use std::sync::Arc;

use domain::StockCode;
use futures::future::BoxFuture;
use serde::Deserialize;

use super::api::KisApiId;
use super::error::Category;
use super::market_rest::whole;
use super::rest::{KisError, KisPage, KisRequest, KisRest, Priority as KisPriority};
use crate::api::{self, ApiErrorCode, ApiErrorReason, Percent, Ranking, RankingFigures, Shares, Venue, Won};
use crate::clock::Clock;
use crate::market_source::rankings::{Demand, RankedRow, RankingChoices, RankingError, RankingFetch, RankingKind, RankingSource, Unsupported};
use crate::market_source::{Cursor, Priority, SourceError, SourceFailure};

const KRX: &str = "J";
const NXT: &str = "NX";
const COMBINED: &str = "UN";
const WHOLE_MARKET_CODE: &str = "0000";
const KOSPI_CODE: &str = "0001";
const KOSDAQ_CODE: &str = "1001";
const NO_CONDITION: &str = "";
const ALL_TARGETS: &str = "0";
const VOLUME_RANK_SCREEN: &str = "20171";
const FLUCTUATION_SCREEN: &str = "20170";
const EXPECTED_SCREEN: &str = "20182";
const INVESTOR_SCREEN: &str = "16449";
const INVESTOR_MARKET: &str = "V";
const QUOTE_BALANCE_SCREEN: &str = "20172";
const CREDIT_SCREEN: &str = "11701";
const CREDIT_DAYS: &str = "2";
const OVERTIME_SCREEN: &str = "20235";
const ALL_SHARE_CLASSES: &str = "0";
const NO_EXCLUSIONS: &str = "0000000000";
const EXCLUDE_MANAGED: &str = "0100000000";
const NO_EXCLUSIONS_QUOTE_BALANCE: &str = "0";
const BY_AVERAGE_VOLUME: &str = "0";
const BY_VOLUME_INCREASE: &str = "1";
const BY_TURNOVER: &str = "2";
const BY_TRADE_AMOUNT: &str = "3";
const RISING_FIRST: &str = "0";
const FALLING_FIRST: &str = "1";
const EXPECTED_RISING_RATE: &str = "0";
const EXPECTED_FALLING_RATE: &str = "3";
const EXPECTED_BEFORE_OPEN: &str = "0";
const EXPECTED_AT_CLOSE: &str = "1";
const EXPECTED_AT_CLOSE_FROM_SECS: u32 = 12 * 3600;
const BY_QUANTITY: &str = "0";
const BY_AMOUNT: &str = "1";
const NET_BUYING_FIRST: &str = "0";
const NET_SELLING_FIRST: &str = "1";
const FOREIGN_INVESTORS: &str = "1";
const INSTITUTIONS: &str = "2";
const OTHER_INVESTORS: &str = "3";
const OVERTIME_BY_VOLUME: &str = "2";
const CREDIT_LOAN_RATIO_FIRST: &str = "0";
const LIMIT_UP_SIGN: &str = "1";
const LIMIT_DOWN_SIGN: &str = "4";
const FALLING_SIGNS: [&str; 2] = [LIMIT_DOWN_SIGN, "5"];
const RISING_SIGNS: [&str; 3] = [LIMIT_UP_SIGN, "2", "3"];
const WON_PER_MILLION: i64 = 1_000_000;

const SUPPORTED_KINDS: [RankingKind; 11] = [
    RankingKind::TradeAmount,
    RankingKind::TradeVolume,
    RankingKind::Turnover,
    RankingKind::VolumeSurge,
    RankingKind::Gainers,
    RankingKind::Losers,
    RankingKind::Expected,
    RankingKind::InvestorNetBuy,
    RankingKind::BidAskBalance,
    RankingKind::CreditRatio,
    RankingKind::MostViewed,
];

const SUPPORTED_INVESTORS: [api::RankingInvestor; 3] = [api::RankingInvestor::Foreign, api::RankingInvestor::Institution, api::RankingInvestor::OtherCorporation];

pub struct KisRankings {
    rest: KisRest,
    clock: Clock,
}

impl KisRankings {
    pub fn new(rest: KisRest, clock: Clock) -> Self {
        KisRankings { rest, clock }
    }
}

impl From<KisRankings> for Arc<dyn RankingSource> {
    fn from(rankings: KisRankings) -> Self {
        Arc::new(rankings)
    }
}

