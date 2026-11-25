use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Path as AxumPath, Query, State};
use axum::response::Json;
use axum::routing::get;
use domain::{BookSideLevel, KstDate, KstTime, MicroEvent, MicroEventDetector, StockCode, Symbol};
use duckdb::{Connection, params};

use crate::api;
use crate::clock::kst;
use crate::collected::Collected;
use crate::collected_store::{CollectedStore, DayIndexState, StampLru, bucket_file_name, file_exists, open_connection, path_str, read_stamp};
use crate::http::{ApiFailure, AppState};
use crate::shared_data::CollectorPaths;

const BOOK_DEPTH: usize = 10;

const BOOK_EVENTS_QUERY: &str = "
SELECT
    recv_ms, file_row_number,
    f41, f61, f42, f62, f43, f63, f44, f64, f45, f65,
    f46, f66, f47, f67, f48, f68, f49, f69, f50, f70,
    f51, f71, f52, f72, f53, f73, f54, f74, f55, f75,
    f56, f76, f57, f77, f58, f78, f59, f79, f60, f80
FROM read_parquet($1, file_row_number = true)
WHERE symbol = $2 AND recv_ms >= $3 AND recv_ms < $4
ORDER BY recv_ms ASC, file_row_number ASC
";

const TRADE_EVENTS_QUERY: &str = "
SELECT recv_ms, file_row_number, f10, f15
FROM read_parquet($1, file_row_number = true)
WHERE symbol = $2 AND recv_ms >= $3 AND recv_ms < $4 AND f10 IS NOT NULL AND f15 IS NOT NULL AND f15 != 0
ORDER BY recv_ms ASC, file_row_number ASC
";

pub struct MicroEventService {
    store: Arc<CollectedStore>,
    cache: Mutex<StampLru<Arc<Vec<MicroEvent>>>>,
}

impl MicroEventService {
    pub fn new(store: Arc<CollectedStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            cache: Mutex::new(StampLru::new()),
        })
    }

    pub async fn day_events(
        self: &Arc<Self>,
        collected: &Arc<Collected>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        now: KstTime,
    ) -> Result<(api::BrokerDaySource, Vec<MicroEvent>), String> {
        let date_str = format_yyyymmdd(date);
        if let Some(dir) = paths.hoga_dir().map(Path::to_path_buf) {
            let cache_key = (stock.as_str().to_owned(), date_str.clone());
            let cached = {
                let service = Arc::clone(self);
                let dir_check = dir.clone();
                let date_check = date_str.clone();
                let key_check = cache_key.clone();
                tokio::task::spawn_blocking(move || lookup_cache(&service, &dir_check, &date_check, &key_check))
                    .await
                    .map_err(|e| format!("미시 이벤트 캐시 확인 작업이 멈췄습니다: {e}"))??
            };
            match cached {
                CacheLookup::Hit(events) => return Ok((api::BrokerDaySource::Store, (*events).clone())),
                CacheLookup::Miss => {
                    let permit = self.store.acquire_permit().await.map_err(|e| format!("미시 이벤트 조회 허가를 얻지 못했습니다: {e}"))?;
                    let service = Arc::clone(self);
                    let dir_load = dir.clone();
                    let date_owned = date_str.clone();
                    let stock_str = stock.as_str().to_owned();
                    let computed = tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        compute_and_cache_store_day(&service, &dir_load, date, &date_owned, &stock_str, &cache_key)
                    })
                    .await
                    .map_err(|e| format!("미시 이벤트 계산 작업이 멈췄습니다: {e}"))??;
                    if let Some(events) = computed {
                        return Ok((api::BrokerDaySource::Store, (*events).clone()));
                    }
                }
                CacheLookup::NotCollected => {}
            }
        }
        if date == now.kst_date() {
            let slice = collected.micro_day(paths, stock, date, &date_str, None, now).await?;
            if slice.source != api::BrokerDaySource::None {
                return Ok((slice.source, slice.snapshots));
            }
        }
        Ok((api::BrokerDaySource::None, Vec::new()))
    }
}

enum CacheLookup {
    Hit(Arc<Vec<MicroEvent>>),
    Miss,
    NotCollected,
}

