use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use server::alert::{
    AlertCode, AlertEvent, AlertPipeline, AlertRouter, AlertSink, AlertSource, Fingerprint, MarketContext, MarketObservation, MarketPhase, Severity, StateStore, TelegramSink,
};
use server::clock::Clock;
use server::collector::telegram::Telegram;

use super::files::{read_coverage, read_disk};
use super::status::{Alert, AlertKind, DaemonStatus, DayPhase, KeyState, ObservationDay, ObservationVerdict};
use super::wire::{CoverageState, DiskUsage, Filesystem};
use crate::keys::KeyRole;

const GIB: u64 = 1024 * 1024 * 1024;
const DISK_WARN_PCT: f64 = 80.0;
const DISK_WARN_FREE_BYTES: u64 = 120 * GIB;
const DISK_WARN_RECOVER_PCT: f64 = 75.0;
const DISK_WARN_RECOVER_FREE_BYTES: u64 = 140 * GIB;
const DISK_CRIT_PCT: f64 = 90.0;
const DISK_CRIT_FREE_BYTES: u64 = 50 * GIB;
const DISK_CRIT_RECOVER_PCT: f64 = 85.0;
const DISK_CRIT_RECOVER_FREE_BYTES: u64 = 70 * GIB;
const CHILD_RESTART_WARN_THRESHOLD: u32 = 3;
const CRASH_MARKER_FILE: &str = "last-crash-unix";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DiskLevel {
    #[default]
    Normal,
    Warning,
    Critical,
}

pub fn market_phase(phase: DayPhase) -> MarketPhase {
    match phase {
        DayPhase::OffHours => MarketPhase::OffHours,
        DayPhase::MorningPrep => MarketPhase::MorningPrep,
        DayPhase::Collecting => MarketPhase::Collecting,
        DayPhase::AfterClose => MarketPhase::AfterClose,
        DayPhase::Finalizing => MarketPhase::Finalizing,
    }
}

pub fn market_observation(observation: Option<&ObservationDay>) -> MarketObservation {
    match observation.map(|day| day.verdict) {
        Some(ObservationVerdict::Observed) => MarketObservation::Observed,
        Some(ObservationVerdict::NotObserved) => MarketObservation::NotObserved,
        Some(ObservationVerdict::Unknown) | None => MarketObservation::Unknown,
    }
}

pub fn used_percent(fs: &Filesystem) -> f64 {
    if fs.total_bytes == 0 {
        return 0.0;
    }
    let used = fs.total_bytes.saturating_sub(fs.free_bytes);
    (used as f64 / fs.total_bytes as f64) * 100.0
}

pub fn evaluate_disk_level(fs: &Filesystem, current: DiskLevel) -> DiskLevel {
    let pct = used_percent(fs);
    let free = fs.free_bytes;
    let is_crit = pct >= DISK_CRIT_PCT || free < DISK_CRIT_FREE_BYTES;
    let is_warn = pct >= DISK_WARN_PCT || free < DISK_WARN_FREE_BYTES;
    match current {
        DiskLevel::Normal => {
            if is_crit {
                DiskLevel::Critical
            } else if is_warn {
                DiskLevel::Warning
            } else {
                DiskLevel::Normal
            }
        }
        DiskLevel::Warning => {
            if is_crit {
                DiskLevel::Critical
            } else if pct <= DISK_WARN_RECOVER_PCT && free >= DISK_WARN_RECOVER_FREE_BYTES {
                DiskLevel::Normal
            } else {
                DiskLevel::Warning
            }
        }
        DiskLevel::Critical => {
            if pct <= DISK_WARN_RECOVER_PCT && free >= DISK_WARN_RECOVER_FREE_BYTES {
                DiskLevel::Normal
            } else if pct <= DISK_CRIT_RECOVER_PCT && free >= DISK_CRIT_RECOVER_FREE_BYTES {
                DiskLevel::Warning
            } else {
                DiskLevel::Critical
            }
        }
    }
}

