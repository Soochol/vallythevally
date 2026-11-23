mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{ScriptedTransport, Server};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::kiwoom::key_file::KeyId;
use server::kiwoom::keys::Connection;
use server::kis::error::judge_market;
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};

const START: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "start");
const OFF: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "off");
const NO_KIWOOM_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");
const KIS_KEY: &str = "FAKE-KIS-APPKEY-keys-env-7H2P";
const KIS_SECRET: &str = "FAKE-KIS-SECRET-keys-env-3M8Q";
const SCREEN_KIS_KEY: &str = "FAKE-KIS-APPKEY-keys-screen-9T4X";
const SCREEN_KIS_SECRET: &str = "FAKE-KIS-SECRET-keys-screen-5N1D";
const KIWOOM_KEY: &str = "FAKE-APPKEY-kiskeys-kiwoom-6C0Z";
const KIWOOM_SECRET: &str = "FAKE-SECRET-kiskeys-kiwoom-2V7B";
const IN_USE_ELSEWHERE: &str = r#"{"header":{"tr_id":null},"body":{"rt_cd":"9","msg_cd":"OPSP8996","msg1":"ALREADY IN USE appkey"}}"#;
const ISSUE_REFUSED: &str = r#"{"error_description":"유효하지 않은 AppKey입니다.","error_code":"EGW00999"}"#;

struct FakeKis {
    requests: Mutex<Vec<(String, Value)>>,
    refuse_issue: AtomicBool,
}

impl FakeKis {
    fn new() -> Arc<FakeKis> {
        Arc::new(FakeKis { requests: Mutex::default(), refuse_issue: AtomicBool::new(false) })
    }

    fn refusing() -> Arc<FakeKis> {
        let fake = FakeKis::new();
        fake.refuse_issue.store(true, Ordering::Relaxed);
        fake
    }

    fn issued_for(&self) -> Vec<String> {
        self.requests.lock().unwrap().iter().filter(|(path, _)| path == "/oauth2/tokenP").map(|(_, body)| body["appkey"].as_str().unwrap().to_owned()).collect()
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let body: Value = req.body.as_ref().and_then(|body| serde_json::from_str(body.expose()).ok()).unwrap_or(Value::Null);
        self.requests.lock().unwrap().push((req.path.to_owned(), body.clone()));
        let response = if req.path == "/oauth2/tokenP" && self.refuse_issue.load(Ordering::Relaxed) {
            HttpResponse { status: 403, tr_cont: None, body: ISSUE_REFUSED.to_owned() }
        } else if req.path == "/oauth2/tokenP" {
            let token = format!("FAKE-KIS-TOKEN-for-{}", body["appkey"].as_str().unwrap_or_default());
            HttpResponse { status: 200, tr_cont: None, body: json!({"access_token": token, "expires_in": 86_400}).to_string() }
        } else {
            HttpResponse { status: 500, tr_cont: None, body: String::new() }
        };
        Box::pin(async move { Ok(response) })
    }
}

fn synthetic_account(key: &str) -> String {
    let digits = key.bytes().fold(0_u64, |sum, byte| (sum * 31 + u64::from(byte)) % 100_000_000);
    format!("{digits:08}-01")
}

struct Env {
    _tmp: tempfile::TempDir,
    lock: PathBuf,
    dist: PathBuf,
}

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
        let lock = tmp.path().join("state/vallythevally/server.lock");
        Env { lock, dist, _tmp: tmp }
    }

    fn dir(&self) -> &Path {
        self.lock.parent().unwrap()
    }

    fn list_path(&self) -> PathBuf {
        self.dir().join("kiwoom-keys.json")
    }

    fn spawn(&self, fake: &ScriptedTransport, kis: &Arc<FakeKis>, extra: &[(&str, &str)]) -> Server {
        let overrides: Vec<(&str, &std::ffi::OsStr)> = extra.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))).collect();
        Server::spawn_with_kis(fake, Some(kis.clone()), &self.lock, &self.dist, &overrides)
    }
}

struct Client {
    base: String,
    http: reqwest::Client,
}

impl Client {
    async fn of(server: &Server) -> Client {
        Client { base: format!("http://{}", server.addr().await), http: reqwest::Client::new() }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let request = self.http.request(method, format!("{}{path}", self.base)).header("content-type", "application/json");
        let request = match body {
            Some(body) => request.body(body.to_string()),
            None => request,
        };
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        self.send(reqwest::Method::GET, path, None).await
    }

