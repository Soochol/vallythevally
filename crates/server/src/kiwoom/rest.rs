//! 키움 조회 대기열(backend.md §4.2, §4.3). 서버 전체의 키움 REST 요청은 여기 한 곳에서 나간다.
//!
//! - TR(api-id)마다 최근 1초 전송 수를 센다. 한도(실전 5, 모의 1) 미만이면 곧바로 보내고, 찼으면 창 안 가장 오래된 전송 + 1초 + 여유(`WINDOW_MARGIN`)에 보낸다. TR 사이에는 간격이 없다.
//!   주문 쓰기 네 TR(`kt10000`~`kt10003`)은 한 창으로 센다. 토큰 발급, 다시 보내기, 연속조회 페이지도 같은 창에 센다.
//! - `TOTAL_PER_SECOND_LIMIT`을 켜면 TR별 창과 별개로 모든 TR의 합계 창도 지킨다. 기본은 꺼져 있다.
//! - 제한 응답은 그 TR(주문 쓰기면 묶음)만 창이 비는 시각까지 붙잡고 같은 요청을 그때 다시 보낸다. 응답의 `유량=N`이 그 TR의 한도가 된다. 대기열 전체는 멈추지 않는다.
//! - 주문 쓰기도 제한 응답(HTTP 429)이면 최대 `ORDER_RATE_LIMIT_RESENDS`번 다시 보낸다. 그 밖의 실패는 다시 보내지 않는다.
//! - 1분마다 TR별 전송·제한 응답·다시 보낸 수와 창 때문에 기다린 가장 긴 시간을 로그 한 줄씩 남긴다.
//! - 시험용 손잡이(`with_send_spacing`)로 만든 대기열은 창 대신 모든 전송 사이 최소 간격을 둔다. 모의투자는 거기에 같은 TR 1초를 더한다.
//! - 토큰 발급이 먼저 나가고, 그다음 `Screen` > `Recovery` > `Background` 순서다.
//! - 토큰은 보내는 순간에 읽는다(D16). 대기 중인 요청은 토큰을 쥐고 있지 않다.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{Notify, oneshot, watch};
use tokio::time::Instant;

use super::api::{Endpoint, MarketRequest};
use crate::trading::TradingApiId;
use super::auth::{AuthError, BeginIssueError, Halt, KiwoomAuth, MIN_ISSUE_INTERVAL_SECS, TokenGen};
use super::error::{self, Category, Failure, Note, Retry, Stop, Surface};
use super::token_file::FileError;
use super::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use super::wire::TokenResponse;
use crate::api::{ApiErrorCode, ApiErrorReason, KiwoomEnvironment};
use crate::clock::Clock;
use crate::config::Secret;
use domain::KstTime;

const SEND_WINDOW: Duration = Duration::from_secs(1);
const WINDOW_MARGIN: Duration = Duration::from_millis(50);
const REAL_SENDS_PER_WINDOW: u32 = 5;
const MOCK_SENDS_PER_WINDOW: u32 = 1;
const MOCK_SAME_TR_SPACING: Duration = Duration::from_secs(1);
const TOTAL_PER_SECOND_LIMIT: Option<u32> = None;
const MAX_RATE_LIMITED: u8 = 3;
const ORDER_RATE_LIMIT_RESENDS: u8 = 2;
const COUNTER_REPORT_PERIOD: Duration = Duration::from_secs(60);
const SCREEN_RETRY_DELAYS: &[Duration] = &[Duration::from_millis(500)];
const OTHER_RETRY_DELAYS: &[Duration] = &[Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)];
const SCREEN_SEND_BUDGET: u8 = 4;
const OTHER_SEND_BUDGET: u8 = 6;
const GATE_WAIT: Duration = Duration::from_secs(30);
const GATE_LONG_WAIT: Duration = Duration::from_secs(5 * 60);
const GATE_MISSES_BEFORE_LONG_WAIT: u8 = 3;
const AUTH_GATE_WAIT: Duration = Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    Order,
    /// 브라우저가 기다리는 요청: 봉 페이지, 서버를 켤 때의 종목 목록.
    Screen,
    /// 끊긴 구간 복구 같은 것(#4). #2에는 부르는 곳이 없다.
    Recovery,
    /// 07:45 종목 목록 갱신 같은 것. 앞의 둘이 비었을 때만 나간다.
    Background,
}

impl Priority {
    fn lane(self) -> usize {
        self as usize
    }

    fn send_budget(self) -> u8 {
        if matches!(self, Priority::Order | Priority::Screen) { SCREEN_SEND_BUDGET } else { OTHER_SEND_BUDGET }
    }
}

/// 응답 헤더가 `cont-yn: Y`일 때의 `next-key`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContKey(String);