impl From<Priority> for KisPriority {
    fn from(priority: Priority) -> Self {
        match priority {
            Priority::Order => KisPriority::Order,
            Priority::Screen => KisPriority::Screen,
            Priority::ScreenBulk => KisPriority::ScreenBulk,
            Priority::Recovery => KisPriority::Recovery,
            Priority::Background => KisPriority::Background,
        }
    }
}

impl RankingSource for KisRankings {
    fn name(&self) -> &'static str {
        "kis"
    }

    fn kinds(&self) -> &'static [RankingKind] {
        &SUPPORTED_KINDS
    }

    fn choices(&self, kind: RankingKind) -> RankingChoices {
        let three_venues = vec![Venue::Combined, Venue::Krx, Venue::Nxt];
        let two_venues = vec![Venue::Combined, Venue::Krx];
        match kind {
            RankingKind::TradeAmount | RankingKind::Turnover | RankingKind::BidAskBalance => RankingChoices { venues: three_venues, excludes_managed: true, ..RankingChoices::default() },
            RankingKind::TradeVolume => RankingChoices {
                venues: three_venues,
                sessions: vec![api::TradingSession::All, api::TradingSession::Regular, api::TradingSession::AfterHours],
                excludes_managed: true,
                ..RankingChoices::default()
            },
            RankingKind::VolumeSurge => RankingChoices {
                venues: three_venues,
                baselines: vec![api::SurgeBaseline::PreviousDay],
                surge_sorts: vec![api::SurgeSort::SurgeRate],
                excludes_managed: true,
                ..RankingChoices::default()
            },
            RankingKind::Gainers | RankingKind::Losers => RankingChoices {
                venues: three_venues,
                min_trade_amounts: vec![api::MinTradeAmount::Any, api::MinTradeAmount::AtLeast100Million, api::MinTradeAmount::AtLeast1Billion, api::MinTradeAmount::AtLeast10Billion],
                excludes_managed: true,
                ..RankingChoices::default()
            },
            RankingKind::Expected | RankingKind::CreditRatio => RankingChoices { venues: two_venues, ..RankingChoices::default() },
            RankingKind::InvestorNetBuy => RankingChoices { investors: SUPPORTED_INVESTORS.to_vec(), ..RankingChoices::default() },
            RankingKind::MostViewed => RankingChoices { spans: vec![api::ViewSpan::Today], ..RankingChoices::default() },
            RankingKind::ForeignStreak | RankingKind::Program => RankingChoices::default(),
        }
    }

    fn refuses_combination(&self, ranking: &Ranking) -> Option<Unsupported> {
        self.plan(ranking).err()
    }

    fn page<'a>(&'a self, ranking: &'a Ranking, cursor: Option<&'a Cursor>, demand: &'a mut Demand) -> BoxFuture<'a, Result<RankingFetch, RankingError>> {
        Box::pin(async move {
            self.check(ranking)?;
            if cursor.is_some() {
                return Err(RankingError::Source(SourceError::Malformed("한투 순위는 이어 받는 쪽이 없습니다".into())));
            }
            let plan = self.plan(ranking)?;
            let page = demand.run(|priority| self.rest.call(KisRequest::new(plan.api, plan.query.clone(), priority.into()))).await.map_err(|e| RankingError::Source(source_error(&e)))?;
            let rows = plan.read.rows(plan.api, &page).map_err(RankingError::Source)?;
            Ok(RankingFetch { rows, next: None, continues_without_cursor: false })
        })
    }
}

struct Plan {
    api: KisApiId,
    query: Vec<(&'static str, String)>,
    read: Read,
}

#[derive(Debug, Clone, Copy)]
enum Read {
    Volume(VolumeColumns),
    Movers { direction: Direction, include_limit: bool },
    Expected,
    Investor { investor: api::RankingInvestor, unit: api::TradeUnit },
    Balance,
    Credit,
    MostViewed,
    Overtime,
}

#[derive(Debug, Clone, Copy)]
enum VolumeColumns {
    TradeAmount,
    TradeVolume,
    Turnover,
    Surge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Rising,
    Falling,
}

fn query<const N: usize>(fields: [(&'static str, &str); N]) -> Vec<(&'static str, String)> {
    fields.into_iter().map(|(name, value)| (name, value.to_owned())).collect()
}

fn market_code(market: api::RankingMarket) -> &'static str {
    match market {
        api::RankingMarket::All => WHOLE_MARKET_CODE,
        api::RankingMarket::Kospi => KOSPI_CODE,
        api::RankingMarket::Kosdaq => KOSDAQ_CODE,
    }
}

fn listed_market_code(market: api::Market) -> &'static str {
    match market {
        api::Market::Kospi => KOSPI_CODE,
        api::Market::Kosdaq => KOSDAQ_CODE,
    }
}

fn division_with_nxt(venue: Venue) -> &'static str {
    match venue {
        Venue::Combined => COMBINED,
        Venue::Krx => KRX,
        Venue::Nxt => NXT,
    }
}

