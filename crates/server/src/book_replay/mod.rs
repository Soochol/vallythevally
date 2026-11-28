mod live;
mod raw_live;
mod reference;
mod span;
mod store;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use domain::{KstDate, StockCode, Symbol};

use crate::api;
use crate::collected::TradeWindowQuery;
use crate::collected_store::{CollectedStore, DayIndexState, FileStamp, StampLru, open_connection};
use crate::hoga_archive::{ArchiveDayLookup, query as archive_query, read_meta_previous_close};
use crate::http::{ApiFailure, AppState, venue_param};
use crate::quotes::effective_venue;
use crate::shared_data::SharedData;

const SPAN_CACHE_CAPACITY: usize = 64;
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const LIVE_CACHE_CONTROL: &str = "no-store";
const ZSTD_SPAN_LEVEL: i32 = 3;
const MAX_SECOND_OF_DAY: u32 = 86_399;
const DEFAULT_TRADE_LIMIT: usize = 200;
const MAX_TRADE_LIMIT: usize = 500;

#[derive(Clone)]
struct EncodedSpan {
    raw: Arc<Vec<u8>>,
    zstd: Arc<Vec<u8>>,
}

pub struct BookReplay {
    store: Arc<CollectedStore>,
    responses: Mutex<StampLru<Arc<api::BookReplayDay>>>,
    metas: Mutex<StampLru<Arc<api::BookReplayMeta>>>,
    spans: Mutex<StampLru<EncodedSpan>>,
    previous_closes: Mutex<StampLru<Option<u64>>>,
    snapshot_bases: reference::SnapshotBaseCache,
}

impl BookReplay {
    pub fn new(store: Arc<CollectedStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            responses: Mutex::new(StampLru::new()),
            metas: Mutex::new(StampLru::new()),
            spans: Mutex::new(StampLru::with_capacity(SPAN_CACHE_CAPACITY)),
            previous_closes: Mutex::new(StampLru::new()),
            snapshot_bases: reference::SnapshotBaseCache::default(),
        })
    }
}

#[derive(Clone)]
struct ReplayDirs {
    hoga: Option<PathBuf>,
    shared: Option<PathBuf>,
    archive: Option<PathBuf>,
}

fn replay_dirs(st: &AppState) -> Result<ReplayDirs, ApiFailure> {
    let hoga = st.collector_paths.hoga_dir().map(FsPath::to_path_buf);
    let shared = st.collector_paths.shared_dir().map(FsPath::to_path_buf);
    let archive = st.collector_paths.archive_dir().map(FsPath::to_path_buf);
    if hoga.is_none() && archive.is_none() {
        return Err(ApiFailure::new(api::ApiErrorCode::NotFound, "호가 복기 기능이 켜져 있지 않습니다"));
    }
    Ok(ReplayDirs { hoga, shared, archive })
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/book-replay/access", get(access))
        .route("/api/book-replay/catalog", get(catalog))
        .route("/api/symbols/{code}/book-replay/days", get(days))
        .route("/api/symbols/{code}/book-replay/meta", get(day_meta))
        .route("/api/symbols/{code}/book-replay/span", get(day_span))
        .route("/api/symbols/{code}/book-replay/trades", get(day_trades))
        .route("/api/symbols/{code}/book-replay/program", get(day_program))
        .route("/api/symbols/{code}/book-replay", get(day_replay))
}

fn parse_stock(code: &str) -> Result<StockCode, ApiFailure> {
    match Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? {
        Symbol::Stock(stock) => Ok(stock),
        Symbol::Index(_) => Err(ApiFailure::bad_request("지수에는 호가 복기 자료가 없습니다")),
    }
}

fn symbol_code(stock: StockCode) -> api::SymbolCode {
    api::SymbolCode(Symbol::Stock(stock).as_wire())
}

fn empty_day(stock: StockCode, date: String, coverage: api::BookReplayCoverage) -> api::BookReplayDay {
    api::BookReplayDay { symbol: symbol_code(stock), date, coverage, previous_close: None, venue_scope: None, covered: Vec::new(), books: Vec::new(), trades: Vec::new() }
}

fn empty_meta(stock: StockCode, date: String, coverage: api::BookReplayCoverage) -> api::BookReplayMeta {
    api::BookReplayMeta {
        symbol: symbol_code(stock),
        date,
        coverage,
        resolution: api::BookReplayResolution::MinuteOnly,
        span_minutes: u32::from(span::SPAN_MINUTES),
        previous_close: None,
        venue_scope: None,
        covered: Vec::new(),
        gaps_ms: Vec::new(),
        spans: Vec::new(),
        minutes: Vec::new(),
    }
}

fn parse_date_query(q: &HashMap<String, String>) -> Result<(String, KstDate, u32), ApiFailure> {
    let date_str = q
        .get("date")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiFailure::bad_request("date 쿼리(YYYYMMDD)가 필요합니다"))?;
    let date = KstDate::parse_yyyymmdd(date_str)
        .ok_or_else(|| ApiFailure::bad_request(format!("date는 YYYYMMDD 형식입니다: {date_str}")))?;
    let date_u32: u32 = date_str
        .parse()
        .map_err(|_| ApiFailure::bad_request(format!("date는 YYYYMMDD 형식입니다: {date_str}")))?;
    Ok((date_str.to_owned(), date, date_u32))
}

