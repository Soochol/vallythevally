use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsStr;
use std::hash::{Hash, Hasher};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
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

const MAX_AFTER_LAG_TRADING_DAYS: usize = 1;
const MAX_AFTER_LAG_CALENDAR_DAYS: i64 = 5;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    ino: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirWatch {
    dir_names_fingerprint: u64,
    watched_files: Vec<(PathBuf, Option<FileStamp>)>,
}

struct CacheEntry {
    dir_watch: DirWatch,
    catalog_revision: u64,
    ma_generation: u64,
    symbols_revision: u64,
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

struct Discovery {
    days: Vec<KstDate>,
    dir_names_fingerprint: u64,
    watch_paths: Vec<PathBuf>,
}

fn max_calendar_span_days(window: u32) -> i64 {
    i64::from(window) * 2 + 10
}

fn window_slice(days: &[KstDate], window: u32) -> &[KstDate] {
    let to_idx = days.len() - 1;
    let to_day = days[to_idx];
    let min_day = KstDate::from_days_since_epoch(to_day.days_since_epoch() - max_calendar_span_days(window));
    let mut from_idx = to_idx.saturating_sub(window as usize);
    while from_idx < to_idx && days[from_idx] < min_day {
        from_idx += 1;
    }
    &days[from_idx..=to_idx]
}

fn is_fresh_after(after_idx: usize, last_idx: usize, after_day: KstDate, to_day: KstDate) -> bool {
    last_idx.saturating_sub(after_idx) <= MAX_AFTER_LAG_TRADING_DAYS
        && to_day.days_since_epoch() - after_day.days_since_epoch() <= MAX_AFTER_LAG_CALENDAR_DAYS
}

fn is_snapshot_json_name(name: &OsStr) -> bool {
    #[cfg(unix)]
    {
        let bytes = name.as_bytes();
        bytes.ends_with(b".json") && !bytes.ends_with(RAW_SUFFIX.as_bytes())
    }
    #[cfg(not(unix))]
    {
        let text = name.to_string_lossy();
        text.ends_with(".json") && !text.ends_with(RAW_SUFFIX)
    }
}

fn fnv1a_bytes(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn hash_snapshot_name(name: &OsStr) -> u64 {
    #[cfg(unix)]
    {
        fnv1a_bytes(name.as_bytes())
    }
    #[cfg(not(unix))]
    {
        fnv1a_bytes(name.to_string_lossy().as_bytes())
    }
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        len: meta.len(),
        modified: meta.modified().ok(),
        #[cfg(unix)]
        ino: meta.ino(),
    })
}

fn scan_day_names(dir: &Path) -> Vec<KstDate> {
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

fn hash_day_snapshot_names(path: &Path, hasher: &mut DefaultHasher) {
    let Ok(entries) = std::fs::read_dir(path) else {
        0usize.hash(hasher);
        return;
    };
    let mut count = 0usize;
    let mut sum = 0u64;
    let mut xor = 0u64;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !is_snapshot_json_name(&name) {
            continue;
        }
        let h = hash_snapshot_name(&name);
        count += 1;
        sum = sum.wrapping_add(h);
        xor ^= h;
    }
    count.hash(hasher);
    sum.hash(hasher);
    xor.hash(hasher);
}

fn scan_dir_names_fingerprint(dir: &Path) -> u64 {
    let all_dirs = scan_day_names(dir);
    let mut hasher = DefaultHasher::new();
    all_dirs.len().hash(&mut hasher);
    for day in all_dirs {
        day.days_since_epoch().hash(&mut hasher);
        hash_day_snapshot_names(&pdf_dir(dir, day), &mut hasher);
    }
    hasher.finish()
}

impl DirWatch {
    fn from_paths(dir_names_fingerprint: u64, paths: Vec<PathBuf>) -> DirWatch {
        let mut seen = HashSet::with_capacity(paths.len());
        let mut watched_files = Vec::with_capacity(paths.len());
        for path in paths {
            if seen.insert(path.clone()) {
                let stamp = file_stamp(&path);
                watched_files.push((path, stamp));
            }
        }
        DirWatch { dir_names_fingerprint, watched_files }
    }

    fn is_fresh(&self, dir: &Path) -> bool {
        if scan_dir_names_fingerprint(dir) != self.dir_names_fingerprint {
            return false;
        }
        self.watched_files.iter().all(|(path, expected)| file_stamp(path) == *expected)
    }
}

