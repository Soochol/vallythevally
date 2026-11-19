use std::collections::HashMap;

use domain::{StockCode, Venue};

use super::cache::{Demand, WalkError};
use crate::api::{self, Percent, RankingFigures, Shares, Won};
use crate::kiwoom::api::{
    BalanceOrder, CreditRatioRanking, ExpectedExecutionRanking, ExpectedOrder, ForeignStreakRanking, InvestorGroup, InvestorNetRanking, InvestorUnit, LimitMoves, ListedMarket, ManagedIssues,
    MarketRequest, MinimumTradeValue, MostViewedRanking, NetSide, OrderBookBalanceRanking, PriceChangeRanking, PriceDirection, ProgramNetRanking, ProgramSide, RankMarket, StockQuotes, StreakSide,
    SurgeBaseline, SurgeOrder, TradeValueRanking, TradingSession, TradingVolumeRanking, ViewWindow, VolumeOrder, VolumeSurgeRanking,
};
use crate::kiwoom::rest::{ContKey, KiwoomRest};
use crate::kiwoom::wire::{CreditRatioColumns, ExpectedExecutionColumns, ForeignStreakColumns, InvestorNetColumns, MostViewedColumns, OrderBookBalanceColumns, ParsedRows, PriceChangeColumns, ProgramNetColumns, RankRow, TradeValueColumns, TradingVolumeColumns, VolumeSurgeColumns, parse_quotes};

#[derive(Debug, Clone, PartialEq)]
pub struct RawRow {
    pub code: StockCode,
    pub name: String,
    pub price: Option<Won>,
    pub change_rate: Option<Percent>,
    pub figures: RankingFigures,
}

