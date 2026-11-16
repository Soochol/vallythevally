use std::fmt;
use std::sync::OnceLock;

use hoga_format::StreamKind;
use serde_json::{Map, Value};

const REAL_FRAME: &str = "REAL";
const STREAM_KINDS: [StreamKind; 4] = [
    StreamKind::Book,
    StreamKind::Trades,
    StreamKind::Program,
    StreamKind::Broker,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub symbol: String,
    pub kind: StreamKind,
    pub values: Vec<i64>,
    pub members: Vec<Member>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Row(Row),
    NotTrade { symbol: String },
    Unsupported { real_type: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemError {
    pub index: usize,
    pub symbol: Option<String>,
    pub message: String,
}

impl fmt::Display for ItemError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.symbol {
            Some(symbol) => write!(formatter, "항목 {} ({symbol}): {}", self.index, self.message),
            None => write!(formatter, "항목 {}: {}", self.index, self.message),
        }
    }
}

impl std::error::Error for ItemError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameError(pub String);

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "프레임을 읽을 수 없습니다: {}", self.0)
    }
}

impl std::error::Error for FrameError {}

pub fn stream_kind_of_real_type(real_type: &str) -> Option<StreamKind> {
    match real_type {
        "0D" => Some(StreamKind::Book),
        "0B" => Some(StreamKind::Trades),
        "0w" => Some(StreamKind::Program),
        "0F" => Some(StreamKind::Broker),
        _ => None,
    }
}

pub fn parse_frame(text: &str) -> Result<Vec<Result<Item, ItemError>>, FrameError> {
    let frame: Value = serde_json::from_str(text).map_err(|error| FrameError(error.to_string()))?;
    if frame.get("trnm").and_then(Value::as_str) != Some(REAL_FRAME) {
        return Ok(Vec::new());
    }
    let entries = frame
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| FrameError("REAL 프레임에 data 배열이 없습니다".to_string()))?;
    Ok(entries
        .iter()
        .enumerate()
        .map(|(index, entry)| parse_item(entry).map_err(|failure| failure.at(index)))
        .collect())
}

struct ItemFailure {
    symbol: Option<String>,
    message: String,
}

impl ItemFailure {
    fn at(self, index: usize) -> ItemError {
        ItemError { index, symbol: self.symbol, message: self.message }
    }
}

fn parse_item(entry: &Value) -> Result<Item, ItemFailure> {
    let real_type = entry
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| failure(None, "type이 없습니다"))?;
    let Some(kind) = stream_kind_of_real_type(real_type) else {
        return Ok(Item::Unsupported { real_type: real_type.to_string() });
    };
    let symbol = entry
        .get("item")
        .and_then(Value::as_str)
        .filter(|symbol| !symbol.is_empty())
        .ok_or_else(|| failure(None, "item이 없습니다"))?
        .to_string();
    let values = entry
        .get("values")
        .and_then(Value::as_object)
        .ok_or_else(|| failure(Some(&symbol), "values가 없습니다"))?;
    read_values(kind, values)
        .map(|read| match read {
            ReadValues::NotTrade => Item::NotTrade { symbol: symbol.clone() },
            ReadValues::Row { values, members } => Item::Row(Row { symbol: symbol.clone(), kind, values, members }),
        })
        .map_err(|message| failure(Some(&symbol), &message))
}

fn failure(symbol: Option<&str>, message: &str) -> ItemFailure {
    ItemFailure { symbol: symbol.map(str::to_string), message: message.to_string() }
}

enum ReadValues {
    NotTrade,
    Row { values: Vec<i64>, members: Vec<Member> },
}

fn read_values(kind: StreamKind, values: &Map<String, Value>) -> Result<ReadValues, String> {
    if kind == StreamKind::Trades && read_fid(values, TRADE_QTY_FID, Reading::Signed)? == 0 {
        return Ok(ReadValues::NotTrade);
    }
    let row = column_plan(kind)
        .iter()
        .map(|column| read_fid(values, column.fid, column.reading))
        .collect::<Result<Vec<i64>, String>>()?;
    let members = if kind == StreamKind::Broker { read_members(values) } else { Vec::new() };
    Ok(ReadValues::Row { values: row, members })
}

const TRADE_QTY_FID: u16 = 15;
const SELL_NAME_BASE: u16 = 140;
const BUY_NAME_BASE: u16 = 150;
const SELL_CODE_BASE: u16 = 145;
const BUY_CODE_BASE: u16 = 155;
const MEMBER_LEVELS: u16 = 5;

