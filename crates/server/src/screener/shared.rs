use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, Ohlcv, Price, StockCode, Venue, Volume};
use tokio::sync::OnceCell;

use super::Observation;
use super::summary::{CollectionBasis, CollectionId, MissingSummary, StockSummary, SummaryBatch};
use crate::api::{Screen, ScreenerResult};
use crate::kiwoom::wire::{KrxSummary, KrxSummaryValues, MillionWon, WireError};
use crate::shared_data::{Loaded, SharedData, SnapshotBody, SnapshotRow};

const KEPT_RESULTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReuseCounts {
    pub hits: u64,
    pub misses: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SnapshotId {
    observation_day: KstDate,
    as_of: i64,
    written_at: i64,
}

pub(super) struct Snapshot {
    id: SnapshotId,
    loaded: Arc<Loaded<SnapshotBody>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ResultKey {
    screen: String,
    snapshot: SnapshotId,
    basis: CollectionBasis,
    today: KstDate,
    observation: Observation,
}

impl ResultKey {
    pub(super) fn new(screen: String, snapshot: &Snapshot, basis: CollectionBasis, today: KstDate, observation: Observation) -> Self {
        ResultKey { screen, snapshot: snapshot.id, basis, today, observation }
    }
}

pub(super) type Slot = Arc<OnceCell<Arc<ScreenerResult>>>;

#[derive(Default)]
struct State {
    snapshot: Option<SnapshotId>,
    results: VecDeque<(ResultKey, Slot)>,
    batch: Option<(SnapshotId, CollectionBasis, KstDate, Arc<SummaryBatch>)>,
}

pub(super) struct SharedQuotes {
    data: Arc<SharedData>,
    state: Mutex<State>,
    hits: AtomicU64,
    misses: AtomicU64,
}

pub(super) fn screen_key(screen: &Screen) -> String {
    fn json<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_string(value).expect("조건식 값은 JSON이 된다")
    }
    fn unordered<T: serde::Serialize>(values: &[T]) -> String {
        let mut texts: Vec<String> = values.iter().map(json).collect();
        texts.sort_unstable();
        texts.dedup();
        texts.join(",")
    }
    format!("{}|{}|{}", json(&screen.conditions), unordered(&screen.markets), unordered(&screen.exclude))
}

impl SharedQuotes {
    pub(super) fn new(data: Arc<SharedData>) -> Self {
        SharedQuotes { data, state: Mutex::new(State::default()), hits: AtomicU64::new(0), misses: AtomicU64::new(0) }
    }

    pub(super) fn counts(&self) -> ReuseCounts {
        ReuseCounts { hits: self.hits.load(Ordering::Relaxed), misses: self.misses.load(Ordering::Relaxed) }
    }

    pub(super) fn count(&self, judged_here: bool) {
        let counter = if judged_here { &self.misses } else { &self.hits };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn snapshot(&self, observation: Observation, today: KstDate, previous_day: Option<KstDate>) -> Option<Snapshot> {
        let loaded = self.data.snapshot(Venue::Krx).current()?;
        let observation_day = KstDate::parse_yyyymmdd(&loaded.header.observation_date)?;
        let current = match observation {
            Observation::Current => observation_day == today,
            Observation::PreviousOnly(previous) => observation_day == previous,
            Observation::Unresolved => previous_day.is_none_or(|previous| observation_day >= previous),
        };
        current.then(|| Snapshot { id: SnapshotId { observation_day, as_of: loaded.header.as_of, written_at: loaded.header.written_at }, loaded })
    }

    pub(super) fn slot(&self, key: ResultKey) -> Slot {
        let mut state = self.state.lock().expect("공용 스냅샷 결과 잠금");
        if state.snapshot != Some(key.snapshot) {
            state.snapshot = Some(key.snapshot);
            state.results.clear();
        }
        if let Some((_, slot)) = state.results.iter().find(|(kept, _)| *kept == key) {
            return slot.clone();
        }
        let slot = Slot::default();
        state.results.push_back((key, slot.clone()));
        if state.results.len() > KEPT_RESULTS {
            state.results.pop_front();
        }
        slot
    }

    pub(super) fn batch(&self, snapshot: &Snapshot, codes: impl Iterator<Item = StockCode>, basis: CollectionBasis, target: KstDate) -> Arc<SummaryBatch> {
        let mut state = self.state.lock().expect("공용 스냅샷 결과 잠금");
        if let Some((id, kept_basis, day, batch)) = &state.batch
            && *id == snapshot.id
            && *kept_basis == basis
            && *day == target
        {
            return batch.clone();
        }
        let batch = Arc::new(batch_of(snapshot, codes, basis, target));
        state.batch = Some((snapshot.id, basis, target, batch.clone()));
        batch
    }
}

fn batch_of(snapshot: &Snapshot, codes: impl Iterator<Item = StockCode>, basis: CollectionBasis, target: KstDate) -> SummaryBatch {
    let received_at = KstTime::from_unix(snapshot.id.as_of);
    let mut rows: HashMap<&str, Option<&SnapshotRow>> = HashMap::with_capacity(snapshot.loaded.body.stocks.len());
    for row in &snapshot.loaded.body.stocks {
        rows.entry(row.code.as_str()).and_modify(|only| *only = None).or_insert(Some(row));
    }
    let stocks = codes
        .map(|code| {
            let result = match rows.get(code.as_str()) {
                None => Err(MissingSummary::MissingRow),
                Some(None) => Err(MissingSummary::DuplicateRow),
                Some(Some(row)) => summary_of(row).map_err(MissingSummary::Unreadable).and_then(|quote| if quote.day == target { Ok(quote) } else { Err(MissingSummary::OtherDate(quote.day)) }),
            };
            (code, StockSummary { received_at, result })
        })
        .collect();
    SummaryBatch { id: CollectionId::next(), basis, target, venue: Venue::Krx, started_at: received_at, completed_at: received_at, stocks }
}

fn summary_of(row: &SnapshotRow) -> Result<KrxSummary, WireError> {
    let day = KstDate::parse_yyyymmdd(&row.day).ok_or_else(|| WireError(format!("day가 날짜가 아닙니다: {:?}", row.day)))?;
    let trade_time = row.traded_at.map(|at| KstTime::from_unix(at).kst_time_of_day());
    let price = |won: u64| won.checked_mul(100).and_then(Price::from_centi).ok_or_else(|| WireError(format!("가격이 0이거나 너무 큽니다: {won}")));
    let base = price(row.base_won)?;
    let values = if row.volume == 0 {
        if row.traded_million_won != 0 || row.open_won != 0 || row.high_won != 0 || row.low_won != 0 {
            return Err(WireError("무거래 행의 시고저·거래대금이 0이 아닙니다".into()));
        }
        let current_centi = row.current_won.checked_mul(100).ok_or_else(|| WireError("현재가가 너무 큽니다".into()))?;
        KrxSummaryValues::NoTrades { current_centi }
    } else {
        if trade_time.is_none() {
            return Err(WireError("거래 행에 체결시각이 없습니다".into()));
        }
        let ohlcv = Ohlcv::try_new(price(row.open_won)?, price(row.high_won)?, price(row.low_won)?, price(row.current_won)?, Volume(row.volume)).map_err(|e| WireError(e.to_string()))?;
        KrxSummaryValues::Traded { ohlcv, traded: MillionWon(row.traded_million_won) }
    };
    Ok(KrxSummary { day, trade_time, base, values })
}