fn format_gib(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / GIB as f64)
}

fn leading_key_target(message: &str) -> String {
    let first = message.split_whitespace().next().unwrap_or("unknown");
    for suffix in ["를", "을", "의", "가", "이", "은", "는"] {
        if let Some(stripped) = first.strip_suffix(suffix)
            && !stripped.is_empty()
        {
            return stripped.to_owned();
        }
    }
    first.to_owned()
}

fn shared_job_target(message: &str) -> String {
    if let Some((_, rest)) = message.split_once("의 일 ")
        && let Some(job) = rest.split_whitespace().next()
    {
        return job.trim_end_matches(['을', '를']).to_owned();
    }
    leading_key_target(message)
}

fn classify_stage_failed(date: u32, message: &str) -> (AlertCode, String, String, String) {
    if message.starts_with("정리:") {
        if message.contains("nice") || message.contains("ionice") {
            return (
                AlertCode::StageDegraded,
                "finalize_priority".to_owned(),
                "정리 우선순위 도구 없음".to_owned(),
                "which nice ionice 로 util-linux 설치 확인".to_owned(),
            );
        }
        return (
            AlertCode::FinalizeFailed,
            format!("finalize:{date}"),
            format!("{date} 마감 정리 실패"),
            format!("collector finalize --data ~/vally-data/hoga --date {date} --verify-only"),
        );
    }
    if message.contains("특일정보") {
        return (
            AlertCode::StageDegraded,
            "holiday_key".to_owned(),
            "특일정보 서비스 키 읽기 실패".to_owned(),
            "ls -l ~/.config/vally/holiday-service-key 확인".to_owned(),
        );
    }
    if message.contains("키 배정표") {
        return (
            AlertCode::StageDegraded,
            "shared_assignment".to_owned(),
            "공용 자료 키 배정표 읽기 실패".to_owned(),
            "~/.config/vally/collector-shared.json 구문 점검".to_owned(),
        );
    }
    if message.starts_with("분 호가 채우기:") {
        return (
            AlertCode::StageDegraded,
            format!("quote_backfill:{date}"),
            "분 호가 백필 실패".to_owned(),
            "journalctl --user -u vally-collector -n 50".to_owned(),
        );
    }
    if message.starts_with("토큰 재발급") {
        let target = message.split(':').next().unwrap_or("token_reissue").trim().replace(' ', "_");
        return (
            AlertCode::StageDegraded,
            target,
            "마감 뒤 토큰 재발급 실패".to_owned(),
            "collector status --state ~/.local/state/vallythevally/collector".to_owned(),
        );
    }
    if message.starts_with("지수 일봉 대조:") {
        return (
            AlertCode::StageDegraded,
            format!("index_check:{date}"),
            "코스피 지수 일봉 대조 실패".to_owned(),
            "journalctl --user -u vally-collector -n 50".to_owned(),
        );
    }
    if message.starts_with("거래대금:") || message.starts_with("마감 뒤") {
        let stage = message.split(':').next().unwrap_or("after_close").trim().replace(' ', "_");
        return (
            AlertCode::StageDegraded,
            format!("{stage}:{date}"),
            "마감 뒤 REST 작업 실패".to_owned(),
            "journalctl --user -u vally-collector -n 50".to_owned(),
        );
    }
    let stage = message.split(':').next().unwrap_or("stage").trim().replace(' ', "_");
    (
        AlertCode::StageCollectFailed,
        format!("{stage}:{date}"),
        format!("수집 단계 실패 ({stage})"),
        "collector status --state ~/.local/state/vallythevally/collector && journalctl --user -u vally-collector -n 50".to_owned(),
    )
}

