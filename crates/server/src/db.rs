//! 사용자 자료 SQLite 연결(backend.md §7.1, ADR 0006).

use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, Transaction};
use tokio::sync::watch;

use crate::api::KiwoomEnvironment;

const READ_POOL: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const HOLDS_USER_DATA: &str = "SELECT
    (SELECT COUNT(*) FROM order_commands) + (SELECT COUNT(*) FROM order_batches) + (SELECT COUNT(*) FROM drawings)
  + (SELECT COUNT(*) FROM watchlist_items) + (SELECT COUNT(*) FROM watch_groups) + (SELECT COUNT(*) FROM watch_group_items)
  + (SELECT COUNT(*) FROM sync_refusals) + (SELECT COUNT(*) FROM local_owner)
  + (SELECT COUNT(*) FROM layouts WHERE revision <> 0) + (SELECT COUNT(*) FROM layouts) - 1
  + (SELECT COUNT(*) FROM ui_state WHERE revision <> 0) + (SELECT COUNT(*) FROM watchlist_revision WHERE revision <> 0)
  + (SELECT COUNT(*) FROM screens WHERE revision <> 0) + (SELECT COUNT(*) FROM watchlists) - 1 > 0";

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
    read: SqlitePool,
    /// 쓰기 풀. 크기 1. 모든 쓰기가 이 연결 하나로 줄 선다.
    write: SqlitePool,
    released: Arc<watch::Sender<u64>>,
}

impl AppDb {
    pub async fn open(path: &Path) -> Result<AppDb, DbError> {
        AppDb::open_in(path, KiwoomEnvironment::Real).await
    }

