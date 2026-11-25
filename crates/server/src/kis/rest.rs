use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use domain::KstTime;
use tokio::sync::{Notify, oneshot};
use tokio::time::{Instant, sleep_until};

use super::api::KisEndpoint;
use super::auth::{AuthError, Halt, KisAuth, TokenLease};
use super::error::{Failure, Policy, judge_market};
use super::token_file::FileError;
use super::transport::{HttpRequest, Method, Transport, TransportError};
use crate::config::Secret;

pub const KIS_PER_SECOND_LIMIT: u32 = 15;
const SEND_WINDOW: Duration = Duration::from_secs(1);
const WINDOW_MARGIN: Duration = Duration::from_millis(50);
const SCREEN_RESERVED_SLOTS: u32 = 2;
const SCREEN_ACTIVITY_SPAN: Duration = Duration::from_secs(10);
const MAX_RATE_LIMITED: u8 = 3;
const CUSTOMER_TYPE_PERSONAL: &str = "P";
const MORE_PAGES: [&str; 2] = ["F", "M"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Priority {
    Order,
    Screen,
    ScreenBulk,
    Recovery,
    Background,
}

const PRIORITIES: [Priority; 5] = [Priority::Order, Priority::Screen, Priority::ScreenBulk, Priority::Recovery, Priority::Background];

impl Priority {
    fn lane(self) -> usize {
        self as usize
    }

    fn uses_reserved_slots(self) -> bool {
        matches!(self, Priority::Order | Priority::Screen)
    }
}

pub type Admission = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub struct SendOnce {
    pub transmitted: Arc<std::sync::atomic::AtomicBool>,
    pub admit: Admission,
}

impl SendOnce {
    pub fn new(admit: Admission) -> SendOnce {
        SendOnce { transmitted: Arc::default(), admit }
    }

    pub fn happened(&self) -> bool {
        self.transmitted.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl fmt::Debug for SendOnce {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SendOnce").field("transmitted", &self.happened()).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct KisRequest {
    pub api: KisEndpoint,
    pub query: Vec<(&'static str, String)>,
    pub next_page: bool,
    pub priority: Priority,
    pub body: Option<Secret<String>>,
    pub once: Option<SendOnce>,
}

impl KisRequest {
    pub fn new(api: impl Into<KisEndpoint>, query: Vec<(&'static str, String)>, priority: Priority) -> Self {
        KisRequest { api: api.into(), query, next_page: false, priority, body: None, once: None }
    }

    pub fn write_once(api: impl Into<KisEndpoint>, body: Secret<String>, once: SendOnce) -> Self {
        KisRequest { api: api.into(), query: Vec::new(), next_page: false, priority: Priority::Order, body: Some(body), once: Some(once) }
    }

    pub fn next_page(self) -> Self {
        KisRequest { next_page: true, ..self }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KisPage {
    pub body: Arc<str>,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KisError {
    Failed(Failure),
    Gated { until: KstTime },
    Stopped(Failure),
    TokenFile(FileError),
    TokenNotSupplied,
    Transport(TransportError),
    BadTokenResponse,
    QueueGone,
    NotAdmitted,
}

impl fmt::Display for KisError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KisError::Failed(failure) | KisError::Stopped(failure) => failure.fmt(f),
            KisError::Gated { .. } => f.write_str("한투 토큰 발급 간격(10분)이 지날 때까지 요청하지 않습니다"),
            KisError::TokenFile(e) => write!(f, "한투 토큰 파일: {e}"),
            KisError::TokenNotSupplied => f.write_str("한투 접근토큰이 아직 전달되지 않았거나 다시 받아야 합니다"),
            KisError::Transport(e) => write!(f, "한투 요청 실패: {e}"),
            KisError::BadTokenResponse => f.write_str("한투 인증 응답에서 값을 읽지 못했습니다"),
            KisError::QueueGone => f.write_str("한투 요청 대기열이 요청을 끝내지 못했습니다"),
            KisError::NotAdmitted => f.write_str("주문 사용이 꺼져 한투에 보내지 않았습니다"),
        }
    }
}

impl std::error::Error for KisError {}

impl From<AuthError> for KisError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Halted(Halt::Rejected(failure)) => KisError::Stopped(failure),
            AuthError::Halted(Halt::TokenFileUnreadable(e)) | AuthError::NotRecorded(e) => KisError::TokenFile(e),
            AuthError::IssueInterval { retry_at } => KisError::Gated { until: retry_at },
            AuthError::IssueDisabled => KisError::TokenNotSupplied,
            AuthError::Transport(e) => KisError::Transport(e),
            AuthError::Failed(failure) => KisError::Failed(failure),
            AuthError::BadResponse => KisError::BadTokenResponse,
        }
    }
}

type JobResult = Result<KisPage, KisError>;

static NEXT_WRITE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone, PartialEq, Eq, Hash)]
struct DedupeKey {
    api: KisEndpoint,
    query: Vec<(&'static str, String)>,
    next_page: bool,
    write: Option<u64>,
}

impl DedupeKey {
    fn of(request: &KisRequest) -> Self {
        let mut query = request.query.clone();
        query.sort();
        let write = request.once.is_some().then(|| NEXT_WRITE.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        DedupeKey { api: request.api, query, next_page: request.next_page, write }
    }
}

#[derive(Default)]
struct Window {
    sent: VecDeque<Instant>,
    held_until: Option<Instant>,
    last_screen_send: Option<Instant>,
}

impl Window {
    fn span() -> Duration {
        SEND_WINDOW + WINDOW_MARGIN
    }

