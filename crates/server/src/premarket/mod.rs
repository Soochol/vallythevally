use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use domain::{KstDate, KstTime, StockCode, Symbol, TimeOfDay};
use duckdb::params;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api;
use crate::clock::kst;
use crate::collected::Collected;
use crate::collected::kind::{CollectedExpectedTrade, CollectedKind, CollectedTradeTick, ExpectedTrades, FidValues};
use crate::collected_store::{DayIndexState, FileStamp, StampLru, open_connection, path_str, read_path_stamp, read_stamp};
use crate::http::{ApiFailure, AppState};
use crate::shared_data::{CollectorPaths, FlowCursor, SYMBOL_FLOW_FOLDER};
use crate::symbols::Directory;

const PREMARKET_START_SEC: u32 = 8 * 3600 + 30 * 60;
const PREMARKET_END_SEC: u32 = 9 * 3600;
const PEAK_WINDOW_START_SEC: u32 = 8 * 3600 + 50 * 60;
const PEAK_WINDOW_END_SEC: u32 = 8 * 3600 + 58 * 60;
const CRITICAL_WINDOW_START_SEC: u32 = 8 * 3600 + 58 * 60;
const LATE_WINDOW_START_SEC: u32 = 8 * 3600 + 59 * 60 + 30;
const OUTCOME_0900_SEC: u32 = 9 * 3600;
const OUTCOME_0905_SEC: u32 = 9 * 3600 + 5 * 60;
const OUTCOME_0910_SEC: u32 = 9 * 3600 + 10 * 60;
const MAX_COMPARE_DAYS: usize = 4;
const DEFAULT_COMPARE_DAYS: usize = 3;
const COMPARE_CACHE_CAPACITY: usize = 64;
const SNAPSHOT_CACHE_CAPACITY: usize = 16;
const DENSE_THRESHOLD_SECONDS: usize = 480;
const FLOW_SNAPSHOT_TTL_SECS: i64 = 1;
const FLOW_SUFFIX: &str = ".flow";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PreMarketSignal {
    GenuineGap,
    SpoofWarning,
    Flat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreMarketPoint {
    pub sec_of_day: u32,
    #[ts(type = "number")]
    pub expected_price_won: u64,
    pub expected_return_pct: f64,
    #[ts(type = "number")]
    pub expected_qty: u64,
    pub expected_turnover_million_won: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreMarketDaySeries {
    pub date: String,
    pub source: api::BrokerDaySource,
    pub points: Vec<PreMarketPoint>,
    pub late_drop_pct: f64,
    pub classification: PreMarketSignal,
    #[ts(type = "number | null")]
    pub open_price_won: Option<u64>,
    #[serde(rename = "return0900Pct")]
    pub return_0900_pct: Option<f64>,
    #[serde(rename = "return0905Pct")]
    pub return_0905_pct: Option<f64>,
    #[serde(rename = "return0910Pct")]
    pub return_0910_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreMarketCompare {
    pub symbol: api::SymbolCode,
    pub series: Vec<PreMarketDaySeries>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreMarketSnapshotRow {
    pub code: api::SymbolCode,
    pub name: String,
    #[ts(type = "number")]
    pub expected_price_won: u64,
    pub expected_return_pct: f64,
    pub expected_turnover_million_won: f64,
    pub late_drop_pct: f64,
    pub signal: PreMarketSignal,
    pub pre_market_extended: bool,
    #[serde(rename = "actual0900Pct")]
    pub actual_0900_pct: Option<f64>,
    #[serde(rename = "actual0910Pct")]
    pub actual_0910_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreMarketSnapshot {
    pub date: String,
    pub available_dates: Vec<String>,
    pub source: api::BrokerDaySource,
    pub rows: Vec<PreMarketSnapshotRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreMarketDays {
    pub symbol: api::SymbolCode,
    pub days: Vec<String>,
}

#[derive(Clone)]
struct CachedSnapshotRow {
    code: String,
    expected_price_won: u64,
    expected_return_pct: f64,
    expected_turnover_million_won: f64,
    late_drop_pct: f64,
    signal: PreMarketSignal,
    pre_market_extended: bool,
    actual_0900_pct: Option<f64>,
    actual_0910_pct: Option<f64>,
}

struct FlowSnapshotCache {
    date: String,
    at_unix: i64,
    rows: Arc<Vec<CachedSnapshotRow>>,
}

struct DatesCache {
    hoga_dir: Option<PathBuf>,
    store_stamp: Option<FileStamp>,
    shared_dir: Option<PathBuf>,
    today_str: String,
    flow_stamp: Option<FileStamp>,
    dates: Vec<String>,
}

struct SnapshotJsonCache {
    date: String,
    stamp: FileStamp,
    dir_ptr: usize,
    available_dates: Vec<String>,
    body: Bytes,
}

pub struct PreMarketService {
    collected: Arc<Collected>,
    compare_cache: Mutex<StampLru<Arc<PreMarketDaySeries>>>,
    snapshot_cache: Mutex<StampLru<Arc<Vec<CachedSnapshotRow>>>>,
    flow_snapshot_cache: Mutex<Option<FlowSnapshotCache>>,
    dates_cache: Mutex<Option<DatesCache>>,
    snapshot_json_cache: Mutex<Option<SnapshotJsonCache>>,
}

impl PreMarketService {
    pub fn new(collected: Arc<Collected>) -> Arc<Self> {
        Arc::new(Self {
            collected,
            compare_cache: Mutex::new(StampLru::with_capacity(COMPARE_CACHE_CAPACITY)),
            snapshot_cache: Mutex::new(StampLru::with_capacity(SNAPSHOT_CACHE_CAPACITY)),
            flow_snapshot_cache: Mutex::new(None),
            dates_cache: Mutex::new(None),
            snapshot_json_cache: Mutex::new(None),
        })
    }

    pub async fn days(&self, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<PreMarketDays, String> {
        let days = self.collected.expected_days(paths, stock, now).await?;
        Ok(PreMarketDays { symbol: symbol_code(stock), days })
    }

    pub async fn compare(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        requested_days: Option<Vec<(KstDate, String)>>,
        now: KstTime,
    ) -> Result<PreMarketCompare, String> {
        let targets: Vec<(KstDate, String)> = match requested_days {
            Some(list) => list,
            None => {
                let available = self.collected.expected_days(paths.clone(), stock, now).await?;
                let start = available.len().saturating_sub(DEFAULT_COMPARE_DAYS);
                available[start..]
                    .iter()
                    .filter_map(|raw| KstDate::parse_yyyymmdd(raw).map(|date| (date, raw.clone())))
                    .collect()
            }
        };
        let hoga_dir = paths.hoga_dir().map(Path::to_path_buf);
        let mut series = Vec::with_capacity(targets.len());
        for (date, date_str) in targets {
            let day = self.load_day_series(paths.clone(), hoga_dir.as_deref(), stock, date, &date_str, now).await?;
            series.push(day);
        }
        Ok(PreMarketCompare { symbol: symbol_code(stock), series })
    }

    async fn load_day_series(
        self: &Arc<Self>,
        paths: CollectorPaths,
        hoga_dir: Option<&Path>,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        now: KstTime,
    ) -> Result<PreMarketDaySeries, String> {
        let stock_str = stock.as_str().to_owned();
        let cache_key = (stock_str, date_str.to_owned());
        let closed_stamp = match hoga_dir {
            Some(dir) => read_stamp(dir, date_str)?,
            None => None,
        };
        if let Some(stamp) = &closed_stamp
            && let Some(cached) = self.compare_cache.lock().expect("premarket compare cache").get(&cache_key, stamp)
        {
            return Ok((*cached).clone());
        }
        let expected = self.collected.expected_day(paths.clone(), stock, date, date_str, None, now).await?;
        let ticks = if expected.source == api::BrokerDaySource::Store {
            self.collected.ticks_day(paths, stock, date, date_str, None, now).await?.snapshots
        } else {
            Vec::new()
        };
        let day_series = build_day_series(date_str, expected.source, &expected.snapshots, &ticks);
        if let Some(stamp) = closed_stamp
            && expected.source == api::BrokerDaySource::Store
        {
            self.compare_cache
                .lock()
                .expect("premarket compare cache")
                .insert(cache_key, stamp, Arc::new(day_series.clone()));
        }
        Ok(day_series)
    }

    pub async fn snapshot_bytes(
        self: &Arc<Self>,
        paths: CollectorPaths,
        requested_date: Option<(KstDate, String)>,
        directory: Option<Arc<Directory>>,
        now: KstTime,
    ) -> Result<Bytes, String> {
        let available_dates = self.available_snapshot_dates(&paths, now).await?;
        let (date, date_str) = resolve_snapshot_date(requested_date, &available_dates, now);
        let dir_ptr = directory.as_ref().map_or(0, |d| Arc::as_ptr(d) as usize);
        if let Some(hoga_dir) = paths.hoga_dir()
            && let Some(stamp) = read_stamp(hoga_dir, &date_str)?
        {
            if let Some(cached) = self.snapshot_json_cache.lock().expect("premarket snapshot json cache").as_ref()
                && cached.date == date_str
                && cached.stamp == stamp
                && cached.dir_ptr == dir_ptr
                && cached.available_dates == available_dates
            {
                return Ok(cached.body.clone());
            }
            let snapshot = self.load_snapshot_with_dates(paths, date, date_str.clone(), available_dates.clone(), directory, now).await?;
            let encoded = Bytes::from(serde_json::to_vec(&snapshot).map_err(|e| format!("장전 스냅샷 직렬화 실패: {e}"))?);
            if snapshot.source == api::BrokerDaySource::Store {
                *self.snapshot_json_cache.lock().expect("premarket snapshot json cache") = Some(SnapshotJsonCache {
                    date: date_str,
                    stamp,
                    dir_ptr,
                    available_dates,
                    body: encoded.clone(),
                });
            }
            return Ok(encoded);
        }
        let snapshot = self.load_snapshot_with_dates(paths, date, date_str, available_dates, directory, now).await?;
        serde_json::to_vec(&snapshot)
            .map(Bytes::from)
            .map_err(|e| format!("장전 스냅샷 직렬화 실패: {e}"))
    }

    pub async fn snapshot(
        self: &Arc<Self>,
        paths: CollectorPaths,
        requested_date: Option<(KstDate, String)>,
        directory: Option<Arc<Directory>>,
        now: KstTime,
    ) -> Result<PreMarketSnapshot, String> {
        let available_dates = self.available_snapshot_dates(&paths, now).await?;
        let (date, date_str) = resolve_snapshot_date(requested_date, &available_dates, now);
        self.load_snapshot_with_dates(paths, date, date_str, available_dates, directory, now).await
    }

    async fn load_snapshot_with_dates(
        self: &Arc<Self>,
        paths: CollectorPaths,
        date: KstDate,
        date_str: String,
        available_dates: Vec<String>,
        directory: Option<Arc<Directory>>,
        now: KstTime,
    ) -> Result<PreMarketSnapshot, String> {
        if let Some(hoga_dir) = paths.hoga_dir().map(Path::to_path_buf)
            && let Some(stamp) = read_stamp(&hoga_dir, &date_str)?
        {
            let cache_key = ("snapshot".to_owned(), date_str.clone());
            if let Some(cached) = self.snapshot_cache.lock().expect("premarket snapshot cache").get(&cache_key, &stamp) {
                return Ok(PreMarketSnapshot {
                    date: date_str,
                    available_dates,
                    source: api::BrokerDaySource::Store,
                    rows: materialize_rows(&cached, directory.as_deref()),
                });
            }
            let permit = self.collected.store().acquire_permit().await?;
            let service = Arc::clone(self);
            let date_owned = date_str.clone();
            let loaded = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                scan_closed_day_snapshot(service.collected.store(), &hoga_dir, date, &date_owned)
            })
            .await
            .map_err(|e| format!("장전 스냅샷 조회 작업이 멈췄습니다: {e}"))??;
            if let Some(rows) = loaded {
                let rows = Arc::new(rows);
                self.snapshot_cache
                    .lock()
                    .expect("premarket snapshot cache")
                    .insert(cache_key, stamp, Arc::clone(&rows));
                return Ok(PreMarketSnapshot {
                    date: date_str,
                    available_dates,
                    source: api::BrokerDaySource::Store,
                    rows: materialize_rows(&rows, directory.as_deref()),
                });
            }
        }
        if date == now.kst_date()
            && let Some(shared_dir) = paths.shared_dir().map(Path::to_path_buf)
        {
            if let Some(cached) = self.flow_snapshot_cache.lock().expect("premarket flow snapshot cache").as_ref()
                && cached.date == date_str
                && now.unix() - cached.at_unix < FLOW_SNAPSHOT_TTL_SECS
            {
                return Ok(PreMarketSnapshot {
                    date: date_str,
                    available_dates,
                    source: api::BrokerDaySource::Flow,
                    rows: materialize_rows(&cached.rows, directory.as_deref()),
                });
            }
            let date_owned = date_str.clone();
            let scanned = tokio::task::spawn_blocking(move || scan_flow_day_snapshot(&shared_dir, &date_owned))
                .await
                .map_err(|e| format!("장전 실시간 스냅샷 작업이 멈췄습니다: {e}"))??;
            if let Some(rows) = scanned {
                let rows = Arc::new(rows);
                *self.flow_snapshot_cache.lock().expect("premarket flow snapshot cache") = Some(FlowSnapshotCache {
                    date: date_str.clone(),
                    at_unix: now.unix(),
                    rows: Arc::clone(&rows),
                });
                return Ok(PreMarketSnapshot {
                    date: date_str,
                    available_dates,
                    source: api::BrokerDaySource::Flow,
                    rows: materialize_rows(&rows, directory.as_deref()),
                });
            }
        }
        Ok(PreMarketSnapshot {
            date: date_str,
            available_dates,
            source: api::BrokerDaySource::None,
            rows: Vec::new(),
        })
    }

    async fn available_snapshot_dates(&self, paths: &CollectorPaths, now: KstTime) -> Result<Vec<String>, String> {
        let hoga_dir = paths.hoga_dir().map(Path::to_path_buf);
        let shared_dir = paths.shared_dir().map(Path::to_path_buf);
        if hoga_dir.is_none() && shared_dir.is_none() {
            return Ok(Vec::new());
        }
        let today_str = now.kst_date().yyyymmdd();
        let store_stamp = match &hoga_dir {
            Some(dir) => read_path_stamp(&dir.join("store"))?,
            None => None,
        };
        let flow_stamp = match &shared_dir {
            Some(dir) => read_path_stamp(&dir.join(SYMBOL_FLOW_FOLDER).join(&today_str).join(ExpectedTrades::TYPE_CODE))?,
            None => None,
        };
        if let Some(cached) = self.dates_cache.lock().expect("premarket dates cache").as_ref()
            && cached.hoga_dir == hoga_dir
            && cached.store_stamp == store_stamp
            && cached.shared_dir == shared_dir
            && cached.today_str == today_str
            && cached.flow_stamp == flow_stamp
        {
            return Ok(cached.dates.clone());
        }
        let store = Arc::clone(self.collected.store());
        let hoga_clone = hoga_dir.clone();
        let shared_clone = shared_dir.clone();
        let today_clone = today_str.clone();
        let dates = tokio::task::spawn_blocking(move || {
            let mut dates = match &hoga_clone {
                Some(dir) => store.available_dates(dir)?,
                None => Vec::new(),
            };
            if let Some(shared) = &shared_clone
                && !dates.iter().any(|d| d == &today_clone)
                && has_any_flow_stock(shared, &today_clone, ExpectedTrades::TYPE_CODE)?
            {
                dates.push(today_clone);
                dates.sort_unstable();
            }
            Ok::<Vec<String>, String>(dates)
        })
        .await
        .map_err(|e| format!("장전 날짜 목록 작업이 멈췄습니다: {e}"))??;
        *self.dates_cache.lock().expect("premarket dates cache") = Some(DatesCache {
            hoga_dir,
            store_stamp,
            shared_dir,
            today_str,
            flow_stamp,
            dates: dates.clone(),
        });
        Ok(dates)
    }
}

fn resolve_snapshot_date(
    requested_date: Option<(KstDate, String)>,
    available_dates: &[String],
    now: KstTime,
) -> (KstDate, String) {
    match requested_date {
        Some(pair) => pair,
        None => {
            if let Some(latest) = available_dates.last()
                && let Some(parsed) = KstDate::parse_yyyymmdd(latest)
            {
                (parsed, latest.clone())
            } else {
                let today = now.kst_date();
                (today, today.yyyymmdd())
            }
        }
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/symbols/{code}/premarket/days", get(premarket_days))
        .route("/api/symbols/{code}/premarket/compare", get(premarket_compare))
        .route("/api/premarket/snapshot", get(premarket_snapshot))
}

fn parse_stock(code: &str) -> Result<StockCode, ApiFailure> {
    match Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? {
        Symbol::Stock(stock) => Ok(stock),
        Symbol::Index(_) => Err(ApiFailure::bad_request("지수에는 장전 동시호가 자료가 없습니다")),
    }
}

fn symbol_code(stock: StockCode) -> api::SymbolCode {
    api::SymbolCode(Symbol::Stock(stock).as_wire())
}

fn parse_days_query(raw: Option<&str>) -> Result<Option<Vec<(KstDate, String)>>, ApiFailure> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let mut parsed = Vec::new();
    let mut seen = HashSet::new();
    for part in raw.split(',') {
        let token = part.trim();
        if token.is_empty() {
            return Err(ApiFailure::bad_request("days 항목이 비어 있습니다"));
        }
        let date = KstDate::parse_yyyymmdd(token)
            .ok_or_else(|| ApiFailure::bad_request(format!("days는 YYYYMMDD 형식입니다: {token}")))?;
        if seen.insert(token.to_owned()) {
            parsed.push((date, token.to_owned()));
        }
    }
    if parsed.is_empty() || parsed.len() > MAX_COMPARE_DAYS {
        return Err(ApiFailure::bad_request(format!("days는 1~{MAX_COMPARE_DAYS}개여야 합니다")));
    }
    Ok(Some(parsed))
}

async fn premarket_days(State(st): State<Arc<AppState>>, AxumPath(code): AxumPath<String>) -> Result<Json<PreMarketDays>, ApiFailure> {
    let stock = parse_stock(&code)?;
    let days = st
        .premarket
        .days(st.collector_paths.snapshot(), stock, st.clock.now())
        .await
        .map_err(|e| internal_error("장전 날짜 목록을 읽지 못했습니다", e))?;
    Ok(Json(days))
}

async fn premarket_compare(
    State(st): State<Arc<AppState>>,
    AxumPath(code): AxumPath<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<PreMarketCompare>, ApiFailure> {
    let stock = parse_stock(&code)?;
    let requested_days = parse_days_query(q.get("days").map(String::as_str))?;
    let compare = st
        .premarket
        .compare(st.collector_paths.snapshot(), stock, requested_days, st.clock.now())
        .await
        .map_err(|e| internal_error("장전 날짜 비교 자료를 읽지 못했습니다", e))?;
    Ok(Json(compare))
}

async fn premarket_snapshot(
    State(st): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiFailure> {
    let requested_date = match q.get("date").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let date = KstDate::parse_yyyymmdd(raw)
                .ok_or_else(|| ApiFailure::bad_request(format!("date는 YYYYMMDD 형식입니다: {raw}")))?;
            Some((date, raw.to_owned()))
        }
        None => None,
    };
    let directory = st.symbols.updates().borrow().clone();
    let bytes = st
        .premarket
        .snapshot_bytes(st.collector_paths.snapshot(), requested_date, directory, st.clock.now())
        .await
        .map_err(|e| internal_error("장전 전 종목 스냅샷을 읽지 못했습니다", e))?;
    Ok((StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], bytes).into_response())
}

fn internal_error(context: &str, detail: String) -> ApiFailure {
    tracing::error!(reason = %detail, "{context}");
    ApiFailure::new(api::ApiErrorCode::Internal, context)
}

fn round2(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 100.0).round() / 100.0
}

fn prev_close_of(price_won: u64, change_won: i64) -> Option<u64> {
    let prev = i64::try_from(price_won).ok()?.checked_sub(change_won)?;
    u64::try_from(prev).ok().filter(|&v| v > 0)
}

fn expected_return_pct(price_won: u64, change_won: i64, change_pct: Option<f64>) -> f64 {
    if let Some(pct) = change_pct.filter(|v| v.is_finite()) {
        return round2(pct);
    }
    if let Some(base) = prev_close_of(price_won, change_won) {
        return round2((change_won as f64 / base as f64) * 100.0);
    }
    0.0
}

fn turnover_million_won(price_won: u64, qty: u64) -> f64 {
    round2((price_won as f64 * qty as f64) / 1_000_000.0)
}

fn return_vs_base(price_won: u64, base_won: u64) -> f64 {
    round2(((price_won as f64 - base_won as f64) / base_won as f64) * 100.0)
}

fn classify_series(points: &[PreMarketPoint]) -> (f64, PreMarketSignal) {
    if points.is_empty() {
        return (0.0, PreMarketSignal::Flat);
    }
    let peak_return = points
        .iter()
        .filter(|p| p.sec_of_day >= PEAK_WINDOW_START_SEC && p.sec_of_day <= PEAK_WINDOW_END_SEC)
        .map(|p| p.expected_return_pct)
        .fold(f64::NEG_INFINITY, f64::max);
    let peak_return = if peak_return.is_finite() {
        peak_return
    } else {
        points
            .iter()
            .filter(|p| p.sec_of_day < LATE_WINDOW_START_SEC)
            .map(|p| p.expected_return_pct)
            .fold(f64::NEG_INFINITY, f64::max)
    };
    let peak_return = if peak_return.is_finite() {
        peak_return
    } else {
        points.iter().map(|p| p.expected_return_pct).fold(f64::NEG_INFINITY, f64::max)
    };
    let late_return = points
        .iter()
        .rev()
        .find(|p| p.sec_of_day >= LATE_WINDOW_START_SEC && p.sec_of_day <= PREMARKET_END_SEC)
        .or_else(|| points.last())
        .map_or(0.0, |p| p.expected_return_pct);
    let late_drop_pct = round2(late_return - peak_return);
    let signal = if (peak_return >= 2.0 && late_drop_pct <= -1.5) || late_drop_pct <= -2.0 {
        PreMarketSignal::SpoofWarning
    } else if late_return.abs() >= 1.5 {
        PreMarketSignal::GenuineGap
    } else {
        PreMarketSignal::Flat
    };
    (late_drop_pct, signal)
}

fn downsample_points(raw: &[CollectedExpectedTrade]) -> (Vec<PreMarketPoint>, Option<u64>) {
    let mut by_second: BTreeMap<u32, PreMarketPoint> = BTreeMap::new();
    let mut prev_close: Option<u64> = None;
    for row in raw {
        let sec = row.hhmmss.secs();
        if !(PREMARKET_START_SEC..=PREMARKET_END_SEC).contains(&sec) {
            continue;
        }
        if let Some(base) = prev_close_of(row.price_won, row.change_won) {
            prev_close = Some(base);
        }
        let point = PreMarketPoint {
            sec_of_day: sec,
            expected_price_won: row.price_won,
            expected_return_pct: expected_return_pct(row.price_won, row.change_won, row.change_pct),
            expected_qty: row.expected_qty,
            expected_turnover_million_won: turnover_million_won(row.price_won, row.expected_qty),
        };
        by_second.insert(sec, point);
    }
    if by_second.len() <= DENSE_THRESHOLD_SECONDS {
        return (by_second.into_values().collect(), prev_close);
    }
    let mut bucketed: BTreeMap<u32, PreMarketPoint> = BTreeMap::new();
    for (sec, point) in by_second {
        let key = if sec >= CRITICAL_WINDOW_START_SEC { sec } else { (sec / 5) * 5 };
        bucketed.insert(key, point);
    }
    (bucketed.into_values().collect(), prev_close)
}

fn compute_tick_outcomes(ticks: &[CollectedTradeTick], prev_close: Option<u64>) -> (Option<u64>, Option<f64>, Option<f64>, Option<f64>) {
    let mut open_price: Option<u64> = None;
    let mut price_0905: Option<u64> = None;
    let mut price_0910: Option<u64> = None;
    for tick in ticks {
        let sec = tick.hhmmss.secs();
        if !(OUTCOME_0900_SEC..=OUTCOME_0910_SEC).contains(&sec) {
            continue;
        }
        if open_price.is_none() {
            open_price = Some(tick.price_won);
        }
        if sec <= OUTCOME_0905_SEC {
            price_0905 = Some(tick.price_won);
        }
        price_0910 = Some(tick.price_won);
    }
    let Some(base) = prev_close else {
        return (open_price, None, None, None);
    };
    (
        open_price,
        open_price.map(|p| return_vs_base(p, base)),
        price_0905.map(|p| return_vs_base(p, base)),
        price_0910.map(|p| return_vs_base(p, base)),
    )
}

fn build_day_series(
    date_str: &str,
    source: api::BrokerDaySource,
    expected: &[CollectedExpectedTrade],
    ticks: &[CollectedTradeTick],
) -> PreMarketDaySeries {
    let (points, prev_close) = downsample_points(expected);
    let (late_drop_pct, classification) = classify_series(&points);
    let (open_price_won, return_0900_pct, return_0905_pct, return_0910_pct) = if source == api::BrokerDaySource::Store {
        compute_tick_outcomes(ticks, prev_close)
    } else {
        (None, None, None, None)
    };
    PreMarketDaySeries {
        date: date_str.to_owned(),
        source,
        points,
        late_drop_pct,
        classification,
        open_price_won,
        return_0900_pct,
        return_0905_pct,
        return_0910_pct,
    }
}

fn signal_rank(signal: PreMarketSignal) -> u8 {
    match signal {
        PreMarketSignal::SpoofWarning => 0,
        PreMarketSignal::GenuineGap => 1,
        PreMarketSignal::Flat => 2,
    }
}

fn sort_snapshot_rows(rows: &mut [CachedSnapshotRow]) {
    rows.sort_by(|a, b| {
        signal_rank(a.signal)
            .cmp(&signal_rank(b.signal))
            .then_with(|| b.expected_turnover_million_won.total_cmp(&a.expected_turnover_million_won))
            .then_with(|| a.code.cmp(&b.code))
    });
}

fn materialize_rows(rows: &[CachedSnapshotRow], directory: Option<&Directory>) -> Vec<PreMarketSnapshotRow> {
    rows.iter()
        .map(|row| {
            let name = directory
                .and_then(|dir| StockCode::parse(&row.code).ok().and_then(|code| dir.get(Symbol::Stock(code))))
                .map_or_else(|| row.code.clone(), |info| info.name.clone());
            PreMarketSnapshotRow {
                code: api::SymbolCode(row.code.clone()),
                name,
                expected_price_won: row.expected_price_won,
                expected_return_pct: row.expected_return_pct,
                expected_turnover_million_won: row.expected_turnover_million_won,
                late_drop_pct: row.late_drop_pct,
                signal: row.signal,
                pre_market_extended: row.pre_market_extended,
                actual_0900_pct: row.actual_0900_pct,
                actual_0910_pct: row.actual_0910_pct,
            }
        })
        .collect()
}

fn list_parquet_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}를 읽을 수 없습니다: {e}", dir.display())),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("{} 항목을 읽을 수 없습니다: {e}", dir.display()))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("parquet") && entry.file_type().is_ok_and(|ft| ft.is_file()) {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn sql_parquet_list(files: &[PathBuf]) -> Result<String, String> {
    let mut quoted = Vec::with_capacity(files.len());
    for path in files {
        let text = path_str(path)?;
        quoted.push(format!("'{}'", text.replace('\'', "''")));
    }
    Ok(format!("[{}]", quoted.join(", ")))
}

fn parquet_columns(conn: &duckdb::Connection, list_expr: &str) -> Result<HashSet<String>, String> {
    let sql = format!("DESCRIBE SELECT * FROM read_parquet({list_expr}, union_by_name = true)");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Parquet 스키마 조회 준비 실패: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("Parquet 스키마 조회 실행 실패: {e}"))?;
    let mut cols = HashSet::new();
    while let Some(row) = rows.next().map_err(|e| format!("Parquet 스키마 행 읽기 실패: {e}"))? {
        if let Ok(name) = row.get::<_, String>(0) {
            cols.insert(name);
        }
    }
    Ok(cols)
}

