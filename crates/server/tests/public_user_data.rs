use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use account_server::fake_idp::{ClientCredentials, FakeIdp};
use account_server::{AccountConfig, AccountOptions, Accounts, GoogleConfig, IdpUrl, NaverConfig, PublicUrl, Secret, SystemClock, open_database};
use axum::Router;
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::app::{Adapters, StreamSource};
use server::clock::kst;
use server::config::Config;
use server::http::AppState;
use server::kiwoom::rest::Access;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{Broker, DataKind, FeedWriter, Header, MinuteBar, MinuteInstrument, MinuteVenue, SnapshotBody, SnapshotRow, SourceKey, minute_path, write_snapshot};
use server::symbols::Directory;
use tower::ServiceExt;

const GOOGLE_SECRET: &str = "google-secret-public-user-data-1c7e";
const NAVER_SECRET: &str = "naver-secret-public-user-data-9d2b";
const THURSDAY_MORNING: &str = "20261119100100";
const DEFAULT_LAYOUT: &str = "01900000-0000-7000-8000-000000000001";
const MINUTE_API: &str = "ka10080";
const QUOTE_API: &str = "ka10095";

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn head(text: &str) -> String {
    text.chars().take(300).collect()
}

fn codes(count: usize, first: usize) -> Vec<String> {
    (first..first + count).map(|n| format!("{n:06}")).collect()
}

fn minute_row(time: &str, close: u64) -> Value {
    json!({"cntr_tm": time, "open_pric": close.to_string(), "high_pric": close.to_string(), "low_pric": close.to_string(), "cur_prc": close.to_string(), "trde_qty": "10"})
}

#[derive(Default)]
struct WireState {
    minute_codes: Mutex<Vec<String>>,
    quote_batches: Mutex<Vec<Vec<String>>>,
    api_ids: Mutex<Vec<String>>,
}

#[derive(Clone, Default)]
struct Wire {
    state: Arc<WireState>,
}

impl Wire {
    fn minute_calls(&self) -> usize {
        self.state.minute_codes.lock().unwrap().len()
    }

    fn quote_batches(&self) -> Vec<Vec<String>> {
        self.state.quote_batches.lock().unwrap().clone()
    }

    fn api_calls(&self) -> Vec<String> {
        self.state.api_ids.lock().unwrap().clone()
    }
}

impl Transport for Wire {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let state = self.state.clone();
        let reply = |body: Value| HttpResponse { status: 200, next_key: None, body: body.to_string() };
        let id = req.api_id.as_str().to_owned();
        state.api_ids.lock().unwrap().push(id.clone());
        if id == "au10001" {
            let response = reply(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}));
            return Box::pin(async move { Ok(response) });
        }
        let body: Value = serde_json::from_str(req.body.expose()).unwrap();
        match id.as_str() {
            MINUTE_API => {
                let code = body["stk_cd"].as_str().unwrap().split('_').next().unwrap().to_owned();
                state.minute_codes.lock().unwrap().push(code);
                let rows: Vec<Value> = [("20261119090500", 10_500), ("20261119090400", 10_200), ("20261119090000", 10_100), ("20261118153000", 10_000)].iter().map(|(t, c)| minute_row(t, *c)).collect();
                let response = reply(json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_min_pole_chart_qry": rows}));
                Box::pin(async move { Ok(response) })
            }
            QUOTE_API => {
                let asked: Vec<String> = body["stk_cd"].as_str().unwrap().split('|').map(|c| c.split('_').next().unwrap().to_owned()).collect();
                state.quote_batches.lock().unwrap().push(asked.clone());
                let rows: Vec<Value> = asked
                    .iter()
                    .map(|code| {
                        json!({"stk_cd": format!("{code}_AL"), "stk_nm": code, "cur_prc": "1100", "base_pric": "1000", "pred_pre": "100", "pred_pre_sig": "2", "flu_rt": "0", "trde_qty": "100",
                               "trde_prica": "500", "open_pric": "1", "high_pric": "1", "low_pric": "1", "close_pric": "1", "cntr_tm": "100000", "dt": "20261119", "upl_pric": "1", "lst_pric": "1"})
                    })
                    .collect();
                let response = reply(json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "atn_stk_infr": rows}));
                Box::pin(async move { Ok(response) })
            }
            _ => {
                let response = reply(json!({"return_code": 1, "return_msg": "이 시험의 transport가 모르는 호출입니다"}));
                Box::pin(async move { Ok(response) })
            }
        }
    }
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

struct Work {
    dir: tempfile::TempDir,
}

impl Work {
    fn new() -> Work {
        let dir = tempfile::tempdir().unwrap();
        let dist = dir.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html><title>vally</title>").unwrap();
        Work { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }
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
        ("VALLY_FINANCIAL_AUTOMATIC", "off".to_owned()),
        ("VALLY_CLOCK_START", THURSDAY_MORNING.to_owned()),
        ("VALLY_KIWOOM_APP_KEY", "test-app-key".to_owned()),
        ("VALLY_KIWOOM_APP_SECRET", "test-app-secret".to_owned()),
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

#[derive(Clone)]
struct Session {
    cookie: String,
}

struct Reply {
    status: u16,
    body: Vec<u8>,
    headers: axum::http::HeaderMap,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("JSON이 아니다({e}): {}", head(&self.text())))
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or_default().to_owned()
    }

    fn error_shape(&self) -> (u16, String, String) {
        let body = self.json();
        (self.status, body["error"]["code"].as_str().unwrap_or_default().to_owned(), body["error"]["message"].as_str().unwrap_or_default().to_owned())
    }
}

struct Site {
    state: Arc<AppState>,
    wire: Wire,
    idp: Arc<FakeIdp>,
    operator_router: Router,
    public_router: Router,
    login_router: Router,
    public_origin: String,
    operator_host: String,
    public_host: String,
    http: reqwest::Client,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    _lock: server::instance::InstanceLock,
    _events: tokio::sync::mpsc::Sender<server::market_source::stream::StreamEvent>,
    _work: Work,
}

