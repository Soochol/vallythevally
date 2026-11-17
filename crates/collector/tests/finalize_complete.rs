use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::Command;

use collector::calendar::Day;
use collector::finalize::{
    DEFAULT_SPILL_BUDGET_BYTES, Options, finalize_day, publish_store, recover_interrupted_swap, seal_day, store_dir, tally_day, temporary_store_dir,
    verify_store, write_store,
};
use collector::keys::KeyRole;
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile, write_plan};
use collector::protocol::KeyName;
use collector::raw_write::{RawLine, RawWriter};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const DATE: u32 = 20_261_117;
const DATE_TEXT: &str = "20261117";
const EXTRA_STOCKS: usize = 51;

fn base_ms() -> i64 {
    Day::from_yyyymmdd(DATE).unwrap().unix_ms_at_kst(9, 0)
}

fn options(data: &Path) -> Options {
    Options { data_dir: data.to_path_buf(), date: DATE, threads: 2, buckets: 16, verify_only: false, spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES }
}

fn key(name: &str) -> KeyName {
    KeyName::parse(name).unwrap()
}

fn extra_code(index: usize) -> String {
    format!("{:06}", 200_000 + index)
}

fn real(code: &str) -> String {
    json!({"trnm": "REAL", "data": [{"type": "0B", "item": format!("{code}_AL"), "values": {"10": "100"}}]}).to_string()
}

struct KeyDay {
    writer: RawWriter,
}

impl KeyDay {
    fn new(data: &Path, name: &str) -> KeyDay {
        KeyDay { writer: RawWriter::for_key(data, key(name)) }
    }

    fn frame(&mut self, offset_ms: i64, text: &str) {
        self.writer.write(&RawLine::Frame { recv_ms: base_ms() + offset_ms, text }).unwrap();
    }

    fn real(&mut self, offset_ms: i64, code: &str) {
        self.frame(offset_ms, &real(code));
    }

    fn live(&mut self, offset_ms: i64) {
        self.writer.write(&RawLine::Live { recv_ms: base_ms() + offset_ms }).unwrap();
    }

    fn down(&mut self, offset_ms: i64) {
        self.writer.write(&RawLine::Down { recv_ms: base_ms() + offset_ms, reason: "연결 끊김" }).unwrap();
    }

    fn login_and_registration(&mut self) {
        self.frame(0, &json!({"trnm": "LOGIN", "return_code": 0}).to_string());
        self.frame(100, &json!({"trnm": "REG", "return_code": 0}).to_string());
        self.live(200);
    }

    fn close(self) {
        self.writer.close().unwrap();
    }
}

fn share(name: &str, role: KeyRole, stocks: Vec<String>, market_types: bool) -> KeyShare {
    KeyShare {
        name: key(name),
        role,
        app_key_hash: format!("hash-{name}"),
        stocks,
        market_types: if market_types { MARKET_TYPES.to_vec() } else { Vec::new() },
        rest_jobs: Vec::new(),
        load: 0,
    }
}

fn write_day_plan(data: &Path) {
    let plan = PlanFile {
        format_version: 1,
        date: DATE,
        created_at: "2026-11-17T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: 4, universe_replaced: None },
        keys: vec![
            share("collect-01", KeyRole::Collecting, ["000010", "000020", "000030", "000040"].map(String::from).to_vec(), true),
            share("collect-02", KeyRole::Collecting, ["000050", "000060"].map(String::from).to_vec(), false),
            share("collect-03", KeyRole::Collecting, (0..EXTRA_STOCKS).map(extra_code).collect(), false),
            share("spare-01", KeyRole::Spare, Vec::new(), false),
        ],
        excluded: vec!["300001".to_owned()],
        unregistered: vec!["300002".to_owned()],
        alerts: vec!["시험 경보".to_owned()],
    };
    write_plan(data, &plan).unwrap();
}

