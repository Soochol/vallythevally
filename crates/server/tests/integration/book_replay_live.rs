use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::KstDate;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::shared_data::{
    CollectorPaths, CurrentQuotes, DataKind, FeedWriter, FlowDescription, FlowRow, FlowWriter, Header, Ladder, LevelQty, LiveQuoteWriter, QuoteMinute, SnapshotBody, SnapshotRow, TradeMinuteLine,
    VenueQuote, flow_links_path, flow_path, trade_minute_path, write_snapshot,
};
use server::symbols::SymbolDirectory;
use support::ScriptedTransport;
use tower::ServiceExt;

const DATE: &str = "20261124";

fn today() -> KstDate {
    KstDate::new(2026, 11, 24).unwrap()
}

fn at(hour: u32, minute: u32, second: u32) -> i64 {
    kst(today(), hour, minute, second).unix() * 1000
}

async fn start_with_paths(tmp: &Path, separate_shared: bool) -> (Router, PathBuf, PathBuf) {
    let fake = ScriptedTransport::new();
    let clock = Clock::fake(kst(today(), 10, 0, 0));
    let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
    let db = crate::support::template_db::open_app_db(&tmp.join("db.sqlite")).await;
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, events) = tokio::sync::mpsc::channel(1);
    let store = crate::support::template_db::open_screener_store(&tmp.join("screener.duckdb"));
    let state = application(ApplicationInputs { rest, clock, symbols: Arc::new(SymbolDirectory::default()), db, screener_store: store, stream: (stream, events), static_dir: tmp.to_owned(), screener_update_on_connect: false });
    let data = tmp.join("hoga");
    std::fs::create_dir_all(&data).unwrap();
    let shared = if separate_shared {
        let external = tmp.join("external-shared");
        state.collector_paths.configure(CollectorPaths::new(Some(data.clone()), Some(external.clone())));
        external
    } else {
        state.collector_paths.configure(CollectorPaths::hoga_only(data.clone()));
        data.join("shared")
    };
    (router(state), data, shared)
}

async fn start(tmp: &Path) -> (Router, PathBuf) {
    let (app, data, _) = start_with_paths(tmp, false).await;
    (app, data)
}

async fn get(app: &Router, path: &str) -> (u16, Value) {
    let response = app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
}

async fn day_of(app: &Router, code: &str) -> Value {
    let (status, body) = get(app, &format!("/api/symbols/{code}/book-replay?date={DATE}")).await;
    assert_eq!(status, 200, "{body}");
    body
}

fn quote(minute: u16, best_ask: i64) -> QuoteMinute {
    let ladder = |qty| Ladder { asks: vec![LevelQty(best_ask, qty), LevelQty(best_ask + 100, qty + 1)], bids: vec![LevelQty(best_ask - 100, qty * 2)] };
    QuoteMinute {
        minute,
        close_sec: u32::from(minute) * 60 + 59,
        single_price: false,
        combined: VenueQuote { close: ladder(10), peak: ladder(999), price_max: ladder(998) },
        krx: VenueQuote { close: ladder(7), ..VenueQuote::default() },
        nxt: VenueQuote { close: ladder(3), ..VenueQuote::default() },
    }
}

fn write_links(shared: &Path, key: &str, events: &[(i64, &str)]) {
    let path = flow_links_path(shared, DATE, key);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: String = events.iter().map(|(t, event)| format!("{}\n", json!({"t": t, "event": event}))).collect();
    std::fs::write(path, text).unwrap();
}

type MinuteTrades<'a> = (u16, &'a [(u32, u64, i64)]);

