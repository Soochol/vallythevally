use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use server::alert::{
    AlertCode, AlertEvent, AlertPipeline, AlertRouter, AlertSource, MarketContext, MarketObservation, MarketPhase, StateStore, TelegramSink,
};
use server::api::{FinancialUpdatePage, FinancialUpdateStopReason as StopReason};
use server::clock::Clock;
use server::collector::telegram::Telegram;
use server::financials::Financials;

use super::render::kst_text;

pub const POLL_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertKind {
    Authentication,
    RateLimited,
    Storage,
}

impl AlertKind {
    fn code(self) -> AlertCode {
        match self {
            AlertKind::Authentication => AlertCode::FinancialsAuthHalted,
            AlertKind::RateLimited => AlertCode::FinancialsRateLimited,
            AlertKind::Storage => AlertCode::FinancialsStorageHalted,
        }
    }

    fn target(self) -> &'static str {
        match self {
            AlertKind::Authentication => "opendart-auth",
            AlertKind::RateLimited => "opendart-quota",
            AlertKind::Storage => "financials-db",
        }
    }
}

pub fn alert_kind(page: &FinancialUpdatePage) -> Option<AlertKind> {
    match page.stop_reason? {
        StopReason::Authentication => Some(AlertKind::Authentication),
        StopReason::RateLimited => Some(AlertKind::RateLimited),
        StopReason::Storage => Some(AlertKind::Storage),
        StopReason::User | StopReason::Interrupted | StopReason::NotConfigured => None,
    }
}

fn message(kind: AlertKind, page: &FinancialUpdatePage) -> String {
    match kind {
        AlertKind::Authentication => "재무 수집이 멈췄습니다: OpenDART 인증이 거절됐습니다. 키 파일을 확인한 뒤 collector financials resume을 실행하세요.".to_owned(),
        AlertKind::RateLimited => match page.next_check_at {
            Some(at) => format!("재무 수집이 멈췄습니다: OpenDART 호출 한도를 넘었습니다. 다음 확인은 {}입니다.", kst_text(at.0)),
            None => "재무 수집이 멈췄습니다: OpenDART 호출 한도를 넘었습니다.".to_owned(),
        },
        AlertKind::Storage => "재무 수집이 멈췄습니다: 재무 저장소에 쓰지 못했습니다. 디스크와 파일을 확인한 뒤 collector financials resume을 실행하세요.".to_owned(),
    }
}

fn active_event(kind: AlertKind, page: &FinancialUpdatePage) -> AlertEvent {
    let summary = message(kind, page);
    match kind {
        AlertKind::Authentication => AlertEvent::active(AlertSource::Financials, kind.code(), kind.target(), "OpenDART 인증 거절 — 재무 수집 중단", summary)
            .with_impact("재무자료 자동 갱신이 멈췄습니다")
            .with_action("~/.config/vally/opendart-key 확인 후 collector financials resume"),
        AlertKind::RateLimited => AlertEvent::active(AlertSource::Financials, kind.code(), kind.target(), "OpenDART 일일 호출 한도 도달", summary)
            .with_impact("다음 확인 시각까지 대기 후 자동 재개됩니다"),
        AlertKind::Storage => AlertEvent::active(AlertSource::Financials, kind.code(), kind.target(), "재무 저장소 쓰기 실패 — 재무 수집 중단", summary)
            .with_impact("재무 SQLite DB에 기록하지 못해 수집이 멈췄습니다")
            .with_action("디스크·파일 권한 확인 후 collector financials resume"),
    }
}

fn resolved_event(kind: AlertKind) -> AlertEvent {
    AlertEvent::resolved(AlertSource::Financials, kind.code(), kind.target(), "재무 수집 정상 재개", "중단 상태가 해소되어 재무자료 수집이 재개됐습니다")
}

#[derive(Default)]
pub struct AlertWatch {
    sent: Option<AlertKind>,
}

impl AlertWatch {
    pub fn observe(&mut self, page: &FinancialUpdatePage) -> Option<String> {
        let current = alert_kind(page);
        let fresh = current.filter(|kind| self.sent != Some(*kind));
        self.sent = current;
        fresh.map(|kind| message(kind, page))
    }

    pub fn observe_events(&mut self, page: &FinancialUpdatePage) -> Vec<AlertEvent> {
        let current = alert_kind(page);
        let mut events = Vec::new();
        if let Some(previous) = self.sent
            && current != Some(previous)
        {
            events.push(resolved_event(previous));
        }
        if let Some(kind) = current {
            events.push(active_event(kind, page));
        }
        self.sent = current;
        events
    }
}

fn is_kst_weekend(unix_secs: i64) -> bool {
    let kst_days = (unix_secs + 9 * 3600).div_euclid(86400);
    let weekday = (kst_days + 4).rem_euclid(7);
    weekday == 0 || weekday == 6
}

pub fn financials_context(clock: &Clock) -> MarketContext {
    let now = clock.now();
    let date: u32 = now.kst_date().yyyymmdd().parse().unwrap_or(0);
    let observation = if is_kst_weekend(now.unix()) { MarketObservation::NotObserved } else { MarketObservation::Observed };
    let secs = now.kst_time_of_day().secs();
    let phase = if secs < 8 * 3600 {
        MarketPhase::OffHours
    } else if secs < 20 * 3600 + 5 * 60 {
        MarketPhase::Collecting
    } else if secs < 21 * 3600 + 30 * 60 {
        MarketPhase::AfterClose
    } else {
        MarketPhase::OffHours
    };
    MarketContext::new(date, phase, observation)
}

