use std::collections::{HashMap, HashSet};
use std::fmt;

use domain::StockCode;
use serde::Deserialize;

use super::{EtfDataSource, EtfDataStatus, EtfStyle};
use crate::api::KstDate;

const SCHEMA_VERSION: u32 = 1;
pub const MAX_WEIGHT_BPS: u32 = 10_000;
pub const MAX_WEIGHT_SUM_BPS: u32 = 11_000;
const TOP_HOLDINGS: usize = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSnapshot {
    schema_version: u32,
    holdings_as_of: String,
    funds: Vec<serde_json::Value>,
    stocks: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFund {
    code: String,
    name: String,
    issuer: String,
    style: String,
    benchmark: String,
    holdings: Vec<RawHolding>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHolding {
    code: String,
    weight_bps: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub subject: String,
    pub reason: String,
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.subject, self.reason)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Holding {
    pub code: StockCode,
    pub weight_bps: u32,
}

#[derive(Debug, Clone)]
pub struct Fund {
    pub code: StockCode,
    pub name: String,
    pub issuer: String,
    pub style: EtfStyle,
    pub benchmark: String,
    pub holdings: Vec<Holding>,
    pub top_weight_bpss: u32,
    pub effective_holdings: f64,
    pub status: EtfDataStatus,
}

#[derive(Debug, Clone, Copy)]
pub struct Holder {
    pub fund: usize,
    pub weight_bps: u32,
}

#[derive(Debug, Default)]
pub struct Catalog {
    funds: Vec<Fund>,
    by_code: HashMap<StockCode, usize>,
    holders: HashMap<StockCode, Vec<Holder>>,
    stock_names: HashMap<StockCode, String>,
}

pub struct Loaded {
    pub catalog: Catalog,
    pub rejected: Vec<Rejection>,
}

impl Catalog {
    pub fn embedded() -> Catalog {
        Catalog::load(include_str!("../../data/etf/funds.json")).catalog
    }

    pub fn load(json: &str) -> Loaded {
        let loaded = match serde_json::from_str::<RawSnapshot>(json) {
            Ok(raw) => Catalog::build(raw),
            Err(e) => Loaded { catalog: Catalog::default(), rejected: vec![Rejection { subject: "스냅샷".into(), reason: format!("읽을 수 없습니다: {e}") }] },
        };
        for rejection in &loaded.rejected {
            tracing::warn!(subject = %rejection.subject, reason = %rejection.reason, "ETF 자료를 싣지 않습니다");
        }
        loaded
    }

    fn build(raw: RawSnapshot) -> Loaded {
        let mut catalog = Catalog::default();
        let mut rejected = Vec::new();
        let snapshot_problem = if raw.schema_version != SCHEMA_VERSION {
            Some(format!("지원하지 않는 자료 버전입니다: {}", raw.schema_version))
        } else {
            None
        };
        let holdings_as_of = raw.holdings_as_of.parse::<KstDate>();
        if let Some(reason) = snapshot_problem.or_else(|| holdings_as_of.clone().err()) {
            return Loaded { catalog, rejected: vec![Rejection { subject: "스냅샷".into(), reason }] };
        }
        let status = EtfDataStatus { source: EtfDataSource::Snapshot, holdings_as_of: holdings_as_of.expect("위에서 확인했다"), last_attempt_at: None, refresh_failed: false };
        for fund in raw.funds {
            let subject = fund.get("code").map_or_else(|| "(코드 없음)".to_owned(), |code| code.as_str().map_or_else(|| code.to_string(), str::to_owned));
            let checked = serde_json::from_value::<RawFund>(fund).map_err(|e| format!("항목을 읽을 수 없습니다: {e}")).and_then(|fund| validated(fund, &raw.stocks, &status, &catalog.by_code));
            match checked {
                Ok(fund) => catalog.insert(fund, &raw.stocks),
                Err(reason) => rejected.push(Rejection { subject, reason }),
            }
        }
        Loaded { catalog, rejected }
    }

    fn insert(&mut self, fund: Fund, names: &HashMap<String, String>) {
        let index = self.funds.len();
        for holding in &fund.holdings {
            self.holders.entry(holding.code).or_default().push(Holder { fund: index, weight_bps: holding.weight_bps });
            self.stock_names.entry(holding.code).or_insert_with(|| names[holding.code.as_str()].clone());
        }
        self.by_code.insert(fund.code, index);
        self.funds.push(fund);
    }

    pub fn overlaid(&self, collected: &HashMap<StockCode, CollectedFund>, attempts: &HashMap<StockCode, Attempt>) -> Catalog {
        let mut names: HashMap<String, String> = self.stock_names.iter().map(|(code, name)| (code.as_str().to_owned(), name.clone())).collect();
        for pdf in collected.values() {
            for holding in &pdf.holdings {
                names.entry(holding.code.as_str().to_owned()).or_insert_with(|| holding.name.clone());
            }
        }
        let mut catalog = Catalog::default();
        for fund in &self.funds {
            let attempt = attempts.get(&fund.code);
            let merged = match collected.get(&fund.code) {
                Some(pdf) => pdf.applied_to(fund, attempt),
                None => Fund { status: EtfDataStatus { last_attempt_at: attempt.map(|a| a.at), refresh_failed: attempt.is_some_and(|a| a.failed), ..fund.status.clone() }, ..fund.clone() },
            };
            catalog.insert(merged, &names);
        }
        catalog
    }

    pub fn funds(&self) -> &[Fund] {
        &self.funds
    }

    pub fn fund(&self, code: StockCode) -> Option<&Fund> {
        self.by_code.get(&code).map(|&i| &self.funds[i])
    }

    pub fn holders(&self, stock: StockCode) -> Vec<(&Fund, u32)> {
        let mut holders: Vec<_> = self.holders.get(&stock).into_iter().flatten().map(|h| (&self.funds[h.fund], h.weight_bps)).collect();
        holders.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.code.cmp(&b.0.code)));
        holders
    }

    pub fn stock_codes(&self) -> Vec<StockCode> {
        self.holders.keys().copied().collect()
    }

    pub fn stock_name(&self, stock: StockCode) -> Option<&str> {
        self.stock_names.get(&stock).map(String::as_str)
    }
}

