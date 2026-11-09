//! 키움 조회 대기열(backend.md §4.2, §4.3). 서버 전체의 키움 REST 요청은 여기 한 곳에서 나간다.
//!
//! - 보내는 시각 사이를 260ms 넘게 띄운다. 토큰 발급, 다시 보내기, 연속조회 페이지도 같은 간격을 따른다.
//! - 토큰 발급이 먼저 나가고, 그다음 `Screen` > `Recovery` > `Background` 순서다.
//! - 토큰은 보내는 순간에 읽는다(D16). 대기 중인 요청은 토큰을 쥐고 있지 않다.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{Notify, oneshot};
use tokio::time::Instant;

use super::api::{ApiId, MarketRequest};
use super::auth::{AuthError, Halt, KiwoomAuth, MIN_ISSUE_INTERVAL_SECS, TokenGen};
use super::error::{self, Category, Failure, Note, Retry, Stop};
use super::token_file::FileError;
use super::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use super::wire::TokenResponse;
use crate::clock::Clock;
use crate::config::Secret;
use domain::KstTime;

pub const SEND_SPACING: Duration = Duration::from_millis(260);
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(1);
const MAX_RATE_LIMITED: u8 = 3;
const SCREEN_RETRY_DELAYS: &[Duration] = &[Duration::from_millis(500)];
const OTHER_RETRY_DELAYS: &[Duration] = &[Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
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
pub struct MergeScope(pub u64);

#[derive(Debug)]
pub struct Page<T> {
    pub body: T,
    pub next: Option<ContKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KiwoomError {
    Failed(Failure),
    IssueTooSoon { until: KstTime },
    TokenFile(FileError),
}

impl KiwoomError {
    pub fn failure(&self) -> Option<&Failure> {
        match self {
            KiwoomError::Failed(f) => Some(f),
            KiwoomError::IssueTooSoon { .. } | KiwoomError::TokenFile(_) => None,
        }
    }

    pub fn outer_retry(&self) -> bool {
        match self {
            KiwoomError::Failed(f) => f.policy().outer_retry,
            KiwoomError::IssueTooSoon { .. } => true,
            KiwoomError::TokenFile(_) => false,
        }
    }
}

impl fmt::Display for KiwoomError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KiwoomError::Failed(failure) => failure.fmt(f),
            KiwoomError::IssueTooSoon { until } => write!(
                f,
                "키움 토큰은 발급 사이를 {}분 띄웁니다. {until}부터 다시 받으니 그 뒤에 다시 시도하세요",
                MIN_ISSUE_INTERVAL_SECS / 60
            ),
            KiwoomError::TokenFile(e) => write!(
                f,
                "토큰 파일을 쓸 수 없어 키움 토큰을 발급하지 않습니다({e}). 파일을 고치거나, 마지막 발급 요청에서 {}분이 지난 뒤 지우고 서버를 다시 켜세요",
                MIN_ISSUE_INTERVAL_SECS / 60
            ),
        }
    }
}

impl std::error::Error for KiwoomError {}

impl From<Halt> for KiwoomError {
    fn from(h: Halt) -> Self {
        match h {
            Halt::Rejected(failure) => KiwoomError::Failed(failure),
            Halt::TokenFileUnreadable(e) => KiwoomError::TokenFile(e),
        }
    }
}

#[derive(Clone)]
struct RawPage {
    body: Arc<str>,
    next: Option<ContKey>,
}

type JobResult = Result<RawPage, KiwoomError>;

/// 같은 요청 합치기의 키: (합치기 범위, api-id, 정규화한 본문, 연속조회 키).
#[derive(Clone, PartialEq, Eq, Hash)]
struct DedupeKey {
    scope: MergeScope,
    api_id: ApiId,
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

struct Job {
    key: DedupeKey,
    priority: Priority,
    state: JobState,
    waiters: Vec<oneshot::Sender<JobResult>>,
    rate_limited: u8,
    transport_failures: usize,
    resent_after_invalid_token: bool,
}

#[derive(Default)]
struct Queue {
    lanes: [VecDeque<u64>; 3],
    jobs: HashMap<u64, Job>,
    by_key: HashMap<DedupeKey, u64>,
    issue_waiters: Vec<oneshot::Sender<Result<TokenGen, KiwoomError>>>,
    last_send: Option<Instant>,
    pause_until: Option<Instant>,
    next_id: u64,
    stopped_paths: HashMap<ApiId, Failure>,
    failed_once: HashSet<ApiId>,
}

impl Queue {
    fn has_market_work(&self) -> bool {
        self.lanes.iter().any(|l| !l.is_empty())
    }

