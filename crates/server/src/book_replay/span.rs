use std::collections::BTreeMap;
use std::path::Path;

use domain::{KstDate, StockCode};
use duckdb::{Connection, params};
use hoga_format::{Span, Stream, StreamKind};

use crate::api;
use crate::clock::kst;
use crate::collected_store::{StockCoverage, bucket_file_name, file_exists, open_connection, path_str};

use super::store::compute_covered;
use super::symbol_code;

pub(super) const SPAN_MINUTES: u16 = 5;
const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_DAY: i64 = 86_400_000;

const BOOK_META_QUERY: &str = "
WITH per_min AS (
    SELECT
        CAST((recv_ms - $2) // 60000 AS INTEGER) AS minute,
        COUNT(*)::BIGINT AS rows,
        max(struct_pack(r := recv_ms, n := file_row_number)).n AS row_num
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $3 AND recv_ms >= $2 AND recv_ms < $4
    GROUP BY 1
)
SELECT
    p.minute,
    p.rows,
    r.f121,
    r.f125,
    (CASE WHEN r.f41 IS NOT NULL AND r.f41 != 0 THEN 1 ELSE 0 END
     + CASE WHEN r.f42 IS NOT NULL AND r.f42 != 0 THEN 1 ELSE 0 END
     + CASE WHEN r.f43 IS NOT NULL AND r.f43 != 0 THEN 1 ELSE 0 END
     + CASE WHEN r.f44 IS NOT NULL AND r.f44 != 0 THEN 1 ELSE 0 END) AS ask_cnt,
    (CASE WHEN r.f51 IS NOT NULL AND r.f51 != 0 THEN 1 ELSE 0 END
     + CASE WHEN r.f52 IS NOT NULL AND r.f52 != 0 THEN 1 ELSE 0 END
     + CASE WHEN r.f53 IS NOT NULL AND r.f53 != 0 THEN 1 ELSE 0 END
     + CASE WHEN r.f54 IS NOT NULL AND r.f54 != 0 THEN 1 ELSE 0 END) AS bid_cnt
FROM read_parquet($1, file_row_number = true) r
JOIN per_min p ON r.file_row_number = p.row_num
ORDER BY p.minute ASC
";

const TRADE_META_QUERY: &str = "
SELECT
    CAST((recv_ms - $2) // 60000 AS INTEGER) AS minute,
    COUNT(*)::BIGINT AS rows,
    arg_min(abs(f10), struct_pack(r := recv_ms, n := file_row_number))::BIGINT AS open_px,
    max(abs(f10))::BIGINT AS high_px,
    min(abs(f10))::BIGINT AS low_px,
    arg_max(abs(f10), struct_pack(r := recv_ms, n := file_row_number))::BIGINT AS close_px,
    sum(abs(f15))::BIGINT AS vol,
    sum(abs(f10) * abs(f15))::HUGEINT AS val,
    sum(CASE WHEN f15 > 0 THEN f15 ELSE 0 END)::BIGINT AS buy_qty,
    sum(CASE WHEN f15 < 0 THEN -f15 ELSE 0 END)::BIGINT AS sell_qty
FROM read_parquet($1, file_row_number = true)
WHERE symbol = $3
  AND recv_ms >= $2
  AND recv_ms < $4
  AND f15 IS NOT NULL
  AND f15 != 0
  AND f10 IS NOT NULL
GROUP BY 1
ORDER BY 1 ASC
";

const PROGRAM_META_QUERY: &str = "
WITH per_min AS (
    SELECT
        CAST((recv_ms - $2) // 60000 AS INTEGER) AS minute,
        COUNT(*)::BIGINT AS rows,
        max(struct_pack(r := recv_ms, n := file_row_number)).n AS row_num
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $3 AND recv_ms >= $2 AND recv_ms < $4
    GROUP BY 1
)
SELECT
    p.minute,
    p.rows,
    r.f202,
    r.f204,
    r.f206,
    r.f208
FROM read_parquet($1, file_row_number = true) r
JOIN per_min p ON r.file_row_number = p.row_num
ORDER BY p.minute ASC
";

const BOOK_SPAN_QUERY: &str = "
WITH carry AS (
    SELECT
        recv_ms, file_row_number, f21,
        f41, f42, f43, f44, f45, f46, f47, f48, f49, f50,
        f51, f52, f53, f54, f55, f56, f57, f58, f59, f60,
        f61, f62, f63, f64, f65, f66, f67, f68, f69, f70,
        f71, f72, f73, f74, f75, f76, f77, f78, f79, f80,
        f121, f125
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $2 AND recv_ms >= $3 AND recv_ms < $4
    ORDER BY recv_ms DESC, file_row_number DESC
    LIMIT 1
),
window_rows AS (
    SELECT
        recv_ms, file_row_number, f21,
        f41, f42, f43, f44, f45, f46, f47, f48, f49, f50,
        f51, f52, f53, f54, f55, f56, f57, f58, f59, f60,
        f61, f62, f63, f64, f65, f66, f67, f68, f69, f70,
        f71, f72, f73, f74, f75, f76, f77, f78, f79, f80,
        f121, f125
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $2 AND recv_ms >= $4 AND recv_ms < $5
)
SELECT
    recv_ms, f21,
    f41, f42, f43, f44, f45, f46, f47, f48, f49, f50,
    f51, f52, f53, f54, f55, f56, f57, f58, f59, f60,
    f61, f62, f63, f64, f65, f66, f67, f68, f69, f70,
    f71, f72, f73, f74, f75, f76, f77, f78, f79, f80,
    f121, f125
FROM (
    SELECT * FROM carry
    UNION ALL
    SELECT * FROM window_rows
)
ORDER BY recv_ms ASC, file_row_number ASC
";

const TRADE_SPAN_QUERY: &str = "
SELECT recv_ms, f20, f10, f15, f9081
FROM read_parquet($1, file_row_number = true)
WHERE symbol = $2
  AND recv_ms >= $3
  AND recv_ms < $4
  AND f15 IS NOT NULL
  AND f15 != 0
  AND f10 IS NOT NULL
ORDER BY recv_ms ASC, file_row_number ASC
";

const PROGRAM_SPAN_QUERY: &str = "
WITH carry AS (
    SELECT recv_ms, file_row_number, f20, f202, f204, f206, f208
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $2 AND recv_ms >= $3 AND recv_ms < $4
    ORDER BY recv_ms DESC, file_row_number DESC
    LIMIT 1
),
window_rows AS (
    SELECT recv_ms, file_row_number, f20, f202, f204, f206, f208
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $2 AND recv_ms >= $4 AND recv_ms < $5
)
SELECT recv_ms, f20, f202, f204, f206, f208
FROM (
    SELECT * FROM carry
    UNION ALL
    SELECT * FROM window_rows
)
ORDER BY recv_ms ASC, file_row_number ASC
";

struct BookMinuteMeta {
    rows: u32,
    total_ask: u64,
    total_bid: u64,
    single_price: bool,
}

struct TradeMinuteMeta {
    rows: u32,
    open: u64,
    high: u64,
    low: u64,
    close: u64,
    volume: u64,
    value: u64,
    buy_qty: u64,
    sell_qty: u64,
}

struct ProgramMinuteMeta {
    rows: u32,
    net_qty: i64,
    net_amt_million: i64,
}

pub(super) fn read_day_meta(
    day_dir: &Path,
    date: KstDate,
    date_str: &str,
    stock: StockCode,
    buckets: u64,
    coverage: &StockCoverage,
) -> Result<api::BookReplayMeta, String> {
    let symbol = format!("{}_AL", stock.as_str());
    let bucket_file = bucket_file_name(&symbol, buckets);
    let book_path = day_dir.join("0D").join(&bucket_file);
    let trade_path = day_dir.join("0B").join(&bucket_file);
    let program_path = day_dir.join("0w").join(&bucket_file);
    let has_books = file_exists(&book_path)?;
    let has_trades = file_exists(&trade_path)?;
    let has_program = file_exists(&program_path)?;
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let day_end_ms = day_start_ms + MS_PER_DAY;

    let mut book_by_min = BTreeMap::new();
    let mut trade_by_min = BTreeMap::new();
    let mut program_by_min = BTreeMap::new();

    if has_books || has_trades || has_program {
        let conn = open_connection()?;
        if has_books {
            book_by_min = query_book_meta(&conn, &book_path, &symbol, day_start_ms, day_end_ms)?;
        }
        if has_trades {
            trade_by_min = query_trade_meta(&conn, &trade_path, &symbol, day_start_ms, day_end_ms)?;
        }
        if has_program {
            program_by_min = query_program_meta(&conn, &program_path, &symbol, day_start_ms, day_end_ms)?;
        }
    }

    let first_book_minute = book_by_min.keys().next().copied();
    let covered = compute_covered(day_start_ms, first_book_minute, coverage.end_minute_exclusive, &coverage.gaps);
    let gaps_ms = relative_gaps_ms(day_start_ms, &coverage.gaps);

    let mut span_counts: BTreeMap<u32, (u32, u32, u32)> = BTreeMap::new();
    let mut active_minutes: BTreeMap<u32, ()> = BTreeMap::new();
    for (&minute, bm) in &book_by_min {
        active_minutes.insert(minute, ());
        let span_start = (minute / u32::from(SPAN_MINUTES)) * u32::from(SPAN_MINUTES);
        span_counts.entry(span_start).or_default().0 += bm.rows;
    }
    for (&minute, tm) in &trade_by_min {
        active_minutes.insert(minute, ());
        let span_start = (minute / u32::from(SPAN_MINUTES)) * u32::from(SPAN_MINUTES);
        span_counts.entry(span_start).or_default().1 += tm.rows;
    }
    for (&minute, pm) in &program_by_min {
        active_minutes.insert(minute, ());
        let span_start = (minute / u32::from(SPAN_MINUTES)) * u32::from(SPAN_MINUTES);
        span_counts.entry(span_start).or_default().2 += pm.rows;
    }

    let spans = span_counts
        .into_iter()
        .map(|(start_minute, (book_rows, trade_rows, program_rows))| api::BookReplaySpanSummary {
            start_minute,
            book_rows,
            trade_rows,
            program_rows,
        })
        .collect();

    let mut minutes = Vec::with_capacity(active_minutes.len());
    let mut cum_vol: u64 = 0;
    let mut cum_val: u64 = 0;
    let mut cum_buy_qty: u64 = 0;
    let mut cum_sell_qty: u64 = 0;
    let mut day_open: Option<u64> = None;
    let mut day_high: Option<u64> = None;
    let mut day_low: Option<u64> = None;

    for minute in active_minutes.into_keys() {
        let bm = book_by_min.get(&minute);
        let tm = trade_by_min.get(&minute);
        let pm = program_by_min.get(&minute);

        minutes.push(api::BookReplayMinuteCheckpoint {
            minute,
            open: tm.map(|t| t.open),
            high: tm.map(|t| t.high),
            low: tm.map(|t| t.low),
            close: tm.map(|t| t.close),
            volume: tm.map_or(0, |t| t.volume),
            cum_vol,
            cum_val,
            cum_buy_qty,
            cum_sell_qty,
            day_open,
            day_high,
            day_low,
            total_ask: bm.map(|b| b.total_ask),
            total_bid: bm.map(|b| b.total_bid),
            program_net_qty: pm.map(|p| p.net_qty),
            program_net_amt_million: pm.map(|p| p.net_amt_million),
            single_price: bm.is_some_and(|b| b.single_price),
        });

        if let Some(t) = tm {
            cum_vol = cum_vol.saturating_add(t.volume);
            cum_val = cum_val.saturating_add(t.value);
            cum_buy_qty = cum_buy_qty.saturating_add(t.buy_qty);
            cum_sell_qty = cum_sell_qty.saturating_add(t.sell_qty);
            if day_open.is_none() {
                day_open = Some(t.open);
            }
            day_high = Some(day_high.map_or(t.high, |prev| prev.max(t.high)));
            day_low = Some(day_low.map_or(t.low, |prev| prev.min(t.low)));
        }
    }

    Ok(api::BookReplayMeta {
        symbol: symbol_code(stock),
        date: date_str.to_owned(),
        coverage: api::BookReplayCoverage::Collected,
        resolution: api::BookReplayResolution::Tick,
        span_minutes: u32::from(SPAN_MINUTES),
        covered,
        gaps_ms,
        spans,
        minutes,
    })
}

pub(super) fn read_span(
    day_dir: &Path,
    date: KstDate,
    date_u32: u32,
    stock_code: &str,
    buckets: u64,
    coverage: &StockCoverage,
    start_minute: u16,
) -> Result<Span, String> {
    let symbol = format!("{stock_code}_AL");
    let bucket_file = bucket_file_name(&symbol, buckets);
    let book_path = day_dir.join("0D").join(&bucket_file);
    let trade_path = day_dir.join("0B").join(&bucket_file);
    let program_path = day_dir.join("0w").join(&bucket_file);
    let has_books = file_exists(&book_path)?;
    let has_trades = file_exists(&trade_path)?;
    let has_program = file_exists(&program_path)?;

    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let from_ms = day_start_ms + i64::from(start_minute) * MS_PER_MINUTE;
    let to_ms = from_ms + i64::from(SPAN_MINUTES) * MS_PER_MINUTE;

    let mut streams = Vec::new();
    if has_books || has_trades || has_program {
        let conn = open_connection()?;
        if has_books
            && let Some(stream) = query_book_span(&conn, &book_path, &symbol, day_start_ms, from_ms, to_ms)?
        {
            streams.push(stream);
        }
        if has_trades
            && let Some(stream) = query_trade_span(&conn, &trade_path, &symbol, day_start_ms, from_ms, to_ms)?
        {
            streams.push(stream);
        }
        if has_program
            && let Some(stream) = query_program_span(&conn, &program_path, &symbol, day_start_ms, from_ms, to_ms)?
        {
            streams.push(stream);
        }
    }

    let rel_from = i64::from(start_minute) * MS_PER_MINUTE;
    let rel_to = rel_from + i64::from(SPAN_MINUTES) * MS_PER_MINUTE;
    let span_gaps = gaps_in_window(&relative_gaps_ms(day_start_ms, &coverage.gaps), rel_from, rel_to);
    if !span_gaps.is_empty() {
        streams.push(Stream {
            kind: StreamKind::Gaps,
            columns: vec![
                span_gaps.iter().map(|gap| gap[0]).collect(),
                span_gaps.iter().map(|gap| gap[1]).collect(),
            ],
        });
    }

    Ok(Span {
        date: date_u32,
        start_minute,
        length_minutes: SPAN_MINUTES,
        symbol,
        streams,
    })
}

fn query_book_meta(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    day_end_ms: i64,
) -> Result<BTreeMap<u32, BookMinuteMeta>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(BOOK_META_QUERY).map_err(|e| format!("호가 메타 조회 준비 실패({path_s}): {e}"))?;
    let rows = stmt
        .query_map(params![path_s, day_start_ms, symbol, day_end_ms], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let count = row.get::<_, i64>(1)?.max(0).min(i64::from(u32::MAX)) as u32;
            let total_ask = row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as u64;
            let total_bid = row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64;
            let ask_cnt = row.get::<_, i32>(4)?;
            let bid_cnt = row.get::<_, i32>(5)?;
            let single_price = ask_cnt > 0 && bid_cnt > 0 && ask_cnt <= 3 && bid_cnt <= 3;
            Ok((minute, BookMinuteMeta { rows: count, total_ask, total_bid, single_price }))
        })
        .map_err(|e| format!("호가 메타 조회 실행 실패({path_s}): {e}"))?;
    let mut map = BTreeMap::new();
    for entry in rows {
        let (minute, meta) = entry.map_err(|e| format!("호가 메타 행 읽기 실패({path_s}): {e}"))?;
        map.insert(minute, meta);
    }
    Ok(map)
}

fn query_trade_meta(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    day_end_ms: i64,
) -> Result<BTreeMap<u32, TradeMinuteMeta>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(TRADE_META_QUERY).map_err(|e| format!("체결 메타 조회 준비 실패({path_s}): {e}"))?;
    let rows = stmt
        .query_map(params![path_s, day_start_ms, symbol, day_end_ms], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let count = row.get::<_, i64>(1)?.max(0).min(i64::from(u32::MAX)) as u32;
            let open = row.get::<_, i64>(2)?.unsigned_abs();
            let high = row.get::<_, i64>(3)?.unsigned_abs();
            let low = row.get::<_, i64>(4)?.unsigned_abs();
            let close = row.get::<_, i64>(5)?.unsigned_abs();
            let volume = row.get::<_, i64>(6)?.max(0) as u64;
            let value_raw = row.get::<_, i128>(7)?;
            let value = value_raw.clamp(0, i128::from(u64::MAX)) as u64;
            let buy_qty = row.get::<_, i64>(8)?.max(0) as u64;
            let sell_qty = row.get::<_, i64>(9)?.max(0) as u64;
            Ok((minute, TradeMinuteMeta { rows: count, open, high, low, close, volume, value, buy_qty, sell_qty }))
        })
        .map_err(|e| format!("체결 메타 조회 실행 실패({path_s}): {e}"))?;
    let mut map = BTreeMap::new();
    for entry in rows {
        let (minute, meta) = entry.map_err(|e| format!("체결 메타 행 읽기 실패({path_s}): {e}"))?;
        map.insert(minute, meta);
    }
    Ok(map)
}

