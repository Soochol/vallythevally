use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use server::clock::Clock;
use server::collector::telegram::{Telegram, default_path as default_telegram_path};
use server::kiwoom::transport::ReqwestTransport;
use server::shared_data::Broker;
use tokio::sync::watch;

use crate::args::{ArgSpec, Arguments};
use crate::calendar::ReqwestHolidayTransport;
use crate::collect::child::is_loopback_ws;
use crate::collect::config::{Variables, default_state_folder, process_variables};
use crate::collect::start::{KIWOOM_BASE_URL, forward_termination_signals, init_logging};
use crate::finalize::RetentionSettings;
use crate::keys::KeyList;

mod api;
mod child_slot;
mod daemon;
mod files;
mod handoff;
mod journal;
mod process;
mod restart_window;
mod schedule;
mod settings;
mod shared;
mod status_command;
mod status;
mod tokens;
mod telegram;
mod wire;

pub use daemon::{Control, Injected, Inputs, StartError, Supervisor, load_plan};
pub use handoff::{STOCK_TYPES, effective_plan, registrations_of};
pub use journal::{JOURNAL_VERSION, JournalEvent, journal_path, kst_stamp, read_lossy};
pub use process::{ChildMessage, ChildProcess, FORWARDED_VARIABLES, Launcher, SharedLaunch, Spawned, TokioLauncher};
pub use shared::{SharedInjected, SharedInputs, SharedReport, SharedStartError, SharedSupervisor};
pub use schedule::{Daemon, SharedJobs, DaemonInjected, DaemonInputs, DaemonStartError, DayTimes, FinalizeRunner, ProcessFinalizeRunner, ScheduleSettings, finalize_arguments, parse_clock_time};
pub use settings::{MarketOpenCheck, Settings, SocketSetting};
pub use restart_window::{RestartInputs, RestartVerdict, decide as decide_restart, run as run_restart_window};
pub use status_command::run as run_status;
pub use status::{Alert, AlertKind, DaemonStatus, DayPhase, KeyState, KeyStatus, KeyUsage, ObservationDay, ObservationVerdict, RestProgress, Today};
pub use api::{MAX_CONNECTIONS, OUTBOX_LINES, SOCKET_FILE_NAME, StatusSocket};
pub use telegram::AlertTelegram;
pub use files::{read_coverage, read_disk};
pub use wire::{API_VERSION, CoverageDay, CoverageState, DayBytes, DiskUsage, ErrorCode, Filesystem, Reply, ReplyBody, Request, RequestKind};

pub const REST_URL_VARIABLE: &str = "VALLY_COLLECTOR_REST_URL";
pub const KIS_URL_VARIABLE: &str = "VALLY_COLLECTOR_KIS_URL";

const SPEC: ArgSpec = ArgSpec {
    value_options: &[
        "date",
        "keys",
        "state",
        "socket",
        "judge-at",
        "plan-at",
        "launch-at",
        "close-at",
        "open-grace-minutes",
        "reissue-spacing-secs",
        "finalize-threads",
        "holiday-key",
        "keep-early",
        "keep",
        "early-period",
        "telegram",
        "shared-config",
        "shared",
    ],
    flag_options: &[],
};

const DAEMON_ONLY_OPTIONS: [&str; 14] = [
    "judge-at",
    "plan-at",
    "launch-at",
    "close-at",
    "open-grace-minutes",
    "reissue-spacing-secs",
    "finalize-threads",
    "holiday-key",
    "keep-early",
    "keep",
    "early-period",
    "telegram",
    "shared-config",
    "shared",
];

const SHARED_CONFIG_FILE: &str = ".config/vally/collector-shared.json";
const HOLIDAY_KEY_FILE: &str = ".config/vally/holiday-service-key";
const RUNTIME_STOP_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);

