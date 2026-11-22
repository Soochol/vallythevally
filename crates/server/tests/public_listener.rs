mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use account_server::{AccountConfig, AccountOptions, Accounts, GoogleConfig, IdpUrl, NaverConfig, PublicUrl, Secret, SystemClock, open_database};
use tower::ServiceExt;
use account_server::fake_idp::{ClientCredentials, FakeIdp};
use axum::extract::Extension;
use axum::routing::get;
use axum::Router;
use domain::{Market, Symbol, SymbolInfo, SymbolKind};
use serde_json::{Value, json};
use server::api::{Excludes, Ranking, RankingMarket, Venue};
use server::app::{Adapters, StreamSource};
use server::config::Config;
use server::http::AppState;
use server::kiwoom::rest::Access;
use server::symbols::Directory;
use support::{APP_KEY, APP_SECRET, ScriptedTransport};

const GOOGLE_SECRET: &str = "google-secret-public-listener-3f9a";
const NAVER_SECRET: &str = "naver-secret-public-listener-71cc";
const FRIDAY_EVENING: &str = "20261106203000";
const KIWOOM_FIXED: &str = "시세를 지금 받지 못합니다. 잠시 뒤 다시 시도하세요";

async fn start_idp() -> Arc<FakeIdp> {
    Arc::new(
        FakeIdp::start(
            ClientCredentials { id: "google-id".into(), secret: GOOGLE_SECRET.into() },
            ClientCredentials { id: "naver-id".into(), secret: NAVER_SECRET.into() },
            Arc::new(SystemClock),
        )
        .await,
    )
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Work {
    dir: tempfile::TempDir,
}

impl Work {
    fn new() -> Work {
        let dir = tempfile::tempdir().unwrap();
        let dist = dir.path().join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::create_dir_all(dist.join("fonts")).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html><title>vally</title><script src=\"/assets/app-1a2b3c.js\"></script>").unwrap();
        std::fs::write(dist.join("assets/app-1a2b3c.js"), bundle_text()).unwrap();
        std::fs::write(dist.join("fonts/face.woff2"), pseudo_random_bytes(4096)).unwrap();
        Work { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn dist(&self) -> PathBuf {
        self.path().join("dist")
    }
}

fn bundle_text() -> String {
    (0..400).map(|i| format!("export function feature{i}(input){{return input.map((row)=>row.value*{i}+row.offset)}}\n")).collect()
}

fn pseudo_random_bytes(count: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    (0..count)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

fn operator_vars(work: &Path, operator_bind: &str) -> BTreeMap<String, String> {
    let show = |p: PathBuf| p.display().to_string();
    [
        ("VALLY_LOCK_PATH", show(work.join("run/server.lock"))),
        ("VALLY_TOKEN_PATH", show(work.join("run/token.json"))),
        ("VALLY_KIWOOM_KEY_PATH", show(work.join("run/kiwoom-key.json"))),
        ("VALLY_ACCOUNT_STATE_PATH", show(work.join("run/account.json"))),
        ("VALLY_DB_PATH", show(work.join("data/vally.db"))),
        ("VALLY_SCREENER_DB_PATH", show(work.join("data/screener.duckdb"))),
        ("VALLY_STATIC_DIR", show(work.join("dist"))),
        ("VALLY_COLLECTOR_TELEGRAM", show(work.join("data/no-telegram.json"))),
        ("VALLY_BIND", operator_bind.to_owned()),
        ("VALLY_LOG", "server=trace".to_owned()),
        ("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:1".to_owned()),
        ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:1".to_owned()),
        ("VALLY_PUBLIC_IP_URL", "http://127.0.0.1:1".to_owned()),
        ("VALLY_SCREENER_UPDATE_ON_START", "off".to_owned()),
        ("VALLY_FINANCIAL_AUTOMATIC", "off".to_owned()),
        ("VALLY_CLOCK_START", FRIDAY_EVENING.to_owned()),
        ("VALLY_KIWOOM_APP_KEY", APP_KEY.to_owned()),
        ("VALLY_KIWOOM_APP_SECRET", APP_SECRET.to_owned()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn public_vars(idp: &FakeIdp, bind: &str, origin: &str) -> Vec<(String, String)> {
    [
        ("VALLY_PUBLIC_BIND", bind.to_owned()),
        ("VALLY_PUBLIC_ORIGIN", origin.to_owned()),
        ("VALLY_PUBLIC_GOOGLE_CLIENT_ID", "google-id".to_owned()),
        ("VALLY_PUBLIC_GOOGLE_CLIENT_SECRET", GOOGLE_SECRET.to_owned()),
        ("VALLY_PUBLIC_GOOGLE_AUTHORIZE_URL", idp.url("/google/authorize")),
        ("VALLY_PUBLIC_GOOGLE_TOKEN_URL", idp.url("/google/token")),
        ("VALLY_PUBLIC_NAVER_CLIENT_ID", "naver-id".to_owned()),
        ("VALLY_PUBLIC_NAVER_CLIENT_SECRET", NAVER_SECRET.to_owned()),
        ("VALLY_PUBLIC_NAVER_AUTHORIZE_URL", idp.url("/naver/authorize")),
        ("VALLY_PUBLIC_NAVER_TOKEN_URL", idp.url("/naver/token")),
        ("VALLY_PUBLIC_NAVER_PROFILE_URL", idp.url("/naver/profile")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn config_of(vars: BTreeMap<String, String>) -> Result<Config, String> {
    Config::from_values(vars).map(|(config, _)| config).map_err(|e| e.to_string())
}

struct Held {
    arrived: AtomicUsize,
    gate: tokio::sync::Semaphore,
}

impl Held {
    fn new() -> Held {
        Held { arrived: AtomicUsize::new(0), gate: tokio::sync::Semaphore::new(0) }
    }

    async fn arrivals(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.arrived.load(Ordering::SeqCst) < count {
            assert!(Instant::now() < deadline, "붙잡힌 요청이 {count}개 도착하지 않았다: {}", self.arrived.load(Ordering::SeqCst));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn release(&self) {
        self.gate.add_permits(1_000);
    }
}

async fn hold_here(Extension(held): Extension<Arc<Held>>) -> &'static str {
    held.arrived.fetch_add(1, Ordering::SeqCst);
    let _ = held.gate.acquire().await;
    "released"
}

#[allow(unreachable_code)]
async fn panic_here() -> &'static str {
    panic!("시험용 panic");
    "never"
}

fn test_routes(held: Arc<Held>) -> Router<Arc<AppState>> {
    Router::new().route("/api/test/hold", get(hold_here)).route("/api/test/panic", get(panic_here)).layer(Extension(held))
}

struct Reply {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    async fn of(response: reqwest::Response) -> Reply {
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = response.bytes().await.unwrap().to_vec();
        Reply { status, headers, body }
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("JSON이 아니다({e}): {}", String::from_utf8_lossy(&self.body)))
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

}

#[derive(Clone)]
struct Session {
    cookie: String,
}

struct Site {
    state: Arc<AppState>,
    fake: ScriptedTransport,
    idp: Arc<FakeIdp>,
    operator: String,
    operator_port: u16,
    public: String,
    public_router: Router,
    operator_router: Router,
    login_router: Router,
    held: Arc<Held>,
    http: reqwest::Client,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    _lock: server::instance::InstanceLock,
    _events: tokio::sync::mpsc::Sender<server::market_source::stream::StreamEvent>,
}

impl Drop for Site {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

struct Spec<'a> {
    work: &'a Work,
    idp: &'a Arc<FakeIdp>,
    env: Vec<(&'a str, String)>,
    public: bool,
    fake: Option<ScriptedTransport>,
}

impl<'a> Spec<'a> {
    fn new(work: &'a Work, idp: &'a Arc<FakeIdp>) -> Spec<'a> {
        Spec { work, idp, env: Vec::new(), public: true, fake: None }
    }

    fn env(mut self, pairs: &[(&'a str, &str)]) -> Spec<'a> {
        self.env.extend(pairs.iter().map(|(key, value)| (*key, (*value).to_owned())));
        self
    }

    fn without_public(mut self) -> Spec<'a> {
        self.public = false;
        self
    }

    fn with_fake(mut self, fake: ScriptedTransport) -> Spec<'a> {
        self.fake = Some(fake);
        self
    }

    async fn start(self) -> Site {
        let _ = tracing_subscriber::fmt().with_env_filter("warn,server=debug,account_server=debug").with_test_writer().try_init();
        let public_port = free_port();
        let operator_bind = "127.0.0.1:0";
        let mut vars = operator_vars(self.work.path(), operator_bind);
        let public_origin = format!("http://127.0.0.1:{public_port}");
        if self.public {
            vars.extend(public_vars(self.idp, &format!("127.0.0.1:{public_port}"), &public_origin));
        }
        vars.extend(self.env.into_iter().map(|(key, value)| (key.to_owned(), value)));
        let config = config_of(vars).unwrap_or_else(|e| panic!("설정 오류: {e}"));
        let fake = self.fake.unwrap_or_default();
        let lock = server::instance::InstanceLock::acquire(&config.lock_path).unwrap();
        let (events, stream_events) = tokio::sync::mpsc::channel(16);
        let adapters = Adapters { kiwoom: fake.transport(), stream: StreamSource::Detached(stream_events), kiwoom_spacing: None, dart_spacing: Some(Duration::from_millis(1)) };
        let started = server::app::start(&config, &lock, adapters).await.unwrap_or_else(|_| panic!("서버가 시작하지 못했다"));
        let server::app::Started { state, router, listener, automatic, public } = started;
        drop(automatic);
        state.rest.set_access(Access::Open);
        let held = Arc::new(Held::new());
        let mut tasks = Vec::new();
        let operator_port = listener.local_addr().unwrap().port();
        let operator_router = router.clone();
        tasks.push(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }));
        let (public_router, public_origin) = match public {
            Some(public) => {
                let router = public.router_with(test_routes(held.clone()));
                let served = router.clone();
                let listener = public.listener;
                tasks.push(tokio::spawn(async move {
                    axum::serve(listener, served).await.unwrap();
                }));
                (router, public_origin)
            }
            None => (Router::new(), String::new()),
        };
        let login_router = match self.public {
            true => {
                let endpoint = |path: &str| IdpUrl::parse(&self.idp.url(path)).unwrap();
                let account_config = AccountConfig {
                    public_url: PublicUrl::parse(&public_origin).unwrap(),
                    google: GoogleConfig { client_id: "google-id".into(), client_secret: Secret::new(GOOGLE_SECRET), authorize_url: endpoint("/google/authorize"), token_url: endpoint("/google/token") },
                    naver: NaverConfig { client_id: "naver-id".into(), client_secret: Secret::new(NAVER_SECRET), authorize_url: endpoint("/naver/authorize"), token_url: endpoint("/naver/token"), profile_url: endpoint("/naver/profile") },
                };
                let pool = open_database(&self.work.path().join("data/public-accounts.db")).await.unwrap();
                Accounts::new(account_config, AccountOptions::default(), pool, Arc::new(SystemClock)).browser_router()
            }
            false => Router::new(),
        };
        Site {
            state,
            login_router,
            operator_router,
            fake,
            idp: self.idp.clone(),
            operator: format!("http://127.0.0.1:{operator_port}"),
            operator_port,
            public: public_origin,
            public_router,
            held,
            http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().timeout(Duration::from_secs(15)).build().unwrap(),
            tasks,
            _lock: lock,
            _events: events,
        }
    }
}

fn listed(code: &str, name: &str) -> SymbolInfo {
    SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true }
}

fn cookie_pairs(headers: &axum::http::HeaderMap) -> Vec<(String, String)> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|line| line.to_str().ok()?.split(';').next()?.split_once('=').map(|(name, value)| (name.to_owned(), value.to_owned())))
        .collect()
}

impl Site {
    fn load_symbols(&self) {
        self.state.symbols.replace(Directory::build(vec![listed("005930", "삼성전자"), listed("000660", "SK하이닉스")]));
    }

    fn now(&self) -> i64 {
        self.state.clock.now().unix()
    }

    fn jump(&self, secs: i64) {
        self.state.clock.jump(secs);
    }

    async fn hop(&self, uri: &str, cookie: Option<String>) -> (u16, axum::http::HeaderMap) {
        let mut request = axum::http::Request::get(uri);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = self.login_router.clone().oneshot(request.body(axum::body::Body::empty()).unwrap()).await.unwrap();
        (response.status().as_u16(), response.headers().clone())
    }

    async fn login_as(&self, provider: &str, subject: &str) -> Session {
        self.idp.set_subject(subject);
        let (status, headers) = self.hop(&format!("/v1/session/{provider}/start"), None).await;
        assert_eq!(status, 302, "로그인 시작은 IdP로 보낸다");
        let mut cookies: BTreeMap<String, String> = cookie_pairs(&headers).into_iter().collect();
        let authorize = headers["location"].to_str().unwrap().to_owned();
        let idp = self.http.get(&authorize).send().await.unwrap();
        assert_eq!(idp.status(), 302);
        let callback = idp.headers()["location"].to_str().unwrap().to_owned();
        let callback = callback.strip_prefix(&self.public).unwrap_or_else(|| panic!("callback이 공개 출처로 온다: {callback}")).to_owned();
        let header: Vec<String> = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect();
        let (status, headers) = self.hop(&callback, Some(header.join("; "))).await;
        assert_eq!(status, 302, "callback은 화면 첫 주소로 보낸다");
        cookies.extend(cookie_pairs(&headers));
        let session = cookies.iter().find(|(name, value)| name.ends_with("vally_session") && !value.is_empty()).unwrap_or_else(|| panic!("세션 쿠키가 없다: {cookies:?}"));
        Session { cookie: format!("{}={}", session.0, session.1) }
    }

    async fn login_many(&self, count: usize) -> Vec<Session> {
        let mut sessions = Vec::new();
        for n in 0..count {
            sessions.push(self.login(&format!("user-{n}")).await);
        }
        sessions
    }

    async fn login(&self, subject: &str) -> Session {
        self.login_as("google", subject).await
    }

    fn public_get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.get(format!("{}{path}", self.public))
    }

    async fn get(&self, session: &Session, path: &str) -> Reply {
        Reply::of(self.public_get(path).header("cookie", &session.cookie).send().await.unwrap()).await
    }

    async fn get_anonymous(&self, path: &str) -> Reply {
        Reply::of(self.public_get(path).send().await.unwrap()).await
    }

    fn post_builder(&self, session: &Session, path: &str, body: &Value) -> reqwest::RequestBuilder {
        self.http.post(format!("{}{path}", self.public)).header("cookie", &session.cookie).header("origin", &self.public).header("content-type", "application/json").body(body.to_string())
    }

    async fn post(&self, session: &Session, path: &str, body: &Value) -> Reply {
        Reply::of(self.post_builder(session, path, body).send().await.unwrap()).await
    }

    async fn operator_get(&self, path: &str) -> Reply {
        Reply::of(self.http.get(format!("{}{path}", self.operator)).send().await.unwrap()).await
    }

    async fn operator_send(&self, request: reqwest::RequestBuilder) -> Reply {
        Reply::of(request.send().await.unwrap()).await
    }

    fn operator_request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{path}", self.operator))
    }

    async fn usage(&self) -> Value {
        let reply = self.operator_get("/api/public-usage").await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        reply.json()
    }

    fn calls_of(&self, api_id: &str) -> usize {
        self.fake.calls().iter().filter(|call| call.api_id == api_id).count()
    }
}

fn assert_retry_matches(site: &Site, reply: &Reply) {
    let body = reply.json();
    let retry_at = body["error"]["retryAt"].as_i64().unwrap_or_else(|| panic!("error.retryAt이 없다: {body}"));
    let retry_after: i64 = reply.header("retry-after").unwrap_or_else(|| panic!("Retry-After가 없다: {body}")).parse().unwrap();
    assert_eq!(retry_at, site.now() + retry_after, "retryAt은 지금 + Retry-After이다: {body}");
    assert!(retry_after >= 1);
}

fn trade_amount(market: RankingMarket) -> Ranking {
    Ranking::TradeAmount { market, venue: Venue::Combined, excludes: Excludes { etf_etn: false, preferred: false }, exclude_managed: false }
}

fn ranking_body(ranking: Ranking, pages: u8) -> Value {
    json!({"ranking": serde_json::to_value(ranking).unwrap(), "pages": pages, "trigger": "user"})
}

fn all_indices() -> Value {
    json!({"all_inds_idex": [
        {"stk_cd": "001", "stk_nm": "종합(KOSPI)", "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
        {"stk_cd": "101", "stk_nm": "종합(KOSDAQ)", "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
        {"stk_cd": "603", "stk_nm": "VKOSPI", "cur_prc": "+17.20", "flu_rt": "+1.50", "trde_prica": "0"}
    ], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn rank_headers(next: Option<&str>) -> Value {
    match next {
        Some(key) => json!({"cont-yn": "Y", "next-key": key}),
        None => json!({"cont-yn": "N", "next-key": ""}),
    }
}

fn trade_amount_page(code: &str, next: Option<&str>) -> Value {
    let row = json!({"stk_cd": code, "stk_nm": format!("키움{code}"), "now_rank": "1", "pred_rank": "1", "cur_prc": "1000", "flu_rt": "0.5", "now_trde_qty": "10", "trde_prica": "1"});
    json!({"_headers": rank_headers(next), "trde_prica_upper": [row], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn script_rankings(fake: &ScriptedTransport, pages: usize) {
    fake.respond_with("ka10032", 200, trade_amount_page("000001", Some("K2")));
    for page in 2..=pages {
        let next = (page < pages).then(|| format!("K{}", page + 1));
        fake.respond_with_for_key("ka10032", &format!("K{page}"), 200, trade_amount_page(&format!("{page:06}"), next.as_deref()));
    }
}

fn index_days(days: &[String]) -> Value {
    let rows: Vec<_> = days.iter().map(|day| json!({"dt": day, "cur_prc": "505969", "open_pric": "505969", "high_pric": "505969", "low_pric": "505969", "trde_qty": "1", "trde_prica": "100"})).collect();
    json!({"inds_dt_pole_qry": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn sector_flows() -> Value {
    let rows: Vec<_> = [("001_AL", "종합(KOSPI)"), ("101_AL", "종합(KOSDAQ)")].iter().map(|(code, name)| json!({"inds_cd": code, "inds_nm": name, "cur_prc": "+658091", "flu_rt": "349", "ind_netprps": "-8787", "frgnr_netprps": "+6473", "orgn_netprps": "+1893"})).collect();
    json!({"inds_netprps": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn program_days(days: &[String]) -> Value {
    let rows: Vec<_> = days.iter().map(|day| json!({"cntr_tm": format!("{day}000000"), "dfrt_trde_netprps": "100", "ndiffpro_trde_netprps": "250", "all_netprps": "350"})).collect();
    json!({"prm_trde_trnsn": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn weekdays_before_friday(count: usize) -> Vec<String> {
    let mut days = Vec::new();
    let mut day = domain::KstDate::new(2026, 11, 5).unwrap();
    while days.len() < count {
        if !matches!(day.weekday(), domain::Weekday::Sat | domain::Weekday::Sun) {
            days.push(day.yyyymmdd().to_string());
        }
        day = day.add_days(-1);
    }
    days.reverse();
    days
}

fn script_market_overview(fake: &ScriptedTransport) {
    let days = weekdays_before_friday(24);
    fake.respond_with("ka20003", 200, all_indices());
    fake.respond_with("ka20006", 200, index_days(&days));
    fake.respond_with("ka10051", 200, sector_flows());
    fake.respond_with("ka90010", 200, program_days(&days));
}

fn head(text: &str) -> String {
    text.chars().take(200).collect()
}

fn operator_host(site: &Site) -> String {
    format!("127.0.0.1:{}", site.operator_port)
}

fn public_host(site: &Site) -> String {
    site.public.trim_start_matches("http://").to_owned()
}

async fn through(router: &Router, request: axum::http::Request<axum::body::Body>) -> (u16, Vec<u8>) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let body = http_body_util::BodyExt::collect(response.into_body()).await.unwrap().to_bytes().to_vec();
    (status, body)
}

fn public_post_in_process(site: &Site, session: &Session, path: &str, body: &Value) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::post(path).header("host", public_host(site)).header("origin", &site.public).header("content-type", "application/json").header("cookie", &session.cookie).body(axum::body::Body::from(body.to_string())).unwrap()
}

fn public_get_in_process(site: &Site, session: &Session, path: &str) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::get(path).header("host", public_host(site)).header("cookie", &session.cookie).body(axum::body::Body::empty()).unwrap()
}

fn operator_post_in_process(site: &Site, path: &str, body: &Value) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::post(path).header("host", operator_host(site)).header("content-type", "application/json").body(axum::body::Body::from(body.to_string())).unwrap()
}

fn operator_get_in_process(site: &Site, path: &str) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::get(path).header("host", operator_host(site)).body(axum::body::Body::empty()).unwrap()
}

fn open_days(from: domain::KstDate, through: domain::KstDate) -> Vec<domain::KstDate> {
    std::iter::successors(Some(from), |d| Some(d.add_days(1))).take_while(|d| *d <= through).filter(|d| !matches!(d.weekday(), domain::Weekday::Sat | domain::Weekday::Sun)).collect()
}

fn screener_market() -> support::krx::KrxMarket {
    use support::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
    let days = open_days(domain::KstDate::new(2026, 10, 19).unwrap(), domain::KstDate::new(2026, 11, 6).unwrap());
    let bars: Vec<KrxBar> = days.iter().enumerate().map(|(i, &day)| {
        let price = 100 + i as u64;
        KrxBar { day, open: price, high: price, low: price, close: price, volume: 1_000, traded_million_won: price * 1_000 / 1_000_000, base: price, adjustment_rate: None }
    }).collect();
    let stock = KrxStock { code: "200010".into(), name: "가상200010".into(), market_code: "0".into(), company_class_name: String::new(), reg_day: days[0], audit_info: "정상".into(), listed_shares: Some(1_000_000), quoted: true, daily: DailyAnswer::Bars, bars };
    KrxMarket { days, stocks: vec![stock] }
}

fn new_high_screen() -> Value {
    json!({"id": "S1", "name": "시험 조건식", "markets": [], "exclude": [], "conditions": [{"kind": "new_high", "period": "D", "field": "high", "n": 5, "recentBars": 1}]})
}

async fn update_screener_store(site: &Site) {
    site.state.link.connect(false).await;
    let started = site.operator_send(site.operator_request(reqwest::Method::POST, "/api/screener/update").header("content-type", "application/json").body("{\"full\":false}")).await;
    assert_eq!(started.status, 200, "{}", started.text());
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let status = site.operator_get("/api/screener/status").await.json();
        if !status["lastDay"].is_null() && status["update"].is_null() {
            return;
        }
        assert!(Instant::now() < deadline, "스크리너 저장소가 채워지지 않았다: {status}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready() {
        assert!(Instant::now() < deadline, "기다리던 일이 일어나지 않았다: {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}


#[tokio::test]
async fn no_public_settings_open_no_second_port() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).without_public().start().await;
    assert!(site.public.is_empty(), "공개 리스너가 떠 있다");
    let local = site.operator_get("/api/server-mode").await;
    assert_eq!((local.status, local.json()), (200, json!({"mode": "local"})));
}

#[tokio::test]
async fn bad_public_settings_stop_the_start() {
    let work = Work::new();
    let idp = start_idp().await;
    let build = |edit: &dyn Fn(&mut BTreeMap<String, String>)| {
        let mut vars = operator_vars(work.path(), "127.0.0.1:8080");
        vars.extend(public_vars(&idp, "127.0.0.1:18443", "https://vally.example.ts.net"));
        edit(&mut vars);
        config_of(vars)
    };
    assert!(build(&|_| {}).is_ok(), "기준 설정은 시작한다");
    let set = |key: &'static str, value: &'static str| move |vars: &mut BTreeMap<String, String>| drop(vars.insert(key.into(), value.into()));
    let only_bind = build(&|vars| drop(vars.remove("VALLY_PUBLIC_ORIGIN")));
    let only_origin = build(&|vars| drop(vars.remove("VALLY_PUBLIC_BIND")));
    let same_address = build(&set("VALLY_PUBLIC_BIND", "127.0.0.1:8080"));
    let not_loopback = build(&set("VALLY_PUBLIC_BIND", "0.0.0.0:18443"));
    let origin_with_path = build(&set("VALLY_PUBLIC_ORIGIN", "https://vally.example.ts.net/app"));
    let connector_mode = build(&set("VALLY_ACCOUNT_SERVER_URL", "https://account.example.test"));
    let mock = build(&|vars| {
        vars.remove("VALLY_KIWOOM_APP_KEY");
        vars.remove("VALLY_KIWOOM_APP_SECRET");
        vars.insert("VALLY_KIWOOM_ENV".into(), "mock".into());
        vars.insert("VALLY_KIWOOM_MOCK_APP_KEY".into(), APP_KEY.into());
        vars.insert("VALLY_KIWOOM_MOCK_APP_SECRET".into(), APP_SECRET.into());
    });
    for (name, result) in [("하나만 있음(BIND)", only_bind), ("하나만 있음(ORIGIN)", only_origin), ("같은 주소", same_address), ("루프백이 아님", not_loopback), ("경로가 붙은 출처", origin_with_path), ("커넥터 계정 모드", connector_mode), ("mock", mock)] {
        assert!(result.is_err(), "{name}인데 설정이 받아들여졌다");
    }
    let operator_alone = |edit: &dyn Fn(&mut BTreeMap<String, String>)| {
        let mut vars = operator_vars(work.path(), "127.0.0.1:8080");
        edit(&mut vars);
        config_of(vars)
    };
    assert!(operator_alone(&set("VALLY_ACCOUNT_SERVER_URL", "https://account.example.test")).is_ok(), "커넥터 계정 모드만으로는 시작한다(위 실패는 공개 설정 때문이다)");
    for (name, value) in [
        ("VALLY_PUBLIC_ACCOUNT_RATE", "0"),
        ("VALLY_PUBLIC_ACCOUNT_RATE", "fast"),
        ("VALLY_PUBLIC_ACCOUNT_BURST", "0.5"),
        ("VALLY_PUBLIC_LIGHT_COST", "2"),
        ("VALLY_PUBLIC_MAX_IN_FLIGHT", "0"),
        ("VALLY_PUBLIC_ACCOUNT_IN_FLIGHT", "-1"),
        ("VALLY_PUBLIC_REQUEST_TIMEOUT_SECS", "0"),
        ("VALLY_PUBLIC_RANKING_MAX_PAGES", "31"),
        ("VALLY_PUBLIC_MARKET_CONCURRENCY", "0"),
        ("VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE", "0"),
        ("VALLY_PUBLIC_ACCOUNT_LIMIT", "0"),
    ] {
        let leaked = Box::leak(value.to_owned().into_boxed_str());
        let key: &'static str = Box::leak(name.to_owned().into_boxed_str());
        assert!(build(&set(key, leaked)).is_err(), "{name}={value}가 받아들여졌다");
    }
    assert!(build(&|vars| {
        vars.insert("VALLY_PUBLIC_SCREENER_CONCURRENCY".into(), "0".into());
        vars.insert("VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE".into(), "0".into());
    })
    .is_ok(), "0은 한도 없음이다");
}

const CLOSED_ROUTES: &[(&str, &str, bool)] = &[
    ("GET", "/api/ws", true),
    ("GET", "/api/bars", true),
    ("GET", "/api/bars/jump", true),
    ("GET", "/api/quotes", true),
    ("GET", "/api/symbols/005930/order-book", true),
    ("GET", "/api/symbols/005930/trades", true),
    ("GET", "/api/symbols/005930/program-trades", true),
    ("GET", "/api/symbols/005930/foreign-holdings", true),
    ("GET", "/api/symbols/005930/investor-net-shares", true),
    ("GET", "/api/symbols/005930/fundamentals", true),
    ("GET", "/api/symbols/005930/day-summary", true),
    ("GET", "/api/system/kiwoom", true),
    ("GET", "/api/system/kiwoom/usage", true),
    ("GET", "/api/system/settings", true),
    ("PUT", "/api/system/kiwoom/key", false),
    ("POST", "/api/system/kiwoom/connect", false),
    ("GET", "/api/trading/account-number", true),
    ("GET", "/api/trading/balance", true),
    ("GET", "/api/system/orders", true),
    ("POST", "/api/trading/commands/place", false),
    ("GET", "/api/account", true),
    ("POST", "/api/account/login", false),
    ("GET", "/auth/complete", true),
    ("GET", "/api/setup/export", true),
    ("PUT", "/api/setup/import", false),
    ("POST", "/api/screener/update", false),
    ("POST", "/api/screener/update/cancel", false),
    ("POST", "/api/financial-update", false),
    ("POST", "/api/financial-update/pause", false),
    ("GET", "/api/watchlists", true),
    ("GET", "/api/screens", true),
    ("GET", "/api/heatmap/themes", true),
    ("GET", "/api/heatmap/board", true),
    ("GET", "/api/heatmap/flow", true),
    ("GET", "/api/kiwoom-themes", true),
    ("GET", "/api/layouts", true),
    ("GET", "/api/ui-state", true),
    ("GET", "/api/drawings", true),
    ("POST", "/v1/auth/token", false),
    ("GET", "/v1/me", false),
    ("GET", "/v1/setup/changes", false),
    ("POST", "/v1/setup/changes", false),
    ("GET", "/v1/auth/google/start?port=40000&state=x&code_challenge=y&code_challenge_method=S256", false),
];

#[tokio::test]
async fn operator_only_routes_are_404_on_the_public_listener_even_with_a_session() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    let mut open = Vec::new();
    for &(method, path, _) in CLOSED_ROUTES {
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let reply = site.operator_send(site.http.request(method.clone(), format!("{}{path}", site.public)).header("cookie", &who.cookie).header("origin", &site.public).header("content-type", "application/json").body("{}")).await;
        if reply.status != 404 {
            open.push(format!("{method} {path} -> {}: {}", reply.status, head(&reply.text())));
        }
    }
    assert!(open.is_empty(), "공개 리스너에서 404가 아닌 운영자 경로: {open:#?}");
    let ws = tokio_tungstenite::connect_async({
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = format!("ws://{}/api/ws", public_host(&site)).into_client_request().unwrap();
        request.headers_mut().insert("cookie", who.cookie.parse().unwrap());
        request.headers_mut().insert("origin", site.public.parse().unwrap());
        request
    })
    .await;
    match ws {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => assert_eq!(response.status(), 404),
        other => panic!("공개 리스너에서 /api/ws가 열렸다: {:?}", other.map(|_| ())),
    }
}

#[tokio::test]
async fn the_same_routes_answer_on_the_operator_listener_as_before() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    site.state.rest.set_access(Access::Closed);
    let before_symbols = site.operator_send(site.operator_request(reqwest::Method::POST, "/api/financial-update").header("content-type", "application/json").body("{}")).await;
    assert_ne!(before_symbols.status, 404, "{}", head(&before_symbols.text()));
    site.load_symbols();
    let mut missing = Vec::new();
    for &(method, path, probe) in CLOSED_ROUTES {
        if !probe || path == "/api/ws" || path.starts_with("/v1/") {
            continue;
        }
        let reply = site.operator_get(path).await;
        if reply.status == 404 {
            missing.push(format!("{method} {path}: {}", head(&reply.text())));
        }
    }
    assert!(missing.is_empty(), "운영자 리스너에서 404인 경로: {missing:#?}");
    let invalid = site.operator_send(site.operator_request(reqwest::Method::POST, "/api/screener/update").header("content-type", "application/json").body("{bad")).await;
    assert_eq!(invalid.status, 400, "{}", head(&invalid.text()));
}

#[tokio::test]
async fn browser_login_works_through_the_public_listener() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    idp.set_subject("through-public");
    let start = site.public_get("/v1/session/google/start").send().await.unwrap();
    assert_eq!(start.status(), 302, "공개 리스너의 로그인 시작: {}", head(&start.text().await.unwrap()));
    let mut cookies: BTreeMap<String, String> = cookie_pairs(start.headers()).into_iter().collect();
    let authorize = start.headers()["location"].to_str().unwrap().to_owned();
    let callback = site.http.get(&authorize).send().await.unwrap().headers()["location"].to_str().unwrap().to_owned();
    let header: Vec<String> = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect();
    let done = site.http.get(&callback).header("cookie", header.join("; ")).send().await.unwrap();
    assert_eq!(done.status(), 302, "공개 리스너의 callback");
    assert_eq!(done.headers()["location"].to_str().unwrap(), format!("{}/", site.public));
    cookies.extend(cookie_pairs(done.headers()));
    let session = cookies.iter().find(|(name, value)| name.ends_with("vally_session") && !value.is_empty()).expect("세션 쿠키");
    let reply = Reply::of(site.public_get("/v1/session").header("cookie", format!("{}={}", session.0, session.1)).send().await.unwrap()).await;
    assert_eq!(reply.status, 200);
    let logout = Reply::of(site.http.post(format!("{}/v1/session/logout", site.public)).header("cookie", format!("{}={}", session.0, session.1)).header("origin", &site.public).header("content-type", "application/json").body("{}").send().await.unwrap()).await;
    assert_eq!(logout.status, 204);
    let after = Reply::of(site.public_get("/v1/session").header("cookie", format!("{}={}", session.0, session.1)).send().await.unwrap()).await;
    assert_eq!(after.status, 401);
}


#[tokio::test]
async fn without_a_session_the_api_is_signed_out_but_server_mode_and_the_screen_files_answer() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let status = site.get_anonymous("/api/screener/status").await;
    assert_eq!(status.status, 401);
    assert_eq!(status.json()["error"]["code"], "signed_out");
    let rankings = Reply::of(site.http.post(format!("{}/api/rankings", site.public)).header("origin", &site.public).header("content-type", "application/json").body(ranking_body(trade_amount(RankingMarket::All), 1).to_string()).send().await.unwrap()).await;
    assert_eq!(rankings.status, 401);
    assert_eq!(rankings.json()["error"]["code"], "signed_out");
    let mode = site.get_anonymous("/api/server-mode").await;
    assert_eq!((mode.status, mode.json()), (200, json!({"mode": "public"})));
    for path in ["/", "/index.html", "/assets/app-1a2b3c.js"] {
        assert_eq!(site.get_anonymous(path).await.status, 200, "{path}");
    }
    assert_eq!(site.calls_of("ka10032"), 0, "세션 없는 요청은 키움에 가지 않는다");
}

#[tokio::test]
async fn a_blocked_accounts_session_is_signed_out_too() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_BLOCKED_ACCOUNTS", "google:mallory")]).start().await;
    let blocked = site.login("mallory").await;
    let fine = site.login("alice").await;
    let reply = site.get(&blocked, "/api/screener/status").await;
    assert_eq!(reply.status, 401, "{}", head(&reply.text()));
    assert_eq!(reply.json()["error"]["code"], "signed_out");
    assert_eq!(site.get(&fine, "/api/screener/status").await.status, 200);
}

#[tokio::test]
async fn with_a_session_the_shared_reads_answer() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    fake.set_krx_market(screener_market());
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    update_screener_store(&site).await;
    let who = site.login("alice").await;
    let status = site.get(&who, "/api/screener/status").await;
    assert_eq!(status.status, 200);
    assert!(status.json()["lastDay"].is_string(), "{}", status.text());
    let run = site.post(&who, "/api/screener/run", &new_high_screen()).await;
    assert_eq!(run.status, 200, "{}", head(&run.text()));
    assert!(run.json()["rows"].is_array());
    script_rankings(&fake, 5);
    script_market_overview(&fake);
    site.load_symbols();
    for path in ["/api/etf/funds", "/api/symbols?q=%EC%82%BC%EC%84%B1", "/api/symbols/005930", "/api/financial-update", "/api/symbols/005930/financials?period=Y", "/api/symbols/005930/financial-source", "/api/market-overview/index?market=kospi"] {
        let reply = site.get(&who, path).await;
        assert_eq!(reply.status, 200, "{path}: {}", head(&reply.text()));
    }
    let ranking = site.post(&who, "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 1)).await;
    assert_eq!(ranking.status, 200, "{}", head(&ranking.text()));
    assert!(ranking.json()["rows"].as_array().is_some_and(|rows| !rows.is_empty()));
}


#[tokio::test]
async fn a_request_for_another_host_port_or_origin_is_refused() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    let port = site.public.rsplit(':').next().unwrap().to_owned();
    let other_port = format!("127.0.0.1:{}", port.parse::<u16>().unwrap().wrapping_add(1));
    let get_with = |header: &str, value: String| {
        let request = site.public_get("/api/collector/access").header("cookie", &who.cookie).header(header.to_owned(), value);
        async move { Reply::of(request.send().await.unwrap()).await }
    };
    assert_eq!(site.get(&who, "/api/collector/access").await.status, 200);
    assert_eq!(get_with("origin", site.public.clone()).await.status, 200, "같은 Origin은 받는다");
    assert_eq!(get_with("host", format!("evil.example:{port}")).await.status, 400, "다른 Host");
    assert_eq!(get_with("host", other_port).await.status, 400, "다른 포트");
    assert_eq!(get_with("host", "127.0.0.1".to_owned()).await.status, 400, "포트가 없는 Host");
    assert_eq!(get_with("host", public_host(&site).to_ascii_uppercase()).await.status, 200, "Host는 대소문자를 가리지 않는다");
    assert_eq!(get_with("origin", "http://evil.example".to_owned()).await.status, 400, "다른 Origin");
    assert_eq!(get_with("origin", format!("{}:1", site.public)).await.status, 400, "다른 포트의 Origin");
    assert_eq!(get_with("origin", "null".to_owned()).await.status, 400);
    let static_file = site.http.get(format!("{}/", site.public)).header("host", "evil.example").send().await.unwrap();
    assert_eq!(static_file.status(), 400, "화면 파일에도 Host를 본다");
}

#[tokio::test]
async fn writes_need_the_public_origin_and_a_json_content_type() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    site.load_symbols();
    let who = site.login("alice").await;
    let body = ranking_body(trade_amount(RankingMarket::All), 1).to_string();
    let send = |origin: Option<&str>, content_type: &str| {
        let mut request = site.http.post(format!("{}/api/rankings", site.public)).header("cookie", &who.cookie).header("content-type", content_type.to_owned()).body(body.clone());
        if let Some(origin) = origin {
            request = request.header("origin", origin.to_owned());
        }
        async move { Reply::of(request.send().await.unwrap()).await }
    };
    site.fake.respond_with("ka10032", 200, trade_amount_page("000001", None));
    let ok = send(Some(&site.public), "application/json").await;
    assert_eq!(ok.status, 200, "{}", head(&ok.text()));
    assert_eq!(send(Some(&site.public), "application/json; charset=utf-8").await.status, 200);
    assert_eq!(send(None, "application/json").await.status, 400, "Origin이 없는 POST");
    assert_eq!(send(Some(&site.public), "text/plain").await.status, 400, "text/plain POST");
    assert_eq!(send(Some(&site.public), "application/x-www-form-urlencoded").await.status, 400);
    assert_eq!(send(Some("http://evil.example"), "application/json").await.status, 400, "다른 Origin의 POST");
    assert_eq!(site.calls_of("ka10032"), 1, "거절된 POST는 키움에 가지 않는다");
}

#[tokio::test]
async fn every_public_response_carries_the_csp_and_the_security_headers() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    let csp = include_str!("../src/public/csp.txt").trim();
    let mut replies = vec![
        site.get(&who, "/api/collector/access").await,
        site.get_anonymous("/api/screener/status").await,
        site.get(&who, "/api/closed").await,
        site.get_anonymous("/").await,
        site.get_anonymous("/assets/app-1a2b3c.js").await,
        site.get_anonymous("/v1/session").await,
        Reply::of(site.public_get("/api/server-mode").header("host", "evil.example").send().await.unwrap()).await,
    ];
    replies.push(site.get(&who, "/api/test/panic").await);
    let statuses: Vec<u16> = replies.iter().map(|reply| reply.status).collect();
    assert_eq!(statuses, [200, 401, 404, 200, 200, 401, 400, 500]);
    for reply in &replies {
        assert_eq!(reply.header("content-security-policy"), Some(csp), "{}", reply.status);
        assert_eq!(reply.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(reply.header("referrer-policy"), Some("no-referrer"));
        assert_eq!(reply.header("cross-origin-opener-policy"), Some("same-origin"));
    }
}

#[tokio::test]
async fn a_request_body_over_eight_mebibytes_is_413_payload_too_large() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    let nine_mib = " ".repeat(9 * 1024 * 1024);
    for path in ["/v1/session/logout", "/api/screener/run"] {
        let reply = Reply::of(site.http.post(format!("{}{path}", site.public)).header("cookie", &who.cookie).header("origin", &site.public).header("content-type", "application/json").body(nine_mib.clone()).send().await.unwrap()).await;
        assert_eq!(reply.status, 413, "{path}");
        assert_eq!(reply.json()["error"]["code"], "payload_too_large", "{path}");
    }
}


#[tokio::test]
async fn two_sessions_of_one_account_share_a_bucket_and_other_accounts_are_untouched() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let first = site.login("alice").await;
    let second = site.login("alice").await;
    let bob = site.login("bob").await;
    for turn in 0..100 {
        let session = if turn % 2 == 0 { &first } else { &second };
        assert_eq!(site.get(session, "/api/collector/access").await.status, 200, "{turn}번째");
    }
    let over = site.get(&second, "/api/collector/access").await;
    assert_eq!(over.status, 429, "{}", head(&over.text()));
    assert_retry_matches(&site, &over);
    assert_eq!(site.get(&first, "/api/collector/access").await.status, 429, "다른 세션도 같은 버킷이다");
    assert_eq!(site.get(&bob, "/api/collector/access").await.status, 200, "다른 계정은 영향이 없다");
    let wait: i64 = over.header("retry-after").unwrap().parse().unwrap();
    site.jump(wait);
    assert_eq!(site.get(&second, "/api/collector/access").await.status, 200, "가짜 시계를 넘기면 다시 받는다");
}

#[tokio::test]
async fn the_sum_of_many_accounts_over_the_total_bucket_is_429() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_TOTAL_BURST", "10"), ("VALLY_PUBLIC_TOTAL_RATE", "1")]).start().await;
    let sessions = [site.login("a").await, site.login("b").await, site.login("c").await];
    let mut statuses = Vec::new();
    for turn in 0..12 {
        statuses.push(site.get(&sessions[turn % 3], "/api/collector/access").await.status);
    }
    assert_eq!(statuses.iter().filter(|&&s| s == 200).count(), 10, "{statuses:?}");
    assert_eq!(statuses[10..], [429, 429]);
    let fresh = site.login("d").await;
    let refused = site.get(&fresh, "/api/collector/access").await;
    assert_eq!(refused.status, 429, "새 계정도 전체 버킷에 막힌다");
    assert_retry_matches(&site, &refused);
    site.jump(refused.header("retry-after").unwrap().parse().unwrap());
    assert_eq!(site.get(&fresh, "/api/collector/access").await.status, 200);
}

#[tokio::test]
async fn a_hundred_and_fifty_symbol_lookups_fit_the_default_account_bucket() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    site.load_symbols();
    let who = site.login("alice").await;
    for turn in 0..150 {
        let reply = site.get(&who, "/api/symbols/005930").await;
        assert_eq!(reply.status, 200, "{turn}번째: {}", head(&reply.text()));
    }
    let mut heavy = 0;
    while site.get(&who, "/api/collector/access").await.status == 200 {
        heavy += 1;
        assert!(heavy <= 100, "한도가 걸리지 않는다");
    }
    assert!((84..=86).contains(&heavy), "가벼운 150번이 15를 쓰고 100 - 15 = 85번 남는다: {heavy}");
}

#[tokio::test]
async fn anonymous_requests_over_their_own_bucket_do_not_stop_signed_in_accounts() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    let mut statuses = Vec::new();
    for _ in 0..25 {
        statuses.push(site.get_anonymous("/api/screener/status").await.status);
    }
    assert_eq!(statuses.iter().filter(|&&s| s == 401).count(), 20, "{statuses:?}");
    assert_eq!(statuses[20..], [429; 5]);
    assert_eq!(site.get(&who, "/api/collector/access").await.status, 200);
    assert_eq!(site.get_anonymous("/").await.status, 200, "화면 파일은 익명 버킷을 쓰지 않는다");
}

#[tokio::test]
async fn the_login_start_bucket_is_its_own_and_retry_at_matches_retry_after() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_LOGIN_PER_MINUTE", "3")]).start().await;
    let who = site.login("alice").await;
    for turn in 0..3 {
        let reply = Reply::of(site.public_get("/v1/session/google/start").send().await.unwrap()).await;
        assert_ne!(reply.status, 429, "{turn}번째");
    }
    let refused = Reply::of(site.public_get("/v1/session/google/start").send().await.unwrap()).await;
    assert_eq!(refused.status, 429);
    assert_retry_matches(&site, &refused);
    assert_eq!(site.get(&who, "/api/collector/access").await.status, 200, "로그인한 계정은 영향이 없다");
    let wait: i64 = refused.header("retry-after").unwrap().parse().unwrap();
    site.jump(wait);
    let again = Reply::of(site.public_get("/v1/session/google/start").send().await.unwrap()).await;
    assert_ne!(again.status, 429, "Retry-After({wait}초)만큼 시계를 넘기면 다시 받는다: {}", head(&again.text()));
}

#[tokio::test]
async fn anonymous_requests_over_the_anonymous_in_flight_cap_leave_signed_in_accounts_alone() {
    let work = Work::new();
    let idp = start_idp().await;
    let hanging = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let hanging_url = format!("http://{}/google/token", hanging.local_addr().unwrap());
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = accepted.clone();
    let parked = tokio::spawn(async move {
        let mut sockets = Vec::new();
        loop {
            let (socket, _) = hanging.accept().await.unwrap();
            counter.fetch_add(1, Ordering::SeqCst);
            sockets.push(socket);
        }
    });
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_GOOGLE_TOKEN_URL", &hanging_url), ("VALLY_PUBLIC_ANON_IN_FLIGHT", "2"), ("VALLY_PUBLIC_ANON_BURST", "1000"), ("VALLY_PUBLIC_LOGIN_PER_MINUTE", "1000")]).start().await;
    let who = site.login_as("naver", "alice").await;
    let mut callbacks = Vec::new();
    for turn in 0..2 {
        idp.set_subject(&format!("stranger-{turn}"));
        let (_, headers) = site.hop("/v1/session/google/start", None).await;
        let cookies = cookie_pairs(&headers);
        let authorize = headers["location"].to_str().unwrap().to_owned();
        let callback = site.http.get(&authorize).send().await.unwrap().headers()["location"].to_str().unwrap().to_owned();
        let cookie = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ");
        let request = site.http.get(callback).header("cookie", cookie);
        callbacks.push(tokio::spawn(async move { request.send().await.map(|r| r.status().as_u16()) }));
    }
    wait_until("두 callback이 IdP 응답을 기다린다", || accepted.load(Ordering::SeqCst) >= 2).await;
    let started = Instant::now();
    let refused = site.get_anonymous("/api/server-mode").await;
    assert_eq!(refused.status, 503, "익명 동시 상한을 넘으면 바로 503");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_retry_matches(&site, &refused);
    assert_eq!(site.get(&who, "/api/collector/access").await.status, 200, "로그인한 계정은 응답한다");
    assert_eq!(site.get_anonymous("/").await.status, 200, "화면 파일은 익명 동시 상한을 세지 않는다");
    parked.abort();
    for callback in callbacks {
        callback.abort();
    }
}


#[tokio::test]
async fn a_full_account_in_flight_cap_refuses_that_account_at_once_and_spares_others() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_ACCOUNT_IN_FLIGHT", "2")]).start().await;
    let alice = site.login("alice").await;
    let bob = site.login("bob").await;
    let pending: Vec<_> = (0..2).map(|_| tokio::spawn({
        let request = site.public_get("/api/test/hold").header("cookie", &alice.cookie);
        async move { Reply::of(request.send().await.unwrap()).await }
    })).collect();
    site.held.arrivals(2).await;
    let started = Instant::now();
    let refused = site.get(&alice, "/api/test/hold").await;
    assert_eq!(refused.status, 503);
    assert!(started.elapsed() < Duration::from_secs(2), "기다리지 않고 바로 503이다");
    assert_retry_matches(&site, &refused);
    assert_eq!(site.get(&bob, "/api/collector/access").await.status, 200);
    site.held.release();
    for reply in pending {
        assert_eq!(reply.await.unwrap().status, 200);
    }
    assert_eq!(site.get(&alice, "/api/collector/access").await.status, 200, "자리가 돌아왔다");
}

#[tokio::test]
async fn a_full_total_in_flight_cap_refuses_public_requests_while_the_operator_listener_answers() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_MAX_IN_FLIGHT", "3")]).start().await;
    let sessions = [site.login("a").await, site.login("b").await, site.login("c").await, site.login("d").await];
    let pending: Vec<_> = sessions[..3].iter().map(|who| tokio::spawn({
        let request = site.public_get("/api/test/hold").header("cookie", &who.cookie);
        async move { Reply::of(request.send().await.unwrap()).await }
    })).collect();
    site.held.arrivals(3).await;
    let started = Instant::now();
    let refused = site.get(&sessions[3], "/api/collector/access").await;
    assert_eq!(refused.status, 503);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_retry_matches(&site, &refused);
    let status = site.operator_get("/api/screener/status").await;
    assert_eq!(status.status, 200, "{}", head(&status.text()));
    assert_eq!(site.operator_get("/api/server-mode").await.json(), json!({"mode": "local"}));
    site.held.release();
    for reply in pending {
        assert_eq!(reply.await.unwrap().status, 200);
    }
}

#[tokio::test]
async fn a_request_over_the_time_cap_is_503() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_REQUEST_TIMEOUT_SECS", "1")]).start().await;
    let who = site.login("alice").await;
    let started = Instant::now();
    let reply = site.get(&who, "/api/test/hold").await;
    assert_eq!(reply.status, 503, "{}", head(&reply.text()));
    assert!(started.elapsed() >= Duration::from_millis(900) && started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    assert_retry_matches(&site, &reply);
    assert_eq!(site.get(&who, "/api/collector/access").await.status, 200, "시간 초과 뒤에도 응답한다");
}

#[tokio::test]
async fn a_panicking_route_is_500_and_both_listeners_keep_answering() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    for _ in 0..3 {
        let reply = site.get(&who, "/api/test/panic").await;
        assert_eq!(reply.status, 500);
        assert_eq!(reply.json()["error"]["code"], "internal");
    }
    assert_eq!(site.get(&who, "/api/collector/access").await.status, 200);
    assert_eq!(site.get_anonymous("/api/server-mode").await.status, 200);
    assert_eq!(site.operator_get("/api/screener/status").await.status, 200);
    assert_eq!(site.operator_get("/api/test/panic").await.status, 404, "시험 라우트는 운영자 리스너에 없다");
}


