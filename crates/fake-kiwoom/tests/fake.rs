use std::net::SocketAddr;
use std::process::Stdio;
use std::time::{Duration, Instant};

use fake_kiwoom::krx::{self, KrxMarket};
use fake_kiwoom::{APP_KEY, FakeKiwoom, TOKEN, extra_stock_code};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

struct Reply {
    status: u16,
    cont: String,
    next: String,
    body: Value,
}

async fn kiwoom(base: &str, api_id: &str, body: Value, next_key: Option<&str>) -> Reply {
    let path = if api_id == "au10001" { "/oauth2/token" } else { "/api/dostk/chart" };
    let mut req = reqwest::Client::new()
        .post(format!("{base}{path}"))
        .header("api-id", api_id)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json;charset=UTF-8")
        .body(body.to_string());
    if let Some(k) = next_key {
        req = req.header("cont-yn", "Y").header("next-key", k);
    }
    let resp = req.send().await.unwrap();
    let h = |k: &str| resp.headers().get(k).map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
    let (status, cont, next) = (resp.status().as_u16(), h("cont-yn"), h("next-key"));
    let text = resp.text().await.unwrap();
    Reply { status, cont, next, body: serde_json::from_str(&text).unwrap_or(Value::String(text)) }
}

async fn admin(base: &str, path: &str, body: Value) -> u16 {
    let resp = reqwest::Client::new().post(format!("{base}/_fake/{path}")).header("content-type", "application/json").body(body.to_string()).send().await.unwrap();
    resp.status().as_u16()
}

async fn stats(base: &str) -> Value {
    serde_json::from_str(&reqwest::get(format!("{base}/_fake/stats")).await.unwrap().text().await.unwrap()).unwrap()
}

fn daily(stk_cd: &str) -> Value {
    json!({"stk_cd": stk_cd, "base_dt": "20261109", "upd_stkpc_tp": "1"})
}

#[tokio::test]
async fn respond_with_overrides_the_answer_until_reset() {
    let fake = FakeKiwoom::start().await;
    let base = fake.base_url();
    let normal = kiwoom(&base, "ka10081", daily("005930_AL"), None).await;
    assert_eq!((normal.status, normal.body["stk_cd"].as_str()), (200, Some("005930_AL")));

    let broken = json!({"return_code": 2, "return_msg": "점검 중"});
    assert_eq!(admin(&base, "respond-with", json!({"apiId": "ka10081", "status": 503, "body": broken})).await, 204);
    let overridden = kiwoom(&base, "ka10081", daily("005930_AL"), None).await;
    assert_eq!((overridden.status, overridden.body), (503, broken));
    assert_eq!(kiwoom(&base, "ka10080", json!({"stk_cd": "005930_AL"}), None).await.status, 200, "다른 api-id는 그대로다");

    assert_eq!(admin(&base, "reset", json!({})).await, 204);
    assert_eq!(kiwoom(&base, "ka10081", daily("005930_AL"), None).await.body, normal.body);
}

#[tokio::test]
async fn respond_with_rejects_a_status_that_is_not_http() {
    let fake = FakeKiwoom::start().await;
    assert_eq!(admin(&fake.base_url(), "respond-with", json!({"apiId": "ka10081", "status": 1000, "body": {}})).await, 400);
}

#[tokio::test]
async fn reject_token_answers_8005_until_reset() {
    let fake = FakeKiwoom::start().await;
    let base = fake.base_url();
    assert_eq!(admin(&base, "reject-token", json!({"token": TOKEN})).await, 204);
    let rejected = kiwoom(&base, "ka10081", daily("005930_AL"), None).await;
    assert_eq!(rejected.body["return_code"], 3);
    assert!(rejected.body["return_msg"].as_str().unwrap().contains("8005"), "{}", rejected.body);
    admin(&base, "reset", json!({})).await;
    assert_eq!(kiwoom(&base, "ka10081", daily("005930_AL"), None).await.body["return_code"], 0);
}

