use std::borrow::Cow;
use std::fmt;

use domain::{BookSideLevel, StockCode};
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

use crate::shared::live_tap::unsigned_quantity;

const BOOK_DEPTH: usize = 10;
const QUOTE_TYPE: &str = "0D";
const TRADE_TYPE: &str = "0B";
const COMBINED_SUFFIX: &str = "_AL";

pub fn mentions_micro_type(text: &str) -> bool {
    let bytes = text.as_bytes();
    memmem_4(bytes, b"\"0D\"") || memmem_4(bytes, b"\"0B\"")
}

#[inline]
fn memmem_4(haystack: &[u8], needle: &[u8; 4]) -> bool {
    haystack.windows(4).any(|window| window == needle)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reading {
    pub books: u64,
    pub trades: u64,
    pub skipped: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicroInput<'a> {
    Book { code: &'a str, asks: &'a [BookSideLevel], bids: &'a [BookSideLevel] },
    Trade { code: &'a str, price_won: u64, signed_qty: i64 },
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
    values: MicroValues,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct BorrowedStr<'a>(#[serde(borrow)] Cow<'a, str>);

#[derive(Default)]
struct MicroValues {
    asks: [BookSideLevel; BOOK_DEPTH],
    bids: [BookSideLevel; BOOK_DEPTH],
    trade_price: Option<u64>,
    trade_qty: Option<i64>,
}

#[derive(Clone, Copy)]
enum QuoteFid {
    AskPrice(usize),
    BidPrice(usize),
    AskQty(usize),
    BidQty(usize),
}

#[inline]
fn classify_quote_fid_bytes(key: &[u8]) -> Option<QuoteFid> {
    if key.len() != 2 || !key[0].is_ascii_digit() || !key[1].is_ascii_digit() {
        return None;
    }
    let fid = (key[0] - b'0') * 10 + (key[1] - b'0');
    match fid {
        41..=50 => Some(QuoteFid::AskPrice(usize::from(fid - 41))),
        51..=60 => Some(QuoteFid::BidPrice(usize::from(fid - 51))),
        61..=70 => Some(QuoteFid::AskQty(usize::from(fid - 61))),
        71..=80 => Some(QuoteFid::BidQty(usize::from(fid - 71))),
        _ => None,
    }
}

#[inline]
fn parse_u64_ascii(bytes: &[u8]) -> Option<u64> {
    let mut start = 0;
    let mut end = bytes.len();
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let slice = &bytes[start..end];
    if slice.is_empty() {
        return Some(0);
    }
    let digits = match slice[0] {
        b'+' | b'-' => &slice[1..],
        _ => slice,
    };
    if digits.is_empty() {
        return None;
    }
    let mut acc: u64 = 0;
    for &b in digits {
        if !b.is_ascii_digit() {
            return None;
        }
        acc = acc.checked_mul(10)?.checked_add(u64::from(b - b'0'))?;
    }
    Some(acc)
}

#[inline]
fn parse_signed_i64_ascii(bytes: &[u8]) -> Option<i64> {
    let mut start = 0;
    let mut end = bytes.len();
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let slice = &bytes[start..end];
    if slice.is_empty() {
        return None;
    }
    let (neg, digits) = match slice[0] {
        b'-' => (true, &slice[1..]),
        b'+' => (false, &slice[1..]),
        _ => (false, slice),
    };
    if digits.is_empty() {
        return None;
    }
    let mut acc: i64 = 0;
    for &b in digits {
        if !b.is_ascii_digit() {
            return None;
        }
        acc = acc.checked_mul(10)?.checked_add(i64::from(b - b'0'))?;
    }
    let signed = if neg { acc.checked_neg()? } else { acc };
    (signed != 0).then_some(signed)
}

fn parse_signed_qty(text: &str) -> Option<i64> {
    parse_signed_i64_ascii(text.as_bytes())
}

fn parse_positive_price(text: &str) -> Option<u64> {
    let value = unsigned_quantity(text)? as u64;
    (value > 0).then_some(value)
}

impl<'de> Deserialize<'de> for MicroValues {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ValuesVisitor;

        impl<'de> Visitor<'de> for ValuesVisitor {
            type Value = MicroValues;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a map of Kiwoom 0D/0B fields")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<MicroValues, A::Error> {
                let mut asks = [BookSideLevel::default(); BOOK_DEPTH];
                let mut bids = [BookSideLevel::default(); BOOK_DEPTH];
                let mut trade_price = None;
                let mut trade_qty = None;
                while let Some(BorrowedStr(key)) = map.next_key::<BorrowedStr<'de>>()? {
                    match key.as_ref() {
                        "10" => {
                            if let Some(BorrowedStr(value)) = map.next_value::<Option<BorrowedStr<'de>>>()? {
                                trade_price = parse_positive_price(value.as_ref());
                            }
                        }
                        "15" => {
                            if let Some(BorrowedStr(value)) = map.next_value::<Option<BorrowedStr<'de>>>()? {
                                trade_qty = parse_signed_qty(value.as_ref());
                            }
                        }
                        other => {
                            if let Some(fid) = classify_quote_fid_bytes(other.as_bytes()) {
                                let parsed = map
                                    .next_value::<Option<BorrowedStr<'de>>>()?
                                    .and_then(|BorrowedStr(value)| unsigned_quantity(value.as_ref()))
                                    .map(|value| value.max(0) as u64)
                                    .unwrap_or(0);
                                match fid {
                                    QuoteFid::AskPrice(index) => asks[index].price_won = parsed,
                                    QuoteFid::BidPrice(index) => bids[index].price_won = parsed,
                                    QuoteFid::AskQty(index) => asks[index].qty = parsed,
                                    QuoteFid::BidQty(index) => bids[index].qty = parsed,
                                }
                            } else {
                                let _: IgnoredAny = map.next_value()?;
                            }
                        }
                    }
                }
                Ok(MicroValues { asks, bids, trade_price, trade_qty })
            }
        }

        deserializer.deserialize_map(ValuesVisitor)
    }
}