fn parse_start_minute(q: &HashMap<String, String>) -> Result<u16, ApiFailure> {
    let raw = q
        .get("startMinute")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiFailure::bad_request("startMinute 쿼리가 필요합니다"))?;
    let minute: u16 = raw
        .parse()
        .map_err(|_| ApiFailure::bad_request(format!("startMinute가 올바르지 않습니다: {raw}")))?;
    if minute >= 1440 || !minute.is_multiple_of(span::SPAN_MINUTES) {
        return Err(ApiFailure::bad_request(format!(
            "startMinute는 0~1435 사이의 {}분 배수여야 합니다: {minute}",
            span::SPAN_MINUTES
        )));
    }
    Ok(minute)
}

fn parse_until_sec(q: &HashMap<String, String>) -> Result<u32, ApiFailure> {
    let raw = q
        .get("untilSec")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiFailure::bad_request("untilSec 쿼리가 필요합니다"))?;
    let sec: u32 = raw
        .parse()
        .map_err(|_| ApiFailure::bad_request(format!("untilSec는 0~{MAX_SECOND_OF_DAY} 정수여야 합니다: {raw}")))?;
    if sec > MAX_SECOND_OF_DAY {
        return Err(ApiFailure::bad_request(format!("untilSec는 0~{MAX_SECOND_OF_DAY} 범위여야 합니다: {sec}")));
    }
    Ok(sec)
}

fn parse_min_won(q: &HashMap<String, String>) -> Result<u64, ApiFailure> {
    match q.get("minWon") {
        None => Ok(0),
        Some(raw) => raw
            .parse::<u64>()
            .map_err(|_| ApiFailure::bad_request(format!("minWon은 0 이상의 정수여야 합니다: {raw}"))),
    }
}

fn parse_trade_limit(q: &HashMap<String, String>) -> Result<usize, ApiFailure> {
    match q.get("limit") {
        None => Ok(DEFAULT_TRADE_LIMIT),
        Some(raw) => raw
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=MAX_TRADE_LIMIT).contains(n))
            .ok_or_else(|| ApiFailure::bad_request(format!("limit은 1~{MAX_TRADE_LIMIT}입니다: {raw}"))),
    }
}

fn resolve_venue(st: &AppState, code: StockCode, requested: domain::Venue) -> domain::Venue {
    if requested != domain::Venue::Nxt {
        return requested;
    }
    let Some(directory) = st.symbols.updates().borrow().clone() else {
        return requested;
    };
    let nxt_enabled = directory.get(Symbol::Stock(code)).is_some_and(|info| info.nxt_enabled);
    effective_venue(requested, nxt_enabled)
}

async fn day_trades(
    State(st): State<Arc<AppState>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<api::BookReplayTrades>, ApiFailure> {
    let dirs = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, _) = parse_date_query(&q)?;
    let until_sec = parse_until_sec(&q)?;
    let requested_venue = venue_param(&q)?.unwrap_or(domain::Venue::Combined);
    let venue = resolve_venue(&st, stock, requested_venue);
    let min_won = parse_min_won(&q)?;
    let limit = parse_trade_limit(&q)?;
    let slice = st
        .collected
        .ticks_window_at(
            st.collector_paths.snapshot(),
            TradeWindowQuery {
                stock,
                date,
                date_str: date_str.clone(),
                until_sec,
                venue,
                min_won,
                limit,
                now: st.clock.now(),
            },
        )
        .await
        .map_err(|e| internal_error("호가 복기 체결 자료를 읽지 못했습니다", e))?;
    let previous_close = if slice.coverage == api::BookReplayCoverage::Collected {
        resolve_previous_close(&st, dirs, stock, date, &date_str).await?
    } else {
        None
    };
    Ok(Json(api::BookReplayTrades {
        symbol: symbol_code(stock),
        date: date_str,
        coverage: slice.coverage,
        previous_close,
        venue: slice.venue_override.unwrap_or_else(|| venue.into()),
        venue_scope: slice.venue_scope,
        gaps: slice.gaps,
        cum_volume: slice.cum_volume,
        cum_buy_qty: slice.cum_buy_qty,
        cum_sell_qty: slice.cum_sell_qty,
        strength: slice.strength,
        trades: slice.trades,
    }))
}

async fn day_program(
    State(st): State<Arc<AppState>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<api::BookReplayProgramDay>, ApiFailure> {
    let dirs = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, _) = parse_date_query(&q)?;
    let slice = st
        .collected
        .program_replay_day(st.collector_paths.snapshot(), stock, date, &date_str, st.clock.now())
        .await
        .map_err(|e| internal_error("호가 복기 프로그램 자료를 읽지 못했습니다", e))?;
    let previous_close = if slice.coverage == api::BookReplayCoverage::Collected {
        resolve_previous_close(&st, dirs, stock, date, &date_str).await?
    } else {
        None
    };
    Ok(Json(api::BookReplayProgramDay {
        symbol: symbol_code(stock),
        date: date_str,
        coverage: slice.coverage,
        previous_close,
        venue_scope: slice.venue_scope,
        gaps: slice.gaps,
        rows: slice.rows,
    }))
}

async fn access(State(st): State<Arc<AppState>>) -> Json<api::BookReplayAccess> {
    let available = st.collector_paths.hoga_dir().is_some() || st.collector_paths.archive_dir().is_some();
    Json(api::BookReplayAccess { available })
}