fn lookup_cache(service: &MicroEventService, dir: &Path, date_str: &str, cache_key: &(String, String)) -> Result<CacheLookup, String> {
    let Some(stamp) = read_stamp(dir, date_str)? else {
        return Ok(CacheLookup::NotCollected);
    };
    if let Some(events) = service.cache.lock().expect("micro events cache").get(cache_key, &stamp) {
        return Ok(CacheLookup::Hit(events));
    }
    let (_, state) = service.store.load_day_index(dir, date_str)?;
    match state {
        DayIndexState::Ready(index) if index.stocks.contains_key(&cache_key.0) => Ok(CacheLookup::Miss),
        _ => Ok(CacheLookup::NotCollected),
    }
}

fn compute_and_cache_store_day(
    service: &MicroEventService,
    dir: &Path,
    date: KstDate,
    date_str: &str,
    stock_str: &str,
    cache_key: &(String, String),
) -> Result<Option<Arc<Vec<MicroEvent>>>, String> {
    let (Some(stamp), state) = service.store.load_day_index(dir, date_str)? else {
        return Ok(None);
    };
    if let Some(events) = service.cache.lock().expect("micro events cache").get(cache_key, &stamp) {
        return Ok(Some(events));
    }
    let DayIndexState::Ready(index) = state else {
        return Ok(None);
    };
    if !index.stocks.contains_key(stock_str) {
        return Ok(None);
    }
    let day_dir = dir.join("store").join(date_str);
    let events = Arc::new(compute_store_day(&day_dir, date, stock_str, index.buckets)?);
    service.cache.lock().expect("micro events cache").insert(cache_key.clone(), stamp, Arc::clone(&events));
    Ok(Some(events))
}

struct StoredBook {
    recv_ms: i64,
    asks: [BookSideLevel; BOOK_DEPTH],
    bids: [BookSideLevel; BOOK_DEPTH],
}

struct StoredTrade {
    recv_ms: i64,
    price_won: u64,
    signed_qty: i64,
}

fn compute_store_day(day_dir: &Path, date: KstDate, stock_code: &str, buckets: u64) -> Result<Vec<MicroEvent>, String> {
    let symbol = format!("{stock_code}_AL");
    let bucket_file = bucket_file_name(&symbol, buckets);
    let book_path = day_dir.join("0D").join(&bucket_file);
    let trade_path = day_dir.join("0B").join(&bucket_file);
    if !file_exists(&book_path)? {
        return Ok(Vec::new());
    }
    let conn = open_connection()?;
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let day_end_ms = day_start_ms + 86_400_000;
    let books = query_books(&conn, &book_path, &symbol, day_start_ms, day_end_ms)?;
    let trades = if file_exists(&trade_path)? {
        query_trades(&conn, &trade_path, &symbol, day_start_ms, day_end_ms)?
    } else {
        Vec::new()
    };

    let mut detector = MicroEventDetector::default();
    let mut out = Vec::new();
    let mut trade_idx = 0usize;
    for book in &books {
        while trade_idx < trades.len() && trades[trade_idx].recv_ms <= book.recv_ms {
            let trade = &trades[trade_idx];
            detector.on_trade(trade.recv_ms, trade.price_won, trade.signed_qty);
            trade_idx += 1;
        }
        let (events, _) = detector.on_book(book.recv_ms, &book.asks, &book.bids);
        out.extend(events);
    }
    Ok(out)
}