fn write_trades(shared: &Path, key: &str, code: &str, lines: &[MinuteTrades<'_>]) {
    let mut writer = FeedWriter::open_at(&trade_minute_path(shared, DATE, key, code), Header::new(DataKind::TradeMinute, today(), 1, 1, Vec::new())).unwrap();
    for (minute, trades) in lines {
        writer.append(&TradeMinuteLine { minute: *minute, trades: trades.to_vec() }).unwrap();
    }
}

#[tokio::test]
async fn today_joins_the_minute_quotes_and_trades_until_the_day_is_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, data) = start(tmp.path()).await;
    let shared = data.join("shared");
    assert_eq!(day_of(&app, "005930").await["coverage"], json!("day_not_collected"));

    let mut first = LiveQuoteWriter::open(&shared, DATE, "collect-01", 1).unwrap();
    first.append_minute("005930", &quote(540, 71_000)).unwrap();
    first.append_minute("005930", &quote(541, 71_100)).unwrap();
    first.append_minute("000660", &quote(541, 500_000)).unwrap();
    let mut current = CurrentQuotes::default();
    current.minutes.insert("005930".to_owned(), quote(542, 71_200));
    first.write_current(&current, 1).unwrap();
    write_links(&shared, "collect-01", &[(at(8, 55, 0), "start"), (at(8, 55, 2), "live"), (at(9, 1, 0), "alive"), (at(9, 2, 20), "alive")]);
    write_trades(&shared, "collect-01", "005930", &[(540, &[(32_401, 71_000, 3), (32_402, 71_010, -4)]), (541, &[(32_465, 71_150, -2)]), (542, &[(32_525, 71_200, 9)])]);

    let body = day_of(&app, "005930").await;
    assert_eq!(body["coverage"], json!("collected"));
    assert_eq!(body["covered"], json!([[540, 541]]));
    assert_eq!(
        body["books"],
        json!([
            {"minute": 540, "asks": [[71_000, 10], [71_100, 11]], "bids": [[70_900, 20]], "totalAsk": 21, "totalBid": 20},
            {"minute": 541, "asks": [[71_100, 10], [71_200, 11]], "bids": [[71_000, 20]], "totalAsk": 21, "totalBid": 20},
        ])
    );
    assert_eq!(body["trades"], json!([[540, 32_401, 71_000, 3], [540, 32_402, 71_010, -4], [541, 32_465, 71_150, -2]]));
    assert_eq!(day_of(&app, "035420").await["coverage"], json!("symbol_not_collected"));
    assert_eq!(get(&app, "/api/symbols/005930/book-replay/days").await.1["days"], json!([DATE]));
    assert_eq!(get(&app, "/api/symbols/035420/book-replay/days").await.1["days"], json!([]));

    let folder = data.join("store").join(DATE);
    std::fs::create_dir_all(&folder).unwrap();
    let complete = json!({"format_version": 1, "date": 20_261_124, "raw_files": {}, "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": [], "handoff": null}]});
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
    let closed = day_of(&app, "005930").await;
    assert_eq!((&closed["coverage"], &closed["books"]), (&json!("collected"), &json!([])));
    assert_eq!(get(&app, "/api/symbols/005930/book-replay/days").await.1["days"], json!([DATE]));
}

#[tokio::test]
async fn covered_minutes_follow_the_link_records_of_the_keys_that_hold_the_stock() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, data) = start(tmp.path()).await;
    let shared = data.join("shared");
    let mut first = LiveQuoteWriter::open(&shared, DATE, "collect-01", 1).unwrap();
    first.append_minute("005930", &quote(540, 71_000)).unwrap();
    first.append_minute("005930", &quote(546, 71_600)).unwrap();
    let mut spare = LiveQuoteWriter::open(&shared, DATE, "spare-01", 1).unwrap();
    spare.append_minute("005930", &quote(552, 72_000)).unwrap();
    let mut other = LiveQuoteWriter::open(&shared, DATE, "collect-02", 1).unwrap();
    other.append_minute("000660", &quote(540, 500_000)).unwrap();

    write_links(
        &shared,
        "collect-01",
        &[
            (at(9, 0, 0), "start"),
            (at(9, 0, 1), "live"),
            (at(9, 2, 0), "alive"),
            (at(9, 2, 40), "down"),
            (at(9, 3, 30), "alive"),
            (at(9, 4, 20), "live"),
            (at(9, 6, 10), "alive"),
            (at(9, 9, 0), "start"),
            (at(9, 9, 30), "end"),
        ],
    );
    write_links(&shared, "spare-01", &[(at(8, 55, 0), "start"), (at(8, 55, 1), "live"), (at(9, 11, 30), "alive"), (at(9, 14, 14), "alive")]);
    write_links(&shared, "collect-02", &[(at(8, 55, 0), "start"), (at(8, 55, 1), "live"), (at(9, 30, 0), "alive")]);

    let body = day_of(&app, "005930").await;
    assert_eq!(body["covered"], json!([[540, 541], [544, 544], [552, 552]]), "{body}");
}

