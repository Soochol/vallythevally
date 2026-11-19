use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::journal::{BatchBegun, Begun, Prepared, PreparedBatch};
use super::tests::{ACCOUNT, DEFAULT_BAND, ETN_CODE, Fixture, HOST, WriteMode, enable, fixture, fixture_in, fixture_with, get, trading_sends};
use super::{SwitchStore, Trading};
use crate::api::{KiwoomEnvironment, OrderCommandKind, OrderCommandState};
use crate::kiwoom::api::{Endpoint, StockList};
use crate::kiwoom::rest::{ContKey, MergeScope, Priority};
use crate::config::Secret;
use crate::kiwoom::stream::{AccountEvent, AccountKind, KiwoomStream};
use crate::trading::TradingApiId;

const PLACE: &str = "/api/trading/commands/place";
const MODIFY: &str = "/api/trading/commands/modify";
const CANCEL: &str = "/api/trading/commands/cancel";
const CANCEL_BATCH: &str = "/api/trading/commands/cancel-batch";
const RECONCILE: &str = "/api/trading/commands/reconcile";

async fn order(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder().method("POST").uri(uri).header("host", HOST).header("content-type", "application/json").header("x-vally-order", "1").body(Body::from(body.to_string())).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("{uri}: JSON이 아님: {}", String::from_utf8_lossy(&bytes))))
}

fn buy(id: &str, qty: u64, price: u64) -> Value {
    json!({"commandId": id, "code": "005930", "side": "buy", "quantity": qty, "price": price})
}

fn writes(f: &Fixture) -> Vec<(&'static str, Value)> {
    f.fake
        .sent()
        .iter()
        .filter_map(|s| match s.api_id {
            Endpoint::Trading(id @ (TradingApiId::Kt10000 | TradingApiId::Kt10001 | TradingApiId::Kt10002 | TradingApiId::Kt10003)) => Some((id.as_str(), serde_json::from_str(&s.body).unwrap())),
            _ => None,
        })
        .collect()
}

async fn on() -> Fixture {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    f
}

async fn refused(f: &Fixture, body: Value, reason: &str) {
    let before = writes(f).len();
    let (code, command) = order(&f.app, PLACE, body.clone()).await;
    assert_eq!((code, command["state"].clone(), command["reason"].clone()), (StatusCode::OK, json!("rejected"), json!(reason)), "{body}: {command}");
    assert_eq!(writes(f).len(), before, "{reason}: 거절에서는 키움 쓰기가 나가지 않는다");
}

#[tokio::test]
async fn an_accepted_buy_sends_one_limit_order_and_records_the_order_number() {
    let f = on().await;
    let (code, command) = order(&f.app, PLACE, buy("cmd-buy-0001", 3, 71_000)).await;
    assert_eq!(code, StatusCode::OK, "{command}");
    assert_eq!((command["state"].clone(), command["orderNo"].clone(), command["kind"].clone(), command["venue"].clone()), (json!("accepted"), json!("0099001"), json!("buy"), json!("krx")));
    assert_eq!(writes(&f), vec![("kt10000", json!({"dmst_stex_tp": "KRX", "stk_cd": "005930", "ord_qty": "3", "ord_uv": "71000", "trde_tp": "0"}))]);
    let (_, stored) = get(&f.app, "/api/trading/commands/cmd-buy-0001").await;
    assert_eq!(stored, command);
    assert!(!command.to_string().contains("5550123401"), "저널과 응답에는 계좌번호가 없다");
    let sell = json!({"commandId": "cmd-sell-001", "code": "005930", "side": "sell", "quantity": 2, "price": 71_000, "venue": "combined"});
    let (_, command) = order(&f.app, PLACE, sell).await;
    assert_eq!(command["state"], "accepted");
    assert_eq!(writes(&f)[1], ("kt10001", json!({"dmst_stex_tp": "SOR", "stk_cd": "005930", "ord_qty": "2", "ord_uv": "71000", "trde_tp": "0"})));
}

#[tokio::test]
async fn write_is_sent_once_and_never_retried() {
    for mode in [WriteMode::Timeout, WriteMode::Refused, WriteMode::Garbage, WriteMode::NoNumber] {
        let f = on().await;
        *f.mode.lock().unwrap() = mode;
        let (code, command) = order(&f.app, PLACE, buy("cmd-once-0001", 1, 71_000)).await;
        assert_eq!((code, command["state"].clone(), command["reason"].clone()), (StatusCode::OK, json!("unknown"), Value::Null), "{mode:?}: {command}");
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(writes(&f).len(), 1, "{mode:?}: 쓰기는 한 번만 나간다");
        let (_, again) = order(&f.app, PLACE, buy("cmd-once-0001", 1, 71_000)).await;
        assert_eq!(again["state"], "unknown");
        assert_eq!(writes(&f).len(), 1, "{mode:?}: 같은 명령을 다시 받아도 보내지 않는다");
    }
}

#[tokio::test]
async fn a_kiwoom_rejection_is_final_and_does_not_block_the_account() {
    let f = on().await;
    *f.mode.lock().unwrap() = WriteMode::Reject;
    let (_, rejected) = order(&f.app, PLACE, buy("cmd-nope-0001", 1, 71_000)).await;
    assert_eq!((rejected["state"].clone(), rejected["reason"].clone()), (json!("rejected"), json!("kiwoom_rejected")));
    *f.mode.lock().unwrap() = WriteMode::Accept;
    let (_, next) = order(&f.app, PLACE, buy("cmd-next-0001", 1, 71_000)).await;
    assert_eq!(next["state"], "accepted", "정상 거절은 계좌를 막지 않는다");
    assert_eq!(writes(&f).len(), 2);
}

#[tokio::test]
async fn a_kiwoom_business_rejection_of_a_write_is_final_not_unknown() {
    let f = on().await;
    *f.mode.lock().unwrap() = WriteMode::BusinessReject;
    let (_, rejected) = order(&f.app, PLACE, buy("cmd-biz-0001", 1, 71_000)).await;
    assert_eq!((rejected["state"].clone(), rejected["reason"].clone()), (json!("rejected"), json!("kiwoom_rejected")), "{rejected}");
    let (_, list) = get(&f.app, "/api/trading/commands").await;
    assert_eq!(list["blocked"], false, "확정 거절은 쓰기를 막지 않는다");
    *f.mode.lock().unwrap() = WriteMode::Accept;
    let (_, next) = order(&f.app, PLACE, buy("cmd-biz-0002", 1, 71_000)).await;
    assert_eq!(next["state"], "accepted");
    assert_eq!(writes(&f).len(), 2);
}

