use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, Ohlcv, Price, StockCode, TimeOfDay, Venue, Volume};
use tokio::sync::watch;

use super::Observation;
use crate::api::Broker;
use crate::clock::Clock;
use crate::kis::market_rest::{DayRow, DayValues, MULTI_PRICE_MAX_ROWS, multi_price_day_rows};
use crate::kis::rest::KisRest;
use crate::kiwoom::api::StockQuotes;
use crate::kiwoom::rest::KiwoomError;
use crate::market_source::{KiwoomHandle, MergeScope, Priority, SourceError};
use crate::kiwoom::wire::{KrxSummary, KrxSummaryValues, MillionWon, StockQuotesResponse, WireError, parse_krx_summary};

const WON_PER_MILLION: u64 = 1_000_000;
const KIS_ROWS_TRADE_FROM: TimeOfDay = match TimeOfDay::hms(9, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};

static NEXT_COLLECTION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectionId(u64);

impl CollectionId {
    pub(super) fn next() -> CollectionId {
        CollectionId(NEXT_COLLECTION.fetch_add(1, Ordering::SeqCst))
    }
}

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
    DayUnknown,
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
    pub broker: Broker,
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
    Kis(SourceError),
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
            Self::Kis(e) => e.fmt(f),
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Receiving {
    Kiwoom,
    Kis(Observation),
}

struct Collecting {
    id: CollectionId,
    basis: CollectionBasis,
    target: KstDate,
    started_at: KstTime,
}

struct Flight {
    id: CollectionId,
    basis: CollectionBasis,
    target: KstDate,
    receiving: Receiving,
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
    kiwoom: KiwoomHandle,
    clock: Clock,
    state: Mutex<State>,
}

impl SummaryCollector {
    pub fn new(kiwoom: impl Into<KiwoomHandle>, clock: Clock) -> Arc<Self> {
        Arc::new(Self { kiwoom: kiwoom.into(), clock, state: Mutex::new(State::default()) })
    }

    pub fn completed(&self) -> Option<Arc<SummaryBatch>> {
        self.state.lock().expect("당일 요약 상태 잠금").completed.clone()
    }

    pub fn cancel(&self) {
        let mut state = self.state.lock().expect("당일 요약 상태 잠금");
        stop(&mut state, CollectionError::Cancelled);
    }

    pub async fn collect(self: &Arc<Self>, codes: Vec<StockCode>, basis: CollectionBasis) -> Outcome {
        self.collect_observing(codes, basis, Observation::Unresolved).await
    }

    pub(super) async fn collect_observing(self: &Arc<Self>, mut codes: Vec<StockCode>, basis: CollectionBasis, observation: Observation) -> Outcome {
        codes.sort_unstable();
        codes.dedup();
        let mut receiver = {
            let mut state = self.state.lock().expect("당일 요약 상태 잠금");
            let target = self.clock.now().kst_date();
            if state.flight.as_ref().is_some_and(|f| f.target != target) {
                stop(&mut state, CollectionError::DateChanged);
            }
            let kis = self.kiwoom.kis_receiving_instead().map(|lane| lane.rest);
            let receiving = if kis.is_some() { Receiving::Kis(observation) } else { Receiving::Kiwoom };
            if let Some(flight) = &state.flight {
                if flight.basis != basis || flight.receiving != receiving {
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
                    let result = match kis {
                        Some(rest) => me.receive_from_kis(&rest, Collecting { id, basis, target, started_at }, observation, &targets).await,
                        None => me.receive(id, basis, target, started_at, &targets).await,
                    };
                    me.finish(id, result);
                });
                state.flight = Some(Flight { id, basis, target, receiving, codes, outcome, task: task.abort_handle() });
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
            let page = self.kiwoom.rest().map_err(CollectionError::Kiwoom)?.call(&request, None, Priority::Screen, MergeScope::Summary(id.0)).await.map_err(CollectionError::Kiwoom)?;
            let received_at = self.clock.now();
            self.check_date(target)?;
            if page.next.is_some() {
                return Err(CollectionError::UnexpectedContinuation);
            }
            stocks.extend(read_stocks(chunk, page.body, target, received_at));
        }
        self.check_date(target)?;
        Ok(Arc::new(SummaryBatch { id, basis, target, broker: Broker::Kiwoom, venue: Venue::Krx, started_at, completed_at: self.clock.now(), stocks }))
    }

