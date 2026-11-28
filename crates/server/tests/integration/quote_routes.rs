use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use duckdb::Connection;
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{ClosedQuotes, CurrentQuotes, Ladder, LevelQty, LiveQuoteWriter, QuoteMinute, VenueQuote, closed_day_dir, write_closed_quotes};
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

const CODE: &str = "005930";
const KRX_ONLY: &str = "042700";
const MONDAY: &str = "20261123";
const TUESDAY: &str = "20261124";

#[derive(Clone, Default)]
struct Kiwoom {
    calls: Arc<AtomicUsize>,
}

impl Transport for Kiwoom {
    fn send(&self, _: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(TransportError::refused()) })
    }
}

struct Harness {
    app: Router,
    clock: Clock,
    kiwoom: Kiwoom,
    shared: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start() -> Harness {
        Harness::start_with(true).await
    }

    async fn start_with(enabled: bool) -> Harness {
        let clock = Clock::frozen(kst(KstDate::new(2026, 11, 24).unwrap(), 10, 1, 30));
        let kiwoom = Kiwoom::default();
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(Arc::new(kiwoom.clone()), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let info = |(code, nxt_enabled): (&str, bool)| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: code.to_owned(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled };
        symbols.replace(Directory::build([(CODE, true), (KRX_ONLY, false)].into_iter().map(info).collect()));
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        let shared = tmp.path().join("shared");
        if enabled {
            state.collector_paths.configure(server::shared_data::CollectorPaths::shared_only(shared.clone()));
        }
        Harness { app: router(state), clock, kiwoom, shared, _tmp: tmp }
    }

    fn closed(&self, date: &str, code: &str, minutes: Vec<QuoteMinute>, gaps: Vec<(u32, u32)>) {
        write_closed_quotes(&closed_day_dir(&self.shared, date), date, code, &ClosedQuotes { minutes, gaps }).unwrap();
    }

    fn live(&self) -> LiveQuoteWriter {
        LiveQuoteWriter::open(&self.shared, TUESDAY, "collect-01", 1).unwrap()
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let request = Request::builder().uri(path).body(Body::empty()).unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{path}: {e}: {}", String::from_utf8_lossy(&bytes))))
    }

    async fn ok(&self, path: &str) -> Value {
        let (status, body) = self.get(path).await;
        assert_eq!(status, 200, "{path}: {body}");
        body
    }

    async fn totals(&self, query: &str) -> Vec<(String, i64, i64)> {
        let page = self.ok(&format!("/api/symbols/{CODE}/quote-totals?{query}")).await;
        points(&page).iter().map(|point| (hhmm(point), point["ask"].as_i64().unwrap(), point["bid"].as_i64().unwrap())).collect()
    }

    async fn depth(&self, query: &str) -> Vec<(String, Value, Value)> {
        let page = self.ok(&format!("/api/symbols/{CODE}/quote-depth?{query}")).await;
        points(&page).iter().map(|point| (hhmm(point), point["asks"].clone(), point["bids"].clone())).collect()
    }
}

fn points(page: &Value) -> &Vec<Value> {
    page["points"].as_array().unwrap()
}

fn unix(date: &str, hour: u32, minute: u32) -> i64 {
    kst(KstDate::parse_yyyymmdd(date).unwrap(), hour, minute, 0).unix()
}

fn hhmm(point: &Value) -> String {
    let seconds = (point["t"].as_i64().unwrap() + 9 * 3600).rem_euclid(86_400);
    assert_eq!(seconds % 60, 0);
    format!("{:02}:{:02}", seconds / 3600, seconds / 60 % 60)
}

fn at(hour: u16, minute: u16) -> u16 {
    hour * 60 + minute
}

fn ladder(asks: &[(i64, i64)], bids: &[(i64, i64)]) -> Ladder {
    let side = |levels: &[(i64, i64)]| levels.iter().filter(|(_, qty)| *qty > 0).map(|(price, qty)| LevelQty(*price, *qty)).collect();
    Ladder { asks: side(asks), bids: side(bids) }
}

fn even(quote: Ladder) -> VenueQuote {
    VenueQuote { close: quote.clone(), peak: quote.clone(), price_max: quote }
}

fn book(minute: u16, ask: i64, bid: i64) -> QuoteMinute {
    let of = |ask: i64, bid: i64| even(ladder(&[(10_100, ask)], &[(9_900, bid)]));
    QuoteMinute { minute, close_sec: u32::from(minute) * 60 + 50, single_price: false, combined: of(ask, bid), krx: of(ask - 1, bid - 2), nxt: of(1, 2) }
}

fn auction(minute: u16) -> QuoteMinute {
    QuoteMinute { single_price: true, ..book(minute, 9_999, 9_999) }
}

fn seconds(hour: u32, minute: u32, second: u32) -> u32 {
    hour * 3600 + minute * 60 + second
}

fn shown(expected: &[(&str, i64, i64)]) -> Vec<(String, i64, i64)> {
    expected.iter().map(|(time, ask, bid)| ((*time).to_owned(), *ask, *bid)).collect()
}

const MONDAY_RANGE: &str = "from=2026-11-23&to=2026-11-23";

#[tokio::test]
async fn totals_follow_the_last_book_of_each_bar() {
    let harness = Harness::start().await;
    let minutes = vec![book(at(9, 0), 100, 50), book(at(9, 1), 110, 60), book(at(9, 2), 120, 70), book(at(9, 3), 130, 80), book(at(9, 4), 140, 90)];
    harness.closed(MONDAY, CODE, minutes.clone(), vec![(seconds(9, 5, 0), seconds(19, 0, 0))]);
    let one = harness.totals(&format!("period=1m&{MONDAY_RANGE}")).await;
    assert_eq!(one, shown(&[("09:00", 100, 50), ("09:01", 110, 60), ("09:02", 120, 70), ("09:03", 130, 80), ("09:04", 140, 90)]));
    let three = harness.totals(&format!("period=3m&venue=combined&{MONDAY_RANGE}")).await;
    assert_eq!(three[..1], shown(&[("09:00", 120, 70)])[..]);
    assert!(three.len() <= 2);
    assert_eq!(harness.totals(&format!("period=1m&venue=krx&{MONDAY_RANGE}")).await[0], ("09:00".to_owned(), 99, 48));
    assert_eq!(harness.totals(&format!("period=1m&venue=nxt&{MONDAY_RANGE}")).await[0], ("09:00".to_owned(), 1, 2));
    let sixty = harness.totals(&format!("period=60m&{MONDAY_RANGE}&after={}", unix(MONDAY, 9, 0))).await;
    assert_eq!(sixty, shown(&[("09:00", 140, 90)]));

    harness.closed(MONDAY, KRX_ONLY, minutes, Vec::new());
    let page = harness.ok(&format!("/api/symbols/{KRX_ONLY}/quote-totals?period=1m&venue=nxt&{MONDAY_RANGE}")).await;
    assert_eq!(page["venue"], "combined");
    assert_eq!(points(&page)[0], json!({"t": unix(MONDAY, 9, 0), "ask": 100, "bid": 50}));
    assert_eq!(harness.kiwoom.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn quiet_bars_carry_the_last_book_until_a_gap_or_a_single_price_close() {
    let harness = Harness::start().await;
    let minutes = vec![book(at(9, 0), 100, 50), book(at(9, 3), 130, 80), book(at(9, 8), 180, 90), auction(at(9, 11)), book(at(9, 14), 200, 95), auction(at(9, 15))];
    harness.closed(MONDAY, CODE, minutes, vec![(seconds(9, 5, 10), seconds(9, 6, 40))]);
    harness.live().append_minute(CODE, &book(at(9, 2), 7, 8)).unwrap();
    let monday = harness.totals(&format!("period=1m&{MONDAY_RANGE}")).await;
    let expected = [
        ("09:00", 100, 50), ("09:01", 100, 50), ("09:02", 100, 50), ("09:03", 130, 80), ("09:04", 130, 80),
        ("09:08", 180, 90), ("09:09", 180, 90), ("09:10", 180, 90), ("09:14", 200, 95),
    ];
    assert_eq!(monday, shown(&expected));

    let both = harness.totals("period=1m&from=2026-11-23&to=2026-11-24").await;
    assert_eq!(both[..expected.len()], monday[..]);
    assert_eq!(both[expected.len()], ("09:02".to_owned(), 7, 8), "전날 값을 오늘로 잇지 않는다");

    let krx_only_minutes = vec![QuoteMinute { krx: VenueQuote::default(), ..book(at(8, 10), 10, 10) }, book(at(9, 0), 40, 41)];
    harness.clock.jump(5);
    harness.closed("20261120", CODE, krx_only_minutes, vec![(seconds(9, 1, 0), seconds(20, 0, 0))]);
    let krx = harness.totals("period=1m&venue=krx&from=2026-11-20&to=2026-11-20").await;
    assert_eq!(krx, shown(&[("09:00", 39, 39)]), "그 거래소 호가가 없는 봉은 비우고 잇지 않는다");
}

#[tokio::test]
async fn the_live_day_stops_at_now_and_shows_new_minutes() {
    let harness = Harness::start().await;
    let mut live = harness.live();
    live.append_minute(CODE, &book(at(9, 57), 10, 20)).unwrap();
    live.write_current(&CurrentQuotes { minutes: [(CODE.to_owned(), book(at(9, 58), 11, 21))].into() }, 1).unwrap();
    let today = "period=1m&from=2026-11-24&to=2026-11-24";
    let first = harness.totals(&format!("{today}&after={}", unix(TUESDAY, 9, 58))).await;
    assert_eq!(first, shown(&[("09:58", 11, 21), ("09:59", 11, 21), ("10:00", 11, 21), ("10:01", 11, 21)]));
    assert_eq!(harness.totals(today).await.len(), 5);

    live.append_minute(CODE, &book(at(9, 58), 12, 22)).unwrap();
    live.write_current(&CurrentQuotes { minutes: [(CODE.to_owned(), book(at(10, 1), 13, 23))].into() }, 2).unwrap();
    harness.clock.jump(5);
    let second = harness.totals(&format!("{today}&after={}", unix(TUESDAY, 10, 0))).await;
    assert_eq!(second, shown(&[("10:00", 12, 22), ("10:01", 13, 23)]));
    let five = harness.totals("period=5m&from=2026-11-24&to=2026-11-24").await;
    assert_eq!(five, shown(&[("09:55", 12, 22), ("10:00", 13, 23)]));
}

#[tokio::test]
async fn depth_merges_the_chosen_source_per_bar() {
    let harness = Harness::start().await;
    let minute = |number: u16, close: Ladder, peak: Ladder, price_max: Ladder| QuoteMinute {
        minute: number,
        close_sec: u32::from(number) * 60 + 59,
        single_price: false,
        combined: VenueQuote { close, peak, price_max },
        krx: VenueQuote::default(),
        nxt: VenueQuote::default(),
    };
    let minutes = vec![
        minute(at(9, 0), ladder(&[(101, 1)], &[(99, 1)]), ladder(&[(101, 60)], &[(99, 40)]), ladder(&[(101, 60), (102, 5)], &[(99, 40)])),
        minute(at(9, 1), ladder(&[(102, 2)], &[(100, 2)]), ladder(&[(102, 70)], &[(100, 30)]), ladder(&[(101, 8), (102, 70)], &[(100, 30), (99, 45)])),
        minute(at(9, 2), ladder(&[(103, 3)], &[(101, 3)]), ladder(&[(103, 4)], &[(101, 4)]), ladder(&[(103, 4)], &[(101, 4)])),
        auction(at(9, 7)),
    ];
    harness.closed(MONDAY, CODE, minutes, vec![(seconds(9, 8, 0), seconds(20, 0, 0))]);
    let query = format!("period=3m&{MONDAY_RANGE}");
    let price_max = harness.depth(&format!("{query}&source=priceMax")).await;
    let quiet = ("09:03".to_owned(), json!([[103, 3]]), json!([[101, 3]]));
    assert_eq!(price_max, [("09:00".to_owned(), json!([[101, 60], [102, 70], [103, 4]]), json!([[101, 4], [100, 30], [99, 45]])), quiet.clone()]);
    assert_eq!(harness.depth(&query).await, price_max);
    let peak = harness.depth(&format!("{query}&source=peak")).await;
    assert_eq!(peak, [("09:00".to_owned(), json!([[101, 60]]), json!([[99, 40]])), quiet.clone()], "합이 같으면 이른 분");
    let close = harness.depth(&format!("{query}&source=close")).await;
    assert_eq!(close, [("09:00".to_owned(), json!([[103, 3]]), json!([[101, 3]])), quiet]);
    let page = harness.ok(&format!("/api/symbols/{CODE}/quote-depth?{query}")).await;
    assert_eq!((&page["source"], &page["venue"]), (&json!("priceMax"), &json!("combined")));
    let tail = harness.depth(&format!("{query}&after={}", unix(MONDAY, 9, 3))).await;
    assert_eq!(tail.len(), 1);
}

#[tokio::test]
async fn days_tell_why_there_is_nothing_to_draw() {
    let harness = Harness::start().await;
    harness.closed(MONDAY, CODE, vec![book(at(9, 0), 1, 1)], Vec::new());
    harness.live().append_minute(CODE, &book(at(9, 0), 1, 1)).unwrap();
    let range = "period=1m&from=2026-11-21&to=2026-11-24";
    let days = |states: [&str; 4]| json!([
        {"date": "2026-11-21", "state": states[0]}, {"date": "2026-11-22", "state": states[1]}, {"date": "2026-11-23", "state": states[2]}, {"date": "2026-11-24", "state": states[3]},
    ]);
    for path in ["quote-totals", "quote-depth"] {
        let collected = harness.ok(&format!("/api/symbols/{CODE}/{path}?{range}")).await;
        assert_eq!(collected["available"], json!(true), "{path}");
        assert_eq!(collected["days"], days(["none", "none", "closed", "live"]), "{path}");
        let missing = harness.ok(&format!("/api/symbols/035420/{path}?{range}")).await;
        assert_eq!(missing["available"], json!(true), "{path}");
        assert_eq!(missing["days"], days(["none", "none", "notCollected", "notCollected"]), "{path}");
        assert!(points(&missing).is_empty());
    }
    let off = Harness::start_with(false).await;
    for path in ["quote-totals", "quote-depth"] {
        let page = off.ok(&format!("/api/symbols/{CODE}/{path}?{range}")).await;
        assert_eq!(page["available"], json!(false), "{path}");
        assert_eq!(page["days"], days(["none"; 4]), "{path}");
    }
}

#[tokio::test]
async fn bad_requests_are_refused_without_reading_files() {
    let harness = Harness::start().await;
    let range = "from=2026-11-23&to=2026-11-24";
    let refused = [
        format!("{CODE}/quote-totals?period=D&{range}"),
        format!("{CODE}/quote-totals?{range}"),
        format!("001/quote-totals?period=1m&{range}"),
        format!("{CODE}/quote-totals?period=1m&from=2026-11-24&to=2026-11-23"),
        format!("{CODE}/quote-totals?period=1m&from=2026-10-24&to=2026-11-24"),
        format!("{CODE}/quote-totals?period=1m&from=20261123&to=2026-11-24"),
        format!("{CODE}/quote-totals?period=1m&to=2026-11-24"),
        format!("{CODE}/quote-totals?period=1m&venue=sor&{range}"),
        format!("{CODE}/quote-totals?period=1m&after=x&{range}"),
        format!("{CODE}/quote-depth?period=1m&source=mean&{range}"),
        format!("..%2F..%2Fetc/quote-depth?period=1m&{range}"),
    ];
    for path in refused {
        let (status, body) = harness.get(&format!("/api/symbols/{path}")).await;
        assert_eq!((status, body["error"]["code"].as_str()), (400, Some("bad_request")), "{path}: {body}");
    }
    let (status, _) = harness.get(&format!("/api/symbols/{CODE}/quote-totals?period=1m&from=2026-10-25&to=2026-11-24")).await;
    assert_eq!(status, 200, "31일은 받는다");
    assert_eq!(harness.kiwoom.calls.load(Ordering::SeqCst), 0);
}

fn write_hogaplay_snapshots(root: &std::path::Path, date: &str, symbol: &str, rows: &[(i64, i32, i64, i64, i64, usize)]) {
    let dir = root.join(date).join(symbol).join("hogaplay");
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    let mut selects = Vec::with_capacity(rows.len());
    for &(ts_ms, seq, ask1, bid1, qty, levels) in rows {
        let mut cols = vec![format!("{ts_ms}::BIGINT AS ts_ms"), format!("{seq}::INTEGER AS seq")];
        for level in 1..=10 {
            let p = if level <= levels { ask1 + (level as i64 - 1) * 100 } else { 0 };
            let q = if level <= levels { qty } else { 0 };
            cols.push(format!("{p}::BIGINT AS ask_p{level}, {q}::BIGINT AS ask_q{level}"));
        }
        for level in 1..=10 {
            let p = if level <= levels { bid1 - (level as i64 - 1) * 100 } else { 0 };
            let q = if level <= levels { qty * 2 } else { 0 };
            cols.push(format!("{p}::BIGINT AS bid_p{level}, {q}::BIGINT AS bid_q{level}"));
        }
        let tot_ask = qty * (levels as i64);
        let tot_bid = qty * 2 * (levels as i64);
        cols.push(format!("{tot_ask}::BIGINT AS tot_ask, {tot_bid}::BIGINT AS tot_bid"));
        selects.push(format!("SELECT {}", cols.join(", ")));
    }
    conn.execute_batch(&format!(
        "SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)",
        selects.join(" UNION ALL "),
        dir.join("snapshots.parquet").display()
    ))
    .unwrap();
}

async fn start_with_paths(paths: server::shared_data::CollectorPaths) -> Harness {
    let clock = Clock::frozen(kst(KstDate::new(2026, 11, 24).unwrap(), 10, 1, 30));
    let kiwoom = Kiwoom::default();
    let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let rest = KiwoomRest::new(Arc::new(kiwoom.clone()), auth, clock.clone());
    let symbols = Arc::new(SymbolDirectory::default());
    let info = |(code, nxt_enabled): (&str, bool)| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: code.to_owned(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled };
    symbols.replace(Directory::build([(CODE, true), (KRX_ONLY, false)].into_iter().map(info).collect()));
    let tmp = tempfile::tempdir().unwrap();
    let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, events) = tokio::sync::mpsc::channel(1);
    let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
    let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
    rest.set_access(Access::Open);
    let shared = paths.shared_dir().map(std::path::Path::to_path_buf).unwrap_or_else(|| tmp.path().join("shared"));
    state.collector_paths.configure(paths);
    Harness { app: router(state), clock, kiwoom, shared, _tmp: tmp }
}

#[tokio::test]
async fn hogaplay_archive_only_serves_quote_totals_and_quote_depth_without_shared_dir() {
    let archive_root = tempfile::tempdir().unwrap();
    let archive_dir = archive_root.path().join("parquet");
    write_hogaplay_snapshots(
        &archive_dir,
        "20240827",
        CODE,
        &[
            (90010000, 1, 76_100, 76_000, 250, 4),
            (90045000, 2, 76_100, 76_000, 100, 4),
            (90120000, 3, 76_200, 76_100, 150, 4),
            (90230000, 4, 76_200, 76_100, 999, 2),
            (90510000, 5, 76_300, 76_200, 200, 4),
        ],
    );
    let harness = start_with_paths(server::shared_data::CollectorPaths::archive_only(archive_dir)).await;

    let page = harness.ok(&format!("/api/symbols/{CODE}/quote-totals?period=1m&venue=combined&from=2024-08-26&to=2024-08-27")).await;
    assert_eq!(page["available"], json!(true));
    assert_eq!(
        page["days"],
        json!([{"date": "2024-08-26", "state": "none"}, {"date": "2024-08-27", "state": "closed"}])
    );
    let got: Vec<(String, i64, i64)> = points(&page)
        .iter()
        .map(|point| (hhmm(point), point["ask"].as_i64().unwrap(), point["bid"].as_i64().unwrap()))
        .collect();
    assert_eq!(got, shown(&[("09:00", 400, 800), ("09:01", 600, 1_200), ("09:05", 800, 1_600)]));

    let five = harness.totals("period=5m&venue=combined&from=2024-08-27&to=2024-08-27").await;
    assert_eq!(five, shown(&[("09:05", 800, 1_600)]));

    let krx = harness.ok(&format!("/api/symbols/{CODE}/quote-totals?period=1m&venue=krx&from=2024-08-27&to=2024-08-27")).await;
    assert_eq!(krx["available"], json!(true));
    assert!(points(&krx).is_empty());

    let nxt = harness.ok(&format!("/api/symbols/{CODE}/quote-totals?period=1m&venue=nxt&from=2024-08-27&to=2024-08-27")).await;
    assert_eq!(nxt["available"], json!(true));
    assert!(points(&nxt).is_empty());

    let depth_peak = harness.depth("period=1m&venue=combined&source=peak&from=2024-08-27&to=2024-08-27").await;
    assert_eq!(depth_peak.len(), 3);
    assert_eq!(depth_peak[0].0, "09:00");
    assert_eq!(depth_peak[0].1[0], json!([76_100, 250]));

    let missing_stock = harness.ok("/api/symbols/035420/quote-totals?period=1m&venue=combined&from=2024-08-27&to=2024-08-27").await;
    assert_eq!(missing_stock["available"], json!(true));
    assert_eq!(missing_stock["days"], json!([{"date": "2024-08-27", "state": "notCollected"}]));
    assert!(points(&missing_stock).is_empty());
}

#[tokio::test]
async fn native_quote_minutes_takes_priority_over_hogaplay_archive_on_overlapping_day() {
    let root = tempfile::tempdir().unwrap();
    let shared_dir = root.path().join("shared");
    let archive_dir = root.path().join("parquet");
    write_closed_quotes(
        &closed_day_dir(&shared_dir, MONDAY),
        MONDAY,
        CODE,
        &ClosedQuotes { minutes: vec![book(at(9, 0), 100, 50)], gaps: vec![(seconds(9, 1, 0), seconds(20, 0, 0))] },
    )
    .unwrap();
    write_hogaplay_snapshots(&archive_dir, MONDAY, CODE, &[(90030000, 1, 76_100, 76_000, 999, 4)]);
    write_hogaplay_snapshots(&archive_dir, "20261120", CODE, &[(90030000, 1, 75_100, 75_000, 100, 4)]);

    let paths = server::shared_data::CollectorPaths::shared_only(shared_dir).with_archive(Some(archive_dir));
    let harness = start_with_paths(paths).await;

    let page = harness.ok(&format!("/api/symbols/{CODE}/quote-totals?period=1m&venue=combined&from=2026-11-20&to=2026-11-23")).await;
    assert_eq!(page["available"], json!(true));
    assert_eq!(
        page["days"],
        json!([
            {"date": "2026-11-20", "state": "closed"},
            {"date": "2026-11-21", "state": "none"},
            {"date": "2026-11-22", "state": "none"},
            {"date": "2026-11-23", "state": "closed"},
        ])
    );
    let pts = points(&page);
    assert_eq!(pts.len(), 2);
    assert_eq!(pts[0], json!({"t": unix("20261120", 9, 0), "ask": 400, "bid": 800}));
    assert_eq!(pts[1], json!({"t": unix(MONDAY, 9, 0), "ask": 100, "bid": 50}));
}
