use std::sync::Arc;

use axum::{Json, Router, extract::{Path, State}, routing::get};
use domain::{Symbol, SymbolKind};

use crate::{api::ApiErrorCode, http::ApiFailure, symbols::SymbolDirectory};
use super::{Financials, model::{Collection, Snapshot}};

#[derive(Clone)]
struct RouteState { service: Arc<Financials>, symbols: Arc<SymbolDirectory> }

pub fn routes(service: Arc<Financials>, symbols: Arc<SymbolDirectory>) -> Router {
    Router::new().route("/api/symbols/{code}/financial-source", get(open).post(refresh)).method_not_allowed_fallback(|| async { ApiFailure::new(ApiErrorCode::MethodNotAllowed, "지원하지 않는 요청 방식입니다") }).with_state(RouteState { service, symbols })
}

async fn open(State(state): State<RouteState>, Path(code): Path<String>) -> Result<Json<Snapshot>, ApiFailure> {
    snapshot(state, code, false).await.map(Json)
}

async fn refresh(State(state): State<RouteState>, Path(code): Path<String>) -> Result<Json<Snapshot>, ApiFailure> {
    snapshot(state, code, true).await.map(Json)
}

async fn snapshot(state: RouteState, code: String, force: bool) -> Result<Snapshot, ApiFailure> {
    let symbol = Symbol::parse(&code).map_err(|_| ApiFailure::bad_request("종목코드를 확인하세요"))?;
    let directory = state.symbols.updates().borrow().clone().ok_or_else(|| ApiFailure::new(ApiErrorCode::KiwoomUnavailable, "종목 목록을 아직 받지 못했습니다"))?;
    let info = directory.get(symbol).ok_or_else(|| ApiFailure::new(ApiErrorCode::UnknownSymbol, "없는 종목입니다"))?;
    if !matches!(info.kind, SymbolKind::Common | SymbolKind::Preferred) {
        return Ok(Snapshot { status: "unsupported", security: None, collection: Collection::default(), failure: None, reason: Some("unsupported_product") });
    }
    Ok(state.service.open(&code, info.kind == SymbolKind::Preferred, force).await)
}
