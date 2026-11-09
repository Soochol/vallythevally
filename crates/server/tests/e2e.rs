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

    let (status, krx) = get(&client, &base, "/api/bars?symbol=005930&period=D&venue=krx&limit=5").await;
    assert_eq!((status, krx["venue"].as_str()), (200, Some("krx")), "{krx}");
    assert_eq!(krx["bars"][4]["c"].as_f64(), Some(193_500.0), "KRX 11-06 종가");

    let (status, nxt) = get(&client, &base, "/api/bars?symbol=005930&period=1m&venue=nxt").await;
    assert_eq!((status, nxt["venue"].as_str(), nxt["period"].as_str()), (200, Some("nxt"), Some("1m")), "{nxt}");
    let last = nxt["bars"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["t"].as_i64(), last["c"].as_f64()), (Some(1_793_962_740), Some(193_400.0)), "NXT 11-06 19:59 봉");
    assert_eq!(nxt["nextBefore"], Value::Null, "가짜 키움은 두 번째 페이지에서 끝난다");

    let (status, err) = get(&client, &base, "/api/bars?symbol=005935&period=1m&venue=nxt").await;
    assert_eq!((status, err["error"]["code"].as_str()), (400, Some("bad_request")), "NXT 불가 종목");

    let (status, idx_m) = get(&client, &base, "/api/bars?symbol=IDX:001&period=1m").await;
    assert_eq!((status, idx_m["venue"].clone()), (200, Value::Null), "{idx_m}");
    assert_eq!(idx_m["bars"].as_array().unwrap().last().unwrap()["c"].as_f64(), Some(5_059.69));

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

async fn put(client: &reqwest::Client, base: &str, path: &str, body: &Value) -> (u16, Value) {
    let resp = client.put(format!("{base}{path}")).header("content-type", "application/json").body(body.to_string()).send().await.unwrap();
    let status = resp.status().as_u16();
    (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn user_data_survives_a_restart_and_quotes_come_from_kiwoom() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let dist = static_dir(tmp.path());
    let server = Server::spawn(&fake, &lock, &dist);
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let watchlist = serde_json::json!({"symbols": ["005930", "IDX:001", "000660"], "revision": 1_794_152_040_001_i64});
    let layout = serde_json::json!({"id": "0193aaaa-0000-7000-8000-000000000002", "name": "둘", "arrangement": "2v", "revision": 1_794_152_040_002_i64,
        "sync": {"crosshair": true, "scroll": false}, "cells": [
            {"slot": 0, "symbol": "005930", "venue": "nxt", "period": "15m", "symbolLink": true, "chartSettings": {"v": 1, "indicators": ["ma"]}},
            {"slot": 1, "symbol": "IDX:001", "venue": null, "period": "W", "symbolLink": false, "chartSettings": {"v": 1}}]});
    let ui = serde_json::json!({"lastLayoutId": layout["id"], "theme": "light", "watchCollapsed": true, "revision": 1_794_152_040_003_i64});
    assert_eq!(put(&client, &base, "/api/watchlist", &watchlist).await, (200, watchlist.clone()));
    let mut saved = Value::Null;
    for _ in 0..100 {
        let (status, body) = put(&client, &base, &format!("/api/layouts/{}", layout["id"].as_str().unwrap()), &layout).await;
        if status != 503 {
            assert_eq!(status, 200, "{body}");
            saved = body;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(saved["updatedAt"].as_i64().unwrap() > 1_700_000_000, "{saved}");
    assert_eq!(put(&client, &base, "/api/ui-state", &ui).await, (200, ui.clone()));

    let (status, quotes) = get(&client, &base, "/api/quotes?symbols=005930,IDX:001,000660").await;
    assert_eq!(status, 200, "{quotes}");
    let got: Vec<(&str, f64)> = quotes.as_array().unwrap().iter().map(|q| (q["symbol"].as_str().unwrap(), q["price"].as_f64().unwrap())).collect();
    assert_eq!(got, [("005930", 50_000.0), ("IDX:001", 5_059.69), ("000660", 120_500.0)]);
    assert_eq!(quotes[0]["change"].as_f64(), Some(-1_000.0));
    let first_logs = server.stop().await;
    assert!(tmp.path().join("run/vally.db").exists(), "DB는 VALLY_DB_PATH(임시 디렉터리)에 있다");

    let server = Server::spawn(&fake, &lock, &dist);
    let base = format!("http://{}", server.addr().await);
    assert_eq!(get(&client, &base, "/api/watchlist").await, (200, watchlist));
    assert_eq!(get(&client, &base, &format!("/api/layouts/{}", layout["id"].as_str().unwrap())).await, (200, saved));
    let (_, list) = get(&client, &base, "/api/layouts").await;
    assert_eq!(list.as_array().unwrap().iter().map(|l| l["name"].as_str().unwrap()).collect::<Vec<_>>(), ["기본", "둘"]);
    assert_eq!(get(&client, &base, "/api/ui-state").await, (200, ui));
    let logs = first_logs + &server.stop().await;
    for secret in [APP_KEY, APP_SECRET, TOKEN] {
        assert!(!logs.contains(secret), "로그에 비밀값 {secret}이 있다");
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
