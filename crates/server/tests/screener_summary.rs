use std::sync::Arc;
use std::time::Duration;

use domain::{KstDate, KstTime, StockCode, TimeOfDay, Venue};
use fake_kiwoom::{APP_KEY, APP_SECRET, FakeKiwoom, KrxBar, ScriptedReply, summary};
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{KiwoomError, KiwoomRest};
use server::kiwoom::transport::ReqwestTransport;
use server::kiwoom::wire::KrxSummaryValues;
use server::screener::summary::{CollectionBasis, CollectionError, MissingSummary, SummaryCollector};

fn day(n: u8) -> KstDate {
    KstDate::new(2026, 11, n).unwrap()
}

fn code(n: usize) -> StockCode {
    StockCode::parse(&format!("{n:06}")).unwrap()
}

fn row(n: usize) -> Value {
    summary::row(code(n).as_str(), KrxBar {
        day: day(12), open: 10_000, high: 12_000, low: 9_000, close: 11_000,
        volume: 300, traded_million_won: 7, base: 10_500, adjustment_rate: None,
    }, "090100")
}

fn reply(rows: Vec<Value>) -> ScriptedReply {
    ScriptedReply { status: 200, body: json!({"return_code": 0, "atn_stk_infr": rows}), delay: Duration::ZERO }
}

fn failure(detail: &str) -> ScriptedReply {
    ScriptedReply { status: 200, body: json!({"return_code": 2, "return_msg": detail}), delay: Duration::ZERO }
}

async fn setup(at: KstTime) -> (FakeKiwoom, Arc<SummaryCollector>, Clock) {
    let fake = FakeKiwoom::start().await;
    let clock = Clock::fake(at);
    let rest = KiwoomRest::new(Arc::new(ReqwestTransport::new(fake.base_url()).unwrap()), KiwoomAuth::new(Secret::new(APP_KEY.into()), Secret::new(APP_SECRET.into()), None), clock.clone());
    let collector = SummaryCollector::new(rest, clock.clone());
    (fake, collector, clock)
}

async fn noon() -> (FakeKiwoom, Arc<SummaryCollector>, Clock) {
    setup(kst(day(12), 12, 0, 0)).await
}

fn calls(fake: &FakeKiwoom) -> usize {
    fake.calls().iter().filter(|c| c.api_id == "ka10095").count()
}

