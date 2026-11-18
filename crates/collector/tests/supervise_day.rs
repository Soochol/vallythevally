use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::finalize::RetentionSettings;
use collector::calendar::{HolidayRequest, HolidayTransport, TransportError as HolidayError};
use collector::keys::{ActiveKey, KeyIdentity, KeyRole};
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile, read_plan, write_plan};
use collector::protocol::{Command, Event, KeyName, SessionState};
use collector::supervise::{
    ChildMessage, ChildProcess, Daemon, DaemonInjected, DaemonInputs, DaemonStartError, DaemonStatus, DayPhase, FinalizeRunner, Injected, Inputs, Launcher, ScheduleSettings,
    Settings, SocketSetting, Spawned, Supervisor, journal_path, schedule_from_arguments,
};
use domain::{KstDate, KstTime};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::kiwoom::token_file::credential_id;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep, timeout};

const DATE: u32 = 20261118;
const PREVIOUS_DATE: u32 = 20261117;
const OLD_DATE: u32 = 20261110;
const FIRST_COMPLETE_DATE: u32 = 20261102;
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/status");
const SERVICE_KEY: &str = "SvcKey-day-test";
const SECRET_MARKERS: [&str; 5] = ["FAKE-APPKEY", "FAKE-SECRET", "FAKE-TOKEN", "sha256:", SERVICE_KEY];

fn today() -> KstDate {
    KstDate::new(2026, 11, 18).unwrap()
}

fn at(hour: u32, minute: u32, second: u32) -> KstTime {
    kst(today(), hour, minute, second)
}

fn stamp(time: KstTime) -> String {
    collector::supervise::kst_stamp(time)
}

fn app_key_of(name: &str) -> String {
    format!("FAKE-APPKEY-{name}")
}

fn identity(name: &str, role: KeyRole) -> KeyIdentity {
    KeyIdentity { name: KeyName::parse(name).unwrap(), role, app_key_hash: credential_id(&app_key_of(name)) }
}

fn active_keys(folder: &Path) -> Vec<ActiveKey> {
    [("collect-01", KeyRole::Collecting), ("collect-02", KeyRole::Collecting), ("spare-01", KeyRole::Spare)]
        .into_iter()
        .map(|(name, role)| ActiveKey {
            identity: identity(name, role),
            app_key: server::config::Secret::new(app_key_of(name)),
            app_secret: server::config::Secret::new(format!("FAKE-SECRET-{name}")),
            token_path: folder.join("keys").join(name).join("token.json"),
            lock_path: folder.join("keys").join(name).join("collector.lock"),
        })
        .collect()
}

#[derive(Clone)]
struct Recorder {
    clock: Clock,
    notes: Arc<Mutex<Vec<(KstTime, String)>>>,
}

impl Recorder {
    fn new(clock: Clock) -> Recorder {
        Recorder { clock, notes: Arc::default() }
    }

    fn note(&self, label: impl Into<String>) {
        self.notes.lock().unwrap().push((self.clock.now(), label.into()));
    }

    fn times_of(&self, label: &str) -> Vec<KstTime> {
        self.notes.lock().unwrap().iter().filter(|(_, noted)| noted == label).map(|(time, _)| *time).collect()
    }

    fn count(&self, label: &str) -> usize {
        self.times_of(label).len()
    }

    fn labels_starting_with(&self, prefix: &str) -> Vec<(KstTime, String)> {
        self.notes.lock().unwrap().iter().filter(|(_, noted)| noted.starts_with(prefix)).cloned().collect()
    }
}

fn plain_row(code: &str, name: &str) -> Value {
    json!({"code": code, "name": name, "marketCode": "0", "companyClassName": "", "nxtEnable": "N", "regDay": "20000101", "auditInfo": "정상", "listCount": "100"})
}

fn listing_rows(codes: &[&str]) -> Vec<Value> {
    codes.iter().map(|code| plain_row(code, &format!("가상{code}"))).collect()
}

const MORNING_CODES: [&str; 6] = ["000010", "000020", "000030", "000040", "000050", "000060"];
const AFTER_CLOSE_CODES: [&str; 6] = ["000010", "000020", "000030", "000040", "000050", "000070"];
const PREVIOUS_CODES: [&str; 6] = ["000010", "000020", "000030", "000040", "000050", "000090"];

#[derive(Clone)]
enum Candles {
    Days(Vec<u32>),
    Failing,
}

struct FakeKiwoom {
    recorder: Recorder,
    after_close_from: KstTime,
    candles: Candles,
    listing_fails: bool,
    issued: Mutex<Vec<(String, KstTime)>>,
    counter: AtomicUsize,
}

impl FakeKiwoom {
    fn issue_times(&self, key: &str) -> Vec<KstTime> {
        let app_key = app_key_of(key);
        self.issued.lock().unwrap().iter().filter(|(issued_for, _)| *issued_for == app_key).map(|(_, time)| *time).collect()
    }

    fn calls(&self) -> usize {
        ["au10001", "ka10099", "ka20006"].iter().map(|api| self.recorder.count(api)).sum()
    }
}

impl Transport for FakeKiwoom {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let api = request.api_id.as_str().to_owned();
        self.recorder.note(&api);
        let body: Value = serde_json::from_str(request.body.expose()).unwrap();
        let reply = match api.as_str() {
            "au10001" => {
                let app_key = body["appkey"].as_str().unwrap().to_owned();
                self.issued.lock().unwrap().push((app_key.clone(), self.recorder.clock.now()));
                let number = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
                ok(json!({"token": format!("FAKE-TOKEN-{number}-for-{app_key}"), "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}))
            }
            "ka10099" if self.listing_fails => Err(TransportError::refused()),
            "ka10099" => {
                let codes: &[&str] = if self.recorder.clock.now() >= self.after_close_from { &AFTER_CLOSE_CODES } else { &MORNING_CODES };
                let rows = if body["mrkt_tp"] == "0" { listing_rows(codes) } else { Vec::new() };
                ok(json!({"list": rows, "return_code": 0, "return_msg": "정상"}))
            }
            "ka20006" => match &self.candles {
                Candles::Failing => Err(TransportError::refused()),
                Candles::Days(days) => {
                    let rows: Vec<Value> = days.iter().rev().map(|day| json!({"dt": day.to_string()})).collect();
                    ok(json!({"inds_dt_pole_qry": rows, "return_code": 0, "return_msg": "정상"}))
                }
            },
            other => panic!("데몬이 부르지 않는 API: {other}"),
        };
        Box::pin(async move { reply })
    }
}

fn ok(body: Value) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status: 200, next_key: None, body: body.to_string() })
}

struct FakeChild {
    key: KeyName,
    commands: Mutex<Vec<Command>>,
    alive: AtomicBool,
    events: mpsc::UnboundedSender<ChildMessage>,
}

impl FakeChild {
    fn emit(&self, event: Event) {
        let _ = self.events.send(ChildMessage::Event(event));
    }

    fn exit(&self, code: i32) {
        if self.alive.swap(false, Ordering::SeqCst) {
            let _ = self.events.send(ChildMessage::Exited(Some(code)));
        }
    }
}