#[tokio::test]
async fn same_command_id_does_not_create_a_second_order() {
    let f = on().await;
    let (_, first) = order(&f.app, PLACE, buy("cmd-same-0001", 1, 71_000)).await;
    let (code, second) = order(&f.app, PLACE, buy("cmd-same-0001", 1, 71_000)).await;
    assert_eq!((code, &second), (StatusCode::OK, &first));
    assert_eq!(writes(&f).len(), 1);
    let (code, different) = order(&f.app, PLACE, buy("cmd-same-0001", 2, 71_000)).await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "{different}");
    assert_eq!(writes(&f).len(), 1, "같은 id가 다른 내용이면 거절하고 보내지 않는다");
    let (_, rejected) = order(&f.app, PLACE, buy("cmd-same-0002", 1, 71_050)).await;
    let (_, again) = order(&f.app, PLACE, buy("cmd-same-0002", 1, 71_050)).await;
    assert_eq!((rejected["state"].clone(), &again), (json!("rejected"), &rejected), "거절된 명령도 같은 id로 되풀이하면 그 상태를 돌려준다");
}

#[tokio::test]
async fn sending_command_after_restart_stays_unknown() {
    let f = on().await;
    let journal = f.state.trading.journal.clone();
    let account_ref = f.state.trading.enabled_record().unwrap().account_ref.unwrap();
    let prepared = Prepared { command_id: "cmd-restart-01".into(), account_ref, kind: OrderCommandKind::Buy, code: Some("005930".into()), venue: Some(domain::Venue::Krx), quantity: Some(1), price: Some(71_000), target_order_no: None };
    assert!(matches!(journal.begin(&prepared, 1).await.unwrap(), Begun::Created(_)));
    journal.mark_sending("cmd-restart-01", 2).await.unwrap();
    let stale = Prepared { command_id: "cmd-restart-02".into(), ..prepared };
    assert!(matches!(journal.begin(&stale, 1).await.unwrap(), Begun::Created(_)));

    let sent = f.fake.sent().len();
    let (stream, _desired) = KiwoomStream::detached();
    let restarted = Trading::new(f.state.rest.clone(), f.state.clock.clone(), SwitchStore::memory(), stream.account_feed(), f.state.db.clone(), f.state.symbols.clone());
    let recovered = restarted.command("cmd-restart-01").await.unwrap();
    assert_eq!((recovered.state, recovered.reason), (OrderCommandState::Unknown, None));
    let closed = restarted.command("cmd-restart-02").await.unwrap();
    assert_eq!((closed.state, closed.reason), (OrderCommandState::Rejected, Some(crate::api::OrderRejectReason::NotSent)), "보내기 전이던 명령은 나간 적이 없다");
    assert_eq!(f.fake.sent().len(), sent, "다시 켠 뒤 키움 호출이 없다");
    assert_eq!(writes(&f).len(), 0);
}

#[tokio::test]
async fn unknown_blocks_new_writes_until_reconciled() {
    let f = on().await;
    *f.mode.lock().unwrap() = WriteMode::Timeout;
    let (_, unknown) = order(&f.app, PLACE, buy("cmd-lost-0001", 1, 71_000)).await;
    assert_eq!(unknown["state"], "unknown");
    *f.mode.lock().unwrap() = WriteMode::Accept;
    refused(&f, buy("cmd-blocked-01", 1, 71_000), "unknown_pending").await;
    let (_, cancel) = order(&f.app, CANCEL, json!({"commandId": "cmd-blocked-02", "orderNo": "0012345"})).await;
    assert_eq!((cancel["state"].clone(), cancel["reason"].clone()), (json!("rejected"), json!("unknown_pending")), "취소도 막는다");
    assert_eq!(writes(&f).len(), 1);
    let (_, list) = get(&f.app, "/api/trading/commands").await;
    assert_eq!(list["blocked"], true);

    let (code, reconciled) = order(&f.app, RECONCILE, json!({})).await;
    assert_eq!((code, reconciled["cleared"].clone()), (StatusCode::OK, json!(1)), "{reconciled}");
    let (_, list) = get(&f.app, "/api/trading/commands").await;
    assert_eq!(list["blocked"], false);
    let (_, open) = order(&f.app, PLACE, buy("cmd-after-0001", 1, 71_000)).await;
    assert_eq!(open["state"], "accepted", "대조한 뒤에는 새 쓰기를 받는다");
    let (_, still) = get(&f.app, "/api/trading/commands/cmd-lost-0001").await;
    assert_eq!((still["state"].clone(), still["reconciled"].clone()), (json!("unknown"), json!(true)), "대조해도 결과를 지어내지 않는다");
}

#[tokio::test]
async fn reconcile_reads_but_never_resends() {
    let f = on().await;
    *f.mode.lock().unwrap() = WriteMode::Garbage;
    order(&f.app, PLACE, buy("cmd-lost-0002", 1, 71_000)).await;
    *f.mode.lock().unwrap() = WriteMode::Accept;
    let reads = |f: &Fixture| trading_sends(&f.fake).into_iter().filter(|id| matches!(*id, "ka10075" | "kt00007")).count();
    let (writes_before, reads_before) = (writes(&f).len(), reads(&f));
    let (_, reconciled) = order(&f.app, RECONCILE, json!({})).await;
    assert_eq!(reconciled["openOrders"].as_array().unwrap().len(), 2);
    assert_eq!(reconciled["executions"].as_array().unwrap().len(), 1);
    assert_eq!(writes(&f).len(), writes_before, "원요청을 다시 보내지 않는다");
    assert_eq!(reads(&f), reads_before + 2, "미체결과 당일 체결을 다시 조회한다");
}

#[tokio::test]
async fn rejects_without_high_value_confirmation() {
    let f = on().await;
    let sell = |id: &str, confirm: bool| json!({"commandId": id, "code": "005930", "side": "sell", "quantity": 1_500, "price": 71_000, "confirmHighValue": confirm});
    refused(&f, sell("cmd-high-0001", false), "high_value_unconfirmed").await;
    let (_, confirmed) = order(&f.app, PLACE, sell("cmd-high-0002", true)).await;
    assert_eq!(confirmed["reason"], "sell_over_sellable", "확인 표시가 있으면 다음 검사로 넘어간다");
}