    async fn receive_from_kis(&self, rest: &KisRest, collecting: Collecting, observation: Observation, codes: &[StockCode]) -> Outcome {
        let Collecting { id, basis, target, started_at } = collecting;
        let mut stocks = BTreeMap::new();
        for chunk in codes.chunks(MULTI_PRICE_MAX_ROWS) {
            self.check_date(target)?;
            let wanted: Vec<(StockCode, Venue)> = chunk.iter().map(|code| (*code, Venue::Krx)).collect();
            let rows = multi_price_day_rows(rest, &wanted, Priority::Screen).await.map_err(CollectionError::Kis)?;
            let received_at = self.clock.now();
            self.check_date(target)?;
            stocks.extend(read_kis_stocks(chunk, rows, KisReading { observation, target, received_at }));
        }
        self.check_date(target)?;
        Ok(Arc::new(SummaryBatch { id, basis, target, broker: Broker::Kis, venue: Venue::Krx, started_at, completed_at: self.clock.now(), stocks }))
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

#[derive(Clone, Copy)]
struct KisReading {
    observation: Observation,
    target: KstDate,
    received_at: KstTime,
}

impl KisReading {
    fn row_day(self) -> Option<KstDate> {
        match self.observation {
            Observation::Current => Some(self.target),
            Observation::PreviousOnly(previous) => Some(previous),
            Observation::Unresolved if self.before_trading_on(self.target) => Some(self.target),
            Observation::Unresolved => None,
        }
    }

    fn before_trading_on(self, day: KstDate) -> bool {
        self.received_at < KstTime::from_kst_civil(day, KIS_ROWS_TRADE_FROM)
    }
}

fn read_kis_stocks(codes: &[StockCode], rows: Vec<DayRow>, reading: KisReading) -> BTreeMap<StockCode, StockSummary> {
    let mut by_code: BTreeMap<StockCode, Vec<DayRow>> = BTreeMap::new();
    for row in rows {
        by_code.entry(row.code).or_default().push(row);
    }
    codes.iter().map(|code| {
        let result = match by_code.remove(code) {
            None => Err(MissingSummary::MissingRow),
            Some(rows) if rows.len() != 1 => Err(MissingSummary::DuplicateRow),
            Some(rows) => kis_summary(&rows[0], reading).and_then(|q| if q.day == reading.target { Ok(q) } else { Err(MissingSummary::OtherDate(q.day)) }),
        };
        if let Err(reason) = &result {
            tracing::warn!(code = code.as_str(), ?reason, "당일 한투 요약을 확인하지 못했습니다");
        }
        (*code, StockSummary { received_at: reading.received_at, result })
    }).collect()
}

fn kis_summary(row: &DayRow, reading: KisReading) -> Result<KrxSummary, MissingSummary> {
    let day = reading.row_day().ok_or(MissingSummary::DayUnknown)?;
    let values = row.values.as_ref().map_err(|reason| MissingSummary::Unreadable(WireError(reason.clone())))?;
    kis_values(values, reading.before_trading_on(day)).map(|(base, values)| KrxSummary { day, trade_time: None, base, values }).map_err(MissingSummary::Unreadable)
}

fn kis_values(row: &DayValues, before_trading: bool) -> Result<(Price, KrxSummaryValues), WireError> {
    let price = |centi: u64| Price::from_centi(centi).ok_or_else(|| WireError(format!("가격이 0입니다: {centi}")));
    let base = price(row.base_centi)?;
    if before_trading || row.volume == 0 {
        let current_centi = if before_trading { row.base_centi } else { row.price_centi };
        return Ok((base, KrxSummaryValues::NoTrades { current_centi }));
    }
    let ohlcv = Ohlcv::try_new(price(row.open_centi)?, price(row.high_centi)?, price(row.low_centi)?, price(row.price_centi)?, Volume(row.volume)).map_err(|e| WireError(e.to_string()))?;
    Ok((base, KrxSummaryValues::Traded { ohlcv, traded: MillionWon(row.traded_won / WON_PER_MILLION) }))
}
