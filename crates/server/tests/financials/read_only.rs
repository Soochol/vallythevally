use super::*;

fn spawn_reader(kiwoom: &common::ScriptedTransport, dir: &std::path::Path, extra: &[(&str, &std::ffi::OsStr)]) -> common::Server {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
    common::Server::spawn_with(kiwoom, &dir.join("run/server.lock"), dir, extra)
}

async fn get_status(client: &reqwest::Client, url: &str) -> (StatusCode, Value) {
    let response = client.get(url).send().await.unwrap();
    let status = response.status();
    (status, serde_json::from_slice(&response.bytes().await.unwrap()).unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_removed_update_routes_answer_404_or_405_and_the_server_never_calls_opendart() {
    let fake = Fake::start().await;
    let kiwoom = common::ScriptedTransport::new();
    let dir = tempfile::tempdir().unwrap();
    let service = Financials::new(Some(fake.client()), Store::open_for_collection(&dir.path().join("run/financials.db")).await.unwrap(), clock());
    settled(&service).await;
    release(service).await;
    let calls_before = fake.state.lock().unwrap().calls.len();
    let server = spawn_reader(&kiwoom, dir.path(), &[
        ("OPENDART_API_KEY", std::ffi::OsStr::new(KEY)),
        ("VALLY_DART_BASE_URL", std::ffi::OsStr::new(&fake.url)),
        ("VALLY_KIND_BASE_URL", std::ffi::OsStr::new(&fake.url)),
    ]);
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    symbols_loaded(&client, &base).await;
    for (method, path) in [
        (reqwest::Method::POST, "/api/financial-update"),
        (reqwest::Method::GET, "/api/financial-update"),
        (reqwest::Method::POST, "/api/financial-update/pause"),
        (reqwest::Method::POST, "/api/financial-update/resume"),
        (reqwest::Method::POST, "/api/symbols/005930/financials?period=Y"),
        (reqwest::Method::POST, "/api/symbols/005930/financial-source"),
    ] {
        let status = client.request(method.clone(), format!("{base}{path}")).send().await.unwrap().status();
        assert!(status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED, "{method} {path}: {status}");
    }
    assert_eq!(get_status(&client, &format!("{base}/api/symbols/005930/financials?period=Y")).await.0, StatusCode::OK);
    assert_eq!(get_status(&client, &format!("{base}/api/symbols/005930/financial-source")).await.0, StatusCode::OK);
    assert_eq!(fake.state.lock().unwrap().calls.len(), calls_before, "서버는 OpenDART를 부르지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn the_server_reads_what_another_writer_stored_and_a_write_in_progress_does_not_make_it_wait() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    let kiwoom = common::ScriptedTransport::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/financials.db");
    let writer = Financials::new(Some(fake.client()), Store::open_for_collection(&path).await.unwrap(), clock());
    assert_eq!(settled(&writer).await.state, ReadState::Ready);
    let server = spawn_reader(&kiwoom, dir.path(), &[]);
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();
    symbols_loaded(&client, &base).await;
    let url = format!("{base}/api/symbols/005930/financials?period=Y");
    let (status, page) = get_status(&client, &url).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["status"], "ready");
    assert_eq!(page["series"][0]["points"][0]["value"], 100.0);

    let mut writing = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("BEGIN IMMEDIATE").execute(&mut writing).await.unwrap();
    sqlx::query("INSERT INTO companies VALUES ('00000999', '{}')").execute(&mut writing).await.unwrap();
    let during = tokio::time::timeout(Duration::from_secs(1), get_status(&client, &url)).await.expect("a read does not wait for the writer's open transaction");
    assert_eq!(during.1["status"], "ready");
    sqlx::query("ROLLBACK").execute(&mut writing).await.unwrap();

    fake.state.lock().unwrap().correction = true;
    run_update(&writer, &[("005930", false)]).await;
    let (_, corrected) = get_status(&client, &url).await;
    assert_eq!(corrected["series"][0]["points"][0]["value"], 120.0, "읽는 쪽은 다른 프로세스가 새로 확정한 자료를 본다");
    server.stop().await;
}

#[tokio::test]
async fn a_missing_database_is_not_configured_without_creating_a_file_and_is_read_once_it_appears() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/financials.db");
    let reader = Financials::read_only(&path, clock());
    let absent = reader.read("005930").await;
    assert_eq!(absent.state, ReadState::NotConfigured);
    assert!(!path.exists() && !dir.path().join("run").exists(), "읽기는 파일도 폴더도 만들지 않는다");
    let writer = Financials::new(Some(fake.client()), Store::open_for_collection(&path).await.unwrap(), clock());
    settled(&writer).await;
    assert_eq!(reader.read("005930").await.state, ReadState::Ready);
}

#[tokio::test]
async fn an_unopenable_database_is_failed_and_a_read_only_store_cannot_write() {
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().join("db-is-directory");
    std::fs::create_dir(&directory).unwrap();
    let reader = Financials::read_only(&directory, clock());
    let failed = reader.read("005930").await;
    assert_eq!((failed.state, failed.failure), (ReadState::Failed, Some(Failure::Storage)));

    let fake = Fake::start().await;
    let path = dir.path().join("f.db");
    let writer = Financials::new(Some(fake.client()), Store::open_for_collection(&path).await.unwrap(), clock());
    settled(&writer).await;
    let store = Store::open_read_only(&path).await.unwrap().unwrap();
    assert_eq!(store.save("00126380", &Default::default()).await.unwrap_err(), Failure::Storage);
}
