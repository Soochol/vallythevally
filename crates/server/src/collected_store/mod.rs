mod cache;
mod day_index;

use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;

use duckdb::{Config, Connection};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::hoga_archive::HogaArchive;

pub(crate) use cache::StampLru;
pub(crate) use day_index::{DayIndexCache, DayIndexState, FileStamp, StockCoverage, read_path_stamp, read_stamp};

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;
const DUCKDB_THREADS: usize = 4;
const MAX_CONCURRENT_QUERIES: usize = 2;

pub struct CollectedStore {
    day_index: DayIndexCache,
    archive: Arc<HogaArchive>,
    permits: Arc<Semaphore>,
}

impl CollectedStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            day_index: DayIndexCache::new(),
            archive: Arc::new(HogaArchive::new()),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_QUERIES)),
        })
    }

    pub(crate) fn archive(&self) -> &Arc<HogaArchive> {
        &self.archive
    }

    pub(crate) fn available_dates(&self, data_dir: &Path) -> Result<Vec<String>, String> {
        self.day_index.available_dates(data_dir)
    }

    pub(crate) fn collected_days(&self, data_dir: &Path, stock_code: &str) -> Result<Vec<String>, String> {
        self.day_index.collected_days(data_dir, stock_code)
    }

    pub(crate) fn load_day_index(&self, data_dir: &Path, date: &str) -> Result<(Option<FileStamp>, DayIndexState), String> {
        self.day_index.load(data_dir, date)
    }

    pub(crate) async fn acquire_permit(&self) -> Result<OwnedSemaphorePermit, String> {
        self.permits.clone().acquire_owned().await.map_err(|e| e.to_string())
    }
}

pub(crate) fn fnv1a_bucket(symbol: &str, buckets: u64) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in symbol.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash % buckets
}

pub(crate) fn bucket_file_name(symbol: &str, buckets: u64) -> String {
    format!("{:03}.parquet", fnv1a_bucket(symbol, buckets))
}

pub(crate) fn open_connection() -> Result<Connection, String> {
    let config = Config::default().enable_autoload_extension(false).map_err(|e| format!("DuckDB 설정 실패: {e}"))?;
    let conn = Connection::open_in_memory_with_flags(config).map_err(|e| format!("DuckDB 연결 실패: {e}"))?;
    conn.execute_batch(&format!("SET threads = {DUCKDB_THREADS};")).map_err(|e| format!("DuckDB 스레드 설정 실패: {e}"))?;
    Ok(conn)
}

pub(crate) fn file_exists(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}를 확인할 수 없습니다: {e}", path.display())),
    }
}

pub(crate) fn path_str(path: &Path) -> Result<&str, String> {
    path.to_str().ok_or_else(|| format!("UTF-8 경로가 아닙니다: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samsung_bucket_is_56() {
        assert_eq!(fnv1a_bucket("005930_AL", 64), 56);
        assert_eq!(bucket_file_name("005930_AL", 64), "056.parquet");
    }

    #[tokio::test]
    async fn shared_store_caps_total_concurrent_permits_at_two() {
        let store = CollectedStore::new();
        let p1 = store.acquire_permit().await.unwrap();
        let p2 = store.acquire_permit().await.unwrap();
        assert!(store.permits.try_acquire().is_err());
        drop(p1);
        assert!(store.permits.try_acquire().is_ok());
        drop(p2);
    }
}
