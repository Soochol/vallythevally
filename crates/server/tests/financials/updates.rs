use super::*;

fn tempdir() -> tempfile::TempDir { tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap() }

const STOCKS: &[(&str, bool)] = &[("005930", false), ("005935", true), ("000020", false), ("000810", false), ("000660", false)];
const ONE: &[(&str, bool)] = &[("005930", false)];
const TWO: &[(&str, bool)] = &[("005930", false), ("000020", false)]; 

#[tokio::test]
async fn financial_http_reads_never_resolve_or_collect_a_company() {
    let fake = Fake::start().await;
    let dir = tempdir();
    let path = dir.path().join("run/financials.db");
    Store::open_for_collection(&path).await.unwrap();
    let reader = collector::Collector::attach(Financials::read_only(&path, collector::clock_at("20171231120000")), collector::clock_at("20171231120000"), ONE);
    for _ in 0..3 {
        for suffix in ["financial-source", "financials?period=Q", "financials?period=Y"] {
            let response = reader.get(&format!("/api/symbols/005930/{suffix}")).await;
            assert_eq!(response["status"], "not_collected");
        }
    }
    assert!(fake.state.lock().unwrap().calls.is_empty());
}

#[tokio::test]
async fn recent_http_update_deduplicates_companies_coalesces_starts_and_persists_its_result() {
    let fake = Fake::start().await;
    {
        let mut state = fake.state.lock().unwrap();
        state.preferred = true;
        state.directory = Some(format!("<result><list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list><list><corp_code>{CORP}</corp_code><stock_code>000660</stock_code></list><list><corp_code>00000002</corp_code><stock_code>000020</stock_code></list></result>"));
    }
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20190101120000", STOCKS).await;
    assert_eq!(server.status().await["status"], "idle");
    assert!(fake.state.lock().unwrap().calls.is_empty());
    let first = server.start().await;
    assert_eq!(server.start().await["id"], first["id"]);
    let result = server.finished(&fake).await;
    assert_eq!(result["status"], "ready", "{result}");
    assert_eq!(result["totalCompanies"], 2);
    assert_eq!(result["completedCompanies"], 2);
    assert_eq!(result["unverifiedSymbols"], 1);
    assert_eq!(result["unverifiedDividends"], 1);
    assert_eq!(result["fromYear"], 2017);
    assert_eq!(result["throughYear"], 2019);
    let calls = fake.state.lock().unwrap().calls.clone();
    let years: std::collections::BTreeSet<_> = calls.iter().filter_map(|(_, params)| params.get("bsns_year").cloned()).collect();
    assert_eq!(years, ["2015", "2016", "2017", "2018", "2019"].map(str::to_owned).into_iter().collect());
    assert_eq!(calls.iter().filter(|(endpoint, params)| endpoint == "fnlttSinglAcntAll.json" && params.get("corp_code").is_some_and(|c| c == CORP) && params.get("bsns_year").is_some_and(|y| y == "2016") && params.get("reprt_code").is_some_and(|c| c == "11013")).count(), 2, "one company request with CFS/OFS absence fallback, shared by three securities");
    let count = calls.len();
    assert_eq!(server.get("/api/symbols/000810/financial-source").await["reason"], "company_mapping_unverified");
    for stock in ["005930", "000660", "005935", "000020"] {
        assert_eq!(server.get(&format!("/api/symbols/{stock}/financials?period=Q")).await["status"], "ready");
    }
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    server.crash().await;
    let restarted = collector::Collector::open(&fake, dir.path(), "20200101120000", STOCKS).await;
    assert_eq!(restarted.status().await, result);
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    restarted.crash().await;
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
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20171231120000", STOCKS).await;
    let initial = server.start().await;
    fake.wait_for_call("statement_stream", 1).await;
    let checkpoint = server.status().await;
    assert_eq!(checkpoint["completedCompanies"], 1);
    server.crash().await;
    fake.state.lock().unwrap().stream_paused_report = None;
    let count = fake.state.lock().unwrap().calls.len();
    let other = fake.state.lock().unwrap().calls.iter().filter(|(_, params)| params.get("corp_code").is_some_and(|corp| corp == "00000002")).count();
    let restarted = collector::Collector::open(&fake, dir.path(), "20180101120000", STOCKS).await;
    let saved = restarted.status().await;
    assert_eq!(saved["status"], "interrupted");
    assert_eq!(saved["completedCompanies"], 1);
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    assert_eq!(restarted.start().await["id"], initial["id"]);
    let result = restarted.finished(&fake).await;
    assert_eq!(result["throughYear"], 2017);
    assert_eq!(result["completedCompanies"], 2);
    let calls = fake.state.lock().unwrap().calls.clone();
    assert_eq!(calls.iter().filter(|(_, params)| params.get("corp_code").is_some_and(|corp| corp == "00000002")).count(), other);
    assert!(!calls.iter().any(|(_, params)| params.get("bsns_year").is_some_and(|year| year == "2018")), "resuming a stored job must not silently collect a different scope");
    restarted.crash().await;
}

