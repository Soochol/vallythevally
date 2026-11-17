
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use common::{APP_KEY, ScriptedTransport, Server, token_path};
use serde_json::{Value, json};
use server::config::Secret;
use server::kiwoom::link::{ConnectStep, LinkFailure, LinkState, Problem};
use server::kiwoom::token_file::credential_id;

const OFF: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "off");
const START: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "start");
const AT_TEN: &str = "20261109100000";
const AT_TEN_TWENTY: &str = "20261109102000";
const NO_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");

fn static_dir(root: &Path) -> PathBuf {
    let dir = root.join("dist");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();
    dir
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

async fn get(base: &str, path: &str) -> (u16, Value) {
    let resp = reqwest::get(format!("{base}{path}")).await.unwrap();
    let status = resp.status().as_u16();
    (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap_or(Value::Null))
}

fn write_private(path: &Path, contents: &[u8]) {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).unwrap();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(path, contents).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn unix_of(kst: &str) -> i64 {
    server::kiwoom::wire::parse_kst_datetime(kst).unwrap().unix()
}

fn token_file_of(env: &Env) -> Value {
    serde_json::from_str(&std::fs::read_to_string(token_path(&env.lock)).unwrap()).unwrap()
}

fn is_connected(state: &LinkState) -> bool {
    *state == LinkState::Connected
}

fn is_issue_interval_wait(state: &LinkState) -> bool {
    matches!(state, LinkState::Connecting(ConnectStep::IssueInterval(_)))
}

fn is_failed(state: &LinkState) -> bool {
    matches!(state, LinkState::Failed(_))
}

fn failure(state: LinkState) -> LinkFailure {
    match state {
        LinkState::Failed(failure) => failure,
        other => panic!("연결 실패가 아니다: {other:?}"),
    }
}

fn overrides<'a>(pairs: &'a [(&'a str, &'a str)]) -> Vec<(&'a str, &'a std::ffi::OsStr)> {
    pairs.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))).collect()
}

struct Env {
    _tmp: tempfile::TempDir,
    lock: PathBuf,
    dist: PathBuf,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let dist = static_dir(tmp.path());
    Env { _tmp: tmp, lock, dist }
}

fn spawn(fake: &ScriptedTransport, env: &Env, pairs: &[(&str, &str)]) -> Server {
    Server::spawn_with(fake, &env.lock, &env.dist, &overrides(pairs))
}

struct CountedSocket {
    url: String,
    accepts: Arc<AtomicUsize>,
}

async fn counted_socket() -> CountedSocket {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/dostk/websocket", listener.local_addr().unwrap());
    let accepts = Arc::new(AtomicUsize::new(0));
    let counter = accepts.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            drop(stream);
        }
    });
    CountedSocket { url, accepts }
}

const EIGHT_FIFTY: &str = "인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]";
const KEY_REJECTED: &str = "인증에 실패했습니다[8001:App Key와 Secret Key 검증에 실패했습니다]";

fn reject_issue(fake: &ScriptedTransport, message: &str) {
    fake.respond_with("au10001", 200, json!({"return_code": 3, "return_msg": message}));
}

#[tokio::test]
async fn a_server_without_keys_starts_and_sends_nothing_across_the_daily_times() {
    let socket = counted_socket().await;
    for start in ["20261109200458", "20261109074458"] {
        let fake = ScriptedTransport::new();
        let env = env();
        let server = spawn(&fake, &env, &[OFF, NO_KEY, ("VALLY_CLOCK_START", start), ("VALLY_KIWOOM_WS_URL", socket.url.as_str())]);
        server.addr().await;
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert_eq!(server.link_state(), LinkState::NoKey, "{start}");
        assert_eq!(fake.requests(), 0, "{start}: {:?}", fake.api_ids());
        assert_eq!(socket.accepts.load(Ordering::SeqCst), 0, "{start}: WebSocket에 접속하지 않는다");
        server.stop().await;
    }
}

#[tokio::test]
async fn starting_with_a_key_sends_nothing_until_asked_and_then_opens_the_realtime_session() {
    let socket = counted_socket().await;
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109200458"), ("VALLY_KIWOOM_WS_URL", socket.url.as_str())]);
    let base = format!("http://{}", server.addr().await);
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(server.link_state(), LinkState::Disconnected);
    assert_eq!(fake.requests(), 0, "켜기만 하면 요청 0건이다: {:?}", fake.api_ids());
    assert_eq!(socket.accepts.load(Ordering::SeqCst), 0, "켜기만 하면 WebSocket 접속 0회다");

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", base.trim_start_matches("http://"))).await.unwrap();
    let saw_not_connected = tokio::time::timeout(Duration::from_secs(5), async {
        use futures::StreamExt;
        while let Some(Ok(message)) = ws.next().await {
            if message.to_text().unwrap_or_default().contains(r#""realtime":"notConnected""#) {
                return;
            }
        }
        panic!("연결이 닫혔다");
    });
    saw_not_connected.await.expect("연결 전 실시간 상태는 notConnected다");
    drop(ws);

    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.issued(), 1);
    let mut accepted = 0;
    for _ in 0..50 {
        accepted = socket.accepts.load(Ordering::SeqCst);
        if accepted > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(accepted > 0, "연결한 뒤에는 WebSocket에 접속한다");
    server.stop().await;
}

