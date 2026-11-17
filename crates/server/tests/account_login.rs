mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use account_server::fake_idp::{ClientCredentials, FakeIdp};
use account_server::{AccountConfig, GoogleConfig, IdpUrl, ManualClock, NaverConfig, PublicUrl, Secret, UnixSeconds, open_database, router};
use common::{ScriptedTransport, Server};
use futures::StreamExt;
use serde_json::{Value, json};

const GOOGLE_SECRET: &str = "google-secret-account-login-4c1d";
const NAVER_SECRET: &str = "naver-secret-account-login-8e2a";
const CLOCK_START: &str = "20261117090000";

struct Accounts {
    base: String,
    idp: FakeIdp,
    requests: Arc<AtomicUsize>,
    setup_requests: Arc<AtomicUsize>,
    serving: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}

impl Accounts {
    async fn start() -> Accounts {
        let clock = Arc::new(ManualClock::new(UnixSeconds(1_800_000_000)));
        let idp = FakeIdp::start(ClientCredentials { id: "google-id".into(), secret: GOOGLE_SECRET.into() }, ClientCredentials { id: "naver-id".into(), secret: NAVER_SECRET.into() }, clock.clone()).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let endpoint = |path: &str| IdpUrl::parse(&idp.url(path)).unwrap();
        let config = AccountConfig {
            public_url: PublicUrl::parse(&base).unwrap(),
            google: GoogleConfig { client_id: "google-id".into(), client_secret: Secret::new(GOOGLE_SECRET), authorize_url: endpoint("/google/authorize"), token_url: endpoint("/google/token") },
            naver: NaverConfig { client_id: "naver-id".into(), client_secret: Secret::new(NAVER_SECRET), authorize_url: endpoint("/naver/authorize"), token_url: endpoint("/naver/token"), profile_url: endpoint("/naver/profile") },
        };
        let dir = tempfile::tempdir().unwrap();
        let pool = open_database(&dir.path().join("account.db")).await.unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let setup_requests = Arc::new(AtomicUsize::new(0));
        let (counter, setup_counter) = (requests.clone(), setup_requests.clone());
        let app = router(config, pool, clock).layer(axum::middleware::from_fn(move |request: axum::extract::Request, next: axum::middleware::Next| {
            let (counter, setup_counter) = (counter.clone(), setup_counter.clone());
            async move {
                if request.uri().path().starts_with("/v1/setup/") {
                    setup_counter.fetch_add(1, Ordering::SeqCst);
                } else {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
                next.run(request).await
            }
        }));
        let serving = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Accounts { base, idp, requests, setup_requests, serving, _dir: dir }
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    fn setup_requests(&self) -> usize {
        self.setup_requests.load(Ordering::SeqCst)
    }

    async fn stop(self) -> String {
        self.serving.abort();
        let _ = self.serving.await;
        self.base
    }
}

struct Machine {
    _tmp: tempfile::TempDir,
    lock: PathBuf,
    dist: PathBuf,
    key_path: PathBuf,
    state_path: PathBuf,
}

impl Machine {
    fn new() -> Machine {
        let tmp = tempfile::tempdir().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
        let lock = tmp.path().join("run/vallythevally/server.lock");
        let key_path = tmp.path().join("keys/vallythevally/kiwoom-key.json");
        let state_path = tmp.path().join("state/vallythevally/account.json");
        Machine { _tmp: tmp, lock, dist, key_path, state_path }
    }

    async fn run(&self, account_url: Option<&str>) -> Connector {
        let mut pairs = vec![
            ("VALLY_KIWOOM_CONNECT", "off".to_owned()),
            ("VALLY_KIWOOM_APP_KEY", String::new()),
            ("VALLY_KIWOOM_KEY_PATH", self.key_path.display().to_string()),
            ("VALLY_ACCOUNT_STATE_PATH", self.state_path.display().to_string()),
            ("VALLY_CLOCK_START", CLOCK_START.to_owned()),
        ];
        if let Some(url) = account_url {
            pairs.push(("VALLY_ACCOUNT_SERVER_URL", url.to_owned()));
        }
        let overrides: Vec<(&str, &std::ffi::OsStr)> = pairs.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(value.as_str()))).collect();
        let server = Server::spawn_with(&ScriptedTransport::new(), &self.lock, &self.dist, &overrides);
        let addr = server.addr().await;
        Connector { server, base: format!("http://{addr}"), port: addr.port(), http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap() }
    }