    async fn add(&self, broker: Option<&str>, alias: &str, key: &str, secret: &str) -> (u16, Value) {
        let mut body = json!({"alias": alias, "appKey": key, "appSecret": secret});
        if let Some(broker) = broker {
            body["broker"] = json!(broker);
        }
        if broker == Some("kis") {
            body["accountNo"] = json!(synthetic_account(key));
        }
        self.send(reqwest::Method::POST, "/api/system/kiwoom/keys", Some(body)).await
    }

    async fn keys(&self) -> Vec<Value> {
        self.get("/api/system/kiwoom/keys").await.1["keys"].as_array().unwrap().clone()
    }

    async fn key(&self, id: &str) -> Value {
        self.keys().await.into_iter().find(|key| key["keyId"] == id).unwrap_or(Value::Null)
    }

    async fn until_key_state(&self, id: &str, wanted: &str) -> Value {
        until(&format!("키 {id}의 연결 상태 {wanted}"), || async {
            let key = self.key(id).await;
            (key["link"]["state"] == wanted).then_some(key)
        })
        .await
    }
}

async fn until<T, F: std::future::Future<Output = Option<T>>>(what: &str, mut check: impl FnMut() -> F) -> T {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(found) = check().await {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("기다리던 것이 오지 않았다: {what}"))
}

const WITH_KIS_ENV: [(&str, &str); 3] = [("VALLY_KIS_APP_KEY", KIS_KEY), ("VALLY_KIS_APP_SECRET", KIS_SECRET), START];

#[tokio::test]
async fn the_kis_env_key_is_a_read_only_line_after_the_kiwoom_env_key_and_connects_on_its_own() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let server = env.spawn(&fake, &kis, &WITH_KIS_ENV);
    let client = Client::of(&server).await;
    let kis_line = client.until_key_state("env-kis", "connected").await;
    let keys = client.keys().await;
    let ids: Vec<_> = keys.iter().map(|key| (key["keyId"].as_str().unwrap(), key["broker"].as_str().unwrap(), key["source"].as_str().unwrap(), key["market"].as_bool().unwrap())).collect();
    assert_eq!(ids, [("env", "kiwoom", "env", true), ("env-kis", "kis", "env", false)]);
    assert_eq!(kis_line["appKeyTail"].as_str(), Some(&KIS_KEY[KIS_KEY.len() - 4..]));
    assert_eq!(kis.issued_for(), [KIS_KEY]);
    let token_file = env.dir().join("kis-token.json");
    assert!(token_file.exists(), "첫 한투 환경 키의 토큰은 VALLY_KIS_TOKEN_PATH 기본 경로에 남는다");
    for (method, path) in [(reqwest::Method::DELETE, "/api/system/kiwoom/keys/env-kis"), (reqwest::Method::PUT, "/api/system/kiwoom/keys/env-kis/alias")] {
        let (status, body) = client.send(method, path, Some(json!({"alias": "바꿈"}))).await;
        assert_eq!(status, 409, "{body}");
    }
    let listed = client.get("/api/system/kiwoom/keys").await.1.to_string();
    for secret in [KIS_KEY, KIS_SECRET, KIWOOM_KEY, KIWOOM_SECRET, "FAKE-KIS-TOKEN"] {
        assert!(!listed.contains(secret), "{secret}");
    }
    server.stop().await;
}

#[tokio::test]
async fn the_kis_env_account_number_and_hts_id_show_as_env_values_with_only_the_tail_and_cannot_be_changed_on_screen() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let mut pairs = WITH_KIS_ENV.to_vec();
    pairs.extend([("VALLY_KIS_ACCOUNT_NO", "50012356-01"), ("VALLY_KIS_HTS_ID", "fakehtsenv")]);
    let server = env.spawn(&fake, &kis, &pairs);
    let client = Client::of(&server).await;
    client.until_key_state("env-kis", "connected").await;
    let keys = client.keys().await;
    let line = keys.iter().find(|key| key["keyId"] == "env-kis").unwrap();
    assert_eq!(line["kisAccount"], json!({"accountTail": "56", "accountMasked": "****-**56", "htsIdSet": true, "source": "env"}));
    assert_eq!(keys.iter().find(|key| key["keyId"] == "env").unwrap()["kisAccount"], Value::Null, "키움 키에는 한투 계좌 칸이 없다");
    let (status, body) = client.send(reqwest::Method::PUT, "/api/system/kiwoom/keys/env-kis/account", Some(json!({"accountNo": "50012357-01"}))).await;
    assert_eq!(status, 409, "{body}");
    let listed = client.get("/api/system/kiwoom/keys").await.1.to_string();
    assert!(!listed.contains("50012356") && !listed.contains("fakehtsenv"), "{listed}");
    server.stop().await;
}

