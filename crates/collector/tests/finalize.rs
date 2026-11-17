use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use collector::finalize::schema::{self, ColumnKind};
use collector::finalize::{DEFAULT_SPILL_BUDGET_BYTES, Options, bucket_of, store_dir, temporary_store_dir, tally_day, verify_store, write_store};
use collector::raw_write::{RawLine, RawWriter};
use duckdb::Connection;
use duckdb::types::Value;
use serde_json::{Value as Json, json};
use tempfile::{TempDir, tempdir};

const DATE: u32 = 20_261_117;
const DATE_TEXT: &str = "20261117";
const NINE_AM_KST_MS: i64 = 1_794_841_200_000 + 9 * 3_600_000;
const SYMBOL_COUNT: usize = 48;
const ROUNDS: usize = 30;
const STOCK_TYPES: [&str; 8] = ["0B", "0D", "0w", "0F", "1h", "0H", "0E", "0g"];

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, limit: usize) -> usize {
        (self.next() % limit as u64) as usize
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Cellular {
    Null,
    Int(i64),
    Float(f64),
    Text(String),
    Flag(bool),
}

struct ModelRow {
    type_index: usize,
    symbol: String,
    recv_ms: i64,
    line: u64,
    entry: u32,
    texts: BTreeMap<u32, String>,
}

struct EntrySpec {
    type_code: &'static str,
    symbol: String,
    raw_values: Vec<(String, String)>,
    stored_values: Vec<(u32, String)>,
    stored: bool,
}

#[derive(Default)]
struct Expected {
    rows: Vec<ModelRow>,
    finalized: u64,
    control: u64,
    unfinalized: BTreeMap<&'static str, u64>,
    symbol_messages: BTreeMap<String, u64>,
    lines: u64,
}

struct DayBuilder {
    writer: RawWriter,
    recv_ms: i64,
    expected: Expected,
    skip_line: Option<u64>,
}

impl DayBuilder {
    fn new(data: &Path, skip_line: Option<u64>) -> DayBuilder {
        DayBuilder { writer: RawWriter::new(data), recv_ms: NINE_AM_KST_MS, expected: Expected::default(), skip_line }
    }

    fn write(&mut self, line: &RawLine<'_>) {
        if self.skip_line != Some(self.expected.lines) {
            self.writer.write(line).unwrap();
        }
        self.expected.lines += 1;
    }

    fn tick(&mut self) -> i64 {
        self.recv_ms += 700;
        self.recv_ms
    }

    fn control_frame(&mut self, frame: &Json) {
        let recv_ms = self.tick();
        self.write(&RawLine::Frame { recv_ms, text: &frame.to_string() });
        self.expected.control += 1;
    }

    fn event(&mut self, down: bool) {
        let recv_ms = self.tick();
        self.write(&if down { RawLine::Down { recv_ms, reason: "연결 끊김" } } else { RawLine::Live { recv_ms } });
        self.expected.control += 1;
    }

    fn unfinalized_frame(&mut self, kind: &'static str, text: &str) {
        let recv_ms = self.tick();
        self.write(&RawLine::Frame { recv_ms, text });
        *self.expected.unfinalized.entry(kind).or_insert(0) += 1;
    }

    fn unfinalized_text(&mut self, text: &str) {
        let recv_ms = self.tick();
        self.write(&RawLine::Text { recv_ms, text });
        *self.expected.unfinalized.entry("non_json_text").or_insert(0) += 1;
    }

    fn real_frame(&mut self, entries: Vec<EntrySpec>, kind: Option<&'static str>) {
        let recv_ms = self.tick();
        let line = self.expected.lines;
        let data: Vec<Json> = entries
            .iter()
            .map(|entry| {
                let values: serde_json::Map<String, Json> =
                    entry.raw_values.iter().map(|(fid, text)| (fid.clone(), Json::String(text.clone()))).collect();
                json!({"type": entry.type_code, "name": "시험", "item": entry.symbol, "values": values})
            })
            .collect();
        self.write(&RawLine::Frame { recv_ms, text: &json!({"trnm": "REAL", "data": data}).to_string() });
        for (index, entry) in entries.into_iter().enumerate() {
            if !entry.symbol.is_empty() {
                *self.expected.symbol_messages.entry(entry.symbol.clone()).or_insert(0) += 1;
            }
            if entry.stored {
                self.expected.rows.push(ModelRow {
                    type_index: schema::type_index(entry.type_code).unwrap(),
                    symbol: entry.symbol,
                    recv_ms,
                    line,
                    entry: index as u32,
                    texts: entry.stored_values.into_iter().collect(),
                });
            }
        }
        match kind {
            Some(kind) => *self.expected.unfinalized.entry(kind).or_insert(0) += 1,
            None => self.expected.finalized += 1,
        }
    }

    fn finish(self) -> Expected {
        self.writer.close().unwrap();
        self.expected
    }
}

fn random_text(rng: &mut Rng, kind: ColumnKind) -> String {
    match kind {
        ColumnKind::Int => ["12345", "-9876", "+4500", " 300", "0", "", "-1", "+22000000000"][rng.below(8)].to_string(),
        ColumnKind::Float => ["-0.24", "+3.50", "12.00", "", "0.00", "-15.07", " 9.1"][rng.below(7)].to_string(),
        ColumnKind::Text => ["KRX", "NXT", "삼  성", "!!!!", "", "000000", "1", " "][rng.below(8)].to_string(),
    }
}

fn random_entry(rng: &mut Rng, type_code: &'static str, symbol: &str) -> EntrySpec {
    let realtime = &schema::types()[schema::type_index(type_code).unwrap()];
    let mut raw_values = Vec::new();
    let mut stored_values = Vec::new();
    for column in &realtime.values {
        if rng.below(100) < 15 {
            continue;
        }
        let text = random_text(rng, column.kind);
        raw_values.push((column.fid.to_string(), text.clone()));
        stored_values.push((column.fid, text));
    }
    EntrySpec { type_code, symbol: symbol.to_string(), raw_values, stored_values, stored: true }
}

fn symbol_name(index: usize) -> String {
    format!("{:06}_AL", 100_000 + index * 37)
}

fn build_day(data: &Path, skip_line: Option<u64>) -> Expected {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut day = DayBuilder::new(data, skip_line);
    day.control_frame(&json!({"trnm": "LOGIN", "return_code": 0, "return_msg": "", "sor_yn": "Y"}));
    day.control_frame(&json!({"trnm": "REG", "return_code": 0, "return_msg": ""}));
    day.event(false);
    for code in ["0J", "0U"] {
        let entry = random_entry(&mut rng, schema_code(code), "001");
        day.real_frame(vec![entry], None);
    }
    let entry = random_entry(&mut rng, "0s", "");
    day.real_frame(vec![entry], None);
    for round in 0..ROUNDS {
        let mut pending = Vec::new();
        for index in 0..SYMBOL_COUNT {
            let symbol = symbol_name(index);
            for _ in 0..2 {
                let code = STOCK_TYPES[rng.below(STOCK_TYPES.len())];
                pending.push(random_entry(&mut rng, code, &symbol));
            }
            if round == 0 {
                pending.extend(STOCK_TYPES.iter().map(|code| random_entry(&mut rng, code, &symbol)));
            }
        }
        for code in ["0J", "0U"] {
            pending.push(random_entry(&mut rng, schema_code(code), "101"));
        }
        while !pending.is_empty() {
            let count = (1 + rng.below(3)).min(pending.len());
            let entries = pending.drain(..count).collect();
            day.real_frame(entries, None);
        }
        if round == 10 {
            day.event(true);
            day.event(false);
        }
    }
    day.real_frame(vec![unknown_type_entry()], Some("unknown_realtime_type"));
    day.real_frame(vec![unknown_fid_entry()], Some("unknown_fid"));
    day.real_frame(vec![unparsable_entry()], Some("unparsable_value"));
    day.unfinalized_frame("other_frame", r#"{"return_code":0,"return_msg":"정상","stk_cd":"005930","data":[]}"#);
    day.unfinalized_frame("broken_line", r#"{"trnm":"REAL","data":["#);
    day.unfinalized_frame("malformed_realtime_frame", r#"{"trnm":"REAL","data":"oops"}"#);
    day.unfinalized_text("not json at all");
    day.finish()
}

fn schema_code(code: &str) -> &'static str {
    schema::types().iter().find(|kind| kind.code == code).map(|kind| kind.code.as_str()).unwrap()
}

fn unknown_type_entry() -> EntrySpec {
    EntrySpec {
        type_code: "ZZ",
        symbol: "ZZZ".to_string(),
        raw_values: vec![("10".to_string(), "1".to_string())],
        stored_values: Vec::new(),
        stored: false,
    }
}

fn unknown_fid_entry() -> EntrySpec {
    EntrySpec {
        type_code: "0B",
        symbol: symbol_name(0),
        raw_values: vec![("10".into(), "-500".into()), ("9999".into(), "1".into()), ("abc".into(), "x".into())],
        stored_values: vec![(10, "-500".into())],
        stored: true,
    }
}

fn unparsable_entry() -> EntrySpec {
    EntrySpec {
        type_code: "0B",
        symbol: symbol_name(1),
        raw_values: vec![("10".into(), "abc".into()), ("13".into(), "42".into())],
        stored_values: vec![(13, "42".into())],
        stored: true,
    }
}

fn options(data: &Path, threads: usize) -> Options {
    Options { data_dir: data.to_path_buf(), date: DATE, threads, buckets: 64, verify_only: false, spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES }
}

fn run(arguments: &[&str]) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_collector")).arg("finalize").args(arguments).output().unwrap();
    (output.status.code(), String::from_utf8(output.stderr).unwrap())
}

fn finalize(data: &Path, extra: &[&str]) -> (Option<i32>, String) {
    let mut arguments = vec!["--data", data.to_str().unwrap(), "--date", DATE_TEXT];
    arguments.extend_from_slice(extra);
    run(&arguments)
}

fn day_with_data() -> (TempDir, Expected) {
    let data = tempdir().unwrap();
    let expected = build_day(data.path(), None);
    (data, expected)
}

fn verify_json(data: &Path) -> Json {
    serde_json::from_slice(&fs::read(store_dir(data, DATE).join("verify.json")).unwrap()).unwrap()
}

fn expected_cell(kind: ColumnKind, text: Option<&String>) -> (Cellular, bool) {
    let Some(text) = text else { return (Cellular::Null, false) };
    match kind {
        ColumnKind::Text => (Cellular::Text(text.clone()), false),
        ColumnKind::Int if text.trim().is_empty() => (Cellular::Null, false),
        ColumnKind::Int => (Cellular::Int(text.trim().parse().unwrap()), text.starts_with('+')),
        ColumnKind::Float if text.trim().is_empty() => (Cellular::Null, false),
        ColumnKind::Float => (Cellular::Float(text.trim().parse().unwrap()), text.starts_with('+')),
    }
}

fn expected_columns(row: &ModelRow) -> BTreeMap<String, Cellular> {
    let realtime = &schema::types()[row.type_index];
    let mut cells = BTreeMap::new();
    cells.insert("symbol".to_string(), Cellular::Text(row.symbol.clone()));
    cells.insert("recv_ms".to_string(), Cellular::Int(row.recv_ms));
    for column in &realtime.values {
        let (cell, plus) = expected_cell(column.kind, row.texts.get(&column.fid));
        cells.insert(column.name.clone(), cell);
        if column.kind != ColumnKind::Text {
            cells.insert(format!("{}_plus", column.name), Cellular::Flag(plus));
        }
    }
    cells
}

fn read_type(store: &Path, code: &str) -> Vec<BTreeMap<String, Cellular>> {
    let folder = store.join(code);
    if !folder.exists() {
        return Vec::new();
    }
    let connection = Connection::open_in_memory().unwrap();
    let sql = format!(
        "SELECT * FROM read_parquet('{}/*.parquet', filename = true, file_row_number = true) ORDER BY filename, file_row_number",
        folder.display()
    );
    let mut statement = connection.prepare(&sql).unwrap();
    let mut query = statement.query([]).unwrap();
    let names: Vec<String> = query.as_ref().unwrap().column_names();
    let mut rows = Vec::new();
    while let Some(row) = query.next().unwrap() {
        let mut cells = BTreeMap::new();
        for (index, name) in names.iter().enumerate() {
            if name == "filename" || name == "file_row_number" {
                continue;
            }
            let cell = match row.get::<_, Value>(index).unwrap() {
                Value::Null => Cellular::Null,
                Value::BigInt(value) => Cellular::Int(value),
                Value::Double(value) => Cellular::Float(value),
                Value::Text(value) => Cellular::Text(value),
                Value::Boolean(value) => Cellular::Flag(value),
                other => panic!("{name}: 계약에 없는 형 {other:?}"),
            };
            cells.insert(name.clone(), cell);
        }
        rows.push(cells);
    }
    rows
}

fn sorted_expected(expected: &Expected, type_index: usize) -> Vec<&ModelRow> {
    let mut rows: Vec<&ModelRow> = expected.rows.iter().filter(|row| row.type_index == type_index).collect();
    rows.sort_by(|a, b| {
        (bucket_of(&a.symbol, 64), &a.symbol, a.recv_ms, a.line, a.entry).cmp(&(bucket_of(&b.symbol, 64), &b.symbol, b.recv_ms, b.line, b.entry))
    });
    rows
}

fn files_under(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.insert(path.strip_prefix(root).unwrap().to_string_lossy().into_owned(), fs::read(&path).unwrap());
            }
        }
    }
    files
}

