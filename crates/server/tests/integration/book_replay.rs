use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tower::ServiceExt;

const SAMSUNG_BUCKET: &str = "056.parquet";

fn at(hour: u32, minute: u32, second: u32) -> i64 {
    kst(KstDate::new(2026, 11, 23).unwrap(), hour, minute, second).unix() * 1000
}

struct Harness {
    app: Router,
    fake: ScriptedTransport,
    symbols: Arc<SymbolDirectory>,
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
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let symbols = Arc::new(SymbolDirectory::default());
        let state = application(ApplicationInputs {
            rest,
            clock,
            symbols: Arc::clone(&symbols),
            db,
            screener_store: store,
            stream: (stream, events),
            static_dir: tmp.path().to_owned(),
            screener_update_on_connect: false,
        });
        let data = tmp.path().join("hoga");
        if enabled {
            state.collector_paths.configure(server::shared_data::CollectorPaths::hoga_only(data.clone()));
        }
        Harness { app: router(state), fake, symbols, data, _tmp: tmp }
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

fn detailed_trade_sql(symbol: &str, recv_ms: i64, time: &str, price: i64, quantity: i64, plus: bool, exchange: Option<&str>) -> String {
    let venue_sql = match exchange {
        Some(v) => format!("'{v}'::VARCHAR"),
        None => "CAST(NULL AS VARCHAR)".to_owned(),
    };
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{time}' AS f20, ({price})::BIGINT AS f10, ({quantity})::BIGINT AS f15, {plus}::BOOLEAN AS f15_plus, {venue_sql} AS f9081"
    )
}

struct ProgramSqlSpec<'a> {
    symbol: &'a str,
    recv_ms: i64,
    time: &'a str,
    price: Option<i64>,
    sell_qty: i64,
    buy_qty: i64,
    net_qty: i64,
    net_change: i64,
    net_amt_million: i64,
}

fn program_sql(spec: ProgramSqlSpec<'_>) -> String {
    let price_sql = match spec.price {
        Some(p) => format!("({p})::BIGINT"),
        None => "CAST(NULL AS BIGINT)".to_owned(),
    };
    format!(
        "SELECT '{}' AS symbol, {}::BIGINT AS recv_ms, '{}' AS f20, {price_sql} AS f10, ({})::BIGINT AS f202, 0::BIGINT AS f204, ({})::BIGINT AS f206, 0::BIGINT AS f208, ({})::BIGINT AS f210, ({})::BIGINT AS f211, ({})::BIGINT AS f212, 0::BIGINT AS f213",
        spec.symbol, spec.recv_ms, spec.time, spec.sell_qty, spec.buy_qty, spec.net_qty, spec.net_change, spec.net_amt_million
    )
}

