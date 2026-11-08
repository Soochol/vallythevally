//! 시세 API만 허용(backend.md §4.4). 이 enum에 없는 api-id와 경로는 보낼 수 없다.

use domain::{IndexCode, KstDate, StockCode};
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
            ApiId::Ka10099 | ApiId::Ka10100 | ApiId::Ka10095 => "/api/dostk/stkinfo",
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
}

/// 주식 시세는 언제나 통합 시세(`_AL`)로 받는다. 키움 종목코드는 이 함수로만 만든다.
pub fn kiwoom_stock_code(code: StockCode) -> String {
    format!("{}_AL", code.as_str())
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
            pub fn new(code: StockCode, today: KstDate) -> Self {
                $name { stk_cd: kiwoom_stock_code(code), base_dt: today.yyyymmdd(), upd_stkpc_tp: ADJUSTED_PRICE }
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
            serde_json::to_value(DailyChart::new(c, today())).unwrap(),
            json!({"stk_cd": "005930_AL", "base_dt": "20261109", "upd_stkpc_tp": "1"})
        );
        assert_eq!(serde_json::to_value(MonthlyChart::new(c, today())).unwrap()["stk_cd"], "005930_AL");
        assert_eq!(
            serde_json::to_value(IndexWeeklyChart::new(IndexCode::KOSDAQ, today())).unwrap(),
            json!({"inds_cd": "101", "base_dt": "20261109"})
        );
        assert_eq!(serde_json::to_value(StockList::KOSDAQ).unwrap(), json!({"mrkt_tp": "10"}));
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
