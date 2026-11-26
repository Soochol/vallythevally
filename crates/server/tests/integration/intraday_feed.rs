use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::shared_data::CollectorPaths;
use server::symbols::{Directory, SymbolDirectory};
use support::{ScriptedReply, ScriptedTransport, fixture};
use tower::ServiceExt;

struct Fixture {
    fake: ScriptedTransport,
    app: Router,
    hoga_dir: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Fixture {
    async fn start(connected: bool) -> Fixture {
        Self::start_with_collector(connected, false).await
    }

    async fn start_with_collector(connected: bool, collector_enabled: bool) -> Fixture {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(KstTime::from_kst_civil(KstDate::new(2026, 11, 9).unwrap(), TimeOfDay::MIDNIGHT));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let listed = |code: &str, name: &str, nxt_enabled: bool| SymbolInfo {
            symbol: Symbol::parse(code).unwrap(),
            name: name.into(),
            kind: SymbolKind::Common,
            market: Market::Kospi,
            nxt_enabled,
        };
        symbols.replace(Directory::build(vec![listed("005930", "삼성전자", true), listed("005935", "삼성전자우", false)]));
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let state = application(ApplicationInputs { rest: rest.clone(), clock, symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        let hoga_dir = tmp.path().join("hoga");
        if collector_enabled {
            state.collector_paths.configure(CollectorPaths::hoga_only(hoga_dir.clone()));
        }
        if connected {
            rest.set_access(Access::Open);
        }
        let app = router(state);
        tokio::time::pause();
        Fixture { fake, app, hoga_dir, _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let resp = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    fn get_in_background(&self, path: &str) -> tokio::task::JoinHandle<(u16, Value)> {
        let (app, path) = (self.app.clone(), path.to_owned());
        tokio::spawn(async move {
            let resp = app.oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
            let status = resp.status().as_u16();
            (status, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap())
        })
    }

    async fn until_calls(&self, api_id: &str, count: usize) {
        for _ in 0..100_000 {
            if self.calls(api_id).len() >= count {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("{api_id} 호출이 {count}건에 이르지 않았다: {:?}", self.calls(api_id));
    }

    async fn settle(&self) {
        for _ in 0..1_000 {
            tokio::task::yield_now().await;
        }
    }

    fn script_five_pages(&self, api_id: &str, first: &str, last: &str) {
        let page_with_next = |next: &str| {
            let mut page = fixture(first);
            page["_headers"]["next-key"] = json!(next);
            page
        };
        self.fake.respond_with(api_id, 200, page_with_next("PAGE2"));
        for (key, next) in [("PAGE2", "PAGE3"), ("PAGE3", "PAGE4"), ("PAGE4", "PAGE5")] {
            self.fake.respond_with_for_key(api_id, key, 200, page_with_next(next));
        }
        self.fake.respond_with_for_key(api_id, "PAGE5", 200, fixture(last));
    }

    fn calls(&self, api_id: &str) -> Vec<support::Call> {
        self.fake.calls().into_iter().filter(|c| c.api_id == api_id).collect()
    }

    fn script_pages(&self, api_id: &str, first: &str, key: &str, second: &str) {
        self.fake.respond_with(api_id, 200, fixture(first));
        self.fake.respond_with_for_key(api_id, key, 200, fixture(second));
    }
}

const FEEDS: [(&str, &str); 3] = [("order-book", "ka10004"), ("trades", "ka10003"), ("program-trades", "ka90008")];

#[tokio::test]
async fn the_order_book_is_read_from_one_combined_request_by_default() {
    let f = Fixture::start(true).await;
    f.fake.respond_with("ka10004", 200, fixture("ka10004_005930_AL"));
    let (status, body) = f.get("/api/symbols/005930/order-book").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["symbol"], "005930");
    assert_eq!((body["asks"].as_array().unwrap().len(), body["bids"].as_array().unwrap().len()), (9, 10));
    assert_eq!(body["asks"][0], json!({"price": 70_100, "quantity": 1_000}));
    assert_eq!((&body["totalAskQuantity"], &body["totalBidQuantity"], &body["bookTime"], &body["expected"]), (&json!(55_000), &json!(66_000), &json!("15:30:00"), &Value::Null));
    let calls = f.calls("ka10004");
    assert_eq!(calls.iter().map(|c| c.body.clone()).collect::<Vec<_>>(), [json!({"stk_cd": "005930_AL"})]);
    let mut with_expected = fixture("ka10004_005930_AL");
    with_expected["exp_cntr_pric"] = "+70150".into();
    with_expected["exp_cntr_qty"] = "420".into();
    f.fake.respond_with("ka10004", 200, with_expected);
    let (status, body) = f.get("/api/symbols/005930/order-book?venue=nxt").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["expected"], json!({"price": 70_150.0, "qty": 420}));
}

#[tokio::test]
async fn the_order_book_asks_for_the_requested_venue_code() {
    let f = Fixture::start(true).await;
    f.fake.respond_with("ka10004", 200, fixture("ka10004_005930_AL"));
    for query in ["?venue=krx", "?venue=nxt", "?venue=combined", ""] {
        let (status, body) = f.get(&format!("/api/symbols/005930/order-book{query}")).await;
        assert_eq!(status, 200, "{query}: {body}");
    }
    let asked: Vec<_> = f.calls("ka10004").into_iter().map(|c| c.body["stk_cd"].as_str().unwrap().to_owned()).collect();
    assert_eq!(asked, ["005930", "005930_NX", "005930_AL", "005930_AL"]);
}

#[tokio::test]
async fn the_order_book_of_a_symbol_off_nxt_is_always_the_combined_book() {
    let f = Fixture::start(true).await;
    f.fake.respond_with("ka10004", 200, fixture("ka10004_005930_AL"));
    for venue in ["krx", "nxt", "combined"] {
        let (status, body) = f.get(&format!("/api/symbols/005935/order-book?venue={venue}")).await;
        assert_eq!(status, 200, "{venue}: {body}");
    }
    let asked: Vec<_> = f.calls("ka10004").into_iter().map(|c| c.body["stk_cd"].as_str().unwrap().to_owned()).collect();
    assert_eq!(asked, ["005935_AL", "005935_AL", "005935_AL"]);
    let (status, body) = f.get("/api/symbols/005930/order-book?venue=tokyo").await;
    assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")));
}

#[tokio::test]
async fn todays_trades_follow_the_continuation_key_and_stop_at_the_limit() {
    let f = Fixture::start(true).await;
    f.script_pages("ka10003", "ka10003_005930_AL_p1", "TRADES2", "ka10003_005930_AL_p2");
    let (status, body) = f.get("/api/symbols/005930/trades").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((&body["venue"], &body["skippedRows"]), (&json!("combined"), &json!(1)));
    let seen: Vec<_> = body["trades"].as_array().unwrap().iter().map(|t| (t["time"].as_str().unwrap(), t["quantity"].as_i64().unwrap())).collect();
    assert_eq!(seen, [("15:30:00", 30), ("15:29:59", -12), ("15:29:58", 5), ("15:29:57", 7), ("15:29:56", -8)]);
    assert_eq!(body["trades"][1]["exchange"], "nxt");
    assert_eq!(body["trades"][2]["exchange"], Value::Null);
    assert_eq!(f.calls("ka10003").iter().map(|c| c.next_key.clone()).collect::<Vec<_>>(), [None, Some("TRADES2".to_owned())]);

    let (_, short) = f.get("/api/symbols/005930/trades?limit=2").await;
    assert_eq!(short["trades"].as_array().unwrap().len(), 2);
    assert_eq!(f.calls("ka10003").len(), 3, "앞의 두 쪽 호출에 한도 2의 첫 쪽 한 번만 더해진다. 다음 쪽은 묻지 않는다");
}

#[tokio::test]
async fn one_page_of_trades_ignores_the_continuation_key() {
    let f = Fixture::start(true).await;
    f.script_pages("ka10003", "ka10003_005930_AL_p1", "TRADES2", "ka10003_005930_AL_p2");
    let (status, body) = f.get("/api/symbols/005930/trades?limit=500&pages=1").await;
    assert_eq!(status, 200, "{body}");
    assert!(!body["trades"].as_array().unwrap().is_empty());
    assert_eq!(f.calls("ka10003").iter().map(|c| c.next_key.clone()).collect::<Vec<_>>(), [None], "첫 쪽에 연속조회 키가 있어도 다음 쪽은 묻지 않는다");
}

#[tokio::test]
async fn trades_ask_for_the_requested_venue_and_report_the_combined_fallback() {
    let f = Fixture::start(true).await;
    f.fake.respond_with("ka10003", 200, fixture("ka10003_005930_AL_p2"));
    let (_, nxt) = f.get("/api/symbols/005930/trades?venue=nxt").await;
    let (_, krx) = f.get("/api/symbols/005930/trades?venue=krx").await;
    let (_, fallback) = f.get("/api/symbols/005935/trades?venue=nxt").await;
    assert_eq!((&nxt["venue"], &krx["venue"], &fallback["venue"]), (&json!("nxt"), &json!("krx"), &json!("combined")));
    let asked: Vec<_> = f.calls("ka10003").into_iter().map(|c| c.body["stk_cd"].as_str().unwrap().to_owned()).collect();
    assert_eq!(asked, ["005930_NX", "005930", "005935_AL"]);
    for bad in ["venue=tokyo", "limit=0", "limit=501", "limit=x", "pages=0", "pages=31", "pages=x"] {
        let (status, body) = f.get(&format!("/api/symbols/005930/trades?{bad}")).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{bad}: {body}");
    }
}

#[tokio::test]
async fn program_trades_cover_the_whole_day_in_won() {
    let f = Fixture::start(true).await;
    f.script_pages("ka90008", "ka90008_005930_AL_p1", "PROG2", "ka90008_005930_AL_p2");
    let (status, body) = f.get("/api/symbols/005930/program-trades").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["skippedRows"], 1);
    assert_eq!(body["points"].as_array().unwrap().len(), 3);
    assert_eq!(
        body["points"][0],
        json!({"time": "15:30:00", "price": 70_100, "buyQuantity": 1_200, "sellQuantity": 1_500, "netQuantity": -300, "buyAmount": 84_000_000, "sellAmount": 105_000_000, "netAmount": -21_000_000})
    );
    assert_eq!(body["points"][2]["netAmount"], 1_000_000);
    let calls = f.calls("ka90008");
    assert_eq!(calls[0].body, json!({"stk_cd": "005930_AL", "date": "20261109", "amt_qty_tp": "2"}));
    assert_eq!(calls.iter().map(|c| c.next_key.clone()).collect::<Vec<_>>(), [None, Some("PROG2".to_owned())]);
}

#[tokio::test]
async fn indexes_and_unlisted_symbols_are_rejected_without_asking_kiwoom() {
    let f = Fixture::start(true).await;
    for (route, api_id) in FEEDS {
        for (symbol, want) in [("IDX:001", (400, "bad_request")), ("bad", (400, "bad_request")), ("000660", (404, "unknown_symbol"))] {
            let (status, body) = f.get(&format!("/api/symbols/{symbol}/{route}")).await;
            assert_eq!((status, body["error"]["code"].as_str().unwrap()), want, "{route} {symbol}: {body}");
        }
        assert!(f.calls(api_id).is_empty(), "{route}");
    }
}

#[tokio::test]
async fn before_connecting_every_feed_answers_not_connected() {
    let f = Fixture::start(false).await;
    for (route, api_id) in FEEDS {
        let (status, body) = f.get(&format!("/api/symbols/005930/{route}")).await;
        assert_eq!((status, body["error"]["code"].as_str(), body["error"]["reason"].as_str()), (503, Some("kiwoom_unavailable"), Some("not_connected")), "{route}: {body}");
        assert!(f.calls(api_id).is_empty(), "{route}");
    }
}

#[tokio::test]
async fn simultaneous_identical_requests_reach_kiwoom_once() {
    let f = Fixture::start(true).await;
    f.fake.respond_with("ka10004", 200, fixture("ka10004_005930_AL"));
    f.fake.respond_with("ka10003", 200, fixture("ka10003_005930_AL_p2"));
    f.fake.respond_with("ka90008", 200, fixture("ka90008_005930_AL_p2"));
    for api_id in ["ka10004", "ka10003", "ka90008"] {
        f.fake.delay(api_id, Duration::from_secs(1));
    }
    for (route, api_id) in FEEDS {
        let path = format!("/api/symbols/005930/{route}");
        let (a, b) = tokio::join!(f.get(&path), f.get(&path));
        assert_eq!((a.0, b.0), (200, 200), "{route}: {a:?} {b:?}");
        assert_eq!(a.1, b.1, "{route}");
        assert_eq!(f.calls(api_id).len(), 1, "{route}: 같은 요청이 동시에 오면 키움 호출은 한 번이다");
    }
}

#[tokio::test]
async fn a_success_without_the_rows_is_a_protocol_failure() {
    let f = Fixture::start(true).await;
    for (route, api_id) in FEEDS {
        f.fake.respond_with(api_id, 200, json!({"return_code": 0, "return_msg": "ok"}));
        let (status, body) = f.get(&format!("/api/symbols/005930/{route}")).await;
        assert_eq!((status, &body["error"]["reason"]), (500, &json!("protocol")), "{route}: {body}");
    }
}

fn asked(calls: &[support::Call]) -> Vec<(String, Option<String>)> {
    calls.iter().map(|c| (c.body["stk_cd"].as_str().unwrap().to_owned(), c.next_key.clone())).collect()
}

fn page(code: &str, key: Option<&str>) -> (String, Option<String>) {
    (code.to_owned(), key.map(str::to_owned))
}

#[tokio::test]
async fn the_later_pages_of_trades_leave_two_slots_so_the_next_symbol_is_not_held() {
    let f = Fixture::start(true).await;
    f.script_five_pages("ka10003", "ka10003_005930_AL_p1", "ka10003_005930_AL_p2");
    let long_walk = f.get_in_background("/api/symbols/005930/trades?limit=500");
    f.until_calls("ka10003", 3).await;
    let next_symbol = f.get_in_background("/api/symbols/005935/trades?pages=1");
    f.until_calls("ka10003", 4).await;
    f.settle().await;
    let before_the_window_frees = asked(&f.calls("ka10003"));
    assert_eq!(before_the_window_frees, [page("005930_AL", None), page("005930_AL", Some("PAGE2")), page("005930_AL", Some("PAGE3")), page("005935_AL", None)], "B의 첫 쪽은 A의 넷째 쪽보다 먼저 나간다");
    tokio::time::advance(Duration::from_millis(1049)).await;
    f.settle().await;
    assert_eq!(f.calls("ka10003").len(), 4, "A의 넷째 쪽은 창이 빌 때까지 나가지 않는다");
    tokio::time::advance(Duration::from_millis(2)).await;
    f.until_calls("ka10003", 5).await;
    assert_eq!(asked(&f.calls("ka10003"))[4], page("005930_AL", Some("PAGE4")));
    assert_eq!(next_symbol.await.unwrap().0, 200);
    tokio::time::advance(Duration::from_secs(10)).await;
    assert_eq!(long_walk.await.unwrap().0, 200);
    assert_eq!(f.calls("ka10003").len(), 6);
}

#[tokio::test]
async fn the_later_pages_of_program_trades_leave_two_slots_in_the_window() {
    let f = Fixture::start(true).await;
    f.script_five_pages("ka90008", "ka90008_005930_AL_p1", "ka90008_005930_AL_p2");
    let walk = f.get_in_background("/api/symbols/005930/program-trades");
    f.until_calls("ka90008", 3).await;
    f.settle().await;
    assert_eq!(f.calls("ka90008").len(), 3, "넷째 쪽은 창이 빌 때까지 나가지 않는다");
    tokio::time::advance(Duration::from_millis(1049)).await;
    f.settle().await;
    assert_eq!(f.calls("ka90008").len(), 3);
    tokio::time::advance(Duration::from_millis(2)).await;
    f.until_calls("ka90008", 4).await;
    assert_eq!(f.calls("ka90008")[3].next_key.as_deref(), Some("PAGE4"));
    tokio::time::advance(Duration::from_secs(10)).await;
    assert_eq!(walk.await.unwrap().0, 200);
    assert_eq!(f.calls("ka90008").len(), 5);
}

fn write_program_store(hoga_dir: &Path, date: &str, recv_s: i64) {
    let folder = hoga_dir.join("store").join(date);
    let parquet = folder.join("0w").join("056.parquet");
    std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
    let sql = format!(
        "SELECT '005930_AL' AS symbol, {}::BIGINT AS recv_ms, '152000' AS f20, 70500::BIGINT AS f10, 400::BIGINT AS f202, 28::BIGINT AS f204, 650::BIGINT AS f206, 46::BIGINT AS f208, 250::BIGINT AS f210, 50::BIGINT AS f211, 18::BIGINT AS f212, 4::BIGINT AS f213",
        recv_s * 1000
    );
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(&format!("SET threads = 1; COPY ({sql}) TO '{}' (FORMAT parquet)", parquet.display())).unwrap();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": 64},
        "raw_files": {"collect-01/1520-000.jsonl.zst": 10},
        "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": [], "handoff": null}],
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

#[tokio::test]
async fn program_trades_fall_back_to_latest_collected_closed_day_when_today_is_empty() {
    let f = Fixture::start_with_collector(true, true).await;
    let closed_at = kst(KstDate::new(2026, 11, 6).unwrap(), 15, 20, 0).unix();
    write_program_store(&f.hoga_dir, "20261106", closed_at);
    f.fake.respond_with("ka90008", 200, json!({"return_code": 0, "return_msg": "ok", "stk_tm_prm_trde_trnsn": []}));
    let (status, body) = f.get("/api/symbols/005930/program-trades").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["date"], json!("20261106"));
    assert_eq!(f.calls("ka90008").len(), 1);
    assert_eq!(
        body["points"],
        json!([{
            "time": "15:20:00",
            "price": 70_500,
            "buyQuantity": 650,
            "sellQuantity": 400,
            "netQuantity": 250,
            "buyAmount": 46_000_000,
            "sellAmount": 28_000_000,
            "netAmount": 18_000_000,
        }])
    );
}

#[tokio::test]
async fn program_trades_fall_back_to_previous_trading_day_via_kiwoom_when_collector_is_absent() {
    let f = Fixture::start_with_collector(true, false).await;
    f.fake.script(
        "ka90008",
        vec![
            ScriptedReply {
                status: 200,
                body: json!({"return_code": 0, "return_msg": "ok", "stk_tm_prm_trde_trnsn": []}),
                delay: Duration::ZERO,
            },
            ScriptedReply {
                status: 200,
                body: fixture("ka90008_005930_AL_p2"),
                delay: Duration::ZERO,
            },
        ],
    );
    let (status, body) = f.get("/api/symbols/005930/program-trades").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["date"], json!("20261106"));
    assert_eq!(body["points"].as_array().unwrap().len(), 1);
    let calls = f.calls("ka90008");
    let dates: Vec<&str> = calls.iter().map(|c| c.body["date"].as_str().unwrap()).collect();
    assert_eq!(dates, ["20261109", "20261106"]);
}

#[tokio::test]
async fn program_trades_serve_collected_closed_day_even_when_source_is_disconnected() {
    let f = Fixture::start_with_collector(false, true).await;
    let closed_at = kst(KstDate::new(2026, 11, 6).unwrap(), 15, 20, 0).unix();
    write_program_store(&f.hoga_dir, "20261106", closed_at);
    let (status, body) = f.get("/api/symbols/005930/program-trades").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["date"], json!("20261106"));
    assert_eq!(body["points"].as_array().unwrap().len(), 1);
    assert!(f.calls("ka90008").is_empty());
}
