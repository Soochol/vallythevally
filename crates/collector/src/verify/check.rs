use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use hoga_format::{Span, StreamKind};

use super::result::{Problem, Problems};
use crate::build::day::{is_path_safe_symbol, Difference, FlatRows, ROW_KINDS, RawDay, SPAN_MS, SymbolRows, carries_forward, row_slot, span_of_ms};
use crate::build::gaps::gaps_in_span;
use crate::build::index::{Index, RowCounts, SpanEntry};
use crate::build::store::{latest_revisions, parse_hhmm, parse_span_file_name, symbol_dir, unpack};
use crate::kst::SPAN_MINUTES;

pub fn check_index_header(index: &Index, day: &RawDay, problems: &mut Problems) {
    if index.version != hoga_format::VERSION {
        problems.add(Problem::message(format!("index.json의 형식 버전이 {}이다. {}이어야 한다", index.version, hoga_format::VERSION)));
    }
    if index.date != day.date {
        problems.add(Problem::message(format!("index.json의 날짜가 {}이다", index.date)));
    }
    if index.span_minutes != SPAN_MINUTES {
        problems.add(Problem::message(format!("index.json의 구간 길이가 {}분이다", index.span_minutes)));
    }
    if index.read_errors != day.errors {
        problems.add(Problem::message("index.json의 read_errors가 원문을 다시 읽은 결과와 다르다"));
    }
    if index.members != day.members {
        problems.add(Problem::message("index.json의 members가 원문의 거래원 이름과 다르다"));
    }
}

pub fn check_symbol(data_dir: &Path, day: &RawDay, index: &Index, symbol: &str, problems: &mut Problems) {
    if !is_path_safe_symbol(symbol) {
        problems.add(Problem::for_symbol(symbol, "종목이 폴더 이름으로 쓸 수 없는 글자를 담고 있다"));
        return;
    }
    if !day.symbols.contains_key(symbol) {
        problems.add(Problem::for_symbol(symbol, "index.json에 있지만 원문에 행이 없는 종목이다"));
    }
    let empty = SymbolRows::new();
    let expected_rows = day.symbols.get(symbol).unwrap_or(&empty);
    let mut entries: Vec<&SpanEntry> = index.symbols.get(symbol).map_or_else(Vec::new, |s| s.spans.iter().collect());
    entries.sort_by(|left, right| left.start.cmp(&right.start));

    let mut actual: Vec<FlatRows> = ROW_KINDS.iter().map(|kind| FlatRows::new(kind.columns().len())).collect();
    let mut listed_spans = BTreeSet::new();
    let folder = symbol_dir(data_dir, day.date, symbol);
    let revisions = latest_revisions(&folder).unwrap_or_default();
    for entry in entries {
        let Some(start_minute) = parse_hhmm(&entry.start) else {
            problems.add(Problem::for_symbol(symbol, format!("구간 시작 {:?}이 HHMM이 아니다", entry.start)));
            continue;
        };
        if !listed_spans.insert(start_minute) {
            problems.add(Problem::for_symbol(symbol, format!("{} 구간이 index.json에 두 번 있다", entry.start)));
            continue;
        }
        let context = SpanContext { day, symbol, entry, start_minute };
        match read_entry_span(&folder, &revisions, &context) {
            Ok((span, byte_len)) => {
                check_against_index(&context, &span, byte_len, problems);
                check_span(&context, &span, &mut actual, problems);
            }
            Err(message) => problems.add(context.problem(message)),
        }
    }
    for (slot, kind) in ROW_KINDS.iter().enumerate() {
        compare_stream(symbol, *kind, expected_rows.stream(*kind), &actual[slot], problems);
    }
    check_span_range(symbol, expected_rows, &listed_spans, problems);
}

fn check_span_range(symbol: &str, expected_rows: &SymbolRows, listed_spans: &BTreeSet<u16>, problems: &mut Problems) {
    let with_rows = spans_with_rows(expected_rows);
    let as_start = |span_index: u32| (span_index * u32::from(SPAN_MINUTES)) as u16;
    let range = with_rows.first().zip(with_rows.last()).map(|(first, last)| as_start(*first)..=as_start(*last));
    if let Some(range) = &range {
        let mut start_minute = *range.start();
        while start_minute <= *range.end() {
            if !listed_spans.contains(&start_minute) {
                problems.add(Problem::for_symbol(
                    symbol,
                    format!("첫 행의 구간부터 마지막 행의 구간 사이의 {} 구간 파일이 index.json에 없다", crate::build::store::hhmm(start_minute)),
                ));
            }
            start_minute += SPAN_MINUTES;
        }
    }
    for start_minute in listed_spans {
        if !range.as_ref().is_some_and(|range| range.contains(start_minute)) {
            problems.add(Problem::for_symbol(
                symbol,
                format!("{} 구간은 원문 행의 구간 범위 밖인데 index.json에 있다", crate::build::store::hhmm(*start_minute)),
            ));
        }
    }
}

struct SpanContext<'a> {
    day: &'a RawDay,
    symbol: &'a str,
    entry: &'a SpanEntry,
    start_minute: u16,
}

impl SpanContext<'_> {
    fn span_start_ms(&self) -> i64 {
        i64::from(self.start_minute) * 60_000
    }

    fn problem(&self, message: impl Into<String>) -> Problem {
        Problem::for_symbol(self.symbol, format!("{} 구간: {}", self.entry.start, message.into()))
    }
}