fn default_holiday_key_path(variables: &Variables) -> Result<PathBuf, String> {
    match variables.get("HOME").filter(|home| !home.is_empty()) {
        Some(home) => Ok(PathBuf::from(home).join(HOLIDAY_KEY_FILE)),
        None => Err("HOME이 없어 특일정보 키 파일 경로를 정할 수 없습니다. --holiday-key를 주세요".to_string()),
    }
}

fn stop_runtime(runtime: tokio::runtime::Runtime, limit: std::time::Duration) {
    runtime.shutdown_timeout(limit);
}

fn loopback_http_url(variables: &Variables, variable: &str, default: &str) -> Result<String, String> {
    let Some(url) = variables.get(variable).filter(|url| !url.is_empty()) else {
        return Ok(default.to_owned());
    };
    let normalized = url.strip_suffix('/').unwrap_or(url);
    let valid = normalized
        .strip_prefix("http://")
        .is_some_and(|rest| !rest.contains(['/', '?', '#']) && is_loopback_ws(&format!("ws://{rest}")));
    if valid {
        Ok(normalized.to_owned())
    } else {
        Err(format!("{variable}는 http://127.0.0.1, http://localhost, http://[::1] 주소만 받습니다. 앱키를 밖으로 보내지 않기 위해서입니다"))
    }
}

pub fn rest_base_url(variables: &Variables) -> Result<String, String> {
    loopback_http_url(variables, REST_URL_VARIABLE, KIWOOM_BASE_URL)
}

pub fn kis_base_url(variables: &Variables) -> Result<String, String> {
    loopback_http_url(variables, KIS_URL_VARIABLE, server::config::KIS_BASE_URL)
}

fn usage_error(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("supervise: {message}");
    ExitCode::from(2)
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => return usage_error(error),
    };
    let Some(keys_path) = arguments.value("keys").map(PathBuf::from) else {
        return usage_error("--keys <키 목록 설정 파일>이 필요합니다");
    };
    match arguments.value("date") {
        Some(date) => run_single_day(&arguments, &keys_path, date),
        None => run_daemon(&arguments, &keys_path),
    }
}

fn parse_schedule(arguments: &Arguments) -> Result<ScheduleSettings, String> {
    let mut schedule = ScheduleSettings::default();
    let clock = |name: &str, slot: &mut domain::TimeOfDay| -> Result<(), String> {
        if let Some(text) = arguments.value(name) {
            *slot = parse_clock_time(text).ok_or_else(|| format!("--{name}은 HH:MM이어야 합니다: {text:?}"))?;
        }
        Ok(())
    };
    clock("judge-at", &mut schedule.judge_at)?;
    clock("plan-at", &mut schedule.plan_at)?;
    clock("launch-at", &mut schedule.launch_at)?;
    clock("close-at", &mut schedule.close_at)?;
    let number = |name: &str| -> Result<Option<u64>, String> {
        arguments.value(name).map(|text| text.parse::<u64>().map_err(|_| format!("--{name}은 0 이상의 정수여야 합니다: {text:?}"))).transpose()
    };
    if let Some(minutes) = number("open-grace-minutes")? {
        schedule.market_open_grace = std::time::Duration::from_secs(minutes * 60);
    }
    if let Some(seconds) = number("reissue-spacing-secs")? {
        schedule.reissue_spacing = std::time::Duration::from_secs(seconds);
    }
    if let Some(threads) = number("finalize-threads")? {
        schedule.finalize_threads = threads as usize;
    }
    schedule.retention = RetentionSettings::from_arguments(arguments)?;
    schedule.check()?;
    Ok(schedule)
}

pub fn schedule_from_arguments(raw_arguments: &[String]) -> Result<ScheduleSettings, String> {
    let arguments = Arguments::parse(raw_arguments, &SPEC).map_err(|error| error.to_string())?;
    parse_schedule(&arguments)
}

fn default_shared_config_path(variables: &Variables) -> Result<PathBuf, String> {
    match variables.get("HOME").filter(|home| !home.is_empty()) {
        Some(home) => Ok(PathBuf::from(home).join(SHARED_CONFIG_FILE)),
        None => Err("HOME이 없어 키 배정표 경로를 정할 수 없습니다. --shared-config를 주세요".to_string()),
    }
}

