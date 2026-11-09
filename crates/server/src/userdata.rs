//! 사용자 자료 저장소(backend.md §7.2). 입력은 경계(http)에서 검사를 마친 값이다.

use sqlx::Row;

use crate::api::{Arrangement, Cell, Layout, LayoutInput, LayoutSummary, LayoutSync, SymbolCode, UiState, UnixSeconds, Watchlist};
use crate::db::{AppDb, DbError};

#[derive(Debug)]
pub enum StoreError {
    NotFound,
    /// 같은 이름의 레이아웃, 마지막 레이아웃 지우기.
    Conflict(String),
    Db(DbError),
}

impl From<sqlx::Error> for StoreError {
    fn from(e: sqlx::Error) -> Self {
        StoreError::Db(e.into())
    }
}

/// 저장된 텍스트를 계약 타입으로 되읽지 못했다. 마이그레이션의 CHECK를 지나 들어온 값이라 버그다.
fn corrupt(what: &str, e: impl std::fmt::Display) -> StoreError {
    StoreError::Db(DbError(format!("저장된 {what}를 읽지 못했습니다: {e}")))
}

/// 계약 enum의 직렬화 이름("1", "2h", "D", "nxt" …). DB에도 같은 문자열을 쓴다.
fn wire_name<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        other => unreachable!("계약 enum은 문자열로 직렬화된다: {other:?}"),
    }
}

fn from_wire_name<T: serde::de::DeserializeOwned>(what: &str, s: String) -> Result<T, StoreError> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| corrupt(what, e))
}

pub async fn get_watchlist(db: &AppDb) -> Result<Watchlist, StoreError> {
    let symbols: Vec<String> = sqlx::query_scalar("SELECT symbol FROM watchlist ORDER BY position").fetch_all(db.read()).await?;
    Ok(Watchlist { symbols: symbols.into_iter().map(SymbolCode).collect() })
}

