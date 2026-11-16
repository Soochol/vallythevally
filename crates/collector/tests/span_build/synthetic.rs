use std::fs;

use collector::build::{build_day, last_finished_span};
use collector::raw_write::{RawLine, RawWriter};
use collector::verify::verify_day;
use hoga_format::StreamKind;

use super::support::*;

const MIN_0900: u16 = 9 * 60;

fn build(data: &std::path::Path) -> collector::build::report::BuildReport {
    build_day(data, DATE, AFTER_THE_DAY_UNIX_MS).unwrap()
}

#[test]
fn a_span_without_new_rows_holds_only_the_carried_rows() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[
            Line::Frame(at(9, 0, 10), book_frame("SPARSE", "090010", "1000", "5")),
            Line::Frame(at(9, 0, 20), trade_frame("SPARSE", "090020", "-1000", "+3")),
            Line::Frame(at(9, 0, 25), program_frame("SPARSE", "090025", "11")),
            Line::Frame(at(9, 12, 10), book_frame("SPARSE", "091210", "1010", "6")),
            Line::Frame(at(9, 12, 20), trade_frame("SPARSE", "091220", "-1010", "-4")),
        ],
    );
    let report = build(data.path());
    assert!(!report.failed(), "{report}");
    assert_eq!(span_names(data.path(), "SPARSE"), ["0900-r1.hoga.br", "0905-r1.hoga.br", "0910-r1.hoga.br"]);

    let middle = read_span(data.path(), "SPARSE", MIN_0900 + 5, 1);
    let book = column(&middle, StreamKind::Book, "recv_ms");
    assert_eq!(book, [ms_of_day(at(9, 0, 10))]);
    assert_eq!(column(&middle, StreamKind::Program, "recv_ms"), [ms_of_day(at(9, 0, 25))]);
    assert!(middle.stream(StreamKind::Trades).is_none());
    assert!(middle.stream(StreamKind::Broker).is_none());
    assert!(middle.stream(StreamKind::Gaps).is_none());

    let last = read_span(data.path(), "SPARSE", MIN_0900 + 10, 1);
    assert_eq!(column(&last, StreamKind::Book, "recv_ms"), [ms_of_day(at(9, 0, 10)), ms_of_day(at(9, 12, 10))]);
    assert_eq!(column(&last, StreamKind::Trades, "recv_ms"), [ms_of_day(at(9, 12, 20))]);
    assert_eq!(column(&last, StreamKind::Trades, "qty"), [-4]);
    assert!(verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}

#[test]
fn gaps_are_cut_from_the_event_lines_into_every_symbol_file() {
    let data = tempfile::tempdir().unwrap();
    let frame = |h, m, s| Line::Frame(at(h, m, s), book_frame("GAPPY", &format!("{h:02}{m:02}{s:02}"), "1000", "1"));
    write_raw(
        data.path(),
        &[
            Line::Live(at(9, 0, 0)),
            frame(9, 0, 30),
            Line::Frame(at(9, 1, 0), trade_frame("OTHER", "090100", "-5", "+1")),
            Line::Down(at(9, 2, 0)),
            Line::Live(at(9, 3, 0)),
            frame(9, 4, 0),
            frame(9, 6, 0),
            Line::Live(at(9, 7, 0)),
            Line::Down(at(9, 9, 30)),
            Line::Live(at(9, 11, 0)),
            Line::Down(at(9, 14, 0)),
            frame(9, 16, 0),
            Line::Frame(at(9, 16, 0), trade_frame("OTHER", "091600", "-5", "+1")),
        ],
    );
    let report = build(data.path());
    assert!(!report.failed(), "{report}");
    assert_eq!(report.gap_intervals, 4);

    let gaps_of = |symbol: &str, start_minute: u16| -> Vec<(i64, i64)> {
        let span = read_span(data.path(), symbol, start_minute, 1);
        let from = column(&span, StreamKind::Gaps, "from_ms");
        let to = column(&span, StreamKind::Gaps, "to_ms");
        from.into_iter().zip(to).collect()
    };
    let ms = |h, m, s| ms_of_day(at(h, m, s));
    assert_eq!(gaps_of("GAPPY", MIN_0900), [(ms(9, 2, 0), ms(9, 3, 0))]);
    assert_eq!(gaps_of("GAPPY", MIN_0900 + 5), [(ms(9, 6, 0), ms(9, 7, 0)), (ms(9, 9, 30), ms(9, 10, 0))]);
    assert_eq!(gaps_of("GAPPY", MIN_0900 + 10), [(ms(9, 10, 0), ms(9, 11, 0)), (ms(9, 14, 0), ms(9, 15, 0))]);
    assert_eq!(gaps_of("GAPPY", MIN_0900 + 15), [(ms(9, 15, 0), ms(9, 16, 0))]);
    assert_eq!(gaps_of("OTHER", MIN_0900), [(ms(9, 2, 0), ms(9, 3, 0))]);
    assert_eq!(gaps_of("OTHER", MIN_0900 + 15), [(ms(9, 15, 0), ms(9, 16, 0))]);
    assert!(verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}

#[test]
fn a_day_that_starts_with_live_has_no_gap() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[Line::Live(at(9, 0, 0)), Line::Frame(at(9, 0, 5), book_frame("CALM", "090005", "1000", "1"))],
    );
    assert_eq!(build(data.path()).gap_intervals, 0);
    assert!(read_span(data.path(), "CALM", MIN_0900, 1).stream(StreamKind::Gaps).is_none());
}

