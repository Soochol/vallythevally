use std::fmt;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use domain::{KstDate, KstTime, TimeOfDay};
use server::clock::Clock;
use server::kiwoom::transport::Transport;
use server::kis::transport::Transport as KisTransport;
use tokio::sync::watch;

use super::api::{StatusApi, StatusSocket, serve};
use super::journal::{Journal, journal_path};
use super::process::Launcher;
use super::settings::{Settings, SocketSetting};
use super::status::{AlertKind, DaemonStatus, DayPhase};
use super::tokens::IssueLane;
use super::telegram::AlertTelegram;
use crate::calendar::{Calendar, HolidayTransport, Judgment};
use crate::finalize::{COMPLETE_FILE_NAME, recover_all_interrupted_quote_swaps, recover_all_interrupted_swaps, store_dir};
use crate::keys::{ActiveKey, KeyRole};
use crate::shared::AssignmentStore;
use report::Reporter;

mod finalizer;
mod report;
mod rest;
mod settings;
mod stages;

pub use finalizer::{FinalizeRunner, ProcessFinalizeRunner, finalize_arguments, quotes_backfill_arguments};
pub use settings::{DayTimes, ScheduleSettings, parse_clock_time};

pub struct DaemonInputs {
    pub keys: Vec<ActiveKey>,
    pub data_dir: PathBuf,
    pub supervisor: Settings,
    pub schedule: ScheduleSettings,
    pub holiday_key_path: PathBuf,
}

pub struct DaemonInjected {
    pub launcher: Arc<dyn Launcher>,
    pub transport: Arc<dyn Transport>,
    pub holidays: Arc<dyn HolidayTransport>,
    pub finalizer: Arc<dyn FinalizeRunner>,
    pub clock: Clock,
}

#[derive(Debug)]
pub enum DaemonStartError {
    NoKeys,
    Schedule(String),
    StatusSocket { path: PathBuf, error: io::Error },
}

impl fmt::Display for DaemonStartError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DaemonStartError::NoKeys => formatter.write_str("활성 키가 없습니다"),
            DaemonStartError::Schedule(message) => formatter.write_str(message),
            DaemonStartError::StatusSocket { path, error } => write!(formatter, "상태 소켓 {}을 열 수 없습니다: {error}", path.display()),
        }
    }
}

impl std::error::Error for DaemonStartError {}

pub struct SharedJobs {
    pub assignment_path: PathBuf,
    pub kis_transport: Option<Arc<dyn KisTransport>>,
}

struct SharedSetup {
    store: AssignmentStore,
    kis_transport: Option<Arc<dyn KisTransport>>,
}

pub struct Daemon {
    keys: Vec<ActiveKey>,
    rest_keys: Vec<ActiveKey>,
    shared: Option<SharedSetup>,
    data_dir: PathBuf,
    shared_dir: PathBuf,
    supervisor: Settings,
    schedule: ScheduleSettings,
    holiday_key_path: PathBuf,
    launcher: Arc<dyn Launcher>,
    transport: Arc<dyn Transport>,
    holidays: Arc<dyn HolidayTransport>,
    finalizer: Arc<dyn FinalizeRunner>,
    clock: Clock,
    lane: IssueLane,
    reporter: Reporter,
    socket: Option<StatusSocket>,
}

enum Halt {
    Stopped,
    Failed(String),
}

type StageResult<T> = Result<T, Halt>;

enum DayEnd {
    Stopped,
    Done,
}

struct DayRun {
    day: KstDate,
    date: u32,
    times: DayTimes,
    journal: Journal,
    calendar: Option<Calendar>,
    judgment: Option<Judgment>,
    open_minute: Option<u16>,
}

async fn stoppable<T>(shutdown: &mut watch::Receiver<bool>, future: impl Future<Output = T>) -> StageResult<T> {
    tokio::select! {
        biased;
        _ = shutdown.wait_for(|stop| *stop) => Err(Halt::Stopped),
        value = future => Ok(value),
    }
}

