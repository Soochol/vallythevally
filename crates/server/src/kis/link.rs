use std::sync::{Arc, Mutex};

use domain::KstTime;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::sync::watch;

use super::auth::{AuthError, Halt};
use super::error::Category;
use super::notice::{KisNotices, NoticeConnect};
use super::rest::{KisError, KisRest};
use crate::clock::Clock;
use crate::kiwoom::auth::DAILY_REISSUE_AT;
use crate::kiwoom::link::{ConnectStep, LinkFailure, LinkState, Problem};

const DAILY_TOKEN_GIVE_UP_AT: domain::TimeOfDay = match domain::TimeOfDay::hms(7, 45, 0) {
    Some(t) => t,
    None => unreachable!(),
};

pub trait SourceDuty: Send + Sync + 'static {
    fn load_symbols(&self) -> BoxFuture<'static, Result<(), LinkFailure>>;
    fn open_realtime(&self) -> BoxFuture<'static, Result<(), LinkFailure>>;
}

const DAILY_TOKEN_RETRY_SECS: i64 = 10 * 60;
const EXPIRY_REISSUE_LEAD_SECS: i64 = 10 * 60;
const IN_USE_ELSEWHERE_MESSAGE: &str = "한투 실시간 접속을 다른 곳에서 쓰고 있어 끊었습니다(OPSP8996). 다른 프로그램의 한투 실시간 연결을 끈 뒤 다시 연결하세요";

#[derive(Clone)]
pub struct KisLane {
    pub rest: KisRest,
    pub link: KisLink,
    pub notices: KisNotices,
}

struct Stale;

enum Decision {
    Done(LinkState),
    WaitUntil(KstTime),
    Proceed,
}

type Flight = Shared<BoxFuture<'static, LinkState>>;