fn inspect_day_dir(path: &Path, day: KstDate, hasher: &mut DefaultHasher, watch_paths: &mut Vec<PathBuf>) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        0usize.hash(hasher);
        return false;
    };
    let mut count = 0usize;
    let mut sum = 0u64;
    let mut xor = 0u64;
    let mut witness: Option<PathBuf> = None;
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !is_snapshot_json_name(&name) {
            continue;
        }
        let h = hash_snapshot_name(&name);
        count += 1;
        sum = sum.wrapping_add(h);
        xor ^= h;
        if witness.is_none() {
            let entry_path = entry.path();
            let valid = name
                .to_str()
                .and_then(|text| text.strip_suffix(".json"))
                .and_then(|stem| StockCode::parse(stem).ok())
                .is_some_and(|code| is_valid_stored_snapshot(&entry_path, code, day));
            if valid {
                witness = Some(entry_path);
            } else {
                candidates.push(entry_path);
            }
        }
    }
    count.hash(hasher);
    sum.hash(hasher);
    xor.hash(hasher);
    if let Some(valid_path) = witness {
        watch_paths.push(valid_path);
        true
    } else {
        watch_paths.extend(candidates);
        false
    }
}

fn discover_days_detailed(dir: &Path) -> Discovery {
    let all_dirs = scan_day_names(dir);
    let mut hasher = DefaultHasher::new();
    all_dirs.len().hash(&mut hasher);
    let mut days = Vec::with_capacity(all_dirs.len());
    let mut watch_paths = Vec::with_capacity(all_dirs.len());
    for day in all_dirs {
        day.days_since_epoch().hash(&mut hasher);
        if inspect_day_dir(&pdf_dir(dir, day), day, &mut hasher, &mut watch_paths) {
            days.push(day);
        }
    }
    Discovery { days, dir_names_fingerprint: hasher.finish(), watch_paths }
}

pub(super) fn discover_days(dir: &Path) -> Vec<KstDate> {
    discover_days_detailed(dir).days
}

pub(super) fn hash_day_dir(path: &Path, hasher: &mut DefaultHasher) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    let mut count = 0usize;
    let mut sum = 0u64;
    let mut xor = 0u64;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !is_snapshot_json_name(&name) {
            continue;
        }
        let mut entry_hasher = DefaultHasher::new();
        hash_snapshot_name(&name).hash(&mut entry_hasher);
        if let Ok(meta) = entry.metadata() {
            meta.len().hash(&mut entry_hasher);
            meta.modified().ok().hash(&mut entry_hasher);
            #[cfg(unix)]
            meta.ino().hash(&mut entry_hasher);
        }
        let h = entry_hasher.finish();
        count += 1;
        sum = sum.wrapping_add(h);
        xor ^= h;
    }
    count.hash(hasher);
    sum.hash(hasher);
    xor.hash(hasher);
}

fn parse_stored_snapshot(bytes: &[u8], code: StockCode, day: KstDate) -> Result<FundSnapshot, String> {
    let stored: StoredPdf = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if stored.schema_version != STORED_SCHEMA_VERSION || stored.code != code.as_str() || stored.as_of != day.to_string() {
        return Err("자료 버전·ETF 코드·기준일이 파일 위치와 다릅니다".into());
    }
    if stored.holdings.is_empty() {
        return Err("구성 종목이 없습니다".into());
    }
    let mut holdings = Vec::with_capacity(stored.holdings.len());
    let mut weights = HashMap::with_capacity(stored.holdings.len());
    let mut has_positive_holding = false;
    for h in stored.holdings {
        if h.cu_quantity.is_finite() && h.cu_quantity > 0.0 {
            has_positive_holding = true;
        }
        weights.insert(h.code.clone(), h.weight_bps);
        holdings.push(Held { code: h.code, name: h.name, quantity: h.cu_quantity });
    }
    if !has_positive_holding {
        return Err("유효한 보유 수량이 없습니다".into());
    }
    Ok(FundSnapshot { holdings, weights })
}

fn is_valid_stored_snapshot(path: &Path, code: StockCode, day: KstDate) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    parse_stored_snapshot(&bytes, code, day).is_ok()
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
    match parse_stored_snapshot(&bytes, code, day) {
        Ok(snapshot) => Some(snapshot),
        Err(reason) => {
            tracing::warn!(file = %path.display(), %reason, "저장된 ETF 구성을 동시 매집 집계에 쓰지 않습니다");
            None
        }
    }
}

