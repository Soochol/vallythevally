mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::support::token_for;
use common::{ScriptedTransport, Server};
use futures::StreamExt;
use serde_json::{Value, json};

const OFF: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "off");
const NO_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");
const APP_KEY: &str = "FAKE-APPKEY-system-7Q2D";
const APP_SECRET: &str = "FAKE-SECRET-system-9X4K";
const OTHER_APP_KEY: &str = "FAKE-APPKEY-other-3M8P";
const OTHER_APP_SECRET: &str = "FAKE-SECRET-other-5T1R";

struct Env {
    _tmp: tempfile::TempDir,
    lock: PathBuf,
    dist: PathBuf,
    key_path: PathBuf,
}

impl Env {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
        let lock = tmp.path().join("state/vallythevally/server.lock");
        let key_path = tmp.path().join("keys/vallythevally/kiwoom-key.json");
        Env { lock, dist, key_path, _tmp: tmp }
    }

    fn spawn(&self, fake: &ScriptedTransport, extra: &[(&str, &str)]) -> Server {
        let key_path = self.key_path.to_str().unwrap();
        let mut pairs = vec![OFF, NO_KEY, ("VALLY_KIWOOM_KEY_PATH", key_path)];
        pairs.extend_from_slice(extra);
        let overrides: Vec<(&str, &std::ffi::OsStr)> = pairs.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))).collect();
        Server::spawn_with(fake, &self.lock, &self.dist, &overrides)
    }
}

struct Client {
    base: String,
    port: u16,
    http: reqwest::Client,
}

impl Client {
    async fn of(server: &Server) -> Client {
        let addr = server.addr().await;
        Client { base: format!("http://{addr}"), port: addr.port(), http: reqwest::Client::new() }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        answer(self.http.get(format!("{}{path}", self.base)).send().await.unwrap()).await
    }

    fn write(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> reqwest::RequestBuilder {
        let request = self.http.request(method, format!("{}{path}", self.base)).header("content-type", "application/json");
        match body {
            Some(body) => request.body(body.to_string()),
            None => request,
        }
    }

    async fn put_key(&self, key: &str, secret: &str) -> (u16, Value) {
        answer(self.write(reqwest::Method::PUT, "/api/system/kiwoom/key", Some(json!({"appKey": key, "appSecret": secret}))).send().await.unwrap()).await
    }

    async fn delete_key(&self) -> (u16, Value) {
        answer(self.write(reqwest::Method::DELETE, "/api/system/kiwoom/key", None).send().await.unwrap()).await
    }

    async fn connect(&self, acknowledged: bool) -> (u16, Value) {
        answer(self.write(reqwest::Method::POST, "/api/system/kiwoom/connect", Some(json!({"acknowledged": acknowledged}))).send().await.unwrap()).await
    }

    fn put_request(&self, key: &str, secret: &str) -> reqwest::RequestBuilder {
        self.write(reqwest::Method::PUT, "/api/system/kiwoom/key", Some(json!({"appKey": key, "appSecret": secret})))
    }
}

async fn answer(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn assert_no_secret(label: &str, text: &str) {
    for secret in [APP_KEY, APP_SECRET, OTHER_APP_KEY, OTHER_APP_SECRET, &token_for(APP_KEY)] {
        assert!(!text.contains(secret), "{label}에 비밀값이 있다: {secret}");
    }
}

async fn next_link_message(ws: &mut (impl futures::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin), seen: &mut String) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(message)) = ws.next().await {
            let text = message.to_text().unwrap_or_default().to_owned();
            seen.push_str(&text);
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if value["type"] == "kiwoom_link" {
                return value["status"].clone();
            }
        }
        panic!("연결이 닫혔다");
    })
    .await
    .expect("kiwoom_link 메시지가 온다")
}

#[tokio::test]
async fn a_saved_key_never_shows_in_responses_the_socket_logs_or_ui_state() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    let mut seen = String::new();

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", client.base.trim_start_matches("http://"))).await.unwrap();
    let first = next_link_message(&mut ws, &mut seen).await;
    assert_eq!((first["state"].as_str(), first["keySource"].as_str()), (Some("noKey"), Some("none")));

    let (status, saved) = client.put_key(APP_KEY, APP_SECRET).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!((saved["state"].as_str(), saved["keySource"].as_str(), saved["appKeyTail"].as_str()), (Some("disconnected"), Some("file"), Some("7Q2D")));
    let pushed = next_link_message(&mut ws, &mut seen).await;
    assert_eq!((pushed["state"].as_str(), pushed["appKeyTail"].as_str()), (Some("disconnected"), Some("7Q2D")));

    let (status, connected) = client.connect(false).await;
    assert_eq!((status, connected["state"].as_str()), (200, Some("connected")), "{connected}");

    let mut outputs = vec![saved.to_string(), connected.to_string(), seen.clone()];
    outputs.push(client.get("/api/system/kiwoom").await.1.to_string());
    outputs.push(client.get("/api/system/settings").await.1.to_string());
    outputs.push(client.get("/api/ui-state").await.1.to_string());
    let (_, empty) = client.put_key("", APP_SECRET).await;
    outputs.push(empty.to_string());
    let (bad_status, wrong_type) = answer(client.write(reqwest::Method::PUT, "/api/system/kiwoom/key", Some(json!({"appKey": APP_KEY, "appSecret": {"x": APP_SECRET}}))).send().await.unwrap()).await;
    assert_eq!(bad_status, 400);
    outputs.push(wrong_type.to_string());
    let logs = server.stop().await;
    outputs.push(logs.clone());
    for (index, output) in outputs.iter().enumerate() {
        assert_no_secret(&format!("출력 {index}"), output);
    }
    assert!(connected.to_string().contains("7Q2D") && logs.contains("키움 키를 저장했습니다"), "{logs}");
}

