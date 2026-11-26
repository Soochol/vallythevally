mod watch;
pub mod telegram;
pub mod wire;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::Extension;
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
use crate::alert::{AlertCode, AlertEvent, AlertPipeline, AlertRouter, AlertSource, MarketContext, MarketObservation, MarketPhase, StateStore, TelegramSink};
use crate::api::{ApiErrorCode, UnixSeconds};
use crate::clock::Clock;
use crate::http::{ApiFailure, AppState};

pub const SUBJECT_RETRY: Duration = Duration::from_secs(30);

pub struct CollectorBoard {
    admins: Vec<ProviderSubject>,
    socket: PathBuf,
    watcher: Watcher,
    telegram: Option<Arc<Telegram>>,
    alert_state_dir: Option<PathBuf>,
}

impl CollectorBoard {
    pub fn configured(admins: Vec<ProviderSubject>, socket: Option<PathBuf>, account_linked: bool) -> Option<CollectorBoard> {
        if admins.is_empty() || !account_linked {
            return None;
        }
        Some(CollectorBoard { admins, socket: socket?, watcher: Watcher::new(), telegram: None, alert_state_dir: None })
    }

    pub fn with_telegram(mut self, telegram: Option<Telegram>) -> CollectorBoard {
        self.telegram = telegram.map(Arc::new);
        self
    }