    fn requeue_front(&mut self, id: u64) {
        if let Some(job) = self.jobs.get_mut(&id) {
            job.state = JobState::Queued;
            self.lanes[job.priority.lane()].push_front(id);
        }
    }

    fn finish(&mut self, id: u64, result: JobResult) {
        if let Some(job) = self.jobs.remove(&id) {
            self.by_key.remove(&job.key);
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
            self.finish(id, Err(KiwoomError::Failed(failure.clone())));
        }
    }

    fn stopped(&self, api_id: ApiId) -> Option<KiwoomError> {
        self.stopped_paths.get(&api_id).cloned().map(KiwoomError::Failed)
    }
}

struct Inner {
    transport: Arc<dyn Transport>,
    auth: KiwoomAuth,
    clock: Clock,
    queue: Mutex<Queue>,
    wake: Notify,
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
        let inner = Arc::new(Inner { transport, auth, clock, queue: Mutex::new(Queue::default()), wake: Notify::new() });
        tokio::spawn(run(inner.clone()));
        KiwoomRest(inner)
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

    pub fn blocked(&self) -> Option<KiwoomError> {
        let auth = &self.0.auth;
        let now = self.0.clock.now();
        self.halted().or_else(|| {
            if !auth.needs_issue(now) {
                return None;
            }
            self.stopped(ApiId::Au10001).or_else(|| Some(KiwoomError::IssueTooSoon { until: auth.issue_blocked_until(now)? }))
        })
    }

    pub fn stopped(&self, api_id: ApiId) -> Option<KiwoomError> {
        self.0.lock().stopped(api_id)
    }

    /// 토큰을 새로 받는다. 서버를 켤 때와 매일 20:05에만 부른다.
    pub async fn issue_token(&self) -> Result<TokenGen, KiwoomError> {
        let (tx, rx) = oneshot::channel();
        self.0.lock().issue_waiters.push(tx);
        self.0.wake.notify_one();
        rx.await.unwrap_or_else(|_| Err(queue_gone(ApiId::Au10001)))
    }

