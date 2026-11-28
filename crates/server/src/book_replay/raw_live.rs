use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};

use domain::{KstDate, StockCode};
use hoga_format::{Span, Stream, StreamKind};
use serde::Deserialize;
use serde_json::{Map, Value};
use zstd::stream::read::Decoder;

use crate::api;
use crate::clock::kst;
use crate::shared_data::live_quote_stock_keys;

use super::live;
use super::span::{SPAN_MINUTES, clamp_i32_range, ms_of_day, parse_hhmmss_i64};

const MS_PER_MINUTE: i64 = 60_000;
const RAW_SUFFIX: &str = ".jsonl.zst";

#[derive(Deserialize)]
struct PlanFile {
    #[serde(default)]
    keys: Vec<PlanKey>,
}

#[derive(Deserialize)]
struct PlanKey {
    name: String,
    #[serde(default)]
    stocks: Vec<String>,
}

#[derive(Deserialize)]
struct RawWireLine {
    recv_ms: i64,
    msg: Option<Value>,
}

pub(super) fn read_live_meta(
    data_dir: &Path,
    shared_dir: &Path,
    stock: StockCode,
    date: KstDate,
    date_str: &str,
) -> Result<api::BookReplayMeta, String> {
    let day = live::read_live_day(shared_dir, stock, date, date_str)?;
    let keys = candidate_keys(data_dir, shared_dir, date_str, stock.as_str());
    let raw_span_minutes = list_raw_span_minutes(data_dir, date_str, &keys);
    let resolution = if day.coverage == api::BookReplayCoverage::Collected && !raw_span_minutes.is_empty() {
        api::BookReplayResolution::Tick
    } else {
        api::BookReplayResolution::MinuteOnly
    };

    let mut book_by_min: BTreeMap<u32, &api::BookReplayBook> = BTreeMap::new();
    for book in &day.books {
        book_by_min.insert(book.minute, book);
    }
    let mut trades_by_min: BTreeMap<u32, Vec<(u64, i64)>> = BTreeMap::new();
    for &(minute, _sec, price, signed_qty) in &day.trades {
        trades_by_min.entry(minute).or_default().push((price, signed_qty));
    }

    let mut active_minutes: BTreeSet<u32> = BTreeSet::new();
    active_minutes.extend(book_by_min.keys().copied());
    active_minutes.extend(trades_by_min.keys().copied());

    let mut minutes = Vec::with_capacity(active_minutes.len());
    let mut cum_vol: u64 = 0;
    let mut cum_val: u64 = 0;
    let mut cum_buy_qty: u64 = 0;
    let mut cum_sell_qty: u64 = 0;
    let mut day_open: Option<u64> = None;
    let mut day_high: Option<u64> = None;
    let mut day_low: Option<u64> = None;

    for minute in active_minutes {
        let book = book_by_min.get(&minute).copied();
        let trades = trades_by_min.get(&minute);
        let mut open: Option<u64> = None;
        let mut high: Option<u64> = None;
        let mut low: Option<u64> = None;
        let mut close: Option<u64> = None;
        let mut vol: u64 = 0;
        let mut val: u64 = 0;
        let mut buy_qty: u64 = 0;
        let mut sell_qty: u64 = 0;

        if let Some(list) = trades {
            for &(price, signed_qty) in list {
                let qty = signed_qty.unsigned_abs();
                if open.is_none() {
                    open = Some(price);
                }
                high = Some(high.map_or(price, |prev| prev.max(price)));
                low = Some(low.map_or(price, |prev| prev.min(price)));
                close = Some(price);
                vol = vol.saturating_add(qty);
                val = val.saturating_add(price.saturating_mul(qty));
                if signed_qty > 0 {
                    buy_qty = buy_qty.saturating_add(qty);
                } else if signed_qty < 0 {
                    sell_qty = sell_qty.saturating_add(qty);
                }
            }
        }

        let single_price = book.is_some_and(|b| !b.asks.is_empty() && !b.bids.is_empty() && b.asks.len() <= 3 && b.bids.len() <= 3);

        minutes.push(api::BookReplayMinuteCheckpoint {
            minute,
            open,
            high,
            low,
            close,
            volume: vol,
            cum_vol,
            cum_val,
            cum_buy_qty,
            cum_sell_qty,
            day_open,
            day_high,
            day_low,
            total_ask: book.map(|b| b.total_ask),
            total_bid: book.map(|b| b.total_bid),
            program_net_qty: None,
            program_net_amt_million: None,
            single_price,
        });

        cum_vol = cum_vol.saturating_add(vol);
        cum_val = cum_val.saturating_add(val);
        cum_buy_qty = cum_buy_qty.saturating_add(buy_qty);
        cum_sell_qty = cum_sell_qty.saturating_add(sell_qty);
        if day_open.is_none() {
            day_open = open;
        }
        if let Some(h) = high {
            day_high = Some(day_high.map_or(h, |prev| prev.max(h)));
        }
        if let Some(l) = low {
            day_low = Some(day_low.map_or(l, |prev| prev.min(l)));
        }
    }

    let spans = raw_span_minutes
        .into_iter()
        .map(|start_minute| api::BookReplaySpanSummary {
            start_minute,
            book_rows: 1,
            trade_rows: 1,
            program_rows: 0,
        })
        .collect();

    Ok(api::BookReplayMeta {
        symbol: day.symbol,
        date: day.date,
        coverage: day.coverage,
        resolution,
        span_minutes: u32::from(SPAN_MINUTES),
        previous_close: day.previous_close,
        venue_scope: None,
        covered: day.covered,
        gaps_ms: Vec::new(),
        spans,
        minutes,
    })
}