#[tokio::test]
async fn a_company_failure_before_or_after_success_keeps_other_companies() {
    for failed in ["00000002", CORP] {
        let fake = Fake::start().await;
        {
            let mut state = fake.state.lock().unwrap();
            state.directory = Some(format!("<result><list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list><list><corp_code>00000002</corp_code><stock_code>000020</stock_code></list></result>"));
            state.failures.insert(format!("list.json///{failed}"), "900".into());
        }
        let dir = tempdir();
        let server = collector::Collector::open(&fake, dir.path(), "20171231120000", STOCKS).await;
        server.start().await;
        let job = server.finished(&fake).await;
        assert_eq!(job["status"], "partial_failure", "{job}");
        assert_eq!(job["completedCompanies"], 1);
        assert_eq!(job["failedCompanies"], 1);
        assert!(job["lastCheckedAt"].is_number());
        assert!(job["failures"].as_array().unwrap().iter().any(|entry| entry["failure"] == "remote"));
        let saved = server.get(&format!("/api/symbols/{}/financials?period=Y", if failed == CORP { "000020" } else { "005930" })).await;
        assert_eq!(saved["status"], "ready");
        assert_eq!(saved["series"][0]["points"][0]["value"], 100.0);
        let calls = fake.state.lock().unwrap().calls.len();
        assert_eq!(server.status().await, job);
        assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
        server.crash().await;
    }
}

#[tokio::test]
async fn failed_checkpoint_storage_never_announces_completion_and_can_resume_after_restart() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    let dir = tempdir();
    let path = dir.path().join("run/financials.db");
    Store::open(&path).await.unwrap();
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON financial_update WHEN NEW.body LIKE '%\"outcome\":{\"status\":\"complete\"}%' BEGIN SELECT RAISE(FAIL,'synthetic checkpoint failure'); END").execute(&mut connection).await.unwrap();
    let server = collector::Collector::open(&fake, dir.path(), "20171231120000", STOCKS).await;
    let initial = server.start().await;
    let failed = server.finished(&fake).await;
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["failure"], "storage");
    assert_eq!(failed["completedCompanies"], 0);
    assert!(failed["lastCheckedAt"].is_null());
    assert_eq!(server.get("/api/symbols/005930/financials?period=Y").await["series"][0]["points"][0]["value"], 100.0);
    server.crash().await;
    sqlx::query("DROP TRIGGER fail_checkpoint").execute(&mut connection).await.unwrap();
    let calls = fake.state.lock().unwrap().calls.len();
    let restarted = collector::Collector::open(&fake, dir.path(), "20171231120000", STOCKS).await;
    let saved = restarted.status().await;
    assert_eq!(saved["status"], "interrupted");
    assert_eq!(saved["completedCompanies"], 0);
    assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
    assert_eq!(restarted.start().await["id"], initial["id"]);
    assert_eq!(restarted.finished(&fake).await["completedCompanies"], 1);
    restarted.crash().await;
}

