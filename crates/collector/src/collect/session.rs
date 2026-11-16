use std::convert::Infallible;
use std::fmt;
use std::future::Future;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde::de::IgnoredAny;
use server::clock::Clock;
use server::kiwoom::auth::AuthError;
use server::kiwoom::error::{Category, CodeKey, WsRejection, classify};
use server::kiwoom::rest::{KiwoomError, KiwoomRest};
use server::kiwoom::wire::{self, WsControl, WsFrame};
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until, timeout};
use tokio_tungstenite::tungstenite::Message;

use super::output::Output;
use super::ws::{Connector, Socket};
use crate::raw_write::RawLine;

pub const STREAM_TYPES: [&str; 4] = ["0B", "0D", "0w", "0F"];

pub trait WallClock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemWallClock;

impl WallClock for SystemWallClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Timings {
    pub control: Duration,
    pub silence: Duration,
    pub backoff: [Duration; 5],
    pub stable_after: Duration,
    pub rate_limit_pause: Duration,
}

impl Default for Timings {
    fn default() -> Timings {
        Timings {
            control: Duration::from_secs(5),
            silence: Duration::from_secs(30),
            backoff: [1, 2, 5, 10, 30].map(Duration::from_secs),
            stable_after: Duration::from_secs(60),
            rate_limit_pause: Duration::from_secs(1),
        }
    }
}

impl Timings {
    fn backoff(&self, attempt: u32) -> Duration {
        self.backoff[(attempt as usize).min(self.backoff.len() - 1)]
    }
}

#[derive(Debug)]
pub enum Halt {
    Token(KiwoomError),
    TokenState(AuthError),
    Login(WsRejection),
    Register(WsRejection),
    Output(io::Error),
}

impl Halt {
    pub fn reason(&self) -> String {
        match self {
            Halt::Token(error) => format!("토큰을 받지 못해 멈춥니다: {error}"),
            Halt::TokenState(error) => format!("토큰 상태를 고치지 못해 멈춥니다: {error:?}"),
            Halt::Login(rejection) => format!("LOGIN이 거절돼 멈춥니다({rejection:?})"),
            Halt::Register(rejection) => format!("REG가 거절돼 멈춥니다({rejection:?})"),
            Halt::Output(error) => format!("원문 파일을 쓰지 못해 멈춥니다: {error}"),
        }
    }

    pub fn action(&self) -> &'static str {
        match self {
            Halt::Token(KiwoomError::TokenFile(_)) => "토큰 파일의 권한(chmod 600)과 내용을 확인하세요. 폴더 권한은 700이어야 합니다",
            Halt::Token(error) if error.failure().and_then(|failure| failure.detail()) == Some(CodeKey::Rest(8050)) => {
                "키움 포털에서 지금 공인 IP가 등록돼 있는지 확인하세요. 반복 발급 잠금이면 포털에서 해제됐는지 확인하세요"
            }
            Halt::Token(_) => "수집기 전용 앱키와 시크릿이 맞는지, 키움 포털의 계정 상태가 정상인지 확인하세요",
            Halt::TokenState(_) => "토큰 파일을 확인하고 수집기를 다시 실행하세요",
            Halt::Login(_) => "수집기 전용 키가 다른 프로세스와 겹치지 않는지, 앱키와 시크릿이 맞는지 확인하세요",
            Halt::Register(rejection) if rejection.category == Category::RealtimeCapacity => "등록 한도를 넘었습니다. --items의 종목 수를 줄여 다시 실행하세요",
            Halt::Register(_) => "--items의 종목 코드와 개수를 확인하세요. 같은 입력으로 다시 접속하면 같은 거절이 반복됩니다",
            Halt::Output(_) => "데이터 폴더의 디스크 공간과 권한을 확인하세요",
        }
    }
}

#[derive(Debug)]
pub enum Finish {
    Shutdown,
    Halted(Halt),
}

#[derive(Debug)]
enum Exit {
    Shutdown,
    Halt(Halt),
}

impl From<Halt> for Exit {
    fn from(halt: Halt) -> Exit {
        Exit::Halt(halt)
    }
}

impl From<io::Error> for Exit {
    fn from(error: io::Error) -> Exit {
        Exit::Halt(Halt::Output(error))
    }
}

#[derive(Debug)]
enum End {
    Closed(Option<u16>),
    Silent,
    Transport(String),
    ControlTimeout(WsControl),
    TokenGone,
}

impl fmt::Display for End {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            End::Closed(Some(code)) => write!(formatter, "키움이 연결을 닫았습니다(close {code}, {:?})", classify(CodeKey::WsClose(*code))),
            End::Closed(None) => formatter.write_str("close 프레임 없이 연결이 끊겼습니다"),
            End::Silent => formatter.write_str("정한 시간 동안 아무 메시지도 오지 않았습니다"),
            End::Transport(error) => write!(formatter, "WebSocket 전송 오류: {error}"),
            End::ControlTimeout(control) => write!(formatter, "{} 응답이 시간 안에 오지 않았습니다", control.trnm()),
            End::TokenGone => formatter.write_str("LOGIN에 쓸 토큰이 없습니다"),
        }
    }
}