fn krx_or_nxt(venue: Venue) -> &'static str {
    match venue {
        Venue::Combined | Venue::Krx => KRX,
        Venue::Nxt => NXT,
    }
}

fn krx_only(kind: RankingKind, venue: Venue) -> Result<&'static str, Unsupported> {
    match venue {
        Venue::Combined | Venue::Krx => Ok(KRX),
        Venue::Nxt => Err(Unsupported::Choice(kind, "시장 구분")),
    }
}

fn exclusions(exclude_managed: bool) -> &'static str {
    if exclude_managed { EXCLUDE_MANAGED } else { NO_EXCLUSIONS }
}

fn minimum_trade_amount_won(minimum: api::MinTradeAmount) -> &'static str {
    match minimum {
        api::MinTradeAmount::Any => NO_CONDITION,
        api::MinTradeAmount::AtLeast100Million => "100000000",
        api::MinTradeAmount::AtLeast1Billion => "1000000000",
        api::MinTradeAmount::AtLeast10Billion => "10000000000",
    }
}

impl KisRankings {
    fn volume_rank(venue: Venue, market: api::RankingMarket, belonging: &'static str, exclude_managed: bool, read: VolumeColumns) -> Plan {
        Plan {
            api: KisApiId::VolumeRank,
            query: query([
                ("FID_COND_MRKT_DIV_CODE", division_with_nxt(venue)),
                ("FID_COND_SCR_DIV_CODE", VOLUME_RANK_SCREEN),
                ("FID_INPUT_ISCD", market_code(market)),
                ("FID_DIV_CLS_CODE", ALL_SHARE_CLASSES),
                ("FID_BLNG_CLS_CODE", belonging),
                ("FID_TRGT_CLS_CODE", ALL_TARGETS),
                ("FID_TRGT_EXLS_CLS_CODE", exclusions(exclude_managed)),
                ("FID_INPUT_PRICE_1", NO_CONDITION),
                ("FID_INPUT_PRICE_2", NO_CONDITION),
                ("FID_VOL_CNT", NO_CONDITION),
                ("FID_INPUT_DATE_1", NO_CONDITION),
            ]),
            read: Read::Volume(read),
        }
    }

