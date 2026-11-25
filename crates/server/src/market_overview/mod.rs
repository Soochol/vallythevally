pub mod broker_book;
mod cards;
pub mod derived;
pub mod disclosures;
mod dto;
mod events;
mod kiwoom_overview;
pub mod pro;
pub mod rrg;
mod sampler;
mod samples;
mod session;
pub mod session_dna;
mod shared;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::routing::get;
use domain::{KstDate, KstTime};

use crate::api::{Broker, Market};
use crate::financials::store::SecurityDisclosures;
use crate::http::AppState;
use crate::market_source::route::Picked;
use crate::market_source::{GenerationTicket, OverviewSource, SourceGeneration};

pub use cards::{CardEnv, StreakFilter, flow_card, index_card, sectors_card, streaks_card, turnover_card};
pub use dto::*;
pub use kiwoom_overview::KiwoomOverview;
pub use sampler::{investors as investor_sample, program as program_sample, start};
pub use samples::{Sample, SampleBook, SampleValue};
pub use session::{SAMPLE_INTERVAL_SECS, is_sampling_minute, minute_floor, observation_day, phase};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/market-overview/index", get(cards::index))
        .route("/api/market-overview/sectors", get(cards::sectors))
        .route("/api/market-overview/flow", get(cards::flow))
        .route("/api/market-overview/flow/intraday", get(cards::intraday_flow))
        .route("/api/market-overview/turnover", get(cards::turnover))
        .route("/api/market-overview/streaks", get(cards::streaks))
        .route("/api/market-overview/derived", get(derived::derived))
        .route("/api/market-overview/pro", get(pro::pro))
        .route("/api/market-overview/themes", get(events::themes))
        .route("/api/market-overview/vi", get(events::vi))
}

#[derive(Default)]
struct InvestorDays {
    observation_day: Option<KstDate>,
    filled_in: Option<GenerationTicket>,
    days: HashMap<(Broker, Market, KstDate), MarketOverviewInvestorDay>,
}

#[derive(Default)]
pub struct MarketOverview {
    pub samples: SampleBook,
    investor_days: Mutex<InvestorDays>,
    chosen: Mutex<Option<Arc<dyn OverviewSource>>>,
    generation: SourceGeneration,
    pub(crate) derived_ma_cache: derived::DerivedMaCache,
    financial_db_path: Mutex<Option<PathBuf>>,
    disclosure_cache: disclosures::DisclosureCache,
}

pub fn overview_source(st: &AppState) -> Picked<dyn OverviewSource> {
    match st.market_overview.chosen.lock().expect("공급원 잠금").clone() {
        Some(source) => Picked { broker: source.broker(), source },
        None => st.route.overview(),
    }
}

impl MarketOverview {
    pub fn with_generation(generation: SourceGeneration) -> MarketOverview {
        MarketOverview {
            samples: SampleBook::with_generation(generation.clone()),
            investor_days: Mutex::default(),
            chosen: Mutex::default(),
            generation,
            derived_ma_cache: derived::DerivedMaCache::default(),
            financial_db_path: Mutex::default(),
            disclosure_cache: disclosures::DisclosureCache::default(),
        }
    }

    pub fn financial_db_path(&self) -> Option<PathBuf> {
        self.financial_db_path.lock().expect("재무 DB 경로 잠금").clone()
    }

    pub fn set_financial_db_path(&self, path: Option<PathBuf>) {
        *self.financial_db_path.lock().expect("재무 DB 경로 잠금") = path;
        self.disclosure_cache.clear();
    }

    pub(crate) async fn load_security_disclosures(&self) -> Option<Arc<Vec<SecurityDisclosures>>> {
        let path = self.financial_db_path()?;
        self.disclosure_cache.load(&path).await
    }

    pub fn ticket(&self) -> GenerationTicket {
        self.generation.ticket()
    }

    pub fn choose(&self, source: Option<Arc<dyn OverviewSource>>) {
        let mut chosen = self.chosen.lock().expect("공급원 잠금");
        self.generation.advance();
        *chosen = source;
    }

    pub fn cached_investor_day(&self, now: KstTime, broker: Broker, market: Market, day: KstDate) -> Option<MarketOverviewInvestorDay> {
        let mut cache = self.investor_days.lock().expect("투자자 캐시 잠금");
        cache.roll(now, self.generation.ticket());
        cache.days.get(&(broker, market, day)).cloned()
    }

    pub fn cache_investor_day(&self, now: KstTime, broker: Broker, market: Market, row: MarketOverviewInvestorDay, started: GenerationTicket) {
        let mut cache = self.investor_days.lock().expect("투자자 캐시 잠금");
        let current = self.generation.ticket();
        cache.roll(now, current);
        if started == current {
            cache.days.insert((broker, market, row.date.0), row);
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