#[tokio::test]
async fn rejects_over_the_single_order_cap() {
    let f = on().await;
    refused(&f, json!({"commandId": "cmd-cap-00001", "code": "005930", "side": "sell", "quantity": 8_000, "price": 71_000, "confirmHighValue": true}), "over_single_order_cap").await;
}

#[tokio::test]
async fn rejects_off_tick_or_out_of_limit_price() {
    let f = on().await;
    refused(&f, buy("cmd-tick-0001", 1, 71_050), "off_tick").await;
    refused(&f, buy("cmd-tick-0002", 1, 101_000), "out_of_limit").await;
    refused(&f, buy("cmd-tick-0003", 1, 49_900), "out_of_limit").await;
}

#[tokio::test]
async fn an_etn_order_uses_the_etf_tick_table() {
    let f = on().await;
    let etn_buy = |id: &str, price: u64| json!({"commandId": id, "code": ETN_CODE, "side": "buy", "quantity": 1, "price": price});
    refused(&f, etn_buy("cmd-etn-0001", 6_463), "off_tick").await;
    let (_, accepted) = order(&f.app, PLACE, etn_buy("cmd-etn-0002", 6_465)).await;
    assert_eq!(accepted["state"], "accepted", "{accepted}");
    assert_eq!(writes(&f), vec![("kt10000", json!({"dmst_stex_tp": "KRX", "stk_cd": "520100", "ord_qty": "1", "ord_uv": "6465", "trde_tp": "0"}))]);
}

#[tokio::test]
async fn rejects_sell_over_sellable_qty() {
    let f = on().await;
    refused(&f, json!({"commandId": "cmd-sell-over1", "code": "005930", "side": "sell", "quantity": 5, "price": 71_000}), "sell_over_sellable").await;
    let (_, ok) = order(&f.app, PLACE, json!({"commandId": "cmd-sell-fits1", "code": "005930", "side": "sell", "quantity": 4, "price": 71_000})).await;
    assert_eq!(ok["state"], "accepted");
}

#[tokio::test]
async fn rejects_buy_over_buying_power() {
    let f = on().await;
    refused(&f, buy("cmd-power-0001", 15, 71_000), "buy_over_buying_power").await;
    let (_, ok) = order(&f.app, PLACE, buy("cmd-power-0002", 14, 71_000)).await;
    assert_eq!(ok["state"], "accepted");
}

#[tokio::test]
async fn rejects_nxt_route_for_krx_only_symbol() {
    let f = on().await;
    refused(&f, json!({"commandId": "cmd-nxt-00001", "code": "005935", "side": "buy", "quantity": 1, "price": 71_000, "venue": "nxt"}), "nxt_unavailable").await;
    let (_, ok) = order(&f.app, PLACE, json!({"commandId": "cmd-nxt-00002", "code": "005930", "side": "buy", "quantity": 1, "price": 71_000, "venue": "nxt"})).await;
    assert_eq!(ok["state"], "accepted");
    assert_eq!(writes(&f)[0].1["dmst_stex_tp"], "NXT");
    refused(&f, json!({"commandId": "cmd-nxt-00003", "code": "009999", "side": "buy", "quantity": 1, "price": 71_000}), "unknown_symbol").await;
}

async fn on_in(environment: KiwoomEnvironment) -> Fixture {
    let f = fixture_in(Duration::ZERO, Duration::ZERO, environment).await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    f
}

fn venue_buy(id: &str, venue: &str) -> Value {
    json!({"commandId": id, "code": "005930", "side": "buy", "quantity": 1, "price": 71_000, "venue": venue})
}

#[tokio::test]
async fn mock_refuses_nxt_and_sor_orders_before_sending() {
    let f = on_in(KiwoomEnvironment::Mock).await;
    refused(&f, venue_buy("cmd-mock-nxt01", "nxt"), "mock_krx_only").await;
    refused(&f, venue_buy("cmd-mock-sor01", "combined"), "mock_krx_only").await;
    assert_eq!(writes(&f).len(), 0);
}

#[tokio::test]
async fn mock_sends_krx_orders() {
    let f = on_in(KiwoomEnvironment::Mock).await;
    let (_, ok) = order(&f.app, PLACE, venue_buy("cmd-mock-krx01", "krx")).await;
    assert_eq!(ok["state"], "accepted", "{ok}");
    assert_eq!(writes(&f)[0].1["dmst_stex_tp"], "KRX");
}

#[tokio::test]
async fn real_keeps_every_route() {
    let f = on_in(KiwoomEnvironment::Real).await;
    for (id, venue, exchange) in [("cmd-real-nxt01", "nxt", "NXT"), ("cmd-real-sor01", "combined", "SOR"), ("cmd-real-krx01", "krx", "KRX")] {
        let (_, ok) = order(&f.app, PLACE, venue_buy(id, venue)).await;
        assert_eq!(ok["state"], "accepted", "{venue}: {ok}");
        assert_eq!(writes(&f).last().unwrap().1["dmst_stex_tp"], exchange);
    }
}

#[tokio::test]
async fn orders_off_rejects_every_write_without_calling_kiwoom() {
    let f = fixture().await;
    let bodies = [(PLACE, buy("cmd-off-00001", 1, 71_000)), (MODIFY, json!({"commandId": "cmd-off-00002", "orderNo": "0012345", "price": 71_000})), (CANCEL, json!({"commandId": "cmd-off-00003", "orderNo": "0012345"})), (CANCEL_BATCH, json!({"batchId": "batch-off-01", "code": "005930", "side": "buy", "price": 71_000})), (RECONCILE, json!({}))];
    for (uri, body) in bodies {
        let (code, error) = order(&f.app, uri, body).await;
        assert_eq!((code, error["error"]["reason"].clone()), (StatusCode::CONFLICT, json!("orders_off")), "{uri}");
    }
    assert!(f.fake.sent().is_empty(), "꺼져 있으면 키움에 아무것도 나가지 않는다");
    let (code, _) = get(&f.app, "/api/trading/commands").await;
    assert_eq!(code, StatusCode::CONFLICT);
}

#[tokio::test]
async fn turning_orders_off_while_a_command_waits_rejects_it_without_sending() {
    let f = fixture_with(Duration::from_millis(120), Duration::ZERO).await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    let placing = tokio::spawn({
        let app = f.app.clone();
        async move { order(&app, PLACE, buy("cmd-late-0001", 1, 71_000)).await }
    });
    tokio::time::sleep(Duration::from_millis(60)).await;
    f.state.trading.set_enabled(crate::api::OrdersSwitchInput { enabled: false, confirm_account_tail: None }).await.unwrap();
    let (_, command) = placing.await.unwrap();
    assert_eq!((command["state"].clone(), command["reason"].clone()), (json!("rejected"), json!("orders_off")), "{command}");
    assert_eq!(writes(&f).len(), 0);
}

