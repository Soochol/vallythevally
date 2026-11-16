use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::build::day::{RawRows, ReadErrors};

const MAX_LISTED_PROBLEMS: usize = 20;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<i64>,
    pub message: String,
}

impl Problem {
    pub fn message(message: impl Into<String>) -> Problem {
        Problem { message: message.into(), ..Problem::default() }
    }

    pub fn for_symbol(symbol: &str, message: impl Into<String>) -> Problem {
        Problem { symbol: Some(symbol.to_string()), ..Problem::message(message) }
    }

    pub fn for_stream(symbol: &str, stream: &str, message: impl Into<String>) -> Problem {
        Problem { stream: Some(stream.to_string()), ..Problem::for_symbol(symbol, message) }
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(symbol) = &self.symbol {
            write!(formatter, "{symbol} ")?;
        }
        if let Some(stream) = &self.stream {
            write!(formatter, "{stream} ")?;
        }
        if let Some(row) = self.row {
            write!(formatter, "행 {row} ")?;
        }
        if let Some(column) = &self.column {
            write!(formatter, "열 {column} ")?;
        }
        write!(formatter, "{}", self.message)?;
        if let (Some(expected), Some(actual)) = (self.expected, self.actual) {
            write!(formatter, " (원문 {expected}, 구간 파일 {actual})")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyResult {
    pub passed: bool,
    pub date: u32,
    pub verified_at_ms: i64,
    pub rows: BTreeMap<String, RawRows>,
    pub gap_intervals: usize,
    pub read_errors: ReadErrors,
    pub problem_count: usize,
    pub problems: Vec<Problem>,
}

#[derive(Debug, Default)]
pub struct Problems {
    count: usize,
    listed: Vec<Problem>,
}

impl Problems {
    pub fn add(&mut self, problem: Problem) {
        self.count += 1;
        if self.listed.len() < MAX_LISTED_PROBLEMS {
            self.listed.push(problem);
        }
    }

    pub fn count(&self) -> usize {
        self.count
    }

    pub fn into_listed(self) -> (usize, Vec<Problem>) {
        (self.count, self.listed)
    }
}

impl fmt::Display for VerifyResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(formatter, "verify {}: {}", self.date, if self.passed { "통과" } else { "통과하지 못했다" })?;
        for (symbol, counts) in &self.rows {
            writeln!(formatter, "  {symbol}: {counts}")?;
        }
        writeln!(formatter, "  gaps: {}", self.gap_intervals)?;
        if self.read_errors.total() > 0 {
            writeln!(
                formatter,
                "원문 읽기 오류 {}건 (항목 {}, 프레임 {}, 줄 {}, 읽을 수 없는 파일 {}, 잘린 파일 {})",
                self.read_errors.total(),
                self.read_errors.items,
                self.read_errors.frames,
                self.read_errors.lines,
                self.read_errors.unreadable_files,
                self.read_errors.truncated_files
            )?;
        }
        if self.problem_count > 0 {
            writeln!(formatter, "다른 곳 {}개 (처음 {}개):", self.problem_count, self.problems.len())?;
            for problem in &self.problems {
                writeln!(formatter, "  {problem}")?;
            }
        }
        Ok(())
    }
}
