use std::fs;
use std::path::PathBuf;

use collector::raw_read::{RawContent, RawItem, RawRecord, read_day};
use collector::raw_write::{RawLine, RawWriter};
use tempfile::tempdir;

const KST_2026_07_20_10_27_55: i64 = 1_784_510_875_000;
const MINUTE_MS: i64 = 60_000;

fn records(items: Vec<RawItem>) -> Vec<RawRecord> {
    items
        .into_iter()
        .map(|item| match item {
            RawItem::Record(record) => record,
            other => panic!("줄이 아닙니다: {other:?}"),
        })
        .collect()
}

fn day_files(data: &std::path::Path, day: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(data.join("raw").join(day))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn all_line_kinds_round_trip_in_order() {
    let data = tempdir().unwrap();
    let frame = r#"{"trnm":"REAL","data":[{"values":{"20":"102755",  "10":"-331000"},"type":"0B","item":"373220"}]}"#;
    let mut writer = RawWriter::new(data.path());
    let t = KST_2026_07_20_10_27_55;
    writer.write(&RawLine::Live { recv_ms: t }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: t + 1, text: frame }).unwrap();
    writer.write(&RawLine::Text { recv_ms: t + 2, text: "plain \"text\"\nwith newline" }).unwrap();
    writer.write(&RawLine::Down { recv_ms: t + 3, reason: "연결 끊김" }).unwrap();
    writer.close().unwrap();

    let read = records(read_day(data.path(), 20260720).unwrap().collect());
    let expected = vec![
        RawRecord { recv_ms: t, content: RawContent::Live },
        RawRecord { recv_ms: t + 1, content: RawContent::Frame(frame.to_string()) },
        RawRecord { recv_ms: t + 2, content: RawContent::Text("plain \"text\"\nwith newline".into()) },
        RawRecord { recv_ms: t + 3, content: RawContent::Down { reason: "연결 끊김".into() } },
    ];
    assert_eq!(read, expected);
}

#[test]
fn newline_bytes_in_a_frame_are_removed_and_nothing_else() {
    let data = tempdir().unwrap();
    let mut writer = RawWriter::new(data.path());
    let t = KST_2026_07_20_10_27_55;
    writer
        .write(&RawLine::Frame { recv_ms: t, text: "{\"a\":\r\n [1,\n2]}" })
        .unwrap();
    writer.close().unwrap();
    let read = records(read_day(data.path(), 20260720).unwrap().collect());
    assert_eq!(read[0].content, RawContent::Frame("{\"a\": [1,2]}".to_string()));
}

#[test]
fn lines_land_in_span_and_day_files_by_recv_ms() {
    let data = tempdir().unwrap();
    let mut writer = RawWriter::new(data.path());
    let t = KST_2026_07_20_10_27_55;
    let kst_midnight = 1_784_559_600_000;
    for recv_ms in [t, t + 4 * MINUTE_MS, kst_midnight - 1, kst_midnight] {
        writer.write(&RawLine::Live { recv_ms }).unwrap();
    }
    writer.close().unwrap();
    assert_eq!(day_files(data.path(), "20260720"), ["1025-000.jsonl.zst", "1030-000.jsonl.zst", "2355-000.jsonl.zst"]);
    assert_eq!(day_files(data.path(), "20260721"), ["0000-000.jsonl.zst"]);
}

#[test]
fn reopening_a_span_takes_the_next_free_number() {
    let data = tempdir().unwrap();
    let t = KST_2026_07_20_10_27_55;
    for _ in 0..2 {
        let mut writer = RawWriter::new(data.path());
        writer.write(&RawLine::Live { recv_ms: t }).unwrap();
        writer.close().unwrap();
    }
    assert_eq!(day_files(data.path(), "20260720"), ["1025-000.jsonl.zst", "1025-001.jsonl.zst"]);
    let read = records(read_day(data.path(), 20260720).unwrap().collect());
    assert_eq!(read.len(), 2);
}

#[test]
fn lowest_missing_number_is_used() {
    let data = tempdir().unwrap();
    let t = KST_2026_07_20_10_27_55;
    for _ in 0..3 {
        let mut writer = RawWriter::new(data.path());
        writer.write(&RawLine::Live { recv_ms: t }).unwrap();
        writer.close().unwrap();
    }
    fs::remove_file(data.path().join("raw/20260720/1025-001.jsonl.zst")).unwrap();
    let mut writer = RawWriter::new(data.path());
    writer.write(&RawLine::Live { recv_ms: t }).unwrap();
    writer.close().unwrap();
    assert_eq!(
        day_files(data.path(), "20260720"),
        ["1025-000.jsonl.zst", "1025-001.jsonl.zst", "1025-002.jsonl.zst"]
    );
}

