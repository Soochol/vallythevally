use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, TimeOfDay, Venue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use server::kiwoom::rest::KiwoomRest;
use server::shared_data::{Broker, DataKind, snapshot_kind};

use super::job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob};
use crate::universe::{ListedStock, listing_path, read_listing_upto};

mod fetch;
mod parts;

const PERIOD_SECS: i64 = 30;
const OPENS_AT: TimeOfDay = match TimeOfDay::hms(8, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const CLOSE: TimeOfDay = match TimeOfDay::hms(20, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const CLOSING_FETCH_AT: TimeOfDay = match TimeOfDay::hms(20, 0, PERIOD_SECS as u32) {
    Some(time) => time,
    None => unreachable!(),
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VenueName {
    Krx,
    Combined,
    Nxt,
}

impl VenueName {
    pub fn venue(self) -> Venue {
        match self {
            VenueName::Krx => Venue::Krx,
            VenueName::Combined => Venue::Combined,
            VenueName::Nxt => Venue::Nxt,
        }
    }

    pub fn kind(self) -> DataKind {
        snapshot_kind(self.venue())
    }

    fn takes(self, stock: &ListedStock) -> bool {
        self != VenueName::Nxt || stock.nxt_enabled
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotOptions {
    #[serde(default = "default_venues")]
    venues: Vec<VenueName>,
}

fn default_venues() -> Vec<VenueName> {
    vec![VenueName::Krx, VenueName::Combined, VenueName::Nxt]
}

fn options_of(options: &Value) -> Result<SnapshotOptions, String> {
    let parsed = match options.is_null() {
        true => SnapshotOptions { venues: default_venues() },
        false => serde_json::from_value::<SnapshotOptions>(options.clone()).map_err(|error| error.to_string())?,
    };
    if parsed.venues.is_empty() {
        return Err("venues에 거래소가 하나는 있어야 합니다".to_owned());
    }
    let mut seen = parsed.venues.clone();
    seen.sort_unstable();
    seen.dedup();
    match seen.len() == parsed.venues.len() {
        true => Ok(parsed),
        false => Err("venues에 같은 거래소가 두 번 적혀 있습니다".to_owned()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Tick {
    at: KstTime,
    closing: bool,
}

fn tick_after(now: KstTime, observation_date: KstDate) -> Tick {
    let boundary = KstTime::from_unix((now.unix() + PERIOD_SECS - 1).div_euclid(PERIOD_SECS) * PERIOD_SECS);
    match boundary < KstTime::from_kst_civil(observation_date, CLOSE) {
        true => Tick { at: boundary, closing: false },
        false => Tick { at: KstTime::from_kst_civil(observation_date, CLOSING_FETCH_AT), closing: true },
    }
}

struct CachedListing {
    observation_date: KstDate,
    source_date: u32,
    stocks: Arc<Vec<ListedStock>>,
}

#[derive(Default)]
pub struct SnapshotJob {
    listing: Mutex<Option<CachedListing>>,
    failures: AtomicU64,
}

impl SnapshotJob {
    pub fn failures(&self) -> u64 {
        self.failures.load(Ordering::SeqCst)
    }

    fn listed_on(&self, shared_dir: &Path, observation_date: KstDate) -> Result<Arc<Vec<ListedStock>>, JobError> {
        let data_dir = shared_dir.parent().ok_or_else(|| JobError(format!("공용 자료 폴더 {}의 위 폴더(데이터 폴더)를 알 수 없습니다", shared_dir.display())))?;
        let date: u32 = observation_date.yyyymmdd().parse().expect("날짜는 숫자 여덟 자리다");
        let mut cached = self.listing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(kept) = cached.as_ref().filter(|kept| kept.observation_date == observation_date && (kept.source_date == date || !listing_path(data_dir, date).exists())) {
            return Ok(kept.stocks.clone());
        }
        let file = read_listing_upto(data_dir, date)
            .map_err(|error| JobError(error.to_string()))?
            .ok_or_else(|| JobError(format!("{} 아래에 {date} 이전의 전체 종목 행 파일이 없습니다", data_dir.join("listing").display())))?;
        let stocks = Arc::new(file.stocks);
        *cached = Some(CachedListing { observation_date, source_date: file.date, stocks: stocks.clone() });
        Ok(stocks)
    }

    async fn one_tick(&self, rest: &KiwoomRest, call: &JobCall<'_>) -> Result<(), JobError> {
        let options = options_of(call.options).map_err(JobError)?;
        let tick = tick_after(call.clock.now(), call.observation_date);
        call.clock.sleep_until(tick.at).await;
        let listed = self.listed_on(call.shared_dir, call.observation_date)?;
        let units = fetch::units_of(&listed, &options.venues);
        let part = fetch::fetch_slice(rest, &units, &options.venues, call.slice, tick, call.key, call.clock).await.map_err(JobError)?;
        parts::publish(call.shared_dir, call.observation_date, part, call.clock.now()).map_err(|error| JobError(format!("공용 자료를 쓰지 못했습니다: {error}")))
    }
}

impl SharedJob for SnapshotJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: OPENS_AT, end: CLOSING_FETCH_AT }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom]
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        options_of(options).map(|_| ())
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let Market::Kiwoom(rest) = call.market else { return Err(JobError("snapshot은 키움 키만 받습니다".to_owned())) };
            let outcome = self.one_tick(rest, &call).await;
            if let Err(error) = &outcome {
                self.failures.fetch_add(1, Ordering::SeqCst);
                tracing::warn!(key = %call.key, %error, "오늘 시세 스냅샷 판을 만들지 못했습니다. 이전 판을 둡니다");
            }
            outcome
        })
    }
}
