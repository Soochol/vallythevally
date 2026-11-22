use serde::{Deserialize, Serialize};

use super::JobName;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrMinute {
    pub tr: String,
    pub sent: u32,
    pub rate_limited: u32,
    pub resent: u32,
    pub max_wait_ms: u64,
    pub max_per_second: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobStat {
    pub job: JobName,
    pub runs: u64,
    pub overruns: u64,
    pub last_error: Option<String>,
}
