use crate::common;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use account_server::fake_idp::{ClientCredentials, FakeIdp};
use account_server::{AccountConfig, GoogleConfig, IdpUrl, ManualClock, NaverConfig, PublicUrl, Secret, UnixSeconds, open_database, router};
use common::{ScriptedTransport, Server};
use futures::StreamExt;
use serde_json::{Value, json};

const GOOGLE_SECRET: &str = "google-secret-setup-sync-2b7e";
const NAVER_SECRET: &str = "naver-secret-setup-sync-9c31";
const CLOCK_START: &str = "20261117090000";
const CLOCK_START_MILLIS: i64 = 1_794_873_600_000;
const REVISION_AHEAD_OF_CLOCK: i64 = 1_795_000_000_000;
const _: () = assert!(REVISION_AHEAD_OF_CLOCK > CLOCK_START_MILLIS);
const LAYOUT_ONE: &str = "0193aaaa-0000-7000-8000-000000000001";
const LAYOUT_TWO: &str = "0193aaaa-0000-7000-8000-000000000002";
const SYMBOLS: [&str; 3] = ["005930", "000660", "IDX:001"];
const APP_KEY: &str = "FAKE-APPKEY-sync-5R2M";
const APP_SECRET: &str = "FAKE-SECRET-sync-1K8D";
const DART_KEY: &str = "FAKE-OPENDART-sync-key";
const REGISTERED_IP: &str = "203.0.113.88";

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    query: String,
    body: String,
}

struct Accounts {
    base: String,
    idp: FakeIdp,
    down: Arc<AtomicBool>,
    seen: Arc<Mutex<Vec<Seen>>>,
    _serving: tokio::task::JoinHandle<()>,
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
        let down = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (gate, record) = (down.clone(), seen.clone());
        let app = router(config, pool, clock).layer(axum::middleware::from_fn(move |request: axum::extract::Request, next: axum::middleware::Next| {
            let (gate, record) = (gate.clone(), record.clone());
            async move {
                if gate.load(Ordering::SeqCst) {
                    return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response_compat();
                }
                if !request.uri().path().starts_with("/v1/setup/") {
                    return next.run(request).await;
                }
                let (parts, body) = request.into_parts();
                let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024).await.unwrap();
                record.lock().unwrap().push(Seen { method: parts.method.to_string(), path: parts.uri.path().to_owned(), query: parts.uri.query().unwrap_or_default().to_owned(), body: String::from_utf8_lossy(&bytes).into_owned() });
                next.run(axum::extract::Request::from_parts(parts, axum::body::Body::from(bytes))).await
            }
        }));
        let serving = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Accounts { base, idp, down, seen, _serving: serving, _dir: dir }
    }

    fn set_down(&self, down: bool) {
        self.down.store(down, Ordering::SeqCst);
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn requests(&self) -> usize {
        self.seen().len()
    }

    async fn push(&self, token: &str, documents: &Value) -> Value {
        let response = reqwest::Client::new().post(format!("{}/v1/setup/push", self.base)).bearer_auth(token).json(&json!({"documents": documents})).send().await.unwrap();
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }

    async fn summary(&self, token: &str) -> Value {
        reqwest::Client::new().get(format!("{}/v1/setup/summary", self.base)).bearer_auth(token).send().await.unwrap().json().await.unwrap()
    }

    async fn stored_revision(&self, token: &str, kind: &str) -> Option<i64> {
        let response = reqwest::Client::new().get(format!("{}/v1/setup/changes?since=0", self.base)).bearer_auth(token).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let changes: Value = response.json().await.unwrap();
        changes["documents"].as_array().unwrap().iter().find(|document| document["kind"] == kind).and_then(|document| document["revision"].as_i64())
    }

    async fn revoke(&self, token: &str) {
        let response = reqwest::Client::new().delete(format!("{}/v1/auth/token", self.base)).bearer_auth(token).send().await.unwrap();
        assert!(response.status().is_success());
    }
}

trait IntoResponseCompat {
    fn into_response_compat(self) -> axum::response::Response;
}

