use std::fs;
use std::path::Path;

use serde::Deserialize;

use super::wire::{CoverageDay, CoverageState, DayBytes, DiskUsage, Filesystem};
use crate::finalize::{store_dir, temporary_store_dir};
use crate::raw_write::raw_day_dir;

pub const LISTED_DAYS: usize = 60;
const COMPLETE_FILE: &str = "complete.json";

#[derive(Deserialize, Default)]
struct CompleteSummary {
    verified: Option<bool>,
    planned_stocks: Option<u64>,
    received_stocks: Option<u64>,
}

fn dates_in(folder: &Path, trim_suffix: &str) -> Vec<u32> {
    let Ok(entries) = fs::read_dir(folder) else { return Vec::new() };
    let mut dates: Vec<u32> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let digits = name.strip_suffix(trim_suffix).unwrap_or(&name);
            if digits.len() == 8 && digits.bytes().all(|byte| byte.is_ascii_digit()) { digits.parse().ok() } else { None }
        })
        .collect();
    dates.sort_unstable_by(|first, second| second.cmp(first));
    dates.dedup();
    dates.truncate(LISTED_DAYS);
    dates
}

fn coverage_of(data_dir: &Path, date: u32) -> CoverageDay {
    let day = |state, summary: CompleteSummary| CoverageDay {
        date,
        state,
        verified: summary.verified,
        planned_stocks: summary.planned_stocks,
        received_stocks: summary.received_stocks,
    };
    let folder = store_dir(data_dir, date);
    if !folder.is_dir() {
        return day(CoverageState::InProgress, CompleteSummary::default());
    }
    match fs::read(folder.join(COMPLETE_FILE)) {
        Ok(bytes) => match serde_json::from_slice::<CompleteSummary>(&bytes) {
            Ok(summary) => day(CoverageState::Complete, summary),
            Err(_) => day(CoverageState::Unreadable, CompleteSummary::default()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => day(CoverageState::Incomplete, CompleteSummary::default()),
        Err(_) => day(CoverageState::Unreadable, CompleteSummary::default()),
    }
}

pub fn read_coverage(data_dir: &Path) -> Vec<CoverageDay> {
    let store = data_dir.join("store");
    dates_in(&store, ".tmp").into_iter().map(|date| coverage_of(data_dir, date)).collect()
}

fn folder_bytes(folder: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(folder) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => folder_bytes(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map_or(0, |metadata| metadata.len()),
            _ => 0,
        })
        .sum()
}

fn filesystem_of(data_dir: &Path) -> Option<Filesystem> {
    let stat = rustix::fs::statvfs(data_dir).ok()?;
    Some(Filesystem { free_bytes: stat.f_bavail.saturating_mul(stat.f_frsize), total_bytes: stat.f_blocks.saturating_mul(stat.f_frsize) })
}

pub fn read_disk(data_dir: &Path) -> DiskUsage {
    let raw = dates_in(&data_dir.join("raw"), "").into_iter().map(|date| DayBytes { date, bytes: folder_bytes(&raw_day_dir(data_dir, date)) }).collect();
    let store = dates_in(&data_dir.join("store"), ".tmp")
        .into_iter()
        .map(|date| DayBytes { date, bytes: folder_bytes(&store_dir(data_dir, date)) + folder_bytes(&temporary_store_dir(data_dir, date)) })
        .collect();
    DiskUsage { filesystem: filesystem_of(data_dir), raw, store }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn coverage_lists_days_newest_first_with_their_state() {
        let folder = tempfile::tempdir().unwrap();
        let store = folder.path().join("store");
        write(&store.join("20261116/complete.json"), r#"{"verified":true,"planned_stocks":2600,"received_stocks":2590,"extra":1}"#);
        write(&store.join("20261117/complete.json"), "not json");
        write(&store.join("20261114/0B/000.parquet"), "x");
        write(&store.join("20261118.tmp/0B/000.parquet"), "x");
        write(&store.join("notes.txt"), "x");
        let days = read_coverage(folder.path());
        let seen: Vec<(u32, CoverageState)> = days.iter().map(|day| (day.date, day.state)).collect();
        assert_eq!(
            seen,
            [(20261118, CoverageState::InProgress), (20261117, CoverageState::Unreadable), (20261116, CoverageState::Complete), (20261114, CoverageState::Incomplete)]
        );
        assert_eq!(days[2].verified, Some(true));
        assert_eq!(days[2].received_stocks, Some(2590));
        assert_eq!(days[3].verified, None);
    }

    #[test]
    fn disk_sums_raw_and_store_bytes_per_day_and_reports_the_filesystem() {
        let folder = tempfile::tempdir().unwrap();
        write(&folder.path().join("raw/20261117/collect-01/a.zst"), "12345");
        write(&folder.path().join("raw/20261117/collect-02/a.zst"), "123");
        write(&folder.path().join("store/20261117/0B/000.parquet"), "1234567");
        write(&folder.path().join("store/20261118.tmp/0B/000.parquet"), "12");
        let disk = read_disk(folder.path());
        assert_eq!(disk.raw, [DayBytes { date: 20261117, bytes: 8 }]);
        assert_eq!(disk.store, [DayBytes { date: 20261118, bytes: 2 }, DayBytes { date: 20261117, bytes: 7 }]);
        let filesystem = disk.filesystem.unwrap();
        assert!(filesystem.total_bytes >= filesystem.free_bytes && filesystem.total_bytes > 0);
    }

    #[test]
    fn an_empty_data_folder_lists_nothing() {
        let folder = tempfile::tempdir().unwrap();
        assert!(read_coverage(folder.path()).is_empty());
        let disk = read_disk(&folder.path().join("missing"));
        assert!(disk.raw.is_empty() && disk.store.is_empty() && disk.filesystem.is_none());
    }
}
