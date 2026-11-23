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
use server::market_source::rankings::condition_key;
use server::shared_data::{Broker, ConditionEntry, ConditionState, DataKind, Header, OverviewBody, RankingsPartBody, ReceivedRanking, SharedRankingRow, SnapshotBody, SnapshotRow, SourceKey, data_path, part_path, write_snapshot, write_snapshot_at};
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

fn shared_dir(work: &Work) -> PathBuf {
    work.path().join("shared")
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

async fn kiwoom_error_here() -> (axum::http::StatusCode, axum::Json<Value>) {
    let body = json!({"error": {"code": "kiwoom_unavailable", "message": format!("{ORIGINAL_KIWOOM_TEXT}[1700:유량=5]"), "reason": null, "retryAt": null, "manualActionRequired": true}});
    (axum::http::StatusCode::BAD_GATEWAY, axum::Json(body))
}

#[allow(unreachable_code)]
async fn panic_here() -> &'static str {
    panic!("시험용 panic");
    "never"
}

fn test_routes(held: Arc<Held>) -> Router<Arc<AppState>> {
    Router::new().route("/api/test/hold", get(hold_here)).route("/api/test/panic", get(panic_here)).route("/api/test/kiwoom-error", get(kiwoom_error_here)).layer(Extension(held))
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
    login_router: Router,
    held: Arc<Held>,
    work_shared: PathBuf,
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
            let shared = shared_dir(self.work);
            std::fs::create_dir_all(&shared).unwrap();
            vars.insert("VALLY_SHARED_DATA_DIR".to_owned(), shared.display().to_string());
        }
        vars.extend(self.env.into_iter().map(|(key, value)| (key.to_owned(), value)));
        let config = config_of(vars).unwrap_or_else(|e| panic!("설정 오류: {e}"));
        let fake = self.fake.unwrap_or_default();
        let lock = server::instance::InstanceLock::acquire(&config.lock_path).unwrap();
        let (events, stream_events) = tokio::sync::mpsc::channel(16);
        let adapters = Adapters { kiwoom: fake.transport(), kis: None, kis_feed: None, stream: StreamSource::Detached(stream_events), kiwoom_spacing: None, dart_spacing: Some(Duration::from_millis(1)) };
        let started = server::app::start(&config, &lock, adapters).await.unwrap_or_else(|_| panic!("서버가 시작하지 못했다"));
        let server::app::Started { state, router, listener, automatic, public } = started;
        drop(automatic);
        state.rest.set_access(Access::Open);
        let held = Arc::new(Held::new());
        let mut tasks = Vec::new();
        let operator_port = listener.local_addr().unwrap().port();
        tasks.push(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }));
        let public_origin = match public {
            Some(public) => {
                let router = public.router_with(test_routes(held.clone()));
                let listener = public.listener;
                tasks.push(tokio::spawn(async move {
                    axum::serve(listener, router).await.unwrap();
                }));
                public_origin
            }
            None => String::new(),
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
            fake,
            idp: self.idp.clone(),
            operator: format!("http://127.0.0.1:{operator_port}"),
            operator_port,
            public: public_origin,
            held,
            work_shared: shared_dir(self.work),
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

    async fn publish_boards(&self) {
        let (shared, at) = (self.work_shared.clone(), self.now());
        write_overview_board(&shared, at, healthy_index());
        write_rankings_board(&shared, at);
        write_screener_snapshot(&shared, at);
        self.state.shared_data.poll_once(&shared).await;
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

const BOARD_DAY: &str = "20261106";
const ORIGINAL_KIWOOM_TEXT: &str = "ORIGINAL-KIWOOM-TEXT-8005 공인 IP 등록 안내";

fn board_header(kind: DataKind, at: i64) -> Header {
    Header::new(kind, domain::KstDate::parse_yyyymmdd(BOARD_DAY).unwrap(), at, at, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }])
}

fn card_context(market: &str, at: i64) -> Value {
    json!({"market": market, "phase": "regular", "receivedAt": at, "source": "kiwoom"})
}

fn ok_part(value: Value) -> Value {
    json!({"status": "ok", "value": value})
}

fn failed_part(message: &str) -> Value {
    json!({"status": "failed", "error": {"code": "kiwoom_unavailable", "message": message, "manualActionRequired": true, "reason": null, "retryAt": null}})
}