fn query_books(conn: &Connection, path: &Path, symbol: &str, day_start_ms: i64, day_end_ms: i64) -> Result<Vec<StoredBook>, String> {
    let path_text = path_str(path)?;
    let mut stmt = conn.prepare(BOOK_EVENTS_QUERY).map_err(|e| format!("미시 이벤트 호가 조회 준비 실패({path_text}): {e}"))?;
    let rows = stmt
        .query_map(params![path_text, symbol, day_start_ms, day_end_ms], |row| {
            let recv_ms = row.get::<_, i64>(0)?;
            let mut asks = [BookSideLevel::default(); BOOK_DEPTH];
            for (level, slot) in asks.iter_mut().enumerate() {
                let price_won = row.get::<_, Option<i64>>(2 + level * 2)?.unwrap_or(0).unsigned_abs();
                let qty = non_negative_u64(row.get::<_, Option<i64>>(3 + level * 2)?);
                *slot = BookSideLevel { price_won, qty };
            }
            let mut bids = [BookSideLevel::default(); BOOK_DEPTH];
            for (level, slot) in bids.iter_mut().enumerate() {
                let price_won = row.get::<_, Option<i64>>(22 + level * 2)?.unwrap_or(0).unsigned_abs();
                let qty = non_negative_u64(row.get::<_, Option<i64>>(23 + level * 2)?);
                *slot = BookSideLevel { price_won, qty };
            }
            Ok(StoredBook { recv_ms, asks, bids })
        })
        .map_err(|e| format!("미시 이벤트 호가 조회 실행 실패({path_text}): {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("미시 이벤트 호가 행 읽기 실패({path_text}): {e}"))?);
    }
    Ok(out)
}

fn query_trades(conn: &Connection, path: &Path, symbol: &str, day_start_ms: i64, day_end_ms: i64) -> Result<Vec<StoredTrade>, String> {
    let path_text = path_str(path)?;
    let mut stmt = conn.prepare(TRADE_EVENTS_QUERY).map_err(|e| format!("미시 이벤트 체결 조회 준비 실패({path_text}): {e}"))?;
    let rows = stmt
        .query_map(params![path_text, symbol, day_start_ms, day_end_ms], |row| {
            let recv_ms = row.get::<_, i64>(0)?;
            let price_won = row.get::<_, Option<i64>>(2)?.unwrap_or(0).unsigned_abs();
            let signed_qty = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
            Ok(StoredTrade { recv_ms, price_won, signed_qty })
        })
        .map_err(|e| format!("미시 이벤트 체결 조회 실행 실패({path_text}): {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let trade = row.map_err(|e| format!("미시 이벤트 체결 행 읽기 실패({path_text}): {e}"))?;
        if trade.price_won > 0 && trade.signed_qty != 0 {
            out.push(trade);
        }
    }
    Ok(out)
}

fn non_negative_u64(raw: Option<i64>) -> u64 {
    raw.map_or(0, |value| value.max(0) as u64)
}

fn format_yyyymmdd(date: KstDate) -> String {
    format!("{:04}{:02}{:02}", date.year(), date.month(), date.day())
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/symbols/{code}/micro-events", get(symbol_micro_events))
}

fn parse_stock(code: &str) -> Result<StockCode, ApiFailure> {
    match Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? {
        Symbol::Stock(stock) => Ok(stock),
        Symbol::Index(_) => Err(ApiFailure::bad_request("지수에는 미시 이벤트 자료가 없습니다")),
    }
}

async fn symbol_micro_events(
    State(st): State<Arc<AppState>>,
    AxumPath(code): AxumPath<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<api::MicroEventsPage>, ApiFailure> {
    let stock = parse_stock(&code)?;
    let now = st.clock.now();
    let (date, date_str) = match q.get("date").map(String::as_str).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let parsed = KstDate::parse_yyyymmdd(raw).ok_or_else(|| ApiFailure::bad_request(format!("date는 YYYYMMDD 형식입니다: {raw}")))?;
            (parsed, raw.to_owned())
        }
        None => {
            let today = now.kst_date();
            (today, format_yyyymmdd(today))
        }
    };
    let (source, events) = st
        .micro_events
        .day_events(&st.collected, st.collector_paths.snapshot(), stock, date, now)
        .await
        .map_err(|detail| {
            tracing::error!(reason = %detail, "미시 이벤트 자료를 읽지 못했습니다");
            ApiFailure::new(api::ApiErrorCode::Internal, "미시 이벤트 자료를 읽지 못했습니다")
        })?;
    Ok(Json(api::MicroEventsPage {
        symbol: api::SymbolCode(Symbol::Stock(stock).as_wire()),
        date: date_str,
        source,
        events: events.into_iter().map(Into::into).collect(),
    }))
}
