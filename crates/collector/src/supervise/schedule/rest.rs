use std::time::Duration;

use server::kiwoom::rest::KiwoomRest;
use tokio::sync::watch;
use tokio::time::sleep;

use super::{Daemon, Halt, StageResult, stoppable};
use crate::keys::{ActiveKey, KeyRole};
use crate::supervise::tokens::{Issue, KeyTokens};

const TOKEN_ATTEMPTS: u32 = 3;

pub(super) struct RestSession {
    tokens: KeyTokens,
}

impl RestSession {
    pub(super) fn rest(&self) -> &KiwoomRest {
        self.tokens.rest()
    }
}

impl Daemon {
    pub(super) fn rest_key(&self) -> (&ActiveKey, bool) {
        match self.keys.iter().find(|key| key.identity.role == KeyRole::Spare) {
            Some(spare) => (spare, true),
            None => (&self.keys[0], false),
        }
    }

    pub(super) async fn open_rest(&self, shutdown: &mut watch::Receiver<bool>) -> StageResult<RestSession> {
        let (key, _) = self.rest_key();
        let tokens = KeyTokens::open(key, self.transport.clone(), self.clock.clone()).map_err(|error| Halt::Failed(format!("키 {}의 잠금을 잡지 못했습니다: {error}", key.identity.name)))?;
        self.ensure_token(&tokens, shutdown).await?;
        Ok(RestSession { tokens })
    }

    pub(super) async fn ensure_token(&self, tokens: &KeyTokens, shutdown: &mut watch::Receiver<bool>) -> StageResult<()> {
        for _ in 0..TOKEN_ATTEMPTS {
            if !tokens.needs_issue() {
                return Ok(());
            }
            match self.issue_with_retry(tokens, shutdown).await? {
                Some(_) => return Ok(()),
                None => continue,
            }
        }
        Err(Halt::Failed("토큰을 받지 못했습니다".to_owned()))
    }

    pub(super) async fn issue_with_retry(&self, tokens: &KeyTokens, shutdown: &mut watch::Receiver<bool>) -> StageResult<Option<u64>> {
        let wait = tokens.wait_before_issue();
        if !wait.is_zero() {
            stoppable(shutdown, sleep(wait)).await?;
        }
        match stoppable(shutdown, self.lane.issue(tokens)).await? {
            Issue::Issued(generation) => Ok(Some(generation)),
            Issue::Halted(halted) => Err(Halt::Failed(format!("토큰을 받을 수 없습니다: {}", halted.text))),
            Issue::Retry(wait) => {
                stoppable(shutdown, sleep(wait.min(Duration::from_secs(120)))).await?;
                Ok(None)
            }
        }
    }
}
