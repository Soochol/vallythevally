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