pub(super) fn read_live_span(
    data_dir: &Path,
    shared_dir: &Path,
    date: KstDate,
    date_u32: u32,
    date_str: &str,
    stock_code: &str,
    start_minute: u16,
) -> Result<Option<Span>, String> {
    let keys = candidate_keys(data_dir, shared_dir, date_str, stock_code);
    let span_files = find_span_files(data_dir, date_str, &keys, start_minute);
    let prev_files = start_minute
        .checked_sub(SPAN_MINUTES)
        .map(|prev| find_span_files(data_dir, date_str, &keys, prev))
        .unwrap_or_default();

    if span_files.is_empty() && prev_files.is_empty() {
        return Ok(None);
    }

    let target_symbol = format!("{stock_code}_AL");
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let from_ms = day_start_ms + i64::from(start_minute) * MS_PER_MINUTE;
    let to_ms = from_ms + i64::from(SPAN_MINUTES) * MS_PER_MINUTE;

    let mut carry_book: Option<Vec<i64>> = None;
    let mut carry_program: Option<Vec<i64>> = None;
    for path in &prev_files {
        scan_raw_file(path, &target_symbol, day_start_ms, |kind, recv_ms, row| {
            if recv_ms >= from_ms {
                return;
            }
            match kind {
                StreamKind::Book => carry_book = Some(row),
                StreamKind::Program => carry_program = Some(row),
                _ => {}
            }
        });
    }

    let mut book_rows: Vec<Vec<i64>> = Vec::new();
    let mut trade_rows: Vec<Vec<i64>> = Vec::new();
    let mut program_rows: Vec<Vec<i64>> = Vec::new();
    if let Some(row) = carry_book {
        book_rows.push(row);
    }
    if let Some(row) = carry_program {
        program_rows.push(row);
    }

    for path in &span_files {
        scan_raw_file(path, &target_symbol, day_start_ms, |kind, recv_ms, row| {
            if recv_ms < from_ms || recv_ms >= to_ms {
                return;
            }
            match kind {
                StreamKind::Book => book_rows.push(row),
                StreamKind::Trades => trade_rows.push(row),
                StreamKind::Program => program_rows.push(row),
                _ => {}
            }
        });
    }

    let mut streams = Vec::new();
    if let Some(stream) = rows_to_stream(StreamKind::Book, &book_rows) {
        streams.push(stream);
    }
    if let Some(stream) = rows_to_stream(StreamKind::Trades, &trade_rows) {
        streams.push(stream);
    }
    if let Some(stream) = rows_to_stream(StreamKind::Program, &program_rows) {
        streams.push(stream);
    }

    Ok(Some(Span {
        date: date_u32,
        start_minute,
        length_minutes: SPAN_MINUTES,
        symbol: target_symbol,
        streams,
    }))
}