fn market_cards(market: &str, at: i64, index: Value) -> Value {
    let context = card_context(market, at);
    let flow = |period: &str| json!({"context": context, "period": period, "investors": ok_part(json!([{"date": "2026-11-06", "individualEok": 1, "foreignEok": 2, "institutionEok": 3}])), "program": ok_part(json!([{"date": "2026-11-06", "arbitrageEok": 1.0, "nonArbitrageEok": 2.0, "totalEok": 3.0}]))});
    let turnover = |period: &str| json!({"context": context, "period": period, "days": ok_part(json!([{"date": "2026-11-06", "tradeValueEok": 5.0}]))});
    let board = json!({"foreign": [{"code": "005930", "name": "삼성전자", "days": 3, "netEok": 1.0, "netShares": 10, "periodChangeRate": 0.1}], "institution": []});
    json!({
        "index": {"context": context, "index": index},
        "sectors": {"context": context, "sectors": ok_part(json!([{"code": "013", "name": "전기전자", "level": 1.0, "changeRate": 2.0, "tradeValueEok": 3.0}])), "flows": ok_part(json!([{"code": "013", "name": "전기전자", "wholeMarket": false, "individualEok": 1, "foreignEok": 2, "institutionEok": 3}]))},
        "flow": [flow("5"), flow("20"), flow("60")],
        "turnover": [turnover("5"), turnover("20"), turnover("60")],
        "streaks": {"context": context, "buying": ok_part(board), "selling": ok_part(json!({"foreign": [], "institution": []}))},
    })
}

fn healthy_index() -> Value {
    ok_part(json!({"code": "001", "name": "종합", "level": 2500.0, "changeRate": 0.5, "breadth": {"rising": 1, "flat": 2, "falling": 3, "upperLimit": 4, "lowerLimit": 5}, "tradeValueEok": 9.0, "volatility": null}))
}

fn write_overview_board(shared: &Path, at: i64, kospi_index: Value) {
    let body: OverviewBody = serde_json::from_value(json!({"kospi": market_cards("kospi", at, kospi_index), "kosdaq": market_cards("kosdaq", at, healthy_index())})).unwrap();
    write_snapshot_at(data_path(shared, DataKind::MarketOverview, BOARD_DAY, "json"), board_header(DataKind::MarketOverview, at), body).unwrap();
}

fn ranking_row(code: &str) -> SharedRankingRow {
    serde_json::from_value(json!({"code": code, "name": format!("판{code}"), "price": 1000, "changeRate": 0.5, "figures": {"kind": "tradeAmount", "tradeAmount": 7, "volume": 3, "placesGained": null}})).unwrap()
}

fn write_rankings_board(shared: &Path, at: i64) {
    let rows: Vec<SharedRankingRow> = ["005930", "000660"].iter().cycle().take(10).map(|code| ranking_row(code)).collect();
    let conditions = [RankingMarket::All, RankingMarket::Kospi, RankingMarket::Kosdaq]
        .into_iter()
        .map(|market| ConditionEntry { key: condition_key(&trade_amount(market)), state: ConditionState::Ready, last: Some(ReceivedRanking { rows: rows.clone(), pages: 5, end: false, limited: false, received_at: at, broker: Broker::Kiwoom, page_rows: vec![2; 5] }) })
        .collect();
    write_snapshot_at(part_path(shared, BOARD_DAY, "rest-01"), board_header(DataKind::Rankings, at), RankingsPartBody { period_secs: 10, pages: 5, conditions }).unwrap();
}

fn write_screener_snapshot(shared: &Path, at: i64) {
    let row = SnapshotRow { code: "200010".into(), day: BOARD_DAY.into(), current_won: 130, base_won: 100, open_won: 100, high_won: 130, low_won: 100, volume: 5_000, traded_million_won: 1, traded_at: None };
    write_snapshot(shared, board_header(DataKind::SnapshotKrx, at), SnapshotBody { closing: false, requested: 1, missing: 0, stocks: vec![row], indices: vec![] }).unwrap();
}

