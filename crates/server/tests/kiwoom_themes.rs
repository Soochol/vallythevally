use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{Router, body::Body, http::Request};
use domain::KstDate;
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::kiwoom_themes::FRESH_SECS;
use server::symbols::SymbolDirectory;
use tower::ServiceExt;

#[derive(Clone)]
struct Reply {
    next_key: Option<String>,
    body: Value,
}

#[derive(Clone, Debug)]
struct Sent {
    api_id: String,
    cont: Option<String>,
    body: Value,
}

type PageKey = (String, Option<String>);

#[derive(Clone, Default)]
struct Kiwoom {
    replies: Arc<Mutex<HashMap<PageKey, Reply>>>,
    sent: Arc<Mutex<Vec<Sent>>>,
}

impl Kiwoom {
    fn page(self, api_id: &str, cont: Option<&str>, next_key: Option<&str>, body: Value) -> Self {
        self.replies.lock().unwrap().insert((api_id.into(), cont.map(String::from)), Reply { next_key: next_key.map(String::from), body });
        self
    }

    fn sent(&self, api_id: &str) -> Vec<Sent> {
        self.sent.lock().unwrap().iter().filter(|s| s.api_id == api_id).cloned().collect()
    }
}

impl Transport for Kiwoom {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let respond = |next_key: Option<String>, body: Value| {
            let response = HttpResponse { status: 200, next_key, body: body.to_string() };
            Box::pin(async move { Ok(response) }) as BoxFuture<'static, _>
        };
        let api_id = req.api_id.as_str().to_owned();
        if api_id == "au10001" {
            return respond(None, json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}));
        }
        let cont = req.cont.as_ref().map(|k| k.as_str().to_owned());
        self.sent.lock().unwrap().push(Sent { api_id: api_id.clone(), cont: cont.clone(), body: serde_json::from_str(req.body.expose()).unwrap() });
        let reply = self.replies.lock().unwrap().get(&(api_id.clone(), cont.clone())).cloned().unwrap_or_else(|| panic!("준비하지 않은 요청: {api_id} {cont:?}"));
        respond(reply.next_key, reply.body)
    }
}

struct Harness {
    app: Router,
    clock: Clock,
    kiwoom: Kiwoom,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(kiwoom: Kiwoom) -> Harness {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 19).unwrap(), 10, 1, 0));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(Arc::new(kiwoom.clone()), auth, clock.clone());
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols: Arc::new(SymbolDirectory::default()), db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        Harness { app: router(state), clock, kiwoom, _tmp: tmp }
    }

    async fn get(&self, uri: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }
}

fn group(code: &str, name: &str, rate: &str, period: &str) -> Value {
    json!({"thema_grp_cd": code, "thema_nm": name, "stk_num": "10", "flu_sig": "2", "flu_rt": rate, "rising_stk_num": "7", "fall_stk_num": "3", "dt_prft_rt": period, "main_stk": "가,나"})
}

fn two_pages() -> Kiwoom {
    Kiwoom::default()
        .page("ka90001", None, Some("P2"), json!({"return_code": 0, "thema_grp": [group("319", "조선", "+3.21", "+8.00"), group("100", "원전", "+1.00", "-2.50")]}))
        .page("ka90001", Some("P2"), None, json!({"return_code": 0, "thema_grp": [group("100", "원전", "+1.00", "-2.50"), group("7", "방산", "-0.50", "+1.10")]}))
}