#[tokio::test]
async fn modify_and_cancel_use_the_remaining_quantity_and_the_original_route() {
    let f = on().await;
    let (_, modified) = order(&f.app, MODIFY, json!({"commandId": "cmd-mod-00001", "orderNo": "0012345", "price": 71_100})).await;
    assert_eq!((modified["state"].clone(), modified["code"].clone(), modified["quantity"].clone(), modified["venue"].clone()), (json!("accepted"), json!("005930"), json!(7), json!("krx")), "{modified}");
    let (_, cancelled) = order(&f.app, CANCEL, json!({"commandId": "cmd-can-00001", "orderNo": "0012346"})).await;
    assert_eq!((cancelled["state"].clone(), cancelled["venue"].clone()), (json!("accepted"), json!("combined")), "{cancelled}");
    assert_eq!(
        writes(&f),
        vec![
            ("kt10002", json!({"dmst_stex_tp": "KRX", "orig_ord_no": "0012345", "stk_cd": "005930", "mdfy_qty": "7", "mdfy_uv": "71100"})),
            ("kt10003", json!({"dmst_stex_tp": "SOR", "orig_ord_no": "0012346", "stk_cd": "005930", "cncl_qty": "3"})),
        ]
    );
    let (_, missing) = order(&f.app, CANCEL, json!({"commandId": "cmd-can-00002", "orderNo": "0000001"})).await;
    assert_eq!((missing["state"].clone(), missing["reason"].clone()), (json!("rejected"), json!("order_not_found")));
    let (_, off_tick) = order(&f.app, MODIFY, json!({"commandId": "cmd-mod-00002", "orderNo": "0012345", "price": 71_050})).await;
    assert_eq!(off_tick["reason"], "off_tick");
    assert_eq!(writes(&f).len(), 2);
}

#[tokio::test]
async fn a_batch_cancel_queues_one_cancel_per_matching_order_and_is_idempotent() {
    let f = on().await;
    let batch = json!({"batchId": "batch-cancel-01", "code": "005930", "side": "buy", "price": 71_000});
    let (code, result) = order(&f.app, CANCEL_BATCH, batch.clone()).await;
    assert_eq!(code, StatusCode::OK, "{result}");
    let states: Vec<Value> = result["commands"].as_array().unwrap().iter().map(|c| c["state"].clone()).collect();
    assert_eq!(states, [json!("accepted")]);
    assert_eq!(writes(&f), vec![("kt10003", json!({"dmst_stex_tp": "KRX", "orig_ord_no": "0012345", "stk_cd": "005930", "cncl_qty": "7"}))]);
    let (_, again) = order(&f.app, CANCEL_BATCH, batch).await;
    assert_eq!(again["commands"], result["commands"]);
    assert_eq!(writes(&f).len(), 1, "같은 일괄 취소를 되풀이해도 다시 보내지 않는다");
    let (_, none) = order(&f.app, CANCEL_BATCH, json!({"batchId": "batch-cancel-02", "code": "005930", "side": "sell", "price": 99_000})).await;
    assert_eq!(none["commands"], json!([]));
}

#[tokio::test]
async fn a_batch_id_reused_with_other_terms_is_refused_and_sends_nothing() {
    let f = on().await;
    let id = "batch-guard-01";
    let (code, first) = order(&f.app, CANCEL_BATCH, json!({"batchId": id, "code": "005930", "side": "buy", "price": 71_000})).await;
    assert_eq!(code, StatusCode::OK, "{first}");
    assert_eq!(writes(&f).len(), 1);
    for other in [json!({"batchId": id, "code": "005930", "side": "sell", "price": 72_000}), json!({"batchId": id, "code": "000660", "side": "buy", "price": 71_000}), json!({"batchId": id, "code": "005930", "side": "buy", "price": 71_100})] {
        let (code, body) = order(&f.app, CANCEL_BATCH, other.clone()).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{other} {body}");
    }
    assert_eq!(writes(&f).len(), 1, "다른 내용의 같은 batchId는 취소를 더 보내지 않는다");
    let (code, same) = order(&f.app, CANCEL_BATCH, json!({"batchId": id, "code": "005930", "side": "buy", "price": 71_000})).await;
    assert_eq!((code, &same["commands"]), (StatusCode::OK, &first["commands"]));
    assert_eq!(writes(&f).len(), 1);
}

#[tokio::test]
async fn a_repeated_batch_returns_its_first_result_without_asking_kiwoom_again() {
    let f = on().await;
    let batch = json!({"batchId": "batch-guard-02", "code": "005930", "side": "buy", "price": 71_000});
    let (_, first) = order(&f.app, CANCEL_BATCH, batch.clone()).await;
    assert_eq!(first["commands"].as_array().unwrap().len(), 1, "{first}");
    let sent_before = trading_sends(&f.fake).len();
    let (code, again) = order(&f.app, CANCEL_BATCH, batch).await;
    assert_eq!((code, &again["commands"]), (StatusCode::OK, &first["commands"]));
    assert_eq!(trading_sends(&f.fake).len(), sent_before, "되풀이는 키움에 아무것도 보내지 않는다");
}

#[tokio::test]
async fn a_batch_adopts_a_cancel_already_journaled_under_its_command_id() {
    let f = on().await;
    let (_, single) = order(&f.app, CANCEL, json!({"commandId": "batch-adopt-01_0012345", "orderNo": "0012345"})).await;
    assert_eq!(single["state"], "accepted", "{single}");
    let batch = json!({"batchId": "batch-adopt-01", "code": "005930", "side": "buy", "price": 71_000});
    let (code, adopted) = order(&f.app, CANCEL_BATCH, batch.clone()).await;
    assert_eq!((code, &adopted["commands"][0]["commandId"]), (StatusCode::OK, &json!("batch-adopt-01_0012345")), "{adopted}");
    assert_eq!(writes(&f).len(), 1, "이미 나간 취소를 다시 보내지 않는다");
    let (code, again) = order(&f.app, CANCEL_BATCH, batch).await;
    assert_eq!((code, &again["commands"]), (StatusCode::OK, &adopted["commands"]));
    let (code, _) = order(&f.app, CANCEL_BATCH, json!({"batchId": "batch-adopt-01", "code": "005930", "side": "sell", "price": 72_000})).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(writes(&f).len(), 1);
}

