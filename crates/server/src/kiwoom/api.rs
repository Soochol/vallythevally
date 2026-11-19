//! 시세 API만 허용(backend.md §4.4). 이 enum에 없는 api-id와 경로는 보낼 수 없다.

use domain::{IndexCode, KstDate, Period, StockCode, Venue};
use serde::Serialize;

use super::wire;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ApiId {
    /// 접근토큰 발급
    Au10001,
    /// 종목정보 리스트
    Ka10099,
    /// 종목정보 하나
    Ka10100,
    /// 지정종목 정보(여러 종목 현재가, 한 번에 100개까지)
    Ka10095,
    /// 주식기본정보(시가총액, PER, 250일 최고·최저 등)
    Ka10001,
    /// 주식 분봉
    Ka10080,
    /// 주식 일봉
    Ka10081,
    /// 주식 주봉
    Ka10082,
    /// 주식 월봉
    Ka10083,
    Ka10094,
    /// 업종 분봉
    Ka20005,
    /// 업종 일봉
    Ka20006,
    /// 업종 주봉
    Ka20007,
    /// 업종 월봉
    Ka20008,
    Ka20019,
    Ka10008,
    Ka10059,
    /// 주식호가(10단 호가와 총잔량)
    Ka10004,
    /// 체결정보(당일 체결 목록)
    Ka10003,
    /// 종목시간별프로그램매매추이
    Ka90008,
    Ka10032,
    Ka10030,
    Ka10023,
    Ka10027,
    Ka10029,
    Ka10065,
    Ka10035,
    Ka10020,
    Ka10033,
    Ka90003,
    Ka00198,
    Ka20003,
    Ka10051,
    Ka90005,
    Ka90010,
    Ka10131,
}

impl ApiId {
    pub const fn path(self) -> &'static str {
        match self {
            ApiId::Au10001 => "/oauth2/token",
            ApiId::Ka10099
            | ApiId::Ka10100
            | ApiId::Ka10095
            | ApiId::Ka10001
            | ApiId::Ka10059
            | ApiId::Ka10003
            | ApiId::Ka90003
            | ApiId::Ka00198 => "/api/dostk/stkinfo",
            ApiId::Ka10032
            | ApiId::Ka10030
            | ApiId::Ka10023
            | ApiId::Ka10027
            | ApiId::Ka10029
            | ApiId::Ka10065
            | ApiId::Ka10035
            | ApiId::Ka10020
            | ApiId::Ka10033 => "/api/dostk/rkinfo",
            ApiId::Ka10004 | ApiId::Ka90008 | ApiId::Ka90005 | ApiId::Ka90010 => "/api/dostk/mrkcond",
            ApiId::Ka10008 | ApiId::Ka10131 => "/api/dostk/frgnistt",
            ApiId::Ka20003 | ApiId::Ka10051 => "/api/dostk/sect",
            ApiId::Ka10080
            | ApiId::Ka10081
            | ApiId::Ka10082
            | ApiId::Ka10083
            | ApiId::Ka10094
            | ApiId::Ka20005
            | ApiId::Ka20006
            | ApiId::Ka20007
            | ApiId::Ka20008
            | ApiId::Ka20019 => "/api/dostk/chart",
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            ApiId::Au10001 => "au10001",
            ApiId::Ka10099 => "ka10099",
            ApiId::Ka10100 => "ka10100",
            ApiId::Ka10095 => "ka10095",
            ApiId::Ka10001 => "ka10001",
            ApiId::Ka10080 => "ka10080",
            ApiId::Ka10081 => "ka10081",
            ApiId::Ka10082 => "ka10082",
            ApiId::Ka10083 => "ka10083",
            ApiId::Ka10094 => "ka10094",
            ApiId::Ka20005 => "ka20005",
            ApiId::Ka20006 => "ka20006",
            ApiId::Ka20007 => "ka20007",
            ApiId::Ka20008 => "ka20008",
            ApiId::Ka20019 => "ka20019",
            ApiId::Ka10008 => "ka10008",
            ApiId::Ka10059 => "ka10059",
            ApiId::Ka10004 => "ka10004",
            ApiId::Ka10003 => "ka10003",
            ApiId::Ka90008 => "ka90008",
            ApiId::Ka10032 => "ka10032",
            ApiId::Ka10030 => "ka10030",
            ApiId::Ka10023 => "ka10023",
            ApiId::Ka10027 => "ka10027",
            ApiId::Ka10029 => "ka10029",
            ApiId::Ka10065 => "ka10065",
            ApiId::Ka10035 => "ka10035",
            ApiId::Ka10020 => "ka10020",
            ApiId::Ka10033 => "ka10033",
            ApiId::Ka90003 => "ka90003",
            ApiId::Ka00198 => "ka00198",
            ApiId::Ka20003 => "ka20003",
            ApiId::Ka10051 => "ka10051",
            ApiId::Ka90005 => "ka90005",
            ApiId::Ka90010 => "ka90010",
            ApiId::Ka10131 => "ka10131",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Endpoint {
    Market(ApiId),
    Trading(crate::trading::TradingApiId),
}

impl Endpoint {
    pub const ISSUE: Endpoint = Endpoint::Market(ApiId::Au10001);

    pub const fn path(self) -> &'static str {
        match self {
            Endpoint::Market(id) => id.path(),
            Endpoint::Trading(id) => id.path(),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Endpoint::Market(id) => id.as_str(),
            Endpoint::Trading(id) => id.as_str(),
        }
    }

    pub const fn market(self) -> Option<ApiId> {
        match self {
            Endpoint::Market(id) => Some(id),
            Endpoint::Trading(_) => None,
        }
    }
}

impl From<ApiId> for Endpoint {
    fn from(id: ApiId) -> Endpoint {
        Endpoint::Market(id)
    }
}

impl From<crate::trading::TradingApiId> for Endpoint {
    fn from(id: crate::trading::TradingApiId) -> Endpoint {
        Endpoint::Trading(id)
    }
}

impl PartialEq<ApiId> for Endpoint {
    fn eq(&self, other: &ApiId) -> bool {
        self.market() == Some(*other)
    }
}

mod sealed {
    pub trait Sealed {}
}

/// 요청 하나의 타입. 봉인되어 있어 kiwoom 모듈 밖에서 새 요청을 만들 수 없다.
pub trait MarketRequest: sealed::Sealed + Serialize + Send + Sync {
    const API_ID: ApiId;
    type Response: serde::de::DeserializeOwned;