#[tokio::test]
async fn the_theme_list_walks_every_page_and_keeps_each_theme_once() {
    let h = Harness::start(two_pages()).await;
    let (status, list) = h.get("/api/kiwoom-themes?days=20&venue=krx").await;
    assert_eq!(status, 200, "{list}");
    assert_eq!((list["periodDays"].clone(), list["pages"].clone(), list["complete"].clone(), list["skipped"].clone()), (json!(20), json!(2), json!(true), json!(0)));
    let codes: Vec<&str> = list["themes"].as_array().unwrap().iter().map(|t| t["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["319", "100", "7"]);
    assert_eq!(list["themes"][0], json!({"code": "319", "name": "조선", "stockCount": 10, "changeRate": 3.21, "periodReturn": 8.0, "rising": 7, "falling": 3, "leaders": ["가", "나"]}));
    let sent = h.kiwoom.sent("ka90001");
    assert_eq!(sent.iter().map(|s| s.cont.clone()).collect::<Vec<_>>(), [None, Some("P2".to_owned())]);
    assert_eq!(sent[0].body, json!({"qry_tp": "0", "stk_cd": "", "date_tp": "20", "thema_nm": "", "flu_pl_amt_tp": "3", "stex_tp": "1"}));
}

#[tokio::test]
async fn the_list_is_reused_while_fresh_and_asked_again_after() {
    let h = Harness::start(two_pages()).await;
    let first = h.get("/api/kiwoom-themes").await.1;
    assert_eq!(h.get("/api/kiwoom-themes").await.1, first);
    assert_eq!(h.kiwoom.sent("ka90001").len(), 2);
    h.clock.jump(FRESH_SECS + 1);
    h.get("/api/kiwoom-themes").await;
    assert_eq!(h.kiwoom.sent("ka90001").len(), 4);
}

#[tokio::test]
async fn theme_members_carry_codes_rates_volume_period_return_and_limit_moves() {
    let kiwoom = Kiwoom::default().page("ka90002", None, None, json!({"return_code": 0, "flu_rt": "+2.00", "dt_prft_rt": "+9.10", "thema_comp_stk": [
        {"stk_cd": "042660_AL", "stk_nm": "한화오션", "cur_prc": "+91000", "flu_sig": "1", "pred_pre": "+21000", "flu_rt": "+29.99", "acc_trde_qty": "1234567", "dt_prft_rt_n": "+35.10"},
        {"stk_cd": "010140_AL", "stk_nm": "삼성중공업", "cur_prc": "-15000", "flu_sig": "5", "flu_rt": "-1.20", "acc_trde_qty": "500", "dt_prft_rt_n": ""},
    ]}));
    let h = Harness::start(kiwoom).await;
    let (status, members) = h.get("/api/kiwoom-themes/319?days=5").await;
    assert_eq!(status, 200, "{members}");
    assert_eq!((members["code"].clone(), members["changeRate"].clone(), members["periodReturn"].clone(), members["complete"].clone()), (json!("319"), json!(2.0), json!(9.1), json!(true)));
    assert_eq!(members["members"], json!([
        {"symbol": "042660", "name": "한화오션", "price": 91000, "changeRate": 29.99, "volume": 1234567, "periodReturn": 35.1, "limit": "upper"},
        {"symbol": "010140", "name": "삼성중공업", "price": 15000, "changeRate": -1.2, "volume": 500, "periodReturn": null, "limit": null},
    ]));
    assert_eq!(h.kiwoom.sent("ka90002")[0].body, json!({"date_tp": "5", "thema_grp_cd": "319", "stex_tp": "3"}));
}

#[tokio::test]
async fn a_repeated_continuation_key_stops_the_walk_with_a_protocol_error() {
    let kiwoom = Kiwoom::default()
        .page("ka90001", None, Some("P2"), json!({"return_code": 0, "thema_grp": [group("1", "가", "+1", "+1")]}))
        .page("ka90001", Some("P2"), Some("P2"), json!({"return_code": 0, "thema_grp": [group("2", "나", "+1", "+1")]}));
    let h = Harness::start(kiwoom).await;
    let (status, body) = h.get("/api/kiwoom-themes").await;
    assert_eq!((status, &body["error"]["code"], &body["error"]["reason"]), (503, &json!("kiwoom_unavailable"), &json!("protocol")), "{body}");
    assert!(body["error"]["message"].as_str().unwrap().contains("되풀이"), "{body}");
}

#[tokio::test]
async fn bad_periods_and_theme_codes_are_refused_before_kiwoom_is_called() {
    let h = Harness::start(Kiwoom::default()).await;
    for uri in ["/api/kiwoom-themes?days=0", "/api/kiwoom-themes?days=100", "/api/kiwoom-themes?venue=tokyo", "/api/kiwoom-themes/1234567", "/api/kiwoom-themes/%EA%B0%80"] {
        let (status, body) = h.get(uri).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{uri}: {body}");
    }
    assert!(h.kiwoom.sent.lock().unwrap().is_empty());
}