fn read_watched_snapshot(path: PathBuf, code: StockCode, day: KstDate, watch_paths: &mut Vec<PathBuf>) -> Option<FundSnapshot> {
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            watch_paths.push(path.clone());
            tracing::warn!(file = %path.display(), error = %e, "저장된 ETF 구성을 동시 매집 집계에 읽지 못했습니다");
            return None;
        }
    };
    watch_paths.push(path.clone());
    match parse_stored_snapshot(&bytes, code, day) {
        Ok(snapshot) => Some(snapshot),
        Err(reason) => {
            tracing::warn!(file = %path.display(), %reason, "저장된 ETF 구성을 동시 매집 집계에 쓰지 않습니다");
            None
        }
    }
}

fn load_fund_endpoints(dir: &Path, window_days: &[KstDate], code: StockCode, watch_paths: &mut Vec<PathBuf>) -> Option<(FundSnapshot, FundSnapshot)> {
    if window_days.len() < 2 {
        return None;
    }
    let last_idx = window_days.len() - 1;
    let to_day = window_days[last_idx];
    let min_after_idx = last_idx.saturating_sub(MAX_AFTER_LAG_TRADING_DAYS).max(1);
    let file_name = format!("{}.json", code.as_str());
    let mut latest: Option<(usize, FundSnapshot)> = None;
    for idx in (min_after_idx..=last_idx).rev() {
        let day = window_days[idx];
        if !is_fresh_after(idx, last_idx, day, to_day) {
            break;
        }
        if let Some(snapshot) = read_watched_snapshot(pdf_dir(dir, day).join(&file_name), code, day, watch_paths) {
            latest = Some((idx, snapshot));
            break;
        }
    }
    let (after_idx, after) = latest?;
    for &day in &window_days[..after_idx] {
        if let Some(before) = read_watched_snapshot(pdf_dir(dir, day).join(&file_name), code, day, watch_paths) {
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
            if matches!(row.kind, EtfChangeKind::Increased | EtfChangeKind::Decreased)
                && !row.real_change.is_some_and(f64::is_finite)
            {
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

struct ComputedDir {
    collected_days: u32,
    range: Option<(KstDate, KstDate)>,
    rows: Vec<AggregatedStock>,
    dir_watch: DirWatch,
}

fn compute_watched(dir: &Path, window: u32, funds: &[FundMeta], direction: EtfAccumulationDirection) -> ComputedDir {
    let mut discovery = discover_days_detailed(dir);
    let collected_days = discovery.days.len() as u32;
    if discovery.days.len() < 2 {
        let dir_watch = DirWatch::from_paths(discovery.dir_names_fingerprint, discovery.watch_paths);
        return ComputedDir { collected_days, range: None, rows: Vec::new(), dir_watch };
    }
    let slice = window_slice(&discovery.days, window);
    if slice.len() < 2 {
        let dir_watch = DirWatch::from_paths(discovery.dir_names_fingerprint, discovery.watch_paths);
        return ComputedDir { collected_days, range: None, rows: Vec::new(), dir_watch };
    }
    let from_date = slice[0];
    let to_date = slice[slice.len() - 1];
    let mut pairs = Vec::with_capacity(funds.len());
    for fund in funds {
        if let Some((before, after)) = load_fund_endpoints(dir, slice, fund.code, &mut discovery.watch_paths) {
            pairs.push((fund.clone(), before, after));
        }
    }
    let rows = aggregate_pairs(&pairs, direction);
    let dir_watch = DirWatch::from_paths(discovery.dir_names_fingerprint, discovery.watch_paths);
    ComputedDir { collected_days, range: Some((from_date, to_date)), rows, dir_watch }
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
        let catalog = st.etf.catalog();
        let catalog_revision = st.etf.revision();
        let ma_generation = st.screener.store_generation().await.ok();
        let symbols_revision = st.symbols.revision();
        let key = (window, style, direction);
        let cached = ma_generation.and_then(|ma_gen| {
            let guard = self.entries.lock().expect("동시 매집 캐시 잠금");
            let entry = guard.get(&key)?;
            if entry.catalog_revision == catalog_revision
                && entry.ma_generation == ma_gen
                && entry.symbols_revision == symbols_revision
            {
                Some((entry.dir_watch.clone(), entry.response.clone()))
            } else {
                None
            }
        });
        if let Some((dir_watch, response)) = cached {
            let check_dir = dir.clone();
            let fresh = tokio::task::spawn_blocking(move || dir_watch.is_fresh(&check_dir))
                .await
                .unwrap_or(false);
            if fresh {
                return (*response).clone();
            }
        }
        let funds: Vec<FundMeta> = catalog
            .funds()
            .iter()
            .filter(|f| style_matches(f.style, style))
            .map(|f| FundMeta { code: f.code, name: f.name.clone(), style: f.style })
            .collect();
        let computed = tokio::task::spawn_blocking(move || compute_watched(&dir, window, &funds, direction))
            .await
            .unwrap_or_else(|_| ComputedDir {
                collected_days: 0,
                range: None,
                rows: Vec::new(),
                dir_watch: DirWatch { dir_names_fingerprint: 0, watched_files: Vec::new() },
            });
        let Some((from_date, to_date)) = computed.range else {
            let response = empty_response(window, style, direction, computed.collected_days);
            if let Some(ma_generation) = ma_generation {
                self.entries.lock().expect("동시 매집 캐시 잠금").insert(
                    key,
                    CacheEntry {
                        dir_watch: computed.dir_watch,
                        catalog_revision,
                        ma_generation,
                        symbols_revision,
                        response: Arc::new(response.clone()),
                    },
                );
            }
            return response;
        };
        let aggregated = computed.rows;
        let ma = ma_cache
            .snapshot(&st.screener, || {
                let mut codes = catalog.stock_codes();
                codes.extend(aggregated.iter().filter_map(|item| StockCode::parse(&item.code).ok()));
                codes
            })
            .await;
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
            collected_days: computed.collected_days,
            ma_as_of: ma.as_of.map(api::KstDate),
            rows,
        };
        if ma.ok
            && let Some(ma_generation) = ma_generation
        {
            self.entries.lock().expect("동시 매집 캐시 잠금").insert(
                key,
                CacheEntry {
                    dir_watch: computed.dir_watch,
                    catalog_revision,
                    ma_generation,
                    symbols_revision,
                    response: Arc::new(response.clone()),
                },
            );
        }
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
        let computed = compute_watched(tmp.path(), 5, &[], EtfAccumulationDirection::Buy);
        assert_eq!(computed.collected_days, 1);
        assert!(computed.range.is_none());
        assert!(computed.dir_watch.is_fresh(tmp.path()));
    }

    #[test]
    fn discover_days_ignores_empty_raw_only_and_corrupt_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let d1 = KstDate::parse_yyyymmdd("20261117").unwrap();
        let d2 = KstDate::parse_yyyymmdd("20261118").unwrap();
        let d_empty = KstDate::parse_yyyymmdd("20261119").unwrap();
        let d_raw = KstDate::parse_yyyymmdd("20261120").unwrap();
        let d_corrupt = KstDate::parse_yyyymmdd("20261121").unwrap();
        let d_mismatch = KstDate::parse_yyyymmdd("20261122").unwrap();
        let d_zero_holdings = KstDate::parse_yyyymmdd("20261123").unwrap();

        write_pdf(tmp.path(), d1, "444200", &[("005930", "삼성전자", 100.0, 10_000)]);
        write_pdf(tmp.path(), d2, "444200", &[("005930", "삼성전자", 100.0, 10_000)]);
        std::fs::create_dir_all(pdf_dir(tmp.path(), d_empty)).unwrap();
        std::fs::create_dir_all(pdf_dir(tmp.path(), d_raw)).unwrap();
        std::fs::write(pdf_dir(tmp.path(), d_raw).join("444200.raw.json"), b"[]").unwrap();
        std::fs::create_dir_all(pdf_dir(tmp.path(), d_corrupt)).unwrap();
        std::fs::write(pdf_dir(tmp.path(), d_corrupt).join("444200.json"), b"{not json").unwrap();
        std::fs::create_dir_all(pdf_dir(tmp.path(), d_mismatch)).unwrap();
        std::fs::write(
            pdf_dir(tmp.path(), d_mismatch).join("444200.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "code": "444200",
                "asOf": "2026-11-21",
                "holdings": [{"code": "005930", "name": "삼성전자", "cuQuantity": 100.0, "weightBps": 10000}]
            })
            .to_string(),
        )
        .unwrap();
        write_pdf(tmp.path(), d_zero_holdings, "444200", &[]);

        assert_eq!(discover_days(tmp.path()), vec![d1, d2]);
    }

    #[test]
    fn window_slice_and_endpoints_exclude_stale_multi_month_and_lagging_etfs() {
        let aug1 = KstDate::parse_yyyymmdd("20260801").unwrap();
        let aug2 = KstDate::parse_yyyymmdd("20260802").unwrap();
        let nov18 = KstDate::parse_yyyymmdd("20261118").unwrap();
        let nov19 = KstDate::parse_yyyymmdd("20261119").unwrap();
        assert_eq!(window_slice(&[aug1, aug2, nov18, nov19], 5), &[nov18, nov19]);
        assert_eq!(window_slice(&[aug1, nov18], 5), &[nov18]);

        let tmp = tempfile::tempdir().unwrap();
        let days: Vec<KstDate> = (1..=21).map(|d| KstDate::parse_yyyymmdd(&format!("202611{d:02}")).unwrap()).collect();
        let stale_early = StockCode::parse("444200").unwrap();
        let stale_two_days = StockCode::parse("445290").unwrap();
        let lag_one_day = StockCode::parse("426030").unwrap();
        let fresh = StockCode::parse("494890").unwrap();
        write_pdf(tmp.path(), days[0], stale_early.as_str(), &[("005930", "삼성전자", 100.0, 10_000)]);
        write_pdf(tmp.path(), days[1], stale_early.as_str(), &[("005930", "삼성전자", 150.0, 10_000)]);
        write_pdf(tmp.path(), days[0], stale_two_days.as_str(), &[("005930", "삼성전자", 100.0, 10_000)]);
        write_pdf(tmp.path(), days[18], stale_two_days.as_str(), &[("005930", "삼성전자", 150.0, 10_000)]);
        write_pdf(tmp.path(), days[0], lag_one_day.as_str(), &[("005930", "삼성전자", 100.0, 10_000)]);
        write_pdf(tmp.path(), days[19], lag_one_day.as_str(), &[("005930", "삼성전자", 150.0, 10_000)]);
        write_pdf(tmp.path(), days[19], fresh.as_str(), &[("005930", "삼성전자", 100.0, 10_000)]);
        write_pdf(tmp.path(), days[20], fresh.as_str(), &[("005930", "삼성전자", 150.0, 10_000)]);

        let mut watched = Vec::new();
        assert!(load_fund_endpoints(tmp.path(), &days, stale_early, &mut watched).is_none());
        assert!(load_fund_endpoints(tmp.path(), &days, stale_two_days, &mut watched).is_none());
        assert!(load_fund_endpoints(tmp.path(), &days, lag_one_day, &mut watched).is_some());
        assert!(load_fund_endpoints(tmp.path(), &days, fresh, &mut watched).is_some());
    }

    #[test]
    fn read_stored_snapshot_rejects_empty_and_zero_holdings() {
        let tmp = tempfile::tempdir().unwrap();
        let d1 = KstDate::parse_yyyymmdd("20261118").unwrap();
        let code = StockCode::parse("444200").unwrap();
        write_pdf(tmp.path(), d1, code.as_str(), &[]);
        assert!(read_stored_snapshot(&pdf_dir(tmp.path(), d1).join("444200.json"), code, d1).is_none());

        write_pdf(tmp.path(), d1, code.as_str(), &[("005930", "삼성전자", 0.0, 10_000)]);
        assert!(read_stored_snapshot(&pdf_dir(tmp.path(), d1).join("444200.json"), code, d1).is_none());
    }

    #[test]
    fn aggregate_pairs_ignores_underflow_and_non_finite_real_changes() {
        let fund = meta("444200", "액티브A", EtfStyle::Active);
        let before = snap(&[("000001", "A", 1e200, 3000), ("000002", "B", 1e200, 3000), ("005930", "삼성전자", 100.0, 4000)]);
        let after = snap(&[("000001", "A", 1e-200, 3000), ("000002", "B", 1e-200, 3000), ("005930", "삼성전자", 100.0, 4000)]);
        let buy_rows = aggregate_pairs(&[(fund, before, after)], EtfAccumulationDirection::Buy);
        assert!(buy_rows.is_empty(), "{buy_rows:?}");
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
            let computed = compute_watched(tmp.path(), 20, &funds, EtfAccumulationDirection::Buy);
            let elapsed = t0.elapsed().as_secs_f64() * 1000.0;
            assert!(!computed.rows.is_empty());
            last_rows = computed.rows.len();
            cold_ms.push(elapsed);

            let t1 = Instant::now();
            assert!(computed.dir_watch.is_fresh(tmp.path()));
            warm_ms.push(t1.elapsed().as_secs_f64() * 1000.0);
        }
        cold_ms.sort_by(f64::total_cmp);
        warm_ms.sort_by(f64::total_cmp);
        println!("perf_119_etfs_20_days: rows={last_rows} cold_ms_runs={cold_ms:.2?} cold_median={:.2}ms warm_ms_runs={warm_ms:.3?} warm_median={:.3}ms", cold_ms[2], warm_ms[2]);
        assert!(cold_ms[2] < 150.0, "cold median {:.2}ms exceeded 150ms", cold_ms[2]);
        assert!(warm_ms[2] < 3.0, "warm median {:.3}ms exceeded 3ms", warm_ms[2]);
    }
}
