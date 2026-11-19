//! 서버를 켜는 순서와 하루 타이머(backend.md §4.1, §6.2, §6.6).
//!
//! 순서: 설정 → 잠금 파일 → 사용자 자료 DB → 포트 열기 → 토큰 파일 읽기(키움 요청 없음) → 요청 받기.
//! 잠금은 키움 요청보다 먼저다. 두 번째 서버는 키움에 아무것도 보내지 않고 끝난다.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use domain::{KstTime, TimeOfDay};
use tokio::net::TcpListener;
use tracing::{Level, Metadata};
use tracing_subscriber::{Layer, Registry};
use tracing_subscriber::filter::{FilterExt, filter_fn};
use tracing_subscriber::layer::{Filter, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

use crate::account::{AccountState, AccountStateFile};
use crate::bars::BarService;
use crate::clock::{Clock, next_daily};
use crate::config::Config;
use crate::db::AppDb;
use crate::http::{AppState, router};
use crate::instance::InstanceLock;
use crate::market::hub::{HubHandle, MarketHub};
use crate::kiwoom::auth::{DAILY_REISSUE_AT, KiwoomAuth};
use crate::kiwoom::link::{Link, LinkState};
use crate::kiwoom::rest::{KiwoomRest, Priority};
use crate::kiwoom::stream::KiwoomStream;
use crate::kiwoom::token_file::TokenFile;
use crate::kiwoom::transport::{ReqwestTransport, Transport};
use crate::screener::Screener;
use crate::screener::store::Store;
use crate::symbols::SymbolDirectory;
use crate::system_routes::SystemState;
use crate::kiwoom::key_file::{KeyFile, startup_key};

const DAILY_RESET_AT: TimeOfDay = match TimeOfDay::hms(7, 45, 0) {
    Some(t) => t,
    None => unreachable!(),
};
const DAILY_LIST_RETRY: Duration = Duration::from_secs(5 * 60);
const DAILY_TOKEN_RETRY: Duration = Duration::from_secs(10 * 60);

pub fn main() -> ExitCode {
    let (config, warnings) = match Config::from_env() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("설정 오류: {e}");
            return ExitCode::from(1);
        }
    };
    init_logging(&config.log_filter);
    for w in warnings {
        tracing::warn!("{w}");
    }
    let lock = match InstanceLock::acquire(&config.lock_path) {
        Ok(lock) => lock,
        Err(e) => {
            tracing::error!("{e}");
            return ExitCode::from(1);
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!(error = %e, "tokio 런타임을 만들 수 없습니다");
            return ExitCode::from(1);
        }
    };
    let code = runtime.block_on(serve(config, &lock));
    drop(lock);
    code
}

fn init_logging(filter: &str) {
    tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr).with_ansi(false).with_filter(log_filter(filter))).init();
}

/// tungstenite는 trace에서 보내는 프레임 내용을 그대로 찍는다. LOGIN 프레임에는 토큰이 있다.
/// EnvFilter 안의 지시문은 더 구체적인 target이 이기므로, 사용자 지시문과 따로 거른다.
const WS_LIBRARIES: [&str; 2] = ["tungstenite", "tokio_tungstenite"];

fn below_ws_library_trace(meta: &Metadata<'_>) -> bool {
    let target = meta.target();
    let from_ws_library = WS_LIBRARIES.iter().any(|lib| target.strip_prefix(lib).is_some_and(|rest| rest.is_empty() || rest.starts_with("::")));
    let from_http_library = target == "reqwest" || target.starts_with("reqwest::");
    (!from_ws_library || *meta.level() <= Level::DEBUG) && (!from_http_library || *meta.level() <= Level::INFO)
}

fn log_filter(spec: &str) -> impl Filter<Registry> + Send + Sync + 'static {
    let user = tracing_subscriber::EnvFilter::try_new(spec).unwrap_or_else(|e| {
        eprintln!("VALLY_LOG를 읽을 수 없어 info로 둡니다: {e}");
        tracing_subscriber::EnvFilter::new("info")
    });
    user.and(filter_fn(below_ws_library_trace))
}

