
mod common;

use std::time::Duration;

use common::{APP_KEY, APP_SECRET, ScriptedTransport, Server, TOKEN};
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

#[tokio::test]
async fn serves_symbols_and_bars_from_injected_transport_and_never_logs_secrets() {
    let fake = ScriptedTransport::new();
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

#[tokio::test]
async fn user_data_survives_a_restart_and_quotes_come_from_kiwoom() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir_in("target").unwrap();
    let lock = tmp.path().join("run/server.lock");
    let dist = static_dir(tmp.path());
    let server = Server::spawn(&fake, &lock, &dist);
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let watchlist = serde_json::json!({"lists": [
        {"id": "01900000-0000-7000-8000-000000000002", "name": "기본", "symbols": ["005930", "IDX:001"], "groups": [
            {"id": "G1", "name": "지수", "symbols": ["IDX:001"]},
            {"id": "G2", "name": "공유", "symbols": ["IDX:001", "005930"]},
            {"id": "G3", "name": "빈 그룹", "symbols": []},
        ]},
        {"id": "L2", "name": "반도체", "symbols": ["000660", "005930"], "groups": []},
        {"id": "L3", "name": "지수", "symbols": ["IDX:101"], "groups": []},
    ], "revision": 1_794_152_040_001_i64});
    let layout = serde_json::json!({"id": "0193aaaa-0000-7000-8000-000000000002", "name": "둘", "revision": 1_794_152_040_002_i64,
        "sync": {"crosshair": true, "scroll": false}, "placement": {"v": 1, "dock": null, "canvas": null}, "windows": [
            {"id": "cell-0", "link": "a", "kind": "chart", "symbol": "005930", "venue": "nxt", "period": "15m", "chartSettings": {"v": 1, "indicators": ["ma"]}},
            {"id": "cell-1", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "W", "chartSettings": {"v": 1}},
            {"id": "watchlist", "link": "a", "kind": "watchlist"}]});
    let ui = serde_json::json!({"lastLayoutId": layout["id"], "theme": "light", "watchCollapsed": true, "revision": 1_794_152_040_003_i64});
    assert_eq!(put(&client, &base, "/api/watchlists", &watchlist).await, (200, watchlist.clone()));
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
    assert_eq!(get(&client, &base, "/api/watchlists").await, (200, watchlist));
    assert_eq!(get(&client, &base, &format!("/api/layouts/{}", layout["id"].as_str().unwrap())).await, (200, saved));
    let (_, list) = get(&client, &base, "/api/layouts").await;
    assert_eq!(list.as_array().unwrap().iter().map(|l| l["name"].as_str().unwrap()).collect::<Vec<_>>(), ["기본", "둘"]);
    assert_eq!(get(&client, &base, "/api/ui-state").await, (200, ui));
    let logs = first_logs + &server.stop().await;
    for secret in [APP_KEY, APP_SECRET, TOKEN] {
        assert!(!logs.contains(secret), "로그에 비밀값 {secret}이 있다");
    }
}

#[tokio::test]
async fn second_instance_exits_1_without_touching_kiwoom() {
    let first_kiwoom = ScriptedTransport::new();
    let second_kiwoom = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let dist = static_dir(tmp.path());
    let first = Server::spawn(&first_kiwoom, &lock, &dist);
    first.addr().await;

    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_vally-server"))
        .env_clear()
        .env("VALLY_KIWOOM_APP_KEY", APP_KEY)
        .env("VALLY_KIWOOM_APP_SECRET", APP_SECRET)
        .env("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:9")
        .env("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:9/api/dostk/websocket")
        .env("VALLY_TOKEN_PATH", lock.with_file_name("token.json"))
        .env("VALLY_LOCK_PATH", &lock)
        .output().await.unwrap();
    assert_eq!(output.status.code(), Some(1));
    let logs = String::from_utf8(output.stderr).unwrap();
    let pid = std::process::id();
    assert!(logs.contains(&format!("다른 서버가 이미 실행 중이다(pid {pid}")), "{logs}");
    assert_eq!(second_kiwoom.requests(), 0, "두 번째 서버는 키움에 아무것도 보내지 않는다");
    assert!(first_kiwoom.requests() >= 1);
    first.stop().await;
}

/// 실제 8050 응답의 HTTP 상태를 아직 재지 못해 200과 403 두 모양을 다 본다.
async fn designated_terminal_stops_after_one_token_attempt(http_status: u16) {
    let fake = ScriptedTransport::new();
    fake.respond_with("au10001", http_status, serde_json::json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]"}));
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

    let longer_than_one_startup_list_retry = Duration::from_secs(11);
    tokio::time::sleep(longer_than_one_startup_list_retry).await;
    assert_eq!(fake.api_ids(), ["au10001"], "발급 시도는 한 번뿐이고 시세 요청은 없다");
    let logs = server.stop().await;
    assert!(logs.contains("공인 IP를 키움 포털에 등록하세요"), "{logs}");
    assert!(!logs.contains("10초 뒤 다시 받습니다"), "멈춘 뒤에는 종목 목록을 다시 받지 않는다:\n{logs}");
}

