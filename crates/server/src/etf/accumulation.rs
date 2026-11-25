use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use domain::{KstDate, StockCode};

use super::collect::{PDF_DIR, RAW_SUFFIX, STORED_SCHEMA_VERSION, StoredPdf, pdf_dir};
use super::history::{Held, compare, median};
use super::ma::MaCache;
use super::{
    EtfAccumulation, EtfAccumulationContributor, EtfAccumulationDirection, EtfAccumulationRow,
    EtfAccumulationStyle, EtfChangeKind, EtfMaStates, EtfStyle, stock_name,
};
use crate::api;
use crate::http::{ApiFailure, AppState};

pub(super) fn parse_window(query: &HashMap<String, String>) -> Result<u32, ApiFailure> {
    match query.get("window").map(String::as_str) {
        None | Some("5") => Ok(5),
        Some("20") => Ok(20),
        Some(_) => Err(ApiFailure::bad_request("window는 5 또는 20이어야 합니다")),
    }
}

pub(super) fn parse_style(query: &HashMap<String, String>) -> Result<EtfAccumulationStyle, ApiFailure> {
    match query.get("style").map(String::as_str) {
        None | Some("active") => Ok(EtfAccumulationStyle::Active),
        Some("all") => Ok(EtfAccumulationStyle::All),
        Some(_) => Err(ApiFailure::bad_request("style은 active 또는 all이어야 합니다")),
    }
}