pub struct FetchedPage {
    pub rows: Vec<RawRow>,
    pub next: Option<ContKey>,
    pub continues_without_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QueryKey {
    api_id: &'static str,
    body: String,
}

pub enum Query {
    TradeAmount(TradeValueRanking),
    TradeVolume(TradingVolumeRanking),
    Turnover(TradingVolumeRanking),
    VolumeSurge(VolumeSurgeRanking),
    Movers(PriceChangeRanking),
    Expected(ExpectedExecutionRanking),
    InvestorNet(InvestorNetRanking, InvestorUnit),
    ForeignStreak(ForeignStreakRanking),
    Program(ProgramNetRanking),
    BidAskBalance(OrderBookBalanceRanking),
    CreditRatio(CreditRatioRanking),
    MostViewed(MostViewedRanking),
}

pub fn plan(ranking: api::Ranking) -> (Query, api::Excludes) {
    use api::Ranking as R;
    match ranking {
        R::TradeAmount { market, venue, excludes, exclude_managed } => (Query::TradeAmount(TradeValueRanking::new(market.into(), venue.into(), managed(exclude_managed))), excludes),
        R::TradeVolume { market, venue, session, excludes, exclude_managed } => {
            (Query::TradeVolume(TradingVolumeRanking::new(VolumeOrder::Volume, market.into(), venue.into(), trading_session(session), managed(exclude_managed))), excludes)
        }
        R::Turnover { market, venue, excludes, exclude_managed } => {
            (Query::Turnover(TradingVolumeRanking::new(VolumeOrder::Turnover, market.into(), venue.into(), TradingSession::All, managed(exclude_managed))), excludes)
        }
        R::VolumeSurge { market, venue, baseline, sort, excludes, exclude_managed } => {
            (Query::VolumeSurge(VolumeSurgeRanking::new(market.into(), venue.into(), surge_baseline(baseline), surge_order(sort), managed(exclude_managed))), excludes)
        }
        R::Gainers { market, venue, include_limit, min_trade_amount, excludes, exclude_managed } => (
            Query::Movers(PriceChangeRanking::new(PriceDirection::Rising, market.into(), venue.into(), limit_moves(include_limit), minimum_trade_value(min_trade_amount), managed(exclude_managed))),
            excludes,
        ),
        R::Losers { market, venue, include_limit, min_trade_amount, excludes, exclude_managed } => (
            Query::Movers(PriceChangeRanking::new(PriceDirection::Falling, market.into(), venue.into(), limit_moves(include_limit), minimum_trade_value(min_trade_amount), managed(exclude_managed))),
            excludes,
        ),
        R::Expected { market, venue, sort, excludes, exclude_managed } => {
            let order = match sort {
                api::ExpectedSort::Gainers => ExpectedOrder::Rising,
                api::ExpectedSort::Losers => ExpectedOrder::Falling,
            };
            (Query::Expected(ExpectedExecutionRanking::new(order, market.into(), venue.into(), managed(exclude_managed))), excludes)
        }
        R::InvestorNetBuy { market, investor, direction, unit, excludes } => {
            let unit = match unit {
                api::TradeUnit::Amount => InvestorUnit::Amount,
                api::TradeUnit::Quantity => InvestorUnit::Quantity,
            };
            let side = match direction {
                api::NetDirection::NetBuy => NetSide::Buying,
                api::NetDirection::NetSell => NetSide::Selling,
            };
            (Query::InvestorNet(InvestorNetRanking::new(investor_group(investor), side, unit, market.into()), unit), excludes)
        }
        R::ForeignStreak { market, venue, direction, excludes } => {
            let side = match direction {
                api::NetDirection::NetBuy => StreakSide::Buying,
                api::NetDirection::NetSell => StreakSide::Selling,
            };
            (Query::ForeignStreak(ForeignStreakRanking::new(side, market.into(), venue.into())), excludes)
        }
        R::Program { market, venue, direction, excludes } => {
            let side = match direction {
                api::NetDirection::NetBuy => ProgramSide::NetBuying,
                api::NetDirection::NetSell => ProgramSide::NetSelling,
            };
            (Query::Program(ProgramNetRanking::new(side, listed_market(market), venue.into())), excludes)
        }
        R::BidAskBalance { market, venue, sort, excludes, exclude_managed } => {
            let order = match sort {
                api::BalanceSort::NetBuyRemaining => BalanceOrder::NetBuyBalance,
                api::BalanceSort::NetSellRemaining => BalanceOrder::NetSellBalance,
                api::BalanceSort::BuyRatio => BalanceOrder::BuyRatio,
                api::BalanceSort::SellRatio => BalanceOrder::SellRatio,
            };
            (Query::BidAskBalance(OrderBookBalanceRanking::new(order, listed_market(market), venue.into(), managed(exclude_managed))), excludes)
        }
        R::CreditRatio { market, venue, excludes, exclude_managed } => (Query::CreditRatio(CreditRatioRanking::new(market.into(), venue.into(), managed(exclude_managed))), excludes),
        R::MostViewed { span, excludes } => {
            let window = match span {
                api::ViewSpan::Seconds30 => ViewWindow::ThirtySeconds,
                api::ViewSpan::Minute1 => ViewWindow::OneMinute,
                api::ViewSpan::Minutes10 => ViewWindow::TenMinutes,
                api::ViewSpan::Hour1 => ViewWindow::OneHour,
                api::ViewSpan::Today => ViewWindow::Today,
            };
            (Query::MostViewed(MostViewedRanking::new(window)), excludes)
        }
    }
}

impl From<api::RankingMarket> for RankMarket {
    fn from(market: api::RankingMarket) -> Self {
        match market {
            api::RankingMarket::All => RankMarket::All,
            api::RankingMarket::Kospi => RankMarket::Kospi,
            api::RankingMarket::Kosdaq => RankMarket::Kosdaq,
        }
    }
}

fn listed_market(market: api::Market) -> ListedMarket {
    match market {
        api::Market::Kospi => ListedMarket::Kospi,
        api::Market::Kosdaq => ListedMarket::Kosdaq,
    }
}

fn managed(exclude: bool) -> ManagedIssues {
    if exclude { ManagedIssues::Exclude } else { ManagedIssues::Include }
}

fn limit_moves(include: bool) -> LimitMoves {
    if include { LimitMoves::Include } else { LimitMoves::Exclude }
}

fn trading_session(session: api::TradingSession) -> TradingSession {
    match session {
        api::TradingSession::All => TradingSession::All,
        api::TradingSession::Regular => TradingSession::Regular,
        api::TradingSession::PreMarket => TradingSession::PreMarket,
        api::TradingSession::AfterHours => TradingSession::AfterMarket,
    }
}

fn surge_baseline(baseline: api::SurgeBaseline) -> SurgeBaseline {
    match baseline {
        api::SurgeBaseline::PreviousDay => SurgeBaseline::PreviousDay,
        api::SurgeBaseline::Minutes1 => SurgeBaseline::OneMinute,
        api::SurgeBaseline::Minutes5 => SurgeBaseline::FiveMinutes,
        api::SurgeBaseline::Minutes10 => SurgeBaseline::TenMinutes,
    }
}

fn surge_order(sort: api::SurgeSort) -> SurgeOrder {
    match sort {
        api::SurgeSort::SurgeVolume => SurgeOrder::Volume,
        api::SurgeSort::SurgeRate => SurgeOrder::Rate,
        api::SurgeSort::DropRate => SurgeOrder::DropRate,
    }
}

fn minimum_trade_value(minimum: api::MinTradeAmount) -> MinimumTradeValue {
    match minimum {
        api::MinTradeAmount::Any => MinimumTradeValue::Any,
        api::MinTradeAmount::AtLeast100Million => MinimumTradeValue::OneHundredMillion,
        api::MinTradeAmount::AtLeast1Billion => MinimumTradeValue::OneBillion,
        api::MinTradeAmount::AtLeast10Billion => MinimumTradeValue::TenBillion,
    }
}

fn investor_group(investor: api::RankingInvestor) -> InvestorGroup {
    match investor {
        api::RankingInvestor::Foreign => InvestorGroup::Foreigner,
        api::RankingInvestor::ForeignFirm => InvestorGroup::ForeignFirm,
        api::RankingInvestor::FinancialInvestment => InvestorGroup::FinancialInvestment,
        api::RankingInvestor::InvestmentTrust => InvestorGroup::InvestmentTrust,
        api::RankingInvestor::OtherFinancial => InvestorGroup::OtherFinance,
        api::RankingInvestor::Bank => InvestorGroup::Bank,
        api::RankingInvestor::Insurance => InvestorGroup::Insurance,
        api::RankingInvestor::PensionFund => InvestorGroup::Pension,
        api::RankingInvestor::State => InvestorGroup::State,
        api::RankingInvestor::OtherCorporation => InvestorGroup::OtherCorporation,
        api::RankingInvestor::Institution => InvestorGroup::Institution,
    }
}

impl Query {
    pub fn key(&self) -> QueryKey {
        fn key_of<R: MarketRequest>(request: &R) -> QueryKey {
            QueryKey { api_id: R::API_ID.as_str(), body: serde_json::to_string(request).expect("요청 타입은 언제나 직렬화된다") }
        }
        match self {
            Query::TradeAmount(r) => key_of(r),
            Query::TradeVolume(r) | Query::Turnover(r) => key_of(r),
            Query::VolumeSurge(r) => key_of(r),
            Query::Movers(r) => key_of(r),
            Query::Expected(r) => key_of(r),
            Query::InvestorNet(r, _) => key_of(r),
            Query::ForeignStreak(r) => key_of(r),
            Query::Program(r) => key_of(r),
            Query::BidAskBalance(r) => key_of(r),
            Query::CreditRatio(r) => key_of(r),
            Query::MostViewed(r) => key_of(r),
        }
    }