#[tokio::test]
async fn with_only_a_kis_env_key_that_key_is_the_market_source() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let server = env.spawn(&fake, &kis, &[NO_KIWOOM_KEY, ("VALLY_KIS_APP_KEY", KIS_KEY), ("VALLY_KIS_APP_SECRET", KIS_SECRET), START]);
    let client = Client::of(&server).await;
    client.until_key_state("env-kis", "connected").await;
    let keys = client.keys().await;
    assert_eq!(keys.len(), 1);
    assert_eq!((keys[0]["keyId"].as_str(), keys[0]["market"].as_bool()), (Some("env-kis"), Some(true)));
    assert_eq!(fake.api_ids(), Vec::<String>::new(), "키움에는 요청이 없다");
    server.stop().await;
}

#[tokio::test]
async fn each_broker_has_its_own_five_key_limit_and_the_same_app_key_is_refused_only_within_a_broker() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let server = env.spawn(&fake, &kis, &[NO_KIWOOM_KEY, OFF]);
    let client = Client::of(&server).await;
    for number in 1..=5 {
        let (status, body) = client.add(None, &format!("키움 {number}"), &format!("FAKE-APPKEY-limit-kiwoom-{number}"), "FAKE-SECRET-limit").await;
        assert_eq!(status, 200, "{body}");
    }
    for number in 1..=5 {
        let (status, body) = client.add(Some("kis"), &format!("한투 {number}"), &format!("FAKE-KIS-APPKEY-limit-{number}"), "FAKE-KIS-SECRET-limit").await;
        assert_eq!(status, 200, "{body}");
    }
    assert_eq!(client.keys().await.len(), 10);
    let saved = std::fs::read(env.list_path()).unwrap();
    for (broker, message) in [(None, "5개"), (Some("kis"), "5개")] {
        let (status, body) = client.add(broker, "여섯째", "FAKE-APPKEY-limit-sixth", "FAKE-SECRET-limit").await;
        assert_eq!(status, 400, "{body}");
        assert!(body["error"]["message"].as_str().unwrap().contains(message), "{body}");
    }
    let (status, body) = client.add(Some("kis"), "복사", "FAKE-KIS-APPKEY-limit-3", "다른 시크릿").await;
    assert_eq!((status, body["error"]["message"].as_str().unwrap().contains("이미 등록한 앱키")), (400, true), "{body}");
    assert_eq!(std::fs::read(env.list_path()).unwrap(), saved);
    let removed = client.send(reqwest::Method::DELETE, "/api/system/kiwoom/keys/k6", None).await;
    assert_eq!(removed.0, 200, "{}", removed.1);
    let (status, body) = client.add(Some("kis"), "같은 앱키", "FAKE-APPKEY-limit-kiwoom-2", "FAKE-SECRET-limit").await;
    assert_eq!(status, 200, "다른 증권사에 같은 앱키 문자열은 올 수 있다: {body}");
    server.stop().await;
}

#[tokio::test]
async fn a_kis_key_added_on_screen_gets_its_own_token_file_and_survives_a_restart() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let server = env.spawn(&fake, &kis, &[NO_KIWOOM_KEY, START]);
    let client = Client::of(&server).await;
    let (status, body) = client.add(Some("kis"), "화면 한투", SCREEN_KIS_KEY, SCREEN_KIS_SECRET).await;
    assert_eq!(status, 200, "{body}");
    assert!(!body.to_string().contains(SCREEN_KIS_KEY) && !body.to_string().contains(SCREEN_KIS_SECRET));
    let added = client.until_key_state("k1", "connected").await;
    assert_eq!((added["broker"].as_str(), added["source"].as_str(), added["market"].as_bool()), (Some("kis"), Some("file"), Some(true)));
    let tag: String = server::kiwoom::token_file::credential_id(SCREEN_KIS_KEY).trim_start_matches("sha256:").chars().take(8).collect();
    let derived = env.dir().join(format!("kis-token.{tag}.json"));
    assert!(derived.exists(), "화면 저장 키는 앱키 해시를 붙인 경로를 쓴다");
    assert!(!env.dir().join("kis-token.json").exists());
    let list: Value = serde_json::from_slice(&std::fs::read(env.list_path()).unwrap()).unwrap();
    assert_eq!((list["keys"][0]["broker"].as_str(), list["marketKeyId"].as_str()), (Some("kis"), Some("k1")));
    server.stop().await;

    let restarted_kis = FakeKis::new();
    let restarted = env.spawn(&fake, &restarted_kis, &[NO_KIWOOM_KEY, START]);
    let client = Client::of(&restarted).await;
    client.until_key_state("k1", "connected").await;
    assert_eq!(restarted_kis.request_count(), 0, "파일의 토큰을 다시 쓴다");
    restarted.stop().await;
}

