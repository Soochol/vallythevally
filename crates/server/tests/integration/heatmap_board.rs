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
use server::heatmap_board::FRESH_SECS;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

const QUOTE_API: &str = "ka10095";

#[derive(Clone, Copy)]
struct Row {
    price: u64,
    base: u64,
    traded: u64,
}

#[derive(Clone, Default)]
struct Market10095 {
    rows: Arc<Mutex<HashMap<String, Row>>>,
    asked: Arc<Mutex<Vec<Vec<String>>>>,
}

impl Market10095 {
    fn with(self, code: &str, price: u64, base: u64, traded: u64) -> Self {
        self.rows.lock().unwrap().insert(code.into(), Row { price, base, traded });
        self
    }

    fn asked(&self) -> Vec<Vec<String>> {
        self.asked.lock().unwrap().clone()
    }
}

impl Transport for Market10095 {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let reply = |body: Value| {
            let response = HttpResponse { status: 200, next_key: None, body: body.to_string() };
            Box::pin(async move { Ok(response) }) as BoxFuture<'static, _>
        };
        if req.api_id.as_str() == "au10001" {
            return reply(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}));
        }
        assert_eq!(req.api_id.as_str(), QUOTE_API);
        let body: Value = serde_json::from_str(req.body.expose()).unwrap();
        let codes: Vec<String> = body["stk_cd"].as_str().unwrap().split('|').map(|c| c.split('_').next().unwrap().to_owned()).collect();
        self.asked.lock().unwrap().push(codes.clone());
        let rows = self.rows.lock().unwrap();
        let infr: Vec<Value> = codes
            .iter()
            .filter_map(|code| rows.get(code).map(|r| (code, *r)))
            .map(|(code, r)| {
                let sig = match r.price.cmp(&r.base) {
                    std::cmp::Ordering::Greater => "2",
                    std::cmp::Ordering::Equal => "3",
                    std::cmp::Ordering::Less => "5",
                };
                json!({"stk_cd": format!("{code}_AL"), "stk_nm": code, "cur_prc": r.price.to_string(), "base_pric": r.base.to_string(),
                       "pred_pre": (r.price as i64 - r.base as i64).to_string(), "pred_pre_sig": sig, "flu_rt": "0", "trde_qty": "100",
                       "trde_prica": r.traded.to_string(), "open_pric": "1", "high_pric": "1", "low_pric": "1", "close_pric": "1",
                       "cntr_tm": "100000", "dt": "20261119", "upl_pric": "1", "lst_pric": "1"})
            })
            .collect();
        reply(json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "atn_stk_infr": infr}))
    }
}

struct Harness {
    app: Router,
    clock: Clock,
    market: Market10095,
    _tmp: tempfile::TempDir,
}

fn day() -> KstDate {
    KstDate::new(2026, 11, 19).unwrap()
}

impl Harness {
    async fn start(market: Market10095, listed: &[(&str, &str)]) -> Harness {
        Harness::start_with(market, listed, None).await
    }