pub(super) fn parse_direction(query: &HashMap<String, String>) -> Result<EtfAccumulationDirection, ApiFailure> {
    match query.get("direction").map(String::as_str) {
        None | Some("buy") => Ok(EtfAccumulationDirection::Buy),
        Some("sell") => Ok(EtfAccumulationDirection::Sell),
        Some(_) => Err(ApiFailure::bad_request("direction은 buy 또는 sell이어야 합니다")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirStamp {
    days: Vec<KstDate>,
    window_dir_mtimes: Vec<Option<SystemTime>>,
    boundary_fingerprint: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CacheStamp {
    dir: DirStamp,
    catalog_revision: u64,
    ma_generation: u64,
    symbols_stamp: usize,
}

struct CacheEntry {
    stamp: CacheStamp,
    response: Arc<EtfAccumulation>,
}

#[derive(Default)]
pub(super) struct AccumulationCache {
    entries: Mutex<HashMap<(u32, EtfAccumulationStyle, EtfAccumulationDirection), CacheEntry>>,
}

#[derive(Debug, Clone)]
struct FundMeta {
    code: StockCode,
    name: String,
    style: EtfStyle,
}

#[derive(Debug, Clone)]
pub(super) struct FundSnapshot {
    pub(super) holdings: Vec<Held>,
    weights: HashMap<String, u32>,
}

#[derive(Debug, Clone)]
struct AggregatedStock {
    code: String,
    fallback_name: String,
    buying_etf_count: u32,
    added_etf_count: u32,
    increased_etf_count: u32,
    selling_etf_count: u32,
    removed_etf_count: u32,
    decreased_etf_count: u32,
    median_real_change: Option<f64>,
    contributors: Vec<EtfAccumulationContributor>,
}

fn window_slice(days: &[KstDate], window: u32) -> &[KstDate] {
    let to_idx = days.len() - 1;
    let from_idx = to_idx.saturating_sub(window as usize);
    &days[from_idx..=to_idx]
}

pub(super) fn discover_days(dir: &Path) -> Vec<KstDate> {
    let Ok(entries) = std::fs::read_dir(dir.join(PDF_DIR)) else {
        return Vec::new();
    };
    let mut days = BTreeSet::new();
    for entry in entries.flatten() {
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        if let Some(day) = entry.file_name().to_str().and_then(KstDate::parse_yyyymmdd) {
            days.insert(day);
        }
    }
    days.into_iter().collect()
}

pub(super) fn hash_day_dir(path: &Path, hasher: &mut DefaultHasher) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    let mut files: Vec<(String, u64, Option<SystemTime>)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") || name.ends_with(RAW_SUFFIX) {
            continue;
        }
        let meta = entry.metadata().ok();
        let len = meta.as_ref().map_or(0, std::fs::Metadata::len);
        let modified = meta.and_then(|m| m.modified().ok());
        files.push((name, len, modified));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.len().hash(hasher);
    for (name, len, modified) in files {
        name.hash(hasher);
        len.hash(hasher);
        modified.hash(hasher);
    }
}

fn scan_stamp(dir: &Path, window: u32) -> DirStamp {
    let days = discover_days(dir);
    if days.len() < 2 {
        return DirStamp { days, window_dir_mtimes: Vec::new(), boundary_fingerprint: 0 };
    }
    let slice = window_slice(&days, window);
    let window_dir_mtimes = slice
        .iter()
        .map(|day| std::fs::metadata(pdf_dir(dir, *day)).ok().and_then(|m| m.modified().ok()))
        .collect();
    let mut hasher = DefaultHasher::new();
    hash_day_dir(&pdf_dir(dir, slice[0]), &mut hasher);
    hash_day_dir(&pdf_dir(dir, slice[slice.len() - 1]), &mut hasher);
    DirStamp { days, window_dir_mtimes, boundary_fingerprint: hasher.finish() }
}

pub(super) fn read_stored_snapshot(path: &Path, code: StockCode, day: KstDate) -> Option<FundSnapshot> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(file = %path.display(), error = %e, "저장된 ETF 구성을 동시 매집 집계에 읽지 못했습니다");
            return None;
        }
    };
    let stored: StoredPdf = match serde_json::from_slice(&bytes) {
        Ok(stored) => stored,
        Err(e) => {
            tracing::warn!(file = %path.display(), error = %e, "저장된 ETF 구성을 동시 매집 집계에 쓰지 않습니다");
            return None;
        }
    };
    if stored.schema_version != STORED_SCHEMA_VERSION || stored.code != code.as_str() || stored.as_of != day.to_string() {
        tracing::warn!(file = %path.display(), "자료 버전·ETF 코드·기준일이 파일 위치와 달라 동시 매집 집계에 쓰지 않습니다");
        return None;
    }
    let mut holdings = Vec::with_capacity(stored.holdings.len());
    let mut weights = HashMap::with_capacity(stored.holdings.len());
    for h in stored.holdings {
        weights.insert(h.code.clone(), h.weight_bps);
        holdings.push(Held { code: h.code, name: h.name, quantity: h.cu_quantity });
    }
    Some(FundSnapshot { holdings, weights })
}

fn load_fund_endpoints(dir: &Path, window_days: &[KstDate], code: StockCode) -> Option<(FundSnapshot, FundSnapshot)> {
    let file_name = format!("{}.json", code.as_str());
    let mut first: Option<(usize, FundSnapshot)> = None;
    for (idx, &day) in window_days.iter().enumerate() {
        if let Some(snapshot) = read_stored_snapshot(&pdf_dir(dir, day).join(&file_name), code, day) {
            first = Some((idx, snapshot));
            break;
        }
    }
    let (first_idx, before) = first?;
    for &day in window_days[first_idx + 1..].iter().rev() {
        if let Some(after) = read_stored_snapshot(&pdf_dir(dir, day).join(&file_name), code, day) {
            return Some((before, after));
        }
    }
    None
}

fn contributor_rank(kind: EtfChangeKind, direction: EtfAccumulationDirection) -> u8 {
    match (direction, kind) {
        (EtfAccumulationDirection::Buy, EtfChangeKind::Added)
        | (EtfAccumulationDirection::Sell, EtfChangeKind::Removed) => 0,
        (EtfAccumulationDirection::Buy, EtfChangeKind::Increased)
        | (EtfAccumulationDirection::Sell, EtfChangeKind::Decreased) => 1,
        _ => 2,
    }
}

