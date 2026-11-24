use std::io::ErrorKind;
use std::path::Path;

use domain::KstDate;
use duckdb::{Config, Connection, params};

use crate::api;
use crate::clock::kst;

use super::day_index::StockCoverage;

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;
const DUCKDB_THREADS: usize = 4;

const BOOK_QUERY: &str = "
WITH picked AS (
    SELECT
        CAST((recv_ms - $2) // 60000 AS INTEGER) AS minute,
        max(struct_pack(r := recv_ms, n := file_row_number)).n AS row_num
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $3 AND recv_ms >= $2 AND recv_ms < $4
    GROUP BY 1
)
SELECT
    p.minute,
    r.f41, r.f61, r.f42, r.f62, r.f43, r.f63, r.f44, r.f64, r.f45, r.f65,
    r.f46, r.f66, r.f47, r.f67, r.f48, r.f68, r.f49, r.f69, r.f50, r.f70,
    r.f51, r.f71, r.f52, r.f72, r.f53, r.f73, r.f54, r.f74, r.f55, r.f75,
    r.f56, r.f76, r.f57, r.f77, r.f58, r.f78, r.f59, r.f79, r.f60, r.f80,
    r.f121, r.f125
FROM read_parquet($1, file_row_number = true) r
JOIN picked p ON r.file_row_number = p.row_num
ORDER BY p.minute ASC
";

const TRADE_QUERY: &str = "
WITH per_min AS (
    SELECT
        CAST((recv_ms - $2) // 60000 AS INTEGER) AS minute,
        max(struct_pack(r := recv_ms, n := file_row_number, f20 := f20, f10 := f10, f15 := f15), 10) AS top
    FROM read_parquet($1, file_row_number = true)
    WHERE symbol = $3
      AND recv_ms >= $2
      AND recv_ms < $4
      AND f15 IS NOT NULL
      AND f15 != 0
      AND f10 IS NOT NULL
    GROUP BY 1
),
flat AS (
    SELECT minute, unnest(top) AS item
    FROM per_min
)
SELECT minute, item.f20, item.f10, item.f15, item.r
FROM flat
ORDER BY minute ASC, item.r ASC, item.n ASC
";

pub(super) struct DayReplayData {
    pub covered: Vec<[u32; 2]>,
    pub books: Vec<api::BookReplayBook>,
    pub trades: Vec<(u32, u32, u64, i64)>,
}

pub(super) fn fnv1a_bucket(symbol: &str, buckets: u64) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in symbol.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash % buckets
}

pub(super) fn bucket_file_name(symbol: &str, buckets: u64) -> String {
    format!("{:03}.parquet", fnv1a_bucket(symbol, buckets))
}

pub(super) fn read_day_data(day_dir: &Path, date: KstDate, stock_code: &str, buckets: u64, coverage: &StockCoverage) -> Result<DayReplayData, String> {
    let symbol = format!("{stock_code}_AL");
    let bucket_file = bucket_file_name(&symbol, buckets);
    let book_path = day_dir.join("0D").join(&bucket_file);
    let trade_path = day_dir.join("0B").join(&bucket_file);
    let has_books = file_exists(&book_path)?;
    let has_trades = file_exists(&trade_path)?;
    if !has_books && !has_trades {
        return Ok(DayReplayData { covered: Vec::new(), books: Vec::new(), trades: Vec::new() });
    }
    let conn = open_connection()?;
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let day_end_ms = day_start_ms + 86_400_000;
    let books = if has_books { query_books(&conn, &book_path, &symbol, day_start_ms, day_end_ms)? } else { Vec::new() };
    let trades = if has_trades { query_trades(&conn, &trade_path, &symbol, day_start_ms, day_end_ms)? } else { Vec::new() };
    let covered = compute_covered(day_start_ms, books.first().map(|b| b.minute), coverage.end_minute_exclusive, &coverage.gaps);
    Ok(DayReplayData { covered, books, trades })
}

fn open_connection() -> Result<Connection, String> {
    let config = Config::default().enable_autoload_extension(false).map_err(|e| format!("DuckDB 설정 실패: {e}"))?;
    let conn = Connection::open_in_memory_with_flags(config).map_err(|e| format!("DuckDB 연결 실패: {e}"))?;
    conn.execute_batch(&format!("SET threads = {DUCKDB_THREADS};")).map_err(|e| format!("DuckDB 스레드 설정 실패: {e}"))?;
    Ok(conn)
}

fn file_exists(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}를 확인할 수 없습니다: {e}", path.display())),
    }
}

fn path_str(path: &Path) -> Result<&str, String> {
    path.to_str().ok_or_else(|| format!("UTF-8 경로가 아닙니다: {}", path.display()))
}