pub fn poll_once(pipeline: &AlertPipeline, page: &FinancialUpdatePage, clock: &Clock) {
    let ctx = financials_context(clock);
    let current = alert_kind(page);
    for fp in pipeline.active_fingerprints() {
        if fp.source == AlertSource::Financials && current.map(AlertKind::code) != Some(fp.code) {
            let resolved = AlertEvent::resolved(
                AlertSource::Financials,
                fp.code,
                fp.target,
                "재무 수집 정상 재개",
                "중단 상태가 해소되어 재무자료 수집이 재개됐습니다",
            );
            pipeline.emit(resolved, ctx);
        }
    }
    if let Some(kind) = current {
        pipeline.emit(active_event(kind, page), ctx);
    }
    if !ctx.is_quiet_hours() && pipeline.deferred_p2_count() > 0 {
        let deferred = pipeline.peek_deferred_p2();
        let items: Vec<String> = deferred.iter().map(|item| format!("{}: {}", item.title, item.summary)).collect();
        let summary_event = AlertEvent::active(
            AlertSource::Financials,
            AlertCode::MorningBrief,
            format!("financials-deferred:{}", ctx.date),
            format!("{} 재무 수집 야간·휴장일 지연 경고 요약", ctx.date),
            items.join("\n"),
        )
        .with_metric("지연 경고", format!("{}건", deferred.len()));
        pipeline.emit_digest_clearing_deferred(&format!("financials_deferred:{}", ctx.date), summary_event, ctx);
    }
    pipeline.tick(ctx);
}

pub async fn run(service: Arc<Financials>, telegram: Telegram, state_folder: &Path, clock: Clock, interval: Duration) {
    let router = AlertRouter::single(Arc::new(TelegramSink::new(telegram)));
    let store = StateStore::in_folder(state_folder, "financials");
    let pipeline = AlertPipeline::spawn(router, Some(store), clock.clone());
    loop {
        let page = service.update_status().await;
        poll_once(&pipeline, &page, &clock);
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use server::alert::Signal;
    use serde_json::json;

    use super::*;

    fn page_with(reason: Option<StopReason>) -> FinancialUpdatePage {
        let mut page: FinancialUpdatePage = serde_json::from_value(json!({
            "id": 1, "status": "stopped", "phase": "recent", "stopReason": null, "nextCheckAt": null, "canResume": true, "automatic": true,
            "latestCheckPending": false, "historyCompletedCompanies": 0, "historyFailedCompanies": 0, "recentFailedCompanies": 0, "historyComplete": false,
            "fromYear": 2024, "throughYear": 2026, "totalSymbols": 1, "processedSymbols": 1, "unsupportedSymbols": 0, "unverifiedSymbols": 0, "unverifiedDividends": 0,
            "totalCompanies": 1, "completedCompanies": 0, "failedCompanies": 0, "startedAt": null, "lastCheckedAt": null, "failure": null, "failures": []
        })).unwrap();
        page.stop_reason = reason;
        page
    }

    #[test]
    fn observe_events_emits_active_and_resolved_when_stop_clears() {
        let mut watch = AlertWatch::default();
        let active = watch.observe_events(&page_with(Some(StopReason::RateLimited)));
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].signal, Signal::Active);
        assert_eq!(active[0].fingerprint.code, AlertCode::FinancialsRateLimited);

        let cleared = watch.observe_events(&page_with(None));
        assert_eq!(cleared.len(), 1);
        assert_eq!(cleared[0].signal, Signal::Resolved);
        assert_eq!(cleared[0].fingerprint.code, AlertCode::FinancialsRateLimited);
    }

    #[tokio::test(start_paused = true)]
    async fn healthy_restart_resolves_persisted_p1_and_stops_reminders() {
        let folder = tempfile::tempdir().unwrap();
        let store = StateStore::in_folder(folder.path(), "financials");
        let sink = Arc::new(server::alert::MemorySink::new());
        let clock = Clock::fake(server::clock::kst(domain::KstDate::new(2026, 11, 26).unwrap(), 9, 0, 0));

        let first = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store.clone()), clock.clone());
        poll_once(&first, &page_with(Some(StopReason::Authentication)), &clock);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(sink.messages().len(), 1);

        let restarted = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store), clock.clone());
        poll_once(&restarted, &page_with(None), &clock);
        clock.jump(22_000);
        poll_once(&restarted, &page_with(None), &clock);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sent = sink.messages();
        assert_eq!(sent.len(), 2, "{sent:?}");
        assert!(sent[1].html.contains("복구 완료") && sent[1].silent);
    }

    #[tokio::test(start_paused = true)]
    async fn quiet_hours_and_weekend_rate_limit_p2_defer_and_flush_on_weekday_open() {
        let folder = tempfile::tempdir().unwrap();
        let store = StateStore::in_folder(folder.path(), "financials");
        let sink = Arc::new(server::alert::MemorySink::new());
        let saturday = domain::KstDate::new(2026, 11, 28).unwrap();
        let clock = Clock::fake(server::clock::kst(saturday, 10, 0, 0));
        let pipeline = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store), clock.clone());

        poll_once(&pipeline, &page_with(Some(StopReason::RateLimited)), &clock);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sink.messages().is_empty(), "주말 P2는 즉시 발송되지 않고 지연된다");

        let monday_open = server::clock::kst(domain::KstDate::new(2026, 11, 30).unwrap(), 8, 5, 0);
        clock.jump(monday_open.unix() - clock.now().unix());
        poll_once(&pipeline, &page_with(Some(StopReason::RateLimited)), &clock);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sent = sink.messages();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert!(sent[0].html.contains("지연 경고 요약") && sent[0].html.contains("OpenDART"));
    }
}