fn write_journal(data: &Path) {
    let lines = [
        json!({"v": 1, "at": "2026-11-17T09:00:06+09:00", "event": "key_stopped", "key": "collect-02", "reason": "재시작 한도"}),
        json!({"v": 1, "at": "2026-11-17T09:00:06+09:00", "event": "handoff", "from": "collect-02", "to": "spare-01", "stocks": ["000050", "000060"], "market_types": []}),
        json!({"v": 1, "at": "2026-11-17T09:00:07+09:00", "event": "register_failed", "key": "collect-03", "id": "collect-03-stocks", "part": 1, "parts": 2, "items": 1, "reason": "거절", "return_code": 1, "detail": null}),
        json!({"v": 1, "at": "2026-11-17T09:00:07+09:00", "event": "register_failed", "key": "collect-01", "id": "collect-01-market-0J", "part": 0, "parts": 1, "items": 1, "reason": "거절", "return_code": 1, "detail": null}),
    ];
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(data.join("plan").join(format!("{DATE}.events.jsonl")), text).unwrap();
}

fn write_day_raw(data: &Path) {
    let mut first = KeyDay::new(data, "collect-01");
    first.login_and_registration();
    for offset in [1000, 2000, 3000] {
        first.real(offset, "000010");
    }
    for offset in [1500, 2500] {
        first.real(offset, "000020");
    }
    first.real(1800, "000040");
    first.real(3500, "999999");
    first.down(4000);
    first.live(9000);
    first.real(9500, "000010");
    first.close();

    let mut second = KeyDay::new(data, "collect-02");
    second.login_and_registration();
    for offset in [1000, 2000, 5000] {
        second.real(offset, "000050");
    }
    second.real(1200, "000060");
    second.close();

    let mut spare = KeyDay::new(data, "spare-01");
    spare.login_and_registration();
    spare.live(8000);
    for offset in [8500, 9000] {
        spare.real(offset, "000050");
    }
    spare.real(8600, "000060");
    spare.close();
}

fn day_with_plan() -> TempDir {
    let data = tempdir().unwrap();
    write_day_plan(data.path());
    write_journal(data.path());
    write_day_raw(data.path());
    data
}

fn complete_json(data: &Path) -> Value {
    serde_json::from_slice(&fs::read(store_dir(data, DATE).join("complete.json")).unwrap()).unwrap()
}

fn stock(complete: &Value, code: &str) -> Value {
    complete["stocks"].as_array().unwrap().iter().find(|stock| stock["code"] == code).unwrap_or_else(|| panic!("{code}가 없다")).clone()
}

fn store_entries(data: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(data.join("store")).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn some_parquet(folder: &Path) -> PathBuf {
    let mut pending = vec![folder.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in fs::read_dir(next).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|extension| extension == "parquet") {
                return path;
            }
        }
    }
    panic!("Parquet 파일이 없다");
}

fn rows_of(file: File) -> usize {
    ParquetRecordBatchReaderBuilder::try_new(file).unwrap().build().unwrap().map(|batch| batch.unwrap().num_rows()).sum()
}