    fn reserved_slots() -> u32 {
        SCREEN_RESERVED_SLOTS.min(KIS_PER_SECOND_LIMIT.saturating_sub(1))
    }

    fn forget_expired(&mut self, now: Instant) {
        while self.sent.front().is_some_and(|&t| t + Self::span() <= now) {
            self.sent.pop_front();
        }
    }

    fn slot_free_at(&self, now: Instant, cap: u32) -> Option<Instant> {
        let cap = cap.max(1) as usize;
        let first_live = self.sent.partition_point(|&t| t + Self::span() <= now);
        let live = self.sent.len() - first_live;
        (live >= cap).then(|| self.sent[first_live + live - cap] + Self::span())
    }

    fn screen_active_until(&self, now: Instant) -> Option<Instant> {
        self.last_screen_send.map(|t| t + SCREEN_ACTIVITY_SPAN).filter(|&until| until > now)
    }

    fn ready_at(&self, now: Instant, priority: Priority) -> Option<Instant> {
        let full = self.slot_free_at(now, KIS_PER_SECOND_LIMIT);
        let ready = match self.screen_active_until(now).filter(|_| !priority.uses_reserved_slots()) {
            Some(reserve_lifts) => self.slot_free_at(now, KIS_PER_SECOND_LIMIT - Self::reserved_slots()).map(|beyond_reserve| beyond_reserve.min(reserve_lifts.max(full.unwrap_or(now)))),
            None => full,
        };
        ready.into_iter().chain(self.held_until).max().filter(|&r| r > now)
    }

    fn record(&mut self, now: Instant, priority: Priority) -> Instant {
        self.forget_expired(now);
        let oldest = self.sent.front().copied().unwrap_or(now);
        self.sent.push_back(now);
        if priority.uses_reserved_slots() {
            self.last_screen_send = Some(now);
        }
        oldest
    }