impl Drop for Site {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn start_site(idp: &Arc<FakeIdp>, env: &[(&str, &str)]) -> Site {
    let work = Work::new();
    let public_port = free_port();
    let public_origin = format!("http://127.0.0.1:{public_port}");
    let mut vars = operator_vars(work.path());
    let shared = work.path().join("shared");
    std::fs::create_dir_all(&shared).unwrap();
    vars.insert("VALLY_SHARED_DATA_DIR".to_owned(), shared.display().to_string());
    vars.extend(public_vars(idp, &format!("127.0.0.1:{public_port}"), &public_origin));
    vars.extend(env.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())));
    let config = Config::from_values(vars).map(|(config, _)| config).unwrap_or_else(|e| panic!("설정 오류: {e}"));
    let wire = Wire::default();
    let lock = server::instance::InstanceLock::acquire(&config.lock_path).unwrap();
    let (events, stream_events) = tokio::sync::mpsc::channel(16);
    let adapters = Adapters { kiwoom: Arc::new(wire.clone()), kis: None, kis_feed: None, stream: StreamSource::Detached(stream_events), kiwoom_spacing: None, dart_spacing: Some(Duration::from_millis(1)) };
    let started = server::app::start(&config, &lock, adapters).await.unwrap_or_else(|_| panic!("서버가 시작하지 못했다"));
    let server::app::Started { state, router, listener, automatic, public } = started;
    drop(automatic);
    state.rest.set_access(Access::Open);
    let mut tasks = Vec::new();
    let operator_port = listener.local_addr().unwrap().port();
    let operator_router = router.clone();
    tasks.push(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let public = public.expect("공개 리스너가 떠야 한다");
    let public_router = public.router();
    let served = public_router.clone();
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
    let site = Site {
        state,
        wire,
        idp: idp.clone(),
        operator_router,
        public_router,
        login_router,
        public_host: format!("127.0.0.1:{public_port}"),
        operator_host: format!("127.0.0.1:{operator_port}"),
        public_origin,
        http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().timeout(Duration::from_secs(15)).build().unwrap(),
        tasks,
        _lock: lock,
        _events: events,
        _work: work,
    };
    site.load_symbols(&[]);
    site
}

fn cookie_pairs(headers: &axum::http::HeaderMap) -> Vec<(String, String)> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|line| line.to_str().ok()?.split(';').next()?.split_once('=').map(|(name, value)| (name.to_owned(), value.to_owned())))
        .collect()
}

fn listed(code: &str) -> SymbolInfo {
    SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: format!("종목{code}"), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true }
}

impl Site {
    fn load_symbols(&self, extra: &[String]) {
        let mut all: Vec<SymbolInfo> = ["005930", "000660"].iter().map(|c| listed(c)).collect();
        all.extend(extra.iter().map(|c| listed(c)));
        self.state.symbols.replace(Directory::build(all));
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

    async fn login(&self, subject: &str) -> Session {
        self.idp.set_subject(subject);
        let (status, headers) = self.hop("/v1/session/google/start", None).await;
        assert_eq!(status, 302, "로그인 시작은 IdP로 보낸다");
        let mut cookies: BTreeMap<String, String> = cookie_pairs(&headers).into_iter().collect();
        let authorize = headers["location"].to_str().unwrap().to_owned();
        let idp = self.http.get(&authorize).send().await.unwrap();
        assert_eq!(idp.status(), 302);
        let callback = idp.headers()["location"].to_str().unwrap().to_owned();
        let callback = callback.strip_prefix(&self.public_origin).unwrap_or_else(|| panic!("callback이 공개 출처로 온다: {callback}")).to_owned();
        let header: Vec<String> = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect();
        let (status, headers) = self.hop(&callback, Some(header.join("; "))).await;
        assert_eq!(status, 302, "callback은 화면 첫 주소로 보낸다");
        cookies.extend(cookie_pairs(&headers));
        let session = cookies.iter().find(|(name, value)| name.ends_with("vally_session") && !value.is_empty()).unwrap_or_else(|| panic!("세션 쿠키가 없다: {cookies:?}"));
        Session { cookie: format!("{}={}", session.0, session.1) }
    }

    fn public_request(&self, who: Option<&Session>, method: &str, path: &str, body: Option<&Value>) -> axum::http::Request<axum::body::Body> {
        let mut request = axum::http::Request::builder().method(method).uri(path).header("host", &self.public_host);
        if let Some(who) = who {
            request = request.header("cookie", &who.cookie);
        }
        match body {
            Some(body) => request.header("origin", &self.public_origin).header("content-type", "application/json").body(axum::body::Body::from(body.to_string())).unwrap(),
            None if method == "GET" => request.body(axum::body::Body::empty()).unwrap(),
            None => request.header("origin", &self.public_origin).header("content-type", "application/json").body(axum::body::Body::empty()).unwrap(),
        }
    }

    fn operator_request(&self, method: &str, path: &str, body: Option<&Value>) -> axum::http::Request<axum::body::Body> {
        let request = axum::http::Request::builder().method(method).uri(path).header("host", &self.operator_host);
        match body {
            Some(body) => request.header("content-type", "application/json").body(axum::body::Body::from(body.to_string())).unwrap(),
            None => request.header("content-type", "application/json").body(axum::body::Body::empty()).unwrap(),
        }
    }

    async fn public(&self, who: &Session, method: &str, path: &str, body: Option<&Value>) -> Reply {
        through(&self.public_router, self.public_request(Some(who), method, path, body)).await
    }

    async fn public_raw(&self, who: &Session, method: &str, path: &str, raw: String) -> Reply {
        let request = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header("host", &self.public_host)
            .header("cookie", &who.cookie)
            .header("origin", &self.public_origin)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(raw))
            .unwrap();
        through(&self.public_router, request).await
    }

    async fn operator(&self, method: &str, path: &str, body: Option<&Value>) -> Reply {
        through(&self.operator_router, self.operator_request(method, path, body)).await
    }

    async fn operator_raw(&self, method: &str, path: &str, raw: String) -> Reply {
        let request = axum::http::Request::builder().method(method).uri(path).header("host", &self.operator_host).header("content-type", "application/json").body(axum::body::Body::from(raw)).unwrap();
        through(&self.operator_router, request).await
    }

    fn shared_dir(&self) -> PathBuf {
        self._work.path().join("shared")
    }

    async fn publish_shared(&self, board: &[(&str, u64)], minute_codes: &[String]) {
        let dir = self.shared_dir();
        write_board(&dir, board);
        write_minutes(&dir, minute_codes);
        self.state.shared_data.poll_once(&dir).await;
    }

