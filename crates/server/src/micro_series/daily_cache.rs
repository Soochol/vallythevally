use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

use domain::{KstDate, KstTime, StockCode};

use crate::api;
use crate::market_source::{DayRange, GenerationScoped, GenerationTicket, SourceGeneration};

pub const DAILY_PROGRAM_TODAY_TTL_SECS: i64 = 15;
pub const DAILY_CACHE_CAPACITY: usize = 256;
pub const DEFAULT_DAILY_LOOKBACK_DAYS: i64 = 365;

#[derive(Clone, Copy)]
pub struct DailyCacheTicket {
    generation: GenerationTicket,
    epoch: u64,
}

pub struct DailyCacheSnapshot {
    pub ticket: DailyCacheTicket,
    pub missing: Vec<DayRange>,
    pub rows: Vec<api::StockProgramDailyDay>,
}

#[derive(Clone, Copy)]
struct TodaySnapshot {
    date: KstDate,
    fetched_at: KstTime,
    row: Option<api::StockProgramDailyDay>,
}

impl TodaySnapshot {
    fn is_fresh(self, today: KstDate, now: KstTime) -> bool {
        self.date == today
            && now.unix() >= self.fetched_at.unix()
            && now.unix() - self.fetched_at.unix() < DAILY_PROGRAM_TODAY_TTL_SECS
    }
}

#[derive(Clone, Default)]
struct CachedDailyProgram {
    confirmed_days: BTreeMap<KstDate, api::StockProgramDailyDay>,
    confirmed_ranges: Vec<DayRange>,
    exhausted_before: Option<KstDate>,
    today: Option<TodaySnapshot>,
}

impl CachedDailyProgram {
    fn add_confirmed_range(&mut self, range: DayRange) {
        self.confirmed_ranges.push(range);
        self.confirmed_ranges.sort_by_key(|r| (r.from(), r.to()));
        let mut merged: Vec<DayRange> = Vec::with_capacity(self.confirmed_ranges.len());
        for next in self.confirmed_ranges.drain(..) {
            if let Some(last) = merged.last_mut()
                && last.to().add_days(1) >= next.from()
            {
                let combined_to = last.to().max(next.to());
                if let Some(combined) = DayRange::new(last.from(), combined_to) {
                    *last = combined;
                }
            } else {
                merged.push(next);
            }
        }
        self.confirmed_ranges = merged;
    }

    fn rows_in_range(&self, range: DayRange, today: KstDate, now: KstTime) -> Vec<api::StockProgramDailyDay> {
        let yesterday = today.add_days(-1);
        let mut rows: Vec<api::StockProgramDailyDay> = if range.from() <= yesterday {
            let hist_to = range.to().min(yesterday);
            self.confirmed_days.range(range.from()..=hist_to).map(|(_, day)| *day).collect()
        } else {
            Vec::new()
        };
        if range.contains(today)
            && let Some(snap) = self.today
            && snap.is_fresh(today, now)
            && let Some(row) = snap.row
        {
            rows.push(row);
        }
        rows
    }
}

#[derive(Default)]
struct DailyProgramStore {
    entries: HashMap<StockCode, CachedDailyProgram>,
    order: VecDeque<StockCode>,
}

impl DailyProgramStore {
    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    fn touch(&mut self, stock: StockCode) {
        if self.entries.contains_key(&stock) {
            self.order.retain(|existing| *existing != stock);
        } else if self.order.len() >= DAILY_CACHE_CAPACITY
            && let Some(evicted) = self.order.pop_front()
        {
            self.entries.remove(&evicted);
        }
        self.order.push_back(stock);
    }
}

fn subtract_ranges(req: DayRange, covered: &[DayRange], exhausted_before: Option<KstDate>) -> Vec<DayRange> {
    let mut cursor = match exhausted_before {
        Some(floor) if req.to() < floor => return Vec::new(),
        Some(floor) => req.from().max(floor),
        None => req.from(),
    };
    let mut missing = Vec::new();
    for cov in covered {
        if cov.to() < cursor {
            continue;
        }
        if cov.from() > req.to() {
            break;
        }
        if cov.from() > cursor
            && let Some(gap) = DayRange::new(cursor, cov.from().add_days(-1))
        {
            missing.push(gap);
        }
        cursor = cov.to().add_days(1);
        if cursor > req.to() {
            break;
        }
    }
    if cursor <= req.to()
        && let Some(tail) = DayRange::new(cursor, req.to())
    {
        missing.push(tail);
    }
    missing
}