#[test]
fn flushed_but_unclosed_file_reads_every_line_and_reports_truncation() {
    let data = tempdir().unwrap();
    let mut writer = RawWriter::new(data.path());
    let t = KST_2026_07_20_10_27_55;
    for offset in 0..50 {
        writer
            .write(&RawLine::Frame { recv_ms: t + offset, text: &format!("{{\"n\":{offset}}}") })
            .unwrap();
    }
    writer.flush().unwrap();

    let items: Vec<RawItem> = read_day(data.path(), 20260720).unwrap().collect();
    let (last, lines) = items.split_last().unwrap();
    assert!(matches!(last, RawItem::Truncated { .. }));
    assert_eq!(records(lines.to_vec()).len(), 50);
    writer.close().unwrap();
}

#[test]
fn truncated_file_keeps_leading_lines_and_is_reported() {
    let data = tempdir().unwrap();
    let t = KST_2026_07_20_10_27_55;
    let mut writer = RawWriter::new(data.path());
    for offset in 0..2000 {
        let text = format!("{{\"n\":{offset},\"pad\":\"{}\"}}", offset.to_string().repeat(20));
        writer.write(&RawLine::Frame { recv_ms: t + offset, text: &text }).unwrap();
    }
    writer.close().unwrap();
    let path: PathBuf = data.path().join("raw/20260720/1025-000.jsonl.zst");
    let whole = fs::read(&path).unwrap();
    fs::write(&path, &whole[..whole.len() - 7]).unwrap();

    let items: Vec<RawItem> = read_day(data.path(), 20260720).unwrap().collect();
    let truncated = items.iter().filter(|item| matches!(item, RawItem::Truncated { .. })).count();
    let read: Vec<&RawRecord> = items
        .iter()
        .filter_map(|item| match item {
            RawItem::Record(record) => Some(record),
            _ => None,
        })
        .collect();
    assert_eq!(truncated, 1);
    assert!(read.len() > 1000, "앞의 줄이 읽혀야 한다: {}", read.len());
    for (index, record) in read.iter().enumerate() {
        assert_eq!(record.recv_ms, t + index as i64);
    }
    assert!(items.iter().all(|item| !matches!(item, RawItem::BadLine { .. })));
}

#[test]
fn a_broken_line_is_reported_and_reading_continues() {
    let data = tempdir().unwrap();
    let t = KST_2026_07_20_10_27_55;
    let mut writer = RawWriter::new(data.path());
    writer.write(&RawLine::Frame { recv_ms: t, text: "{\"n\":1}" }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: t + 1, text: "{broken" }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: t + 2, text: "{\"n\":3}" }).unwrap();
    writer.close().unwrap();

    let items: Vec<RawItem> = read_day(data.path(), 20260720).unwrap().collect();
    assert_eq!(items.len(), 3);
    assert!(matches!(items[0], RawItem::Record(_)));
    assert!(matches!(&items[1], RawItem::BadLine { line_number: 2, .. }));
    assert!(matches!(items[2], RawItem::Record(_)));
}

#[test]
fn files_are_read_in_name_order() {
    let data = tempdir().unwrap();
    let t = KST_2026_07_20_10_27_55;
    let mut writer = RawWriter::new(data.path());
    writer.write(&RawLine::Live { recv_ms: t + 5 * MINUTE_MS }).unwrap();
    writer.write(&RawLine::Live { recv_ms: t }).unwrap();
    writer.close().unwrap();
    let read = records(read_day(data.path(), 20260720).unwrap().collect());
    assert_eq!(read.iter().map(|record| record.recv_ms).collect::<Vec<_>>(), [t, t + 5 * MINUTE_MS]);
}

#[test]
fn json_scalar_frames_round_trip_including_null() {
    let data = tempdir().unwrap();
    let t = KST_2026_07_20_10_27_55;
    let texts = ["null", "true", "0", "\"s\"", "[]", "[null]"];
    let mut writer = RawWriter::new(data.path());
    for (offset, text) in texts.iter().enumerate() {
        writer.write(&RawLine::Frame { recv_ms: t + offset as i64, text }).unwrap();
    }
    writer.close().unwrap();
    let read = records(read_day(data.path(), 20260720).unwrap().collect());
    let frames: Vec<&str> = read
        .iter()
        .map(|record| match &record.content {
            RawContent::Frame(text) => text.as_str(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(frames, texts);
}
