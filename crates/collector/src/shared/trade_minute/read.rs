use std::borrow::Cow;

use domain::StockCode;
use serde::Deserialize;

const TRADE_TYPE: &str = "0B";
const COMBINED_SUFFIX: &str = "_AL";

pub fn mentions_trade_type(text: &str) -> bool {
    text.contains("\"0B\"")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawTrade<'a> {
    pub code: &'a str,
    pub sec: u32,
    pub price: u64,
    pub quantity: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reading {
    pub trades: u64,
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
    #[serde(borrow, default)]
    values: Values<'a>,
}

#[derive(Deserialize, Default)]
struct Values<'a> {
    #[serde(rename = "20", borrow)]
    time: Option<Cow<'a, str>>,
    #[serde(rename = "10", borrow)]
    price: Option<Cow<'a, str>>,
    #[serde(rename = "15", borrow)]
    quantity: Option<Cow<'a, str>>,
}

pub fn read_trades(text: &str, mut sink: impl FnMut(RawTrade<'_>)) -> Result<Reading, serde_json::Error> {
    let frame: Frame<'_> = serde_json::from_str(text)?;
    let mut reading = Reading::default();
    for entry in &frame.data {
        if entry.kind.as_ref() != TRADE_TYPE {
            continue;
        }
        match trade_of(entry) {
            Some(trade) => {
                reading.trades += 1;
                sink(trade);
            }
            None => reading.skipped += 1,
        }
    }
    Ok(reading)
}

fn trade_of<'a>(entry: &'a Entry<'_>) -> Option<RawTrade<'a>> {
    let code = entry.item.strip_suffix(COMBINED_SUFFIX)?;
    if StockCode::parse(code).is_err() {
        return None;
    }
    let sec = seconds_of_day(entry.values.time.as_deref()?)?;
    let price = price_of(entry.values.price.as_deref()?)?;
    let quantity = quantity_of(entry.values.quantity.as_deref()?)?;
    Some(RawTrade { code, sec, price, quantity })
}

fn seconds_of_day(text: &str) -> Option<u32> {
    if text.len() != 6 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let part = |range: std::ops::Range<usize>| text[range].parse::<u32>().ok();
    let (hour, minute, second) = (part(0..2)?, part(2..4)?, part(4..6)?);
    (hour < 24 && minute < 60 && second < 60).then_some(hour * 3600 + minute * 60 + second)
}

fn price_of(text: &str) -> Option<u64> {
    let trimmed = text.trim();
    let magnitude = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if magnitude.is_empty() || !magnitude.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let price = magnitude.parse::<u64>().ok()?;
    (price > 0).then_some(price)
}

fn quantity_of(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let quantity = trimmed.parse::<i64>().ok()?;
    (quantity != 0).then_some(quantity)
}
