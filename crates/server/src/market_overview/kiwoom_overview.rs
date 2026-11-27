use std::collections::HashSet;

use domain::{KstDate, KstTime, StockCode, Symbol};
use futures::future::BoxFuture;

use crate::api::{self, Market};
use crate::kiwoom::api::{AllIndices, IndexDailyChart, InstitutionForeignStreak, ListedMarket, MarketRequest, ProgramTrendByDay, ProgramTrendByMinute, SectorInvestorNet, StockForeignHoldings, StockInvestorNetShares, StockProgramDaily};
use crate::kiwoom::rest::{Access, ContKey, KiwoomRest};
use crate::kiwoom::wire::{DayPage, IndexBreadthRow, InstitutionForeignStreakRow, ProgramNetMillionWon, StreakColumns, index_trade_days};
use crate::market_source::{
    DayRange, IndexBreadth, IndexLevel, IntradayProgram, InvestorNetEok, KiwoomHandle, MarketIndexSnapshot, MergeScope, OverviewFeature, OverviewFeatures, OverviewSource, Priority, ProgramDay, ProgramSplit,
    SectorFlow, SourceError, StreakColumn, StreakRow, StreakSide, TradingDay, VolatilityLevel, protocol,
};

const MILLION_WON_PER_EOK: f64 = 100.0;
const VOLATILITY_INDEX_CODE: &str = "603";

pub fn listed(market: Market) -> ListedMarket {
    match market {
        Market::Kospi => ListedMarket::Kospi,
        Market::Kosdaq => ListedMarket::Kosdaq,
    }
}

fn whole_index_code(market: Market) -> &'static str {
    match market {
        Market::Kospi => "001",
        Market::Kosdaq => "101",
    }
}

fn eok(million_won: i64) -> f64 {
    million_won as f64 / MILLION_WON_PER_EOK
}