fn missing_fetch_ranges(entry: Option<&CachedDailyProgram>, req: DayRange, today: KstDate, now: KstTime) -> Vec<DayRange> {
    let fetch_to = req.to().min(today);
    if req.from() > fetch_to {
        return Vec::new();
    }
    let Some(cached) = entry else {
        return DayRange::new(req.from(), fetch_to).into_iter().collect();
    };
    let yesterday = today.add_days(-1);
    let mut ranges = match DayRange::new(req.from(), fetch_to.min(yesterday)) {
        Some(hist_req) => subtract_ranges(hist_req, &cached.confirmed_ranges, cached.exhausted_before),
        None => Vec::new(),
    };
    let needs_today = fetch_to == today && !cached.today.is_some_and(|snap| snap.is_fresh(today, now));
    if needs_today {
        if let Some(last) = ranges.last_mut()
            && last.to() == yesterday
            && let Some(extended) = DayRange::new(last.from(), today)
        {
            *last = extended;
        } else if let Some(today_only) = DayRange::new(today, today) {
            ranges.push(today_only);
        }
    }
    ranges
}

pub struct DailyProgramCache {
    store: GenerationScoped<DailyProgramStore>,
    epoch: AtomicU64,
}

struct FetchRecord {
    started: DailyCacheTicket,
    stock: StockCode,
    fetch_range: DayRange,
    days: Vec<api::StockProgramDailyDay>,
    hit_start: bool,
    today: KstDate,
    now: KstTime,
}

impl DailyProgramCache {
    pub fn with_generation(generation: SourceGeneration) -> Self {
        Self {
            store: GenerationScoped::new(generation),
            epoch: AtomicU64::new(0),
        }
    }

    pub fn clear(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.store.read(DailyProgramStore::clear);
    }

    pub fn ticket(&self) -> DailyCacheTicket {
        DailyCacheTicket {
            generation: self.store.ticket(),
            epoch: self.epoch.load(Ordering::SeqCst),
        }
    }

    pub fn snapshot(&self, stock: StockCode, range: DayRange, today: KstDate, now: KstTime) -> DailyCacheSnapshot {
        let ticket = self.ticket();
        let (missing, rows) = self.store.read(|store| {
            let entry = store.entries.get(&stock);
            let missing = missing_fetch_ranges(entry, range, today, now);
            let rows = entry.map(|cached| cached.rows_in_range(range, today, now)).unwrap_or_default();
            (missing, rows)
        });
        DailyCacheSnapshot { ticket, missing, rows }
    }

    pub fn insert_history(
        &self,
        started: DailyCacheTicket,
        stock: StockCode,
        fetch_range: DayRange,
        history: api::DayHistory<api::StockProgramDailyDay>,
        today: KstDate,
        now: KstTime,
    ) {
        let hit_start = !matches!(history.coverage, api::RangeCoverage::WholeRange);
        self.record_fetch(FetchRecord { started, stock, fetch_range, days: history.days, hit_start, today, now });
    }

    pub fn mark_exhausted(
        &self,
        started: DailyCacheTicket,
        stock: StockCode,
        fetch_range: DayRange,
        today: KstDate,
        now: KstTime,
    ) {
        self.record_fetch(FetchRecord { started, stock, fetch_range, days: Vec::new(), hit_start: true, today, now });
    }

