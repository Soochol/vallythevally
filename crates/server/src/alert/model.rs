use std::collections::BTreeMap;
use std::fmt;

use domain::KstTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    P3Info,
    P2Warning,
    P1Critical,
}

impl Severity {
    pub fn label(self) -> &'static str {
        match self {
            Severity::P1Critical => "P1 장애",
            Severity::P2Warning => "P2 경고",
            Severity::P3Info => "P3 리포트",
        }
    }

    pub fn badge(self) -> &'static str {
        match self {
            Severity::P1Critical => "🔴",
            Severity::P2Warning => "🟡",
            Severity::P3Info => "🔵",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertSource {
    Supervise,
    Financials,
    ServerWatch,
    Systemd,
    Deploy,
}

impl AlertSource {
    pub fn as_str(self) -> &'static str {
        match self {
            AlertSource::Supervise => "supervise",
            AlertSource::Financials => "financials",
            AlertSource::ServerWatch => "server",
            AlertSource::Systemd => "systemd",
            AlertSource::Deploy => "deploy",
        }
    }
}

impl fmt::Display for AlertSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertCode {
    DaemonCrashed,
    DaemonDown,
    DaemonUnresponsive,
    FinancialsCrashed,
    KeyAuthHalted,
    KeyStopped,
    HandoffSkipped,
    SharedJobHalted,
    MarketOpenMissing,
    StageCollectFailed,
    FinalizeFailed,
    DiskCritical,
    FinancialsAuthHalted,
    FinancialsStorageHalted,
    HandoffCompleted,
    SharedJobMoved,
    ChildRestarting,
    RegisterFailed,
    ObservationUnknown,
    IndexMismatch,
    StageDegraded,
    DiskWarning,
    FinancialsRateLimited,
    DeployPromotionFailed,
    MorningBrief,
    DailyCloseReport,
    IncidentResolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyRule {
    pub pending_secs: u64,
    pub backoff_secs: &'static [u64],
    pub escalate_after_secs: Option<u64>,
}

const P1_DEFAULT_BACKOFF: &[u64] = &[1800, 7200, 21600];
const P1_HOURLY_BACKOFF: &[u64] = &[3600, 7200, 21600];
const P1_LONG_BACKOFF: &[u64] = &[7200, 21600];
const P1_AUTH_BACKOFF: &[u64] = &[21600];
const NO_BACKOFF: &[u64] = &[];

impl AlertCode {
    pub fn as_str(self) -> &'static str {
        match self {
            AlertCode::DaemonCrashed => "daemon_crashed",
            AlertCode::DaemonDown => "daemon_down",
            AlertCode::DaemonUnresponsive => "daemon_unresponsive",
            AlertCode::FinancialsCrashed => "financials_crashed",
            AlertCode::KeyAuthHalted => "key_auth_halted",
            AlertCode::KeyStopped => "key_stopped",
            AlertCode::HandoffSkipped => "handoff_skipped",
            AlertCode::SharedJobHalted => "shared_job_halted",
            AlertCode::MarketOpenMissing => "market_open_missing",
            AlertCode::StageCollectFailed => "stage_collect_failed",
            AlertCode::FinalizeFailed => "finalize_failed",
            AlertCode::DiskCritical => "disk_critical",
            AlertCode::FinancialsAuthHalted => "financials_auth_halted",
            AlertCode::FinancialsStorageHalted => "financials_storage_halted",
            AlertCode::HandoffCompleted => "handoff_completed",
            AlertCode::SharedJobMoved => "shared_job_moved",
            AlertCode::ChildRestarting => "child_restarting",
            AlertCode::RegisterFailed => "register_failed",
            AlertCode::ObservationUnknown => "observation_unknown",
            AlertCode::IndexMismatch => "index_mismatch",
            AlertCode::StageDegraded => "stage_degraded",
            AlertCode::DiskWarning => "disk_warning",
            AlertCode::FinancialsRateLimited => "financials_rate_limited",
            AlertCode::DeployPromotionFailed => "deploy_promotion_failed",
            AlertCode::MorningBrief => "morning_brief",
            AlertCode::DailyCloseReport => "daily_close_report",
            AlertCode::IncidentResolved => "incident_resolved",
        }
    }

    pub fn default_severity(self) -> Severity {
        match self {
            AlertCode::DaemonCrashed
            | AlertCode::DaemonDown
            | AlertCode::DaemonUnresponsive
            | AlertCode::FinancialsCrashed
            | AlertCode::KeyAuthHalted
            | AlertCode::KeyStopped
            | AlertCode::HandoffSkipped
            | AlertCode::SharedJobHalted
            | AlertCode::MarketOpenMissing
            | AlertCode::StageCollectFailed
            | AlertCode::FinalizeFailed
            | AlertCode::DiskCritical
            | AlertCode::FinancialsAuthHalted
            | AlertCode::FinancialsStorageHalted => Severity::P1Critical,
            AlertCode::HandoffCompleted
            | AlertCode::SharedJobMoved
            | AlertCode::ChildRestarting
            | AlertCode::RegisterFailed
            | AlertCode::ObservationUnknown
            | AlertCode::IndexMismatch
            | AlertCode::StageDegraded
            | AlertCode::DiskWarning
            | AlertCode::FinancialsRateLimited
            | AlertCode::DeployPromotionFailed => Severity::P2Warning,
            AlertCode::MorningBrief | AlertCode::DailyCloseReport | AlertCode::IncidentResolved => Severity::P3Info,
        }
    }