fn market_card_calls(call: &support::Call) -> bool {
    matches!(call.api_id.as_str(), "ka20003" | "ka20006")
}

#[tokio::test]
async fn a_full_market_overview_bundle_leaves_rankings_their_own_room() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_market_overview(&fake);
    script_rankings(&fake, 1);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let sessions: Vec<Session> = site.login_many(8).await;
    let warm = site.get(&sessions[7], "/api/market-overview/index?market=kospi&period=20").await;
    assert_eq!(warm.status, 200, "{}", head(&warm.text()));
    let held = fake.hold("시장 개요 카드", market_card_calls);
    let queries = ["/api/market-overview/index?market=kospi&period=5", "/api/market-overview/index?market=kosdaq&period=5", "/api/market-overview/turnover?market=kospi&period=5", "/api/market-overview/turnover?market=kosdaq&period=5"];
    let before = fake.requests();
    let pending: Vec<_> = queries.iter().enumerate().map(|(n, path)| tokio::spawn({
        let request = site.public_get(path).header("cookie", &sessions[n].cookie);
        async move { Reply::of(request.send().await.unwrap()).await }
    })).collect();
    held.arrived().await;
    wait_until("네 묶음 요청이 키움 요청을 냈다", || fake.requests() >= before + 4).await;
    let started = Instant::now();
    let fifth = site.get(&sessions[4], "/api/market-overview/index?market=kospi&period=60").await;
    assert_eq!(fifth.status, 503, "묶음 자리가 없으면 바로 503: {}", head(&fifth.text()));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_retry_matches(&site, &fifth);
    let cached = site.get(&sessions[6], "/api/market-overview/index?market=kospi&period=20").await;
    assert_eq!(cached.status, 200, "캐시가 적중한 요청은 묶음 자리를 잡지 않는다");
    let ranking = site.post(&sessions[5], "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 1)).await;
    assert_eq!(ranking.status, 200, "시장 개요 묶음이 차도 순위는 자기 묶음 한도 안에서 응답한다: {}", head(&ranking.text()));
    held.release();
    for reply in pending {
        assert_eq!(reply.await.unwrap().status, 200);
    }
}

