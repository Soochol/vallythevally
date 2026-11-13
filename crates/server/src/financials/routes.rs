use std::sync::Arc;

use axum::{Json, Router, extract::{Path, Query, State}, routing::get};
use domain::{Symbol, SymbolKind};
use serde::Deserialize;

use crate::{api::{ApiErrorCode, FinancialPeriod, FinancialsPage, FinancialUpdatePage}, http::ApiFailure, symbols::SymbolDirectory};
use super::{Financials, company_records::ReadSnapshot, response::FinancialSourceResponse};

#[derive(Clone)]
struct RouteState { service: Arc<Financials>, symbols: Arc<SymbolDirectory> }

pub fn routes(service: Arc<Financials>, symbols: Arc<SymbolDirectory>) -> Router {
    Router::new().route("/api/financial-update", get(update_status).post(start_update)).route("/api/financial-update/pause", axum::routing::post(pause_update)).route("/api/financial-update/resume", axum::routing::post(resume_update)).route("/api/symbols/{code}/financial-source", get(open).post(refresh)).route("/api/symbols/{code}/financials", get(indicators).post(refresh_indicators)).method_not_allowed_fallback(|| async { ApiFailure::new(ApiErrorCode::MethodNotAllowed, "지원하지 않는 요청 방식입니다") }).with_state(RouteState { service, symbols })
}

async fn update_status(State(state): State<RouteState>) -> Json<FinancialUpdatePage> { Json(state.service.update_status().await) }

async fn pause_update(State(state): State<RouteState>) -> Json<FinancialUpdatePage> { Json(state.service.pause_update().await) }
async fn resume_update(State(state): State<RouteState>) -> Json<FinancialUpdatePage> {
    let symbols = state.symbols.updates().borrow().clone().map(|directory| directory.all().cloned().collect()).unwrap_or_default();
    Json(state.service.resume_update(symbols).await)
}

async fn start_update(State(state): State<RouteState>) -> Result<Json<FinancialUpdatePage>, ApiFailure> { start(&state).await.map(Json) }

async fn start(state: &RouteState) -> Result<FinancialUpdatePage, ApiFailure> {
    let directory = state.symbols.updates().borrow().clone().ok_or_else(|| ApiFailure::new(ApiErrorCode::KiwoomUnavailable, "종목 목록을 아직 받지 못했습니다"))?;
    Ok(state.service.start_update(directory.all().cloned().collect()).await)
}

async fn open(State(state): State<RouteState>, Path(code): Path<String>) -> Result<Json<FinancialSourceResponse>, ApiFailure> {
    snapshot(state, code, false).await.map(|snapshot| Json(snapshot.into()))
}

async fn refresh(State(state): State<RouteState>, Path(code): Path<String>) -> Result<Json<FinancialSourceResponse>, ApiFailure> {
    snapshot(state, code, true).await.map(|snapshot| Json(snapshot.into()))
}

async fn snapshot(state: RouteState, code: String, force: bool) -> Result<ReadSnapshot, ApiFailure> {
    let symbol = Symbol::parse(&code).map_err(|_| ApiFailure::bad_request("종목코드를 확인하세요"))?;
    let directory = state.symbols.updates().borrow().clone().ok_or_else(|| ApiFailure::new(ApiErrorCode::KiwoomUnavailable, "종목 목록을 아직 받지 못했습니다"))?;
    let info = directory.get(symbol).ok_or_else(|| ApiFailure::new(ApiErrorCode::UnknownSymbol, "없는 종목입니다"))?;
    if !matches!(info.kind, SymbolKind::Common | SymbolKind::Preferred) {
        return Ok(ReadSnapshot::unsupported_product());
    }
    if force { start(&state).await?; }
    Ok(state.service.read(&code).await)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinancialQuery { period: FinancialPeriod }

async fn indicators(State(state): State<RouteState>, Path(code): Path<String>, query: Result<Query<FinancialQuery>, axum::extract::rejection::QueryRejection>) -> Result<Json<FinancialsPage>, ApiFailure> {
    calculated(state, code, query, false).await
}

async fn refresh_indicators(State(state): State<RouteState>, Path(code): Path<String>, query: Result<Query<FinancialQuery>, axum::extract::rejection::QueryRejection>) -> Result<Json<FinancialsPage>, ApiFailure> {
    calculated(state, code, query, true).await
}

async fn calculated(state: RouteState, code: String, query: Result<Query<FinancialQuery>, axum::extract::rejection::QueryRejection>, force: bool) -> Result<Json<FinancialsPage>, ApiFailure> {
    let Query(query) = query.map_err(|_| ApiFailure::bad_request("재무지표는 Q 또는 Y 보고기간을 선택하세요"))?;
    let source = snapshot(state, code.clone(), force).await?;
    Ok(Json(super::calculate::page(&code, query.period, source)))
}