    async fn usage(&self) -> Value {
        let reply = self.operator("GET", "/api/public-usage", None).await;
        assert_eq!(reply.status, 200, "{}", head(&reply.text()));
        reply.json()
    }
}

fn collection_day() -> KstDate {
    KstDate::new(2026, 11, 19).unwrap()
}

fn collection_unix(hour: u32, minute: u32) -> i64 {
    kst(collection_day(), hour, minute, 0).unix()
}

fn collection_sources() -> Vec<SourceKey> {
    vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]
}

fn write_board(dir: &Path, rows: &[(&str, u64)]) {
    let stocks: Vec<SnapshotRow> = rows
        .iter()
        .map(|(code, current)| SnapshotRow { code: (*code).into(), day: "20261119".into(), current_won: *current, base_won: 50_000, open_won: 50_000, high_won: *current.max(&50_000), low_won: *current.min(&50_000), volume: 100, traded_million_won: 1_000, traded_at: Some(collection_unix(9, 59)) })
        .collect();
    let requested = stocks.len() as u32;
    let as_of = collection_unix(10, 0);
    write_snapshot(dir, Header::new(DataKind::SnapshotCombined, collection_day(), as_of, as_of, collection_sources()), SnapshotBody { closing: false, requested, missing: 0, stocks, indices: Vec::new() }).unwrap();
}

fn write_minutes(dir: &Path, codes: &[String]) {
    if codes.is_empty() {
        return;
    }
    let as_of = collection_unix(10, 0);
    let header = Header::new(DataKind::Minute, collection_day(), as_of, as_of, collection_sources());
    let mut writer = FeedWriter::open_at(&minute_path(dir, "20261119", "collect-01"), header).unwrap();
    for code in codes {
        for (minute, close, first_sec) in [(540_u16, 50_500.0, 32_400_u32), (544, 51_000.0, 32_640)] {
            writer.append(&MinuteBar { symbol: code.clone(), instrument: MinuteInstrument::Stock, venue: Some(MinuteVenue::Combined), minute, open: close, high: close, low: close, close, volume: 10, value: 1_000_000, trades: 1, first_sec, last_sec: first_sec + 30 }).unwrap();
        }
    }
    writer.sync().unwrap();
}

async fn through(router: &Router, request: axum::http::Request<axum::body::Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = http_body_util::BodyExt::collect(response.into_body()).await.unwrap().to_bytes().to_vec();
    Reply { status, body, headers }
}

fn watchlists_body(revision: i64, name: &str) -> Value {
    json!({"lists": [{"id": "list-a", "name": name, "symbols": ["005930", "000660"], "groups": [{"id": "g1", "name": "묶음", "symbols": ["005930"]}]}], "revision": revision})
}

fn screens_body(revision: i64) -> Value {
    json!({"screens": [], "revision": revision})
}

fn themes_body(revision: i64, themes: &[(&str, &str, Vec<String>)]) -> Value {
    json!({"themes": themes.iter().map(|(id, name, symbols)| json!({"id": id, "name": name, "symbols": symbols})).collect::<Vec<_>>(), "revision": revision})
}

fn ui_state_body(revision: i64, theme: &str) -> Value {
    json!({"lastLayoutId": DEFAULT_LAYOUT, "theme": theme, "revision": revision})
}

async fn layout_body(site: &Site, id: &str, name: &str, revision: i64) -> Value {
    let template = site.operator("GET", &format!("/api/layouts/{DEFAULT_LAYOUT}"), None).await;
    assert_eq!(template.status, 200, "{}", head(&template.text()));
    let mut body = template.json();
    body["id"] = json!(id);
    body["name"] = json!(name);
    body["revision"] = json!(revision);
    body.as_object_mut().unwrap().remove("updatedAt");
    body
}

fn drawing_body(id: &str, symbol: &str, z: f64, scope: Value, revision: i64) -> Value {
    json!({"id": id, "symbol": symbol, "tool": "trendline", "text": "목표", "style": {"v": 1}, "locked": false, "hidden": false, "periods": null, "z": z, "group": null, "scope": scope,
           "revision": revision, "points": [{"t": 1_794_100_000, "price": 100.0}, {"t": 1_794_200_000, "price": 110.0}]})
}

struct Pair {
    site: Site,
    alice: Session,
    bob: Session,
}

async fn pair(env: &[(&str, &str)]) -> (Pair, Arc<FakeIdp>) {
    let idp = start_idp().await;
    let site = start_site(&idp, env).await;
    let alice = site.login("alice").await;
    let bob = site.login("bob").await;
    (Pair { site, alice, bob }, idp)
}