async fn catalog(State(st): State<Arc<AppState>>) -> Result<Json<api::BookReplayCatalog>, ApiFailure> {
    let dirs = replay_dirs(&st)?;
    let replay = st.book_replay.clone();
    let directory = st.symbols.updates().borrow().clone();
    let items = tokio::task::spawn_blocking(move || build_catalog(&replay, &dirs, directory.as_deref()))
        .await
        .map_err(|e| internal_error("호가 복기 카탈로그 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 카탈로그를 읽지 못했습니다", e))?;
    Ok(Json(api::BookReplayCatalog { items }))
}

fn build_catalog(replay: &BookReplay, dirs: &ReplayDirs, directory: Option<&crate::symbols::Directory>) -> Result<Vec<api::BookReplayCatalogItem>, String> {
    let mut native_by_stock: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    if let Some(hoga_dir) = &dirs.hoga {
        let dates = replay.store.available_dates(hoga_dir)?;
        for date in dates {
            if let Ok((_, DayIndexState::Ready(index))) = replay.store.load_day_index(hoga_dir, &date) {
                for code in index.stocks.keys() {
                    native_by_stock.entry(code.clone()).or_default().insert(date.clone());
                }
            }
        }
    }
    let archive_map = match &dirs.archive {
        Some(archive_dir) => replay.store.archive().catalog(archive_dir)?,
        None => BTreeMap::new(),
    };
    let mut all_codes: BTreeSet<String> = native_by_stock.keys().cloned().collect();
    all_codes.extend(archive_map.keys().cloned());

    let mut items = Vec::with_capacity(all_codes.len());
    for code in all_codes {
        let Ok(stock) = StockCode::parse(&code) else { continue };
        let native_set = native_by_stock.get(&code);
        let native_days = native_set.map_or(0, BTreeSet::len).min(u32::MAX as usize) as u32;
        let (archive_days, archive_latest) = match (&dirs.archive, archive_map.get(&code)) {
            (Some(archive_dir), Some(summary)) => {
                if let Some(native_dates) = native_set {
                    let raw_days = replay.store.archive().days_for_stock(archive_dir, &code)?;
                    let extra = raw_days.iter().filter(|d| !native_dates.contains(*d)).count().min(u32::MAX as usize) as u32;
                    (extra, Some(summary.latest_date.clone()))
                } else {
                    (summary.days, Some(summary.latest_date.clone()))
                }
            }
            _ => (0, None),
        };
        let total_days = native_days.saturating_add(archive_days);
        if total_days == 0 {
            continue;
        }
        let native_latest = native_set.and_then(|s| s.iter().next_back()).cloned();
        let latest_date = match (native_latest, archive_latest) {
            (Some(a), Some(b)) => a.max(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => continue,
        };
        let info = directory.and_then(|dir| dir.get(Symbol::Stock(stock)));
        items.push(api::BookReplayCatalogItem {
            symbol: symbol_code(stock),
            name: info.map(|s| s.name.clone()),
            market: info.map(|s| s.market.into()),
            kind: info.map(|s| s.kind.into()),
            native_days,
            archive_days,
            total_days,
            latest_date,
        });
    }
    items.sort_by(|a, b| b.total_days.cmp(&a.total_days).then_with(|| a.symbol.0.cmp(&b.symbol.0)));
    Ok(items)
}

async fn days(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::BookReplayDays>, ApiFailure> {
    let dirs = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let replay = st.book_replay.clone();
    let stock_str = stock.as_str().to_owned();
    let (merged, archive_days) = tokio::task::spawn_blocking(move || {
        let mut native: BTreeSet<String> = BTreeSet::new();
        if let Some(hoga) = &dirs.hoga {
            native.extend(replay.store.collected_days(hoga, &stock_str)?);
            if let Some(shared) = &dirs.shared {
                native.extend(live::live_days(hoga, shared, &stock_str)?);
            }
        }
        let archive_days: Vec<String> = match &dirs.archive {
            Some(archive) => replay
                .store
                .archive()
                .days_for_stock(archive, &stock_str)?
                .into_iter()
                .filter(|d| !native.contains(d))
                .collect(),
            None => Vec::new(),
        };
        let mut all = native;
        all.extend(archive_days.iter().cloned());
        Ok::<(Vec<String>, Vec<String>), String>((all.into_iter().collect(), archive_days))
    })
    .await
    .map_err(|e| internal_error("호가 복기 날짜 목록 작업이 멈췄습니다", e.to_string()))?
    .map_err(|e| internal_error("호가 복기 날짜 목록을 읽지 못했습니다", e))?;
    Ok(Json(api::BookReplayDays {
        symbol: symbol_code(stock),
        days: merged,
        archive_days: (!archive_days.is_empty()).then_some(archive_days),
    }))
}

async fn day_replay(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<Arc<api::BookReplayDay>>, ApiFailure> {
    let dirs = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, _) = parse_date_query(&q)?;
    let cache_key = (stock.as_str().to_owned(), date_str.clone());
    let replay_check = st.book_replay.clone();
    let dirs_check = dirs.clone();
    let date_check = date_str.clone();
    let key_check = cache_key.clone();
    let stock_check = stock.as_str().to_owned();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_response(&replay_check, &dirs_check, &date_check, &stock_check, &key_check))
        .await
        .map_err(|e| internal_error("호가 복기 캐시 확인 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 자료를 확인하지 못했습니다", e))?
    {
        return Ok(Json(cached));
    }
    let permit = st.book_replay.store.acquire_permit().await.map_err(|e| internal_error("호가 복기 조회 허가를 얻지 못했습니다", e))?;
    let replay = st.book_replay.clone();
    let shared_data = st.shared_data.clone();
    let shared = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let lookup = DayLookup {
            dirs: &dirs,
            shared_data: &shared_data,
            stock,
            date,
            date_str: &date_str,
            cache_key: &cache_key,
        };
        load_or_cached_day(&replay, &lookup)
    })
    .await
    .map_err(|e| internal_error("호가 복기 조회 작업이 멈췄습니다", e.to_string()))?
    .map_err(|e| internal_error("호가 복기 자료를 읽지 못했습니다", e))?;
    Ok(Json(shared))
}