#[test]
fn coverage_is_written_per_stock() {
    let data = day_with_plan();
    let report = finalize_day(&options(data.path())).unwrap();
    assert!(report.passed);
    let complete = complete_json(data.path());

    assert_eq!(complete["format_version"], json!(1));
    assert_eq!(complete["date"], json!(DATE));
    assert_eq!(complete["verify"]["passed"], json!(true));
    assert_eq!(complete["plan"]["active_keys"], json!(4));
    assert_eq!(complete["plan"]["planned_stocks"], json!(4 + 2 + EXTRA_STOCKS + 2));
    assert_eq!(complete["plan"]["alerts"], json!(["시험 경보"]));

    let outage = json!([{"from_ms": base_ms() + 4000, "to_ms": base_ms() + 9000}]);
    let first = stock(&complete, "000010");
    assert_eq!(first["messages"], json!(4));
    assert_eq!(first["planned"], json!(true));
    assert_eq!(first["key"], json!("collect-01"));
    assert_eq!(first["registered"], json!(true));
    assert_eq!(first["received"], json!(true));
    assert_eq!(first["gaps"], outage);
    assert_eq!(stock(&complete, "000020")["messages"], json!(2));
    assert_eq!(stock(&complete, "000040")["messages"], json!(1));

    let silent = stock(&complete, "000030");
    assert_eq!((silent["received"].clone(), silent["messages"].clone(), silent["registered"].clone()), (json!(false), json!(0), json!(true)));
    assert_eq!(silent["gaps"], outage);

    let excluded = stock(&complete, "300001");
    assert_eq!((excluded["planned"].clone(), excluded["excluded"].clone(), excluded["registered"].clone(), excluded["key"].clone()), (json!(true), json!(true), json!(false), Value::Null));
    let suspended = stock(&complete, "300002");
    assert_eq!((suspended["suspended"].clone(), suspended["excluded"].clone(), suspended["registered"].clone()), (json!(true), json!(false), json!(false)));

    let unplanned = stock(&complete, "999999");
    assert_eq!((unplanned["planned"].clone(), unplanned["received"].clone(), unplanned["messages"].clone()), (json!(false), json!(true), json!(1)));
}