    pub fn policy(self) -> PolicyRule {
        match self {
            AlertCode::DaemonDown => PolicyRule { pending_secs: 45, backoff_secs: P1_DEFAULT_BACKOFF, escalate_after_secs: None },
            AlertCode::DiskCritical => PolicyRule { pending_secs: 120, backoff_secs: P1_HOURLY_BACKOFF, escalate_after_secs: None },
            AlertCode::DiskWarning => PolicyRule { pending_secs: 120, backoff_secs: NO_BACKOFF, escalate_after_secs: None },
            AlertCode::FinancialsCrashed | AlertCode::SharedJobHalted => PolicyRule { pending_secs: 0, backoff_secs: P1_HOURLY_BACKOFF, escalate_after_secs: None },
            AlertCode::KeyAuthHalted | AlertCode::FinalizeFailed | AlertCode::FinancialsStorageHalted => PolicyRule { pending_secs: 0, backoff_secs: P1_LONG_BACKOFF, escalate_after_secs: None },
            AlertCode::FinancialsAuthHalted => PolicyRule { pending_secs: 0, backoff_secs: P1_AUTH_BACKOFF, escalate_after_secs: None },
            AlertCode::DaemonCrashed
            | AlertCode::DaemonUnresponsive
            | AlertCode::KeyStopped
            | AlertCode::HandoffSkipped
            | AlertCode::MarketOpenMissing
            | AlertCode::StageCollectFailed => PolicyRule { pending_secs: 0, backoff_secs: P1_DEFAULT_BACKOFF, escalate_after_secs: None },
            AlertCode::ChildRestarting => PolicyRule { pending_secs: 0, backoff_secs: NO_BACKOFF, escalate_after_secs: Some(1800) },
            AlertCode::HandoffCompleted
            | AlertCode::SharedJobMoved
            | AlertCode::RegisterFailed
            | AlertCode::ObservationUnknown
            | AlertCode::IndexMismatch
            | AlertCode::StageDegraded
            | AlertCode::FinancialsRateLimited
            | AlertCode::DeployPromotionFailed
            | AlertCode::MorningBrief
            | AlertCode::DailyCloseReport
            | AlertCode::IncidentResolved => PolicyRule { pending_secs: 0, backoff_secs: NO_BACKOFF, escalate_after_secs: None },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Fingerprint {
    pub source: AlertSource,
    pub code: AlertCode,
    pub target: String,
}

impl Fingerprint {
    pub fn new(source: AlertSource, code: AlertCode, target: impl Into<String>) -> Fingerprint {
        Fingerprint { source, code, target: target.into() }
    }

    pub fn short_id(&self) -> String {
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in self.source.as_str().bytes().chain([b':']).chain(self.code.as_str().bytes()).chain([b':']).chain(self.target.bytes()) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("inc-{:08x}", (hash & 0xffff_ffff) as u32)
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}/{}/{}", self.source.as_str(), self.code.as_str(), self.target)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Signal {
    Active,
    Resolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertEvent {
    pub fingerprint: Fingerprint,
    pub severity: Severity,
    pub signal: Signal,
    pub title: String,
    pub summary: String,
    pub metrics: BTreeMap<String, String>,
    pub impact: String,
    pub action: Option<String>,
}

impl AlertEvent {
    pub fn active(source: AlertSource, code: AlertCode, target: impl Into<String>, title: impl Into<String>, summary: impl Into<String>) -> AlertEvent {
        AlertEvent {
            fingerprint: Fingerprint::new(source, code, target),
            severity: code.default_severity(),
            signal: Signal::Active,
            title: title.into(),
            summary: summary.into(),
            metrics: BTreeMap::new(),
            impact: String::new(),
            action: None,
        }
    }

    pub fn resolved(source: AlertSource, code: AlertCode, target: impl Into<String>, title: impl Into<String>, summary: impl Into<String>) -> AlertEvent {
        AlertEvent {
            fingerprint: Fingerprint::new(source, code, target),
            severity: code.default_severity(),
            signal: Signal::Resolved,
            title: title.into(),
            summary: summary.into(),
            metrics: BTreeMap::new(),
            impact: String::new(),
            action: None,
        }
    }

    pub fn with_severity(mut self, severity: Severity) -> AlertEvent {
        self.severity = severity;
        self
    }

    pub fn with_metric(mut self, key: impl Into<String>, value: impl Into<String>) -> AlertEvent {
        self.metrics.insert(key.into(), value.into());
        self
    }

    pub fn with_impact(mut self, impact: impl Into<String>) -> AlertEvent {
        self.impact = impact.into();
        self
    }

    pub fn with_action(mut self, action: impl Into<String>) -> AlertEvent {
        self.action = Some(action.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketPhase {
    #[default]
    OffHours,
    MorningPrep,
    Collecting,
    AfterClose,
    Finalizing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketObservation {
    #[default]
    Observed,
    NotObserved,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketContext {
    pub date: u32,
    pub phase: MarketPhase,
    pub observation: MarketObservation,
}

impl MarketContext {
    pub fn new(date: u32, phase: MarketPhase, observation: MarketObservation) -> MarketContext {
        MarketContext { date, phase, observation }
    }

    pub fn is_quiet_hours(self) -> bool {
        self.observation == MarketObservation::NotObserved || self.phase == MarketPhase::OffHours
    }

    pub fn is_after_close_window(self) -> bool {
        matches!(self.phase, MarketPhase::AfterClose | MarketPhase::Finalizing)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchKind {
    Fired,
    Escalated,
    Reminder,
    Resolved,
    Digest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertDispatch {
    pub kind: DispatchKind,
    pub fingerprint: Fingerprint,
    pub severity: Severity,
    pub title: String,
    pub summary: String,
    pub metrics: BTreeMap<String, String>,
    pub impact: String,
    pub action: Option<String>,
    pub observed_at: KstTime,
    pub duration_secs: Option<u64>,
    pub suppressed_count: u64,
    pub silent: bool,
}