#[tokio::test]
async fn all_companies_recent_reports_precede_history_and_completed_history_is_reused() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().preferred = true;
    fake.state.lock().unwrap().directory = Some(format!("<result><list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list><list><corp_code>00000002</corp_code><stock_code>000020</stock_code></list></result>"));
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20200101120000", STOCKS).await;
    server.start().await;
    let job = server.finished(&fake).await;
    assert_eq!(job["status"], "ready");
    assert_eq!(job["phase"], "complete");
    assert_eq!(job["completedCompanies"], 2);
    assert_eq!(job["historyCompletedCompanies"], 2);
    assert_eq!(job["historyComplete"], true);
    let calls = fake.state.lock().unwrap().calls.clone();
    let first_history = calls.iter().position(|(_, params)| params.get("bsns_year").is_some_and(|year| year == "2016")).expect("history must begin after every company's recent/comparison range");
    let recent: std::collections::BTreeSet<_> = calls[..first_history].iter().filter(|(endpoint, _)| endpoint == "fnlttSinglAcntAll.json").map(|(_, params)| (params["corp_code"].clone(), params["bsns_year"].clone(), params["reprt_code"].clone())).collect();
    assert_eq!(recent.len(), 32);
    assert!(recent.iter().all(|(_, year, _)| ["2017", "2018", "2019", "2020"].contains(&year.as_str())));
    let history: Vec<_> = calls[first_history..].iter().filter(|(endpoint, _)| endpoint == "fnlttSinglAcntAll.json").map(|(_, params)| params["bsns_year"].clone()).collect();
    assert!(history.iter().all(|year| year == "2015" || year == "2016"));
    let stored = server.get("/api/symbols/005930/financials?period=Y").await;
    assert_eq!(stored["series"][0]["points"][0]["value"], 100.0);
    let reports = fake.count("fnlttSinglAcntAll.json");
    server.start().await;
    assert_eq!(server.finished(&fake).await["historyComplete"], true);
    assert_eq!(fake.count("fnlttSinglAcntAll.json"), reports, "confirmed absent and successful reports are both reusable");
    let previous = fake.state.lock().unwrap().calls.len();
    fake.state.lock().unwrap().correction = true;
    server.start().await;
    assert_eq!(server.finished(&fake).await["historyComplete"], true);
    let calls = fake.state.lock().unwrap().calls[previous..].to_vec();
    let last_recent_check = calls.iter().rposition(|(endpoint, _)| endpoint == "list.json").unwrap();
    let first_old_correction = calls.iter().position(|(endpoint, params)| endpoint == "fnlttSinglAcntAll.json" && params["bsns_year"] == "2015").unwrap();
    assert!(last_recent_check < first_old_correction, "a later update must confirm all companies' recent sources before refreshing stored history");
    server.crash().await;
}

#[tokio::test]
async fn user_pause_saves_the_inflight_response_stops_the_next_request_and_survives_restart() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().stream_paused_report = Some("11013".into());
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20171231120000", ONE).await;
    let initial = server.start().await;
    fake.wait_for_call("statement_stream", 1).await;
    let requested = server.pause().await;
    assert_eq!(requested["status"], "pausing");
    assert_eq!(requested["stopReason"], "user");
    fake.state.lock().unwrap().stream_paused_report = None;
    let paused = server.finished(&fake).await;
    assert_eq!(paused["status"], "paused", "{paused}");
    assert_eq!(paused["completedCompanies"], 0);
    assert_eq!(fake.count("fnlttSinglAcntAll.json"), 1);
    assert_eq!(fake.count("fnlttXbrl.xml"), 0, "pause must not assign XBRL after the inflight statement");
    let count = fake.state.lock().unwrap().calls.len();
    let saved = server.get("/api/symbols/005930/financial-source").await;
    assert!(!saved["collection"]["reports"].as_object().unwrap().is_empty(), "the inflight result is checkpointed before paused");
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    server.crash().await;
    let restarted = collector::Collector::open(&fake, dir.path(), "20180101120000", ONE).await;
    assert_eq!(restarted.status().await["status"], "paused");
    assert_eq!(restarted.start().await["status"], "paused", "ordinary starts cannot erase durable user intent");
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    assert_eq!(restarted.resume().await["id"], initial["id"]);
    assert_eq!(restarted.finished(&fake).await["historyComplete"], true);
    assert_eq!(report_calls(&fake, "11013"), 1, "saved statement rows must resume at XBRL rather than download again");
    restarted.crash().await;
}