    fn plan(&self, ranking: &Ranking) -> Result<Plan, Unsupported> {
        let plan = match *ranking {
            Ranking::TradeAmount { market, venue, exclude_managed, .. } => Self::volume_rank(venue, market, BY_TRADE_AMOUNT, exclude_managed, VolumeColumns::TradeAmount),
            Ranking::TradeVolume { market, venue, session, exclude_managed, .. } => match session {
                api::TradingSession::All | api::TradingSession::Regular => Self::volume_rank(venue, market, BY_AVERAGE_VOLUME, exclude_managed, VolumeColumns::TradeVolume),
                api::TradingSession::AfterHours if exclude_managed => return Err(Unsupported::Choice(RankingKind::TradeVolume, "관리종목 제외")),
                api::TradingSession::AfterHours => Plan {
                    api: KisApiId::OvertimeVolume,
                    query: query([
                        ("FID_COND_MRKT_DIV_CODE", krx_only(RankingKind::TradeVolume, venue)?),
                        ("FID_COND_SCR_DIV_CODE", OVERTIME_SCREEN),
                        ("FID_INPUT_ISCD", market_code(market)),
                        ("FID_RANK_SORT_CLS_CODE", OVERTIME_BY_VOLUME),
                        ("FID_INPUT_PRICE_1", NO_CONDITION),
                        ("FID_INPUT_PRICE_2", NO_CONDITION),
                        ("FID_VOL_CNT", NO_CONDITION),
                        ("FID_TRGT_CLS_CODE", NO_CONDITION),
                        ("FID_TRGT_EXLS_CLS_CODE", NO_CONDITION),
                    ]),
                    read: Read::Overtime,
                },
                api::TradingSession::PreMarket => return Err(Unsupported::Choice(RankingKind::TradeVolume, "장 구분")),
            },
            Ranking::Turnover { market, venue, exclude_managed, .. } => Self::volume_rank(venue, market, BY_TURNOVER, exclude_managed, VolumeColumns::Turnover),
            Ranking::VolumeSurge { market, venue, exclude_managed, .. } => Self::volume_rank(venue, market, BY_VOLUME_INCREASE, exclude_managed, VolumeColumns::Surge),
            Ranking::Gainers { market, venue, include_limit, min_trade_amount, exclude_managed, .. } => {
                Self::movers(Direction::Rising, market, venue, include_limit, min_trade_amount, exclude_managed)
            }
            Ranking::Losers { market, venue, include_limit, min_trade_amount, exclude_managed, .. } => {
                Self::movers(Direction::Falling, market, venue, include_limit, min_trade_amount, exclude_managed)
            }
            Ranking::Expected { market, venue, sort, .. } => {
                let after_noon = self.clock.now().kst_time_of_day().secs() >= EXPECTED_AT_CLOSE_FROM_SECS;
                Plan {
                    api: KisApiId::ExpectedUpDown,
                    query: query([
                        ("FID_RANK_SORT_CLS_CODE", if sort == api::ExpectedSort::Gainers { EXPECTED_RISING_RATE } else { EXPECTED_FALLING_RATE }),
                        ("FID_COND_MRKT_DIV_CODE", krx_only(RankingKind::Expected, venue)?),
                        ("FID_COND_SCR_DIV_CODE", EXPECTED_SCREEN),
                        ("FID_INPUT_ISCD", market_code(market)),
                        ("FID_DIV_CLS_CODE", ALL_SHARE_CLASSES),
                        ("FID_APLY_RANG_PRC_1", NO_CONDITION),
                        ("FID_VOL_CNT", NO_CONDITION),
                        ("FID_PBMN", NO_CONDITION),
                        ("FID_BLNG_CLS_CODE", ALL_TARGETS),
                        ("FID_MKOP_CLS_CODE", if after_noon { EXPECTED_AT_CLOSE } else { EXPECTED_BEFORE_OPEN }),
                    ]),
                    read: Read::Expected,
                }
            }
            Ranking::InvestorNetBuy { market, investor, direction, unit, .. } => {
                let investor_code = match investor {
                    api::RankingInvestor::Foreign => FOREIGN_INVESTORS,
                    api::RankingInvestor::Institution => INSTITUTIONS,
                    api::RankingInvestor::OtherCorporation => OTHER_INVESTORS,
                    _ => return Err(Unsupported::Choice(RankingKind::InvestorNetBuy, "투자자 구분")),
                };
                Plan {
                    api: KisApiId::InvestorTotal,
                    query: query([
                        ("FID_COND_MRKT_DIV_CODE", INVESTOR_MARKET),
                        ("FID_COND_SCR_DIV_CODE", INVESTOR_SCREEN),
                        ("FID_INPUT_ISCD", market_code(market)),
                        ("FID_DIV_CLS_CODE", if unit == api::TradeUnit::Amount { BY_AMOUNT } else { BY_QUANTITY }),
                        ("FID_RANK_SORT_CLS_CODE", if direction == api::NetDirection::NetBuy { NET_BUYING_FIRST } else { NET_SELLING_FIRST }),
                        ("FID_ETC_CLS_CODE", investor_code),
                    ]),
                    read: Read::Investor { investor, unit },
                }
            }
            Ranking::BidAskBalance { market, venue, sort, exclude_managed, .. } => Plan {
                api: KisApiId::QuoteBalance,
                query: query([
                    ("FID_VOL_CNT", NO_CONDITION),
                    ("FID_COND_MRKT_DIV_CODE", krx_or_nxt(venue)),
                    ("FID_COND_SCR_DIV_CODE", QUOTE_BALANCE_SCREEN),
                    ("FID_INPUT_ISCD", listed_market_code(market)),
                    (
                        "FID_RANK_SORT_CLS_CODE",
                        match sort {
                            api::BalanceSort::NetBuyRemaining => "0",
                            api::BalanceSort::NetSellRemaining => "1",
                            api::BalanceSort::BuyRatio => "2",
                            api::BalanceSort::SellRatio => "3",
                        },
                    ),
                    ("FID_DIV_CLS_CODE", ALL_TARGETS),
                    ("FID_TRGT_CLS_CODE", ALL_TARGETS),
                    ("FID_TRGT_EXLS_CLS_CODE", if exclude_managed { EXCLUDE_MANAGED } else { NO_EXCLUSIONS_QUOTE_BALANCE }),
                    ("FID_INPUT_PRICE_1", NO_CONDITION),
                    ("FID_INPUT_PRICE_2", NO_CONDITION),
                ]),
                read: Read::Balance,
            },
            Ranking::CreditRatio { market, venue, .. } => Plan {
                api: KisApiId::CreditBalance,
                query: query([
                    ("FID_COND_SCR_DIV_CODE", CREDIT_SCREEN),
                    ("FID_INPUT_ISCD", market_code(market)),
                    ("FID_OPTION", CREDIT_DAYS),
                    ("FID_COND_MRKT_DIV_CODE", krx_only(RankingKind::CreditRatio, venue)?),
                    ("FID_RANK_SORT_CLS_CODE", CREDIT_LOAN_RATIO_FIRST),
                ]),
                read: Read::Credit,
            },
            Ranking::MostViewed { .. } => Plan { api: KisApiId::HtsTopView, query: Vec::new(), read: Read::MostViewed },
            Ranking::ForeignStreak { .. } => return Err(Unsupported::Kind(RankingKind::ForeignStreak)),
            Ranking::Program { .. } => return Err(Unsupported::Kind(RankingKind::Program)),
        };
        Ok(plan)
    }

