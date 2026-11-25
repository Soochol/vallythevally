use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::middleware;
use axum::response::Json;
use axum::routing::{get, post, put};
use serde::de::DeserializeOwned;

use crate::api::{self, ApiErrorCode, Broker, KeySource, KiwoomAtStart, KiwoomEnvironment, KiwoomConnectStep, KiwoomLinkProblem, KiwoomLinkState, KiwoomLinkStatus, UnixSeconds};
use crate::config::{Config, KiwoomCredentials, Secret};
use crate::http::{ApiFailure, AppState};
use crate::kiwoom::key_file::{KEY_LIMIT, KeyId, KeyOrigin};
use crate::kiwoom::keys::{Connection, KeyError, KeySetup, KisFactory, ListedKey};
use crate::kiwoom::link::{ConnectStep, LinkState, Problem};
use crate::kiwoom::private_file::FileError;
use crate::kiwoom::rest::Usage;
use crate::public_ip::{self, PublicIpTransport};
use crate::trading::KisAccountSettings;

const BODY_LIMIT: usize = 4096;

pub struct SystemStartup {
    pub state: SystemState,
    pub key_setup: Option<KeySetup>,
    pub kis_factory: Option<KisFactory>,
    pub order_switch: Option<crate::trading::SwitchStore>,
}

impl SystemStartup {
    pub fn new(key_setup: KeySetup, key_file_problem: Option<FileError>, settings: api::SystemSettings) -> Self {
        let order_switch = Some(key_setup.store.order_switch_store());
        Self {
            state: SystemState {
                environment: settings.environment,
                public_ip: None,
                key_file_problem: Mutex::new(key_file_problem.map(|e| e.to_string())),
                settings: Some(settings),
                account: crate::account::AccountState::local_only(),
                collector: None,
                bound: OnceLock::new(),
                tailnet_hosts: Default::default(),
                bound_signal: tokio::sync::Notify::new(),
                write: tokio::sync::Mutex::new(()),
            },
            key_setup: Some(key_setup),
            kis_factory: None,
            order_switch,
        }
    }

    pub fn with_kis(mut self, factory: KisFactory) -> Self {
        self.kis_factory = Some(factory);
        self
    }

    pub fn with_public_ip(mut self, transport: Arc<dyn PublicIpTransport>) -> Self {
        self.state = self.state.with_public_ip(transport);
        self
    }

    pub fn with_account(mut self, account: crate::account::AccountState) -> Self {
        self.state = self.state.with_account(account);
        self
    }

    pub fn with_tailnet_hosts(mut self, tailnet_hosts: crate::config::TailnetHosts) -> Self {
        self.state = self.state.with_tailnet_hosts(tailnet_hosts);
        self
    }

    pub fn with_collector(mut self, collector: Option<crate::collector::CollectorBoard>) -> Self {
        self.state = self.state.with_collector(collector);
        self
    }
}

impl From<SystemState> for SystemStartup {
    fn from(state: SystemState) -> Self {
        Self { state, key_setup: None, kis_factory: None, order_switch: None }
    }
}

pub struct SystemState {
    environment: KiwoomEnvironment,
    public_ip: Option<Arc<dyn PublicIpTransport>>,
    key_file_problem: Mutex<Option<String>>,
    settings: Option<api::SystemSettings>,
    account: crate::account::AccountState,
    collector: Option<crate::collector::CollectorBoard>,
    bound: OnceLock<std::net::SocketAddr>,
    tailnet_hosts: crate::config::TailnetHosts,
    bound_signal: tokio::sync::Notify,
    write: tokio::sync::Mutex<()>,
}

impl SystemState {
    pub fn environment(&self) -> KiwoomEnvironment {
        self.environment
    }

    pub fn with_public_ip(mut self, transport: Arc<dyn PublicIpTransport>) -> Self {
        self.public_ip = Some(transport);
        self
    }

    pub fn with_account(mut self, account: crate::account::AccountState) -> Self {
        self.account = account;
        self
    }

    pub fn with_tailnet_hosts(mut self, tailnet_hosts: crate::config::TailnetHosts) -> Self {
        self.tailnet_hosts = tailnet_hosts;
        self
    }

