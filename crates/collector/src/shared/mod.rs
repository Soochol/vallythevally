use std::sync::Arc;

use serde::{Deserialize, Serialize};

mod assignment;
pub mod child;
pub mod flow;
mod job;
pub mod minute;
mod overview;
mod probe;
pub mod quotes;
pub mod rankings;
mod runner;
mod themes;
pub mod snapshot;
mod usage;
mod wire;

pub use assignment::{AssignedJob, Assignment, AssignmentError, AssignmentStore, KeyOptions, Reload};
pub use job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob, Slice};
pub use runner::{JobLoop, LoopStats};
pub use usage::{LimitEvidence, UsageLog, UsageMinute, UsagePoller, judge_limit, usage_path};
pub use wire::{JobStat, TrMinute};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobName {
    Probe,
    KiwoomThemes,
    Overview,
    IntradaySamples,
    Snapshot,
    Rankings,
}

impl JobName {
    pub fn job(self) -> Arc<dyn SharedJob> {
        match self {
            JobName::Probe => Arc::new(probe::ProbeJob),
            JobName::KiwoomThemes => Arc::new(themes::KiwoomThemesJob::default()),
            JobName::Overview => Arc::new(overview::OverviewJob::default()),
            JobName::IntradaySamples => Arc::new(overview::IntradaySamplesJob::default()),
            JobName::Snapshot => Arc::new(snapshot::SnapshotJob::default()),
            JobName::Rankings => Arc::new(rankings::RankingsJob::default()),
        }
    }
}