#[tokio::test]
async fn history_checkpoint_failure_stops_before_completion_and_resumes_after_reopening() {
    use sqlx::Connection;
    for first in [true, false] {
        let fake = Fake::start().await;
        fake.state.lock().unwrap().integrated_financials = true;
        let dir = tempdir();
        let path = dir.path().join("run/financials.db");
        Store::open(&path).await.unwrap();
            let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
        let trigger = if first { "CREATE TRIGGER fail_history BEFORE INSERT ON companies BEGIN SELECT RAISE(FAIL,'synthetic history checkpoint failure'); END" } else { "CREATE TRIGGER fail_history BEFORE INSERT ON companies WHEN NEW.body LIKE '%\"2015/11011\"%' BEGIN SELECT RAISE(FAIL,'synthetic history checkpoint failure'); END" };
        sqlx::query(trigger).execute(&mut connection).await.unwrap();
        let server = collector::Collector::open(&fake, dir.path(), "20190101120000", ONE).await;
        let initial = server.start().await;
        let failed = server.finished(&fake).await;
        assert_eq!(failed["status"], "failed", "{failed}");
        assert_eq!(failed["stopReason"], "storage");
        assert_eq!(failed["completedCompanies"], if first { 0 } else { 1 });
        assert_eq!(failed["historyCompletedCompanies"], 0);
        assert_eq!(failed["historyComplete"], false);
        if !first {
            let saved = server.get("/api/symbols/005930/financials?period=Y").await;
            assert_eq!(saved["series"][0]["points"].as_array().unwrap().iter().find(|point| point["businessYear"] == 2016).unwrap()["value"], 1000.0);
        }
        sqlx::query("DROP TRIGGER fail_history").execute(&mut connection).await.unwrap();
        let recent_calls = || fake.state.lock().unwrap().calls.iter().filter(|(_, params)| params.get("bsns_year").is_some_and(|year| year.as_str() >= "2016")).count();
        let before = recent_calls();
        server.crash().await;
        connection.close().await.unwrap();
        let reopened = collector::Collector::open(&fake, dir.path(), "20190101120000", ONE).await;
        assert_eq!(reopened.status().await["status"], "interrupted");
        assert_eq!(recent_calls(), before);
        assert_eq!(reopened.resume().await["id"], initial["id"]);
        let done = reopened.finished(&fake).await;
        assert_eq!(done["historyComplete"], true, "{done}");
        if !first { assert_eq!(recent_calls(), before, "reopening a historical failure does not collect completed recent reports again"); }
        reopened.crash().await;
    }
}

#[tokio::test]
async fn resuming_keeps_confirmed_absence_and_continues_the_pending_separate_request() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().stream_paused_report = Some("11014".into());
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20190101120000", ONE).await;
    server.start().await;
    fake.wait_for_call("statement_stream", 1).await;
    server.pause().await;
    fake.state.lock().unwrap().stream_paused_report = None;
    assert_eq!(server.finished(&fake).await["status"], "paused");
    let saved = server.get("/api/symbols/005930/financial-source").await;
    assert_eq!(saved["collection"]["reports"]["2016/11013"]["statement"]["absent"], true);
    server.crash().await;
    let reopened = collector::Collector::open(&fake, dir.path(), "20200101120000", ONE).await;
    reopened.resume().await;
    assert_eq!(reopened.finished(&fake).await["historyComplete"], true);
    let calls = fake.state.lock().unwrap().calls.clone();
    for report in ["11013", "11014"] {
        assert_eq!(calls.iter().filter(|(endpoint, params)| endpoint == "fnlttSinglAcntAll.json" && params["bsns_year"] == "2016" && params["reprt_code"] == report).count(), 2, "{report}: confirmed CFS absence and completed OFS absence are reusable after a new-day restart");
    }
    reopened.crash().await;
}

