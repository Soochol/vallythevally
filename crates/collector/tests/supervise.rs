use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::keys::{ActiveKey, KeyIdentity, KeyRole};
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile, check_plan};
use collector::protocol::{Batch, Command, Event, KeyName, Registration, Rejection, SessionState};
use collector::supervise::{
    ChildMessage, ChildProcess, DaemonStatus, Injected, Inputs, KeyState, Launcher, STOCK_TYPES, Settings, Spawned, StartError, Supervisor,
    effective_plan, journal_path, load_plan,
};
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::api::ApiId;
use server::kiwoom::token_file::credential_id;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep};

const DATE: u32 = 20261118;

fn app_key_of(name: &str) -> String {
    format!("FAKE-APPKEY-{name}")
}

fn stock_code(number: usize) -> String {
    format!("{:06}", number + 1)
}

struct FakeTransport {
    started: Instant,
    issued: Mutex<Vec<(String, Duration)>>,
    refused_8050: Mutex<HashSet<String>>,
    counter: AtomicUsize,
}

impl FakeTransport {
    fn new() -> Arc<FakeTransport> {
        Arc::new(FakeTransport { started: Instant::now(), issued: Mutex::default(), refused_8050: Mutex::default(), counter: AtomicUsize::new(0) })
    }

    fn refuse_8050(&self, key: &str) {
        self.refused_8050.lock().unwrap().insert(app_key_of(key));
    }

    fn issues(&self, key: &str) -> Vec<Duration> {
        let app_key = app_key_of(key);
        self.issued.lock().unwrap().iter().filter(|(issued_for, _)| *issued_for == app_key).map(|(_, at)| *at).collect()
    }

    fn all_issue_times(&self) -> Vec<Duration> {
        self.issued.lock().unwrap().iter().map(|(_, at)| *at).collect()
    }
}

impl Transport for FakeTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        assert_eq!(request.api_id, ApiId::Au10001, "데몬은 토큰 발급 말고는 키움을 부르지 않는다");
        let body: Value = serde_json::from_str(request.body.expose()).unwrap();
        let app_key = body["appkey"].as_str().unwrap().to_owned();
        self.issued.lock().unwrap().push((app_key.clone(), self.started.elapsed()));
        let reply = if self.refused_8050.lock().unwrap().contains(&app_key) {
            json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기 인증에 실패하였습니다]"})
        } else {
            let number = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
            json!({"token": format!("FAKE-TOKEN-{number}-for-{app_key}"), "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"})
        };
        Box::pin(async move { Ok(HttpResponse { status: 200, next_key: None, body: reply.to_string() }) })
    }
}

struct FakeChild {
    key: KeyName,
    commands: Mutex<Vec<Command>>,
    signals: Mutex<Vec<&'static str>>,
    alive: AtomicBool,
    silent: AtomicBool,
    stubborn: AtomicBool,
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

    fn commands(&self) -> Vec<Command> {
        self.commands.lock().unwrap().clone()
    }

    fn registers(&self) -> Vec<Registration> {
        self.commands().into_iter().filter_map(|command| if let Command::Register(registration) = command { Some(registration) } else { None }).collect()
    }

    fn tokens(&self) -> Vec<(String, u64)> {
        self.commands()
            .into_iter()
            .filter_map(|command| if let Command::Token { token, generation, .. } = command { Some((token.expose().clone(), generation)) } else { None })
            .collect()
    }

    fn signals(&self) -> Vec<&'static str> {
        self.signals.lock().unwrap().clone()
    }

    fn got_shutdown(&self) -> bool {
        self.commands().contains(&Command::Shutdown)
    }
}

struct FakeHandle(Arc<FakeChild>);

impl ChildProcess for FakeHandle {
    fn send(&mut self, command: &Command) {
        self.0.commands.lock().unwrap().push(command.clone());
        if *command == Command::Shutdown && !self.0.stubborn.load(Ordering::SeqCst) {
            self.0.exit(0);
        }
    }