#[tokio::test]
async fn live_replay_reads_from_separate_shared_data_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, _data, shared) = start_with_paths(tmp.path(), true).await;
    let mut writer = LiveQuoteWriter::open(&shared, DATE, "collect-01", 1).unwrap();
    writer.append_minute("005930", &quote(540, 71_000)).unwrap();
    write_links(&shared, "collect-01", &[(at(8, 55, 0), "start"), (at(8, 55, 2), "live"), (at(9, 1, 20), "alive")]);
    write_trades(&shared, "collect-01", "005930", &[(540, &[(32_401, 71_000, 3)])]);

    let body = day_of(&app, "005930").await;
    assert_eq!(body["coverage"], json!("collected"));
    assert_eq!(body["covered"], json!([[540, 540]]));
    assert_eq!(body["books"].as_array().unwrap().len(), 1);
    assert_eq!(body["trades"], json!([[540, 32_401, 71_000, 3]]));
    assert_eq!(get(&app, "/api/symbols/005930/book-replay/days").await.1["days"], json!([DATE]));
}

fn write_trade_flow(shared: &Path, key: &str, code: &str, rows: Vec<FlowRow>) {
    let fids = [20, 10, 15, 1313, 9081];
    let path = flow_path(shared, DATE, "0B", code, key);
    FlowWriter::open(&path, FlowDescription::new("0B", code, DATE, key, &fids))
        .unwrap()
        .append(&rows)
        .unwrap();
}

fn write_program_flow(shared: &Path, key: &str, code: &str, rows: Vec<FlowRow>) {
    let fids = [20, 10, 202, 204, 206, 208, 210, 211, 212, 213];
    let path = flow_path(shared, DATE, "0w", code, key);
    FlowWriter::open(&path, FlowDescription::new("0w", code, DATE, key, &fids))
        .unwrap()
        .append(&rows)
        .unwrap();
}

fn trade_flow_row(recv_ms: i64, hhmmss: &str, price: &str, qty: &str, exchange: Option<&str>) -> FlowRow {
    FlowRow {
        recv_ms,
        values: vec![
            Some(hhmmss.to_owned()),
            Some(price.to_owned()),
            Some(qty.to_owned()),
            None,
            exchange.map(str::to_owned),
        ],
    }
}

struct ProgramFlowSpec<'a> {
    recv_ms: i64,
    hhmmss: &'a str,
    price: Option<&'a str>,
    sell_qty: &'a str,
    buy_qty: &'a str,
    net_qty: &'a str,
    net_change: &'a str,
    net_amt_million: &'a str,
}

fn program_flow_row(spec: ProgramFlowSpec<'_>) -> FlowRow {
    FlowRow {
        recv_ms: spec.recv_ms,
        values: vec![
            Some(spec.hhmmss.to_owned()),
            spec.price.map(str::to_owned),
            Some(spec.sell_qty.to_owned()),
            Some("0".to_owned()),
            Some(spec.buy_qty.to_owned()),
            Some("0".to_owned()),
            Some(spec.net_qty.to_owned()),
            Some(spec.net_change.to_owned()),
            Some(spec.net_amt_million.to_owned()),
            Some("0".to_owned()),
        ],
    }
}

