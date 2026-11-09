//! 키움 응답 → `domain` 타입(backend.md §4.6). 숫자는 모두 문자열로 오고, 가격 부호는 믿지 않는다.

use std::fmt;

use domain::{Bucket, KstDate, KstTime, Market, Ohlcv, Period, Price, StockCode, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Volume};
use serde::Deserialize;

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
            let high = o.max(h).max(l).max(c);
            let low = o.min(h).min(l).min(c);
            Ohlcv::try_new(o, high, low, c, v).expect("넓힌 고가·저가는 언제나 시가·종가를 감싼다")
        }
    };
    Ok(KiwoomBar { bucket, ohlcv })
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
            trde_qty: "5".into(), dt: "20261106".into(), cntr_tm: "090000".into(),
        };
        let mismatch = parse_quotes(StockQuotesResponse { atn_stk_infr: vec![row("005930_AL", "5")] });
        assert_eq!((mismatch[0].price_centi, mismatch[0].base_centi), (10_000, 9_000), "방향이 어긋나도 계산한 값을 쓴다");
        let krx_bad_time = vec![row("005930", "2"), row("005930_NX", "2"), QuoteRow { cntr_tm: "99".into(), ..row("000660_AL", "2") }];
        assert!(parse_quotes(StockQuotesResponse { atn_stk_infr: krx_bad_time }).is_empty());
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
}
