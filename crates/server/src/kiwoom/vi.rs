use std::sync::{Arc, Mutex};

use domain::KstDate;

use super::api::ViTriggeredStocks;
use super::rest::{KiwoomRest, Priority};
use crate::api::KiwoomEnvironment;
use crate::clock::Clock;
use crate::market_source::MergeScope;
use crate::market_source::vi::{ViAlert, ViHistory, vi_session_open};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Progress {
    NotAsked,
    Asking,
    Answered(KstDate),
}

pub struct ViBackfill {
    rest: KiwoomRest,
    clock: Clock,
    progress: Arc<Mutex<Progress>>,
}

impl ViBackfill {
    pub fn new(rest: KiwoomRest, clock: Clock) -> ViBackfill {
        ViBackfill { rest, clock, progress: Arc::new(Mutex::new(Progress::NotAsked)) }
    }

    pub fn ask_if_due(&self) -> Option<ViHistory> {
        let now = self.clock.now();
        if self.rest.environment() == KiwoomEnvironment::Mock || !vi_session_open(now) {
            return None;
        }
        let today = now.kst_date();
        {
            let mut progress = self.progress.lock().expect("VI 보충 잠금");
            if *progress == Progress::Asking || *progress == Progress::Answered(today) {
                return None;
            }
            *progress = Progress::Asking;
        }
        let (rest, progress) = (self.rest.clone(), self.progress.clone());
        Some(Box::pin(async move {
            let alerts = fetch(&rest).await;
            *progress.lock().expect("VI 보충 잠금") = if alerts.is_some() { Progress::Answered(today) } else { Progress::NotAsked };
            alerts
        }))
    }
}

async fn fetch(rest: &KiwoomRest) -> Option<Vec<ViAlert>> {
    match rest.call(&ViTriggeredStocks::KRX_TODAY, None, Priority::Background, MergeScope::default()).await {
        Ok(page) => {
            if page.next.is_some() {
                tracing::warn!("오늘 VI 발동 목록이 한 쪽에 다 오지 않았습니다. 첫 쪽만 씁니다");
            }
            let parsed = page.body.alerts();
            tracing::info!(count = parsed.rows.len(), skipped = parsed.skipped, "오늘 VI 발동 목록을 받았습니다");
            Some(parsed.rows)
        }
        Err(error) => {
            tracing::warn!(%error, "오늘 VI 발동 목록을 받지 못했습니다. 다음 연결 때 다시 받습니다");
            None
        }
    }
}