    pub(crate) fn tailnet_hosts(&self) -> &crate::config::TailnetHosts {
        &self.tailnet_hosts
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

    pub fn unconfigured() -> Self {
        SystemState { environment: KiwoomEnvironment::Real, public_ip: None, key_file_problem: Mutex::new(None), settings: None, account: crate::account::AccountState::local_only(), collector: None, bound: OnceLock::new(), tailnet_hosts: Default::default(), bound_signal: tokio::sync::Notify::new(), write: tokio::sync::Mutex::new(()) }
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

    fn set_key_file_problem(&self, problem: Option<String>) {
        *self.key_file_problem.lock().expect("키 파일 문제 잠금") = problem;
    }
}

impl api::SystemSettings {
    pub fn from_config(config: &Config) -> Self {
        let path = |p: &std::path::Path| p.display().to_string();
        api::SystemSettings {
            environment: config.kiwoom_environment,
            bind: config.bind.socket_addr().to_string(),
            log_filter: config.log_filter.clone(),
            static_dir: path(&config.static_dir),
            db_path: path(&config.db_path),
            screener_db_path: path(&config.screener_db_path),
            financial_db_path: path(&config.financial_db_path),
            hoga_data_dir: config.hoga_data_dir.as_deref().map(path),
            shared_data_dir: config.shared_data.as_ref().map(|shared| path(&shared.dir)),
            screener_update_on_start: config.screener_update_on_start,
            token_path: path(&config.token_path),
            key_path: path(&config.kiwoom_key_path.with_file_name(crate::kiwoom::key_file::KEY_LIST_FILE_NAME)),
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
        .route("/api/system/market-source", get(get_market_source))
        .route("/api/system/kiwoom/usage", get(get_kiwoom_usage))
        .route("/api/system/kiwoom/key", put(put_key).delete(delete_key))
        .route("/api/system/kiwoom/keys", get(list_keys).post(add_key))
        .route("/api/system/kiwoom/keys/{id}", axum::routing::delete(delete_key_by_id))
        .route("/api/system/kiwoom/keys/{id}/alias", put(rename_key))
        .route("/api/system/kiwoom/keys/{id}/key", put(replace_key))
        .route("/api/system/kiwoom/keys/{id}/account", put(put_kis_account))
        .route("/api/system/kiwoom/keys/{id}/connect", post(connect_key))
        .route("/api/system/kiwoom/keys/{id}/disconnect", post(disconnect_key))
        .route("/api/system/kiwoom/market-key", put(put_market_key))
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

fn mock_key_conflict() -> ApiFailure {
    ApiFailure::new(ApiErrorCode::Conflict, "모의투자 키는 환경 설정(VALLY_KIWOOM_MOCK_APP_KEY, VALLY_KIWOOM_MOCK_APP_SECRET)에서만 받아 화면에서 바꿀 수 없습니다")
}

async fn get_kiwoom(State(st): State<Arc<AppState>>) -> Json<KiwoomLinkStatus> {
    Json(kiwoom_status(&st))
}

async fn get_market_source(State(st): State<Arc<AppState>>) -> Json<api::MarketSourceStatus> {
    Json(st.market_control.snapshot())
}

async fn get_kiwoom_usage(State(st): State<Arc<AppState>>) -> Json<api::KiwoomUsage> {
    Json(kiwoom_usage(&st.rest.usage()))
}

fn kiwoom_usage(usage: &Usage) -> api::KiwoomUsage {
    let saturating = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
    api::KiwoomUsage {
        last_minute_started_at: usage.last_minute_started_at.map(|t| UnixSeconds(t.unix())),
        total_rate_limited: saturating(usage.total_rate_limited),
        trs: usage
            .trs
            .iter()
            .map(|tr| api::KiwoomUsageTr {
                api_id: tr.api_id.to_owned(),
                limit: tr.limit,
                last_minute: api::KiwoomUsageMinute {
                    sent: tr.last_minute.sent,
                    max_per_second: tr.last_minute.max_per_second,
                    max_wait_ms: u32::try_from(tr.last_minute.max_wait.as_millis()).unwrap_or(u32::MAX),
                    rate_limited: tr.last_minute.rate_limited,
                    resent: tr.last_minute.resent,
                },
                total_sent: saturating(tr.total_sent),
                total_rate_limited: saturating(tr.total_rate_limited),
            })
            .collect(),
    }
}

fn key_failure(error: KeyError) -> ApiFailure {
    match error {
        KeyError::Limit | KeyError::DuplicateAppKey | KeyError::DuplicateAccount | KeyError::AccountRequired | KeyError::NotKis | KeyError::Alias(_) => ApiFailure::bad_request(error.to_string()),
        KeyError::Unknown => ApiFailure::new(ApiErrorCode::NotFound, error.to_string()),
        KeyError::EnvReadOnly => env_key_conflict(),
        KeyError::NoStore | KeyError::File(_) => ApiFailure::new(ApiErrorCode::Internal, error.to_string()),
    }
}

fn key_id(text: &str) -> Result<KeyId, ApiFailure> {
    KeyId::parse(text).ok_or_else(|| key_failure(KeyError::Unknown))
}

fn checked_credentials(app_key: &str, app_secret: &str) -> Result<KiwoomCredentials, ApiFailure> {
    let (app_key, app_secret) = (app_key.trim(), app_secret.trim());
    if app_key.is_empty() {
        return Err(ApiFailure::bad_request("앱키가 비어 있습니다"));
    }
    if app_secret.is_empty() {
        return Err(ApiFailure::bad_request("시크릿이 비어 있습니다"));
    }
    Ok(KiwoomCredentials { app_key: Secret::new(app_key.to_owned()), app_secret: Secret::new(app_secret.to_owned()) })
}

fn checked_kis_account(account_no: Option<&str>, hts_id: Option<&str>) -> Result<KisAccountSettings, ApiFailure> {
    KisAccountSettings::read(account_no, hts_id).map_err(ApiFailure::bad_request)
}

fn refuse_mock(st: &AppState) -> Result<(), ApiFailure> {
    if st.system.environment == KiwoomEnvironment::Mock { Err(mock_key_conflict()) } else { Ok(()) }
}

async fn put_key(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<KiwoomLinkStatus>, ApiFailure> {
    let input: api::KiwoomKeyInput = read_body(body).await?;
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    let credentials = checked_credentials(&input.app_key, &input.app_secret)?;
    st.market_control.save_market_credentials(credentials).await.map_err(key_failure)?;
    st.system.set_key_file_problem(None);
    tracing::info!("키움 키를 저장했습니다");
    Ok(Json(kiwoom_status(&st)))
}

async fn delete_key(State(st): State<Arc<AppState>>) -> Result<Json<KiwoomLinkStatus>, ApiFailure> {
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    st.market_control.remove_market_key().await.map_err(key_failure)?;
    st.system.set_key_file_problem(None);
    tracing::info!("키움 키를 지웠습니다");
    Ok(Json(kiwoom_status(&st)))
}

async fn list_keys(State(st): State<Arc<AppState>>) -> Json<api::KiwoomKeyList> {
    Json(key_list(&st))
}

async fn add_key(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let input: api::KiwoomKeyAdd = read_body(body).await?;
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    let credentials = checked_credentials(&input.app_key, &input.app_secret)?;
    let broker = input.broker.unwrap_or(Broker::Kiwoom);
    let account = checked_kis_account(input.account_no.as_deref(), input.hts_id.as_deref())?;
    st.market_control.add_key(broker, &input.alias, credentials, account).await.map_err(key_failure)?;
    st.system.set_key_file_problem(None);
    tracing::info!(broker = ?broker, "키를 더했습니다");
    Ok(Json(key_list(&st)))
}

async fn rename_key(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let input: api::KiwoomKeyAlias = read_body(body).await?;
    let id = key_id(&id)?;
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    st.market_control.rename_key(&id, &input.alias).map_err(key_failure)?;
    Ok(Json(key_list(&st)))
}

async fn replace_key(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let input: api::KiwoomKeyInput = read_body(body).await?;
    let id = key_id(&id)?;
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    let credentials = checked_credentials(&input.app_key, &input.app_secret)?;
    let account = match input.account_no.as_deref() {
        Some(account_no) => Some(checked_kis_account(Some(account_no), input.hts_id.as_deref())?),
        None => None,
    };
    st.market_control.replace_key(&id, credentials, account).await.map_err(key_failure)?;
    st.system.set_key_file_problem(None);
    tracing::info!("키움 키를 바꿨습니다");
    Ok(Json(key_list(&st)))
}

async fn put_kis_account(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let input: api::KisAccountInput = read_body(body).await?;
    let id = key_id(&id)?;
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    let account = checked_kis_account(Some(&input.account_no), input.hts_id.as_deref())?;
    st.market_control.set_kis_account(&id, account, &st.accounts).map_err(key_failure)?;
    tracing::info!("한투 키의 계좌번호·HTS ID를 바꿨습니다");
    Ok(Json(key_list(&st)))
}

async fn delete_key_by_id(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let id = key_id(&id)?;
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    st.market_control.remove_key(&id).await.map_err(key_failure)?;
    tracing::info!("키움 키를 지웠습니다");
    Ok(Json(key_list(&st)))
}

async fn put_market_key(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let input: api::KiwoomMarketKeyInput = read_body(body).await?;
    let id = key_id(&input.key_id)?;
    let _write = st.system.write.lock().await;
    refuse_mock(&st)?;
    st.market_control.designate_market(&id).await.map_err(key_failure)?;
    tracing::info!("시세 키를 바꿨습니다");
    Ok(Json(key_list(&st)))
}

async fn connect_key(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let input: api::KiwoomConnectInput = read_body(body).await?;
    let key = st.keys.listed_key(&key_id(&id)?).ok_or_else(|| key_failure(KeyError::Unknown))?;
    match key.connection {
        Connection::Kiwoom { lane, .. } => drop(lane.link.connect_until_waiting(input.acknowledged).await),
        Connection::Kis(lane) => drop(lane.link.connect_until_waiting().await),
    }
    Ok(Json(key_list(&st)))
}

async fn disconnect_key(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<api::KiwoomKeyList>, ApiFailure> {
    let key = st.keys.listed_key(&key_id(&id)?).ok_or_else(|| key_failure(KeyError::Unknown))?;
    match key.connection {
        Connection::Kiwoom { lane, .. } => lane.link.disconnect_by_user(),
        Connection::Kis(lane) => lane.link.disconnect_by_user(),
    }
    Ok(Json(key_list(&st)))
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
    let registered = api::RegisteredIp { ip: ip.to_string(), at: UnixSeconds(st.clock.now().unix()) };
    st.keys.record_registered_ip(registered).map_err(|e| match e {
        KeyError::NoStore => ApiFailure::new(ApiErrorCode::Internal, "등록 IP 파일 위치가 정해지지 않았습니다"),
        other => ApiFailure::new(ApiErrorCode::Internal, format!("등록한 IP를 파일에 쓰지 못했습니다: {other}")),
    })?;
    tracing::info!("포털에 등록한 공인 IP를 기록했습니다");
    Ok(Json(kiwoom_status(&st)))
}

async fn get_settings(State(st): State<Arc<AppState>>) -> Result<Json<api::SystemSettings>, ApiFailure> {
    st.system.settings.clone().map(Json).ok_or_else(|| ApiFailure::new(ApiErrorCode::Internal, "설정 값이 준비되지 않았습니다"))
}

pub fn kiwoom_status(st: &AppState) -> KiwoomLinkStatus {
    let market = st.keys.market();
    let source = match market.as_ref().map(|view| view.origin) {
        Some(origin) => key_source(origin),
        None if st.rest.auth().has_credentials() => KeySource::File,
        None => KeySource::None,
    };
    link_status(st, &st.rest, &st.link, source, st.keys.registered_ip(), true)
}

fn key_source(origin: KeyOrigin) -> KeySource {
    match origin {
        KeyOrigin::Env => KeySource::Env,
        KeyOrigin::File => KeySource::File,
    }
}

fn key_list(st: &AppState) -> api::KiwoomKeyList {
    api::KiwoomKeyList { limit: KEY_LIMIT as u32, keys: st.keys.listing().iter().map(|key| key_entry(st, key)).collect(), key_file_problem: st.system.key_file_problem() }
}

fn key_entry(st: &AppState, key: &ListedKey) -> api::KiwoomKey {
    let source = key_source(key.origin);
    let link = match &key.connection {
        Connection::Kiwoom { lane, registered_ip } => link_status(st, &lane.rest, &lane.link, source, registered_ip.clone(), key.market),
        Connection::Kis(lane) => kis_link_status(st, lane, source),
    };
    let kis_account = (key.broker == Broker::Kis).then(|| api::KisAccountListing {
        account_tail: key.account.number.as_ref().map(|number| number.tail()),
        account_masked: key.account.number.as_ref().map(|number| number.masked()),
        hts_id_set: key.account.hts_id.is_some(),
        source,
    });
    api::KiwoomKey { key_id: key.id.to_string(), alias: key.alias.clone(), broker: key.broker, source, app_key_tail: key.app_key_tail.clone(), market: key.market, link, kis_account }
}

fn kis_link_status(st: &AppState, lane: &crate::kis::link::KisLane, key_source: KeySource) -> KiwoomLinkStatus {
    let auth = lane.rest.auth();
    let mut status = KiwoomLinkStatus {
        environment: st.system.environment,
        key_source,
        app_key_tail: auth.app_key_tail(),
        credential_id: Some(auth.credential_prefix()),
        state: KiwoomLinkState::Disconnected,
        problem: None,
        message: String::new(),
        retry_at: None,
        needs_acknowledgement: false,
        step: None,
        token_expires_at: None,
        realtime_registered: None,
        symbol_count: None,
        registered_ip: None,
        at_start: Some(if lane.link.kept_disconnected() { KiwoomAtStart::KeptDisconnected } else { KiwoomAtStart::Connects }),
    };
    match lane.link.state() {
        LinkState::NoKey | LinkState::Disconnected => {
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
                status.message = "한투 토큰 발급 간격을 기다리는 중입니다. 간격이 끝나면 저절로 연결합니다".to_owned();
            } else {
                status.message = "한투에 연결하는 중입니다".to_owned();
            }
        }
        LinkState::Connected => {
            status.state = KiwoomLinkState::Connected;
            status.message = "한투에 연결됨".to_owned();
            status.token_expires_at = auth.token_expires_at().map(|t| UnixSeconds(t.unix()));
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

fn link_status(st: &AppState, rest: &crate::kiwoom::rest::KiwoomRest, link: &crate::kiwoom::link::Link, key_source: KeySource, registered_ip: Option<api::RegisteredIp>, market: bool) -> KiwoomLinkStatus {
    let summary = rest.auth().credential_summary();
    let summary_present = summary.is_some();
    let mut status = KiwoomLinkStatus {
        environment: st.system.environment,
        key_source,
        app_key_tail: summary.as_ref().and_then(|s| s.app_key_tail.clone()),
        credential_id: summary.map(|s| s.credential_prefix),
        state: KiwoomLinkState::NoKey,
        problem: None,
        message: String::new(),
        retry_at: None,
        needs_acknowledgement: link.needs_acknowledgement(),
        step: None,
        token_expires_at: None,
        realtime_registered: None,
        symbol_count: None,
        registered_ip,
        at_start: None,
    };
    status.at_start = summary_present.then(|| if rest.auth().kept_disconnected() { KiwoomAtStart::KeptDisconnected } else { KiwoomAtStart::Connects });
    match link.state() {
        LinkState::NoKey => match st.system.key_file_problem() {
            Some(problem) => {
                status.state = KiwoomLinkState::Failed;
                status.problem = Some(KiwoomLinkProblem::KeyFileUnusable);
                status.message = format!("키 파일을 쓸 수 없어 키 없이 켰습니다({problem})");
            }
            None if st.system.environment == KiwoomEnvironment::Mock => status.message = "모의투자 키가 없습니다. VALLY_KIWOOM_MOCK_APP_KEY와 VALLY_KIWOOM_MOCK_APP_SECRET을 설정하고 서버를 다시 켭니다".to_owned(),
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
            status.token_expires_at = rest.auth().token_expires_at().map(|t| UnixSeconds(t.unix()));
            if market {
                status.realtime_registered = Some(count(st.seat_rules.seats(&st.registered.borrow())));
                status.symbol_count = st.symbols.updates().borrow().as_ref().map(|directory| count(directory.len()));
            }
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

pub(crate) fn connect_step(step: ConnectStep) -> KiwoomConnectStep {
    match step {
        ConnectStep::CheckingKey => KiwoomConnectStep::CheckingKey,
        ConnectStep::Token => KiwoomConnectStep::Token,
        ConnectStep::IssueInterval(_) => KiwoomConnectStep::IssueInterval,
        ConnectStep::Symbols => KiwoomConnectStep::Symbols,
        ConnectStep::Realtime => KiwoomConnectStep::Realtime,
    }
}

pub(crate) fn problem(problem: Problem) -> KiwoomLinkProblem {
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
