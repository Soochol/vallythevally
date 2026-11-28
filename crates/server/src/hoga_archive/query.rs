use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::path::Path;

use domain::{KstDate, StockCode, TimeOfDay};
use duckdb::{Connection, params};
use hoga_format::{Span, Stream, StreamKind};

use crate::api;
use crate::clock::kst;
use crate::collected::kind::CollectedTradeTick;
use crate::collected_store::{file_exists, open_connection, path_str};
use crate::market_source::stream::{Exchange, TradeSide};
use crate::shared_data::{Ladder, LevelQty, QuoteDay, QuoteMinute, VenueQuote};

use super::{
    SNAPSHOTS_FILE, TRADES_FILE, day_minute_to_hhmmss_mmm, hhmmss_mmm_to_day_ms, hhmmss_mmm_to_sec,
    read_meta_previous_close,
};

const SPAN_MINUTES: u16 = 5;
const KRX_VENUE_CODE: i64 = 1;

const DAY_BOOK_QUERY: &str = "
WITH parsed AS (
    SELECT
        CAST((ts_ms // 10000000) * 60 + ((ts_ms // 100000) % 100) AS INTEGER) AS minute,
        ts_ms, seq,
        ask_p1, ask_q1, ask_p2, ask_q2, ask_p3, ask_q3, ask_p4, ask_q4, ask_p5, ask_q5,
        ask_p6, ask_q6, ask_p7, ask_q7, ask_p8, ask_q8, ask_p9, ask_q9, ask_p10, ask_q10,
        bid_p1, bid_q1, bid_p2, bid_q2, bid_p3, bid_q3, bid_p4, bid_q4, bid_p5, bid_q5,
        bid_p6, bid_q6, bid_p7, bid_q7, bid_p8, bid_q8, bid_p9, bid_q9, bid_p10, bid_q10,
        tot_ask, tot_bid,
        row_number() OVER (
            PARTITION BY CAST((ts_ms // 10000000) * 60 + ((ts_ms // 100000) % 100) AS INTEGER)
            ORDER BY ts_ms DESC, seq DESC
        ) AS rn
    FROM read_parquet($1)
    WHERE ts_ms >= 0 AND (ts_ms // 10000000) < 24 AND ((ts_ms // 100000) % 100) < 60
)
SELECT
    minute,
    ask_p1, ask_q1, ask_p2, ask_q2, ask_p3, ask_q3, ask_p4, ask_q4, ask_p5, ask_q5,
    ask_p6, ask_q6, ask_p7, ask_q7, ask_p8, ask_q8, ask_p9, ask_q9, ask_p10, ask_q10,
    bid_p1, bid_q1, bid_p2, bid_q2, bid_p3, bid_q3, bid_p4, bid_q4, bid_p5, bid_q5,
    bid_p6, bid_q6, bid_p7, bid_q7, bid_p8, bid_q8, bid_p9, bid_q9, bid_p10, bid_q10,
    tot_ask, tot_bid
FROM parsed
WHERE rn = 1
ORDER BY minute ASC
";

const DAY_TRADE_QUERY: &str = "
WITH per_min AS (
    SELECT
        CAST((ts_ms // 10000000) * 60 + ((ts_ms // 100000) % 100) AS INTEGER) AS minute,
        max(struct_pack(t := ts_ms, s := seq, p := CAST(price AS BIGINT), q := CAST(qty AS BIGINT), side := CAST(side AS BIGINT)), 10) AS top
    FROM read_parquet($1)
    WHERE ts_ms >= 0
      AND (ts_ms // 10000000) < 24
      AND ((ts_ms // 100000) % 100) < 60
      AND price IS NOT NULL AND price > 0
      AND qty IS NOT NULL AND qty > 0
    GROUP BY 1
),
flat AS (
    SELECT minute, unnest(top) AS item
    FROM per_min
)
SELECT minute, item.t, item.p, item.q, item.side
FROM flat
ORDER BY minute ASC, item.t ASC, item.s ASC
";

const META_BOOK_QUERY: &str = "
WITH parsed AS (
    SELECT
        CAST((ts_ms // 10000000) * 60 + ((ts_ms // 100000) % 100) AS INTEGER) AS minute,
        ts_ms, seq,
        tot_ask, tot_bid,
        (CASE WHEN ask_p1 IS NOT NULL AND ask_p1 > 0 THEN 1 ELSE 0 END
         + CASE WHEN ask_p2 IS NOT NULL AND ask_p2 > 0 THEN 1 ELSE 0 END
         + CASE WHEN ask_p3 IS NOT NULL AND ask_p3 > 0 THEN 1 ELSE 0 END
         + CASE WHEN ask_p4 IS NOT NULL AND ask_p4 > 0 THEN 1 ELSE 0 END) AS ask_cnt,
        (CASE WHEN bid_p1 IS NOT NULL AND bid_p1 > 0 THEN 1 ELSE 0 END
         + CASE WHEN bid_p2 IS NOT NULL AND bid_p2 > 0 THEN 1 ELSE 0 END
         + CASE WHEN bid_p3 IS NOT NULL AND bid_p3 > 0 THEN 1 ELSE 0 END
         + CASE WHEN bid_p4 IS NOT NULL AND bid_p4 > 0 THEN 1 ELSE 0 END) AS bid_cnt
    FROM read_parquet($1)
    WHERE ts_ms >= 0 AND (ts_ms // 10000000) < 24 AND ((ts_ms // 100000) % 100) < 60
),
ranked AS (
    SELECT
        minute,
        COUNT(*) OVER (PARTITION BY minute)::BIGINT AS rows,
        tot_ask, tot_bid, ask_cnt, bid_cnt,
        row_number() OVER (PARTITION BY minute ORDER BY ts_ms DESC, seq DESC) AS rn
    FROM parsed
)
SELECT minute, rows, tot_ask, tot_bid, ask_cnt, bid_cnt
FROM ranked
WHERE rn = 1
ORDER BY minute ASC
";

const META_TRADE_QUERY: &str = "
SELECT
    CAST((ts_ms // 10000000) * 60 + ((ts_ms // 100000) % 100) AS INTEGER) AS minute,
    COUNT(*)::BIGINT AS rows,
    arg_min(CAST(price AS BIGINT), struct_pack(t := ts_ms, s := seq))::BIGINT AS open_px,
    max(CAST(price AS BIGINT))::BIGINT AS high_px,
    min(CAST(price AS BIGINT))::BIGINT AS low_px,
    arg_max(CAST(price AS BIGINT), struct_pack(t := ts_ms, s := seq))::BIGINT AS close_px,
    sum(CAST(qty AS BIGINT))::BIGINT AS vol,
    sum(CAST(price AS BIGINT) * CAST(qty AS BIGINT))::HUGEINT AS val,
    sum(CASE WHEN side > 0 THEN CAST(qty AS BIGINT) ELSE 0 END)::BIGINT AS buy_qty,
    sum(CASE WHEN side < 0 THEN CAST(qty AS BIGINT) ELSE 0 END)::BIGINT AS sell_qty
FROM read_parquet($1)
WHERE ts_ms >= 0
  AND (ts_ms // 10000000) < 24
  AND ((ts_ms // 100000) % 100) < 60
  AND price IS NOT NULL AND price > 0
  AND qty IS NOT NULL AND qty > 0
GROUP BY 1
ORDER BY 1 ASC
";

const SPAN_BOOK_QUERY: &str = "
WITH carry AS (
    SELECT
        ts_ms, seq,
        ask_p1, ask_p2, ask_p3, ask_p4, ask_p5, ask_p6, ask_p7, ask_p8, ask_p9, ask_p10,
        bid_p1, bid_p2, bid_p3, bid_p4, bid_p5, bid_p6, bid_p7, bid_p8, bid_p9, bid_p10,
        ask_q1, ask_q2, ask_q3, ask_q4, ask_q5, ask_q6, ask_q7, ask_q8, ask_q9, ask_q10,
        bid_q1, bid_q2, bid_q3, bid_q4, bid_q5, bid_q6, bid_q7, bid_q8, bid_q9, bid_q10,
        tot_ask, tot_bid
    FROM read_parquet($1)
    WHERE ts_ms >= 0 AND ts_ms < $2
    ORDER BY ts_ms DESC, seq DESC
    LIMIT 1
),
window_rows AS (
    SELECT
        ts_ms, seq,
        ask_p1, ask_p2, ask_p3, ask_p4, ask_p5, ask_p6, ask_p7, ask_p8, ask_p9, ask_p10,
        bid_p1, bid_p2, bid_p3, bid_p4, bid_p5, bid_p6, bid_p7, bid_p8, bid_p9, bid_p10,
        ask_q1, ask_q2, ask_q3, ask_q4, ask_q5, ask_q6, ask_q7, ask_q8, ask_q9, ask_q10,
        bid_q1, bid_q2, bid_q3, bid_q4, bid_q5, bid_q6, bid_q7, bid_q8, bid_q9, bid_q10,
        tot_ask, tot_bid
    FROM read_parquet($1)
    WHERE ts_ms >= $2 AND ts_ms < $3
)
SELECT
    ts_ms,
    ask_p1, ask_p2, ask_p3, ask_p4, ask_p5, ask_p6, ask_p7, ask_p8, ask_p9, ask_p10,
    bid_p1, bid_p2, bid_p3, bid_p4, bid_p5, bid_p6, bid_p7, bid_p8, bid_p9, bid_p10,
    ask_q1, ask_q2, ask_q3, ask_q4, ask_q5, ask_q6, ask_q7, ask_q8, ask_q9, ask_q10,
    bid_q1, bid_q2, bid_q3, bid_q4, bid_q5, bid_q6, bid_q7, bid_q8, bid_q9, bid_q10,
    tot_ask, tot_bid
FROM (
    SELECT * FROM carry
    UNION ALL
    SELECT * FROM window_rows
)
ORDER BY ts_ms ASC, seq ASC
";

const SPAN_TRADE_QUERY: &str = "
SELECT
    CAST(ts_ms AS BIGINT),
    CAST(price AS BIGINT),
    CAST(qty AS BIGINT),
    CAST(side AS BIGINT)
FROM read_parquet($1)
WHERE ts_ms >= $2
  AND ts_ms < $3
  AND price IS NOT NULL AND price > 0
  AND qty IS NOT NULL AND qty > 0
ORDER BY ts_ms ASC, seq ASC
";

const ALL_TRADE_TICKS_QUERY: &str = "
SELECT
    CAST(ts_ms AS BIGINT),
    CAST(price AS BIGINT),
    CAST(qty AS BIGINT),
    CAST(side AS BIGINT)
FROM read_parquet($1)
WHERE ts_ms >= 0
  AND price IS NOT NULL AND price > 0
  AND qty IS NOT NULL AND qty > 0
ORDER BY ts_ms ASC, seq ASC
";

pub struct ArchiveDayReplayData {
    pub previous_close: Option<u64>,
    pub covered: Vec<[u32; 2]>,
    pub books: Vec<api::BookReplayBook>,
    pub trades: Vec<(u32, u32, u64, i64)>,
}

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

pub fn read_day_data(hogaplay_dir: &Path) -> Result<ArchiveDayReplayData, String> {
    let book_path = hogaplay_dir.join(SNAPSHOTS_FILE);
    let trade_path = hogaplay_dir.join(TRADES_FILE);
    let has_books = file_exists(&book_path)?;
    let has_trades = file_exists(&trade_path)?;
    let previous_close = read_meta_previous_close(hogaplay_dir);
    if !has_books && !has_trades {
        return Ok(ArchiveDayReplayData {
            previous_close,
            covered: Vec::new(),
            books: Vec::new(),
            trades: Vec::new(),
        });
    }
    let conn = open_connection()?;
    let books = if has_books { query_day_books(&conn, &book_path)? } else { Vec::new() };
    let trades = if has_trades { query_day_trades(&conn, &trade_path)? } else { Vec::new() };
    let covered = contiguous_covered(books.first().map(|b| b.minute), books.last().map(|b| b.minute));
    Ok(ArchiveDayReplayData { previous_close, covered, books, trades })
}

pub fn read_day_meta(hogaplay_dir: &Path, date_str: &str, stock: StockCode) -> Result<api::BookReplayMeta, String> {
    let book_path = hogaplay_dir.join(SNAPSHOTS_FILE);
    let trade_path = hogaplay_dir.join(TRADES_FILE);
    let has_books = file_exists(&book_path)?;
    let has_trades = file_exists(&trade_path)?;

    let mut book_by_min = BTreeMap::new();
    let mut trade_by_min = BTreeMap::new();
    if has_books || has_trades {
        let conn = open_connection()?;
        if has_books {
            book_by_min = query_book_meta(&conn, &book_path)?;
        }
        if has_trades {
            trade_by_min = query_trade_meta(&conn, &trade_path)?;
        }
    }

    let covered = contiguous_covered(book_by_min.keys().next().copied(), book_by_min.keys().next_back().copied());
    let mut span_counts: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
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

    let spans = span_counts
        .into_iter()
        .map(|(start_minute, (book_rows, trade_rows))| api::BookReplaySpanSummary {
            start_minute,
            book_rows,
            trade_rows,
            program_rows: 0,
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
            program_net_qty: None,
            program_net_amt_million: None,
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
        symbol: api::SymbolCode(domain::Symbol::Stock(stock).as_wire()),
        date: date_str.to_owned(),
        coverage: api::BookReplayCoverage::Collected,
        resolution: api::BookReplayResolution::Tick,
        span_minutes: u32::from(SPAN_MINUTES),
        previous_close: read_meta_previous_close(hogaplay_dir),
        venue_scope: Some(api::ReplayVenueScope::KrxArchive),
        covered,
        gaps_ms: Vec::new(),
        spans,
        minutes,
    })
}

pub fn read_span(hogaplay_dir: &Path, date_u32: u32, stock_code: &str, start_minute: u16) -> Result<Span, String> {
    let book_path = hogaplay_dir.join(SNAPSHOTS_FILE);
    let trade_path = hogaplay_dir.join(TRADES_FILE);
    let has_books = file_exists(&book_path)?;
    let has_trades = file_exists(&trade_path)?;
    let from_ts = day_minute_to_hhmmss_mmm(start_minute);
    let to_ts = day_minute_to_hhmmss_mmm(start_minute.saturating_add(SPAN_MINUTES));

    let mut streams = Vec::new();
    if has_books || has_trades {
        let conn = open_connection()?;
        if has_books
            && let Some(stream) = query_book_span(&conn, &book_path, from_ts, to_ts)?
        {
            streams.push(stream);
        }
        if has_trades
            && let Some(stream) = query_trade_span(&conn, &trade_path, from_ts, to_ts)?
        {
            streams.push(stream);
        }
    }

    Ok(Span {
        date: date_u32,
        start_minute,
        length_minutes: SPAN_MINUTES,
        symbol: format!("{stock_code}_AL"),
        streams,
    })
}

pub fn read_trade_ticks(hogaplay_dir: &Path, date: KstDate) -> Result<Vec<CollectedTradeTick>, String> {
    let path = hogaplay_dir.join(TRADES_FILE);
    if !file_exists(&path)? {
        return Ok(Vec::new());
    }
    let path_text = path_str(&path)?;
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let conn = open_connection()?;
    let mut stmt = conn.prepare(ALL_TRADE_TICKS_QUERY).map_err(|e| format!("아카이브 체결 조회 준비 실패({path_text}): {e}"))?;
    let mut rows = stmt.query(params![path_text]).map_err(|e| format!("아카이브 체결 조회 실행 실패({path_text}): {e}"))?;

    let mut ticks = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("아카이브 체결 행 읽기 실패({path_text}): {e}"))? {
        let ts_ms = row.get::<_, i64>(0).map_err(|e| format!("ts_ms 읽기 실패({path_text}): {e}"))?;
        let Some(day_ms) = hhmmss_mmm_to_day_ms(ts_ms) else {
            continue;
        };
        let price = row.get::<_, i64>(1).map_err(|e| format!("price 읽기 실패({path_text}): {e}"))?;
        let qty = row.get::<_, i64>(2).map_err(|e| format!("qty 읽기 실패({path_text}): {e}"))?;
        let raw_side = row.get::<_, Option<i64>>(3).map_err(|e| format!("side 읽기 실패({path_text}): {e}"))?.unwrap_or(0);
        if price <= 0 || qty <= 0 {
            continue;
        }
        let sec = (day_ms / 1000) as u32;
        let Some(hhmmss) = TimeOfDay::hms(sec / 3600, (sec % 3600) / 60, sec % 60) else {
            continue;
        };
        let (side, signed_qty) = if raw_side > 0 {
            (Some(TradeSide::Buy), qty)
        } else if raw_side < 0 {
            (Some(TradeSide::Sell), -qty)
        } else {
            (None, qty)
        };
        ticks.push(CollectedTradeTick {
            recv_ms: day_start_ms + day_ms,
            hhmmss,
            price_won: price as u64,
            signed_qty,
            side,
            instant_value_thousand_won: None,
            exchange: Some(Exchange::Krx),
        });
    }
    Ok(ticks)
}

fn query_day_books(conn: &Connection, path: &Path) -> Result<Vec<api::BookReplayBook>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(DAY_BOOK_QUERY).map_err(|e| format!("아카이브 호가 조회 준비 실패({path_s}): {e}"))?;
    let rows = stmt
        .query_map(params![path_s], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let mut asks = Vec::with_capacity(10);
            for level in 0..10 {
                let price = row.get::<_, Option<i64>>(1 + level * 2)?.unwrap_or(0).max(0) as u64;
                if price > 0 {
                    let qty = row.get::<_, Option<i64>>(2 + level * 2)?.unwrap_or(0).max(0) as u64;
                    asks.push([price, qty]);
                }
            }
            let mut bids = Vec::with_capacity(10);
            for level in 0..10 {
                let price = row.get::<_, Option<i64>>(21 + level * 2)?.unwrap_or(0).max(0) as u64;
                if price > 0 {
                    let qty = row.get::<_, Option<i64>>(22 + level * 2)?.unwrap_or(0).max(0) as u64;
                    bids.push([price, qty]);
                }
            }
            let total_ask = row.get::<_, Option<i64>>(41)?.unwrap_or(0).max(0) as u64;
            let total_bid = row.get::<_, Option<i64>>(42)?.unwrap_or(0).max(0) as u64;
            Ok(api::BookReplayBook { minute, asks, bids, total_ask, total_bid })
        })
        .map_err(|e| format!("아카이브 호가 조회 실행 실패({path_s}): {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("아카이브 호가 행 읽기 실패({path_s}): {e}"))
}

fn query_day_trades(conn: &Connection, path: &Path) -> Result<Vec<(u32, u32, u64, i64)>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(DAY_TRADE_QUERY).map_err(|e| format!("아카이브 체결 조회 준비 실패({path_s}): {e}"))?;
    let rows = stmt
        .query_map(params![path_s], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let ts_ms = row.get::<_, i64>(1)?;
            let price = row.get::<_, i64>(2)?.unsigned_abs();
            let qty = row.get::<_, i64>(3)?.max(0);
            let side = row.get::<_, Option<i64>>(4)?.unwrap_or(0);
            let signed_qty = if side < 0 { -qty } else { qty };
            let time_sec = hhmmss_mmm_to_sec(ts_ms).unwrap_or(minute * 60);
            Ok((minute, time_sec, price, signed_qty))
        })
        .map_err(|e| format!("아카이브 체결 조회 실행 실패({path_s}): {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("아카이브 체결 행 읽기 실패({path_s}): {e}"))
}

fn query_book_meta(conn: &Connection, path: &Path) -> Result<BTreeMap<u32, BookMinuteMeta>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(META_BOOK_QUERY).map_err(|e| format!("아카이브 호가 메타 조회 준비 실패({path_s}): {e}"))?;
    let rows = stmt
        .query_map(params![path_s], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let count = row.get::<_, i64>(1)?.max(0).min(i64::from(u32::MAX)) as u32;
            let total_ask = row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as u64;
            let total_bid = row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64;
            let ask_cnt = row.get::<_, i32>(4)?;
            let bid_cnt = row.get::<_, i32>(5)?;
            let single_price = ask_cnt > 0 && bid_cnt > 0 && ask_cnt <= 3 && bid_cnt <= 3;
            Ok((minute, BookMinuteMeta { rows: count, total_ask, total_bid, single_price }))
        })
        .map_err(|e| format!("아카이브 호가 메타 조회 실행 실패({path_s}): {e}"))?;
    let mut map = BTreeMap::new();
    for entry in rows {
        let (minute, meta) = entry.map_err(|e| format!("아카이브 호가 메타 행 읽기 실패({path_s}): {e}"))?;
        map.insert(minute, meta);
    }
    Ok(map)
}

fn query_trade_meta(conn: &Connection, path: &Path) -> Result<BTreeMap<u32, TradeMinuteMeta>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(META_TRADE_QUERY).map_err(|e| format!("아카이브 체결 메타 조회 준비 실패({path_s}): {e}"))?;
    let rows = stmt
        .query_map(params![path_s], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let count = row.get::<_, i64>(1)?.max(0).min(i64::from(u32::MAX)) as u32;
            let open = row.get::<_, i64>(2)?.unsigned_abs();
            let high = row.get::<_, i64>(3)?.unsigned_abs();
            let low = row.get::<_, i64>(4)?.unsigned_abs();
            let close = row.get::<_, i64>(5)?.unsigned_abs();
            let volume = row.get::<_, i64>(6)?.max(0) as u64;
            let value = row.get::<_, i128>(7)?.clamp(0, i128::from(u64::MAX)) as u64;
            let buy_qty = row.get::<_, i64>(8)?.max(0) as u64;
            let sell_qty = row.get::<_, i64>(9)?.max(0) as u64;
            Ok((minute, TradeMinuteMeta { rows: count, open, high, low, close, volume, value, buy_qty, sell_qty }))
        })
        .map_err(|e| format!("아카이브 체결 메타 조회 실행 실패({path_s}): {e}"))?;
    let mut map = BTreeMap::new();
    for entry in rows {
        let (minute, meta) = entry.map_err(|e| format!("아카이브 체결 메타 행 읽기 실패({path_s}): {e}"))?;
        map.insert(minute, meta);
    }
    Ok(map)
}

fn query_book_span(conn: &Connection, path: &Path, from_ts: i64, to_ts: i64) -> Result<Option<Stream>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(SPAN_BOOK_QUERY).map_err(|e| format!("아카이브 호가 구간 조회 준비 실패({path_s}): {e}"))?;
    let col_count = StreamKind::Book.columns().len();
    let mut columns: Vec<Vec<i64>> = (0..col_count).map(|_| Vec::new()).collect();
    let rows = stmt
        .query_map(params![path_s, from_ts, to_ts], |row| {
            let ts_ms = row.get::<_, i64>(0)?;
            let Some(day_ms) = hhmmss_mmm_to_day_ms(ts_ms) else {
                return Ok(None);
            };
            let mut vals = Vec::with_capacity(col_count);
            vals.push(clamp_i32(day_ms));
            vals.push(day_ms / 1000);
            for i in 0..20 {
                let px = row.get::<_, Option<i64>>(1 + i)?.unwrap_or(0).max(0);
                vals.push(clamp_i32(px));
            }
            for i in 0..22 {
                let qty = row.get::<_, Option<i64>>(21 + i)?.unwrap_or(0).max(0);
                vals.push(clamp_i32(qty));
            }
            Ok(Some(vals))
        })
        .map_err(|e| format!("아카이브 호가 구간 조회 실행 실패({path_s}): {e}"))?;
    for row in rows {
        let Some(vals) = row.map_err(|e| format!("아카이브 호가 구간 행 읽기 실패({path_s}): {e}"))? else {
            continue;
        };
        for (col, val) in columns.iter_mut().zip(vals) {
            col.push(val);
        }
    }
    if columns[0].is_empty() {
        return Ok(None);
    }
    Ok(Some(Stream { kind: StreamKind::Book, columns }))
}

fn query_trade_span(conn: &Connection, path: &Path, from_ts: i64, to_ts: i64) -> Result<Option<Stream>, String> {
    let path_s = path_str(path)?;
    let mut stmt = conn.prepare(SPAN_TRADE_QUERY).map_err(|e| format!("아카이브 체결 구간 조회 준비 실패({path_s}): {e}"))?;
    let mut columns: Vec<Vec<i64>> = (0..5).map(|_| Vec::new()).collect();
    let rows = stmt
        .query_map(params![path_s, from_ts, to_ts], |row| {
            let ts_ms = row.get::<_, i64>(0)?;
            let Some(day_ms) = hhmmss_mmm_to_day_ms(ts_ms) else {
                return Ok(None);
            };
            let price = row.get::<_, i64>(1)?.abs();
            let qty = row.get::<_, i64>(2)?.max(0);
            let side = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
            let signed_qty = if side < 0 { -qty } else { qty };
            Ok(Some([
                clamp_i32(day_ms),
                day_ms / 1000,
                clamp_i32(price),
                clamp_i32(signed_qty),
                KRX_VENUE_CODE,
            ]))
        })
        .map_err(|e| format!("아카이브 체결 구간 조회 실행 실패({path_s}): {e}"))?;
    for row in rows {
        let Some(vals) = row.map_err(|e| format!("아카이브 체결 구간 행 읽기 실패({path_s}): {e}"))? else {
            continue;
        };
        for (col, val) in columns.iter_mut().zip(vals) {
            col.push(val);
        }
    }
    if columns[0].is_empty() {
        return Ok(None);
    }
    Ok(Some(Stream { kind: StreamKind::Trades, columns }))
}

fn contiguous_covered(first: Option<u32>, last: Option<u32>) -> Vec<[u32; 2]> {
    match (first, last) {
        (Some(start), Some(end)) if end >= start => vec![[start, end]],
        _ => Vec::new(),
    }
}

const QUOTE_MINUTES_QUERY: &str = "
WITH parsed AS (
    SELECT
        CAST((ts_ms // 10000000) * 60 + ((ts_ms // 100000) % 100) AS INTEGER) AS minute,
        CAST((ts_ms // 10000000) * 3600 + ((ts_ms // 100000) % 100) * 60 + ((ts_ms // 1000) % 100) AS INTEGER) AS sec,
        ts_ms, seq,
        ask_p1, ask_q1, ask_p2, ask_q2, ask_p3, ask_q3, ask_p4, ask_q4, ask_p5, ask_q5,
        ask_p6, ask_q6, ask_p7, ask_q7, ask_p8, ask_q8, ask_p9, ask_q9, ask_p10, ask_q10,
        bid_p1, bid_q1, bid_p2, bid_q2, bid_p3, bid_q3, bid_p4, bid_q4, bid_p5, bid_q5,
        bid_p6, bid_q6, bid_p7, bid_q7, bid_p8, bid_q8, bid_p9, bid_q9, bid_p10, bid_q10,
        (CASE WHEN ask_p1 IS NOT NULL AND ask_p1 > 0 THEN 1 ELSE 0 END
         + CASE WHEN ask_p2 IS NOT NULL AND ask_p2 > 0 THEN 1 ELSE 0 END
         + CASE WHEN ask_p3 IS NOT NULL AND ask_p3 > 0 THEN 1 ELSE 0 END
         + CASE WHEN ask_p4 IS NOT NULL AND ask_p4 > 0 THEN 1 ELSE 0 END) AS ask_cnt,
        (CASE WHEN bid_p1 IS NOT NULL AND bid_p1 > 0 THEN 1 ELSE 0 END
         + CASE WHEN bid_p2 IS NOT NULL AND bid_p2 > 0 THEN 1 ELSE 0 END
         + CASE WHEN bid_p3 IS NOT NULL AND bid_p3 > 0 THEN 1 ELSE 0 END
         + CASE WHEN bid_p4 IS NOT NULL AND bid_p4 > 0 THEN 1 ELSE 0 END) AS bid_cnt,
        (CASE WHEN ask_p1 IS NOT NULL AND ask_p1 > 0 AND ask_q1 IS NOT NULL AND ask_q1 > 0 THEN CAST(ask_q1 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p2 IS NOT NULL AND ask_p2 > 0 AND ask_q2 IS NOT NULL AND ask_q2 > 0 THEN CAST(ask_q2 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p3 IS NOT NULL AND ask_p3 > 0 AND ask_q3 IS NOT NULL AND ask_q3 > 0 THEN CAST(ask_q3 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p4 IS NOT NULL AND ask_p4 > 0 AND ask_q4 IS NOT NULL AND ask_q4 > 0 THEN CAST(ask_q4 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p5 IS NOT NULL AND ask_p5 > 0 AND ask_q5 IS NOT NULL AND ask_q5 > 0 THEN CAST(ask_q5 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p6 IS NOT NULL AND ask_p6 > 0 AND ask_q6 IS NOT NULL AND ask_q6 > 0 THEN CAST(ask_q6 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p7 IS NOT NULL AND ask_p7 > 0 AND ask_q7 IS NOT NULL AND ask_q7 > 0 THEN CAST(ask_q7 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p8 IS NOT NULL AND ask_p8 > 0 AND ask_q8 IS NOT NULL AND ask_q8 > 0 THEN CAST(ask_q8 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p9 IS NOT NULL AND ask_p9 > 0 AND ask_q9 IS NOT NULL AND ask_q9 > 0 THEN CAST(ask_q9 AS BIGINT) ELSE 0 END
         + CASE WHEN ask_p10 IS NOT NULL AND ask_p10 > 0 AND ask_q10 IS NOT NULL AND ask_q10 > 0 THEN CAST(ask_q10 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p1 IS NOT NULL AND bid_p1 > 0 AND bid_q1 IS NOT NULL AND bid_q1 > 0 THEN CAST(bid_q1 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p2 IS NOT NULL AND bid_p2 > 0 AND bid_q2 IS NOT NULL AND bid_q2 > 0 THEN CAST(bid_q2 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p3 IS NOT NULL AND bid_p3 > 0 AND bid_q3 IS NOT NULL AND bid_q3 > 0 THEN CAST(bid_q3 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p4 IS NOT NULL AND bid_p4 > 0 AND bid_q4 IS NOT NULL AND bid_q4 > 0 THEN CAST(bid_q4 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p5 IS NOT NULL AND bid_p5 > 0 AND bid_q5 IS NOT NULL AND bid_q5 > 0 THEN CAST(bid_q5 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p6 IS NOT NULL AND bid_p6 > 0 AND bid_q6 IS NOT NULL AND bid_q6 > 0 THEN CAST(bid_q6 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p7 IS NOT NULL AND bid_p7 > 0 AND bid_q7 IS NOT NULL AND bid_q7 > 0 THEN CAST(bid_q7 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p8 IS NOT NULL AND bid_p8 > 0 AND bid_q8 IS NOT NULL AND bid_q8 > 0 THEN CAST(bid_q8 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p9 IS NOT NULL AND bid_p9 > 0 AND bid_q9 IS NOT NULL AND bid_q9 > 0 THEN CAST(bid_q9 AS BIGINT) ELSE 0 END
         + CASE WHEN bid_p10 IS NOT NULL AND bid_p10 > 0 AND bid_q10 IS NOT NULL AND bid_q10 > 0 THEN CAST(bid_q10 AS BIGINT) ELSE 0 END) AS level_total
    FROM read_parquet($1)
    WHERE ts_ms >= 0
      AND (ts_ms // 10000000) < 24
      AND ((ts_ms // 100000) % 100) < 60
      AND ((ts_ms // 1000) % 100) < 60
),
ranked AS (
    SELECT
        minute, sec, ask_cnt, bid_cnt, level_total,
        ask_p1, ask_q1, ask_p2, ask_q2, ask_p3, ask_q3, ask_p4, ask_q4, ask_p5, ask_q5,
        ask_p6, ask_q6, ask_p7, ask_q7, ask_p8, ask_q8, ask_p9, ask_q9, ask_p10, ask_q10,
        bid_p1, bid_q1, bid_p2, bid_q2, bid_p3, bid_q3, bid_p4, bid_q4, bid_p5, bid_q5,
        bid_p6, bid_q6, bid_p7, bid_q7, bid_p8, bid_q8, bid_p9, bid_q9, bid_p10, bid_q10,
        row_number() OVER (PARTITION BY minute ORDER BY ts_ms DESC, seq DESC) AS rn_close,
        row_number() OVER (
            PARTITION BY minute
            ORDER BY (CASE WHEN ask_cnt <= 3 AND bid_cnt <= 3 THEN -1 ELSE level_total END) DESC, ts_ms ASC, seq ASC
        ) AS rn_peak
    FROM parsed
)
SELECT
    minute, sec, rn_close, rn_peak, ask_cnt, bid_cnt, level_total,
    ask_p1, ask_q1, ask_p2, ask_q2, ask_p3, ask_q3, ask_p4, ask_q4, ask_p5, ask_q5,
    ask_p6, ask_q6, ask_p7, ask_q7, ask_p8, ask_q8, ask_p9, ask_q9, ask_p10, ask_q10,
    bid_p1, bid_q1, bid_p2, bid_q2, bid_p3, bid_q3, bid_p4, bid_q4, bid_p5, bid_q5,
    bid_p6, bid_q6, bid_p7, bid_q7, bid_p8, bid_q8, bid_p9, bid_q9, bid_p10, bid_q10
FROM ranked
WHERE rn_close = 1 OR rn_peak = 1
ORDER BY minute ASC
";

const SESSION_CLOSE_SEC: u32 = 20 * 3600;

struct ArchiveMinuteAcc {
    close_sec: u32,
    single_price: bool,
    close: Ladder,
    peak: Ladder,
}

pub fn read_quote_day(hogaplay_dir: &Path) -> Result<Option<QuoteDay>, String> {
    let snaps_path = hogaplay_dir.join(SNAPSHOTS_FILE);
    if !file_exists(&snaps_path)? {
        return Ok(None);
    }
    let path_s = path_str(&snaps_path)?;
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(QUOTE_MINUTES_QUERY)
        .map_err(|e| format!("아카이브 분 호가 조회 준비 실패({path_s}): {e}"))?;
    let mut rows = stmt
        .query(params![path_s])
        .map_err(|e| format!("아카이브 분 호가 조회 실행 실패({path_s}): {e}"))?;

    let mut by_minute: BTreeMap<u16, ArchiveMinuteAcc> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(|e| format!("아카이브 분 호가 행 읽기 실패({path_s}): {e}"))? {
        let minute_raw = row.get::<_, i32>(0).map_err(|e| format!("minute 읽기 실패({path_s}): {e}"))?;
        let Ok(minute) = u16::try_from(minute_raw) else { continue };
        let sec = row.get::<_, i32>(1).map_err(|e| format!("sec 읽기 실패({path_s}): {e}"))?.max(0) as u32;
        let rn_close = row.get::<_, i64>(2).map_err(|e| format!("rn_close 읽기 실패({path_s}): {e}"))?;
        let rn_peak = row.get::<_, i64>(3).map_err(|e| format!("rn_peak 읽기 실패({path_s}): {e}"))?;
        let ask_cnt = row.get::<_, i64>(4).map_err(|e| format!("ask_cnt 읽기 실패({path_s}): {e}"))?;
        let bid_cnt = row.get::<_, i64>(5).map_err(|e| format!("bid_cnt 읽기 실패({path_s}): {e}"))?;
        let level_total = row.get::<_, i64>(6).map_err(|e| format!("level_total 읽기 실패({path_s}): {e}"))?;
        let single_price = ask_cnt <= 3 && bid_cnt <= 3;

        let mut asks = Vec::with_capacity(10);
        for level in 0..10 {
            let price = row.get::<_, Option<i64>>(7 + level * 2).map_err(|e| format!("ask_p 읽기 실패({path_s}): {e}"))?.unwrap_or(0).abs();
            let qty = row.get::<_, Option<i64>>(8 + level * 2).map_err(|e| format!("ask_q 읽기 실패({path_s}): {e}"))?.unwrap_or(0).max(0);
            if price > 0 && qty > 0 {
                asks.push(LevelQty(price, qty));
            }
        }
        asks.sort_unstable_by_key(|level| level.0);

        let mut bids = Vec::with_capacity(10);
        for level in 0..10 {
            let price = row.get::<_, Option<i64>>(27 + level * 2).map_err(|e| format!("bid_p 읽기 실패({path_s}): {e}"))?.unwrap_or(0).abs();
            let qty = row.get::<_, Option<i64>>(28 + level * 2).map_err(|e| format!("bid_q 읽기 실패({path_s}): {e}"))?.unwrap_or(0).max(0);
            if price > 0 && qty > 0 {
                bids.push(LevelQty(price, qty));
            }
        }
        bids.sort_unstable_by_key(|level| Reverse(level.0));

        let ladder = Ladder { asks, bids };
        let entry = by_minute.entry(minute).or_insert_with(|| ArchiveMinuteAcc {
            close_sec: sec,
            single_price,
            close: Ladder::default(),
            peak: Ladder::default(),
        });
        if rn_close == 1 {
            entry.close_sec = sec;
            entry.single_price = single_price;
            entry.close = ladder.clone();
        }
        if rn_peak == 1 && !single_price && level_total > 0 {
            entry.peak = ladder;
        }
    }

    if by_minute.is_empty() {
        return Ok(None);
    }

    let mut minutes = Vec::with_capacity(by_minute.len());
    let mut last_minute = 0u16;
    for (minute, acc) in by_minute {
        last_minute = minute;
        let price_max = merge_price_max_ladders(
            if acc.single_price { None } else { Some(&acc.close) },
            (!acc.peak.is_empty()).then_some(&acc.peak),
        );
        minutes.push(QuoteMinute {
            minute,
            close_sec: acc.close_sec,
            single_price: acc.single_price,
            combined: VenueQuote { close: acc.close, peak: acc.peak, price_max },
            krx: VenueQuote::default(),
            nxt: VenueQuote::default(),
        });
    }

    let mut gaps = Vec::new();
    let after_last = (u32::from(last_minute) + 1) * 60;
    if after_last < SESSION_CLOSE_SEC {
        gaps.push((after_last, SESSION_CLOSE_SEC));
    }

    Ok(Some(QuoteDay { closed: true, minutes, gaps }))
}

fn merge_price_max_ladders(first: Option<&Ladder>, second: Option<&Ladder>) -> Ladder {
    let mut asks = BTreeMap::<i64, i64>::new();
    let mut bids = BTreeMap::<i64, i64>::new();
    for ladder in [first, second].into_iter().flatten() {
        for &LevelQty(price, qty) in &ladder.asks {
            let entry = asks.entry(price).or_insert(0);
            if qty > *entry {
                *entry = qty;
            }
        }
        for &LevelQty(price, qty) in &ladder.bids {
            let entry = bids.entry(price).or_insert(0);
            if qty > *entry {
                *entry = qty;
            }
        }
    }
    Ladder {
        asks: asks.into_iter().map(|(price, qty)| LevelQty(price, qty)).collect(),
        bids: bids.into_iter().rev().map(|(price, qty)| LevelQty(price, qty)).collect(),
    }
}

fn clamp_i32(value: i64) -> i64 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_hogaplay_fixture(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("meta.json"), r#"{"code":"005930","date":"20240827","prev_close":76000}"#).unwrap();
        let conn = open_connection().unwrap();
        let mut book_rows = Vec::new();
        for (ts_ms, seq, ask1, bid1, qty) in [
            (90050100i64, 1i32, 76100i32, 76000i32, 100i64),
            (90501250i64, 2i32, 76200i32, 76100i32, 250i64),
            (90501500i64, 3i32, 76300i32, 76200i32, 180i64),
        ] {
            let mut cols = vec![format!("{ts_ms}::BIGINT AS ts_ms"), format!("{seq}::INTEGER AS seq")];
            for level in 1..=10 {
                let p = if level <= 4 { ask1 + (level - 1) * 100 } else { 0 };
                cols.push(format!("{p}::INTEGER AS ask_p{level}"));
            }
            for level in 1..=10 {
                let q = if level <= 4 { qty } else { 0 };
                cols.push(format!("{q}::BIGINT AS ask_q{level}"));
            }
            for level in 1..=10 {
                let p = if level <= 4 { bid1 - (level - 1) * 100 } else { 0 };
                cols.push(format!("{p}::INTEGER AS bid_p{level}"));
            }
            for level in 1..=10 {
                let q = if level <= 4 { qty } else { 0 };
                cols.push(format!("{q}::BIGINT AS bid_q{level}"));
            }
            cols.push(format!("{}::BIGINT AS tot_ask", qty * 4));
            cols.push(format!("{}::BIGINT AS tot_bid", qty * 4));
            book_rows.push(format!("SELECT {}", cols.join(", ")));
        }
        conn.execute_batch(&format!(
            "SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)",
            book_rows.join(" UNION ALL "),
            dir.join("snapshots.parquet").display()
        ))
        .unwrap();

        conn.execute_batch(&format!(
            "SET threads = 1; COPY (
                SELECT 90030000::BIGINT AS ts_ms, 1::INTEGER AS seq, 76100::INTEGER AS price, 100::INTEGER AS qty, 1::TINYINT AS side
                UNION ALL
                SELECT 90501200::BIGINT, 2::INTEGER, 76200::INTEGER, 50::INTEGER, 1::TINYINT
                UNION ALL
                SELECT 90501450::BIGINT, 3::INTEGER, 76100::INTEGER, 30::INTEGER, -1::TINYINT
                UNION ALL
                SELECT 90502000::BIGINT, 4::INTEGER, 0::INTEGER, 0::INTEGER, 0::TINYINT
            ) TO '{}' (FORMAT parquet)",
            dir.join("trades.parquet").display()
        ))
        .unwrap();
    }

    #[test]
    fn reads_meta_span_day_and_ticks_from_hogaplay_fixture() {
        let tmp = tempfile::tempdir().unwrap();
        let hp = tmp.path().join("20240827").join("005930").join("hogaplay");
        write_hogaplay_fixture(&hp);
        let stock = StockCode::parse("005930").unwrap();
        let date = KstDate::new(2024, 8, 27).unwrap();

        let meta = read_day_meta(&hp, "20240827", stock).unwrap();
        assert_eq!(meta.venue_scope, Some(api::ReplayVenueScope::KrxArchive));
        assert_eq!(meta.previous_close, Some(76_000));
        assert_eq!(meta.spans.len(), 2);
        assert_eq!(meta.spans[0].start_minute, 540);
        assert_eq!(meta.spans[1].start_minute, 545);
        assert_eq!(meta.spans[1].book_rows, 2);
        assert_eq!(meta.spans[1].trade_rows, 2);

        let span = read_span(&hp, 20240827, "005930", 545).unwrap();
        let encoded = hoga_format::encode(&span).unwrap();
        let decoded = hoga_format::decode(&encoded).unwrap();
        let books = decoded.stream(StreamKind::Book).unwrap();
        assert_eq!(books.rows(), 3);
        assert_eq!(books.column("recv_ms").unwrap()[0], 540 * 60_000 + 50_100);
        assert_eq!(books.column("ask_px1").unwrap()[0], 76_100);
        assert_eq!(books.column("ask_px1").unwrap()[2], 76_300);

        let trades = decoded.stream(StreamKind::Trades).unwrap();
        assert_eq!(trades.rows(), 2);
        assert_eq!(trades.column("qty").unwrap(), &[50, -30]);
        assert_eq!(trades.column("venue").unwrap(), &[1, 1]);

        let day = read_day_data(&hp).unwrap();
        assert_eq!(day.previous_close, Some(76_000));
        assert_eq!(day.covered, vec![[540, 545]]);
        assert_eq!(day.books.len(), 2);
        assert_eq!(day.trades.len(), 3);

        let ticks = read_trade_ticks(&hp, date).unwrap();
        assert_eq!(ticks.len(), 3);
        assert_eq!(ticks[0].exchange, Some(Exchange::Krx));
        assert_eq!(ticks[0].side, Some(TradeSide::Buy));
        assert_eq!(ticks[2].side, Some(TradeSide::Sell));

        let quote_day = read_quote_day(&hp).unwrap().unwrap();
        assert!(quote_day.closed);
        assert_eq!(quote_day.minutes.len(), 2);
        assert_eq!(quote_day.minutes[0].minute, 540);
        assert!(!quote_day.minutes[0].single_price);
        assert_eq!(quote_day.minutes[0].combined.close.ask_total(), 400);
        assert_eq!(quote_day.minutes[0].combined.close.bid_total(), 400);
        assert!(quote_day.minutes[0].krx.close.is_empty());
        assert!(quote_day.minutes[0].nxt.close.is_empty());
        assert_eq!(quote_day.minutes[1].minute, 545);
        assert_eq!(quote_day.minutes[1].combined.close.ask_total(), 720);
        assert_eq!(quote_day.minutes[1].combined.peak.ask_total(), 1_000);
        assert_eq!(quote_day.gaps, vec![(546 * 60, 20 * 3600)]);
    }
}