pub fn read_micro_frame(text: &str, mut sink: impl FnMut(MicroInput<'_>)) -> Result<Reading, serde_json::Error> {
    if !text.as_bytes().contains(&b'\\')
        && let Some(reading) = read_micro_fast(text, &mut sink)
    {
        return Ok(reading);
    }
    read_micro_serde(text, sink)
}

fn read_micro_serde(text: &str, mut sink: impl FnMut(MicroInput<'_>)) -> Result<Reading, serde_json::Error> {
    let frame: Frame<'_> = serde_json::from_str(text)?;
    let mut reading = Reading::default();
    for entry in &frame.data {
        let kind = entry.kind.as_ref();
        if kind != QUOTE_TYPE && kind != TRADE_TYPE {
            continue;
        }
        let Some(code) = entry.item.strip_suffix(COMBINED_SUFFIX).filter(|code| StockCode::parse(code).is_ok()) else {
            reading.skipped += 1;
            continue;
        };
        if kind == QUOTE_TYPE {
            reading.books += 1;
            sink(MicroInput::Book { code, asks: &entry.values.asks, bids: &entry.values.bids });
        } else {
            match (entry.values.trade_price, entry.values.trade_qty) {
                (Some(price_won), Some(signed_qty)) => {
                    reading.trades += 1;
                    sink(MicroInput::Trade { code, price_won, signed_qty });
                }
                _ => reading.skipped += 1,
            }
        }
    }
    Ok(reading)
}

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(text: &'a str) -> Self {
        Self { bytes: text.as_bytes(), pos: 0 }
    }

    #[inline]
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    #[inline]
    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    #[inline]
    fn expect_byte(&mut self, expected: u8) -> Option<()> {
        self.skip_ws();
        if self.bytes.get(self.pos) == Some(&expected) {
            self.pos += 1;
            Some(())
        } else {
            None
        }
    }

    #[inline]
    fn read_str(&mut self) -> Option<&'a [u8]> {
        self.expect_byte(b'"')?;
        let start = self.pos;
        while self.pos < self.bytes.len() {
            if self.bytes[self.pos] == b'"' {
                let slice = &self.bytes[start..self.pos];
                self.pos += 1;
                return Some(slice);
            }
            self.pos += 1;
        }
        None
    }

    fn skip_value(&mut self) -> Option<()> {
        match self.peek()? {
            b'"' => {
                self.read_str()?;
                Some(())
            }
            b'{' => {
                self.pos += 1;
                if self.peek()? == b'}' {
                    self.pos += 1;
                    return Some(());
                }
                loop {
                    self.read_str()?;
                    self.expect_byte(b':')?;
                    self.skip_value()?;
                    match self.peek()? {
                        b',' => self.pos += 1,
                        b'}' => {
                            self.pos += 1;
                            return Some(());
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.pos += 1;
                if self.peek()? == b']' {
                    self.pos += 1;
                    return Some(());
                }
                loop {
                    self.skip_value()?;
                    match self.peek()? {
                        b',' => self.pos += 1,
                        b']' => {
                            self.pos += 1;
                            return Some(());
                        }
                        _ => return None,
                    }
                }
            }
            _ => {
                while self.pos < self.bytes.len() {
                    let b = self.bytes[self.pos];
                    if matches!(b, b',' | b'}' | b']') || b.is_ascii_whitespace() {
                        return Some(());
                    }
                    self.pos += 1;
                }
                Some(())
            }
        }
    }
}

#[allow(clippy::large_enum_variant)]
enum BufferedInput<'a> {
    Book { code: &'a str, asks: [BookSideLevel; BOOK_DEPTH], bids: [BookSideLevel; BOOK_DEPTH] },
    Trade { code: &'a str, price_won: u64, signed_qty: i64 },
}

#[derive(Default)]
struct FastBuffer<'a> {
    first: Option<BufferedInput<'a>>,
    rest: Vec<BufferedInput<'a>>,
}

impl<'a> FastBuffer<'a> {
    #[inline]
    fn push(&mut self, item: BufferedInput<'a>) {
        if self.first.is_none() {
            self.first = Some(item);
        } else {
            self.rest.push(item);
        }
    }

    fn flush(self, sink: &mut impl FnMut(MicroInput<'_>)) {
        if let Some(first) = self.first {
            emit_buffered(&first, sink);
        }
        for item in &self.rest {
            emit_buffered(item, sink);
        }
    }
}

#[inline]
fn emit_buffered(item: &BufferedInput<'_>, sink: &mut impl FnMut(MicroInput<'_>)) {
    match item {
        BufferedInput::Book { code, asks, bids } => sink(MicroInput::Book { code, asks, bids }),
        BufferedInput::Trade { code, price_won, signed_qty } => sink(MicroInput::Trade {
            code,
            price_won: *price_won,
            signed_qty: *signed_qty,
        }),
    }
}

fn read_micro_fast(text: &str, sink: &mut impl FnMut(MicroInput<'_>)) -> Option<Reading> {
    let mut sc = Scanner::new(text);
    sc.expect_byte(b'{')?;
    let mut reading = Reading::default();
    let mut buffer = FastBuffer::default();
    if sc.peek()? == b'}' {
        sc.pos += 1;
        sc.skip_ws();
        return (sc.pos == sc.bytes.len()).then_some(reading);
    }
    loop {
        let key = sc.read_str()?;
        sc.expect_byte(b':')?;
        if key == b"data" {
            read_data_array(&mut sc, &mut reading, &mut buffer)?;
        } else {
            sc.skip_value()?;
        }
        match sc.peek()? {
            b',' => sc.pos += 1,
            b'}' => {
                sc.pos += 1;
                break;
            }
            _ => return None,
        }
    }
    sc.skip_ws();
    if sc.pos != sc.bytes.len() {
        return None;
    }
    buffer.flush(sink);
    Some(reading)
}

fn read_data_array<'a>(sc: &mut Scanner<'a>, reading: &mut Reading, buffer: &mut FastBuffer<'a>) -> Option<()> {
    sc.expect_byte(b'[')?;
    if sc.peek()? == b']' {
        sc.pos += 1;
        return Some(());
    }
    loop {
        read_entry(sc, reading, buffer)?;
        match sc.peek()? {
            b',' => sc.pos += 1,
            b']' => {
                sc.pos += 1;
                return Some(());
            }
            _ => return None,
        }
    }
}

fn read_entry<'a>(sc: &mut Scanner<'a>, reading: &mut Reading, buffer: &mut FastBuffer<'a>) -> Option<()> {
    sc.expect_byte(b'{')?;
    let mut kind: Option<&[u8]> = None;
    let mut item: Option<&'a [u8]> = None;
    let mut values_slice_start: Option<usize> = None;
    let mut asks = [BookSideLevel::default(); BOOK_DEPTH];
    let mut bids = [BookSideLevel::default(); BOOK_DEPTH];
    let mut trade_price: Option<u64> = None;
    let mut trade_qty: Option<i64> = None;
    let mut parsed_values = false;

    if sc.peek()? != b'}' {
        loop {
            let key = sc.read_str()?;
            sc.expect_byte(b':')?;
            match key {
                b"type" => kind = Some(sc.read_str()?),
                b"item" => item = Some(sc.read_str()?),
                b"values" => {
                    if kind == Some(b"0D") {
                        read_quote_values(sc, &mut asks, &mut bids)?;
                        parsed_values = true;
                    } else if kind == Some(b"0B") {
                        read_trade_values(sc, &mut trade_price, &mut trade_qty)?;
                        parsed_values = true;
                    } else {
                        values_slice_start = Some(sc.pos);
                        sc.skip_value()?;
                    }
                }
                _ => sc.skip_value()?,
            }
            match sc.peek()? {
                b',' => sc.pos += 1,
                b'}' => {
                    sc.pos += 1;
                    break;
                }
                _ => return None,
            }
        }
    } else {
        sc.pos += 1;
    }

    let kind = match kind {
        Some(k) if k == b"0D" || k == b"0B" => k,
        _ => return Some(()),
    };
    let item_bytes = item.unwrap_or(&[]);
    let Some(code_bytes) = item_bytes.strip_suffix(b"_AL") else {
        reading.skipped += 1;
        return Some(());
    };
    let Ok(code) = std::str::from_utf8(code_bytes) else {
        reading.skipped += 1;
        return Some(());
    };
    if StockCode::parse(code).is_err() {
        reading.skipped += 1;
        return Some(());
    }
    if !parsed_values
        && let Some(start) = values_slice_start
    {
        let mut sub = Scanner { bytes: sc.bytes, pos: start };
        if kind == b"0D" {
            read_quote_values(&mut sub, &mut asks, &mut bids)?;
        } else {
            read_trade_values(&mut sub, &mut trade_price, &mut trade_qty)?;
        }
    }
    if kind == b"0D" {
        reading.books += 1;
        buffer.push(BufferedInput::Book { code, asks, bids });
    } else {
        match (trade_price, trade_qty) {
            (Some(price_won), Some(signed_qty)) => {
                reading.trades += 1;
                buffer.push(BufferedInput::Trade { code, price_won, signed_qty });
            }
            _ => reading.skipped += 1,
        }
    }
    Some(())
}

fn read_quote_values(sc: &mut Scanner<'_>, asks: &mut [BookSideLevel; BOOK_DEPTH], bids: &mut [BookSideLevel; BOOK_DEPTH]) -> Option<()> {
    sc.expect_byte(b'{')?;
    if sc.peek()? == b'}' {
        sc.pos += 1;
        return Some(());
    }
    loop {
        let key = sc.read_str()?;
        sc.expect_byte(b':')?;
        if let Some(fid) = classify_quote_fid_bytes(key) {
            let parsed = if sc.peek()? == b'"' {
                parse_u64_ascii(sc.read_str()?).unwrap_or(0)
            } else {
                sc.skip_value()?;
                0
            };
            match fid {
                QuoteFid::AskPrice(index) => asks[index].price_won = parsed,
                QuoteFid::BidPrice(index) => bids[index].price_won = parsed,
                QuoteFid::AskQty(index) => asks[index].qty = parsed,
                QuoteFid::BidQty(index) => bids[index].qty = parsed,
            }
        } else {
            sc.skip_value()?;
        }
        match sc.peek()? {
            b',' => sc.pos += 1,
            b'}' => {
                sc.pos += 1;
                return Some(());
            }
            _ => return None,
        }
    }
}

fn read_trade_values(sc: &mut Scanner<'_>, price: &mut Option<u64>, qty: &mut Option<i64>) -> Option<()> {
    sc.expect_byte(b'{')?;
    if sc.peek()? == b'}' {
        sc.pos += 1;
        return Some(());
    }
    loop {
        let key = sc.read_str()?;
        sc.expect_byte(b':')?;
        match key {
            b"10" => {
                if sc.peek()? == b'"' {
                    *price = parse_u64_ascii(sc.read_str()?).filter(|&v| v > 0);
                } else {
                    sc.skip_value()?;
                }
            }
            b"15" => {
                if sc.peek()? == b'"' {
                    *qty = parse_signed_i64_ascii(sc.read_str()?);
                } else {
                    sc.skip_value()?;
                }
            }
            _ => sc.skip_value()?,
        }
        match sc.peek()? {
            b',' => sc.pos += 1,
            b'}' => {
                sc.pos += 1;
                return Some(());
            }
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_and_serde_paths_match_on_book_and_trade_frames() {
        let frame = r#"{"trnm":"REAL","data":[{"type":"0D","item":"005930_AL","values":{"21":"090500","41":"+70100","61":"5000","51":"+70000","71":"2000"}},{"type":"0B","item":"005930_AL","values":{"20":"090501","10":"+70100","15":"-350","9081":"KRX"}}]}"#;
        let mut fast_out = Vec::new();
        let fast_read = read_micro_frame(frame, |item| fast_out.push(format!("{item:?}"))).unwrap();
        let mut serde_out = Vec::new();
        let serde_read = read_micro_serde(frame, |item| serde_out.push(format!("{item:?}"))).unwrap();
        assert_eq!(fast_read, serde_read);
        assert_eq!(fast_out, serde_out);

        let escaped = r#"{"trnm":"REAL","data":[{"type":"0B","item":"005930_AL","values":{"10":"\u002b70100","15":"-12"}}]}"#;
        let mut esc_out = Vec::new();
        let esc_read = read_micro_frame(escaped, |item| esc_out.push(format!("{item:?}"))).unwrap();
        assert_eq!(esc_read.trades, 1);
        assert_eq!(esc_out.len(), 1);
    }

    #[test]
    fn fast_path_does_not_emit_earlier_entries_when_frame_is_malformed() {
        let broken_later_entry = r#"{"trnm":"REAL","data":[{"type":"0B","item":"005930_AL","values":{"20":"090501","10":"+70100","15":"+50"}},{"type":"0B","item":"005930_AL","values":{BROKEN}}]}"#;
        let mut emitted = 0usize;
        let result = read_micro_frame(broken_later_entry, |_| emitted += 1);
        assert!(result.is_err());
        assert_eq!(emitted, 0);

        let trailing_garbage = r#"{"trnm":"REAL","data":[{"type":"0B","item":"005930_AL","values":{"20":"090501","10":"+70100","15":"+50"}}]} trailing"#;
        let result2 = read_micro_frame(trailing_garbage, |_| emitted += 1);
        assert!(result2.is_err());
        assert_eq!(emitted, 0);
    }
}
