use std::io;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use domain::{KstDate, KstTime};
use server::api::KiwoomEnvironment;
use server::clock::Clock;
use server::config::KisCredentials;
use server::kis::auth::{Halt as KisHalt, KisAuth, TokenGen as KisTokenGen};
use server::kis::rest::KisRest;
use server::kis::transport::{ReqwestTransport as KisReqwestTransport, Transport as KisTransport};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{ReqwestTransport, Transport};
use server::kiwoom::wire::TokenResponse;
use server::shared_data::Broker;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use super::assignment::AssignedJob;
use super::job::{Market, Slice};
use super::runner::{JobLoop, LoopStats};
use super::usage::UsagePoller;
use super::JobName;
use crate::args::{ArgSpec, Arguments};
use crate::collect::child::{ParentWatch, die_with_parent, read_commands, write_events};
use crate::collect::config::process_variables;
use crate::collect::link::{Commands, Events, Incoming};
use crate::collect::start::{forward_termination_signals, init_logging};
use crate::protocol::{Command, Event, HEARTBEAT_EVERY, KeyName, SessionState};
use crate::supervise::{kis_base_url, rest_base_url};

const USAGE_POLL: Duration = Duration::from_secs(5);
const STATS_EVERY: Duration = Duration::from_secs(60);
const WATCH_EVERY: Duration = Duration::from_secs(1);
const TOKEN_LIFETIME_WHEN_UNSTATED_SECS: i64 = 12 * 3600;

pub struct SharedParts {
    pub key: KeyName,
    pub broker: Broker,
    pub shared_dir: PathBuf,
    pub transport: Arc<dyn Transport>,
    pub kis_transport: Option<Arc<dyn KisTransport>>,
    pub clock: Clock,
    pub total_per_second: Option<u32>,
    pub commands: Commands,
    pub events: Events,
    pub shutdown: watch::Receiver<bool>,
}

struct Running {
    tasks: Vec<JoinHandle<()>>,
    stats: Vec<(JobName, Arc<LoopStats>)>,
}

impl Running {
    fn stop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
        self.stats.clear();
    }
}

fn expires_dt(at: KstTime) -> String {
    let seconds = at.kst_time_of_day().secs();
    format!("{}{:02}{:02}{:02}", at.kst_date().yyyymmdd(), seconds / 3600, seconds / 60 % 60, seconds % 60)
}

fn kis_halt_reason(halt: &KisHalt) -> String {
    match halt {
        KisHalt::Rejected(failure) => failure.to_string(),
        KisHalt::TokenFileUnreadable(error) => format!("한투 토큰 파일: {error}"),
    }
}

