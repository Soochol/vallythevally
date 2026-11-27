use std::collections::HashMap;
use std::sync::Arc;

use axum::{Extension, Router};
use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::middleware::{self, Next};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::response::Json;
use axum::routing::{get, post, put};
use domain::{KstDate, StockCode};

use super::forensics::{ForensicsCache, ForensicsInputs, compute_forensics};
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
        .route("/api/system/orders/margin", get(margin_policy).put(set_margin_policy))
        .route("/api/system/orders/check-account", post(check_account))
        .route("/api/trading/account-number", get(account_number))
        .route("/api/trading/balance", get(balance))
        .route("/api/trading/open-orders", get(open_orders))
        .route("/api/trading/orderable", get(orderable))
        .route("/api/trading/executions", get(executions))
        .route("/api/trading/executions/forensics", get(execution_forensics))
        .route("/api/trading/auto-orders", get(auto_orders_list).post(auto_orders_create))
        .route("/api/trading/auto-orders/master", put(auto_orders_master))
        .route("/api/trading/auto-orders/{id}", put(auto_orders_update).delete(auto_orders_delete))
        .layer(Extension(ForensicsCache::new()))
        .layer(middleware::from_fn_with_state(state, crate::write_guard::guard_writes))
}

fn account_of(query: &HashMap<String, String>) -> Option<&str> {
    query.get("account").map(String::as_str)
}

