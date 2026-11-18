mod watch;
pub mod wire;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{Method, Uri, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use self::watch::{ASK_TIMEOUT, CONNECT_TIMEOUT, DaemonJudgment, DaemonNotice, HEARTBEAT_EVERY, MAX_LINE_BYTES, MISSED_HEARTBEATS, RECONNECT_BACKOFF};
use self::watch::{Answer, AskFailure, Question, Watcher};
use self::wire::{CollectorCoverage, CollectorDisk, CollectorStatus};
use crate::account::ProviderSubject;
use crate::api::{ApiErrorCode, UnixSeconds};
use crate::http::{ApiFailure, AppState};

pub const SUBJECT_RETRY: Duration = Duration::from_secs(30);

pub struct CollectorBoard {
    admins: Vec<ProviderSubject>,
    socket: PathBuf,
    watcher: Watcher,
}

impl CollectorBoard {
    pub fn configured(admins: Vec<ProviderSubject>, socket: Option<PathBuf>, account_linked: bool) -> Option<CollectorBoard> {
        if admins.is_empty() || !account_linked {
            return None;
        }
        Some(CollectorBoard { admins, socket: socket?, watcher: Watcher::new() })
    }

    pub fn allows(&self, identity: Option<&ProviderSubject>) -> bool {
        identity.is_some_and(|identity| self.admins.contains(identity))
    }

    pub fn subscribe_judgment(&self) -> tokio::sync::watch::Receiver<DaemonJudgment> {
        self.watcher.subscribe_judgment()
    }

    pub fn subscribe_notices(&self) -> tokio::sync::broadcast::Receiver<DaemonNotice> {
        self.watcher.subscribe()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CollectorAccessState {
    Off,
    Denied,
    Allowed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorAccess {
    pub access: CollectorAccessState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorStatusPage {
    pub judgment: DaemonJudgment,
    pub status: Option<CollectorStatus>,
    pub sent_at: Option<String>,
    pub received_at: Option<UnixSeconds>,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/collector/access", get(access))
        .route("/api/collector/status", get(status).fallback(other_method))
        .route("/api/collector/coverage", get(coverage).fallback(other_method))
        .route("/api/collector/disk", get(disk).fallback(other_method))
}

async fn other_method(State(st): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    match allowed_board(&st) {
        Ok(_) => ([(header::ALLOW, "GET,HEAD")], ApiFailure::new(ApiErrorCode::MethodNotAllowed, format!("{}에는 {method}를 쓸 수 없습니다", uri.path()))).into_response(),
        Err(failure) => failure.into_response(),
    }
}

fn allowed_board(st: &AppState) -> Result<&CollectorBoard, ApiFailure> {
    let board = st.system.collector().ok_or_else(|| ApiFailure::new(ApiErrorCode::NotFound, "없는 경로입니다"))?;
    if board.allows(st.system.account().signed_in_identity().as_ref()) {
        Ok(board)
    } else {
        Err(ApiFailure::new(ApiErrorCode::Forbidden, "수집 현황판을 볼 수 있는 계정이 아닙니다"))
    }
}

async fn access(State(st): State<Arc<AppState>>) -> Json<CollectorAccess> {
    let access = match st.system.collector() {
        None => CollectorAccessState::Off,
        Some(board) if board.allows(st.system.account().signed_in_identity().as_ref()) => CollectorAccessState::Allowed,
        Some(_) => CollectorAccessState::Denied,
    };
    Json(CollectorAccess { access })
}

async fn status(State(st): State<Arc<AppState>>) -> Result<Json<CollectorStatusPage>, ApiFailure> {
    let view = allowed_board(&st)?.watcher.view();
    let (status, sent_at, received_at) = match view.last_status {
        Some(received) => (Some(received.status), Some(received.sent_at), Some(received.received_at)),
        None => (None, None, None),
    };
    Ok(Json(CollectorStatusPage { judgment: view.judgment, status, sent_at, received_at }))
}

async fn ask(st: &AppState, question: Question) -> Result<Answer, ApiFailure> {
    let board = allowed_board(st)?;
    watch::ask(&board.socket, question).await.map_err(|failure| {
        let message = match failure {
            AskFailure::Down => "감독 데몬이 꺼져 있습니다",
            AskFailure::Silent => "감독 데몬이 응답하지 않습니다",
            AskFailure::VersionMismatch => "감독 데몬과 형식 버전이 맞지 않습니다",
            AskFailure::Refused => "감독 데몬이 요청을 거절했습니다",
        };
        ApiFailure::new(ApiErrorCode::CollectorUnavailable, message)
    })
}

async fn coverage(State(st): State<Arc<AppState>>) -> Result<Json<CollectorCoverage>, ApiFailure> {
    match ask(&st, Question::Coverage).await? {
        Answer::Coverage(coverage) => Ok(Json(coverage)),
        Answer::Disk(_) => unreachable!("커버리지 질문에는 커버리지 답만 돌려준다"),
    }
}

async fn disk(State(st): State<Arc<AppState>>) -> Result<Json<CollectorDisk>, ApiFailure> {
    match ask(&st, Question::Disk).await? {
        Answer::Disk(disk) => Ok(Json(disk)),
        Answer::Coverage(_) => unreachable!("디스크 질문에는 디스크 답만 돌려준다"),
    }
}

pub async fn run(st: Arc<AppState>) {
    let Some(board) = st.system.collector() else { return };
    tokio::join!(watch::watch_forever(&board.socket, &board.watcher, &st.clock), fill_missing_subject(st.system.account()));
}

async fn fill_missing_subject(account: &crate::account::AccountState) {
    let mut sessions = account.subscribe_sessions();
    loop {
        sessions.borrow_and_update();
        let retry = account.is_signed_in_without_subject() && account.refresh().await.is_err();
        if retry {
            tokio::select! {
                _ = tokio::time::sleep(SUBJECT_RETRY) => {}
                changed = sessions.changed() => if changed.is_err() { return },
            }
        } else if sessions.changed().await.is_err() {
            return;
        }
    }
}