async fn day_meta(
    State(st): State<Arc<AppState>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Arc<api::BookReplayMeta>>, ApiFailure> {
    let dirs = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, _) = parse_date_query(&q)?;
    let cache_key = (stock.as_str().to_owned(), date_str.clone());
    let replay_check = st.book_replay.clone();
    let dirs_check = dirs.clone();
    let date_check = date_str.clone();
    let key_check = cache_key.clone();
    let stock_check = stock.as_str().to_owned();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_meta(&replay_check, &dirs_check, &date_check, &stock_check, &key_check))
        .await
        .map_err(|e| internal_error("호가 복기 메타 캐시 확인 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 메타를 확인하지 못했습니다", e))?
    {
        return Ok(Json(cached));
    }
    let permit = st.book_replay.store.acquire_permit().await.map_err(|e| internal_error("호가 복기 메타 조회 허가를 얻지 못했습니다", e))?;
    let replay = st.book_replay.clone();
    let meta = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        load_or_cached_meta(&replay, &dirs, stock, date, &date_str, &cache_key)
    })
    .await
    .map_err(|e| internal_error("호가 복기 메타 조회 작업이 멈췄습니다", e.to_string()))?
    .map_err(|e| internal_error("호가 복기 메타를 읽지 못했습니다", e))?;
    Ok(Json(meta))
}

async fn day_span(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiFailure> {
    let dirs = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, date_u32) = parse_date_query(&q)?;
    let start_minute = parse_start_minute(&q)?;
    let cache_key = (format!("{}:{start_minute}", stock.as_str()), date_str.clone());
    let replay_check = st.book_replay.clone();
    let dirs_check = dirs.clone();
    let date_check = date_str.clone();
    let key_check = cache_key.clone();
    let stock_check = stock.as_str().to_owned();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_span(&replay_check, &dirs_check, &date_check, &stock_check, &key_check))
        .await
        .map_err(|e| internal_error("호가 복기 구간 캐시 확인 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 구간을 확인하지 못했습니다", e))?
    {
        return Ok(span_http_response(&headers, &cached, true));
    }
    let permit = st.book_replay.store.acquire_permit().await.map_err(|e| internal_error("호가 복기 구간 조회 허가를 얻지 못했습니다", e))?;
    let replay = st.book_replay.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        load_or_cached_span(
            &replay,
            SpanLookup {
                dirs: &dirs,
                stock,
                date,
                date_u32,
                date_str: &date_str,
                start_minute,
                cache_key: &cache_key,
            },
        )
    })
    .await
    .map_err(|e| internal_error("호가 복기 구간 조회 작업이 멈췄습니다", e.to_string()))?
    .map_err(|e| internal_error("호가 복기 구간을 읽지 못했습니다", e))?;

    let Some((encoded, immutable)) = result else {
        return Err(ApiFailure::new(api::ApiErrorCode::NotFound, "요청한 구간의 호가 복기 자료가 없습니다"));
    };
    Ok(span_http_response(&headers, &encoded, immutable))
}