    fn answers(&self, _: &Self::Response) -> bool {
        true
    }
}

/// 거래소는 종목코드 접미사로 고른다(kiwoom.md 3·12·13절). 키움 종목코드는 이 함수로만 만든다.
pub fn kiwoom_stock_code(code: StockCode, venue: Venue) -> String {
    let suffix = match venue {
        Venue::Combined => "_AL",
        Venue::Krx => "",
        Venue::Nxt => "_NX",
    };
    format!("{}{suffix}", code.as_str())
}

const ADJUSTED_PRICE: &str = "1";

macro_rules! stock_chart {
    ($name:ident, $api:ident, $resp:ty) => {
        /// `base_dt`는 언제나 오늘이다. 생성자가 넣으므로 과거 날짜로 바로 가는 요청은 표현할 수 없다(§6.3).
        #[derive(Serialize)]
        pub struct $name {
            stk_cd: String,
            base_dt: String,
            upd_stkpc_tp: &'static str,
        }
        impl $name {
            pub fn new(code: StockCode, venue: Venue, today: KstDate) -> Self {
                $name { stk_cd: kiwoom_stock_code(code, venue), base_dt: today.yyyymmdd(), upd_stkpc_tp: ADJUSTED_PRICE }
            }
        }
        impl sealed::Sealed for $name {}
        impl MarketRequest for $name {
            const API_ID: ApiId = ApiId::$api;
            type Response = $resp;
        }
    };
}

macro_rules! index_chart {
    ($name:ident, $api:ident, $resp:ty) => {
        #[derive(Serialize)]
        pub struct $name {
            inds_cd: String,
            base_dt: String,
        }
        impl $name {
            pub fn new(code: IndexCode, today: KstDate) -> Self {
                $name { inds_cd: code.as_str().to_owned(), base_dt: today.yyyymmdd() }
            }
        }
        impl sealed::Sealed for $name {}
        impl MarketRequest for $name {
            const API_ID: ApiId = ApiId::$api;
            type Response = $resp;
        }
    };
}

stock_chart!(DailyChart, Ka10081, wire::DailyChartResponse);
stock_chart!(WeeklyChart, Ka10082, wire::WeeklyChartResponse);
stock_chart!(MonthlyChart, Ka10083, wire::MonthlyChartResponse);
stock_chart!(YearlyChart, Ka10094, wire::YearlyChartResponse);
index_chart!(IndexDailyChart, Ka20006, wire::IndexDailyChartResponse);
index_chart!(IndexWeeklyChart, Ka20007, wire::IndexWeeklyChartResponse);
index_chart!(IndexMonthlyChart, Ka20008, wire::IndexMonthlyChartResponse);
index_chart!(IndexYearlyChart, Ka20019, wire::IndexYearlyChartResponse);

/// ka10080 주식 분봉. `base_dt`는 일·주·월봉처럼 언제나 시리즈의 오늘이다. 과거 날짜를 주면 그날 뒤의
/// 권리발생이 빠진 가격이 온다(kiwoom.md §4.1, backend.md §6.3).
#[derive(Serialize)]
pub struct MinuteChart {
    stk_cd: String,
    tic_scope: String,
    upd_stkpc_tp: &'static str,
    base_dt: String,
}

impl MinuteChart {
    /// 분봉 주기가 아니면 None.
    pub fn new(code: StockCode, venue: Venue, period: Period, today: KstDate) -> Option<Self> {
        Some(MinuteChart {
            stk_cd: kiwoom_stock_code(code, venue),
            tic_scope: tic_scope(period)?,
            upd_stkpc_tp: ADJUSTED_PRICE,
            base_dt: today.yyyymmdd(),
        })
    }
}

impl sealed::Sealed for MinuteChart {}
impl MarketRequest for MinuteChart {
    const API_ID: ApiId = ApiId::Ka10080;
    type Response = wire::MinuteChartResponse;
}

/// ka20005 업종 분봉. 지수에는 수정주가 필드가 없어(§6) 과거 `base_dt`로 받아도 값이 같다. 그래서 연속조회 키가
/// 묵으면(kiwoom.md §10.3) 키움이 그날 19:59부터 거꾸로 주는 것(§1)을 써서 끊긴 자리로 한 번에 건너뛴다.
#[derive(Serialize)]
pub struct IndexMinuteChart {
    inds_cd: String,
    tic_scope: String,
    base_dt: String,
}

impl IndexMinuteChart {
    /// 분봉 주기가 아니면 None.
    pub fn new(code: IndexCode, period: Period, base_dt: KstDate) -> Option<Self> {
        Some(IndexMinuteChart { inds_cd: code.as_str().to_owned(), tic_scope: tic_scope(period)?, base_dt: base_dt.yyyymmdd() })
    }
}

impl sealed::Sealed for IndexMinuteChart {}
impl MarketRequest for IndexMinuteChart {
    const API_ID: ApiId = ApiId::Ka20005;
    type Response = wire::IndexMinuteChartResponse;
}

/// "1", "3", "5", "10", "15", "30", "60".
fn tic_scope(period: Period) -> Option<String> {
    period.minutes().map(|n| n.to_string())
}

/// ka10099. `mrkt_tp=0`은 거래소 시장의 모든 상품, `10`은 코스닥이다(kiwoom.md §5).
#[derive(Serialize)]
pub struct StockList {
    mrkt_tp: &'static str,
}

impl StockList {
    pub const EXCHANGE: StockList = StockList { mrkt_tp: "0" };
    pub const KOSDAQ: StockList = StockList { mrkt_tp: "10" };
}

impl sealed::Sealed for StockList {}
impl MarketRequest for StockList {
    const API_ID: ApiId = ApiId::Ka10099;
    type Response = wire::StockListResponse;
}

/// ka10095 여러 종목 현재가. 거래소는 종목코드 접미사로 고른다. 한 번에 100종목까지 된다. 101개부터는
/// 행 없이 1634로 거절된다(kiwoom.md §10.6). 생성자가 개수를 막으므로 넘치는 요청은 만들 수 없다.
#[derive(Serialize)]
pub struct StockQuotes {
    stk_cd: String,
}

impl StockQuotes {
    pub const MAX: usize = 100;

    pub fn new(codes: &[StockCode], venue: Venue) -> Option<Self> {
        (1..=Self::MAX).contains(&codes.len()).then(|| StockQuotes {
            stk_cd: codes.iter().map(|c| kiwoom_stock_code(*c, venue)).collect::<Vec<_>>().join("|"),
        })
    }

    pub fn of_venues(rows: &[(StockCode, Venue)]) -> Option<Self> {
        (1..=Self::MAX).contains(&rows.len()).then(|| StockQuotes {
            stk_cd: rows.iter().map(|(c, v)| kiwoom_stock_code(*c, *v)).collect::<Vec<_>>().join("|"),
        })
    }
}

impl sealed::Sealed for StockQuotes {}
impl MarketRequest for StockQuotes {
    const API_ID: ApiId = ApiId::Ka10095;
    type Response = wire::StockQuotesResponse;
}

#[derive(Serialize)]
pub struct StockBasicInfo {
    stk_cd: String,
}

impl StockBasicInfo {
    pub fn new(code: StockCode) -> Self {
        StockBasicInfo { stk_cd: kiwoom_stock_code(code, Venue::Combined) }
    }
}

impl sealed::Sealed for StockBasicInfo {}
impl MarketRequest for StockBasicInfo {
    const API_ID: ApiId = ApiId::Ka10001;
    type Response = wire::StockBasicInfoResponse;

