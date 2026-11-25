use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use server::config::Secret;

use crate::args::{ArgSpec, Arguments};
use crate::build::day::parse_date;
use crate::calendar::{CachedHolidaysOnly, Calendar, Day};
use crate::raw_read::read_day;

mod check;
mod chunk;
mod complete;
mod coverage;
pub mod daily_micro;
mod merge;
mod observation;
mod prune;
mod quotes;
mod raw_files;
mod scan;
pub mod schema;

pub use complete::{COMPLETE_FILE_NAME, COMPLETE_FORMAT_VERSION, CompleteFile, REPLACED_SUFFIX, publish_store, recover_interrupted_swap};
pub use coverage::{CoverageInput, Gap, Handoff, JournalFact, KeyTimeline, KeyTimelines, StockCoverage, build_coverage};
pub use daily_micro::{DailyMicroReport, DailyMicroRow, write_daily_micro};
pub use observation::{IndexCheckResult, IndexCheckSummary, JudgedVerdict, JudgmentSummary, MarketOpenSummary, ObservationSummary, TreatedAs};
pub use prune::{
    CompleteState, DayFacts, KeepReason, PRUNE_LOG_NAME, PruneReport, PrunePlan, RetentionSettings, UnfinalizedCount, delete_planned_day, delete_raw_day,
    RawState, first_complete_day, plan_prune, prune_raw, raw_days_without_complete, read_day_facts,
};
pub use quotes::{QuotesReport, fill_closed_days, fill_missing_closed_days, missing_closed_quote_days, write_closed_day};
pub use raw_files::RawFiles;
pub use check::{Mismatch, StatJson, VERIFY_FILE_NAME, VerifyReport, bucket_count_of, verify_store};
pub use merge::{ROW_GROUP_ROWS, WrittenFile, bucket_file};
pub use scan::{RowStat, Tally, Unfinalized};
pub use schema::{FORMAT_VERSION, bucket_of};

pub const DEFAULT_THREADS: usize = 4;
pub const DEFAULT_BUCKETS: usize = 64;
pub const DEFAULT_SPILL_BUDGET_BYTES: usize = 128 << 20;
const MAX_THREADS: usize = 64;
const MAX_BUCKETS: usize = 999;
const STORE_FOLDER: &str = "store";
const TEMPORARY_SUFFIX: &str = ".tmp";
const SPILL_FOLDER: &str = ".spill";
const QUOTES_EXIT_CODE: u8 = 3;

const SPEC: ArgSpec = ArgSpec {
    value_options: &["date", "threads", "buckets", "keep-early", "keep", "early-period", "shared"],
    flag_options: &["verify-only", "prune"],
};

#[derive(Debug, Clone)]
pub struct Options {
    pub data_dir: PathBuf,
    pub date: u32,
    pub threads: usize,
    pub buckets: usize,
    pub verify_only: bool,
    pub spill_budget_bytes: usize,
}

pub struct Written {
    pub store_dir: PathBuf,
    pub tally: Tally,
    pub files: Vec<WrittenFile>,
}

pub fn store_dir(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join(STORE_FOLDER).join(date.to_string())
}

