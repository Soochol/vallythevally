use std::sync::Arc;
use std::time::Duration;

use server::clock::Clock;
use server::config::Secret;
use server::instance::{InstanceLock, LockError};
use server::kiwoom::auth::{KiwoomAuth, TokenGen};
use server::kiwoom::error::CodeKey;
use server::kiwoom::rest::{GateCause, KiwoomError, KiwoomRest};
use server::kiwoom::token_file::TokenFile;
use server::kiwoom::transport::Transport;
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep_until};

use crate::keys::ActiveKey;

const UNKNOWN_RETRY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Halted {
    pub text: String,
    pub is_8050: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Issue {
    Issued(u64),
    Halted(Halted),
    Retry(Duration),
}

pub struct KeyTokens {
    rest: KiwoomRest,
    clock: Clock,
    _lock: InstanceLock,
}

impl KeyTokens {
    pub fn open(key: &ActiveKey, transport: Arc<dyn Transport>, clock: Clock) -> Result<KeyTokens, LockError> {
        let lock = InstanceLock::acquire(&key.lock_path)?;
        let file = TokenFile::new(key.token_path.clone(), &lock);
        let auth = KiwoomAuth::new(key.app_key.clone(), key.app_secret.clone(), Some(file));
        Ok(KeyTokens { rest: KiwoomRest::new(transport, auth, clock.clone()), clock, _lock: lock })
    }

    pub fn rest(&self) -> &KiwoomRest {
        &self.rest
    }

    pub fn current(&self) -> Option<(Secret<String>, u64)> {
        self.rest.auth().current(self.clock.now()).map(|(token, TokenGen(generation))| (token, generation))
    }

    pub fn expires_at(&self) -> Option<i64> {
        self.rest.auth().token_expires_at().map(|at| at.unix())
    }

    pub fn needs_issue(&self) -> bool {
        self.rest.auth().needs_issue(self.clock.now())
    }

    pub fn halted(&self) -> Option<Halted> {
        self.rest.auth().halted().map(|halt| Halted { is_8050: halt.is_8050(), text: KiwoomError::from(halt).to_string() })
    }

    pub fn wait_before_issue(&self) -> Duration {
        let now = self.clock.now();
        self.rest.auth().issue_blocked_until(now).map_or(Duration::ZERO, |until| seconds_until(until.unix() - now.unix()))
    }

    pub fn invalidate(&self, generation: u64) {
        let _ = self.rest.auth().invalidate(TokenGen(generation));
    }

    pub fn mark_current_stale(&self) {
        if let Some(generation) = self.rest.auth().issued_generation() {
            let _ = self.rest.auth().invalidate(generation);
        }
    }

    pub async fn issue(&self) -> Issue {
        match self.rest.issue_token().await {
            Ok(TokenGen(generation)) => Issue::Issued(generation),
            Err(error) => self.judge(error),
        }
    }

    fn judge(&self, error: KiwoomError) -> Issue {
        if let Some(halted) = self.halted() {
            return Issue::Halted(halted);
        }
        if error.manual_action_required() {
            let is_8050 = error.failure().is_some_and(|failure| failure.detail() == Some(CodeKey::Rest(8050)));
            return Issue::Halted(Halted { text: error.to_string(), is_8050 });
        }
        let now = self.clock.now();
        let wait = match &error {
            KiwoomError::Gated { until, cause: GateCause::IssueInterval } => Some(seconds_until(until.unix() - now.unix())),
            _ => Some(self.wait_before_issue()).filter(|wait| !wait.is_zero()),
        };
        Issue::Retry(wait.unwrap_or(UNKNOWN_RETRY))
    }
}

fn seconds_until(seconds: i64) -> Duration {
    Duration::from_secs(seconds.max(0) as u64 + 1)
}

pub struct IssueLane {
    spacing: Duration,
    last_started: Mutex<Option<Instant>>,
}

impl IssueLane {
    pub fn new(spacing: Duration) -> IssueLane {
        IssueLane { spacing, last_started: Mutex::new(None) }
    }

    pub async fn issue(&self, tokens: &KeyTokens) -> Issue {
        let mut last_started = self.last_started.lock().await;
        if let Some(previous) = *last_started {
            sleep_until(previous + self.spacing).await;
        }
        *last_started = Some(Instant::now());
        tokens.issue().await
    }
}
