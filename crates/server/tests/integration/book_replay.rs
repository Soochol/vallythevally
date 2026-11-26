use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::KstDate;
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::symbols::SymbolDirectory;
use support::ScriptedTransport;
use tower::ServiceExt;

const SAMSUNG_BUCKET: &str = "056.parquet";

fn at(hour: u32, minute: u32, second: u32) -> i64 {
    kst(KstDate::new(2026, 11, 23).unwrap(), hour, minute, second).unix() * 1000
}

struct Harness {
    app: Router,
    fake: ScriptedTransport,
    data: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(enabled: bool) -> Harness {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 24).unwrap(), 10, 0, 0));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let symbols = Arc::new(SymbolDirectory::default());
        let state = application(ApplicationInputs { rest, clock, symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        let data = tmp.path().join("hoga");
        if enabled {
            state.collector_paths.configure(server::shared_data::CollectorPaths::hoga_only(data.clone()));
        }
        Harness { app: router(state), fake, data, _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    fn day_folder(&self, date: &str) -> PathBuf {
        self.data.join("store").join(date)
    }
}

struct Book {
    symbol: &'static str,
    recv_ms: i64,
    best_ask: i64,
    quantity: i64,
}

fn book_sql(book: &Book) -> String {
    let mut columns = vec![format!("'{}' AS symbol", book.symbol), format!("{}::BIGINT AS recv_ms", book.recv_ms), "'090000' AS f21".to_owned()];
    for level in 0..10 {
        let priced = level < 2;
        let ask = if priced { (-(book.best_ask + level * 100)).to_string() } else { "NULL".to_owned() };
        let bid = if priced { (-(book.best_ask - 100 - level * 100)).to_string() } else { "0".to_owned() };
        let quantity = if priced { book.quantity + level } else { 0 };
        columns.push(format!("({ask})::BIGINT AS f{}", 41 + level));
        columns.push(format!("({bid})::BIGINT AS f{}", 51 + level));
        columns.push(format!("{quantity}::BIGINT AS f{}", 61 + level));
        columns.push(format!("{}::BIGINT AS f{}", quantity * 2, 71 + level));
    }
    columns.push(format!("{}::BIGINT AS f121", book.quantity * 10));
    columns.push(format!("{}::BIGINT AS f125", book.quantity * 20));
    format!("SELECT {}", columns.join(", "))
}

fn trade_sql(symbol: &str, recv_ms: i64, time: &str, price: i64, quantity: i64) -> String {
    format!("SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{time}' AS f20, ({price})::BIGINT AS f10, ({quantity})::BIGINT AS f15")
}

fn write_parquet(path: &Path, selects: &[String]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(&format!("SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)", selects.join(" UNION ALL "), path.display())).unwrap();
}

fn stock(code: &str, registered: bool, gaps: Value) -> Value {
    json!({"code": code, "planned": true, "key": "collect-01", "excluded": !registered, "suspended": false, "registered": registered, "received": registered, "messages": 5, "gaps": gaps, "handoff": null})
}

fn write_complete(folder: &Path, date: u32, stocks: Vec<Value>) {
    std::fs::create_dir_all(folder).unwrap();
    let complete = json!({
        "format_version": 1,
        "date": date,
        "verify": {"passed": true},
        "plan": null,
        "raw_files": {"collect-01/0900-000.jsonl.zst": 10, "collect-01/2000-000.jsonl.zst": 10, "collect-02/2005-000.jsonl.zst": 10},
        "stocks": stocks,
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn write_monday(harness: &Harness, gaps: Value) {
    let folder = harness.day_folder("20261123");
    write_complete(&folder, 20_261_123, vec![stock("005930", true, gaps), stock("000660", false, json!([]))]);
    let samsung = |recv_ms, best_ask, quantity| Book { symbol: "005930_AL", recv_ms, best_ask, quantity };
    let books = [
        Book { symbol: "000120_AL", recv_ms: at(9, 0, 55), best_ask: 90_000, quantity: 999 },
        samsung(at(9, 0, 10), 71_000, 10),
        samsung(at(9, 0, 50), 71_100, 20),
        samsung(at(9, 0, 50), 71_200, 30),
        samsung(at(9, 2, 30), 71_300, 40),
    ];
    write_parquet(&folder.join("0D").join(SAMSUNG_BUCKET), &books.iter().map(book_sql).collect::<Vec<_>>());
    let mut trades = vec![trade_sql("000120_AL", at(9, 0, 55), "090055", 90_000, 1)];
    for second in 1..=12 {
        trades.push(trade_sql("005930_AL", at(9, 0, second), &format!("0900{second:02}"), -71_000 - second as i64, if second % 2 == 0 { -i64::from(second) } else { i64::from(second) }));
    }
    trades.push(trade_sql("005930_AL", at(9, 0, 13), "090013", 71_000, 0));
    trades.push(trade_sql("005930_AL", at(9, 5, 1), "090501", 71_500, 7));
    write_parquet(&folder.join("0B").join(SAMSUNG_BUCKET), &trades);
}

#[tokio::test]
async fn a_closed_day_gives_the_last_book_and_the_last_trades_of_each_minute() {
    let harness = Harness::start(true).await;
    write_monday(&harness, json!([]));
    let (status, body) = harness.get("/api/symbols/005930/book-replay?date=20261123").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((&body["symbol"], &body["date"], &body["coverage"]), (&json!("005930"), &json!("20261123"), &json!("collected")));
    assert_eq!(
        body["books"],
        json!([
            {"minute": 540, "asks": [[71_200, 30], [71_300, 31]], "bids": [[71_100, 60], [71_000, 62]], "totalAsk": 300, "totalBid": 600},
            {"minute": 542, "asks": [[71_300, 40], [71_400, 41]], "bids": [[71_200, 80], [71_100, 82]], "totalAsk": 400, "totalBid": 800},
        ])
    );
    let mut expected: Vec<Value> = (3..=12).map(|second: i64| json!([540, 32_400 + second, 71_000 + second, if second % 2 == 0 { -second } else { second }])).collect();
    expected.push(json!([545, 32_701, 71_500, 7]));
    assert_eq!(body["trades"], Value::Array(expected));
    let (_, again) = harness.get("/api/symbols/005930/book-replay?date=20261123").await;
    assert_eq!(again, body);
    assert_eq!(harness.fake.requests(), 0);
}

#[tokio::test]
async fn covered_minutes_leave_out_the_minutes_that_ended_inside_a_gap() {
    let harness = Harness::start(true).await;
    write_monday(&harness, json!([{"from_ms": at(10, 1, 30), "to_ms": at(10, 3, 0)}]));
    let (status, body) = harness.get("/api/symbols/005930/book-replay?date=20261123").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["covered"], json!([[540, 600], [602, 1204]]));
}

#[tokio::test]
async fn a_day_without_complete_json_or_a_stock_that_was_not_registered_is_not_collected() {
    let harness = Harness::start(true).await;
    write_monday(&harness, json!([]));
    write_complete(&harness.day_folder("20261119"), 20_261_119, vec![stock("005930", true, json!([]))]);
    std::fs::create_dir_all(harness.day_folder("20261120")).unwrap();
    for date in ["20261122", "20261120"] {
        let (status, body) = harness.get(&format!("/api/symbols/005930/book-replay?date={date}")).await;
        assert_eq!((status, &body["coverage"]), (200, &json!("day_not_collected")), "{date} {body}");
        assert_eq!((&body["covered"], &body["books"], &body["trades"]), (&json!([]), &json!([]), &json!([])));
    }
    let (status, body) = harness.get("/api/symbols/000660/book-replay?date=20261123").await;
    assert_eq!((status, &body["coverage"]), (200, &json!("symbol_not_collected")));
    assert_eq!(harness.get("/api/symbols/005930/book-replay/days").await, (200, json!({"symbol": "005930", "days": ["20261119", "20261123"]})));
    assert_eq!(harness.get("/api/symbols/000660/book-replay/days").await, (200, json!({"symbol": "000660", "days": []})));
}

#[tokio::test]
async fn replay_is_off_without_a_data_folder() {
    let off = Harness::start(false).await;
    assert_eq!(off.get("/api/book-replay/access").await, (200, json!({"available": false})));
    for path in ["/api/symbols/005930/book-replay?date=20261123", "/api/symbols/005930/book-replay/days"] {
        let (status, body) = off.get(path).await;
        assert_eq!((status, &body["error"]["code"]), (404, &json!("not_found")), "{path} {body}");
    }
    let on = Harness::start(true).await;
    assert_eq!(on.get("/api/book-replay/access").await, (200, json!({"available": true})));
    for path in ["/api/symbols/005930/book-replay?date=2026-11-23", "/api/symbols/005930/book-replay", "/api/symbols/IDX:001/book-replay?date=20261123"] {
        let (status, body) = on.get(path).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{path} {body}");
    }
}
