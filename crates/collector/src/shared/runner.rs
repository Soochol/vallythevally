use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use domain::{KstDate, KstTime};
use serde_json::Value;
use server::clock::Clock;
use tokio::time::{Instant, sleep_until};

use super::job::{JobCall, Market, SharedJob, Slice};
use super::wire::JobStat;
use super::JobName;
use crate::protocol::KeyName;

#[derive(Default)]
pub struct LoopStats {
    runs: AtomicU64,
    overruns: AtomicU64,
    last_error: Mutex<Option<String>>,
}

impl LoopStats {
    pub fn runs(&self) -> u64 {
        self.runs.load(Ordering::SeqCst)
    }

    pub fn overruns(&self) -> u64 {
        self.overruns.load(Ordering::SeqCst)
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    pub fn report(&self, job: JobName) -> JobStat {
        JobStat { job, runs: self.runs(), overruns: self.overruns(), last_error: self.last_error() }
    }
}

pub struct JobLoop {
    pub job: Arc<dyn SharedJob>,
    pub observation_date: KstDate,
    pub period: Duration,
    pub slice: Slice,
    pub options: Value,
}

impl JobLoop {
    pub async fn run(&self, market: Market<'_>, key: &KeyName, shared_dir: &Path, clock: &Clock, stats: &LoopStats) {
        let window = self.job.window();
        let opens_at = KstTime::from_kst_civil(self.observation_date, window.start);
        let closes_at = KstTime::from_kst_civil(self.observation_date, window.end);
        clock.sleep_until(opens_at).await;
        let mut due = Instant::now();
        while clock.now() < closes_at {
            sleep_until(due).await;
            if clock.now() >= closes_at {
                break;
            }
            let call = JobCall { observation_date: self.observation_date, slice: self.slice, market: reborrow(&market), shared_dir, key, clock, options: &self.options };
            let outcome = self.job.run(call).await;
            stats.runs.fetch_add(1, Ordering::SeqCst);
            *stats.last_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = outcome.err().map(|error| error.to_string());
            due += self.period;
            let finished = Instant::now();
            if finished > due {
                stats.overruns.fetch_add(1, Ordering::SeqCst);
                due = finished;
            }
        }
    }
}

fn reborrow<'a>(market: &'a Market<'_>) -> Market<'a> {
    match market {
        Market::Kiwoom(rest) => Market::Kiwoom(rest),
        Market::Kis => Market::Kis,
    }
}
