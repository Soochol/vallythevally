use std::sync::Arc;

use axum::{Json, Router, extract::{Path, Query, State}, routing::get};
use domain::{Symbol, SymbolKind};
use serde::Deserialize;

use crate::{api::{ApiErrorCode, FinancialPeriod, FinancialsPage}, http::ApiFailure, symbols::SymbolDirectory};
use super::{Financials, company_records::ReadSnapshot, response::FinancialSourceResponse};

#[derive(Clone)]
struct RouteState { service: Arc<Financials>, symbols: Arc<SymbolDirectory> }

pub fn routes(service: Arc<Financials>, symbols: Arc<SymbolDirectory>) -> Router {
    Router::new().route("/api/symbols/{code}/financial-source", get(open)).route("/api/symbols/{code}/financials", get(indicators)).method_not_allowed_fallback(|| async { ApiFailure::new(ApiErrorCode::MethodNotAllowed, "지원하지 않는 요청 방식입니다") }).with_state(RouteState { service, symbols })
}

async fn open(State(state): State<RouteState>, Path(code): Path<String>) -> Result<Json<FinancialSourceResponse>, ApiFailure> {
    snapshot(state, code).await.map(|snapshot| Json(snapshot.into()))
}

async fn snapshot(state: RouteState, code: String) -> Result<ReadSnapshot, ApiFailure> {
    let symbol = Symbol::parse(&code).map_err(|_| ApiFailure::bad_request("종목코드를 확인하세요"))?;
    let directory = state.symbols.updates().borrow().clone().ok_or_else(|| ApiFailure::new(ApiErrorCode::KiwoomUnavailable, "종목 목록을 아직 받지 못했습니다"))?;
    let info = directory.get(symbol).ok_or_else(|| ApiFailure::new(ApiErrorCode::UnknownSymbol, "없는 종목입니다"))?;
    if !matches!(info.kind, SymbolKind::Common | SymbolKind::Preferred) {
        return Ok(ReadSnapshot::unsupported_product());
    }
    Ok(state.service.read(&code).await)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinancialQuery { period: FinancialPeriod }

async fn indicators(State(state): State<RouteState>, Path(code): Path<String>, query: Result<Query<FinancialQuery>, axum::extract::rejection::QueryRejection>) -> Result<Json<FinancialsPage>, ApiFailure> {
    let Query(query) = query.map_err(|_| ApiFailure::bad_request("재무지표는 Q 또는 Y 보고기간을 선택하세요"))?;
    let source = snapshot(state, code.clone()).await?;
    Ok(Json(super::calculate::page(&code, query.period, source)))
}