#[tokio::test]
async fn the_key_file_is_private_and_the_next_start_reads_it_without_calling_kiwoom() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    assert_eq!(mode(&env.key_path), 0o600);
    assert_eq!(mode(env.key_path.parent().unwrap()), 0o700);
    server.stop().await;

    let restarted = env.spawn(&fake, &[]);
    let client = Client::of(&restarted).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["keySource"].as_str(), status["state"].as_str(), status["appKeyTail"].as_str()), (Some("file"), Some("disconnected"), Some("7Q2D")), "{status}");
    assert_eq!(status["credentialId"].as_str().map(str::len), Some(8));
    assert_eq!(fake.requests(), 0, "{:?}", fake.api_ids());
}

#[tokio::test]
async fn a_key_file_others_can_read_is_not_read_and_the_status_names_the_cause() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    server.stop().await;
    std::fs::set_permissions(&env.key_path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let restarted = env.spawn(&fake, &[]);
    let client = Client::of(&restarted).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["state"].as_str(), status["problem"].as_str(), status["keySource"].as_str()), (Some("failed"), Some("keyFileUnusable"), Some("none")), "{status}");
    assert!(status["message"].as_str().unwrap().contains("chmod 600"), "{status}");
    let (_, after_connect) = client.connect(false).await;
    assert_eq!(after_connect["problem"].as_str(), Some("keyFileUnusable"));
    assert_eq!(fake.requests(), 0, "{:?}", fake.api_ids());
    assert_no_secret("상태", &status.to_string());
    assert_eq!(mode(&env.key_path), 0o644, "읽지 않은 파일은 건드리지 않는다");

    assert_eq!(client.put_key(OTHER_APP_KEY, OTHER_APP_SECRET).await.0, 200, "새 키를 저장하면 파일이 새로 쓰여 문제가 풀린다");
    let (_, fixed) = client.get("/api/system/kiwoom").await;
    assert_eq!((fixed["state"].as_str(), fixed["problem"].as_str()), (Some("disconnected"), None), "{fixed}");
    assert_eq!(mode(&env.key_path), 0o600);
}

#[tokio::test]
async fn an_environment_key_wins_and_the_screen_cannot_change_it() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[("VALLY_KIWOOM_APP_KEY", "FAKE-APPKEY-env-4W6Z")]);
    let client = Client::of(&server).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["keySource"].as_str(), status["appKeyTail"].as_str()), (Some("env"), Some("4W6Z")), "{status}");

    let (put_status, put_body) = client.put_key(APP_KEY, APP_SECRET).await;
    let (delete_status, delete_body) = client.delete_key().await;
    assert_eq!((put_status, delete_status), (409, 409));
    for body in [put_body, delete_body] {
        assert_eq!(body["error"]["code"], "conflict");
        assert_eq!(body["error"]["message"], ".env에서 읽은 키라 화면에서 바꿀 수 없습니다");
    }
    assert!(!env.key_path.exists(), "환경 키가 있으면 키 파일이 생기지 않는다");
    assert_eq!(fake.requests(), 0);
}

#[tokio::test]
async fn saving_a_key_sends_nothing_and_connecting_five_times_at_once_issues_one_token() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.connect(false).await.1["state"], "noKey");
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    assert_eq!(fake.requests(), 0, "키를 저장해도 키움에는 아무것도 보내지 않는다");

    let answers = futures::future::join_all((0..5).map(|_| client.connect(false))).await;
    for (status, body) in &answers {
        assert_eq!((*status, body["state"].as_str()), (200, Some("connected")), "{body}");
    }
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    let (_, connected) = client.get("/api/system/kiwoom").await;
    assert!(connected["tokenExpiresAt"].is_i64() && connected["symbolCount"].as_u64().unwrap() > 0 && connected["realtimeRegistered"].is_u64(), "{connected}");
}

#[tokio::test]
async fn deleting_and_saving_again_does_not_skip_the_issue_interval() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    assert_eq!(client.connect(false).await.1["state"], "connected");
    assert_eq!(fake.issued(), 1);

    let (status, deleted) = client.delete_key().await;
    assert_eq!((status, deleted["state"].as_str(), deleted["keySource"].as_str()), (200, Some("noKey"), Some("none")), "{deleted}");
    assert!(!env.key_path.exists());
    assert_eq!(client.delete_key().await.0, 200, "이미 지운 키를 또 지워도 같은 결과다");

    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let (_, again) = client.connect(false).await;
    assert_eq!((again["state"].as_str(), again["problem"].as_str()), (Some("failed"), Some("issueIntervalWait")), "{again}");
    assert!(again["retryAt"].is_i64(), "{again}");
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
}