fn read_members(values: &Map<String, Value>) -> Vec<Member> {
    let sells = (1..=MEMBER_LEVELS).map(|level| (SELL_CODE_BASE + level, SELL_NAME_BASE + level));
    let buys = (1..=MEMBER_LEVELS).map(|level| (BUY_CODE_BASE + level, BUY_NAME_BASE + level));
    sells
        .chain(buys)
        .filter_map(|(code_fid, name_fid)| {
            let code = text_of(values, code_fid);
            let name = text_of(values, name_fid);
            (!code.is_empty() && !name.is_empty()).then_some(Member { code, name })
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
enum Reading {
    Time,
    Price,
    Signed,
    Venue,
}

#[derive(Debug, Clone, Copy)]
struct PlannedColumn {
    fid: u16,
    reading: Reading,
}

fn column_plan(kind: StreamKind) -> &'static [PlannedColumn] {
    static PLANS: [OnceLock<Vec<PlannedColumn>>; 4] =
        [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let slot = STREAM_KINDS.iter().position(|candidate| *candidate == kind).expect("받는 흐름이 아니다");
    PLANS[slot].get_or_init(|| {
        kind.columns()
            .iter()
            .skip(1)
            .map(|spec| planned_column(kind, &spec.name))
            .collect()
    })
}

fn planned_column(kind: StreamKind, name: &str) -> PlannedColumn {
    let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
    let level: u16 = name[base.len()..].parse().unwrap_or(0);
    let (fid, reading) = match (kind, base) {
        (StreamKind::Book, "t_s") => (21, Reading::Time),
        (StreamKind::Book, "ask_px") => (40 + level, Reading::Price),
        (StreamKind::Book, "bid_px") => (50 + level, Reading::Price),
        (StreamKind::Book, "ask_qty") => (60 + level, Reading::Signed),
        (StreamKind::Book, "bid_qty") => (70 + level, Reading::Signed),
        (StreamKind::Book, "ask_total") => (121, Reading::Signed),
        (StreamKind::Book, "bid_total") => (125, Reading::Signed),
        (StreamKind::Trades, "t_s") => (20, Reading::Time),
        (StreamKind::Trades, "price") => (10, Reading::Price),
        (StreamKind::Trades, "qty") => (TRADE_QTY_FID, Reading::Signed),
        (StreamKind::Trades, "venue") => (9081, Reading::Venue),
        (StreamKind::Program, "t_s") => (20, Reading::Time),
        (StreamKind::Program, "sell_qty") => (202, Reading::Signed),
        (StreamKind::Program, "sell_amt") => (204, Reading::Signed),
        (StreamKind::Program, "buy_qty") => (206, Reading::Signed),
        (StreamKind::Program, "buy_amt") => (208, Reading::Signed),
        (StreamKind::Broker, "sell_code") => (SELL_CODE_BASE + level, Reading::Signed),
        (StreamKind::Broker, "buy_code") => (BUY_CODE_BASE + level, Reading::Signed),
        (StreamKind::Broker, "sell_qty") => (160 + level, Reading::Signed),
        (StreamKind::Broker, "buy_qty") => (170 + level, Reading::Signed),
        _ => panic!("hoga-format의 열 {name}에 키움 FID 규칙이 없다"),
    };
    PlannedColumn { fid, reading }
}

fn text_of(values: &Map<String, Value>, fid: u16) -> String {
    match values.get(&fid.to_string()) {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn read_fid(values: &Map<String, Value>, fid: u16, reading: Reading) -> Result<i64, String> {
    let text = text_of(values, fid);
    let parsed = match reading {
        Reading::Time => read_time(&text),
        Reading::Price => read_price(&text),
        Reading::Signed => read_signed(&text),
        Reading::Venue => Ok(match text.as_str() {
            "KRX" => 1,
            "NXT" => 2,
            _ => 0,
        }),
    };
    parsed.map_err(|reason| format!("FID {fid}: {reason}"))
}

fn read_time(text: &str) -> Result<i64, String> {
    if text.is_empty() {
        return Err("시각이 없습니다".to_string());
    }
    if text.len() != 6 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("HHmmss가 아닙니다: {text:?}"));
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<i64>().expect("숫자만 확인했다");
    let (hour, minute, second) = (number(0..2), number(2..4), number(4..6));
    if hour > 23 || minute > 59 || second > 59 {
        return Err(format!("시각 범위를 벗어났습니다: {text}"));
    }
    Ok(hour * 3600 + minute * 60 + second)
}

fn read_price(text: &str) -> Result<i64, String> {
    if text.is_empty() {
        return Ok(0);
    }
    let magnitude = text.strip_prefix(['+', '-']).unwrap_or(text).trim_start();
    parse_digits(magnitude, text)
}

fn read_signed(text: &str) -> Result<i64, String> {
    if text.is_empty() {
        return Ok(0);
    }
    match text.strip_prefix('-') {
        Some(magnitude) => parse_digits(magnitude, text).map(|value| -value),
        None => parse_digits(text.strip_prefix('+').unwrap_or(text), text),
    }
}

fn parse_digits(digits: &str, whole: &str) -> Result<i64, String> {
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("숫자가 아닙니다: {whole:?}"));
    }
    digits.parse().map_err(|_| format!("범위를 벗어났습니다: {whole:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_hoga_format_column_has_a_fid_rule() {
        for kind in STREAM_KINDS {
            assert_eq!(column_plan(kind).len(), kind.columns().len() - 1);
        }
    }

    #[test]
    fn reads_numbers() {
        assert_eq!(read_price(" 1842000"), Ok(1842000));
        assert_eq!(read_price("-1841000"), Ok(1841000));
        assert_eq!(read_price("+1843000"), Ok(1843000));
        assert_eq!(read_price(""), Ok(0));
        assert!(read_price("18x2000").is_err());
        assert!(read_price("-").is_err());
        assert_eq!(read_signed("+4"), Ok(4));
        assert_eq!(read_signed("-58"), Ok(-58));
        assert_eq!(read_signed("002"), Ok(2));
        assert!(read_signed("1.5").is_err());
    }

    #[test]
    fn reads_times() {
        assert_eq!(read_time("195620"), Ok(71780));
        assert_eq!(read_time("000000"), Ok(0));
        assert_eq!(read_time("235959"), Ok(86399));
        assert!(read_time("").is_err());
        assert!(read_time("240000").is_err());
        assert!(read_time("106000").is_err());
        assert!(read_time("10a000").is_err());
        assert!(read_time("9015").is_err());
    }
}