#[tokio::test]
async fn many_connects_at_once_issue_one_token() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    let states = futures::future::join_all((0..8).map(|_| server.connect(false))).await;
    assert!(states.iter().all(|state| *state == LinkState::Connected), "{states:?}");
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn a_valid_saved_token_for_the_same_app_key_means_connect_issues_nothing() {
    let fake = ScriptedTransport::new();
    let env = env();
    let at = now_unix() - 3600;
    write_private(&token_path(&env.lock), json!({"credential": credential_id(APP_KEY), "token": {"value": "saved-token", "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.issued(), 0, "{:?}", fake.api_ids());
    assert!(fake.seen.authorizations.lock().unwrap().iter().all(|auth| auth == "Bearer saved-token"));
    server.stop().await;
}

#[tokio::test]
async fn inside_the_issue_interval_connect_waits_without_issuing_and_says_until_when() {
    let fake = ScriptedTransport::new();
    let env = env();
    let last_request = now_unix() - 60;
    write_private(&token_path(&env.lock), json!({"token": null, "last_request_at": last_request}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    let waiting = server.connect_until_waiting(false).await;
    let LinkState::Connecting(ConnectStep::IssueInterval(until)) = waiting else { panic!("발급 간격 대기여야 한다: {waiting:?}") };
    assert_eq!(until.unix(), last_request + 600);
    assert_eq!(fake.requests(), 0, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn after_8050_connect_needs_the_acknowledgement_and_the_issue_interval() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000")]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.issued(), 1);

    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050, "확인 없이는 거절된다");
    assert_eq!(fake.requests(), 1, "{:?}", fake.api_ids());

    let waiting = failure(server.connect(true).await);
    assert_eq!(waiting.problem, Problem::IssueIntervalWait, "{}", waiting.message);
    assert!(waiting.retry_at.is_some());
    assert_eq!(fake.requests(), 1, "확인을 해도 발급 간격 안에서는 요청이 없다: {:?}", fake.api_ids());
    assert!(server.link().needs_acknowledgement(), "간격 대기 중에도 확인은 소비되지 않는다");
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.requests(), 1);

    fake.reset();
    server.clock().jump(601);
    assert_eq!(server.connect(true).await, LinkState::Connected);
    assert_eq!(fake.issued(), 2, "발급 간격 뒤에 한 번만 보낸다: {:?}", fake.api_ids());
    assert!(!server.link().needs_acknowledgement());
    server.stop().await;
}

#[tokio::test]
async fn a_key_replacement_clears_a_key_block_but_keeps_the_issue_interval() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, KEY_REJECTED);
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000")]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::KeyNeedsCheck);
    assert_eq!(failure(server.connect(true).await).problem, Problem::KeyNeedsCheck, "확인 체크는 키 문제를 풀지 못한다");
    assert_eq!(fake.issued(), 1);

    let state = server.link().replace_key(Secret::new("FAKE-new-key".into()), Secret::new("FAKE-new-secret".into()));
    assert_eq!(state, LinkState::Disconnected);
    assert!(is_issue_interval_wait(&server.connect_until_waiting(false).await), "키를 바꿔도 마지막 발급 요청 시각은 지켜진다");
    assert_eq!(fake.issued(), 1);

    fake.reset();
    server.clock().jump(601);
    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.issued(), 2);
    assert_eq!(fake.seen.token_bodies.lock().unwrap().last().unwrap()["appkey"], "FAKE-new-key");
    server.stop().await;
}

#[tokio::test]
async fn a_key_replacement_does_not_clear_8050() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000")]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);

    let state = server.link().replace_key(Secret::new("FAKE-new-key".into()), Secret::new("FAKE-new-secret".into()));
    assert_eq!(failure(state).problem, Problem::AuthBlocked8050);
    server.clock().jump(601);
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050, "간격이 지나도 확인 없이는 거절된다");
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn clearing_the_key_empties_the_token_and_keeps_the_last_request_time() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    let before: Value = serde_json::from_str(&std::fs::read_to_string(token_path(&env.lock)).unwrap()).unwrap();
    assert!(before["token"].is_object());

    assert_eq!(server.link().clear_key(), LinkState::NoKey);
    let after: Value = serde_json::from_str(&std::fs::read_to_string(token_path(&env.lock)).unwrap()).unwrap();
    assert_eq!((after["token"].clone(), after["last_request_at"].clone()), (Value::Null, before["last_request_at"].clone()));
    server.stop().await;
}