#[tokio::test]
async fn closed_day_trades_filter_by_cutoff_venue_min_won_and_limit() {
    let harness = Harness::start(true).await;
    harness.symbols.replace(Directory::build(vec![
        SymbolInfo { symbol: Symbol::parse("005930").unwrap(), name: "삼성전자".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true },
        SymbolInfo { symbol: Symbol::parse("035420").unwrap(), name: "NAVER".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: false },
    ]));
    let folder = harness.day_folder("20261123");
    let gaps = json!([{"from_ms": at(9, 10, 0), "to_ms": at(9, 12, 30)}]);
    write_complete(
        &folder,
        20_261_123,
        vec![
            stock("005930", true, gaps),
            stock("035420", true, json!([])),
            stock("000660", false, json!([])),
        ],
    );

    let samsung_trades = vec![
        detailed_trade_sql("005930_AL", at(9, 0, 5), "090005", 100_000, 1_100, true, Some("KRX")),
        detailed_trade_sql("005930_AL", at(9, 1, 10), "090110", 100_000, 400, true, Some("NXT")),
        detailed_trade_sql("005930_AL", at(9, 2, 0), "090200", 100_000, -500, false, Some("KRX")),
        detailed_trade_sql("005930_AL", at(9, 2, 10) + 999, "090210", 100_000, 100, false, None),
        detailed_trade_sql("005930_AL", at(9, 2, 11), "090211", 100_000, 999, true, Some("KRX")),
    ];
    write_parquet(&folder.join("0B").join(SAMSUNG_BUCKET), &samsung_trades);

    let naver_bucket = format!("{:03}.parquet", fnv1a_test_bucket("035420_AL"));
    let naver_trades = vec![
        detailed_trade_sql("035420_AL", at(9, 0, 1), "090001", 200_000, 10, true, Some("KRX")),
        detailed_trade_sql("035420_AL", at(9, 0, 2), "090002", 200_000, 5, true, Some("NXT")),
    ];
    write_parquet(&folder.join("0B").join(&naver_bucket), &naver_trades);

    let (status, body) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32530").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["symbol"], json!("005930"));
    assert_eq!(body["date"], json!("20261123"));
    assert_eq!(body["coverage"], json!("collected"));
    assert_eq!(body["venue"], json!("combined"));
    assert_eq!(body["gaps"], json!([[kst(KstDate::new(2026, 11, 23).unwrap(), 9, 10, 0).unix(), kst(KstDate::new(2026, 11, 23).unwrap(), 9, 12, 30).unix()]]));
    assert_eq!(body["cumVolume"], json!(2_100));
    assert_eq!(body["cumBuyQty"], json!(1_500));
    assert_eq!(body["cumSellQty"], json!(500));
    assert_eq!(body["strength"], json!(300.0));
    assert_eq!(
        body["trades"],
        json!([
            {"secondOfDay": 32_530, "price": 100_000, "quantity": 100, "side": "none", "venue": null},
            {"secondOfDay": 32_520, "price": 100_000, "quantity": 500, "side": "sell", "venue": "krx"},
            {"secondOfDay": 32_470, "price": 100_000, "quantity": 400, "side": "buy", "venue": "nxt"},
            {"secondOfDay": 32_405, "price": 100_000, "quantity": 1_100, "side": "buy", "venue": "krx"},
        ])
    );

    let (status, capped) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32530&limit=2").await;
    assert_eq!(status, 200, "{capped}");
    assert_eq!(capped["cumVolume"], json!(2_100));
    assert_eq!(capped["trades"].as_array().unwrap().len(), 2);
    assert_eq!(capped["trades"][0]["secondOfDay"], json!(32_530));
    assert_eq!(capped["trades"][1]["secondOfDay"], json!(32_520));

    let (status, krx) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32530&venue=krx").await;
    assert_eq!(status, 200, "{krx}");
    assert_eq!(krx["venue"], json!("krx"));
    assert_eq!(krx["cumVolume"], json!(1_700));
    assert_eq!(krx["cumBuyQty"], json!(1_100));
    assert_eq!(krx["cumSellQty"], json!(500));
    assert!((krx["strength"].as_f64().unwrap() - 220.0).abs() < 1e-9, "{krx}");
    assert_eq!(krx["trades"].as_array().unwrap().len(), 3);

    let (status, nxt) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32530&venue=nxt").await;
    assert_eq!(status, 200, "{nxt}");
    assert_eq!(nxt["venue"], json!("nxt"));
    assert_eq!(nxt["cumVolume"], json!(400));
    assert_eq!(nxt["cumBuyQty"], json!(400));
    assert_eq!(nxt["cumSellQty"], json!(0));
    assert_eq!(nxt["strength"], json!(500.0));
    assert_eq!(nxt["trades"].as_array().unwrap().len(), 1);

    let (status, fallback) = harness.get("/api/symbols/035420/book-replay/trades?date=20261123&untilSec=32530&venue=nxt").await;
    assert_eq!(status, 200, "{fallback}");
    assert_eq!(fallback["venue"], json!("combined"));
    assert_eq!(fallback["cumVolume"], json!(15));
    assert_eq!(fallback["strength"], json!(500.0));
    assert_eq!(fallback["trades"].as_array().unwrap().len(), 2);

    let (status, min30) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32530&minWon=30000000").await;
    assert_eq!(status, 200, "{min30}");
    assert_eq!(min30["cumVolume"], json!(2_100));
    assert_eq!(min30["trades"].as_array().unwrap().len(), 3);

    let (status, min100) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32530&minWon=100000000").await;
    assert_eq!(status, 200, "{min100}");
    assert_eq!(min100["cumVolume"], json!(2_100));
    assert_eq!(
        min100["trades"],
        json!([{"secondOfDay": 32_405, "price": 100_000, "quantity": 1_100, "side": "buy", "venue": "krx"}])
    );

    let (status, early) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32400").await;
    assert_eq!(status, 200, "{early}");
    assert_eq!((&early["cumVolume"], &early["strength"], &early["trades"]), (&json!(0), &json!(null), &json!([])));

    let (status, missing_sym) = harness.get("/api/symbols/000660/book-replay/trades?date=20261123&untilSec=32530").await;
    assert_eq!((status, &missing_sym["coverage"]), (200, &json!("symbol_not_collected")));

    let (status, missing_day) = harness.get("/api/symbols/005930/book-replay/trades?date=20261122&untilSec=32530").await;
    assert_eq!((status, &missing_day["coverage"]), (200, &json!("day_not_collected")));

    let unsupported = harness.day_folder("20261121");
    std::fs::create_dir_all(&unsupported).unwrap();
    std::fs::write(unsupported.join("complete.json"), r#"{"format_version":99,"stocks":[]}"#).unwrap();
    let (status, bad_ver) = harness.get("/api/symbols/005930/book-replay/trades?date=20261121&untilSec=32530").await;
    assert_eq!((status, &bad_ver["coverage"]), (200, &json!("day_not_collected")));
}

#[tokio::test]
async fn closed_day_program_returns_rows_gaps_and_coverage() {
    let harness = Harness::start(true).await;
    let folder = harness.day_folder("20261123");
    let gaps = json!([{"from_ms": at(10, 0, 0), "to_ms": at(10, 5, 0)}]);
    write_complete(&folder, 20_261_123, vec![stock("005930", true, gaps), stock("000660", false, json!([]))]);
    let rows = vec![
        program_sql(ProgramSqlSpec {
            symbol: "005930_AL",
            recv_ms: at(9, 0, 30),
            time: "090030",
            price: Some(71_000),
            sell_qty: 100,
            buy_qty: 350,
            net_qty: 250,
            net_change: 250,
            net_amt_million: 18,
        }),
        program_sql(ProgramSqlSpec {
            symbol: "005930_AL",
            recv_ms: at(9, 1, 0),
            time: "090100",
            price: None,
            sell_qty: 200,
            buy_qty: 350,
            net_qty: 150,
            net_change: -100,
            net_amt_million: 11,
        }),
    ];
    write_parquet(&folder.join("0w").join(SAMSUNG_BUCKET), &rows);

    let (status, body) = harness.get("/api/symbols/005930/book-replay/program?date=20261123").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["symbol"], json!("005930"));
    assert_eq!(body["date"], json!("20261123"));
    assert_eq!(body["coverage"], json!("collected"));
    assert_eq!(body["gaps"], json!([[kst(KstDate::new(2026, 11, 23).unwrap(), 10, 0, 0).unix(), kst(KstDate::new(2026, 11, 23).unwrap(), 10, 5, 0).unix()]]));
    assert_eq!(
        body["rows"],
        json!([
            {"secondOfDay": 32_430, "price": 71_000, "buyQty": 350, "sellQty": 100, "netQty": 250, "netQtyChange": 250, "netAmountMillionWon": 18},
            {"secondOfDay": 32_460, "price": null, "buyQty": 350, "sellQty": 200, "netQty": 150, "netQtyChange": -100, "netAmountMillionWon": 11},
        ])
    );

    let (status, missing_sym) = harness.get("/api/symbols/000660/book-replay/program?date=20261123").await;
    assert_eq!((status, &missing_sym["coverage"]), (200, &json!("symbol_not_collected")));

    let (status, missing_day) = harness.get("/api/symbols/005930/book-replay/program?date=20261122").await;
    assert_eq!((status, &missing_day["coverage"]), (200, &json!("day_not_collected")));
}

