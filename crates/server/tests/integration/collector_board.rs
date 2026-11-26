use crate::support;

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use futures::StreamExt;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::account::{AccountServerUrl, AccountState, AccountStateFile, CompleteQuery, ProviderSubject};
use server::api::{AccountProvider, UnixSeconds};
use server::app::{ApplicationInputs, application_with_system};
use server::clock::Clock;
use server::collector::wire::{COVERAGE_REQUEST, CollectorDayState, DISK_REQUEST, Line, Reply, WATCH_REQUEST};
use server::collector::telegram::Telegram;
use server::collector::{CollectorBoard, DaemonJudgment, HEARTBEAT_EVERY, MAX_LINE_BYTES, MISSED_HEARTBEATS, RECONNECT_BACKOFF};
use server::config::Secret;
use server::http::{AppState, router};
use server::instance::InstanceLock;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::symbols::SymbolDirectory;
use server::system_routes::SystemState;
use support::ScriptedTransport;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::time::Instant;
use tower::ServiceExt;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../collector/tests/fixtures/status");
const ADMINS: &[&str] = &["google:1234", "naver:abc"];
const WAIT: Duration = Duration::from_secs(300);

fn assert_elapsed(elapsed: Duration, expected: Duration, what: &str) {
    assert!(elapsed >= expected && elapsed < expected + Duration::from_millis(50), "{what}: {elapsed:?}, 기대 {expected:?}");
}

