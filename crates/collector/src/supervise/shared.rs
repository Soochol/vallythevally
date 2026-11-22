use std::collections::BTreeSet;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use domain::{KstDate, KstTime};
use server::clock::Clock;
use server::config::{KisCredentials, Secret};
use server::instance::{InstanceLock, LockError};
use server::kiwoom::transport::Transport;
use server::kis::auth::{AuthError, KisAuth, TokenGen as KisTokenGen};
use server::kis::transport::Transport as KisTransport;
use server::shared_data::Broker;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep_until};

use super::journal::{Journal, JournalEvent, journal_path, kst_stamp};
use super::process::{ChildMessage, ChildProcess, Launcher, SharedLaunch};
use super::settings::Settings;
use super::status::{Alert, AlertKind, KeyState, KeyStatus, KeyUsage, RestProgress};
use super::tokens::{Halted, Issue, IssueLane, KeyTokens};
use crate::keys::{ActiveKey, KeyRole};
use crate::protocol::{Command, Event, KeyName, ProtocolError, SessionState};
use crate::shared::{AssignedJob, Assignment, JobStat, UsageLog, UsageMinute};

const ALERT_LIMIT: usize = 100;
const HASH_PREFIX_LEN: usize = 8;
const KIS_RETRY: Duration = Duration::from_secs(60);

pub struct SharedInputs {
    pub keys: Vec<ActiveKey>,
    pub assignment: Assignment,
    pub date: u32,
    pub data_dir: PathBuf,
    pub settings: Settings,
}

pub struct SharedInjected {
    pub launcher: Arc<dyn Launcher>,
    pub transport: Arc<dyn Transport>,
    pub kis_transport: Option<Arc<dyn KisTransport>>,
    pub clock: Clock,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SharedReport {
    pub keys: Vec<KeyStatus>,
    pub alerts: Vec<Alert>,
}

#[derive(Debug)]
pub enum SharedStartError {
    Lock { key: KeyName, error: LockError },
    Journal(io::Error),
    KisTransportMissing(KeyName),
    KeyMissing(KeyName),
}

impl std::fmt::Display for SharedStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SharedStartError::Lock { key, error } => write!(formatter, "키 {key}의 잠금을 잡지 못했습니다: {error}"),
            SharedStartError::Journal(error) => write!(formatter, "사건 기록 파일을 열 수 없습니다: {error}"),
            SharedStartError::KisTransportMissing(key) => write!(formatter, "한투 키 {key}를 쓰려면 한투 transport가 있어야 합니다"),
            SharedStartError::KeyMissing(key) => write!(formatter, "배정표의 키 {key}가 rest 키 목록에 없습니다"),
        }
    }
}

impl std::error::Error for SharedStartError {}

enum TokenOutcome {
    Ready { token: Secret<String>, generation: u64, expires_at: Option<i64> },
    Retry(Duration),
    Halted(String),
}

enum RestTokens {
    Kiwoom(KeyTokens),
    Kis { auth: KisAuth, _lock: InstanceLock },
}

impl RestTokens {
    fn open(key: &ActiveKey, transport: &Arc<dyn Transport>, kis: Option<&Arc<dyn KisTransport>>, clock: &Clock) -> Result<RestTokens, SharedStartError> {
        let lock_error = |error| SharedStartError::Lock { key: key.identity.name.clone(), error };
        match key.broker {
            Broker::Kiwoom => KeyTokens::open(key, transport.clone(), clock.clone()).map(RestTokens::Kiwoom).map_err(lock_error),
            Broker::Kis => {
                let transport = kis.ok_or_else(|| SharedStartError::KisTransportMissing(key.identity.name.clone()))?;
                let lock = InstanceLock::acquire(&key.lock_path).map_err(lock_error)?;
                let credentials = KisCredentials { app_key: key.app_key.clone(), app_secret: key.app_secret.clone() };
                Ok(RestTokens::Kis { auth: KisAuth::new(credentials, key.token_path.clone(), transport.clone(), clock.clone()), _lock: lock })
            }
        }
    }

