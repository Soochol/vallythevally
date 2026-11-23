use std::collections::BTreeMap;
use std::io::{Cursor, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path as RoutePath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use collector::financials::alert::{AlertKind, AlertWatch};
use collector::financials::listing::watch_listings;
use collector::universe::{Diff, Entry, MarketName, StockKind, UniverseFile, universe_path};
use serde_json::{Value, json};
use server::clock::Clock;
use server::financials::store::Store;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

const KEY: &str = "synthetic-dart-secret-for-process-test";
const COMMON_CORP: &str = "00126380";
const SPAC_CORP: &str = "00000002";
const WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct DartState {
    calls: Mutex<Vec<String>>,
    unauthorized: AtomicBool,
    delay_millis: AtomicU64,
}

struct FakeDart {
    url: String,
    state: Arc<DartState>,
    task: JoinHandle<()>,
}

impl Drop for FakeDart {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeDart {
    async fn start() -> FakeDart {
        let state = Arc::new(DartState::default());
        let router = Router::new()
            .route("/api/{endpoint}", get(dart))
            .route("/common/searchcorpname.do", get(|| async { axum::Json(json!([])) }))
            .route("/disclosure/searchtotalinfo.do", get(no_search_result))
            .route("/common/disclsviewer.do", get(no_search_result))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        FakeDart { url, state, task }
    }

    fn calls(&self) -> usize {
        self.state.calls.lock().unwrap().len()
    }
}

async fn no_search_result() -> &'static str {
    "<section class=\"paging-group\"><div class=\"info\"><em>0</em></div></section>검색결과가 없습니다."
}

fn zipped(name: &str, text: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(text.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

async fn dart(State(state): State<Arc<DartState>>, RoutePath(endpoint): RoutePath<String>, Query(params): Query<BTreeMap<String, String>>) -> Response {
    state.calls.lock().unwrap().push(endpoint.clone());
    let delay = state.delay_millis.load(Ordering::SeqCst);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    if state.unauthorized.load(Ordering::SeqCst) || params.get("crtfc_key").map(String::as_str) != Some(KEY) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let corp = params.get("corp_code").cloned().unwrap_or_else(|| COMMON_CORP.to_owned());
    match endpoint.as_str() {
        "corpCode.xml" => {
            let directory = format!("<result><list><corp_code>{COMMON_CORP}</corp_code><corp_name>회사</corp_name><stock_code>005930</stock_code></list><list><corp_code>{SPAC_CORP}</corp_code><corp_name>스팩</corp_name><stock_code>123456</stock_code></list></result>");
            zipped("CORPCODE.xml", &directory).into_response()
        }
        "company.json" => axum::Json(json!({"status": "000", "corp_code": corp, "corp_name": "회사", "acc_mt": "12"})).into_response(),
        "list.json" => axum::Json(json!({"status": "000", "page_no": 1, "total_page": 1, "list": [{"corp_code": corp, "rcept_no": "20150331000001", "rcept_dt": "20150331", "report_nm": "사업보고서 (2015.12)"}]})).into_response(),
        "fnlttSinglAcntAll.json" | "alotMatter.json" => axum::Json(json!({"status": "013"})).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

struct FakeTelegram {
    url: String,
    received: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl Drop for FakeTelegram {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeTelegram {
    async fn start() -> FakeTelegram {
        let received = Arc::new(Mutex::new(Vec::new()));
        let router = Router::new()
            .route("/{bot}/sendMessage", post(|State(received): State<Arc<Mutex<Vec<String>>>>, body: String| async move {
                received.lock().unwrap().push(body);
                axum::Json(json!({"ok": true}))
            }))
            .with_state(received.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        FakeTelegram { url, received, task }
    }
}

struct Workspace {
    root: tempfile::TempDir,
    sockets: tempfile::TempDir,
}

impl Workspace {
    fn new() -> Workspace {
        Workspace { root: tempfile::tempdir().unwrap(), sockets: tempfile::Builder::new().prefix("fp").tempdir_in("/tmp").unwrap() }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn database(&self) -> PathBuf {
        self.path("server/financials.db")
    }

    fn data(&self) -> PathBuf {
        self.path("hoga")
    }

    fn state(&self) -> PathBuf {
        self.sockets.path().join("state")
    }

    fn key_file(&self, mode: u32, text: &str) -> PathBuf {
        let path = self.path("opendart-key");
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn telegram_file(&self) -> PathBuf {
        let path = self.path("telegram");
        std::fs::write(&path, "bot_token=123456:synthetic-token\nchat_id=42\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    fn write_universe(&self, date: u32, stocks: &[(&str, MarketName, StockKind)]) {
        let file = UniverseFile {
            format_version: 1,
            date,
            fetched_at: "2026-11-23T07:20:00+09:00".to_owned(),
            stocks: stocks.iter().map(|(code, market, kind)| Entry { code: (*code).to_owned(), name: format!("종목{code}"), market: *market, kind: *kind, status: Vec::new(), registered: true }).collect(),
            warnings: Vec::new(),
            diff: Diff::default(),
            replaced: None,
        };
        let path = universe_path(&self.data(), date);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&file).unwrap()).unwrap();
    }

    fn run_arguments(&self, dart: &FakeDart) -> Vec<String> {
        let key = self.key_file(0o600, &format!("{KEY}\n"));
        [
            "financials", "run",
            "--db", self.database().to_str().unwrap(),
            "--data", self.data().to_str().unwrap(),
            "--dart-key", key.to_str().unwrap(),
            "--state", self.state().to_str().unwrap(),
            "--dart-base-url", &dart.url,
            "--kind-base-url", &dart.url,
            "--dart-spacing-millis", "1",
        ].map(str::to_owned).to_vec()
    }
}

fn command(arguments: &[String], home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_collector"));
    command.args(arguments).env_clear().env("HOME", home).env("RUST_LOG", "info").stdin(Stdio::null()).kill_on_drop(true);
    command
}

struct Running {
    child: Child,
    output: JoinHandle<String>,
}

impl Running {
    fn spawn(arguments: &[String], home: &Path) -> Running {
        let mut child = command(arguments, home).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let mut readers = Vec::new();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        readers.push(tokio::spawn(read_all(stdout)));
        readers.push(tokio::spawn(read_all(stderr)));
        let output = tokio::spawn(async move {
            let mut text = String::new();
            for reader in readers {
                text.push_str(&reader.await.unwrap());
            }
            text
        });
        Running { child, output }
    }

    async fn terminate(mut self) -> (std::process::ExitStatus, String) {
        let pid = rustix::process::Pid::from_raw(self.child.id().unwrap() as i32).unwrap();
        rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
        let status = tokio::time::timeout(Duration::from_secs(20), self.child.wait()).await.expect("SIGTERM ends the process").unwrap();
        (status, self.output.await.unwrap())
    }

    async fn finished(mut self) -> (std::process::ExitStatus, String) {
        let status = tokio::time::timeout(Duration::from_secs(20), self.child.wait()).await.expect("the process ends on its own").unwrap();
        (status, self.output.await.unwrap())
    }
}

async fn read_all(mut stream: impl tokio::io::AsyncRead + Unpin) -> String {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes).await;
    String::from_utf8_lossy(&bytes).into_owned()
}

async fn financials(arguments: &[&str], workspace: &Workspace) -> (std::process::ExitStatus, String, String) {
    let mut all = vec!["financials".to_owned()];
    all.extend(arguments.iter().map(|argument| (*argument).to_owned()));
    all.extend(["--state".to_owned(), workspace.state().to_str().unwrap().to_owned()]);
    let output = command(&all, workspace.root.path()).output().await.unwrap();
    (output.status, String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned())
}

async fn status_json(workspace: &Workspace) -> Option<Value> {
    let (status, stdout, _) = financials(&["status", "--json"], workspace).await;
    status.success().then(|| serde_json::from_str(&stdout).unwrap())
}

async fn until(label: &str, mut check: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(WAIT, async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{label}에 닿지 못했습니다"));
}

async fn until_status(workspace: &Workspace, wanted: &str) -> Value {
    let mut last = Value::Null;
    until(wanted, async || {
        let Some(reply) = status_json(workspace).await else { return false };
        last = reply.clone();
        reply["page"]["status"] == wanted
    })
    .await;
    last
}

fn today() -> u32 {
    Clock::system().now().kst_date().yyyymmdd().parse().unwrap()
}

fn three_stocks() -> Vec<(&'static str, MarketName, StockKind)> {
    vec![("005930", MarketName::Kospi, StockKind::Common), ("000547", MarketName::Kospi, StockKind::Preferred), ("123456", MarketName::Kosdaq, StockKind::Spac)]
}

#[tokio::test]
async fn a_run_collects_the_listed_common_preferred_and_spac_stocks_and_reports_ready() {
    let dart = FakeDart::start().await;
    let workspace = Workspace::new();
    workspace.write_universe(today(), &three_stocks());
    let process = Running::spawn(&workspace.run_arguments(&dart), workspace.root.path());
    let reply = until_status(&workspace, "ready").await;
    assert_eq!(reply["page"]["totalSymbols"], 3, "{reply}");
    assert_eq!(reply["page"]["processedSymbols"], 3);
    assert_eq!(reply["page"]["completedCompanies"], 2, "the common stock and the spac are collected");
    assert_eq!(reply["page"]["unsupportedSymbols"], 0);
    assert_eq!(reply["listing"], json!({"date": today(), "stocks": 3}));
    let store = Store::open(&workspace.database()).await.unwrap();
    assert!(store.collection(COMMON_CORP).await.unwrap().last_checked_at.is_some());
    assert!(store.collection(SPAC_CORP).await.unwrap().last_checked_at.is_some());
    assert!(store.security("005930").await.unwrap().is_some());
    let (status, text, _) = financials(&["status"], &workspace).await;
    assert!(status.success());
    assert!(text.contains("상태: ready (완료)") && text.contains("회사 진행: 2/2 완료") && text.contains("종목 목록:"), "{text}");
    let (code, output) = process.terminate().await;
    assert_eq!(code.code(), Some(0));
    assert!(!output.contains(KEY), "{output}");
    assert!(!workspace.state().join("financials.sock").exists(), "the socket is removed when the process ends");
}

#[tokio::test]
async fn without_today_s_file_the_latest_one_is_used_and_without_any_file_nothing_is_called() {
    let dart = FakeDart::start().await;
    let workspace = Workspace::new();
    workspace.write_universe(20200102, &[("123456", MarketName::Kosdaq, StockKind::Spac)]);
    workspace.write_universe(20200103, &[("005930", MarketName::Kospi, StockKind::Common), ("123456", MarketName::Kosdaq, StockKind::Spac)]);
    let process = Running::spawn(&workspace.run_arguments(&dart), workspace.root.path());
    let reply = until_status(&workspace, "ready").await;
    assert_eq!(reply["listing"], json!({"date": 20200103, "stocks": 2}), "the most recent file stands in for today's");
    assert_eq!(reply["page"]["totalSymbols"], 2);
    process.terminate().await;

    let dart = FakeDart::start().await;
    let empty = Workspace::new();
    std::fs::create_dir_all(empty.data()).unwrap();
    let process = Running::spawn(&empty.run_arguments(&dart), empty.root.path());
    until("status answers", async || status_json(&empty).await.is_some()).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let reply = status_json(&empty).await.unwrap();
    assert_eq!(reply["listing"], Value::Null);
    let (_, text, _) = financials(&["status"], &empty).await;
    assert!(text.contains("종목 목록: 없음"), "{text}");
    let (start_status, _, start_error) = financials(&["start"], &empty).await;
    assert!(!start_status.success() && start_error.contains("종목 목록이 없어"), "{start_error}");
    assert_eq!(dart.calls(), 0, "no listing means no OpenDART call");
    process.terminate().await;
}

#[tokio::test]
async fn pause_stops_the_calls_and_resume_finishes_the_collection() {
    let dart = FakeDart::start().await;
    dart.state.delay_millis.store(15, Ordering::SeqCst);
    let workspace = Workspace::new();
    workspace.write_universe(today(), &three_stocks());
    let process = Running::spawn(&workspace.run_arguments(&dart), workspace.root.path());
    until("calls start", async || dart.calls() >= 8).await;
    let (status, _, _) = financials(&["pause"], &workspace).await;
    assert!(status.success());
    let paused = until_status(&workspace, "paused").await;
    assert_eq!(paused["page"]["stopReason"], "user");
    let calls = dart.calls();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(dart.calls(), calls, "no request leaves while paused");
    let (_, text, _) = financials(&["status"], &workspace).await;
    assert!(text.contains("상태: paused") && text.contains("운영자 일시정지"), "{text}");
    let (status, _, _) = financials(&["resume"], &workspace).await;
    assert!(status.success());
    dart.state.delay_millis.store(0, Ordering::SeqCst);
    let ready = until_status(&workspace, "ready").await;
    assert_eq!(ready["page"]["completedCompanies"], 2);
    process.terminate().await;
}

#[tokio::test]
async fn a_second_run_on_the_same_database_exits_with_code_two() {
    let dart = FakeDart::start().await;
    let workspace = Workspace::new();
    workspace.write_universe(today(), &three_stocks());
    let first = Running::spawn(&workspace.run_arguments(&dart), workspace.root.path());
    until("first run answers", async || status_json(&workspace).await.is_some()).await;
    let mut second_arguments = workspace.run_arguments(&dart);
    let other_state = workspace.sockets.path().join("state-two");
    let position = second_arguments.iter().position(|argument| argument == "--state").unwrap();
    second_arguments[position + 1] = other_state.to_str().unwrap().to_owned();
    let (status, output) = Running::spawn(&second_arguments, workspace.root.path()).finished().await;
    assert_eq!(status.code(), Some(2), "{output}");
    assert!(output.contains("다른 프로세스가 재무 저장소에 쓰고 있습니다"), "{output}");
    assert!(!output.contains(KEY));
    first.terminate().await;
}

#[tokio::test]
async fn a_key_file_that_is_not_private_or_is_empty_stops_the_start_without_printing_the_key() {
    let dart = FakeDart::start().await;
    let workspace = Workspace::new();
    workspace.write_universe(today(), &three_stocks());
    let mut arguments = workspace.run_arguments(&dart);
    let position = arguments.iter().position(|argument| argument == "--dart-key").unwrap();
    for (mode, text, expected) in [(0o644, format!("{KEY}\n"), "권한이 644입니다"), (0o640, format!("{KEY}\n"), "권한이 640입니다"), (0o600, "  \n".to_owned(), "비어 있습니다")] {
        arguments[position + 1] = workspace.key_file(mode, &text).to_str().unwrap().to_owned();
        let (status, output) = Running::spawn(&arguments, workspace.root.path()).finished().await;
        assert_eq!(status.code(), Some(2), "{output}");
        assert!(output.contains(expected), "{output}");
        assert!(!output.contains(KEY), "{output}");
    }
    assert_eq!(dart.calls(), 0);
}

#[tokio::test]
async fn status_without_a_running_process_says_it_is_off_and_fails() {
    let workspace = Workspace::new();
    for arguments in [&["status"][..], &["status", "--json"], &["pause"]] {
        let (status, stdout, stderr) = financials(arguments, &workspace).await;
        assert!(!status.success());
        assert!(format!("{stdout}{stderr}").contains("재무 수집 프로세스가 꺼져 있습니다"), "{stdout}{stderr}");
    }
}

#[tokio::test]
async fn an_authentication_refusal_stops_the_job_and_sends_one_telegram_message() {
    let dart = FakeDart::start().await;
    dart.state.unauthorized.store(true, Ordering::SeqCst);
    let telegram = FakeTelegram::start().await;
    let workspace = Workspace::new();
    workspace.write_universe(today(), &three_stocks());
    let mut arguments = workspace.run_arguments(&dart);
    arguments.extend(["--telegram".to_owned(), workspace.telegram_file().to_str().unwrap().to_owned(), "--telegram-api".to_owned(), telegram.url.clone()]);
    let process = Running::spawn(&arguments, workspace.root.path());
    let stopped = until_status(&workspace, "stopped").await;
    assert_eq!(stopped["page"]["stopReason"], "authentication");
    until("one telegram message", async || !telegram.received.lock().unwrap().is_empty()).await;
    tokio::time::sleep(Duration::from_secs(7)).await;
    let received = telegram.received.lock().unwrap().clone();
    assert_eq!(received.len(), 1, "the same stop is announced once: {received:?}");
    assert!(received[0].contains("인증"), "{}", received[0]);
    let (_, output) = process.terminate().await;
    assert!(!output.contains(KEY) && !received[0].contains(KEY));
}

#[test]
fn an_alert_is_sent_once_per_stop_and_again_after_the_stop_clears() {
    let mut page = serde_json::from_value::<server::api::FinancialUpdatePage>(json!({
        "id": 1, "status": "stopped", "phase": "recent", "stopReason": "authentication", "nextCheckAt": null, "canResume": true, "automatic": true,
        "latestCheckPending": false, "historyCompletedCompanies": 0, "historyFailedCompanies": 0, "recentFailedCompanies": 0, "historyComplete": false,
        "fromYear": 2024, "throughYear": 2026, "totalSymbols": 1, "processedSymbols": 1, "unsupportedSymbols": 0, "unverifiedSymbols": 0, "unverifiedDividends": 0,
        "totalCompanies": 1, "completedCompanies": 0, "failedCompanies": 0, "startedAt": null, "lastCheckedAt": null, "failure": "authentication", "failures": []
    })).unwrap();
    let mut watch = AlertWatch::default();
    assert!(watch.observe(&page).is_some());
    assert!(watch.observe(&page).is_none(), "the same stop is not repeated");
    page.status = server::api::FinancialUpdateStatus::Pausing;
    assert!(watch.observe(&page).is_none());
    page.stop_reason = Some(server::api::FinancialUpdateStopReason::RateLimited);
    assert!(watch.observe(&page).unwrap().contains("호출 한도"), "a different stop is announced");
    page.stop_reason = Some(server::api::FinancialUpdateStopReason::User);
    assert!(watch.observe(&page).is_none(), "an operator pause needs no alert");
    page.stop_reason = Some(server::api::FinancialUpdateStopReason::Storage);
    assert!(watch.observe(&page).unwrap().contains("저장소"));
    page.stop_reason = None;
    assert!(watch.observe(&page).is_none());
    page.stop_reason = Some(server::api::FinancialUpdateStopReason::Storage);
    assert!(watch.observe(&page).is_some(), "a stop that returns after the job recovered is announced again");
    assert_eq!(collector::financials::alert::alert_kind(&page), Some(AlertKind::Storage));
}

#[tokio::test]
async fn the_listing_watcher_follows_new_and_replaced_files_and_skips_unreadable_ones() {
    let workspace = Workspace::new();
    let (feed, task) = watch_listings(workspace.data(), Clock::system(), Duration::from_millis(40));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(feed.symbols.borrow().is_none() && feed.info.borrow().is_none());
    workspace.write_universe(today(), &three_stocks()[..1]);
    until("the first file is read", async || feed.symbols.borrow().as_ref().is_some_and(|symbols| symbols.len() == 1)).await;
    workspace.write_universe(today(), &three_stocks());
    until("the replaced file is read", async || feed.symbols.borrow().as_ref().is_some_and(|symbols| symbols.len() == 3)).await;
    let listed = feed.symbols.borrow().clone().unwrap();
    assert_eq!(listed.iter().map(|info| (info.symbol.as_wire(), info.kind)).collect::<Vec<_>>(), vec![("005930".to_owned(), domain::SymbolKind::Common), ("000547".to_owned(), domain::SymbolKind::Preferred), ("123456".to_owned(), domain::SymbolKind::Common)]);
    std::fs::write(universe_path(&workspace.data(), today()), b"not json").unwrap();
    workspace.write_universe(20200101, &three_stocks()[..2]);
    until("an unreadable newest file falls back to an older readable one", async || feed.info.borrow().as_ref().is_some_and(|info| (info.date, info.stocks) == (20200101, 2))).await;
    task.abort();
}