#[tokio::test]
async fn delay_holds_the_answer_until_reset() {
    let fake = FakeKiwoom::start().await;
    let base = fake.base_url();
    assert_eq!(admin(&base, "delay", json!({"apiId": "ka10081", "ms": 400})).await, 204);
    let started = Instant::now();
    kiwoom(&base, "ka10081", daily("005930_AL"), None).await;
    assert!(started.elapsed() >= Duration::from_millis(400), "{:?}", started.elapsed());
    admin(&base, "reset", json!({})).await;
    let started = Instant::now();
    kiwoom(&base, "ka10081", daily("005930_AL"), None).await;
    assert!(started.elapsed() < Duration::from_millis(400), "{:?}", started.elapsed());
}

#[tokio::test]
async fn stats_count_kiwoom_calls_but_not_admin_calls_and_survive_reset() {
    let fake = FakeKiwoom::start().await;
    let base = fake.base_url();
    assert_eq!(stats(&base).await, json!({"requests": 0, "issued": 0, "apiIds": []}));
    kiwoom(&base, "au10001", json!({"grant_type": "client_credentials", "appkey": APP_KEY, "secretkey": "x"}), None).await;
    kiwoom(&base, "ka10081", daily("005930_AL"), None).await;
    admin(&base, "delay", json!({"apiId": "ka10080", "ms": 1})).await;
    admin(&base, "reset", json!({})).await;
    kiwoom(&base, "ka10080", json!({"stk_cd": "005930_AL"}), None).await;
    assert_eq!(stats(&base).await, json!({"requests": 3, "issued": 1, "apiIds": ["au10001", "ka10081", "ka10080"]}));
    assert_eq!((fake.requests(), fake.issued(), fake.api_ids()), (3, 1, vec!["au10001".to_owned(), "ka10081".to_owned(), "ka10080".to_owned()]));
}

#[tokio::test]
async fn bind_accepts_only_loopback_addresses() {
    for addr in ["0.0.0.0:0", "[::]:0", "192.168.0.10:0"] {
        let err = FakeKiwoom::bind(addr.parse().unwrap()).await.err().unwrap_or_else(|| panic!("{addr}에 열렸습니다"));
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "{addr}: {err}");
    }
    let fake = FakeKiwoom::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    assert!(fake.addr.ip().is_loopback() && fake.addr.port() != 0);
}

#[tokio::test]
async fn deep_daily_history_of_086520_is_four_chained_pages_of_weekdays() {
    let fake = FakeKiwoom::start().await;
    let base = fake.base_url();
    for stk_cd in ["086520", "086520_AL", "086520_NX"] {
        let mut rows = Vec::new();
        let mut next: Option<String> = None;
        let mut keys = Vec::new();
        loop {
            let page = kiwoom(&base, "ka10081", daily(stk_cd), next.as_deref()).await;
            assert_eq!((page.status, page.body["return_code"].as_i64(), page.body["stk_cd"].as_str()), (200, Some(0), Some(stk_cd)));
            assert!(page.body.get("_source").is_none() && page.body.get("_headers").is_none());
            let got = page.body["stk_dt_pole_chart_qry"].as_array().unwrap();
            assert_eq!(got.len(), 300);
            rows.extend(got.iter().cloned());
            if page.cont != "Y" {
                assert_eq!((page.cont.as_str(), page.next.as_str()), ("N", ""));
                break;
            }
            keys.push(page.next.clone());
            next = Some(page.next);
        }
        assert_eq!(keys, ["P2", "P3", "P4"]);
        assert_eq!(rows.len(), 1200);
        assert_eq!(rows[0]["dt"], "20261106");
        let dates: Vec<&str> = rows.iter().map(|r| r["dt"].as_str().unwrap()).collect();
        assert!(dates.windows(2).all(|w| w[0] > w[1]), "최신 행부터 내려간다");
        let weekdays = dates.iter().map(|d| domain::KstDate::parse_yyyymmdd(d).unwrap().weekday());
        assert!(weekdays.into_iter().all(|w| !matches!(w, domain::Weekday::Sat | domain::Weekday::Sun)));
        for r in &rows {
            let p = |k: &str| r[k].as_str().unwrap().parse::<i64>().unwrap();
            let (o, h, l, c) = (p("open_pric"), p("high_pric"), p("low_pric"), p("cur_prc"));
            assert!(l <= o.min(c) && o.max(c) <= h && l > 0, "{r}");
        }
    }
}