fn query_program_meta(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    day_end_ms: i64,
) -> Result<BTreeMap<u32, ProgramMinuteMeta>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(PROGRAM_META_QUERY).map_err(|e| format!("프로그램 메타 조회 준비 실패({path_s}): {e}"))?;
    let rows = stmt
        .query_map(params![path_s, day_start_ms, symbol, day_end_ms], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let count = row.get::<_, i64>(1)?.max(0).min(i64::from(u32::MAX)) as u32;
            let sell_qty = row.get::<_, Option<i64>>(2)?.unwrap_or(0);
            let sell_amt = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
            let buy_qty = row.get::<_, Option<i64>>(4)?.unwrap_or(0);
            let buy_amt = row.get::<_, Option<i64>>(5)?.unwrap_or(0);
            Ok((
                minute,
                ProgramMinuteMeta {
                    rows: count,
                    net_qty: buy_qty.saturating_sub(sell_qty),
                    net_amt_million: buy_amt.saturating_sub(sell_amt),
                },
            ))
        })
        .map_err(|e| format!("프로그램 메타 조회 실행 실패({path_s}): {e}"))?;
    let mut map = BTreeMap::new();
    for entry in rows {
        let (minute, meta) = entry.map_err(|e| format!("프로그램 메타 행 읽기 실패({path_s}): {e}"))?;
        map.insert(minute, meta);
    }
    Ok(map)
}

