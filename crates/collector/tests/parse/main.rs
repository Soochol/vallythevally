mod real_items;

use collector::parse::{Item, ItemError, Member, Row, parse_frame};
use hoga_format::StreamKind;
use real_items::*;

fn frame(items: &[&str]) -> String {
    format!(r#"{{"trnm":"REAL","data":[{}]}}"#, items.join(","))
}

fn only_row(items: &[&str]) -> Row {
    let mut parsed = parse_frame(&frame(items)).unwrap();
    match parsed.remove(0).unwrap() {
        Item::Row(row) => row,
        other => panic!("행이 아닙니다: {other:?}"),
    }
}

fn item_with(real_type: &str, symbol: &str, values: &str) -> String {
    format!(r#"{{"values":{values},"type":"{real_type}","name":"x","item":"{symbol}"}}"#)
}

#[test]
fn book_item_gives_43_hand_checked_columns() {
    let row = only_row(&[REAL_0D_000660_NX]);
    assert_eq!(row.symbol, "000660_NX");
    assert_eq!(row.kind, StreamKind::Book);
    let expected: Vec<i64> = vec![
        71780,
        1842000, 1843000, 1844000, 1845000, 1846000, 1847000, 1848000, 1849000, 1850000, 1851000,
        1841000, 1840000, 1839000, 1838000, 1837000, 1836000, 1835000, 1834000, 1833000, 1832000,
        480, 5798, 3211, 2832, 1192, 1390, 1833, 2642, 5185, 497,
        3578, 3436, 1607, 1714, 1901, 1287, 2846, 1005, 1068, 1848,
        25060, 20290,
    ];
    assert_eq!(row.values.len(), 43);
    assert_eq!(row.values, expected);
}

#[test]
fn buy_and_sell_trades() {
    assert_eq!(only_row(&[REAL_0B_BUY]).values, vec![37675, 331000, 4, 1]);
    let sell = only_row(&[REAL_0B_SELL]);
    assert_eq!(sell.symbol, "000660");
    assert_eq!(sell.kind, StreamKind::Trades);
    assert_eq!(sell.values, vec![37676, 1850000, -58, 1]);
}

#[test]
fn program_item() {
    let row = only_row(&[REAL_0W]);
    assert_eq!(row.kind, StreamKind::Program);
    assert_eq!(row.values, vec![37676, 99486, 40329, 132815, 53934]);
}

#[test]
fn broker_item_gives_codes_quantities_and_members() {
    let row = only_row(&[REAL_0F]);
    assert_eq!(row.symbol, "207940");
    assert_eq!(row.kind, StreamKind::Broker);
    assert_eq!(
        row.values,
        vec![
            2, 50, 33, 3, 44,
            12, 35, 3, 43, 5,
            2155, 2122, 1202, 838, 830,
            2077, 1914, 1131, 866, 810,
        ]
    );
    let member = |code: &str, name: &str| Member { code: code.into(), name: name.into() };
    assert_eq!(
        row.members,
        vec![
            member("002", "신한투자증권"),
            member("050", "키움증권"),
            member("033", "JP모간서울"),
            member("003", "한국투자증권"),
            member("044", "메릴린치"),
            member("012", "NH투자증권"),
            member("035", "맥쿼리증권"),
            member("003", "한국투자증권"),
            member("043", "유비에스증권"),
            member("005", "미래에셋"),
        ]
    );
}

#[test]
fn zero_quantity_trade_is_not_a_trade() {
    let item = item_with("0B", "005930", r#"{"20":"090000","10":"+70000","15":"0","9081":"KRX"}"#);
    let parsed = parse_frame(&frame(&[&item])).unwrap();
    assert_eq!(parsed, vec![Ok(Item::NotTrade { symbol: "005930".into() })]);
}

#[test]
fn other_real_types_are_unsupported_not_errors() {
    let item = item_with("0E", "005930", r#"{"21":"153000"}"#);
    let parsed = parse_frame(&frame(&[&item])).unwrap();
    assert_eq!(parsed, vec![Ok(Item::Unsupported { real_type: "0E".into() })]);
}

#[test]
fn bad_items_fail_alone() {
    let no_time = item_with("0B", "005930", r#"{"10":"+70000","15":"+1"}"#);
    let bad_price = item_with("0B", "005930", r#"{"20":"090000","10":"+70x00","15":"+1"}"#);
    let bad_clock = item_with("0w", "005930", r#"{"20":"096100","202":"1"}"#);
    let parsed = parse_frame(&frame(&[&no_time, REAL_0W, &bad_price, &bad_clock])).unwrap();
    assert_eq!(parsed.len(), 4);
    assert!(matches!(&parsed[0], Err(ItemError { index: 0, .. })));
    assert!(matches!(&parsed[1], Ok(Item::Row(_))));
    assert!(matches!(&parsed[2], Err(ItemError { index: 2, symbol: Some(symbol), .. }) if symbol == "005930"));
    assert!(matches!(&parsed[3], Err(ItemError { index: 3, .. })));
}

#[test]
fn empty_and_missing_values_are_zero() {
    let item = item_with("0D", "005930_AL", r#"{"21":"090000","41":"","61":" "}"#);
    let row = only_row(&[&item]);
    assert_eq!(row.values[0], 32400);
    assert!(row.values[1..].iter().all(|value| *value == 0));
}

#[test]
fn non_real_frames_have_no_items() {
    for text in [
        r#"{"trnm":"LOGIN","return_code":0,"return_msg":"","sor_yn":"Y"}"#,
        r#"{"trnm":"REG","return_code":0,"return_msg":""}"#,
    ] {
        assert_eq!(parse_frame(text).unwrap(), vec![]);
    }
}

#[test]
fn broken_json_is_a_frame_error() {
    assert!(parse_frame("not json").is_err());
}