    pub async fn open_in(path: &Path, environment: KiwoomEnvironment) -> Result<AppDb, DbError> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| DbError(format!("{}를 만들 수 없습니다: {e}", dir.display())))?;
        }
        AppDb::connect_in(SqliteConnectOptions::new().filename(path).create_if_missing(true), environment).await
    }

    pub async fn connect(options: SqliteConnectOptions) -> Result<AppDb, DbError> {
        AppDb::connect_in(options, KiwoomEnvironment::Real).await
    }

    pub async fn connect_in(options: SqliteConnectOptions, environment: KiwoomEnvironment) -> Result<AppDb, DbError> {
        let options = options
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(BUSY_TIMEOUT)
            .synchronous(SqliteSynchronous::Normal);
        let released = Arc::new(watch::channel(0u64).0);
        let on_release = released.clone();
        let write = SqlitePoolOptions::new()
            .max_connections(1)
            .after_release(move |_, _| {
                on_release.send_modify(|count| *count += 1);
                Box::pin(async { Ok(true) })
            })
            .connect_with(options.clone())
            .await?;
        let existed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = '_sqlx_migrations')").fetch_one(&write).await?;
        sqlx::migrate!("./migrations").run(&write).await.map_err(|e| DbError(format!("마이그레이션 실패: {e}")))?;
        let marked_for = if existed && sqlx::query_scalar(HOLDS_USER_DATA).fetch_one(&write).await? { KiwoomEnvironment::Real } else { environment };
        sqlx::query("INSERT OR IGNORE INTO kiwoom_environment (id, environment) VALUES (1, ?)").bind(marked_for.as_str()).execute(&write).await?;
        let stored: String = sqlx::query_scalar("SELECT environment FROM kiwoom_environment WHERE id = 1").fetch_one(&write).await?;
        if stored != environment.as_str() {
            return Err(DbError(format!("이 사용자 자료 DB는 투자구분 {stored}의 것이라 {} 서버로 열 수 없습니다. 투자구분마다 DB 파일을 따로 씁니다", environment.as_str())));
        }
        let read = SqlitePoolOptions::new().max_connections(READ_POOL).connect_with(options.read_only(true)).await?;
        Ok(AppDb { read, write, released })
    }

    pub fn write_releases(&self) -> watch::Receiver<u64> {
        self.released.subscribe()
    }

    pub fn read(&self) -> &SqlitePool {
        &self.read
    }

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

    #[tokio::test]
    async fn a_database_from_the_other_environment_stops_the_start() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vally.db");
        drop(AppDb::open_in(&path, KiwoomEnvironment::Mock).await.unwrap());
        let error = AppDb::open_in(&path, KiwoomEnvironment::Real).await.err().expect("모의 DB를 실전으로 열 수 없다").to_string();
        assert!(error.contains("mock") && error.contains("real"), "{error}");
        AppDb::open_in(&path, KiwoomEnvironment::Mock).await.expect("같은 투자구분은 다시 열린다");

        let real = tmp.path().join("real.db");
        drop(AppDb::open(&real).await.unwrap());
        assert!(AppDb::open_in(&real, KiwoomEnvironment::Mock).await.is_err(), "실전 DB를 모의로 열 수 없다");
    }

    async fn database_from_before_the_mark(path: &Path) {
        drop(AppDb::open(path).await.unwrap());
        let direct = sqlx::SqlitePool::connect_with(SqliteConnectOptions::new().filename(path)).await.unwrap();
        sqlx::query("DROP TABLE kiwoom_environment").execute(&direct).await.unwrap();
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 18").execute(&direct).await.unwrap();
        direct.close().await;
    }

    async fn database_with_user_data_from_before_the_mark(path: &Path) {
        database_from_before_the_mark(path).await;
        let direct = sqlx::SqlitePool::connect_with(SqliteConnectOptions::new().filename(path)).await.unwrap();
        sqlx::query("INSERT INTO watchlist_items (list_id, symbol, position) VALUES ('01900000-0000-7000-8000-000000000002', '005930', 0)").execute(&direct).await.unwrap();
        direct.close().await;
    }

    #[tokio::test]
    async fn a_database_without_the_environment_mark_opens_as_real() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vally.db");
        database_with_user_data_from_before_the_mark(&path).await;
        let db = AppDb::open(&path).await.expect("표시 없는 기존 DB는 실전으로 열린다");
        let marked: String = sqlx::query_scalar("SELECT environment FROM kiwoom_environment").fetch_one(db.read()).await.unwrap();
        assert_eq!(marked, "real");
    }

    #[tokio::test]
    async fn an_interrupted_first_open_without_user_data_takes_the_current_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vally.db");
        database_from_before_the_mark(&path).await;
        let db = AppDb::open_in(&path, KiwoomEnvironment::Mock).await.expect("자료 없는 표시 없는 DB는 지금 투자구분으로 열린다");
        let marked: String = sqlx::query_scalar("SELECT environment FROM kiwoom_environment").fetch_one(db.read()).await.unwrap();
        assert_eq!(marked, "mock");
        drop(db);
        assert!(AppDb::open_in(&path, KiwoomEnvironment::Real).await.is_err(), "표시된 뒤에는 다른 투자구분으로 열리지 않는다");
    }

    #[tokio::test]
    async fn a_migrations_table_alone_does_not_make_a_database_real() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vally.db");
        let direct = sqlx::SqlitePool::connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true)).await.unwrap();
        sqlx::query("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)").execute(&direct).await.unwrap();
        direct.close().await;
        let db = AppDb::open_in(&path, KiwoomEnvironment::Mock).await.expect("빈 마이그레이션 표만 있는 파일은 모의로 열린다");
        let marked: String = sqlx::query_scalar("SELECT environment FROM kiwoom_environment").fetch_one(db.read()).await.unwrap();
        assert_eq!(marked, "mock");
    }

    #[tokio::test]
    async fn every_kind_of_user_data_keeps_a_database_without_the_mark_real() {
        for change in [
            "INSERT INTO watchlist_items (list_id, symbol, position) VALUES ('01900000-0000-7000-8000-000000000002', '005930', 0)",
            "UPDATE layouts SET revision = 1",
            "UPDATE ui_state SET revision = 1",
            "UPDATE screens SET revision = 1",
            "UPDATE watchlist_revision SET revision = 1",
            "INSERT INTO watchlists (id, name, position) VALUES ('x', '둘째', 1)",
            "INSERT INTO layouts (id, name, sync, position, updated_at) VALUES ('y', '둘째', '{}', 1, 0)",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("vally.db");
            drop(AppDb::open(&path).await.unwrap());
            let direct = sqlx::SqlitePool::connect_with(SqliteConnectOptions::new().filename(&path)).await.unwrap();
            sqlx::query(change).execute(&direct).await.unwrap_or_else(|e| panic!("{change}: {e}"));
            sqlx::query("DROP TABLE kiwoom_environment").execute(&direct).await.unwrap();
            sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 18").execute(&direct).await.unwrap();
            direct.close().await;
            assert!(AppDb::open_in(&path, KiwoomEnvironment::Mock).await.is_err(), "{change}");
        }
    }

    #[tokio::test]
    async fn a_database_without_the_environment_mark_does_not_open_as_mock() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vally.db");
        database_with_user_data_from_before_the_mark(&path).await;
        let error = AppDb::open_in(&path, KiwoomEnvironment::Mock).await.err().expect("자료가 있는 표시 없는 DB는 실전이다").to_string();
        assert!(error.contains("real"), "{error}");
    }
}