fn normalize_stock_code(raw: &str) -> Option<String> {
    let base = raw.trim().split('_').next()?;
    StockCode::parse(base).ok().map(|code| code.as_str().to_owned())
}

fn parse_hhmmss_secs(raw: Option<&str>) -> Option<u32> {
    let text = raw?.trim();
    if text.len() != 6 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let tod = TimeOfDay::hms(text[0..2].parse().ok()?, text[2..4].parse().ok()?, text[4..6].parse().ok()?)?;
    Some(tod.secs())
}

fn parse_magnitude_u64(raw: Option<&str>) -> Option<u64> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    text.strip_prefix(['+', '-']).unwrap_or(text).parse::<u64>().ok()
}

fn parse_signed_i64(raw: Option<&str>) -> Option<i64> {
    let text = raw?.trim();
    if text.is_empty() {
        return Some(0);
    }
    text.parse::<i64>().ok()
}

fn parse_opt_f64(raw: Option<&str>) -> Option<f64> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn is_extended_flag(raw: Option<&str>) -> bool {
    let Some(text) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    !matches!(text, "0" | "N" | "n" | "false" | "FALSE")
}

struct SnapshotSample {
    sec: u32,
    recv_ms: i64,
    price_won: u64,
    change_won: i64,
    change_pct: Option<f64>,
    expected_qty: u64,
}