#[tokio::test]
async fn a_repeated_batch_lists_adopted_and_new_commands_in_the_first_order() {
    let f = on().await;
    let journal = &f.state.trading.journal;
    let cancel = |order_no: &str| Prepared { command_id: format!("batch-order-01_{order_no}"), account_ref: "x".into(), kind: OrderCommandKind::Cancel, code: None, venue: None, quantity: None, price: None, target_order_no: Some(order_no.into()) };
    let batch = PreparedBatch { batch_id: "batch-order-01".into(), account_ref: "x".into(), code: "005930".into(), side: crate::api::OrderSide::Buy, price: 71_000 };
    journal.begin(&cancel("0000002"), 1).await.unwrap();
    let BatchBegun::Created(first) = journal.begin_batch(&batch, &[cancel("0000001"), cancel("0000002")], 2).await.unwrap() else { panic!("새 배치") };
    let Some(BatchBegun::Existing(again)) = journal.existing_batch(&batch).await.unwrap() else { panic!("기록된 배치") };
    let ids = |commands: &[crate::api::OrderCommand]| commands.iter().map(|c| c.command_id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&again), ids(&first));
}

#[tokio::test]
async fn writes_for_one_account_run_one_at_a_time() {
    let f = fixture_with(Duration::from_millis(150), Duration::ZERO).await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    let place = |id: &'static str| {
        let app = f.app.clone();
        tokio::spawn(async move { order(&app, PLACE, buy(id, 1, 71_000)).await })
    };
    let (first, second) = (place("cmd-line-0001"), place("cmd-line-0002"));
    let mut seen_waiting = false;
    for _ in 0..40 {
        let states: Vec<Value> = ["cmd-line-0001", "cmd-line-0002"].iter().map(|id| serde_json::to_value(futures::executor::block_on(f.state.trading.command(id)).ok().map(|c| c.state)).unwrap()).collect();
        seen_waiting |= states.contains(&json!("prepared")) && states.iter().any(|s| *s == json!("prepared") || *s == json!("sending"));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (a, b) = (first.await.unwrap().1, second.await.unwrap().1);
    assert_eq!((a["state"].clone(), b["state"].clone()), (json!("accepted"), json!("accepted")));
    assert!(seen_waiting, "줄 선 명령은 prepared로 보인다");
    let times: Vec<_> = f.fake.sent().iter().filter(|s| matches!(s.api_id, Endpoint::Trading(TradingApiId::Kt10000))).map(|s| s.at).collect();
    assert_eq!(times.len(), 2);
    assert!(times[1] - times[0] >= Duration::from_millis(150), "두 번째 쓰기는 첫 응답 뒤에 나간다: {:?}", times[1] - times[0]);
}

#[tokio::test]
async fn order_requests_jump_the_market_queue() {
    let f = fixture_with(Duration::ZERO, Duration::from_millis(150)).await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    let market: Vec<_> = ["a", "b", "c", "d"]
        .into_iter()
        .map(|key| {
            let rest = f.state.rest.clone();
            tokio::spawn(async move { rest.call(&StockList::EXCHANGE, Some(&ContKey::new(key)), Priority::Screen, MergeScope::default()).await.map(drop) })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(40)).await;
    let (_, command) = order(&f.app, PLACE, buy("cmd-jump-0001", 1, 71_000)).await;
    assert_eq!(command["state"], "accepted", "{command}");
    for call in market {
        call.await.unwrap().unwrap();
    }
    let sent: Vec<String> = f.fake.sent().iter().filter(|s| s.api_id != Endpoint::ISSUE).map(|s| s.cont.clone().unwrap_or_else(|| s.api_id.as_str().to_owned())).collect();
    let write = sent.iter().position(|id| id == "kt10000").unwrap();
    let last_market = sent.iter().rposition(|id| matches!(id.as_str(), "a" | "b" | "c" | "d")).unwrap();
    assert!(write < last_market, "주문 쓰기가 줄 선 시세 요청보다 먼저 나갔다: {sent:?}");
    assert!(sent.iter().take(write).filter(|id| matches!(id.as_str(), "a" | "b" | "c" | "d")).count() <= 1, "처음 나간 시세 하나만 앞선다: {sent:?}");
}

#[tokio::test]
async fn write_requires_the_order_header() {
    let f = on().await;
    for (uri, body) in [(PLACE, buy("cmd-head-0001", 1, 71_000)), (RECONCILE, json!({}))] {
        let req = Request::builder().method("POST").uri(uri).header("host", HOST).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
        let resp = f.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{uri}");
        let wrong = Request::builder().method("POST").uri(uri).header("host", HOST).header("content-type", "application/json").header("x-vally-order", "yes").body(Body::from(body.to_string())).unwrap();
        assert_eq!(f.app.clone().oneshot(wrong).await.unwrap().status(), StatusCode::BAD_REQUEST, "{uri}");
    }
    assert_eq!(writes(&f).len(), 0, "헤더가 없으면 아무것도 보내지 않는다");
    assert_eq!(order(&f.app, PLACE, buy("cmd-head-0002", 1, 71_000)).await.0, StatusCode::OK);
    assert_eq!(get(&f.app, "/api/trading/commands").await.0, StatusCode::OK, "읽기에는 헤더가 필요 없다");
}

#[tokio::test]
async fn malformed_commands_are_refused_before_the_journal() {
    let f = on().await;
    for body in [buy("short", 1, 71_000), buy("cmd-bad-0001", 0, 71_000), buy("cmd-bad-0002", 1, 0), buy("cmd-bad-0005", 1, 1 << 63), buy("cmd-bad-0006", u64::MAX, 71_000), json!({"commandId": "cmd-bad-0003", "code": "abc", "side": "buy", "quantity": 1, "price": 71_000}), json!({"commandId": "cmd bad 0004", "code": "005930", "side": "buy", "quantity": 1, "price": 71_000})] {
        let (code, _) = order(&f.app, PLACE, body.clone()).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");
    }
    let (_, list) = get(&f.app, "/api/trading/commands").await;
    assert_eq!(list["commands"], json!([]));
    assert_eq!(writes(&f).len(), 0);
}

#[tokio::test]
async fn the_journal_never_holds_the_account_number() {
    let f = on().await;
    order(&f.app, PLACE, buy("cmd-priv-0001", 1, 71_000)).await;
    let rows: Vec<String> = sqlx::query_scalar("SELECT account_ref || command_id || fingerprint || COALESCE(order_no, '') FROM order_commands").fetch_all(f.state.db.read()).await.unwrap();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|row| !row.contains("5550123401")), "{rows:?}");
}

