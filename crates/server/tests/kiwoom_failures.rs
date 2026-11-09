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

/// R5: 현재가(ka10095) 실패를 "봉 요청"으로 적지 않는다.
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

/// 8050(지정단말기): 토큰 발급을 한 번만 하고, 재시도·재발급을 모두 멈추고, 원인과 조치를 로그와 응답에 싣는다.
/// 실제 8050 응답의 HTTP 상태를 아직 재지 못해 200과 403 두 모양을 다 본다.
async fn designated_terminal_stops_after_one_token_attempt(http_status: u16) {
    let fake = FakeKiwoom::start().await;
    fake.respond_with("au10001", http_status, json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]"}));
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), &static_dir(tmp.path()));
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let mut last = Value::Null;
    for path in ["/api/symbols/005930", "/api/symbols?q=%EC%82%BC%EC%84%B1", "/api/bars?symbol=005930&period=D", "/api/quotes?symbols=005930", "/api/bars?symbol=IDX:001&period=D"] {
        let (status, body) = get(&client, &base, path).await;
        assert_eq!((status, body["error"]["code"].as_str()), (502, Some("kiwoom_auth_failed")), "{path}: {body}");
        last = body;
    }
    let message = last["error"]["message"].as_str().unwrap();
    assert!(message.contains("8050") && message.contains("공인 IP를 키움 포털에 등록하세요"), "{message}");

    // 켤 때의 종목 목록 재시도(10초)가 한 번은 돌 만큼 기다린다.
    tokio::time::sleep(Duration::from_secs(11)).await;
    assert_eq!(fake.api_ids(), ["au10001"], "발급 시도는 한 번뿐이고 시세 요청은 없다");
    let logs = server.stop().await;
    assert!(logs.contains("공인 IP를 키움 포털에 등록하세요"), "{logs}");
    assert!(!logs.contains("10초 뒤 다시 받습니다"), "멈춘 뒤에는 종목 목록을 다시 받지 않는다:\n{logs}");
}

#[tokio::test(flavor = "multi_thread")]
async fn designated_terminal_8050_with_http_200_halts_everything() {
    designated_terminal_stops_after_one_token_attempt(200).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn designated_terminal_8050_with_http_403_halts_everything() {
    designated_terminal_stops_after_one_token_attempt(403).await;
}