#[tokio::test]
async fn pausing_an_inflight_listing_page_keeps_it_separate_and_resumes_the_next_page() {
    let fake = Fake::start().await;
    { let mut state = fake.state.lock().unwrap(); state.paused_list = true; state.list_pages = true; }
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20151231120000", ONE).await;
    server.start().await;
    fake.wait_for_call("listing_stream", 1).await;
    assert_eq!(server.pause().await["status"], "pausing");
    fake.state.lock().unwrap().paused_list = false;
    assert_eq!(server.finished(&fake).await["status"], "paused");
    let saved = server.get("/api/symbols/005930/financial-source").await;
    assert!(saved["collection"]["disclosures"].as_array().unwrap().is_empty(), "an incomplete listing must not become the validated snapshot");
    server.crash().await;
    let reopened = collector::Collector::open(&fake, dir.path(), "20160101120000", ONE).await;
    reopened.resume().await;
    assert_eq!(reopened.finished(&fake).await["historyComplete"], true);
    let calls = fake.state.lock().unwrap().calls.clone();
    for page in ["1", "2"] {
        assert_eq!(calls.iter().filter(|(endpoint, params)| endpoint == "list.json" && params["page_no"] == page).count(), 1, "page {page} must only download once across pause and restart");
    }
    reopened.crash().await;
}

#[tokio::test]
async fn response_checkpoint_failure_stops_without_completion_and_reopens_without_persisting_secrets() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    let dir = tempdir();
    let path = dir.path().join("run/financials.db");
    Store::open(&path).await.unwrap();
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_response BEFORE INSERT ON financial_requests WHEN NEW.request LIKE 'json/list.json/%' BEGIN SELECT RAISE(FAIL,'synthetic response checkpoint failure'); END").execute(&mut connection).await.unwrap();
    let server = collector::Collector::open(&fake, dir.path(), "20151231120000", ONE).await;
    server.start().await;
    let failed = server.finished(&fake).await;
    assert_eq!(failed["stopReason"], "storage");
    assert_eq!(failed["completedCompanies"], 0);
    assert_eq!(failed["historyComplete"], false);
    sqlx::query("DROP TRIGGER fail_response").execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    server.crash().await;
    let reopened = collector::Collector::open(&fake, dir.path(), "20160101120000", ONE).await;
    assert_eq!(reopened.status().await["status"], "interrupted");
    reopened.resume().await;
    assert_eq!(reopened.finished(&fake).await["historyComplete"], true);
    reopened.crash().await;
    for entry in std::fs::read_dir(dir.path().join("run")).unwrap().map(Result::unwrap).filter(|entry| entry.file_name().to_string_lossy().starts_with("financials.db")) {
        let bytes = std::fs::read(entry.path()).unwrap();
        assert!(!bytes.windows(KEY.len()).any(|window| window == KEY.as_bytes()), "response and archive checkpoints must not contain authentication secrets");
    }
}

#[tokio::test]
async fn a_terminal_update_allows_the_next_start_to_create_a_new_job() {
    let fake = Fake::start().await;
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20151231120000", ONE).await;
    let mut job = server.start().await;
    for _ in 0..5 {
        let terminal = server.finished(&fake).await;
        assert_eq!(terminal["historyComplete"], true);
        assert_eq!(terminal["id"], job["id"]);
        job = server.start().await;
        assert_eq!(job["id"].as_u64().unwrap(), terminal["id"].as_u64().unwrap() + 1, "a published terminal status cannot coalesce a subsequent update into the finished job");
    }
    server.finished(&fake).await;
    server.crash().await;
}