#[tokio::test]
async fn every_user_route_saves_for_its_account_and_hides_it_from_the_other() {
    let (Pair { site, alice, bob }, _idp) = pair(&[]).await;
    let themes = themes_body(2, &[("t1", "반도체", vec!["005930".into(), "000660".into()])]);
    let layout = layout_body(&site, "L-alice", "앨리스 배치", 5).await;
    let drawing = drawing_body("D1", "005930", 1.5, json!({"kind": "layout", "layoutId": "L-alice"}), 7);
    for (path, body) in [("/api/watchlists", watchlists_body(3, "앨리스")), ("/api/screens", screens_body(4)), ("/api/heatmap/themes", themes.clone()), ("/api/ui-state", ui_state_body(6, "light"))] {
        let before_alice = site.public(&alice, "GET", path, None).await;
        assert_eq!(before_alice.status, 200, "{path}: {}", head(&before_alice.text()));
        let default_before = before_alice.json();
        let saved = site.public(&alice, "PUT", path, Some(&body)).await;
        assert_eq!((saved.status, saved.json()), (200, body.clone()), "{path}: {}", head(&saved.text()));
        assert_eq!(site.public(&alice, "GET", path, None).await.json(), body, "{path}: 저장한 본문이 그대로 읽힌다");
        assert_eq!(site.public(&bob, "GET", path, None).await.json(), default_before, "{path}: 다른 계정은 앨리스의 것을 보지 못하고 기본값을 본다");
    }
    let watch = site.public(&alice, "GET", "/api/watchlists", None).await;
    assert_eq!(watch.headers.get("x-vally-watchlists-version").and_then(|v| v.to_str().ok()), Some("2"));

    let saved = site.public(&alice, "PUT", "/api/layouts/L-alice", Some(&layout)).await;
    assert_eq!(saved.status, 200, "{}", head(&saved.text()));
    let saved = saved.json();
    assert_eq!(saved["updatedAt"], json!(site.now()), "서버 시계가 updatedAt이다");
    let got = site.public(&alice, "GET", "/api/layouts/L-alice", None).await;
    assert_eq!(got.json(), saved);
    let listed = site.public(&alice, "GET", "/api/layouts", None).await.json();
    assert_eq!(listed.as_array().unwrap().iter().map(|l| l["id"].as_str().unwrap()).collect::<Vec<_>>(), [DEFAULT_LAYOUT, "L-alice"], "기본 레이아웃이 먼저, 만든 순서대로");
    assert_eq!(listed[1], json!({"id": "L-alice", "name": "앨리스 배치", "updatedAt": site.now()}));
    let bobs = site.public(&bob, "GET", "/api/layouts", None).await.json();
    assert_eq!(bobs.as_array().unwrap().iter().map(|l| l["id"].as_str().unwrap()).collect::<Vec<_>>(), [DEFAULT_LAYOUT]);
    assert_eq!(site.public(&bob, "GET", "/api/layouts/L-alice", None).await.status, 404);

    let drawn = site.public(&alice, "PUT", "/api/drawings/D1", Some(&drawing)).await;
    assert_eq!(drawn.status, 200, "{}", head(&drawn.text()));
    let mut want = drawing.clone();
    want["updatedAt"] = json!(site.now());
    assert_eq!(drawn.json(), want);
    assert_eq!(site.public(&alice, "GET", "/api/drawings?symbol=005930", None).await.json(), json!([want]));
    assert_eq!(site.public(&bob, "GET", "/api/drawings?symbol=005930", None).await.json(), json!([]));
    assert_eq!(site.public(&bob, "PUT", "/api/drawings/D2", Some(&drawing_body("D2", "005930", 0.0, json!({"kind": "layout", "layoutId": "L-alice"}), 1))).await.status, 400, "다른 계정의 레이아웃은 범위가 될 수 없다");
}

#[tokio::test]
async fn without_a_session_every_user_route_is_401_signed_out() {
    let (Pair { site, .. }, _idp) = pair(&[]).await;
    let routes = [
        ("GET", "/api/watchlists"),
        ("PUT", "/api/watchlists"),
        ("GET", "/api/screens"),
        ("PUT", "/api/screens"),
        ("GET", "/api/heatmap/themes"),
        ("PUT", "/api/heatmap/themes"),
        ("GET", "/api/ui-state"),
        ("PUT", "/api/ui-state"),
        ("GET", "/api/layouts"),
        ("GET", "/api/layouts/x"),
        ("PUT", "/api/layouts/x"),
        ("DELETE", "/api/layouts/x"),
        ("GET", "/api/drawings?symbol=005930"),
        ("PUT", "/api/drawings/x"),
        ("DELETE", "/api/drawings/x"),
        ("GET", "/api/heatmap/board"),
        ("GET", "/api/heatmap/flow?symbols=005930"),
    ];
    let empty = json!({});
    for (method, path) in routes {
        let request = site.public_request(None, method, path, if method == "GET" { None } else { Some(&empty) });
        let reply = through(&site.public_router, request).await;
        assert_eq!((reply.status, reply.code().as_str()), (401, "signed_out"), "{method} {path}: {}", head(&reply.text()));
    }
}

#[tokio::test]
async fn an_equal_or_smaller_revision_is_stale_and_leaves_the_stored_value() {
    let (Pair { site, alice, bob }, _idp) = pair(&[]).await;
    let layout = layout_body(&site, "L2", "둘째", 10).await;
    let singles = [("/api/watchlists", watchlists_body(10, "첫째"), watchlists_body(10, "바뀜")), ("/api/screens", screens_body(10), screens_body(9)), ("/api/heatmap/themes", themes_body(10, &[]), themes_body(3, &[])), ("/api/ui-state", ui_state_body(10, "dark"), ui_state_body(10, "light"))];
    for (path, first, again) in singles {
        assert_eq!(site.public(&alice, "PUT", path, Some(&first)).await.status, 200);
        let refused = site.public(&alice, "PUT", path, Some(&again)).await;
        assert_eq!((refused.status, refused.code().as_str()), (409, "stale_revision"), "{path}: {}", head(&refused.text()));
        assert_eq!(refused.json()["error"]["message"], "더 새 편집(revision 10)이 이미 저장돼 있습니다");
        assert_eq!(site.public(&alice, "GET", path, None).await.json(), first, "{path}: 저장값은 바뀌지 않는다");
    }
    assert_eq!(site.public(&alice, "PUT", "/api/layouts/L2", Some(&layout)).await.status, 200);
    for revision in [10, 4] {
        let mut older = layout.clone();
        older["name"] = json!("바뀐 이름");
        older["revision"] = json!(revision);
        assert_eq!(site.public(&alice, "PUT", "/api/layouts/L2", Some(&older)).await.code(), "stale_revision");
    }
    assert_eq!(site.public(&alice, "GET", "/api/layouts/L2", None).await.json()["name"], "둘째");
    let drawing = drawing_body("D1", "005930", 1.0, json!({"kind": "symbol"}), 20);
    assert_eq!(site.public(&alice, "PUT", "/api/drawings/D1", Some(&drawing)).await.status, 200);
    for revision in [20, 19] {
        let refused = site.public(&alice, "PUT", "/api/drawings/D1", Some(&drawing_body("D1", "005930", 9.0, json!({"kind": "symbol"}), revision))).await;
        assert_eq!(refused.code(), "stale_revision");
    }
    assert_eq!(site.public(&alice, "GET", "/api/drawings?symbol=005930", None).await.json()[0]["z"], 1.0);
    let first_ever = site.public(&bob, "PUT", "/api/screens", Some(&screens_body(0))).await;
    assert_eq!((first_ever.status, first_ever.json()["error"]["message"].clone()), (409, json!("더 새 편집(revision 0)이 이미 저장돼 있습니다")), "저장된 적 없는 문서도 운영자처럼 revision 0을 가진 것으로 본다");
    assert_eq!(site.public(&bob, "PUT", "/api/screens", Some(&screens_body(1))).await.status, 200);
}

