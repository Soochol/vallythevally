use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use server::clock::Clock;
use server::instance::{InstanceLock, LockError};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::token_file::TokenFile;
use server::kiwoom::transport::{ReqwestTransport, Transport};
use tokio::sync::watch;

use super::config::CollectorConfig;
use super::items::Items;
use super::output::Output;
use super::registry::Registry;
use super::session::{Finish, Session, SessionParts, SystemWallClock, Timings, Tokens, WallClock};
use super::ws::{Connector, WebSocketConnector};

pub const KIWOOM_BASE_URL: &str = "https://api.kiwoom.com";
pub const KIWOOM_WS_URL: &str = "wss://api.kiwoom.com:10000/api/dostk/websocket";

pub struct Injected {
    pub transport: Arc<dyn Transport>,
    pub connector: Arc<dyn Connector>,
    pub wall_clock: Arc<dyn WallClock>,
    pub token_clock: Clock,
    pub timings: Timings,
}

#[derive(Debug)]
pub enum StartError {
    Lock(LockError),
    DataFolder(std::io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Lock(error) => error.fmt(formatter),
            StartError::DataFolder(error) => write!(formatter, "데이터 폴더를 만들 수 없습니다: {error}"),
        }
    }
}

pub async fn execute(
    config: &CollectorConfig,
    data_dir: PathBuf,
    items: &Items,
    injected: Injected,
    shutdown: watch::Receiver<bool>,
) -> Result<Finish, StartError> {
    let lock = InstanceLock::acquire(&config.lock_path).map_err(StartError::Lock)?;
    std::fs::create_dir_all(data_dir.join("raw")).map_err(StartError::DataFolder)?;
    let token_file = TokenFile::new(config.token_path.clone(), &lock);
    let auth = KiwoomAuth::new(config.app_key.clone(), config.app_secret.clone(), Some(token_file));
    let rest = KiwoomRest::new(injected.transport, auth, injected.token_clock.clone());
    let session = Session::new(SessionParts {
        tokens: Tokens::issued(rest, injected.token_clock),
        registry: Registry::standalone(items.registrations()),
        output: Output::new(data_dir),
        connector: injected.connector,
        wall_clock: injected.wall_clock,
        timings: injected.timings,
        shutdown,
        child: None,
    });
    let finish = session.run().await;
    drop(lock);
    Ok(finish)
}

pub fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .try_init();
}

pub fn run_collector(config: &CollectorConfig, data_dir: PathBuf, items: &Items) -> ExitCode {
    init_logging();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("collect: 실행 환경을 만들지 못했습니다: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async {
        let transport = match ReqwestTransport::new(KIWOOM_BASE_URL.to_owned()) {
            Ok(transport) => transport,
            Err(error) => {
                eprintln!("collect: HTTP 클라이언트를 만들지 못했습니다: {error}");
                return ExitCode::FAILURE;
            }
        };
        let (stop, shutdown) = watch::channel(false);
        tokio::spawn(forward_termination_signals(stop));
        let injected = Injected {
            transport: Arc::new(transport),
            connector: Arc::new(WebSocketConnector::new(KIWOOM_WS_URL)),
            wall_clock: Arc::new(SystemWallClock),
            token_clock: Clock::system(),
            timings: Timings::default(),
        };
        match execute(config, data_dir, items, injected, shutdown).await {
            Err(error) => {
                eprintln!("collect: 수집기를 시작하지 못했습니다: {error}");
                ExitCode::FAILURE
            }
            Ok(finish) => {
                if let Finish::Halted(halt) = &finish {
                    eprintln!("collect: 멈췄습니다. {}\n할 일: {}", halt.reason(), halt.action());
                }
                ExitCode::from(exit_status(&finish))
            }
        }
    })
}

pub fn exit_status(finish: &Finish) -> u8 {
    match finish {
        Finish::Shutdown => 0,
        Finish::Halted(_) => 1,
    }
}

pub(crate) async fn forward_termination_signals(stop: watch::Sender<bool>) {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut terminate), Ok(mut interrupt)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        tracing::error!("종료 신호를 받을 수 없습니다");
        return;
    };
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
    let _ = stop.send(true);
}
