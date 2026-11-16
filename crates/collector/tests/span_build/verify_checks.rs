use std::fs;
use std::path::Path;

use collector::build::build_day;
use collector::build::index::Index;
use collector::build::store::{pack, unpack};
use collector::verify::{VerifyResult, verify_day};
use hoga_format::{Span, StreamKind};

use super::support::*;

const MIN_0900: u16 = 9 * 60;

fn built_day() -> tempfile::TempDir {
    let data = tempfile::tempdir().unwrap();
    let book = |time: &str, quantity: &str| book_frame("CHECK", time, "1000", quantity);
    write_raw(
        data.path(),
        &[
            Line::Live(at(9, 0, 0)),
            Line::Frame(at(9, 0, 10), book("090010", "1")),
            Line::Frame(at(9, 1, 10), book("090110", "2")),
            Line::Frame(at(9, 1, 20), trade_frame("CHECK", "090120", "-1000", "+4")),
            Line::Down(at(9, 8, 0)),
            Line::Live(at(9, 9, 0)),
            Line::Frame(at(9, 11, 10), book("091110", "3")),
            Line::Frame(at(9, 11, 20), program_frame("CHECK", "091120", "8")),
        ],
    );
    let report = build_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap();
    assert!(!report.failed(), "{report}");
    assert!(verify(data.path()).passed);
    data
}

fn verify(data: &Path) -> VerifyResult {
    verify_day(data, DATE, AFTER_THE_DAY_UNIX_MS).unwrap()
}

fn replace_span(data: &Path, start_minute: u16, change: impl FnOnce(&mut Span)) {
    let path = span_path(data, "CHECK", start_minute, 1);
    let mut span = unpack(&fs::read(&path).unwrap()).unwrap();
    change(&mut span);
    fs::write(path, pack(&span).unwrap()).unwrap();
}

fn stream_column<'a>(span: &'a mut Span, kind: StreamKind, name: &str) -> &'a mut Vec<i64> {
    let index = kind.column_index(name).unwrap();
    &mut span.streams.iter_mut().find(|stream| stream.kind == kind).unwrap().columns[index]
}

fn problem_mentions(result: &VerifyResult, stream: &str, row: Option<usize>, column: Option<&str>) -> bool {
    result.problems.iter().any(|problem| {
        problem.symbol.as_deref() == Some("CHECK")
            && problem.stream.as_deref() == Some(stream)
            && (row.is_none() || problem.row == row)
            && (column.is_none() || problem.column.as_deref() == column)
    })
}

#[test]
fn a_replaced_span_file_is_found_at_its_stream_row_and_column() {
    let data = built_day();
    replace_span(data.path(), MIN_0900, |span| stream_column(span, StreamKind::Book, "ask_qty1")[1] = 99);
    let result = verify(data.path());
    assert!(!result.passed);
    let found = result.problems.iter().find(|problem| problem.column.as_deref() == Some("ask_qty1")).unwrap();
    assert_eq!((found.symbol.as_deref(), found.stream.as_deref(), found.row), (Some("CHECK"), Some("book"), Some(1)));
    assert_eq!((found.expected, found.actual), (Some(2), Some(99)));
    let saved: VerifyResult = serde_json::from_slice(&fs::read(data.path().join("spans/20260720/verified.json")).unwrap()).unwrap();
    assert!(!saved.passed);
    assert_eq!(saved.problems, result.problems);
}

#[test]
fn a_deleted_span_file_fails_with_the_rows_it_took_along() {
    let data = built_day();
    fs::remove_file(span_path(data.path(), "CHECK", MIN_0900 + 10, 1)).unwrap();
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(problem_mentions(&result, "book", None, None), "{result}");
    assert!(problem_mentions(&result, "program", Some(0), None), "{result}");
}

#[test]
fn a_changed_carried_row_is_caught() {
    let data = built_day();
    replace_span(data.path(), MIN_0900 + 5, |span| stream_column(span, StreamKind::Book, "ask_px1")[0] += 1);
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(
        result.problems.iter().any(|problem| problem.stream.as_deref() == Some("book") && problem.message.contains("이월 행")),
        "{result}"
    );
}

#[test]
fn a_row_outside_the_span_is_caught() {
    let data = built_day();
    replace_span(data.path(), MIN_0900, |span| stream_column(span, StreamKind::Trades, "recv_ms")[0] += 5 * 60_000);
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(result.problems.iter().any(|problem| problem.message.contains("구간 밖")), "{result}");
}

#[test]
fn a_span_file_missing_from_the_index_is_caught() {
    let data = built_day();
    let index_path = data.path().join("spans/20260720/index.json");
    let mut index = Index::read(&index_path).unwrap();
    index.symbols.get_mut("CHECK").unwrap().spans.retain(|entry| entry.start != "0910");
    index.write_if_changed(&index_path).unwrap();
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(result.problems.iter().any(|problem| problem.message.contains("0910") && problem.message.contains("index.json에 없다")), "{result}");
}

#[test]
fn changed_gaps_are_caught() {
    let data = built_day();
    replace_span(data.path(), MIN_0900 + 5, |span| stream_column(span, StreamKind::Gaps, "to_ms")[0] -= 1000);
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(problem_mentions(&result, "gaps", None, None), "{result}");
}