#[tokio::test]
async fn one_account_holds_one_kiwoom_path_at_a_time() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_market_overview(&fake);
    script_rankings(&fake, 1);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let alice = site.login("alice").await;
    let bob = site.login("bob").await;
    let held = fake.hold("순위", |call| call.api_id == "ka10032");
    let first = tokio::spawn({
        let request = site.post_builder(&alice, "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 1));
        async move { Reply::of(request.send().await.unwrap()).await }
    });
    held.arrived().await;
    let started = Instant::now();
    let second = site.post(&alice, "/api/rankings", &ranking_body(trade_amount(RankingMarket::Kospi), 1)).await;
    assert_eq!(second.status, 503, "{}", head(&second.text()));
    let other_bundle = site.get(&alice, "/api/market-overview/index?market=kosdaq").await;
    assert_eq!(other_bundle.status, 503, "다른 묶음이어도 계정당 키움 경로는 1개다");
    assert!(started.elapsed() < Duration::from_secs(2), "바로 503이다");
    assert_retry_matches(&site, &other_bundle);
    assert_eq!(site.get(&bob, "/api/market-overview/index?market=kosdaq").await.status, 200, "다른 계정은 응답한다");
    held.release();
    assert_eq!(first.await.unwrap().status, 200);
    assert_eq!(site.post(&alice, "/api/rankings", &ranking_body(trade_amount(RankingMarket::Kospi), 1)).await.status, 200, "자리가 돌아왔다");
}