    fn answers(&self, r: &wire::StockBasicInfoResponse) -> bool {
        match r {
            wire::StockBasicInfoResponse::UnknownSymbol => true,
            wire::StockBasicInfoResponse::Found { kiwoom_code, .. } => *kiwoom_code == self.stk_cd,
        }
    }
}

#[derive(Serialize)]
pub struct StockForeignHoldings {
    stk_cd: String,
}

impl StockForeignHoldings {
    pub fn new(code: StockCode) -> Self {
        StockForeignHoldings { stk_cd: kiwoom_stock_code(code, Venue::Krx) }
    }
}

impl sealed::Sealed for StockForeignHoldings {}
impl MarketRequest for StockForeignHoldings {
    const API_ID: ApiId = ApiId::Ka10008;
    type Response = wire::StockForeignHoldingsResponse;
}

const QUANTITY: &str = "2";
const NET_BUYING: &str = "0";
const SINGLE_SHARES: &str = "1";

#[derive(Serialize)]
pub struct StockInvestorNetShares {
    dt: String,
    stk_cd: String,
    amt_qty_tp: &'static str,
    trde_tp: &'static str,
    unit_tp: &'static str,
}

impl StockInvestorNetShares {
    pub fn new(code: StockCode, today: KstDate) -> Self {
        StockInvestorNetShares { dt: today.yyyymmdd(), stk_cd: kiwoom_stock_code(code, Venue::Krx), amt_qty_tp: QUANTITY, trde_tp: NET_BUYING, unit_tp: SINGLE_SHARES }
    }
}

impl sealed::Sealed for StockInvestorNetShares {}
impl MarketRequest for StockInvestorNetShares {
    const API_ID: ApiId = ApiId::Ka10059;
    type Response = wire::StockInvestorNetSharesResponse;
}

/// ka10004. 거래소는 종목코드 접미사로 고른다.
#[derive(Serialize)]
pub struct StockOrderBook {
    stk_cd: String,
}

impl StockOrderBook {
    pub fn new(code: StockCode, venue: Venue) -> Self {
        StockOrderBook { stk_cd: kiwoom_stock_code(code, venue) }
    }
}

impl sealed::Sealed for StockOrderBook {}
impl MarketRequest for StockOrderBook {
    const API_ID: ApiId = ApiId::Ka10004;
    type Response = wire::StockOrderBookResponse;
}

/// ka10003. 날짜 입력이 없어 언제나 당일 체결이다. 거래소는 종목코드 접미사로 고른다.
#[derive(Serialize)]
pub struct StockTrades {
    stk_cd: String,
}

impl StockTrades {
    pub fn new(code: StockCode, venue: Venue) -> Self {
        StockTrades { stk_cd: kiwoom_stock_code(code, venue) }
    }
}

impl sealed::Sealed for StockTrades {}
impl MarketRequest for StockTrades {
    const API_ID: ApiId = ApiId::Ka10003;
    type Response = wire::StockTradesResponse;
}

const PROGRAM_QUANTITY: &str = "2";

/// ka90008. 호가처럼 통합 시세(`_AL`)로만 묻고, 날짜는 언제나 오늘이다.
#[derive(Serialize)]
pub struct StockProgramTrades {
    stk_cd: String,
    date: String,
    amt_qty_tp: &'static str,
}

impl StockProgramTrades {
    pub fn new(code: StockCode, today: KstDate) -> Self {
        StockProgramTrades { stk_cd: kiwoom_stock_code(code, Venue::Combined), date: today.yyyymmdd(), amt_qty_tp: PROGRAM_QUANTITY }
    }
}

impl sealed::Sealed for StockProgramTrades {}
impl MarketRequest for StockProgramTrades {
    const API_ID: ApiId = ApiId::Ka90008;
    type Response = wire::StockProgramTradesResponse;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RankMarket {
    All,
    Kospi,
    Kosdaq,
}

impl RankMarket {
    const fn code(self) -> &'static str {
        match self {
            RankMarket::All => "000",
            RankMarket::Kospi => "001",
            RankMarket::Kosdaq => "101",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListedMarket {
    Kospi,
    Kosdaq,
}

impl ListedMarket {
    const fn order_book_code(self) -> &'static str {
        match self {
            ListedMarket::Kospi => "001",
            ListedMarket::Kosdaq => "101",
        }
    }

    const fn program_code(self) -> &'static str {
        match self {
            ListedMarket::Kospi => "P00101",
            ListedMarket::Kosdaq => "P10102",
        }
    }

    const fn sector_code(self) -> &'static str {
        match self {
            ListedMarket::Kospi => "0",
            ListedMarket::Kosdaq => "1",
        }
    }