    fn saved_token(&self) -> String {
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&self.state_path).unwrap()).unwrap();
        saved["token"].as_str().unwrap().to_owned()
    }

    fn state_file(&self) -> Option<String> {
        std::fs::read_to_string(&self.state_path).ok()
    }
}

struct Connector {
    server: Server,
    base: String,
    port: u16,
    http: reqwest::Client,
}

impl Connector {
    fn write(&self, method: reqwest::Method, path: &str, body: &Value) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{path}", self.base)).header("content-type", "application/json").body(body.to_string())
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        answer(self.http.get(format!("{}{path}", self.base)).send().await.unwrap()).await
    }

    async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        answer(self.write(reqwest::Method::POST, path, body).send().await.unwrap()).await
    }

    async fn status(&self) -> Value {
        let (status, body) = self.get("/api/account").await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn start_login(&self, provider: &str) -> String {
        let (status, body) = self.post("/api/account/login", &json!({"provider": provider})).await;
        assert_eq!(status, 200, "{body}");
        body["url"].as_str().unwrap().to_owned()
    }

    async fn complete(&self, query: &str) -> reqwest::Response {
        self.http.get(format!("{}/auth/complete?{query}", self.base)).send().await.unwrap()
    }

    async fn login(&self, accounts: &Accounts, provider: &str) -> reqwest::Response {
        let start = self.start_login(provider).await;
        let target = follow_to_connector(accounts, &start).await;
        assert_eq!(target.host_str(), Some("127.0.0.1"));
        assert_eq!(target.port(), Some(self.port));
        assert_eq!(target.path(), "/auth/complete");
        self.http.get(format!("{}/auth/complete?{}", self.base, target.query().unwrap())).send().await.unwrap()
    }

    async fn login_ok(&self, accounts: &Accounts, provider: &str) {
        let done = self.login(accounts, provider).await;
        assert_eq!(done.status(), 302);
        assert_eq!(done.headers()["location"], "/", "로그인이 끝나면 /로 간다");
    }
}

async fn follow_to_connector(accounts: &Accounts, start: &str) -> reqwest::Url {
    assert!(start.starts_with(&accounts.base), "{start}");
    let browser = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let begun = browser.get(start).send().await.unwrap();
    let cookie = begun.headers().get_all("set-cookie").iter().map(|value| value.to_str().unwrap().split(';').next().unwrap().to_owned()).collect::<Vec<_>>().join("; ");
    let authorize = location(&begun);
    let at_idp = browser.get(authorize.as_str()).send().await.unwrap();
    let callback = location(&at_idp);
    let back = browser.get(callback.as_str()).header("cookie", cookie).send().await.unwrap();
    location(&back)
}

fn location(response: &reqwest::Response) -> reqwest::Url {
    assert_eq!(response.status(), 302, "리다이렉트여야 한다");
    let raw = response.headers()["location"].to_str().unwrap();
    reqwest::Url::parse("http://relative.invalid").unwrap().join(raw).unwrap_or_else(|e| panic!("{e}: {raw} (from {})", response.url()))
}

