use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::middleware;
use axum::response::Json;
use axum::routing::{get, post, put};
use serde::de::DeserializeOwned;

use crate::api::{self, ApiErrorCode, KeySource, KiwoomAtStart, KiwoomConnectStep, KiwoomLinkProblem, KiwoomLinkState, KiwoomLinkStatus, UnixSeconds};
use crate::config::{Config, KiwoomCredentials, Secret};
use crate::http::{ApiFailure, AppState};
use crate::kiwoom::ip_file::RegisteredIpFile;
use crate::kiwoom::key_file::KeyFile;
use crate::kiwoom::link::{ConnectStep, LinkState, Problem};
use crate::kiwoom::private_file::FileError;
use crate::public_ip::{self, PublicIpTransport};

const BODY_LIMIT: usize = 4096;

pub struct SystemState {
    key_file: Option<KeyFile>,
    ip_file: Option<RegisteredIpFile>,
    registered_ip: Mutex<Option<api::RegisteredIp>>,
    public_ip: Option<Arc<dyn PublicIpTransport>>,
    env_key: bool,
    key_file_problem: Mutex<Option<String>>,
    settings: Option<api::SystemSettings>,
    account: crate::account::AccountState,
    collector: Option<crate::collector::CollectorBoard>,
    bound: OnceLock<std::net::SocketAddr>,
    bound_signal: tokio::sync::Notify,
    write: tokio::sync::Mutex<()>,
}

impl SystemState {
    pub fn new(key_file: KeyFile, env_key: bool, key_file_problem: Option<FileError>, settings: api::SystemSettings) -> Self {
        let ip_file = key_file.registered_ip_file();
        let registered_ip = ip_file.load().unwrap_or_else(|e| {
            tracing::warn!(error = %e, "등록한 IP 기록을 읽지 못했습니다. 없는 것으로 봅니다");
            None
        });
        SystemState { key_file: Some(key_file), ip_file: Some(ip_file), registered_ip: Mutex::new(registered_ip), public_ip: None, env_key, key_file_problem: Mutex::new(key_file_problem.map(|e| e.to_string())), settings: Some(settings), account: crate::account::AccountState::local_only(), collector: None, bound: OnceLock::new(), bound_signal: tokio::sync::Notify::new(), write: tokio::sync::Mutex::new(()) }
    }

    pub fn with_public_ip(mut self, transport: Arc<dyn PublicIpTransport>) -> Self {
        self.public_ip = Some(transport);
        self
    }

    pub fn with_account(mut self, account: crate::account::AccountState) -> Self {
        self.account = account;
        self
    }

    pub fn with_collector(mut self, collector: Option<crate::collector::CollectorBoard>) -> Self {
        self.collector = collector;
        self
    }

    pub fn collector(&self) -> Option<&crate::collector::CollectorBoard> {
        self.collector.as_ref()
    }

    pub fn account(&self) -> &crate::account::AccountState {
        &self.account
    }

    pub fn order_switch_store(&self) -> crate::trading::SwitchStore {
        match &self.key_file {
            Some(key_file) => key_file.order_switch_store(),
            None => crate::trading::SwitchStore::memory(),
        }
    }

    pub fn unconfigured() -> Self {
        SystemState { key_file: None, ip_file: None, registered_ip: Mutex::new(None), public_ip: None, env_key: false, key_file_problem: Mutex::new(None), settings: None, account: crate::account::AccountState::local_only(), collector: None, bound: OnceLock::new(), bound_signal: tokio::sync::Notify::new(), write: tokio::sync::Mutex::new(()) }
    }

    pub fn bound(&self, addr: std::net::SocketAddr) {
        let _ = self.bound.set(addr);
        self.bound_signal.notify_waiters();
    }

    pub async fn when_bound(&self) {
        loop {
            let signal = self.bound_signal.notified();
            tokio::pin!(signal);
            signal.as_mut().enable();
            if self.bound.get().is_some() {
                return;
            }
            signal.await;
        }
    }

    pub(crate) fn bound_addr(&self) -> Option<std::net::SocketAddr> {
        self.bound.get().copied()
    }

    fn key_file_problem(&self) -> Option<String> {
        self.key_file_problem.lock().expect("키 파일 문제 잠금").clone()
    }