pub fn classify_alert(date: u32, alert: &Alert) -> AlertEvent {
    let message = alert.message.as_str();
    match alert.kind {
        AlertKind::KeyStopped => {
            let target = leading_key_target(message);
            let is_auth = message.contains("8050") || message.contains("인증");
            let code = if is_auth { AlertCode::KeyAuthHalted } else { AlertCode::KeyStopped };
            let title = if is_auth { format!("{target} 인증 차단으로 정지") } else { format!("{target} 수집 키 정지") };
            let action = if is_auth {
                "키움 포털에 현재 공인 IP 등록 후 collector status 확인"
            } else {
                "journalctl --user -u vally-collector -n 50 && collector status"
            };
            AlertEvent::active(AlertSource::Supervise, code, target, title, message)
                .with_impact("해당 키의 실시간 수집 또는 REST 작업이 멈췄습니다")
                .with_action(action)
        }
        AlertKind::Handoff => {
            let target = leading_key_target(message);
            AlertEvent::active(AlertSource::Supervise, AlertCode::HandoffCompleted, target, "예비 키 인계 완료", message)
                .with_impact("수집 결손은 없으나 남은 예비 키 여유가 0개입니다")
                .with_action("정지된 원 키의 원인을 점검하세요 (collector status)")
        }
        AlertKind::HandoffSkipped => {
            let target = leading_key_target(message);
            AlertEvent::active(AlertSource::Supervise, AlertCode::HandoffSkipped, target, "예비 키 인계 실패 — 종목 수집 중단", message)
                .with_impact("해당 키에 배정된 종목의 실시간 호가·체결 수집이 끊긴 상태입니다")
                .with_action("키움 포털 공인 IP 및 키 상태 즉시 점검 (collector status)")
        }
        AlertKind::RegisterFailed => {
            let target = leading_key_target(message);
            AlertEvent::active(AlertSource::Supervise, AlertCode::RegisterFailed, target, "실시간 종목 등록 실패", message)
                .with_impact("실패한 배치 종목은 실시간 시세가 누락될 수 있습니다")
                .with_action("journalctl --user -u vally-collector -n 40")
        }
        AlertKind::MarketOpenMissing => AlertEvent::active(AlertSource::Supervise, AlertCode::MarketOpenMissing, format!("market_open:{date}"), "장 시작 신호(0s) 미수신", message)
            .with_impact("관측일 개장 확인이 되지 않았습니다 (임시 휴장 또는 키움 세션 이상)")
            .with_action("임시 휴장 여부 확인 후 필요 시 calendar/overrides.json 보정"),
        AlertKind::ObservationUnknown => AlertEvent::active(AlertSource::Supervise, AlertCode::ObservationUnknown, format!("calendar:{date}"), "관측일 판단 불가 — 관측일 간주 진행", message)
            .with_impact("달력 캐시 부재로 관측일로 간주해 수집을 진행합니다")
            .with_action("holiday-service-key 와 calendar/overrides.json 점검"),
        AlertKind::IndexMismatch => AlertEvent::active(AlertSource::Supervise, AlertCode::IndexMismatch, format!("index:{date}"), "관측일 판단 vs 코스피 지수 일봉 불일치", message)
            .with_impact("휴장일/개장일 판정이 실제 거래소와 달랐습니다")
            .with_action("calendar/overrides.json 에 해당 날짜 보정 기록"),
        AlertKind::SharedJobMoved => {
            let target = shared_job_target(message);
            if message.contains("이어받을 키가 없") {
                AlertEvent::active(AlertSource::Supervise, AlertCode::SharedJobHalted, target, "공용 자료 작업 중단 — 대체 REST 키 없음", message)
                    .with_impact("해당 공용 자료(순위·시세·개요 등) 갱신이 멈췄습니다")
                    .with_action("collector-shared.json 및 REST 키 상태 확인 (collector status)")
            } else {
                AlertEvent::active(AlertSource::Supervise, AlertCode::SharedJobMoved, target, "공용 자료 작업 다른 REST 키로 이전", message)
                    .with_impact("작업은 유지되나 기존 REST 키의 장애 원인을 확인해야 합니다")
                    .with_action("collector status --state ~/.local/state/vallythevally/collector")
            }
        }
        AlertKind::StageFailed => {
            let (code, target, title, action) = classify_stage_failed(date, message);
            let impact = if code == AlertCode::FinalizeFailed {
                "그날 원문의 Parquet 병합 또는 대조가 완료되지 않았습니다"
            } else if code == AlertCode::StageDegraded {
                "폴백 상태로 계속 진행하거나 다음 정리 기회에 재시도합니다"
            } else {
                "해당 단계가 실패해 당일 수집이 불완전할 수 있습니다"
            };
            AlertEvent::active(AlertSource::Supervise, code, target, title, message)
                .with_impact(impact)
                .with_action(action)
        }
        AlertKind::Excluded | AlertKind::PlanNote => {
            AlertEvent::active(AlertSource::Supervise, AlertCode::MorningBrief, format!("note:{date}"), alert.kind.label(), message)
        }
    }
}

