//! 키움 WebSocket 세션(backend.md §5.1, §5.2). 토큰 하나에 세션 하나라서 서버 안에서도 세션은 언제나 하나다.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use domain::{IndexCode, KstTime, Price, Symbol, TimeOfDay, Volume};
use futures::{Sink, SinkExt, Stream, StreamExt, future::BoxFuture};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep_until, timeout};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::connect_async;

use super::error::{Category, CodeKey, WsRejection, classify};
use super::rest::KiwoomRest;
use super::wire::{self, RealItem, RealType, WsControl, WsFrame};
use crate::clock::Clock;

/// 0B `9081`. `_AL` 한 흐름이 KRX와 NXT 체결을 함께 준다(kiwoom.md 11.1, 11.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Exchange {
    Krx,
    Nxt,
}

/// 실시간 체결 하나. 날짜는 아직 없다(`domain::resolve_trade_time`이 붙인다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealTick {
    pub symbol: Symbol,
    pub hhmmss: TimeOfDay,
    pub price: Price,
    pub qty: Volume,
    /// 지수(0J)와 `9081`이 없거나 모르는 값이면 None.
    pub exchange: Option<Exchange>,
    /// 프레임에 11·13이 없거나 읽지 못하면 None.
    pub day: Option<DayTotals>,
}

/// 체결 프레임에 같이 오는 그날 값(kiwoom.md §11.3, §11.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayTotals {
    /// 11 전일대비. 부호가 곧 값이다.
    pub change_centi: i64,
    pub cumulative: Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEvent {
    Tick { tick: RealTick, received_at: KstTime },
    /// 세션이 LOGIN을 마치고 원하는 집합을 모두 REG 했다.
    Live { since: KstTime },
    /// 세션이 끊겼다. 다음 Live까지는 체결이 빠졌을 수 있다.
    Down { at: KstTime },
    Halted,
}

/// 세션 태스크의 손잡이. 받을 종목 전체 집합을 통째로 주면 세션이 차이를 REG/REMOVE 한다.
pub struct KiwoomStream {
    desired: watch::Sender<BTreeSet<Symbol>>,
}

impl KiwoomStream {
    pub fn spawn(url: String, rest: KiwoomRest, clock: Clock) -> (KiwoomStream, mpsc::Receiver<StreamEvent>) {
        KiwoomStream::spawn_with(url, rest, clock, Timings::default())
    }

    pub(crate) fn spawn_with(url: String, rest: KiwoomRest, clock: Clock, timings: Timings) -> (KiwoomStream, mpsc::Receiver<StreamEvent>) {
        Self::spawn_connector(Box::new(WebSocketConnector(url)), rest, clock, timings)
    }

    fn spawn_connector(connector: Box<dyn Connector>, rest: KiwoomRest, clock: Clock, timings: Timings) -> (KiwoomStream, mpsc::Receiver<StreamEvent>) {
        let (stream, desired) = KiwoomStream::detached();
        let (events, rx) = mpsc::channel(EVENT_BUFFER);
        let session = Session { connector, rest, clock, timings, desired, events, budget: TokenBudget::Fresh, rebuild: ControlBudget::Fresh, dropped: Dropped::default() };
        tokio::spawn(session.run());
        (stream, rx)
    }

    /// 세션 없이 손잡이만 만든다. 시험이 원하는 집합을 읽는다.
    pub fn detached() -> (KiwoomStream, watch::Receiver<BTreeSet<Symbol>>) {
        let (desired, rx) = watch::channel(BTreeSet::new());
        (KiwoomStream { desired }, rx)
    }

    pub fn set_desired(&self, desired: BTreeSet<Symbol>) {
        self.desired.send_if_modified(|cur| {
            let changed = *cur != desired;
            *cur = desired;
            changed
        });
    }
}

const EVENT_BUFFER: usize = 4096;
const BACKOFF: [Duration; 5] = [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(10), Duration::from_secs(30)];
const DROP_WARN_EVERY: Duration = Duration::from_secs(60);
const STABLE: Duration = Duration::from_secs(60);
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy)]
pub(crate) struct Timings {
    /// LOGIN·REG·REMOVE 응답과 연결을 기다리는 시간.
    pub control: Duration,
    /// 아무 메시지도 없으면 연결이 죽었다고 보는 시간. 키움은 10초마다 PING을 보낸다(kiwoom.md §8).
    pub silence: Duration,
    /// n번째 다시 연결 전에 쉬는 시간. 끝 값을 계속 쓴다.
    pub backoff: [Duration; 5],
    pub live_resets_backoff_after: Duration,
    /// 키움 REG 유량은 공개 기록으로 약 초당 5회다(kiwoom-ws-errors.md).
    pub rate_limit_pause: Duration,
}

impl Default for Timings {
    fn default() -> Timings {
        Timings { control: Duration::from_secs(5), silence: Duration::from_secs(30), backoff: BACKOFF, live_resets_backoff_after: STABLE, rate_limit_pause: RATE_LIMIT_PAUSE }
    }
}

impl Timings {
    fn backoff(&self, attempt: u32) -> Duration {
        self.backoff[(attempt as usize).min(self.backoff.len() - 1)]
    }
}

enum SessionState {
    Disconnected { retry_at: Instant, attempt: u32 },
    Connecting { attempt: u32 },
    LoggingIn { conn: Conn, attempt: u32 },
    Live { conn: Conn, since: KstTime, accepted: BTreeSet<Symbol>, attempt: u32 },
    Halted,
}