    fn movers(direction: Direction, market: api::RankingMarket, venue: Venue, include_limit: bool, min_trade_amount: api::MinTradeAmount, exclude_managed: bool) -> Plan {
        Plan {
            api: KisApiId::Fluctuation,
            query: query([
                ("FID_RSFL_RATE2", NO_CONDITION),
                ("FID_COND_MRKT_DIV_CODE", krx_or_nxt(venue)),
                ("FID_COND_SCR_DIV_CODE", FLUCTUATION_SCREEN),
                ("FID_INPUT_ISCD", market_code(market)),
                ("FID_RANK_SORT_CLS_CODE", if direction == Direction::Rising { RISING_FIRST } else { FALLING_FIRST }),
                ("FID_INPUT_CNT_1", ALL_TARGETS),
                ("FID_PRC_CLS_CODE", ALL_TARGETS),
                ("FID_INPUT_PRICE_1", NO_CONDITION),
                ("FID_INPUT_PRICE_2", NO_CONDITION),
                ("FID_VOL_CNT", minimum_trade_amount_won(min_trade_amount)),
                ("FID_TRGT_CLS_CODE", ALL_TARGETS),
                ("FID_TRGT_EXLS_CLS_CODE", exclusions(exclude_managed)),
                ("FID_DIV_CLS_CODE", ALL_SHARE_CLASSES),
                ("FID_RSFL_RATE1", NO_CONDITION),
            ]),
            read: Read::Movers { direction, include_limit },
        }
    }
}

fn protocol_failure(api: KisApiId) -> SourceError {
    tracing::error!(tr_id = api.tr_id(), "한투 순위 응답을 읽지 못했습니다");
    SourceError::Failed(SourceFailure {
        code: ApiErrorCode::KiwoomUnavailable,
        reason: ApiErrorReason::Protocol,
        message: format!("한투 순위 응답을 읽지 못했습니다({})", api.tr_id()),
        retry_at: None,
        manual_action_required: false,
    })
}

fn source_error(error: &KisError) -> SourceError {
    let unavailable = |reason| SourceFailure { code: ApiErrorCode::KiwoomUnavailable, reason, message: error.to_string(), retry_at: None, manual_action_required: false };
    let failure = match error {
        KisError::Failed(failure) => unavailable(match failure.category() {
            Category::RateLimited => ApiErrorReason::RateLimited,
            Category::TokenInvalid => ApiErrorReason::TokenInvalid,
            Category::IssueLimited => ApiErrorReason::IssueInterval,
            Category::BusinessRejected => ApiErrorReason::BusinessRejected,
            Category::AuthBlocked => ApiErrorReason::AuthBlocked,
            Category::Unknown | Category::SeatsExceeded | Category::InUseElsewhere => ApiErrorReason::UnknownFailure,
        }),
        KisError::Stopped(failure) if matches!(failure.category(), Category::AuthBlocked | Category::TokenInvalid) => {
            SourceFailure { code: ApiErrorCode::KiwoomAuthFailed, reason: ApiErrorReason::AuthBlocked, manual_action_required: true, ..unavailable(ApiErrorReason::AuthBlocked) }
        }
        KisError::Stopped(_) => unavailable(ApiErrorReason::UnknownFailure),
        KisError::Gated { until } => SourceFailure { retry_at: Some(*until), ..unavailable(ApiErrorReason::IssueInterval) },
        KisError::TokenFile(_) => SourceFailure { code: ApiErrorCode::KiwoomAuthFailed, manual_action_required: true, ..unavailable(ApiErrorReason::TokenFile) },
        KisError::Transport(transport) => unavailable(if transport.timed_out { ApiErrorReason::KiwoomTimeout } else { ApiErrorReason::KiwoomUnreachable }),
        KisError::BadTokenResponse => unavailable(ApiErrorReason::Protocol),
        KisError::QueueGone | KisError::NotAdmitted => unavailable(ApiErrorReason::KiwoomUnreachable),
    };
    SourceError::Failed(failure)
}

