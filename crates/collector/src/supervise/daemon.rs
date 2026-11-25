use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use domain::{KstDate, KstTime};
use server::clock::Clock;
use server::instance::LockError;
use server::kiwoom::transport::Transport;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep_until};

use super::api::{StatusApi, StatusSocket, serve};
use super::child_slot::{ChildSlot, GoneOutcome, SlotTimer, SupervisedSlot, hash_prefix, next_slot_deadline, shut_down_slots, sleep_until_option};
use super::handoff::{effective_plan, registrations_of};
use super::journal::{Journal, JournalEvent, has_event, journal_path, kst_stamp};
use super::process::{ChildMessage, Launcher};
use super::settings::{Settings, SocketSetting};
use super::status::{Alert, AlertKind, DaemonStatus, DayPhase, KeyState, KeyStatus, RestProgress, Today};
use super::tokens::{Halted, Issue, IssueLane, KeyTokens};
use crate::keys::{ActiveKey, KeyRole};
use crate::plan::{PlanError, PlanFile, Violation, check_plan, read_plan};
use crate::protocol::{Command, Event, HEARTBEAT_EVERY, KeyName, ProtocolError, Registration, RegistrationError, SessionState};

const ALERT_LIMIT: usize = 200;

pub struct Injected {
    pub launcher: Arc<dyn Launcher>,
    pub transport: Arc<dyn Transport>,
    pub clock: Clock,
}

pub struct Inputs {
    pub plan: PlanFile,
    pub keys: Vec<ActiveKey>,
    pub data_dir: PathBuf,
    pub settings: Settings,
}

#[derive(Debug)]
pub enum StartError {
    Plan(PlanError),
    PlanDate { requested: u32, in_plan: u32 },
    PlanKeyNotActive(KeyName),
    ActiveKeyNotInPlan(KeyName),
    PlanKeyDiffers(KeyName),
    SharedPath { first: KeyName, second: KeyName, path: PathBuf },
    Registration { key: KeyName, error: RegistrationError },
    Lock { key: KeyName, error: LockError },
    Journal(io::Error),
    StatusSocket { path: PathBuf, error: io::Error },
}

impl fmt::Display for StartError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartError::Plan(error) => error.fmt(formatter),
            StartError::PlanDate { requested, in_plan } => write!(formatter, "{requested}의 계획 파일이 {in_plan}일의 계획입니다"),
            StartError::PlanKeyNotActive(key) => write!(formatter, "계획에 있는 키 {key}가 키 목록 설정의 활성 키에 없습니다"),
            StartError::ActiveKeyNotInPlan(key) => write!(formatter, "활성 키 {key}가 그날 계획에 없습니다. 키 목록 설정을 바꾼 뒤 계획을 다시 세워야 합니다"),
            StartError::PlanKeyDiffers(key) => write!(formatter, "키 {key}의 역할이나 앱키 해시가 계획과 키 목록 설정에서 다릅니다"),
            StartError::SharedPath { first, second, path } => {
                write!(formatter, "키 {first}와 {second}가 같은 파일({})을 씁니다. 키마다 토큰과 잠금 파일은 따로여야 합니다", path.display())
            }
            StartError::Registration { key, error } => write!(formatter, "키 {key}의 몫으로 등록 명령을 만들 수 없습니다: {error}"),
            StartError::Lock { key, error } => write!(formatter, "키 {key}의 잠금을 잡지 못했습니다: {error}"),
            StartError::Journal(error) => write!(formatter, "사건 기록 파일을 열 수 없습니다: {error}"),
            StartError::StatusSocket { path, error } => write!(formatter, "상태 소켓 {}을 열 수 없습니다: {error}", path.display()),
        }
    }
}

impl std::error::Error for StartError {}

pub fn load_plan(data_dir: &std::path::Path, date: u32) -> Result<PlanFile, StartError> {
    let plan = read_plan(data_dir, date).map_err(StartError::Plan)?;
    if plan.date != date {
        return Err(StartError::PlanDate { requested: date, in_plan: plan.date });
    }
    check_plan(&plan).map_err(|violation: Violation| StartError::Plan(PlanError::Violation(violation)))?;
    Ok(plan)
}