#[tokio::test]
async fn the_same_market_overview_query_inside_fifteen_seconds_costs_no_new_kiwoom_request() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_market_overview(&fake);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    let alice = site.login("alice").await;
    let bob = site.login("bob").await;
    let path = "/api/market-overview/index?market=kospi";
    let first = site.get(&alice, path).await;
    assert_eq!(first.status, 200, "{}", head(&first.text()));
    assert_eq!(site.calls_of("ka20003"), 1);
    site.jump(14);
    let second = site.get(&bob, path).await;
    assert_eq!((second.status, second.body.clone()), (200, first.body.clone()), "모든 계정이 같은 응답을 같이 쓴다");
    assert_eq!(site.calls_of("ka20003"), 1, "15초 안의 같은 질의는 키움을 다시 부르지 않는다");
    site.jump(2);
    assert_eq!(site.get(&bob, path).await.status, 200);
    assert_eq!(site.calls_of("ka20003"), 2, "15초가 지나면 다시 받는다");
    assert_eq!(site.usage().await["cacheHits"]["marketOverview"], 1);
}

#[tokio::test]
async fn a_ranking_asking_for_thirty_pages_sends_five_to_kiwoom() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_rankings(&fake, 12);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let who = site.login("alice").await;
    let reply = site.post(&who, "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 30)).await;
    assert_eq!(reply.status, 200, "{}", head(&reply.text()));
    let keys: Vec<Option<String>> = fake.calls().into_iter().filter(|call| call.api_id == "ka10032").map(|call| call.next_key).collect();
    assert_eq!(keys, [None, Some("K2".into()), Some("K3".into()), Some("K4".into()), Some("K5".into())]);
}

