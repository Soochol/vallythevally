use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use domain::{KstTime, Symbol, SymbolKind};

use super::dto::*;
use super::overview_source;
use super::samples::SampleValue;
use super::session::{observation_day, phase};
use crate::api::{self, ApiErrorBody, Market};
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, symbol_list};
use crate::market_source::{IndexLevel, MarketIndexSnapshot, Priority, SectorFlow, SourceError, StreakColumn, StreakRow, StreakSide, TradingDay};

const DEFAULT_PERIOD: MarketOverviewPeriod = MarketOverviewPeriod::Days20;

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
}

impl Answers {
    fn new() -> Answers {
        Answers { latest: None }
    }

    async fn ask<T>(&mut self, st: &AppState, call: impl Future<Output = Result<T, SourceError>>) -> Result<T, ApiErrorBody> {
        match call.await {
            Ok(value) => {
                self.latest = Some(st.clock.now());
                Ok(value)
            }
            Err(e) => Err(failed(st, e)),
        }
    }

    fn context(&self, st: &AppState, market: Market) -> MarketOverviewContext {
        MarketOverviewContext { market, phase: phase(st.clock.now()), received_at: self.latest.map(|t| api::UnixSeconds(t.unix())) }
    }
}

fn failed(st: &AppState, error: SourceError) -> ApiErrorBody {
    Lookup::MarketOverview.failure(BarError::from(error), st.clock.now()).into_body()
}

fn part<T>(result: Result<T, ApiErrorBody>) -> MarketOverviewPart<T> {
    match result {
        Ok(value) => MarketOverviewPart::Ok { value },
        Err(error) => MarketOverviewPart::Failed { error },
    }
}

pub async fn index(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewIndexCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let source = overview_source(&st);
    let mut answers = Answers::new();
    let index = part(answers.ask(&st, source.index(params.market, Priority::Screen)).await.map(index_dto));
    Ok(Json(MarketOverviewIndexCard { context: answers.context(&st, params.market), index }))
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
    let source = overview_source(&st);
    let today = st.clock.now().kst_date();
    let (mut level_answers, mut flow_answers) = (Answers::new(), Answers::new());
    let (levels, flows) = tokio::join!(level_answers.ask(&st, source.sector_levels(params.market, Priority::Screen)), flow_answers.ask(&st, source.sector_flows(params.market, today, Priority::Screen)));
    let sectors = part(levels.map(|rows| rows.into_iter().map(sector_dto).collect()));
    let flows = part(flows.map(|rows| rows.into_iter().map(sector_flow_dto).collect()));
    let latest = level_answers.latest.max(flow_answers.latest);
    Ok(Json(MarketOverviewSectorsCard { context: Answers { latest }.context(&st, params.market), sectors, flows }))
}

fn sector_dto(row: IndexLevel) -> MarketOverviewSector {
    MarketOverviewSector { code: row.code, name: row.name, level: row.level, change_rate: row.change_rate, trade_value_eok: row.trade_value_eok }
}

fn sector_flow_dto(row: SectorFlow) -> MarketOverviewSectorFlow {
    MarketOverviewSectorFlow { code: row.code, name: row.name, whole_market: row.whole_market, individual_eok: row.net.individual, foreign_eok: row.net.foreign, institution_eok: row.net.institution }
}

async fn trading_days(st: &AppState, params: &Params, answers: &mut Answers) -> Result<Vec<TradingDay>, ApiErrorBody> {
    let source = overview_source(st);
    let mut days = answers.ask(st, source.trading_days(params.market, st.clock.now().kst_date(), Priority::Screen)).await?;
    let keep = days.len().saturating_sub(params.period.days());
    days.drain(..keep);
    Ok(days)
}

pub async fn turnover(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewTurnoverCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let mut answers = Answers::new();
    let days = part(trading_days(&st, &params, &mut answers).await.map(|days| days.iter().map(|d| MarketOverviewTurnoverDay { date: api::KstDate(d.date), trade_value_eok: d.trade_value_eok }).collect()));
    Ok(Json(MarketOverviewTurnoverCard { context: answers.context(&st, params.market), period: params.period, days }))
}

pub async fn flow(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewFlowCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let (mut investor_answers, mut program_answers) = (Answers::new(), Answers::new());
    let (investors, program) = tokio::join!(investor_days(&st, &params, &mut investor_answers), program_days(&st, &params, &mut program_answers));
    let latest = investor_answers.latest.max(program_answers.latest);
    Ok(Json(MarketOverviewFlowCard { context: Answers { latest }.context(&st, params.market), period: params.period, investors: part(investors), program: part(program) }))
}

