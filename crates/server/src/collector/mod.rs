mod watch;
pub mod telegram;
pub mod wire;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{Method, Uri, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use self::watch::{ASK_TIMEOUT, CONNECT_TIMEOUT, DaemonJudgment, DaemonNotice, HEARTBEAT_EVERY, MAX_LINE_BYTES, MISSED_HEARTBEATS, RECONNECT_BACKOFF};
use self::watch::{Answer, AskFailure, Question, Watcher};
use self::telegram::Telegram;
use self::wire::{CollectorCoverage, CollectorDisk, CollectorStatus};
use crate::account::ProviderSubject;
use crate::api::{ApiErrorCode, UnixSeconds};
use crate::http::{ApiFailure, AppState};

pub const SUBJECT_RETRY: Duration = Duration::from_secs(30);

pub struct CollectorBoard {
    admins: Vec<ProviderSubject>,
    socket: PathBuf,
    watcher: Watcher,
    telegram: Option<Arc<Telegram>>,
}

impl CollectorBoard {
    pub fn configured(admins: Vec<ProviderSubject>, socket: Option<PathBuf>, account_linked: bool) -> Option<CollectorBoard> {
        if admins.is_empty() || !account_linked {
            return None;
        }
        Some(CollectorBoard { admins, socket: socket?, watcher: Watcher::new(), telegram: None })
    }

    pub fn with_telegram(mut self, telegram: Option<Telegram>) -> CollectorBoard {
        self.telegram = telegram.map(Arc::new);
        self
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
        .route("/api/collector/status", any(other_method).get(status))
        .route("/api/collector/coverage", any(other_method).get(coverage))
        .route("/api/collector/disk", any(other_method).get(disk))
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
    let announced = board.telegram.clone().map(|telegram| (telegram, board.subscribe_notices()));
    tokio::join!(watch::watch_forever(&board.socket, &board.watcher, &st.clock), fill_missing_subject(st.system.account()), announce_to_telegram(announced));
}

fn telegram_text(notice: &DaemonNotice) -> String {
    let what = match notice.judgment {
        DaemonJudgment::Down => "감독 데몬이 꺼져 있습니다",
        _ => "감독 데몬이 응답하지 않습니다",
    };
    format!("[수집 경보] {} · {what}", domain::KstTime::from_unix(notice.at.0))
}

async fn announce_to_telegram(announced: Option<(Arc<Telegram>, tokio::sync::broadcast::Receiver<DaemonNotice>)>) {
    let Some((telegram, mut notices)) = announced else { return };
    loop {
        match notices.recv().await {
            Ok(notice) => {
                if let Err(failure) = telegram.send(&telegram_text(&notice)).await {
                    tracing::warn!(%failure, "수집 경보를 텔레그램으로 보내지 못했습니다");
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => tracing::warn!(skipped, "수집 경보 알림을 건너뛰었습니다"),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
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

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    use super::watch::{DaemonJudgment, DaemonNotice};
    use super::*;

    #[derive(Clone, Default)]
    struct LogCapture(Arc<Mutex<Vec<u8>>>);

    impl Write for LogCapture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn notices_the_queue_dropped_are_counted_in_a_warning() {
        let capture = LogCapture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt().with_writer(move || writer.clone()).with_ansi(false).finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("telegram");
        std::fs::write(&path, "bot_token=1:token\nchat_id=1\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let telegram = Arc::new(Telegram::load(&path).unwrap().unwrap());
        let (sender, receiver) = tokio::sync::broadcast::channel(2);
        for second in 0..5 {
            sender.send(DaemonNotice { judgment: DaemonJudgment::Down, at: UnixSeconds(second) }).unwrap();
        }
        drop(sender);
        announce_to_telegram(Some((telegram, receiver))).await;
        let logs = String::from_utf8_lossy(&capture.0.lock().unwrap()).into_owned();
        assert!(logs.contains("수집 경보 알림을 건너뛰었습니다") && logs.contains("skipped=3"), "{logs}");
    }
}
