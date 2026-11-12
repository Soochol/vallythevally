use super::*;

fn tempdir() -> tempfile::TempDir { tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap() }

async fn page(client: &reqwest::Client, base: &str, period: &str) -> Value {
    let response = client.get(format!("{base}/api/symbols/005930/financials?period={period}")).send().await.unwrap().error_for_status().unwrap();
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

fn point<'a>(page: &'a Value, metric: &str) -> &'a Value {
    page["series"].as_array().unwrap().iter().find(|s| s["metric"] == metric).unwrap()["points"].as_array().unwrap().iter().find(|p| p["businessYear"] == 2016 && p["reportCode"] == "11011").unwrap()
}

#[tokio::test]
async fn unchanged_manual_http_update_reuses_reports_and_actual_success_times() {
    let fake = Fake::start().await;
    let kiwoom = common::FakeKiwoom::start().await;
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20151231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    http_start(&client, &base).await;
    let before = http_settled(&client, &base).await;
    assert_eq!(before["status"], "ready");
    let endpoints = ["fnlttSinglAcntAll.json", "fnlttXbrl.xml", "alotMatter.json"];
    let counts = endpoints.map(|endpoint| fake.count(endpoint));
    let lists = fake.count("list.json");
    client.post(format!("{base}/api/symbols/005930/financials?period=Y")).send().await.unwrap().error_for_status().unwrap();
    let after = http_settled(&client, &base).await;
    assert_eq!(after["status"], "ready");
    assert_eq!(endpoints.map(|endpoint| fake.count(endpoint)), counts, "unchanged statements, XBRL and dividends must not download again");
    assert_eq!(fake.count("list.json"), lists + 1);
    for code in REPORT_CODES {
        for fetch in ["statement", "dividends"] {
            let prior = &before["collection"]["reports"][format!("2015/{code}")][fetch];
            let current = &after["collection"]["reports"][format!("2015/{code}")][fetch];
            for field in ["data", "checked_at", "last_success_at", "refresh_version"] {
                assert_eq!(current[field], prior[field], "{code}/{fetch}/{field} is actual fetch provenance");
            }
        }
    }
    let bytes = client.get(format!("{base}/api/symbols/005930/financials?period=Y")).send().await.unwrap().bytes().await.unwrap();
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(response["progress"]["pending"], 0);
    assert_eq!(response["series"][0]["points"][0]["value"], 100.0);
    server.stop().await;
}

#[tokio::test]
async fn corrected_report_http_update_reuses_comparison_periods_without_losing_quarter_cf_or_roe() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().integrated_financials = true;
    let kiwoom = common::FakeKiwoom::start().await;
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    http_start(&client, &base).await;
    let before = http_settled(&client, &base).await;
    assert_eq!(before["status"], "ready");
    assert_eq!(point(&page(&client, &base, "Q").await, "revenue")["value"], 700.0);
    let endpoints = ["fnlttSinglAcntAll.json", "fnlttXbrl.xml", "alotMatter.json"];
    let counts = endpoints.map(|endpoint| fake.count(endpoint));
    fake.state.lock().unwrap().report_corrections.insert((2016, "11011".into()));
    client.post(format!("{base}/api/symbols/005930/financials?period=Q")).send().await.unwrap().error_for_status().unwrap();
    let after = http_settled(&client, &base).await;
    assert_eq!(after["status"], "ready");
    assert_eq!(endpoints.map(|endpoint| fake.count(endpoint)), counts.map(|count| count + 1));
    let quarter = page(&client, &base, "Q").await;
    for (metric, expected) in [("revenue", 900.0), ("investing_cash_flow", -100.0), ("owner_roe", 20.0)] {
        let result = point(&quarter, metric);
        assert_eq!(result["status"], "available", "{metric}: {result}");
        assert_eq!(result["value"], expected);
    }
    assert_eq!(point(&page(&client, &base, "Y").await, "dps")["value"], 10.0);
    let unchanged = &after["collection"]["reports"]["2016/11014"]["statement"];
    for field in ["data", "checked_at", "last_success_at", "refresh_version"] {
        assert_eq!(unchanged[field], before["collection"]["reports"]["2016/11014"]["statement"][field]);
    }
    server.stop().await;
}