#[tokio::test]
async fn authentication_stops_the_whole_job_and_requires_successful_explicit_confirmation_after_restart() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().preferred = true;
    fake.state.lock().unwrap().failures.insert("corpCode.xml".into(), "010".into());
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20151231120000", STOCKS).await;
    let initial = server.start().await;
    let stopped = server.finished(&fake).await;
    assert_eq!(stopped["status"], "stopped", "{stopped}");
    assert_eq!(stopped["stopReason"], "authentication");
    assert_eq!(stopped["failure"], "authentication");
    assert_eq!(stopped["processedSymbols"], stopped["unsupportedSymbols"], "authentication must not consume a pending company target");
    assert_eq!(fake.count("corpCode.xml"), 1);
    assert!(!stopped.to_string().contains(KEY));
    server.crash().await;
    let reopened = collector::Collector::open(&fake, dir.path(), "20160101120000", STOCKS).await;
    assert_eq!(reopened.status().await["stopReason"], "authentication");
    reopened.resume().await;
    let still_stopped = reopened.finished(&fake).await;
    assert_eq!(still_stopped["status"], "stopped");
    assert_eq!(fake.count("corpCode.xml"), 2, "explicit confirmation may send one request, never the pending company requests");
    fake.state.lock().unwrap().failures.clear();
    reopened.resume().await;
    let done = reopened.finished(&fake).await;
    assert_eq!(done["historyComplete"], true, "a repaired source configuration may retain the same API key: {done}");
    assert_eq!(reopened.status().await["id"], initial["id"]);
    reopened.crash().await;
}

#[tokio::test]
async fn rate_limit_at_first_or_middle_request_persists_and_only_one_confirmation_can_open_it() {
    for endpoint in ["corpCode.xml", "fnlttSinglAcntAll.json/2015/11014"] {
        let fake = Fake::start().await;
        fake.state.lock().unwrap().failures.insert(endpoint.into(), "020".into());
        let dir = tempdir();
        let server = collector::Collector::open(&fake, dir.path(), "20151231120000", ONE).await;
        let initial = server.start().await;
        let stopped = server.finished(&fake).await;
        assert_eq!(stopped["status"], "stopped", "{stopped}");
        assert_eq!(stopped["stopReason"], "rate_limited");
        assert_eq!(stopped["nextCheckAt"], kst(KstDate::new(2016, 1, 1).unwrap(), 7, 0, 0).unix());
        let count = fake.state.lock().unwrap().calls.len();
        assert_eq!(server.start().await["status"], "stopped");
        assert_eq!(fake.state.lock().unwrap().calls.len(), count);
        server.crash().await;
        let reopened = collector::Collector::open(&fake, dir.path(), "20160101070000", ONE).await;
        assert_eq!(reopened.status().await["nextCheckAt"], stopped["nextCheckAt"]);
        assert_eq!(fake.state.lock().unwrap().calls.len(), count);
        reopened.resume().await;
        let limited = reopened.finished(&fake).await;
        assert_eq!(limited["status"], "stopped");
        assert_eq!(limited["nextCheckAt"], kst(KstDate::new(2016, 1, 2).unwrap(), 7, 0, 0).unix());
        assert_eq!(fake.state.lock().unwrap().calls.len(), count + 1, "a still-limited confirmation must not release any other request");
        let first_report_calls = report_calls(&fake, "11013");
        fake.state.lock().unwrap().failures.insert(endpoint.into(), "900".into());
        reopened.resume().await;
        let unconfirmed = reopened.finished(&fake).await;
        assert_eq!(unconfirmed["stopReason"], "rate_limited", "an unsuccessful confirmation must keep the global stop");
        assert_eq!(fake.state.lock().unwrap().calls.len(), count + 2, "a confirmation with a remote error has a one-request budget too");
        fake.state.lock().unwrap().failures.clear();
        reopened.resume().await;
        let done = reopened.finished(&fake).await;
        assert_eq!(done["id"], initial["id"]);
        assert_eq!(done["historyComplete"], true, "{done}");
        assert!(done["nextCheckAt"].is_null());
        if endpoint != "corpCode.xml" { assert_eq!(report_calls(&fake, "11013"), first_report_calls, "saved successful reports must survive a global stop"); }
        let failed_endpoint_calls = fake.state.lock().unwrap().calls.iter().filter(|(name, params)| if endpoint == "corpCode.xml" { name == endpoint } else { name == "fnlttSinglAcntAll.json" && params["reprt_code"] == "11014" }).count();
        assert_eq!(failed_endpoint_calls, 4, "initial failure, two failed confirmations, one successful confirmation; reuse its response");
        reopened.crash().await;
    }
}