#[tokio::test]
async fn a_deleted_layout_or_drawing_is_gone_and_cannot_come_back_with_a_smaller_revision() {
    let (Pair { site, alice, .. }, _idp) = pair(&[]).await;
    let layout = layout_body(&site, "L2", "둘째", 10).await;
    assert_eq!(site.public(&alice, "PUT", "/api/layouts/L2", Some(&layout)).await.status, 200);
    let drawing = drawing_body("D1", "005930", 1.0, json!({"kind": "cell", "layoutId": "L2", "windowId": "cell-0"}), 20);
    assert_eq!(site.public(&alice, "PUT", "/api/drawings/D1", Some(&drawing)).await.status, 200);

    assert_eq!(site.public(&alice, "DELETE", "/api/drawings/D1", None).await.status, 204);
    assert_eq!(site.public(&alice, "DELETE", "/api/drawings/D1", None).await.status, 204, "없는 드로잉 삭제도 204다");
    assert_eq!(site.public(&alice, "GET", "/api/drawings?symbol=005930", None).await.json(), json!([]));
    for revision in [20, 21, 1_000] {
        let back = site.public(&alice, "PUT", "/api/drawings/D1", Some(&drawing_body("D1", "005930", 1.0, json!({"kind": "symbol"}), revision))).await;
        assert_eq!(back.code(), "stale_revision", "삭제 표시보다 크지 않은 revision {revision}");
    }
    let back = site.public(&alice, "PUT", "/api/drawings/D1", Some(&drawing_body("D1", "005930", 1.0, json!({"kind": "symbol"}), site.now() * 1000 + 1))).await;
    assert_eq!(back.status, 200, "{}", head(&back.text()));

    assert_eq!(site.public(&alice, "DELETE", "/api/layouts/L2", None).await.status, 204);
    assert_eq!(site.public(&alice, "GET", "/api/layouts/L2", None).await.status, 404);
    assert_eq!(site.public(&alice, "DELETE", "/api/layouts/L2", None).await.status, 404);
    let listed = site.public(&alice, "GET", "/api/layouts", None).await.json();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    for revision in [10, 11] {
        let mut again = layout.clone();
        again["revision"] = json!(revision);
        assert_eq!(site.public(&alice, "PUT", "/api/layouts/L2", Some(&again)).await.code(), "stale_revision");
    }
    let last = site.public(&alice, "DELETE", &format!("/api/layouts/{DEFAULT_LAYOUT}"), None).await;
    assert_eq!((last.status, last.code().as_str()), (409, "conflict"), "마지막 레이아웃은 지울 수 없다: {}", head(&last.text()));
}

#[tokio::test]
async fn bad_bodies_are_refused_with_the_same_status_code_and_message_as_the_operator_listener() {
    let (Pair { site, alice, .. }, _idp) = pair(&[]).await;
    let long_name = "가".repeat(21);
    let symbols_over: Vec<String> = codes(61, 100_000);
    let cases: Vec<(&str, &str, String)> = vec![
        ("PUT", "/api/watchlists", "{bad".into()),
        ("PUT", "/api/watchlists", json!({"lists": [], "revision": 1}).to_string()),
        ("PUT", "/api/watchlists", watchlists_body(1, &long_name).to_string()),
        ("PUT", "/api/watchlists", json!({"lists": [{"id": "a", "name": "x", "symbols": ["005930", "005930"], "groups": []}], "revision": 1}).to_string()),
        ("PUT", "/api/watchlists", json!({"lists": [{"id": "a", "name": "x", "symbols": ["nope"], "groups": []}], "revision": 1}).to_string()),
        ("PUT", "/api/screens", json!({"screens": "no", "revision": 1}).to_string()),
        ("PUT", "/api/screens", json!({"revision": 1}).to_string()),
        ("PUT", "/api/heatmap/themes", themes_body(1, &[("a", "같다", vec![]), ("b", "같다", vec![])]).to_string()),
        ("PUT", "/api/heatmap/themes", themes_body(1, &[("a", "지수", vec!["IDX:001".into()])]).to_string()),
        ("PUT", "/api/heatmap/themes", themes_body(1, &[("a", "많다", symbols_over)]).to_string()),
        ("PUT", "/api/ui-state", json!({"theme": "dark"}).to_string()),
        ("PUT", "/api/ui-state", json!({"theme": "dark", "revision": "1"}).to_string()),
        ("PUT", "/api/ui-state", json!({"theme": "dark", "revision": 1, "pad": "x".repeat(setup::JSON_LIMIT)}).to_string()),
        ("PUT", "/api/layouts/L9", "{".into()),
        ("PUT", "/api/layouts/OTHER", layout_body(&site, "L9", "하나", 1).await.to_string()),
        ("PUT", "/api/layouts/L9", layout_body(&site, "L9", "  ", 1).await.to_string()),
        ("PUT", "/api/layouts/a%20b", layout_body(&site, "a b", "공백", 1).await.to_string()),
        ("PUT", "/api/layouts/L9", {
            let mut body = layout_body(&site, "L9", "창 없음", 1).await;
            body["windows"] = json!([]);
            body.to_string()
        }),
        ("PUT", "/api/layouts/L9", {
            let mut body = layout_body(&site, "L9", "큰 설정", 1).await;
            body["windows"][0]["chartSettings"] = json!({"pad": "x".repeat(setup::JSON_LIMIT)});
            body.to_string()
        }),
        ("PUT", "/api/drawings/OTHER", drawing_body("D1", "005930", 0.0, json!({"kind": "symbol"}), 1).to_string()),
        ("PUT", "/api/drawings/D1", drawing_body("D1", "bad", 0.0, json!({"kind": "symbol"}), 1).to_string()),
        ("PUT", "/api/drawings/D1", {
            let mut body = drawing_body("D1", "005930", 0.0, json!({"kind": "symbol"}), 1);
            body["points"] = json!([{"t": 1, "price": 1.0}]);
            body.to_string()
        }),
        ("PUT", "/api/drawings/D1", {
            let mut body = drawing_body("D1", "005930", 0.0, json!({"kind": "symbol"}), 1);
            body["periods"] = json!([]);
            body.to_string()
        }),
        ("PUT", "/api/drawings/D1", drawing_body("D1", "005930", 0.0, json!({"kind": "layout", "layoutId": "nope"}), 1).to_string()),
        ("PUT", "/api/drawings/D1", drawing_body("D1", "005930", 0.0, json!({"kind": "cell", "layoutId": DEFAULT_LAYOUT, "windowId": "cell-3"}), 1).to_string()),
        ("PUT", "/api/drawings/D1", {
            let mut body = drawing_body("D1", "005930", 0.0, json!({"kind": "symbol"}), 1);
            body["style"] = json!({"pad": "x".repeat(setup::JSON_LIMIT)});
            body.to_string()
        }),
        ("GET", "/api/drawings", String::new()),
        ("GET", "/api/drawings?symbol=abc", String::new()),
        ("GET", "/api/layouts/never", String::new()),
    ];
    for (method, path, body) in cases {
        let (operator, public) = if method == "GET" {
            (site.operator("GET", path, None).await, site.public(&alice, "GET", path, None).await)
        } else {
            (site.operator_raw(method, path, body.clone()).await, site.public_raw(&alice, method, path, body.clone()).await)
        };
        assert!(operator.status >= 400, "{method} {path}: 운영자 리스너가 받아 버렸다({}): {}", operator.status, head(&body));
        assert_eq!(public.error_shape(), operator.error_shape(), "{method} {path}: {}", head(&body));
    }
}