#[tokio::test]
async fn live_today_trades_and_program_read_symbol_flow_and_report_coverage() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, data) = start(tmp.path()).await;
    let shared = data.join("shared");

    let (status, empty_trades) = get(&app, &format!("/api/symbols/005930/book-replay/trades?date={DATE}&untilSec=32500")).await;
    assert_eq!((status, &empty_trades["coverage"]), (200, &json!("day_not_collected")), "{empty_trades}");
    let (status, empty_program) = get(&app, &format!("/api/symbols/005930/book-replay/program?date={DATE}")).await;
    assert_eq!((status, &empty_program["coverage"]), (200, &json!("day_not_collected")), "{empty_program}");

    write_links(&shared, "collect-01", &[(at(8, 0, 0), "live"), (at(9, 10, 0), "down"), (at(9, 12, 0), "live"), (at(9, 59, 50), "alive")]);
    write_trade_flow(
        &shared,
        "collect-01",
        "005930",
        vec![
            trade_flow_row(at(9, 0, 10), "090010", "100000", "+500", Some("KRX")),
            trade_flow_row(at(9, 1, 0), "090100", "100000", "-200", Some("NXT")),
            trade_flow_row(at(9, 1, 5) + 999, "090105", "100000", "+100", Some("KRX")),
            trade_flow_row(at(9, 1, 6), "090106", "100000", "+900", Some("KRX")),
        ],
    );
    write_program_flow(
        &shared,
        "collect-01",
        "005930",
        vec![
            program_flow_row(ProgramFlowSpec {
                recv_ms: at(9, 0, 30),
                hhmmss: "090030",
                price: Some("71000"),
                sell_qty: "100",
                buy_qty: "400",
                net_qty: "300",
                net_change: "300",
                net_amt_million: "21",
            }),
            program_flow_row(ProgramFlowSpec {
                recv_ms: at(9, 1, 30),
                hhmmss: "090130",
                price: None,
                sell_qty: "250",
                buy_qty: "450",
                net_qty: "200",
                net_change: "-100",
                net_amt_million: "14",
            }),
        ],
    );

    let expected_gap = json!([[kst(today(), 9, 10, 0).unix(), kst(today(), 9, 12, 0).unix()]]);

    let (status, trades) = get(&app, &format!("/api/symbols/005930/book-replay/trades?date={DATE}&untilSec=32465")).await;
    assert_eq!(status, 200, "{trades}");
    assert_eq!(trades["coverage"], json!("collected"));
    assert_eq!(trades["venue"], json!("combined"));
    assert_eq!(trades["gaps"], expected_gap);
    assert_eq!(trades["cumVolume"], json!(800));
    assert_eq!(trades["cumBuyQty"], json!(600));
    assert_eq!(trades["cumSellQty"], json!(200));
    assert_eq!(trades["strength"], json!(300.0));
    assert_eq!(
        trades["trades"],
        json!([
            {"secondOfDay": 32_465, "price": 100_000, "quantity": 100, "side": "buy", "venue": "krx"},
            {"secondOfDay": 32_460, "price": 100_000, "quantity": 200, "side": "sell", "venue": "nxt"},
            {"secondOfDay": 32_410, "price": 100_000, "quantity": 500, "side": "buy", "venue": "krx"},
        ])
    );

    let (status, big_trades) = get(&app, &format!("/api/symbols/005930/book-replay/trades?date={DATE}&untilSec=32465&minWon=30000000")).await;
    assert_eq!(status, 200, "{big_trades}");
    assert_eq!(big_trades["cumVolume"], json!(800));
    assert_eq!(
        big_trades["trades"],
        json!([{"secondOfDay": 32_410, "price": 100_000, "quantity": 500, "side": "buy", "venue": "krx"}])
    );

    let (status, nxt_trades) = get(&app, &format!("/api/symbols/005930/book-replay/trades?date={DATE}&untilSec=32465&venue=nxt")).await;
    assert_eq!(status, 200, "{nxt_trades}");
    assert_eq!(nxt_trades["venue"], json!("nxt"));
    assert_eq!(nxt_trades["cumVolume"], json!(200));
    assert_eq!(nxt_trades["cumBuyQty"], json!(0));
    assert_eq!(nxt_trades["cumSellQty"], json!(200));
    assert_eq!(nxt_trades["strength"], json!(0.0));

    let (status, prog) = get(&app, &format!("/api/symbols/005930/book-replay/program?date={DATE}")).await;
    assert_eq!(status, 200, "{prog}");
    assert_eq!(prog["coverage"], json!("collected"));
    assert_eq!(prog["gaps"], expected_gap);
    assert_eq!(
        prog["rows"],
        json!([
            {"secondOfDay": 32_430, "price": 71_000, "buyQty": 400, "sellQty": 100, "netQty": 300, "netQtyChange": 300, "netAmountMillionWon": 21},
            {"secondOfDay": 32_490, "price": null, "buyQty": 450, "sellQty": 250, "netQty": 200, "netQtyChange": -100, "netAmountMillionWon": 14},
        ])
    );

    let (status, missing_trade_sym) = get(&app, &format!("/api/symbols/035420/book-replay/trades?date={DATE}&untilSec=32465")).await;
    assert_eq!((status, &missing_trade_sym["coverage"]), (200, &json!("symbol_not_collected")), "{missing_trade_sym}");
    let (status, missing_prog_sym) = get(&app, &format!("/api/symbols/035420/book-replay/program?date={DATE}")).await;
    assert_eq!((status, &missing_prog_sym["coverage"]), (200, &json!("symbol_not_collected")), "{missing_prog_sym}");
}