async fn investor_days(st: &AppState, params: &Params, answers: &mut Answers) -> Result<Vec<MarketOverviewInvestorDay>, ApiErrorBody> {
    let started = st.market_overview.ticket();
    let source = overview_source(st);
    let days = trading_days(st, params, answers).await?;
    let mut rows = Vec::with_capacity(days.len());
    for day in days.iter().map(|d| d.date) {
        let now = st.clock.now();
        if let Some(cached) = st.market_overview.cached_investor_day(now, params.market, day) {
            rows.push(cached);
            continue;
        }
        let net = answers.ask(st, source.investor_day(params.market, day, Priority::Screen)).await?;
        let row = MarketOverviewInvestorDay { date: api::KstDate(day), individual_eok: net.individual, foreign_eok: net.foreign, institution_eok: net.institution };
        if day < observation_day(now) {
            st.market_overview.cache_investor_day(now, params.market, row.clone(), started);
        }
        rows.push(row);
    }
    Ok(rows)
}

async fn program_days(st: &AppState, params: &Params, answers: &mut Answers) -> Result<Vec<MarketOverviewProgramDay>, ApiErrorBody> {
    let source = overview_source(st);
    let mut rows = answers.ask(st, source.program_days(params.market, st.clock.now().kst_date(), Priority::Screen)).await?;
    let keep = rows.len().saturating_sub(params.period.days());
    Ok(rows.split_off(keep).into_iter().map(|r| MarketOverviewProgramDay { date: api::KstDate(r.date), arbitrage_eok: r.arbitrage_eok, non_arbitrage_eok: r.non_arbitrage_eok, total_eok: r.total_eok }).collect())
}

pub async fn intraday_flow(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewIntradayFlow>, ApiFailure> {
    let params = Params::parse(&query)?;
    let now = st.clock.now();
    let samples = st.market_overview.samples.samples(now, params.market);
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
    Ok(Json(MarketOverviewIntradayFlow { context: Answers { latest }.context(&st, params.market), day: api::KstDate(observation_day(now)), points: points.into_values().collect() }))
}

const MILLION_WON_PER_EOK: f64 = 100.0;

pub async fn streaks(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewStreaksCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let source = overview_source(&st);
    let directory = symbol_list(&st).await.map_err(ApiFailure::into_body);
    let (mut buy_answers, mut sell_answers) = (Answers::new(), Answers::new());
    let (buying, selling) = tokio::join!(buy_answers.ask(&st, source.streaks(StreakSide::Buying, params.market, Priority::Screen)), sell_answers.ask(&st, source.streaks(StreakSide::Selling, params.market, Priority::Screen)));
    let board = |result: Result<Vec<StreakRow>, ApiErrorBody>, direction: i64| match (&directory, result) {
        (Err(error), _) => MarketOverviewPart::Failed { error: error.clone() },
        (Ok(directory), result) => part(result.map(|rows| streak_board(&rows, direction, directory))),
    };
    let latest = buy_answers.latest.max(sell_answers.latest);
    Ok(Json(MarketOverviewStreaksCard { context: Answers { latest }.context(&st, params.market), buying: board(buying, 1), selling: board(selling, -1) }))
}

fn streak_board(rows: &[StreakRow], direction: i64, directory: &crate::symbols::Directory) -> MarketOverviewStreakBoard {
    let shown = |row: &&StreakRow| !directory.get(Symbol::Stock(row.code)).is_some_and(|info| matches!(info.kind, SymbolKind::Etf | SymbolKind::Etn));
    let pick = |columns: fn(&StreakRow) -> StreakColumn| -> Vec<MarketOverviewStreak> {
        rows.iter().filter(shown).filter(|row| columns(row).days.signum() == direction).map(|row| {
            let c = columns(row);
            MarketOverviewStreak { code: api::SymbolCode(Symbol::Stock(row.code).as_wire()), name: row.name.clone(), days: c.days, net_eok: c.net_eok, net_shares: c.net_shares, period_change_rate: row.period_change_rate }
        }).collect()
    };
    MarketOverviewStreakBoard { foreign: pick(|row| row.foreign), institution: pick(|row| row.institution) }
}
