use super::*;

struct ScheduledApp {
    collector: collector::Collector,
    scheduler: tokio::task::JoinHandle<()>,
    _listings: tokio::sync::watch::Sender<Option<Vec<domain::SymbolInfo>>>,
}

impl std::ops::Deref for ScheduledApp {
    type Target = collector::Collector;
    fn deref(&self) -> &Self::Target { &self.collector }
}

impl Drop for ScheduledApp { fn drop(&mut self) { self.scheduler.abort(); } }

impl ScheduledApp {
    async fn launch(fake: &Fake, path: &std::path::Path, clock: Clock) -> Self {
        let service = Financials::new(Some(fake.client()), Store::open(path).await.unwrap(), clock.clone());
        let collector = collector::Collector::attach(service, clock, &[("005930", false)]);
        let (_listings, scheduler) = collector.start_automatic().await;
        Self { collector, scheduler, _listings }
    }
}

async fn listing_count(fake: &Fake, count: usize) {
    fake.wait_for_call("list.json", count).await;
}

#[tokio::test]
async fn seven_oclock_checks_run_without_reads_and_manual_overlap_joins_the_same_job() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
    let clock = Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 6, 50, 0));
    let app = ScheduledApp::launch(&fake, &dir.path().join("f.db"), clock.clone()).await;
    listing_count(&fake, 1).await;
    let initial = app.finished(&fake).await;
    assert_eq!(initial["historyComplete"], true);
    fake.state.lock().unwrap().paused_list = true;
    app.clock.jump(600);
    fake.wait_for_call("listing_stream", 1).await;
    let manual = app.start().await;
    assert_eq!(manual["id"].as_u64().unwrap(), initial["id"].as_u64().unwrap() + 1);
    assert_eq!(app.start().await["id"], manual["id"]);
    fake.state.lock().unwrap().paused_list = false;
    let done = app.finished(&fake).await;
    assert_eq!(done["id"], manual["id"]);
    assert_eq!(fake.count("list.json"), 2);
    assert_eq!(report_calls(&fake, "11013"), 1, "unchanged statement confirmations must not download data again");
    assert_eq!(done["nextCheckAt"], kst(KstDate::new(2016, 1, 1).unwrap(), 7, 0, 0).unix());
}

#[tokio::test]
async fn daily_confirmation_preempts_history_and_refreshes_old_corrections_before_missing_history() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
    let path = dir.path().join("f.db");
    let seed = ScheduledApp::launch(&fake, &path, Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 12, 0, 0))).await;
    listing_count(&fake, 1).await;
    assert_eq!(seed.finished(&fake).await["historyComplete"], true);
    drop(seed);
    {
        let mut state = fake.state.lock().unwrap();
        state.stream_paused_report = Some("11013".into());
        state.stream_paused_year = Some("2016".into());
    }
    let clock = Clock::fake(kst(KstDate::new(2020, 1, 1).unwrap(), 6, 0, 0));
    let app = ScheduledApp::launch(&fake, &path, clock.clone()).await;
    fake.wait_for_call("statement_stream", 1).await;
    let history = app.status().await;
    assert_eq!(history["phase"], "history");
    assert_eq!(history["completedCompanies"], 1);
    let offset = fake.state.lock().unwrap().calls.len();
    fake.state.lock().unwrap().correction = true;
    clock.jump(3600);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let job = app.status().await;
            if job["latestCheckPending"] == true { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("a due latest check must wait for the inflight history response, then take priority");
    fake.state.lock().unwrap().stream_paused_report = None;
    let done = app.finished(&fake).await;
    assert_eq!(done["id"], history["id"], "daily and historical work share one active job");
    assert_eq!(done["historyComplete"], true, "{done}");
    let calls = fake.state.lock().unwrap().calls[offset..].to_vec();
    let latest = calls.iter().position(|(name, _)| name == "list.json").unwrap();
    let correction = calls.iter().position(|(name, params)| name == "fnlttSinglAcntAll.json" && params["bsns_year"] == "2015").unwrap();
    let resumed_history = calls.iter().enumerate().skip(latest + 1).find(|(_, (name, params))| name == "fnlttSinglAcntAll.json" && params["bsns_year"] == "2016").unwrap().0;
    assert!(latest < correction && correction < resumed_history, "latest disclosures and even old corrections precede remaining missing history: {calls:?}");
    let page = app.get("/api/symbols/005930/financials?period=Y").await;
    assert_eq!(page["series"][0]["points"][0]["value"], 120.0);
}

