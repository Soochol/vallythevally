use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use domain::{KstDate, KstTime, StockCode, Symbol, Venue, Weekday};

use crate::api;
use crate::bars::BarError;
use crate::collected::kind::CollectedProgramRow;
use crate::http::{ApiFailure, AppState, Lookup, symbol_list, venue_param};
use crate::market_source::{Cursor, MarketFeature, MarketSource, Priority, SourceError};
use crate::quotes::{effective_book_venue, effective_venue};

pub const DEFAULT_TRADE_LIMIT: usize = 200;
pub const MAX_TRADE_LIMIT: usize = 500;
const MAX_PAGES: usize = 30;
const MAX_PAST_PROGRAM_DAYS: usize = 5;

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

fn require(st: &AppState, lookup: Lookup, feature: MarketFeature) -> Result<(), ApiFailure> {
    st.source.requires(feature).map_err(|e| lookup.failure(e, st.clock.now()))
}

async fn order_book(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::OrderBook>, ApiFailure> {
    let requested = venue_param(&q)?.unwrap_or(Venue::Combined);
    let stock = listed_stock(&st, &code).await?;
    let nxt_enabled = symbol_list(&st).await?.get(Symbol::Stock(stock)).map(|info| info.nxt_enabled);
    let venue = effective_book_venue(requested, nxt_enabled);
    require(&st, Lookup::OrderBook, MarketFeature::OrderBook)?;
    let book = st.source.order_book(stock, venue, Priority::Screen).await.map_err(|e| Lookup::OrderBook.failure(e.into(), st.clock.now()))?;
    Ok(Json(api::OrderBook {
        symbol: symbol_code(stock),
        asks: book.asks,
        bids: book.bids,
        total_ask_quantity: book.total_ask_quantity,
        total_bid_quantity: book.total_bid_quantity,
        after_hours_ask_quantity: book.after_hours_ask_quantity,
        after_hours_bid_quantity: book.after_hours_bid_quantity,
        book_time: book.book_time,
        expected: book.expected,
    }))
}

async fn trades(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::TradeTape>, ApiFailure> {
    let requested = venue_param(&q)?.unwrap_or(Venue::Combined);
    let limit = match q.get("limit") {
        None => DEFAULT_TRADE_LIMIT,
        Some(s) => s.parse::<usize>().ok().filter(|n| (1..=MAX_TRADE_LIMIT).contains(n)).ok_or_else(|| ApiFailure::bad_request(format!("limit은 1~{MAX_TRADE_LIMIT}입니다: {s}")))?,
    };
    let max_pages = match q.get("pages") {
        None => MAX_PAGES,
        Some(s) => s.parse::<usize>().ok().filter(|n| (1..=MAX_PAGES).contains(n)).ok_or_else(|| ApiFailure::bad_request(format!("pages는 1~{MAX_PAGES}입니다: {s}")))?,
    };
    let stock = listed_stock(&st, &code).await?;
    let nxt_enabled = symbol_list(&st).await?.get(Symbol::Stock(stock)).is_some_and(|info| info.nxt_enabled);
    let venue = effective_venue(requested, nxt_enabled);
    require(&st, Lookup::Trades, MarketFeature::Trades)?;
    let (trades, skipped_rows) = walk_trades(st.source.as_ref(), stock, venue, limit, max_pages).await.map_err(|e| Lookup::Trades.failure(e, st.clock.now()))?;
    Ok(Json(api::TradeTape { symbol: symbol_code(stock), venue: venue.into(), trades, skipped_rows }))
}

async fn program_trades(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::ProgramTradeTimeline>, ApiFailure> {
    let Symbol::Stock(stock) = Symbol::parse(&code).map_err(|e| ApiFailure::bad_request(e.to_string()))? else {
        return Err(ApiFailure::bad_request("지수에는 호가·체결·프로그램매매 자료가 없습니다"));
    };
    let now = st.clock.now();
    let today = now.kst_date();
    let today_str = today.yyyymmdd();
    if let Err(err) = listed_stock(&st, &code).await {
        let listed = st.symbols.updates().borrow().as_ref().is_none_or(|dir| dir.get(Symbol::Stock(stock)).is_some());
        if listed && let Some((resolved_date, points)) = collected_program_fallback(&st, stock, today, &today_str, now).await {
            let date = (resolved_date != today_str).then_some(resolved_date);
            return Ok(Json(api::ProgramTradeTimeline { symbol: symbol_code(stock), points, skipped_rows: 0, date }));
        }
        return Err(err);
    }
    if let Err(source_error) = require(&st, Lookup::ProgramTrades, MarketFeature::ProgramTrades) {
        if let Some((resolved_date, points)) = collected_program_fallback(&st, stock, today, &today_str, now).await {
            let date = (resolved_date != today_str).then_some(resolved_date);
            return Ok(Json(api::ProgramTradeTimeline { symbol: symbol_code(stock), points, skipped_rows: 0, date }));
        }
        return Err(source_error);
    }
    let (points, skipped_rows) = match walk_program_trades(st.source.as_ref(), stock, today).await {
        Ok(result) => result,
        Err(SourceError::Failed(failure)) if failure.reason == api::ApiErrorReason::NotConnected => {
            if let Some((resolved_date, fallback_points)) = collected_program_fallback(&st, stock, today, &today_str, now).await {
                let date = (resolved_date != today_str).then_some(resolved_date);
                return Ok(Json(api::ProgramTradeTimeline {
                    symbol: symbol_code(stock),
                    points: fallback_points,
                    skipped_rows: 0,
                    date,
                }));
            }
            return Err(Lookup::ProgramTrades.failure(SourceError::Failed(failure).into(), st.clock.now()));
        }
        Err(err) => return Err(Lookup::ProgramTrades.failure(err.into(), st.clock.now())),
    };
    if !points.is_empty() {
        return Ok(Json(api::ProgramTradeTimeline { symbol: symbol_code(stock), points, skipped_rows, date: None }));
    }
    if let Some((resolved_date, fallback_points)) = collected_program_fallback(&st, stock, today, &today_str, now).await {
        let date = (resolved_date != today_str).then_some(resolved_date);
        return Ok(Json(api::ProgramTradeTimeline {
            symbol: symbol_code(stock),
            points: fallback_points,
            skipped_rows,
            date,
        }));
    }
    if st.source.supports_past_program_trades()
        && let Some((resolved_date, fallback_points, fallback_skipped)) = past_program_trades_fallback(st.source.as_ref(), stock, today).await
    {
        return Ok(Json(api::ProgramTradeTimeline {
            symbol: symbol_code(stock),
            points: fallback_points,
            skipped_rows: fallback_skipped,
            date: Some(resolved_date),
        }));
    }
    Ok(Json(api::ProgramTradeTimeline { symbol: symbol_code(stock), points, skipped_rows, date: None }))
}

async fn walk_program_trades(
    source: &dyn MarketSource,
    stock: StockCode,
    date: KstDate,
) -> Result<(Vec<api::ProgramTradePoint>, u32), SourceError> {
    let (mut points, mut skipped_rows) = (Vec::new(), 0);
    let mut seen_keys = HashSet::new();
    let mut cont: Option<Cursor> = None;
    for _ in 0..MAX_PAGES {
        let priority = if cont.is_none() { Priority::Screen } else { Priority::ScreenBulk };
        let page = source.program_trades_page(stock, date, cont.clone(), priority).await?;
        points.extend(page.rows);
        skipped_rows += page.skipped;
        match page.next {
            Some(next) if seen_keys.insert(next.clone()) => cont = Some(next),
            Some(_) => {
                tracing::warn!(feature = MarketFeature::ProgramTrades.label(), code = stock.as_str(), "연속조회 키가 되풀이돼 여기서 멈춥니다");
                break;
            }
            None => break,
        }
    }
    Ok((points, skipped_rows))
}

async fn past_program_trades_fallback(
    source: &dyn MarketSource,
    stock: StockCode,
    today: KstDate,
) -> Option<(String, Vec<api::ProgramTradePoint>, u32)> {
    let mut candidate = today;
    let mut checked = 0usize;
    while checked < MAX_PAST_PROGRAM_DAYS {
        candidate = candidate.add_days(-1);
        if matches!(candidate.weekday(), Weekday::Sat | Weekday::Sun) {
            continue;
        }
        checked += 1;
        match walk_program_trades(source, stock, candidate).await {
            Ok((points, skipped)) if !points.is_empty() => return Some((candidate.yyyymmdd(), points, skipped)),
            Ok(_) => {}
            Err(reason) => {
                tracing::warn!(
                    code = stock.as_str(),
                    date = %candidate.yyyymmdd(),
                    reason = %reason,
                    "직전 거래일 프로그램매매 REST 폴백을 읽지 못했습니다"
                );
                break;
            }
        }
    }
    None
}

async fn collected_program_fallback(
    st: &AppState,
    stock: StockCode,
    today: KstDate,
    today_str: &str,
    now: KstTime,
) -> Option<(String, Vec<api::ProgramTradePoint>)> {
    let paths = st.collector_paths.snapshot();
    match st.collected.program_day_or_latest(paths, stock, today, today_str, now).await {
        Ok((resolved_date, slice)) if slice.source != api::BrokerDaySource::None && !slice.snapshots.is_empty() => {
            let points = slice.snapshots.into_iter().map(collected_program_point).collect();
            Some((resolved_date, points))
        }
        Ok(_) => None,
        Err(reason) => {
            tracing::warn!(code = stock.as_str(), reason = %reason, "수집 프로그램매매 폴백을 읽지 못했습니다");
            None
        }
    }
}

fn collected_program_point(row: CollectedProgramRow) -> api::ProgramTradePoint {
    let secs = row.hhmmss.secs();
    let hour = secs / 3600;
    let minute = (secs % 3600) / 60;
    let second = secs % 60;
    api::ProgramTradePoint {
        time: format!("{hour:02}:{minute:02}:{second:02}"),
        price: row.price_won,
        buy_quantity: row.buy_qty,
        sell_quantity: row.sell_qty,
        net_quantity: row.net_buy_qty,
        buy_amount: (row.buy_amount_million_won as i64).saturating_mul(1_000_000),
        sell_amount: (row.sell_amount_million_won as i64).saturating_mul(1_000_000),
        net_amount: row.net_buy_amount_million_won.saturating_mul(1_000_000),
    }
}

async fn walk_trades(source: &dyn MarketSource, code: StockCode, venue: Venue, limit: usize, max_pages: usize) -> Result<(Vec<api::TradePrint>, u32), BarError> {
    let (mut trades, mut skipped) = (Vec::new(), 0);
    let mut seen_keys = HashSet::new();
    let mut cont: Option<Cursor> = None;
    for _ in 0..max_pages {
        let priority = if cont.is_none() { Priority::Screen } else { Priority::ScreenBulk };
        let page = source.trades_page(code, venue, cont.clone(), priority).await?;
        trades.extend(page.rows);
        skipped += page.skipped;
        if trades.len() >= limit {
            break;
        }
        match page.next {
            Some(next) if seen_keys.insert(next.clone()) => cont = Some(next),
            Some(_) => {
                tracing::warn!(feature = MarketFeature::Trades.label(), code = code.as_str(), "연속조회 키가 되풀이돼 여기서 멈춥니다");
                break;
            }
            None => break,
        }
    }
    trades.truncate(limit);
    Ok((trades, skipped))
}
