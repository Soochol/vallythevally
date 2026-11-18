use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const FORMAT_VERSION: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CollectorPhase {
    OffHours,
    MorningPrep,
    Collecting,
    AfterClose,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CollectorKeyRole {
    Collecting,
    Spare,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CollectorKeyState {
    Waiting,
    Connecting,
    Receiving,
    Disconnected,
    Stopped,
    HandedOff,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorToday {
    pub planned_stocks: u32,
    pub receiving_stocks: u32,
    pub register_failed_batches: u32,
    pub disconnected_stocks: u32,
    pub handed_off_stocks: u32,
    pub excluded_stocks: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorRest {
    pub planned_jobs: u32,
    pub finished_jobs: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorKey {
    pub name: String,
    pub app_key_hash_prefix: String,
    pub role: CollectorKeyRole,
    pub state: CollectorKeyState,
    pub stocks: u32,
    pub messages_per_second: Option<f64>,
    pub register_failures: u32,
    pub restarts: u32,
    pub rest: CollectorRest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorStock {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorRenamedStock {
    pub code: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorUniverseChanges {
    pub added: Vec<CollectorStock>,
    pub removed: Vec<CollectorStock>,
    pub renamed: Vec<CollectorRenamedStock>,
    pub halt_started: Vec<CollectorStock>,
    pub halt_lifted: Vec<CollectorStock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CollectorVerdict {
    Observed,
    NotObserved,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorObservationDay {
    pub verdict: CollectorVerdict,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorAlert {
    pub at: String,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorStatus {
    pub date: u32,
    pub phase: CollectorPhase,
    pub today: CollectorToday,
    pub keys: Vec<CollectorKey>,
    pub universe_changes: Option<CollectorUniverseChanges>,
    pub observation_day: Option<CollectorObservationDay>,
    pub alerts: Vec<CollectorAlert>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CollectorDayState {
    Complete,
    Incomplete,
    InProgress,
    Unreadable,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorCoverageDay {
    pub date: u32,
    pub state: CollectorDayState,
    pub verified: Option<bool>,
    pub planned_stocks: Option<u32>,
    pub received_stocks: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorCoverage {
    pub sent_at: String,
    pub days: Vec<CollectorCoverageDay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorFilesystem {
    #[ts(type = "number")]
    pub free_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorDayBytes {
    pub date: u32,
    #[ts(type = "number")]
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorDiskUsage {
    pub filesystem: Option<CollectorFilesystem>,
    pub raw: Vec<CollectorDayBytes>,
    pub store: Vec<CollectorDayBytes>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CollectorDisk {
    pub sent_at: String,
    pub disk: CollectorDiskUsage,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StatusReply {
    pub sent_at: String,
    pub status: CollectorStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Heartbeat {
    pub sequence: u64,
    pub phase: CollectorPhase,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DaemonError {
    pub code: String,
    pub message: String,
    pub supported_version: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    Status(Box<StatusReply>),
    Heartbeat(Heartbeat),
    Coverage(CollectorCoverage),
    Disk(CollectorDisk),
    Error(DaemonError),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Reply(Reply),
    Incompatible,
    Malformed,
}

#[derive(Deserialize)]
struct Header {
    v: serde_json::Value,
}

impl Line {
    pub fn parse(bytes: &[u8]) -> Line {
        let Ok(header) = serde_json::from_slice::<Header>(bytes) else { return Line::Malformed };
        if header.v.as_u64() != Some(FORMAT_VERSION) {
            return Line::Incompatible;
        }
        serde_json::from_slice(bytes).map_or(Line::Malformed, Line::Reply)
    }
}

pub const WATCH_REQUEST: &[u8] = b"{\"v\":1,\"type\":\"watch\"}\n";
pub const COVERAGE_REQUEST: &[u8] = b"{\"v\":1,\"type\":\"coverage\"}\n";
pub const DISK_REQUEST: &[u8] = b"{\"v\":1,\"type\":\"disk\"}\n";
