use domain::{KstDate, Weekday};
use serde_json::{Value, json};

pub const PAGE_ROWS: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KrxMarket {
    pub days: Vec<KstDate>,
    pub stocks: Vec<KrxStock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KrxStock {
    pub code: String,
    pub name: String,
    pub market_code: String,
    pub company_class_name: String,
    pub reg_day: KstDate,
    pub audit_info: String,
    pub quoted: bool,
    pub daily: DailyAnswer,
    pub bars: Vec<KrxBar>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DailyAnswer {
    Bars,
    BarsThrough(KstDate),
    EmptyRow,
    UnknownCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KrxBar {
    pub day: KstDate,
    pub open: u64,
    pub high: u64,
    pub low: u64,
    pub close: u64,
    pub volume: u64,
    pub traded_million_won: u64,
    pub base: u64,
    pub adjustment_rate: Option<&'static str>,
}

pub const PRE_1985: &str = "110010";
pub const COMMON: &str = "110020";
pub const DAILY_WITHHELD: &str = "110025";
pub const SPLIT: &str = "110030";
pub const PREFERRED: &str = "110035";
pub const HALTED: &str = "110040";
pub const MANAGED: &str = "110050";
pub const ETF: &str = "110060";
pub const REIT: &str = "110070";
pub const SPAC: &str = "110080";
pub const NEW_LISTING: &str = "110090";
const NXT_LISTED: [&str; 2] = [SPLIT, MANAGED];

const SPLIT_RATIO: u64 = 5;

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).expect("올바른 날짜")
}

pub fn sample_first_day() -> KstDate {
    day(2021, 6, 1)
}

pub fn sample_split_day() -> KstDate {
    day(2026, 11, 10)
}

pub fn sample_halt_from() -> KstDate {
    day(2026, 10, 26)
}

const HOLIDAYS: [(u8, u8); 8] = [(1, 1), (3, 1), (5, 5), (6, 6), (8, 15), (10, 3), (10, 9), (12, 25)];

pub fn sample_calendar(through: KstDate) -> Vec<KstDate> {
    std::iter::successors(Some(sample_first_day()), |d| Some(d.add_days(1)))
        .take_while(|d| *d <= through)
        .filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) && !HOLIDAYS.contains(&(d.month(), d.day())))
        .collect()
}

struct Profile {
    code: &'static str,
    name: &'static str,
    market_code: &'static str,
    company_class_name: &'static str,
    reg_day: KstDate,
    audit_info: &'static str,
    level: u64,
}

fn profiles() -> Vec<Profile> {
    let p = |code, name, market_code, company_class_name, reg_day, audit_info, level| Profile { code, name, market_code, company_class_name, reg_day, audit_info, level };
    vec![
        p(PRE_1985, "가상전자", "0", "", day(1976, 3, 24), "정상", 60_000),
        p(COMMON, "가상화학", "0", "", day(2022, 3, 2), "정상", 30_000),
        p(SPLIT, "가상분할", "10", "", day(2023, 6, 1), "정상", 50_000),
        p(PREFERRED, "가상전자우", "0", "", day(2024, 1, 2), "정상", 40_000),
        p(HALTED, "가상정지", "10", "", day(2022, 9, 1), "거래정지", 8_000),
        p(MANAGED, "가상관리", "10", "", day(2024, 5, 2), "관리종목", 3_000),
        p(ETF, "가상200", "8", "", day(2021, 6, 1), "정상", 35_000),
        p(REIT, "가상리츠", "6", "", day(2023, 1, 2), "정상", 5_000),
        p(SPAC, "가상기업인수목적1호", "10", "스팩", day(2026, 3, 3), "정상", 2_000),
        p(NEW_LISTING, "가상신규", "0", "", day(2026, 10, 1), "정상", 20_000),
    ]
}

fn daily_withheld() -> Profile {
    Profile { code: DAILY_WITHHELD, name: "가상화학우B", market_code: "0", company_class_name: "", reg_day: day(2003, 6, 16), audit_info: "거래정지", level: 9_000 }
}

impl KrxMarket {
    pub fn sample(as_of: KstDate) -> KrxMarket {
        let days = sample_calendar(as_of);
        let stocks = profiles().into_iter().enumerate().map(|(k, p)| sample_stock(&p, k, &days, as_of)).collect();
        KrxMarket { days, stocks }
    }