pub struct ApplicationInputs {
    pub rest: KiwoomRest,
    pub clock: Clock,
    pub symbols: Arc<SymbolDirectory>,
    pub db: AppDb,
    pub screener_store: Store,
    pub stream: (KiwoomStream, tokio::sync::mpsc::Receiver<crate::kiwoom::stream::StreamEvent>),
    pub static_dir: std::path::PathBuf,
    pub screener_update_on_connect: bool,
}

pub fn application(inputs: ApplicationInputs) -> Arc<AppState> {
    application_with_system(inputs, SystemState::unconfigured())
}

pub fn application_with_system(inputs: ApplicationInputs, system: SystemState) -> Arc<AppState> {
    let ApplicationInputs { rest, clock, symbols, db, screener_store, stream: (stream, events), static_dir, screener_update_on_connect } = inputs;
    let bars = Arc::new(BarService::new(rest.clone(), symbols.clone(), clock.clone()));
    let screener = Arc::new(Screener::new(screener_store, rest.clone(), bars.clone(), symbols.clone(), clock.clone()));
    let registered = stream.watch_desired();
    let trading = crate::trading::Trading::new(rest.clone(), clock.clone(), system.order_switch_store(), stream.account_feed(), db.clone(), symbols.clone());
    let hub = MarketHub::spawn(bars.clone(), stream, events, clock.clone());
    let link = Link::new(rest.clone(), symbols.clone(), screener.clone(), clock.clone(), screener_update_on_connect);
    Arc::new(AppState { symbols, bars, rest, db, clock, static_dir, hub, screener, link, system, registered, trading, rankings: Default::default(), market_overview: Default::default(), etf: Default::default() })
}

pub async fn daily_maintenance(state: Arc<AppState>) {
    tokio::join!(
        daily_reset(state.clock.clone(), state.rest.clone(), state.symbols.clone(), state.bars.clone(), state.hub.clone(), state.link.clone()),
        daily_token(state.clock.clone(), state.rest.clone(), state.link.clone()),
    );
}

pub enum StreamSource {
    Connect,
    Detached(tokio::sync::mpsc::Receiver<crate::kiwoom::stream::StreamEvent>),
}

pub struct Adapters {
    pub kiwoom: Arc<dyn Transport>,
    pub stream: StreamSource,
    pub kiwoom_spacing: Option<Duration>,
    pub dart_spacing: Option<Duration>,
}

impl Adapters {
    pub fn production(config: &Config) -> Result<Adapters, StartFailure> {
        match ReqwestTransport::new(config.kiwoom_base_url.clone()) {
            Ok(transport) => Ok(Adapters { kiwoom: Arc::new(transport), stream: StreamSource::Connect, kiwoom_spacing: None, dart_spacing: None }),
            Err(e) => {
                tracing::error!(error = %e, "HTTP 클라이언트를 만들 수 없습니다");
                Err(StartFailure)
            }
        }
    }
}

#[derive(Debug)]
pub struct StartFailure;

pub struct Started {
    pub state: Arc<AppState>,
    pub router: axum::Router,
    pub listener: TcpListener,
    pub automatic: Option<tokio::task::JoinHandle<()>>,
}