pub fn temporary_store_dir(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join(STORE_FOLDER).join(format!("{date}{TEMPORARY_SUFFIX}"))
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let (options, prune, shared_dir) = match parse_command(raw_arguments) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("finalize: {message}");
            return ExitCode::from(2);
        }
    };
    match finalize_day_with_shared(&options, &shared_dir) {
        Ok(report) => {
            println!(
                "finalize: {} 정리 {}줄, 제어 {}줄, 정리 못 함 {}줄, 원문 대조 {}",
                options.date,
                report.lines.finalized,
                report.lines.control,
                report.lines.unfinalized.total,
                if report.passed { "통과" } else { "실패" }
            );
            if !report.passed {
                eprintln!(
                    "finalize: 원문과 Parquet이 {}곳에서 다르다. {}를 본다",
                    report.mismatch_count,
                    temporary_store_dir(&options.data_dir, options.date).join(VERIFY_FILE_NAME).display()
                );
                return ExitCode::FAILURE;
            }
            if options.verify_only {
                return ExitCode::SUCCESS;
            }
            let prune_failed = match prune {
                Some(settings) => !prune_after_finalize(&options, &settings),
                None => false,
            };
            let quotes_failed = !quotes_after_finalize(&options, &shared_dir);
            if prune_failed {
                ExitCode::FAILURE
            } else if quotes_failed {
                ExitCode::from(QUOTES_EXIT_CODE)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(error) => {
            eprintln!("finalize: {}를 정리할 수 없다: {error}", options.date);
            ExitCode::FAILURE
        }
    }
}

pub fn prune_with_cached_calendar(data_dir: &Path, date: u32, settings: &RetentionSettings) -> io::Result<PruneReport> {
    let runtime = tokio::runtime::Builder::new_current_thread().build()?;
    let today = Day::from_yyyymmdd(date).ok_or_else(|| io::Error::other("날짜가 아니다"))?;
    let first_day = first_complete_day(data_dir)?.and_then(Day::from_yyyymmdd).unwrap_or(today);
    let calendar = runtime.block_on(Calendar::load_from_year(
        data_dir,
        &CachedHolidaysOnly,
        &Secret::new(String::new()),
        today.unix_ms_at_kst(20, 0),
        first_day.year(),
    ));
    prune_raw(data_dir, date, &calendar, settings)
}

fn prune_after_finalize(options: &Options, settings: &RetentionSettings) -> bool {
    match prune_with_cached_calendar(&options.data_dir, options.date, settings) {
        Ok(report) => {
            println!("finalize: 원문 지우기 {}일 지움, {}일 남김, {}일 실패", report.deleted.len(), report.kept.len(), report.failed.len());
            report.failed.is_empty()
        }
        Err(error) => {
            eprintln!("finalize: 원문을 지울 수 없다: {error}");
            false
        }
    }
}

fn quotes_after_finalize(options: &Options, shared_dir: &Path) -> bool {
    match fill_closed_days(&options.data_dir, shared_dir, options.date, options.threads) {
        Ok(reports) => {
            let stocks: usize = reports.iter().map(|report| report.stocks).sum();
            let minutes: usize = reports.iter().map(|report| report.minutes).sum();
            println!("finalize: 분 호가 {}일, {}종목, {}분 만듦", reports.len(), stocks, minutes);
            true
        }
        Err(error) => {
            eprintln!("finalize: 분 호가를 만들지 못했다: {error}");
            false
        }
    }
}

fn parse_command(raw_arguments: &[String]) -> Result<(Options, Option<RetentionSettings>, PathBuf), String> {
    let arguments = Arguments::parse(raw_arguments, &SPEC).map_err(|error| error.to_string())?;
    let date = arguments.value("date").ok_or("--date YYYYMMDD가 필요합니다")?;
    let data_dir = arguments.data_dir();
    let shared_dir = arguments.value("shared").map_or_else(|| data_dir.join("shared"), PathBuf::from);
    let options = Options {
        data_dir,
        date: parse_date(date)?,
        threads: bounded(&arguments, "threads", DEFAULT_THREADS, MAX_THREADS)?,
        buckets: bounded(&arguments, "buckets", DEFAULT_BUCKETS, MAX_BUCKETS)?,
        verify_only: arguments.flag("verify-only"),
        spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES,
    };
    Ok((options, parse_retention(&arguments)?, shared_dir))
}

fn parse_retention(arguments: &Arguments) -> Result<Option<RetentionSettings>, String> {
    let given = ["keep-early", "keep", "early-period"].iter().any(|name| arguments.value(name).is_some());
    if !arguments.flag("prune") {
        return if given { Err("--keep-early, --keep, --early-period는 --prune과 함께 쓴다".to_owned()) } else { Ok(None) };
    }
    RetentionSettings::from_arguments(arguments).map(Some)
}

fn bounded(arguments: &Arguments, name: &str, default: usize, max: usize) -> Result<usize, String> {
    let Some(text) = arguments.value(name) else { return Ok(default) };
    text.parse::<usize>()
        .ok()
        .filter(|value| (1..=max).contains(value))
        .ok_or_else(|| format!("--{name}은 1 이상 {max} 이하의 정수여야 합니다: {text:?}"))
}

pub fn finalize_day(options: &Options) -> io::Result<VerifyReport> {
    finalize_day_with_shared(options, &options.data_dir.join("shared"))
}

pub fn finalize_day_with_shared(options: &Options, shared_dir: &Path) -> io::Result<VerifyReport> {
    if options.verify_only {
        let tally = tally_day(options)?;
        let temporary = temporary_store_dir(&options.data_dir, options.date);
        let store_dir = if temporary.is_dir() { temporary } else { self::store_dir(&options.data_dir, options.date) };
        if !store_dir.is_dir() {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("{}가 없다", store_dir.display())));
        }
        let buckets = bucket_count_of(&store_dir)?.unwrap_or(options.buckets);
        return verify_store(&store_dir, options.date, buckets, options.threads, &tally);
    }
    recover_interrupted_swap(&options.data_dir, options.date)?;
    let raw_files = RawFiles::of_day(&options.data_dir, options.date)?;
    let written = write_store(options)?;
    let report = verify_store(&written.store_dir, options.date, options.buckets, options.threads, &written.tally)?;
    if seal_day(options, &report, raw_files)? {
        if let Err(error) = crate::shared::flow::remove_finished_days(shared_dir, &options.data_dir) {
            tracing::warn!(%error, shared_dir = %shared_dir.display(), "지난 종목 흐름 폴더를 지우지 못했습니다");
        }
        if let Err(error) = daily_micro::write_daily_micro(&options.data_dir, shared_dir, options.date, options.threads) {
            tracing::warn!(%error, shared_dir = %shared_dir.display(), date = options.date, "일별 미시구조 요약 파일을 쓰지 못했습니다");
        }
    }
    Ok(report)
}