async fn answer(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    (status, serde_json::from_str(&response.text().await.unwrap_or_default()).unwrap_or(Value::Null))
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

async fn me(accounts: &Accounts, token: &str) -> u16 {
    reqwest::Client::new().get(format!("{}/v1/me", accounts.base)).bearer_auth(token).send().await.unwrap().status().as_u16()
}

fn reason_of(response: &reqwest::Response) -> String {
    let target = location(response);
    assert_eq!(target.path(), "/");
    let query: std::collections::HashMap<String, String> = target.query_pairs().into_owned().collect();
    assert_eq!(query["login"], "error");
    query["reason"].clone()
}

async fn fill_watchlist(connector: &Connector) {
    let body = json!({"lists": [{"id": "W1", "name": "기본", "symbols": ["005930", "000660"], "groups": []}], "revision": 1_794_152_040_001_i64});
    let (status, answer) = answer(connector.write(reqwest::Method::PUT, "/api/watchlists", &body).send().await.unwrap()).await;
    assert_eq!(status, 200, "{answer}");
}

#[tokio::test]
async fn google_and_naver_logins_end_signed_in_with_a_private_state_file() {
    for provider in ["google", "naver"] {
        let accounts = Accounts::start().await;
        let machine = Machine::new();
        let connector = machine.run(Some(&accounts.base)).await;
        assert_eq!(connector.status().await, json!({"state": "signed_out"}));
        connector.login_ok(&accounts, provider).await;
        let status = connector.status().await;
        assert_eq!(status["state"], "signed_in");
        assert_eq!(status["provider"], provider);
        assert_eq!(status["accountId"].as_str().unwrap().len(), 8);
        assert!(status["signedInAt"].as_i64().unwrap() > 1_700_000_000);
        assert_eq!(mode(&machine.state_path), 0o600);
        assert_eq!(mode(machine.state_path.parent().unwrap()), 0o700);
        assert_eq!(me(&accounts, &machine.saved_token()).await, 200, "저장된 토큰이 계정 서버에서 통한다");
    }
}

#[tokio::test]
async fn a_login_started_twice_keeps_one_working_token() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    connector.login_ok(&accounts, "google").await;
    let first = machine.saved_token();
    connector.login_ok(&accounts, "google").await;
    let second = machine.saved_token();
    assert_ne!(first, second);
    assert_eq!(me(&accounts, &first).await, 401, "새 로그인이 옛 토큰을 폐기한다");
    assert_eq!(me(&accounts, &second).await, 200);
}

#[tokio::test]
async fn a_state_the_connector_did_not_start_or_already_used_or_let_expire_stores_nothing() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;

    let unknown = connector.complete("code=stolen-code&state=never-started-by-this-connector").await;
    assert_eq!(reason_of(&unknown), "state");
    assert!(machine.state_file().is_none());

    let start = connector.start_login("google").await;
    let query = follow_to_connector(&accounts, &start).await.query().unwrap().to_owned();
    connector.server.clock().jump(601);
    let late = connector.complete(&query).await;
    assert_eq!(reason_of(&late), "state", "10분이 지난 state");
    assert!(machine.state_file().is_none());
    assert_eq!(connector.status().await, json!({"state": "signed_out"}));

    let start = connector.start_login("naver").await;
    let query = follow_to_connector(&accounts, &start).await.query().unwrap().to_owned();
    assert_eq!(connector.complete(&query).await.headers()["location"], "/");
    let saved = machine.state_file().unwrap();
    let requests = accounts.requests();
    let replay = connector.complete(&query).await;
    assert_eq!(reason_of(&replay), "state", "같은 state는 한 번만 쓴다");
    assert_eq!(machine.state_file().unwrap(), saved, "다시 써도 상태 파일이 그대로다");
    assert_eq!(accounts.requests(), requests, "거절한 요청은 계정 서버로 가지 않는다");
}

#[tokio::test]
async fn cancelled_and_failed_idp_logins_come_back_as_short_reasons() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    accounts.idp.cancel_next_authorization();
    let cancelled = connector.login(&accounts, "google").await;
    assert_eq!(reason_of(&cancelled), "cancelled");
    accounts.idp.set_fault(account_server::fake_idp::Fault::TokenExchangeRejected);
    let failed = connector.login(&accounts, "google").await;
    assert_eq!(reason_of(&failed), "idp_failed");
    assert!(machine.state_file().is_none());
    assert_eq!(connector.status().await, json!({"state": "signed_out"}));
}

#[tokio::test]
async fn the_connector_token_never_leaves_the_state_file() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    let ws_url = format!("ws://{}/api/ws", connector.base.trim_start_matches("http://"));
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    let mut seen = String::new();
    let first = next_account_message(&mut ws, &mut seen).await;
    assert_eq!(first, json!({"state": "signed_out"}));
    connector.login_ok(&accounts, "google").await;
    let pushed = next_account_message(&mut ws, &mut seen).await;
    assert_eq!(pushed["state"], "signed_in");
    let token = machine.saved_token();
    assert!(token.len() >= 32);

    let mut outputs = vec![seen, connector.get("/api/account").await.1.to_string(), connector.get("/api/system/settings").await.1.to_string(), connector.get("/api/setup/export").await.1.to_string()];
    let (_, settings) = connector.get("/api/system/settings").await;
    assert_eq!(settings["accountServerUrl"], accounts.base);
    assert_eq!(settings["accountStatePath"], machine.state_path.display().to_string());
    let (mut fresh, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    let mut reconnected = String::new();
    assert_eq!(next_account_message(&mut fresh, &mut reconnected).await["state"], "signed_in");
    outputs.push(reconnected);
    outputs.push(connector.server.logs());
    outputs.push(connector.server.stop().await);
    for (index, output) in outputs.iter().enumerate() {
        assert!(!output.contains(&token), "출력 {index}에 토큰이 있다");
    }
}

