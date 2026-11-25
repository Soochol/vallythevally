use std::borrow::Cow;
use std::fmt;

use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use server::shared_data::{BOOK_DEPTH, BookLevel, BookRow};

use crate::shared::live_tap::{seconds_of_day, unsigned_quantity};

const QUOTE_TYPE: &str = "0D";
const COMBINED_SUFFIX: &str = "_AL";

pub fn mentions_quote_type(text: &str) -> bool {
    text.contains("\"0D\"")
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reading {
    pub books: u64,
    pub skipped: u64,
}

#[derive(Deserialize)]
struct Frame<'a> {
    #[serde(borrow, default)]
    data: Vec<Entry<'a>>,
}

#[derive(Deserialize)]
struct Entry<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Cow<'a, str>,
    #[serde(borrow, default)]
    item: Cow<'a, str>,
    #[serde(default)]
    values: BookValues,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct BorrowedStr<'a>(#[serde(borrow)] Cow<'a, str>);

#[derive(Default)]
struct BookValues {
    sec: Option<u32>,
    asks: [BookLevel; BOOK_DEPTH],
    bids: [BookLevel; BOOK_DEPTH],
}

#[derive(Clone, Copy)]
enum LevelField {
    Price,
    Combined,
    Krx,
    Nxt,
}

fn classify_fid(key: &str) -> Option<(bool, usize, LevelField)> {
    let fid = match key.len() {
        2 | 4 if key.bytes().all(|byte| byte.is_ascii_digit()) => key.parse::<u16>().ok()?,
        _ => return None,
    };
    match fid {
        41..=50 => Some((true, usize::from(fid - 41), LevelField::Price)),
        51..=60 => Some((false, usize::from(fid - 51), LevelField::Price)),
        61..=70 => Some((true, usize::from(fid - 61), LevelField::Combined)),
        71..=80 => Some((false, usize::from(fid - 71), LevelField::Combined)),
        6044..=6053 => Some((true, usize::from(fid - 6044), LevelField::Krx)),
        6054..=6063 => Some((false, usize::from(fid - 6054), LevelField::Krx)),
        6066..=6075 => Some((true, usize::from(fid - 6066), LevelField::Nxt)),
        6076..=6085 => Some((false, usize::from(fid - 6076), LevelField::Nxt)),
        _ => None,
    }
}

impl<'de> Deserialize<'de> for BookValues {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ValuesVisitor;

        impl<'de> Visitor<'de> for ValuesVisitor {
            type Value = BookValues;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of Kiwoom quote fields")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<BookValues, A::Error> {
                let mut sec = None;
                let mut asks = [BookLevel::default(); BOOK_DEPTH];
                let mut bids = [BookLevel::default(); BOOK_DEPTH];
                while let Some(BorrowedStr(key)) = map.next_key::<BorrowedStr<'de>>()? {
                    if key.as_ref() == "21" {
                        if let Some(BorrowedStr(value)) = map.next_value::<Option<BorrowedStr<'de>>>()? {
                            sec = seconds_of_day(value.as_ref());
                        }
                    } else if let Some((is_ask, index, field)) = classify_fid(key.as_ref()) {
                        let parsed = map
                            .next_value::<Option<BorrowedStr<'de>>>()?
                            .and_then(|BorrowedStr(value)| unsigned_quantity(value.as_ref()))
                            .unwrap_or(0);
                        let level = if is_ask { &mut asks[index] } else { &mut bids[index] };
                        match field {
                            LevelField::Price => level.price = parsed,
                            LevelField::Combined => level.combined = parsed,
                            LevelField::Krx => level.krx = parsed,
                            LevelField::Nxt => level.nxt = parsed,
                        }
                    } else {
                        let _: IgnoredAny = map.next_value()?;
                    }
                }
                Ok(BookValues { sec, asks, bids })
            }
        }

        deserializer.deserialize_map(ValuesVisitor)
    }
}

pub fn read_books(text: &str, mut sink: impl FnMut(&str, &BookRow)) -> Result<Reading, serde_json::Error> {
    let frame: Frame<'_> = serde_json::from_str(text)?;
    let mut reading = Reading::default();
    for entry in &frame.data {
        if entry.kind.as_ref() != QUOTE_TYPE {
            continue;
        }
        match book_of(entry) {
            Some((code, row)) => {
                reading.books += 1;
                sink(code, &row);
            }
            None => reading.skipped += 1,
        }
    }
    Ok(reading)
}

fn book_of<'a>(entry: &'a Entry<'_>) -> Option<(&'a str, BookRow)> {
    let code = entry.item.strip_suffix(COMBINED_SUFFIX)?;
    domain::StockCode::parse(code).ok()?;
    let sec = entry.values.sec?;
    Some((code, BookRow { sec, asks: entry.values.asks, bids: entry.values.bids }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cheap_check_passes_only_order_book_frames() {
        assert!(mentions_quote_type(r#"{"data":[{"type":"0D"}]}"#));
        assert!(!mentions_quote_type(r#"{"data":[{"type":"0B"}]}"#));
        assert!(!mentions_quote_type(r#"{"data":[{"type":"0J"}]}"#));
    }

    #[test]
    fn rejects_empty_code_with_combined_suffix_and_invalid_clock() {
        let frame = r#"{"trnm":"REAL","data":[
            {"type":"0D","item":"_AL","values":{"21":"090000"}},
            {"type":"0D","item":"005930_AL","values":{"21":"240000"}},
            {"type":"0D","item":"005930_AL","values":{"21":"096000"}}
        ]}"#;
        let reading = read_books(frame, |_, _| panic!("유효한 호가가 없다")).unwrap();
        assert_eq!(reading, Reading { books: 0, skipped: 3 });
    }

    #[test]
    fn borrows_unescaped_strings_and_still_reads_escaped_values() {
        let borrowed: BorrowedStr<'_> = serde_json::from_str(r#""+10100""#).unwrap();
        assert!(matches!(borrowed.0, Cow::Borrowed("+10100")));
        let escaped: BorrowedStr<'_> = serde_json::from_str(r#""\u002b10100""#).unwrap();
        assert!(matches!(escaped.0, Cow::Owned(ref text) if text == "+10100"));

        let frame = r#"{"trnm":"REAL","data":[{"type":"0D","item":"005930_AL","values":{"21":"\u003090159","41":"\u002b10100","61":"12"}}]}"#;
        let mut seen = Vec::new();
        let reading = read_books(frame, |code, row| seen.push((code.to_owned(), *row))).unwrap();
        assert_eq!(reading, Reading { books: 1, skipped: 0 });
        assert_eq!(seen[0].0, "005930");
        assert_eq!(seen[0].1.sec, 9 * 3600 + 60 + 59);
        assert_eq!(seen[0].1.asks[0].price, 10_100);
        assert_eq!(seen[0].1.asks[0].combined, 12);
    }
}
