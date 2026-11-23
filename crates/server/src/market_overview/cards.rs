use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use domain::{KstTime, Symbol, SymbolKind};

use super::dto::*;
use super::overview_source;
use super::samples::SampleValue;
use super::shared;
use super::session::{observation_day, phase};
use super::MarketOverview;
use crate::api::{self, ApiErrorBody, Broker, Market};
use crate::bars::BarError;
use crate::clock::Clock;
use crate::http::{ApiFailure, AppState, Lookup, feature_symbol_list};
use crate::market_source::{IndexLevel, MarketIndexSnapshot, OverviewSource, Priority, SectorFlow, SourceError, StreakColumn, StreakRow, StreakSide, TradingDay};

const DEFAULT_PERIOD: MarketOverviewPeriod = MarketOverviewPeriod::Days20;

pub struct CardEnv<'a> {
    pub source: &'a dyn OverviewSource,
    pub broker: Broker,
    pub clock: &'a Clock,
    pub priority: Priority,
    pub book: &'a MarketOverview,
}

pub type StreakFilter<'a> = Result<&'a (dyn Fn(&StreakRow) -> bool + Sync), ApiErrorBody>;

pub struct Params {
    market: Market,
    period: MarketOverviewPeriod,
}

impl Params {
    fn parse(query: &HashMap<String, String>) -> Result<Params, ApiFailure> {
        let market = match query.get("market").map(String::as_str) {
            Some("kospi") => Market::Kospi,
            Some("kosdaq") => Market::Kosdaq,
            Some(other) => return Err(ApiFailure::bad_request(format!("market은 kospi나 kosdaq입니다: {other}"))),
            None => return Err(ApiFailure::bad_request("market이 없습니다")),
        };
        let period = match query.get("period").map(String::as_str) {
            None => DEFAULT_PERIOD,
            Some("5") => MarketOverviewPeriod::Days5,
            Some("20") => MarketOverviewPeriod::Days20,
            Some("60") => MarketOverviewPeriod::Days60,
            Some(other) => return Err(ApiFailure::bad_request(format!("period는 5, 20, 60입니다: {other}"))),
        };
        Ok(Params { market, period })
    }
}

struct Answers {
    latest: Option<KstTime>,
    source: Broker,
}

impl Answers {
    fn new(source: Broker) -> Answers {
        Answers { latest: None, source }
    }

    async fn ask<T>(&mut self, env: &CardEnv<'_>, call: impl Future<Output = Result<T, SourceError>>) -> Result<T, ApiErrorBody> {
        match call.await {
            Ok(value) => {
                self.latest = Some(env.clock.now());
                Ok(value)
            }
            Err(e) => Err(failed(env.clock, e)),
        }
    }

    fn context(&self, clock: &Clock, market: Market) -> MarketOverviewContext {
        MarketOverviewContext { market, phase: phase(clock.now()), received_at: self.latest.map(|t| api::UnixSeconds(t.unix())), source: self.source }
    }
}

fn failed(clock: &Clock, error: SourceError) -> ApiErrorBody {
    Lookup::MarketOverview.failure(BarError::from(error), clock.now()).into_body()
}

fn part<T>(result: Result<T, ApiErrorBody>) -> MarketOverviewPart<T> {
    match result {
        Ok(value) => MarketOverviewPart::Ok { value },
        Err(error) => MarketOverviewPart::Failed { error },
    }
}

fn env_of<'a>(st: &'a AppState, picked: &'a crate::market_source::route::Picked<dyn OverviewSource>) -> CardEnv<'a> {
    CardEnv { source: picked.source.as_ref(), broker: picked.broker, clock: &st.clock, priority: Priority::Screen, book: &st.market_overview }
}

pub async fn index(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewIndexCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    if let Some(shared) = shared::answer(&st, params.market, "지수 칸", |cards| cards.index.as_ref()) {
        return shared;
    }
    let picked = overview_source(&st);
    Ok(Json(index_card(&env_of(&st, &picked), params.market).await))
}

pub async fn index_card(env: &CardEnv<'_>, market: Market) -> MarketOverviewIndexCard {
    let mut answers = Answers::new(env.broker);
    let index = part(answers.ask(env, env.source.index(market, env.priority)).await.map(index_dto));
    MarketOverviewIndexCard { context: answers.context(env.clock, market), index }
}

fn index_dto(snapshot: MarketIndexSnapshot) -> MarketOverviewIndex {
    let (whole, breadth) = (snapshot.whole, snapshot.breadth);
    MarketOverviewIndex {
        code: whole.code,
        name: whole.name,
        level: whole.level,
        change_rate: whole.change_rate,
        breadth: MarketOverviewBreadth { rising: breadth.rising, flat: breadth.flat, falling: breadth.falling, upper_limit: breadth.upper_limit, lower_limit: breadth.lower_limit },
        trade_value_eok: whole.trade_value_eok,
        volatility: snapshot.volatility.map(|v| MarketOverviewVolatility { level: v.level, change_rate: v.change_rate }),
    }
}

