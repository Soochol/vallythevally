//! 서버를 켜는 순서와 하루 타이머(backend.md §4.1, §6.2, §6.6).
//!
//! 순서: 설정 → 잠금 파일 → 사용자 자료 DB → 포트 열기 → 토큰 파일(유효하면 다시 쓰고, 없으면 발급) → 종목 목록 받기 시작 → 요청 받기.
//! 잠금은 키움 요청보다 먼저다. 두 번째 서버는 키움에 아무것도 보내지 않고 끝난다.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use domain::TimeOfDay;
use tokio::net::TcpListener;

use crate::bars::BarService;
use crate::clock::{Clock, next_daily};
use crate::config::Config;
use crate::db::AppDb;
use crate::http::{AppState, router};
use crate::instance::InstanceLock;
use crate::kiwoom::auth::{DAILY_REISSUE_AT, KiwoomAuth};
use crate::kiwoom::rest::{KiwoomRest, Priority};
use crate::kiwoom::token_file::TokenFile;
use crate::kiwoom::transport::ReqwestTransport;
use crate::symbols::SymbolDirectory;

const DAILY_RESET_AT: TimeOfDay = match TimeOfDay::hms(7, 45, 0) {
    Some(t) => t,
    None => unreachable!(),
};
const STARTUP_LIST_RETRY: Duration = Duration::from_secs(10);
const DAILY_LIST_RETRY: Duration = Duration::from_secs(5 * 60);
const DAILY_TOKEN_RETRY: Duration = Duration::from_secs(10 * 60);
const EVICT_EVERY: Duration = Duration::from_secs(60);

pub fn main() -> ExitCode {
    let (config, warnings) = match Config::from_env() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("설정 오류: {e}");
            return ExitCode::from(1);
        }
    };
    init_logging(&config.log_filter);
    for w in warnings {
        tracing::warn!("{w}");
    }
    let lock = match InstanceLock::acquire(&config.lock_path) {
        Ok(lock) => lock,
        Err(e) => {
            tracing::error!("{e}");
            return ExitCode::from(1);
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!(error = %e, "tokio 런타임을 만들 수 없습니다");
            return ExitCode::from(1);
        }
    };
    let token_file = TokenFile::new(config.token_path.clone(), &lock);
    let code = runtime.block_on(serve(config, token_file));
    drop(lock);
    code
}

fn init_logging(filter: &str) {
    let filter = tracing_subscriber::EnvFilter::try_new(filter).unwrap_or_else(|e| {
        eprintln!("VALLY_LOG를 읽을 수 없어 info로 둡니다: {e}");
        tracing_subscriber::EnvFilter::new("info")
    });
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_ansi(false).init();
}

async fn serve(config: Config, token_file: TokenFile) -> ExitCode {
    let db = match AppDb::open(&config.db_path).await {
        Ok(db) => db,
        Err(e) => {
            tracing::error!(path = %config.db_path.display(), error = %e, "사용자 자료 DB를 열 수 없습니다");
            return ExitCode::from(1);
        }
    };
    tracing::info!(path = %config.db_path.display(), "사용자 자료 DB를 열었습니다");
    let listener = match TcpListener::bind(config.bind.socket_addr()).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(addr = %config.bind.socket_addr(), error = %e, "포트를 열 수 없습니다");
            return ExitCode::from(1);
        }
    };
    match listener.local_addr() {
        Ok(addr) => tracing::info!(%addr, "포트를 열었습니다"),
        Err(e) => tracing::warn!(error = %e, "연 주소를 읽지 못했습니다"),
    }
    let transport = match ReqwestTransport::new(config.kiwoom_base_url.clone()) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e.0, "HTTP 클라이언트를 만들 수 없습니다");
            return ExitCode::from(1);
        }
    };
    let clock = Clock::system();
    let rest = KiwoomRest::new(
        Arc::new(transport),
        KiwoomAuth::new(config.kiwoom_app_key.clone(), config.kiwoom_app_secret.clone(), Some(token_file)),
        clock.clone(),
    );
    if !rest.auth().needs_issue(clock.now()) {
        tracing::info!(path = %config.token_path.display(), "파일의 토큰을 다시 씁니다. 발급하지 않습니다");
    } else if let Err(e) = rest.issue_token().await {
        tracing::error!(error = %e, "첫 토큰을 받지 못했습니다. 조회가 들어오면 다시 받아 봅니다");
    }
    let symbols = Arc::new(SymbolDirectory::default());
    tokio::spawn(load_symbols_at_startup(rest.clone(), symbols.clone()));
    let bars = Arc::new(BarService::new(rest.clone(), symbols.clone(), clock.clone()));
    tokio::spawn(evict_idle_series(bars.clone()));
    tokio::spawn(daily_reset(clock.clone(), rest.clone(), symbols.clone(), bars.clone()));
    tokio::spawn(daily_token(clock.clone(), rest.clone()));

    let app = router(Arc::new(AppState { symbols, bars, rest, db, clock, static_dir: config.static_dir.clone() }));
    tracing::info!(static_dir = %config.static_dir.display(), "요청을 받기 시작합니다");
    if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await {
        tracing::error!(error = %e, "서버가 멈췄습니다");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("끝냅니다");
}

