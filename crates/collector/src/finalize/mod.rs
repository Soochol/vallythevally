use std::fs;
use std::io;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use futures::future::BoxFuture;
use server::config::Secret;

use crate::args::{ArgSpec, Arguments};
use crate::build::day::parse_date;
use crate::calendar::{Calendar, Day, HolidayRequest, HolidayTransport, TransportError};
use crate::raw_read::read_day;

mod check;
mod chunk;
mod complete;
mod coverage;
mod merge;
mod prune;
mod scan;
pub mod schema;

pub use complete::{COMPLETE_FILE_NAME, COMPLETE_FORMAT_VERSION, CompleteFile, publish_store, recover_interrupted_swap};
pub use coverage::{CoverageInput, Gap, Handoff, JournalFact, KeyTimeline, KeyTimelines, StockCoverage, build_coverage};
pub use prune::{
    CompleteState, DayFacts, KeepReason, PRUNE_LOG_NAME, PruneReport, PrunePlan, RetentionSettings, UnfinalizedCount, delete_raw_day,
    first_complete_day, plan_prune, prune_raw, read_day_facts,
};
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

const SPEC: ArgSpec = ArgSpec {
    value_options: &["date", "threads", "buckets", "keep-early", "keep", "early-period"],
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
    let (options, prune) = match parse_command(raw_arguments) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("finalize: {message}");
            return ExitCode::from(2);
        }
    };
    match finalize_day(&options) {
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
            match prune {
                Some(settings) if !options.verify_only => prune_after_finalize(&options, &settings),
                _ => ExitCode::SUCCESS,
            }
        }
        Err(error) => {
            eprintln!("finalize: {}를 정리할 수 없다: {error}", options.date);
            ExitCode::FAILURE
        }
    }
}

struct CachedHolidaysOnly;

impl HolidayTransport for CachedHolidaysOnly {
    fn fetch<'a>(&'a self, _request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
        Box::pin(async { Err(TransportError::Unreachable) })
    }
}

fn prune_after_finalize(options: &Options, settings: &RetentionSettings) -> ExitCode {
    let outcome = tokio::runtime::Builder::new_current_thread().build().and_then(|runtime| {
        let today = Day::from_yyyymmdd(options.date).ok_or_else(|| io::Error::other("날짜가 아니다"))?;
        let calendar = runtime.block_on(Calendar::load(
            &options.data_dir,
            &CachedHolidaysOnly,
            &Secret::new(String::new()),
            today.unix_ms_at_kst(20, 0),
        ));
        prune_raw(&options.data_dir, options.date, &calendar, settings)
    });
    match outcome {
        Ok(report) => {
            println!("finalize: 원문 지우기 {}일 지움, {}일 남김, {}일 실패", report.deleted.len(), report.kept.len(), report.failed.len());
            if report.failed.is_empty() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
        }
        Err(error) => {
            eprintln!("finalize: 원문을 지울 수 없다: {error}");
            ExitCode::FAILURE
        }
    }
}

fn parse_command(raw_arguments: &[String]) -> Result<(Options, Option<RetentionSettings>), String> {
    let arguments = Arguments::parse(raw_arguments, &SPEC).map_err(|error| error.to_string())?;
    let date = arguments.value("date").ok_or("--date YYYYMMDD가 필요합니다")?;
    let options = Options {
        data_dir: arguments.data_dir(),
        date: parse_date(date)?,
        threads: bounded(&arguments, "threads", DEFAULT_THREADS, MAX_THREADS)?,
        buckets: bounded(&arguments, "buckets", DEFAULT_BUCKETS, MAX_BUCKETS)?,
        verify_only: arguments.flag("verify-only"),
        spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES,
    };
    Ok((options, parse_retention(&arguments)?))
}

fn parse_retention(arguments: &Arguments) -> Result<Option<RetentionSettings>, String> {
    let given = ["keep-early", "keep", "early-period"].iter().any(|name| arguments.value(name).is_some());
    if !arguments.flag("prune") {
        return if given { Err("--keep-early, --keep, --early-period는 --prune과 함께 쓴다".to_owned()) } else { Ok(None) };
    }
    let defaults = RetentionSettings::default();
    let number = |name: &str, default: u32| -> Result<u32, String> {
        let Some(text) = arguments.value(name) else { return Ok(default) };
        text.parse::<u32>().map_err(|_| format!("--{name}은 0 이상의 정수여야 합니다: {text:?}"))
    };
    let positive = |name: &str, default: NonZeroU32| -> Result<NonZeroU32, String> {
        NonZeroU32::new(number(name, default.get())?).ok_or_else(|| format!("--{name}은 1 이상이어야 합니다"))
    };
    Ok(Some(RetentionSettings {
        early_keep: positive("keep-early", defaults.early_keep)?,
        steady_keep: positive("keep", defaults.steady_keep)?,
        early_period: number("early-period", defaults.early_period)?,
    }))
}

fn bounded(arguments: &Arguments, name: &str, default: usize, max: usize) -> Result<usize, String> {
    let Some(text) = arguments.value(name) else { return Ok(default) };
    text.parse::<usize>()
        .ok()
        .filter(|value| (1..=max).contains(value))
        .ok_or_else(|| format!("--{name}은 1 이상 {max} 이하의 정수여야 합니다: {text:?}"))
}

pub fn finalize_day(options: &Options) -> io::Result<VerifyReport> {
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
    let written = write_store(options)?;
    let report = verify_store(&written.store_dir, options.date, options.buckets, options.threads, &written.tally)?;
    seal_day(options, &report)?;
    Ok(report)
}

pub fn seal_day(options: &Options, report: &VerifyReport) -> io::Result<bool> {
    if !report.passed {
        return Ok(false);
    }
    let temporary = temporary_store_dir(&options.data_dir, options.date);
    complete::write_complete(&temporary, &complete::build_complete(&options.data_dir, options.date, report)?)?;
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