#[tokio::test]
async fn disconnecting_closes_queries_and_connecting_again_reuses_the_saved_token() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    let base = format!("http://{}", server.addr().await);
    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(get(&base, "/api/symbols/005930").await.0, 200);

    server.link().disconnect();
    assert_eq!(server.link_state(), LinkState::Disconnected);
    let sent = fake.requests();
    let (status, body) = get(&base, "/api/bars?symbol=005930&period=D").await;
    assert_eq!((status, body["error"]["reason"].as_str()), (503, Some("not_connected")), "{body}");
    assert_eq!(fake.requests(), sent, "연결을 끊은 뒤에는 키움으로 아무것도 보내지 않는다");

    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.issued(), 1, "끊고 다시 연결해도 파일 토큰이 유효한 동안 발급은 늘지 않는다: {:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn a_bars_request_before_connecting_answers_not_connected() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    let base = format!("http://{}", server.addr().await);
    let (status, body) = get(&base, "/api/bars?symbol=005930&period=D").await;
    assert_eq!((status, body["error"]["code"].as_str(), body["error"]["reason"].as_str()), (503, Some("kiwoom_unavailable"), Some("not_connected")), "{body}");
    assert_eq!(fake.requests(), 0);
    server.stop().await;
}

#[tokio::test]
async fn rechecking_an_unreadable_token_file_clears_the_stop_without_asking_kiwoom() {
    let fake = ScriptedTransport::new();
    let env = env();
    let at = now_unix() - 3600;
    let path = token_path(&env.lock);
    write_private(&path, json!({"credential": credential_id(APP_KEY), "token": {"value": "saved-token", "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at}).to_string().as_bytes());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::TokenFileUnusable);
    assert_eq!(failure(server.link().recheck_token_file()).problem, Problem::TokenFileUnusable, "그대로면 풀리지 않는다");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(server.link().recheck_token_file(), LinkState::Disconnected);
    assert_eq!(fake.requests(), 0, "{:?}", fake.api_ids());
    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.issued(), 0, "다시 읽은 파일의 토큰을 쓴다");
    server.stop().await;
}

#[tokio::test]
async fn disconnecting_during_a_stream_backoff_opens_no_websocket() {
    let socket = counted_socket().await;
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_KIWOOM_WS_URL", socket.url.as_str())]);
    server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    for _ in 0..50 {
        if socket.accepts.load(Ordering::SeqCst) >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    server.link().disconnect();
    let at_disconnect = socket.accepts.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(socket.accepts.load(Ordering::SeqCst), at_disconnect, "끊은 뒤에는 다시 접속하지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn a_connect_after_a_disconnect_is_not_swallowed_by_the_abandoned_attempt() {
    let fake = ScriptedTransport::new();
    fake.delay("au10001", Duration::from_secs(2));
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", AT_TEN)]);
    server.addr().await;
    let abandoned = tokio::spawn({
        let link = server.link();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.link().disconnect();
    let second = server.connect_until_waiting(false).await;
    assert!(is_issue_interval_wait(&second), "{second:?}");
    abandoned.await.unwrap();
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    tokio::time::sleep(Duration::from_millis(2500)).await;
    server.clock().jump(601);
    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.issued(), 1, "먼저 받던 토큰이 파일에 남아 있다: {:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn a_token_issued_for_the_replaced_key_is_not_kept_for_the_new_key() {
    let fake = ScriptedTransport::new();
    fake.delay("au10001", Duration::from_secs(2));
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    let first = tokio::spawn({
        let link = server.link();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.link().replace_key(Secret::new("FAKE-APPKEY-other".into()), Secret::new("other-secret".into()));
    first.await.unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(token_path(&env.lock)).unwrap()).unwrap();
    assert!(saved["token"].is_null(), "옛 키로 받은 토큰이 새 키의 것으로 기록됐다: {saved}");
    server.stop().await;
}

#[tokio::test]
async fn a_disconnect_right_after_connect_starts_wins() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    let link = server.link();
    let connecting = link.connect(false);
    tokio::pin!(connecting);
    assert!(futures::poll!(connecting.as_mut()).is_pending());
    link.disconnect();
    connecting.await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(server.link_state(), LinkState::Disconnected);
    assert_eq!(fake.requests(), 0, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn a_disconnect_during_a_stream_backoff_reports_not_connected_at_once() {
    let socket = counted_socket().await;
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_KIWOOM_WS_URL", socket.url.as_str())]);
    let addr = server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    tokio::time::sleep(Duration::from_secs(6)).await;
    server.link().disconnect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws")).await.unwrap();
    let realtime = tokio::time::timeout(Duration::from_secs(2), async {
        use futures::StreamExt;
        while let Some(Ok(message)) = ws.next().await {
            let text = message.to_text().unwrap_or_default().to_owned();
            if let Some(at) = text.find(r#""realtime":""#) {
                return text[at..(at + 40).min(text.len())].to_owned();
            }
        }
        String::new()
    })
    .await
    .unwrap();
    assert!(realtime.contains("notConnected"), "{realtime}");
    server.stop().await;
}

async fn slow_upgrade_peer(hold: Duration) -> (String, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/dostk/websocket", listener.local_addr().unwrap());
    let tcp = Arc::new(AtomicUsize::new(0));
    let logins = Arc::new(AtomicUsize::new(0));
    let (tcp_count, login_count) = (tcp.clone(), logins.clone());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tcp_count.fetch_add(1, Ordering::SeqCst);
            let login_count = login_count.clone();
            tokio::spawn(async move {
                use futures::StreamExt;
                tokio::time::sleep(hold).await;
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { return };
                while let Some(Ok(message)) = socket.next().await {
                    if message.to_text().unwrap_or_default().contains("LOGIN") {
                        login_count.fetch_add(1, Ordering::SeqCst);
                    }
                }
            });
        }
    });
    (url, tcp, logins)
}

#[tokio::test]
async fn a_handshake_in_flight_at_disconnect_sends_no_login() {
    let (url, tcp, logins) = slow_upgrade_peer(Duration::from_millis(1500)).await;
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_KIWOOM_WS_URL", url.as_str())]);
    server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    for _ in 0..40 {
        if tcp.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(tcp.load(Ordering::SeqCst), 1);
    server.link().disconnect();
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_eq!(logins.load(Ordering::SeqCst), 0, "끊은 뒤에는 LOGIN을 보내지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn racing_connect_and_disconnect_on_threads_always_ends_disconnected() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("SERVER_RUNTIME_THREADS", "4")]);
    server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    server.link().disconnect();
    let mut stuck = Vec::new();
    for round in 0..600u64 {
        let link = server.link();
        let connecting = server.connect(false);
        tokio::pin!(connecting);
        let first = futures::poll!(connecting.as_mut());
        while !matches!(link.state(), LinkState::Connecting(_) | LinkState::Connected) {
            std::hint::spin_loop();
        }
        let spin = std::time::Instant::now();
        while spin.elapsed() < Duration::from_nanos((round % 40) * 5_000) {
            std::hint::spin_loop();
        }
        link.disconnect();
        if first.is_pending() {
            connecting.await;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
        if server.link_state() != LinkState::Disconnected {
            stuck.push((round, server.link_state()));
            server.link().disconnect();
        }
    }
    assert!(stuck.is_empty(), "{} {:?}", stuck.len(), &stuck[..stuck.len().min(5)]);
    server.stop().await;
}

#[tokio::test]
async fn an_acknowledged_connect_abandoned_before_its_request_keeps_the_8050_block() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000"), ("KIWOOM_SEND_SPACING_MILLIS", "3000")]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    server.clock().jump(601);
    let acknowledged = tokio::spawn({
        let link = server.link();
        async move { link.connect(true).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.link().disconnect();
    acknowledged.await.unwrap();
    assert!(server.link().needs_acknowledgement(), "요청이 나가기 전에 끊긴 확인은 8050 멈춤을 풀지 못한다");
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn an_acknowledged_connect_joining_an_unacknowledged_flight_is_not_swallowed() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000")]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    server.clock().jump(601);
    fake.reset();
    let link = server.link();
    let (_, acknowledged) = tokio::join!(link.connect(false), link.connect(true));
    assert_eq!(acknowledged, LinkState::Connected);
    assert_eq!(fake.issued(), 2, "처음 8050 거절 한 건과 확인한 연결의 발급 한 건: {:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn an_8050_at_the_daily_reissue_leaves_the_link_failed_and_closed() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109200458")]);
    server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    reject_issue(&fake, EIGHT_FIFTY);
    server.clock().jump(601);
    for _ in 0..60 {
        if fake.issued() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(fake.issued(), 2, "{:?}", fake.api_ids());
    assert_eq!(failure(server.link_state()).problem, Problem::AuthBlocked8050);
    let base = format!("http://{}", server.addr().await);
    assert_eq!(get(&base, "/api/bars?symbol=005930&period=D").await.1["error"]["reason"], "not_connected");
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    server.stop().await;
}

#[tokio::test]
async fn an_acknowledged_caller_joined_to_a_flight_does_not_reconnect_after_a_disconnect() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    assert_eq!(server.connect(false).await, LinkState::Connected);
    server.link().disconnect();
    fake.delay("ka10099", Duration::from_secs(2));
    let link = server.link();
    let plain = tokio::spawn({
        let link = link.clone();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let acknowledged = tokio::spawn({
        let link = link.clone();
        async move { link.connect(true).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    link.disconnect();
    plain.await.unwrap();
    let outcome = acknowledged.await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(server.link_state(), LinkState::Disconnected, "outcome {outcome:?} {:?}", fake.api_ids());
    server.stop().await;
}

async fn abandoned_acknowledged_connect(fake: &ScriptedTransport, env: &Env) -> Server {
    reject_issue(fake, EIGHT_FIFTY);
    let server = spawn(fake, env, &[OFF, ("VALLY_CLOCK_START", "20261109100000"), ("KIWOOM_SEND_SPACING_MILLIS", "3000")]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    server.clock().jump(601);
    let acknowledged = tokio::spawn({
        let link = server.link();
        async move { link.connect(true).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.link().disconnect();
    let plain = server.connect(false).await;
    assert_eq!(failure(plain).problem, Problem::AuthBlocked8050);
    acknowledged.await.unwrap();
    server
}

#[tokio::test]
async fn a_plain_connect_right_after_an_abandoned_acknowledged_one_sends_nothing() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = abandoned_acknowledged_connect(&fake, &env).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn the_state_after_an_abandoned_acknowledged_connect_still_shows_8050() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = abandoned_acknowledged_connect(&fake, &env).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(failure(server.link_state()).problem, Problem::AuthBlocked8050);
    assert!(server.link().needs_acknowledgement());
    server.stop().await;
}

#[tokio::test]
async fn an_acknowledged_connect_right_after_a_disconnect_that_restored_8050_still_connects() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000"), ("KIWOOM_SEND_SPACING_MILLIS", "3000")]);
    server.addr().await;
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    server.clock().jump(601);
    fake.reset();
    let abandoned = tokio::spawn({
        let link = server.link();
        async move { link.connect(true).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let link = server.link();
    link.disconnect();
    let again = link.connect(true).await;
    abandoned.await.unwrap();
    assert_eq!(again, LinkState::Connected);
    server.stop().await;
}

#[tokio::test]
async fn an_8050_answer_arriving_after_a_disconnect_still_shows_in_the_link_state() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    fake.delay("au10001", Duration::from_millis(800));
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000")]);
    server.addr().await;
    let connecting = tokio::spawn({
        let link = server.link();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.issued(), 1);
    server.link().disconnect();
    connecting.await.unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(server.link().needs_acknowledgement());
    assert_eq!(failure(server.link_state()).problem, Problem::AuthBlocked8050);
    server.stop().await;
}

#[tokio::test]
async fn a_key_rejection_answered_for_the_replaced_key_does_not_block_the_new_key() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, KEY_REJECTED);
    fake.delay("au10001", Duration::from_millis(800));
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000")]);
    server.addr().await;
    let connecting = tokio::spawn({
        let link = server.link();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.link().replace_key(Secret::new("FAKE-new-key".into()), Secret::new("FAKE-new-secret".into()));
    connecting.await.unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    fake.reset();
    server.clock().jump(601);
    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.seen.token_bodies.lock().unwrap().last().unwrap()["appkey"], "FAKE-new-key");
    server.stop().await;
}

#[tokio::test]
async fn a_failed_answer_for_a_replaced_key_ends_the_new_keys_connect_as_failed() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, KEY_REJECTED);
    fake.delay("au10001", Duration::from_secs(2));
    let env = env();
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", "20261109100000")]);
    server.addr().await;
    let old = tokio::spawn({
        let link = server.link();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.link().replace_key(Secret::new("FAKE-new-key".into()), Secret::new("FAKE-new-secret".into()));
    server.clock().jump(601);
    let new = server.connect(false).await;
    old.await.unwrap();
    assert!(matches!(new, LinkState::Failed(_)), "{new:?}");
    assert!(matches!(server.link_state(), LinkState::Failed(_)), "{:?}", server.link_state());
    let base = format!("http://{}", server.addr().await);
    assert_eq!(get(&base, "/api/bars?symbol=005930&period=D").await.1["error"]["reason"], "not_connected");
    server.stop().await;
}

#[tokio::test]
async fn a_rejected_saved_token_inside_the_issue_interval_ends_the_connect_as_a_wait() {
    let fake = ScriptedTransport::new();
    fake.respond_with("ka10099", 200, json!({"return_code": 3, "return_msg": "인증 실패[8005:Token이 유효하지 않습니다]"}));
    let env = env();
    let at = now_unix() - 60;
    write_private(&token_path(&env.lock), json!({"credential": credential_id(APP_KEY), "token": {"value": "saved-token", "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    let outcome = tokio::time::timeout(Duration::from_secs(6), server.connect(false)).await.expect("연결이 끝나야 한다");
    assert_eq!(failure(outcome).problem, Problem::IssueIntervalWait);
    assert_eq!(fake.issued(), 0);
    server.stop().await;
}

#[tokio::test]
async fn a_key_rejection_while_connecting_always_leaves_the_link_failed_and_closed() {
    let fake = ScriptedTransport::new();
    fake.delay("ka10099", Duration::from_secs(1));
    fake.respond_with("ka10081", 200, json!({"return_code": 3, "return_msg": KEY_REJECTED}));
    let env = env();
    let server = spawn(&fake, &env, &[OFF]);
    let base = format!("http://{}", server.addr().await);
    let connecting = tokio::spawn({
        let link = server.link();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let bars = tokio::spawn({
        let base = base.clone();
        async move { get(&base, "/api/bars?symbol=005930&period=D").await }
    });
    connecting.await.unwrap();
    bars.await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(failure(server.link_state()).problem, Problem::KeyNeedsCheck);
    assert_eq!(get(&base, "/api/bars?symbol=005930&period=D").await.1["error"]["reason"], "not_connected");
    server.stop().await;
}

#[tokio::test]
async fn a_first_start_with_a_key_connects_by_itself_with_one_issue() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[START]);
    server.addr().await;
    assert_eq!(server.wait_for_state(is_connected).await, LinkState::Connected);
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    assert_eq!(token_file_of(&env)["credential"], credential_id(APP_KEY));
    server.stop().await;
}

#[tokio::test]
async fn a_restart_after_a_connect_connects_by_itself_and_issues_nothing_with_the_saved_token() {
    let socket = counted_socket().await;
    let fake = ScriptedTransport::new();
    let env = env();
    let ws = ("VALLY_KIWOOM_WS_URL", socket.url.as_str());
    let first = spawn(&fake, &env, &[START, ws]);
    first.addr().await;
    first.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 1);
    first.stop().await;
    let accepts_before = socket.accepts.load(Ordering::SeqCst);

    let second = spawn(&fake, &env, &[START, ws]);
    second.addr().await;
    second.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 1, "저장한 토큰을 쓰므로 발급은 늘지 않는다: {:?}", fake.api_ids());
    let mut accepts = accepts_before;
    for _ in 0..50 {
        accepts = socket.accepts.load(Ordering::SeqCst);
        if accepts > accepts_before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(accepts > accepts_before, "재시작 뒤에도 WebSocket에 접속한다");
    second.stop().await;
}

#[tokio::test]
async fn a_restart_with_an_expired_token_connects_by_itself_with_one_issue() {
    let fake = ScriptedTransport::new();
    let env = env();
    let at = now_unix() - 3600;
    write_private(&token_path(&env.lock), json!({"credential": credential_id(APP_KEY), "token": {"value": "expired-token", "expires_dt": "20200101000000", "issued_at": at - 86400}, "last_request_at": at}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[START]);
    server.addr().await;
    server.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    assert!(fake.seen.authorizations.lock().unwrap().iter().all(|auth| auth != "Bearer expired-token"));
    server.stop().await;
}

#[tokio::test]
async fn a_restart_inside_the_issue_interval_waits_and_then_connects_by_itself() {
    let fake = ScriptedTransport::new();
    let env = env();
    let last_request = unix_of(AT_TEN) - 60;
    write_private(&token_path(&env.lock), json!({"token": null, "last_request_at": last_request}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN)]);
    server.addr().await;
    let waiting = server.wait_for_state(is_issue_interval_wait).await;
    assert_eq!(waiting, LinkState::Connecting(ConnectStep::IssueInterval(server::kiwoom::wire::parse_kst_datetime(AT_TEN).unwrap().plus_secs(-60 + 600))));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(fake.requests(), 0, "그 시각 전에는 아무것도 보내지 않는다: {:?}", fake.api_ids());
    server.clock().jump(541);
    server.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn a_first_automatic_issue_answered_8050_stops_blocked_and_does_not_repeat() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    let env = env();
    let server = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN)]);
    server.addr().await;
    let blocked = server.wait_for_state(is_failed).await;
    assert_eq!(failure(blocked).problem, Problem::AuthBlocked8050);
    assert_eq!(failure(server.link_state()).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.issued(), 1);

    server.clock().jump(601);
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(fake.issued(), 1, "같은 프로세스에서 간격이 지나도 저절로 다시 보내지 않는다: {:?}", fake.api_ids());
    server.stop().await;

    let again = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN_TWENTY)]);
    again.addr().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(failure(again.link_state()).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.issued(), 1, "같은 파일로 다시 켜도 발급은 1회 그대로다: {:?}", fake.api_ids());
    again.stop().await;
}

#[tokio::test]
async fn a_restart_after_8050_stays_blocked_and_sends_nothing() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, EIGHT_FIFTY);
    let env = env();
    let first = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", AT_TEN)]);
    first.addr().await;
    let blocked = first.connect(false).await;
    assert_eq!(failure(blocked.clone()).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.requests(), 1);
    first.stop().await;
    fake.reset();

    let server = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN_TWENTY)]);
    server.addr().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(server.link_state(), blocked, "재시작 뒤 상태가 8050 직후와 같다");
    assert!(server.link().needs_acknowledgement());
    assert_eq!(fake.requests(), 1, "켜기만 하면 요청이 없다: {:?}", fake.api_ids());
    assert_eq!(failure(server.connect(false).await).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.requests(), 1, "확인 없는 연결도 요청이 없다");

    assert_eq!(server.connect(true).await, LinkState::Connected, "확인하고 간격이 지난 연결은 풀린다");
    assert_eq!(fake.issued(), 2);
    let saved = token_file_of(&env);
    assert!(saved["auth_block"].is_null(), "{saved}");
    server.stop().await;
}

#[tokio::test]
async fn a_restart_after_a_key_rejection_stays_blocked_until_a_new_key_is_saved() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, KEY_REJECTED);
    let env = env();
    let first = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN)]);
    first.addr().await;
    let blocked = first.wait_for_state(is_failed).await;
    assert_eq!(failure(blocked.clone()).problem, Problem::KeyNeedsCheck);
    assert_eq!(token_file_of(&env)["auth_block"]["credential"], credential_id(APP_KEY));
    first.stop().await;
    fake.reset();

    let server = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN_TWENTY)]);
    server.addr().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(failure(server.link_state()).problem, Problem::KeyNeedsCheck);
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    assert_eq!(failure(server.connect(true).await).problem, Problem::KeyNeedsCheck, "확인 체크는 키 문제를 풀지 못한다");

    let state = server.link().replace_key(Secret::new("FAKE-new-key".into()), Secret::new("FAKE-new-secret".into()));
    assert_eq!(state, LinkState::Disconnected);
    assert!(token_file_of(&env)["auth_block"].is_null());
    assert_eq!(server.connect(false).await, LinkState::Connected);
    assert_eq!(fake.issued(), 2);
    server.stop().await;
}

#[tokio::test]
async fn a_restart_with_another_app_key_does_not_restore_a_key_rejection() {
    let fake = ScriptedTransport::new();
    reject_issue(&fake, KEY_REJECTED);
    let env = env();
    let first = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN)]);
    first.addr().await;
    first.wait_for_state(is_failed).await;
    first.stop().await;
    fake.reset();

    let other = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN_TWENTY), ("VALLY_KIWOOM_APP_KEY", "FAKE-other-key")]);
    other.addr().await;
    other.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 2, "{:?}", fake.api_ids());
    other.stop().await;
}

