use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::args::{ArgSpec, Arguments};
use crate::kst::KstTime;

pub mod cut;
pub mod day;
pub mod follow;
pub mod gaps;
pub mod index;
pub mod publish;
pub mod report;
pub mod store;

use day::{RawDay, SPAN_MS, parse_date};
use index::{INDEX_FILE_NAME, Index};
use report::BuildReport;
use store::spans_day_dir;

const SPAN_GRACE_MS: i64 = 10_000;

const SPEC: ArgSpec = ArgSpec {
    value_options: &["date"],
    flag_options: &["follow"],
};

pub fn now_unix_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("build: {error}");
            return ExitCode::from(2);
        }
    };
    let data_dir = arguments.data_dir();
    if arguments.flag("follow") {
        if arguments.value("date").is_some() {
            eprintln!("build: --follow는 오늘 날짜만 만든다. --date와 함께 쓸 수 없다");
            return ExitCode::from(2);
        }
        return match follow::run_follow(data_dir) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("build: {error}");
                ExitCode::FAILURE
            }
        };
    }
    let now = now_unix_ms();
    let date = match arguments.value("date").map(parse_date) {
        Some(Ok(date)) => date,
        Some(Err(message)) => {
            eprintln!("build: {message}");
            return ExitCode::from(2);
        }
        None => KstTime::from_unix_ms(now).date,
    };
    match build_day(&data_dir, date, now) {
        Ok(report) => {
            print!("{report}");
            if report.failed() { ExitCode::FAILURE } else { ExitCode::SUCCESS }
        }
        Err(error) => {
            eprintln!("build: {date}를 만들 수 없다: {error}");
            ExitCode::FAILURE
        }
    }
}

pub fn last_finished_span(date: u32, now_unix_ms: i64) -> Option<u32> {
    let now = KstTime::from_unix_ms(now_unix_ms);
    match date.cmp(&now.date) {
        std::cmp::Ordering::Less => Some(u32::MAX),
        std::cmp::Ordering::Greater => None,
        std::cmp::Ordering::Equal => {
            let settled_ms = i64::from(now.ms_of_day) - SPAN_GRACE_MS;
            let settled_spans = settled_ms.div_euclid(i64::from(SPAN_MS));
            u32::try_from(settled_spans - 1).ok()
        }
    }
}

pub fn build_day(data_dir: &Path, date: u32, now_unix_ms: i64) -> std::io::Result<BuildReport> {
    let day = RawDay::read(data_dir, date)?;
    let limit = last_finished_span(date, now_unix_ms);
    let mut report = BuildReport::new(&day, limit.is_some());
    let mut index = Index::new(date, day.errors.clone(), day.members.clone());
    if let Some(limit) = limit {
        for (symbol, rows) in &day.symbols {
            let cuts = cut::cut_symbol(date, symbol, rows, &day.gaps, limit);
            let entries = publish::publish_symbol(data_dir, date, symbol, &cuts, &mut report);
            if !entries.is_empty() {
                index.symbols.insert(symbol.clone(), index::SymbolIndex { spans: entries });
            }
        }
    }
    let index_path = spans_day_dir(data_dir, date).join(INDEX_FILE_NAME);
    match index.write_if_changed(&index_path) {
        Ok(written) => report.index_written = written,
        Err(error) => report.write_errors.push(format!("{}: {error}", index_path.display())),
    }
    Ok(report)
}