fn date_number(day: KstDate) -> u32 {
    day.yyyymmdd().parse().expect("날짜는 숫자 여덟 자리다")
}

impl Daemon {
    pub fn start(inputs: DaemonInputs, injected: DaemonInjected) -> Result<Daemon, DaemonStartError> {
        let DaemonInputs { keys, data_dir, mut supervisor, schedule, holiday_key_path } = inputs;
        let (rest_keys, keys): (Vec<ActiveKey>, Vec<ActiveKey>) = keys.into_iter().partition(|key| key.identity.role == KeyRole::Rest);
        if keys.is_empty() {
            return Err(DaemonStartError::NoKeys);
        }
        schedule.check().map_err(DaemonStartError::Schedule)?;
        let socket = match supervisor.status_socket.take() {
            Some(SocketSetting { path, required }) => match StatusSocket::bind(&path) {
                Ok(socket) => Some(socket),
                Err(error) if required || error.kind() == std::io::ErrorKind::AddrInUse => return Err(DaemonStartError::StatusSocket { path, error }),
                Err(error) => {
                    tracing::error!(path = %path.display(), %error, "상태 소켓을 열 수 없어 상태 API 없이 수집을 이어 갑니다");
                    None
                }
            },
            None => None,
        };
        let shared_dir = data_dir.join("shared");
        let today = date_number(injected.clock.now().kst_date());
        Ok(Daemon {
            keys,
            rest_keys,
            shared: None,
            data_dir,
            shared_dir,
            supervisor,
            schedule,
            holiday_key_path,
            launcher: injected.launcher,
            transport: injected.transport,
            holidays: injected.holidays,
            finalizer: injected.finalizer,
            lane: IssueLane::new(std::time::Duration::ZERO),
            reporter: Reporter::new(injected.clock.clone(), today),
            clock: injected.clock,
            socket,
        })
    }

    pub fn with_shared_jobs(mut self, jobs: SharedJobs) -> Daemon {
        self.shared = Some(SharedSetup { store: AssignmentStore::new(jobs.assignment_path, &self.data_dir), kis_transport: jobs.kis_transport });
        self
    }

    pub fn with_shared_dir(mut self, shared_dir: PathBuf) -> Daemon {
        self.shared_dir = shared_dir;
        self
    }

    pub fn with_telegram(mut self, telegram: Option<AlertTelegram>) -> Daemon {
        self.reporter.use_telegram(telegram);
        self
    }

    pub fn status(&self) -> watch::Receiver<DaemonStatus> {
        self.reporter.subscribe()
    }

    pub async fn run(mut self, mut shutdown: watch::Receiver<bool>) {
        if let Err(error) = recover_all_interrupted_swaps(&self.data_dir) {
            tracing::warn!(%error, data_dir = %self.data_dir.display(), "시작 시 끊긴 저장소 교체를 복구하지 못했습니다");
        }
        if let Err(error) = recover_all_interrupted_quote_swaps(&self.shared_dir) {
            tracing::warn!(%error, shared_dir = %self.shared_dir.display(), "시작 시 끊긴 분 호가 교체를 복구하지 못했습니다");
        }
        let (api_stop, api_shutdown) = watch::channel(false);
        let api = self.socket.take().map(|socket| {
            let api = StatusApi { status: self.reporter.subscribe(), data_dir: self.data_dir.clone(), clock: self.clock.clone(), watch_every: self.supervisor.watch_every };
            tokio::spawn(serve(socket, api, api_shutdown))
        });
        loop {
            let today = self.clock.now().kst_date();
            if self.run_day(today, &mut shutdown).await.is_err() {
                break;
            }
            let midnight = KstTime::from_kst_civil(today.add_days(1), TimeOfDay::MIDNIGHT);
            if stoppable(&mut shutdown, self.clock.sleep_until(midnight)).await.is_err() {
                break;
            }
        }
        let _ = api_stop.send(true);
        if let Some(api) = api {
            let _ = api.await;
        }
    }