async fn serve(config: Config, lock: &InstanceLock) -> ExitCode {
    let Ok(adapters) = Adapters::production(&config) else { return ExitCode::from(1) };
    let Ok(started) = start(&config, lock, adapters).await else { return ExitCode::from(1) };
    started.state.link.connect_at_start();
    tracing::info!(static_dir = %config.static_dir.display(), "요청을 받기 시작합니다");
    if let Err(e) = axum::serve(started.listener, started.router).with_graceful_shutdown(shutdown_signal()).await {
        tracing::error!(error = %e, "서버가 멈췄습니다");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

pub async fn start(config: &Config, lock: &InstanceLock, adapters: Adapters) -> Result<Started, StartFailure> {
    let Adapters { kiwoom, stream: stream_source, kiwoom_spacing, dart_spacing } = adapters;
    let token_file = TokenFile::new(config.token_path.clone(), lock).with_environment(config.kiwoom_environment);
    let key_file = KeyFile::new(config.kiwoom_key_path.clone(), lock).with_environment(config.kiwoom_environment);
    let account_file = config.account_state_path.clone().map(|path| AccountStateFile::new(path, lock));
    tracing::info!(environment = config.kiwoom_environment.as_str(), host = %crate::system_routes::kiwoom_target(&config.kiwoom_base_url).host.as_deref().unwrap_or("loopback"), "키움 투자구분으로 켭니다");
    let db = match AppDb::open_in(&config.db_path, config.kiwoom_environment).await {
        Ok(db) => db,
        Err(e) => {
            tracing::error!(path = %config.db_path.display(), error = %e, "사용자 자료 DB를 열 수 없습니다");
            return Err(StartFailure);
        }
    };
    tracing::info!(path = %config.db_path.display(), "사용자 자료 DB를 열었습니다");
    let screener_path = config.screener_db_path.clone();
    let dispatcher = tracing::dispatcher::get_default(Clone::clone);
    let screener_store = match tokio::task::spawn_blocking(move || tracing::dispatcher::with_default(&dispatcher, || Store::open(&screener_path))).await {
        Ok(Ok(store)) => store,
        Ok(Err(e)) => {
            tracing::error!(path = %config.screener_db_path.display(), error = %e, "스크리너 저장소를 열 수 없습니다");
            return Err(StartFailure);
        }
        Err(e) => {
            tracing::error!(path = %config.screener_db_path.display(), error = %e, "스크리너 저장소를 여는 작업이 끝나지 못했습니다");
            return Err(StartFailure);
        }
    };
    tracing::info!(path = %config.screener_db_path.display(), "스크리너 저장소를 열었습니다");
    let listener = match TcpListener::bind(config.bind.socket_addr()).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(addr = %config.bind.socket_addr(), error = %e, "포트를 열 수 없습니다");
            return Err(StartFailure);
        }
    };
    let bound_addr = match listener.local_addr() {
        Ok(addr) => {
            tracing::info!(%addr, "포트를 열었습니다");
            addr
        }
        Err(e) => {
            tracing::error!(error = %e, "연 주소를 읽지 못했습니다");
            return Err(StartFailure);
        }
    };
    let clock = match config.clock_start {
        None => Clock::system(),
        Some(start) => {
            tracing::warn!(%start, "시험용 시계로 켭니다(VALLY_CLOCK_START)");
            Clock::fake(start)
        }
    };
    let env_key = config.kiwoom_credentials.is_some();
    let startup = startup_key(config.kiwoom_credentials.clone(), &key_file, config.kiwoom_environment);
    let auth = match &startup.credentials {
        Some(credentials) => KiwoomAuth::new(credentials.app_key.clone(), credentials.app_secret.clone(), Some(token_file)),
        None => KiwoomAuth::keyless(Some(token_file)),
    };
    let rest = match kiwoom_spacing {
        None => KiwoomRest::for_environment(kiwoom, auth, clock.clone(), config.kiwoom_environment),
        Some(spacing) => KiwoomRest::build(kiwoom, auth, clock.clone(), spacing, config.kiwoom_environment),
    };
    rest.set_access(crate::kiwoom::rest::Access::Closed);
    let symbols = Arc::new(SymbolDirectory::default());
    let stream = match stream_source {
        StreamSource::Connect => KiwoomStream::spawn(config.kiwoom_ws_url.clone(), rest.clone(), clock.clone()),
        StreamSource::Detached(events) => (KiwoomStream::detached().0, events),
    };
    let public_ip = match crate::public_ip::ReqwestPublicIp::new(config.public_ip_url.clone()) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "공인 IP 확인용 HTTP 클라이언트를 만들 수 없습니다");
            return Err(StartFailure);
        }
    };
    let account = match (&config.account_server_url, account_file) {
        (Some(url), Some(file)) => match AccountState::linked(url.clone(), file) {
            Ok(account) => account,
            Err(e) => {
                tracing::error!(error = %e, "계정 서버용 HTTP 클라이언트를 만들 수 없습니다");
                return Err(StartFailure);
            }
        },
        _ => AccountState::local_only(),
    };
    let mut collector = crate::collector::CollectorBoard::configured(config.collector_admins.clone(), config.collector_socket.clone(), account.is_linked());
    if let Some(board) = collector.take() {
        let webhook_path = config.collector_webhook.clone().or_else(|| std::env::var_os("HOME").filter(|home| !home.is_empty()).map(|home| crate::collector::webhook::default_path(std::path::Path::new(&home))));
        let webhook = match webhook_path.map(|path| crate::collector::webhook::Webhook::load(&path)).transpose() {
            Ok(webhook) => webhook.flatten(),
            Err(e) => {
                tracing::error!(error = %e, "수집 경보 웹훅 주소 파일을 쓸 수 없습니다");
                return Err(StartFailure);
            }
        };
        collector = Some(board.with_webhook(webhook));
    }
    let system = SystemState::new(key_file, env_key, startup.file_problem, crate::api::SystemSettings::from_config(config)).with_public_ip(Arc::new(public_ip)).with_account(account).with_collector(collector);
    let state = application_with_system(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols: symbols.clone(), db, screener_store, stream, static_dir: config.static_dir.clone(), screener_update_on_connect: config.screener_update_on_start }, system);
    state.system.bound(bound_addr);
    tokio::spawn(daily_maintenance(state.clone()));
    tokio::spawn(crate::account::sync::run(state.clone()));
    tokio::spawn(crate::collector::run(state.clone()));
    crate::market_overview::start(state.clone(), config.market_samples_dir.clone());
    crate::etf::start_collection(state.clone(), config.etf_pdf_dir.clone(), config.naver_base_url.clone());

    let financial_store = crate::financials::store::Store::open(&config.financial_db_path).await;
    if let Err(failure) = financial_store { tracing::warn!(?failure, "재무 저장소를 열 수 없습니다"); }
    let dart = config.opendart_api_key.clone().and_then(|key| match dart_spacing {
        None => crate::financials::client::Client::new(key, config.dart_base_url.clone(), config.kind_base_url.clone()),
        Some(spacing) => crate::financials::client::Client::with_spacing(key, config.dart_base_url.clone(), config.kind_base_url.clone(), spacing),
    }.ok());
    let financials = crate::financials::Financials::with_store(dart, financial_store, clock.clone());
    let automatic = config.financial_automatic.then(|| financials.start_automatic(symbols.clone()));
    let financial_routes = crate::financials::routes(financials, symbols.clone());
    let router = router(state.clone()).merge(financial_routes);
    Ok(Started { state, router, listener, automatic })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("끝냅니다");
}

