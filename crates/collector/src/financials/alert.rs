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

fn financials_context(clock: &Clock) -> MarketContext {
    let now = clock.now();
    let date: u32 = now.kst_date().yyyymmdd().parse().unwrap_or(0);
    let secs = now.kst_time_of_day().secs();
    let phase = if secs < 7 * 3600 + 20 * 60 {
        MarketPhase::OffHours
    } else if secs < 20 * 3600 + 5 * 60 {
        MarketPhase::Collecting
    } else if secs < 21 * 3600 + 30 * 60 {
        MarketPhase::AfterClose
    } else {
        MarketPhase::OffHours
    };
    MarketContext::new(date, phase, MarketObservation::Observed)
}

pub async fn run(service: Arc<Financials>, telegram: Telegram, state_folder: &Path, clock: Clock, interval: Duration) {
    let router = AlertRouter::single(Arc::new(TelegramSink::new(telegram)));
    let store = StateStore::in_folder(state_folder, "financials");
    let pipeline = AlertPipeline::spawn(router, Some(store), clock.clone());
    let mut watch = AlertWatch::default();
    loop {
        let page = service.update_status().await;
        let ctx = financials_context(&clock);
        let events = watch.observe_events(&page);
        for event in events {
            pipeline.emit(event, ctx);
        }
        pipeline.tick(ctx);
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
}