    pub async fn fetch(&self, rest: &KiwoomRest, cont: Option<&ContKey>, demand: &mut Demand) -> Result<FetchedPage, WalkError> {
        match self {
            Query::TradeAmount(r) => page(rest, r, cont, demand, |body| rows(body.rows(), trade_amount)).await,
            Query::TradeVolume(r) => page(rest, r, cont, demand, |body| rows(body.rows(), trade_volume)).await,
            Query::Turnover(r) => page(rest, r, cont, demand, |body| rows(body.rows(), turnover)).await,
            Query::VolumeSurge(r) => page(rest, r, cont, demand, |body| rows(body.rows(), volume_surge)).await,
            Query::Movers(r) => page(rest, r, cont, demand, |body| rows(body.rows(), movers)).await,
            Query::Expected(r) => page(rest, r, cont, demand, |body| rows(body.rows(), expected)).await,
            Query::InvestorNet(r, unit) => {
                let mut fetched = page(rest, r, cont, demand, |body| rows(body.rows(*unit), |c| investor_net(*unit, c))).await?;
                fill_quotes(rest, &mut fetched.rows, demand).await;
                Ok(fetched)
            }
            Query::ForeignStreak(r) => page(rest, r, cont, demand, |body| rows(body.rows(), foreign_streak)).await,
            Query::Program(r) => page(rest, r, cont, demand, |body| rows(body.rows(), program)).await,
            Query::BidAskBalance(r) => page(rest, r, cont, demand, |body| rows(body.rows(), bid_ask_balance)).await,
            Query::CreditRatio(r) => page(rest, r, cont, demand, |body| rows(body.rows(), credit_ratio)).await,
            Query::MostViewed(r) => page(rest, r, cont, demand, |body| rows(body.rows(), most_viewed)).await,
        }
    }
}

async fn page<R: MarketRequest>(rest: &KiwoomRest, request: &R, cont: Option<&ContKey>, demand: &mut Demand, read: impl FnOnce(R::Response) -> ReadRows) -> Result<FetchedPage, WalkError> {
    let page = demand.call(rest, request, cont).await?;
    let read = read(page.body);
    if read.all_unreadable {
        return Err(WalkError::PageUnreadable);
    }
    Ok(FetchedPage { rows: read.rows, next: page.next, continues_without_key: page.continues_without_key })
}

struct ReadRows {
    rows: Vec<RawRow>,
    all_unreadable: bool,
}

struct Fields {
    price: Option<u64>,
    change_rate: Option<f64>,
    figures: Option<RankingFigures>,
}

fn rows<C>(parsed: ParsedRows<RankRow<C>>, read: impl Fn(&C) -> Fields) -> ReadRows {
    let received = parsed.rows.len() + parsed.skipped as usize;
    let rows: Vec<RawRow> = parsed
        .rows
        .into_iter()
        .filter_map(|row| {
            let Fields { price, change_rate, figures } = read(&row.columns);
            let Some(figures) = figures else {
                tracing::warn!(code = row.code.as_str(), "순위 행의 값이 너무 커서 그 행만 빼고 받습니다");
                return None;
            };
            Some(RawRow { code: row.code, name: row.name, price: price.and_then(won), change_rate: change_rate.map(Percent), figures })
        })
        .collect();
    ReadRows { all_unreadable: received > 0 && rows.is_empty(), rows }
}

fn won(value: u64) -> Option<Won> {
    i64::try_from(value).ok().map(Won)
}

fn shares(value: u64) -> Option<Shares> {
    i64::try_from(value).ok().map(Shares)
}

fn places_gained(now: Option<u32>, before: Option<u32>) -> Option<i32> {
    i32::try_from(i64::from(before?) - i64::from(now?)).ok()
}

fn trade_amount(c: &TradeValueColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: Some(c.change_rate),
        figures: shares(c.volume).map(|volume| RankingFigures::TradeAmount { trade_amount: Won(c.trade_value_won), volume, places_gained: places_gained(c.rank, c.previous_rank) }),
    }
}