fn signed_whole(text: &str) -> Option<i64> {
    let text = text.trim();
    match text.strip_prefix('-') {
        Some(rest) => whole(rest).and_then(|n| i64::try_from(n).ok()).map(|n| -n),
        None => whole(text).and_then(|n| i64::try_from(n).ok()),
    }
}

fn float(text: &str) -> Option<f64> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.parse::<f64>().ok()).flatten().filter(|v| v.is_finite())
}

fn won(text: &str) -> Option<Won> {
    whole(text).and_then(|n| i64::try_from(n).ok()).map(Won)
}

fn shares(text: &str) -> Option<Shares> {
    whole(text).and_then(|n| i64::try_from(n).ok()).map(Shares)
}

fn percent(text: &str) -> Option<Percent> {
    float(text).map(Percent)
}

fn signed_change(sign: &str, magnitude: &str) -> Option<Won> {
    let sign = sign.trim();
    if !RISING_SIGNS.contains(&sign) && !FALLING_SIGNS.contains(&sign) {
        return None;
    }
    let amount = signed_whole(magnitude)?.abs();
    Some(Won(if FALLING_SIGNS.contains(&sign) { -amount } else { amount }))
}

fn won_from_million(text: &str) -> Option<Won> {
    signed_whole(text).and_then(|n| n.checked_mul(WON_PER_MILLION)).map(Won)
}