impl SessionState {
    fn name(&self) -> &'static str {
        match self {
            SessionState::Disconnected { .. } => "Disconnected",
            SessionState::Connecting { .. } => "Connecting",
            SessionState::LoggingIn { .. } => "LoggingIn",
            SessionState::Live { .. } => "Live",
            SessionState::Halted => "Halted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenBudget {
    Fresh,
    Reissued,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlBudget {
    Fresh,
    Rebuilt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Control {
    Reg(BTreeSet<Symbol>),
    Remove(RealType, BTreeSet<Symbol>),
}

impl Control {
    /// 해지가 먼저다. 200개가 찬 채로 하나를 바꿀 때 REG를 먼저 보내면 잠깐 201개라 키움이 거절한다.
    fn next(desired: &BTreeSet<Symbol>, accepted: &BTreeSet<Symbol>) -> Option<Control> {
        let remove = [RealType::Trade, RealType::Index].into_iter().find_map(|kind| {
            let removed: BTreeSet<Symbol> = accepted.difference(desired).copied().filter(|&s| RealType::of(s) == kind).collect();
            (!removed.is_empty()).then_some(Control::Remove(kind, removed))
        });
        let added: BTreeSet<Symbol> = desired.difference(accepted).copied().collect();
        remove.or_else(|| (!added.is_empty()).then_some(Control::Reg(added)))
    }

    fn kind(&self) -> WsControl {
        match self {
            Control::Reg(_) => WsControl::Reg,
            Control::Remove(..) => WsControl::Remove,
        }
    }

    fn message(&self) -> String {
        match self {
            Control::Reg(symbols) => wire::reg_message(symbols),
            Control::Remove(kind, symbols) => wire::remove_message(*kind, symbols),
        }
    }

    fn apply(self, accepted: &mut BTreeSet<Symbol>) {
        match self {
            Control::Reg(symbols) => accepted.extend(symbols),
            Control::Remove(_, symbols) => accepted.retain(|s| !symbols.contains(s)),
        }
    }
}

#[derive(Debug)]
enum End {
    Closed(Option<u16>),
    Silent,
    Transport(String),
    ControlTimeout(WsControl),
    ControlRejected(WsControl, WsRejection),
    Shutdown,
}

impl End {
    fn is_control_failure(&self) -> bool {
        matches!(self, End::ControlTimeout(_) | End::ControlRejected(..))
    }
}

impl std::fmt::Display for End {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            End::Closed(Some(code)) => write!(f, "키움이 연결을 닫았습니다(close {code}, {:?})", classify(CodeKey::WsClose(*code))),
            End::Closed(None) => f.write_str("close 프레임 없이 연결이 끊겼습니다"),
            End::Silent => f.write_str("정한 시간 동안 아무 메시지도 오지 않았습니다"),
            End::Transport(e) => write!(f, "WebSocket 전송 오류: {e}"),
            End::ControlTimeout(c) => write!(f, "{} 응답이 시간 안에 오지 않았습니다", c.trnm()),
            End::ControlRejected(c, r) => write!(f, "{}이 거절됐습니다({r:?})", c.trnm()),
            End::Shutdown => f.write_str("세션을 끝냅니다"),
        }
    }
}

enum Wake {
    Ack(WsControl, Result<(), WsRejection>),
    Deadline,
    Desired,
}

#[derive(Default)]
struct Dropped {
    auction_only: u64,
    unparsed: u64,
    last_warn: Option<Instant>,
}

struct Session {
    connector: Box<dyn Connector>,
    rest: KiwoomRest,
    clock: Clock,
    timings: Timings,
    desired: watch::Receiver<BTreeSet<Symbol>>,
    events: mpsc::Sender<StreamEvent>,
    budget: TokenBudget,
    rebuild: ControlBudget,
    dropped: Dropped,
}

trait SessionSocket: Sink<Message, Error = WsError> + Stream<Item = Result<Message, WsError>> + Unpin + Send {}

impl<T> SessionSocket for T where T: Sink<Message, Error = WsError> + Stream<Item = Result<Message, WsError>> + Unpin + Send {}

type Socket = Box<dyn SessionSocket>;

trait Connector: Send + Sync {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>>;
}

struct WebSocketConnector(String);

impl Connector for WebSocketConnector {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        Box::pin(async { connect_async(self.0.as_str()).await.map(|(socket, _)| Box::new(socket) as Socket) })
    }
}

struct Conn {
    ws: Socket,
    silence: Duration,
    silent_at: Instant,
    /// 0J 체결량을 구하려고 지수마다 앞 프레임의 누적거래량을 든다. 연결마다 새로 시작한다.
    index_cumulative: HashMap<IndexCode, u64>,
}

impl Session {
    async fn run(mut self) {
        let mut state = SessionState::Disconnected { retry_at: Instant::now(), attempt: 0 };
        loop {
            let from = state.name();
            state = match state {
                SessionState::Disconnected { retry_at, attempt } => match self.wait_and_get_token(retry_at, attempt).await {
                    Some(next) => next,
                    None => return,
                },
                SessionState::Connecting { attempt } => self.connect(attempt).await,
                SessionState::LoggingIn { conn, attempt } => match self.log_in(conn, attempt).await {
                    Some(next) => next,
                    None => return,
                },
                SessionState::Live { conn, since, accepted, attempt } => {
                    let entered = Instant::now();
                    let end = self.live(conn, accepted).await;
                    let live_duration = entered.elapsed();
                    if matches!(end, End::Shutdown) {
                        return;
                    }
                    let at = self.clock.now();
                    tracing::warn!(%end, %since, %at, "키움 WebSocket 세션이 끊겼습니다");
                    if self.events.send(StreamEvent::Down { at }).await.is_err() {
                        return;
                    }
                    let attempt = if live_duration >= self.timings.live_resets_backoff_after {
                        self.rebuild = ControlBudget::Fresh;
                        0
                    } else {
                        attempt
                    };
                    self.next_after_close(end, attempt)
                }
                SessionState::Halted => {
                    tracing::error!("키움 WebSocket을 멈췄습니다. 서버를 다시 켜야 다시 연결합니다. 조회(REST)는 그대로 씁니다");
                    let _ = self.events.send(StreamEvent::Halted).await;
                    return;
                }
            };
            match &state {
                SessionState::Disconnected { retry_at, attempt } => {
                    tracing::info!(from, to = "Disconnected", attempt, after_ms = retry_at.saturating_duration_since(Instant::now()).as_millis() as u64, "키움 WebSocket 상태")
                }
                next => tracing::info!(from, to = next.name(), "키움 WebSocket 상태"),
            }
        }
    }

    fn retry_later(&self, attempt: u32) -> SessionState {
        SessionState::Disconnected { retry_at: Instant::now() + self.timings.backoff(attempt), attempt: attempt + 1 }
    }

