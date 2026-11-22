use domain::{KstDate, KstTime, StockCode};
use futures::future::BoxFuture;

use super::{Priority, SourceError, SourceFailure};
use crate::api::{self, ApiErrorCode, ApiErrorReason, Market};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum OverviewFeature {
    Index,
    Sectors,
    Flow,
    IntradayFlow,
    Turnover,
    Streaks,
    StockInvestors,
    ForeignHoldings,
}

impl OverviewFeature {
    pub const ALL: [OverviewFeature; 8] = [
        OverviewFeature::Index,
        OverviewFeature::Sectors,
        OverviewFeature::Flow,
        OverviewFeature::IntradayFlow,
        OverviewFeature::Turnover,
        OverviewFeature::Streaks,
        OverviewFeature::StockInvestors,
        OverviewFeature::ForeignHoldings,
    ];

    pub fn label(self) -> &'static str {
        match self {
            OverviewFeature::Index => "시장 개요 지수·등락 종목 수",
            OverviewFeature::Sectors => "시장 개요 업종 지도",
            OverviewFeature::Flow => "시장 개요 기간 수급",
            OverviewFeature::IntradayFlow => "시장 개요 오늘 누적선",
            OverviewFeature::Turnover => "시장 개요 거래대금 추이",
            OverviewFeature::Streaks => "시장 개요 연속 매매",
            OverviewFeature::StockInvestors => "종목 투자자 일별 순매수",
            OverviewFeature::ForeignHoldings => "종목 외국인 보유",
        }
    }

    const fn bit(self) -> u8 {
        1 << self as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OverviewFeatures(u8);

impl OverviewFeatures {
    pub const NONE: OverviewFeatures = OverviewFeatures(0);

    pub fn of(features: impl IntoIterator<Item = OverviewFeature>) -> OverviewFeatures {
        OverviewFeatures(features.into_iter().fold(0, |bits, feature| bits | feature.bit()))
    }

    pub fn contains(self, feature: OverviewFeature) -> bool {
        self.0 & feature.bit() != 0
    }

    pub fn iter(self) -> impl Iterator<Item = OverviewFeature> {
        OverviewFeature::ALL.into_iter().filter(move |f| self.contains(*f))
    }
}

pub fn unsupported(feature: OverviewFeature) -> SourceError {
    SourceError::Failed(SourceFailure {
        code: ApiErrorCode::BadRequest,
        reason: ApiErrorReason::UnsupportedBySource,
        message: format!("지금 쓰는 시세 공급원은 {}을(를) 받을 수 없습니다", feature.label()),
        retry_at: None,
        manual_action_required: false,
    })
}

pub fn protocol(message: impl Into<String>) -> SourceError {
    let message = message.into();
    tracing::error!(reason = %message, "시세 공급원 응답이 약속과 다릅니다");
    SourceError::Failed(SourceFailure { code: ApiErrorCode::KiwoomUnavailable, reason: ApiErrorReason::Protocol, message, retry_at: None, manual_action_required: false })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayRange {
    from: KstDate,
    to: KstDate,
}

impl DayRange {
    pub fn new(from: KstDate, to: KstDate) -> Option<Self> {
        (from <= to).then_some(DayRange { from, to })
    }

    pub fn from(self) -> KstDate {
        self.from
    }

    pub fn to(self) -> KstDate {
        self.to
    }

    pub fn contains(self, day: KstDate) -> bool {
        (self.from..=self.to).contains(&day)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndexLevel {
    pub code: String,
    pub name: String,
    pub level: f64,
    pub change_rate: f64,
    pub trade_value_eok: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexBreadth {
    pub rising: u32,
    pub flat: u32,
    pub falling: u32,
    pub upper_limit: u32,
    pub lower_limit: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VolatilityLevel {
    pub level: f64,
    pub change_rate: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarketIndexSnapshot {
    pub whole: IndexLevel,
    pub breadth: IndexBreadth,
    pub volatility: Option<VolatilityLevel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvestorNetEok {
    pub individual: i64,
    pub foreign: i64,
    pub institution: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectorFlow {
    pub code: String,
    pub name: String,
    pub whole_market: bool,
    pub net: InvestorNetEok,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TradingDay {
    pub date: KstDate,
    pub trade_value_eok: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgramDay {
    pub date: KstDate,
    pub arbitrage_eok: f64,
    pub non_arbitrage_eok: f64,
    pub total_eok: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgramSplit {
    pub arbitrage_eok: f64,
    pub non_arbitrage_eok: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IntradayProgram {
    pub total_eok: f64,
    pub split: Option<ProgramSplit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreakSide {
    Buying,
    Selling,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreakColumn {
    pub days: i64,
    pub net_eok: f64,
    pub net_shares: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreakRow {
    pub code: StockCode,
    pub name: String,
    pub foreign: StreakColumn,
    pub institution: StreakColumn,
    pub period_change_rate: f64,
}

pub trait OverviewSource: Send + Sync + 'static {
    fn broker(&self) -> api::Broker;

    fn features(&self) -> OverviewFeatures;

    fn is_open(&self) -> bool;

    fn index(&self, market: Market, priority: Priority) -> BoxFuture<'_, Result<MarketIndexSnapshot, SourceError>>;
    fn sector_levels(&self, market: Market, priority: Priority) -> BoxFuture<'_, Result<Vec<IndexLevel>, SourceError>>;
    fn sector_flows(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<SectorFlow>, SourceError>>;
    fn trading_days(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<TradingDay>, SourceError>>;
    fn investor_day(&self, market: Market, day: KstDate, priority: Priority) -> BoxFuture<'_, Result<InvestorNetEok, SourceError>>;
    fn program_days(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<ProgramDay>, SourceError>>;
    fn intraday_investors(&self, market: Market, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<Option<InvestorNetEok>, SourceError>>;
    fn intraday_program(&self, market: Market, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<Option<IntradayProgram>, SourceError>>;
    fn streaks(&self, side: StreakSide, market: Market, priority: Priority) -> BoxFuture<'_, Result<Vec<StreakRow>, SourceError>>;

    fn stock_investors(&self, code: StockCode, range: DayRange, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<api::DayHistory<api::InvestorNetSharesDay>, SourceError>>;
    fn foreign_holdings(&self, code: StockCode, range: DayRange, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<api::DayHistory<api::ForeignHoldingDay>, SourceError>>;
}