#[tokio::test]
async fn live_today_marks_symbol_not_collected_when_only_quote_minutes_live_exists() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, data) = start(tmp.path()).await;
    let shared = data.join("shared");
    let mut writer = LiveQuoteWriter::open(&shared, DATE, "collect-01", 1).unwrap();
    writer.append_minute("005930", &quote(540, 71_000)).unwrap();

    let (status, trades) = get(&app, &format!("/api/symbols/035420/book-replay/trades?date={DATE}&untilSec=32460")).await;
    assert_eq!((status, &trades["coverage"]), (200, &json!("symbol_not_collected")), "{trades}");
    let (status, prog) = get(&app, &format!("/api/symbols/035420/book-replay/program?date={DATE}")).await;
    assert_eq!((status, &prog["coverage"]), (200, &json!("symbol_not_collected")), "{prog}");
}

#[tokio::test]
async fn live_today_collected_quote_stock_without_flow_reports_collected_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, data) = start(tmp.path()).await;
    let shared = data.join("shared");
    let mut writer = LiveQuoteWriter::open(&shared, DATE, "collect-01", 1).unwrap();
    writer.append_minute("005930", &quote(540, 71_000)).unwrap();

    let (status, prog) = get(&app, &format!("/api/symbols/005930/book-replay/program?date={DATE}")).await;
    assert_eq!(status, 200, "{prog}");
    assert_eq!((&prog["coverage"], &prog["rows"]), (&json!("collected"), &json!([])));

    let (status, trades) = get(&app, &format!("/api/symbols/005930/book-replay/trades?date={DATE}&untilSec=32460")).await;
    assert_eq!(status, 200, "{trades}");
    assert_eq!((&trades["coverage"], &trades["cumVolume"], &trades["trades"]), (&json!("collected"), &json!(0), &json!([])));
}

#[tokio::test]
async fn live_program_replay_orders_rows_monotonically_by_second_of_day() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, data) = start(tmp.path()).await;
    let shared = data.join("shared");
    write_links(&shared, "collect-01", &[(at(8, 0, 0), "live"), (at(9, 59, 50), "alive")]);
    write_links(&shared, "spare-01", &[(at(8, 0, 0), "live"), (at(9, 59, 50), "alive")]);
    write_program_flow(
        &shared,
        "collect-01",
        "005930",
        vec![
            program_flow_row(ProgramFlowSpec {
                recv_ms: at(9, 0, 31) + 100,
                hhmmss: "090031",
                price: Some("71100"),
                sell_qty: "100",
                buy_qty: "200",
                net_qty: "100",
                net_change: "100",
                net_amt_million: "7",
            }),
            program_flow_row(ProgramFlowSpec {
                recv_ms: at(9, 0, 31) + 300,
                hhmmss: "090031",
                price: Some("71200"),
                sell_qty: "100",
                buy_qty: "250",
                net_qty: "150",
                net_change: "50",
                net_amt_million: "10",
            }),
        ],
    );
    write_program_flow(
        &shared,
        "spare-01",
        "005930",
        vec![program_flow_row(ProgramFlowSpec {
            recv_ms: at(9, 0, 31) + 200,
            hhmmss: "090030",
            price: Some("71000"),
            sell_qty: "100",
            buy_qty: "150",
            net_qty: "50",
            net_change: "50",
            net_amt_million: "3",
        })],
    );

    let (status, prog) = get(&app, &format!("/api/symbols/005930/book-replay/program?date={DATE}")).await;
    assert_eq!(status, 200, "{prog}");
    assert_eq!(prog["coverage"], json!("collected"));
    assert_eq!(
        prog["rows"],
        json!([
            {"secondOfDay": 32_430, "price": 71_000, "buyQty": 150, "sellQty": 100, "netQty": 50, "netQtyChange": 50, "netAmountMillionWon": 3},
            {"secondOfDay": 32_431, "price": 71_100, "buyQty": 200, "sellQty": 100, "netQty": 100, "netQtyChange": 100, "netAmountMillionWon": 7},
            {"secondOfDay": 32_431, "price": 71_200, "buyQty": 250, "sellQty": 100, "netQty": 150, "netQtyChange": 50, "netAmountMillionWon": 10},
        ])
    );
}