#[tokio::test]
async fn an_unreadable_reply_leaves_unknown_but_does_not_close_the_write_path() {
    let f = on().await;
    *f.mode.lock().unwrap() = WriteMode::NullNumber;
    let (_, unknown) = order(&f.app, PLACE, buy("cmd-null-0001", 1, 71_000)).await;
    assert_eq!(unknown["state"], "unknown");
    order(&f.app, RECONCILE, json!({})).await;
    *f.mode.lock().unwrap() = WriteMode::Accept;
    let (_, next) = order(&f.app, PLACE, buy("cmd-null-0002", 1, 71_000)).await;
    assert_eq!(next["state"], "accepted", "{next}");
}

#[tokio::test]
async fn a_dropped_http_request_does_not_strand_the_command() {
    let f = fixture_with(Duration::from_millis(30), Duration::ZERO).await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    for (i, wait) in [0u64, 1, 5, 20, 60].into_iter().enumerate() {
        let id = format!("cmd-drop-{i:04}");
        let _ = tokio::time::timeout(Duration::from_millis(wait), order(&f.app, PLACE, buy(&id, 1, 71_000))).await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let (_, command) = order(&f.app, PLACE, buy(&id, 1, 71_000)).await;
        assert!(command["state"] == "accepted" || command["state"] == "rejected" && command["reason"] == "not_sent", "{wait}ms: {command}");
        assert_ne!(command["state"], "prepared", "{wait}ms");
    }
    let accepted = writes(&f).len();
    assert!(accepted <= 5, "같은 id는 한 번만 나간다: {accepted}");
}

const FUNDAMENTALS: &str = "/api/symbols/005930/fundamentals";
const OPEN_ORDERS: &str = "/api/trading/open-orders";

fn sent_ids(f: &Fixture) -> Vec<&'static str> {
    f.fake.sent().iter().filter(|s| s.api_id != Endpoint::ISSUE).map(|s| s.api_id.as_str()).collect()
}

fn sent_since(f: &Fixture, before: usize) -> Vec<&'static str> {
    sent_ids(f).split_off(before)
}

async fn remember_band(f: &Fixture) {
    assert_eq!(get(&f.app, FUNDAMENTALS).await.0, StatusCode::OK);
}

fn set_band(f: &Fixture, upper: &str, lower: &str) {
    *f.band_limits.lock().unwrap() = (upper.to_owned(), lower.to_owned());
}

fn sell(id: &str, qty: u64, price: u64) -> Value {
    json!({"commandId": id, "code": "005930", "side": "sell", "quantity": qty, "price": price})
}

#[tokio::test]
async fn place_with_remembered_band_skips_basic_info() {
    let f = on().await;
    let before = sent_ids(&f).len();
    remember_band(&f).await;
    assert_eq!(sent_since(&f, before), ["ka10001"]);
    let before = sent_ids(&f).len();
    let (_, bought) = order(&f.app, PLACE, buy("cmd-band-buy01", 3, 71_000)).await;
    assert_eq!(bought["state"], "accepted", "{bought}");
    assert_eq!(sent_since(&f, before), ["kt00010", "kt10000"]);
    let before = sent_ids(&f).len();
    let (_, sold) = order(&f.app, PLACE, sell("cmd-band-sell1", 2, 71_000)).await;
    assert_eq!(sold["state"], "accepted", "{sold}");
    assert_eq!(sent_since(&f, before), ["kt00018", "kt10001"]);
}

#[tokio::test]
async fn an_order_alone_remembers_the_band_for_the_next_one() {
    let f = on().await;
    let before = sent_ids(&f).len();
    order(&f.app, PLACE, buy("cmd-band-solo1", 1, 71_000)).await;
    order(&f.app, PLACE, buy("cmd-band-solo2", 1, 71_000)).await;
    assert_eq!(sent_since(&f, before), ["ka10001", "kt00010", "kt10000", "kt00010", "kt10000"]);
}

#[tokio::test]
async fn price_band_is_fetched_again_on_a_new_kst_day() {
    let f = on().await;
    remember_band(&f).await;
    order(&f.app, PLACE, buy("cmd-day-00001", 1, 71_000)).await;
    f.state.clock.jump(24 * 60 * 60);
    let before = sent_ids(&f).len();
    let (_, next_day) = order(&f.app, PLACE, buy("cmd-day-00002", 1, 71_000)).await;
    assert_eq!(next_day["state"], "accepted", "{next_day}");
    assert_eq!(sent_since(&f, before).iter().filter(|id| **id == "ka10001").count(), 1);
    let before = sent_ids(&f).len();
    order(&f.app, PLACE, buy("cmd-day-00003", 1, 71_000)).await;
    assert_eq!(sent_since(&f, before), ["kt00010", "kt10000"], "새 날짜의 값은 다시 기억한다");
}

#[tokio::test]
async fn missing_limits_still_refuse_with_limits_unavailable() {
    let f = on().await;
    for (round, (upper, lower)) in [("+100000", "0"), ("", "-50000"), ("0", "0"), ("", "")].into_iter().enumerate() {
        set_band(&f, upper, lower);
        remember_band(&f).await;
        let before = sent_ids(&f).len();
        refused(&f, buy(&format!("cmd-miss-000{round}"), 1, 71_000), "limits_unavailable").await;
        assert_eq!(sent_since(&f, before), ["ka10001"], "상한·하한이 없으면 기억하지 않아 주문에서 다시 묻고, 확인이 막으니 다른 조회도 쓰기도 없다: {upper:?} {lower:?}");
    }
    set_band(&f, DEFAULT_BAND[0], DEFAULT_BAND[1]);
    let (_, accepted) = order(&f.app, PLACE, buy("cmd-miss-0009", 1, 71_000)).await;
    assert_eq!(accepted["state"], "accepted", "{accepted}");
}

