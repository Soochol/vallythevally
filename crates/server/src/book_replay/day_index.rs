use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use domain::KstDate;
use serde::Deserialize;

const SUPPORTED_FORMAT_VERSION: u32 = 1;
const DEFAULT_BUCKETS: u64 = 64;
const DEFAULT_END_MINUTE_EXCLUSIVE: u32 = 20 * 60 + 5;
const MAX_DAY_FOLDERS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileStamp {
    pub len: u64,
    pub modified: Option<SystemTime>,
}

#[derive(Debug, Clone)]
pub(super) struct StockCoverage {
    pub gaps: Vec<(i64, i64)>,
    pub end_minute_exclusive: u32,
}

#[derive(Debug)]
pub(super) struct DayIndex {
    pub buckets: u64,
    pub stocks: HashMap<String, StockCoverage>,
}

#[derive(Clone)]
pub(super) enum DayIndexState {
    Missing,
    UnsupportedVersion,
    Ready(Arc<DayIndex>),
}

struct CachedDayIndex {
    stamp: FileStamp,
    state: DayIndexState,
}

pub(super) struct DayIndexCache {
    entries: Mutex<HashMap<String, CachedDayIndex>>,
}

#[derive(Deserialize)]
struct RawComplete {
    format_version: u32,
    #[serde(default)]
    verify: RawVerify,
    #[serde(default)]
    raw_files: HashMap<String, u64>,
    #[serde(default)]
    stocks: Vec<RawStock>,
}

#[derive(Deserialize, Default)]
struct RawVerify {
    buckets: Option<u64>,
}

#[derive(Deserialize)]
struct RawStock {
    code: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    registered: bool,
    #[serde(default)]
    received: bool,
    #[serde(default)]
    gaps: Vec<RawGap>,
    #[serde(default)]
    handoff: Option<RawHandoff>,
}

#[derive(Deserialize)]
struct RawGap {
    from_ms: i64,
    to_ms: i64,
}

#[derive(Deserialize)]
struct RawHandoff {
    to: String,
}

pub(super) fn read_stamp(data_dir: &Path, date: &str) -> Result<Option<FileStamp>, String> {
    let path = data_dir.join("store").join(date).join("complete.json");
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(Some(FileStamp { len: meta.len(), modified: meta.modified().ok() })),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}를 확인할 수 없습니다: {e}", path.display())),
    }
}

impl DayIndexCache {
    pub(super) fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }

    pub(super) fn load(&self, data_dir: &Path, date: &str) -> Result<(Option<FileStamp>, DayIndexState), String> {
        let Some(stamp) = read_stamp(data_dir, date)? else {
            self.entries.lock().expect("day index cache").remove(date);
            return Ok((None, DayIndexState::Missing));
        };
        if let Some(cached) = self.entries.lock().expect("day index cache").get(date)
            && cached.stamp == stamp
        {
            return Ok((Some(stamp), cached.state.clone()));
        }
        let path = data_dir.join("store").join(date).join("complete.json");
        let bytes = std::fs::read(&path).map_err(|e| format!("{}를 읽을 수 없습니다: {e}", path.display()))?;
        let raw: RawComplete = serde_json::from_slice(&bytes).map_err(|e| format!("{}를 해석할 수 없습니다: {e}", path.display()))?;
        let state = if raw.format_version != SUPPORTED_FORMAT_VERSION {
            tracing::warn!(date = %date, format_version = raw.format_version, "지원하지 않는 complete.json 형식 버전이라 그날을 쓰지 않습니다");
            DayIndexState::UnsupportedVersion
        } else {
            DayIndexState::Ready(Arc::new(build_index(raw)))
        };
        self.entries.lock().expect("day index cache").insert(date.to_owned(), CachedDayIndex { stamp: stamp.clone(), state: state.clone() });
        Ok((Some(stamp), state))
    }

    pub(super) fn collected_days(&self, data_dir: &Path, stock_code: &str) -> Result<Vec<String>, String> {
        let store_dir = data_dir.join("store");
        let entries = match std::fs::read_dir(&store_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("{}를 읽을 수 없습니다: {e}", store_dir.display())),
        };
        let mut dates: Vec<String> = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("{} 항목을 읽을 수 없습니다: {e}", store_dir.display()))?;
            let Ok(name) = entry.file_name().into_string() else { continue };
            if KstDate::parse_yyyymmdd(&name).is_none() {
                continue;
            }
            if entry.file_type().is_ok_and(|ft| ft.is_dir()) {
                dates.push(name);
            }
        }
        dates.sort_unstable_by(|a, b| b.cmp(a));
        dates.truncate(MAX_DAY_FOLDERS);
        dates.reverse();
        let mut collected = Vec::new();
        for date in dates {
            match self.load(data_dir, &date) {
                Ok((_, DayIndexState::Ready(index))) if index.stocks.contains_key(stock_code) => collected.push(date),
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(date = %date, reason = %e, "complete.json을 읽지 못해 날짜 목록에서 건너뜁니다");
                }
            }
        }
        Ok(collected)
    }
}