    fn hold_until_oldest_leaves(&mut self, oldest_at_send: Instant) {
        self.held_until = self.held_until.into_iter().chain([oldest_at_send + Self::span()]).max();
    }
}

#[derive(Default)]
struct Scheduler {
    lanes: [VecDeque<u64>; 5],
    window: Window,
    next_ticket: u64,
}

enum Decision {
    Granted { oldest_in_window: Instant },
    WaitUntil(Option<Instant>),
}

impl Scheduler {
    fn decide(&mut self, ticket: u64, priority: Priority, now: Instant) -> Decision {
        self.window.forget_expired(now);
        let outranking = PRIORITIES.iter().find(|&&p| self.lanes[p.lane()].front().is_some() && self.window.ready_at(now, p).is_none());
        let is_head = self.lanes[priority.lane()].front() == Some(&ticket);
        match outranking {
            Some(&best) if best == priority && is_head => {
                self.lanes[priority.lane()].pop_front();
                Decision::Granted { oldest_in_window: self.window.record(now, priority) }
            }
            _ if is_head => Decision::WaitUntil(self.window.ready_at(now, priority)),
            _ => Decision::WaitUntil(None),
        }
    }

    fn leave(&mut self, ticket: u64, priority: Priority) {
        self.lanes[priority.lane()].retain(|&t| t != ticket);
    }
}

struct Inner {
    transport: Arc<dyn Transport>,
    auth: KisAuth,
    scheduler: Mutex<Scheduler>,
    changed: Notify,
    merged: Mutex<HashMap<DedupeKey, Vec<oneshot::Sender<JobResult>>>>,
    stopped: Mutex<HashMap<KisEndpoint, Failure>>,
}

#[derive(Clone)]
pub struct KisRest(Arc<Inner>);

impl fmt::Debug for KisRest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KisRest").field("auth", &self.0.auth).finish_non_exhaustive()
    }
}

struct Waiting<'a> {
    inner: &'a Inner,
    ticket: u64,
    priority: Priority,
    granted: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if !self.granted {
            self.inner.scheduler.lock().expect("대기열 잠금").leave(self.ticket, self.priority);
            self.inner.changed.notify_waiters();
        }
    }
}

impl KisRest {
    pub fn new(transport: Arc<dyn Transport>, auth: KisAuth) -> Self {
        KisRest(Arc::new(Inner { transport, auth, scheduler: Mutex::default(), changed: Notify::new(), merged: Mutex::default(), stopped: Mutex::default() }))
    }

    pub fn auth(&self) -> &KisAuth {
        &self.0.auth
    }

    pub fn stopped(&self, api: impl Into<KisEndpoint>) -> Option<Failure> {
        self.0.stopped.lock().expect("멈춘 경로 잠금").get(&api.into()).cloned()
    }

    pub async fn call(&self, request: KisRequest) -> Result<KisPage, KisError> {
        if let Some(failure) = self.stopped(request.api) {
            return Err(KisError::Stopped(failure));
        }
        let key = DedupeKey::of(&request);
        let (tx, rx) = oneshot::channel();
        let leads = {
            let mut merged = self.0.merged.lock().expect("합치기 잠금");
            match merged.get_mut(&key) {
                Some(waiters) => {
                    waiters.push(tx);
                    false
                }
                None => {
                    merged.insert(key.clone(), vec![tx]);
                    true
                }
            }
        };
        if leads {
            let inner = self.0.clone();
            tokio::spawn(async move {
                let result = inner.execute(&key, &request).await;
                inner.finish(&key, result);
            });
        }
        rx.await.unwrap_or(Err(KisError::QueueGone))
    }
}

impl Inner {
    fn finish(&self, key: &DedupeKey, result: JobResult) {
        let waiters = self.merged.lock().expect("합치기 잠금").remove(key).unwrap_or_default();
        for waiter in waiters {
            let _ = waiter.send(result.clone());
        }
    }

    fn abandoned(&self, key: &DedupeKey) -> bool {
        self.merged.lock().expect("합치기 잠금").get(key).is_none_or(|waiters| waiters.iter().all(oneshot::Sender::is_closed))
    }

