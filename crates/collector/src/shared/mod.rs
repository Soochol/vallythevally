use std::sync::Arc;

use serde::{Deserialize, Serialize};

mod assignment;
pub mod child;
mod job;
mod probe;
pub mod rankings;
mod runner;
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
}

impl JobName {
    pub fn job(self) -> Arc<dyn SharedJob> {
        match self {
            JobName::Probe => Arc::new(probe::ProbeJob),
        }
    }
}