#[tokio::test]
async fn a_gated_kiwoom_answers_503_with_fixed_words_and_no_kiwoom_text() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    let marker = "ORIGINAL-KIWOOM-TEXT-8005 공인 IP 등록 안내";
    let refused = || support::ScriptedReply { status: 429, body: json!({"return_code": 5, "return_msg": format!("{marker}[1700:유량=5]")}), delay: Duration::ZERO };
    fake.script("ka10032", vec![refused(), refused(), refused()]);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let alice = site.login("alice").await;
    let bob = site.login("bob").await;
    let closing = site.post(&alice, "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 1)).await;
    assert!(!closing.text().contains("ORIGINAL-KIWOOM-TEXT"), "{}", closing.text());
    let sent = site.calls_of("ka10032");
    let started = Instant::now();
    let gated = site.post(&bob, "/api/rankings", &ranking_body(trade_amount(RankingMarket::Kospi), 1)).await;
    assert_eq!(gated.status, 503, "{}", head(&gated.text()));
    assert!(started.elapsed() < Duration::from_secs(2), "바로 503이다");
    let body = gated.json();
    assert_eq!(body["error"]["message"], KIWOOM_FIXED);
    assert_ne!(body["error"]["manualActionRequired"], true);
    assert!(!gated.text().contains("ORIGINAL-KIWOOM-TEXT") && !gated.text().contains("1700"), "{}", gated.text());
    assert_retry_matches(&site, &gated);
    assert_eq!(site.calls_of("ka10032"), sent, "닫힌 관문 뒤에는 키움에 보내지 않는다");
}


