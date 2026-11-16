use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use hoga_format::StreamKind;

use super::day::{RawDay, RawRows, ReadErrors, Skipped};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeFailure {
    pub symbol: String,
    pub start: String,
    pub stream: &'static str,
    pub column: String,
    pub value: i64,
}

#[derive(Debug)]
pub struct BuildReport {
    pub date: u32,
    pub raw_rows: BTreeMap<String, RawRows>,
    pub gap_intervals: usize,
    pub finished_spans: bool,
    pub written_files: usize,
    pub written_bytes: u64,
    pub unchanged_files: usize,
    pub index_written: bool,
    pub max_book_rows_per_span: BTreeMap<String, usize>,
    pub skipped: Skipped,
    pub read_errors: ReadErrors,
    pub truncated_files: Vec<PathBuf>,
    pub error_samples: Vec<String>,
    pub range_failures: Vec<RangeFailure>,
    pub write_errors: Vec<String>,
}

impl BuildReport {
    pub fn new(day: &RawDay, finished_spans: bool) -> BuildReport {
        let raw_rows = day.symbols.iter().map(|(symbol, rows)| (symbol.clone(), RawRows::of(rows))).collect();
        BuildReport {
            date: day.date,
            raw_rows,
            gap_intervals: day.gaps.len(),
            finished_spans,
            written_files: 0,
            written_bytes: 0,
            unchanged_files: 0,
            index_written: false,
            max_book_rows_per_span: BTreeMap::new(),
            skipped: day.skipped.clone(),
            read_errors: day.errors.clone(),
            truncated_files: day.truncated_files.clone(),
            error_samples: day.error_samples.clone(),
            range_failures: Vec::new(),
            write_errors: Vec::new(),
        }
    }

    pub fn note_book_rows(&mut self, symbol: &str, rows: usize) {
        let slot = self.max_book_rows_per_span.entry(symbol.to_string()).or_default();
        *slot = (*slot).max(rows);
    }

    pub fn failed(&self) -> bool {
        self.read_errors.dropped_data() > 0 || !self.range_failures.is_empty() || !self.write_errors.is_empty()
    }
}

impl fmt::Display for BuildReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(formatter, "build {}", self.date)?;
        writeln!(formatter, "원문 행 수 (종목, 흐름):")?;
        for (symbol, counts) in &self.raw_rows {
            writeln!(formatter, "  {symbol}: {counts}")?;
        }
        writeln!(formatter, "  {}: {}", StreamKind::Gaps.name(), self.gap_intervals)?;
        writeln!(
            formatter,
            "새로 쓴 파일 {}개 ({}바이트), 그대로 둔 파일 {}개, index.json {}",
            self.written_files,
            self.written_bytes,
            self.unchanged_files,
            if self.index_written { "새로 씀" } else { "그대로" }
        )?;
        if !self.finished_spans {
            writeln!(formatter, "끝난 구간이 아직 없다")?;
        }
        let busy: Vec<String> = self
            .max_book_rows_per_span
            .iter()
            .filter(|(_, rows)| **rows > 0)
            .map(|(symbol, rows)| format!("{symbol} {rows}"))
            .collect();
        if !busy.is_empty() {
            writeln!(formatter, "구간당 book 행 수 최댓값: {}", busy.join(", "))?;
        }
        writeln!(
            formatter,
            "건너뜀: 체결 아님 {}건, 받지 않는 종류 {}건, JSON이 아닌 줄 {}건",
            self.skipped.not_trade, self.skipped.unsupported, self.skipped.text_lines
        )?;
        for file in &self.truncated_files {
            writeln!(formatter, "잘린 원문 파일: {}", file.display())?;
        }
        let errors = &self.read_errors;
        if errors.dropped_data() > 0 {
            writeln!(
                formatter,
                "읽기 오류: 항목 {}, 프레임 {}, 줄 {}, 읽을 수 없는 파일 {}",
                errors.items, errors.frames, errors.lines, errors.unreadable_files
            )?;
        }
        for sample in &self.error_samples {
            writeln!(formatter, "  {sample}")?;
        }
        for failure in &self.range_failures {
            writeln!(
                formatter,
                "범위 초과: 종목 {} 구간 {} {} 흐름 {} 열의 값 {}이 i32를 넘어 파일을 쓰지 않았다",
                failure.symbol, failure.start, failure.stream, failure.column, failure.value
            )?;
        }
        for error in &self.write_errors {
            writeln!(formatter, "쓰기 오류: {error}")?;
        }
        Ok(())
    }
}
