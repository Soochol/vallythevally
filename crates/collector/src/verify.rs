use std::collections::BTreeSet;
use std::path::Path;
use std::process::ExitCode;

use crate::args::{ArgSpec, Arguments};
use crate::build::day::{RawDay, RawRows, parse_date};
use crate::build::index::{INDEX_FILE_NAME, Index};
use crate::build::now_unix_ms;
use crate::build::store::{spans_day_dir, write_atomically};

mod check;
mod result;

pub use result::{Problem, VerifyResult};
use result::Problems;

pub const VERIFIED_FILE_NAME: &str = "verified.json";

const SPEC: ArgSpec = ArgSpec {
    value_options: &["date"],
    flag_options: &[],
};

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("verify: {error}");
            return ExitCode::from(2);
        }
    };
    let date = match arguments.value("date").map(parse_date) {
        Some(Ok(date)) => date,
        Some(Err(message)) => {
            eprintln!("verify: {message}");
            return ExitCode::from(2);
        }
        None => {
            eprintln!("verify: --date YYYYMMDD가 필요합니다");
            return ExitCode::from(2);
        }
    };
    match verify_day(&arguments.data_dir(), date, now_unix_ms()) {
        Ok(result) => {
            print!("{result}");
            if result.passed { ExitCode::SUCCESS } else { ExitCode::FAILURE }
        }
        Err(error) => {
            eprintln!("verify: {date}를 대조할 수 없다: {error}");
            ExitCode::FAILURE
        }
    }
}

pub fn verify_day(data_dir: &Path, date: u32, now_unix_ms: i64) -> std::io::Result<VerifyResult> {
    let day = RawDay::read(data_dir, date)?;
    let mut problems = Problems::default();
    let index_path = spans_day_dir(data_dir, date).join(INDEX_FILE_NAME);
    match Index::read(&index_path) {
        Ok(index) => {
            check::check_index_header(&index, &day, &mut problems);
            let symbols: BTreeSet<&String> = day.symbols.keys().chain(index.symbols.keys()).collect();
            for symbol in symbols {
                check::check_symbol(data_dir, &day, &index, symbol, &mut problems);
            }
        }
        Err(error) => problems.add(Problem::message(format!("{}를 읽을 수 없다: {error}", index_path.display()))),
    }
    let rows = day.symbols.iter().map(|(symbol, rows)| (symbol.clone(), RawRows::of(rows))).collect();
    let passed = problems.count() == 0 && day.errors.total() == 0;
    let (problem_count, listed) = problems.into_listed();
    let result = VerifyResult {
        passed,
        date,
        verified_at_ms: now_unix_ms,
        rows,
        gap_intervals: day.gaps.len(),
        read_errors: day.errors.clone(),
        problem_count,
        problems: listed,
    };
    let mut text = serde_json::to_vec_pretty(&result).expect("대조 결과는 항상 JSON이 된다");
    text.push(b'\n');
    write_atomically(&spans_day_dir(data_dir, date).join(VERIFIED_FILE_NAME), &text)?;
    Ok(result)
}