    /// 한 페이지를 받는다. `cont`가 있으면 그 연속조회 키로 다음 페이지를 받는다.
    pub async fn call<R: MarketRequest>(
        &self,
        req: &R,
        cont: Option<&ContKey>,
        priority: Priority,
        scope: MergeScope,
    ) -> Result<Page<R::Response>, KiwoomError> {
        let key = DedupeKey {
            scope,
            api_id: R::API_ID,
            body: serde_json::to_string(req).expect("요청 타입은 언제나 직렬화된다"),
            cont: cont.cloned(),
        };
        let rx = self.0.enqueue(key, priority);
        let raw = rx.await.unwrap_or_else(|_| Err(queue_gone(R::API_ID)))?;
        match serde_json::from_str::<R::Response>(&raw.body) {
            Ok(body) => Ok(Page { body, next: raw.next }),
            Err(e) => {
                let note = Note::Schema { line: e.line(), column: e.column() };
                tracing::error!(api_id = R::API_ID.as_str(), %note, "키움 응답을 읽지 못했습니다");
                let failure = Failure::protocol(R::API_ID, note);
                self.0.stop(&mut self.0.lock(), &failure);
                Err(KiwoomError::Failed(failure))
            }
        }
    }
}

fn queue_gone(api_id: ApiId) -> KiwoomError {
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

    fn enqueue(&self, key: DedupeKey, priority: Priority) -> oneshot::Receiver<JobResult> {
        let (tx, rx) = oneshot::channel();
        let mut q = self.lock();
        if let Some(err) = q.stopped(key.api_id) {
            let _ = tx.send(Err(err));
            return rx;
        }
        if let Some(&id) = q.by_key.get(&key) {
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
            q.by_key.insert(key.clone(), id);
            q.jobs.insert(
                id,
                Job {
                    key,
                    priority,
                    state: JobState::Queued,
                    waiters: vec![tx],
                    rate_limited: 0,
                    transport_failures: 0,
                    resent_after_invalid_token: false,
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
        if let Some(err) = q.stopped(ApiId::Au10001).filter(|_| market_needs_token || !q.issue_waiters.is_empty()) {
            for w in q.issue_waiters.drain(..) {
                let _ = w.send(Err(err.clone()));
            }
            if market_needs_token {
                q.fail_queued(&err);
                has_market = false;
            }
        }
        if let Some(until) = self.auth.issue_blocked_until(now_kst).filter(|_| market_needs_token || !q.issue_waiters.is_empty()) {
            let err = KiwoomError::IssueTooSoon { until };
            tracing::warn!(%until, "마지막 토큰 발급 요청에서 10분이 지나지 않아 발급하지 않습니다");
            for w in q.issue_waiters.drain(..) {
                let _ = w.send(Err(err.clone()));
            }
            if market_needs_token {
                q.fail_queued(&err);
                has_market = false;
            }
        }
        let wants_issue = !q.issue_waiters.is_empty() || (has_market && self.auth.needs_issue(now_kst));
        if !wants_issue && !has_market {
            return Step::Idle;
        }
        let now = Instant::now();
        let ready = q.last_send.map(|t| t + SEND_SPACING).into_iter().chain(q.pause_until).max();
        if let Some(r) = ready.filter(|&r| r > now) {
            return Step::Wait(r);
        }
        q.last_send = Some(now);
        if wants_issue {
            return Step::Issue;
        }
        let Some(id) = q.lanes.iter_mut().find_map(VecDeque::pop_front) else {
            return Step::Again;
        };
        let Some((token, generation)) = self.auth.current(now_kst) else {
            q.requeue_front(id);
            return Step::Again;
        };
        let api_id = q.jobs.get(&id).expect("대기열의 id는 jobs에 있다").key.api_id;
        if let Some(err) = q.stopped(api_id) {
            q.finish(id, Err(err));
            return Step::Again;
        }
        let job = q.jobs.get_mut(&id).expect("대기열의 id는 jobs에 있다");
        job.state = JobState::InFlight;
        let req = HttpRequest {
            api_id: job.key.api_id,
            token: Some(token),
            cont: job.key.cont.clone(),
            body: Secret::new(job.key.body.clone()),
        };
        Step::Send { id, req, generation, priority: job.priority }
    }

    async fn issue(&self) {
        let outcome = match self.auth.begin_issue(self.clock.now()) {
            Ok(body) => {
                let started = Instant::now();
                let res = self.transport.send(HttpRequest { api_id: ApiId::Au10001, token: None, cont: None, body }).await;
                self.judge_issue(res, started)
            }
            Err(e) => {
                tracing::error!(error = %e, "토큰 파일에 발급 요청 시각을 쓰지 못해 발급 요청을 보내지 않습니다");
                Err(KiwoomError::TokenFile(e))
            }
        };
        let mut q = self.lock();
        match &outcome {
            Ok(_) => {
                q.failed_once.remove(&ApiId::Au10001);
            }
            Err(e) => {
                if let Some(f) = e.failure() {
                    if f.category() == Category::RateLimit {
                        q.pause_until = Some(Instant::now() + RATE_LIMIT_PAUSE);
                    }
                    self.stop(&mut q, f);
                }
                q.fail_queued(e);
            }
        }
        for w in q.issue_waiters.drain(..) {
            let _ = w.send(outcome.clone());
        }
    }

    fn stop(&self, q: &mut Queue, failure: &Failure) {
        let api_id = failure.api_id();
        match failure.policy().stop {
            Stop::Nothing => {}
            Stop::Everything => {
                tracing::error!(api_id = api_id.as_str(), "{failure}");
                self.auth.halt(failure.clone());
            }
            Stop::PathOnRepeat if q.failed_once.insert(api_id) => {
                tracing::warn!(api_id = api_id.as_str(), "{failure}. 다음 발급도 같은 범주로 실패하면 발급을 멈춥니다");
            }
            Stop::Path | Stop::PathOnRepeat => {
                tracing::error!(api_id = api_id.as_str(), "{failure}");
                q.stop_path(failure);
            }
        }
    }

    /// au10001 응답 판정. 본문에는 토큰이 있으므로 로그에 남기지 않는다.
    fn judge_issue(&self, res: Result<HttpResponse, TransportError>, started: Instant) -> Result<TokenGen, KiwoomError> {
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let resp = match res {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(api_id = "au10001", elapsed_ms, error = %e, "토큰 발급 요청이 키움에 닿지 못했습니다");
                return Err(KiwoomError::Failed(Failure::transport(ApiId::Au10001, e)));
            }
        };
        let judged = error::judge(ApiId::Au10001, resp.status, &resp.body);
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
        judged.map_err(KiwoomError::Failed)?;
        let bad_token = || KiwoomError::Failed(Failure::protocol(ApiId::Au10001, Note::BadTokenResponse));
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
        match outcome {
            Ok(page) => q.finish(id, Ok(page)),
            Err(failure) => self.market_failed(&mut q, id, generation, failure),
        }
        drop(q);
        self.wake.notify_one();
    }

    fn market_failed(self: &Arc<Self>, q: &mut Queue, id: u64, generation: TokenGen, failure: Failure) {
        let api_id = failure.api_id().as_str();
        match failure.category() {
            Category::RateLimit => {
                tracing::warn!(api_id, "요청 개수 초과. 260ms 간격이 모자랐습니다. 대기열을 1초 멈춥니다");
                q.pause_until = Some(Instant::now() + RATE_LIMIT_PAUSE);
            }
            Category::InvalidRequest | Category::BatchLimit => tracing::error!(api_id, "{failure}. 우리 코드의 버그입니다"),
            _ => {}
        }
        self.stop(q, &failure);
        let job = q.jobs.get_mut(&id).expect("send_market이 확인했다");
        let resend = match failure.policy().retry {
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
                self.auth.halt(failure.clone());
                false
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
            q.finish(id, Err(KiwoomError::Failed(failure)));
        }
    }
}

fn judge_market(api_id: ApiId, priority: Priority, res: Result<HttpResponse, TransportError>, started: Instant) -> Result<RawPage, Failure> {
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
        "키움 조회"
    );
    judged.map(|()| RawPage { body: resp.body.into(), next: resp.next_key.map(ContKey) })
}

#[cfg(test)]
pub mod testing {
    //! 가짜 전송. 보낸 요청을 기록하고, 응답은 테스트가 준 함수가 만든다.

    use std::sync::Mutex;
    use std::time::Duration;

    use futures::future::BoxFuture;
    use tokio::time::Instant;

    use super::super::api::ApiId;
    use super::super::transport::{HttpRequest, HttpResponse, Transport, TransportError};

    #[derive(Debug, Clone)]
    pub struct Sent {
        pub at: Instant,
        pub api_id: ApiId,
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
        file.save(&Saved { credential: Some(credential_id("k")), token: Some(token), last_request_at: an_hour_ago }).unwrap();
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

    fn assert_at_most_4_per_second(sent: &[Sent]) {
        for (i, a) in sent.iter().enumerate() {
            let in_window = sent[i..].iter().take_while(|b| b.at.duration_since(a.at) <= Duration::from_secs(1)).count();
            assert!(in_window <= 4, "{}번째 전송부터 1초 안에 {in_window}번", i);
        }
        for w in sent.windows(2) {
            assert!(w[1].at.duration_since(w[0].at) >= SEND_SPACING);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn spacing_holds_across_token_retries_and_continuations() {
        let tokens = token_counter();
        let failures = AtomicUsize::new(0);
        let fake = Arc::new(FakeTransport::new(Duration::from_millis(30), move |s| {
            if let Some(t) = tokens(s) {
                return t;
            }
            if s.cont.as_deref() == Some("k3") && failures.fetch_add(1, Ordering::SeqCst) < 1 {
                return status(503, json!({}));
            }
            if s.cont.as_deref() == Some("k5") && failures.fetch_add(1, Ordering::SeqCst) < 2 {
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
        assert_at_most_4_per_second(&sent);
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
    async fn rate_limit_pauses_the_whole_queue_and_fails_after_three() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            if let Some(t) = tokens(s) {
                return t;
            }
            if s.cont.as_deref() == Some("k0") {
                return status(429, json!({"return_code": 5, "return_msg": "허용된 요청 개수를 초과하였습니다[1700:유량=5]"}));
            }
            list_ok()
        }));
        let rest = rest(&fake);
        let (a, b) = tokio::join!(
            call_k(&rest, 0, Priority::Screen),
            call_k(&rest, 1, Priority::Screen)
        );
        assert_eq!(category(a.err()), Some(Category::RateLimit));
        assert!(b.is_ok());
        let sent = fake.market_sent();
        let k0: Vec<_> = sent.iter().filter(|s| s.cont.as_deref() == Some("k0")).collect();
        assert_eq!(k0.len(), 3);
        let first = k0[0].at;
        let after: Vec<_> = sent.iter().filter(|s| s.at > first).collect();
        assert!(after.iter().all(|s| s.at.duration_since(first) >= RATE_LIMIT_PAUSE), "429 뒤 1초 동안 아무것도 나가지 않는다");
        assert_eq!(after[0].cont.as_deref(), Some("k0"), "같은 요청을 맨 앞에 다시 넣는다");
    }

    #[tokio::test(start_paused = true)]
    async fn the_third_rate_limit_also_pauses_the_whole_queue() {
        let tokens = token_counter();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            if let Some(t) = tokens(s) {
                return t;
            }
            if s.body.contains("\"0\"") {
                return status(429, json!({"return_code": 5, "return_msg": "허용된 요청 개수를 초과하였습니다[1700:유량=5]"}));
            }
            list_ok()
        }));
        let rest = rest(&fake);
        let scope = MergeScope::default();
        assert_eq!(category(rest.call(&StockList::EXCHANGE, None, Priority::Screen, scope).await.err()), Some(Category::RateLimit));
        rest.call(&StockList::KOSDAQ, None, Priority::Screen, scope).await.unwrap();
        let sent = fake.market_sent();
        assert_eq!(sent.len(), 4);
        assert!(sent[3].at.duration_since(sent[2].at) >= RATE_LIMIT_PAUSE, "세 번째 429 뒤에도 다른 요청을 1초 기다린다");
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
        assert!(matches!(issue, Err(KiwoomError::IssueTooSoon { .. })), "{issue:?}");
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
        assert_eq!(call_k(&rest, 0, Priority::Screen).await.err(), Some(KiwoomError::IssueTooSoon { until }));
        assert_eq!(rest.blocked(), Some(KiwoomError::IssueTooSoon { until }));
        assert_eq!(call_k(&rest, 1, Priority::Screen).await.err(), Some(KiwoomError::IssueTooSoon { until }));
        assert_eq!(rest.issue_token().await.err(), Some(KiwoomError::IssueTooSoon { until }));
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
                tokens(s).unwrap_or_else(|| match s.api_id {
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
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| match s.api_id {
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
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| match s.api_id {
            ApiId::Au10001 => ok(json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8003:토큰 조회 실패]"}), None),
            _ => list_ok(),
        }));
        let rest = rest(&fake);
        assert_eq!(category(call_k(&rest, 0, Priority::Screen).await.err()), Some(Category::AuthIndeterminate));
        assert!(matches!(call_k(&rest, 1, Priority::Screen).await, Err(KiwoomError::IssueTooSoon { .. })));
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
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| match s.api_id {
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
        assert_eq!(category(call_k(&rest, 1, Priority::Background).await.err()), Some(Category::Transient));
        let bg: Vec<_> = fake.market_sent().into_iter().filter(|s| s.cont.as_deref() == Some("k1")).collect();
        assert_eq!(bg.len(), 4);
        let gaps: Vec<u64> = bg.windows(2).map(|w| w[1].at.duration_since(w[0].at).as_secs()).collect();
        assert_eq!(gaps, [1, 2, 4]);
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
}
