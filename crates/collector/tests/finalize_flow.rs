use std::fs;
use std::path::Path;

use collector::calendar::Day;
use collector::finalize::{DEFAULT_SPILL_BUDGET_BYTES, Options, finalize_day_with_shared};
use collector::protocol::KeyName;
use collector::raw_write::{RawLine, RawWriter};
use serde_json::json;
use server::shared_data::flow_folder;
use tempfile::tempdir;

const OLD_DATE: u32 = 20_261_120;
const NEW_DATE: u32 = 20_261_123;
const UNFINISHED_DATE: u32 = 20_261_119;
const TODAY_DATE: u32 = 20_261_124;

fn write_minimal_raw_day(data: &Path, date: u32) {
    let mut writer = RawWriter::for_key(data, KeyName::parse("collect-01").unwrap());
    let recv_ms = Day::from_yyyymmdd(date).unwrap().unix_ms_at_kst(9, 0);
    let frame = json!({"trnm": "REAL", "data": [{"type": "0B", "item": "005930_AL", "values": {"10": "100"}}]}).to_string();
    writer.write(&RawLine::Live { recv_ms }).unwrap();
    writer.write(&RawLine::Frame { recv_ms: recv_ms + 100, text: &frame }).unwrap();
    writer.write(&RawLine::Down { recv_ms: recv_ms + 200, reason: "종료" }).unwrap();
    writer.close().unwrap();
}

#[test]
fn finalize_removes_finished_flow_days_before_the_newest_finished_day() {
    let folder = tempdir().unwrap();
    let data = folder.path().join("data");
    let shared = folder.path().join("custom-shared");
    write_minimal_raw_day(&data, NEW_DATE);
    let old_store = data.join("store").join(OLD_DATE.to_string());
    fs::create_dir_all(&old_store).unwrap();
    fs::write(old_store.join("complete.json"), "{}").unwrap();
    for day in [UNFINISHED_DATE, OLD_DATE, NEW_DATE, TODAY_DATE] {
        fs::create_dir_all(flow_folder(&shared, &day.to_string(), "0F", "005930")).unwrap();
    }

    let options = Options {
        data_dir: data.clone(),
        date: NEW_DATE,
        threads: 2,
        buckets: 16,
        verify_only: false,
        spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES,
    };
    let report = finalize_day_with_shared(&options, &shared).unwrap();
    assert!(report.passed);
    let exists = |day: u32| shared.join("symbol-flow").join(day.to_string()).exists();
    assert_eq!([UNFINISHED_DATE, OLD_DATE, NEW_DATE, TODAY_DATE].map(exists), [true, false, true, true]);
}