#[test]
fn a_first_start_with_control_responses_before_live_has_no_gap() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[
            Line::Raw(at(9, 0, 0), r#"{"trnm":"LOGIN","return_code":0}"#),
            Line::Raw(at(9, 0, 1), r#"{"trnm":"REG","return_code":0}"#),
            Line::Live(at(9, 0, 2)),
            Line::Frame(at(9, 0, 5), book_frame("FIRST", "090005", "1000", "1")),
        ],
    );
    let report = build(data.path());
    assert!(!report.failed(), "{report}");
    assert_eq!(report.gap_intervals, 0);
    assert!(read_span(data.path(), "FIRST", MIN_0900, 1).stream(StreamKind::Gaps).is_none());
    assert!(verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}

#[test]
fn a_process_death_after_real_frames_leaves_a_gap_from_the_last_line() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[
            Line::Live(at(9, 0, 0)),
            Line::Frame(at(9, 0, 5), book_frame("DIED", "090005", "1000", "1")),
            Line::Raw(at(9, 3, 0), r#"{"trnm":"LOGIN","return_code":0}"#),
            Line::Live(at(9, 3, 1)),
            Line::Frame(at(9, 3, 5), book_frame("DIED", "090305", "1000", "1")),
        ],
    );
    let report = build(data.path());
    assert!(!report.failed(), "{report}");
    assert_eq!(report.gap_intervals, 1);
    let span = read_span(data.path(), "DIED", MIN_0900, 1);
    assert_eq!(column(&span, StreamKind::Gaps, "from_ms"), [ms_of_day(at(9, 3, 0))]);
    assert_eq!(column(&span, StreamKind::Gaps, "to_ms"), [ms_of_day(at(9, 3, 1))]);
    assert!(verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}

#[test]
fn only_finished_spans_are_cut_for_today() {
    let ms = |h, m, s, extra| at(h, m, s) + extra;
    assert_eq!(last_finished_span(DATE, ms(9, 4, 59, 999)), Some(107));
    assert_eq!(last_finished_span(DATE, ms(9, 5, 9, 999)), Some(107));
    assert_eq!(last_finished_span(DATE, ms(9, 5, 10, 0)), Some(108));
    assert_eq!(last_finished_span(DATE, ms(9, 5, 40, 0)), Some(108));
    assert_eq!(last_finished_span(DATE, ms(0, 0, 9, 0)), None);
    assert_eq!(last_finished_span(DATE, ms(0, 5, 10, 0)), Some(0));
    assert_eq!(last_finished_span(DATE - 1, ms(0, 0, 0, 0)), Some(u32::MAX));
    assert_eq!(last_finished_span(DATE + 1, ms(23, 59, 59, 0)), None);
}

#[test]
fn building_today_leaves_out_unfinished_spans_and_adds_them_later() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[
            Line::Frame(at(9, 0, 10), book_frame("LIVE", "090010", "1000", "1")),
            Line::Frame(at(9, 6, 0), book_frame("LIVE", "090600", "1001", "1")),
        ],
    );
    let early = build_day(data.path(), DATE, at(9, 10, 5)).unwrap();
    assert_eq!(early.written_files, 1);
    assert_eq!(span_names(data.path(), "LIVE"), ["0900-r1.hoga.br"]);
    assert_eq!(index_of(data.path()).symbols["LIVE"].spans.len(), 1);

    let later = build_day(data.path(), DATE, at(9, 10, 11)).unwrap();
    assert_eq!((later.written_files, later.unchanged_files), (1, 1));
    assert_eq!(span_names(data.path(), "LIVE"), ["0900-r1.hoga.br", "0905-r1.hoga.br"]);
    assert_eq!(index_of(data.path()).symbols["LIVE"].spans.len(), 2);
}

