
use std::sync::{Arc, Mutex};
use std::time::Duration;

use domain::KstTime;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::sync::watch;

use super::auth::{Halt, TokenGen};
use super::error::Category;
use super::rest::{Access, GateCause, KiwoomError, KiwoomRest, Priority};
use crate::clock::Clock;
use crate::config::Secret;
use crate::screener::Screener;
use crate::symbols::SymbolDirectory;

const SYMBOL_LIST_RETRY: Duration = Duration::from_secs(10);

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

impl LinkFailure {
    fn of(error: &KiwoomError) -> Self {
        let problem = match error {
            KiwoomError::Gated { cause: GateCause::IssueInterval, .. } => Problem::IssueIntervalWait,
            KiwoomError::Gated { cause: GateCause::Failure(f), .. } => match f.category() {
                Category::AuthIndeterminate => Problem::AuthUncertain,
                _ => Problem::Network,
            },
            KiwoomError::Failed(f) | KiwoomError::Stopped(f) => match f.category() {
                Category::AuthBlocked if f.detail() == Some(super::error::CodeKey::Rest(8050)) => Problem::AuthBlocked8050,
                Category::AuthBlocked => Problem::KeyNeedsCheck,
                Category::AuthIndeterminate | Category::TokenInvalid => Problem::AuthUncertain,
                Category::RateLimit | Category::Transient => Problem::Network,
                _ => Problem::PathStopped,
            },
            KiwoomError::TokenFile(_) => Problem::TokenFileUnusable,
            KiwoomError::NotConnected => Problem::Network,
        };
        LinkFailure { problem, retry_at: error.retry_at(), message: error.to_string() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    NoKey,
    Disconnected,
    Connecting(ConnectStep),
    Connected,
    Failed(LinkFailure),
}

struct Stale;

enum Decision {
    Done(LinkState),
    WaitUntil(KstTime),
    Proceed { has_token: bool },
}

type Flight = Shared<BoxFuture<'static, LinkState>>;

struct MarketData {
    symbols: Arc<SymbolDirectory>,
    screener: Arc<Screener>,
    update_on_start: bool,
}

struct Inner {
    rest: KiwoomRest,
    market: Option<MarketData>,
    clock: Clock,
    state: watch::Sender<LinkState>,
    flight: Mutex<Option<(bool, Flight)>>,
    released_8050: Mutex<Option<(Halt, Option<TokenGen>)>>,
    epoch: watch::Sender<u64>,
}

#[derive(Clone)]
pub struct Link(Arc<Inner>);

impl Link {
    pub fn new(rest: KiwoomRest, symbols: Arc<SymbolDirectory>, screener: Arc<Screener>, clock: Clock, update_on_start: bool) -> Link {
        Link::with_market(rest, Some(MarketData { symbols, screener, update_on_start }), clock)
    }

    pub fn account_only(rest: KiwoomRest, clock: Clock) -> Link {
        Link::with_market(rest, None, clock)
    }

    fn with_market(rest: KiwoomRest, market: Option<MarketData>, clock: Clock) -> Link {
        rest.set_access(Access::Closed);
        let link = Link(Arc::new(Inner { rest, market, clock, state: watch::channel(LinkState::Disconnected).0, flight: Mutex::new(None), released_8050: Mutex::new(None), epoch: watch::channel(0).0 }));
        link.0.state.send_replace(link.resting_state());
        link.watch_halts();
        link
    }

    fn watch_halts(&self) {
        let inner = Arc::downgrade(&self.0);
        let mut halted = self.0.rest.auth().watch_halted();
        tokio::spawn(async move {
            loop {
                if halted.wait_for(Option::is_some).await.is_err() {
                    return;
                }
                let Some(inner) = inner.upgrade() else { return };
                Link(inner).stop_for_halt();
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
        self.0.rest.set_access(Access::Closed);
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

    pub fn needs_acknowledgement(&self) -> bool {
        self.0.rest.auth().halted().is_some_and(|halt| halt.is_8050())
    }

    fn resting_state(&self) -> LinkState {
        let auth = self.0.rest.auth();
        if !auth.has_credentials() {
            return LinkState::NoKey;
        }
        match auth.halted() {
            Some(halt) => LinkState::Failed(LinkFailure::of(&halt.into())),
            None => LinkState::Disconnected,
        }
    }

    fn abandon_connect(&self, then: impl FnOnce()) {
        let mut slot = self.0.flight.lock().expect("연결 잠금");
        self.0.epoch.send_modify(|epoch| *epoch += 1);
        slot.take();
        self.restore_unsent_8050();
        then();
    }

    fn set(&self, state: LinkState) {
        self.0.state.send_replace(state);
    }

    fn restore_unsent_8050(&self) -> bool {
        let released = self.0.released_8050.lock().expect("8050 잠금").take();
        let auth = self.0.rest.auth();
        match released {
            Some((halt, generation_at_release)) if auth.issued_generation() == generation_at_release => {
                auth.restore_halt(halt);
                auth.halted().is_some_and(|halt| halt.is_8050())
            }
            _ => false,
        }
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

    fn open_access(&self, epoch: u64, access: Access) -> Result<(), Stale> {
        self.publish(epoch, || self.0.rest.set_access(access))
    }

    fn aborted(&self, epoch: u64) -> bool {
        *self.0.epoch.borrow() != epoch
    }

    pub async fn connect(&self, acknowledged: bool) -> LinkState {
        loop {
            let epoch = *self.0.epoch.borrow();
            let (started_acknowledged, flight) = self.join_or_start(acknowledged);
            let outcome = flight.await;
            let failed_unabandoned = matches!(outcome, LinkState::Failed(_)) && *self.0.epoch.borrow() == epoch;
            if acknowledged && !started_acknowledged && failed_unabandoned {
                continue;
            }
            return outcome;
        }
    }

    fn join_or_start(&self, acknowledged: bool) -> (bool, Flight) {
        let mut slot = self.0.flight.lock().expect("연결 잠금");
        if let Some((started_acknowledged, flight)) = slot.as_ref() {
            return (*started_acknowledged, flight.clone());
        }
        let link = self.clone();
        let epoch = *self.0.epoch.borrow();
        let task = tokio::spawn(async move {
            let outcome = link.run_connect(acknowledged, epoch).await.unwrap_or_else(|Stale| link.state());
            let mut slot = link.0.flight.lock().expect("연결 잠금");
            if *link.0.epoch.borrow() == epoch {
                slot.take();
            }
            outcome
        });
        let flight = async move { task.await.unwrap_or(LinkState::Disconnected) }.boxed().shared();
        *slot = Some((acknowledged, flight.clone()));
        if !self.is_connected() {
            self.set(LinkState::Connecting(ConnectStep::CheckingKey));
        }
        (acknowledged, flight)
    }

    async fn run_connect(&self, acknowledged: bool, epoch: u64) -> Result<LinkState, Stale> {
        let outcome = self.connect_steps(acknowledged, epoch).await;
        let _slot = self.0.flight.lock().expect("연결 잠금");
        if *self.0.epoch.borrow() == epoch {
            if matches!(outcome, Ok(LinkState::Connected)) {
                self.0.released_8050.lock().expect("8050 잠금").take();
                self.0.rest.auth().clear_connect_records();
            } else if self.restore_unsent_8050() {
                let blocked = self.resting_state();
                self.set(blocked.clone());
                return Ok(blocked);
            }
        }
        outcome
    }

    async fn connect_steps(&self, acknowledged: bool, epoch: u64) -> Result<LinkState, Stale> {
        let rest = &self.0.rest;
        let auth = rest.auth();
        let has_token = loop {
            match self.decide(acknowledged, epoch)? {
                Decision::Done(state) => return Ok(state),
                Decision::WaitUntil(until) => self.wait_for_issue_interval(until, epoch).await?,
                Decision::Proceed { has_token } => break has_token,
            }
        };
        self.open_access(epoch, Access::Connecting)?;
        if has_token {
            tracing::info!("파일의 토큰을 다시 씁니다. 발급하지 않습니다");
        } else {
            self.step(epoch, LinkState::Connecting(ConnectStep::Token))?;
            if let Err(error) = rest.issue_token().await {
                return self.fail(&error, epoch);
            }
        }
        if self.0.market.is_some() {
            self.step(epoch, LinkState::Connecting(ConnectStep::Symbols))?;
            if let Err(error) = self.load_symbols(epoch).await {
                return self.fail(&error, epoch);
            }
        }
        self.step(epoch, LinkState::Connecting(ConnectStep::Realtime))?;
        let mut outcome = LinkState::Connected;
        self.publish(epoch, || {
            if let Some(halt) = auth.halted() {
                outcome = LinkState::Failed(LinkFailure::of(&halt.into()));
                rest.set_access(Access::Closed);
            } else {
                rest.set_access(Access::Open);
            }
            self.set(outcome.clone());
        })?;
        if outcome == LinkState::Connected {
            self.start_screener_update();
        }
        Ok(outcome)
    }

    fn decide(&self, acknowledged: bool, epoch: u64) -> Result<Decision, Stale> {
        let auth = self.0.rest.auth();
        if self.aborted(epoch) {
            return Err(Stale);
        }
        if self.is_connected() {
            return Ok(Decision::Done(LinkState::Connected));
        }
        self.step(epoch, LinkState::Connecting(ConnectStep::CheckingKey))?;
        if !auth.has_credentials() {
            return self.finish(epoch, LinkState::NoKey).map(Decision::Done);
        }
        match auth.halted() {
            Some(halt) if halt.is_8050() && acknowledged => {
                let now = self.0.clock.now();
                if let Some(until) = auth.issue_blocked_until(now) {
                    return self.finish(epoch, LinkState::Failed(LinkFailure::of(&KiwoomError::Gated { until, cause: GateCause::IssueInterval }))).map(Decision::Done);
                }
                self.publish(epoch, || {
                    auth.release_8050();
                    *self.0.released_8050.lock().expect("8050 잠금") = Some((halt, auth.issued_generation()));
                })?;
            }
            Some(halt) => return self.finish(epoch, LinkState::Failed(LinkFailure::of(&halt.into()))).map(Decision::Done),
            None => {}
        }
        let now = self.0.clock.now();
        let has_token = auth.current(now).is_some();
        if !has_token && let Some(until) = auth.issue_blocked_until(now) {
            if acknowledged {
                return self.finish(epoch, LinkState::Failed(LinkFailure::of(&KiwoomError::Gated { until, cause: GateCause::IssueInterval }))).map(Decision::Done);
            }
            self.step(epoch, LinkState::Connecting(ConnectStep::IssueInterval(until)))?;
            return Ok(Decision::WaitUntil(until));
        }
        Ok(Decision::Proceed { has_token })
    }

    async fn wait_for_issue_interval(&self, until: KstTime, epoch: u64) -> Result<(), Stale> {
        let mut abandoned = self.0.epoch.subscribe();
        tokio::select! {
            () = self.0.clock.sleep_until(until) => {}
            _ = abandoned.wait_for(|current| *current != epoch) => {}
        }
        if self.aborted(epoch) { Err(Stale) } else { Ok(()) }
    }

    fn finish(&self, epoch: u64, state: LinkState) -> Result<LinkState, Stale> {
        self.step(epoch, state.clone())?;
        Ok(state)
    }

    fn fail(&self, error: &KiwoomError, epoch: u64) -> Result<LinkState, Stale> {
        if matches!(error, KiwoomError::NotConnected) {
            return Err(Stale);
        }
        tracing::warn!(error = %error, "키움에 연결하지 못했습니다");
        let state = LinkState::Failed(LinkFailure::of(error));
        self.publish(epoch, || {
            self.0.rest.set_access(Access::Closed);
            self.set(state.clone());
        })?;
        Ok(state)
    }

    async fn load_symbols(&self, epoch: u64) -> Result<(), KiwoomError> {
        loop {
            let Some(market) = &self.0.market else { return Ok(()) };
            let error = match market.symbols.refresh(&self.0.rest, Priority::Screen).await {
                Ok(()) => return Ok(()),
                Err(error) => error,
            };
            if matches!(error, KiwoomError::Gated { cause: GateCause::IssueInterval, .. }) {
                return Err(error);
            }
            let Some(retry_at) = error.retry_at() else {
                tracing::error!(error = %error, "종목 목록을 받지 못했습니다. 다시 받지 않습니다");
                return Err(error);
            };
            let at = crate::app::next_try(&self.0.clock, retry_at, SYMBOL_LIST_RETRY);
            tracing::warn!(error = %error, %at, "종목 목록을 받지 못했습니다. 그 시각에 다시 받습니다");
            let mut abandoned = self.0.epoch.subscribe();
            tokio::select! {
                () = self.0.clock.sleep_until(at) => {}
                _ = abandoned.wait_for(|current| *current != epoch) => {}
            }
            if self.aborted(epoch) {
                return Err(KiwoomError::NotConnected);
            }
        }
    }

    fn start_screener_update(&self) {
        let Some(market) = &self.0.market else { return };
        let screener = market.screener.clone();
        let update_on_start = market.update_on_start;
        tokio::spawn(async move {
            screener.fill_lost_listing().await;
            if update_on_start {
                screener.update_if_behind().await;
            }
        });
    }

    pub fn connect_at_start(&self) {
        let auth = self.0.rest.auth();
        if !auth.has_credentials() || auth.halted().is_some() {
            return;
        }
        if auth.kept_disconnected() {
            tracing::info!("사용자가 연결을 끊어 둔 키라 켤 때 연결하지 않습니다");
            return;
        }
        tracing::info!("키가 있어 키움에 저절로 연결합니다");
        self.connect_in_background();
    }

    pub fn connect_in_background(&self) {
        drop(self.join_or_start(false));
    }

    pub async fn connect_until_waiting(&self, acknowledged: bool) -> LinkState {
        let mut state = self.subscribe();
        let waiting = async {
            let _ = state.wait_for(|state| matches!(state, LinkState::Connecting(ConnectStep::IssueInterval(_)))).await;
        };
        tokio::select! {
            outcome = self.connect(acknowledged) => outcome,
            () = waiting => self.state(),
        }
    }

    pub fn disconnect_by_user(&self) {
        self.abandon_connect(|| {
            self.0.rest.set_access(Access::Closed);
            self.0.rest.auth().keep_disconnected();
            self.set(self.resting_state());
        });
    }

    pub fn disconnect(&self) {
        self.abandon_connect(|| {
            self.0.rest.set_access(Access::Closed);
            self.set(self.resting_state());
        });
    }

    fn rest_as(&self, state: LinkState) -> LinkState {
        self.set(state.clone());
        state
    }

    pub fn recheck_token_file(&self) -> LinkState {
        match self.0.rest.auth().recheck_token_file() {
            Ok(()) if !self.is_connected() && !matches!(self.state(), LinkState::Connecting(_)) => self.rest_as(self.resting_state()),
            Ok(()) | Err(_) => self.state(),
        }
    }

    pub fn replace_key(&self, app_key: Secret<String>, app_secret: Secret<String>) -> LinkState {
        let auth = self.0.rest.auth();
        self.abandon_connect(|| {
            self.0.rest.set_access(Access::Closed);
            auth.replace_credentials(app_key, app_secret);
            auth.release_key_rejection();
            self.set(self.resting_state());
        });
        self.state()
    }

    pub fn rebind(&self, identity: Option<(Secret<String>, Secret<String>, Option<super::token_file::TokenFile>)>) -> LinkState {
        self.abandon_connect(|| {
            self.0.rest.set_access(Access::Closed);
            self.0.rest.auth().rebind(identity);
            self.set(self.resting_state());
        });
        self.state()
    }

    pub fn record_key_in_token_file(&self) {
        self.0.rest.auth().persist();
    }

    pub fn clear_key(&self) -> LinkState {
        self.abandon_connect(|| {
            self.0.rest.set_access(Access::Closed);
            self.0.rest.auth().clear_credentials();
            self.set(self.resting_state());
        });
        self.state()
    }
}
