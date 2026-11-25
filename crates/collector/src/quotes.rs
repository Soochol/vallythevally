use std::path::PathBuf;
use std::process::ExitCode;

use crate::args::{ArgSpec, Arguments};
use crate::build::day::parse_date;
use crate::finalize::{DEFAULT_THREADS, fill_missing_closed_days, write_closed_day};

const MAX_THREADS: usize = 64;

const BACKFILL_SPEC: ArgSpec = ArgSpec {
    value_options: &["date", "threads", "shared"],
    flag_options: &[],
};

struct BackfillOptions {
    data_dir: PathBuf,
    shared_dir: PathBuf,
    date: Option<u32>,
    threads: usize,
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let Some((subcommand, rest)) = raw_arguments.split_first() else {
        eprintln!("사용법: collector quotes backfill [--data <폴더>] [--shared <폴더>] [--date YYYYMMDD] [--threads <1..64>]");
        return ExitCode::from(2);
    };
    match subcommand.as_str() {
        "backfill" => run_backfill(rest),
        unknown => {
            eprintln!("quotes: 알 수 없는 하위 명령입니다: {unknown}");
            ExitCode::from(2)
        }
    }
}

fn run_backfill(raw_arguments: &[String]) -> ExitCode {
    let options = match parse_backfill(raw_arguments) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("quotes backfill: {message}");
            return ExitCode::from(2);
        }
    };
    let outcome = match options.date {
        Some(date) => write_closed_day(&options.data_dir, &options.shared_dir, date, options.threads).map(|report| vec![report]),
        None => fill_missing_closed_days(&options.data_dir, &options.shared_dir, options.threads),
    };
    match outcome {
        Ok(reports) if reports.is_empty() => {
            println!("quotes backfill: 빠진 날 없음");
            ExitCode::SUCCESS
        }
        Ok(reports) => {
            let stocks: usize = reports.iter().map(|report| report.stocks).sum();
            let minutes: usize = reports.iter().map(|report| report.minutes).sum();
            println!("quotes backfill: {}일, {}종목, {}분 만듦", reports.len(), stocks, minutes);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("quotes backfill: 분 호가를 만들지 못했습니다: {error}");
            ExitCode::FAILURE
        }
    }
}

fn parse_backfill(raw_arguments: &[String]) -> Result<BackfillOptions, String> {
    let arguments = Arguments::parse(raw_arguments, &BACKFILL_SPEC).map_err(|error| error.to_string())?;
    let data_dir = arguments.data_dir();
    let shared_dir = arguments.value("shared").map_or_else(|| data_dir.join("shared"), PathBuf::from);
    let date = arguments.value("date").map(parse_date).transpose()?;
    let threads = match arguments.value("threads") {
        None => DEFAULT_THREADS,
        Some(text) => text
            .parse::<usize>()
            .ok()
            .filter(|value| (1..=MAX_THREADS).contains(value))
            .ok_or_else(|| format!("--threads은 1 이상 {MAX_THREADS} 이하의 정수여야 합니다: {text:?}"))?,
    };
    Ok(BackfillOptions { data_dir, shared_dir, date, threads })
}