fn stock_code(text: &str) -> Option<StockCode> {
    StockCode::parse(text.trim()).ok()
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct VolumeRow {
    mksc_shrn_iscd: String,
    hts_kor_isnm: String,
    stck_prpr: String,
    prdy_ctrt: String,
    acml_vol: String,
    prdy_vol: String,
    avrg_vol: String,
    vol_inrt: String,
    vol_tnrt: String,
    acml_tr_pbmn: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MoversRow {
    stck_shrn_iscd: String,
    hts_kor_isnm: String,
    stck_prpr: String,
    prdy_vrss: String,
    prdy_vrss_sign: String,
    prdy_ctrt: String,
    acml_vol: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ExpectedRow {
    stck_shrn_iscd: String,
    hts_kor_isnm: String,
    stck_prpr: String,
    prdy_ctrt: String,
    cntg_vol: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct InvestorRow {
    mksc_shrn_iscd: String,
    hts_kor_isnm: String,
    stck_prpr: String,
    prdy_ctrt: String,
    frgn_ntby_qty: String,
    orgn_ntby_qty: String,
    etc_orgt_ntby_vol: String,
    etc_corp_ntby_vol: String,
    frgn_ntby_tr_pbmn: String,
    orgn_ntby_tr_pbmn: String,
    etc_orgt_ntby_tr_pbmn: String,
    etc_corp_ntby_tr_pbmn: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct BalanceRow {
    mksc_shrn_iscd: String,
    hts_kor_isnm: String,
    stck_prpr: String,
    prdy_ctrt: String,
    total_askp_rsqn: String,
    total_bidp_rsqn: String,
    total_ntsl_bidp_rsqn: String,
    shnu_rsqn_rate: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CreditRow {
    mksc_shrn_iscd: String,
    hts_kor_isnm: String,
    stck_prpr: String,
    prdy_ctrt: String,
    acml_vol: String,
    whol_loan_rmnd_rate: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TopViewRow {
    mksc_shrn_iscd: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OvertimeRow {
    stck_shrn_iscd: String,
    hts_kor_isnm: String,
    ovtm_untp_prpr: String,
    ovtm_untp_prdy_ctrt: String,
    ovtm_untp_vol: String,
}

struct ReadRows {
    received: usize,
    rows: Vec<RankedRow>,
}

fn collect<R>(rows: Vec<Option<R>>, read: impl Fn(&R) -> Option<RankedRow>) -> ReadRows {
    ReadRows { received: rows.len(), rows: rows.iter().flatten().filter_map(read).collect() }
}

impl Read {
    fn rows_field(self) -> &'static str {
        match self {
            Read::Volume(_) | Read::Movers { .. } | Read::Expected | Read::Investor { .. } | Read::Balance => "output",
            Read::MostViewed => "output1",
            Read::Credit | Read::Overtime => "output2",
        }
    }

    fn rows(self, api: KisApiId, page: &KisPage) -> Result<Vec<RankedRow>, SourceError> {
        let field = self.rows_field();
        let read = match self {
            Read::Volume(columns) => collect(parse::<VolumeRow>(api, page, field)?, |row| volume_row(columns, row)),
            Read::Movers { direction, include_limit } => {
                let mut parsed = parse::<MoversRow>(api, page, field)?;
                parsed.retain(|row| include_limit || !row.as_ref().is_some_and(|row| at_limit(direction, row)));
                collect(parsed, mover_row)
            }
            Read::Expected => collect(parse::<ExpectedRow>(api, page, field)?, expected_row),
            Read::Investor { investor, unit } => collect(parse::<InvestorRow>(api, page, field)?, |row| investor_row(investor, unit, row)),
            Read::Balance => collect(parse::<BalanceRow>(api, page, field)?, balance_row),
            Read::Credit => collect(parse::<CreditRow>(api, page, field)?, credit_row),
            Read::MostViewed => collect(parse::<TopViewRow>(api, page, field)?, most_viewed_row),
            Read::Overtime => collect(parse::<OvertimeRow>(api, page, field)?, overtime_row),
        };
        if read.received > 0 && read.rows.is_empty() {
            return Err(protocol_failure(api));
        }
        Ok(read.rows)
    }
}

fn parse<R: for<'de> Deserialize<'de>>(api: KisApiId, page: &KisPage, field: &str) -> Result<Vec<Option<R>>, SourceError> {
    let mut body: serde_json::Value = serde_json::from_str(&page.body).map_err(|_| protocol_failure(api))?;
    let rows = match body.get_mut(field).map(serde_json::Value::take) {
        None | Some(serde_json::Value::Null) => return Ok(Vec::new()),
        Some(serde_json::Value::Array(rows)) => rows,
        Some(_) => return Err(protocol_failure(api)),
    };
    Ok(rows
        .into_iter()
        .map(|mut row| {
            if let serde_json::Value::Object(columns) = &mut row {
                columns.retain(|_, value| !value.is_null());
            }
            serde_json::from_value(row).ok()
        })
        .collect())
}

fn volume_row(columns: VolumeColumns, row: &VolumeRow) -> Option<RankedRow> {
    let volume = shares(&row.acml_vol)?;
    let figures = match columns {
        VolumeColumns::TradeAmount => RankingFigures::TradeAmount { trade_amount: won(&row.acml_tr_pbmn)?, volume, places_gained: None },
        VolumeColumns::TradeVolume => {
            let previous = whole(&row.prdy_vol).filter(|previous| *previous > 0);
            RankingFigures::TradeVolume { volume, previous_day_volume_rate: previous.map(|previous| Percent(volume.0 as f64 / previous as f64 * 100.0)) }
        }
        VolumeColumns::Turnover => RankingFigures::Turnover { turnover_rate: percent(&row.vol_tnrt)?, volume },
        VolumeColumns::Surge => {
            let average = whole(&row.avrg_vol).and_then(|average| i64::try_from(average).ok()).unwrap_or(0);
            RankingFigures::VolumeSurge { surge_rate: percent(&row.vol_inrt)?, surge_volume: Shares(volume.0 - average), volume }
        }
    };
    Some(RankedRow { code: stock_code(&row.mksc_shrn_iscd)?, name: row.hts_kor_isnm.trim().to_owned(), price: Some(won(&row.stck_prpr)?), change_rate: percent(&row.prdy_ctrt), figures })
}

fn at_limit(direction: Direction, row: &MoversRow) -> bool {
    row.prdy_vrss_sign.trim() == if direction == Direction::Rising { LIMIT_UP_SIGN } else { LIMIT_DOWN_SIGN }
}

fn mover_row(row: &MoversRow) -> Option<RankedRow> {
    Some(RankedRow {
        code: stock_code(&row.stck_shrn_iscd)?,
        name: row.hts_kor_isnm.trim().to_owned(),
        price: Some(won(&row.stck_prpr)?),
        change_rate: percent(&row.prdy_ctrt),
        figures: RankingFigures::Movers { price_change: signed_change(&row.prdy_vrss_sign, &row.prdy_vrss)?, volume: shares(&row.acml_vol)? },
    })
}

fn expected_row(row: &ExpectedRow) -> Option<RankedRow> {
    Some(RankedRow {
        code: stock_code(&row.stck_shrn_iscd)?,
        name: row.hts_kor_isnm.trim().to_owned(),
        price: None,
        change_rate: None,
        figures: RankingFigures::Expected { expected_price: won(&row.stck_prpr)?, expected_change_rate: percent(&row.prdy_ctrt)?, expected_volume: shares(&row.cntg_vol)? },
    })
}

fn investor_row(investor: api::RankingInvestor, unit: api::TradeUnit, row: &InvestorRow) -> Option<RankedRow> {
    let figures = match unit {
        api::TradeUnit::Amount => {
            let net = match investor {
                api::RankingInvestor::Foreign => won_from_million(&row.frgn_ntby_tr_pbmn)?,
                api::RankingInvestor::Institution => won_from_million(&row.orgn_ntby_tr_pbmn)?,
                _ => Won(won_from_million(&row.etc_orgt_ntby_tr_pbmn)?.0.checked_add(won_from_million(&row.etc_corp_ntby_tr_pbmn)?.0)?),
            };
            RankingFigures::NetAmounts { net, buy: Won(0), sell: Won(0) }
        }
        api::TradeUnit::Quantity => {
            let net = match investor {
                api::RankingInvestor::Foreign => signed_whole(&row.frgn_ntby_qty)?,
                api::RankingInvestor::Institution => signed_whole(&row.orgn_ntby_qty)?,
                _ => signed_whole(&row.etc_orgt_ntby_vol)?.checked_add(signed_whole(&row.etc_corp_ntby_vol)?)?,
            };
            RankingFigures::NetQuantities { net: Shares(net), buy: Shares(0), sell: Shares(0) }
        }
    };
    Some(RankedRow { code: stock_code(&row.mksc_shrn_iscd)?, name: row.hts_kor_isnm.trim().to_owned(), price: won(&row.stck_prpr), change_rate: percent(&row.prdy_ctrt), figures })
}

fn balance_row(row: &BalanceRow) -> Option<RankedRow> {
    Some(RankedRow {
        code: stock_code(&row.mksc_shrn_iscd)?,
        name: row.hts_kor_isnm.trim().to_owned(),
        price: Some(won(&row.stck_prpr)?),
        change_rate: percent(&row.prdy_ctrt),
        figures: RankingFigures::BidAskBalance {
            total_sell_remaining: shares(&row.total_askp_rsqn)?,
            total_buy_remaining: shares(&row.total_bidp_rsqn)?,
            net_buy_remaining: Shares(signed_whole(&row.total_ntsl_bidp_rsqn)?),
            buy_ratio: percent(&row.shnu_rsqn_rate)?,
        },
    })
}

fn credit_row(row: &CreditRow) -> Option<RankedRow> {
    Some(RankedRow {
        code: stock_code(&row.mksc_shrn_iscd)?,
        name: row.hts_kor_isnm.trim().to_owned(),
        price: Some(won(&row.stck_prpr)?),
        change_rate: percent(&row.prdy_ctrt),
        figures: RankingFigures::CreditRatio { credit_ratio: percent(&row.whol_loan_rmnd_rate)?, volume: shares(&row.acml_vol)? },
    })
}

fn most_viewed_row(row: &TopViewRow) -> Option<RankedRow> {
    Some(RankedRow {
        code: stock_code(&row.mksc_shrn_iscd)?,
        name: String::new(),
        price: None,
        change_rate: None,
        figures: RankingFigures::MostViewed { reference_price: Won(0), change_from_reference_rate: Percent(0.0), places_gained: None },
    })
}

fn overtime_row(row: &OvertimeRow) -> Option<RankedRow> {
    Some(RankedRow {
        code: stock_code(&row.stck_shrn_iscd)?,
        name: row.hts_kor_isnm.trim().to_owned(),
        price: Some(won(&row.ovtm_untp_prpr)?),
        change_rate: percent(&row.ovtm_untp_prdy_ctrt),
        figures: RankingFigures::TradeVolume { volume: shares(&row.ovtm_untp_vol)?, previous_day_volume_rate: None },
    })
}