impl ContKey {
    pub fn new(s: impl Into<String>) -> Self {
        ContKey(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 같은 요청 합치기의 범위. 범위가 다르면 내용이 같아도 합치지 않고 따로 보낸다.
/// `BarService`는 07:45 비우기마다 범위를 바꿔, 비우기 전 조회의 응답이 새 캐시에 들어가지 않게 한다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum MergeScope {
    #[default]
    Shared,
    Bars(u64),
    Summary(u64),
}

#[derive(Debug)]
pub struct Page<T> {
    pub body: T,
    pub next: Option<ContKey>,
    pub continues_without_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KiwoomError {
    Failed(Failure),
    Gated { until: KstTime, cause: GateCause },
    Stopped(Failure),
    TokenFile(FileError),
    NotConnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Closed,
    Connecting,
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateCause {
    IssueInterval,
    Failure(Failure),
}

impl KiwoomError {
    pub fn failure(&self) -> Option<&Failure> {
        match self {
            KiwoomError::Failed(f) | KiwoomError::Stopped(f) | KiwoomError::Gated { cause: GateCause::Failure(f), .. } => Some(f),
            KiwoomError::Gated { cause: GateCause::IssueInterval, .. } | KiwoomError::TokenFile(_) | KiwoomError::NotConnected => None,
        }
    }

    pub fn retry_at(&self) -> Option<KstTime> {
        match self {
            KiwoomError::Gated { until, .. } => Some(*until),
            KiwoomError::Failed(_) | KiwoomError::Stopped(_) | KiwoomError::TokenFile(_) | KiwoomError::NotConnected => None,
        }
    }

    pub fn manual_action_required(&self) -> bool {
        matches!(self, KiwoomError::Stopped(_) | KiwoomError::TokenFile(_))
    }

    pub fn shown(&self) -> Shown {
        Shown { code: self.shown_code(), reason: self.shown_reason(), retry_at: self.retry_at(), manual_action_required: self.manual_action_required() }
    }

    fn shown_code(&self) -> ApiErrorCode {
        match self.failure().map(Failure::surface) {
            Some(Surface::Unavailable) => ApiErrorCode::KiwoomUnavailable,
            Some(Surface::AuthFailed) => ApiErrorCode::KiwoomAuthFailed,
            Some(Surface::UnknownSymbol) => ApiErrorCode::UnknownSymbol,
            Some(Surface::Internal) => ApiErrorCode::Internal,
            None if matches!(self, KiwoomError::TokenFile(_)) => ApiErrorCode::KiwoomAuthFailed,
            None => ApiErrorCode::KiwoomUnavailable,
        }
    }

    fn shown_reason(&self) -> ApiErrorReason {
        use ApiErrorReason as R;
        let Some(f) = self.failure() else {
            return match self {
                KiwoomError::TokenFile(_) => R::TokenFile,
                KiwoomError::NotConnected => R::NotConnected,
                _ => R::IssueInterval,
            };
        };
        match f.category() {
            Category::RateLimit => R::RateLimited,
            Category::Transient => match f.note() {
                Note::Transport(t) if t.timed_out => R::KiwoomTimeout,
                Note::Transport(_) | Note::QueueGone => R::KiwoomUnreachable,
                _ => R::KiwoomError,
            },
            Category::TokenInvalid => R::TokenInvalid,
            Category::AuthBlocked => R::AuthBlocked,
            Category::AuthIndeterminate => R::AuthIndeterminate,
            Category::InvalidRequest | Category::BatchLimit => R::InvalidRequest,
            Category::BusinessRejected => R::BusinessRejected,
            Category::SymbolMismatch => R::SymbolMismatch,
            Category::Unsupported => R::Unsupported,
            Category::Protocol => R::Protocol,
            Category::Unknown | Category::RealtimeCapacity | Category::ControlRejected | Category::SubscriptionMismatch => R::UnknownFailure,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shown {
    pub code: ApiErrorCode,
    pub reason: ApiErrorReason,
    pub retry_at: Option<KstTime>,
    pub manual_action_required: bool,
}

impl fmt::Display for KiwoomError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KiwoomError::Failed(failure) => failure.fmt(f),
            KiwoomError::Gated { until, cause: GateCause::IssueInterval } => write!(
                f,
                "키움 토큰은 발급 사이를 {}분 띄웁니다. {until}부터 다시 받으니 그 뒤에 다시 시도하세요",
                MIN_ISSUE_INTERVAL_SECS / 60
            ),
            KiwoomError::Gated { until, cause: GateCause::Failure(failure) } => write!(f, "{failure}. {until}에 확인 요청 하나를 보냅니다"),
            KiwoomError::Stopped(failure) => match failure.category() {
                Category::AuthBlocked | Category::Unsupported | Category::Unknown | Category::Protocol => failure.fmt(f),
                _ => write!(f, "{failure}. 운영자가 확인하고 서버를 다시 켤 때까지 보내지 않습니다"),
            },
            KiwoomError::NotConnected => f.write_str("키움에 연결하지 않았습니다. 시스템 설정에서 연결하세요"),
            KiwoomError::TokenFile(e) => write!(
                f,
                "토큰 파일을 쓸 수 없어 키움 토큰을 발급하지 않습니다({e}). 파일을 고치거나, 마지막 발급 요청에서 {}분이 지난 뒤 지우고 시스템 설정에서 토큰 파일을 다시 확인하세요",
                MIN_ISSUE_INTERVAL_SECS / 60
            ),
        }
    }
}

impl std::error::Error for KiwoomError {}

impl From<Halt> for KiwoomError {
    fn from(h: Halt) -> Self {
        match h {
            Halt::Rejected(failure) => KiwoomError::Stopped(failure),
            Halt::TokenFileUnreadable(e) => KiwoomError::TokenFile(e),
        }
    }
}

#[derive(Clone)]
struct RawPage {
    body: Arc<str>,
    next: Option<ContKey>,
    continues_without_key: bool,
    envelope: error::Envelope,
}

type JobResult = Result<RawPage, KiwoomError>;

/// 같은 요청 합치기의 키: (합치기 범위, api-id, 정규화한 본문, 연속조회 키).
#[derive(Clone, PartialEq, Eq, Hash)]
struct DedupeKey {
    scope: MergeScope,
    api_id: Endpoint,
    body: String,
    cont: Option<ContKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JobState {
    Queued,
    InFlight,
    /// 네트워크 오류 뒤 다시 보내기 전까지 쉬는 중.
    Backoff,
}

pub(crate) type Admission = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone, Default)]
pub(crate) struct Transmitted(Arc<std::sync::atomic::AtomicBool>);

impl Transmitted {
    pub(crate) fn happened(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub(crate) struct SendOnce {
    pub transmitted: Transmitted,
}

pub(crate) struct Dispatch<'a> {
    pub endpoint: Endpoint,
    pub body: String,
    pub cont: Option<&'a ContKey>,
    pub priority: Priority,
    pub scope: MergeScope,
    pub admit: Option<Admission>,
    pub once: Option<SendOnce>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum WindowKey {
    Tr(Endpoint),
    OrderWrites,
}

impl WindowKey {
    fn of(endpoint: Endpoint) -> Self {
        match endpoint {
            Endpoint::Trading(TradingApiId::Kt10000 | TradingApiId::Kt10001 | TradingApiId::Kt10002 | TradingApiId::Kt10003) => WindowKey::OrderWrites,
            other => WindowKey::Tr(other),
        }
    }
}

struct SendWindow {
    sent: VecDeque<Instant>,
    limit: u32,
    held_until: Option<Instant>,
}

impl SendWindow {
    fn new(limit: u32) -> Self {
        SendWindow { sent: VecDeque::new(), limit, held_until: None }
    }

    fn span() -> Duration {
        SEND_WINDOW + WINDOW_MARGIN
    }

    fn forget_expired(&mut self, now: Instant) {
        while self.sent.front().is_some_and(|&t| t + Self::span() <= now) {
            self.sent.pop_front();
        }
    }

    fn record(&mut self, now: Instant) {
        self.forget_expired(now);
        self.sent.push_back(now);
    }

    fn ready_at(&self, now: Instant, limited: bool) -> Option<Instant> {
        let first_live = self.sent.partition_point(|&t| t + Self::span() <= now);
        let live = self.sent.len() - first_live;
        let full = (limited && live >= self.limit as usize).then(|| self.sent[first_live + live - self.limit as usize] + Self::span());
        full.into_iter().chain(self.held_until).max().filter(|&r| r > now)
    }

    fn hold_until_oldest_leaves(&mut self, now: Instant) {
        self.forget_expired(now);
        self.held_until = self.sent.front().map(|&t| t + Self::span());
    }

    fn set_limit(&mut self, limit: u32) -> bool {
        std::mem::replace(&mut self.limit, limit) != limit
    }
}

#[derive(Default)]
struct TrCounter {
    sent: u32,
    rate_limited: u32,
    resent: u32,
    max_wait: Duration,
    max_total_wait: Duration,
}

struct Job {
    once: Option<SendOnce>,
    admit: Option<Admission>,
    key: DedupeKey,
    priority: Priority,
    state: JobState,
    waiters: Vec<oneshot::Sender<JobResult>>,
    sends: u8,
    rate_limited: u8,
    transport_failures: usize,
    resent_after_invalid_token: bool,
    window_blocked_since: Option<Instant>,
    total_blocked_since: Option<Instant>,
}

#[derive(Default)]
enum Gate {
    #[default]
    Open,
    Closed { opens: Instant, until: KstTime, cause: Failure, misses: u8 },
    Probing { probe: u64, cause: Failure, misses: u8 },
}

#[derive(Default)]
struct Queue {
    lanes: [VecDeque<u64>; 4],
    jobs: HashMap<u64, Job>,
    by_key: HashMap<DedupeKey, u64>,
    issue_waiters: Vec<oneshot::Sender<Result<TokenGen, KiwoomError>>>,
    last_send: Option<Instant>,
    last_send_by_endpoint: HashMap<Endpoint, Instant>,
    windows: HashMap<WindowKey, SendWindow>,
    total: Option<SendWindow>,
    counters: HashMap<Endpoint, TrCounter>,
    next_id: u64,
    stopped_paths: HashMap<Endpoint, Failure>,
    failed_once: HashSet<Endpoint>,
    gate: Gate,
}

impl Queue {
    fn has_market_work(&self) -> bool {
        self.lanes.iter().any(|l| !l.is_empty())
    }

    fn window(&mut self, endpoint: Endpoint, default_limit: u32) -> &mut SendWindow {
        self.windows.entry(WindowKey::of(endpoint)).or_insert_with(|| SendWindow::new(default_limit))
    }

    fn requeue_front(&mut self, id: u64) {
        if let Some(job) = self.jobs.get_mut(&id) {
            job.state = JobState::Queued;
            self.lanes[job.priority.lane()].push_front(id);
        }
    }

    fn finish(&mut self, id: u64, result: JobResult) {
        if let Some(job) = self.jobs.remove(&id) {
            if job.once.is_none() {
                self.by_key.remove(&job.key);
            }
            for w in job.waiters {
                let _ = w.send(result.clone());
            }
        }
    }

    fn fail_queued(&mut self, err: &KiwoomError) {
        let ids: Vec<u64> = self.lanes.iter_mut().flat_map(|l| l.drain(..)).collect();
        for id in ids {
            self.finish(id, Err(err.clone()));
        }
    }

    fn stop_path(&mut self, failure: &Failure) {
        let api_id = failure.api_id();
        self.stopped_paths.insert(api_id, failure.clone());
        let jobs = &self.jobs;
        let mut ids = Vec::new();
        for lane in &mut self.lanes {
            lane.retain(|id| {
                let hit = jobs.get(id).is_some_and(|j| j.key.api_id == api_id);
                if hit {
                    ids.push(*id);
                }
                !hit
            });
        }
        for id in ids {
            self.finish(id, Err(KiwoomError::Stopped(failure.clone())));
        }
    }

    fn stopped(&self, api_id: Endpoint) -> Option<KiwoomError> {
        self.stopped_paths.get(&api_id).cloned().map(KiwoomError::Stopped)
    }
}

enum Pacing {
    PerTr,
    SharedSpacing(Duration),
}

struct Inner {
    transport: Arc<dyn Transport>,
    auth: KiwoomAuth,
    clock: Clock,
    pacing: Pacing,
    environment: KiwoomEnvironment,
    order_resends: u8,
    total_limit: Option<u32>,
    queue: Mutex<Queue>,
    wake: Notify,
    path_stopped: Notify,
    access: watch::Sender<Access>,
}

#[derive(Clone)]
pub struct KiwoomRest(Arc<Inner>);

impl fmt::Debug for KiwoomRest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KiwoomRest").field("auth", &self.0.auth).finish_non_exhaustive()
    }
}

enum Step {
    Idle,
    Wait(Instant),
    Issue,
    Send { id: u64, req: HttpRequest, generation: TokenGen, priority: Priority },
    Again,
}

impl KiwoomRest {
    /// 보내는 태스크를 하나 띄운다. tokio 런타임 안에서 부른다.
    pub fn new(transport: Arc<dyn Transport>, auth: KiwoomAuth, clock: Clock) -> Self {
        Self::for_environment(transport, auth, clock, KiwoomEnvironment::Real)
    }

    pub fn for_environment(transport: Arc<dyn Transport>, auth: KiwoomAuth, clock: Clock, environment: KiwoomEnvironment) -> Self {
        Self::start(transport, auth, clock, Pacing::PerTr, environment, ORDER_RATE_LIMIT_RESENDS, TOTAL_PER_SECOND_LIMIT)
    }

    pub fn with_send_spacing(transport: Arc<dyn Transport>, auth: KiwoomAuth, clock: Clock, send_spacing: Duration) -> Self {
        Self::build(transport, auth, clock, send_spacing, KiwoomEnvironment::Real)
    }

    pub(crate) fn build(transport: Arc<dyn Transport>, auth: KiwoomAuth, clock: Clock, send_spacing: Duration, environment: KiwoomEnvironment) -> Self {
        Self::start(transport, auth, clock, Pacing::SharedSpacing(send_spacing), environment, ORDER_RATE_LIMIT_RESENDS, TOTAL_PER_SECOND_LIMIT)
    }

    fn start(transport: Arc<dyn Transport>, auth: KiwoomAuth, clock: Clock, pacing: Pacing, environment: KiwoomEnvironment, order_resends: u8, total_limit: Option<u32>) -> Self {
        let inner = Arc::new(Inner { transport, auth, clock, pacing, environment, order_resends, total_limit, queue: Mutex::new(Queue { total: total_limit.map(SendWindow::new), ..Queue::default() }), wake: Notify::new(), path_stopped: Notify::new(), access: watch::channel(Access::Open).0 });
        tokio::spawn(run(inner.clone()));
        tokio::spawn(report_counters(inner.clone()));
        KiwoomRest(inner)
    }

    pub fn environment(&self) -> KiwoomEnvironment {
        self.0.environment
    }

    pub fn auth(&self) -> &KiwoomAuth {
        &self.0.auth
    }

    pub fn halted(&self) -> Option<KiwoomError> {
        self.0.auth.halted().map(KiwoomError::from)
    }

    pub async fn until_halted(&self) -> KiwoomError {
        self.0.auth.until_halted().await.into()
    }

    pub fn access(&self) -> Access {
        *self.0.access.borrow()
    }

    pub fn watch_access(&self) -> watch::Receiver<Access> {
        self.0.access.subscribe()
    }

    pub fn set_access(&self, access: Access) {
        self.0.access.send_replace(access);
        self.0.wake.notify_one();
    }

    pub fn blocked(&self) -> Option<KiwoomError> {
        let auth = &self.0.auth;
        let now = self.0.clock.now();
        if self.access() == Access::Closed {
            return Some(KiwoomError::NotConnected);
        }
        self.halted().or_else(|| {
            if !auth.needs_issue(now) {
                return None;
            }
            self.stopped(Endpoint::ISSUE)
                .or_else(|| Some(KiwoomError::Gated { until: auth.issue_blocked_until(now)?, cause: GateCause::IssueInterval }))
        })
    }

    pub fn gate_until(&self) -> Option<KstTime> {
        match &self.0.lock().gate {
            Gate::Closed { until, .. } => Some(*until),
            Gate::Open | Gate::Probing { .. } => None,
        }
    }

    pub fn stopped(&self, api_id: impl Into<Endpoint>) -> Option<KiwoomError> {
        self.0.lock().stopped(api_id.into())
    }

    pub async fn until_stopped(&self, api_id: impl Into<Endpoint>) -> KiwoomError {
        let api_id = api_id.into();
        loop {
            let notified = self.0.path_stopped.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(e) = self.stopped(api_id) {
                return e;
            }
            notified.await;
        }
    }

    /// 토큰을 새로 받는다. 서버를 켤 때와 매일 20:05에만 부른다.
    pub async fn issue_token(&self) -> Result<TokenGen, KiwoomError> {
        if self.access() == Access::Closed {
            return Err(KiwoomError::NotConnected);
        }
        let (tx, rx) = oneshot::channel();
        self.0.lock().issue_waiters.push(tx);
        self.0.wake.notify_one();
        rx.await.unwrap_or_else(|_| Err(queue_gone(Endpoint::ISSUE)))
    }

    /// 한 페이지를 받는다. `cont`가 있으면 그 연속조회 키로 다음 페이지를 받는다.
    pub async fn call<R: MarketRequest>(
        &self,
        req: &R,
        cont: Option<&ContKey>,
        priority: Priority,
        scope: MergeScope,
    ) -> Result<Page<R::Response>, KiwoomError> {
        let body = serde_json::to_string(req).expect("요청 타입은 언제나 직렬화된다");
        self.call_endpoint(Dispatch { endpoint: R::API_ID.into(), body, cont, priority, scope, admit: None, once: None }, |response| req.answers(response)).await
    }

    pub(crate) async fn call_endpoint<T: serde::de::DeserializeOwned>(&self, call: Dispatch<'_>, answers: impl FnOnce(&T) -> bool) -> Result<Page<T>, KiwoomError> {
        let Dispatch { endpoint, body, cont, priority, scope, admit, once } = call;
        let key = DedupeKey { scope, api_id: endpoint, body, cont: cont.cloned() };
        let once_requested = once.is_some();
        let rx = self.0.enqueue(key, priority, admit, once);
        let raw = rx.await.unwrap_or_else(|_| Err(queue_gone(endpoint)))?;
        let note = match serde_json::from_str::<T>(&raw.body) {
            Ok(body) if answers(&body) => return Ok(Page { body, next: raw.next, continues_without_key: raw.continues_without_key }),
            Ok(_) => Note::AnotherRequestsAnswer,
            Err(e) => Note::Schema { line: e.line(), column: e.column() },
        };
        tracing::error!(api_id = endpoint.as_str(), %note, "키움 응답을 읽지 못했습니다");
        let failure = Failure::schema(endpoint, raw.envelope, note);
        if once_requested {
            return Err(KiwoomError::Failed(failure));
        }
        Err(self.0.settle(&mut self.0.lock(), failure))
    }
}

async fn report_counters(inner: Arc<Inner>) {
    let mut ticks = tokio::time::interval_at(Instant::now() + COUNTER_REPORT_PERIOD, COUNTER_REPORT_PERIOD);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        let counters = std::mem::take(&mut inner.lock().counters);
        let mut lines: Vec<_> = counters.into_iter().filter(|(_, c)| c.sent > 0).map(|(endpoint, c)| (endpoint.as_str(), c)).collect();
        lines.sort_by_key(|(api_id, _)| *api_id);
        for (api_id, c) in lines {
            let max_wait_ms = c.max_wait.as_millis() as u64;
            if inner.total_limit.is_some() {
                tracing::info!(api_id, sent = c.sent, rate_limited = c.rate_limited, resent = c.resent, max_wait_ms, max_total_wait_ms = c.max_total_wait.as_millis() as u64, "키움 대기열 1분 계수");
            } else {
                tracing::info!(api_id, sent = c.sent, rate_limited = c.rate_limited, resent = c.resent, max_wait_ms, "키움 대기열 1분 계수");
            }
        }
    }
}

fn queue_gone(api_id: Endpoint) -> KiwoomError {
    KiwoomError::Failed(Failure::queue_gone(api_id))
}

async fn run(inner: Arc<Inner>) {
    loop {
        match inner.next_step() {
            Step::Idle => inner.wake.notified().await,
            Step::Wait(t) => {
                tokio::select! {
                    _ = tokio::time::sleep_until(t) => {}
                    _ = inner.wake.notified() => {}
                }
            }
            Step::Issue => inner.issue().await,
            Step::Send { id, req, generation, priority } => {
                tokio::spawn(inner.clone().send_market(id, req, generation, priority));
            }
            Step::Again => {}
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().expect("대기열 잠금")
    }

    fn enqueue(&self, key: DedupeKey, priority: Priority, admit: Option<Admission>, once: Option<SendOnce>) -> oneshot::Receiver<JobResult> {
        let (tx, rx) = oneshot::channel();
        let mut q = self.lock();
        if *self.access.borrow() == Access::Closed {
            let _ = tx.send(Err(KiwoomError::NotConnected));
            return rx;
        }
        if let Some(err) = q.stopped(key.api_id) {
            let _ = tx.send(Err(err));
            return rx;
        }
        if let Some(&id) = q.by_key.get(&key).filter(|_| once.is_none()) {
            let job = q.jobs.get_mut(&id).expect("by_key와 jobs는 함께 바뀐다");
            job.waiters.push(tx);
            if priority < job.priority {
                let (old, state) = (job.priority, job.state);
                job.priority = priority;
                if state == JobState::Queued {
                    q.lanes[old.lane()].retain(|&x| x != id);
                    q.lanes[priority.lane()].push_back(id);
                }
            }
        } else {
            let id = q.next_id;
            q.next_id += 1;
            if once.is_none() {
                q.by_key.insert(key.clone(), id);
            }
            q.jobs.insert(
                id,
                Job {
                    once,
                    admit,
                    key,
                    priority,
                    state: JobState::Queued,
                    waiters: vec![tx],
                    sends: 0,
                    rate_limited: 0,
                    transport_failures: 0,
                    resent_after_invalid_token: false,
                    window_blocked_since: None,
                    total_blocked_since: None,
                },
            );
            q.lanes[priority.lane()].push_back(id);
        }
        drop(q);
        self.wake.notify_one();
        rx
    }

    fn next_step(&self) -> Step {
        let now_kst = self.clock.now();
        let mut q = self.lock();
        if *self.access.borrow() == Access::Closed {
            let err = KiwoomError::NotConnected;
            q.fail_queued(&err);
            for w in q.issue_waiters.drain(..) {
                let _ = w.send(Err(err.clone()));
            }
            return Step::Idle;
        }
        if let Some(halt) = self.auth.halted() {
            let err = KiwoomError::from(halt);
            q.fail_queued(&err);
            for w in q.issue_waiters.drain(..) {
                let _ = w.send(Err(err.clone()));
            }
            return Step::Idle;
        }
        let mut has_market = q.has_market_work();
        let market_needs_token = has_market && self.auth.needs_issue(now_kst);
        if let Some(err) = q.stopped(Endpoint::ISSUE).filter(|_| market_needs_token || !q.issue_waiters.is_empty()) {
            for w in q.issue_waiters.drain(..) {
                let _ = w.send(Err(err.clone()));
            }
            if market_needs_token {
                q.fail_queued(&err);
                has_market = false;
            }
        }
        if let Some(until) = self.auth.issue_blocked_until(now_kst).filter(|_| market_needs_token || !q.issue_waiters.is_empty()) {
            let err = KiwoomError::Gated { until, cause: GateCause::IssueInterval };
            tracing::warn!(%until, "마지막 토큰 발급 요청에서 10분이 지나지 않아 발급하지 않습니다");
            for w in q.issue_waiters.drain(..) {
                let _ = w.send(Err(err.clone()));
            }
            if market_needs_token {
                q.fail_queued(&err);
                has_market = false;
            }
        }
        let now = Instant::now();
        if has_market {
            match &q.gate {
                Gate::Closed { opens, until, cause, .. } if now < *opens => {
                    let err = KiwoomError::Gated { until: *until, cause: GateCause::Failure(cause.clone()) };
                    q.fail_queued(&err);
                    has_market = false;
                }
                Gate::Probing { .. } => has_market = false,
                Gate::Open | Gate::Closed { .. } => {}
            }
        }
        let wants_issue = !q.issue_waiters.is_empty() || (has_market && self.auth.needs_issue(now_kst));
        if !wants_issue && !has_market {
            return Step::Idle;
        }
        if let Pacing::SharedSpacing(spacing) = self.pacing
            && let Some(r) = q.last_send.map(|t| t + spacing).filter(|&r| r > now)
        {
            return Step::Wait(r);
        }
        if wants_issue {
            if let Some(r) = self.endpoint_ready_at(&q, Endpoint::ISSUE, now) {
                return Step::Wait(r);
            }
            q.last_send = Some(now);
            self.record_send(&mut q, Endpoint::ISSUE, now, (None, None), false);
            return Step::Issue;
        }
        let blocked: Vec<(u64, bool)> = q
            .lanes
            .iter()
            .flatten()
            .copied()
            .filter_map(|id| {
                let endpoint = q.jobs[&id].key.api_id;
                self.endpoint_ready_at(&q, endpoint, now).map(|_| (id, self.tr_ready_at(&q, endpoint, now).is_some()))
            })
            .collect();
        for (id, by_tr) in blocked {
            let job = q.jobs.get_mut(&id).expect("대기열의 id는 jobs에 있다");
            if by_tr { &mut job.window_blocked_since } else { &mut job.total_blocked_since }.get_or_insert(now);
        }
        let ready_job = q.lanes.iter().enumerate().find_map(|(lane, ids)| {
            ids.iter().position(|id| self.endpoint_ready_at(&q, q.jobs[id].key.api_id, now).is_none()).map(|position| (lane, position))
        });
        let Some((lane, position)) = ready_job else {
            let soonest = q.lanes.iter().flatten().filter_map(|id| self.endpoint_ready_at(&q, q.jobs[id].key.api_id, now)).min();
            return soonest.map_or(Step::Again, Step::Wait);
        };
        q.last_send = Some(now);
        let id = q.lanes[lane].remove(position).expect("찾은 자리는 대기열에 있다");
        let Some((token, generation)) = self.auth.current(now_kst) else {
            q.requeue_front(id);
            return Step::Again;
        };
        let api_id = q.jobs.get(&id).expect("대기열의 id는 jobs에 있다").key.api_id;
        if let Some(err) = q.stopped(api_id) {
            q.finish(id, Err(err));
            return Step::Again;
        }
        if q.jobs.get(&id).and_then(|job| job.admit.as_ref()).is_some_and(|admit| !admit()) {
            q.finish(id, Err(KiwoomError::NotConnected));
            return Step::Again;
        }
        if let Gate::Closed { cause, misses, .. } = std::mem::take(&mut q.gate) {
            tracing::info!(api_id = api_id.as_str(), "관문을 확인하는 요청 하나를 보냅니다");
            q.gate = Gate::Probing { probe: id, cause, misses };
        }
        let job = q.jobs.get_mut(&id).expect("대기열의 id는 jobs에 있다");
        let waited = job.window_blocked_since.take().map(|since| now.duration_since(since));
        let total_waited = job.total_blocked_since.take().map(|since| now.duration_since(since));
        let resent = job.rate_limited > 0;
        self.record_send(&mut q, api_id, now, (waited, total_waited), resent);
        let job = q.jobs.get_mut(&id).expect("대기열의 id는 jobs에 있다");
        job.state = JobState::InFlight;
        job.sends += 1;
        if let Some(once) = &job.once {
            once.transmitted.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let req = HttpRequest {
            api_id: job.key.api_id,
            token: Some(token),
            cont: job.key.cont.clone(),
            body: Secret::new(job.key.body.clone()),
        };
        Step::Send { id, req, generation, priority: job.priority }
    }

    fn default_limit(&self) -> u32 {
        match self.environment {
            KiwoomEnvironment::Real => REAL_SENDS_PER_WINDOW,
            KiwoomEnvironment::Mock => MOCK_SENDS_PER_WINDOW,
        }
    }

    fn endpoint_ready_at(&self, q: &Queue, endpoint: Endpoint, now: Instant) -> Option<Instant> {
        self.tr_ready_at(q, endpoint, now).into_iter().chain(self.total_ready_at(q, endpoint, now)).max()
    }

    fn total_ready_at(&self, q: &Queue, endpoint: Endpoint, now: Instant) -> Option<Instant> {
        if endpoint == Endpoint::ISSUE || !matches!(self.pacing, Pacing::PerTr) {
            return None;
        }
        q.total.as_ref().and_then(|total| total.ready_at(now, true))
    }

    fn tr_ready_at(&self, q: &Queue, endpoint: Endpoint, now: Instant) -> Option<Instant> {
        let window = q.windows.get(&WindowKey::of(endpoint));
        let held = window.and_then(|w| w.ready_at(now, matches!(self.pacing, Pacing::PerTr)));
        let same_tr = match (&self.pacing, self.environment) {
            (Pacing::SharedSpacing(_), KiwoomEnvironment::Mock) => q.last_send_by_endpoint.get(&endpoint).map(|sent| *sent + MOCK_SAME_TR_SPACING).filter(|&r| r > now),
            _ => None,
        };
        held.into_iter().chain(same_tr).max()
    }

    fn record_send(&self, q: &mut Queue, endpoint: Endpoint, now: Instant, waited: (Option<Duration>, Option<Duration>), resent: bool) {
        if matches!(self.pacing, Pacing::SharedSpacing(_)) && self.environment == KiwoomEnvironment::Mock {
            q.last_send_by_endpoint.insert(endpoint, now);
        }
        q.window(endpoint, self.default_limit()).record(now);
        if endpoint != Endpoint::ISSUE
            && let Some(total) = q.total.as_mut()
        {
            total.record(now);
        }
        let counter = q.counters.entry(endpoint).or_default();
        counter.sent += 1;
        counter.resent += u32::from(resent);
        counter.max_wait = counter.max_wait.max(waited.0.unwrap_or_default());
        counter.max_total_wait = counter.max_total_wait.max(waited.1.unwrap_or_default());
    }

    fn note_rate_limited(&self, q: &mut Queue, failure: &Failure) {
        let endpoint = failure.api_id();
        q.counters.entry(endpoint).or_default().rate_limited += 1;
        let window = q.window(endpoint, self.default_limit());
        if let Some(limit) = failure.rate_allowance()
            && window.set_limit(limit)
        {
            tracing::warn!(api_id = endpoint.as_str(), limit, "키움이 알려 준 초당 한도로 이 TR의 한도를 바꿉니다");
        }
        window.hold_until_oldest_leaves(Instant::now());
    }

    async fn issue(&self) {
        let (mut q, outcome) = match self.auth.begin_issue(self.clock.now()) {
            Ok(body) => {
                let started = Instant::now();
                let res = self.transport.send(HttpRequest { api_id: Endpoint::ISSUE, token: None, cont: None, body }).await;
                let judged = self.judge_issue(res, started);
                let mut q = self.lock();
                let outcome = match judged {
                    Ok(generation) => {
                        q.failed_once.remove(&Endpoint::ISSUE);
                        Ok(generation)
                    }
                    Err(_) if !self.auth.issue_is_for_current_key() => Err(queue_gone(Endpoint::ISSUE)),
                    Err(failure) => {
                        if failure.category() == Category::RateLimit {
                            self.note_rate_limited(&mut q, &failure);
                        }
                        Err(self.settle(&mut q, failure))
                    }
                };
                (q, outcome)
            }
            Err(BeginIssueError::NoKey) => (self.lock(), Err(KiwoomError::NotConnected)),
            Err(BeginIssueError::File(e)) => {
                tracing::error!(error = %e, "토큰 파일에 발급 요청 시각을 쓰지 못해 발급 요청을 보내지 않습니다");
                (self.lock(), Err(KiwoomError::TokenFile(e)))
            }
        };
        if let Err(e) = &outcome {
            q.fail_queued(e);
        }
        for w in q.issue_waiters.drain(..) {
            let _ = w.send(outcome.clone());
        }
    }

    fn settle(&self, q: &mut Queue, failure: Failure) -> KiwoomError {
        let api_id = failure.api_id();
        match failure.policy().stop {
            Stop::Nothing => KiwoomError::Failed(failure),
            Stop::Gate | Stop::AuthGate => self.close_gate(q, failure, 0),
            Stop::IssueInterval => self.wait_issue_interval(failure),
            Stop::PathOnRepeat if q.failed_once.insert(api_id) => {
                tracing::warn!(api_id = api_id.as_str(), "{failure}. 다음 발급도 같은 범주로 실패하면 발급을 멈춥니다");
                self.wait_issue_interval(failure)
            }
            Stop::Path | Stop::PathOnRepeat => {
                tracing::error!(api_id = api_id.as_str(), "{failure}");
                q.stop_path(&failure);
                self.path_stopped.notify_waiters();
                KiwoomError::Stopped(failure)
            }
            Stop::Everything => {
                tracing::error!(api_id = api_id.as_str(), "{failure}");
                self.auth.halt(failure.clone(), self.clock.now());
                KiwoomError::Stopped(failure)
            }
        }
    }

    fn close_gate(&self, q: &mut Queue, cause: Failure, misses: u8) -> KiwoomError {
        let wait = match cause.policy().stop {
            Stop::AuthGate => AUTH_GATE_WAIT,
            _ if misses >= GATE_MISSES_BEFORE_LONG_WAIT => GATE_LONG_WAIT,
            _ => GATE_WAIT,
        };
        let until = self.clock.now().plus_secs(wait.as_secs() as i64);
        tracing::warn!(api_id = cause.api_id().as_str(), category = ?cause.category(), misses, %until, "조회 관문을 닫습니다. 그 시각에 확인 요청 하나만 보냅니다");
        q.gate = Gate::Closed { opens: Instant::now() + wait, until, cause: cause.clone(), misses };
        KiwoomError::Gated { until, cause: GateCause::Failure(cause) }
    }

    fn wait_issue_interval(&self, failure: Failure) -> KiwoomError {
        let now = self.clock.now();
        KiwoomError::Gated { until: self.auth.issue_blocked_until(now).unwrap_or(now), cause: GateCause::Failure(failure) }
    }

    /// au10001 응답 판정. 본문에는 토큰이 있으므로 로그에 남기지 않는다.
    fn judge_issue(&self, res: Result<HttpResponse, TransportError>, started: Instant) -> Result<TokenGen, Failure> {
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let resp = match res {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(api_id = "au10001", elapsed_ms, error = %e, "토큰 발급 요청이 키움에 닿지 못했습니다");
                return Err(Failure::transport(Endpoint::ISSUE, e));
            }
        };
        let judged = error::judge(Endpoint::ISSUE, resp.status, &resp.body);
        let failed = judged.as_ref().err();
        tracing::info!(
            api_id = "au10001",
            elapsed_ms,
            http = resp.status,
            category = ?failed.map(Failure::category),
            return_code = ?failed.and_then(Failure::return_code),
            detail = ?failed.and_then(Failure::detail),
            "토큰 발급 응답"
        );
        judged?;
        let bad_token = || Failure::protocol(Endpoint::ISSUE, Note::BadTokenResponse);
        let token: TokenResponse = serde_json::from_str(&resp.body).map_err(|_| bad_token())?;
        let generation = self.auth.record_issued(token, self.clock.now()).map_err(|_| bad_token())?;
        tracing::info!(generation = generation.0, "새 토큰을 받았습니다");
        Ok(generation)
    }

    async fn send_market(self: Arc<Self>, id: u64, req: HttpRequest, generation: TokenGen, priority: Priority) {
        let api_id = req.api_id;
        let started = Instant::now();
        let res = self.transport.send(req).await;
        let outcome = judge_market(api_id, priority, res, started);
        let mut q = self.lock();
        if !q.jobs.contains_key(&id) {
            return;
        }
        let probe = matches!(q.gate, Gate::Probing { probe, .. } if probe == id);
        if let Err(failure) = &outcome
            && failure.category() == Category::RateLimit
        {
            self.note_rate_limited(&mut q, failure);
        }
        match outcome {
            Ok(page) => {
                if probe {
                    tracing::info!(api_id = api_id.as_str(), "확인 요청이 성공해 관문을 엽니다");
                    q.gate = Gate::Open;
                }
                q.finish(id, Ok(page));
            }
            Err(failure) if probe => self.probe_failed(&mut q, id, generation, failure),
            Err(failure) => self.market_failed(&mut q, id, generation, failure),
        }
        drop(q);
        self.wake.notify_one();
    }

    fn probe_failed(self: &Arc<Self>, q: &mut Queue, id: u64, generation: TokenGen, failure: Failure) {
        let Gate::Probing { cause, misses, .. } = std::mem::take(&mut q.gate) else {
            unreachable!("send_market이 확인 요청임을 확인했다")
        };
        let err = match (cause.policy().stop, failure.policy().stop) {
            (Stop::Gate, Stop::Gate) => self.close_gate(q, failure, misses + 1),
            (Stop::AuthGate, Stop::AuthGate) => {
                tracing::error!(api_id = failure.api_id().as_str(), "{failure}. 10분 뒤 확인도 실패해 조회와 토큰 발급을 멈춥니다");
                self.auth.halt(failure.clone(), self.clock.now());
                KiwoomError::Stopped(failure)
            }
            _ => return self.market_failed(q, id, generation, failure),
        };
        q.finish(id, Err(err));
    }

    fn market_failed(self: &Arc<Self>, q: &mut Queue, id: u64, generation: TokenGen, failure: Failure) {
        let api_id = failure.api_id().as_str();
        match failure.category() {
            Category::RateLimit => tracing::warn!(api_id, "요청 개수 초과 응답을 받았습니다. 이 TR만 창이 비는 시각까지 붙잡고 대기열 전체는 멈추지 않습니다"),
            Category::InvalidRequest | Category::BatchLimit => tracing::error!(api_id, "{failure}. 우리 코드의 버그입니다"),
            _ => {}
        }
        let job = q.jobs.get_mut(&id).expect("send_market이 확인했다");
        if job.once.is_some() {
            let rate_limited_by_http = failure.category() == Category::RateLimit && failure.http_status() == Some(429);
            if rate_limited_by_http && job.rate_limited < self.order_resends {
                job.rate_limited += 1;
                tracing::warn!(api_id, resends = job.rate_limited, "주문 쓰기가 요청 개수 초과를 받아 창이 비는 시각에 같은 요청을 다시 보냅니다");
                q.requeue_front(id);
                return;
            }
            if failure.category() == Category::TokenInvalid {
                let _ = self.auth.invalidate(generation);
            }
            let err = match failure.policy().stop {
                Stop::Path | Stop::PathOnRepeat | Stop::Gate => {
                    tracing::warn!(api_id, "주문 쓰기가 실패했습니다. 다시 보내지 않고 경로나 관문도 닫지 않습니다: {failure}");
                    KiwoomError::Failed(failure)
                }
                _ => self.settle(q, failure),
            };
            q.finish(id, Err(err));
            return;
        }
        let resend = match failure.policy().retry {
            _ if job.sends >= job.priority.send_budget() => {
                tracing::warn!(api_id, sends = job.sends, "요청 하나의 전송 예산을 다 썼습니다");
                false
            }
            Retry::Never => false,
            Retry::AfterPause => {
                job.rate_limited += 1;
                let again = job.rate_limited < MAX_RATE_LIMITED;
                if !again {
                    tracing::warn!(api_id, "요청 개수 초과가 세 번이라 실패로 돌려줍니다");
                }
                again
            }
            Retry::RefreshTokenOnce if job.resent_after_invalid_token => {
                tracing::error!(api_id, "새 토큰으로도 토큰 무효 응답을 받았습니다. 조회와 토큰 발급을 멈춥니다");
                self.auth.halt(failure.clone(), self.clock.now());
                q.finish(id, Err(KiwoomError::Stopped(failure)));
                return;
            }
            Retry::RefreshTokenOnce => {
                job.resent_after_invalid_token = true;
                match self.auth.invalidate(generation) {
                    Ok(()) => true,
                    Err(AuthError::Halted(halt)) => {
                        q.finish(id, Err(halt.into()));
                        return;
                    }
                    Err(AuthError::BadTokenResponse) => false,
                }
            }
            Retry::Backoff => {
                let delays = if job.priority == Priority::Screen { SCREEN_RETRY_DELAYS } else { OTHER_RETRY_DELAYS };
                if let Some(&delay) = delays.get(job.transport_failures) {
                    job.transport_failures += 1;
                    job.state = JobState::Backoff;
                    let inner = self.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(delay).await;
                        inner.lock().requeue_front(id);
                        inner.wake.notify_one();
                    });
                    return;
                }
                false
            }
        };
        if resend {
            q.requeue_front(id);
        } else {
            let err = self.settle(q, failure);
            q.finish(id, Err(err));
        }
    }
}

fn judge_market(api_id: Endpoint, priority: Priority, res: Result<HttpResponse, TransportError>, started: Instant) -> Result<RawPage, Failure> {
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let resp = match res {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(api_id = api_id.as_str(), ?priority, elapsed_ms, error = %e, "키움에 닿지 못했습니다");
            return Err(Failure::transport(api_id, e));
        }
    };
    let judged = error::judge(api_id, resp.status, &resp.body);
    let failed = judged.as_ref().err();
    tracing::info!(
        api_id = api_id.as_str(),
        ?priority,
        elapsed_ms,
        http = resp.status,
        category = ?failed.map(Failure::category),
        return_code = ?failed.and_then(Failure::return_code),
        detail = ?failed.and_then(Failure::detail),
        reason = ?failed.and_then(Failure::vendor_reason),
        "키움 조회"
    );
    judged.map(|envelope| {
        let continues_without_key = resp.next_key.as_deref() == Some(super::transport::NEXT_KEY_ABSENT);
        RawPage { body: resp.body.into(), next: resp.next_key.filter(|key| key != super::transport::NEXT_KEY_ABSENT).map(ContKey), continues_without_key, envelope }
    })
}