struct FakeHandle {
    child: Arc<FakeChild>,
    recorder: Recorder,
}

impl ChildProcess for FakeHandle {
    fn send(&mut self, command: &Command) {
        self.child.commands.lock().unwrap().push(command.clone());
        if *command == Command::Shutdown {
            self.recorder.note(format!("shutdown:{}", self.child.key));
            self.child.exit(0);
        }
    }

    fn terminate(&mut self) {
        self.child.exit(0);
    }

    fn kill(&mut self) {
        self.child.exit(137);
    }
}

struct FakeLauncher {
    recorder: Recorder,
    open_at: Option<KstTime>,
    spawned: Mutex<Vec<Arc<FakeChild>>>,
}

impl FakeLauncher {
    fn launched(&self) -> usize {
        self.spawned.lock().unwrap().len()
    }

    fn child(&self, key: &str) -> Arc<FakeChild> {
        self.spawned.lock().unwrap().iter().find(|child| child.key.as_str() == key).cloned().unwrap_or_else(|| panic!("{key} 자식이 없다"))
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, key: &KeyName) -> io::Result<Spawned> {
        self.recorder.note(format!("launch:{key}"));
        let (events, messages) = mpsc::unbounded_channel();
        let child = Arc::new(FakeChild { key: key.clone(), commands: Mutex::default(), alive: AtomicBool::new(true), events });
        let pid = 1000 + self.spawned.lock().unwrap().len() as u32;
        self.spawned.lock().unwrap().push(child.clone());
        child.emit(Event::Hello { key: key.clone(), pid });
        let beating = child.clone();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(5)).await;
                if !beating.alive.load(Ordering::SeqCst) {
                    return;
                }
                beating.emit(Event::Heartbeat { frames: 50, bytes: 5000, state: SessionState::Live });
            }
        });
        if let Some(open_at) = self.open_at {
            let opening = child.clone();
            let clock = self.recorder.clock.clone();
            tokio::spawn(async move {
                clock.sleep_until(open_at).await;
                if opening.alive.load(Ordering::SeqCst) {
                    opening.emit(Event::MarketOpen { recv_ms: 0, values: serde_json::from_value(json!({"215": "3", "20": "090000"})).unwrap() });
                }
            });
        }
        Ok(Spawned { pid: Some(pid), process: Box::new(FakeHandle { child, recorder: self.recorder.clone() }), messages })
    }
}

enum Holidays {
    Listed(Vec<(u32, &'static str)>),
    Down,
}

struct FakeHolidays {
    kind: Holidays,
    calls: Mutex<Vec<String>>,
}

impl HolidayTransport for FakeHolidays {
    fn fetch<'a>(&'a self, request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, HolidayError>> {
        self.calls.lock().unwrap().push(request.service_key.expose().clone());
        let reply = match &self.kind {
            Holidays::Down => Err(HolidayError::Unreachable),
            Holidays::Listed(holidays) => {
                let items: Vec<String> = holidays
                    .iter()
                    .filter(|(date, _)| *date / 10_000 == u32::from(request.year))
                    .map(|(date, name)| format!(r#"{{"dateKind":"01","dateName":"{name}","isHoliday":"Y","locdate":{date},"seq":1}}"#))
                    .collect();
                Ok(format!(
                    r#"{{"response":{{"header":{{"resultCode":"00","resultMsg":"NORMAL SERVICE."}},"body":{{"items":{{"item":[{}]}},"numOfRows":100,"pageNo":1,"totalCount":{}}}}}}}"#,
                    items.join(","),
                    items.len()
                ))
            }
        };
        Box::pin(async move { reply })
    }
}

struct RealFinalize {
    recorder: Recorder,
    hold: Duration,
    forced_exit: Option<i32>,
    runs: Mutex<Vec<Vec<String>>>,
    finished: AtomicUsize,
}

impl FinalizeRunner for RealFinalize {
    fn run(&self, arguments: Vec<String>) -> BoxFuture<'_, io::Result<i32>> {
        Box::pin(async move {
            self.recorder.note("finalize");
            self.runs.lock().unwrap().push(arguments.clone());
            sleep(self.hold).await;
            let code = match self.forced_exit {
                Some(code) => code,
                None => {
                    let code = tokio::task::spawn_blocking(move || collector::finalize::run(&arguments)).await.unwrap();
                    if format!("{code:?}") == format!("{:?}", ExitCode::SUCCESS) { 0 } else { 1 }
                }
            };
            self.finished.fetch_add(1, Ordering::SeqCst);
            Ok(code)
        })
    }
}

struct Config {
    start: KstTime,
    holidays: Holidays,
    candles: Candles,
    open_at: Option<KstTime>,
    hold_finalize: Duration,
    forced_exit: Option<i32>,
    listing_fails: bool,
    socket: bool,
    seed_history: bool,
    seed_today_raw: bool,
    schedule: ScheduleSettings,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            start: at(7, 0, 0),
            holidays: Holidays::Listed(vec![(20261225, "기독탄신일")]),
            candles: Candles::Days(vec![20261112, 20261113, 20261116, 20261117, 20261118]),
            open_at: Some(at(9, 0, 0)),
            hold_finalize: Duration::ZERO,
            forced_exit: None,
            listing_fails: false,
            socket: false,
            seed_history: true,
            seed_today_raw: true,
            schedule: ScheduleSettings::default(),
        }
    }
}

struct Harness {
    folder: tempfile::TempDir,
    sockets: tempfile::TempDir,
    clock: Clock,
    recorder: Recorder,
    kiwoom: Arc<FakeKiwoom>,
    launcher: Arc<FakeLauncher>,
    holidays: Arc<FakeHolidays>,
    finalizer: Arc<RealFinalize>,
    status: watch::Receiver<DaemonStatus>,
    stop: watch::Sender<bool>,
    done: tokio::task::JoinHandle<()>,
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn universe_json(date: u32, codes: &[&str]) -> String {
    let stocks: Vec<Value> =
        codes.iter().map(|code| json!({"code": code, "name": format!("가상{code}"), "market": "kospi", "kind": "common", "status": [], "registered": true})).collect();
    json!({"format_version": 1, "date": date, "fetched_at": format!("{} 07:20", date), "stocks": stocks, "warnings": [], "diff": {"added": [], "removed": [], "renamed": [], "halt_started": [], "halt_lifted": []}, "replaced": null}).to_string()
}

fn complete_json(date: u32, stocks: Value) -> String {
    json!({"format_version": 1, "date": date, "verify": {"passed": true}, "stocks": stocks}).to_string()
}

fn raw_frames(date: u32) -> Vec<u8> {
    let at_nine = domain::KstDate::parse_yyyymmdd(&date.to_string()).unwrap();
    let recv_ms = kst(at_nine, 9, 0, 0).unix() * 1000;
    let line = format!(r#"{{"recv_ms":{recv_ms},"msg":{}}}"#, json!({"trnm": "REAL", "data": [{"type": "0B", "item": "000010_AL", "values": {"10": "100"}}]}));
    zstd::encode_all(format!("{line}\n").as_bytes(), 3).unwrap()
}

fn write_raw_day(data: &Path, date: u32) {
    let folder = data.join("raw").join(date.to_string());
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("day.jsonl.zst"), raw_frames(date)).unwrap();
}

fn seed_history(data: &Path) {
    write(&data.join("universe").join(format!("{PREVIOUS_DATE}.json")), &universe_json(PREVIOUS_DATE, &PREVIOUS_CODES));
    write(
        &data.join("store").join(PREVIOUS_DATE.to_string()).join("complete.json"),
        &complete_json(PREVIOUS_DATE, json!([{"code": "000010", "messages": 900}, {"code": "000020", "messages": 100}])),
    );
    write(&data.join("store").join(FIRST_COMPLETE_DATE.to_string()).join("complete.json"), &complete_json(FIRST_COMPLETE_DATE, json!([])));
    write_raw_day(data, OLD_DATE);
    let old_raw_bytes = std::fs::metadata(data.join("raw").join(OLD_DATE.to_string()).join("day.jsonl.zst")).unwrap().len();
    write(
        &data.join("store").join(OLD_DATE.to_string()).join("complete.json"),
        &json!({"format_version": 1, "date": OLD_DATE, "verify": {"passed": true}, "raw_files": {"day.jsonl.zst": old_raw_bytes}, "stocks": []}).to_string(),
    );
    write(&data.join("store").join(OLD_DATE.to_string()).join("verify.json"), &json!({"passed": true, "lines": {"unfinalized": {"total": 0, "kinds": {}}}}).to_string());
}

impl Harness {
    fn start(config: Config) -> Harness {
        Harness::start_with(config, |_| {})
    }

