use std::fs;
use std::path::Path;

use collector::protocol::KeyName;
use collector::shared::flow::{FLOW_KINDS, FileFlowStore, spawn};
use serde_json::{Value, json};
use server::shared_data::{FlowCursor, flow_links_path, flow_path};
use tokio_tungstenite::tungstenite::Utf8Bytes;

const DAY: &str = "20261124";
const NINE_MS: i64 = 1_795_478_400_000;
const KEY: &str = "collect-01";

fn key() -> KeyName {
    KeyName::parse(KEY).unwrap()
}

fn frame(entries: Value) -> Utf8Bytes {
    json!({"trnm": "REAL", "data": entries}).to_string().into()
}

#[tokio::test]
async fn an_item_that_is_not_a_plain_code_is_skipped() {
    let root = tempfile::tempdir().unwrap();
    let shared = root.path().join("nested").join("shared");
    let too_long = format!("{}_AL", "A".repeat(34));
    let entries = frame(json!([
        {"type": "0F", "item": "../../x_AL", "values": {"141": "키움"}},
        {"type": "0F", "item": "/tmp/x_AL", "values": {"141": "키움"}},
        {"type": "0F", "item": "", "values": {"141": "키움"}},
        {"type": "0F", "item": too_long, "values": {"141": "키움"}},
        {"type": "0F", "item": "005930_AL", "values": {"141": "키움"}},
    ]));
    let (feed, worker) = spawn(FLOW_KINDS, FileFlowStore::new(shared.clone(), key()), NINE_MS);
    feed.offer(NINE_MS, &entries);
    drop(feed);
    worker.finish().await;

    let valid = flow_path(&shared, DAY, "0F", "005930", KEY);
    let blocks = FlowCursor::new(valid).read_new().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].rows.len(), 1);

    let kind_dir = shared.join("symbol-flow").join(DAY).join("0F");
    let mut symbols: Vec<String> = fs::read_dir(&kind_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    symbols.sort();
    assert_eq!(symbols, ["005930"]);

    assert!(!shared.join("symbol-flow").join(DAY).join("x").exists());
    assert!(!shared.join("symbol-flow").join("x").exists());
    assert!(!root.path().join("x").exists());
    assert!(!Path::new("/tmp/x").join(format!("{KEY}.flow")).exists());
}

#[tokio::test]
async fn a_torn_link_line_is_cut_before_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let links = flow_links_path(dir.path(), DAY, KEY);
    fs::create_dir_all(links.parent().unwrap()).unwrap();
    let intact = format!(r#"{{"t":{NINE_MS},"event":"start"}}"#);
    let torn = format!(r#"{{"t":{},"ev"#, NINE_MS + 10);
    fs::write(&links, format!("{intact}\n{torn}")).unwrap();

    let (feed, worker) = spawn(FLOW_KINDS, FileFlowStore::new(dir.path().to_owned(), key()), NINE_MS + 100);
    drop(feed);
    worker.finish().await;

    let text = fs::read_to_string(&links).unwrap();
    let lines: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let non_alive: Vec<&Value> = lines.iter().filter(|line| line["event"] != "alive").collect();
    let events: Vec<&str> = non_alive.iter().map(|line| line["event"].as_str().unwrap()).collect();
    assert_eq!(events, ["start", "start", "end"]);
    assert_eq!(non_alive[0]["t"].as_i64().unwrap(), NINE_MS);
    assert_eq!(non_alive[1]["t"].as_i64().unwrap(), NINE_MS + 100);
}

#[tokio::test]
async fn vi_flow_strips_nx_normalizes_f9001_and_ignores_al_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let entries = frame(json!([
        {"type": "1h", "item": "005930", "values": {"9001": "005930", "9068": "1", "9069": "1", "1223": "090100"}},
        {"type": "1h", "item": "005930_NX", "values": {"9001": "005930", "9068": "2", "9069": "2", "1223": "090200"}},
        {"type": "1h", "item": "005930_AL", "values": {"9001": "005930_AL", "9068": "1", "9069": "1", "1223": "090100"}},
    ]));
    let (feed, worker) = spawn(FLOW_KINDS, FileFlowStore::new(dir.path().to_owned(), key()), NINE_MS);
    feed.offer(NINE_MS, &entries);
    drop(feed);
    worker.finish().await;

    let path = flow_path(dir.path(), DAY, "1h", "005930", KEY);
    let blocks = FlowCursor::new(path).read_new().unwrap();
    let rows: Vec<_> = blocks.iter().flat_map(|block| &block.rows).collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].values[0].as_deref(), Some("005930"));
    assert_eq!(rows[1].values[0].as_deref(), Some("005930_NX"));
    assert!(!dir.path().join("symbol-flow").join(DAY).join("1h").join("005930_NX").exists());
    assert!(!dir.path().join("symbol-flow").join(DAY).join("1h").join("005930_AL").exists());
}

#[tokio::test]
async fn multi_entry_frame_with_null_type_or_item_preserves_valid_siblings() {
    let dir = tempfile::tempdir().unwrap();
    let entries = frame(json!([
        {"type": null, "item": null, "values": null},
        {"type": "0B", "item": null, "values": {"20": "090001", "10": "+71000", "15": "+5"}},
        {"type": 123, "item": "005930_AL", "values": {"10": "+71000"}},
        {"type": "0F", "item": "005930_AL", "values": {"141": "키움", "161": "50"}},
        {"type": "0B", "item": "005930_AL", "values": {"20": "090002", "10": "+71000", "15": "+7", "9081": "KRX"}},
    ]));
    let (feed, worker) = spawn(FLOW_KINDS, FileFlowStore::new(dir.path().to_owned(), key()), NINE_MS);
    feed.offer(NINE_MS, &entries);
    drop(feed);
    worker.finish().await;

    let brokers = FlowCursor::new(flow_path(dir.path(), DAY, "0F", "005930", KEY)).read_new().unwrap();
    assert_eq!(brokers[0].rows.len(), 1);
    let ticks = FlowCursor::new(flow_path(dir.path(), DAY, "0B", "005930", KEY)).read_new().unwrap();
    assert_eq!(ticks[0].rows.len(), 1);
}
