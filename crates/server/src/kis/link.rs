use std::sync::{Arc, Mutex};

use domain::KstTime;
use futures::future::BoxFuture;
use tokio::sync::watch;

use super::auth::{AuthError, Halt};
use super::error::Category;
use super::notice::{KisNotices, NoticeConnect};
use super::rest::{KisError, KisRest};
use crate::clock::{Clock, next_daily};
use crate::kiwoom::auth::DAILY_REISSUE_AT;
use crate::market_source::link::{
    ConnectStep, DAILY_TOKEN_GIVE_UP_AT, Flight, LinkEngine, LinkFailure, LinkState, Problem, ReissueAttempt, Stale,
    retry_reissue_until, spawn_halt_watcher, spawn_token_refresher,
};

pub trait SourceDuty: Send + Sync + 'static {
    fn load_symbols(&self) -> BoxFuture<'static, Result<(), LinkFailure>>;
    fn open_realtime(&self) -> BoxFuture<'static, Result<(), LinkFailure>>;
}

const EXPIRY_REISSUE_LEAD_SECS: i64 = 10 * 60;
const IN_USE_ELSEWHERE_MESSAGE: &str = "한투 실시간 접속을 다른 곳에서 쓰고 있어 끊었습니다(OPSP8996). 다른 프로그램의 한투 실시간 연결을 끈 뒤 다시 연결하세요";

#[derive(Clone)]
pub struct KisLane {
    pub rest: KisRest,
    pub link: KisLink,
    pub notices: KisNotices,
}

enum Decision {
    Done(LinkState),
    WaitUntil(KstTime),
    Proceed,
}

struct Inner {
    rest: KisRest,
    clock: Clock,
    engine: LinkEngine<()>,
    duty: Mutex<Option<Arc<dyn SourceDuty>>>,
}

#[derive(Clone)]
pub struct KisLink(Arc<Inner>);

fn failure_of_halt(halt: &Halt) -> LinkFailure {
    match halt {
        Halt::Rejected(failure) => LinkFailure { problem: Problem::KeyNeedsCheck, retry_at: None, message: failure.to_string() },
        Halt::TokenFileUnreadable(e) => LinkFailure { problem: Problem::TokenFileUnusable, retry_at: None, message: format!("한투 토큰 파일: {e}") },
    }
}

fn failure_of(error: &KisError) -> LinkFailure {
    let (problem, retry_at) = match error {
        KisError::Gated { until } => (Problem::IssueIntervalWait, Some(*until)),
        KisError::Stopped(failure) | KisError::Failed(failure) => match failure.category() {
            Category::AuthBlocked => (Problem::KeyNeedsCheck, None),
            Category::TokenInvalid | Category::IssueLimited => (Problem::AuthUncertain, None),
            Category::RateLimited | Category::SeatsExceeded | Category::InUseElsewhere => (Problem::Network, None),
            Category::BusinessRejected | Category::Unknown => (Problem::PathStopped, None),
        },
        KisError::TokenFile(_) => (Problem::TokenFileUnusable, None),
        KisError::Transport(_) | KisError::QueueGone | KisError::NotAdmitted => (Problem::Network, None),
        KisError::BadTokenResponse => (Problem::AuthUncertain, None),
    };
    LinkFailure { problem, retry_at, message: error.to_string() }
}

impl KisLink {
    pub fn new(rest: KisRest, clock: Clock) -> KisLink {
        let link = KisLink(Arc::new(Inner {
            rest,
            clock,
            engine: LinkEngine::new(LinkState::Disconnected),
            duty: Mutex::new(None),
        }));
        link.0.engine.set(link.resting_state());
        link.watch_halts();
        link.keep_token_fresh();
        link
    }

    pub fn lane(rest: KisRest, clock: Clock) -> KisLane {
        KisLink::lane_with_notices(rest, clock, None)
    }

    pub fn lane_with_notices(rest: KisRest, clock: Clock, connect: Option<NoticeConnect>) -> KisLane {
        let link = KisLink::new(rest.clone(), clock);
        let notices = KisNotices::new(connect, rest.auth().clone(), link.subscribe());
        KisLane { link, rest, notices }
    }

    pub fn same(&self, other: &KisLink) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub fn set_duty(&self, duty: Option<Arc<dyn SourceDuty>>) {
        *self.0.duty.lock().expect("의무 잠금") = duty;
    }

    fn duty(&self) -> Option<Arc<dyn SourceDuty>> {
        self.0.duty.lock().expect("의무 잠금").clone()
    }

    fn watch_halts(&self) {
        let halted = self.0.rest.auth().watch_halted();
        spawn_halt_watcher(Arc::downgrade(&self.0), halted, |inner| KisLink(inner).stop_for_halt());
    }