fn span_http_response(headers: &HeaderMap, encoded: &EncodedSpan, immutable: bool) -> Response {
    let cache_control = if immutable { IMMUTABLE_CACHE_CONTROL } else { LIVE_CACHE_CONTROL };
    let common = [
        (header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream")),
        (header::VARY, HeaderValue::from_static("Accept-Encoding")),
        (header::CACHE_CONTROL, HeaderValue::from_static(cache_control)),
    ];
    if accepts_encoding(headers, "zstd") {
        return (common, [(header::CONTENT_ENCODING, HeaderValue::from_static("zstd"))], (*encoded.zstd).clone()).into_response();
    }
    if accepts_encoding(headers, "gzip")
        && let Ok(gz) = gzip_compress(&encoded.raw)
    {
        return (common, [(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"))], gz).into_response();
    }
    (common, (*encoded.raw).clone()).into_response()
}

fn accepts_encoding(headers: &HeaderMap, encoding: &str) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|part| {
            let mut segments = part.split(';');
            let name = segments.next().unwrap_or("").trim();
            let refused = segments.any(|param| {
                let param = param.trim();
                param.len() > 2
                    && param[..2].eq_ignore_ascii_case("q=")
                    && param[2..].trim().parse::<f32>() == Ok(0.0)
            });
            name.eq_ignore_ascii_case(encoding) && !refused
        })
}

fn gzip_compress(raw: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(raw)?;
    encoder.finish()
}

fn encode_span_payload(span_data: &hoga_format::Span) -> Result<EncodedSpan, String> {
    let raw = hoga_format::encode(span_data).map_err(|e| format!("호가 구간 부호화 실패: {e}"))?;
    let zstd = zstd::bulk::compress(&raw, ZSTD_SPAN_LEVEL).map_err(|e| format!("호가 구간 zstd 압축 실패: {e}"))?;
    Ok(EncodedSpan { raw: Arc::new(raw), zstd: Arc::new(zstd) })
}

fn resolve_cache_stamp(replay: &BookReplay, dirs: &ReplayDirs, date_str: &str, stock_code: &str) -> Result<Option<FileStamp>, String> {
    if let Some(hoga_dir) = &dirs.hoga {
        let (stamp, state) = replay.store.load_day_index(hoga_dir, date_str)?;
        if let DayIndexState::Ready(index) = state
            && index.stocks.contains_key(stock_code)
        {
            return Ok(stamp);
        }
    }
    if let Some(archive_dir) = &dirs.archive {
        return replay.store.archive().stamp_for(archive_dir, date_str, stock_code);
    }
    Ok(None)
}

fn cached_response(replay: &BookReplay, dirs: &ReplayDirs, date_str: &str, stock_code: &str, cache_key: &(String, String)) -> Result<Option<Arc<api::BookReplayDay>>, String> {
    let Some(stamp) = resolve_cache_stamp(replay, dirs, date_str, stock_code)? else { return Ok(None) };
    Ok(replay.responses.lock().expect("book replay cache").get(cache_key, &stamp))
}

fn cached_meta(replay: &BookReplay, dirs: &ReplayDirs, date_str: &str, stock_code: &str, cache_key: &(String, String)) -> Result<Option<Arc<api::BookReplayMeta>>, String> {
    let Some(stamp) = resolve_cache_stamp(replay, dirs, date_str, stock_code)? else { return Ok(None) };
    Ok(replay.metas.lock().expect("book replay meta cache").get(cache_key, &stamp))
}

fn cached_span(replay: &BookReplay, dirs: &ReplayDirs, date_str: &str, stock_code: &str, cache_key: &(String, String)) -> Result<Option<EncodedSpan>, String> {
    let Some(stamp) = resolve_cache_stamp(replay, dirs, date_str, stock_code)? else { return Ok(None) };
    Ok(replay.spans.lock().expect("book replay span cache").get(cache_key, &stamp))
}

fn cached_previous_close(replay: &BookReplay, dirs: &ReplayDirs, date_str: &str, stock_code: &str, cache_key: &(String, String)) -> Result<Option<Option<u64>>, String> {
    let Some(stamp) = resolve_cache_stamp(replay, dirs, date_str, stock_code)? else { return Ok(None) };
    Ok(replay.previous_closes.lock().expect("book replay previous close cache").get(cache_key, &stamp))
}

async fn resolve_previous_close(
    st: &AppState,
    dirs: ReplayDirs,
    stock: StockCode,
    date: KstDate,
    date_str: &str,
) -> Result<Option<u64>, ApiFailure> {
    let cache_key = (stock.as_str().to_owned(), date_str.to_owned());
    let replay_check = st.book_replay.clone();
    let dirs_check = dirs.clone();
    let date_check = date_str.to_owned();
    let key_check = cache_key.clone();
    let stock_check = stock.as_str().to_owned();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_previous_close(&replay_check, &dirs_check, &date_check, &stock_check, &key_check))
        .await
        .map_err(|e| internal_error("호가 복기 기준가 캐시 확인 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 기준가를 확인하지 못했습니다", e))?
    {
        return Ok(cached);
    }
    let permit = st.book_replay.store.acquire_permit().await.map_err(|e| internal_error("호가 복기 기준가 조회 허가를 얻지 못했습니다", e))?;
    let replay = st.book_replay.clone();
    let shared_data = st.shared_data.clone();
    let date_owned = date_str.to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let lookup = DayLookup {
            dirs: &dirs,
            shared_data: &shared_data,
            stock,
            date,
            date_str: &date_owned,
            cache_key: &cache_key,
        };
        load_or_cached_previous_close(&replay, &lookup)
    })
    .await
    .map_err(|e| internal_error("호가 복기 기준가 조회 작업이 멈췄습니다", e.to_string()))?
    .map_err(|e| internal_error("호가 복기 기준가를 읽지 못했습니다", e))
}

struct DayLookup<'a> {
    dirs: &'a ReplayDirs,
    shared_data: &'a SharedData,
    stock: StockCode,
    date: KstDate,
    date_str: &'a str,
    cache_key: &'a (String, String),
}

