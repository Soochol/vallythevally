use setup::{Document, DocumentKind};
use sqlx::{Row, SqliteConnection};

const REASON_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Push,
    Pull,
}

impl Direction {
    fn wire(self) -> &'static str {
        match self {
            Direction::Push => "push",
            Direction::Pull => "pull",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub kind: DocumentKind,
    pub id: String,
    pub revision: i64,
    pub deleted: bool,
}

fn kind_of(wire: &str) -> DocumentKind {
    DocumentKind::ALL.into_iter().find(|kind| kind.wire_name() == wire).expect("동기화 기록의 종류는 CHECK가 DocumentKind::ALL로 막는다")
}

pub(crate) async fn saved(conn: &mut SqliteConnection, kind: DocumentKind, id: &str, revision: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sync_documents (kind, id, revision, deleted) VALUES (?, ?, ?, 0)
         ON CONFLICT (kind, id) DO UPDATE SET revision = excluded.revision, deleted = 0",
    )
    .bind(kind.wire_name())
    .bind(id)
    .bind(revision)
    .execute(&mut *conn)
    .await?;
    forget_refusal(conn, kind, id).await
}

pub(crate) async fn deleted(conn: &mut SqliteConnection, kind: DocumentKind, id: &str, floor: i64) -> Result<i64, sqlx::Error> {
    let known: Option<i64> = sqlx::query_scalar("SELECT revision FROM sync_documents WHERE kind = ? AND id = ?").bind(kind.wire_name()).bind(id).fetch_optional(&mut *conn).await?;
    let revision = known.map_or(floor, |known| (known + 1).max(floor));
    sqlx::query(
        "INSERT INTO sync_documents (kind, id, revision, deleted) VALUES (?, ?, ?, 1)
         ON CONFLICT (kind, id) DO UPDATE SET revision = excluded.revision, deleted = 1",
    )
    .bind(kind.wire_name())
    .bind(id)
    .bind(revision)
    .execute(&mut *conn)
    .await?;
    forget_refusal(conn, kind, id).await?;
    Ok(revision)
}

pub(crate) async fn tombstone_revision(conn: &mut SqliteConnection, kind: DocumentKind, id: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT revision FROM sync_documents WHERE kind = ? AND id = ? AND deleted = 1").bind(kind.wire_name()).bind(id).fetch_optional(&mut *conn).await
}

pub(crate) async fn recorded_revision(conn: &mut SqliteConnection, kind: DocumentKind, id: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT revision FROM sync_documents WHERE kind = ? AND id = ?").bind(kind.wire_name()).bind(id).fetch_optional(&mut *conn).await
}

pub(crate) async fn received(conn: &mut SqliteConnection, document: &Document) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sync_documents (kind, id, revision, acked_revision, deleted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE SET revision = excluded.revision, acked_revision = excluded.acked_revision, deleted = excluded.deleted",
    )
    .bind(document.kind.wire_name())
    .bind(&document.id)
    .bind(document.revision)
    .bind(document.revision)
    .bind(i64::from(document.deleted))
    .execute(&mut *conn)
    .await?;
    forget_refusal(conn, document.kind, &document.id).await
}

pub(crate) async fn acked(conn: &mut SqliteConnection, kind: DocumentKind, id: &str, revision: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sync_documents SET acked_revision = MAX(COALESCE(acked_revision, 0), ?) WHERE kind = ? AND id = ?").bind(revision).bind(kind.wire_name()).bind(id).execute(&mut *conn).await?;
    Ok(())
}