#[tokio::test]
async fn deep_daily_history_does_not_change_005930() {
    let fake = FakeKiwoom::start().await;
    let first = kiwoom(&fake.base_url(), "ka10081", daily("005930_AL"), None).await;
    assert_eq!(first.body["stk_dt_pole_chart_qry"].as_array().unwrap().len(), 30);
    assert_eq!(first.cont, "Y");
    let second = kiwoom(&fake.base_url(), "ka10081", daily("005930_AL"), Some(&first.next)).await;
    assert_eq!((second.body["stk_dt_pole_chart_qry"].as_array().unwrap().len(), second.cont.as_str()), (0, "N"));
}

#[tokio::test]
async fn the_binary_prints_its_address_and_serves_admin_paths() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_fake-kiwoom"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await.unwrap().unwrap().unwrap();
    let addr: SocketAddr = line.strip_prefix("fake-kiwoom listening addr=").unwrap_or_else(|| panic!("{line}")).parse().unwrap();
    assert!(addr.ip().is_loopback() && addr.port() != 0, "{addr}");
    let base = format!("http://{addr}");
    assert_eq!(stats(&base).await, json!({"requests": 0, "issued": 0, "apiIds": []}));
    kiwoom(&base, "ka10081", daily("005930_AL"), None).await;
    assert_eq!(stats(&base).await["requests"], 1);
    child.kill().await.unwrap();
}

#[tokio::test]
async fn the_binary_refuses_a_non_loopback_bind() {
    let out = Command::new(env!("CARGO_BIN_EXE_fake-kiwoom")).args(["--bind", "0.0.0.0:0"]).output().await.unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("루프백"), "{}", String::from_utf8_lossy(&out.stderr));
}