pub fn seal_day(options: &Options, report: &VerifyReport, raw_files: RawFiles) -> io::Result<bool> {
    if !report.passed {
        return Ok(false);
    }
    let temporary = temporary_store_dir(&options.data_dir, options.date);
    complete::write_complete(&temporary, &complete::build_complete(&options.data_dir, options.date, report, raw_files)?)?;
    publish_store(&options.data_dir, options.date)?;
    Ok(true)
}

pub fn tally_day(options: &Options) -> io::Result<Tally> {
    let reader = read_day(&options.data_dir, options.date)?;
    Ok(scan::scan(reader, None, options.threads, options.buckets, options.spill_budget_bytes)?.tally)
}

pub fn write_store(options: &Options) -> io::Result<Written> {
    let reader = read_day(&options.data_dir, options.date)?;
    let store_dir = temporary_store_dir(&options.data_dir, options.date);
    let removed = if store_dir.is_dir() { fs::remove_dir_all(&store_dir) } else { fs::remove_file(&store_dir) };
    match removed {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let spill_root = store_dir.join(SPILL_FOLDER);
    fs::create_dir_all(&spill_root)?;
    let result = write_buckets(options, reader, &store_dir, &spill_root);
    let _ = fs::remove_dir_all(&spill_root);
    let (tally, files) = result?;
    Ok(Written { store_dir, tally, files })
}

fn write_buckets(
    options: &Options,
    reader: crate::raw_read::RawDayReader,
    store_dir: &Path,
    spill_root: &Path,
) -> io::Result<(Tally, Vec<WrittenFile>)> {
    let spill = scan::SpillLayout::new(spill_root.to_path_buf());
    let scanned = scan::scan(reader, Some(&spill), options.threads, options.buckets, options.spill_budget_bytes)?;
    let tasks: Vec<(usize, usize)> = scanned.spilled.iter().copied().collect();
    let files = merge::merge(store_dir, &spill, options.threads, &tasks, options.buckets, options.threads)?;
    Ok((scanned.tally, files))
}