    fn record_fetch(&self, record: FetchRecord) {
        let FetchRecord { started, stock, fetch_range, days, hit_start, today, now } = record;
        let yesterday = today.add_days(-1);
        let confirmed_span = DayRange::new(fetch_range.from(), fetch_range.to().min(yesterday));
        let includes_today = fetch_range.contains(today);
        let exhausted_floor = hit_start.then(|| fetch_range.from().min(today));
        self.store.keep(started.generation, |store| {
            if self.epoch.load(Ordering::SeqCst) != started.epoch {
                return;
            }
            store.touch(stock);
            let entry = store.entries.entry(stock).or_default();
            let mut today_row = None;
            for day in days {
                if day.day.0 < today {
                    entry.confirmed_days.insert(day.day.0, day);
                } else if day.day.0 == today {
                    today_row = Some(day);
                }
            }
            if let Some(span) = confirmed_span {
                entry.add_confirmed_range(span);
            }
            if let Some(floor) = exhausted_floor {
                entry.exhausted_before = Some(entry.exhausted_before.map_or(floor, |prev| prev.max(floor)));
            }
            if includes_today {
                entry.today = Some(TodaySnapshot { date: today, fetched_at: now, row: today_row });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::kst;

    fn day(y: i32, m: u8, d: u8) -> KstDate {
        KstDate::new(y, m, d).unwrap()
    }

    fn range(from: KstDate, to: KstDate) -> DayRange {
        DayRange::new(from, to).unwrap()
    }

    fn stock(code: &str) -> StockCode {
        StockCode::parse(code).unwrap()
    }

    fn sample_day(date: KstDate, net_amt: i64) -> api::StockProgramDailyDay {
        api::StockProgramDailyDay {
            day: api::KstDate(date),
            close_won: 70_000,
            volume: 1_000_000,
            sell_amount_million_won: 100,
            buy_amount_million_won: (100 + net_amt).max(0) as u64,
            net_buy_amount_million_won: net_amt,
            sell_qty: 1_000,
            buy_qty: 2_000,
            net_buy_qty: 1_000,
        }
    }

    fn history(
        code: StockCode,
        req: DayRange,
        coverage: api::RangeCoverage,
        days: Vec<api::StockProgramDailyDay>,
    ) -> api::DayHistory<api::StockProgramDailyDay> {
        api::DayHistory {
            symbol: api::SymbolCode(code.as_str().to_owned()),
            from: api::KstDate(req.from()),
            to: api::KstDate(req.to()),
            coverage,
            days,
            source: api::Broker::Kiwoom,
            skipped_days: Vec::new(),
            undated_rows: Vec::new(),
            estimated_days: None,
        }
    }

    #[test]
    fn missing_fetch_ranges_handles_initial_clamping_pan_left_exhausted_ttl_and_midnight() {
        let today = day(2026, 11, 24);
        let t0 = kst(today, 10, 0, 0);

        assert_eq!(
            missing_fetch_ranges(None, range(day(2026, 11, 18), day(2026, 11, 30)), today, t0),
            vec![range(day(2026, 11, 18), today)]
        );
        assert!(missing_fetch_ranges(None, range(day(2026, 11, 25), day(2026, 11, 30)), today, t0).is_empty());

        let cached = CachedDailyProgram {
            confirmed_days: BTreeMap::new(),
            confirmed_ranges: vec![range(day(2026, 11, 18), day(2026, 11, 23))],
            exhausted_before: None,
            today: Some(TodaySnapshot { date: today, fetched_at: t0, row: Some(sample_day(today, 20)) }),
        };

        assert!(missing_fetch_ranges(Some(&cached), range(day(2026, 11, 18), day(2026, 11, 30)), today, kst(today, 10, 0, 14)).is_empty());
        assert_eq!(
            missing_fetch_ranges(Some(&cached), range(day(2026, 11, 18), day(2026, 11, 30)), today, kst(today, 10, 0, 15)),
            vec![range(today, today)]
        );
        assert_eq!(
            missing_fetch_ranges(Some(&cached), range(day(2026, 11, 1), today), today, kst(today, 10, 0, 5)),
            vec![range(day(2026, 11, 1), day(2026, 11, 17))]
        );

        let next_day = day(2026, 11, 25);
        assert_eq!(
            missing_fetch_ranges(Some(&cached), range(day(2026, 11, 18), next_day), next_day, kst(next_day, 0, 30, 0)),
            vec![range(today, next_day)]
        );
        assert_eq!(
            missing_fetch_ranges(Some(&cached), range(day(2026, 11, 18), today), next_day, kst(next_day, 0, 30, 0)),
            vec![range(today, today)]
        );

        let exhausted = CachedDailyProgram { exhausted_before: Some(day(2026, 11, 18)), ..cached };
        assert!(missing_fetch_ranges(Some(&exhausted), range(day(2025, 1, 1), today), today, kst(today, 10, 0, 5)).is_empty());
    }

    #[test]
    fn disjoint_inserts_do_not_bridge_unfetched_middle_gap() {
        let generation = SourceGeneration::default();
        let cache = DailyProgramCache::with_generation(generation);
        let code = stock("005930");
        let today = day(2026, 11, 24);
        let t0 = kst(today, 10, 0, 0);

        let left = range(day(2026, 11, 1), day(2026, 11, 10));
        let right = range(day(2026, 11, 20), today);
        let ticket = cache.ticket();
        cache.insert_history(ticket, code, left, history(code, left, api::RangeCoverage::WholeRange, vec![sample_day(day(2026, 11, 5), 10)]), today, t0);
        cache.insert_history(ticket, code, right, history(code, right, api::RangeCoverage::WholeRange, vec![sample_day(day(2026, 11, 20), 20)]), today, t0);

        let middle = range(day(2026, 11, 12), day(2026, 11, 18));
        assert_eq!(cache.snapshot(code, middle, today, t0).missing, vec![middle]);
    }

    #[test]
    fn cache_reuses_across_timeframe_bounds_extends_left_and_invalidates_on_clear_and_generation() {
        let generation = SourceGeneration::default();
        let cache = DailyProgramCache::with_generation(generation.clone());
        let code = stock("005930");
        let today = day(2026, 11, 24);
        let t0 = kst(today, 10, 0, 0);

        let initial = range(day(2026, 11, 18), today);
        let snap = cache.snapshot(code, initial, today, t0);
        assert_eq!(snap.missing, vec![initial]);
        cache.insert_history(
            snap.ticket,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(day(2026, 11, 18), 50), sample_day(today, 100)]),
            today,
            t0,
        );
        let hit = cache.snapshot(code, range(day(2026, 11, 18), day(2026, 11, 30)), today, kst(today, 10, 0, 10));
        assert!(hit.missing.is_empty());
        assert_eq!(hit.rows.len(), 2);

        let pan_left = range(day(2026, 11, 1), today);
        let older = range(day(2026, 11, 1), day(2026, 11, 17));
        let left_snap = cache.snapshot(code, pan_left, today, kst(today, 10, 0, 10));
        assert_eq!(left_snap.missing, vec![older]);
        assert_eq!(left_snap.rows.len(), 2);
        cache.insert_history(
            left_snap.ticket,
            code,
            older,
            history(
                code,
                older,
                api::RangeCoverage::KiwoomStartsLater { first_day: api::KstDate(day(2026, 11, 10)) },
                vec![sample_day(day(2026, 11, 10), -20)],
            ),
            today,
            kst(today, 10, 0, 10),
        );
        let after_left = cache.snapshot(code, range(day(2025, 1, 1), today), today, kst(today, 10, 0, 10));
        assert!(after_left.missing.is_empty());
        assert_eq!(after_left.rows.len(), 3);

        let stale_ticket = cache.ticket();
        cache.clear();
        assert!(cache.snapshot(code, initial, today, kst(today, 10, 0, 10)).rows.is_empty());
        cache.insert_history(
            stale_ticket,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(today, 100)]),
            today,
            kst(today, 10, 0, 11),
        );
        assert!(cache.snapshot(code, initial, today, kst(today, 10, 0, 11)).rows.is_empty());

        let before_switch = cache.ticket();
        cache.insert_history(
            before_switch,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(today, 100)]),
            today,
            kst(today, 10, 0, 12),
        );
        assert_eq!(cache.snapshot(code, initial, today, kst(today, 10, 0, 12)).rows.len(), 1);
        generation.advance();
        assert!(cache.snapshot(code, initial, today, kst(today, 10, 0, 12)).rows.is_empty());
        cache.insert_history(
            before_switch,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(today, 100)]),
            today,
            kst(today, 10, 0, 13),
        );
        assert!(cache.snapshot(code, initial, today, kst(today, 10, 0, 13)).rows.is_empty());
    }
}