pub async fn run_shared(parts: SharedParts) {
    let SharedParts { key, broker, shared_dir, transport, kis_transport, clock, total_per_second, mut commands, events, mut shutdown } = parts;
    let auth = KiwoomAuth::keyless(None);
    let rest = KiwoomRest::with_total_per_second(transport, auth, clock.clone(), KiwoomEnvironment::Real, total_per_second);
    let kis_rest = match (broker, kis_transport) {
        (Broker::Kis, Some(kis_transport)) => Some(KisRest::new(kis_transport, KisAuth::supplied(clock.clone()))),
        _ => None,
    };
    events.emit(Event::Hello { key: key.clone(), pid: std::process::id() });
    let mut heartbeat = interval_at(Instant::now() + HEARTBEAT_EVERY, HEARTBEAT_EVERY);
    let mut poll = interval_at(Instant::now() + USAGE_POLL, USAGE_POLL);
    let mut stats_tick = interval_at(Instant::now() + STATS_EVERY, STATS_EVERY);
    let mut watch_tick = interval_at(Instant::now() + WATCH_EVERY, WATCH_EVERY);
    for tick in [&mut heartbeat, &mut poll, &mut stats_tick, &mut watch_tick] {
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    }
    let mut usage = UsagePoller::default();
    let mut running = Running { tasks: Vec::new(), stats: Vec::new() };
    let mut supplied_generation: Option<u64> = None;
    let mut reported_invalid: Option<u64> = None;
    let mut reported_halt = false;
    loop {
        tokio::select! {
            _ = shutdown.wait_for(|stop| *stop) => break,
            incoming = commands.recv() => match incoming {
                None | Some(Ok(Command::Shutdown)) => break,
                Some(Err(error)) => tracing::warn!(%key, %error, "읽을 수 없는 명령을 건너뜁니다"),
                Some(Ok(Command::Token { token, generation, expires_at, app_key, app_secret })) => {
                    let now = clock.now();
                    let expires = expires_at.map_or_else(|| now.plus_secs(TOKEN_LIFETIME_WHEN_UNSTATED_SECS), KstTime::from_unix);
                    match broker {
                        Broker::Kiwoom => {
                            let issued = rest.auth().record_issued(TokenResponse { token: token.expose().clone(), expires_dt: expires_dt(expires) }, now);
                            match issued {
                                Ok(_) => {
                                    supplied_generation = Some(generation);
                                    reported_invalid = None;
                                }
                                Err(error) => tracing::error!(%key, ?error, "받은 토큰을 쓰지 못했습니다"),
                            }
                        }
                        Broker::Kis => match (&kis_rest, app_key, app_secret) {
                            (Some(kis_rest), Some(app_key), Some(app_secret)) => {
                                match kis_rest.auth().record_supplied(KisCredentials { app_key, app_secret }, token, KisTokenGen(generation), now, expires) {
                                    Ok(()) => {
                                        supplied_generation = Some(generation);
                                        reported_invalid = None;
                                        reported_halt = false;
                                    }
                                    Err(error) => tracing::error!(%key, %error, "받은 한투 토큰을 쓰지 못했습니다"),
                                }
                            }
                            (None, _, _) => tracing::error!(%key, "한투 세션이 없어 받은 토큰을 쓰지 못했습니다"),
                            (_, None, _) | (_, _, None) => tracing::error!(%key, "한투 앱키와 시크릿이 없어 받은 토큰을 쓰지 못했습니다"),
                        },
                    }
                }
                Some(Ok(Command::Assign { date, jobs })) => {
                    running.stop();
                    let Some(day) = KstDate::parse_yyyymmdd(&date.to_string()) else {
                        tracing::error!(%key, date, "배정의 날짜를 읽지 못했습니다");
                        continue;
                    };
                    for job in jobs {
                        let stats = Arc::new(LoopStats::default());
                        running.stats.push((job.job, stats.clone()));
                        running.tasks.push(tokio::spawn(JobTask { assigned: job, day, broker, rest: rest.clone(), kis_rest: kis_rest.clone(), key: key.clone(), shared_dir: shared_dir.clone(), clock: clock.clone(), stats }.run()));
                    }
                }
                Some(Ok(Command::Register(_) | Command::Unregister(_))) => tracing::warn!(%key, "공용 자료 자식은 등록 명령을 받지 않습니다"),
            },
            _ = heartbeat.tick() => {
                let halted = match broker {
                    Broker::Kiwoom => rest.auth().halted().is_some(),
                    Broker::Kis => kis_rest.as_ref().is_some_and(|kis_rest| kis_rest.auth().halted().is_some()),
                };
                let state = if supplied_generation.is_some() && !halted { SessionState::Live } else { SessionState::WaitingForToken };
                events.heartbeat(0, 0, state);
            }
            _ = poll.tick() => {
                if let Some(minute) = usage.take(&rest.usage()) {
                    events.emit(Event::Usage { minute_start: minute.minute_start, key_max_per_second: minute.key_max_per_second, trs: minute.trs });
                }
            }
            _ = stats_tick.tick() => {
                if !running.stats.is_empty() {
                    events.emit(Event::JobStats { jobs: running.stats.iter().map(|(job, stats)| stats.report(*job)).collect() });
                }
            }
            _ = watch_tick.tick() => {
                if let Some(halt) = kis_rest.as_ref().filter(|_| broker == Broker::Kis).and_then(|kis_rest| kis_rest.auth().halted()) {
                    if !reported_halt {
                        reported_halt = true;
                        events.halted(&kis_halt_reason(&halt), "한투 키와 인증 상태를 확인한 뒤 다시 시작하세요");
                    }
                    continue;
                }
                let needs_issue = match broker {
                    Broker::Kiwoom => rest.auth().needs_issue(clock.now()),
                    Broker::Kis => kis_rest.as_ref().is_some_and(|kis_rest| kis_rest.auth().needs_issue()),
                };
                if let Some(generation) = supplied_generation.filter(|generation| reported_invalid != Some(*generation) && needs_issue) {
                    reported_invalid = Some(generation);
                    events.token_invalid(generation);
                }
            }
        }
    }
    running.stop();
}