    fn keep_token_fresh(&self) {
        spawn_token_refresher(
            Arc::downgrade(&self.0),
            self.0.clock.clone(),
            KisLink::next_token_check_of,
            |inner| Box::pin(async move { KisLink(inner).refresh_token_if_due().await }),
        );
    }

    fn next_token_check_of(inner: &Inner) -> KstTime {
        let now = inner.clock.now();
        let daily = next_daily(now, DAILY_REISSUE_AT);
        match inner.rest.auth().token_expires_at().map(|expires| expires.plus_secs(-EXPIRY_REISSUE_LEAD_SECS)).filter(|before_expiry| *before_expiry > now) {
            Some(before_expiry) => daily.min(before_expiry),
            None => daily,
        }
    }

    async fn refresh_token_if_due(&self) {
        let auth = self.0.rest.auth();
        let now = self.0.clock.now();
        let near_expiry = auth.token_expires_at().is_some_and(|expires| expires.unix() - now.unix() <= EXPIRY_REISSUE_LEAD_SECS);
        if !self.is_connected() || auth.halted().is_some() || !(near_expiry || auth.due_daily_reissue(now, DAILY_REISSUE_AT)) {
            return;
        }
        let deadline = next_daily(now, DAILY_TOKEN_GIVE_UP_AT);
        let ok = retry_reissue_until(&self.0.clock, deadline, || self.is_connected(), || {
            let auth = self.0.rest.auth().clone();
            let now = self.0.clock.now();
            Box::pin(async move {
                match auth.reissue().await {
                    Ok(_) => {
                        tracing::info!("한투 토큰을 새로 받았습니다");
                        ReissueAttempt::Done
                    }
                    Err(AuthError::IssueInterval { retry_at }) => ReissueAttempt::RetryAt(retry_at),
                    Err(AuthError::Transport(e)) => {
                        tracing::warn!(error = %e, "한투 토큰을 다시 받지 못했습니다");
                        ReissueAttempt::RetryAt(now)
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "한투 토큰을 다시 받지 못했습니다. 다시 받지 않습니다");
                        ReissueAttempt::Stop
                    }
                }
            })
        })
        .await;
        if !ok && self.is_connected() && self.0.clock.now() >= deadline {
            tracing::error!("한투 토큰을 07:45까지 다시 받지 못했습니다");
        }
    }

    pub fn fail_in_use_elsewhere(&self) {
        self.0.engine.abandon(|| self.0.engine.set(LinkState::Failed(LinkFailure { problem: Problem::Network, retry_at: None, message: IN_USE_ELSEWHERE_MESSAGE.into() })));
    }

    fn stop_for_halt(&self) {
        self.0.engine.stop_for_halt(|| self.resting_state(), || {});
    }

    pub fn state(&self) -> LinkState {
        self.0.engine.state()
    }

    pub fn subscribe(&self) -> watch::Receiver<LinkState> {
        self.0.engine.subscribe()
    }

    pub async fn settled(&self) -> LinkState {
        self.0.engine.settled().await
    }

    pub fn is_connected(&self) -> bool {
        self.0.engine.is_connected()
    }

    pub fn kept_disconnected(&self) -> bool {
        self.0.rest.auth().kept_disconnected()
    }

    fn resting_state(&self) -> LinkState {
        match self.0.rest.auth().halted() {
            Some(halt) => LinkState::Failed(failure_of_halt(&halt)),
            None => LinkState::Disconnected,
        }
    }

    pub async fn connect(&self) -> LinkState {
        self.join_or_start().await
    }

    fn join_or_start(&self) -> Flight {
        let link = self.clone();
        self.0
            .engine
            .join_or_start((), move |epoch| {
                Box::pin(async move {
                    let outcome = link.connect_steps(epoch).await.unwrap_or_else(|Stale| link.state());
                    link.0.engine.clear_flight_if_current(epoch);
                    outcome
                })
            })
            .1
    }

    async fn connect_steps(&self, epoch: u64) -> Result<LinkState, Stale> {
        let auth = self.0.rest.auth();
        loop {
            match self.decide(epoch)? {
                Decision::Done(state) => return Ok(state),
                Decision::WaitUntil(until) => {
                    self.0.engine.sleep_until_or_aborted(&self.0.clock, until, epoch).await?;
                    continue;
                }
                Decision::Proceed => {}
            }
            if !auth.has_usable_token() {
                self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::Token))?;
                match auth.token().await.map_err(KisError::from) {
                    Ok(_) => {}
                    Err(KisError::Gated { until }) => {
                        self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::IssueInterval(until)))?;
                        self.0.engine.sleep_until_or_aborted(&self.0.clock, until, epoch).await?;
                        continue;
                    }
                    Err(error) => return self.fail(&error, epoch),
                }
            }
            break;
        }
        if let Some(duty) = self.duty() {
            self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::Symbols))?;
            if let Err(failure) = duty.load_symbols().await {
                return self.fail_with(failure, epoch);
            }
            self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::Realtime))?;
            if let Err(failure) = duty.open_realtime().await {
                return self.fail_with(failure, epoch);
            }
        }
        let mut outcome = LinkState::Connected;
        self.0.engine.publish(epoch, || {
            if let Some(halt) = auth.halted() {
                outcome = LinkState::Failed(failure_of_halt(&halt));
            }
            self.0.engine.set(outcome.clone());
        })?;
        if outcome == LinkState::Connected {
            auth.clear_disconnected();
        }
        Ok(outcome)
    }

    fn decide(&self, epoch: u64) -> Result<Decision, Stale> {
        let auth = self.0.rest.auth();
        if self.0.engine.aborted(epoch) {
            return Err(Stale);
        }
        if self.is_connected() {
            return Ok(Decision::Done(LinkState::Connected));
        }
        self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::CheckingKey))?;
        if let Some(halt) = auth.halted() {
            return self.0.engine.finish(epoch, LinkState::Failed(failure_of_halt(&halt))).map(Decision::Done);
        }
        if !auth.has_usable_token() && let Some(until) = auth.issue_blocked_until() {
            self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::IssueInterval(until)))?;
            return Ok(Decision::WaitUntil(until));
        }
        Ok(Decision::Proceed)
    }

    fn fail(&self, error: &KisError, epoch: u64) -> Result<LinkState, Stale> {
        tracing::warn!(error = %error, "한투에 연결하지 못했습니다");
        self.fail_with(failure_of(error), epoch)
    }

    fn fail_with(&self, failure: LinkFailure, epoch: u64) -> Result<LinkState, Stale> {
        self.0.engine.finish(epoch, LinkState::Failed(failure))
    }

    pub fn connect_at_start(&self) {
        let auth = self.0.rest.auth();
        if auth.halted().is_some() {
            return;
        }
        if auth.kept_disconnected() {
            tracing::info!("사용자가 연결을 끊어 둔 한투 키라 켤 때 연결하지 않습니다");
            return;
        }
        tracing::info!("한투 키가 있어 한투에 저절로 연결합니다");
        self.connect_in_background();
    }

    pub fn connect_in_background(&self) {
        drop(self.join_or_start());
    }

    pub async fn connect_until_waiting(&self) -> LinkState {
        self.0.engine.connect_until_waiting(self.connect()).await
    }

    pub fn disconnect_by_user(&self) {
        self.0.engine.abandon(|| {
            self.0.rest.auth().keep_disconnected();
            self.0.engine.set(self.resting_state());
        });
    }

    pub fn disconnect(&self) {
        self.0.engine.abandon(|| self.0.engine.set(self.resting_state()));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use domain::KstDate;
    use futures::future::BoxFuture;

    use super::*;
    use crate::clock::kst;
    use crate::config::{KisCredentials, Secret};
    use crate::kis::auth::KisAuth;
    use crate::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};

    #[derive(Default)]
    struct CountingIssue(AtomicUsize);

    impl Transport for CountingIssue {
        fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
            assert_eq!(req.path, "/oauth2/tokenP");
            let count = self.0.fetch_add(1, Ordering::SeqCst) + 1;
            let body = format!(r#"{{"access_token":"FAKE-KIS-TOKEN-daily-{count}","expires_in":86400}}"#);
            Box::pin(async move { Ok(HttpResponse { status: 200, tr_cont: None, body }) })
        }
    }

    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn a_connected_kis_key_reissues_its_token_at_twenty_oh_five_and_a_disconnected_one_does_not() {
        for connected in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let clock = Clock::fake(kst(KstDate::new(2026, 11, 23).unwrap(), 19, 0, 0));
            let transport = Arc::new(CountingIssue::default());
            let credentials = KisCredentials { app_key: Secret::new("FAKE-KIS-APPKEY-daily".into()), app_secret: Secret::new("FAKE-KIS-SECRET-daily".into()) };
            let auth = KisAuth::new(credentials, dir.path().join("state/vallythevally/kis-token.json"), transport.clone(), clock.clone());
            let link = KisLink::new(KisRest::new(transport.clone(), auth), clock.clone());
            assert_eq!(link.connect().await, LinkState::Connected);
            if !connected {
                link.disconnect_by_user();
            }
            settle().await;
            clock.jump(66 * 60);
            settle().await;
            tokio::time::sleep(Duration::from_millis(20)).await;
            settle().await;
            assert_eq!(transport.0.load(Ordering::SeqCst), if connected { 2 } else { 1 }, "연결된 키만 20:05에 다시 받는다(연결됨={connected})");
        }
    }
}