#[tokio::test]
async fn a_write_from_another_site_host_or_content_type_is_refused_and_leaves_the_key_file_alone() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let saved = std::fs::read(&env.key_path).unwrap();

    let evil_host = client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("host", format!("evil.example:{}", client.port));
    let evil_origin = client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("origin", "https://evil.example");
    let same_host_other_scheme = client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("origin", format!("https://127.0.0.1:{}", client.port));
    let wrong_port = client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("host", "127.0.0.1:1");
    let plain_text = client.http.put(format!("{}/api/system/kiwoom/key", client.base)).header("content-type", "text/plain").body(json!({"appKey": OTHER_APP_KEY, "appSecret": OTHER_APP_SECRET}).to_string());
    let no_type = client.http.put(format!("{}/api/system/kiwoom/key", client.base)).body(json!({"appKey": OTHER_APP_KEY, "appSecret": OTHER_APP_SECRET}).to_string());
    let evil_delete = client.write(reqwest::Method::DELETE, "/api/system/kiwoom/key", None).header("origin", "https://evil.example");
    let evil_connect = client.write(reqwest::Method::POST, "/api/system/kiwoom/connect", Some(json!({"acknowledged": false}))).header("host", format!("evil.example:{}", client.port));
    for (name, request) in [("host", evil_host), ("origin", evil_origin), ("scheme", same_host_other_scheme), ("port", wrong_port), ("text/plain", plain_text), ("type 없음", no_type), ("delete", evil_delete), ("connect", evil_connect)] {
        let (status, body) = answer(request.send().await.unwrap()).await;
        assert_eq!(status, 400, "{name}: {body}");
        assert_eq!(body["error"]["code"], "bad_request", "{name}: {body}");
        assert_no_secret(name, &body.to_string());
        assert_eq!(std::fs::read(&env.key_path).unwrap(), saved, "{name}");
    }
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["state"].as_str(), status["appKeyTail"].as_str()), (Some("disconnected"), Some("7Q2D")));

    let same_origin = client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("origin", format!("http://localhost:{}", client.port)).header("host", format!("localhost:{}", client.port));
    assert_eq!(same_origin.send().await.unwrap().status().as_u16(), 200, "같은 출처는 받는다");
    let with_charset = client.http.put(format!("{}/api/system/kiwoom/key", client.base)).header("content-type", "application/json; charset=utf-8").body(json!({"appKey": APP_KEY, "appSecret": APP_SECRET}).to_string());
    assert_eq!(with_charset.send().await.unwrap().status().as_u16(), 200);
    assert_eq!(fake.requests(), 0);
}

#[tokio::test]
async fn settings_report_the_values_but_never_the_opendart_key() {
    const DART_KEY: &str = "FAKE-OPENDART-system-key";
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let dart = [("OPENDART_API_KEY", DART_KEY), ("VALLY_DART_BASE_URL", "http://127.0.0.1:9"), ("VALLY_KIND_BASE_URL", "http://127.0.0.1:9")];
    let server = env.spawn(&fake, &dart);
    let client = Client::of(&server).await;
    let (status, settings) = client.get("/api/system/settings").await;
    assert_eq!(status, 200);
    assert!(!settings.to_string().contains(DART_KEY), "{settings}");
    assert_eq!(settings["opendartKeyPresent"], true);
    assert_eq!(settings["keyPath"].as_str(), env.key_path.to_str());
    assert_eq!(settings["kiwoomTarget"], json!({"kind": "loopback", "host": null}));
    assert_eq!(settings["serverVersion"], env!("CARGO_PKG_VERSION"));
    for field in ["bind", "logFilter", "staticDir", "dbPath", "screenerDbPath", "financialDbPath", "tokenPath", "lockPath"] {
        assert!(settings[field].as_str().is_some_and(|value| !value.is_empty()), "{field}: {settings}");
    }
    for field in ["screenerUpdateOnStart", "financialAutomatic"] {
        assert!(settings[field].is_boolean(), "{field}: {settings}");
    }
    server.stop().await;

    let without = env.spawn(&fake, &[]);
    let client = Client::of(&without).await;
    assert_eq!(client.get("/api/system/settings").await.1["opendartKeyPresent"], false);
}

#[test]
fn the_real_kiwoom_target_shows_its_host_and_loopback_shows_only_the_fact() {
    use server::api::KiwoomTargetKind;
    let real = server::system_routes::kiwoom_target("https://api.kiwoom.com");
    assert_eq!((real.kind, real.host.as_deref()), (KiwoomTargetKind::Kiwoom, Some("api.kiwoom.com")));
    for url in ["http://127.0.0.1:4000", "http://localhost:4000", "http://[::1]:4000"] {
        let local = server::system_routes::kiwoom_target(url);
        assert_eq!((local.kind, local.host), (KiwoomTargetKind::Loopback, None), "{url}");
    }
}
