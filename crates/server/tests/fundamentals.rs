use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use fake_kiwoom::{FakeKiwoom, fixture};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::bars::BarService;
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::http::{AppState, router};
use server::market::hub::MarketHub;
use server::kiwoom::api::ApiId;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::ReqwestTransport;
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

struct Fixture {
    fake: FakeKiwoom,
    rest: KiwoomRest,
    app: Router,
    _tmp: tempfile::TempDir,
}

impl Fixture {
    async fn start() -> Fixture {
        let fake = FakeKiwoom::start().await;
        let clock = Clock::fake(KstTime::from_kst_civil(KstDate::new(2026, 11, 9).unwrap(), TimeOfDay::MIDNIGHT));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(Arc::new(ReqwestTransport::new(fake.base_url()).unwrap()), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let listed = |code: &str, name: &str| SymbolInfo {
            symbol: Symbol::parse(code).unwrap(),
            name: name.into(),
            kind: SymbolKind::Common,
            market: Market::Kospi,
            nxt_enabled: true,
        };
        symbols.replace(Directory::build(vec![listed("005930", "삼성전자"), listed("999999", "목록에만 있는 종목")]));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let bars = Arc::new(BarService::new(rest.clone(), symbols.clone(), clock.clone()));
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let hub = MarketHub::spawn(bars.clone(), stream, events, clock.clone());
        let app = router(Arc::new(AppState { symbols, bars, rest: rest.clone(), db, clock, static_dir: tmp.path().to_owned(), hub }));
        Fixture { fake, rest, app, _tmp: tmp }
    }

    async fn get(&self, code: &str) -> (u16, Value) {
        let req = Request::get(format!("/api/symbols/{code}/fundamentals")).body(Body::empty()).unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    fn sends(&self) -> usize {
        self.fake.api_ids().iter().filter(|id| *id == "ka10001").count()
    }

    async fn assert_protocol_stops_the_path(&self, case: &str) {
        let (status, body) = self.get("005930").await;
        assert_eq!(status, 500, "{case}: {body}");
        assert_eq!((&body["error"]["reason"], &body["error"]["manualActionRequired"]), (&json!("protocol"), &json!(true)), "{case}: {body}");
        let (_, again) = self.get("005930").await;
        assert_eq!(again["error"]["reason"], json!("protocol"), "{case}: {again}");
        assert_eq!(self.sends(), 1, "{case}: 형식 오류 뒤에는 같은 TR을 다시 보내지 않는다");
        assert!(self.rest.stopped(ApiId::Ka10001).is_some(), "{case}");
    }
}

#[tokio::test]
async fn another_stocks_answer_is_rejected_not_shown_as_the_requested_stock() {
    let f = Fixture::start().await;
    f.fake.respond_with("ka10001", 200, fixture("ka10001_086520_AL"));
    f.assert_protocol_stops_the_path("086520_AL 원본을 005930 요청에 받음").await;
}

#[tokio::test]
async fn a_number_kiwoom_did_not_send_as_a_number_is_a_protocol_failure() {
    let f = Fixture::start().await;
    let mut body = fixture("ka10001_005930_AL");
    body["per"] = json!("not-a-number");
    f.fake.respond_with("ka10001", 200, body);
    f.assert_protocol_stops_the_path("per=\"not-a-number\"").await;
}

#[tokio::test]
async fn a_field_of_the_wrong_json_type_is_a_protocol_failure() {
    let f = Fixture::start().await;
    let mut body = fixture("ka10001_005930_AL");
    body["per"] = json!([]);
    f.fake.respond_with("ka10001", 200, body);
    f.assert_protocol_stops_the_path("per=[]").await;
}

#[tokio::test]
async fn a_success_without_the_fields_is_a_protocol_failure_not_an_unknown_stock() {
    let f = Fixture::start().await;
    f.fake.respond_with("ka10001", 200, json!({"return_code": 0, "return_msg": "ok"}));
    f.assert_protocol_stops_the_path("필드 없는 성공 응답").await;
}

#[tokio::test]
async fn kiwooms_explicitly_empty_answer_is_an_unknown_stock() {
    let f = Fixture::start().await;
    f.fake.respond_with("ka10001", 200, fixture("ka10001_999999_AL"));
    let (status, body) = f.get("999999").await;
    assert_eq!((status, &body["error"]["code"]), (404, &json!("unknown_symbol")), "{body}");
    assert!(f.rest.stopped(ApiId::Ka10001).is_none());
}
