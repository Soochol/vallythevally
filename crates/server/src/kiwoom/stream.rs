//! 키움 WebSocket 세션(backend.md §5.1, §5.2). 토큰 하나에 세션 하나라서 서버 안에서도 세션은 언제나 하나다.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use domain::{IndexCode, KstTime, Price, Symbol, TimeOfDay, Volume};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep_until, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

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
        let (stream, desired) = KiwoomStream::detached();
        let (events, rx) = mpsc::channel(EVENT_BUFFER);
        let session = Session { url, rest, clock, timings, desired, events, budget: TokenBudget::Fresh, rebuild: ControlBudget::Fresh, dropped: Dropped::default() };
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
    url: String,
    rest: KiwoomRest,
    clock: Clock,
    timings: Timings,
    desired: watch::Receiver<BTreeSet<Symbol>>,
    events: mpsc::Sender<StreamEvent>,
    budget: TokenBudget,
    rebuild: ControlBudget,
    dropped: Dropped,
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

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
        match timeout(self.timings.control, connect_async(self.url.as_str())).await {
            Ok(Ok((ws, _))) => SessionState::LoggingIn { conn: Conn::new(ws, self.timings.silence), attempt },
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
        let _ = timeout(self.silence, self.ws.close(None)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use domain::{IndexCode, StockCode};
    use fake_kiwoom::{APP_KEY, APP_SECRET, FakeKiwoom, TOKEN, tick_0j, trade_0b};

    use super::*;
    use crate::config::Secret;
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::transport::ReqwestTransport;
    use crate::kiwoom::wire::TokenResponse;

    const WAIT: Duration = Duration::from_secs(3);

    fn samsung() -> Symbol {
        Symbol::Stock(StockCode::parse("005930").unwrap())
    }

    fn kospi() -> Symbol {
        Symbol::Index(IndexCode::KOSPI)
    }

    fn fast() -> Timings {
        Timings { control: Duration::from_millis(500), silence: Duration::from_secs(2), backoff: [Duration::from_millis(50); 5], live_resets_backoff_after: Duration::from_secs(60), rate_limit_pause: Duration::from_millis(300) }
    }

    fn rest(fake: &FakeKiwoom) -> KiwoomRest {
        let transport = ReqwestTransport::new(fake.base_url()).unwrap();
        KiwoomRest::new(Arc::new(transport), KiwoomAuth::new(Secret::new(APP_KEY.into()), Secret::new(APP_SECRET.into()), None), Clock::system())
    }

    fn holding_unrecorded(rest: &KiwoomRest, token: &str) {
        rest.auth().record_issued(TokenResponse { token: token.into(), expires_dt: "20991231000000".into() }, Clock::system().now()).unwrap();
    }

    fn start(fake: &FakeKiwoom, rest: KiwoomRest, timings: Timings, desired: &[Symbol]) -> (KiwoomStream, mpsc::Receiver<StreamEvent>) {
        let (stream, events) = KiwoomStream::spawn_with(fake.ws_url(), rest, Clock::system(), timings);
        stream.set_desired(desired.iter().copied().collect());
        (stream, events)
    }

    async fn next(events: &mut mpsc::Receiver<StreamEvent>) -> StreamEvent {
        timeout(WAIT, events.recv()).await.expect("이벤트가 오지 않았다").expect("세션 태스크가 끝났다")
    }

    async fn until(what: &str, f: impl Fn() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !f() {
            assert!(Instant::now() < deadline, "기다린 상태가 되지 않았다: {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn registered(fake: &FakeKiwoom) -> Vec<(String, Vec<String>)> {
        fake.ws_stats().registered.into_iter().collect()
    }

    fn both_registered() -> Vec<(String, Vec<String>)> {
        vec![("0B".into(), vec!["005930_AL".into()]), ("0J".into(), vec!["001".into()])]
    }

    fn tick(event: StreamEvent) -> RealTick {
        match event {
            StreamEvent::Tick { tick, .. } => tick,
            other => panic!("체결이 아니다: {other:?}"),
        }
    }

    #[tokio::test]
    async fn logs_in_registers_the_desired_set_and_turns_live() {
        let fake = FakeKiwoom::start().await;
        let (_stream, mut events) = start(&fake, rest(&fake), fast(), &[samsung(), kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(registered(&fake), both_registered());
        assert_eq!(fake.ws_stats().controls, ["LOGIN", "REG"], "원하는 집합을 REG 하나로");
        assert_eq!(fake.issued(), 1);
    }

    #[tokio::test]
    async fn trades_become_ticks_and_auction_only_frames_are_dropped() {
        let fake = FakeKiwoom::start().await;
        let (_stream, mut events) = start(&fake, rest(&fake), fast(), &[samsung(), kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(fake.push_real("0B", "005930_AL", trade_0b("093001", -71_200, -15, 100, "NXT")), 1);
        let t = tick(next(&mut events).await);
        assert_eq!((t.symbol, t.hhmmss, t.price.centi(), t.qty, t.exchange), (samsung(), TimeOfDay::hms(9, 30, 1).unwrap(), 7_120_000, Volume(15), Some(Exchange::Nxt)));
        fake.push_real("0B", "005930_AL", trade_0b("093002", 71_300, 0, 100, "KRX"));
        fake.push_real("0B", "005930_AL", trade_0b("093003", 71_400, 7, 107, "KRX"));
        let t = tick(next(&mut events).await);
        assert_eq!((t.hhmmss, t.price.centi(), t.qty, t.exchange), (TimeOfDay::hms(9, 30, 3).unwrap(), 7_140_000, Volume(7), Some(Exchange::Krx)), "체결량 0인 프레임은 오지 않는다");
    }

    #[tokio::test]
    async fn index_ticks_take_the_level_and_the_cumulative_volume_increase() {
        let fake = FakeKiwoom::start().await;
        let (_stream, mut events) = start(&fake, rest(&fake), fast(), &[kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        let mut got = Vec::new();
        for (cum, centi) in [(1_000, -505_969), (1_250, 506_010), (1_200, 506_020)] {
            fake.push_real("0J", "001", tick_0j("093001", centi, cum));
            let t = tick(next(&mut events).await);
            assert_eq!((t.symbol, t.exchange), (kospi(), None));
            got.push((t.price.centi(), t.qty.0));
        }
        assert_eq!(got, [(505_969, 0), (506_010, 250), (506_020, 0)], "첫 프레임은 0, 줄면 0");
    }

    #[tokio::test]
    async fn ping_is_echoed() {
        let fake = FakeKiwoom::start().await;
        let (_stream, mut events) = start(&fake, rest(&fake), fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        fake.set_ping_every(Duration::from_millis(30));
        until("PING 세 번을 돌려보냈다", || fake.ws_stats().pongs >= 3).await;
        assert_eq!(fake.ws_stats().logins, 1);
    }

    #[tokio::test]
    async fn desired_changes_are_one_reg_and_one_remove_per_type() {
        let fake = FakeKiwoom::start().await;
        let (stream, mut events) = start(&fake, rest(&fake), fast(), &[samsung(), kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        stream.set_desired(BTreeSet::new());
        until("모두 해지됐다", || registered(&fake).is_empty()).await;
        assert_eq!(fake.ws_stats().controls, ["LOGIN", "REG", "REMOVE", "REMOVE"], "0B와 0J를 섞으면 105112다");
        stream.set_desired([samsung(), kospi()].into());
        until("다시 등록됐다", || registered(&fake) == both_registered()).await;
        assert_eq!(fake.ws_stats().controls, ["LOGIN", "REG", "REMOVE", "REMOVE", "REG"]);
        assert_eq!(fake.ws_stats().logins, 1);
    }

    #[tokio::test]
    async fn a_dropped_session_goes_down_then_logs_in_again_with_the_same_token_and_registers_everything() {
        let fake = FakeKiwoom::start().await;
        let (_stream, mut events) = start(&fake, rest(&fake), fast(), &[samsung(), kospi()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        fake.drop_sessions(1000, "Bye");
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(registered(&fake), both_registered());
        assert_eq!(fake.ws_stats().controls, ["LOGIN", "REG", "LOGIN", "REG"]);
        assert_eq!(fake.issued(), 1, "다시 연결할 때 토큰을 새로 받지 않는다");
    }

    #[tokio::test]
    async fn silence_closes_the_session() {
        let fake = FakeKiwoom::start().await;
        let timings = Timings { silence: Duration::from_millis(300), ..fast() };
        let (_stream, mut events) = start(&fake, rest(&fake), timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        fake.mute_ws(true);
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        fake.mute_ws(false);
        fake.set_ping_every(Duration::from_millis(50));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(events.try_recv().is_err(), "PING이 오는 동안은 끊지 않는다");
    }

    #[tokio::test]
    async fn a_rejected_login_reissues_the_token_once_and_recovers() {
        let fake = FakeKiwoom::start().await;
        let rest = rest(&fake);
        holding_unrecorded(&rest, "FAKE-TOKEN-revoked");
        let (_stream, mut events) = start(&fake, rest, fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(fake.issued(), 1);
        assert_eq!(fake.ws_stats().controls, ["LOGIN", "LOGIN", "REG"]);
    }

    #[tokio::test]
    async fn a_login_rejected_again_after_the_one_reissue_halts() {
        let fake = FakeKiwoom::start().await;
        fake.reject_token(TOKEN);
        let rest = rest(&fake);
        holding_unrecorded(&rest, "FAKE-TOKEN-revoked");
        let (_stream, mut events) = start(&fake, rest.clone(), fast(), &[samsung()]);
        assert_eq!(next(&mut events).await, StreamEvent::Halted);
        assert!(timeout(Duration::from_millis(300), events.recv()).await.unwrap().is_none(), "멈추면 태스크가 끝난다");
        assert_eq!((fake.issued(), fake.ws_stats().controls), (1, vec!["LOGIN".to_owned(), "LOGIN".to_owned()]));
        assert!(rest.halted().is_none(), "조회는 멈추지 않는다");
    }

    #[tokio::test]
    async fn a_reissue_refused_by_the_issue_interval_waits_instead_of_looping() {
        let fake = FakeKiwoom::start().await;
        fake.reject_token(TOKEN);
        let (_stream, mut events) = start(&fake, rest(&fake), fast(), &[samsung()]);
        until("첫 LOGIN이 거절됐다", || fake.ws_stats().controls == ["LOGIN"]).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!((fake.issued(), fake.ws_stats().controls), (1, vec!["LOGIN".to_owned()]), "10분 뒤에야 다시 받는다");
        assert!(events.try_recv().is_err(), "Halted도 Live도 아니다");
    }

    #[tokio::test]
    async fn dropping_the_handle_ends_the_session() {
        let fake = FakeKiwoom::start().await;
        let (stream, mut events) = start(&fake, rest(&fake), fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        drop(stream);
        until("세션이 닫혔다", || fake.ws_stats().sessions == 0).await;
        assert!(timeout(WAIT, events.recv()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_wss_handshake_fails_without_a_crypto_provider_panic() {
        let fake = FakeKiwoom::start().await;
        let url = format!("wss://127.0.0.1:{}/api/dostk/websocket", fake.addr.port());
        let result = timeout(WAIT, connect_async(url.as_str())).await.expect("시간 안에 끝난다");
        assert!(result.is_err(), "평문 HTTP 포트와는 TLS가 맺어지지 않는다");
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

    struct Peer {
        url: String,
        seen: Arc<std::sync::Mutex<Vec<(usize, String, Instant)>>>,
    }

    impl Peer {
        async fn start(script: impl Fn(usize, &str, usize) -> Reply + Send + Sync + 'static) -> Peer {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}/api/dostk/websocket", listener.local_addr().unwrap());
            let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
            let script = Arc::new(script);
            let log = seen.clone();
            tokio::spawn(async move {
                for conn in 0.. {
                    let (tcp, _) = listener.accept().await.unwrap();
                    if matches!(script(conn, "CONNECT", 1), Reply::Refuse) {
                        drop(tcp);
                        continue;
                    }
                    let (script, log) = (script.clone(), log.clone());
                    tokio::spawn(async move {
                        let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                        let mut counts: HashMap<String, usize> = HashMap::new();
                        while let Some(Ok(Message::Text(text))) = ws.next().await {
                            let trnm = serde_json::from_str::<serde_json::Value>(text.as_str()).unwrap()["trnm"].as_str().unwrap().to_owned();
                            log.lock().unwrap().push((conn, trnm.clone(), Instant::now()));
                            let nth = counts.entry(trnm.clone()).and_modify(|n| *n += 1).or_insert(1);
                            let ack = |code: u32| Message::Text(serde_json::json!({"trnm": trnm, "return_code": code, "return_msg": ""}).to_string().into());
                            match script(conn, &trnm, *nth) {
                                Reply::Ok => ws.send(ack(0)).await.unwrap(),
                                Reply::OkThenFlood => {
                                    ws.send(ack(0)).await.unwrap();
                                    let item = serde_json::json!({"type":"0B", "name":"주식체결", "item":"005930_AL", "values":trade_0b("093001", 71000, 1, 100, "KRX")});
                                    let frame = serde_json::json!({"trnm":"REAL", "data":vec![item; EVENT_BUFFER]});
                                    ws.send(Message::Text(frame.to_string().into())).await.unwrap();
                                }
                                Reply::Code(code) => ws.send(ack(code)).await.unwrap(),
                                Reply::Silent | Reply::Refuse => {}
                                Reply::OkThenBye => {
                                    ws.send(ack(0)).await.unwrap();
                                    let _ = ws.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: 1000.into(), reason: "Bye".into() })).await;
                                }
                            }
                        }
                    });
                }
            });
            Peer { url, seen }
        }

        fn controls(&self, conn: usize) -> Vec<String> {
            self.seen.lock().unwrap().iter().filter(|(c, ..)| *c == conn).map(|(_, t, _)| t.clone()).collect()
        }

        fn logins(&self) -> usize {
            self.seen.lock().unwrap().iter().filter(|(_, t, _)| t == "LOGIN").count()
        }

        fn sent_at(&self, conn: usize, trnm: &str) -> Vec<Instant> {
            self.seen.lock().unwrap().iter().filter(|(c, t, _)| *c == conn && t == trnm).map(|(.., at)| *at).collect()
        }
    }

    fn start_with(peer: &Peer, fake: &FakeKiwoom, timings: Timings, desired: &[Symbol]) -> (KiwoomStream, mpsc::Receiver<StreamEvent>) {
        let (stream, events) = KiwoomStream::spawn_with(peer.url.clone(), rest(fake), Clock::system(), timings);
        stream.set_desired(desired.iter().copied().collect());
        (stream, events)
    }

    #[tokio::test]
    async fn a_control_answered_too_late_drops_the_connection_instead_of_resending_on_it() {
        let fake = FakeKiwoom::start().await;
        let peer = Peer::start(|conn, trnm, _| match (conn, trnm) {
            (0, "REG") => Reply::Silent,
            _ => Reply::Ok,
        })
        .await;
        let (_stream, mut events) = start_with(&peer, &fake, fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(peer.controls(0), ["LOGIN", "REG"], "응답 없는 REG를 같은 연결로 다시 보내면 늦은 ACK가 어느 요청의 것인지 모른다");
        assert_eq!(peer.controls(1), ["LOGIN", "REG"]);
    }

    #[tokio::test]
    async fn a_registration_refused_for_capacity_rebuilds_once_then_halts_only_the_stream() {
        for code in [105115, 105118] {
            let fake = FakeKiwoom::start().await;
            let peer = Peer::start(move |_, trnm, _| if trnm == "REG" { Reply::Code(code) } else { Reply::Ok }).await;
            let (_stream, mut events) = start_with(&peer, &fake, fast(), &[samsung()]);
            assert_eq!(next(&mut events).await, StreamEvent::Halted, "{code}");
            assert_eq!(peer.logins(), 2, "{code}: 처음 하나와 다시 구성 한 번");
            assert_eq!(fake.issued(), 1);
        }
    }

    #[tokio::test]
    async fn a_rate_limited_registration_waits_before_it_is_sent_again_on_the_same_connection() {
        let fake = FakeKiwoom::start().await;
        let peer = Peer::start(|_, trnm, nth| if (trnm, nth) == ("REG", 1) { Reply::Code(105110) } else { Reply::Ok }).await;
        let (_stream, mut events) = start_with(&peer, &fake, fast(), &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        let regs = peer.sent_at(0, "REG");
        assert_eq!(regs.len(), 2, "같은 연결에서 다시 보낸다");
        assert!(regs[1] - regs[0] >= fast().rate_limit_pause, "105110 뒤 바로 다시 보냈다: {:?}", regs[1] - regs[0]);
        assert_eq!(peer.logins(), 1);
    }

    #[tokio::test]
    async fn sessions_that_drop_right_after_turning_live_back_off_further_each_time() {
        let fake = FakeKiwoom::start().await;
        let timings = Timings { backoff: [Duration::from_millis(100), Duration::from_millis(300), Duration::from_millis(700), Duration::from_millis(700), Duration::from_millis(700)], ..fast() };
        let (_stream, mut events) = start(&fake, rest(&fake), timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        let mut waits = Vec::new();
        for _ in 0..3 {
            fake.drop_sessions(1000, "Bye");
            assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
            let at = Instant::now();
            assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
            waits.push(at.elapsed());
        }
        assert!(waits[1] >= Duration::from_millis(300) && waits[2] >= Duration::from_millis(700), "곧 끊기는 세션은 실패로 쌓인다: {waits:?}");
    }

    #[tokio::test]
    async fn a_session_that_stayed_live_long_enough_starts_the_backoff_over() {
        let fake = FakeKiwoom::start().await;
        let timings = Timings { backoff: [Duration::from_millis(100), Duration::from_millis(700), Duration::from_millis(700), Duration::from_millis(700), Duration::from_millis(700)], live_resets_backoff_after: Duration::from_millis(400), ..fast() };
        let (_stream, mut events) = start(&fake, rest(&fake), timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        fake.drop_sessions(1000, "Bye");
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        tokio::time::sleep(timings.live_resets_backoff_after).await;
        fake.drop_sessions(1000, "Bye");
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        let at = Instant::now();
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert!(at.elapsed() < Duration::from_millis(500), "안정된 연결 뒤에는 첫 간격으로 돌아간다: {:?}", at.elapsed());
    }

    #[tokio::test]
    async fn a_stable_session_gets_its_control_rebuild_back() {
        let fake = FakeKiwoom::start().await;
        let peer = Peer::start(|conn, trnm, nth| match (conn, trnm, nth) {
            (0, "REG", _) => Reply::Silent,
            (1 | 2, "REG", 2) => Reply::Silent,
            _ => Reply::Ok,
        })
        .await;
        let timings = Timings { control: Duration::from_millis(200), live_resets_backoff_after: Duration::from_millis(300), ..fast() };
        let (stream, mut events) = start_with(&peer, &fake, timings, &[samsung()]);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        tokio::time::sleep(timings.live_resets_backoff_after).await;
        stream.set_desired([samsung(), kospi()].into());
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }), "안정된 세션 뒤라 다시 구성한다");
        stream.set_desired([samsung()].into());
        until("REMOVE가 받아들여졌다", || peer.controls(2).contains(&"REMOVE".to_owned())).await;
        stream.set_desired([samsung(), kospi()].into());
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        assert_eq!(next(&mut events).await, StreamEvent::Halted, "다시 구성한 세션이 안정되기 전에 또 실패했다");
        assert_eq!(peer.logins(), 3);
    }

    #[tokio::test]
    async fn replacing_one_of_two_hundred_registrations_removes_before_it_registers() {
        let fake = FakeKiwoom::start().await;
        let stock = |n: u32| Symbol::Stock(StockCode::parse(&format!("{n:06}")).unwrap());
        let desired: Vec<Symbol> = (1..=200).map(stock).collect();
        let (stream, mut events) = start(&fake, rest(&fake), fast(), &desired);
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        stream.set_desired((2..=201).map(stock).collect());
        until("바꾼 종목이 등록됐다", || fake.ws_stats().registered.get("0B").is_some_and(|items| items.contains(&"000201_AL".to_owned()))).await;
        let stats = fake.ws_stats();
        assert_eq!((stats.logins, stats.controls), (1, vec!["LOGIN".to_owned(), "REG".to_owned(), "REMOVE".to_owned(), "REG".to_owned()]), "201개가 되는 순간이 없어야 나머지 199개가 끊기지 않는다");
        assert!(events.try_recv().is_err(), "끊기지 않았다");
    }

    #[tokio::test]
    async fn dropped_sessions_and_failed_connections_never_spend_the_control_rebuild() {
        let fake = FakeKiwoom::start().await;
        let peer = Peer::start(|conn, trnm, _| match (conn, trnm) {
            (0 | 1, "CONNECT") => Reply::Refuse,
            (2..=4, "REG") => Reply::OkThenBye,
            (_, "REG") => Reply::Code(105118),
            _ => Reply::Ok,
        })
        .await;
        let (_stream, mut events) = start_with(&peer, &fake, fast(), &[samsung()]);
        for _ in 2..=4 {
            assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
            assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        }
        assert_eq!(next(&mut events).await, StreamEvent::Halted);
        assert_eq!(peer.logins(), 5, "07:50 같은 단절과 접속 실패 뒤에도 거절된 REG에 다시 구성 한 번이 남아 있다");
    }

    #[tokio::test]
    async fn down_delivery_delay_does_not_reset_the_control_budget() {
        let fake = FakeKiwoom::start().await;
        let peer = Peer::start(|conn, trnm, nth| match (conn, trnm, nth) {
            (0, "REG", _) | (1, "REG", 2) => Reply::Code(105118),
            (1, "REG", 1) => Reply::OkThenFlood,
            _ => Reply::Ok,
        }).await;
        let (stream, desired) = KiwoomStream::detached();
        let (events_tx, mut events) = mpsc::channel(EVENT_BUFFER);
        let session = Session { url: peer.url.clone(), rest: rest(&fake), clock: Clock::system(), timings: Timings::default(), desired, events: events_tx, budget: TokenBudget::Fresh, rebuild: ControlBudget::Fresh, dropped: Dropped::default() };
        let sender = session.events.clone();
        stream.set_desired([samsung()].into());
        tokio::spawn(session.run());
        assert!(matches!(next(&mut events).await, StreamEvent::Live { .. }));
        assert_eq!(peer.logins(), 2, "one rebuild already spent");
        let live_at = Instant::now();
        until("4096 real WS ticks fill the production event queue", || sender.capacity() == 0).await;
        stream.set_desired([samsung(), kospi()].into());
        until("second capacity rejection", || peer.controls(1).len() == 3).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(live_at.elapsed() < Duration::from_secs(1));
        assert_eq!(sender.capacity(), 0);
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::time::resume();
        for _ in 0..EVENT_BUFFER { assert!(matches!(events.recv().await.unwrap(), StreamEvent::Tick { .. })); }
        assert!(matches!(next(&mut events).await, StreamEvent::Down { .. }));
        let actual = next(&mut events).await;
        println!("second control failure at <1s Live; Down delivery stalled 61s; actual={actual:?}, LOGIN={}", peer.logins());
        assert_eq!(actual, StreamEvent::Halted, "time after connection close is not stable Live time");
        assert_eq!(peer.logins(), 2);
    }
}