async fn next_account_message(ws: &mut (impl futures::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin), seen: &mut String) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(message)) = ws.next().await {
            let text = message.to_text().unwrap_or_default().to_owned();
            seen.push_str(&text);
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if value["type"] == "account" {
                return value["status"].clone();
            }
        }
        panic!("연결이 닫혔다");
    })
    .await
    .expect("account 메시지가 온다")
}

#[tokio::test]
async fn a_different_account_server_address_means_signed_out_and_sends_nothing() {
    let (old, new, machine) = (Accounts::start().await, Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&old.base)).await;
    connector.login_ok(&old, "google").await;
    let saved = machine.state_file().unwrap();
    connector.server.stop().await;
    let (old_before, new_before) = (old.requests(), new.requests());

    let moved = machine.run(Some(&new.base)).await;
    assert_eq!(moved.status().await, json!({"state": "signed_out"}));
    let (_, settings) = moved.get("/api/system/settings").await;
    assert_eq!(settings["accountServerUrl"], new.base);
    let (status, _) = moved.post("/api/account/logout", &json!({})).await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((old.requests(), new.requests()), (old_before, new_before), "어느 서버에도 요청이 가지 않는다");
    assert_eq!(machine.state_file().unwrap(), saved, "다른 서버의 상태 파일은 건드리지 않는다");
}

#[tokio::test]
async fn starting_the_connector_sends_only_setup_sync_requests_when_signed_in() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    connector.login_ok(&accounts, "naver").await;
    connector.server.stop().await;
    let (before, setup_before) = (accounts.requests(), accounts.setup_requests());
    let restarted = machine.run(Some(&accounts.base)).await;
    assert_eq!(restarted.status().await["state"], "signed_in");
    let _ = restarted.get("/api/system/settings").await;
    let (_socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", restarted.base.trim_start_matches("http://"))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(accounts.requests(), before, "토큰 확인 같은 로그인 요청은 가지 않는다");
    assert!(accounts.setup_requests() > setup_before, "로그인돼 있으면 시작 때 셋업 동기화를 한다");
}

#[tokio::test]
async fn logout_revokes_the_token_and_works_without_the_account_server() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    connector.login_ok(&accounts, "google").await;
    let token = machine.saved_token();
    let (status, body) = connector.post("/api/account/logout", &json!({})).await;
    assert_eq!((status, &body), (200, &json!({"state": "signed_out"})));
    assert_eq!(me(&accounts, &token).await, 401);
    assert!(machine.state_file().is_none());

    connector.login_ok(&accounts, "google").await;
    accounts.stop().await;
    let (status, body) = connector.post("/api/account/logout", &json!({})).await;
    assert_eq!((status, &body), (200, &json!({"state": "signed_out"})), "계정 서버가 꺼져 있어도 로컬 로그아웃은 끝난다");
    assert!(machine.state_file().is_none());
}

#[tokio::test]
async fn refresh_signs_out_a_token_the_account_server_no_longer_knows_and_keeps_it_when_unreachable() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    connector.login_ok(&accounts, "google").await;
    let (status, body) = connector.post("/api/account/refresh", &json!({})).await;
    assert_eq!((status, body["state"].clone()), (200, json!("signed_in")));

    let token = machine.saved_token();
    let revoked = reqwest::Client::new().delete(format!("{}/v1/auth/token", accounts.base)).bearer_auth(&token).send().await.unwrap();
    assert_eq!(revoked.status(), 204);
    let (status, body) = connector.post("/api/account/refresh", &json!({})).await;
    assert_eq!((status, &body), (200, &json!({"state": "signed_out"})));
    assert!(machine.state_file().is_none());

    connector.login_ok(&accounts, "google").await;
    accounts.stop().await;
    let (status, body) = connector.post("/api/account/refresh", &json!({})).await;
    assert_eq!((status, body["error"]["code"].clone()), (502, json!("account_server_unavailable")));
    assert_eq!(connector.status().await["state"], "signed_in");
}

