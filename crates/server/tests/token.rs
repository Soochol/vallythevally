mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{APP_KEY, APP_SECRET, FakeKiwoom, Server, TOKEN, token_for, token_path};
use serde_json::{Value, json};
use server::kiwoom::token_file::credential_id;

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

async fn run_until_symbols_load(fake: &FakeKiwoom, lock: &Path, dist: &Path) -> String {
    run_until_symbols_load_with(fake, lock, dist, &[]).await
}

async fn run_until_symbols_load_with(fake: &FakeKiwoom, lock: &Path, dist: &Path, overrides: &[(&str, &std::ffi::OsStr)]) -> String {
    let server = Server::spawn_with(fake, lock, dist, overrides);
    let base = format!("http://{}", server.addr().await);
    for _ in 0..100 {
        if get(&base, "/api/symbols/005930").await.0 == 200 {
            return server.stop().await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("종목 목록을 받지 못했습니다:\n{}", server.stop().await);
}

fn write_token_file(lock: &Path, contents: Value) {
    write_private(&token_path(lock), contents.to_string().as_bytes());
}

fn write_private(path: &Path, contents: &[u8]) {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).unwrap();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(path, contents).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn restarting_three_times_issues_one_token_kept_in_a_private_file() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("state/vallythevally/server.lock");
    let dist = static_dir(tmp.path());
    let mut logs = String::new();
    for _ in 0..3 {
        logs += &run_until_symbols_load(&fake, &lock, &dist).await;
    }
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    assert_eq!(logs.matches("파일의 토큰을 다시 씁니다").count(), 2, "{logs}");

    let file = token_path(&lock);
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved["token"]["value"], TOKEN);
    assert_eq!(saved["credential"], credential_id(APP_KEY));
    assert_eq!(saved["token"]["expires_dt"], "20991231000000");
    assert!(saved["last_request_at"].as_i64().unwrap() > now_unix() - 60);
    for secret in [APP_KEY, APP_SECRET, TOKEN] {
        assert!(!logs.contains(secret), "로그에 비밀값 {secret}이 있다:\n{logs}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_valid_saved_token_is_used_without_issuing() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let at = now_unix() - 3600;
    write_token_file(&lock, json!({"credential": credential_id(APP_KEY), "token": {"value": TOKEN, "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at}));
    run_until_symbols_load(&fake, &lock, &static_dir(tmp.path())).await;
    assert_eq!(fake.issued(), 0, "{:?}", fake.api_ids());
    let auths = fake.seen.authorizations.lock().unwrap().clone();
    assert!(auths.iter().all(|a| *a == format!("Bearer {TOKEN}")), "{auths:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_issue_within_ten_minutes_of_the_last_request_even_across_restarts() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    write_token_file(&lock, json!({"token": null, "last_request_at": now_unix() - 60}));
    let server = Server::spawn(&fake, &lock, &static_dir(tmp.path()));
    let base = format!("http://{}", server.addr().await);
    let (status, body) = get(&base, "/api/bars?symbol=005930&period=D").await;
    assert_eq!((status, body["error"]["code"].as_str()), (503, Some("kiwoom_unavailable")), "{body}");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("10분"), "{message}");
    let logs = server.stop().await;
    assert_eq!(fake.requests(), 0, "{:?}\n{logs}", fake.api_ids());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_invalid_saved_token_is_reissued_once() {
    let fake = FakeKiwoom::start().await;
    fake.reject_token("FAKE-TOKEN-old-0001");
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let at = now_unix() - 3600;
    write_token_file(&lock, json!({"credential": credential_id(APP_KEY), "token": {"value": "FAKE-TOKEN-old-0001", "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at}));
    let logs = run_until_symbols_load(&fake, &lock, &static_dir(tmp.path())).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(token_path(&lock)).unwrap()).unwrap();
    assert_eq!(saved["token"]["value"], TOKEN);
    assert!(!logs.contains("FAKE-TOKEN-old-0001"), "{logs}");
}

struct Case {
    token: PathBuf,
    untouched: PathBuf,
}

type Setup = Box<dyn Fn(&Path) -> Case>;

fn with_contents(contents: &'static str) -> Setup {
    Box::new(move |root: &Path| {
        let path = root.join("state/token.json");
        write_private(&path, contents.as_bytes());
        Case { token: path.clone(), untouched: path }
    })
}

fn with_modes(dir_mode: u32, file_mode: u32) -> Setup {
    Box::new(move |root: &Path| {
        let path = root.join("state/token.json");
        let at = now_unix() - 3600;
        let valid = json!({"credential": credential_id(APP_KEY), "token": {"value": TOKEN, "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at});
        write_private(&path, valid.to_string().as_bytes());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(file_mode)).unwrap();
        std::fs::set_permissions(path.parent().unwrap(), std::fs::Permissions::from_mode(dir_mode)).unwrap();
        Case { token: path.clone(), untouched: path }
    })
}

async fn assert_never_issues(fake: &FakeKiwoom, cases: Vec<(&str, Setup)>) {
    let tmp = tempfile::tempdir().unwrap();
    let dist = static_dir(tmp.path());
    for (name, setup) in cases {
        let root = tmp.path().join(name);
        std::fs::create_dir_all(&root).unwrap();
        let Case { token, untouched } = setup(&root);
        let before = std::fs::read(&untouched).unwrap();
        let lock = root.join("run/server.lock");
        for _ in 0..3 {
            let server = Server::spawn_with(fake, &lock, &dist, &[("VALLY_TOKEN_PATH", token.as_os_str())]);
            let base = format!("http://{}", server.addr().await);
            let (status, body) = get(&base, "/api/symbols/005930").await;
            let logs = server.stop().await;
            assert_eq!((status, body["error"]["code"].as_str()), (502, Some("kiwoom_auth_failed")), "{name}: {body}\n{logs}");
            assert!(body["error"]["message"].as_str().unwrap().contains("토큰 파일"), "{name}: {body}");
            assert!(logs.contains(&token.display().to_string()), "{name}: 로그에 경로가 있다\n{logs}");
        }
        assert_eq!(fake.requests(), 0, "{name}: {:?}", fake.api_ids());
        assert_eq!(std::fs::read(&untouched).unwrap(), before, "{name}: 고치지 않고 그대로 둔다");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_token_file_issues_nothing_across_restarts_and_is_left_as_is() {
    let parent_is_a_file: Setup = Box::new(|root: &Path| {
        let blocker = root.join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();
        Case { token: blocker.join("token.json"), untouched: blocker }
    });
    let cases = vec![("빈 파일", with_contents("")), ("깨진 JSON", with_contents("{\"token\": ")), ("부모가 일반 파일", parent_is_a_file)];
    assert_never_issues(&FakeKiwoom::start().await, cases).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_saved_for_another_app_key_is_never_sent_and_the_interval_still_holds() {
    const OTHER_KEY: &str = "FAKE-APPKEY-other-b2b2b2b2";
    let other: &[(&str, &std::ffi::OsStr)] = &[("VALLY_KIWOOM_APP_KEY", OTHER_KEY.as_ref())];
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let dist = static_dir(tmp.path());
    run_until_symbols_load(&fake, &lock, &dist).await;
    assert_eq!(fake.issued(), 1);
    let sent_before = fake.requests();

    let server = Server::spawn_with(&fake, &lock, &dist, other);
    let base = format!("http://{}", server.addr().await);
    let (status, body) = get(&base, "/api/bars?symbol=005930&period=D").await;
    let logs = server.stop().await;
    assert_eq!((status, body["error"]["code"].as_str()), (503, Some("kiwoom_unavailable")), "{body}\n{logs}");
    assert!(body["error"]["message"].as_str().unwrap().contains("10분"), "{body}");
    assert_eq!(fake.requests(), sent_before, "앱키가 바뀌어도 10분 안에는 아무것도 보내지 않는다: {:?}", fake.api_ids());

    let path = token_path(&lock);
    let mut saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    saved["last_request_at"] = json!(now_unix() - 3600);
    std::fs::write(&path, saved.to_string()).unwrap();
    run_until_symbols_load_with(&fake, &lock, &dist, other).await;
    let bodies = fake.seen.token_bodies.lock().unwrap().clone();
    assert_eq!(bodies.iter().map(|b| b["appkey"].as_str().unwrap()).collect::<Vec<_>>(), [APP_KEY, OTHER_KEY]);
    let auths = fake.seen.authorizations.lock().unwrap()[sent_before..].to_vec();
    assert!(!auths.contains(&format!("Bearer {TOKEN}")), "옛 앱키의 토큰을 보냈다: {auths:?}");
    assert!(auths.contains(&format!("Bearer {}", token_for(OTHER_KEY))), "{auths:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_file_others_can_read_is_not_used() {
    let cases = vec![("파일 644", with_modes(0o700, 0o644)), ("디렉터리 755", with_modes(0o755, 0o600))];
    assert_never_issues(&FakeKiwoom::start().await, cases).await;
}
