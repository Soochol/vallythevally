//! 바이너리를 가짜 키움에 붙여 처음부터 끝까지 돌린다.

mod common;

use std::time::Duration;

use common::{APP_KEY, APP_SECRET, FakeKiwoom, Server, TOKEN};
use serde_json::Value;

fn static_dir(root: &std::path::Path) -> std::path::PathBuf {
    let dir = root.join("dist");
    std::fs::create_dir_all(dir.join("assets")).unwrap();
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
async fn serves_symbols_and_bars_from_fake_kiwoom_and_never_logs_secrets() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), &static_dir(tmp.path()));
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let mut found = Value::Null;
    for _ in 0..100 {
        let (status, body) = get(&client, &base, "/api/symbols?q=%EC%82%BC%EC%84%B1").await;
        if status == 200 {
            found = body;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let codes: Vec<&str> = found.as_array().expect("검색 결과").iter().map(|s| s["code"].as_str().unwrap()).collect();
    assert!(codes.contains(&"005930") && codes.contains(&"005935") && codes.len() >= 8, "{codes:?}");
    assert!(!codes.contains(&"520100"), "ETN은 목록에 없다");

    let (status, info) = get(&client, &base, "/api/symbols/005930").await;
    assert_eq!((status, info["name"].as_str()), (200, Some("삼성전자")));

    let (status, week) = get(&client, &base, "/api/bars?symbol=005930&period=W").await;
    assert_eq!(status, 200, "{week}");
    assert_eq!(week["period"], "W");
    assert_eq!(week["seq"], Value::Null);
    let bars = week["bars"].as_array().unwrap();
    assert!(bars.len() >= 29, "{}", bars.len());
    let ts: Vec<i64> = bars.iter().map(|b| b["t"].as_i64().unwrap()).collect();
    assert!(ts.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(week["nextBefore"], Value::Null, "가짜 키움은 두 번째 페이지에서 끝난다");
    let newest = week["current"].as_object().map_or_else(|| bars.last().unwrap().clone(), |c| Value::Object(c.clone()));
    assert_eq!((newest["t"].as_i64(), newest["c"].as_f64()), (Some(1_793_545_200), Some(193_400.0)), "2026-11-02 주봉, 종가 193,400원");

    let (status, idx) = get(&client, &base, "/api/bars?symbol=IDX:001&period=D&limit=10").await;
    assert_eq!(status, 200, "{idx}");
    assert_eq!(idx["bars"].as_array().unwrap().len(), 10);
    assert_eq!(idx["bars"][9]["c"].as_f64(), Some(5_059.69));
    assert!(idx["nextBefore"].is_number());

    let (status, err) = get(&client, &base, "/api/bars?symbol=000000&period=D").await;
    assert_eq!((status, err["error"]["code"].as_str()), (404, Some("unknown_symbol")));
    let (status, page) = get(&client, &base, "/layout/abc").await;
    assert_eq!((status, page.as_str().map(|s| s.contains("vally"))), (200, Some(true)));

    let seen = &fake.seen;
    let api_ids = seen.api_ids.lock().unwrap().clone();
    assert_eq!(api_ids[0], "au10001", "토큰 발급이 먼저 나간다");
    assert_eq!(api_ids.iter().filter(|a| *a == "au10001").count(), 1);
    assert_eq!(seen.token_bodies.lock().unwrap()[0]["appkey"], APP_KEY);
    let auths = seen.authorizations.lock().unwrap().clone();
    assert!(auths[1..].iter().all(|a| *a == format!("Bearer {TOKEN}")));

    let logs = server.stop().await;
    assert!(logs.contains("키움 조회"), "로그가 비어 있다:\n{logs}");
    for secret in [APP_KEY, APP_SECRET, TOKEN] {
        assert!(!logs.contains(secret), "로그에 비밀값 {secret}이 있다:\n{logs}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn second_instance_exits_1_without_touching_kiwoom() {
    let first_kiwoom = FakeKiwoom::start().await;
    let second_kiwoom = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let dist = static_dir(tmp.path());
    let first = Server::spawn(&first_kiwoom, &lock, &dist);
    first.addr().await;

    let mut second = Server::spawn(&second_kiwoom, &lock, &dist);
    let status = tokio::time::timeout(Duration::from_secs(10), second.child.wait()).await.expect("두 번째 서버가 끝나지 않았다").unwrap();
    assert_eq!(status.code(), Some(1));
    tokio::time::sleep(Duration::from_millis(100)).await;
    let logs = second.logs();
    let pid = first.child.id().unwrap();
    assert!(logs.contains(&format!("다른 서버가 이미 실행 중이다(pid {pid}")), "{logs}");
    assert_eq!(second_kiwoom.requests(), 0, "두 번째 서버는 키움에 아무것도 보내지 않는다");
    assert!(first_kiwoom.requests() >= 1);
    first.stop().await;
}