fn read_entry_span(
    folder: &Path,
    revisions: &BTreeMap<u16, u32>,
    context: &SpanContext<'_>,
) -> Result<(Span, u64), String> {
    let entry = context.entry;
    match parse_span_file_name(&entry.file) {
        Some((start_minute, revision)) if start_minute == context.start_minute => {
            if revisions.get(&start_minute) != Some(&revision) {
                return Err(format!("{}이 지금 판이 아니다", entry.file));
            }
        }
        _ => return Err(format!("파일 이름 {:?}이 구간과 맞지 않는다", entry.file)),
    }
    let bytes = fs::read(folder.join(&entry.file))
        .map_err(|error| format!("{}을 읽을 수 없다: {error}", entry.file))?;
    let span = unpack(&bytes).map_err(|error| format!("{}: {error}", entry.file))?;
    Ok((span, bytes.len() as u64))
}

fn check_against_index(context: &SpanContext<'_>, span: &Span, byte_len: u64, problems: &mut Problems) {
    if byte_len != context.entry.bytes {
        problems.add(context.problem(format!(
            "index.json의 바이트 수 {}가 파일의 {byte_len}와 다르다",
            context.entry.bytes
        )));
    }
    if RowCounts::of(span) != context.entry.rows {
        problems.add(context.problem("index.json의 행 수가 파일과 다르다"));
    }
}

fn check_span(context: &SpanContext<'_>, span: &Span, actual: &mut [FlatRows], problems: &mut Problems) {
    let header_matches = span.date == context.day.date
        && span.symbol == context.symbol
        && i64::from(span.start_minute) == context.span_start_ms() / 60_000
        && span.length_minutes == SPAN_MINUTES;
    if !header_matches {
        problems.add(context.problem("파일 머리의 날짜·종목·구간이 놓인 경로와 다르다"));
    }
    let start_ms = context.span_start_ms();
    let end_ms = start_ms + i64::from(SPAN_MS);
    for kind in ROW_KINDS {
        let slot = row_slot(kind);
        let needs_carry = carries_forward(kind) && !actual[slot].is_empty();
        let Some(stream) = span.stream(kind) else {
            if needs_carry {
                problems.add(missing_carry(context, kind));
            }
            continue;
        };
        let recv_ms = &stream.columns[0];
        let mut first_own = 0;
        if carries_forward(kind) && stream.rows() > 0 && recv_ms[0] < start_ms {
            let carried: Vec<i64> = stream.columns.iter().map(|column| column[0]).collect();
            if actual[slot].last_row() != Some(carried.as_slice()) {
                problems.add(Problem::for_stream(
                    context.symbol,
                    kind.name(),
                    format!("{} 구간의 이월 행이 이어 붙인 열의 바로 앞 행과 다르다", context.entry.start),
                ));
            }
            first_own = 1;
        } else if needs_carry {
            problems.add(missing_carry(context, kind));
        }
        let mut reported_out_of_span = false;
        for row in first_own..stream.rows() {
            let values: Vec<i64> = stream.columns.iter().map(|column| column[row]).collect();
            if !(start_ms..end_ms).contains(&values[0]) && !reported_out_of_span {
                reported_out_of_span = true;
                problems.add(Problem {
                    row: Some(row),
                    ..Problem::for_stream(
                        context.symbol,
                        kind.name(),
                        format!("{} 구간 파일에 구간 밖의 recv_ms {}가 있다", context.entry.start, values[0]),
                    )
                });
            }
            actual[slot].push(&values);
        }
    }
    check_gaps(context, span, problems);
}

fn missing_carry(context: &SpanContext<'_>, kind: StreamKind) -> Problem {
    Problem::for_stream(context.symbol, kind.name(), format!("{} 구간 파일에 이월 행이 없다", context.entry.start))
}

fn check_gaps(context: &SpanContext<'_>, span: &Span, problems: &mut Problems) {
    let start_ms = context.span_start_ms() as u32;
    let expected = gaps_in_span(&context.day.gaps, start_ms, start_ms + SPAN_MS);
    let found: Vec<(i64, i64)> = span.stream(StreamKind::Gaps).map_or_else(Vec::new, |stream| {
        stream.columns[0].iter().copied().zip(stream.columns[1].iter().copied()).collect()
    });
    let wanted: Vec<(i64, i64)> = expected.iter().map(|gap| (i64::from(gap.from_ms), i64::from(gap.to_ms))).collect();
    if found != wanted {
        problems.add(Problem::for_stream(
            context.symbol,
            StreamKind::Gaps.name(),
            format!("{} 구간의 gaps가 원문 사건 줄에서 구한 {wanted:?}와 다르다: {found:?}", context.entry.start),
        ));
    }
}

fn compare_stream(symbol: &str, kind: StreamKind, expected: &FlatRows, actual: &FlatRows, problems: &mut Problems) {
    match expected.first_difference(actual) {
        None => {}
        Some(Difference::Cell { row, column, expected, actual }) => problems.add(Problem {
            row: Some(row),
            column: Some(kind.columns()[column].name.clone()),
            expected: Some(expected),
            actual: Some(actual),
            ..Problem::for_stream(symbol, kind.name(), "값이 다르다")
        }),
        Some(Difference::Length { expected, actual }) => problems.add(Problem {
            row: Some(expected.min(actual)),
            ..Problem::for_stream(symbol, kind.name(), format!("행 수가 다르다: 원문 {expected}, 구간 파일 {actual}"))
        }),
    }
}

fn spans_with_rows(rows: &SymbolRows) -> BTreeSet<u32> {
    let mut spans = BTreeSet::new();
    for kind in ROW_KINDS {
        let stream = rows.stream(kind);
        spans.extend((0..stream.len()).map(|row| span_of_ms(stream.row(row)[0])));
    }
    spans
}