fn count(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[derive(Clone)]
pub struct KiwoomOverview {
    handle: KiwoomHandle,
}

impl KiwoomOverview {
    pub fn new(handle: KiwoomHandle) -> Self {
        KiwoomOverview { handle }
    }

    fn rest(&self) -> Result<KiwoomRest, SourceError> {
        Ok(self.handle.rest()?)
    }

    async fn ask<R: MarketRequest>(&self, request: &R, priority: Priority) -> Result<R::Response, SourceError> {
        Ok(self.rest()?.call(request, None, priority, MergeScope::default()).await?.body)
    }

    async fn whole_market_flow(&self, market: Market, day: KstDate, priority: Priority) -> Result<Option<crate::kiwoom::wire::SectorInvestorRow>, SourceError> {
        let body = self.ask(&SectorInvestorNet::new(listed(market), day), priority).await?;
        Ok(body.rows().rows.into_iter().find(|r| r.code == whole_index_code(market)))
    }
}

fn index_snapshot(market: Market, rows: &[IndexBreadthRow]) -> Result<MarketIndexSnapshot, SourceError> {
    let code = whole_index_code(market);
    let whole = rows.iter().find(|r| r.code == code).ok_or_else(|| protocol(format!("키움 전업종지수 응답에 종합지수({code}) 행이 없습니다")))?;
    let volatility = rows.iter().find(|r| r.code == VOLATILITY_INDEX_CODE).map(|r| VolatilityLevel { level: r.level, change_rate: r.change_rate });
    Ok(MarketIndexSnapshot {
        whole: index_level(whole),
        breadth: IndexBreadth {
            rising: Some(count(whole.rising)),
            flat: Some(count(whole.flat)),
            falling: Some(count(whole.falling)),
            upper_limit: Some(count(whole.upper_limit)),
            lower_limit: Some(count(whole.lower_limit)),
        },
        volatility,
    })
}

fn index_level(row: &IndexBreadthRow) -> IndexLevel {
    IndexLevel { code: row.code.clone(), name: row.name.clone(), level: row.level, change_rate: row.change_rate, trade_value_eok: eok(i64::try_from(row.trade_million_won).unwrap_or(i64::MAX)) }
}

fn program_eok(net: ProgramNetMillionWon) -> (f64, f64, f64) {
    (eok(net.arbitrage), eok(net.non_arbitrage), eok(net.total))
}

fn streak_column(columns: StreakColumns) -> StreakColumn {
    StreakColumn { days: columns.days, net_eok: eok(columns.net_million_won), net_shares: columns.net_shares }
}

fn streak_row(row: InstitutionForeignStreakRow) -> StreakRow {
    StreakRow { code: row.code, name: row.name, foreign: streak_column(row.foreign), institution: streak_column(row.institution), period_change_rate: row.period_change_rate }
}

impl OverviewSource for KiwoomOverview {
    fn broker(&self) -> crate::api::Broker {
        crate::api::Broker::Kiwoom
    }

    fn features(&self) -> OverviewFeatures {
        OverviewFeatures::of(OverviewFeature::ALL)
    }

    fn is_open(&self) -> bool {
        self.handle.rest().is_ok_and(|rest| rest.access() == Access::Open)
    }

    fn index(&self, market: Market, priority: Priority) -> BoxFuture<'_, Result<MarketIndexSnapshot, SourceError>> {
        Box::pin(async move {
            let body = self.ask(&AllIndices::new(listed(market)), priority).await?;
            index_snapshot(market, &body.rows().rows)
        })
    }

    fn sector_levels(&self, market: Market, priority: Priority) -> BoxFuture<'_, Result<Vec<IndexLevel>, SourceError>> {
        Box::pin(async move {
            let body = self.ask(&AllIndices::new(listed(market)), priority).await?;
            Ok(body.rows().rows.iter().filter(|r| r.code != whole_index_code(market) && r.code != VOLATILITY_INDEX_CODE).map(index_level).collect())
        })
    }

    fn sector_flows(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<SectorFlow>, SourceError>> {
        Box::pin(async move {
            let body = self.ask(&SectorInvestorNet::new(listed(market), today), priority).await?;
            Ok(body
                .rows()
                .rows
                .into_iter()
                .map(|r| SectorFlow {
                    whole_market: r.code == whole_index_code(market),
                    code: r.code,
                    name: r.name,
                    net: InvestorNetEok { individual: r.individual_eok, foreign: r.foreign_eok, institution: r.institution_eok },
                })
                .collect())
        })
    }

    fn trading_days(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<TradingDay>, SourceError>> {
        Box::pin(async move {
            let body = self.ask(&IndexDailyChart::new(listed(market).index_code(), today), priority).await?;
            Ok(index_trade_days(body).rows.into_iter().map(|d| TradingDay { date: d.day, trade_value_eok: eok(i64::try_from(d.trade_million_won).unwrap_or(i64::MAX)) }).collect())
        })
    }

    fn investor_day(&self, market: Market, day: KstDate, priority: Priority) -> BoxFuture<'_, Result<InvestorNetEok, SourceError>> {
        Box::pin(async move {
            let Some(whole) = self.whole_market_flow(market, day, priority).await? else {
                return Err(protocol(format!("키움 업종별 투자자 순매수가 {day}의 종합({}) 행을 주지 않았습니다", whole_index_code(market))));
            };
            Ok(InvestorNetEok { individual: whole.individual_eok, foreign: whole.foreign_eok, institution: whole.institution_eok })
        })
    }

    fn program_days(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<ProgramDay>, SourceError>> {
        Box::pin(async move {
            let body = self.ask(&ProgramTrendByDay::new(listed(market), today), priority).await?;
            let mut rows = body.rows().rows;
            rows.sort_by_key(|r| r.day);
            Ok(rows
                .into_iter()
                .map(|r| {
                    let (arbitrage_eok, non_arbitrage_eok, total_eok) = program_eok(r.net);
                    ProgramDay { date: r.day, arbitrage_eok, non_arbitrage_eok, total_eok }
                })
                .collect())
        })
    }

    fn intraday_investors(&self, market: Market, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<Option<InvestorNetEok>, SourceError>> {
        Box::pin(async move {
            let whole = self.whole_market_flow(market, now.kst_date(), priority).await?;
            if whole.is_none() {
                tracing::info!(?market, "키움이 종합 행을 주지 않아 이 분의 투자자 표본을 비웁니다(휴장일이거나 장이 시작되지 않았을 수 있습니다)");
            }
            Ok(whole.map(|r| InvestorNetEok { individual: r.individual_eok, foreign: r.foreign_eok, institution: r.institution_eok }))
        })
    }

    fn intraday_program(&self, market: Market, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<Option<IntradayProgram>, SourceError>> {
        Box::pin(async move {
            let body = self.ask(&ProgramTrendByMinute::new(listed(market), now.kst_date()), priority).await?;
            let latest = body.rows().rows.into_iter().max_by_key(|r| r.time.secs());
            if latest.is_none() {
                tracing::info!(?market, "키움이 프로그램 매매 행을 주지 않아 이 분의 표본을 비웁니다");
            }
            Ok(latest.map(|r| {
                let (arbitrage_eok, non_arbitrage_eok, total_eok) = program_eok(r.net);
                IntradayProgram { total_eok, split: Some(ProgramSplit { arbitrage_eok, non_arbitrage_eok }) }
            }))
        })
    }

    fn streaks(&self, side: StreakSide, market: Market, priority: Priority) -> BoxFuture<'_, Result<Vec<StreakRow>, SourceError>> {
        Box::pin(async move {
            let side = match side {
                StreakSide::Buying => crate::kiwoom::api::StreakSide::Buying,
                StreakSide::Selling => crate::kiwoom::api::StreakSide::Selling,
            };
            let body = self.ask(&InstitutionForeignStreak::new(side, listed(market)), priority).await?;
            Ok(body.rows().rows.into_iter().map(streak_row).collect())
        })
    }

    fn stock_investors(&self, code: StockCode, range: DayRange, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<api::DayHistory<api::InvestorNetSharesDay>, SourceError>> {
        Box::pin(async move { self.walk(&StockInvestorNetShares::new(code, now.kst_date()), code, range, priority).await })
    }

    fn foreign_holdings(&self, code: StockCode, range: DayRange, _now: KstTime, priority: Priority) -> BoxFuture<'_, Result<api::DayHistory<api::ForeignHoldingDay>, SourceError>> {
        Box::pin(async move { self.walk(&StockForeignHoldings::new(code), code, range, priority).await })
    }

    fn stock_program_daily(&self, code: StockCode, range: DayRange, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<api::DayHistory<api::StockProgramDailyDay>, SourceError>> {
        Box::pin(async move {
            let today = now.kst_date();
            if range.from() > today {
                return Ok(api::DayHistory {
                    symbol: api::SymbolCode(Symbol::Stock(code).as_wire()),
                    from: api::KstDate(range.from()),
                    to: api::KstDate(range.to()),
                    coverage: api::RangeCoverage::WholeRange,
                    days: Vec::new(),
                    source: crate::api::Broker::Kiwoom,
                    skipped_days: Vec::new(),
                    undated_rows: Vec::new(),
                    estimated_days: None,
                });
            }
            let anchor = range.to().min(today);
            self.walk(&StockProgramDaily::new(code, anchor), code, range, priority).await
        })
    }
}

impl KiwoomOverview {
    async fn walk<R>(&self, req: &R, code: StockCode, range: DayRange, priority: Priority) -> Result<api::DayHistory<<R::Response as DayPage>::Day>, SourceError>
    where
        R: MarketRequest,
        R::Response: DayPage,
    {
        let rest = self.rest()?;
        let (mut days, mut skipped, mut undated) = (Vec::new(), Vec::new(), Vec::new());
        let mut undated_pages = Vec::new();
        let mut seen_keys = HashSet::new();
        let mut reached: Option<KstDate> = None;
        let mut cont: Option<ContKey> = None;
        loop {
            let page = rest.call(req, cont.as_ref(), priority, MergeScope::default()).await?;
            if undated_pages.contains(&page.body) {
                tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), "키움 연속조회가 날짜 없는 페이지를 반복해 여기서 멈춥니다");
                break;
            }
            let rows = page.body.days();
            let oldest = rows.oldest();
            if rows.rows.is_empty() && rows.undated.is_empty() {
                if reached.is_none() && undated.is_empty() {
                    return Err(SourceError::UnknownSymbol);
                }
                break;
            }
            if oldest.is_none() {
                undated_pages.push(page.body);
            }
            for row in rows.undated {
                tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), dt = %row.dt, reason = %row.reason, "키움 행을 읽지 못해 그 행만 빼고 받습니다");
                undated.push(api::UndatedRow { dt: row.dt, reason: row.reason.to_string() });
            }
            if let Some(oldest) = oldest {
                if reached.is_some_and(|r| oldest >= r) {
                    tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), %oldest, "키움 연속조회가 더 오래된 날을 주지 않아 여기서 멈춥니다");
                    break;
                }
                reached = Some(oldest);
            }
            for (day, row) in rows.rows {
                match row {
                    Ok(row) if range.contains(day) => days.push((day, row)),
                    Ok(_) => {}
                    Err(e) => {
                        tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), dt = %day.yyyymmdd(), field = e.field, reason = %e.reason, "키움 행을 읽지 못해 그 행만 빼고 받습니다");
                        if range.contains(day) {
                            skipped.push(api::SkippedDay { day: api::KstDate(day), field: e.field.to_owned(), reason: e.reason.to_string() });
                        }
                    }
                }
            }
            if oldest.is_some_and(|d| d <= range.from()) {
                break;
            }
            match page.next {
                Some(next) if seen_keys.insert(next.clone()) => cont = Some(next),
                Some(_) => {
                    tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), "키움 연속조회가 next-key를 반복해 여기서 멈춥니다");
                    break;
                }
                None => break,
            }
        }
        days.sort_by_key(|(day, _)| *day);
        days.dedup_by_key(|(day, _)| *day);
        skipped.sort_by_key(|s| s.day);
        skipped.dedup_by_key(|s| s.day);
        skipped.retain(|s| days.binary_search_by_key(&s.day.0, |(day, _)| *day).is_err());
        let coverage = match reached {
            Some(first_day) if first_day <= range.from() => api::RangeCoverage::WholeRange,
            Some(first_day) => api::RangeCoverage::KiwoomStartsLater { first_day: api::KstDate(first_day) },
            None => api::RangeCoverage::NoReadableDates,
        };
        Ok(api::DayHistory {
            symbol: api::SymbolCode(Symbol::Stock(code).as_wire()),
            from: api::KstDate(range.from()),
            to: api::KstDate(range.to()),
            coverage,
            days: days.into_iter().map(|(_, day)| day).collect(),
            source: crate::api::Broker::Kiwoom,
            skipped_days: skipped,
            undated_rows: undated,
            estimated_days: None,
        })
    }
}
