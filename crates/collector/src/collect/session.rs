use std::collections::VecDeque;
use std::convert::Infallible;
use std::fmt;
use std::future::Future;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::{Map, Value};
use server::clock::Clock;
use server::config::Secret;
use server::kiwoom::auth::{AuthError, TokenGen};
use server::kiwoom::error::{Category, CodeKey, WsRejection, classify};
use server::kiwoom::rest::{KiwoomError, KiwoomRest};
use server::kiwoom::wire::{self, WsControl, WsFrame};
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until, timeout};
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use super::link::{ChildLink, Commands, Events};
use super::output::Output;
use super::registry::{Chunk, Registry};
use super::ws::{Connector, Socket};
use crate::protocol::{Command, ProtocolError, Rejection, SessionState};
use crate::raw_write::RawLine;
use crate::shared::LiveTapFeed;

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
    Protocol(ProtocolError),
}

impl Halt {
    pub fn reason(&self) -> String {
        match self {
            Halt::Token(error) => format!("토큰을 받지 못해 멈춥니다: {error}"),
            Halt::TokenState(error) => format!("토큰 상태를 고치지 못해 멈춥니다: {error:?}"),
            Halt::Login(rejection) => format!("LOGIN이 거절돼 멈춥니다({rejection:?})"),
            Halt::Register(rejection) => format!("REG가 거절돼 멈춥니다({rejection:?})"),
            Halt::Output(error) => format!("원문 파일을 쓰지 못해 멈춥니다: {error}"),
            Halt::Protocol(error) => format!("데몬이 보낸 줄을 처리하지 못해 멈춥니다: {error}"),
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
            Halt::Protocol(_) => "데몬과 수집기의 프로토콜 버전이 같은지, 데몬이 명령을 형식대로 보내는지 확인하세요",
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
    Command(Command),
    Deadline,
}

enum Waited<T> {
    Done(T),
    Command(Command),
}

#[derive(Debug, Clone)]
pub struct Credential {
    token: Secret<String>,
    generation: u64,
}

pub struct Issuer {
    rest: KiwoomRest,
    clock: Clock,
    budget: TokenBudget,
}

pub enum Tokens {
    Issue(Issuer),
    Supplied(Option<Credential>),
}

impl Tokens {
    pub fn issued(rest: KiwoomRest, clock: Clock) -> Tokens {
        Tokens::Issue(Issuer { rest, clock, budget: TokenBudget::Fresh })
    }

    pub fn supplied() -> Tokens {
        Tokens::Supplied(None)
    }

    fn credential(&self) -> Option<Credential> {
        match self {
            Tokens::Issue(issuer) => issuer
                .rest
                .auth()
                .current(issuer.clock.now())
                .map(|(token, TokenGen(generation))| Credential { token, generation }),
            Tokens::Supplied(credential) => credential.clone(),
        }
    }

    fn confirmed(&mut self) {
        if let Tokens::Issue(issuer) = self {
            issuer.budget = TokenBudget::Fresh;
        }
    }

    fn rejected(&mut self, credential: &Credential, events: &Events) -> Result<bool, AuthError> {
        match self {
            Tokens::Issue(issuer) if issuer.budget == TokenBudget::Fresh => {
                issuer.budget = TokenBudget::Reissued;
                issuer.rest.auth().invalidate(TokenGen(credential.generation))?;
                Ok(true)
            }
            Tokens::Issue(_) => Ok(false),
            Tokens::Supplied(slot) => {
                events.token_invalid(credential.generation);
                if slot.as_ref().is_some_and(|held| held.generation == credential.generation) {
                    *slot = None;
                }
                Ok(true)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpKind {
    Register,
    Remove,
}

struct Op {
    kind: OpKind,
    chunk: Chunk,
    replay: bool,
}

impl Op {
    fn control(&self) -> WsControl {
        match self.kind {
            OpKind::Register => WsControl::Reg,
            OpKind::Remove => WsControl::Remove,
        }
    }

    fn message(&self) -> String {
        match self.kind {
            OpKind::Register => self.chunk.register_message(),
            OpKind::Remove => self.chunk.remove_message(),
        }
    }
}

fn rejection_event(rejection: &WsRejection) -> Rejection {
    Rejection {
        reason: format!("{:?}", rejection.category),
        return_code: rejection.return_code,
        detail: rejection.detail,
    }
}

async fn next_incoming(commands: &mut Option<Commands>) -> Result<Command, Exit> {
    let Some(receiver) = commands else {
        return std::future::pending().await;
    };
    match receiver.recv().await {
        Some(Ok(command)) => Ok(command),
        Some(Err(error)) => Err(Halt::Protocol(error).into()),
        None => Err(Exit::Shutdown),
    }
}

async fn next_command(shutdown: &mut watch::Receiver<bool>, commands: &mut Option<Commands>) -> Result<Command, Exit> {
    if *shutdown.borrow() {
        return Err(Exit::Shutdown);
    }
    tokio::select! {
        command = next_incoming(commands) => command,
        _ = shutdown.changed() => Err(Exit::Shutdown),
    }
}

async fn interruptible<T>(
    shutdown: &mut watch::Receiver<bool>,
    commands: &mut Option<Commands>,
    work: &mut (impl Future<Output = T> + Unpin),
) -> Result<Waited<T>, Exit> {
    if *shutdown.borrow() {
        return Err(Exit::Shutdown);
    }
    tokio::select! {
        output = &mut *work => Ok(Waited::Done(output)),
        command = next_incoming(commands) => command.map(Waited::Command),
        _ = shutdown.changed() => Err(Exit::Shutdown),
    }
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
    pub tokens: Tokens,
    pub registry: Registry,
    pub output: Output,
    pub connector: Arc<dyn Connector>,
    pub wall_clock: Arc<dyn WallClock>,
    pub timings: Timings,
    pub shutdown: watch::Receiver<bool>,
    pub child: Option<ChildLink>,
    pub tap: Option<LiveTapFeed>,
}

pub struct Session {
    tokens: Tokens,
    registry: Registry,
    queue: VecDeque<Op>,
    out: Output,
    connector: Arc<dyn Connector>,
    wall_clock: Arc<dyn WallClock>,
    timings: Timings,
    shutdown: watch::Receiver<bool>,
    commands: Option<Commands>,
    events: Events,
    state: watch::Sender<SessionState>,
    tap: Option<LiveTapFeed>,
    halt_on_rejected_register: bool,
    gap: Gap,
    attempt: u32,
    retry_at: Instant,
    live_since: Option<Instant>,
    logged_in: bool,
    confirmed_any: bool,
    live: bool,
}

impl Session {
    pub fn new(parts: SessionParts) -> Session {
        let child = parts.child;
        let halt_on_rejected_register = child.is_none();
        let (commands, events, state) = match child {
            Some(link) => (Some(link.commands), link.events, link.state),
            None => (None, Events::none(), watch::channel(SessionState::Backoff).0),
        };
        Session {
            tokens: parts.tokens,
            registry: parts.registry,
            queue: VecDeque::new(),
            out: parts.output,
            connector: parts.connector,
            wall_clock: parts.wall_clock,
            timings: parts.timings,
            shutdown: parts.shutdown,
            commands,
            events,
            state,
            tap: parts.tap,
            halt_on_rejected_register,
            gap: Gap::Unknown,
            attempt: 0,
            retry_at: Instant::now(),
            live_since: None,
            logged_in: false,
            confirmed_any: false,
            live: false,
        }
    }

    pub async fn run(mut self) -> Finish {
        let exit = self.drive().await;
        let (reason, mut finish) = match exit {
            Exit::Shutdown => ("종료".to_owned(), Finish::Shutdown),
            Exit::Halt(halt) => (halt.reason(), Finish::Halted(halt)),
        };
        let written = match &finish {
            Finish::Halted(_) => self.write_down(&reason),
            Finish::Shutdown => self.mark_down(&reason),
        };
        if let Finish::Halted(halt) = &finish {
            self.events.halted(&halt.reason(), halt.action());
        }
        if let Err(Exit::Halt(Halt::Output(error))) = written {
            tracing::error!(%error, "down 사건 줄을 쓰지 못했습니다");
            if matches!(finish, Finish::Shutdown) {
                finish = Finish::Halted(Halt::Output(error));
            }
        }
        if let Err(error) = self.out.close() {
            tracing::error!(%error, "원문 파일을 닫지 못했습니다");
            if matches!(finish, Finish::Shutdown) {
                finish = Finish::Halted(Halt::Output(error));
            }
        }
        finish
    }

    fn set_state(&self, state: SessionState) {
        self.state.send_replace(state);
    }

    async fn wait_for<T>(&mut self, work: impl Future<Output = T>) -> Result<T, Exit> {
        let mut work = Box::pin(work);
        loop {
            match interruptible(&mut self.shutdown, &mut self.commands, &mut work).await? {
                Waited::Done(output) => return Ok(output),
                Waited::Command(command) => self.take_command(command)?,
            }
        }
    }

    async fn drive(&mut self) -> Exit {
        loop {
            if self.retry_at > Instant::now() {
                self.set_state(SessionState::Backoff);
            }
            if let Err(exit) = self.wait_for(sleep_until(self.retry_at)).await {
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
            self.set_state(SessionState::Connecting);
            let (connector, control) = (self.connector.clone(), self.timings.control);
            let connected = match self.wait_for(async move { timeout(control, connector.connect()).await }).await {
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
            self.logged_in = false;
            self.queue.clear();
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

    fn write_down(&mut self, reason: &str) -> Result<(), Exit> {
        self.events.down(reason);
        let recv_ms = self.wall_clock.now_ms();
        if let Some(tap) = &self.tap {
            tap.on_link(recv_ms, false);
        }
        self.out.write_event(&RawLine::Down { recv_ms, reason })?;
        Ok(())
    }

    fn mark_down(&mut self, reason: &str) -> Result<(), Exit> {
        if self.gap != Gap::Down {
            self.write_down(reason)?;
            self.out.flush_if_dirty()?;
            self.gap = Gap::Down;
        }
        Ok(())
    }

    async fn ensure_token(&mut self) -> Result<TokenReady, Exit> {
        if let Tokens::Issue(issuer) = &mut self.tokens {
            return issuer.ensure(&mut self.shutdown, &self.timings, &mut self.attempt).await;
        }
        self.set_state(SessionState::WaitingForToken);
        while self.tokens.credential().is_none() {
            let command = next_command(&mut self.shutdown, &mut self.commands).await?;
            self.take_command(command)?;
        }
        Ok(TokenReady::Ready)
    }

    fn take_command(&mut self, command: Command) -> Result<(), Exit> {
        match command {
            Command::Token { token, generation, .. } => {
                if let Tokens::Supplied(slot) = &mut self.tokens {
                    *slot = Some(Credential { token, generation });
                }
            }
            Command::Assign { .. } => {}
            Command::Register(registration) => {
                let chunks = self.registry.add(Chunk::split(&registration));
                self.queue_ops(OpKind::Register, chunks);
            }
            Command::Unregister(registration) => {
                let chunks = Chunk::split(&registration);
                self.registry.remove(&chunks);
                self.queue_ops(OpKind::Remove, chunks);
            }
            Command::Shutdown => return Err(Exit::Shutdown),
        }
        Ok(())
    }

    fn queue_ops(&mut self, kind: OpKind, chunks: Vec<Chunk>) {
        if self.logged_in {
            self.queue.extend(chunks.into_iter().map(|chunk| Op { kind, chunk, replay: false }));
        }
    }

    async fn serve(&mut self, conn: &mut Conn) -> Interrupt {
        match self.serve_connection(conn).await {
            Err(interrupt) => interrupt,
            Ok(never) => match never {},
        }
    }

    async fn serve_connection(&mut self, conn: &mut Conn) -> Result<Infallible, Interrupt> {
        self.live = false;
        self.confirmed_any = false;
        self.log_in(conn).await?;
        self.begin_registration();
        self.drain_queue(conn).await?;
        self.announce_live_if_ready()?;
        loop {
            match self.recv(conn, None).await? {
                Wake::Command(command) => {
                    self.take_command(command)?;
                    self.drain_queue(conn).await?;
                    self.announce_live_if_ready()?;
                }
                Wake::Ack(control, _) => tracing::debug!(trnm = control.trnm(), "기다리지 않던 응답을 버립니다"),
                Wake::Deadline => {}
            }
        }
    }

    fn begin_registration(&mut self) {
        self.logged_in = true;
        self.set_state(SessionState::Registering);
        self.queue = self.registry.replay().into_iter().map(|chunk| Op { kind: OpKind::Register, replay: chunk.sent, chunk }).collect();
    }

    fn announce_live_if_ready(&mut self) -> Result<(), Exit> {
        if self.live || !self.confirmed_any {
            return Ok(());
        }
        let recv_ms = self.wall_clock.now_ms();
        self.out.write_event(&RawLine::Live { recv_ms })?;
        if let Some(tap) = &self.tap {
            tap.on_link(recv_ms, true);
        }
        self.gap = Gap::Up;
        self.tokens.confirmed();
        self.live_since = Some(Instant::now());
        self.live = true;
        self.set_state(SessionState::Live);
        self.events.live();
        tracing::info!("수집을 시작합니다(LOGIN과 REG 완료)");
        Ok(())
    }

    async fn log_in(&mut self, conn: &mut Conn) -> Result<(), Interrupt> {
        self.set_state(SessionState::LoggingIn);
        let Some(credential) = self.tokens.credential() else {
            return Err(End::TokenGone.into());
        };
        let login = wire::login_message(&credential.token);
        conn.send(login.expose().clone()).await?;
        match self.await_ack(conn, WsControl::Login).await? {
            Ok(()) => Ok(()),
            Err(rejection) if rejection.category == Category::TokenInvalid => match self.tokens.rejected(&credential, &self.events) {
                Ok(true) => {
                    tracing::warn!(?rejection, "LOGIN이 토큰 무효로 거절됐습니다. 새 토큰을 기다립니다");
                    Err(Interrupt::TokenRefresh)
                }
                Ok(false) => Err(Exit::Halt(Halt::Login(rejection)).into()),
                Err(error) => Err(Exit::Halt(Halt::TokenState(error)).into()),
            },
            Err(rejection) => Err(Exit::Halt(Halt::Login(rejection)).into()),
        }
    }

    async fn drain_queue(&mut self, conn: &mut Conn) -> Result<(), Interrupt> {
        while let Some(op) = self.queue.pop_front() {
            self.send_op(conn, op).await?;
        }
        Ok(())
    }

    async fn send_op(&mut self, conn: &mut Conn, op: Op) -> Result<(), Interrupt> {
        let message = op.message();
        if op.kind == OpKind::Register {
            self.registry.mark_sent(op.chunk.seq);
        }
        conn.send(message.clone()).await?;
        let mut result = self.await_ack(conn, op.control()).await?;
        if matches!(&result, Err(rejection) if rejection.category == Category::RateLimit) {
            tracing::warn!(trnm = op.control().trnm(), "유량 제한으로 거절됐습니다. 한 번 다시 보냅니다");
            self.pause(conn, Instant::now() + self.timings.rate_limit_pause).await?;
            conn.send(message).await?;
            result = self.await_ack(conn, op.control()).await?;
        }
        self.finish_op(&op, result)?;
        Ok(())
    }

    fn finish_op(&mut self, op: &Op, result: Result<(), WsRejection>) -> Result<(), Exit> {
        match (op.kind, result) {
            (OpKind::Register, Ok(())) => {
                self.confirmed_any = true;
                self.registry.accepted(&op.chunk);
                self.events.registered(op.chunk.batch(), op.replay, None);
            }
            (OpKind::Register, Err(rejection)) => {
                if self.halt_on_rejected_register {
                    return Err(Halt::Register(rejection).into());
                }
                tracing::warn!(?rejection, id = op.chunk.id, part = op.chunk.part, "REG가 거절됐습니다. 이 묶음은 다시 보내지 않습니다");
                self.registry.forget(&op.chunk);
                self.events.registered(op.chunk.batch(), op.replay, Some(rejection_event(&rejection)));
            }
            (OpKind::Remove, result) => {
                let rejection = result.err().map(|rejection| rejection_event(&rejection));
                self.events.unregistered(op.chunk.batch(), rejection);
            }
        }
        Ok(())
    }

    async fn pause(&mut self, conn: &mut Conn, until: Instant) -> Result<(), Interrupt> {
        loop {
            match self.recv(conn, Some(until)).await? {
                Wake::Deadline => return Ok(()),
                Wake::Command(command) => self.take_command(command)?,
                Wake::Ack(..) => {}
            }
        }
    }

    async fn await_ack(&mut self, conn: &mut Conn, control: WsControl) -> Result<Result<(), WsRejection>, Interrupt> {
        let deadline = Instant::now() + self.timings.control;
        loop {
            match self.recv(conn, Some(deadline)).await? {
                Wake::Ack(got, result) if got == control => return Ok(result),
                Wake::Ack(got, _) => tracing::debug!(trnm = got.trnm(), want = control.trnm(), "기다리던 것과 다른 응답을 버립니다"),
                Wake::Command(command) => self.take_command(command)?,
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
                command = next_incoming(&mut self.commands) => return Ok(Wake::Command(command?)),
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
            if let Some(wake) = self.handle_text(conn, &text, recv_ms).await? {
                return Ok(wake);
            }
        }
    }

    async fn handle_text(&mut self, conn: &mut Conn, bytes: &Utf8Bytes, recv_ms: i64) -> Result<Option<Wake>, Interrupt> {
        let text = bytes.as_str();
        match classify_frame(text) {
            FrameKind::Ping => conn.send(text.to_owned()).await?,
            FrameKind::NotJson => self.out.write_text(recv_ms, text)?,
            FrameKind::Real => {
                self.out.write_frame(recv_ms, text)?;
                if let Some(tap) = &self.tap {
                    tap.offer_frame(recv_ms, bytes);
                }
                self.report_market_hours(text, recv_ms);
            }
            FrameKind::Control => {
                self.out.write_frame(recv_ms, text)?;
                if let Ok(WsFrame::Ack { control, result }) = wire::parse_ws_frame(text) {
                    return Ok(Some(Wake::Ack(control, result)));
                }
            }
        }
        Ok(None)
    }

    fn report_market_hours(&self, text: &str, recv_ms: i64) {
        if !self.events.enabled() || !text.contains(MARKET_HOURS_MARK) {
            return;
        }
        let Ok(frame) = serde_json::from_str::<RealFrame>(text) else {
            return;
        };
        for entry in frame.data.into_iter().filter(|entry| entry.kind.as_deref() == Some("0s")) {
            self.events.market_open(recv_ms, entry.values);
        }
    }
}

const MARKET_HOURS_MARK: &str = "\"0s\"";

#[derive(Deserialize)]
struct RealFrame {
    #[serde(default)]
    data: Vec<RealEntry>,
}

#[derive(Deserialize)]
struct RealEntry {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    values: Map<String, Value>,
}

impl Issuer {
    async fn ensure(&mut self, shutdown: &mut watch::Receiver<bool>, timings: &Timings, attempt: &mut u32) -> Result<TokenReady, Exit> {
        if let Some(error) = self.rest.halted() {
            return Err(Halt::Token(error).into());
        }
        if self.rest.auth().current(self.clock.now()).is_some() {
            return Ok(TokenReady::Ready);
        }
        match or_shutdown(shutdown, self.rest.issue_token()).await? {
            Ok(_) => Ok(TokenReady::Ready),
            Err(error) if self.rest.halted().is_some() || error.manual_action_required() => Err(Halt::Token(error).into()),
            Err(error) => {
                tracing::warn!(%error, "WebSocket에 쓸 토큰을 받지 못했습니다");
                Ok(TokenReady::WaitFor(match error.retry_at() {
                    Some(until) => Duration::from_secs((until.unix() - self.clock.now().unix()).max(0) as u64),
                    None => {
                        let wait = timings.backoff(*attempt);
                        *attempt += 1;
                        wait
                    }
                }))
            }
        }
    }
}

#[cfg(test)]
mod tokens_tests {
    use super::*;

    fn credential(generation: u64) -> Credential {
        Credential { token: Secret::new(format!("FAKE-TOKEN-{generation}")), generation }
    }

    #[test]
    fn a_rejection_clears_only_the_token_of_the_rejected_generation() {
        let (sink, source) = std::sync::mpsc::channel();
        let events = Events::to(sink);
        let mut tokens = Tokens::Supplied(Some(credential(2)));
        assert!(tokens.rejected(&credential(1), &events).unwrap());
        assert_eq!(tokens.credential().unwrap().generation, 2, "더 새 토큰은 남는다");
        assert!(tokens.rejected(&credential(2), &events).unwrap());
        assert!(tokens.credential().is_none());
        let reported: Vec<_> = source.try_iter().collect();
        assert_eq!(reported, [crate::protocol::Event::TokenInvalid { generation: 1 }, crate::protocol::Event::TokenInvalid { generation: 2 }]);
    }
}