/// 목록 전체를 바꾼다. 중복은 호출자가 먼저 거른다.
pub async fn put_watchlist(db: &AppDb, list: &Watchlist) -> Result<(), StoreError> {
    let mut tx = db.begin_write().await?;
    sqlx::query("DELETE FROM watchlist").execute(&mut *tx).await?;
    for (position, symbol) in list.symbols.iter().enumerate() {
        sqlx::query("INSERT INTO watchlist (symbol, position) VALUES (?, ?)").bind(&symbol.0).bind(position as i64).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn list_layouts(db: &AppDb) -> Result<Vec<LayoutSummary>, StoreError> {
    let rows = sqlx::query("SELECT id, name, arrangement, updated_at FROM layouts ORDER BY position, rowid").fetch_all(db.read()).await?;
    rows.into_iter()
        .map(|r| {
            Ok(LayoutSummary {
                id: r.get("id"),
                name: r.get("name"),
                arrangement: from_wire_name("arrangement", r.get("arrangement"))?,
                updated_at: UnixSeconds(r.get("updated_at")),
            })
        })
        .collect()
}

/// 레이아웃 행과 칸을 한 읽기 트랜잭션에서 읽는다. WAL에서는 첫 SELECT가 스냅숏을 고정한다.
pub async fn get_layout(db: &AppDb, id: &str) -> Result<Layout, StoreError> {
    let mut tx = db.read().begin().await?;
    let row = sqlx::query("SELECT name, arrangement, sync, updated_at FROM layouts WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::NotFound)?;
    let cells = sqlx::query("SELECT slot, symbol, venue, period, symbol_link, chart_settings FROM layout_cells WHERE layout_id = ? ORDER BY slot")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|c| {
            let venue: Option<String> = c.get("venue");
            Ok(Cell {
                slot: u8::try_from(c.get::<i64, _>("slot")).map_err(|e| corrupt("slot", e))?,
                symbol: SymbolCode(c.get("symbol")),
                venue: venue.map(|v| from_wire_name("venue", v)).transpose()?,
                period: from_wire_name("period", c.get("period"))?,
                symbol_link: c.get::<i64, _>("symbol_link") == 1,
                chart_settings: serde_json::from_str(c.get("chart_settings")).map_err(|e| corrupt("chart_settings", e))?,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let arrangement: Arrangement = from_wire_name("arrangement", row.get("arrangement"))?;
    let sync: LayoutSync = serde_json::from_str(row.get("sync")).map_err(|e| corrupt("sync", e))?;
    Ok(Layout { id: id.to_owned(), name: row.get("name"), arrangement, sync, cells, updated_at: UnixSeconds(row.get("updated_at")) })
}

/// 없으면 만들고 있으면 바꾼다. 칸은 모두 지우고 다시 넣는다. 새 레이아웃은 목록의 맨 끝에 놓인다.
pub async fn put_layout(db: &AppDb, input: &LayoutInput, now: UnixSeconds) -> Result<Layout, StoreError> {
    let mut tx = db.begin_write().await?;
    let taken: Option<String> = sqlx::query_scalar("SELECT id FROM layouts WHERE name = ? AND id <> ?")
        .bind(&input.name)
        .bind(&input.id)
        .fetch_optional(&mut *tx)
        .await?;
    if taken.is_some() {
        return Err(StoreError::Conflict(format!("같은 이름의 레이아웃이 이미 있습니다: {}", input.name)));
    }
    let sync = serde_json::to_string(&input.sync).expect("LayoutSync는 언제나 직렬화된다");
    sqlx::query(
        "INSERT INTO layouts (id, name, arrangement, sync, position, updated_at)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM layouts), ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, arrangement = excluded.arrangement,
                                       sync = excluded.sync, updated_at = excluded.updated_at",
    )
    .bind(&input.id)
    .bind(&input.name)
    .bind(wire_name(&input.arrangement))
    .bind(sync)
    .bind(now.0)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM layout_cells WHERE layout_id = ?").bind(&input.id).execute(&mut *tx).await?;
    let mut cells = input.cells.clone();
    cells.sort_by_key(|c| c.slot);
    for c in &cells {
        sqlx::query(
            "INSERT INTO layout_cells (layout_id, slot, symbol, venue, period, symbol_link, chart_settings) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&input.id)
        .bind(i64::from(c.slot))
        .bind(&c.symbol.0)
        .bind(c.venue.as_ref().map(wire_name))
        .bind(wire_name(&c.period))
        .bind(i64::from(c.symbol_link))
        .bind(c.chart_settings.to_string())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Layout { id: input.id.clone(), name: input.name.clone(), arrangement: input.arrangement, sync: input.sync, cells, updated_at: now })
}

/// 마지막 레이아웃은 지울 수 없다(레이아웃이 0개인 상태는 없다).
pub async fn delete_layout(db: &AppDb, id: &str) -> Result<(), StoreError> {
    let mut tx = db.begin_write().await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM layouts WHERE id = ?").bind(id).fetch_optional(&mut *tx).await?;
    if exists.is_none() {
        return Err(StoreError::NotFound);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layouts").fetch_one(&mut *tx).await?;
    if count <= 1 {
        return Err(StoreError::Conflict("마지막 레이아웃은 지울 수 없습니다".into()));
    }
    sqlx::query("DELETE FROM layouts WHERE id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn get_ui_state(db: &AppDb) -> Result<UiState, StoreError> {
    let state: String = sqlx::query_scalar("SELECT state FROM ui_state WHERE singleton = 1").fetch_one(db.read()).await?;
    serde_json::from_str(&state).map_err(|e| corrupt("ui_state", e))
}

pub async fn put_ui_state(db: &AppDb, state: &UiState) -> Result<(), StoreError> {
    let text = serde_json::to_string(state).expect("UiState는 언제나 직렬화된다");
    let mut tx = db.begin_write().await?;
    sqlx::query("INSERT INTO ui_state (singleton, state) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state = excluded.state")
        .bind(text)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::api::{Period, Venue};

    const DEFAULT_ID: &str = "01900000-0000-7000-8000-000000000001";

    async fn db(opts: SqliteConnectOptions) -> AppDb {
        AppDb::connect(opts).await.unwrap()
    }

    fn codes(list: &Watchlist) -> Vec<&str> {
        list.symbols.iter().map(|s| s.0.as_str()).collect()
    }

    fn watch(codes: &[&str]) -> Watchlist {
        Watchlist { symbols: codes.iter().map(|c| SymbolCode((*c).into())).collect() }
    }

    fn cell(slot: u8, symbol: &str, venue: Option<Venue>) -> Cell {
        Cell { slot, symbol: SymbolCode(symbol.into()), venue, period: Period::M5, symbol_link: slot == 1, chart_settings: json!({"v": 1, "future": [slot]}) }
    }

    fn layout(id: &str, name: &str, arrangement: Arrangement, cells: Vec<Cell>) -> LayoutInput {
        LayoutInput { id: id.into(), name: name.into(), arrangement, sync: LayoutSync { crosshair: false, scroll: true }, cells }
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn watchlist_round_trips_in_order_and_reorders(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        assert!(get_watchlist(&db).await.unwrap().symbols.is_empty());
        put_watchlist(&db, &watch(&["005930", "IDX:001", "000660"])).await.unwrap();
        assert_eq!(codes(&get_watchlist(&db).await.unwrap()), ["005930", "IDX:001", "000660"]);
        put_watchlist(&db, &watch(&["000660", "005930"])).await.unwrap();
        assert_eq!(codes(&get_watchlist(&db).await.unwrap()), ["000660", "005930"], "순서 바꾸기와 지우기");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn layout_upsert_replaces_cells_and_lists_in_position_order(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let seeded = get_layout(&db, DEFAULT_ID).await.unwrap();
        assert_eq!((seeded.name.as_str(), seeded.arrangement, seeded.cells.len()), ("기본", Arrangement::One, 1));
        assert_eq!((seeded.cells[0].symbol.0.as_str(), seeded.cells[0].venue), ("IDX:001", None));

        let two = layout("L2", "둘", Arrangement::TwoH, vec![cell(1, "005930", Some(Venue::Nxt)), cell(0, "IDX:101", None)]);
        let saved = put_layout(&db, &two, UnixSeconds(100)).await.unwrap();
        let read = get_layout(&db, "L2").await.unwrap();
        assert_eq!(saved, read);
        assert_eq!(read.cells.iter().map(|c| c.slot).collect::<Vec<_>>(), [0, 1], "slot 순서로 돌려준다");
        assert_eq!(read.cells[1].chart_settings, json!({"v": 1, "future": [1]}), "모르는 키도 그대로");
        assert_eq!(read.sync, LayoutSync { crosshair: false, scroll: true });

        let one = layout("L2", "둘 바꿈", Arrangement::One, vec![cell(0, "000660", Some(Venue::Krx))]);
        put_layout(&db, &one, UnixSeconds(200)).await.unwrap();
        let read = get_layout(&db, "L2").await.unwrap();
        assert_eq!((read.cells.len(), read.updated_at, read.name.as_str()), (1, UnixSeconds(200), "둘 바꿈"), "칸을 통째로 바꾼다");

        let names: Vec<_> = list_layouts(&db).await.unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["기본", "둘 바꿈"], "바꿔도 자리는 그대로");
        assert!(matches!(get_layout(&db, "nope").await, Err(StoreError::NotFound)));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn duplicate_name_conflicts_and_last_layout_cannot_be_deleted(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let dup = layout("L2", "기본", Arrangement::One, vec![cell(0, "005930", Some(Venue::Combined))]);
        assert!(matches!(put_layout(&db, &dup, UnixSeconds(1)).await, Err(StoreError::Conflict(_))));
        assert!(matches!(delete_layout(&db, DEFAULT_ID).await, Err(StoreError::Conflict(_))));
        assert!(matches!(delete_layout(&db, "nope").await, Err(StoreError::NotFound)));

        put_layout(&db, &layout("L2", "둘", Arrangement::One, vec![cell(0, "005930", Some(Venue::Combined))]), UnixSeconds(1)).await.unwrap();
        delete_layout(&db, DEFAULT_ID).await.unwrap();
        let cells: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layout_cells WHERE layout_id = ?").bind(DEFAULT_ID).fetch_one(db.read()).await.unwrap();
        assert_eq!(cells, 0, "foreign_keys가 켜져 있어 칸도 함께 지워진다");
        assert!(matches!(delete_layout(&db, "L2").await, Err(StoreError::Conflict(_))));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn db_rejects_venue_on_an_index_and_a_stock_without_venue(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        for bad in [cell(0, "IDX:001", Some(Venue::Krx)), cell(0, "005930", None)] {
            let err = put_layout(&db, &layout("L2", "둘", Arrangement::One, vec![bad]), UnixSeconds(1)).await.unwrap_err();
            assert!(matches!(&err, StoreError::Db(e) if e.0.contains("CHECK")), "{err:?}");
        }
        assert!(matches!(get_layout(&db, "L2").await, Err(StoreError::NotFound)), "실패한 트랜잭션은 레이아웃도 남기지 않는다");
    }

    /// R3: 레이아웃 행과 칸을 서로 다른 커밋에서 읽으면 `2v`에 칸 1개 같은, 저장된 적 없는 조합이 나온다.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn get_layout_never_mixes_two_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("vally.db")).await.unwrap();
        let one = layout("R", "race", Arrangement::One, vec![cell(0, "005930", Some(Venue::Krx))]);
        let two = layout("R", "race", Arrangement::TwoV, vec![cell(0, "005930", Some(Venue::Krx)), cell(1, "000660", Some(Venue::Krx))]);
        put_layout(&db, &one, UnixSeconds(0)).await.unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let (db, stop) = (db.clone(), stop.clone());
            tokio::spawn(async move {
                for i in 0..400 {
                    put_layout(&db, if i % 2 == 0 { &two } else { &one }, UnixSeconds(i)).await.unwrap();
                }
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        };
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let (db, stop) = (db.clone(), stop.clone());
                tokio::spawn(async move {
                    let (mut reads, mut torn) = (0, Vec::new());
                    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                        let l = get_layout(&db, "R").await.unwrap();
                        reads += 1;
                        if l.cells.len() != l.arrangement.cell_count() {
                            torn.push((l.arrangement, l.cells.len()));
                        }
                    }
                    (reads, torn)
                })
            })
            .collect();
        writer.await.unwrap();
        let (mut reads, mut torn) = (0, Vec::new());
        for r in readers {
            let (n, t) = r.await.unwrap();
            reads += n;
            torn.extend(t);
        }
        assert!(reads > 0);
        assert!(torn.is_empty(), "쓰기 400회 중 읽기 {reads}회에서 섞인 응답 {}개: {:?}", torn.len(), &torn[..torn.len().min(3)]);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn ui_state_keeps_unknown_keys(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let seeded = serde_json::to_value(get_ui_state(&db).await.unwrap()).unwrap();
        assert_eq!(seeded, json!({"lastLayoutId": DEFAULT_ID, "theme": "dark"}));
        let state: UiState = serde_json::from_value(json!({"lastLayoutId": null, "theme": "light", "watchCollapsed": true, "nested": {"a": [1]}})).unwrap();
        put_ui_state(&db, &state).await.unwrap();
        assert_eq!(get_ui_state(&db).await.unwrap(), state);
    }
}
