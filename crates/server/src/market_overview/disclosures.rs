use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use domain::{StockCode, Symbol};

use super::derived::StockCatalog;
use super::dto::{
    MarketOverviewDisclosureCategory, MarketOverviewDisclosureCounts, MarketOverviewDisclosureItem, MarketOverviewDisclosureRadar,
    MarketOverviewScope,
};
use crate::api::SymbolCode;
use crate::financials::store::{SecurityDisclosures, Store};

const MAX_DISCLOSURES: usize = 30;
const CONTRACT_KEYWORDS: [&str; 5] = ["단일판매", "공급계약", "수주", "기술이전", "라이선스"];
const SHAREHOLDER_KEYWORDS: [&str; 7] = ["자기주식", "자사주", "소각", "배당", "현금배당", "주식배당", "무상증자"];
const EARNINGS_KEYWORDS: [&str; 4] = ["잠정실적", "영업(잠정)실적", "매출액또는손익구조", "실적"];
const CAPITAL_KEYWORDS: [&str; 7] = ["유상증자", "전환사채", "신주인수권부사채", "합병", "분할", "공개매수", "제3자배정"];

pub fn classify_report(report_name: &str) -> Option<MarketOverviewDisclosureCategory> {
    let trimmed = report_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    if CONTRACT_KEYWORDS.iter().any(|kw| trimmed.contains(kw)) {
        return Some(MarketOverviewDisclosureCategory::Contract);
    }
    if SHAREHOLDER_KEYWORDS.iter().any(|kw| trimmed.contains(kw)) {
        return Some(MarketOverviewDisclosureCategory::Shareholder);
    }
    if EARNINGS_KEYWORDS.iter().any(|kw| trimmed.contains(kw)) {
        return Some(MarketOverviewDisclosureCategory::Earnings);
    }
    if CAPITAL_KEYWORDS.iter().any(|kw| trimmed.contains(kw)) {
        return Some(MarketOverviewDisclosureCategory::Capital);
    }
    None
}

pub fn build_disclosure_radar(
    records: Option<&[SecurityDisclosures]>,
    scope: MarketOverviewScope,
    catalog: &StockCatalog,
    live_rates: &HashMap<StockCode, f64>,
) -> Option<MarketOverviewDisclosureRadar> {
    let records = records?;
    if records.is_empty() {
        return None;
    }
    let mut counts = MarketOverviewDisclosureCounts { contract: 0, shareholder: 0, earnings: 0, capital: 0 };
    let mut items = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for entry in records {
        let Ok(code) = StockCode::parse(&entry.stock_code) else { continue };
        if !catalog.includes_stock(code, scope) {
            continue;
        }
        let name = if !entry.company_name.is_empty() {
            entry.company_name.clone()
        } else {
            catalog.names.get(&code).cloned().unwrap_or_else(|| code.as_str().to_owned())
        };
        let market = catalog.markets.get(&code).copied();
        let change_rate = live_rates.get(&code).copied().filter(|r| r.is_finite());
        let wire_code = SymbolCode(Symbol::Stock(code).as_wire());
        for row in &entry.disclosures {
            let report_name = row.get("report_nm").map(String::as_str).unwrap_or("").trim();
            let Some(category) = classify_report(report_name) else { continue };
            let receipt_no = row.get("rcept_no").map(String::as_str).unwrap_or("").trim().to_owned();
            if !receipt_no.is_empty() && !seen.insert((wire_code.0.clone(), receipt_no.clone())) {
                continue;
            }
            match category {
                MarketOverviewDisclosureCategory::Contract => counts.contract += 1,
                MarketOverviewDisclosureCategory::Shareholder => counts.shareholder += 1,
                MarketOverviewDisclosureCategory::Earnings => counts.earnings += 1,
                MarketOverviewDisclosureCategory::Capital => counts.capital += 1,
            }
            let receipt_date = row.get("rcept_dt").map(String::as_str).unwrap_or("").trim().to_owned();
            let filer = row.get("flr_nm").map(String::as_str).unwrap_or("").trim().to_owned();
            let remarks = row.get("rm").map(String::as_str).unwrap_or("").trim().to_owned();
            items.push(MarketOverviewDisclosureItem {
                code: wire_code.clone(),
                name: name.clone(),
                market,
                category,
                report_name: report_name.to_owned(),
                receipt_no,
                receipt_date,
                filer,
                remarks,
                change_rate,
            });
        }
    }
    let total_matched = counts.contract + counts.shareholder + counts.earnings + counts.capital;
    items.sort_by(|a, b| {
        b.receipt_date
            .cmp(&a.receipt_date)
            .then_with(|| b.receipt_no.cmp(&a.receipt_no))
            .then_with(|| a.code.0.cmp(&b.code.0))
    });
    items.truncate(MAX_DISCLOSURES);
    Some(MarketOverviewDisclosureRadar { total_matched, counts, items })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified_nanos: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DbStamp {
    path: PathBuf,
    main: FileStamp,
    wal: Option<FileStamp>,
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let modified_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Some(FileStamp { len: meta.len(), modified_nanos })
}

fn db_stamp(path: &Path) -> Option<DbStamp> {
    let main = file_stamp(path)?;
    let mut wal_os = path.as_os_str().to_os_string();
    wal_os.push("-wal");
    let wal = file_stamp(Path::new(&wal_os));
    Some(DbStamp { path: path.to_owned(), main, wal })
}

struct CachedDisclosures {
    stamp: DbStamp,
    rows: Arc<Vec<SecurityDisclosures>>,
}

#[derive(Default)]
pub(crate) struct DisclosureCache {
    cached: Mutex<Option<CachedDisclosures>>,
}

impl DisclosureCache {
    pub(crate) fn clear(&self) {
        *self.cached.lock().expect("공시 캐시 잠금") = None;
    }

    pub(crate) async fn load(&self, path: &Path) -> Option<Arc<Vec<SecurityDisclosures>>> {
        let stamp = db_stamp(path)?;
        if let Some(entry) = self.cached.lock().expect("공시 캐시 잠금").as_ref()
            && entry.stamp == stamp
        {
            return Some(entry.rows.clone());
        }
        let store = match Store::open_read_only(path).await {
            Ok(Some(store)) => store,
            Ok(None) => return None,
            Err(error) => {
                tracing::warn!(path = %path.display(), ?error, "공시 레이더용 재무 DB를 열지 못했습니다");
                return None;
            }
        };
        let rows = match store.all_security_disclosures().await {
            Ok(rows) => Arc::new(rows),
            Err(error) => {
                tracing::warn!(path = %path.display(), ?error, "공시 레이더용 공시 목록을 읽지 못했습니다");
                return None;
            }
        };
        *self.cached.lock().expect("공시 캐시 잠금") = Some(CachedDisclosures { stamp, rows: rows.clone() });
        Some(rows)
    }
}
