mod support;

use std::sync::Arc;
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::symbols::{Directory, SymbolDirectory};
use support::{ScriptedTransport, fixture};
use tower::ServiceExt;

struct Fixture {
    fake: ScriptedTransport,
    app: Router,
    _tmp: tempfile::TempDir,
}

impl Fixture {
    async fn start(connected: bool) -> Fixture {
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
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock, symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        if connected {
            rest.set_access(Access::Open);
        }
        let app = router(state);
        tokio::time::pause();
        Fixture { fake, app, _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let resp = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap())
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
async fn the_order_book_is_read_from_one_combined_request() {
    let f = Fixture::start(true).await;
    f.fake.respond_with("ka10004", 200, fixture("ka10004_005930_AL"));
    let (status, body) = f.get("/api/symbols/005930/order-book").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["symbol"], "005930");
    assert_eq!((body["asks"].as_array().unwrap().len(), body["bids"].as_array().unwrap().len()), (9, 10));
    assert_eq!(body["asks"][0], json!({"price": 70_100, "quantity": 1_000}));
    assert_eq!((&body["totalAskQuantity"], &body["totalBidQuantity"], &body["bookTime"]), (&json!(55_000), &json!(66_000), &json!("15:30:00")));
    let calls = f.calls("ka10004");
    assert_eq!(calls.iter().map(|c| c.body.clone()).collect::<Vec<_>>(), [json!({"stk_cd": "005930_AL"})]);
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
async fn trades_ask_for_the_requested_venue_and_report_the_combined_fallback() {
    let f = Fixture::start(true).await;
    f.fake.respond_with("ka10003", 200, fixture("ka10003_005930_AL_p2"));
    let (_, nxt) = f.get("/api/symbols/005930/trades?venue=nxt").await;
    let (_, krx) = f.get("/api/symbols/005930/trades?venue=krx").await;
    let (_, fallback) = f.get("/api/symbols/005935/trades?venue=nxt").await;
    assert_eq!((&nxt["venue"], &krx["venue"], &fallback["venue"]), (&json!("nxt"), &json!("krx"), &json!("combined")));
    let asked: Vec<_> = f.calls("ka10003").into_iter().map(|c| c.body["stk_cd"].as_str().unwrap().to_owned()).collect();
    assert_eq!(asked, ["005930_NX", "005930", "005935_AL"]);
    for bad in ["venue=tokyo", "limit=0", "limit=501", "limit=x"] {
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
