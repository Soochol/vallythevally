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

#[derive(Clone)]
struct CachedDailyProgram {
    days: BTreeMap<KstDate, api::StockProgramDailyDay>,
    covered_from: KstDate,
    covered_to: KstDate,
    exhausted: bool,
    today_fetched: Option<(KstDate, KstTime)>,
}

impl CachedDailyProgram {
    fn today_is_fresh(&self, today: KstDate, now: KstTime) -> bool {
        matches!(
            self.today_fetched,
            Some((fetched_day, fetched_at))
                if fetched_day == today
                    && now.unix() >= fetched_at.unix()
                    && now.unix() - fetched_at.unix() < DAILY_PROGRAM_TODAY_TTL_SECS
        )
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

fn missing_fetch_ranges(entry: Option<&CachedDailyProgram>, req: DayRange, today: KstDate, now: KstTime) -> Vec<DayRange> {
    let fetch_to = req.to().min(today);
    if req.from() > fetch_to {
        return Vec::new();
    }
    let Some(cached) = entry else {
        return DayRange::new(req.from(), fetch_to).into_iter().collect();
    };
    let mut ranges = Vec::new();
    if !cached.exhausted && req.from() < cached.covered_from {
        let older_to = cached.covered_from.add_days(-1).min(today);
        if let Some(older) = DayRange::new(req.from(), older_to) {
            ranges.push(older);
        }
    }
    let newer_covers_today = if fetch_to > cached.covered_to {
        let newer_from = cached.covered_to.add_days(1);
        if let Some(newer) = DayRange::new(newer_from, fetch_to) {
            ranges.push(newer);
            fetch_to == today
        } else {
            false
        }
    } else {
        false
    };
    if fetch_to == today && !newer_covers_today && !cached.today_is_fresh(today, now)
        && let Some(today_only) = DayRange::new(today, today)
    {
        ranges.push(today_only);
    }
    ranges
}

pub struct DailyProgramCache {
    store: GenerationScoped<DailyProgramStore>,
    epoch: AtomicU64,
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

    pub fn missing_ranges(&self, stock: StockCode, range: DayRange, today: KstDate, now: KstTime) -> Vec<DayRange> {
        self.store.read(|store| missing_fetch_ranges(store.entries.get(&stock), range, today, now))
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
        let fetched_today = fetch_range.contains(today).then_some((today, now));
        self.store.keep(started.generation, |store| {
            if self.epoch.load(Ordering::SeqCst) != started.epoch {
                return;
            }
            store.touch(stock);
            match store.entries.get_mut(&stock) {
                Some(entry) => {
                    for day in history.days {
                        entry.days.insert(day.day.0, day);
                    }
                    let reaches_left = fetch_range.from() <= entry.covered_from;
                    entry.covered_from = entry.covered_from.min(fetch_range.from());
                    entry.covered_to = entry.covered_to.max(fetch_range.to());
                    if reaches_left && hit_start {
                        entry.exhausted = true;
                    }
                    if let Some(mark) = fetched_today {
                        entry.today_fetched = Some(mark);
                    }
                }
                None => {
                    let mut days = BTreeMap::new();
                    for day in history.days {
                        days.insert(day.day.0, day);
                    }
                    store.entries.insert(
                        stock,
                        CachedDailyProgram {
                            days,
                            covered_from: fetch_range.from(),
                            covered_to: fetch_range.to(),
                            exhausted: hit_start,
                            today_fetched: fetched_today,
                        },
                    );
                }
            }
        });
    }

    pub fn mark_exhausted(
        &self,
        started: DailyCacheTicket,
        stock: StockCode,
        fetch_range: DayRange,
        today: KstDate,
        now: KstTime,
    ) {
        let fetched_today = fetch_range.contains(today).then_some((today, now));
        self.store.keep(started.generation, |store| {
            if self.epoch.load(Ordering::SeqCst) != started.epoch {
                return;
            }
            store.touch(stock);
            match store.entries.get_mut(&stock) {
                Some(entry) => {
                    let reaches_left = fetch_range.from() <= entry.covered_from;
                    entry.covered_from = entry.covered_from.min(fetch_range.from());
                    entry.covered_to = entry.covered_to.max(fetch_range.to());
                    if reaches_left {
                        entry.exhausted = true;
                    }
                    if let Some(mark) = fetched_today {
                        entry.today_fetched = Some(mark);
                    }
                }
                None => {
                    store.entries.insert(
                        stock,
                        CachedDailyProgram {
                            days: BTreeMap::new(),
                            covered_from: fetch_range.from(),
                            covered_to: fetch_range.to(),
                            exhausted: true,
                            today_fetched: fetched_today,
                        },
                    );
                }
            }
        });
    }

    pub fn rows_in_range(&self, stock: StockCode, range: DayRange) -> Vec<api::StockProgramDailyDay> {
        self.store.read(|store| {
            let Some(entry) = store.entries.get(&stock) else {
                return Vec::new();
            };
            entry.days.range(range.from()..=range.to()).map(|(_, day)| *day).collect()
        })
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
    fn missing_fetch_ranges_handles_initial_clamping_pan_left_exhausted_and_ttl() {
        let today = day(2026, 11, 24);
        let t0 = kst(today, 10, 0, 0);

        assert_eq!(
            missing_fetch_ranges(None, range(day(2026, 11, 18), day(2026, 11, 30)), today, t0),
            vec![range(day(2026, 11, 18), today)]
        );
        assert!(missing_fetch_ranges(None, range(day(2026, 11, 25), day(2026, 11, 30)), today, t0).is_empty());

        let cached = CachedDailyProgram {
            days: BTreeMap::new(),
            covered_from: day(2026, 11, 18),
            covered_to: today,
            exhausted: false,
            today_fetched: Some((today, t0)),
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

        let exhausted = CachedDailyProgram { exhausted: true, ..cached };
        assert!(missing_fetch_ranges(Some(&exhausted), range(day(2025, 1, 1), today), today, kst(today, 10, 0, 5)).is_empty());
    }

    #[test]
    fn cache_reuses_across_timeframe_bounds_extends_left_and_invalidates_on_clear_and_generation() {
        let generation = SourceGeneration::default();
        let cache = DailyProgramCache::with_generation(generation.clone());
        let code = stock("005930");
        let today = day(2026, 11, 24);
        let t0 = kst(today, 10, 0, 0);

        let initial = range(day(2026, 11, 18), today);
        let ticket = cache.ticket();
        assert_eq!(cache.missing_ranges(code, initial, today, t0), vec![initial]);
        cache.insert_history(
            ticket,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(day(2026, 11, 18), 50), sample_day(today, 100)]),
            today,
            t0,
        );
        assert_eq!(cache.rows_in_range(code, initial).len(), 2);
        assert!(cache.missing_ranges(code, range(day(2026, 11, 18), day(2026, 11, 30)), today, kst(today, 10, 0, 10)).is_empty());

        let pan_left = range(day(2026, 11, 1), today);
        let older = range(day(2026, 11, 1), day(2026, 11, 17));
        assert_eq!(cache.missing_ranges(code, pan_left, today, kst(today, 10, 0, 10)), vec![older]);
        cache.insert_history(
            cache.ticket(),
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
        assert!(cache.missing_ranges(code, range(day(2025, 1, 1), today), today, kst(today, 10, 0, 10)).is_empty());
        assert_eq!(cache.rows_in_range(code, pan_left).len(), 3);

        let stale_ticket = cache.ticket();
        cache.clear();
        assert!(cache.rows_in_range(code, initial).is_empty());
        cache.insert_history(
            stale_ticket,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(today, 100)]),
            today,
            kst(today, 10, 0, 11),
        );
        assert!(cache.rows_in_range(code, initial).is_empty());

        let before_switch = cache.ticket();
        cache.insert_history(
            before_switch,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(today, 100)]),
            today,
            kst(today, 10, 0, 12),
        );
        assert_eq!(cache.rows_in_range(code, initial).len(), 1);
        generation.advance();
        assert!(cache.rows_in_range(code, initial).is_empty());
        cache.insert_history(
            before_switch,
            code,
            initial,
            history(code, initial, api::RangeCoverage::WholeRange, vec![sample_day(today, 100)]),
            today,
            kst(today, 10, 0, 13),
        );
        assert!(cache.rows_in_range(code, initial).is_empty());
    }
}