fn validated(raw: RawFund, names: &HashMap<String, String>, status: &EtfDataStatus, seen: &HashMap<StockCode, usize>) -> Result<Fund, String> {
    let code = StockCode::parse(&raw.code).map_err(|_| format!("ETF 코드 형식이 아닙니다: {}", raw.code))?;
    if seen.contains_key(&code) {
        return Err("ETF 코드가 중복입니다".into());
    }
    let style = match raw.style.as_str() {
        "active" => EtfStyle::Active,
        "passive" => EtfStyle::Passive,
        other => return Err(format!("운용 방식을 알 수 없습니다: {other}")),
    };
    if raw.name.trim().is_empty() {
        return Err("이름이 비었습니다".into());
    }
    if raw.holdings.is_empty() {
        return Err("구성 종목이 없습니다".into());
    }
    let mut holdings = Vec::with_capacity(raw.holdings.len());
    let mut stocks = HashSet::new();
    for holding in &raw.holdings {
        let stock = StockCode::parse(&holding.code).map_err(|_| format!("종목 코드 형식이 아닙니다: {}", holding.code))?;
        if !stocks.insert(stock) {
            return Err(format!("종목이 중복입니다: {}", holding.code));
        }
        if !names.contains_key(stock.as_str()) {
            return Err(format!("종목 이름이 없습니다: {}", holding.code));
        }
        let weight_bps = u32::try_from(holding.weight_bps).ok().filter(|w| *w <= MAX_WEIGHT_BPS).ok_or_else(|| format!("종목 비중이 0~{MAX_WEIGHT_BPS}bps를 벗어납니다: {} {}bps", holding.code, holding.weight_bps))?;
        holdings.push(Holding { code: stock, weight_bps });
    }
    let sum: u64 = holdings.iter().map(|h| u64::from(h.weight_bps)).sum();
    if sum == 0 || sum > u64::from(MAX_WEIGHT_SUM_BPS) {
        return Err(format!("비중 합이 허용 범위(1~{MAX_WEIGHT_SUM_BPS}bp)를 벗어납니다: {sum}bps"));
    }
    let (holdings, top_weight_bpss, effective_holdings) = shaped(holdings);
    Ok(Fund { code, name: raw.name, issuer: raw.issuer, style, benchmark: raw.benchmark, holdings, top_weight_bpss, effective_holdings, status: status.clone() })
}

fn shaped(mut holdings: Vec<Holding>) -> (Vec<Holding>, u32, f64) {
    holdings.sort_by(|a, b| b.weight_bps.cmp(&a.weight_bps).then(a.code.cmp(&b.code)));
    let sum: u64 = holdings.iter().map(|h| u64::from(h.weight_bps)).sum();
    let top_weight_bpss = holdings.iter().take(TOP_HOLDINGS).map(|h| h.weight_bps).sum();
    let sum_of_squares: u64 = holdings.iter().map(|h| u64::from(h.weight_bps).pow(2)).sum();
    let effective_holdings = (sum * sum) as f64 / sum_of_squares as f64;
    (holdings, top_weight_bpss, effective_holdings)
}

#[derive(Debug, Clone)]
pub struct CollectedHolding {
    pub code: StockCode,
    pub name: String,
    pub weight_bps: u32,
}

#[derive(Debug, Clone)]
pub struct CollectedFund {
    pub as_of: domain::KstDate,
    pub holdings: Vec<CollectedHolding>,
}

#[derive(Debug, Clone, Copy)]
pub struct Attempt {
    pub at: crate::api::UnixSeconds,
    pub day: domain::KstDate,
    pub failed: bool,
}

impl CollectedFund {
    fn applied_to(&self, fund: &Fund, attempt: Option<&Attempt>) -> Fund {
        let (holdings, top_weight_bpss, effective_holdings) = shaped(self.holdings.iter().map(|h| Holding { code: h.code, weight_bps: h.weight_bps }).collect());
        let status = EtfDataStatus { source: EtfDataSource::Collected, holdings_as_of: KstDate(self.as_of), last_attempt_at: attempt.map(|a| a.at), refresh_failed: attempt.is_some_and(|a| a.failed) };
        Fund { holdings, top_weight_bpss, effective_holdings, status, ..fund.clone() }
    }
}
