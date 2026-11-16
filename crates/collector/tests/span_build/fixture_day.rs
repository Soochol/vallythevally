use std::fs;

use collector::build::build_day;
use collector::verify::verify_day;
use hoga_format::StreamKind;

use super::support::*;

const SPANS_1955_2000: [&str; 2] = ["1955-r1.hoga.br", "2000-r1.hoga.br"];
const SPANS_1025_1030: [&str; 2] = ["1025-r1.hoga.br", "1030-r1.hoga.br"];

fn built_fixture() -> tempfile::TempDir {
    let data = fixture_day();
    let report = build_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap();
    assert!(!report.failed(), "{report}");
    data
}

fn own_rows(data: &std::path::Path, symbol: &str, kind: StreamKind) -> usize {
    let index = index_of(data);
    index.symbols[symbol]
        .spans
        .iter()
        .map(|entry| {
            let start_minute = collector::build::store::parse_hhmm(&entry.start).unwrap();
            let span = read_span(data, symbol, start_minute, 1);
            let Some(stream) = span.stream(kind) else { return 0 };
            let carried = kind != StreamKind::Trades && stream.columns[0][0] < i64::from(start_minute) * 60_000;
            stream.rows() - usize::from(carried)
        })
        .sum()
}

#[test]
fn builds_exactly_the_spans_the_capture_covers() {
    let data = built_fixture();
    for symbol in ["005930_NX", "000660_NX"] {
        assert_eq!(span_names(data.path(), symbol), SPANS_1955_2000, "{symbol}");
    }
    for symbol in ["000660", "005380", "005930", "207940", "373220"] {
        assert_eq!(span_names(data.path(), symbol), SPANS_1025_1030, "{symbol}");
    }
}

#[test]
fn span_rows_without_carry_add_up_to_the_raw_counts() {
    let data = built_fixture();
    assert_eq!(own_rows(data.path(), "005930_NX", StreamKind::Book), 1202);
    assert_eq!(own_rows(data.path(), "000660_NX", StreamKind::Book), 1180);
    let symbols = ["000660", "005380", "005930", "207940", "373220"];
    let total = |kind| symbols.iter().map(|symbol| own_rows(data.path(), symbol, kind)).sum::<usize>();
    assert_eq!(total(StreamKind::Program), 205);
    assert_eq!(total(StreamKind::Broker), 24);
    assert_eq!(total(StreamKind::Trades), 6880);
}

#[test]
fn a_book_frame_decodes_to_the_hand_copied_values() {
    let data = built_fixture();
    let span = read_span(data.path(), "005930_NX", 19 * 60 + 55, 1);
    let at = |kind, name: &str| column(&span, kind, name)[0];
    let book = StreamKind::Book;
    assert_eq!(at(book, "recv_ms"), 71_780_553);
    assert_eq!(at(book, "t_s"), 71_780);
    let ask_prices = [251500, 252000, 252500, 253000, 253500, 254000, 254500, 255000, 255500, 256000];
    let bid_prices = [251000, 250500, 250000, 249500, 249000, 248500, 248000, 247500, 247000, 246500];
    let ask_quantities = [9701, 72529, 51664, 35793, 43934, 33424, 30616, 81527, 21657, 45361];
    let bid_quantities = [77446, 24762, 48023, 31981, 33338, 32348, 41848, 54057, 22788, 29508];
    for level in 0..10 {
        assert_eq!(at(book, &format!("ask_px{}", level + 1)), ask_prices[level]);
        assert_eq!(at(book, &format!("bid_px{}", level + 1)), bid_prices[level]);
        assert_eq!(at(book, &format!("ask_qty{}", level + 1)), ask_quantities[level]);
        assert_eq!(at(book, &format!("bid_qty{}", level + 1)), bid_quantities[level]);
    }
    assert_eq!(at(book, "ask_total"), 426206);
    assert_eq!(at(book, "bid_total"), 396099);
}

