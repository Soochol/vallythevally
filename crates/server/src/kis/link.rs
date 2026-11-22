use std::sync::{Arc, Mutex};

use domain::KstTime;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::sync::watch;

use super::auth::Halt;
use super::error::Category;
use super::rest::{KisError, KisRest};
use crate::clock::Clock;
use crate::kiwoom::link::{ConnectStep, LinkFailure, LinkState, Problem};

pub trait SourceDuty: Send + Sync + 'static {
    fn load_symbols(&self) -> BoxFuture<'static, Result<(), KisError>>;
    fn open_realtime(&self) -> BoxFuture<'static, Result<(), KisError>>;
}

#[derive(Clone)]
pub struct KisLane {
    pub rest: KisRest,
    pub link: KisLink,
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
        KisError::Transport(_) | KisError::QueueGone => (Problem::Network, None),
        KisError::BadTokenResponse => (Problem::AuthUncertain, None),
    };
    LinkFailure { problem, retry_at, message: error.to_string() }
}

impl KisLink {
    pub fn new(rest: KisRest, clock: Clock) -> KisLink {
        let link = KisLink(Arc::new(Inner { rest, clock, state: watch::channel(LinkState::Disconnected).0, flight: Mutex::new(None), epoch: watch::channel(0).0, duty: Mutex::new(None) }));
        link.0.state.send_replace(link.resting_state());
        link.watch_halts();
        link
    }

    pub fn lane(rest: KisRest, clock: Clock) -> KisLane {
        KisLane { link: KisLink::new(rest.clone(), clock), rest }
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
            if let Err(error) = duty.load_symbols().await {
                return self.fail(&error, epoch);
            }
            self.step(epoch, LinkState::Connecting(ConnectStep::Realtime))?;
            if let Err(error) = duty.open_realtime().await {
                return self.fail(&error, epoch);
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
        let state = LinkState::Failed(failure_of(error));
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
