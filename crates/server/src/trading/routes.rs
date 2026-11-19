use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::middleware::{self, Next};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::response::Json;
use axum::routing::{get, post};
use domain::StockCode;

use crate::api::{self, OrderSide};
use crate::http::{ApiFailure, AppState};

const BODY_LIMIT: usize = 1024;
pub const ORDER_HEADER: &str = "x-vally-order";

async fn require_order_header(req: Request, next: Next) -> Response {
    if req.method() != axum::http::Method::GET && req.headers().get(ORDER_HEADER).and_then(|v| v.to_str().ok()) != Some("1") {
        tracing::warn!(path = req.uri().path(), "주문 쓰기 요청에 X-Vally-Order 헤더가 없어 거절했습니다");
        return ApiFailure::bad_request("이 요청은 받지 않습니다: X-Vally-Order: 1 헤더가 없습니다").into_response();
    }
    next.run(req).await
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    let commands = Router::new()
        .route("/api/trading/commands", get(commands))
        .route("/api/trading/commands/{id}", get(command))
        .route("/api/trading/commands/place", post(place))
        .route("/api/trading/commands/modify", post(modify))
        .route("/api/trading/commands/cancel", post(cancel))
        .route("/api/trading/commands/cancel-batch", post(cancel_batch))
        .route("/api/trading/commands/reconcile", post(reconcile))
        .layer(middleware::from_fn(require_order_header));
    Router::new()
        .merge(commands)
        .route("/api/system/orders", get(status).put(switch))
        .route("/api/system/orders/check-account", post(check_account))
        .route("/api/trading/account-number", get(account_number))
        .route("/api/trading/balance", get(balance))
        .route("/api/trading/open-orders", get(open_orders))
        .route("/api/trading/orderable", get(orderable))
        .route("/api/trading/executions", get(executions))
        .layer(middleware::from_fn_with_state(state, crate::write_guard::guard_writes))
}

async fn status(State(st): State<Arc<AppState>>) -> Json<api::OrdersStatus> {
    Json(st.trading.status())
}

async fn switch(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrdersStatus>, ApiFailure> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))?;
    let input: api::OrdersSwitchInput = serde_json::from_slice(&bytes).map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))?;
    tracing::info!(enabled = input.enabled, "주문 사용 스위치를 바꾸라는 요청을 받았습니다");
    st.trading.set_enabled(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn check_account(State(st): State<Arc<AppState>>) -> Result<Json<api::OrdersAccountCheck>, ApiFailure> {
    tracing::info!("주문 사용을 켜기 전에 계좌를 확인하라는 요청을 받았습니다");
    st.trading.check_account().await.map(Json).map_err(ApiFailure::trading)
}

async fn account_number(State(st): State<Arc<AppState>>, request: Request) -> Result<Response, ApiFailure> {
    crate::write_guard::check_host(&st, request.headers(), request.uri())?;
    let number = st.trading.confirmed_account_number().await.map_err(ApiFailure::trading)?;
    let mut response = Json(number).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn balance(State(st): State<Arc<AppState>>) -> Result<Json<api::TradingBalance>, ApiFailure> {
    st.trading.balance().await.map(Json).map_err(ApiFailure::trading)
}

async fn open_orders(State(st): State<Arc<AppState>>) -> Result<Json<api::TradingOpenOrders>, ApiFailure> {
    st.trading.open_orders().await.map(Json).map_err(ApiFailure::trading)
}

async fn orderable(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::TradingOrderable>, ApiFailure> {
    let required = |k: &str| q.get(k).ok_or_else(|| ApiFailure::bad_request(format!("{k}가 없습니다")));
    let code = StockCode::parse(required("code")?).map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    let side = match required("side")?.as_str() {
        "buy" => OrderSide::Buy,
        "sell" => OrderSide::Sell,
        _ => return Err(ApiFailure::bad_request("side는 buy 또는 sell이어야 합니다")),
    };
    let price = required("price")?.parse::<u64>().map_err(|_| ApiFailure::bad_request("price는 양의 정수여야 합니다"))?;
    st.trading.orderable(code, side, price).await.map(Json).map_err(ApiFailure::trading)
}

async fn executions(State(st): State<Arc<AppState>>) -> Result<Json<api::TradingExecutions>, ApiFailure> {
    st.trading.executions().await.map(Json).map_err(ApiFailure::trading)
}

async fn read_json<T: serde::de::DeserializeOwned>(body: Body) -> Result<T, ApiFailure> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))
}

async fn place(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommand>, ApiFailure> {
    let input: api::OrderPlaceInput = read_json(body).await?;
    tracing::info!(side = ?input.side, "신규 주문 요청을 받았습니다");
    st.trading.place(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn modify(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommand>, ApiFailure> {
    let input: api::OrderModifyInput = read_json(body).await?;
    tracing::info!("정정 요청을 받았습니다");
    st.trading.modify(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn cancel(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommand>, ApiFailure> {
    let input: api::OrderCancelInput = read_json(body).await?;
    tracing::info!("취소 요청을 받았습니다");
    st.trading.cancel(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn cancel_batch(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommands>, ApiFailure> {
    let input: api::OrderCancelBatchInput = read_json(body).await?;
    tracing::info!("가격별 일괄 취소 요청을 받았습니다");
    st.trading.cancel_batch(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn reconcile(State(st): State<Arc<AppState>>) -> Result<Json<api::OrderReconciliation>, ApiFailure> {
    tracing::info!("결과 불명 명령을 조회로 대조하라는 요청을 받았습니다");
    st.trading.reconcile().await.map(Json).map_err(ApiFailure::trading)
}

async fn commands(State(st): State<Arc<AppState>>) -> Result<Json<api::OrderCommands>, ApiFailure> {
    st.trading.commands().await.map(Json).map_err(ApiFailure::trading)
}

async fn command(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<api::OrderCommand>, ApiFailure> {
    st.trading.command(&id).await.map(Json).map_err(ApiFailure::trading)
}