    fn terminate(&mut self) {
        self.0.signals.lock().unwrap().push("terminate");
        if !self.0.stubborn.load(Ordering::SeqCst) {
            self.0.exit(0);
        }
    }

    fn kill(&mut self) {
        self.0.signals.lock().unwrap().push("kill");
        self.0.exit(137);
    }
}

#[derive(Default)]
struct FakeLauncher {
    spawned: Mutex<Vec<Arc<FakeChild>>>,
    silent_first: Mutex<BTreeMap<String, usize>>,
    stubborn: AtomicBool,
}

impl FakeLauncher {
    fn children_of(&self, key: &str) -> Vec<Arc<FakeChild>> {
        self.spawned.lock().unwrap().iter().filter(|child| child.key.as_str() == key).cloned().collect()
    }

    fn only(&self, key: &str) -> Arc<FakeChild> {
        let mut children = self.children_of(key);
        assert_eq!(children.len(), 1, "{key}의 자식 수");
        children.remove(0)
    }

    fn make_first_children_silent(&self, key: &str, count: usize) {
        self.silent_first.lock().unwrap().insert(key.to_owned(), count);
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, key: &KeyName) -> io::Result<Spawned> {
        let (events, messages) = mpsc::unbounded_channel();
        let silent = {
            let mut remaining = self.silent_first.lock().unwrap();
            match remaining.get_mut(key.as_str()) {
                Some(left) if *left > 0 => {
                    *left -= 1;
                    true
                }
                _ => false,
            }
        };
        let child = Arc::new(FakeChild {
            key: key.clone(),
            commands: Mutex::default(),
            signals: Mutex::default(),
            alive: AtomicBool::new(true),
            silent: AtomicBool::new(silent),
            stubborn: AtomicBool::new(self.stubborn.load(Ordering::SeqCst)),
            events,
        });
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
                if !beating.silent.load(Ordering::SeqCst) {
                    beating.emit(Event::Heartbeat { frames: 50, bytes: 5000, state: SessionState::Live });
                }
            }
        });
        Ok(Spawned { pid: Some(pid), process: Box::new(FakeHandle(child)), messages })
    }
}

fn identity(name: &str, role: KeyRole) -> KeyIdentity {
    KeyIdentity { name: KeyName::parse(name).unwrap(), role, app_key_hash: credential_id(&app_key_of(name)) }
}

