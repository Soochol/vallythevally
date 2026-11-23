use super::*;
use server::{financials::{WriterError, writer_lock_path}, instance::InstanceLock};
use sqlx::{Connection, Row};

fn samsung() -> domain::SymbolInfo {
    domain::SymbolInfo { symbol: domain::Symbol::parse("005930").unwrap(), name: "삼성전자".into(), kind: domain::SymbolKind::Common, market: domain::Market::Kospi, nxt_enabled: false }
}

fn tempdir() -> tempfile::TempDir { tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap() }

async fn connect(path: &std::path::Path) -> sqlx::SqliteConnection {
    sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(path)).await.unwrap()
}

async fn control_rows(path: &std::path::Path) -> Vec<String> {
    let mut connection = connect(path).await;
    let mut rows = Vec::new();
    for query in [
        "SELECT CAST(body AS TEXT) AS value FROM financial_update ORDER BY 1",
        "SELECT CAST(paused AS TEXT) AS value FROM financial_update_control ORDER BY 1",
        "SELECT CAST(body AS TEXT) AS value FROM financial_stop ORDER BY 1",
        "SELECT CAST(body AS TEXT) AS value FROM financial_requests ORDER BY 1",
    ] {
        let found = sqlx::query(query).fetch_all(&mut connection).await.unwrap();
        rows.push(found.iter().map(|row| row.get::<String, _>("value")).collect::<Vec<_>>().join("|"));
    }
    rows
}

#[tokio::test]
async fn a_second_writer_on_the_same_database_neither_starts_an_update_nor_changes_the_job() {
    let fake = Fake::start().await;
    let dir = tempdir();
    let path = dir.path().join("f.db");
    let clock = Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 12, 0, 0));
    let first = Financials::new(Some(fake.client()), Store::open_for_collection(&path).await.unwrap(), clock.clone());
    first.claim_writer().unwrap();
    first.start_update(vec![samsung()]).await;
    let done = tokio::time::timeout(Duration::from_secs(60), async { loop {
        let page = first.update_status().await;
        if page.status == FinancialUpdateStatus::Ready { return page; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    } }).await.expect("the first writer finishes its update");
    let before = (control_rows(&path).await, fake.state.lock().unwrap().calls.len());
    let second = Financials::new(Some(fake.client()), Store::open(&path).await.unwrap(), clock);
    assert!(matches!(second.claim_writer(), Err(WriterError::Held { pid: Some(pid), .. }) if pid == std::process::id()));
    for page in [second.start_update(vec![samsung()]).await, second.resume_update(vec![samsung()]).await, second.pause_update().await] {
        assert_eq!((page.id, page.status), (done.id, FinancialUpdateStatus::Ready));
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!((control_rows(&path).await, fake.state.lock().unwrap().calls.len()), before, "a writer that does not hold the lock leaves the job rows and OpenDART alone");
}

#[tokio::test]
async fn a_writer_is_taken_by_the_first_launch_and_kept_until_the_service_is_dropped() {
    let fake = Fake::start().await;
    let dir = tempdir();
    let path = dir.path().join("f.db");
    let lock = writer_lock_path(&path);
    assert_eq!(lock, dir.path().join("f.db.writer.lock"));
    let service = Financials::new(Some(fake.client()), Store::open(&path).await.unwrap(), Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 12, 0, 0)));
    service.read("005930").await;
    drop(InstanceLock::acquire(&lock).expect("constructing and reading do not take the lock"));
    service.start_update(vec![samsung()]).await;
    assert!(matches!(InstanceLock::acquire(&lock), Err(server::instance::LockError::Held { .. })), "the first launch takes the lock");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(matches!(InstanceLock::acquire(&lock), Err(server::instance::LockError::Held { .. })), "the lock stays until the process ends");
    release(service).await;
    drop(InstanceLock::acquire(&lock).expect("dropping the service releases the lock"));
}

#[tokio::test]
async fn a_reader_without_a_client_never_takes_the_writer() {
    let dir = tempdir();
    let path = dir.path().join("f.db");
    let service = Financials::new(None, Store::open(&path).await.unwrap(), Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 12, 0, 0)));
    service.start_update(vec![samsung()]).await;
    service.pause_update().await;
    drop(InstanceLock::acquire(&writer_lock_path(&path)).expect("a service without OpenDART never holds the lock"));
}