fn fixture_text(name: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn fixture_value(name: &str) -> Value {
    serde_json::from_str(&fixture_text(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn line_of(value: &Value) -> String {
    format!("{value}\n")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Beating,
    BeatingOffHours,
    Mute,
    NewerVersion,
    EndlessLine,
    StatusOfBytes(usize),
}

struct Daemon {
    path: PathBuf,
    task: Option<tokio::task::JoinHandle<()>>,
    accepted: tokio::sync::watch::Receiver<usize>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl Daemon {
    fn start(path: &Path, mode: Mode) -> Daemon {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path).unwrap();
        let (accepted_count, accepted) = tokio::sync::watch::channel(0usize);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                accepted_count.send_modify(|count| *count += 1);
                connections.spawn(serve(stream, mode, seen.clone()));
            }
        });
        Daemon { path: path.to_owned(), task: Some(task), accepted, requests }
    }

    async fn wait_for_connections(&self, at_least: usize) {
        tokio::time::timeout(WAIT, self.accepted.clone().wait_for(|count| *count >= at_least)).await.expect("연결이 오지 않았다").unwrap();
    }

    async fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        let _ = std::fs::remove_file(&self.path);
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn status_line(mode: Mode) -> String {
    if let Mode::StatusOfBytes(length) = mode {
        let text = fixture_text("reply-status.json").trim().replace('\n', " ");
        let padding = " ".repeat(length - text.len());
        return format!("{text}{padding}\n");
    }
    let mut status = fixture_value("reply-status.json");
    if mode == Mode::BeatingOffHours {
        status["status"]["phase"] = json!("off_hours");
    }
    if mode == Mode::NewerVersion {
        status["v"] = json!(2);
    }
    line_of(&status)
}

fn heartbeat_line(mode: Mode, sequence: u64) -> String {
    let mut heartbeat = fixture_value("reply-heartbeat.json");
    heartbeat["sequence"] = json!(sequence);
    if mode == Mode::BeatingOffHours {
        heartbeat["phase"] = json!("off_hours");
    }
    line_of(&heartbeat)
}

async fn serve(stream: UnixStream, mode: Mode, requests: Arc<Mutex<Vec<String>>>) {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut beat: Option<tokio::time::Interval> = None;
    let mut sequence = 0u64;
    loop {
        let tick = async {
            match beat.as_mut() {
                Some(beat) => {
                    beat.tick().await;
                }
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { return };
                let kind = serde_json::from_str::<Value>(&line).ok().and_then(|value| value["type"].as_str().map(str::to_owned)).unwrap_or_default();
                requests.lock().unwrap().push(line);
                let reply = match kind.as_str() {
                    "watch" | "status" => status_line(mode),
                    "coverage" => line_of(&fixture_value("reply-coverage.json")),
                    "disk" => line_of(&fixture_value("reply-disk.json")),
                    _ => line_of(&fixture_value("reply-error-unknown-request.json")),
                };
                if kind == "watch" && mode == Mode::EndlessLine {
                    let _ = write.write_all(&vec![b'a'; MAX_LINE_BYTES + 2]).await;
                    continue;
                }
                if write.write_all(reply.as_bytes()).await.is_err() {
                    return;
                }
                if kind == "watch" && !matches!(mode, Mode::Mute | Mode::NewerVersion) {
                    beat = Some(tokio::time::interval_at(Instant::now() + HEARTBEAT_EVERY, HEARTBEAT_EVERY));
                }
            }
            _ = tick => {
                sequence += 1;
                let both = format!("{}{}", status_line(mode), heartbeat_line(mode, sequence));
                if write.write_all(both.as_bytes()).await.is_err() {
                    return;
                }
            }
        }
    }
}

struct FakeAccount {
    base: String,
    me: Arc<Mutex<Value>>,
    me_requests: tokio::sync::watch::Sender<usize>,
    serving: tokio::task::JoinHandle<()>,
}

impl FakeAccount {
    async fn start() -> FakeAccount {
        let me = Arc::new(Mutex::new(json!({"id": "acc-1", "provider": "google", "subject": "1234", "created_at": 1})));
        let (me_requests, _) = tokio::sync::watch::channel(0usize);
        let (served, counted) = (me.clone(), me_requests.clone());
        let app = Router::new()
            .route("/v1/auth/token", axum::routing::post(|| async { axum::Json(json!({"token": "fake-account-token"})) }).delete(|| async { axum::http::StatusCode::NO_CONTENT }))
            .route(
                "/v1/me",
                axum::routing::get(move || {
                    let (served, counted) = (served.clone(), counted.clone());
                    async move {
                        counted.send_modify(|count| *count += 1);
                        let body = served.lock().unwrap().clone();
                        axum::Json(body)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let serving = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        FakeAccount { base, me, me_requests, serving }
    }

    fn answer_me_with(&self, subject: Option<&str>) {
        let mut me = json!({"id": "acc-1", "provider": "google", "created_at": 1});
        if let Some(subject) = subject {
            me["subject"] = json!(subject);
        }
        *self.me.lock().unwrap() = me;
    }
}

impl Drop for FakeAccount {
    fn drop(&mut self) {
        self.serving.abort();
    }
}

const TELEGRAM_SECRET: &str = "TELEGRAM-TOKEN-do-not-print";
const TELEGRAM_CHAT_ID: &str = "-100777";

struct FakeTelegram {
    port: u16,
    texts: Arc<Mutex<Vec<String>>>,
    routes: Arc<Mutex<Vec<(String, String)>>>,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl FakeTelegram {
    async fn start(status: u16) -> FakeTelegram {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let texts: Arc<Mutex<Vec<String>>> = Arc::default();
        let calls: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
        let routes: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
        let (log, count, route_log) = (texts.clone(), calls.clone(), routes.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut reader = BufReader::new(&mut stream);
                let mut request_line = String::new();
                reader.read_line(&mut request_line).await.unwrap();
                let path = request_line.split_whitespace().nth(1).unwrap().to_owned();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0u8; length];
                tokio::io::AsyncReadExt::read_exact(&mut reader, &mut body).await.unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if status < 300 {
                    log.lock().unwrap().push(body["text"].as_str().unwrap().to_owned());
                    route_log.lock().unwrap().push((path, body["chat_id"].as_str().unwrap().to_owned()));
                }
                let reply = format!("HTTP/1.1 {status} Reply\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                stream.write_all(reply.as_bytes()).await.unwrap();
                let _ = stream.shutdown().await;
            }
        });
        FakeTelegram { port, texts, routes, calls }
    }

    fn settings_file(&self, folder: &Path) -> PathBuf {
        let path = folder.join("telegram");
        std::fs::write(&path, format!("bot_token=123456:{TELEGRAM_SECRET}\nchat_id={TELEGRAM_CHAT_ID}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    fn telegram(&self, folder: &Path) -> Telegram {
        Telegram::load_at(&self.settings_file(folder), &format!("http://127.0.0.1:{}", self.port)).unwrap().unwrap()
    }

    fn texts(&self) -> Vec<String> {
        self.texts.lock().unwrap().clone()
    }

    async fn wait_for_calls(&self, count: usize) {
        for _ in 0..1000 {
            if self.calls.load(std::sync::atomic::Ordering::SeqCst) >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("텔레그램 호출이 {count}번이 되지 않았다");
    }
}

#[derive(Clone, Default)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = LogCapture;

    fn make_writer(&'a self) -> LogCapture {
        self.clone()
    }
}

struct Options {
    admins: &'static [&'static str],
    linked: bool,
    legacy_login_without_subject: bool,
    account_subject: Option<&'static str>,
    telegram: Option<Telegram>,
}

impl Options {
    fn allowed_board() -> Options {
        Options { admins: ADMINS, linked: true, legacy_login_without_subject: false, account_subject: Some("1234"), telegram: None }
    }
}

struct Fixture {
    app: Router,
    state: Arc<AppState>,
    accounts: FakeAccount,
    socket: PathBuf,
    state_file: PathBuf,
    sessions: tokio::sync::watch::Receiver<u64>,
    running: Option<tokio::task::JoinHandle<()>>,
    _lock: InstanceLock,
    _socket_dir: tempfile::TempDir,
    _tmp: tempfile::TempDir,
}

impl Fixture {
    async fn start(options: Options) -> Fixture {
        let accounts = FakeAccount::start().await;
        accounts.answer_me_with(options.account_subject);
        let tmp = tempfile::tempdir().unwrap();
        let socket_dir = tempfile::Builder::new().prefix("collector-board-").tempdir_in("/tmp").unwrap();
        let socket = socket_dir.path().join("supervise.sock");
        let lock = InstanceLock::acquire(&tmp.path().join("run/server.lock")).unwrap();
        let state_file = tmp.path().join("state/account.json");
        let url = AccountServerUrl::parse(&accounts.base).unwrap();
        if options.legacy_login_without_subject {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(state_file.parent().unwrap()).unwrap();
            let legacy = json!({"server_url": url.as_str(), "token": "legacy-token", "account_id": "acc-1", "provider": "google", "signed_in_at": 1});
            std::fs::write(&state_file, legacy.to_string()).unwrap();
            std::fs::set_permissions(&state_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let account = if options.linked { AccountState::linked(url, AccountStateFile::new(state_file.clone(), &lock)).unwrap() } else { AccountState::local_only() };
        let sessions = account.subscribe_sessions();
        let admins: Vec<ProviderSubject> = options.admins.iter().map(|admin| ProviderSubject::parse(admin).unwrap()).collect();
        let collector = CollectorBoard::configured(admins, Some(socket.clone()), account.is_linked()).map(|board| board.with_telegram(options.telegram));
        let system = SystemState::unconfigured().with_account(account).with_collector(collector);

        let clock = Clock::fake(server::kiwoom::wire::parse_kst_datetime("20261118090000").unwrap());
        let rest = KiwoomRest::new(ScriptedTransport::new().transport(), KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None), clock.clone());
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let state = application_with_system(
            ApplicationInputs { rest, clock, symbols: Arc::new(SymbolDirectory::default()), db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false },
            system,
        );
        let app = router(state.clone());
        Fixture { app, state, accounts, socket, state_file, sessions, running: None, _lock: lock, _socket_dir: socket_dir, _tmp: tmp }
    }

    fn go(&mut self) {
        self.running = Some(tokio::spawn(server::collector::run(self.state.clone())));
        tokio::time::pause();
    }

    fn board(&self) -> &CollectorBoard {
        self.state.system.collector().expect("현황판이 켜져 있어야 한다")
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let (status, body) = self.send("GET", path).await;
        (status, serde_json::from_slice(&body).unwrap())
    }

    async fn send(&self, method: &str, path: &str) -> (u16, Vec<u8>) {
        let (status, _, body) = self.send_with_headers(method, path).await;
        (status, body)
    }

    async fn send_with_headers(&self, method: &str, path: &str) -> (u16, axum::http::HeaderMap, Vec<u8>) {
        let response = self.app.clone().oneshot(Request::builder().method(method).uri(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        (status, headers, response.into_body().collect().await.unwrap().to_bytes().to_vec())
    }

    async fn assert_other_methods_answer(&self, expected: u16, code: Option<&str>, what: &str) {
        let expected_allow = (expected == 405).then_some("GET,HEAD");
        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "PROPFIND"] {
            for path in ["status", "coverage", "disk"] {
                let (status, headers, body) = self.send_with_headers(method, &format!("/api/collector/{path}")).await;
                let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                assert_eq!((status, body["error"]["code"].as_str()), (expected, code), "{what} {method} {path}: {body}");
                assert_eq!(headers.get("allow").map(|value| value.to_str().unwrap()), expected_allow, "{what} {method} {path}: Allow");
            }
        }
    }

    async fn access(&self) -> String {
        let (status, body) = self.get("/api/collector/access").await;
        assert_eq!(status, 200, "access는 꺼짐에서도 403이나 404를 내지 않는다: {body}");
        body["access"].as_str().unwrap().to_owned()
    }

    async fn in_real_time<T>(&self, work: impl std::future::Future<Output = T>) -> T {
        let paused = self.running.is_some();
        if paused {
            tokio::time::resume();
        }
        let done = work.await;
        if paused {
            tokio::time::pause();
        }
        done
    }

    async fn wait_until_the_browser_is_told_of_the_login(&self, browser: &mut Socket) {
        self.in_real_time(async {
            loop {
                let account = next_message_of_type(browser, "account", WAIT).await.expect("로그인을 브라우저에 알리지 않았다");
                if account["status"]["state"] == "signed_in" {
                    break;
                }
            }
        })
        .await;
    }

    async fn sign_in(&self) {
        let account = self.state.system.account();
        let now = UnixSeconds(self.state.clock.now().unix());
        let start = account.start_login(now, AccountProvider::Google, 1).unwrap();
        let state = reqwest::Url::parse(&start).unwrap().query_pairs().find(|(key, _)| key == "state").unwrap().1.into_owned();
        let completed = self.in_real_time(account.complete_login(&self.state.db, now, CompleteQuery { code: Some("code".into()), state: Some(state), error: None })).await;
        completed.unwrap();
    }

    async fn sign_in_as(&self, subject: Option<&str>) {
        self.accounts.answer_me_with(subject);
        self.sign_in().await;
    }

    async fn sign_out(&self) {
        self.in_real_time(self.state.system.account().logout()).await.unwrap();
    }

    async fn reached(&self, judgment: DaemonJudgment) {
        let mut judgments = self.board().subscribe_judgment();
        tokio::time::timeout(WAIT, judgments.wait_for(|now| *now == judgment)).await.unwrap_or_else(|_| panic!("{judgment:?}에 닿지 못했다")).unwrap();
    }

    fn judgment(&self) -> DaemonJudgment {
        *self.board().subscribe_judgment().borrow()
    }

    async fn wait_for_account_change(&mut self) {
        tokio::time::timeout(WAIT, self.sessions.changed()).await.expect("계정 상태가 바뀌지 않았다").unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(running) = &self.running {
            running.abort();
        }
    }
}

async fn serve_http(state: Arc<AppState>) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(state);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open_ws(addr: std::net::SocketAddr) -> Socket {
    tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws")).await.unwrap().0
}

async fn next_message_of_type(ws: &mut Socket, kind: &str, within: Duration) -> Option<Value> {
    tokio::time::timeout(within, async {
        loop {
            let message = ws.next().await?.ok()?;
            if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if value["type"] == kind {
                    return Some(value);
                }
            }
        }
    })
    .await
    .ok()
    .flatten()
}

#[test]
fn every_example_message_reads_as_a_connector_type() {
    let requests = [("request-status.json", "status", None), ("request-coverage.json", "coverage", Some(COVERAGE_REQUEST)), ("request-disk.json", "disk", Some(DISK_REQUEST)), ("request-watch.json", "watch", Some(WATCH_REQUEST))];
    for (name, kind, sent) in requests {
        let value = fixture_value(name);
        assert_eq!((value["v"].as_u64(), value["type"].as_str()), (Some(1), Some(kind)), "{name}");
        if let Some(sent) = sent {
            assert_eq!(serde_json::from_slice::<Value>(sent).unwrap(), value, "커넥터가 보내는 {kind} 요청이 예시와 같다");
            assert_eq!(sent.last(), Some(&b'\n'));
        }
    }
    let read = |name: &str| match Line::parse(fixture_text(name).as_bytes()) {
        Line::Reply(reply) => reply,
        other => panic!("{name}: {other:?}"),
    };
    let Reply::Status(plain) = read("reply-status.json") else { panic!("status") };
    assert_eq!((plain.status.date, plain.status.keys.len(), plain.status.alerts.len(), plain.status.today.handed_off_stocks), (20261118, 2, 2, 3));
    assert!(plain.status.universe_changes.is_none() && plain.status.observation_day.is_none());
    let Reply::Status(filled) = read("reply-status-filled.json") else { panic!("status-filled") };
    assert_eq!(filled.status.universe_changes.as_ref().map(|changes| (changes.added.len(), changes.renamed.len(), changes.halt_lifted.len())), Some((1, 1, 1)));
    assert!(filled.status.observation_day.is_some());
    let Reply::Heartbeat(heartbeat) = read("reply-heartbeat.json") else { panic!("heartbeat") };
    assert_eq!(heartbeat.sequence, 12);
    let Reply::Coverage(coverage) = read("reply-coverage.json") else { panic!("coverage") };
    assert_eq!(coverage.days.len(), 4);
    assert!(coverage.days.iter().all(|day| day.state != CollectorDayState::Unknown), "예시의 날짜 상태는 모두 이름 있는 값으로 읽힌다");
    assert_eq!(coverage.days[1].planned_stocks, Some(2600));
    let Reply::Disk(disk) = read("reply-disk.json") else { panic!("disk") };
    assert_eq!((disk.disk.filesystem.map(|fs| fs.free_bytes), disk.disk.raw.len(), disk.disk.store.len()), (Some(812_345_678_901), 2, 1));
    for (name, code) in [("reply-error-read-only.json", "read_only"), ("reply-error-unknown-request.json", "unknown_request"), ("reply-error-unsupported-version.json", "unsupported_version")] {
        let Reply::Error(error) = read(name) else { panic!("{name}") };
        assert_eq!((error.code.as_str(), error.supported_version), (code, Some(1)), "{name}");
    }
}

#[test]
fn a_reply_of_another_format_version_is_not_interpreted_and_unknown_fields_are_ignored() {
    assert_eq!(Line::parse(br#"{"v":2,"type":"status","status":"a shape this connector does not know"}"#), Line::Incompatible);
    assert_eq!(Line::parse(br#"{"v":"1","type":"heartbeat"}"#), Line::Incompatible);
    assert_eq!(Line::parse(br#"{"type":"heartbeat","sequence":1,"phase":"collecting"}"#), Line::Malformed);
    assert_eq!(Line::parse(b"not json"), Line::Malformed);
    assert_eq!(Line::parse(br#"{"v":1,"type":"nonsense"}"#), Line::Malformed);
    let newer = br#"{"v":1,"type":"heartbeat","sequence":3,"phase":"a_phase_added_later","sent_at":"x","extra":{"a":1}}"#;
    let Line::Reply(Reply::Heartbeat(heartbeat)) = Line::parse(newer) else { panic!("모르는 필드와 모르는 단계는 읽힌다") };
    assert_eq!(heartbeat.sequence, 3);
}

#[test]
fn every_phase_the_contract_names_reads_as_itself() {
    for phase in ["off_hours", "morning_prep", "collecting", "after_close", "finalizing"] {
        let line = format!(r#"{{"v":1,"type":"heartbeat","sequence":1,"phase":"{phase}","sent_at":"x"}}"#);
        let Line::Reply(Reply::Heartbeat(heartbeat)) = Line::parse(line.as_bytes()) else { panic!("{phase}") };
        assert_eq!(serde_json::to_value(heartbeat.phase).unwrap(), phase);
    }
}

#[test]
fn every_day_state_the_contract_names_reads_as_itself() {
    for state in ["complete", "incomplete", "in_progress", "verify_failed", "unreadable"] {
        let line = format!(r#"{{"v":1,"type":"coverage","sent_at":"x","days":[{{"date":20261115,"state":"{state}","verified":null,"planned_stocks":null,"received_stocks":null}}]}}"#);
        let Line::Reply(Reply::Coverage(coverage)) = Line::parse(line.as_bytes()) else { panic!("{state}") };
        assert_eq!(serde_json::to_value(coverage.days[0].state).unwrap(), state);
    }
}

#[tokio::test]
async fn an_allowed_account_reads_the_daemon_status_coverage_and_disk() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Healthy).await;
    assert_eq!(fixture.access().await, "allowed");

    let (status, body) = fixture.get("/api/collector/status").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["judgment"], "healthy");
    assert_eq!(body["status"]["phase"], "collecting");
    assert_eq!(body["status"]["keys"].as_array().unwrap().len(), 2);
    assert_eq!(body["sent_at"], "2026-11-18T09:00:05+09:00");
    assert!(body["received_at"].as_i64().unwrap() > 1_700_000_000);

    let (status, body) = fixture.get("/api/collector/coverage").await;
    assert_eq!((status, body["days"].as_array().map(Vec::len)), (200, Some(4)), "{body}");
    assert_eq!((body["days"][0]["state"].as_str(), body["days"][1]["verified"].as_bool(), body["days"][3]["state"].as_str()), (Some("in_progress"), Some(true), Some("verify_failed")));
    let (status, body) = fixture.get("/api/collector/disk").await;
    assert_eq!((status, body["disk"]["filesystem"]["free_bytes"].as_u64()), (200, Some(812_345_678_901)), "{body}");

    let requests = daemon.requests();
    assert_eq!(requests.iter().map(|line| serde_json::from_str::<Value>(line).unwrap()["type"].as_str().unwrap().to_owned()).collect::<Vec<_>>(), ["watch", "coverage", "disk"], "커넥터는 읽기 요청만 보낸다");
    assert_eq!(serde_json::from_str::<Value>(&requests[0]).unwrap(), fixture_value("request-watch.json"));
    fixture.assert_other_methods_answer(405, Some("method_not_allowed"), "허용된 계정").await;
    assert_eq!(daemon.requests().len(), 3, "GET이 아닌 요청은 데몬에 닿지 않는다");
}

#[tokio::test]
async fn an_account_off_the_list_and_no_login_get_403_and_the_daemon_is_not_asked() {
    let fixture = Fixture::start(Options::allowed_board()).await;
    let daemon = Daemon::start(&fixture.socket, Mode::Beating);
    for path in ["status", "coverage", "disk"] {
        let (status, body) = fixture.get(&format!("/api/collector/{path}")).await;
        assert_eq!((status, body["error"]["code"].as_str()), (403, Some("forbidden")), "로그인 없음 {path}: {body}");
    }
    assert_eq!(fixture.access().await, "denied");

    fixture.sign_in_as(Some("9999")).await;
    for path in ["status", "coverage", "disk"] {
        let (status, body) = fixture.get(&format!("/api/collector/{path}")).await;
        assert_eq!((status, body["error"]["code"].as_str()), (403, Some("forbidden")), "목록에 없는 계정 {path}: {body}");
    }
    assert_eq!(fixture.access().await, "denied");
    fixture.assert_other_methods_answer(403, Some("forbidden"), "목록에 없는 계정").await;
    assert!(!daemon.requests().iter().any(|line| line.contains("coverage") || line.contains("disk")), "인가가 먼저다. 거절한 요청은 데몬에 닿지 않는다");

    fixture.accounts.answer_me_with(Some("1234"));
    fixture.sign_in().await;
    assert_eq!(fixture.access().await, "allowed", "로그인이 바뀌면 권한이 따라간다");
    fixture.sign_out().await;
    assert_eq!(fixture.access().await, "denied");
    assert_eq!(fixture.get("/api/collector/status").await.0, 403);
}

#[tokio::test]
async fn the_same_subject_under_another_provider_is_not_allowed() {
    let fixture = Fixture::start(Options::allowed_board()).await;
    let mut me = json!({"id": "acc-1", "provider": "naver", "subject": "1234"});
    me["created_at"] = json!(1);
    *fixture.accounts.me.lock().unwrap() = me;
    fixture.sign_in().await;
    assert_eq!(fixture.access().await, "denied");
    assert_eq!(fixture.get("/api/collector/status").await.0, 403);
}

async fn assert_board_is_off(mut fixture: Fixture, name: &str) {
    let daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.go();
    assert!(fixture.state.system.collector().is_none(), "{name}");
    assert_eq!(fixture.access().await, "off", "{name}");
    for path in ["status", "coverage", "disk"] {
        let (status, body) = fixture.get(&format!("/api/collector/{path}")).await;
        assert_eq!((status, body["error"]["code"].as_str()), (404, Some("not_found")), "{name} {path}: {body}");
    }
    fixture.assert_other_methods_answer(404, Some("not_found"), name).await;
    tokio::time::sleep(HEARTBEAT_EVERY * 20).await;
    assert!(daemon.requests().is_empty(), "{name}: 감시 태스크가 돌지 않는다");
}

#[tokio::test]
async fn an_empty_allow_list_turns_the_board_off_even_for_a_signed_in_account() {
    let fixture = Fixture::start(Options { admins: &[], ..Options::allowed_board() }).await;
    fixture.sign_in_as(Some("1234")).await;
    assert_board_is_off(fixture, "빈 허용 목록").await;
}

#[tokio::test]
async fn local_only_mode_turns_the_board_off_even_with_an_allow_list() {
    let fixture = Fixture::start(Options { linked: false, ..Options::allowed_board() }).await;
    assert_board_is_off(fixture, "로컬 전용").await;
}

#[tokio::test]
async fn a_missing_socket_means_the_daemon_is_down_and_the_last_status_is_kept() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
    let (status, body) = fixture.get("/api/collector/status").await;
    assert_eq!((status, body["judgment"].as_str(), body["status"].is_null(), body["received_at"].is_null()), (200, Some("down"), true, true), "{body}");
    let (status, body) = fixture.get("/api/collector/coverage").await;
    assert_eq!((status, body["error"]["code"].as_str()), (503, Some("collector_unavailable")), "{body}");

    let mut daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.reached(DaemonJudgment::Healthy).await;
    daemon.stop().await;
    fixture.reached(DaemonJudgment::Down).await;
    let (status, body) = fixture.get("/api/collector/status").await;
    assert_eq!((status, body["judgment"].as_str(), body["status"]["date"].as_u64()), (200, Some("down"), Some(20261118)), "꺼져도 마지막 상태와 받은 시각을 준다: {body}");
    assert!(body["received_at"].is_i64());
}

#[tokio::test]
async fn three_missed_heartbeats_after_connecting_mean_no_response() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let daemon = Daemon::start(&fixture.socket, Mode::Mute);
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    daemon.wait_for_connections(1).await;
    let connected = Instant::now();
    let limit = HEARTBEAT_EVERY * MISSED_HEARTBEATS;
    tokio::time::sleep(limit - Duration::from_secs(1)).await;
    assert_eq!(fixture.judgment(), DaemonJudgment::Checking, "15초가 차기 전에는 응답 없음이 아니다");
    fixture.reached(DaemonJudgment::Unresponsive).await;
    assert_elapsed(connected.elapsed(), limit, "하트비트 3번(15초)");
    let (_, body) = fixture.get("/api/collector/status").await;
    assert_eq!((body["judgment"].as_str(), body["status"]["date"].as_u64()), (Some("unresponsive"), Some(20261118)), "{body}");
}

#[tokio::test]
async fn heartbeats_keep_the_daemon_healthy_even_when_it_waits_outside_market_hours() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let daemon = Daemon::start(&fixture.socket, Mode::BeatingOffHours);
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Healthy).await;
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(fixture.judgment(), DaemonJudgment::Healthy);
    let (_, body) = fixture.get("/api/collector/status").await;
    assert_eq!((body["judgment"].as_str(), body["status"]["phase"].as_str()), (Some("healthy"), Some("off_hours")));
    assert_eq!(daemon.requests().len(), 1, "연결은 하나를 유지한다");
}

#[tokio::test]
async fn the_connector_reconnects_with_growing_gaps_and_returns_to_healthy_when_the_daemon_is_back() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
    let first_try = Instant::now();
    assert_eq!(RECONNECT_BACKOFF.map(|gap| gap.as_secs()), [1, 2, 5, 10, 30]);
    tokio::time::sleep(Duration::from_secs(4)).await;
    let daemon = Daemon::start(&fixture.socket, Mode::Beating);
    daemon.wait_for_connections(1).await;
    assert_elapsed(first_try.elapsed(), Duration::from_secs(1 + 2 + 5), "시도 간격 1, 2, 5초");
    fixture.reached(DaemonJudgment::Healthy).await;

    let mut daemon = daemon;
    daemon.stop().await;
    fixture.reached(DaemonJudgment::Down).await;
    tokio::time::sleep(Duration::from_secs(100)).await;
    let daemon = Daemon::start(&fixture.socket, Mode::Beating);
    daemon.wait_for_connections(1).await;
    fixture.reached(DaemonJudgment::Healthy).await;
}

#[tokio::test]
async fn the_wait_between_tries_stops_growing_at_thirty_seconds() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
    let first_try = Instant::now();
    tokio::time::sleep(Duration::from_secs(1 + 2 + 5 + 10 + 30 + 30 + 1)).await;
    let daemon = Daemon::start(&fixture.socket, Mode::Beating);
    daemon.wait_for_connections(1).await;
    assert_elapsed(first_try.elapsed(), Duration::from_secs(1 + 2 + 5 + 10 + 30 + 30 + 30), "마지막 간격 30초를 되풀이한다");
}

#[tokio::test]
async fn a_line_exactly_at_the_limit_is_read() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let daemon = Daemon::start(&fixture.socket, Mode::StatusOfBytes(MAX_LINE_BYTES));
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Healthy).await;
    let (_, body) = fixture.get("/api/collector/status").await;
    assert_eq!(body["status"]["date"].as_u64(), Some(20261118), "한도와 같은 길이의 줄은 읽는다: {body}");
    assert_eq!(daemon.requests().len(), 1, "연결이 끊기지 않았다");
}

#[tokio::test]
async fn a_line_one_byte_over_the_limit_drops_the_connection() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let daemon = Daemon::start(&fixture.socket, Mode::StatusOfBytes(MAX_LINE_BYTES + 1));
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    daemon.wait_for_connections(2).await;
    let (_, body) = fixture.get("/api/collector/status").await;
    assert_eq!((body["judgment"].as_str() != Some("healthy"), body["status"].is_null()), (true, true), "한도보다 1바이트 긴 줄은 읽지 않고 연결을 끊는다: {body}");
}

#[tokio::test]
async fn a_connection_that_heard_a_heartbeat_reconnects_after_one_second_then_grows_from_the_start_of_the_steps() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    let mut daemon = Daemon::start(&fixture.socket, Mode::Beating);
    daemon.wait_for_connections(1).await;
    fixture.reached(DaemonJudgment::Healthy).await;

    daemon.stop().await;
    let lost = Instant::now();
    tokio::time::sleep(Duration::from_secs(5)).await;
    let daemon = Daemon::start(&fixture.socket, Mode::Beating);
    daemon.wait_for_connections(1).await;
    assert_elapsed(lost.elapsed(), RECONNECT_BACKOFF[0] + RECONNECT_BACKOFF[1] + RECONNECT_BACKOFF[2], "하트비트를 들은 연결 뒤 시도 간격은 1, 2, 5초다");
}

#[tokio::test]
async fn a_daemon_that_speaks_another_format_version_is_flagged_and_not_interpreted() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let _daemon = Daemon::start(&fixture.socket, Mode::NewerVersion);
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::VersionMismatch).await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    let (_, body) = fixture.get("/api/collector/status").await;
    assert_eq!((body["judgment"].as_str(), body["status"].is_null()), (Some("version_mismatch"), true), "{body}");
}

#[tokio::test]
async fn a_line_over_the_limit_drops_the_connection_and_the_connector_tries_again() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let daemon = Daemon::start(&fixture.socket, Mode::EndlessLine);
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    daemon.wait_for_connections(2).await;
    assert_ne!(fixture.judgment(), DaemonJudgment::Healthy);
}

#[tokio::test]
async fn only_down_and_no_response_are_announced_and_a_recovery_is_not() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let mut notices = fixture.board().subscribe_notices();
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
    assert_eq!(notices.try_recv().unwrap().judgment, DaemonJudgment::Down);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(notices.try_recv().is_err(), "꺼짐이 이어지는 동안 다시 알리지 않는다");

    let mut daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.reached(DaemonJudgment::Healthy).await;
    assert!(notices.try_recv().is_err(), "정상 복귀는 알리지 않는다");
    daemon.stop().await;
    fixture.reached(DaemonJudgment::Down).await;
    assert_eq!(notices.try_recv().unwrap().judgment, DaemonJudgment::Down);

    let _mute = Daemon::start(&fixture.socket, Mode::Mute);
    fixture.reached(DaemonJudgment::Unresponsive).await;
    assert_eq!(notices.try_recv().unwrap().judgment, DaemonJudgment::Unresponsive);
    assert!(notices.try_recv().is_err());
}