    async fn ensure(&self, lane: &IssueLane) -> TokenOutcome {
        match self {
            RestTokens::Kiwoom(tokens) => loop {
                if let Some(halted) = tokens.halted() {
                    return TokenOutcome::Halted(halted_text(&halted));
                }
                if !tokens.needs_issue() {
                    let Some((token, generation)) = tokens.current() else { return TokenOutcome::Retry(KIS_RETRY) };
                    return TokenOutcome::Ready { token, generation, expires_at: tokens.expires_at() };
                }
                match lane.issue(tokens).await {
                    Issue::Issued(_) => continue,
                    Issue::Halted(halted) => return TokenOutcome::Halted(halted_text(&halted)),
                    Issue::Retry(wait) => return TokenOutcome::Retry(wait),
                }
            },
            RestTokens::Kis { auth, .. } => match auth.token().await {
                Ok(lease) => TokenOutcome::Ready { token: lease.token, generation: lease.generation.0, expires_at: auth.token_expires_at().map(|at| at.unix()) },
                Err(error @ (AuthError::Halted(_) | AuthError::Failed(_))) => TokenOutcome::Halted(error.to_string()),
                Err(AuthError::IssueInterval { .. } | AuthError::NotRecorded(_) | AuthError::Transport(_) | AuthError::BadResponse) => TokenOutcome::Retry(KIS_RETRY),
            },
        }
    }

    fn invalidate(&self, generation: u64) {
        match self {
            RestTokens::Kiwoom(tokens) => tokens.invalidate(generation),
            RestTokens::Kis { auth, .. } => auth.invalidate(KisTokenGen(generation)),
        }
    }
}

fn halted_text(halted: &Halted) -> String {
    if halted.is_8050 { format!("8050을 받았습니다: {}", halted.text) } else { format!("토큰을 받을 수 없습니다: {}", halted.text) }
}

struct Running {
    process: Box<dyn ChildProcess>,
    last_heard: Instant,
    said_hello: bool,
    live: bool,
    retiring: Option<Retiring>,
}

struct Retiring {
    stop: Option<String>,
    kill_at: Instant,
    killed: bool,
}

enum Phase {
    Backoff { until: Instant },
    Running(Running),
    Stopped,
}

struct RestKey {
    name: KeyName,
    broker: Broker,
    hash_prefix: String,
    total_per_second: Option<u32>,
    tokens: Arc<RestTokens>,
    phase: Phase,
    restarts: u32,
    incarnation: u64,
    sent_generation: Option<u64>,
    sent_jobs: Option<Vec<AssignedJob>>,
    issuing: bool,
    issue_at: Option<Instant>,
    usage: Option<UsageMinute>,
    jobs: Vec<JobStat>,
    assigned_job_count: usize,
}

enum Inbound {
    Child { index: usize, incarnation: u64, message: ChildMessage },
    Token { index: usize, outcome: TokenOutcome },
}

pub struct SharedSupervisor {
    date: u32,
    day: KstDate,
    data_dir: PathBuf,
    assignment: Assignment,
    settings: Settings,
    keys: Vec<RestKey>,
    down: BTreeSet<KeyName>,
    launcher: Arc<dyn Launcher>,
    clock: Clock,
    lane: Arc<IssueLane>,
    journal: Journal,
    usage_log: UsageLog,
    inbox: mpsc::UnboundedSender<Inbound>,
    inbox_source: mpsc::UnboundedReceiver<Inbound>,
    report: watch::Sender<SharedReport>,
    alerts: Vec<Alert>,
}