    pub const fn index_code(self) -> IndexCode {
        match self {
            ListedMarket::Kospi => IndexCode::KOSPI,
            ListedMarket::Kosdaq => IndexCode::KOSDAQ,
        }
    }
}

const fn exchange_code(venue: Venue) -> &'static str {
    match venue {
        Venue::Krx => "1",
        Venue::Nxt => "2",
        Venue::Combined => "3",
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ManagedIssues {
    Include,
    Exclude,
}

impl ManagedIssues {
    const fn condition(self) -> &'static str {
        match self {
            ManagedIssues::Include => "0",
            ManagedIssues::Exclude => "1",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LimitMoves {
    Include,
    Exclude,
}

impl LimitMoves {
    const fn code(self) -> &'static str {
        match self {
            LimitMoves::Include => "1",
            LimitMoves::Exclude => "0",
        }
    }
}

macro_rules! market_request {
    ($name:ident, $api:ident, $resp:ty) => {
        impl sealed::Sealed for $name {}
        impl MarketRequest for $name {
            const API_ID: ApiId = ApiId::$api;
            type Response = $resp;
        }
    };
}

#[derive(Serialize)]
pub struct TradeValueRanking {
    mrkt_tp: &'static str,
    mang_stk_incls: &'static str,
    stex_tp: &'static str,
}

impl TradeValueRanking {
    pub fn new(market: RankMarket, venue: Venue, managed: ManagedIssues) -> Self {
        let mang_stk_incls = match managed {
            ManagedIssues::Include => "1",
            ManagedIssues::Exclude => "0",
        };
        TradeValueRanking { mrkt_tp: market.code(), mang_stk_incls, stex_tp: exchange_code(venue) }
    }
}

market_request!(TradeValueRanking, Ka10032, wire::TradeValueRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VolumeOrder {
    Volume,
    Turnover,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TradingSession {
    All,
    Regular,
    PreMarket,
    AfterMarket,
}

impl TradingSession {
    const fn code(self) -> &'static str {
        match self {
            TradingSession::All => "0",
            TradingSession::Regular => "1",
            TradingSession::PreMarket => "2",
            TradingSession::AfterMarket => "3",
        }
    }
}

#[derive(Serialize)]
pub struct TradingVolumeRanking {
    mrkt_tp: &'static str,
    sort_tp: &'static str,
    mang_stk_incls: &'static str,
    crd_tp: &'static str,
    trde_qty_tp: &'static str,
    pric_tp: &'static str,
    trde_prica_tp: &'static str,
    mrkt_open_tp: &'static str,
    stex_tp: &'static str,
}

impl TradingVolumeRanking {
    pub fn new(order: VolumeOrder, market: RankMarket, venue: Venue, session: TradingSession, managed: ManagedIssues) -> Self {
        let sort_tp = match order {
            VolumeOrder::Volume => "1",
            VolumeOrder::Turnover => "2",
        };
        let mang_stk_incls = match managed {
            ManagedIssues::Include => "0",
            ManagedIssues::Exclude => "1",
        };
        TradingVolumeRanking {
            mrkt_tp: market.code(),
            sort_tp,
            mang_stk_incls,
            crd_tp: "0",
            trde_qty_tp: "0",
            pric_tp: "0",
            trde_prica_tp: "0",
            mrkt_open_tp: session.code(),
            stex_tp: exchange_code(venue),
        }
    }
}

market_request!(TradingVolumeRanking, Ka10030, wire::TradingVolumeRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SurgeBaseline {
    PreviousDay,
    OneMinute,
    FiveMinutes,
    TenMinutes,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SurgeOrder {
    Volume,
    Rate,
    DropRate,
}

#[derive(Serialize)]
pub struct VolumeSurgeRanking {
    mrkt_tp: &'static str,
    sort_tp: &'static str,
    tm_tp: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tm: Option<&'static str>,
    trde_qty_tp: &'static str,
    stk_cnd: &'static str,
    pric_tp: &'static str,
    stex_tp: &'static str,
}

impl VolumeSurgeRanking {
    pub fn new(market: RankMarket, venue: Venue, baseline: SurgeBaseline, order: SurgeOrder, managed: ManagedIssues) -> Self {
        let (tm_tp, tm) = match baseline {
            SurgeBaseline::PreviousDay => ("2", None),
            SurgeBaseline::OneMinute => ("1", Some("1")),
            SurgeBaseline::FiveMinutes => ("1", Some("5")),
            SurgeBaseline::TenMinutes => ("1", Some("10")),
        };
        let sort_tp = match order {
            SurgeOrder::Volume => "1",
            SurgeOrder::Rate => "2",
            SurgeOrder::DropRate => "4",
        };
        VolumeSurgeRanking {
            mrkt_tp: market.code(),
            sort_tp,
            tm_tp,
            tm,
            trde_qty_tp: "5",
            stk_cnd: managed.condition(),
            pric_tp: "0",
            stex_tp: exchange_code(venue),
        }
    }
}

market_request!(VolumeSurgeRanking, Ka10023, wire::VolumeSurgeRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PriceDirection {
    Rising,
    Falling,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MinimumTradeValue {
    Any,
    OneHundredMillion,
    OneBillion,
    TenBillion,
}

impl MinimumTradeValue {
    const fn code(self) -> &'static str {
        match self {
            MinimumTradeValue::Any => "0",
            MinimumTradeValue::OneHundredMillion => "10",
            MinimumTradeValue::OneBillion => "100",
            MinimumTradeValue::TenBillion => "1000",
        }
    }
}

#[derive(Serialize)]
pub struct PriceChangeRanking {
    mrkt_tp: &'static str,
    sort_tp: &'static str,
    trde_qty_cnd: &'static str,
    stk_cnd: &'static str,
    crd_cnd: &'static str,
    updown_incls: &'static str,
    pric_cnd: &'static str,
    trde_prica_cnd: &'static str,
    stex_tp: &'static str,
}

impl PriceChangeRanking {
    pub fn new(direction: PriceDirection, market: RankMarket, venue: Venue, limit_moves: LimitMoves, minimum_value: MinimumTradeValue, managed: ManagedIssues) -> Self {
        let sort_tp = match direction {
            PriceDirection::Rising => "1",
            PriceDirection::Falling => "3",
        };
        PriceChangeRanking {
            mrkt_tp: market.code(),
            sort_tp,
            trde_qty_cnd: "0000",
            stk_cnd: managed.condition(),
            crd_cnd: "0",
            updown_incls: limit_moves.code(),
            pric_cnd: "0",
            trde_prica_cnd: minimum_value.code(),
            stex_tp: exchange_code(venue),
        }
    }
}

market_request!(PriceChangeRanking, Ka10027, wire::PriceChangeRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExpectedOrder {
    Rising,
    Falling,
}

#[derive(Serialize)]
pub struct ExpectedExecutionRanking {
    mrkt_tp: &'static str,
    sort_tp: &'static str,
    trde_qty_cnd: &'static str,
    stk_cnd: &'static str,
    crd_cnd: &'static str,
    pric_cnd: &'static str,
    stex_tp: &'static str,
}

impl ExpectedExecutionRanking {
    pub fn new(order: ExpectedOrder, market: RankMarket, venue: Venue, managed: ManagedIssues) -> Self {
        let sort_tp = match order {
            ExpectedOrder::Rising => "1",
            ExpectedOrder::Falling => "4",
        };
        ExpectedExecutionRanking {
            mrkt_tp: market.code(),
            sort_tp,
            trde_qty_cnd: "0",
            stk_cnd: managed.condition(),
            crd_cnd: "0",
            pric_cnd: "0",
            stex_tp: exchange_code(venue),
        }
    }
}

market_request!(ExpectedExecutionRanking, Ka10029, wire::ExpectedExecutionRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InvestorGroup {
    Foreigner,
    ForeignFirm,
    FinancialInvestment,
    InvestmentTrust,
    OtherFinance,
    Bank,
    Insurance,
    Pension,
    State,
    OtherCorporation,
    Institution,
}

impl InvestorGroup {
    const fn code(self) -> &'static str {
        match self {
            InvestorGroup::Foreigner => "9000",
            InvestorGroup::ForeignFirm => "9100",
            InvestorGroup::FinancialInvestment => "1000",
            InvestorGroup::InvestmentTrust => "3000",
            InvestorGroup::OtherFinance => "5000",
            InvestorGroup::Bank => "4000",
            InvestorGroup::Insurance => "2000",
            InvestorGroup::Pension => "6000",
            InvestorGroup::State => "7000",
            InvestorGroup::OtherCorporation => "7100",
            InvestorGroup::Institution => "9999",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NetSide {
    Buying,
    Selling,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InvestorUnit {
    Amount,
    Quantity,
}

#[derive(Serialize)]
pub struct InvestorNetRanking {
    trde_tp: &'static str,
    mrkt_tp: &'static str,
    orgn_tp: &'static str,
    amt_qty_tp: &'static str,
}

impl InvestorNetRanking {
    pub fn new(investor: InvestorGroup, side: NetSide, unit: InvestorUnit, market: RankMarket) -> Self {
        let trde_tp = match side {
            NetSide::Buying => "1",
            NetSide::Selling => "2",
        };
        let amt_qty_tp = match unit {
            InvestorUnit::Amount => "1",
            InvestorUnit::Quantity => "2",
        };
        InvestorNetRanking { trde_tp, mrkt_tp: market.code(), orgn_tp: investor.code(), amt_qty_tp }
    }
}

market_request!(InvestorNetRanking, Ka10065, wire::InvestorNetRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StreakSide {
    Buying,
    Selling,
}

#[derive(Serialize)]
pub struct ForeignStreakRanking {
    mrkt_tp: &'static str,
    trde_tp: &'static str,
    base_dt_tp: &'static str,
    stex_tp: &'static str,
}

impl ForeignStreakRanking {
    pub fn new(side: StreakSide, market: RankMarket, venue: Venue) -> Self {
        let trde_tp = match side {
            StreakSide::Buying => "2",
            StreakSide::Selling => "1",
        };
        ForeignStreakRanking { mrkt_tp: market.code(), trde_tp, base_dt_tp: "0", stex_tp: exchange_code(venue) }
    }
}

market_request!(ForeignStreakRanking, Ka10035, wire::ForeignStreakRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProgramSide {
    NetBuying,
    NetSelling,
}

#[derive(Serialize)]
pub struct ProgramNetRanking {
    trde_upper_tp: &'static str,
    amt_qty_tp: &'static str,
    mrkt_tp: &'static str,
    stex_tp: &'static str,
}

impl ProgramNetRanking {
    pub fn new(side: ProgramSide, market: ListedMarket, venue: Venue) -> Self {
        let trde_upper_tp = match side {
            ProgramSide::NetBuying => "2",
            ProgramSide::NetSelling => "1",
        };
        ProgramNetRanking { trde_upper_tp, amt_qty_tp: "1", mrkt_tp: market.program_code(), stex_tp: exchange_code(venue) }
    }
}

market_request!(ProgramNetRanking, Ka90003, wire::ProgramNetRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BalanceOrder {
    NetBuyBalance,
    NetSellBalance,
    BuyRatio,
    SellRatio,
}

#[derive(Serialize)]
pub struct OrderBookBalanceRanking {
    mrkt_tp: &'static str,
    sort_tp: &'static str,
    trde_qty_tp: &'static str,
    stk_cnd: &'static str,
    crd_cnd: &'static str,
    stex_tp: &'static str,
}

impl OrderBookBalanceRanking {
    pub fn new(order: BalanceOrder, market: ListedMarket, venue: Venue, managed: ManagedIssues) -> Self {
        let sort_tp = match order {
            BalanceOrder::NetBuyBalance => "1",
            BalanceOrder::NetSellBalance => "2",
            BalanceOrder::BuyRatio => "3",
            BalanceOrder::SellRatio => "4",
        };
        OrderBookBalanceRanking {
            mrkt_tp: market.order_book_code(),
            sort_tp,
            trde_qty_tp: "0000",
            stk_cnd: managed.condition(),
            crd_cnd: "0",
            stex_tp: exchange_code(venue),
        }
    }
}

market_request!(OrderBookBalanceRanking, Ka10020, wire::OrderBookBalanceRankingResponse);

#[derive(Serialize)]
pub struct CreditRatioRanking {
    mrkt_tp: &'static str,
    trde_qty_tp: &'static str,
    stk_cnd: &'static str,
    updown_incls: &'static str,
    crd_cnd: &'static str,
    stex_tp: &'static str,
}

impl CreditRatioRanking {
    pub fn new(market: RankMarket, venue: Venue, managed: ManagedIssues) -> Self {
        CreditRatioRanking {
            mrkt_tp: market.code(),
            trde_qty_tp: "0",
            stk_cnd: managed.condition(),
            updown_incls: LimitMoves::Include.code(),
            crd_cnd: "0",
            stex_tp: exchange_code(venue),
        }
    }
}

market_request!(CreditRatioRanking, Ka10033, wire::CreditRatioRankingResponse);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ViewWindow {
    ThirtySeconds,
    OneMinute,
    TenMinutes,
    OneHour,
    Today,
}

#[derive(Serialize)]
pub struct MostViewedRanking {
    qry_tp: &'static str,
}

impl MostViewedRanking {
    pub fn new(window: ViewWindow) -> Self {
        let qry_tp = match window {
            ViewWindow::ThirtySeconds => "5",
            ViewWindow::OneMinute => "1",
            ViewWindow::TenMinutes => "2",
            ViewWindow::OneHour => "3",
            ViewWindow::Today => "4",
        };
        MostViewedRanking { qry_tp }
    }
}

market_request!(MostViewedRanking, Ka00198, wire::MostViewedRankingResponse);

#[derive(Serialize)]
pub struct AllIndices {
    mrkt_tp: &'static str,
    inds_cd: String,
}

impl AllIndices {
    pub fn new(market: ListedMarket) -> Self {
        AllIndices { mrkt_tp: market.sector_code(), inds_cd: market.index_code().as_str().to_owned() }
    }
}

market_request!(AllIndices, Ka20003, wire::AllIndicesResponse);

const SECTOR_NET_AMOUNT: &str = "0";

#[derive(Serialize)]
pub struct SectorInvestorNet {
    mrkt_tp: &'static str,
    amt_qty_tp: &'static str,
    base_dt: String,
    stex_tp: &'static str,
}

impl SectorInvestorNet {
    pub fn new(market: ListedMarket, day: KstDate) -> Self {
        SectorInvestorNet { mrkt_tp: market.sector_code(), amt_qty_tp: SECTOR_NET_AMOUNT, base_dt: day.yyyymmdd(), stex_tp: exchange_code(Venue::Combined) }
    }
}

market_request!(SectorInvestorNet, Ka10051, wire::SectorInvestorNetResponse);

const PROGRAM_AMOUNT: &str = "1";

#[derive(Serialize)]
struct ProgramTrendBody {
    date: String,
    amt_qty_tp: &'static str,
    mrkt_tp: &'static str,
    min_tic_tp: &'static str,
    stex_tp: &'static str,
}

impl ProgramTrendBody {
    fn new(market: ListedMarket, day: KstDate, min_tic_tp: &'static str) -> Self {
        ProgramTrendBody { date: day.yyyymmdd(), amt_qty_tp: PROGRAM_AMOUNT, mrkt_tp: market.program_code(), min_tic_tp, stex_tp: exchange_code(Venue::Combined) }
    }
}

#[derive(Serialize)]
pub struct ProgramTrendByMinute(ProgramTrendBody);

impl ProgramTrendByMinute {
    pub fn new(market: ListedMarket, today: KstDate) -> Self {
        ProgramTrendByMinute(ProgramTrendBody::new(market, today, "0"))
    }
}

market_request!(ProgramTrendByMinute, Ka90005, wire::ProgramTrendByMinuteResponse);

#[derive(Serialize)]
pub struct ProgramTrendByDay(ProgramTrendBody);

impl ProgramTrendByDay {
    pub fn new(market: ListedMarket, today: KstDate) -> Self {
        ProgramTrendByDay(ProgramTrendBody::new(market, today, "1"))
    }
}

market_request!(ProgramTrendByDay, Ka90010, wire::ProgramTrendByDayResponse);

#[derive(Serialize)]
pub struct InstitutionForeignStreak {
    dt: &'static str,
    mrkt_tp: &'static str,
    netslmt_tp: &'static str,
    stk_inds_tp: &'static str,
    amt_qty_tp: &'static str,
    stex_tp: &'static str,
}

impl InstitutionForeignStreak {
    pub fn new(side: StreakSide, market: ListedMarket) -> Self {
        let netslmt_tp = match side {
            StreakSide::Buying => "2",
            StreakSide::Selling => "1",
        };
        InstitutionForeignStreak { dt: "1", mrkt_tp: market.order_book_code(), netslmt_tp, stk_inds_tp: "0", amt_qty_tp: "0", stex_tp: exchange_code(Venue::Combined) }
    }
}

market_request!(InstitutionForeignStreak, Ka10131, wire::InstitutionForeignStreakResponse);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn today() -> KstDate {
        KstDate::new(2026, 11, 9).unwrap()
    }

    #[test]
    fn request_bodies_match_the_probed_shape() {
        let c = StockCode::parse("005930").unwrap();
        assert_eq!(
            serde_json::to_value(DailyChart::new(c, Venue::Combined, today())).unwrap(),
            json!({"stk_cd": "005930_AL", "base_dt": "20261109", "upd_stkpc_tp": "1"})
        );
        assert_eq!(serde_json::to_value(MonthlyChart::new(c, Venue::Krx, today())).unwrap()["stk_cd"], "005930");
        assert_eq!(serde_json::to_value(WeeklyChart::new(c, Venue::Nxt, today())).unwrap()["stk_cd"], "005930_NX");
        assert_eq!(
            serde_json::to_value(IndexWeeklyChart::new(IndexCode::KOSDAQ, today())).unwrap(),
            json!({"inds_cd": "101", "base_dt": "20261109"})
        );
        assert_eq!(serde_json::to_value(StockList::KOSDAQ).unwrap(), json!({"mrkt_tp": "10"}));
    }

    #[test]
    fn minute_bodies_take_tic_scope_from_the_period_and_a_past_base_dt() {
        let c = StockCode::parse("005930").unwrap();
        let past = KstDate::new(2026, 6, 1).unwrap();
        assert_eq!(
            serde_json::to_value(MinuteChart::new(c, Venue::Nxt, Period::M15, past).unwrap()).unwrap(),
            json!({"stk_cd": "005930_NX", "tic_scope": "15", "upd_stkpc_tp": "1", "base_dt": "20260601"})
        );
        let scopes: Vec<_> = Period::ALL
            .into_iter()
            .filter_map(|p| MinuteChart::new(c, Venue::Krx, p, today()))
            .map(|r| serde_json::to_value(r).unwrap()["tic_scope"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(scopes, ["1", "3", "5", "10", "15", "30", "60"]);
        assert_eq!(
            serde_json::to_value(IndexMinuteChart::new(IndexCode::KOSPI, Period::M1, today()).unwrap()).unwrap(),
            json!({"inds_cd": "001", "tic_scope": "1", "base_dt": "20261109"})
        );
        assert!(IndexMinuteChart::new(IndexCode::KOSPI, Period::Day, today()).is_none());
        assert_eq!(<IndexMinuteChart as MarketRequest>::API_ID.as_str(), "ka20005");
    }

    #[test]
    fn quote_body_joins_codes_of_one_venue_and_caps_at_100() {
        let codes: Vec<StockCode> = ["005930", "000660"].iter().map(|c| StockCode::parse(c).unwrap()).collect();
        assert_eq!(serde_json::to_value(StockQuotes::new(&codes, Venue::Combined).unwrap()).unwrap(), json!({"stk_cd": "005930_AL|000660_AL"}));
        assert_eq!(serde_json::to_value(StockQuotes::new(&codes, Venue::Krx).unwrap()).unwrap(), json!({"stk_cd": "005930|000660"}));
        assert_eq!(<StockQuotes as MarketRequest>::API_ID.path(), "/api/dostk/stkinfo");
        let many = vec![codes[0]; 101];
        assert!(StockQuotes::new(&many[..100], Venue::Krx).is_some());
        assert!(StockQuotes::new(&many, Venue::Krx).is_none(), "101개는 1634로 거절된다");
        assert!(StockQuotes::new(&[], Venue::Combined).is_none());
        let mixed = StockQuotes::of_venues(&[(codes[0], Venue::Nxt), (codes[1], Venue::Combined), (codes[0], Venue::Krx)]).unwrap();
        assert_eq!(serde_json::to_value(mixed).unwrap(), json!({"stk_cd": "005930_NX|000660_AL|005930"}));
    }

    #[test]
    fn basic_info_body_asks_for_the_combined_code() {
        let c = StockCode::parse("005930").unwrap();
        assert_eq!(serde_json::to_value(StockBasicInfo::new(c)).unwrap(), json!({"stk_cd": "005930_AL"}));
        assert_eq!(<StockBasicInfo as MarketRequest>::API_ID.as_str(), "ka10001");
        assert_eq!(<StockBasicInfo as MarketRequest>::API_ID.path(), "/api/dostk/stkinfo");
    }

    #[test]
    fn investor_bodies_ask_for_krx_net_buying_in_single_shares_from_today() {
        let c = StockCode::parse("247540").unwrap();
        assert_eq!(serde_json::to_value(StockForeignHoldings::new(c)).unwrap(), json!({"stk_cd": "247540"}));
        assert_eq!(
            serde_json::to_value(StockInvestorNetShares::new(c, today())).unwrap(),
            json!({"dt": "20261109", "stk_cd": "247540", "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"})
        );
        assert_eq!((<StockForeignHoldings as MarketRequest>::API_ID.as_str(), ApiId::Ka10008.path()), ("ka10008", "/api/dostk/frgnistt"));
        assert_eq!((<StockInvestorNetShares as MarketRequest>::API_ID.as_str(), ApiId::Ka10059.path()), ("ka10059", "/api/dostk/stkinfo"));
    }

    #[test]
    fn feed_bodies_ask_for_the_book_by_venue_and_programs_and_todays_trades() {
        let c = StockCode::parse("005930").unwrap();
        assert_eq!(serde_json::to_value(StockOrderBook::new(c, Venue::Combined)).unwrap(), json!({"stk_cd": "005930_AL"}));
        assert_eq!(serde_json::to_value(StockOrderBook::new(c, Venue::Krx)).unwrap(), json!({"stk_cd": "005930"}));
        assert_eq!(serde_json::to_value(StockTrades::new(c, Venue::Nxt)).unwrap(), json!({"stk_cd": "005930_NX"}));
        assert_eq!(serde_json::to_value(StockProgramTrades::new(c, today())).unwrap(), json!({"stk_cd": "005930_AL", "date": "20261109", "amt_qty_tp": "2"}));
        assert_eq!((<StockOrderBook as MarketRequest>::API_ID.as_str(), ApiId::Ka10004.path()), ("ka10004", "/api/dostk/mrkcond"));
        assert_eq!((<StockTrades as MarketRequest>::API_ID.as_str(), ApiId::Ka10003.path()), ("ka10003", "/api/dostk/stkinfo"));
        assert_eq!((<StockProgramTrades as MarketRequest>::API_ID.as_str(), ApiId::Ka90008.path()), ("ka90008", "/api/dostk/mrkcond"));
    }

    #[test]
    fn api_ids_and_paths() {
        assert_eq!(<WeeklyChart as MarketRequest>::API_ID.as_str(), "ka10082");
        assert_eq!(<IndexMonthlyChart as MarketRequest>::API_ID.as_str(), "ka20008");
        assert_eq!(ApiId::Au10001.path(), "/oauth2/token");
        assert_eq!(ApiId::Ka10099.path(), "/api/dostk/stkinfo");
        assert_eq!(ApiId::Ka20007.path(), "/api/dostk/chart");
    }

    fn body(request: impl Serialize) -> serde_json::Value {
        serde_json::to_value(request).unwrap()
    }

    #[test]
    fn ranking_paths_follow_the_tr_family() {
        let rkinfo = [ApiId::Ka10032, ApiId::Ka10030, ApiId::Ka10023, ApiId::Ka10027, ApiId::Ka10029, ApiId::Ka10065, ApiId::Ka10035, ApiId::Ka10020, ApiId::Ka10033];
        assert!(rkinfo.iter().all(|id| id.path() == "/api/dostk/rkinfo"));
        assert_eq!(ApiId::Ka90003.path(), "/api/dostk/stkinfo");
        assert_eq!(ApiId::Ka00198.path(), "/api/dostk/stkinfo");
        let names: Vec<_> = rkinfo.iter().chain([ApiId::Ka90003, ApiId::Ka00198].iter()).map(|id| id.as_str()).collect();
        assert_eq!(names, ["ka10032", "ka10030", "ka10023", "ka10027", "ka10029", "ka10065", "ka10035", "ka10020", "ka10033", "ka90003", "ka00198"]);
        assert_eq!(<TradeValueRanking as MarketRequest>::API_ID, ApiId::Ka10032);
        assert_eq!(<MostViewedRanking as MarketRequest>::API_ID, ApiId::Ka00198);
        assert_eq!(<ProgramNetRanking as MarketRequest>::API_ID, ApiId::Ka90003);
    }

    #[test]
    fn trade_value_and_trading_volume_send_opposite_managed_issue_codes() {
        assert_eq!(
            body(TradeValueRanking::new(RankMarket::All, Venue::Combined, ManagedIssues::Exclude)),
            json!({"mrkt_tp": "000", "mang_stk_incls": "0", "stex_tp": "3"})
        );
        assert_eq!(body(TradeValueRanking::new(RankMarket::Kospi, Venue::Krx, ManagedIssues::Include))["mang_stk_incls"], "1");
        assert_eq!(
            body(TradingVolumeRanking::new(VolumeOrder::Volume, RankMarket::Kosdaq, Venue::Nxt, TradingSession::Regular, ManagedIssues::Exclude)),
            json!({"mrkt_tp": "101", "sort_tp": "1", "mang_stk_incls": "1", "crd_tp": "0", "trde_qty_tp": "0", "pric_tp": "0", "trde_prica_tp": "0", "mrkt_open_tp": "1", "stex_tp": "2"})
        );
        assert_eq!(body(TradingVolumeRanking::new(VolumeOrder::Turnover, RankMarket::All, Venue::Krx, TradingSession::All, ManagedIssues::Include))["sort_tp"], "2");
        assert_eq!(body(TradingVolumeRanking::new(VolumeOrder::Turnover, RankMarket::All, Venue::Krx, TradingSession::All, ManagedIssues::Include))["mang_stk_incls"], "0");
        let sessions: Vec<_> = [TradingSession::All, TradingSession::Regular, TradingSession::PreMarket, TradingSession::AfterMarket]
            .map(|s| body(TradingVolumeRanking::new(VolumeOrder::Volume, RankMarket::All, Venue::Krx, s, ManagedIssues::Include))["mrkt_open_tp"].as_str().unwrap().to_owned())
            .into();
        assert_eq!(sessions, ["0", "1", "2", "3"]);
    }

    #[test]
    fn volume_surge_baseline_is_previous_day_or_minutes() {
        assert_eq!(
            body(VolumeSurgeRanking::new(RankMarket::All, Venue::Krx, SurgeBaseline::PreviousDay, SurgeOrder::Rate, ManagedIssues::Include)),
            json!({"mrkt_tp": "000", "sort_tp": "2", "tm_tp": "2", "trde_qty_tp": "5", "stk_cnd": "0", "pric_tp": "0", "stex_tp": "1"})
        );
        assert_eq!(
            body(VolumeSurgeRanking::new(RankMarket::Kospi, Venue::Combined, SurgeBaseline::FiveMinutes, SurgeOrder::Volume, ManagedIssues::Exclude)),
            json!({"mrkt_tp": "001", "sort_tp": "1", "tm_tp": "1", "tm": "5", "trde_qty_tp": "5", "stk_cnd": "1", "pric_tp": "0", "stex_tp": "3"})
        );
        let minutes: Vec<_> = [SurgeBaseline::OneMinute, SurgeBaseline::FiveMinutes, SurgeBaseline::TenMinutes]
            .map(|b| body(VolumeSurgeRanking::new(RankMarket::All, Venue::Krx, b, SurgeOrder::DropRate, ManagedIssues::Include))["tm"].as_str().unwrap().to_owned())
            .into();
        assert_eq!(minutes, ["1", "5", "10"]);
        assert_eq!(body(VolumeSurgeRanking::new(RankMarket::All, Venue::Krx, SurgeBaseline::OneMinute, SurgeOrder::DropRate, ManagedIssues::Include))["sort_tp"], "4");
    }

    #[test]
    fn price_change_and_expected_execution_bodies() {
        assert_eq!(
            body(PriceChangeRanking::new(PriceDirection::Rising, RankMarket::All, Venue::Krx, LimitMoves::Include, MinimumTradeValue::Any, ManagedIssues::Exclude)),
            json!({"mrkt_tp": "000", "sort_tp": "1", "trde_qty_cnd": "0000", "stk_cnd": "1", "crd_cnd": "0", "updown_incls": "1", "pric_cnd": "0", "trde_prica_cnd": "0", "stex_tp": "1"})
        );
        let falling = body(PriceChangeRanking::new(PriceDirection::Falling, RankMarket::Kosdaq, Venue::Nxt, LimitMoves::Exclude, MinimumTradeValue::TenBillion, ManagedIssues::Include));
        assert_eq!((falling["sort_tp"].as_str(), falling["updown_incls"].as_str(), falling["trde_prica_cnd"].as_str(), falling["stk_cnd"].as_str()), (Some("3"), Some("0"), Some("1000"), Some("0")));
        let floors: Vec<_> = [MinimumTradeValue::OneHundredMillion, MinimumTradeValue::OneBillion]
            .map(|m| body(PriceChangeRanking::new(PriceDirection::Rising, RankMarket::All, Venue::Krx, LimitMoves::Include, m, ManagedIssues::Include))["trde_prica_cnd"].as_str().unwrap().to_owned())
            .into();
        assert_eq!(floors, ["10", "100"]);
        assert_eq!(
            body(ExpectedExecutionRanking::new(ExpectedOrder::Falling, RankMarket::Kospi, Venue::Combined, ManagedIssues::Exclude)),
            json!({"mrkt_tp": "001", "sort_tp": "4", "trde_qty_cnd": "0", "stk_cnd": "1", "crd_cnd": "0", "pric_cnd": "0", "stex_tp": "3"})
        );
        assert_eq!(body(ExpectedExecutionRanking::new(ExpectedOrder::Rising, RankMarket::All, Venue::Krx, ManagedIssues::Include))["sort_tp"], "1");
    }

    #[test]
    fn investor_net_body_has_no_exchange_and_maps_every_investor_group() {
        assert_eq!(
            body(InvestorNetRanking::new(InvestorGroup::Foreigner, NetSide::Buying, InvestorUnit::Amount, RankMarket::All)),
            json!({"trde_tp": "1", "mrkt_tp": "000", "orgn_tp": "9000", "amt_qty_tp": "1"})
        );
        assert_eq!(body(InvestorNetRanking::new(InvestorGroup::Pension, NetSide::Selling, InvestorUnit::Quantity, RankMarket::Kosdaq)), json!({"trde_tp": "2", "mrkt_tp": "101", "orgn_tp": "6000", "amt_qty_tp": "2"}));
        let groups = [
            InvestorGroup::Foreigner,
            InvestorGroup::ForeignFirm,
            InvestorGroup::FinancialInvestment,
            InvestorGroup::InvestmentTrust,
            InvestorGroup::OtherFinance,
            InvestorGroup::Bank,
            InvestorGroup::Insurance,
            InvestorGroup::Pension,
            InvestorGroup::State,
            InvestorGroup::OtherCorporation,
            InvestorGroup::Institution,
        ];
        let codes: Vec<_> = groups.map(|g| body(InvestorNetRanking::new(g, NetSide::Buying, InvestorUnit::Amount, RankMarket::All))["orgn_tp"].as_str().unwrap().to_owned()).into();
        assert_eq!(codes, ["9000", "9100", "1000", "3000", "5000", "4000", "2000", "6000", "7000", "7100", "9999"]);
    }

    #[test]
    fn foreign_streak_and_program_bodies() {
        assert_eq!(
            body(ForeignStreakRanking::new(StreakSide::Buying, RankMarket::Kospi, Venue::Krx)),
            json!({"mrkt_tp": "001", "trde_tp": "2", "base_dt_tp": "0", "stex_tp": "1"})
        );
        assert_eq!(body(ForeignStreakRanking::new(StreakSide::Selling, RankMarket::All, Venue::Combined))["trde_tp"], "1");
        assert_eq!(
            body(ProgramNetRanking::new(ProgramSide::NetBuying, ListedMarket::Kosdaq, Venue::Combined)),
            json!({"trde_upper_tp": "2", "amt_qty_tp": "1", "mrkt_tp": "P10102", "stex_tp": "3"})
        );
        let kospi = body(ProgramNetRanking::new(ProgramSide::NetSelling, ListedMarket::Kospi, Venue::Nxt));
        assert_eq!((kospi["trde_upper_tp"].as_str(), kospi["mrkt_tp"].as_str(), kospi["stex_tp"].as_str()), (Some("1"), Some("P00101"), Some("2")));
    }

    #[test]
    fn market_overview_bodies_use_each_trs_own_market_codes() {
        assert_eq!(body(AllIndices::new(ListedMarket::Kospi)), json!({"mrkt_tp": "0", "inds_cd": "001"}));
        assert_eq!(body(AllIndices::new(ListedMarket::Kosdaq)), json!({"mrkt_tp": "1", "inds_cd": "101"}));
        assert_eq!(body(SectorInvestorNet::new(ListedMarket::Kosdaq, today())), json!({"mrkt_tp": "1", "amt_qty_tp": "0", "base_dt": "20261109", "stex_tp": "3"}));
        assert_eq!(body(ProgramTrendByMinute::new(ListedMarket::Kospi, today())), json!({"date": "20261109", "amt_qty_tp": "1", "mrkt_tp": "P00101", "min_tic_tp": "0", "stex_tp": "3"}));
        assert_eq!(body(ProgramTrendByDay::new(ListedMarket::Kosdaq, today())), json!({"date": "20261109", "amt_qty_tp": "1", "mrkt_tp": "P10102", "min_tic_tp": "1", "stex_tp": "3"}));
        assert_eq!(
            body(InstitutionForeignStreak::new(StreakSide::Selling, ListedMarket::Kosdaq)),
            json!({"dt": "1", "mrkt_tp": "101", "netslmt_tp": "1", "stk_inds_tp": "0", "amt_qty_tp": "0", "stex_tp": "3"})
        );
    }

    #[test]
    fn order_book_credit_and_most_viewed_bodies() {
        assert_eq!(
            body(OrderBookBalanceRanking::new(BalanceOrder::NetBuyBalance, ListedMarket::Kospi, Venue::Krx, ManagedIssues::Exclude)),
            json!({"mrkt_tp": "001", "sort_tp": "1", "trde_qty_tp": "0000", "stk_cnd": "1", "crd_cnd": "0", "stex_tp": "1"})
        );
        let orders: Vec<_> = [BalanceOrder::NetBuyBalance, BalanceOrder::NetSellBalance, BalanceOrder::BuyRatio, BalanceOrder::SellRatio]
            .map(|o| body(OrderBookBalanceRanking::new(o, ListedMarket::Kosdaq, Venue::Krx, ManagedIssues::Include))["sort_tp"].as_str().unwrap().to_owned())
            .into();
        assert_eq!(orders, ["1", "2", "3", "4"]);
        assert_eq!(body(OrderBookBalanceRanking::new(BalanceOrder::BuyRatio, ListedMarket::Kosdaq, Venue::Nxt, ManagedIssues::Include))["mrkt_tp"], "101");
        assert_eq!(
            body(CreditRatioRanking::new(RankMarket::All, Venue::Combined, ManagedIssues::Exclude)),
            json!({"mrkt_tp": "000", "trde_qty_tp": "0", "stk_cnd": "1", "updown_incls": "1", "crd_cnd": "0", "stex_tp": "3"})
        );
        let windows: Vec<_> = [ViewWindow::ThirtySeconds, ViewWindow::OneMinute, ViewWindow::TenMinutes, ViewWindow::OneHour, ViewWindow::Today]
            .map(|w| body(MostViewedRanking::new(w))["qry_tp"].as_str().unwrap().to_owned())
            .into();
        assert_eq!(windows, ["5", "1", "2", "3", "4"]);
        assert_eq!(body(MostViewedRanking::new(ViewWindow::Today)), json!({"qry_tp": "4"}));
    }
}
