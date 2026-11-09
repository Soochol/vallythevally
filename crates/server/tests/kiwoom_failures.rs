//! 키움이 실패할 때 서버가 무엇을 기록하고 무엇을 멈추는가. 가짜 키움만 쓴다.

mod common;

use std::time::Duration;

use common::{FakeKiwoom, Server};
use serde_json::{Value, json};

fn static_dir(root: &std::path::Path) -> std::path::PathBuf {
    let dir = root.join("dist");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>vally</title>").unwrap();
    dir
}

async fn get(client: &reqwest::Client, base: &str, path: &str) -> (u16, Value) {
    let resp = client.get(format!("{base}{path}")).send().await.unwrap();
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

#[tokio::test(flavor = "multi_thread")]
async fn quote_failure_is_logged_as_a_quote_request() {
    let fake = FakeKiwoom::start().await;
    fake.respond_with("ka10095", 503, json!({"return_code": 1, "return_msg": "점검"}));
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), &static_dir(tmp.path()));
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let (status, body) = get(&client, &base, "/api/quotes?symbols=005930").await;
    assert_eq!((status, body["error"]["code"].as_str()), (503, Some("kiwoom_unavailable")), "{body}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let logs = server.stop().await;
    let lines: Vec<&str> = logs.lines().filter(|l| l.contains("요청에 답하지 못했습니다")).collect();
    assert_eq!(lines.len(), 1, "{logs}");
    assert!(lines[0].contains("현재가 요청에 답하지 못했습니다"), "{}", lines[0]);
}

async fn the_symbol_list_is_not_fetched_again_after(reply: Value, want: &str) {
    let fake = FakeKiwoom::start().await;
    fake.respond_with("ka10099", 200, reply.clone());
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), &static_dir(tmp.path()));
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let longer_than_one_startup_list_retry = Duration::from_secs(11);
    tokio::time::sleep(longer_than_one_startup_list_retry).await;
    let (status, body) = get(&client, &base, "/api/symbols?q=005930").await;
    assert_eq!(body["error"]["code"].as_str(), Some(want), "{reply}: {status} {body}");
    let list_requests = fake.api_ids().iter().filter(|id| *id == "ka10099").count();
    assert_eq!(list_requests, 1, "{reply}: 브라우저 요청도 바깥 타이머도 같은 경로로 다시 보내지 않는다");
    let logs = server.stop().await;
    assert!(!logs.contains("10초 뒤 다시 받습니다"), "{logs}");
    assert!(logs.contains("다시 받지 않습니다"), "{logs}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_failure_stops_the_symbol_list_path() {
    the_symbol_list_is_not_fetched_again_after(json!({"return_code": 1, "return_msg": "알 수 없음"}), "kiwoom_unavailable").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_envelope_is_not_an_empty_symbol_list() {
    the_symbol_list_is_not_fetched_again_after(json!({}), "internal").await;
}