fn query_book_span(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    from_ms: i64,
    to_ms: i64,
) -> Result<Option<Stream>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(BOOK_SPAN_QUERY).map_err(|e| format!("호가 구간 조회 준비 실패({path_s}): {e}"))?;
    let col_count = StreamKind::Book.columns().len();
    let mut columns: Vec<Vec<i64>> = (0..col_count).map(|_| Vec::new()).collect();
    let rows = stmt
        .query_map(params![path_s, symbol, day_start_ms, from_ms, to_ms], |row| {
            let recv_ms = row.get::<_, i64>(0)?;
            let time_text = row.get::<_, Option<String>>(1)?;
            let mut vals = Vec::with_capacity(col_count);
            vals.push(ms_of_day(recv_ms, day_start_ms));
            vals.push(parse_hhmmss_i64(time_text.as_deref(), recv_ms, day_start_ms));
            for i in 0..20 {
                let px = row.get::<_, Option<i64>>(2 + i)?.unwrap_or(0).abs();
                vals.push(clamp_i32_range(px));
            }
            for i in 0..22 {
                let qty = row.get::<_, Option<i64>>(22 + i)?.unwrap_or(0).max(0);
                vals.push(clamp_i32_range(qty));
            }
            Ok(vals)
        })
        .map_err(|e| format!("호가 구간 조회 실행 실패({path_s}): {e}"))?;
    for row in rows {
        let vals = row.map_err(|e| format!("호가 구간 행 읽기 실패({path_s}): {e}"))?;
        for (col, val) in columns.iter_mut().zip(vals) {
            col.push(val);
        }
    }
    if columns[0].is_empty() {
        return Ok(None);
    }
    Ok(Some(Stream { kind: StreamKind::Book, columns }))
}