impl IntoResponseCompat for axum::http::StatusCode {
    fn into_response_compat(self) -> axum::response::Response {
        axum::response::IntoResponse::into_response(self)
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

    async fn run(&self, account_url: &str) -> Connector {
        let pairs = vec![
            ("VALLY_KIWOOM_CONNECT", "off".to_owned()),
            ("VALLY_KIWOOM_APP_KEY", String::new()),
            ("VALLY_KIWOOM_KEY_PATH", self.key_path.display().to_string()),
            ("VALLY_ACCOUNT_STATE_PATH", self.state_path.display().to_string()),
            ("VALLY_CLOCK_START", CLOCK_START.to_owned()),
            ("OPENDART_API_KEY", DART_KEY.to_owned()),
            ("VALLY_DART_BASE_URL", "http://127.0.0.1:9".to_owned()),
            ("VALLY_KIND_BASE_URL", "http://127.0.0.1:9".to_owned()),
            ("VALLY_ACCOUNT_SERVER_URL", account_url.to_owned()),
        ];
        let overrides: Vec<(&str, &std::ffi::OsStr)> = pairs.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(value.as_str()))).collect();
        let server = Server::spawn_with(&ScriptedTransport::new(), &self.lock, &self.dist, &overrides);
        let addr = server.addr().await;
        Connector { server, base: format!("http://{addr}"), port: addr.port(), http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(), token_path: self.state_path.clone() }
    }
}

struct Connector {
    server: Server,
    base: String,
    port: u16,
    http: reqwest::Client,
    token_path: PathBuf,
}

async fn answer(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    (status, serde_json::from_str(&response.text().await.unwrap_or_default()).unwrap_or(Value::Null))
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

    async fn put(&self, path: &str, body: &Value) -> (u16, Value) {
        answer(self.write(reqwest::Method::PUT, path, body).send().await.unwrap()).await
    }

    async fn delete(&self, path: &str) -> u16 {
        self.write(reqwest::Method::DELETE, path, &json!({})).send().await.unwrap().status().as_u16()
    }

    async fn saved(&self, path: &str, body: &Value) {
        let (status, answer) = self.put(path, body).await;
        assert_eq!(status, 200, "{path}: {answer}");
    }

    async fn account(&self) -> Value {
        let (status, body) = self.get("/api/account").await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn sync_status(&self) -> Value {
        self.account().await["sync"].clone()
    }

    async fn sync(&self) -> (u16, Value) {
        self.post("/api/account/sync", &json!({})).await
    }

    async fn synced(&self) -> Value {
        let (status, body) = self.sync().await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn login(&self, accounts: &Accounts) {
        let (status, body) = self.post("/api/account/login", &json!({"provider": "google"})).await;
        assert_eq!(status, 200, "{body}");
        let start = body["url"].as_str().unwrap().to_owned();
        let browser = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        assert!(start.starts_with(&accounts.base));
        let begun = browser.get(&start).send().await.unwrap();
        let cookie = begun.headers().get_all("set-cookie").iter().map(|value| value.to_str().unwrap().split(';').next().unwrap().to_owned()).collect::<Vec<_>>().join("; ");
        let authorize = location(&begun);
        let callback = location(&browser.get(authorize.as_str()).send().await.unwrap());
        let back = location(&browser.get(callback.as_str()).header("cookie", cookie).send().await.unwrap());
        let done = self.http.get(format!("{}/auth/complete?{}", self.base, back.query().unwrap())).send().await.unwrap();
        assert_eq!(done.status(), 302);
        assert_eq!(done.headers()["location"], "/");
    }

    fn token(&self) -> String {
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&self.token_path).unwrap()).unwrap();
        saved["token"].as_str().unwrap().to_owned()
    }

    async fn export(&self) -> Value {
        let (status, bundle) = self.get("/api/setup/export").await;
        assert_eq!(status, 200, "{bundle}");
        bundle
    }

    async fn snapshot(&self) -> Value {
        let (_, list) = self.get("/api/layouts").await;
        let mut layouts = Vec::new();
        for summary in list.as_array().unwrap() {
            layouts.push(self.get(&format!("/api/layouts/{}", summary["id"].as_str().unwrap())).await.1);
        }
        let mut drawings = Vec::new();
        for symbol in SYMBOLS {
            drawings.push(self.get(&format!("/api/drawings?symbol={symbol}")).await.1);
        }
        json!({
            "watchlists": self.get("/api/watchlists").await.1,
            "screens": self.get("/api/screens").await.1,
            "uiState": self.get("/api/ui-state").await.1,
            "layoutList": list,
            "layouts": layouts,
            "drawings": drawings,
            "heatmapThemes": self.get("/api/heatmap/themes").await.1,
        })
    }

    async fn websocket(&self) -> impl futures::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/api/ws", self.port)).await.unwrap();
        ws
    }
}

