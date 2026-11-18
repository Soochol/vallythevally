use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::journal::{BatchBegun, Begun, Prepared, PreparedBatch};
use super::tests::{Fixture, HOST, WriteMode, enable, fixture, fixture_with, get, trading_sends};
use super::{SwitchStore, Trading};
use crate::api::{OrderCommandKind, OrderCommandState};
use crate::kiwoom::api::{Endpoint, StockList};
use crate::kiwoom::rest::{ContKey, MergeScope, Priority};
use crate::kiwoom::stream::KiwoomStream;
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
