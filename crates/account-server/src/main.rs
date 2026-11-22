use account_server::settings::{Settings, parse_env_file};
use account_server::{Accounts, SystemClock, open_database};
use std::collections::HashMap;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

fn read_values() -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    if let Some(path) = std::env::var_os("VALLY_ACCOUNT_ENV_FILE") {
        let text = read_private_file(Path::new(&path))?;
        values.extend(parse_env_file(&text));
    }
    values.extend(std::env::vars().filter(|(key, _)| key.starts_with("VALLY_ACCOUNT_")));
    Ok(values)
}

fn read_private_file(path: &Path) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path).map_err(|error| format!("env 파일을 읽지 못했다: {error}"))?.permissions().mode();
    if mode & 0o077 != 0 {
        return Err("env 파일 권한이 다른 사용자에게 열려 있다(600으로 줄여야 한다)".into());
    }
    std::fs::read_to_string(path).map_err(|error| format!("env 파일을 읽지 못했다: {error}"))
}

async fn run() -> Result<(), String> {
    let settings = Settings::from_values(&read_values()?).map_err(|error| error.to_string())?;
    if let Some(parent) = settings.database_path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| format!("DB 폴더를 만들지 못했다: {error}"))?;
    }
    let pool = open_database(&settings.database_path).await.map_err(|error| format!("DB를 열지 못했다: {error}"))?;
    let app = Accounts::new(settings.config.clone(), settings.account_options(), pool, Arc::new(SystemClock)).router();
    let listener = tokio::net::TcpListener::bind(settings.bind).await.map_err(|error| format!("{}에 묶지 못했다: {error}", settings.bind))?;
    tracing::info!(bind = %settings.bind, "계정 서버 시작");
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await.map_err(|error| error.to_string())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("VALLY_ACCOUNT_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("vally-account: {message}");
            ExitCode::FAILURE
        }
    }
}