    fn next_after_close(&mut self, end: End, attempt: u32) -> SessionState {
        if !end.is_control_failure() {
            return self.retry_later(attempt);
        }
        match self.rebuild {
            ControlBudget::Fresh => {
                self.rebuild = ControlBudget::Rebuilt;
                tracing::warn!(%end, budget = ?ControlBudget::Fresh, "제어가 실패했습니다. 세션을 한 번 다시 구성합니다");
                self.retry_later(attempt)
            }
            ControlBudget::Rebuilt => {
                tracing::error!(%end, budget = ?ControlBudget::Rebuilt, "다시 구성한 세션에서도 제어가 실패했습니다. 실시간만 멈춥니다");
                SessionState::Halted
            }
        }
    }

    async fn wait_and_get_token(&mut self, retry_at: Instant, attempt: u32) -> Option<SessionState> {
        tokio::select! {
            () = sleep_until(retry_at) => {}
            () = self.events.closed() => return None,
        }
        if self.rest.halted().is_some() {
            return Some(SessionState::Halted);
        }
        if self.rest.auth().current(self.clock.now()).is_some() {
            return Some(SessionState::Connecting { attempt });
        }
        Some(match self.rest.issue_token().await {
            Ok(_) => SessionState::Connecting { attempt },
            Err(e) if self.rest.halted().is_some() || e.manual_action_required() => {
                tracing::error!(error = %e, "WebSocket에 쓸 토큰을 받지 못했습니다");
                SessionState::Halted
            }
            Err(e) => {
                tracing::warn!(error = %e, "WebSocket에 쓸 토큰을 받지 못했습니다");
                match e.retry_at() {
                    Some(until) => {
                        let wait = Duration::from_secs((until.unix() - self.clock.now().unix()).max(0) as u64);
                        SessionState::Disconnected { retry_at: Instant::now() + wait, attempt }
                    }
                    None => self.retry_later(attempt),
                }
            }
        })
    }

