use crate::store::Store;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use setup::{ACCOUNT_LIMIT, Document, DocumentKind, ShapeError};
use sqlx::{Row, sqlite::SqliteRow};

pub const MAX_REVISION_LEAD_MILLIS: i64 = 24 * 60 * 60 * 1000;

#[derive(Serialize, Deserialize)]
pub struct SetupDocument {
    pub kind: DocumentKind,
    pub id: String,
    pub revision: i64,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Box<RawValue>>,
}

impl SetupDocument {
    fn check(&self, latest_revision: i64) -> Result<usize, String> {
        let Self { kind, id, revision, deleted, body } = self;
        let shape = Document { kind: *kind, id: id.clone(), revision: *revision, deleted: *deleted, body: body.as_ref().map(|_| serde_json::Value::Null) };
        shape.check().map_err(|error| error.to_string())?;
        if *revision > latest_revision {
            return Err(format!("문서 {} {id:?}: revision {revision}이 서버 시각보다 24시간 넘게 앞섭니다(허용 상한 {latest_revision})", kind.wire_name()));
        }
        let size = body.as_ref().map_or(0, |body| body.get().len());
        if size > kind.document_limit() {
            return Err(ShapeError::BodyTooLarge { kind: *kind, id: id.clone(), size }.to_string());
        }
        Ok(size)
    }
}

pub struct Checked {
    pub document: SetupDocument,
    pub size: usize,
}

impl Checked {
    pub fn parse(raw: &RawValue, now_millis: i64) -> Result<Self, String> {
        let document: SetupDocument = serde_json::from_str(raw.get()).map_err(|error| format!("문서 모양이 맞지 않습니다: {error}"))?;
        let size = document.check(now_millis.saturating_add(MAX_REVISION_LEAD_MILLIS))?;
        Ok(Self { document, size })
    }
}

pub enum Outcome {
    Accepted { seq: i64 },
    Stale(SetupDocument),
    Rejected(String),
}

pub struct Pushed {
    pub outcomes: Vec<Outcome>,
    pub seq: i64,
    pub accepted_bytes: usize,
}

pub struct Changes {
    pub documents: Vec<SetupDocument>,
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

fn document_from(row: &SqliteRow) -> Result<SetupDocument, sqlx::Error> {
    let kind: String = row.get("kind");
    let body: Option<String> = row.get("body");
    let decode = |error: serde_json::Error| sqlx::Error::Decode(Box::new(error));
    Ok(SetupDocument {
        kind: serde_json::from_value(serde_json::Value::String(kind)).map_err(decode)?,
        id: row.get("id"),
        revision: row.get("revision"),
        deleted: row.get::<i64, _>("deleted") == 1,
        body: body.map(RawValue::from_string).transpose().map_err(decode)?,
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
            let SetupDocument { kind, id, revision, deleted, body } = &checked.document;
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
            .bind(body.as_deref().map(RawValue::get))
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
             FROM (SELECT seq, SUM(size) OVER (ORDER BY seq) AS running FROM setup_documents WHERE account_id = ? AND seq > ?) AS w
             JOIN setup_documents d ON d.account_id = ? AND d.seq = w.seq
             WHERE w.running <= ?
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
