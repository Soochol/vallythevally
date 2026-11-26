use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::heatmap_flow::{FRESH_SECS, MAX_SYMBOLS};
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

const MINUTE_API: &str = "ka10080";

type Closes = Vec<(&'static str, u64)>;

#[derive(Clone, Default)]
struct Chart {
    closes: Arc<Mutex<HashMap<String, Closes>>>,
    default: Arc<Mutex<Closes>>,
    minute_calls: Arc<Mutex<Vec<String>>>,
}

impl Chart {
    fn with(self, code: &str, closes: Closes) -> Self {
        self.closes.lock().unwrap().insert(code.into(), closes);
        self
    }

    fn by_default(self, closes: Closes) -> Self {
        *self.default.lock().unwrap() = closes;
        self
    }

    fn minute_calls(&self) -> usize {
        self.minute_calls.lock().unwrap().len()
    }
}

fn row(time: &str, close: u64) -> Value {
    json!({"cntr_tm": time, "open_pric": close.to_string(), "high_pric": close.to_string(), "low_pric": close.to_string(), "cur_prc": close.to_string(), "trde_qty": "10"})
}

impl Transport for Chart {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let reply = |body: Value| {
            let response = HttpResponse { status: 200, next_key: None, body: body.to_string() };
            Box::pin(async move { Ok(response) }) as BoxFuture<'static, _>
        };
        if req.api_id.as_str() == "au10001" {
            return reply(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}));
        }
        assert_eq!(req.api_id.as_str(), MINUTE_API);
        let body: Value = serde_json::from_str(req.body.expose()).unwrap();
        let code = body["stk_cd"].as_str().unwrap().split('_').next().unwrap().to_owned();
        self.minute_calls.lock().unwrap().push(code.clone());
        let closes = self.closes.lock().unwrap().get(&code).cloned().unwrap_or_else(|| self.default.lock().unwrap().clone());
        let rows: Vec<Value> = if closes.is_empty() { vec![row("", 0)] } else { closes.iter().rev().map(|(time, close)| row(time, *close)).collect() };
        reply(json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_min_pole_chart_qry": rows}))
    }
}

struct Harness {
    app: Router,
    clock: Clock,
    chart: Chart,
    _tmp: tempfile::TempDir,
}

fn day() -> KstDate {
    KstDate::new(2026, 11, 19).unwrap()
}