#[tokio::test]
async fn out_of_remembered_band_fetches_once_before_refusing() {
    let f = on().await;
    remember_band(&f).await;
    set_band(&f, "+130000", "-60000");
    let before = sent_ids(&f).len();
    let (_, inside_new) = order(&f.app, PLACE, buy("cmd-out-00001", 1, 110_000)).await;
    assert_eq!(inside_new["state"], "accepted", "{inside_new}");
    assert_eq!(sent_since(&f, before), ["ka10001", "kt00010", "kt10000"]);
    let before = sent_ids(&f).len();
    refused(&f, buy("cmd-out-00002", 1, 140_000), "out_of_limit").await;
    assert_eq!(sent_since(&f, before), ["ka10001"], "새 값으로도 밖이면 한 번 조회하고 거절한다");
    let before = sent_ids(&f).len();
    let (_, inside_old) = order(&f.app, PLACE, buy("cmd-out-00003", 1, 71_000)).await;
    assert_eq!(inside_old["state"], "accepted", "{inside_old}");
    assert_eq!(sent_since(&f, before), ["kt00010", "kt10000"], "새로 받은 값이 기억을 바꿨다");
}

#[tokio::test]
async fn cancel_with_recent_open_orders_sends_only_kt10003() {
    let f = on().await;
    remember_band(&f).await;
    get(&f.app, OPEN_ORDERS).await;
    let before = sent_ids(&f).len();
    let (_, modified) = order(&f.app, MODIFY, json!({"commandId": "cmd-fast-mod01", "orderNo": "0012345", "price": 71_100})).await;
    assert_eq!((modified["state"].clone(), modified["quantity"].clone()), (json!("accepted"), json!(7)), "{modified}");
    assert_eq!(sent_since(&f, before), ["kt10002"]);
    get(&f.app, OPEN_ORDERS).await;
    let before = sent_ids(&f).len();
    let (_, cancelled) = order(&f.app, CANCEL, json!({"commandId": "cmd-fast-can01", "orderNo": "0012346"})).await;
    assert_eq!((cancelled["state"].clone(), cancelled["venue"].clone(), cancelled["quantity"].clone()), (json!("accepted"), json!("combined"), json!(3)), "{cancelled}");
    assert_eq!(sent_since(&f, before), ["kt10003"]);
}

#[tokio::test]
async fn cancel_of_an_order_missing_from_recent_open_orders_queries_again() {
    let f = on().await;
    let cancel = |id: &str, order_no: &str| json!({"commandId": id, "orderNo": order_no});

    get(&f.app, OPEN_ORDERS).await;
    let before = sent_ids(&f).len();
    let (_, missing) = order(&f.app, CANCEL, cancel("cmd-miss-can01", "0000001")).await;
    assert_eq!((missing["state"].clone(), missing["reason"].clone()), (json!("rejected"), json!("order_not_found")));
    assert_eq!(sent_since(&f, before), ["ka10075"], "기억에 없는 주문번호는 다시 조회한다");

    get(&f.app, OPEN_ORDERS).await;
    f.state.clock.jump(11);
    let before = sent_ids(&f).len();
    order(&f.app, CANCEL, cancel("cmd-miss-can02", "0012345")).await;
    assert_eq!(sent_since(&f, before), ["ka10075", "kt10003"], "10초가 지난 기억은 쓰지 않는다");

    get(&f.app, OPEN_ORDERS).await;
    remember_band(&f).await;
    order(&f.app, PLACE, buy("cmd-miss-buy01", 1, 71_000)).await;
    let before = sent_ids(&f).len();
    order(&f.app, CANCEL, cancel("cmd-miss-can03", "0012345")).await;
    assert_eq!(sent_since(&f, before), ["ka10075", "kt10003"], "이 서버의 쓰기가 접수된 뒤에는 기억을 버린다");

    get(&f.app, OPEN_ORDERS).await;
    f.feed.emit(AccountEvent { kind: AccountKind::OrderFill, account: Secret::new(ACCOUNT.into()) });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    let before = sent_ids(&f).len();
    order(&f.app, CANCEL, cancel("cmd-miss-can04", "0012345")).await;
    assert_eq!(sent_since(&f, before), ["ka10075", "kt10003"], "계좌 이벤트가 오면 기억을 버린다");
}

#[tokio::test]
async fn an_open_orders_read_that_overlaps_a_write_is_not_remembered() {
    let f = fixture_with(Duration::from_millis(50), Duration::ZERO).await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    remember_band(&f).await;
    let slow_read = {
        let trading = f.state.trading.clone();
        tokio::spawn(async move { trading.open_orders().await.map(drop) })
    };
    tokio::time::sleep(Duration::from_millis(10)).await;
    let (_, placed) = order(&f.app, PLACE, buy("cmd-race-buy01", 1, 71_000)).await;
    assert_eq!(placed["state"], "accepted", "{placed}");
    slow_read.await.unwrap().unwrap();
    let before = sent_ids(&f).len();
    order(&f.app, CANCEL, json!({"commandId": "cmd-race-can01", "orderNo": "0012345"})).await;
    assert_eq!(sent_since(&f, before), ["ka10075", "kt10003"], "쓰기 전에 시작한 조회의 결과는 기억하지 않는다");
}

fn same_price_rows(order_nos: &[&str]) -> Value {
    Value::Array(order_nos.iter().map(|no| json!({"acnt_no": null, "ord_no": no, "stk_cd": "005930", "stk_nm": "삼성전자", "ord_stt": "접수", "ord_qty": "5", "ord_pric": "71000", "oso_qty": "5", "orig_ord_no": "0000000", "io_tp_nm": "-매수", "trde_tp": "보통", "tm": "093001", "stex_tp": "1", "stex_tp_txt": "KRX", "sor_yn": "N"})).collect())
}

#[tokio::test]
async fn batch_cancel_lists_once_then_sends_each() {
    let f = on().await;
    *f.open_rows.lock().unwrap() = Some(same_price_rows(&["0020001", "0020002", "0020003"]));
    get(&f.app, OPEN_ORDERS).await;
    f.state.trading.remember_price_band(domain::StockCode::parse("005930").unwrap(), Some(100_000), Some(50_000));
    let before = sent_ids(&f).len();
    let batch = json!({"batchId": "batch-fast-0001", "code": "005930", "side": "buy", "price": 71_000});
    let (code, result) = order(&f.app, CANCEL_BATCH, batch.clone()).await;
    assert_eq!(code, StatusCode::OK, "{result}");
    assert_eq!(sent_since(&f, before), ["ka10075", "kt10003", "kt10003", "kt10003"], "대상은 새로 조회하고 건마다 취소만 보낸다");
    let commands = result["commands"].as_array().unwrap();
    assert_eq!(commands.iter().map(|c| (c["state"].clone(), c["code"].clone(), c["quantity"].clone())).collect::<Vec<_>>(), vec![(json!("accepted"), json!("005930"), json!(5)); 3], "저널에는 건마다 대상 확인이 남는다");
    assert_eq!(writes(&f).iter().map(|(_, body)| body["orig_ord_no"].clone()).collect::<Vec<_>>(), [json!("0020001"), json!("0020002"), json!("0020003")]);
    let before = sent_ids(&f).len();
    let (_, again) = order(&f.app, CANCEL_BATCH, batch).await;
    assert_eq!(again["commands"], result["commands"]);
    assert_eq!(sent_since(&f, before), Vec::<&str>::new(), "같은 batch_id 재요청은 새로 보내지 않는다");
}