    fn start_with(config: Config, prepare: impl FnOnce(&Path)) -> Harness {
        let folder = tempfile::tempdir().unwrap();
        let sockets = tempfile::Builder::new().prefix("vd").tempdir_in("/tmp").unwrap();
        let data = folder.path().join("data");
        if config.seed_history {
            seed_history(&data);
        }
        if config.seed_today_raw {
            write_raw_day(&data, DATE);
        }
        prepare(&data);
        write(&folder.path().join("holiday-key"), SERVICE_KEY);
        let clock = Clock::fake(config.start);
        let recorder = Recorder::new(clock.clone());
        let kiwoom = Arc::new(FakeKiwoom {
            recorder: recorder.clone(),
            after_close_from: at(20, 0, 0),
            candles: config.candles,
            listing_fails: config.listing_fails,
            issued: Mutex::default(),
            counter: AtomicUsize::new(0),
        });
        let launcher = Arc::new(FakeLauncher { recorder: recorder.clone(), open_at: config.open_at, spawned: Mutex::default() });
        let holidays = Arc::new(FakeHolidays { kind: config.holidays, calls: Mutex::default() });
        let finalizer = Arc::new(RealFinalize { recorder: recorder.clone(), hold: config.hold_finalize, forced_exit: config.forced_exit, runs: Mutex::default(), finished: AtomicUsize::new(0) });
        let socket_path = sockets.path().join("run").join("supervise.sock");
        let daemon = Daemon::start(
            DaemonInputs {
                keys: active_keys(folder.path()),
                data_dir: data.clone(),
                supervisor: Settings { status_socket: config.socket.then_some(SocketSetting { path: socket_path, required: true }), ..Settings::default() },
                schedule: config.schedule,
                holiday_key_path: folder.path().join("holiday-key"),
            },
            DaemonInjected { launcher: launcher.clone(), transport: kiwoom.clone(), holidays: holidays.clone(), finalizer: finalizer.clone(), clock: clock.clone() },
        )
        .unwrap_or_else(|error| panic!("시작하지 못했다: {error}"));
        let status = daemon.status();
        let (stop, shutdown) = watch::channel(false);
        let done = tokio::spawn(daemon.run(shutdown));
        Harness { folder, sockets, clock, recorder, kiwoom, launcher, holidays, finalizer, status, stop, done }
    }

    fn data(&self) -> PathBuf {
        self.folder.path().join("data")
    }

    fn socket(&self) -> PathBuf {
        self.sockets.path().join("run").join("supervise.sock")
    }

    async fn until(&self, time: KstTime) {
        self.clock.sleep_until(time).await;
        for _ in 0..3 {
            sleep(Duration::from_millis(1)).await;
        }
    }

    async fn until_finalize_finished(&self, runs: usize) {
        for _ in 0..200_000 {
            if self.finalizer.finished.load(Ordering::SeqCst) >= runs {
                sleep(Duration::from_secs(1)).await;
                return;
            }
            sleep(Duration::from_secs(1)).await;
        }
        panic!("finalize가 끝나지 않았다");
    }

    fn journal(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(journal_path(&self.data(), DATE)).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn journal_of(&self, event: &str) -> Vec<Value> {
        self.journal().into_iter().filter(|record| record["event"] == event).collect()
    }

    fn status_now(&self) -> DaemonStatus {
        self.status.borrow().clone()
    }

    fn alert_kinds(&self) -> Vec<String> {
        self.status_now().alerts.iter().map(|alert| serde_json::to_value(alert.kind).unwrap().as_str().unwrap().to_owned()).collect()
    }

    fn complete(&self) -> Value {
        let path = self.data().join("store").join(DATE.to_string()).join("complete.json");
        serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap()
    }

    fn complete_exists(&self) -> bool {
        self.data().join("store").join(DATE.to_string()).join("complete.json").is_file()
    }

    async fn finish(self) {
        self.stop.send(true).unwrap();
        timeout(Duration::from_secs(120), self.done).await.expect("데몬이 끝나지 않았다").unwrap();
    }
}

type SeededPlan = (Vec<u8>, std::time::SystemTime);

fn between(times: &[KstTime], from: KstTime, until: KstTime) -> bool {
    !times.is_empty() && times.iter().all(|time| *time >= from && *time < until)
}

fn minute_after(time: KstTime) -> KstTime {
    time.plus_secs(60)
}

#[tokio::test(start_paused = true)]
async fn a_weekday_runs_every_stage_in_order_and_ends_with_the_complete_file() {
    let harness = Harness::start(Config::default());
    harness.until(at(7, 19, 0)).await;
    assert_eq!(harness.status_now().phase, DayPhase::OffHours);
    assert_eq!(harness.kiwoom.calls(), 0);
    assert!(!harness.data().join("plan").join(format!("{DATE}.json")).exists());

    harness.until(at(7, 34, 0)).await;
    let list_calls = harness.recorder.times_of("ka10099");
    assert!(between(&list_calls, at(7, 20, 0), minute_after(at(7, 20, 0))), "{list_calls:?}");
    assert!(harness.data().join("universe").join(format!("{DATE}.json")).is_file());
    assert!(!harness.data().join("plan").join(format!("{DATE}.json")).exists());
    assert_eq!(harness.launcher.launched(), 0);

    harness.until(at(7, 36, 0)).await;
    let plan = read_plan(&harness.data(), DATE).unwrap();
    assert!(plan.created_at.starts_with("2026-11-18T07:35:"), "{}", plan.created_at);
    let mut loads: Vec<u64> = plan.keys.iter().filter(|key| key.role == KeyRole::Collecting).map(|key| key.load).collect();
    loads.sort_unstable();
    assert_eq!(loads, [100, 900], "전날 complete.json의 메시지 수가 부하로 들어간다");
    assert_eq!(harness.launcher.launched(), 0);

    harness.until(at(7, 56, 0)).await;
    let launches: Vec<KstTime> = harness.recorder.labels_starting_with("launch:").into_iter().map(|(time, _)| time).collect();
    assert_eq!(launches.len(), 3);
    assert!(between(&launches, at(7, 55, 0), minute_after(at(7, 55, 0))), "{launches:?}");
    assert!(!harness.launcher.child("collect-01").commands.lock().unwrap().is_empty());
    let registered: usize = ["collect-01", "collect-02"]
        .iter()
        .map(|key| harness.launcher.child(key).commands.lock().unwrap().iter().filter(|command| matches!(command, Command::Register(_))).count())
        .sum();
    assert!(registered > 0, "자식에게 등록 명령이 간다");
    assert_eq!(harness.status_now().phase, DayPhase::Collecting);
    assert_eq!(harness.kiwoom.issue_times("spare-01").len(), 1, "아침 목록 때 받은 토큰을 Supervisor가 다시 쓴다");

    harness.until(at(9, 5, 0)).await;
    let seen = harness.journal_of("market_open_seen");
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["deadline"], stamp(at(9, 10, 0)));
    assert!(harness.journal_of("market_open_missing").is_empty());