#[test]
fn finalize_writes_typed_bucket_files_that_read_back_as_the_raw_frames() {
    let (data, expected) = day_with_data();
    let (code, stderr) = finalize(data.path(), &[]);
    assert_eq!(code, Some(0), "{stderr}");
    let store = store_dir(data.path(), DATE);

    for (type_index, realtime) in schema::types().iter().enumerate() {
        let want = sorted_expected(&expected, type_index);
        assert!(!want.is_empty(), "{} 합성 행이 없다", realtime.code);
        let got = read_type(&store, &realtime.code);
        assert_eq!(got.len(), want.len(), "{} 행 수", realtime.code);
        for (position, (got, want)) in got.iter().zip(&want).enumerate() {
            assert_eq!(got, &expected_columns(want), "{} {position}번 행", realtime.code);
        }
        let files: BTreeSet<String> = fs::read_dir(store.join(&realtime.code))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(files.iter().all(|name| name.len() == 11 && name.ends_with(".parquet")), "{files:?}");
        if realtime.code == "0B" {
            assert!(files.len() > 8, "버킷이 여럿 차야 한다: {files:?}");
        }
    }
    assert!(!store.join(".spill").exists());
}

#[test]
fn a_known_frame_is_stored_with_its_signs_and_blanks() {
    let data = tempdir().unwrap();
    let mut writer = RawWriter::new(data.path());
    let frame = r#"{"trnm":"REAL","data":[{"type":"0B","name":"주식체결","item":"005930_AL","values":{"20":"165208","10":"-20800","12":"+0.33","15":"+82","16":" 20850","14":"632640","851":"","9081":"NXT"}}]}"#;
    writer.write(&RawLine::Frame { recv_ms: NINE_AM_KST_MS, text: frame }).unwrap();
    writer.close().unwrap();
    assert_eq!(finalize(data.path(), &[]).0, Some(0));

    let rows = read_type(&store_dir(data.path(), DATE), "0B");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row["symbol"], Cellular::Text("005930_AL".into()));
    assert_eq!(row["recv_ms"], Cellular::Int(NINE_AM_KST_MS));
    assert_eq!(row["f20"], Cellular::Text("165208".into()));
    assert_eq!((&row["f10"], &row["f10_plus"]), (&Cellular::Int(-20800), &Cellular::Flag(false)));
    assert_eq!((&row["f12"], &row["f12_plus"]), (&Cellular::Float(0.33), &Cellular::Flag(true)));
    assert_eq!((&row["f15"], &row["f15_plus"]), (&Cellular::Int(82), &Cellular::Flag(true)));
    assert_eq!((&row["f16"], &row["f16_plus"]), (&Cellular::Int(20850), &Cellular::Flag(false)));
    assert_eq!(row["f851"], Cellular::Null);
    assert_eq!(row["f9081"], Cellular::Text("NXT".into()));
    assert_eq!(row["f13"], Cellular::Null);
}

