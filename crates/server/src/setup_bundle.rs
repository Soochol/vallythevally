use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::middleware;
use axum::response::Json;
use axum::routing::{get, put};
use domain::Symbol;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use setup::{BUNDLE_LIMIT, Bundle, Document, DocumentKind, FORMAT_VERSION, SINGLETON_ID};

use crate::api::{ApiErrorCode, Layout, LayoutInput, Revision, Screens, UiState, Watchlists};
use crate::db::AppDb;
use crate::drawing_api::{Drawing, DrawingInput};
use crate::drawings::{self, DrawingError};
use crate::http::{ApiFailure, AppState};
use crate::user_routes::{check_layout_input, check_nxt_traded, check_screens, check_watchlists, read_json};
use crate::userdata::{self, StoreError};

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/setup/export", get(export))
        .route("/api/setup/import", put(import))
        .layer(middleware::from_fn_with_state(state, crate::write_guard::guard_writes))
}

struct Setup {
    watchlists: Watchlists,
    screens: Screens,
    ui_state: UiState,
    ui_state_revision: Revision,
    layouts: Vec<Layout>,
    drawings: Vec<Drawing>,
}

fn live(kind: DocumentKind, id: &str, revision: Revision, mut body: Value) -> Document {
    if let Value::Object(fields) = &mut body {
        fields.remove("revision");
    }
    Document { kind, id: id.to_owned(), revision: revision.0, deleted: false, body: Some(body) }
}

fn json_of(value: &impl Serialize) -> Value {
    serde_json::to_value(value).expect("셋업 자료는 언제나 직렬화된다")
}

impl Setup {
    async fn read(db: &AppDb) -> Result<Setup, StoreError> {
        let mut tx = db.read().begin().await?;
        let watchlists = userdata::get_watchlists_in(&mut tx).await?;
        let screens = userdata::get_screens_in(&mut tx).await?;
        let ui_state = userdata::get_ui_state_in(&mut tx).await?;
        let ui_state_revision = Revision(ui_state.0.get("revision").and_then(Value::as_i64).expect("저장된 화면 상태에는 revision이 있다"));
        let mut layouts = Vec::new();
        for summary in userdata::list_layouts_in(&mut tx).await? {
            layouts.push(userdata::get_layout_in(&mut tx, &summary.id).await?);
        }
        let drawings = drawings::list_all_drawings_in(&mut tx).await?;
        Ok(Setup { watchlists, screens, ui_state, ui_state_revision, layouts, drawings })
    }

    fn into_bundle(self) -> Bundle {
        let mut documents = vec![
            live(DocumentKind::Watchlists, SINGLETON_ID, self.watchlists.revision, json_of(&self.watchlists)),
            live(DocumentKind::Screens, SINGLETON_ID, self.screens.revision, json_of(&self.screens)),
            live(DocumentKind::UiState, SINGLETON_ID, self.ui_state_revision, json_of(&self.ui_state)),
        ];
        documents.extend(self.layouts.iter().map(|layout| live(DocumentKind::Layout, &layout.id, layout.revision, json_of(layout))));
        documents.extend(self.drawings.iter().map(|drawing| live(DocumentKind::Drawing, &drawing.id, drawing.revision, json_of(drawing))));
        Bundle { version: FORMAT_VERSION, documents }
    }
}

async fn export(State(st): State<Arc<AppState>>) -> Result<Json<Bundle>, ApiFailure> {
    let bundle = Setup::read(&st.db).await?.into_bundle();
    bundle.check().map_err(|e| {
        tracing::error!(error = %e, "내보낼 셋업이 형식에 맞지 않습니다");
        ApiFailure::new(ApiErrorCode::Internal, format!("셋업을 내보내지 못했습니다: {e}"))
    })?;
    Ok(Json(bundle))
}

fn refused(document: &Document, why: impl std::fmt::Display) -> ApiFailure {
    ApiFailure::bad_request(format!("문서 {} {:?}: {why}", document.kind.wire_name(), document.id))
}

fn typed<T: DeserializeOwned>(document: &Document) -> Result<T, ApiFailure> {
    let Some(Value::Object(fields)) = &document.body else {
        return Err(refused(document, "본문은 JSON 객체여야 합니다"));
    };
    let mut fields: Map<String, Value> = fields.clone();
    fields.insert("revision".into(), json!(document.revision));
    serde_json::from_value(Value::Object(fields)).map_err(|e| refused(document, format!("본문의 JSON이 틀렸습니다: {e}")))
}

fn only(bundle: &Bundle, kind: DocumentKind) -> Result<&Document, ApiFailure> {
    bundle.documents.iter().find(|d| d.kind == kind).ok_or_else(|| ApiFailure::bad_request(format!("묶음에 {} 문서가 없습니다", kind.wire_name())))
}

struct Checked {
    setup: Setup,
    nxt: Vec<Symbol>,
}