async fn wait_calls(fake: &FakeKiwoom, n: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while calls(fake) < n {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
}

#[tokio::test]
async fn batches_at_100_boundary_join_by_code_and_preserve_krx_units_and_times() {
    let (fake, collector, _) = noon().await;
    let mut rows: Vec<_> = (1..=201).rev().map(|n| {
        let mut value = row(n);
        value["cur_prc"] = (11_000 + n).to_string().into();
        value
    }).collect();
    rows[0]["cur_prc"] = "-11201".into();
    fake.set_quote_rows(rows);
    for size in [0, 1, 99, 100, 101, 200, 201] {
        let seen = calls(&fake);
        let targets = (1..=size).map(code).collect();
        let batch = collector.collect(targets, CollectionBasis::default()).await.unwrap();
        assert_eq!(batch.stocks.len(), size);
        assert_eq!(batch.missing_count(), 0);
        assert_eq!(batch.venue, Venue::Krx);
        assert_eq!(batch.target, day(12));
        assert!(batch.started_at <= batch.completed_at);
        assert_eq!(calls(&fake) - seen, size.div_ceil(100));
        for (stock_code, stock) in &batch.stocks {
            assert!(stock.received_at >= batch.started_at && stock.received_at <= batch.completed_at);
            let quote = stock.result.as_ref().unwrap();
            assert_eq!((quote.day, quote.trade_time, quote.base.centi()), (day(12), TimeOfDay::hms(9, 1, 0), 1_050_000));
            let KrxSummaryValues::Traded { ohlcv, traded } = quote.values else { panic!("거래 행") };
            let close = (11_000 + stock_code.as_str().parse::<u64>().unwrap()) * 100;
            assert_eq!((ohlcv.open().centi(), ohlcv.high().centi(), ohlcv.low().centi(), ohlcv.close().centi(), ohlcv.volume().0, traded.0), (1_000_000, 1_200_000, 900_000, close, 300, 7));
        }
    }
    let sizes: Vec<_> = fake.calls().iter().filter(|c| c.api_id == "ka10095").map(|c| {
        let codes = c.body["stk_cd"].as_str().unwrap();
        assert!(!codes.contains('_'));
        codes.split('|').count()
    }).collect();
    assert_eq!(sizes, [1, 99, 100, 100, 1, 100, 100, 100, 100, 1]);
}

#[tokio::test]
async fn concurrent_calls_share_one_collection_but_calls_after_completion_fetch_again() {
    let (fake, collector, _) = noon().await;
    fake.set_quote_rows(vec![row(1), row(2)]);
    fake.delay("ka10095", Duration::from_millis(100));
    let (a, b) = tokio::join!(collector.collect(vec![code(1), code(2)], CollectionBasis::default()), collector.collect(vec![code(2), code(1), code(1)], CollectionBasis::default()));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert!(Arc::ptr_eq(&a, &b));
    assert_eq!(calls(&fake), 1);
    let c = collector.collect(vec![code(1), code(2)], CollectionBasis::default()).await.unwrap();
    assert_ne!(a.id, c.id);
    assert_eq!(calls(&fake), 2);
}

#[tokio::test]
async fn first_request_failure_never_publishes_a_batch_and_keeps_previous_completion() {
    let (fake, collector, _) = noon().await;
    fake.script("ka10095", vec![failure("[1501:입력 오류]")]);
    assert!(matches!(collector.collect(vec![code(1)], CollectionBasis::default()).await, Err(CollectionError::Kiwoom(_))));
    assert!(collector.completed().is_none());
    fake.set_quote_rows(vec![row(1)]);
    let previous = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap();
    fake.script("ka10095", vec![failure("[1501:입력 오류]")]);
    assert!(collector.collect(vec![code(1)], CollectionBasis::default()).await.is_err());
    assert!(Arc::ptr_eq(&previous, &collector.completed().unwrap()));
}

#[tokio::test]
async fn middle_request_failure_discards_partial_rows_without_mixing_previous_batch() {
    let (fake, collector, _) = noon().await;
    fake.script("ka10095", vec![reply((1..=100).map(row).collect()), failure("[1501:입력 오류]")]);
    let targets: Vec<_> = (1..=101).map(code).collect();
    assert!(matches!(collector.collect(targets.clone(), CollectionBasis::default()).await, Err(CollectionError::Kiwoom(_))));
    assert_eq!(calls(&fake), 2);
    assert!(collector.completed().is_none());
    fake.set_quote_rows((1..=101).map(row).collect());
    let previous = collector.collect(targets.clone(), CollectionBasis::default()).await.unwrap();
    let mut changed = row(1);
    changed["cur_prc"] = "11500".into();
    fake.script("ka10095", vec![reply(vec![changed]), failure("[1501:입력 오류]")]);
    assert!(collector.collect(targets, CollectionBasis::default()).await.is_err());
    assert!(Arc::ptr_eq(&previous, &collector.completed().unwrap()));
}

#[tokio::test]
async fn individual_missing_unreadable_duplicate_and_other_venue_rows_preserve_good_rows() {
    let (fake, collector, _) = noon().await;
    let mut bad = row(3);
    bad["cur_prc"] = json!({"invalid": true});
    let mut nxt = row(5);
    nxt["stk_cd"] = "000005_NX".into();
    let mut combined = row(6);
    combined["stk_cd"] = "000006_AL".into();
    fake.script("ka10095", vec![reply(vec![row(1), bad, row(4), row(4), nxt, combined, Value::Null])]);
    let batch = collector.collect((1..=6).map(code).collect(), CollectionBasis::default()).await.unwrap();
    assert_eq!(batch.missing_count(), 5);
    assert!(batch.stocks[&code(1)].result.is_ok());
    assert_eq!(batch.stocks[&code(2)].result, Err(MissingSummary::MissingRow));
    assert!(matches!(batch.stocks[&code(3)].result, Err(MissingSummary::Unreadable(_))));
    assert_eq!(batch.stocks[&code(4)].result, Err(MissingSummary::DuplicateRow));
    assert_eq!(batch.stocks[&code(5)].result, Err(MissingSummary::MissingRow));
    assert_eq!(batch.stocks[&code(6)].result, Err(MissingSummary::MissingRow));
}

#[tokio::test]
async fn premarket_confirmed_no_trades_is_distinct_from_old_missing_or_unreadable_dates() {
    let (fake, collector, _) = setup(kst(day(12), 8, 0, 0)).await;
    let mut no_trades = row(1);
    for field in ["open_pric", "high_pric", "low_pric", "cur_prc", "trde_qty", "trde_prica"] {
        no_trades[field] = "0".into();
    }
    no_trades["cntr_tm"] = "".into();
    let mut yesterday = no_trades.clone();
    yesterday["stk_cd"] = code(2).as_str().into();
    yesterday["dt"] = "20261111".into();
    let mut bad_date = row(3);
    bad_date["dt"] = "20260230".into();
    let mut unknown_date = no_trades.clone();
    unknown_date["stk_cd"] = code(4).as_str().into();
    unknown_date["dt"] = "".into();
    let mut future = row(5);
    future["dt"] = "20261113".into();
    fake.set_quote_rows(vec![no_trades, yesterday, bad_date, unknown_date, future]);
    let batch = collector.collect((1..=6).map(code).collect(), CollectionBasis::default()).await.unwrap();
    let known = batch.stocks[&code(1)].result.as_ref().unwrap();
    assert_eq!(known.values, KrxSummaryValues::NoTrades { current_centi: 0 });
    assert_eq!(known.trade_time, None);
    assert_eq!(batch.stocks[&code(2)].result, Err(MissingSummary::OtherDate(day(11))));
    for n in [3, 4] {
        assert!(matches!(batch.stocks[&code(n)].result, Err(MissingSummary::Unreadable(_))));
    }
    assert_eq!(batch.stocks[&code(5)].result, Err(MissingSummary::OtherDate(day(13))));
    assert_eq!(batch.missing_count(), 5);
}

#[tokio::test]
async fn holiday_does_not_turn_previous_trading_day_into_confirmed_no_trades() {
    let (fake, collector, _) = setup(kst(day(14), 12, 0, 0)).await;
    let mut friday = row(1);
    friday["dt"] = "20261113".into();
    fake.set_quote_rows(vec![friday]);
    let batch = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap();
    assert_eq!(batch.stocks[&code(1)].result, Err(MissingSummary::OtherDate(day(13))));
}

#[tokio::test]
async fn stale_trade_time_is_allowed_but_invalid_time_and_inconsistent_zero_volume_are_not() {
    let (fake, collector, _) = noon().await;
    let mut bad_time = row(2);
    bad_time["cntr_tm"] = "256199".into();
    let mut contradictory = row(3);
    contradictory["trde_qty"] = "0".into();
    let mut invalid_ohlc = row(4);
    invalid_ohlc["high_pric"] = "10500".into();
    fake.set_quote_rows(vec![row(1), bad_time, contradictory, invalid_ohlc]);
    let batch = collector.collect((1..=4).map(code).collect(), CollectionBasis::default()).await.unwrap();
    assert!(batch.stocks[&code(1)].result.is_ok());
    assert_eq!(batch.missing_count(), 3);
}

#[tokio::test]
async fn midnight_during_delayed_response_rejects_batch_then_new_date_fetches_again() {
    let (fake, collector, clock) = setup(kst(day(12), 23, 59, 0)).await;
    fake.set_quote_rows(vec![row(1)]);
    let previous = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap();
    let mut delayed = reply(vec![row(1)]);
    delayed.delay = Duration::from_millis(150);
    fake.script("ka10095", vec![delayed]);
    let task = tokio::spawn({ let collector = collector.clone(); async move { collector.collect(vec![code(1)], CollectionBasis::default()).await } });
    wait_calls(&fake, 2).await;
    clock.jump(61);
    assert_eq!(task.await.unwrap().unwrap_err(), CollectionError::DateChanged);
    assert!(Arc::ptr_eq(&previous, &collector.completed().unwrap()));
    let mut next_day = row(1);
    next_day["dt"] = "20261113".into();
    fake.set_quote_rows(vec![next_day]);
    let next = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap();
    assert_eq!(next.target, day(13));
    assert_ne!(next.id, previous.id);
    assert_eq!(calls(&fake), 3);
}

#[tokio::test]
async fn cancel_notifies_all_waiters_and_late_response_cannot_replace_new_collection() {
    let (fake, collector, _) = noon().await;
    let mut delayed = reply(vec![row(1)]);
    delayed.delay = Duration::from_millis(600);
    let mut changed = row(1);
    changed["cur_prc"] = "11500".into();
    fake.script("ka10095", vec![delayed, reply(vec![changed])]);
    let a = tokio::spawn({ let collector = collector.clone(); async move { collector.collect(vec![code(1)], CollectionBasis::default()).await } });
    wait_calls(&fake, 1).await;
    let b = collector.collect(vec![code(1)], CollectionBasis::default());
    tokio::pin!(b);
    tokio::select! { result = &mut b => panic!("아직 수집 중: {result:?}"), _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
    collector.cancel();
    assert_eq!(a.await.unwrap().unwrap_err(), CollectionError::Cancelled);
    assert_eq!(b.await.unwrap_err(), CollectionError::Cancelled);
    assert!(collector.completed().is_none());
    let next = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap();
    assert_eq!(calls(&fake), 2);
    let KrxSummaryValues::Traded { ohlcv, .. } = next.stocks[&code(1)].result.as_ref().unwrap().values else { panic!("거래 행") };
    assert_eq!(ohlcv.close().centi(), 1_150_000);
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert!(Arc::ptr_eq(&next, &collector.completed().unwrap()));
}

#[tokio::test]
async fn dropping_one_waiter_does_not_cancel_shared_collection_and_different_targets_do_not_join() {
    let (fake, collector, _) = noon().await;
    fake.set_quote_rows(vec![row(1)]);
    fake.delay("ka10095", Duration::from_millis(100));
    let task = tokio::spawn({ let collector = collector.clone(); async move { collector.collect(vec![code(1)], CollectionBasis::default()).await } });
    wait_calls(&fake, 1).await;
    task.abort();
    assert_eq!(collector.collect(vec![code(2)], CollectionBasis::default()).await.unwrap_err(), CollectionError::TargetsChanged);
    let batch = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap();
    assert_eq!(batch.missing_count(), 0);
    assert_eq!(calls(&fake), 1);
}

#[tokio::test]
async fn gate_global_stop_and_path_stop_keep_existing_kiwoom_error_contract() {
    for (message, stopped, gated) in [("[8003:인증 불확실]", false, true), ("[8050:인증 차단]", true, false), ("[9998:알 수 없음]", true, false)] {
        let (fake, collector, _) = noon().await;
        fake.script("ka10095", vec![failure(message)]);
        let error = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap_err();
        let CollectionError::Kiwoom(error) = error else { panic!("키움 오류") };
        assert_eq!(matches!(error, KiwoomError::Stopped(_)), stopped);
        assert_eq!(matches!(error, KiwoomError::Gated { .. }), gated);
        assert!(collector.completed().is_none());
        assert!(collector.collect(vec![code(1)], CollectionBasis::default()).await.is_err());
        assert_eq!(calls(&fake), 1);
    }
}

#[tokio::test]
async fn new_date_call_ends_old_flight_and_never_joins_yesterdays_response() {
    let (fake, collector, clock) = noon().await;
    let mut delayed = reply(vec![row(1)]);
    delayed.delay = Duration::from_millis(600);
    let mut next_day = row(1);
    next_day["dt"] = "20261113".into();
    fake.script("ka10095", vec![delayed, reply(vec![next_day])]);
    let old = tokio::spawn({ let collector = collector.clone(); async move { collector.collect(vec![code(1)], CollectionBasis::default()).await } });
    wait_calls(&fake, 1).await;
    clock.jump(86_400);
    let next = collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap();
    assert_eq!(old.await.unwrap().unwrap_err(), CollectionError::DateChanged);
    assert_eq!(next.target, day(13));
    assert!(next.stocks[&code(1)].result.is_ok());
    assert_eq!(calls(&fake), 2);
}

#[tokio::test]
async fn unexpected_continuation_never_publishes_an_incomplete_batch() {
    let (fake, collector, _) = noon().await;
    let mut partial = reply(vec![row(1)]);
    partial.body["_headers"] = json!({"cont-yn": "Y", "next-key": "unread-part"});
    fake.script("ka10095", vec![partial]);
    assert_eq!(collector.collect(vec![code(1)], CollectionBasis::default()).await.unwrap_err(), CollectionError::UnexpectedContinuation);
    assert!(collector.completed().is_none());
}

#[tokio::test]
async fn different_store_generations_and_update_epochs_cannot_share_a_flight() {
    let (fake, collector, _) = noon().await;
    fake.set_quote_rows(vec![row(1)]);
    fake.delay("ka10095", Duration::from_millis(200));
    let basis = CollectionBasis { generation: 7, update_epoch: 3 };
    let first = tokio::spawn({ let collector = collector.clone(); async move { collector.collect(vec![code(1)], basis).await } });
    wait_calls(&fake, 1).await;
    for changed in [CollectionBasis { generation: 8, ..basis }, CollectionBasis { update_epoch: 4, ..basis }] {
        assert_eq!(collector.collect(vec![code(1)], changed).await.unwrap_err(), CollectionError::BasisChanged);
    }
    let batch = first.await.unwrap().unwrap();
    assert_eq!(batch.basis, basis);
    assert_eq!(calls(&fake), 1);
}
