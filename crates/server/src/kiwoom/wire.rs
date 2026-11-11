//! 키움 응답 → `domain` 타입(backend.md §4.6). 숫자는 모두 문자열로 오고, 가격 부호는 믿지 않는다.

use std::collections::BTreeSet;
use std::fmt;

use domain::{Bucket, IndexCode, KstDate, KstTime, Market, Ohlcv, Period, Price, StockCode, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Venue, Volume};
use serde::Deserialize;
use serde_json::{Value, json};

use super::api::kiwoom_stock_code;
use crate::api::ExcludeKind;
use super::error::{WsRejection, judge_ws_ack};
use super::stream::{DayTotals, Exchange, RealTick};
use crate::config::Secret;

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
chart_body!(IndexMinuteChartResponse, inds_min_pole_qry, IndexCenti, DateTime);
chart_body!(IndexDailyChartResponse, inds_dt_pole_qry, IndexCenti, Date);
chart_body!(IndexWeeklyChartResponse, inds_stk_pole_qry, IndexCenti, Date);
chart_body!(IndexMonthlyChartResponse, inds_mth_pole_qry, IndexCenti, Date);

/// 키움에서 받은 봉. 가장 늦은 봉은 진행 중인 구간일 수 있다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KiwoomBar {
    pub bucket: Bucket,
    pub ohlcv: Ohlcv,
}

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
    s.trim_start_matches(['+', '-']).parse().map_err(|_| WireError(format!("숫자가 아닙니다: {s:?}")))
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
    pub list: Vec<ListRow>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ListRow {
    pub code: String,
    pub name: String,
    pub market_code: String,
    pub company_class_name: String,
    pub nxt_enable: String,
    pub reg_day: String,
    pub audit_info: String,
}

/// ka10099 한 행을 가른 결과(§6.6 표).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listing {
    Include(SymbolInfo),
    /// ETN, 인프라투자금융, 뮤추얼펀드처럼 일부러 넣지 않는 상품.
    Exclude,
    /// 표에 없는 marketCode 또는 코드 형식이 아닌 행. 넣지 않고 경고한다.
    Unknown(String),
}

pub fn classify(row: &ListRow) -> Listing {
    let Ok(code) = StockCode::parse(&row.code) else {
        return Listing::Unknown(format!("종목코드 형식이 아닙니다: {:?}", row.code));
    };
    let stock_kind = |code: StockCode| if code.is_preferred_code() { SymbolKind::Preferred } else { SymbolKind::Common };
    let (kind, market) = match row.market_code.as_str() {
        "0" => (stock_kind(code), Market::Kospi),
        "8" => (SymbolKind::Etf, Market::Kospi),
        "6" => (SymbolKind::Reit, Market::Kospi),
        "10" if is_spac(row) => (SymbolKind::Common, Market::Kosdaq),
        "10" => (stock_kind(code), Market::Kosdaq),
        "60" | "70" | "90" | "2" | "4" => return Listing::Exclude,
        other => return Listing::Unknown(format!("모르는 marketCode {other:?}({} {})", row.code, row.name)),
    };
    Listing::Include(SymbolInfo { symbol: Symbol::Stock(code), name: row.name.clone(), kind, market, nxt_enabled: row.nxt_enable == "Y" })
}

