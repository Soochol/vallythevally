mod live;
mod raw_live;
mod span;
mod store;

use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use domain::{KstDate, StockCode, Symbol};

use crate::api;
use crate::collected_store::{CollectedStore, DayIndexState, FileStamp, StampLru, read_stamp};
use crate::http::{ApiFailure, AppState};

const SPAN_CACHE_CAPACITY: usize = 64;
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const LIVE_CACHE_CONTROL: &str = "no-store";
const ZSTD_SPAN_LEVEL: i32 = 3;

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
}

impl BookReplay {
    pub fn new(store: Arc<CollectedStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            responses: Mutex::new(StampLru::new()),
            metas: Mutex::new(StampLru::new()),
            spans: Mutex::new(StampLru::with_capacity(SPAN_CACHE_CAPACITY)),
        })
    }
}

fn replay_dirs(st: &AppState) -> Result<(PathBuf, PathBuf), ApiFailure> {
    let hoga = st.collector_paths.hoga_dir().ok_or_else(|| ApiFailure::new(api::ApiErrorCode::NotFound, "호가 복기 기능이 켜져 있지 않습니다"))?;
    let shared = st.collector_paths.shared_dir().ok_or_else(|| ApiFailure::new(api::ApiErrorCode::NotFound, "호가 복기 기능이 켜져 있지 않습니다"))?;
    Ok((hoga.to_path_buf(), shared.to_path_buf()))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/book-replay/access", get(access))
        .route("/api/symbols/{code}/book-replay/days", get(days))
        .route("/api/symbols/{code}/book-replay/meta", get(day_meta))
        .route("/api/symbols/{code}/book-replay/span", get(day_span))
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
    api::BookReplayDay { symbol: symbol_code(stock), date, coverage, covered: Vec::new(), books: Vec::new(), trades: Vec::new() }
}

fn empty_meta(stock: StockCode, date: String, coverage: api::BookReplayCoverage) -> api::BookReplayMeta {
    api::BookReplayMeta {
        symbol: symbol_code(stock),
        date,
        coverage,
        resolution: api::BookReplayResolution::MinuteOnly,
        span_minutes: u32::from(span::SPAN_MINUTES),
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

async fn access(State(st): State<Arc<AppState>>) -> Json<api::BookReplayAccess> {
    Json(api::BookReplayAccess { available: st.collector_paths.hoga_dir().is_some() })
}

async fn days(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::BookReplayDays>, ApiFailure> {
    let (dir, shared) = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let replay = st.book_replay.clone();
    let stock_str = stock.as_str().to_owned();
    let days = tokio::task::spawn_blocking(move || {
        let mut merged: BTreeSet<String> = replay.store.collected_days(&dir, &stock_str)?.into_iter().collect();
        merged.extend(live::live_days(&dir, &shared, &stock_str)?);
        Ok::<Vec<String>, String>(merged.into_iter().collect())
    })
        .await
        .map_err(|e| internal_error("호가 복기 날짜 목록 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 날짜 목록을 읽지 못했습니다", e))?;
    Ok(Json(api::BookReplayDays { symbol: symbol_code(stock), days }))
}

async fn day_replay(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<Arc<api::BookReplayDay>>, ApiFailure> {
    let (dir, shared_dir) = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, _) = parse_date_query(&q)?;
    let cache_key = (stock.as_str().to_owned(), date_str.clone());
    let replay_check = st.book_replay.clone();
    let dir_check = dir.clone();
    let date_check = date_str.clone();
    let key_check = cache_key.clone();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_response(&replay_check, &dir_check, &date_check, &key_check))
        .await
        .map_err(|e| internal_error("호가 복기 캐시 확인 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 자료를 확인하지 못했습니다", e))?
    {
        return Ok(Json(cached));
    }
    let permit = st.book_replay.store.acquire_permit().await.map_err(|e| internal_error("호가 복기 조회 허가를 얻지 못했습니다", e))?;
    let replay = st.book_replay.clone();
    let shared = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        load_or_cached_day(&replay, &dir, &shared_dir, stock, date, &date_str, &cache_key)
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
    let (dir, shared_dir) = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, _) = parse_date_query(&q)?;
    let cache_key = (stock.as_str().to_owned(), date_str.clone());
    let replay_check = st.book_replay.clone();
    let dir_check = dir.clone();
    let date_check = date_str.clone();
    let key_check = cache_key.clone();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_meta(&replay_check, &dir_check, &date_check, &key_check))
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
        load_or_cached_meta(&replay, &dir, &shared_dir, stock, date, &date_str, &cache_key)
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
    let (dir, shared_dir) = replay_dirs(&st)?;
    let stock = parse_stock(&code)?;
    let (date_str, date, date_u32) = parse_date_query(&q)?;
    let start_minute = parse_start_minute(&q)?;
    let cache_key = (format!("{}:{start_minute}", stock.as_str()), date_str.clone());
    let replay_check = st.book_replay.clone();
    let dir_check = dir.clone();
    let date_check = date_str.clone();
    let key_check = cache_key.clone();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_span(&replay_check, &dir_check, &date_check, &key_check))
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
        load_or_cached_span(&replay, &dir, &shared_dir, stock, date, date_u32, &date_str, start_minute, &cache_key)
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