fn candidate_keys(data_dir: &Path, shared_dir: &Path, date_str: &str, stock_code: &str) -> Vec<String> {
    let mut keys: BTreeSet<String> = BTreeSet::new();
    let plan_path = data_dir.join("plan").join(format!("{date_str}.json"));
    if let Ok(bytes) = std::fs::read(&plan_path)
        && let Ok(plan) = serde_json::from_slice::<PlanFile>(&bytes)
    {
        for share in plan.keys {
            if share.stocks.iter().any(|s| s == stock_code) {
                keys.insert(share.name);
            }
        }
    }
    if let Ok(live_keys) = live_quote_stock_keys(shared_dir, date_str, stock_code) {
        for (name, _) in live_keys {
            keys.insert(name);
        }
    }
    keys.into_iter().collect()
}

fn list_raw_span_minutes(data_dir: &Path, date_str: &str, keys: &[String]) -> Vec<u32> {
    let mut minutes = BTreeSet::new();
    let raw_day = data_dir.join("raw").join(date_str);
    let folders: Vec<PathBuf> = if keys.is_empty() {
        vec![raw_day]
    } else {
        keys.iter().map(|key| raw_day.join(key)).collect()
    };
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            if let Some(start_min) = parse_raw_span_start_minute(&name) {
                minutes.insert(start_min);
            }
        }
    }
    minutes.into_iter().collect()
}

fn find_span_files(data_dir: &Path, date_str: &str, keys: &[String], start_minute: u16) -> Vec<PathBuf> {
    let prefix = format!("{:02}{:02}-", start_minute / 60, start_minute % 60);
    let raw_day = data_dir.join("raw").join(date_str);
    let folders: Vec<PathBuf> = if keys.is_empty() {
        vec![raw_day]
    } else {
        keys.iter().map(|key| raw_day.join(key)).collect()
    };
    let mut files = Vec::new();
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            if name.starts_with(&prefix) && name.ends_with(RAW_SUFFIX) {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    files
}

fn parse_raw_span_start_minute(file_name: &str) -> Option<u32> {
    if !file_name.ends_with(RAW_SUFFIX) {
        return None;
    }
    let bytes = file_name.as_bytes();
    if bytes.len() < 5 || bytes[4] != b'-' || !bytes[..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let hour = u32::from(bytes[0] - b'0') * 10 + u32::from(bytes[1] - b'0');
    let minute = u32::from(bytes[2] - b'0') * 10 + u32::from(bytes[3] - b'0');
    if hour >= 24 || minute >= 60 {
        return None;
    }
    let total = hour * 60 + minute;
    total.is_multiple_of(u32::from(SPAN_MINUTES)).then_some(total)
}

fn scan_raw_file(
    path: &Path,
    target_symbol: &str,
    day_start_ms: i64,
    mut on_row: impl FnMut(StreamKind, i64, Vec<i64>),
) {
    let Ok(file) = File::open(path) else { return };
    let Ok(decoder) = Decoder::new(file) else { return };
    let mut reader = BufReader::new(decoder);
    let needle = format!("\"{target_symbol}\"");
    let mut buf = Vec::with_capacity(4096);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(err) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(_) => break,
        }
        let Ok(line_str) = std::str::from_utf8(&buf) else { continue };
        if !line_str.contains(&needle) {
            continue;
        }
        let Ok(wire) = serde_json::from_str::<RawWireLine>(line_str) else { continue };
        let Some(msg) = wire.msg else { continue };
        if msg.get("trnm").and_then(Value::as_str) != Some("REAL") {
            continue;
        }
        let Some(entries) = msg.get("data").and_then(Value::as_array) else { continue };
        let rel_ms = ms_of_day(wire.recv_ms, day_start_ms);
        for entry in entries {
            if entry.get("item").and_then(Value::as_str) != Some(target_symbol) {
                continue;
            }
            let Some(real_type) = entry.get("type").and_then(Value::as_str) else { continue };
            let Some(values) = entry.get("values").and_then(Value::as_object) else { continue };
            match real_type {
                "0D" => {
                    if let Some(row) = parse_book_row(rel_ms, wire.recv_ms, day_start_ms, values) {
                        on_row(StreamKind::Book, wire.recv_ms, row);
                    }
                }
                "0B" => {
                    if let Some(row) = parse_trade_row(rel_ms, wire.recv_ms, day_start_ms, values) {
                        on_row(StreamKind::Trades, wire.recv_ms, row);
                    }
                }
                "0w" => {
                    if let Some(row) = parse_program_row(rel_ms, wire.recv_ms, day_start_ms, values) {
                        on_row(StreamKind::Program, wire.recv_ms, row);
                    }
                }
                _ => {}
            }
        }
    }
}