#[derive(Default)]
struct Tracker {
    notes_date: u32,
    notes: Vec<String>,
    disk_level: DiskLevel,
    crash_checked: bool,
}

type DiskProbe = Arc<dyn Fn(&Path) -> DiskUsage + Send + Sync>;

#[derive(Clone)]
pub struct AlertTelegram {
    pipeline: AlertPipeline,
    tracker: Arc<Mutex<Tracker>>,
    state_folder: PathBuf,
    clock: Clock,
    disk_probe: DiskProbe,
}

impl AlertTelegram {
    pub fn spawn(telegram: Telegram, state_folder: &Path) -> AlertTelegram {
        AlertTelegram::spawn_with_clock(telegram, state_folder, Clock::system())
    }

    pub fn spawn_with_clock(telegram: Telegram, state_folder: &Path, clock: Clock) -> AlertTelegram {
        let sink: Arc<dyn AlertSink> = Arc::new(TelegramSink::new(telegram));
        AlertTelegram::spawn_with_sink(sink, state_folder, clock)
    }

    pub fn spawn_with_sink(sink: Arc<dyn AlertSink>, state_folder: &Path, clock: Clock) -> AlertTelegram {
        let store = StateStore::in_folder(state_folder, "supervise");
        let pipeline = AlertPipeline::spawn(AlertRouter::single(sink), Some(store), clock.clone());
        AlertTelegram {
            pipeline,
            tracker: Arc::new(Mutex::new(Tracker::default())),
            state_folder: state_folder.to_path_buf(),
            clock,
            disk_probe: Arc::new(read_disk),
        }
    }

    pub fn with_disk_probe(mut self, probe: impl Fn(&Path) -> DiskUsage + Send + Sync + 'static) -> AlertTelegram {
        self.disk_probe = Arc::new(probe);
        self
    }