fn trade_volume(c: &TradingVolumeColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: Some(c.change_rate),
        figures: shares(c.volume).map(|volume| RankingFigures::TradeVolume { volume, previous_day_volume_rate: Some(Percent(c.previous_day_ratio)) }),
    }
}

fn turnover(c: &TradingVolumeColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: Some(c.change_rate),
        figures: shares(c.volume).map(|volume| RankingFigures::Turnover { turnover_rate: Percent(c.turnover_rate), volume }),
    }
}

fn volume_surge(c: &VolumeSurgeColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: Some(c.change_rate),
        figures: shares(c.volume).map(|volume| RankingFigures::VolumeSurge { surge_rate: Percent(c.surge_rate), surge_volume: Shares(c.surge_volume), volume }),
    }
}

fn movers(c: &PriceChangeColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: Some(c.change_rate),
        figures: shares(c.volume).map(|volume| RankingFigures::Movers { price_change: Won(c.change_won), volume }),
    }
}

fn expected(c: &ExpectedExecutionColumns) -> Fields {
    Fields {
        price: None,
        change_rate: None,
        figures: won(c.expected_price)
            .zip(shares(c.expected_volume))
            .map(|(expected_price, expected_volume)| RankingFigures::Expected { expected_price, expected_change_rate: Percent(c.expected_change_rate), expected_volume }),
    }
}

