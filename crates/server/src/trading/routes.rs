use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::middleware;
use axum::response::Json;
use axum::routing::{get, post};
use domain::StockCode;

use crate::api::{self, OrderSide};
use crate::http::{ApiFailure, AppState};

const BODY_LIMIT: usize = 1024;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/system/orders", get(status).put(switch))
        .route("/api/system/orders/check-account", post(check_account))
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
