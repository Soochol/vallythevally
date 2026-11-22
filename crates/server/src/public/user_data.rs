use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use account_server::{Removal, SetupDocument, SetupPut};
use axum::Router;
use axum::body::Body;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::get;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use setup::{DocumentKind, HEATMAP_THEMES_LIMIT, JSON_LIMIT, LAYOUT_LIMIT, SCREENS_LIMIT, SINGLETON_ID, WATCHLISTS_LIMIT};

use super::limits::locked;
use super::{Principal, Runtime};
use crate::api::{ApiErrorCode, HeatmapThemes, Layout, LayoutInput, LayoutSummary, Screens, UiState, UnixSeconds, Watchlists};
use crate::db::AppDb;
use crate::drawing_api::{Drawing, DrawingInput, DrawingScope};
use crate::http::ApiFailure;
use crate::setup_documents::{check_drawing, check_heatmap_themes, check_layout_input, check_nxt_traded, check_screens, check_watchlists};
use crate::user_routes::{parse_symbol, read_json};
use crate::userdata;

const WATCHLISTS_VERSION: [(&str, &str); 1] = [("x-vally-watchlists-version", "2")];

pub(crate) struct Setup {
    defaults: Defaults,
    seeded: Mutex<HashSet<String>>,
}

struct Defaults {
    watchlists: Watchlists,
    screens: Screens,
    ui_state: UiState,
    heatmap_themes: HeatmapThemes,
    layout: Layout,
}

impl Setup {
    pub async fn load() -> Result<Setup, String> {
        let dir = tempfile::tempdir().map_err(|e| format!("기본 셋업을 만들 폴더를 못 만듭니다: {e}"))?;
        let db = AppDb::open(&dir.path().join("defaults.db")).await.map_err(|e| format!("기본 셋업 DB를 못 엽니다: {e}"))?;
        let reading = |e: userdata::StoreError| format!("기본 셋업을 읽지 못했습니다: {e:?}");
        let first_layout = userdata::list_layouts(&db).await.map_err(reading)?.into_iter().next().ok_or("기본 레이아웃이 없습니다")?;
        let defaults = Defaults {
            watchlists: userdata::get_watchlists(&db).await.map_err(reading)?,
            screens: userdata::get_screens(&db).await.map_err(reading)?,
            ui_state: userdata::get_ui_state(&db).await.map_err(reading)?,
            heatmap_themes: userdata::get_heatmap_themes(&db).await.map_err(reading)?,
            layout: userdata::get_layout(&db, &first_layout.id).await.map_err(reading)?,
        };
        Ok(Setup { defaults, seeded: Mutex::new(HashSet::new()) })
    }
}

pub(super) fn routes() -> Router<Arc<Runtime>> {
    Router::new()
        .route("/api/watchlists", get(get_watchlists).put(put_watchlists))
        .route("/api/screens", get(get_screens).put(put_screens))
        .route("/api/heatmap/themes", get(get_heatmap_themes).put(put_heatmap_themes))
        .route("/api/ui-state", get(get_ui_state).put(put_ui_state))
        .route("/api/layouts", get(list_layouts))
        .route("/api/layouts/{id}", get(get_layout).put(put_layout).delete(delete_layout))
        .route("/api/drawings", get(list_drawings))
        .route("/api/drawings/{id}", axum::routing::put(put_drawing).delete(delete_drawing))
}

fn database_failure(e: sqlx::Error) -> ApiFailure {
    tracing::error!(error = %e, "공개 셋업 저장소 오류");
    ApiFailure::new(ApiErrorCode::Internal, "사용자 자료를 읽거나 쓰지 못했습니다")
}

fn unreadable(what: &str, e: impl std::fmt::Display) -> ApiFailure {
    tracing::error!(error = %e, what, "저장된 셋업 문서를 읽지 못했습니다");
    ApiFailure::new(ApiErrorCode::Internal, "사용자 자료를 읽거나 쓰지 못했습니다")
}

