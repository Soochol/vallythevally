
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

use crate::api::{self, ApiErrorCode, Layout, LayoutInput, LayoutSummary, Revision, Screen, Screens, UiState, UnixSeconds, Watchlists};
use crate::http::{ApiFailure, AppState, symbol_list};
use crate::userdata::{self, StoreError, wire_name};

pub const JSON_LIMIT: usize = 64 * 1024;
pub const LAYOUT_LIMIT: usize = 4 * JSON_LIMIT + 16 * 1024;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/watchlists", get(get_watchlists).put(put_watchlists))
        .route("/api/screens", get(get_screens).put(put_screens))
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
    ApiFailure::new(ApiErrorCode::PayloadTooLarge, format!("{what}는 {}KB를 넘을 수 없습니다", limit / 1024))
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

pub const MAX_WATCHLISTS: usize = 20;
pub const MAX_WATCHLIST_NAME_CHARS: usize = 20;
const MAX_WATCHLIST_ID_BYTES: usize = 64;
const LONGEST_WATCHLIST_WRAPPER_BYTES: usize = r#"{"id":"","name":"","symbols":[]},"#.len() + MAX_WATCHLIST_ID_BYTES + 4 * MAX_WATCHLIST_NAME_CHARS;
pub const WATCHLISTS_LIMIT: usize = JSON_LIMIT + MAX_WATCHLISTS * LONGEST_WATCHLIST_WRAPPER_BYTES;

async fn get_watchlists(State(st): State<Arc<AppState>>) -> Result<Json<Watchlists>, ApiFailure> {
    Ok(Json(userdata::get_watchlists(&st.db).await?))
}

async fn put_watchlists(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<Watchlists>, ApiFailure> {
    let all: Watchlists = read_json(body, WATCHLISTS_LIMIT, "관심종목 본문").await?;
    check_watchlists(&all)?;
    userdata::put_watchlists(&st.db, &all).await?;
    Ok(Json(all))
}

/// 종목 목록에 없는 코드도 받는다. 상장폐지된 종목이 목록에서 사라져도 관심종목은 남아야 한다.
fn check_watchlists(all: &Watchlists) -> Result<(), ApiFailure> {
    if all.lists.is_empty() || all.lists.len() > MAX_WATCHLISTS {
        return Err(ApiFailure::bad_request(format!("관심종목 목록은 1~{MAX_WATCHLISTS}개여야 합니다: {}개", all.lists.len())));
    }
    let (mut ids, mut names) = (HashSet::new(), HashSet::new());
    for list in &all.lists {
        if list.id.is_empty() || list.id.len() > MAX_WATCHLIST_ID_BYTES || !ids.insert(list.id.as_str()) {
            return Err(ApiFailure::bad_request(format!("관심종목 목록 id가 비었거나 길거나 겹칩니다: {}", list.id)));
        }
        let name = list.name.trim();
        if name.is_empty() || name != list.name || name.chars().count() > MAX_WATCHLIST_NAME_CHARS {
            return Err(ApiFailure::bad_request(format!("관심종목 목록 이름은 앞뒤 공백 없이 1~{MAX_WATCHLIST_NAME_CHARS}자여야 합니다: {:?}", list.name)));
        }
        if !names.insert(name) {
            return Err(ApiFailure::bad_request(format!("같은 이름의 관심종목 목록이 두 개 있습니다: {name}")));
        }
        let mut seen = HashSet::new();
        for code in &list.symbols {
            if !seen.insert(parse_symbol(&code.0)?) {
                return Err(ApiFailure::bad_request(format!("관심종목 목록 {name}에 같은 종목이 두 번 있습니다: {}", code.0)));
            }
        }
    }
    Ok(())
}

const MAX_SCREENS: usize = 50;
const MAX_SCREEN_NAME_CHARS: usize = 40;
const MAX_SCREEN_CONDITIONS: usize = 10;
const MAX_SCREEN_ID_BYTES: usize = 64;

async fn get_screens(State(st): State<Arc<AppState>>) -> Result<Json<Screens>, ApiFailure> {
    Ok(Json(userdata::get_screens(&st.db).await?))
}

async fn put_screens(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<Screens>, ApiFailure> {
    let all: Screens = read_json(body, JSON_LIMIT, "조건식 본문").await?;
    check_screens(&all)?;
    userdata::put_screens(&st.db, &all).await?;
    Ok(Json(all))
}

fn check_screens(all: &Screens) -> Result<(), ApiFailure> {
    if all.screens.len() > MAX_SCREENS {
        return Err(ApiFailure::bad_request(format!("조건식은 {MAX_SCREENS}개까지 저장할 수 있습니다: {}개", all.screens.len())));
    }
    let mut ids = HashSet::new();
    for screen in &all.screens {
        check_screen(screen)?;
        if !ids.insert(screen.id.as_str()) {
            return Err(ApiFailure::bad_request(format!("조건식 id가 겹칩니다: {}", screen.id)));
        }
    }
    Ok(())
}

pub(crate) fn check_screen(screen: &Screen) -> Result<(), ApiFailure> {
    if screen.id.is_empty() || screen.id.len() > MAX_SCREEN_ID_BYTES {
        return Err(ApiFailure::bad_request(format!("조건식 id는 1~{MAX_SCREEN_ID_BYTES}바이트여야 합니다: {}", screen.id)));
    }
    let name = &screen.name;
    if !(1..=MAX_SCREEN_NAME_CHARS).contains(&name.trim().chars().count()) {
        return Err(ApiFailure::bad_request(format!("조건식 이름은 공백을 빼고 1~{MAX_SCREEN_NAME_CHARS}자여야 합니다: {name:?}")));
    }
    if !(1..=MAX_SCREEN_CONDITIONS).contains(&screen.conditions.len()) {
        return Err(ApiFailure::bad_request(format!("조건식 {name}의 조건은 1~{MAX_SCREEN_CONDITIONS}줄이어야 합니다: {}줄", screen.conditions.len())));
    }
    if let Some(c) = screen.conditions.iter().find(|c| !(1..=c.n).contains(&c.m)) {
        return Err(ApiFailure::bad_request(format!("조건식 {name}의 조건은 1 ≤ m ≤ n이어야 합니다: n={}, m={}", c.n, c.m)));
    }
    let mut kinds = HashSet::new();
    if let Some(kind) = screen.exclude.iter().find(|k| !kinds.insert(**k)) {
        return Err(ApiFailure::bad_request(format!("조건식 {name}의 제외 목록에 {}가 두 번 있습니다", wire_name(kind))));
    }
    Ok(())
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
