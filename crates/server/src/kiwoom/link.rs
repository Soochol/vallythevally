use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use domain::KstTime;
use tokio::sync::watch;

use super::auth::{DAILY_REISSUE_AT, Halt, TokenGen};
use super::error::Category;
use super::rest::{Access, GateCause, KiwoomError, KiwoomRest, Priority};
use crate::clock::{Clock, next_daily};
use crate::config::Secret;
pub use crate::market_source::link::{ConnectStep, LinkFailure, LinkState, Problem};
use crate::market_source::link::{DAILY_TOKEN_GIVE_UP_AT, Flight, LinkEngine, ReissueAttempt, Stale, retry_reissue_until, spawn_halt_watcher, spawn_token_refresher};
use crate::screener::Screener;
use crate::symbols::SymbolDirectory;

const SYMBOL_LIST_RETRY: Duration = Duration::from_secs(10);

fn failure_of(error: &KiwoomError) -> LinkFailure {
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

enum Decision {
    Done(LinkState),
    WaitUntil(KstTime),
    Proceed { has_token: bool },
}

struct MarketData {
    symbols: Arc<SymbolDirectory>,
    screener: Arc<Screener>,
    update_on_start: bool,
}

struct Inner {
    rest: KiwoomRest,
    market: Option<MarketData>,
    market_duty: AtomicBool,
    clock: Clock,
    engine: LinkEngine<bool>,
    released_8050: Mutex<Option<(Halt, Option<TokenGen>)>>,
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
        let link = Link(Arc::new(Inner {
            rest,
            market,
            market_duty: AtomicBool::new(true),
            clock,
            engine: LinkEngine::new(LinkState::Disconnected),
            released_8050: Mutex::new(None),
        }));
        link.0.engine.set(link.resting_state());
        link.watch_halts();
        link.keep_token_fresh();
        link
    }

    fn watch_halts(&self) {
        let halted = self.0.rest.auth().watch_halted();
        spawn_halt_watcher(Arc::downgrade(&self.0), halted, |inner| Link(inner).stop_for_halt());
    }

    fn keep_token_fresh(&self) {
        spawn_token_refresher(
            Arc::downgrade(&self.0),
            self.0.clock.clone(),
            |inner| next_daily(inner.clock.now(), DAILY_REISSUE_AT),
            |inner| Box::pin(async move { Link(inner).refresh_token_if_due().await }),
        );
    }

    async fn refresh_token_if_due(&self) {
        if self.settled().await != LinkState::Connected || self.0.rest.halted().is_some() || !self.0.rest.auth().due_daily_reissue(self.0.clock.now()) {
            return;
        }
        let deadline = next_daily(self.0.clock.now(), DAILY_TOKEN_GIVE_UP_AT);
        let ok = retry_reissue_until(&self.0.clock, deadline, || self.is_connected(), || {
            let rest = self.0.rest.clone();
            Box::pin(async move {
                match rest.issue_token().await {
                    Ok(_) => ReissueAttempt::Done,
                    Err(e) => match e.retry_at() {
                        Some(at) => {
                            tracing::warn!(error = %e, %at, "20:05 토큰 발급에 실패했습니다. 그 시각에 다시 받습니다");
                            ReissueAttempt::RetryAt(at)
                        }
                        None => {
                            tracing::error!(error = %e, "20:05 토큰 발급에 실패했습니다. 다시 받지 않습니다");
                            ReissueAttempt::Stop
                        }
                    },
                }
            })
        })
        .await;
        if !ok && self.is_connected() && self.0.clock.now() >= deadline {
            tracing::error!("20:05 토큰 발급이 07:45까지 실패했습니다");
        }
    }

    fn stop_for_halt(&self) {
        self.0.engine.stop_for_halt(|| self.resting_state(), || self.0.rest.set_access(Access::Closed));
    }

    pub fn set_market_duty(&self, on: bool) {
        self.0.market_duty.store(on, Ordering::Relaxed);
    }

    fn has_market_duty(&self) -> bool {
        self.0.market.is_some() && self.0.market_duty.load(Ordering::Relaxed)
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

    pub fn needs_acknowledgement(&self) -> bool {
        self.0.rest.auth().halted().is_some_and(|halt| halt.is_8050())
    }

    fn resting_state(&self) -> LinkState {
        let auth = self.0.rest.auth();
        if !auth.has_credentials() {
            return LinkState::NoKey;
        }
        match auth.halted() {
            Some(halt) => LinkState::Failed(failure_of(&halt.into())),
            None => LinkState::Disconnected,
        }
    }

    fn abandon_connect(&self, then: impl FnOnce()) {
        self.0.engine.abandon(|| {
            self.restore_unsent_8050();
            then();
        });
    }

    fn set(&self, state: LinkState) {
        self.0.engine.set(state);
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

    fn open_access(&self, epoch: u64, access: Access) -> Result<(), Stale> {
        self.0.engine.publish(epoch, || self.0.rest.set_access(access))
    }

    pub async fn connect(&self, acknowledged: bool) -> LinkState {
        loop {
            let epoch = self.0.engine.epoch();
            let (started_acknowledged, flight) = self.join_or_start(acknowledged);
            let outcome = flight.await;
            let failed_unabandoned = matches!(outcome, LinkState::Failed(_)) && !self.0.engine.aborted(epoch);
            if acknowledged && !started_acknowledged && failed_unabandoned {
                continue;
            }
            return outcome;
        }
    }

    fn join_or_start(&self, acknowledged: bool) -> (bool, Flight) {
        let link = self.clone();
        self.0.engine.join_or_start(acknowledged, move |epoch| {
            Box::pin(async move {
                let outcome = link.run_connect(acknowledged, epoch).await.unwrap_or_else(|Stale| link.state());
                link.0.engine.clear_flight_if_current(epoch);
                outcome
            })
        })
    }

    async fn run_connect(&self, acknowledged: bool, epoch: u64) -> Result<LinkState, Stale> {
        let outcome = self.connect_steps(acknowledged, epoch).await;
        self.0.engine.with_epoch_lock(epoch, |same_epoch| {
            if same_epoch {
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
        })
    }

    async fn connect_steps(&self, acknowledged: bool, epoch: u64) -> Result<LinkState, Stale> {
        let rest = &self.0.rest;
        let auth = rest.auth();
        let has_token = loop {
            match self.decide(acknowledged, epoch)? {
                Decision::Done(state) => return Ok(state),
                Decision::WaitUntil(until) => self.0.engine.sleep_until_or_aborted(&self.0.clock, until, epoch).await?,
                Decision::Proceed { has_token } => break has_token,
            }
        };
        self.open_access(epoch, Access::Connecting)?;
        if has_token {
            tracing::info!("파일의 토큰을 다시 씁니다. 발급하지 않습니다");
        } else {
            self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::Token))?;
            if let Err(error) = rest.issue_token().await {
                return self.fail(&error, epoch);
            }
        }
        if self.has_market_duty() {
            self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::Symbols))?;
            if let Err(error) = self.load_symbols(epoch).await {
                return self.fail(&error, epoch);
            }
        }
        self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::Realtime))?;
        let mut outcome = LinkState::Connected;
        self.0.engine.publish(epoch, || {
            if let Some(halt) = auth.halted() {
                outcome = LinkState::Failed(failure_of(&halt.into()));
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
        if self.0.engine.aborted(epoch) {
            return Err(Stale);
        }
        if self.is_connected() {
            return Ok(Decision::Done(LinkState::Connected));
        }
        self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::CheckingKey))?;
        if !auth.has_credentials() {
            return self.0.engine.finish(epoch, LinkState::NoKey).map(Decision::Done);
        }
        match auth.halted() {
            Some(halt) if halt.is_8050() && acknowledged => {
                let now = self.0.clock.now();
                if let Some(until) = auth.issue_blocked_until(now) {
                    return self.0.engine.finish(epoch, LinkState::Failed(failure_of(&KiwoomError::Gated { until, cause: GateCause::IssueInterval }))).map(Decision::Done);
                }
                self.0.engine.publish(epoch, || {
                    auth.release_8050();
                    *self.0.released_8050.lock().expect("8050 잠금") = Some((halt, auth.issued_generation()));
                })?;
            }
            Some(halt) => return self.0.engine.finish(epoch, LinkState::Failed(failure_of(&halt.into()))).map(Decision::Done),
            None => {}
        }
        let now = self.0.clock.now();
        let has_token = auth.current(now).is_some();
        if !has_token && let Some(until) = auth.issue_blocked_until(now) {
            if acknowledged {
                return self.0.engine.finish(epoch, LinkState::Failed(failure_of(&KiwoomError::Gated { until, cause: GateCause::IssueInterval }))).map(Decision::Done);
            }
            self.0.engine.step(epoch, LinkState::Connecting(ConnectStep::IssueInterval(until)))?;
            return Ok(Decision::WaitUntil(until));
        }
        Ok(Decision::Proceed { has_token })
    }

    fn fail(&self, error: &KiwoomError, epoch: u64) -> Result<LinkState, Stale> {
        if matches!(error, KiwoomError::NotConnected) {
            return Err(Stale);
        }
        tracing::warn!(error = %error, "키움에 연결하지 못했습니다");
        let state = LinkState::Failed(failure_of(error));
        self.0.engine.publish(epoch, || {
            self.0.rest.set_access(Access::Closed);
            self.set(state.clone());
        })?;
        Ok(state)
    }

    async fn load_symbols(&self, epoch: u64) -> Result<(), KiwoomError> {
        loop {
            let Some(market) = &self.0.market else { return Ok(()) };
            let error = match crate::kiwoom::market_source::refresh_symbols(&market.symbols, &self.0.rest, Priority::Screen).await {
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
            if self.0.engine.sleep_until_or_aborted(&self.0.clock, at, epoch).await.is_err() {
                return Err(KiwoomError::NotConnected);
            }
        }
    }

    fn start_screener_update(&self) {
        if !self.has_market_duty() {
            return;
        }
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
        self.0.engine.connect_until_waiting(self.connect(acknowledged)).await
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

    pub fn rebind_replacing(&self, identity: Option<(Secret<String>, Secret<String>, Option<super::token_file::TokenFile>)>) -> LinkState {
        self.abandon_connect(|| {
            self.0.rest.set_access(Access::Closed);
            self.0.rest.auth().rebind_replacing(identity);
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
