use std::path::Path;
use std::time::Duration;

use collector::protocol::KeyName;
use collector::shared::quotes::{Applied, CLOSE_AFTER_SECS, FLUSH_EVERY, LiveQuotes, QuoteFeed, QuoteWorker, read_books, spawn};
use serde_json::{Map, Value, json};
use server::shared_data::{BookLevel, BookRow, CurrentQuotes, QuoteDay, QuoteMinute, QuoteMinuteBuilder, read_quote_day};
use tokio_tungstenite::tungstenite::Utf8Bytes;

const DAY: u32 = 20_261_123;
const DAY_START_MS: i64 = 1_795_359_600_000;
const CODE: &str = "005930";
const QUIET: &str = "000660";

type Level = (i64, i64, i64);

fn sec(hour: u32, minute: u32, second: u32) -> u32 {
    hour * 3600 + minute * 60 + second
}

fn ms(hour: u32, minute: u32, second: u32) -> i64 {
    DAY_START_MS + i64::from(sec(hour, minute, second)) * 1000
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

fn clock_text(at: u32) -> String {
    format!("{:02}{:02}{:02}", at / 3600, at / 60 % 60, at % 60)
}

fn values_of(time: &str, asks: &[Level], bids: &[Level]) -> Map<String, Value> {
    let mut values = Map::new();
    values.insert("21".to_owned(), json!(time));
    for (price_fid, qty_fid, krx_fid, nxt_fid, levels, sign) in [(41, 61, 6044, 6066, asks, "+"), (51, 71, 6054, 6076, bids, "-")] {
        for (index, (price, krx, nxt)) in levels.iter().enumerate() {
            for (fid, text) in [(price_fid, format!("{sign}{price}")), (qty_fid, (krx + nxt).to_string()), (krx_fid, krx.to_string()), (nxt_fid, nxt.to_string())] {
                values.insert((fid + index).to_string(), json!(text));
            }
        }
    }
    values
}

fn frame(code: &str, book: &BookRow) -> Utf8Bytes {
    let levels = |side: &[BookLevel; 10]| side.iter().map(|level| (level.price, level.krx, level.nxt)).collect::<Vec<Level>>();
    let values = values_of(&clock_text(book.sec), &levels(&book.asks), &levels(&book.bids));
    json!({"trnm": "REAL", "data": [{"type": "0D", "item": format!("{code}_AL"), "values": values}]}).to_string().into()
}

#[test]
fn every_level_is_read_and_signs_are_dropped() {
    let asks: Vec<Level> = (0..10).map(|index| (10_100 + index * 100, index + 1, index * 2)).collect();
    let bids: Vec<Level> = vec![(10_000, 7, 8), (9_900, 0, 9)];
    let text = json!({"trnm": "REAL", "data": [
        {"type": "0D", "item": "005930_AL", "values": values_of("090159", &asks, &bids)},
        {"type": "0B", "item": "005930_AL", "values": {"20": "090159", "10": "1", "15": "1"}},
        {"type": "0D", "item": "000660_AL", "values": values_of("09", &asks, &bids)},
        {"type": "0D", "item": "001", "values": values_of("090159", &asks, &bids)},
        {"type": "0D", "item": "000660_AL", "values": {"21": "100000", "41": "", "51": "-500", "71": "3"}},
    ]});
    let mut seen: Vec<(String, BookRow)> = Vec::new();
    let reading = read_books(&text.to_string(), |code, row| seen.push((code.to_owned(), *row))).unwrap();
    assert_eq!((reading.books, reading.skipped), (2, 2));
    let (code, book) = &seen[0];
    assert_eq!((code.as_str(), book.sec), ("005930", sec(9, 1, 59)));
    for (index, (price, krx, nxt)) in asks.iter().enumerate() {
        assert_eq!(book.asks[index], BookLevel { price: *price, combined: krx + nxt, krx: *krx, nxt: *nxt });
    }
    assert_eq!(book.bids[1], BookLevel { price: 9_900, combined: 9, krx: 0, nxt: 9 });
    assert_eq!(book.bids[2..], [BookLevel::default(); 8]);
    let (code, sparse) = &seen[1];
    assert_eq!((code.as_str(), sparse.asks[0], sparse.bids[0]), ("000660", BookLevel::default(), BookLevel { price: 500, combined: 3, krx: 0, nxt: 0 }));
    assert!(read_books("not json", |_, _| {}).is_err());
    assert_eq!(read_books(r#"{"trnm":"PING"}"#, |_, _| panic!("호가가 없다")).unwrap().books, 0);
}

#[test]
fn a_minute_ends_with_the_next_minute_or_five_seconds_later() {
    let mut live = LiveQuotes::new(DAY);
    let (first, second, next) = (row(sec(9, 0, 1), 10), row(sec(9, 0, 59), 20), row(sec(9, 1, 0), 30));
    let quiet = row(sec(9, 0, 30), 5);
    for (code, book) in [(CODE, &first), (QUIET, &quiet), (CODE, &second)] {
        assert_eq!(live.take(code, book), Applied::Counted);
    }
    live.settle(sec(9, 0, 59));
    assert!(live.pending().is_empty());
    assert_eq!(live.current().minutes.len(), 2);

    live.take(CODE, &next);
    assert_eq!(live.pending(), [(CODE.to_owned(), folded(&[first, second]))]);
    live.settle(sec(9, 1, 0) + CLOSE_AFTER_SECS - 1);
    assert_eq!(live.pending().len(), 1);
    live.settle(sec(9, 1, 0) + CLOSE_AFTER_SECS);
    assert_eq!(live.pending().len(), 2);
    assert_eq!(live.pending()[1], (QUIET.to_owned(), folded(&[quiet])));
    assert_eq!(live.current(), CurrentQuotes { minutes: [(CODE.to_owned(), folded(&[next]))].into() });

    live.written(1);
    assert_eq!(live.pending(), [(QUIET.to_owned(), folded(&[quiet]))]);
    live.written(1);
    assert!(live.pending().is_empty());
    assert_eq!(live.date(), DAY);
}

#[test]
fn a_book_of_a_finished_minute_is_too_late() {
    let mut live = LiveQuotes::new(DAY);
    let (early, back, next, late) = (row(sec(9, 0, 50), 10), row(sec(9, 0, 40), 20), row(sec(9, 1, 0), 30), row(sec(9, 0, 59), 99));
    assert_eq!(live.take(CODE, &early), Applied::Counted);
    assert_eq!(live.take(CODE, &back), Applied::Counted);
    assert_eq!(live.take(CODE, &next), Applied::Counted);
    assert_eq!(live.take(CODE, &late), Applied::TooLate);
    assert_eq!(live.pending(), [(CODE.to_owned(), folded(&[early, back]))]);

    live.take(QUIET, &row(sec(9, 1, 10), 1));
    live.settle(sec(9, 2, 5));
    assert_eq!(live.take(QUIET, &row(sec(9, 1, 59), 2)), Applied::TooLate);
    assert_eq!(live.take(QUIET, &row(sec(9, 2, 1), 3)), Applied::Counted);

    let mut resumed = LiveQuotes::resumed(DAY, CurrentQuotes { minutes: [(CODE.to_owned(), folded(&[early]))].into() });
    assert_eq!(resumed.take(CODE, &row(sec(8, 59, 59), 1)), Applied::TooLate);
    assert_eq!(resumed.take(CODE, &back), Applied::Counted);
    assert_eq!(resumed.current().minutes[CODE], folded(&[early, back]));
}

fn key() -> KeyName {
    KeyName::parse("collect-01").unwrap()
}

fn started(shared: &Path, now_ms: i64) -> (QuoteFeed, QuoteWorker) {
    spawn(shared.to_owned(), key(), now_ms)
}

async fn flushed() {
    for _ in 0..3 {
        settle().await;
        tokio::time::advance(FLUSH_EVERY).await;
    }
    settle().await;
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
        tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(1))).await.unwrap();
    }
}