pub(crate) fn next_try(clock: &Clock, retry_at: KstTime, at_least: Duration) -> KstTime {
    retry_at.max(clock.now().plus_secs(at_least.as_secs() as i64))
}

async fn daily_reset(clock: Clock, rest: KiwoomRest, symbols: Arc<SymbolDirectory>, bars: Arc<BarService>, hub: HubHandle, link: Link) {
    loop {
        clock.sleep_until(next_daily(clock.now(), DAILY_RESET_AT)).await;
        bars.clear_all();
        hub.daily_reset();
        if !link.is_connected() {
            continue;
        }
        let deadline = next_daily(clock.now(), DAILY_RESET_AT);
        while let Err(e) = symbols.refresh(&rest, Priority::Background).await {
            let Some(retry_at) = e.retry_at() else {
                tracing::error!(error = %e, "07:45 종목 목록 갱신에 실패했습니다. 이전 목록을 쓰고 다시 받지 않습니다");
                break;
            };
            let at = next_try(&clock, retry_at, DAILY_LIST_RETRY);
            if at >= deadline {
                break;
            }
            tracing::warn!(error = %e, %at, "종목 목록 갱신에 실패했습니다. 이전 목록을 쓰고 그 시각에 다시 받습니다");
            clock.sleep_until(at).await;
        }
    }
}

