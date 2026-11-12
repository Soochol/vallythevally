use super::*;

fn tempdir() -> tempfile::TempDir { tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap() }

async fn json(client: &reqwest::Client, url: &str) -> Value {
    let response = client.get(url).send().await.unwrap().error_for_status().unwrap();
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

fn listings(kiwoom: &common::FakeKiwoom) {
    let mut body = fake_kiwoom::fixture("ka10099_0");
    body["list"].as_array_mut().unwrap().retain(|row| ["005930", "005935", "000020", "000810", "0000D0"].contains(&row["code"].as_str().unwrap()));
    let mut alias = body["list"].as_array().unwrap().iter().find(|row| row["code"] == "005930").unwrap().clone();
    alias["code"] = "000660".into();
    alias["name"] = "합성 코스닥 증권".into();
    alias["marketCode"] = "10".into();
    body["list"].as_array_mut().unwrap().push(alias);
    kiwoom.seen.respond_with("ka10099", StatusCode::OK, body);
}

async fn start(client: &reqwest::Client, base: &str) -> Value {
    let response = client.post(format!("{base}/api/financial-update")).send().await.unwrap().error_for_status().unwrap();
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

async fn finished(client: &reqwest::Client, base: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let result = json(client, &format!("{base}/api/financial-update")).await;
            if result["status"] != "planning" && result["status"] != "collecting" { return result; }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }).await.unwrap()
}

#[tokio::test]
async fn financial_http_reads_never_resolve_or_collect_a_company() {
    let fake = Fake::start().await;
    let kiwoom = common::FakeKiwoom::start().await;
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    for _ in 0..3 {
        for suffix in ["financial-source", "financials?period=Q", "financials?period=Y"] {
            let response = json(&client, &format!("{base}/api/symbols/005930/{suffix}")).await;
            assert_eq!(response["status"], "not_collected");
        }
    }
    assert!(fake.state.lock().unwrap().calls.is_empty());
    server.stop().await;
}

#[tokio::test]
async fn recent_http_update_deduplicates_companies_coalesces_starts_and_persists_its_result() {
    let fake = Fake::start().await;
    {
        let mut state = fake.state.lock().unwrap();
        state.preferred = true;
        state.directory = Some(format!("<result><list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list><list><corp_code>{CORP}</corp_code><stock_code>000660</stock_code></list><list><corp_code>00000002</corp_code><stock_code>000020</stock_code></list></result>"));
    }
    let kiwoom = common::FakeKiwoom::start().await;
    listings(&kiwoom);
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20190101120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    assert_eq!(json(&client, &format!("{base}/api/symbols/000660")).await["market"], "kosdaq");
    assert_eq!(json(&client, &format!("{base}/api/financial-update")).await["status"], "idle");
    assert!(fake.state.lock().unwrap().calls.is_empty());
    let first = start(&client, &base).await;
    assert_eq!(start(&client, &base).await["id"], first["id"]);
    let result = finished(&client, &base).await;
    assert_eq!(result["status"], "ready", "{result}");
    assert_eq!(result["totalCompanies"], 2);
    assert_eq!(result["completedCompanies"], 2);
    assert_eq!(result["unverifiedSymbols"], 1);
    assert_eq!(result["unverifiedDividends"], 1);
    assert_eq!(result["fromYear"], 2017);
    assert_eq!(result["throughYear"], 2019);
    let calls = fake.state.lock().unwrap().calls.clone();
    let years: std::collections::BTreeSet<_> = calls.iter().filter_map(|(_, params)| params.get("bsns_year").cloned()).collect();
    assert_eq!(years, ["2016", "2017", "2018", "2019"].map(str::to_owned).into_iter().collect());
    assert_eq!(calls.iter().filter(|(endpoint, params)| endpoint == "fnlttSinglAcntAll.json" && params.get("corp_code").is_some_and(|c| c == CORP) && params.get("bsns_year").is_some_and(|y| y == "2016") && params.get("reprt_code").is_some_and(|c| c == "11013")).count(), 2, "one company request with CFS/OFS absence fallback, shared by three securities");
    let count = calls.len();
    assert_eq!(json(&client, &format!("{base}/api/symbols/000810/financial-source")).await["reason"], "company_mapping_unverified");
    for stock in ["005930", "000660", "005935", "000020"] {
        assert_eq!(json(&client, &format!("{base}/api/symbols/{stock}/financials?period=Q")).await["status"], "ready");
    }
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    server.stop().await;
    let restarted = process(&fake, &kiwoom, dir.path(), "20200101120000");
    let base = format!("http://{}", restarted.addr().await);
    assert_eq!(json(&client, &format!("{base}/api/financial-update")).await, result);
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    restarted.stop().await;
}