    fn tracker(&self) -> std::sync::MutexGuard<'_, Tracker> {
        self.tracker.lock().expect("수집 경보 상태 잠금")
    }

    pub(super) fn resolve_pending_crash(&self, ctx: MarketContext) {
        {
            let mut tracker = self.tracker();
            if tracker.crash_checked {
                return;
            }
            tracker.crash_checked = true;
        }
        let marker = self.state_folder.join(CRASH_MARKER_FILE);
        let Ok(raw) = std::fs::read_to_string(&marker) else { return };
        let _ = std::fs::remove_file(&marker);
        let crashed_at = raw.trim().parse::<i64>().ok();
        let downtime = crashed_at.map(|unix| self.clock.now().unix().saturating_sub(unix).max(0) as u64);
        let summary = match downtime {
            Some(secs) => format!("비정상 종료 후 감독 데몬이 자동 재기동됐습니다 (다운타임 {})", server::alert::format_duration(secs)),
            None => "비정상 종료 후 감독 데몬이 자동 재기동됐습니다".to_owned(),
        };
        let event = AlertEvent::active(AlertSource::Systemd, AlertCode::DaemonCrashed, "vally-collector", "감독 데몬 자동 재기동 정상화", summary)
            .with_severity(Severity::P3Info);
        let key = format!("crash_recovered:{}", crashed_at.unwrap_or(0));
        self.pipeline.emit_digest(&key, event, MarketContext::new(ctx.date, ctx.phase, MarketObservation::Observed));
    }

    pub(super) fn alert(&self, ctx: MarketContext, alert: &Alert) {
        if alert.kind.is_note() {
            let mut tracker = self.tracker();
            if tracker.notes_date != ctx.date {
                tracker.notes_date = ctx.date;
                tracker.notes.clear();
            }
            if !tracker.notes.contains(&alert.message) {
                tracker.notes.push(alert.message.clone());
            }
            return;
        }
        let event = classify_alert(ctx.date, alert);
        self.pipeline.emit(event, ctx);
    }

    pub(super) fn observe_status(&self, ctx: MarketContext, status: &DaemonStatus) {
        for key in &status.keys {
            let target = key.name.to_string();
            if key.restarts >= CHILD_RESTART_WARN_THRESHOLD && key.state != KeyState::Stopped {
                let event = AlertEvent::active(
                    AlertSource::Supervise,
                    AlertCode::ChildRestarting,
                    target.clone(),
                    format!("{target} 자식 프로세스 재시작 반복"),
                    format!("당일 재시작 {}회 도달 (5회 초과 시 키 정지)", key.restarts),
                )
                .with_impact("재시작 한도에 근접했습니다")
                .with_action("journalctl --user -u vally-collector -n 40");
                self.pipeline.emit(event, ctx);
            }
            if key.state == KeyState::Receiving {
                for code in [AlertCode::ChildRestarting, AlertCode::KeyStopped, AlertCode::KeyAuthHalted] {
                    let fp = Fingerprint::new(AlertSource::Supervise, code, target.clone());
                    if self.pipeline.has_active(&fp) {
                        let resolved = AlertEvent::resolved(
                            AlertSource::Supervise,
                            code,
                            target.clone(),
                            format!("{target} 정상 수신 재개"),
                            format!("{}종목 실시간 수신 중", key.stocks),
                        );
                        self.pipeline.emit(resolved, ctx);
                    }
                }
            }
        }
    }

    pub(super) fn check_disk(&self, data_dir: &Path, ctx: MarketContext) {
        let disk = (self.disk_probe)(data_dir);
        self.check_disk_usage(&disk, ctx);
    }

    pub fn check_disk_usage(&self, disk: &DiskUsage, ctx: MarketContext) {
        let Some(fs) = &disk.filesystem else { return };
        let previous = self.tracker().disk_level;
        let next = evaluate_disk_level(fs, previous);
        self.tracker().disk_level = next;

        let pct = used_percent(fs);
        let raw_bytes: u64 = disk.raw.iter().map(|d| d.bytes).sum();
        let store_bytes: u64 = disk.store.iter().map(|d| d.bytes).sum();

        match next {
            DiskLevel::Critical => {
                if self.pipeline.has_active(&Fingerprint::new(AlertSource::Supervise, AlertCode::DiskWarning, "disk:data")) {
                    let clear_warn = AlertEvent::resolved(AlertSource::Supervise, AlertCode::DiskWarning, "disk:data", "디스크 경고에서 임계로 승격", "P1 임계 경보로 전환됐습니다");
                    self.pipeline.emit(clear_warn, ctx);
                }
                let event = AlertEvent::active(
                    AlertSource::Supervise,
                    AlertCode::DiskCritical,
                    "disk:data",
                    "데이터 디스크 임계 — 원문 쓰기 중단 위험",
                    format!("사용률 {pct:.1}% · 잔여 {} / {}", format_gib(fs.free_bytes), format_gib(fs.total_bytes)),
                )
                .with_metric("원문(raw)", format_gib(raw_bytes))
                .with_metric("저장소(store)", format_gib(store_bytes))
                .with_impact("오늘 원문 쓰기 또는 마감 finalize 임시 공간 부족 위험")
                .with_action("df -h ~/vally-data/hoga && grep '\"action\":\"kept\"' ~/vally-data/hoga/store/prune.log.jsonl | tail");
                self.pipeline.emit(event, ctx);
            }
            DiskLevel::Warning => {
                if self.pipeline.has_active(&Fingerprint::new(AlertSource::Supervise, AlertCode::DiskCritical, "disk:data")) {
                    let clear_crit = AlertEvent::resolved(
                        AlertSource::Supervise,
                        AlertCode::DiskCritical,
                        "disk:data",
                        "데이터 디스크 임계 해소",
                        format!("사용률 {pct:.1}% · 잔여 {} (경고 구간으로 완화)", format_gib(fs.free_bytes)),
                    );
                    self.pipeline.emit(clear_crit, ctx);
                }
                let event = AlertEvent::active(
                    AlertSource::Supervise,
                    AlertCode::DiskWarning,
                    "disk:data",
                    "데이터 디스크 사용량 경고",
                    format!("사용률 {pct:.1}% · 잔여 {} / {}", format_gib(fs.free_bytes), format_gib(fs.total_bytes)),
                )
                .with_metric("원문(raw)", format_gib(raw_bytes))
                .with_metric("저장소(store)", format_gib(store_bytes))
                .with_impact("90% 이상 또는 잔여 50 GB 미만 시 P1 장애로 승격됩니다")
                .with_action("du -sh ~/vally-data/hoga/* && tail -n 10 ~/vally-data/hoga/store/prune.log.jsonl");
                self.pipeline.emit(event, ctx);
            }
            DiskLevel::Normal => {
                for code in [AlertCode::DiskCritical, AlertCode::DiskWarning] {
                    let fp = Fingerprint::new(AlertSource::Supervise, code, "disk:data");
                    if self.pipeline.has_active(&fp) {
                        let resolved = AlertEvent::resolved(
                            AlertSource::Supervise,
                            code,
                            "disk:data",
                            "데이터 디스크 여유 공간 회복",
                            format!("사용률 {pct:.1}% · 잔여 {}", format_gib(fs.free_bytes)),
                        );
                        self.pipeline.emit(resolved, ctx);
                    }
                }
            }
        }
    }

    pub(super) fn morning_brief(&self, ctx: MarketContext, status: &DaemonStatus, data_dir: &Path) {
        let notes = {
            let mut tracker = self.tracker();
            if tracker.notes_date == ctx.date {
                std::mem::take(&mut tracker.notes)
            } else {
                Vec::new()
            }
        };
        let deferred = self.pipeline.take_deferred_p2();
        let disk = (self.disk_probe)(data_dir);

        let collecting_total = status.keys.iter().filter(|k| k.role == KeyRole::Collecting).count();
        let collecting_live = status.keys.iter().filter(|k| k.role == KeyRole::Collecting && k.state == KeyState::Receiving).count();
        let spare_total = status.keys.iter().filter(|k| k.role == KeyRole::Spare).count();
        let rest_total = status.keys.iter().filter(|k| k.role == KeyRole::Rest).count();

        let mut summary_parts = vec![format!("관측일 {} 수집 준비 완료", ctx.date)];
        if !notes.is_empty() {
            summary_parts.push(format!("계획 메모 {}건: {}", notes.len(), notes.join(" / ")));
        }
        if !deferred.is_empty() {
            let items: Vec<String> = deferred.iter().map(|item| item.title.clone()).collect();
            summary_parts.push(format!("야간·휴장일 지연 경고 {}건: {}", deferred.len(), items.join(", ")));
        }

        let mut event = AlertEvent::active(
            AlertSource::Supervise,
            AlertCode::MorningBrief,
            format!("morning:{}", ctx.date),
            format!("{} 장전 수집 준비 점검", ctx.date),
            summary_parts.join("\n"),
        )
        .with_metric("배정 종목", format!("{}종목 (제외 {})", status.today.planned_stocks, status.today.excluded_stocks))
        .with_metric("키 상태", format!("수집 {collecting_live}/{collecting_total} · 예비 {spare_total} · REST {rest_total}"));

        if let Some(fs) = &disk.filesystem {
            event = event.with_metric("디스크", format!("잔여 {} ({:.1}% 사용)", format_gib(fs.free_bytes), used_percent(fs)));
        }
        if !deferred.is_empty() {
            event = event.with_metric("야간 지연 P2", format!("{}건", deferred.len()));
        }

        self.pipeline.emit_digest("morning_brief", event, ctx);
    }

    pub(super) fn close_day(&self, ctx: MarketContext, status: &DaemonStatus, data_dir: &Path) {
        let coverage = read_coverage(data_dir);
        let today_cov = coverage.days.iter().find(|day| day.date == ctx.date);
        let disk = (self.disk_probe)(data_dir);
        let stats = self.pipeline.day_stats(ctx.date);
        let (active_p1, active_p2) = self.pipeline.active_counts();

        let coverage_line = match today_cov {
            Some(day) => {
                let planned = day.planned_stocks.unwrap_or(status.today.planned_stocks as u64);
                let received = day.received_stocks.unwrap_or(status.today.receiving_stocks as u64);
                let pct = if planned > 0 { (received as f64 / planned as f64) * 100.0 } else { 100.0 };
                let verify = match (day.state, day.verified) {
                    (CoverageState::Complete, Some(true)) => "봉인·대조 통과",
                    (CoverageState::Complete, Some(false)) | (CoverageState::VerifyFailed, _) => "대조 실패",
                    (CoverageState::Incomplete, _) => "미완료",
                    (CoverageState::InProgress, _) => "정리 진행 중",
                    (CoverageState::Unreadable, _) => "읽기 실패",
                    (CoverageState::Complete, None) => "봉인 완료",
                };
                format!("{received}/{planned}종목 ({pct:.2}%) · {verify}")
            }
            None => format!("계획 {}종목 · 정리 기록 없음", status.today.planned_stocks),
        };

        let raw_today = disk.raw.iter().find(|d| d.date == ctx.date).map_or(0, |d| d.bytes);
        let store_today = disk.store.iter().find(|d| d.date == ctx.date).map_or(0, |d| d.bytes);
        let disk_line = match &disk.filesystem {
            Some(fs) => format!("원문 {} · Parquet {} · 잔여 {} ({:.1}%)", format_gib(raw_today), format_gib(store_today), format_gib(fs.free_bytes), used_percent(fs)),
            None => format!("원문 {} · Parquet {}", format_gib(raw_today), format_gib(store_today)),
        };

        let event = AlertEvent::active(
            AlertSource::Supervise,
            AlertCode::DailyCloseReport,
            format!("close:{}", ctx.date),
            format!("{} 일일 수집 완결 리포트", ctx.date),
            format!("장 마감 및 정리 절차가 종료됐습니다 (미해결 P1 {active_p1}건 · P2 {active_p2}건)"),
        )
        .with_metric("커버리지", coverage_line)
        .with_metric("저장 용량", disk_line)
        .with_metric("당일 인시던트", format!("P1 {}건 · P2 {}건 · 복구 {}건", stats.p1_fired, stats.p2_fired, stats.resolved));

        self.pipeline.emit_digest("daily_close", event, ctx);
    }

    pub(super) fn tick(&self, ctx: MarketContext) {
        self.pipeline.tick(ctx);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use domain::KstDate;
    use server::alert::MemorySink;
    use server::clock::kst;

    use super::*;

    const DATE: u32 = 20261126;

    fn alert(kind: AlertKind, message: &str) -> Alert {
        Alert { at: "2026-11-26T09:00:05+09:00".to_owned(), kind, message: message.to_owned() }
    }

    fn live_ctx() -> MarketContext {
        MarketContext::new(DATE, MarketPhase::Collecting, MarketObservation::Observed)
    }

    #[test]
    fn disk_level_uses_hysteresis_bands_for_warning_and_critical() {
        let total = 500 * GIB;
        let fs = |free_gib: u64| Filesystem { free_bytes: free_gib * GIB, total_bytes: total };

        assert_eq!(evaluate_disk_level(&fs(200), DiskLevel::Normal), DiskLevel::Normal);
        assert_eq!(evaluate_disk_level(&fs(110), DiskLevel::Normal), DiskLevel::Warning);
        assert_eq!(evaluate_disk_level(&fs(130), DiskLevel::Warning), DiskLevel::Warning);
        assert_eq!(evaluate_disk_level(&fs(145), DiskLevel::Warning), DiskLevel::Normal);
        assert_eq!(evaluate_disk_level(&fs(45), DiskLevel::Warning), DiskLevel::Critical);
        assert_eq!(evaluate_disk_level(&fs(60), DiskLevel::Critical), DiskLevel::Critical);
        assert_eq!(evaluate_disk_level(&fs(80), DiskLevel::Critical), DiskLevel::Warning);
        assert_eq!(evaluate_disk_level(&fs(150), DiskLevel::Critical), DiskLevel::Normal);
    }

    #[tokio::test(start_paused = true)]
    async fn distinct_stage_failures_and_keys_are_not_swallowed_and_morning_brief_merges_deferred_p2() {
        let folder = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::new());
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 26).unwrap(), 2, 0, 0));
        let notifier = AlertTelegram::spawn_with_sink(sink.clone(), folder.path(), clock.clone());

        let night = MarketContext::new(DATE, MarketPhase::OffHours, MarketObservation::Observed);
        notifier.alert(night, &alert(AlertKind::StageFailed, "특일정보 서비스 키를 읽지 못해 캐시만 씁니다: missing"));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(sink.messages().is_empty(), "야간 P2는 장전 리포트로 지연 병합된다");

        notifier.alert(live_ctx(), &alert(AlertKind::PlanNote, "예비 키가 없어 첫 활성 키로 REST를 부릅니다"));
        notifier.morning_brief(live_ctx(), &DaemonStatus::default(), data.path());
        notifier.alert(live_ctx(), &alert(AlertKind::StageFailed, "정리: finalize가 종료 코드 1로 끝났습니다"));
        notifier.alert(live_ctx(), &alert(AlertKind::KeyStopped, "collect-01를 멈췄습니다: 8050 인증 차단"));
        notifier.alert(live_ctx(), &alert(AlertKind::KeyStopped, "collect-02를 멈췄습니다: 재시작 한도 초과"));
        tokio::time::sleep(Duration::from_millis(50)).await;

        let messages = sink.messages();
        assert_eq!(messages.len(), 4, "{messages:?}");
        assert!(messages[0].html.contains("장전 수집 준비 점검") && messages[0].html.contains("특일정보 서비스 키 읽기 실패") && messages[0].html.contains("예비 키가 없어") && messages[0].silent);
        assert!(messages[1].html.contains("P1 장애") && messages[1].html.contains("마감 정리 실패"));
        assert!(messages[2].html.contains("collect-01") && messages[2].html.contains("인증 차단"));
        assert!(messages[3].html.contains("collect-02") && messages[3].html.contains("수집 키 정지"));
    }

    #[tokio::test(start_paused = true)]
    async fn crash_marker_resolves_automatically_on_startup() {
        let folder = tempfile::tempdir().unwrap();
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 26).unwrap(), 10, 21, 34));
        std::fs::write(folder.path().join(CRASH_MARKER_FILE), (clock.now().unix() - 34).to_string()).unwrap();
        let sink = Arc::new(MemorySink::new());
        let notifier = AlertTelegram::spawn_with_sink(sink.clone(), folder.path(), clock);
        notifier.resolve_pending_crash(live_ctx());
        tokio::time::sleep(Duration::from_millis(50)).await;
        let messages = sink.messages();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].html.contains("감독 데몬 자동 재기동 정상화") && messages[0].html.contains("34초") && messages[0].silent);
        assert!(!folder.path().join(CRASH_MARKER_FILE).exists());
    }
}