    async fn run_day(&mut self, today: KstDate, shutdown: &mut watch::Receiver<bool>) -> Result<(), Halt> {
        let date = date_number(today);
        self.reporter.begin_day(date);
        let outcome = match Journal::open(journal_path(&self.data_dir, date)) {
            Ok(journal) => {
                let mut day = DayRun { day: today, date, times: self.schedule.times_of(today), journal, calendar: None, judgment: None, open_minute: None };
                self.stages(&mut day, shutdown).await
            }
            Err(error) => {
                self.reporter.alert(AlertKind::StageFailed, format!("사건 기록 파일을 열 수 없어 {date}일을 건너뜁니다: {error}"));
                Err(DayEnd::Done)
            }
        };
        match outcome {
            Err(DayEnd::Stopped) => Err(Halt::Stopped),
            Ok(()) | Err(DayEnd::Done) => {
                self.reporter.close_day();
                self.reporter.phase(DayPhase::OffHours);
                Ok(())
            }
        }
    }

    async fn stages(&mut self, day: &mut DayRun, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        let backlog_until = if self.clock.now().unix() < day.times.close.unix() { day.times.judge } else { self.schedule.times_of(day.day.add_days(1)).judge };
        self.finalize_backlog(day.date, backlog_until, shutdown).await?;
        self.backfill_quote_minutes(backlog_until, shutdown).await?;
        if self.clock.now().unix() >= day.times.close.unix() {
            return self.after_close_start(day, backlog_until, shutdown).await;
        }
        self.wait(shutdown, day.times.judge).await?;
        self.judge(day, shutdown).await?;
        self.reporter.phase(DayPhase::MorningPrep);
        let universe = self.morning_universe(day, shutdown).await?;
        self.wait(shutdown, day.times.plan).await?;
        self.reload_shared_assignment();
        let plan = self.plan(day, universe)?;
        self.wait(shutdown, day.times.launch).await?;
        if self.clock.now().unix() >= day.times.close.unix() {
            return Ok(());
        }
        self.collect(day, plan, shutdown).await?;
        self.reporter.phase(DayPhase::AfterClose);
        self.after_close(day, shutdown).await?;
        self.finalize(day, true, shutdown).await
    }

    async fn after_close_start(&mut self, day: &mut DayRun, start_before: KstTime, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        if store_dir(&self.data_dir, day.date).join(COMPLETE_FILE_NAME).is_file() {
            return Ok(());
        }
        self.judge(day, shutdown).await?;
        if self.clock.now().unix() >= start_before.unix() {
            tracing::warn!(date = day.date, "그날 정리를 아침 일정 앞에서 시작하지 않습니다. 다음 정리 기회에 밀린 날로 정리합니다");
            return Ok(());
        }
        self.reporter.phase(DayPhase::AfterClose);
        self.after_close(day, shutdown).await?;
        if self.clock.now().unix() >= start_before.unix() {
            tracing::warn!(date = day.date, "그날 정리를 아침 일정 앞에서 시작하지 않습니다. 다음 정리 기회에 밀린 날로 정리합니다");
            return Ok(());
        }
        self.finalize(day, false, shutdown).await
    }

    async fn wait(&self, shutdown: &mut watch::Receiver<bool>, at: KstTime) -> Result<(), DayEnd> {
        let clock = self.clock.clone();
        stoppable(shutdown, async move { clock.sleep_until(at).await }).await.map_err(|_| DayEnd::Stopped)
    }

    fn soft<T>(&mut self, stage: &str, result: StageResult<T>) -> Result<Option<T>, DayEnd> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(Halt::Stopped) => Err(DayEnd::Stopped),
            Err(Halt::Failed(message)) => {
                self.reporter.alert(AlertKind::StageFailed, format!("{stage}: {message}"));
                Ok(None)
            }
        }
    }
}
