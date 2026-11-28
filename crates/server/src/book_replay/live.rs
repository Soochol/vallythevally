use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use domain::{KstDate, StockCode};

use crate::api;
use crate::clock::kst;
use crate::shared_data::{
    FlowLinkEvent, QuoteMinute, closed_day_dir, flow_links_path, live_day_dir, live_quote_days_for_stock, live_quote_stock_keys, read_flow_links, read_quote_day, read_trade_minute_file,
    trade_minute_path,
};

use super::{empty_day, symbol_code};

const COVERED_CONFIRM_MS: i64 = 15_000;
const MAX_TRADES_PER_MINUTE: usize = 10;

pub(super) fn read_live_day(shared: &Path, stock: StockCode, date: KstDate, date_str: &str) -> Result<api::BookReplayDay, String> {
    let code = stock.as_str();
    let live_dir = live_day_dir(shared, date_str);
    let closed_dir = closed_day_dir(shared, date_str);
    if !live_dir.is_dir() && !closed_dir.is_dir() {
        return Ok(empty_day(stock, date_str.to_owned(), api::BookReplayCoverage::DayNotCollected));
    }
    let quote_day = read_quote_day(shared, date_str, code).map_err(|e| format!("분 호가 파일을 읽지 못했습니다: {e}"))?;
    let Some(quote_day) = quote_day else {
        return Ok(empty_day(stock, date_str.to_owned(), api::BookReplayCoverage::SymbolNotCollected));
    };
    let all_books = books_from_quotes(quote_day.minutes);
    let first_book_minute = all_books.first().map(|book| book.minute);
    let mut stock_keys = live_quote_stock_keys(shared, date_str, code).map_err(|e| format!("장중 분 호가 키 목록을 읽지 못했습니다: {e}"))?;
    stock_keys.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));

    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let covered = compute_covered(shared, date_str, day_start_ms, first_book_minute, &stock_keys);
    let last_covered = covered.last().map(|range| range[1]);

    let books = match last_covered {
        Some(last) => all_books.into_iter().filter(|book| book.minute <= last).collect(),
        None => Vec::new(),
    };
    let trades = match last_covered {
        Some(last) => read_merged_trades(shared, date_str, code, &stock_keys, last),
        None => Vec::new(),
    };

    Ok(api::BookReplayDay {
        symbol: symbol_code(stock),
        date: date_str.to_owned(),
        coverage: api::BookReplayCoverage::Collected,
        previous_close: None,
        venue_scope: None,
        covered,
        books,
        trades,
    })
}

pub(super) fn live_days(data_dir: &Path, shared_dir: &Path, stock_code: &str) -> Result<Vec<String>, String> {
    let mut days = live_quote_days_for_stock(shared_dir, stock_code).map_err(|e| format!("장중 분 호가 날짜 목록을 읽지 못했습니다: {e}"))?;
    days.retain(|date| !data_dir.join("store").join(date).join("complete.json").is_file());
    Ok(days)
}

fn books_from_quotes(minutes: Vec<QuoteMinute>) -> Vec<api::BookReplayBook> {
    let mut books = Vec::with_capacity(minutes.len());
    for qm in minutes {
        let ladder = &qm.combined.close;
        if ladder.is_empty() {
            continue;
        }
        let asks: Vec<[u64; 2]> = ladder.asks.iter().map(|level| [level.0.unsigned_abs(), level.1.max(0) as u64]).collect();
        let bids: Vec<[u64; 2]> = ladder.bids.iter().map(|level| [level.0.unsigned_abs(), level.1.max(0) as u64]).collect();
        let total_ask = asks.iter().map(|level| level[1]).sum();
        let total_bid = bids.iter().map(|level| level[1]).sum();
        books.push(api::BookReplayBook {
            minute: u32::from(qm.minute),
            asks,
            bids,
            total_ask,
            total_bid,
        });
    }
    books
}

fn compute_covered(
    shared: &Path,
    date_str: &str,
    day_start_ms: i64,
    first_book_minute: Option<u32>,
    stock_keys: &[(String, u16)],
) -> Vec<[u32; 2]> {
    let Some(first_book) = first_book_minute else {
        return Vec::new();
    };
    let mut covered_minutes = BTreeSet::new();
    for (key_name, key_first_minute) in stock_keys {
        let min_start = first_book.max(u32::from(*key_first_minute));
        let intervals = read_link_intervals(&flow_links_path(shared, date_str, key_name));
        for (start_ms, end_ms) in intervals {
            for minute in min_start..1440 {
                let minute_end_ms = day_start_ms + i64::from(minute + 1) * 60_000;
                if minute_end_ms >= start_ms && minute_end_ms + COVERED_CONFIRM_MS <= end_ms {
                    covered_minutes.insert(minute);
                }
            }
        }
    }
    collapse_ranges(covered_minutes)
}