#[tokio::test]
async fn designated_terminal_8050_with_http_200_halts_everything() {
    designated_terminal_stops_after_one_token_attempt(200).await;
}

#[tokio::test]
async fn designated_terminal_8050_with_http_403_halts_everything() {
    designated_terminal_stops_after_one_token_attempt(403).await;
}

#[tokio::test]
async fn scrolling_back_through_086520_daily_follows_the_kiwoom_chain_to_its_origin() {
    let fake = ScriptedTransport::new();
    let days: Vec<_> = std::iter::successors(Some(domain::KstDate::new(2026, 11, 6).unwrap()), |day| Some(day.add_days(-1)))
        .filter(|day| !matches!(day.weekday(), domain::Weekday::Sat | domain::Weekday::Sun)).take(1200).collect();
    let pages = days.chunks(300).enumerate().map(|(index, days)| {
        let rows: Vec<_> = days.iter().enumerate().map(|(offset, day)| {
            let close = 100_000 + ((index * 300 + offset) * 37 % 97) * 500;
            serde_json::json!({"dt":day.yyyymmdd(),"cur_prc":close.to_string(),"open_pric":close.to_string(),"high_pric":(close+2000).to_string(),"low_pric":(close-2000).to_string(),"trde_qty":"500000","trde_prica":"50000","upd_rt":""})
        }).collect();
        common::support::ScriptedReply { status:200, delay:Duration::ZERO, body:serde_json::json!({"return_code":0,"stk_cd":"086520_AL","stk_dt_pole_chart_qry":rows,"_headers":{"cont-yn":if index==3 { "N" } else { "Y" },"next-key":if index==3 { String::new() } else { format!("P{}",index+2) }}}) }
    }).collect();
    fake.script("ka10081", pages);

    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), &static_dir(tmp.path()));
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let mut path = "/api/bars?symbol=086520&period=D&limit=500".to_owned();
    let (mut status, mut page) = get(&client, &base, &path).await;
    for _ in 0..100 {
        if status != 503 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        (status, page) = get(&client, &base, &path).await;
    }
    let mut sizes = Vec::new();
    let mut oldest_seen = i64::MAX;
    loop {
        assert_eq!(status, 200, "{path}: {page}");
        let ts: Vec<i64> = page["bars"].as_array().unwrap().iter().map(|b| b["t"].as_i64().unwrap()).collect();
        assert!(ts.windows(2).all(|w| w[0] < w[1]), "{path}: 봉은 오름차순이다");
        assert!(*ts.last().unwrap() < oldest_seen, "{path}: 앞 페이지보다 모두 과거다");
        oldest_seen = ts[0];
        sizes.push(ts.len());
        match page["nextBefore"].as_i64() {
            Some(before) => {
                assert_eq!(before, ts[0]);
                path = format!("/api/bars?symbol=086520&period=D&limit=500&before={before}");
                (status, page) = get(&client, &base, &path).await;
            }
            None => break,
        }
    }
    assert_eq!(sizes, [500, 500, 200]);
    let chain: Vec<String> = fake.api_ids().into_iter().filter(|a| a == "ka10081").collect();
    assert_eq!(chain.len(), 4, "키움 네 페이지를 한 번씩 받는다");
    server.stop().await;
}