fn summarize_samples(
    code: String,
    mut samples: Vec<SnapshotSample>,
    extended: bool,
    outcome: Option<(u64, u64)>,
) -> Option<CachedSnapshotRow> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by_key(|s| (s.sec, s.recv_ms));
    let mut by_second: BTreeMap<u32, PreMarketPoint> = BTreeMap::new();
    let mut prev_close: Option<u64> = None;
    for sample in samples {
        if let Some(base) = prev_close_of(sample.price_won, sample.change_won) {
            prev_close = Some(base);
        }
        by_second.insert(
            sample.sec,
            PreMarketPoint {
                sec_of_day: sample.sec,
                expected_price_won: sample.price_won,
                expected_return_pct: expected_return_pct(sample.price_won, sample.change_won, sample.change_pct),
                expected_qty: sample.expected_qty,
                expected_turnover_million_won: turnover_million_won(sample.price_won, sample.expected_qty),
            },
        );
    }
    let points: Vec<PreMarketPoint> = by_second.into_values().collect();
    let last = points.last()?;
    let (late_drop_pct, signal) = classify_series(&points);
    let (actual_0900_pct, actual_0910_pct) = match (outcome, prev_close) {
        (Some((open_won, close_0910_won)), Some(base)) => (
            Some(return_vs_base(open_won, base)),
            Some(return_vs_base(close_0910_won, base)),
        ),
        _ => (None, None),
    };
    Some(CachedSnapshotRow {
        code,
        expected_price_won: last.expected_price_won,
        expected_return_pct: last.expected_return_pct,
        expected_turnover_million_won: last.expected_turnover_million_won,
        late_drop_pct,
        signal,
        pre_market_extended: extended,
        actual_0900_pct,
        actual_0910_pct,
    })
}