/// 스팩은 코스닥 보통주로 둔다(D13). 가리는 규칙은 kiwoom.md §5.
fn is_spac(row: &ListRow) -> bool {
    row.company_class_name == "스팩" || row.name.contains("스팩") || row.name.contains("기업인수목적")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenerListing {
    pub code: StockCode,
    pub name: String,
    pub listed_on: Option<KstDate>,
    pub excludable_as: Vec<ExcludeKind>,
}

pub fn screener_listing(row: &ListRow, info: &SymbolInfo) -> Option<ScreenerListing> {
    let Symbol::Stock(code) = info.symbol else {
        return None;
    };
    let kind = match info.kind {
        SymbolKind::Etf => Some(ExcludeKind::Etf),
        SymbolKind::Reit => Some(ExcludeKind::Reit),
        SymbolKind::Preferred => Some(ExcludeKind::Preferred),
        SymbolKind::Common if info.market == Market::Kosdaq && is_spac(row) => Some(ExcludeKind::Spac),
        SymbolKind::Common | SymbolKind::Index => None,
    };
    let states = row.audit_info.split('|').map(str::trim).filter_map(|label| match audit_state(label) {
        Ok(state) => state,
        Err(()) => {
            tracing::warn!(code = %row.code, label, "auditInfo에 모르는 상태가 있어 상태 제외에 넣지 않습니다");
            None
        }
    });
    Some(ScreenerListing { code, name: info.name.clone(), listed_on: KstDate::parse_yyyymmdd(&row.reg_day), excludable_as: kind.into_iter().chain(states).collect() })
}

fn audit_state(label: &str) -> Result<Option<ExcludeKind>, ()> {
    Ok(Some(match label {
        "정상" | "" => return Ok(None),
        "관리종목" => ExcludeKind::Managed,
        "투자주의환기종목" => ExcludeKind::InvestmentCautionAlert,
        "투자경고" => ExcludeKind::InvestmentWarning,
        "투자위험" => ExcludeKind::InvestmentDanger,
        "투자주의" => ExcludeKind::InvestmentCaution,
        "단기과열" => ExcludeKind::ShortTermOverheated,
        "거래정지" => ExcludeKind::TradingHalted,
        _ => return Err(()),
    }))
}

/// ka10095 응답. 행 순서는 요청 순서였지만(kiwoom.md §10.6) 호출자는 `stk_cd`로 맞춘다.
#[derive(Debug, Deserialize)]
pub struct StockQuotesResponse {
    #[serde(default)]
    pub atn_stk_infr: Vec<QuoteRow>,
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

/// ka10095 한 행의 통합 시세. 가격은 centi(원 × 100)다. 거래정지 종목은 현재가가 0일 수 있어 `Price`가 아니다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StockQuote {
    pub code: StockCode,
    pub price_centi: u64,
    /// 기준가(`base_pric`). 등락은 현재가 − 기준가다(backend.md §4.6 "현재가의 등락").
    pub base_centi: u64,
    pub volume: Volume,
    pub at: KstTime,
}

/// 빈 행(없는 코드, NXT 불가 종목의 `_NX`, kiwoom.md §12.4)과 통합(`_AL`)이 아닌 행은 뺀다.
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

fn parse_quote_row(r: &QuoteRow) -> Result<StockQuote, WireError> {
    let code = r.stk_cd.strip_suffix("_AL").ok_or_else(|| WireError(format!("통합 시세(_AL)가 아닙니다: {:?}", r.stk_cd)))?;
    let code = StockCode::parse(code).map_err(|e| WireError(format!("{e}: {:?}", r.stk_cd)))?;
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
    Ok(StockQuote { code, price_centi, base_centi, volume: Volume(unsigned(&r.trde_qty)?), at })
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
    #[serde(rename = "250hgst")]
    high_250: String,
    #[serde(rename = "250lwst")]
    low_250: String,
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
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "BasicInfoRow")]
pub enum StockBasicInfoResponse {
    UnknownSymbol,
    Found { kiwoom_code: String, fundamentals: StockFundamentals },
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
            high_250_won: optional(&r.high_250, unsigned)?,
            low_250_won: optional(&r.low_250, unsigned)?,
        };
        Ok(StockBasicInfoResponse::Found { kiwoom_code: r.stk_cd, fundamentals })
    }
}

fn optional<T>(s: &str, parse: fn(&str) -> Result<T, WireError>) -> Result<Option<T>, WireError> {
    if s.trim().is_empty() { Ok(None) } else { parse(s.trim()).map(Some) }
}