    harness.until(at(20, 4, 0)).await;
    assert_eq!(harness.recorder.count("shutdown:collect-01"), 0);
    harness.until(at(20, 5, 30)).await;
    for key in ["collect-01", "collect-02", "spare-01"] {
        let times = harness.recorder.times_of(&format!("shutdown:{key}"));
        assert!(between(&times, at(20, 5, 0), at(20, 5, 30)), "{key}: {times:?}");
    }
    assert!(harness.data().join("universe").join(format!("{DATE}.after.json")).is_file());
    let after_close_lists = harness.recorder.times_of("ka10099");
    assert_eq!(after_close_lists.len(), 4, "아침 두 번(코스피·코스닥)과 마감 뒤 두 번");
    assert!(after_close_lists[2] >= at(20, 5, 0));

    harness.until_finalize_finished(1).await;
    let index_calls = harness.recorder.times_of("ka20006");
    assert_eq!(index_calls.len(), 1);
    assert!(index_calls[0] >= after_close_lists[3], "지수 일봉 대조는 마감 뒤 목록 다음이다");
    let reissue: Vec<(KstTime, KstTime)> = ["collect-01", "collect-02", "spare-01"]
        .iter()
        .map(|key| {
            let times = harness.kiwoom.issue_times(key);
            assert_eq!(times.len(), 2, "{key}는 아침에 한 번, 마감 뒤 한 번 받는다: {times:?}");
            (times[0], times[1])
        })
        .collect();
    assert!(reissue[0].1 >= index_calls[0]);
    for pair in reissue.windows(2) {
        let gap = pair[1].1.unix() - pair[0].1.unix();
        assert!((30..=31).contains(&gap), "재발급 간격 {gap}초");
    }
    let finalize_times = harness.recorder.times_of("finalize");
    assert_eq!(finalize_times.len(), 1);
    assert!(finalize_times[0] >= reissue[2].1, "정리는 재발급 뒤다");

    let arguments = harness.finalizer.runs.lock().unwrap()[0].clone();
    assert!(arguments.windows(2).any(|pair| pair == ["--date", "20261118"]) && arguments.contains(&"--prune".to_owned()), "{arguments:?}");
    assert!(arguments.windows(2).any(|pair| pair == ["--threads", "2"]));

    let complete = harness.complete();
    assert_eq!(complete["observation"]["judgment"]["verdict"], "observed");
    assert_eq!(complete["observation"]["judgment"]["treated_as"], "observed");
    assert_eq!(complete["observation"]["market_open"]["state"], "seen");
    assert_eq!(complete["observation"]["index_check"]["result"], "agrees");
    assert!(!harness.data().join("raw").join(OLD_DATE.to_string()).exists(), "정리가 끝난 옛 원문은 지운다");
    assert!(harness.data().join("raw").join(DATE.to_string()).exists(), "그날 원문은 보존 기간 안이라 남는다");
    assert_eq!(harness.status_now().phase, DayPhase::OffHours);

