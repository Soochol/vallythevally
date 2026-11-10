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
    /// 업종 분봉
    Ka20005,
    /// 업종 일봉
    Ka20006,
    /// 업종 주봉
    Ka20007,
    /// 업종 월봉
    Ka20008,
}

impl ApiId {
    pub const fn path(self) -> &'static str {
        match self {
            ApiId::Au10001 => "/oauth2/token",
            ApiId::Ka10099 | ApiId::Ka10100 | ApiId::Ka10095 | ApiId::Ka10001 => "/api/dostk/stkinfo",
            ApiId::Ka10080
            | ApiId::Ka10081
            | ApiId::Ka10082
            | ApiId::Ka10083
            | ApiId::Ka20005
            | ApiId::Ka20006
            | ApiId::Ka20007
            | ApiId::Ka20008 => "/api/dostk/chart",
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
            ApiId::Ka20005 => "ka20005",
            ApiId::Ka20006 => "ka20006",
            ApiId::Ka20007 => "ka20007",
            ApiId::Ka20008 => "ka20008",
        }
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
index_chart!(IndexDailyChart, Ka20006, wire::IndexDailyChartResponse);
index_chart!(IndexWeeklyChart, Ka20007, wire::IndexWeeklyChartResponse);
index_chart!(IndexMonthlyChart, Ka20008, wire::IndexMonthlyChartResponse);

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

/// "1", "3", "5", "15", "30", "60".
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
        assert_eq!(scopes, ["1", "3", "5", "15", "30", "60"]);
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
    }

    #[test]
    fn basic_info_body_asks_for_the_combined_code() {
        let c = StockCode::parse("005930").unwrap();
        assert_eq!(serde_json::to_value(StockBasicInfo::new(c)).unwrap(), json!({"stk_cd": "005930_AL"}));
        assert_eq!(<StockBasicInfo as MarketRequest>::API_ID.as_str(), "ka10001");
        assert_eq!(<StockBasicInfo as MarketRequest>::API_ID.path(), "/api/dostk/stkinfo");
    }

    #[test]
    fn api_ids_and_paths() {
        assert_eq!(<WeeklyChart as MarketRequest>::API_ID.as_str(), "ka10082");
        assert_eq!(<IndexMonthlyChart as MarketRequest>::API_ID.as_str(), "ka20008");
        assert_eq!(ApiId::Au10001.path(), "/oauth2/token");
        assert_eq!(ApiId::Ka10099.path(), "/api/dostk/stkinfo");
        assert_eq!(ApiId::Ka20007.path(), "/api/dostk/chart");
    }
}
