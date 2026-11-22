use crate::store::Store;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use setup::{ACCOUNT_LIMIT, Document, DocumentKind, ShapeError};
use sqlx::{Row, sqlite::SqliteRow};

pub const MAX_REVISION_LEAD_MILLIS: i64 = 24 * 60 * 60 * 1000;

const DRAWINGS_OF_SYMBOL: &str = "SELECT kind, id, revision, deleted, body FROM setup_documents
     WHERE account_id = ? AND kind = 'drawing' AND deleted = 0 AND json_extract(body, '$.symbol') = ?
     ORDER BY json_extract(body, '$.z'), id";

const LAYOUT_NAME_TAKEN: &str = "SELECT 1 FROM setup_documents WHERE account_id = ? AND kind = 'layout' AND deleted = 0 AND json_extract(body, '$.name') = ? AND id <> ? LIMIT 1";

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
    pub fn live(kind: DocumentKind, id: &str, revision: i64, body: &serde_json::Value) -> Self {
        let body = RawValue::from_string(body.to_string()).expect("JSON 값은 언제나 JSON 문자열이 된다");
        Self { kind, id: id.to_owned(), revision, deleted: false, body: Some(body) }
    }

    pub fn body_value(&self) -> Option<serde_json::Value> {
        self.body.as_ref().and_then(|body| serde_json::from_str(body.get()).ok())
    }

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

pub struct LayoutHead {
    pub id: String,
    pub name: String,
    pub updated_at: i64,
}

