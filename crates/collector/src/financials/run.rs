use std::process::ExitCode;
use std::sync::Arc;

use server::clock::Clock;
use server::financials::{Financials, acquire_writer_lock, client::Client, store::Store};
use tokio::sync::watch;

use super::alert;
use super::config::{RUN_SPEC, RunConfig, SOCKET_FILE_NAME};
use super::listing::{POLL_INTERVAL, watch_listings};
use super::socket::{self, Control};
use crate::args::Arguments;
use crate::collect::config::process_variables;
use crate::collect::start::{forward_termination_signals, init_logging};

const RUNTIME_STOP_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);

fn usage_error(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("financials run: {message}");
    ExitCode::from(2)
}

fn failure(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("financials run: {message}");
    ExitCode::FAILURE
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &RUN_SPEC) {
        Ok(arguments) => arguments,
        Err(error) => return usage_error(error),
    };
    let config = match RunConfig::load(&arguments, &process_variables()) {
        Ok(config) => config,
        Err(message) => return usage_error(message),
    };
    init_logging();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return failure(format_args!("실행 환경을 만들지 못했습니다: {error}")),
    };
    let code = runtime.block_on(execute(config));
    runtime.shutdown_timeout(RUNTIME_STOP_LIMIT);
    code
}

async fn execute(config: RunConfig) -> ExitCode {
    let RunConfig { database, data_dir, key, state_folder, telegram, dart_base_url, kind_base_url, spacing } = config;
    let client = match spacing {
        Some(spacing) => Client::with_spacing(key, dart_base_url, kind_base_url, spacing),
        None => Client::new(key, dart_base_url, kind_base_url),
    };
    let Ok(client) = client else { return failure("OpenDART HTTP 클라이언트를 만들지 못했습니다") };
    let writer = match acquire_writer_lock(&database) {
        Ok(writer) => writer,
        Err(error) => return usage_error(error),
    };
    let store = match Store::open_for_collection(&database).await {
        Ok(store) => store,
        Err(failure_kind) => return failure(format_args!("재무 저장소 {}를 열 수 없습니다({failure_kind:?})", database.display())),
    };
    let clock = Clock::system();
    let service = Financials::new(Some(client), store, clock.clone());
    service.hold_writer(writer);
    let socket = match socket::bind(&state_folder.join(SOCKET_FILE_NAME)) {
        Ok(socket) => socket,
        Err(error) => return usage_error(format_args!("상태 소켓을 열 수 없습니다: {error}")),
    };
    let (listing, listing_task) = watch_listings(data_dir.clone(), clock.clone(), POLL_INTERVAL);
    let _automatic = service.start_automatic(listing.symbols.clone());
    tokio::spawn(socket::serve(socket, Arc::new(Control { service: service.clone(), listing })));
    if let Some(telegram) = telegram {
        let alert_state = state_folder.clone();
        tokio::spawn(async move { alert::run(service.clone(), telegram, &alert_state, clock, alert::POLL_INTERVAL).await });
    }
    tracing::info!(database = %database.display(), data = %data_dir.display(), "재무 수집 프로세스를 시작했습니다");
    let (stop, mut stopped) = watch::channel(false);
    tokio::spawn(forward_termination_signals(stop));
    let _ = stopped.wait_for(|stopped| *stopped).await;
    listing_task.abort();
    tracing::info!("재무 수집 프로세스를 끝냅니다");
    ExitCode::SUCCESS
}
