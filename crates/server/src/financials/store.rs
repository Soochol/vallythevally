use std::path::Path;

use sqlx::{Row, SqlitePool, sqlite::{SqliteConnectOptions, SqlitePoolOptions}};

use super::model::{Collection, Failure, Security};

#[derive(Clone)]
pub struct Store(SqlitePool);

impl Store {
    pub async fn open(path: &Path) -> Result<Self, Failure> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(parent).await.map_err(|_| Failure::Storage)?;
        }
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(SqliteConnectOptions::new().filename(path).create_if_missing(true)).await.map_err(|_| Failure::Storage)?;
        for query in [
            "CREATE TABLE IF NOT EXISTS securities (stock_code TEXT PRIMARY KEY, body TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS companies (corp_code TEXT PRIMARY KEY, body TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS financial_requests (job TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job, request))",
            "CREATE TABLE IF NOT EXISTS financial_update_control (id INTEGER PRIMARY KEY CHECK(id = 1), paused INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS financial_update (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS financial_stop (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)",
        ] {
            sqlx::query(query).execute(&pool).await.map_err(|_| Failure::Storage)?;
        }
        Ok(Self(pool))
    }

    pub async fn security(&self, code: &str) -> Result<Option<Security>, Failure> {
        let row = sqlx::query("SELECT body FROM securities WHERE stock_code = ?").bind(code).fetch_optional(&self.0).await.map_err(|_| Failure::Storage)?;
        row.map(|r| serde_json::from_str(r.get::<&str, _>("body")).map_err(|_| Failure::Storage)).transpose()
    }

    pub async fn save_security(&self, security: &Security) -> Result<(), Failure> {
        let body = serde_json::to_string(security).map_err(|_| Failure::Storage)?;
        sqlx::query("INSERT INTO securities VALUES (?, ?) ON CONFLICT(stock_code) DO UPDATE SET body = excluded.body").bind(&security.stock_code).bind(body).execute(&self.0).await.map_err(|_| Failure::Storage)?;
        Ok(())
    }

    pub async fn collection(&self, corp: &str) -> Result<Collection, Failure> {
        let row = sqlx::query("SELECT body FROM companies WHERE corp_code = ?").bind(corp).fetch_optional(&self.0).await.map_err(|_| Failure::Storage)?;
        row.map(|r| serde_json::from_str(r.get::<&str, _>("body")).map_err(|_| Failure::Storage)).transpose().map(Option::unwrap_or_default)
    }

    pub async fn save(&self, corp: &str, collection: &Collection) -> Result<(), Failure> {
        let body = serde_json::to_string(collection).map_err(|_| Failure::Storage)?;
        sqlx::query("INSERT INTO companies VALUES (?, ?) ON CONFLICT(corp_code) DO UPDATE SET body = excluded.body").bind(corp).bind(body).execute(&self.0).await.map_err(|_| Failure::Storage)?;
        Ok(())
    }

    pub(super) async fn begin_requests(&self, job: &str) -> Result<(), Failure> {
        sqlx::query("DELETE FROM financial_requests WHERE job != ?").bind(job).execute(&self.0).await.map_err(|_| Failure::Storage)?;
        Ok(())
    }

    pub(super) async fn response(&self, job: &str, request: &str) -> Result<Option<String>, Failure> {
        let row = sqlx::query("SELECT body FROM financial_requests WHERE job = ? AND request = ?").bind(job).bind(request).fetch_optional(&self.0).await.map_err(|_| Failure::Storage)?;
        Ok(row.map(|r| r.get("body")))
    }

    pub(super) async fn save_response(&self, job: &str, request: &str, body: String) -> Result<(), Failure> {
        sqlx::query("INSERT INTO financial_requests VALUES (?, ?, ?) ON CONFLICT(job, request) DO UPDATE SET body = excluded.body").bind(job).bind(request).bind(body).execute(&self.0).await.map_err(|_| Failure::Storage)?;
        Ok(())
    }

    pub(super) fn pool(&self) -> &SqlitePool { &self.0 }

    pub(super) async fn confirmed_at(&self, corps: &[&str]) -> Result<Option<i64>, Failure> {
        if corps.is_empty() { return Ok(None); }
        let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT COUNT(*), MIN(json_extract(body, '$.last_checked_at')) FROM companies WHERE json_type(body, '$.last_checked_at') = 'integer' AND corp_code IN (");
        let mut list = query.separated(",");
        for corp in corps { list.push_bind(*corp); }
        list.push_unseparated(")");
        let row = query.build().fetch_one(&self.0).await.map_err(|_| Failure::Storage)?;
        Ok((row.get::<i64, _>(0) == corps.len() as i64).then(|| row.get::<i64, _>(1)))
    }
}
