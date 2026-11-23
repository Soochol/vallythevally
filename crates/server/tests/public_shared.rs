mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use account_server::fake_idp::{ClientCredentials, FakeIdp};
use account_server::{AccountConfig, AccountOptions, Accounts, GoogleConfig, IdpUrl, NaverConfig, PublicUrl, Secret, SystemClock, open_database};
use axum::Router;
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use serde_json::{Value, json};
use server::api::{Excludes, Ranking, RankingMarket, Venue};
use server::app::{Adapters, StreamSource};
use server::clock::kst;
use server::config::Config;
use server::http::AppState;
use server::kiwoom::rest::Access;
use server::market_source::rankings::condition_key;
use server::shared_data::{
    Broker, ConditionEntry, ConditionState, DataKind, FeedWriter, Header, IndexRow, MinuteBar, MinuteInstrument, MinuteVenue, OverviewBody, RankingsPartBody, ReceivedRanking, SAMPLES_FOLDER, SharedRankingRow, SnapshotBody,
    SnapshotRow, SourceKey, data_path, minute_path, part_path, write_snapshot, write_snapshot_at,
};
use server::symbols::Directory;
use support::{APP_KEY, APP_SECRET, ScriptedTransport};
use tower::ServiceExt;

const GOOGLE_SECRET: &str = "google-secret-public-shared-6c1d";
const NAVER_SECRET: &str = "naver-secret-public-shared-90ae";
const FRIDAY_EVENING: &str = "20261106203000";
const DAY: &str = "20261106";
const LISTED: [(&str, &str); 3] = [("005930", "삼성전자"), ("000660", "SK하이닉스"), ("200010", "가상200010")];

fn friday(hour: u32, minute: u32, second: u32) -> i64 {
    kst(KstDate::new(2026, 11, 6).unwrap(), hour, minute, second).unix()
}

fn open_public_listener() -> (std::net::TcpListener, u16) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

fn operator_vars(work: &Path) -> BTreeMap<String, String> {
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
        ("VALLY_BIND", "127.0.0.1:0".to_owned()),
        ("VALLY_LOG", "server=warn".to_owned()),
        ("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:1".to_owned()),
        ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:1".to_owned()),
        ("VALLY_PUBLIC_IP_URL", "http://127.0.0.1:1".to_owned()),
        ("VALLY_SCREENER_UPDATE_ON_START", "off".to_owned()),
        ("VALLY_CLOCK_START", FRIDAY_EVENING.to_owned()),
        ("VALLY_KIWOOM_APP_KEY", APP_KEY.to_owned()),
        ("VALLY_KIWOOM_APP_SECRET", APP_SECRET.to_owned()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn public_vars(idp: &FakeIdp, bind: &str, origin: &str) -> BTreeMap<String, String> {
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

fn cookie_pairs(headers: &axum::http::HeaderMap) -> Vec<(String, String)> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|line| line.to_str().ok()?.split(';').next()?.split_once('=').map(|(name, value)| (name.to_owned(), value.to_owned())))
        .collect()
}

struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("JSON이 아니다({e}): {}", String::from_utf8_lossy(&self.body)))
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

struct Session {
    cookie: String,
}

struct Site {
    state: Arc<AppState>,
    fake: ScriptedTransport,
    idp: Arc<FakeIdp>,
    shared: PathBuf,
    operator_host: String,
    public: String,
    operator_router: Router,
    login_router: Router,
    http: reqwest::Client,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    _work: tempfile::TempDir,
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

fn work_folder() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let dist = dir.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html><title>vally</title>").unwrap();
    std::fs::create_dir_all(dir.path().join("shared")).unwrap();
    dir
}

