use std::sync::atomic::{AtomicI64, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct UnixSeconds(pub i64);

impl UnixSeconds {
    pub fn plus(self, seconds: i64) -> UnixSeconds {
        UnixSeconds(self.0 + seconds)
    }
}

pub trait Clock: Send + Sync {
    fn now(&self) -> UnixSeconds;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> UnixSeconds {
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        UnixSeconds(elapsed.as_secs() as i64)
    }
}

pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(start: UnixSeconds) -> Self {
        Self(AtomicI64::new(start.0))
    }

    pub fn advance(&self, seconds: i64) {
        self.0.fetch_add(seconds, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> UnixSeconds {
        UnixSeconds(self.0.load(Ordering::SeqCst))
    }
}