#[tokio::test]
async fn trades_and_program_validate_inputs_and_respect_disabled_flag() {
    let off = Harness::start(false).await;
    for path in [
        "/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32400",
        "/api/symbols/005930/book-replay/program?date=20261123",
    ] {
        let (status, body) = off.get(path).await;
        assert_eq!((status, &body["error"]["code"]), (404, &json!("not_found")), "{path} {body}");
    }

    let on = Harness::start(true).await;
    for path in [
        "/api/symbols/005930/book-replay/trades?date=20261123",
        "/api/symbols/005930/book-replay/trades?date=20261123&untilSec=86400",
        "/api/symbols/005930/book-replay/trades?date=20261123&untilSec=-1",
        "/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32400&venue=other",
        "/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32400&minWon=-5",
        "/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32400&limit=0",
        "/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32400&limit=501",
        "/api/symbols/005930/book-replay/trades?date=2026-11-23&untilSec=32400",
        "/api/symbols/IDX:001/book-replay/trades?date=20261123&untilSec=32400",
        "/api/symbols/005930/book-replay/program",
        "/api/symbols/005930/book-replay/program?date=bad",
        "/api/symbols/IDX:001/book-replay/program?date=20261123",
    ] {
        let (status, body) = on.get(path).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{path} {body}");
    }
}