fn script_operator_ranking(fake: &ScriptedTransport) {
    let row = json!({"stk_cd": "000001", "stk_nm": "키움000001", "now_rank": "1", "pred_rank": "1", "cur_prc": "1000", "flu_rt": "0.5", "now_trde_qty": "10", "trde_prica": "1"});
    fake.respond_with("ka10032", 200, json!({"_headers": {"cont-yn": "N", "next-key": ""}, "trde_prica_upper": [row], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"}));
}

fn head(text: &str) -> String {
    text.chars().take(200).collect()
}

fn public_host(site: &Site) -> String {
    site.public.trim_start_matches("http://").to_owned()
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
        vars.insert("VALLY_SHARED_DATA_DIR".into(), shared_dir(&work).display().to_string());
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
        ("VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE", "0"),
        ("VALLY_PUBLIC_ACCOUNT_LIMIT", "0"),
    ] {
        let leaked = Box::leak(value.to_owned().into_boxed_str());
        let key: &'static str = Box::leak(name.to_owned().into_boxed_str());
        assert!(build(&set(key, leaked)).is_err(), "{name}={value}가 받아들여졌다");
    }
    let retired: Vec<String> = RETIRED_LIMITS.iter().map(|name| (*name).to_owned()).collect();
    let mut vars = operator_vars(work.path(), "127.0.0.1:8080");
    vars.extend(public_vars(&idp, "127.0.0.1:18443", "https://vally.example.ts.net"));
    vars.insert("VALLY_SHARED_DATA_DIR".into(), shared_dir(&work).display().to_string());
    for name in &retired {
        vars.insert(name.clone(), "not-a-number".into());
    }
    let (_, warnings) = Config::from_values(vars).unwrap_or_else(|e| panic!("걷은 한도 변수는 틀린 값이어도 시작을 막지 않는다: {e}"));
    let warning = warnings.iter().find(|line| line.contains("무시")).unwrap_or_else(|| panic!("무시 경고가 없다: {warnings:?}"));
    for name in &retired {
        assert!(warning.contains(name.as_str()), "{name}가 경고에 없다: {warning}");
    }
}

const RETIRED_LIMITS: &[&str] = &[
    "VALLY_PUBLIC_KIWOOM_ACCOUNT_IN_FLIGHT",
    "VALLY_PUBLIC_MARKET_CONCURRENCY",
    "VALLY_PUBLIC_RANKINGS_CONCURRENCY",
    "VALLY_PUBLIC_BOARD_CONCURRENCY",
    "VALLY_PUBLIC_FLOW_CONCURRENCY",
    "VALLY_PUBLIC_FLOW_TR_PER_MINUTE",
    "VALLY_PUBLIC_FLOW_ACCOUNT_TR_PER_MINUTE",
    "VALLY_PUBLIC_FLOW_FETCH_CONCURRENCY",
    "VALLY_PUBLIC_BOARD_TR_PER_WINDOW",
    "VALLY_PUBLIC_KIWOOM_SENDS_PER_WINDOW",
    "VALLY_PUBLIC_MARKET_CACHE_SECS",
    "VALLY_PUBLIC_RANKING_MAX_PAGES",
    "VALLY_PUBLIC_SCREENER_CONCURRENCY",
    "VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE",
];

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
    ("GET", "/api/kiwoom-themes", true),
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
    site.publish_boards().await;
    let who = site.login("alice").await;
    let status = site.get(&who, "/api/screener/status").await;
    assert_eq!(status.status, 200);
    assert!(status.json()["lastDay"].is_string(), "{}", status.text());
    let requests_before_reads = site.fake.requests();
    let run = site.post(&who, "/api/screener/run", &new_high_screen()).await;
    assert_eq!(run.status, 200, "{}", head(&run.text()));
    assert!(run.json()["rows"].is_array());
    site.load_symbols();
    for path in ["/api/etf/funds", "/api/symbols?q=%EC%82%BC%EC%84%B1", "/api/symbols/005930", "/api/financial-update", "/api/symbols/005930/financials?period=Y", "/api/symbols/005930/financial-source", "/api/market-overview/index?market=kospi"] {
        let reply = site.get(&who, path).await;
        assert_eq!(reply.status, 200, "{path}: {}", head(&reply.text()));
    }
    let ranking = site.post(&who, "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 1)).await;
    assert_eq!(ranking.status, 200, "{}", head(&ranking.text()));
    assert!(ranking.json()["rows"].as_array().is_some_and(|rows| !rows.is_empty()));
    assert_eq!(site.fake.requests(), requests_before_reads, "공개 읽기는 키움에 가지 않는다");
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
    site.publish_boards().await;
    let who = site.login("alice").await;
    let body = ranking_body(trade_amount(RankingMarket::All), 1).to_string();
    let send = |origin: Option<&str>, content_type: &str| {
        let mut request = site.http.post(format!("{}/api/rankings", site.public)).header("cookie", &who.cookie).header("content-type", content_type.to_owned()).body(body.clone());
        if let Some(origin) = origin {
            request = request.header("origin", origin.to_owned());
        }
        async move { Reply::of(request.send().await.unwrap()).await }
    };
    let ok = send(Some(&site.public), "application/json").await;
    assert_eq!(ok.status, 200, "{}", head(&ok.text()));
    assert_eq!(send(Some(&site.public), "application/json; charset=utf-8").await.status, 200);
    assert_eq!(send(None, "application/json").await.status, 400, "Origin이 없는 POST");
    assert_eq!(send(Some(&site.public), "text/plain").await.status, 400, "text/plain POST");
    assert_eq!(send(Some(&site.public), "application/x-www-form-urlencoded").await.status, 400);
    assert_eq!(send(Some("http://evil.example"), "application/json").await.status, 400, "다른 Origin의 POST");
    assert_eq!(site.calls_of("ka10032"), 0, "공개 순위는 키움에 가지 않는다");
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


#[tokio::test]
async fn a_kiwoom_failure_leaves_the_public_listener_with_fixed_words_and_no_kiwoom_text() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let alice = site.login("alice").await;
    let failed = site.get(&alice, "/api/test/kiwoom-error").await;
    assert_eq!(failed.status, 503, "{}", head(&failed.text()));
    let body = failed.json();
    assert_eq!(body["error"]["code"], "kiwoom_unavailable");
    assert_eq!(body["error"]["message"], KIWOOM_FIXED);
    assert_eq!(body["error"]["manualActionRequired"], false);
    assert!(!failed.text().contains("ORIGINAL-KIWOOM-TEXT") && !failed.text().contains("1700"), "{}", failed.text());
    assert_retry_matches(&site, &failed);
}


async fn screener_site<'a>(work: &'a Work, idp: &'a Arc<FakeIdp>, env: &[(&'a str, &str)]) -> (Site, ScriptedTransport) {
    let fake = ScriptedTransport::new();
    fake.set_krx_market(screener_market());
    let site = Spec::new(work, idp).env(env).with_fake(fake.clone()).start().await;
    update_screener_store(&site).await;
    (site, fake)
}