fn cached_response(replay: &BookReplay, dir: &std::path::Path, date_str: &str, cache_key: &(String, String)) -> Result<Option<Arc<api::BookReplayDay>>, String> {
    let Some(stamp) = read_stamp(dir, date_str)? else { return Ok(None) };
    Ok(replay.responses.lock().expect("book replay cache").get(cache_key, &stamp))
}

fn cached_meta(replay: &BookReplay, dir: &std::path::Path, date_str: &str, cache_key: &(String, String)) -> Result<Option<Arc<api::BookReplayMeta>>, String> {
    let Some(stamp) = read_stamp(dir, date_str)? else { return Ok(None) };
    Ok(replay.metas.lock().expect("book replay meta cache").get(cache_key, &stamp))
}

fn cached_span(replay: &BookReplay, dir: &std::path::Path, date_str: &str, cache_key: &(String, String)) -> Result<Option<EncodedSpan>, String> {
    let Some(stamp) = read_stamp(dir, date_str)? else { return Ok(None) };
    Ok(replay.spans.lock().expect("book replay span cache").get(cache_key, &stamp))
}

fn load_or_cached_day(replay: &BookReplay, dir: &std::path::Path, shared_dir: &std::path::Path, stock: StockCode, date: KstDate, date_str: &str, cache_key: &(String, String)) -> Result<Arc<api::BookReplayDay>, String> {
    if let Some(cached) = cached_response(replay, dir, date_str, cache_key)? {
        return Ok(cached);
    }
    let (stamp, response) = load_day(replay, dir, shared_dir, stock, date, date_str)?;
    let shared = Arc::new(response);
    if shared.coverage == api::BookReplayCoverage::Collected
        && let Some(stamp) = stamp
    {
        replay.responses.lock().expect("book replay cache").insert(cache_key.clone(), stamp, shared.clone());
    }
    Ok(shared)
}

fn load_or_cached_meta(
    replay: &BookReplay,
    dir: &std::path::Path,
    shared_dir: &std::path::Path,
    stock: StockCode,
    date: KstDate,
    date_str: &str,
    cache_key: &(String, String),
) -> Result<Arc<api::BookReplayMeta>, String> {
    if let Some(cached) = cached_meta(replay, dir, date_str, cache_key)? {
        return Ok(cached);
    }
    let (stamp, state) = replay.store.load_day_index(dir, date_str)?;
    let response = match state {
        DayIndexState::Missing => raw_live::read_live_meta(dir, shared_dir, stock, date, date_str)?,
        DayIndexState::UnsupportedVersion => empty_meta(stock, date_str.to_owned(), api::BookReplayCoverage::DayNotCollected),
        DayIndexState::Ready(index) => match index.stocks.get(stock.as_str()) {
            None => empty_meta(stock, date_str.to_owned(), api::BookReplayCoverage::SymbolNotCollected),
            Some(coverage) => {
                let day_dir = dir.join("store").join(date_str);
                span::read_day_meta(&day_dir, date, date_str, stock, index.buckets, coverage)?
            }
        },
    };
    let shared = Arc::new(response);
    if shared.coverage == api::BookReplayCoverage::Collected
        && let Some(stamp) = stamp
    {
        replay.metas.lock().expect("book replay meta cache").insert(cache_key.clone(), stamp, shared.clone());
    }
    Ok(shared)
}

