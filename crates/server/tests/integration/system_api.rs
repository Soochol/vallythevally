use crate::common;

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

    fn list_path(&self) -> PathBuf {
        self.key_path.with_file_name("kiwoom-keys.json")
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

    async fn until_state(&self, wanted: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (_, status) = self.get("/api/system/kiwoom").await;
                if status["state"] == wanted {
                    return status;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("연결 상태 {wanted}가 오지 않았다"))
    }

    async fn disconnect(&self) -> (u16, Value) {
        answer(self.write(reqwest::Method::POST, "/api/system/kiwoom/disconnect", None).send().await.unwrap()).await
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
    assert_eq!((saved["state"].as_str(), saved["keySource"].as_str(), saved["appKeyTail"].as_str()), (Some("connecting"), Some("file"), Some("7Q2D")));
    let mut pushed = next_link_message(&mut ws, &mut seen).await;
    while pushed["state"] != "connected" {
        assert_eq!(pushed["appKeyTail"].as_str(), Some("7Q2D"));
        pushed = next_link_message(&mut ws, &mut seen).await;
    }

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
    client.until_state("connected").await;
    assert_eq!(mode(&env.list_path()), 0o600);
    assert_eq!(mode(env.list_path().parent().unwrap()), 0o700);
    server.stop().await;
    let sent = fake.requests();

    let restarted = env.spawn(&fake, &[]);
    let client = Client::of(&restarted).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["keySource"].as_str(), status["state"].as_str(), status["appKeyTail"].as_str()), (Some("file"), Some("disconnected"), Some("7Q2D")), "{status}");
    assert_eq!(status["credentialId"].as_str().map(str::len), Some(8));
    assert_eq!(fake.requests(), sent, "{:?}", fake.api_ids());
}

#[tokio::test]
async fn a_key_file_others_can_read_is_not_read_and_the_status_names_the_cause() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    client.until_state("connected").await;
    server.stop().await;
    let sent = fake.requests();
    std::fs::set_permissions(env.list_path(), std::fs::Permissions::from_mode(0o644)).unwrap();

    let restarted = env.spawn(&fake, &[]);
    let client = Client::of(&restarted).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["state"].as_str(), status["problem"].as_str(), status["keySource"].as_str()), (Some("failed"), Some("keyFileUnusable"), Some("none")), "{status}");
    assert!(status["message"].as_str().unwrap().contains("chmod 600"), "{status}");
    let (_, after_connect) = client.connect(false).await;
    assert_eq!(after_connect["problem"].as_str(), Some("keyFileUnusable"));
    assert_eq!(fake.requests(), sent, "{:?}", fake.api_ids());
    assert_no_secret("상태", &status.to_string());
    assert_eq!(mode(&env.list_path()), 0o644, "읽지 않은 파일은 건드리지 않는다");

    assert_eq!(client.put_key(OTHER_APP_KEY, OTHER_APP_SECRET).await.0, 200, "새 키를 저장하면 파일이 새로 쓰여 문제가 풀린다");
    let fixed = client.until_state("connected").await;
    assert_eq!(fixed["problem"].as_str(), None, "{fixed}");
    assert_eq!(mode(&env.list_path()), 0o600);
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
    assert!(!env.list_path().exists(), "환경 키가 있으면 키 파일이 생기지 않는다");
    assert_eq!(fake.requests(), 0);
}

const MOCK_APP_KEY: &str = "FAKE-MOCK-APPKEY-system-2H5N";
const MOCK_APP_SECRET: &str = "FAKE-MOCK-SECRET-system-8V3C";
const MOCK: [(&str, &str); 3] = [("VALLY_KIWOOM_ENV", "mock"), ("VALLY_KIWOOM_MOCK_APP_KEY", MOCK_APP_KEY), ("VALLY_KIWOOM_MOCK_APP_SECRET", MOCK_APP_SECRET)];

