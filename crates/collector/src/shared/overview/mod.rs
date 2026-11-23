use std::collections::HashSet;
use std::path::Path;

use domain::{KstDate, TimeOfDay};
use serde_json::Value;
use server::api::{ApiErrorBody, ApiErrorCode, Broker as ApiBroker, Market as ApiMarket};
use server::kis::overview::{KisOverview, SUPPORTED_OVERVIEW_FEATURES};
use server::market_overview::{
    CardEnv, KiwoomOverview, MarketOverview, MarketOverviewPeriod, StreakFilter, flow_card, index_card, sectors_card, streaks_card, turnover_card,
};
use server::market_source::{KiwoomHandle, OverviewFeature, OverviewFeatures, OverviewSource, Priority, StreakRow};
use server::shared_data::{Broker, CardValue, MadeCard};

use super::job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob, Slice};
use crate::universe::read_listing_upto;

mod parts;
mod samples;

pub(super) use samples::IntradaySamplesJob;

const OPENS_AT: TimeOfDay = match TimeOfDay::hms(8, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const CLOSES_AT: TimeOfDay = match TimeOfDay::hms(20, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const MARKETS: [ApiMarket; 2] = [ApiMarket::Kospi, ApiMarket::Kosdaq];
const PERIODS: [MarketOverviewPeriod; 3] = [MarketOverviewPeriod::Days5, MarketOverviewPeriod::Days20, MarketOverviewPeriod::Days60];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Card {
    Index,
    Sectors,
    Flow(MarketOverviewPeriod),
    Turnover(MarketOverviewPeriod),
    Streaks,
}

impl Card {
    fn feature(self) -> OverviewFeature {
        match self {
            Card::Index => OverviewFeature::Index,
            Card::Sectors => OverviewFeature::Sectors,
            Card::Flow(_) => OverviewFeature::Flow,
            Card::Turnover(_) => OverviewFeature::Turnover,
            Card::Streaks => OverviewFeature::Streaks,
        }
    }
}

fn units() -> Vec<(ApiMarket, Card)> {
    let mut units = Vec::new();
    for market in MARKETS {
        units.push((market, Card::Index));
        units.push((market, Card::Sectors));
        units.extend(PERIODS.map(|period| (market, Card::Flow(period))));
        units.extend(PERIODS.map(|period| (market, Card::Turnover(period))));
        units.push((market, Card::Streaks));
    }
    units
}

pub(super) fn features_of(broker: Broker) -> OverviewFeatures {
    match broker {
        Broker::Kiwoom => KiwoomOverview::new(KiwoomHandle::absent()).features(),
        Broker::Kis => OverviewFeatures::of(SUPPORTED_OVERVIEW_FEATURES),
    }
}

pub(super) fn owns(slice: Slice, peers: &[Broker], unit: u32, feature: OverviewFeature) -> bool {
    let count = slice.count.max(1);
    if peers.len() != count as usize {
        return slice.owns(unit);
    }
    let preferred = unit % count;
    let owner = (0..count).map(|step| (preferred + step) % count).find(|candidate| features_of(peers[*candidate as usize]).contains(feature)).unwrap_or(preferred);
    owner == slice.index
}

fn api_broker(broker: Broker) -> ApiBroker {
    match broker {
        Broker::Kiwoom => ApiBroker::Kiwoom,
        Broker::Kis => ApiBroker::Kis,
    }
}

fn source_of(market: &Market<'_>) -> Result<(Box<dyn OverviewSource>, Broker), JobError> {
    match market {
        Market::Kiwoom(rest) => Ok((Box::new(KiwoomOverview::new(KiwoomHandle::connected((*rest).clone()))), Broker::Kiwoom)),
        Market::Kis(Some(rest)) => Ok((Box::new(KisOverview::new((*rest).clone())), Broker::Kis)),
        Market::Kis(None) => Err(JobError("이 한투 키의 공용 자료 자식에는 한투 세션이 없습니다".to_owned())),
    }
}

fn listing_codes(shared_dir: &Path, observation_date: KstDate) -> Result<HashSet<String>, ApiErrorBody> {
    let unavailable = |detail: String| ApiErrorBody { code: ApiErrorCode::CollectorUnavailable, message: detail, reason: None, retry_at: None, manual_action_required: false };
    let data_dir = shared_dir.parent().ok_or_else(|| unavailable("공용 자료 폴더의 위 폴더(데이터 폴더)를 알 수 없습니다".to_owned()))?;
    let date: u32 = observation_date.yyyymmdd().parse().expect("날짜는 숫자 여덟 자리다");
    match read_listing_upto(data_dir, date) {
        Ok(Some(file)) => Ok(file.stocks.into_iter().map(|stock| stock.code).collect()),
        Ok(None) => Err(unavailable(format!("{date} 이전의 전체 종목 행 파일이 없어 ETF·ETN을 가릴 수 없습니다"))),
        Err(error) => Err(unavailable(error.to_string())),
    }
}

#[derive(Default)]
pub struct OverviewJob {
    book: MarketOverview,
}

impl OverviewJob {
    async fn make(&self, env: &CardEnv<'_>, market: ApiMarket, card: Card, filter: &StreakFilter<'_>) -> CardValue {
        match card {
            Card::Index => CardValue::Index { value: index_card(env, market).await },
            Card::Sectors => CardValue::Sectors { value: sectors_card(env, market).await },
            Card::Flow(period) => CardValue::Flow { value: flow_card(env, market, period).await },
            Card::Turnover(period) => CardValue::Turnover { value: turnover_card(env, market, period).await },
            Card::Streaks => CardValue::Streaks { value: streaks_card(env, market, filter.clone()).await },
        }
    }
}

impl SharedJob for OverviewJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: OPENS_AT, end: CLOSES_AT }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom, Broker::Kis]
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        match options.is_null() {
            true => Ok(()),
            false => Err("overview는 선택값을 받지 않습니다".to_owned()),
        }
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let (source, broker) = source_of(&call.market)?;
            let mine: Vec<(ApiMarket, Card)> = units().into_iter().enumerate().filter(|(unit, (_, card))| owns(call.slice, call.peers, *unit as u32, card.feature())).map(|(_, unit)| unit).collect();
            if mine.is_empty() {
                return Ok(());
            }
            let env = CardEnv { source: source.as_ref(), broker: api_broker(broker), clock: call.clock, priority: Priority::Background, book: &self.book };
            let listing = match mine.iter().any(|(_, card)| *card == Card::Streaks) {
                true => Some(listing_codes(call.shared_dir, call.observation_date)),
                false => None,
            };
            let shown = |row: &StreakRow| listing.as_ref().and_then(|codes| codes.as_ref().ok()).is_none_or(|codes| codes.contains(row.code.as_str()));
            let filter: StreakFilter<'_> = match &listing {
                Some(Err(error)) => Err(error.clone()),
                _ => Ok(&shown),
            };
            let made_at = call.clock.now().unix();
            let cards = futures::future::join_all(mine.iter().map(|(market, card)| async { MadeCard { market: *market, key_name: call.key.as_str().to_owned(), made_at, card: self.make(&env, *market, *card, &filter).await } })).await;
            parts::publish(call.shared_dir, call.observation_date, call.key, broker, cards, call.clock.now()).map_err(|error| JobError(format!("공용 자료를 쓰지 못했습니다: {error}")))
        })
    }
}
