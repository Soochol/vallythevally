use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use domain::{KstDate, StockCode};
use duckdb::{Connection, OptionalExt, params};

use crate::clock::kst;
use crate::collected_store::{FileStamp, bucket_file_name, file_exists, path_str, read_path_stamp};
use crate::shared_data::{DataKind, FlowCursor, SNAPSHOT_EXTENSION, SharedData, SnapshotBody, data_path, flow_folder, read_snapshot};

const SNAPSHOT_CACHE_LIMIT: usize = 4;
const FLOW_EXTENSION: &str = "flow";

const PRICE_MINUS_CHANGE_QUERY: &str = "
SELECT CAST(abs(f10) - f11 AS BIGINT)
FROM read_parquet($1)
WHERE symbol = $2
  AND recv_ms >= $3
  AND recv_ms < $4
  AND f10 IS NOT NULL
  AND f10 != 0
  AND f11 IS NOT NULL
  AND abs(f10) - f11 > 0
LIMIT 1
";

const STOCK_INFO_BASE_QUERY: &str = "
SELECT CAST(abs(f307) AS BIGINT)
FROM read_parquet($1)
WHERE symbol = $2
  AND recv_ms >= $3
  AND recv_ms < $4
  AND f307 IS NOT NULL
  AND f307 != 0
LIMIT 1
";

struct CachedSnapshotBases {
    path: PathBuf,
    stamp: FileStamp,
    bases: Arc<HashMap<String, u64>>,
}

#[derive(Default)]
pub(super) struct SnapshotBaseCache {
    entries: Mutex<Vec<CachedSnapshotBases>>,
}

impl SnapshotBaseCache {
    fn get_or_load(&self, path: &Path, kind: DataKind, date_str: &str) -> Option<Arc<HashMap<String, u64>>> {
        let stamp = read_path_stamp(path).ok().flatten()?;
        {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = entries.iter().find(|entry| entry.path == path && entry.stamp == stamp) {
                return Some(Arc::clone(&entry.bases));
            }
        }
        let loaded = match read_snapshot::<SnapshotBody>(path, kind) {
            Ok(loaded) => loaded,
            Err(reason) => {
                tracing::warn!(path = %path.display(), %reason, "호가 복기 기준가 스냅샷을 읽지 못했습니다");
                return None;
            }
        };
        if loaded.header.observation_date != date_str {
            return None;
        }
        let map: HashMap<String, u64> = loaded
            .body
            .stocks
            .into_iter()
            .filter(|row| row.base_won > 0)
            .map(|row| (row.code, row.base_won))
            .collect();
        let bases = Arc::new(map);
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|entry| entry.path != path);
        if entries.len() >= SNAPSHOT_CACHE_LIMIT {
            entries.remove(0);
        }
        entries.push(CachedSnapshotBases {
            path: path.to_path_buf(),
            stamp,
            bases: Arc::clone(&bases),
        });
        Some(bases)
    }
}

pub(super) fn read_store_previous_close(
    conn: &Connection,
    day_dir: &Path,
    date: KstDate,
    stock_code: &str,
    buckets: u64,
) -> Result<Option<u64>, String> {
    let symbol = format!("{stock_code}_AL");
    let bucket_file = bucket_file_name(&symbol, buckets);
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let day_end_ms = day_start_ms + 86_400_000;

    let trade_path = day_dir.join("0B").join(&bucket_file);
    if let Some(base) = query_price_minus_change(conn, &trade_path, &symbol, day_start_ms, day_end_ms)? {
        return Ok(Some(base));
    }
    let expected_path = day_dir.join("0H").join(&bucket_file);
    if let Some(base) = query_price_minus_change(conn, &expected_path, &symbol, day_start_ms, day_end_ms)? {
        return Ok(Some(base));
    }
    let info_path = day_dir.join("0g").join(&bucket_file);
    query_stock_info_base(conn, &info_path, &symbol, day_start_ms, day_end_ms)
}