#[tokio::test]
async fn a_kis_key_that_the_issue_endpoint_refuses_never_disturbs_the_kiwoom_key() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::refusing(), Env::new());
    let server = env.spawn(&fake, &kis, &WITH_KIS_ENV);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    let blocked = client.until_key_state("env-kis", "failed").await;
    assert_eq!(blocked["link"]["problem"], "keyNeedsCheck", "{blocked}");
    assert_eq!(client.key("env").await["link"]["state"], "connected");
    let status = client.get("/api/system/kiwoom").await.1;
    assert_eq!(status["state"], "connected");
    let again = client.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env-kis/connect", Some(json!({"acknowledged": true}))).await;
    assert_eq!(again.1["keys"][1]["link"]["state"], "failed");
    assert_eq!(kis.issued_for().len(), 1, "차단된 키는 발급을 다시 보내지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn a_kis_key_halted_after_connecting_for_auth_or_in_use_elsewhere_leaves_the_kiwoom_key_connected() {
    for body in [ISSUE_REFUSED, IN_USE_ELSEWHERE] {
        let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
        let server = env.spawn(&fake, &kis, &WITH_KIS_ENV);
        let client = Client::of(&server).await;
        client.until_key_state("env", "connected").await;
        client.until_key_state("env-kis", "connected").await;
        let Some(Connection::Kis(lane)) = server.keys().listed_key(&KeyId::env_kis()).map(|key| key.connection) else { panic!("한투 키 줄") };
        lane.rest.auth().halt(judge_market(if body == ISSUE_REFUSED { 403 } else { 200 }, body).unwrap());
        let failed = client.until_key_state("env-kis", "failed").await;
        assert!(failed["link"]["message"].as_str().is_some_and(|message| !message.is_empty()), "{failed}");
        assert_eq!(client.key("env").await["link"]["state"], "connected");
        assert_eq!(client.get("/api/system/kiwoom").await.1["state"], "connected");
        server.stop().await;
    }
}

#[tokio::test]
async fn a_kis_key_the_user_disconnected_stays_disconnected_after_a_restart_until_connected_again() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let server = env.spawn(&fake, &kis, &WITH_KIS_ENV);
    let client = Client::of(&server).await;
    client.until_key_state("env-kis", "connected").await;
    let (status, body) = client.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env-kis/disconnect", None).await;
    assert_eq!(status, 200, "{body}");
    let line = client.key("env-kis").await;
    assert_eq!((line["link"]["state"].as_str(), line["link"]["atStart"].as_str()), (Some("disconnected"), Some("keptDisconnected")));
    assert_eq!(client.key("env").await["link"]["state"], "connected", "키움 키는 그대로다");
    let saved: Value = serde_json::from_slice(&std::fs::read(env.dir().join("kis-token.json")).unwrap()).unwrap();
    assert!(saved["disconnected"].is_string(), "끊어 둔 기록은 한투 토큰 파일에 남는다");
    server.stop().await;

    let restarted_kis = FakeKis::new();
    let restarted = env.spawn(&fake, &restarted_kis, &WITH_KIS_ENV);
    let client = Client::of(&restarted).await;
    client.until_key_state("env", "connected").await;
    let line = client.key("env-kis").await;
    assert_eq!((line["link"]["state"].as_str(), line["link"]["atStart"].as_str()), (Some("disconnected"), Some("keptDisconnected")));
    assert_eq!(restarted_kis.request_count(), 0);
    let (_, listed) = client.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env-kis/connect", Some(json!({"acknowledged": false}))).await;
    assert_eq!(listed["keys"][1]["link"]["state"], "connected", "{listed}");
    let saved: Value = serde_json::from_slice(&std::fs::read(env.dir().join("kis-token.json")).unwrap()).unwrap();
    assert!(saved["disconnected"].is_null(), "연결하면 끊어 둔 기록이 지워진다");
    restarted.stop().await;
}