#[tokio::test]
async fn mock_server_refuses_key_save_and_delete() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &MOCK);
    let client = Client::of(&server).await;
    let (put_status, put_body) = client.put_key(APP_KEY, APP_SECRET).await;
    let (delete_status, delete_body) = client.delete_key().await;
    assert_eq!((put_status, delete_status), (409, 409));
    for body in [put_body, delete_body] {
        assert_eq!(body["error"]["code"], "conflict");
        assert!(body["error"]["message"].as_str().unwrap().contains("VALLY_KIWOOM_MOCK_APP_KEY"), "{body}");
        assert_no_secret("거절 응답", &body.to_string());
    }
    assert!(!env.list_path().exists(), "모의 서버는 키 파일을 쓰지 않는다");
    assert!(!env.list_path().parent().unwrap().exists());
    assert_eq!(fake.requests(), 0);

    let keyless = Env::new();
    let server = keyless.spawn(&fake, &[("VALLY_KIWOOM_ENV", "mock"), ("VALLY_KIWOOM_MOCK_APP_KEY", "")]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 409, "모의 키가 없어도 화면에서는 저장하지 못한다");
    assert!(!keyless.list_path().exists());
    assert_eq!(client.get("/api/system/kiwoom").await.1["state"], "noKey");
}

#[tokio::test]
async fn mock_server_connects_with_the_mock_key_only() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let real = env.spawn(&fake, &[]);
    let client = Client::of(&real).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    assert_eq!(client.until_state("connected").await["keySource"], "file");
    real.stop().await;
    let key_file_before = std::fs::read(env.list_path()).unwrap();
    let issued_before = fake.seen.token_bodies.lock().unwrap().len();

    let mock_env = Env { key_path: env.key_path.clone(), ..Env::new() };
    let server = mock_env.spawn(&fake, &MOCK);
    let client = Client::of(&server).await;
    let (status, connected) = client.connect(false).await;
    assert_eq!((status, connected["state"].as_str(), connected["keySource"].as_str(), connected["appKeyTail"].as_str()), (200, Some("connected"), Some("env"), Some("2H5N")), "{connected}");
    let bodies = fake.seen.token_bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), issued_before + 1, "{bodies:?}");
    assert_eq!((bodies[issued_before]["appkey"].as_str(), bodies[issued_before]["secretkey"].as_str()), (Some(MOCK_APP_KEY), Some(MOCK_APP_SECRET)), "발급 요청은 모의 키만 담는다");
    assert_eq!(std::fs::read(env.list_path()).unwrap(), key_file_before, "모의 서버는 실전 키 파일을 읽지도 쓰지도 않는다");
    assert_no_secret("연결 응답", &connected.to_string());
    let logs = server.stop().await;
    assert!(!logs.contains(MOCK_APP_KEY) && !logs.contains(MOCK_APP_SECRET), "{logs}");

    let keyless = Env { key_path: env.key_path.clone(), ..Env::new() };
    let server = keyless.spawn(&fake, &[("VALLY_KIWOOM_ENV", "mock"), ("VALLY_KIWOOM_MOCK_APP_KEY", "")]);
    let client = Client::of(&server).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["keySource"].as_str(), status["state"].as_str()), (Some("none"), Some("noKey")), "모의 키가 없으면 키 파일이 있어도 키 없이 켠다: {status}");
}

#[tokio::test]
async fn link_status_and_settings_carry_the_environment() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let real = env.spawn(&fake, &[]);
    let client = Client::of(&real).await;
    assert_eq!(client.get("/api/system/kiwoom").await.1["environment"], "real");
    assert_eq!(client.get("/api/system/settings").await.1["environment"], "real");
    real.stop().await;

    let mock_env = Env::new();
    let server = mock_env.spawn(&fake, &MOCK);
    let client = Client::of(&server).await;
    assert_eq!(client.get("/api/system/kiwoom").await.1["environment"], "mock");
    assert_eq!(client.get("/api/system/settings").await.1["environment"], "mock");
    let mut seen = String::new();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", client.base.trim_start_matches("http://"))).await.unwrap();
    assert_eq!(next_link_message(&mut ws, &mut seen).await["environment"], "mock", "WebSocket의 kiwoom_link도 투자구분을 싣는다");
}

