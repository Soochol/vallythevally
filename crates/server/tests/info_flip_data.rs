mod support;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::FeedTrade;
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::wire::{RealItem, WsFrame, parse_ws_frame};
use server::symbols::{Directory, SymbolDirectory};
use support::{ScriptedTransport, fixture};
use tower::ServiceExt;

fn trade_frame(extra: Value) -> Option<u64> {
    let mut values = json!({"20": "093001", "10": "-71200", "15": "-15", "13": "100", "9081": "KRX", "11": "-300"});
    for (fid, value) in extra.as_object().unwrap() {
        values[fid] = value.clone();
    }
    let text = json!({"trnm": "REAL", "data": [{"type": "0B", "name": "", "item": "005930_AL", "values": values}]}).to_string();
    let WsFrame::Real(mut items) = parse_ws_frame(&text).unwrap() else { panic!("REAL 프레임이 아니다") };
    let RealItem::Trade(tick) = items.remove(0).unwrap() else { panic!("체결이 아니다") };
    tick.same_time_ratio_centi
}

#[test]
fn a_trade_frame_carries_the_same_time_volume_ratio_of_fid_851() {
    assert_eq!(trade_frame(json!({"851": "9395"})), Some(9395));
    assert_eq!(trade_frame(json!({"851": "13879"})), Some(13879));
    assert_eq!(trade_frame(json!({})), None);
    for absent in ["", " ", "0", "abc", "87.42", "-5"] {
        assert_eq!(trade_frame(json!({"851": absent})), None, "{absent:?}");
    }
}

#[test]
fn the_feed_trade_sends_the_same_time_ratio_only_when_known() {
    let without = json!({"t": 1, "price": 71200.0, "qty": -15, "venue": "krx", "strength": 101.5});
    let mut trade: FeedTrade = serde_json::from_value(without.clone()).unwrap();
    assert_eq!(trade.same_time_ratio, None);
    assert_eq!(serde_json::to_value(&trade).unwrap(), without);
    trade.same_time_ratio = Some(93.95);
    let sent = serde_json::to_value(&trade).unwrap();
    assert_eq!(sent["sameTimeRatio"], json!(93.95));
    assert_eq!(sent.as_object().unwrap().len(), without.as_object().unwrap().len() + 1);
}

async fn fundamentals_with(crd_rt: Option<Value>) -> (u16, Value) {
    let fake = ScriptedTransport::new();
    let clock = Clock::fake(KstTime::from_kst_civil(KstDate::new(2026, 11, 9).unwrap(), TimeOfDay::MIDNIGHT));
    let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
    let symbols = Arc::new(SymbolDirectory::default());
    symbols.replace(Directory::build(vec![SymbolInfo { symbol: Symbol::parse("005930").unwrap(), name: "삼성전자".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true }]));
    let tmp = tempfile::tempdir().unwrap();
    let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, events) = tokio::sync::mpsc::channel(1);
    let screener_store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
    let state = application(ApplicationInputs { rest: rest.clone(), clock, symbols, db, screener_store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
    rest.set_access(Access::Open);
    let app = router(state);
    let mut answer = fixture("ka10001_005930_AL");
    match crd_rt {
        Some(value) => answer["crd_rt"] = value,
        None => drop(answer.as_object_mut().unwrap().remove("crd_rt")),
    }
    fake.respond_with("ka10001", 200, answer);
    let request = Request::get("/api/symbols/005930/fundamentals").body(Body::empty()).unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
}

#[tokio::test]
async fn the_basic_info_answer_carries_the_credit_rate() {
    let (status, body) = fundamentals_with(Some(json!("+0.32"))).await;
    assert_eq!((status, &body["creditRate"]), (200, &json!(0.32)), "{body}");
}

#[tokio::test]
async fn an_unreadable_credit_rate_is_null_and_keeps_the_rest_of_the_basic_info() {
    for crd_rt in [None, Some(json!("")), Some(json!("abc")), Some(Value::Null), Some(json!(0.32))] {
        let case = format!("{crd_rt:?}");
        let (status, body) = fundamentals_with(crd_rt).await;
        assert_eq!((status, body.get("creditRate")), (200, Some(&Value::Null)), "{case}: {body}");
        assert_eq!((&body["upperLimit"], &body["lowerLimit"]), (&json!(245_000), &json!(132_100)), "{case}: {body}");
    }
}