#[tokio::test]
async fn a_restart_after_the_user_disconnects_stays_disconnected() {
    let fake = ScriptedTransport::new();
    let env = env();
    let first = spawn(&fake, &env, &[START]);
    first.addr().await;
    first.wait_for_state(is_connected).await;
    first.link().disconnect_by_user();
    assert_eq!(first.link_state(), LinkState::Disconnected);
    assert_eq!(token_file_of(&env)["disconnected"], credential_id(APP_KEY));
    first.stop().await;
    let sent = fake.requests();

    let second = spawn(&fake, &env, &[START]);
    second.addr().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(second.link_state(), LinkState::Disconnected);
    assert_eq!(fake.requests(), sent, "끊어 둔 키는 켤 때 아무것도 보내지 않는다: {:?}", fake.api_ids());
    assert_eq!(second.connect(false).await, LinkState::Connected);
    assert!(token_file_of(&env)["disconnected"].is_null(), "다시 연결하면 끊어 둔 기록이 지워진다");
    second.stop().await;

    let third = spawn(&fake, &env, &[START]);
    third.addr().await;
    third.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    third.stop().await;
}

#[tokio::test]
async fn a_disconnect_that_a_key_save_or_delete_makes_is_not_remembered() {
    let fake = ScriptedTransport::new();
    let env = env();
    let server = spawn(&fake, &env, &[START]);
    server.addr().await;
    server.wait_for_state(is_connected).await;
    server.link().disconnect();
    server.link().replace_key(Secret::new(APP_KEY.into()), Secret::new("FAKE-SECRET".into()));
    assert!(token_file_of(&env)["disconnected"].is_null());
    server.link().disconnect();
    server.link().clear_key();
    assert!(token_file_of(&env)["disconnected"].is_null());
    server.stop().await;
}