fn load_or_cached_previous_close(replay: &BookReplay, lookup: &DayLookup<'_>) -> Result<Option<u64>, String> {
    if let Some(cached) = cached_previous_close(replay, lookup.dirs, lookup.date_str, lookup.stock.as_str(), lookup.cache_key)? {
        return Ok(cached);
    }
    if let Some(hoga_dir) = &lookup.dirs.hoga {
        let (stamp, state) = replay.store.load_day_index(hoga_dir, lookup.date_str)?;
        match state {
            DayIndexState::Ready(index) if index.stocks.contains_key(lookup.stock.as_str()) => {
                let day_dir = hoga_dir.join("store").join(lookup.date_str);
                let conn = open_connection()?;
                let previous_close = reference::read_store_previous_close(&conn, &day_dir, lookup.date, lookup.stock.as_str(), index.buckets)?;
                if let Some(stamp) = stamp {
                    replay
                        .previous_closes
                        .lock()
                        .expect("book replay previous close cache")
                        .insert(lookup.cache_key.clone(), stamp, previous_close);
                }
                return Ok(previous_close);
            }
            DayIndexState::Missing => {
                if let Some(shared_dir) = &lookup.dirs.shared
                    && let Some(base) = reference::read_live_previous_close(
                        shared_dir,
                        lookup.shared_data,
                        &replay.snapshot_bases,
                        lookup.stock,
                        lookup.date_str,
                    )
                {
                    return Ok(Some(base));
                }
            }
            DayIndexState::UnsupportedVersion | DayIndexState::Ready(_) => {}
        }
    }
    if let Some(archive_dir) = &lookup.dirs.archive
        && let ArchiveDayLookup::Found { hogaplay_dir, stamp } =
            replay.store.archive().lookup_day(archive_dir, lookup.date_str, lookup.stock.as_str())?
    {
        let previous_close = read_meta_previous_close(&hogaplay_dir);
        replay
            .previous_closes
            .lock()
            .expect("book replay previous close cache")
            .insert(lookup.cache_key.clone(), stamp, previous_close);
        return Ok(previous_close);
    }
    Ok(None)
}

fn load_or_cached_day(replay: &BookReplay, lookup: &DayLookup<'_>) -> Result<Arc<api::BookReplayDay>, String> {
    if let Some(cached) = cached_response(replay, lookup.dirs, lookup.date_str, lookup.stock.as_str(), lookup.cache_key)? {
        return Ok(cached);
    }
    let (stamp, response) = load_day(replay, lookup)?;
    let shared = Arc::new(response);
    if shared.coverage == api::BookReplayCoverage::Collected
        && let Some(stamp) = stamp
    {
        replay.responses.lock().expect("book replay cache").insert(lookup.cache_key.clone(), stamp.clone(), shared.clone());
        replay
            .previous_closes
            .lock()
            .expect("book replay previous close cache")
            .insert(lookup.cache_key.clone(), stamp, shared.previous_close);
    }
    Ok(shared)
}

fn load_or_cached_meta(
    replay: &BookReplay,
    dirs: &ReplayDirs,
    stock: StockCode,
    date: KstDate,
    date_str: &str,
    cache_key: &(String, String),
) -> Result<Arc<api::BookReplayMeta>, String> {
    if let Some(cached) = cached_meta(replay, dirs, date_str, stock.as_str(), cache_key)? {
        return Ok(cached);
    }
    let mut fallback_coverage = api::BookReplayCoverage::DayNotCollected;
    if let Some(hoga_dir) = &dirs.hoga {
        let (stamp, state) = replay.store.load_day_index(hoga_dir, date_str)?;
        match state {
            DayIndexState::Missing => {
                if let Some(shared_dir) = &dirs.shared {
                    let live = raw_live::read_live_meta(hoga_dir, shared_dir, stock, date, date_str)?;
                    if live.coverage == api::BookReplayCoverage::Collected {
                        return Ok(Arc::new(live));
                    }
                    fallback_coverage = live.coverage;
                }
            }
            DayIndexState::UnsupportedVersion => {}
            DayIndexState::Ready(index) => match index.stocks.get(stock.as_str()) {
                Some(coverage) => {
                    let day_dir = hoga_dir.join("store").join(date_str);
                    let response = span::read_day_meta(&day_dir, date, date_str, stock, index.buckets, coverage)?;
                    let shared = Arc::new(response);
                    if let Some(stamp) = stamp {
                        replay.metas.lock().expect("book replay meta cache").insert(cache_key.clone(), stamp, shared.clone());
                    }
                    return Ok(shared);
                }
                None => fallback_coverage = api::BookReplayCoverage::SymbolNotCollected,
            },
        }
    }
    if let Some(archive_dir) = &dirs.archive {
        match replay.store.archive().lookup_day(archive_dir, date_str, stock.as_str())? {
            ArchiveDayLookup::Found { hogaplay_dir, stamp } => {
                let response = archive_query::read_day_meta(&hogaplay_dir, date_str, stock)?;
                let shared = Arc::new(response);
                replay.metas.lock().expect("book replay meta cache").insert(cache_key.clone(), stamp, shared.clone());
                return Ok(shared);
            }
            ArchiveDayLookup::MissingStock => {
                fallback_coverage = api::BookReplayCoverage::SymbolNotCollected;
            }
            ArchiveDayLookup::MissingDay => {}
        }
    }
    Ok(Arc::new(empty_meta(stock, date_str.to_owned(), fallback_coverage)))
}

struct SpanLookup<'a> {
    dirs: &'a ReplayDirs,
    stock: StockCode,
    date: KstDate,
    date_u32: u32,
    date_str: &'a str,
    start_minute: u16,
    cache_key: &'a (String, String),
}