fn stale(stored: i64) -> ApiFailure {
    ApiFailure::new(ApiErrorCode::StaleRevision, format!("더 새 편집(revision {stored})이 이미 저장돼 있습니다"))
}

fn typed<T: DeserializeOwned>(document: &SetupDocument) -> Result<T, ApiFailure> {
    let Some(Value::Object(mut fields)) = document.body_value() else { return Err(unreadable("본문", "JSON 객체가 아닙니다")) };
    fields.insert("revision".into(), document.revision.into());
    serde_json::from_value(Value::Object(fields)).map_err(|e| unreadable(document.kind.wire_name(), e))
}

fn document_of(kind: DocumentKind, id: &str, revision: i64, value: &impl Serialize) -> SetupDocument {
    let mut body = serde_json::to_value(value).expect("셋업 자료는 언제나 직렬화된다");
    if let Value::Object(fields) = &mut body {
        fields.remove("revision");
    }
    SetupDocument::live(kind, id, revision, &body)
}

async fn live_document(runtime: &Runtime, account: &str, kind: DocumentKind, id: &str) -> Result<Option<SetupDocument>, ApiFailure> {
    Ok(runtime.accounts.setup_document(account, kind, id).await.map_err(database_failure)?.filter(|document| !document.deleted))
}

async fn save(runtime: &Runtime, account: &str, document: &SetupDocument) -> Result<(), ApiFailure> {
    match runtime.accounts.setup_put(account, document).await.map_err(database_failure)? {
        SetupPut::Saved => Ok(()),
        SetupPut::Stale(stored) => Err(stale(stored.revision)),
        SetupPut::AccountFull(reason) => Err(ApiFailure::new(ApiErrorCode::PayloadTooLarge, reason)),
        SetupPut::Invalid(reason) => Err(ApiFailure::bad_request(reason)),
        SetupPut::AccountGone => Err(ApiFailure::new(ApiErrorCode::SignedOut, "로그인이 필요합니다")),
    }
}

async fn read_singleton<T: DeserializeOwned + Clone>(runtime: &Runtime, account: &str, kind: DocumentKind, default: &T) -> Result<T, ApiFailure> {
    match live_document(runtime, account, kind, SINGLETON_ID).await? {
        Some(document) => typed(&document),
        None => Ok(default.clone()),
    }
}

async fn save_singleton<T: Serialize + DeserializeOwned>(runtime: &Runtime, account: &str, kind: DocumentKind, value: &T, revision: i64) -> Result<(), ApiFailure> {
    if revision <= 0 && live_document(runtime, account, kind, SINGLETON_ID).await?.is_none() {
        return Err(stale(0));
    }
    save(runtime, account, &document_of(kind, SINGLETON_ID, revision, value)).await
}

pub(crate) async fn heatmap_themes_of(runtime: &Runtime, account: &str) -> Result<HeatmapThemes, ApiFailure> {
    read_singleton(runtime, account, DocumentKind::HeatmapThemes, &runtime.setup.defaults.heatmap_themes).await
}

async fn get_heatmap_themes(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>) -> Result<Json<HeatmapThemes>, ApiFailure> {
    Ok(Json(heatmap_themes_of(&runtime, &who.account_id).await?))
}

async fn put_heatmap_themes(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, body: Body) -> Result<Json<HeatmapThemes>, ApiFailure> {
    let all: HeatmapThemes = read_json(body, HEATMAP_THEMES_LIMIT, "테마 본문").await?;
    check_heatmap_themes(&all)?;
    save_singleton(&runtime, &who.account_id, DocumentKind::HeatmapThemes, &all, all.revision.0).await?;
    Ok(Json(all))
}

type WatchlistsResponse = ([(&'static str, &'static str); 1], Json<Watchlists>);

async fn get_watchlists(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>) -> Result<WatchlistsResponse, ApiFailure> {
    Ok((WATCHLISTS_VERSION, Json(read_singleton(&runtime, &who.account_id, DocumentKind::Watchlists, &runtime.setup.defaults.watchlists).await?)))
}