#[tokio::test]
async fn automatic_dates_and_restart_preserve_user_and_authentication_stops_until_explicit_resume() {
    for user in [true, false] {
        let fake = Fake::start().await;
        if user { fake.state.lock().unwrap().stream_paused_report = Some("11013".into()); }
        else { fake.state.lock().unwrap().failures.insert("list.json".into(), "010".into()); }
        let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
        let path = dir.path().join("f.db");
        let clock = Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 6, 0, 0));
        let app = ScheduledApp::launch(&fake, &path, clock.clone()).await;
            listing_count(&fake, 1).await;
        if user {
            fake.wait_for_call("statement_stream", 1).await;
            app.pause().await;
            fake.state.lock().unwrap().stream_paused_report = None;
        }
        let stopped = app.finished(&fake).await;
        assert_eq!(stopped["stopReason"], if user { "user" } else { "authentication" });
        let calls = fake.state.lock().unwrap().calls.len();
        clock.jump(2 * 86400);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
        drop(app);
        let restarted = ScheduledApp::launch(&fake, &path, Clock::fake(kst(KstDate::new(2016, 1, 3).unwrap(), 12, 0, 0))).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        let saved = restarted.status().await;
        assert_eq!(saved["stopReason"], stopped["stopReason"]);
        assert!(saved["nextCheckAt"].is_null());
        assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
        fake.state.lock().unwrap().failures.clear();
        restarted.resume().await;
        let done = restarted.finished(&fake).await;
        assert_eq!(done["id"], stopped["id"]);
        assert_eq!(done["throughYear"], 2016, "explicit resume handles current data before continuing old history");
        assert_eq!(done["historyComplete"], true, "{done}");
    }
}

#[tokio::test]
async fn automatic_limit_confirmation_uses_one_request_and_waits_until_the_next_saved_check() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().failures.insert("list.json".into(), "020".into());
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
    let path = dir.path().join("f.db");
    let clock = Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 6, 0, 0));
    let app = ScheduledApp::launch(&fake, &path, clock.clone()).await;
    listing_count(&fake, 1).await;
    assert_eq!(app.finished(&fake).await["stopReason"], "rate_limited");
    let calls = fake.state.lock().unwrap().calls.len();
    clock.jump(3600);
    listing_count(&fake, 2).await;
    let limited = app.finished(&fake).await;
    assert_eq!(limited["stopReason"], "rate_limited");
    assert_eq!(limited["nextCheckAt"], kst(KstDate::new(2016, 1, 1).unwrap(), 7, 0, 0).unix());
    assert_eq!(fake.state.lock().unwrap().calls.len(), calls + 1, "a limited confirmation must not release other work or retry itself");
    drop(app);
    let clock = Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 8, 0, 0));
    let restarted = ScheduledApp::launch(&fake, &path, clock.clone()).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(fake.state.lock().unwrap().calls.len(), calls + 1, "restart before the saved confirmation time must not send a probe");
    fake.state.lock().unwrap().failures.clear();
    clock.jump(86400);
    listing_count(&fake, 3).await;
    let done = restarted.finished(&fake).await;
    assert_eq!(done["historyComplete"], true, "{done}");
    assert_eq!(done["throughYear"], 2016);
    assert_eq!(fake.count("list.json"), 4, "one successful confirmation then one listing of the current date");
    assert_eq!(done["nextCheckAt"], kst(KstDate::new(2016, 1, 2).unwrap(), 7, 0, 0).unix());
}

#[tokio::test]
async fn automatic_restart_resumes_an_interrupted_checkpoint_without_redownloading_successes() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().stream_paused_report = Some("11014".into());
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
    let collector = collector::Collector::open(&fake, dir.path(), "20151231120000", &[("005930", false)]).await;
    let (_listings, _scheduler) = collector.start_automatic().await;
    fake.wait_for_call("statement_stream", 1).await;
    let interrupted = collector.status().await;
    assert_eq!(report_calls(&fake, "11013"), 1);
    collector.crash().await;
    fake.state.lock().unwrap().stream_paused_report = None;
    let restarted = collector::Collector::open(&fake, dir.path(), "20151231130000", &[("005930", false)]).await;
    let (_listings, _scheduler) = restarted.start_automatic().await;
    fake.wait_for_source("report 11011", || report_calls(&fake, "11011") > 0).await;
    let done = restarted.finished(&fake).await;
    assert_eq!(done["id"], interrupted["id"]);
    assert_eq!(done["historyComplete"], true);
    assert_eq!(fake.count("list.json"), 1);
    assert_eq!(report_calls(&fake, "11013"), 1);
}

