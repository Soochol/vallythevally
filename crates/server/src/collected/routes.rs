use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use domain::{KstDate, StockCode, Symbol};

use crate::api;
use crate::http::{ApiFailure, AppState};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/symbols/{code}/brokers/days", get(broker_days))
        .route("/api/symbols/{code}/brokers", get(broker_day))
}

fn parse_stock(code: &str) -> Result<StockCode, ApiFailure> {
    match Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? {
        Symbol::Stock(stock) => Ok(stock),
        Symbol::Index(_) => Err(ApiFailure::bad_request("지수에는 수집 거래원 자료가 없습니다")),
    }
}

fn symbol_code(stock: StockCode) -> api::SymbolCode {
    api::SymbolCode(Symbol::Stock(stock).as_wire())
}

async fn broker_days(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::BrokerDays>, ApiFailure> {
    let stock = parse_stock(&code)?;
    let days = st
        .collected
        .broker_days(stock, st.clock.now())
        .await
        .map_err(|e| internal_error("수집 거래원 날짜 목록을 읽지 못했습니다", e))?;
    Ok(Json(api::BrokerDays { symbol: symbol_code(stock), days }))
}

async fn broker_day(
    State(st): State<Arc<AppState>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<api::BrokerDay>, ApiFailure> {
    let stock = parse_stock(&code)?;
    let date_str = q
        .get("date")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiFailure::bad_request("date 쿼리(YYYYMMDD)가 필요합니다"))?;
    let date = KstDate::parse_yyyymmdd(date_str).ok_or_else(|| ApiFailure::bad_request(format!("date는 YYYYMMDD 형식입니다: {date_str}")))?;
    let after = q.get("after").map(String::as_str);
    let slice = st
        .collected
        .broker_day(stock, date, date_str, after, st.clock.now())
        .await
        .map_err(|e| internal_error("수집 거래원 자료를 읽지 못했습니다", e))?;
    Ok(Json(api::BrokerDay {
        symbol: symbol_code(stock),
        date: date_str.to_owned(),
        source: slice.source,
        snapshots: slice.snapshots,
        gaps: slice.gaps,
        live: slice.live,
        cursor: slice.cursor,
        reset: slice.reset,
    }))
}

fn internal_error(context: &str, detail: String) -> ApiFailure {
    tracing::error!(reason = %detail, "{context}");
    ApiFailure::new(api::ApiErrorCode::Internal, context)
}
