
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use common::{APP_KEY, ScriptedTransport, Server, token_path};
use serde_json::{Value, json};
use server::config::Secret;
use server::kiwoom::link::{LinkFailure, LinkState, Problem};
use server::kiwoom::token_file::credential_id;

const OFF: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "off");
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
    let waiting = failure(server.connect(false).await);
    assert_eq!((waiting.problem, waiting.retry_at.map(|at| at.unix())), (Problem::IssueIntervalWait, Some(last_request + 600)), "{}", waiting.message);
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
    assert_eq!(failure(server.connect(false).await).problem, Problem::IssueIntervalWait, "키를 바꿔도 마지막 발급 요청 시각은 지켜진다");
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
    let server = spawn(&fake, &env, &[OFF]);
    server.addr().await;
    let abandoned = tokio::spawn({
        let link = server.link();
        async move { link.connect(false).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.link().disconnect();
    let second = failure(server.connect(false).await);
    assert_eq!(second.problem, Problem::IssueIntervalWait, "{}", second.message);
    abandoned.await.unwrap();
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    tokio::time::sleep(Duration::from_millis(2500)).await;
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
