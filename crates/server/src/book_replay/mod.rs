pub(crate) mod day_index;
pub(crate) mod store;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use domain::{KstDate, StockCode, Symbol};
use tokio::sync::Semaphore;

use crate::api;
use crate::http::{ApiFailure, AppState};

use self::day_index::{DayIndexCache, DayIndexState, FileStamp, read_stamp};

const RESPONSE_CACHE_CAPACITY: usize = 16;
const MAX_CONCURRENT_QUERIES: usize = 2;

struct CachedResponse {
    stamp: FileStamp,
    body: Arc<api::BookReplayDay>,
}

struct ResponseCache {
    order: VecDeque<(String, String)>,
    entries: HashMap<(String, String), CachedResponse>,
}

impl ResponseCache {
    fn new() -> Self {
        Self { order: VecDeque::with_capacity(RESPONSE_CACHE_CAPACITY), entries: HashMap::with_capacity(RESPONSE_CACHE_CAPACITY) }
    }

    fn get(&mut self, key: &(String, String), stamp: &FileStamp) -> Option<Arc<api::BookReplayDay>> {
        let entry = self.entries.get(key)?;
        if &entry.stamp != stamp {
            return None;
        }
        let body = entry.body.clone();
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
        Some(body)
    }

    fn insert(&mut self, key: (String, String), stamp: FileStamp, body: Arc<api::BookReplayDay>) {
        if let Some(pos) = self.order.iter().position(|k| k == &key) {
            self.order.remove(pos);
        } else if self.order.len() >= RESPONSE_CACHE_CAPACITY
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, CachedResponse { stamp, body });
    }
}

pub struct BookReplay {
    dir: OnceLock<PathBuf>,
    day_index: DayIndexCache,
    responses: Mutex<ResponseCache>,
    permits: Arc<Semaphore>,
}

