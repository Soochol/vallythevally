use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::num::NonZeroU32;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use super::complete::COMPLETE_FILE_NAME;
use super::raw_files::RawFiles;
use super::{VERIFY_FILE_NAME, store_dir};
use crate::args::Arguments;
use crate::calendar::{Calendar, Day};
use crate::raw_write::raw_day_dir;

pub const PRUNE_LOG_NAME: &str = "prune.log.jsonl";
const RAW_FOLDER: &str = "raw";
const STORE_FOLDER: &str = "store";
const DATE_FOLDER_LEN: usize = 8;
const CHANGED_EXAMPLES: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionSettings {
    pub early_keep: NonZeroU32,
    pub steady_keep: NonZeroU32,
    pub early_period: u32,
}

impl Default for RetentionSettings {
    fn default() -> RetentionSettings {
        RetentionSettings {
            early_keep: NonZeroU32::new(7).expect("0이 아니다"),
            steady_keep: NonZeroU32::new(1).expect("0이 아니다"),
            early_period: 10,
        }
    }
}

impl RetentionSettings {
    pub fn from_arguments(arguments: &Arguments) -> Result<RetentionSettings, String> {
        let defaults = RetentionSettings::default();
        let number = |name: &str, default: u32| -> Result<u32, String> {
            let Some(text) = arguments.value(name) else { return Ok(default) };
            text.parse::<u32>().map_err(|_| format!("--{name}은 0 이상의 정수여야 합니다: {text:?}"))
        };
        let positive = |name: &str, default: NonZeroU32| -> Result<NonZeroU32, String> {
            NonZeroU32::new(number(name, default.get())?).ok_or_else(|| format!("--{name}은 1 이상이어야 합니다"))
        };
        Ok(RetentionSettings {
            early_keep: positive("keep-early", defaults.early_keep)?,
            steady_keep: positive("keep", defaults.steady_keep)?,
            early_period: number("early-period", defaults.early_period)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompleteState {
    Missing,
    Unreadable,
    Verified,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawState {
    Unchecked,
    Same,
    NotRecorded,
    Changed { files: u64, examples: Vec<String> },
    HasUnreadFiles { files: u64, examples: Vec<String> },
    Unreadable { detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnfinalizedCount {
    Unknown,
    Counted { total: u64, kinds: BTreeMap<String, u64> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayFacts {
    pub date: u32,
    pub complete: CompleteState,
    pub unfinalized: UnfinalizedCount,
    pub raw: RawState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum KeepReason {
    NoComplete,
    CompleteUnreadable,
    VerificationFailed,
    UnfinalizedCountMissing,
    Unfinalized { total: u64, kinds: BTreeMap<String, u64> },
    RawFingerprintMissing,
    RawChangedAfterComplete { files: u64, examples: Vec<String> },
    RawHasUnreadFiles { files: u64, examples: Vec<String> },
    RawUnreadable { detail: String },
    WithinRetention { keep_observation_days: u32 },
    ObservationUnknown { detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrunePlan {
    pub delete: Vec<u32>,
    pub keep: Vec<(u32, KeepReason)>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PruneReport {
    pub deleted: Vec<(u32, u64)>,
    pub kept: Vec<(u32, KeepReason)>,
    pub failed: Vec<(u32, String)>,
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Outcome<'a> {
    Deleted { bytes: u64 },
    Kept(&'a KeepReason),
    Failed { message: &'a str },
}

#[derive(Serialize)]
struct LogLine<'a> {
    run_date: u32,
    date: u32,
    #[serde(flatten)]
    outcome: Outcome<'a>,
}

#[derive(Deserialize)]
struct CompleteMarker {
    verify: CompleteVerify,
    raw_files: Option<RawFiles>,
}

#[derive(Deserialize)]
struct CompleteVerify {
    passed: bool,
}

#[derive(Deserialize)]
struct VerifyLines {
    passed: Option<bool>,
    lines: Option<LinesField>,
}

#[derive(Deserialize)]
struct LinesField {
    unfinalized: Option<UnfinalizedField>,
}

#[derive(Deserialize)]
struct UnfinalizedField {
    total: Option<u64>,
    kinds: Option<BTreeMap<String, u64>>,
}

pub fn plan_prune(today: u32, first_complete: Option<u32>, days: &[DayFacts], calendar: &Calendar, settings: &RetentionSettings) -> PrunePlan {
    let keep_days = retention_keep(today, first_complete, calendar, settings);
    let mut plan = PrunePlan { delete: Vec::new(), keep: Vec::new() };
    for facts in days {
        match decide(today, facts, &keep_days, calendar) {
            Ok(()) => plan.delete.push(facts.date),
            Err(reason) => plan.keep.push((facts.date, reason)),
        }
    }
    plan
}

fn retention_keep(today: u32, first_complete: Option<u32>, calendar: &Calendar, settings: &RetentionSettings) -> Result<NonZeroU32, KeepReason> {
    let unknown = |detail: String| KeepReason::ObservationUnknown { detail };
    let first = first_complete.ok_or_else(|| unknown("정리 완료한 날이 없다".to_owned()))?;
    let first_day = Day::from_yyyymmdd(first).ok_or_else(|| unknown(format!("{first}는 날짜가 아니다")))?;
    let steady_start = calendar
        .observation_days_after(first_day, settings.early_period)
        .map_err(|judgment| unknown(format!("{} 관측일 판단이 모름이다", judgment.day)))?;
    Ok(if today >= steady_start.yyyymmdd() { settings.steady_keep } else { settings.early_keep })
}

fn decide(today: u32, facts: &DayFacts, keep_days: &Result<NonZeroU32, KeepReason>, calendar: &Calendar) -> Result<(), KeepReason> {
    match facts.complete {
        CompleteState::Missing => return Err(KeepReason::NoComplete),
        CompleteState::Unreadable => return Err(KeepReason::CompleteUnreadable),
        CompleteState::Failed => return Err(KeepReason::VerificationFailed),
        CompleteState::Verified => {}
    }
    match &facts.unfinalized {
        UnfinalizedCount::Unknown => return Err(KeepReason::UnfinalizedCountMissing),
        UnfinalizedCount::Counted { total, kinds } if *total > 0 => {
            return Err(KeepReason::Unfinalized { total: *total, kinds: kinds.iter().filter(|(_, count)| **count > 0).map(|(kind, count)| (kind.clone(), *count)).collect() });
        }
        UnfinalizedCount::Counted { .. } => {}
    }
    match &facts.raw {
        RawState::Unchecked | RawState::Same => {}
        RawState::NotRecorded => return Err(KeepReason::RawFingerprintMissing),
        RawState::Changed { files, examples } => return Err(KeepReason::RawChangedAfterComplete { files: *files, examples: examples.clone() }),
        RawState::HasUnreadFiles { files, examples } => return Err(KeepReason::RawHasUnreadFiles { files: *files, examples: examples.clone() }),
        RawState::Unreadable { detail } => return Err(KeepReason::RawUnreadable { detail: detail.clone() }),
    }
    let keep = keep_days.clone()?;
    let unknown = |detail: String| KeepReason::ObservationUnknown { detail };
    let day = Day::from_yyyymmdd(facts.date).ok_or_else(|| unknown(format!("{}는 날짜가 아니다", facts.date)))?;
    let deletable_from = calendar
        .observation_days_after(day, keep.get())
        .map_err(|judgment| unknown(format!("{} 관측일 판단이 모름이다", judgment.day)))?;
    if deletable_from.yyyymmdd() <= today { Ok(()) } else { Err(KeepReason::WithinRetention { keep_observation_days: keep.get() }) }
}

fn date_folders(folder: &Path) -> io::Result<Vec<u32>> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut dates = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| name.len() == DATE_FOLDER_LEN && name.bytes().all(|byte| byte.is_ascii_digit())) else { continue };
        if entry.file_type()?.is_dir() {
            dates.extend(name.parse::<u32>());
        }
    }
    dates.sort_unstable();
    Ok(dates)
}

pub fn first_complete_day(data_dir: &Path) -> io::Result<Option<u32>> {
    let stored = date_folders(&data_dir.join(STORE_FOLDER))?;
    Ok(stored.into_iter().find(|date| store_dir(data_dir, *date).join(COMPLETE_FILE_NAME).is_file()))
}

pub fn raw_days_without_complete(data_dir: &Path, before: u32) -> io::Result<Vec<u32>> {
    let raw_days = date_folders(&data_dir.join(RAW_FOLDER))?;
    Ok(raw_days.into_iter().filter(|date| *date < before && !store_dir(data_dir, *date).join(COMPLETE_FILE_NAME).is_file()).collect())
}

fn raw_state(data_dir: &Path, date: u32, recorded: Option<RawFiles>) -> RawState {
    let Some(recorded) = recorded else { return RawState::NotRecorded };
    let examples = |paths: Vec<String>| (paths.len() as u64, paths.into_iter().take(CHANGED_EXAMPLES).collect());
    let now = match RawFiles::of_day(data_dir, date) {
        Ok(now) => now,
        Err(error) => return RawState::Unreadable { detail: error.to_string() },
    };
    let differing = recorded.paths_differing_from(&now);
    if !differing.is_empty() {
        let (files, examples) = examples(differing);
        return RawState::Changed { files, examples };
    }
    match RawFiles::unread_of_day(data_dir, date) {
        Err(error) => RawState::Unreadable { detail: error.to_string() },
        Ok(unread) if unread.is_empty() => RawState::Same,
        Ok(unread) => {
            let (files, examples) = examples(unread);
            RawState::HasUnreadFiles { files, examples }
        }
    }
}

pub fn read_day_facts(data_dir: &Path, date: u32) -> DayFacts {
    let folder = store_dir(data_dir, date);
    let (complete, recorded_raw) = match fs::read(folder.join(COMPLETE_FILE_NAME)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => (CompleteState::Missing, None),
        Err(_) => (CompleteState::Unreadable, None),
        Ok(bytes) => match serde_json::from_slice::<CompleteMarker>(&bytes) {
            Ok(marker) if marker.verify.passed => (CompleteState::Verified, marker.raw_files),
            Ok(_) => (CompleteState::Failed, None),
            Err(_) => (CompleteState::Unreadable, None),
        },
    };
    let verify = fs::read(folder.join(VERIFY_FILE_NAME)).ok().and_then(|bytes| serde_json::from_slice::<VerifyLines>(&bytes).ok());
    let complete = match (complete, verify.as_ref().and_then(|verify| verify.passed)) {
        (CompleteState::Verified, Some(false)) => CompleteState::Failed,
        (complete, _) => complete,
    };
    let raw = if complete == CompleteState::Verified { raw_state(data_dir, date, recorded_raw) } else { RawState::Unchecked };
    DayFacts { date, complete, unfinalized: unfinalized_of(verify), raw }
}

fn unfinalized_of(verify: Option<VerifyLines>) -> UnfinalizedCount {
    let counted = verify
        .and_then(|verify| verify.lines)
        .and_then(|lines| lines.unfinalized)
        .and_then(|unfinalized| Some((unfinalized.total?, unfinalized.kinds?)));
    match counted {
        Some((total, kinds)) => UnfinalizedCount::Counted { total, kinds },
        None => UnfinalizedCount::Unknown,
    }
}

fn directory_bytes(path: &Path) -> io::Result<u64> {
    let mut bytes = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        bytes += if metadata.is_dir() { directory_bytes(&entry.path())? } else { metadata.len() };
    }
    Ok(bytes)
}

pub fn delete_raw_day(data_dir: &Path, target: &Path) -> io::Result<u64> {
    match remove_raw_day(data_dir, target, || None::<std::convert::Infallible>)? {
        Ok(bytes) => Ok(bytes),
        Err(never) => match never {},
    }
}

fn remove_raw_day<Kept>(data_dir: &Path, target: &Path, last_check: impl FnOnce() -> Option<Kept>) -> io::Result<Result<u64, Kept>> {
    let refuse = |why: &str| io::Error::new(io::ErrorKind::InvalidInput, format!("{}는 raw/ 아래 날짜 폴더가 아니다: {why}", target.display()));
    if target.components().any(|component| component == Component::ParentDir) {
        return Err(refuse("상위 폴더 경로가 든다"));
    }
    let name = target.file_name().and_then(|name| name.to_str()).ok_or_else(|| refuse("이름이 없다"))?;
    if name.len() != DATE_FOLDER_LEN || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(refuse("날짜 이름이 아니다"));
    }
    let raw_root = fs::canonicalize(data_dir.join(RAW_FOLDER))?;
    let parent = fs::canonicalize(target.parent().ok_or_else(|| refuse("부모가 없다"))?)?;
    if parent != raw_root {
        return Err(refuse("raw/ 바로 아래가 아니다"));
    }
    if !fs::symlink_metadata(target)?.file_type().is_dir() {
        return Err(refuse("폴더가 아니다"));
    }
    let bytes = directory_bytes(target)?;
    if let Some(reason) = last_check() {
        return Ok(Err(reason));
    }
    fs::remove_dir_all(target)?;
    Ok(Ok(bytes))
}

fn append_log(data_dir: &Path, today: u32, report: &PruneReport) -> io::Result<()> {
    if report.deleted.is_empty() && report.kept.is_empty() && report.failed.is_empty() {
        return Ok(());
    }
    let mut text = String::new();
    let mut push = |date: u32, outcome: Outcome<'_>| {
        text.push_str(&serde_json::to_string(&LogLine { run_date: today, date, outcome }).expect("지우기 기록은 항상 JSON이 된다"));
        text.push('\n');
    };
    for (date, bytes) in &report.deleted {
        push(*date, Outcome::Deleted { bytes: *bytes });
    }
    for (date, reason) in &report.kept {
        push(*date, Outcome::Kept(reason));
    }
    for (date, message) in &report.failed {
        push(*date, Outcome::Failed { message });
    }
    let folder = data_dir.join(STORE_FOLDER);
    fs::create_dir_all(&folder)?;
    OpenOptions::new().create(true).append(true).open(folder.join(PRUNE_LOG_NAME))?.write_all(text.as_bytes())
}

pub fn prune_raw(data_dir: &Path, today: u32, calendar: &Calendar, settings: &RetentionSettings) -> io::Result<PruneReport> {
    let days: Vec<DayFacts> = date_folders(&data_dir.join(RAW_FOLDER))?.into_iter().map(|date| read_day_facts(data_dir, date)).collect();
    let plan = plan_prune(today, first_complete_day(data_dir)?, &days, calendar, settings);
    let mut report = PruneReport { kept: plan.keep, ..PruneReport::default() };
    for date in plan.delete {
        match delete_planned_day(data_dir, today, date, calendar, settings) {
            Ok(Ok(bytes)) => report.deleted.push((date, bytes)),
            Ok(Err(reason)) => report.kept.push((date, reason)),
            Err(error) => report.failed.push((date, error.to_string())),
        }
    }
    append_log(data_dir, today, &report)?;
    Ok(report)
}

pub fn delete_planned_day(data_dir: &Path, today: u32, date: u32, calendar: &Calendar, settings: &RetentionSettings) -> io::Result<Result<u64, KeepReason>> {
    let first_complete = first_complete_day(data_dir)?;
    let still_deletable = || {
        let now = [read_day_facts(data_dir, date)];
        plan_prune(today, first_complete, &now, calendar, settings).keep.into_iter().next().map(|(_, reason)| reason)
    };
    remove_raw_day(data_dir, &raw_day_dir(data_dir, date), still_deletable)
}