fn fid_text<'a>(values: &'a Map<String, Value>, fid: &str) -> Option<&'a str> {
    values.get(fid).and_then(Value::as_str).map(str::trim)
}

fn fid_price(values: &Map<String, Value>, fid: &str) -> i64 {
    let Some(text) = fid_text(values, fid) else { return 0 };
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text).trim_start();
    clamp_i32_range(digits.parse::<i64>().unwrap_or(0).abs())
}

fn fid_signed(values: &Map<String, Value>, fid: &str) -> i64 {
    let Some(text) = fid_text(values, fid) else { return 0 };
    let val = match text.strip_prefix('-') {
        Some(rest) => -rest.trim_start().parse::<i64>().unwrap_or(0),
        None => text.strip_prefix('+').unwrap_or(text).trim_start().parse::<i64>().unwrap_or(0),
    };
    clamp_i32_range(val)
}

fn parse_book_row(rel_ms: i64, recv_ms: i64, day_start_ms: i64, values: &Map<String, Value>) -> Option<Vec<i64>> {
    let mut row = Vec::with_capacity(44);
    row.push(rel_ms);
    row.push(parse_hhmmss_i64(fid_text(values, "21"), recv_ms, day_start_ms));
    for fid in 41..=50 {
        row.push(fid_price(values, &fid.to_string()));
    }
    for fid in 51..=60 {
        row.push(fid_price(values, &fid.to_string()));
    }
    for fid in 61..=70 {
        row.push(fid_signed(values, &fid.to_string()).max(0));
    }
    for fid in 71..=80 {
        row.push(fid_signed(values, &fid.to_string()).max(0));
    }
    row.push(fid_signed(values, "121").max(0));
    row.push(fid_signed(values, "125").max(0));
    Some(row)
}

fn parse_trade_row(rel_ms: i64, recv_ms: i64, day_start_ms: i64, values: &Map<String, Value>) -> Option<Vec<i64>> {
    let qty = fid_signed(values, "15");
    if qty == 0 {
        return None;
    }
    let price = fid_price(values, "10");
    if price == 0 {
        return None;
    }
    let venue = match fid_text(values, "9081") {
        Some("KRX") => 1,
        Some("NXT") => 2,
        _ => 0,
    };
    Some(vec![
        rel_ms,
        parse_hhmmss_i64(fid_text(values, "20"), recv_ms, day_start_ms),
        price,
        qty,
        venue,
    ])
}

fn parse_program_row(rel_ms: i64, recv_ms: i64, day_start_ms: i64, values: &Map<String, Value>) -> Option<Vec<i64>> {
    Some(vec![
        rel_ms,
        parse_hhmmss_i64(fid_text(values, "20"), recv_ms, day_start_ms),
        fid_signed(values, "202"),
        fid_signed(values, "204"),
        fid_signed(values, "206"),
        fid_signed(values, "208"),
    ])
}