pub async fn sectors(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewSectorsCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    if let Some(shared) = shared::answer(&st, params.market, "업종 칸", |cards| cards.sectors.as_ref()) {
        return shared;
    }
    let picked = overview_source(&st);
    Ok(Json(sectors_card(&env_of(&st, &picked), params.market).await))
}

pub async fn sectors_card(env: &CardEnv<'_>, market: Market) -> MarketOverviewSectorsCard {
    let today = env.clock.now().kst_date();
    let (mut level_answers, mut flow_answers) = (Answers::new(env.broker), Answers::new(env.broker));
    let (levels, flows) = tokio::join!(level_answers.ask(env, env.source.sector_levels(market, env.priority)), flow_answers.ask(env, env.source.sector_flows(market, today, env.priority)));
    let sectors = part(levels.map(|rows| rows.into_iter().map(sector_dto).collect()));
    let flows = part(flows.map(|rows| rows.into_iter().map(sector_flow_dto).collect()));
    let latest = level_answers.latest.max(flow_answers.latest);
    MarketOverviewSectorsCard { context: Answers { latest, source: env.broker }.context(env.clock, market), sectors, flows }
}

fn sector_dto(row: IndexLevel) -> MarketOverviewSector {
    MarketOverviewSector { code: row.code, name: row.name, level: row.level, change_rate: row.change_rate, trade_value_eok: row.trade_value_eok }
}

fn sector_flow_dto(row: SectorFlow) -> MarketOverviewSectorFlow {
    MarketOverviewSectorFlow { code: row.code, name: row.name, whole_market: row.whole_market, individual_eok: row.net.individual, foreign_eok: row.net.foreign, institution_eok: row.net.institution }
}

async fn trading_days(env: &CardEnv<'_>, market: Market, period: MarketOverviewPeriod, answers: &mut Answers) -> Result<Vec<TradingDay>, ApiErrorBody> {
    let mut days = answers.ask(env, env.source.trading_days(market, env.clock.now().kst_date(), env.priority)).await?;
    let keep = days.len().saturating_sub(period.days());
    days.drain(..keep);
    Ok(days)
}

pub async fn turnover(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewTurnoverCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    if let Some(shared) = shared::answer(&st, params.market, "거래대금 칸", |cards| cards.turnover.iter().find(|card| card.period == params.period)) {
        return shared;
    }
    let picked = overview_source(&st);
    Ok(Json(turnover_card(&env_of(&st, &picked), params.market, params.period).await))
}

pub async fn turnover_card(env: &CardEnv<'_>, market: Market, period: MarketOverviewPeriod) -> MarketOverviewTurnoverCard {
    let mut answers = Answers::new(env.broker);
    let days = part(trading_days(env, market, period, &mut answers).await.map(|days| days.iter().map(|d| MarketOverviewTurnoverDay { date: api::KstDate(d.date), trade_value_eok: d.trade_value_eok }).collect()));
    MarketOverviewTurnoverCard { context: answers.context(env.clock, market), period, days }
}

pub async fn flow(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewFlowCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    if let Some(shared) = shared::answer(&st, params.market, "수급 칸", |cards| cards.flow.iter().find(|card| card.period == params.period)) {
        return shared;
    }
    let picked = overview_source(&st);
    Ok(Json(flow_card(&env_of(&st, &picked), params.market, params.period).await))
}

pub async fn flow_card(env: &CardEnv<'_>, market: Market, period: MarketOverviewPeriod) -> MarketOverviewFlowCard {
    let (mut investor_answers, mut program_answers) = (Answers::new(env.broker), Answers::new(env.broker));
    let (investors, program) = tokio::join!(investor_days(env, market, period, &mut investor_answers), program_days(env, market, period, &mut program_answers));
    let latest = investor_answers.latest.max(program_answers.latest);
    MarketOverviewFlowCard { context: Answers { latest, source: env.broker }.context(env.clock, market), period, investors: part(investors), program: part(program) }
}

async fn investor_days(env: &CardEnv<'_>, market: Market, period: MarketOverviewPeriod, answers: &mut Answers) -> Result<Vec<MarketOverviewInvestorDay>, ApiErrorBody> {
    let started = env.book.ticket();
    let days = trading_days(env, market, period, answers).await?;
    let mut rows = Vec::with_capacity(days.len());
    for day in days.iter().map(|d| d.date) {
        let now = env.clock.now();
        if let Some(cached) = env.book.cached_investor_day(now, env.broker, market, day) {
            rows.push(cached);
            continue;
        }
        let net = answers.ask(env, env.source.investor_day(market, day, env.priority)).await?;
        let row = MarketOverviewInvestorDay { date: api::KstDate(day), individual_eok: net.individual, foreign_eok: net.foreign, institution_eok: net.institution };
        if day < observation_day(now) {
            env.book.cache_investor_day(now, env.broker, market, row.clone(), started);
        }
        rows.push(row);
    }
    Ok(rows)
}