    pub fn with_daily_withheld(mut self) -> KrxMarket {
        let as_of = *self.days.last().expect("가짜 KRX 시장에 관측일이 있다");
        let mut stock = sample_stock(&daily_withheld(), self.stocks.len(), &self.days, as_of);
        stock.daily = DailyAnswer::EmptyRow;
        self.stocks.push(stock);
        self
    }

    pub fn stock_mut(&mut self, code: &str) -> &mut KrxStock {
        self.stocks.iter_mut().find(|s| s.code == code).unwrap_or_else(|| panic!("가짜 KRX 시장에 없는 종목: {code}"))
    }

    pub fn codes(&self) -> Vec<String> {
        self.stocks.iter().map(|s| s.code.clone()).collect()
    }

    fn stock(&self, code: &str) -> Option<&KrxStock> {
        self.stocks.iter().find(|s| s.code == code)
    }
}

fn sample_stock(p: &Profile, k: usize, days: &[KstDate], as_of: KstDate) -> KrxStock {
    let swing = |i: usize| {
        let phase = (i + k * 13) % 120;
        p.level + p.level / 400 * phase.abs_diff(60) as u64
    };
    let regular_close = |i: usize| swing(i) - p.level / 1_000 * (i % 3) as u64;
    let split_applies = p.code == SPLIT && as_of >= sample_split_day();
    let halted_close = days.iter().position(|d| *d >= sample_halt_from()).map(|i| swing(i.saturating_sub(1)));
    let mut bars = Vec::new();
    for (i, &d) in days.iter().enumerate().filter(|(_, d)| **d >= p.reg_day) {
        let close = swing(i);
        let base = if bars.is_empty() { close } else { regular_close(i - 1) };
        let bar = match halted_close.filter(|_| p.code == HALTED && d >= sample_halt_from()) {
            Some(last) => KrxBar { day: d, open: last, high: last, low: last, close: last, volume: 0, traded_million_won: 0, base: last, adjustment_rate: None },
            None => {
                let wick = p.level / 200;
                let volume = 100_000 + (i * 7_919 % 50_000) as u64;
                KrxBar { day: d, open: base, high: base.max(close) + wick, low: base.min(close) - wick, close, volume, traded_million_won: volume * (base + close) / 2 / 1_000_000, base, adjustment_rate: None }
            }
        };
        bars.push(if split_applies { split_adjusted(bar) } else { bar });
    }
    KrxStock {
        code: p.code.into(),
        name: p.name.into(),
        market_code: p.market_code.into(),
        company_class_name: p.company_class_name.into(),
        reg_day: p.reg_day,
        audit_info: p.audit_info.into(),
        quoted: true,
        daily: DailyAnswer::Bars,
        bars,
    }
}

fn split_adjusted(bar: KrxBar) -> KrxBar {
    let price = |won: u64| won.div_ceil(SPLIT_RATIO);
    KrxBar {
        open: price(bar.open),
        high: price(bar.high),
        low: price(bar.low),
        close: price(bar.close),
        base: price(bar.base),
        volume: bar.volume * SPLIT_RATIO,
        adjustment_rate: (bar.day == sample_split_day()).then_some("-80.00"),
        ..bar
    }
}

pub enum KrxPage {
    Page { body: Value, last: bool },
    UnknownNextKey(String),
}