async fn put_watchlists(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, body: Body) -> Result<WatchlistsResponse, ApiFailure> {
    let all: Watchlists = read_json(body, WATCHLISTS_LIMIT, "관심종목 본문").await?;
    check_watchlists(&all)?;
    save_singleton(&runtime, &who.account_id, DocumentKind::Watchlists, &all, all.revision.0).await?;
    Ok((WATCHLISTS_VERSION, Json(all)))
}

async fn get_screens(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>) -> Result<Json<Screens>, ApiFailure> {
    Ok(Json(read_singleton(&runtime, &who.account_id, DocumentKind::Screens, &runtime.setup.defaults.screens).await?))
}

async fn put_screens(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, body: Body) -> Result<Json<Screens>, ApiFailure> {
    let all: Screens = read_json(body, SCREENS_LIMIT, "조건식 본문").await?;
    check_screens(&all)?;
    save_singleton(&runtime, &who.account_id, DocumentKind::Screens, &all, all.revision.0).await?;
    Ok(Json(all))
}

async fn get_ui_state(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>) -> Result<Json<UiState>, ApiFailure> {
    Ok(Json(read_singleton(&runtime, &who.account_id, DocumentKind::UiState, &runtime.setup.defaults.ui_state).await?))
}

async fn put_ui_state(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, body: Body) -> Result<Json<UiState>, ApiFailure> {
    let state: UiState = read_json(body, JSON_LIMIT, "화면 상태 본문").await?;
    let revision = state.0.get("revision").and_then(Value::as_i64).ok_or_else(|| ApiFailure::bad_request("화면 상태에 정수 revision이 있어야 합니다"))?;
    save_singleton(&runtime, &who.account_id, DocumentKind::UiState, &state, revision).await?;
    Ok(Json(state))
}

async fn ensure_default_layout(runtime: &Runtime, account: &str) -> Result<(), ApiFailure> {
    if locked(&runtime.setup.seeded).contains(account) {
        return Ok(());
    }
    let layout = &runtime.setup.defaults.layout;
    let document = document_of(DocumentKind::Layout, &layout.id, layout.revision.0, layout);
    match runtime.accounts.setup_put(account, &document).await.map_err(database_failure)? {
        SetupPut::Saved | SetupPut::Stale(_) => {
            locked(&runtime.setup.seeded).insert(account.to_owned());
        }
        SetupPut::AccountFull(_) | SetupPut::Invalid(_) | SetupPut::AccountGone => {}
    }
    Ok(())
}

fn no_such_layout() -> ApiFailure {
    ApiFailure::new(ApiErrorCode::NotFound, "없는 레이아웃입니다")
}

async fn list_layouts(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>) -> Result<Json<Vec<LayoutSummary>>, ApiFailure> {
    ensure_default_layout(&runtime, &who.account_id).await?;
    let heads = runtime.accounts.setup_layout_heads(&who.account_id).await.map_err(database_failure)?;
    Ok(Json(heads.into_iter().map(|head| LayoutSummary { id: head.id, name: head.name, updated_at: UnixSeconds(head.updated_at) }).collect()))
}

