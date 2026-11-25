use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{ApiErrorBody, Broker, KstDate, Market, SymbolCode, UnixSeconds};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum MarketOverviewPeriod {
    #[serde(rename = "5")]
    #[ts(rename = "5")]
    Days5,
    #[serde(rename = "20")]
    #[ts(rename = "20")]
    Days20,
    #[serde(rename = "60")]
    #[ts(rename = "60")]
    Days60,
}

impl MarketOverviewPeriod {
    pub const fn days(self) -> usize {
        match self {
            MarketOverviewPeriod::Days5 => 5,
            MarketOverviewPeriod::Days20 => 20,
            MarketOverviewPeriod::Days60 => 60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MarketOverviewPhase {
    Closed,
    PreMarket,
    Regular,
    AfterMarket,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewContext {
    pub market: Market,
    pub phase: MarketOverviewPhase,
    pub received_at: Option<UnixSeconds>,
    pub source: Broker,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum MarketOverviewPart<T> {
    Ok { value: T },
    Failed { error: ApiErrorBody },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewBreadth {
    pub rising: Option<u32>,
    pub flat: Option<u32>,
    pub falling: Option<u32>,
    pub upper_limit: Option<u32>,
    pub lower_limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewVolatility {
    pub level: f64,
    pub change_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewIndex {
    pub code: String,
    pub name: String,
    pub level: f64,
    pub change_rate: f64,
    pub breadth: MarketOverviewBreadth,
    pub trade_value_eok: f64,
    pub volatility: Option<MarketOverviewVolatility>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewIndexCard {
    pub context: MarketOverviewContext,
    pub index: MarketOverviewPart<MarketOverviewIndex>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewSector {
    pub code: String,
    pub name: String,
    pub level: f64,
    pub change_rate: f64,
    pub trade_value_eok: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewSectorFlow {
    pub code: String,
    pub name: String,
    pub whole_market: bool,
    pub individual_eok: i64,
    pub foreign_eok: i64,
    pub institution_eok: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewSectorsCard {
    pub context: MarketOverviewContext,
    pub sectors: MarketOverviewPart<Vec<MarketOverviewSector>>,
    pub flows: MarketOverviewPart<Vec<MarketOverviewSectorFlow>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewInvestorDay {
    pub date: KstDate,
    pub individual_eok: i64,
    pub foreign_eok: i64,
    pub institution_eok: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewProgramDay {
    pub date: KstDate,
    pub arbitrage_eok: f64,
    pub non_arbitrage_eok: f64,
    pub total_eok: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewFlowCard {
    pub context: MarketOverviewContext,
    pub period: MarketOverviewPeriod,
    pub investors: MarketOverviewPart<Vec<MarketOverviewInvestorDay>>,
    pub program: MarketOverviewPart<Vec<MarketOverviewProgramDay>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewIntradayPoint {
    pub at: UnixSeconds,
    pub individual_eok: Option<i64>,
    pub foreign_eok: Option<i64>,
    pub institution_eok: Option<i64>,
    pub program_eok: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewIntradayFlow {
    pub context: MarketOverviewContext,
    pub day: KstDate,
    pub points: Vec<MarketOverviewIntradayPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewTurnoverDay {
    pub date: KstDate,
    pub trade_value_eok: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewTurnoverCard {
    pub context: MarketOverviewContext,
    pub period: MarketOverviewPeriod,
    pub days: MarketOverviewPart<Vec<MarketOverviewTurnoverDay>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewStreak {
    pub code: SymbolCode,
    pub name: String,
    pub days: i64,
    pub net_eok: f64,
    pub net_shares: i64,
    pub period_change_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewStreakBoard {
    pub foreign: Vec<MarketOverviewStreak>,
    pub institution: Vec<MarketOverviewStreak>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewStreaksCard {
    pub context: MarketOverviewContext,
    pub buying: MarketOverviewPart<MarketOverviewStreakBoard>,
    pub selling: MarketOverviewPart<MarketOverviewStreakBoard>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MarketOverviewScope {
    All,
    Kospi,
    Kosdaq,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewHistogramBucket {
    pub label: String,
    pub count: u32,
    pub share_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewVenueShare {
    pub krx_trade_value_eok: f64,
    pub nxt_trade_value_eok: f64,
    pub krx_ratio_pct: f64,
    pub nxt_ratio_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewAttributionRow {
    pub code: SymbolCode,
    pub name: String,
    pub market: Market,
    pub change_rate: f64,
    pub points: f64,
    pub cap_delta_eok: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewAttribution {
    pub market: Market,
    pub index_change_points: f64,
    pub top_positive: Vec<MarketOverviewAttributionRow>,
    pub top_negative: Vec<MarketOverviewAttributionRow>,
    pub top_two_concentration_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewMaHistoryPoint {
    pub date: KstDate,
    pub above_20_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewMaThrust {
    pub as_of: Option<KstDate>,
    pub total_stocks: u32,
    pub above_5_pct: f64,
    pub above_20_pct: f64,
    pub above_60_pct: f64,
    pub above_200_pct: f64,
    pub history_20d: Vec<MarketOverviewMaHistoryPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketOverviewDerivedCard {
    pub scope: MarketOverviewScope,
    pub phase: MarketOverviewPhase,
    pub received_at: Option<UnixSeconds>,
    pub histogram: MarketOverviewPart<Vec<MarketOverviewHistogramBucket>>,
    pub venue_share: MarketOverviewPart<MarketOverviewVenueShare>,
    pub attribution: MarketOverviewPart<MarketOverviewAttribution>,
    pub ma_thrust: MarketOverviewPart<MarketOverviewMaThrust>,
}
