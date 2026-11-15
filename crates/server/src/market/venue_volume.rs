use std::collections::{BTreeSet, HashMap};

use domain::{KstTime, StockCode};

use crate::kiwoom::stream::Exchange;

pub const RETRY_SECS: i64 = 5;
const MAX_RETRY_SECS: i64 = 60;
const MAX_BUFFERED: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayVolumes {
    pub combined: u64,
    pub krx: u64,
    pub nxt: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VenueVolumes {
    pub krx: u64,
    pub nxt: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    pub exchange: Option<Exchange>,
    pub qty: u64,
    pub combined_cumulative: Option<u64>,
}

enum Tally {
    Seeding { buffered: Vec<Fill> },
    Live(DayVolumes),
    Retry { at: KstTime },
}

enum Applied {
    Counted(VenueVolumes),
    AlreadyCounted,
    Broken,
}

#[derive(Default)]
pub struct DayTallies {
    by_code: HashMap<StockCode, Tally>,
    failures: HashMap<StockCode, u32>,
}

impl DayTallies {
    pub fn tracks(&self, code: StockCode) -> bool {
        self.by_code.contains_key(&code)
    }

    pub fn take_due(&mut self, wanted: &BTreeSet<StockCode>, now: KstTime) -> Vec<StockCode> {
        self.by_code.retain(|code, _| wanted.contains(code));
        self.failures.retain(|code, _| wanted.contains(code));
        let mut due = Vec::new();
        for code in wanted {
            let start = match self.by_code.get(code) {
                None => true,
                Some(Tally::Retry { at }) => *at <= now,
                Some(_) => false,
            };
            if start {
                self.by_code.insert(*code, Tally::Seeding { buffered: Vec::new() });
                due.push(*code);
            }
        }
        due
    }

    pub fn apply(&mut self, code: StockCode, fill: Fill, now: KstTime) -> Option<VenueVolumes> {
        match self.by_code.get_mut(&code)? {
            Tally::Seeding { buffered } if buffered.len() < MAX_BUFFERED => {
                buffered.push(fill);
                None
            }
            Tally::Seeding { .. } => {
                self.by_code.insert(code, retry(now, 0));
                None
            }
            Tally::Retry { .. } => None,
            Tally::Live(volumes) => match count(volumes, fill, false) {
                Applied::Counted(v) => Some(v),
                Applied::AlreadyCounted => None,
                Applied::Broken => {
                    tracing::debug!(code = code.as_str(), "거래소별 거래량을 이을 수 없어 다시 조회합니다");
                    self.by_code.insert(code, retry(now, 0));
                    None
                }
            },
        }
    }

    pub fn seeded(&mut self, code: StockCode, volumes: Option<DayVolumes>, now: KstTime) {
        let Some(Tally::Seeding { buffered }) = self.by_code.get_mut(&code) else {
            return;
        };
        let buffered = std::mem::take(buffered);
        let failures = self.failures.get(&code).copied().unwrap_or(0);
        let Some(mut live) = volumes else {
            self.by_code.insert(code, retry(now, failures));
            self.failures.insert(code, failures + 1);
            return;
        };
        self.failures.remove(&code);
        for fill in buffered {
            if matches!(count(&mut live, fill, true), Applied::Broken) {
                self.by_code.insert(code, retry(now, 0));
                return;
            }
        }
        self.by_code.insert(code, Tally::Live(live));
    }
}

fn retry(now: KstTime, failures: u32) -> Tally {
    Tally::Retry { at: now.plus_secs((RETRY_SECS << failures.min(4)).min(MAX_RETRY_SECS)) }
}

fn count(live: &mut DayVolumes, fill: Fill, inside_snapshot: bool) -> Applied {
    let Some(combined) = fill.combined_cumulative else {
        return Applied::Broken;
    };
    if combined == live.combined || (inside_snapshot && combined < live.combined) {
        return Applied::AlreadyCounted;
    }
    let Some(exchange) = fill.exchange else {
        return Applied::Broken;
    };
    if live.combined.checked_add(fill.qty) != Some(combined) {
        return Applied::Broken;
    }
    live.combined = combined;
    match exchange {
        Exchange::Krx => live.krx += fill.qty,
        Exchange::Nxt => live.nxt += fill.qty,
    }
    Applied::Counted(VenueVolumes { krx: live.krx, nxt: live.nxt })
}

#[cfg(test)]
mod tests {
    use domain::KstDate;

    use super::*;
    use crate::clock::kst;

    fn at(s: u32) -> KstTime {
        kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, s)
    }

    fn code() -> StockCode {
        StockCode::parse("005930").unwrap()
    }

    fn fill(exchange: Option<Exchange>, qty: u64, cumulative: u64) -> Fill {
        Fill { exchange, qty, combined_cumulative: Some(cumulative) }
    }

    fn live(volumes: DayVolumes) -> DayTallies {
        let mut t = DayTallies::default();
        assert_eq!(t.take_due(&BTreeSet::from([code()]), at(0)), vec![code()]);
        t.seeded(code(), Some(volumes), at(0));
        t
    }

    const START: DayVolumes = DayVolumes { combined: 1_000, krx: 700, nxt: 300 };

    #[test]
    fn a_fill_adds_its_quantity_to_its_own_exchange_only() {
        let mut t = live(START);
        assert_eq!(t.apply(code(), fill(Some(Exchange::Nxt), 5, 1_005), at(1)), Some(VenueVolumes { krx: 700, nxt: 305 }));
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 20, 1_025), at(2)), Some(VenueVolumes { krx: 720, nxt: 305 }));
    }

    #[test]
    fn fills_already_inside_the_snapshot_are_not_counted_twice() {
        let mut t = DayTallies::default();
        t.take_due(&BTreeSet::from([code()]), at(0));
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 4, 998), at(1)), None, "조회 중에는 모아 둔다");
        assert_eq!(t.apply(code(), fill(Some(Exchange::Nxt), 2, 1_000), at(1)), None);
        assert_eq!(t.apply(code(), fill(Some(Exchange::Nxt), 3, 1_003), at(1)), None);
        t.seeded(code(), Some(START), at(2));
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 1, 1_004), at(3)), Some(VenueVolumes { krx: 701, nxt: 303 }), "1_000 이하는 조회 값에 있고 1_003만 더해졌다");
    }

    #[test]
    fn a_cumulative_that_goes_backwards_after_the_snapshot_breaks_the_numbers() {
        let mut t = live(START);
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 100, 100), at(1)), None, "날이 바뀌어 누적이 다시 시작했다");
        assert_eq!(t.take_due(&BTreeSet::from([code()]), at(6)), vec![code()]);
    }

    #[test]
    fn a_duplicate_fill_changes_nothing() {
        let mut t = live(START);
        assert!(t.apply(code(), fill(Some(Exchange::Krx), 1, 1_001), at(1)).is_some());
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 1, 1_001), at(2)), None);
        assert_eq!(t.apply(code(), fill(Some(Exchange::Nxt), 1, 1_002), at(3)), Some(VenueVolumes { krx: 701, nxt: 301 }));
    }

    #[test]
    fn a_missed_fill_stops_the_numbers_until_the_next_snapshot() {
        let mut t = live(START);
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 5, 1_010), at(1)), None, "1_005에서 1_010으로 건너뛰었다");
        assert_eq!(t.take_due(&BTreeSet::from([code()]), at(3)), Vec::<StockCode>::new(), "다시 조회는 5초 뒤");
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 1, 1_011), at(4)), None, "다시 받기 전에는 값을 내지 않는다");
        assert_eq!(t.take_due(&BTreeSet::from([code()]), at(6)), vec![code()]);
        t.seeded(code(), Some(DayVolumes { combined: 1_012, krx: 710, nxt: 302 }), at(7));
        assert_eq!(t.apply(code(), fill(Some(Exchange::Nxt), 8, 1_020), at(8)), Some(VenueVolumes { krx: 710, nxt: 310 }));
    }

    #[test]
    fn a_fill_without_an_exchange_or_a_cumulative_breaks_the_numbers() {
        for broken in [fill(None, 1, 1_001), Fill { exchange: Some(Exchange::Krx), qty: 1, combined_cumulative: None }] {
            let mut t = live(START);
            assert_eq!(t.apply(code(), broken, at(1)), None);
            assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 1, 1_001), at(2)), None);
        }
    }

    #[test]
    fn a_snapshot_the_buffered_fills_do_not_continue_is_retried() {
        let mut t = DayTallies::default();
        t.take_due(&BTreeSet::from([code()]), at(0));
        t.apply(code(), fill(Some(Exchange::Krx), 1, 1_050), at(1));
        t.seeded(code(), Some(START), at(2));
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 1, 1_051), at(3)), None);
        assert_eq!(t.take_due(&BTreeSet::from([code()]), at(7)), vec![code()]);
    }

    #[test]
    fn a_fill_without_an_exchange_inside_the_snapshot_breaks_nothing() {
        let mut t = DayTallies::default();
        t.take_due(&BTreeSet::from([code()]), at(0));
        t.apply(code(), fill(None, 2, 995), at(1));
        t.seeded(code(), Some(START), at(2));
        assert_eq!(t.apply(code(), fill(Some(Exchange::Krx), 5, 1_005), at(3)), Some(VenueVolumes { krx: 705, nxt: 300 }));
    }

    #[test]
    fn repeated_failed_snapshots_are_retried_less_and_less_often() {
        let mut t = DayTallies::default();
        let wanted = BTreeSet::from([code()]);
        let mut now = at(0);
        let mut waits = Vec::new();
        for _ in 0..6 {
            t.take_due(&wanted, now);
            t.seeded(code(), None, now);
            let wait = (1..=120).find(|s| !t.take_due(&wanted, now.plus_secs(*s)).is_empty()).unwrap();
            waits.push(wait);
            now = now.plus_secs(wait);
            t.seeded(code(), None, now);
        }
        assert_eq!(waits, [5, 10, 20, 40, 60, 60]);
    }

    #[test]
    fn a_failed_snapshot_is_retried_and_symbols_no_longer_wanted_are_dropped() {
        let mut t = DayTallies::default();
        t.take_due(&BTreeSet::from([code()]), at(0));
        t.seeded(code(), None, at(1));
        assert_eq!(t.take_due(&BTreeSet::from([code()]), at(5)), Vec::<StockCode>::new());
        assert_eq!(t.take_due(&BTreeSet::from([code()]), at(6)), vec![code()]);
        t.take_due(&BTreeSet::new(), at(7));
        assert!(!t.tracks(code()));
    }
}
