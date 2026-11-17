use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use server::clock::Clock;
use server::kiwoom::transport::ReqwestTransport;
use tokio::sync::watch;

use crate::args::{ArgSpec, Arguments};
use crate::collect::child::is_loopback_ws;
use crate::collect::config::{Variables, default_state_folder, process_variables};
use crate::collect::start::{KIWOOM_BASE_URL, forward_termination_signals, init_logging};
use crate::keys::KeyList;

mod api;
mod daemon;
mod files;
mod handoff;
mod journal;
mod process;
mod settings;
mod status_command;
mod status;
mod tokens;
mod wire;

pub use daemon::{Control, Injected, Inputs, StartError, Supervisor, load_plan};
pub use handoff::{STOCK_TYPES, effective_plan, registrations_of};
pub use journal::{JOURNAL_VERSION, JournalEvent, journal_path, kst_stamp};
pub use process::{ChildMessage, ChildProcess, FORWARDED_VARIABLES, Launcher, Spawned, TokioLauncher};
pub use settings::{Settings, SocketSetting};
pub use status_command::run as run_status;
pub use status::{Alert, AlertKind, DaemonStatus, DayPhase, KeyState, KeyStatus, ObservationDay, ObservationVerdict, RestProgress, Today};
pub use api::{MAX_CONNECTIONS, OUTBOX_LINES, SOCKET_FILE_NAME};
pub use files::{read_coverage, read_disk};
pub use wire::{API_VERSION, CoverageDay, CoverageState, DayBytes, DiskUsage, ErrorCode, Filesystem, Reply, ReplyBody, Request, RequestKind};

pub const REST_URL_VARIABLE: &str = "VALLY_COLLECTOR_REST_URL";

const SPEC: ArgSpec = ArgSpec { value_options: &["date", "keys", "state", "socket"], flag_options: &[] };

pub fn rest_base_url(variables: &Variables) -> Result<String, String> {
    let Some(url) = variables.get(REST_URL_VARIABLE).filter(|url| !url.is_empty()) else {
        return Ok(KIWOOM_BASE_URL.to_owned());
    };
    if url.starts_with("http://") && is_loopback_ws(&url.replacen("http://", "ws://", 1)) {
        Ok(url.trim_end_matches('/').to_owned())
    } else {
        Err(format!("{REST_URL_VARIABLE}는 http://127.0.0.1, http://localhost, http://[::1] 주소만 받습니다. 앱키를 밖으로 보내지 않기 위해서입니다"))
    }
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
    let Some(date) = arguments.value("date").and_then(|text| text.parse::<u32>().ok()).filter(|date| (10_000_101..=99_991_231).contains(date)) else {
        return usage_error("--date YYYYMMDD가 필요합니다");
    };
    let Some(keys_path) = arguments.value("keys").map(PathBuf::from) else {
        return usage_error("--keys <키 목록 설정 파일>이 필요합니다");
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
    let socket = match status_command::socket_path(&arguments, &process) {
        Ok(socket) => socket,
        Err(message) => return usage_error(message),
    };
    let rest_url = match rest_base_url(&process) {
        Ok(url) => url,
        Err(message) => return usage_error(message),
    };
    let data_dir = arguments.data_dir();
    let keys = match KeyList::load(&keys_path, &state_folder, &process) {
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
    runtime.block_on(async {
        let transport = match ReqwestTransport::new(rest_url) {
            Ok(transport) => transport,
            Err(error) => return usage_error(format_args!("HTTP 클라이언트를 만들지 못했습니다: {error}")),
        };
        let injected = Injected {
            launcher: Arc::new(TokioLauncher::new(executable, data_dir.clone(), &process)),
            transport: Arc::new(transport),
            clock: Clock::system(),
        };
        let supervisor = match Supervisor::start(Inputs { plan, keys: keys.active, data_dir, settings: Settings { status_socket: Some(SocketSetting { path: socket, required: socket_given }), ..Settings::default() } }, injected) {
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
    })
}