#[test]
fn a_trade_a_program_row_and_a_broker_row_decode_to_the_hand_copied_values() {
    let data = built_fixture();
    let span = read_span(data.path(), "005930", 10 * 60 + 30, 1);

    let trade = |name: &str| column(&span, StreamKind::Trades, name)[0];
    assert_eq!(trade("recv_ms"), 37_800_038);
    assert_eq!(trade("t_s"), 10 * 3600 + 29 * 60 + 59);
    assert_eq!(trade("price"), 248500);
    assert_eq!(trade("qty"), -28);
    assert_eq!(trade("venue"), 1);

    let span_start_ms = (10 * 60 + 30) * 60_000;
    let first_own_of = |kind: StreamKind| usize::from(column(&span, kind, "recv_ms")[0] < span_start_ms);
    let program_row = first_own_of(StreamKind::Program);
    let program = |name: &str| column(&span, StreamKind::Program, name)[program_row];
    assert_eq!(program("recv_ms"), 37_801_942);
    assert_eq!(program("t_s"), 10 * 3600 + 30 * 60 + 1);
    assert_eq!(program("sell_qty"), 2883097);
    assert_eq!(program("sell_amt"), 718738);
    assert_eq!(program("buy_qty"), 4114087);
    assert_eq!(program("buy_amt"), 1028453);

    let broker = |name: &str| column(&span, StreamKind::Broker, name);
    let first_own = first_own_of(StreamKind::Broker);
    assert_eq!(broker("recv_ms")[first_own], 37_847_638);
    let at_first = |name: &str| -> Vec<i64> { (1..=5).map(|level| broker(&format!("{name}{level}"))[first_own]).collect() };
    assert_eq!(at_first("sell_code"), [3, 5, 17, 50, 43]);
    assert_eq!(at_first("buy_code"), [17, 37, 45, 5, 33]);
    assert_eq!(at_first("sell_qty"), [1422952, 934647, 752418, 674496, 657945]);
    assert_eq!(at_first("buy_qty"), [942121, 887884, 735523, 674670, 649392]);
}

#[test]
fn the_carried_row_is_the_previous_spans_last_row() {
    let data = built_fixture();
    let earlier = read_span(data.path(), "005930_NX", 19 * 60 + 55, 1);
    let later = read_span(data.path(), "005930_NX", 20 * 60, 1);
    let last_of_earlier: Vec<i64> =
        earlier.stream(StreamKind::Book).unwrap().columns.iter().map(|column| *column.last().unwrap()).collect();
    let first_of_later: Vec<i64> =
        later.stream(StreamKind::Book).unwrap().columns.iter().map(|column| column[0]).collect();
    assert_eq!(first_of_later, last_of_earlier);
    assert_eq!(first_of_later[0], 71_999_951);
    assert!(first_of_later[0] < 20 * 60 * 60_000);
    assert_eq!(later.stream(StreamKind::Book).unwrap().rows(), 3);
}

#[test]
fn the_index_lists_members_and_current_files() {
    let data = built_fixture();
    let index = index_of(data.path());
    assert_eq!(index.date, DATE);
    assert_eq!(index.version, hoga_format::VERSION);
    assert_eq!(index.members.get("003").map(String::as_str), Some("한국투자증권"));
    assert_eq!(index.members.get("030").map(String::as_str), Some("삼  성"));
    assert_eq!(index.members.len(), 18);
    let entries = &index.symbols["005930_NX"].spans;
    assert_eq!(entries.iter().map(|entry| entry.start.as_str()).collect::<Vec<_>>(), ["1955", "2000"]);
    assert_eq!(entries[0].file, "1955-r1.hoga.br");
    assert_eq!(entries[0].rows.book, 1200);
    assert_eq!(entries[1].rows.book, 3);
    let file_size = fs::metadata(span_path(data.path(), "005930_NX", 19 * 60 + 55, 1)).unwrap().len();
    assert_eq!(entries[0].bytes, file_size);
}

#[test]
fn building_again_changes_nothing() {
    let data = built_fixture();
    let index_path = data.path().join("spans/20260720/index.json");
    let index_before = fs::read(&index_path).unwrap();
    let file_before = fs::read(span_path(data.path(), "005930", 10 * 60 + 30, 1)).unwrap();
    let again = build_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap();
    assert_eq!(again.written_files, 0);
    assert_eq!(again.unchanged_files, 14);
    assert!(!again.index_written);
    assert_eq!(fs::read(&index_path).unwrap(), index_before);
    assert_eq!(fs::read(span_path(data.path(), "005930", 10 * 60 + 30, 1)).unwrap(), file_before);
    assert_eq!(span_names(data.path(), "005930"), SPANS_1025_1030);
}

#[test]
fn verify_passes_on_the_untouched_build_and_leaves_the_raw_files() {
    let data = built_fixture();
    let result = verify_day(data.path(), DATE, AFTER_THE_DAY_UNIX_MS).unwrap();
    assert!(result.passed, "{result}");
    assert_eq!(result.rows["005930"].trades, 2920);
    assert_eq!(result.rows["005930_NX"].book, 1202);
    assert_eq!(result.read_errors.total(), 0);
    let written: serde_json::Value =
        serde_json::from_slice(&fs::read(data.path().join("spans/20260720/verified.json")).unwrap()).unwrap();
    assert_eq!(written["passed"], true);
    assert_eq!(written["date"], DATE);
    assert_eq!(fs::read_dir(data.path().join("raw/20260720")).unwrap().count(), 4);
}