#[tokio::test]
async fn restarting_again_and_again_issues_at_most_one_token_per_issue_interval() {
    let fake = ScriptedTransport::new();
    fake.respond_with("au10001", 500, json!({}));
    let env = env();
    for round in 0..4 {
        let server = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN)]);
        server.addr().await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(fake.issued(), 1, "{round}번째 시작: {:?}", fake.api_ids());
        server.stop().await;
    }
    fake.reset();
    let later = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN_TWENTY)]);
    later.addr().await;
    later.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 2, "간격이 지나야 다음 발급이 나간다: {:?}", fake.api_ids());
    later.stop().await;
}

#[tokio::test]
async fn a_plain_connect_inside_the_issue_interval_continues_by_itself_when_it_ends() {
    let fake = ScriptedTransport::new();
    let env = env();
    write_private(&token_path(&env.lock), json!({"token": null, "last_request_at": unix_of(AT_TEN) - 60}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[OFF, ("VALLY_CLOCK_START", AT_TEN)]);
    server.addr().await;
    let waiting = server.connect_until_waiting(false).await;
    assert!(is_issue_interval_wait(&waiting), "{waiting:?}");
    assert!(is_issue_interval_wait(&server.connect_until_waiting(false).await), "다른 연결 요청은 같은 대기에 붙는다");
    assert_eq!(fake.requests(), 0);
    server.clock().jump(541);
    server.wait_for_state(is_connected).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn a_disconnect_during_the_issue_interval_wait_sends_nothing() {
    let fake = ScriptedTransport::new();
    let env = env();
    write_private(&token_path(&env.lock), json!({"token": null, "last_request_at": unix_of(AT_TEN) - 60}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN)]);
    server.addr().await;
    server.wait_for_state(is_issue_interval_wait).await;
    server.link().disconnect();
    assert_eq!(server.link_state(), LinkState::Disconnected);
    server.clock().jump(700);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(server.link_state(), LinkState::Disconnected);
    assert_eq!(fake.requests(), 0, "{:?}", fake.api_ids());
    server.stop().await;
}

#[tokio::test]
async fn an_acknowledged_connect_that_fails_before_a_token_keeps_8050_blocked_for_the_automatic_paths() {
    let fake = ScriptedTransport::new();
    fake.respond_with("au10001", 500, json!({}));
    let env = env();
    write_private(&token_path(&env.lock), json!({"credential": credential_id(APP_KEY), "token": null, "last_request_at": unix_of(AT_TEN) - 3600, "auth_block": {"detail": {"rest": 8050}, "credential": null, "at": unix_of(AT_TEN) - 3600}}).to_string().as_bytes());
    let server = spawn(&fake, &env, &[START, ("VALLY_CLOCK_START", AT_TEN)]);
    server.addr().await;
    assert_eq!(failure(server.link_state()).problem, Problem::AuthBlocked8050);
    assert_eq!(fake.requests(), 0);

    assert_eq!(failure(server.connect(true).await).problem, Problem::AuthBlocked8050, "토큰을 받기 전에 실패하면 8050 차단이 다시 선다");
    assert!(server.link().needs_acknowledgement());
    assert_eq!(fake.issued(), 1);

    server.link().replace_key(Secret::new("FAKE-new-key".into()), Secret::new("FAKE-new-secret".into()));
    server.link().connect_in_background();
    server.clock().jump(601);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(failure(server.link_state()).problem, Problem::AuthBlocked8050, "키 저장 때의 자동 연결은 확인 없이 발급하지 않는다");
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());

    fake.reset();
    assert_eq!(server.connect(true).await, LinkState::Connected, "확인하고 간격이 지난 손 연결은 지금처럼 풀린다");
    assert_eq!(fake.issued(), 2);
    server.stop().await;
}
