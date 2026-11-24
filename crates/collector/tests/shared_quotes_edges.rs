use std::time::Duration;

use collector::protocol::KeyName;
use collector::shared::quotes::{FLUSH_EVERY, read_books, spawn};
use serde_json::{Map, Value, json};
use server::shared_data::{BookLevel, BookRow, QuoteMinute, QuoteMinuteBuilder, read_quote_day};
use tokio_tungstenite::tungstenite::Utf8Bytes;

const DAY_ONE: u32 = 20_261_123;
const DAY_TWO: u32 = 20_261_124;
const DAY_ONE_START_MS: i64 = 1_795_359_600_000;
const DAY_MS: i64 = 24 * 3_600 * 1000;
const CODE: &str = "005930";

fn sec(hour: u32, minute: u32, second: u32) -> u32 {
    hour * 3600 + minute * 60 + second
}

fn row(at: u32, ask: i64) -> BookRow {
    let side = |best: i64, step: i64| std::array::from_fn(|index| BookLevel { price: best + step * index as i64, combined: ask + 3, krx: ask, nxt: 3 });
    BookRow { sec: at, asks: side(10_100, 100), bids: side(10_000, -100) }
}

fn folded(rows: &[BookRow]) -> QuoteMinute {
    let mut builder = QuoteMinuteBuilder::new(rows[0].minute());
    rows.iter().for_each(|row| builder.take(row));
    builder.finish().unwrap()
}

fn frame_for(item: &str, book: &BookRow) -> Utf8Bytes {
    let mut values = Map::new();
    values.insert("21".to_owned(), json!(format!("{:02}{:02}{:02}", book.sec / 3600, book.sec / 60 % 60, book.sec % 60)));
    for (price_fid, qty_fid, krx_fid, nxt_fid, levels, sign) in [(41, 61, 6044, 6066, &book.asks, "+"), (51, 71, 6054, 6076, &book.bids, "-")] {
        for (index, level) in levels.iter().enumerate() {
            values.insert((price_fid + index).to_string(), json!(format!("{sign}{}", level.price)));
            values.insert((qty_fid + index).to_string(), json!(level.combined.to_string()));
            values.insert((krx_fid + index).to_string(), json!(level.krx.to_string()));
            values.insert((nxt_fid + index).to_string(), json!(level.nxt.to_string()));
        }
    }
    json!({"trnm": "REAL", "data": [{"type": "0D", "item": item, "values": values}]}).to_string().into()
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
        tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(1))).await.unwrap();
    }
}

async fn flushed() {
    for _ in 0..3 {
        settle().await;
        tokio::time::advance(FLUSH_EVERY).await;
    }
    settle().await;
}

#[tokio::test(start_paused = true)]
async fn a_new_day_closes_the_open_minutes_of_the_old_one() {
    let folder = tempfile::tempdir().unwrap();
    let shared = folder.path().join("shared");
    let key = KeyName::parse("collect-01").unwrap();
    let day_one_ms = DAY_ONE_START_MS + i64::from(sec(15, 29, 50)) * 1000;
    let day_two_ms = DAY_ONE_START_MS + DAY_MS + i64::from(sec(9, 0, 1)) * 1000;
    let (feed, worker) = spawn(shared.clone(), key, day_one_ms);

    let first = row(sec(15, 29, 50), 10);
    let second = row(sec(9, 0, 1), 20);
    feed.offer(day_one_ms, &frame_for("005930_AL", &first));
    feed.offer(day_two_ms, &frame_for("005930_AL", &second));
    flushed().await;

    let old_stock_file = shared.join("quote-minutes-live").join(DAY_ONE.to_string()).join("collect-01").join("005930.jsonl");
    let old_lines: Vec<String> = std::fs::read_to_string(&old_stock_file).unwrap().lines().map(str::to_owned).collect();
    assert_eq!(old_lines.len(), 2);
    let old_day = read_quote_day(&shared, &DAY_ONE.to_string(), CODE).unwrap().unwrap();
    assert_eq!(old_day.minutes, [folded(&[first])]);

    let new_day = read_quote_day(&shared, &DAY_TWO.to_string(), CODE).unwrap().unwrap();
    assert_eq!(new_day.minutes, [folded(&[second])]);

    drop(feed);
    worker.finish().await;
}

#[test]
fn odd_item_names_are_skipped() {
    let sample = row(sec(9, 0, 10), 10);
    let items = ["../escape_AL", "sub/x_AL", "_gaps_AL", "_AL", "00593_AL", "005930_AL"];
    let entries: Vec<Value> = items
        .iter()
        .map(|item| {
            let mut values = Map::new();
            values.insert("21".to_owned(), json!("090010"));
            values.insert("41".to_owned(), json!(format!("+{}", sample.asks[0].price)));
            values.insert("61".to_owned(), json!(sample.asks[0].combined.to_string()));
            json!({"type": "0D", "item": item, "values": values})
        })
        .collect();
    let text = json!({"trnm": "REAL", "data": entries}).to_string();

    let mut seen = Vec::new();
    let reading = read_books(&text, |code, _| seen.push(code.to_owned())).unwrap();
    assert_eq!(reading.books, 1);
    assert_eq!(reading.skipped, 5);
    assert_eq!(seen, ["005930"]);
}

#[tokio::test(start_paused = true)]
async fn a_full_queue_counts_what_it_drops() {
    let folder = tempfile::tempdir().unwrap();
    let shared = folder.path().join("shared");
    let key = KeyName::parse("collect-01").unwrap();
    let at_ms = DAY_ONE_START_MS + i64::from(sec(9, 0, 1)) * 1000;
    let (feed, worker) = spawn(shared, key, at_ms);
    let stats = worker.stats();
    let frame = frame_for("005930_AL", &row(sec(9, 0, 1), 10));

    let capacity = 16_384;
    let overflow = 25;
    for _ in 0..capacity + overflow {
        feed.offer(at_ms, &frame);
    }
    assert_eq!(stats.dropped(), overflow as u64);

    drop(feed);
    worker.finish().await;
    assert_eq!(stats.books(), capacity as u64);
}