    pub fn with_alert_state_dir(mut self, dir: Option<PathBuf>) -> CollectorBoard {
        self.alert_state_dir = dir;
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

#[derive(Debug, Clone)]
pub struct SessionIdentity(pub ProviderSubject);

fn identity_of(st: &AppState, session: Option<Extension<SessionIdentity>>) -> Option<ProviderSubject> {
    match session {
        Some(Extension(SessionIdentity(identity))) => Some(identity),
        None => st.system.account().signed_in_identity(),
    }
}

async fn other_method(State(st): State<Arc<AppState>>, session: Option<Extension<SessionIdentity>>, method: Method, uri: Uri) -> Response {
    match allowed_board(&st, session) {
        Ok(_) => ([(header::ALLOW, "GET,HEAD")], ApiFailure::new(ApiErrorCode::MethodNotAllowed, format!("{}에는 {method}를 쓸 수 없습니다", uri.path()))).into_response(),
        Err(failure) => failure.into_response(),
    }
}

fn allowed_board(st: &AppState, session: Option<Extension<SessionIdentity>>) -> Result<&CollectorBoard, ApiFailure> {
    let board = st.system.collector().ok_or_else(|| ApiFailure::new(ApiErrorCode::NotFound, "없는 경로입니다"))?;
    if board.allows(identity_of(st, session).as_ref()) {
        Ok(board)
    } else {
        Err(ApiFailure::new(ApiErrorCode::Forbidden, "수집 현황판을 볼 수 있는 계정이 아닙니다"))
    }
}

async fn access(State(st): State<Arc<AppState>>, session: Option<Extension<SessionIdentity>>) -> Json<CollectorAccess> {
    let access = match st.system.collector() {
        None => CollectorAccessState::Off,
        Some(board) if board.allows(identity_of(&st, session).as_ref()) => CollectorAccessState::Allowed,
        Some(_) => CollectorAccessState::Denied,
    };
    Json(CollectorAccess { access })
}

async fn status(State(st): State<Arc<AppState>>, session: Option<Extension<SessionIdentity>>) -> Result<Json<CollectorStatusPage>, ApiFailure> {
    let view = allowed_board(&st, session)?.watcher.view();
    let (status, sent_at, received_at) = match view.last_status {
        Some(received) => (Some(received.status), Some(received.sent_at), Some(received.received_at)),
        None => (None, None, None),
    };
    Ok(Json(CollectorStatusPage { judgment: view.judgment, status, sent_at, received_at }))
}

async fn ask(st: &AppState, session: Option<Extension<SessionIdentity>>, question: Question) -> Result<Answer, ApiFailure> {
    let board = allowed_board(st, session)?;
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

async fn coverage(State(st): State<Arc<AppState>>, session: Option<Extension<SessionIdentity>>) -> Result<Json<CollectorCoverage>, ApiFailure> {
    match ask(&st, session, Question::Coverage).await? {
        Answer::Coverage(coverage) => Ok(Json(coverage)),
        Answer::Disk(_) => unreachable!("커버리지 질문에는 커버리지 답만 돌려준다"),
    }
}

async fn disk(State(st): State<Arc<AppState>>, session: Option<Extension<SessionIdentity>>) -> Result<Json<CollectorDisk>, ApiFailure> {
    match ask(&st, session, Question::Disk).await? {
        Answer::Disk(disk) => Ok(Json(disk)),
        Answer::Coverage(_) => unreachable!("디스크 질문에는 디스크 답만 돌려준다"),
    }
}

pub async fn run(st: Arc<AppState>) {
    let Some(board) = st.system.collector() else { return };
    let announced = board.telegram.clone().map(|telegram| (telegram, board.subscribe_judgment(), board.alert_state_dir.clone()));
    tokio::join!(watch::watch_forever(&board.socket, &board.watcher, &st.clock), fill_missing_subject(st.system.account()), announce_to_telegram(announced, st.clock.clone()));
}

fn server_market_context(clock: &Clock) -> MarketContext {
    let now = clock.now();
    let date: u32 = now.kst_date().yyyymmdd().parse().unwrap_or(0);
    let secs = now.kst_time_of_day().secs();
    let phase = if secs < 7 * 3600 + 20 * 60 {
        MarketPhase::OffHours
    } else if secs < 7 * 3600 + 55 * 60 {
        MarketPhase::MorningPrep
    } else if secs < 20 * 3600 + 5 * 60 {
        MarketPhase::Collecting
    } else if secs < 21 * 3600 + 30 * 60 {
        MarketPhase::AfterClose
    } else {
        MarketPhase::OffHours
    };
    MarketContext::new(date, phase, MarketObservation::Observed)
}

fn apply_judgment(pipeline: &AlertPipeline, judgment: DaemonJudgment, ctx: MarketContext) {
    match judgment {
        DaemonJudgment::Down => {
            let event = AlertEvent::active(AlertSource::ServerWatch, AlertCode::DaemonDown, "supervise", "감독 데몬이 꺼져 있습니다", "상태 소켓(supervise.sock) 연결이 45초 이상 실패했습니다")
                .with_impact("실시간 수집 및 마감 정리가 중단됐을 수 있습니다")
                .with_action("systemctl --user status vally-collector && journalctl --user -u vally-collector -n 50");
            pipeline.emit(event, ctx);
        }
        DaemonJudgment::Unresponsive => {
            let event = AlertEvent::active(AlertSource::ServerWatch, AlertCode::DaemonUnresponsive, "supervise", "감독 데몬이 응답하지 않습니다", "소켓 연결은 열려 있으나 하트비트가 15초 이상 끊겼습니다")
                .with_impact("감독 데몬이 멈췄거나 과부하 상태일 수 있습니다")
                .with_action("collector status --state ~/.local/state/vallythevally/collector");
            pipeline.emit(event, ctx);
        }
        DaemonJudgment::Healthy => {
            let down_ok = AlertEvent::resolved(AlertSource::ServerWatch, AlertCode::DaemonDown, "supervise", "감독 데몬 연결 복구", "상태 소켓 하트비트가 정상 수신되고 있습니다");
            let silent_ok = AlertEvent::resolved(AlertSource::ServerWatch, AlertCode::DaemonUnresponsive, "supervise", "감독 데몬 응답 복구", "상태 소켓 하트비트가 정상 수신되고 있습니다");
            pipeline.emit(down_ok, ctx);
            pipeline.emit(silent_ok, ctx);
        }
        DaemonJudgment::Checking | DaemonJudgment::VersionMismatch => {}
    }
}

async fn announce_to_telegram(announced: Option<(Arc<Telegram>, tokio::sync::watch::Receiver<DaemonJudgment>, Option<PathBuf>)>, clock: Clock) {
    let Some((telegram, mut judgments, state_dir)) = announced else { return };
    let router = AlertRouter::single(Arc::new(TelegramSink::from_arc(telegram)));
    let store = state_dir.as_deref().map(|dir| StateStore::in_folder(dir, "server"));
    let pipeline = AlertPipeline::spawn(router, store, clock.clone());
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let initial = *judgments.borrow_and_update();
    apply_judgment(&pipeline, initial, server_market_context(&clock));
    loop {
        tokio::select! {
            changed = judgments.changed() => {
                if changed.is_err() {
                    return;
                }
                let current = *judgments.borrow_and_update();
                apply_judgment(&pipeline, current, server_market_context(&clock));
            }
            _ = tick.tick() => {
                pipeline.tick(server_market_context(&clock));
            }
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
    use super::watch::DaemonJudgment;
    use super::*;
    use crate::alert::MemorySink;
    use crate::clock::kst;

    #[tokio::test(start_paused = true)]
    async fn brief_down_under_hysteresis_sends_nothing_and_sustained_down_recovers_with_duration() {
        let sink = Arc::new(MemorySink::new());
        let clock = Clock::fake(kst(domain::KstDate::new(2026, 11, 26).unwrap(), 9, 0, 0));
        let pipeline = AlertPipeline::spawn(AlertRouter::single(sink.clone()), None, clock.clone());
        let ctx = server_market_context(&clock);

        apply_judgment(&pipeline, DaemonJudgment::Down, ctx);
        tokio::time::sleep(Duration::from_secs(30)).await;
        pipeline.tick(server_market_context(&clock));
        apply_judgment(&pipeline, DaemonJudgment::Healthy, server_market_context(&clock));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sink.messages().is_empty());

        apply_judgment(&pipeline, DaemonJudgment::Down, server_market_context(&clock));
        tokio::time::sleep(Duration::from_secs(45)).await;
        pipeline.tick(server_market_context(&clock));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(sink.messages().len(), 1);
        assert!(sink.messages()[0].html.contains("감독 데몬이 꺼져 있습니다"));

        tokio::time::sleep(Duration::from_secs(60)).await;
        apply_judgment(&pipeline, DaemonJudgment::Healthy, server_market_context(&clock));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sent = sink.messages();
        assert_eq!(sent.len(), 2);
        assert!(sent[1].html.contains("복구 완료") && sent[1].silent);
    }
}
