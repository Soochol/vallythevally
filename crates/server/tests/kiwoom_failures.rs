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