fn query_price_minus_change(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    day_end_ms: i64,
) -> Result<Option<u64>, String> {
    if !file_exists(path)? {
        return Ok(None);
    }
    let path_text = path_str(path)?;
    if !parquet_has_columns(conn, path_text, &["f10", "f11"])? {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare(PRICE_MINUS_CHANGE_QUERY)
        .map_err(|e| format!("기준가 조회 준비 실패({path_text}): {e}"))?;
    let value: Option<i64> = stmt
        .query_row(params![path_text, symbol, day_start_ms, day_end_ms], |row| row.get(0))
        .optional()
        .map_err(|e| format!("기준가 조회 실행 실패({path_text}): {e}"))?;
    Ok(value.and_then(|v| u64::try_from(v).ok()).filter(|&v| v > 0))
}

fn query_stock_info_base(
    conn: &Connection,
    path: &Path,
    symbol: &str,
    day_start_ms: i64,
    day_end_ms: i64,
) -> Result<Option<u64>, String> {
    if !file_exists(path)? {
        return Ok(None);
    }
    let path_text = path_str(path)?;
    if !parquet_has_columns(conn, path_text, &["f307"])? {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare(STOCK_INFO_BASE_QUERY)
        .map_err(|e| format!("종목정보 기준가 조회 준비 실패({path_text}): {e}"))?;
    let value: Option<i64> = stmt
        .query_row(params![path_text, symbol, day_start_ms, day_end_ms], |row| row.get(0))
        .optional()
        .map_err(|e| format!("종목정보 기준가 조회 실행 실패({path_text}): {e}"))?;
    Ok(value.and_then(|v| u64::try_from(v).ok()).filter(|&v| v > 0))
}

fn parquet_has_columns(conn: &Connection, path_text: &str, required: &[&str]) -> Result<bool, String> {
    let quoted = path_text.replace('\'', "''");
    let sql = format!("DESCRIBE SELECT * FROM read_parquet('{quoted}')");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Parquet 스키마 조회 준비 실패({path_text}): {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("Parquet 스키마 조회 실행 실패({path_text}): {e}"))?;
    let mut cols = HashSet::new();
    while let Some(row) = rows.next().map_err(|e| format!("Parquet 스키마 행 읽기 실패({path_text}): {e}"))? {
        if let Ok(name) = row.get::<_, String>(0) {
            cols.insert(name);
        }
    }
    Ok(required.iter().all(|name| cols.contains(*name)))
}

pub(super) fn read_live_previous_close(
    shared_dir: &Path,
    shared_data: &SharedData,
    snapshot_cache: &SnapshotBaseCache,
    stock: StockCode,
    date_str: &str,
) -> Option<u64> {
    let code = stock.as_str();
    if let Some(base) = read_expected_flow_previous_close(shared_dir, date_str, code) {
        return Some(base);
    }
    if let Some(base) = snapshot_board_previous_close(shared_data, code, date_str) {
        return Some(base);
    }
    snapshot_file_previous_close(shared_dir, snapshot_cache, code, date_str)
}

fn read_expected_flow_previous_close(shared_dir: &Path, date_str: &str, stock_code: &str) -> Option<u64> {
    let folder = flow_folder(shared_dir, date_str, "0H", stock_code);
    let entries = std::fs::read_dir(&folder).ok()?;
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some(FLOW_EXTENSION))
        .collect();
    paths.sort();

    for path in paths {
        let mut cursor = FlowCursor::new(path);
        let Ok(blocks) = cursor.read_new() else {
            continue;
        };
        for block in blocks {
            let Some(price_slot) = block.description.fids.iter().position(|&fid| fid == 10) else {
                continue;
            };
            let Some(change_slot) = block.description.fids.iter().position(|&fid| fid == 11) else {
                continue;
            };
            for row in &block.rows {
                let Some(price) = row.values.get(price_slot).and_then(|v| v.as_deref()).and_then(parse_positive_won) else {
                    continue;
                };
                let Some(change) = row.values.get(change_slot).and_then(|v| v.as_deref()).and_then(parse_signed_i64) else {
                    continue;
                };
                if let Some(base) = base_from_price_and_change(price, change) {
                    return Some(base);
                }
            }
        }
    }
    None
}

fn snapshot_board_previous_close(shared_data: &SharedData, stock_code: &str, date_str: &str) -> Option<u64> {
    for board in [&shared_data.snapshot_combined, &shared_data.snapshot_krx] {
        let Some(loaded) = board.current() else {
            continue;
        };
        if loaded.header.observation_date != date_str {
            continue;
        }
        if let Some(base) = loaded
            .body
            .stocks
            .iter()
            .find(|row| row.code == stock_code && row.base_won > 0)
            .map(|row| row.base_won)
        {
            return Some(base);
        }
    }
    None
}

fn snapshot_file_previous_close(
    shared_dir: &Path,
    snapshot_cache: &SnapshotBaseCache,
    stock_code: &str,
    date_str: &str,
) -> Option<u64> {
    for kind in [DataKind::SnapshotCombined, DataKind::SnapshotKrx] {
        let path = data_path(shared_dir, kind, date_str, SNAPSHOT_EXTENSION);
        if let Some(bases) = snapshot_cache.get_or_load(&path, kind, date_str)
            && let Some(&base) = bases.get(stock_code)
        {
            return Some(base);
        }
    }
    None
}

fn parse_positive_won(raw: &str) -> Option<u64> {
    let trimmed = raw.trim().trim_start_matches(['+', '-']);
    trimmed.parse::<u64>().ok().filter(|&v| v > 0)
}

fn parse_signed_i64(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

fn base_from_price_and_change(price: u64, change: i64) -> Option<u64> {
    let price_i64 = i64::try_from(price).ok()?;
    let base = price_i64.checked_sub(change)?;
    u64::try_from(base).ok().filter(|&v| v > 0)
}
