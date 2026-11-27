use std::collections::{BTreeMap, HashSet};

use domain::{KstDate, Venue};
use sqlx::{Row, SqliteConnection};

use crate::api::{self, OrderSide, TradingExecution, TradingExecutionDay};
use crate::db::AppDb;

use super::journal::JournalError;

fn parse_side(text: &str) -> Result<OrderSide, JournalError> {
    match text {
        "buy" => Ok(OrderSide::Buy),
        "sell" => Ok(OrderSide::Sell),
        other => Err(JournalError(format!("체결 이력에 모르는 방향이 있습니다: {other}"))),
    }
}

fn side_wire(side: OrderSide) -> &'static str {
    match side {
        OrderSide::Buy => "buy",
        OrderSide::Sell => "sell",
    }
}

fn parse_day_text(text: &str) -> Result<KstDate, JournalError> {
    text.parse::<api::KstDate>().map(|d| d.0).map_err(|_| JournalError(format!("체결 이력에 잘못된 날짜가 있습니다: {text}")))
}

fn execution_of(row: &sqlx::sqlite::SqliteRow) -> Result<(KstDate, TradingExecution), JournalError> {
    let day = parse_day_text(&row.try_get::<String, _>("day")?)?;
    let venue_raw: String = row.try_get("venue")?;
    let venue = Venue::parse(&venue_raw).ok_or_else(|| JournalError(format!("체결 이력에 모르는 거래소가 있습니다: {venue_raw}")))?;
    let quantity: i64 = row.try_get("quantity")?;
    let price: i64 = row.try_get("price")?;
    Ok((
        day,
        TradingExecution {
            order_no: row.try_get("order_no")?,
            code: row.try_get("code")?,
            name: row.try_get("name")?,
            side: parse_side(&row.try_get::<String, _>("side")?)?,
            quantity: quantity.unsigned_abs(),
            price: price.unsigned_abs(),
            time: row.try_get("time")?,
            venue: venue.into(),
        },
    ))
}

async fn write_day_in(conn: &mut SqliteConnection, account_ref: &str, day: KstDate, finalized: bool, executions: &[TradingExecution], synced_at: i64) -> Result<(), JournalError> {
    let day_text = day.to_string();
    sqlx::query("DELETE FROM trading_executions WHERE account_ref = ? AND day = ?")
        .bind(account_ref)
        .bind(&day_text)
        .execute(&mut *conn)
        .await?;
    for (seq, fill) in executions.iter().enumerate() {
        let venue = Venue::from(fill.venue);
        sqlx::query(
            "INSERT INTO trading_executions (account_ref, day, seq, order_no, code, name, side, quantity, price, time, venue) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(account_ref)
        .bind(&day_text)
        .bind(seq as i64)
        .bind(&fill.order_no)
        .bind(&fill.code)
        .bind(&fill.name)
        .bind(side_wire(fill.side))
        .bind(fill.quantity as i64)
        .bind(fill.price as i64)
        .bind(&fill.time)
        .bind(venue.as_wire())
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "INSERT OR REPLACE INTO trading_execution_days (account_ref, day, finalized, synced_at) VALUES (?, ?, ?, ?)",
    )
    .bind(account_ref)
    .bind(&day_text)
    .bind(i64::from(finalized))
    .bind(synced_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(Clone)]
pub struct ExecutionHistoryStore {
    db: AppDb,
}

impl ExecutionHistoryStore {
    pub fn new(db: AppDb) -> Self {
        Self { db }
    }

    pub async fn is_finalized(&self, account_ref: &str, day: KstDate) -> Result<bool, JournalError> {
        let found: Option<i64> = sqlx::query_scalar(
            "SELECT finalized FROM trading_execution_days WHERE account_ref = ? AND day = ?",
        )
        .bind(account_ref)
        .bind(day.to_string())
        .fetch_optional(self.db.read())
        .await?;
        Ok(found == Some(1))
    }

    pub async fn finalized_days(&self, account_ref: &str, from: KstDate, to: KstDate) -> Result<HashSet<KstDate>, JournalError> {
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT day FROM trading_execution_days WHERE account_ref = ? AND day >= ? AND day <= ? AND finalized = 1",
        )
        .bind(account_ref)
        .bind(from.to_string())
        .bind(to.to_string())
        .fetch_all(self.db.read())
        .await?;
        rows.into_iter().map(|text| parse_day_text(&text)).collect()
    }

    pub async fn earliest_day(&self, account_ref: &str) -> Result<Option<KstDate>, JournalError> {
        let row: Option<String> = sqlx::query_scalar(
            "SELECT MIN(day) FROM trading_executions WHERE account_ref = ?",
        )
        .bind(account_ref)
        .fetch_one(self.db.read())
        .await?;
        row.as_deref().map(parse_day_text).transpose()
    }

    pub async fn load_day(&self, account_ref: &str, day: KstDate) -> Result<Vec<TradingExecution>, JournalError> {
        let rows = sqlx::query(
            "SELECT day, order_no, code, name, side, quantity, price, time, venue \
             FROM trading_executions WHERE account_ref = ? AND day = ? ORDER BY seq ASC",
        )
        .bind(account_ref)
        .bind(day.to_string())
        .fetch_all(self.db.read())
        .await?;
        rows.iter().map(|row| execution_of(row).map(|(_, fill)| fill)).collect()
    }

    pub async fn load_range(&self, account_ref: &str, from: KstDate, to: KstDate) -> Result<Vec<TradingExecutionDay>, JournalError> {
        let rows = sqlx::query(
            "SELECT day, order_no, code, name, side, quantity, price, time, venue \
             FROM trading_executions WHERE account_ref = ? AND day >= ? AND day <= ? \
             ORDER BY day ASC, seq ASC",
        )
        .bind(account_ref)
        .bind(from.to_string())
        .bind(to.to_string())
        .fetch_all(self.db.read())
        .await?;
        let mut grouped: BTreeMap<KstDate, Vec<TradingExecution>> = BTreeMap::new();
        for row in &rows {
            let (day, fill) = execution_of(row)?;
            grouped.entry(day).or_default().push(fill);
        }
        Ok(grouped
            .into_iter()
            .map(|(day, executions)| TradingExecutionDay { day: api::KstDate(day), executions })
            .collect())
    }

    pub async fn save_day(&self, account_ref: &str, day: KstDate, finalized: bool, executions: &[TradingExecution], synced_at: i64) -> Result<(), JournalError> {
        let mut tx = self.db.begin_write().await?;
        write_day_in(&mut tx, account_ref, day, finalized, executions, synced_at).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn save_days(&self, account_ref: &str, days: &[(KstDate, bool, Vec<TradingExecution>)], synced_at: i64) -> Result<(), JournalError> {
        if days.is_empty() {
            return Ok(());
        }
        let mut tx = self.db.begin_write().await?;
        for (day, finalized, executions) in days {
            write_day_in(&mut tx, account_ref, *day, *finalized, executions, synced_at).await?;
        }
        tx.commit().await?;
        Ok(())
    }
}