async fn get_layout(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<Json<Layout>, ApiFailure> {
    ensure_default_layout(&runtime, &who.account_id).await?;
    let document = live_document(&runtime, &who.account_id, DocumentKind::Layout, &id).await?.ok_or_else(no_such_layout)?;
    Ok(Json(typed(&document)?))
}

async fn put_layout(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Path(id): Path<String>, body: Body) -> Result<Json<Layout>, ApiFailure> {
    let input: LayoutInput = read_json(body, LAYOUT_LIMIT, "레이아웃 본문").await?;
    let nxt = check_layout_input(&id, &input)?;
    check_nxt_traded(&runtime.state, &nxt).await??;
    ensure_default_layout(&runtime, &who.account_id).await?;
    if runtime.accounts.setup_layout_name_taken(&who.account_id, &input.name, &input.id).await.map_err(database_failure)? {
        return Err(ApiFailure::new(ApiErrorCode::Conflict, format!("같은 이름의 레이아웃이 이미 있습니다: {}", input.name)));
    }
    let layout = Layout {
        id: input.id.clone(),
        name: input.name.clone(),
        sync: input.sync,
        windows: input.windows.clone(),
        placement: input.placement.clone(),
        updated_at: UnixSeconds(runtime.state.clock.now().unix()),
        revision: input.revision,
    };
    save(&runtime, &who.account_id, &document_of(DocumentKind::Layout, &layout.id, layout.revision.0, &layout)).await?;
    Ok(Json(layout))
}

async fn delete_layout(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<StatusCode, ApiFailure> {
    ensure_default_layout(&runtime, &who.account_id).await?;
    let floor = runtime.state.clock.now().unix() * 1000;
    match runtime.accounts.setup_remove(&who.account_id, DocumentKind::Layout, &id, floor).await.map_err(database_failure)? {
        Removal::Removed => Ok(StatusCode::NO_CONTENT),
        Removal::Missing => Err(no_such_layout()),
        Removal::LastLayout => Err(ApiFailure::new(ApiErrorCode::Conflict, "마지막 레이아웃은 지울 수 없습니다")),
    }
}

#[derive(Deserialize)]
struct SymbolQuery {
    symbol: Option<String>,
}

async fn list_drawings(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Query(q): Query<SymbolQuery>) -> Result<Json<Vec<Drawing>>, ApiFailure> {
    let code = q.symbol.ok_or_else(|| ApiFailure::bad_request("symbol이 필요합니다"))?;
    parse_symbol(&code)?;
    let documents = runtime.accounts.setup_drawings_of(&who.account_id, &code).await.map_err(database_failure)?;
    Ok(Json(documents.iter().map(typed).collect::<Result<_, _>>()?))
}

async fn check_drawing_scope(runtime: &Runtime, account: &str, scope: &DrawingScope) -> Result<(), ApiFailure> {
    let (layout_id, window_id) = match scope {
        DrawingScope::Symbol => return Ok(()),
        DrawingScope::Layout { layout_id } => (layout_id, None),
        DrawingScope::Cell { layout_id, window_id } => (layout_id, Some(window_id)),
    };
    ensure_default_layout(runtime, account).await?;
    let layout: Option<Layout> = match live_document(runtime, account, DocumentKind::Layout, layout_id).await? {
        Some(document) => Some(typed(&document)?),
        None => None,
    };
    match (layout, window_id) {
        (None, _) => Err(ApiFailure::bad_request(format!("드로잉 범위의 레이아웃이 없습니다: {layout_id}"))),
        (Some(_), None) => Ok(()),
        (Some(layout), Some(window_id)) if layout.windows.iter().any(|w| &w.id == window_id && w.content.is_chart()) => Ok(()),
        (Some(_), Some(window_id)) => Err(ApiFailure::bad_request(format!("드로잉 범위의 차트 창이 없습니다: 레이아웃 {layout_id}, 창 {}", window_id.as_str()))),
    }
}

async fn put_drawing(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Path(id): Path<String>, body: Body) -> Result<Json<Drawing>, ApiFailure> {
    let input: DrawingInput = read_json(body, JSON_LIMIT, "드로잉 본문").await?;
    check_drawing(&id, &input)?;
    check_drawing_scope(&runtime, &who.account_id, &input.scope).await?;
    let drawing = input.saved_at(UnixSeconds(runtime.state.clock.now().unix()));
    save(&runtime, &who.account_id, &document_of(DocumentKind::Drawing, &drawing.id, drawing.revision.0, &drawing)).await?;
    Ok(Json(drawing))
}

async fn delete_drawing(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<StatusCode, ApiFailure> {
    let floor = runtime.state.clock.now().unix() * 1000;
    runtime.accounts.setup_remove(&who.account_id, DocumentKind::Drawing, &id, floor).await.map_err(database_failure)?;
    Ok(StatusCode::NO_CONTENT)
}