fn collapse_ranges(minutes: BTreeSet<u32>) -> Vec<[u32; 2]> {
    let mut ranges: Vec<[u32; 2]> = Vec::new();
    for minute in minutes {
        if let Some(last) = ranges.last_mut()
            && last[1] + 1 == minute
        {
            last[1] = minute;
            continue;
        }
        ranges.push([minute, minute]);
    }
    ranges
}

fn read_link_intervals(path: &Path) -> Vec<(i64, i64)> {
    let entries = match read_flow_links(path) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "연결 기록 파일을 읽지 못해 건너뜁니다");
            return Vec::new();
        }
    };
    let mut intervals = Vec::new();
    let mut active: Option<(i64, i64)> = None;
    for entry in entries {
        match entry.event {
            FlowLinkEvent::Live => {
                active = match active {
                    Some((start, end)) => Some((start, end.max(entry.t))),
                    None => Some((entry.t, entry.t)),
                };
            }
            FlowLinkEvent::Alive => {
                if let Some((start, end)) = active {
                    active = Some((start, end.max(entry.t)));
                }
            }
            FlowLinkEvent::Down | FlowLinkEvent::End => {
                if let Some((start, end)) = active.take() {
                    intervals.push((start, end.max(entry.t)));
                }
            }
            FlowLinkEvent::Start => {
                if let Some(interval) = active.take() {
                    intervals.push(interval);
                }
            }
        }
    }
    if let Some(interval) = active {
        intervals.push(interval);
    }
    intervals
}

fn read_merged_trades(
    shared: &Path,
    date_str: &str,
    code: &str,
    stock_keys: &[(String, u16)],
    last_covered: u32,
) -> Vec<(u32, u32, u64, i64)> {
    let mut per_minute: BTreeMap<u16, Vec<(u32, u64, i64)>> = BTreeMap::new();
    for (key_name, _) in stock_keys {
        let path = trade_minute_path(shared, date_str, key_name, code);
        read_trade_file(&path, last_covered, &mut per_minute);
    }
    let mut merged = Vec::new();
    for (minute, trades) in per_minute {
        for (sec, price, quantity) in trades {
            merged.push((u32::from(minute), sec, price, quantity));
        }
    }
    merged
}

fn read_trade_file(path: &Path, last_covered: u32, per_minute: &mut BTreeMap<u16, Vec<(u32, u64, i64)>>) {
    let entries = match read_trade_minute_file(path) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "1분 체결 파일을 읽지 못해 건너뜁니다");
            return;
        }
    };
    for entry in entries {
        if u32::from(entry.minute) > last_covered {
            continue;
        }
        let bucket = per_minute.entry(entry.minute).or_default();
        bucket.extend(entry.trades);
        if bucket.len() > MAX_TRADES_PER_MINUTE {
            let extra = bucket.len() - MAX_TRADES_PER_MINUTE;
            bucket.drain(..extra);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::shared_data::{DataKind, Header};

    use super::*;

    #[test]
    fn incomplete_trailing_line_with_torn_utf8_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let links = tmp.path().join("links.jsonl");
        let mut raw = b"{\"t\":1000,\"event\":\"live\"}\n{\"t\":5000,\"event\":\"alive\"}\n{\"t\":9000,\"event\":\"\xec\x95".to_vec();
        std::fs::write(&links, &raw).unwrap();
        assert_eq!(read_link_intervals(&links), vec![(1000, 5000)]);

        let trades = tmp.path().join("005930.jsonl");
        let header = serde_json::to_vec(&Header::new(DataKind::TradeMinute, KstDate::new(2026, 11, 24).unwrap(), 1, 1, Vec::new())).unwrap();
        raw = header;
        raw.push(b'\n');
        raw.extend_from_slice(br#"{"minute":540,"trades":[[32401,71000,5]]}"#);
        raw.push(b'\n');
        raw.extend_from_slice(b"{\"minute\":541,\"trades\":[\xec\x95");
        std::fs::write(&trades, &raw).unwrap();
        let mut per_minute = BTreeMap::new();
        read_trade_file(&trades, 541, &mut per_minute);
        assert_eq!(per_minute.get(&540), Some(&vec![(32401, 71000, 5)]));
        assert!(!per_minute.contains_key(&541));
    }

    #[test]
    fn unsupported_trade_header_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let trades = tmp.path().join("005930.jsonl");
        let content = concat!(
            r#"{"formatVersion":99,"kind":"tradeMinute","observationDate":"20261124","asOf":1,"writtenAt":1,"sources":[]}"#,
            "\n",
            r#"{"minute":540,"trades":[[32401,71000,5]]}"#,
            "\n"
        );
        std::fs::write(&trades, content).unwrap();
        let mut per_minute = BTreeMap::new();
        read_trade_file(&trades, 540, &mut per_minute);
        assert!(per_minute.is_empty());
    }
}