fn query_trade_span(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    from_ms: i64,
    to_ms: i64,
) -> Result<Option<Stream>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(TRADE_SPAN_QUERY).map_err(|e| format!("체결 구간 조회 준비 실패({path_s}): {e}"))?;
    let mut columns: Vec<Vec<i64>> = (0..5).map(|_| Vec::new()).collect();
    let rows = stmt
        .query_map(params![path_s, symbol, from_ms, to_ms], |row| {
            let recv_ms = row.get::<_, i64>(0)?;
            let time_text = row.get::<_, Option<String>>(1)?;
            let price = row.get::<_, i64>(2)?.abs();
            let qty = row.get::<_, i64>(3)?;
            let venue_text = row.get::<_, Option<String>>(4)?;
            let venue = match venue_text.as_deref().map(str::trim) {
                Some("KRX") => 1,
                Some("NXT") => 2,
                _ => 0,
            };
            Ok([
                ms_of_day(recv_ms, day_start_ms),
                parse_hhmmss_i64(time_text.as_deref(), recv_ms, day_start_ms),
                clamp_i32_range(price),
                clamp_i32_range(qty),
                venue,
            ])
        })
        .map_err(|e| format!("체결 구간 조회 실행 실패({path_s}): {e}"))?;
    for row in rows {
        let vals = row.map_err(|e| format!("체결 구간 행 읽기 실패({path_s}): {e}"))?;
        for (col, val) in columns.iter_mut().zip(vals) {
            col.push(val);
        }
    }
    if columns[0].is_empty() {
        return Ok(None);
    }
    Ok(Some(Stream { kind: StreamKind::Trades, columns }))
}

