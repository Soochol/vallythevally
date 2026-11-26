use serde::{Deserialize, Serialize};
use server::collector::wire::{
    CollectorAlert, CollectorKey, CollectorKeyRole, CollectorKeyState, CollectorKeyUsage, CollectorObservationDay, CollectorPhase, CollectorRenamedStock,
    CollectorRest, CollectorStatus, CollectorStock, CollectorToday, CollectorTrUsage, CollectorUniverseChanges, CollectorVerdict,
};

use crate::keys::KeyRole;
use crate::protocol::KeyName;
use crate::shared::TrMinute;
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

    pub fn to_wire(self) -> CollectorKeyState {
        match self {
            KeyState::Waiting => CollectorKeyState::Waiting,
            KeyState::Connecting => CollectorKeyState::Connecting,
            KeyState::Receiving => CollectorKeyState::Receiving,
            KeyState::Disconnected => CollectorKeyState::Disconnected,
            KeyState::Stopped => CollectorKeyState::Stopped,
            KeyState::HandedOff => CollectorKeyState::HandedOff,
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

    pub fn to_wire(self) -> CollectorPhase {
        match self {
            DayPhase::OffHours => CollectorPhase::OffHours,
            DayPhase::MorningPrep => CollectorPhase::MorningPrep,
            DayPhase::Collecting => CollectorPhase::Collecting,
            DayPhase::AfterClose => CollectorPhase::AfterClose,
            DayPhase::Finalizing => CollectorPhase::Finalizing,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<KeyUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyUsage {
    pub minute_start: i64,
    pub key_max_per_second: u32,
    pub trs: Vec<TrMinute>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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
    SharedJobMoved,
}

impl AlertKind {
    pub fn label(self) -> &'static str {
        match self {
            AlertKind::Excluded => "수집 제외",
            AlertKind::PlanNote => "계획 메모",
            AlertKind::Handoff => "인계",
            AlertKind::HandoffSkipped => "인계 건너뜀",
            AlertKind::KeyStopped => "키 멈춤",
            AlertKind::RegisterFailed => "등록 실패",
            AlertKind::MarketOpenMissing => "장 시작 확인 실패",
            AlertKind::ObservationUnknown => "관측일 판단 모름",
            AlertKind::IndexMismatch => "지수 대조 불일치",
            AlertKind::StageFailed => "단계 실패",
            AlertKind::SharedJobMoved => "공용 자료 일 이동",
        }
    }

    pub fn is_note(self) -> bool {
        matches!(self, AlertKind::Excluded | AlertKind::PlanNote)
    }

    pub fn wire_name(self) -> &'static str {
        match self {
            AlertKind::Excluded => "excluded",
            AlertKind::PlanNote => "plan_note",
            AlertKind::Handoff => "handoff",
            AlertKind::HandoffSkipped => "handoff_skipped",
            AlertKind::KeyStopped => "key_stopped",
            AlertKind::RegisterFailed => "register_failed",
            AlertKind::MarketOpenMissing => "market_open_missing",
            AlertKind::ObservationUnknown => "observation_unknown",
            AlertKind::IndexMismatch => "index_mismatch",
            AlertKind::StageFailed => "stage_failed",
            AlertKind::SharedJobMoved => "shared_job_moved",
        }
    }
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

    pub fn to_wire(&self) -> CollectorStatus {
        CollectorStatus {
            date: self.date,
            phase: self.phase.to_wire(),
            today: self.today.to_wire(),
            keys: self.keys.iter().map(KeyStatus::to_wire).collect(),
            universe_changes: self.universe_changes.as_ref().map(diff_to_wire),
            observation_day: self.observation_day.as_ref().map(ObservationDay::to_wire),
            alerts: self.alerts.iter().map(Alert::to_wire).collect(),
        }
    }
}

fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn key_role_to_wire(role: KeyRole) -> CollectorKeyRole {
    match role {
        KeyRole::Collecting => CollectorKeyRole::Collecting,
        KeyRole::Spare => CollectorKeyRole::Spare,
        KeyRole::Rest => CollectorKeyRole::Rest,
    }
}

impl RestProgress {
    pub fn to_wire(self) -> CollectorRest {
        CollectorRest {
            planned_jobs: usize_to_u32(self.planned_jobs),
            finished_jobs: usize_to_u32(self.finished_jobs),
        }
    }
}

impl KeyUsage {
    pub fn to_wire(&self) -> CollectorKeyUsage {
        CollectorKeyUsage {
            minute_start: self.minute_start,
            key_max_per_second: self.key_max_per_second,
            trs: self
                .trs
                .iter()
                .map(|tr| CollectorTrUsage {
                    tr: tr.tr.clone(),
                    sent: tr.sent,
                    rate_limited: tr.rate_limited,
                    resent: tr.resent,
                    max_wait_ms: tr.max_wait_ms,
                    max_per_second: tr.max_per_second,
                })
                .collect(),
        }
    }
}

impl KeyStatus {
    pub fn to_wire(&self) -> CollectorKey {
        CollectorKey {
            name: self.name.as_str().to_owned(),
            app_key_hash_prefix: self.app_key_hash_prefix.clone(),
            role: key_role_to_wire(self.role),
            state: self.state.to_wire(),
            stocks: usize_to_u32(self.stocks),
            messages_per_second: self.messages_per_second,
            register_failures: usize_to_u32(self.register_failures),
            restarts: self.restarts,
            rest: self.rest.to_wire(),
            usage: self.usage.as_ref().map(KeyUsage::to_wire),
        }
    }
}

impl Today {
    pub fn to_wire(self) -> CollectorToday {
        CollectorToday {
            planned_stocks: usize_to_u32(self.planned_stocks),
            receiving_stocks: usize_to_u32(self.receiving_stocks),
            register_failed_batches: usize_to_u32(self.register_failed_batches),
            disconnected_stocks: usize_to_u32(self.disconnected_stocks),
            handed_off_stocks: usize_to_u32(self.handed_off_stocks),
            excluded_stocks: usize_to_u32(self.excluded_stocks),
        }
    }
}

impl Alert {
    pub fn to_wire(&self) -> CollectorAlert {
        CollectorAlert {
            at: self.at.clone(),
            kind: self.kind.wire_name().to_owned(),
            message: self.message.clone(),
        }
    }
}

impl ObservationVerdict {
    pub fn to_wire(self) -> CollectorVerdict {
        match self {
            ObservationVerdict::Observed => CollectorVerdict::Observed,
            ObservationVerdict::NotObserved => CollectorVerdict::NotObserved,
            ObservationVerdict::Unknown => CollectorVerdict::Unknown,
        }
    }
}

impl ObservationDay {
    pub fn to_wire(&self) -> CollectorObservationDay {
        CollectorObservationDay {
            verdict: self.verdict.to_wire(),
            reasons: self.reasons.clone(),
        }
    }
}

fn diff_to_wire(diff: &Diff) -> CollectorUniverseChanges {
    let stocks = |items: &[crate::universe::Named]| {
        items.iter().map(|item| CollectorStock { code: item.code.clone(), name: item.name.clone() }).collect()
    };
    CollectorUniverseChanges {
        added: stocks(&diff.added),
        removed: stocks(&diff.removed),
        renamed: diff
            .renamed
            .iter()
            .map(|item| CollectorRenamedStock { code: item.code.clone(), from: item.from.clone(), to: item.to.clone() })
            .collect(),
        halt_started: stocks(&diff.halt_started),
        halt_lifted: stocks(&diff.halt_lifted),
    }
}
