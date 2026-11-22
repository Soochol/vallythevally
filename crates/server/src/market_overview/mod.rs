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
use crate::market_source::{GenerationTicket, OverviewSource, SourceGeneration};

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
    filled_in: Option<GenerationTicket>,
    days: HashMap<(Market, KstDate), MarketOverviewInvestorDay>,
}

#[derive(Default)]
pub struct MarketOverview {
    pub samples: SampleBook,
    investor_days: Mutex<InvestorDays>,
    chosen: Mutex<Option<Arc<dyn OverviewSource>>>,
    generation: SourceGeneration,
}

pub fn overview_source(st: &AppState) -> Arc<dyn OverviewSource> {
    match st.market_overview.chosen.lock().expect("공급원 잠금").clone() {
        Some(source) => source,
        None => Arc::new(KiwoomOverview::new(st.kiwoom.clone())),
    }
}

impl MarketOverview {
    pub fn with_generation(generation: SourceGeneration) -> MarketOverview {
        MarketOverview { samples: SampleBook::with_generation(generation.clone()), investor_days: Mutex::default(), chosen: Mutex::default(), generation }
    }

    pub fn ticket(&self) -> GenerationTicket {
        self.generation.ticket()
    }

    pub fn choose(&self, source: Option<Arc<dyn OverviewSource>>) {
        let mut chosen = self.chosen.lock().expect("공급원 잠금");
        self.generation.advance();
        *chosen = source;
    }

    pub fn cached_investor_day(&self, now: KstTime, market: Market, day: KstDate) -> Option<MarketOverviewInvestorDay> {
        let mut cache = self.investor_days.lock().expect("투자자 캐시 잠금");
        cache.roll(now, self.generation.ticket());
        cache.days.get(&(market, day)).cloned()
    }

    pub fn cache_investor_day(&self, now: KstTime, market: Market, row: MarketOverviewInvestorDay, started: GenerationTicket) {
        let mut cache = self.investor_days.lock().expect("투자자 캐시 잠금");
        let current = self.generation.ticket();
        cache.roll(now, current);
        if started == current {
            cache.days.insert((market, row.date.0), row);
        }
    }
}

impl InvestorDays {
    fn roll(&mut self, now: KstTime, generation: GenerationTicket) {
        let day = observation_day(now);
        if self.observation_day != Some(day) || self.filled_in != Some(generation) {
            self.observation_day = Some(day);
            self.filled_in = Some(generation);
            self.days.clear();
        }
    }
}
