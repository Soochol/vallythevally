use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use collector::keys::{ActiveKey, KeyIdentity, KeyRole};
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile};
use collector::protocol::{Command as ChildCommand, Event, KeyName, SessionState};
use collector::supervise::{
    ChildMessage, ChildProcess, Control, DayPhase, Injected, Inputs, KeyState, Launcher, Reply, Request, Settings, SocketSetting, Spawned, StartError,
    Supervisor,
};
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::token_file::credential_id;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, timeout};

const DATE: u32 = 20261118;
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/status");
const SECRET_MARKERS: [&str; 4] = ["FAKE-APPKEY", "FAKE-SECRET", "FAKE-TOKEN", "sha256:"];

fn app_key_of(name: &str) -> String {
    format!("FAKE-APPKEY-{name}")
}

fn short_folder() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("vs").tempdir_in("/tmp").unwrap()
}

fn fixture(name: &str) -> Value {
    let text = std::fs::read_to_string(Path::new(FIXTURES).join(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn fixture_line(name: &str) -> String {
    format!("{}\n", fixture(name))
}

struct FakeTransport {
    counter: AtomicUsize,
}

impl Transport for FakeTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let body: Value = serde_json::from_str(request.body.expose()).unwrap();
        let app_key = body["appkey"].as_str().unwrap().to_owned();
        let number = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let reply = json!({"token": format!("FAKE-TOKEN-{number}-for-{app_key}"), "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"});
        Box::pin(async move { Ok(HttpResponse { status: 200, next_key: None, body: reply.to_string() }) })
    }
}

struct BeatingChild {
    events: mpsc::UnboundedSender<ChildMessage>,
}

impl ChildProcess for BeatingChild {
    fn send(&mut self, command: &ChildCommand) {
        if *command == ChildCommand::Shutdown {
            let _ = self.events.send(ChildMessage::Exited(Some(0)));
        }
    }

    fn terminate(&mut self) {
        let _ = self.events.send(ChildMessage::Exited(Some(0)));
    }

    fn kill(&mut self) {
        let _ = self.events.send(ChildMessage::Exited(Some(137)));
    }
}

struct BeatingLauncher {
    silent: Vec<String>,
}

impl Launcher for BeatingLauncher {
    fn launch(&self, key: &KeyName) -> io::Result<Spawned> {
        let (events, messages) = mpsc::unbounded_channel();
        let _ = events.send(ChildMessage::Event(Event::Hello { key: key.clone(), pid: 4000 }));
        if !self.silent.iter().any(|silent| silent == key.as_str()) {
            let beating = events.clone();
            tokio::spawn(async move {
                loop {
                    sleep(Duration::from_secs(5)).await;
                    if beating.send(ChildMessage::Event(Event::Heartbeat { frames: 50, bytes: 5000, state: SessionState::Live })).is_err() {
                        return;
                    }
                }
            });
        }
        Ok(Spawned { pid: Some(4000), process: Box::new(BeatingChild { events }), messages })
    }
}

fn share(name: &str, role: KeyRole, stocks: Vec<String>, market: bool) -> KeyShare {
    KeyShare {
        name: KeyName::parse(name).unwrap(),
        role,
        app_key_hash: credential_id(&app_key_of(name)),
        stocks,
        market_types: if market { MARKET_TYPES.to_vec() } else { Vec::new() },
        rest_jobs: Vec::new(),
        load: 0,
    }
}

fn plan_for(collecting: usize, stocks_each: usize, excluded: usize) -> PlanFile {
    let mut keys: Vec<KeyShare> = (0..collecting)
        .map(|number| {
            let stocks = (0..stocks_each).map(|stock| format!("{:06}", number * stocks_each + stock + 1)).collect();
            share(&format!("collect-{:02}", number + 1), KeyRole::Collecting, stocks, number == 0)
        })
        .collect();
    keys.push(share("spare-01", KeyRole::Spare, Vec::new(), false));
    PlanFile {
        format_version: 1,
        date: DATE,
        created_at: "2026-11-18T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: keys.len(), universe_replaced: None },
        keys,
        excluded: (0..excluded).map(|number| format!("9{number:05}")).collect(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    }
}

fn active_keys_for(folder: &Path, plan: &PlanFile) -> Vec<ActiveKey> {
    plan.keys
        .iter()
        .map(|share| ActiveKey {
            identity: KeyIdentity { name: share.name.clone(), role: share.role, app_key_hash: share.app_key_hash.clone() },
            app_key: Secret::new(app_key_of(share.name.as_str())),
            app_secret: Secret::new(format!("FAKE-SECRET-{}", share.name)),
            token_path: folder.join(share.name.as_str()).join("token.json"),
            lock_path: folder.join(share.name.as_str()).join("collector.lock"),
        })
        .collect()
}

struct World {
    folder: tempfile::TempDir,
    _sockets: tempfile::TempDir,
    socket: PathBuf,
    stop: watch::Sender<bool>,
    done: tokio::task::JoinHandle<()>,
    control: Control,
    status: watch::Receiver<collector::supervise::DaemonStatus>,
}

impl World {
    fn try_start(plan: PlanFile, silent: &[&str], prepare_socket: impl FnOnce(&Path)) -> Result<World, StartError> {
        let sockets = short_folder();
        prepare_socket(sockets.path());
        let socket = sockets.path().join("run").join("supervise.sock");
        World::launch(plan, silent, sockets, socket, true)
    }

    fn try_start_on(plan: PlanFile, socket: &Path, required: bool) -> Result<World, StartError> {
        World::launch(plan, &[], short_folder(), socket.to_owned(), required)
    }

    fn launch(plan: PlanFile, silent: &[&str], sockets: tempfile::TempDir, socket: PathBuf, required: bool) -> Result<World, StartError> {
        let folder = tempfile::tempdir().unwrap();
        let injected = Injected {
            launcher: Arc::new(BeatingLauncher { silent: silent.iter().map(|name| (*name).to_owned()).collect() }),
            transport: Arc::new(FakeTransport { counter: AtomicUsize::new(0) }),
            clock: Clock::fake(kst(KstDate::new(2026, 11, 18).unwrap(), 9, 0, 0)),
        };
        let settings = Settings { status_socket: Some(SocketSetting { path: socket.clone(), required }), end_at: None, ..Settings::default() };
        let keys = active_keys_for(folder.path(), &plan);
        let supervisor = Supervisor::start(Inputs { plan, keys, data_dir: folder.path().join("data"), settings }, injected)?;
        let (status, control) = (supervisor.status(), supervisor.control());
        let (stop, shutdown) = watch::channel(false);
        let done = tokio::spawn(supervisor.run(shutdown));
        Ok(World { folder, _sockets: sockets, socket, stop, done, control, status })
    }

    fn start(plan: PlanFile) -> World {
        World::try_start(plan, &[], |_| {}).unwrap_or_else(|error| panic!("시작하지 못했다: {error}"))
    }

    fn data(&self) -> PathBuf {
        self.folder.path().join("data")
    }

    async fn connect(&self) -> Client {
        let (reader, writer) = UnixStream::connect(&self.socket).await.unwrap().into_split();
        Client { reader: BufReader::new(reader), writer }
    }

    async fn finish(self) {
        self.stop.send(true).unwrap();
        timeout(Duration::from_secs(60), self.done).await.expect("데몬이 끝나지 않았다").unwrap();
        assert!(!self.socket.exists(), "끝난 데몬은 소켓 파일을 지운다");
    }
}

struct Client {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

impl Client {
    async fn send(&mut self, line: &str) {
        self.writer.write_all(line.as_bytes()).await.unwrap();
    }

    async fn read_text(&mut self) -> String {
        let mut line = String::new();
        let read = timeout(Duration::from_secs(30), self.reader.read_line(&mut line)).await.expect("응답이 오지 않았다").unwrap();
        assert!(read > 0, "연결이 닫혔다");
        line
    }

    async fn read(&mut self) -> Value {
        serde_json::from_str(&self.read_text().await).unwrap()
    }

    async fn ask(&mut self, request: &str) -> Value {
        self.send(&format!("{request}\n")).await;
        self.read().await
    }
}

fn same_shape(fixture: &Value, actual: &Value, path: &str) {
    match (fixture, actual) {
        (Value::Null, _) | (_, Value::Null) => {}
        (Value::Object(expected), Value::Object(found)) => {
            let names = |map: &serde_json::Map<String, Value>| map.keys().cloned().collect::<Vec<_>>();
            assert_eq!(names(expected), names(found), "{path}의 필드 이름");
            for (name, value) in expected {
                same_shape(value, &found[name], &format!("{path}.{name}"));
            }
        }
        (Value::Array(expected), Value::Array(found)) => {
            if let Some(first) = expected.first() {
                for (index, item) in found.iter().enumerate() {
                    same_shape(first, item, &format!("{path}[{index}]"));
                }
            }
        }
        (Value::Number(expected), Value::Number(found)) => assert_eq!(expected.is_f64(), found.is_f64(), "{path}의 수 형"),
        (Value::String(_), Value::String(_)) | (Value::Bool(_), Value::Bool(_)) => {}
        _ => panic!("{path}의 형이 다르다: 예시 {fixture}, 실제 {actual}"),
    }
}

fn error_code(reply: &Value) -> &str {
    assert_eq!(reply["type"], "error", "{reply}");
    reply["code"].as_str().unwrap()
}

#[test]
fn every_fixture_parses_into_the_wire_types_and_serializes_back_unchanged() {
    for name in std::fs::read_dir(FIXTURES).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()) {
        let value = fixture(&name);
        let again = if name.starts_with("request-") {
            serde_json::to_value(serde_json::from_value::<Request>(value.clone()).unwrap()).unwrap()
        } else {
            serde_json::to_value(serde_json::from_value::<Reply>(value.clone()).unwrap()).unwrap()
        };
        assert_eq!(value, again, "{name}");
    }
}

fn leftover_socket_at(sockets: &Path) {
    let socket = sockets.join("run").join("supervise.sock");
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
    assert!(socket.exists());
    let refused = || std::os::unix::net::UnixStream::connect(&socket).is_err_and(|error| error.kind() == io::ErrorKind::ConnectionRefused);
    for _ in 0..200 {
        if refused() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("닫은 소켓이 계속 연결을 받는다");
}

#[tokio::test(start_paused = true)]
async fn the_socket_is_private_and_a_leftover_socket_file_does_not_stop_the_start() {
    let world = World::try_start(plan_for(2, 3, 0), &[], leftover_socket_at).unwrap();
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&world.socket), 0o600);
    world.connect().await;
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_folder_the_daemon_creates_is_private_and_a_regular_file_at_the_path_is_refused() {
    let world = World::start(plan_for(2, 3, 0));
    assert_eq!(std::fs::metadata(world.socket.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    world.finish().await;

    let refused = World::try_start(plan_for(2, 3, 0), &[], |sockets| {
        let socket = sockets.join("run").join("supervise.sock");
        std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
        std::fs::write(&socket, "내용").unwrap();
    });
    assert!(matches!(refused, Err(StartError::StatusSocket { .. })));
}

#[tokio::test(start_paused = true)]
async fn each_reply_has_the_shape_of_its_fixture() {
    let world = World::start(plan_for(2, 3, 2));
    sleep(Duration::from_secs(30)).await;
    let data = world.data();
    finalize_a_day(&data, 20261117, true);
    std::fs::create_dir_all(data.join("raw/20261117/collect-01")).unwrap();
    std::fs::write(data.join("raw/20261117/collect-01/a.zst"), "12345").unwrap();
    let mut client = world.connect().await;
    for (request, expected) in [
        ("request-status.json", "reply-status.json"),
        ("request-coverage.json", "reply-coverage.json"),
        ("request-disk.json", "reply-disk.json"),
    ] {
        let reply = client.ask(fixture_line(request).trim()).await;
        same_shape(&fixture(expected), &reply, expected);
    }
    let coverage = client.ask(fixture_line("request-coverage.json").trim()).await;
    let complete_day = coverage["days"].as_array().unwrap().iter().find(|day| day["date"] == 20261117).unwrap();
    assert_eq!(complete_day["state"], "complete");
    same_shape(&fixture("reply-coverage.json")["days"][1], complete_day, "coverage의 complete 날");
    let status = client.ask(fixture_line("request-status.json").trim()).await;
    assert_eq!(status["status"]["alerts"][0]["kind"], "excluded");
    assert_eq!(status["status"]["today"]["excluded_stocks"], 2);
    assert_eq!(status["status"]["observation_day"], Value::Null);
    assert_eq!(status["status"]["universe_changes"], Value::Null);

    let mut watcher = world.connect().await;
    watcher.send(&fixture_line("request-watch.json")).await;
    same_shape(&fixture("reply-status.json"), &watcher.read().await, "watch의 첫 상태");
    assert_eq!(watcher.read().await["type"], "status");
    same_shape(&fixture("reply-heartbeat.json"), &watcher.read().await, "watch의 하트비트");

    let unknown = client.ask(r#"{"v":1,"type":"nonsense"}"#).await;
    same_shape(&fixture("reply-error-unknown-request.json"), &unknown, "unknown");
    let command = client.ask(r#"{"v":1,"type":"restart"}"#).await;
    same_shape(&fixture("reply-error-read-only.json"), &command, "read_only");
    let version = client.ask(r#"{"v":2,"type":"status"}"#).await;
    same_shape(&fixture("reply-error-unsupported-version.json"), &version, "unsupported_version");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_status_counts_stocks_and_lists_alerts_after_a_handoff() {
    let world = World::try_start(plan_for(2, 3, 2), &["collect-02"], |_| {}).unwrap();
    sleep(Duration::from_secs(200)).await;
    let mut client = world.connect().await;
    let reply = client.ask(r#"{"v":1,"type":"status"}"#).await;
    let status = &reply["status"];
    assert_eq!(status["today"], json!({"planned_stocks": 6, "receiving_stocks": 6, "register_failed_batches": 0, "disconnected_stocks": 0, "handed_off_stocks": 3, "excluded_stocks": 2}));
    let kinds: Vec<&str> = status["alerts"].as_array().unwrap().iter().map(|alert| alert["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"excluded") && kinds.contains(&"handoff") && kinds.contains(&"key_stopped"), "{kinds:?}");
    let keys = status["keys"].as_array().unwrap();
    let second = keys.iter().find(|key| key["name"] == "collect-02").unwrap();
    assert_eq!(second["state"], "handed_off");
    assert_eq!(second["app_key_hash_prefix"].as_str().unwrap(), &credential_id(&app_key_of("collect-02"))["sha256:".len()..][..8]);
    assert_eq!(world.status.borrow().keys.iter().find(|key| key.name.as_str() == "spare-01").unwrap().state, KeyState::Receiving);
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_watching_connection_gets_a_heartbeat_every_five_seconds_and_a_phase_change_at_once() {
    let world = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    let mut client = world.connect().await;
    let begun = Instant::now();
    client.send(&fixture_line("request-watch.json")).await;
    assert_eq!(client.read().await["type"], "status");
    let mut beats = Vec::new();
    for expected in 1..=3_u64 {
        let status = client.read().await;
        assert_eq!(status["type"], "status");
        let heartbeat = client.read().await;
        assert_eq!(heartbeat["type"], "heartbeat");
        assert_eq!(heartbeat["sequence"], expected);
        assert_eq!(heartbeat["phase"], "collecting");
        beats.push(begun.elapsed().as_secs());
    }
    assert_eq!(beats, [5, 10, 15]);

    let changed_at = Instant::now();
    world.control.enter_phase(DayPhase::AfterClose);
    let status = client.read().await;
    assert_eq!(status["type"], "status");
    assert_eq!(status["status"]["phase"], "after_close");
    assert!(changed_at.elapsed() < Duration::from_secs(1), "단계가 바뀌면 다음 하트비트를 기다리지 않는다: {:?}", changed_at.elapsed());
    let heartbeat = loop {
        let next = client.read().await;
        if next["type"] == "heartbeat" {
            break next;
        }
    };
    assert_eq!(heartbeat["phase"], "after_close");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_never_reads_is_dropped_without_slowing_other_connections_or_the_children() {
    let world = World::start(plan_for(2, 3, 2));
    sleep(Duration::from_secs(20)).await;
    let mut slow = world.connect().await;
    slow.send(&fixture_line("request-watch.json")).await;
    let mut healthy = world.connect().await;
    healthy.send(&fixture_line("request-watch.json")).await;
    assert_eq!(healthy.read().await["type"], "status");

    let mut heartbeat_times = Vec::new();
    let begun = Instant::now();
    while begun.elapsed() < Duration::from_secs(4000) {
        let reply = healthy.read().await;
        if reply["type"] == "heartbeat" {
            heartbeat_times.push(begun.elapsed().as_secs());
        }
    }
    let gaps: Vec<u64> = heartbeat_times.windows(2).map(|pair| pair[1] - pair[0]).collect();
    assert!(gaps.len() > 700 && gaps.iter().all(|gap| *gap == 5), "건강한 연결의 하트비트 간격: {:?}", gaps.iter().filter(|gap| **gap != 5).collect::<Vec<_>>());

    let mut leftover = Vec::new();
    timeout(Duration::from_secs(30), slow.reader.read_to_end(&mut leftover)).await.expect("읽지 않던 연결은 끊긴다").unwrap();
    assert!(!leftover.is_empty());

    let keys = world.status.borrow().keys.clone();
    assert!(keys.iter().all(|key| key.restarts == 0), "느린 연결 때문에 자식 감시가 늦어 재시작이 생겼다: {keys:?}");
    assert_eq!(keys.iter().find(|key| key.name.as_str() == "collect-01").unwrap().state, KeyState::Receiving);
    let journal = std::fs::read_to_string(collector::supervise::journal_path(&world.data(), DATE)).unwrap();
    assert!(!journal.contains("heartbeat_lost"), "{journal}");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn unknown_requests_get_an_error_line_and_command_like_requests_are_refused_without_effect() {
    let world = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    let restarts_before: Vec<u32> = world.status.borrow().keys.iter().map(|key| key.restarts).collect();
    let mut client = world.connect().await;
    assert_eq!(error_code(&client.ask(r#"{"v":1,"type":"nonsense"}"#).await), "unknown_request");
    for command in ["restart", "handoff", "stop", "shutdown", "register"] {
        let reply = client.ask(&format!(r#"{{"v":1,"type":"{command}","key":"collect-01"}}"#)).await;
        assert_eq!(error_code(&reply), "read_only", "{command}");
    }
    assert_eq!(error_code(&client.ask("not json").await), "bad_request");
    assert_eq!(error_code(&client.ask(r#"{"type":"status"}"#).await), "bad_request");
    assert_eq!(error_code(&client.ask(r#"{"v":2,"type":"status"}"#).await), "unsupported_version");
    assert_eq!(client.ask(r#"{"v":1,"type":"status"}"#).await["type"], "status", "거절 뒤에도 연결은 쓸 수 있다");
    sleep(Duration::from_secs(60)).await;
    let restarts_after: Vec<u32> = world.status.borrow().keys.iter().map(|key| key.restarts).collect();
    assert_eq!(restarts_before, restarts_after);
    assert!(world.status.borrow().keys.iter().all(|key| key.state != KeyState::HandedOff));

    let mut oversized = world.connect().await;
    oversized.send(&"a".repeat(10_000)).await;
    let mut rest = Vec::new();
    let _ = timeout(Duration::from_secs(5), oversized.reader.read_to_end(&mut rest)).await.expect("너무 긴 줄 뒤에는 연결이 닫힌다");
    if !rest.is_empty() {
        assert_eq!(error_code(&serde_json::from_slice(rest.split(|byte| *byte == b'\n').next().unwrap()).unwrap()), "bad_request");
    }
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn no_reply_contains_an_app_key_a_token_or_a_full_hash() {
    let world = World::start(plan_for(2, 3, 1));
    sleep(Duration::from_secs(30)).await;
    std::fs::create_dir_all(world.data().join("store/20261117")).unwrap();
    let mut client = world.connect().await;
    let mut seen = String::new();
    for request in [r#"{"v":1,"type":"status"}"#, r#"{"v":1,"type":"coverage"}"#, r#"{"v":1,"type":"disk"}"#, r#"{"v":1,"type":"token"}"#] {
        client.send(&format!("{request}\n")).await;
        seen += &client.read_text().await;
    }
    client.send(&fixture_line("request-watch.json")).await;
    for _ in 0..4 {
        seen += &client.read_text().await;
    }
    assert!(seen.contains("app_key_hash_prefix"));
    for marker in SECRET_MARKERS {
        assert!(!seen.contains(marker), "{marker}가 응답에 있다: {seen}");
    }
    world.finish().await;
}

fn collector_status(arguments: &[&str]) -> (Option<i32>, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_collector")).arg("status").args(arguments).output().unwrap();
    (output.status.code(), String::from_utf8(output.stdout).unwrap(), String::from_utf8(output.stderr).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collector_status_prints_the_table_when_the_daemon_is_up() {
    let world = World::start(plan_for(2, 3, 1));
    sleep(Duration::from_millis(1500)).await;
    let socket = world.socket.to_str().unwrap().to_owned();
    let (code, stdout, stderr) = tokio::task::spawn_blocking(move || collector_status(&["--socket", &socket])).await.unwrap();
    assert_eq!(code, Some(0), "{stderr}");
    assert!(stdout.contains("수집 상태 20261118") && stdout.contains("장중 수집"), "{stdout}");
    assert!(stdout.contains("collect-01") && stdout.contains("spare-01") && stdout.contains("계획 6"), "{stdout}");
    assert!(stdout.contains("경보") && stdout.contains("제외"), "{stdout}");
    for marker in SECRET_MARKERS {
        assert!(!stdout.contains(marker), "{marker}: {stdout}");
    }
    world.finish().await;
}

#[test]
fn collector_status_says_the_daemon_is_off_and_fails_when_nothing_listens() {
    let folder = short_folder();
    let missing = folder.path().join("none.sock");
    let (code, stdout, _) = collector_status(&["--socket", missing.to_str().unwrap()]);
    assert_eq!(code, Some(1));
    assert!(stdout.contains("데몬 꺼짐"), "{stdout}");

    let leftover = folder.path().join("left.sock");
    drop(std::os::unix::net::UnixListener::bind(&leftover).unwrap());
    let (code, stdout, _) = collector_status(&["--socket", leftover.to_str().unwrap()]);
    assert_eq!(code, Some(1));
    assert!(stdout.contains("데몬 꺼짐"), "{stdout}");

    let (code, stdout, _) = collector_status(&["--state", folder.path().to_str().unwrap()]);
    assert_eq!(code, Some(1), "기본 소켓은 상태 폴더 아래 supervise.sock이다");
    assert!(stdout.contains("supervise.sock"), "{stdout}");
}

#[tokio::test(start_paused = true)]
async fn a_request_split_across_writes_survives_a_heartbeat_tick_and_an_oversized_line_is_refused_even_in_one_write() {
    let world = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    let mut client = world.connect().await;
    client.send(&fixture_line("request-watch.json")).await;
    assert_eq!(client.read().await["type"], "status");
    client.send(r#"{"v":1,"ty"#).await;
    sleep(Duration::from_secs(6)).await;
    client.send("pe\":\"disk\"}\n").await;
    let mut types = Vec::new();
    for _ in 0..3 {
        types.push(client.read().await["type"].as_str().unwrap().to_owned());
    }
    assert_eq!(types.iter().filter(|kind| *kind == "disk").count(), 1, "{types:?}");
    assert!(!types.contains(&"error".to_owned()), "{types:?}");

    let mut oversized = world.connect().await;
    oversized.send(&format!("{{\"v\":1,\"type\":\"status\",\"pad\":\"{}\"}}\n", " ".repeat(6000))).await;
    assert_eq!(error_code(&oversized.read().await), "bad_request");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_coverage_read_that_never_returns_does_not_stop_the_heartbeats_of_a_watching_connection() {
    let world = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    let fifo = world.data().join("store/20261117/complete.json");
    std::fs::create_dir_all(fifo.parent().unwrap()).unwrap();
    assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
    let mut client = world.connect().await;
    client.send(&fixture_line("request-watch.json")).await;
    assert_eq!(client.read().await["type"], "status");
    client.send(&fixture_line("request-coverage.json")).await;
    let coverage = client.read().await;
    assert_eq!(coverage["type"], "coverage");
    assert_eq!(coverage["days"][0]["state"], "unreadable");
    let mut heartbeats = 0;
    while heartbeats < 3 {
        if client.read().await["type"] == "heartbeat" {
            heartbeats += 1;
        }
    }
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_file_reply_is_still_delivered_after_the_client_half_closes() {
    let world = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    for request in ["request-coverage.json", "request-disk.json"] {
        let mut client = world.connect().await;
        client.send(&fixture_line(request)).await;
        client.writer.shutdown().await.unwrap();
        let reply = client.read().await;
        assert_eq!(reply["type"], request.trim_start_matches("request-").trim_end_matches(".json"));
    }
    world.finish().await;
}

fn finalize_a_day(data: &Path, date: u32, with_plan: bool) {
    let base_ms = collector::calendar::Day::from_yyyymmdd(date).unwrap().unix_ms_at_kst(9, 0);
    let name = KeyName::parse("collect-01").unwrap();
    if with_plan {
        let mut plan = plan_for(1, 3, 1);
        plan.date = date;
        plan.unregistered = vec!["300002".to_owned()];
        collector::plan::write_plan(data, &plan).unwrap();
    }
    let mut writer = collector::raw_write::RawWriter::for_key(data, name);
    for (offset, code) in [(1000, "000001"), (2000, "000001"), (3000, "000002")] {
        let text = json!({"trnm": "REAL", "data": [{"type": "0B", "item": format!("{code}_AL"), "values": {"10": "100"}}]}).to_string();
        writer.write(&collector::raw_write::RawLine::Frame { recv_ms: base_ms + offset, text: &text }).unwrap();
    }
    writer.close().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_collector")).args(["finalize", "--data", data.to_str().unwrap(), "--date", &date.to_string()]).output().unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
}

#[tokio::test(start_paused = true)]
async fn the_coverage_summarizes_the_complete_json_that_finalize_really_writes() {
    let world = World::start(plan_for(2, 3, 0));
    finalize_a_day(&world.data(), 20261117, true);
    finalize_a_day(&world.data(), 20261116, false);
    let mut client = world.connect().await;
    let reply = client.ask(fixture_line("request-coverage.json").trim()).await;
    let days = reply["days"].as_array().unwrap();
    let day = |date: u64| days.iter().find(|day| day["date"] == date).unwrap().clone();
    assert_eq!(day(20261117), json!({"date": 20261117, "state": "complete", "verified": true, "planned_stocks": 5, "received_stocks": 2}));
    assert_eq!(day(20261116), json!({"date": 20261116, "state": "complete", "verified": true, "planned_stocks": null, "received_stocks": 2}));
    world.finish().await;
}

fn coverage_day(reply: &Value, date: u64) -> Value {
    reply["days"].as_array().unwrap().iter().find(|day| day["date"] == date).unwrap_or_else(|| panic!("{date}가 없다: {reply}")).clone()
}

fn only_state(date: u64, state: &str) -> Value {
    json!({"date": date, "state": state, "verified": null, "planned_stocks": null, "received_stocks": null})
}

#[tokio::test(start_paused = true)]
async fn a_day_whose_verification_failed_is_told_apart_from_a_day_in_progress() {
    let world = World::start(plan_for(2, 3, 0));
    let store = world.data().join("store");
    std::fs::create_dir_all(store.join("20261118.tmp/0B")).unwrap();
    std::fs::create_dir_all(store.join("20261117.tmp")).unwrap();
    std::fs::write(store.join("20261117.tmp/verify.json"), r#"{"format_version":1,"date":20261117,"passed":false,"mismatch_count":3,"mismatches":[]}"#).unwrap();
    std::fs::create_dir_all(store.join("20261116.tmp")).unwrap();
    std::fs::write(store.join("20261116.tmp/verify.json"), r#"{"format_version":1,"date":20261116,"passed":true,"mismatch_count":0,"mismatches":[]}"#).unwrap();
    std::fs::create_dir_all(store.join("20261115.tmp")).unwrap();
    std::fs::write(store.join("20261115.tmp/verify.json"), r#"{"format_version":1,"da"#).unwrap();
    let mut client = world.connect().await;
    let reply = client.ask(fixture_line("request-coverage.json").trim()).await;
    assert_eq!(coverage_day(&reply, 20261117), only_state(20261117, "verify_failed"));
    assert_eq!(coverage_day(&reply, 20261118), only_state(20261118, "in_progress"));
    assert_eq!(coverage_day(&reply, 20261116), only_state(20261116, "in_progress"));
    assert_eq!(coverage_day(&reply, 20261115), only_state(20261115, "in_progress"));
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_day_being_swapped_by_a_refinalize_is_not_cached_as_incomplete() {
    let world = World::start(plan_for(2, 3, 0));
    let store = world.data().join("store");
    std::fs::create_dir_all(store.join("20261117/0B")).unwrap();
    std::fs::create_dir_all(store.join("20261117.old-1/0B")).unwrap();
    std::fs::create_dir_all(store.join("20261116/0B")).unwrap();
    let mut client = world.connect().await;

    let during = client.ask(fixture_line("request-coverage.json").trim()).await;
    assert_eq!(coverage_day(&during, 20261117), only_state(20261117, "in_progress"), "갈아 끼우는 중에는 완료 표시가 없어도 미완이 아니다");
    assert_eq!(coverage_day(&during, 20261116), only_state(20261116, "incomplete"), "그냥 완료 표시가 없는 날은 미완이다");

    std::fs::remove_dir_all(store.join("20261117.old-1")).unwrap();
    finalize_a_day(&world.data(), 20261117, true);
    let after = client.ask(fixture_line("request-coverage.json").trim()).await;
    assert_eq!(coverage_day(&after, 20261117)["state"], "complete", "갈아 끼우는 중의 답은 캐시에 남지 않는다: {after}");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_complete_json_of_another_format_version_or_without_one_is_unreadable() {
    let world = World::start(plan_for(2, 3, 0));
    finalize_a_day(&world.data(), 20261117, true);
    finalize_a_day(&world.data(), 20261116, false);
    finalize_a_day(&world.data(), 20261115, false);
    let rewrite = |date: u32, edit: &dyn Fn(String) -> String| {
        let path = world.data().join(format!("store/{date}/complete.json"));
        std::fs::write(&path, edit(std::fs::read_to_string(&path).unwrap())).unwrap();
    };
    rewrite(20261116, &|text| text.replace("\"format_version\": 1", "\"format_version\": 2"));
    rewrite(20261115, &|text| text.replace("\"format_version\": 1,", ""));
    let mut client = world.connect().await;
    let reply = client.ask(fixture_line("request-coverage.json").trim()).await;
    assert_eq!(coverage_day(&reply, 20261117)["state"], "complete");
    assert_eq!(coverage_day(&reply, 20261116), only_state(20261116, "unreadable"));
    assert_eq!(coverage_day(&reply, 20261115), only_state(20261115, "unreadable"));
    world.finish().await;
}

fn fake_daemon_answering(socket: &Path, answer: &'static str) -> std::thread::JoinHandle<()> {
    let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut request = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(&stream), &mut request).unwrap();
        std::io::Write::write_all(&mut &stream, answer.as_bytes()).unwrap();
    })
}

#[test]
fn collector_status_refuses_a_reply_of_another_format_version() {
    let folder = short_folder();
    let socket = folder.path().join("fake.sock");
    let daemon = fake_daemon_answering(&socket, "{\"v\":2,\"type\":\"snapshot\",\"anything\":1}\n");
    let (code, stdout, _) = collector_status(&["--socket", socket.to_str().unwrap()]);
    daemon.join().unwrap();
    assert_eq!(code, Some(1));
    assert!(stdout.contains("형식 버전 불일치") && stdout.contains("v2"), "{stdout}");
}

#[test]
fn collector_status_still_reads_a_reply_of_its_own_format_version() {
    let folder = short_folder();
    let socket = folder.path().join("fake.sock");
    let daemon = fake_daemon_answering(
        &socket,
        concat!(r#"{"v":1,"type":"status","sent_at":"2026-11-18T09:00:05+09:00","status":{"date":20261118,"phase":"collecting","today":{"planned_stocks":0,"receiving_stocks":0,"register_failed_batches":0,"#,
            r#""disconnected_stocks":0,"handed_off_stocks":0,"excluded_stocks":0},"keys":[],"universe_changes":null,"observation_day":null,"alerts":[]}}"#, "\n"),
    );
    let (code, stdout, stderr) = collector_status(&["--socket", socket.to_str().unwrap()]);
    daemon.join().unwrap();
    assert_eq!(code, Some(0), "{stderr}");
    assert!(stdout.contains("수집 상태 20261118"), "{stdout}");
}

#[tokio::test(start_paused = true)]
async fn the_alert_list_keeps_the_newest_200_even_when_the_plan_alone_brings_more() {
    let mut plan = plan_for(2, 3, 0);
    plan.alerts = (0..250).map(|number| format!("계획 알림 {number}")).collect();
    let world = World::try_start(plan, &["collect-02"], |_| {}).unwrap();
    let mut client = world.connect().await;
    let alerts = |reply: &Value| reply["status"]["alerts"].as_array().unwrap().iter().map(|alert| alert["message"].as_str().unwrap().to_owned()).collect::<Vec<_>>();

    let first = alerts(&client.ask(r#"{"v":1,"type":"status"}"#).await);
    assert_eq!((first.len(), first[0].as_str(), first[199].as_str()), (200, "계획 알림 50", "계획 알림 249"));

    sleep(Duration::from_secs(200)).await;
    let later = alerts(&client.ask(r#"{"v":1,"type":"status"}"#).await);
    assert_eq!(later.len(), 200, "{later:?}");
    assert!(later.iter().any(|message| message.contains("인계했습니다")), "새 경보는 남고 오래된 것이 밀려난다");
    assert!(!later.contains(&"계획 알림 50".to_owned()) && later.contains(&"계획 알림 249".to_owned()), "{later:?}");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_second_daemon_on_a_live_socket_fails_to_start_and_leaves_the_first_socket_alone() {
    let first = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    for required in [true, false] {
        let second = World::try_start_on(plan_for(2, 3, 0), &first.socket, required);
        let Err(StartError::StatusSocket { error, .. }) = second else { panic!("살아 있는 소켓을 두고 시작했다(required={required})") };
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse, "{error}");
    }
    let mut client = first.connect().await;
    assert_eq!(client.ask(r#"{"v":1,"type":"status"}"#).await["type"], "status", "첫 데몬의 소켓은 그대로 답한다");
    first.finish().await;
}

#[tokio::test(start_paused = true)]
async fn connections_that_stall_on_half_a_line_are_closed_and_give_their_slots_back() {
    let world = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    let mut stalled = Vec::new();
    for _ in 0..16 {
        let mut client = world.connect().await;
        client.send(r#"{"v":1,"ty"#).await;
        stalled.push(client);
    }
    sleep(Duration::from_secs(1)).await;
    let mut crowded = world.connect().await;
    assert_eq!(error_code(&crowded.read().await), "too_many_connections");

    sleep(Duration::from_secs(15)).await;
    for client in &mut stalled {
        let mut rest = Vec::new();
        timeout(Duration::from_secs(30), client.reader.read_to_end(&mut rest)).await.expect("반쪽 줄에서 멈춘 연결은 끊긴다").unwrap();
        assert!(String::from_utf8_lossy(&rest).contains("bad_request"), "{}", String::from_utf8_lossy(&rest));
    }
    let mut healthy = world.connect().await;
    assert_eq!(healthy.ask(r#"{"v":1,"type":"status"}"#).await["type"], "status");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_burst_of_requests_in_one_write_is_answered_in_order_and_keeps_the_connection() {
    let world = World::start(plan_for(2, 3, 0));
    sleep(Duration::from_secs(20)).await;
    let mut client = world.connect().await;
    let burst: String = (0..300).map(|number| if number % 100 == 99 { "{\"v\":1,\"type\":\"nonsense\"}\n" } else { "{\"v\":1,\"type\":\"status\"}\n" }).collect();
    client.send(&burst).await;
    for number in 0..300 {
        let reply = client.read().await;
        let expected = if number % 100 == 99 { "error" } else { "status" };
        assert_eq!(reply["type"], expected, "{number}번째 응답");
    }
    assert_eq!(client.ask(r#"{"v":1,"type":"status"}"#).await["type"], "status");
    world.finish().await;
}

struct StuckRead {
    fifo: PathBuf,
}

impl Drop for StuckRead {
    fn drop(&mut self) {
        use std::os::unix::fs::OpenOptionsExt;
        for _ in 0..8 {
            if std::fs::OpenOptions::new().write(true).custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32).open(&self.fifo).is_err() {
                return;
            }
        }
    }
}

impl StuckRead {
    fn at(world: &World, date: u32) -> StuckRead {
        let folder = world.data().join(format!("store/{date}.tmp"));
        std::fs::create_dir_all(&folder).unwrap();
        let fifo = folder.join("verify.json");
        assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        StuckRead { fifo }
    }

    fn release(&self, content: &str) {
        std::fs::write(&self.fifo, content).unwrap();
    }
}

#[tokio::test]
async fn a_status_request_is_answered_while_four_file_replies_are_still_being_read() {
    let world = World::start(plan_for(2, 3, 0));
    let stuck = StuckRead::at(&world, 20261117);
    let mut client = world.connect().await;
    for _ in 0..4 {
        client.send(&fixture_line("request-coverage.json")).await;
    }
    client.send("{\"v\":1,\"type\":\"status\"}\n").await;
    client.send(&fixture_line("request-coverage.json")).await;
    assert_eq!(client.read().await["type"], "status", "읽기 끝나지 않은 파일 응답 4개 뒤에 보낸 status가 먼저 온다");

    stuck.release(r#"{"passed":false}"#);
    for _ in 0..5 {
        let reply = client.read().await;
        assert_eq!(reply["type"], "coverage");
        assert_eq!(coverage_day(&reply, 20261117)["state"], "verify_failed");
    }
    world.finish().await;
}

#[tokio::test]
async fn a_slow_disk_read_keeps_the_reply_for_a_client_that_half_closed_and_its_result_is_kept_for_the_next_asker() {
    let world = World::start(plan_for(2, 3, 0));
    let stuck = StuckRead::at(&world, 20261117);
    let mut half_closed = world.connect().await;
    half_closed.send(&fixture_line("request-coverage.json")).await;
    half_closed.writer.shutdown().await.unwrap();
    let mut impatient = world.connect().await;
    impatient.send(&fixture_line("request-coverage.json")).await;
    drop(impatient);
    sleep(Duration::from_secs(8)).await;

    stuck.release(r#"{"passed":false}"#);
    let reply = half_closed.read().await;
    assert_eq!(coverage_day(&reply, 20261117)["state"], "verify_failed", "5초를 넘긴 읽기도 응답을 잃지 않는다");
    let mut next = world.connect().await;
    let again = next.ask(fixture_line("request-coverage.json").trim()).await;
    assert_eq!(coverage_day(&again, 20261117)["state"], "verify_failed", "떠난 요청이 시작한 읽기의 결과도 캐시에 남는다");
    world.finish().await;
}
