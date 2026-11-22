mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::support::{ScriptedReply, token_for};
use common::{ScriptedTransport, Server};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

const OFF: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "off");
const START: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "start");
const NO_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");
const FIRST_KEY: &str = "FAKE-APPKEY-keys-first-4D7Q";
const FIRST_SECRET: &str = "FAKE-SECRET-keys-first-8W2L";
const SECOND_KEY: &str = "FAKE-APPKEY-keys-second-6B3N";
const SECOND_SECRET: &str = "FAKE-SECRET-keys-second-1H9V";
const ENV_KEY: &str = "FAKE-APPKEY-keys-env-5K0R";
const EIGHT_FIFTY: &str = "인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]";

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
        let mut pairs = vec![NO_KEY, ("VALLY_KIWOOM_KEY_PATH", key_path)];
        pairs.extend_from_slice(extra);
        let overrides: Vec<(&str, &std::ffi::OsStr)> = pairs.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))).collect();
        Server::spawn_with(fake, &self.lock, &self.dist, &overrides)
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

    async fn get(&self, path: &str) -> (u16, Value) {
        answer(self.http.get(format!("{}{path}", self.base)).send().await.unwrap()).await
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let request = self.http.request(method, format!("{}{path}", self.base)).header("content-type", "application/json");
        let request = match body {
            Some(body) => request.body(body.to_string()),
            None => request,
        };
        answer(request.send().await.unwrap()).await
    }

    async fn put_market_credentials(&self, key: &str, secret: &str) -> (u16, Value) {
        self.send(reqwest::Method::PUT, "/api/system/kiwoom/key", Some(json!({"appKey": key, "appSecret": secret}))).await
    }

    async fn add(&self, alias: &str, key: &str, secret: &str) -> (u16, Value) {
        self.send(reqwest::Method::POST, "/api/system/kiwoom/keys", Some(json!({"alias": alias, "appKey": key, "appSecret": secret}))).await
    }

    async fn designate(&self, id: &str) -> (u16, Value) {
        self.send(reqwest::Method::PUT, "/api/system/kiwoom/market-key", Some(json!({"keyId": id}))).await
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

async fn answer(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
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

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[derive(Clone, Debug)]
struct Frame {
    connection: usize,
    token: String,
    body: Value,
}

struct Peer {
    url: String,
    seen: Arc<Mutex<Vec<Frame>>>,
}

impl Peer {
    async fn start() -> Peer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<Frame>>> = Arc::default();
        let record = seen.clone();
        tokio::spawn(async move {
            for connection in 0.. {
                let (tcp, _) = listener.accept().await.unwrap();
                let record = record.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(tcp).await else { return };
                    let mut token = String::new();
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let body: Value = serde_json::from_str(text.as_str()).unwrap();
                        let trnm = body["trnm"].as_str().unwrap().to_owned();
                        if trnm == "LOGIN" {
                            token = body["token"].as_str().unwrap().to_owned();
                        }
                        if trnm == "PING" {
                            let _ = socket.send(Message::Text(text)).await;
                            continue;
                        }
                        record.lock().unwrap().push(Frame { connection, token: token.clone(), body });
                        let ack = json!({"trnm": trnm, "return_code": 0, "return_msg": ""});
                        if socket.send(Message::Text(ack.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Peer { url, seen }
    }

    fn frames(&self, trnm: &str) -> Vec<Frame> {
        self.seen.lock().unwrap().iter().filter(|frame| frame.body["trnm"] == trnm).cloned().collect()
    }

    fn registered_tokens(&self) -> Vec<String> {
        self.frames("REG").into_iter().map(|frame| frame.token).collect()
    }
}

async fn subscribe_to_samsung(addr: std::net::SocketAddr) -> impl Sized {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws")).await.unwrap();
    ws.send(Message::Text(r#"{"type":"subscribe","sub":"c0","symbol":"005930","venue":null,"period":"D"}"#.into())).await.unwrap();
    ws
}

#[tokio::test]
async fn two_keys_each_get_their_own_token_and_only_the_market_key_session_gets_market_subscriptions() {
    let peer = Peer::start().await;
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF, ("VALLY_KIWOOM_WS_URL", &peer.url)]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    client.until_key_state("k1", "connected").await;
    let (status, list) = client.add("선물", SECOND_KEY, SECOND_SECRET).await;
    assert_eq!(status, 200, "{list}");
    client.until_key_state("k2", "connected").await;

    let issued: Vec<String> = fake.calls().into_iter().filter(|call| call.api_id == "au10001").map(|call| call.body["appkey"].as_str().unwrap().to_owned()).collect();
    assert_eq!(issued.len(), 2, "발급 요청은 키마다 하나다: {issued:?}");
    assert!(issued.contains(&FIRST_KEY.to_owned()) && issued.contains(&SECOND_KEY.to_owned()));

    let (first_token, second_token) = (token_for(FIRST_KEY), token_for(SECOND_KEY));
    until("두 키의 세션 LOGIN", || async {
        let tokens: Vec<String> = peer.frames("LOGIN").into_iter().map(|frame| frame.token).collect();
        (tokens.contains(&first_token) && tokens.contains(&second_token)).then_some(())
    })
    .await;

    let _browser = subscribe_to_samsung(server.addr().await).await;
    until("시세 키 세션의 REG", || async { (!peer.registered_tokens().is_empty()).then_some(()) }).await;
    assert!(peer.registered_tokens().iter().all(|token| *token == first_token), "시세 구독은 시세 키 세션에만 간다: {:?}", peer.registered_tokens());

    let (status, list) = client.designate("k2").await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(client.key("k2").await["market"], true);
    assert_eq!(client.key("k1").await["market"], false);
    until("새 시세 키 세션의 REG", || async { peer.registered_tokens().contains(&second_token).then_some(()) }).await;
    client.until_key_state("k1", "connected").await;
    client.until_key_state("k2", "connected").await;
    let old_key_session = until("옛 시세 키의 새 세션", || async { peer.frames("LOGIN").into_iter().filter(|frame| frame.token == first_token).map(|frame| frame.connection).max().filter(|connection| *connection > 1) }).await;
    assert!(peer.frames("REG").iter().all(|frame| frame.connection != old_key_session), "옛 시세 키의 세션에는 시세 구독이 없다");
    let issued_after = fake.calls().into_iter().filter(|call| call.api_id == "au10001").count();
    assert_eq!(issued_after, 2, "시세 키를 바꿔도 토큰을 다시 받지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn a_key_blocked_by_8050_leaves_the_others_connected_and_stays_blocked_after_a_restart() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    client.until_key_state("k1", "connected").await;
    fake.script("au10001", vec![ScriptedReply { status: 200, body: json!({"return_code": 3, "return_msg": EIGHT_FIFTY}), delay: Duration::ZERO }]);
    assert_eq!(client.add("막힌 키", SECOND_KEY, SECOND_SECRET).await.0, 200);
    let blocked = client.until_key_state("k2", "failed").await;
    assert_eq!(blocked["link"]["problem"], "authBlocked8050", "{blocked}");
    assert_eq!(client.key("k1").await["link"]["state"], "connected", "한 키의 8050이 다른 키를 멈추지 않는다");
    server.stop().await;

    let restarted_fake = ScriptedTransport::new();
    let restarted = env.spawn(&restarted_fake, &[START]);
    let client = Client::of(&restarted).await;
    client.until_key_state("k1", "connected").await;
    let blocked = client.until_key_state("k2", "failed").await;
    assert_eq!(blocked["link"]["problem"], "authBlocked8050", "{blocked}");
    assert!(restarted_fake.api_ids().iter().all(|id| id != "au10001"), "막힌 키는 다시 켜도 발급을 보내지 않고, 받아 둔 토큰이 있는 키도 새로 받지 않는다: {:?}", restarted_fake.api_ids());
    restarted.stop().await;
}

#[tokio::test]
async fn invalid_additions_are_refused_with_a_message_and_leave_the_file_unchanged() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    for number in 2..=5 {
        let (status, body) = client.add(&format!("키 {number}"), &format!("FAKE-APPKEY-keys-extra-{number}"), "FAKE-SECRET-keys-extra").await;
        assert_eq!(status, 200, "{body}");
    }
    assert_eq!(client.keys().await.len(), 5);
    let saved = std::fs::read(env.list_path()).unwrap();
    let refused = [
        ("여섯째 키", client.add("여섯째", SECOND_KEY, SECOND_SECRET).await, "5개"),
        ("이미 있는 앱키", client.add("복사", "FAKE-APPKEY-keys-extra-3", "다른 시크릿").await, "이미 등록한 앱키"),
        ("빈 별칭", client.add("  ", SECOND_KEY, SECOND_SECRET).await, "별칭이 비어"),
        ("긴 별칭", client.add(&"가".repeat(21), SECOND_KEY, SECOND_SECRET).await, "20자"),
    ];
    for (name, (status, body), message) in refused {
        assert_eq!(status, 400, "{name}: {body}");
        assert!(body["error"]["message"].as_str().unwrap().contains(message), "{name}: {body}");
        assert_eq!(std::fs::read(env.list_path()).unwrap(), saved, "{name}: 파일이 바뀌지 않는다");
    }
    let removed = client.send(reqwest::Method::DELETE, "/api/system/kiwoom/keys/k5", None).await;
    assert_eq!(removed.0, 200, "{}", removed.1);
    let (status, body) = client.add("   ", SECOND_KEY, SECOND_SECRET).await;
    assert_eq!(status, 400, "{body}");
    let (status, body) = client.add("뒤 키", "FAKE-APPKEY-keys-extra-2", SECOND_SECRET).await;
    assert_eq!(status, 400, "다섯 개 밑에서도 같은 앱키는 거절한다: {body}");
    server.stop().await;
}

#[tokio::test]
async fn the_key_list_never_shows_secrets_or_whole_app_keys_and_the_file_is_private() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    let (_, put) = client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await;
    let (_, added) = client.add("보조", SECOND_KEY, SECOND_SECRET).await;
    let (_, listed) = client.get("/api/system/kiwoom/keys").await;
    let (_, single) = client.get("/api/system/kiwoom").await;
    for text in [put.to_string(), added.to_string(), listed.to_string(), single.to_string()] {
        for secret in [FIRST_KEY, FIRST_SECRET, SECOND_KEY, SECOND_SECRET] {
            assert!(!text.contains(secret), "응답에 {secret}이 있다: {text}");
        }
    }
    let first = &listed["keys"][0];
    assert_eq!((first["keyId"].as_str(), first["alias"].as_str(), first["broker"].as_str(), first["source"].as_str(), first["market"].as_bool()), (Some("k1"), Some("키 1"), Some("kiwoom"), Some("file"), Some(true)));
    assert_eq!(first["appKeyTail"].as_str(), Some(&FIRST_KEY[FIRST_KEY.len() - 4..]));
    assert_eq!(listed["limit"], 5);
    assert_eq!(mode(&env.list_path()), 0o600);
    assert_eq!(mode(env.list_path().parent().unwrap()), 0o700);
    let logs = server.stop().await;
    for secret in [FIRST_KEY, FIRST_SECRET, SECOND_KEY, SECOND_SECRET] {
        assert!(!logs.contains(secret), "로그에 {secret}이 있다");
    }
}

#[tokio::test]
async fn an_old_single_key_file_becomes_key_one_and_is_removed() {
    let env = Env::new();
    std::fs::create_dir_all(env.key_path.parent().unwrap()).unwrap();
    std::fs::set_permissions(env.key_path.parent().unwrap(), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(&env.key_path, json!({"appKey": FIRST_KEY, "appSecret": FIRST_SECRET}).to_string()).unwrap();
    std::fs::set_permissions(&env.key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let fake = ScriptedTransport::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    let keys = client.keys().await;
    assert_eq!(keys.len(), 1);
    assert_eq!((keys[0]["keyId"].as_str(), keys[0]["alias"].as_str(), keys[0]["market"].as_bool()), (Some("k1"), Some("키 1"), Some(true)));
    assert!(!env.key_path.exists(), "옮긴 뒤 옛 파일은 지운다");
    assert_eq!(mode(&env.list_path()), 0o600);
    server.stop().await;

    let restarted = env.spawn(&ScriptedTransport::new(), &[OFF]);
    assert_eq!(Client::of(&restarted).await.keys().await.len(), 1, "옮긴 목록을 다시 켠 서버가 읽는다");
    restarted.stop().await;
}

#[tokio::test]
async fn a_failed_move_keeps_the_old_file_and_reports_the_key_file_problem() {
    let env = Env::new();
    std::fs::create_dir_all(env.list_path()).unwrap();
    std::fs::create_dir_all(env.key_path.parent().unwrap()).unwrap();
    std::fs::set_permissions(env.key_path.parent().unwrap(), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(&env.key_path, json!({"appKey": FIRST_KEY, "appSecret": FIRST_SECRET}).to_string()).unwrap();
    std::fs::set_permissions(&env.key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let server = env.spawn(&ScriptedTransport::new(), &[OFF]);
    let client = Client::of(&server).await;
    let (_, status) = client.get("/api/system/kiwoom").await;
    assert_eq!((status["state"].as_str(), status["problem"].as_str()), (Some("failed"), Some("keyFileUnusable")), "{status}");
    assert!(env.key_path.exists(), "옮기지 못했으면 옛 파일이 남는다");
    server.stop().await;
}

#[tokio::test]
async fn the_environment_key_leads_the_list_is_read_only_and_other_keys_can_still_be_added() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF, ("VALLY_KIWOOM_APP_KEY", ENV_KEY), ("VALLY_KIWOOM_APP_SECRET", "FAKE-SECRET-keys-env")]);
    let client = Client::of(&server).await;
    let keys = client.keys().await;
    assert_eq!((keys[0]["keyId"].as_str(), keys[0]["source"].as_str(), keys[0]["market"].as_bool()), (Some("env"), Some("env"), Some(true)));
    assert_eq!(client.add("파일 키", FIRST_KEY, FIRST_SECRET).await.0, 200);
    assert_eq!(client.add("같은 키", ENV_KEY, FIRST_SECRET).await.0, 400, "환경 키와 같은 앱키도 거절한다");
    assert_eq!(client.put_market_credentials(SECOND_KEY, SECOND_SECRET).await.0, 409, "시세 키가 환경 키면 화면에서 바꿀 수 없다");
    assert_eq!(client.send(reqwest::Method::PUT, "/api/system/kiwoom/keys/env/alias", Some(json!({"alias": "바꿈"}))).await.0, 409);
    assert_eq!(client.send(reqwest::Method::DELETE, "/api/system/kiwoom/keys/env", None).await.0, 409);
    assert_eq!(client.designate("k1").await.0, 200);
    assert_eq!(client.put_market_credentials(SECOND_KEY, SECOND_SECRET).await.0, 200, "시세 키가 파일 키면 단일 키 경로가 그 키를 바꾼다");
    assert_eq!(client.key("k1").await["appKeyTail"].as_str(), Some(&SECOND_KEY[SECOND_KEY.len() - 4..]));
    assert_eq!(client.key("env").await["market"], false);
    server.stop().await;
}

#[tokio::test]
async fn renaming_and_deleting_keys_and_handing_the_market_to_the_next_key() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    assert_eq!(client.add("둘째", SECOND_KEY, SECOND_SECRET).await.0, 200);
    let (status, list) = client.send(reqwest::Method::PUT, "/api/system/kiwoom/keys/k2/alias", Some(json!({"alias": "새 별칭"}))).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(client.key("k2").await["alias"], "새 별칭");
    assert_eq!(client.send(reqwest::Method::PUT, "/api/system/kiwoom/keys/k9/alias", Some(json!({"alias": "없는 키"}))).await.0, 404);
    let (status, list) = client.send(reqwest::Method::DELETE, "/api/system/kiwoom/keys/k1", None).await;
    assert_eq!(status, 200, "{list}");
    let keys = client.keys().await;
    assert_eq!(keys.len(), 1);
    assert_eq!((keys[0]["keyId"].as_str(), keys[0]["market"].as_bool()), (Some("k2"), Some(true)), "시세 키를 지우면 남은 첫 키가 시세 키가 된다");
    let (_, single) = client.get("/api/system/kiwoom").await;
    assert_eq!(single["appKeyTail"].as_str(), Some(&SECOND_KEY[SECOND_KEY.len() - 4..]));
    let (status, _) = client.send(reqwest::Method::DELETE, "/api/system/kiwoom/key", None).await;
    assert_eq!(status, 200);
    assert!(client.keys().await.is_empty());
    assert!(!env.list_path().exists(), "키가 하나도 없으면 목록 파일을 지운다");
    server.stop().await;
}

fn issued_for(fake: &ScriptedTransport, app_key: &str) -> usize {
    fake.calls().into_iter().filter(|call| call.api_id == "au10001" && call.body["appkey"] == app_key).count()
}

#[tokio::test]
async fn adding_an_environment_key_later_keeps_the_blocked_file_key_blocked() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    fake.script("au10001", vec![ScriptedReply { status: 200, body: json!({"return_code": 3, "return_msg": EIGHT_FIFTY}), delay: Duration::ZERO }]);
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    client.until_key_state("k1", "failed").await;
    server.stop().await;

    let restarted_fake = ScriptedTransport::new();
    let restarted = env.spawn(&restarted_fake, &[START, ("VALLY_KIWOOM_APP_KEY", ENV_KEY), ("VALLY_KIWOOM_APP_SECRET", "FAKE-SECRET-keys-env")]);
    let client = Client::of(&restarted).await;
    let blocked = client.until_key_state("k1", "failed").await;
    assert_eq!(blocked["link"]["problem"], "authBlocked8050", "{blocked}");
    client.until_key_state("env", "connected").await;
    assert_eq!(issued_for(&restarted_fake, FIRST_KEY), 0, "환경 키가 생겨도 막힌 키는 발급을 보내지 않는다");
    restarted.stop().await;
}

#[tokio::test]
async fn removing_a_blocked_key_and_adding_the_same_app_key_back_keeps_it_blocked() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    client.until_key_state("k1", "connected").await;
    fake.script("au10001", vec![ScriptedReply { status: 200, body: json!({"return_code": 3, "return_msg": EIGHT_FIFTY}), delay: Duration::ZERO }]);
    assert_eq!(client.add("막힌 키", SECOND_KEY, SECOND_SECRET).await.0, 200);
    client.until_key_state("k2", "failed").await;
    assert_eq!(client.send(reqwest::Method::DELETE, "/api/system/kiwoom/keys/k2", None).await.0, 200);
    assert_eq!(client.add("다시 넣은 키", SECOND_KEY, SECOND_SECRET).await.0, 200);
    let readded = client.until_key_state("k2", "failed").await;
    assert_eq!(readded["link"]["problem"], "authBlocked8050", "{readded}");
    assert_eq!(issued_for(&fake, SECOND_KEY), 1, "지웠다 다시 넣어도 같은 앱키는 막힌 채다");
    server.stop().await;
}

#[tokio::test]
async fn a_token_request_in_flight_when_the_market_key_changes_is_not_credited_to_the_other_key() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    client.until_key_state("k1", "connected").await;
    fake.script("au10001", vec![ScriptedReply { status: 200, body: json!({"return_code": 3, "return_msg": EIGHT_FIFTY}), delay: Duration::from_millis(800) }]);
    assert_eq!(client.add("둘째", SECOND_KEY, SECOND_SECRET).await.0, 200);
    until("둘째 키의 발급 요청", || async { (issued_for(&fake, SECOND_KEY) == 1).then_some(()) }).await;
    assert_eq!(client.designate("k2").await.0, 200);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let first = client.key("k1").await;
    assert_ne!(first["link"]["problem"], "authBlocked8050", "k1은 그 요청을 보내지 않았다: {first}");
    assert_eq!(issued_for(&fake, FIRST_KEY), 1, "k1은 토큰을 다시 받지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn a_token_received_while_the_market_key_changes_is_not_saved_in_the_other_keys_file() {
    let fake = ScriptedTransport::new();
    let env = Env::new();
    let server = env.spawn(&fake, &[OFF]);
    let client = Client::of(&server).await;
    assert_eq!(client.put_market_credentials(FIRST_KEY, FIRST_SECRET).await.0, 200);
    client.until_key_state("k1", "connected").await;
    fake.delay("au10001", Duration::from_millis(800));
    assert_eq!(client.add("둘째", SECOND_KEY, SECOND_SECRET).await.0, 200);
    until("둘째 키의 발급 요청", || async { (issued_for(&fake, SECOND_KEY) == 1).then_some(()) }).await;
    assert_eq!(client.designate("k2").await.0, 200);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let first_file = std::fs::read_to_string(env.lock.parent().unwrap().join("token.json")).unwrap();
    assert!(!first_file.contains(&token_for(SECOND_KEY)), "k1의 토큰 파일에 k2의 토큰이 들어갔다");
    server.stop().await;
}