#[tokio::test]
async fn public_rankings_at_their_limit_delay_an_operator_ranking_by_at_most_two_seconds() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_rankings(&fake, 10);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let (first, second) = (site.login("first").await, site.login("second").await);
    tokio::time::pause();
    let operator_ranking = |market| operator_post_in_process(&site, "/api/rankings", &ranking_body(trade_amount(market), 1));
    let started = tokio::time::Instant::now();
    assert_eq!(through(&site.operator_router, operator_ranking(RankingMarket::Kosdaq)).await.0, 200);
    let alone = started.elapsed();
    tokio::time::resume();
    site.jump(10);
    let walks: Vec<_> = [(&first, RankingMarket::All), (&second, RankingMarket::Kospi)].into_iter().map(|(who, market)| {
        let request = public_post_in_process(&site, who, "/api/rankings", &ranking_body(trade_amount(market), 30));
        let router = site.public_router.clone();
        tokio::spawn(async move { through(&router, request).await })
    }).collect();
    wait_until("공개 순위 두 건이 키움 대기열에 들어갔다", || site.calls_of("ka10032") >= 3).await;
    tokio::time::pause();
    let started = tokio::time::Instant::now();
    let (status, body) = through(&site.operator_router, operator_ranking(RankingMarket::Kosdaq)).await;
    let loaded = started.elapsed();
    assert_eq!(status, 200, "{}", head(&String::from_utf8_lossy(&body)));
    for walk in walks {
        assert_eq!(walk.await.unwrap().0, 200);
    }
    let extra = loaded.saturating_sub(alone);
    eprintln!("D10(9) 순위: 혼자 {alone:?}, 공개 부하 중 {loaded:?}, 더 기다림 {extra:?}");
    assert!(extra <= Duration::from_secs(2), "공개 순위 묶음이 운영자 순위를 {extra:?} 늦췄다");
    assert!(extra > Duration::ZERO, "공개 부하가 대기열을 채우지 못했다(시험이 아무것도 재지 않는다): 혼자 {alone:?}, 부하 중 {loaded:?}");
}

#[tokio::test]
async fn public_market_overview_at_its_limit_delays_an_operator_card_by_at_most_two_point_four_seconds() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_market_overview(&fake);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let sessions: Vec<Session> = site.login_many(4).await;
    tokio::time::pause();
    let operator_card = || operator_get_in_process(&site, "/api/market-overview/sectors?market=kospi");
    let flows = ["/api/market-overview/flow?market=kospi&period=20", "/api/market-overview/flow?market=kosdaq&period=20", "/api/market-overview/flow?market=kospi&period=60", "/api/market-overview/flow?market=kosdaq&period=60"];
    let started = tokio::time::Instant::now();
    assert_eq!(through(&site.operator_router, operator_card()).await.0, 200);
    let alone = started.elapsed();
    tokio::time::sleep(Duration::from_secs(10)).await;
    tokio::time::resume();
    let before = fake.requests();
    let loads: Vec<_> = flows.iter().zip(&sessions).map(|(path, who)| {
        let request = public_get_in_process(&site, who, path);
        let router = site.public_router.clone();
        tokio::spawn(async move { through(&router, request).await })
    }).collect();
    wait_until("공개 시장 개요 네 건이 키움 대기열에 들어갔다", || fake.requests() >= before + 2).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    tokio::time::pause();
    let public_requests = fake.requests() - before;
    let started = tokio::time::Instant::now();
    let (status, body) = through(&site.operator_router, operator_card()).await;
    let loaded = started.elapsed();
    assert_eq!(status, 200, "{}", head(&String::from_utf8_lossy(&body)));
    for load in loads {
        let (status, body) = load.await.unwrap();
        assert_eq!(status, 200, "{}", head(&String::from_utf8_lossy(&body)));
    }
    let extra = loaded.saturating_sub(alone);
    eprintln!("D10(9) 시장 개요: 혼자 {alone:?}, 공개 부하 중 {loaded:?}, 더 기다림 {extra:?}, 공개가 낸 요청 {} 이상", public_requests);
    assert!(extra <= Duration::from_millis(2400), "공개 시장 개요 묶음이 운영자 카드를 {extra:?} 늦췄다");
    assert!(extra > Duration::ZERO, "공개 부하가 대기열을 채우지 못했다(시험이 아무것도 재지 않는다): 혼자 {alone:?}, 부하 중 {loaded:?}");
}


async fn screener_site<'a>(work: &'a Work, idp: &'a Arc<FakeIdp>, env: &[(&'a str, &str)]) -> (Site, ScriptedTransport) {
    let fake = ScriptedTransport::new();
    fake.set_krx_market(screener_market());
    let site = Spec::new(work, idp).env(env).with_fake(fake.clone()).start().await;
    update_screener_store(&site).await;
    (site, fake)
}

