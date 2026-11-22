use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use domain::{KstTime, Symbol, SymbolKind};

use super::dto::*;
use super::samples::SampleValue;
use super::session::{observation_day, phase};
use crate::api::{self, ApiErrorBody, Market};
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, symbol_list};
use crate::kiwoom::api::{AllIndices, IndexDailyChart, InstitutionForeignStreak, ListedMarket, MarketRequest, ProgramTrendByDay, SectorInvestorNet, StreakSide};
use crate::kiwoom::rest::KiwoomError;
use crate::market_source::{MergeScope, Priority, SourceFailure};
use crate::kiwoom::wire::{ProgramNetMillionWon, SectorInvestorRow, index_trade_days};

const MILLION_WON_PER_EOK: f64 = 100.0;
const VOLATILITY_INDEX_CODE: &str = "603";
const DEFAULT_PERIOD: MarketOverviewPeriod = MarketOverviewPeriod::Days20;

pub fn listed(market: Market) -> ListedMarket {
    match market {
        Market::Kospi => ListedMarket::Kospi,
        Market::Kosdaq => ListedMarket::Kosdaq,
    }
}

fn eok(million_won: impl Into<i128>) -> f64 {
    million_won.into() as f64 / MILLION_WON_PER_EOK
}

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

    fn index_code(&self) -> &'static str {
        index_code(self.market)
    }
}

pub fn index_code(market: Market) -> &'static str {
    match market {
        Market::Kospi => "001",
        Market::Kosdaq => "101",
    }
}

struct Answers {
    latest: Option<KstTime>,
}

impl Answers {
    fn new() -> Answers {
        Answers { latest: None }
    }

    async fn ask<R: MarketRequest>(&mut self, st: &AppState, request: &R) -> Result<R::Response, ApiErrorBody> {
        let rest = st.kiwoom.rest().map_err(|e| failed(st, e))?;
        match rest.call(request, None, Priority::Screen, MergeScope::default()).await {
            Ok(page) => {
                self.latest = Some(st.clock.now());
                Ok(page.body)
            }
            Err(e) => Err(failed(st, e)),
        }
    }

    fn context(&self, st: &AppState, market: Market) -> MarketOverviewContext {
        MarketOverviewContext { market, phase: phase(st.clock.now()), received_at: self.latest.map(|t| api::UnixSeconds(t.unix())) }
    }
}

fn failed(st: &AppState, error: KiwoomError) -> ApiErrorBody {
    Lookup::MarketOverview.failure(BarError::Source(SourceFailure::from(&error)), st.clock.now()).into_body()
}

fn protocol_failure(message: impl Into<String>) -> ApiErrorBody {
    ApiFailure::kiwoom_protocol(message).into_body()
}

fn part<T>(result: Result<T, ApiErrorBody>) -> MarketOverviewPart<T> {
    match result {
        Ok(value) => MarketOverviewPart::Ok { value },
        Err(error) => MarketOverviewPart::Failed { error },
    }
}

pub async fn index(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewIndexCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let mut answers = Answers::new();
    let index = part(answers.ask(&st, &AllIndices::new(listed(params.market))).await.and_then(|body| index_of(&params, &body.rows().rows).map_err(protocol_failure)));
    Ok(Json(MarketOverviewIndexCard { context: answers.context(&st, params.market), index }))
}

fn index_of(params: &Params, rows: &[crate::kiwoom::wire::IndexBreadthRow]) -> Result<MarketOverviewIndex, String> {
    let whole = rows.iter().find(|r| r.code == params.index_code()).ok_or_else(|| format!("키움 전업종지수 응답에 종합지수({}) 행이 없습니다", params.index_code()))?;
    let volatility = rows.iter().find(|r| r.code == VOLATILITY_INDEX_CODE).map(|r| MarketOverviewVolatility { level: r.level, change_rate: r.change_rate });
    Ok(MarketOverviewIndex {
        code: whole.code.clone(),
        name: whole.name.clone(),
        level: whole.level,
        change_rate: whole.change_rate,
        breadth: MarketOverviewBreadth {
            rising: count(whole.rising),
            flat: count(whole.flat),
            falling: count(whole.falling),
            upper_limit: count(whole.upper_limit),
            lower_limit: count(whole.lower_limit),
        },
        trade_value_eok: eok(whole.trade_million_won),
        volatility,
    })
}

