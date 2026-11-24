use std::io;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use collector::collect::session::WallClock;
use collector::protocol::KeyName;
use collector::shared::trade_minute::{FileTradeMinuteStore, TradeMinuteStore, spawn};
use serde_json::json;
use server::shared_data::{TradeMinuteLine, trade_minute_path};
use tokio_tungstenite::tungstenite::Utf8Bytes;

const DAY_START_MS: i64 = 1_795_359_600_000;
const DATE: u32 = 20_261_123;
const KEY: &str = "collect-01";

struct Wall(AtomicI64);

impl WallClock for Wall {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

fn at(hour: i64, minute: i64, second: i64) -> i64 {
    DAY_START_MS + ((hour * 60 + minute) * 60 + second) * 1000
}

fn wall(now_ms: i64) -> Arc<Wall> {
    Arc::new(Wall(AtomicI64::new(now_ms)))
}

fn trade(item: &str, time: &str, price: &str, quantity: &str) -> Utf8Bytes {
    json!({"trnm": "REAL", "data": [{"type": "0B", "item": item, "name": "주식체결", "values": {"20": time, "10": price, "15": quantity, "9081": "KRX"}}]}).to_string().into()
}

fn lines_of(shared: &Path, code: &str) -> Vec<TradeMinuteLine> {
    let text = std::fs::read_to_string(trade_minute_path(shared, &DATE.to_string(), KEY, code)).unwrap_or_default();
    text.lines().skip(1).map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn minutes_of(shared: &Path, code: &str) -> Vec<u16> {
    lines_of(shared, code).iter().map(|line| line.minute).collect()
}

fn file_store(shared: &Path) -> Box<dyn TradeMinuteStore> {
    Box::new(FileTradeMinuteStore::new(shared.to_owned(), KeyName::parse(KEY).unwrap()))
}

#[tokio::test(start_paused = true)]
async fn a_minute_keeps_the_last_ten_trades_of_each_stock() {
    let shared = tempfile::tempdir().unwrap();
    let (feed, worker) = spawn(file_store(shared.path()), wall(at(9, 0, 1)));
    for second in 1..=12 {
        let quantity = if second % 2 == 0 { format!("-{second}") } else { format!("+{second}") };
        feed.offer(at(9, 0, second), &trade("005930_AL", &format!("0900{second:02}"), &format!("-{}", 71_000 + second), &quantity));
    }
    feed.offer(at(9, 0, 20), &trade("005930_AL", "090020", "-71000", "0"));
    feed.offer(at(9, 0, 21), &trade("005930", "090021", "-71000", "5"));
    feed.offer(at(9, 0, 22), &trade("../escape_AL", "090022", "-71000", "5"));
    feed.offer(at(9, 0, 30), &trade("000660_AL", "090030", "+500000", "+3"));
    feed.offer(at(9, 1, 5), &trade("005930_AL", "090105", "+71500", "+7"));
    feed.offer(at(9, 2, 1), &trade("000120_AL", "090201", "90000", "1"));
    drop(feed);
    worker.finish().await;

    let samsung = lines_of(shared.path(), "005930");
    assert_eq!(samsung.iter().map(|line| line.minute).collect::<Vec<_>>(), [540, 541]);
    let expected: Vec<(u32, u64, i64)> = (3..=12).map(|second: i64| (32_400 + second as u32, 71_000 + second as u64, if second % 2 == 0 { -second } else { second })).collect();
    assert_eq!(samsung[0].trades, expected);
    assert_eq!(samsung[1].trades, [(32_465, 71_500, 7)]);
    assert_eq!(minutes_of(shared.path(), "000660"), [540]);
    assert_eq!(minutes_of(shared.path(), "000120"), [542]);
    let names = std::fs::read_dir(trade_minute_path(shared.path(), &DATE.to_string(), KEY, "005930").parent().unwrap()).unwrap().count();
    assert_eq!(names, 3);
}

#[tokio::test(start_paused = true)]
async fn a_minute_closes_by_the_clock_without_another_frame() {
    let shared = tempfile::tempdir().unwrap();
    let clock = wall(at(9, 0, 10));
    let (feed, worker) = spawn(file_store(shared.path()), clock.clone());
    feed.offer(at(9, 0, 10), &trade("005930_AL", "090010", "71000", "1"));
    clock.0.store(at(9, 0, 59), Ordering::SeqCst);
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(lines_of(shared.path(), "005930").is_empty());
    clock.0.store(at(9, 1, 2), Ordering::SeqCst);
    for _ in 0..3_000 {
        if !lines_of(shared.path(), "005930").is_empty() {
            break;
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(minutes_of(shared.path(), "005930"), [540]);
    drop(feed);
    worker.finish().await;
}

struct FailsOnce {
    inner: Box<dyn TradeMinuteStore>,
    failed: bool,
}

impl TradeMinuteStore for FailsOnce {
    fn append(&mut self, date: u32, lines: &[(String, TradeMinuteLine)]) -> io::Result<()> {
        if !self.failed {
            self.failed = true;
            return Err(io::Error::other("시험이 만든 쓰기 실패"));
        }
        self.inner.append(date, lines)
    }

    fn finish(&mut self) -> io::Result<()> {
        self.inner.finish()
    }
}

#[tokio::test(start_paused = true)]
async fn trades_of_a_failed_write_come_with_the_next_minute() {
    let shared = tempfile::tempdir().unwrap();
    let store = FailsOnce { inner: file_store(shared.path()), failed: false };
    let (feed, worker) = spawn(Box::new(store), wall(at(9, 0, 1)));
    let stats = worker.stats();
    feed.offer(at(9, 0, 2), &trade("005930_AL", "090002", "+71000", "+5"));
    feed.offer(at(9, 1, 5), &trade("000660_AL", "090105", "500000", "3"));
    feed.offer(at(9, 2, 1), &trade("000660_AL", "090201", "500100", "3"));
    drop(feed);
    worker.finish().await;
    assert_eq!(stats.store_errors(), 1);
    let samsung = lines_of(shared.path(), "005930");
    assert_eq!(samsung.iter().map(|line| (line.minute, line.trades.clone())).collect::<Vec<_>>(), [(541, vec![(32_402, 71_000, 5)])]);
    assert_eq!(minutes_of(shared.path(), "000660"), [541, 542]);
}