#[tokio::test]
async fn screener_runs_over_the_concurrency_cap_are_503_at_once() {
    let work = Work::new();
    let idp = start_idp().await;
    let (site, fake) = screener_site(&work, &idp, &[("VALLY_PUBLIC_SCREENER_CONCURRENCY", "1"), ("VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE", "50"), ("VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE", "0")]).await;
    let (alice, bob) = (site.login("alice").await, site.login("bob").await);
    let held = fake.hold("스크리너 실행", |call| call.api_id == "ka10095");
    let first = tokio::spawn({
        let request = site.post_builder(&alice, "/api/screener/run", &new_high_screen());
        async move { Reply::of(request.send().await.unwrap()).await }
    });
    held.arrived().await;
    let started = Instant::now();
    let refused = site.post(&bob, "/api/screener/run", &new_high_screen()).await;
    assert_eq!(refused.status, 503, "{}", head(&refused.text()));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_retry_matches(&site, &refused);
    held.release();
    assert_eq!(first.await.unwrap().status, 200);
    assert_eq!(site.post(&bob, "/api/screener/run", &new_high_screen()).await.status, 200, "자리가 돌아왔다");
}

#[tokio::test]
async fn the_third_run_of_an_account_in_a_minute_and_the_fourth_of_all_are_429() {
    let work = Work::new();
    let idp = start_idp().await;
    let (site, _fake) = screener_site(&work, &idp, &[]).await;
    let (alice, bob, carol) = (site.login("alice").await, site.login("bob").await, site.login("carol").await);
    async fn run_for(site: &Site, who: &Session) -> Reply {
        site.post(who, "/api/screener/run", &new_high_screen()).await
    }
    assert_eq!(run_for(&site, &alice).await.status, 200);
    assert_eq!(run_for(&site, &alice).await.status, 200);
    let third = run_for(&site, &alice).await;
    assert_eq!(third.status, 429, "{}", head(&third.text()));
    assert_retry_matches(&site, &third);
    assert_eq!(run_for(&site, &bob).await.status, 200, "전체 분당 3회 가운데 세 번째");
    let fourth = run_for(&site, &carol).await;
    assert_eq!(fourth.status, 429, "전체 분당 3회를 넘었다: {}", head(&fourth.text()));
    assert_retry_matches(&site, &fourth);
    let wait: i64 = fourth.header("retry-after").unwrap().parse().unwrap();
    site.jump(wait);
    assert_eq!(run_for(&site, &carol).await.status, 200, "Retry-After({wait}초)만큼 가짜 시계를 넘기면 다시 받는다");
}

#[tokio::test]
async fn the_screener_status_is_shared_for_two_seconds_without_reading_the_store_again() {
    let work = Work::new();
    let idp = start_idp().await;
    let (site, fake) = screener_site(&work, &idp, &[]).await;
    let (alice, bob) = (site.login("alice").await, site.login("bob").await);
    let first = site.get(&alice, "/api/screener/status").await;
    assert_eq!(first.status, 200);
    assert_eq!(first.json()["update"], Value::Null);
    let held = fake.hold("종목 목록", |call| call.api_id == "ka10099");
    let started = site.operator_send(site.operator_request(reqwest::Method::POST, "/api/screener/update").header("content-type", "application/json").body("{\"full\":false}")).await;
    assert_eq!(started.status, 200, "{}", started.text());
    assert_ne!(started.json()["update"], Value::Null, "운영자 쪽 상태는 갱신이 돌고 있음을 바로 보인다");
    let cached = site.get(&bob, "/api/screener/status").await;
    assert_eq!(cached.json(), first.json(), "2초 안에는 저장소를 다시 읽지 않고 같은 응답을 준다");
    assert_eq!(site.usage().await["cacheHits"]["screenerStatus"], 1);
    site.jump(3);
    assert_ne!(site.get(&bob, "/api/screener/status").await.json()["update"], Value::Null, "2초가 지나면 다시 읽는다");
    held.release();
}

#[tokio::test]
async fn no_limit_zero_lets_screener_runs_pass() {
    let work = Work::new();
    let idp = start_idp().await;
    let (site, fake) = screener_site(&work, &idp, &[("VALLY_PUBLIC_SCREENER_CONCURRENCY", "0"), ("VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE", "0"), ("VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE", "100")]).await;
    let sessions: Vec<Session> = site.login_many(6).await;
    let held = fake.hold("스크리너 실행", |call| call.api_id == "ka10095");
    let pending: Vec<_> = sessions.iter().map(|who| tokio::spawn({
        let request = site.post_builder(who, "/api/screener/run", &new_high_screen());
        async move { Reply::of(request.send().await.unwrap()).await }
    })).collect();
    held.arrived().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(pending.iter().all(|reply| !reply.is_finished()), "동시 한도가 없어서 모두 실행 중이어야 한다");
    held.release();
    for reply in pending {
        assert_eq!(reply.await.unwrap().status, 200);
    }
    for who in &sessions {
        assert_eq!(site.post(who, "/api/screener/run", &new_high_screen()).await.status, 200, "전체 분당 한도도 없다");
    }
}


async fn fetch(client: &reqwest::Client, url: String, headers: &[(&str, &str)]) -> Reply {
    let mut request = client.get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    Reply::of(request.send().await.unwrap()).await
}

#[tokio::test]
async fn the_public_listener_serves_screen_files_in_brotli_and_gzip_with_etags() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let raw = std::fs::read(work.dist().join("assets/app-1a2b3c.js")).unwrap();
    let url = format!("{}/assets/app-1a2b3c.js", site.public);
    let plain = fetch(&site.http, url.clone(), &[]).await;
    assert_eq!((plain.status, plain.body.clone()), (200, raw.clone()));
    let brotli = fetch(&site.http, url.clone(), &[("accept-encoding", "br, gzip")]).await;
    assert_eq!((brotli.status, brotli.header("content-encoding")), (200, Some("br")));
    let gzip = fetch(&site.http, url.clone(), &[("accept-encoding", "gzip")]).await;
    assert_eq!((gzip.status, gzip.header("content-encoding")), (200, Some("gzip")));
    assert_eq!(gzip.body[..2], [0x1f, 0x8b], "gzip 본문이다");
    assert!(brotli.body.len() < gzip.body.len() && gzip.body.len() < raw.len() / 2, "br {} < gzip {} < 원본 {}", brotli.body.len(), gzip.body.len(), raw.len());
    for reply in [&plain, &brotli, &gzip] {
        assert!(reply.header("etag").is_some_and(|etag| !etag.is_empty()), "ETag가 없다");
        assert!(reply.header("vary").is_some_and(|vary| vary.to_ascii_lowercase().contains("accept-encoding")), "Vary가 없다");
    }
    for (encoding, reply) in [("br", &brotli), ("gzip", &gzip), ("identity", &plain)] {
        let etag = reply.header("etag").unwrap().to_owned();
        let not_modified = fetch(&site.http, url.clone(), &[("accept-encoding", encoding), ("if-none-match", &etag)]).await;
        assert_eq!((not_modified.status, not_modified.body.len()), (304, 0), "{encoding}");
        let changed = fetch(&site.http, url.clone(), &[("accept-encoding", encoding), ("if-none-match", "\"other\"")]).await;
        assert_eq!(changed.status, 200, "{encoding}");
    }
    let operator_rules: Vec<_> = {
        let mut rules = Vec::new();
        for path in ["/index.html", "/assets/app-1a2b3c.js", "/layout/abc"] {
            let operator = fetch(&site.http, format!("{}{path}", site.operator), &[]).await;
            let public = fetch(&site.http, format!("{}{path}", site.public), &[]).await;
            rules.push((path, operator.status, public.status, operator.header("cache-control").map(str::to_owned), public.header("cache-control").map(str::to_owned)));
        }
        rules
    };
    for (path, operator_status, public_status, operator_cache, public_cache) in operator_rules {
        assert_eq!((public_status, public_cache), (operator_status, operator_cache), "{path}: 캐시 헤더는 지금 규칙 그대로다");
    }
}

#[tokio::test]
async fn woff2_is_not_compressed_on_either_listener() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let raw = std::fs::read(work.dist().join("fonts/face.woff2")).unwrap();
    for base in [&site.public, &site.operator] {
        let reply = fetch(&site.http, format!("{base}/fonts/face.woff2"), &[("accept-encoding", "br, gzip")]).await;
        assert_eq!(reply.status, 200, "{base}");
        assert_eq!(reply.header("content-encoding"), None, "{base}");
        assert_eq!(reply.body, raw, "{base}");
    }
}

fn deflate_size(data: &[u8], level: i64) -> usize {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).compression_level(Some(level));
    writer.start_file("a", options).unwrap();
    writer.write_all(data).unwrap();
    let archive = writer.finish().unwrap().into_inner();
    let mut reader = zip::ZipArchive::new(std::io::Cursor::new(archive)).unwrap();
    reader.by_index(0).unwrap().compressed_size() as usize
}

#[tokio::test]
async fn the_operator_listener_compresses_javascript_at_quality_four() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).without_public().start().await;
    let raw = std::fs::read(work.dist().join("assets/app-1a2b3c.js")).unwrap();
    let reply = fetch(&site.http, format!("{}/assets/app-1a2b3c.js", site.operator), &[("accept-encoding", "gzip")]).await;
    assert_eq!((reply.status, reply.header("content-encoding")), (200, Some("gzip")));
    let gzip_overhead = 18;
    let size_at = |level| deflate_size(&raw, level) + gzip_overhead;
    assert_eq!(reply.body.len(), size_at(4), "응답 크기가 수준 4의 크기와 같다(수준 1: {}, 6: {}, 9: {})", size_at(1), size_at(6), size_at(9));
    assert!(size_at(4) != size_at(6) && size_at(4) != size_at(1), "이 본문으로는 수준 4를 다른 수준과 가릴 수 있다");
}


async fn operator_ws(site: &Site, extra: &[(&str, String)]) -> Result<(), u16> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://127.0.0.1:{}/api/ws", site.operator_port).into_client_request().unwrap();
    for (name, value) in extra {
        request.headers_mut().insert(axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(), value.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok(_) => Ok(()),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err(response.status().as_u16()),
        Err(other) => panic!("WebSocket 연결이 HTTP 응답 없이 실패했다: {other}"),
    }
}