async fn get_after_symbol_list(client: &reqwest::Client, base: &str, path: &str) -> (u16, Value) {
    for _ in 0..100 {
        let (status, body) = get(client, base, path).await;
        if body["error"]["reason"] != "symbol_list_loading" {
            return (status, body);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("종목 목록을 받지 못했습니다: {path}");
}

fn ten_minute_starts(page: &Value) -> Vec<i64> {
    let ts: Vec<i64> = page["bars"].as_array().unwrap().iter().map(|b| b["t"].as_i64().unwrap()).collect();
    assert!(!ts.is_empty(), "{page}");
    assert!(ts.windows(2).all(|w| w[0] < w[1]), "봉은 오름차순이다: {ts:?}");
    assert!(ts.iter().all(|t| t % 600 == 0), "봉 시작은 10분 경계다: {ts:?}");
    ts
}

#[tokio::test]
async fn ten_minute_bars_follow_each_venue_and_a_saved_layout_keeps_them() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let dist = static_dir(tmp.path());
    let server = Server::spawn(&fake, &lock, &dist);
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let cases = [
        ("symbol=005930", Value::from("combined"), "ka10080", ("stk_cd", "005930_AL")),
        ("symbol=005930&venue=krx", Value::from("krx"), "ka10080", ("stk_cd", "005930")),
        ("symbol=005930&venue=nxt", Value::from("nxt"), "ka10080", ("stk_cd", "005930_NX")),
        ("symbol=IDX:001", Value::Null, "ka20005", ("inds_cd", "001")),
    ];
    for (query, venue, api_id, (code_field, code)) in cases {
        let sent_before = fake.calls().len();
        let (status, page) = get_after_symbol_list(&client, &base, &format!("/api/bars?{query}&period=10m")).await;
        assert_eq!((status, &page["period"], &page["venue"]), (200, &Value::from("10m"), &venue), "{query}: {page}");
        ten_minute_starts(&page);
        let sent: Vec<_> = fake.calls().into_iter().skip(sent_before).filter(|c| c.api_id == api_id).collect();
        assert!(!sent.is_empty(), "{query}: 키움 {api_id}를 부르지 않았다");
        assert!(sent.iter().all(|c| c.body["tic_scope"] == "10" && c.body[code_field] == code), "{query}: {sent:?}");
    }

    let (status, err) = get(&client, &base, "/api/bars?symbol=005935&period=10m&venue=nxt").await;
    assert_eq!((status, err["error"]["code"].as_str()), (400, Some("bad_request")), "NXT 불가 종목");

    let (status, newest) = get(&client, &base, "/api/bars?symbol=005930&period=10m&venue=krx&limit=3").await;
    assert_eq!(status, 200, "{newest}");
    let newest_starts = ten_minute_starts(&newest);
    let before = newest["nextBefore"].as_i64().expect("앞 구간이 더 있다");
    assert_eq!(before, newest_starts[0]);
    let (status, older) = get(&client, &base, &format!("/api/bars?symbol=005930&period=10m&venue=krx&before={before}")).await;
    assert_eq!(status, 200, "{older}");
    assert!(ten_minute_starts(&older).iter().all(|t| *t < before), "{older}");

    let layout = serde_json::json!({"id": "0193aaaa-0000-7000-8000-000000000010", "name": "10분", "revision": 1_794_152_040_010_i64,
        "sync": {"crosshair": true, "scroll": true}, "placement": {}, "windows": [
            {"id": "cell-0", "link": "a", "kind": "chart", "symbol": "005930", "venue": "nxt", "period": "10m", "chartSettings": {"v": 1, "indicators": ["ma"]}},
            {"id": "cell-1", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "10m", "chartSettings": {"v": 1}}]});
    let path = format!("/api/layouts/{}", layout["id"].as_str().unwrap());
    let (status, saved) = put(&client, &base, &path, &layout).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["windows"], layout["windows"]);
    server.stop().await;

    let server = Server::spawn(&fake, &lock, &dist);
    let base = format!("http://{}", server.addr().await);
    assert_eq!(get(&client, &base, &path).await, (200, saved));
    server.stop().await;
}

#[tokio::test]
async fn a_ten_minute_failure_at_the_first_page_or_a_later_page_stops_only_that_request() {
    let fake = ScriptedTransport::new();
    let invalid = serde_json::json!({"return_code": 2, "return_msg": "입력 값 오류입니다[1511:필수 입력 값에 값이 존재하지 않습니다]"});
    fake.respond_with("ka20005", 200, invalid.clone());
    fake.respond_with_for_key("ka10080", "A0059302026110216180000010000", 200, invalid);
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), &static_dir(tmp.path()));
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let (status, first_page) = get_after_symbol_list(&client, &base, "/api/bars?symbol=IDX:001&period=10m").await;
    assert_eq!((status, &first_page["error"]["reason"]), (500, &Value::from("invalid_request")), "{first_page}");

    let newest_path = "/api/bars?symbol=005930&period=10m&venue=krx&limit=3";
    let (status, newest) = get(&client, &base, newest_path).await;
    assert_eq!(status, 200, "다른 시리즈는 지수 실패와 상관없이 받는다: {newest}");
    let before = newest["nextBefore"].as_i64().expect("앞 구간이 더 있다");
    let (status, later_page) = get(&client, &base, &format!("/api/bars?symbol=005930&period=10m&venue=krx&before={before}")).await;
    assert_eq!((status, &later_page["error"]["reason"]), (500, &Value::from("invalid_request")), "{later_page}");
    let (status, again) = get(&client, &base, newest_path).await;
    assert_eq!((status, &again["bars"]), (200, &newest["bars"]), "이어 받기 실패 뒤에도 최신 봉은 그대로 받는다: {again}");
    server.stop().await;
}