fn investor_net(unit: InvestorUnit, c: &InvestorNetColumns) -> Fields {
    let figures = match unit {
        InvestorUnit::Amount => RankingFigures::NetAmounts { net: Won(c.net), buy: Won(c.bought), sell: Won(c.sold) },
        InvestorUnit::Quantity => RankingFigures::NetQuantities { net: Shares(c.net), buy: Shares(c.bought), sell: Shares(c.sold) },
    };
    Fields { price: None, change_rate: None, figures: Some(figures) }
}

fn foreign_streak(c: &ForeignStreakColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: None,
        figures: Some(RankingFigures::ForeignStreak {
            net_d1: Shares(c.day_before_1),
            net_d2: Shares(c.day_before_2),
            net_d3: Shares(c.day_before_3),
            net_total: Shares(c.total),
            limit_exhaustion_rate: Percent(c.limit_exhaustion_rate),
        }),
    }
}

fn program(c: &ProgramNetColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: Some(c.change_rate),
        figures: Some(RankingFigures::NetAmounts { net: Won(c.net_won), buy: Won(c.bought_won), sell: Won(c.sold_won) }),
    }
}

fn bid_ask_balance(c: &OrderBookBalanceColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: None,
        figures: shares(c.total_sell).zip(shares(c.total_buy)).map(|(total_sell_remaining, total_buy_remaining)| RankingFigures::BidAskBalance {
            total_sell_remaining,
            total_buy_remaining,
            net_buy_remaining: Shares(c.net_buy),
            buy_ratio: Percent(c.buy_ratio),
        }),
    }
}

fn credit_ratio(c: &CreditRatioColumns) -> Fields {
    Fields {
        price: Some(c.price),
        change_rate: Some(c.change_rate),
        figures: shares(c.volume).map(|volume| RankingFigures::CreditRatio { credit_ratio: Percent(c.credit_ratio), volume }),
    }
}

fn most_viewed(c: &MostViewedColumns) -> Fields {
    Fields {
        price: None,
        change_rate: None,
        figures: won(c.base_price).map(|reference_price| RankingFigures::MostViewed {
            reference_price,
            change_from_reference_rate: Percent(c.base_change_rate),
            places_gained: Some(c.rank_change),
        }),
    }
}

async fn fill_quotes(rest: &KiwoomRest, rows: &mut [RawRow], demand: &mut Demand) {
    let mut codes: Vec<StockCode> = Vec::new();
    for row in rows.iter() {
        if codes.len() < StockQuotes::MAX && !codes.contains(&row.code) {
            codes.push(row.code);
        }
    }
    let Some(request) = StockQuotes::new(&codes, Venue::Krx) else { return };
    let page = match demand.call(rest, &request, None).await {
        Ok(page) => page,
        Err(reason) => {
            tracing::warn!(%reason, "투자자별 순매수의 현재가·등락률을 받지 못해 비워 둡니다");
            return;
        }
    };
    let quotes: HashMap<StockCode, (Won, Percent)> = parse_quotes(page.body)
        .into_iter()
        .filter(|quote| quote.venue == Venue::Krx && quote.price_centi > 0 && quote.base_centi > 0)
        .filter_map(|quote| {
            let price = i64::try_from(quote.price_centi / 100).ok()?;
            let rate = (quote.price_centi as f64 - quote.base_centi as f64) / quote.base_centi as f64 * 100.0;
            Some((quote.code, (Won(price), Percent(rate))))
        })
        .collect();
    for row in rows {
        if let Some((price, rate)) = quotes.get(&row.code) {
            row.price = Some(*price);
            row.change_rate = Some(*rate);
        }
    }
}