struct JobTask {
    assigned: AssignedJob,
    day: KstDate,
    broker: Broker,
    rest: KiwoomRest,
    kis_rest: Option<KisRest>,
    key: KeyName,
    shared_dir: PathBuf,
    clock: Clock,
    stats: Arc<LoopStats>,
}

impl JobTask {
    async fn run(self) {
        let job_loop = JobLoop {
            job: self.assigned.job.job(),
            observation_date: self.day,
            period: Duration::from_secs(self.assigned.period_secs),
            slice: Slice { index: self.assigned.slice_index, count: self.assigned.slice_count },
            peers: if self.assigned.peers.is_empty() { vec![self.broker] } else { self.assigned.peers.clone() },
            options: self.assigned.options.clone(),
        };
        let market = match self.broker {
            Broker::Kiwoom => Market::Kiwoom(&self.rest),
            Broker::Kis => Market::Kis(self.kis_rest.as_ref()),
        };
        job_loop.run(market, &self.key, &self.shared_dir, &self.clock, &self.stats).await;
    }
}

const SPEC: ArgSpec = ArgSpec { value_options: &["key", "shared", "broker", "total-per-second"], flag_options: &["child"] };

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("shared: {message}");
    ExitCode::from(2)
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => return fail(error),
    };
    if !arguments.flag("child") {
        return fail("shared는 --child로만 뜹니다. 데몬이 띄웁니다");
    }
    let Some(key_text) = arguments.value("key") else { return fail("--child에는 --key <이름>이 필요합니다") };
    let key = match KeyName::parse(key_text) {
        Ok(key) => key,
        Err(error) => return fail(format_args!("--key: {error}")),
    };
    let broker = match arguments.value("broker").unwrap_or("kiwoom") {
        "kiwoom" => Broker::Kiwoom,
        "kis" => Broker::Kis,
        other => return fail(format_args!("--broker는 kiwoom이나 kis여야 합니다: {other:?}")),
    };
    let total_per_second = match arguments.value("total-per-second").map(str::parse::<u32>).transpose() {
        Ok(value) => value,
        Err(_) => return fail("--total-per-second는 정수여야 합니다"),
    };
    let data_dir = arguments.data_dir();
    let shared_dir = arguments.value("shared").map_or_else(|| data_dir.join("shared"), PathBuf::from);
    init_logging();
    match die_with_parent() {
        Ok(ParentWatch::Armed) => {}
        Ok(ParentWatch::ParentGone) => {
            eprintln!("shared: 데몬이 이미 끝났습니다. 시작하지 않고 끝납니다");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("shared: 부모 종료 신호를 걸지 못했습니다: {error}");
            return ExitCode::FAILURE;
        }
    }
    let process = process_variables();
    let rest_url = match rest_base_url(&process) {
        Ok(url) => url,
        Err(message) => return fail(message),
    };
    let transport = match ReqwestTransport::new(rest_url) {
        Ok(transport) => transport,
        Err(error) => return fail(format_args!("HTTP 클라이언트를 만들지 못했습니다: {error}")),
    };
    let kis_transport: Option<Arc<dyn KisTransport>> = if broker == Broker::Kis {
        let kis_url = match kis_base_url(&process) {
            Ok(url) => url,
            Err(message) => return fail(message),
        };
        match KisReqwestTransport::new(kis_url) {
            Ok(transport) => Some(Arc::new(transport)),
            Err(error) => return fail(format_args!("한투 HTTP 클라이언트를 만들지 못했습니다: {error}")),
        }
    } else {
        None
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return fail(format_args!("실행 환경을 만들지 못했습니다: {error}")),
    };
    let (event_sink, event_source) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || write_events(event_source, io::stdout().lock()));
    let events = Events::to(event_sink);
    let (command_sink, commands): (mpsc::UnboundedSender<Incoming>, Commands) = mpsc::unbounded_channel();
    std::thread::spawn(move || read_commands(io::stdin().lock(), &command_sink));
    let (stop, shutdown) = watch::channel(false);
    runtime.block_on(async {
        tokio::spawn(forward_termination_signals(stop));
        run_shared(SharedParts { key, broker, shared_dir, transport: Arc::new(transport), kis_transport, clock: Clock::system(), total_per_second, commands, events: events.clone(), shutdown }).await;
    });
    drop(events);
    runtime.shutdown_background();
    let _ = writer.join();
    ExitCode::SUCCESS
}