impl BookReplay {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            dir: OnceLock::new(),
            day_index: DayIndexCache::new(),
            responses: Mutex::new(ResponseCache::new()),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_QUERIES)),
        })
    }

    pub fn enable(&self, dir: PathBuf) {
        let _ = self.dir.set(dir);
    }

    pub fn is_enabled(&self) -> bool {
        self.dir.get().is_some()
    }

    fn data_dir(&self) -> Result<PathBuf, ApiFailure> {
        self.dir.get().cloned().ok_or_else(|| ApiFailure::new(api::ApiErrorCode::NotFound, "호가 복기 기능이 켜져 있지 않습니다"))
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/book-replay/access", get(access))
        .route("/api/symbols/{code}/book-replay/days", get(days))
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

async fn access(State(st): State<Arc<AppState>>) -> Json<api::BookReplayAccess> {
    Json(api::BookReplayAccess { available: st.book_replay.is_enabled() })
}

async fn days(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::BookReplayDays>, ApiFailure> {
    let dir = st.book_replay.data_dir()?;
    let stock = parse_stock(&code)?;
    let replay = st.book_replay.clone();
    let stock_str = stock.as_str().to_owned();
    let days = tokio::task::spawn_blocking(move || replay.day_index.collected_days(&dir, &stock_str))
        .await
        .map_err(|e| internal_error("호가 복기 날짜 목록 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 날짜 목록을 읽지 못했습니다", e))?;
    Ok(Json(api::BookReplayDays { symbol: symbol_code(stock), days }))
}

async fn day_replay(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<Arc<api::BookReplayDay>>, ApiFailure> {
    let dir = st.book_replay.data_dir()?;
    let stock = parse_stock(&code)?;
    let date_str = q.get("date").map(String::as_str).filter(|s| !s.is_empty()).ok_or_else(|| ApiFailure::bad_request("date 쿼리(YYYYMMDD)가 필요합니다"))?;
    let date = KstDate::parse_yyyymmdd(date_str).ok_or_else(|| ApiFailure::bad_request(format!("date는 YYYYMMDD 형식입니다: {date_str}")))?;
    let cache_key = (stock.as_str().to_owned(), date_str.to_owned());
    let replay_check = st.book_replay.clone();
    let dir_check = dir.clone();
    let date_check = date_str.to_owned();
    let key_check = cache_key.clone();
    if let Some(cached) = tokio::task::spawn_blocking(move || cached_response(&replay_check, &dir_check, &date_check, &key_check))
        .await
        .map_err(|e| internal_error("호가 복기 캐시 확인 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 자료를 확인하지 못했습니다", e))?
    {
        return Ok(Json(cached));
    }
    let permit = st.book_replay.permits.clone().acquire_owned().await.map_err(|e| internal_error("호가 복기 조회 허가를 얻지 못했습니다", e.to_string()))?;
    let replay = st.book_replay.clone();
    let date_owned = date_str.to_owned();
    let shared = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        load_or_cached_day(&replay, &dir, stock, date, &date_owned, &cache_key)
    })
    .await
    .map_err(|e| internal_error("호가 복기 조회 작업이 멈췄습니다", e.to_string()))?
    .map_err(|e| internal_error("호가 복기 자료를 읽지 못했습니다", e))?;
    Ok(Json(shared))
}

fn cached_response(replay: &BookReplay, dir: &std::path::Path, date_str: &str, cache_key: &(String, String)) -> Result<Option<Arc<api::BookReplayDay>>, String> {
    let Some(stamp) = read_stamp(dir, date_str)? else { return Ok(None) };
    Ok(replay.responses.lock().expect("book replay cache").get(cache_key, &stamp))
}

fn load_or_cached_day(replay: &BookReplay, dir: &std::path::Path, stock: StockCode, date: KstDate, date_str: &str, cache_key: &(String, String)) -> Result<Arc<api::BookReplayDay>, String> {
    if let Some(cached) = cached_response(replay, dir, date_str, cache_key)? {
        return Ok(cached);
    }
    let (stamp, response) = load_day(replay, dir, stock, date, date_str)?;
    let shared = Arc::new(response);
    if shared.coverage == api::BookReplayCoverage::Collected
        && let Some(stamp) = stamp
    {
        replay.responses.lock().expect("book replay cache").insert(cache_key.clone(), stamp, shared.clone());
    }
    Ok(shared)
}

fn load_day(replay: &BookReplay, dir: &std::path::Path, stock: StockCode, date: KstDate, date_str: &str) -> Result<(Option<FileStamp>, api::BookReplayDay), String> {
    let (stamp, state) = replay.day_index.load(dir, date_str)?;
    let index = match state {
        DayIndexState::Missing | DayIndexState::UnsupportedVersion => return Ok((stamp, empty_day(stock, date_str.to_owned(), api::BookReplayCoverage::DayNotCollected))),
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
        let replay = BookReplay::new();
        let stock = StockCode::parse("005930").unwrap();
        let key = ("005930".to_owned(), "20261123".to_owned());
        let first = load_or_cached_day(&replay, tmp.path(), stock, date, "20261123", &key).unwrap();
        assert_eq!(first.books[0].asks[0][0], 71_000);
        assert!(cached_response(&replay, tmp.path(), "20261123", &key).unwrap().is_some());
        write_book_parquet(&day_dir.join("0D").join("056.parquet"), recv_ms, 72_500);
        std::fs::write(
            day_dir.join("complete.json"),
            r#"{"format_version":1,"raw_files":{"k1/2000-000.jsonl.zst":10},"stocks":[{"code":"005930","key":"k1","registered":true,"received":true,"gaps":[],"handoff":null}]}"#,
        )
        .unwrap();
        assert!(cached_response(&replay, tmp.path(), "20261123", &key).unwrap().is_none());
        let second = load_or_cached_day(&replay, tmp.path(), stock, date, "20261123", &key).unwrap();
        assert_eq!(second.books[0].asks[0][0], 72_500);
    }
}