    async fn start_with(market: Market10095, listed: &[(&str, &str)], catalog: Option<Value>) -> Harness {
        let clock = Clock::fake(kst(day(), 10, 1, 0));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(Arc::new(market.clone()), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let info = |(code, name): &(&str, &str)| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: (*name).to_owned(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true };
        symbols.replace(Directory::build(listed.iter().map(info).collect()));
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        let catalog_dir = tmp.path().join("kiwoom-themes");
        if let Some(catalog) = catalog {
            std::fs::create_dir_all(&catalog_dir).unwrap();
            std::fs::write(catalog_dir.join(format!("{}.json", catalog["date"].as_str().unwrap())), catalog.to_string()).unwrap();
        }
        state.kiwoom_catalog.open(catalog_dir);
        Harness { app: router(state), clock, market, _tmp: tmp }
    }

    async fn send(&self, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
        let request = Request::builder().method(method).uri(uri).header("content-type", "application/json");
        let request = request.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    async fn themes(&self, themes: Value, revision: i64) {
        let (status, body) = self.send("PUT", "/api/heatmap/themes", Some(json!({"themes": themes, "revision": revision}))).await;
        assert_eq!(status, 200, "{body}");
    }

    async fn board(&self, query: &str) -> Value {
        let (status, body) = self.send("GET", &format!("/api/heatmap/board{query}"), None).await;
        assert_eq!(status, 200, "{body}");
        body
    }
}

fn market() -> Market10095 {
    Market10095::default()
        .with("005930", 51_000, 50_000, 5_000)
        .with("000660", 109_000, 100_000, 50)
        .with("042700", 99_000, 100_000, 30)
        .with("105560", 70_000, 70_000, 400)
}

const LISTED: [(&str, &str); 4] = [("005930", "삼성전자"), ("000660", "SK하이닉스"), ("042700", "한미반도체"), ("105560", "KB금융")];

fn rounded(rate: f64) -> f64 {
    (rate * 10_000.0).round() / 10_000.0
}

fn ids(board: &Value) -> Vec<&str> {
    board["themes"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn the_board_carries_each_themes_members_and_a_traded_weighted_summary() {
    let h = Harness::start(market(), &LISTED).await;
    h.themes(json!([
        {"id": "FIN", "name": "금융", "symbols": ["105560"]},
        {"id": "CHIP", "name": "반도체", "symbols": ["005930", "000660", "042700", "999990"]},
    ]), 7).await;
    let board = h.board("").await;
    assert_eq!((board["revision"].clone(), board["order"].clone()), (json!(7), json!("rate")));
    assert_eq!(ids(&board), ["CHIP", "FIN"], "기본 순서는 가중 평균 등락률이 높은 순");
    let chip = &board["themes"][0];
    assert_eq!(chip["name"], "반도체");
    let weighted = rounded((2.0 * 5_000.0 + 9.0 * 50.0 - 1.0 * 30.0) / 5_080.0);
    assert_eq!(chip["summary"], json!({"weightedRate": weighted, "tradedMillionWon": 5_080, "rising": 2, "flat": 0, "falling": 1, "leader": "000660"}));
    assert_eq!(
        chip["members"],
        json!([
            {"symbol": "005930", "name": "삼성전자", "changeRate": 2.0, "tradedMillionWon": 5_000},
            {"symbol": "000660", "name": "SK하이닉스", "changeRate": 9.0, "tradedMillionWon": 50},
            {"symbol": "042700", "name": "한미반도체", "changeRate": -1.0, "tradedMillionWon": 30},
        ])
    );
    assert_eq!(chip["missing"], json!(["999990"]));
    assert_eq!(board["themes"][1]["summary"]["flat"], 1);
    assert_eq!(board["asOf"], kst(day(), 10, 0, 0).unix());
    assert_eq!(h.market.asked(), vec![vec!["105560", "005930", "000660", "042700", "999990"]], "테마 사이 종목을 모아 한 번에 묻는다");
}

#[tokio::test]
async fn the_order_query_picks_custom_or_traded_and_a_bad_one_is_refused() {
    let h = Harness::start(market(), &LISTED).await;
    h.themes(json!([
        {"id": "CHIP", "name": "반도체", "symbols": ["000660"]},
        {"id": "BIG", "name": "대형", "symbols": ["005930"]},
        {"id": "EMPTY", "name": "빈 테마", "symbols": []},
    ]), 1).await;
    assert_eq!(ids(&h.board("?order=custom").await), ["CHIP", "BIG", "EMPTY"]);
    assert_eq!(ids(&h.board("?order=traded").await), ["BIG", "CHIP", "EMPTY"]);
    assert_eq!(ids(&h.board("?order=rate").await), ["CHIP", "BIG", "EMPTY"]);
    for query in ["?order=name", "?venue=tokyo"] {
        let (status, body) = h.send("GET", &format!("/api/heatmap/board{query}"), None).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{query}: {body}");
    }
}

#[tokio::test]
async fn quotes_stay_fresh_for_a_while_and_a_new_member_is_the_only_one_asked() {
    let h = Harness::start(market(), &LISTED).await;
    h.themes(json!([{"id": "CHIP", "name": "반도체", "symbols": ["005930", "000660"]}]), 1).await;
    let first = h.board("").await;
    assert_eq!(h.board("").await, first);
    assert_eq!(h.market.asked().len(), 1, "신선한 동안은 키움에 다시 묻지 않는다");

    h.themes(json!([{"id": "CHIP", "name": "반도체", "symbols": ["005930", "000660", "042700"]}]), 2).await;
    let grown = h.board("").await;
    assert_eq!(grown["themes"][0]["members"].as_array().unwrap().len(), 3);
    assert_eq!(h.market.asked()[1], vec!["042700"], "새로 든 종목만 묻는다");

    h.clock.jump(FRESH_SECS + 1);
    h.board("").await;
    assert_eq!(h.market.asked()[2], vec!["005930", "000660", "042700"]);
}

#[tokio::test]
async fn no_themes_means_no_kiwoom_call() {
    let h = Harness::start(market(), &LISTED).await;
    let board = h.board("").await;
    assert_eq!((board["themes"].clone(), board["asOf"].clone()), (json!([]), Value::Null));
    assert!(h.market.asked().is_empty());
}

#[tokio::test]
async fn the_kiwoom_source_builds_themes_from_the_stored_members_with_the_same_summary() {
    let catalog = json!({"date": "20261119", "collected_at": 1_794_000_000, "themes": [
        {"code": "319", "name": "반도체", "members": ["005930", "000660"]},
        {"code": "7", "name": "금융", "members": ["105560"]},
    ]});
    let h = Harness::start_with(market(), &LISTED, Some(catalog)).await;
    h.themes(json!([{"id": "MINE", "name": "내 것", "symbols": ["042700"]}]), 3).await;
    let board = h.board("?source=kiwoom&order=custom").await;
    assert_eq!((board["source"].clone(), board["revision"].clone()), (json!("kiwoom"), json!(0)));
    assert_eq!(board["catalog"], json!({"date": "2026-11-19", "collectedAt": 1_794_000_000, "themes": 2, "state": "ready"}));
    assert_eq!(ids(&board), ["kiwoom-319", "kiwoom-7"]);
    assert_eq!(board["themes"][0]["name"], "반도체");
    assert_eq!(board["themes"][0]["summary"]["weightedRate"], rounded((2.0 * 5_000.0 + 9.0 * 50.0) / 5_050.0));
    let mine = h.board("").await;
    assert_eq!((mine["source"].clone(), mine["catalog"].clone(), ids(&mine)), (json!("mine"), Value::Null, vec!["MINE"]));
}

#[tokio::test]
async fn the_kiwoom_source_without_stored_members_is_empty_and_a_bad_source_is_refused() {
    let h = Harness::start(market(), &LISTED).await;
    let board = h.board("?source=kiwoom").await;
    assert_eq!((board["themes"].clone(), board["catalog"]["state"].clone(), board["catalog"]["date"].clone()), (json!([]), json!("empty"), Value::Null));
    let (status, body) = h.send("GET", "/api/heatmap/board?source=naver", None).await;
    assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{body}");
}