fn load_or_cached_span(replay: &BookReplay, lookup: SpanLookup<'_>) -> Result<Option<(EncodedSpan, bool)>, String> {
    if let Some(cached) = cached_span(replay, lookup.dirs, lookup.date_str, lookup.stock.as_str(), lookup.cache_key)? {
        return Ok(Some((cached, true)));
    }
    if let Some(hoga_dir) = &lookup.dirs.hoga {
        let (stamp, state) = replay.store.load_day_index(hoga_dir, lookup.date_str)?;
        match state {
            DayIndexState::Missing => {
                if let Some(shared_dir) = &lookup.dirs.shared
                    && let Some(live_span) = raw_live::read_live_span(
                        hoga_dir,
                        shared_dir,
                        lookup.date,
                        lookup.date_u32,
                        lookup.date_str,
                        lookup.stock.as_str(),
                        lookup.start_minute,
                    )?
                {
                    let encoded = encode_span_payload(&live_span)?;
                    return Ok(Some((encoded, false)));
                }
            }
            DayIndexState::UnsupportedVersion => {}
            DayIndexState::Ready(index) => {
                if let Some(coverage) = index.stocks.get(lookup.stock.as_str()) {
                    let day_dir = hoga_dir.join("store").join(lookup.date_str);
                    let span_data = span::read_span(
                        &day_dir,
                        lookup.date,
                        lookup.date_u32,
                        lookup.stock.as_str(),
                        index.buckets,
                        coverage,
                        lookup.start_minute,
                    )?;
                    let encoded = encode_span_payload(&span_data)?;
                    if let Some(stamp) = stamp {
                        replay.spans.lock().expect("book replay span cache").insert(lookup.cache_key.clone(), stamp, encoded.clone());
                    }
                    return Ok(Some((encoded, true)));
                }
            }
        }
    }
    if let Some(archive_dir) = &lookup.dirs.archive
        && let ArchiveDayLookup::Found { hogaplay_dir, stamp } =
            replay.store.archive().lookup_day(archive_dir, lookup.date_str, lookup.stock.as_str())?
    {
        let span_data = archive_query::read_span(&hogaplay_dir, lookup.date_u32, lookup.stock.as_str(), lookup.start_minute)?;
        let encoded = encode_span_payload(&span_data)?;
        replay.spans.lock().expect("book replay span cache").insert(lookup.cache_key.clone(), stamp, encoded.clone());
        return Ok(Some((encoded, true)));
    }
    Ok(None)
}

fn load_day(replay: &BookReplay, lookup: &DayLookup<'_>) -> Result<(Option<FileStamp>, api::BookReplayDay), String> {
    let mut fallback_coverage = api::BookReplayCoverage::DayNotCollected;
    if let Some(hoga_dir) = &lookup.dirs.hoga {
        let (stamp, state) = replay.store.load_day_index(hoga_dir, lookup.date_str)?;
        match state {
            DayIndexState::Missing => {
                if let Some(shared_dir) = &lookup.dirs.shared {
                    let mut day = live::read_live_day(shared_dir, lookup.stock, lookup.date, lookup.date_str)?;
                    if day.coverage == api::BookReplayCoverage::Collected {
                        day.previous_close = reference::read_live_previous_close(
                            shared_dir,
                            lookup.shared_data,
                            &replay.snapshot_bases,
                            lookup.stock,
                            lookup.date_str,
                        );
                        return Ok((None, day));
                    }
                    fallback_coverage = day.coverage;
                }
            }
            DayIndexState::UnsupportedVersion => {}
            DayIndexState::Ready(index) => match index.stocks.get(lookup.stock.as_str()) {
                Some(coverage) => {
                    let day_dir = hoga_dir.join("store").join(lookup.date_str);
                    let data = store::read_day_data(&day_dir, lookup.date, lookup.stock.as_str(), index.buckets, coverage)?;
                    return Ok((
                        stamp,
                        api::BookReplayDay {
                            symbol: symbol_code(lookup.stock),
                            date: lookup.date_str.to_owned(),
                            coverage: api::BookReplayCoverage::Collected,
                            previous_close: data.previous_close,
                            venue_scope: None,
                            covered: data.covered,
                            books: data.books,
                            trades: data.trades,
                        },
                    ));
                }
                None => fallback_coverage = api::BookReplayCoverage::SymbolNotCollected,
            },
        }
    }
    if let Some(archive_dir) = &lookup.dirs.archive {
        match replay.store.archive().lookup_day(archive_dir, lookup.date_str, lookup.stock.as_str())? {
            ArchiveDayLookup::Found { hogaplay_dir, stamp } => {
                let data = archive_query::read_day_data(&hogaplay_dir)?;
                return Ok((
                    Some(stamp),
                    api::BookReplayDay {
                        symbol: symbol_code(lookup.stock),
                        date: lookup.date_str.to_owned(),
                        coverage: api::BookReplayCoverage::Collected,
                        previous_close: data.previous_close,
                        venue_scope: Some(api::ReplayVenueScope::KrxArchive),
                        covered: data.covered,
                        books: data.books,
                        trades: data.trades,
                    },
                ));
            }
            ArchiveDayLookup::MissingStock => {
                fallback_coverage = api::BookReplayCoverage::SymbolNotCollected;
            }
            ArchiveDayLookup::MissingDay => {}
        }
    }
    Ok((None, empty_day(lookup.stock, lookup.date_str.to_owned(), fallback_coverage)))
}