#[tokio::test]
async fn a_company_remote_failure_has_a_bounded_retry_budget_and_preserves_previous_values() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().directory = Some(format!("<result><list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list><list><corp_code>00000002</corp_code><stock_code>000020</stock_code></list></result>"));
    let dir = tempdir();
    let server = collector::Collector::open_spaced(&fake, dir.path(), "20151231120000", TWO, Duration::from_millis(250)).await;
    server.start().await;
    assert_eq!(server.finished(&fake).await["historyComplete"], true);
    let before = server.get("/api/symbols/005930/financial-source").await;
    let offset = fake.state.lock().unwrap().calls.len();
    {
        let mut state = fake.state.lock().unwrap();
        state.correction = true;
        state.failures.insert(format!("fnlttSinglAcntAll.json/2015/11014/{CORP}"), "900".into());
    }
    server.start().await;
    let job = server.finished(&fake).await;
    assert_eq!(job["status"], "partial_failure");
    assert_eq!(job["failedCompanies"], 1);
    assert_eq!(job["completedCompanies"], 1);
    let calls = fake.state.lock().unwrap().calls[offset..].to_vec();
    assert!(fake.state.lock().unwrap().request_times.windows(2).all(|times| times[1].duration_since(times[0]) >= Duration::from_millis(200)), "all companies and retries share the DART transmission interval");
    assert_eq!(calls.iter().filter(|(name, params)| name == "fnlttSinglAcntAll.json" && params["corp_code"] == CORP && params["reprt_code"] == "11014").count(), 3, "one initial attempt and two bounded retries");
    let after = server.get("/api/symbols/005930/financial-source").await;
    assert_eq!(after["collection"]["reports"]["2015/11014"]["statement"]["last_success_at"], before["collection"]["reports"]["2015/11014"]["statement"]["last_success_at"]);
    assert_eq!(server.get("/api/symbols/005930/financials?period=Y").await["series"][0]["points"][0]["value"], 100.0);
    assert_eq!(server.get("/api/symbols/000020/financials?period=Y").await["series"][0]["points"][0]["value"], 120.0);
    let count = fake.state.lock().unwrap().calls.len();
    for _ in 0..3 { server.status().await; }
    assert_eq!(fake.state.lock().unwrap().calls.len(), count);
    server.crash().await;
}

#[tokio::test]
async fn http_authentication_and_limit_responses_stop_without_retrying_other_targets() {
    for (status, reason) in [(StatusCode::UNAUTHORIZED, "authentication"), (StatusCode::FORBIDDEN, "authentication"), (StatusCode::TOO_MANY_REQUESTS, "rate_limited")] {
        let fake = Fake::start().await;
        fake.state.lock().unwrap().http_failure = Some(status);
        let dir = tempdir();
        let server = collector::Collector::open(&fake, dir.path(), "20151231065959", STOCKS).await;
        server.start().await;
        let stopped = server.finished(&fake).await;
        assert_eq!(stopped["status"], "stopped", "{stopped}");
        assert_eq!(stopped["stopReason"], reason);
        assert_eq!(fake.count("corpCode.xml"), 1);
        server.crash().await;
    }
}