#[tokio::test]
async fn interrupted_recent_http_update_reads_checkpoints_and_resumes_the_original_scope() {
    let fake = Fake::start().await;
    {
        let mut state = fake.state.lock().unwrap();
        state.directory = Some(format!("<result><list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list><list><corp_code>00000002</corp_code><stock_code>000020</stock_code></list></result>"));
        state.stream_paused_report = Some("11014".into());
        state.stream_paused_company = Some(CORP.into());
    }
    let kiwoom = common::FakeKiwoom::start().await;
    listings(&kiwoom);
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    let initial = start(&client, &base).await;
    tokio::time::timeout(Duration::from_secs(30), async {
        while fake.count("statement_stream") == 0 { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await.unwrap();
    let checkpoint = json(&client, &format!("{base}/api/financial-update")).await;
    assert_eq!(checkpoint["completedCompanies"], 1);
    server.stop().await;
    fake.state.lock().unwrap().stream_paused_report = None;
    let count = fake.state.lock().unwrap().calls.len();
    let other = fake.state.lock().unwrap().calls.iter().filter(|(_, params)| params.get("corp_code").is_some_and(|corp| corp == "00000002")).count();
    let restarted = process(&fake, &kiwoom, dir.path(), "20180101120000");
    let base = format!("http://{}", restarted.addr().await);
    let saved = json(&client, &format!("{base}/api/financial-update")).await;
    assert_eq!(saved["status"], "interrupted");
    assert_eq!(saved["completedCompanies"], 1);
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    assert_eq!(start(&client, &base).await["id"], initial["id"]);
    let result = finished(&client, &base).await;
    assert_eq!(result["throughYear"], 2017);
    assert_eq!(result["completedCompanies"], 2);
    let calls = fake.state.lock().unwrap().calls.clone();
    assert_eq!(calls.iter().filter(|(_, params)| params.get("corp_code").is_some_and(|corp| corp == "00000002")).count(), other);
    assert!(!calls.iter().any(|(_, params)| params.get("bsns_year").is_some_and(|year| year == "2018")), "resuming a stored job must not silently collect a different scope");
    restarted.stop().await;
}

#[tokio::test]
async fn a_company_failure_before_or_after_success_keeps_other_companies_and_prices_available() {
    for failed in ["00000002", CORP] {
        let fake = Fake::start().await;
        {
            let mut state = fake.state.lock().unwrap();
            state.directory = Some(format!("<result><list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list><list><corp_code>00000002</corp_code><stock_code>000020</stock_code></list></result>"));
            state.failures.insert(format!("list.json///{failed}"), "900".into());
        }
        let kiwoom = common::FakeKiwoom::start().await;
        listings(&kiwoom);
        let dir = tempdir();
        let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
        let base = format!("http://{}", server.addr().await);
        let client = reqwest::Client::new();
        let price = format!("{base}/api/bars?symbol=005930&period=D&limit=5");
        client.get(&price).send().await.unwrap().error_for_status().unwrap();
        start(&client, &base).await;
        let job = finished(&client, &base).await;
        assert_eq!(job["status"], "partial_failure", "{job}");
        assert_eq!(job["completedCompanies"], 1);
        assert_eq!(job["failedCompanies"], 1);
        assert!(job["lastCheckedAt"].is_number());
        assert!(job["failures"].as_array().unwrap().iter().any(|entry| entry["failure"] == "remote"));
        let saved = json(&client, &format!("{base}/api/symbols/{}/financials?period=Y", if failed == CORP { "000020" } else { "005930" })).await;
        assert_eq!(saved["status"], "ready");
        assert_eq!(saved["series"][0]["points"][0]["value"], 100.0);
        tokio::time::timeout(Duration::from_secs(1), client.get(&price).send()).await.unwrap().unwrap().error_for_status().unwrap();
        let calls = fake.state.lock().unwrap().calls.len();
        assert_eq!(json(&client, &format!("{base}/api/financial-update")).await, job);
        assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
        server.stop().await;
    }
}

#[tokio::test]
async fn failed_checkpoint_storage_never_announces_completion_and_can_resume_after_restart() {
    use sqlx::Connection;
    use std::os::unix::fs::PermissionsExt;
    let fake = Fake::start().await;
    let kiwoom = common::FakeKiwoom::start().await;
    listings(&kiwoom);
    let dir = tempdir();
    let path = dir.path().join("run/financials.db");
    Store::open(&path).await.unwrap();
    std::fs::set_permissions(dir.path().join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON financial_update WHEN NEW.body LIKE '%\"outcome\":{\"status\":\"complete\"}%' BEGIN SELECT RAISE(FAIL,'synthetic checkpoint failure'); END").execute(&mut connection).await.unwrap();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    let initial = start(&client, &base).await;
    let failed = finished(&client, &base).await;
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["failure"], "storage");
    assert_eq!(failed["completedCompanies"], 0);
    assert!(failed["lastCheckedAt"].is_null());
    assert_eq!(json(&client, &format!("{base}/api/symbols/005930/financials?period=Y")).await["series"][0]["points"][0]["value"], 100.0);
    server.stop().await;
    sqlx::query("DROP TRIGGER fail_checkpoint").execute(&mut connection).await.unwrap();
    let calls = fake.state.lock().unwrap().calls.len();
    let restarted = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", restarted.addr().await);
    let saved = json(&client, &format!("{base}/api/financial-update")).await;
    assert_eq!(saved["status"], "interrupted");
    assert_eq!(saved["completedCompanies"], 0);
    assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    assert_eq!(start(&client, &base).await["id"], initial["id"]);
    assert_eq!(finished(&client, &base).await["completedCompanies"], 1);
    restarted.stop().await;
}
