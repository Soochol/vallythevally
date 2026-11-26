use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use collector::protocol::KeyName;
use collector::shared::flow::{FLOW_KINDS, FLUSH_EVERY, FileFlowStore, FlowKindSpec, remove_finished_days, spawn};
use serde_json::{Value, json};
use server::shared_data::{FlowBlock, FlowCursor, flow_folder, flow_links_path, flow_path};
use tokio_tungstenite::tungstenite::Utf8Bytes;

const DAY: &str = "20261124";
const NINE_MS: i64 = 1_795_478_400_000;
const KEY: &str = "collect-01";

static WITH_PROGRAM: &[FlowKindSpec] = &[FlowKindSpec { type_code: "0F", fids: &[141] }, FlowKindSpec { type_code: "0w", fids: &[20, 210] }];
static BROKER_ONLY: &[FlowKindSpec] = &[FLOW_KINDS[0]];

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
        {"type": "0w", "item": "005930_AL", "values": {"20": "090001", "10": "+71000", "210": "+150"}},
        {"type": "1h", "item": "005930", "values": {"9001": "005930", "9068": "1", "9069": "1", "1223": "090002"}},
        {"type": "0H", "item": "005930_AL", "values": {"20": "085900", "10": "+71200", "15": "100"}},
        {"type": "0B", "item": "005930_AL", "values": {"20": "090001", "10": "-71000", "15": "+3", "9081": "KRX"}},
        {"type": "0D", "item": "005930_AL", "values": {"21": "090001", "41": "71100", "61": "500"}},
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
    for type_code in ["0w", "1h", "0H", "0B"] {
        assert_eq!(blocks(dir.path(), type_code, "005930")[0].rows.len(), 1, "{type_code}");
    }
    assert!(!flow_folder(dir.path(), DAY, "0D", "005930").exists());
}

#[tokio::test]
async fn all_registered_flow_kinds_write_expected_fids_and_values() {
    let dir = tempfile::tempdir().unwrap();
    let frames = [
        frame(json!([
            {
                "type": "0w",
                "item": "005930_AL",
                "values": {
                    "20": "090500", "10": "+71200", "202": "100", "204": "7", "206": "250",
                    "208": "18", "210": "+150", "211": "+10", "212": "+11", "213": "+1", "999": "ignored"
                }
            },
            {
                "type": "1h",
                "item": "005930_NX",
                "values": {
                    "9001": "005930_NX", "9068": "3", "9069": "2", "1221": "-68000", "1223": "091000",
                    "1224": "091200", "1225": "2", "1236": "70000", "1237": "70500", "1238": "-2.86",
                    "1239": "-3.55", "1489": "-4.20", "1490": "2"
                }
            },
            {
                "type": "0H",
                "item": "005930_AL",
                "values": {"20": "085500", "10": "+71500", "11": "+500", "12": "+0.70", "15": "1200", "13": "50000", "25": "2"}
            },
            {
                "type": "0B",
                "item": "005930_AL",
                "values": {"20": "090001", "10": "-71000", "15": "-12", "1313": "-852", "9081": "NXT"}
            },
        ])),
    ];
    write(FLOW_KINDS, dir.path(), &frames).await;

    let program = blocks(dir.path(), "0w", "005930");
    assert_eq!(program[0].description.fids, [20, 10, 202, 204, 206, 208, 210, 211, 212, 213]);
    assert_eq!(
        program[0].rows[0].values,
        ["090500", "+71200", "100", "7", "250", "18", "+150", "+10", "+11", "+1"].map(|s| Some(s.to_owned()))
    );

    let vi = blocks(dir.path(), "1h", "005930");
    assert_eq!(vi[0].description.fids, [9001, 9068, 9069, 1221, 1223, 1224, 1225, 1236, 1237, 1238, 1239, 1489, 1490]);
    assert_eq!(
        vi[0].rows[0].values,
        ["005930_NX", "3", "2", "-68000", "091000", "091200", "2", "70000", "70500", "-2.86", "-3.55", "-4.20", "2"].map(|s| Some(s.to_owned()))
    );

    let expected = blocks(dir.path(), "0H", "005930");
    assert_eq!(expected[0].description.fids, [20, 10, 11, 12, 15, 13, 25]);
    assert_eq!(
        expected[0].rows[0].values,
        ["085500", "+71500", "+500", "+0.70", "1200", "50000", "2"].map(|s| Some(s.to_owned()))
    );

    let ticks = blocks(dir.path(), "0B", "005930");
    assert_eq!(ticks[0].description.fids, [20, 10, 15, 1313, 9081]);
    assert_eq!(
        ticks[0].rows[0].values,
        ["090001", "-71000", "-12", "-852", "NXT"].map(|s| Some(s.to_owned()))
    );
}

