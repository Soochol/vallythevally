pub mod brokers;
pub mod query;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use domain::{KstDate, StockCode};
use serde::Deserialize;

use crate::collected_store::{FileStamp, read_path_stamp};

const HOGAPLAY_DIR: &str = "hogaplay";
const PARQUET_SUBDIR: &str = "parquet";
const META_FILE: &str = "meta.json";
const SNAPSHOTS_FILE: &str = "snapshots.parquet";
const TRADES_FILE: &str = "trades.parquet";
const BROKERS_FILE: &str = "brokers.parquet";
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_SECOND: i64 = 1_000;

#[derive(Debug, Clone)]
pub struct ArchiveCatalogSummary {
    pub days: u32,
    pub latest_date: String,
}

#[derive(Debug, Clone)]
pub(crate) enum ArchiveDayLookup {
    MissingDay,
    MissingStock,
    Found { hogaplay_dir: PathBuf, stamp: FileStamp },
}

struct CachedArchiveIndex {
    root: PathBuf,
    days_by_stock: HashMap<String, Vec<String>>,
    stocks_by_day: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Default)]
pub struct HogaArchive {
    index: Mutex<Option<CachedArchiveIndex>>,
}

#[derive(Deserialize)]
struct HogaplayMeta {
    #[serde(default)]
    prev_close: Option<i64>,
}

impl HogaArchive {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn days_for_stock(&self, root: &Path, stock_code: &str) -> Result<Vec<String>, String> {
        self.with_index(root, |index| {
            index.days_by_stock.get(stock_code).cloned().unwrap_or_default()
        })
    }

    pub fn catalog(&self, root: &Path) -> Result<BTreeMap<String, ArchiveCatalogSummary>, String> {
        self.with_index(root, |index| {
            let mut out = BTreeMap::new();
            for (code, days) in &index.days_by_stock {
                if let Some(latest) = days.last() {
                    out.insert(
                        code.clone(),
                        ArchiveCatalogSummary {
                            days: days.len().min(u32::MAX as usize) as u32,
                            latest_date: latest.clone(),
                        },
                    );
                }
            }
            out
        })
    }

    pub(crate) fn lookup_day(&self, root: &Path, date_str: &str, stock_code: &str) -> Result<ArchiveDayLookup, String> {
        let resolved_root = self.with_index(root, |index| {
            let Some(stocks) = index.stocks_by_day.get(date_str) else {
                return Ok::<_, ()>(None);
            };
            if !stocks.contains(stock_code) {
                return Err(());
            }
            Ok(Some(index.root.clone()))
        })?;
        let base = match resolved_root {
            Ok(None) => return Ok(ArchiveDayLookup::MissingDay),
            Err(()) => return Ok(ArchiveDayLookup::MissingStock),
            Ok(Some(base)) => base,
        };
        let hogaplay_dir = base.join(date_str).join(stock_code).join(HOGAPLAY_DIR);
        let Some(stamp) = archive_dir_stamp(&hogaplay_dir)? else {
            return Ok(ArchiveDayLookup::MissingStock);
        };
        Ok(ArchiveDayLookup::Found { hogaplay_dir, stamp })
    }

    pub(crate) fn stamp_for(&self, root: &Path, date_str: &str, stock_code: &str) -> Result<Option<FileStamp>, String> {
        match self.lookup_day(root, date_str, stock_code)? {
            ArchiveDayLookup::Found { stamp, .. } => Ok(Some(stamp)),
            ArchiveDayLookup::MissingDay | ArchiveDayLookup::MissingStock => Ok(None),
        }
    }

    fn with_index<T>(&self, root: &Path, f: impl FnOnce(&CachedArchiveIndex) -> T) -> Result<T, String> {
        let resolved = resolve_archive_root(root);
        let mut guard = self.index.lock().expect("hoga archive index lock");
        let needs_build = match guard.as_ref() {
            Some(cached) => cached.root != resolved,
            None => true,
        };
        if needs_build {
            let built = scan_archive_index(&resolved)?;
            *guard = Some(built);
        }
        Ok(f(guard.as_ref().expect("hoga archive index populated")))
    }
}

fn resolve_archive_root(root: &Path) -> PathBuf {
    if has_date_subdirs(root) {
        return root.to_path_buf();
    }
    let nested = root.join(PARQUET_SUBDIR);
    if nested.is_dir() && has_date_subdirs(&nested) {
        return nested;
    }
    root.to_path_buf()
}

fn has_date_subdirs(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if KstDate::parse_yyyymmdd(&name).is_some() && entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            return true;
        }
    }
    false
}

