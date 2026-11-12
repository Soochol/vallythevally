use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, StockCode, Venue};
use tokio::sync::watch;

use crate::clock::Clock;
use crate::kiwoom::api::StockQuotes;
use crate::kiwoom::rest::{KiwoomError, KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::{KrxSummary, StockQuotesResponse, WireError, parse_krx_summary};

static NEXT_COLLECTION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectionId(u64);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CollectionBasis {
    pub generation: u64,
    pub update_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MissingSummary {
    MissingRow,
    DuplicateRow,
    Unreadable(WireError),
    OtherDate(KstDate),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockSummary {
    pub received_at: KstTime,
    pub result: Result<KrxSummary, MissingSummary>,
}

#[derive(Debug)]
pub struct SummaryBatch {
    pub id: CollectionId,
    pub basis: CollectionBasis,
    pub target: KstDate,
    pub venue: Venue,
    pub started_at: KstTime,
    pub completed_at: KstTime,
    pub stocks: BTreeMap<StockCode, StockSummary>,
}

impl SummaryBatch {
    pub fn missing_count(&self) -> usize {
        self.stocks.values().filter(|s| s.result.is_err()).count()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectionError {
    Kiwoom(KiwoomError),
    DateChanged,
    Cancelled,
    TargetsChanged,
    BasisChanged,
    UnexpectedContinuation,
}

impl fmt::Display for CollectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Kiwoom(e) => e.fmt(f),
            Self::DateChanged => f.write_str("수집 중 날짜가 바뀌었습니다"),
            Self::Cancelled => f.write_str("당일 요약 수집을 취소했습니다"),
            Self::BasisChanged => f.write_str("수집을 시작한 확정 이력 세대가 다릅니다. 다시 실행하세요"),
            Self::TargetsChanged => f.write_str("수집 중 대상 종목이 바뀌었습니다"),
            Self::UnexpectedContinuation => f.write_str("당일 요약이 한 응답으로 끝나지 않았습니다"),
        }
    }
}

impl std::error::Error for CollectionError {}

type Outcome = Result<Arc<SummaryBatch>, CollectionError>;

struct Flight {
    id: CollectionId,
    basis: CollectionBasis,
    target: KstDate,
    codes: Vec<StockCode>,
    outcome: watch::Sender<Option<Outcome>>,
    task: tokio::task::AbortHandle,
}

#[derive(Default)]
struct State {
    flight: Option<Flight>,
    completed: Option<Arc<SummaryBatch>>,
}

pub struct SummaryCollector {
    rest: KiwoomRest,
    clock: Clock,
    state: Mutex<State>,
}

impl SummaryCollector {
    pub fn new(rest: KiwoomRest, clock: Clock) -> Arc<Self> {
        Arc::new(Self { rest, clock, state: Mutex::new(State::default()) })
    }

    pub fn completed(&self) -> Option<Arc<SummaryBatch>> {
        self.state.lock().expect("당일 요약 상태 잠금").completed.clone()
    }

    pub fn cancel(&self) {
        let mut state = self.state.lock().expect("당일 요약 상태 잠금");
        stop(&mut state, CollectionError::Cancelled);
    }

    pub async fn collect(self: &Arc<Self>, mut codes: Vec<StockCode>, basis: CollectionBasis) -> Outcome {
        codes.sort_unstable();
        codes.dedup();
        let mut receiver = {
            let mut state = self.state.lock().expect("당일 요약 상태 잠금");
            let target = self.clock.now().kst_date();
            if state.flight.as_ref().is_some_and(|f| f.target != target) {
                stop(&mut state, CollectionError::DateChanged);
            }
            if let Some(flight) = &state.flight {
                if flight.basis != basis {
                    return Err(CollectionError::BasisChanged);
                }
                if flight.codes != codes {
                    return Err(CollectionError::TargetsChanged);
                }
                flight.outcome.subscribe()
            } else {
                let id = CollectionId(NEXT_COLLECTION.fetch_add(1, Ordering::SeqCst));
                let started_at = self.clock.now();
                let (outcome, receiver) = watch::channel(None);
                let me = self.clone();
                let targets = codes.clone();
                let task = tokio::spawn(async move {
                    let result = me.receive(id, basis, target, started_at, &targets).await;
                    me.finish(id, result);
                });
                state.flight = Some(Flight { id, basis, target, codes, outcome, task: task.abort_handle() });
                receiver
            }
        };
        loop {
            if let Some(outcome) = receiver.borrow_and_update().clone() {
                return outcome;
            }
            if receiver.changed().await.is_err() {
                return Err(CollectionError::Cancelled);
            }
        }
    }

    async fn receive(&self, id: CollectionId, basis: CollectionBasis, target: KstDate, started_at: KstTime, codes: &[StockCode]) -> Outcome {
        let mut stocks = BTreeMap::new();
        for chunk in codes.chunks(StockQuotes::MAX) {
            self.check_date(target)?;
            let request = StockQuotes::new(chunk, Venue::Krx).expect("1~MAX 종목 묶음");
            let page = self.rest.call(&request, None, Priority::Screen, MergeScope::Summary(id.0)).await.map_err(CollectionError::Kiwoom)?;
            let received_at = self.clock.now();
            self.check_date(target)?;
            if page.next.is_some() {
                return Err(CollectionError::UnexpectedContinuation);
            }
            stocks.extend(read_stocks(chunk, page.body, target, received_at));
        }
        self.check_date(target)?;
        Ok(Arc::new(SummaryBatch { id, basis, target, venue: Venue::Krx, started_at, completed_at: self.clock.now(), stocks }))
    }

    fn check_date(&self, target: KstDate) -> Result<(), CollectionError> {
        if self.clock.now().kst_date() == target { Ok(()) } else { Err(CollectionError::DateChanged) }
    }

    fn finish(&self, id: CollectionId, mut result: Outcome) {
        let mut state = self.state.lock().expect("당일 요약 상태 잠금");
        if state.flight.as_ref().is_none_or(|f| f.id != id) {
            return;
        }
        let flight = state.flight.take().expect("실행 중 수집");
        if self.check_date(flight.target).is_err() {
            result = Err(CollectionError::DateChanged);
        }
        if let Ok(batch) = &result {
            state.completed = Some(batch.clone());
        }
        flight.outcome.send_replace(Some(result));
    }
}

fn stop(state: &mut State, error: CollectionError) {
    if let Some(flight) = state.flight.take() {
        flight.task.abort();
        flight.outcome.send_replace(Some(Err(error)));
    }
}

fn read_stocks(codes: &[StockCode], response: StockQuotesResponse, target: KstDate, received_at: KstTime) -> BTreeMap<StockCode, StockSummary> {
    let mut rows: BTreeMap<StockCode, Vec<_>> = BTreeMap::new();
    for row in response.atn_stk_infr {
        if let Ok(code) = StockCode::parse(&row.stk_cd) {
            rows.entry(code).or_default().push(row);
        }
    }
    codes.iter().map(|code| {
        let result = match rows.remove(code) {
            None => Err(MissingSummary::MissingRow),
            Some(rows) if rows.len() != 1 => Err(MissingSummary::DuplicateRow),
            Some(rows) => parse_krx_summary(&rows[0]).map_err(MissingSummary::Unreadable).and_then(|q| {
                if q.day == target { Ok(q) } else { Err(MissingSummary::OtherDate(q.day)) }
            }),
        };
        if let Err(reason) = &result {
            tracing::warn!(code = code.as_str(), ?reason, "당일 KRX 요약을 확인하지 못했습니다");
        }
        (*code, StockSummary { received_at, result })
    }).collect()
}