pub enum Removal {
    Removed,
    Missing,
    LastLayout,
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
        let mut transaction = self.begin_account_write().await?;
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
                "INSERT INTO setup_documents (account_id, kind, id, revision, deleted, body, size, seq, born) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    pub async fn setup_document(&self, account_id: &str, kind: DocumentKind, id: &str) -> Result<Option<SetupDocument>, sqlx::Error> {
        let row = sqlx::query("SELECT kind, id, revision, deleted, body FROM setup_documents WHERE account_id = ? AND kind = ? AND id = ?")
            .bind(account_id)
            .bind(kind.wire_name())
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(document_from).transpose()
    }

    pub async fn layout_heads(&self, account_id: &str) -> Result<Vec<LayoutHead>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, json_extract(body, '$.name') AS name, json_extract(body, '$.updatedAt') AS updated_at
             FROM setup_documents WHERE account_id = ? AND kind = 'layout' AND deleted = 0 ORDER BY born, id",
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(|row| LayoutHead { id: row.get("id"), name: row.get("name"), updated_at: row.get("updated_at") }).collect())
    }

    pub async fn layout_name_taken(&self, account_id: &str, name: &str, except_id: &str) -> Result<bool, sqlx::Error> {
        let taken: Option<i64> = sqlx::query_scalar(LAYOUT_NAME_TAKEN)
        .bind(account_id)
        .bind(name)
        .bind(except_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(taken.is_some())
    }

    pub async fn drawings_of(&self, account_id: &str, symbol: &str) -> Result<Vec<SetupDocument>, sqlx::Error> {
        let rows = sqlx::query(DRAWINGS_OF_SYMBOL)
        .bind(account_id)
        .bind(symbol)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(document_from).collect()
    }

    pub async fn remove_document(&self, account_id: &str, kind: DocumentKind, id: &str, floor_revision: i64) -> Result<Removal, sqlx::Error> {
        let mut transaction = self.begin_account_write().await?;
        let stored = sqlx::query("SELECT revision, deleted, size FROM setup_documents WHERE account_id = ? AND kind = ? AND id = ?")
            .bind(account_id)
            .bind(kind.wire_name())
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await?;
        let Some(stored) = stored.filter(|row| row.get::<i64, _>("deleted") == 0) else { return Ok(Removal::Missing) };
        if kind == DocumentKind::Layout {
            let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM setup_documents WHERE account_id = ? AND kind = 'layout' AND deleted = 0")
                .bind(account_id)
                .fetch_one(&mut *transaction)
                .await?;
            if live <= 1 {
                return Ok(Removal::LastLayout);
            }
        }
        let revision = (stored.get::<i64, _>("revision") + 1).max(floor_revision);
        let counters = sqlx::query("SELECT seq, bytes FROM setup_accounts WHERE account_id = ?").bind(account_id).fetch_one(&mut *transaction).await?;
        let seq = counters.get::<i64, _>("seq") + 1;
        let bytes = counters.get::<i64, _>("bytes") - stored.get::<i64, _>("size");
        sqlx::query("UPDATE setup_documents SET revision = ?, deleted = 1, body = NULL, size = 0, seq = ? WHERE account_id = ? AND kind = ? AND id = ?")
            .bind(revision)
            .bind(seq)
            .bind(account_id)
            .bind(kind.wire_name())
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("UPDATE setup_accounts SET seq = ?, bytes = ? WHERE account_id = ?").bind(seq).bind(bytes).bind(account_id).execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(Removal::Removed)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::store::open_database;

    async fn store_with_account(dir: &tempfile::TempDir) -> Store {
        let pool = open_database(&dir.path().join("accounts.db")).await.unwrap();
        sqlx::query("INSERT INTO accounts (id, created_at) VALUES ('a1', 0)").execute(&pool).await.unwrap();
        Store::new(pool)
    }

    fn checked(kind: DocumentKind, id: &str, revision: i64, body: serde_json::Value) -> Checked {
        let raw = serde_json::value::RawValue::from_string(serde_json::to_string(&SetupDocument::live(kind, id, revision, &body)).unwrap()).unwrap();
        Checked::parse(&raw, 0).unwrap()
    }

    async fn plan(store: &Store, sql: &str, binds: &[&str]) -> String {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")));
        for bind in binds {
            query = query.bind(*bind);
        }
        query.fetch_all(&store.pool).await.unwrap().iter().map(|row| row.get::<String, _>("detail")).collect::<Vec<_>>().join(" | ")
    }

    #[tokio::test]
    async fn the_drawing_and_layout_name_queries_walk_their_expression_indexes_instead_of_the_whole_account() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_account(&dir).await;
        let drawings = plan(&store, DRAWINGS_OF_SYMBOL, &["a1", "005930"]).await;
        assert!(drawings.contains("USING INDEX setup_drawings_by_symbol") && !drawings.contains("TEMP B-TREE"), "{drawings}");
        let names = plan(&store, LAYOUT_NAME_TAKEN, &["a1", "이름", "x"]).await;
        assert!(names.contains("USING INDEX setup_layouts_by_name"), "{names}");
    }

    #[tokio::test]
    async fn a_layout_keeps_its_place_when_edited_and_removing_a_document_returns_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_account(&dir).await;
        let layout = |id: &str, name: &str, revision: i64| checked(DocumentKind::Layout, id, revision, json!({"id": id, "name": name, "updatedAt": revision}));
        let (first, second, third) = (layout("L1", "하나", 1), layout("L2", "둘", 1), layout("L3", "셋", 1));
        store.push_documents("a1", &[&first, &second, &third]).await.unwrap();
        store.push_documents("a1", &[&layout("L1", "하나 고침", 2)]).await.unwrap();
        let order: Vec<String> = store.layout_heads("a1").await.unwrap().into_iter().map(|head| head.id).collect();
        assert_eq!(order, ["L1", "L2", "L3"], "고친 레이아웃이 뒤로 가지 않는다");
        assert_eq!(store.layout_heads("a1").await.unwrap()[0].name, "하나 고침");

        let before = store.setup_summary("a1").await.unwrap();
        assert!(matches!(store.remove_document("a1", DocumentKind::Layout, "L2", 100).await.unwrap(), Removal::Removed));
        let after = store.setup_summary("a1").await.unwrap();
        assert!(after.bytes < before.bytes && after.seq == before.seq + 1 && after.documents == before.documents - 1, "{} → {}", before.bytes, after.bytes);
        let tombstone = store.setup_document("a1", DocumentKind::Layout, "L2").await.unwrap().unwrap();
        assert_eq!((tombstone.deleted, tombstone.revision, tombstone.body.is_none()), (true, 100, true));
        assert!(matches!(store.remove_document("a1", DocumentKind::Layout, "L2", 200).await.unwrap(), Removal::Missing));
        assert!(matches!(store.remove_document("a1", DocumentKind::Layout, "nope", 200).await.unwrap(), Removal::Missing));
        assert!(matches!(store.remove_document("a1", DocumentKind::Layout, "L3", 5).await.unwrap(), Removal::Removed));
        let floor = store.setup_document("a1", DocumentKind::Layout, "L3").await.unwrap().unwrap().revision;
        assert_eq!(floor, 5, "저장된 revision(1)보다 크면 바닥값을 쓴다");
        assert!(matches!(store.remove_document("a1", DocumentKind::Layout, "L1", 0).await.unwrap(), Removal::LastLayout), "마지막 레이아웃은 지우지 못한다");
        let kept = store.setup_document("a1", DocumentKind::Layout, "L1").await.unwrap().unwrap();
        assert_eq!((kept.deleted, kept.revision), (false, 2));
        let outcome = store.push_documents("a1", &[&layout("L2", "둘", 100)]).await.unwrap();
        assert!(matches!(outcome.outcomes[0], Outcome::Stale(ref stored) if stored.revision == 100), "삭제 표시와 같은 revision은 거절한다");
    }
}
