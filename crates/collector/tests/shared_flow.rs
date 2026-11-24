use std::fs;
use std::path::Path;
use std::time::Duration;

use collector::protocol::KeyName;
use collector::shared::flow::{FLOW_KINDS, FLUSH_EVERY, FileFlowStore, FlowKindSpec, remove_finished_days, spawn};
use serde_json::{Value, json};
use server::shared_data::{FlowBlock, FlowCursor, flow_folder, flow_links_path, flow_path};
use tokio_tungstenite::tungstenite::Utf8Bytes;

const DAY: &str = "20261124";
const NINE_MS: i64 = 1_795_478_400_000;
const KEY: &str = "collect-01";

static WITH_PROGRAM: &[FlowKindSpec] = &[FlowKindSpec { type_code: "0F", fids: &[141] }, FlowKindSpec { type_code: "0w", fids: &[20, 210] }];

fn key() -> KeyName {
    KeyName::parse(KEY).unwrap()
}

fn frame(entries: Value) -> Utf8Bytes {
    json!({"trnm": "REAL", "data": entries}).to_string().into()
}

fn blocks(shared: &Path, type_code: &str, symbol: &str) -> Vec<FlowBlock> {
    FlowCursor::new(flow_path(shared, DAY, type_code, symbol, KEY)).read_new().unwrap()
}

async fn write(kinds: &'static [FlowKindSpec], shared: &Path, frames: &[Utf8Bytes]) {
    let (feed, worker) = spawn(kinds, FileFlowStore::new(shared.to_owned(), key()), NINE_MS);
    for (i, frame) in frames.iter().enumerate() {
        feed.offer(NINE_MS + i as i64, frame);
    }
    drop(feed);
    worker.finish().await;
}

#[tokio::test]
async fn broker_rows_are_written_per_symbol_and_other_types_are_not() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(FLUSH_EVERY, Duration::from_secs(1));
    let one = frame(json!([
        {"type": "0F", "item": "005930_AL", "values": {"141": "삼  성", "146": "030", "161": "120", "166": "-5", "151": "키움증권", "156": "050", "171": "300", "176": "+7", "337": "9"}},
        {"type": "0F", "item": "000660_AL", "values": {"141": "KB증권", "146": "017", "161": "40"}},
        {"type": "0B", "item": "005930_AL", "values": {"20": "090001", "10": "-71000", "15": "3"}},
    ]));
    let two = frame(json!([{"type": "0F", "item": "005930_AL", "values": {"141": "삼  성", "146": "030", "161": "150"}}]));
    write(FLOW_KINDS, dir.path(), &[one, two]).await;

    let samsung = blocks(dir.path(), "0F", "005930");
    let rows: Vec<_> = samsung.iter().flat_map(|block| &block.rows).collect();
    assert_eq!(rows.iter().map(|row| row.recv_ms).collect::<Vec<_>>(), [NINE_MS, NINE_MS + 1]);
    let fids = &samsung[0].description.fids;
    assert_eq!(*fids, (141..=180).collect::<Vec<u32>>());
    let value = |row: usize, fid: u32| rows[row].values[fids.iter().position(|f| *f == fid).unwrap()].clone();
    assert_eq!([141, 146, 161, 166, 151, 156, 171, 176].map(|fid| value(0, fid).unwrap()), ["삼  성", "030", "120", "-5", "키움증권", "050", "300", "+7"]);
    assert_eq!(value(0, 142), None);
    assert_eq!(value(1, 161).as_deref(), Some("150"));
    assert_eq!(samsung[0].description.symbol, "005930");
    assert_eq!(samsung[0].description.key, KEY);
    assert_eq!(blocks(dir.path(), "0F", "000660")[0].rows.len(), 1);
    assert!(!flow_folder(dir.path(), DAY, "0B", "005930").exists());
}

#[tokio::test]
async fn a_new_kind_is_one_row_of_the_table() {
    let dir = tempfile::tempdir().unwrap();
    let program = frame(json!([{"type": "0w", "item": "005930_AL", "values": {"20": "090005", "210": "+1200"}}]));
    write(WITH_PROGRAM, dir.path(), &[program]).await;
    let written = blocks(dir.path(), "0w", "005930");
    assert_eq!(written[0].description.type_code, "0w");
    assert_eq!(written[0].rows[0].values, [Some("090005".to_owned()), Some("+1200".to_owned())]);
}

#[tokio::test]
async fn links_record_start_down_and_live() {
    let dir = tempfile::tempdir().unwrap();
    let (feed, worker) = spawn(FLOW_KINDS, FileFlowStore::new(dir.path().to_owned(), key()), NINE_MS);
    feed.link(NINE_MS + 10, true);
    feed.link(NINE_MS + 20, false);
    feed.link(NINE_MS + 30, true);
    drop(feed);
    worker.finish().await;
    let text = fs::read_to_string(flow_links_path(dir.path(), DAY, KEY)).unwrap();
    let lines: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).filter(|line: &Value| line["event"] != "alive").collect();
    assert_eq!(lines.iter().map(|line| line["event"].as_str().unwrap()).collect::<Vec<_>>(), ["start", "live", "down", "live", "end"]);
    let times: Vec<i64> = lines.iter().map(|line| line["t"].as_i64().unwrap()).collect();
    assert_eq!(times[..4], [NINE_MS, NINE_MS + 10, NINE_MS + 20, NINE_MS + 30]);
    assert!(times[4] >= times[3]);
}

#[test]
fn only_finished_days_before_the_newest_finished_day_are_removed() {
    let data = tempfile::tempdir().unwrap();
    let shared = data.path().join("shared");
    for day in ["20261119", "20261120", "20261123", "20261124"] {
        fs::create_dir_all(flow_folder(&shared, day, "0F", "005930")).unwrap();
    }
    for day in ["20261120", "20261123"] {
        let store = data.path().join("store").join(day);
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("complete.json"), "{}").unwrap();
    }
    assert_eq!(remove_finished_days(&shared, data.path()).unwrap(), [20261120]);
    let left = |day: &str| shared.join("symbol-flow").join(day).exists();
    assert_eq!(["20261119", "20261120", "20261123", "20261124"].map(left), [true, false, true, true]);
}

#[tokio::test]
async fn a_number_in_one_entry_does_not_lose_the_frame() {
    let dir = tempfile::tempdir().unwrap();
    let mixed = frame(json!([
        {"type": "0B", "item": "005930_AL", "values": {"10": 71000, "15": [1, 2]}},
        {"type": "0F", "item": "005930_AL", "values": {"141": "삼  성", "161": 120}},
    ]));
    write(FLOW_KINDS, dir.path(), &[mixed]).await;
    let written = blocks(dir.path(), "0F", "005930");
    let position = written[0].description.fids.iter().position(|fid| *fid == 161).unwrap();
    assert_eq!(written[0].rows[0].values[position].as_deref(), Some("120"));
}