#[derive(Debug, Clone)]
pub struct Control {
    commands: mpsc::UnboundedSender<ControlCommand>,
}

#[derive(Debug)]
enum ControlCommand {
    ReissueToken { key: KeyName, at: KstTime },
    EnterPhase(DayPhase),
}

impl Control {
    pub fn reissue_token_at(&self, key: KeyName, at: KstTime) {
        let _ = self.commands.send(ControlCommand::ReissueToken { key, at });
    }

    pub fn enter_phase(&self, phase: DayPhase) {
        let _ = self.commands.send(ControlCommand::EnterPhase(phase));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarketOpenWatch {
    Off,
    Waiting(Instant),
    Settled,
}

enum Inbound {
    Child { index: usize, incarnation: u64, message: ChildMessage },
    Issued { index: usize, issue: Issue },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StopReason {
    RestartLimit,
    Token(Halted),
    VersionMismatch,
}

impl fmt::Display for StopReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StopReason::RestartLimit => formatter.write_str("그날 재시작 한도를 넘었습니다"),
            StopReason::Token(halted) if halted.is_8050 => write!(formatter, "8050을 받았습니다: {}", halted.text),
            StopReason::Token(halted) => write!(formatter, "토큰을 받을 수 없습니다: {}", halted.text),
            StopReason::VersionMismatch => formatter.write_str("자식의 프로토콜 버전이 데몬과 다릅니다"),
        }
    }
}

struct KeyRuntime {
    name: KeyName,
    role: KeyRole,
    own: Vec<Registration>,
    own_stocks: usize,
    rest_jobs: usize,
    hash_prefix: String,
    handoff_share: Vec<Registration>,
    inherited: Vec<Registration>,
    inherited_stocks: usize,
    tokens: Arc<KeyTokens>,
    slot: ChildSlot<StopReason>,
    handed_off: bool,
    receiving: bool,
    down: bool,
    sent_generation: Option<u64>,
    issuing: bool,
    issue_at: Option<Instant>,
    reissue_at: Option<Instant>,
    batches: BTreeMap<(String, u32, u32), bool>,
    messages_per_second: Option<f64>,
}

impl SupervisedSlot for KeyRuntime {
    type Stop = StopReason;

    fn name(&self) -> KeyName {
        self.name.clone()
    }

    fn slot(&self) -> &ChildSlot<StopReason> {
        &self.slot
    }

    fn slot_mut(&mut self) -> &mut ChildSlot<StopReason> {
        &mut self.slot
    }
}

impl KeyRuntime {
    fn failed_batches(&self) -> usize {
        self.batches.values().filter(|ok| !**ok).count()
    }

    fn state(&self) -> KeyState {
        if self.handed_off {
            return KeyState::HandedOff;
        }
        self.slot.key_state(self.receiving, self.down, self.sent_generation.is_some())
    }

    fn status(&self) -> KeyStatus {
        let stocks = if self.handed_off { 0 } else { self.own_stocks + self.inherited_stocks };
        KeyStatus {
            name: self.name.clone(),
            app_key_hash_prefix: self.hash_prefix.clone(),
            role: self.role,
            state: self.state(),
            stocks,
            messages_per_second: self.messages_per_second,
            register_failures: self.failed_batches(),
            restarts: self.slot.restarts(),
            rest: RestProgress { planned_jobs: self.rest_jobs, finished_jobs: 0 },
            usage: None,
        }
    }
}

pub struct Supervisor {
    date: u32,
    data_dir: PathBuf,
    plan: PlanFile,
    settings: Settings,
    keys: Vec<KeyRuntime>,
    launcher: Arc<dyn Launcher>,
    clock: Clock,
    lane: Arc<IssueLane>,
    journal: Journal,
    inbox: mpsc::UnboundedSender<Inbound>,
    inbox_source: mpsc::UnboundedReceiver<Inbound>,
    control_sink: mpsc::UnboundedSender<ControlCommand>,
    control_source: mpsc::UnboundedReceiver<ControlCommand>,
    status: watch::Sender<DaemonStatus>,
    status_socket: Option<StatusSocket>,
    phase: DayPhase,
    alerts: Vec<Alert>,
    handed: Option<usize>,
    housekeeping_at: Instant,
    market_open: MarketOpenWatch,
}