#[test]
fn a_rejected_registration_batch_marks_only_the_stocks_in_that_batch() {
    let data = day_with_plan();
    finalize_day(&options(data.path())).unwrap();
    let complete = complete_json(data.path());
    let unregistered: Vec<String> = complete["stocks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|stock| stock["planned"] == json!(true) && stock["excluded"] == json!(false) && stock["suspended"] == json!(false) && stock["registered"] == json!(false))
        .map(|stock| stock["code"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(unregistered, [extra_code(EXTRA_STOCKS - 1)]);
}

#[test]
fn a_handed_off_stock_joins_the_raw_of_both_key_folders_and_the_wait_between_is_a_gap() {
    let data = day_with_plan();
    finalize_day(&options(data.path())).unwrap();
    let complete = complete_json(data.path());
    let handoff_gap = json!([{"from_ms": base_ms() + 5000, "to_ms": base_ms() + 8000}]);

    let first = stock(&complete, "000050");
    assert_eq!(first["messages"], json!(5));
    assert_eq!(first["handoff"], json!({"at": "2026-11-17T09:00:06+09:00", "from": "collect-02", "to": "spare-01"}));
    assert_eq!(first["gaps"], handoff_gap);
    let second = stock(&complete, "000060");
    assert_eq!(second["messages"], json!(2));
    assert_eq!(second["gaps"], handoff_gap);
    assert_eq!(stock(&complete, "000010")["handoff"], Value::Null);
}

#[test]
fn a_day_without_a_plan_lists_only_what_arrived() {
    let data = tempdir().unwrap();
    let mut flat = RawWriter::new(data.path());
    for (offset, code) in [(1000, "000010"), (2000, "000010"), (3000, "000020")] {
        flat.write(&RawLine::Frame { recv_ms: base_ms() + offset, text: &real(code) }).unwrap();
    }
    flat.close().unwrap();
    finalize_day(&options(data.path())).unwrap();
    let complete = complete_json(data.path());
    assert_eq!(complete["plan"], Value::Null);
    let codes: Vec<&str> = complete["stocks"].as_array().unwrap().iter().map(|stock| stock["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["000010", "000020"]);
    assert_eq!(stock(&complete, "000010")["messages"], json!(2));
    assert_eq!(stock(&complete, "000010")["planned"], json!(false));
}

#[test]
fn the_first_finalize_publishes_the_day_with_the_completion_marker_and_leaves_no_temporary_folder() {
    let data = day_with_plan();
    let output = Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["finalize", "--data", data.path().to_str().unwrap(), "--date", DATE_TEXT])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(store_entries(data.path()), [DATE_TEXT]);
    assert!(store_dir(data.path(), DATE).join("complete.json").is_file());
    assert!(store_dir(data.path(), DATE).join("verify.json").is_file());
}

#[test]
fn finalizing_again_swaps_the_folder_and_an_open_old_file_still_reads_to_the_end() {
    let data = day_with_plan();
    finalize_day(&options(data.path())).unwrap();
    let old_file = some_parquet(&store_dir(data.path(), DATE));
    let expected_rows = rows_of(File::open(&old_file).unwrap());
    let held = File::open(&old_file).unwrap();
    let before = complete_json(data.path());

    let mut more = KeyDay::new(data.path(), "collect-09");
    more.real(20_000, "000010");
    more.close();
    finalize_day(&options(data.path())).unwrap();

    assert_eq!(stock(&complete_json(data.path()), "000010")["messages"], json!(stock(&before, "000010")["messages"].as_u64().unwrap() + 1));
    assert_eq!(rows_of(held), expected_rows);
    assert_eq!(store_entries(data.path()), [DATE_TEXT]);
}

#[test]
fn a_run_interrupted_between_the_two_renames_is_repaired_by_the_next_run() {
    let data = day_with_plan();
    finalize_day(&options(data.path())).unwrap();
    let published = store_dir(data.path(), DATE);
    let replaced = data.path().join("store").join(format!("{DATE_TEXT}.old-1700000000000"));
    fs::rename(&published, &replaced).unwrap();
    let temporary = temporary_store_dir(data.path(), DATE);
    fs::create_dir_all(temporary.join("0B")).unwrap();
    fs::write(temporary.join("0B").join("000.parquet"), "half written").unwrap();

    finalize_day(&options(data.path())).unwrap();

    assert_eq!(store_entries(data.path()), [DATE_TEXT]);
    assert!(published.join("complete.json").is_file());
}

#[test]
fn recovery_restores_the_old_folder_when_the_new_one_was_not_finished() {
    let data = tempdir().unwrap();
    let replaced = data.path().join("store").join(format!("{DATE_TEXT}.old-1"));
    fs::create_dir_all(&replaced).unwrap();
    fs::write(replaced.join("complete.json"), "old").unwrap();
    let temporary = temporary_store_dir(data.path(), DATE);
    fs::create_dir_all(&temporary).unwrap();
    fs::write(temporary.join("verify.json"), "half").unwrap();

    recover_interrupted_swap(data.path(), DATE).unwrap();

    assert_eq!(fs::read(store_dir(data.path(), DATE).join("complete.json")).unwrap(), b"old");
    assert_eq!(store_entries(data.path()), [DATE_TEXT, format!("{DATE_TEXT}.tmp").as_str()]);
}

#[test]
fn recovery_promotes_a_finished_temporary_folder_and_drops_the_old_one() {
    let data = tempdir().unwrap();
    let replaced = data.path().join("store").join(format!("{DATE_TEXT}.old-1"));
    fs::create_dir_all(&replaced).unwrap();
    fs::write(replaced.join("complete.json"), "old").unwrap();
    let temporary = temporary_store_dir(data.path(), DATE);
    fs::create_dir_all(&temporary).unwrap();
    fs::write(temporary.join("complete.json"), "new").unwrap();

    recover_interrupted_swap(data.path(), DATE).unwrap();

    assert_eq!(fs::read(store_dir(data.path(), DATE).join("complete.json")).unwrap(), b"new");
    assert_eq!(store_entries(data.path()), [DATE_TEXT]);
}

#[test]
fn recovery_drops_an_old_folder_left_after_the_second_rename() {
    let data = tempdir().unwrap();
    fs::create_dir_all(store_dir(data.path(), DATE)).unwrap();
    fs::create_dir_all(data.path().join("store").join(format!("{DATE_TEXT}.old-1"))).unwrap();

    recover_interrupted_swap(data.path(), DATE).unwrap();

    assert_eq!(store_entries(data.path()), [DATE_TEXT]);
}

#[test]
fn a_failed_comparison_writes_no_completion_marker_and_keeps_the_temporary_folder() {
    let full = day_with_plan();
    let reduced = tempdir().unwrap();
    write_day_plan(reduced.path());
    let mut only = KeyDay::new(reduced.path(), "collect-01");
    only.login_and_registration();
    only.real(1000, "000010");
    only.close();

    let full_tally = tally_day(&options(full.path())).unwrap();
    let written = write_store(&options(reduced.path())).unwrap();
    let report = verify_store(&written.store_dir, DATE, 16, 2, &full_tally).unwrap();
    assert!(!report.passed);

    assert!(!seal_day(&options(reduced.path()), &report).unwrap());
    assert!(temporary_store_dir(reduced.path(), DATE).is_dir());
    assert!(!temporary_store_dir(reduced.path(), DATE).join("complete.json").exists());
    assert!(!store_dir(reduced.path(), DATE).exists());
}

#[test]
fn publishing_needs_a_temporary_folder() {
    let data = tempdir().unwrap();
    fs::create_dir_all(data.path().join("store")).unwrap();
    assert!(publish_store(data.path(), DATE).is_err());
}

fn write_events(data: &Path, lines: &[Value]) {
    fs::create_dir_all(data.join("plan")).unwrap();
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(data.join("plan").join(format!("{DATE}.events.jsonl")), text).unwrap();
}

#[test]
fn a_spare_that_was_already_live_resumes_at_its_registration_answer() {
    let data = tempdir().unwrap();
    write_events(
        data.path(),
        &[json!({"v": 1, "at": "2026-11-17T09:00:06+09:00", "event": "handoff", "from": "collect-02", "to": "spare-01", "stocks": ["000050"], "market_types": []})],
    );
    let mut stopped = KeyDay::new(data.path(), "collect-02");
    stopped.login_and_registration();
    stopped.real(1000, "000050");
    stopped.real(5000, "000050");
    stopped.close();
    let mut spare = KeyDay::new(data.path(), "spare-01");
    spare.login_and_registration();
    spare.frame(6400, &json!({"trnm": "REG", "return_code": 0}).to_string());
    spare.real(6500, "000050");
    spare.real(30_000, "000050");
    spare.close();

    finalize_day(&options(data.path())).unwrap();

    assert_eq!(stock(&complete_json(data.path()), "000050")["gaps"], json!([{"from_ms": base_ms() + 5000, "to_ms": base_ms() + 6400}]));
}

#[test]
fn an_outage_that_never_ended_lasts_until_the_last_line_of_the_day() {
    let data = tempdir().unwrap();
    let mut down = KeyDay::new(data.path(), "collect-01");
    down.login_and_registration();
    down.real(1000, "000010");
    down.down(4000);
    down.close();
    let mut other = KeyDay::new(data.path(), "collect-02");
    other.login_and_registration();
    other.real(50_000, "000020");
    other.close();
    write_day_plan_for(data.path(), ["000010"], ["000020"]);

    finalize_day(&options(data.path())).unwrap();

    assert_eq!(stock(&complete_json(data.path()), "000010")["gaps"], json!([{"from_ms": base_ms() + 4000, "to_ms": base_ms() + 50_000}]));
    assert_eq!(stock(&complete_json(data.path()), "000020")["gaps"], json!([]));
}

fn write_day_plan_for<const A: usize, const B: usize>(data: &Path, first: [&str; A], second: [&str; B]) {
    let plan = PlanFile {
        format_version: 1,
        date: DATE,
        created_at: "2026-11-17T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: 2, universe_replaced: None },
        keys: vec![
            share("collect-01", KeyRole::Collecting, first.map(String::from).to_vec(), true),
            share("collect-02", KeyRole::Collecting, second.map(String::from).to_vec(), false),
        ],
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    };
    write_plan(data, &plan).unwrap();
}