fn load_telegram(arguments: &Arguments, process: &Variables) -> Result<Option<Telegram>, String> {
    let default = || process.get("HOME").filter(|home| !home.is_empty()).map(|home| default_telegram_path(std::path::Path::new(home)));
    let Some(path) = arguments.value("telegram").map(PathBuf::from).or_else(default) else { return Ok(None) };
    Telegram::load(&path).map_err(|error| error.to_string())
}

fn run_daemon(arguments: &Arguments, keys_path: &std::path::Path) -> ExitCode {
    let schedule = match parse_schedule(arguments) {
        Ok(schedule) => schedule,
        Err(message) => return usage_error(message),
    };
    let process = process_variables();
    let state_folder = match arguments.value("state") {
        Some(folder) => PathBuf::from(folder),
        None => match default_state_folder(&process) {
            Ok(folder) => folder,
            Err(error) => return usage_error(error),
        },
    };
    let socket_given = arguments.value("socket").is_some();
    let socket = match status_command::socket_path(arguments, &process) {
        Ok(socket) => socket,
        Err(message) => return usage_error(message),
    };
    let rest_url = match rest_base_url(&process) {
        Ok(url) => url,
        Err(message) => return usage_error(message),
    };
    let data_dir = arguments.data_dir();
    let keys = match KeyList::load(keys_path, &state_folder, &process) {
        Ok(keys) => keys,
        Err(error) => return usage_error(error),
    };
    let shared_config = match arguments.value("shared-config") {
        Some(path) => PathBuf::from(path),
        None => match default_shared_config_path(&process) {
            Ok(path) => path,
            Err(message) => return usage_error(message),
        },
    };
    let shared_dir = arguments.value("shared").map_or_else(|| data_dir.join("shared"), PathBuf::from);
    let holiday_key_path = match arguments.value("holiday-key") {
        Some(path) => PathBuf::from(path),
        None => match default_holiday_key_path(&process) {
            Ok(path) => path,
            Err(message) => return usage_error(message),
        },
    };
    let telegram = match load_telegram(arguments, &process) {
        Ok(telegram) => telegram,
        Err(message) => return usage_error(message),
    };
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => return usage_error(format_args!("실행 파일 경로를 알 수 없습니다: {error}")),
    };
    let kis_transport: Option<Arc<dyn server::kis::transport::Transport>> = if keys.active.iter().any(|key| key.broker == Broker::Kis) {
        let kis_url = match kis_base_url(&process) {
            Ok(url) => url,
            Err(message) => return usage_error(message),
        };
        match server::kis::transport::ReqwestTransport::new(kis_url) {
            Ok(transport) => Some(Arc::new(transport)),
            Err(error) => return usage_error(format_args!("한투 HTTP 클라이언트를 만들지 못했습니다: {error}")),
        }
    } else {
        None
    };
    init_logging();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return usage_error(format_args!("실행 환경을 만들지 못했습니다: {error}")),
    };
    let code = runtime.block_on(async {
        let transport = match ReqwestTransport::new(rest_url) {
            Ok(transport) => transport,
            Err(error) => return usage_error(format_args!("HTTP 클라이언트를 만들지 못했습니다: {error}")),
        };
        let holidays = match ReqwestHolidayTransport::new() {
            Ok(holidays) => holidays,
            Err(error) => return usage_error(format_args!("특일정보 HTTP 클라이언트를 만들지 못했습니다: {error}")),
        };
        let injected = DaemonInjected {
            launcher: Arc::new(TokioLauncher::new(executable.clone(), data_dir.clone(), &process).with_shared_dir(shared_dir.clone())),
            transport: Arc::new(transport),
            holidays: Arc::new(holidays),
            finalizer: Arc::new(ProcessFinalizeRunner::new(executable)),
            clock: Clock::system(),
        };
        let inputs = DaemonInputs {
            keys: keys.active,
            data_dir,
            supervisor: Settings { status_socket: Some(SocketSetting { path: socket, required: socket_given }), ..Settings::default() },
            schedule,
            holiday_key_path,
        };
        let daemon = match Daemon::start(inputs, injected) {
            Ok(daemon) => daemon
                .with_shared_dir(shared_dir)
                .with_shared_jobs(SharedJobs { assignment_path: shared_config, kis_transport })
                .with_telegram(telegram.map(|telegram| AlertTelegram::spawn(telegram, &state_folder))),
            Err(error) => {
                eprintln!("supervise: 시작하지 못했습니다: {error}");
                return ExitCode::FAILURE;
            }
        };
        let (stop, shutdown) = watch::channel(false);
        tokio::spawn(forward_termination_signals(stop));
        daemon.run(shutdown).await;
        ExitCode::SUCCESS
    });
    stop_runtime(runtime, RUNTIME_STOP_LIMIT);
    code
}

