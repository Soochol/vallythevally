use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use domain::{KstDate, StockCode, Symbol};

use crate::api;
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, symbol_list};
use crate::market_overview::overview_source;
use crate::market_source::{DayRange, Priority};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/symbols/{code}/foreign-holdings", get(foreign_holdings))
        .route("/api/symbols/{code}/investor-net-shares", get(investor_net_shares))
}

async fn foreign_holdings(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::DayHistory<api::ForeignHoldingDay>>, ApiFailure> {
    let (stock, range) = history_query(&st, &code, &q).await?;
    let history = overview_source(&st).foreign_holdings(stock, range, st.clock.now(), Priority::Background).await;
    Ok(Json(history.map_err(|e| Lookup::ForeignHoldings.failure(BarError::from(e), st.clock.now()))?))
}

async fn investor_net_shares(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::DayHistory<api::InvestorNetSharesDay>>, ApiFailure> {
    let (stock, range) = history_query(&st, &code, &q).await?;
    let history = overview_source(&st).stock_investors(stock, range, st.clock.now(), Priority::Background).await;
    Ok(Json(history.map_err(|e| Lookup::InvestorNetShares.failure(BarError::from(e), st.clock.now()))?))
}

async fn history_query(st: &AppState, code: &str, q: &HashMap<String, String>) -> Result<(StockCode, DayRange), ApiFailure> {
    let Symbol::Stock(stock) = Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? else {
        return Err(ApiFailure::bad_request("지수에는 투자자별 자료가 없습니다"));
    };
    let day = |k: &str| -> Result<KstDate, ApiFailure> {
        let text = q.get(k).ok_or_else(|| ApiFailure::bad_request(format!("{k}가 없습니다")))?;
        Ok(text.parse::<api::KstDate>().map_err(|e| ApiFailure::bad_request(format!("{k}: {e}")))?.0)
    };
    let (from, to) = (day("from")?, day("to")?);
    let range = DayRange::new(from, to).ok_or_else(|| ApiFailure::bad_request(format!("from({from})이 to({to})보다 늦습니다")))?;
    if symbol_list(st).await?.get(Symbol::Stock(stock)).is_none() {
        return Err(ApiFailure::new(api::ApiErrorCode::UnknownSymbol, format!("없는 종목입니다: {code}")));
    }
    Ok((stock, range))
}
