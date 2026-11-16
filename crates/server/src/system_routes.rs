use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post, put};
use serde::de::DeserializeOwned;

use crate::api::{self, ApiErrorCode, KeySource, KiwoomConnectStep, KiwoomLinkProblem, KiwoomLinkState, KiwoomLinkStatus, UnixSeconds};
use crate::config::{Config, KiwoomCredentials, Secret};
use crate::http::{ApiFailure, AppState};
use crate::kiwoom::key_file::KeyFile;
use crate::kiwoom::link::{ConnectStep, LinkState, Problem};
use crate::kiwoom::private_file::FileError;

const BODY_LIMIT: usize = 4096;

pub struct SystemState {
    key_file: Option<KeyFile>,
    env_key: bool,
    key_file_problem: Mutex<Option<String>>,
    settings: Option<api::SystemSettings>,
    bound: OnceLock<std::net::SocketAddr>,
    write: tokio::sync::Mutex<()>,
}

impl SystemState {
    pub fn new(key_file: KeyFile, env_key: bool, key_file_problem: Option<FileError>, settings: api::SystemSettings) -> Self {
        SystemState { key_file: Some(key_file), env_key, key_file_problem: Mutex::new(key_file_problem.map(|e| e.to_string())), settings: Some(settings), bound: OnceLock::new(), write: tokio::sync::Mutex::new(()) }
    }

    pub fn unconfigured() -> Self {
        SystemState { key_file: None, env_key: false, key_file_problem: Mutex::new(None), settings: None, bound: OnceLock::new(), write: tokio::sync::Mutex::new(()) }
    }

    pub fn bound(&self, addr: std::net::SocketAddr) {
        let _ = self.bound.set(addr);
    }

    fn key_file_problem(&self) -> Option<String> {
        self.key_file_problem.lock().expect("키 파일 문제 잠금").clone()
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
        .route("/api/system/kiwoom/recheck-token-file", post(recheck_token_file))
        .route("/api/system/settings", get(get_settings))
        .layer(middleware::from_fn_with_state(state, guard_writes))
}

async fn guard_writes(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && let Err(rejected) = check_write(&st.system, &req)
    {
        tracing::warn!(method = %req.method(), path = req.uri().path(), "시스템 설정 쓰기 요청을 거절했습니다");
        return rejected.into_response();
    }
    next.run(req).await
}

fn check_write(system: &SystemState, req: &Request) -> Result<(), ApiFailure> {
    let headers = req.headers();
    let refuse = |what: &str| ApiFailure::bad_request(format!("이 요청은 받지 않습니다: {what}"));
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).or_else(|| req.uri().authority().map(|a| a.as_str())).ok_or_else(|| refuse("Host가 없습니다"))?;
    let bound = system.bound.get().ok_or_else(|| refuse("서버가 아직 준비되지 않았습니다"))?;
    if !is_own_host(host, *bound) {
        return Err(refuse("Host가 이 서버의 주소가 아닙니다"));
    }
    check_origin(headers, host)?;
    let json = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(';').next().is_some_and(|essence| essence.trim().eq_ignore_ascii_case("application/json")));
    if !json {
        return Err(refuse("Content-Type은 application/json이어야 합니다"));
    }
    Ok(())
}

fn is_own_host(host: &str, bound: std::net::SocketAddr) -> bool {
    let (host, port) = (host.to_ascii_lowercase(), bound.port());
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}"), bound.to_string()].contains(&host)
}

fn check_origin(headers: &HeaderMap, host: &str) -> Result<(), ApiFailure> {
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let Some(origin) = origins.next() else { return Ok(()) };
    let same = origins.next().is_none() && origin.to_str().is_ok_and(|o| o.eq_ignore_ascii_case(&format!("http://{host}")));
    if same { Ok(()) } else { Err(ApiFailure::bad_request("이 요청은 받지 않습니다: Origin이 이 서버가 아닙니다")) }
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
    st.link.connect(input.acknowledged).await;
    Ok(Json(kiwoom_status(&st)))
}

async fn disconnect(State(st): State<Arc<AppState>>) -> Json<KiwoomLinkStatus> {
    st.link.disconnect();
    Json(kiwoom_status(&st))
}

async fn recheck_token_file(State(st): State<Arc<AppState>>) -> Json<KiwoomLinkStatus> {
    st.link.recheck_token_file();
    Json(kiwoom_status(&st))
}

async fn get_settings(State(st): State<Arc<AppState>>) -> Result<Json<api::SystemSettings>, ApiFailure> {
    st.system.settings.clone().map(Json).ok_or_else(|| ApiFailure::new(ApiErrorCode::Internal, "설정 값이 준비되지 않았습니다"))
}

pub fn kiwoom_status(st: &AppState) -> KiwoomLinkStatus {
    let summary = st.rest.auth().credential_summary();
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
    };
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
            status.message = "키가 저장돼 있습니다. 연결하지 않았습니다".to_owned();
        }
        LinkState::Connecting(step) => {
            status.state = KiwoomLinkState::Connecting;
            status.step = Some(connect_step(step));
            status.message = "키움에 연결하는 중입니다".to_owned();
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
