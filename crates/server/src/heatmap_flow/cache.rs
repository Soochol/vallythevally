use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use domain::{Bucket, Feed, KstTime, Ohlcv, Period, SeriesKey, Symbol};

use super::series::{MinuteBar, SymbolDay, Weighting};
use crate::bars::{BarError, BarService};
use crate::clock::Clock;

pub const FRESH_SECS: i64 = 45;

pub trait Freshness: Sync {
    fn is_fresh(&self, fetched_at: KstTime, now: KstTime) -> bool;
    fn grant_tr(&self) -> BoxFuture<'_, bool>;
}

pub struct Rolling;

impl Freshness for Rolling {
    fn is_fresh(&self, fetched_at: KstTime, now: KstTime) -> bool {
        now.unix() - fetched_at.unix() < FRESH_SECS
    }

    fn grant_tr(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }
}

#[derive(Debug)]
pub enum DayError {
    OutOfBudget,
    Bars(BarError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Cached,
    Fetched,
}

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
        match self.day_by(bars, clock, feed, &Rolling).await {
            Ok((day, _)) => Ok(day),
            Err(DayError::Bars(e)) => Err(e),
            Err(DayError::OutOfBudget) => Err(BarError::Internal("예산이 없는 호출자가 아닌데 예산이 없다고 답했습니다".into())),
        }
    }

    pub async fn day_by(&self, bars: &BarService, clock: &Clock, feed: Feed, freshness: &dyn Freshness) -> Result<(Arc<SymbolDay>, Origin), DayError> {
        let now = clock.now();
        if let Some(day) = self.fresh(feed, now, freshness) {
            return Ok((day, Origin::Cached));
        }
        if !freshness.grant_tr().await {
            return Err(DayError::OutOfBudget);
        }
        let page = bars.page(SeriesKey { feed, period: Period::M1 }, None, MINUTE_BARS_WANTED).await.map_err(DayError::Bars)?;
        let weighting = match feed.symbol() {
            Symbol::Stock(_) => Weighting::TradedValue,
            Symbol::Index(_) => Weighting::Excluded,
        };
        let minute = |bucket: Bucket, ohlcv: &Ohlcv| MinuteBar { start: bucket.start(), close_centi: ohlcv.close().centi(), volume: ohlcv.volume().0 };
        let bars = page.bars.iter().map(|b| minute(b.bucket, &b.ohlcv)).chain(page.current.iter().map(|c| minute(c.bucket, &c.ohlcv)));
        let day = SymbolDay::from_minute_bars(now.kst_date(), weighting, bars).ok_or_else(|| DayError::Bars(BarError::Internal("전일 종가를 알 수 없습니다".into())))?;
        let day = Arc::new(day);
        let mut entries = self.entries.lock().expect("흐름 캐시 잠금");
        entries.retain(|_, e| e.fetched_at.kst_date() == now.kst_date());
        entries.insert(feed, Entry { fetched_at: now, day: day.clone() });
        Ok((day, Origin::Fetched))
    }

    pub fn stale_count(&self, feeds: &[Feed], now: KstTime, freshness: &dyn Freshness) -> usize {
        feeds.iter().filter(|feed| self.fresh(**feed, now, freshness).is_none()).count()
    }

    fn fresh(&self, feed: Feed, now: KstTime, freshness: &dyn Freshness) -> Option<Arc<SymbolDay>> {
        let entries = self.entries.lock().expect("흐름 캐시 잠금");
        let entry = entries.get(&feed)?;
        (entry.fetched_at.kst_date() == now.kst_date() && freshness.is_fresh(entry.fetched_at, now)).then(|| entry.day.clone())
    }
}