#[tokio::test]
async fn partial_correction_http_keeps_coherent_values_and_resumes_only_failed_reports_after_restart() {
    for failed_code in ["11014", "11011"] {
        let fake = Fake::start().await;
        fake.state.lock().unwrap().integrated_financials = true;
        let kiwoom = common::FakeKiwoom::start().await;
        let dir = tempdir();
        let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
        let base = format!("http://{}", server.addr().await);
        let client = reqwest::Client::new();
        client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
        http_start(&client, &base).await;
    let before = http_settled(&client, &base).await;
        assert_eq!(before["status"], "ready");
        let failure = format!("fnlttSinglAcntAll.json/2016/{failed_code}");
        {
            let mut state = fake.state.lock().unwrap();
            state.report_corrections.extend([(2016, "11014".into()), (2016, "11011".into())]);
            state.failures.insert(failure.clone(), "900".into());
        }
        client.post(format!("{base}/api/symbols/005930/financials?period=Q")).send().await.unwrap().error_for_status().unwrap();
        assert_eq!(http_settled(&client, &base).await["status"], "partial_failure");
        for period in ["Q", "Y"] {
            let saved = page(&client, &base, period).await;
            let revenue = point(&saved, "revenue");
            assert_eq!(revenue["status"], "available", "{failed_code}/{period}: {revenue}");
            assert_eq!(revenue["value"], if period == "Q" { 700.0 } else { 1000.0 });
            assert_eq!(point(&saved, "owner_roe")["value"], 20.0);
        }
        let quarter = page(&client, &base, "Q").await;
        assert!(point(&quarter, "revenue")["inputs"].as_array().unwrap().iter().any(|input| input["failure"] == "remote"));
        server.stop().await;
        let restarted = process(&fake, &kiwoom, dir.path(), "20171231120000");
        let base = format!("http://{}", restarted.addr().await);
        client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
        assert_eq!(point(&page(&client, &base, "Q").await, "revenue")["value"], 700.0);
        let endpoints = ["fnlttSinglAcntAll.json", "fnlttXbrl.xml", "alotMatter.json"];
        let counts = endpoints.map(|endpoint| fake.count(endpoint));
        fake.state.lock().unwrap().failures.remove(&failure);
        client.post(format!("{base}/api/symbols/005930/financials?period=Q")).send().await.unwrap().error_for_status().unwrap();
        let recovered = http_settled(&client, &base).await;
        assert_eq!(recovered["status"], "ready");
        assert_eq!(endpoints.map(|endpoint| fake.count(endpoint)), [counts[0] + 1, counts[1] + 1, counts[2]]);
        let quarter = page(&client, &base, "Q").await;
        for (metric, expected) in [("revenue", 850.0), ("investing_cash_flow", -100.0), ("owner_roe", 20.0)] {
            assert_eq!(point(&quarter, metric)["status"], "available");
            assert_eq!(point(&quarter, metric)["value"], expected);
        }
        for code in REPORT_CODES {
            let original = &before["collection"]["reports"][format!("2015/{code}")]["statement"];
            let current = &recovered["collection"]["reports"][format!("2015/{code}")]["statement"];
            assert_eq!(current["data"], original["data"]);
            assert_eq!(current["last_success_at"], original["last_success_at"]);
        }
        restarted.stop().await;
    }
}

#[tokio::test]
async fn newly_disclosed_http_report_replaces_unpublished_without_refetching_saved_reports() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().integrated_financials = true;
    let kiwoom = common::FakeKiwoom::start().await;
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    http_start(&client, &base).await;
    let before = http_settled(&client, &base).await;
    assert_eq!(before["status"], "ready");
    assert_eq!(before["collection"]["reports"]["2017/11013"]["statement"]["absent"], true);
    let known_calls = || fake.state.lock().unwrap().calls.iter().filter(|(endpoint, params)| endpoint == "fnlttSinglAcntAll.json" && params.get("bsns_year").is_some_and(|year| year == "2015" || year == "2016")).count();
    let count = known_calls();
    fake.state.lock().unwrap().report_corrections.insert((2017, "11013".into()));
    client.post(format!("{base}/api/symbols/005930/financials?period=Q")).send().await.unwrap().error_for_status().unwrap();
    let after = http_settled(&client, &base).await;
    assert_eq!(after["status"], "ready");
    let quarter = page(&client, &base, "Q").await;
    let revenue = quarter["series"][0]["points"].as_array().unwrap().iter().find(|point| point["businessYear"] == 2017 && point["reportCode"] == "11013").unwrap();
    assert_eq!(revenue["status"], "available", "{revenue}");
    assert_eq!(revenue["value"], 150.0);
    assert_eq!(known_calls(), count);
    for year in [2015, 2016] {
        for code in REPORT_CODES {
            let original = &before["collection"]["reports"][format!("{year}/{code}")]["statement"];
            let current = &after["collection"]["reports"][format!("{year}/{code}")]["statement"];
            assert_eq!(current["data"], original["data"]);
            assert_eq!(current["last_success_at"], original["last_success_at"]);
        }
    }
    server.stop().await;
}