fn query_program_span(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    from_ms: i64,
    to_ms: i64,
) -> Result<Option<Stream>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(PROGRAM_SPAN_QUERY).map_err(|e| format!("프로그램 구간 조회 준비 실패({path_s}): {e}"))?;
    let mut columns: Vec<Vec<i64>> = (0..6).map(|_| Vec::new()).collect();
    let rows = stmt
        .query_map(params![path_s, symbol, day_start_ms, from_ms, to_ms], |row| {
            let recv_ms = row.get::<_, i64>(0)?;
            let time_text = row.get::<_, Option<String>>(1)?;
            let sell_qty = row.get::<_, Option<i64>>(2)?.unwrap_or(0);
            let sell_amt = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
            let buy_qty = row.get::<_, Option<i64>>(4)?.unwrap_or(0);
            let buy_amt = row.get::<_, Option<i64>>(5)?.unwrap_or(0);
            Ok([
                ms_of_day(recv_ms, day_start_ms),
                parse_hhmmss_i64(time_text.as_deref(), recv_ms, day_start_ms),
                clamp_i32_range(sell_qty),
                clamp_i32_range(sell_amt),
                clamp_i32_range(buy_qty),
                clamp_i32_range(buy_amt),
            ])
        })
        .map_err(|e| format!("프로그램 구간 조회 실행 실패({path_s}): {e}"))?;
    for row in rows {
        let vals = row.map_err(|e| format!("프로그램 구간 행 읽기 실패({path_s}): {e}"))?;
        for (col, val) in columns.iter_mut().zip(vals) {
            col.push(val);
        }
    }
    if columns[0].is_empty() {
        return Ok(None);
    }
    Ok(Some(Stream { kind: StreamKind::Program, columns }))
}