fn signed(s: &str) -> Result<i64, WireError> {
    s.strip_prefix('+').unwrap_or(s).parse().map_err(|_| WireError(format!("정수가 아닙니다: {s:?}")))
}

fn decimal(s: &str) -> Result<f64, WireError> {
    s.parse::<f64>().ok().filter(|x| x.is_finite()).ok_or_else(|| WireError(format!("소수가 아닙니다: {s:?}")))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RealType {
    Trade,
    Index,
}

impl RealType {
    pub fn of(symbol: Symbol) -> RealType {
        match symbol {
            Symbol::Stock(_) => RealType::Trade,
            Symbol::Index(_) => RealType::Index,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            RealType::Trade => "0B",
            RealType::Index => "0J",
        }
    }
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
    /// 0J. 체결량은 `13`(누적거래량)의 증가분이라 세션이 앞 프레임과 비교해 정한다.
    Index { index: IndexCode, hhmmss: TimeOfDay, price: Price, cumulative: u64, change_centi: Option<i64> },
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
            let qty = unsigned(field("15")?)?;
            if qty == 0 {
                return Ok(RealItem::AuctionOnly);
            }
            let exchange = match values.get("9081").and_then(Value::as_str) {
                Some("KRX") => Some(Exchange::Krx),
                Some("NXT") => Some(Exchange::Nxt),
                _ => None,
            };
            let day = (|| {
                let change_centi = signed(field("11").ok()?).ok()?.checked_mul(100)?;
                Some(DayTotals { change_centi, cumulative: Volume(unsigned(field("13").ok()?).ok()?) })
            })();
            Ok(RealItem::Trade(RealTick { symbol: Symbol::Stock(code), hhmmss: hhmmss(field("20")?)?, price: stock_price(field("10")?)?, qty: Volume(qty), exchange, day }))
        }
        "0J" => {
            let index = IndexCode::parse(item).map_err(|e| WireError(format!("{e}: {item:?}")))?;
            let change_centi = field("11").ok().and_then(signed_level_centi);
            Ok(RealItem::Index { index, hhmmss: hhmmss(field("20")?)?, price: index_level(field("10")?)?, cumulative: unsigned(field("13")?)?, change_centi })
        }
        other => Ok(RealItem::OtherType(other.to_owned())),
    }
}

fn hhmmss(s: &str) -> Result<TimeOfDay, WireError> {
    let bad = || WireError(format!("체결시각이 HHMMSS가 아닙니다: {s:?}"));
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().expect("ASCII 숫자");
    TimeOfDay::hms(n(0..2), n(2..4), n(4..6)).ok_or_else(bad)
}

/// 0J 지수는 소수 2자리 문자열이고 앞에 등락 부호가 붙는다(kiwoom.md 11.5). REST 지수(100배 정수)와 다르다.
fn index_level(s: &str) -> Result<Price, WireError> {
    level_centi(s.trim_start_matches(['+', '-']))
        .and_then(Price::from_centi)
        .ok_or_else(|| WireError(format!("지수가 소수 2자리 이하의 양수가 아닙니다: {s:?}")))
}