#[tokio::test]
async fn saving_a_key_connects_by_itself_and_answers_without_waiting() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    fake.delay("au10001", Duration::from_millis(800));
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.connect(false).await.1["state"], "noKey");
    let asked = std::time::Instant::now();
    let (status, saved) = client.put_key(APP_KEY, APP_SECRET).await;
    assert_eq!((status, saved["state"].as_str()), (200, Some("connecting")), "{saved}");
    assert!(asked.elapsed() < Duration::from_millis(600), "키 저장 응답이 연결이 끝나길 기다렸다: {:?}", asked.elapsed());

    let answers = futures::future::join_all((0..5).map(|_| client.connect(false))).await;
    for (status, body) in &answers {
        assert_eq!((*status, body["state"].as_str()), (200, Some("connected")), "{body}");
    }
    assert_eq!(fake.issued(), 1, "저장으로 시작한 연결에 붙는다: {:?}", fake.api_ids());
    let (_, connected) = client.get("/api/system/kiwoom").await;
    assert!(connected["tokenExpiresAt"].is_i64() && connected["symbolCount"].as_u64().unwrap() > 0 && connected["realtimeRegistered"].is_u64(), "{connected}");
}

#[tokio::test]
async fn the_kiwoom_usage_is_empty_before_connecting_and_totals_grow_with_calls_without_any_secret() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    let (status, before) = client.get("/api/system/kiwoom/usage").await;
    assert_eq!((status, &before), (200, &json!({"lastMinuteStartedAt": null, "totalRateLimited": 0, "trs": []})));
    assert_eq!(fake.requests(), 0, "사용률 조회는 키움을 부르지 않는다");

    client.put_key(APP_KEY, APP_SECRET).await;
    client.until_state("connected").await;
    fake.respond_with("ka10001", 429, json!({"return_code": 5, "return_msg": "허용된 요청 개수를 초과하였습니다[1700:허용된 API 요청 개수를 초과하였습니다.]"}));
    client.get("/api/symbols/005930/fundamentals").await;
    let (status, usage) = client.get("/api/system/kiwoom/usage").await;
    assert_eq!(status, 200);
    let row = usage["trs"].as_array().unwrap().iter().find(|tr| tr["apiId"] == "ka10001").unwrap_or_else(|| panic!("{usage}"));
    assert!(row["totalSent"].as_u64().unwrap() > 0 && row["totalRateLimited"].as_u64().unwrap() > 0, "{row}");
    assert_eq!(row["totalSent"], fake.api_ids().iter().filter(|id| *id == "ka10001").count(), "누적 전송 수는 가짜 키움이 받은 수와 같다");
    assert_eq!(row["limit"], 5);
    assert_eq!(usage["totalRateLimited"], row["totalRateLimited"]);
    let before_reading = fake.requests();
    client.get("/api/system/kiwoom/usage").await;
    assert_eq!(fake.requests(), before_reading);
    for secret in [APP_KEY, APP_SECRET, token_for(APP_KEY).as_str(), "005930"] {
        assert!(!usage.to_string().contains(secret), "사용률 응답에 {secret}가 있다: {usage}");
    }
}

#[tokio::test]
async fn deleting_and_saving_again_waits_out_the_issue_interval_and_then_connects_by_itself() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[("VALLY_CLOCK_START", "20261109100000")]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    client.until_state("connected").await;
    assert_eq!(fake.issued(), 1);

    let (status, deleted) = client.delete_key().await;
    assert_eq!((status, deleted["state"].as_str(), deleted["keySource"].as_str()), (200, Some("noKey"), Some("none")), "{deleted}");
    assert!(!env.list_path().exists());
    assert_eq!(client.delete_key().await.0, 200, "이미 지운 키를 또 지워도 같은 결과다");

    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let waiting = client.until_state("connecting").await;
    assert_eq!(waiting["step"], "issueInterval", "{waiting}");
    assert!(waiting["retryAt"].is_i64(), "{waiting}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());

    server.clock().jump(601);
    client.until_state("connected").await;
    assert_eq!(fake.issued(), 2, "{:?}", fake.api_ids());
}

#[tokio::test]
async fn a_connect_request_answers_as_soon_as_the_issue_interval_wait_starts() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let last_request = 1_794_909_600_i64 - 60;
    let token_file = common::token_path(&env.lock);
    std::fs::create_dir_all(token_file.parent().unwrap()).unwrap();
    std::fs::set_permissions(token_file.parent().unwrap(), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(&token_file, json!({"token": null, "last_request_at": last_request}).to_string()).unwrap();
    std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let server = env.spawn(&fake, &[("VALLY_CLOCK_START", "20261109100000")]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);

    let (status, body) = tokio::time::timeout(Duration::from_secs(3), client.connect(false)).await.expect("대기에 들어가면 바로 답해야 한다");
    assert_eq!((status, body["state"].as_str(), body["step"].as_str(), body["retryAt"].as_i64()), (200, Some("connecting"), Some("issueInterval"), Some(last_request + 600)), "{body}");
    assert_eq!(fake.requests(), 0, "{:?}", fake.api_ids());
}

