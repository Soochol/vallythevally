use serde::{Deserialize, Serialize};

use crate::keys::KeyRole;
use crate::protocol::KeyName;
use crate::universe::Diff;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyState {
    Waiting,
    Connecting,
    Receiving,
    Disconnected,
    Stopped,
    HandedOff,
}

impl KeyState {
    pub fn label(self) -> &'static str {
        match self {
            KeyState::Waiting => "대기",
            KeyState::Connecting => "연결 중",
            KeyState::Receiving => "받는 중",
            KeyState::Disconnected => "끊김",
            KeyState::Stopped => "멈춤",
            KeyState::HandedOff => "인계됨",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DayPhase {
    OffHours,
    MorningPrep,
    #[default]
    Collecting,
    AfterClose,
    Finalizing,
}

impl DayPhase {
    pub fn label(self) -> &'static str {
        match self {
            DayPhase::OffHours => "장 밖 대기",
            DayPhase::MorningPrep => "아침 준비",
            DayPhase::Collecting => "장중 수집",
            DayPhase::AfterClose => "마감 뒤 처리",
            DayPhase::Finalizing => "정리 중",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RestProgress {
    pub planned_jobs: usize,
    pub finished_jobs: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyStatus {
    pub name: KeyName,
    pub app_key_hash_prefix: String,
    pub role: KeyRole,
    pub state: KeyState,
    pub stocks: usize,
    pub messages_per_second: Option<f64>,
    pub register_failures: usize,
    pub restarts: u32,
    pub rest: RestProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Today {
    pub planned_stocks: usize,
    pub receiving_stocks: usize,
    pub register_failed_batches: usize,
    pub disconnected_stocks: usize,
    pub handed_off_stocks: usize,
    pub excluded_stocks: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    Excluded,
    PlanNote,
    Handoff,
    HandoffSkipped,
    KeyStopped,
    RegisterFailed,
    MarketOpenMissing,
    ObservationUnknown,
    IndexMismatch,
    StageFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alert {
    pub at: String,
    pub kind: AlertKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationVerdict {
    Observed,
    NotObserved,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservationDay {
    pub verdict: ObservationVerdict,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DaemonStatus {
    pub date: u32,
    pub phase: DayPhase,
    pub today: Today,
    pub keys: Vec<KeyStatus>,
    pub universe_changes: Option<Diff>,
    pub observation_day: Option<ObservationDay>,
    pub alerts: Vec<Alert>,
}

impl DaemonStatus {
    pub fn summary(&self) -> String {
        let keys: Vec<String> = self
            .keys
            .iter()
            .map(|key| {
                let rate = key.messages_per_second.map_or_else(|| "-".to_owned(), |rate| format!("{rate:.1}"));
                format!("{}={} 종목 {} 초당 {} 등록실패 {} 재시작 {}", key.name, key.state.label(), key.stocks, rate, key.register_failures, key.restarts)
            })
            .collect();
        format!("{} 상태: {}", self.date, keys.join(" | "))
    }
}
