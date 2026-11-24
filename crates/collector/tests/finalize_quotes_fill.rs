use std::fs;
use std::path::Path;
use std::process::ExitCode;

use collector::calendar::Day;
use collector::finalize::{self, store_dir};
use collector::keys::KeyRole;
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile, write_plan};
use collector::protocol::KeyName;
use collector::raw_write::{RawLine, RawWriter};
use serde_json::{Map, json};
use server::shared_data::{closed_day_dir, live_day_dir, read_quote_day};
use tempfile::tempdir;

const BROKEN: u32 = 20_261_118;
const FAILED_VERIFY: u32 = 20_261_115;
const WRONG_VERSION: u32 = 20_261_116;
const MISSING_STOCKS: u32 = 20_261_117;
const EARLIER: u32 = 20_261_120;
const TODAY: u32 = 20_261_124;
const CODE: &str = "000010";

fn at_ms(date: u32, hour: u32, minute: u32, second: i64) -> i64 {
    Day::from_yyyymmdd(date).unwrap().unix_ms_at_kst(hour, minute) + second * 1000
}

fn quote_frame_for_item(item: &str, time: &str, ask_base: i64) -> String {
    let mut values = Map::new();
    values.insert("21".to_owned(), json!(time));
    for index in 0..4 {
        let ask = ask_base + index as i64 * 100;
        let bid = ask_base - 200 - index as i64 * 100;
        values.insert((41 + index).to_string(), json!(format!("+{ask}")));
        values.insert((51 + index).to_string(), json!(format!("-{bid}")));
        values.insert((61 + index).to_string(), json!("10"));
        values.insert((71 + index).to_string(), json!("10"));
        values.insert((6044 + index).to_string(), json!("6"));
        values.insert((6054 + index).to_string(), json!("6"));
        values.insert((6066 + index).to_string(), json!("4"));
        values.insert((6076 + index).to_string(), json!("4"));
    }
    json!({"trnm": "REAL", "data": [{"type": "0D", "item": item, "values": values}]}).to_string()
}

fn quote_frame(code: &str, time: &str) -> String {
    quote_frame_for_item(&format!("{code}_AL"), time, 10_100)
}

fn prepare_day(data: &Path, date: u32) {
    let key = KeyName::parse("collect-01").unwrap();
    let plan = PlanFile {
        format_version: 1,
        date,
        created_at: "2026-11-24T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: 1, universe_replaced: None },
        keys: vec![KeyShare {
            name: key.clone(),
            role: KeyRole::Collecting,
            app_key_hash: "hash-collect-01".to_owned(),
            stocks: vec![CODE.to_owned()],
            market_types: MARKET_TYPES.to_vec(),
            rest_jobs: Vec::new(),
            load: 0,
        }],
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    };
    write_plan(data, &plan).unwrap();

    let mut writer = RawWriter::for_key(data, key);
    let base = at_ms(date, 9, 0, 0);
    writer.write(&RawLine::Frame { recv_ms: base, text: &json!({"trnm": "LOGIN", "return_code": 0}).to_string() }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: base + 100, text: &json!({"trnm": "REG", "return_code": 0}).to_string() }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: base + 1_000, text: &quote_frame(CODE, "090005") }).unwrap();
    writer.write(&RawLine::Live { recv_ms: base + 1_100 }).unwrap();
    writer.close().unwrap();
}

fn run_finalize(data: &Path, shared: &Path, date: u32) -> String {
    let arguments: Vec<String> = [
        "--data",
        &data.to_string_lossy(),
        "--date",
        &date.to_string(),
        "--buckets",
        "16",
        "--threads",
        "2",
        "--shared",
        &shared.to_string_lossy(),
    ]
    .map(str::to_owned)
    .to_vec();
    format!("{:?}", finalize::run(&arguments))
}