/// 매일 20:05: 그날 20:05 전에 받은 토큰이면 다시 받는다. 실패하면 07:45까지 10분마다.
async fn daily_token(clock: Clock, rest: KiwoomRest, link: Link) {
    loop {
        clock.sleep_until(next_daily(clock.now(), DAILY_REISSUE_AT)).await;
        if link.settled().await != LinkState::Connected || rest.halted().is_some() || !rest.auth().due_daily_reissue(clock.now()) {
            continue;
        }
        let deadline = next_daily(clock.now(), DAILY_RESET_AT);
        while let Err(e) = rest.issue_token().await {
            let Some(retry_at) = e.retry_at() else {
                tracing::error!(error = %e, "20:05 토큰 발급에 실패했습니다. 다시 받지 않습니다");
                break;
            };
            let at = next_try(&clock, retry_at, DAILY_TOKEN_RETRY);
            if at >= deadline {
                tracing::error!(error = %e, "20:05 토큰 발급이 07:45까지 실패했습니다");
                break;
            }
            tracing::warn!(error = %e, %at, "20:05 토큰 발급에 실패했습니다. 그 시각에 다시 받습니다");
            clock.sleep_until(at).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    use crate::kiwoom::rest::testing::FakeTransport;
    use crate::kiwoom::wire::TokenResponse;

    const TOKEN: &str = "ws-log-filter-regression-token";

    use super::*;
    use crate::config::Secret;
    use crate::kiwoom::stream::{KiwoomStream, StreamEvent};

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    async fn logs_of_one_ws_login(filter: impl Filter<Registry> + Send + Sync + 'static) -> String {
        let out = Captured::default();
        let writer = out.clone();
        let subscriber = tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_writer(move || writer.clone()).with_ansi(false).with_filter(filter));
        let _guard = tracing::subscriber::set_default(subscriber);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let Message::Text(login) = socket.next().await.unwrap().unwrap() else { panic!("LOGIN frame") };
            assert_eq!(serde_json::from_str::<serde_json::Value>(login.as_str()).unwrap(), serde_json::json!({"trnm":"LOGIN", "token":TOKEN}));
            socket.send(Message::Text(r#"{"trnm":"LOGIN","return_code":0}"#.into())).await.unwrap();
            let _ = socket.next().await;
        });
        let clock = Clock::system();
        let transport = Arc::new(FakeTransport::new(Duration::ZERO, |_| panic!("current token needs no HTTP request")));
        let rest = KiwoomRest::new(Arc::new(transport), KiwoomAuth::new(Secret::new("key".into()), Secret::new("secret".into()), None), clock.clone());
        rest.auth().record_issued(TokenResponse { token: TOKEN.into(), expires_dt: "20991231000000".into() }, clock.now()).unwrap();
        let (stream, mut events) = KiwoomStream::spawn(url, rest, clock);
        let live = tokio::time::timeout(Duration::from_secs(3), events.recv()).await.unwrap();
        assert!(matches!(live, Some(StreamEvent::Live { .. })), "{live:?}");
        drop(stream);
        tokio::time::timeout(Duration::from_secs(3), peer).await.unwrap().unwrap();
        String::from_utf8(out.0.lock().unwrap().clone()).unwrap()
    }

    #[tokio::test]
    async fn trace_logs_never_carry_the_ws_login_token() {
        let _ = tracing_log::LogTracer::init();
        let hex: String = TOKEN.bytes().map(|b| format!("{b:02x}")).collect();
        let leaks = |logs: &str| logs.contains(TOKEN) || logs.contains(&hex);
        let uncapped = logs_of_one_ws_login(tracing_subscriber::EnvFilter::new("trace")).await;
        assert!(leaks(&uncapped), "막지 않으면 tungstenite가 LOGIN 프레임을 찍는다(이 시험이 새는 것을 알아본다)");
        let capped = logs_of_one_ws_login(log_filter("trace")).await;
        assert!(capped.contains("키움 WebSocket 상태"), "로그는 그대로 남는다");
        assert!(!leaks(&capped));
    }

    #[tokio::test]
    async fn a_more_specific_trace_target_still_cannot_log_the_ws_login_token() {
        let _ = tracing_log::LogTracer::init();
        let hex: String = TOKEN.bytes().map(|b| format!("{b:02x}")).collect();
        let logs = logs_of_one_ws_login(log_filter("info,tungstenite::protocol=trace,tokio_tungstenite=trace")).await;
        assert!(logs.contains("키움 WebSocket 상태"), "로그는 그대로 남는다");
        assert!(!logs.contains(TOKEN), "평문 토큰");
        assert!(!logs.contains(&hex), "16진 토큰");
    }
}