fn day(shared: &Path) -> Option<QuoteDay> {
    read_quote_day(shared, &DAY.to_string(), CODE).unwrap()
}

#[tokio::test(start_paused = true)]
async fn an_outage_and_a_restart_become_gaps() {
    let folder = tempfile::tempdir().unwrap();
    let shared = folder.path().join("shared");
    let (feed, worker) = started(&shared, ms(9, 0, 0));
    let books = [row(sec(9, 0, 1), 10), row(sec(9, 0, 30), 20), row(sec(9, 1, 10), 30)];
    feed.link_live(ms(9, 0, 0));
    for book in &books {
        feed.offer(DAY_START_MS + i64::from(book.sec) * 1000 + 300, &frame(CODE, book));
    }
    feed.link_down(ms(9, 1, 20));
    feed.link_down(ms(9, 1, 25));
    feed.link_live(ms(9, 1, 40));
    flushed().await;
    let running = day(&shared).unwrap();
    assert_eq!(running.minutes, [folded(&books[..2]), folded(&books[2..])]);
    assert_eq!(running.gaps, [(sec(9, 1, 20), sec(9, 1, 40))]);
    feed.link_down(ms(9, 1, 50));
    drop(feed);
    let stats = worker.stats();
    worker.finish().await;
    assert_eq!((stats.books(), stats.too_late(), stats.dropped(), stats.store_errors()), (3, 0, 0, 0));
    assert_eq!(day(&shared).unwrap().gaps.len(), 1);

    let (feed, worker) = started(&shared, ms(9, 1, 55));
    feed.link_live(ms(9, 1, 56));
    let after = row(sec(9, 1, 58), 40);
    feed.offer(ms(9, 1, 58), &frame(CODE, &after));
    flushed().await;
    let resumed = day(&shared).unwrap();
    assert_eq!(resumed.minutes, [folded(&books[..2]), folded(&[books[2], after])]);
    assert_eq!(resumed.gaps, [(sec(9, 1, 10), sec(9, 1, 56)), (sec(9, 1, 20), sec(9, 1, 40))]);
    drop(feed);
    worker.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_broken_folder_is_counted_and_does_not_stop_the_worker() {
    let folder = tempfile::tempdir().unwrap();
    let shared = folder.path().join("shared");
    std::fs::write(&shared, "폴더가 아니다").unwrap();
    let (feed, worker) = started(&shared, ms(9, 0, 0));
    let books = [row(sec(9, 0, 1), 10), row(sec(9, 1, 1), 20), row(sec(9, 2, 1), 30)];
    for book in &books {
        feed.offer(DAY_START_MS + i64::from(book.sec) * 1000, &frame(CODE, book));
    }
    flushed().await;
    assert!(worker.stats().store_errors() >= 1);
    std::fs::remove_file(&shared).unwrap();
    flushed().await;
    assert_eq!(day(&shared).unwrap().minutes, [folded(&books[..1]), folded(&books[1..2]), folded(&books[2..])]);
    drop(feed);
    worker.finish().await;
}