fn internal_error(context: &str, detail: String) -> ApiFailure {
    tracing::error!(reason = %detail, "{context}");
    ApiFailure::new(api::ApiErrorCode::Internal, context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::kst;

    fn write_book_parquet(path: &std::path::Path, recv_ms: i64, best_ask: i64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut cols = vec!["'005930_AL' AS symbol".to_owned(), format!("{recv_ms}::BIGINT AS recv_ms"), "'090000' AS f21".to_owned()];
        for level in 0..10 {
            let ask = if level == 0 { (-best_ask).to_string() } else { "NULL".to_owned() };
            let bid = if level == 0 { (-(best_ask - 100)).to_string() } else { "NULL".to_owned() };
            let qty = if level == 0 { 10 } else { 0 };
            cols.push(format!("({ask})::BIGINT AS f{}", 41 + level));
            cols.push(format!("({bid})::BIGINT AS f{}", 51 + level));
            cols.push(format!("{qty}::BIGINT AS f{}", 61 + level));
            cols.push(format!("{qty}::BIGINT AS f{}", 71 + level));
        }
        cols.push("10::BIGINT AS f121".to_owned());
        cols.push("10::BIGINT AS f125".to_owned());
        let conn = duckdb::Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("SET threads = 1; COPY (SELECT {}) TO '{}' (FORMAT parquet)", cols.join(", "), path.display())).unwrap();
    }

    #[test]
    fn refinalized_day_replaces_cached_response() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 23).unwrap();
        let recv_ms = kst(date, 9, 0, 10).unix() * 1000;
        let day_dir = tmp.path().join("store").join("20261123");
        std::fs::create_dir_all(&day_dir).unwrap();
        std::fs::write(
            day_dir.join("complete.json"),
            r#"{"format_version":1,"stocks":[{"code":"005930","key":"k1","registered":true,"received":true,"gaps":[],"handoff":null}]}"#,
        )
        .unwrap();
        write_book_parquet(&day_dir.join("0D").join("056.parquet"), recv_ms, 71_000);
        let replay = BookReplay::new(CollectedStore::new());
        let shared_data = SharedData::new();
        let dirs = ReplayDirs { hoga: Some(tmp.path().to_path_buf()), shared: Some(tmp.path().join("shared")), archive: None };
        let stock = StockCode::parse("005930").unwrap();
        let key = ("005930".to_owned(), "20261123".to_owned());
        let lookup = DayLookup {
            dirs: &dirs,
            shared_data: &shared_data,
            stock,
            date,
            date_str: "20261123",
            cache_key: &key,
        };
        let first = load_or_cached_day(&replay, &lookup).unwrap();
        assert_eq!(first.books[0].asks[0][0], 71_000);
        assert!(cached_response(&replay, &dirs, "20261123", "005930", &key).unwrap().is_some());
        write_book_parquet(&day_dir.join("0D").join("056.parquet"), recv_ms, 72_500);
        std::fs::write(
            day_dir.join("complete.json"),
            r#"{"format_version":1,"raw_files":{"k1/2000-000.jsonl.zst":10},"stocks":[{"code":"005930","key":"k1","registered":true,"received":true,"gaps":[],"handoff":null}]}"#,
        )
        .unwrap();
        assert!(cached_response(&replay, &dirs, "20261123", "005930", &key).unwrap().is_none());
        let second = load_or_cached_day(&replay, &lookup).unwrap();
        assert_eq!(second.books[0].asks[0][0], 72_500);
    }

    #[test]
    fn span_cache_and_zstd_negotiation_work() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 23).unwrap();
        let recv_ms = kst(date, 9, 0, 10).unix() * 1000;
        let day_dir = tmp.path().join("store").join("20261123");
        std::fs::create_dir_all(&day_dir).unwrap();
        std::fs::write(
            day_dir.join("complete.json"),
            r#"{"format_version":1,"stocks":[{"code":"005930","key":"k1","registered":true,"received":true,"gaps":[],"handoff":null}]}"#,
        )
        .unwrap();
        write_book_parquet(&day_dir.join("0D").join("056.parquet"), recv_ms, 71_000);

        let replay = BookReplay::new(CollectedStore::new());
        let dirs = ReplayDirs { hoga: Some(tmp.path().to_path_buf()), shared: Some(tmp.path().join("shared")), archive: None };
        let stock = StockCode::parse("005930").unwrap();
        let span_key = ("005930:540".to_owned(), "20261123".to_owned());
        let (encoded, immutable) = load_or_cached_span(
            &replay,
            SpanLookup {
                dirs: &dirs,
                stock,
                date,
                date_u32: 20261123,
                date_str: "20261123",
                start_minute: 540,
                cache_key: &span_key,
            },
        )
        .unwrap()
        .unwrap();
        assert!(immutable);
        assert!(cached_span(&replay, &dirs, "20261123", "005930", &span_key).unwrap().is_some());
        let decoded = hoga_format::decode(&encoded.raw).unwrap();
        assert_eq!(decoded.stream(hoga_format::StreamKind::Book).unwrap().rows(), 1);

        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip, zstd"));
        let resp = span_http_response(&headers, &encoded, true);
        assert_eq!(resp.headers().get(header::CONTENT_ENCODING).unwrap(), "zstd");
        assert_eq!(resp.headers().get(header::CACHE_CONTROL).unwrap(), IMMUTABLE_CACHE_CONTROL);
    }
}