    fn registered_ip(&self) -> Option<api::RegisteredIp> {
        self.registered_ip.lock().expect("등록 IP 잠금").clone()
    }

    fn set_key_file_problem(&self, problem: Option<String>) {
        *self.key_file_problem.lock().expect("키 파일 문제 잠금") = problem;
    }
}

impl api::SystemSettings {
    pub fn from_config(config: &Config) -> Self {
        let path = |p: &std::path::Path| p.display().to_string();
        api::SystemSettings {
            bind: config.bind.socket_addr().to_string(),
            log_filter: config.log_filter.clone(),
            static_dir: path(&config.static_dir),
            db_path: path(&config.db_path),
            screener_db_path: path(&config.screener_db_path),
            financial_db_path: path(&config.financial_db_path),
            screener_update_on_start: config.screener_update_on_start,
            financial_automatic: config.financial_automatic,
            opendart_key_present: config.opendart_api_key.is_some(),
            token_path: path(&config.token_path),
            key_path: path(&config.kiwoom_key_path),
            lock_path: path(&config.lock_path),
            kiwoom_target: kiwoom_target(&config.kiwoom_base_url),
            server_version: env!("CARGO_PKG_VERSION").to_owned(),
            account_server_url: config.account_server_url.as_ref().map(|url| url.as_str().to_owned()),
            account_state_path: config.account_state_path.as_deref().map(path),
        }
    }
}

pub fn kiwoom_target(base_url: &str) -> api::KiwoomTarget {
    let host = reqwest::Url::parse(base_url).ok().and_then(|url| url.host_str().map(str::to_owned));
    match host {
        Some(host) if !is_loopback_host(&host) => api::KiwoomTarget { kind: api::KiwoomTargetKind::Kiwoom, host: Some(host) },
        _ => api::KiwoomTarget { kind: api::KiwoomTargetKind::Loopback, host: None },
    }
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/system/kiwoom", get(get_kiwoom))
        .route("/api/system/kiwoom/key", put(put_key).delete(delete_key))
        .route("/api/system/kiwoom/connect", post(connect))
        .route("/api/system/kiwoom/disconnect", post(disconnect))
        .route("/api/system/kiwoom/ip-check", post(ip_check))
        .route("/api/system/kiwoom/registered-ip", put(put_registered_ip))
        .route("/api/system/kiwoom/recheck-token-file", post(recheck_token_file))
        .route("/api/system/settings", get(get_settings))
        .layer(middleware::from_fn_with_state(state, crate::write_guard::guard_writes))
}

async fn read_body<T: DeserializeOwned>(body: Body) -> Result<T, ApiFailure> {
    let malformed = || ApiFailure::bad_request("본문 형식이 올바르지 않습니다");
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| malformed())?;
    serde_json::from_slice(&bytes).map_err(|_| malformed())
}

fn env_key_conflict() -> ApiFailure {
    ApiFailure::new(ApiErrorCode::Conflict, ".env에서 읽은 키라 화면에서 바꿀 수 없습니다")
}

fn key_file_of(system: &SystemState) -> Result<&KeyFile, ApiFailure> {
    system.key_file.as_ref().ok_or_else(|| ApiFailure::new(ApiErrorCode::Internal, "키 파일 위치가 정해지지 않았습니다"))
}

async fn get_kiwoom(State(st): State<Arc<AppState>>) -> Json<KiwoomLinkStatus> {
    Json(kiwoom_status(&st))
}

