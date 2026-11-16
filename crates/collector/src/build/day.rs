use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use hoga_format::StreamKind;
use serde::{Deserialize, Serialize};

use super::gaps::{GapInterval, GapTracker, LineEvent};
use crate::kst::{KstTime, SPAN_MINUTES};
use crate::parse::{Item, parse_frame};
use crate::raw_read::{RawContent, RawItem, read_day};

pub const ROW_KINDS: [StreamKind; 4] = [
    StreamKind::Book,
    StreamKind::Trades,
    StreamKind::Program,
    StreamKind::Broker,
];
pub const SPAN_MS: u32 = SPAN_MINUTES as u32 * 60_000;
const MAX_ERROR_SAMPLES: usize = 10;
const MAX_SYMBOL_BYTES: usize = 255;
const MAX_UNIX_MS: i64 = 253_402_300_799_000;

pub fn row_slot(kind: StreamKind) -> usize {
    ROW_KINDS.iter().position(|candidate| *candidate == kind).expect("행 흐름이 아니다")
}

pub fn carries_forward(kind: StreamKind) -> bool {
    kind != StreamKind::Trades
}

pub fn span_of_ms(ms_of_day: i64) -> u32 {
    (ms_of_day / i64::from(SPAN_MS)) as u32
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlatRows {
    width: usize,
    values: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Difference {
    Cell { row: usize, column: usize, expected: i64, actual: i64 },
    Length { expected: usize, actual: usize },
}

impl FlatRows {
    pub fn new(width: usize) -> FlatRows {
        FlatRows { width, values: Vec::new() }
    }

    pub fn push(&mut self, row: &[i64]) {
        debug_assert_eq!(row.len(), self.width);
        self.values.extend_from_slice(row);
    }

    pub fn len(&self) -> usize {
        self.values.len() / self.width
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn row(&self, index: usize) -> &[i64] {
        &self.values[index * self.width..(index + 1) * self.width]
    }

    pub fn last_row(&self) -> Option<&[i64]> {
        self.len().checked_sub(1).map(|index| self.row(index))
    }

    pub fn first_difference(&self, other: &FlatRows) -> Option<Difference> {
        let shared = self.len().min(other.len());
        for row in 0..shared {
            let (expected, actual) = (self.row(row), other.row(row));
            if let Some(column) = (0..self.width).find(|&column| expected[column] != actual[column]) {
                return Some(Difference::Cell { row, column, expected: expected[column], actual: actual[column] });
            }
        }
        (self.len() != other.len()).then_some(Difference::Length { expected: self.len(), actual: other.len() })
    }
}

#[derive(Debug, Clone)]
pub struct SymbolRows {
    streams: Vec<FlatRows>,
}

impl SymbolRows {
    pub fn new() -> SymbolRows {
        SymbolRows {
            streams: ROW_KINDS.iter().map(|kind| FlatRows::new(kind.columns().len())).collect(),
        }
    }

    pub fn stream(&self, kind: StreamKind) -> &FlatRows {
        &self.streams[row_slot(kind)]
    }

    fn push(&mut self, kind: StreamKind, row: &[i64]) {
        self.streams[row_slot(kind)].push(row);
    }
}

impl Default for SymbolRows {
    fn default() -> SymbolRows {
        SymbolRows::new()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawRows {
    pub book: usize,
    pub trades: usize,
    pub program: usize,
    pub broker: usize,
}

impl RawRows {
    pub fn of(rows: &SymbolRows) -> RawRows {
        RawRows {
            book: rows.stream(StreamKind::Book).len(),
            trades: rows.stream(StreamKind::Trades).len(),
            program: rows.stream(StreamKind::Program).len(),
            broker: rows.stream(StreamKind::Broker).len(),
        }
    }
}

impl std::fmt::Display for RawRows {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "book {}, trades {}, program {}, broker {}",
            self.book, self.trades, self.program, self.broker
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadErrors {
    pub items: usize,
    pub frames: usize,
    pub lines: usize,
    pub unreadable_files: usize,
    pub truncated_files: usize,
}

impl ReadErrors {
    pub fn total(&self) -> usize {
        self.items + self.frames + self.lines + self.unreadable_files + self.truncated_files
    }

    pub fn dropped_data(&self) -> usize {
        self.total() - self.truncated_files
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Skipped {
    pub not_trade: usize,
    pub unsupported: usize,
    pub text_lines: usize,
}

#[derive(Debug)]
pub struct RawDay {
    pub date: u32,
    pub symbols: BTreeMap<String, SymbolRows>,
    pub gaps: Vec<GapInterval>,
    pub members: BTreeMap<String, String>,
    pub skipped: Skipped,
    pub errors: ReadErrors,
    pub truncated_files: Vec<PathBuf>,
    pub error_samples: Vec<String>,
}

impl RawDay {
    pub fn read(data_dir: &Path, date: u32) -> io::Result<RawDay> {
        let mut day = RawDay {
            date,
            symbols: BTreeMap::new(),
            gaps: Vec::new(),
            members: BTreeMap::new(),
            skipped: Skipped::default(),
            errors: ReadErrors::default(),
            truncated_files: Vec::new(),
            error_samples: Vec::new(),
        };
        let mut tracker = GapTracker::default();
        for item in read_day(data_dir, date)? {
            match item {
                RawItem::Record(record) => day.take_record(&mut tracker, record.recv_ms, record.content),
                RawItem::BadLine { file, line_number, message } => {
                    day.errors.lines += 1;
                    day.sample(format!("{}:{line_number}: {message}", file.display()));
                }
                RawItem::Truncated { file } => {
                    day.errors.truncated_files += 1;
                    day.truncated_files.push(file);
                }
                RawItem::Unreadable { file, message } => {
                    day.errors.unreadable_files += 1;
                    day.sample(format!("{}: {message}", file.display()));
                }
            }
        }
        day.gaps = tracker.finish();
        Ok(day)
    }

    pub fn row_count(&self, symbol: &str, kind: StreamKind) -> usize {
        self.symbols.get(symbol).map_or(0, |rows| rows.stream(kind).len())
    }

    fn take_record(&mut self, tracker: &mut GapTracker, recv_ms: i64, content: RawContent) {
        if !(0..=MAX_UNIX_MS).contains(&recv_ms) {
            self.errors.lines += 1;
            self.sample(format!("recv_ms {recv_ms}은 시각으로 읽을 수 없다"));
            return;
        }
        let time = KstTime::from_unix_ms(recv_ms);
        if time.date != self.date {
            self.errors.lines += 1;
            self.sample(format!("recv_ms {recv_ms}은 {}일의 줄이 아니다", self.date));
            return;
        }
        let line_ms = time.ms_of_day;
        match content {
            RawContent::Frame(text) => {
                let event = if self.take_frame(line_ms, &text) { LineEvent::Real } else { LineEvent::Other };
                tracker.record(line_ms, event);
            }
            RawContent::Text(_) => {
                self.skipped.text_lines += 1;
                tracker.record(line_ms, LineEvent::Other);
            }
            RawContent::Live => tracker.record(line_ms, LineEvent::Live),
            RawContent::Down { .. } => tracker.record(line_ms, LineEvent::Down),
        }
    }

    fn take_frame(&mut self, line_ms: u32, text: &str) -> bool {
        let entries = match parse_frame(text) {
            Ok(entries) => entries,
            Err(error) => {
                self.errors.frames += 1;
                self.sample(error.to_string());
                return false;
            }
        };
        let carries_real_items = !entries.is_empty();
        for entry in entries {
            match entry {
                Ok(Item::Row(row)) => {
                    if !is_path_safe_symbol(&row.symbol) {
                        self.errors.items += 1;
                        self.sample(format!("종목 {:?}은 파일 이름으로 쓸 수 없다", row.symbol));
                        continue;
                    }
                    let symbol_rows = self.symbols.entry(row.symbol.clone()).or_default();
                    let newest = symbol_rows.stream(row.kind).last_row().map(|last| span_of_ms(last[0]));
                    if newest.is_some_and(|newest| newest > span_of_ms(i64::from(line_ms))) {
                        self.errors.items += 1;
                        self.sample(format!("종목 {} 행이 앞 행보다 이른 구간으로 거꾸로 왔다", row.symbol));
                        continue;
                    }
                    let mut full_row = Vec::with_capacity(row.values.len() + 1);
                    full_row.push(i64::from(line_ms));
                    full_row.extend_from_slice(&row.values);
                    self.symbols.get_mut(&row.symbol).expect("방금 넣었다").push(row.kind, &full_row);
                    for member in row.members {
                        self.members.insert(member.code, member.name);
                    }
                }
                Ok(Item::NotTrade { .. }) => self.skipped.not_trade += 1,
                Ok(Item::Unsupported { .. }) => self.skipped.unsupported += 1,
                Err(error) => {
                    self.errors.items += 1;
                    self.sample(error.to_string());
                }
            }
        }
        carries_real_items
    }

    fn sample(&mut self, message: String) {
        if self.error_samples.len() < MAX_ERROR_SAMPLES {
            self.error_samples.push(message);
        }
    }
}

pub fn is_path_safe_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= MAX_SYMBOL_BYTES
        && symbol.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub fn parse_date(text: &str) -> Result<u32, String> {
    let invalid = || format!("날짜는 YYYYMMDD여야 합니다: {text:?}");
    if text.len() != 8 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let date: u32 = text.parse().map_err(|_| invalid())?;
    let (month, day) = (date / 100 % 100, date % 100);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(invalid());
    }
    Ok(date)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dates() {
        assert_eq!(parse_date("20260720"), Ok(20260720));
        for bad in ["2026072", "202607200", "2026-07-2", "20261301", "20260700", "abcdefgh", ""] {
            assert!(parse_date(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn symbols_must_be_path_safe() {
        assert!(is_path_safe_symbol("005930_NX"));
        assert!(!is_path_safe_symbol("../x"));
        assert!(!is_path_safe_symbol(""));
        assert!(!is_path_safe_symbol("삼성"));
    }

    #[test]
    fn first_difference_names_the_cell_or_the_length() {
        let mut left = FlatRows::new(2);
        let mut right = FlatRows::new(2);
        left.push(&[1, 2]);
        left.push(&[3, 4]);
        right.push(&[1, 2]);
        assert_eq!(left.first_difference(&right), Some(Difference::Length { expected: 2, actual: 1 }));
        right.push(&[3, 9]);
        assert_eq!(
            left.first_difference(&right),
            Some(Difference::Cell { row: 1, column: 1, expected: 4, actual: 9 })
        );
    }
}