#[tokio::test]
async fn annual_correction_http_fills_absent_statement_or_dividends_when_the_other_source_was_saved() {
    for missing in ["alotMatter.json", "fnlttSinglAcntAll.json"] {
        let fake = Fake::start().await;
        let absence = format!("{missing}/2016/11011");
        {
            let mut state = fake.state.lock().unwrap();
            state.integrated_financials = true;
            state.failures.insert(absence.clone(), "013".into());
        }
        let kiwoom = common::FakeKiwoom::start().await;
        let dir = tempdir();
        let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
        let base = format!("http://{}", server.addr().await);
        let client = reqwest::Client::new();
        client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
        http_start(&client, &base).await;
    let before = http_settled(&client, &base).await;
        assert_eq!(before["status"], "ready");
        let fetch = if missing == "alotMatter.json" { "dividends" } else { "statement" };
        assert_eq!(before["collection"]["reports"]["2016/11011"][fetch]["absent"], true);
        let endpoints = ["fnlttSinglAcntAll.json", "fnlttXbrl.xml", "alotMatter.json"];
        let counts = endpoints.map(|endpoint| fake.count(endpoint));
        {
            let mut state = fake.state.lock().unwrap();
            state.failures.remove(&absence);
            state.report_corrections.insert((2016, "11011".into()));
        }
        client.post(format!("{base}/api/symbols/005930/financials?period=Y")).send().await.unwrap().error_for_status().unwrap();
        assert_eq!(http_settled(&client, &base).await["status"], "ready");
        let annual = page(&client, &base, "Y").await;
        assert_eq!(point(&annual, "revenue")["value"], 1200.0, "{missing}");
        assert_eq!(point(&annual, "dps")["value"], 10.0, "{missing}: {}", point(&annual, "dps"));
        assert_eq!(endpoints.map(|endpoint| fake.count(endpoint)), counts.map(|count| count + 1));
        server.stop().await;
    }
}

#[tokio::test]
async fn legacy_http_snapshot_without_versions_keeps_coherent_values_during_partial_correction() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    fake.state.lock().unwrap().integrated_financials = true;
    let kiwoom = common::FakeKiwoom::start().await;
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    http_start(&client, &base).await;
    let before = http_settled(&client, &base).await;
    assert_eq!(before["status"], "ready");
    server.stop().await;
    {
        let mut state = fake.state.lock().unwrap();
        state.report_corrections.extend([(2016, "11014".into()), (2016, "11011".into())]);
        state.failures.insert("fnlttSinglAcntAll.json/2016/11014".into(), "900".into());
    }
    let mut legacy = before["collection"].clone();
    legacy["disclosures"] = serde_json::to_value(fake.client().disclosures(CORP, "20171231").await.unwrap()).unwrap();
    legacy["last_attempt_at"] = Value::Null;
    for field in ["refresh_version", "disclosure_version", "unpublished_check_version", "staged_reports"] { legacy.as_object_mut().unwrap().remove(field); }
    for report in legacy["reports"].as_object_mut().unwrap().values_mut() {
        for fetch in ["statement", "dividends"] {
            report[fetch].as_object_mut().unwrap().remove("refresh_version");
            report[fetch].as_object_mut().unwrap().remove("validated_version");
        }
    }
    let path = dir.path().join("run/financials.db");
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(path)).await.unwrap();
    sqlx::query("UPDATE companies SET body = ? WHERE corp_code = ?").bind(legacy.to_string()).bind(CORP).execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    let restarted = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", restarted.addr().await);
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    http_start(&client, &base).await;
    assert_eq!(http_settled(&client, &base).await["status"], "partial_failure");
    let quarter = page(&client, &base, "Q").await;
    assert_eq!(point(&quarter, "revenue")["value"], 700.0, "legacy zero versions must not make old and corrected receipts compatible");
    assert_eq!(point(&quarter, "owner_roe")["value"], 20.0);
    assert_eq!(point(&page(&client, &base, "Y").await, "revenue")["value"], 1000.0);
    restarted.stop().await;
}

#[tokio::test]
async fn unchanged_http_inputs_remain_coherent_while_one_saved_report_is_retrying() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    fake.state.lock().unwrap().integrated_financials = true;
    let kiwoom = common::FakeKiwoom::start().await;
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    http_start(&client, &base).await;
    let before = http_settled(&client, &base).await;
    assert_eq!(before["status"], "ready");
    server.stop().await;
    let mut saved = before["collection"].clone();
    saved["reports"]["2016/11013"]["statement"]["failure"] = "network".into();
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("run/financials.db"))).await.unwrap();
    sqlx::query("UPDATE companies SET body = ? WHERE corp_code = ?").bind(saved.to_string()).bind(CORP).execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    fake.state.lock().unwrap().stream_paused_report = Some("11013".into());
    let endpoints = ["fnlttSinglAcntAll.json", "fnlttXbrl.xml", "alotMatter.json"];
    let counts = endpoints.map(|endpoint| fake.count(endpoint));
    let restarted = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", restarted.addr().await);
    client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.unwrap().error_for_status().unwrap();
    client.post(format!("{base}/api/symbols/005930/financials?period=Q")).send().await.unwrap().error_for_status().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while fake.count("statement_stream") == 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    let during = page(&client, &base, "Q").await;
    fake.state.lock().unwrap().stream_paused_report = None;
    assert_eq!(during["status"], "collecting");
    assert_eq!(point(&during, "owner_roe")["value"], 20.0, "reusing unchanged inputs must not temporarily split their validation snapshot");
    assert_eq!(http_settled(&client, &base).await["status"], "ready");
    assert_eq!(endpoints.map(|endpoint| fake.count(endpoint)), [counts[0] + 1, counts[1] + 1, counts[2]]);
    restarted.stop().await;
}