    async fn admit(&self, priority: Priority) -> Instant {
        let ticket = {
            let mut scheduler = self.scheduler.lock().expect("대기열 잠금");
            let ticket = scheduler.next_ticket;
            scheduler.next_ticket += 1;
            scheduler.lanes[priority.lane()].push_back(ticket);
            ticket
        };
        let mut waiting = Waiting { inner: self, ticket, priority, granted: false };
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let decision = self.scheduler.lock().expect("대기열 잠금").decide(ticket, priority, Instant::now());
            match decision {
                Decision::Granted { oldest_in_window } => {
                    waiting.granted = true;
                    self.changed.notify_waiters();
                    return oldest_in_window;
                }
                Decision::WaitUntil(Some(at)) => {
                    tokio::select! {
                        _ = sleep_until(at) => {}
                        _ = &mut notified => {}
                    }
                }
                Decision::WaitUntil(None) => notified.await,
            }
        }
    }

    fn hold_window(&self, oldest_in_window: Instant) {
        self.scheduler.lock().expect("대기열 잠금").window.hold_until_oldest_leaves(oldest_in_window);
        self.changed.notify_waiters();
    }

    fn build(&self, request: &KisRequest, lease: &TokenLease) -> HttpRequest {
        let mut headers = self.auth.app_headers();
        headers.push(("authorization", Secret::new(format!("Bearer {}", lease.token.expose()))));
        headers.push(("tr_id", Secret::new(request.api.tr_id().to_owned())));
        headers.push(("custtype", Secret::new(CUSTOMER_TYPE_PERSONAL.to_owned())));
        headers.push(("tr_cont", Secret::new(if request.next_page { "N" } else { "" }.to_owned())));
        let method = if request.body.is_some() { Method::Post } else { Method::Get };
        HttpRequest { method, path: request.api.path(), headers, query: request.query.clone(), body: request.body.clone() }
    }

    async fn execute(&self, key: &DedupeKey, request: &KisRequest) -> JobResult {
        let mut rate_limited = 0_u8;
        let mut reissued = false;
        loop {
            if self.abandoned(key) {
                return Err(KisError::QueueGone);
            }
            if request.once.as_ref().is_some_and(|once| !(once.admit)()) {
                return Err(KisError::NotAdmitted);
            }
            let _ = self.auth.token().await?;
            let oldest_in_window = self.admit(request.priority).await;
            let lease = self.auth.token().await?;
            if request.once.as_ref().is_some_and(|once| !(once.admit)()) {
                return Err(KisError::NotAdmitted);
            }
            if let Some(once) = &request.once {
                once.transmitted.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let response = self.transport.send(self.build(request, &lease)).await.map_err(KisError::Transport)?;
            let Some(failure) = judge_market(response.status, &response.body) else {
                let more = response.tr_cont.as_deref().is_some_and(|flag| MORE_PAGES.contains(&flag));
                return Ok(KisPage { body: response.body.into(), more });
            };
            tracing::warn!(api = ?request.api, category = ?failure.category(), code = failure.code(), status = failure.status(), "한투가 요청을 받아들이지 않았습니다");
            match failure.policy() {
                Policy::RetryAtWindowEnd => {
                    rate_limited += 1;
                    if rate_limited >= MAX_RATE_LIMITED {
                        return Err(KisError::Failed(failure));
                    }
                    self.hold_window(oldest_in_window);
                }
                Policy::ReissueOnce | Policy::HaltPath if request.once.is_some() => {
                    if failure.policy() == Policy::ReissueOnce {
                        self.auth.invalidate(lease.generation);
                    }
                    return Err(KisError::Failed(failure));
                }
                Policy::ReissueOnce if !reissued => {
                    reissued = true;
                    self.auth.invalidate(lease.generation);
                }
                Policy::ReissueOnce if self.auth.is_supplied() => {
                    self.auth.invalidate(lease.generation);
                    return Err(KisError::Failed(failure));
                }
                Policy::ReissueOnce | Policy::HaltAll => {
                    self.auth.halt(failure.clone());
                    return Err(KisError::Stopped(failure));
                }
                Policy::HaltPath => {
                    self.stopped.lock().expect("멈춘 경로 잠금").insert(request.api, failure.clone());
                    return Err(KisError::Stopped(failure));
                }
                Policy::WaitIssueInterval | Policy::FailRequest | Policy::FailRegistration | Policy::CloseSession => return Err(KisError::Failed(failure)),
            }
        }
    }
}
