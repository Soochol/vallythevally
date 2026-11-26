use domain::{KstDate, KstTime, Price, StockCode, TimeOfDay};
use serde_json::{Value, json};
use server::api::{self, ServerMessage, SymbolCode};
use server::clock::kst;
use server::kiwoom::wire::{RealItem, WsFrame, parse_ws_frame};
use server::market::outbox::Outbox;
use server::market::vi::{BaseAfterRelease, ViBoard};
use server::market_source::vi::{ViAlert, ViDirection, ViMarket};

const SAMSUNG: &str = "005930";

fn code() -> StockCode {
    StockCode::parse(SAMSUNG).unwrap()
}

fn at(h: u32, m: u32, s: u32) -> KstTime {
    kst(KstDate::new(2026, 11, 24).unwrap(), h, m, s)
}

fn time(h: u32, m: u32, s: u32) -> TimeOfDay {
    TimeOfDay::hms(h, m, s).unwrap()
}

fn alert(market: ViMarket, triggered: TimeOfDay, released: Option<TimeOfDay>) -> ViAlert {
    ViAlert { code: code(), market, direction: Some(ViDirection::Up), trigger_price: Price::from_centi(88_100_000), static_base: Price::from_centi(80_000_000), triggered, released }
}

fn active(board: &ViBoard, market: ViMarket) -> Option<bool> {
    board.state(code(), market).map(|state| state.active)
}

fn vi_items(entries: Value) -> Vec<RealItem> {
    match parse_ws_frame(&json!({"trnm": "REAL", "data": entries}).to_string()).unwrap() {
        WsFrame::Real(items) => items.into_iter().map(Result::unwrap).collect(),
        other => panic!("REAL이 아니다: {other:?}"),
    }
}

fn vi_frame(item: &str) -> Value {
    json!({"type": "1h", "item": item, "values": {"9001": item, "9068": "1", "9069": "1", "9075": "1", "1221": "881000", "1223": "093000", "1224": "000000", "1236": "800000", "1237": "0"}})
}

#[test]
fn a_suffixed_1h_line_belongs_to_nxt_and_the_combined_line_is_ignored() {
    let items = vi_items(json!([vi_frame("005930"), vi_frame("005930_NX"), vi_frame("005930_AL")]));
    let expected = |market| RealItem::Vi(alert(market, time(9, 30, 0), None));
    assert_eq!(items, [expected(ViMarket::Krx), expected(ViMarket::Nxt), RealItem::IgnoredVi]);
}

#[test]
fn the_two_markets_of_one_symbol_turn_on_and_off_separately() {
    let mut board = ViBoard::default();
    assert!(board.apply_alert(&alert(ViMarket::Krx, time(9, 30, 0), None), at(9, 30, 0), BaseAfterRelease::FirstKrxTrade));
    assert!(board.apply_alert(&alert(ViMarket::Nxt, time(9, 30, 10), None), at(9, 30, 10), BaseAfterRelease::Unknown));
    assert_eq!((active(&board, ViMarket::Krx), active(&board, ViMarket::Nxt)), (Some(true), Some(true)));
    assert!(board.apply_alert(&alert(ViMarket::Nxt, time(9, 30, 10), Some(time(9, 32, 10))), at(9, 32, 10), BaseAfterRelease::Unknown));
    assert_eq!((active(&board, ViMarket::Krx), active(&board, ViMarket::Nxt)), (Some(true), Some(false)));
    assert_eq!(board.states().len(), 2);
    assert!(!board.awaits_base(), "NXT 해제는 KRX 체결을 기다리지 않는다");
}

#[test]
fn an_nxt_vi_without_a_release_turns_off_after_five_minutes_and_leaves_krx_on() {
    let mut board = ViBoard::default();
    assert!(board.apply_alert(&alert(ViMarket::Nxt, time(9, 30, 0), None), at(9, 30, 0), BaseAfterRelease::Unknown));
    assert!(board.apply_alert(&alert(ViMarket::Krx, time(9, 33, 0), None), at(9, 33, 0), BaseAfterRelease::FirstKrxTrade));
    assert_eq!(board.expire(at(9, 35, 0)), [(code(), ViMarket::Nxt)]);
    assert_eq!((active(&board, ViMarket::Krx), active(&board, ViMarket::Nxt)), (Some(true), Some(false)));
}

#[test]
fn nxt_vi_is_kept_from_eight_to_twenty_and_krx_vi_in_the_regular_and_after_markets() {
    for (market, triggered, kept) in [
        (ViMarket::Nxt, time(7, 59, 59), false),
        (ViMarket::Nxt, time(8, 0, 0), true),
        (ViMarket::Nxt, time(15, 30, 0), true),
        (ViMarket::Nxt, time(19, 59, 59), true),
        (ViMarket::Nxt, time(20, 0, 0), false),
        (ViMarket::Krx, time(8, 59, 59), false),
        (ViMarket::Krx, time(9, 0, 0), true),
        (ViMarket::Krx, time(15, 19, 59), true),
        (ViMarket::Krx, time(15, 20, 0), false),
        (ViMarket::Krx, time(15, 59, 59), false),
        (ViMarket::Krx, time(16, 0, 0), true),
        (ViMarket::Krx, time(19, 59, 59), true),
        (ViMarket::Krx, time(20, 0, 0), false),
    ] {
        let mut board = ViBoard::default();
        let now = KstTime::from_kst_civil(KstDate::new(2026, 11, 24).unwrap(), triggered);
        assert_eq!(board.apply_alert(&alert(market, triggered, None), now, BaseAfterRelease::Unknown), kept, "{market:?} {triggered:?}");
    }
}

#[test]
fn pending_updates_of_the_two_markets_do_not_overwrite_each_other() {
    let outbox = Outbox::new();
    let state = |market, active| api::ViState { symbol: SymbolCode(SAMSUNG.into()), market, active, direction: None, trigger_price: None, base: None, triggered_at: None, released_at: None };
    outbox.set_vi(state(api::ViMarket::Krx, true));
    outbox.set_vi(state(api::ViMarket::Nxt, true));
    outbox.set_vi(state(api::ViMarket::Krx, false));
    assert_eq!(
        outbox.take(true).messages,
        vec![ServerMessage::ViUpdate { state: state(api::ViMarket::Krx, false) }, ServerMessage::ViUpdate { state: state(api::ViMarket::Nxt, true) }]
    );
    assert_eq!(serde_json::to_value(state(api::ViMarket::Nxt, true)).unwrap()["market"], json!("nxt"));
}