#[tokio::test]
async fn saving_a_new_key_after_8050_issues_nothing_without_the_acknowledgement() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    fake.respond_with("au10001", 200, json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]"}));
    let server = env.spawn(&fake, &[("VALLY_CLOCK_START", "20261109100000")]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let blocked = client.until_state("failed").await;
    assert_eq!((blocked["problem"].as_str(), blocked["needsAcknowledgement"].as_bool()), (Some("authBlocked8050"), Some(true)), "{blocked}");
    assert_eq!(fake.issued(), 1);

    server.clock().jump(601);
    let (status, saved) = client.put_key(OTHER_APP_KEY, OTHER_APP_SECRET).await;
    assert_eq!(status, 200, "{saved}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (_, after) = client.get("/api/system/kiwoom").await;
    assert_eq!((after["problem"].as_str(), after["needsAcknowledgement"].as_bool()), (Some("authBlocked8050"), Some(true)), "새 키를 저장해도 8050 차단은 남는다: {after}");
    assert_eq!(fake.issued(), 1, "간격이 지나도 확인 없이는 발급하지 않는다: {:?}", fake.api_ids());
}

#[tokio::test]
async fn saving_a_key_after_the_user_disconnected_connects_again() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    client.until_state("connected").await;

    let (status, kept) = client.disconnect().await;
    assert_eq!((status, kept["state"].as_str(), kept["atStart"].as_str()), (200, Some("disconnected"), Some("keptDisconnected")), "{kept}");
    assert_eq!(kept["message"].as_str(), Some("연결을 끊어 두었습니다. 연결하면 다음부터 서버를 켤 때 자동으로 연결합니다"));

    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let again = client.until_state("connected").await;
    assert_eq!(again["atStart"].as_str(), Some("connects"), "{again}");
    assert_eq!(fake.issued(), 1, "저장한 토큰이 유효하다: {:?}", fake.api_ids());
}

#[tokio::test]
async fn the_status_says_what_happens_at_the_next_start() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    let (_, without_key) = client.get("/api/system/kiwoom").await;
    assert!(without_key["atStart"].is_null(), "{without_key}");

    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let connected = client.until_state("connected").await;
    assert_eq!(connected["atStart"].as_str(), Some("connects"));
    let (_, kept) = client.disconnect().await;
    assert_eq!(kept["atStart"].as_str(), Some("keptDisconnected"));
    let (_, connected_again) = client.connect(false).await;
    assert_eq!((connected_again["state"].as_str(), connected_again["atStart"].as_str()), (Some("connected"), Some("connects")));
    let (_, deleted) = client.delete_key().await;
    assert!(deleted["atStart"].is_null(), "{deleted}");

    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let (_, kept_again) = client.disconnect().await;
    assert_eq!(kept_again["atStart"].as_str(), Some("keptDisconnected"));
    server.stop().await;
    let restarted = env.spawn(&fake, &[]);
    let client = Client::of(&restarted).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["state"].as_str(), status["atStart"].as_str()), (Some("disconnected"), Some("keptDisconnected")), "{status}");
    assert_eq!(status["message"].as_str(), Some("연결을 끊어 두었습니다. 연결하면 다음부터 서버를 켤 때 자동으로 연결합니다"));
}

#[tokio::test]
async fn a_write_from_another_site_host_or_content_type_is_refused_and_leaves_the_key_file_alone() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    client.until_state("connected").await;
    let sent = fake.requests();
    let saved = std::fs::read(env.list_path()).unwrap();

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
        assert_eq!(std::fs::read(env.list_path()).unwrap(), saved, "{name}");
    }
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["state"].as_str(), status["appKeyTail"].as_str()), (Some("connected"), Some("7Q2D")));
    assert_eq!(fake.requests(), sent, "거절된 쓰기는 키움으로 아무것도 보내지 않는다: {:?}", fake.api_ids());

    let same_origin = client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("origin", format!("http://localhost:{}", client.port)).header("host", format!("localhost:{}", client.port));
    assert_eq!(same_origin.send().await.unwrap().status().as_u16(), 200, "같은 출처는 받는다");
    let with_charset = client.http.put(format!("{}/api/system/kiwoom/key", client.base)).header("content-type", "application/json; charset=utf-8").body(json!({"appKey": APP_KEY, "appSecret": APP_SECRET}).to_string());
    assert_eq!(with_charset.send().await.unwrap().status().as_u16(), 200);
}

