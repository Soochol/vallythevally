use std::collections::BTreeSet;

use domain::{Price, Symbol, TimeOfDay, Volume};
use serde_json::{Value, json};
use server::kiwoom::wire::{RealItem, RealType, Registrations, WsFrame, parse_ws_frame, reg_message, remove_message};
use server::market_source::stream::ExpectedQuote;

fn real_items(entries: Value) -> Vec<RealItem> {
    let text = json!({"trnm": "REAL", "data": entries}).to_string();
    match parse_ws_frame(&text).unwrap() {
        WsFrame::Real(items) => items.into_iter().map(Result::unwrap).collect(),
        other => panic!("REAL이 아니다: {other:?}"),
    }
}

fn samsung() -> Symbol {
    Symbol::parse("005930").unwrap()
}

#[test]
fn real_0h_reads_abs_price_signed_change_and_cumulative_expected_qty() {
    let items = real_items(json!([
        {"type": "0H", "name": "주식예상체결", "item": "005930_AL", "values": {"20": "085500", "10": "+194900", "11": "+17400", "12": "+9.80", "15": "+20", "13": "355581", "25": "2"}},
        {"type": "0H", "name": "주식예상체결", "item": "006730_AL", "values": {"20": "085500", "10": "-8910", "11": "-90", "12": "-1.00", "15": "-13", "13": "7559", "25": "5"}}
    ]));
    let at = TimeOfDay::hms(8, 55, 0).unwrap();
    assert_eq!(
        items,
        vec![
            RealItem::Expected(ExpectedQuote { symbol: samsung(), hhmmss: at, price: Price::from_centi(19_490_000).unwrap(), change_centi: 1_740_000, expected_qty: Volume(355_581) }),
            RealItem::Expected(ExpectedQuote { symbol: Symbol::parse("006730").unwrap(), hhmmss: at, price: Price::from_centi(891_000).unwrap(), change_centi: -9_000, expected_qty: Volume(7_559) }),
        ]
    );
}

#[test]
fn real_0h_with_zero_price_is_not_an_expected_quote() {
    let items = real_items(json!([
        {"type": "0H", "name": "주식예상체결", "item": "005930_AL", "values": {"20": "085000", "10": "-0", "11": "0", "12": "0.00", "15": "0", "13": "0", "25": "3"}}
    ]));
    assert!(items.iter().all(|item| !matches!(item, RealItem::Expected(_))), "{items:?}");
}

#[test]
fn expected_registration_and_removal_go_out_as_0h_combined_codes() {
    let registrations: Registrations = BTreeSet::from([(RealType::Expected, samsung())]);
    let reg: Value = serde_json::from_str(&reg_message(&registrations)).unwrap();
    assert_eq!(reg["trnm"], "REG");
    assert_eq!(reg["data"], json!([{"item": ["005930_AL"], "type": ["0H"]}]));
    let remove: Value = serde_json::from_str(&remove_message(RealType::Expected, &BTreeSet::from([samsung()]))).unwrap();
    assert_eq!(remove["trnm"], "REMOVE");
    assert_eq!(remove["data"], json!([{"item": ["005930_AL"], "type": ["0H"]}]));
}
