use std::path::{Path, PathBuf};

use domain::KstDate;
use duckdb::params;

use crate::collected_store::{bucket_file_name, file_exists, open_connection, path_str};
use crate::clock::kst;

use super::kind::{CollectedKind, FidValues};

pub(super) struct StoreDay<V> {
    pub snapshots: Vec<V>,
    pub gaps: Vec<[i64; 2]>,
}

pub(super) fn read_day<K: CollectedKind>(
    day_dir: &Path,
    date: KstDate,
    stock_code: &str,
    buckets: u64,
    gaps_ms: &[(i64, i64)],
) -> Result<StoreDay<K::View>, String> {
    let symbols = K::store_symbols(stock_code);
    let gaps = gaps_to_seconds(gaps_ms);
    let mut targets: Vec<(String, PathBuf)> = Vec::with_capacity(symbols.len());
    for symbol in symbols {
        let bucket_file = bucket_file_name(&symbol, buckets);
        let path = day_dir.join(K::TYPE_CODE).join(&bucket_file);
        if file_exists(&path)? {
            targets.push((symbol, path));
        }
    }
    if targets.is_empty() {
        return Ok(StoreDay { snapshots: Vec::new(), gaps });
    }
    let conn = open_connection()?;
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let day_end_ms = day_start_ms + 86_400_000;
    let fids = K::fids();
    let plus_fids = K::plus_sign_fids();
    let mut ordered: Vec<(i64, i64, K::View)> = Vec::new();
    let mut skipped: u64 = 0;
    for (symbol, path) in &targets {
        let path_text = path_str(path)?;
        let active_plus: Vec<u32> = plus_fids
            .iter()
            .copied()
            .filter(|fid| parquet_has_column(&conn, path_text, &format!("f{fid}_plus")))
            .collect();
        let sql = build_query(fids, &active_plus);
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("수집 저장소 조회 준비 실패: {e}"))?;
        let mut raw_rows = stmt
            .query(params![path_text, symbol, day_start_ms, day_end_ms])
            .map_err(|e| format!("수집 저장소 조회 실행 실패({path_text}): {e}"))?;
        while let Some(row) = raw_rows.next().map_err(|e| format!("수집 저장소 행 읽기 실패({path_text}): {e}"))? {
            let recv_ms = row.get::<_, i64>(0).map_err(|e| format!("recv_ms 읽기 실패({path_text}): {e}"))?;
            let row_number = row.get::<_, i64>(1).map_err(|e| format!("file_row_number 읽기 실패({path_text}): {e}"))?;
            let mut values = Vec::with_capacity(fids.len());
            for index in 0..fids.len() {
                let value = row.get::<_, Option<String>>(index + 2).map_err(|e| format!("FID 열 읽기 실패({path_text}): {e}"))?;
                values.push(value);
            }
            let fid_values = FidValues::new(fids, &values);
            let Some(view) = K::decode_store(symbol, recv_ms, &fid_values) else {
                skipped += 1;
                continue;
            };
            ordered.push((recv_ms, row_number, view));
        }
    }
    if targets.len() > 1 {
        ordered.sort_by_key(|(recv_ms, row_number, _)| (*recv_ms, *row_number));
    }
    if skipped > 0 {
        tracing::warn!(type_code = K::TYPE_CODE, symbol = %stock_code, skipped, "수집 저장소 행을 읽지 못해 건너뛰었습니다");
    }
    let snapshots = ordered.into_iter().map(|(_, _, view)| view).collect();
    Ok(StoreDay { snapshots, gaps })
}

fn parquet_has_column(conn: &duckdb::Connection, path_text: &str, column: &str) -> bool {
    conn.prepare("SELECT 1 FROM parquet_schema($1) WHERE name = $2 LIMIT 1")
        .and_then(|mut s| s.exists(params![path_text, column]))
        .unwrap_or(false)
}

fn build_query(fids: &[u32], plus_sign_fids: &[u32]) -> String {
    let mut cols = String::from("recv_ms, file_row_number");
    for fid in fids {
        if plus_sign_fids.contains(fid) {
            cols.push_str(&format!(
                ", CASE WHEN f{fid}_plus AND f{fid} IS NOT NULL THEN '+' || CAST(f{fid} AS VARCHAR) ELSE CAST(f{fid} AS VARCHAR) END"
            ));
        } else {
            cols.push_str(&format!(", CAST(f{fid} AS VARCHAR)"));
        }
    }
    format!(
        "SELECT {cols} FROM read_parquet($1, file_row_number = true) WHERE symbol = $2 AND recv_ms >= $3 AND recv_ms < $4 ORDER BY recv_ms ASC, file_row_number ASC"
    )
}

fn gaps_to_seconds(gaps_ms: &[(i64, i64)]) -> Vec<[i64; 2]> {
    let mut intervals: Vec<[i64; 2]> = gaps_ms
        .iter()
        .map(|&(from_ms, to_ms)| [from_ms.div_euclid(1000), to_ms.div_euclid(1000)])
        .filter(|&[from, to]| to > from)
        .collect();
    intervals.sort_unstable();
    let mut merged: Vec<[i64; 2]> = Vec::with_capacity(intervals.len());
    for interval in intervals {
        if let Some(last) = merged.last_mut()
            && interval[0] <= last[1]
        {
            last[1] = last[1].max(interval[1]);
        } else {
            merged.push(interval);
        }
    }
    merged
}