fn query_books(conn: &Connection, path: &Path, symbol: &str, day_start_ms: i64, day_end_ms: i64) -> Result<Vec<api::BookReplayBook>, String> {
    let path_str = path_str(path)?;
    let mut stmt = conn.prepare(BOOK_QUERY).map_err(|e| format!("호가 조회 준비 실패({path_str}): {e}"))?;
    let rows = stmt
        .query_map(params![path_str, day_start_ms, symbol, day_end_ms], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let mut asks = Vec::with_capacity(10);
            for level in 0..10 {
                let price = row.get::<_, Option<i64>>(1 + level * 2)?.unwrap_or(0).unsigned_abs();
                if price > 0 {
                    let qty = non_negative_u64(row.get::<_, Option<i64>>(2 + level * 2)?);
                    asks.push([price, qty]);
                }
            }
            let mut bids = Vec::with_capacity(10);
            for level in 0..10 {
                let price = row.get::<_, Option<i64>>(21 + level * 2)?.unwrap_or(0).unsigned_abs();
                if price > 0 {
                    let qty = non_negative_u64(row.get::<_, Option<i64>>(22 + level * 2)?);
                    bids.push([price, qty]);
                }
            }
            let total_ask = non_negative_u64(row.get::<_, Option<i64>>(41)?);
            let total_bid = non_negative_u64(row.get::<_, Option<i64>>(42)?);
            Ok(api::BookReplayBook { minute, asks, bids, total_ask, total_bid })
        })
        .map_err(|e| format!("호가 조회 실행 실패({path_str}): {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("호가 행 읽기 실패({path_str}): {e}"))
}

fn query_trades(conn: &Connection, path: &Path, symbol: &str, day_start_ms: i64, day_end_ms: i64) -> Result<Vec<(u32, u32, u64, i64)>, String> {
    let path_str = path_str(path)?;
    let mut stmt = conn.prepare(TRADE_QUERY).map_err(|e| format!("체결 조회 준비 실패({path_str}): {e}"))?;
    let rows = stmt
        .query_map(params![path_str, day_start_ms, symbol, day_end_ms], |row| {
            let minute = row.get::<_, i32>(0)? as u32;
            let time_text = row.get::<_, Option<String>>(1)?;
            let price = row.get::<_, i64>(2)?.unsigned_abs();
            let quantity = row.get::<_, i64>(3)?;
            let recv_ms = row.get::<_, i64>(4)?;
            let time_sec = parse_hhmmss(time_text.as_deref(), recv_ms, day_start_ms);
            Ok((minute, time_sec, price, quantity))
        })
        .map_err(|e| format!("체결 조회 실행 실패({path_str}): {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("체결 행 읽기 실패({path_str}): {e}"))
}

fn non_negative_u64(value: Option<i64>) -> u64 {
    value.unwrap_or(0).max(0) as u64
}

fn parse_hhmmss(raw: Option<&str>, recv_ms: i64, day_start_ms: i64) -> u32 {
    if let Some(text) = raw {
        let bytes = text.trim().as_bytes();
        if bytes.len() == 6 && bytes.iter().all(u8::is_ascii_digit) {
            let hour = u32::from(bytes[0] - b'0') * 10 + u32::from(bytes[1] - b'0');
            let minute = u32::from(bytes[2] - b'0') * 10 + u32::from(bytes[3] - b'0');
            let second = u32::from(bytes[4] - b'0') * 10 + u32::from(bytes[5] - b'0');
            if hour < 24 && minute < 60 && second < 60 {
                return hour * 3600 + minute * 60 + second;
            }
        }
    }
    ((recv_ms - day_start_ms) / 1000).clamp(0, 86_399) as u32
}

pub(super) fn compute_covered(day_start_ms: i64, first_book_minute: Option<u32>, end_minute_exclusive: u32, gaps: &[(i64, i64)]) -> Vec<[u32; 2]> {
    let Some(start) = first_book_minute else { return Vec::new() };
    if start >= end_minute_exclusive {
        return Vec::new();
    }
    let mut ranges: Vec<[u32; 2]> = Vec::new();
    let mut current: Option<[u32; 2]> = None;
    for minute in start..end_minute_exclusive {
        let end_ms = day_start_ms + i64::from(minute + 1) * 60_000;
        let missed = gaps.iter().any(|&(from_ms, to_ms)| end_ms >= from_ms && end_ms < to_ms);
        if missed {
            if let Some(range) = current.take() {
                ranges.push(range);
            }
        } else {
            match &mut current {
                Some(range) => range[1] = minute,
                None => current = Some([minute, minute]),
            }
        }
    }
    if let Some(range) = current {
        ranges.push(range);
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samsung_bucket_is_56() {
        assert_eq!(fnv1a_bucket("005930_AL", 64), 56);
        assert_eq!(bucket_file_name("005930_AL", 64), "056.parquet");
    }

    #[test]
    fn covered_is_empty_without_books() {
        assert!(compute_covered(0, None, 1205, &[]).is_empty());
    }

    #[test]
    #[ignore]
    fn bench_large_stock_210k_books_and_410k_trades() {
        let tmp = tempfile::tempdir().unwrap();
        let day_dir = tmp.path().join("store").join("20261123");
        std::fs::create_dir_all(day_dir.join("0D")).unwrap();
        std::fs::create_dir_all(day_dir.join("0B")).unwrap();
        let date = KstDate::new(2026, 11, 23).unwrap();
        let start_ms = kst(date, 9, 0, 0).unix() * 1000;
        let book_path = day_dir.join("0D").join("056.parquet");
        let trade_path = day_dir.join("0B").join("056.parquet");
        let conn = open_connection().unwrap();
        conn.execute_batch(&format!(
            "COPY (
                SELECT
                    '005930_AL' AS symbol,
                    {start_ms} + (i * 100) AS recv_ms,
                    '090000' AS f21,
                    -(71000 + (i % 10) * 100) AS f41, 100 + (i % 50) AS f61,
                    -(71100 + (i % 10) * 100) AS f42, 110 + (i % 50) AS f62,
                    -(71200 + (i % 10) * 100) AS f43, 120 + (i % 50) AS f63,
                    -(71300 + (i % 10) * 100) AS f44, 130 + (i % 50) AS f64,
                    -(71400 + (i % 10) * 100) AS f45, 140 + (i % 50) AS f65,
                    -(71500 + (i % 10) * 100) AS f46, 150 + (i % 50) AS f66,
                    -(71600 + (i % 10) * 100) AS f47, 160 + (i % 50) AS f67,
                    -(71700 + (i % 10) * 100) AS f48, 170 + (i % 50) AS f68,
                    -(71800 + (i % 10) * 100) AS f49, 180 + (i % 50) AS f69,
                    -(71900 + (i % 10) * 100) AS f50, 190 + (i % 50) AS f70,
                    -(70900 + (i % 10) * 100) AS f51, 200 + (i % 50) AS f71,
                    -(70800 + (i % 10) * 100) AS f52, 210 + (i % 50) AS f72,
                    -(70700 + (i % 10) * 100) AS f53, 220 + (i % 50) AS f73,
                    -(70600 + (i % 10) * 100) AS f54, 230 + (i % 50) AS f74,
                    -(70500 + (i % 10) * 100) AS f55, 240 + (i % 50) AS f75,
                    -(70400 + (i % 10) * 100) AS f56, 250 + (i % 50) AS f76,
                    -(70300 + (i % 10) * 100) AS f57, 260 + (i % 50) AS f77,
                    -(70200 + (i % 10) * 100) AS f58, 270 + (i % 50) AS f78,
                    -(70100 + (i % 10) * 100) AS f59, 280 + (i % 50) AS f79,
                    -(70000 + (i % 10) * 100) AS f60, 290 + (i % 50) AS f80,
                    10000::BIGINT AS f121,
                    20000::BIGINT AS f125
                FROM range(210000) t(i)
            ) TO '{}' (FORMAT parquet, CODEC zstd)",
            book_path.display()
        ))
        .unwrap();
        conn.execute_batch(&format!(
            "COPY (
                SELECT
                    '005930_AL' AS symbol,
                    {start_ms} + (i * 50) AS recv_ms,
                    '090001' AS f20,
                    -(71000 + (i % 500)) AS f10,
                    CASE WHEN i % 2 = 0 THEN (i % 100) + 1 ELSE -((i % 100) + 1) END AS f15
                FROM range(410000) t(i)
            ) TO '{}' (FORMAT parquet, CODEC zstd)",
            trade_path.display()
        ))
        .unwrap();
        let coverage = StockCoverage { gaps: Vec::new(), end_minute_exclusive: 1205 };
        let t0 = std::time::Instant::now();
        let data = read_day_data(&day_dir, date, "005930", 64, &coverage).unwrap();
        let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let book_bytes = std::fs::metadata(&book_path).unwrap().len();
        let trade_bytes = std::fs::metadata(&trade_path).unwrap().len();
        println!("bench_large_stock: elapsed_ms={elapsed_ms:.2} books={} trades={} book_bytes={book_bytes} trade_bytes={trade_bytes}", data.books.len(), data.trades.len());
        assert!(!data.books.is_empty());
        assert!(!data.trades.is_empty());
    }
}