impl Harness {
    async fn start(chart: Chart, listed: &[String]) -> Harness {
        let clock = Clock::fake(kst(day(), 10, 1, 0));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(Arc::new(chart.clone()), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let info = |code: &String| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: code.clone(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true };
        symbols.replace(Directory::build(listed.iter().map(info).collect()));
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        tokio::time::pause();
        Harness { app: router(state), clock, chart, _tmp: tmp }
    }

    async fn get(&self, symbols: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(format!("/api/heatmap/flow?symbols={symbols}")).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    async fn ok(&self, symbols: &str) -> Value {
        let (status, body) = self.get(symbols).await;
        assert_eq!(status, 200, "{body}");
        body
    }
}

fn unix(h: u32, m: u32) -> i64 {
    kst(day(), h, m, 0).unix()
}

fn listed(codes: &[&str]) -> Vec<String> {
    codes.iter().map(|c| (*c).to_owned()).collect()
}

fn pair() -> Chart {
    Chart::default()
        .with("005930", vec![("20261118153000", 10_000), ("20261119090000", 10_100), ("20261119090400", 10_200), ("20261119090500", 10_500), ("20261119090900", 10_600)])
        .with("000660", vec![("20261118153000", 20_000), ("20261119090000", 20_200), ("20261119090400", 20_400), ("20261119090700", 19_800)])
}

#[tokio::test]
async fn the_five_minute_traded_weighted_average_matches_the_hand_computed_rates() {
    let h = Harness::start(pair(), &listed(&["005930", "000660"])).await;
    let flow = h.ok("005930,000660").await;
    assert_eq!(flow["date"], "2026-11-19");
    assert_eq!(flow["bucketMinutes"], 5);
    assert_eq!(flow["points"], json!([{"t": unix(9, 0), "rate": 2.0}, {"t": unix(9, 5), "rate": 1.8468}]));
    assert_eq!(flow["used"], json!(["005930", "000660"]));
    assert_eq!(flow["missing"], json!([]));
    assert_eq!(flow["overLimit"], json!([]));
}

#[tokio::test]
async fn asking_again_within_the_fresh_window_does_not_call_kiwoom_for_minute_bars() {
    let h = Harness::start(pair(), &listed(&["005930", "000660"])).await;
    let first = h.ok("005930,000660").await;
    assert_eq!(h.chart.minute_calls(), 2);

    let second = h.ok("005930,000660").await;
    assert_eq!(second, first);
    assert_eq!(h.chart.minute_calls(), 2);

    h.clock.jump(FRESH_SECS + 1);
    h.ok("005930,000660").await;
    assert_eq!(h.chart.minute_calls(), 4);
}

#[tokio::test]
async fn a_symbol_shared_with_another_group_is_not_fetched_twice() {
    let h = Harness::start(pair(), &listed(&["005930", "000660"])).await;
    h.ok("005930").await;
    h.ok("005930,000660").await;
    assert_eq!(h.chart.minute_calls(), 2);
}

#[tokio::test]
async fn symbols_over_the_limit_are_left_out_and_listed() {
    let codes: Vec<String> = (0..MAX_SYMBOLS + 2).map(|i| format!("1{i:05}")).collect();
    let chart = Chart::default().by_default(vec![("20261118153000", 10_000), ("20261119090000", 10_100)]);
    let h = Harness::start(chart, &codes).await;
    let flow = h.ok(&codes.join(",")).await;
    assert_eq!(flow["used"].as_array().unwrap().len(), MAX_SYMBOLS);
    assert_eq!(flow["used"][0], codes[0].as_str());
    assert_eq!(flow["overLimit"], json!([codes[MAX_SYMBOLS], codes[MAX_SYMBOLS + 1]]));
    assert_eq!(flow["limit"], MAX_SYMBOLS);
    assert_eq!(flow["missing"], json!([]));
    assert_eq!(h.chart.minute_calls(), MAX_SYMBOLS);
    assert_eq!(flow["points"], json!([{"t": unix(9, 0), "rate": 1.0}]));
}

#[tokio::test]
async fn a_symbol_whose_minute_bars_fail_is_left_out_and_the_series_still_comes() {
    let chart = pair().with("005380", vec![]);
    let h = Harness::start(chart, &listed(&["005930", "000660", "005380"])).await;
    let flow = h.ok("005930,005380,000660").await;
    assert_eq!(flow["used"], json!(["005930", "000660"]));
    assert_eq!(flow["missing"], json!(["005380"]));
    assert_eq!(flow["points"], json!([{"t": unix(9, 0), "rate": 2.0}, {"t": unix(9, 5), "rate": 1.8468}]));
}

#[tokio::test]
async fn a_symbol_without_a_previous_day_bar_is_left_out() {
    let chart = pair().with("005380", vec![("20261119090000", 50_000)]);
    let h = Harness::start(chart, &listed(&["005930", "000660", "005380"])).await;
    let flow = h.ok("005930,005380,000660").await;
    assert_eq!(flow["missing"], json!(["005380"]));
    assert_eq!(flow["points"][0]["rate"], 2.0);
}

#[tokio::test]
async fn when_no_symbol_has_minute_bars_the_request_fails() {
    let chart = Chart::default().with("005380", vec![]);
    let h = Harness::start(chart, &listed(&["005380"])).await;
    let (status, body) = h.get("005380").await;
    assert_eq!((status, &body["error"]["code"]), (404, &json!("unknown_symbol")), "{body}");
}

#[tokio::test]
async fn a_bad_request_is_rejected_before_kiwoom_is_called() {
    let h = Harness::start(pair(), &listed(&["005930"])).await;
    for query in ["", "005930,bad", "005930&venue=tokyo"] {
        let (status, body) = h.get(query).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{query}: {body}");
    }
    assert_eq!(h.chart.minute_calls(), 0);
}