#[test]
fn more_raw_lines_in_a_built_span_make_a_new_revision_and_keep_the_old_one() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[
            Line::Frame(at(9, 0, 10), book_frame("REV", "090010", "1000", "1")),
            Line::Frame(at(9, 6, 0), book_frame("REV", "090600", "1001", "1")),
        ],
    );
    build(data.path());
    let before = fs::read(span_path(data.path(), "REV", MIN_0900, 1)).unwrap();

    write_raw(data.path(), &[Line::Frame(at(9, 1, 0), book_frame("REV", "090100", "1002", "9"))]);
    let report = build(data.path());
    assert_eq!(report.written_files, 2);
    assert_eq!(span_names(data.path(), "REV"), ["0900-r1.hoga.br", "0900-r2.hoga.br", "0905-r1.hoga.br", "0905-r2.hoga.br"]);
    assert_eq!(fs::read(span_path(data.path(), "REV", MIN_0900, 1)).unwrap(), before);
    assert_eq!(column(&read_span(data.path(), "REV", MIN_0900, 2), StreamKind::Book, "ask_qty1"), [1, 9]);
    let entries = &index_of(data.path()).symbols["REV"].spans;
    assert_eq!(entries.iter().map(|entry| entry.file.as_str()).collect::<Vec<_>>(), ["0900-r2.hoga.br", "0905-r2.hoga.br"]);
    assert!(verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);

    let third = build(data.path());
    assert_eq!(third.written_files, 0);
    assert_eq!(span_names(data.path(), "REV").len(), 4);
}

#[test]
fn a_value_beyond_i32_blocks_its_span_and_the_spans_that_carry_it() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[
            Line::Frame(at(9, 0, 10), book_frame("HUGE", "090010", "1000", "3000000000")),
            Line::Frame(at(9, 6, 0), book_frame("HUGE", "090600", "1000", "5")),
            Line::Frame(at(9, 11, 0), book_frame("HUGE", "091100", "1000", "6")),
            Line::Frame(at(9, 0, 10), book_frame("FINE", "090010", "1000", "5")),
        ],
    );
    let report = build(data.path());
    assert!(report.failed());
    let failed: Vec<(&str, &str, &str)> = report
        .range_failures
        .iter()
        .map(|failure| (failure.symbol.as_str(), failure.start.as_str(), failure.column.as_str()))
        .collect();
    assert_eq!(failed, [("HUGE", "0900", "ask_qty1"), ("HUGE", "0905", "ask_qty1")]);
    assert_eq!(report.range_failures[0].value, 3_000_000_000);
    assert_eq!(span_names(data.path(), "HUGE"), ["0910-r1.hoga.br"]);
    assert_eq!(span_names(data.path(), "FINE"), ["0900-r1.hoga.br"]);
    assert!(report.to_string().contains("범위 초과: 종목 HUGE 구간 0900"));
    assert!(!verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}