#[tokio::test]
async fn the_browser_notice_reaches_a_connection_only_while_the_current_login_is_allowed() {
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    let addr = serve_http(fixture.state.clone()).await;
    let mut daemon = Daemon::start(&fixture.socket, Mode::Beating);
    let mut browser = open_ws(addr).await;
    assert!(next_message_of_type(&mut browser, "hello", WAIT).await.is_some());
    fixture.go();
    fixture.reached(DaemonJudgment::Healthy).await;
    daemon.stop().await;
    fixture.reached(DaemonJudgment::Down).await;
    assert!(next_message_of_type(&mut browser, "collector_daemon", Duration::from_secs(10)).await.is_none(), "로그인 없음에는 보내지 않는다");

    fixture.sign_in_as(Some("1234")).await;
    fixture.wait_until_the_browser_is_told_of_the_login(&mut browser).await;
    let mut daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.reached(DaemonJudgment::Healthy).await;
    daemon.stop().await;
    fixture.reached(DaemonJudgment::Down).await;
    let notice = next_message_of_type(&mut browser, "collector_daemon", WAIT).await.expect("연결을 연 뒤에 허용된 계정이 로그인했어도 보낼 때의 로그인으로 판정해 알린다");
    assert_eq!(notice["judgment"], "down");
    assert!(notice["at"].as_i64().unwrap() > 1_700_000_000);

    let mut mute = Daemon::start(&fixture.socket, Mode::Mute);
    fixture.reached(DaemonJudgment::Unresponsive).await;
    let notice = next_message_of_type(&mut browser, "collector_daemon", WAIT).await.expect("응답 없음도 알린다");
    assert_eq!(notice["judgment"], "unresponsive");
    mute.stop().await;

    fixture.sign_out().await;
    fixture.sign_in_as(Some("9999")).await;
    fixture.wait_until_the_browser_is_told_of_the_login(&mut browser).await;
    let mut daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.reached(DaemonJudgment::Healthy).await;
    daemon.stop().await;
    fixture.reached(DaemonJudgment::Down).await;
    assert!(next_message_of_type(&mut browser, "collector_daemon", Duration::from_secs(10)).await.is_none(), "목록에 없는 계정이 로그인한 연결에는 보내지 않는다");
    let _mute = Daemon::start(&fixture.socket, Mode::Mute);
    fixture.reached(DaemonJudgment::Unresponsive).await;
    assert!(next_message_of_type(&mut browser, "collector_daemon", Duration::from_secs(10)).await.is_none());
}

