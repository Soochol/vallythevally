use domain::Venue;
use serde::Serialize;
use serde::de::DeserializeOwned;
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::api::{OrderCommand, OrderCommandKind, OrderCommandState, OrderRejectReason, UnixSeconds};
use crate::db::AppDb;

const RECENT_COMMANDS: i64 = 50;

#[derive(Debug)]
pub struct JournalError(pub String);

impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "명령 저널을 쓰거나 읽지 못했습니다: {}", self.0)
    }
}

impl From<sqlx::Error> for JournalError {
    fn from(e: sqlx::Error) -> Self {
        JournalError(e.to_string())
    }
}

pub struct Prepared {
    pub command_id: String,
    pub account_ref: String,
    pub kind: OrderCommandKind,
    pub code: Option<String>,
    pub venue: Option<Venue>,
    pub quantity: Option<u64>,
    pub price: Option<u64>,
    pub target_order_no: Option<String>,
}

impl Prepared {
    fn fingerprint(&self) -> String {
        format!("{}|{}|{}|{}|{}|{}", wire(&self.kind), self.code.as_deref().unwrap_or(""), self.venue.map_or("", Venue::as_wire), self.quantity.unwrap_or(0), self.price.unwrap_or(0), self.target_order_no.as_deref().unwrap_or(""))
    }
}

pub enum Begun {
    Created(OrderCommand),
    Existing(OrderCommand),
    DifferentRequest,
}

fn wire<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(text)) => text,
        _ => unreachable!("닫힌 열거형은 문자열로 나간다"),
    }
}

fn from_wire<T: DeserializeOwned>(text: &str) -> Result<T, JournalError> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).map_err(|_| JournalError(format!("저널에 모르는 값이 있습니다: {text}")))
}

fn unsigned(row: &SqliteRow, column: &str) -> Result<Option<u64>, JournalError> {
    Ok(row.try_get::<Option<i64>, _>(column)?.map(i64::unsigned_abs))
}

fn command_of(row: &SqliteRow) -> Result<OrderCommand, JournalError> {
    let venue: Option<String> = row.try_get("venue")?;
    let reason: Option<String> = row.try_get("reason")?;
    Ok(OrderCommand {
        command_id: row.try_get("command_id")?,
        account_ref: row.try_get("account_ref")?,
        kind: from_wire(&row.try_get::<String, _>("kind")?)?,
        code: row.try_get("code")?,
        venue: venue.map(|v| Venue::parse(&v).ok_or_else(|| JournalError(format!("저널에 모르는 거래소가 있습니다: {v}")))).transpose()?.map(Into::into),
        quantity: unsigned(row, "quantity")?,
        price: unsigned(row, "price")?,
        target_order_no: row.try_get("target_order_no")?,
        state: from_wire(&row.try_get::<String, _>("state")?)?,
        reason: reason.map(|r| from_wire(&r)).transpose()?,
        order_no: row.try_get("order_no")?,
        reconciled: row.try_get::<i64, _>("reconciled")? == 1,
        created_at: UnixSeconds(row.try_get("created_at")?),
        updated_at: UnixSeconds(row.try_get("updated_at")?),
    })
}

#[derive(Clone)]
pub struct Journal {
    db: AppDb,
}

impl Journal {
    pub fn new(db: AppDb) -> Journal {
        Journal { db }
    }

    pub async fn begin(&self, command: &Prepared, now: i64) -> Result<Begun, JournalError> {
        let fingerprint = command.fingerprint();
        let mut tx = self.db.begin_write().await?;
        if let Some(row) = sqlx::query("SELECT *, fingerprint AS stored FROM order_commands WHERE command_id = ?").bind(&command.command_id).fetch_optional(&mut *tx).await? {
            let stored: String = row.try_get("stored")?;
            let existing = command_of(&row)?;
            return Ok(if stored == fingerprint { Begun::Existing(existing) } else { Begun::DifferentRequest });
        }
        sqlx::query(
            "INSERT INTO order_commands (command_id, account_ref, fingerprint, kind, code, venue, quantity, price, target_order_no, state, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)",
        )
        .bind(&command.command_id)
        .bind(&command.account_ref)
        .bind(&fingerprint)
        .bind(wire(&command.kind))
        .bind(&command.code)
        .bind(command.venue.map(Venue::as_wire))
        .bind(command.quantity.map(|q| q as i64))
        .bind(command.price.map(|p| p as i64))
        .bind(&command.target_order_no)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query("SELECT * FROM order_commands WHERE command_id = ?").bind(&command.command_id).fetch_one(&mut *tx).await?;
        let created = command_of(&row)?;
        tx.commit().await?;
        Ok(Begun::Created(created))
    }

