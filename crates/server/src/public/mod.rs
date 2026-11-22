
mod errors;
mod gate;
mod kiwoom_guard;
mod limits;
mod origin;
mod server_mode;
pub mod settings;
pub mod static_files;
mod user_data;
pub mod usage;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use futures::future::BoxFuture;
use crate::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{Method, Uri};
use axum::middleware::{Next, from_fn_with_state, map_response};
use axum::response::{Json, Response};
use axum::routing::{any, get};
use tokio::net::TcpListener;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::{CompressionLayer, CompressionLevel};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;

pub use self::server_mode::{ServerMode, ServerModeKind, local as server_mode_local};
use self::settings::{Limits, PublicOrigin, PublicSettings};
use self::static_files::StaticSite;
use self::usage::{Bundle, Usage, UsageSnapshot};
use crate::app::StartFailure;
use crate::clock::Clock;
use crate::config::Config;
use crate::http::AppState;

pub const CSP: &str = include_str!("csp.txt");
pub const BODY_LIMIT_BYTES: usize = 8 * 1024 * 1024;
const COMPRESSION_QUALITY: i32 = 4;
const USAGE_LOG_EVERY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct Principal {
    pub account_id: String,
    pub key: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AccountMark(pub String);

pub(crate) struct Runtime {
    pub(super) state: Arc<AppState>,
    pub(super) origin: PublicOrigin,
    pub(super) limits: Limits,
    pub(super) accounts: account_server::Accounts,
    pub(super) clock: Clock,
    pub(super) usage: Arc<Usage>,
    pub(super) meters: gate::Meters,
    pub(super) flight: gate::Flight,
    pub(super) kiwoom: kiwoom_guard::KiwoomGuard,
    pub(super) sends: Arc<AtomicU64>,
    pub(super) setup: user_data::Setup,
}

pub struct PublicListener {
    pub listener: TcpListener,
    runtime: Arc<Runtime>,
    browser_login: Router,
    financial_reads: Router,
    site: Arc<StaticSite>,
}

struct CountingTransport {
    inner: Arc<dyn Transport>,
    sent: Arc<AtomicU64>,
}

impl Transport for CountingTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        self.sent.fetch_add(1, Ordering::Relaxed);
        self.inner.send(request)
    }
}

pub fn counted(inner: Arc<dyn Transport>) -> (Arc<dyn Transport>, Arc<AtomicU64>) {
    let sent = Arc::new(AtomicU64::new(0));
    (Arc::new(CountingTransport { inner, sent: sent.clone() }), sent)
}

pub async fn start(config: &Config, state: Arc<AppState>, financial_routes: Router, sends: Arc<AtomicU64>) -> Result<Option<PublicListener>, StartFailure> {
    let Some(settings) = config.public.clone() else { return Ok(None) };
    let PublicSettings { bind, origin, account, limits } = settings;
    let listener = TcpListener::bind(bind.socket_addr()).await.map_err(|e| {
        tracing::error!(addr = %bind.socket_addr(), error = %e, "공개 포트를 열 수 없습니다");
        StartFailure
    })?;
    let account_settings = account.0;
    if let Some(parent) = account_settings.database_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| {
            tracing::error!(path = %parent.display(), error = %e, "공개 계정 DB 폴더를 만들 수 없습니다");
            StartFailure
        })?;
    }
    let pool = account_server::open_database(&account_settings.database_path).await.map_err(|e| {
        tracing::error!(path = %account_settings.database_path.display(), error = %e, "공개 계정 DB를 열 수 없습니다");
        StartFailure
    })?;
    let accounts = account_server::Accounts::new(account_settings.config.clone(), account_settings.account_options(), pool, Arc::new(account_server::SystemClock));
    let loading = std::time::Instant::now();
    let site = StaticSite::load(config.static_dir.clone()).await.map_err(|e| {
        tracing::error!(path = %config.static_dir.display(), error = %e, "공개 화면 파일을 읽을 수 없습니다");
        StartFailure
    })?;
    tracing::info!(path = %config.static_dir.display(), elapsed_ms = loading.elapsed().as_millis() as u64, "공개 화면 파일을 메모리에 올렸습니다");
    let setup = user_data::Setup::load().await.map_err(|e| {
        tracing::error!(error = %e, "공개 셋업 기본값을 만들 수 없습니다");
        StartFailure
    })?;
    let now = state.clock.now().unix();
    state.public_usage.started(now);
    let runtime = Arc::new(Runtime {
        origin,
        accounts: accounts.clone(),
        clock: state.clock.clone(),
        usage: state.public_usage.clone(),
        meters: gate::Meters::new(&limits, now),
        flight: gate::Flight::new(&limits),
        kiwoom: kiwoom_guard::KiwoomGuard::new(&limits),
        sends,
        setup,
        limits,
        state,
    });
    tokio::spawn(log_usage_every_minute(runtime.usage.clone(), runtime.clock.clone()));
    let financial_reads = financial_routes.route_layer(axum::middleware::from_fn(kiwoom_guard::financial_reads));
    tracing::info!(addr = %bind.socket_addr(), origin = %runtime.origin.origin, "공개 리스너를 엽니다");
    Ok(Some(PublicListener { listener, runtime, browser_login: accounts.browser_router(), financial_reads, site: Arc::new(site) }))
}

async fn log_usage_every_minute(usage: Arc<Usage>, clock: Clock) {
    let mut ticks = tokio::time::interval(USAGE_LOG_EVERY);
    ticks.tick().await;
    loop {
        ticks.tick().await;
        if let Some(line) = usage.take_minute_line(clock.now().unix()) {
            tracing::info!("{line}");
        }
    }
}