fn scan_archive_index(root: &Path) -> Result<CachedArchiveIndex, String> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(CachedArchiveIndex {
                root: root.to_path_buf(),
                days_by_stock: HashMap::new(),
                stocks_by_day: BTreeMap::new(),
            });
        }
        Err(error) => return Err(format!("아카이브 폴더를 읽을 수 없습니다({}): {error}", root.display())),
    };

    let mut date_dirs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("아카이브 항목을 읽을 수 없습니다({}): {error}", root.display()))?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        if KstDate::parse_yyyymmdd(&name).is_some() && entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            date_dirs.push(name);
        }
    }
    date_dirs.sort_unstable();

    let mut days_by_stock: HashMap<String, Vec<String>> = HashMap::new();
    let mut stocks_by_day: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for date in date_dirs {
        let day_path = root.join(&date);
        let Ok(stock_entries) = std::fs::read_dir(&day_path) else {
            continue;
        };
        let mut day_stocks = BTreeSet::new();
        for stock_entry in stock_entries.flatten() {
            let Ok(code) = stock_entry.file_name().into_string() else { continue };
            if StockCode::parse(&code).is_err() {
                continue;
            }
            if !stock_entry.file_type().is_ok_and(|ft| ft.is_dir()) {
                continue;
            }
            let hogaplay_dir = stock_entry.path().join(HOGAPLAY_DIR);
            if has_hogaplay_data(&hogaplay_dir) {
                days_by_stock.entry(code.clone()).or_default().push(date.clone());
                day_stocks.insert(code);
            }
        }
        if !day_stocks.is_empty() {
            stocks_by_day.insert(date, day_stocks);
        }
    }

    Ok(CachedArchiveIndex {
        root: root.to_path_buf(),
        days_by_stock,
        stocks_by_day,
    })
}

fn has_hogaplay_data(hogaplay_dir: &Path) -> bool {
    hogaplay_dir.is_dir()
        && (hogaplay_dir.join(SNAPSHOTS_FILE).is_file()
            || hogaplay_dir.join(TRADES_FILE).is_file()
            || hogaplay_dir.join(BROKERS_FILE).is_file())
}

fn archive_dir_stamp(hogaplay_dir: &Path) -> Result<Option<FileStamp>, String> {
    for file in [SNAPSHOTS_FILE, TRADES_FILE, BROKERS_FILE] {
        if let Some(stamp) = read_path_stamp(&hogaplay_dir.join(file))? {
            return Ok(Some(stamp));
        }
    }
    Ok(None)
}

pub fn read_meta_previous_close(hogaplay_dir: &Path) -> Option<u64> {
    let bytes = std::fs::read(hogaplay_dir.join(META_FILE)).ok()?;
    let meta: HogaplayMeta = serde_json::from_slice(&bytes).ok()?;
    meta.prev_close.and_then(|value| u64::try_from(value).ok()).filter(|&value| value > 0)
}

pub fn hhmmss_mmm_to_day_ms(ts_ms: i64) -> Option<i64> {
    if ts_ms < 0 {
        return None;
    }
    let hour = ts_ms / 10_000_000;
    let minute = (ts_ms / 100_000) % 100;
    let second = (ts_ms / 1_000) % 100;
    let millis = ts_ms % 1_000;
    if hour >= 24 || minute >= 60 || second >= 60 {
        return None;
    }
    Some(hour * MS_PER_HOUR + minute * MS_PER_MINUTE + second * MS_PER_SECOND + millis)
}

pub fn hhmmss_mmm_to_sec(ts_ms: i64) -> Option<u32> {
    hhmmss_mmm_to_day_ms(ts_ms).map(|ms| (ms / MS_PER_SECOND) as u32)
}

pub fn hhmmss_mmm_to_minute(ts_ms: i64) -> Option<u32> {
    hhmmss_mmm_to_day_ms(ts_ms).map(|ms| (ms / MS_PER_MINUTE) as u32)
}

pub fn day_minute_to_hhmmss_mmm(minute: u16) -> i64 {
    let clamped = minute.min(1440);
    let hour = i64::from(clamped / 60);
    let min = i64::from(clamped % 60);
    hour * 10_000_000 + min * 100_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hhmmss_mmm_converts_kst_wall_clock_to_day_ms() {
        assert_eq!(hhmmss_mmm_to_day_ms(90144276), Some((9 * 3600 + 60 + 44) * 1000 + 276));
        assert_eq!(hhmmss_mmm_to_day_ms(200000743), Some(20 * 3600 * 1000 + 743));
        assert_eq!(hhmmss_mmm_to_day_ms(0), Some(0));
        assert_eq!(hhmmss_mmm_to_day_ms(240000000), None);
        assert_eq!(hhmmss_mmm_to_day_ms(96000000), None);
        assert_eq!(hhmmss_mmm_to_day_ms(90060000), None);
        assert_eq!(hhmmss_mmm_to_day_ms(-1), None);
        assert_eq!(day_minute_to_hhmmss_mmm(540), 90_000_000);
        assert_eq!(day_minute_to_hhmmss_mmm(545), 90_500_000);
        assert_eq!(day_minute_to_hhmmss_mmm(930), 153_000_000);
    }

    #[test]
    fn archive_index_discovers_nested_parquet_root_and_meta_prev_close() {
        let tmp = tempfile::tempdir().unwrap();
        let hp = tmp.path().join("parquet").join("20240827").join("009540").join("hogaplay");
        std::fs::create_dir_all(&hp).unwrap();
        std::fs::write(hp.join("snapshots.parquet"), b"stub").unwrap();
        std::fs::write(hp.join("meta.json"), r#"{"code":"009540","prev_close":185000}"#).unwrap();

        let archive = HogaArchive::new();
        assert_eq!(archive.days_for_stock(tmp.path(), "009540").unwrap(), vec!["20240827"]);
        assert!(archive.days_for_stock(tmp.path(), "005930").unwrap().is_empty());
        assert_eq!(read_meta_previous_close(&hp), Some(185_000));
        let catalog = archive.catalog(tmp.path()).unwrap();
        assert_eq!(catalog["009540"].days, 1);
        assert_eq!(catalog["009540"].latest_date, "20240827");
    }
}