pub(super) fn ms_of_day(recv_ms: i64, day_start_ms: i64) -> i64 {
    (recv_ms - day_start_ms).clamp(0, MS_PER_DAY - 1)
}

pub(super) fn clamp_i32_range(value: i64) -> i64 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX))
}

pub(super) fn parse_hhmmss_i64(raw: Option<&str>, recv_ms: i64, day_start_ms: i64) -> i64 {
    if let Some(text) = raw {
        let bytes = text.trim().as_bytes();
        if bytes.len() == 6 && bytes.iter().all(u8::is_ascii_digit) {
            let hour = i64::from(bytes[0] - b'0') * 10 + i64::from(bytes[1] - b'0');
            let minute = i64::from(bytes[2] - b'0') * 10 + i64::from(bytes[3] - b'0');
            let second = i64::from(bytes[4] - b'0') * 10 + i64::from(bytes[5] - b'0');
            if hour < 24 && minute < 60 && second < 60 {
                return hour * 3600 + minute * 60 + second;
            }
        }
    }
    ((recv_ms - day_start_ms) / 1000).clamp(0, 86_399)
}

pub(super) fn relative_gaps_ms(day_start_ms: i64, gaps: &[(i64, i64)]) -> Vec<[i64; 2]> {
    let mut out = Vec::new();
    for &(from_ms, to_ms) in gaps {
        let start = (from_ms - day_start_ms).clamp(0, MS_PER_DAY);
        let end = (to_ms - day_start_ms).clamp(0, MS_PER_DAY);
        if end > start {
            out.push([start, end]);
        }
    }
    out.sort_unstable_by_key(|g| (g[0], g[1]));
    out
}

