use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::calendar::{Evidence, Mismatch};
use crate::supervise::journal_path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JudgedVerdict {
    Observed,
    Closed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TreatedAs {
    Observed,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JudgmentSummary {
    pub day: u32,
    pub verdict: JudgedVerdict,
    pub open_minute: Option<u16>,
    pub treated_as: TreatedAs,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum MarketOpenSummary {
    Seen { key: String, deadline: String },
    Missing { deadline: String },
    NotChecked { reason: String },
    NotRecorded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexCheckResult {
    Agrees,
    Disagrees,
    Undetermined,
    Failed,
    NotRecorded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexCheckSummary {
    pub result: IndexCheckResult,
    pub mismatch: Option<Mismatch>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObservationSummary {
    pub judgment: Option<JudgmentSummary>,
    pub market_open: MarketOpenSummary,
    pub index_check: IndexCheckSummary,
}

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum ObservationEvent {
    ObservationJudged(JudgmentSummary),
    MarketOpenSeen { key: String, deadline: String },
    MarketOpenMissing { deadline: String },
    MarketOpenNotChecked { reason: String },
    IndexChecked { result: IndexCheckResult, mismatch: Option<Mismatch>, detail: Option<String> },
}

pub fn read_observation(data_dir: &Path, date: u32) -> io::Result<ObservationSummary> {
    let text = match std::fs::read_to_string(journal_path(data_dir, date)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let events = text.lines().filter_map(|line| serde_json::from_str::<ObservationEvent>(line).ok());
    Ok(summarize(events))
}

fn summarize(events: impl Iterator<Item = ObservationEvent>) -> ObservationSummary {
    let mut judgment = None;
    let mut seen = None;
    let mut other_open = None;
    let mut index_check = IndexCheckSummary { result: IndexCheckResult::NotRecorded, mismatch: None, detail: None };
    for event in events {
        match event {
            ObservationEvent::ObservationJudged(summary) => judgment = Some(summary),
            ObservationEvent::MarketOpenSeen { key, deadline } => seen = Some(MarketOpenSummary::Seen { key, deadline }),
            ObservationEvent::MarketOpenMissing { deadline } => other_open = Some(MarketOpenSummary::Missing { deadline }),
            ObservationEvent::MarketOpenNotChecked { reason } => other_open = Some(MarketOpenSummary::NotChecked { reason }),
            ObservationEvent::IndexChecked { result, mismatch, detail } => index_check = IndexCheckSummary { result, mismatch, detail },
        }
    }
    ObservationSummary { judgment, market_open: seen.or(other_open).unwrap_or(MarketOpenSummary::NotRecorded), index_check }
}
