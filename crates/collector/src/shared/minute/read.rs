use std::borrow::Cow;

use serde::Deserialize;
use server::shared_data::MinuteInstrument;

use crate::shared::live_tap::{seconds_of_day, unsigned_quantity};

const STOCK_TYPE: &str = "0B";
const INDEX_TYPE: &str = "0J";
const COMBINED_SUFFIX: &str = "_AL";

pub fn mentions_minute_type(text: &str) -> bool {
    text.contains("\"0B\"") || text.contains("\"0J\"")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exchange {
    Krx,
    Nxt,
    Unstated,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawTick<'a> {
    pub symbol: &'a str,
    pub instrument: MinuteInstrument,
    pub exchange: Exchange,
    pub sec: u32,
    pub price: f64,
    pub volume: i64,
    pub cumulative_value: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reading {
    pub ticks: u64,
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
    volume: Option<Cow<'a, str>>,
    #[serde(rename = "14", borrow)]
    cumulative_value: Option<Cow<'a, str>>,
    #[serde(rename = "9081", borrow)]
    exchange: Option<Cow<'a, str>>,
}

pub fn read_ticks(text: &str, mut sink: impl FnMut(RawTick<'_>)) -> Result<Reading, serde_json::Error> {
    let frame: Frame<'_> = serde_json::from_str(text)?;
    let mut reading = Reading::default();
    for entry in &frame.data {
        let instrument = match entry.kind.as_ref() {
            STOCK_TYPE => MinuteInstrument::Stock,
            INDEX_TYPE => MinuteInstrument::Index,
            _ => continue,
        };
        match tick_of(entry, instrument) {
            Some(tick) => {
                reading.ticks += 1;
                sink(tick);
            }
            None => reading.skipped += 1,
        }
    }
    Ok(reading)
}

pub(crate) fn tick_from_fields<'a>(
    item: &'a str,
    instrument: MinuteInstrument,
    time: Option<&str>,
    price: Option<&str>,
    volume: Option<&str>,
    cumulative_value: Option<&str>,
    exchange: Option<&str>,
) -> Option<RawTick<'a>> {
    let symbol = item.strip_suffix(COMBINED_SUFFIX).unwrap_or(item);
    if symbol.is_empty() {
        return None;
    }
    let sec = seconds_of_day(time?)?;
    let price = price_of(price?)?;
    let volume = unsigned_quantity(volume.unwrap_or_default())?;
    let cumulative_value = cumulative_value.and_then(unsigned_quantity);
    let exchange = match (instrument, exchange) {
        (MinuteInstrument::Stock, Some("KRX")) => Exchange::Krx,
        (MinuteInstrument::Stock, Some("NXT")) => Exchange::Nxt,
        _ => Exchange::Unstated,
    };
    let is_trade = instrument == MinuteInstrument::Index || volume > 0;
    is_trade.then_some(RawTick { symbol, instrument, exchange, sec, price, volume, cumulative_value })
}

fn tick_of<'a>(entry: &'a Entry<'_>, instrument: MinuteInstrument) -> Option<RawTick<'a>> {
    let values = &entry.values;
    tick_from_fields(
        entry.item.as_ref(),
        instrument,
        values.time.as_deref(),
        values.price.as_deref(),
        values.volume.as_deref(),
        values.cumulative_value.as_deref(),
        values.exchange.as_deref(),
    )
}

fn price_of(text: &str) -> Option<f64> {
    let magnitude = text.trim().strip_prefix(['+', '-']).unwrap_or(text.trim());
    let price = magnitude.parse::<f64>().ok()?;
    (price.is_finite() && price > 0.0).then_some(price)
}

#[cfg(test)]
mod tests {
    use super::*;

    type Seen = (String, MinuteInstrument, Exchange, u32, f64, i64, Option<i64>);

    fn ticks_of(text: &str) -> (Vec<Seen>, Reading) {
        let mut seen = Vec::new();
        let reading = read_ticks(text, |tick| seen.push((tick.symbol.to_owned(), tick.instrument, tick.exchange, tick.sec, tick.price, tick.volume, tick.cumulative_value))).unwrap();
        (seen, reading)
    }

    #[test]
    fn reads_a_stock_trade_with_its_exchange_and_drops_the_signs() {
        let frame = r#"{"trnm":"REAL","data":[{"type":"0B","item":"005930_AL","values":{"20":"090001","10":"-71000","15":"-12","9081":"NXT"}}]}"#;
        let (ticks, reading) = ticks_of(frame);
        assert_eq!(ticks, [("005930".into(), MinuteInstrument::Stock, Exchange::Nxt, 32401, 71000.0, 12, None)]);
        assert_eq!(reading, Reading { ticks: 1, skipped: 0 });
    }

    #[test]
    fn reads_an_index_tick_with_its_cumulative_value() {
        let frame = r#"{"trnm":"REAL","data":[{"type":"0J","item":"001","values":{"20":"153000","10":"+2650.35","15":"0","14":"1234567"}}]}"#;
        let (ticks, _) = ticks_of(frame);
        assert_eq!(ticks, [("001".into(), MinuteInstrument::Index, Exchange::Unstated, 55800, 2650.35, 0, Some(1_234_567))]);
    }

    #[test]
    fn skips_what_is_not_a_trade_or_cannot_be_read() {
        let frame = r#"{"trnm":"REAL","data":[
            {"type":"0B","item":"000001_AL","values":{"20":"090001","10":"100","15":"0"}},
            {"type":"0B","item":"000002_AL","values":{"20":"09","10":"100","15":"1"}},
            {"type":"0B","item":"000003_AL","values":{"20":"090001","10":"x","15":"1"}},
            {"type":"0B","item":"000004_AL","values":{"10":"100","15":"1"}},
            {"type":"0D","item":"000005_AL","values":{"21":"090001"}},
            {"type":"0B","item":"000006_AL","values":{"20":"090002","10":"100","15":"3"}}]}"#;
        let (ticks, reading) = ticks_of(frame);
        assert_eq!(ticks.len(), 1);
        assert_eq!(ticks[0].0, "000006");
        assert_eq!(reading, Reading { ticks: 1, skipped: 4 });
    }

    #[test]
    fn an_unreadable_frame_is_an_error_and_other_frames_are_empty() {
        assert!(read_ticks("not json", |_| {}).is_err());
        assert_eq!(read_ticks(r#"{"trnm":"PING"}"#, |_| panic!("no tick")).unwrap(), Reading::default());
    }

    #[test]
    fn the_cheap_check_passes_only_trade_and_index_frames() {
        assert!(mentions_minute_type(r#"{"data":[{"type":"0B"}]}"#));
        assert!(mentions_minute_type(r#"{"data":[{"type":"0J"}]}"#));
        assert!(!mentions_minute_type(r#"{"data":[{"type":"0D"}]}"#));
    }
}
