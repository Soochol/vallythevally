mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::KstDate;
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
use server::shared_data::{CurrentQuotes, DataKind, FeedWriter, Header, Ladder, LevelQty, LiveQuoteWriter, QuoteMinute, TradeMinuteLine, VenueQuote, flow_links_path, trade_minute_path};
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

async fn start(tmp: &Path) -> (Router, PathBuf) {
    let fake = ScriptedTransport::new();
    let clock = Clock::fake(kst(today(), 10, 0, 0));
    let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
    let db = AppDb::open(&tmp.join("db.sqlite")).await.unwrap();
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, events) = tokio::sync::mpsc::channel(1);
    let store = server::screener::store::Store::open(&tmp.join("screener.duckdb")).unwrap();
    let state = application(ApplicationInputs { rest, clock, symbols: Arc::new(SymbolDirectory::default()), db, screener_store: store, stream: (stream, events), static_dir: tmp.to_owned(), screener_update_on_connect: false });
    let data = tmp.join("hoga");
    std::fs::create_dir_all(&data).unwrap();
    state.book_replay.enable(data.clone());
    (router(state), data)
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
