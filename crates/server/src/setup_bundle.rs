use std::collections::HashSet;
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

use crate::api::{ApiErrorCode, Layout, LayoutInput, Revision, Screens, UiState, UnixSeconds, Watchlists};
use crate::db::AppDb;
use crate::drawing_api::{Drawing, DrawingInput, DrawingScope};
use crate::drawings::{self, DrawingError};
use crate::http::{ApiFailure, AppState};
use crate::setup_documents::{check_drawing, check_layout_input, check_nxt_traded, check_screens, check_watchlists};
use crate::user_routes::read_json;
use crate::sync_log::{self, Direction};
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
        Setup::read_in(&mut tx).await
    }

    async fn read_in(tx: &mut sqlx::SqliteConnection) -> Result<Setup, StoreError> {
        let watchlists = userdata::get_watchlists_in(tx).await?;
        let screens = userdata::get_screens_in(tx).await?;
        let ui_state = userdata::get_ui_state_in(tx).await?;
        let ui_state_revision = Revision(ui_state.0.get("revision").and_then(Value::as_i64).expect("저장된 화면 상태에는 revision이 있다"));
        let mut layouts = Vec::new();
        for summary in userdata::list_layouts_in(tx).await? {
            layouts.push(userdata::get_layout_in(tx, &summary.id).await?);
        }
        let drawings = drawings::list_all_drawings_in(tx).await?;
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

const RETIRED_WINDOW_KIND: &str = "objects";

fn without_retired_windows(document: &Document) -> Document {
    let mut document = document.clone();
    if let Some(Value::Object(fields)) = &mut document.body
        && let Some(Value::Array(windows)) = fields.get_mut("windows")
    {
        windows.retain(|window| window.get("kind").and_then(Value::as_str) != Some(RETIRED_WINDOW_KIND));
    }
    document
}

struct Checked {
    setup: Setup,
    nxt: Vec<Symbol>,
}

enum Parsed {
    Watchlists(Watchlists),
    Screens(Screens),
    UiState(UiState, Revision),
    Layout(Layout, Vec<Symbol>),
    Drawing(Drawing),
}

fn parse_document(document: &Document) -> Result<Parsed, ApiFailure> {
    match document.kind {
        DocumentKind::Watchlists => {
            let watchlists: Watchlists = typed(document)?;
            check_watchlists(&watchlists).map_err(|e| refused(document, e.reason()))?;
            Ok(Parsed::Watchlists(watchlists))
        }
        DocumentKind::Screens => {
            let screens: Screens = typed(document)?;
            check_screens(&screens).map_err(|e| refused(document, e.reason()))?;
            Ok(Parsed::Screens(screens))
        }
        DocumentKind::UiState => {
            let Some(Value::Object(fields)) = &document.body else {
                return Err(refused(document, "본문은 JSON 객체여야 합니다"));
            };
            Ok(Parsed::UiState(UiState(fields.clone()), Revision(document.revision)))
        }
        DocumentKind::Layout => {
            let layout: Layout = typed(&without_retired_windows(document))?;
            let input = layout_input(&layout);
            let nxt = check_layout_input(&document.id, &input).map_err(|e| refused(document, e.reason()))?;
            Ok(Parsed::Layout(layout, nxt))
        }
        DocumentKind::Drawing => {
            let drawing: Drawing = typed(document)?;
            check_drawing(&document.id, &drawing_input(&drawing)).map_err(|e| refused(document, e.reason()))?;
            Ok(Parsed::Drawing(drawing))
        }
    }
}

fn layout_input(layout: &Layout) -> LayoutInput {
    LayoutInput { id: layout.id.clone(), name: layout.name.clone(), sync: layout.sync, windows: layout.windows.clone(), placement: layout.placement.clone(), revision: layout.revision }
}

fn check_bundle(bundle: &Bundle) -> Result<Checked, ApiFailure> {
    bundle.check().map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    if let Some(deleted) = bundle.documents.iter().find(|d| d.deleted) {
        return Err(refused(deleted, "삭제 문서는 아직 가져오지 않습니다"));
    }
    let mut watchlists = None;
    let mut screens = None;
    let mut ui_state = None;
    let mut layouts = Vec::new();
    let mut nxt = Vec::new();
    let mut drawings = Vec::new();
    for document in &bundle.documents {
        match parse_document(document)? {
            Parsed::Watchlists(parsed) => watchlists = Some(parsed),
            Parsed::Screens(parsed) => screens = Some(parsed),
            Parsed::UiState(state, revision) => ui_state = Some((state, revision)),
            Parsed::Layout(layout, symbols) => {
                nxt.extend(symbols);
                layouts.push(layout);
            }
            Parsed::Drawing(drawing) => drawings.push(drawing),
        }
    }
    let watchlists = watchlists.ok_or_else(|| ApiFailure::bad_request(format!("묶음에 {} 문서가 없습니다", DocumentKind::Watchlists.wire_name())))?;
    let screens = screens.ok_or_else(|| ApiFailure::bad_request(format!("묶음에 {} 문서가 없습니다", DocumentKind::Screens.wire_name())))?;
    let (ui_state, ui_state_revision) = ui_state.ok_or_else(|| ApiFailure::bad_request(format!("묶음에 {} 문서가 없습니다", DocumentKind::UiState.wire_name())))?;
    if layouts.is_empty() {
        return Err(ApiFailure::bad_request("묶음에 layout 문서가 하나도 없습니다"));
    }
    Ok(Checked { setup: Setup { watchlists, screens, ui_state, ui_state_revision, layouts, drawings }, nxt })
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

async fn replace_all(db: &AppDb, setup: &Setup, now: UnixSeconds) -> Result<(), ApiFailure> {
    let internal = |e: sqlx::Error| ApiFailure::from(StoreError::from(e));
    let mut tx = db.begin_write().await.map_err(internal)?;
    let newest_known: Option<i64> = sqlx::query_scalar("SELECT MAX(revision) FROM sync_documents").fetch_one(&mut *tx).await.map_err(internal)?;
    replace_all_in(&mut tx, setup, now).await?;
    let owned: Option<i64> = sqlx::query_scalar("SELECT 1 FROM local_owner WHERE singleton = 1").fetch_optional(&mut *tx).await.map_err(internal)?;
    if owned.is_some() {
        sync_log::raise_revisions(&mut tx, now.millis().max(newest_known.map_or(0, |newest| newest + 1))).await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(())
}

async fn replace_all_in(tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>, setup: &Setup, now: UnixSeconds) -> Result<(), ApiFailure> {
    let internal = |e: sqlx::Error| ApiFailure::from(StoreError::from(e));
    let kept_drawings: HashSet<&str> = setup.drawings.iter().map(|d| d.id.as_str()).collect();
    let kept_layouts: HashSet<&str> = setup.layouts.iter().map(|l| l.id.as_str()).collect();
    let removed_drawings: Vec<String> = sqlx::query_scalar("SELECT id FROM drawings").fetch_all(&mut **tx).await.map_err(internal)?.into_iter().filter(|id: &String| !kept_drawings.contains(id.as_str())).collect();
    let removed_layouts: Vec<String> = sqlx::query_scalar("SELECT id FROM layouts").fetch_all(&mut **tx).await.map_err(internal)?.into_iter().filter(|id: &String| !kept_layouts.contains(id.as_str())).collect();
    for id in &removed_drawings {
        sync_log::deleted(tx, DocumentKind::Drawing, id, now.millis()).await.map_err(internal)?;
    }
    for id in &removed_layouts {
        sync_log::deleted(tx, DocumentKind::Layout, id, now.millis()).await.map_err(internal)?;
    }
    sqlx::query("DELETE FROM drawings").execute(&mut **tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM layouts").execute(&mut **tx).await.map_err(internal)?;
    userdata::store_watchlists(tx, &setup.watchlists).await.map_err(|e| store_failure(DocumentKind::Watchlists, SINGLETON_ID, e))?;
    userdata::store_screens(tx, &setup.screens).await.map_err(|e| store_failure(DocumentKind::Screens, SINGLETON_ID, e))?;
    userdata::store_ui_state(tx, &setup.ui_state, setup.ui_state_revision).await.map_err(|e| store_failure(DocumentKind::UiState, SINGLETON_ID, e))?;
    for layout in &setup.layouts {
        userdata::store_layout(tx, &layout_input(layout), layout.updated_at).await.map_err(|e| store_failure(DocumentKind::Layout, &layout.id, e))?;
    }
    for drawing in &setup.drawings {
        drawings::store_drawing(tx, &drawing_input(drawing), drawing.updated_at).await.map_err(|e| store_failure(DocumentKind::Drawing, &drawing.id, e))?;
    }
    Ok(())
}

pub(crate) async fn reset_to_default(db: &AppDb, owner: &str) -> Result<(), ApiFailure> {
    let internal = |e: sqlx::Error| ApiFailure::from(StoreError::from(e));
    let scratch = tempfile::tempdir().map_err(|e| ApiFailure::new(ApiErrorCode::Internal, format!("기본 셋업을 만들 임시 폴더를 만들지 못했습니다: {e}")))?;
    let fresh = AppDb::open(&scratch.path().join("default.db")).await.map_err(|e| ApiFailure::new(ApiErrorCode::Internal, format!("기본 셋업을 만들지 못했습니다: {e}")))?;
    let defaults = Setup::read(&fresh).await?;
    let mut tx = db.begin_write().await.map_err(internal)?;
    replace_all_in(&mut tx, &defaults, UnixSeconds(0)).await?;
    sync_log::forget_account(&mut tx).await.map_err(internal)?;
    sync_log::set_initial_done(&mut tx).await.map_err(internal)?;
    crate::account::owner::set_in(&mut tx, owner).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(())
}

async fn import(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<Value>, ApiFailure> {
    let bundle: Bundle = read_json(body, BUNDLE_LIMIT, "셋업 묶음").await?;
    let Checked { setup, nxt } = check_bundle(&bundle)?;
    check_nxt_traded(&st, &nxt).await??;
    replace_all(&st.db, &setup, UnixSeconds(st.clock.now().unix())).await?;
    tracing::info!(documents = bundle.documents.len(), "셋업 묶음을 가져왔습니다");
    Ok(Json(json!({ "documents": bundle.documents.len() })))
}

pub(crate) async fn live_documents_in(conn: &mut sqlx::SqliteConnection) -> Result<Vec<Document>, StoreError> {
    Ok(Setup::read_in(conn).await?.into_bundle().documents)
}

pub(crate) async fn is_default(db: &AppDb) -> Result<bool, ApiFailure> {
    let scratch = tempfile::tempdir().map_err(|e| ApiFailure::new(ApiErrorCode::Internal, format!("기본 셋업을 비교할 임시 폴더를 만들지 못했습니다: {e}")))?;
    let fresh = AppDb::open(&scratch.path().join("default.db")).await.map_err(|e| ApiFailure::new(ApiErrorCode::Internal, format!("기본 셋업을 만들지 못했습니다: {e}")))?;
    let defaults = Setup::read(&fresh).await?.into_bundle();
    let mut conn = db.read().acquire().await.map_err(|e| ApiFailure::from(StoreError::from(e)))?;
    let local = Setup::read_in(&mut conn).await?.into_bundle();
    let tombstones = sync_log::tombstone_count(&mut conn).await.map_err(|e| ApiFailure::from(StoreError::from(e)))?;
    Ok(local == defaults && tombstones == 0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Received {
    Applied,
    Discarded,
    Refused(String),
}

fn application_order(document: &Document) -> u8 {
    match (document.kind, document.deleted) {
        (DocumentKind::Layout, false) => 0,
        (DocumentKind::Layout, true) => 2,
        _ => 1,
    }
}

pub(crate) fn in_application_order(documents: &mut [Document]) {
    documents.sort_by_key(application_order);
}

pub(crate) fn in_push_order(documents: &mut [Document]) {
    documents.sort_by_key(|document| match (document.kind, document.deleted) {
        (DocumentKind::Layout, false) => 0,
        (DocumentKind::Drawing, true) => 2,
        (DocumentKind::Layout, true) => 3,
        _ => 1,
    });
}

async fn widened_drawing(tx: &mut sqlx::SqliteConnection, drawing: &Drawing) -> Result<Option<DrawingInput>, StoreError> {
    let DrawingScope::Cell { layout_id, .. } = &drawing.scope else { return Ok(None) };
    let layout: Option<i64> = sqlx::query_scalar("SELECT 1 FROM layouts WHERE id = ?").bind(layout_id).fetch_optional(&mut *tx).await?;
    Ok(layout.map(|_| DrawingInput { scope: DrawingScope::Layout { layout_id: layout_id.clone() }, ..drawing_input(drawing) }))
}

enum Outcome {
    Applied,
    Refused(String),
}

async fn apply_in(tx: &mut sqlx::Transaction<'static, sqlx::Sqlite>, document: &Document, parsed: Option<Parsed>) -> Result<Outcome, StoreError> {
    let refuse = |why: String| Ok(Outcome::Refused(why));
    match parsed {
        None => match document.kind {
            DocumentKind::Layout => {
                let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM layouts WHERE id = ?").bind(&document.id).fetch_optional(&mut **tx).await?;
                if exists.is_some() {
                    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layouts").fetch_one(&mut **tx).await?;
                    if count <= 1 {
                        return refuse("마지막 레이아웃은 지울 수 없습니다".into());
                    }
                    if let Err(e) = sqlx::query("DELETE FROM layouts WHERE id = ?").bind(&document.id).execute(&mut **tx).await {
                        return refuse(format!("레이아웃을 지우지 못했습니다: {e}"));
                    }
                }
            }
            DocumentKind::Drawing => {
                sqlx::query("DELETE FROM drawings WHERE id = ?").bind(&document.id).execute(&mut **tx).await?;
            }
            kind => return refuse(format!("{} 문서는 지울 수 없습니다", kind.wire_name())),
        },
        Some(Parsed::Watchlists(watchlists)) => userdata::store_watchlists(tx, &watchlists).await?,
        Some(Parsed::Screens(screens)) => userdata::store_screens(tx, &screens).await?,
        Some(Parsed::UiState(state, revision)) => userdata::store_ui_state(tx, &state, revision).await?,
        Some(Parsed::Layout(layout, _)) => match userdata::store_layout(tx, &layout_input(&layout), layout.updated_at).await {
            Ok(()) => {}
            Err(StoreError::Conflict(why)) => return refuse(why),
            Err(other) => return Err(other),
        },
        Some(Parsed::Drawing(drawing)) => {
            let first = drawings::store_drawing(tx, &drawing_input(&drawing), drawing.updated_at).await;
            let stored = match first {
                Err(DrawingError::MissingScope(why)) => match widened_drawing(tx, &drawing).await? {
                    Some(widened) => drawings::store_drawing(tx, &widened, drawing.updated_at).await,
                    None => Err(DrawingError::MissingScope(why)),
                },
                other => other,
            };
            match stored {
                Ok(()) => {}
                Err(DrawingError::MissingScope(why)) => return refuse(why),
                Err(DrawingError::Store(other)) => return Err(other),
            }
        }
    }
    sync_log::received(tx, document).await?;
    Ok(Outcome::Applied)
}

pub(crate) async fn apply_received(st: &AppState, document: &Document, over_equal: bool) -> Result<Received, StoreError> {
    if let Err(e) = document.check() {
        return finish_refused(&st.db, document, e.to_string(), over_equal).await;
    }
    let parsed = if document.deleted {
        None
    } else {
        match parse_document(document) {
            Ok(parsed) => Some(parsed),
            Err(e) => return finish_refused(&st.db, document, e.message().to_owned(), over_equal).await,
        }
    };
    if let Some(Parsed::Layout(_, nxt)) = &parsed
        && let Ok(Err(refusal)) = check_nxt_traded(st, nxt).await
    {
        return finish_refused(&st.db, document, refusal.reason(), over_equal).await;
    }
    let mut tx = st.db.begin_write().await?;
    let known = sync_log::recorded_revision(&mut tx, document.kind, &document.id).await?;
    if known.is_some_and(|known| superseded(document.revision, known, over_equal)) {
        return Ok(Received::Discarded);
    }
    match apply_in(&mut tx, document, parsed).await? {
        Outcome::Applied => {
            tx.commit().await?;
            Ok(Received::Applied)
        }
        Outcome::Refused(why) => {
            drop(tx);
            finish_refused(&st.db, document, why, over_equal).await
        }
    }
}

fn superseded(received: i64, known: i64, over_equal: bool) -> bool {
    received < known || (received == known && !over_equal)
}

async fn finish_refused(db: &AppDb, document: &Document, why: String, over_equal: bool) -> Result<Received, StoreError> {
    let mut tx = db.begin_write().await?;
    let known = sync_log::recorded_revision(&mut tx, document.kind, &document.id).await?;
    if known.is_some_and(|known| superseded(document.revision, known, over_equal)) {
        return Ok(Received::Discarded);
    }
    sync_log::refuse(&mut tx, document.kind, &document.id, document.revision, Direction::Pull, &why).await?;
    tx.commit().await?;
    Ok(Received::Refused(why))
}
