use crate::store::Store;
use setup::{ACCOUNT_LIMIT, Document, ShapeError};
use sqlx::{Row, sqlite::SqliteRow};

pub struct Checked {
    pub document: Document,
    pub body: Option<String>,
    pub size: usize,
}

impl Checked {
    pub fn parse(raw: serde_json::Value) -> Result<Self, String> {
        let document: Document = serde_json::from_value(raw).map_err(|error| format!("문서 모양이 맞지 않습니다: {error}"))?;
        let size = document.check().map_err(|error| error.to_string())?;
        let body = document.body.as_ref().map(serde_json::Value::to_string);
        Ok(Self { document, body, size })
    }
}

pub enum Outcome {
    Accepted { seq: i64 },
    Stale(Document),
    Rejected(String),
}

pub struct Pushed {
    pub outcomes: Vec<Outcome>,
    pub seq: i64,
    pub accepted_bytes: usize,
}

pub struct Changes {
    pub documents: Vec<Document>,
    pub seq: i64,
    pub more: bool,
}

pub struct Summary {
    pub documents: i64,
    pub bytes: i64,
    pub seq: i64,
}

struct Stored {
    revision: i64,
    size: i64,
}

fn document_from(row: &SqliteRow) -> Result<Document, sqlx::Error> {
    let kind: String = row.get("kind");
    let body: Option<String> = row.get("body");
    let decode = |error: serde_json::Error| sqlx::Error::Decode(Box::new(error));
    Ok(Document {
        kind: serde_json::from_value(serde_json::Value::String(kind)).map_err(decode)?,
        id: row.get("id"),
        revision: row.get("revision"),
        deleted: row.get::<i64, _>("deleted") == 1,
        body: body.map(|text| serde_json::from_str(&text)).transpose().map_err(decode)?,
    })
}

impl Store {
    pub async fn push_documents(&self, account_id: &str, documents: &[&Checked]) -> Result<Pushed, sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("INSERT INTO setup_accounts (account_id) VALUES (?) ON CONFLICT DO NOTHING")
            .bind(account_id)
            .execute(&mut *transaction)
            .await?;
        let counters = sqlx::query("SELECT seq, bytes FROM setup_accounts WHERE account_id = ?")
            .bind(account_id)
            .fetch_one(&mut *transaction)
            .await?;
        let mut seq: i64 = counters.get("seq");
        let mut bytes: i64 = counters.get("bytes");
        let mut outcomes = Vec::with_capacity(documents.len());
        let mut accepted_bytes = 0;
        for checked in documents {
            let Document { kind, id, revision, deleted, .. } = &checked.document;
            let stored = sqlx::query("SELECT revision, size FROM setup_documents WHERE account_id = ? AND kind = ? AND id = ?")
                .bind(account_id)
                .bind(kind.wire_name())
                .bind(id)
                .fetch_optional(&mut *transaction)
                .await?
                .map(|row| Stored { revision: row.get("revision"), size: row.get("size") });
            if let Some(stored) = &stored
                && *revision <= stored.revision
            {
                let row = sqlx::query("SELECT kind, id, revision, deleted, body FROM setup_documents WHERE account_id = ? AND kind = ? AND id = ?")
                    .bind(account_id)
                    .bind(kind.wire_name())
                    .bind(id)
                    .fetch_one(&mut *transaction)
                    .await?;
                outcomes.push(Outcome::Stale(document_from(&row)?));
                continue;
            }
            let size = checked.size as i64;
            let previous_size = stored.map_or(0, |stored| stored.size);
            let total_after = bytes - previous_size + size;
            if size > previous_size && total_after > ACCOUNT_LIMIT as i64 {
                outcomes.push(Outcome::Rejected(ShapeError::AccountTooLarge { size: total_after as usize }.to_string()));
                continue;
            }
            seq += 1;
            bytes = total_after;
            accepted_bytes += checked.size;
            sqlx::query(
                "INSERT INTO setup_documents (account_id, kind, id, revision, deleted, body, size, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (account_id, kind, id) DO UPDATE SET revision = excluded.revision, deleted = excluded.deleted, body = excluded.body, size = excluded.size, seq = excluded.seq",
            )
            .bind(account_id)
            .bind(kind.wire_name())
            .bind(id)
            .bind(revision)
            .bind(i64::from(*deleted))
            .bind(&checked.body)
            .bind(size)
            .bind(seq)
            .execute(&mut *transaction)
            .await?;
            outcomes.push(Outcome::Accepted { seq });
        }
        sqlx::query("UPDATE setup_accounts SET seq = ?, bytes = ? WHERE account_id = ?")
            .bind(seq)
            .bind(bytes)
            .bind(account_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(Pushed { outcomes, seq, accepted_bytes })
    }

    pub async fn setup_changes(&self, account_id: &str, since: i64, limit: i64, byte_budget: i64) -> Result<Changes, sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        let latest: i64 = sqlx::query_scalar("SELECT COALESCE((SELECT seq FROM setup_accounts WHERE account_id = ?), 0)")
            .bind(account_id)
            .fetch_one(&mut *transaction)
            .await?;
        let rows = sqlx::query(
            "SELECT d.kind, d.id, d.revision, d.deleted, d.body, d.seq
             FROM (SELECT seq, SUM(size) OVER (ORDER BY seq) - size AS bytes_before FROM setup_documents WHERE account_id = ? AND seq > ?) AS w
             JOIN setup_documents d ON d.account_id = ? AND d.seq = w.seq
             WHERE w.bytes_before < ?
             ORDER BY d.seq
             LIMIT ?",
        )
        .bind(account_id)
        .bind(since)
        .bind(account_id)
        .bind(byte_budget)
        .bind(limit)
        .fetch_all(&mut *transaction)
        .await?;
        transaction.commit().await?;
        let documents = rows.iter().map(document_from).collect::<Result<Vec<_>, _>>()?;
        let last_seq = rows.last().map(|row| row.get::<i64, _>("seq"));
        let more = last_seq.is_some_and(|last| last < latest);
        Ok(Changes { documents, seq: last_seq.unwrap_or(latest), more })
    }

    pub async fn setup_summary(&self, account_id: &str) -> Result<Summary, sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        let documents: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM setup_documents WHERE account_id = ? AND deleted = 0")
            .bind(account_id)
            .fetch_one(&mut *transaction)
            .await?;
        let counters = sqlx::query("SELECT seq, bytes FROM setup_accounts WHERE account_id = ?")
            .bind(account_id)
            .fetch_optional(&mut *transaction)
            .await?;
        transaction.commit().await?;
        let (seq, bytes) = counters.map_or((0, 0), |row| (row.get("seq"), row.get("bytes")));
        Ok(Summary { documents, bytes, seq })
    }
}
