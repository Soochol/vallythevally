use std::future::Future;
use std::sync::{Arc, Mutex, Weak};

use domain::{KstTime, TimeOfDay};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::sync::watch;

use crate::clock::Clock;

pub const DAILY_TOKEN_GIVE_UP_AT: TimeOfDay = match TimeOfDay::hms(7, 45, 0) {
    Some(t) => t,
    None => unreachable!(),
};

pub const DAILY_TOKEN_RETRY_SECS: i64 = 10 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectStep {
    CheckingKey,
    Token,
    IssueInterval(KstTime),
    Symbols,
    Realtime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    AuthBlocked8050,
    KeyNeedsCheck,
    IssueIntervalWait,
    AuthUncertain,
    Network,
    TokenFileUnusable,
    PathStopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkFailure {
    pub problem: Problem,
    pub retry_at: Option<KstTime>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    NoKey,
    Disconnected,
    Connecting(ConnectStep),
    Connected,
    Failed(LinkFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stale;

pub type Flight = Shared<BoxFuture<'static, LinkState>>;

pub struct LinkEngine<Meta: Copy + Send + 'static> {
    state: watch::Sender<LinkState>,
    flight: Mutex<Option<(Meta, Flight)>>,
    epoch: watch::Sender<u64>,
}

impl<Meta: Copy + Send + 'static> LinkEngine<Meta> {
    pub fn new(initial: LinkState) -> Self {
        Self {
            state: watch::channel(initial).0,
            flight: Mutex::new(None),
            epoch: watch::channel(0).0,
        }
    }

    pub fn state(&self) -> LinkState {
        self.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<LinkState> {
        self.state.subscribe()
    }

    pub async fn settled(&self) -> LinkState {
        let mut state = self.subscribe();
        match state.wait_for(|state| !matches!(state, LinkState::Connecting(_))).await {
            Ok(settled) => settled.clone(),
            Err(_) => self.state(),
        }
    }

    pub fn is_connected(&self) -> bool {
        *self.state.borrow() == LinkState::Connected
    }

    pub fn epoch(&self) -> u64 {
        *self.epoch.borrow()
    }

    pub fn set(&self, state: LinkState) {
        self.state.send_replace(state);
    }

    pub fn aborted(&self, epoch: u64) -> bool {
        *self.epoch.borrow() != epoch
    }

    pub fn publish(&self, epoch: u64, write: impl FnOnce()) -> Result<(), Stale> {
        let _slot = self.flight.lock().expect("연결 잠금");
        if *self.epoch.borrow() != epoch {
            return Err(Stale);
        }
        write();
        Ok(())
    }

    pub fn with_epoch_lock<R>(&self, epoch: u64, write: impl FnOnce(bool) -> R) -> R {
        let _slot = self.flight.lock().expect("연결 잠금");
        write(*self.epoch.borrow() == epoch)
    }

    pub fn step(&self, epoch: u64, state: LinkState) -> Result<(), Stale> {
        self.publish(epoch, || self.set(state))
    }

    pub fn finish(&self, epoch: u64, state: LinkState) -> Result<LinkState, Stale> {
        self.step(epoch, state.clone())?;
        Ok(state)
    }

    pub fn abandon(&self, then: impl FnOnce()) {
        let mut slot = self.flight.lock().expect("연결 잠금");
        self.epoch.send_modify(|epoch| *epoch += 1);
        slot.take();
        then();
    }

    pub fn stop_for_halt(&self, resting: impl FnOnce() -> LinkState, on_disconnect: impl FnOnce()) {
        let mut slot = self.flight.lock().expect("연결 잠금");
        if !self.is_connected() {
            if !matches!(self.state(), LinkState::Connecting(_)) {
                self.set(resting());
            }
            return;
        }
        self.epoch.send_modify(|epoch| *epoch += 1);
        slot.take();
        on_disconnect();
        self.set(resting());
    }

    pub fn clear_flight_if_current(&self, epoch: u64) {
        let mut slot = self.flight.lock().expect("연결 잠금");
        if *self.epoch.borrow() == epoch {
            slot.take();
        }
    }

    pub fn join_or_start(&self, meta: Meta, launch: impl FnOnce(u64) -> BoxFuture<'static, LinkState>) -> (Meta, Flight) {
        let mut slot = self.flight.lock().expect("연결 잠금");
        if let Some((started_meta, flight)) = slot.as_ref() {
            return (*started_meta, flight.clone());
        }
        let epoch = *self.epoch.borrow();
        let task = tokio::spawn(launch(epoch));
        let flight = async move { task.await.unwrap_or(LinkState::Disconnected) }.boxed().shared();
        *slot = Some((meta, flight.clone()));
        if !self.is_connected() {
            self.set(LinkState::Connecting(ConnectStep::CheckingKey));
        }
        (meta, flight)
    }

    pub async fn sleep_until_or_aborted(&self, clock: &Clock, until: KstTime, epoch: u64) -> Result<(), Stale> {
        let mut abandoned = self.epoch.subscribe();
        tokio::select! {
            () = clock.sleep_until(until) => {}
            _ = abandoned.wait_for(|current| *current != epoch) => {}
        }
        if self.aborted(epoch) { Err(Stale) } else { Ok(()) }
    }

    pub async fn connect_until_waiting(&self, connect: impl Future<Output = LinkState>) -> LinkState {
        let mut state = self.subscribe();
        let waiting = async {
            let _ = state.wait_for(|state| matches!(state, LinkState::Connecting(ConnectStep::IssueInterval(_)))).await;
        };
        tokio::select! {
            outcome = connect => outcome,
            () = waiting => self.state(),
        }
    }
}

pub fn spawn_halt_watcher<T, H>(
    weak: Weak<T>,
    mut halted: watch::Receiver<Option<H>>,
    on_halt: impl Fn(Arc<T>) + Send + Sync + 'static,
) where
    T: Send + Sync + 'static,
    H: Send + Sync + 'static,
{
    tokio::spawn(async move {
        while halted.wait_for(Option::is_some).await.is_ok() {
            let Some(target) = weak.upgrade() else { return };
            on_halt(target);
            if halted.wait_for(Option::is_none).await.is_err() {
                return;
            }
        }
    });
}

pub fn spawn_token_refresher<T>(
    weak: Weak<T>,
    clock: Clock,
    next_wake: impl Fn(&T) -> KstTime + Send + Sync + 'static,
    on_due: impl Fn(Arc<T>) -> BoxFuture<'static, ()> + Send + Sync + 'static,
) where
    T: Send + Sync + 'static,
{
    tokio::spawn(async move {
        loop {
            let wake = {
                let Some(target) = weak.upgrade() else { return };
                next_wake(&target)
            };
            clock.sleep_until(wake).await;
            let Some(target) = weak.upgrade() else { return };
            on_due(target).await;
        }
    });
}

pub enum ReissueAttempt {
    Done,
    RetryAt(KstTime),
    Stop,
}

pub async fn retry_reissue_until(
    clock: &Clock,
    deadline: KstTime,
    still_connected: impl Fn() -> bool,
    mut attempt: impl FnMut() -> BoxFuture<'static, ReissueAttempt>,
) -> bool {
    loop {
        let retry_at = match attempt().await {
            ReissueAttempt::Done => return true,
            ReissueAttempt::Stop => return false,
            ReissueAttempt::RetryAt(at) => at,
        };
        let at = retry_at.max(clock.now().plus_secs(DAILY_TOKEN_RETRY_SECS));
        if at >= deadline || !still_connected() {
            return false;
        }
        clock.sleep_until(at).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use domain::KstDate;

    use super::*;
    use crate::clock::kst;

    #[tokio::test]
    async fn join_or_start_deduplicates_concurrent_callers_and_clears_slot() {
        let engine = Arc::new(LinkEngine::<bool>::new(LinkState::Disconnected));
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let started = Arc::new(AtomicUsize::new(0));

        let e1 = engine.clone();
        let s1 = started.clone();
        let (meta1, flight1) = engine.join_or_start(false, move |epoch| {
            Box::pin(async move {
                s1.fetch_add(1, Ordering::SeqCst);
                let _ = release_rx.await;
                let outcome = e1.finish(epoch, LinkState::Connected).unwrap();
                e1.clear_flight_if_current(epoch);
                outcome
            })
        });
        assert!(!meta1);
        assert_eq!(engine.state(), LinkState::Connecting(ConnectStep::CheckingKey));

        let s2 = started.clone();
        let (meta2, flight2) = engine.join_or_start(true, move |_| {
            s2.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { LinkState::Disconnected })
        });
        assert!(!meta2);

        release_tx.send(()).unwrap();
        assert_eq!(flight1.await, LinkState::Connected);
        assert_eq!(flight2.await, LinkState::Connected);
        assert_eq!(started.load(Ordering::SeqCst), 1);

        let e3 = engine.clone();
        let (meta3, flight3) = engine.join_or_start(true, move |epoch| {
            Box::pin(async move {
                e3.clear_flight_if_current(epoch);
                LinkState::Connected
            })
        });
        assert!(meta3);
        assert_eq!(flight3.await, LinkState::Connected);
    }

    #[tokio::test]
    async fn abandon_invalidates_in_flight_epoch_and_wakes_sleep() {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 25).unwrap(), 9, 0, 0));
        let engine = Arc::new(LinkEngine::<()>::new(LinkState::Disconnected));
        let epoch = engine.epoch();
        let until = clock.now().plus_secs(3600);

        let e = engine.clone();
        let c = clock.clone();
        let waiter = tokio::spawn(async move { e.sleep_until_or_aborted(&c, until, epoch).await });
        tokio::task::yield_now().await;

        engine.abandon(|| engine.set(LinkState::NoKey));
        assert_eq!(waiter.await.unwrap(), Err(Stale));
        assert_eq!(engine.step(epoch, LinkState::Connected), Err(Stale));
        assert_eq!(engine.state(), LinkState::NoKey);
    }

    #[test]
    fn stop_for_halt_disconnects_connected_and_leaves_connecting_alone() {
        let engine = LinkEngine::<()>::new(LinkState::Connected);
        let disconnected = AtomicUsize::new(0);
        let failure = LinkFailure { problem: Problem::KeyNeedsCheck, retry_at: None, message: "bad".into() };
        engine.stop_for_halt(|| LinkState::Failed(failure.clone()), || { disconnected.fetch_add(1, Ordering::SeqCst); });
        assert_eq!(disconnected.load(Ordering::SeqCst), 1);
        assert_eq!(engine.state(), LinkState::Failed(failure.clone()));

        engine.set(LinkState::Connecting(ConnectStep::Token));
        engine.stop_for_halt(|| LinkState::Failed(failure), || { disconnected.fetch_add(1, Ordering::SeqCst); });
        assert_eq!(disconnected.load(Ordering::SeqCst), 1);
        assert_eq!(engine.state(), LinkState::Connecting(ConnectStep::Token));
    }

    #[tokio::test]
    async fn retry_reissue_until_retries_until_done_or_deadline() {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 25).unwrap(), 20, 5, 0));
        let deadline = clock.now().plus_secs(30 * 60);
        let attempts = Arc::new(AtomicUsize::new(0));

        let c = clock.clone();
        let c_inner = clock.clone();
        let a = attempts.clone();
        let handle = tokio::spawn(async move {
            retry_reissue_until(&c, deadline, || true, move || {
                let n = a.fetch_add(1, Ordering::SeqCst);
                let retry_at = c_inner.now();
                Box::pin(async move {
                    if n == 0 { ReissueAttempt::RetryAt(retry_at) } else { ReissueAttempt::Done }
                })
            })
            .await
        });

        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        clock.jump(DAILY_TOKEN_RETRY_SECS);
        assert!(handle.await.unwrap());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
}
