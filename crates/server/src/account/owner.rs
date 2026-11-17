use sqlx::{Sqlite, Transaction};

use crate::db::AppDb;

pub async fn get(db: &AppDb) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT account_id FROM local_owner WHERE singleton = 1").fetch_optional(db.read()).await
}

pub async fn set_if_none(db: &AppDb, account_id: &str) -> Result<(), sqlx::Error> {
    let mut tx = db.begin_write().await?;
    sqlx::query("INSERT OR IGNORE INTO local_owner (singleton, account_id) VALUES (1, ?)").bind(account_id).execute(&mut *tx).await?;
    tx.commit().await
}

pub async fn set_in(tx: &mut Transaction<'_, Sqlite>, account_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO local_owner (singleton, account_id) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET account_id = excluded.account_id").bind(account_id).execute(&mut **tx).await?;
    Ok(())
}

pub async fn clear(db: &AppDb) -> Result<(), sqlx::Error> {
    let mut tx = db.begin_write().await?;
    sqlx::query("DELETE FROM local_owner").execute(&mut *tx).await?;
    tx.commit().await
}