#[tokio::test]
async fn automatic_storage_failure_keeps_progress_without_retry_loops_and_reopens_after_repair() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
    let path = dir.path().join("f.db");
    Store::open(&path).await.unwrap();
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_auto BEFORE INSERT ON companies BEGIN SELECT RAISE(FAIL,'synthetic automatic checkpoint failure'); END").execute(&mut connection).await.unwrap();
    let clock = Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 12, 0, 0));
    let app = ScheduledApp::launch(&fake, &path, clock.clone()).await;
    fake.wait_for_call("company.json", 1).await;
    let failed = app.finished(&fake).await;
    assert_eq!(failed["stopReason"], "storage", "{failed}");
    assert_eq!(failed["completedCompanies"], 0);
    assert_eq!(failed["historyComplete"], false);
    let calls = fake.state.lock().unwrap().calls.len();
    clock.jump(86400);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(fake.state.lock().unwrap().calls.len(), calls);
    drop(app);
    sqlx::query("DROP TRIGGER fail_auto").execute(&mut connection).await.unwrap();
    let restarted = ScheduledApp::launch(&fake, &path, Clock::fake(kst(KstDate::new(2016, 1, 1).unwrap(), 12, 0, 0))).await;
    listing_count(&fake, 1).await;
    let done = restarted.finished(&fake).await;
    assert_eq!(done["id"], failed["id"]);
    assert_eq!(done["historyComplete"], true, "{done}");
}

#[tokio::test]
async fn upgrading_an_old_completed_scope_checks_the_current_year_despite_a_recent_completion_time() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
    let path = dir.path().join("f.db");
    Store::open(&path).await.unwrap();
    let now = kst(KstDate::new(2016, 1, 1).unwrap(), 12, 0, 0);
    let legacy = json!({"id":1,"status":"ready","phase":"complete","from_year":2015,"through_year":2015,"targets":[],"companies":{},"started_at":1451530800_i64,"checked_at":now.unix()});
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("INSERT INTO financial_update VALUES (1, ?)").bind(legacy.to_string()).execute(&mut connection).await.unwrap();
    let app = ScheduledApp::launch(&fake, &path, Clock::fake(now)).await;
    listing_count(&fake, 1).await;
    let done = app.finished(&fake).await;
    assert_eq!(done["id"], 2);
    assert_eq!(done["throughYear"], 2016);
    assert_eq!(done["historyComplete"], true);
}

#[tokio::test]
async fn legacy_upgrade_uses_disclosure_confirmation_times_instead_of_the_end_of_history() {
    use sqlx::Connection;
    for checked_after_seven in [false, true] {
        let fake = Fake::start().await;
        let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
        let path = dir.path().join("f.db");
        let date = KstDate::new(2016, 1, 1).unwrap();
        let seed = ScheduledApp::launch(&fake, &path, Clock::fake(kst(date, 6, 0, 0))).await;
            listing_count(&fake, 1).await;
        let previous = seed.finished(&fake).await;
        drop(seed);
        let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
        sqlx::query("UPDATE financial_update SET body = json_set(json_remove(body, '$.requested_for', '$.generation', '$.check_started_at'), '$.checked_at', ?)").bind(kst(date, 9, 0, 0).unix()).execute(&mut connection).await.unwrap();
        sqlx::query("UPDATE companies SET body = json_set(body, '$.last_checked_at', ?)").bind(kst(date, if checked_after_seven { 8 } else { 6 }, 0, 0).unix()).execute(&mut connection).await.unwrap();
        let calls = fake.state.lock().unwrap().calls.len();
        let app = ScheduledApp::launch(&fake, &path, Clock::fake(kst(date, 9, 0, 0))).await;
        if checked_after_seven {
            tokio::time::sleep(Duration::from_millis(600)).await;
            assert_eq!(fake.state.lock().unwrap().calls.len(), calls, "verified post-07:00 confirmations must not be repeated after upgrade");
        } else { listing_count(&fake, 2).await; }
        let done = app.finished(&fake).await;
        assert_eq!(done["id"].as_u64().unwrap(), previous["id"].as_u64().unwrap() + u64::from(!checked_after_seven));
        assert_eq!(done["historyComplete"], true);
    }
}