pub fn respond(market: &KrxMarket, api_id: &str, body: &Value, next_key: Option<&str>) -> Option<KrxPage> {
    match api_id {
        "ka10099" => Some(KrxPage::Page { body: stock_list(market, body["mrkt_tp"].as_str() == Some("10")), last: true }),
        "ka20006" => Some(paged(market.days.len(), next_key, "IDX", |range, headers| index_daily(market, range, headers))),
        "ka10081" => {
            let stock = market.stock(body["stk_cd"].as_str()?)?;
            Some(match stock.daily {
                DailyAnswer::Bars => paged(stock.bars.len(), next_key, &stock.code, |range, headers| stock_daily(&stock.code, &stock.bars, range, headers)),
                DailyAnswer::BarsThrough(last) => {
                    let bars: Vec<KrxBar> = stock.bars.iter().filter(|b| b.day <= last).copied().collect();
                    paged(bars.len(), next_key, &stock.code, |range, headers| stock_daily(&stock.code, &bars, range, headers))
                }
                DailyAnswer::EmptyRow => KrxPage::Page { body: empty_daily_row(stock), last: true },
                DailyAnswer::UnknownCode => KrxPage::Page { body: json!({"return_code": 2, "return_msg": "입력 값 오류입니다[1902:종목 정보가 없습니다]"}), last: true },
            })
        }
        "ka10083" => {
            let stock = market.stock(body["stk_cd"].as_str()?)?;
            let months = monthly(&stock.bars);
            Some(paged(months.len(), next_key, &stock.code, |range, headers| stock_monthly(stock, &months, range, headers)))
        }
        "ka10095" => {
            let codes: Vec<&str> = body["stk_cd"].as_str()?.split('|').collect();
            codes.iter().all(|c| !c.contains('_')).then(|| KrxPage::Page { body: quotes(market, &codes), last: true })
        }
        _ => None,
    }
}

fn paged(rows: usize, next_key: Option<&str>, chain: &str, page: impl Fn(std::ops::Range<usize>, Value) -> Value) -> KrxPage {
    let index = match next_key {
        None => 0,
        Some(key) => match key.strip_prefix(chain).and_then(|rest| rest.strip_prefix('-')).and_then(|n| n.parse::<usize>().ok()) {
            Some(n) if n >= 1 => n,
            _ => return KrxPage::UnknownNextKey(key.to_owned()),
        },
    };
    let start = index * PAGE_ROWS;
    let end = (start + PAGE_ROWS).min(rows);
    let last = end >= rows;
    let headers = json!({"cont-yn": if last { "N" } else { "Y" }, "next-key": if last { String::new() } else { format!("{chain}-{}", index + 1) }});
    KrxPage::Page { body: page(start.min(end)..end, headers), last }
}

fn newest_first<T>(all: &[T], range: std::ops::Range<usize>) -> impl Iterator<Item = &T> {
    all.iter().rev().skip(range.start).take(range.len())
}

fn signed_change(close: u64, base: u64) -> (String, &'static str) {
    match close.cmp(&base) {
        std::cmp::Ordering::Greater => (format!("+{}", close - base), "2"),
        std::cmp::Ordering::Equal => ("0".into(), "3"),
        std::cmp::Ordering::Less => (format!("-{}", base - close), "5"),
    }
}

fn chart_row(b: &KrxBar, traded: u64) -> Value {
    let (pred_pre, sig) = signed_change(b.close, b.base);
    json!({
        "cur_prc": b.close.to_string(),
        "dt": b.day.yyyymmdd(),
        "high_pric": b.high.to_string(),
        "low_pric": b.low.to_string(),
        "open_pric": b.open.to_string(),
        "pred_pre": pred_pre,
        "pred_pre_sig": sig,
        "trde_prica": traded.to_string(),
        "trde_qty": b.volume.to_string(),
        "trde_tern_rt": "+0.10",
        "upd_rt": b.adjustment_rate.unwrap_or(""),
        "upd_stkpc_tp": if b.adjustment_rate.is_some() { "256" } else { "" },
    })
}

fn stock_daily(code: &str, bars: &[KrxBar], range: std::ops::Range<usize>, headers: Value) -> Value {
    let rows: Vec<Value> = newest_first(bars, range).map(|b| chart_row(b, b.traded_million_won)).collect();
    json!({"_headers": headers, "return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_cd": code, "stk_dt_pole_chart_qry": rows})
}

fn monthly(bars: &[KrxBar]) -> Vec<KrxBar> {
    let mut months: Vec<KrxBar> = Vec::new();
    for b in bars {
        match months.last_mut().filter(|m| (m.day.year(), m.day.month()) == (b.day.year(), b.day.month())) {
            Some(m) => {
                m.high = m.high.max(b.high);
                m.low = m.low.min(b.low);
                m.close = b.close;
                m.volume += b.volume;
                m.traded_million_won += b.traded_million_won;
                m.adjustment_rate = m.adjustment_rate.or(b.adjustment_rate);
            }
            None => {
                let base = months.last().map_or(b.base, |m| m.close);
                months.push(KrxBar { base, ..*b });
            }
        }
    }
    months
}