fn scan_closed_day_snapshot(
    store: &crate::collected_store::CollectedStore,
    hoga_dir: &Path,
    date: KstDate,
    date_str: &str,
) -> Result<Option<Vec<CachedSnapshotRow>>, String> {
    let (_, state) = store.load_day_index(hoga_dir, date_str)?;
    let DayIndexState::Ready(index) = state else {
        return Ok(None);
    };
    let day_dir = hoga_dir.join("store").join(date_str);
    let expected_files = list_parquet_files(&day_dir.join("0H"))?;
    if expected_files.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let conn = open_connection()?;
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let day_end_ms = day_start_ms + 86_400_000;

    let expected_list = sql_parquet_list(&expected_files)?;
    let expected_cols = parquet_columns(&conn, &expected_list)?;
    if !expected_cols.contains("symbol") || !expected_cols.contains("recv_ms") || !expected_cols.contains("f20") || !expected_cols.contains("f10") {
        return Ok(Some(Vec::new()));
    }
    let col_or_null = |name: &str| {
        if expected_cols.contains(name) {
            format!("CAST({name} AS VARCHAR)")
        } else {
            "NULL::VARCHAR".to_owned()
        }
    };
    let expected_sql = format!(
        "SELECT symbol, recv_ms, CAST(f20 AS VARCHAR), CAST(f10 AS VARCHAR), {}, {}, {} FROM read_parquet({expected_list}, union_by_name = true) WHERE recv_ms >= $1 AND recv_ms < $2 AND TRIM(CAST(f20 AS VARCHAR)) >= '083000' AND TRIM(CAST(f20 AS VARCHAR)) <= '090000'",
        col_or_null("f11"),
        col_or_null("f12"),
        col_or_null("f15"),
    );
    let mut by_stock: HashMap<String, Vec<SnapshotSample>> = HashMap::new();
    {
        let mut stmt = conn.prepare(&expected_sql).map_err(|e| format!("장전 0H 스냅샷 쿼리 준비 실패: {e}"))?;
        let mut rows = stmt.query(params![day_start_ms, day_end_ms]).map_err(|e| format!("장전 0H 스냅샷 쿼리 실행 실패: {e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("장전 0H 스냅샷 행 읽기 실패: {e}"))? {
            let raw_symbol: String = row.get(0).map_err(|e| format!("symbol 읽기 실패: {e}"))?;
            let Some(code) = normalize_stock_code(&raw_symbol) else { continue };
            if !index.stocks.contains_key(&code) {
                continue;
            }
            let recv_ms: i64 = row.get(1).map_err(|e| format!("recv_ms 읽기 실패: {e}"))?;
            let f20: Option<String> = row.get(2).map_err(|e| format!("f20 읽기 실패: {e}"))?;
            let f10: Option<String> = row.get(3).map_err(|e| format!("f10 읽기 실패: {e}"))?;
            let f11: Option<String> = row.get(4).map_err(|e| format!("f11 읽기 실패: {e}"))?;
            let f12: Option<String> = row.get(5).map_err(|e| format!("f12 읽기 실패: {e}"))?;
            let f15: Option<String> = row.get(6).map_err(|e| format!("f15 읽기 실패: {e}"))?;
            let Some(sec) = parse_hhmmss_secs(f20.as_deref()) else { continue };
            if !(PREMARKET_START_SEC..=PREMARKET_END_SEC).contains(&sec) {
                continue;
            }
            let Some(price_won) = parse_magnitude_u64(f10.as_deref()).filter(|&v| v > 0) else { continue };
            let change_won = parse_signed_i64(f11.as_deref()).unwrap_or(0);
            let change_pct = parse_opt_f64(f12.as_deref());
            let expected_qty = parse_magnitude_u64(f15.as_deref()).unwrap_or(0);
            by_stock.entry(code).or_default().push(SnapshotSample {
                sec,
                recv_ms,
                price_won,
                change_won,
                change_pct,
                expected_qty,
            });
        }
    }
    if by_stock.is_empty() {
        return Ok(Some(Vec::new()));
    }

    let mut extended_stocks: HashSet<String> = HashSet::new();
    let ext_files = list_parquet_files(&day_dir.join("0g"))?;
    if !ext_files.is_empty() {
        let ext_list = sql_parquet_list(&ext_files)?;
        let ext_cols = parquet_columns(&conn, &ext_list)?;
        if ext_cols.contains("symbol") && ext_cols.contains("recv_ms") && ext_cols.contains("f592") {
            let ext_sql = format!(
                "SELECT DISTINCT symbol, CAST(f592 AS VARCHAR) FROM read_parquet({ext_list}, union_by_name = true) WHERE recv_ms >= $1 AND recv_ms < $2 AND f592 IS NOT NULL"
            );
            let mut stmt = conn.prepare(&ext_sql).map_err(|e| format!("장전 0g 스냅샷 쿼리 준비 실패: {e}"))?;
            let mut rows = stmt.query(params![day_start_ms, day_end_ms]).map_err(|e| format!("장전 0g 스냅샷 쿼리 실행 실패: {e}"))?;
            while let Some(row) = rows.next().map_err(|e| format!("장전 0g 스냅샷 행 읽기 실패: {e}"))? {
                let raw_symbol: String = row.get(0).map_err(|e| format!("0g symbol 읽기 실패: {e}"))?;
                let f592: Option<String> = row.get(1).map_err(|e| format!("0g f592 읽기 실패: {e}"))?;
                if is_extended_flag(f592.as_deref())
                    && let Some(code) = normalize_stock_code(&raw_symbol)
                {
                    extended_stocks.insert(code);
                }
            }
        }
    }

    let mut outcomes: HashMap<String, (u64, u64)> = HashMap::new();
    let tick_files = list_parquet_files(&day_dir.join("0B"))?;
    if !tick_files.is_empty() {
        let tick_list = sql_parquet_list(&tick_files)?;
        let tick_cols = parquet_columns(&conn, &tick_list)?;
        if tick_cols.contains("symbol") && tick_cols.contains("recv_ms") && tick_cols.contains("f20") && tick_cols.contains("f10") {
            let tick_sql = format!(
                "SELECT symbol, arg_min(CAST(f10 AS VARCHAR), (TRIM(CAST(f20 AS VARCHAR)), recv_ms)), arg_max(CAST(f10 AS VARCHAR), (TRIM(CAST(f20 AS VARCHAR)), recv_ms)) FROM read_parquet({tick_list}, union_by_name = true) WHERE recv_ms >= $1 AND recv_ms < $2 AND TRIM(CAST(f20 AS VARCHAR)) >= '090000' AND TRIM(CAST(f20 AS VARCHAR)) <= '091000' AND TRIM(COALESCE(CAST(f10 AS VARCHAR), '')) <> '' AND TRIM(CAST(f10 AS VARCHAR)) <> '0' GROUP BY symbol"
            );
            let mut stmt = conn.prepare(&tick_sql).map_err(|e| format!("장전 0B 스냅샷 쿼리 준비 실패: {e}"))?;
            let mut rows = stmt.query(params![day_start_ms, day_end_ms]).map_err(|e| format!("장전 0B 스냅샷 쿼리 실행 실패: {e}"))?;
            while let Some(row) = rows.next().map_err(|e| format!("장전 0B 스냅샷 행 읽기 실패: {e}"))? {
                let raw_symbol: String = row.get(0).map_err(|e| format!("0B symbol 읽기 실패: {e}"))?;
                let open_raw: Option<String> = row.get(1).map_err(|e| format!("0B 시가 읽기 실패: {e}"))?;
                let late_raw: Option<String> = row.get(2).map_err(|e| format!("0B 0910가 읽기 실패: {e}"))?;
                let Some(code) = normalize_stock_code(&raw_symbol) else { continue };
                if let (Some(open_won), Some(late_won)) = (
                    parse_magnitude_u64(open_raw.as_deref()).filter(|&v| v > 0),
                    parse_magnitude_u64(late_raw.as_deref()).filter(|&v| v > 0),
                ) {
                    outcomes.insert(code, (open_won, late_won));
                }
            }
        }
    }

    let mut result = Vec::with_capacity(by_stock.len());
    for (code, samples) in by_stock {
        let extended = extended_stocks.contains(&code);
        let outcome = outcomes.get(&code).copied();
        if let Some(row) = summarize_samples(code, samples, extended, outcome) {
            result.push(row);
        }
    }
    sort_snapshot_rows(&mut result);
    Ok(Some(result))
}

fn has_any_flow_stock(shared_dir: &Path, date_str: &str, type_code: &str) -> Result<bool, String> {
    let type_dir = shared_dir.join(SYMBOL_FLOW_FOLDER).join(date_str).join(type_code);
    let entries = match std::fs::read_dir(&type_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("{}를 읽을 수 없습니다: {e}", type_dir.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("{} 항목을 읽을 수 없습니다: {e}", type_dir.display()))?;
        if entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn list_flow_files(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}를 읽을 수 없습니다: {e}", folder.display())),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("{} 항목을 읽을 수 없습니다: {e}", folder.display()))?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        if name.ends_with(FLOW_SUFFIX) && entry.file_type().is_ok_and(|ft| ft.is_file()) {
            files.push(entry.path());
        }
    }
    files.sort();
    Ok(files)
}

