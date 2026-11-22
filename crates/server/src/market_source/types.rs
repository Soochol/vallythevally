use std::num::NonZeroU64;

use domain::{Bucket, KstDate, KstTime, Ohlcv, StockCode, Venue, Volume};

use crate::api::{self, ExcludeKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    Order,
    /// 브라우저가 기다리는 요청: 봉 페이지, 서버를 켤 때의 종목 목록.
    Screen,
    ScreenBulk,
    /// 끊긴 구간 복구 같은 것(#4). #2에는 부르는 곳이 없다.
    Recovery,
    /// 07:45 종목 목록 갱신 같은 것. 앞의 둘이 비었을 때만 나간다.
    Background,
}

/// 같은 요청 합치기의 범위. 범위가 다르면 내용이 같아도 합치지 않고 따로 보낸다.
/// `BarService`는 07:45 비우기마다 범위를 바꿔, 비우기 전 조회의 응답이 새 캐시에 들어가지 않게 한다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum MergeScope {
    #[default]
    Shared,
    Bars(u64),
    Summary(u64),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Cursor(String);

impl Cursor {
    pub fn new(s: impl Into<String>) -> Self {
        Cursor(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 공급원에서 받은 봉. 가장 늦은 봉은 진행 중인 구간일 수 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeriodBar {
    pub bucket: Bucket,
    pub ohlcv: Ohlcv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartPage {
    /// 오름차순.
    pub bars: Vec<PeriodBar>,
    pub next: Option<Cursor>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TapePage<T> {
    pub rows: Vec<T>,
    pub skipped: u32,
    pub next: Option<Cursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StockFundamentals {
    pub market_cap_won: Option<u64>,
    pub listed_shares: Option<u64>,
    pub per: Option<f64>,
    pub pbr: Option<f64>,
    pub roe_pct: Option<f64>,
    pub eps_won: Option<i64>,
    pub bps_won: Option<i64>,
    pub foreign_exhaustion_pct: Option<f64>,
    pub high_250_won: Option<u64>,
    pub low_250_won: Option<u64>,
    pub upper_limit_won: Option<u64>,
    pub lower_limit_won: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuoteRow {
    pub code: StockCode,
    pub venue: Venue,
    pub price_centi: u64,
    pub base_centi: u64,
    pub volume: Volume,
    /// 당일 누적 거래대금, 백만원. 없거나 읽지 못하면 None.
    pub traded_million_won: Option<u64>,
    pub at: KstTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DaySummary {
    pub price_won: Option<u64>,
    pub base_won: Option<u64>,
    pub open_won: Option<u64>,
    pub high_won: Option<u64>,
    pub low_won: Option<u64>,
    pub volume: Option<u64>,
    pub trade_value_won: Option<u64>,
    pub at: Option<KstTime>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderBookSnapshot {
    pub asks: Vec<api::OrderBookLevel>,
    pub bids: Vec<api::OrderBookLevel>,
    pub total_ask_quantity: u64,
    pub total_bid_quantity: u64,
    pub after_hours_ask_quantity: Option<u64>,
    pub after_hours_bid_quantity: Option<u64>,
    pub book_time: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenerListing {
    pub code: StockCode,
    pub name: String,
    pub listed_on: Option<KstDate>,
    pub excludable_as: Vec<ExcludeKind>,
    pub market: api::Market,
    pub listed_shares: Option<NonZeroU64>,
}