#[tokio::test]
async fn designating_a_kis_key_as_the_market_source_keeps_the_kiwoom_key_connected_and_designating_back_works() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let server = env.spawn(&fake, &kis, &WITH_KIS_ENV);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    let requests_before = fake.requests();
    let (status, body) = client.send(reqwest::Method::PUT, "/api/system/kiwoom/market-key", Some(json!({"keyId": "env-kis"}))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((client.key("env").await["market"].as_bool(), client.key("env-kis").await["market"].as_bool()), (Some(false), Some(true)));
    assert_eq!(client.key("env").await["link"]["state"], "connected", "키움 키는 끊기지 않는다");
    assert_eq!(client.get("/api/system/kiwoom").await.1["state"], "connected");
    assert_eq!(fake.requests(), requests_before, "키움 키의 토큰은 다시 받지 않는다");
    let (status, body) = client.send(reqwest::Method::PUT, "/api/system/kiwoom/market-key", Some(json!({"keyId": "nope"}))).await;
    assert_eq!(status, 404, "{body}");
    let (status, _) = client.send(reqwest::Method::PUT, "/api/system/kiwoom/market-key", Some(json!({"keyId": "env"}))).await;
    assert_eq!(status, 200);
    assert_eq!((client.key("env").await["market"].as_bool(), client.key("env-kis").await["market"].as_bool()), (Some(true), Some(false)));
    server.stop().await;
}

#[tokio::test]
async fn a_key_list_file_entry_with_a_broker_other_than_kiwoom_or_kis_is_a_file_problem_and_old_entries_read_as_kiwoom() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    std::fs::create_dir_all(env.dir()).unwrap();
    std::fs::set_permissions(env.dir(), std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let write = |text: String| {
        std::fs::write(env.list_path(), text).unwrap();
        std::fs::set_permissions(env.list_path(), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    };
    write(json!({"version": 1, "marketKeyId": "k1", "keys": [{"id": "k1", "alias": "옛 키", "appKey": KIWOOM_KEY, "appSecret": KIWOOM_SECRET}]}).to_string());
    let server = env.spawn(&fake, &kis, &[NO_KIWOOM_KEY, OFF]);
    let client = Client::of(&server).await;
    let keys = client.keys().await;
    assert_eq!((keys[0]["broker"].as_str(), keys[0]["market"].as_bool()), (Some("kiwoom"), Some(true)));
    server.stop().await;

    write(json!({"version": 1, "keys": [{"id": "k1", "alias": "이상한 키", "broker": "mirae", "appKey": KIWOOM_KEY, "appSecret": KIWOOM_SECRET}]}).to_string());
    let server = env.spawn(&fake, &kis, &[NO_KIWOOM_KEY, OFF]);
    let client = Client::of(&server).await;
    let (_, listed) = client.get("/api/system/kiwoom/keys").await;
    assert_eq!(listed["keys"].as_array().unwrap().len(), 0);
    assert!(listed["keyFileProblem"].is_string(), "{listed}");
    server.stop().await;
}

#[tokio::test]
async fn the_kiwoom_lane_follows_a_kiwoom_key_while_the_source_is_a_kis_key_and_hands_over_when_that_key_is_removed() {
    let (fake, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
    let server = env.spawn(&fake, &kis, &[NO_KIWOOM_KEY, START]);
    let client = Client::of(&server).await;
    for (broker, alias, key) in [(None, "키움 하나", KIWOOM_KEY), (None, "키움 둘", "FAKE-APPKEY-kiskeys-kiwoom-second-8F5K"), (Some("kis"), "한투", SCREEN_KIS_KEY)] {
        assert_eq!(client.add(broker, alias, key, "FAKE-SECRET-kiskeys").await.0, 200);
    }
    for id in ["k1", "k2", "k3"] {
        client.until_key_state(id, "connected").await;
    }
    assert_eq!(client.send(reqwest::Method::PUT, "/api/system/kiwoom/market-key", Some(json!({"keyId": "k3"}))).await.0, 200);
    let lane = client.get("/api/system/kiwoom").await.1;
    assert_eq!((lane["state"].as_str(), lane["appKeyTail"].as_str()), (Some("connected"), Some(&KIWOOM_KEY[KIWOOM_KEY.len() - 4..])), "시세 공급원이 한투여도 키움 레인은 키움 키에 묶여 있다: {lane}");
    assert_eq!(client.send(reqwest::Method::DELETE, "/api/system/kiwoom/keys/k1", None).await.0, 200);
    let lane = until("키움 레인이 둘째 키움 키로 넘어옴", || async {
        let lane = client.get("/api/system/kiwoom").await.1;
        (lane["state"] == "connected" && lane["appKeyTail"] == "8F5K").then_some(lane)
    })
    .await;
    assert_eq!(lane["keySource"], "file");
    assert_eq!(client.key("k3").await["market"], true, "공급원은 한투 키 그대로");
    assert_eq!(client.key("k2").await["link"]["state"], "connected");
    server.stop().await;
}