#[allow(clippy::too_many_arguments)]
fn load_or_cached_span(
    replay: &BookReplay,
    dir: &std::path::Path,
    shared_dir: &std::path::Path,
    stock: StockCode,
    date: KstDate,
    date_u32: u32,
    date_str: &str,
    start_minute: u16,
    cache_key: &(String, String),
) -> Result<Option<(EncodedSpan, bool)>, String> {
    if let Some(cached) = cached_span(replay, dir, date_str, cache_key)? {
        return Ok(Some((cached, true)));
    }
    let (stamp, state) = replay.store.load_day_index(dir, date_str)?;
    match state {
        DayIndexState::Missing => {
            let Some(live_span) = raw_live::read_live_span(dir, shared_dir, date, date_u32, date_str, stock.as_str(), start_minute)? else {
                return Ok(None);
            };
            let encoded = encode_span_payload(&live_span)?;
            Ok(Some((encoded, false)))
        }
        DayIndexState::UnsupportedVersion => Ok(None),
        DayIndexState::Ready(index) => {
            let Some(coverage) = index.stocks.get(stock.as_str()) else {
                return Ok(None);
            };
            let day_dir = dir.join("store").join(date_str);
            let span_data = span::read_span(&day_dir, date, date_u32, stock.as_str(), index.buckets, coverage, start_minute)?;
            let encoded = encode_span_payload(&span_data)?;
            if let Some(stamp) = stamp {
                replay.spans.lock().expect("book replay span cache").insert(cache_key.clone(), stamp, encoded.clone());
            }
            Ok(Some((encoded, true)))
        }
    }
}

fn load_day(replay: &BookReplay, dir: &std::path::Path, shared_dir: &std::path::Path, stock: StockCode, date: KstDate, date_str: &str) -> Result<(Option<FileStamp>, api::BookReplayDay), String> {
    let (stamp, state) = replay.store.load_day_index(dir, date_str)?;
    let index = match state {
        DayIndexState::Missing => return Ok((None, live::read_live_day(shared_dir, stock, date, date_str)?)),
        DayIndexState::UnsupportedVersion => return Ok((stamp, empty_day(stock, date_str.to_owned(), api::BookReplayCoverage::DayNotCollected))),
        DayIndexState::Ready(index) => index,
    };
    let Some(coverage) = index.stocks.get(stock.as_str()) else {
        return Ok((stamp, empty_day(stock, date_str.to_owned(), api::BookReplayCoverage::SymbolNotCollected)));
    };
    let day_dir = dir.join("store").join(date_str);
    let data = store::read_day_data(&day_dir, date, stock.as_str(), index.buckets, coverage)?;
    Ok((
        stamp,
        api::BookReplayDay {
            symbol: symbol_code(stock),
            date: date_str.to_owned(),
            coverage: api::BookReplayCoverage::Collected,
            covered: data.covered,
            books: data.books,
            trades: data.trades,
        },
    ))
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
        let shared = tmp.path().join("shared");
        let stock = StockCode::parse("005930").unwrap();
        let key = ("005930".to_owned(), "20261123".to_owned());
        let first = load_or_cached_day(&replay, tmp.path(), &shared, stock, date, "20261123", &key).unwrap();
        assert_eq!(first.books[0].asks[0][0], 71_000);
        assert!(cached_response(&replay, tmp.path(), "20261123", &key).unwrap().is_some());
        write_book_parquet(&day_dir.join("0D").join("056.parquet"), recv_ms, 72_500);
        std::fs::write(
            day_dir.join("complete.json"),
            r#"{"format_version":1,"raw_files":{"k1/2000-000.jsonl.zst":10},"stocks":[{"code":"005930","key":"k1","registered":true,"received":true,"gaps":[],"handoff":null}]}"#,
        )
        .unwrap();
        assert!(cached_response(&replay, tmp.path(), "20261123", &key).unwrap().is_none());
        let second = load_or_cached_day(&replay, tmp.path(), &shared, stock, date, "20261123", &key).unwrap();
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
        let shared = tmp.path().join("shared");
        let stock = StockCode::parse("005930").unwrap();
        let span_key = ("005930:540".to_owned(), "20261123".to_owned());
        let (encoded, immutable) = load_or_cached_span(&replay, tmp.path(), &shared, stock, date, 20261123, "20261123", 540, &span_key)
            .unwrap()
            .unwrap();
        assert!(immutable);
        assert!(cached_span(&replay, tmp.path(), "20261123", &span_key).unwrap().is_some());
        let decoded = hoga_format::decode(&encoded.raw).unwrap();
        assert_eq!(decoded.stream(hoga_format::StreamKind::Book).unwrap().rows(), 1);

        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip, zstd"));
        let resp = span_http_response(&headers, &encoded, true);
        assert_eq!(resp.headers().get(header::CONTENT_ENCODING).unwrap(), "zstd");
        assert_eq!(resp.headers().get(header::CACHE_CONTROL).unwrap(), IMMUTABLE_CACHE_CONTROL);
    }
}