#[test]
fn broken_items_are_left_out_counted_and_fail_the_build() {
    let data = tempfile::tempdir().unwrap();
    write_raw(
        data.path(),
        &[
            Line::Frame(at(9, 0, 10), book_frame("GOOD", "090010", "1000", "1")),
            Line::Frame(at(9, 0, 11), book_frame("GOOD", "9x0011", "1000", "2")),
            Line::Raw(at(9, 0, 12), "{broken"),
            Line::Raw(at(9, 0, 13), "not json at all"),
            Line::Frame(at(9, 0, 14), book_frame("GOOD", "090014", "1000", "3")),
        ],
    );
    let report = build(data.path());
    assert!(report.failed());
    assert_eq!((report.read_errors.items, report.read_errors.lines), (1, 2));
    assert_eq!(column(&read_span(data.path(), "GOOD", MIN_0900, 1), StreamKind::Book, "ask_qty1"), [1, 3]);
    assert_eq!(index_of(data.path()).read_errors.items, 1);
    assert_eq!(index_of(data.path()).read_errors.lines, 2);
    let verified = verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap();
    assert!(!verified.passed);
    assert_eq!(verified.problem_count, 0, "{verified}");
    assert_eq!(verified.read_errors.items, 1);
}

#[test]
fn skipped_items_are_counted_and_a_cut_off_file_is_reported() {
    let data = tempfile::tempdir().unwrap();
    let mut writer = RawWriter::new(data.path());
    let frames = [
        trade_frame("QUIET", "090000", "-1000", "0"),
        unsupported_frame("QUIET"),
        trade_frame("QUIET", "090001", "-1000", "+2"),
    ];
    for (offset, frame) in frames.iter().enumerate() {
        writer.write(&RawLine::Frame { recv_ms: at(9, 0, offset as i64), text: &frame.to_string() }).unwrap();
    }
    writer.flush().unwrap();
    drop(writer);
    let report = build(data.path());
    assert_eq!((report.skipped.not_trade, report.skipped.unsupported), (1, 1));
    assert_eq!(report.read_errors.truncated_files, 1);
    assert_eq!(report.truncated_files.len(), 1);
    assert!(!report.failed(), "{report}");
    assert_eq!(column(&read_span(data.path(), "QUIET", MIN_0900, 1), StreamKind::Trades, "qty"), [2]);
    assert!(!verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}

#[test]
fn symbols_that_cannot_be_directory_names_are_refused() {
    let data = tempfile::tempdir().unwrap();
    write_raw(data.path(), &[Line::Frame(at(9, 0, 10), book_frame("../ESCAPE", "090010", "1000", "1"))]);
    let report = build(data.path());
    assert!(report.failed());
    assert_eq!(report.read_errors.items, 1);
    assert!(!data.path().join("spans/ESCAPE").exists());
    assert!(!data.path().join("spans/20260720/../ESCAPE").exists());
}

#[test]
fn a_recv_ms_that_is_not_a_time_is_a_read_error_not_a_panic() {
    let data = tempfile::tempdir().unwrap();
    write_raw(data.path(), &[Line::Frame(at(9, 0, 10), book_frame("OK", "090010", "1000", "1"))]);
    let lines = format!(
        "{{\"recv_ms\":{},\"event\":\"live\"}}\n{{\"recv_ms\":-5,\"event\":\"live\"}}\n",
        i64::MAX
    );
    let packed = zstd::encode_all(lines.as_bytes(), 3).unwrap();
    fs::write(data.path().join("raw/20260720/9999-000.jsonl.zst"), packed).unwrap();
    let report = build(data.path());
    assert_eq!(report.read_errors.lines, 2);
    assert!(report.failed());
    assert!(!verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}

#[test]
fn rows_that_come_back_to_an_earlier_span_are_a_read_error() {
    let data = tempfile::tempdir().unwrap();
    write_raw(data.path(), &[Line::Frame(at(9, 12, 0), book_frame("BACK", "091200", "1000", "1"))]);
    write_raw(data.path(), &[Line::Frame(at(9, 2, 0), book_frame("BACK", "090200", "1000", "2"))]);
    fs::rename(data.path().join("raw/20260720/0900-000.jsonl.zst"), data.path().join("raw/20260720/9999-000.jsonl.zst")).unwrap();
    let report = build(data.path());
    assert!(report.failed());
    assert_eq!(report.read_errors.items, 1);
    assert_eq!(column(&read_span(data.path(), "BACK", MIN_0900 + 10, 1), StreamKind::Book, "ask_qty1"), [1]);
    assert!(!verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap().passed);
}
