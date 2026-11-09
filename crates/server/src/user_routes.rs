//! 관심종목, 레이아웃, 화면 상태 REST(backend.md §8.2). 본문 크기와 모양은 여기서 한 번 검사한다.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::get;
use domain::{Symbol, Venue};
use serde::de::DeserializeOwned;

use crate::api::{self, ApiErrorCode, Layout, LayoutInput, LayoutSummary, UiState, UnixSeconds, Watchlist};
use crate::http::{ApiFailure, AppState, symbol_list};
use crate::userdata::{self, StoreError};

/// 화면 상태, 관심종목 본문, 칸 하나의 `chartSettings`.
pub const JSON_LIMIT: usize = 64 * 1024;
/// 레이아웃 본문: 칸 4개의 `chartSettings`와 나머지 필드.
pub const LAYOUT_LIMIT: usize = 4 * JSON_LIMIT + 16 * 1024;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/watchlist", get(get_watchlist).put(put_watchlist))
        .route("/api/layouts", get(list_layouts))
        .route("/api/layouts/{id}", get(get_layout).put(put_layout).delete(delete_layout))
        .route("/api/ui-state", get(get_ui_state).put(put_ui_state))
}

impl From<StoreError> for ApiFailure {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => ApiFailure::new(ApiErrorCode::NotFound, "없는 레이아웃입니다"),
            StoreError::Conflict(m) => ApiFailure::new(ApiErrorCode::Conflict, m),
            StoreError::Db(e) => {
                tracing::error!(error = %e, "사용자 자료 DB 오류");
                ApiFailure::new(ApiErrorCode::Internal, "사용자 자료를 읽거나 쓰지 못했습니다")
            }
        }
    }
}

fn too_large(what: &str, limit: usize) -> ApiFailure {
    ApiFailure::new(ApiErrorCode::PayloadTooLarge, format!("{what}는 {}KB를 넘을 수 없습니다", limit / 1024))
}

/// axum 기본 본문 한도(2MB)는 우리 오류 본문이 아닌 응답을 낸다. 그래서 `Body`를 직접 받아 한도까지만 읽는다.
/// 읽다 실패하는 경우는 한도 초과뿐이다(연결이 끊기면 응답을 받을 쪽도 없다).
async fn read_json<T: DeserializeOwned>(body: Body, limit: usize, what: &str) -> Result<T, ApiFailure> {
    let bytes: Bytes = axum::body::to_bytes(body, limit).await.map_err(|_| too_large(what, limit))?;
    serde_json::from_slice(&bytes).map_err(|e| ApiFailure::bad_request(format!("{what}의 JSON이 틀렸습니다: {e}")))
}

fn parse_symbol(code: &str) -> Result<Symbol, ApiFailure> {
    Symbol::parse(code).map_err(|e| ApiFailure::bad_request(format!("{e}: {code}")))
}

async fn get_watchlist(State(st): State<Arc<AppState>>) -> Result<Json<Watchlist>, ApiFailure> {
    Ok(Json(userdata::get_watchlist(&st.db).await?))
}

/// 종목 목록에 없는 코드도 받는다. 상장폐지된 종목이 목록에서 사라져도 관심종목은 남아야 한다.
async fn put_watchlist(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<Watchlist>, ApiFailure> {
    let list: Watchlist = read_json(body, JSON_LIMIT, "관심종목 본문").await?;
    let mut seen = HashSet::new();
    for code in &list.symbols {
        if !seen.insert(parse_symbol(&code.0)?) {
            return Err(ApiFailure::bad_request(format!("관심종목에 같은 종목이 두 번 있습니다: {}", code.0)));
        }
    }
    userdata::put_watchlist(&st.db, &list).await?;
    Ok(Json(list))
}

async fn list_layouts(State(st): State<Arc<AppState>>) -> Result<Json<Vec<LayoutSummary>>, ApiFailure> {
    Ok(Json(userdata::list_layouts(&st.db).await?))
}

async fn get_layout(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<Layout>, ApiFailure> {
    Ok(Json(userdata::get_layout(&st.db, &id).await?))
}

async fn put_layout(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<Layout>, ApiFailure> {
    let input: LayoutInput = read_json(body, LAYOUT_LIMIT, "레이아웃 본문").await?;
    if input.cells.iter().any(|c| c.chart_settings.to_string().len() > JSON_LIMIT) {
        return Err(too_large("칸의 chartSettings", JSON_LIMIT));
    }
    let nxt = check_layout(&id, &input)?;
    if !nxt.is_empty() {
        let dir = symbol_list(&st).await?;
        if let Some(info) = nxt.iter().find_map(|s| dir.get(*s).filter(|i| !i.nxt_enabled)) {
            return Err(ApiFailure::bad_request(format!("NXT에서 거래되지 않는 종목입니다: {}({})", info.name, info.symbol.as_wire())));
        }
    }
    let now = UnixSeconds(st.clock.now().unix());
    Ok(Json(userdata::put_layout(&st.db, &input, now).await?))
}

/// 종목 목록 없이 할 수 있는 검사. NXT를 고른 주식 칸의 종목을 돌려준다(종목 목록으로 더 검사한다).
/// 목록에 없는 주식은 막지 않는다. 상장폐지된 종목을 연 칸도 저장되어야 한다.
fn check_layout(path_id: &str, input: &LayoutInput) -> Result<Vec<Symbol>, ApiFailure> {
    if input.id != path_id {
        return Err(ApiFailure::bad_request(format!("주소의 id({path_id})와 본문의 id({})가 다릅니다", input.id)));
    }
    if input.name.trim().is_empty() {
        return Err(ApiFailure::bad_request("레이아웃 이름이 비어 있습니다"));
    }
    let n = input.arrangement.cell_count();
    let slots: HashSet<usize> = input.cells.iter().map(|c| usize::from(c.slot)).collect();
    if input.cells.len() != n || slots != (0..n).collect() {
        return Err(ApiFailure::bad_request(format!("배치 {:?}에는 slot 0부터 {}까지 칸이 하나씩 있어야 합니다", input.arrangement, n - 1)));
    }
    let mut nxt = Vec::new();
    for c in &input.cells {
        let symbol = parse_symbol(&c.symbol.0)?;
        let venue = c.venue.map(|v| match v {
            api::Venue::Combined => Venue::Combined,
            api::Venue::Krx => Venue::Krx,
            api::Venue::Nxt => Venue::Nxt,
        });
        match (symbol, venue) {
            (Symbol::Stock(_), None) => return Err(ApiFailure::bad_request(format!("주식 칸에는 거래소가 있어야 합니다: {}", c.symbol.0))),
            (Symbol::Index(_), Some(_)) => return Err(ApiFailure::bad_request(format!("지수에는 거래소가 없습니다: {}", c.symbol.0))),
            (Symbol::Stock(_), Some(Venue::Nxt)) => nxt.push(symbol),
            _ => {}
        }
    }
    Ok(nxt)
}

async fn delete_layout(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<StatusCode, ApiFailure> {
    userdata::delete_layout(&st.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_ui_state(State(st): State<Arc<AppState>>) -> Result<Json<UiState>, ApiFailure> {
    Ok(Json(userdata::get_ui_state(&st.db).await?))
}

/// 객체인지만 본다. 모르는 키도 그대로 저장한다.
async fn put_ui_state(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<UiState>, ApiFailure> {
    let state: UiState = read_json(body, JSON_LIMIT, "화면 상태 본문").await?;
    userdata::put_ui_state(&st.db, &state).await?;
    Ok(Json(state))
}
