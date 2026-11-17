use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::args::{ArgSpec, Arguments};
use crate::build::day::parse_date;
use crate::raw_read::read_day;

mod check;
mod chunk;
mod merge;
mod scan;
pub mod schema;

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
    value_options: &["date", "threads", "buckets"],
    flag_options: &["verify-only"],
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
    let options = match parse_options(raw_arguments) {
        Ok(options) => options,
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
            if report.passed {
                ExitCode::SUCCESS
            } else {
                eprintln!(
                    "finalize: 원문과 Parquet이 {}곳에서 다르다. {}를 본다",
                    report.mismatch_count,
                    temporary_store_dir(&options.data_dir, options.date).join(VERIFY_FILE_NAME).display()
                );
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("finalize: {}를 정리할 수 없다: {error}", options.date);
            ExitCode::FAILURE
        }
    }
}

fn parse_options(raw_arguments: &[String]) -> Result<Options, String> {
    let arguments = Arguments::parse(raw_arguments, &SPEC).map_err(|error| error.to_string())?;
    let date = arguments.value("date").ok_or("--date YYYYMMDD가 필요합니다")?;
    Ok(Options {
        data_dir: arguments.data_dir(),
        date: parse_date(date)?,
        threads: bounded(&arguments, "threads", DEFAULT_THREADS, MAX_THREADS)?,
        buckets: bounded(&arguments, "buckets", DEFAULT_BUCKETS, MAX_BUCKETS)?,
        verify_only: arguments.flag("verify-only"),
        spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES,
    })
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
        let store_dir = temporary_store_dir(&options.data_dir, options.date);
        if !store_dir.is_dir() {
            return Err(io::Error::new(io::ErrorKind::NotFound, format!("{}가 없다", store_dir.display())));
        }
        let buckets = bucket_count_of(&store_dir)?.unwrap_or(options.buckets);
        return verify_store(&store_dir, options.date, buckets, options.threads, &tally);
    }
    let written = write_store(options)?;
    verify_store(&written.store_dir, options.date, options.buckets, options.threads, &written.tally)
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
