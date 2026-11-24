//! 키움 응답 → `domain` 타입(backend.md §4.6). 숫자는 모두 문자열로 오고, 가격 부호는 믿지 않는다.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::num::NonZeroU64;

use domain::{AuditStatus, IndexCode, KstDate, KstTime, ListingRow, Market, Ohlcv, Period, Price, StockCode, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Venue, Volume};
use serde::Deserialize;
use serde_json::{Value, json};

use super::api::{InvestorUnit, kiwoom_stock_code};
use crate::api::{self, ExcludeKind};
use super::error::{WsRejection, judge_ws_ack};
use crate::market_source::stream::{AfterHoursTotals, BOOK_DEPTH, BookLevel, BookSnapshot, BrokerEntry, BrokerSnapshot, DayTotals, Exchange, ExpectedQuote, ExpectedTrade, RealProgramTrade, RealTick, StreamKind, TradeSide};
use crate::config::Secret;
use crate::market_source::vi::{ViAlert, ViDirection, ViMarket};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError(pub String);

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WireError {}

/// 봉 행. 지수와 주식이 같은 필드 이름을 쓴다. 일·주·월봉은 `dt`, 분봉은 `cntr_tm`에 시각이 있다.
/// 명세에 없는 필드는 무시한다.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChartRow {
    pub dt: String,
    pub cntr_tm: String,
    pub open_pric: String,
    pub high_pric: String,
    pub low_pric: String,
    pub cur_prc: String,
    pub trde_qty: String,
    pub trde_prica: String,
}

/// 가격 배율이 TR 묶음마다 다르다. 그래서 공통 "자연 단위 → centi" 함수를 두지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceScale {
    /// ka10080/81/82/83: 원 단위 정수. 절댓값 × 100.
    StockWon,
    /// ka20005/06/07/08: 이미 100배 정수. 절댓값 그대로.
    IndexCenti,
}

/// 행의 시각이 어느 필드에 있나.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowTime {
    /// `dt`(`YYYYMMDD`). 주봉·월봉은 구간의 첫 관측일이다(§3.2).
    Date,
    /// `cntr_tm`(`YYYYMMDDHHMMSS`, KST). 구간이 시작하는 시각이다(kiwoom.md §1).
    DateTime,
}

pub trait ChartBody {
    const SCALE: PriceScale;
    const TIME: RowTime;
    fn into_rows(self) -> Vec<ChartRow>;
}

macro_rules! chart_body {
    ($name:ident, $field:ident, $scale:ident, $time:ident) => {
        #[derive(Debug, Deserialize)]
        pub struct $name {
            $field: Vec<ChartRow>,
        }
        impl ChartBody for $name {
            const SCALE: PriceScale = PriceScale::$scale;
            const TIME: RowTime = RowTime::$time;
            fn into_rows(self) -> Vec<ChartRow> {
                self.$field
            }
        }
    };
}

chart_body!(MinuteChartResponse, stk_min_pole_chart_qry, StockWon, DateTime);
chart_body!(DailyChartResponse, stk_dt_pole_chart_qry, StockWon, Date);
chart_body!(WeeklyChartResponse, stk_stk_pole_chart_qry, StockWon, Date);
chart_body!(MonthlyChartResponse, stk_mth_pole_chart_qry, StockWon, Date);
chart_body!(YearlyChartResponse, stk_yr_pole_chart_qry, StockWon, Date);
chart_body!(IndexMinuteChartResponse, inds_min_pole_qry, IndexCenti, DateTime);
chart_body!(IndexDailyChartResponse, inds_dt_pole_qry, IndexCenti, Date);
chart_body!(IndexWeeklyChartResponse, inds_stk_pole_qry, IndexCenti, Date);
chart_body!(IndexMonthlyChartResponse, inds_mth_pole_qry, IndexCenti, Date);
chart_body!(IndexYearlyChartResponse, inds_yr_pole_qry, IndexCenti, Date);

pub use crate::market_source::PeriodBar as KiwoomBar;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChartRows {
    /// 빈 행 하나: 없는 코드(kiwoom.md §9). NXT에서 거래되지 않는 종목의 `_NX`도 같은 모양이다(§12.4, §13).
    UnknownSymbol,
    /// 오름차순.
    Rows(Vec<KiwoomBar>),
}

/// 행은 최신순으로 온다. 결과는 오름차순이다.
pub fn parse_chart<B: ChartBody>(body: B, period: Period) -> Result<ChartRows, WireError> {
    let rows = body.into_rows();
    if rows.first().is_some_and(|r| r.dt.is_empty() && r.cntr_tm.is_empty()) {
        return Ok(ChartRows::UnknownSymbol);
    }
    let price = match B::SCALE {
        PriceScale::StockWon => stock_price,
        PriceScale::IndexCenti => index_price,
    };
    let mut bars = rows.iter().rev().map(|r| parse_row(r, B::TIME, period, price)).collect::<Result<Vec<_>, _>>()?;
    bars.dedup_by_key(|b| b.bucket);
    Ok(ChartRows::Rows(bars))
}