#[tokio::test]
async fn settings_report_the_values_and_no_longer_carry_the_financial_collection_switches() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    let (status, settings) = client.get("/api/system/settings").await;
    assert_eq!(status, 200);
    assert_eq!(settings["keyPath"].as_str(), env.list_path().to_str());
    assert_eq!(settings["kiwoomTarget"], json!({"kind": "loopback", "host": null}));
    assert_eq!(settings["serverVersion"], env!("CARGO_PKG_VERSION"));
    for field in ["bind", "logFilter", "staticDir", "dbPath", "screenerDbPath", "financialDbPath", "tokenPath", "lockPath"] {
        assert!(settings[field].as_str().is_some_and(|value| !value.is_empty()), "{field}: {settings}");
    }
    assert!(settings["screenerUpdateOnStart"].is_boolean(), "{settings}");
    for retired in ["financialAutomatic", "opendartKeyPresent"] {
        assert!(settings.get(retired).is_none(), "{retired}: {settings}");
    }
    server.stop().await;
}

#[tokio::test]
async fn a_retired_opendart_key_in_the_environment_starts_the_server_and_never_shows_up() {
    const DART_KEY: &str = "FAKE-OPENDART-system-key";
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let retired = [("OPENDART_API_KEY", DART_KEY), ("VALLY_FINANCIAL_AUTOMATIC", "on"), ("VALLY_DART_BASE_URL", "http://127.0.0.1:9")];
    let server = env.spawn(&fake, &retired);
    let client = Client::of(&server).await;
    let (status, settings) = client.get("/api/system/settings").await;
    assert_eq!(status, 200);
    assert!(!settings.to_string().contains(DART_KEY), "{settings}");
    let (status, source) = client.get("/api/symbols/005930/financial-source").await;
    assert!(!source.to_string().contains(DART_KEY), "{status} {source}");
    let logs = server.stop().await;
    assert!(!logs.contains(DART_KEY), "{logs}");
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

#[tokio::test]
async fn deleting_the_key_while_the_token_file_is_unreadable_keeps_the_issue_interval() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    assert_eq!(client.connect(false).await.1["state"], "connected");
    server.stop().await;
    let token_file = common::token_path(&env.lock);
    let before = std::fs::read(&token_file).unwrap();
    std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o644)).unwrap();

    let restarted = env.spawn(&fake, &[]);
    let client = Client::of(&restarted).await;
    assert_eq!(client.get("/api/system/kiwoom").await.1["problem"], "tokenFileUnusable");
    assert_eq!(client.delete_key().await.0, 200);
    assert_eq!(std::fs::read(&token_file).unwrap(), before, "읽을 수 없는 토큰 파일은 덮어쓰지 않는다");
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let recheck = answer(client.write(reqwest::Method::POST, "/api/system/kiwoom/recheck-token-file", None).send().await.unwrap()).await.1;
    assert_eq!(recheck["state"], "failed", "{recheck}");
    let (_, again) = client.connect(false).await;
    assert_ne!(again["state"], "connected", "{again}");
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
}

#[tokio::test]
async fn hello_stays_the_first_websocket_message_while_the_key_changes() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let overrides = [("SERVER_RUNTIME_THREADS", "4")];
    let server = env.spawn(&fake, &overrides);
    let client = Client::of(&server).await;
    let changing = async {
        for round in 0..60 {
            let (key, secret) = if round % 2 == 0 { (APP_KEY, APP_SECRET) } else { (OTHER_APP_KEY, OTHER_APP_SECRET) };
            client.put_key(key, secret).await;
            client.delete_key().await;
        }
    };
    let opening = async {
        for _ in 0..80 {
            let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", client.base.trim_start_matches("http://"))).await.unwrap();
            let mut seen = String::new();
            let first = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap().unwrap().unwrap();
            seen.push_str(first.to_text().unwrap());
            let first: Value = serde_json::from_str(&seen).unwrap();
            assert_eq!(first["type"], "hello", "{first}");
            let second = next_link_message(&mut ws, &mut seen).await;
            assert!(second["state"].is_string());
        }
    };
    tokio::join!(changing, opening);
}