fn check_inputs(inputs: &Inputs) -> Result<(), StartError> {
    for share in &inputs.plan.keys {
        let Some(active) = inputs.keys.iter().find(|key| key.identity.name == share.name) else {
            return Err(StartError::PlanKeyNotActive(share.name.clone()));
        };
        if active.identity.role != share.role || active.identity.app_key_hash != share.app_key_hash {
            return Err(StartError::PlanKeyDiffers(share.name.clone()));
        }
    }
    for (index, key) in inputs.keys.iter().enumerate() {
        if !inputs.plan.keys.iter().any(|share| share.name == key.identity.name) {
            return Err(StartError::ActiveKeyNotInPlan(key.identity.name.clone()));
        }
        for earlier in &inputs.keys[..index] {
            for (path, other) in [(&key.token_path, &earlier.token_path), (&key.lock_path, &earlier.lock_path)] {
                if path == other {
                    return Err(StartError::SharedPath { first: earlier.identity.name.clone(), second: key.identity.name.clone(), path: path.clone() });
                }
            }
        }
    }
    check_plan(&inputs.plan).map_err(|violation| StartError::Plan(PlanError::Violation(violation)))
}

impl Supervisor {
    pub fn start(inputs: Inputs, injected: Injected) -> Result<Supervisor, StartError> {
        check_inputs(&inputs)?;
        let Inputs { plan, keys: active, data_dir, settings } = inputs;
        let journal = Journal::open(journal_path(&data_dir, plan.date)).map_err(StartError::Journal)?;
        let mut keys = Vec::new();
        for share in &plan.keys {
            let Some(active) = active.iter().find(|key| key.identity.name == share.name) else { continue };
            let registration_error = |error| StartError::Registration { key: share.name.clone(), error };
            let tokens = KeyTokens::open(active, injected.transport.clone(), injected.clock.clone())
                .map_err(|error| StartError::Lock { key: share.name.clone(), error })?;
            keys.push(KeyRuntime {
                name: share.name.clone(),
                role: share.role,
                own: registrations_of(share, share.name.as_str()).map_err(registration_error)?,
                own_stocks: share.stocks.len(),
                rest_jobs: share.rest_jobs.len(),
                hash_prefix: hash_prefix(&share.app_key_hash),
                handoff_share: registrations_of(share, &format!("handoff-{}", share.name)).map_err(registration_error)?,
                inherited: Vec::new(),
                inherited_stocks: 0,
                tokens: Arc::new(tokens),
                slot: ChildSlot::new(Instant::now()),
                handed_off: false,
                receiving: false,
                down: false,
                sent_generation: None,
                issuing: false,
                issue_at: None,
                reissue_at: None,
                batches: BTreeMap::new(),
                messages_per_second: None,
            });
        }
        let (inbox, inbox_source) = mpsc::unbounded_channel();
        let (control_sink, control_source) = mpsc::unbounded_channel();
        let status_socket = match &settings.status_socket {
            Some(SocketSetting { path, required }) => match StatusSocket::bind(path) {
                Ok(socket) => Some(socket),
                Err(error) if *required || error.kind() == io::ErrorKind::AddrInUse => return Err(StartError::StatusSocket { path: path.clone(), error }),
                Err(error) => {
                    tracing::error!(path = %path.display(), %error, "상태 소켓을 열 수 없어 상태 API 없이 수집을 이어 갑니다");
                    None
                }
            },
            None => None,
        };
        let date = plan.date;
        let mut alerts = plan_alerts(&plan);
        alerts.drain(..alerts.len().saturating_sub(ALERT_LIMIT));
        Ok(Supervisor {
            date,
            data_dir,
            plan,
            lane: Arc::new(IssueLane::new(settings.token_spacing)),
            housekeeping_at: Instant::now() + settings.housekeeping_every,
            settings,
            keys,
            launcher: injected.launcher,
            clock: injected.clock,
            journal,
            inbox,
            inbox_source,
            control_sink,
            control_source,
            status: watch::channel(DaemonStatus { date, ..DaemonStatus::default() }).0,
            status_socket,
            phase: DayPhase::default(),
            alerts,
            handed: None,
            market_open: MarketOpenWatch::Off,
        })
    }