    let events: Vec<String> = harness.journal().iter().map(|record| record["event"].as_str().unwrap().to_owned()).collect();
    let position = |name: &str| events.iter().position(|event| event == name).unwrap_or_else(|| panic!("{name}이 사건 기록에 없다: {events:?}"));
    assert!(position("observation_judged") < position("child_started"));
    assert!(position("child_started") < position("market_open_seen"));
    assert!(position("market_open_seen") < position("index_checked"));
    assert!(position("index_checked") < events.iter().rposition(|event| event == "token_issued").unwrap());
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_holiday_runs_no_stage_and_the_status_shows_why() {
    let harness = Harness::start(Config { holidays: Holidays::Listed(vec![(20261118, "임시공휴일")]), ..Config::default() });
    harness.until(at(7, 25, 0)).await;
    harness.until(at(20, 30, 0)).await;
    assert_eq!(harness.launcher.launched(), 0);
    assert_eq!(harness.kiwoom.calls(), 0);
    assert_eq!(harness.finalizer.runs.lock().unwrap().len(), 0);
    assert!(!harness.data().join("plan").join(format!("{DATE}.json")).exists());
    assert!(!harness.data().join("universe").join(format!("{DATE}.json")).exists());
    let status = harness.status_now();
    assert_eq!(status.phase, DayPhase::OffHours);
    let observation = status.observation_day.expect("근거가 보인다");
    assert_eq!(serde_json::to_value(observation.verdict).unwrap(), "not_observed");
    assert!(observation.reasons.iter().any(|reason| reason.contains("임시공휴일")), "{:?}", observation.reasons);
    let judged = harness.journal_of("observation_judged");
    assert_eq!(judged.len(), 1);
    assert_eq!((judged[0]["verdict"].as_str(), judged[0]["treated_as"].as_str()), (Some("closed"), Some("closed")));
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn an_unknown_judgment_runs_as_an_observation_day_with_an_alert_and_the_reason() {
    let harness = Harness::start(Config { holidays: Holidays::Down, ..Config::default() });
    harness.until(at(7, 56, 0)).await;
    assert_eq!(harness.launcher.launched(), 3, "모르면 관측일로 보고 돈다");
    let status = harness.status_now();
    assert!(harness.alert_kinds().contains(&"observation_unknown".to_owned()), "{:?}", status.alerts);
    let observation = status.observation_day.unwrap();
    assert_eq!(serde_json::to_value(observation.verdict).unwrap(), "unknown");
    assert_eq!(observation.reasons.last().map(String::as_str), Some("관측일로 보고 돌린다"));
    let alert = status.alerts.iter().find(|alert| serde_json::to_value(alert.kind).unwrap() == "observation_unknown").unwrap();
    assert!(alert.message.contains("특일정보"), "{}", alert.message);
    let judged = harness.journal_of("observation_judged");
    assert_eq!((judged[0]["verdict"].as_str(), judged[0]["treated_as"].as_str()), (Some("unknown"), Some("observed")));
    assert_eq!(judged[0]["open_minute"], Value::Null);
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_missing_market_open_alerts_at_the_deadline_and_reaches_the_complete_file() {
    let harness = Harness::start(Config { open_at: None, ..Config::default() });
    harness.until(at(9, 9, 0)).await;
    assert!(!harness.alert_kinds().contains(&"market_open_missing".to_owned()));
    harness.until(at(9, 11, 0)).await;
    assert!(harness.alert_kinds().contains(&"market_open_missing".to_owned()));
    let missing = harness.journal_of("market_open_missing");
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0]["deadline"], stamp(at(9, 10, 0)));
    let alert = harness.status_now().alerts.into_iter().find(|alert| serde_json::to_value(alert.kind).unwrap() == "market_open_missing").unwrap();
    assert!(alert.at.starts_with("2026-11-18T09:10:"), "{}", alert.at);
    harness.until_finalize_finished(1).await;
    let complete = harness.complete();
    assert_eq!(complete["observation"]["market_open"]["state"], "missing");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_closing_zero_s_deadline_follows_a_changed_open_time() {
    let harness = Harness::start_with(Config { open_at: None, ..Config::default() }, |data| {
        write(
            &data.join("calendar").join("overrides.json"),
            r#"{"version":1,"days":[{"kind":"open_at","date":20261118,"time":"10:00","reason":"수능일"}]}"#,
        );
    });
    harness.until(at(9, 30, 0)).await;
    assert!(!harness.alert_kinds().contains(&"market_open_missing".to_owned()), "개장이 10:00이라 09:10에는 경보가 없다");
    harness.until(at(10, 11, 0)).await;
    let missing = harness.journal_of("market_open_missing");
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0]["deadline"], stamp(at(10, 10, 0)));
    assert_eq!(harness.journal_of("observation_judged")[0]["open_minute"], 600);
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_zero_s_that_arrives_at_the_changed_open_time_is_seen_before_the_changed_deadline() {
    let harness = Harness::start_with(Config { open_at: Some(at(10, 0, 0)), ..Config::default() }, |data| {
        write(
            &data.join("calendar").join("overrides.json"),
            r#"{"version":1,"days":[{"kind":"open_at","date":20261118,"time":"10:00","reason":"수능일"}]}"#,
        );
    });
    harness.until(at(10, 12, 0)).await;
    let seen = harness.journal_of("market_open_seen");
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["deadline"], stamp(at(10, 10, 0)));
    assert!(harness.journal_of("market_open_missing").is_empty());
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn an_index_without_todays_candle_alerts_a_mismatch_and_reaches_the_complete_file() {
    let harness = Harness::start(Config { candles: Candles::Days(vec![20261112, 20261113, 20261116, 20261117]), ..Config::default() });
    harness.until_finalize_finished(1).await;
    assert!(harness.alert_kinds().contains(&"index_mismatch".to_owned()), "{:?}", harness.status_now().alerts);
    let checked = harness.journal_of("index_checked");
    assert_eq!(checked.len(), 1);
    assert_eq!(checked[0]["result"], "disagrees");
    assert_eq!(checked[0]["mismatch"], "observed_without_index_candle");
    let complete = harness.complete();
    assert_eq!(complete["observation"]["index_check"]["result"], "disagrees");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_index_request_is_recorded_as_failed_and_the_day_goes_on() {
    let harness = Harness::start(Config { candles: Candles::Failing, ..Config::default() });
    harness.until_finalize_finished(1).await;
    let checked = harness.journal_of("index_checked");
    assert_eq!(checked[0]["result"], "failed");
    assert!(harness.alert_kinds().contains(&"stage_failed".to_owned()));
    assert!(harness.complete_exists(), "대조가 실패해도 정리는 이어 간다");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_daemon_started_at_eleven_keeps_the_existing_plan_and_launches_at_once() {
    let folder_plan: Arc<Mutex<Option<SeededPlan>>> = Arc::default();
    let seeded = folder_plan.clone();
    let harness = Harness::start_with(Config { start: at(11, 0, 0), ..Config::default() }, move |data| {
        write_plan(data, &day_plan()).unwrap();
        let path = data.join("plan").join(format!("{DATE}.json"));
        *seeded.lock().unwrap() = Some((std::fs::read(&path).unwrap(), std::fs::metadata(&path).unwrap().modified().unwrap()));
    });
    harness.until(at(11, 1, 0)).await;
    let launches: Vec<KstTime> = harness.recorder.labels_starting_with("launch:").into_iter().map(|(time, _)| time).collect();
    assert_eq!(launches.len(), 3);
    assert!(between(&launches, at(11, 0, 0), at(11, 0, 30)), "{launches:?}");
    let path = harness.data().join("plan").join(format!("{DATE}.json"));
    let (bytes, modified) = folder_plan.lock().unwrap().clone().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes, "계획 파일을 다시 쓰지 않는다");
    assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert_eq!(harness.recorder.count("ka10099"), 0, "계획이 있으면 목록도 다시 받지 않는다");
    assert_eq!(harness.journal_of("market_open_not_checked").len(), 1, "개장 뒤에 떠서 0s를 대조하지 않는다");
    assert!(!harness.alert_kinds().contains(&"market_open_missing".to_owned()));
    harness.until(at(20, 30, 0)).await;
    assert!(harness.alert_kinds().iter().all(|kind| kind != "market_open_missing"));
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_daemon_started_after_the_close_without_a_complete_file_finalizes_first_and_collects_nothing() {
    let harness = Harness::start(Config { start: at(21, 0, 0), ..Config::default() });
    harness.until_finalize_finished(1).await;
    assert_eq!(harness.launcher.launched(), 0);
    assert_eq!(harness.recorder.count("au10001"), 0, "토큰 요청이 없다");
    assert_eq!(harness.recorder.count("ka10099") + harness.recorder.count("ka20006"), 0);
    assert!(!harness.data().join("plan").join(format!("{DATE}.json")).exists(), "계획을 만들지 않는다");
    assert_eq!(harness.finalizer.runs.lock().unwrap().len(), 1);
    assert!(harness.complete_exists());
    assert!(harness.journal_of("index_checked").is_empty());
    assert_eq!(harness.complete()["observation"]["index_check"]["result"], "not_recorded");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_daemon_started_after_the_close_with_a_complete_file_does_nothing() {
    let harness = Harness::start_with(Config { start: at(21, 0, 0), ..Config::default() }, |data| {
        write(&data.join("store").join(DATE.to_string()).join("complete.json"), &complete_json(DATE, json!([])));
    });
    let before = std::fs::read(harness.data().join("store").join(DATE.to_string()).join("complete.json")).unwrap();
    harness.until(at(23, 0, 0)).await;
    assert_eq!(harness.launcher.launched(), 0);
    assert_eq!(harness.kiwoom.calls(), 0);
    assert_eq!(harness.finalizer.runs.lock().unwrap().len(), 0);
    assert_eq!(harness.holidays.calls.lock().unwrap().len(), 0);
    assert_eq!(std::fs::read(harness.data().join("store").join(DATE.to_string()).join("complete.json")).unwrap(), before);
    assert_eq!(harness.status_now().phase, DayPhase::OffHours);
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_supervisor_started_after_its_end_time_launches_nothing_and_asks_for_no_token() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(at(21, 0, 0));
    let recorder = Recorder::new(clock.clone());
    let kiwoom = Arc::new(FakeKiwoom {
        recorder: recorder.clone(),
        after_close_from: at(20, 0, 0),
        candles: Candles::Failing,
        listing_fails: false,
        issued: Mutex::default(),
        counter: AtomicUsize::new(0),
    });
    let launcher = Arc::new(FakeLauncher { recorder: recorder.clone(), open_at: None, spawned: Mutex::default() });
    let supervisor = Supervisor::start(
        Inputs { plan: day_plan(), keys: active_keys(folder.path()), data_dir: folder.path().join("data"), settings: Settings::default() },
        Injected { launcher: launcher.clone(), transport: kiwoom.clone(), clock },
    )
    .unwrap_or_else(|error| panic!("시작하지 못했다: {error}"));
    let (_stop, shutdown) = watch::channel(false);
    timeout(Duration::from_secs(5), supervisor.run(shutdown)).await.expect("마감 뒤에 뜬 Supervisor는 곧장 끝난다");
    assert_eq!(launcher.launched(), 0);
    assert_eq!(kiwoom.calls(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_listing_failure_without_a_fallback_skips_the_day_with_an_alert() {
    let harness = Harness::start_with(Config { listing_fails: true, seed_history: false, ..Config::default() }, |_| {});
    harness.until(at(20, 30, 0)).await;
    assert_eq!(harness.launcher.launched(), 0);
    assert!(!harness.data().join("plan").join(format!("{DATE}.json")).exists());
    assert!(harness.alert_kinds().contains(&"stage_failed".to_owned()), "{:?}", harness.status_now().alerts);
    assert_eq!(harness.status_now().phase, DayPhase::OffHours);
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_finalize_is_alerted_and_not_retried_the_same_day() {
    let harness = Harness::start(Config { forced_exit: Some(1), ..Config::default() });
    harness.until_finalize_finished(1).await;
    harness.until(at(23, 0, 0)).await;
    assert_eq!(harness.finalizer.runs.lock().unwrap().len(), 1);
    assert!(harness.alert_kinds().contains(&"stage_failed".to_owned()));
    assert!(!harness.complete_exists());
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_next_day_finalizes_a_day_whose_finalize_failed() {
    let harness = Harness::start(Config { forced_exit: Some(1), holidays: Holidays::Listed(vec![(20261119, "임시공휴일")]), ..Config::default() });
    harness.until_finalize_finished(1).await;
    harness.until(kst(KstDate::new(2026, 11, 19).unwrap(), 0, 5, 0)).await;
    harness.until_finalize_finished(2).await;
    let runs = harness.finalizer.runs.lock().unwrap().clone();
    assert!(runs[1].windows(2).any(|pair| pair == ["--date", "20261118"]), "{runs:?}");
    harness.finish().await;
}

fn prune_log_of(data: &Path, date: u32) -> Value {
    let text = std::fs::read_to_string(data.join("store").join("prune.log.jsonl")).unwrap_or_default();
    text.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()).find(|line| line["date"] == json!(date)).unwrap_or_else(|| panic!("{date}의 지우기 기록이 없다: {text}"))
}

fn daemon_arguments(extra: &[&str]) -> Vec<String> {
    ["--keys", "somewhere"].iter().chain(extra).map(|argument| (*argument).to_owned()).collect()
}

fn exit_code_text(code: ExitCode) -> String {
    format!("{code:?}")
}

#[test]
fn supervise_retention_options_reach_the_finalize_arguments_and_bad_values_exit_with_2() {
    let schedule = schedule_from_arguments(&daemon_arguments(&["--keep-early", "20", "--keep", "3", "--early-period", "5"])).unwrap();
    assert_eq!(schedule.retention, RetentionSettings { early_keep: 20.try_into().unwrap(), steady_keep: 3.try_into().unwrap(), early_period: 5 });
    assert_eq!(schedule_from_arguments(&daemon_arguments(&[])).unwrap().retention, RetentionSettings::default());
    for bad in [&["--keep-early", "0"][..], &["--keep", "0"], &["--keep", "x"], &["--early-period", "-1"], &["--early-period", ""]] {
        assert!(schedule_from_arguments(&daemon_arguments(bad)).is_err(), "{bad:?}");
        assert_eq!(exit_code_text(collector::supervise::run(&daemon_arguments(bad))), exit_code_text(ExitCode::from(2)), "{bad:?}");
    }
    let with_date = daemon_arguments(&["--date", "20261118", "--keep", "3"]);
    assert_eq!(exit_code_text(collector::supervise::run(&with_date)), exit_code_text(ExitCode::from(2)));
}

#[tokio::test(start_paused = true)]
async fn supervise_retention_options_reach_prune() {
    let cases: [(&[&str], u64); 2] = [(&["--keep-early", "20", "--early-period", "20"], 20), (&["--keep", "8", "--early-period", "0"], 8)];
    for (options, keep_days) in cases {
        let schedule = schedule_from_arguments(&daemon_arguments(options)).unwrap();
        let harness = Harness::start(Config { schedule, ..Config::default() });
        harness.until_finalize_finished(1).await;
        assert!(harness.data().join("raw").join(OLD_DATE.to_string()).exists(), "{options:?}: 기본 값이면 지웠을 원문이 보관 기간 안이라 남는다");
        let line = prune_log_of(&harness.data(), OLD_DATE);
        assert_eq!(line["action"], "kept", "{options:?}");
        assert_eq!(line["reason"], "within_retention", "{options:?}");
        assert_eq!(line["keep_observation_days"], json!(keep_days), "{options:?}");
        harness.finish().await;
    }
}

fn monday() -> KstDate {
    KstDate::new(2026, 11, 16).unwrap()
}

fn seed_unfinalized_days(data: &Path, dates: &[u32]) {
    for date in dates {
        write_raw_day(data, *date);
    }
}

#[tokio::test(start_paused = true)]
async fn a_daemon_started_on_monday_finalizes_friday() {
    let harness = Harness::start_with(Config { start: kst(monday(), 7, 0, 0), seed_history: false, seed_today_raw: false, ..Config::default() }, |data| {
        seed_unfinalized_days(data, &[20261113]);
    });
    harness.until_finalize_finished(1).await;
    let runs = harness.finalizer.runs.lock().unwrap().clone();
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert!(runs[0].windows(2).any(|pair| pair == ["--date", "20261113"]), "{runs:?}");
    assert!(harness.data().join("store").join("20261113").join("complete.json").is_file());
    assert!(!harness.data().join("store").join("20261116").join("complete.json").exists(), "오늘은 정리하지 않는다");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_daemon_finalizes_every_unfinalized_past_day_oldest_first_and_skips_today() {
    let dates = [20261110, 20261112, 20261113];
    let harness = Harness::start_with(Config { start: kst(monday(), 7, 0, 0), seed_history: false, seed_today_raw: false, ..Config::default() }, |data| {
        seed_unfinalized_days(data, &[20261113, 20261110, 20261112, 20261116, 20261117]);
        write(&data.join("store").join("20261117").join("complete.json"), &complete_json(20261117, json!([])));
    });
    harness.until_finalize_finished(3).await;
    harness.until(kst(monday(), 7, 10, 0)).await;
    let runs = harness.finalizer.runs.lock().unwrap().clone();
    let finalized: Vec<&str> = runs.iter().map(|arguments| arguments[arguments.iter().position(|argument| argument == "--date").unwrap() + 1].as_str()).collect();
    assert_eq!(finalized, ["20261110", "20261112", "20261113"], "{runs:?}");
    for date in dates {
        assert!(harness.data().join("store").join(date.to_string()).join("complete.json").is_file(), "{date}");
    }
    assert!(!harness.data().join("store").join("20261116").join("complete.json").exists());
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_failing_backlog_day_is_tried_once_per_start_and_the_others_still_run() {
    let harness = Harness::start_with(
        Config { start: kst(monday(), 7, 0, 0), seed_history: false, seed_today_raw: false, forced_exit: Some(1), ..Config::default() },
        |data| seed_unfinalized_days(data, &[20261112, 20261113]),
    );
    harness.until_finalize_finished(2).await;
    harness.until(kst(monday(), 7, 10, 0)).await;
    assert_eq!(harness.finalizer.runs.lock().unwrap().len(), 2, "한 번 시작에 날마다 한 번만 시도한다");
    assert!(harness.alert_kinds().iter().filter(|kind| *kind == "stage_failed").count() >= 2);
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_next_day_start_finalizes_every_past_day_left_unfinalized() {
    let harness = Harness::start_with(
        Config { forced_exit: Some(1), holidays: Holidays::Listed(vec![(20261119, "임시공휴일")]), seed_history: false, seed_today_raw: true, ..Config::default() },
        |data| seed_unfinalized_days(data, &[20261112]),
    );
    harness.until_finalize_finished(2).await;
    harness.until(kst(KstDate::new(2026, 11, 19).unwrap(), 0, 5, 0)).await;
    harness.until_finalize_finished(4).await;
    let runs = harness.finalizer.runs.lock().unwrap().clone();
    let dates: Vec<&str> = runs[2..].iter().map(|arguments| arguments[arguments.iter().position(|argument| argument == "--date").unwrap() + 1].as_str()).collect();
    assert_eq!(dates, ["20261112", "20261118"], "{runs:?}");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_journal_line_cut_inside_a_korean_character_does_not_stop_the_complete_file() {
    let harness = Harness::start_with(Config::default(), |data| {
        let mut torn = br#"{"v":1,"at":"2026-11-18T06:59:58+09:00","event":"key_stopped","key":"collect-01","reason":""#.to_vec();
        torn.extend_from_slice(&"토큰".as_bytes()[..4]);
        std::fs::create_dir_all(journal_path(data, DATE).parent().unwrap()).unwrap();
        std::fs::write(journal_path(data, DATE), torn).unwrap();
    });
    harness.until_finalize_finished(1).await;
    assert_eq!(harness.complete()["observation"]["judgment"]["verdict"], "observed");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_torn_journal_line_does_not_swallow_the_next_event() {
    let harness = Harness::start_with(Config::default(), |data| {
        let torn = r#"{"v":1,"at":"2026-11-18T06:59:58+09:00","event":"child_started","key":"collect-01","pid":4"#;
        write(&journal_path(data, DATE), torn);
    });
    harness.until_finalize_finished(1).await;
    let complete = harness.complete();
    assert_eq!(complete["observation"]["judgment"]["verdict"], "observed", "{}", complete["observation"]);
    assert_eq!(complete["observation"]["market_open"]["state"], "seen");
    assert_eq!(complete["observation"]["index_check"]["result"], "agrees");
    let text = std::fs::read_to_string(journal_path(&harness.data(), DATE)).unwrap();
    assert!(text.lines().next().unwrap().ends_with("\"pid\":4"), "잘린 줄은 제 줄로 남는다");
    assert!(text.ends_with('\n'));
    harness.finish().await;
}

struct Client {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

impl Client {
    async fn connect(socket: &Path) -> Client {
        let (reader, writer) = UnixStream::connect(socket).await.unwrap().into_split();
        Client { reader: BufReader::new(reader), writer }
    }

    async fn status(&mut self) -> Value {
        self.writer.write_all(format!("{}\n", fixture("request-status.json")).as_bytes()).await.unwrap();
        let mut line = String::new();
        let read = timeout(Duration::from_secs(30), self.reader.read_line(&mut line)).await.expect("응답이 오지 않았다").unwrap();
        assert!(read > 0, "연결이 닫혔다");
        serde_json::from_str(&line).unwrap()
    }
}

fn fixture(name: &str) -> Value {
    let text = std::fs::read_to_string(Path::new(FIXTURES).join(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
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

#[tokio::test(start_paused = true)]
async fn the_status_socket_answers_in_every_phase_with_the_contract_shape() {
    let harness = Harness::start(Config { socket: true, hold_finalize: Duration::from_secs(600), ..Config::default() });
    let mut client = Client::connect(&harness.socket()).await;
    let mut phases = Vec::new();

    harness.until(at(3, 0, 0)).await;
    let reply = client.status().await;
    same_shape(&fixture("reply-status.json"), &reply, "장 밖 대기");
    assert_eq!(reply["status"]["phase"], "off_hours");
    assert_eq!(reply["status"]["date"], DATE);
    assert_eq!(reply["status"]["observation_day"], Value::Null);
    phases.push(reply["status"]["phase"].clone());

    harness.until(at(7, 25, 0)).await;
    let reply = client.status().await;
    assert_eq!(reply["status"]["phase"], "morning_prep");
    assert_eq!(reply["status"]["observation_day"]["verdict"], "observed");
    let changes = &reply["status"]["universe_changes"];
    assert_eq!(changes["added"][0]["code"], "000060");
    assert_eq!(changes["removed"][0]["code"], "000090");
    phases.push(reply["status"]["phase"].clone());

    harness.until(at(9, 30, 0)).await;
    let reply = client.status().await;
    assert_eq!(reply["status"]["phase"], "collecting");
    assert_eq!(reply["status"]["keys"].as_array().unwrap().len(), 3);
    assert_eq!(reply["status"]["today"]["planned_stocks"], 6);
    let filled = fixture("reply-status-filled.json");
    let mut with_alert = reply.clone();
    with_alert["status"]["alerts"] = filled["status"]["alerts"].clone();
    let mut shape_reference = filled.clone();
    shape_reference["status"]["keys"] = fixture("reply-status.json")["status"]["keys"].clone();
    same_shape(&shape_reference, &with_alert, "장중 수집");
    phases.push(reply["status"]["phase"].clone());

    harness.until(at(20, 5, 20)).await;
    let reply = client.status().await;
    assert_eq!(reply["status"]["phase"], "after_close");
    phases.push(reply["status"]["phase"].clone());

    harness.until(at(20, 9, 0)).await;
    let reply = client.status().await;
    assert_eq!(reply["status"]["phase"], "finalizing");
    phases.push(reply["status"]["phase"].clone());

    harness.until_finalize_finished(1).await;
    let reply = client.status().await;
    assert_eq!(reply["status"]["phase"], "off_hours");
    assert_eq!(phases, ["off_hours", "morning_prep", "collecting", "after_close", "finalizing"]);
    let text = reply.to_string();
    for marker in SECRET_MARKERS {
        assert!(!text.contains(marker), "상태 응답에 {marker}가 있다");
    }
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_status_reply_carries_the_alerts_of_the_daemon_and_the_supervisor_oldest_first() {
    let harness = Harness::start(Config { socket: true, open_at: None, holidays: Holidays::Down, ..Config::default() });
    harness.until(at(9, 30, 0)).await;
    let mut client = Client::connect(&harness.socket()).await;
    let reply = client.status().await;
    let kinds: Vec<&str> = reply["status"]["alerts"].as_array().unwrap().iter().map(|alert| alert["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["observation_unknown", "market_open_missing"]);
    let times: Vec<&str> = reply["status"]["alerts"].as_array().unwrap().iter().map(|alert| alert["at"].as_str().unwrap()).collect();
    assert!(times.windows(2).all(|pair| pair[0] <= pair[1]), "{times:?}");
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_shutdown_signal_ends_the_daemon_while_it_waits_collects_or_finalizes() {
    let waiting = Harness::start(Config { socket: true, ..Config::default() });
    waiting.until(at(3, 0, 0)).await;
    let socket = waiting.socket();
    waiting.finish().await;
    assert!(!socket.exists(), "끝난 데몬은 소켓 파일을 지운다");

    let collecting = Harness::start(Config::default());
    collecting.until(at(10, 0, 0)).await;
    assert_eq!(collecting.status_now().phase, DayPhase::Collecting);
    let launcher = collecting.launcher.clone();
    collecting.finish().await;
    assert!(launcher.child("collect-01").commands.lock().unwrap().contains(&Command::Shutdown), "장중 종료 신호는 자식 끄기까지 간다");

    let finalizing = Harness::start(Config { hold_finalize: Duration::from_secs(3600), ..Config::default() });
    finalizing.until(at(20, 30, 0)).await;
    assert_eq!(finalizing.status_now().phase, DayPhase::Finalizing);
    finalizing.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_daemon_goes_on_to_the_next_day_after_a_whole_day() {
    let harness = Harness::start(Config::default());
    harness.until_finalize_finished(1).await;
    let next = KstDate::new(2026, 11, 19).unwrap();
    harness.until(kst(next, 7, 57, 0)).await;
    assert_eq!(harness.status_now().date, 20261119);
    assert_eq!(harness.launcher.launched(), 6, "다음 날도 같은 순서로 자식을 띄운다");
    harness.finish().await;
}

fn day_plan() -> PlanFile {
    let key = |name: &str, role: KeyRole, stocks: &[&str], market: bool| KeyShare {
        name: KeyName::parse(name).unwrap(),
        role,
        app_key_hash: credential_id(&app_key_of(name)),
        stocks: stocks.iter().map(|code| (*code).to_owned()).collect(),
        market_types: if market { MARKET_TYPES.to_vec() } else { Vec::new() },
        rest_jobs: Vec::new(),
        load: 0,
    };
    let keys = vec![
        key("collect-01", KeyRole::Collecting, &["000010", "000020", "000030"], true),
        key("collect-02", KeyRole::Collecting, &["000040", "000050", "000060"], false),
        key("spare-01", KeyRole::Spare, &[], false),
    ];
    PlanFile {
        format_version: 1,
        date: DATE,
        created_at: "2026-11-18T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: keys.len(), universe_replaced: None },
        keys,
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    }
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    let status = std::process::Command::new("cp").arg("-a").arg(format!("{}/.", from.display())).arg(to).status().unwrap();
    assert!(status.success());
}

#[tokio::test(start_paused = true)]
async fn an_unknown_day_with_a_changed_open_time_moves_the_zero_s_deadline() {
    let harness = Harness::start_with(Config { holidays: Holidays::Down, open_at: Some(at(10, 0, 0)), ..Config::default() }, |data| {
        write(
            &data.join("calendar").join("overrides.json"),
            r#"{"version":1,"days":[{"kind":"open_at","date":20261118,"time":"10:00","reason":"수능일"}]}"#,
        );
    });
    harness.until(at(10, 12, 0)).await;
    assert!(harness.journal_of("market_open_missing").is_empty(), "판단이 모름이어도 수정 파일의 개장 시각을 따라야 한다");
    assert_eq!(harness.journal_of("market_open_seen").len(), 1);
    harness.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_restart_after_a_missing_zero_s_keeps_the_missing_result() {
    let first = Harness::start(Config { open_at: None, ..Config::default() });
    first.until(at(9, 15, 0)).await;
    assert_eq!(first.journal_of("market_open_missing").len(), 1);
    let snapshot = tempfile::tempdir().unwrap();
    let Harness { folder, stop, done, .. } = first;
    stop.send(true).unwrap();
    timeout(Duration::from_secs(120), done).await.unwrap().unwrap();
    copy_tree(&folder.path().join("data"), snapshot.path());
    let snapshot_path = snapshot.path().to_path_buf();
    let second = Harness::start_with(Config { start: at(11, 0, 0), open_at: None, ..Config::default() }, move |data| {
        copy_tree(&snapshot_path, data);
    });
    second.until_finalize_finished(1).await;
    let complete = second.complete();
    assert_eq!(complete["observation"]["market_open"]["state"], "missing", "다시 뜬 데몬이 이미 적힌 0s 없음을 덮으면 안 된다");
    second.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_second_daemon_on_a_live_status_socket_does_not_start_even_without_an_explicit_socket_option() {
    let harness = Harness::start(Config { socket: true, ..Config::default() });
    let other_folder = tempfile::tempdir().unwrap();
    write(&other_folder.path().join("holiday-key"), SERVICE_KEY);
    let second = Daemon::start(
        DaemonInputs {
            keys: active_keys(other_folder.path()),
            data_dir: other_folder.path().join("data"),
            supervisor: Settings { status_socket: Some(SocketSetting { path: harness.socket(), required: false }), ..Settings::default() },
            schedule: Config::default().schedule,
            holiday_key_path: other_folder.path().join("holiday-key"),
        },
        DaemonInjected {
            launcher: harness.launcher.clone(),
            transport: harness.kiwoom.clone(),
            holidays: harness.holidays.clone(),
            finalizer: harness.finalizer.clone(),
            clock: harness.clock.clone(),
        },
    );
    let Err(DaemonStartError::StatusSocket { error, .. }) = second else { panic!("살아 있는 소켓을 두고 시작했다") };
    assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
    assert!(Client::connect(&harness.socket()).await.status().await["type"] == "status");
}
