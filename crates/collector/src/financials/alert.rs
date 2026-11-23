use std::sync::Arc;
use std::time::Duration;

use server::api::{FinancialUpdatePage, FinancialUpdateStopReason as StopReason};
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
}

pub async fn run(service: Arc<Financials>, telegram: Telegram, interval: Duration) {
    let mut watch = AlertWatch::default();
    loop {
        if let Some(text) = watch.observe(&service.update_status().await) {
            match telegram.send(&text).await {
                Ok(()) => tracing::info!("재무 수집 중단 경보를 보냈습니다"),
                Err(error) => tracing::warn!(%error, "재무 수집 중단 경보를 보내지 못했습니다"),
            }
        }
        tokio::time::sleep(interval).await;
    }
}