async fn program_days(env: &CardEnv<'_>, market: Market, period: MarketOverviewPeriod, answers: &mut Answers) -> Result<Vec<MarketOverviewProgramDay>, ApiErrorBody> {
    let mut rows = answers.ask(env, env.source.program_days(market, env.clock.now().kst_date(), env.priority)).await?;
    let keep = rows.len().saturating_sub(period.days());
    Ok(rows.split_off(keep).into_iter().map(|r| MarketOverviewProgramDay { date: api::KstDate(r.date), arbitrage_eok: r.arbitrage_eok, non_arbitrage_eok: r.non_arbitrage_eok, total_eok: r.total_eok }).collect())
}

pub async fn intraday_flow(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewIntradayFlow>, ApiFailure> {
    let params = Params::parse(&query)?;
    let now = st.clock.now();
    let (samples, source) = match st.shared_data.serving() {
        true => (shared::samples(&st, now, params.market), shared::broker(&st)),
        false => (st.market_overview.samples.samples(now, params.market), overview_source(&st).broker),
    };
    let mut points: BTreeMap<i64, MarketOverviewIntradayPoint> = BTreeMap::new();
    for sample in &samples {
        let point = points.entry(sample.at).or_insert(MarketOverviewIntradayPoint { at: api::UnixSeconds(sample.at), individual_eok: None, foreign_eok: None, institution_eok: None, program_eok: None });
        match &sample.value {
            SampleValue::Investors { individual_eok, foreign_eok, institution_eok } => {
                (point.individual_eok, point.foreign_eok, point.institution_eok) = (Some(*individual_eok), Some(*foreign_eok), Some(*institution_eok));
            }
            SampleValue::Program { total_million_won, .. } => point.program_eok = Some(*total_million_won as f64 / MILLION_WON_PER_EOK),
        }
    }
    let latest = samples.iter().map(|s| s.received_at).max().map(KstTime::from_unix);
    Ok(Json(MarketOverviewIntradayFlow { context: Answers { latest, source }.context(&st.clock, params.market), day: api::KstDate(observation_day(now)), points: points.into_values().collect() }))
}

const MILLION_WON_PER_EOK: f64 = 100.0;

pub async fn streaks(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewStreaksCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    if let Some(shared) = shared::answer(&st, params.market, "연속 매매 칸", |cards| cards.streaks.as_ref()) {
        return shared;
    }
    let picked = overview_source(&st);
    let directory = feature_symbol_list(&st).await.map_err(ApiFailure::into_body);
    let shown = |row: &StreakRow| !directory.as_ref().ok().and_then(|directory| directory.get(Symbol::Stock(row.code))).is_some_and(|info| matches!(info.kind, SymbolKind::Etf | SymbolKind::Etn));
    let filter: StreakFilter<'_> = match &directory {
        Ok(_) => Ok(&shown),
        Err(error) => Err(error.clone()),
    };
    Ok(Json(streaks_card(&env_of(&st, &picked), params.market, filter).await))
}

pub async fn streaks_card(env: &CardEnv<'_>, market: Market, shown: StreakFilter<'_>) -> MarketOverviewStreaksCard {
    let (mut buy_answers, mut sell_answers) = (Answers::new(env.broker), Answers::new(env.broker));
    let (buying, selling) = tokio::join!(buy_answers.ask(env, env.source.streaks(StreakSide::Buying, market, env.priority)), sell_answers.ask(env, env.source.streaks(StreakSide::Selling, market, env.priority)));
    let board = |result: Result<Vec<StreakRow>, ApiErrorBody>, direction: i64| match (&shown, result) {
        (Err(error), _) => MarketOverviewPart::Failed { error: error.clone() },
        (Ok(shown), result) => part(result.map(|rows| streak_board(&rows, direction, *shown))),
    };
    let latest = buy_answers.latest.max(sell_answers.latest);
    MarketOverviewStreaksCard { context: Answers { latest, source: env.broker }.context(env.clock, market), buying: board(buying, 1), selling: board(selling, -1) }
}

fn streak_board(rows: &[StreakRow], direction: i64, shown: &(dyn Fn(&StreakRow) -> bool + Sync)) -> MarketOverviewStreakBoard {
    let pick = |columns: fn(&StreakRow) -> StreakColumn| -> Vec<MarketOverviewStreak> {
        rows.iter().filter(|row| shown(row)).filter(|row| columns(row).days.signum() == direction).map(|row| {
            let c = columns(row);
            MarketOverviewStreak { code: api::SymbolCode(Symbol::Stock(row.code).as_wire()), name: row.name.clone(), days: c.days, net_eok: c.net_eok, net_shares: c.net_shares, period_change_rate: row.period_change_rate }
        }).collect()
    };
    MarketOverviewStreakBoard { foreign: pick(|row| row.foreign), institution: pick(|row| row.institution) }
}