fn run_single_day(arguments: &Arguments, keys_path: &std::path::Path, date: &str) -> ExitCode {
    if let Some(option) = DAEMON_ONLY_OPTIONS.iter().find(|option| arguments.value(option).is_some()) {
        return usage_error(format_args!("--{option}은 --date 없이 도는 데몬에서만 씁니다"));
    }
    let Some(date) = date.parse::<u32>().ok().filter(|date| (10_000_101..=99_991_231).contains(date)) else {
        return usage_error("--date YYYYMMDD가 필요합니다");
    };
    let process = process_variables();
    let state_folder = match arguments.value("state") {
        Some(folder) => PathBuf::from(folder),
        None => match default_state_folder(&process) {
            Ok(folder) => folder,
            Err(error) => return usage_error(error),
        },
    };
    let socket_given = arguments.value("socket").is_some();
    let socket = match status_command::socket_path(arguments, &process) {
        Ok(socket) => socket,
        Err(message) => return usage_error(message),
    };
    let rest_url = match rest_base_url(&process) {
        Ok(url) => url,
        Err(message) => return usage_error(message),
    };
    let data_dir = arguments.data_dir();
    let keys = match KeyList::load(keys_path, &state_folder, &process) {
        Ok(keys) => keys,
        Err(error) => return usage_error(error),
    };
    let plan = match load_plan(&data_dir, date) {
        Ok(plan) => plan,
        Err(error) => return usage_error(error),
    };
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => return usage_error(format_args!("실행 파일 경로를 알 수 없습니다: {error}")),
    };
    init_logging();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return usage_error(format_args!("실행 환경을 만들지 못했습니다: {error}")),
    };
    let code = runtime.block_on(async {
        let transport = match ReqwestTransport::new(rest_url) {
            Ok(transport) => transport,
            Err(error) => return usage_error(format_args!("HTTP 클라이언트를 만들지 못했습니다: {error}")),
        };
        let injected = Injected {
            launcher: Arc::new(TokioLauncher::new(executable, data_dir.clone(), &process)),
            transport: Arc::new(transport),
            clock: Clock::system(),
        };
        let supervisor = match Supervisor::start(Inputs { plan, keys: keys.split_rest().0, data_dir, settings: Settings { status_socket: Some(SocketSetting { path: socket, required: socket_given }), ..Settings::default() } }, injected) {
            Ok(supervisor) => supervisor,
            Err(error) => {
                eprintln!("supervise: 시작하지 못했습니다: {error}");
                return ExitCode::FAILURE;
            }
        };
        let (stop, shutdown) = watch::channel(false);
        tokio::spawn(forward_termination_signals(stop));
        supervisor.run(shutdown).await;
        ExitCode::SUCCESS
    });
    stop_runtime(runtime, RUNTIME_STOP_LIMIT);
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn telegram_arguments(path: &std::path::Path) -> Arguments {
        let raw: Vec<String> = ["--keys", "keys.json", "--telegram", &path.display().to_string()].map(str::to_owned).to_vec();
        Arguments::parse(&raw, &SPEC).unwrap()
    }

    #[test]
    fn the_telegram_file_comes_from_the_option_or_home_and_a_wide_one_stops_the_start() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("hook");
        std::fs::write(&file, "bot_token=1:SECRET-TOKEN\nchat_id=1\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        let message = load_telegram(&telegram_arguments(&file), &Variables::default()).unwrap_err();
        assert!(message.contains("chmod 600") && !message.contains("SECRET-TOKEN"), "{message}");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(load_telegram(&telegram_arguments(&file), &Variables::default()).unwrap().is_some());

        let none = Arguments::parse(&["--keys".to_owned(), "keys.json".to_owned()], &SPEC).unwrap();
        assert!(load_telegram(&none, &Variables::default()).unwrap().is_none(), "HOME이 없으면 꺼진다");
        let mut process = Variables::default();
        process.insert("HOME".to_owned(), folder.path().display().to_string());
        assert!(load_telegram(&none, &process).unwrap().is_none(), "기본 파일이 없으면 꺼진다");
        let default_file = server::collector::telegram::default_path(folder.path());
        std::fs::create_dir_all(default_file.parent().unwrap()).unwrap();
        std::fs::copy(&file, &default_file).unwrap();
        assert!(load_telegram(&none, &process).unwrap().is_some(), "HOME 아래 기본 경로를 읽는다");
        std::fs::set_permissions(&default_file, std::fs::Permissions::from_mode(0o660)).unwrap();
        assert!(load_telegram(&none, &process).is_err());
    }

    #[test]
    fn holiday_key_defaults_to_the_secrets_folder_under_home() {
        let variables = Variables::from([("HOME".to_string(), "/home/someone".to_string())]);
        assert_eq!(default_holiday_key_path(&variables).unwrap(), PathBuf::from("/home/someone/.config/vally/holiday-service-key"));
        assert!(default_holiday_key_path(&Variables::new()).is_err());
    }

    #[test]
    fn kis_base_url_allows_only_loopback_overrides() {
        assert_eq!(kis_base_url(&Variables::new()).unwrap(), server::config::KIS_BASE_URL);
        assert_eq!(
            kis_base_url(&Variables::from([(KIS_URL_VARIABLE.to_owned(), "http://127.0.0.1:18080/".to_owned())])).unwrap(),
            "http://127.0.0.1:18080"
        );
        assert_eq!(
            kis_base_url(&Variables::from([(KIS_URL_VARIABLE.to_owned(), "http://[::1]:18080".to_owned())])).unwrap(),
            "http://[::1]:18080"
        );
        for bad in [
            "https://example.com",
            "http://[::1]evil.example:8080",
            "http://127.0.0.1:18080/override#frag",
            "http://127.0.0.1:18080#frag",
            "http://127.0.0.1:18080?x=1",
            "http://127.0.0.1:18080/prefix",
            "http://127.0.0.1:18080//",
            "http://127.0.0.1:70000",
        ] {
            assert!(kis_base_url(&Variables::from([(KIS_URL_VARIABLE.to_owned(), bad.to_owned())])).is_err(), "{bad}");
            assert!(rest_base_url(&Variables::from([(REST_URL_VARIABLE.to_owned(), bad.to_owned())])).is_err(), "{bad}");
        }
    }

    #[test]
    fn stopping_the_runtime_gives_up_on_a_blocking_task_after_the_limit() {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let (started, running) = std::sync::mpsc::channel();
        runtime.spawn_blocking(move || {
            started.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(30));
        });
        running.recv().unwrap();
        let limit = Duration::from_millis(300);
        let before = Instant::now();
        stop_runtime(runtime, limit);
        let waited = before.elapsed();
        assert!(waited >= limit && waited < Duration::from_secs(5), "{waited:?}");
    }
}