    pub async fn get(&self, command_id: &str) -> Result<Option<OrderCommand>, JournalError> {
        let row = sqlx::query("SELECT * FROM order_commands WHERE command_id = ?").bind(command_id).fetch_optional(self.db.read()).await?;
        row.as_ref().map(command_of).transpose()
    }

    pub async fn recent(&self, account_ref: &str) -> Result<Vec<OrderCommand>, JournalError> {
        let rows = sqlx::query("SELECT * FROM order_commands WHERE account_ref = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(account_ref).bind(RECENT_COMMANDS).fetch_all(self.db.read()).await?;
        rows.iter().map(command_of).collect()
    }

    pub async fn blocking_unknown(&self, account_ref: &str) -> Result<u64, JournalError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM order_commands WHERE account_ref = ? AND state IN ('sending', 'unknown') AND reconciled = 0").bind(account_ref).fetch_one(self.db.read()).await?;
        Ok(count.unsigned_abs())
    }

    pub async fn resolve_target(&self, command_id: &str, code: &str, venue: Venue, quantity: u64, now: i64) -> Result<(), JournalError> {
        self.exactly_one(sqlx::query("UPDATE order_commands SET code = ?, venue = ?, quantity = ?, updated_at = ? WHERE command_id = ? AND state = 'prepared'").bind(code).bind(venue.as_wire()).bind(quantity as i64).bind(now).bind(command_id)).await
    }

    pub async fn reject(&self, command_id: &str, reason: OrderRejectReason, now: i64) -> Result<(), JournalError> {
        self.exactly_one(sqlx::query("UPDATE order_commands SET state = 'rejected', reason = ?, updated_at = ? WHERE command_id = ? AND state = 'prepared'").bind(wire(&reason)).bind(now).bind(command_id)).await
    }

    pub async fn mark_sending(&self, command_id: &str, now: i64) -> Result<(), JournalError> {
        self.exactly_one(sqlx::query("UPDATE order_commands SET state = 'sending', updated_at = ? WHERE command_id = ? AND state = 'prepared'").bind(now).bind(command_id)).await
    }

    pub async fn finish_sending(&self, command_id: &str, state: OrderCommandState, reason: Option<OrderRejectReason>, order_no: Option<&str>, now: i64) -> Result<(), JournalError> {
        self.exactly_one(sqlx::query("UPDATE order_commands SET state = ?, reason = ?, order_no = ?, updated_at = ? WHERE command_id = ? AND state = 'sending'").bind(wire(&state)).bind(reason.map(|r| wire(&r))).bind(order_no).bind(now).bind(command_id)).await
    }

    pub async fn mark_reconciled(&self, account_ref: &str, now: i64) -> Result<u64, JournalError> {
        let mut tx = self.db.begin_write().await?;
        let changed = sqlx::query("UPDATE order_commands SET state = 'unknown', reason = NULL, reconciled = 1, updated_at = ? WHERE account_ref = ? AND state IN ('sending', 'unknown') AND reconciled = 0").bind(now).bind(account_ref).execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        Ok(changed)
    }

    pub async fn recover(&self, now: i64) -> Result<(), JournalError> {
        let mut tx = self.db.begin_write().await?;
        sqlx::query("UPDATE order_commands SET state = 'unknown', reason = NULL, updated_at = ? WHERE state = 'sending'").bind(now).execute(&mut *tx).await?;
        sqlx::query("UPDATE order_commands SET state = 'rejected', reason = 'not_sent', updated_at = ? WHERE state = 'prepared'").bind(now).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn exactly_one(&self, query: sqlx::query::Query<'_, sqlx::Sqlite, sqlx::sqlite::SqliteArguments>) -> Result<(), JournalError> {
        let mut tx = self.db.begin_write().await?;
        let changed = query.execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(JournalError("명령이 기대한 상태가 아닙니다".to_owned()));
        }
        tx.commit().await?;
        Ok(())
    }
}