    async fn connect(&mut self, attempt: u32) -> SessionState {
        match timeout(self.timings.control, self.connector.connect()).await {
            Ok(Ok(ws)) => SessionState::LoggingIn { conn: Conn::new(ws, self.timings.silence), attempt },
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "키움 WebSocket에 연결하지 못했습니다");
                self.retry_later(attempt)
            }
            Err(_) => {
                tracing::warn!(timeout_ms = self.timings.control.as_millis() as u64, "키움 WebSocket 연결이 시간 안에 끝나지 않았습니다");
                self.retry_later(attempt)
            }
        }
    }

    async fn log_in(&mut self, mut conn: Conn, attempt: u32) -> Option<SessionState> {
        let Some((token, generation)) = self.rest.auth().current(self.clock.now()) else {
            conn.close().await;
            return Some(SessionState::Disconnected { retry_at: Instant::now(), attempt });
        };
        let login = wire::login_message(&token);
        tracing::debug!("LOGIN을 보냅니다");
        let sent = conn.send(login.expose().clone()).await;
        let reply = match sent {
            Ok(()) => self.await_ack(&mut conn, WsControl::Login).await,
            Err(end) => Err(end),
        };
        match reply {
            Ok(()) => {}
            Err(End::Shutdown) => return None,
            Err(End::ControlRejected(_, rejection)) if rejection.category == Category::TokenInvalid && self.budget == TokenBudget::Fresh => {
                tracing::warn!(?rejection, "LOGIN이 토큰 무효로 거절됐습니다. 토큰을 한 번 다시 받습니다");
                conn.close().await;
                self.budget = TokenBudget::Reissued;
                if self.rest.auth().invalidate(generation).is_err() {
                    return Some(SessionState::Halted);
                }
                return Some(SessionState::Disconnected { retry_at: Instant::now(), attempt });
            }
            Err(End::ControlRejected(_, rejection)) => {
                tracing::error!(?rejection, "LOGIN이 거절됐습니다");
                conn.close().await;
                return Some(SessionState::Halted);
            }
            Err(end) => {
                tracing::warn!(%end, "LOGIN을 마치지 못했습니다");
                conn.close().await;
                return Some(self.retry_later(attempt));
            }
        }
        let desired = self.desired.borrow_and_update().clone();
        let mut accepted = BTreeSet::new();
        if let Some(control) = Control::next(&desired, &accepted) {
            match self.control(&mut conn, &control).await {
                Ok(()) => control.apply(&mut accepted),
                Err(End::Shutdown) => return None,
                Err(end) => {
                    tracing::warn!(%end, "처음 REG를 마치지 못했습니다");
                    conn.close().await;
                    return Some(self.next_after_close(end, attempt));
                }
            }
        }
        let since = self.clock.now();
        self.budget = TokenBudget::Fresh;
        self.events.send(StreamEvent::Live { since }).await.ok()?;
        Some(SessionState::Live { conn, since, accepted, attempt })
    }

    async fn live(&mut self, mut conn: Conn, mut accepted: BTreeSet<Symbol>) -> End {
        let end = loop {
            let desired = self.desired.borrow_and_update().clone();
            if let Some(control) = Control::next(&desired, &accepted) {
                match self.control(&mut conn, &control).await {
                    Ok(()) => control.apply(&mut accepted),
                    Err(end) => break end,
                }
                continue;
            }
            match self.recv(&mut conn, None, true).await {
                Ok(Wake::Desired) => {}
                Ok(Wake::Ack(control, _)) => tracing::debug!(trnm = control.trnm(), "기다리지 않던 응답을 버립니다"),
                Ok(Wake::Deadline) => unreachable!("기한 없이 기다렸다"),
                Err(end) => break end,
            }
        };
        conn.close().await;
        end
    }

    /// 응답에 요청 번호가 없어서, 시간 안에 응답이 없으면 늦은 응답이 어느 요청의 것인지 알 수 없다. 그 연결로는 더 보내지 않는다.
    async fn control(&mut self, conn: &mut Conn, control: &Control) -> Result<(), End> {
        let message = control.message();
        let mut resent = false;
        loop {
            tracing::debug!(trnm = control.kind().trnm(), resent, message = %message, "제어 메시지를 보냅니다");
            conn.send(message.clone()).await?;
            let rejection = match self.await_ack(conn, control.kind()).await {
                Ok(()) => return Ok(()),
                Err(End::ControlRejected(_, rejection)) if !resent && rejection.category != Category::RealtimeCapacity => rejection,
                Err(end) => return Err(end),
            };
            tracing::warn!(?rejection, "제어 메시지가 거절됐습니다. 한 번 다시 보냅니다");
            if rejection.category == Category::RateLimit {
                self.serve_until(conn, self.timings.rate_limit_pause).await?;
            }
            resent = true;
        }
    }

    async fn serve_until(&mut self, conn: &mut Conn, wait: Duration) -> Result<(), End> {
        let until = Instant::now() + wait;
        loop {
            match self.recv(conn, Some(until), false).await? {
                Wake::Deadline => return Ok(()),
                Wake::Ack(got, _) => tracing::debug!(trnm = got.trnm(), "기다리지 않던 응답을 버립니다"),
                Wake::Desired => {}
            }
        }
    }

    async fn await_ack(&mut self, conn: &mut Conn, control: WsControl) -> Result<(), End> {
        let deadline = Instant::now() + self.timings.control;
        loop {
            match self.recv(conn, Some(deadline), false).await? {
                Wake::Ack(got, result) if got == control => return result.map_err(|r| End::ControlRejected(control, r)),
                Wake::Ack(got, _) => tracing::debug!(trnm = got.trnm(), want = control.trnm(), "기다리던 것과 다른 응답을 버립니다"),
                Wake::Deadline => return Err(End::ControlTimeout(control)),
                Wake::Desired => {}
            }
        }
    }

    async fn recv(&mut self, conn: &mut Conn, deadline: Option<Instant>, watch_desired: bool) -> Result<Wake, End> {
        loop {
            let message = tokio::select! {
                m = conn.ws.next() => m,
                () = sleep_until(conn.silent_at) => return Err(End::Silent),
                () = sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => return Ok(Wake::Deadline),
                changed = self.desired.changed(), if watch_desired => return changed.map(|()| Wake::Desired).map_err(|_| End::Shutdown),
            };
            let text = match message {
                Some(Ok(Message::Text(text))) => text,
                Some(Ok(Message::Close(frame))) => return Err(End::Closed(frame.map(|f| u16::from(f.code)))),
                Some(Ok(Message::Ping(_))) => {
                    conn.touch();
                    conn.ws.flush().await.map_err(|e| End::Transport(e.to_string()))?;
                    continue;
                }
                Some(Ok(_)) => {
                    conn.touch();
                    continue;
                }
                Some(Err(e)) => return Err(End::Transport(e.to_string())),
                None => return Err(End::Closed(None)),
            };
            conn.touch();
            match wire::parse_ws_frame(text.as_str()) {
                Ok(WsFrame::Ping) => conn.send(text.as_str().to_owned()).await?,
                Ok(WsFrame::Ack { control, result }) => return Ok(Wake::Ack(control, result)),
                Ok(WsFrame::Real(items)) => self.on_real(conn, items).await?,
                Ok(WsFrame::Other(trnm)) => tracing::debug!(%trnm, "모르는 WebSocket 메시지를 버립니다"),
                Err(e) => self.unparsed(&e),
            }
        }
    }

    async fn on_real(&mut self, conn: &mut Conn, items: Vec<Result<RealItem, wire::WireError>>) -> Result<(), End> {
        let received_at = self.clock.now();
        for item in items {
            let tick = match item {
                Ok(RealItem::Trade(tick)) => tick,
                Ok(RealItem::Index { index, hhmmss, price, cumulative, change_centi }) => {
                    let before = conn.index_cumulative.insert(index, cumulative);
                    let qty = before.map_or(0, |b| cumulative.saturating_sub(b));
                    let day = change_centi.map(|change_centi| DayTotals { change_centi, cumulative: Volume(cumulative) });
                    RealTick { symbol: Symbol::Index(index), hhmmss, price, qty: Volume(qty), exchange: None, day }
                }
                Ok(RealItem::AuctionOnly) => {
                    self.dropped.auction_only += 1;
                    tracing::debug!(count = self.dropped.auction_only, "체결량 0인 0B(동시호가)를 버립니다");
                    continue;
                }
                Ok(RealItem::OtherType(kind)) => {
                    tracing::debug!(%kind, "받지 않는 실시간 항목을 버립니다");
                    continue;
                }
                Err(e) => {
                    self.unparsed(&e);
                    continue;
                }
            };
            self.events.send(StreamEvent::Tick { tick, received_at }).await.map_err(|_| End::Shutdown)?;
        }
        Ok(())
    }

    fn unparsed(&mut self, e: &wire::WireError) {
        let d = &mut self.dropped;
        d.unparsed += 1;
        if d.last_warn.is_none_or(|t| t.elapsed() >= DROP_WARN_EVERY) {
            d.last_warn = Some(Instant::now());
            tracing::warn!(error = %e, count = d.unparsed, "읽지 못한 WebSocket 메시지를 버립니다");
        }
    }
}

impl Conn {
    fn new(ws: Socket, silence: Duration) -> Conn {
        Conn { ws, silence, silent_at: Instant::now() + silence, index_cumulative: HashMap::new() }
    }

    fn touch(&mut self) {
        self.silent_at = Instant::now() + self.silence;
    }

    async fn send(&mut self, text: String) -> Result<(), End> {
        self.ws.send(Message::Text(text.into())).await.map_err(|e| End::Transport(e.to_string()))
    }