fn matches_direction(kind: EtfChangeKind, direction: EtfAccumulationDirection) -> bool {
    match direction {
        EtfAccumulationDirection::Buy => matches!(kind, EtfChangeKind::Added | EtfChangeKind::Increased),
        EtfAccumulationDirection::Sell => matches!(kind, EtfChangeKind::Removed | EtfChangeKind::Decreased),
    }
}

#[derive(Default)]
struct StockBucket {
    fallback_name: String,
    added_etf_count: u32,
    increased_etf_count: u32,
    removed_etf_count: u32,
    decreased_etf_count: u32,
    real_changes: Vec<f64>,
    contributors: Vec<EtfAccumulationContributor>,
}

fn aggregate_pairs(pairs: &[(FundMeta, FundSnapshot, FundSnapshot)], direction: EtfAccumulationDirection) -> Vec<AggregatedStock> {
    let mut buckets: HashMap<String, StockBucket> = HashMap::new();
    for (fund, before, after) in pairs {
        let comparison = compare(&before.holdings, &after.holdings);
        for row in comparison.rows {
            if !matches_direction(row.kind, direction) {
                continue;
            }
            let bucket = buckets.entry(row.code.clone()).or_default();
            if bucket.fallback_name.is_empty() && !row.name.is_empty() {
                bucket.fallback_name = row.name.clone();
            }
            match row.kind {
                EtfChangeKind::Added => bucket.added_etf_count += 1,
                EtfChangeKind::Increased => {
                    bucket.increased_etf_count += 1;
                    if let Some(rc) = row.real_change {
                        bucket.real_changes.push(rc);
                    }
                }
                EtfChangeKind::Removed => bucket.removed_etf_count += 1,
                EtfChangeKind::Decreased => {
                    bucket.decreased_etf_count += 1;
                    if let Some(rc) = row.real_change {
                        bucket.real_changes.push(rc);
                    }
                }
                EtfChangeKind::Unchanged => {}
            }
            bucket.contributors.push(EtfAccumulationContributor {
                fund_code: fund.code.as_str().into(),
                fund_name: fund.name.clone(),
                style: fund.style,
                kind: row.kind,
                real_change: row.real_change,
                before_weight_bps: before.weights.get(&row.code).copied(),
                after_weight_bps: after.weights.get(&row.code).copied(),
            });
        }
    }
    let mut rows: Vec<AggregatedStock> = buckets
        .into_iter()
        .map(|(code, mut bucket)| {
            bucket.contributors.sort_by(|a, b| {
                contributor_rank(a.kind, direction)
                    .cmp(&contributor_rank(b.kind, direction))
                    .then_with(|| match direction {
                        EtfAccumulationDirection::Buy => b.real_change.unwrap_or(f64::NEG_INFINITY).total_cmp(&a.real_change.unwrap_or(f64::NEG_INFINITY)),
                        EtfAccumulationDirection::Sell => a.real_change.unwrap_or(f64::INFINITY).total_cmp(&b.real_change.unwrap_or(f64::INFINITY)),
                    })
                    .then_with(|| a.fund_code.cmp(&b.fund_code))
            });
            AggregatedStock {
                code,
                fallback_name: bucket.fallback_name,
                buying_etf_count: bucket.added_etf_count + bucket.increased_etf_count,
                added_etf_count: bucket.added_etf_count,
                increased_etf_count: bucket.increased_etf_count,
                selling_etf_count: bucket.removed_etf_count + bucket.decreased_etf_count,
                removed_etf_count: bucket.removed_etf_count,
                decreased_etf_count: bucket.decreased_etf_count,
                median_real_change: median(bucket.real_changes),
                contributors: bucket.contributors,
            }
        })
        .collect();
    rows.sort_by(|a, b| match direction {
        EtfAccumulationDirection::Buy => b
            .buying_etf_count
            .cmp(&a.buying_etf_count)
            .then_with(|| b.added_etf_count.cmp(&a.added_etf_count))
            .then_with(|| b.median_real_change.unwrap_or(f64::NEG_INFINITY).total_cmp(&a.median_real_change.unwrap_or(f64::NEG_INFINITY)))
            .then_with(|| a.code.cmp(&b.code)),
        EtfAccumulationDirection::Sell => b
            .selling_etf_count
            .cmp(&a.selling_etf_count)
            .then_with(|| b.removed_etf_count.cmp(&a.removed_etf_count))
            .then_with(|| a.median_real_change.unwrap_or(f64::INFINITY).total_cmp(&b.median_real_change.unwrap_or(f64::INFINITY)))
            .then_with(|| a.code.cmp(&b.code)),
    });
    rows
}

