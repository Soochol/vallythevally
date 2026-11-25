use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{KstDate, KstTime, Period, StockCode, Symbol, TimeOfDay};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{self, ApiErrorCode, BrokerDaySource, SymbolCode, UnixSeconds};
use crate::collected::kind::{CollectedProgramRow, CollectedTradeTick};
use crate::http::{ApiFailure, AppState};
use crate::market_source::stream::TradeSide;
use crate::shared_data::CollectorPaths;

pub const MID_MIN_WON: u64 = 5_000_000;
pub const LARGE_MIN_WON: u64 = 30_000_000;
pub const WHALE_MIN_WON: u64 = 100_000_000;
pub const MAX_RANGE_DAYS: i64 = 31;

const WON_PER_MILLION: f64 = 1_000_000.0;
const MINUTES_PER_DAY: usize = 1440;
const CACHE_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickTier {
    Retail,
    Mid,
    Large,
    Whale,
}

pub fn classify_tick_tier(value_won: u64) -> TickTier {
    if value_won >= WHALE_MIN_WON {
        TickTier::Whale
    } else if value_won >= LARGE_MIN_WON {
        TickTier::Large
    } else if value_won >= MID_MIN_WON {
        TickTier::Mid
    } else {
        TickTier::Retail
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MicroSeriesState {
    Ready,
    Disabled,
    NotCollected,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TickCvdPoint {
    pub t: UnixSeconds,
    pub whale_net_million_won: f64,
    pub large_net_million_won: f64,
    pub mid_net_million_won: f64,
    pub retail_net_million_won: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TickCvdPage {
    pub symbol: SymbolCode,
    pub period: api::Period,
    pub state: MicroSeriesState,
    pub points: Vec<TickCvdPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgramSeriesPoint {
    pub t: UnixSeconds,
    pub net_buy_amount_million_won: f64,
    #[ts(type = "number")]
    pub net_buy_qty: i64,
    pub buy_amount_million_won: f64,
    pub sell_amount_million_won: f64,
    pub program_share_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgramSeriesPage {
    pub symbol: SymbolCode,
    pub period: api::Period,
    pub state: MicroSeriesState,
    pub points: Vec<ProgramSeriesPoint>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TickMinuteBucket {
    pub minute_unix: i64,
    pub whale_won: i128,
    pub large_won: i128,
    pub mid_won: i128,
    pub retail_won: i128,
    pub total_traded_won: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgramMinuteBucket {
    pub minute_unix: i64,
    pub net_buy_amount_million_won: i64,
    pub net_buy_qty: i64,
    pub buy_amount_million_won: u64,
    pub sell_amount_million_won: u64,
}

#[derive(Clone, Copy, Default)]
struct TickMinuteSlot {
    has_ticks: bool,
    whale_won: i128,
    large_won: i128,
    mid_won: i128,
    retail_won: i128,
    total_traded_won: u128,
}

impl TickMinuteSlot {
    fn add_tick(&mut self, tick: &CollectedTradeTick) {
        let value_won = tick.value_won();
        if let Some(side) = tick.side() {
            let signed_won = match side {
                TradeSide::Buy => i128::from(value_won),
                TradeSide::Sell => -i128::from(value_won),
            };
            match classify_tick_tier(value_won) {
                TickTier::Whale => self.whale_won += signed_won,
                TickTier::Large => self.large_won += signed_won,
                TickTier::Mid => self.mid_won += signed_won,
                TickTier::Retail => self.retail_won += signed_won,
            }
        }
        self.total_traded_won += u128::from(value_won);
        self.has_ticks = true;
    }
}

pub fn bucket_ticks_by_minute(date: KstDate, ticks: &[CollectedTradeTick]) -> Vec<TickMinuteBucket> {
    if ticks.is_empty() {
        return Vec::new();
    }
    let day_start = KstTime::from_kst_civil(date, TimeOfDay::MIDNIGHT).unix();
    let mut slots = [TickMinuteSlot::default(); MINUTES_PER_DAY];
    for tick in ticks {
        let minute_idx = (tick.hhmmss.secs() / 60) as usize;
        slots[minute_idx].add_tick(tick);
    }
    let mut out = Vec::new();
    for (minute_idx, slot) in slots.iter().enumerate() {
        if !slot.has_ticks {
            continue;
        }
        out.push(TickMinuteBucket {
            minute_unix: day_start + (minute_idx as i64) * 60,
            whale_won: slot.whale_won,
            large_won: slot.large_won,
            mid_won: slot.mid_won,
            retail_won: slot.retail_won,
            total_traded_won: slot.total_traded_won,
        });
    }
    out
}

fn merge_tick_minutes(date: KstDate, existing: &[TickMinuteBucket], added: &[CollectedTradeTick]) -> Vec<TickMinuteBucket> {
    if added.is_empty() {
        return existing.to_vec();
    }
    let day_start = KstTime::from_kst_civil(date, TimeOfDay::MIDNIGHT).unix();
    let mut slots = [TickMinuteSlot::default(); MINUTES_PER_DAY];
    for bucket in existing {
        let offset = bucket.minute_unix - day_start;
        if offset >= 0 && offset < (MINUTES_PER_DAY as i64) * 60 {
            let idx = (offset / 60) as usize;
            slots[idx] = TickMinuteSlot {
                has_ticks: true,
                whale_won: bucket.whale_won,
                large_won: bucket.large_won,
                mid_won: bucket.mid_won,
                retail_won: bucket.retail_won,
                total_traded_won: bucket.total_traded_won,
            };
        }
    }
    for tick in added {
        let minute_idx = (tick.hhmmss.secs() / 60) as usize;
        slots[minute_idx].add_tick(tick);
    }
    let mut out = Vec::new();
    for (minute_idx, slot) in slots.iter().enumerate() {
        if !slot.has_ticks {
            continue;
        }
        out.push(TickMinuteBucket {
            minute_unix: day_start + (minute_idx as i64) * 60,
            whale_won: slot.whale_won,
            large_won: slot.large_won,
            mid_won: slot.mid_won,
            retail_won: slot.retail_won,
            total_traded_won: slot.total_traded_won,
        });
    }
    out
}

pub fn bucket_program_by_minute(date: KstDate, rows: &[CollectedProgramRow]) -> Vec<ProgramMinuteBucket> {
    if rows.is_empty() {
        return Vec::new();
    }
    let day_start = KstTime::from_kst_civil(date, TimeOfDay::MIDNIGHT).unix();
    let mut slots: [Option<ProgramMinuteBucket>; MINUTES_PER_DAY] = [None; MINUTES_PER_DAY];
    for row in rows {
        let minute_idx = (row.hhmmss.secs() / 60) as usize;
        slots[minute_idx] = Some(ProgramMinuteBucket {
            minute_unix: day_start + (minute_idx as i64) * 60,
            net_buy_amount_million_won: row.net_buy_amount_million_won,
            net_buy_qty: row.net_buy_qty,
            buy_amount_million_won: row.buy_amount_million_won,
            sell_amount_million_won: row.sell_amount_million_won,
        });
    }
    slots.into_iter().flatten().collect()
}

fn merge_program_minutes(date: KstDate, existing: &[ProgramMinuteBucket], added: &[CollectedProgramRow]) -> Vec<ProgramMinuteBucket> {
    if added.is_empty() {
        return existing.to_vec();
    }
    let day_start = KstTime::from_kst_civil(date, TimeOfDay::MIDNIGHT).unix();
    let mut slots: [Option<ProgramMinuteBucket>; MINUTES_PER_DAY] = [None; MINUTES_PER_DAY];
    for bucket in existing {
        let offset = bucket.minute_unix - day_start;
        if offset >= 0 && offset < (MINUTES_PER_DAY as i64) * 60 {
            slots[(offset / 60) as usize] = Some(*bucket);
        }
    }
    for row in added {
        let minute_idx = (row.hhmmss.secs() / 60) as usize;
        slots[minute_idx] = Some(ProgramMinuteBucket {
            minute_unix: day_start + (minute_idx as i64) * 60,
            net_buy_amount_million_won: row.net_buy_amount_million_won,
            net_buy_qty: row.net_buy_qty,
            buy_amount_million_won: row.buy_amount_million_won,
            sell_amount_million_won: row.sell_amount_million_won,
        });
    }
    slots.into_iter().flatten().collect()
}

pub fn period_seconds(period: Period) -> Option<i64> {
    period.minutes().map(|minutes| minutes * 60)
}

fn bucket_start(unix_sec: i64, period_secs: i64) -> i64 {
    unix_sec.div_euclid(period_secs) * period_secs
}

fn in_requested_range(bucket_t: i64, from: Option<i64>, to: Option<i64>, period_secs: i64) -> bool {
    if let Some(start) = from
        && bucket_t < bucket_start(start, period_secs)
    {
        return false;
    }
    if let Some(end) = to
        && bucket_t > end
    {
        return false;
    }
    true
}

pub fn rollup_tick_cvd_day(minutes: &[TickMinuteBucket], period_secs: i64, from: Option<i64>, to: Option<i64>) -> Vec<TickCvdPoint> {
    if minutes.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cum_whale: i128 = 0;
    let mut cum_large: i128 = 0;
    let mut cum_mid: i128 = 0;
    let mut cum_retail: i128 = 0;
    let mut idx = 0usize;
    while idx < minutes.len() {
        let bar_t = bucket_start(minutes[idx].minute_unix, period_secs);
        while idx < minutes.len() && bucket_start(minutes[idx].minute_unix, period_secs) == bar_t {
            let bucket = &minutes[idx];
            cum_whale += bucket.whale_won;
            cum_large += bucket.large_won;
            cum_mid += bucket.mid_won;
            cum_retail += bucket.retail_won;
            idx += 1;
        }
        if in_requested_range(bar_t, from, to, period_secs) {
            out.push(TickCvdPoint {
                t: UnixSeconds(bar_t),
                whale_net_million_won: cum_whale as f64 / WON_PER_MILLION,
                large_net_million_won: cum_large as f64 / WON_PER_MILLION,
                mid_net_million_won: cum_mid as f64 / WON_PER_MILLION,
                retail_net_million_won: cum_retail as f64 / WON_PER_MILLION,
            });
        }
    }
    out
}

pub fn aggregate_tick_cvd_day(
    date: KstDate,
    ticks: &[CollectedTradeTick],
    period: Period,
    from: Option<i64>,
    to: Option<i64>,
) -> Vec<TickCvdPoint> {
    let Some(period_secs) = period_seconds(period) else {
        return Vec::new();
    };
    let minutes = bucket_ticks_by_minute(date, ticks);
    rollup_tick_cvd_day(&minutes, period_secs, from, to)
}

pub fn rollup_program_day(
    program_minutes: &[ProgramMinuteBucket],
    tick_minutes: &[TickMinuteBucket],
    period_secs: i64,
    from: Option<i64>,
    to: Option<i64>,
) -> Vec<ProgramSeriesPoint> {
    if program_minutes.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut tick_idx = 0usize;
    let mut cum_traded_won: u128 = 0;
    let mut idx = 0usize;
    while idx < program_minutes.len() {
        let bar_t = bucket_start(program_minutes[idx].minute_unix, period_secs);
        let mut last = program_minutes[idx];
        idx += 1;
        while idx < program_minutes.len() && bucket_start(program_minutes[idx].minute_unix, period_secs) == bar_t {
            last = program_minutes[idx];
            idx += 1;
        }
        let bar_end_exclusive = bar_t + period_secs;
        while tick_idx < tick_minutes.len() && tick_minutes[tick_idx].minute_unix < bar_end_exclusive {
            cum_traded_won += tick_minutes[tick_idx].total_traded_won;
            tick_idx += 1;
        }
        if in_requested_range(bar_t, from, to, period_secs) {
            let buy_million = last.buy_amount_million_won as f64;
            let sell_million = last.sell_amount_million_won as f64;
            let program_share_pct = if cum_traded_won > 0 {
                let total_million = cum_traded_won as f64 / WON_PER_MILLION;
                Some((((buy_million + sell_million) / total_million) * 100.0).clamp(0.0, 100.0))
            } else {
                None
            };
            out.push(ProgramSeriesPoint {
                t: UnixSeconds(bar_t),
                net_buy_amount_million_won: last.net_buy_amount_million_won as f64,
                net_buy_qty: last.net_buy_qty,
                buy_amount_million_won: buy_million,
                sell_amount_million_won: sell_million,
                program_share_pct,
            });
        }
    }
    out
}

pub fn aggregate_program_day(
    date: KstDate,
    rows: &[CollectedProgramRow],
    ticks: &[CollectedTradeTick],
    period: Period,
    from: Option<i64>,
    to: Option<i64>,
) -> Vec<ProgramSeriesPoint> {
    let Some(period_secs) = period_seconds(period) else {
        return Vec::new();
    };
    let program_minutes = bucket_program_by_minute(date, rows);
    let tick_minutes = bucket_ticks_by_minute(date, ticks);
    rollup_program_day(&program_minutes, &tick_minutes, period_secs, from, to)
}

type CacheKey = (String, String);

struct CachedDay<V> {
    cursor: String,
    buckets: Arc<Vec<V>>,
}

struct DayLru<V> {
    entries: HashMap<CacheKey, CachedDay<V>>,
    order: VecDeque<CacheKey>,
}

impl<V> DayLru<V> {
    fn new() -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new() }
    }

    fn peek(&self, key: &CacheKey) -> Option<(String, Arc<Vec<V>>)> {
        self.entries.get(key).map(|entry| (entry.cursor.clone(), Arc::clone(&entry.buckets)))
    }

    fn insert(&mut self, key: CacheKey, cursor: String, buckets: Arc<Vec<V>>) {
        if self.entries.contains_key(&key) {
            self.order.retain(|existing| existing != &key);
        } else if self.order.len() >= CACHE_CAPACITY
            && let Some(evicted) = self.order.pop_front()
        {
            self.entries.remove(&evicted);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, CachedDay { cursor, buckets });
    }
}

pub struct MicroSeriesCache {
    ticks: Mutex<DayLru<TickMinuteBucket>>,
    program: Mutex<DayLru<ProgramMinuteBucket>>,
}

impl Default for MicroSeriesCache {
    fn default() -> Self {
        Self::new()
    }
}

impl MicroSeriesCache {
    pub fn new() -> Self {
        Self {
            ticks: Mutex::new(DayLru::new()),
            program: Mutex::new(DayLru::new()),
        }
    }

    async fn load_tick_minutes(
        &self,
        st: &AppState,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        now: KstTime,
    ) -> Result<(bool, Arc<Vec<TickMinuteBucket>>), String> {
        let key = (stock.as_str().to_owned(), date_str.to_owned());
        let cached = self.ticks.lock().expect("micro ticks cache").peek(&key);
        let after = cached.as_ref().map(|(cursor, _)| cursor.as_str());
        let slice = st.collected.ticks_day(paths, stock, date, date_str, after, now).await?;
        if slice.source == BrokerDaySource::None {
            return Ok((false, Arc::new(Vec::new())));
        }
        if !slice.reset
            && let Some((_, prev_buckets)) = cached
        {
            if slice.snapshots.is_empty() {
                return Ok((true, prev_buckets));
            }
            let merged = Arc::new(merge_tick_minutes(date, &prev_buckets, &slice.snapshots));
            self.ticks.lock().expect("micro ticks cache").insert(key, slice.cursor, Arc::clone(&merged));
            return Ok((true, merged));
        }
        let built = Arc::new(bucket_ticks_by_minute(date, &slice.snapshots));
        self.ticks.lock().expect("micro ticks cache").insert(key, slice.cursor, Arc::clone(&built));
        Ok((true, built))
    }

    async fn load_program_minutes(
        &self,
        st: &AppState,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        now: KstTime,
    ) -> Result<(bool, Arc<Vec<ProgramMinuteBucket>>), String> {
        let key = (stock.as_str().to_owned(), date_str.to_owned());
        let cached = self.program.lock().expect("micro program cache").peek(&key);
        let after = cached.as_ref().map(|(cursor, _)| cursor.as_str());
        let slice = st.collected.program_day(paths, stock, date, date_str, after, now).await?;
        if slice.source == BrokerDaySource::None {
            return Ok((false, Arc::new(Vec::new())));
        }
        if !slice.reset
            && let Some((_, prev_buckets)) = cached
        {
            if slice.snapshots.is_empty() {
                return Ok((true, prev_buckets));
            }
            let merged = Arc::new(merge_program_minutes(date, &prev_buckets, &slice.snapshots));
            self.program.lock().expect("micro program cache").insert(key, slice.cursor, Arc::clone(&merged));
            return Ok((true, merged));
        }
        let built = Arc::new(bucket_program_by_minute(date, &slice.snapshots));
        self.program.lock().expect("micro program cache").insert(key, slice.cursor, Arc::clone(&built));
        Ok((true, built))
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    let cache = Arc::new(MicroSeriesCache::new());
    Router::new()
        .route("/api/symbols/{code}/tick-cvd", get(tick_cvd))
        .route("/api/symbols/{code}/program-series", get(program_series))
        .layer(Extension(cache))
}

struct MicroQuery {
    stock: StockCode,
    period: Period,
    period_secs: i64,
    from: Option<i64>,
    to: Option<i64>,
}

fn parse_query(code: &str, q: &HashMap<String, String>) -> Result<MicroQuery, ApiFailure> {
    let symbol = Symbol::parse(code).map_err(|e| ApiFailure::bad_request(format!("{e}: {code}")))?;
    let Symbol::Stock(stock) = symbol else {
        return Err(ApiFailure::bad_request(format!("지수는 미세 수급 지표를 지원하지 않습니다: {code}")));
    };
    let period_raw = q.get("period").ok_or_else(|| ApiFailure::bad_request("period가 필요합니다"))?;
    let period = Period::parse(period_raw).map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    let Some(period_secs) = period_seconds(period) else {
        return Err(ApiFailure::bad_request(format!("분봉 주기만 지원합니다: {period_raw}")));
    };
    let from = parse_optional_unix(q, "from")?;
    let to = parse_optional_unix(q, "to")?;
    if let (Some(start), Some(end)) = (from, to) {
        if start > end {
            return Err(ApiFailure::bad_request("from은 to보다 늦을 수 없습니다"));
        }
        let from_date = KstTime::from_unix(start).kst_date();
        let to_date = KstTime::from_unix(end).kst_date();
        let span = to_date.days_since_epoch() - from_date.days_since_epoch() + 1;
        if span > MAX_RANGE_DAYS {
            return Err(ApiFailure::bad_request(format!("조회 범위는 {MAX_RANGE_DAYS}일까지입니다")));
        }
    }
    Ok(MicroQuery { stock, period, period_secs, from, to })
}

fn parse_optional_unix(q: &HashMap<String, String>, name: &str) -> Result<Option<i64>, ApiFailure> {
    q.get(name)
        .filter(|raw| !raw.is_empty())
        .map(|raw| raw.parse::<i64>().map_err(|_| ApiFailure::bad_request(format!("{name}는 Unix 초여야 합니다: {raw}"))))
        .transpose()
}

fn paths_enabled(paths: &CollectorPaths) -> bool {
    paths.hoga_dir().is_some() || paths.shared_dir().is_some()
}

fn date_range(from: KstDate, to: KstDate) -> Vec<KstDate> {
    let span = to.days_since_epoch() - from.days_since_epoch() + 1;
    (0..span).map(|offset| from.add_days(offset)).collect()
}

fn explicit_dates(from: Option<i64>, to: Option<i64>, now: KstTime) -> Result<Option<Vec<KstDate>>, ApiFailure> {
    match (from, to) {
        (Some(start), Some(end)) => Ok(Some(date_range(KstTime::from_unix(start).kst_date(), KstTime::from_unix(end).kst_date()))),
        (Some(start), None) => {
            let from_date = KstTime::from_unix(start).kst_date();
            let today = now.kst_date();
            let to_date = if from_date <= today { today } else { from_date };
            let span = to_date.days_since_epoch() - from_date.days_since_epoch() + 1;
            if span > MAX_RANGE_DAYS {
                return Err(ApiFailure::bad_request(format!("조회 범위는 {MAX_RANGE_DAYS}일까지입니다")));
            }
            Ok(Some(date_range(from_date, to_date)))
        }
        (None, Some(end)) => Ok(Some(vec![KstTime::from_unix(end).kst_date()])),
        (None, None) => Ok(None),
    }
}

fn format_yyyymmdd(date: KstDate) -> String {
    format!("{:04}{:02}{:02}", date.year(), date.month(), date.day())
}

fn symbol_code(stock: StockCode) -> SymbolCode {
    SymbolCode(Symbol::Stock(stock).as_wire())
}

fn internal_error(context: &str, detail: impl std::fmt::Display) -> ApiFailure {
    tracing::error!(reason = %detail, "{context}");
    ApiFailure::new(ApiErrorCode::Internal, context)
}

async fn tick_cvd(
    State(st): State<Arc<AppState>>,
    Extension(cache): Extension<Arc<MicroSeriesCache>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<TickCvdPage>, ApiFailure> {
    let query = parse_query(&code, &q)?;
    let paths = st.collector_paths.snapshot();
    if !paths_enabled(&paths) {
        return Ok(Json(TickCvdPage {
            symbol: symbol_code(query.stock),
            period: query.period.into(),
            state: MicroSeriesState::Disabled,
            points: Vec::new(),
        }));
    }
    let now = st.clock.now();
    let dates = match explicit_dates(query.from, query.to, now)? {
        Some(dates) => dates,
        None => {
            let available = st
                .collected
                .ticks_days(paths.clone(), query.stock, now)
                .await
                .map_err(|e| internal_error("체결 수집 날짜 목록을 읽지 못했습니다", e))?;
            let Some(latest_str) = available.last() else {
                return Ok(Json(TickCvdPage {
                    symbol: symbol_code(query.stock),
                    period: query.period.into(),
                    state: MicroSeriesState::NotCollected,
                    points: Vec::new(),
                }));
            };
            let Some(latest) = KstDate::parse_yyyymmdd(latest_str) else {
                return Err(internal_error("체결 수집 날짜 형식이 잘못되었습니다", latest_str));
            };
            vec![latest]
        }
    };
    let mut any_collected = false;
    let mut points = Vec::new();
    for date in dates {
        let date_str = format_yyyymmdd(date);
        let (collected, minutes) = cache
            .load_tick_minutes(&st, paths.clone(), query.stock, date, &date_str, now)
            .await
            .map_err(|e| internal_error("수집 체결 자료를 읽지 못했습니다", e))?;
        if collected {
            any_collected = true;
            points.extend(rollup_tick_cvd_day(&minutes, query.period_secs, query.from, query.to));
        }
    }
    if !any_collected {
        let available = st
            .collected
            .ticks_days(paths, query.stock, now)
            .await
            .map_err(|e| internal_error("체결 수집 날짜 목록을 읽지 못했습니다", e))?;
        let state = if available.is_empty() { MicroSeriesState::NotCollected } else { MicroSeriesState::Ready };
        return Ok(Json(TickCvdPage {
            symbol: symbol_code(query.stock),
            period: query.period.into(),
            state,
            points: Vec::new(),
        }));
    }
    Ok(Json(TickCvdPage {
        symbol: symbol_code(query.stock),
        period: query.period.into(),
        state: MicroSeriesState::Ready,
        points,
    }))
}

async fn program_series(
    State(st): State<Arc<AppState>>,
    Extension(cache): Extension<Arc<MicroSeriesCache>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<ProgramSeriesPage>, ApiFailure> {
    let query = parse_query(&code, &q)?;
    let paths = st.collector_paths.snapshot();
    if !paths_enabled(&paths) {
        return Ok(Json(ProgramSeriesPage {
            symbol: symbol_code(query.stock),
            period: query.period.into(),
            state: MicroSeriesState::Disabled,
            points: Vec::new(),
        }));
    }
    let now = st.clock.now();
    let dates = match explicit_dates(query.from, query.to, now)? {
        Some(dates) => dates,
        None => {
            let available = st
                .collected
                .program_days(paths.clone(), query.stock, now)
                .await
                .map_err(|e| internal_error("프로그램 수집 날짜 목록을 읽지 못했습니다", e))?;
            let Some(latest_str) = available.last() else {
                return Ok(Json(ProgramSeriesPage {
                    symbol: symbol_code(query.stock),
                    period: query.period.into(),
                    state: MicroSeriesState::NotCollected,
                    points: Vec::new(),
                }));
            };
            let Some(latest) = KstDate::parse_yyyymmdd(latest_str) else {
                return Err(internal_error("프로그램 수집 날짜 형식이 잘못되었습니다", latest_str));
            };
            vec![latest]
        }
    };
    let mut any_collected = false;
    let mut points = Vec::new();
    for date in dates {
        let date_str = format_yyyymmdd(date);
        let (collected, program_minutes) = cache
            .load_program_minutes(&st, paths.clone(), query.stock, date, &date_str, now)
            .await
            .map_err(|e| internal_error("수집 프로그램 자료를 읽지 못했습니다", e))?;
        if collected {
            any_collected = true;
            let (_, tick_minutes) = cache
                .load_tick_minutes(&st, paths.clone(), query.stock, date, &date_str, now)
                .await
                .map_err(|e| internal_error("수집 체결 자료를 읽지 못했습니다", e))?;
            points.extend(rollup_program_day(&program_minutes, &tick_minutes, query.period_secs, query.from, query.to));
        }
    }
    if !any_collected {
        let available = st
            .collected
            .program_days(paths, query.stock, now)
            .await
            .map_err(|e| internal_error("프로그램 수집 날짜 목록을 읽지 못했습니다", e))?;
        let state = if available.is_empty() { MicroSeriesState::NotCollected } else { MicroSeriesState::Ready };
        return Ok(Json(ProgramSeriesPage {
            symbol: symbol_code(query.stock),
            period: query.period.into(),
            state,
            points: Vec::new(),
        }));
    }
    Ok(Json(ProgramSeriesPage {
        symbol: symbol_code(query.stock),
        period: query.period.into(),
        state: MicroSeriesState::Ready,
        points,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(day: u8) -> KstDate {
        KstDate::new(2026, 11, day).unwrap()
    }

    fn tick(hh: u32, mm: u32, ss: u32, price_won: u64, signed_qty: i64) -> CollectedTradeTick {
        let side = if signed_qty > 0 {
            Some(TradeSide::Buy)
        } else if signed_qty < 0 {
            Some(TradeSide::Sell)
        } else {
            None
        };
        CollectedTradeTick {
            recv_ms: 0,
            hhmmss: TimeOfDay::hms(hh, mm, ss).unwrap(),
            price_won,
            signed_qty,
            side,
            instant_value_thousand_won: None,
            exchange: None,
        }
    }

    fn program(hh: u32, mm: u32, ss: u32, net_amt: i64, net_qty: i64, buy_amt: u64, sell_amt: u64) -> CollectedProgramRow {
        CollectedProgramRow {
            recv_ms: 0,
            hhmmss: TimeOfDay::hms(hh, mm, ss).unwrap(),
            price_won: Some(70_000),
            sell_qty: 0,
            sell_amount_million_won: sell_amt,
            buy_qty: 0,
            buy_amount_million_won: buy_amt,
            net_buy_qty: net_qty,
            net_buy_qty_change: 0,
            net_buy_amount_million_won: net_amt,
            net_buy_amount_change_million_won: 0,
        }
    }

    #[test]
    fn tick_tier_boundaries_are_exact() {
        assert_eq!(classify_tick_tier(0), TickTier::Retail);
        assert_eq!(classify_tick_tier(4_999_999), TickTier::Retail);
        assert_eq!(classify_tick_tier(5_000_000), TickTier::Mid);
        assert_eq!(classify_tick_tier(29_999_999), TickTier::Mid);
        assert_eq!(classify_tick_tier(30_000_000), TickTier::Large);
        assert_eq!(classify_tick_tier(99_999_999), TickTier::Large);
        assert_eq!(classify_tick_tier(100_000_000), TickTier::Whale);
        assert_eq!(classify_tick_tier(500_000_000), TickTier::Whale);
    }

    #[test]
    fn tick_cvd_accumulates_signed_values_by_tier_and_resets_daily() {
        let day1 = date(23);
        let day2 = date(24);
        let d1_ticks = vec![
            tick(9, 0, 5, 100_000, 1_500),
            tick(9, 0, 10, 10_000, -400),
            tick(9, 1, 20, 50_000, 700),
            tick(9, 1, 45, 10_000, 600),
        ];
        let d2_ticks = vec![
            tick(9, 0, 1, 100_000, -1_200),
        ];

        let p1 = aggregate_tick_cvd_day(day1, &d1_ticks, Period::M1, None, None);
        let p2 = aggregate_tick_cvd_day(day2, &d2_ticks, Period::M1, None, None);

        assert_eq!(p1.len(), 2);
        assert_eq!(p1[0].t.0, KstTime::from_kst_civil(day1, TimeOfDay::hms(9, 0, 0).unwrap()).unix());
        assert!((p1[0].whale_net_million_won - 150.0).abs() < 1e-9);
        assert!((p1[0].retail_net_million_won - (-4.0)).abs() < 1e-9);
        assert!((p1[0].large_net_million_won - 0.0).abs() < 1e-9);
        assert!((p1[0].mid_net_million_won - 0.0).abs() < 1e-9);

        assert_eq!(p1[1].t.0, KstTime::from_kst_civil(day1, TimeOfDay::hms(9, 1, 0).unwrap()).unix());
        assert!((p1[1].whale_net_million_won - 150.0).abs() < 1e-9);
        assert!((p1[1].large_net_million_won - 35.0).abs() < 1e-9);
        assert!((p1[1].mid_net_million_won - 6.0).abs() < 1e-9);
        assert!((p1[1].retail_net_million_won - (-4.0)).abs() < 1e-9);

        assert_eq!(p2.len(), 1);
        assert!((p2[0].whale_net_million_won - (-120.0)).abs() < 1e-9);
        assert!((p2[0].large_net_million_won - 0.0).abs() < 1e-9);
        assert!((p2[0].mid_net_million_won - 0.0).abs() < 1e-9);
        assert!((p2[0].retail_net_million_won - 0.0).abs() < 1e-9);
    }

    #[test]
    fn program_series_buckets_last_row_and_computes_clamped_share_pct() {
        let day = date(23);
        let rows = vec![
            program(9, 0, 10, 10, 100, 15, 5),
            program(9, 0, 50, 25, 250, 35, 10),
            program(9, 4, 30, 40, 400, 60, 20),
            program(9, 5, 10, 150, 1500, 200, 100),
        ];
        let ticks = vec![
            tick(9, 0, 5, 100_000, 2_000),
            tick(9, 5, 5, 100_000, 500),
        ];
        let points = aggregate_program_day(day, &rows, &ticks, Period::M5, None, None);
        assert_eq!(points.len(), 2);

        assert_eq!(points[0].t.0, KstTime::from_kst_civil(day, TimeOfDay::hms(9, 0, 0).unwrap()).unix());
        assert!((points[0].net_buy_amount_million_won - 40.0).abs() < 1e-9);
        assert_eq!(points[0].net_buy_qty, 400);
        assert!((points[0].buy_amount_million_won - 60.0).abs() < 1e-9);
        assert!((points[0].sell_amount_million_won - 20.0).abs() < 1e-9);
        assert!((points[0].program_share_pct.unwrap() - 40.0).abs() < 1e-9);

        assert_eq!(points[1].t.0, KstTime::from_kst_civil(day, TimeOfDay::hms(9, 5, 0).unwrap()).unix());
        assert!((points[1].net_buy_amount_million_won - 150.0).abs() < 1e-9);
        assert!((points[1].program_share_pct.unwrap() - 100.0).abs() < 1e-9);
    }

    #[test]
    fn program_share_is_none_without_ticks() {
        let day = date(23);
        let rows = vec![program(9, 0, 10, 10, 100, 15, 5)];
        let points = aggregate_program_day(day, &rows, &[], Period::M1, None, None);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].program_share_pct, None);
    }
}