#[tokio::test]
async fn live_day_replay_resolves_previous_close_from_0h_flow_and_snapshot_combined() {
    let tmp = tempfile::tempdir().unwrap();
    let (app, data) = start(tmp.path()).await;
    let shared = data.join("shared");

    let mut quotes = LiveQuoteWriter::open(&shared, DATE, "collect-01", 1).unwrap();
    quotes.append_minute("005930", &quote(540, 71_000)).unwrap();
    quotes.append_minute("000660", &quote(540, 201_000)).unwrap();
    quotes.append_minute("035420", &quote(540, 151_000)).unwrap();
    write_links(&shared, "collect-01", &[(at(8, 55, 0), "live"), (at(9, 2, 0), "alive")]);

    let mut expected_writer = FlowWriter::open(
        &flow_path(&shared, DATE, "0H", "005930", "collect-01"),
        FlowDescription::new("0H", "005930", DATE, "collect-01", &[20, 10, 11, 12, 15, 13, 25]),
    )
    .unwrap();
    expected_writer
        .append(&[FlowRow {
            recv_ms: at(8, 55, 10),
            values: vec![
                Some("085510".into()),
                Some("+71200".into()),
                Some("+700".into()),
                Some("+0.99".into()),
                Some("10".into()),
                Some("100".into()),
                Some("2".into()),
            ],
        }])
        .unwrap();

    write_snapshot(
        &shared,
        Header::new(DataKind::SnapshotCombined, today(), at(9, 0, 0) / 1000, at(9, 0, 0) / 1000, Vec::new()),
        &SnapshotBody {
            closing: false,
            requested: 2,
            missing: 0,
            stocks: vec![
                SnapshotRow {
                    code: "005930".into(),
                    day: DATE.into(),
                    current_won: 71_000,
                    base_won: 70_000,
                    open_won: 71_000,
                    high_won: 71_200,
                    low_won: 70_900,
                    volume: 100,
                    traded_million_won: 7,
                    traded_at: Some(at(9, 0, 10) / 1000),
                },
                SnapshotRow {
                    code: "000660".into(),
                    day: DATE.into(),
                    current_won: 201_000,
                    base_won: 200_000,
                    open_won: 201_000,
                    high_won: 201_500,
                    low_won: 200_500,
                    volume: 50,
                    traded_million_won: 10,
                    traded_at: Some(at(9, 0, 10) / 1000),
                },
            ],
            indices: Vec::new(),
        },
    )
    .unwrap();

    assert_eq!(day_of(&app, "005930").await["previousClose"], json!(70_500));
    assert_eq!(day_of(&app, "000660").await["previousClose"], json!(200_000));
    assert_eq!(day_of(&app, "035420").await["previousClose"], json!(null));

    let (status, trades) = get(&app, &format!("/api/symbols/000660/book-replay/trades?date={DATE}&untilSec=32460")).await;
    assert_eq!(status, 200, "{trades}");
    assert_eq!(trades["previousClose"], json!(200_000));

    let (status, prog) = get(&app, &format!("/api/symbols/000660/book-replay/program?date={DATE}")).await;
    assert_eq!(status, 200, "{prog}");
    assert_eq!(prog["previousClose"], json!(200_000));
}