#[tokio::test]
async fn a_batch_lists_afresh_even_when_open_orders_were_just_read() {
    let f = on().await;
    get(&f.app, OPEN_ORDERS).await;
    *f.open_rows.lock().unwrap() = Some(same_price_rows(&["0020001", "0020002"]));
    let before = sent_ids(&f).len();
    let (_, result) = order(&f.app, CANCEL_BATCH, json!({"batchId": "batch-fast-0002", "code": "005930", "side": "buy", "price": 71_000})).await;
    assert_eq!(result["commands"].as_array().unwrap().len(), 2, "막 들어온 주문도 빠뜨리지 않는다: {result}");
    assert_eq!(sent_since(&f, before), ["ka10075", "kt10003", "kt10003"]);
}

#[tokio::test]
async fn order_latency_probe() {
    let mut table = vec!["조건(지연, 간격) | 동작 | 키움 전송 순서 | HTTP 총 시간".to_owned()];
    let mut mismatches = Vec::new();
    for (latency_ms, spacing_ms) in [(0u64, 260u64), (100, 260)] {
        let spacing = Duration::from_millis(spacing_ms);
        let f = fixture_with(Duration::from_millis(latency_ms), spacing).await;
        assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
        let tag = format!("{latency_ms}-{spacing_ms}");
        let actions: Vec<(&str, Vec<&str>)> = vec![
            ("매수", vec!["kt00010", "kt10000"]),
            ("매도", vec!["kt00018", "kt10001"]),
            ("단건 취소", vec!["kt10003"]),
            ("같은 가격 3건 일괄 취소", vec!["ka10075", "kt10003", "kt10003", "kt10003"]),
            ("정정 1건", vec!["kt10002"]),
        ];
        for (index, (name, expected)) in actions.into_iter().enumerate() {
            *f.open_rows.lock().unwrap() = (name == "같은 가격 3건 일괄 취소").then(|| same_price_rows(&["0020001", "0020002", "0020003"]));
            get(&f.app, FUNDAMENTALS).await;
            get(&f.app, OPEN_ORDERS).await;
            tokio::time::sleep(spacing + Duration::from_millis(60)).await;
            let before = sent_ids(&f).len();
            let started = tokio::time::Instant::now();
            let (_, reply) = match name {
                "매수" => order(&f.app, PLACE, buy(&format!("cmd-probe-{tag}-{index}"), 3, 71_000)).await,
                "매도" => order(&f.app, PLACE, sell(&format!("cmd-probe-{tag}-{index}"), 2, 71_000)).await,
                "단건 취소" => order(&f.app, CANCEL, json!({"commandId": format!("cmd-probe-{tag}-{index}"), "orderNo": "0012346"})).await,
                "같은 가격 3건 일괄 취소" => order(&f.app, CANCEL_BATCH, json!({"batchId": format!("batch-probe-{tag}"), "code": "005930", "side": "buy", "price": 71_000})).await,
                _ => order(&f.app, MODIFY, json!({"commandId": format!("cmd-probe-{tag}-{index}"), "orderNo": "0012345", "price": 71_100})).await,
            };
            let elapsed = started.elapsed();
            assert!(reply.to_string().contains("accepted"), "{name}: {reply}");
            let sent = sent_since(&f, before);
            table.push(format!("{latency_ms}ms, {spacing_ms}ms | {name} | {} | {}ms", sent.join(" → "), elapsed.as_millis()));
            if sent != expected {
                mismatches.push(format!("{latency_ms}ms {name}: {sent:?} != {expected:?}"));
            }
        }
    }
    println!("{}", table.join("\n"));
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

#[tokio::test]
async fn turning_orders_off_and_on_drops_the_recent_open_orders() {
    let f = on().await;
    get(&f.app, OPEN_ORDERS).await;
    let (code, _) = super::tests::call(&f.app, "PUT", "/api/system/orders", Some(json!({"enabled": false}))).await;
    assert_eq!(code, StatusCode::OK);
    *f.open_rows.lock().unwrap() = Some(json!([]));
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    let before = sent_ids(&f).len();
    let (_, cancelled) = order(&f.app, CANCEL, json!({"commandId": "cmd-offon-0001", "orderNo": "0012345"})).await;
    assert_eq!((cancelled["state"].clone(), cancelled["reason"].clone()), (json!("rejected"), json!("order_not_found")), "{cancelled}");
    assert_eq!(sent_since(&f, before), ["ka10075"]);
}

#[tokio::test]
async fn a_batch_waiting_for_the_turn_lists_after_the_write_ahead_of_it() {
    let f = fixture_with(Duration::from_millis(300), Duration::ZERO).await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    *f.open_rows.lock().unwrap() = Some(same_price_rows(&["0020001", "0020002"]));
    get(&f.app, OPEN_ORDERS).await;
    let single = tokio::spawn({
        let app = f.app.clone();
        async move { order(&app, CANCEL, json!({"commandId": "cmd-turn-single", "orderNo": "0020001"})).await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    let batch = tokio::spawn({
        let app = f.app.clone();
        async move { order(&app, CANCEL_BATCH, json!({"batchId": "batch-turn-0001", "code": "005930", "side": "buy", "price": 71_000})).await }
    });
    tokio::time::sleep(Duration::from_millis(120)).await;
    *f.open_rows.lock().unwrap() = Some(same_price_rows(&["0020002"]));
    assert_eq!(single.await.unwrap().1["state"], "accepted");
    let (_, batch) = batch.await.unwrap();
    assert_eq!(batch["commands"].as_array().unwrap().len(), 1, "{batch}");
    let cancelled: Vec<Value> = writes(&f).into_iter().map(|(_, body)| body["orig_ord_no"].clone()).collect();
    assert_eq!(cancelled, [json!("0020001"), json!("0020002")], "이미 취소 접수된 주문에 다시 보내지 않는다");
}