impl SharedSupervisor {
    pub fn start(inputs: SharedInputs, injected: SharedInjected) -> Result<SharedSupervisor, SharedStartError> {
        let SharedInputs { keys, assignment, date, data_dir, settings } = inputs;
        let day = KstDate::parse_yyyymmdd(&date.to_string()).expect("날짜는 달력에 있다");
        let journal = Journal::open(journal_path(&data_dir, date)).map_err(SharedStartError::Journal)?;
        let mut runtimes = Vec::new();
        for name in assignment.keys_in_use() {
            let key = keys.iter().find(|key| key.identity.name == name && key.identity.role == KeyRole::Rest).ok_or_else(|| SharedStartError::KeyMissing(name.clone()))?;
            let tokens = RestTokens::open(key, &injected.transport, injected.kis_transport.as_ref(), &injected.clock)?;
            runtimes.push(RestKey {
                name,
                broker: key.broker,
                hash_prefix: key.identity.app_key_hash.strip_prefix("sha256:").unwrap_or(&key.identity.app_key_hash).chars().take(HASH_PREFIX_LEN).collect(),
                total_per_second: assignment.total_per_second(&key.identity.name),
                tokens: Arc::new(tokens),
                phase: Phase::Backoff { until: Instant::now() },
                restarts: 0,
                incarnation: 0,
                sent_generation: None,
                sent_jobs: None,
                issuing: false,
                issue_at: None,
                usage: None,
                jobs: Vec::new(),
                assigned_job_count: 0,
            });
        }
        let (inbox, inbox_source) = mpsc::unbounded_channel();
        let lane = Arc::new(IssueLane::new(settings.token_spacing));
        Ok(SharedSupervisor {
            date,
            day,
            usage_log: UsageLog::new(data_dir.clone()),
            data_dir,
            assignment,
            settings,
            keys: runtimes,
            down: BTreeSet::new(),
            launcher: injected.launcher,
            clock: injected.clock,
            lane,
            journal,
            inbox,
            inbox_source,
            report: watch::channel(SharedReport::default()).0,
            alerts: Vec::new(),
        })
    }

    pub fn report(&self) -> watch::Receiver<SharedReport> {
        self.report.subscribe()
    }

    fn name(&self, index: usize) -> KeyName {
        self.keys[index].name.clone()
    }

    fn record(&mut self, event: JournalEvent) {
        self.journal.append(self.clock.now(), &event);
    }

    fn alert(&mut self, kind: AlertKind, message: String) {
        tracing::warn!(?kind, %message, "공용 자료 경보");
        self.alerts.push(Alert { at: kst_stamp(self.clock.now()), kind, message });
        self.alerts.drain(..self.alerts.len().saturating_sub(ALERT_LIMIT));
    }

    fn end_instant(&self) -> Option<Instant> {
        let end = KstTime::from_kst_civil(self.day, self.settings.end_at?);
        Some(Instant::now() + Duration::from_secs((end.unix() - self.clock.now().unix()).max(0) as u64))
    }

