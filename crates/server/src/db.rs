//! 사용자 자료 SQLite 연결(backend.md §7.1, ADR 0006).

use std::fmt;
use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, Transaction};

const READ_POOL: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct DbError(pub String);

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DbError {}

impl From<sqlx::Error> for DbError {
    fn from(e: sqlx::Error) -> Self {
        DbError(e.to_string())
    }
}

#[derive(Clone)]
pub struct AppDb {
    /// 읽기 풀. 크기 4.
    read: SqlitePool,
    /// 쓰기 풀. 크기 1. 모든 쓰기가 이 연결 하나로 줄 선다.
    write: SqlitePool,
}

impl AppDb {
    /// 파일과 상위 디렉터리가 없으면 만든다. 열고 나서 마이그레이션을 돌린다.
    pub async fn open(path: &Path) -> Result<AppDb, DbError> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| DbError(format!("{}를 만들 수 없습니다: {e}", dir.display())))?;
        }
        AppDb::connect(SqliteConnectOptions::new().filename(path).create_if_missing(true)).await
    }

    /// 연결마다 WAL, foreign_keys, busy_timeout, synchronous를 건다.
    pub async fn connect(options: SqliteConnectOptions) -> Result<AppDb, DbError> {
        let options = options
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(BUSY_TIMEOUT)
            .synchronous(SqliteSynchronous::Normal);
        let write = SqlitePoolOptions::new().max_connections(1).connect_with(options.clone()).await?;
        sqlx::migrate!("./migrations").run(&write).await.map_err(|e| DbError(format!("마이그레이션 실패: {e}")))?;
        let read = SqlitePoolOptions::new().max_connections(READ_POOL).connect_with(options.read_only(true)).await?;
        Ok(AppDb { read, write })
    }

    pub fn read(&self) -> &SqlitePool {
        &self.read
    }

    /// 쓰기 트랜잭션. `BEGIN IMMEDIATE`로 쓰기 잠금을 먼저 잡는다.
    pub async fn begin_write(&self) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
        self.write.begin_with("BEGIN IMMEDIATE").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_creates_the_directory_and_sets_pragmas_on_every_connection() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested/dir/vally.db");
        let db = AppDb::open(&path).await.unwrap();
        assert!(path.exists());
        for pool in [&db.read, &db.write] {
            let mode: String = sqlx::query_scalar("PRAGMA journal_mode").fetch_one(pool).await.unwrap();
            let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(pool).await.unwrap();
            let busy: i64 = sqlx::query_scalar("PRAGMA busy_timeout").fetch_one(pool).await.unwrap();
            let sync: i64 = sqlx::query_scalar("PRAGMA synchronous").fetch_one(pool).await.unwrap();
            assert_eq!((mode.as_str(), fk, busy, sync), ("wal", 1, 5000, 1));
        }
        let layouts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layouts").fetch_one(db.read()).await.unwrap();
        assert_eq!(layouts, 1, "첫 마이그레이션의 기본 레이아웃");
        drop(db);
        AppDb::open(&path).await.expect("다시 열어도 마이그레이션이 겹치지 않는다");
    }
}
