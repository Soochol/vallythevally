use std::collections::HashMap;

use crate::config::Secret;

pub const PENDING_TTL_SECONDS: i64 = 10 * 60;
pub const PENDING_LIMIT: usize = 8;

pub struct Pending {
    pub verifier: Secret<String>,
    started_at: i64,
}

#[derive(Default)]
pub struct PendingLogins {
    by_state: HashMap<String, Pending>,
}

impl PendingLogins {
    pub fn insert(&mut self, now: i64, state: String, verifier: Secret<String>) {
        self.by_state.retain(|_, pending| now - pending.started_at < PENDING_TTL_SECONDS);
        if self.by_state.len() >= PENDING_LIMIT
            && let Some(oldest) = self.by_state.iter().min_by_key(|(_, pending)| pending.started_at).map(|(state, _)| state.clone())
        {
            self.by_state.remove(&oldest);
        }
        self.by_state.insert(state, Pending { verifier, started_at: now });
    }

    pub fn take(&mut self, now: i64, state: &str) -> Option<Pending> {
        self.by_state.remove(state).filter(|pending| now - pending.started_at < PENDING_TTL_SECONDS)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.by_state.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verifier() -> Secret<String> {
        Secret::new("v".to_owned())
    }

    #[test]
    fn a_state_is_used_once() {
        let mut pending = PendingLogins::default();
        pending.insert(100, "s".into(), verifier());
        assert!(pending.take(101, "s").is_some());
        assert!(pending.take(101, "s").is_none());
    }

    #[test]
    fn a_state_expires_after_ten_minutes_and_is_dropped_when_asked() {
        let mut pending = PendingLogins::default();
        pending.insert(100, "fresh".into(), verifier());
        pending.insert(100, "stale".into(), verifier());
        assert!(pending.take(100 + PENDING_TTL_SECONDS - 1, "fresh").is_some());
        assert!(pending.take(100 + PENDING_TTL_SECONDS, "stale").is_none());
        assert_eq!(pending.len(), 0);
    }

    #[test]
    fn the_oldest_waiting_login_gives_way_past_the_limit() {
        let mut pending = PendingLogins::default();
        for n in 0..=PENDING_LIMIT as i64 {
            pending.insert(100 + n, format!("s{n}"), verifier());
        }
        assert_eq!(pending.len(), PENDING_LIMIT);
        assert!(pending.take(200, "s0").is_none());
        assert!(pending.take(200, &format!("s{PENDING_LIMIT}")).is_some());
    }
}