#[test]
fn odd_raw_shapes_are_stored_exactly_or_counted_as_unfinalized() {
    let data = tempdir().unwrap();
    fs::create_dir_all(data.path().join("store")).unwrap();
    fs::write(temporary_store_dir(data.path(), DATE), "a stale file").unwrap();
    let frames = [
        r#"{"trnm":"REAL","data":[{"type":"0B","item":"A_AL","values":{"+10":"111","010":"333","11":"5"}}]}"#,
        r#"{"trnm":"REAL","data":[{"type":"0B","item":"B_AL","values":{"10":"444","10":"555"}}]}"#,
        r#"{"trnm":"REAL","data":[{"type":"0B","item":"G1_AL","values":{"11":"1"}},{"type":"0B","item":5930,"values":{}},{"type":"0B","item":"G2_AL","values":{"11":"2"}}]}"#,
        r#"{"trnm":"REAL","data":[{"type":"0B","item":"N_AL","values":{"20":1.50,"9081":1e2,"13":12345,"12":-0.0}}]}"#,
        r#"{"trnm":"REAL","data":[{"type":"0B","item":"P_AL","values":{"15":" +82","16":"+7","14":"-0"}}]}"#,
        r#"{"trnm":"REAL","data":[{"type":"0B","item":"W_AL","values":[]}]}"#,
    ];
    let mut writer = RawWriter::new(data.path());
    for (index, text) in frames.iter().enumerate() {
        writer.write(&RawLine::Frame { recv_ms: NINE_AM_KST_MS + index as i64, text }).unwrap();
    }
    writer.close().unwrap();
    assert_eq!(finalize(data.path(), &[]).0, Some(0));

    let verify = verify_json(data.path());
    assert_eq!(verify["lines"]["finalized"], json!(2));
    assert_eq!(verify["lines"]["unfinalized"]["kinds"]["unknown_fid"], json!(1));
    assert_eq!(verify["lines"]["unfinalized"]["kinds"]["unparsable_value"], json!(1));
    assert_eq!(verify["lines"]["unfinalized"]["kinds"]["malformed_realtime_frame"], json!(2));
    assert_eq!(verify["unknown_fids"], json!({"0B": {"+10": 1, "010": 1}}));
    assert_eq!(verify["unparsable_values"], json!({"0B": {"10": 1}}));
    let messages: BTreeMap<String, u64> = serde_json::from_value(verify["symbol_messages"].clone()).unwrap();
    assert_eq!(messages.keys().map(String::as_str).collect::<Vec<_>>(), ["A_AL", "B_AL", "G1_AL", "G2_AL", "N_AL", "P_AL", "W_AL"]);

    let rows = read_type(&store_dir(data.path(), DATE), "0B");
    let by_symbol: BTreeMap<String, &BTreeMap<String, Cellular>> = rows
        .iter()
        .map(|row| match &row["symbol"] {
            Cellular::Text(symbol) => (symbol.clone(), row),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(by_symbol.keys().map(String::as_str).collect::<Vec<_>>(), ["A_AL", "B_AL", "G1_AL", "G2_AL", "N_AL", "P_AL"]);
    assert_eq!(by_symbol["A_AL"]["f10"], Cellular::Null);
    assert_eq!(by_symbol["A_AL"]["f11"], Cellular::Int(5));
    assert_eq!(by_symbol["G1_AL"]["f11"], Cellular::Int(1));
    assert_eq!(by_symbol["N_AL"]["f20"], Cellular::Text("1.50".into()));
    assert_eq!(by_symbol["N_AL"]["f9081"], Cellular::Text("1e2".into()));
    assert_eq!(by_symbol["N_AL"]["f13"], Cellular::Int(12345));
    assert_eq!((&by_symbol["P_AL"]["f15"], &by_symbol["P_AL"]["f15_plus"]), (&Cellular::Int(82), &Cellular::Flag(false)));
    assert_eq!((&by_symbol["P_AL"]["f16"], &by_symbol["P_AL"]["f16_plus"]), (&Cellular::Int(7), &Cellular::Flag(true)));
    assert_eq!(by_symbol["P_AL"]["f14"], Cellular::Int(0));
}

#[test]
fn merge_thread_count_does_not_change_the_result() {
    let (single, _) = day_with_data();
    let (quad, _) = day_with_data();
    assert_eq!(finalize(single.path(), &["--threads", "1"]).0, Some(0));
    assert_eq!(finalize(quad.path(), &["--threads", "4"]).0, Some(0));
    let (one, four) = (files_under(&store_dir(single.path(), DATE)), files_under(&store_dir(quad.path(), DATE)));
    assert_eq!(one.keys().collect::<Vec<_>>(), four.keys().collect::<Vec<_>>());
    for (name, bytes) in &one {
        assert!(bytes == &four[name], "{name}이 다르다");
    }
}

#[test]
fn verify_json_counts_every_kind_of_raw_line() {
    let (data, expected) = day_with_data();
    assert_eq!(finalize(data.path(), &[]).0, Some(0));
    let verify = verify_json(data.path());

    assert_eq!(verify["passed"], json!(true));
    assert_eq!(verify["format_version"], json!(1));
    assert_eq!(verify["lines"]["finalized"], json!(expected.finalized));
    assert_eq!(verify["lines"]["control"], json!(expected.control));
    let unfinalized_total: u64 = expected.unfinalized.values().sum();
    assert_eq!(verify["lines"]["unfinalized"]["total"], json!(unfinalized_total));
    for (kind, count) in &expected.unfinalized {
        assert_eq!(verify["lines"]["unfinalized"]["kinds"][*kind], json!(count), "{kind}");
    }
    assert_eq!(verify["lines"]["unfinalized"]["kinds"]["truncated_file"], json!(0));
    assert_eq!(verify["lines"]["total"], json!(expected.lines));
    assert_eq!(expected.unfinalized.len(), 7);

    assert_eq!(verify["unknown_realtime_types"], json!({"ZZ": 1}));
    assert_eq!(verify["unknown_fids"], json!({"0B": {"9999": 1, "abc": 1}}));
    assert_eq!(verify["unparsable_values"], json!({"0B": {"10": 1}}));

    let messages: BTreeMap<String, u64> = serde_json::from_value(verify["symbol_messages"].clone()).unwrap();
    assert_eq!(messages, expected.symbol_messages);

    for (type_index, realtime) in schema::types().iter().enumerate() {
        let mut per_symbol: BTreeMap<&str, (u64, i64, i64)> = BTreeMap::new();
        for row in expected.rows.iter().filter(|row| row.type_index == type_index) {
            let stat = per_symbol.entry(&row.symbol).or_insert((0, i64::MAX, i64::MIN));
            *stat = (stat.0 + 1, stat.1.min(row.recv_ms), stat.2.max(row.recv_ms));
        }
        let listed = verify["rows"][&realtime.code].as_object().unwrap();
        assert_eq!(listed.len(), per_symbol.len(), "{}", realtime.code);
        for (symbol, (rows, first, last)) in per_symbol {
            assert_eq!(listed[symbol], json!({"rows": rows, "first_recv_ms": first, "last_recv_ms": last}), "{} {symbol}", realtime.code);
        }
    }
    assert_eq!(verify["mismatch_count"], json!(0));
}

#[test]
fn a_comparison_against_a_raw_day_with_one_more_line_fails() {
    let (full, _) = day_with_data();
    let reduced = tempdir().unwrap();
    build_day(reduced.path(), Some(200));

    let full_tally = tally_day(&options(full.path(), 4)).unwrap();
    let written = write_store(&options(reduced.path(), 4)).unwrap();
    let report = verify_store(&written.store_dir, DATE, 64, 4, &full_tally).unwrap();
    assert!(!report.passed);
    assert!(report.mismatch_count >= 1);
    assert!(written.store_dir.join("verify.json").exists());
    let listed = &report.mismatches[0];
    assert_eq!(listed.kind, "rows");
    assert!(listed.raw.as_ref().unwrap().rows > listed.parquet.as_ref().map_or(0, |stat| stat.rows));
}

#[test]
fn verify_only_exits_non_zero_when_the_parquet_lacks_a_raw_line() {
    let (full, _) = day_with_data();
    let reduced = tempdir().unwrap();
    build_day(reduced.path(), Some(200));
    assert_eq!(finalize(reduced.path(), &[]).0, Some(0));
    assert_eq!(finalize(reduced.path(), &["--verify-only"]).0, Some(0));

    let raw_day = |data: &Path| data.join("raw").join(DATE_TEXT);
    for entry in fs::read_dir(raw_day(full.path())).unwrap() {
        let path = entry.unwrap().path();
        fs::copy(&path, raw_day(reduced.path()).join(path.file_name().unwrap())).unwrap();
    }
    let (code, stderr) = finalize(reduced.path(), &["--verify-only"]);
    assert_eq!(code, Some(1), "{stderr}");
    assert!(stderr.contains("verify.json"), "{stderr}");
    assert_eq!(verify_json(reduced.path())["passed"], json!(false));
}

#[test]
fn verify_only_reads_the_bucket_count_from_the_files_and_needs_a_finished_store() {
    let (data, _) = day_with_data();
    assert_eq!(finalize(data.path(), &["--verify-only"]).0, Some(1));
    assert!(!temporary_store_dir(data.path(), DATE).exists());

    assert_eq!(finalize(data.path(), &["--buckets", "16"]).0, Some(0));
    assert_eq!(verify_json(data.path())["buckets"], json!(16));
    let (code, stderr) = finalize(data.path(), &["--verify-only"]);
    assert_eq!(code, Some(0), "{stderr}");
    assert_eq!(verify_json(data.path())["buckets"], json!(16));
}

#[test]
fn an_existing_finished_folder_is_replaced_and_a_stale_temporary_folder_is_rewritten() {
    let (data, _) = day_with_data();
    let finished = store_dir(data.path(), DATE);
    fs::create_dir_all(&finished).unwrap();
    fs::write(finished.join("complete.json"), "{\"sentinel\":true}").unwrap();
    let temporary = temporary_store_dir(data.path(), DATE);
    fs::create_dir_all(temporary.join("0B")).unwrap();
    fs::write(temporary.join("0B").join("999.parquet"), "stale").unwrap();
    fs::write(temporary.join("stale.txt"), "stale").unwrap();

    assert_eq!(finalize(data.path(), &[]).0, Some(0));

    assert!(!temporary.exists());
    assert!(files_under(&finished).contains_key("verify.json"));
    assert!(!files_under(&finished).contains_key("0B/999.parquet"));
    assert_ne!(fs::read(finished.join("complete.json")).unwrap(), b"{\"sentinel\":true}");
    let leftovers: Vec<String> = fs::read_dir(data.path().join("store")).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(leftovers, [DATE_TEXT]);
}

#[test]
fn the_real_recorded_day_finalizes_without_leftovers() {
    let data = tempdir().unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/raw/20260720");
    let raw = data.path().join("raw/20260720");
    fs::create_dir_all(&raw).unwrap();
    for entry in fs::read_dir(&source).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|extension| extension == "zst") {
            fs::copy(&path, raw.join(path.file_name().unwrap())).unwrap();
        }
    }
    let output = Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["finalize", "--data", data.path().to_str().unwrap(), "--date", "20260720"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
    let verify: Json = serde_json::from_slice(&fs::read(data.path().join("store/20260720/verify.json")).unwrap()).unwrap();
    assert_eq!(verify["passed"], json!(true));
    let kinds = verify["lines"]["unfinalized"]["kinds"].as_object().unwrap();
    let unfinalized: Vec<(&String, &Json)> = kinds.iter().filter(|(kind, count)| **count != json!(0) && !kind.ends_with("_file")).collect();
    assert!(unfinalized.is_empty() || unfinalized.iter().all(|(kind, _)| *kind == "broken_line"), "{unfinalized:?}");
    assert!(verify["lines"]["finalized"].as_u64().unwrap() > 0);
    for code in ["0B", "0D", "0w", "0F"] {
        assert!(!verify["rows"][code].as_object().unwrap().is_empty(), "{code}");
    }
}

#[test]
fn arguments_are_checked() {
    assert_eq!(run(&["--data", "somewhere"]).0, Some(2));
    assert_eq!(run(&["--data", "somewhere", "--date", "2026"]).0, Some(2));
    assert_eq!(run(&["--data", "somewhere", "--date", DATE_TEXT, "--threads", "0"]).0, Some(2));
    assert_eq!(run(&["--data", "somewhere", "--date", DATE_TEXT, "--buckets", "1000"]).0, Some(2));
    assert_eq!(run(&["--data", "somewhere", "--date", DATE_TEXT, "--nope"]).0, Some(2));
    assert_eq!(run(&["--data", "somewhere", "--date", DATE_TEXT]).0, Some(1));
}

#[test]
fn bucket_hash_is_the_documented_fnv_1a() {
    assert_eq!(bucket_of("005930_AL", 64), 56);
    assert_eq!(bucket_of("000660_AL", 64), 59);
    assert_eq!(bucket_of("", 64), 37);
    assert_eq!(bucket_of("005930_AL", 1), 0);
}

#[test]
fn the_format_document_lists_exactly_the_columns_in_the_code() {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/collector-store-format.md");
    let document = fs::read_to_string(path).unwrap();
    let kind_name = |kind: ColumnKind| match kind {
        ColumnKind::Int => "정수",
        ColumnKind::Float => "실수",
        ColumnKind::Text => "문자",
    };
    for realtime in schema::types() {
        let heading = format!("### {} {}\n", realtime.code, realtime.korean_name);
        let start = document.find(&heading).unwrap_or_else(|| panic!("문서에 {heading:?}가 없다"));
        let section = &document[start + heading.len()..];
        let section = &section[..section.find("\n### ").unwrap_or(section.len())];
        let documented: Vec<(String, String, String)> = section
            .lines()
            .filter(|line| line.starts_with("| `f"))
            .map(|line| {
                let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
                (cells[0].trim_matches('`').to_string(), cells[1].to_string(), cells[3].to_string())
            })
            .collect();
        let in_code: Vec<(String, String, String)> = realtime
            .values
            .iter()
            .map(|column| (column.name.clone(), kind_name(column.kind).to_string(), column.korean_name.clone()))
            .collect();
        assert_eq!(documented, in_code, "{}", realtime.code);
    }
}

#[test]
fn flushing_the_spill_many_times_gives_the_same_files() {
    let (data, _) = day_with_data();
    let whole = options(data.path(), 4);
    let written = write_store(&whole).unwrap();
    let verify = verify_store(&written.store_dir, DATE, 64, 4, &written.tally).unwrap();
    assert!(verify.passed);
    let once = files_under(&written.store_dir);

    let tiny = Options { spill_budget_bytes: 2_000, ..options(data.path(), 4) };
    let written = write_store(&tiny).unwrap();
    assert!(verify_store(&written.store_dir, DATE, 64, 4, &written.tally).unwrap().passed);
    let many = files_under(&written.store_dir);
    assert_eq!(once.keys().collect::<Vec<_>>(), many.keys().collect::<Vec<_>>());
    for (name, bytes) in &once {
        assert!(bytes == &many[name], "{name}이 다르다");
    }
}

#[test]
fn rows_with_the_same_symbol_and_time_keep_their_raw_order_for_any_thread_count() {
    let build = |threads: &str| {
        let data = tempdir().unwrap();
        let mut writer = RawWriter::new(data.path());
        for index in 0..6_000 {
            let frame = format!(
                r#"{{"trnm":"REAL","data":[{{"type":"0B","item":"T_AL","values":{{"15":"{index}"}}}},{{"type":"0B","item":"T_AL","values":{{"15":"-{index}"}}}}]}}"#
            );
            writer.write(&RawLine::Frame { recv_ms: NINE_AM_KST_MS, text: &frame }).unwrap();
        }
        writer.close().unwrap();
        assert_eq!(finalize(data.path(), &["--threads", threads]).0, Some(0));
        read_type(&store_dir(data.path(), DATE), "0B")
    };
    let single = build("1");
    assert_eq!(single, build("8"));
    let quantities: Vec<Cellular> = single.iter().map(|row| row["f15"].clone()).collect();
    let wanted: Vec<Cellular> = (0..6_000).flat_map(|index| [Cellular::Int(index), Cellular::Int(-index)]).collect();
    assert_eq!(quantities, wanted);
}
