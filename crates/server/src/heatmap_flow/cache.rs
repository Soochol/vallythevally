use std::collections::HashMap;
use std::sync::Arc;

use domain::{Bucket, Feed, KstTime, Ohlcv, Period, SeriesKey, Symbol};

use super::series::{MinuteBar, SymbolDay, Weighting};
use crate::bars::{BarError, BarService};
use crate::clock::Clock;
use crate::market_source::{GenerationScoped, SourceGeneration};

pub const FRESH_SECS: i64 = 45;

#[derive(Debug)]
pub enum DayError {
    NotCollected,
    Bars(BarError),
}

const MINUTE_BARS_WANTED: usize = 800;

struct Entry {
    fetched_at: KstTime,
    day: Arc<SymbolDay>,
}

pub struct FlowCache {
    entries: GenerationScoped<HashMap<Feed, Entry>>,
}

impl FlowCache {
    pub fn with_generation(generation: SourceGeneration) -> FlowCache {
        FlowCache { entries: GenerationScoped::new(generation) }
    }

    pub async fn day(&self, bars: &BarService, clock: &Clock, feed: Feed) -> Result<Arc<SymbolDay>, BarError> {
        let started = self.entries.ticket();
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
        self.entries.keep(started, |entries| {
            entries.retain(|_, e| e.fetched_at.kst_date() == now.kst_date());
            entries.insert(feed, Entry { fetched_at: now, day: day.clone() });
        });
        Ok(day)
    }

    fn fresh(&self, feed: Feed, now: KstTime) -> Option<Arc<SymbolDay>> {
        self.entries.read(|entries| {
            let entry = entries.get(&feed)?;
            (entry.fetched_at.kst_date() == now.kst_date() && now.unix() - entry.fetched_at.unix() < FRESH_SECS).then(|| entry.day.clone())
        })
    }
}