fn signed_level_centi(s: &str) -> Option<i64> {
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

/// REG·REMOVE의 `item`. 주식은 거래소와 상관없이 `_AL` 하나만 받는다(ADR 0007).
fn real_item_code(symbol: Symbol) -> String {
    match symbol {
        Symbol::Stock(code) => kiwoom_stock_code(code, Venue::Combined),
        Symbol::Index(index) => index.as_str().to_owned(),
    }
}

fn real_entry(kind: RealType, symbols: impl Iterator<Item = Symbol>) -> Value {
    json!({"item": symbols.map(real_item_code).collect::<Vec<_>>(), "type": [kind.as_wire()]})
}

pub fn login_message(token: &Secret<String>) -> Secret<String> {
    Secret::new(json!({"trnm": "LOGIN", "token": token.expose()}).to_string())
}

pub fn reg_message(symbols: &BTreeSet<Symbol>) -> String {
    let data: Vec<Value> = [RealType::Trade, RealType::Index]
        .into_iter()
        .filter(|&kind| symbols.iter().any(|&s| RealType::of(s) == kind))
        .map(|kind| real_entry(kind, symbols.iter().copied().filter(move |&s| RealType::of(s) == kind)))
        .collect();
    json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": data}).to_string()
}

/// 0B와 0J를 한 REMOVE에 섞으면 105112로 실패한다(kiwoom.md §8). 그래서 종류 하나만 받는다.
pub fn remove_message(kind: RealType, symbols: &BTreeSet<Symbol>) -> String {
    json!({"trnm": "REMOVE", "grp_no": "1", "data": [real_entry(kind, symbols.iter().copied())]}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn basic_info(name: &str) -> StockFundamentals {
        match serde_json::from_str(&fixture(name)).unwrap() {
            StockBasicInfoResponse::Found { fundamentals, .. } => fundamentals,
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
                high_250_won: Some(380_000),
                low_250_won: Some(93_500),
            }
        );
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
    fn quotes_take_abs_price_and_base_and_skip_empty_and_non_combined_rows() {
        let body: StockQuotesResponse = serde_json::from_str(&fixture("ka10095_synthetic")).unwrap();
        let quotes = parse_quotes(body);
        let got: Vec<_> = quotes.iter().map(|q| (q.code.as_str(), q.price_centi, q.base_centi, q.volume.0)).collect();
        assert_eq!(got, [("005930", 5_000_000, 5_100_000, 1_234_567), ("000660", 12_050_000, 12_000_000, 765_432), ("035720", 4_200_000, 4_200_000, 1_000)], "005935_NX 빈 행은 빠진다");
        let at = KstTime::from_kst_civil(KstDate::parse_yyyymmdd("20261106").unwrap(), TimeOfDay::hms(19, 59, 59).unwrap());
        assert_eq!(quotes[0].at, at);

        let row = |stk_cd: &str, sig: &str| QuoteRow {
            stk_cd: stk_cd.into(), cur_prc: "-100".into(), base_pric: "90".into(), pred_pre_sig: sig.into(),
            trde_qty: "5".into(), dt: "20261106".into(), cntr_tm: "090000".into(), ..QuoteRow::default()
        };
        let mismatch = parse_quotes(StockQuotesResponse { atn_stk_infr: vec![row("005930_AL", "5")] });
        assert_eq!((mismatch[0].price_centi, mismatch[0].base_centi), (10_000, 9_000), "방향이 어긋나도 계산한 값을 쓴다");
        let krx_bad_time = vec![row("005930", "2"), row("005930_NX", "2"), QuoteRow { cntr_tm: "99".into(), ..row("000660_AL", "2") }];
        assert!(parse_quotes(StockQuotesResponse { atn_stk_infr: krx_bad_time }).is_empty());
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
        for excluded in ["088980", "094800", "520100", "500095", "520066"] {
            assert_eq!(kind_of(&l, excluded), None, "{excluded}");
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
        let spac = ListRow { code: "12345K".into(), name: "가나스팩".into(), market_code: "10".into(), ..Default::default() };
        assert!(matches!(classify(&spac), Listing::Include(SymbolInfo { kind: SymbolKind::Common, .. })));
        let odd = ListRow { code: "123450".into(), name: "x".into(), market_code: "77".into(), ..Default::default() };
        assert!(matches!(classify(&odd), Listing::Unknown(_)));
        let info: ListRow = serde_json::from_str(&fixture("ka10100_005930")).unwrap();
        assert!(matches!(classify(&info), Listing::Include(SymbolInfo { kind: SymbolKind::Common, .. })));
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
        let tick = |exchange| RealTick { symbol: Symbol::Stock(code), hhmmss: TimeOfDay::hms(9, 30, 1).unwrap(), price: Price::from_centi(7_120_000).unwrap(), qty: Volume(15), exchange, day };
        assert_eq!(one("0B", "005930_AL", fake_kiwoom::trade_0b("093001", -71_200, -15, 100, "NXT")), Ok(RealItem::Trade(tick(Some(Exchange::Nxt)))));
        assert_eq!(one("0B", "005930_AL", fake_kiwoom::trade_0b("093001", 71_200, 15, 100, "KRX")), Ok(RealItem::Trade(tick(Some(Exchange::Krx)))));
        assert_eq!(one("0B", "005930_AL", fake_kiwoom::trade_0b("093001", 71_200, 15, 100, "1")), Ok(RealItem::Trade(tick(None))));
        assert_eq!(one("0B", "005930_AL", fake_kiwoom::trade_0b("093001", 71_200, 0, 100, "KRX")), Ok(RealItem::AuctionOnly));
    }

    #[test]
    fn real_0b_day_totals_are_the_signed_change_and_the_cumulative_volume() {
        let day = |values: Value| match one("0B", "005930_AL", values) {
            Ok(RealItem::Trade(tick)) => tick.day,
            other => panic!("{other:?}"),
        };
        let mut v = fake_kiwoom::trade_0b("093001", -193_400, 15, 56_147_847, "KRX");
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
        let ok = fake_kiwoom::trade_0b("093001", 71_200, 15, 100, "KRX");
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
        assert_eq!(one("0J", "001", fake_kiwoom::tick_0j("105602", -505_969, 28_264)), Ok(RealItem::Index { index, hhmmss: at, price: Price::from_centi(505_969).unwrap(), cumulative: 28_264, change_centi: None }));
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
        assert!(one("0J", "001_AL", fake_kiwoom::tick_0j("105602", 1, 1)).is_err());
    }

    #[test]
    fn real_frames_keep_each_item_separately() {
        let text = json!({"trnm": "REAL", "data": [
            {"type": "0B", "item": "005930_AL", "values": fake_kiwoom::trade_0b("093001", 71_200, 15, 100, "KRX")},
            {"type": "0B", "item": "005930_AL", "values": {"20": "x"}},
            {"type": "0D", "item": "005930_AL", "values": {}},
        ]}).to_string();
        let WsFrame::Real(items) = parse_ws_frame(&text).unwrap() else { panic!() };
        assert!(matches!(items.as_slice(), [Ok(RealItem::Trade(_)), Err(_), Ok(RealItem::OtherType(k))] if k == "0D"));
    }

    #[test]
    fn reg_and_remove_messages() {
        let stock = Symbol::Stock(StockCode::parse("005930").unwrap());
        let both: BTreeSet<Symbol> = [stock, Symbol::Index(IndexCode::KOSPI)].into();
        let v: Value = serde_json::from_str(&reg_message(&both)).unwrap();
        assert_eq!(v, json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [{"item": ["005930_AL"], "type": ["0B"]}, {"item": ["001"], "type": ["0J"]}]}));
        let v: Value = serde_json::from_str(&reg_message(&[Symbol::Index(IndexCode::KOSDAQ)].into())).unwrap();
        assert_eq!(v["data"], json!([{"item": ["101"], "type": ["0J"]}]), "빈 원소는 넣지 않는다");
        let v: Value = serde_json::from_str(&remove_message(RealType::Trade, &[stock].into())).unwrap();
        assert_eq!(v, json!({"trnm": "REMOVE", "grp_no": "1", "data": [{"item": ["005930_AL"], "type": ["0B"]}]}));
        let login: Value = serde_json::from_str(login_message(&Secret::new("t".into())).expose()).unwrap();
        assert_eq!(login, json!({"trnm": "LOGIN", "token": "t"}));
    }
}