async fn status(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::OrdersStatus>, ApiFailure> {
    st.accounts.status(account_of(&q)).map(Json).map_err(ApiFailure::trading)
}

async fn switch(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrdersStatus>, ApiFailure> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))?;
    let input: api::OrdersSwitchInput = serde_json::from_slice(&bytes).map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))?;
    tracing::info!(enabled = input.enabled, "주문 사용 스위치를 바꾸라는 요청을 받았습니다");
    st.accounts.set_enabled(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn margin_policy(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::OrdersMargin>, ApiFailure> {
    st.accounts.margin_policy(account_of(&q)).map(Json).map_err(ApiFailure::trading)
}

async fn set_margin_policy(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrdersMargin>, ApiFailure> {
    let input: api::OrdersMarginInput = read_json(body).await?;
    tracing::info!(policy = ?input.policy, "주문 미수 정책을 바꾸라는 요청을 받았습니다");
    st.accounts.set_margin_policy(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn check_account(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::OrdersAccountCheck>, ApiFailure> {
    tracing::info!("주문 사용을 켜기 전에 계좌를 확인하라는 요청을 받았습니다");
    st.accounts.check_account(q.get("keyId").map(String::as_str)).await.map(Json).map_err(ApiFailure::trading)
}

async fn account_number(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>, request: Request) -> Result<Response, ApiFailure> {
    crate::write_guard::check_host(&st, request.headers(), request.uri())?;
    let number = st.accounts.confirmed_account_number(account_of(&q)).await.map_err(ApiFailure::trading)?;
    let mut response = Json(number).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn balance(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::TradingBalance>, ApiFailure> {
    st.accounts.balance(account_of(&q)).await.map(Json).map_err(ApiFailure::trading)
}

async fn open_orders(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::TradingOpenOrders>, ApiFailure> {
    st.accounts.open_orders(account_of(&q)).await.map(Json).map_err(ApiFailure::trading)
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
    st.accounts.orderable(account_of(&q), code, side, price).await.map(Json).map_err(ApiFailure::trading)
}

async fn executions(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::TradingExecutions>, ApiFailure> {
    st.accounts.executions(account_of(&q)).await.map(Json).map_err(ApiFailure::trading)
}

async fn execution_forensics(
    State(st): State<Arc<AppState>>,
    Extension(cache): Extension<Arc<ForensicsCache>>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<api::ExecutionForensics>, ApiFailure> {
    let now = st.clock.now();
    let (date, date_str) = match q.get("date").map(String::as_str).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let parsed = KstDate::parse_yyyymmdd(raw).ok_or_else(|| ApiFailure::bad_request(format!("date는 YYYYMMDD 형식입니다: {raw}")))?;
            (parsed, raw.to_owned())
        }
        None => {
            let today = now.kst_date();
            (today, format!("{:04}{:02}{:02}", today.year(), today.month(), today.day()))
        }
    };
    let account = account_of(&q);
    let fills = st.accounts.executions(account).await.map_err(ApiFailure::trading)?;
    let result = compute_forensics(ForensicsInputs {
        collected: &st.collected,
        micro_events: &st.micro_events,
        db: &st.db,
        symbols: &st.symbols,
        cache: &cache,
        paths: st.collector_paths.snapshot(),
        date,
        date_str: &date_str,
        account_query: account,
        executions: &fills,
        now,
    })
    .await
    .map_err(|detail| {
        tracing::error!(reason = %detail, "체결 해부를 계산하지 못했습니다");
        ApiFailure::new(api::ApiErrorCode::Internal, "체결 해부를 계산하지 못했습니다")
    })?;
    Ok(Json(result))
}

async fn read_json<T: serde::de::DeserializeOwned>(body: Body) -> Result<T, ApiFailure> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiFailure::bad_request("본문 형식이 올바르지 않습니다"))
}

async fn place(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommand>, ApiFailure> {
    let input: api::OrderPlaceInput = read_json(body).await?;
    tracing::info!(side = ?input.side, "신규 주문 요청을 받았습니다");
    st.accounts.place(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn modify(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommand>, ApiFailure> {
    let input: api::OrderModifyInput = read_json(body).await?;
    tracing::info!("정정 요청을 받았습니다");
    st.accounts.modify(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn cancel(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommand>, ApiFailure> {
    let input: api::OrderCancelInput = read_json(body).await?;
    tracing::info!("취소 요청을 받았습니다");
    st.accounts.cancel(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn cancel_batch(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::OrderCommands>, ApiFailure> {
    let input: api::OrderCancelBatchInput = read_json(body).await?;
    tracing::info!("가격별 일괄 취소 요청을 받았습니다");
    st.accounts.cancel_batch(input).await.map(Json).map_err(ApiFailure::trading)
}

async fn reconcile(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::OrderReconciliation>, ApiFailure> {
    tracing::info!("결과 불명 명령을 조회로 대조하라는 요청을 받았습니다");
    st.accounts.reconcile(account_of(&q)).await.map(Json).map_err(ApiFailure::trading)
}

async fn commands(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::OrderCommands>, ApiFailure> {
    st.accounts.commands(account_of(&q)).await.map(Json).map_err(ApiFailure::trading)
}

async fn command(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<api::OrderCommand>, ApiFailure> {
    st.accounts.command(&id).await.map(Json).map_err(ApiFailure::trading)
}

async fn auto_orders_list(State(st): State<Arc<AppState>>) -> Result<Json<api::AutoOrderList>, ApiFailure> {
    st.auto_orders.list().await.map(Json).map_err(ApiFailure::bad_request)
}

async fn auto_orders_create(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::AutoOrderRule>, ApiFailure> {
    let input: api::AutoOrderUpsertInput = read_json(body).await?;
    st.auto_orders.create(input).await.map(Json).map_err(ApiFailure::bad_request)
}

async fn auto_orders_update(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<api::AutoOrderRule>, ApiFailure> {
    let input: api::AutoOrderUpsertInput = read_json(body).await?;
    st.auto_orders.update(&id, input).await.map(Json).map_err(ApiFailure::bad_request)
}

async fn auto_orders_delete(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<axum::http::StatusCode, ApiFailure> {
    st.auto_orders.delete(&id).await.map(|()| axum::http::StatusCode::NO_CONTENT).map_err(ApiFailure::bad_request)
}

async fn auto_orders_master(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::AutoOrderMasterState>, ApiFailure> {
    let input: api::AutoOrderMasterInput = read_json(body).await?;
    st.auto_orders.set_master(input.enabled).await.map(Json).map_err(ApiFailure::bad_request)
}
