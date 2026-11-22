use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use domain::{Bucket, Feed, KstTime, Ohlcv, Period, SeriesKey, Symbol};

use super::series::{MinuteBar, SymbolDay, Weighting};
use crate::bars::{BarError, BarService};
use crate::clock::Clock;

pub const FRESH_SECS: i64 = 45;

const MINUTE_BARS_WANTED: usize = 800;

struct Entry {
    fetched_at: KstTime,
    day: Arc<SymbolDay>,
}

#[derive(Default)]
pub struct FlowCache {
    entries: Mutex<HashMap<Feed, Entry>>,
}

impl FlowCache {
    pub async fn day(&self, bars: &BarService, clock: &Clock, feed: Feed) -> Result<Arc<SymbolDay>, BarError> {
        let now = clock.now();
        if let Some(day) = self.fresh(feed, now) {
            return Ok(day);
        }
        let page = bars.page(SeriesKey { feed, period: Period::M1 }, None, MINUTE_BARS_WANTED).await?;
        let weighting = match feed.symbol() {
            Symbol::Stock(_) => Weighting::TradedValue,
            Symbol::Index(_) => Weighting::Excluded,
        };
        let minute = |bucket: Bucket, ohlcv: &Ohlcv| MinuteBar { start: bucket.start(), close_centi: ohlcv.close().centi(), volume: ohlcv.volume().0 };
        let bars = page.bars.iter().map(|b| minute(b.bucket, &b.ohlcv)).chain(page.current.iter().map(|c| minute(c.bucket, &c.ohlcv)));
        let day = SymbolDay::from_minute_bars(now.kst_date(), weighting, bars).ok_or_else(|| BarError::Internal("전일 종가를 알 수 없습니다".into()))?;
        let day = Arc::new(day);
        let mut entries = self.entries.lock().expect("흐름 캐시 잠금");
        entries.retain(|_, e| e.fetched_at.kst_date() == now.kst_date());
        entries.insert(feed, Entry { fetched_at: now, day: day.clone() });
        Ok(day)
    }

    fn fresh(&self, feed: Feed, now: KstTime) -> Option<Arc<SymbolDay>> {
        let entries = self.entries.lock().expect("흐름 캐시 잠금");
        let entry = entries.get(&feed)?;
        (entry.fetched_at.kst_date() == now.kst_date() && now.unix() - entry.fetched_at.unix() < FRESH_SECS).then(|| entry.day.clone())
    }
}