#[tokio::test]
async fn a_login_without_a_subject_from_an_older_account_server_signs_in_but_gets_no_access() {
    let fixture = Fixture::start(Options::allowed_board()).await;
    let _daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.sign_in_as(None).await;
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&fixture.state_file).unwrap()).unwrap();
    assert_eq!(saved["account_id"], "acc-1", "로그인 자체는 된다");
    assert!(saved.get("subject").is_none());
    assert!(matches!(fixture.state.system.account().status(&fixture.state.db).await.unwrap(), server::api::AccountStatus::SignedIn { .. }));
    assert_eq!(fixture.access().await, "denied");
    let (status, body) = fixture.get("/api/collector/status").await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("forbidden")), "{body}");
}

#[tokio::test]
async fn a_login_saves_the_subject_to_the_state_file() {
    let fixture = Fixture::start(Options::allowed_board()).await;
    fixture.sign_in_as(Some("1234")).await;
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&fixture.state_file).unwrap()).unwrap();
    assert_eq!(saved["subject"], "1234");
    assert_eq!(saved["account_id"], "acc-1");
    assert_eq!(fixture.access().await, "allowed");
}

#[tokio::test]
async fn a_state_file_without_a_subject_is_still_read_and_filled_from_the_account_server() {
    let mut legacy = Fixture::start(Options { legacy_login_without_subject: true, ..Options::allowed_board() }).await;
    let status = legacy.state.system.account().status(&legacy.state.db).await.unwrap();
    assert!(matches!(status, server::api::AccountStatus::SignedIn { .. }), "옛 상태 파일의 로그인이 그대로 읽힌다: {status:?}");
    assert_eq!(legacy.access().await, "denied", "subject를 채우기 전에는 권한이 없다");
    legacy.go();
    legacy.wait_for_account_change().await;
    assert_eq!(legacy.access().await, "allowed", "저장된 로그인에 subject가 없으면 me로 채운다");
    let refilled: Value = serde_json::from_str(&std::fs::read_to_string(&legacy.state_file).unwrap()).unwrap();
    assert_eq!(refilled["subject"], "1234", "채운 값은 상태 파일에 남는다");
    assert_eq!(refilled["token"], "legacy-token");
}