fn active_key(folder: &Path, name: &str, role: KeyRole) -> ActiveKey {
    ActiveKey {
        broker: server::shared_data::Broker::Kiwoom,
        identity: identity(name, role),
        app_key: Secret::new(app_key_of(name)),
        app_secret: Secret::new(format!("FAKE-SECRET-{name}")),
        token_path: folder.join(name).join("token.json"),
        lock_path: folder.join(name).join("collector.lock"),
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

fn plan_for(collecting: usize, stocks_each: usize) -> PlanFile {
    let mut keys: Vec<KeyShare> = (0..collecting)
        .map(|number| {
            let stocks = (0..stocks_each).map(|stock| stock_code(number * stocks_each + stock)).collect();
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
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    }
}

fn active_keys_for(folder: &Path, plan: &PlanFile) -> Vec<ActiveKey> {
    plan.keys.iter().map(|key| active_key(folder, key.name.as_str(), key.role)).collect()
}

struct World {
    folder: tempfile::TempDir,
    launcher: Arc<FakeLauncher>,
    transport: Arc<FakeTransport>,
    status: watch::Receiver<DaemonStatus>,
    stop: watch::Sender<bool>,
    done: tokio::task::JoinHandle<()>,
    control: collector::supervise::Control,
    clock: Clock,
}

impl World {
    fn start(plan: PlanFile) -> World {
        World::start_with(plan, Settings::default(), |_, _| {})
    }

    fn start_with(plan: PlanFile, settings: Settings, prepare: impl FnOnce(&FakeLauncher, &FakeTransport)) -> World {
        let folder = tempfile::tempdir().unwrap();
        let launcher = Arc::new(FakeLauncher::default());
        let transport = FakeTransport::new();
        prepare(&launcher, &transport);
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 18).unwrap(), 9, 0, 0));
        let keys = active_keys_for(folder.path(), &plan);
        let injected = Injected { launcher: launcher.clone(), transport: transport.clone(), clock: clock.clone() };
        let supervisor = match Supervisor::start(Inputs { plan, keys, data_dir: folder.path().join("data"), settings }, injected) {
            Ok(supervisor) => supervisor,
            Err(error) => panic!("시작하지 못했다: {error}"),
        };
        let (status, control) = (supervisor.status(), supervisor.control());
        let (stop, shutdown) = watch::channel(false);
        let done = tokio::spawn(supervisor.run(shutdown));
        World { folder, launcher, transport, status, stop, done, control, clock }
    }

    fn journal(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(journal_path(&self.folder.path().join("data"), DATE)).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn journal_of(&self, event: &str) -> Vec<Value> {
        self.journal().into_iter().filter(|record| record["event"] == event).collect()
    }

    fn state_of(&self, key: &str) -> KeyState {
        self.status.borrow().keys.iter().find(|status| status.name.as_str() == key).unwrap().state
    }

    fn status_of(&self, key: &str) -> collector::supervise::KeyStatus {
        self.status.borrow().keys.iter().find(|status| status.name.as_str() == key).unwrap().clone()
    }

    async fn pass(&self, seconds: u64) {
        sleep(Duration::from_secs(seconds)).await;
    }

    async fn finish(self) -> World {
        self.stop.send(true).unwrap();
        self.pass(40).await;
        assert!(self.done.is_finished(), "데몬이 끝나지 않았다");
        self
    }
}

fn spacing(times: &[Duration]) -> Vec<u64> {
    times.windows(2).map(|pair| (pair[1] - pair[0]).as_secs()).collect()
}

fn registered(id: &str, part: u32, parts: u32, ok: bool) -> Event {
    let rejection = (!ok).then(|| Rejection { reason: "한도".to_owned(), return_code: Some(105115), detail: Some(8005) });
    Event::Registered { batch: Batch { id: id.to_owned(), part, parts, items: 50 }, ok, replay: false, rejection }
}

#[tokio::test(start_paused = true)]
async fn three_collecting_keys_and_a_spare_get_spaced_tokens_and_only_the_collecting_keys_get_their_share() {
    let plan = plan_for(3, 4);
    let world = World::start(plan.clone());
    world.pass(30).await;

    let issues = world.transport.all_issue_times();
    assert_eq!(issues.len(), 4, "키 넷이 한 번씩 발급한다");
    assert!(spacing(&issues).iter().all(|gap| *gap >= 5), "{:?}", spacing(&issues));

    for share in plan.keys.iter().filter(|share| share.role == KeyRole::Collecting) {
        let child = world.launcher.only(share.name.as_str());
        let registers = child.registers();
        let stocks: Vec<String> = registers.iter().filter(|registration| registration.types() == STOCK_TYPES).flat_map(Registration::wire_items).collect();
        let wanted: Vec<String> = share.stocks.iter().map(|code| format!("{code}_AL")).collect();
        assert_eq!(stocks, wanted, "{}", share.name);
        assert_eq!(child.tokens().len(), 1, "{}", share.name);
        let (token, _) = &child.tokens()[0];
        assert!(token.ends_with(&app_key_of(share.name.as_str())), "키마다 자기 앱키의 토큰을 받는다");
    }
    let market_holder = world.launcher.only("collect-01");
    assert_eq!(market_holder.registers().len(), 1 + MARKET_TYPES.len());
    let spare = world.launcher.only("spare-01");
    assert!(spare.registers().is_empty(), "예비 키에는 등록이 없다");
    assert_eq!(spare.tokens().len(), 1, "예비 키는 토큰을 미리 받아 둔다");
    assert_eq!(world.state_of("collect-01"), KeyState::Receiving);
    assert_eq!(world.status_of("collect-01").stocks, 4);
    assert_eq!(world.status_of("collect-01").messages_per_second, Some(10.0));
    assert_eq!(world.launcher.spawned.lock().unwrap().len(), 4);
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_silent_child_is_replaced_after_fifteen_seconds_with_growing_delays_and_gets_its_token_and_share_again() {
    let world = World::start_with(plan_for(2, 3), Settings::default(), |launcher, _| launcher.make_first_children_silent("collect-02", 2));
    world.pass(14).await;
    assert_eq!(world.launcher.children_of("collect-02").len(), 1, "15초가 지나기 전에는 그대로다");
    world.pass(2).await;
    assert_eq!(world.launcher.children_of("collect-02")[0].signals(), ["terminate"]);
    assert_eq!(world.journal_of("heartbeat_lost").len(), 1);
    assert_eq!(world.state_of("collect-02"), KeyState::Disconnected);
    world.pass(60).await;

    let children = world.launcher.children_of("collect-02");
    assert_eq!(children.len(), 3, "처음 자식, 다시 띄운 둘");
    let restarts: Vec<u64> = world.journal_of("restart").iter().map(|record| record["delay_secs"].as_u64().unwrap()).collect();
    assert_eq!(restarts, [1, 2]);
    let first = &children[0];
    let last = &children[2];
    assert_eq!(last.tokens().len(), 1, "다시 뜬 자식도 토큰을 받는다");
    assert_eq!(first.tokens()[0].0, last.tokens()[0].0, "아직 유효한 토큰을 다시 보낸다(새로 발급하지 않는다)");
    assert_eq!(world.transport.issues("collect-02").len(), 1);
    assert_eq!(last.registers().len(), first.registers().len());
    assert!(!last.registers().is_empty());
    assert_eq!(world.state_of("collect-02"), KeyState::Receiving);
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_key_past_the_restart_limit_hands_its_share_to_the_spare_and_is_never_registered_again() {
    let world = World::start_with(plan_for(2, 3), Settings::default(), |launcher, _| launcher.make_first_children_silent("collect-02", 99));
    world.pass(200).await;

    let restarts: Vec<u64> = world.journal_of("restart").iter().map(|record| record["delay_secs"].as_u64().unwrap()).collect();
    assert_eq!(restarts, [1, 2, 5, 10, 30]);
    assert_eq!(world.launcher.children_of("collect-02").len(), 6, "처음 하나와 재시작 다섯");
    let handoffs = world.journal_of("handoff");
    assert_eq!(handoffs.len(), 1);
    assert_eq!(handoffs[0]["from"], "collect-02");
    assert_eq!(handoffs[0]["to"], "spare-01");
    assert_eq!(handoffs[0]["stocks"], json!(["000004", "000005", "000006"]));
    assert_eq!(handoffs[0]["at"].as_str().map(|at| at.starts_with("2026-11-18T09:")), Some(true));
    assert_eq!(handoffs[0]["v"], 1);
    assert_eq!(world.state_of("collect-02"), KeyState::HandedOff);
    assert_eq!(world.status_of("collect-02").stocks, 0);

    let spare = world.launcher.only("spare-01");
    let wire: Vec<String> = spare.registers().iter().flat_map(Registration::wire_items).collect();
    assert_eq!(wire, ["000004_AL", "000005_AL", "000006_AL"]);
    assert_eq!(world.state_of("spare-01"), KeyState::Receiving);
    assert_eq!(world.status_of("spare-01").stocks, 3);

    let registers_before: Vec<usize> = world.launcher.children_of("collect-02").iter().map(|child| child.registers().len()).collect();
    world.pass(300).await;
    assert_eq!(world.launcher.children_of("collect-02").len(), 6, "인계된 키는 다시 띄우지 않는다");
    let registers_after: Vec<usize> = world.launcher.children_of("collect-02").iter().map(|child| child.registers().len()).collect();
    assert_eq!(registers_before, registers_after, "원래 키에는 그날 다시 등록을 보내지 않는다");
    let effective = effective_plan(&plan_for(2, 3), Some((&KeyName::parse("collect-02").unwrap(), &KeyName::parse("spare-01").unwrap())));
    check_plan(&effective).unwrap();
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_key_that_gets_8050_is_handed_off_at_once_and_the_second_stopped_key_is_not() {
    let world = World::start_with(plan_for(3, 3), Settings::default(), |_, transport| {
        transport.refuse_8050("collect-02");
        transport.refuse_8050("collect-03");
    });
    world.pass(60).await;

    let stopped = world.journal_of("key_stopped");
    assert_eq!(stopped.len(), 2);
    assert!(stopped[0]["reason"].as_str().unwrap().contains("8050"), "{}", stopped[0]);
    let handoffs = world.journal_of("handoff");
    assert_eq!(handoffs.len(), 1);
    assert_eq!(handoffs[0]["from"], "collect-02");
    let skipped = world.journal_of("handoff_skipped");
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["key"], "collect-03");
    assert_eq!(world.state_of("collect-02"), KeyState::HandedOff);
    assert_eq!(world.state_of("collect-03"), KeyState::Stopped);
    assert_eq!(world.launcher.only("spare-01").registers().iter().flat_map(Registration::wire_items).count(), 3);
    assert_eq!(world.state_of("collect-01"), KeyState::Receiving);
    assert!(world.launcher.children_of("collect-02")[0].signals().contains(&"terminate"), "멈춘 키의 자식은 끝낸다");
    assert_eq!(world.launcher.children_of("collect-03").len(), 1, "멈춘 키는 다시 띄우지 않는다");
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_token_invalid_report_gets_a_new_token_only_after_the_issue_interval() {
    let world = World::start(plan_for(2, 2));
    world.pass(30).await;
    let child = world.launcher.only("collect-01");
    let (first_token, first_generation) = child.tokens()[0].clone();
    let first_issue = world.transport.issues("collect-01")[0];

    child.emit(Event::TokenInvalid { generation: first_generation });
    world.pass(300).await;
    assert_eq!(child.tokens().len(), 1, "10분이 지나기 전에는 새 토큰이 없다");
    assert_eq!(world.journal_of("token_invalid").len(), 1);
    assert_eq!(world.state_of("collect-01"), KeyState::Receiving);
    world.pass(400).await;

    let tokens = child.tokens();
    assert_eq!(tokens.len(), 2);
    assert_ne!(tokens[1].0, first_token);
    assert!(tokens[1].1 > first_generation);
    let issues = world.transport.issues("collect-01");
    assert_eq!(issues.len(), 2);
    assert!(issues[1] - issues[0] >= Duration::from_secs(600), "{issues:?} {first_issue:?}");
    assert!(spacing(&world.transport.all_issue_times()).iter().all(|gap| *gap >= 5));
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_staggered_reissue_replaces_the_token_at_the_requested_time_for_that_key_only() {
    let world = World::start(plan_for(2, 2));
    world.pass(30).await;
    let now = world.clock.now();
    world.control.reissue_token_at(KeyName::parse("collect-02").unwrap(), now.plus_secs(700));
    world.pass(650).await;
    assert_eq!(world.launcher.only("collect-02").tokens().len(), 1);
    world.pass(100).await;
    assert_eq!(world.launcher.only("collect-02").tokens().len(), 2);
    assert_eq!(world.launcher.only("collect-01").tokens().len(), 1);
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_shutdown_sends_shutdown_to_every_child_and_ends_the_ones_that_ignore_it() {
    let world = World::start(plan_for(2, 2));
    world.pass(30).await;
    world.launcher.only("collect-02").stubborn.store(true, Ordering::SeqCst);
    let world = world.finish().await;
    for key in ["collect-01", "collect-02", "spare-01"] {
        assert!(world.launcher.only(key).got_shutdown(), "{key}");
    }
    assert!(world.launcher.only("collect-01").signals().is_empty(), "순순히 끝난 자식에게는 신호가 필요 없다");
    assert_eq!(world.launcher.only("collect-02").signals(), ["terminate", "kill"]);
    assert_eq!(world.journal_of("child_exited").len(), 3);
}

#[tokio::test(start_paused = true)]
async fn the_configured_end_time_shuts_the_children_down() {
    let settings = Settings { end_at: Some(domain::TimeOfDay::hms(9, 5, 0).unwrap()), ..Settings::default() };
    let world = World::start_with(plan_for(1, 2), settings, |_, _| {});
    world.pass(200).await;
    assert!(!world.done.is_finished());
    world.pass(200).await;
    assert!(world.done.is_finished());
    assert!(world.launcher.only("collect-01").got_shutdown());
}

#[tokio::test(start_paused = true)]
async fn a_batch_reported_twice_counts_once_and_a_bad_line_restarts_the_child() {
    let world = World::start(plan_for(1, 120));
    world.pass(30).await;
    let child = world.launcher.only("collect-01");
    child.emit(registered("collect-01-stocks", 0, 3, false));
    child.emit(registered("collect-01-stocks", 0, 3, false));
    child.emit(registered("collect-01-stocks", 1, 3, false));
    child.emit(registered("collect-01-stocks", 2, 3, true));
    world.pass(1).await;
    assert_eq!(world.status_of("collect-01").register_failures, 2);
    assert_eq!(world.journal_of("register_failed").len(), 2);
    child.emit(registered("collect-01-stocks", 0, 3, true));
    world.pass(1).await;
    assert_eq!(world.status_of("collect-01").register_failures, 1, "같은 묶음의 새 결과가 앞의 것을 대체한다");

    child.events.send(ChildMessage::BadLine(collector::protocol::ProtocolError::Version(Some(2)))).unwrap();
    world.pass(5).await;
    assert_eq!(child.signals(), ["terminate"]);
    let rejected = world.journal_of("child_rejected");
    assert_eq!(rejected.len(), 1);
    assert_eq!(world.state_of("collect-01"), KeyState::HandedOff, "버전이 다른 자식은 다시 띄우지 않고 멈춰 인계한다");
    assert_eq!(world.launcher.children_of("collect-01").len(), 1);
    world.finish().await;
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Captured;

    fn make_writer(&'a self) -> Captured {
        self.clone()
    }
}

fn captured_logs() -> Captured {
    static LOGS: std::sync::OnceLock<Captured> = std::sync::OnceLock::new();
    LOGS.get_or_init(|| {
        let captured = Captured::default();
        let subscriber = tracing_subscriber::fmt().with_writer(captured.clone()).with_max_level(tracing::Level::TRACE).finish();
        tracing::subscriber::set_global_default(subscriber).unwrap();
        captured
    })
    .clone()
}

#[tokio::test(start_paused = true)]
async fn token_values_never_reach_the_event_record_or_the_log() {
    let captured = captured_logs();

    let world = World::start(plan_for(2, 2));
    world.pass(30).await;
    let child = world.launcher.only("collect-01");
    let tokens: Vec<String> = ["collect-01", "collect-02", "spare-01"].iter().flat_map(|key| world.launcher.only(key).tokens()).map(|(token, _)| token).collect();
    assert_eq!(tokens.len(), 3);
    child.emit(Event::TokenInvalid { generation: child.tokens()[0].1 });
    world.pass(1500).await;
    let journal_text = std::fs::read_to_string(journal_path(&world.folder.path().join("data"), DATE)).unwrap();
    let log_text = String::from_utf8_lossy(&captured.0.lock().unwrap()).into_owned();
    assert!(!log_text.is_empty());
    for token in tokens.iter().chain(child.tokens().iter().map(|(token, _)| token)) {
        assert!(!journal_text.contains(token.as_str()), "사건 기록에 토큰이 있다");
        assert!(!log_text.contains(token.as_str()), "로그에 토큰이 있다");
    }
    for name in ["collect-01", "collect-02", "spare-01"] {
        assert!(!journal_text.contains(&app_key_of(name)) && !log_text.contains(&app_key_of(name)), "앱키가 새 나갔다");
    }
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_daemon_refuses_to_start_on_a_shared_token_or_lock_file_a_stale_plan_or_a_key_list_that_disagrees_with_it() {
    let plan = plan_for(2, 2);
    let folder = tempfile::tempdir().unwrap();
    let start = |keys: Vec<ActiveKey>, plan: PlanFile| {
        let injected = Injected { launcher: Arc::new(FakeLauncher::default()), transport: FakeTransport::new(), clock: Clock::fake(kst(KstDate::new(2026, 11, 18).unwrap(), 9, 0, 0)) };
        Supervisor::start(Inputs { plan, keys, data_dir: folder.path().join("data"), settings: Settings::default() }, injected).err()
    };

    let mut shared_token = active_keys_for(folder.path(), &plan);
    shared_token[1].token_path = shared_token[0].token_path.clone();
    assert!(matches!(start(shared_token, plan.clone()), Some(StartError::SharedPath { .. })));

    let mut shared_lock = active_keys_for(folder.path(), &plan);
    shared_lock[2].lock_path = shared_lock[0].lock_path.clone();
    assert!(matches!(start(shared_lock, plan.clone()), Some(StartError::SharedPath { .. })));

    let mut without_one = active_keys_for(folder.path(), &plan);
    without_one.remove(0);
    assert!(matches!(start(without_one, plan.clone()), Some(StartError::PlanKeyNotActive(_))));

    let mut with_extra = active_keys_for(folder.path(), &plan);
    with_extra.push(active_key(folder.path(), "collect-09", KeyRole::Collecting));
    assert!(matches!(start(with_extra, plan.clone()), Some(StartError::ActiveKeyNotInPlan(_))));

    let mut other_hash = plan.clone();
    other_hash.keys[0].app_key_hash = credential_id("FAKE-APPKEY-someone-else");
    assert!(matches!(start(active_keys_for(folder.path(), &plan), other_hash), Some(StartError::PlanKeyDiffers(_))));

    let mut twice = plan.clone();
    let repeated = twice.keys[0].stocks[0].clone();
    twice.keys[1].stocks.push(repeated);
    assert!(matches!(start(active_keys_for(folder.path(), &plan), twice), Some(StartError::Plan(_))));

    assert!(start(active_keys_for(folder.path(), &plan), plan.clone()).is_none());
}

#[test]
fn a_plan_file_must_be_for_the_date_in_its_name_and_pass_the_one_stock_one_key_check() {
    let data = tempfile::tempdir().unwrap();
    let write = |date_in_name: u32, plan: &PlanFile| {
        let path = collector::plan::plan_path(data.path(), date_in_name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(plan).unwrap()).unwrap();
    };
    let plan = plan_for(2, 2);
    write(DATE, &plan);
    assert_eq!(load_plan(data.path(), DATE).unwrap().keys.len(), 3);

    write(20261119, &plan);
    assert!(matches!(load_plan(data.path(), 20261119), Err(StartError::PlanDate { requested: 20261119, in_plan: DATE })));

    let mut twice = plan_for(2, 2);
    let repeated = twice.keys[0].stocks[0].clone();
    twice.keys[1].stocks.push(repeated);
    twice.date = 20261120;
    write(20261120, &twice);
    assert!(matches!(load_plan(data.path(), 20261120), Err(StartError::Plan(_))));
    assert!(load_plan(data.path(), 20261121).is_err());
}

#[test]
fn the_plan_after_a_handoff_still_has_every_stock_on_exactly_one_key() {
    let plan = plan_for(3, 4);
    let (from, to) = (KeyName::parse("collect-01").unwrap(), KeyName::parse("spare-01").unwrap());
    let after = effective_plan(&plan, Some((&from, &to)));
    check_plan(&after).unwrap();
    let held = |plan: &PlanFile, name: &str| plan.keys.iter().find(|key| key.name.as_str() == name).unwrap().clone();
    assert!(held(&after, "collect-01").stocks.is_empty() && held(&after, "collect-01").market_types.is_empty());
    assert_eq!(held(&after, "spare-01").stocks, held(&plan, "collect-01").stocks);
    assert_eq!(held(&after, "spare-01").market_types, MARKET_TYPES.to_vec());
    assert_eq!(effective_plan(&plan, None), plan);
}

async fn stopped_spare_scenario(spare_event: ChildMessage) -> World {
    let world = World::start_with(plan_for(2, 3), Settings::default(), |launcher, _| launcher.stubborn.store(true, Ordering::SeqCst));
    world.pass(1).await;
    world.launcher.only("spare-01").events.send(spare_event).unwrap();
    world.pass(1).await;
    let giver = world.launcher.only("collect-02");
    giver.stubborn.store(false, Ordering::SeqCst);
    giver.events.send(ChildMessage::BadLine(collector::protocol::ProtocolError::Version(Some(2)))).unwrap();
    world.pass(1).await;
    assert_eq!(world.launcher.only("spare-01").signals(), ["terminate"], "예비 키는 아직 끝나는 중이다");
    world
}

#[tokio::test(start_paused = true)]
async fn a_spare_that_is_being_stopped_does_not_take_a_share() {
    let world = stopped_spare_scenario(ChildMessage::BadLine(collector::protocol::ProtocolError::Version(Some(2)))).await;
    world.pass(30).await;
    assert!(world.journal_of("handoff").is_empty(), "받지 못하는 예비 키로 인계했다고 적으면 안 된다");
    assert_eq!(world.journal_of("handoff_skipped").len(), 1);
    assert_eq!(world.state_of("collect-02"), KeyState::Stopped);
    assert!(world.launcher.only("spare-01").registers().is_empty());
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_spare_that_is_being_restarted_still_takes_the_share_and_registers_it_after_it_is_back() {
    let world = stopped_spare_scenario(ChildMessage::BadLine(collector::protocol::ProtocolError::NotJson)).await;
    world.pass(40).await;
    assert_eq!(world.journal_of("handoff").len(), 1);
    assert_eq!(world.state_of("collect-02"), KeyState::HandedOff);
    let spares = world.launcher.children_of("spare-01");
    assert_eq!(spares.len(), 2);
    let wire: Vec<String> = spares[1].registers().iter().flat_map(Registration::wire_items).collect();
    assert_eq!(wire, ["000004_AL", "000005_AL", "000006_AL"]);
    world.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_reissue_due_inside_the_issue_interval_keeps_the_valid_token_until_the_new_one_can_be_issued() {
    let world = World::start(plan_for(2, 2));
    world.pass(30).await;
    let now = world.clock.now();
    world.control.reissue_token_at(KeyName::parse("collect-02").unwrap(), now.plus_secs(100));
    world.pass(200).await;
    let first = world.launcher.only("collect-02");
    first.exit(1);
    world.pass(30).await;

    let children = world.launcher.children_of("collect-02");
    assert_eq!(children.len(), 2);
    assert_eq!(children[1].tokens().len(), 1, "다시 뜬 자식은 아직 유효한 토큰을 바로 받는다");
    assert_eq!(children[1].tokens()[0].0, first.tokens()[0].0);
    world.pass(700).await;
    assert_eq!(world.transport.issues("collect-02").len(), 2);
    assert_eq!(world.launcher.children_of("collect-02")[1].tokens().len(), 2, "새 토큰은 발급 간격이 지난 뒤 간다");
    world.finish().await;
}
