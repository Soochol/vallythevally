use std::fs;
use std::path::Path;

use serde::Deserialize;

use super::wire::{CoverageDay, CoverageState, DayBytes, DiskUsage, Filesystem};
use crate::finalize::{COMPLETE_FORMAT_VERSION, REPLACED_SUFFIX, VERIFY_FILE_NAME, store_dir, temporary_store_dir};
use crate::raw_write::raw_day_dir;

pub const LISTED_DAYS: usize = 60;
const COMPLETE_FILE: &str = "complete.json";

#[derive(Deserialize)]
struct CompleteFile {
    format_version: u32,
    verify: VerifyPart,
    plan: Option<PlanPart>,
    stocks: Vec<StockPart>,
}

#[derive(Deserialize)]
struct VerifyPart {
    passed: bool,
}

#[derive(Deserialize)]
struct VerifyFile {
    passed: bool,
}

#[derive(Deserialize)]
struct PlanPart {
    planned_stocks: u64,
}

#[derive(Deserialize)]
struct StockPart {
    received: bool,
}

impl CompleteFile {
    fn into_day(self, date: u32) -> CoverageDay {
        CoverageDay {
            date,
            state: CoverageState::Complete,
            verified: Some(self.verify.passed),
            planned_stocks: self.plan.map(|plan| plan.planned_stocks),
            received_stocks: Some(self.stocks.iter().filter(|stock| stock.received).count() as u64),
        }
    }
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

fn day_in(date: u32, state: CoverageState) -> CoverageDay {
    CoverageDay { date, state, verified: None, planned_stocks: None, received_stocks: None }
}

fn only_temporary_state(data_dir: &Path, date: u32) -> CoverageState {
    let verify = fs::read(temporary_store_dir(data_dir, date).join(VERIFY_FILE_NAME)).ok().and_then(|bytes| serde_json::from_slice::<VerifyFile>(&bytes).ok());
    match verify {
        Some(VerifyFile { passed: false }) => CoverageState::VerifyFailed,
        _ => CoverageState::InProgress,
    }
}

fn coverage_of(data_dir: &Path, date: u32) -> CoverageDay {
    let folder = store_dir(data_dir, date);
    if !folder.is_dir() {
        return day_in(date, only_temporary_state(data_dir, date));
    }
    let complete = folder.join(COMPLETE_FILE);
    if fs::symlink_metadata(&complete).is_ok_and(|metadata| !metadata.is_file()) {
        return day_in(date, CoverageState::Unreadable);
    }
    match fs::read(&complete) {
        Ok(bytes) => match serde_json::from_slice::<CompleteFile>(&bytes) {
            Ok(file) if file.format_version == COMPLETE_FORMAT_VERSION => file.into_day(date),
            _ => day_in(date, CoverageState::Unreadable),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => day_in(date, CoverageState::Incomplete),
        Err(_) => day_in(date, CoverageState::Unreadable),
    }
}

fn swap_leftover_exists(data_dir: &Path, date: u32) -> bool {
    let prefix = format!("{date}{REPLACED_SUFFIX}");
    let Ok(entries) = fs::read_dir(data_dir.join("store")) else { return false };
    entries.flatten().any(|entry| entry.file_name().to_str().is_some_and(|name| name.starts_with(&prefix)))
}

fn observe_day(data_dir: &Path, date: u32) -> (CoverageDay, bool) {
    let day = coverage_of(data_dir, date);
    if day.state == CoverageState::Complete {
        return (day, true);
    }
    let sealed_meanwhile = matches!(day.state, CoverageState::Incomplete | CoverageState::InProgress | CoverageState::VerifyFailed)
        && store_dir(data_dir, date).join(COMPLETE_FILE).is_file();
    if sealed_meanwhile {
        return (coverage_of(data_dir, date), false);
    }
    if swap_leftover_exists(data_dir, date) {
        return (day_in(date, CoverageState::InProgress), false);
    }
    (day, true)
}

pub struct Coverage {
    pub days: Vec<CoverageDay>,
    pub settled: bool,
}

pub fn read_coverage(data_dir: &Path) -> Coverage {
    let store = data_dir.join("store");
    let observed: Vec<(CoverageDay, bool)> = dates_in(&store, ".tmp").into_iter().map(|date| observe_day(data_dir, date)).collect();
    let settled = observed.iter().all(|(_, settled)| *settled);
    Coverage { days: observed.into_iter().map(|(day, _)| day).collect(), settled }
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
        write(&store.join("20261116/complete.json"), r#"{"format_version":1,"date":20261116,"verify":{"passed":true,"mismatch_count":0},"plan":{"planned_stocks":2600,"excluded":2},"stocks":[{"code":"000010","received":true,"messages":9},{"code":"000020","received":false,"messages":0},{"code":"000030","received":true,"messages":3}]}"#);
        write(&store.join("20261117/complete.json"), "not json");
        write(&store.join("20261114/0B/000.parquet"), "x");
        write(&store.join("20261118.tmp/0B/000.parquet"), "x");
        write(&store.join("notes.txt"), "x");
        let coverage = read_coverage(folder.path());
        assert!(coverage.settled);
        let days = coverage.days;
        let seen: Vec<(u32, CoverageState)> = days.iter().map(|day| (day.date, day.state)).collect();
        assert_eq!(
            seen,
            [(20261118, CoverageState::InProgress), (20261117, CoverageState::Unreadable), (20261116, CoverageState::Complete), (20261114, CoverageState::Incomplete)]
        );
        assert_eq!(days[2].verified, Some(true));
        assert_eq!(days[2].planned_stocks, Some(2600));
        assert_eq!(days[2].received_stocks, Some(2));
        assert_eq!(days[3].verified, None);
    }

    #[test]
    fn a_failed_verification_is_not_a_day_in_progress_and_a_swap_in_flight_is_not_settled() {
        let folder = tempfile::tempdir().unwrap();
        let store = folder.path().join("store");
        write(&store.join("20261118.tmp/verify.json"), r#"{"passed":false,"mismatch_count":2}"#);
        write(&store.join("20261117.tmp/verify.json"), r#"{"passed":true}"#);
        let coverage = read_coverage(folder.path());
        assert!(coverage.settled);
        let seen: Vec<(u32, CoverageState)> = coverage.days.iter().map(|day| (day.date, day.state)).collect();
        assert_eq!(seen, [(20261118, CoverageState::VerifyFailed), (20261117, CoverageState::InProgress)]);

        write(&store.join("20261116/0B/000.parquet"), "x");
        write(&store.join(format!("20261116{REPLACED_SUFFIX}1/0B/000.parquet")), "x");
        let swapping = read_coverage(folder.path());
        assert!(!swapping.settled);
        assert_eq!(swapping.days.iter().find(|day| day.date == 20261116).unwrap().state, CoverageState::InProgress);
    }

    #[test]
    fn a_complete_json_of_another_format_version_is_unreadable() {
        let folder = tempfile::tempdir().unwrap();
        let store = folder.path().join("store");
        let body = |version: &str| format!(r#"{{{version}"verify":{{"passed":true}},"plan":null,"stocks":[]}}"#);
        write(&store.join("20261117/complete.json"), &body(r#""format_version":2,"#));
        write(&store.join("20261116/complete.json"), &body(""));
        write(&store.join("20261115/complete.json"), &body(r#""format_version":1,"#));
        let states: Vec<CoverageState> = read_coverage(folder.path()).days.iter().map(|day| day.state).collect();
        assert_eq!(states, [CoverageState::Unreadable, CoverageState::Unreadable, CoverageState::Complete]);
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
        assert!(read_coverage(folder.path()).days.is_empty());
        let disk = read_disk(&folder.path().join("missing"));
        assert!(disk.raw.is_empty() && disk.store.is_empty() && disk.filesystem.is_none());
    }
}