#[tokio::test]
async fn a_server_bound_to_another_loopback_address_accepts_writes_to_that_address() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[("SERVER_BIND_IP", "127.0.0.2")]);
    let addr = server.addr().await;
    assert_eq!(addr.ip().to_string(), "127.0.0.2");
    let http = reqwest::Client::new();
    let url = format!("http://{addr}/api/system/kiwoom/key");
    let put = |host: String| http.put(&url).header("content-type", "application/json").header("host", host).body(json!({"appKey": APP_KEY, "appSecret": APP_SECRET}).to_string());
    assert_eq!(put(addr.to_string()).send().await.unwrap().status().as_u16(), 200);
    assert_eq!(put(format!("127.0.0.3:{}", addr.port())).send().await.unwrap().status().as_u16(), 400);
}

struct IpService {
    url: String,
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl IpService {
    async fn start(body: &'static str) -> IpService {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => raw.extend_from_slice(&chunk[..n]),
                        }
                    }
                    seen.lock().unwrap().push(String::from_utf8_lossy(&raw).into_owned());
                    let response = format!("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        IpService { url, requests }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Client {
    async fn ip_check(&self) -> (u16, Value) {
        answer(self.write(reqwest::Method::POST, "/api/system/kiwoom/ip-check", None).send().await.unwrap()).await
    }

    async fn put_registered_ip(&self, ip: &str) -> (u16, Value) {
        answer(self.write(reqwest::Method::PUT, "/api/system/kiwoom/registered-ip", Some(json!({"ip": ip}))).send().await.unwrap()).await
    }
}

#[tokio::test]
async fn one_ip_check_sends_one_bare_request_and_returns_the_address() {
    let (env, fake, service) = (Env::new(), ScriptedTransport::new(), IpService::start("203.0.113.7\n").await);
    let server = env.spawn(&fake, &[("VALLY_PUBLIC_IP_URL", &service.url)]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    client.until_state("connected").await;
    let sent = fake.requests();

    let (status, checked) = client.ip_check().await;
    assert_eq!(status, 200, "{checked}");
    assert_eq!(checked["ip"].as_str(), Some("203.0.113.7"));
    assert!(checked["checkedAt"].as_i64().is_some_and(|at| at > 0), "{checked}");

    let requests = service.requests();
    assert_eq!(requests.len(), 1, "{requests:?}");
    let raw = requests[0].to_ascii_lowercase();
    assert!(raw.starts_with("get / http/1.1"), "{raw}");
    for forbidden in ["authorization", "cookie", &APP_KEY.to_ascii_lowercase(), &APP_SECRET.to_ascii_lowercase(), &token_for(APP_KEY).to_ascii_lowercase()] {
        assert!(!raw.contains(forbidden), "요청에 {forbidden}가 있다: {raw}");
    }
    assert_eq!(fake.requests(), sent, "{:?}", fake.api_ids());
}

#[tokio::test]
async fn starting_and_connecting_never_call_the_ip_service() {
    let (env, fake, service) = (Env::new(), ScriptedTransport::new(), IpService::start("203.0.113.7").await);
    let server = env.spawn(&fake, &[("VALLY_PUBLIC_IP_URL", &service.url)]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_key(APP_KEY, APP_SECRET).await.0, 200);
    let (_, connected) = client.connect(false).await;
    assert_eq!(connected["state"].as_str(), Some("connected"), "{connected}");
    client.get("/api/system/kiwoom").await;
    assert_eq!(service.requests().len(), 0, "{:?}", service.requests());
}

#[tokio::test]
async fn an_answer_that_is_not_an_address_fails_without_leaving_the_service_text() {
    let page = "<html>LEAKY-PAGE-4Z9</html>";
    let (env, fake, service) = (Env::new(), ScriptedTransport::new(), IpService::start(page).await);
    let server = env.spawn(&fake, &[("VALLY_PUBLIC_IP_URL", &service.url)]);
    let client = Client::of(&server).await;
    let (status, failed) = client.ip_check().await;
    assert!(status >= 500, "{status} {failed}");
    assert!(failed["error"]["message"].as_str().is_some_and(|m| m.contains("IP 주소가 아닙니다")), "{failed}");
    assert_eq!(service.requests().len(), 1);
    let logs = server.stop().await;
    assert!(!failed.to_string().contains("LEAKY-PAGE") && !logs.contains("LEAKY-PAGE"), "{failed}\n{logs}");
}

#[tokio::test]
async fn the_registered_ip_is_private_on_disk_and_survives_a_restart() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    assert!(client.get("/api/system/kiwoom").await.1["registeredIp"].is_null());
    let (status, saved) = client.put_registered_ip("203.0.113.7").await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["registeredIp"]["ip"].as_str(), Some("203.0.113.7"));
    let ip_path = env.list_path().with_file_name("kiwoom-ip.json");
    assert_eq!(mode(&ip_path), 0o600);
    assert_eq!(mode(ip_path.parent().unwrap()), 0o700);
    let at = saved["registeredIp"]["at"].as_i64().unwrap();
    assert_eq!(client.put_registered_ip("not an ip").await.0, 400);
    assert_eq!(client.put_registered_ip("").await.0, 400);
    server.stop().await;