fn location(response: &reqwest::Response) -> reqwest::Url {
    assert_eq!(response.status(), 302, "리다이렉트여야 한다");
    let raw = response.headers()["location"].to_str().unwrap();
    reqwest::Url::parse("http://relative.invalid").unwrap().join(raw).unwrap()
}

async fn next_of_type(ws: &mut (impl futures::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin), kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(message)) = ws.next().await {
            let value: Value = serde_json::from_str(message.to_text().unwrap_or_default()).unwrap_or(Value::Null);
            if value["type"] == kind {
                return value;
            }
        }
        panic!("연결이 닫혔다");
    })
    .await
    .unwrap_or_else(|_| panic!("{kind} 메시지가 오지 않았다"))
}

fn layout(id: &str, name: &str, revision: i64, windows: Value) -> Value {
    json!({"id": id, "name": name, "revision": revision, "sync": {"crosshair": true, "scroll": false}, "placement": {"v": 1, "dock": null, "canvas": {"w": 3}}, "windows": windows})
}

fn drawing(id: &str, symbol: &str, scope: Value, revision: i64) -> Value {
    json!({"id": id, "symbol": symbol, "tool": "channel", "text": null, "style": {"v": 1, "color": "#fa0"}, "locked": false, "hidden": true, "periods": ["D", "W"], "z": 1.5, "group": "묶음", "scope": scope, "revision": revision,
           "points": [{"t": 1_794_100_000, "price": 100.0}, {"t": 1_794_200_000, "price": 110.5}, {"t": 1_794_100_000, "price": 105.0}]})
}

fn chart_window(id: &str) -> Value {
    json!({"id": id, "link": null, "kind": "chart", "symbol": "005930", "venue": "krx", "period": "D", "chartSettings": {"v": 1}})
}

fn watchlists(name: &str, revision: i64) -> Value {
    json!({"lists": [{"id": "W1", "name": name, "symbols": ["005930", "000660", "IDX:001"], "groups": [{"id": "G1", "name": "반도체", "symbols": ["005930", "000660"]}]}], "revision": revision})
}

fn screens(name: &str, revision: i64) -> Value {
    json!({"screens": [{"id": "S1", "name": name, "markets": ["kospi"], "exclude": ["etf"], "conditions": [{"kind": "new_high", "period": "D", "field": "high", "n": 200, "recentBars": 1}]}], "revision": revision})
}

async fn fill(connector: &Connector) {
    let charts = json!([
        {"id": "cell-0", "link": "a", "kind": "chart", "symbol": "005930", "venue": "krx", "period": "15m", "chartSettings": {"v": 1, "indicators": ["ma"], "future": {"x": 1}}},
        {"id": "cell-1", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "W", "chartSettings": {"v": 1}},
        {"id": "watchlist", "link": "a", "kind": "watchlist"},
    ]);
    connector.saved("/api/watchlists", &watchlists("기본", 1_794_152_040_001)).await;
    connector.saved("/api/screens", &screens("신고가", 1_794_152_040_002)).await;
    connector.saved(&format!("/api/layouts/{LAYOUT_ONE}"), &layout(LAYOUT_ONE, "하나", 1_794_152_040_003, json!([charts[0], charts[2]]))).await;
    connector.saved(&format!("/api/layouts/{LAYOUT_TWO}"), &layout(LAYOUT_TWO, "둘", 1_794_152_040_004, charts)).await;
    connector.saved("/api/ui-state", &json!({"lastLayoutId": LAYOUT_TWO, "theme": "light", "watchCollapsed": true, "revision": 1_794_152_040_005_i64})).await;
    connector.saved("/api/drawings/D1", &drawing("D1", "005930", json!({"kind": "symbol"}), 1_794_152_040_006)).await;
    connector.saved("/api/drawings/D2", &drawing("D2", "000660", json!({"kind": "layout", "layoutId": LAYOUT_ONE}), 1_794_152_040_007)).await;
    connector.saved("/api/drawings/D3", &drawing("D3", "005930", json!({"kind": "cell", "layoutId": LAYOUT_TWO, "windowId": "cell-1"}), 1_794_152_040_008)).await;
    connector.saved("/api/heatmap/themes", &json!({"themes": [{"id": "T1", "name": "반도체 소부장", "symbols": ["042700", "000660"]}], "revision": 1_794_152_040_009_i64})).await;
}