#[tokio::test]
async fn extra_stocks_are_appended_to_the_kospi_list_only_when_asked() {
    let fake = FakeKiwoom::start().await;
    let codes = |r: Reply| r.body["list"].as_array().unwrap().iter().map(|row| row["code"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let base = fake.base_url();
    let kospi = || kiwoom(&base, "ka10099", json!({"mrkt_tp": "0"}), None);
    let plain = codes(kospi().await);
    assert!((0..1000).map(extra_stock_code).all(|c| !plain.contains(&c)), "합성 코드는 고정 입력과 겹치지 않고, 변수가 없으면 고정 입력 그대로다");
    fake.set_extra_kospi_stocks(3);
    let more = codes(kospi().await);
    assert_eq!(more[..plain.len()], plain[..]);
    assert_eq!(more[plain.len()..], [extra_stock_code(0), extra_stock_code(1), extra_stock_code(2)]);
    let kosdaq = codes(kiwoom(&base, "ka10099", json!({"mrkt_tp": "10"}), None).await);
    assert!(!kosdaq.contains(&extra_stock_code(0)), "코스닥 목록에는 붙이지 않는다");
}

#[tokio::test]
async fn krx_stock_lists_give_each_stock_its_own_zero_padded_list_count_and_leave_it_empty_for_one() {
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket::sample(domain::KstDate::new(2026, 11, 6).unwrap()));
    let base = fake.base_url();
    let mut counts = std::collections::BTreeMap::new();
    for market in ["0", "10"] {
        for row in kiwoom(&base, "ka10099", json!({"mrkt_tp": market}), None).await.body["list"].as_array().unwrap() {
            counts.insert(row["code"].as_str().unwrap().to_owned(), (market, row["listCount"].as_str().unwrap().to_owned()));
        }
    }
    assert_eq!(counts[krx::PRE_1985], ("0", "0000005919637922".to_owned()));
    assert_eq!(counts[krx::SPLIT], ("10", "0000000012000000".to_owned()));
    assert_eq!(counts[krx::NEW_LISTING], ("0", String::new()), "상장주식수가 없는 종목이 하나 있다");
    let given: std::collections::BTreeSet<&str> = counts.values().map(|(_, count)| count.as_str()).filter(|c| !c.is_empty()).collect();
    assert_eq!(given.len(), counts.len() - 1, "상장주식수는 종목마다 다르다: {counts:?}");
    assert!(given.iter().all(|c| c.len() == 16 && c.bytes().all(|b| b.is_ascii_digit())));
}

#[tokio::test]
async fn a_listed_krx_stock_can_withhold_its_daily_bars_and_still_answer_monthly_ones() {
    let fake = FakeKiwoom::start().await;
    let as_of = domain::KstDate::new(2026, 11, 6).unwrap();
    fake.set_krx_market(KrxMarket::sample(as_of).with_daily_withheld());
    let base = fake.base_url();
    let listed = kiwoom(&base, "ka10099", json!({"mrkt_tp": "0"}), None).await;
    let row = listed.body["list"].as_array().unwrap().iter().find(|r| r["code"] == krx::DAILY_WITHHELD).cloned().expect("종목 목록에 있다");
    assert_eq!((row["auditInfo"].as_str(), row["regDay"].as_str()), (Some("거래정지"), Some("20030616")));

    let daily = kiwoom(&base, "ka10081", daily(krx::DAILY_WITHHELD), None).await;
    assert_eq!((daily.status, daily.body["stk_dt_pole_chart_qry"][0]["dt"].as_str()), (200, Some("")), "일봉은 봉 없이 빈 행 하나로 답한다: {}", daily.body);

    let monthly = kiwoom(&base, "ka10083", json!({"stk_cd": krx::DAILY_WITHHELD, "base_dt": "20261106", "upd_stkpc_tp": "1"}), None).await;
    let months = monthly.body["stk_mth_pole_chart_qry"].as_array().unwrap();
    assert_eq!((months[0]["dt"].as_str(), months[1]["dt"].as_str(), monthly.cont.as_str()), (Some("20261102"), Some("20261001"), "N"), "최신 달부터, 그달 첫 관측일로 준다");
    assert!(months.iter().all(|m| m["trde_qty"].as_str().unwrap().parse::<u64>().unwrap() > 0), "월봉에는 거래량이 있다");
    assert_eq!(kiwoom(&base, "ka10083", json!({"stk_cd": krx::COMMON, "base_dt": "20261106", "upd_stkpc_tp": "1"}), None).await.body["stk_cd"], krx::COMMON, "다른 KRX 종목도 월봉을 준다");
}

#[tokio::test]
async fn a_krx_stock_can_answer_one_daily_row_with_zero_prices_or_daily_pages_that_never_end() {
    let fake = FakeKiwoom::start().await;
    let as_of = domain::KstDate::new(2026, 11, 6).unwrap();
    let zero = domain::KstDate::new(2026, 11, 4).unwrap();
    let mut market = KrxMarket::sample(as_of);
    market.stock_mut(krx::COMMON).daily = krx::DailyAnswer::ZeroPricesOn(zero);
    market.stock_mut(krx::REIT).daily = krx::DailyAnswer::EndlessPages;
    fake.set_krx_market(market);
    let base = fake.base_url();
    let prices = |r: &Reply, dt: &str| {
        let row = r.body["stk_dt_pole_chart_qry"].as_array().unwrap().iter().find(|row| row["dt"] == dt).cloned().unwrap_or_else(|| panic!("{dt} 행이 있다: {}", r.body));
        ["open_pric", "high_pric", "low_pric", "cur_prc"].map(|f| row[f].as_str().unwrap().to_owned())
    };

    let common = kiwoom(&base, "ka10081", daily(krx::COMMON), None).await;
    assert_eq!(prices(&common, "20261104"), ["0", "0", "0", "0"].map(String::from), "그날 행은 네 가격이 \"0\"이다");
    assert!(prices(&common, "20261105").iter().all(|p| p != "0"), "다른 날 행은 그대로다");

    let first = kiwoom(&base, "ka10081", daily(krx::REIT), None).await;
    let far = kiwoom(&base, "ka10081", daily(krx::REIT), Some("110070-9")).await;
    assert_eq!((first.cont.as_str(), first.next.as_str()), ("Y", "110070-1"));
    assert_eq!((far.status, far.cont.as_str(), far.next.as_str()), (200, "Y", "110070-10"), "봉이 다 떨어진 뒤에도 다음 페이지가 있다고 답한다");
    assert!(far.body["stk_dt_pole_chart_qry"].as_array().unwrap().is_empty(), "{}", far.body);
}