#[tokio::test]
async fn a_server_configuration_takes_the_writer_when_the_first_update_starts() {
    let fake = Fake::start().await;
    let kiwoom = common::ScriptedTransport::new();
    let dir = tempdir();
    let server = process(&fake, &kiwoom, dir.path(), "20171231120000");
    let base = format!("http://{}", server.addr().await);
    let lock = writer_lock_path(&dir.path().join("run/financials.db"));
    let client = reqwest::Client::new();
    assert_eq!(updates::json(&client, &format!("{base}/api/financial-update")).await["status"], "idle");
    drop(InstanceLock::acquire(&lock).expect("starting the server does not take the lock"));
    updates::start(&client, &base).await;
    assert!(matches!(InstanceLock::acquire(&lock), Err(server::instance::LockError::Held { .. })), "the first update takes the lock");
    server.stop().await;
    drop(InstanceLock::acquire(&lock).expect("ending the process releases the lock"));
}

#[tokio::test]
async fn the_collection_store_runs_in_wal_mode_and_reads_do_not_wait_for_a_large_write() {
    let dir = tempdir();
    let path = dir.path().join("wal.db");
    let store = Store::open_for_collection(&path).await.unwrap();
    store.save("00000001", &Default::default()).await.unwrap();
    let mut inspector = connect(&path).await;
    assert_eq!(sqlx::query("PRAGMA journal_mode").fetch_one(&mut inspector).await.unwrap().get::<String, _>(0), "wal");
    let mut writer = connect(&path).await;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut writer).await.unwrap();
    sqlx::query("INSERT INTO companies VALUES ('00000002', ?)").bind("x".repeat(16 * 1024 * 1024)).execute(&mut writer).await.unwrap();
    let read = tokio::time::timeout(Duration::from_secs(1), store.collection("00000001")).await.expect("a read does not wait for the open large write");
    assert!(read.is_ok());
    let uncommitted = tokio::time::timeout(Duration::from_secs(1), sqlx::query("SELECT count(*) FROM companies").fetch_one(&mut inspector)).await.unwrap().unwrap();
    assert_eq!(uncommitted.get::<i64, _>(0), 1, "readers see the last committed state");
    sqlx::query("COMMIT").execute(&mut writer).await.unwrap();
    let committed = sqlx::query("SELECT count(*) FROM companies").fetch_one(&mut inspector).await.unwrap();
    assert_eq!(committed.get::<i64, _>(0), 2);
}

#[tokio::test]
async fn the_rollback_journal_store_still_blocks_reads_during_a_large_write() {
    let dir = tempdir();
    let path = dir.path().join("delete.db");
    let store = Store::open(&path).await.unwrap();
    store.save("00000001", &Default::default()).await.unwrap();
    let mut writer = connect(&path).await;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut writer).await.unwrap();
    sqlx::query("INSERT INTO companies VALUES ('00000002', ?)").bind("x".repeat(16 * 1024 * 1024)).execute(&mut writer).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(1), store.collection("00000001")).await.is_err(), "the contrast case: without WAL the read waits for the writer");
}

#[tokio::test]
async fn an_outside_listing_that_arrives_later_starts_the_automatic_check() {
    let fake = Fake::start().await;
    let dir = tempdir();
    let clock = Clock::fake(kst(KstDate::new(2015, 12, 31).unwrap(), 12, 0, 0));
    let service = Financials::new(Some(fake.client()), Store::open(&dir.path().join("f.db")).await.unwrap(), clock);
    let (sender, listings) = tokio::sync::watch::channel(None);
    let scheduler = service.start_automatic(listings);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(fake.state.lock().unwrap().calls.is_empty(), "no listing means no OpenDART call");
    sender.send_replace(Some(vec![samsung()]));
    fake.wait_for_call("list.json", 1).await;
    let done = tokio::time::timeout(Duration::from_secs(60), async { loop {
        let page = service.update_status().await;
        if page.status == FinancialUpdateStatus::Ready { return page; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    } }).await.expect("the listing that arrives later is collected");
    assert_eq!((done.total_symbols, done.completed_companies), (1, 1));
    scheduler.abort();
}