fn parse_row(r: &ChartRow, time: RowTime, period: Period, price: fn(&str) -> Result<Price, WireError>) -> Result<KiwoomBar, WireError> {
    let t = match time {
        RowTime::Date => KstDate::parse_yyyymmdd(&r.dt)
            .map(|d| KstTime::from_kst_civil(d, TimeOfDay::MIDNIGHT))
            .ok_or_else(|| WireError(format!("dt가 날짜가 아닙니다: {:?}", r.dt)))?,
        RowTime::DateTime => parse_kst_datetime(&r.cntr_tm).ok_or_else(|| WireError(format!("cntr_tm이 시각이 아닙니다: {:?}", r.cntr_tm)))?,
    };
    // 주봉·월봉 dt는 구간의 첫 관측일이다. 그 주 월요일, 그달 1일로 맞춘다(§3.2).
    let bucket = period.bucket(t);
    let (o, h, l, c) = (price(&r.open_pric)?, price(&r.high_pric)?, price(&r.low_pric)?, price(&r.cur_prc)?);
    let v = Volume(unsigned(&r.trde_qty)?);
    let ohlcv = match Ohlcv::try_new(o, h, l, c, v) {
        Ok(x) => x,
        Err(e) => {
            // 실제 지수 일봉에 저가 > 종가 같은 행이 있다(코스피 1996-11-04 등). 행을 버리면 구간에 구멍이 생기므로
            // 고가·저가를 네 값의 최대·최소로 넓혀 받는다.
            tracing::warn!(dt = %r.dt, cntr_tm = %r.cntr_tm, error = %e, "키움 봉의 시고저종이 맞지 않아 고가·저가를 넓혔습니다");
            spanning(o, h, l, c, v)
        }
    };
    Ok(KiwoomBar { bucket, ohlcv })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct MillionWon(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KrxDailyRow {
    pub day: KstDate,
    pub ohlcv: Ohlcv,
    pub traded: MillionWon,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableRow {
    pub dt: String,
    pub reason: WireError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KrxDaily {
    pub rows: Vec<KrxDailyRow>,
    pub unreadable: Vec<UnreadableRow>,
}

pub fn parse_krx_daily(body: DailyChartResponse) -> Option<KrxDaily> {
    let rows = body.into_rows();
    if !rows.is_empty() && rows.iter().all(|r| KstDate::parse_yyyymmdd(&r.dt).is_none()) {
        return None;
    }
    let (mut readable, mut unreadable) = (Vec::new(), Vec::new());
    for r in rows.iter().rev() {
        match parse_krx_daily_row(r) {
            Ok(row) => readable.push(row),
            Err(reason) => unreadable.push(UnreadableRow { dt: r.dt.clone(), reason }),
        }
    }
    readable.dedup_by_key(|r| r.day);
    Some(KrxDaily { rows: readable, unreadable })
}

fn parse_krx_daily_row(r: &ChartRow) -> Result<KrxDailyRow, WireError> {
    let bar = parse_row(r, RowTime::Date, Period::Day, stock_price)?;
    Ok(KrxDailyRow { day: bar.bucket.start().kst_date(), ohlcv: bar.ohlcv, traded: MillionWon(unsigned(&r.trde_prica)?) })
}

pub fn index_days(body: IndexDailyChartResponse) -> Result<Vec<KstDate>, WireError> {
    let mut days = body.into_rows().iter().rev().map(|r| KstDate::parse_yyyymmdd(&r.dt).ok_or_else(|| WireError(format!("날짜가 아닙니다: {:?}", r.dt)))).collect::<Result<Vec<_>, _>>()?;
    days.dedup();
    Ok(days)
}

fn spanning(o: Price, h: Price, l: Price, c: Price, v: Volume) -> Ohlcv {
    let high = o.max(h).max(l).max(c);
    let low = o.min(h).min(l).min(c);
    Ohlcv::try_new(o, high, low, c, v).expect("넓힌 고가·저가는 언제나 시가·종가를 감싼다")
}

/// 앞의 `+`/`-`(이중 부호 포함)를 모두 뗀 절댓값.
fn unsigned(s: &str) -> Result<u64, WireError> {
    s.trim().trim_start_matches(['+', '-']).parse().map_err(|_| WireError(format!("숫자가 아닙니다: {s:?}")))
}

fn stock_price(s: &str) -> Result<Price, WireError> {
    let won = unsigned(s)?;
    won.checked_mul(100).and_then(Price::from_centi).ok_or_else(|| WireError(format!("가격이 0이거나 너무 큽니다: {s:?}")))
}

fn index_price(s: &str) -> Result<Price, WireError> {
    Price::from_centi(unsigned(s)?).ok_or_else(|| WireError(format!("가격이 0입니다: {s:?}")))
}

#[derive(Debug, Deserialize)]
pub struct StockListResponse {
    #[serde(deserialize_with = "list_rows")]
    pub list: Vec<ListingRow>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WireListRow {
    code: String,
    name: String,
    market_code: String,
    company_class_name: String,
    nxt_enable: String,
    reg_day: String,
    audit_info: String,
    list_count: String,
}

impl From<WireListRow> for ListingRow {
    fn from(row: WireListRow) -> ListingRow {
        ListingRow {
            code: row.code,
            name: row.name,
            market_code: row.market_code,
            company_class_name: row.company_class_name,
            nxt_enable: row.nxt_enable,
            reg_day: row.reg_day,
            audit_info: row.audit_info,
            list_count: row.list_count,
        }
    }
}

fn list_rows<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<ListingRow>, D::Error> {
    Ok(Vec::<WireListRow>::deserialize(deserializer)?.into_iter().map(ListingRow::from).collect())
}

pub use crate::market_source::ScreenerListing;

pub fn screener_listing(row: &ListingRow, info: &SymbolInfo) -> Option<ScreenerListing> {
    let Symbol::Stock(code) = info.symbol else {
        return None;
    };
    let kind = match info.kind {
        SymbolKind::Etf => Some(ExcludeKind::Etf),
        SymbolKind::Reit => Some(ExcludeKind::Reit),
        SymbolKind::Preferred => Some(ExcludeKind::Preferred),
        SymbolKind::Common if info.market == Market::Kosdaq && row.is_spac() => Some(ExcludeKind::Spac),
        SymbolKind::Common => None,
        SymbolKind::Index => return None,
        SymbolKind::Etn => Some(ExcludeKind::Etn),
        SymbolKind::Infrastructure => Some(ExcludeKind::Infrastructure),
        SymbolKind::MutualFund => Some(ExcludeKind::MutualFund),
    };
    let states = row.audit_statuses().filter_map(|(label, status)| match status {
        AuditStatus::Unknown => {
            tracing::warn!(code = %row.code, label, "auditInfo에 모르는 상태가 있어 상태 제외에 넣지 않습니다");
            None
        }
        known => exclude_kind_of(known),
    });
    Some(ScreenerListing {
        code,
        name: info.name.clone(),
        listed_on: KstDate::parse_yyyymmdd(&row.reg_day),
        excludable_as: kind.into_iter().chain(states).collect(),
        market: info.market.into(),
        listed_shares: listed_shares(row),
    })
}

fn listed_shares(row: &ListingRow) -> Option<NonZeroU64> {
    match row.list_count.parse() {
        Ok(shares) => NonZeroU64::new(shares),
        Err(_) if row.list_count.is_empty() => None,
        Err(_) => {
            tracing::warn!(code = %row.code, list_count = row.list_count, "listCount가 수가 아니어서 상장주식수를 모르는 종목으로 둡니다");
            None
        }
    }
}

fn exclude_kind_of(status: AuditStatus) -> Option<ExcludeKind> {
    match status {
        AuditStatus::Normal | AuditStatus::Unknown => None,
        AuditStatus::Managed => Some(ExcludeKind::Managed),
        AuditStatus::InvestmentCautionAlert => Some(ExcludeKind::InvestmentCautionAlert),
        AuditStatus::InvestmentWarning => Some(ExcludeKind::InvestmentWarning),
        AuditStatus::InvestmentDanger => Some(ExcludeKind::InvestmentDanger),
        AuditStatus::InvestmentCaution => Some(ExcludeKind::InvestmentCaution),
        AuditStatus::ShortTermOverheated => Some(ExcludeKind::ShortTermOverheated),
        AuditStatus::TradingHalted => Some(ExcludeKind::TradingHalted),
    }
}

/// ka10095 응답. 행 순서는 요청 순서였지만(kiwoom.md §10.6) 호출자는 `stk_cd`로 맞춘다.
#[derive(Debug, Deserialize)]
pub struct StockQuotesResponse {
    #[serde(default, deserialize_with = "quote_rows")]
    pub atn_stk_infr: Vec<QuoteRow>,
}

fn quote_rows<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<QuoteRow>, D::Error> {
    let rows = Vec::<Value>::deserialize(deserializer)?;
    Ok(rows.into_iter().map(|row| {
        serde_json::from_value(row.clone()).unwrap_or_else(|_| QuoteRow {
            stk_cd: row["stk_cd"].as_str().unwrap_or("").to_owned(),
            ..QuoteRow::default()
        })
    }).collect())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct QuoteRow {
    pub stk_cd: String,
    pub cur_prc: String,
    pub base_pric: String,
    pub pred_pre_sig: String,
    pub trde_qty: String,
    pub dt: String,
    pub cntr_tm: String,
    pub open_pric: String,
    pub high_pric: String,
    pub low_pric: String,
    pub trde_prica: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StockQuote {
    pub code: StockCode,
    pub venue: Venue,
    pub price_centi: u64,
    /// 기준가(`base_pric`). 등락은 현재가 − 기준가다(backend.md §4.6 "현재가의 등락").
    pub base_centi: u64,
    pub volume: Volume,
    /// 당일 누적 거래대금, 백만원. 행에 없거나 읽지 못하면 None.
    pub traded: Option<MillionWon>,
    pub at: KstTime,
}

pub fn parse_quotes(body: StockQuotesResponse) -> Vec<StockQuote> {
    body.atn_stk_infr
        .iter()
        .filter(|r| !r.cur_prc.is_empty() && !r.base_pric.is_empty())
        .filter_map(|r| match parse_quote_row(r) {
            Ok(q) => Some(q),
            Err(e) => {
                tracing::warn!(stk_cd = %r.stk_cd, error = %e, "ka10095 행을 읽지 못해 뺍니다");
                None
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KrxDayQuote {
    pub code: StockCode,
    pub day: KstDate,
    pub ohlcv: Ohlcv,
    pub traded: MillionWon,
    pub base: Price,
}

pub fn parse_krx_quotes(body: StockQuotesResponse) -> Vec<KrxDayQuote> {
    body.atn_stk_infr
        .iter()
        .filter(|r| !r.cur_prc.is_empty() && !r.base_pric.is_empty())
        .filter_map(|r| match parse_krx_quote_row(r) {
            Ok(q) => Some(q),
            Err(e) => {
                tracing::warn!(stk_cd = %r.stk_cd, error = %e, "ka10095 KRX 행을 읽지 못해 뺍니다");
                None
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KrxSummary {
    pub day: KstDate,
    pub trade_time: Option<TimeOfDay>,
    pub base: Price,
    pub values: KrxSummaryValues,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KrxSummaryValues {
    Traded { ohlcv: Ohlcv, traded: MillionWon },
    NoTrades { current_centi: u64 },
}

pub fn parse_krx_summary(r: &QuoteRow) -> Result<KrxSummary, WireError> {
    StockCode::parse(&r.stk_cd).map_err(|e| WireError(e.to_string()))?;
    let day = KstDate::parse_yyyymmdd(&r.dt).ok_or_else(|| WireError(format!("dt가 날짜가 아닙니다: {:?}", r.dt)))?;
    let trade_time = if r.cntr_tm.is_empty() {
        None
    } else {
        Some(parse_kst_datetime(&format!("{}{}", r.dt, r.cntr_tm))
            .ok_or_else(|| WireError(format!("cntr_tm이 시각이 아닙니다: {:?}", r.cntr_tm)))?.kst_time_of_day())
    };
    let base = stock_price(&r.base_pric)?;
    let volume = Volume(unsigned(&r.trde_qty)?);
    let traded = MillionWon(unsigned(&r.trde_prica)?);
    let values = if volume.0 == 0 {
        if traded.0 != 0 || unsigned(&r.open_pric)? != 0 || unsigned(&r.high_pric)? != 0 || unsigned(&r.low_pric)? != 0 {
            return Err(WireError("무거래 행의 시고저·거래대금이 0이 아닙니다".into()));
        }
        let current_centi = unsigned(&r.cur_prc)?.checked_mul(100).ok_or_else(|| WireError("현재가가 너무 큽니다".into()))?;
        KrxSummaryValues::NoTrades { current_centi }
    } else {
        if trade_time.is_none() {
            return Err(WireError("거래 행에 체결시각이 없습니다".into()));
        }
        let ohlcv = Ohlcv::try_new(stock_price(&r.open_pric)?, stock_price(&r.high_pric)?, stock_price(&r.low_pric)?, stock_price(&r.cur_prc)?, volume)
            .map_err(|e| WireError(e.to_string()))?;
        KrxSummaryValues::Traded { ohlcv, traded }
    };
    Ok(KrxSummary { day, trade_time, base, values })
}

fn parse_krx_quote_row(r: &QuoteRow) -> Result<KrxDayQuote, WireError> {
    let code = StockCode::parse(&r.stk_cd).map_err(|e| WireError(format!("{e}: {:?}", r.stk_cd)))?;
    let day = KstDate::parse_yyyymmdd(&r.dt).ok_or_else(|| WireError(format!("dt가 날짜가 아닙니다: {:?}", r.dt)))?;
    let close = stock_price(&r.cur_prc)?;
    let volume = Volume(unsigned(&r.trde_qty)?);
    let ohlcv = if volume.0 == 0 {
        spanning(close, close, close, close, volume)
    } else {
        let (o, h, l) = (stock_price(&r.open_pric)?, stock_price(&r.high_pric)?, stock_price(&r.low_pric)?);
        Ohlcv::try_new(o, h, l, close, volume).unwrap_or_else(|e| {
            tracing::warn!(stk_cd = %r.stk_cd, dt = %r.dt, error = %e, "ka10095 KRX 행의 시고저종이 맞지 않아 고가·저가를 넓혔습니다");
            spanning(o, h, l, close, volume)
        })
    };
    Ok(KrxDayQuote { code, day, ohlcv, traded: MillionWon(unsigned(&r.trde_prica)?), base: stock_price(&r.base_pric)? })
}

fn quote_row_code(stk_cd: &str) -> Result<(StockCode, Venue), WireError> {
    let (code, venue) = match (stk_cd.strip_suffix("_AL"), stk_cd.strip_suffix("_NX")) {
        (Some(code), _) => (code, Venue::Combined),
        (_, Some(code)) => (code, Venue::Nxt),
        _ => (stk_cd, Venue::Krx),
    };
    let code = StockCode::parse(code).map_err(|e| WireError(format!("{e}: {stk_cd:?}")))?;
    Ok((code, venue))
}

pub use crate::market_source::DaySummary as DaySummaryRow;

pub fn parse_day_summary(body: StockQuotesResponse, code: StockCode, venue: Venue) -> DaySummaryRow {
    let present = |s: &str| unsigned(s).ok().filter(|n| *n > 0);
    body.atn_stk_infr
        .iter()
        .find(|r| quote_row_code(&r.stk_cd).is_ok_and(|row| row == (code, venue)))
        .map(|r| DaySummaryRow {
            price_won: present(&r.cur_prc),
            base_won: present(&r.base_pric),
            open_won: present(&r.open_pric),
            high_won: present(&r.high_pric),
            low_won: present(&r.low_pric),
            volume: present(&r.trde_qty),
            trade_value_won: present(&r.trde_prica).and_then(|million| million.checked_mul(WON_PER_MILLION as u64)),
            at: parse_kst_datetime(&format!("{}{}", r.dt, r.cntr_tm)),
        })
        .unwrap_or_default()
}

fn parse_quote_row(r: &QuoteRow) -> Result<StockQuote, WireError> {
    let (code, venue) = quote_row_code(&r.stk_cd)?;
    let won = |s: &str| unsigned(s)?.checked_mul(100).ok_or_else(|| WireError(format!("가격이 너무 큽니다: {s:?}")));
    let (price_centi, base_centi) = (won(&r.cur_prc)?, won(&r.base_pric)?);
    let at = parse_kst_datetime(&format!("{}{}", r.dt, r.cntr_tm)).ok_or_else(|| WireError(format!("dt·cntr_tm이 시각이 아닙니다: {:?} {:?}", r.dt, r.cntr_tm)))?;
    let computed = price_centi.cmp(&base_centi);
    // 방향 필드: 1 상한, 2 상승, 3 보합, 4 하한, 5 하락(§4.6).
    let signalled = match r.pred_pre_sig.as_str() {
        "1" | "2" => Some(std::cmp::Ordering::Greater),
        "3" => Some(std::cmp::Ordering::Equal),
        "4" | "5" => Some(std::cmp::Ordering::Less),
        _ => None,
    };
    if signalled != Some(computed) {
        tracing::warn!(stk_cd = %r.stk_cd, cur_prc = %r.cur_prc, base_pric = %r.base_pric, pred_pre_sig = %r.pred_pre_sig, "등락 방향 필드가 현재가 − 기준가와 맞지 않습니다. 계산한 값을 씁니다");
    }
    Ok(StockQuote { code, venue, price_centi, base_centi, volume: Volume(unsigned(&r.trde_qty)?), traded: unsigned(&r.trde_prica).ok().map(MillionWon), at })
}

#[derive(Deserialize)]
pub struct BasicInfoRow {
    stk_cd: String,
    stk_nm: String,
    mac: String,
    flo_stk: String,
    per: String,
    pbr: String,
    roe: String,
    eps: String,
    bps: String,
    for_exh_rt: String,
    #[serde(default)]
    crd_rt: Value,
    #[serde(rename = "250hgst")]
    high_250: String,
    #[serde(rename = "250lwst")]
    low_250: String,
    upl_pric: String,
    lst_pric: String,
}

pub use crate::market_source::StockFundamentals;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "BasicInfoRow")]
pub enum StockBasicInfoResponse {
    UnknownSymbol,
    Found { kiwoom_code: String, fundamentals: Box<StockFundamentals> },
}

const WON_PER_EOK: u64 = 100_000_000;
/// 명세는 `flo_stk` 단위를 천원이라 적지만 실제로는 천 주다(kiwoom.md §14).
const SHARES_PER_FLO_STK_UNIT: u64 = 1_000;

impl TryFrom<BasicInfoRow> for StockBasicInfoResponse {
    type Error = WireError;

    fn try_from(r: BasicInfoRow) -> Result<Self, WireError> {
        match (r.stk_cd.is_empty(), r.stk_nm.is_empty()) {
            (true, true) => return Ok(StockBasicInfoResponse::UnknownSymbol),
            (false, false) => {}
            _ => return Err(WireError(format!("종목코드와 종목명 중 하나만 비었습니다: {:?}", r.stk_cd))),
        }
        let scaled = |s: &str, by: u64| optional(s, unsigned)?.map(|n| n.checked_mul(by).ok_or_else(|| WireError(format!("값이 너무 큽니다: {s:?}")))).transpose();
        let fundamentals = StockFundamentals {
            market_cap_won: scaled(&r.mac, WON_PER_EOK)?,
            listed_shares: scaled(&r.flo_stk, SHARES_PER_FLO_STK_UNIT)?,
            per: optional(&r.per, decimal)?,
            pbr: optional(&r.pbr, decimal)?,
            roe_pct: optional(&r.roe, decimal)?,
            eps_won: optional(&r.eps, signed)?,
            bps_won: optional(&r.bps, signed)?,
            foreign_exhaustion_pct: optional(&r.for_exh_rt, decimal)?,
            credit_rate: r.crd_rt.as_str().and_then(|s| optional(s, decimal).ok().flatten()),
            high_250_won: optional(&r.high_250, unsigned)?,
            low_250_won: optional(&r.low_250, unsigned)?,
            upper_limit_won: optional(&r.upl_pric, unsigned)?,
            lower_limit_won: optional(&r.lst_pric, unsigned)?,
        };
        Ok(StockBasicInfoResponse::Found { kiwoom_code: r.stk_cd, fundamentals: Box::new(fundamentals) })
    }
}

fn optional<T>(s: &str, parse: fn(&str) -> Result<T, WireError>) -> Result<Option<T>, WireError> {
    if s.trim().is_empty() { Ok(None) } else { parse(s.trim()).map(Some) }
}

fn signed(s: &str) -> Result<i64, WireError> {
    s.trim().strip_prefix('+').unwrap_or(s.trim()).parse().map_err(|_| WireError(format!("정수가 아닙니다: {s:?}")))
}

fn decimal(s: &str) -> Result<f64, WireError> {
    s.trim().parse::<f64>().ok().filter(|x| x.is_finite()).ok_or_else(|| WireError(format!("소수가 아닙니다: {s:?}")))
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageDays<T> {
    pub rows: Vec<(KstDate, Result<T, FieldError>)>,
    pub undated: Vec<UnreadableRow>,
}

impl<T> PageDays<T> {
    pub fn oldest(&self) -> Option<KstDate> {
        self.rows.iter().map(|(day, _)| *day).min()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
    pub field: &'static str,
    pub reason: WireError,
}

fn field<T>(field: &'static str, kiwoom_field: &str, text: &str, parse: fn(&str) -> Result<T, WireError>) -> Result<T, FieldError> {
    parse(text).map_err(|e| FieldError { field, reason: WireError(format!("{kiwoom_field}: {e}")) })
}

pub trait DayPage: PartialEq {
    type Day;
    fn days(&self) -> PageDays<Self::Day>;
}

fn page_days<R, T>(rows: &[R], dt: impl Fn(&R) -> &str, read: impl Fn(KstDate, &R) -> Result<T, FieldError>) -> PageDays<T> {
    let (mut dated, mut undated) = (Vec::new(), Vec::new());
    for r in rows {
        match KstDate::parse_yyyymmdd(dt(r)) {
            Some(day) => dated.push((day, read(day, r))),
            None => undated.push(UnreadableRow { dt: dt(r).to_owned(), reason: WireError(format!("dt가 날짜가 아닙니다: {:?}", dt(r))) }),
        }
    }
    PageDays { rows: dated, undated }
}

fn shares(s: &str) -> Result<u64, WireError> {
    s.trim().strip_prefix('+').unwrap_or(s.trim()).parse().map_err(|_| WireError(format!("주식 수가 아닙니다: {s:?}")))
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct StockForeignHoldingsResponse {
    stk_frgnr: Vec<ForeignHoldingRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct ForeignHoldingRow {
    dt: String,
    poss_stkcnt: String,
    wght: String,
}

impl DayPage for StockForeignHoldingsResponse {
    type Day = api::ForeignHoldingDay;

    fn days(&self) -> PageDays<api::ForeignHoldingDay> {
        page_days(&self.stk_frgnr, |r| r.dt.as_str(), |day, r| {
            Ok(api::ForeignHoldingDay {
                day: api::KstDate(day),
                shares: field("shares", "poss_stkcnt", &r.poss_stkcnt, shares)?,
                weight_pct: field("weightPct", "wght", &r.wght, decimal)?,
            })
        })
    }
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct StockInvestorNetSharesResponse {
    stk_invsr_orgn: Vec<InvestorNetSharesRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct InvestorNetSharesRow {
    dt: String,
    ind_invsr: String,
    frgnr_invsr: String,
    orgn: String,
    fnnc_invt: String,
    insrnc: String,
    invtrt: String,
    etc_fnnc: String,
    bank: String,
    penfnd_etc: String,
    samo_fund: String,
    natn: String,
    etc_corp: String,
}

impl DayPage for StockInvestorNetSharesResponse {
    type Day = api::InvestorNetSharesDay;

    fn days(&self) -> PageDays<api::InvestorNetSharesDay> {
        page_days(&self.stk_invsr_orgn, |r| r.dt.as_str(), |day, r| {
            Ok(api::InvestorNetSharesDay {
                day: api::KstDate(day),
                individual: field("individual", "ind_invsr", &r.ind_invsr, signed)?,
                foreign: field("foreign", "frgnr_invsr", &r.frgnr_invsr, signed)?,
                institution: field("institution", "orgn", &r.orgn, signed)?,
                financial_investment: field("financialInvestment", "fnnc_invt", &r.fnnc_invt, signed)?,
                insurance: field("insurance", "insrnc", &r.insrnc, signed)?,
                investment_trust: field("investmentTrust", "invtrt", &r.invtrt, signed)?,
                other_financial: field("otherFinancial", "etc_fnnc", &r.etc_fnnc, signed)?,
                bank: field("bank", "bank", &r.bank, signed)?,
                pension_fund: field("pensionFund", "penfnd_etc", &r.penfnd_etc, signed)?,
                private_fund: field("privateFund", "samo_fund", &r.samo_fund, signed)?,
                government: field("government", "natn", &r.natn, signed)?,
                other_corporation: field("otherCorporation", "etc_corp", &r.etc_corp, signed)?,
            })
        })
    }
}

const ORDER_BOOK_LEVELS: usize = 10;

/// ka10004 응답. 호가 40여 개 필드가 납작하게 오므로 이름으로 읽는다.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "std::collections::HashMap<String, Value>")]
pub struct StockOrderBookResponse {
    pub asks: Vec<api::OrderBookLevel>,
    pub bids: Vec<api::OrderBookLevel>,
    pub total_ask_quantity: u64,
    pub total_bid_quantity: u64,
    pub after_hours_ask_quantity: Option<u64>,
    pub after_hours_bid_quantity: Option<u64>,
    pub book_time: Option<String>,
}

impl TryFrom<std::collections::HashMap<String, Value>> for StockOrderBookResponse {
    type Error = WireError;

    fn try_from(fields: std::collections::HashMap<String, Value>) -> Result<Self, WireError> {
        let text = |name: &str| match fields.get(name) {
            Some(Value::String(s)) => Ok(s.as_str()),
            Some(other) => Err(WireError(format!("{name}가 문자열이 아닙니다: {other}"))),
            None => Err(WireError(format!("{name}가 없습니다"))),
        };
        let quantity = |name: &str| text(name).and_then(|s| optional(s, unsigned).map(Option::unwrap_or_default));
        let side = |prefix: &str| -> Result<Vec<api::OrderBookLevel>, WireError> {
            let mut levels = Vec::new();
            for rank in 1..=ORDER_BOOK_LEVELS {
                let (price, size) = if rank == 1 { (format!("{prefix}_fpr_bid"), format!("{prefix}_fpr_req")) } else { (format!("{prefix}_{rank}th_pre_bid"), format!("{prefix}_{rank}th_pre_req")) };
                let price = optional(text(&price)?, unsigned)?.unwrap_or_default();
                if price != 0 {
                    levels.push(api::OrderBookLevel { price, quantity: quantity(&size)? });
                }
            }
            Ok(levels)
        };
        let after_hours = |name: &str| fields.get(name).and_then(Value::as_str).and_then(|s| optional(s, unsigned).ok().flatten());
        let clock = text("bid_req_base_tm")?.trim();
        Ok(StockOrderBookResponse {
            asks: side("sel")?,
            bids: side("buy")?,
            total_ask_quantity: quantity("tot_sel_req")?,
            total_bid_quantity: quantity("tot_buy_req")?,
            after_hours_ask_quantity: after_hours("ovt_sel_req"),
            after_hours_bid_quantity: after_hours("ovt_buy_req"),
            book_time: if clock.is_empty() { None } else { Some(clock_text(clock)?) },
        })
    }
}

/// `HHMMSS` → `HH:MM:SS`.
fn clock_text(s: &str) -> Result<String, WireError> {
    let valid = s.len() == 6 && s.is_ascii() && s.bytes().all(|b| b.is_ascii_digit());
    let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().unwrap_or(99);
    if valid && TimeOfDay::hms(n(0..2), n(2..4), n(4..6)).is_some() {
        Ok(format!("{}:{}:{}", &s[..2], &s[2..4], &s[4..]))
    } else {
        Err(WireError(format!("시각이 아닙니다: {s:?}")))
    }
}

/// 부호 붙은 정수. `+`와 `-`가 겹쳐 와도 앞의 부호만 방향으로 읽는다.
fn signed_quantity(s: &str) -> Result<i64, WireError> {
    let magnitude = i64::try_from(unsigned(s)?).map_err(|_| WireError(format!("값이 너무 큽니다: {s:?}")))?;
    Ok(if s.trim().starts_with('-') { -magnitude } else { magnitude })
}

const WON_PER_MILLION: i64 = 1_000_000;

/// 백만원 단위 금액을 원으로. 부호는 방향이다.
fn million_won(s: &str) -> Result<i64, WireError> {
    signed_quantity(s)?.checked_mul(WON_PER_MILLION).ok_or_else(|| WireError(format!("금액이 너무 큽니다: {s:?}")))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRows<T> {
    pub rows: Vec<T>,
    pub skipped: u32,
}

fn collect_rows<R, T>(rows: &[R], read: impl Fn(&R) -> Result<T, WireError>, api_id: &str) -> ParsedRows<T> {
    let (mut parsed, mut skipped) = (Vec::new(), 0);
    for r in rows {
        match read(r) {
            Ok(row) => parsed.push(row),
            Err(reason) => {
                tracing::warn!(api_id, %reason, "키움 행을 읽지 못해 그 행만 빼고 받습니다");
                skipped += 1;
            }
        }
    }
    ParsedRows { rows: parsed, skipped }
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct StockTradesResponse {
    cntr_infr: Vec<TradeRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct TradeRow {
    tm: String,
    cur_prc: String,
    cntr_trde_qty: String,
    stex_tp: String,
}

impl StockTradesResponse {
    pub fn trades(&self) -> ParsedRows<api::TradePrint> {
        collect_rows(&self.cntr_infr, |r| {
            let exchange = match r.stex_tp.trim() {
                "KRX" => Some(api::Venue::Krx),
                "NXT" => Some(api::Venue::Nxt),
                _ => None,
            };
            Ok(api::TradePrint { time: clock_text(r.tm.trim())?, price: unsigned(&r.cur_prc)?, quantity: signed_quantity(&r.cntr_trde_qty)?, exchange })
        }, "ka10003")
    }
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct StockProgramTradesResponse {
    stk_tm_prm_trde_trnsn: Vec<ProgramTradeRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct ProgramTradeRow {
    tm: String,
    cur_prc: String,
    prm_sell_qty: String,
    prm_buy_qty: String,
    prm_netprps_qty: String,
    prm_sell_amt: String,
    prm_buy_amt: String,
    prm_netprps_amt: String,
}

impl StockProgramTradesResponse {
    pub fn points(&self) -> ParsedRows<api::ProgramTradePoint> {
        collect_rows(&self.stk_tm_prm_trde_trnsn, |r| {
            Ok(api::ProgramTradePoint {
                time: clock_text(r.tm.trim())?,
                price: optional(&r.cur_prc, unsigned)?,
                sell_quantity: unsigned(&r.prm_sell_qty)?,
                buy_quantity: unsigned(&r.prm_buy_qty)?,
                net_quantity: signed_quantity(&r.prm_netprps_qty)?,
                sell_amount: million_won(&r.prm_sell_amt)?.abs(),
                buy_amount: million_won(&r.prm_buy_amt)?.abs(),
                net_amount: million_won(&r.prm_netprps_amt)?,
            })
        }, "ka90008")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankRow<T> {
    pub code: StockCode,
    pub name: String,
    pub columns: T,
}

fn without_commas(s: &str) -> String {
    s.chars().filter(|c| *c != ',').collect()
}

fn rank_price(s: &str) -> Result<u64, WireError> {
    unsigned(&without_commas(s))
}

fn rank_count(s: &str) -> Result<u64, WireError> {
    unsigned(&without_commas(s))
}

fn rank_signed(s: &str) -> Result<i64, WireError> {
    signed_quantity(&without_commas(s))
}

fn rank_rate(s: &str) -> Result<f64, WireError> {
    decimal(&without_commas(s))
}

fn rank_won(s: &str) -> Result<i64, WireError> {
    million_won(&without_commas(s))
}

fn rank_position(s: &str) -> Result<Option<u32>, WireError> {
    optional(s, |s| s.trim().parse().map_err(|_| WireError(format!("순위가 아닙니다: {s:?}"))))
}

fn rank_code(s: &str) -> Result<StockCode, WireError> {
    let bare = s.trim();
    let bare = bare.strip_suffix("_NX").or_else(|| bare.strip_suffix("_AL")).unwrap_or(bare);
    StockCode::parse(bare).map_err(|e| WireError(format!("{e}: {s:?}")))
}

fn rank_rows<R, T>(rows: &[R], identity: impl Fn(&R) -> (&str, &str), read: impl Fn(&R) -> Result<T, WireError>, api_id: &str) -> ParsedRows<RankRow<T>> {
    collect_rows(rows, |r| {
        let (code, name) = identity(r);
        Ok(RankRow { code: rank_code(code)?, name: name.trim().to_owned(), columns: read(r)? })
    }, api_id)
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct TradeValueWireRow {
    stk_cd: String,
    stk_nm: String,
    now_rank: String,
    pred_rank: String,
    cur_prc: String,
    flu_rt: String,
    now_trde_qty: String,
    trde_prica: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct ViTriggeredWireRow {
    stk_cd: String,
    motn_pric: String,
    trde_cntr_proc_time: String,
    virelis_time: String,
    static_stdpc: String,
    static_dispty_rt: String,
    dynm_dispty_rt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct ViTriggeredStocksResponse {
    motn_stk: Vec<ViTriggeredWireRow>,
}

impl ViTriggeredStocksResponse {
    pub fn alerts(&self) -> ParsedRows<ViAlert> {
        let mut parsed = collect_rows(&self.motn_stk, |r| {
            let code = StockCode::parse(r.stk_cd.trim()).map_err(|e| WireError(format!("{e}: {:?}", r.stk_cd)))?;
            Ok(ViAlert {
                code,
                market: ViMarket::Krx,
                direction: dispersion_direction(&r.static_dispty_rt).or_else(|| dispersion_direction(&r.dynm_dispty_rt)),
                trigger_price: won_or_zero(&r.motn_pric)?,
                static_base: won_or_zero(&r.static_stdpc)?,
                triggered: hhmmss(&r.trde_cntr_proc_time)?,
                released: vi_release_time(&r.virelis_time)?,
            })
        }, "ka10054");
        parsed.rows.sort_by_key(|alert| alert.triggered);
        parsed
    }
}

fn dispersion_direction(text: &str) -> Option<ViDirection> {
    let rate = signed_decimal(text).ok()?;
    if rate > 0.0 {
        Some(ViDirection::Up)
    } else if rate < 0.0 {
        Some(ViDirection::Down)
    } else {
        None
    }
}

fn won_or_zero(text: &str) -> Result<Option<Price>, WireError> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Price::from_centi(unsigned(text)?.checked_mul(100).ok_or_else(|| WireError(format!("가격이 너무 큽니다: {text:?}")))?))
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct TradeValueRankingResponse {
    trde_prica_upper: Vec<TradeValueWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TradeValueColumns {
    pub price: u64,
    pub change_rate: f64,
    pub trade_value_won: i64,
    pub volume: u64,
    pub rank: Option<u32>,
    pub previous_rank: Option<u32>,
}

impl TradeValueRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<TradeValueColumns>> {
        rank_rows(&self.trde_prica_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(TradeValueColumns {
                price: rank_price(&r.cur_prc)?,
                change_rate: rank_rate(&r.flu_rt)?,
                trade_value_won: rank_won(&r.trde_prica)?,
                volume: rank_count(&r.now_trde_qty)?,
                rank: rank_position(&r.now_rank)?,
                previous_rank: rank_position(&r.pred_rank)?,
            })
        }, "ka10032")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct TradingVolumeWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    flu_rt: String,
    trde_qty: String,
    pred_rt: String,
    trde_tern_rt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct TradingVolumeRankingResponse {
    tdy_trde_qty_upper: Vec<TradingVolumeWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TradingVolumeColumns {
    pub price: u64,
    pub change_rate: f64,
    pub volume: u64,
    pub previous_day_ratio: f64,
    pub turnover_rate: f64,
}

impl TradingVolumeRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<TradingVolumeColumns>> {
        rank_rows(&self.tdy_trde_qty_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(TradingVolumeColumns {
                price: rank_price(&r.cur_prc)?,
                change_rate: rank_rate(&r.flu_rt)?,
                volume: rank_count(&r.trde_qty)?,
                previous_day_ratio: rank_rate(&r.pred_rt)?,
                turnover_rate: rank_rate(&r.trde_tern_rt)?,
            })
        }, "ka10030")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct VolumeSurgeWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    flu_rt: String,
    now_trde_qty: String,
    sdnin_qty: String,
    sdnin_rt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct VolumeSurgeRankingResponse {
    trde_qty_sdnin: Vec<VolumeSurgeWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VolumeSurgeColumns {
    pub price: u64,
    pub change_rate: f64,
    pub surge_rate: f64,
    pub surge_volume: i64,
    pub volume: u64,
}

impl VolumeSurgeRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<VolumeSurgeColumns>> {
        rank_rows(&self.trde_qty_sdnin, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(VolumeSurgeColumns {
                price: rank_price(&r.cur_prc)?,
                change_rate: rank_rate(&r.flu_rt)?,
                surge_rate: rank_rate(&r.sdnin_rt)?,
                surge_volume: rank_signed(&r.sdnin_qty)?,
                volume: rank_count(&r.now_trde_qty)?,
            })
        }, "ka10023")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct PriceChangeWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    pred_pre: String,
    flu_rt: String,
    now_trde_qty: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct PriceChangeRankingResponse {
    pred_pre_flu_rt_upper: Vec<PriceChangeWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PriceChangeColumns {
    pub price: u64,
    pub change_rate: f64,
    pub change_won: i64,
    pub volume: u64,
}

impl PriceChangeRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<PriceChangeColumns>> {
        rank_rows(&self.pred_pre_flu_rt_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(PriceChangeColumns {
                price: rank_price(&r.cur_prc)?,
                change_rate: rank_rate(&r.flu_rt)?,
                change_won: rank_signed(&r.pred_pre)?,
                volume: rank_count(&r.now_trde_qty)?,
            })
        }, "ka10027")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct ExpectedExecutionWireRow {
    stk_cd: String,
    stk_nm: String,
    exp_cntr_pric: String,
    flu_rt: String,
    exp_cntr_qty: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct ExpectedExecutionRankingResponse {
    exp_cntr_flu_rt_upper: Vec<ExpectedExecutionWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExpectedExecutionColumns {
    pub expected_price: u64,
    pub expected_change_rate: f64,
    pub expected_volume: u64,
}

impl ExpectedExecutionRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<ExpectedExecutionColumns>> {
        rank_rows(&self.exp_cntr_flu_rt_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(ExpectedExecutionColumns {
                expected_price: rank_price(&r.exp_cntr_pric)?,
                expected_change_rate: rank_rate(&r.flu_rt)?,
                expected_volume: rank_count(&r.exp_cntr_qty)?,
            })
        }, "ka10029")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct InvestorNetWireRow {
    stk_cd: String,
    stk_nm: String,
    sel_qty: String,
    buy_qty: String,
    netslmt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct InvestorNetRankingResponse {
    opmr_invsr_trde_upper: Vec<InvestorNetWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InvestorNetColumns {
    pub net: i64,
    pub bought: i64,
    pub sold: i64,
}

impl InvestorNetRankingResponse {
    pub fn rows(&self, unit: InvestorUnit) -> ParsedRows<RankRow<InvestorNetColumns>> {
        let read = |s: &str| match unit {
            InvestorUnit::Amount => rank_won(s),
            InvestorUnit::Quantity => rank_signed(s),
        };
        rank_rows(&self.opmr_invsr_trde_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(InvestorNetColumns { net: read(&r.netslmt)?, bought: read(&r.buy_qty)?.abs(), sold: read(&r.sel_qty)?.abs() })
        }, "ka10065")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct ForeignStreakWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    dm1: String,
    dm2: String,
    dm3: String,
    tot: String,
    limit_exh_rt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct ForeignStreakRankingResponse {
    for_cont_nettrde_upper: Vec<ForeignStreakWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ForeignStreakColumns {
    pub price: u64,
    pub day_before_1: i64,
    pub day_before_2: i64,
    pub day_before_3: i64,
    pub total: i64,
    pub limit_exhaustion_rate: f64,
}

impl ForeignStreakRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<ForeignStreakColumns>> {
        rank_rows(&self.for_cont_nettrde_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(ForeignStreakColumns {
                price: rank_price(&r.cur_prc)?,
                day_before_1: rank_signed(&r.dm1)?,
                day_before_2: rank_signed(&r.dm2)?,
                day_before_3: rank_signed(&r.dm3)?,
                total: rank_signed(&r.tot)?,
                limit_exhaustion_rate: rank_rate(&r.limit_exh_rt)?,
            })
        }, "ka10035")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct ProgramNetWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    flu_rt: String,
    prm_sell_amt: String,
    prm_buy_amt: String,
    prm_netprps_amt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct ProgramNetRankingResponse {
    prm_netprps_upper_50: Vec<ProgramNetWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProgramNetColumns {
    pub price: u64,
    pub change_rate: f64,
    pub net_won: i64,
    pub bought_won: i64,
    pub sold_won: i64,
}

impl ProgramNetRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<ProgramNetColumns>> {
        rank_rows(&self.prm_netprps_upper_50, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(ProgramNetColumns {
                price: rank_price(&r.cur_prc)?,
                change_rate: rank_rate(&r.flu_rt)?,
                net_won: rank_won(&r.prm_netprps_amt)?,
                bought_won: rank_won(&r.prm_buy_amt)?.abs(),
                sold_won: rank_won(&r.prm_sell_amt)?.abs(),
            })
        }, "ka90003")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct OrderBookBalanceWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    tot_sel_req: String,
    tot_buy_req: String,
    netprps_req: String,
    buy_rt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct OrderBookBalanceRankingResponse {
    bid_req_upper: Vec<OrderBookBalanceWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderBookBalanceColumns {
    pub price: u64,
    pub total_sell: u64,
    pub total_buy: u64,
    pub net_buy: i64,
    pub buy_ratio: f64,
}

impl OrderBookBalanceRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<OrderBookBalanceColumns>> {
        rank_rows(&self.bid_req_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(OrderBookBalanceColumns {
                price: rank_price(&r.cur_prc)?,
                total_sell: rank_count(&r.tot_sel_req)?,
                total_buy: rank_count(&r.tot_buy_req)?,
                net_buy: rank_signed(&r.netprps_req)?,
                buy_ratio: rank_rate(&r.buy_rt)?,
            })
        }, "ka10020")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct CreditRatioWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    flu_rt: String,
    crd_rt: String,
    now_trde_qty: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct CreditRatioRankingResponse {
    crd_rt_upper: Vec<CreditRatioWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreditRatioColumns {
    pub price: u64,
    pub change_rate: f64,
    pub credit_ratio: f64,
    pub volume: u64,
}

impl CreditRatioRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<CreditRatioColumns>> {
        rank_rows(&self.crd_rt_upper, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(CreditRatioColumns {
                price: rank_price(&r.cur_prc)?,
                change_rate: rank_rate(&r.flu_rt)?,
                credit_ratio: rank_rate(&r.crd_rt)?,
                volume: rank_count(&r.now_trde_qty)?,
            })
        }, "ka10033")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct MostViewedWireRow {
    stk_cd: String,
    stk_nm: String,
    past_curr_prc: String,
    base_comp_chgr: String,
    rank_chg: String,
    rank_chg_sign: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct MostViewedRankingResponse {
    item_inq_rank: Vec<MostViewedWireRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MostViewedColumns {
    pub base_price: u64,
    pub base_change_rate: f64,
    pub rank_change: i32,
}

fn rank_change(magnitude: &str, sign: &str) -> Result<i32, WireError> {
    let Some(places) = rank_position(magnitude)? else { return Ok(0) };
    let places = i32::try_from(places).map_err(|_| WireError(format!("순위 변동이 너무 큽니다: {magnitude:?}")))?;
    match sign.trim() {
        "-" => Ok(-places),
        "+" | "" => Ok(places),
        other => Err(WireError(format!("순위 변동 부호가 아닙니다: {other:?}"))),
    }
}

impl MostViewedRankingResponse {
    pub fn rows(&self) -> ParsedRows<RankRow<MostViewedColumns>> {
        rank_rows(&self.item_inq_rank, |r| (&r.stk_cd, &r.stk_nm), |r| {
            Ok(MostViewedColumns {
                base_price: rank_price(&r.past_curr_prc)?,
                base_change_rate: rank_rate(&r.base_comp_chgr)?,
                rank_change: rank_change(&r.rank_chg, &r.rank_chg_sign)?,
            })
        }, "ka00198")
    }
}

fn signed_decimal(s: &str) -> Result<f64, WireError> {
    let text = without_commas(s);
    let magnitude = decimal(text.trim().trim_start_matches(['+', '-']))?;
    Ok(if text.trim().starts_with('-') { -magnitude } else { magnitude })
}

fn sector_code(s: &str) -> String {
    s.trim().strip_suffix("_AL").unwrap_or(s.trim()).to_owned()
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndexBreadthRow {
    pub code: String,
    pub name: String,
    pub level: f64,
    pub change_rate: f64,
    pub rising: u64,
    pub flat: u64,
    pub falling: u64,
    pub upper_limit: u64,
    pub lower_limit: u64,
    pub trade_million_won: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct IndexBreadthWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    flu_rt: String,
    rising: String,
    stdns: String,
    fall: String,
    upl: String,
    lst: String,
    trde_prica: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct AllIndicesResponse {
    #[serde(default)]
    all_inds_idex: Vec<IndexBreadthWireRow>,
}

impl AllIndicesResponse {
    pub fn rows(&self) -> ParsedRows<IndexBreadthRow> {
        collect_rows(&self.all_inds_idex, |r| {
            let count = |s: &str| optional(s, |s| unsigned(&without_commas(s))).map(Option::unwrap_or_default);
            Ok(IndexBreadthRow {
                code: sector_code(&r.stk_cd),
                name: r.stk_nm.trim().to_owned(),
                level: signed_decimal(&r.cur_prc)?.abs(),
                change_rate: signed_decimal(&r.flu_rt)?,
                rising: count(&r.rising)?,
                flat: count(&r.stdns)?,
                falling: count(&r.fall)?,
                upper_limit: count(&r.upl)?,
                lower_limit: count(&r.lst)?,
                trade_million_won: count(&r.trde_prica)?,
            })
        }, "ka20003")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SectorInvestorRow {
    pub code: String,
    pub name: String,
    pub level: f64,
    pub change_rate: f64,
    pub individual_eok: i64,
    pub foreign_eok: i64,
    pub institution_eok: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct SectorInvestorWireRow {
    inds_cd: String,
    inds_nm: String,
    cur_prc: String,
    flu_rt: String,
    ind_netprps: String,
    frgnr_netprps: String,
    orgn_netprps: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct SectorInvestorNetResponse {
    #[serde(default)]
    inds_netprps: Vec<SectorInvestorWireRow>,
}

const CENTI: f64 = 100.0;

impl SectorInvestorNetResponse {
    pub fn rows(&self) -> ParsedRows<SectorInvestorRow> {
        collect_rows(&self.inds_netprps, |r| {
            if r.inds_cd.trim().is_empty() {
                return Err(WireError("업종 코드가 없습니다".into()));
            }
            Ok(SectorInvestorRow {
                code: sector_code(&r.inds_cd),
                name: r.inds_nm.trim().to_owned(),
                level: signed_decimal(&r.cur_prc)?.abs() / CENTI,
                change_rate: signed_decimal(&r.flu_rt)? / CENTI,
                individual_eok: rank_signed(&r.ind_netprps)?,
                foreign_eok: rank_signed(&r.frgnr_netprps)?,
                institution_eok: rank_signed(&r.orgn_netprps)?,
            })
        }, "ka10051")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgramNetMillionWon {
    pub arbitrage: i64,
    pub non_arbitrage: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct ProgramTrendWireRow {
    cntr_tm: String,
    dfrt_trde_netprps: String,
    ndiffpro_trde_netprps: String,
    all_netprps: String,
}

impl ProgramTrendWireRow {
    fn net(&self) -> Result<ProgramNetMillionWon, WireError> {
        Ok(ProgramNetMillionWon {
            arbitrage: rank_signed(&self.dfrt_trde_netprps)?,
            non_arbitrage: rank_signed(&self.ndiffpro_trde_netprps)?,
            total: rank_signed(&self.all_netprps)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProgramMinuteRow {
    pub time: TimeOfDay,
    pub net: ProgramNetMillionWon,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProgramDayRow {
    pub day: KstDate,
    pub net: ProgramNetMillionWon,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct ProgramTrendByMinuteResponse {
    #[serde(default)]
    prm_trde_trnsn: Vec<ProgramTrendWireRow>,
}

impl ProgramTrendByMinuteResponse {
    pub fn rows(&self) -> ParsedRows<ProgramMinuteRow> {
        collect_rows(&self.prm_trde_trnsn, |r| {
            let time = hhmmss(r.cntr_tm.trim())?;
            Ok(ProgramMinuteRow { time, net: r.net()? })
        }, "ka90005")
    }
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct ProgramTrendByDayResponse {
    #[serde(default)]
    prm_trde_trnsn: Vec<ProgramTrendWireRow>,
}

impl ProgramTrendByDayResponse {
    pub fn rows(&self) -> ParsedRows<ProgramDayRow> {
        collect_rows(&self.prm_trde_trnsn, |r| {
            let day = r.cntr_tm.trim().get(..8).and_then(KstDate::parse_yyyymmdd).ok_or_else(|| WireError(format!("cntr_tm이 날짜가 아닙니다: {:?}", r.cntr_tm)))?;
            Ok(ProgramDayRow { day, net: r.net()? })
        }, "ka90010")
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreakColumns {
    pub days: i64,
    pub net_million_won: i64,
    pub net_shares: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InstitutionForeignStreakRow {
    pub code: StockCode,
    pub name: String,
    pub foreign: StreakColumns,
    pub institution: StreakColumns,
    pub period_change_rate: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
struct StreakWireRow {
    stk_cd: String,
    stk_nm: String,
    frgnr_cont_netprps_dys: String,
    frgnr_cont_netprps_qty: String,
    frgnr_cont_netprps_amt: String,
    orgn_cont_netprps_dys: String,
    orgn_cont_netprps_qty: String,
    orgn_cont_netprps_amt: String,
    prid_stkpc_flu_rt: String,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct InstitutionForeignStreakResponse {
    #[serde(default)]
    orgn_frgnr_cont_trde_prst: Vec<StreakWireRow>,
}

impl InstitutionForeignStreakResponse {
    pub fn rows(&self) -> ParsedRows<InstitutionForeignStreakRow> {
        collect_rows(&self.orgn_frgnr_cont_trde_prst, |r| {
            let columns = |days: &str, shares: &str, amount: &str| -> Result<StreakColumns, WireError> {
                Ok(StreakColumns { days: rank_signed(days)?, net_million_won: rank_signed(amount)?, net_shares: rank_signed(shares)? })
            };
            Ok(InstitutionForeignStreakRow {
                code: rank_code(&r.stk_cd)?,
                name: r.stk_nm.trim().to_owned(),
                foreign: columns(&r.frgnr_cont_netprps_dys, &r.frgnr_cont_netprps_qty, &r.frgnr_cont_netprps_amt)?,
                institution: columns(&r.orgn_cont_netprps_dys, &r.orgn_cont_netprps_qty, &r.orgn_cont_netprps_amt)?,
                period_change_rate: signed_decimal(&r.prid_stkpc_flu_rt)?,
            })
        }, "ka10131")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexTradeDay {
    pub day: KstDate,
    pub trade_million_won: u64,
}

pub fn index_trade_days(body: IndexDailyChartResponse) -> ParsedRows<IndexTradeDay> {
    let rows = body.into_rows();
    let mut parsed = collect_rows(&rows, |r| {
        let day = KstDate::parse_yyyymmdd(&r.dt).ok_or_else(|| WireError(format!("dt가 날짜가 아닙니다: {:?}", r.dt)))?;
        Ok(IndexTradeDay { day, trade_million_won: rank_count(&r.trde_prica)? })
    }, "ka20006");
    parsed.rows.sort_by_key(|row| row.day);
    parsed.rows.dedup_by_key(|row| row.day);
    parsed
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitMove {
    Upper,
    Lower,
}

fn limit_move(sign: &str) -> Option<LimitMove> {
    match sign.trim() {
        "1" => Some(LimitMove::Upper),
        "4" => Some(LimitMove::Lower),
        _ => None,
    }
}

fn unknown_keys<'a>(extras: impl IntoIterator<Item = &'a BTreeMap<String, Value>>) -> BTreeSet<String> {
    extras.into_iter().flat_map(|extra| extra.keys().cloned()).collect()
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ThemeGroupsResponse {
    thema_grp: Vec<ThemeGroupWireRow>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ThemeGroupWireRow {
    thema_grp_cd: String,
    thema_nm: String,
    stk_num: String,
    flu_rt: String,
    rising_stk_num: String,
    fall_stk_num: String,
    dt_prft_rt: String,
    main_stk: String,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThemeGroupRow {
    pub code: String,
    pub name: String,
    pub stock_count: u64,
    pub change_rate: f64,
    pub period_return: f64,
    pub rising: u64,
    pub falling: u64,
    pub leaders: Vec<String>,
}

impl ThemeGroupsResponse {
    pub fn rows(&self) -> ParsedRows<ThemeGroupRow> {
        collect_rows(&self.thema_grp, |r| {
            let code = r.thema_grp_cd.trim();
            if code.is_empty() {
                return Err(WireError("테마그룹코드가 비었습니다".into()));
            }
            Ok(ThemeGroupRow {
                code: code.to_owned(),
                name: r.thema_nm.trim().to_owned(),
                stock_count: rank_count(&r.stk_num)?,
                change_rate: signed_decimal(&r.flu_rt)?,
                period_return: signed_decimal(&r.dt_prft_rt)?,
                rising: rank_count(&r.rising_stk_num)?,
                falling: rank_count(&r.fall_stk_num)?,
                leaders: r.main_stk.split(',').map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned).collect(),
            })
        }, "ka90001")
    }

    pub fn unknown_fields(&self) -> BTreeSet<String> {
        unknown_keys(std::iter::once(&self.extra).chain(self.thema_grp.iter().map(|r| &r.extra)))
    }

    pub fn is_empty(&self) -> bool {
        self.thema_grp.is_empty()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ThemeMembersResponse {
    flu_rt: String,
    dt_prft_rt: String,
    thema_comp_stk: Vec<ThemeMemberWireRow>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ThemeMemberWireRow {
    stk_cd: String,
    stk_nm: String,
    cur_prc: String,
    flu_sig: String,
    flu_rt: String,
    acc_trde_qty: String,
    dt_prft_rt_n: String,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThemeMemberRow {
    pub code: StockCode,
    pub name: String,
    pub price_won: u64,
    pub change_rate: f64,
    pub volume: u64,
    pub period_return: Option<f64>,
    pub limit: Option<LimitMove>,
}

impl ThemeMembersResponse {
    pub fn rows(&self) -> ParsedRows<ThemeMemberRow> {
        collect_rows(&self.thema_comp_stk, |r| {
            Ok(ThemeMemberRow {
                code: rank_code(&r.stk_cd)?,
                name: r.stk_nm.trim().to_owned(),
                price_won: rank_price(&r.cur_prc)?,
                change_rate: signed_decimal(&r.flu_rt)?,
                volume: rank_count(&r.acc_trde_qty)?,
                period_return: optional(&r.dt_prft_rt_n, signed_decimal)?,
                limit: limit_move(&r.flu_sig),
            })
        }, "ka90002")
    }

    pub fn theme_change_rate(&self) -> Option<f64> {
        optional(&self.flu_rt, signed_decimal).ok().flatten()
    }

    pub fn theme_period_return(&self) -> Option<f64> {
        optional(&self.dt_prft_rt, signed_decimal).ok().flatten()
    }

    pub fn unknown_fields(&self) -> BTreeSet<String> {
        unknown_keys(std::iter::once(&self.extra).chain(self.thema_comp_stk.iter().map(|r| &r.extra)))
    }

    pub fn is_empty(&self) -> bool {
        self.thema_comp_stk.is_empty()
    }
}

#[cfg(test)]
mod theme_tests {
    use super::*;

    #[test]
    fn theme_groups_read_signed_rates_counts_and_the_leader_list() {
        let body: ThemeGroupsResponse = serde_json::from_value(json!({
            "return_code": 0, "return_msg": "정상",
            "thema_grp": [
                {"thema_grp_cd": "319", "thema_nm": "조선", "stk_num": "12", "flu_sig": "2", "flu_rt": "+3.21", "rising_stk_num": "9", "fall_stk_num": "2", "dt_prft_rt": "-1.05", "main_stk": "한화오션, HD현대중공업,"},
                {"thema_grp_cd": "", "thema_nm": "빈 코드"},
                {"thema_grp_cd": "7", "thema_nm": "원전", "stk_num": "8", "flu_rt": "--0.50", "rising_stk_num": "1", "fall_stk_num": "6", "dt_prft_rt": "+12.30", "main_stk": "", "new_field": "x"}
            ]
        })).unwrap();
        let rows = body.rows();
        assert_eq!(rows.skipped, 1);
        assert_eq!(rows.rows[0], ThemeGroupRow { code: "319".into(), name: "조선".into(), stock_count: 12, change_rate: 3.21, period_return: -1.05, rising: 9, falling: 2, leaders: vec!["한화오션".into(), "HD현대중공업".into()] });
        assert_eq!((rows.rows[1].change_rate, rows.rows[1].period_return, rows.rows[1].leaders.len()), (-0.5, 12.3, 0));
        assert_eq!(body.unknown_fields(), ["flu_sig", "new_field", "return_code", "return_msg"].map(String::from).into());
    }

    #[test]
    fn theme_members_read_venue_codes_limit_signs_and_an_absent_period_return() {
        let body: ThemeMembersResponse = serde_json::from_value(json!({
            "flu_rt": "+2.00", "dt_prft_rt": "",
            "thema_comp_stk": [
                {"stk_cd": "042660_AL", "stk_nm": "한화오션", "cur_prc": "+91,000", "flu_sig": "1", "pred_pre": "+21000", "flu_rt": "+29.99", "acc_trde_qty": "1,234,567", "dt_prft_rt_n": "+35.10"},
                {"stk_cd": "010140", "stk_nm": "삼성중공업", "cur_prc": "-15000", "flu_sig": "5", "flu_rt": "-1.20", "acc_trde_qty": "500", "dt_prft_rt_n": ""},
                {"stk_cd": "bad", "stk_nm": "?"}
            ]
        })).unwrap();
        let rows = body.rows();
        assert_eq!(rows.skipped, 1);
        assert_eq!(rows.rows[0], ThemeMemberRow { code: StockCode::parse("042660").unwrap(), name: "한화오션".into(), price_won: 91_000, change_rate: 29.99, volume: 1_234_567, period_return: Some(35.1), limit: Some(LimitMove::Upper) });
        assert_eq!((rows.rows[1].price_won, rows.rows[1].change_rate, rows.rows[1].period_return, rows.rows[1].limit), (15_000, -1.2, None, None));
        assert_eq!((body.theme_change_rate(), body.theme_period_return()), (Some(2.0), None));
        assert_eq!(body.unknown_fields(), ["pred_pre"].map(String::from).into());
    }
}

#[cfg(test)]
mod market_overview_tests {
    use super::*;

    fn parse<R: serde::de::DeserializeOwned>(body: Value) -> R {
        serde_json::from_value(body).unwrap()
    }

    #[test]
    fn index_rows_read_decimal_levels_and_breadth() {
        let body: AllIndicesResponse = parse(json!({"all_inds_idex": [
            {"stk_cd": "001", "stk_nm": "종합(KOSPI)", "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
            {"stk_cd": "", "stk_nm": "", "cur_prc": "x"}
        ]}));
        let rows = body.rows();
        assert_eq!(rows.skipped, 1);
        let row = &rows.rows[0];
        assert_eq!((row.code.as_str(), row.level, row.change_rate), ("001", 6613.59, -0.67));
        assert_eq!((row.rising, row.flat, row.falling, row.upper_limit, row.lower_limit, row.trade_million_won), (410, 52, 498, 3, 0, 13_485_976));
    }

    #[test]
    fn sector_investor_rows_are_hundredfold_integers_with_al_suffix() {
        let body: SectorInvestorNetResponse = parse(json!({"inds_netprps": [
            {"inds_cd": "101_AL", "inds_nm": "종합(KOSDAQ)", "cur_prc": "-77903", "flu_rt": "-282", "ind_netprps": "-8787", "frgnr_netprps": "+6473", "orgn_netprps": "--12"}
        ]}));
        let row = &body.rows().rows[0];
        assert_eq!((row.code.as_str(), row.level, row.change_rate), ("101", 779.03, -2.82));
        assert_eq!((row.individual_eok, row.foreign_eok, row.institution_eok), (-8787, 6473, -12));
    }

    #[test]
    fn program_rows_fold_double_signs_and_dates() {
        let minutes: ProgramTrendByMinuteResponse = parse(json!({"prm_trde_trnsn": [
            {"cntr_tm": "103905", "dfrt_trde_netprps": "+25634", "ndiffpro_trde_netprps": "--528475", "all_netprps": "--502841"},
            {"cntr_tm": "bad", "all_netprps": "1"}
        ]}));
        let rows = minutes.rows();
        assert_eq!(rows.skipped, 1);
        assert_eq!(rows.rows[0], ProgramMinuteRow { time: TimeOfDay::hms(10, 39, 5).unwrap(), net: ProgramNetMillionWon { arbitrage: 25_634, non_arbitrage: -528_475, total: -502_841 } });
        let days: ProgramTrendByDayResponse = parse(json!({"prm_trde_trnsn": [{"cntr_tm": "20260805000000", "dfrt_trde_netprps": "1", "ndiffpro_trde_netprps": "2", "all_netprps": "3"}]}));
        assert_eq!(days.rows().rows[0].day, KstDate::new(2026, 8, 5).unwrap());
    }

    #[test]
    fn streak_rows_keep_each_actors_sign() {
        let body: InstitutionForeignStreakResponse = parse(json!({"orgn_frgnr_cont_trde_prst": [
            {"stk_cd": "005930_AL", "stk_nm": "삼성전자", "frgnr_cont_netprps_dys": "-2", "frgnr_cont_netprps_qty": "--100", "frgnr_cont_netprps_amt": "--940483",
             "orgn_cont_netprps_dys": "+7", "orgn_cont_netprps_qty": "55", "orgn_cont_netprps_amt": "1000", "prid_stkpc_flu_rt": "-1.25"}
        ]}));
        let row = &body.rows().rows[0];
        assert_eq!((row.foreign.days, row.foreign.net_million_won, row.foreign.net_shares), (-2, -940_483, -100));
        assert_eq!((row.institution.days, row.period_change_rate), (7, -1.25));
    }

    #[test]
    fn index_trade_days_are_ascending_millions() {
        let body: IndexDailyChartResponse = parse(json!({"inds_dt_pole_qry": [
            {"dt": "20261106", "trde_prica": "300"}, {"dt": "20261105", "trde_prica": "200"}
        ]}));
        let days = index_trade_days(body).rows;
        assert_eq!(days.iter().map(|d| (d.day.yyyymmdd(), d.trade_million_won)).collect::<Vec<_>>(), [("20261105".to_owned(), 200), ("20261106".to_owned(), 300)]);
    }
}

#[cfg(test)]
mod rank_tests {
    use super::*;

    fn parse<R: serde::de::DeserializeOwned>(body: Value) -> R {
        serde_json::from_value(body).unwrap()
    }

    fn code(s: &str) -> StockCode {
        StockCode::parse(s).unwrap()
    }

    #[test]
    fn trade_value_rows_read_won_rates_ranks_and_convert_million_won() {
        let r: TradeValueRankingResponse = parse(json!({"trde_prica_upper": [
            {"stk_cd": "005930", "stk_nm": "삼성전자", "now_rank": "1", "pred_rank": "3", "cur_prc": "-71,200", "pred_pre_sig": "5", "flu_rt": "-3.21", "now_trde_qty": "1,234,567", "trde_prica": "88,000"},
            {"stk_cd": "000660_NX", "stk_nm": "SK하이닉스", "now_rank": "2", "pred_rank": "", "cur_prc": "--500", "flu_rt": "+29.97", "now_trde_qty": "10", "trde_prica": "1"},
            {"stk_cd": "bad", "stk_nm": "읽을 수 없음", "cur_prc": "1"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(parsed.rows[0], RankRow {
            code: code("005930"),
            name: "삼성전자".into(),
            columns: TradeValueColumns { price: 71_200, change_rate: -3.21, trade_value_won: 88_000_000_000, volume: 1_234_567, rank: Some(1), previous_rank: Some(3) },
        });
        assert_eq!(parsed.rows[1].code, code("000660"));
        assert_eq!(parsed.rows[1].columns.price, 500);
        assert_eq!(parsed.rows[1].columns.change_rate, 29.97);
        assert_eq!(parsed.rows[1].columns.previous_rank, None);
        assert_eq!(parsed.rows[1].columns.trade_value_won, 1_000_000);
    }

    #[test]
    fn empty_lists_are_empty_and_a_missing_list_is_an_error() {
        let r: TradeValueRankingResponse = parse(json!({"trde_prica_upper": []}));
        assert_eq!(r.rows(), ParsedRows { rows: vec![], skipped: 0 });
        assert!(serde_json::from_value::<TradeValueRankingResponse>(json!({"return_code": 0})).is_err());
    }

    #[test]
    fn trading_volume_rows_read_previous_day_ratio_and_turnover() {
        let r: TradingVolumeRankingResponse = parse(json!({"tdy_trde_qty_upper": [
            {"stk_cd": "005930_AL", "stk_nm": "삼성전자", "cur_prc": "+71200", "flu_rt": "+1.50", "trde_qty": "5,000", "pred_rt": "-12.50", "trde_tern_rt": "0.31", "trde_amt": "300"},
            {"stk_cd": "", "stk_nm": "코드 없음", "cur_prc": "1", "flu_rt": "0", "trde_qty": "1", "pred_rt": "0", "trde_tern_rt": "0"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.rows[0].code, code("005930"));
        assert_eq!(parsed.rows[0].columns, TradingVolumeColumns { price: 71_200, change_rate: 1.5, volume: 5_000, previous_day_ratio: -12.5, turnover_rate: 0.31 });
    }

    #[test]
    fn volume_surge_rows_keep_the_sign_of_the_surge() {
        let r: VolumeSurgeRankingResponse = parse(json!({"trde_qty_sdnin": [
            {"stk_cd": "035720", "stk_nm": "카카오", "cur_prc": "-48,500", "flu_rt": "-3.21", "now_trde_qty": "900,000", "sdnin_qty": "-300,000", "sdnin_rt": "-25.00"},
            {"stk_cd": "035420", "stk_nm": "NAVER", "cur_prc": "+200,000", "flu_rt": "+1.00", "now_trde_qty": "2,000", "sdnin_qty": "+1,500", "sdnin_rt": "+300.00"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.rows[0].columns, VolumeSurgeColumns { price: 48_500, change_rate: -3.21, surge_rate: -25.0, surge_volume: -300_000, volume: 900_000 });
        assert_eq!(parsed.rows[1].columns.surge_volume, 1_500);
        assert_eq!(parsed.rows[1].columns.surge_rate, 300.0);
    }

    #[test]
    fn price_change_rows_read_a_lower_limit_price_as_its_magnitude_and_the_change_as_negative() {
        let r: PriceChangeRankingResponse = parse(json!({"pred_pre_flu_rt_upper": [
            {"stk_cd": "123456", "stk_nm": "하한", "cur_prc": "--500", "pred_pre_sig": "4", "pred_pre": "--215", "flu_rt": "-30.00", "now_trde_qty": "1,000"},
            {"stk_cd": "654321_NX", "stk_nm": "상승", "cur_prc": "+1,300", "pred_pre": "+300", "flu_rt": "+29.97", "now_trde_qty": "2,000"},
            {"stk_cd": "111111", "stk_nm": "깨진 값", "cur_prc": "abc", "pred_pre": "0", "flu_rt": "0", "now_trde_qty": "0"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.rows[0].columns, PriceChangeColumns { price: 500, change_rate: -30.0, change_won: -215, volume: 1_000 });
        assert_eq!(parsed.rows[1].code, code("654321"));
        assert_eq!(parsed.rows[1].columns, PriceChangeColumns { price: 1_300, change_rate: 29.97, change_won: 300, volume: 2_000 });
    }

    #[test]
    fn expected_execution_rows_read_the_expected_price_rate_and_quantity() {
        let r: ExpectedExecutionRankingResponse = parse(json!({"exp_cntr_flu_rt_upper": [
            {"stk_cd": "005930", "stk_nm": "삼성전자", "exp_cntr_pric": "+72,000", "base_pric": "71,200", "flu_rt": "+1.12", "exp_cntr_qty": "35,000"},
            {"stk_cd": "000660", "stk_nm": "수량 없음", "exp_cntr_pric": "1,000", "flu_rt": "0.00", "exp_cntr_qty": ""},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.rows[0].columns, ExpectedExecutionColumns { expected_price: 72_000, expected_change_rate: 1.12, expected_volume: 35_000 });
    }

    #[test]
    fn investor_net_rows_convert_amounts_to_won_and_leave_quantities() {
        let r: InvestorNetRankingResponse = parse(json!({"opmr_invsr_trde_upper": [
            {"stk_cd": "005930", "stk_nm": "삼성전자", "sel_qty": "-1,200", "buy_qty": "+3,400", "netslmt": "+2,200"},
            {"stk_cd": "000660", "stk_nm": "SK하이닉스", "sel_qty": "-500", "buy_qty": "+100", "netslmt": "-400"},
            {"stk_cd": "x", "stk_nm": "깨짐", "sel_qty": "0", "buy_qty": "0", "netslmt": "0"},
        ]}));
        let amounts = r.rows(InvestorUnit::Amount);
        assert_eq!(amounts.skipped, 1);
        assert_eq!(amounts.rows[0].columns, InvestorNetColumns { net: 2_200_000_000, bought: 3_400_000_000, sold: 1_200_000_000 });
        assert_eq!(amounts.rows[1].columns.net, -400_000_000);
        let shares = r.rows(InvestorUnit::Quantity);
        assert_eq!(shares.rows[0].columns, InvestorNetColumns { net: 2_200, bought: 3_400, sold: 1_200 });
        assert_eq!(shares.rows[1].columns.net, -400);
    }

    #[test]
    fn foreign_streak_rows_read_daily_shares_with_their_signs() {
        let r: ForeignStreakRankingResponse = parse(json!({"for_cont_nettrde_upper": [
            {"stk_cd": "005930_AL", "stk_nm": "삼성전자", "cur_prc": "-71,200", "pred_pre_sig": "5", "dm1": "+1,000", "dm2": "-200", "dm3": "+30", "tot": "+830", "limit_exh_rt": "+52.31"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.rows[0].columns, ForeignStreakColumns { price: 71_200, day_before_1: 1_000, day_before_2: -200, day_before_3: 30, total: 830, limit_exhaustion_rate: 52.31 });
    }

    #[test]
    fn program_net_rows_convert_million_won_to_won() {
        let r: ProgramNetRankingResponse = parse(json!({"prm_netprps_upper_50": [
            {"rank": "1", "stk_cd": "005930_NX", "stk_nm": "삼성전자", "cur_prc": "+71,200", "flu_sig": "2", "pred_pre": "+200", "flu_rt": "+0.28", "acc_trde_qty": "1,000", "prm_sell_amt": "-100", "prm_buy_amt": "+1,100", "prm_netprps_amt": "+1,000"},
            {"rank": "2", "stk_cd": "000660", "stk_nm": "SK하이닉스", "cur_prc": "300,000", "flu_rt": "-1.00", "prm_sell_amt": "900", "prm_buy_amt": "100", "prm_netprps_amt": "-800"},
            {"rank": "3", "stk_cd": "000001", "stk_nm": "금액 없음", "cur_prc": "1", "flu_rt": "0", "prm_sell_amt": "", "prm_buy_amt": "", "prm_netprps_amt": ""},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.rows[0].code, code("005930"));
        assert_eq!(parsed.rows[0].columns, ProgramNetColumns { price: 71_200, change_rate: 0.28, net_won: 1_000_000_000, bought_won: 1_100_000_000, sold_won: 100_000_000 });
        assert_eq!(parsed.rows[1].columns.net_won, -800_000_000);
        assert_eq!(parsed.rows[1].columns.change_rate, -1.0);
    }

    #[test]
    fn order_book_balance_rows_read_remaining_quantities_and_the_buy_ratio() {
        let r: OrderBookBalanceRankingResponse = parse(json!({"bid_req_upper": [
            {"stk_cd": "005930", "stk_nm": "삼성전자", "cur_prc": "-71,200", "pred_pre": "-800", "trde_qty": "100", "tot_sel_req": "1,000", "tot_buy_req": "4,000", "netprps_req": "+3,000", "buy_rt": "80.00"},
            {"stk_cd": "000660", "stk_nm": "SK하이닉스", "cur_prc": "300,000", "tot_sel_req": "5,000", "tot_buy_req": "1,000", "netprps_req": "-4,000", "buy_rt": "16.67"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.rows[0].columns, OrderBookBalanceColumns { price: 71_200, total_sell: 1_000, total_buy: 4_000, net_buy: 3_000, buy_ratio: 80.0 });
        assert_eq!(parsed.rows[1].columns.net_buy, -4_000);
    }

    #[test]
    fn credit_ratio_rows_read_the_ratio_and_volume() {
        let r: CreditRatioRankingResponse = parse(json!({"crd_rt_upper": [
            {"stk_infr": "", "stk_cd": "005930", "stk_nm": "삼성전자", "cur_prc": "+71,200", "flu_rt": "+0.50", "crd_rt": "+12.34", "now_trde_qty": "1,000"},
            {"stk_cd": "0059", "stk_nm": "짧은 코드", "cur_prc": "1", "flu_rt": "0", "crd_rt": "0", "now_trde_qty": "0"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.rows[0].columns, CreditRatioColumns { price: 71_200, change_rate: 0.5, credit_ratio: 12.34, volume: 1_000 });
    }

    #[test]
    fn most_viewed_rows_read_rank_change_from_its_sign_and_treat_blank_as_unchanged() {
        let r: MostViewedRankingResponse = parse(json!({"item_inq_rank": [
            {"stk_cd": "005930", "stk_nm": "삼성전자", "bigd_rank": "1", "rank_chg": "3", "rank_chg_sign": "+", "past_curr_prc": "-71,200", "base_comp_sign": "5", "base_comp_chgr": "-1.25"},
            {"stk_cd": "000660_AL", "stk_nm": "SK하이닉스", "bigd_rank": "2", "rank_chg": "2", "rank_chg_sign": "-", "past_curr_prc": "+300,000", "base_comp_chgr": "+0.10"},
            {"stk_cd": "035720", "stk_nm": "카카오", "bigd_rank": "0", "rank_chg": "", "rank_chg_sign": "", "past_curr_prc": "48,500", "base_comp_chgr": "0.00"},
            {"stk_cd": "", "stk_nm": "코드 없음", "past_curr_prc": "1", "base_comp_chgr": "0"},
        ]}));
        let parsed = r.rows();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.rows[0].columns, MostViewedColumns { base_price: 71_200, base_change_rate: -1.25, rank_change: 3 });
        assert_eq!(parsed.rows[1].columns.rank_change, -2);
        assert_eq!(parsed.rows[1].code, code("000660"));
        assert_eq!(parsed.rows[2].columns.rank_change, 0);
    }
}

/// au10001 응답. 토큰은 받자마자 `Secret`으로 감싼다(호출자 몫).
#[derive(Deserialize)]
pub struct TokenResponse {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub expires_dt: String,
}

/// `YYYYMMDDHHMMSS`(KST).
pub fn parse_kst_datetime(s: &str) -> Option<KstTime> {
    if s.len() != 14 || !s.is_ascii() {
        return None;
    }
    let date = KstDate::parse_yyyymmdd(&s[..8])?;
    let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().ok();
    let tod = TimeOfDay::hms(n(8..10)?, n(10..12)?, n(12..14)?)?;
    Some(KstTime::from_kst_civil(date, tod))
}

/// 응답을 기다리는 WebSocket 제어 메시지. 응답에 요청 번호가 없어 `trnm`으로만 짝을 맞춘다(backend.md §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsControl {
    Login,
    Reg,
    Remove,
}

impl WsControl {
    pub fn trnm(self) -> &'static str {
        match self {
            WsControl::Login => "LOGIN",
            WsControl::Reg => "REG",
            WsControl::Remove => "REMOVE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Hash, Eq, PartialOrd, Ord)]
pub enum RealType {
    Trade,
    Index,
    Book,
    Program,
    Broker,
    AfterHours,
    BookKrx,
    BookNxt,
    Expected,
}

impl RealType {
    pub const ALL: [RealType; 9] =
        [RealType::Trade, RealType::Index, RealType::Book, RealType::Program, RealType::Broker, RealType::AfterHours, RealType::BookKrx, RealType::BookNxt, RealType::Expected];

    pub fn book(venue: Venue) -> RealType {
        match venue {
            Venue::Combined => RealType::Book,
            Venue::Krx => RealType::BookKrx,
            Venue::Nxt => RealType::BookNxt,
        }
    }

    pub fn has_own_code(self) -> bool {
        matches!(self, RealType::BookKrx | RealType::BookNxt)
    }

    fn item_venue(self) -> Venue {
        match self {
            RealType::BookKrx => Venue::Krx,
            RealType::BookNxt => Venue::Nxt,
            _ => Venue::Combined,
        }
    }

    pub fn of(symbol: Symbol) -> RealType {
        match symbol {
            Symbol::Stock(_) => RealType::Trade,
            Symbol::Index(_) => RealType::Index,
        }
    }

    pub fn serves(self, symbol: Symbol) -> bool {
        match symbol {
            Symbol::Stock(_) => self != RealType::Index,
            Symbol::Index(_) => self == RealType::Index,
        }
    }

    pub fn companion(self) -> Option<RealType> {
        matches!(self, RealType::Book | RealType::BookKrx | RealType::BookNxt).then_some(RealType::AfterHours)
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            RealType::Trade => "0B",
            RealType::Index => "0J",
            RealType::Book | RealType::BookKrx | RealType::BookNxt => "0D",
            RealType::Program => "0w",
            RealType::Broker => "0F",
            RealType::AfterHours => "0E",
            RealType::Expected => "0H",
        }
    }
}

pub type Registrations = BTreeSet<(RealType, Symbol)>;

impl From<StreamKind> for RealType {
    fn from(kind: StreamKind) -> RealType {
        match kind {
            StreamKind::Trades => RealType::Trade,
            StreamKind::Index => RealType::Index,
            StreamKind::Book(venue) => RealType::book(venue),
            StreamKind::AfterHours => RealType::AfterHours,
            StreamKind::Program => RealType::Program,
            StreamKind::Brokers => RealType::Broker,
        }
    }
}

impl From<RealType> for StreamKind {
    fn from(kind: RealType) -> StreamKind {
        match kind {
            RealType::Trade => StreamKind::Trades,
            RealType::Index => StreamKind::Index,
            RealType::Book | RealType::BookKrx | RealType::BookNxt => StreamKind::Book(kind.item_venue()),
            RealType::AfterHours => StreamKind::AfterHours,
            RealType::Program => StreamKind::Program,
            RealType::Broker => StreamKind::Brokers,
            RealType::Expected => StreamKind::Trades,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountKind {
    OrderFill,
    Balance,
}

impl AccountKind {
    pub const ALL: [AccountKind; 2] = [AccountKind::OrderFill, AccountKind::Balance];

    pub fn as_wire(self) -> &'static str {
        match self {
            AccountKind::OrderFill => "00",
            AccountKind::Balance => "04",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountEvent {
    pub kind: AccountKind,
    pub account: Secret<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsFrame {
    /// 받은 글자 그대로 돌려보낸다.
    Ping,
    Ack { control: WsControl, result: Result<(), WsRejection> },
    Real(Vec<Result<RealItem, WireError>>),
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealItem {
    Trade(RealTick),
    /// 0B `15`가 0: 동시호가에만 나온다(kiwoom.md 11.3). 체결이 아니라 버린다.
    AuctionOnly,
    Expected(ExpectedQuote),
    NoExpectedPrice,
    /// 0J. 체결량은 `13`(누적거래량)의 증가분이라 세션이 앞 프레임과 비교해 정한다.
    Index { index: IndexCode, hhmmss: TimeOfDay, price: Price, cumulative: u64, change_centi: Option<i64> },
    Book(Box<BookSnapshot>),
    Program(RealProgramTrade),
    Broker(BrokerSnapshot),
    AfterHours(AfterHoursTotals),
    Vi(ViAlert),
    IgnoredVi,
    Account(AccountEvent),
    OtherType(String),
}

pub fn parse_ws_frame(text: &str) -> Result<WsFrame, WireError> {
    let Ok(Value::Object(frame)) = serde_json::from_str::<Value>(text) else {
        return Err(WireError("WebSocket 메시지가 JSON 객체가 아닙니다".into()));
    };
    let trnm = frame.get("trnm").and_then(Value::as_str).ok_or_else(|| WireError("WebSocket 메시지에 trnm이 없습니다".into()))?;
    let control = match trnm {
        "PING" => return Ok(WsFrame::Ping),
        "REAL" => {
            let Some(Value::Array(data)) = frame.get("data") else {
                return Err(WireError("REAL에 data 배열이 없습니다".into()));
            };
            return Ok(WsFrame::Real(data.iter().map(parse_real_item).collect()));
        }
        "LOGIN" => WsControl::Login,
        "REG" => WsControl::Reg,
        "REMOVE" => WsControl::Remove,
        other => return Ok(WsFrame::Other(other.to_owned())),
    };
    Ok(WsFrame::Ack { control, result: judge_ws_ack(&frame) })
}

fn parse_real_item(entry: &Value) -> Result<RealItem, WireError> {
    let text = |k: &str| entry.get(k).and_then(Value::as_str).ok_or_else(|| WireError(format!("REAL 항목에 {k}가 없습니다")));
    let (kind, item) = (text("type")?, text("item")?);
    let values = entry.get("values").ok_or_else(|| WireError(format!("{kind} {item}: values가 없습니다")))?;
    let field = |fid: &str| values.get(fid).and_then(Value::as_str).ok_or_else(|| WireError(format!("{kind} {item}: FID {fid}가 없습니다")));
    match kind {
        "0B" => {
            let code = item.strip_suffix("_AL").ok_or_else(|| WireError(format!("0B 통합 시세(_AL)가 아닙니다: {item:?}")))?;
            let code = StockCode::parse(code).map_err(|e| WireError(format!("{e}: {item:?}")))?;
            let qty_text = field("15")?;
            let qty = unsigned(qty_text)?;
            let side = match qty_text.trim().chars().next() {
                Some('+') => Some(TradeSide::Buy),
                Some('-') => Some(TradeSide::Sell),
                _ => None,
            };
            if qty == 0 {
                return Ok(RealItem::AuctionOnly);
            }
            let exchange = match values.get("9081").and_then(Value::as_str).map(str::trim) {
                Some("KRX") => Some(Exchange::Krx),
                Some("NXT") => Some(Exchange::Nxt),
                _ => None,
            };
            let day = (|| {
                let change_centi = signed(field("11").ok()?).ok()?.checked_mul(100)?;
                Some(DayTotals { change_centi, cumulative: Volume(unsigned(field("13").ok()?).ok()?) })
            })();
            let strength_centi = field("228").ok().and_then(|s| level_centi(s.trim().trim_start_matches(['+', '-'])));
            let same_time_ratio_centi = values.get("851").and_then(Value::as_str).and_then(|s| {
                let s = s.trim();
                if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                s.parse::<u64>().ok().filter(|&n| n > 0)
            });
            Ok(RealItem::Trade(RealTick { symbol: Symbol::Stock(code), hhmmss: hhmmss(field("20")?)?, price: stock_price(field("10")?)?, qty: Volume(qty), exchange, day, strength_centi, same_time_ratio_centi, side }))
        }
        "0J" => {
            let index = IndexCode::parse(item).map_err(|e| WireError(format!("{e}: {item:?}")))?;
            let change_centi = field("11").ok().and_then(signed_level_centi);
            Ok(RealItem::Index { index, hhmmss: hhmmss(field("20")?)?, price: index_level(field("10")?)?, cumulative: unsigned(field("13")?)?, change_centi })
        }
        "0H" => {
            let symbol = combined_stock("0H", item)?;
            let Some(price) = Price::from_centi(unsigned(field("10")?)?.checked_mul(100).ok_or_else(|| WireError(format!("0H {item}: 예상체결가가 너무 큽니다")))?) else {
                return Ok(RealItem::NoExpectedPrice);
            };
            let change_centi = signed(field("11")?)?.checked_mul(100).ok_or_else(|| WireError(format!("0H {item}: 전일대비가 너무 큽니다")))?;
            Ok(RealItem::Expected(ExpectedQuote { symbol, hhmmss: hhmmss(field("20")?)?, price, change_centi, expected_qty: Volume(unsigned(field("13")?)?) }))
        }
        "0D" => parse_book(item, values).map(|book| RealItem::Book(Box::new(book))),
        "0w" => parse_program(item, values).map(RealItem::Program),
        "0F" => parse_broker(item, values).map(RealItem::Broker),
        "0E" => parse_after_hours(item, values).map(RealItem::AfterHours),
        VI_REAL_TYPE => parse_vi(item, values),
        "00" | "04" => {
            let kind = if kind == "00" { AccountKind::OrderFill } else { AccountKind::Balance };
            Ok(RealItem::Account(AccountEvent { kind, account: Secret::new(field("9201")?.trim().to_owned()) }))
        }
        other => Ok(RealItem::OtherType(other.to_owned())),
    }
}

fn combined_stock(kind: &str, item: &str) -> Result<Symbol, WireError> {
    let code = item.strip_suffix("_AL").ok_or_else(|| WireError(format!("{kind} 통합 시세(_AL)가 아닙니다: {item:?}")))?;
    StockCode::parse(code).map(Symbol::Stock).map_err(|e| WireError(format!("{e}: {item:?}")))
}

fn book_item(item: &str) -> Result<(Symbol, Venue), WireError> {
    let (code, venue) = match (item.strip_suffix("_AL"), item.strip_suffix("_NX")) {
        (Some(code), _) => (code, Venue::Combined),
        (_, Some(code)) => (code, Venue::Nxt),
        _ => (item, Venue::Krx),
    };
    StockCode::parse(code).map(|code| (Symbol::Stock(code), venue)).map_err(|e| WireError(format!("{e}: {item:?}")))
}

fn fid_or<T: Default>(values: &Value, fid: impl fmt::Display, read: fn(&str) -> Result<T, WireError>) -> Result<T, WireError> {
    let text = match values.get(fid.to_string()) {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    if text.is_empty() { Ok(T::default()) } else { read(&text) }
}

fn required_time(values: &Value, fid: &str, kind: &str, item: &str) -> Result<TimeOfDay, WireError> {
    hhmmss(values.get(fid).and_then(Value::as_str).ok_or_else(|| WireError(format!("{kind} {item}: FID {fid}가 없습니다")))?)
}

fn won_or_absent(values: &Value, fid: u32) -> Result<Option<Price>, WireError> {
    Ok(Price::from_centi(fid_or(values, fid, unsigned)?.checked_mul(100).ok_or_else(|| WireError(format!("FID {fid}: 가격이 너무 큽니다")))?))
}

fn book_side(values: &Value, price_base: u32, qty_base: u32) -> Result<[Option<BookLevel>; BOOK_DEPTH], WireError> {
    let mut levels = [None; BOOK_DEPTH];
    for (depth, level) in levels.iter_mut().enumerate() {
        let depth = depth as u32 + 1;
        let qty = Volume(fid_or(values, qty_base + depth, unsigned)?);
        *level = won_or_absent(values, price_base + depth)?.map(|price| BookLevel { price, qty });
    }
    Ok(levels)
}

fn parse_book(item: &str, values: &Value) -> Result<BookSnapshot, WireError> {
    let expected = (|| {
        let price = won_or_absent(values, 23).ok()??;
        let qty = fid_or(values, 24, unsigned).ok()?;
        Some(ExpectedTrade { price, qty: Volume(qty) })
    })();
    let (symbol, venue) = book_item(item)?;
    Ok(BookSnapshot {
        symbol,
        venue,
        hhmmss: required_time(values, "21", "0D", item)?,
        asks: book_side(values, 40, 60)?,
        bids: book_side(values, 50, 70)?,
        total_ask_qty: Volume(fid_or(values, 121, unsigned)?),
        total_bid_qty: Volume(fid_or(values, 125, unsigned)?),
        expected,
    })
}

fn parse_after_hours(item: &str, values: &Value) -> Result<AfterHoursTotals, WireError> {
    Ok(AfterHoursTotals {
        symbol: combined_stock("0E", item)?,
        hhmmss: required_time(values, "21", "0E", item)?,
        total_ask_qty: Volume(fid_or(values, 131, unsigned)?),
        total_bid_qty: Volume(fid_or(values, 135, unsigned)?),
    })
}

const VI_REAL_TYPE: &str = "1h";

fn vi_target(item: &str) -> Option<(StockCode, ViMarket)> {
    let trimmed = item.trim();
    let (raw, market) = match trimmed.strip_suffix("_NX") {
        Some(code) => (code, ViMarket::Nxt),
        None => (trimmed, ViMarket::Krx),
    };
    StockCode::parse(raw).ok().map(|code| (code, market))
}

fn parse_vi(item: &str, values: &Value) -> Result<RealItem, WireError> {
    let text = |fid: &str| values.get(fid).and_then(Value::as_str).map(str::trim).unwrap_or_default();
    let Some((code, market)) = vi_target(item) else {
        return Ok(RealItem::IgnoredVi);
    };
    let direction = match text("9069") {
        "1" => ViDirection::Up,
        "2" => ViDirection::Down,
        _ => return Ok(RealItem::IgnoredVi),
    };
    if !matches!(text("9068"), "1" | "2" | "3") {
        return Ok(RealItem::IgnoredVi);
    }
    Ok(RealItem::Vi(ViAlert {
        code,
        market,
        direction: Some(direction),
        trigger_price: won_or_absent(values, 1221)?,
        static_base: won_or_absent(values, 1236)?,
        triggered: required_time(values, "1223", VI_REAL_TYPE, item)?,
        released: vi_release_time(text("1224"))?,
    }))
}

fn vi_release_time(text: &str) -> Result<Option<TimeOfDay>, WireError> {
    match text.trim() {
        "" | "000000" => Ok(None),
        text => hhmmss(text).map(Some),
    }
}

fn parse_program(item: &str, values: &Value) -> Result<RealProgramTrade, WireError> {
    Ok(RealProgramTrade {
        symbol: combined_stock("0w", item)?,
        hhmmss: required_time(values, "20", "0w", item)?,
        price: won_or_absent(values, 10)?,
        sell_qty: Volume(fid_or(values, 202, unsigned)?),
        sell_amount_million_won: fid_or(values, 204, unsigned)?,
        buy_qty: Volume(fid_or(values, 206, unsigned)?),
        buy_amount_million_won: fid_or(values, 208, unsigned)?,
        net_buy_qty: fid_or(values, 210, signed)?,
        net_buy_qty_change: fid_or(values, 211, signed)?,
        net_buy_amount_million_won: fid_or(values, 212, signed)?,
        net_buy_amount_change_million_won: fid_or(values, 213, signed)?,
    })
}

pub(crate) fn parse_broker_side<'a>(
    get: &impl Fn(u32) -> Option<std::borrow::Cow<'a, str>>,
    code_base: u32,
    name_base: u32,
    qty_base: u32,
    change_base: u32,
) -> Result<Vec<BrokerEntry>, WireError> {
    let mut entries = Vec::new();
    for rank in 1..=5 {
        let code_raw = get(code_base + rank);
        let name_raw = get(name_base + rank);
        let member_code = code_raw.as_deref().map(str::trim).unwrap_or_default();
        let member_name = name_raw.as_deref().map(str::trim).unwrap_or_default();
        if member_code.is_empty() || member_name.is_empty() {
            continue;
        }
        let qty_raw = get(qty_base + rank);
        let change_raw = get(change_base + rank);
        let qty_text = qty_raw.as_deref().map(str::trim).unwrap_or_default();
        let change_text = change_raw.as_deref().map(str::trim).unwrap_or_default();
        let cumulative_qty = if qty_text.is_empty() { 0 } else { unsigned(qty_text)? };
        let change_qty = if change_text.is_empty() { 0 } else { signed(change_text)? };
        entries.push(BrokerEntry {
            member_code: member_code.to_owned(),
            member_name: member_name.to_owned(),
            cumulative_qty: Volume(cumulative_qty),
            change_qty,
        });
    }
    Ok(entries)
}

pub(crate) fn parse_broker_sides<'a>(
    get: impl Fn(u32) -> Option<std::borrow::Cow<'a, str>>,
) -> Result<(Vec<BrokerEntry>, Vec<BrokerEntry>), WireError> {
    let sells = parse_broker_side(&get, 145, 140, 160, 165)?;
    let buys = parse_broker_side(&get, 155, 150, 170, 175)?;
    Ok((sells, buys))
}

fn broker_side(values: &Value, code_base: u32, name_base: u32, qty_base: u32, change_base: u32) -> Result<Vec<BrokerEntry>, WireError> {
    let get = |fid: u32| match values.get(fid.to_string()) {
        Some(Value::String(text)) => Some(std::borrow::Cow::Borrowed(text.as_str())),
        Some(Value::Number(number)) => Some(std::borrow::Cow::Owned(number.to_string())),
        _ => None,
    };
    parse_broker_side(&get, code_base, name_base, qty_base, change_base)
}

fn parse_broker(item: &str, values: &Value) -> Result<BrokerSnapshot, WireError> {
    if !values.is_object() {
        return Err(WireError(format!("0F {item}: values가 객체가 아닙니다")));
    }
    Ok(BrokerSnapshot {
        symbol: combined_stock("0F", item)?,
        sells: broker_side(values, 145, 140, 160, 165)?,
        buys: broker_side(values, 155, 150, 170, 175)?,
    })
}

fn hhmmss(s: &str) -> Result<TimeOfDay, WireError> {
    let s = s.trim();
    let bad = || WireError(format!("체결시각이 HHMMSS가 아닙니다: {s:?}"));
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().expect("ASCII 숫자");
    TimeOfDay::hms(n(0..2), n(2..4), n(4..6)).ok_or_else(bad)
}

/// 0J 지수는 소수 2자리 문자열이고 앞에 등락 부호가 붙는다(kiwoom.md 11.5). REST 지수(100배 정수)와 다르다.
fn index_level(s: &str) -> Result<Price, WireError> {
    level_centi(s.trim().trim_start_matches(['+', '-']))
        .and_then(Price::from_centi)
        .ok_or_else(|| WireError(format!("지수가 소수 2자리 이하의 양수가 아닙니다: {s:?}")))
}

fn signed_level_centi(s: &str) -> Option<i64> {
    let s = s.trim();
    let (negative, abs) = match s.strip_prefix('-') {
        Some(abs) => (true, abs),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let centi = i64::try_from(level_centi(abs)?).ok()?;
    Some(if negative { -centi } else { centi })
}

fn level_centi(abs: &str) -> Option<u64> {
    let (int, frac) = abs.split_once('.').unwrap_or((abs, ""));
    let digits = |x: &str| x.bytes().all(|b| b.is_ascii_digit());
    if int.is_empty() || frac.len() > 2 || !digits(int) || !digits(frac) {
        return None;
    }
    let int: u64 = int.parse().ok()?;
    let frac: u64 = format!("{frac:0<2}").parse().expect("두 자리 숫자");
    int.checked_mul(100)?.checked_add(frac)
}

/// REG·REMOVE의 `item`. 주식은 `_AL` 하나만 받고, 거래소 호가(ADR 0032)만 자기 거래소 코드를 쓴다(ADR 0007).
fn real_item_code(kind: RealType, symbol: Symbol) -> String {
    match symbol {
        Symbol::Stock(code) => kiwoom_stock_code(code, kind.item_venue()),
        Symbol::Index(index) => index.as_str().to_owned(),
    }
}

fn real_entry(kind: RealType, symbols: impl Iterator<Item = Symbol>) -> Value {
    json!({"item": symbols.map(|symbol| real_item_code(kind, symbol)).collect::<Vec<_>>(), "type": [kind.as_wire()]})
}

pub fn login_message(token: &Secret<String>) -> Secret<String> {
    Secret::new(json!({"trnm": "LOGIN", "token": token.expose()}).to_string())
}

pub fn reg_message(registrations: &Registrations) -> String {
    let mut by_kind: BTreeMap<RealType, Vec<Symbol>> = BTreeMap::new();
    for &(kind, symbol) in registrations {
        by_kind.entry(kind).or_default().push(symbol);
    }
    let data: Vec<Value> = by_kind.into_iter().map(|(kind, symbols)| real_entry(kind, symbols.into_iter())).collect();
    json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": data}).to_string()
}

/// 0B와 0J를 한 REMOVE에 섞으면 105112로 실패한다(kiwoom.md §8). 그래서 종류 하나만 받는다.
pub fn remove_message(kind: RealType, symbols: &BTreeSet<Symbol>) -> String {
    json!({"trnm": "REMOVE", "grp_no": "1", "data": [real_entry(kind, symbols.iter().copied())]}).to_string()
}

fn account_entry() -> Value {
    json!({"item": [""], "type": AccountKind::ALL.map(AccountKind::as_wire)})
}

pub fn account_reg_message() -> String {
    json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [account_entry()]}).to_string()
}

pub fn vi_reg_message() -> String {
    json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [{"item": [""], "type": [VI_REAL_TYPE]}]}).to_string()
}

pub fn account_remove_message() -> String {
    json!({"trnm": "REMOVE", "grp_no": "1", "data": [account_entry()]}).to_string()
}

#[cfg(test)]
mod tests {
    use domain::{Listing, classify};
    use super::*;

    fn trade_values(time: &str, price: i64, qty: i64, cumulative: i64, exchange: &str) -> Value {
        json!({"20": time, "10": price.to_string(), "15": qty.to_string(), "13": cumulative.to_string(), "9081": exchange, "11": "0"})
    }

    fn vi_frame(item: &str, overrides: &[(&str, &str)]) -> Value {
        let mut values = json!({"9001": "005930", "9068": "1", "9069": "1", "9075": "1", "1221": "881000", "1223": "093000", "1224": "000000", "1236": "800000", "1237": "0"});
        for (fid, value) in overrides {
            values[*fid] = json!(value);
        }
        json!({"type": "1h", "item": item, "values": values})
    }

    #[test]
    fn a_1h_frame_becomes_a_vi_event_and_other_codes_are_ignored() {
        let frame = json!({"trnm": "REAL", "data": [
            vi_frame("005930", &[]),
            vi_frame("005930_AL", &[]),
            vi_frame("005930_NX", &[]),
            vi_frame("005930", &[("9068", "4"), ("1236", "0"), ("1237", "0")]),
            vi_frame("005930", &[("9069", "9")]),
            vi_frame("005930", &[("9068", "")]),
            vi_frame("", &[]),
            vi_frame("005930", &[("9068", "2"), ("9069", "2"), ("1236", "0"), ("1224", "093214")]),
        ]});
        let WsFrame::Real(items) = parse_ws_frame(&frame.to_string()).unwrap() else { panic!("REAL이 아니다") };
        let alert = ViAlert {
            code: StockCode::parse("005930").unwrap(),
            market: ViMarket::Krx,
            direction: Some(ViDirection::Up),
            trigger_price: Price::from_centi(88_100_000),
            static_base: Price::from_centi(80_000_000),
            triggered: TimeOfDay::hms(9, 30, 0).unwrap(),
            released: None,
        };
        let nxt = ViAlert { market: ViMarket::Nxt, ..alert };
        let released = ViAlert { direction: Some(ViDirection::Down), static_base: None, released: TimeOfDay::hms(9, 32, 14), ..alert };
        let ignored = || Ok(RealItem::IgnoredVi);
        assert_eq!(items, [Ok(RealItem::Vi(alert)), ignored(), Ok(RealItem::Vi(nxt)), ignored(), ignored(), ignored(), ignored(), Ok(RealItem::Vi(released))]);
    }

    #[test]
    fn ka10054_rows_take_the_direction_from_the_dispersion_sign_in_trigger_order() {
        let row = |code: &str, at: &str, released: &str, base: &str, rates: (&str, &str)| {
            json!({"stk_cd": code, "motn_pric": "3860", "trde_cntr_proc_time": at, "virelis_time": released, "static_stdpc": base, "static_dispty_rt": rates.0, "dynm_dispty_rt": rates.1})
        };
        let body: ViTriggeredStocksResponse = serde_json::from_value(json!({"motn_stk": [
            row("005930", "114359", "000000", "3490", ("+10.60", "0.00")),
            row("000660", "091000", "091214", "0", ("0.00", "-6.09")),
            row("035720_NX", "091000", "091214", "0", ("0.00", "-6.09")),
        ]})).unwrap();
        let parsed = body.alerts();
        assert_eq!(parsed.skipped, 1);
        let shape: Vec<_> = parsed.rows.iter().map(|a| (a.code.as_str().to_owned(), a.direction, a.static_base, a.released)).collect();
        assert_eq!(
            shape,
            [
                ("000660".to_owned(), Some(ViDirection::Down), None, TimeOfDay::hms(9, 12, 14)),
                ("005930".to_owned(), Some(ViDirection::Up), Price::from_centi(349_000), None),
            ]
        );
    }

    fn index_values(time: &str, centi: i64, cumulative: i64) -> Value {
        let sign = if centi < 0 { "-" } else { "+" };
        let magnitude = centi.unsigned_abs();
        json!({"20": time, "10": format!("{sign}{}.{:02}", magnitude / 100, magnitude % 100), "13": cumulative.to_string()})
    }

    fn fixture(name: &str) -> String {
        let path = format!("{}/tests/fixtures/kiwoom/{name}.json", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn rows<B: ChartBody + serde::de::DeserializeOwned>(name: &str, period: Period) -> Vec<KiwoomBar> {
        match parse_chart(serde_json::from_str::<B>(&fixture(name)).unwrap(), period).unwrap() {
            ChartRows::Rows(r) => r,
            ChartRows::UnknownSymbol => panic!("{name}: UnknownSymbol"),
        }
    }

    fn day(ymd: &str) -> KstTime {
        KstTime::from_kst_civil(KstDate::parse_yyyymmdd(ymd).unwrap(), TimeOfDay::MIDNIGHT)
    }

    fn centi(b: &KiwoomBar) -> [u64; 4] {
        [b.ohlcv.open().centi(), b.ohlcv.high().centi(), b.ohlcv.low().centi(), b.ohlcv.close().centi()]
    }

    fn assert_ascending(bars: &[KiwoomBar]) {
        assert!(bars.windows(2).all(|w| w[0].bucket.start() < w[1].bucket.start()));
    }

    #[test]
    fn stock_daily_is_won_times_100_and_ascending() {
        let bars = rows::<DailyChartResponse>("ka10081_005930_AL", Period::Day);
        assert_eq!(bars.len(), 30);
        assert_ascending(&bars);
        let last = bars.last().unwrap();
        assert_eq!(last.bucket.start(), day("20261106"));
        assert_eq!(centi(last), [18_500_000, 19_650_000, 17_530_000, 19_340_000]);
        assert_eq!(last.ohlcv.volume(), Volume(56_147_847));
    }

    #[test]
    fn weekly_and_monthly_dt_snap_to_monday_and_first() {
        let weeks = rows::<WeeklyChartResponse>("ka10082_005930_AL", Period::Week);
        assert_ascending(&weeks);
        assert_eq!(weeks.last().unwrap().bucket.start(), day("20261102"));
        assert_eq!(centi(weeks.last().unwrap()), [22_050_000, 23_200_000, 17_530_000, 19_340_000]);
        for w in &weeks {
            assert_eq!(w.bucket.start().kst_date().weekday(), domain::Weekday::Mon);
        }
        let months = rows::<MonthlyChartResponse>("ka10083_005930_AL", Period::Month);
        assert_ascending(&months);
        let n = months.len();
        assert_eq!(months[n - 1].bucket.start(), day("20261101"));
        assert_eq!(months[n - 2].bucket.start(), day("20261001"));
        assert!(months.iter().all(|m| m.bucket.start().kst_date().day() == 1));
    }

    #[test]
    fn index_prices_are_already_centi() {
        let d = rows::<IndexDailyChartResponse>("ka20006_001", Period::Day);
        assert_eq!(centi(d.last().unwrap()), [526_326, 526_910, 491_128, 505_969]);
        assert_eq!(d.last().unwrap().ohlcv.close().to_f64(), 5_059.69);
        let w = rows::<IndexWeeklyChartResponse>("ka20007_001", Period::Week);
        assert_eq!(w.last().unwrap().bucket.start(), day("20261102"));
        assert_eq!(centi(w.last().unwrap()), [563_777, 591_083, 491_128, 505_969]);
        let m = rows::<IndexMonthlyChartResponse>("ka20008_001", Period::Month);
        assert_eq!(m.last().unwrap().bucket.start(), day("20261101"));
        assert_eq!(centi(&m[m.len() - 2]), [681_449, 704_467, 530_598, 573_074]);
    }

    fn at(ymd: &str, h: u32, m: u32) -> KstTime {
        KstTime::from_kst_civil(KstDate::parse_yyyymmdd(ymd).unwrap(), TimeOfDay::hms(h, m, 0).unwrap())
    }

    fn close_on(bars: &[KiwoomBar], t: KstTime) -> u64 {
        bars.iter().find(|b| b.bucket.start() == t).unwrap_or_else(|| panic!("{t} 봉이 없다")).ohlcv.close().centi()
    }

    #[test]
    fn daily_close_differs_by_venue() {
        let krx = rows::<DailyChartResponse>("ka10081_005930", Period::Day);
        let nxt = rows::<DailyChartResponse>("ka10081_005930_NX", Period::Day);
        let all = rows::<DailyChartResponse>("ka10081_005930_AL", Period::Day);
        let d = day("20261106");
        assert_eq!([close_on(&krx, d), close_on(&nxt, d), close_on(&all, d)], [19_350_000, 19_340_000, 19_340_000]);
    }

    #[test]
    fn nxt_minutes_start_at_cntr_tm_and_keep_the_1535_bar() {
        let bars = rows::<MinuteChartResponse>("ka10080_005930_NX_1", Period::M1);
        assert_ascending(&bars);
        let last = bars.last().unwrap();
        assert_eq!(last.bucket.start(), at("20261106", 19, 59));
        assert_eq!(centi(last), [19_370_000, 19_370_000, 19_340_000, 19_340_000], "부호를 뗀 원 × 100");
        assert!(bars.iter().any(|b| b.bucket.start() == at("20261106", 15, 35)));
    }

    #[test]
    fn krx_three_minutes_jump_from_1533_to_1600() {
        let bars = rows::<MinuteChartResponse>("ka10080_005930_3", Period::M3);
        assert_ascending(&bars);
        let i = bars.iter().position(|b| b.bucket.start() == at("20261106", 15, 33)).unwrap();
        assert_eq!(bars[i + 1].bucket.start(), at("20261106", 16, 0));
        assert!(bars.iter().all(|b| b.bucket.start().kst_time_of_day().secs() % 180 == 0));
    }

    #[test]
    fn nxt_minutes_of_a_symbol_not_on_nxt_are_one_empty_row() {
        let s = serde_json::from_str::<MinuteChartResponse>(&fixture("ka10080_005935_NX_1")).unwrap();
        assert_eq!(parse_chart(s, Period::M1).unwrap(), ChartRows::UnknownSymbol);
    }

    #[test]
    fn index_minutes_are_already_centi() {
        let bars = rows::<IndexMinuteChartResponse>("ka20005_001_1", Period::M1);
        assert_ascending(&bars);
        let last = bars.last().unwrap();
        assert_eq!(last.bucket.start(), at("20261106", 15, 30));
        assert_eq!(centi(last), [505_029, 505_969, 505_029, 505_969]);
    }

    #[test]
    fn real_index_row_with_low_above_close_is_widened() {
        let bars = rows::<IndexDailyChartResponse>("ka20006_001_19961104", Period::Day);
        let b = bars.iter().find(|b| b.bucket.start() == day("19961104")).unwrap();
        assert_eq!(centi(b), [76_453, 76_453, 74_742, 74_742]);
    }

    #[test]
    fn empty_row_means_unknown_symbol() {
        let s = serde_json::from_str::<DailyChartResponse>(&fixture("ka10081_unknown_999999")).unwrap();
        assert_eq!(parse_chart(s, Period::Day).unwrap(), ChartRows::UnknownSymbol);
        let i = serde_json::from_str::<IndexDailyChartResponse>(&fixture("ka20006_unknown_999")).unwrap();
        assert_eq!(parse_chart(i, Period::Day).unwrap(), ChartRows::UnknownSymbol);
    }

    #[test]
    fn signs_are_dropped_including_double_signs() {
        assert_eq!(unsigned("--32411"), Ok(32_411));
        assert_eq!(stock_price("-193400").unwrap().centi(), 19_340_000);
        assert_eq!(index_price("+505969").unwrap().centi(), 505_969);
        assert!(stock_price("0").is_err());
        assert!(stock_price("").is_err());
    }

    #[test]
    fn surrounding_spaces_are_trimmed_but_inner_spaces_and_blanks_are_errors() {
        assert_eq!((unsigned(" 172500"), unsigned("172500 "), unsigned(" +172500"), unsigned(" --32411 ")), (Ok(172_500), Ok(172_500), Ok(172_500), Ok(32_411)));
        assert_eq!((signed(" +8100"), signed("-8100 ")), (Ok(8_100), Ok(-8_100)));
        assert_eq!(level_centi_of(" -1327.93 "), Some(132_793));
        assert_eq!(signed_level_centi(" -43.69 "), Some(-4_369));
        for bad in ["", " ", "   ", "172 500", "1 72500", "+ 172500"] {
            assert!(unsigned(bad).is_err(), "{bad:?}");
        }
        assert!(index_level(" ").is_err());
        assert_eq!((decimal(" 1.5 "), shares(" +27931470 "), hhmmss(" 093001 ").map(|t| t.secs())), (Ok(1.5), Ok(27_931_470), Ok(34_201)));
        assert!(hhmmss("09 3001").is_err() && hhmmss(" ").is_err());
    }

    fn level_centi_of(s: &str) -> Option<i64> {
        index_level(s).ok().map(|p| p.centi() as i64)
    }

    #[test]
    fn real_0b_reads_values_padded_with_spaces() {
        let mut v = trade_values("093001", 71_200, 15, 100, "KRX");
        v["10"] = " 172500".into();
        v["11"] = " +8100".into();
        v["20"] = " 093001".into();
        v["9081"] = " KRX".into();
        match one("0B", "005930_AL", v) {
            Ok(RealItem::Trade(tick)) => assert_eq!((tick.price.centi(), tick.day.map(|d| d.change_centi), tick.exchange), (17_250_000, Some(810_000), Some(Exchange::Krx))),
            other => panic!("{other:?}"),
        }
    }

    fn basic_info(name: &str) -> StockFundamentals {
        match serde_json::from_str(&fixture(name)).unwrap() {
            StockBasicInfoResponse::Found { fundamentals, .. } => *fundamentals,
            StockBasicInfoResponse::UnknownSymbol => panic!("{name}: UnknownSymbol"),
        }
    }

    #[test]
    fn basic_info_is_in_natural_units_with_prices_unsigned() {
        assert_eq!(
            basic_info("ka10001_005930_AL"),
            StockFundamentals {
                market_cap_won: Some(1_093_838_700_000_000),
                listed_shares: Some(5_846_279_000),
                per: Some(28.51),
                pbr: Some(2.92),
                roe_pct: Some(10.9),
                eps_won: Some(6_564),
                bps_won: Some(63_997),
                foreign_exhaustion_pct: Some(45.93),
                credit_rate: Some(0.32),
                high_250_won: Some(380_000),
                low_250_won: Some(93_500),
                upper_limit_won: Some(245_000),
                lower_limit_won: Some(132_100),
            }
        );
    }

    #[test]
    fn basic_info_reads_price_limits_unsigned_and_empty_ones_as_none() {
        let loss = basic_info("ka10001_086520_AL");
        assert_eq!((loss.upper_limit_won, loss.lower_limit_won), (Some(86_000), Some(46_400)));
        let mut body: serde_json::Value = serde_json::from_str(&fixture("ka10001_005930_AL")).unwrap();
        body["upl_pric"] = "".into();
        body["lst_pric"] = "".into();
        let StockBasicInfoResponse::Found { fundamentals, .. } = serde_json::from_value(body).unwrap() else { panic!() };
        assert_eq!((fundamentals.upper_limit_won, fundamentals.lower_limit_won), (None, None));
    }

    #[test]
    fn basic_info_treats_missing_or_unreadable_credit_rate_as_none() {
        for value in [None, Some(json!("")), Some(json!(" ")), Some(json!("abc")), Some(Value::Null), Some(json!(0.32))] {
            let mut body: serde_json::Value = serde_json::from_str(&fixture("ka10001_005930_AL")).unwrap();
            match &value {
                Some(v) => body["crd_rt"] = v.clone(),
                None => drop(body.as_object_mut().unwrap().remove("crd_rt")),
            }
            let StockBasicInfoResponse::Found { fundamentals, .. } = serde_json::from_value(body).unwrap() else { panic!() };
            assert_eq!(fundamentals.credit_rate, None, "{value:?}");
            assert_eq!((fundamentals.upper_limit_won, fundamentals.lower_limit_won), (Some(245_000), Some(132_100)), "{value:?}");
        }
    }

    #[test]
    fn order_book_keeps_ranked_levels_unsigned_and_drops_levels_without_a_price() {
        let book: StockOrderBookResponse = serde_json::from_str(&fixture("ka10004_005930_AL")).unwrap();
        assert_eq!((book.asks.len(), book.bids.len()), (9, 10));
        assert_eq!(book.asks[0], api::OrderBookLevel { price: 70_100, quantity: 1_000 });
        assert_eq!(book.bids[9], api::OrderBookLevel { price: 69_100, quantity: 10_000 });
        assert_eq!((book.total_ask_quantity, book.total_bid_quantity, book.book_time.as_deref()), (55_000, 66_000, Some("15:30:00")));
        let mut body: serde_json::Value = serde_json::from_str(&fixture("ka10004_005930_AL")).unwrap();
        assert_eq!((book.after_hours_ask_quantity, book.after_hours_bid_quantity), (None, None), "필드가 없으면 null이다");
        body["ovt_sel_req"] = "1500".into();
        body["ovt_buy_req"] = "0".into();
        let with = serde_json::from_value::<StockOrderBookResponse>(body.clone()).unwrap();
        assert_eq!((with.after_hours_ask_quantity, with.after_hours_bid_quantity), (Some(1_500), Some(0)));
        assert_eq!((with.asks, with.bids, with.total_ask_quantity, with.book_time.as_deref()), (book.asks.clone(), book.bids.clone(), 55_000, Some("15:30:00")));
        body["ovt_sel_req"] = "".into();
        body["ovt_buy_req"] = "abc".into();
        let broken = serde_json::from_value::<StockOrderBookResponse>(body.clone()).unwrap();
        assert_eq!((broken.after_hours_ask_quantity, broken.after_hours_bid_quantity), (None, None), "비었거나 읽을 수 없으면 응답 전체가 실패하지 않고 null이다");
        body["bid_req_base_tm"] = "".into();
        assert_eq!(serde_json::from_value::<StockOrderBookResponse>(body.clone()).unwrap().book_time, None);
        body["bid_req_base_tm"] = "256100".into();
        assert!(serde_json::from_value::<StockOrderBookResponse>(body.clone()).is_err());
        body.as_object_mut().unwrap().remove("tot_sel_req");
        assert!(serde_json::from_value::<StockOrderBookResponse>(body).is_err(), "필드 없는 성공 응답은 빈 호가가 아니라 형식 오류다");
    }

    #[test]
    fn trades_carry_direction_in_the_quantity_sign_and_skip_unreadable_rows() {
        let page: StockTradesResponse = serde_json::from_str(&fixture("ka10003_005930_AL_p1")).unwrap();
        let parsed = page.trades();
        assert_eq!(parsed.skipped, 1, "시각이 여섯 자리가 아닌 행");
        let seen: Vec<_> = parsed.rows.iter().map(|t| (t.time.as_str(), t.price, t.quantity, t.exchange)).collect();
        assert_eq!(
            seen,
            [
                ("15:30:00", 70_100, 30, Some(api::Venue::Krx)),
                ("15:29:59", 70_000, -12, Some(api::Venue::Nxt)),
                ("15:29:58", 70_000, 5, None),
            ]
        );
        assert!(serde_json::from_value::<StockTradesResponse>(json!({"return_code": 0})).is_err());
    }

    #[test]
    fn program_points_are_in_won_with_gross_sides_unsigned_and_net_signed() {
        let page: StockProgramTradesResponse = serde_json::from_str(&fixture("ka90008_005930_AL_p1")).unwrap();
        let parsed = page.points();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(
            parsed.rows[0],
            api::ProgramTradePoint { time: "15:30:00".into(), price: Some(70_100), buy_quantity: 1_200, sell_quantity: 1_500, net_quantity: -300, buy_amount: 84_000_000, sell_amount: 105_000_000, net_amount: -21_000_000 }
        );
        assert!(serde_json::from_value::<StockProgramTradesResponse>(json!({"return_code": 0})).is_err());
    }

    #[test]
    fn basic_info_keeps_loss_signs_and_leaves_what_kiwoom_omits_empty() {
        let loss = basic_info("ka10001_086520_AL");
        assert_eq!((loss.per, loss.eps_won, loss.roe_pct, loss.bps_won), (None, Some(-1_103), Some(-8.4), Some(14_563)));
        let etf = basic_info("ka10001_069500_AL");
        assert_eq!((etf.per, etf.pbr, etf.roe_pct, etf.eps_won, etf.bps_won), (None, None, None, None, None));
        assert_eq!((etf.market_cap_won, etf.high_250_won, etf.low_250_won), (Some(19_438_000_000_000), Some(152_455), Some(53_925)));
        assert_eq!(serde_json::from_str::<StockBasicInfoResponse>(&fixture("ka10001_999999_AL")).unwrap(), StockBasicInfoResponse::UnknownSymbol);
    }

    #[test]
    fn basic_info_rejects_bodies_that_do_not_match_the_observed_shape() {
        let edited = |field: &str, v: serde_json::Value| {
            let mut body: serde_json::Value = serde_json::from_str(&fixture("ka10001_005930_AL")).unwrap();
            body[field] = v;
            serde_json::from_value::<StockBasicInfoResponse>(body)
        };
        assert!(edited("per", "N/A".into()).is_err());
        assert!(edited("mac", "999999999999999".into()).is_err(), "원으로 바꾸면 u64를 넘는다");
        assert!(edited("stk_cd", "".into()).is_err(), "이름은 있는데 코드가 비었다");
        assert!(edited("stk_nm", "".into()).is_err(), "코드는 있는데 이름이 비었다");
        let mut missing: serde_json::Value = serde_json::from_str(&fixture("ka10001_005930_AL")).unwrap();
        missing.as_object_mut().unwrap().remove("per");
        assert!(serde_json::from_value::<StockBasicInfoResponse>(missing).is_err(), "빈 값과 빠진 필드는 다르다");
    }

    #[test]
    fn quotes_take_abs_price_and_base_and_skip_empty_rows() {
        let body: StockQuotesResponse = serde_json::from_str(&fixture("ka10095_synthetic")).unwrap();
        let quotes = parse_quotes(body);
        let got: Vec<_> = quotes.iter().map(|q| (q.code.as_str(), q.venue, q.price_centi, q.base_centi, q.volume.0)).collect();
        assert_eq!(
            got,
            [
                ("005930", Venue::Combined, 5_000_000, 5_100_000, 1_234_567),
                ("000660", Venue::Combined, 12_050_000, 12_000_000, 765_432),
                ("035720", Venue::Combined, 4_200_000, 4_200_000, 1_000)
            ],
            "005935_NX 빈 행은 빠진다"
        );
        let at = KstTime::from_kst_civil(KstDate::parse_yyyymmdd("20261106").unwrap(), TimeOfDay::hms(19, 59, 59).unwrap());
        assert_eq!(quotes[0].at, at);

        let row = |stk_cd: &str, sig: &str| QuoteRow {
            stk_cd: stk_cd.into(), cur_prc: "-100".into(), base_pric: "90".into(), pred_pre_sig: sig.into(),
            trde_qty: "5".into(), dt: "20261106".into(), cntr_tm: "090000".into(), ..QuoteRow::default()
        };
        let mismatch = parse_quotes(StockQuotesResponse { atn_stk_infr: vec![row("005930_AL", "5")] });
        assert_eq!((mismatch[0].price_centi, mismatch[0].base_centi), (10_000, 9_000), "방향이 어긋나도 계산한 값을 쓴다");
        let venues = parse_quotes(StockQuotesResponse { atn_stk_infr: vec![row("005930", "2"), row("005930_NX", "2"), QuoteRow { cntr_tm: "99".into(), ..row("000660_AL", "2") }] });
        assert_eq!(venues.iter().map(|q| (q.code.as_str(), q.venue)).collect::<Vec<_>>(), [("005930", Venue::Krx), ("005930", Venue::Nxt)], "접미사가 거래소를 정하고, 시각을 읽지 못한 행은 빠진다");
    }

    #[test]
    fn day_summary_reads_open_high_low_volume_and_traded_value_in_won_and_nulls_zero_or_empty() {
        let body: StockQuotesResponse = serde_json::from_str(&fixture("ka10095_synthetic")).unwrap();
        let code = StockCode::parse("005930").unwrap();
        let row = parse_day_summary(body, code, Venue::Combined);
        let at = KstTime::from_kst_civil(KstDate::parse_yyyymmdd("20261106").unwrap(), TimeOfDay::hms(19, 59, 59).unwrap());
        assert_eq!(
            row,
            DaySummaryRow { price_won: Some(50_000), base_won: Some(51_000), open_won: Some(51_200), high_won: Some(51_500), low_won: Some(49_800), volume: Some(1_234_567), trade_value_won: Some(61_728_000_000), at: Some(at) },
            "부호를 떼고, 기준가는 전일 종가이며, 거래대금은 백만원을 원으로 바꾼다"
        );
        let pre_market = QuoteRow {
            stk_cd: "005930".into(), cur_prc: "51000".into(), base_pric: "51000".into(), trde_qty: "0".into(), trde_prica: "0".into(),
            open_pric: "0".into(), high_pric: "".into(), low_pric: "0".into(), dt: "20261106".into(), cntr_tm: "".into(), ..QuoteRow::default()
        };
        let row = parse_day_summary(StockQuotesResponse { atn_stk_infr: vec![pre_market] }, code, Venue::Krx);
        assert_eq!(row, DaySummaryRow { price_won: Some(51_000), base_won: Some(51_000), ..DaySummaryRow::default() }, "0이나 빈 값은 None이다");
        let body: StockQuotesResponse = serde_json::from_str(&fixture("ka10095_synthetic")).unwrap();
        assert_eq!(parse_day_summary(body, code, Venue::Nxt), DaySummaryRow::default(), "다른 거래소의 행은 읽지 않는다");
    }

    #[test]
    fn krx_ka10095_and_ka10081_report_the_traded_value_of_a_day_in_the_same_million_won() {
        let quote: StockQuotesResponse = serde_json::from_str(&fixture("ka10095_005930_krx")).unwrap();
        let quote = parse_krx_quotes(quote)[0];
        let daily: DailyChartResponse = serde_json::from_str(&fixture("ka10081_005930")).unwrap();
        let daily = parse_krx_daily(daily).unwrap().rows;
        let same_day = daily.iter().find(|r| r.day == quote.day).unwrap();
        assert_eq!((quote.day, quote.ohlcv, quote.traded), (same_day.day, same_day.ohlcv, same_day.traded), "마감 뒤 ka10095 KRX 행은 그날 KRX 일봉 행과 같다");
        let average_won = quote.traded.0 * 1_000_000 / quote.ohlcv.volume().0;
        assert!((quote.ohlcv.low().centi() / 100..=quote.ohlcv.high().centi() / 100).contains(&average_won), "백만원 단위면 평균 체결가 {average_won}원이 그날 저가·고가 사이다");
    }

    #[test]
    fn krx_daily_leaves_out_only_the_rows_it_cannot_read_and_names_their_dt_and_reason() {
        let mut body: serde_json::Value = serde_json::from_str(&fixture("ka10081_005930")).unwrap();
        let rows = body["stk_dt_pole_chart_qry"].as_array_mut().unwrap();
        let (count, zero_dt) = (rows.len(), rows[1]["dt"].as_str().unwrap().to_owned());
        rows[1]["cur_prc"] = "0".into();
        rows[2]["dt"] = "2026-11".into();
        rows[3]["trde_qty"] = "N/A".into();
        rows[0]["dt"] = "".into();
        let daily = parse_krx_daily(serde_json::from_value(body.clone()).unwrap()).unwrap();
        assert_eq!(daily.rows.len(), count - 4, "첫 행의 dt가 비어도 다른 행은 읽는다");
        assert!(!daily.rows.iter().any(|r| r.day.yyyymmdd() == zero_dt));
        assert_eq!(daily.unreadable.len(), 4, "{:?}", daily.unreadable);
        assert!(daily.unreadable.iter().any(|u| u.dt == zero_dt && u.reason.0.contains("가격이 0")), "{:?}", daily.unreadable);
        assert!(daily.unreadable.iter().any(|u| u.dt == "2026-11"), "dt가 날짜가 아니어도 그 값을 남긴다");

        for row in body["stk_dt_pole_chart_qry"].as_array_mut().unwrap() {
            row["dt"] = "".into();
        }
        assert_eq!(parse_krx_daily(serde_json::from_value(body).unwrap()), None, "날짜를 읽을 수 있는 행이 하나도 없으면 없는 종목이다");
        let no_rows: DailyChartResponse = serde_json::from_value(json!({"stk_dt_pole_chart_qry": []})).unwrap();
        assert_eq!(parse_krx_daily(no_rows), Some(KrxDaily { rows: vec![], unreadable: vec![] }), "행이 없는 페이지는 빈 페이지다");
    }

    fn spec_foreign_rows() -> serde_json::Value {
        json!({"stk_frgnr": [
            {"dt": "20241105", "close_pric": "135300", "pred_pre": "0", "trde_qty": "0", "chg_qty": "0", "poss_stkcnt": "6663509", "wght": "+26.10", "gain_pos_stkcnt": "18863197", "frgnr_limit": "25526706", "frgnr_limit_irds": "0", "limit_exh_rt": "+26.10"},
            {"dt": "20241101", "close_pric": "65100", "pred_pre": "0", "trde_qty": "0", "chg_qty": "-3441", "poss_stkcnt": "6642402", "wght": "+26.02", "gain_pos_stkcnt": "18884304", "frgnr_limit": "25526706", "frgnr_limit_irds": "0", "limit_exh_rt": "+26.02"},
            {"dt": "20241029", "close_pric": "-65000", "pred_pre": "-27300", "trde_qty": "4", "chg_qty": "249", "poss_stkcnt": "6651461", "wght": "+26.06", "gain_pos_stkcnt": "18875245", "frgnr_limit": "25526706", "frgnr_limit_irds": "0", "limit_exh_rt": "+26.06"}
        ], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
    }

    fn foreign_days(body: serde_json::Value) -> PageDays<api::ForeignHoldingDay> {
        serde_json::from_value::<StockForeignHoldingsResponse>(body).unwrap().days()
    }

    #[test]
    fn foreign_holdings_read_shares_and_weight_of_each_day_in_kiwooms_order() {
        let days = foreign_days(spec_foreign_rows());
        let day = |s: &str| api::KstDate(KstDate::parse_yyyymmdd(s).unwrap());
        assert_eq!(
            days.rows.iter().map(|(_, d)| d.clone().unwrap()).collect::<Vec<_>>(),
            [
                api::ForeignHoldingDay { day: day("20241105"), shares: 6_663_509, weight_pct: 26.10 },
                api::ForeignHoldingDay { day: day("20241101"), shares: 6_642_402, weight_pct: 26.02 },
                api::ForeignHoldingDay { day: day("20241029"), shares: 6_651_461, weight_pct: 26.06 },
            ]
        );
        assert!(days.rows.iter().all(|(d, row)| row.as_ref().is_ok_and(|row| *d == row.day.0)));
        assert_eq!((days.oldest(), days.undated.len()), (Some(KstDate::new(2024, 10, 29).unwrap()), 0));
    }

    #[test]
    fn a_day_page_leaves_out_only_the_rows_it_cannot_read_and_still_knows_how_far_back_it_went() {
        let mut body = spec_foreign_rows();
        body["stk_frgnr"][0]["poss_stkcnt"] = "".into();
        body["stk_frgnr"][1]["dt"] = "2024-11".into();
        body["stk_frgnr"][2]["wght"] = "N/A".into();
        let days = foreign_days(body);
        let failed: Vec<_> = days.rows.iter().map(|(d, row)| (d.yyyymmdd(), row.as_ref().err().map(|e| e.field))).collect();
        assert_eq!(failed, [("20241105".to_owned(), Some("shares")), ("20241029".to_owned(), Some("weightPct"))], "날짜를 읽은 행은 어느 필드 때문에 못 읽었는지 남긴다");
        assert!(days.rows[0].1.as_ref().unwrap_err().reason.0.starts_with("poss_stkcnt: "), "{:?}", days.rows[0]);
        assert_eq!(days.undated.iter().map(|u| u.dt.as_str()).collect::<Vec<_>>(), ["2024-11"]);
        assert_eq!(days.oldest(), Some(KstDate::new(2024, 10, 29).unwrap()), "값을 못 읽은 행도 날짜는 연속조회가 얼마나 거슬러 갔는지 알려 준다");

        let mut negative = spec_foreign_rows();
        negative["stk_frgnr"][0]["poss_stkcnt"] = "-5".into();
        assert!(foreign_days(negative).rows[0].1.is_err(), "보유주식수는 음수가 될 수 없다");
    }

    #[test]
    fn an_undated_page_preserves_its_failures_while_an_empty_page_has_no_rows() {
        let undated = foreign_days(json!({"stk_frgnr": [{"dt": ""}, {"dt": "2026110X"}]}));
        assert_eq!(undated.oldest(), None);
        assert!(undated.rows.is_empty());
        assert_eq!(undated.undated.iter().map(|row| row.dt.as_str()).collect::<Vec<_>>(), ["", "2026110X"]);
        assert!(undated.undated.iter().all(|row| row.reason.0.contains("dt")));
        let empty = foreign_days(json!({"stk_frgnr": []}));
        assert_eq!(empty.oldest(), None);
        assert!(empty.rows.is_empty() && empty.undated.is_empty());
        assert!(serde_json::from_value::<StockForeignHoldingsResponse>(json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다"})).is_err(), "목록이 없는 성공 응답은 빈 답이 아니라 형식 오류다");
        assert!(serde_json::from_value::<StockInvestorNetSharesResponse>(json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다"})).is_err());
    }

    #[test]
    fn investor_net_shares_map_each_kiwoom_investor_field_and_keep_signs() {
        let body = json!({"stk_invsr_orgn": [
            {"dt": "20241107", "cur_prc": "+61300", "pre_sig": "2", "pred_pre": "+4000", "flu_rt": "+698", "acc_trde_qty": "1105968", "acc_trde_prica": "64215",
             "ind_invsr": "1584", "frgnr_invsr": "-61779", "orgn": "+60195", "fnnc_invt": "25514", "insrnc": "-3", "invtrt": "7", "etc_fnnc": "34619", "bank": "4",
             "penfnd_etc": "-1", "samo_fund": "58", "natn": "11", "etc_corp": "-12", "natfor": "1"},
            {"dt": "20241106", "ind_invsr": "x", "frgnr_invsr": "0", "orgn": "0", "fnnc_invt": "0", "insrnc": "0", "invtrt": "0", "etc_fnnc": "0", "bank": "0",
             "penfnd_etc": "0", "samo_fund": "0", "natn": "0", "etc_corp": "0"}
        ], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"});
        let days = serde_json::from_value::<StockInvestorNetSharesResponse>(body).unwrap().days();
        let day = api::KstDate(KstDate::new(2024, 11, 7).unwrap());
        assert_eq!(
            days.rows.iter().filter_map(|(_, d)| d.clone().ok()).collect::<Vec<_>>(),
            [api::InvestorNetSharesDay {
                day,
                individual: 1584,
                foreign: -61779,
                institution: 60195,
                financial_investment: 25514,
                insurance: -3,
                investment_trust: 7,
                other_financial: 34619,
                bank: 4,
                pension_fund: -1,
                private_fund: 58,
                government: 11,
                other_corporation: -12,
            }]
        );
        assert_eq!(days.rows[1].1.as_ref().unwrap_err().field, "individual");
        assert_eq!((days.rows.len(), days.oldest()), (2, Some(KstDate::new(2024, 11, 6).unwrap())));
    }

    #[test]
    fn a_failed_field_names_the_key_the_answer_would_have_carried() {
        let foreign = spec_foreign_rows()["stk_frgnr"][0].clone();
        let investor = json!({"dt": "20241107", "ind_invsr": "1", "frgnr_invsr": "2", "orgn": "3", "fnnc_invt": "4", "insrnc": "5", "invtrt": "6", "etc_fnnc": "7", "bank": "8", "penfnd_etc": "9", "samo_fund": "10", "natn": "11", "etc_corp": "12"});
        let fields = |row: &Value| row.as_object().unwrap().keys().filter(|k| *k != "dt").cloned().collect::<Vec<_>>();
        let failed_field = |list: &str, row: &Value, blank: &str| -> (&'static str, Value) {
            let mut broken = row.clone();
            broken[blank] = "".into();
            let mut whole = json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다"});
            whole[list] = json!([row]);
            let mut body = whole.clone();
            body[list] = json!([broken]);
            if list == "stk_frgnr" {
                let read = |b: Value| serde_json::from_value::<StockForeignHoldingsResponse>(b).unwrap().days().rows.remove(0).1;
                (read(body).unwrap_err().field, serde_json::to_value(read(whole).unwrap()).unwrap())
            } else {
                let read = |b: Value| serde_json::from_value::<StockInvestorNetSharesResponse>(b).unwrap().days().rows.remove(0).1;
                (read(body).unwrap_err().field, serde_json::to_value(read(whole).unwrap()).unwrap())
            }
        };
        let mut named = Vec::new();
        for kiwoom in fields(&foreign).into_iter().filter(|k| ["poss_stkcnt", "wght"].contains(&k.as_str())) {
            named.push(failed_field("stk_frgnr", &foreign, &kiwoom));
        }
        for kiwoom in fields(&investor) {
            named.push(failed_field("stk_invsr_orgn", &investor, &kiwoom));
        }
        assert_eq!(named.len(), 14);
        for (field, day) in &named {
            assert!(day.get(*field).is_some(), "{field}는 응답 JSON의 키여야 한다: {day}");
        }
        let distinct: BTreeSet<&str> = named.iter().map(|(f, _)| *f).collect();
        assert_eq!(distinct.len(), 14, "필드마다 다른 이름이다");
    }

    fn listing(name: &str) -> Vec<(String, Listing)> {
        let resp: StockListResponse = serde_json::from_str(&fixture(name)).unwrap();
        resp.list.iter().map(|r| (r.code.clone(), classify(r))).collect()
    }

    fn kind_of(list: &[(String, Listing)], code: &str) -> Option<(SymbolKind, Market)> {
        match &list.iter().find(|(c, _)| c == code).unwrap().1 {
            Listing::Include(i) => Some((i.kind, i.market)),
            _ => None,
        }
    }

    #[test]
    fn exchange_list_is_filtered_by_market_code() {
        let l = listing("ka10099_0");
        use {Market::Kospi, SymbolKind::*};
        assert_eq!(kind_of(&l, "005930"), Some((Common, Kospi)));
        assert_eq!(kind_of(&l, "005935"), Some((Preferred, Kospi)));
        assert_eq!(kind_of(&l, "02826K"), Some((Preferred, Kospi)));
        assert_eq!(kind_of(&l, "0126Z0"), Some((Common, Kospi)));
        assert_eq!(kind_of(&l, "0000D0"), Some((Etf, Kospi)));
        assert_eq!(kind_of(&l, "102780"), Some((Etf, Kospi)));
        assert_eq!(kind_of(&l, "0030R0"), Some((Reit, Kospi)));
        assert_eq!(kind_of(&l, "088980"), Some((Infrastructure, Kospi)));
        assert_eq!(kind_of(&l, "094800"), Some((MutualFund, Kospi)));
        for etn in ["520100", "500095", "520066"] {
            assert_eq!(kind_of(&l, etn), Some((Etn, Kospi)), "{etn}");
        }
        assert!(l.iter().all(|(_, x)| !matches!(x, Listing::Unknown(_))));
    }

    #[test]
    fn kosdaq_preferred_by_code_and_spac_is_common() {
        let l = listing("ka10099_10");
        use {Market::Kosdaq, SymbolKind::*};
        assert_eq!(kind_of(&l, "03481K"), Some((Preferred, Kosdaq)));
        assert_eq!(kind_of(&l, "021045"), Some((Preferred, Kosdaq)));
        for common in ["159910", "294090", "458650", "0004Y0", "0205H0", "473000", "247540"] {
            assert_eq!(kind_of(&l, common), Some((Common, Kosdaq)), "{common}");
        }
    }

    #[test]
    fn spac_rule_wins_over_code_rule_and_unknown_market_is_reported() {
        let spac = ListingRow { code: "12345K".into(), name: "가나스팩".into(), market_code: "10".into(), ..Default::default() };
        assert!(matches!(classify(&spac), Listing::Include(SymbolInfo { kind: SymbolKind::Common, .. })));
        let odd = ListingRow { code: "123450".into(), name: "x".into(), market_code: "77".into(), ..Default::default() };
        assert!(matches!(classify(&odd), Listing::Unknown(_)));
        let info = ListingRow::from(serde_json::from_str::<WireListRow>(&fixture("ka10100_005930")).unwrap());
        assert!(matches!(classify(&info), Listing::Include(SymbolInfo { kind: SymbolKind::Common, .. })));
    }

    #[test]
    fn a_screener_listing_takes_the_market_of_the_list_and_reads_the_zero_padded_list_count_as_listed_shares() {
        let rows = |name: &str| serde_json::from_str::<StockListResponse>(&fixture(name)).unwrap().list;
        let (kospi, kosdaq) = (rows("ka10099_0"), rows("ka10099_10"));
        let listing = |row: &ListingRow| match classify(row) {
            Listing::Include(info) => screener_listing(row, &info).unwrap(),
            other => panic!("{other:?}"),
        };
        let of = |rows: &[ListingRow], code: &str| {
            let l = listing(rows.iter().find(|r| r.code == code).unwrap());
            (l.market, l.listed_shares.map(NonZeroU64::get))
        };
        assert_eq!(of(&kospi, "000020"), (api::Market::Kospi, Some(27_931_470)));
        assert_eq!(of(&kospi, "0000D0"), (api::Market::Kospi, Some(6_350_000)), "ETF는 코스피다");
        assert_eq!(of(&kosdaq, "03481K"), (api::Market::Kosdaq, Some(1_377_453)));

        let dongwha = kospi.iter().find(|r| r.code == "000020").unwrap();
        let shares = |list_count: &str| listing(&ListingRow { list_count: list_count.into(), ..dongwha.clone() }).listed_shares;
        assert_eq!([shares(""), shares("0000000000000000"), shares("27,931,470"), shares("-1")], [None; 4], "없거나 0이거나 수가 아니면 상장주식수를 모른다");
    }

    #[test]
    fn each_audit_label_in_a_row_becomes_its_own_exclusion_in_the_screener_listing() {
        let listed = |audit_info: &str| {
            let row = ListingRow { code: "005930".into(), name: "가상".into(), market_code: "0".into(), audit_info: audit_info.into(), ..Default::default() };
            let Listing::Include(info) = classify(&row) else { panic!() };
            screener_listing(&row, &info).unwrap().excludable_as
        };
        use ExcludeKind::*;
        assert_eq!(listed("관리종목"), [Managed]);
        assert_eq!(listed("투자주의환기종목"), [InvestmentCautionAlert]);
        assert_eq!(listed("투자경고"), [InvestmentWarning]);
        assert_eq!(listed("투자위험"), [InvestmentDanger]);
        assert_eq!(listed("투자주의"), [InvestmentCaution]);
        assert_eq!(listed("단기과열"), [ShortTermOverheated]);
        assert_eq!(listed("거래정지"), [TradingHalted]);
        assert_eq!(listed("정상"), []);
        assert_eq!(listed("관리종목|신종상태|거래정지"), [Managed, TradingHalted], "모르는 상태는 빠지고 나머지는 남는다");
    }

    #[test]
    fn a_list_row_keeps_every_field_of_the_json_row() {
        let body = r#"{"list":[{"code":"12345K","name":"가나스팩","marketCode":"10","companyClassName":"스팩","nxtEnable":"Y","regDay":"20240102","auditInfo":"관리종목|거래정지","listCount":"0000000000001234"}]}"#;
        let response: StockListResponse = serde_json::from_str(body).unwrap();
        let want = ListingRow {
            code: "12345K".into(),
            name: "가나스팩".into(),
            market_code: "10".into(),
            company_class_name: "스팩".into(),
            nxt_enable: "Y".into(),
            reg_day: "20240102".into(),
            audit_info: "관리종목|거래정지".into(),
            list_count: "0000000000001234".into(),
        };
        assert_eq!(response.list, [want]);
    }

    #[test]
    fn the_kind_of_a_listed_product_becomes_its_screener_exclusion() {
        let kinds = |code: &str, name: &str, market_code: &str| {
            let row = ListingRow { code: code.into(), name: name.into(), market_code: market_code.into(), ..Default::default() };
            let Listing::Include(info) = classify(&row) else { panic!() };
            screener_listing(&row, &info).unwrap().excludable_as
        };
        use ExcludeKind::*;
        assert_eq!(kinds("0000D0", "가상", "8"), [Etf]);
        assert_eq!(kinds("0030R0", "가상", "6"), [Reit]);
        assert_eq!(kinds("005935", "가상", "0"), [Preferred]);
        assert_eq!(kinds("03481K", "가상", "10"), [Preferred]);
        assert_eq!(kinds("12345K", "가나스팩", "10"), [Spac]);
        assert_eq!(kinds("005930", "가나스팩", "0"), [], "스팩 제외는 코스닥 보통주에만 붙는다");
        assert_eq!(kinds("005930", "가상", "0"), []);
    }

    #[test]
    fn etn_infrastructure_and_mutual_fund_rows_become_screener_listings_with_their_exclusion() {
        let rows = serde_json::from_str::<StockListResponse>(&fixture("ka10099_0")).unwrap().list;
        use ExcludeKind::*;
        for (code, want) in [("520100", Etn), ("520066", Etn), ("500095", Etn), ("088980", Infrastructure), ("094800", MutualFund)] {
            let row = rows.iter().find(|r| r.code == code).unwrap();
            let Listing::Include(info) = classify(row) else { panic!("{code}") };
            let listing = screener_listing(row, &info).unwrap();
            assert_eq!((listing.market, listing.excludable_as), (api::Market::Kospi, vec![want]), "{code}");
        }
    }

    #[test]
    fn an_etn_row_keeps_its_audit_status_beside_its_kind() {
        let row = ListingRow { code: "520100".into(), name: "가상".into(), market_code: "60".into(), audit_info: "관리종목".into(), ..Default::default() };
        let Listing::Include(info) = classify(&row) else { panic!() };
        assert_eq!(screener_listing(&row, &info).unwrap().excludable_as, [ExcludeKind::Etn, ExcludeKind::Managed]);
    }

    #[test]
    fn token_expiry() {
        let t: TokenResponse = serde_json::from_str(&fixture("au10001_ok")).unwrap();
        let at = parse_kst_datetime(&t.expires_dt).unwrap();
        assert_eq!(at.kst_date(), KstDate::new(2026, 11, 9).unwrap());
        assert_eq!(at.kst_time_of_day(), TimeOfDay::hms(22, 48, 6).unwrap());
        assert!(parse_kst_datetime("2026110922480").is_none());
    }

    fn ack(text: &str) -> Result<(), WsRejection> {
        match parse_ws_frame(text).unwrap() {
            WsFrame::Ack { result, .. } => result,
            other => panic!("{other:?}"),
        }
    }

    fn category(text: &str) -> crate::kiwoom::error::Category {
        ack(text).unwrap_err().category
    }

    #[test]
    fn ws_ack_return_code_is_an_int_or_a_numeric_string_and_nothing_else() {
        use crate::kiwoom::error::Category::*;
        assert_eq!(parse_ws_frame(r#"{"trnm":"LOGIN","return_code":0,"return_msg":"","sor_yn":"Y"}"#).unwrap(), WsFrame::Ack { control: WsControl::Login, result: Ok(()) });
        assert_eq!(ack(r#"{"trnm":"REG","return_code":"0","return_msg":""}"#), Ok(()));
        assert_eq!(ack(r#"{"trnm":"REMOVE","return_code":"0000"}"#), Ok(()));
        assert_eq!(category(r#"{"trnm":"REMOVE","return_code":105112,"return_msg":"실시간 항목 해지에 실패했습니다 (ERROR=서비스를 처리하는 중에 오류가 발생했습니다)"}"#), ControlRejected);
        assert_eq!(category(r#"{"trnm":"REG","return_code":"105118","return_msg":"등록 종목이 그룹번호에 등록할 수 있는 허용 개수(200)를 초과했습니다"}"#), RealtimeCapacity);
        assert_eq!(category(r#"{"trnm":"REG","return_code":105115}"#), RealtimeCapacity);
        for missing in [r#"{"trnm":"LOGIN"}"#, r#"{"trnm":"LOGIN","return_code":null}"#, r#"{"trnm":"LOGIN","return_code":""}"#, r#"{"trnm":"LOGIN","return_code":"ok"}"#, r#"{"trnm":"LOGIN","return_code":true}"#, r#"{"trnm":"LOGIN","return_code":0,"return_msg":5}"#] {
            assert_eq!(category(missing), Protocol, "{missing}: 성공이 아니다");
        }
        assert_eq!(category(r#"{"trnm":"LOGIN","return_code":-1}"#), Unknown);
    }

    #[test]
    fn ws_login_token_invalid_is_read_from_the_message() {
        use crate::kiwoom::error::Category::*;
        let code_eq = ack(r#"{"trnm":"LOGIN","return_code":3,"return_msg":"인증에 실패했습니다 (CODE=8005, Token이 유효하지 않습니다)"}"#).unwrap_err();
        assert_eq!((code_eq.category, code_eq.return_code, code_eq.detail), (TokenInvalid, Some(3), Some(8005)));
        assert_eq!(category(r#"{"trnm":"LOGIN","return_code":"3","return_msg":"인증에 실패했습니다[8005:Token이 유효하지 않습니다]"}"#), TokenInvalid);
        assert_eq!(category(r#"{"trnm":"LOGIN","return_code":3,"return_msg":"(CODE=8103)"}"#), AuthBlocked);
        assert_eq!(category(r#"{"trnm":"LOGIN","return_code":3,"return_msg":"(CODE=80051)"}"#), Unknown, "네 자리가 아니면 상세가 아니다");
    }

    #[test]
    fn ws_frames_other_than_acks() {
        assert_eq!(parse_ws_frame(r#"{"trnm":"PING"}"#).unwrap(), WsFrame::Ping);
        assert_eq!(parse_ws_frame(r#"{"trnm":"SYSTEM","code":"x"}"#).unwrap(), WsFrame::Other("SYSTEM".into()));
        for bad in ["", "[]", "PING", r#"{"return_code":0}"#, r#"{"trnm":"REAL"}"#] {
            assert!(parse_ws_frame(bad).is_err(), "{bad:?}");
        }
    }

    fn real(kind: &str, item: &str, values: Value) -> Vec<Result<RealItem, WireError>> {
        let text = json!({"trnm": "REAL", "data": [{"type": kind, "name": "", "item": item, "values": values}]}).to_string();
        match parse_ws_frame(&text).unwrap() {
            WsFrame::Real(items) => items,
            other => panic!("{other:?}"),
        }
    }

    fn one(kind: &str, item: &str, values: Value) -> Result<RealItem, WireError> {
        real(kind, item, values).remove(0)
    }

    #[test]
    fn real_0b_is_a_combined_trade_with_abs_price_and_qty() {
        let code = StockCode::parse("005930").unwrap();
        let day = Some(DayTotals { change_centi: 0, cumulative: Volume(100) });
        let tick = |exchange| RealTick { symbol: Symbol::Stock(code), hhmmss: TimeOfDay::hms(9, 30, 1).unwrap(), price: Price::from_centi(7_120_000).unwrap(), qty: Volume(15), exchange, day, strength_centi: None, same_time_ratio_centi: None, side: None };
        let sell = |exchange| RealTick { side: Some(TradeSide::Sell), ..tick(exchange) };
        assert_eq!(one("0B", "005930_AL", trade_values("093001", -71_200, -15, 100, "NXT")), Ok(RealItem::Trade(sell(Some(Exchange::Nxt)))));
        let mut buy = trade_values("093001", 71_200, 15, 100, "KRX");
        buy["15"] = "+15".into();
        assert_eq!(one("0B", "005930_AL", buy), Ok(RealItem::Trade(RealTick { side: Some(TradeSide::Buy), ..tick(Some(Exchange::Krx)) })));
        assert_eq!(one("0B", "005930_AL", trade_values("093001", 71_200, 15, 100, "KRX")), Ok(RealItem::Trade(tick(Some(Exchange::Krx)))));
        assert_eq!(one("0B", "005930_AL", trade_values("093001", 71_200, 15, 100, "1")), Ok(RealItem::Trade(tick(None))));
        assert_eq!(one("0B", "005930_AL", trade_values("093001", 71_200, 0, 100, "KRX")), Ok(RealItem::AuctionOnly));
    }

    #[test]
    fn real_0b_day_totals_are_the_signed_change_and_the_cumulative_volume() {
        let day = |values: Value| match one("0B", "005930_AL", values) {
            Ok(RealItem::Trade(tick)) => tick.day,
            other => panic!("{other:?}"),
        };
        let mut v = trade_values("093001", -193_400, 15, 56_147_847, "KRX");
        v["11"] = "-8100".into();
        assert_eq!(day(v.clone()), Some(DayTotals { change_centi: -810_000, cumulative: Volume(56_147_847) }));
        for (fid, bad) in [("11", "x"), ("13", "")] {
            let mut broken = v.clone();
            broken[fid] = bad.into();
            assert_eq!(day(broken), None, "{fid}={bad:?}: 체결은 그대로 받고 그날 값만 없다");
        }
        v.as_object_mut().unwrap().remove("11");
        assert_eq!(day(v), None);
    }

    #[test]
    fn real_0b_that_cannot_be_read_is_an_error() {
        let ok = trade_values("093001", 71_200, 15, 100, "KRX");
        assert!(one("0B", "005930", ok.clone()).is_err(), "_AL만 등록한다");
        assert!(one("0B", "00593_AL", ok.clone()).is_err());
        for (fid, bad) in [("20", "093060"), ("20", "9301"), ("10", "0"), ("10", "x"), ("15", "")] {
            let mut v = ok.clone();
            v[fid] = bad.into();
            assert!(one("0B", "005930_AL", v).is_err(), "{fid}={bad:?}");
        }
        let mut no_time = ok.clone();
        no_time.as_object_mut().unwrap().remove("20");
        assert!(one("0B", "005930_AL", no_time).is_err());
    }

    #[test]
    fn real_0j_level_is_a_signed_decimal_and_volume_is_cumulative() {
        let index = IndexCode::KOSPI;
        let at = TimeOfDay::hms(10, 56, 2).unwrap();
        assert_eq!(one("0J", "001", index_values("105602", -505_969, 28_264)), Ok(RealItem::Index { index, hhmmss: at, price: Price::from_centi(505_969).unwrap(), cumulative: 28_264, change_centi: None }));
        let change = |s: &str| match one("0J", "150", json!({"20": "105602", "10": "-1327.93", "11": s, "13": "28264"})) {
            Ok(RealItem::Index { change_centi, .. }) => change_centi,
            other => panic!("{other:?}"),
        };
        assert_eq!((change("-43.69"), change("+0.5"), change("0.00"), change("x")), (Some(-4_369), Some(50), Some(0), None));
        let level = |s: &str| one("0J", "001", json!({"20": "105602", "10": s, "13": "1"})).map(|i| match i {
            RealItem::Index { price, .. } => price.centi(),
            other => panic!("{other:?}"),
        });
        assert_eq!(level("-1327.93"), Ok(132_793));
        assert_eq!(level("+1327.9"), Ok(132_790));
        assert_eq!(level("1327"), Ok(132_700));
        for bad in ["1327.931", "0.00", ".5", "+", "1,327.93", "13a7.93"] {
            assert!(level(bad).is_err(), "{bad:?}");
        }
        assert!(one("0J", "001_AL", index_values("105602", 1, 1)).is_err());
    }

    #[test]
    fn real_frames_keep_each_item_separately() {
        let text = json!({"trnm": "REAL", "data": [
            {"type": "0B", "item": "005930_AL", "values": trade_values("093001", 71_200, 15, 100, "KRX")},
            {"type": "0B", "item": "005930_AL", "values": {"20": "x"}},
            {"type": "0g", "item": "005930_AL", "values": {}},
        ]}).to_string();
        let WsFrame::Real(items) = parse_ws_frame(&text).unwrap() else { panic!() };
        assert!(matches!(items.as_slice(), [Ok(RealItem::Trade(_)), Err(_), Ok(RealItem::OtherType(k))] if k == "0g"));
    }

    #[test]
    fn reg_and_remove_messages() {
        let stock = Symbol::Stock(StockCode::parse("005930").unwrap());
        let both: Registrations = [(RealType::Trade, stock), (RealType::Index, Symbol::Index(IndexCode::KOSPI))].into();
        let v: Value = serde_json::from_str(&reg_message(&both)).unwrap();
        assert_eq!(v, json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [{"item": ["005930_AL"], "type": ["0B"]}, {"item": ["001"], "type": ["0J"]}]}));
        let v: Value = serde_json::from_str(&reg_message(&[(RealType::Index, Symbol::Index(IndexCode::KOSDAQ))].into())).unwrap();
        assert_eq!(v["data"], json!([{"item": ["101"], "type": ["0J"]}]), "빈 원소는 넣지 않는다");
        let v: Value = serde_json::from_str(&reg_message(&[(RealType::Book, stock), (RealType::Program, stock), (RealType::Broker, stock)].into())).unwrap();
        assert_eq!(v["data"], json!([{"item": ["005930_AL"], "type": ["0D"]}, {"item": ["005930_AL"], "type": ["0w"]}, {"item": ["005930_AL"], "type": ["0F"]}]));
        let v: Value = serde_json::from_str(&reg_message(&[(RealType::Book, stock), (RealType::AfterHours, stock)].into())).unwrap();
        assert!(v["data"].as_array().unwrap().contains(&json!({"item": ["005930_AL"], "type": ["0E"]})));
        assert_eq!(RealType::AfterHours.as_wire(), "0E");
        let v: Value = serde_json::from_str(&remove_message(RealType::Trade, &[stock].into())).unwrap();
        assert_eq!(v, json!({"trnm": "REMOVE", "grp_no": "1", "data": [{"item": ["005930_AL"], "type": ["0B"]}]}));
        let login: Value = serde_json::from_str(login_message(&Secret::new("t".into())).expose()).unwrap();
        assert_eq!(login, json!({"trnm": "LOGIN", "token": "t"}));
    }

    fn book_values() -> Value {
        let mut values = json!({"21": "093001", "23": "71150", "24": "300", "121": "5100", "125": "4200"});
        for depth in 1..=10_i64 {
            values[(40 + depth).to_string()] = json!(format!("+{}", 71_000 + depth * 100));
            values[(50 + depth).to_string()] = json!(format!("-{}", 71_000 - (depth - 1) * 100));
            values[(60 + depth).to_string()] = json!((100 * depth).to_string());
            values[(70 + depth).to_string()] = json!((10 * depth).to_string());
        }
        values
    }

    fn book(result: Result<RealItem, WireError>) -> BookSnapshot {
        match result {
            Ok(RealItem::Book(book)) => *book,
            other => panic!("호가가 아니다: {other:?}"),
        }
    }

    fn after_hours(result: Result<RealItem, WireError>) -> AfterHoursTotals {
        match result {
            Ok(RealItem::AfterHours(totals)) => totals,
            other => panic!("시간외 호가가 아니다: {other:?}"),
        }
    }

    #[test]
    fn parses_0e_into_after_hours_totals() {
        let totals = after_hours(one("0E", "005930_AL", json!({"21": "083512", "131": "13770", "132": "+500", "135": "0", "136": "0"})));
        assert_eq!(totals, AfterHoursTotals { symbol: Symbol::Stock(StockCode::parse("005930").unwrap()), hhmmss: TimeOfDay::hms(8, 35, 12).unwrap(), total_ask_qty: Volume(13_770), total_bid_qty: Volume(0) });
        let blank = after_hours(one("0E", "005930_AL", json!({"21": "083512", "131": "13770", "135": ""})));
        assert_eq!((blank.total_ask_qty, blank.total_bid_qty), (Volume(13_770), Volume(0)));
        assert!(one("0E", "005930_AL", json!({"131": "1", "135": "1"})).is_err(), "호가시간이 없다");
        assert!(one("0E", "005930_AL", json!({"21": "8:35", "131": "1", "135": "1"})).is_err(), "호가시간을 읽을 수 없다");
        assert!(one("0E", "005930", json!({"21": "083512", "131": "1", "135": "1"})).is_err(), "_AL이 아니다");
    }

    #[test]
    fn the_book_item_code_says_which_venue_it_is() {
        let samsung = Symbol::Stock(StockCode::parse("005930").unwrap());
        let venue_of = |item: &str| {
            let book = book(one("0D", item, book_values()));
            (book.symbol, book.venue)
        };
        assert_eq!(venue_of("005930_AL"), (samsung, Venue::Combined));
        assert_eq!(venue_of("005930"), (samsung, Venue::Krx));
        assert_eq!(venue_of("005930_NX"), (samsung, Venue::Nxt));
        assert!(one("0E", "005930_NX", json!({"21": "083512", "131": "1", "135": "1"})).is_err(), "0E는 통합 코드만 받는다");
    }

    #[test]
    fn venue_books_register_and_remove_their_own_item_code() {
        let stock = Symbol::Stock(StockCode::parse("005930").unwrap());
        let registrations: Registrations = [(RealType::Trade, stock), (RealType::BookKrx, stock), (RealType::BookNxt, stock), (RealType::AfterHours, stock)].into();
        let v: Value = serde_json::from_str(&reg_message(&registrations)).unwrap();
        assert_eq!(v["data"], json!([
            {"item": ["005930_AL"], "type": ["0B"]},
            {"item": ["005930_AL"], "type": ["0E"]},
            {"item": ["005930"], "type": ["0D"]},
            {"item": ["005930_NX"], "type": ["0D"]},
        ]));
        let v: Value = serde_json::from_str(&remove_message(RealType::BookNxt, &[stock].into())).unwrap();
        assert_eq!(v["data"], json!([{"item": ["005930_NX"], "type": ["0D"]}]));
        assert!(RealType::BookKrx.has_own_code() && RealType::BookNxt.has_own_code() && !RealType::Book.has_own_code());
        assert_eq!((RealType::BookKrx.companion(), RealType::Trade.companion()), (Some(RealType::AfterHours), None));
    }

    #[test]
    fn parses_book_frame_into_ten_levels() {
        let book = book(one("0D", "005930_AL", book_values()));
        let level = |won: u64, qty: u64| Some(BookLevel { price: Price::from_centi(won * 100).unwrap(), qty: Volume(qty) });
        assert_eq!((book.symbol, book.hhmmss), (Symbol::Stock(StockCode::parse("005930").unwrap()), TimeOfDay::hms(9, 30, 1).unwrap()));
        assert_eq!((book.asks[0], book.asks[9]), (level(71_100, 100), level(72_000, 1_000)));
        assert_eq!((book.bids[0], book.bids[9]), (level(71_000, 10), level(70_100, 100)));
        assert_eq!((book.total_ask_qty, book.total_bid_qty), (Volume(5_100), Volume(4_200)));
        assert_eq!(book.expected, Some(ExpectedTrade { price: Price::from_centi(7_115_000).unwrap(), qty: Volume(300) }));
    }

    #[test]
    fn a_crossed_book_is_read_as_it_comes() {
        let mut values = book_values();
        values["41"] = json!("+70900");
        values["51"] = json!("-71000");
        let book = book(one("0D", "005930_AL", values));
        assert!(book.bids[0].unwrap().price > book.asks[0].unwrap().price);
    }

    #[test]
    fn book_levels_without_a_price_are_absent_and_expected_values_may_be_zero() {
        let mut values = book_values();
        values["59"] = json!("0");
        values["60"] = json!("");
        values["23"] = json!("0");
        values["24"] = json!("0");
        let book = book(one("0D", "005930_AL", values));
        assert!(book.bids[8].is_none() && book.bids[9].is_none());
        assert!(book.bids[7].is_some() && book.asks.iter().all(Option::is_some));
        assert_eq!(book.expected, None);
    }

    #[test]
    fn a_book_frame_needs_a_time_a_stock_code_and_readable_numbers() {
        let mut no_time = book_values();
        no_time.as_object_mut().unwrap().remove("21");
        assert!(one("0D", "005930_AL", no_time).is_err());
        assert!(one("0D", "5930", book_values()).is_err());
        assert!(one("0D", "005930_XX", book_values()).is_err());
        let mut garbage = book_values();
        garbage["61"] = json!("x");
        assert!(one("0D", "005930_AL", garbage).is_err());
    }

    #[test]
    fn parses_program_frame() {
        let values = json!({"20": "093002", "10": "+71200", "202": "100", "204": "7", "206": "300", "208": "21", "210": "200", "211": "-5", "212": "14", "213": "-1"});
        let Ok(RealItem::Program(row)) = one("0w", "005930_AL", values) else { panic!() };
        assert_eq!(row, RealProgramTrade {
            symbol: Symbol::Stock(StockCode::parse("005930").unwrap()),
            hhmmss: TimeOfDay::hms(9, 30, 2).unwrap(),
            price: Price::from_centi(7_120_000),
            sell_qty: Volume(100),
            sell_amount_million_won: 7,
            buy_qty: Volume(300),
            buy_amount_million_won: 21,
            net_buy_qty: 200,
            net_buy_qty_change: -5,
            net_buy_amount_million_won: 14,
            net_buy_amount_change_million_won: -1,
        });
        assert!(one("0w", "005930_AL", json!({"10": "71200"})).is_err(), "시각이 없다");
    }

    #[test]
    fn parses_broker_frame_with_member_names() {
        let values = json!({
            "141": "미래에셋", "142": "키움", "146": "001", "147": "002", "161": "5000", "162": "4000", "166": "-30", "167": "+12",
            "151": "삼성", "156": "003", "171": "3000", "176": "9",
            "143": "이름만", "148": "",
        });
        let Ok(RealItem::Broker(snapshot)) = one("0F", "005930_AL", values) else { panic!() };
        let entry = |code: &str, name: &str, cumulative: u64, change: i64| BrokerEntry { member_code: code.into(), member_name: name.into(), cumulative_qty: Volume(cumulative), change_qty: change };
        assert_eq!(snapshot.sells, [entry("001", "미래에셋", 5_000, -30), entry("002", "키움", 4_000, 12)]);
        assert_eq!(snapshot.buys, [entry("003", "삼성", 3_000, 9)]);
        let Ok(RealItem::Broker(empty)) = one("0F", "005930_AL", json!({})) else { panic!() };
        assert!(empty.sells.is_empty() && empty.buys.is_empty());
    }

    #[test]
    fn a_book_frame_with_an_unreadable_expected_quantity_keeps_its_levels() {
        let mut values = book_values();
        values["24"] = json!("x");
        let book = book(one("0D", "005930_AL", values));
        assert_eq!(book.expected, None);
        assert!(book.asks.iter().all(Option::is_some));
    }

    #[test]
    fn a_book_price_sent_as_a_json_number_is_read_not_dropped() {
        let mut values = book_values();
        values["41"] = json!(71_100);
        let book = book(one("0D", "005930_AL", values));
        assert_eq!(book.asks[0].unwrap().price, Price::from_centi(7_110_000).unwrap());
    }

    #[test]
    fn a_broker_frame_whose_values_are_not_an_object_is_rejected() {
        assert!(one("0F", "005930_AL", Value::Null).is_err());
        assert!(one("0F", "005930_AL", json!("x")).is_err());
    }
}