#[tokio::test]
async fn an_account_stops_at_32mb_and_gets_room_back_when_it_deletes() {
    let (Pair { site, alice, bob }, _idp) = pair(&[]).await;
    let big_layout = |site_template: &Value, n: usize| {
        let mut body = site_template.clone();
        body["id"] = json!(format!("big-{n}"));
        body["name"] = json!(format!("큰 배치 {n}"));
        body["revision"] = json!(1);
        let chart = body["windows"][0].clone();
        body["windows"] = json!((0..8).map(|w| {
            let mut window = chart.clone();
            window["id"] = json!(format!("cell-{w}"));
            window["chartSettings"] = json!({"v": 1, "pad": "x".repeat(60_000)});
            window
        }).collect::<Vec<_>>());
        body["placement"] = json!({"pad": "y".repeat(60_000)});
        body
    };
    let template = layout_body(&site, "t", "t", 1).await;
    let mut saved = 0;
    let refused = loop {
        let body = big_layout(&template, saved);
        let reply = site.public(&alice, "PUT", &format!("/api/layouts/big-{saved}"), Some(&body)).await;
        if reply.status != 200 {
            break reply;
        }
        saved += 1;
        assert!(saved < 200, "계정 전체 한도가 걸리지 않는다");
    };
    assert!((50..=70).contains(&saved), "32MB를 큰 배치 약 0.5MB씩으로 채운다: {saved}개");
    assert_eq!((refused.status, refused.code().as_str()), (413, "payload_too_large"), "{}", head(&refused.text()));
    assert!(refused.json()["error"]["message"].as_str().unwrap().starts_with("계정 전체 본문이 32MB를 넘습니다"), "{}", refused.text());
    assert_eq!(site.public(&alice, "GET", "/api/layouts/big-0", None).await.status, 200, "한도에 걸려도 저장된 것은 그대로다");
    assert_eq!(site.public(&bob, "PUT", "/api/layouts/mine", Some(&layout_body(&site, "mine", "내 것", 1).await)).await.status, 200, "다른 계정은 영향받지 않는다");

    assert_eq!(site.public(&alice, "DELETE", "/api/layouts/big-0", None).await.status, 204);
    let again = site.public(&alice, "PUT", &format!("/api/layouts/big-{saved}"), Some(&big_layout(&template, saved))).await;
    assert_eq!(again.status, 200, "지운 만큼 자리가 생긴다: {}", head(&again.text()));
}

#[tokio::test]
async fn the_drawing_query_returns_what_the_operator_listener_returns_for_the_same_documents() {
    let (Pair { site, alice, .. }, _idp) = pair(&[]).await;
    let cell = json!({"kind": "cell", "layoutId": DEFAULT_LAYOUT, "windowId": "cell-0"});
    let layout = json!({"kind": "layout", "layoutId": DEFAULT_LAYOUT});
    let drawings = [
        drawing_body("A", "005930", 2.5, json!({"kind": "symbol"}), 3),
        drawing_body("B", "005930", -1.0, cell.clone(), 4),
        drawing_body("Y", "005930", -3.0, json!({"kind": "symbol"}), 4),
        drawing_body("b-tie", "005930", 2.5, layout.clone(), 5),
        drawing_body("a-tie", "005930", 2.5, layout, 6),
        drawing_body("C", "000660", 0.5, cell, 7),
        drawing_body("Z", "IDX:001", 9.0, json!({"kind": "symbol"}), 8),
    ];
    for drawing in &drawings {
        let id = drawing["id"].as_str().unwrap();
        let operator = site.operator("PUT", &format!("/api/drawings/{id}"), Some(drawing)).await;
        let public = site.public(&alice, "PUT", &format!("/api/drawings/{id}"), Some(drawing)).await;
        assert_eq!((operator.status, public.status), (200, 200), "{id}: {} / {}", head(&operator.text()), head(&public.text()));
        assert_eq!(public.json(), operator.json(), "{id}: 저장 응답도 같다");
    }
    for removed in ["B", "Z"] {
        assert_eq!(site.operator("DELETE", &format!("/api/drawings/{removed}"), None).await.status, 204);
        assert_eq!(site.public(&alice, "DELETE", &format!("/api/drawings/{removed}"), None).await.status, 204);
    }
    for symbol in ["005930", "000660", "IDX:001", "035720"] {
        let path = format!("/api/drawings?symbol={symbol}");
        let (operator, public) = (site.operator("GET", &path, None).await, site.public(&alice, "GET", &path, None).await);
        assert_eq!(public.json(), operator.json(), "{symbol}");
    }
    let order: Vec<String> = site.public(&alice, "GET", "/api/drawings?symbol=005930", None).await.json().as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(order, ["Y", "A", "a-tie", "b-tie"], "z 오름차순이고 z가 같으면 id를 바이트 순으로 비교한다(운영자와 같다)");
}

