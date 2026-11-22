
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{ConfirmedBar, Feed, KstDate, KstTime, Ohlcv, Period, Price, SeriesKey, TimeOfDay};

use crate::bars::{BarError, BarService, CONT_FRESH_SECS, Cont, IDLE_EVICT_SECS, MAX_LIMIT, merge, window};
use crate::market_source::Priority;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpPage {
    pub bars: Vec<ConfirmedBar>,
    pub next_before: Option<KstTime>,
    pub unadjusted_days: Vec<KstDate>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct JumpKey {
    series: SeriesKey,
    date: KstDate,
}

#[derive(Default)]
pub(crate) struct JumpTable {
    slots: Mutex<HashMap<JumpKey, Arc<JumpSlot>>>,
}

struct JumpSlot {
    last_access: AtomicI64,
    jump: tokio::sync::Mutex<Jump>,
}

struct Jump {
    minutes: Column,
    daily: Column,
    unadjusted: BTreeSet<KstDate>,
}

#[derive(Default)]
struct Column {
    bars: Vec<ConfirmedBar>,
    reached_origin: bool,
    cont: Option<Cont>,
}

struct Page {
    rows: Vec<ConfirmedBar>,
    next: Option<Cont>,
}

#[derive(Clone, Copy)]
struct Rate {
    today_close: Price,
    base_close: Price,
}

impl JumpTable {
    pub(crate) async fn page(&self, bars: &BarService, key: SeriesKey, date: KstDate, before: Option<KstTime>, limit: usize, prio: Priority) -> Result<JumpPage, BarError> {
        if !key.period.is_intraday() {
            return Err(BarError::BadRequest(format!("바로가기는 분봉만 받습니다: {}", key.period.as_wire())));
        }
        if date >= bars.now().kst_date() {
            return Err(BarError::BadRequest(format!("기준일은 오늘보다 이른 날이어야 합니다: {date}")));
        }
        bars.check(key).await?;
        let slot = self.slot(JumpKey { series: key, date }, bars.now());
        let mut jump = slot.jump.lock().await;
        while jump.minutes.held_before(before) < limit && !jump.minutes.reached_origin {
            jump.extend_minutes(bars, key, date, prio).await?;
        }
        slot.last_access.store(bars.now().unix(), Ordering::SeqCst);
        let (page_bars, next_before) = window(&jump.minutes.bars, jump.minutes.reached_origin, before, limit);
        let days: BTreeSet<KstDate> = page_bars.iter().map(|b| b.bucket.start().kst_date()).collect();
        let unadjusted_days = days.intersection(&jump.unadjusted).copied().collect();
        Ok(JumpPage { bars: page_bars, next_before, unadjusted_days })
    }

    pub(crate) fn clear(&self) {
        self.slots.lock().expect("jump 잠금").clear();
    }

    pub(crate) fn evict_idle(&self, now_unix: i64) {
        self.slots.lock().expect("jump 잠금").retain(|_, slot| now_unix - slot.last_access.load(Ordering::SeqCst) < IDLE_EVICT_SECS || slot.jump.try_lock().is_err());
    }

    pub(crate) fn len(&self) -> usize {
        self.slots.lock().expect("jump 잠금").len()
    }

    fn slot(&self, key: JumpKey, now: KstTime) -> Arc<JumpSlot> {
        let mut slots = self.slots.lock().expect("jump 잠금");
        let slot = slots.entry(key).or_insert_with(|| {
            Arc::new(JumpSlot {
                last_access: AtomicI64::new(now.unix()),
                jump: tokio::sync::Mutex::new(Jump { minutes: Column::default(), daily: Column::default(), unadjusted: BTreeSet::new() }),
            })
        });
        slot.last_access.store(now.unix(), Ordering::SeqCst);
        slot.clone()
    }
}

impl Column {
    fn held_before(&self, before: Option<KstTime>) -> usize {
        before.map_or(self.bars.len(), |b| self.bars.partition_point(|x| x.bucket.start() < b))
    }

    fn absorb(&mut self, rows: Vec<ConfirmedBar>, next: Option<Cont>) {
        let reaches_oldest = match (rows.first(), self.bars.first()) {
            (Some(new), Some(old)) => new.bucket.start() <= old.bucket.start(),
            (_, None) => true,
            (None, Some(_)) => false,
        };
        self.bars = merge(std::mem::take(&mut self.bars), rows);
        if reaches_oldest || next.is_none() {
            self.reached_origin = next.is_none();
            self.cont = next;
        }
    }

    fn close_on(&self, day: KstDate) -> Option<Price> {
        close_on(&self.bars, day)
    }

    fn oldest_day(&self) -> Option<KstDate> {
        self.bars.first().map(|b| b.bucket.start().kst_date())
    }
}

fn close_on(daily: &[ConfirmedBar], day: KstDate) -> Option<Price> {
    daily.binary_search_by_key(&day, |b| b.bucket.start().kst_date()).ok().map(|i| daily[i].ohlcv.close())
}

impl Jump {
    async fn extend_minutes(&mut self, bars: &BarService, key: SeriesKey, base: KstDate, prio: Priority) -> Result<(), BarError> {
        for page in older_pages(bars, key, base, &self.minutes, prio).await? {
            let rows = self.adjust(bars, key, base, page.rows, prio).await?;
            self.minutes.absorb(rows, page.next);
        }
        Ok(())
    }

    async fn extend_daily(&mut self, bars: &BarService, daily_key: SeriesKey, base: KstDate, prio: Priority) -> Result<(), BarError> {
        for page in older_pages(bars, daily_key, base, &self.daily, prio).await? {
            self.daily.absorb(page.rows, page.next);
        }
        Ok(())
    }

    async fn adjust(&mut self, bars: &BarService, key: SeriesKey, base: KstDate, rows: Vec<ConfirmedBar>, prio: Priority) -> Result<Vec<ConfirmedBar>, BarError> {
        if matches!(key.feed, Feed::Index(_)) {
            return Ok(rows);
        }
        let day_of = |b: &ConfirmedBar| b.bucket.start().kst_date();
        let (Some(oldest), Some(newest)) = (rows.iter().map(day_of).min(), rows.iter().map(day_of).max()) else {
            return Ok(rows);
        };
        let daily_key = SeriesKey { period: Period::Day, ..key };
        while self.daily.oldest_day().is_none_or(|d| d > oldest) && !self.daily.reached_origin {
            self.extend_daily(bars, daily_key, base, prio).await?;
        }
        let today_daily = today_daily(bars, daily_key, oldest, newest, prio).await?;
        let mut rates: HashMap<KstDate, Option<Rate>> = HashMap::new();
        let adjusted = rows
            .into_iter()
            .map(|bar| {
                let day = day_of(&bar);
                let rate = *rates.entry(day).or_insert_with(|| match (close_on(&today_daily, day), self.daily.close_on(day)) {
                    (Some(today_close), Some(base_close)) => Some(Rate { today_close, base_close }),
                    _ => {
                        self.unadjusted.insert(day);
                        None
                    }
                });
                rate.map_or(bar, |rate| rate.adjusted(&bar))
            })
            .collect();
        Ok(adjusted)
    }
}

async fn older_pages(bars: &BarService, key: SeriesKey, base: KstDate, column: &Column, prio: Priority) -> Result<Vec<Page>, BarError> {
    let now = bars.now();
    if let Some(c) = column.cont.clone().filter(|c| now.unix() - c.received_at.unix() < CONT_FRESH_SECS) {
        let page = confirmed_page(bars.fetch_direct(key, c.base, Some(&c.key), prio).await?);
        let below = match (page.rows.last(), column.bars.first()) {
            (Some(newest_new), Some(oldest_old)) => newest_new.bucket.start() < oldest_old.bucket.start(),
            (None, _) | (_, None) => true,
        };
        if below {
            return Ok(vec![page]);
        }
        tracing::info!(symbol = %key.feed.symbol().as_wire(), venue = ?key.feed.venue(), period = key.period.as_wire(), cont_age_secs = now.unix() - c.received_at.unix(), "연속조회 키가 기대한 위치를 주지 않아 다시 따라갑니다");
    }
    let target = column.bars.first().map(|b| b.bucket.start());
    let mut pages = Vec::new();
    let mut cont: Option<Cont> = None;
    loop {
        let page = confirmed_page(bars.fetch_direct(key, base, cont.as_ref().map(|c| &c.key), prio).await?);
        let reached = match (page.rows.first(), target) {
            (Some(oldest_new), Some(t)) => oldest_new.bucket.start() < t,
            (Some(_), None) => true,
            (None, _) => false,
        };
        cont = page.next.clone();
        pages.push(page);
        if reached || cont.is_none() {
            return Ok(pages);
        }
    }
}

fn confirmed_page(fetched: crate::bars::Fetched) -> Page {
    Page { rows: fetched.rows.iter().map(|r| ConfirmedBar::from_kiwoom(r.bucket, r.ohlcv)).collect(), next: fetched.next }
}

async fn today_daily(bars: &BarService, daily_key: SeriesKey, oldest: KstDate, newest: KstDate, prio: Priority) -> Result<Vec<ConfirmedBar>, BarError> {
    let calendar_days = newest.days_since_epoch() - oldest.days_since_epoch() + 1;
    let mut limit = usize::try_from(calendar_days).unwrap_or(MAX_LIMIT).clamp(1, MAX_LIMIT);
    let mut before = Some(KstTime::from_kst_civil(newest.add_days(1), TimeOfDay::MIDNIGHT));
    let mut daily: Vec<ConfirmedBar> = Vec::new();
    while let Some(cursor) = before {
        let page = bars.page_with(daily_key, Some(cursor), limit, prio).await?;
        daily.splice(0..0, page.bars);
        before = page.next_before.filter(|_| daily.first().is_some_and(|b| b.bucket.start().kst_date() > oldest));
        limit = MAX_LIMIT;
    }
    Ok(daily)
}

impl Rate {
    fn adjusted(self, bar: &ConfirmedBar) -> ConfirmedBar {
        let o = &bar.ohlcv;
        let ohlcv = Ohlcv::try_new(self.apply(o.open()), self.apply(o.high()), self.apply(o.low()), self.apply(o.close()), o.volume())
            .expect("같은 비율을 곱한 가격은 low ≤ open, close ≤ high를 지킨다");
        ConfirmedBar { ohlcv, ..*bar }
    }

    fn apply(self, price: Price) -> Price {
        let won = round_half_up_div(u128::from(price.centi()) * u128::from(self.today_close.centi()), u128::from(self.base_close.centi()) * 100).max(1);
        Price::from_centi(u64::try_from(won * 100).unwrap_or(u64::MAX)).expect("1원 이상")
    }
}

fn round_half_up_div(num: u128, den: u128) -> u128 {
    (2 * num + den) / (2 * den)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate(today: u64, base: u64) -> Rate {
        Rate { today_close: Price::from_centi(today * 100).unwrap(), base_close: Price::from_centi(base * 100).unwrap() }
    }

    fn won(w: u64) -> Price {
        Price::from_centi(w * 100).unwrap()
    }

    #[test]
    fn rounding_goes_half_up_to_whole_won() {
        assert_eq!(round_half_up_div(5, 2), 3, "2.5 → 3");
        assert_eq!(round_half_up_div(7, 3), 2, "2.33 → 2");
        assert_eq!(round_half_up_div(8, 3), 3, "2.67 → 3");
        assert_eq!(rate(1, 2).apply(won(5)), won(3), "2.5원 → 3원");
        assert_eq!(rate(1, 2).apply(won(4)), won(2));
    }

    #[test]
    fn a_rate_below_one_won_never_makes_a_zero_price() {
        assert_eq!(rate(1, 1000).apply(won(10)), won(1));
    }

    #[test]
    fn the_same_rate_keeps_the_ohlcv_order_and_the_volume() {
        let ohlcv = Ohlcv::try_new(won(275_500), won(277_000), won(275_000), won(276_500), domain::Volume(65_937)).unwrap();
        let bucket = Period::M60.bucket(KstTime::from_kst_civil(KstDate::new(2026, 7, 16).unwrap(), TimeOfDay::MIDNIGHT).plus_secs(15 * 3600));
        let bar = ConfirmedBar::from_kiwoom(bucket, ohlcv);
        let adjusted = rate(212_767, 276_500).adjusted(&bar);
        assert_eq!(adjusted.ohlcv.volume(), ohlcv.volume());
        assert!(adjusted.ohlcv.low() <= adjusted.ohlcv.open().min(adjusted.ohlcv.close()) && adjusted.ohlcv.open().max(adjusted.ohlcv.close()) <= adjusted.ohlcv.high());
        assert_eq!(adjusted.ohlcv.close(), won(212_767), "기준일 종가는 오늘 기준 종가가 된다");
    }
}