#[test]
fn a_broken_old_day_does_not_keep_the_others_from_being_filled() {
    let folder = tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    fs::create_dir_all(&data).unwrap();

    prepare_day(&data, EARLIER);
    assert_eq!(run_finalize(&data, &shared, EARLIER), format!("{:?}", ExitCode::SUCCESS));
    fs::remove_dir_all(closed_day_dir(&shared, &EARLIER.to_string())).unwrap();

    let broken_store = store_dir(&data, BROKEN);
    fs::create_dir_all(&broken_store).unwrap();
    fs::write(broken_store.join("complete.json"), "{깨진 완료 파일").unwrap();

    prepare_day(&data, TODAY);
    assert_eq!(run_finalize(&data, &shared, TODAY), format!("{:?}", ExitCode::from(3)));

    for date in [EARLIER, TODAY] {
        let day = read_quote_day(&shared, &date.to_string(), CODE).unwrap().unwrap_or_else(|| panic!("{date}가 비어 있다"));
        assert!(day.closed);
        assert_eq!(day.minutes.len(), 1);
    }
    assert!(!closed_day_dir(&shared, &BROKEN.to_string()).exists());
}

#[test]
fn a_complete_file_that_did_not_pass_is_not_published() {
    let folder = tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    fs::create_dir_all(&data).unwrap();

    let bad_days = [
        (FAILED_VERIFY, json!({"format_version": 1, "date": FAILED_VERIFY, "verify": {"passed": false}, "stocks": []})),
        (WRONG_VERSION, json!({"format_version": 2, "date": WRONG_VERSION, "verify": {"passed": true}, "stocks": []})),
        (MISSING_STOCKS, json!({"format_version": 1, "date": MISSING_STOCKS, "verify": {"passed": true}})),
    ];
    for (date, body) in bad_days {
        let store = store_dir(&data, date);
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("complete.json"), body.to_string()).unwrap();
        let live = live_day_dir(&shared, &date.to_string()).join("collect-01");
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("marker"), "keep").unwrap();
    }

    prepare_day(&data, TODAY);
    assert_eq!(run_finalize(&data, &shared, TODAY), format!("{:?}", ExitCode::from(3)));

    for date in [FAILED_VERIFY, WRONG_VERSION, MISSING_STOCKS] {
        assert!(!closed_day_dir(&shared, &date.to_string()).exists(), "{date} 닫힌 폴더가 생기면 안 된다");
        assert!(live_day_dir(&shared, &date.to_string()).join("collect-01").join("marker").is_file(), "{date} 장중 폴더가 남아야 한다");
    }
    assert!(read_quote_day(&shared, &TODAY.to_string(), CODE).unwrap().is_some());
}

#[test]
fn odd_symbols_are_left_out() {
    let folder = tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    fs::create_dir_all(&data).unwrap();

    let key = KeyName::parse("collect-01").unwrap();
    let plan = PlanFile {
        format_version: 1,
        date: TODAY,
        created_at: "2026-11-24T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: 1, universe_replaced: None },
        keys: vec![KeyShare {
            name: key.clone(),
            role: KeyRole::Collecting,
            app_key_hash: "hash-collect-01".to_owned(),
            stocks: vec![CODE.to_owned()],
            market_types: MARKET_TYPES.to_vec(),
            rest_jobs: Vec::new(),
            load: 0,
        }],
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    };
    write_plan(&data, &plan).unwrap();

    let mut writer = RawWriter::for_key(&data, key);
    let base = at_ms(TODAY, 9, 0, 0);
    writer.write(&RawLine::Frame { recv_ms: base, text: &json!({"trnm": "LOGIN", "return_code": 0}).to_string() }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: base + 100, text: &json!({"trnm": "REG", "return_code": 0}).to_string() }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: base + 1_000, text: &quote_frame_for_item(&format!("{CODE}_AL"), "090005", 10_100) }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: base + 1_100, text: &quote_frame_for_item(CODE, "090055", 50_100) }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: base + 1_200, text: &quote_frame_for_item("_AL", "090056", 60_100) }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: base + 1_300, text: &quote_frame_for_item("../x_AL", "090057", 70_100) }).unwrap();
    writer.write(&RawLine::Live { recv_ms: base + 1_400 }).unwrap();
    writer.close().unwrap();

    assert_eq!(run_finalize(&data, &shared, TODAY), format!("{:?}", ExitCode::SUCCESS));

    let day = read_quote_day(&shared, &TODAY.to_string(), CODE).unwrap().unwrap();
    assert_eq!(day.minutes.len(), 1);
    assert_eq!(day.minutes[0].close_sec, 9 * 3600 + 5);
    assert_eq!(day.minutes[0].combined.close.asks[0].0, 10_100);

    let mut files: Vec<String> = fs::read_dir(closed_day_dir(&shared, &TODAY.to_string()))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files, [format!("{CODE}.json.gz")]);
}