#[test]
fn a_header_that_disagrees_with_the_path_is_caught() {
    let data = built_day();
    replace_span(data.path(), MIN_0900, |span| span.symbol = "OTHER".to_string());
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(result.problems.iter().any(|problem| problem.message.contains("파일 머리")), "{result}");
}

#[test]
fn an_index_that_does_not_point_at_the_newest_revision_is_caught() {
    let data = built_day();
    fs::copy(span_path(data.path(), "CHECK", MIN_0900, 1), span_path(data.path(), "CHECK", MIN_0900, 2)).unwrap();
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(result.problems.iter().any(|problem| problem.message.contains("지금 판이 아니다")), "{result}");
}

#[test]
fn a_missing_index_fails_and_still_writes_the_result() {
    let data = built_day();
    fs::remove_file(data.path().join("spans/20260720/index.json")).unwrap();
    let result = verify(data.path());
    assert!(!result.passed);
    assert!(data.path().join("spans/20260720/verified.json").exists());
}

#[test]
fn a_fixed_day_passes_again_after_a_rebuild() {
    let data = built_day();
    replace_span(data.path(), MIN_0900, |span| stream_column(span, StreamKind::Book, "ask_qty1")[1] = 99);
    assert!(!verify(data.path()).passed);
    let broken_path = span_path(data.path(), "CHECK", MIN_0900, 1);
    fs::remove_file(&broken_path).unwrap();
    build_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap();
    assert!(span_path(data.path(), "CHECK", MIN_0900, 1).exists());
    assert!(verify(data.path()).passed);
}

fn edit_index(data: &Path, change: impl FnOnce(&mut Index)) {
    let path = data.join("spans/20260720/index.json");
    let mut index = Index::read(&path).unwrap();
    change(&mut index);
    index.write_if_changed(&path).unwrap();
}

fn assert_fails_with(result: &VerifyResult, text: &str) {
    assert!(!result.passed, "{result}");
    assert!(result.problems.iter().any(|problem| problem.message.contains(text)), "{text}: {result}");
}

#[test]
fn a_deleted_span_between_the_first_and_last_row_is_caught_even_without_rows() {
    let data = built_day();
    fs::remove_file(span_path(data.path(), "CHECK", MIN_0900 + 5, 1)).unwrap();
    edit_index(data.path(), |index| index.symbols.get_mut("CHECK").unwrap().spans.retain(|entry| entry.start != "0905"));
    assert_fails_with(&verify(data.path()), "0905 구간 파일이 index.json에 없다");
}

#[test]
fn a_carry_row_that_was_removed_is_caught() {
    let data = built_day();
    let path = span_path(data.path(), "CHECK", MIN_0900 + 10, 1);
    let mut span = unpack(&fs::read(&path).unwrap()).unwrap();
    for column in &mut span.streams.iter_mut().find(|stream| stream.kind == StreamKind::Book).unwrap().columns {
        column.remove(0);
    }
    let packed = pack(&span).unwrap();
    fs::write(&path, &packed).unwrap();
    edit_index(data.path(), |index| {
        let entry = index.symbols.get_mut("CHECK").unwrap().spans.iter_mut().find(|entry| entry.start == "0910").unwrap();
        entry.rows = collector::build::index::RowCounts::of(&span);
        entry.bytes = packed.len() as u64;
    });
    assert_fails_with(&verify(data.path()), "이월 행이 없다");
}

#[test]
fn a_symbol_only_in_the_index_is_caught() {
    let data = built_day();
    edit_index(data.path(), |index| {
        let spans = index.symbols["CHECK"].clone();
        index.symbols.insert("GHOST".to_string(), spans);
    });
    assert_fails_with(&verify(data.path()), "원문에 행이 없는 종목");
}

#[test]
fn an_index_symbol_that_is_a_path_is_refused_without_reading_it() {
    let data = built_day();
    edit_index(data.path(), |index| {
        let spans = index.symbols["CHECK"].clone();
        index.symbols.insert("/etc".to_string(), spans);
    });
    assert_fails_with(&verify(data.path()), "폴더 이름으로 쓸 수 없는");
}

#[test]
fn a_span_outside_the_rows_range_is_caught() {
    let data = built_day();
    let empty = Span { date: DATE, start_minute: 8 * 60, length_minutes: 5, symbol: "CHECK".into(), streams: vec![] };
    let packed = pack(&empty).unwrap();
    fs::write(span_path(data.path(), "CHECK", 8 * 60, 1), &packed).unwrap();
    edit_index(data.path(), |index| {
        let spans = &mut index.symbols.get_mut("CHECK").unwrap().spans;
        spans.insert(
            0,
            collector::build::index::SpanEntry {
                start: "0800".into(),
                file: "0800-r1.hoga.br".into(),
                rows: Default::default(),
                bytes: packed.len() as u64,
            },
        );
    });
    assert_fails_with(&verify(data.path()), "범위 밖");
}

#[test]
fn an_index_that_misstates_the_read_errors_is_caught() {
    let data = built_day();
    edit_index(data.path(), |index| index.read_errors.items = 7);
    assert_fails_with(&verify(data.path()), "read_errors");
}