#[cfg(test)]
pub mod testing {
    //! 가짜 전송. 보낸 요청을 기록하고, 응답은 테스트가 준 함수가 만든다.

    use std::sync::Mutex;
    use std::time::Duration;

    use futures::future::BoxFuture;
    use tokio::time::Instant;

    use super::super::api::{ApiId, Endpoint};
    use super::super::transport::{HttpRequest, HttpResponse, Transport, TransportError};

    #[derive(Debug, Clone)]
    pub struct Sent {
        pub at: Instant,
        pub api_id: Endpoint,
        pub token: Option<String>,
        pub cont: Option<String>,
        pub body: String,
    }

    type Handler = Box<dyn Fn(&Sent) -> Result<HttpResponse, TransportError> + Send + Sync>;

    pub struct FakeTransport {
        sent: Mutex<Vec<Sent>>,
        handler: Handler,
        latency: Duration,
    }

    impl FakeTransport {
        pub fn new(latency: Duration, handler: impl Fn(&Sent) -> Result<HttpResponse, TransportError> + Send + Sync + 'static) -> Self {
            FakeTransport { sent: Mutex::new(Vec::new()), handler: Box::new(handler), latency }
        }

        pub fn sent(&self) -> Vec<Sent> {
            self.sent.lock().unwrap().clone()
        }

