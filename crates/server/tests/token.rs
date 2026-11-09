//! 토큰 파일(ADR 0004, backend.md §4.1): 재시작은 발급이 아니다. 발급 사이는 10분 넘게 띄운다.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{APP_KEY, APP_SECRET, FakeKiwoom, Server, TOKEN, token_path};
use serde_json::{Value, json};

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
    let server = Server::spawn(fake, lock, dist);
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
    let path = token_path(lock);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, contents.to_string()).unwrap();
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
    write_token_file(&lock, json!({"token": {"value": TOKEN, "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at}));
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
    write_token_file(&lock, json!({"token": {"value": "FAKE-TOKEN-old-0001", "expires_dt": "20991231000000", "issued_at": at}, "last_request_at": at}));
    let logs = run_until_symbols_load(&fake, &lock, &static_dir(tmp.path())).await;
    assert_eq!(fake.issued(), 1, "{:?}", fake.api_ids());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(token_path(&lock)).unwrap()).unwrap();
    assert_eq!(saved["token"]["value"], TOKEN);
    assert!(!logs.contains("FAKE-TOKEN-old-0001"), "{logs}");
}