    let restarted = env.spawn(&fake, &[]);
    let client = Client::of(&restarted).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["registeredIp"]["ip"].as_str(), status["registeredIp"]["at"].as_i64()), (Some("203.0.113.7"), Some(at)), "{status}");
    assert_eq!(fake.requests(), 0);
}

#[tokio::test]
async fn ip_routes_go_through_the_same_write_checks() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    for (method, path, body) in [(reqwest::Method::POST, "/api/system/kiwoom/ip-check", None), (reqwest::Method::PUT, "/api/system/kiwoom/registered-ip", Some(json!({"ip": "203.0.113.7"})))] {
        let request = |content_type: Option<&str>, host: Option<&str>, origin: Option<&str>| {
            let mut builder = client.http.request(method.clone(), format!("{}{path}", client.base));
            if let Some(content_type) = content_type { builder = builder.header("content-type", content_type); }
            if let Some(host) = host { builder = builder.header("host", host); }
            if let Some(origin) = origin { builder = builder.header("origin", origin); }
            builder.body(body.clone().map(|b| b.to_string()).unwrap_or_default())
        };
        for (label, wrong) in [("Content-Type", request(Some("text/plain"), None, None)), ("Host", request(Some("application/json"), Some("evil.example"), None)), ("Origin", request(Some("application/json"), None, Some("http://evil.example")))] {
            assert_eq!(answer(wrong.send().await.unwrap()).await.0, 400, "{path} {label}");
        }
    }
    assert!(client.get("/api/system/kiwoom").await.1["registeredIp"].is_null(), "거절된 요청은 아무것도 쓰지 않는다");
    assert!(!env.list_path().with_file_name("kiwoom-ip.json").exists());
}

const TAILNET_NAME: &str = "server.example-tailnet.ts.net";

fn refused_by_the_guard(status: u16, body: &Value) -> bool {
    status == 400 && body["error"]["message"].as_str().is_some_and(|message| message.starts_with("이 요청은 받지 않습니다"))
}

#[tokio::test]
async fn without_a_tailnet_name_the_tailnet_host_is_refused_like_any_foreign_host() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[]);
    let client = Client::of(&server).await;
    for host in [TAILNET_NAME, "other.example-tailnet.ts.net"] {
        let (status, body) = answer(client.put_request(APP_KEY, APP_SECRET).header("host", host).header("origin", format!("https://{host}")).send().await.unwrap()).await;
        assert!(refused_by_the_guard(status, &body), "{host}: {status} {body}");
        let (status, body) = answer(client.http.get(format!("{}/api/trading/account-number", client.base)).header("host", host).send().await.unwrap()).await;
        assert!(refused_by_the_guard(status, &body), "{host}: {status} {body}");
    }
    assert!(!env.list_path().exists(), "거절된 쓰기는 키 파일을 만들지 않는다");
}