#[tokio::test]
async fn the_operator_listener_refuses_foreign_origins_hosts_and_sites() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let own_origin = format!("http://127.0.0.1:{}", site.operator_port);
    assert_eq!(operator_ws(&site, &[]).await, Ok(()), "Origin 없는 /api/ws");
    assert_eq!(operator_ws(&site, &[("origin", own_origin.clone())]).await, Ok(()), "같은 출처의 /api/ws");
    assert_eq!(operator_ws(&site, &[("origin", site.public.clone())]).await, Err(400), "공개 출처의 /api/ws");
    assert_eq!(operator_ws(&site, &[("origin", "http://evil.example".into())]).await, Err(400), "다른 출처의 /api/ws");
    assert_eq!(operator_ws(&site, &[("host", "evil.example".into())]).await, Err(400), "다른 Host의 /api/ws");

    let send = |method: reqwest::Method, path: &str, headers: &[(&str, &str)]| {
        let mut request = site.operator_request(method, path);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        site.operator_send(request)
    };
    let get = reqwest::Method::GET;
    let post = reqwest::Method::POST;
    let foreign = send(get.clone(), "/api/trading/account-number", &[("origin", "http://evil.example")]).await;
    assert_eq!(foreign.status, 400, "{}", head(&foreign.text()));
    let public_origin = send(get.clone(), "/api/trading/account-number", &[("origin", &site.public)]).await;
    assert_eq!(public_origin.status, 400, "공개 출처의 Origin");
    for path in ["/api/screener/update", "/api/financial-update"] {
        let reply = send(post.clone(), path, &[("origin", "http://evil.example"), ("content-type", "text/plain")]).await;
        assert_eq!(reply.status, 400, "{path}: {}", head(&reply.text()));
    }
    for fetch_site in ["cross-site", "same-site"] {
        let reply = send(get.clone(), "/api/bars", &[("sec-fetch-site", fetch_site)]).await;
        assert_eq!(reply.status, 400, "{fetch_site}: {}", head(&reply.text()));
        assert!(reply.text().contains("다른 사이트"), "{}", reply.text());
    }
    let page = send(get.clone(), "/", &[("host", "evil.example")]).await;
    assert_eq!(page.status, 400, "화면 파일에도 Host 검사를 건다");

    let same_headers: [&[(&str, &str)]; 5] = [&[], &[("origin", &own_origin)], &[("sec-fetch-site", "same-origin")], &[("sec-fetch-site", "none")], &[("origin", &own_origin), ("sec-fetch-site", "same-origin")]];
    for headers in same_headers {
        let reply = send(get.clone(), "/api/screener/status", headers).await;
        assert_eq!(reply.status, 200, "{headers:?}: {}", head(&reply.text()));
    }
    assert_eq!(send(get.clone(), "/api/bars", &[("sec-fetch-site", "same-origin")]).await.status, 400, "같은 출처는 검사를 지나 본래 응답(매개변수 없음)을 받는다");
    assert!(!send(get, "/api/bars", &[("sec-fetch-site", "same-origin")]).await.text().contains("다른 사이트"));
}


#[tokio::test]
async fn only_a_collector_admin_session_may_see_the_collector_board() {
    let work = Work::new();
    let idp = start_idp().await;
    let socket = work.path().join("collector.sock").display().to_string();
    let site = Spec::new(&work, &idp).env(&[("VALLY_COLLECTOR_ADMINS", "google:boss"), ("VALLY_COLLECTOR_SOCKET", &socket)]).start().await;
    let (boss, other) = (site.login("boss").await, site.login("alice").await);
    assert_eq!(site.get(&boss, "/api/collector/access").await.json(), json!({"access": "allowed"}));
    assert_eq!(site.get(&other, "/api/collector/access").await.json(), json!({"access": "denied"}));
    assert_eq!(site.get(&boss, "/api/collector/status").await.status, 200);
    let denied = site.get(&other, "/api/collector/status").await;
    assert_eq!(denied.status, 403, "{}", head(&denied.text()));
    assert_eq!(site.get_anonymous("/api/collector/status").await.status, 401);
}

#[tokio::test]
async fn without_a_collector_setting_the_public_board_is_off() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    assert_eq!(site.get(&who, "/api/collector/access").await.json(), json!({"access": "off"}));
}

#[tokio::test]
async fn server_mode_differs_by_listener_and_public_usage_is_operator_only() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let who = site.login("alice").await;
    assert_eq!(site.operator_get("/api/server-mode").await.json(), json!({"mode": "local"}));
    assert_eq!(site.get_anonymous("/api/server-mode").await.json(), json!({"mode": "public"}));
    assert_eq!(site.get(&who, "/api/server-mode").await.json(), json!({"mode": "public"}));
    let usage = site.operator_get("/api/public-usage").await;
    assert_eq!(usage.status, 200, "{}", head(&usage.text()));
    assert!(usage.json()["bundles"].is_object());
    assert_eq!(site.get(&who, "/api/public-usage").await.status, 404);
    assert_eq!(site.get_anonymous("/api/public-usage").await.status, 401, "공개 리스너에는 없다(세션 없이는 문이 먼저 막는다)");
}

#[tokio::test]
async fn usage_counts_limits_cache_hits_top_accounts_and_operator_latency() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_market_overview(&fake);
    script_rankings(&fake, 1);
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_ACCOUNT_BURST", "6"), ("VALLY_PUBLIC_ACCOUNT_RATE", "0.001")]).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let (alice, bob) = (site.login("alice").await, site.login("bob").await);
    for _ in 0..6 {
        assert_eq!(site.get(&alice, "/api/collector/access").await.status, 200);
    }
    assert_eq!(site.get(&alice, "/api/collector/access").await.status, 429);
    for _ in 0..2 {
        assert_eq!(site.get(&bob, "/api/market-overview/index?market=kospi").await.status, 200);
    }
    for _ in 0..2 {
        assert_eq!(site.get(&bob, "/api/screener/status").await.status, 200);
    }
    let held = fake.hold("순위", |call| call.api_id == "ka10032");
    let first = tokio::spawn({
        let request = site.post_builder(&bob, "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 1));
        async move { Reply::of(request.send().await.unwrap()).await }
    });
    held.arrived().await;
    assert_eq!(site.post(&bob, "/api/rankings", &ranking_body(trade_amount(RankingMarket::Kospi), 1)).await.status, 503);
    held.release();
    assert_eq!(first.await.unwrap().status, 200);
    let operator = site.operator_send(site.operator_request(reqwest::Method::POST, "/api/rankings").header("content-type", "application/json").body(ranking_body(trade_amount(RankingMarket::Kosdaq), 1).to_string())).await;
    assert_eq!(operator.status, 200, "{}", head(&operator.text()));
    let usage = site.usage().await;
    let bundle = |name: &str, field: &str| usage["bundles"][name][field].as_u64().unwrap_or_else(|| panic!("{name}.{field}: {usage}"));
    assert_eq!((bundle("shared", "responses"), bundle("shared", "tooManyRequests"), bundle("shared", "unavailable")), (9, 1, 0), "{usage}");
    assert_eq!((bundle("market_overview", "responses"), bundle("market_overview", "tooManyRequests")), (2, 0), "{usage}");
    assert_eq!((bundle("rankings", "responses"), bundle("rankings", "tooManyRequests"), bundle("rankings", "unavailable")), (2, 0, 1), "{usage}");
    assert_eq!(usage["cacheHits"], json!({"marketOverview": 1, "screenerStatus": 1}));
    assert_eq!(usage["topAccounts"], json!([{"account": "google:alice", "requests": 7}, {"account": "google:bob", "requests": 6}]));
    assert!(bundle("rankings", "trCalls") >= 1, "공개 순위가 낸 TR 수가 세어지지 않았다: {usage}");
    assert!(bundle("market_overview", "trCalls") >= 1, "공개 시장 개요가 낸 TR 수가 세어지지 않았다: {usage}");
    for name in ["rankings", "market_overview", "shared"] {
        assert_eq!((bundle(name, "waitTotalMs"), bundle(name, "waitMaxMs")), (0, 0), "바로 거절하는 묶음의 대기 시간은 0이다: {name}");
    }
    let latency = &usage["operatorKiwoomLatency"];
    let samples = latency["current"]["samples"].as_u64().unwrap() + latency["lastMinute"]["samples"].as_u64().unwrap_or(0);
    assert_eq!(samples, 1, "운영자 리스너의 키움 경로 응답 시간만 센다: {latency}");
}

#[tokio::test]
async fn a_failed_market_overview_card_carries_fixed_words_and_is_never_served_from_the_cache() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_market_overview(&fake);
    fake.respond_with("ka20003", 200, json!({"return_code": 1501, "return_msg": "운영자만 아는 사정"}));
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    let alice = site.login("alice").await;
    let bob = site.login("bob").await;
    let path = "/api/market-overview/index?market=kospi";
    let failed = site.get(&alice, path).await;
    assert_eq!(failed.status, 200, "{}", head(&failed.text()));
    let text = failed.text();
    assert!(text.contains("\"failed\""), "{}", head(&text));
    assert!(!text.contains("1501") && !text.contains("ka20003") && !text.contains("운영자"), "{}", head(&text));
    assert!(text.contains("\"manualActionRequired\":false"), "{}", head(&text));
    site.jump(1);
    let again = site.get(&bob, path).await;
    assert!(!again.text().contains("1501"), "{}", head(&again.text()));
    assert_eq!(site.usage().await["cacheHits"]["marketOverview"], 0);
}

#[tokio::test]
async fn the_same_market_overview_query_in_another_parameter_order_hits_the_cache() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_market_overview(&fake);
    let site = Spec::new(&work, &idp).with_fake(fake.clone()).start().await;
    let who = site.login("alice").await;
    assert_eq!(site.get(&who, "/api/market-overview/flow?market=kospi&period=20").await.status, 200);
    let before = fake.requests();
    assert_eq!(site.get(&who, "/api/market-overview/flow?period=20&market=kospi").await.status, 200);
    assert_eq!(fake.requests(), before);
}

#[tokio::test]
async fn screen_files_are_never_compressed_again_on_the_fly() {
    let work = Work::new();
    std::fs::write(work.dist().join("assets/photo-1a2b.webp"), vec![7u8; 4096]).unwrap();
    std::fs::write(work.dist().join("robots.txt"), "User-agent: *\n").unwrap();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    for (path, content_type) in [("/assets/photo-1a2b.webp", "image/webp"), ("/robots.txt", "text/plain; charset=utf-8")] {
        let reply = fetch(&site.http, format!("{}{path}", site.public), &[("accept-encoding", "gzip")]).await;
        assert_eq!(reply.status, 200, "{path}");
        assert_eq!(reply.header("content-type"), Some(content_type), "{path}");
        assert_eq!(reply.header("content-encoding"), None, "{path}");
    }
}