    /// 반쯤 열린 연결이면 close가 끝나지 않을 수 있어 기다리는 시간을 둔다.
    async fn close(mut self) {
        let _ = timeout(self.silence, self.ws.close()).await;
    }
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}};
    use std::task::{Context, Poll};

    use domain::{KstDate, StockCode};
    use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
    use serde_json::{Value, json};

    use super::*;
    use crate::config::Secret;
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::rest::testing::{FakeTransport, token};
    use crate::kiwoom::wire::TokenResponse;

    const WAIT: Duration = Duration::from_secs(120);
    type Frames = UnboundedSender<Result<Message, WsError>>;
    type Script = dyn Fn(usize, &str, usize) -> Reply + Send + Sync;

    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn samsung() -> Symbol {
        Symbol::Stock(StockCode::parse("005930").unwrap())
    }

    fn kospi() -> Symbol {
        Symbol::Index(IndexCode::KOSPI)
    }

    fn fast() -> Timings {
        Timings { control: Duration::from_millis(500), silence: Duration::from_secs(30), backoff: [Duration::from_millis(50); 5], live_resets_backoff_after: Duration::from_secs(60), rate_limit_pause: Duration::from_millis(300) }
    }

    fn clock() -> Clock {
        Clock::fake(crate::clock::kst(KstDate::new(2026, 11, 9).unwrap(), 9, 30, 0))
    }

    fn rest(clock: &Clock) -> (KiwoomRest, Arc<FakeTransport>) {
        let transport = Arc::new(FakeTransport::new(Duration::ZERO, |_| token(1)));
        let rest = KiwoomRest::new(Arc::new(transport.clone()), KiwoomAuth::new(Secret::new("key".into()), Secret::new("secret".into()), None), clock.clone());
        (rest, transport)
    }

    fn holding_unrecorded(rest: &KiwoomRest, clock: &Clock) {
        rest.auth().record_issued(TokenResponse { token: "revoked-token".into(), expires_dt: "20991231000000".into() }, clock.now().plus_secs(-601)).unwrap();
    }

    async fn next(events: &mut mpsc::Receiver<StreamEvent>) -> StreamEvent {
        timeout(WAIT, events.recv()).await.expect("이벤트가 오지 않았다").expect("세션 태스크가 끝났다")
    }

    async fn until(what: &str, f: impl Fn() -> bool) {
        for _ in 0..1000 {
            if f() { return; }
            tokio::task::yield_now().await;
        }
        panic!("기다린 상태가 되지 않았다: {what}");
    }

    fn tick(event: StreamEvent) -> RealTick {
        match event {
            StreamEvent::Tick { tick, .. } => tick,
            other => panic!("체결이 아니다: {other:?}"),
        }
    }

    fn trade(time: &str, price: i64, qty: i64, cumulative: i64, exchange: &str) -> Value {
        json!({"type": "0B", "item": "005930_AL", "values": {"20": time, "10": price.to_string(), "15": qty.to_string(), "13": cumulative.to_string(), "9081": exchange, "11": "0"}})
    }

    fn index(centi: i64, cumulative: u64) -> Value {
        let sign = if centi < 0 { "-" } else { "+" };
        let magnitude = centi.unsigned_abs();
        json!({"type": "0J", "item": "001", "values": {"20": "093001", "10": format!("{sign}{}.{:02}", magnitude / 100, magnitude % 100), "13": cumulative.to_string()}})
    }

    struct ChannelSocket {
        incoming: UnboundedReceiver<Result<Message, WsError>>,
        outgoing: UnboundedSender<Message>,
    }

    impl Stream for ChannelSocket {
        type Item = Result<Message, WsError>;

        fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            Pin::new(&mut self.incoming).poll_next(cx)
        }
    }

    impl Sink<Message> for ChannelSocket {
        type Error = WsError;

        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
            self.outgoing.unbounded_send(message).map_err(|_| WsError::ConnectionClosed)
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            self.outgoing.close_channel();
            Poll::Ready(Ok(()))
        }
    }

    #[derive(Clone, Copy)]
    enum Reply {
        Ok,
        Code(u32),
        Silent,
        OkThenBye,
        OkThenFlood,
        Refuse,
    }

    #[derive(Clone)]
    struct Peer {
        script: Arc<Script>,
        seen: Arc<Mutex<Vec<(usize, Value, Instant)>>>,
        frames: Arc<Mutex<Vec<Frames>>>,
        attempts: Arc<AtomicUsize>,
    }

    impl Peer {
        fn new(script: impl Fn(usize, &str, usize) -> Reply + Send + Sync + 'static) -> Self {
            Self { script: Arc::new(script), seen: Arc::default(), frames: Arc::default(), attempts: Arc::default() }
        }

        fn ok() -> Self {
            Self::new(|_, _, _| Reply::Ok)
        }

        fn start(&self, timings: Timings, desired: &[Symbol]) -> (KiwoomStream, mpsc::Receiver<StreamEvent>, Arc<FakeTransport>) {
            let clock = clock();
            let (rest, transport) = rest(&clock);
            let (stream, events) = self.start_rest(rest, clock, timings, desired);
            (stream, events, transport)
        }

        fn start_rest(&self, rest: KiwoomRest, clock: Clock, timings: Timings, desired: &[Symbol]) -> (KiwoomStream, mpsc::Receiver<StreamEvent>) {
            let (stream, events) = KiwoomStream::spawn_connector(Box::new(self.clone()), rest, clock, timings);
            stream.set_desired(desired.iter().copied().collect());
            (stream, events)
        }

        fn controls(&self, conn: usize) -> Vec<String> {
            self.seen.lock().unwrap().iter().filter(|(c, ..)| *c == conn).map(|(_, v, _)| v["trnm"].as_str().unwrap().to_owned()).collect()
        }

        fn messages(&self, conn: usize) -> Vec<Value> {
            self.seen.lock().unwrap().iter().filter(|(c, ..)| *c == conn).map(|(_, v, _)| v.clone()).collect()
        }

        fn logins(&self) -> usize {
            self.seen.lock().unwrap().iter().filter(|(_, v, _)| v["trnm"] == "LOGIN").count()
        }

        fn sent_at(&self, conn: usize, trnm: &str) -> Vec<Instant> {
            self.seen.lock().unwrap().iter().filter(|(c, v, _)| *c == conn && v["trnm"] == trnm).map(|(.., at)| *at).collect()
        }

        fn send(&self, conn: usize, message: Message) {
            self.frames.lock().unwrap()[conn].unbounded_send(Ok(message)).unwrap();
        }

        fn real(&self, conn: usize, items: Vec<Value>) {
            self.send(conn, Message::Text(json!({"trnm": "REAL", "data": items}).to_string().into()));
        }

        fn drop_session(&self, conn: usize) {
            self.send(conn, Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: 1000.into(), reason: "Bye".into() })));
        }
    }

    impl Connector for Peer {
        fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
            let conn = self.attempts.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                let (incoming_tx, incoming) = unbounded();
                self.frames.lock().unwrap().push(incoming_tx.clone());
                if matches!((self.script)(conn, "CONNECT", 1), Reply::Refuse) {
                    return Err(WsError::ConnectionClosed);
                }
                let (outgoing, mut outgoing_rx) = unbounded();
                let (script, seen) = (self.script.clone(), self.seen.clone());
                tokio::spawn(async move {
                    let mut counts: HashMap<String, usize> = HashMap::new();
                    while let Some(Message::Text(text)) = outgoing_rx.next().await {
                        let value: Value = serde_json::from_str(text.as_str()).unwrap();
                        let trnm = value["trnm"].as_str().unwrap().to_owned();
                        seen.lock().unwrap().push((conn, value, Instant::now()));
                        if trnm == "PING" { continue; }
                        let nth = counts.entry(trnm.clone()).and_modify(|n| *n += 1).or_insert(1);
                        let reply = script(conn, &trnm, *nth);
                        let code = match reply { Reply::Code(code) => code, _ => 0 };
                        if !matches!(reply, Reply::Silent | Reply::Refuse) {
                            let detail = if trnm == "LOGIN" && code == 3 { "(CODE=8005)" } else { "" };
                            let ack = json!({"trnm": trnm, "return_code": code, "return_msg": detail});
                            if incoming_tx.unbounded_send(Ok(Message::Text(ack.to_string().into()))).is_err() { return; }
                        }
                        if matches!(reply, Reply::OkThenBye) {
                            let _ = incoming_tx.unbounded_send(Ok(Message::Close(None)));
                        }
                        if matches!(reply, Reply::OkThenFlood) {
                            let frame = json!({"trnm": "REAL", "data": vec![trade("093001", 71000, 1, 100, "KRX"); EVENT_BUFFER]});
                            let _ = incoming_tx.unbounded_send(Ok(Message::Text(frame.to_string().into())));
                        }
                    }
                });
                Ok(Box::new(ChannelSocket { incoming, outgoing }) as Socket)
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn logs_in_registers_the_desired_set_and_turns_live() {
        let peer = Peer::ok();
        let (_stream, mut events, transport) = peer.start(fast(), &[samsung(), kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(peer.controls(0), ["LOGIN", "REG"]);
        assert_eq!(peer.messages(0)[1], json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [{"item": ["005930_AL"], "type": ["0B"]}, {"item": ["001"], "type": ["0J"]}]}));
        assert_eq!(transport.sent().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn trades_become_ticks_and_auction_only_frames_are_dropped() {
        let peer = Peer::ok();
        let (_stream, mut events, _) = peer.start(fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        peer.real(0, vec![trade("093001", -71_200, -15, 100, "NXT")]);
        let t = tick(next(&mut events).await);
        assert_eq!((t.symbol, t.hhmmss, t.price.centi(), t.qty, t.exchange), (samsung(), TimeOfDay::hms(9, 30, 1).unwrap(), 7_120_000, Volume(15), Some(Exchange::Nxt)));
        peer.real(0, vec![trade("093002", 71_300, 0, 100, "KRX"), trade("093003", 71_400, 7, 107, "KRX")]);
        let t = tick(next(&mut events).await);
        assert_eq!((t.hhmmss, t.price.centi(), t.qty, t.exchange), (TimeOfDay::hms(9, 30, 3).unwrap(), 7_140_000, Volume(7), Some(Exchange::Krx)));
    }

    #[tokio::test(start_paused = true)]
    async fn index_ticks_take_the_level_and_the_cumulative_volume_increase() {
        let peer = Peer::ok();
        let (_stream, mut events, _) = peer.start(fast(), &[kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        let mut got = Vec::new();
        for (cum, centi) in [(1_000, -505_969), (1_250, 506_010), (1_200, 506_020)] {
            peer.real(0, vec![index(centi, cum)]);
            let t = tick(next(&mut events).await);
            assert_eq!((t.symbol, t.exchange), (kospi(), None));
            got.push((t.price.centi(), t.qty.0));
        }
        assert_eq!(got, [(505_969, 0), (506_010, 250), (506_020, 0)]);
    }

    #[tokio::test(start_paused = true)]
    async fn ping_is_echoed() {
        let peer = Peer::ok();
        let (_stream, mut events, _) = peer.start(fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        for _ in 0..3 { peer.send(0, Message::Text(r#"{"trnm":"PING"}"#.into())); }
        until("PING 세 번을 돌려보냈다", || peer.controls(0).iter().filter(|s| *s == "PING").count() == 3).await;
        assert_eq!(peer.logins(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn desired_changes_are_one_reg_and_one_remove_per_type() {
        let peer = Peer::ok();
        let (stream, mut events, _) = peer.start(fast(), &[samsung(), kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        stream.set_desired(BTreeSet::new());
        until("모두 해지됐다", || peer.controls(0).len() == 4).await;
        let messages = peer.messages(0);
        assert_eq!(messages[2]["data"], json!([{"item": ["005930_AL"], "type": ["0B"]}]));
        assert_eq!(messages[3]["data"], json!([{"item": ["001"], "type": ["0J"]}]));
        stream.set_desired([samsung(), kospi()].into());
        until("다시 등록됐다", || peer.controls(0).len() == 5).await;
        assert_eq!(peer.controls(0), ["LOGIN", "REG", "REMOVE", "REMOVE", "REG"]);
        assert_eq!(peer.logins(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_session_goes_down_then_logs_in_again_with_the_same_token_and_registers_everything() {
        let peer = Peer::ok();
        let (_stream, mut events, transport) = peer.start(fast(), &[samsung(), kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        peer.drop_session(0);
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(peer.controls(1), ["LOGIN", "REG"]);
        assert_eq!(peer.messages(0), peer.messages(1));
        assert_eq!(transport.sent().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn silence_closes_the_session() {
        let peer = Peer::ok();
        let timings = Timings { silence: Duration::from_millis(300), ..fast() };
        let (_stream, mut events, _) = peer.start(timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        for _ in 0..5 {
            tokio::time::advance(Duration::from_millis(100)).await;
            peer.send(1, Message::Text(r#"{"trnm":"PING"}"#.into()));
            tokio::task::yield_now().await;
        }
        assert!(events.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_rejected_login_reissues_the_token_once_and_recovers() {
        let peer = Peer::new(|conn, trnm, _| if (conn, trnm) == (0, "LOGIN") { Reply::Code(3) } else { Reply::Ok });
        let clock = clock();
        let (rest, transport) = rest(&clock);
        holding_unrecorded(&rest, &clock);
        let (_stream, mut events) = peer.start_rest(rest, clock, fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(transport.sent().len(), 1);
        assert_eq!(peer.controls(0), ["LOGIN"]);
        assert_eq!(peer.controls(1), ["LOGIN", "REG"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_login_rejected_again_after_the_one_reissue_halts() {
        let peer = Peer::new(|_, trnm, _| if trnm == "LOGIN" { Reply::Code(3) } else { Reply::Ok });
        let clock = clock();
        let (rest, transport) = rest(&clock);
        holding_unrecorded(&rest, &clock);
        let (_stream, mut events) = peer.start_rest(rest.clone(), clock, fast(), &[samsung()]);
        assert_eq!(next(&mut events).await, StreamEvent::Halted);
        assert!(events.recv().await.is_none());
        assert_eq!((transport.sent().len(), peer.logins()), (1, 2));
        assert!(rest.halted().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_reissue_refused_by_the_issue_interval_waits_instead_of_looping() {
        let peer = Peer::new(|_, trnm, _| if trnm == "LOGIN" { Reply::Code(3) } else { Reply::Ok });
        let (_stream, mut events, transport) = peer.start(fast(), &[samsung()]);
        until("첫 LOGIN이 거절됐다", || peer.logins() == 1).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!((transport.sent().len(), peer.logins()), (1, 1));
        assert!(events.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_handle_ends_the_session() {
        let peer = Peer::ok();
        let (stream, mut events, _) = peer.start(fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        drop(stream);
        assert!(events.recv().await.is_none());
        until("세션이 닫혔다", || peer.frames.lock().unwrap()[0].is_closed()).await;
    }

    #[tokio::test]
    async fn websocket_connector_handshakes_sends_receives_and_closes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connector = WebSocketConnector(format!("ws://{}", listener.local_addr().unwrap()));
        let peer = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            assert_eq!(socket.next().await.unwrap().unwrap(), Message::Text("outgoing".into()));
            socket.send(Message::Ping(vec![1, 2].into())).await.unwrap();
            assert_eq!(socket.next().await.unwrap().unwrap(), Message::Pong(vec![1, 2].into()));
            socket.send(Message::Text("incoming".into())).await.unwrap();
            assert!(matches!(socket.next().await.unwrap().unwrap(), Message::Close(_)));
        });
        let mut socket = timeout(Duration::from_secs(3), connector.connect()).await.unwrap().unwrap();
        socket.send(Message::Text("outgoing".into())).await.unwrap();
        assert!(matches!(socket.next().await.unwrap().unwrap(), Message::Ping(_)));
        socket.flush().await.unwrap();
        assert_eq!(socket.next().await.unwrap().unwrap(), Message::Text("incoming".into()));
        socket.close().await.unwrap();
        timeout(Duration::from_secs(3), peer).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_wss_handshake_fails_without_a_crypto_provider_panic() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connector = WebSocketConnector(format!("wss://{}", listener.local_addr().unwrap()));
        let peer = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            tokio::io::AsyncWriteExt::write_all(&mut tcp, b"HTTP/1.1 400 Bad Request\r\n\r\n").await.unwrap();
        });
        assert!(timeout(Duration::from_secs(3), connector.connect()).await.unwrap().is_err());
        peer.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_control_answered_too_late_drops_the_connection_instead_of_resending_on_it() {
        let peer = Peer::new(|conn, trnm, _| if (conn, trnm) == (0, "REG") { Reply::Silent } else { Reply::Ok });
        let (_stream, mut events, _) = peer.start(fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(peer.controls(0), ["LOGIN", "REG"]);
        assert_eq!(peer.controls(1), ["LOGIN", "REG"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_registration_refused_for_capacity_rebuilds_once_then_halts_only_the_stream() {
        for code in [105115, 105118] {
            let output = Arc::new(Mutex::new(Vec::new()));
            let writer = output.clone();
            let subscriber = tracing_subscriber::fmt().with_writer(move || Captured(writer.clone())).with_ansi(false).with_max_level(tracing::Level::TRACE).finish();
            let _guard = tracing::subscriber::set_default(subscriber);
            let peer = Peer::new(move |_, trnm, _| if trnm == "REG" { Reply::Code(code) } else { Reply::Ok });
            let clock = clock();
            let (rest, transport) = rest(&clock);
            let (_stream, mut events) = peer.start_rest(rest.clone(), clock, fast(), &[samsung()]);
            assert_eq!(next(&mut events).await, StreamEvent::Halted, "{code}");
            assert_eq!(peer.logins(), 2);
            assert_eq!(transport.sent().len(), 1);
            assert!(rest.halted().is_none());
            let logs = String::from_utf8(output.lock().unwrap().clone()).unwrap();
            let line = logs.lines().find(|line| line.contains("다시 구성한 세션에서도 제어가 실패했습니다")).unwrap_or_else(|| panic!("{logs}"));
            assert!(line.contains("ERROR") && line.contains(&format!("return_code: Some({code})")) && line.contains("budget=Rebuilt"), "{line}");
            assert!(!logs.contains("tok-1"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limited_registration_waits_before_it_is_sent_again_on_the_same_connection() {
        let peer = Peer::new(|_, trnm, nth| if (trnm, nth) == ("REG", 1) { Reply::Code(105110) } else { Reply::Ok });
        let (_stream, mut events, _) = peer.start(fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        let regs = peer.sent_at(0, "REG");
        assert_eq!(regs.len(), 2);
        assert_eq!(regs[1] - regs[0], fast().rate_limit_pause);
        assert_eq!(peer.logins(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn sessions_that_drop_right_after_turning_live_back_off_further_each_time() {
        let peer = Peer::ok();
        let timings = Timings { backoff: [Duration::from_millis(100), Duration::from_millis(300), Duration::from_millis(700), Duration::from_millis(700), Duration::from_millis(700)], ..fast() };
        let (_stream, mut events, _) = peer.start(timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        let mut waits = Vec::new();
        for conn in 0..3 {
            peer.drop_session(conn);
            assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
            let at = Instant::now();
            assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
            waits.push(at.elapsed());
        }
        assert_eq!(waits, [Duration::from_millis(100), Duration::from_millis(300), Duration::from_millis(700)]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_that_stayed_live_long_enough_starts_the_backoff_over() {
        let peer = Peer::ok();
        let timings = Timings { backoff: [Duration::from_millis(100), Duration::from_millis(700), Duration::from_millis(700), Duration::from_millis(700), Duration::from_millis(700)], live_resets_backoff_after: Duration::from_millis(400), ..fast() };
        let (_stream, mut events, _) = peer.start(timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        peer.drop_session(0);
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        tokio::time::advance(timings.live_resets_backoff_after).await;
        peer.drop_session(1);
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        let at = Instant::now();
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(at.elapsed(), Duration::from_millis(100));
    }

    #[tokio::test(start_paused = true)]
    async fn a_stable_session_gets_its_control_rebuild_back() {
        let peer = Peer::new(|conn, trnm, nth| match (conn, trnm, nth) {
            (0, "REG", _) | (1 | 2, "REG", 2) => Reply::Silent,
            _ => Reply::Ok,
        });
        let timings = Timings { control: Duration::from_millis(200), live_resets_backoff_after: Duration::from_millis(300), ..fast() };
        let (stream, mut events, _) = peer.start(timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        tokio::time::advance(timings.live_resets_backoff_after).await;
        stream.set_desired([samsung(), kospi()].into());
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        stream.set_desired([samsung()].into());
        until("REMOVE가 받아들여졌다", || peer.controls(2).contains(&"REMOVE".to_owned())).await;
        stream.set_desired([samsung(), kospi()].into());
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert_eq!(next(&mut events).await, StreamEvent::Halted);
        assert_eq!(peer.logins(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn replacing_one_of_two_hundred_registrations_removes_before_it_registers() {
        let peer = Peer::ok();
        let stock = |n: u32| Symbol::Stock(StockCode::parse(&format!("{n:06}")).unwrap());
        let desired: Vec<Symbol> = (1..=200).map(stock).collect();
        let (stream, mut events, _) = peer.start(fast(), &desired);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        stream.set_desired((2..=201).map(stock).collect());
        until("바꾼 종목이 등록됐다", || peer.controls(0).len() == 4).await;
        assert_eq!(peer.controls(0), ["LOGIN", "REG", "REMOVE", "REG"]);
        assert_eq!(peer.messages(0)[2]["data"], json!([{"item": ["000001_AL"], "type": ["0B"]}]));
        assert_eq!(peer.messages(0)[3]["data"], json!([{"item": ["000201_AL"], "type": ["0B"]}]));
        assert!(events.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn dropped_sessions_and_failed_connections_never_spend_the_control_rebuild() {
        let peer = Peer::new(|conn, trnm, _| match (conn, trnm) {
            (0 | 1, "CONNECT") => Reply::Refuse,
            (2..=4, "REG") => Reply::OkThenBye,
            (_, "REG") => Reply::Code(105118),
            _ => Reply::Ok,
        });
        let (_stream, mut events, _) = peer.start(fast(), &[samsung()]);
        for _ in 2..=4 {
            assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
            assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        }
        assert_eq!(next(&mut events).await, StreamEvent::Halted);
        assert_eq!(peer.logins(), 5);
    }

    #[tokio::test(start_paused = true)]
    async fn down_delivery_delay_does_not_reset_the_control_budget() {
        let peer = Peer::new(|conn, trnm, nth| match (conn, trnm, nth) {
            (0, "REG", _) | (1, "REG", 2) => Reply::Code(105118),
            (1, "REG", 1) => Reply::OkThenFlood,
            _ => Reply::Ok,
        });
        let (stream, desired) = KiwoomStream::detached();
        let (events_tx, mut events) = mpsc::channel(EVENT_BUFFER);
        let clock = clock();
        let (rest, _) = rest(&clock);
        let session = Session { connector: Box::new(peer.clone()), rest, clock, timings: Timings::default(), desired, events: events_tx, budget: TokenBudget::Fresh, rebuild: ControlBudget::Fresh, dropped: Dropped::default() };
        let sender = session.events.clone();
        stream.set_desired([samsung()].into());
        tokio::spawn(session.run());
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(peer.logins(), 2);
        until("4096 real ticks fill the production event queue", || sender.capacity() == 0).await;
        stream.set_desired([samsung(), kospi()].into());
        until("second capacity rejection", || peer.controls(1).len() == 3).await;
        tokio::task::yield_now().await;
        assert_eq!(sender.capacity(), 0);
        tokio::time::advance(Duration::from_secs(61)).await;
        for _ in 0..EVENT_BUFFER { assert!(matches!(events.recv().await.unwrap(), StreamEvent::Tick { .. })); }
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert_eq!(next(&mut events).await, StreamEvent::Halted);
        assert_eq!(peer.logins(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn transport_errors_reconnect_and_reset_index_cumulative_volume() {
        let peer = Peer::ok();
        let (_stream, mut events, _) = peer.start(fast(), &[kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        peer.real(0, vec![index(505_969, 1000)]);
        assert_eq!(tick(next(&mut events).await).qty, Volume(0));
        peer.frames.lock().unwrap()[0].unbounded_send(Err(WsError::ConnectionClosed)).unwrap();
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        peer.real(1, vec![index(506_010, 1250)]);
        assert_eq!(tick(next(&mut events).await).qty, Volume(0));
    }

    #[tokio::test(start_paused = true)]
    async fn malformed_frames_and_stale_acks_do_not_interrupt_the_live_session() {
        let peer = Peer::ok();
        let (_stream, mut events, _) = peer.start(fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        peer.send(0, Message::Text("invalid json".into()));
        peer.send(0, Message::Text(r#"{"trnm":"REG","return_code":105118}"#.into()));
        peer.real(0, vec![json!({"type":"0B", "item":"005930_AL", "values":{"20":"x"}}), trade("093001", 71_200, 15, 100, "KRX")]);
        assert_eq!(tick(next(&mut events).await).price.centi(), 7_120_000);
        assert_eq!(peer.logins(), 1);
    }
}
