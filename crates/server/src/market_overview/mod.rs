mod cards;
mod dto;
mod kiwoom_overview;
mod sampler;
mod samples;
mod session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::routing::get;
use domain::{KstDate, KstTime};

use crate::api::Market;
use crate::http::AppState;
use crate::market_source::OverviewSource;

pub use dto::*;
pub use kiwoom_overview::KiwoomOverview;
pub use sampler::start;
pub use samples::{Sample, SampleBook, SampleValue};
pub use session::{observation_day, phase};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/market-overview/index", get(cards::index))
        .route("/api/market-overview/sectors", get(cards::sectors))
        .route("/api/market-overview/flow", get(cards::flow))
        .route("/api/market-overview/flow/intraday", get(cards::intraday_flow))
        .route("/api/market-overview/turnover", get(cards::turnover))
        .route("/api/market-overview/streaks", get(cards::streaks))
}

#[derive(Default)]
struct InvestorDays {
    observation_day: Option<KstDate>,
    days: HashMap<(Market, KstDate), MarketOverviewInvestorDay>,
}

#[derive(Default)]
pub struct MarketOverview {
    pub samples: SampleBook,
    investor_days: Mutex<InvestorDays>,
    chosen: Mutex<Option<Arc<dyn OverviewSource>>>,
}

pub fn overview_source(st: &AppState) -> Arc<dyn OverviewSource> {
    match st.market_overview.chosen.lock().expect("공급원 잠금").clone() {
        Some(source) => source,
        None => Arc::new(KiwoomOverview::new(st.kiwoom.clone())),
    }
}

impl MarketOverview {
    pub fn choose(&self, source: Option<Arc<dyn OverviewSource>>) {
        *self.chosen.lock().expect("공급원 잠금") = source;
        self.investor_days.lock().expect("투자자 캐시 잠금").days.clear();
    }

    fn cached_investor_day(&self, now: KstTime, market: Market, day: KstDate) -> Option<MarketOverviewInvestorDay> {
        let mut cache = self.investor_days.lock().expect("투자자 캐시 잠금");
        cache.roll(now);
        cache.days.get(&(market, day)).cloned()
    }

    fn cache_investor_day(&self, now: KstTime, market: Market, row: MarketOverviewInvestorDay) {
        let mut cache = self.investor_days.lock().expect("투자자 캐시 잠금");
        cache.roll(now);
        cache.days.insert((market, row.date.0), row);
    }
}

impl InvestorDays {
    fn roll(&mut self, now: KstTime) {
        let day = observation_day(now);
        if self.observation_day != Some(day) {
            self.observation_day = Some(day);
            self.days.clear();
        }
    }
}