#[tokio::test]
async fn a_saved_login_stays_without_access_while_the_account_server_still_sends_no_subject() {
    let mut legacy = Fixture::start(Options { legacy_login_without_subject: true, account_subject: None, ..Options::allowed_board() }).await;
    legacy.go();
    let mut me_requests = legacy.accounts.me_requests.subscribe();
    tokio::time::timeout(WAIT, me_requests.wait_for(|count| *count >= 1)).await.unwrap().unwrap();
    legacy.state.system.account().refresh().await.unwrap();
    assert_eq!(legacy.access().await, "denied");
    assert_eq!(legacy.get("/api/collector/status").await.0, 403);
    legacy.accounts.answer_me_with(Some("1234"));
    legacy.state.system.account().refresh().await.unwrap();
    legacy.wait_for_account_change().await;
    assert_eq!(legacy.access().await, "allowed", "계정 서버가 subject를 내주기 시작하면 다음 새로 고침에서 채워진다");
}

#[tokio::test]
async fn down_and_no_response_go_to_telegram_and_a_recovery_does_not() {
    let hook = FakeTelegram::start(200).await;
    let folder = tempfile::tempdir().unwrap();
    let mut fixture = Fixture::start(Options { telegram: Some(hook.telegram(folder.path())), ..Options::allowed_board() }).await;
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
    hook.wait_for_calls(1).await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(hook.texts().len(), 1, "꺼짐이 이어지는 동안 다시 보내지 않는다");

    let mut daemon = Daemon::start(&fixture.socket, Mode::Beating);
    fixture.reached(DaemonJudgment::Healthy).await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(hook.texts().len(), 1, "정상 복귀는 보내지 않는다");
    daemon.stop().await;
    fixture.reached(DaemonJudgment::Down).await;
    hook.wait_for_calls(2).await;

    let _mute = Daemon::start(&fixture.socket, Mode::Mute);
    fixture.reached(DaemonJudgment::Unresponsive).await;
    hook.wait_for_calls(3).await;
    let texts = hook.texts();
    assert_eq!(texts.len(), 3, "{texts:?}");
    assert!(texts[0].starts_with("[수집 경보] 2026-11-18 09:") && texts[0].ends_with(" KST · 감독 데몬이 꺼져 있습니다"), "{texts:?}");
    assert!(texts[1].ends_with("감독 데몬이 꺼져 있습니다") && texts[2].ends_with("감독 데몬이 응답하지 않습니다"), "{texts:?}");
    assert!(texts.iter().all(|text| !text.contains(TELEGRAM_SECRET)));
    let routes = hook.routes.lock().unwrap().clone();
    assert_eq!(routes.len(), 3);
    assert!(routes.iter().all(|(path, chat_id)| path == &format!("/bot123456:{TELEGRAM_SECRET}/sendMessage") && chat_id == TELEGRAM_CHAT_ID), "{routes:?}");
}