fn stock_monthly(stock: &KrxStock, months: &[KrxBar], range: std::ops::Range<usize>, headers: Value) -> Value {
    let rows: Vec<Value> = newest_first(months, range).map(|m| chart_row(m, m.traded_million_won * 1_000_000)).collect();
    json!({"_headers": headers, "return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_cd": stock.code, "stk_mth_pole_chart_qry": rows})
}

fn empty_daily_row(stock: &KrxStock) -> Value {
    let fields = ["cur_prc", "dt", "high_pric", "low_pric", "open_pric", "pred_pre", "pred_pre_sig", "trde_prica", "trde_qty", "trde_tern_rt", "upd_rt", "upd_stkpc_tp"];
    let row: serde_json::Map<String, Value> = fields.iter().map(|f| (f.to_string(), json!(""))).collect();
    json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_cd": stock.code, "stk_dt_pole_chart_qry": [row]})
}

fn index_daily(market: &KrxMarket, range: std::ops::Range<usize>, headers: Value) -> Value {
    let rows: Vec<Value> = market
        .days
        .iter()
        .enumerate()
        .rev()
        .skip(range.start)
        .take(range.len())
        .map(|(i, d)| {
            let close = 250_000 + (i % 200) as u64 * 150;
            json!({
                "cur_prc": close.to_string(),
                "dt": d.yyyymmdd(),
                "high_pric": (close + 900).to_string(),
                "low_pric": (close - 900).to_string(),
                "open_pric": (close - 300).to_string(),
                "trde_prica": "20000000",
                "trde_qty": "300000",
            })
        })
        .collect();
    json!({"_headers": headers, "return_code": 0, "return_msg": "정상적으로 처리되었습니다", "inds_cd": "001", "inds_dt_pole_qry": rows})
}

fn stock_list(market: &KrxMarket, kosdaq: bool) -> Value {
    let rows: Vec<Value> = market
        .stocks
        .iter()
        .filter(|s| (s.market_code == "10") == kosdaq)
        .map(|s| {
            json!({
                "auditInfo": s.audit_info,
                "code": s.code,
                "companyClassName": s.company_class_name,
                "kind": "A",
                "lastPrice": format!("{:08}", s.bars.last().map_or(0, |b| b.close)),
                "listCount": "0000000010000000",
                "marketCode": s.market_code,
                "marketName": if kosdaq { "코스닥" } else { "거래소" },
                "name": s.name,
                "nxtEnable": if NXT_LISTED.contains(&s.code.as_str()) { "Y" } else { "N" },
                "orderWarning": "0",
                "regDay": s.reg_day.yyyymmdd(),
                "state": "증거금40%|신용가능",
                "upName": "",
                "upSizeName": "",
            })
        })
        .collect();
    json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "list": rows})
}

fn quotes(market: &KrxMarket, codes: &[&str]) -> Value {
    let rows: Vec<Value> = codes
        .iter()
        .map(|code| match market.stock(code).filter(|s| s.quoted).and_then(|s| Some((s, s.bars.last()?))) {
            None => json!({"stk_cd": "", "stk_nm": "", "cur_prc": "", "base_pric": "", "trde_qty": "", "dt": "", "cntr_tm": ""}),
            Some((s, b)) => {
                let (pred_pre, sig) = signed_change(b.close, b.base);
                let traded = |won: u64| if b.volume == 0 { "0".to_owned() } else { won.to_string() };
                json!({
                    "stk_cd": s.code,
                    "stk_nm": s.name,
                    "cur_prc": b.close.to_string(),
                    "base_pric": b.base.to_string(),
                    "pred_pre": pred_pre,
                    "pred_pre_sig": sig,
                    "open_pric": traded(b.open),
                    "high_pric": traded(b.high),
                    "low_pric": traded(b.low),
                    "close_pric": b.close.to_string(),
                    "trde_qty": b.volume.to_string(),
                    "trde_prica": b.traded_million_won.to_string(),
                    "cntr_tm": "195959",
                    "dt": b.day.yyyymmdd(),
                })
            }
        })
        .collect();
    json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "atn_stk_infr": rows})
}
