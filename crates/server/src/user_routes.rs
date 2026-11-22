
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::get;
use domain::Symbol;
use serde::de::DeserializeOwned;
use setup::{HEATMAP_THEMES_LIMIT, JSON_LIMIT, LAYOUT_LIMIT, SCREENS_LIMIT, WATCHLISTS_LIMIT};

use crate::api::{ApiErrorCode, HeatmapThemes, Layout, LayoutInput, LayoutSummary, Revision, Screens, UiState, UnixSeconds, Watchlists};
use crate::http::{ApiFailure, AppState};
use crate::setup_documents::{check_heatmap_themes, check_layout_input, check_nxt_traded, check_screens, check_watchlists, too_large_text};
use crate::userdata::{self, StoreError};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/watchlists", get(get_watchlists).put(put_watchlists))
        .route("/api/screens", get(get_screens).put(put_screens))
        .route("/api/heatmap/themes", get(get_heatmap_themes).put(put_heatmap_themes))
        .route("/api/layouts", get(list_layouts))
        .route("/api/layouts/{id}", get(get_layout).put(put_layout).delete(delete_layout))
        .route("/api/ui-state", get(get_ui_state).put(put_ui_state))
}

impl From<StoreError> for ApiFailure {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => ApiFailure::new(ApiErrorCode::NotFound, "없는 레이아웃입니다"),
            StoreError::Conflict(m) => ApiFailure::new(ApiErrorCode::Conflict, m),
            StoreError::Stale(stored) => {
                ApiFailure::new(ApiErrorCode::StaleRevision, format!("더 새 편집(revision {})이 이미 저장돼 있습니다", stored.0))
            }
            StoreError::Db(e) => {
                tracing::error!(error = %e, "사용자 자료 DB 오류");
                ApiFailure::new(ApiErrorCode::Internal, "사용자 자료를 읽거나 쓰지 못했습니다")
            }
        }
    }
}

fn too_large(what: &str, limit: usize) -> ApiFailure {
    ApiFailure::new(ApiErrorCode::PayloadTooLarge, too_large_text(what, limit))
}

/// axum 기본 본문 한도(2MB)는 우리 오류 본문이 아닌 응답을 낸다. 그래서 `Body`를 직접 받아 한도까지만 읽는다.
/// 읽다 실패하는 경우는 한도 초과뿐이다(연결이 끊기면 응답을 받을 쪽도 없다).
pub(crate) async fn read_json<T: DeserializeOwned>(body: Body, limit: usize, what: &str) -> Result<T, ApiFailure> {
    let bytes: Bytes = axum::body::to_bytes(body, limit).await.map_err(|_| too_large(what, limit))?;
    serde_json::from_slice(&bytes).map_err(|e| ApiFailure::bad_request(format!("{what}의 JSON이 틀렸습니다: {e}")))
}

pub(crate) fn parse_symbol(code: &str) -> Result<Symbol, ApiFailure> {
    Symbol::parse(code).map_err(|e| ApiFailure::bad_request(format!("{e}: {code}")))
}

async fn get_heatmap_themes(State(st): State<Arc<AppState>>) -> Result<Json<HeatmapThemes>, ApiFailure> {
    Ok(Json(userdata::get_heatmap_themes(&st.db).await?))
}

async fn put_heatmap_themes(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<HeatmapThemes>, ApiFailure> {
    let all: HeatmapThemes = read_json(body, HEATMAP_THEMES_LIMIT, "테마 본문").await?;
    check_heatmap_themes(&all)?;
    userdata::put_heatmap_themes(&st.db, &all).await?;
    Ok(Json(all))
}

type WatchlistsResponse = ([(&'static str, &'static str); 1], Json<Watchlists>);

async fn get_watchlists(State(st): State<Arc<AppState>>) -> Result<WatchlistsResponse, ApiFailure> {
    Ok(([("x-vally-watchlists-version", "2")], Json(userdata::get_watchlists(&st.db).await?)))
}

async fn put_watchlists(State(st): State<Arc<AppState>>, body: Body) -> Result<WatchlistsResponse, ApiFailure> {
    let all: Watchlists = read_json(body, WATCHLISTS_LIMIT, "관심종목 본문").await?;
    check_watchlists(&all)?;
    userdata::put_watchlists(&st.db, &all).await?;
    Ok(([("x-vally-watchlists-version", "2")], Json(all)))
}

async fn get_screens(State(st): State<Arc<AppState>>) -> Result<Json<Screens>, ApiFailure> {
    Ok(Json(userdata::get_screens(&st.db).await?))
}

async fn put_screens(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<Screens>, ApiFailure> {
    let all: Screens = read_json(body, SCREENS_LIMIT, "조건식 본문").await?;
    check_screens(&all)?;
    userdata::put_screens(&st.db, &all).await?;
    Ok(Json(all))
}

async fn list_layouts(State(st): State<Arc<AppState>>) -> Result<Json<Vec<LayoutSummary>>, ApiFailure> {
    Ok(Json(userdata::list_layouts(&st.db).await?))
}

async fn get_layout(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<Layout>, ApiFailure> {
    Ok(Json(userdata::get_layout(&st.db, &id).await?))
}

async fn put_layout(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<Layout>, ApiFailure> {
    let input: LayoutInput = read_json(body, LAYOUT_LIMIT, "레이아웃 본문").await?;
    let nxt = check_layout_input(&id, &input)?;
    check_nxt_traded(&st, &nxt).await??;
    let now = UnixSeconds(st.clock.now().unix());
    Ok(Json(userdata::put_layout(&st.db, &input, now).await?))
}

async fn delete_layout(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<StatusCode, ApiFailure> {
    let now = UnixSeconds(st.clock.now().unix());
    userdata::delete_layout(&st.db, &id, now).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_ui_state(State(st): State<Arc<AppState>>) -> Result<Json<UiState>, ApiFailure> {
    Ok(Json(userdata::get_ui_state(&st.db).await?))
}

async fn put_ui_state(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<UiState>, ApiFailure> {
    let state: UiState = read_json(body, JSON_LIMIT, "화면 상태 본문").await?;
    let revision = state
        .0
        .get("revision")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| ApiFailure::bad_request("화면 상태에 정수 revision이 있어야 합니다"))?;
    userdata::put_ui_state(&st.db, &state, Revision(revision)).await?;
    Ok(Json(state))
}