struct Inner {
    rest: KisRest,
    clock: Clock,
    state: watch::Sender<LinkState>,
    flight: Mutex<Option<Flight>>,
    epoch: watch::Sender<u64>,
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
        let link = KisLink(Arc::new(Inner { rest, clock, state: watch::channel(LinkState::Disconnected).0, flight: Mutex::new(None), epoch: watch::channel(0).0, duty: Mutex::new(None) }));
        link.0.state.send_replace(link.resting_state());
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
        let inner = Arc::downgrade(&self.0);
        let mut halted = self.0.rest.auth().watch_halted();
        tokio::spawn(async move {
            while halted.wait_for(Option::is_some).await.is_ok() {
                let Some(inner) = inner.upgrade() else { return };
                KisLink(inner).stop_for_halt();
                if halted.wait_for(Option::is_none).await.is_err() {
                    return;
                }
            }
        });
    }

    fn keep_token_fresh(&self) {
        let inner = Arc::downgrade(&self.0);
        let clock = self.0.clock.clone();
        tokio::spawn(async move {
            loop {
                let wake = {
                    let Some(inner) = inner.upgrade() else { return };
                    KisLink(inner).next_token_check()
                };
                clock.sleep_until(wake).await;
                let Some(inner) = inner.upgrade() else { return };
                KisLink(inner).refresh_token_if_due().await;
            }
        });
    }

    fn next_token_check(&self) -> KstTime {
        let now = self.0.clock.now();
        let daily = crate::clock::next_daily(now, DAILY_REISSUE_AT);
        match self.0.rest.auth().token_expires_at().map(|expires| expires.plus_secs(-EXPIRY_REISSUE_LEAD_SECS)).filter(|before_expiry| *before_expiry > now) {
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
        let deadline = crate::clock::next_daily(now, DAILY_TOKEN_GIVE_UP_AT);
        loop {
            let retry_at = match auth.reissue().await {
                Ok(_) => {
                    tracing::info!("한투 토큰을 새로 받았습니다");
                    return;
                }
                Err(AuthError::IssueInterval { retry_at }) => retry_at,
                Err(AuthError::Transport(e)) => {
                    tracing::warn!(error = %e, "한투 토큰을 다시 받지 못했습니다");
                    self.0.clock.now()
                }
                Err(e) => {
                    tracing::error!(error = %e, "한투 토큰을 다시 받지 못했습니다. 다시 받지 않습니다");
                    return;
                }
            };
            let at = retry_at.max(self.0.clock.now().plus_secs(DAILY_TOKEN_RETRY_SECS));
            if at >= deadline || !self.is_connected() {
                tracing::error!("한투 토큰을 07:45까지 다시 받지 못했습니다");
                return;
            }
            self.0.clock.sleep_until(at).await;
        }
    }

    pub fn fail_in_use_elsewhere(&self) {
        self.abandon_connect(|| self.set(LinkState::Failed(LinkFailure { problem: Problem::Network, retry_at: None, message: IN_USE_ELSEWHERE_MESSAGE.into() })));
    }

    fn stop_for_halt(&self) {
        let mut slot = self.0.flight.lock().expect("연결 잠금");
        if !self.is_connected() {
            if !matches!(self.state(), LinkState::Connecting(_)) {
                self.set(self.resting_state());
            }
            return;
        }
        self.0.epoch.send_modify(|epoch| *epoch += 1);
        slot.take();
        self.set(self.resting_state());
    }

    pub fn state(&self) -> LinkState {
        self.0.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<LinkState> {
        self.0.state.subscribe()
    }

    pub async fn settled(&self) -> LinkState {
        let mut state = self.subscribe();
        match state.wait_for(|state| !matches!(state, LinkState::Connecting(_))).await {
            Ok(settled) => settled.clone(),
            Err(_) => self.state(),
        }
    }

    pub fn is_connected(&self) -> bool {
        *self.0.state.borrow() == LinkState::Connected
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

    fn set(&self, state: LinkState) {
        self.0.state.send_replace(state);
    }

    fn publish(&self, epoch: u64, write: impl FnOnce()) -> Result<(), Stale> {
        let _slot = self.0.flight.lock().expect("연결 잠금");
        if *self.0.epoch.borrow() != epoch {
            return Err(Stale);
        }
        write();
        Ok(())
    }

    fn step(&self, epoch: u64, state: LinkState) -> Result<(), Stale> {
        self.publish(epoch, || self.set(state))
    }

    fn aborted(&self, epoch: u64) -> bool {
        *self.0.epoch.borrow() != epoch
    }

    pub async fn connect(&self) -> LinkState {
        self.join_or_start().await
    }

    fn join_or_start(&self) -> Flight {
        let mut slot = self.0.flight.lock().expect("연결 잠금");
        if let Some(flight) = slot.as_ref() {
            return flight.clone();
        }
        let link = self.clone();
        let epoch = *self.0.epoch.borrow();
        let task = tokio::spawn(async move {
            let outcome = link.connect_steps(epoch).await.unwrap_or_else(|Stale| link.state());
            let mut slot = link.0.flight.lock().expect("연결 잠금");
            if *link.0.epoch.borrow() == epoch {
                slot.take();
            }
            outcome
        });
        let flight = async move { task.await.unwrap_or(LinkState::Disconnected) }.boxed().shared();
        *slot = Some(flight.clone());
        if !self.is_connected() {
            self.set(LinkState::Connecting(ConnectStep::CheckingKey));
        }
        flight
    }

    async fn connect_steps(&self, epoch: u64) -> Result<LinkState, Stale> {
        let auth = self.0.rest.auth();
        loop {
            match self.decide(epoch)? {
                Decision::Done(state) => return Ok(state),
                Decision::WaitUntil(until) => {
                    self.wait_for_issue_interval(until, epoch).await?;
                    continue;
                }
                Decision::Proceed => {}
            }
            if !auth.has_usable_token() {
                self.step(epoch, LinkState::Connecting(ConnectStep::Token))?;
                match auth.token().await.map_err(KisError::from) {
                    Ok(_) => {}
                    Err(KisError::Gated { until }) => {
                        self.step(epoch, LinkState::Connecting(ConnectStep::IssueInterval(until)))?;
                        self.wait_for_issue_interval(until, epoch).await?;
                        continue;
                    }
                    Err(error) => return self.fail(&error, epoch),
                }
            }
            break;
        }
        if let Some(duty) = self.duty() {
            self.step(epoch, LinkState::Connecting(ConnectStep::Symbols))?;
            if let Err(failure) = duty.load_symbols().await {
                return self.fail_with(failure, epoch);
            }
            self.step(epoch, LinkState::Connecting(ConnectStep::Realtime))?;
            if let Err(failure) = duty.open_realtime().await {
                return self.fail_with(failure, epoch);
            }
        }
        let mut outcome = LinkState::Connected;
        self.publish(epoch, || {
            if let Some(halt) = auth.halted() {
                outcome = LinkState::Failed(failure_of_halt(&halt));
            }
            self.set(outcome.clone());
        })?;
        if outcome == LinkState::Connected {
            auth.clear_disconnected();
        }
        Ok(outcome)
    }

    fn decide(&self, epoch: u64) -> Result<Decision, Stale> {
        let auth = self.0.rest.auth();
        if self.aborted(epoch) {
            return Err(Stale);
        }
        if self.is_connected() {
            return Ok(Decision::Done(LinkState::Connected));
        }
        self.step(epoch, LinkState::Connecting(ConnectStep::CheckingKey))?;
        if let Some(halt) = auth.halted() {
            let state = LinkState::Failed(failure_of_halt(&halt));
            self.step(epoch, state.clone())?;
            return Ok(Decision::Done(state));
        }
        if !auth.has_usable_token() && let Some(until) = auth.issue_blocked_until() {
            self.step(epoch, LinkState::Connecting(ConnectStep::IssueInterval(until)))?;
            return Ok(Decision::WaitUntil(until));
        }
        Ok(Decision::Proceed)
    }

    async fn wait_for_issue_interval(&self, until: KstTime, epoch: u64) -> Result<(), Stale> {
        let mut abandoned = self.0.epoch.subscribe();
        tokio::select! {
            () = self.0.clock.sleep_until(until) => {}
            _ = abandoned.wait_for(|current| *current != epoch) => {}
        }
        if self.aborted(epoch) { Err(Stale) } else { Ok(()) }
    }

    fn fail(&self, error: &KisError, epoch: u64) -> Result<LinkState, Stale> {
        tracing::warn!(error = %error, "한투에 연결하지 못했습니다");
        self.fail_with(failure_of(error), epoch)
    }

    fn fail_with(&self, failure: LinkFailure, epoch: u64) -> Result<LinkState, Stale> {
        let state = LinkState::Failed(failure);
        self.step(epoch, state.clone())?;
        Ok(state)
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
        let mut state = self.subscribe();
        let waiting = async {
            let _ = state.wait_for(|state| matches!(state, LinkState::Connecting(ConnectStep::IssueInterval(_)))).await;
        };
        tokio::select! {
            outcome = self.connect() => outcome,
            () = waiting => self.state(),
        }
    }

    fn abandon_connect(&self, then: impl FnOnce()) {
        let mut slot = self.0.flight.lock().expect("연결 잠금");
        self.0.epoch.send_modify(|epoch| *epoch += 1);
        slot.take();
        then();
    }

    pub fn disconnect_by_user(&self) {
        self.abandon_connect(|| {
            self.0.rest.auth().keep_disconnected();
            self.set(self.resting_state());
        });
    }

    pub fn disconnect(&self) {
        self.abandon_connect(|| self.set(self.resting_state()));
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
