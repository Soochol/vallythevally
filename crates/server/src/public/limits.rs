
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Rate {
    pub per_second: f64,
    pub burst: f64,
}

#[derive(Debug)]
pub(super) struct TokenBucket {
    rate: Rate,
    tokens: f64,
    at: i64,
}

impl TokenBucket {
    pub fn new(rate: Rate, now: i64) -> Self {
        TokenBucket { rate, tokens: rate.burst, at: now }
    }

    fn refill(&mut self, now: i64) {
        let elapsed = (now - self.at).max(0) as f64;
        self.tokens = (self.tokens + elapsed * self.rate.per_second).min(self.rate.burst);
        self.at = self.at.max(now);
    }

    pub fn take(&mut self, cost: f64, now: i64) -> Result<(), i64> {
        self.refill(now);
        if self.tokens + 1e-9 >= cost {
            self.tokens -= cost;
            return Ok(());
        }
        let wait = ((cost - self.tokens) / self.rate.per_second).ceil().max(1.0);
        Err(now + wait as i64)
    }

    pub fn refund(&mut self, cost: f64) {
        self.tokens = (self.tokens + cost).min(self.rate.burst);
    }
}

#[derive(Debug, Default)]
pub(super) struct MinuteWindow {
    starts: VecDeque<i64>,
}

impl MinuteWindow {
    pub fn admit(&mut self, limit: u32, now: i64) -> Result<(), i64> {
        while self.starts.front().is_some_and(|&at| at + 60 <= now) {
            self.starts.pop_front();
        }
        if self.starts.len() >= limit as usize {
            return Err(self.starts.front().map_or(now + 1, |&at| at + 60));
        }
        self.starts.push_back(now);
        Ok(())
    }
}

#[derive(Debug)]
pub(super) struct PerAccount<T> {
    entries: Mutex<HashMap<String, T>>,
}

impl<T> Default for PerAccount<T> {
    fn default() -> Self {
        PerAccount { entries: Mutex::new(HashMap::new()) }
    }
}

impl<T> PerAccount<T> {
    pub fn with<R>(&self, account: &str, make: impl FnOnce() -> T, use_entry: impl FnOnce(&mut T) -> R) -> R {
        let mut entries = locked(&self.entries);
        let entry = entries.entry(account.to_owned()).or_insert_with(make);
        use_entry(entry)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Full;

#[derive(Debug)]
pub(super) struct Slots {
    pool: Arc<Semaphore>,
}

impl Slots {
    pub fn new(limit: usize) -> Self {
        Slots { pool: Arc::new(Semaphore::new(limit)) }
    }

    pub fn take(&self) -> Result<OwnedSemaphorePermit, Full> {
        self.pool.clone().try_acquire_owned().map_err(|_| Full)
    }
}

#[derive(Debug)]
pub(super) struct AccountSlots {
    limit: usize,
    pools: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl AccountSlots {
    pub fn new(limit: usize) -> Self {
        AccountSlots { limit, pools: Mutex::new(HashMap::new()) }
    }

    pub fn take(&self, account: &str) -> Result<OwnedSemaphorePermit, Full> {
        let pool = locked(&self.pools).entry(account.to_owned()).or_insert_with(|| Arc::new(Semaphore::new(self.limit))).clone();
        pool.try_acquire_owned().map_err(|_| Full)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bucket_spends_its_burst_then_refills_by_the_clock() {
        let mut bucket = TokenBucket::new(Rate { per_second: 2.0, burst: 4.0 }, 100);
        for _ in 0..4 {
            assert!(bucket.take(1.0, 100).is_ok());
        }
        assert_eq!(bucket.take(1.0, 100), Err(101));
        assert!(bucket.take(1.0, 101).is_ok());
        assert!(bucket.take(1.0, 101).is_ok());
        assert!(bucket.take(1.0, 101).is_err());
        assert!(bucket.take(1.0, 1_000).is_ok(), "오래 쉬어도 burst까지만 쌓인다");
        assert!((0..3).all(|_| bucket.take(1.0, 1_000).is_ok()));
        assert!(bucket.take(1.0, 1_000).is_err());
    }

    #[test]
    fn light_requests_cost_a_fraction() {
        let mut bucket = TokenBucket::new(Rate { per_second: 20.0, burst: 100.0 }, 0);
        for _ in 0..150 {
            assert!(bucket.take(0.1, 0).is_ok());
        }
    }

    #[test]
    fn the_minute_window_reports_when_the_oldest_run_leaves() {
        let mut window = MinuteWindow::default();
        assert!(window.admit(2, 10).is_ok());
        assert!(window.admit(2, 20).is_ok());
        assert_eq!(window.admit(2, 30), Err(70));
        assert!(window.admit(2, 70).is_ok());
        assert_eq!(window.admit(2, 71), Err(80));
    }

    #[test]
    fn slots_refuse_instead_of_waiting() {
        let slots = Slots::new(1);
        let first = slots.take().unwrap();
        assert_eq!(slots.take().unwrap_err(), Full);
        drop(first);
        assert!(slots.take().is_ok());
    }
}