struct Pair {
    accounts: Accounts,
    _machines: (Machine, Machine),
    a: Connector,
    b: Connector,
}

async fn pair() -> Pair {
    let accounts = Accounts::start().await;
    let (a_machine, b_machine) = (Machine::new(), Machine::new());
    let a = a_machine.run(&accounts.base).await;
    let b = b_machine.run(&accounts.base).await;
    a.login(&accounts).await;
    a.synced().await;
    b.login(&accounts).await;
    b.synced().await;
    Pair { accounts, _machines: (a_machine, b_machine), a, b }
}

fn kinds_of(documents: &Value) -> BTreeSet<String> {
    documents.as_array().unwrap().iter().map(|document| document["kind"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn what_one_pc_saves_the_other_pc_gets_with_the_same_revisions_and_a_setup_changed_message() {
    let pair = pair().await;
    let (a, b) = (&pair.a, &pair.b);
    let mut ws = b.websocket().await;
    fill(a).await;
    assert_eq!(a.sync_status().await["pendingDocuments"], 9);
    a.synced().await;
    assert_eq!(a.sync_status().await["pendingDocuments"], 0);

    b.synced().await;
    let changed = next_of_type(&mut ws, "setup_changed").await;
    let kinds: BTreeSet<String> = changed["kinds"].as_array().unwrap().iter().map(|kind| kind.as_str().unwrap().to_owned()).collect();
    assert_eq!(kinds, ["drawing", "heatmap_themes", "layout", "screens", "ui_state", "watchlists"].map(String::from).into());
    assert_eq!(b.snapshot().await, a.snapshot().await);
    assert_eq!(b.export().await, a.export().await);
    assert_eq!(b.sync_status().await["pendingDocuments"], 0);
    assert_eq!(b.sync_status().await["refusedDocuments"], 0);
    assert_eq!(b.sync_status().await["state"], "running");
    assert!(b.sync_status().await["lastSuccessAt"].as_i64().unwrap() > 1_700_000_000);
}

#[tokio::test]
async fn a_deleted_layout_and_drawing_stay_deleted_on_the_other_pc_even_when_it_pushes_an_old_revision() {
    let pair = pair().await;
    let (accounts, a, b) = (&pair.accounts, &pair.a, &pair.b);
    fill(a).await;
    a.synced().await;
    b.synced().await;
    assert_eq!(b.get(&format!("/api/layouts/{LAYOUT_TWO}")).await.0, 200);

    assert_eq!(a.delete("/api/drawings/D3").await, 204);
    assert_eq!(a.delete(&format!("/api/layouts/{LAYOUT_TWO}")).await, 204);
    a.synced().await;
    b.synced().await;
    assert_eq!(b.get(&format!("/api/layouts/{LAYOUT_TWO}")).await.0, 404);
    assert_eq!(b.get("/api/drawings?symbol=005930").await.1.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect::<Vec<_>>(), ["D1"]);
    assert_eq!(b.snapshot().await, a.snapshot().await);

    let (status, answer) = b.put(&format!("/api/layouts/{LAYOUT_TWO}"), &layout(LAYOUT_TWO, "둘", 1_794_152_040_004, json!([chart_window("cell-0"), {"id": "watchlist", "link": null, "kind": "watchlist"}]))).await;
    assert_eq!(status, 409, "{answer}");
    let (status, answer) = b.put("/api/drawings/D3", &drawing("D3", "005930", json!({"kind": "symbol"}), 1_794_152_040_008)).await;
    assert_eq!(status, 409, "{answer}");

    let old = json!([{"kind": "layout", "id": LAYOUT_TWO, "revision": 1_794_152_040_004_i64, "deleted": false, "body": {"id": LAYOUT_TWO, "name": "둘", "sync": {"crosshair": true, "scroll": false}, "placement": {}, "windows": [], "updatedAt": 1}}]);
    let pushed = accounts.push(&b.token(), &old).await;
    assert_eq!(pushed["results"][0]["status"], "stale", "계정 서버도 옛 revision으로 되살리지 않는다");
    a.synced().await;
    b.synced().await;
    assert_eq!(a.get(&format!("/api/layouts/{LAYOUT_TWO}")).await.0, 404);
    assert_eq!(b.get(&format!("/api/layouts/{LAYOUT_TWO}")).await.0, 404);
}

#[tokio::test]
async fn two_pcs_that_edit_the_same_document_offline_end_with_the_content_of_the_larger_revision() {
    let pair = pair().await;
    let (accounts, a, b) = (&pair.accounts, &pair.a, &pair.b);
    a.synced().await;
    accounts.set_down(true);
    a.saved("/api/watchlists", &watchlists("A가 먼저, 작은 번호", 1_794_152_050_001)).await;
    b.saved("/api/watchlists", &watchlists("B가 나중, 큰 번호", 1_794_152_050_002)).await;
    a.saved("/api/screens", &screens("A의 큰 번호", 1_794_152_050_011)).await;
    b.saved("/api/screens", &screens("B의 작은 번호", 1_794_152_050_010)).await;
    assert_ne!(a.sync().await.0, 200);
    accounts.set_down(false);

    a.synced().await;
    b.synced().await;
    a.synced().await;
    let (a_snapshot, b_snapshot) = (a.snapshot().await, b.snapshot().await);
    assert_eq!(a_snapshot, b_snapshot);
    assert_eq!(a_snapshot["watchlists"]["lists"][0]["name"], "B가 나중, 큰 번호");
    assert_eq!(a_snapshot["watchlists"]["revision"], 1_794_152_050_002_i64);
    assert_eq!(a_snapshot["screens"]["screens"][0]["name"], "A의 큰 번호");
    assert_eq!(a_snapshot["screens"]["revision"], 1_794_152_050_011_i64);
}

#[tokio::test]
async fn saving_keeps_working_while_the_account_server_is_down_and_the_pending_count_returns_to_zero_afterwards() {
    let pair = pair().await;
    let (accounts, a) = (&pair.accounts, &pair.a);
    accounts.set_down(true);
    a.saved("/api/watchlists", &watchlists("서버 없이", 1_794_152_060_001)).await;
    a.saved("/api/drawings/D1", &drawing("D1", "005930", json!({"kind": "symbol"}), 1_794_152_060_002)).await;
    assert_eq!(a.get("/api/watchlists").await.1["lists"][0]["name"], "서버 없이");
    let (status, body) = a.sync().await;
    assert_eq!(status, 502, "{body}");
    let down = a.sync_status().await;
    assert_eq!(down["pendingDocuments"], 2);
    assert_eq!(down["lastError"], "rejected");
    a.saved("/api/drawings/D2", &drawing("D2", "000660", json!({"kind": "symbol"}), 1_794_152_060_003)).await;
    assert_eq!(a.sync_status().await["pendingDocuments"], 3);

    accounts.set_down(false);
    a.synced().await;
    let up = a.sync_status().await;
    assert_eq!((up["pendingDocuments"].clone(), up["lastError"].clone()), (json!(0), Value::Null));
}

#[tokio::test]
async fn a_document_the_domain_checks_refuse_is_left_unapplied_and_counted_while_the_other_documents_arrive() {
    let pair = pair().await;
    let (accounts, a, b) = (&pair.accounts, &pair.a, &pair.b);
    let orphan = json!([{"kind": "drawing", "id": "ORPHAN", "revision": 1_794_152_070_001_i64, "deleted": false, "body": {
        "id": "ORPHAN", "symbol": "005930", "tool": "channel", "text": null, "style": {"v": 1}, "locked": false, "hidden": false, "periods": null, "z": 1.0, "group": null,
        "scope": {"kind": "layout", "layoutId": "no-such-layout"}, "updatedAt": 1,
        "points": [{"t": 1, "price": 1.0}, {"t": 2, "price": 2.0}, {"t": 3, "price": 3.0}]}}]);
    assert_eq!(accounts.push(&a.token(), &orphan).await["results"][0]["status"], "accepted");
    a.saved("/api/drawings/D1", &drawing("D1", "005930", json!({"kind": "symbol"}), 1_794_152_070_002)).await;
    a.synced().await;

    b.synced().await;
    assert_eq!(b.sync_status().await["refusedDocuments"], 1);
    let drawings = b.get("/api/drawings?symbol=005930").await.1;
    assert_eq!(drawings.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect::<Vec<_>>(), ["D1"], "거절된 문서는 없고 다른 문서는 들어온다");
    b.synced().await;
    assert_eq!(b.sync_status().await["refusedDocuments"], 1, "같은 문서를 다시 받지 않고 수도 그대로다");
}

#[tokio::test]
async fn the_first_login_uploads_a_local_setup_when_the_account_is_empty_and_takes_the_account_when_the_local_one_is_default() {
    let accounts = Accounts::start().await;
    let (first_machine, second_machine) = (Machine::new(), Machine::new());
    let first = first_machine.run(&accounts.base).await;
    fill(&first).await;
    assert_eq!(first.sync_status().await, Value::Null, "로그인 전에는 동기화 상태가 없다");
    first.login(&accounts).await;
    first.synced().await;
    assert_eq!(accounts.summary(&first.token()).await["documents"], 10);
    assert_eq!(first.sync_status().await["state"], "running");

    let second = second_machine.run(&accounts.base).await;
    second.login(&accounts).await;
    second.synced().await;
    assert_eq!(second.snapshot().await, first.snapshot().await);
    assert_eq!(second.sync_status().await["pendingDocuments"], 0);
}

#[tokio::test]
async fn when_both_sides_have_a_setup_the_first_login_waits_for_a_choice_and_each_choice_gives_its_result() {
    let accounts = Accounts::start().await;
    let (seed_machine, upload_machine, take_machine, witness_machine) = (Machine::new(), Machine::new(), Machine::new(), Machine::new());
    let seed = seed_machine.run(&accounts.base).await;
    fill(&seed).await;
    seed.login(&accounts).await;
    seed.synced().await;
    let seeded = accounts.summary(&seed.token()).await["documents"].as_i64().unwrap();

    let upload = upload_machine.run(&accounts.base).await;
    upload.saved("/api/watchlists", &watchlists("올릴 것", 1_794_152_080_001)).await;
    upload.saved("/api/layouts/EXTRA", &layout("EXTRA", "여분", 1_794_152_080_002, json!([chart_window("cell-0"), {"id": "watchlist", "link": null, "kind": "watchlist"}]))).await;
    upload.login(&accounts).await;
    let waiting = upload.synced().await;
    assert_eq!((waiting["sync"]["state"].clone(), waiting["sync"]["localDocuments"].clone(), waiting["sync"]["accountDocuments"].clone()), (json!("needs_choice"), json!(6), json!(seeded)));
    assert_eq!(accounts.summary(&upload.token()).await["documents"], seeded, "고르기 전에는 아무것도 올리지 않는다");
    assert_eq!(upload.get("/api/watchlists").await.1["lists"][0]["name"], "올릴 것");
    let (status, _) = upload.post("/api/account/initial-sync", &json!({"choice": "keep"})).await;
    assert_eq!(status, 400);

    let (status, body) = upload.post("/api/account/initial-sync", &json!({"choice": "upload_local"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["sync"]["state"], "running");
    assert_eq!(body["sync"]["pendingDocuments"], 0);
    let (status, _) = upload.post("/api/account/initial-sync", &json!({"choice": "upload_local"})).await;
    assert_eq!(status, 409, "한 번 고른 뒤에는 고를 것이 없다");

    let witness = witness_machine.run(&accounts.base).await;
    witness.login(&accounts).await;
    witness.synced().await;
    assert_eq!(witness.snapshot().await, upload.snapshot().await, "계정이 올린 로컬 셋업과 같아졌다");
    assert_eq!(witness.get(&format!("/api/layouts/{LAYOUT_ONE}")).await.0, 404, "올리지 않은 계정 문서는 지워졌다");
    assert_eq!(witness.get("/api/layouts/EXTRA").await.0, 200);

    let take = take_machine.run(&accounts.base).await;
    take.saved("/api/watchlists", &watchlists("버릴 것", 1_794_152_080_009)).await;
    take.saved("/api/layouts/DROPPED", &layout("DROPPED", "버릴 레이아웃", 1_794_152_080_010, json!([chart_window("cell-0"), {"id": "watchlist", "link": null, "kind": "watchlist"}]))).await;
    take.login(&accounts).await;
    let waiting = take.synced().await;
    assert_eq!(waiting["sync"]["state"], "needs_choice");
    let (status, body) = take.post("/api/account/initial-sync", &json!({"choice": "take_account"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(take.snapshot().await, upload.snapshot().await);
    assert_eq!(take.get("/api/layouts/DROPPED").await.0, 404);
    assert_eq!(take.sync_status().await["pendingDocuments"], 0);
}

#[tokio::test]
async fn after_replacing_a_local_setup_owned_by_another_account_the_connector_takes_the_new_account() {
    let accounts = Accounts::start().await;
    let (owner_machine, other_machine) = (Machine::new(), Machine::new());
    accounts.idp.set_subject("subject-2");
    let other = other_machine.run(&accounts.base).await;
    other.login(&accounts).await;
    fill(&other).await;
    other.synced().await;

    accounts.idp.set_subject("subject-1");
    let owner = owner_machine.run(&accounts.base).await;
    owner.login(&accounts).await;
    owner.synced().await;
    owner.saved("/api/watchlists", &watchlists("원래 주인의 것", 1_794_152_090_001)).await;

    accounts.idp.set_subject("subject-2");
    owner.login(&accounts).await;
    assert_eq!(owner.account().await["state"], "owner_mismatch");
    assert_eq!(owner.account().await["sync"]["state"], "owner_mismatch");
    assert_eq!(owner.sync().await.0, 409, "소유가 다르면 동기화하지 않는다");
    assert_eq!(owner.account().await["sync"]["pendingDocuments"], 1);

    let (status, body) = owner.post("/api/account/replace-local", &json!({"confirm": true})).await;
    assert_eq!(status, 200, "{body}");
    owner.synced().await;
    assert_eq!(owner.snapshot().await, other.snapshot().await);
}

#[tokio::test]
async fn a_rejected_token_signs_the_connector_out_and_stops_the_loop() {
    let pair = pair().await;
    let (accounts, a) = (&pair.accounts, &pair.a);
    a.saved("/api/watchlists", &watchlists("올라가야 할 것", 1_794_152_100_001)).await;
    accounts.revoke(&a.token()).await;
    let (status, body) = a.sync().await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(a.account().await, json!({"state": "signed_out"}));
    let before = accounts.requests();
    assert_eq!(a.sync().await.0, 409);
    assert_eq!(accounts.requests(), before, "로그인 안 함 상태에서는 계정 서버로 아무것도 가지 않는다");
}

#[tokio::test]
async fn the_requests_to_the_account_server_carry_only_the_setup_document_kinds_and_none_of_the_secrets() {
    let accounts = Accounts::start().await;
    let machine = Machine::new();
    let connector = machine.run(&accounts.base).await;
    assert_eq!(connector.put("/api/system/kiwoom/key", &json!({"appKey": APP_KEY, "appSecret": APP_SECRET})).await.0, 200);
    assert_eq!(connector.put("/api/system/kiwoom/registered-ip", &json!({"ip": REGISTERED_IP})).await.0, 200);
    fill(&connector).await;
    connector.login(&accounts).await;
    connector.synced().await;
    connector.saved("/api/watchlists", &watchlists("한 번 더", 1_794_152_110_001)).await;
    connector.synced().await;

    let setup_requests: Vec<Seen> = accounts.seen();
    assert!(setup_requests.iter().any(|request| request.method == "POST" && request.path == "/v1/setup/push"));
    assert!(setup_requests.iter().any(|request| request.method == "GET" && request.path == "/v1/setup/changes"));
    let token = connector.token();
    let kiwoom_token = common::support::token_for(APP_KEY);
    for request in &setup_requests {
        for secret in [APP_KEY, APP_SECRET, DART_KEY, REGISTERED_IP, token.as_str(), kiwoom_token.as_str(), "appKey", "appSecret", "registeredIp"] {
            assert!(!request.body.contains(secret) && !request.query.contains(secret), "{} {}에 {secret}이 있다", request.method, request.path);
        }
        if request.method == "POST" {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            assert_eq!(body.as_object().unwrap().keys().collect::<Vec<_>>(), ["documents"]);
            assert!(kinds_of(&body["documents"]).is_subset(&["drawing", "heatmap_themes", "layout", "screens", "ui_state", "watchlists"].map(String::from).into()));
        }
    }
    let logs = connector.server.stop().await;
    assert!(!logs.contains(&token) && !logs.contains(APP_SECRET), "로그에 비밀값이 있다");
}

#[tokio::test]
async fn two_pcs_that_saved_different_content_under_the_same_revision_end_with_the_account_copy() {
    let pair = pair().await;
    let (accounts, a, b) = (&pair.accounts, &pair.a, &pair.b);
    accounts.set_down(true);
    a.saved("/api/screens", &screens("A의 편집", 1_794_152_120_001)).await;
    b.saved("/api/screens", &screens("B의 편집", 1_794_152_120_001)).await;
    accounts.set_down(false);
    a.synced().await;
    b.synced().await;
    a.synced().await;
    b.synced().await;
    let (a_snapshot, b_snapshot) = (a.snapshot().await, b.snapshot().await);
    assert_eq!(a_snapshot["screens"], b_snapshot["screens"]);
    assert_eq!(a_snapshot["screens"]["screens"][0]["name"], "A의 편집", "먼저 올린 쪽이 계정 사본이 된다");
    assert_eq!(b.sync_status().await["pendingDocuments"], 0);
}

#[tokio::test]
async fn uploading_the_local_setup_beats_account_documents_whose_revision_is_ahead_of_this_pcs_clock() {
    let accounts = Accounts::start().await;
    let (seed_machine, upload_machine, witness_machine) = (Machine::new(), Machine::new(), Machine::new());
    let seed = seed_machine.run(&accounts.base).await;
    seed.saved("/api/watchlists", &watchlists("계정 쪽, 시계가 빠른 PC", REVISION_AHEAD_OF_CLOCK)).await;
    seed.login(&accounts).await;
    seed.synced().await;
    assert_eq!(accounts.stored_revision(&seed.token(), "watchlists").await, Some(REVISION_AHEAD_OF_CLOCK));

    let upload = upload_machine.run(&accounts.base).await;
    upload.saved("/api/watchlists", &watchlists("올릴 것", 1_794_152_130_001)).await;
    upload.login(&accounts).await;
    assert_eq!(upload.synced().await["sync"]["state"], "needs_choice");
    let (status, body) = upload.post("/api/account/initial-sync", &json!({"choice": "upload_local"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(upload.get("/api/watchlists").await.1["lists"][0]["name"], "올릴 것");

    let witness = witness_machine.run(&accounts.base).await;
    witness.login(&accounts).await;
    witness.synced().await;
    assert_eq!(witness.get("/api/watchlists").await.1["lists"][0]["name"], "올릴 것");
}

#[tokio::test]
async fn an_older_setup_imported_on_a_signed_in_pc_survives_the_next_sync_and_reaches_the_other_pc() {
    let pair = pair().await;
    let (a, b) = (&pair.a, &pair.b);
    fill(a).await;
    a.synced().await;
    let earlier = a.export().await;
    a.saved("/api/watchlists", &watchlists("나중 편집", 1_794_152_140_001)).await;
    a.synced().await;
    b.synced().await;

    assert_eq!(a.put("/api/setup/import", &earlier).await.0, 200);
    a.synced().await;
    b.synced().await;
    a.synced().await;
    assert_eq!(a.get("/api/watchlists").await.1["lists"][0]["name"], "기본");
    assert_eq!(a.snapshot().await, b.snapshot().await);
}

#[tokio::test]
async fn an_import_also_beats_an_account_copy_whose_revision_is_ahead_of_this_pcs_clock() {
    let pair = pair().await;
    let (accounts, a, b) = (&pair.accounts, &pair.a, &pair.b);
    fill(a).await;
    a.synced().await;
    let earlier = a.export().await;
    b.synced().await;
    b.saved("/api/watchlists", &watchlists("빠른 시계 PC", REVISION_AHEAD_OF_CLOCK)).await;
    b.synced().await;
    assert_eq!(accounts.stored_revision(&b.token(), "watchlists").await, Some(REVISION_AHEAD_OF_CLOCK));
    a.synced().await;
    assert_eq!(a.put("/api/setup/import", &earlier).await.0, 200);
    a.synced().await;
    b.synced().await;
    a.synced().await;
    assert_eq!(a.get("/api/watchlists").await.1["lists"][0]["name"], "기본");
    assert_eq!(a.snapshot().await, b.snapshot().await);
}