fn compute_from_dir(dir: &Path, window_days: &[KstDate], funds: &[FundMeta], direction: EtfAccumulationDirection) -> Vec<AggregatedStock> {
    let mut pairs = Vec::with_capacity(funds.len());
    for fund in funds {
        if let Some((before, after)) = load_fund_endpoints(dir, window_days, fund.code) {
            pairs.push((fund.clone(), before, after));
        }
    }
    aggregate_pairs(&pairs, direction)
}

fn empty_response(window: u32, style: EtfAccumulationStyle, direction: EtfAccumulationDirection, collected_days: u32) -> EtfAccumulation {
    EtfAccumulation { window, style, direction, from_date: None, to_date: None, collected_days, ma_as_of: None, rows: Vec::new() }
}

fn style_matches(fund_style: EtfStyle, filter: EtfAccumulationStyle) -> bool {
    match filter {
        EtfAccumulationStyle::Active => fund_style == EtfStyle::Active,
        EtfAccumulationStyle::All => true,
    }
}

impl AccumulationCache {
    pub(super) async fn get(
        &self,
        st: &AppState,
        ma_cache: &MaCache,
        window: u32,
        style: EtfAccumulationStyle,
        direction: EtfAccumulationDirection,
    ) -> EtfAccumulation {
        let Some(dir) = st.etf.pdf_dir().map(PathBuf::from) else {
            return empty_response(window, style, direction, 0);
        };
        let scan_dir = dir.clone();
        let dir_stamp = tokio::task::spawn_blocking(move || scan_stamp(&scan_dir, window))
            .await
            .unwrap_or_else(|_| DirStamp { days: Vec::new(), window_dir_mtimes: Vec::new(), boundary_fingerprint: 0 });
        let catalog = st.etf.catalog();
        let catalog_revision = st.etf.revision();
        let ma_generation = st.screener.store_generation();
        let symbols_stamp = st.symbols.updates().borrow().as_ref().map_or(0, |d| Arc::as_ptr(d) as usize);
        let stamp = CacheStamp { dir: dir_stamp, catalog_revision, ma_generation, symbols_stamp };
        let key = (window, style, direction);
        if let Some(entry) = self.entries.lock().expect("동시 매집 캐시 잠금").get(&key)
            && entry.stamp == stamp
        {
            return (*entry.response).clone();
        }
        let collected_days = stamp.dir.days.len() as u32;
        if stamp.dir.days.len() < 2 {
            let response = empty_response(window, style, direction, collected_days);
            self.entries.lock().expect("동시 매집 캐시 잠금").insert(key, CacheEntry { stamp, response: Arc::new(response.clone()) });
            return response;
        }
        let window_days = window_slice(&stamp.dir.days, window).to_vec();
        let from_date = window_days[0];
        let to_date = window_days[window_days.len() - 1];
        let funds: Vec<FundMeta> = catalog
            .funds()
            .iter()
            .filter(|f| style_matches(f.style, style))
            .map(|f| FundMeta { code: f.code, name: f.name.clone(), style: f.style })
            .collect();
        let aggregated = tokio::task::spawn_blocking(move || compute_from_dir(&dir, &window_days, &funds, direction))
            .await
            .unwrap_or_default();
        let ma = ma_cache.snapshot(&st.screener, || catalog.stock_codes()).await;
        let rows = aggregated
            .into_iter()
            .map(|item| {
                let parsed = StockCode::parse(&item.code).ok();
                let name = parsed.and_then(|sc| stock_name(st, &catalog, sc)).unwrap_or(item.fallback_name);
                let states = parsed.map_or(EtfMaStates::default(), |sc| ma.states(sc));
                EtfAccumulationRow {
                    code: item.code,
                    name,
                    buying_etf_count: item.buying_etf_count,
                    added_etf_count: item.added_etf_count,
                    increased_etf_count: item.increased_etf_count,
                    selling_etf_count: item.selling_etf_count,
                    removed_etf_count: item.removed_etf_count,
                    decreased_etf_count: item.decreased_etf_count,
                    median_real_change: item.median_real_change,
                    ma: states,
                    contributors: item.contributors,
                }
            })
            .collect();
        let response = EtfAccumulation {
            window,
            style,
            direction,
            from_date: Some(api::KstDate(from_date)),
            to_date: Some(api::KstDate(to_date)),
            collected_days,
            ma_as_of: ma.as_of.map(api::KstDate),
            rows,
        };
        self.entries.lock().expect("동시 매집 캐시 잠금").insert(key, CacheEntry { stamp, response: Arc::new(response.clone()) });
        response
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::etf::Catalog;
    use crate::etf::collect::StoredHolding;

    fn query(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    fn meta(code: &str, name: &str, style: EtfStyle) -> FundMeta {
        FundMeta { code: StockCode::parse(code).unwrap(), name: name.into(), style }
    }

    fn snap(entries: &[(&str, &str, f64, u32)]) -> FundSnapshot {
        let holdings = entries.iter().map(|(c, n, q, _)| Held { code: (*c).into(), name: (*n).into(), quantity: *q }).collect();
        let weights = entries.iter().map(|(c, _, _, w)| ((*c).into(), *w)).collect();
        FundSnapshot { holdings, weights }
    }

    fn write_pdf(dir: &Path, day: KstDate, fund_code: &str, rows: &[(&str, &str, f64, u32)]) {
        let day_dir = pdf_dir(dir, day);
        std::fs::create_dir_all(&day_dir).unwrap();
        let stored = StoredPdf {
            schema_version: STORED_SCHEMA_VERSION,
            code: fund_code.into(),
            as_of: day.to_string(),
            holdings: rows.iter().map(|(c, n, q, w)| StoredHolding { code: (*c).into(), name: (*n).into(), cu_quantity: *q, weight_bps: *w }).collect(),
        };
        std::fs::write(day_dir.join(format!("{fund_code}.json")), serde_json::to_vec(&stored).unwrap()).unwrap();
    }

    #[test]
    fn query_parsing_accepts_defaults_and_valid_values_and_rejects_others() {
        assert_eq!(parse_window(&query(&[])).unwrap(), 5);
        assert_eq!(parse_window(&query(&[("window", "5")])).unwrap(), 5);
        assert_eq!(parse_window(&query(&[("window", "20")])).unwrap(), 20);
        for bad in ["", "1", "10", "30", "abc", "-5"] {
            assert!(parse_window(&query(&[("window", bad)])).is_err(), "{bad}");
        }
        assert_eq!(parse_style(&query(&[])).unwrap(), EtfAccumulationStyle::Active);
        assert_eq!(parse_style(&query(&[("style", "active")])).unwrap(), EtfAccumulationStyle::Active);
        assert_eq!(parse_style(&query(&[("style", "all")])).unwrap(), EtfAccumulationStyle::All);
        for bad in ["", "passive", "ACTIVE", "both"] {
            assert!(parse_style(&query(&[("style", bad)])).is_err(), "{bad}");
        }
        assert_eq!(parse_direction(&query(&[])).unwrap(), EtfAccumulationDirection::Buy);
        assert_eq!(parse_direction(&query(&[("direction", "buy")])).unwrap(), EtfAccumulationDirection::Buy);
        assert_eq!(parse_direction(&query(&[("direction", "sell")])).unwrap(), EtfAccumulationDirection::Sell);
        for bad in ["", "BUY", "SELL", "both", "short"] {
            assert!(parse_direction(&query(&[("direction", bad)])).is_err(), "{bad}");
        }
    }

    #[test]
    fn cu_doubling_across_all_holdings_produces_zero_false_accumulation() {
        let fund = meta("444200", "액티브A", EtfStyle::Active);
        let before = snap(&[
            ("005930", "삼성전자", 100.0, 2500),
            ("000660", "SK하이닉스", 200.0, 2500),
            ("035420", "NAVER", 50.0, 2500),
            ("005380", "현대차", 75.0, 2500),
        ]);
        let after = snap(&[
            ("005930", "삼성전자", 200.0, 2500),
            ("000660", "SK하이닉스", 400.0, 2500),
            ("035420", "NAVER", 100.0, 2500),
            ("005380", "현대차", 150.0, 2500),
        ]);
        let pairs = [(fund, before, after)];
        let buy_rows = aggregate_pairs(&pairs, EtfAccumulationDirection::Buy);
        assert!(buy_rows.is_empty(), "CU 2배 증가는 매집으로 잡히면 안 된다: {buy_rows:?}");
        let sell_rows = aggregate_pairs(&pairs, EtfAccumulationDirection::Sell);
        assert!(sell_rows.is_empty(), "CU 2배 증가는 매도로 잡히면 안 된다: {sell_rows:?}");
    }

    #[test]
    fn contributors_and_rows_follow_exact_ranking_and_median_rules() {
        let f1 = meta("444200", "액티브1", EtfStyle::Active);
        let f2 = meta("445290", "액티브2", EtfStyle::Active);
        let f3 = meta("426030", "액티브3", EtfStyle::Active);
        let b1 = snap(&[("000001", "A", 100.0, 3000), ("000002", "B", 100.0, 3000), ("000003", "C", 100.0, 4000)]);
        let a1 = snap(&[("000001", "A", 100.0, 2000), ("000002", "B", 150.0, 3500), ("000003", "C", 100.0, 2500), ("000004", "D", 40.0, 2000)]);
        let b2 = snap(&[("000001", "A", 100.0, 3000), ("000002", "B", 100.0, 3000), ("000003", "C", 100.0, 4000)]);
        let a2 = snap(&[("000001", "A", 100.0, 2000), ("000002", "B", 130.0, 3000), ("000003", "C", 100.0, 3000), ("000004", "D", 60.0, 2000)]);
        let b3 = snap(&[("000001", "A", 100.0, 5000), ("000003", "C", 100.0, 5000)]);
        let a3 = snap(&[("000001", "A", 100.0, 4000), ("000003", "C", 100.0, 4000), ("000002", "B", 20.0, 2000)]);

        let rows = aggregate_pairs(&[(f1, b1, a1), (f2, b2, a2), (f3, b3, a3)], EtfAccumulationDirection::Buy);
        let codes: Vec<&str> = rows.iter().map(|r| r.code.as_str()).collect();
        assert_eq!(codes, ["000002", "000004"]);

        let b_row = &rows[0];
        assert_eq!((b_row.buying_etf_count, b_row.added_etf_count, b_row.increased_etf_count), (3, 1, 2));
        assert_eq!((b_row.selling_etf_count, b_row.removed_etf_count, b_row.decreased_etf_count), (0, 0, 0));
        assert!((b_row.median_real_change.unwrap() - 0.4).abs() < 1e-9);
        let contrib_order: Vec<(&str, EtfChangeKind, Option<u32>, Option<u32>)> =
            b_row.contributors.iter().map(|c| (c.fund_code.as_str(), c.kind, c.before_weight_bps, c.after_weight_bps)).collect();
        assert_eq!(contrib_order, [
            ("426030", EtfChangeKind::Added, None, Some(2000)),
            ("444200", EtfChangeKind::Increased, Some(3000), Some(3500)),
            ("445290", EtfChangeKind::Increased, Some(3000), Some(3000)),
        ]);

        let d_row = &rows[1];
        assert_eq!((d_row.buying_etf_count, d_row.added_etf_count, d_row.increased_etf_count), (2, 2, 0));
        assert_eq!(d_row.median_real_change, None);
        let d_contribs: Vec<&str> = d_row.contributors.iter().map(|c| c.fund_code.as_str()).collect();
        assert_eq!(d_contribs, ["444200", "445290"]);
    }

    #[test]
    fn sell_direction_ranks_removed_before_decreased_and_most_negative_first() {
        let f1 = meta("444200", "액티브1", EtfStyle::Active);
        let f2 = meta("445290", "액티브2", EtfStyle::Active);
        let f3 = meta("426030", "액티브3", EtfStyle::Active);
        let b1 = snap(&[("000001", "A", 100.0, 2500), ("000002", "B", 100.0, 2500), ("000003", "C", 100.0, 2500), ("000004", "D", 100.0, 2500)]);
        let a1 = snap(&[("000001", "A", 100.0, 4000), ("000002", "B", 60.0, 2000), ("000003", "C", 100.0, 4000)]);
        let b2 = snap(&[("000001", "A", 100.0, 2500), ("000002", "B", 100.0, 2500), ("000003", "C", 100.0, 2500), ("000004", "D", 100.0, 2500)]);
        let a2 = snap(&[("000001", "A", 100.0, 3500), ("000002", "B", 80.0, 2500), ("000003", "C", 100.0, 4000)]);
        let b3 = snap(&[("000001", "A", 100.0, 3500), ("000002", "B", 100.0, 3000), ("000003", "C", 100.0, 3500)]);
        let a3 = snap(&[("000001", "A", 100.0, 5000), ("000003", "C", 100.0, 5000)]);

        let rows = aggregate_pairs(&[(f1, b1, a1), (f2, b2, a2), (f3, b3, a3)], EtfAccumulationDirection::Sell);
        let codes: Vec<&str> = rows.iter().map(|r| r.code.as_str()).collect();
        assert_eq!(codes, ["000002", "000004"]);

        let b_row = &rows[0];
        assert_eq!((b_row.buying_etf_count, b_row.added_etf_count, b_row.increased_etf_count), (0, 0, 0));
        assert_eq!((b_row.selling_etf_count, b_row.removed_etf_count, b_row.decreased_etf_count), (3, 1, 2));
        assert!((b_row.median_real_change.unwrap() - (-0.3)).abs() < 1e-9);
        let contrib_order: Vec<(&str, EtfChangeKind, Option<u32>, Option<u32>)> =
            b_row.contributors.iter().map(|c| (c.fund_code.as_str(), c.kind, c.before_weight_bps, c.after_weight_bps)).collect();
        assert_eq!(contrib_order, [
            ("426030", EtfChangeKind::Removed, Some(3000), None),
            ("444200", EtfChangeKind::Decreased, Some(2500), Some(2000)),
            ("445290", EtfChangeKind::Decreased, Some(2500), Some(2500)),
        ]);

        let d_row = &rows[1];
        assert_eq!((d_row.selling_etf_count, d_row.removed_etf_count, d_row.decreased_etf_count), (2, 2, 0));
        assert_eq!(d_row.median_real_change, None);
    }

    #[test]
    fn window_selection_uses_exact_steps_or_clamps_to_oldest() {
        let days: Vec<KstDate> = (1..=25).map(|d| KstDate::parse_yyyymmdd(&format!("202611{d:02}")).unwrap()).collect();
        let w5 = window_slice(&days, 5);
        assert_eq!((w5[0], w5[w5.len() - 1], w5.len()), (days[19], days[24], 6));
        let w20 = window_slice(&days, 20);
        assert_eq!((w20[0], w20[w20.len() - 1], w20.len()), (days[4], days[24], 21));
        let short = &days[..3];
        let clamped = window_slice(short, 5);
        assert_eq!((clamped[0], clamped[clamped.len() - 1], clamped.len()), (days[0], days[2], 3));
    }

    #[test]
    fn empty_and_single_day_directories_yield_graceful_empty_stamp() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(discover_days(tmp.path()), Vec::<KstDate>::new());
        let d1 = KstDate::parse_yyyymmdd("20261118").unwrap();
        write_pdf(tmp.path(), d1, "444200", &[("005930", "삼성전자", 100.0, 10_000)]);
        assert_eq!(discover_days(tmp.path()), vec![d1]);
        let stamp = scan_stamp(tmp.path(), 5);
        assert_eq!(stamp.days.len(), 1);
        assert!(stamp.window_dir_mtimes.is_empty());
    }

    #[test]
    #[ignore]
    fn perf_119_etfs_20_days_cold_and_warm_cache() {
        let catalog = Catalog::embedded();
        assert_eq!(catalog.funds().len(), 119);
        let tmp = tempfile::tempdir().unwrap();
        let days: Vec<KstDate> = (1..=21).map(|d| KstDate::parse_yyyymmdd(&format!("202611{d:02}")).unwrap()).collect();
        let stock_codes: Vec<String> = (0..50).map(|i| format!("{:06}", 100000 + i)).collect();
        for (day_idx, &day) in days.iter().enumerate() {
            for (fund_idx, fund) in catalog.funds().iter().enumerate() {
                let mut rows: Vec<(&str, &str, f64, u32)> = Vec::with_capacity(30);
                for slot in 0..30 {
                    let stock_idx = (fund_idx + slot) % stock_codes.len();
                    let base = 1000.0;
                    let qty = if day_idx == 20 && slot < 3 { base * 1.25 } else { base };
                    rows.push((stock_codes[stock_idx].as_str(), "종목", qty, 333));
                }
                write_pdf(tmp.path(), day, fund.code.as_str(), &rows);
            }
        }
        let funds: Vec<FundMeta> = catalog.funds().iter().map(|f| FundMeta { code: f.code, name: f.name.clone(), style: f.style }).collect();
        let mut cold_ms = Vec::new();
        let mut warm_ms = Vec::new();
        let mut last_rows = 0usize;
        for _ in 0..5 {
            let t0 = Instant::now();
            let stamp = scan_stamp(tmp.path(), 20);
            let slice = window_slice(&stamp.days, 20);
            let rows = compute_from_dir(tmp.path(), slice, &funds, EtfAccumulationDirection::Buy);
            let elapsed = t0.elapsed().as_secs_f64() * 1000.0;
            assert!(!rows.is_empty());
            last_rows = rows.len();
            cold_ms.push(elapsed);

            let t1 = Instant::now();
            let stamp2 = scan_stamp(tmp.path(), 20);
            assert_eq!(stamp, stamp2);
            warm_ms.push(t1.elapsed().as_secs_f64() * 1000.0);
        }
        cold_ms.sort_by(f64::total_cmp);
        warm_ms.sort_by(f64::total_cmp);
        println!("perf_119_etfs_20_days: rows={last_rows} cold_ms_runs={cold_ms:.2?} cold_median={:.2}ms warm_ms_runs={warm_ms:.3?} warm_median={:.3}ms", cold_ms[2], warm_ms[2]);
        assert!(cold_ms[2] < 150.0, "cold median {:.2}ms exceeded 150ms", cold_ms[2]);
        assert!(warm_ms[2] < 3.0, "warm median {:.3}ms exceeded 3ms", warm_ms[2]);
    }
}