    pub async fn run(mut self, mut shutdown: watch::Receiver<bool>) {
        let _ = self.date;
        let _ = &self.data_dir;
        let end = self.end_instant();
        let mut housekeeping_at = Instant::now() + self.settings.housekeeping_every;
        self.publish();
        loop {
            let wake = self.next_deadline().min(housekeeping_at);
            tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
                Some(inbound) = self.inbox_source.recv() => self.on_inbound(inbound),
                () = sleep_until(wake) => {
                    self.on_timers();
                    if housekeeping_at <= Instant::now() {
                        housekeeping_at = Instant::now() + self.settings.housekeeping_every;
                        for index in 0..self.keys.len() {
                            self.acquire_token(index);
                        }
                    }
                }
                () = sleep_until_option(end) => break,
            }
            self.publish();
        }
        self.shut_down().await;
        self.publish();
    }

    fn next_deadline(&self) -> Instant {
        let mut deadlines = Vec::new();
        for key in &self.keys {
            match &key.phase {
                Phase::Backoff { until } => deadlines.push(*until),
                Phase::Running(running) => match &running.retiring {
                    Some(retiring) if !retiring.killed => deadlines.push(retiring.kill_at),
                    Some(_) => {}
                    None => deadlines.push(running.last_heard + self.settings.heartbeat_timeout),
                },
                Phase::Stopped => {}
            }
            deadlines.extend(key.issue_at);
        }
        deadlines.into_iter().min().unwrap_or_else(|| Instant::now() + self.settings.housekeeping_every)
    }

    fn on_timers(&mut self) {
        let now = Instant::now();
        for index in 0..self.keys.len() {
            enum Due {
                Launch,
                Silent(Duration),
                Kill,
                Nothing,
            }
            let due = match &self.keys[index].phase {
                Phase::Backoff { until } if *until <= now => Due::Launch,
                Phase::Running(running) => match &running.retiring {
                    Some(retiring) if !retiring.killed && retiring.kill_at <= now => Due::Kill,
                    None if running.last_heard + self.settings.heartbeat_timeout <= now => Due::Silent(now - running.last_heard),
                    _ => Due::Nothing,
                },
                _ => Due::Nothing,
            };
            match due {
                Due::Launch => self.launch(index),
                Due::Silent(silent) => {
                    let key = self.name(index);
                    self.record(JournalEvent::HeartbeatLost { key, silent_secs: silent.as_secs() });
                    self.retire(index, None);
                }
                Due::Kill => {
                    if let Phase::Running(running) = &mut self.keys[index].phase {
                        running.process.kill();
                        if let Some(retiring) = &mut running.retiring {
                            retiring.killed = true;
                        }
                    }
                }
                Due::Nothing => {}
            }
            if self.keys[index].issue_at.is_some_and(|at| at <= now) {
                self.keys[index].issue_at = None;
                self.acquire_token(index);
            }
        }
    }

    fn launch(&mut self, index: usize) {
        let name = self.name(index);
        let launch = SharedLaunch { broker: self.keys[index].broker, total_per_second: self.keys[index].total_per_second };
        match self.launcher.launch_shared(&name, &launch) {
            Err(error) => {
                tracing::error!(key = %name, %error, "공용 자료 자식을 띄우지 못했습니다");
                self.record(JournalEvent::ChildRejected { key: name, reason: format!("띄우지 못했습니다: {error}") });
                self.child_gone(index, None);
            }
            Ok(mut spawned) => {
                let key = &mut self.keys[index];
                key.incarnation += 1;
                key.sent_generation = None;
                key.sent_jobs = None;
                let incarnation = key.incarnation;
                let restarts = key.restarts;
                key.phase = Phase::Running(Running { process: spawned.process, last_heard: Instant::now(), said_hello: false, live: false, retiring: None });
                let inbox = self.inbox.clone();
                tokio::spawn(async move {
                    while let Some(message) = spawned.messages.recv().await {
                        if inbox.send(Inbound::Child { index, incarnation, message }).is_err() {
                            return;
                        }
                    }
                });
                self.record(JournalEvent::ChildStarted { key: name, pid: spawned.pid, restarts });
            }
        }
    }

    fn retire(&mut self, index: usize, stop: Option<String>) {
        let grace = self.settings.shutdown_grace;
        let Phase::Running(running) = &mut self.keys[index].phase else { return };
        match &mut running.retiring {
            None => {
                running.process.terminate();
                running.retiring = Some(Retiring { stop, kill_at: Instant::now() + grace, killed: false });
            }
            Some(retiring) if retiring.stop.is_none() => retiring.stop = stop,
            Some(_) => {}
        }
    }

    fn child_gone(&mut self, index: usize, stop: Option<String>) {
        match stop {
            Some(reason) => self.stop_key(index, reason),
            None if self.keys[index].restarts >= self.settings.restart_limit => self.stop_key(index, "그날 재시작 한도를 넘었습니다".to_owned()),
            None => {
                let delay = self.settings.restart_delay(self.keys[index].restarts);
                self.keys[index].restarts += 1;
                let (key, restart) = (self.name(index), self.keys[index].restarts);
                self.record(JournalEvent::Restart { key, restart, delay_secs: delay.as_secs() });
                self.keys[index].phase = Phase::Backoff { until: Instant::now() + delay };
            }
        }
    }

    fn stop_key(&mut self, index: usize, reason: String) {
        let key = self.name(index);
        tracing::error!(%key, %reason, "공용 자료 키를 멈춥니다");
        self.keys[index].phase = Phase::Stopped;
        self.record(JournalEvent::KeyStopped { key: key.clone(), reason: reason.clone() });
        self.alert(AlertKind::KeyStopped, format!("{key}를 멈췄습니다: {reason}"));
        let owned: Vec<_> = self.assignment.jobs_of(&self.down).remove(&key).unwrap_or_default();
        self.down.insert(key.clone());
        for assigned in owned {
            let to = self.assignment.next_key_of(assigned.job, &key, &self.down);
            self.record(JournalEvent::SharedJobMoved { job: assigned.job, from: key.clone(), to: to.clone() });
            match to {
                Some(to) => self.alert(AlertKind::SharedJobMoved, format!("{key}의 일 {:?}을 {to}로 옮깁니다", assigned.job)),
                None => self.alert(AlertKind::SharedJobMoved, format!("{key}의 일 {:?}을 이어받을 키가 없어 멈춥니다", assigned.job)),
            }
        }
        for index in 0..self.keys.len() {
            self.deliver_jobs(index);
        }
    }

    fn acquire_token(&mut self, index: usize) {
        let key = &self.keys[index];
        if key.issuing || key.issue_at.is_some() || matches!(key.phase, Phase::Stopped) {
            return;
        }
        self.keys[index].issuing = true;
        let (tokens, lane, inbox) = (self.keys[index].tokens.clone(), self.lane.clone(), self.inbox.clone());
        tokio::spawn(async move {
            let outcome = tokens.ensure(&lane).await;
            let _ = inbox.send(Inbound::Token { index, outcome });
        });
    }

    fn on_inbound(&mut self, inbound: Inbound) {
        match inbound {
            Inbound::Token { index, outcome } => self.on_token(index, outcome),
            Inbound::Child { index, incarnation, message } => {
                if matches!(self.keys[index].phase, Phase::Running(_)) && self.keys[index].incarnation == incarnation {
                    self.on_child(index, message);
                }
            }
        }
    }

    fn on_token(&mut self, index: usize, outcome: TokenOutcome) {
        self.keys[index].issuing = false;
        match outcome {
            TokenOutcome::Ready { token, generation, expires_at } => {
                let key = self.name(index);
                self.record(JournalEvent::TokenIssued { key, generation });
                self.deliver_token(index, token, generation, expires_at);
            }
            TokenOutcome::Retry(wait) => {
                tracing::warn!(key = %self.keys[index].name, wait_secs = wait.as_secs(), "토큰을 받지 못해 나중에 다시 시도합니다");
                self.keys[index].issue_at = Some(Instant::now() + wait);
            }
            TokenOutcome::Halted(reason) => match &self.keys[index].phase {
                Phase::Stopped => {}
                Phase::Running(_) => self.retire(index, Some(reason)),
                Phase::Backoff { .. } => self.stop_key(index, reason),
            },
        }
    }

    fn deliver_token(&mut self, index: usize, token: Secret<String>, generation: u64, expires_at: Option<i64>) {
        let key = &mut self.keys[index];
        let Phase::Running(running) = &mut key.phase else { return };
        if !running.said_hello || key.sent_generation == Some(generation) {
            return;
        }
        running.process.send(&Command::Token { token, generation, expires_at });
        key.sent_generation = Some(generation);
        self.deliver_jobs(index);
    }

    fn deliver_jobs(&mut self, index: usize) {
        let mut wanted = self.assignment.jobs_of(&self.down).remove(&self.keys[index].name).unwrap_or_default();
        wanted.sort_by_key(|job| job.job);
        let date = self.date;
        let key = &mut self.keys[index];
        key.assigned_job_count = wanted.len();
        let Phase::Running(running) = &mut key.phase else { return };
        if key.sent_generation.is_none() || key.sent_jobs.as_ref() == Some(&wanted) {
            return;
        }
        running.process.send(&Command::Assign { date, jobs: wanted.clone() });
        key.sent_jobs = Some(wanted);
    }

    fn on_child(&mut self, index: usize, message: ChildMessage) {
        let key = self.name(index);
        match message {
            ChildMessage::Exited(code) => {
                let Phase::Running(running) = std::mem::replace(&mut self.keys[index].phase, Phase::Stopped) else { return };
                self.record(JournalEvent::ChildExited { key, code });
                self.child_gone(index, running.retiring.and_then(|retiring| retiring.stop));
            }
            ChildMessage::BadLine(error) => {
                let version = matches!(error, ProtocolError::Version(_));
                tracing::error!(%key, %error, "공용 자료 자식이 프로토콜에 맞지 않는 줄을 보냈습니다");
                self.record(JournalEvent::ChildRejected { key, reason: error.to_string() });
                self.retire(index, version.then(|| "자식의 프로토콜 버전이 데몬과 다릅니다".to_owned()));
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
                if let Phase::Running(running) = &mut self.keys[index].phase {
                    running.said_hello = true;
                    running.last_heard = Instant::now();
                }
                self.acquire_token(index);
            }
            Event::Heartbeat { state, .. } => {
                if let Phase::Running(running) = &mut self.keys[index].phase {
                    running.last_heard = Instant::now();
                    running.live = state == SessionState::Live;
                }
            }
            Event::TokenInvalid { generation } => {
                self.record(JournalEvent::TokenInvalid { key, generation });
                self.keys[index].tokens.invalidate(generation);
                self.keys[index].sent_generation = None;
                self.acquire_token(index);
            }
            Event::Usage { minute_start, key_max_per_second, trs } => {
                let minute = UsageMinute { minute_start, key_max_per_second, trs };
                if let Err(error) = self.usage_log.append(&key, self.keys[index].broker, &minute) {
                    tracing::error!(%key, %error, "사용량 줄을 쓰지 못했습니다");
                }
                self.keys[index].usage = Some(minute);
            }
            Event::JobStats { jobs } => {
                for stat in &jobs {
                    if stat.overruns > self.keys[index].jobs.iter().find(|before| before.job == stat.job).map_or(0, |before| before.overruns) {
                        tracing::warn!(%key, job = ?stat.job, overruns = stat.overruns, "일 한 번이 주기를 넘었습니다");
                    }
                }
                self.keys[index].jobs = jobs;
            }
            Event::Halted { reason, action } => tracing::error!(%key, %reason, %action, "공용 자료 자식이 멈췄다고 알렸습니다"),
            Event::Registered { .. } | Event::Unregistered { .. } | Event::Live | Event::Down { .. } | Event::MarketOpen { .. } => {}
        }
    }

    fn state_of(key: &RestKey) -> KeyState {
        match &key.phase {
            Phase::Stopped => KeyState::Stopped,
            Phase::Backoff { .. } if key.incarnation > 0 => KeyState::Disconnected,
            Phase::Backoff { .. } => KeyState::Waiting,
            Phase::Running(running) if running.retiring.is_some() => KeyState::Disconnected,
            Phase::Running(running) if running.live => KeyState::Receiving,
            Phase::Running(_) if key.sent_generation.is_none() => KeyState::Waiting,
            Phase::Running(_) => KeyState::Connecting,
        }
    }

    fn publish(&self) {
        let keys = self
            .keys
            .iter()
            .map(|key| KeyStatus {
                name: key.name.clone(),
                app_key_hash_prefix: key.hash_prefix.clone(),
                role: KeyRole::Rest,
                state: Self::state_of(key),
                stocks: 0,
                messages_per_second: None,
                register_failures: 0,
                restarts: key.restarts,
                rest: RestProgress { planned_jobs: key.assigned_job_count, finished_jobs: key.jobs.iter().map(|job| job.runs as usize).sum() },
                usage: key.usage.as_ref().map(|minute| KeyUsage { minute_start: minute.minute_start, key_max_per_second: minute.key_max_per_second, trs: minute.trs.clone() }),
            })
            .collect();
        let report = SharedReport { keys, alerts: self.alerts.clone() };
        self.report.send_if_modified(|current| {
            let changed = *current != report;
            if changed {
                *current = report;
            }
            changed
        });
    }

    async fn shut_down(&mut self) {
        for key in &mut self.keys {
            if let Phase::Running(running) = &mut key.phase {
                running.process.send(&Command::Shutdown);
            }
        }
        let mut stage = 0;
        let mut deadline = Instant::now() + self.settings.shutdown_grace;
        while self.keys.iter().any(|key| matches!(key.phase, Phase::Running(_))) {
            tokio::select! {
                Some(inbound) = self.inbox_source.recv() => {
                    if let Inbound::Child { index, incarnation, message: ChildMessage::Exited(code) } = inbound
                        && self.keys[index].incarnation == incarnation
                        && matches!(self.keys[index].phase, Phase::Running(_))
                    {
                        let key = self.name(index);
                        self.keys[index].phase = Phase::Stopped;
                        self.record(JournalEvent::ChildExited { key, code });
                    }
                }
                () = sleep_until(deadline) => {
                    stage += 1;
                    deadline = Instant::now() + self.settings.shutdown_grace;
                    for key in &mut self.keys {
                        if let Phase::Running(running) = &mut key.phase {
                            match stage {
                                1 => running.process.terminate(),
                                2 => running.process.kill(),
                                _ => {}
                            }
                        }
                    }
                    if stage > 2 {
                        tracing::error!("끝나지 않은 공용 자료 자식이 남았지만 기다리지 않고 끝냅니다");
                        return;
                    }
                }
            }
        }
    }
}

async fn sleep_until_option(at: Option<Instant>) {
    match at {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}