fn read_flow_extended_flag(shared_dir: &Path, date_str: &str, code: &str) -> bool {
    let folder = shared_dir.join(SYMBOL_FLOW_FOLDER).join(date_str).join("0g").join(code);
    let Ok(files) = list_flow_files(&folder) else { return false };
    for file in files {
        let mut cursor = FlowCursor::new(file);
        let Ok(blocks) = cursor.read_new() else { continue };
        for block in blocks {
            let Some(pos) = block.description.fids.iter().position(|&fid| fid == 592) else { continue };
            for row in block.rows {
                if is_extended_flag(row.values.get(pos).and_then(|v| v.as_deref())) {
                    return true;
                }
            }
        }
    }
    false
}

fn scan_flow_day_snapshot(shared_dir: &Path, date_str: &str) -> Result<Option<Vec<CachedSnapshotRow>>, String> {
    let type_dir = shared_dir.join(SYMBOL_FLOW_FOLDER).join(date_str).join(ExpectedTrades::TYPE_CODE);
    let entries = match std::fs::read_dir(&type_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}를 읽을 수 없습니다: {e}", type_dir.display())),
    };
    let mut rows = Vec::new();
    let mut found_any = false;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{} 항목을 읽을 수 없습니다: {e}", type_dir.display()))?;
        if !entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Some(code) = normalize_stock_code(&name) else { continue };
        let files = list_flow_files(&entry.path())?;
        if files.is_empty() {
            continue;
        }
        found_any = true;
        let mut samples = Vec::new();
        for file in files {
            let mut cursor = FlowCursor::new(file);
            let Ok(blocks) = cursor.read_new() else { continue };
            for block in blocks {
                for row in block.rows {
                    let values = FidValues::new(&block.description.fids, &row.values);
                    let Some(decoded) = ExpectedTrades::decode(row.recv_ms, &values) else { continue };
                    let sec = decoded.hhmmss.secs();
                    if !(PREMARKET_START_SEC..=PREMARKET_END_SEC).contains(&sec) {
                        continue;
                    }
                    samples.push(SnapshotSample {
                        sec,
                        recv_ms: decoded.recv_ms,
                        price_won: decoded.price_won,
                        change_won: decoded.change_won,
                        change_pct: decoded.change_pct,
                        expected_qty: decoded.expected_qty,
                    });
                }
            }
        }
        let extended = read_flow_extended_flag(shared_dir, date_str, &code);
        if let Some(summary) = summarize_samples(code, samples, extended, None) {
            rows.push(summary);
        }
    }
    if !found_any {
        return Ok(None);
    }
    sort_snapshot_rows(&mut rows);
    Ok(Some(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(sec: u32, price: u64, pct: f64, qty: u64) -> PreMarketPoint {
        PreMarketPoint {
            sec_of_day: sec,
            expected_price_won: price,
            expected_return_pct: pct,
            expected_qty: qty,
            expected_turnover_million_won: turnover_million_won(price, qty),
        }
    }

    #[test]
    fn classifies_spoof_warning_genuine_gap_and_flat() {
        let spoof = vec![
            pt(8 * 3600 + 52 * 60, 74_200, 6.0, 50_000),
            pt(8 * 3600 + 59 * 60 + 40, 71_050, 1.5, 12_000),
        ];
        assert_eq!(classify_series(&spoof), (-4.5, PreMarketSignal::SpoofWarning));

        let genuine = vec![
            pt(8 * 3600 + 52 * 60, 72_100, 3.0, 40_000),
            pt(8 * 3600 + 59 * 60 + 45, 72_450, 3.5, 45_000),
        ];
        assert_eq!(classify_series(&genuine), (0.5, PreMarketSignal::GenuineGap));

        let flat = vec![
            pt(8 * 3600 + 52 * 60, 70_200, 0.29, 10_000),
            pt(8 * 3600 + 59 * 60 + 50, 70_100, 0.14, 10_000),
        ];
        assert_eq!(classify_series(&flat), (-0.15, PreMarketSignal::Flat));
    }

    #[test]
    fn downsamples_dense_early_points_while_preserving_critical_window_seconds() {
        let mut raw = Vec::new();
        for sec in PREMARKET_START_SEC..=PREMARKET_END_SEC {
            let h = sec / 3600;
            let m = (sec % 3600) / 60;
            let s = sec % 60;
            raw.push(CollectedExpectedTrade {
                recv_ms: i64::from(sec) * 1000,
                hhmmss: TimeOfDay::hms(h, m, s).unwrap(),
                price_won: 70_000 + u64::from(sec - PREMARKET_START_SEC),
                change_won: i64::from(sec - PREMARKET_START_SEC),
                change_pct: Some(1.0),
                expected_qty: 100,
                cumulative_qty: 100,
                change_sign: Some(2),
            });
        }
        let (points, prev_close) = downsample_points(&raw);
        assert_eq!(prev_close, Some(70_000));
        let critical: Vec<u32> = points.iter().filter(|p| p.sec_of_day >= CRITICAL_WINDOW_START_SEC).map(|p| p.sec_of_day).collect();
        assert_eq!(critical.len(), (PREMARKET_END_SEC - CRITICAL_WINDOW_START_SEC + 1) as usize);
        assert!(points.len() <= 460);
    }

    #[test]
    fn validates_days_query_bounds_and_format() {
        assert!(parse_days_query(None).unwrap().is_none());
        assert_eq!(parse_days_query(Some("20261120,20261123")).unwrap().unwrap().len(), 2);
        assert!(parse_days_query(Some("20261119,20261120,20261121,20261122,20261123")).is_err());
        assert!(parse_days_query(Some("2026-11-23")).is_err());
    }
}