fn build_index(raw: RawComplete) -> DayIndex {
    let key_end_minutes = latest_end_minutes(&raw.raw_files);
    let mut stocks = HashMap::new();
    for stock in raw.stocks {
        if !(stock.registered && stock.received) {
            continue;
        }
        let owner_key = stock.handoff.map(|h| h.to).or(stock.key);
        let end_minute_exclusive = key_end_minutes.get(&owner_key).copied().unwrap_or(DEFAULT_END_MINUTE_EXCLUSIVE);
        let gaps = stock.gaps.into_iter().map(|g| (g.from_ms, g.to_ms)).collect();
        stocks.insert(stock.code, StockCoverage { gaps, end_minute_exclusive });
    }
    let buckets = raw.verify.buckets.filter(|&b| b > 0).unwrap_or(DEFAULT_BUCKETS);
    DayIndex { buckets, stocks }
}

fn latest_end_minutes(raw_files: &HashMap<String, u64>) -> HashMap<Option<String>, u32> {
    let mut latest: HashMap<Option<String>, u32> = HashMap::new();
    for rel_path in raw_files.keys() {
        let (owner_key, file_name) = match rel_path.split_once('/') {
            Some((key, file)) => (Some(key.to_owned()), file),
            None => (None, rel_path.as_str()),
        };
        let Some(end_minute) = parse_five_minute_end(file_name) else { continue };
        latest.entry(owner_key).and_modify(|current| *current = (*current).max(end_minute)).or_insert(end_minute);
    }
    latest
}

fn parse_five_minute_end(file_name: &str) -> Option<u32> {
    let bytes = file_name.as_bytes();
    if bytes.len() < 4 || !bytes[..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let hour = u32::from(bytes[0] - b'0') * 10 + u32::from(bytes[1] - b'0');
    let minute = u32::from(bytes[2] - b'0') * 10 + u32::from(bytes[3] - b'0');
    if hour >= 24 || minute >= 60 {
        return None;
    }
    Some((hour * 60 + minute + 5).min(1440))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_format_version_is_skipped_and_handoff_uses_target_key_end() {
        let tmp = tempfile::tempdir().unwrap();
        let bad_dir = tmp.path().join("store").join("20261122");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("complete.json"), r#"{"format_version":2,"stocks":[]}"#).unwrap();
        let good_dir = tmp.path().join("store").join("20261123");
        std::fs::create_dir_all(&good_dir).unwrap();
        std::fs::write(
            good_dir.join("complete.json"),
            r#"{"format_version":1,"raw_files":{"k1/1000-000.jsonl.zst":10,"k2/1530-000.jsonl.zst":10},"stocks":[{"code":"005930","key":"k1","registered":true,"received":true,"gaps":[],"handoff":{"at":"10:05:00","from":"k1","to":"k2"}}]}"#,
        )
        .unwrap();
        let cache = DayIndexCache::new();
        assert!(matches!(cache.load(tmp.path(), "20261122").unwrap().1, DayIndexState::UnsupportedVersion));
        let (_, DayIndexState::Ready(index)) = cache.load(tmp.path(), "20261123").unwrap() else {
            panic!("expected ready index");
        };
        assert_eq!(index.stocks["005930"].end_minute_exclusive, 15 * 60 + 35);
    }

    #[test]
    fn broken_complete_json_is_skipped_in_collected_days() {
        let tmp = tempfile::tempdir().unwrap();
        let broken_dir = tmp.path().join("store").join("20261122");
        std::fs::create_dir_all(&broken_dir).unwrap();
        std::fs::write(broken_dir.join("complete.json"), "{broken").unwrap();
        let good_dir = tmp.path().join("store").join("20261123");
        std::fs::create_dir_all(&good_dir).unwrap();
        std::fs::write(
            good_dir.join("complete.json"),
            r#"{"format_version":1,"stocks":[{"code":"005930","key":"k1","registered":true,"received":true,"gaps":[],"handoff":null}]}"#,
        )
        .unwrap();
        let cache = DayIndexCache::new();
        assert_eq!(cache.collected_days(tmp.path(), "005930").unwrap(), vec!["20261123"]);
    }
}
