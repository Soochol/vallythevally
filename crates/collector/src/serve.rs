use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use tokio::net::TcpListener;

use crate::args::{ArgSpec, Arguments};

pub mod assets;
pub mod routes;

pub use routes::router;

pub const DEFAULT_BIND: &str = "127.0.0.1:8090";

const SPEC: ArgSpec = ArgSpec {
    value_options: &["bind"],
    flag_options: &[],
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    NotAnAddress(String),
    NotLoopback(SocketAddr),
}

impl std::fmt::Display for BindError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindError::NotAnAddress(text) => write!(formatter, "주소를 읽을 수 없습니다: {text} (예: 127.0.0.1:8090)"),
            BindError::NotLoopback(address) => {
                write!(formatter, "루프백 주소(127.0.0.0/8, ::1)만 쓸 수 있습니다: {address}")
            }
        }
    }
}

impl std::error::Error for BindError {}

pub fn parse_loopback_address(text: &str) -> Result<SocketAddr, BindError> {
    let address: SocketAddr = text.parse().map_err(|_| BindError::NotAnAddress(text.to_string()))?;
    if address.ip().is_loopback() { Ok(address) } else { Err(BindError::NotLoopback(address)) }
}

pub async fn bind_loopback(text: &str) -> Result<TcpListener, Box<dyn std::error::Error>> {
    let address = parse_loopback_address(text)?;
    Ok(TcpListener::bind(address).await?)
}

pub fn page_url(address: SocketAddr) -> String {
    format!("http://{address}")
}

async fn shutdown_signal() {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM 처리기를 등록할 수 있다");
        tokio::select! {
            _ = interrupt => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = interrupt.await;
    }
}

async fn serve(data_dir: PathBuf, bind: &str) -> Result<(), Box<dyn std::error::Error>> {
    let listener = bind_loopback(bind).await?;
    println!("{}", page_url(listener.local_addr()?));
    axum::serve(listener, router(data_dir)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("serve: {error}");
            return ExitCode::from(2);
        }
    };
    let data_dir = arguments.data_dir();
    if !data_dir.is_dir() {
        eprintln!("serve: 데이터 폴더가 없습니다: {}", data_dir.display());
        return ExitCode::FAILURE;
    }
    let bind = arguments.value("bind").unwrap_or(DEFAULT_BIND);
    if let Err(error) = parse_loopback_address(bind) {
        eprintln!("serve: {error}");
        return ExitCode::from(2);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("serve: 실행기를 만들 수 없습니다: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(serve(data_dir, bind)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("serve: {error}");
            ExitCode::FAILURE
        }
    }
}