#[tokio::test]
async fn the_operator_listener_keeps_its_local_sqlite_and_never_sees_what_the_public_listener_saved() {
    let (Pair { site, alice, .. }, _idp) = pair(&[]).await;
    let paths = ["/api/watchlists", "/api/screens", "/api/heatmap/themes", "/api/ui-state", "/api/layouts", "/api/drawings?symbol=005930"];
    let mut local_before = Vec::new();
    for path in paths {
        local_before.push(site.operator("GET", path, None).await.json());
    }
    let themes = themes_body(2, &[("t1", "공개 테마", vec!["005930".into()])]);
    for (path, body) in [("/api/watchlists", watchlists_body(3, "공개")), ("/api/screens", screens_body(4)), ("/api/heatmap/themes", themes), ("/api/ui-state", ui_state_body(6, "light"))] {
        assert_eq!(site.public(&alice, "PUT", path, Some(&body)).await.status, 200);
    }
    assert_eq!(site.public(&alice, "PUT", "/api/layouts/L-pub", Some(&layout_body(&site, "L-pub", "공개 배치", 1).await)).await.status, 200);
    assert_eq!(site.public(&alice, "PUT", "/api/drawings/D-pub", Some(&drawing_body("D-pub", "005930", 1.0, json!({"kind": "symbol"}), 1))).await.status, 200);
    for (path, before) in paths.iter().zip(&local_before) {
        assert_eq!(&site.operator("GET", path, None).await.json(), before, "{path}: 공개 리스너에서 저장한 것이 운영자 쪽에 나타났다");
    }
    let local_themes = themes_body(8, &[("local", "로컬 테마", vec!["000660".into()])]);
    assert_eq!(site.operator("PUT", "/api/heatmap/themes", Some(&local_themes)).await.status, 200);
    assert_eq!(site.operator("GET", "/api/heatmap/themes", None).await.json(), local_themes);
    assert_eq!(site.public(&alice, "GET", "/api/heatmap/themes", None).await.json()["themes"][0]["id"], "t1", "운영자가 저장한 것은 공개 계정에 나타나지 않는다");
}

async fn save_themes(site: &Site, who: &Session, themes: &[(&str, &str, Vec<String>)]) {
    let reply = site.public(who, "PUT", "/api/heatmap/themes", Some(&themes_body(1, themes))).await;
    assert_eq!(reply.status, 200, "{}", head(&reply.text()));
}

async fn board_of(site: &Site, who: &Session) -> Value {
    let reply = site.public(who, "GET", "/api/heatmap/board", None).await;
    assert_eq!(reply.status, 200, "{}", head(&reply.text()));
    reply.json()
}

async fn flow_of(site: &Site, who: &Session, symbols: &[String]) -> Reply {
    site.public(who, "GET", &format!("/api/heatmap/flow?symbols={}", symbols.join(",")), None).await
}

fn names(list: &Value, field: &str) -> Vec<String> {
    list.as_array().unwrap().iter().map(|item| item[field].as_str().unwrap().to_owned()).collect()
}