    pub fn status(&self) -> watch::Receiver<DaemonStatus> {
        self.status.subscribe()
    }

    pub fn control(&self) -> Control {
        Control { commands: self.control_sink.clone() }
    }

    fn record(&mut self, event: JournalEvent) {
        let at = self.clock.now();
        self.journal.append(at, &event);
        if let Some((kind, message)) = alert_of(&event) {
            self.alerts.push(Alert { at: kst_stamp(at), kind, message });
            self.alerts.drain(..self.alerts.len().saturating_sub(ALERT_LIMIT));
        }
    }

    fn name(&self, index: usize) -> KeyName {
        self.keys[index].name.clone()
    }

    pub async fn run(mut self, mut shutdown: watch::Receiver<bool>) {
        if self.after_end() {
            tracing::warn!(date = self.date, "마감 시각이 지난 뒤라 자식도 토큰도 띄우지 않고 끝냅니다");
            self.publish_status();
            return;
        }
        self.arm_market_open();
        for index in 0..self.keys.len() {
            self.acquire_token(index);
        }
        let end = self.end_instant();
        self.publish_status();
        let (api_stop, api_shutdown) = watch::channel(false);
        let api = self.status_socket.take().map(|socket| {
            let api = StatusApi { status: self.status.subscribe(), data_dir: self.data_dir.clone(), clock: self.clock.clone(), watch_every: self.settings.watch_every };
            tokio::spawn(serve(socket, api, api_shutdown))
        });
        loop {
            let wake = self.next_deadline();
            tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
                Some(inbound) = self.inbox_source.recv() => self.on_inbound(inbound),
                Some(command) = self.control_source.recv() => self.on_control(command),
                () = sleep_until(wake) => self.on_timers(),
                () = sleep_until_option(end) => break,
            }
            self.publish_status();
        }
        self.shut_down().await;
        self.publish_status();
        let _ = api_stop.send(true);
        if let Some(api) = api {
            let _ = api.await;
        }
    }

    fn end_time(&self) -> Option<KstTime> {
        let at = self.settings.end_at?;
        let day = KstDate::parse_yyyymmdd(&self.date.to_string())?;
        Some(KstTime::from_kst_civil(day, at))
    }

    fn after_end(&self) -> bool {
        self.end_time().is_some_and(|end| self.clock.now().unix() >= end.unix())
    }

    fn end_instant(&self) -> Option<Instant> {
        let end = self.end_time()?;
        Some(Instant::now() + Duration::from_secs((end.unix() - self.clock.now().unix()).max(0) as u64))
    }

    fn arm_market_open(&mut self) {
        let Some(check) = self.settings.market_open_check else { return };
        let now = self.clock.now();
        let settled_before = ["market_open_seen", "market_open_missing"].iter().any(|event| has_event(&journal_path(&self.data_dir, self.date), event));
        if settled_before {
            self.market_open = MarketOpenWatch::Settled;
        } else if now.unix() >= check.opens_at.unix() {
            let reason = format!("개장({})이 지난 뒤에 시작해 0s 대조를 하지 않습니다", kst_stamp(check.opens_at));
            self.record(JournalEvent::MarketOpenNotChecked { reason });
            self.market_open = MarketOpenWatch::Settled;
        } else {
            let wait = (check.deadline.unix() - now.unix()).max(0) as u64;
            self.market_open = MarketOpenWatch::Waiting(Instant::now() + Duration::from_secs(wait));
        }
    }

    fn check_market_open_deadline(&mut self, now: Instant) {
        let (MarketOpenWatch::Waiting(at), Some(check)) = (self.market_open, self.settings.market_open_check) else { return };
        if at <= now {
            self.market_open = MarketOpenWatch::Settled;
            self.record(JournalEvent::MarketOpenMissing { deadline: kst_stamp(check.deadline) });
        }
    }

    fn publish_status(&self) {
        let keys: Vec<KeyStatus> = self.keys.iter().map(KeyRuntime::status).collect();
        let status = DaemonStatus { date: self.date, phase: self.phase, today: self.today(&keys), keys, alerts: self.alerts.clone(), ..DaemonStatus::default() };
        self.status.send_if_modified(|current| {
            let changed = *current != status;
            if changed {
                *current = status;
            }
            changed
        });
    }

    fn today(&self, statuses: &[KeyStatus]) -> Today {
        let stocks_in = |wanted: &[KeyState]| statuses.iter().filter(|status| wanted.contains(&status.state)).map(|status| status.stocks).sum();
        Today {
            planned_stocks: self.keys.iter().map(|key| key.own_stocks).sum(),
            receiving_stocks: stocks_in(&[KeyState::Receiving]),
            register_failed_batches: statuses.iter().map(|status| status.register_failures).sum(),
            disconnected_stocks: stocks_in(&[KeyState::Disconnected, KeyState::Stopped]),
            handed_off_stocks: self.keys.iter().filter(|key| key.handed_off).map(|key| key.own_stocks).sum(),
            excluded_stocks: self.plan.excluded.len(),
        }
    }

    fn next_deadline(&self) -> Instant {
        let mut earliest = self.housekeeping_at;
        if let MarketOpenWatch::Waiting(at) = self.market_open {
            earliest = earliest.min(at);
        }
        if let Some(at) = next_slot_deadline(&self.keys, self.settings.heartbeat_timeout) {
            earliest = earliest.min(at);
        }
        for key in &self.keys {
            if let Some(at) = key.issue_at {
                earliest = earliest.min(at);
            }
            if let Some(at) = key.reissue_at {
                earliest = earliest.min(at);
            }
        }
        earliest
    }

    fn on_timers(&mut self) {
        let now = Instant::now();
        self.check_market_open_deadline(now);
        for index in 0..self.keys.len() {
            match self.keys[index].slot.poll_timer(now, self.settings.heartbeat_timeout) {
                SlotTimer::Launch => self.launch(index),
                SlotTimer::HeartbeatLost(silent) => {
                    let key = self.name(index);
                    self.record(JournalEvent::HeartbeatLost { key, silent_secs: silent.as_secs() });
                    self.retire(index, None);
                }
                SlotTimer::Killed | SlotTimer::Nothing => {}
            }
            if self.keys[index].issue_at.is_some_and(|at| at <= now) {
                self.keys[index].issue_at = None;
                self.acquire_token(index);
            }
            if self.keys[index].reissue_at.is_some_and(|at| at <= now) {
                let wait = self.keys[index].tokens.wait_before_issue();
                if wait.is_zero() {
                    self.keys[index].reissue_at = None;
                    self.keys[index].tokens.mark_current_stale();
                    self.keys[index].sent_generation = None;
                    self.acquire_token(index);
                } else {
                    self.keys[index].reissue_at = Some(now + wait);
                }
            }
        }
        if self.housekeeping_at <= now {
            self.housekeeping_at = now + self.settings.housekeeping_every;
            tracing::info!("{}", self.status.borrow().summary());
            for index in 0..self.keys.len() {
                self.acquire_token(index);
            }
        }
    }

    fn on_control(&mut self, command: ControlCommand) {
        match command {
            ControlCommand::ReissueToken { key, at } => {
                let Some(index) = self.keys.iter().position(|runtime| runtime.name == key) else {
                    tracing::warn!(%key, "재발급할 키를 찾지 못했습니다");
                    return;
                };
                let wait = (at.unix() - self.clock.now().unix()).max(0) as u64;
                self.keys[index].reissue_at = Some(Instant::now() + Duration::from_secs(wait));
            }
            ControlCommand::EnterPhase(phase) => self.phase = phase,
        }
    }

    fn launch(&mut self, index: usize) {
        let name = self.name(index);
        match self.launcher.launch(&name) {
            Err(error) => {
                tracing::error!(key = %name, %error, "자식을 띄우지 못했습니다");
                self.record(JournalEvent::ChildRejected { key: name, reason: format!("띄우지 못했습니다: {error}") });
                self.child_gone(index, None);
            }
            Ok(spawned) => {
                let key = &mut self.keys[index];
                key.sent_generation = None;
                key.batches.clear();
                key.messages_per_second = None;
                key.receiving = false;
                key.down = false;
                let (pid, restarts) = key.slot.attach_spawned(spawned, Instant::now(), &self.inbox, move |incarnation, message| {
                    Inbound::Child { index, incarnation, message }
                });
                self.record(JournalEvent::ChildStarted { key: name, pid, restarts });
            }
        }
    }

    fn retire(&mut self, index: usize, stop: Option<StopReason>) {
        self.keys[index].slot.retire(stop, Instant::now(), self.settings.shutdown_grace);
    }

    fn child_gone(&mut self, index: usize, stop: Option<StopReason>) {
        match self.keys[index].slot.on_gone(stop, Instant::now(), &self.settings, StopReason::RestartLimit) {
            GoneOutcome::Stop(reason) => self.stop_key(index, reason),
            GoneOutcome::Backoff { restart, delay } => {
                let key = self.name(index);
                self.record(JournalEvent::Restart { key, restart, delay_secs: delay.as_secs() });
            }
        }
    }

    fn stop_key(&mut self, index: usize, reason: StopReason) {
        let key = self.name(index);
        tracing::error!(%key, "키를 멈춥니다: {reason}");
        self.keys[index].slot.stop();
        self.record(JournalEvent::KeyStopped { key, reason: reason.to_string() });
        if self.keys[index].role == KeyRole::Collecting {
            self.hand_off(index);
        }
    }

    fn hand_off(&mut self, from: usize) {
        let key = self.name(from);
        let skip = |this: &mut Supervisor, reason: String| {
            tracing::error!(%key, "인계하지 않습니다: {reason}");
            this.record(JournalEvent::HandoffSkipped { key: key.clone(), reason });
        };
        if self.keys[from].handoff_share.is_empty() {
            return skip(self, "그 키가 맡은 몫이 없습니다".to_owned());
        }
        if let Some(first) = self.handed {
            let first = self.name(first);
            return skip(self, format!("예비 키가 이미 {first}의 몫을 받았습니다. 이 키의 몫은 수집이 끊긴 채로 남습니다"));
        }
        let Some(to) = self.keys.iter().position(|runtime| runtime.role == KeyRole::Spare && runtime.slot.can_accept_work()) else {
            return skip(self, "받을 수 있는 예비 키가 없습니다".to_owned());
        };
        let receiver = self.name(to);
        if let Err(violation) = check_plan(&effective_plan(&self.plan, None)) {
            return skip(self, format!("인계 전 확인에서 계획이 틀렸습니다: {violation}"));
        }
        if let Err(violation) = check_plan(&effective_plan(&self.plan, Some((&key, &receiver)))) {
            return skip(self, format!("인계 뒤 계획이 틀립니다: {violation}"));
        }
        let Some(share) = self.plan.keys.iter().find(|share| share.name == key) else { return };
        let (stocks, market_types) = (share.stocks.clone(), share.market_types.clone());
        let moved = self.keys[from].handoff_share.clone();
        self.plan = effective_plan(&self.plan, Some((&key, &receiver)));
        self.keys[to].inherited_stocks = stocks.len();
        self.keys[to].inherited = moved;
        self.keys[from].handed_off = true;
        self.handed = Some(from);
        self.record(JournalEvent::Handoff { from: key, to: receiver, stocks, market_types });
        self.deliver_registrations(to);
    }

    fn deliver_registrations(&mut self, index: usize) {
        let key = &mut self.keys[index];
        if !key.slot.is_ready() {
            return;
        }
        let registrations: Vec<Registration> = if matches!(key.role, KeyRole::Spare) { key.inherited.clone() } else { key.own.clone() };
        for registration in registrations {
            key.slot.send_if_ready(&Command::Register(registration));
        }
    }

    fn deliver_token(&mut self, index: usize) {
        let key = &mut self.keys[index];
        if !key.slot.is_ready() {
            return;
        }
        let Some((token, generation)) = key.tokens.current() else { return };
        if key.sent_generation != Some(generation) {
            key.slot.send_if_ready(&Command::Token { token, generation, expires_at: None });
            key.sent_generation = Some(generation);
        }
    }

    fn acquire_token(&mut self, index: usize) {
        let key = &self.keys[index];
        if key.issuing || key.issue_at.is_some() || key.slot.is_stopped() {
            return;
        }
        if let Some(halted) = key.tokens.halted() {
            let reason = StopReason::Token(halted);
            if self.keys[index].slot.is_running() {
                self.retire(index, Some(reason));
            } else {
                self.stop_key(index, reason);
            }
            return;
        }
        if !key.tokens.needs_issue() {
            self.deliver_token(index);
            return;
        }
        let wait = key.tokens.wait_before_issue();
        if wait.is_zero() {
            self.spawn_issue(index);
        } else {
            self.keys[index].issue_at = Some(Instant::now() + wait);
        }
    }

    fn spawn_issue(&mut self, index: usize) {
        self.keys[index].issuing = true;
        let (tokens, lane, inbox) = (self.keys[index].tokens.clone(), self.lane.clone(), self.inbox.clone());
        tokio::spawn(async move {
            let issue = lane.issue(&tokens).await;
            let _ = inbox.send(Inbound::Issued { index, issue });
        });
    }

    fn on_inbound(&mut self, inbound: Inbound) {
        match inbound {
            Inbound::Issued { index, issue } => self.on_issued(index, issue),
            Inbound::Child { index, incarnation, message } => {
                if self.keys[index].slot.matches_incarnation(incarnation) {
                    self.on_child(index, message);
                }
            }
        }
    }

    fn on_issued(&mut self, index: usize, issue: Issue) {
        self.keys[index].issuing = false;
        match issue {
            Issue::Issued(generation) => {
                let key = self.name(index);
                self.record(JournalEvent::TokenIssued { key, generation });
                self.deliver_token(index);
            }
            Issue::Halted(halted) => {
                if !self.keys[index].slot.is_stopped() {
                    let reason = StopReason::Token(halted);
                    if self.keys[index].slot.is_running() {
                        self.retire(index, Some(reason));
                    } else {
                        self.stop_key(index, reason);
                    }
                }
            }
            Issue::Retry(wait) => {
                tracing::warn!(key = %self.keys[index].name, wait_secs = wait.as_secs(), "토큰을 받지 못해 나중에 다시 시도합니다");
                self.keys[index].issue_at = Some(Instant::now() + wait);
            }
        }
    }

    fn on_child(&mut self, index: usize, message: ChildMessage) {
        let key = self.name(index);
        match message {
            ChildMessage::Exited(code) => {
                let Some(stop) = self.keys[index].slot.take_exit() else { return };
                self.record(JournalEvent::ChildExited { key, code });
                self.child_gone(index, stop);
            }
            ChildMessage::BadLine(error) => {
                let version = matches!(error, ProtocolError::Version(_));
                tracing::error!(%key, %error, "자식이 프로토콜에 맞지 않는 줄을 보냈습니다");
                self.record(JournalEvent::ChildRejected { key, reason: error.to_string() });
                self.retire(index, version.then_some(StopReason::VersionMismatch));
            }
            ChildMessage::Event(event) => self.on_event(index, event),
        }
    }

    fn on_event(&mut self, index: usize, event: Event) {
        let key = self.name(index);
        match event {
            Event::Hello { key: said, .. } if said != key => {
                self.record(JournalEvent::ChildRejected { key: key.clone(), reason: format!("hello가 다른 키({said})를 말합니다") });
                self.retire(index, None);
            }
            Event::Hello { .. } => {
                self.keys[index].slot.mark_hello(Instant::now());
                self.deliver_registrations(index);
                self.acquire_token(index);
            }
            Event::Heartbeat { frames, state, .. } => {
                let runtime = &mut self.keys[index];
                runtime.slot.touch(Instant::now());
                runtime.receiving = state == SessionState::Live;
                runtime.down = runtime.down && !runtime.receiving;
                runtime.messages_per_second = Some(frames as f64 / HEARTBEAT_EVERY.as_secs_f64());
            }
            Event::Registered { batch, ok, rejection, .. } => {
                let triple = (batch.id.clone(), batch.part, batch.parts);
                let was_failed = self.keys[index].batches.insert(triple, ok) == Some(false);
                if let (false, false, Some(rejection)) = (ok, was_failed, rejection) {
                    self.record(JournalEvent::RegisterFailed {
                        key,
                        id: batch.id,
                        part: batch.part,
                        parts: batch.parts,
                        items: batch.items,
                        reason: rejection.reason,
                        return_code: rejection.return_code,
                        detail: rejection.detail,
                    });
                }
            }
            Event::Unregistered { .. } => {}
            Event::MarketOpen { .. } => {
                if let (MarketOpenWatch::Waiting(_), Some(check)) = (self.market_open, self.settings.market_open_check) {
                    self.market_open = MarketOpenWatch::Settled;
                    self.record(JournalEvent::MarketOpenSeen { key, deadline: kst_stamp(check.deadline) });
                }
            }
            Event::Live => {
                self.keys[index].receiving = true;
                self.keys[index].down = false;
            }
            Event::Down { reason } => {
                tracing::warn!(%key, %reason, "자식이 연결 끊김을 알렸습니다");
                self.keys[index].receiving = false;
                self.keys[index].down = true;
            }
            Event::TokenInvalid { generation } => {
                self.record(JournalEvent::TokenInvalid { key, generation });
                self.keys[index].tokens.invalidate(generation);
                self.keys[index].sent_generation = None;
                self.acquire_token(index);
            }
            Event::Usage { .. } | Event::JobStats { .. } => {}
            Event::Halted { reason, action } => {
                tracing::error!(%key, %reason, %action, "자식이 멈췄다고 알렸습니다");
            }
        }
    }

    async fn shut_down(&mut self) {
        let mut exited = Vec::new();
        shut_down_slots(
            &mut self.keys,
            &mut self.inbox_source,
            |inbound| match inbound {
                Inbound::Child { index, incarnation, message: ChildMessage::Exited(code) } => Some((index, incarnation, code)),
                _ => None,
            },
            self.settings.shutdown_grace,
            |key, code| exited.push((key, code)),
            "끝나지 않은 자식이 남았지만 기다리지 않고 데몬을 끝냅니다",
        )
        .await;
        for (key, code) in exited {
            self.record(JournalEvent::ChildExited { key, code });
        }
    }
}