async fn put_key(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<KiwoomLinkStatus>, ApiFailure> {
    let input: api::KiwoomKeyInput = read_body(body).await?;
    let _write = st.system.write.lock().await;
    if st.system.env_key {
        return Err(env_key_conflict());
    }
    let (app_key, app_secret) = (input.app_key.trim(), input.app_secret.trim());
    if app_key.is_empty() {
        return Err(ApiFailure::bad_request("앱키가 비어 있습니다"));
    }
    if app_secret.is_empty() {
        return Err(ApiFailure::bad_request("시크릿이 비어 있습니다"));
    }
    let credentials = KiwoomCredentials { app_key: Secret::new(app_key.to_owned()), app_secret: Secret::new(app_secret.to_owned()) };
    st.link.disconnect();
    key_file_of(&st.system)?.save(&credentials).map_err(|e| ApiFailure::new(ApiErrorCode::Internal, format!("키 파일에 쓰지 못했습니다: {e}")))?;
    st.system.set_key_file_problem(None);
    st.link.replace_key(credentials.app_key, credentials.app_secret);
    tracing::info!("키움 키를 저장했습니다");
    st.link.connect_in_background();
    Ok(Json(kiwoom_status(&st)))
}

async fn delete_key(State(st): State<Arc<AppState>>) -> Result<Json<KiwoomLinkStatus>, ApiFailure> {
    let _write = st.system.write.lock().await;
    if st.system.env_key {
        return Err(env_key_conflict());
    }
    st.link.disconnect();
    key_file_of(&st.system)?.remove().map_err(|e| ApiFailure::new(ApiErrorCode::Internal, format!("키 파일을 지우지 못했습니다: {e}")))?;
    st.system.set_key_file_problem(None);
    st.link.clear_key();
    tracing::info!("키움 키를 지웠습니다");
    Ok(Json(kiwoom_status(&st)))
}

async fn connect(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<KiwoomLinkStatus>, ApiFailure> {
    let input: api::KiwoomConnectInput = read_body(body).await?;
    tracing::info!(acknowledged = input.acknowledged, "키움 연결을 요청받았습니다");
    st.link.connect_until_waiting(input.acknowledged).await;
    Ok(Json(kiwoom_status(&st)))
}

async fn disconnect(State(st): State<Arc<AppState>>) -> Json<KiwoomLinkStatus> {
    st.link.disconnect_by_user();
    Json(kiwoom_status(&st))
}

async fn recheck_token_file(State(st): State<Arc<AppState>>) -> Json<KiwoomLinkStatus> {
    st.link.recheck_token_file();
    Json(kiwoom_status(&st))
}

async fn ip_check(State(st): State<Arc<AppState>>) -> Result<Json<api::PublicIpCheck>, ApiFailure> {
    let transport = st.system.public_ip.as_ref().ok_or_else(|| ApiFailure::new(ApiErrorCode::Internal, "공인 IP 확인 주소가 정해지지 않았습니다"))?;
    tracing::info!("공인 IP 확인을 요청받았습니다");
    match public_ip::check(transport.as_ref()).await {
        Ok(ip) => Ok(Json(api::PublicIpCheck { ip: ip.to_string(), checked_at: UnixSeconds(st.clock.now().unix()) })),
        Err(failure) => {
            tracing::warn!(?failure, "공인 IP를 확인하지 못했습니다");
            Err(ApiFailure::new(ApiErrorCode::Internal, failure.to_string()))
        }
    }
}

async fn put_registered_ip(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<KiwoomLinkStatus>, ApiFailure> {
    let input: api::RegisteredIpInput = read_body(body).await?;
    let ip: std::net::IpAddr = input.ip.trim().parse().map_err(|_| ApiFailure::bad_request("IP 주소 형식이 올바르지 않습니다"))?;
    let _write = st.system.write.lock().await;
    let file = st.system.ip_file.as_ref().ok_or_else(|| ApiFailure::new(ApiErrorCode::Internal, "등록 IP 파일 위치가 정해지지 않았습니다"))?;
    let registered = api::RegisteredIp { ip: ip.to_string(), at: UnixSeconds(st.clock.now().unix()) };
    file.save(&registered).map_err(|e| ApiFailure::new(ApiErrorCode::Internal, format!("등록한 IP를 파일에 쓰지 못했습니다: {e}")))?;
    *st.system.registered_ip.lock().expect("등록 IP 잠금") = Some(registered);
    tracing::info!("포털에 등록한 공인 IP를 기록했습니다");
    Ok(Json(kiwoom_status(&st)))
}

async fn get_settings(State(st): State<Arc<AppState>>) -> Result<Json<api::SystemSettings>, ApiFailure> {
    st.system.settings.clone().map(Json).ok_or_else(|| ApiFailure::new(ApiErrorCode::Internal, "설정 값이 준비되지 않았습니다"))
}

pub fn kiwoom_status(st: &AppState) -> KiwoomLinkStatus {
    let summary = st.rest.auth().credential_summary();
    let summary_present = summary.is_some();
    let key_source = if st.system.env_key { KeySource::Env } else if summary.is_some() { KeySource::File } else { KeySource::None };
    let mut status = KiwoomLinkStatus {
        key_source,
        app_key_tail: summary.as_ref().and_then(|s| s.app_key_tail.clone()),
        credential_id: summary.map(|s| s.credential_prefix),
        state: KiwoomLinkState::NoKey,
        problem: None,
        message: String::new(),
        retry_at: None,
        needs_acknowledgement: st.link.needs_acknowledgement(),
        step: None,
        token_expires_at: None,
        realtime_registered: None,
        symbol_count: None,
        registered_ip: st.system.registered_ip(),
        at_start: None,
    };
    status.at_start = summary_present.then(|| if st.rest.auth().kept_disconnected() { KiwoomAtStart::KeptDisconnected } else { KiwoomAtStart::Connects });
    match st.link.state() {
        LinkState::NoKey => match st.system.key_file_problem() {
            Some(problem) => {
                status.state = KiwoomLinkState::Failed;
                status.problem = Some(KiwoomLinkProblem::KeyFileUnusable);
                status.message = format!("키 파일을 쓸 수 없어 키 없이 켰습니다({problem})");
            }
            None => status.message = "키움 키가 없습니다. 저장만 하고 키움에는 아무것도 보내지 않습니다".to_owned(),
        },
        LinkState::Disconnected => {
            status.state = KiwoomLinkState::Disconnected;
            status.message = match status.at_start {
                Some(KiwoomAtStart::KeptDisconnected) => "연결을 끊어 두었습니다. 연결하면 다음부터 서버를 켤 때 자동으로 연결합니다",
                _ => "키가 저장돼 있습니다. 서버를 켤 때 자동으로 연결합니다",
            }
            .to_owned();
        }
        LinkState::Connecting(step) => {
            status.state = KiwoomLinkState::Connecting;
            status.step = Some(connect_step(step));
            if let ConnectStep::IssueInterval(until) = step {
                status.retry_at = Some(UnixSeconds(until.unix()));
                status.message = "키움 토큰 발급 간격을 기다리는 중입니다. 간격이 끝나면 저절로 연결합니다".to_owned();
            } else {
                status.message = "키움에 연결하는 중입니다".to_owned();
            }
        }
        LinkState::Connected => {
            status.state = KiwoomLinkState::Connected;
            status.message = "키움에 연결됨".to_owned();
            status.token_expires_at = st.rest.auth().token_expires_at().map(|t| UnixSeconds(t.unix()));
            status.realtime_registered = Some(count(st.registered.borrow().len()));
            status.symbol_count = st.symbols.updates().borrow().as_ref().map(|directory| count(directory.len()));
        }
        LinkState::Failed(failure) => {
            status.state = KiwoomLinkState::Failed;
            status.problem = Some(problem(failure.problem));
            status.message = failure.message;
            status.retry_at = failure.retry_at.map(|t| UnixSeconds(t.unix()));
        }
    }
    status
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn connect_step(step: ConnectStep) -> KiwoomConnectStep {
    match step {
        ConnectStep::CheckingKey => KiwoomConnectStep::CheckingKey,
        ConnectStep::Token => KiwoomConnectStep::Token,
        ConnectStep::IssueInterval(_) => KiwoomConnectStep::IssueInterval,
        ConnectStep::Symbols => KiwoomConnectStep::Symbols,
        ConnectStep::Realtime => KiwoomConnectStep::Realtime,
    }
}

fn problem(problem: Problem) -> KiwoomLinkProblem {
    match problem {
        Problem::AuthBlocked8050 => KiwoomLinkProblem::AuthBlocked8050,
        Problem::KeyNeedsCheck => KiwoomLinkProblem::KeyNeedsCheck,
        Problem::IssueIntervalWait => KiwoomLinkProblem::IssueIntervalWait,
        Problem::AuthUncertain => KiwoomLinkProblem::AuthUncertain,
        Problem::Network => KiwoomLinkProblem::Network,
        Problem::TokenFileUnusable => KiwoomLinkProblem::TokenFileUnusable,
        Problem::PathStopped => KiwoomLinkProblem::PathStopped,
    }
}