/// 켤 때는 `Screen`으로 받고, 실패하면 10초마다 다시 받는다.
async fn load_symbols_at_startup(rest: KiwoomRest, symbols: Arc<SymbolDirectory>) {
    loop {
        match symbols.refresh(&rest, Priority::Screen).await {
            Ok(()) => return,
            Err(_) if rest.halted().is_some() => return,
            Err(e) => {
                tracing::warn!(error = %e, "종목 목록을 받지 못했습니다. 10초 뒤 다시 받습니다");
                tokio::time::sleep(STARTUP_LIST_RETRY).await;
            }
        }
    }
}

async fn evict_idle_series(bars: Arc<BarService>) {
    let mut tick = tokio::time::interval(EVICT_EVERY);
    loop {
        tick.tick().await;
        bars.evict_idle();
    }
}

/// 매일 07:45: 시세 캐시를 모두 비우고 종목 목록을 `Background`로 다시 받는다. 실패하면 5분마다, 다음 07:45 전까지.
async fn daily_reset(clock: Clock, rest: KiwoomRest, symbols: Arc<SymbolDirectory>, bars: Arc<BarService>) {
    loop {
        clock.sleep_until(next_daily(clock.now(), DAILY_RESET_AT)).await;
        bars.clear_all();
        let deadline = next_daily(clock.now(), DAILY_RESET_AT);
        while let Err(e) = symbols.refresh(&rest, Priority::Background).await {
            if rest.halted().is_some() {
                break;
            }
            if clock.now().plus_secs(DAILY_LIST_RETRY.as_secs() as i64) >= deadline {
                break;
            }
            tracing::warn!(error = %e, "종목 목록 갱신에 실패했습니다. 이전 목록을 쓰고 5분 뒤 다시 받습니다");
            tokio::time::sleep(DAILY_LIST_RETRY).await;
        }
    }
}

/// 매일 20:05: 그날 20:05 전에 받은 토큰이면 다시 받는다. 실패하면 07:45까지 10분마다.
async fn daily_token(clock: Clock, rest: KiwoomRest) {
    loop {
        clock.sleep_until(next_daily(clock.now(), DAILY_REISSUE_AT)).await;
        if rest.halted().is_some() || !rest.auth().due_daily_reissue(clock.now()) {
            continue;
        }
        let deadline = next_daily(clock.now(), DAILY_RESET_AT);
        while let Err(e) = rest.issue_token().await {
            if rest.halted().is_some() {
                break;
            }
            if clock.now().plus_secs(DAILY_TOKEN_RETRY.as_secs() as i64) >= deadline {
                tracing::error!(error = %e, "20:05 토큰 발급이 07:45까지 실패했습니다");
                break;
            }
            tracing::warn!(error = %e, "20:05 토큰 발급에 실패했습니다. 10분 뒤 다시 받습니다");
            tokio::time::sleep(DAILY_TOKEN_RETRY).await;
        }
    }
}