pub(super) fn gaps_in_window(gaps_ms: &[[i64; 2]], rel_from: i64, rel_to: i64) -> Vec<[i64; 2]> {
    gaps_ms
        .iter()
        .filter_map(|&[from, to]| {
            let start = from.max(rel_from);
            let end = to.min(rel_to);
            (end > start).then_some([start, end])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_sample_parquet(day_dir: &Path, day_start_ms: i64) {
        std::fs::create_dir_all(day_dir.join("0D")).unwrap();
        std::fs::create_dir_all(day_dir.join("0B")).unwrap();
        let conn = open_connection().unwrap();
        let m540 = day_start_ms + 540 * 60_000;
        let m545 = day_start_ms + 545 * 60_000;
        let mut book_rows = Vec::new();
        for (recv, ask1, bid1, qty) in [
            (m540 + 50_000, 71_100, 71_000, 100),
            (m545 + 1_250, 71_200, 71_100, 250),
            (m545 + 1_500, 71_200, 71_100, 180),
        ] {
            let mut cols = vec![
                "'005930_AL' AS symbol".to_owned(),
                format!("{recv}::BIGINT AS recv_ms"),
                "'090501' AS f21".to_owned(),
            ];
            for level in 0..10 {
                let ask = if level < 4 { (-(ask1 + level * 100)).to_string() } else { "NULL".to_owned() };
                let bid = if level < 4 { (-(bid1 - level * 100)).to_string() } else { "NULL".to_owned() };
                let q = if level < 4 { qty } else { 0 };
                cols.push(format!("({ask})::BIGINT AS f{}", 41 + level));
                cols.push(format!("({bid})::BIGINT AS f{}", 51 + level));
                cols.push(format!("{q}::BIGINT AS f{}", 61 + level));
                cols.push(format!("{q}::BIGINT AS f{}", 71 + level));
            }
            cols.push(format!("{}::BIGINT AS f121", qty * 4));
            cols.push(format!("{}::BIGINT AS f125", qty * 4));
            book_rows.push(format!("SELECT {}", cols.join(", ")));
        }
        conn.execute_batch(&format!(
            "SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)",
            book_rows.join(" UNION ALL "),
            day_dir.join("0D").join("056.parquet").display()
        ))
        .unwrap();

        conn.execute_batch(&format!(
            "SET threads = 1; COPY (
                SELECT '005930_AL' AS symbol, {}::BIGINT AS recv_ms, '090030' AS f20, -71100::BIGINT AS f10, 100::BIGINT AS f15, 'KRX' AS f9081
                UNION ALL
                SELECT '005930_AL' AS symbol, {}::BIGINT AS recv_ms, '090501' AS f20, -71200::BIGINT AS f10, 50::BIGINT AS f15, 'KRX' AS f9081
                UNION ALL
                SELECT '005930_AL' AS symbol, {}::BIGINT AS recv_ms, '090501' AS f20, -71100::BIGINT AS f10, -30::BIGINT AS f15, 'NXT' AS f9081
            ) TO '{}' (FORMAT parquet)",
            m540 + 30_000,
            m545 + 1_200,
            m545 + 1_450,
            day_dir.join("0B").join("056.parquet").display()
        ))
        .unwrap();
    }

    #[test]
    fn meta_checkpoints_accumulate_and_span_includes_carry_forward_keyframe() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 25).unwrap();
        let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
        let day_dir = tmp.path().join("store").join("20261125");
        write_sample_parquet(&day_dir, day_start_ms);

        let stock = StockCode::parse("005930").unwrap();
        let coverage = StockCoverage { gaps: Vec::new(), end_minute_exclusive: 1205 };
        let meta = read_day_meta(&day_dir, date, "20261125", stock, 64, &coverage).unwrap();
        assert_eq!(meta.resolution, api::BookReplayResolution::Tick);
        assert_eq!(meta.spans.len(), 2);
        assert_eq!(meta.spans[0].start_minute, 540);
        assert_eq!(meta.spans[1].start_minute, 545);
        assert_eq!(meta.spans[1].book_rows, 2);
        assert_eq!(meta.spans[1].trade_rows, 2);

        let ck545 = meta.minutes.iter().find(|m| m.minute == 545).unwrap();
        assert_eq!(ck545.cum_vol, 100);
        assert_eq!(ck545.cum_buy_qty, 100);
        assert_eq!(ck545.cum_sell_qty, 0);
        assert_eq!(ck545.day_open, Some(71_100));
        assert_eq!(ck545.open, Some(71_200));
        assert_eq!(ck545.low, Some(71_100));

        let span = read_span(&day_dir, date, 20261125, "005930", 64, &coverage, 545).unwrap();
        let encoded = hoga_format::encode(&span).unwrap();
        let decoded = hoga_format::decode(&encoded).unwrap();
        let books = decoded.stream(StreamKind::Book).unwrap();
        assert_eq!(books.rows(), 3);
        assert_eq!(books.column("recv_ms").unwrap()[0], 540 * 60_000 + 50_000);
        assert_eq!(books.column("ask_px1").unwrap()[0], 71_100);
        assert_eq!(books.column("ask_px1").unwrap()[1], 71_200);

        let trades = decoded.stream(StreamKind::Trades).unwrap();
        assert_eq!(trades.rows(), 2);
        assert_eq!(trades.column("recv_ms").unwrap(), &[545 * 60_000 + 1_200, 545 * 60_000 + 1_450]);
        assert_eq!(trades.column("qty").unwrap(), &[50, -30]);
        assert_eq!(trades.column("venue").unwrap(), &[1, 2]);
    }
}
