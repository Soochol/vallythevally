use std::fs;
use std::path::{Path, PathBuf};

use collector::build::index::Index;
use collector::build::store::{span_file_name, symbol_dir, unpack};
use collector::raw_write::{RawLine, RawWriter};
use hoga_format::{Span, StreamKind};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

pub const DATE: u32 = 20260720;
pub const DAY_START_UNIX_MS: i64 = 1_784_473_200_000;
pub const AFTER_THE_DAY_UNIX_MS: i64 = DAY_START_UNIX_MS + 36 * 3_600_000;

pub fn at(hour: i64, minute: i64, second: i64) -> i64 {
    DAY_START_UNIX_MS + ((hour * 60 + minute) * 60 + second) * 1000
}

pub fn ms_of_day(unix_ms: i64) -> i64 {
    unix_ms - DAY_START_UNIX_MS
}

pub fn fixture_day() -> TempDir {
    fixture_day_under("raw/20260720")
}

pub fn fixture_day_in_key_folder() -> TempDir {
    fixture_day_under("raw/20260720/k1")
}

fn fixture_day_under(raw_folder: &str) -> TempDir {
    let data = tempdir().unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/raw/20260720");
    let target = data.path().join(raw_folder);
    fs::create_dir_all(&target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|extension| extension == "zst") {
            fs::copy(&path, target.join(path.file_name().unwrap())).unwrap();
        }
    }
    data
}

pub enum Line {
    Frame(i64, Value),
    Raw(i64, &'static str),
    Live(i64),
    Down(i64),
}

pub fn write_raw(data: &Path, lines: &[Line]) {
    let mut writer = RawWriter::new(data);
    for line in lines {
        match line {
            Line::Frame(recv_ms, frame) => {
                writer.write(&RawLine::Frame { recv_ms: *recv_ms, text: &frame.to_string() }).unwrap()
            }
            Line::Raw(recv_ms, text) => writer.write(&RawLine::Frame { recv_ms: *recv_ms, text }).unwrap(),
            Line::Live(recv_ms) => writer.write(&RawLine::Live { recv_ms: *recv_ms }).unwrap(),
            Line::Down(recv_ms) => writer.write(&RawLine::Down { recv_ms: *recv_ms, reason: "시험" }).unwrap(),
        }
    }
    writer.close().unwrap();
}

fn real_frame(real_type: &str, symbol: &str, values: Value) -> Value {
    json!({"trnm": "REAL", "data": [{"values": values, "type": real_type, "item": symbol}]})
}

pub fn book_frame(symbol: &str, time: &str, ask_px1: &str, ask_qty1: &str) -> Value {
    real_frame(
        "0D",
        symbol,
        json!({"21": time, "41": format!("+{ask_px1}"), "51": "-1000", "61": ask_qty1, "71": "7", "121": "10", "125": "20"}),
    )
}

pub fn trade_frame(symbol: &str, time: &str, price: &str, signed_qty: &str) -> Value {
    real_frame("0B", symbol, json!({"20": time, "10": price, "15": signed_qty, "9081": "KRX"}))
}

pub fn program_frame(symbol: &str, time: &str, sell_qty: &str) -> Value {
    real_frame("0w", symbol, json!({"20": time, "202": sell_qty, "204": "2", "206": "3", "208": "4"}))
}

pub fn unsupported_frame(symbol: &str) -> Value {
    real_frame("0E", symbol, json!({"20": "090000"}))
}

pub fn read_span(data: &Path, symbol: &str, start_minute: u16, revision: u32) -> Span {
    let path = symbol_dir(data, DATE, symbol).join(span_file_name(start_minute, revision));
    unpack(&fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap()
}

pub fn span_path(data: &Path, symbol: &str, start_minute: u16, revision: u32) -> PathBuf {
    symbol_dir(data, DATE, symbol).join(span_file_name(start_minute, revision))
}

pub fn column(span: &Span, kind: StreamKind, name: &str) -> Vec<i64> {
    span.stream(kind)
        .and_then(|stream| stream.column(name))
        .unwrap_or_else(|| panic!("{} 흐름의 {name} 열이 없다", kind.name()))
        .to_vec()
}

pub fn index_of(data: &Path) -> Index {
    Index::read(&data.join("spans/20260720/index.json")).unwrap()
}

pub fn span_names(data: &Path, symbol: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(symbol_dir(data, DATE, symbol))
        .map(|entries| entries.map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect())
        .unwrap_or_default();
    names.sort();
    names
}
