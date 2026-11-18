use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use domain::{StockCode, Symbol, Venue};

use crate::api;
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, symbol_list};
use crate::kiwoom::api::{MarketRequest, StockOrderBook, StockProgramTrades, StockTrades};
use crate::kiwoom::rest::{ContKey, KiwoomRest, MergeScope, Priority};
use crate::quotes::effective_venue;

pub const DEFAULT_TRADE_LIMIT: usize = 200;
pub const MAX_TRADE_LIMIT: usize = 500;
const MAX_PAGES: usize = 30;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/symbols/{code}/order-book", get(order_book))
        .route("/api/symbols/{code}/trades", get(trades))
        .route("/api/symbols/{code}/program-trades", get(program_trades))
}

async fn listed_stock(st: &AppState, code: &str) -> Result<StockCode, ApiFailure> {
    let Symbol::Stock(stock) = Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? else {
        return Err(ApiFailure::bad_request("지수에는 호가·체결·프로그램매매 자료가 없습니다"));
    };
    if symbol_list(st).await?.get(Symbol::Stock(stock)).is_none() {
        return Err(ApiFailure::new(api::ApiErrorCode::UnknownSymbol, format!("없는 종목입니다: {code}")));
    }
    Ok(stock)
}

fn symbol_code(stock: StockCode) -> api::SymbolCode {
    api::SymbolCode(Symbol::Stock(stock).as_wire())
}

async fn order_book(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::OrderBook>, ApiFailure> {
    let stock = listed_stock(&st, &code).await?;
    let page = st.rest.call(&StockOrderBook::new(stock), None, Priority::Screen, MergeScope::default()).await.map_err(|e| Lookup::OrderBook.failure(e.into(), st.clock.now()))?;
    let book = page.body;
    Ok(Json(api::OrderBook {
        symbol: symbol_code(stock),
        asks: book.asks,
        bids: book.bids,
        total_ask_quantity: book.total_ask_quantity,
        total_bid_quantity: book.total_bid_quantity,
        after_hours_ask_quantity: book.after_hours_ask_quantity,
        after_hours_bid_quantity: book.after_hours_bid_quantity,
        book_time: book.book_time,
    }))
}

async fn trades(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::TradeTape>, ApiFailure> {
    let requested = match q.get("venue") {
        None => Venue::Combined,
        Some(s) => Venue::parse(s).ok_or_else(|| ApiFailure::bad_request(format!("거래소는 combined, krx, nxt 중 하나입니다: {s}")))?,
    };
    let limit = match q.get("limit") {
        None => DEFAULT_TRADE_LIMIT,
        Some(s) => s.parse::<usize>().ok().filter(|n| (1..=MAX_TRADE_LIMIT).contains(n)).ok_or_else(|| ApiFailure::bad_request(format!("limit은 1~{MAX_TRADE_LIMIT}입니다: {s}")))?,
    };
    let stock = listed_stock(&st, &code).await?;
    let nxt_enabled = symbol_list(&st).await?.get(Symbol::Stock(stock)).is_some_and(|info| info.nxt_enabled);
    let venue = effective_venue(requested, nxt_enabled);
    let (trades, skipped_rows) = walk_trades(&st.rest, &StockTrades::new(stock, venue), stock, limit).await.map_err(|e| Lookup::Trades.failure(e, st.clock.now()))?;
    Ok(Json(api::TradeTape { symbol: symbol_code(stock), venue: venue.into(), trades, skipped_rows }))
}

async fn program_trades(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::ProgramTradeTimeline>, ApiFailure> {
    let stock = listed_stock(&st, &code).await?;
    let req = StockProgramTrades::new(stock, st.clock.now().kst_date());
    let (mut points, mut skipped_rows) = (Vec::new(), 0);
    let mut seen_keys = HashSet::new();
    let mut cont: Option<ContKey> = None;
    for _ in 0..MAX_PAGES {
        let page = st.rest.call(&req, cont.as_ref(), Priority::Screen, MergeScope::default()).await.map_err(|e| Lookup::ProgramTrades.failure(e.into(), st.clock.now()))?;
        let parsed = page.body.points();
        points.extend(parsed.rows);
        skipped_rows += parsed.skipped;
        match page.next {
            Some(next) if seen_keys.insert(next.clone()) => cont = Some(next),
            Some(_) => {
                tracing::warn!(api_id = StockProgramTrades::API_ID.as_str(), code = stock.as_str(), "키움 연속조회 키가 되풀이돼 여기서 멈춥니다");
                break;
            }
            None => break,
        }
    }
    Ok(Json(api::ProgramTradeTimeline { symbol: symbol_code(stock), points, skipped_rows }))
}

async fn walk_trades(rest: &KiwoomRest, req: &StockTrades, code: StockCode, limit: usize) -> Result<(Vec<api::TradePrint>, u32), BarError> {
    let (mut trades, mut skipped) = (Vec::new(), 0);
    let mut seen_keys = HashSet::new();
    let mut cont: Option<ContKey> = None;
    for _ in 0..MAX_PAGES {
        let page = rest.call(req, cont.as_ref(), Priority::Screen, MergeScope::default()).await?;
        let parsed = page.body.trades();
        trades.extend(parsed.rows);
        skipped += parsed.skipped;
        if trades.len() >= limit {
            break;
        }
        match page.next {
            Some(next) if seen_keys.insert(next.clone()) => cont = Some(next),
            Some(_) => {
                tracing::warn!(api_id = StockTrades::API_ID.as_str(), code = code.as_str(), "키움 연속조회 키가 되풀이돼 여기서 멈춥니다");
                break;
            }
            None => break,
        }
    }
    trades.truncate(limit);
    Ok((trades, skipped))
}