#[tokio::test]
async fn the_third_run_of_an_account_in_a_minute_is_429_and_other_accounts_are_not_held_by_it() {
    let work = Work::new();
    let idp = start_idp().await;
    let (site, _fake) = screener_site(&work, &idp, &[]).await;
    site.publish_boards().await;
    let (alice, bob, carol) = (site.login("alice").await, site.login("bob").await, site.login("carol").await);
    async fn run_for(site: &Site, who: &Session) -> Reply {
        site.post(who, "/api/screener/run", &new_high_screen()).await
    }
    assert_eq!(run_for(&site, &alice).await.status, 200);
    assert_eq!(run_for(&site, &alice).await.status, 200);
    let third = run_for(&site, &alice).await;
    assert_eq!(third.status, 429, "{}", head(&third.text()));
    assert_retry_matches(&site, &third);
    assert_eq!(run_for(&site, &bob).await.status, 200, "다른 계정은 같은 분에 막히지 않는다");
    assert_eq!(run_for(&site, &carol).await.status, 200, "전체 분당 한도는 없다");
    let wait: i64 = third.header("retry-after").unwrap().parse().unwrap();
    site.jump(wait);
    assert_eq!(run_for(&site, &alice).await.status, 200, "Retry-After({wait}초)만큼 가짜 시계를 넘기면 다시 받는다");
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
async fn usage_counts_limits_cache_hits_top_accounts_shared_data_and_operator_latency() {
    let work = Work::new();
    let idp = start_idp().await;
    let fake = ScriptedTransport::new();
    script_operator_ranking(&fake);
    let site = Spec::new(&work, &idp).env(&[("VALLY_PUBLIC_ACCOUNT_BURST", "6"), ("VALLY_PUBLIC_ACCOUNT_RATE", "0.001")]).with_fake(fake.clone()).start().await;
    site.load_symbols();
    let before_boards = site.usage().await;
    assert!(before_boards["sharedData"].is_object(), "{before_boards}");
    assert!(before_boards["sharedData"].as_object().unwrap().values().all(|kind| kind["ageSecs"].is_null()), "판이 없으면 ageSecs는 null이다: {before_boards}");
    site.publish_boards().await;
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
    assert_eq!(site.post(&bob, "/api/rankings", &ranking_body(trade_amount(RankingMarket::All), 1)).await.status, 200);
    let operator = site.operator_send(site.operator_request(reqwest::Method::POST, "/api/rankings").header("content-type", "application/json").body(ranking_body(trade_amount(RankingMarket::Kosdaq), 1).to_string())).await;
    assert_eq!(operator.status, 200, "{}", head(&operator.text()));
    let usage = site.usage().await;
    let bundle = |name: &str, field: &str| usage["bundles"][name][field].as_u64().unwrap_or_else(|| panic!("{name}.{field}: {usage}"));
    assert_eq!((bundle("shared", "responses"), bundle("shared", "tooManyRequests"), bundle("shared", "unavailable")), (9, 1, 0), "{usage}");
    assert_eq!((bundle("market_overview", "responses"), bundle("market_overview", "tooManyRequests")), (2, 0), "{usage}");
    assert_eq!((bundle("rankings", "responses"), bundle("rankings", "tooManyRequests"), bundle("rankings", "unavailable")), (1, 0, 0), "{usage}");
    assert_eq!(usage["cacheHits"], json!({"screenerStatus": 1}));
    assert_eq!(usage["topAccounts"], json!([{"account": "google:alice", "requests": 7}, {"account": "google:bob", "requests": 5}]));
    let shared_data = usage["sharedData"].as_object().unwrap_or_else(|| panic!("{usage}"));
    for (kind, status) in shared_data {
        assert!(status["readErrors"].is_u64(), "{kind}: {usage}");
    }
    let aged = |kind: &str| shared_data.get(kind).unwrap_or_else(|| panic!("{kind}: {usage}"))["ageSecs"].clone();
    assert!(aged("market-overview").is_u64(), "쓴 판은 ageSecs가 숫자이다: {usage}");
    assert!(shared_data.values().any(|status| status["ageSecs"].is_null()), "쓰지 않은 종류는 ageSecs가 null이다: {usage}");
    let latency = &usage["operatorKiwoomLatency"];
    let samples = latency["current"]["samples"].as_u64().unwrap() + latency["lastMinute"]["samples"].as_u64().unwrap_or(0);
    assert_eq!(samples, 1, "운영자 리스너의 키움 경로 응답 시간만 센다: {latency}");
}

#[tokio::test]
async fn a_failed_market_overview_card_carries_fixed_words_on_the_public_listener_and_the_original_on_the_operator_one() {
    let work = Work::new();
    let idp = start_idp().await;
    let site = Spec::new(&work, &idp).start().await;
    let at = site.now();
    write_overview_board(&work.path().join("shared"), at, failed_part(&format!("{ORIGINAL_KIWOOM_TEXT} 1501 ka20003")));
    site.state.shared_data.poll_once(&work.path().join("shared")).await;
    let alice = site.login("alice").await;
    let path = "/api/market-overview/index?market=kospi";
    let failed = site.get(&alice, path).await;
    assert_eq!(failed.status, 200, "{}", head(&failed.text()));
    let text = failed.text();
    assert!(text.contains("\"failed\""), "{}", head(&text));
    assert!(!text.contains("1501") && !text.contains("ka20003") && !text.contains("ORIGINAL-KIWOOM-TEXT"), "{}", head(&text));
    let error = &failed.json()["index"]["error"];
    assert_eq!((error["message"].as_str(), error["manualActionRequired"].as_bool()), (Some(KIWOOM_FIXED), Some(false)), "{text}");
    assert_eq!(error["retryAt"].as_i64(), Some(site.now() + 5), "{text}");
    let operator = site.operator_get(path).await;
    assert_eq!(operator.status, 200, "{}", head(&operator.text()));
    assert!(operator.text().contains("ORIGINAL-KIWOOM-TEXT"), "운영자 리스너는 판의 원문을 그대로 낸다: {}", head(&operator.text()));
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