#[tokio::test]
async fn a_configured_tailnet_name_is_accepted_as_host_with_a_matching_https_origin_and_nothing_else_is() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[("VALLY_TAILNET_HOSTS", " Server.Example-Tailnet.ts.net ,phone.example-tailnet.ts.net")]);
    let client = Client::of(&server).await;

    let wrong_origins = [format!("http://{TAILNET_NAME}"), format!("https://{TAILNET_NAME}:443"), "https://other.example-tailnet.ts.net".to_owned(), "https://phone.example-tailnet.ts.net".to_owned(), format!("http://127.0.0.1:{}", client.port)];
    for origin in &wrong_origins {
        let (status, body) = answer(client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("host", TAILNET_NAME).header("origin", origin).send().await.unwrap()).await;
        assert!(refused_by_the_guard(status, &body), "{origin}: {status} {body}");
    }
    let two_origins = client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("host", TAILNET_NAME).header("origin", format!("https://{TAILNET_NAME}")).header("origin", format!("https://{TAILNET_NAME}"));
    let (status, body) = answer(two_origins.send().await.unwrap()).await;
    assert!(refused_by_the_guard(status, &body), "Origin이 둘이면 거절한다: {status} {body}");
    for host in ["other.example-tailnet.ts.net", "evil.ts.net", "192.168.0.10:8080", "100.64.0.1:8080", "203.0.113.5", &format!("{TAILNET_NAME}:443"), &format!("{TAILNET_NAME}.")] {
        let write = answer(client.put_request(OTHER_APP_KEY, OTHER_APP_SECRET).header("host", host).send().await.unwrap()).await;
        assert!(refused_by_the_guard(write.0, &write.1), "{host}: {} {}", write.0, write.1);
        let read = answer(client.http.get(format!("{}/api/trading/account-number", client.base)).header("host", host).send().await.unwrap()).await;
        assert!(refused_by_the_guard(read.0, &read.1), "{host}: {} {}", read.0, read.1);
    }
    assert!(!env.list_path().exists(), "거절된 쓰기는 키 파일을 만들지 않는다");

    for origin in [None, Some(format!("https://{TAILNET_NAME}")), Some(format!("HTTPS://{}", TAILNET_NAME.to_uppercase()))] {
        let mut request = client.put_request(APP_KEY, APP_SECRET).header("host", TAILNET_NAME);
        if let Some(origin) = &origin {
            request = request.header("origin", origin);
        }
        let (status, body) = answer(request.send().await.unwrap()).await;
        assert_eq!(status, 200, "{origin:?}: {body}");
    }
    let upper_host = client.put_request(APP_KEY, APP_SECRET).header("host", TAILNET_NAME.to_uppercase()).header("origin", format!("https://{TAILNET_NAME}"));
    assert_eq!(upper_host.send().await.unwrap().status().as_u16(), 200, "Host는 대소문자를 가리지 않는다");
    let (status, body) = answer(client.http.get(format!("{}/api/trading/account-number", client.base)).header("host", TAILNET_NAME).send().await.unwrap()).await;
    assert!(!refused_by_the_guard(status, &body), "계좌번호 조회가 Host로 거절됐다: {status} {body}");
    let phone = answer(client.put_request(APP_KEY, APP_SECRET).header("host", "phone.example-tailnet.ts.net").header("origin", "https://phone.example-tailnet.ts.net").send().await.unwrap()).await;
    assert_eq!(phone.0, 200, "여러 이름을 설정하면 각자 받는다: {}", phone.1);
}

#[tokio::test]
async fn loopback_host_and_origin_keep_working_when_a_tailnet_name_is_configured() {
    let (env, fake) = (Env::new(), ScriptedTransport::new());
    let server = env.spawn(&fake, &[("VALLY_TAILNET_HOSTS", TAILNET_NAME)]);
    let client = Client::of(&server).await;
    let same_origin = client.put_request(APP_KEY, APP_SECRET).header("origin", format!("http://127.0.0.1:{}", client.port));
    assert_eq!(same_origin.send().await.unwrap().status().as_u16(), 200);
    let localhost = client.put_request(APP_KEY, APP_SECRET).header("host", format!("localhost:{}", client.port)).header("origin", format!("http://localhost:{}", client.port));
    assert_eq!(localhost.send().await.unwrap().status().as_u16(), 200);
    let https_origin_on_loopback = client.put_request(APP_KEY, APP_SECRET).header("origin", format!("https://{TAILNET_NAME}"));
    let (status, body) = answer(https_origin_on_loopback.send().await.unwrap()).await;
    assert!(refused_by_the_guard(status, &body), "루프백 Host에는 tailnet Origin을 받지 않는다: {status} {body}");
    let (status, body) = answer(client.http.get(format!("{}/api/trading/account-number", client.base)).send().await.unwrap()).await;
    assert!(!refused_by_the_guard(status, &body), "{status} {body}");
}
