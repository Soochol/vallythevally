use std::time::Duration;

use domain::KstDate;
use fake_kiwoom::{FakeKiwoom, KrxBar, ScriptedReply, summary};
use serde_json::{Value, json};

fn row(code: &str) -> Value {
    summary::row(code, KrxBar {
        day: KstDate::new(2026, 11, 12).unwrap(), open: 1_000, high: 1_200, low: 900,
        close: 1_100, volume: 10, traded_million_won: 2, base: 1_050, adjustment_rate: None,
    }, "101112")
}

async fn quote(fake: &FakeKiwoom) -> (u16, Value) {
    let response = reqwest::Client::new().post(format!("{}/api/dostk/stkinfo", fake.base_url()))
        .header("api-id", "ka10095").header("content-type", "application/json").body(json!({"stk_cd": "000001|000002|000003"}).to_string()).send().await.unwrap();
    (response.status().as_u16(), serde_json::from_str(&response.text().await.unwrap()).unwrap())
}

#[tokio::test]
async fn synthetic_quote_rows_preserve_date_time_values_order_and_omissions() {
    let fake = FakeKiwoom::start().await;
    fake.set_quote_rows(vec![row("000002"), row("000001"), row("000004")]);
    let (status, response) = quote(&fake).await;
    assert_eq!(status, 200);
    assert_eq!(response["atn_stk_infr"], json!([row("000002"), row("000001")]));
    fake.seen.reset();
    let (_, response) = quote(&fake).await;
    assert_ne!(response["atn_stk_infr"], json!([row("000002"), row("000001")]));
}

#[tokio::test]
async fn scripted_requests_have_independent_failures_and_delays_then_resume_normal_quotes() {
    let fake = FakeKiwoom::start().await;
    fake.set_quote_rows(vec![row("000001")]);
    fake.script("ka10095", vec![
        ScriptedReply { status: 503, body: json!({"return_code": 2, "return_msg": "합성 실패"}), delay: Duration::from_millis(40) },
        ScriptedReply { status: 200, body: json!({"return_code": 0, "atn_stk_infr": []}), delay: Duration::ZERO },
    ]);
    let start = std::time::Instant::now();
    assert_eq!(quote(&fake).await.0, 503);
    assert!(start.elapsed() >= Duration::from_millis(40));
    assert_eq!(quote(&fake).await.1["atn_stk_infr"], json!([]));
    assert_eq!(quote(&fake).await.1["atn_stk_infr"], json!([row("000001")]));
}

#[tokio::test]
async fn http_scripts_and_expanded_market_drive_multiple_summary_batches() {
    let fake = FakeKiwoom::start().await;
    let client = reqwest::Client::new();
    let market = client.post(format!("{}/_fake/krx-market", fake.base_url()))
        .header("content-type", "application/json").body(json!({"asOf": "20261106", "extraStocks": 91}).to_string()).send().await.unwrap();
    assert_eq!(market.status(), 204);
    let market = fake.seen.krx_market.lock().unwrap().clone().unwrap();
    assert_eq!(market.stocks.len(), 101);
    let codes = market.stocks.iter().map(|s| s.code.as_str()).collect::<Vec<_>>().join("|");
    let request = || client.post(format!("{}/api/dostk/stkinfo", fake.base_url()))
        .header("api-id", "ka10095").header("content-type", "application/json").body(json!({"stk_cd": codes}).to_string());
    let normal: Value = serde_json::from_str(&request().send().await.unwrap().text().await.unwrap()).unwrap();
    assert_eq!(normal["atn_stk_infr"].as_array().unwrap().len(), 101);
    let script = client.post(format!("{}/_fake/script", fake.base_url())).header("content-type", "application/json").body(json!({
        "apiId": "ka10095", "replies": [{"status": 200, "body": {"atn_stk_infr": [row("000001")]}}, {"status": 503, "body": {"return_code": 2}}],
    }).to_string()).send().await.unwrap();
    assert_eq!(script.status(), 204);
    let first: Value = serde_json::from_str(&request().send().await.unwrap().text().await.unwrap()).unwrap();
    assert_eq!(first["atn_stk_infr"], json!([row("000001")]));
    assert_eq!(request().send().await.unwrap().status(), 503);
    let resumed: Value = serde_json::from_str(&request().send().await.unwrap().text().await.unwrap()).unwrap();
    assert_eq!(resumed["atn_stk_infr"], normal["atn_stk_infr"]);
    let invalid = client.post(format!("{}/_fake/script", fake.base_url()))
        .header("content-type", "application/json").body(json!({"apiId": "ka10095", "replies": [{"status": 0, "body": {}}]}).to_string()).send().await.unwrap();
    assert_eq!(invalid.status(), 400);
}