fn plan_alerts(plan: &PlanFile) -> Vec<Alert> {
    let at = plan.created_at.clone();
    let excluded = (!plan.excluded.is_empty()).then(|| Alert { at: at.clone(), kind: AlertKind::Excluded, message: format!("키 용량이 모자라 {}종목을 수집에서 제외했습니다", plan.excluded.len()) });
    let notes = plan.alerts.iter().map(|note| Alert { at: at.clone(), kind: AlertKind::PlanNote, message: note.clone() });
    excluded.into_iter().chain(notes).collect()
}

fn alert_of(event: &JournalEvent) -> Option<(AlertKind, String)> {
    match event {
        JournalEvent::Handoff { from, to, stocks, .. } => Some((AlertKind::Handoff, format!("{from}의 {}종목을 {to}에 인계했습니다", stocks.len()))),
        JournalEvent::HandoffSkipped { key, reason } => Some((AlertKind::HandoffSkipped, format!("{key}의 몫을 인계하지 않았습니다: {reason}"))),
        JournalEvent::KeyStopped { key, reason } => Some((AlertKind::KeyStopped, format!("{key}를 멈췄습니다: {reason}"))),
        JournalEvent::RegisterFailed { key, id, part, parts, reason, .. } => Some((AlertKind::RegisterFailed, format!("{key}의 등록 {id} {part}/{parts}번이 실패했습니다: {reason}"))),
        JournalEvent::MarketOpenMissing { deadline } => Some((AlertKind::MarketOpenMissing, format!("관측일인데 {deadline}까지 0s가 오지 않았습니다"))),
        _ => None,
    }
}