fn dir_bytes(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(folder) = stack.pop() {
        let Ok(entries) = fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

fn synthetic_trade_burst(symbols: usize, frames: usize) -> Vec<Utf8Bytes> {
    (0..frames)
        .map(|index| {
            let symbol = format!("{:06}_AL", (index % symbols) + 1);
            let qty = if index % 2 == 0 { format!("+{}", (index % 50) + 1) } else { format!("-{}", (index % 50) + 1) };
            let venue = if index % 3 == 0 { "NXT" } else { "KRX" };
            let sec = index % 60;
            let min = (index / 60) % 60;
            let hhmmss = format!("09{min:02}{sec:02}");
            frame(json!([{
                "type": "0B",
                "item": symbol,
                "values": {
                    "20": hhmmss,
                    "10": "+71000",
                    "15": qty,
                    "1313": "355",
                    "9081": venue,
                }
            }]))
        })
        .collect()
}

#[tokio::test]
async fn ten_thousand_trade_ticks_across_symbols_flush_without_drops() {
    const SYMBOLS: usize = 190;
    const FRAMES: usize = 10_000;
    let synthetic = synthetic_trade_burst(SYMBOLS, FRAMES);
    let full_dir = tempfile::tempdir().unwrap();
    let (full_feed, full_worker) = spawn(FLOW_KINDS, FileFlowStore::new(full_dir.path().to_owned(), key()), NINE_MS);
    let full_stats = full_worker.stats();
    for (index, item) in synthetic.iter().enumerate() {
        full_feed.offer(NINE_MS + index as i64, item);
    }
    drop(full_feed);
    full_worker.finish().await;

    assert_eq!(full_stats.dropped(), 0);
    assert_eq!(full_stats.store_errors(), 0);
    assert_eq!(full_stats.evicted(), 0);
    assert_eq!(full_stats.rows(), FRAMES as u64);

    let mut read_rows = 0usize;
    for index in 0..SYMBOLS {
        let symbol = format!("{:06}", index + 1);
        read_rows += blocks(full_dir.path(), "0B", &symbol).iter().map(|block| block.rows.len()).sum::<usize>();
    }
    assert_eq!(read_rows, FRAMES);
}

#[tokio::test]
#[ignore]
async fn trade_tick_perf_probe_baseline_vs_all_kinds() {
    const SYMBOLS: usize = 190;
    const FRAMES: usize = 10_000;
    let synthetic = synthetic_trade_burst(SYMBOLS, FRAMES);

    let baseline_dir = tempfile::tempdir().unwrap();
    let baseline_start = Instant::now();
    let (baseline_feed, baseline_worker) = spawn(BROKER_ONLY, FileFlowStore::new(baseline_dir.path().to_owned(), key()), NINE_MS);
    let baseline_stats = baseline_worker.stats();
    for (index, item) in synthetic.iter().enumerate() {
        baseline_feed.offer(NINE_MS + index as i64, item);
    }
    drop(baseline_feed);
    baseline_worker.finish().await;
    let baseline_ms = baseline_start.elapsed().as_millis();
    let baseline_bytes = dir_bytes(&baseline_dir.path().join("symbol-flow").join(DAY).join("0B"));
    assert_eq!(baseline_stats.dropped(), 0);
    assert_eq!(baseline_stats.store_errors(), 0);
    assert_eq!(baseline_stats.rows(), 0);
    assert_eq!(baseline_bytes, 0);

    let full_dir = tempfile::tempdir().unwrap();
    let (full_feed, full_worker) = spawn(FLOW_KINDS, FileFlowStore::new(full_dir.path().to_owned(), key()), NINE_MS);
    let full_stats = full_worker.stats();
    let ingest_start = Instant::now();
    for (index, item) in synthetic.iter().enumerate() {
        full_feed.offer(NINE_MS + index as i64, item);
    }
    while full_stats.rows() < FRAMES as u64 {
        tokio::task::yield_now().await;
    }
    let parse_ms = ingest_start.elapsed().as_millis();
    assert_eq!(full_stats.blocks(), 0);
    let flush_start = Instant::now();
    drop(full_feed);
    full_worker.finish().await;
    let flush_ms = flush_start.elapsed().as_millis();
    let total_ms = ingest_start.elapsed().as_millis();
    let full_bytes = dir_bytes(&full_dir.path().join("symbol-flow").join(DAY).join("0B"));

    assert_eq!(full_stats.dropped(), 0);
    assert_eq!(full_stats.store_errors(), 0);
    assert_eq!(full_stats.evicted(), 0);
    assert_eq!(full_stats.rows(), FRAMES as u64);

    let mut read_rows = 0usize;
    for index in 0..SYMBOLS {
        let symbol = format!("{:06}", index + 1);
        read_rows += blocks(full_dir.path(), "0B", &symbol).iter().map(|block| block.rows.len()).sum::<usize>();
    }
    assert_eq!(read_rows, FRAMES);
    eprintln!(
        "perf_probe baseline_ms={baseline_ms} baseline_bytes={baseline_bytes} full_parse_ms={parse_ms} full_flush_ms={flush_ms} full_total_ms={total_ms} full_bytes={full_bytes} blocks={} dropped={}",
        full_stats.blocks(),
        full_stats.dropped()
    );
    assert!(flush_ms <= 150, "flush_ms={flush_ms} exceeded 150ms budget for 190 symbols / 10_000 frames");
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