fn check_bundle(bundle: &Bundle) -> Result<Checked, ApiFailure> {
    bundle.check().map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    if let Some(deleted) = bundle.documents.iter().find(|d| d.deleted) {
        return Err(refused(deleted, "삭제 문서는 아직 가져오지 않습니다"));
    }
    let watchlists_document = only(bundle, DocumentKind::Watchlists)?;
    let watchlists: Watchlists = typed(watchlists_document)?;
    check_watchlists(&watchlists).map_err(|e| refused(watchlists_document, e.message()))?;

    let screens_document = only(bundle, DocumentKind::Screens)?;
    let screens: Screens = typed(screens_document)?;
    check_screens(&screens).map_err(|e| refused(screens_document, e.message()))?;

    let ui_state_document = only(bundle, DocumentKind::UiState)?;
    let Some(Value::Object(fields)) = &ui_state_document.body else {
        return Err(refused(ui_state_document, "본문은 JSON 객체여야 합니다"));
    };
    let ui_state = UiState(fields.clone());

    let mut layouts = Vec::new();
    let mut nxt = Vec::new();
    for document in bundle.documents.iter().filter(|d| d.kind == DocumentKind::Layout) {
        let layout: Layout = typed(document)?;
        let input = LayoutInput { id: layout.id.clone(), name: layout.name.clone(), sync: layout.sync, windows: layout.windows.clone(), placement: layout.placement.clone(), revision: layout.revision };
        nxt.extend(check_layout_input(&document.id, &input).map_err(|e| refused(document, e.message()))?);
        layouts.push(layout);
    }
    if layouts.is_empty() {
        return Err(ApiFailure::bad_request("묶음에 layout 문서가 하나도 없습니다"));
    }

    let mut drawings = Vec::new();
    for document in bundle.documents.iter().filter(|d| d.kind == DocumentKind::Drawing) {
        let drawing: Drawing = typed(document)?;
        drawings::check_drawing(&document.id, &drawing_input(&drawing)).map_err(|e| refused(document, e.message()))?;
        drawings.push(drawing);
    }
    Ok(Checked { setup: Setup { watchlists, screens, ui_state, ui_state_revision: Revision(ui_state_document.revision), layouts, drawings }, nxt })
}

fn drawing_input(d: &Drawing) -> DrawingInput {
    DrawingInput {
        id: d.id.clone(),
        symbol: d.symbol.clone(),
        tool: d.tool,
        points: d.points.clone(),
        text: d.text.clone(),
        style: d.style.clone(),
        locked: d.locked,
        hidden: d.hidden,
        periods: d.periods.clone(),
        z: d.z,
        group: d.group.clone(),
        scope: d.scope.clone(),
        revision: d.revision,
    }
}

fn store_failure(kind: DocumentKind, id: &str, error: impl Into<StoreFault>) -> ApiFailure {
    match error.into() {
        StoreFault::Rejected(why) => ApiFailure::bad_request(format!("문서 {} {id:?}: {why}", kind.wire_name())),
        StoreFault::Failed(e) => e.into(),
    }
}

enum StoreFault {
    Rejected(String),
    Failed(StoreError),
}

impl From<StoreError> for StoreFault {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Conflict(why) => StoreFault::Rejected(why),
            other => StoreFault::Failed(other),
        }
    }
}

impl From<DrawingError> for StoreFault {
    fn from(e: DrawingError) -> Self {
        match e {
            DrawingError::MissingScope(why) => StoreFault::Rejected(why),
            DrawingError::Store(e) => e.into(),
        }
    }
}

async fn replace_all(db: &AppDb, setup: &Setup) -> Result<(), ApiFailure> {
    let internal = |e: sqlx::Error| ApiFailure::from(StoreError::from(e));
    let mut tx = db.begin_write().await.map_err(internal)?;
    sqlx::query("DELETE FROM drawings").execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM layouts").execute(&mut *tx).await.map_err(internal)?;
    userdata::store_watchlists(&mut tx, &setup.watchlists).await.map_err(|e| store_failure(DocumentKind::Watchlists, SINGLETON_ID, e))?;
    userdata::store_screens(&mut tx, &setup.screens).await.map_err(|e| store_failure(DocumentKind::Screens, SINGLETON_ID, e))?;
    userdata::store_ui_state(&mut tx, &setup.ui_state, setup.ui_state_revision).await.map_err(|e| store_failure(DocumentKind::UiState, SINGLETON_ID, e))?;
    for layout in &setup.layouts {
        let input = LayoutInput { id: layout.id.clone(), name: layout.name.clone(), sync: layout.sync, windows: layout.windows.clone(), placement: layout.placement.clone(), revision: layout.revision };
        userdata::store_layout(&mut tx, &input, layout.updated_at).await.map_err(|e| store_failure(DocumentKind::Layout, &layout.id, e))?;
    }
    for drawing in &setup.drawings {
        drawings::store_drawing(&mut tx, &drawing_input(drawing), drawing.updated_at).await.map_err(|e| store_failure(DocumentKind::Drawing, &drawing.id, e))?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(())
}

async fn import(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<Value>, ApiFailure> {
    let bundle: Bundle = read_json(body, BUNDLE_LIMIT, "셋업 묶음").await?;
    let Checked { setup, nxt } = check_bundle(&bundle)?;
    check_nxt_traded(&st, &nxt).await?;
    replace_all(&st.db, &setup).await?;
    tracing::info!(documents = bundle.documents.len(), "셋업 묶음을 가져왔습니다");
    Ok(Json(json!({ "documents": bundle.documents.len() })))
}