fn strings(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn two_accounts_get_boards_from_their_own_themes_and_the_operator_from_the_local_one() {
    let (Pair { site, alice, bob }, _idp) = pair(&[]).await;
    save_themes(&site, &alice, &[("a", "앨리스 테마", vec!["005930".into()])]).await;
    save_themes(&site, &bob, &[("b1", "밥 테마", vec!["000660".into()]), ("b2", "밥 둘째", vec!["005930".into()])]).await;
    let local = themes_body(1, &[("l", "로컬 테마", vec!["005930".into(), "000660".into()])]);
    assert_eq!(site.operator("PUT", "/api/heatmap/themes", Some(&local)).await.status, 200);
    site.publish_shared(&[("005930", 51_000), ("000660", 55_000)], &[]).await;
    let before = site.wire.api_calls();

    let (a, b) = (board_of(&site, &alice).await, board_of(&site, &bob).await);
    assert_eq!(site.wire.api_calls(), before, "공개 보드는 키움 transport를 부르지 않는다");
    let operator = site.operator("GET", "/api/heatmap/board", None).await;
    assert_eq!(operator.status, 200, "{}", head(&operator.text()));
    let mut theme_names = vec![names(&a["themes"], "name"), names(&b["themes"], "name"), names(&operator.json()["themes"], "name")];
    for names in &mut theme_names {
        names.sort();
    }
    assert_eq!(theme_names, [vec!["앨리스 테마"], vec!["밥 둘째", "밥 테마"], vec!["로컬 테마"]]);
    assert_eq!(a["revision"], 1);
    assert_eq!(a["asOf"], collection_unix(10, 0), "시세는 공용 자료 판에서 나온다");
    let members = |board: &Value, id: &str| -> Vec<(String, f64)> {
        let theme = board["themes"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap_or_else(|| panic!("{id} 테마가 없다"));
        theme["members"].as_array().unwrap().iter().map(|m| (m["symbol"].as_str().unwrap().to_owned(), m["changeRate"].as_f64().unwrap())).collect()
    };
    assert_eq!(members(&a, "a"), [("005930".to_owned(), 2.0)]);
    assert_eq!(members(&b, "b1"), [("000660".to_owned(), 10.0)]);
    assert_eq!(members(&b, "b2"), [("005930".to_owned(), 2.0)]);
    let operator = operator.json();
    let mut local_members = members(&operator, "l");
    local_members.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(local_members, [("000660".to_owned(), 10.0), ("005930".to_owned(), 2.0)]);
    assert_eq!(site.wire.api_calls(), before, "운영자 보드도 판에서 읽는다");
}

#[tokio::test]
async fn a_symbol_outside_the_accounts_themes_comes_back_apart_and_nothing_reaches_kiwoom() {
    let (Pair { site, alice, .. }, _idp) = pair(&[]).await;
    let all = codes(5, 100_000);
    site.load_symbols(&all);
    save_themes(&site, &alice, &[("t", "셋과 미수집", [all[0..3].to_vec(), vec![all[4].clone()]].concat())]).await;
    let rows: Vec<(&str, u64)> = all.iter().map(|code| (code.as_str(), 51_000)).collect();
    site.publish_shared(&rows, &all[0..4]).await;
    let before = site.wire.api_calls();
    let reply = flow_of(&site, &alice, &[all[0].clone(), all[3].clone(), all[1].clone()]).await;
    assert_eq!(reply.status, 200, "{}", head(&reply.text()));
    let flow = reply.json();
    assert_eq!(strings(&flow["used"]), [all[0].clone(), all[1].clone()], "{flow}");
    assert_eq!(strings(&flow["notInThemes"]), [all[3].clone()]);
    assert_eq!((flow["overLimit"].clone(), flow["missing"].clone()), (json!([]), json!([])));
    assert!(!flow["points"].as_array().unwrap().is_empty(), "공용 분봉으로 흐름이 만들어진다");

    let only_outside = flow_of(&site, &alice, &[all[3].clone()]).await;
    assert_eq!(only_outside.status, 200, "{}", head(&only_outside.text()));
    assert_eq!(strings(&only_outside.json()["notInThemes"]), [all[3].clone()]);
    assert_eq!(only_outside.json()["points"], json!([]));
    assert_eq!(site.wire.api_calls(), before, "공개 흐름은 키움 transport를 부르지 않는다");

    let uncollected = flow_of(&site, &alice, &all[4..5]).await;
    assert_eq!(uncollected.status, 200, "{}", head(&uncollected.text()));
    assert_eq!(strings(&uncollected.json()["notCollected"]), all[4..5].to_vec());
    assert_eq!(site.wire.api_calls(), before, "분봉이 없어도 키움으로 채우지 않는다");

    let operator = site.operator("GET", &format!("/api/heatmap/flow?symbols={}", all[3]), None).await;
    assert_eq!(operator.status, 200, "운영자 리스너는 테마와 상관없이 받는다: {}", head(&operator.text()));
    assert!(operator.json().get("notInThemes").is_none(), "운영자 응답에는 새 칸이 없다");
}

#[tokio::test]
async fn the_operator_flow_keeps_its_forty_five_second_rule() {
    let (Pair { site, .. }, _idp) = pair(&[]).await;
    let all = codes(1, 100_000);
    site.load_symbols(&all);
    let path = format!("/api/heatmap/flow?symbols={}", all[0]);
    assert_eq!(site.operator("GET", &path, None).await.status, 200);
    let after_first = site.wire.minute_calls();
    assert!(after_first >= 1);
    site.jump(30);
    assert_eq!(site.operator("GET", &path, None).await.status, 200);
    assert_eq!(site.wire.minute_calls(), after_first, "45초 안에는 캐시다");
    site.jump(16);
    assert_eq!(site.operator("GET", &path, None).await.status, 200);
    assert!(site.wire.minute_calls() > after_first, "46초가 지나면 다시 받는다");
}

#[tokio::test]
async fn public_board_and_flow_requests_from_many_accounts_never_call_kiwoom() {
    let (Pair { site, alice, bob }, _idp) = pair(&[]).await;
    let carol = site.login("carol").await;
    let all = codes(30, 100_000);
    site.load_symbols(&all);
    for (n, who) in [&alice, &bob, &carol].into_iter().enumerate() {
        save_themes(&site, who, &[("t", "열 종목", all[n * 10..(n + 1) * 10].to_vec())]).await;
    }
    let rows: Vec<(&str, u64)> = all.iter().map(|code| (code.as_str(), 51_000)).collect();
    site.publish_shared(&rows, &all[0..20]).await;
    let before = site.wire.api_calls();

    for _ in 0..2 {
        for (n, who) in [&alice, &bob, &carol].into_iter().enumerate() {
            let board = board_of(&site, who).await;
            assert_eq!(board["themes"][0]["members"].as_array().unwrap().len(), 10);
            let flow = flow_of(&site, who, &all[n * 10..(n + 1) * 10]).await;
            assert_eq!(flow.status, 200, "{}", head(&flow.text()));
            site.jump(50);
        }
    }
    assert_eq!(site.wire.api_calls(), before, "공개 보드·흐름은 계정 수와 시간과 상관없이 키움 transport를 부르지 않는다");
    assert_eq!(site.wire.minute_calls() + site.wire.quote_batches().len(), 0);
}

#[tokio::test]
async fn the_usage_page_counts_theme_rejections_and_shared_data_ages() {
    let (Pair { site, alice, .. }, _idp) = pair(&[]).await;
    let all = codes(7, 100_000);
    site.load_symbols(&all);
    save_themes(&site, &alice, &[("t", "여섯", all[0..6].to_vec())]).await;
    let rows: Vec<(&str, u64)> = all.iter().map(|code| (code.as_str(), 51_000)).collect();
    site.publish_shared(&rows, &all).await;

    assert_eq!(flow_of(&site, &alice, &[all[0].clone(), all[1].clone(), all[6].clone()]).await.status, 200);
    assert_eq!(flow_of(&site, &alice, &all[0..3]).await.status, 200);
    assert_eq!(flow_of(&site, &alice, &[all[6].clone(), all[2].clone()]).await.status, 200);
    let usage = site.usage().await;
    let flow = &usage["bundles"]["flow"];
    assert_eq!((flow["rejectedSymbols"].as_u64(), flow["responses"].as_u64()), (Some(2), Some(3)), "{flow}");
    for gone in ["trCalls", "cachedSymbols", "overBudgetSymbols", "waitTotalMs", "waitMaxMs"] {
        assert!(flow.get(gone).is_none(), "{gone}는 JSON에 없다: {flow}");
    }
    assert!(usage["cacheHits"].get("marketOverview").is_none());

    board_of(&site, &alice).await;
    let usage = site.usage().await;
    let board = &usage["bundles"]["board"];
    assert_eq!(board["responses"].as_u64(), Some(1), "{board}");
    assert!(board.get("rejectedSymbols").is_none() && board.get("trCalls").is_none(), "{board}");
    assert_eq!(usage["bundles"]["user_data"]["responses"].as_u64(), Some(1), "테마 저장 한 번");

    let shared = usage["sharedData"].as_object().expect("sharedData");
    for kind in [DataKind::SnapshotCombined, DataKind::Minute, DataKind::SnapshotKrx] {
        assert!(shared[kind.folder()]["readErrors"].is_u64(), "{kind:?}: {shared:?}");
    }
    assert!(shared[DataKind::SnapshotCombined.folder()]["ageSecs"].is_i64(), "통합 스냅샷은 썼다: {shared:?}");
    assert!(shared[DataKind::SnapshotKrx.folder()]["ageSecs"].is_null(), "KRX 스냅샷은 쓰지 않았다: {shared:?}");
    assert!(shared[DataKind::SnapshotNxt.folder()]["ageSecs"].is_null(), "{shared:?}");
}