impl Site {
    async fn start(fake: ScriptedTransport) -> Site {
        let idp = start_idp().await;
        let work = work_folder();
        let (opened, public_port) = open_public_listener();
        let public_origin = format!("http://127.0.0.1:{public_port}");
        let mut vars = operator_vars(work.path());
        vars.extend(public_vars(&idp, &format!("127.0.0.1:{public_port}"), &public_origin));
        let shared = work.path().join("shared");
        vars.insert("VALLY_SHARED_DATA_DIR".into(), shared.display().to_string());
        vars.insert("VALLY_SHARED_DATA_POLL_MILLIS".into(), "3600000".into());
        let (config, _) = Config::from_values(vars).unwrap_or_else(|e| panic!("설정 오류: {e}"));
        let lock = server::instance::InstanceLock::acquire(&config.lock_path).unwrap();
        let (events, stream_events) = tokio::sync::mpsc::channel(16);
        let adapters = Adapters { kiwoom: fake.transport(), kis: None, kis_feed: None, stream: StreamSource::Detached(stream_events), kiwoom_spacing: None };
        let started = server::app::start_with(&config, &lock, adapters, server::app::StartOptions { public_listener: Some(opened), frozen_clock: false }).await.unwrap_or_else(|_| panic!("서버가 시작하지 못했다"));
        let server::app::Started { state, router, listener, public } = started;
        state.rest.set_access(Access::Open);
        let public = public.expect("공개 설정이 있다");
        let operator_host = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
        let mut tasks = Vec::new();
        let operator_router = router.clone();
        tasks.push(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }));
        let served = public.router();
        let public_listener = public.listener;
        tasks.push(tokio::spawn(async move {
            axum::serve(public_listener, served).await.unwrap();
        }));
        let endpoint = |path: &str| IdpUrl::parse(&idp.url(path)).unwrap();
        let account_config = AccountConfig {
            public_url: PublicUrl::parse(&public_origin).unwrap(),
            google: GoogleConfig { client_id: "google-id".into(), client_secret: Secret::new(GOOGLE_SECRET), authorize_url: endpoint("/google/authorize"), token_url: endpoint("/google/token") },
            naver: NaverConfig { client_id: "naver-id".into(), client_secret: Secret::new(NAVER_SECRET), authorize_url: endpoint("/naver/authorize"), token_url: endpoint("/naver/token"), profile_url: endpoint("/naver/profile") },
        };
        let pool = open_database(&work.path().join("data/public-accounts.db")).await.unwrap();
        let login_router = Accounts::new(account_config, AccountOptions::default(), pool, Arc::new(SystemClock)).browser_router();
        Site {
            state,
            fake,
            idp,
            shared,
            operator_host,
            public: public_origin,
            operator_router,
            login_router,
            http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().timeout(Duration::from_secs(15)).build().unwrap(),
            tasks,
            _work: work,
            _lock: lock,
            _events: events,
        }
    }

    fn load_symbols(&self) {
        let listed = |code: &str, name: &str| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: false };
        self.state.symbols.replace(Directory::build(LISTED.iter().map(|(code, name)| listed(code, name)).collect()));
    }

    async fn poll(&self) {
        self.state.shared_data.poll_once(&self.shared).await;
    }

    async fn hop(&self, uri: &str, cookie: Option<String>) -> (u16, axum::http::HeaderMap) {
        let mut request = axum::http::Request::get(uri);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = self.login_router.clone().oneshot(request.body(axum::body::Body::empty()).unwrap()).await.unwrap();
        (response.status().as_u16(), response.headers().clone())
    }

    async fn login(&self, subject: &str) -> Session {
        self.idp.set_subject(subject);
        let (status, headers) = self.hop("/v1/session/google/start", None).await;
        assert_eq!(status, 302, "로그인 시작은 IdP로 보낸다");
        let mut cookies: BTreeMap<String, String> = cookie_pairs(&headers).into_iter().collect();
        let authorize = headers["location"].to_str().unwrap().to_owned();
        let at_idp = self.http.get(&authorize).send().await.unwrap();
        assert_eq!(at_idp.status(), 302);
        let callback = at_idp.headers()["location"].to_str().unwrap().to_owned();
        let callback = callback.strip_prefix(&self.public).unwrap_or_else(|| panic!("callback이 공개 출처로 온다: {callback}")).to_owned();
        let header: Vec<String> = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect();
        let (status, headers) = self.hop(&callback, Some(header.join("; "))).await;
        assert_eq!(status, 302, "callback은 화면 첫 주소로 보낸다");
        cookies.extend(cookie_pairs(&headers));
        let session = cookies.iter().find(|(name, value)| name.ends_with("vally_session") && !value.is_empty()).unwrap_or_else(|| panic!("세션 쿠키가 없다: {cookies:?}"));
        Session { cookie: format!("{}={}", session.0, session.1) }
    }

    async fn get(&self, session: &Session, path: &str) -> Reply {
        let response = self.http.get(format!("{}{path}", self.public)).header("cookie", &session.cookie).send().await.unwrap();
        Reply { status: response.status().as_u16(), body: response.bytes().await.unwrap().to_vec() }
    }

    async fn send_json(&self, session: &Session, method: reqwest::Method, path: &str, body: &Value) -> Reply {
        let request = self.http.request(method, format!("{}{path}", self.public)).header("cookie", &session.cookie).header("origin", &self.public).header("content-type", "application/json").body(body.to_string());
        let response = request.send().await.unwrap();
        Reply { status: response.status().as_u16(), body: response.bytes().await.unwrap().to_vec() }
    }

    async fn operator_get(&self, path: &str) -> Reply {
        let response = self.operator_router.clone().oneshot(axum::http::Request::get(path).header("host", &self.operator_host).body(axum::body::Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        Reply { status, body: http_body_util::BodyExt::collect(response.into_body()).await.unwrap().to_bytes().to_vec() }
    }

    async fn usage(&self) -> Value {
        let reply = self.operator_get("/api/public-usage").await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        reply.json()
    }

    async fn fill_screener_store(&self) {
        self.fake.set_krx_market(screener_market());
        self.state.link.connect(false).await;
        let request = axum::http::Request::post("/api/screener/update").header("host", &self.operator_host).header("content-type", "application/json").body(axum::body::Body::from("{\"full\":false}")).unwrap();
        assert_eq!(self.operator_router.clone().oneshot(request).await.unwrap().status(), 200);
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let status = self.operator_get("/api/screener/status").await.json();
            if !status["lastDay"].is_null() && status["update"].is_null() {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "스크리너 저장소가 채워지지 않았다: {status}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn open_days(from: KstDate, through: KstDate) -> Vec<KstDate> {
    std::iter::successors(Some(from), |d| Some(d.add_days(1))).take_while(|d| *d <= through).filter(|d| !matches!(d.weekday(), domain::Weekday::Sat | domain::Weekday::Sun)).collect()
}

fn screener_market() -> support::krx::KrxMarket {
    use support::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
    let days = open_days(KstDate::new(2026, 10, 19).unwrap(), KstDate::new(2026, 11, 6).unwrap());
    let bars: Vec<KrxBar> = days
        .iter()
        .enumerate()
        .map(|(i, &day)| {
            let price = 100 + i as u64;
            KrxBar { day, open: price, high: price, low: price, close: price, volume: 1_000, traded_million_won: price * 1_000 / 1_000_000, base: price, adjustment_rate: None }
        })
        .collect();
    let stock = KrxStock { code: "200010".into(), name: "가상200010".into(), market_code: "0".into(), company_class_name: String::new(), reg_day: days[0], audit_info: "정상".into(), listed_shares: Some(1_000_000), quoted: true, daily: DailyAnswer::Bars, bars };
    KrxMarket { days, stocks: vec![stock] }
}

fn new_high_screen() -> Value {
    json!({"id": "S1", "name": "시험 조건식", "markets": [], "exclude": [], "conditions": [{"kind": "new_high", "period": "D", "field": "high", "n": 5, "recentBars": 1}]})
}

fn sources() -> Vec<SourceKey> {
    vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]
}

fn snapshot_row(code: &str, current: u64, base: u64) -> SnapshotRow {
    SnapshotRow { code: code.into(), day: DAY.into(), current_won: current, base_won: base, open_won: base, high_won: current.max(base), low_won: current.min(base), volume: 100, traded_million_won: 500, traded_at: Some(friday(20, 29, 0)) }
}

fn write_boards(dir: &Path, as_of: i64) {
    let day = KstDate::new(2026, 11, 6).unwrap();
    let kospi = IndexRow { code: "001".into(), name: "코스피".into(), level: 2_650.0, change_rate: 1.0, trade_million_won: 0 };
    let stocks = || vec![snapshot_row("005930", 51_000, 50_000), snapshot_row("000660", 109_000, 100_000), snapshot_row("200010", 121, 120)];
    for kind in [DataKind::SnapshotKrx, DataKind::SnapshotCombined, DataKind::SnapshotNxt] {
        let stocks = stocks();
        let requested = stocks.len() as u32;
        write_snapshot(dir, Header::new(kind, day, as_of, as_of, sources()), SnapshotBody { closing: false, requested, missing: 0, stocks, indices: vec![kospi.clone()] }).unwrap();
    }
}

fn minute_bar(symbol: &str, minute: u16, close: f64, value: i64) -> MinuteBar {
    MinuteBar {
        symbol: symbol.into(),
        instrument: MinuteInstrument::Stock,
        venue: Some(MinuteVenue::Krx),
        minute,
        open: close,
        high: close,
        low: close,
        close,
        volume: 10,
        value,
        trades: 1,
        first_sec: u32::from(minute) * 60,
        last_sec: u32::from(minute) * 60 + 30,
    }
}

fn write_minutes(dir: &Path, as_of: i64) {
    let header = Header::new(DataKind::Minute, KstDate::new(2026, 11, 6).unwrap(), as_of, as_of, sources());
    let mut writer = FeedWriter::open_at(&minute_path(dir, DAY, "collect-01"), header).unwrap();
    for bar in [minute_bar("005930", 540, 50_500.0, 1_000_000), minute_bar("005930", 545, 51_000.0, 2_000_000), minute_bar("000660", 541, 101_000.0, 10_000_000)] {
        writer.append(&bar).unwrap();
    }
    writer.sync().unwrap();
}

fn trade_amount() -> Ranking {
    Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes: Excludes { etf_etn: false, preferred: false }, exclude_managed: false }
}

fn ranking_row(code: &str) -> SharedRankingRow {
    serde_json::from_value(json!({"code": code, "name": format!("판{code}"), "price": 1000, "changeRate": 0.5, "figures": {"kind": "tradeAmount", "tradeAmount": 7, "volume": 3, "placesGained": null}})).unwrap()
}

fn write_rankings(dir: &Path, received_at: i64) {
    let received = ReceivedRanking { rows: ["005930", "000660"].iter().cycle().take(10).map(|code| ranking_row(code)).collect(), pages: 5, end: false, limited: false, received_at, broker: Broker::Kiwoom, page_rows: vec![2, 2, 2, 2, 2] };
    let conditions = vec![ConditionEntry { key: condition_key(&trade_amount()), state: ConditionState::Ready, last: Some(received) }];
    let header = Header::new(DataKind::Rankings, KstDate::new(2026, 11, 6).unwrap(), received_at, received_at, sources());
    write_snapshot_at(part_path(dir, DAY, "rest-01"), header, RankingsPartBody { period_secs: 10, pages: 5, conditions }).unwrap();
}

fn market_context(market: &str, received_at: i64) -> Value {
    json!({"market": market, "phase": "regular", "receivedAt": received_at, "source": "kiwoom"})
}

fn ok(value: Value) -> Value {
    json!({"status": "ok", "value": value})
}

fn market_cards(market: &str, received_at: i64) -> Value {
    let context = || market_context(market, received_at);
    let flow = |period: &str| json!({"context": context(), "period": period, "investors": ok(json!([{"date": "2026-11-06", "individualEok": 1, "foreignEok": 2, "institutionEok": 3}])), "program": ok(json!([]))});
    let turnover = |period: &str| json!({"context": context(), "period": period, "days": ok(json!([{"date": "2026-11-06", "tradeValueEok": 9.0}]))});
    json!({
        "index": {"context": context(), "index": ok(json!({"code": "001", "name": "종합", "level": 2500.0, "changeRate": 0.5, "breadth": {"rising": 1, "flat": 2, "falling": 3, "upperLimit": 4, "lowerLimit": 5}, "tradeValueEok": 9.0, "volatility": null}))},
        "sectors": {"context": context(), "sectors": ok(json!([])), "flows": ok(json!([]))},
        "flow": [flow("5"), flow("20"), flow("60")],
        "turnover": [turnover("5"), turnover("20"), turnover("60")],
        "streaks": {"context": context(), "buying": ok(json!({"foreign": [], "institution": []})), "selling": ok(json!({"foreign": [], "institution": []}))},
    })
}

fn write_overview(dir: &Path, received_at: i64) {
    let body: OverviewBody = serde_json::from_value(json!({"kospi": market_cards("kospi", received_at), "kosdaq": market_cards("kosdaq", received_at)})).unwrap();
    let header = Header::new(DataKind::MarketOverview, KstDate::new(2026, 11, 6).unwrap(), received_at, received_at, sources());
    write_snapshot_at(data_path(dir, DataKind::MarketOverview, DAY, "json"), header, body).unwrap();
}

fn write_samples(dir: &Path, at: i64) {
    let folder = dir.join(SAMPLES_FOLDER);
    std::fs::create_dir_all(&folder).unwrap();
    let line = json!({"at": at, "received_at": at + 3, "market": "kospi", "value": {"kind": "investors", "individual_eok": 1, "foreign_eok": 2, "institution_eok": 3}});
    std::fs::write(folder.join(format!("{DAY}.jsonl")), format!("{line}\n")).unwrap();
}

fn write_every_board(dir: &Path) {
    let as_of = friday(20, 29, 30);
    write_boards(dir, as_of);
    write_minutes(dir, as_of);
    write_rankings(dir, as_of);
    write_overview(dir, as_of);
    write_samples(dir, as_of);
}

fn ranking_request(pages: u8) -> Value {
    json!({"ranking": serde_json::to_value(trade_amount()).unwrap(), "pages": pages, "trigger": "user"})
}

fn themes_body() -> Value {
    json!({"themes": [{"id": "CHIP", "name": "반도체", "symbols": ["005930", "000660"]}], "revision": 1})
}

fn transport_calls(site: &Site) -> usize {
    site.fake.requests()
}

async fn every_public_shared_route(site: &Site, who: &Session) -> Vec<(String, u16)> {
    let mut seen: Vec<(String, u16)> = Vec::new();
    let mut note = |path: &str, reply: Reply| {
        seen.push((path.to_owned(), reply.status));
        if reply.status >= 400 {
            eprintln!("{path} -> {} {}", reply.status, reply.text());
        }
        reply
    };
    let themes = site.send_json(who, reqwest::Method::PUT, "/api/heatmap/themes", &themes_body()).await;
    note("PUT /api/heatmap/themes", themes);
    for path in [
        "/api/symbols?q=%EC%82%BC%EC%84%B1",
        "/api/symbols/005930",
        "/api/screener/status",
        "/api/etf/funds",
        "/api/etf/stocks/005930",
        "/api/symbols/005930/financials",
        "/api/symbols/005930/financial-source",
        "/api/heatmap/board?venue=krx",
        "/api/heatmap/flow?symbols=005930,000660,200010&venue=krx",
        "/api/market-overview/index?market=kospi",
        "/api/market-overview/sectors?market=kosdaq",
        "/api/market-overview/flow?market=kospi&period=60",
        "/api/market-overview/flow/intraday?market=kospi",
        "/api/market-overview/turnover?market=kosdaq&period=5",
        "/api/market-overview/streaks?market=kospi",
    ] {
        let reply = site.get(who, path).await;
        note(&format!("GET {path}"), reply);
    }
    let run = site.send_json(who, reqwest::Method::POST, "/api/screener/run", &new_high_screen()).await;
    note("POST /api/screener/run", run);
    for pages in [1, 5, 30] {
        let reply = site.send_json(who, reqwest::Method::POST, "/api/rankings", &ranking_request(pages)).await;
        note(&format!("POST /api/rankings pages={pages}"), reply);
    }
    seen
}

#[tokio::test]
async fn every_shared_public_route_answers_many_accounts_without_one_kiwoom_transport_call() {
    let site = Site::start(ScriptedTransport::new()).await;
    site.fill_screener_store().await;
    site.load_symbols();
    write_every_board(&site.shared);
    site.poll().await;
    let accounts = [site.login("alice").await, site.login("bob").await, site.login("carol").await];
    let before = transport_calls(&site);
    for who in &accounts {
        let seen = every_public_shared_route(&site, who).await;
        let status_of = |label: &str| seen.iter().find(|(name, _)| name == label).unwrap_or_else(|| panic!("{label}을 부르지 않았다: {seen:?}")).1;
        for label in [
            "GET /api/symbols?q=%EC%82%BC%EC%84%B1",
            "GET /api/symbols/005930",
            "GET /api/screener/status",
            "GET /api/heatmap/board?venue=krx",
            "GET /api/heatmap/flow?symbols=005930,000660,200010&venue=krx",
            "GET /api/market-overview/index?market=kospi",
            "GET /api/market-overview/sectors?market=kosdaq",
            "GET /api/market-overview/flow?market=kospi&period=60",
            "GET /api/market-overview/flow/intraday?market=kospi",
            "GET /api/market-overview/turnover?market=kosdaq&period=5",
            "GET /api/market-overview/streaks?market=kospi",
            "POST /api/screener/run",
            "POST /api/rankings pages=1",
            "POST /api/rankings pages=5",
        ] {
            assert_eq!(status_of(label), 200, "{label}");
        }
        assert_eq!(status_of("POST /api/rankings pages=30"), 404, "판에 없는 쪽 수는 not_prepared다");
        assert!(seen.iter().all(|(label, status)| *status < 500 || label.contains("financ")), "5xx가 났다: {seen:?}");
    }
    assert_eq!(transport_calls(&site), before, "공개 요청은 키움 transport를 한 번도 부르지 않는다");
    site.state.clock.jump(900);
    for who in &accounts {
        assert_eq!(site.get(who, "/api/screener/status").await.status, 200);
        let run = site.send_json(who, reqwest::Method::POST, "/api/screener/run", &new_high_screen()).await;
        assert!(run.status < 500 || run.status == 503, "{}", run.text());
    }
    assert_eq!(transport_calls(&site), before, "거래일 달력이 낡아도 공개 스크리너 요청은 키움에서 달력을 다시 받지 않는다");
}

#[tokio::test]
async fn a_public_load_neither_queues_behind_nor_in_front_of_an_operator_kiwoom_request() {
    let fake = ScriptedTransport::new();
    let site = Site::start(fake.clone()).await;
    site.load_symbols();
    write_every_board(&site.shared);
    site.poll().await;
    let accounts = [site.login("alice").await, site.login("bob").await, site.login("carol").await, site.login("dave").await];
    fake.respond_with("ka10032", 200, json!({"_headers": {"cont-yn": "N", "next-key": ""}, "trde_prica_upper": [{"stk_cd": "005930", "stk_nm": "키움", "now_rank": "1", "pred_rank": "1", "cur_prc": "1000", "flu_rt": "0.5", "now_trde_qty": "10", "trde_prica": "1"}], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"}));
    let held = fake.hold("운영자 순위", |call| call.api_id == "ka10032");
    let unprepared = Ranking::TradeAmount { market: RankingMarket::Kospi, venue: Venue::Combined, excludes: Excludes { etf_etn: false, preferred: false }, exclude_managed: false };
    let losers = json!({"ranking": serde_json::to_value(unprepared).unwrap(), "pages": 1, "trigger": "user"});
    let operator = tokio::spawn({
        let router = site.operator_router.clone();
        let request = axum::http::Request::post("/api/rankings").header("host", &site.operator_host).header("content-type", "application/json").body(axum::body::Body::from(losers.to_string())).unwrap();
        async move { router.oneshot(request).await.unwrap().status().as_u16() }
    });
    held.arrived().await;
    let in_queue = fake.requests();
    for who in &accounts {
        for _ in 0..3 {
            let seen = every_public_shared_route(&site, who).await;
            assert!(seen.iter().filter(|(label, _)| label.starts_with("GET /api/market-overview") || label.starts_with("GET /api/heatmap")).all(|(_, status)| *status == 200), "{seen:?}");
        }
    }
    let sent: Vec<_> = fake.calls().iter().map(|call| call.api_id.clone()).collect();
    assert_eq!(fake.requests(), in_queue, "공개 부하는 운영자 요청이 붙잡힌 대기열에 키움 요청을 하나도 더하지 않는다: {sent:?}");
    assert!(!operator.is_finished(), "운영자 요청은 공개 부하와 상관없이 붙잡힌 채로 있다");
    held.release();
    assert_eq!(operator.await.unwrap(), 200);
}

#[tokio::test]
async fn a_public_listener_without_the_shared_data_folder_does_not_start() {
    let idp = start_idp().await;
    let work = work_folder();
    let mut vars = operator_vars(work.path());
    vars.extend(public_vars(&idp, "127.0.0.1:18443", "http://127.0.0.1:18443"));
    let refused = Config::from_values(vars.clone()).map(|_| ()).unwrap_err().to_string();
    assert!(refused.contains("VALLY_SHARED_DATA_DIR") && !refused.contains('\n'), "{refused}");
    vars.insert("VALLY_SHARED_DATA_DIR".into(), work.path().join("shared").display().to_string());
    let (config, warnings) = Config::from_values(vars.clone()).unwrap();
    assert!(config.public.is_some() && config.shared_data.is_some());
    assert!(warnings.is_empty(), "{warnings:?}");
    vars.insert("VALLY_PUBLIC_FLOW_TR_PER_MINUTE".into(), "60".into());
    vars.insert("VALLY_PUBLIC_RANKING_MAX_PAGES".into(), "5".into());
    let (_, warnings) = Config::from_values(vars).unwrap();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains("VALLY_PUBLIC_FLOW_TR_PER_MINUTE") && warnings[0].contains("VALLY_PUBLIC_RANKING_MAX_PAGES") && !warnings[0].contains('\n'), "{warnings:?}");
}

#[tokio::test]
async fn the_server_without_public_settings_starts_without_the_shared_data_folder() {
    let work = work_folder();
    let (config, warnings) = Config::from_values(operator_vars(work.path())).unwrap();
    assert!(config.public.is_none() && config.shared_data.is_none() && warnings.is_empty(), "{warnings:?}");
}

#[tokio::test]
async fn the_usage_page_reports_each_boards_age_its_read_errors_and_screener_result_reuse() {
    let site = Site::start(ScriptedTransport::new()).await;
    site.fill_screener_store().await;
    site.load_symbols();
    write_every_board(&site.shared);
    std::fs::create_dir_all(site.shared.join(DataKind::KiwoomThemes.folder())).unwrap();
    std::fs::write(data_path(&site.shared, DataKind::KiwoomThemes, DAY, "json"), "{torn").unwrap();
    site.poll().await;
    let (alice, bob) = (site.login("alice").await, site.login("bob").await);
    let first = site.send_json(&alice, reqwest::Method::POST, "/api/screener/run", &new_high_screen()).await;
    assert_eq!(first.status, 200, "{}", first.text());
    let second = site.send_json(&bob, reqwest::Method::POST, "/api/screener/run", &new_high_screen()).await;
    assert_eq!(second.status, 200, "{}", second.text());
    let usage = site.usage().await;
    let shared = &usage["sharedData"];
    assert_eq!(shared["snapshot-krx"], json!({"ageSecs": 30, "readErrors": 0}), "{usage}");
    assert_eq!(shared["rankings"]["ageSecs"], 30, "{usage}");
    assert_eq!(shared["market-overview"]["ageSecs"], 30, "{usage}");
    assert_eq!(shared["probe"], json!({"ageSecs": null, "readErrors": 0}), "쓰지 않은 종류는 나이가 없다: {usage}");
    assert_eq!(shared["kiwoom-themes"], json!({"ageSecs": null, "readErrors": 1}), "읽지 못한 파일은 읽기 오류로 센다: {usage}");
    assert_eq!(usage["screenerResults"], json!({"hits": 1, "misses": 1}), "같은 조건식의 두 번째 실행은 첫 결과를 다시 쓴다: {usage}");
    assert!(usage["bundles"]["screener_run"].get("trCalls").is_none() && usage["cacheHits"].get("marketOverview").is_none(), "{usage}");
    site.state.clock.jump(60);
    assert_eq!(site.usage().await["sharedData"]["snapshot-krx"]["ageSecs"], 90, "나이는 가짜 시계를 따라 늘어난다");
}

#[tokio::test]
async fn a_public_screener_run_before_the_server_has_a_calendar_is_not_prepared_and_calls_nothing() {
    let site = Site::start(ScriptedTransport::new()).await;
    site.load_symbols();
    write_every_board(&site.shared);
    site.poll().await;
    let who = site.login("alice").await;
    let before = transport_calls(&site);
    let status = site.get(&who, "/api/screener/status").await;
    assert_eq!(status.status, 200, "{}", status.text());
    assert!(status.json()["needDay"].is_null());
    let run = site.send_json(&who, reqwest::Method::POST, "/api/screener/run", &new_high_screen()).await;
    assert_eq!((run.status, run.json()["error"]["code"].as_str().map(str::to_owned)), (404, Some("not_prepared".to_owned())), "{}", run.text());
    assert_eq!(transport_calls(&site), before);
}

#[tokio::test]
async fn the_server_renews_the_calendar_by_itself_so_public_requests_never_have_to() {
    let site = Site::start(ScriptedTransport::new()).await;
    site.fill_screener_store().await;
    site.load_symbols();
    let index_days = || site.fake.calls().iter().filter(|call| call.api_id == "ka20006").count();
    let fetched_before = index_days();
    tokio::time::pause();
    tokio::time::sleep(Duration::from_secs(301)).await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    tokio::time::resume();
    assert!(index_days() > fetched_before, "5분마다 서버가 스스로 달력을 새로 받는다");
}

#[tokio::test]
async fn a_calendar_renewal_waiting_on_kiwoom_does_not_hold_up_public_screener_requests() {
    let fake = ScriptedTransport::new();
    let site = Site::start(fake.clone()).await;
    site.fill_screener_store().await;
    site.load_symbols();
    write_every_board(&site.shared);
    site.poll().await;
    let who = site.login("alice").await;
    let held = fake.hold("달력 갱신", |call| call.api_id == "ka20006");
    tokio::time::pause();
    tokio::time::sleep(Duration::from_secs(301)).await;
    tokio::time::resume();
    held.arrived().await;
    let answered = tokio::time::timeout(Duration::from_secs(3), async {
        let status = site.get(&who, "/api/screener/status").await.status;
        let run = site.send_json(&who, reqwest::Method::POST, "/api/screener/run", &new_high_screen()).await.status;
        (status, run)
    })
    .await;
    held.release();
    assert!(matches!(answered, Ok((200, run)) if run < 500), "달력 갱신이 키움을 기다리는 동안 공개 요청이 멈췄다: {answered:?}");
}
