mod day_index;
mod store;

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

use self::day_index::{DayIndexCache, DayIndexState};

const RESPONSE_CACHE_CAPACITY: usize = 16;
const MAX_CONCURRENT_QUERIES: usize = 2;

struct ResponseCache {
    order: VecDeque<(String, String)>,
    entries: HashMap<(String, String), Arc<api::BookReplayDay>>,
}

impl ResponseCache {
    fn new() -> Self {
        Self { order: VecDeque::with_capacity(RESPONSE_CACHE_CAPACITY), entries: HashMap::with_capacity(RESPONSE_CACHE_CAPACITY) }
    }

    fn get(&mut self, key: &(String, String)) -> Option<Arc<api::BookReplayDay>> {
        let value = self.entries.get(key)?.clone();
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
        Some(value)
    }

    fn insert(&mut self, key: (String, String), value: Arc<api::BookReplayDay>) {
        if let Some(pos) = self.order.iter().position(|k| k == &key) {
            self.order.remove(pos);
        } else if self.order.len() >= RESPONSE_CACHE_CAPACITY
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
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
    if let Some(cached) = st.book_replay.responses.lock().expect("book replay cache").get(&cache_key) {
        return Ok(Json(cached));
    }
    let _permit = st.book_replay.permits.clone().acquire_owned().await.map_err(|e| internal_error("호가 복기 조회 허가를 얻지 못했습니다", e.to_string()))?;
    if let Some(cached) = st.book_replay.responses.lock().expect("book replay cache").get(&cache_key) {
        return Ok(Json(cached));
    }
    let replay = st.book_replay.clone();
    let date_owned = date_str.to_owned();
    let response = tokio::task::spawn_blocking(move || load_day(&replay, &dir, stock, date, &date_owned))
        .await
        .map_err(|e| internal_error("호가 복기 조회 작업이 멈췄습니다", e.to_string()))?
        .map_err(|e| internal_error("호가 복기 자료를 읽지 못했습니다", e))?;
    let shared = Arc::new(response);
    if shared.coverage == api::BookReplayCoverage::Collected {
        st.book_replay.responses.lock().expect("book replay cache").insert(cache_key, shared.clone());
    }
    Ok(Json(shared))
}

fn load_day(replay: &BookReplay, dir: &std::path::Path, stock: StockCode, date: KstDate, date_str: &str) -> Result<api::BookReplayDay, String> {
    let index = match replay.day_index.load(dir, date_str)? {
        DayIndexState::Missing | DayIndexState::UnsupportedVersion => return Ok(empty_day(stock, date_str.to_owned(), api::BookReplayCoverage::DayNotCollected)),
        DayIndexState::Ready(index) => index,
    };
    let Some(coverage) = index.stocks.get(stock.as_str()) else {
        return Ok(empty_day(stock, date_str.to_owned(), api::BookReplayCoverage::SymbolNotCollected));
    };
    let day_dir = dir.join("store").join(date_str);
    let data = store::read_day_data(&day_dir, date, stock.as_str(), index.buckets, coverage)?;
    Ok(api::BookReplayDay {
        symbol: symbol_code(stock),
        date: date_str.to_owned(),
        coverage: api::BookReplayCoverage::Collected,
        covered: data.covered,
        books: data.books,
        trades: data.trades,
    })
}

fn internal_error(context: &str, detail: String) -> ApiFailure {
    tracing::error!(reason = %detail, "{context}");
    ApiFailure::new(api::ApiErrorCode::Internal, context)
}