#[tokio::test]
async fn authentication_during_listing_or_xbrl_keeps_checkpoints_and_resumes_after_configuration_repair() {
    for endpoint in ["list.json", "fnlttXbrl.xml"] {
        let fake = Fake::start().await;
        fake.state.lock().unwrap().failures.insert(endpoint.into(), "012".into());
        let dir = tempdir();
        let server = collector::Collector::open(&fake, dir.path(), "20151231120000", ONE).await;
        let initial = server.start().await;
        assert_eq!(server.finished(&fake).await["stopReason"], "authentication");
        assert_eq!(fake.count(endpoint), 1);
        let calls = fake.state.lock().unwrap().calls.len();
        let statements = report_calls(&fake, "11013");
        server.crash().await;
        let reopened = collector::Collector::open(&fake, dir.path(), "20160101120000", ONE).await;
        assert_eq!(reopened.status().await["stopReason"], "authentication");
        assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
        fake.state.lock().unwrap().failures.clear();
        reopened.resume().await;
        let done = reopened.finished(&fake).await;
        assert_eq!(done["id"], initial["id"]);
        assert_eq!(done["historyComplete"], true, "{done}");
        if endpoint == "fnlttXbrl.xml" { assert_eq!(report_calls(&fake, "11013"), statements, "saved CFS rows must resume at XBRL"); }
        reopened.crash().await;
        let bytes = std::fs::read(dir.path().join("run/financials.db")).unwrap();
        assert!(!bytes.windows(KEY.len()).any(|window| window == KEY.as_bytes()));
    }
}

#[tokio::test]
async fn missing_dart_configuration_never_dispatches_on_repeated_start_or_resume() {
    let fake = Fake::start().await;
    let dir = tempdir();
    let collector = collector::Collector::open_without_client(dir.path(), "20151231120000", ONE).await;
    for _ in 0..3 {
        let page = collector.start().await;
        assert_eq!(page["status"], "not_configured");
        assert_eq!(page["stopReason"], "not_configured");
        assert_eq!(collector.resume().await["canResume"], false);
    }
    assert!(fake.state.lock().unwrap().calls.is_empty());
}

#[tokio::test]
async fn automatic_start_catches_up_once_and_same_day_restart_does_not_create_another_job() {
    let fake = Fake::start().await;
    let dir = tempdir();
    let server = collector::Collector::open(&fake, dir.path(), "20151231070001", ONE).await;
    let (_listings_server, _scheduler_server) = server.start_automatic().await;
    fake.wait_for_call("list.json", 1).await;
    let done = server.finished(&fake).await;
    assert_eq!(done["historyComplete"], true, "{done}");
    assert_eq!(done["nextCheckAt"], kst(KstDate::new(2016, 1, 1).unwrap(), 7, 0, 0).unix());
    let calls = fake.state.lock().unwrap().calls.len();
    server.crash().await;
    let restarted = collector::Collector::open(&fake, dir.path(), "20151231220000", ONE).await;
    let (_listings_restarted, _scheduler_restarted) = restarted.start_automatic().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(restarted.status().await["id"], done["id"]);
    assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
    restarted.crash().await;
    let later = collector::Collector::open(&fake, dir.path(), "20160104120000", ONE).await;
    let (_listings_later, _scheduler_later) = later.start_automatic().await;
    fake.wait_for_call("list.json", 2).await;
    let caught_up = later.finished(&fake).await;
    assert_eq!(caught_up["id"].as_u64().unwrap(), done["id"].as_u64().unwrap() + 1, "several missed dates require one current check");
    assert_eq!(fake.count("list.json"), 2);
    assert_eq!(report_calls(&fake, "11013"), 1, "unchanged confirmed reports are reused");
    later.crash().await;
}