fn rows_to_stream(kind: StreamKind, rows: &[Vec<i64>]) -> Option<Stream> {
    if rows.is_empty() {
        return None;
    }
    let col_count = kind.columns().len();
    let mut columns: Vec<Vec<i64>> = (0..col_count).map(|_| Vec::with_capacity(rows.len())).collect();
    for row in rows {
        if row.len() != col_count {
            continue;
        }
        for (col, &val) in columns.iter_mut().zip(row.iter()) {
            col.push(val);
        }
    }
    if columns[0].is_empty() {
        return None;
    }
    Some(Stream { kind, columns })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn write_zst_lines(path: &Path, lines: &[String]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = File::create(path).unwrap();
        let mut enc = zstd::stream::write::Encoder::new(file, 3).unwrap();
        for line in lines {
            enc.write_all(line.as_bytes()).unwrap();
            enc.write_all(b"\n").unwrap();
        }
        enc.finish().unwrap();
    }

    #[test]
    fn parses_live_five_minute_raw_span_with_carry_forward_and_ignores_other_symbols() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 26).unwrap();
        let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
        std::fs::create_dir_all(tmp.path().join("plan")).unwrap();
        std::fs::write(
            tmp.path().join("plan").join("20261126.json"),
            r#"{"format_version":1,"keys":[{"name":"k1","stocks":["005930","000660"]}]}"#,
        )
        .unwrap();

        let prev_ms = day_start_ms + 544 * 60_000 + 55_000;
        let cur_book_ms = day_start_ms + 545 * 60_000 + 1_200;
        let cur_trade_ms = day_start_ms + 545 * 60_000 + 1_500;

        write_zst_lines(
            &tmp.path().join("raw/20261126/k1/0900-000.jsonl.zst"),
            &[format!(
                r#"{{"recv_ms":{prev_ms},"msg":{{"trnm":"REAL","data":[{{"type":"0D","item":"005930_AL","values":{{"21":"090455","41":"+71100","51":"+71000","61":"100","71":"200","121":"100","125":"200"}}}}]}}}}"#
            )],
        );
        write_zst_lines(
            &tmp.path().join("raw/20261126/k1/0905-000.jsonl.zst"),
            &[
                format!(
                    r#"{{"recv_ms":{cur_book_ms},"msg":{{"trnm":"REAL","data":[{{"type":"0D","item":"000660_AL","values":{{"21":"090501","41":"180000"}}}},{{"type":"0D","item":"005930_AL","values":{{"21":"090501","41":"+71200","51":"+71100","61":"300","71":"400","121":"300","125":"400"}}}}]}}}}"#
                ),
                format!(
                    r#"{{"recv_ms":{cur_trade_ms},"msg":{{"trnm":"REAL","data":[{{"type":"0B","item":"005930_AL","values":{{"20":"090501","10":"+71200","15":"+45","9081":"KRX"}}}}]}}}}"#
                ),
            ],
        );

        let shared = tmp.path().join("shared");
        let span = read_live_span(tmp.path(), &shared, date, 20261126, "20261126", "005930", 545)
            .unwrap()
            .expect("raw span should decode");
        let encoded = hoga_format::encode(&span).unwrap();
        let decoded = hoga_format::decode(&encoded).unwrap();

        let books = decoded.stream(StreamKind::Book).unwrap();
        assert_eq!(books.rows(), 2);
        assert_eq!(books.column("ask_px1").unwrap(), &[71_100, 71_200]);
        assert_eq!(books.column("ask_qty1").unwrap(), &[100, 300]);

        let trades = decoded.stream(StreamKind::Trades).unwrap();
        assert_eq!(trades.rows(), 1);
        assert_eq!(trades.column("price").unwrap(), &[71_200]);
        assert_eq!(trades.column("qty").unwrap(), &[45]);
        assert_eq!(trades.column("venue").unwrap(), &[1]);
    }
}