impl PublicListener {
    pub fn router(&self) -> Router {
        self.router_with(Router::new())
    }

    pub fn router_with(&self, extra: Router<Arc<AppState>>) -> Router {
        let runtime = self.runtime.clone();
        let rankings = crate::rankings::routes().route_layer(from_fn_with_state(runtime.clone(), kiwoom_guard::rankings));
        let market = crate::market_overview::routes().route_layer(from_fn_with_state(runtime.clone(), kiwoom_guard::market_overview));
        let screener = crate::screener::routes().route_layer(from_fn_with_state(runtime.clone(), kiwoom_guard::screener));
        let heatmap = Router::<Arc<Runtime>>::new()
            .route("/api/heatmap/board", get(kiwoom_guard::heatmap_board))
            .route("/api/heatmap/flow", get(kiwoom_guard::heatmap_flow))
            .merge(user_data::routes())
            .with_state(runtime.clone());
        let shared = Router::new()
            .route("/api/server-mode", get(server_mode::public))
            .merge(heatmap)
            .route("/api/symbols", get(crate::http::search))
            .route("/api/symbols/{code}", get(crate::http::symbol))
            .merge(rankings)
            .merge(market)
            .merge(crate::etf::routes())
            .merge(screener)
            .merge(crate::collector::routes())
            .merge(extra)
            .with_state(runtime.state.clone());
        let site = self.site.clone();
        let api = shared
            .merge(self.financial_reads.clone())
            .route("/api", any(not_found))
            .route("/api/{*rest}", any(not_found))
            .route("/v1", any(not_found))
            .route("/auth/{*rest}", any(not_found))
            .route("/v1/{*rest}", any(v1_proxy).with_state(self.browser_login.clone()))
            .layer(from_fn_with_state(runtime.clone(), gate::gate));
        let finish_state = runtime.clone();
        Router::new()
            .merge(api)
            .fallback(move |method: Method, uri: Uri, headers: axum::http::HeaderMap| {
                let site = site.clone();
                async move {
                    let mut response = site.respond(&method, uri.path(), &headers);
                    response.extensions_mut().insert(PreEncoded);
                    response
                }
            })
            .layer(from_fn_with_state(runtime.clone(), origin::check))
            .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES))
            .layer(TimeoutLayer::with_status_code(axum::http::StatusCode::SERVICE_UNAVAILABLE, runtime.limits.request_timeout))
            .layer(CatchPanicLayer::custom(|_| errors::internal()))
            .layer(from_fn_with_state(finish_state, finish))
            .layer(compression())
            .layer(map_response(|mut response: Response| async move {
                errors::security_headers(&mut response, CSP.trim());
                response
            }))
    }

    pub fn local_addr(&self) -> std::io::Result<std::net::SocketAddr> {
        self.listener.local_addr()
    }
}

#[derive(Clone, Copy)]
struct PreEncoded;

#[derive(Clone, Copy)]
struct NotPreEncoded;

impl Predicate for NotPreEncoded {
    fn should_compress<B>(&self, response: &axum::http::Response<B>) -> bool
    where
        B: axum::body::HttpBody,
    {
        response.extensions().get::<PreEncoded>().is_none()
    }
}

pub fn compression() -> CompressionLayer<impl Predicate> {
    CompressionLayer::new()
        .quality(CompressionLevel::Precise(COMPRESSION_QUALITY))
        .compress_when(DefaultPredicate::new().and(NotForContentType::const_new("font/woff2")).and(NotForContentType::const_new("font/woff")).and(NotForContentType::const_new("application/zip")).and(NotPreEncoded))
}

async fn v1_proxy(State(login): State<Router>, mut request: Request) -> Response {
    *request.extensions_mut() = axum::http::Extensions::new();
    match tower::ServiceExt::oneshot(login, request).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}

async fn not_found() -> Response {
    errors::not_found()
}

async fn finish(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let counted = path == "/api" || path.starts_with("/api/") || path == "/v1" || path.starts_with("/v1/");
    let response = next.run(request).await;
    let account = response.extensions().get::<AccountMark>().map(|mark| mark.0.clone());
    let response = errors::shape(response, runtime.clock.now().unix()).await;
    if counted {
        runtime.usage.response(Bundle::of_path(&path), response.status().as_u16(), account.as_deref());
    }
    response
}

pub async fn usage_page(State(state): State<Arc<AppState>>) -> Json<UsageSnapshot> {
    Json(state.public_usage.snapshot(state.clock.now().unix()))
}

fn is_kiwoom_path(path: &str) -> bool {
    const PREFIXES: &[&str] = &["/api/rankings", "/api/market-overview/", "/api/screener/run", "/api/heatmap/", "/api/bars", "/api/quotes"];
    const SYMBOL_SUFFIXES: &[&str] = &["/order-book", "/trades", "/program-trades", "/foreign-holdings", "/investor-net-shares", "/fundamentals", "/day-summary"];
    PREFIXES.iter().any(|prefix| path.starts_with(prefix)) || (path.starts_with("/api/symbols/") && SYMBOL_SUFFIXES.iter().any(|suffix| path.ends_with(suffix)))
}

pub async fn measure_operator_kiwoom(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    if !is_kiwoom_path(request.uri().path()) {
        return next.run(request).await;
    }
    let started = Instant::now();
    let response = next.run(request).await;
    state.public_usage.operator_kiwoom_response(state.clock.now().unix(), started.elapsed());
    response
}