fn count(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

pub async fn sectors(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewSectorsCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let market = listed(params.market);
    let today = st.clock.now().kst_date();
    let (mut level_answers, mut flow_answers) = (Answers::new(), Answers::new());
    let (level_request, flow_request) = (AllIndices::new(market), SectorInvestorNet::new(market, today));
    let (levels, flows) = tokio::join!(level_answers.ask(&st, &level_request), flow_answers.ask(&st, &flow_request));
    let sectors = part(levels.map(|body| {
        body.rows().rows.iter().filter(|r| r.code != params.index_code() && r.code != VOLATILITY_INDEX_CODE).map(|r| MarketOverviewSector { code: r.code.clone(), name: r.name.clone(), level: r.level, change_rate: r.change_rate, trade_value_eok: eok(r.trade_million_won) }).collect()
    }));
    let flows = part(flows.map(|body| body.rows().rows.iter().map(|r| sector_flow(&params, r)).collect()));
    let latest = level_answers.latest.max(flow_answers.latest);
    Ok(Json(MarketOverviewSectorsCard { context: Answers { latest }.context(&st, params.market), sectors, flows }))
}

fn sector_flow(params: &Params, row: &SectorInvestorRow) -> MarketOverviewSectorFlow {
    MarketOverviewSectorFlow { code: row.code.clone(), name: row.name.clone(), whole_market: row.code == params.index_code(), individual_eok: row.individual_eok, foreign_eok: row.foreign_eok, institution_eok: row.institution_eok }
}

async fn trading_days(st: &AppState, params: &Params, answers: &mut Answers) -> Result<Vec<crate::kiwoom::wire::IndexTradeDay>, ApiErrorBody> {
    let request = IndexDailyChart::new(listed(params.market).index_code(), st.clock.now().kst_date());
    let body = answers.ask(st, &request).await?;
    let mut days = index_trade_days(body).rows;
    let keep = days.len().saturating_sub(params.period.days());
    days.drain(..keep);
    Ok(days)
}

pub async fn turnover(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewTurnoverCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let mut answers = Answers::new();
    let days = part(trading_days(&st, &params, &mut answers).await.map(|days| days.iter().map(|d| MarketOverviewTurnoverDay { date: api::KstDate(d.day), trade_value_eok: eok(d.trade_million_won) }).collect()));
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
    let days = trading_days(st, params, answers).await?;
    let market = listed(params.market);
    let mut rows = Vec::with_capacity(days.len());
    for day in days.iter().map(|d| d.day) {
        let now = st.clock.now();
        if let Some(cached) = st.market_overview.cached_investor_day(now, params.market, day) {
            rows.push(cached);
            continue;
        }
        let body = answers.ask(st, &SectorInvestorNet::new(market, day)).await?;
        let Some(whole) = body.rows().rows.into_iter().find(|r| r.code == params.index_code()) else {
            return Err(protocol_failure(format!("키움 업종별 투자자 순매수가 {day}의 종합({}) 행을 주지 않았습니다", params.index_code())));
        };
        let row = MarketOverviewInvestorDay { date: api::KstDate(day), individual_eok: whole.individual_eok, foreign_eok: whole.foreign_eok, institution_eok: whole.institution_eok };
        if day < observation_day(now) {
            st.market_overview.cache_investor_day(now, params.market, row.clone());
        }
        rows.push(row);
    }
    Ok(rows)
}

fn program_eok(net: ProgramNetMillionWon) -> (f64, f64, f64) {
    (eok(net.arbitrage), eok(net.non_arbitrage), eok(net.total))
}

async fn program_days(st: &AppState, params: &Params, answers: &mut Answers) -> Result<Vec<MarketOverviewProgramDay>, ApiErrorBody> {
    let body = answers.ask(st, &ProgramTrendByDay::new(listed(params.market), st.clock.now().kst_date())).await?;
    let mut rows = body.rows().rows;
    rows.sort_by_key(|r| r.day);
    let keep = rows.len().saturating_sub(params.period.days());
    Ok(rows.split_off(keep).into_iter().map(|r| {
        let (arbitrage_eok, non_arbitrage_eok, total_eok) = program_eok(r.net);
        MarketOverviewProgramDay { date: api::KstDate(r.day), arbitrage_eok, non_arbitrage_eok, total_eok }
    }).collect())
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
            SampleValue::Program { total_million_won, .. } => point.program_eok = Some(eok(*total_million_won)),
        }
    }
    let latest = samples.iter().map(|s| s.received_at).max().map(KstTime::from_unix);
    Ok(Json(MarketOverviewIntradayFlow { context: Answers { latest }.context(&st, params.market), day: api::KstDate(observation_day(now)), points: points.into_values().collect() }))
}

pub async fn streaks(State(st): State<Arc<AppState>>, Query(query): Query<HashMap<String, String>>) -> Result<Json<MarketOverviewStreaksCard>, ApiFailure> {
    let params = Params::parse(&query)?;
    let market = listed(params.market);
    let directory = symbol_list(&st).await.map_err(ApiFailure::into_body);
    let (mut buy_answers, mut sell_answers) = (Answers::new(), Answers::new());
    let (buy_request, sell_request) = (InstitutionForeignStreak::new(StreakSide::Buying, market), InstitutionForeignStreak::new(StreakSide::Selling, market));
    let (buying, selling) = tokio::join!(buy_answers.ask(&st, &buy_request), sell_answers.ask(&st, &sell_request));
    let board = |result: Result<crate::kiwoom::wire::InstitutionForeignStreakResponse, ApiErrorBody>, direction: i64| match (&directory, result) {
        (Err(error), _) => MarketOverviewPart::Failed { error: error.clone() },
        (Ok(directory), result) => part(result.map(|body| streak_board(&body, direction, directory))),
    };
    let latest = buy_answers.latest.max(sell_answers.latest);
    Ok(Json(MarketOverviewStreaksCard { context: Answers { latest }.context(&st, params.market), buying: board(buying, 1), selling: board(selling, -1) }))
}

fn streak_board(body: &crate::kiwoom::wire::InstitutionForeignStreakResponse, direction: i64, directory: &crate::symbols::Directory) -> MarketOverviewStreakBoard {
    let rows = body.rows().rows;
    let shown = |row: &&crate::kiwoom::wire::InstitutionForeignStreakRow| !directory.get(Symbol::Stock(row.code)).is_some_and(|info| matches!(info.kind, SymbolKind::Etf | SymbolKind::Etn));
    let pick = |columns: fn(&crate::kiwoom::wire::InstitutionForeignStreakRow) -> crate::kiwoom::wire::StreakColumns| -> Vec<MarketOverviewStreak> {
        rows.iter().filter(shown).filter(|row| columns(row).days.signum() == direction).map(|row| {
            let c = columns(row);
            MarketOverviewStreak { code: api::SymbolCode(Symbol::Stock(row.code).as_wire()), name: row.name.clone(), days: c.days, net_eok: eok(c.net_million_won), net_shares: c.net_shares, period_change_rate: row.period_change_rate }
        }).collect()
    };
    MarketOverviewStreakBoard { foreign: pick(|row| row.foreign), institution: pick(|row| row.institution) }
}
