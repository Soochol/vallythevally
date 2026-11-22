use domain::{Ohlcv, Period, Price, Volume};
use serde::{Deserialize, Serialize};

use crate::market_source::PeriodBar;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Minute {
    pub start_unix: i64,
    pub open_centi: u64,
    pub high_centi: u64,
    pub low_centi: u64,
    pub close_centi: u64,
    pub volume: u64,
}

impl Minute {
    fn ohlcv(&self) -> Option<Ohlcv> {
        let price = |centi| Price::from_centi(centi);
        Ohlcv::try_new(price(self.open_centi)?, price(self.high_centi)?, price(self.low_centi)?, price(self.close_centi)?, Volume(self.volume)).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Position {
    StockAt { at_unix: i64 },
    IndexNextPage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MinuteCursor {
    pub position: Position,
    pub carried: Vec<Minute>,
}

impl MinuteCursor {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("숫자만 담은 구조체")
    }

    pub fn decode(text: &str) -> Option<MinuteCursor> {
        serde_json::from_str(text).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    pub bars: Vec<PeriodBar>,
    pub held_back: Vec<Minute>,
}

pub fn build(period: Period, minutes: &[Minute], more_older_minutes: bool) -> Result<Built, Minute> {
    let mut sorted = minutes.to_vec();
    sorted.sort_by_key(|m| m.start_unix);
    sorted.dedup_by_key(|m| m.start_unix);
    let held_from = sorted
        .first()
        .map(|oldest| (oldest, period.bucket(domain::KstTime::from_unix(oldest.start_unix))))
        .filter(|(oldest, bucket)| more_older_minutes && oldest.start_unix > bucket.start().unix())
        .map(|(_, bucket)| bucket);
    let mut bars: Vec<PeriodBar> = Vec::new();
    let mut held_back = Vec::new();
    let mut open_group: Option<(domain::Bucket, Vec<Minute>)> = None;
    for minute in sorted {
        let bucket = period.bucket(domain::KstTime::from_unix(minute.start_unix));
        if open_group.as_ref().is_some_and(|(current, _)| *current != bucket) {
            let (done, group) = open_group.take().expect("방금 있다고 확인했다");
            flush(done, &group, held_from, &mut bars, &mut held_back)?;
        }
        open_group.get_or_insert_with(|| (bucket, Vec::new())).1.push(minute);
    }
    if let Some((done, group)) = open_group {
        flush(done, &group, held_from, &mut bars, &mut held_back)?;
    }
    Ok(Built { bars, held_back })
}

fn flush(bucket: domain::Bucket, group: &[Minute], held_from: Option<domain::Bucket>, bars: &mut Vec<PeriodBar>, held_back: &mut Vec<Minute>) -> Result<(), Minute> {
    if held_from == Some(bucket) {
        held_back.extend_from_slice(group);
        return Ok(());
    }
    let first = group.first().expect("묶음은 비지 않았다");
    let last = group.last().expect("묶음은 비지 않았다");
    let high = group.iter().map(|m| m.high_centi).max().expect("묶음은 비지 않았다");
    let low = group.iter().map(|m| m.low_centi).min().expect("묶음은 비지 않았다");
    let volume = group.iter().fold(0_u64, |sum, m| sum.saturating_add(m.volume));
    let merged = Minute { start_unix: first.start_unix, open_centi: first.open_centi, high_centi: high, low_centi: low, close_centi: last.close_centi, volume };
    for minute in group {
        minute.ohlcv().ok_or(*minute)?;
    }
    let ohlcv = merged.ohlcv().ok_or(merged)?;
    bars.push(PeriodBar { bucket, ohlcv });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{KstDate, KstTime, TimeOfDay};

    fn at(h: u32, m: u32) -> i64 {
        KstTime::from_kst_civil(KstDate::new(2026, 11, 20).unwrap(), TimeOfDay::hms(h, m, 0).unwrap()).unix()
    }

    fn minute(h: u32, m: u32, o: u64, hi: u64, lo: u64, c: u64, v: u64) -> Minute {
        Minute { start_unix: at(h, m), open_centi: o * 100, high_centi: hi * 100, low_centi: lo * 100, close_centi: c * 100, volume: v }
    }

    #[test]
    fn five_one_minute_bars_make_one_five_minute_bar() {
        let minutes = [minute(9, 0, 100, 105, 99, 103, 10), minute(9, 1, 103, 110, 102, 108, 20), minute(9, 2, 108, 109, 95, 96, 30), minute(9, 3, 96, 100, 96, 99, 40), minute(9, 4, 99, 104, 98, 101, 50)];
        let built = build(Period::M5, &minutes, false).unwrap();
        assert_eq!(built.bars.len(), 1);
        let bar = built.bars[0];
        assert_eq!(bar.bucket.start().unix(), at(9, 0));
        let o = bar.ohlcv;
        assert_eq!((o.open().centi(), o.high().centi(), o.low().centi(), o.close().centi(), o.volume().0), (10_000, 11_000, 9_500, 10_100, 150));
    }

    #[test]
    fn the_oldest_bucket_is_held_back_while_older_minutes_may_still_come() {
        let minutes = [minute(9, 2, 1, 1, 1, 1, 1), minute(9, 3, 1, 1, 1, 1, 1), minute(9, 4, 1, 1, 1, 1, 1), minute(9, 5, 2, 2, 2, 2, 1)];
        let held = build(Period::M5, &minutes, true).unwrap();
        assert_eq!(held.bars.len(), 1);
        assert_eq!(held.bars[0].bucket.start().unix(), at(9, 5));
        assert_eq!(held.held_back.len(), 3);
        assert_eq!(build(Period::M5, &minutes, false).unwrap().bars.len(), 2);
    }

    #[test]
    fn a_nxt_open_at_eight_starts_its_own_five_minute_bucket() {
        let minutes = [minute(8, 0, 1, 1, 1, 1, 1), minute(8, 4, 1, 1, 1, 1, 1), minute(8, 5, 1, 1, 1, 1, 1)];
        let starts: Vec<_> = build(Period::M5, &minutes, false).unwrap().bars.iter().map(|b| b.bucket.start().unix()).collect();
        assert_eq!(starts, [at(8, 0), at(8, 5)]);
    }

    #[test]
    fn a_cursor_round_trips() {
        let cursor = MinuteCursor { position: Position::StockAt { at_unix: at(9, 1) }, carried: vec![minute(9, 2, 1, 2, 1, 2, 3)] };
        assert_eq!(MinuteCursor::decode(&cursor.encode()), Some(cursor));
        assert_eq!(MinuteCursor::decode("not a cursor"), None);
    }
}
