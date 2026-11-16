use std::collections::HashMap;
use std::path::Path;

use collector::parse::{Item, parse_frame};
use collector::raw_read::{RawContent, RawItem, read_day};
use hoga_format::StreamKind;

#[derive(Default)]
struct Totals {
    rows: HashMap<(StreamKind, String), usize>,
    trade_items: usize,
    not_trades: usize,
    unsupported: usize,
    item_errors: usize,
    frame_errors: usize,
    events: usize,
    other_lines: usize,
    bad_lines: usize,
    truncated_files: usize,
}

fn read_fixture() -> Totals {
    let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut totals = Totals::default();
    for item in read_day(&data, 20260720).unwrap() {
        match item {
            RawItem::Record(record) => match record.content {
                RawContent::Frame(text) => match parse_frame(&text) {
                    Ok(parsed) => {
                        for entry in parsed {
                            match entry {
                                Ok(Item::Row(row)) => {
                                    if row.kind == StreamKind::Trades {
                                        totals.trade_items += 1;
                                    }
                                    *totals.rows.entry((row.kind, row.symbol)).or_default() += 1;
                                }
                                Ok(Item::NotTrade { .. }) => {
                                    totals.not_trades += 1;
                                    totals.trade_items += 1;
                                }
                                Ok(Item::Unsupported { .. }) => totals.unsupported += 1,
                                Err(_) => totals.item_errors += 1,
                            }
                        }
                    }
                    Err(_) => totals.frame_errors += 1,
                },
                RawContent::Live | RawContent::Down { .. } => totals.events += 1,
                RawContent::Text(_) => totals.other_lines += 1,
            },
            RawItem::BadLine { .. } => totals.bad_lines += 1,
            RawItem::Truncated { .. } => totals.truncated_files += 1,
            RawItem::Unreadable { .. } => totals.other_lines += 1,
        }
    }
    totals
}

#[test]
fn committed_capture_parses_without_errors_and_with_known_counts() {
    let totals = read_fixture();
    let rows_of = |kind: StreamKind| -> usize {
        totals.rows.iter().filter(|((k, _), _)| *k == kind).map(|(_, count)| count).sum()
    };
    let count = |kind: StreamKind, symbol: &str| totals.rows.get(&(kind, symbol.to_string())).copied().unwrap_or(0);

    assert_eq!(rows_of(StreamKind::Book), 2382);
    assert_eq!(count(StreamKind::Book, "005930_NX"), 1202);
    assert_eq!(count(StreamKind::Book, "000660_NX"), 1180);
    assert_eq!(totals.trade_items, 6880);
    assert_eq!(rows_of(StreamKind::Trades) + totals.not_trades, 6880);
    assert_eq!(rows_of(StreamKind::Program), 205);
    assert_eq!(rows_of(StreamKind::Broker), 24);

    assert_eq!(totals.item_errors, 0);
    assert_eq!(totals.frame_errors, 0);
    assert_eq!(totals.bad_lines, 0);
    assert_eq!(totals.truncated_files, 0);
    assert_eq!(totals.events, 0);
    assert_eq!(totals.other_lines, 0);
    assert_eq!(totals.unsupported, 0);
}