#[tokio::test]
async fn closed_day_trades_cutoff_aligns_on_hhmmss_despite_recv_skew() {
    let harness = Harness::start(true).await;
    let folder = harness.day_folder("20261123");
    write_complete(&folder, 20_261_123, vec![stock("005930", true, json!([]))]);
    let trades = vec![
        detailed_trade_sql("005930_AL", at(9, 1, 0) + 200, "090100", 100_000, 100, true, Some("KRX")),
        detailed_trade_sql("005930_AL", at(9, 1, 0) + 950, "090101", 100_000, 500, true, Some("KRX")),
        detailed_trade_sql("005930_AL", at(9, 1, 5) + 400, "090100", 100_000, -200, false, Some("KRX")),
        detailed_trade_sql("005930_AL", at(9, 1, 6), "090106", 100_000, 900, true, Some("KRX")),
    ];
    write_parquet(&folder.join("0B").join(SAMSUNG_BUCKET), &trades);

    let (status, body) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32460").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["cumVolume"], json!(300));
    assert_eq!(body["cumBuyQty"], json!(100));
    assert_eq!(body["cumSellQty"], json!(200));
    assert_eq!(body["strength"], json!(50.0));
    assert_eq!(
        body["trades"],
        json!([
            {"secondOfDay": 32_460, "price": 100_000, "quantity": 200, "side": "sell", "venue": "krx"},
            {"secondOfDay": 32_460, "price": 100_000, "quantity": 100, "side": "buy", "venue": "krx"},
        ])
    );

    let (status, next) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32461").await;
    assert_eq!(status, 200, "{next}");
    assert_eq!(next["cumVolume"], json!(800));
    assert_eq!(next["cumBuyQty"], json!(600));
    assert_eq!(next["cumSellQty"], json!(200));
}

#[tokio::test]
async fn closed_day_trades_krx_includes_legacy_parquet_without_f9081() {
    let harness = Harness::start(true).await;
    harness.symbols.replace(Directory::build(vec![
        SymbolInfo { symbol: Symbol::parse("005930").unwrap(), name: "삼성전자".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true },
    ]));
    let folder = harness.day_folder("20261123");
    write_complete(&folder, 20_261_123, vec![stock("005930", true, json!([]))]);
    let trades = vec![
        format!(
            "SELECT '005930_AL' AS symbol, {}::BIGINT AS recv_ms, '090010' AS f20, 71000::BIGINT AS f10, 300::BIGINT AS f15, true::BOOLEAN AS f15_plus",
            at(9, 0, 10)
        ),
        format!(
            "SELECT '005930_AL' AS symbol, {}::BIGINT AS recv_ms, '090020' AS f20, 71000::BIGINT AS f10, (-100)::BIGINT AS f15, false::BOOLEAN AS f15_plus",
            at(9, 0, 20)
        ),
    ];
    write_parquet(&folder.join("0B").join(SAMSUNG_BUCKET), &trades);

    let (status, krx) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32430&venue=krx").await;
    assert_eq!(status, 200, "{krx}");
    assert_eq!(krx["cumVolume"], json!(400));
    assert_eq!(krx["cumBuyQty"], json!(300));
    assert_eq!(krx["cumSellQty"], json!(100));
    assert_eq!(krx["strength"], json!(300.0));
    assert_eq!(krx["trades"].as_array().unwrap().len(), 2);

    let (status, nxt) = harness.get("/api/symbols/005930/book-replay/trades?date=20261123&untilSec=32430&venue=nxt").await;
    assert_eq!(status, 200, "{nxt}");
    assert_eq!(nxt["cumVolume"], json!(0));
    assert_eq!(nxt["trades"], json!([]));
}

#[tokio::test]
async fn brokers_day_reports_coverage_for_collected_missing_symbol_and_missing_day() {
    let harness = Harness::start(true).await;
    let folder = harness.day_folder("20261123");
    write_complete(&folder, 20_261_123, vec![stock("005930", true, json!([])), stock("000660", false, json!([]))]);

    let (status, collected) = harness.get("/api/symbols/005930/brokers?date=20261123").await;
    assert_eq!(status, 200, "{collected}");
    assert_eq!((&collected["source"], &collected["coverage"]), (&json!("store"), &json!("collected")));

    let (status, missing_sym) = harness.get("/api/symbols/000660/brokers?date=20261123").await;
    assert_eq!(status, 200, "{missing_sym}");
    assert_eq!((&missing_sym["source"], &missing_sym["coverage"]), (&json!("none"), &json!("symbol_not_collected")));

    let (status, missing_day) = harness.get("/api/symbols/005930/brokers?date=20261122").await;
    assert_eq!(status, 200, "{missing_day}");
    assert_eq!((&missing_day["source"], &missing_day["coverage"]), (&json!("none"), &json!("day_not_collected")));
}

fn fnv1a_test_bucket(symbol: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in symbol.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash % 64
}