#[derive(Debug)]
enum Interrupt {
    Ended(End),
    Exit(Exit),
    TokenRefresh,
}

impl From<End> for Interrupt {
    fn from(end: End) -> Interrupt {
        Interrupt::Ended(end)
    }
}

impl From<Exit> for Interrupt {
    fn from(exit: Exit) -> Interrupt {
        Interrupt::Exit(exit)
    }
}

impl From<io::Error> for Interrupt {
    fn from(error: io::Error) -> Interrupt {
        Interrupt::Exit(error.into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenBudget {
    Fresh,
    Reissued,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gap {
    Unknown,
    Up,
    Down,
}

enum TokenReady {
    Ready,
    WaitFor(Duration),
}

enum Wake {
    Ack(WsControl, Result<(), WsRejection>),
    Deadline,
}

struct Conn {
    ws: Socket,
    silence: Duration,
    silent_at: Instant,
}

impl Conn {
    fn new(ws: Socket, silence: Duration) -> Conn {
        Conn { ws, silence, silent_at: Instant::now() + silence }
    }

    fn touch(&mut self) {
        self.silent_at = Instant::now() + self.silence;
    }

    async fn send(&mut self, text: String) -> Result<(), End> {
        self.ws.send(Message::Text(text.into())).await.map_err(|error| End::Transport(error.to_string()))
    }

    async fn close(mut self) {
        let _ = timeout(self.silence, self.ws.close()).await;
    }
}

#[derive(Deserialize)]
struct FrameHead<'a> {
    #[serde(borrow)]
    trnm: Option<&'a str>,
}

enum FrameKind {
    Ping,
    Real,
    Control,
    NotJson,
}

fn classify_frame(text: &str) -> FrameKind {
    let head = if text.trim_start().starts_with('{') { serde_json::from_str::<FrameHead<'_>>(text).ok() } else { None };
    match head {
        Some(FrameHead { trnm: Some("PING") }) => FrameKind::Ping,
        Some(FrameHead { trnm: Some("REAL") }) => FrameKind::Real,
        Some(_) => FrameKind::Control,
        None if serde_json::from_str::<IgnoredAny>(text).is_ok() => FrameKind::Control,
        None => FrameKind::NotJson,
    }
}

pub fn register_message(registrations: &[String]) -> String {
    serde_json::json!({
        "trnm": "REG",
        "grp_no": "1",
        "refresh": "1",
        "data": [{"item": registrations, "type": STREAM_TYPES}],
    })
    .to_string()
}

async fn or_shutdown<T>(shutdown: &mut watch::Receiver<bool>, work: impl Future<Output = T>) -> Result<T, Exit> {
    if *shutdown.borrow() {
        return Err(Exit::Shutdown);
    }
    tokio::select! {
        output = work => Ok(output),
        _ = shutdown.changed() => Err(Exit::Shutdown),
    }
}

pub struct SessionParts {
    pub rest: KiwoomRest,
    pub registrations: Vec<String>,
    pub output: Output,
    pub connector: Arc<dyn Connector>,
    pub wall_clock: Arc<dyn WallClock>,
    pub token_clock: Clock,
    pub timings: Timings,
    pub shutdown: watch::Receiver<bool>,
}

pub struct Session {
    rest: KiwoomRest,
    register: String,
    out: Output,
    connector: Arc<dyn Connector>,
    wall_clock: Arc<dyn WallClock>,
    token_clock: Clock,
    timings: Timings,
    shutdown: watch::Receiver<bool>,
    budget: TokenBudget,
    gap: Gap,
    attempt: u32,
    retry_at: Instant,
    live_since: Option<Instant>,
}

impl Session {
    pub fn new(parts: SessionParts) -> Session {
        Session {
            rest: parts.rest,
            register: register_message(&parts.registrations),
            out: parts.output,
            connector: parts.connector,
            wall_clock: parts.wall_clock,
            token_clock: parts.token_clock,
            timings: parts.timings,
            shutdown: parts.shutdown,
            budget: TokenBudget::Fresh,
            gap: Gap::Unknown,
            attempt: 0,
            retry_at: Instant::now(),
            live_since: None,
        }
    }

    pub async fn run(mut self) -> Finish {
        let exit = self.drive().await;
        let (reason, mut finish) = match exit {
            Exit::Shutdown => ("종료".to_owned(), Finish::Shutdown),
            Exit::Halt(halt) => (halt.reason(), Finish::Halted(halt)),
        };
        if let Err(Exit::Halt(Halt::Output(error))) = self.mark_down(&reason) {
            tracing::error!(%error, "down 사건 줄을 쓰지 못했습니다");
        }
        if let Err(error) = self.out.close() {
            tracing::error!(%error, "원문 파일을 닫지 못했습니다");
            if matches!(finish, Finish::Shutdown) {
                finish = Finish::Halted(Halt::Output(error));
            }
        }
        finish
    }

    async fn drive(&mut self) -> Exit {
        loop {
            if let Err(exit) = or_shutdown(&mut self.shutdown, sleep_until(self.retry_at)).await {
                return exit;
            }
            match self.ensure_token().await {
                Err(exit) => return exit,
                Ok(TokenReady::WaitFor(wait)) => {
                    self.retry_at = Instant::now() + wait;
                    continue;
                }
                Ok(TokenReady::Ready) => {}
            }
            let connected = match or_shutdown(&mut self.shutdown, timeout(self.timings.control, self.connector.connect())).await {
                Err(exit) => return exit,
                Ok(Ok(Ok(socket))) => Some(Conn::new(socket, self.timings.silence)),
                Ok(Ok(Err(error))) => {
                    tracing::warn!(%error, "키움 WebSocket에 연결하지 못했습니다");
                    None
                }
                Ok(Err(_)) => {
                    tracing::warn!("키움 WebSocket 연결이 시간 안에 끝나지 않았습니다");
                    None
                }
            };
            let Some(mut conn) = connected else {
                self.retry_later();
                continue;
            };
            self.live_since = None;
            let interrupt = self.serve(&mut conn).await;
            conn.close().await;
            if let Err(error) = self.out.flush_if_dirty() {
                return error.into();
            }
            match interrupt {
                Interrupt::Exit(exit) => return exit,
                Interrupt::TokenRefresh => {
                    if let Err(exit) = self.mark_down("LOGIN이 토큰 무효로 거절됐습니다") {
                        return exit;
                    }
                    self.retry_at = Instant::now();
                }
                Interrupt::Ended(end) => {
                    tracing::warn!(%end, "키움 WebSocket 세션이 끊겼습니다");
                    if let Err(exit) = self.mark_down(&end.to_string()) {
                        return exit;
                    }
                    if self.live_since.is_some_and(|since| since.elapsed() >= self.timings.stable_after) {
                        self.attempt = 0;
                    }
                    self.retry_later();
                }
            }
        }
    }

    fn retry_later(&mut self) {
        self.retry_at = Instant::now() + self.timings.backoff(self.attempt);
        self.attempt += 1;
    }

    fn mark_down(&mut self, reason: &str) -> Result<(), Exit> {
        if self.gap != Gap::Down {
            let recv_ms = self.wall_clock.now_ms();
            self.out.write_event(&RawLine::Down { recv_ms, reason })?;
            self.out.flush_if_dirty()?;
            self.gap = Gap::Down;
        }
        Ok(())
    }

    async fn ensure_token(&mut self) -> Result<TokenReady, Exit> {
        if let Some(error) = self.rest.halted() {
            return Err(Halt::Token(error).into());
        }
        if self.rest.auth().current(self.token_clock.now()).is_some() {
            return Ok(TokenReady::Ready);
        }
        match or_shutdown(&mut self.shutdown, self.rest.issue_token()).await? {
            Ok(_) => Ok(TokenReady::Ready),
            Err(error) if self.rest.halted().is_some() || error.manual_action_required() => Err(Halt::Token(error).into()),
            Err(error) => {
                tracing::warn!(%error, "WebSocket에 쓸 토큰을 받지 못했습니다");
                Ok(TokenReady::WaitFor(match error.retry_at() {
                    Some(until) => Duration::from_secs((until.unix() - self.token_clock.now().unix()).max(0) as u64),
                    None => {
                        let wait = self.timings.backoff(self.attempt);
                        self.attempt += 1;
                        wait
                    }
                }))
            }
        }
    }

    async fn serve(&mut self, conn: &mut Conn) -> Interrupt {
        match self.serve_connection(conn).await {
            Err(interrupt) => interrupt,
            Ok(never) => match never {},
        }
    }

    async fn serve_connection(&mut self, conn: &mut Conn) -> Result<Infallible, Interrupt> {
        self.log_in(conn).await?;
        self.register(conn).await?;
        let recv_ms = self.wall_clock.now_ms();
        self.out.write_event(&RawLine::Live { recv_ms })?;
        self.gap = Gap::Up;
        self.budget = TokenBudget::Fresh;
        self.live_since = Some(Instant::now());
        tracing::info!("수집을 시작합니다(LOGIN과 REG 완료)");
        loop {
            if let Wake::Ack(control, _) = self.recv(conn, None).await? {
                tracing::debug!(trnm = control.trnm(), "기다리지 않던 응답을 버립니다");
            }
        }
    }

    async fn log_in(&mut self, conn: &mut Conn) -> Result<(), Interrupt> {
        let Some((token, generation)) = self.rest.auth().current(self.token_clock.now()) else {
            return Err(End::TokenGone.into());
        };
        let login = wire::login_message(&token);
        conn.send(login.expose().clone()).await?;
        match self.await_ack(conn, WsControl::Login).await? {
            Ok(()) => Ok(()),
            Err(rejection) if rejection.category == Category::TokenInvalid && self.budget == TokenBudget::Fresh => {
                tracing::warn!(?rejection, "LOGIN이 토큰 무효로 거절됐습니다. 토큰을 한 번 다시 받습니다");
                self.budget = TokenBudget::Reissued;
                self.rest.auth().invalidate(generation).map_err(|error| Exit::Halt(Halt::TokenState(error)))?;
                Err(Interrupt::TokenRefresh)
            }
            Err(rejection) => Err(Exit::Halt(Halt::Login(rejection)).into()),
        }
    }

    async fn register(&mut self, conn: &mut Conn) -> Result<(), Interrupt> {
        conn.send(self.register.clone()).await?;
        let Err(rejection) = self.await_ack(conn, WsControl::Reg).await? else {
            return Ok(());
        };
        if rejection.category != Category::RateLimit {
            return Err(Exit::Halt(Halt::Register(rejection)).into());
        }
        tracing::warn!(?rejection, "REG가 유량 제한으로 거절됐습니다. 한 번 다시 보냅니다");
        let until = Instant::now() + self.timings.rate_limit_pause;
        while !matches!(self.recv(conn, Some(until)).await?, Wake::Deadline) {}
        conn.send(self.register.clone()).await?;
        match self.await_ack(conn, WsControl::Reg).await? {
            Ok(()) => Ok(()),
            Err(rejection) => Err(Exit::Halt(Halt::Register(rejection)).into()),
        }
    }

    async fn await_ack(&mut self, conn: &mut Conn, control: WsControl) -> Result<Result<(), WsRejection>, Interrupt> {
        let deadline = Instant::now() + self.timings.control;
        loop {
            match self.recv(conn, Some(deadline)).await? {
                Wake::Ack(got, result) if got == control => return Ok(result),
                Wake::Ack(got, _) => tracing::debug!(trnm = got.trnm(), want = control.trnm(), "기다리던 것과 다른 응답을 버립니다"),
                Wake::Deadline => return Err(End::ControlTimeout(control).into()),
            }
        }
    }

    async fn recv(&mut self, conn: &mut Conn, deadline: Option<Instant>) -> Result<Wake, Interrupt> {
        loop {
            let message = tokio::select! {
                message = conn.ws.next() => message,
                () = sleep_until(conn.silent_at) => return Err(End::Silent.into()),
                () = sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => return Ok(Wake::Deadline),
                _ = self.out.flush_tick.tick() => {
                    self.out.flush_if_dirty()?;
                    continue;
                }
                _ = self.out.report_tick.tick() => {
                    self.out.report();
                    continue;
                }
                _ = self.shutdown.changed() => return Err(Exit::Shutdown.into()),
            };
            let recv_ms = self.wall_clock.now_ms();
            let text = match message {
                Some(Ok(Message::Text(text))) => text,
                Some(Ok(Message::Close(frame))) => return Err(End::Closed(frame.map(|frame| u16::from(frame.code))).into()),
                Some(Ok(Message::Ping(_))) => {
                    conn.touch();
                    conn.ws.flush().await.map_err(|error| End::Transport(error.to_string()))?;
                    continue;
                }
                Some(Ok(_)) => {
                    conn.touch();
                    continue;
                }
                Some(Err(error)) => return Err(End::Transport(error.to_string()).into()),
                None => return Err(End::Closed(None).into()),
            };
            conn.touch();
            if let Some(wake) = self.handle_text(conn, text.as_str(), recv_ms).await? {
                return Ok(wake);
            }
        }
    }

    async fn handle_text(&mut self, conn: &mut Conn, text: &str, recv_ms: i64) -> Result<Option<Wake>, Interrupt> {
        match classify_frame(text) {
            FrameKind::Ping => conn.send(text.to_owned()).await?,
            FrameKind::NotJson => self.out.write_text(recv_ms, text)?,
            FrameKind::Real => self.out.write_frame(recv_ms, text)?,
            FrameKind::Control => {
                self.out.write_frame(recv_ms, text)?;
                if let Ok(WsFrame::Ack { control, result }) = wire::parse_ws_frame(text) {
                    return Ok(Some(Wake::Ack(control, result)));
                }
            }
        }
        Ok(None)
    }
}