        pub fn market_sent(&self) -> Vec<Sent> {
            self.sent().into_iter().filter(|s| s.api_id != ApiId::Au10001).collect()
        }
    }

    impl Transport for std::sync::Arc<FakeTransport> {
        fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
            let sent = Sent {
                at: Instant::now(),
                api_id: req.api_id,
                token: req.token.map(|t| t.expose().clone()),
                cont: req.cont.map(|c| c.as_str().to_owned()),
                body: req.body.expose().clone(),
            };
            let reply = (self.handler)(&sent);
            self.sent.lock().unwrap().push(sent);
            let latency = self.latency;
            Box::pin(async move {
                tokio::time::sleep(latency).await;
                reply
            })
        }
    }

    pub fn ok(body: serde_json::Value, next: Option<&str>) -> Result<HttpResponse, TransportError> {
        Ok(HttpResponse { status: 200, next_key: next.map(str::to_owned), body: body.to_string() })
    }

    pub fn status(status: u16, body: serde_json::Value) -> Result<HttpResponse, TransportError> {
        Ok(HttpResponse { status, next_key: None, body: body.to_string() })
    }

    /// 토큰 n번째 발급 응답. 만료는 먼 미래.
    pub fn token(n: usize) -> Result<HttpResponse, TransportError> {
        ok(serde_json::json!({"token": format!("tok-{n}"), "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}), None)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::testing::*;
    use super::*;
    use crate::kiwoom::api::ApiId;
    use crate::kiwoom::error::CodeKey;
    use crate::clock::kst;
    use crate::kiwoom::api::StockList;
    use domain::KstDate;

    fn rest(fake: &Arc<FakeTransport>) -> KiwoomRest {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        KiwoomRest::new(Arc::new(fake.clone()), auth, clock)
    }

    type Guards = (tempfile::TempDir, crate::instance::InstanceLock);

    fn rest_with_saved_token(fake: &Arc<FakeTransport>) -> (KiwoomRest, Guards) {
        use crate::kiwoom::token_file::{Saved, SavedToken, credential_id, testing::temp_token_file};
        let start = kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0);
        let (dir, lock, file) = temp_token_file();
        let an_hour_ago = start.unix() - 3600;
        let token = SavedToken { value: "tok-0".into(), expires_dt: "20991231000000".into(), issued_at: an_hour_ago };
        file.save(&Saved { credential: Some(credential_id("k")), token: Some(token), last_request_at: an_hour_ago, ..Saved::default() }).unwrap();
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), Some(file));
        (KiwoomRest::new(Arc::new(fake.clone()), auth, Clock::fake(start)), (dir, lock))
    }

    fn invalid_token() -> Result<HttpResponse, TransportError> {
        ok(json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8005:Token이 유효하지 않습니다]"}), None)
    }

    fn list_ok() -> Result<HttpResponse, TransportError> {
        ok(json!({"list": [], "return_code": 0, "return_msg": "정상"}), None)
    }

    /// 요청 본문이 서로 다르도록 mrkt_tp 대신 연속조회 키를 바꿔 쓴다.
    fn cont(i: usize) -> ContKey {
        ContKey::new(format!("k{i}"))
    }

    async fn call_k(rest: &KiwoomRest, i: usize, p: Priority) -> Result<Page<crate::kiwoom::wire::StockListResponse>, KiwoomError> {
        rest.call(&StockList::EXCHANGE, Some(&cont(i)), p, MergeScope::default()).await
    }

    fn verdict(e: Option<KiwoomError>) -> Option<(Category, Option<CodeKey>)> {
        e.and_then(|e| e.failure().map(|f| (f.category(), f.detail())))
    }

    fn category(e: Option<KiwoomError>) -> Option<Category> {
        verdict(e).map(|(c, _)| c)
    }

    fn token_counter() -> impl Fn(&Sent) -> Option<Result<HttpResponse, TransportError>> {
        let n = AtomicUsize::new(0);
        move |s: &Sent| (s.api_id == ApiId::Au10001).then(|| token(n.fetch_add(1, Ordering::SeqCst) + 1))
    }

    const SHARED_SPACING: Duration = Duration::from_millis(260);

    fn assert_at_most_per_second(sent: &[Sent], limit: usize) {
        for (i, a) in sent.iter().enumerate() {
            let in_window = sent[i..].iter().take_while(|b| b.at.duration_since(a.at) <= Duration::from_secs(1)).count();
            assert!(in_window <= limit, "{}번째 전송부터 1초 안에 {in_window}번", i);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_window_holds_across_token_retries_and_continuations() {
        let tokens = token_counter();
        let (k3_failures, k5_failures) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let fake = Arc::new(FakeTransport::new(Duration::from_millis(30), move |s| {
            if let Some(t) = tokens(s) {
                return t;
            }
            if s.cont.as_deref() == Some("k3") && k3_failures.fetch_add(1, Ordering::SeqCst) < 1 {
                return status(503, json!({}));
            }
            if s.cont.as_deref() == Some("k5") && k5_failures.fetch_add(1, Ordering::SeqCst) < 1 {
                return status(429, json!({"return_code": 5, "return_msg": "초과[1700:유량=5]"}));
            }
            list_ok()
        }));
        let rest = rest(&fake);
        let calls = (0..12).map(|i| {
            let rest = rest.clone();
            async move { call_k(&rest, i, Priority::Screen).await.map(|_| ()) }
        });
        let results = futures::future::join_all(calls).await;
        assert!(results.iter().all(Result::is_ok), "{results:?}");
        let sent = fake.sent();
        assert_eq!(sent[0].api_id, ApiId::Au10001, "토큰 발급이 먼저 나간다");
        assert_eq!(sent.len(), 1 + 12 + 1 + 1);
        assert_at_most_per_second(&fake.market_sent(), 5);
    }

    fn basic_info_ok() -> Result<HttpResponse, TransportError> {
        let mut body: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/kiwoom/ka10001_005930_AL.json")).unwrap();
        body["return_code"] = 0.into();
        body["return_msg"] = "정상".into();
        ok(body, None)
    }

    fn two_tr_transport(latency: Duration) -> Arc<FakeTransport> {
        let tokens = token_counter();
        Arc::new(FakeTransport::new(latency, move |s| {
            tokens(s).unwrap_or_else(|| if s.api_id == ApiId::Ka10001 { basic_info_ok() } else { list_ok() })
        }))
    }

    fn rest_in(fake: &Arc<FakeTransport>, environment: KiwoomEnvironment) -> KiwoomRest {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        KiwoomRest::for_environment(Arc::new(fake.clone()), auth, clock, environment)
    }

    async fn basic_info(rest: &KiwoomRest, p: Priority) -> Result<(), KiwoomError> {
        let samsung = domain::StockCode::parse("005930").unwrap();
        rest.call(&crate::kiwoom::api::StockBasicInfo::new(samsung), None, p, MergeScope::default()).await.map(drop)
    }

    fn sent_order(fake: &FakeTransport) -> Vec<String> {
        fake.market_sent().iter().map(|s| s.cont.clone().unwrap_or_else(|| s.api_id.as_str().to_owned())).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn mock_queue_spaces_the_same_tr_by_one_second() {
        let fake = two_tr_transport(Duration::from_millis(10));
        let rest = rest_in(&fake, KiwoomEnvironment::Mock);
        rest.issue_token().await.unwrap();
        let calls = (0..3).map(|i| call_k(&rest, i, Priority::Screen));
        for r in futures::future::join_all(calls).await {
            r.unwrap();
        }
        let sent = fake.market_sent();
        assert_eq!(sent.len(), 3);
        for w in sent.windows(2) {
            assert!(w[1].at.duration_since(w[0].at) >= SEND_WINDOW + WINDOW_MARGIN, "{:?}", w[1].at.duration_since(w[0].at));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn mock_queue_sends_other_trs_while_one_waits() {
        let fake = two_tr_transport(Duration::from_millis(10));
        let rest = rest_in(&fake, KiwoomEnvironment::Mock);
        rest.issue_token().await.unwrap();
        let (a, b, c, d) = tokio::join!(call_k(&rest, 0, Priority::Screen), call_k(&rest, 1, Priority::Screen), basic_info(&rest, Priority::Screen), async {
            let samsung = domain::StockCode::parse("005930").unwrap();
            rest.call(&crate::kiwoom::api::StockBasicInfo::new(samsung), Some(&cont(9)), Priority::Screen, MergeScope::default()).await.map(drop)
        });
        a.unwrap();
        b.unwrap();
        c.unwrap();
        d.unwrap();
        let sent = fake.market_sent();
        let kinds: Vec<_> = sent.iter().map(|s| s.api_id).collect();
        assert_eq!(kinds, [ApiId::Ka10099, ApiId::Ka10001, ApiId::Ka10099, ApiId::Ka10001].map(Endpoint::from));
        assert_eq!(sent[1].at, sent[0].at, "기다리는 TR 뒤의 다른 TR은 기다리지 않고 먼저 나간다");
        assert_eq!(sent[2].at.duration_since(sent[0].at), Duration::from_millis(1050));
        assert_eq!(sent[3].at.duration_since(sent[1].at), Duration::from_millis(1050));
    }

    #[tokio::test(start_paused = true)]
    async fn mock_queue_keeps_order_priority() {
        let fake = two_tr_transport(Duration::from_millis(10));
        let rest = rest_in(&fake, KiwoomEnvironment::Mock);
        rest.issue_token().await.unwrap();
        let handles: Vec<_> = [(1, Priority::Background), (0, Priority::Order), (2, Priority::Order)]
            .into_iter()
            .map(|(i, p)| {
                let rest = rest.clone();
                tokio::spawn(async move { call_k(&rest, i, p).await.map(drop) })
            })
            .chain(std::iter::once({
                let rest = rest.clone();
                tokio::spawn(async move { basic_info(&rest, Priority::Screen).await })
            }))
            .collect();
        for h in handles {
            h.await.unwrap().unwrap();
        }
        let sent = fake.market_sent();
        assert_eq!(sent_order(&fake), ["k0", "ka10001", "k2", "k1"]);
        assert_eq!(sent[2].at.duration_since(sent[0].at), Duration::from_millis(1050));
        assert_eq!(sent[3].at.duration_since(sent[2].at), Duration::from_millis(1050));
    }

    #[tokio::test(start_paused = true)]
    async fn the_spacing_knob_queue_spaces_every_send_by_that_interval() {
        let fake = two_tr_transport(Duration::from_millis(10));
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let rest = KiwoomRest::with_send_spacing(Arc::new(fake.clone()), auth, clock, SHARED_SPACING);
        rest.issue_token().await.unwrap();
        let (a, b, c) = tokio::join!(call_k(&rest, 0, Priority::Screen), basic_info(&rest, Priority::Screen), call_k(&rest, 1, Priority::Screen));
        a.unwrap();
        b.unwrap();
        c.unwrap();
        let sent = fake.sent();
        for w in sent.windows(2) {
            assert_eq!(w[1].at.duration_since(w[0].at), SHARED_SPACING, "손잡이 대기열은 토큰 발급과 TR이 달라도 모든 전송 사이를 그 간격으로 띄운다");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_spacing_knob_mock_queue_keeps_the_same_tr_second() {
        let fake = two_tr_transport(Duration::from_millis(10));
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let rest = KiwoomRest::build(Arc::new(fake.clone()), auth, clock, SHARED_SPACING, KiwoomEnvironment::Mock);
        rest.issue_token().await.unwrap();
        let (a, b, c) = tokio::join!(call_k(&rest, 0, Priority::Screen), call_k(&rest, 1, Priority::Screen), basic_info(&rest, Priority::Screen));
        a.unwrap();
        b.unwrap();
        c.unwrap();
        let sent = fake.market_sent();
        let kinds: Vec<_> = sent.iter().map(|s| s.api_id).collect();
        assert_eq!(kinds, [ApiId::Ka10099, ApiId::Ka10001, ApiId::Ka10099].map(Endpoint::from));
        assert_eq!(sent[1].at.duration_since(sent[0].at), SHARED_SPACING);
        assert!(sent[2].at.duration_since(sent[0].at) >= Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn screen_goes_before_background() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::from_millis(10), move |s| tokens(s).unwrap_or_else(list_ok)));
        let rest = rest(&fake);
        rest.issue_token().await.unwrap();
        let mut handles = Vec::new();
        for (i, p) in [(0, Priority::Background), (1, Priority::Background), (2, Priority::Background), (3, Priority::Screen), (4, Priority::Recovery)] {
            let rest = rest.clone();
            handles.push(tokio::spawn(async move { call_k(&rest, i, p).await.map(|_| ()) }));
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }
        let order: Vec<_> = fake.market_sent().iter().map(|s| s.cont.clone().unwrap()).collect();
        assert_eq!(order, ["k3", "k4", "k0", "k1", "k2"]);
    }

    #[tokio::test(start_paused = true)]
    async fn identical_requests_share_one_send_and_raise_priority() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::from_millis(200), move |s| tokens(s).unwrap_or_else(list_ok)));
        let rest = rest(&fake);
        rest.issue_token().await.unwrap();
        let bg = rest.clone();
        let slow = tokio::spawn(async move { call_k(&bg, 9, Priority::Background).await.map(|_| ()) });
        let other = rest.clone();
        let other = tokio::spawn(async move { call_k(&other, 1, Priority::Background).await.map(|_| ()) });
        tokio::task::yield_now().await;
        let (a, b) = tokio::join!(
            call_k(&rest, 9, Priority::Screen),
            call_k(&rest, 9, Priority::Screen)
        );
        assert!(a.is_ok() && b.is_ok());
        slow.await.unwrap().unwrap();
        other.await.unwrap().unwrap();
        let sent = fake.market_sent();
        assert_eq!(sent.iter().filter(|s| s.cont.as_deref() == Some("k9")).count(), 1);
        assert_eq!(sent.len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limited_tr_fails_after_three_and_closes_the_shared_gate_without_pausing_other_trs() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            if let Some(t) = tokens(s) {
                return t;
            }
            if s.cont.as_deref() == Some("k0") {
                return rate_limited();
            }
            list_ok()
        }));
        let rest = rest(&fake);
        let (a, other) = tokio::join!(call_k(&rest, 0, Priority::Screen), tr_call(&rest, ApiId::Ka10001, "other", Priority::Screen));
        assert_eq!(category(a.err()), Some(Category::RateLimit));
        other.unwrap();
        let k0: Vec<_> = fake.market_sent().into_iter().filter(|s| s.cont.as_deref() == Some("k0")).collect();
        assert_eq!(k0.len(), 3);
        assert_eq!(at_ms(&k0, k0[0].at), [0, 1050, 2100], "429 뒤 그 TR의 창이 비는 시각에 같은 요청을 다시 보낸다");
        let ka10001 = fake.market_sent().into_iter().find(|s| s.api_id == ApiId::Ka10001).unwrap();
        assert_eq!(ka10001.at, k0[0].at, "다른 TR은 429를 받은 TR을 기다리지 않는다");
        assert!(matches!(call_k(&rest, 1, Priority::Screen).await, Err(KiwoomError::Gated { .. })), "세 번째 429 뒤 공유 관문이 닫힌다");
    }

    #[tokio::test(start_paused = true)]
    async fn the_third_rate_limit_closes_the_gate_for_thirty_seconds() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            if let Some(t) = tokens(s) {
                return t;
            }
            if s.body.contains("\"0\"") {
                return rate_limited();
            }
            list_ok()
        }));
        let rest = rest(&fake);
        let scope = MergeScope::default();
        assert_eq!(category(rest.call(&StockList::EXCHANGE, None, Priority::Screen, scope).await.err()), Some(Category::RateLimit));
        assert!(matches!(rest.call(&StockList::KOSDAQ, None, Priority::Screen, scope).await, Err(KiwoomError::Gated { .. })));
        assert_eq!(fake.market_sent().len(), 3, "세 번째 429 뒤 다른 요청은 관문에서 기다린다");
        tokio::time::sleep(GATE_WAIT).await;
        rest.call(&StockList::KOSDAQ, None, Priority::Screen, scope).await.unwrap();
        let sent = fake.market_sent();
        assert!(sent[3].at.duration_since(sent[2].at) >= GATE_WAIT);
    }

    #[tokio::test(start_paused = true)]
    async fn invalid_token_reissues_once_and_every_request_uses_the_new_token() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::from_millis(50), move |s| {
            tokens(s).unwrap_or_else(|| if s.token.as_deref() == Some("tok-0") { invalid_token() } else { list_ok() })
        }));
        let (rest, _guards) = rest_with_saved_token(&fake);
        let (a, b, c) = tokio::join!(
            call_k(&rest, 0, Priority::Screen),
            call_k(&rest, 1, Priority::Screen),
            call_k(&rest, 2, Priority::Background)
        );
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        let sent = fake.sent();
        assert_eq!(sent.iter().filter(|s| s.api_id == ApiId::Au10001).count(), 1, "옛 세대의 무효 응답은 다시 발급하지 않는다");
        let issue = sent.iter().position(|s| s.api_id == ApiId::Au10001).unwrap();
        assert!(sent[issue + 1..].iter().all(|s| s.token.as_deref() == Some("tok-1")));
        assert_eq!(sent.iter().rfind(|s| s.cont.as_deref() == Some("k2")).unwrap().token.as_deref(), Some("tok-1"));
        assert_every_market_request_has_a_token(&sent);
    }

    fn assert_every_market_request_has_a_token(sent: &[Sent]) {
        assert!(sent.iter().filter(|s| s.api_id != ApiId::Au10001).all(|s| s.token.is_some()));
    }

    #[tokio::test(start_paused = true)]
    async fn invalid_token_on_the_new_token_halts_everything() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| tokens(s).unwrap_or_else(invalid_token)));
        let (rest, _guards) = rest_with_saved_token(&fake);
        let r = rest.call(&StockList::EXCHANGE, None, Priority::Screen, MergeScope::default()).await;
        let invalid = Some((Category::TokenInvalid, Some(CodeKey::Rest(8005))));
        assert_eq!(verdict(r.err()), invalid);
        assert_eq!(fake.market_sent().len(), 2);
        assert_eq!(fake.sent().len(), 3, "다시 발급은 한 번");
        assert_eq!(verdict(rest.halted()), invalid);
        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        assert_eq!(verdict(call_k(&rest, 1, Priority::Screen).await.err()), invalid);
        assert_eq!(fake.sent().len(), 3, "멈춘 뒤에는 10분이 지나도 보내지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_blocked_daily_reissue_does_not_fail_requests_that_have_a_valid_token() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| tokens(s).unwrap_or_else(list_ok)));
        let rest = rest(&fake);
        rest.issue_token().await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
        let (issue, page) = tokio::join!(rest.issue_token(), call_k(&rest, 0, Priority::Screen));
        assert!(matches!(issue, Err(KiwoomError::Gated { cause: GateCause::IssueInterval, .. })), "{issue:?}");
        assert!(page.is_ok(), "{page:?}");
        assert_eq!(fake.market_sent()[0].token.as_deref(), Some("tok-1"));
    }

    #[tokio::test(start_paused = true)]
    async fn no_reissue_within_ten_minutes_of_the_last_issue_request() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            tokens(s).unwrap_or_else(|| if s.token.as_deref() == Some("tok-1") { invalid_token() } else { list_ok() })
        }));
        let rest = rest(&fake);
        let first_issue = rest.0.clock.now();
        let until = first_issue.plus_secs(MIN_ISSUE_INTERVAL_SECS);
        assert_eq!(call_k(&rest, 0, Priority::Screen).await.err(), Some(KiwoomError::Gated { until, cause: GateCause::IssueInterval }));
        assert_eq!(rest.blocked(), Some(KiwoomError::Gated { until, cause: GateCause::IssueInterval }));
        assert_eq!(call_k(&rest, 1, Priority::Screen).await.err(), Some(KiwoomError::Gated { until, cause: GateCause::IssueInterval }));
        assert_eq!(rest.issue_token().await.err(), Some(KiwoomError::Gated { until, cause: GateCause::IssueInterval }));
        assert_eq!(fake.sent().len(), 2, "발급 한 번, 조회 한 번");

        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        assert_eq!(rest.blocked(), None);
        call_k(&rest, 2, Priority::Screen).await.unwrap();
        let issues: Vec<_> = fake.sent().into_iter().filter(|s| s.api_id == ApiId::Au10001).collect();
        assert_eq!(issues.len(), 2);
        assert!(issues[1].at.duration_since(issues[0].at) >= Duration::from_secs(600));
    }

    #[tokio::test(start_paused = true)]
    async fn app_key_rejection_halts_everything() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            tokens(s).unwrap_or_else(|| ok(json!({"return_code": 3, "return_msg": "인증 실패[8030:투자구분]"}), None))
        }));
        let rest = rest(&fake);
        let rejected = Some((Category::AuthBlocked, Some(CodeKey::Rest(8030))));
        assert_eq!(verdict(rest.call(&StockList::EXCHANGE, None, Priority::Screen, MergeScope::default()).await.err()), rejected);
        assert_eq!(verdict(rest.call(&StockList::KOSDAQ, None, Priority::Screen, MergeScope::default()).await.err()), rejected);
        assert_eq!(verdict(rest.issue_token().await.err()), rejected);
        assert_eq!(fake.sent().len(), 2, "멈춘 뒤에는 아무것도 보내지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn designated_terminal_rejection_halts_even_on_a_non_200_status() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            tokens(s).unwrap_or_else(|| status(503, json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기]"})))
        }));
        let rest = rest(&fake);
        let halted = Some((Category::AuthBlocked, Some(CodeKey::Rest(8050))));
        assert_eq!(verdict(rest.call(&StockList::EXCHANGE, None, Priority::Screen, MergeScope::default()).await.err()), halted);
        assert_eq!(verdict(rest.call(&StockList::KOSDAQ, None, Priority::Screen, MergeScope::default()).await.err()), halted);
        assert_eq!(verdict(rest.issue_token().await.err()), halted);
        assert_eq!(fake.sent().len(), 2, "토큰 한 번, 조회 한 번. 재시도도 재발급도 없다");
    }

    #[tokio::test(start_paused = true)]
    async fn bad_requests_are_not_retried() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            tokens(s).unwrap_or_else(|| match s.cont.as_deref() {
                Some("k0") => ok(json!({"return_code": 2, "return_msg": "입력 값 오류입니다[1511:필수]"}), None),
                Some("k1") => ok(json!({"return_code": 5, "return_msg": "허용된 요청 개수를 초과하였습니다[1634]"}), None),
                _ => ok(json!({"return_code": 1, "return_msg": "알 수 없음"}), None),
            })
        }));
        let rest = rest(&fake);
        let expected = [
            (Category::InvalidRequest, Some(CodeKey::Rest(1511))),
            (Category::BatchLimit, Some(CodeKey::Rest(1634))),
            (Category::Unknown, None),
        ];
        for (i, want) in expected.into_iter().enumerate() {
            assert_eq!(verdict(call_k(&rest, i, Priority::Screen).await.err()), Some(want), "k{i}");
        }
        assert_eq!(fake.market_sent().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_and_protocol_failures_stop_their_path_until_restart() {
        for (name, reply) in [
            ("상세 없는 비0", json!({"return_code": 1, "return_msg": "알 수 없음"})),
            ("표에 없는 상세", json!({"return_code": 3, "return_msg": "실패[8100:처음 보는 코드]"})),
            ("return_code 없음", json!({"list": []})),
            ("빈 봉투", json!({})),
            ("목록 필드 없음", json!({"return_code": 0})),
        ] {
            let tokens = token_counter();
            let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
                tokens(s).unwrap_or_else(|| match s.api_id.market().unwrap() {
                    ApiId::Ka10099 => ok(reply.clone(), None),
                    _ => ok(json!({"return_code": 0, "stk_dt_pole_chart_qry": []}), None),
                })
            }));
            let rest = rest(&fake);
            let first = category(call_k(&rest, 0, Priority::Background).await.err());
            assert!(matches!(first, Some(Category::Unknown | Category::Protocol)), "{name}: {first:?}");
            assert_eq!(category(call_k(&rest, 1, Priority::Screen).await.err()), first, "{name}");
            assert_eq!(fake.market_sent().len(), 1, "{name}: 다시 보내지 않고, 다른 요청도 같은 경로로 보내지 않는다");
            assert!(rest.stopped(ApiId::Ka10099).is_some() && rest.halted().is_none(), "{name}: 그 경로만 멈춘다");
            let daily = crate::kiwoom::api::DailyChart::new(domain::StockCode::parse("005930").unwrap(), domain::Venue::Krx, KstDate::new(2026, 11, 9).unwrap());
            rest.call(&daily, None, Priority::Screen, MergeScope::default()).await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_same_detail_gets_the_same_handling_on_any_http_status() {
        for http in [200, 403, 429, 500] {
            let tokens = token_counter();
            let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
                tokens(s).unwrap_or_else(|| status(http, json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기]"})))
            }));
            let blocked = rest(&fake);
            assert_eq!(category(call_k(&blocked, 0, Priority::Screen).await.err()), Some(Category::AuthBlocked), "8050 HTTP {http}");
            assert_eq!(fake.sent().len(), 2, "8050 HTTP {http}: 발급 한 번, 조회 한 번");

            let tokens = token_counter();
            let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
                tokens(s).unwrap_or_else(|| if s.token.as_deref() == Some("tok-0") { status(http, json!({"return_code": 3, "return_msg": "[8005:Token이 유효하지 않습니다]"})) } else { list_ok() })
            }));
            let (saved, _guards) = rest_with_saved_token(&fake);
            call_k(&saved, 0, Priority::Screen).await.unwrap();
            let ids: Vec<_> = fake.sent().iter().map(|s| s.api_id).collect();
            assert_eq!(ids, [ApiId::Ka10099, ApiId::Au10001, ApiId::Ka10099], "8005 HTTP {http}: 한 번 다시 발급해 한 번 다시 보낸다");

            let tokens = token_counter();
            let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
                tokens(s).unwrap_or_else(|| status(http, json!({"return_code": 2, "return_msg": "[1511:필수]"})))
            }));
            let fresh = rest(&fake);
            assert_eq!(category(call_k(&fresh, 0, Priority::Background).await.err()), Some(Category::InvalidRequest), "1511 HTTP {http}");
            assert_eq!(fake.market_sent().len(), 1, "1511 HTTP {http}: 다시 보내지 않는다");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_issue_failure_that_is_not_transient_stops_issuing_but_not_requests_with_a_valid_token() {
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| match s.api_id.market().unwrap() {
            ApiId::Au10001 => ok(json!({"return_code": 1, "return_msg": "알 수 없음"}), None),
            _ => list_ok(),
        }));
        let (rest, _guards) = rest_with_saved_token(&fake);
        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        assert_eq!(category(rest.issue_token().await.err()), Some(Category::Unknown));
        call_k(&rest, 0, Priority::Screen).await.unwrap();
        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        assert_eq!(category(rest.issue_token().await.err()), Some(Category::Unknown));
        let ids: Vec<_> = fake.sent().iter().map(|s| s.api_id).collect();
        assert_eq!(ids, [ApiId::Au10001, ApiId::Ka10099], "발급은 한 번만, 쥐고 있는 토큰의 조회는 계속");
    }

    #[tokio::test(start_paused = true)]
    async fn an_ambiguous_issue_failure_waits_ten_minutes_and_stops_after_the_second() {
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| match s.api_id.market().unwrap() {
            ApiId::Au10001 => ok(json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8003:토큰 조회 실패]"}), None),
            _ => list_ok(),
        }));
        let rest = rest(&fake);
        assert_eq!(category(call_k(&rest, 0, Priority::Screen).await.err()), Some(Category::AuthIndeterminate));
        assert!(matches!(call_k(&rest, 1, Priority::Screen).await, Err(KiwoomError::Gated { cause: GateCause::IssueInterval, .. })));
        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        assert_eq!(category(call_k(&rest, 2, Priority::Screen).await.err()), Some(Category::AuthIndeterminate));
        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        assert_eq!(category(call_k(&rest, 3, Priority::Screen).await.err()), Some(Category::AuthIndeterminate));
        assert_eq!(category(rest.blocked()), Some(Category::AuthIndeterminate));
        assert_eq!(fake.sent().len(), 2, "발급 두 번, 그 뒤로는 아무것도 보내지 않는다");
        assert!(rest.halted().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_broken_token_response_stops_issuing() {
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| match s.api_id.market().unwrap() {
            ApiId::Au10001 => ok(json!({"return_code": 0, "return_msg": "정상"}), None),
            _ => list_ok(),
        }));
        let rest = rest(&fake);
        assert_eq!(category(rest.issue_token().await.err()), Some(Category::Protocol));
        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        assert_eq!(category(call_k(&rest, 0, Priority::Screen).await.err()), Some(Category::Protocol));
        assert_eq!(fake.sent().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn network_errors_retry_by_priority() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| tokens(s).unwrap_or_else(|| Err(TransportError::refused()))));
        let rest = rest(&fake);
        assert_eq!(category(call_k(&rest, 0, Priority::Screen).await.err()), Some(Category::Transient));
        let screen: Vec<_> = fake.market_sent();
        assert_eq!(screen.len(), 2);
        assert!(screen[1].at.duration_since(screen[0].at) >= Duration::from_millis(500));
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| tokens(s).unwrap_or_else(|| Err(TransportError::refused()))));
        let rest = super::tests::rest(&fake);
        assert_eq!(category(call_k(&rest, 1, Priority::Background).await.err()), Some(Category::Transient));
        let bg: Vec<_> = fake.market_sent().into_iter().filter(|s| s.cont.as_deref() == Some("k1")).collect();
        assert_eq!(bg.len(), 4);
        let gaps: Vec<u64> = bg.windows(2).map(|w| w[1].at.duration_since(w[0].at).as_secs()).collect();
        assert_eq!(gaps, [1, 2, 4]);
    }

    fn replies(seq: Vec<Result<HttpResponse, TransportError>>) -> impl Fn(&Sent) -> Result<HttpResponse, TransportError> {
        let tokens = token_counter();
        let n = AtomicUsize::new(0);
        move |s| tokens(s).unwrap_or_else(|| seq.get(n.fetch_add(1, Ordering::SeqCst)).cloned().unwrap_or_else(|| status(503, json!({}))))
    }

    fn rate_limited() -> Result<HttpResponse, TransportError> {
        status(429, json!({"return_code": 5, "return_msg": "허용된 요청 개수를 초과하였습니다[1700:유량=5]"}))
    }

    fn unavailable() -> Result<HttpResponse, TransportError> {
        status(503, json!({}))
    }

    fn indeterminate() -> Result<HttpResponse, TransportError> {
        ok(json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8003:토큰 조회 실패]"}), None)
    }

    fn gated_for(rest: &KiwoomRest, e: &KiwoomError) -> Option<i64> {
        matches!(e, KiwoomError::Gated { .. }).then(|| e.retry_at().unwrap().unix() - rest.0.clock.now().unix())
    }

    #[tokio::test(start_paused = true)]
    async fn one_request_sends_at_most_four_times_on_screen_and_six_otherwise() {
        for (priority, budget) in [(Priority::Screen, 4), (Priority::Background, 6)] {
            let seq = vec![rate_limited(), rate_limited(), invalid_token(), unavailable(), unavailable(), unavailable(), unavailable(), unavailable()];
            let fake = Arc::new(FakeTransport::new(Duration::ZERO, replies(seq)));
            let (rest, _guards) = rest_with_saved_token(&fake);
            let err = call_k(&rest, 0, priority).await.unwrap_err();
            assert_eq!(fake.market_sent().len(), budget, "{priority:?}: 한도 초과·토큰 무효·일시 장애가 번갈아도 총 전송은 예산까지");
            assert!(gated_for(&rest, &err).is_some(), "{priority:?}: {err:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn exhausted_transient_failures_close_a_shared_gate_for_thirty_seconds() {
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, replies(vec![unavailable(), unavailable(), list_ok(), list_ok()])));
        let rest = rest(&fake);
        let err = call_k(&rest, 0, Priority::Screen).await.unwrap_err();
        assert_eq!(gated_for(&rest, &err), Some(30));
        assert_eq!(category(Some(err)), Some(Category::Transient));
        let blocked = call_k(&rest, 1, Priority::Background).await.unwrap_err();
        assert_eq!(blocked.retry_at(), rest.gate_until(), "다른 요청도 같은 관문에서 기다린다");
        assert_eq!(fake.market_sent().len(), 2, "관문이 닫힌 동안 보내지 않는다");
        tokio::time::sleep(Duration::from_secs(30)).await;
        call_k(&rest, 1, Priority::Background).await.unwrap();
        call_k(&rest, 2, Priority::Screen).await.unwrap();
        assert_eq!(fake.market_sent().len(), 4, "확인 요청이 성공하면 다시 연다");
    }

    #[tokio::test(start_paused = true)]
    async fn three_failed_checks_stretch_the_gate_to_five_minutes() {
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, replies(vec![])));
        let rest = rest(&fake);
        call_k(&rest, 0, Priority::Screen).await.unwrap_err();
        let mut waits = Vec::new();
        for i in 1..=4 {
            let wait = rest.gate_until().unwrap().unix() - rest.0.clock.now().unix();
            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
            let (probe, held) = tokio::join!(call_k(&rest, i, Priority::Screen), call_k(&rest, 100 + i, Priority::Screen));
            waits.push(gated_for(&rest, &probe.unwrap_err()).unwrap());
            assert!(matches!(held, Err(KiwoomError::Gated { .. })), "확인 요청이 나가는 동안 다른 요청은 보내지 않는다");
        }
        assert_eq!(waits, [30, 30, 300, 300]);
        assert_eq!(fake.market_sent().len(), 2 + 4, "확인은 한 번에 하나, 다시 보내지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn only_the_check_request_reopens_the_gate() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::from_secs(1), move |s| {
            tokens(s).unwrap_or_else(|| if s.cont.as_deref() == Some("k0") { unavailable() } else { list_ok() })
        }));
        let rest = rest(&fake);
        rest.issue_token().await.unwrap();
        let failing = rest.clone();
        let failing = tokio::spawn(async move { call_k(&failing, 0, Priority::Screen).await });
        tokio::time::sleep(Duration::from_millis(2000)).await;
        call_k(&rest, 1, Priority::Screen).await.unwrap();
        assert!(matches!(failing.await.unwrap(), Err(KiwoomError::Gated { .. })));
        assert!(matches!(call_k(&rest, 2, Priority::Screen).await, Err(KiwoomError::Gated { .. })), "관문이 닫힌 뒤 도착한 다른 성공은 관문을 열지 않는다");
        assert_eq!(fake.market_sent().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn an_ambiguous_auth_failure_on_a_market_request_holds_every_request_for_ten_minutes_then_stops() {
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, replies(vec![indeterminate(), indeterminate()])));
        let rest = rest(&fake);
        let first = call_k(&rest, 0, Priority::Screen).await.unwrap_err();
        assert_eq!(category(Some(first.clone())), Some(Category::AuthIndeterminate));
        assert_eq!(gated_for(&rest, &first), Some(MIN_ISSUE_INTERVAL_SECS));
        let daily = crate::kiwoom::api::DailyChart::new(domain::StockCode::parse("005930").unwrap(), domain::Venue::Krx, KstDate::new(2026, 11, 9).unwrap());
        assert!(matches!(rest.call(&daily, None, Priority::Screen, MergeScope::default()).await, Err(KiwoomError::Gated { .. })), "다른 API도 같은 자격증명이라 기다린다");
        assert_eq!(fake.market_sent().len(), 1);
        tokio::time::sleep(Duration::from_secs(MIN_ISSUE_INTERVAL_SECS as u64)).await;
        let second = call_k(&rest, 1, Priority::Screen).await.unwrap_err();
        assert!(matches!(&second, KiwoomError::Stopped(f) if f.category() == Category::AuthIndeterminate), "{second:?}");
        assert!(matches!(call_k(&rest, 2, Priority::Screen).await, Err(KiwoomError::Stopped(_))));
        assert_eq!(fake.market_sent().len(), 2, "10분 뒤 확인 한 번, 그 뒤로는 사람이 다시 켤 때까지 보내지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn unparseable_body_is_a_parse_error() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            tokens(s).unwrap_or_else(|| ok(json!({"list": "not a list", "return_code": 0}), None))
        }));
        let rest = rest(&fake);
        assert_eq!(category(rest.call(&StockList::EXCHANGE, None, Priority::Screen, MergeScope::default()).await.err()), Some(Category::Protocol));
        assert_eq!(category(rest.call(&StockList::KOSDAQ, None, Priority::Screen, MergeScope::default()).await.err()), Some(Category::Protocol));
        assert_eq!(fake.market_sent().len(), 1, "형식이 틀린 경로로는 다시 보내지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_schema_failure_keeps_the_http_status_and_return_code_it_received() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| tokens(s).unwrap_or_else(|| ok(json!({"return_code": 0, "return_msg": "정상"}), None))));
        let rest = rest(&fake);
        let err = rest.call(&StockList::EXCHANGE, None, Priority::Screen, MergeScope::default()).await.unwrap_err();
        let f = err.failure().unwrap();
        assert_eq!((f.category(), f.http_status(), f.return_code()), (Category::Protocol, Some(200), Some(0)));
    }

    #[tokio::test(start_paused = true)]
    async fn continuation_headers_round_trip() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            tokens(s).unwrap_or_else(|| ok(json!({"list": [], "return_code": 0}), (s.cont.is_none()).then_some("NEXT-1")))
        }));
        let rest = rest(&fake);
        let p1 = rest.call(&StockList::EXCHANGE, None, Priority::Screen, MergeScope::default()).await.unwrap();
        assert_eq!(p1.next, Some(ContKey::new("NEXT-1")));
        let p2 = rest.call(&StockList::EXCHANGE, p1.next.as_ref(), Priority::Screen, MergeScope::default()).await.unwrap();
        assert_eq!(p2.next, None);
        assert_eq!(fake.market_sent()[1].cont.as_deref(), Some("NEXT-1"));
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_sent_when_the_issue_request_time_cannot_be_saved() {
        let (_dir, _lock, file) = crate::kiwoom::token_file::testing::temp_token_file();
        let state_dir = file.path().parent().unwrap().to_owned();
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), Some(file));
        std::fs::create_dir_all(state_dir.parent().unwrap()).unwrap();
        std::fs::write(&state_dir, "디렉터리 자리를 일반 파일이 막는다").unwrap();
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| tokens(s).unwrap_or_else(list_ok)));
        let rest = KiwoomRest::new(Arc::new(fake.clone()), auth, Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0)));
        assert!(rest.issue_token().await.is_err());
        assert!(call_k(&rest, 0, Priority::Screen).await.is_err());
        assert!(rest.issue_token().await.is_err());
        assert_eq!(fake.sent().len(), 0, "{:?}", fake.sent().iter().map(|s| s.api_id).collect::<Vec<_>>());
    }
    #[test]
    fn a_kiwoom_failure_shows_its_code_reason_and_resume_time_from_one_place() {
        use crate::api::{ApiErrorCode as C, ApiErrorReason as R};
        use crate::kiwoom::error::judge;
        use crate::kiwoom::transport::{Stage, TransportError};
        let rejected = |detail: u16| KiwoomError::Failed(judge(ApiId::Ka10081, 200, &format!(r#"{{"return_code": 3, "return_msg": "실패[{detail}:사유]"}}"#)).unwrap_err());
        let transport = |stage, timed_out| KiwoomError::Failed(Failure::transport(ApiId::Ka10081, TransportError { stage, timed_out }));
        let until = kst(KstDate::new(2026, 11, 9).unwrap(), 9, 10, 0);
        let cases = [
            (rejected(1700), C::KiwoomUnavailable, R::RateLimited),
            (rejected(8005), C::KiwoomAuthFailed, R::TokenInvalid),
            (rejected(8003), C::KiwoomAuthFailed, R::AuthIndeterminate),
            (rejected(1901), C::UnknownSymbol, R::SymbolMismatch),
            (rejected(1501), C::Internal, R::InvalidRequest),
            (rejected(2000), C::KiwoomUnavailable, R::BusinessRejected),
            (transport(Stage::AwaitResponse, true), C::KiwoomUnavailable, R::KiwoomTimeout),
            (transport(Stage::Connect, false), C::KiwoomUnavailable, R::KiwoomUnreachable),
            (KiwoomError::NotConnected, C::KiwoomUnavailable, R::NotConnected),
            (KiwoomError::Gated { until, cause: GateCause::IssueInterval }, C::KiwoomUnavailable, R::IssueInterval),
        ];
        for (error, code, reason) in cases {
            let shown = error.shown();
            assert_eq!((shown.code, shown.reason), (code, reason), "{error}");
            assert_eq!((shown.retry_at, shown.manual_action_required), (error.retry_at(), error.manual_action_required()), "{error}");
        }
        assert_eq!(KiwoomError::Gated { until, cause: GateCause::IssueInterval }.shown().retry_at, Some(until));
    }

    fn at_ms(sent: &[Sent], origin: Instant) -> Vec<u64> {
        sent.iter().map(|s| s.at.duration_since(origin).as_millis() as u64).collect()
    }

    fn sent_of(fake: &FakeTransport, api: impl Into<Endpoint>) -> Vec<Sent> {
        let api = api.into();
        fake.market_sent().into_iter().filter(|s| s.api_id == api).collect()
    }

    fn fake_with(latency: Duration, handler: impl Fn(&Sent) -> Result<HttpResponse, TransportError> + Send + Sync + 'static) -> Arc<FakeTransport> {
        let tokens = token_counter();
        Arc::new(FakeTransport::new(latency, move |s| tokens(s).unwrap_or_else(|| handler(s))))
    }

    fn limited_with(allowance: Option<u32>) -> Result<HttpResponse, TransportError> {
        let counted = allowance.map(|n| format!(" 유량={n}, API ID=ka10080")).unwrap_or_default();
        status(429, json!({"return_code": 5, "return_msg": format!("허용된 요청 개수를 초과하였습니다[1700:허용된 API 요청 개수를 초과하였습니다.{counted}]")}))
    }

    type Call<'a> = futures::future::BoxFuture<'a, Result<(), KiwoomError>>;

    fn tr_call<'a>(rest: &'a KiwoomRest, api: impl Into<Endpoint>, body: &str, priority: Priority) -> Call<'a> {
        let dispatch = Dispatch { endpoint: api.into(), body: body.to_owned(), cont: None, priority, scope: MergeScope::default(), admit: None, once: None };
        Box::pin(async move { rest.call_endpoint(dispatch, |_: &serde_json::Value| true).await.map(drop) })
    }

    fn write_call<'a>(rest: &'a KiwoomRest, api: TradingApiId, body: &str, admit: Option<Admission>) -> Call<'a> {
        let dispatch = Dispatch {
            endpoint: api.into(),
            body: body.to_owned(),
            cont: None,
            priority: Priority::Order,
            scope: MergeScope::default(),
            admit,
            once: Some(SendOnce { transmitted: Transmitted::default() }),
        };
        Box::pin(async move { rest.call_endpoint(dispatch, |_: &serde_json::Value| true).await.map(drop) })
    }

    async fn all_ok(calls: Vec<Call<'_>>) {
        for r in futures::future::join_all(calls).await {
            r.unwrap();
        }
    }

    async fn real_rest(fake: &Arc<FakeTransport>) -> KiwoomRest {
        let rest = rest_in(fake, KiwoomEnvironment::Real);
        rest.issue_token().await.unwrap();
        rest
    }

    #[tokio::test(start_paused = true)]
    async fn one_tr_sends_five_at_once_and_the_sixth_when_its_window_frees() {
        let fake = fake_with(Duration::ZERO, |_| list_ok());
        let rest = real_rest(&fake).await;
        let origin = Instant::now();
        all_ok((0..12).map(|i| tr_call(&rest, ApiId::Ka10080, &format!("b{i}"), Priority::Screen)).collect()).await;
        let sent = fake.market_sent();
        assert_eq!(at_ms(&sent, origin), [0, 0, 0, 0, 0, 1050, 1050, 1050, 1050, 1050, 2100, 2100]);
        assert_at_most_per_second(&sent, 5);
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_tr_does_not_hold_back_other_trs_and_keeps_priority_inside_the_tr() {
        let fake = fake_with(Duration::ZERO, |_| list_ok());
        let rest = real_rest(&fake).await;
        let origin = Instant::now();
        let screen = |i: usize| tr_call(&rest, ApiId::Ka10080, &format!("s{i}"), Priority::Screen);
        let background = |i: usize| tr_call(&rest, ApiId::Ka10080, &format!("b{i}"), Priority::Background);
        let mut calls: Vec<Call> = (1..=5).map(screen).collect();
        calls.extend((1..=5).map(background));
        calls.push(screen(6));
        calls.push(tr_call(&rest, ApiId::Ka10081, "other", Priority::Background));
        all_ok(calls).await;
        let sent = fake.market_sent();
        let order: Vec<_> = sent.iter().map(|s| s.body.clone()).collect();
        assert_eq!(order, ["s1", "s2", "s3", "s4", "s5", "other", "s6", "b1", "b2", "b3", "b4", "b5"]);
        assert_eq!(at_ms(&sent, origin), [0, 0, 0, 0, 0, 0, 1050, 1050, 1050, 1050, 1050, 2100]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_order_goes_before_a_screen_request_of_the_same_tr() {
        let fake = fake_with(Duration::ZERO, |_| list_ok());
        let rest = real_rest(&fake).await;
        let origin = Instant::now();
        all_ok((0..4).map(|i| tr_call(&rest, ApiId::Ka10001, &format!("e{i}"), Priority::Screen)).collect()).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        all_ok(vec![tr_call(&rest, ApiId::Ka10001, "screen", Priority::Screen), tr_call(&rest, ApiId::Ka10001, "order", Priority::Order)]).await;
        let sent = fake.market_sent();
        let last: Vec<_> = sent[4..].iter().map(|s| (s.body.as_str(), s.at.duration_since(origin).as_millis() as u64)).collect();
        assert_eq!(last, [("order", 10), ("screen", 1050)]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_four_order_write_trs_share_one_window_and_queries_do_not_wait() {
        let fake = fake_with(Duration::ZERO, |_| list_ok());
        let rest = real_rest(&fake).await;
        let origin = Instant::now();
        let writes = [TradingApiId::Kt10000, TradingApiId::Kt10001, TradingApiId::Kt10002, TradingApiId::Kt10003, TradingApiId::Kt10000, TradingApiId::Kt10001];
        let mut calls: Vec<Call> = vec![tr_call(&rest, ApiId::Ka10001, "screen-same-lane", Priority::Screen), tr_call(&rest, TradingApiId::Kt00018, "account", Priority::Screen)];
        calls.extend(writes.iter().enumerate().map(|(i, api)| write_call(&rest, *api, &format!("w{i}"), None)));
        all_ok(calls).await;
        let sent = fake.market_sent();
        let writes_at: Vec<_> = sent.iter().filter(|s| s.body.starts_with('w')).map(|s| (s.body.as_str(), s.at.duration_since(origin).as_millis() as u64)).collect();
        assert_eq!(writes_at, [("w0", 0), ("w1", 0), ("w2", 0), ("w3", 0), ("w4", 0), ("w5", 1050)]);
        let queries: Vec<_> = sent.iter().filter(|s| !s.body.starts_with('w')).map(|s| s.at.duration_since(origin).as_millis() as u64).collect();
        assert_eq!(queries, [0, 0]);
        assert_eq!(sent.iter().position(|s| s.body == "w0"), Some(0), "주문 요청이 먼저 나간다");
    }

    #[tokio::test(start_paused = true)]
    async fn mock_queue_counts_the_order_writes_as_one_window_of_one() {
        let fake = fake_with(Duration::from_millis(10), |_| list_ok());
        let rest = rest_in(&fake, KiwoomEnvironment::Mock);
        rest.issue_token().await.unwrap();
        let origin = Instant::now();
        all_ok(vec![
            write_call(&rest, TradingApiId::Kt10000, "w0", None),
            write_call(&rest, TradingApiId::Kt10001, "w1", None),
            tr_call(&rest, ApiId::Ka10001, "q", Priority::Screen),
        ])
        .await;
        let at: Vec<_> = fake.market_sent().iter().map(|s| (s.body.clone(), s.at.duration_since(origin).as_millis() as u64)).collect();
        assert_eq!(at, [("w0".to_owned(), 0), ("q".to_owned(), 0), ("w1".to_owned(), 1050)]);
    }

    async fn call_at(rest: &KiwoomRest, after_ms: u64, api: ApiId, body: &str) -> Result<(), KiwoomError> {
        tokio::time::sleep(Duration::from_millis(after_ms)).await;
        tr_call(rest, api, body, Priority::Screen).await
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limited_request_is_sent_again_when_its_window_frees_while_other_trs_keep_going() {
        let limited = std::sync::atomic::AtomicBool::new(false);
        let fake = fake_with(Duration::ZERO, move |s| if s.body == "c" && !limited.swap(true, Ordering::SeqCst) { limited_with(Some(5)) } else { list_ok() });
        let rest = real_rest(&fake).await;
        let origin = Instant::now();
        let (a, b, c, d) = tokio::join!(call_at(&rest, 0, ApiId::Ka10080, "a"), call_at(&rest, 100, ApiId::Ka10080, "b"), call_at(&rest, 200, ApiId::Ka10080, "c"), call_at(&rest, 300, ApiId::Ka10081, "d"));
        a.unwrap();
        b.unwrap();
        c.unwrap();
        d.unwrap();
        let sent = fake.market_sent();
        let timeline: Vec<_> = sent.iter().map(|s| (s.body.as_str(), s.at.duration_since(origin).as_millis() as u64)).collect();
        assert_eq!(timeline, [("a", 0), ("b", 100), ("c", 200), ("d", 300), ("c", 1050)]);
    }

    async fn window_after_a_limit_response(allowance: Option<u32>) -> (Vec<u64>, Vec<u64>) {
        let limited = std::sync::atomic::AtomicBool::new(false);
        let fake = fake_with(Duration::ZERO, move |s| if s.body == "x2" && !limited.swap(true, Ordering::SeqCst) { limited_with(allowance) } else { list_ok() });
        let rest = real_rest(&fake).await;
        all_ok((0..3).map(|i| tr_call(&rest, ApiId::Ka10080, &format!("x{i}"), Priority::Screen)).collect()).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        let origin = Instant::now();
        let mut calls: Vec<Call> = (0..6).map(|i| tr_call(&rest, ApiId::Ka10080, &format!("w{i}"), Priority::Screen)).collect();
        calls.extend((0..6).map(|i| tr_call(&rest, ApiId::Ka10081, &format!("y{i}"), Priority::Screen)));
        all_ok(calls).await;
        let after = |api: ApiId| at_ms(&sent_of(&fake, api).into_iter().filter(|s| s.at >= origin).collect::<Vec<_>>(), origin);
        (after(ApiId::Ka10080), after(ApiId::Ka10081))
    }

    #[tokio::test(start_paused = true)]
    async fn a_limit_response_with_a_count_changes_only_that_trs_limit() {
        let (limited, other) = window_after_a_limit_response(Some(2)).await;
        assert_eq!(limited, [0, 0, 1050, 1050, 2100, 2100], "유량=2 뒤 그 TR은 최근 1초 2건까지");
        assert_eq!(other, [0, 0, 0, 0, 0, 1050], "다른 TR의 한도는 그대로");
    }

    #[tokio::test(start_paused = true)]
    async fn a_limit_response_without_a_count_keeps_the_limit() {
        let (limited, _) = window_after_a_limit_response(None).await;
        assert_eq!(limited, [0, 0, 0, 0, 0, 1050]);
    }

    fn write_fake(replies: Vec<Result<HttpResponse, TransportError>>) -> Arc<FakeTransport> {
        Arc::new(FakeTransport::new(Duration::ZERO, replies_for_writes(replies)))
    }

    fn replies_for_writes(seq: Vec<Result<HttpResponse, TransportError>>) -> impl Fn(&Sent) -> Result<HttpResponse, TransportError> {
        replies(seq)
    }

    fn the_write(rest: &KiwoomRest) -> Call<'_> {
        write_call(rest, TradingApiId::Kt10000, "order", None)
    }

    #[tokio::test(start_paused = true)]
    async fn an_order_write_that_is_rate_limited_is_sent_again_when_the_bundle_window_frees() {
        let fake = write_fake(vec![limited_with(Some(5)), list_ok()]);
        let rest = real_rest(&fake).await;
        let origin = Instant::now();
        the_write(&rest).await.unwrap();
        assert_eq!(at_ms(&fake.market_sent(), origin), [0, 1050]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_order_write_fails_with_the_rate_limit_after_three_sends() {
        let fake = write_fake(vec![limited_with(Some(5)), limited_with(Some(5)), limited_with(Some(5)), list_ok()]);
        let rest = real_rest(&fake).await;
        let origin = Instant::now();
        let err = the_write(&rest).await.unwrap_err();
        assert_eq!(at_ms(&fake.market_sent(), origin), [0, 1050, 2100]);
        assert!(matches!(err, KiwoomError::Failed(_)), "{err:?}");
        assert_eq!(category(Some(err)), Some(Category::RateLimit));
        assert_eq!(rest.gate_until(), None, "주문 쓰기는 관문을 닫지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn an_order_write_is_sent_once_when_the_resend_switch_is_off() {
        let fake = write_fake(vec![limited_with(Some(5)), list_ok()]);
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let rest = KiwoomRest::start(Arc::new(fake.clone()), auth, clock, Pacing::PerTr, KiwoomEnvironment::Real, 0, None);
        rest.issue_token().await.unwrap();
        assert_eq!(category(the_write(&rest).await.err()), Some(Category::RateLimit));
        assert_eq!(fake.market_sent().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_order_write_checks_admission_again_before_sending_again() {
        let fake = write_fake(vec![limited_with(Some(5)), list_ok()]);
        let rest = real_rest(&fake).await;
        let checks = Arc::new(AtomicUsize::new(0));
        let admit: Admission = {
            let checks = checks.clone();
            Arc::new(move || checks.fetch_add(1, Ordering::SeqCst) == 0)
        };
        let err = write_call(&rest, TradingApiId::Kt10000, "order", Some(admit)).await.unwrap_err();
        assert_eq!(err, KiwoomError::NotConnected);
        assert_eq!(fake.market_sent().len(), 1);
        assert_eq!(checks.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn an_order_write_is_not_sent_again_for_any_other_failure() {
        let unreadable = || ok(json!("not an object"), None);
        let rate_limited_in_200 = || ok(json!({"return_code": 5, "return_msg": "초과[1700:유량=5]"}), None);
        let temporarily_down = || ok(json!({"return_code": 1, "return_msg": "점검[1999:일시 장애]"}), None);
        let failures = [Err(TransportError::refused()), unavailable(), temporarily_down(), unreadable(), rate_limited_in_200()];
        for failure in failures {
            let fake = write_fake(vec![failure.clone(), list_ok()]);
            let rest = real_rest(&fake).await;
            assert!(the_write(&rest).await.is_err(), "{failure:?}");
            assert_eq!(fake.market_sent().len(), 1, "{failure:?}");
        }
    }

    struct Logs;

    fn capture_logs() -> Logs {
        crate::kiwoom::stream::tests::install_global_log_capture();
        crate::kiwoom::stream::tests::start_capturing_logs_of_this_thread();
        Logs
    }

    impl Logs {
        fn text(&self) -> String {
            crate::kiwoom::stream::tests::logs_captured_on_this_thread()
        }

        fn counter_lines(&self) -> Vec<String> {
            self.text().lines().filter(|l| l.contains("키움 대기열 1분 계수")).map(str::to_owned).collect()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_queue_logs_per_tr_counts_every_minute_and_skips_idle_trs() {
        let logs = capture_logs();
        let limited = std::sync::atomic::AtomicBool::new(false);
        let fake = fake_with(Duration::ZERO, move |s| if s.body == "secret-a2" && !limited.swap(true, Ordering::SeqCst) { limited_with(None) } else { list_ok() });
        let rest = real_rest(&fake).await;
        let mut calls: Vec<Call> = (0..6).map(|i| tr_call(&rest, ApiId::Ka10080, &format!("secret-a{i}"), Priority::Screen)).collect();
        calls.push(tr_call(&rest, ApiId::Ka10081, "secret-x", Priority::Screen));
        all_ok(calls).await;
        tokio::time::sleep(Duration::from_secs(61)).await;
        let first = logs.counter_lines();
        let find = |api: &str| first.iter().find(|l| l.contains(&format!("api_id=\"{api}\""))).unwrap_or_else(|| panic!("{api}: {first:?}")).to_owned();
        let numbers = |line: String| line.split(" sent=").nth(1).unwrap().to_owned();
        assert_eq!(numbers(find("ka10080")), "7 rate_limited=1 resent=1 max_wait_ms=1050");
        assert_eq!(numbers(find("ka10081")), "1 rate_limited=0 resent=0 max_wait_ms=0");
        assert_eq!(numbers(find("au10001")), "1 rate_limited=0 resent=0 max_wait_ms=0");
        assert_eq!(first.len(), 3);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(logs.counter_lines().len(), 3, "보낸 것이 없는 1분에는 줄이 없다");
        tr_call(&rest, ApiId::Ka10081, "secret-y", Priority::Screen).await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
        let all = logs.counter_lines();
        assert_eq!(all.len(), 4, "{all:?}");
        assert!(all[3].contains("api_id=\"ka10081\"") && all[3].contains("sent=1 "), "{}", all[3]);
        let text = logs.text();
        assert!(!text.contains("secret-") && !text.contains("tok-"), "로그에 본문이나 토큰이 없다");
    }

    struct Timed {
        label: &'static str,
        enqueued_ms: u64,
        done_ms: u64,
    }

    fn timed<'a>(origin: Instant, label: &'static str, after_ms: u64, call: Call<'a>) -> futures::future::BoxFuture<'a, Timed> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(after_ms)).await;
            let enqueued_ms = Instant::now().duration_since(origin).as_millis() as u64;
            call.await.unwrap();
            Timed { label, enqueued_ms, done_ms: Instant::now().duration_since(origin).as_millis() as u64 }
        })
    }

    async fn settled_rest(fake: &Arc<FakeTransport>, shared_spacing: bool) -> KiwoomRest {
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let rest = if shared_spacing {
            KiwoomRest::with_send_spacing(Arc::new(fake.clone()), auth, clock, SHARED_SPACING)
        } else {
            KiwoomRest::new(Arc::new(fake.clone()), auth, clock)
        };
        rest.issue_token().await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
        rest
    }

    async fn symbol_switch(shared_spacing: bool) -> (Vec<Timed>, usize) {
        let fake = fake_with(Duration::from_millis(30), |_| list_ok());
        let rest = settled_rest(&fake, shared_spacing).await;
        let origin = Instant::now();
        let screen = |label: &'static str, api: Endpoint, body: &'static str, after_ms: u64| timed(origin, label, after_ms, tr_call(&rest, api, body, Priority::Screen));
        let calls = vec![
            screen("ka10081", ApiId::Ka10081.into(), "chart", 0),
            screen("ka10080", ApiId::Ka10080.into(), "minute", 0),
            screen("ka10004", ApiId::Ka10004.into(), "book", 0),
            screen("ka10095", ApiId::Ka10095.into(), "quote", 0),
            screen("ka10003", ApiId::Ka10003.into(), "ticks", 0),
            screen("ka10001", ApiId::Ka10001.into(), "info", 0),
            screen("kt00011", TradingApiId::Kt00011.into(), "buyable", 0),
            screen("ka10095 again", ApiId::Ka10095.into(), "quote", 50),
        ];
        let timeline = futures::future::join_all(calls).await;
        let sends = fake.market_sent().len();
        for t in &timeline {
            println!("종목 전환 {} {:<14} 넣음 {:>5}ms 끝남 {:>5}ms", if shared_spacing { "지금(260ms)" } else { "새 규칙   " }, t.label, t.enqueued_ms, t.done_ms);
        }
        (timeline, sends)
    }

    #[tokio::test(start_paused = true)]
    async fn probe_symbol_switch_before_and_after_the_window_queue() {
        let (before, before_sends) = symbol_switch(true).await;
        let (after, after_sends) = symbol_switch(false).await;
        let slowest = |t: &[Timed]| t.iter().map(|t| t.done_ms).max().unwrap();
        assert!(slowest(&before) > 1500, "지금 동작은 마지막 완료가 1.5초를 넘는다: {}ms", slowest(&before));
        assert_eq!(before_sends, 7, "지금은 아직 줄에 있는 같은 ka10095를 합친다");
        assert_eq!(after_sends, 8);
        for t in &after {
            assert!(t.done_ms - t.enqueued_ms <= 35, "{}: 넣은 뒤 {}ms", t.label, t.done_ms - t.enqueued_ms);
        }
    }

    async fn one_order(shared_spacing: bool) -> (Vec<Timed>, u64) {
        let fake = fake_with(Duration::from_millis(30), |_| list_ok());
        let rest = settled_rest(&fake, shared_spacing).await;
        let origin = Instant::now();
        let account = |label: &'static str, api: TradingApiId| timed(origin, label, 0, tr_call(&rest, api, label, Priority::Screen));
        let steps = async {
            let rest = &rest;
            let mut done = Vec::new();
            done.push(timed(origin, "ka10001", 0, tr_call(rest, ApiId::Ka10001, "price band", Priority::Order)).await);
            done.push(timed(origin, "kt00011", 0, tr_call(rest, TradingApiId::Kt00011, "buyable", Priority::Order)).await);
            done.push(timed(origin, "kt10000", 0, write_call(rest, TradingApiId::Kt10000, "buy", None)).await);
            done
        };
        let (mut timeline, chain) = tokio::join!(futures::future::join_all(vec![account("kt00018", TradingApiId::Kt00018), account("kt00007", TradingApiId::Kt00007), account("ka10075", TradingApiId::Ka10075)]), steps);
        timeline.extend(chain);
        let write_sent = fake.market_sent().into_iter().find(|s| s.api_id == Endpoint::from(TradingApiId::Kt10000)).unwrap().at.duration_since(origin).as_millis() as u64;
        for t in &timeline {
            println!("주문 1건 {} {:<8} 넣음 {:>4}ms 끝남 {:>4}ms", if shared_spacing { "지금(260ms)" } else { "새 규칙   " }, t.label, t.enqueued_ms, t.done_ms);
        }
        (timeline, write_sent)
    }

    #[tokio::test(start_paused = true)]
    async fn probe_one_order_before_and_after_the_window_queue() {
        let (_, before_write_sent) = one_order(true).await;
        let (after, after_write_sent) = one_order(false).await;
        assert!(before_write_sent >= 520, "지금 동작은 쓰기가 520ms 이후에 나간다: {before_write_sent}ms");
        let write = after.iter().find(|t| t.label == "kt10000").unwrap();
        assert!(write.done_ms <= 95, "새 동작은 쓰기 완료가 약 90ms: {}ms", write.done_ms);
        assert_eq!(after_write_sent, 60);
    }

    async fn seven_trs_with_total_limit(total_limit: Option<u32>) -> (Vec<u64>, Vec<String>) {
        let fake = fake_with(Duration::ZERO, |_| list_ok());
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let logs = capture_logs();
        let rest = KiwoomRest::start(Arc::new(fake.clone()), auth, clock, Pacing::PerTr, KiwoomEnvironment::Real, ORDER_RATE_LIMIT_RESENDS, total_limit);
        rest.issue_token().await.unwrap();
        let origin = Instant::now();
        let trs = [ApiId::Ka10081, ApiId::Ka10080, ApiId::Ka10004, ApiId::Ka10095, ApiId::Ka10003, ApiId::Ka10001, ApiId::Ka10100];
        all_ok(trs.iter().map(|api| tr_call(&rest, *api, "x", Priority::Screen)).collect()).await;
        tokio::time::sleep(Duration::from_secs(61)).await;
        (at_ms(&fake.market_sent(), origin), logs.counter_lines())
    }

    #[tokio::test(start_paused = true)]
    async fn the_total_window_is_off_by_default_and_seven_trs_go_at_once() {
        let (at, lines) = seven_trs_with_total_limit(None).await;
        assert_eq!(at, [0; 7]);
        assert!(lines.iter().all(|l| !l.contains("max_total_wait_ms")), "{lines:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn the_total_window_sends_five_at_once_and_the_rest_when_it_frees() {
        let (at, lines) = seven_trs_with_total_limit(Some(5)).await;
        assert_eq!(at, [0, 0, 0, 0, 0, 1050, 1050]);
        let waited: Vec<_> = lines.iter().filter(|l| l.contains("max_total_wait_ms=1050")).collect();
        assert_eq!(waited.len(), 2, "{lines:?}");
        assert!(lines.iter().filter(|l| l.contains("au10001")).all(|l| l.contains("max_total_wait_ms=0")), "토큰 발급은 합계에 세지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn the_total_window_counts_order_writes_and_the_tr_window_still_applies() {
        let fake = fake_with(Duration::ZERO, |_| list_ok());
        let auth = KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None);
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let rest = KiwoomRest::start(Arc::new(fake.clone()), auth, clock, Pacing::PerTr, KiwoomEnvironment::Real, ORDER_RATE_LIMIT_RESENDS, Some(3));
        rest.issue_token().await.unwrap();
        let origin = Instant::now();
        all_ok(vec![
            write_call(&rest, TradingApiId::Kt10000, "w0", None),
            write_call(&rest, TradingApiId::Kt10001, "w1", None),
            tr_call(&rest, ApiId::Ka10001, "a", Priority::Screen),
            tr_call(&rest, ApiId::Ka10001, "b", Priority::Screen),
        ])
        .await;
        let at: Vec<_> = fake.market_sent().iter().map(|s| (s.body.clone(), s.at.duration_since(origin).as_millis() as u64)).collect();
        assert_eq!(at, [("w0".to_owned(), 0), ("w1".to_owned(), 0), ("a".to_owned(), 0), ("b".to_owned(), 1050)]);
    }
}