#[tokio::test]
async fn deleting_the_account_clears_the_login_and_owner_but_keeps_the_local_setup() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    fill_watchlist(&connector).await;
    accounts.idp.set_subject("first-person");
    connector.login_ok(&accounts, "google").await;
    let token = machine.saved_token();
    let watchlists = connector.get("/api/watchlists").await.1;

    let (status, body) = connector.post("/api/account/delete", &json!({"confirm": false})).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(connector.status().await["state"], "signed_in");

    let (status, body) = connector.post("/api/account/delete", &json!({"confirm": true})).await;
    assert_eq!((status, &body), (200, &json!({"state": "signed_out"})));
    assert!(machine.state_file().is_none());
    assert_eq!(me(&accounts, &token).await, 401);
    assert_eq!(connector.get("/api/watchlists").await.1, watchlists, "로컬 관심종목은 그대로다");

    accounts.idp.set_subject("second-person");
    connector.login_ok(&accounts, "google").await;
    assert_eq!(connector.status().await["state"], "signed_in", "소유 표시가 지워졌으니 다른 계정도 그대로 들어온다");
}

#[tokio::test]
async fn a_failed_account_deletion_erases_nothing() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    connector.login_ok(&accounts, "google").await;
    let saved = machine.state_file().unwrap();
    accounts.stop().await;
    let (status, body) = connector.post("/api/account/delete", &json!({"confirm": true})).await;
    assert_eq!((status, body["error"]["code"].clone()), (502, json!("account_server_unavailable")));
    assert_eq!(machine.state_file().unwrap(), saved);
    assert_eq!(connector.status().await["state"], "signed_in");
}

#[tokio::test]
async fn another_account_is_a_mismatch_until_the_local_setup_is_replaced() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    fill_watchlist(&connector).await;
    accounts.idp.set_subject("owner-person");
    connector.login_ok(&accounts, "google").await;
    let owner = connector.status().await["accountId"].as_str().unwrap().to_owned();
    connector.post("/api/account/logout", &json!({})).await;

    accounts.idp.set_subject("other-person");
    connector.login_ok(&accounts, "naver").await;
    let status = connector.status().await;
    assert_eq!(status["state"], "owner_mismatch");
    assert_eq!(status["localOwner"], owner);
    assert_ne!(status["accountId"], status["localOwner"]);
    assert_eq!(status["provider"], "naver");
    assert!(machine.state_file().is_some(), "다른 계정이어도 토큰은 저장한다");
    assert_eq!(connector.get("/api/watchlists").await.1["lists"].as_array().unwrap().len(), 1, "바꾸기 전에는 로컬 셋업이 그대로다");

    let (status, body) = connector.post("/api/account/replace-local", &json!({"confirm": false})).await;
    assert_eq!(status, 400, "{body}");
    let (status, body) = connector.post("/api/account/replace-local", &json!({"confirm": true})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "signed_in");

    let fresh = Machine::new().run(None).await;
    assert_eq!(connector.get("/api/setup/export").await.1, fresh.get("/api/setup/export").await.1, "로컬 셋업이 첫 마이그레이션의 기본 상태다");
    let (status, body) = connector.post("/api/account/replace-local", &json!({"confirm": true})).await;
    assert_eq!((status, body["error"]["code"].clone()), (409, json!("conflict")), "소유가 같으면 쓸 수 없다");
}