pub(crate) async fn refuse(conn: &mut SqliteConnection, kind: DocumentKind, id: &str, revision: i64, direction: Direction, reason: &str) -> Result<(), sqlx::Error> {
    let reason: String = reason.chars().take(REASON_CHARS).collect();
    sqlx::query(
        "INSERT INTO sync_refusals (kind, id, revision, direction, reason) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE SET revision = excluded.revision, direction = excluded.direction, reason = excluded.reason",
    )
    .bind(kind.wire_name())
    .bind(id)
    .bind(revision)
    .bind(direction.wire())
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn forget_refusal(conn: &mut SqliteConnection, kind: DocumentKind, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sync_refusals WHERE kind = ? AND id = ?").bind(kind.wire_name()).bind(id).execute(&mut *conn).await?;
    Ok(())
}

pub(crate) async fn pending(conn: &mut SqliteConnection) -> Result<Vec<Entry>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT kind, id, revision, deleted FROM sync_documents d
         WHERE (acked_revision IS NULL OR acked_revision <> revision)
           AND NOT EXISTS (SELECT 1 FROM sync_refusals r WHERE r.kind = d.kind AND r.id = d.id)
         ORDER BY kind, id",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.iter().map(|row| Entry { kind: kind_of(row.get("kind")), id: row.get("id"), revision: row.get("revision"), deleted: row.get::<i64, _>("deleted") == 1 }).collect())
}

pub(crate) async fn pending_count(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_documents d WHERE (acked_revision IS NULL OR acked_revision <> revision) AND NOT EXISTS (SELECT 1 FROM sync_refusals r WHERE r.kind = d.kind AND r.id = d.id)")
        .fetch_one(&mut *conn)
        .await
}

pub(crate) async fn refused_count(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_refusals").fetch_one(&mut *conn).await
}

pub(crate) async fn tombstone_count(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_documents WHERE deleted = 1").fetch_one(&mut *conn).await
}

pub(crate) async fn cursor(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT cursor FROM sync_state WHERE singleton = 1").fetch_one(&mut *conn).await
}

pub(crate) async fn set_cursor(conn: &mut SqliteConnection, cursor: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sync_state SET cursor = ? WHERE singleton = 1").bind(cursor).execute(&mut *conn).await?;
    Ok(())
}

pub(crate) async fn initial_done(conn: &mut SqliteConnection) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT initial_done FROM sync_state WHERE singleton = 1").fetch_one(&mut *conn).await? == 1)
}

pub(crate) async fn set_initial_done(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sync_state SET initial_done = 1 WHERE singleton = 1").execute(&mut *conn).await?;
    Ok(())
}

pub(crate) async fn forget_account(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sync_documents WHERE deleted = 1").execute(&mut *conn).await?;
    unack_all(conn).await?;
    sqlx::query("UPDATE sync_state SET cursor = 0, initial_done = 0 WHERE singleton = 1").execute(&mut *conn).await?;
    Ok(())
}

pub(crate) async fn unack_all(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sync_documents SET acked_revision = NULL").execute(&mut *conn).await?;
    sqlx::query("DELETE FROM sync_refusals").execute(&mut *conn).await?;
    Ok(())
}

pub(crate) async fn raise_revisions(conn: &mut SqliteConnection, floor: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE layouts SET revision = MAX(revision, ?)").bind(floor).execute(&mut *conn).await?;
    sqlx::query("UPDATE drawings SET revision = MAX(revision, ?)").bind(floor).execute(&mut *conn).await?;
    sqlx::query("UPDATE screens SET revision = MAX(revision, ?)").bind(floor).execute(&mut *conn).await?;
    sqlx::query("UPDATE ui_state SET revision = MAX(revision, ?)").bind(floor).execute(&mut *conn).await?;
    sqlx::query("UPDATE watchlist_revision SET revision = MAX(revision, ?)").bind(floor).execute(&mut *conn).await?;
    sqlx::query("UPDATE heatmap_theme_revision SET revision = MAX(revision, ?)").bind(floor).execute(&mut *conn).await?;
    sqlx::query("UPDATE sync_documents SET revision = MAX(revision, ?)").bind(floor).execute(&mut *conn).await?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn break_for_test(db: &crate::db::AppDb) {
    let mut tx = db.begin_write().await.unwrap();
    sqlx::query("DROP TABLE sync_documents").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}
