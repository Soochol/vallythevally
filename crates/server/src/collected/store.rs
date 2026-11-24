use std::path::Path;

use domain::KstDate;
use duckdb::params;

use crate::book_replay::store::{bucket_file_name, file_exists, open_connection, path_str};
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
    let symbol = format!("{stock_code}_AL");
    let bucket_file = bucket_file_name(&symbol, buckets);
    let path = day_dir.join(K::TYPE_CODE).join(&bucket_file);
    let gaps = gaps_to_seconds(gaps_ms);
    if !file_exists(&path)? {
        return Ok(StoreDay { snapshots: Vec::new(), gaps });
    }
    let conn = open_connection()?;
    let day_start_ms = kst(date, 0, 0, 0).unix() * 1000;
    let day_end_ms = day_start_ms + 86_400_000;
    let fids = K::fids();
    let sql = build_query(fids);
    let path_text = path_str(&path)?;
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("수집 저장소 조회 준비 실패({path_text}): {e}"))?;
    let mut raw_rows = stmt
        .query(params![path_text, symbol, day_start_ms, day_end_ms])
        .map_err(|e| format!("수집 저장소 조회 실행 실패({path_text}): {e}"))?;
    let mut snapshots: Vec<K::View> = Vec::new();
    let mut skipped: u64 = 0;
    while let Some(row) = raw_rows.next().map_err(|e| format!("수집 저장소 행 읽기 실패({path_text}): {e}"))? {
        let recv_ms = row.get::<_, i64>(0).map_err(|e| format!("recv_ms 읽기 실패({path_text}): {e}"))?;
        let mut values = Vec::with_capacity(fids.len());
        for index in 0..fids.len() {
            let value = row.get::<_, Option<String>>(index + 1).map_err(|e| format!("FID 열 읽기 실패({path_text}): {e}"))?;
            values.push(value);
        }
        let fid_values = FidValues::new(fids, &values);
        let Some(view) = K::decode(recv_ms, &fid_values) else {
            skipped += 1;
            continue;
        };
        snapshots.push(view);
    }
    if skipped > 0 {
        tracing::warn!(type_code = K::TYPE_CODE, symbol = %stock_code, skipped, "수집 저장소 행을 읽지 못해 건너뛰었습니다");
    }
    Ok(StoreDay { snapshots, gaps })
}

fn build_query(fids: &[u32]) -> String {
    let mut cols = String::from("recv_ms");
    for fid in fids {
        cols.push_str(&format!(", CAST(f{fid} AS VARCHAR)"));
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