#[tokio::test]
async fn a_telegram_that_fails_leaves_the_judgment_alone_and_its_token_out_of_the_log() {
    let capture = LogCapture::default();
    let subscriber = tracing_subscriber::fmt().with_writer(capture.clone()).with_ansi(false).with_max_level(tracing::Level::TRACE).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let hook = FakeTelegram::start(500).await;
    let folder = tempfile::tempdir().unwrap();
    let mut fixture = Fixture::start(Options { telegram: Some(hook.telegram(folder.path())), ..Options::allowed_board() }).await;
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
    hook.wait_for_calls(1).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(fixture.judgment(), DaemonJudgment::Down);
    let logs = String::from_utf8_lossy(&capture.0.lock().unwrap()).into_owned();
    assert!(logs.contains("수집 경보를 텔레그램으로 보내지 못했습니다"), "{logs}");
    for hidden in [TELEGRAM_SECRET, "/bot123456"] {
        assert!(!logs.contains(hidden), "{hidden}가 로그에 나온다: {logs}");
    }
    let (_, status) = fixture.get("/api/collector/status").await;
    assert!(!status.to_string().contains(TELEGRAM_SECRET));
}

#[tokio::test]
async fn a_board_without_a_telegram_file_runs_as_before() {
    let folder = tempfile::tempdir().unwrap();
    assert!(Telegram::load(&folder.path().join("telegram")).unwrap().is_none());
    let mut fixture = Fixture::start(Options::allowed_board()).await;
    fixture.sign_in_as(Some("1234")).await;
    fixture.go();
    fixture.reached(DaemonJudgment::Down).await;
}