#[tokio::test]
async fn local_only_mode_reports_it_and_refuses_every_account_action() {
    let (counting, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(None).await;
    assert_eq!(connector.status().await, json!({"state": "local_only"}));
    let (_, settings) = connector.get("/api/system/settings").await;
    assert_eq!(settings["accountServerUrl"], Value::Null);
    let attempts = [("/api/account/login", json!({"provider": "google"})), ("/api/account/logout", json!({})), ("/api/account/refresh", json!({})), ("/api/account/delete", json!({"confirm": true})), ("/api/account/replace-local", json!({"confirm": true}))];
    for (path, body) in attempts {
        let (status, answer) = connector.post(path, &body).await;
        assert_eq!((status, answer["error"]["code"].clone()), (409, json!("conflict")), "{path}: {answer}");
    }
    let (status, body) = connector.post("/api/account/login", &json!({"provider": "google"})).await;
    assert_eq!((status, body["error"]["code"].clone()), (409, json!("conflict")));
    assert_eq!(reason_of(&connector.complete("code=c&state=s").await), "local_only");
    assert!(machine.state_file().is_none());
    assert_eq!(counting.requests(), 0);
    assert_eq!(connector.get("/api/layouts").await.0, 200, "다른 API는 그대로 돈다");
}

#[tokio::test]
async fn account_writes_with_a_foreign_host_origin_or_content_type_are_refused() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    let url = format!("{}/api/account/login", connector.base);
    let body = json!({"provider": "google"}).to_string();
    let evil_host = format!("evil.example:{}", connector.port);
    let attempts = [
        connector.http.post(&url).header("content-type", "application/json").header("host", &evil_host).body(body.clone()),
        connector.http.post(&url).header("content-type", "application/json").header("origin", "https://evil.example").body(body.clone()),
        connector.http.post(&url).header("content-type", "text/plain").body(body.clone()),
        connector.http.post(format!("{}/api/account/logout", connector.base)).header("content-type", "text/plain").body("{}"),
        connector.http.post(format!("{}/api/account/delete", connector.base)).header("content-type", "application/json").header("origin", "https://evil.example").body(json!({"confirm": true}).to_string()),
    ];
    for attempt in attempts {
        assert_eq!(attempt.send().await.unwrap().status(), 400);
    }
    assert_eq!(accounts.requests(), 0);

    let start = connector.start_login("google").await;
    let query = follow_to_connector(&accounts, &start).await.query().unwrap().to_owned();
    let wrong_host = connector.http.get(format!("{}/auth/complete?{query}", connector.base)).header("host", &evil_host).send().await.unwrap();
    assert_eq!(wrong_host.status(), 400);
    assert!(machine.state_file().is_none());
    let right_host = connector.complete(&query).await;
    assert_eq!(right_host.headers()["location"], "/", "잘못된 Host의 요청이 state를 쓰지 않았다");
    assert_eq!(connector.status().await["state"], "signed_in");
}

#[tokio::test]
async fn deleting_a_mismatched_account_leaves_the_local_owner_in_place() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    accounts.idp.set_subject("owner-person");
    connector.login_ok(&accounts, "google").await;
    let owner = connector.status().await["accountId"].as_str().unwrap().to_owned();
    connector.post("/api/account/logout", &json!({})).await;
    accounts.idp.set_subject("other-person");
    connector.login_ok(&accounts, "google").await;
    assert_eq!(connector.status().await["state"], "owner_mismatch");
    let (status, body) = connector.post("/api/account/delete", &json!({"confirm": true})).await;
    assert_eq!((status, &body), (200, &json!({"state": "signed_out"})));
    accounts.idp.set_subject("third-person");
    connector.login_ok(&accounts, "google").await;
    let status = connector.status().await;
    assert_eq!((status["state"].clone(), status["localOwner"].clone()), (json!("owner_mismatch"), json!(owner)), "삭제한 계정이 소유자가 아니면 소유 표시는 그대로다");
}

#[tokio::test]
async fn when_the_state_file_cannot_be_removed_after_deletion_memory_and_file_still_agree() {
    let (accounts, machine) = (Accounts::start().await, Machine::new());
    let connector = machine.run(Some(&accounts.base)).await;
    connector.login_ok(&accounts, "google").await;
    let dir = machine.state_path.parent().unwrap().to_owned();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let (status, _) = connector.post("/api/account/delete", &json!({"confirm": true})).await;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(status, 500);
    assert_eq!(connector.status().await["state"], "signed_in", "파일이 남았으니 메모리도 로그인 상태다");
    connector.server.stop().await;
    let restarted = machine.run(Some(&accounts.base)).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while restarted.status().await["state"] != "signed_out" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("시작 때의 동기화가 계정 서버가 모르는 토큰을 로그아웃으로 정리한다");
    assert!(machine.state_file().is_none());
}
