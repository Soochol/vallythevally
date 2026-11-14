
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::api::{Layout, LayoutInput, LayoutSummary, LayoutWindow, Revision, Screens, SymbolCode, UiState, UnixSeconds, WatchGroup, Watchlist, Watchlists, WindowContent, WindowId};
use crate::db::{AppDb, DbError};

#[derive(Debug)]
pub enum StoreError {
    NotFound,
    Conflict(String),
    Stale(Revision),
    Db(DbError),
}

impl From<sqlx::Error> for StoreError {
    fn from(e: sqlx::Error) -> Self {
        StoreError::Db(e.into())
    }
}

pub(crate) fn corrupt(what: &str, e: impl std::fmt::Display) -> StoreError {
    StoreError::Db(DbError(format!("저장된 {what}를 읽지 못했습니다: {e}")))
}

pub(crate) fn wire_name<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        other => unreachable!("계약 enum은 문자열로 직렬화된다: {other:?}"),
    }
}

pub(crate) fn from_wire_name<T: serde::de::DeserializeOwned>(what: &str, s: String) -> Result<T, StoreError> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| corrupt(what, e))
}

pub(crate) fn check_newer(stored: Option<i64>, sent: Revision) -> Result<(), StoreError> {
    match stored {
        Some(r) if sent.0 <= r => Err(StoreError::Stale(Revision(r))),
        _ => Ok(()),
    }
}

pub async fn get_watchlists(db: &AppDb) -> Result<Watchlists, StoreError> {
    let mut tx = db.read().begin().await?;
    let mut lists: Vec<Watchlist> = sqlx::query("SELECT id, name FROM watchlists ORDER BY position")
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r| Watchlist { id: r.get("id"), name: r.get("name"), symbols: Vec::new(), groups: Vec::new() })
        .collect();
    let items = sqlx::query("SELECT list_id, symbol FROM watchlist_items ORDER BY list_id, position").fetch_all(&mut *tx).await?;
    for item in items {
        let list_id: String = item.get("list_id");
        let list = lists.iter_mut().find(|l| l.id == list_id).ok_or_else(|| corrupt("watchlist_items", &list_id))?;
        list.symbols.push(SymbolCode(item.get("symbol")));
    }
    let groups = sqlx::query("SELECT id, list_id, name FROM watch_groups ORDER BY list_id, position").fetch_all(&mut *tx).await?;
    for group in groups {
        let list_id: String = group.get("list_id");
        let list = lists.iter_mut().find(|l| l.id == list_id).ok_or_else(|| corrupt("watch_groups", &list_id))?;
        list.groups.push(WatchGroup { id: group.get("id"), name: group.get("name"), symbols: Vec::new() });
    }
    let grouped = sqlx::query("SELECT group_id, list_id, symbol FROM watch_group_items ORDER BY group_id, position").fetch_all(&mut *tx).await?;
    for item in grouped {
        let (group_id, list_id): (String, String) = (item.get("group_id"), item.get("list_id"));
        let group = lists
            .iter_mut()
            .find(|l| l.id == list_id)
            .and_then(|l| l.groups.iter_mut().find(|g| g.id == group_id))
            .ok_or_else(|| corrupt("watch_group_items", &group_id))?;
        group.symbols.push(SymbolCode(item.get("symbol")));
    }
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM watchlist_revision WHERE singleton = 1").fetch_one(&mut *tx).await?;
    Ok(Watchlists { lists, revision: Revision(revision) })
}

pub async fn put_watchlists(db: &AppDb, all: &Watchlists) -> Result<(), StoreError> {
    let mut tx = db.begin_write().await?;
    let stored: Option<i64> = sqlx::query_scalar("SELECT revision FROM watchlist_revision WHERE singleton = 1").fetch_optional(&mut *tx).await?;
    check_newer(stored, all.revision)?;
    sqlx::query("UPDATE watchlist_revision SET revision = ? WHERE singleton = 1").bind(all.revision.0).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM watchlists").execute(&mut *tx).await?;
    for (list_position, list) in all.lists.iter().enumerate() {
        sqlx::query("INSERT INTO watchlists (id, name, position) VALUES (?, ?, ?)")
            .bind(&list.id)
            .bind(&list.name)
            .bind(list_position as i64)
            .execute(&mut *tx)
            .await?;
        for (position, symbol) in list.symbols.iter().enumerate() {
            sqlx::query("INSERT INTO watchlist_items (list_id, symbol, position) VALUES (?, ?, ?)")
                .bind(&list.id)
                .bind(&symbol.0)
                .bind(position as i64)
                .execute(&mut *tx)
                .await?;
        }
        for (group_position, group) in list.groups.iter().enumerate() {
            sqlx::query("INSERT INTO watch_groups (id, list_id, name, position) VALUES (?, ?, ?, ?)")
                .bind(&group.id)
                .bind(&list.id)
                .bind(&group.name)
                .bind(group_position as i64)
                .execute(&mut *tx)
                .await?;
            for (position, symbol) in group.symbols.iter().enumerate() {
                sqlx::query("INSERT INTO watch_group_items (group_id, list_id, symbol, position) VALUES (?, ?, ?, ?)")
                    .bind(&group.id)
                    .bind(&list.id)
                    .bind(&symbol.0)
                    .bind(position as i64)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn get_screens(db: &AppDb) -> Result<Screens, StoreError> {
    let row = sqlx::query("SELECT list, revision FROM screens WHERE singleton = 1").fetch_one(db.read()).await?;
    let screens = serde_json::from_str(row.get("list")).map_err(|e| corrupt("screens", e))?;
    Ok(Screens { screens, revision: Revision(row.get("revision")) })
}

pub async fn put_screens(db: &AppDb, all: &Screens) -> Result<(), StoreError> {
    let list = serde_json::to_string(&all.screens).expect("Screen은 언제나 직렬화된다");
    let mut tx = db.begin_write().await?;
    let stored: Option<i64> = sqlx::query_scalar("SELECT revision FROM screens WHERE singleton = 1").fetch_optional(&mut *tx).await?;
    check_newer(stored, all.revision)?;
    sqlx::query("UPDATE screens SET list = ?, revision = ? WHERE singleton = 1").bind(list).bind(all.revision.0).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn list_layouts(db: &AppDb) -> Result<Vec<LayoutSummary>, StoreError> {
    let rows = sqlx::query("SELECT id, name, updated_at FROM layouts ORDER BY position, rowid").fetch_all(db.read()).await?;
    Ok(rows.into_iter().map(|r| LayoutSummary { id: r.get("id"), name: r.get("name"), updated_at: UnixSeconds(r.get("updated_at")) }).collect())
}

fn read_window(r: &SqliteRow) -> Result<LayoutWindow, StoreError> {
    let id = WindowId::try_from(r.get::<String, _>("id")).map_err(|e| corrupt("창 id", e))?;
    let link: Option<String> = r.get("link");
    let kind: String = r.get("kind");
    let content = match kind.as_str() {
        "chart" => {
            let venue: Option<String> = r.get("venue");
            let (symbol, period, chart_settings): (Option<String>, Option<String>, Option<String>) = (r.get("symbol"), r.get("period"), r.get("chart_settings"));
            let (Some(symbol), Some(period), Some(chart_settings)) = (symbol, period, chart_settings) else {
                return Err(corrupt("차트 창", id.as_str()));
            };
            WindowContent::Chart {
                symbol: SymbolCode(symbol),
                venue: venue.map(|v| from_wire_name("venue", v)).transpose()?,
                period: from_wire_name("period", period)?,
                chart_settings: serde_json::from_str(&chart_settings).map_err(|e| corrupt("chart_settings", e))?,
            }
        }
        _ => serde_json::from_value(serde_json::json!({ "kind": kind })).map_err(|e| corrupt("창 종류", e))?,
    };
    Ok(LayoutWindow { id, link: link.map(|l| from_wire_name("link", l)).transpose()?, content })
}

/// 레이아웃 행과 창을 한 읽기 트랜잭션에서 읽는다. WAL에서는 첫 SELECT가 스냅숏을 고정한다.
pub async fn get_layout(db: &AppDb, id: &str) -> Result<Layout, StoreError> {
    let mut tx = db.read().begin().await?;
    let row = sqlx::query("SELECT name, sync, placement, updated_at, revision FROM layouts WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::NotFound)?;
    let windows = sqlx::query("SELECT * FROM layout_windows WHERE layout_id = ? ORDER BY position")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(read_window)
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(Layout {
        id: id.to_owned(),
        name: row.get("name"),
        sync: serde_json::from_str(row.get("sync")).map_err(|e| corrupt("sync", e))?,
        windows,
        placement: serde_json::from_str(row.get("placement")).map_err(|e| corrupt("placement", e))?,
        updated_at: UnixSeconds(row.get("updated_at")),
        revision: Revision(row.get("revision")),
    })
}

pub async fn put_layout(db: &AppDb, input: &LayoutInput, now: UnixSeconds) -> Result<Layout, StoreError> {
    let mut tx = db.begin_write().await?;
    let stored: Option<i64> = sqlx::query_scalar("SELECT revision FROM layouts WHERE id = ?").bind(&input.id).fetch_optional(&mut *tx).await?;
    check_newer(stored, input.revision)?;
    let taken: Option<String> = sqlx::query_scalar("SELECT id FROM layouts WHERE name = ? AND id <> ?")
        .bind(&input.name)
        .bind(&input.id)
        .fetch_optional(&mut *tx)
        .await?;
    if taken.is_some() {
        return Err(StoreError::Conflict(format!("같은 이름의 레이아웃이 이미 있습니다: {}", input.name)));
    }
    let sync = serde_json::to_string(&input.sync).expect("LayoutSync는 언제나 직렬화된다");
    let placement = serde_json::to_string(&input.placement).expect("JSON 객체는 언제나 직렬화된다");
    sqlx::query(
        "INSERT INTO layouts (id, name, sync, placement, position, updated_at, revision)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM layouts), ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, sync = excluded.sync, placement = excluded.placement,
                                       updated_at = excluded.updated_at, revision = excluded.revision",
    )
    .bind(&input.id)
    .bind(&input.name)
    .bind(sync)
    .bind(placement)
    .bind(now.0)
    .bind(input.revision.0)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM layout_windows WHERE layout_id = ?").bind(&input.id).execute(&mut *tx).await?;
    for (position, w) in input.windows.iter().enumerate() {
        let (symbol, venue, period, chart_settings) = match &w.content {
            WindowContent::Chart { symbol, venue, period, chart_settings } => {
                (Some(&symbol.0), venue.as_ref().map(wire_name), Some(wire_name(period)), Some(chart_settings.to_string()))
            }
            WindowContent::Watchlist | WindowContent::Screener | WindowContent::Objects | WindowContent::Indicators => (None, None, None, None),
        };
        sqlx::query(
            "INSERT INTO layout_windows (layout_id, id, position, kind, link, symbol, venue, period, chart_settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&input.id)
        .bind(w.id.as_str())
        .bind(position as i64)
        .bind(window_kind(&w.content))
        .bind(w.link.as_ref().map(wire_name))
        .bind(symbol)
        .bind(venue)
        .bind(period)
        .bind(chart_settings)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE drawings SET scope = 'layout', window_id = NULL, updated_at = ?
         WHERE scope = 'cell' AND layout_id = ?
           AND window_id NOT IN (SELECT id FROM layout_windows WHERE layout_id = ? AND kind = 'chart')",
    )
    .bind(now.0)
    .bind(&input.id)
    .bind(&input.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Layout {
        id: input.id.clone(),
        name: input.name.clone(),
        sync: input.sync,
        windows: input.windows.clone(),
        placement: input.placement.clone(),
        updated_at: now,
        revision: input.revision,
    })
}

pub(crate) fn window_kind(content: &WindowContent) -> String {
    match serde_json::to_value(content) {
        Ok(serde_json::Value::Object(mut fields)) => match fields.remove("kind") {
            Some(serde_json::Value::String(kind)) => kind,
            other => unreachable!("창 내용은 kind 문자열로 갈린다: {other:?}"),
        },
        other => unreachable!("창 내용은 객체로 직렬화된다: {other:?}"),
    }
}

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
    let row = sqlx::query("SELECT state, revision FROM ui_state WHERE singleton = 1").fetch_one(db.read()).await?;
    let mut state: UiState = serde_json::from_str(row.get("state")).map_err(|e| corrupt("ui_state", e))?;
    state.0.insert("revision".into(), row.get::<i64, _>("revision").into());
    Ok(state)
}

pub async fn put_ui_state(db: &AppDb, state: &UiState, revision: Revision) -> Result<(), StoreError> {
    let mut fields = state.0.clone();
    fields.remove("revision");
    let text = serde_json::to_string(&fields).expect("UiState는 언제나 직렬화된다");
    let mut tx = db.begin_write().await?;
    let stored: Option<i64> = sqlx::query_scalar("SELECT revision FROM ui_state WHERE singleton = 1").fetch_optional(&mut *tx).await?;
    check_newer(stored, revision)?;
    sqlx::query(
        "INSERT INTO ui_state (singleton, state, revision) VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET state = excluded.state, revision = excluded.revision",
    )
    .bind(text)
    .bind(revision.0)
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
    use crate::api::{LayoutSync, LinkColor, Period, Venue};

    const DEFAULT_ID: &str = "01900000-0000-7000-8000-000000000001";

    async fn db(opts: SqliteConnectOptions) -> AppDb {
        AppDb::connect(opts).await.unwrap()
    }

    const FIRST_LIST_ID: &str = "01900000-0000-7000-8000-000000000002";

    fn codes(all: &Watchlists) -> Vec<(&str, Vec<&str>)> {
        all.lists.iter().map(|l| (l.name.as_str(), l.symbols.iter().map(|s| s.0.as_str()).collect())).collect()
    }

    fn list(id: &str, name: &str, codes: &[&str]) -> Watchlist {
        Watchlist { id: id.into(), name: name.into(), symbols: symbols(codes), groups: Vec::new() }
    }

    fn symbols(codes: &[&str]) -> Vec<SymbolCode> {
        codes.iter().map(|c| SymbolCode((*c).into())).collect()
    }

    fn group(id: &str, name: &str, codes: &[&str]) -> WatchGroup {
        WatchGroup { id: id.into(), name: name.into(), symbols: symbols(codes) }
    }

    fn watch(lists: Vec<Watchlist>, revision: i64) -> Watchlists {
        Watchlists { lists, revision: Revision(revision) }
    }

    fn window_id(id: &str) -> WindowId {
        WindowId::try_from(id.to_owned()).unwrap()
    }

    fn chart(id: &str, symbol: &str, venue: Option<Venue>) -> LayoutWindow {
        let content = WindowContent::Chart { symbol: SymbolCode(symbol.into()), venue, period: Period::M5, chart_settings: json!({"v": 1, "future": [id]}) };
        LayoutWindow { id: window_id(id), link: None, content }
    }

    fn side(content: WindowContent) -> LayoutWindow {
        LayoutWindow { id: window_id(&window_kind(&content)), link: None, content }
    }

    fn layout(id: &str, name: &str, windows: Vec<LayoutWindow>) -> LayoutInput {
        layout_at(id, name, windows, 1)
    }

    fn layout_at(id: &str, name: &str, windows: Vec<LayoutWindow>, revision: i64) -> LayoutInput {
        let placement = json!({"v": 1, "windows": windows.len(), "future": {"dock": null}}).as_object().unwrap().clone();
        LayoutInput { id: id.into(), name: name.into(), sync: LayoutSync { crosshair: false, scroll: true }, windows, placement, revision: Revision(revision) }
    }

    fn kinds(layout: &Layout) -> Vec<(&str, String, Option<LinkColor>)> {
        layout.windows.iter().map(|w| (w.id.as_str(), window_kind(&w.content), w.link)).collect()
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn watchlists_round_trip_in_order_and_replace_whole(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let seeded = get_watchlists(&db).await.unwrap();
        assert_eq!((codes(&seeded), seeded.lists[0].id.as_str(), seeded.revision), (vec![("기본", vec![])], FIRST_LIST_ID, Revision(0)));

        let three = watch(vec![list("B", "둘", &["000660", "005930"]), list(FIRST_LIST_ID, "기본", &["005930", "IDX:001"]), list("C", "셋", &[])], 1);
        put_watchlists(&db, &three).await.unwrap();
        assert_eq!(get_watchlists(&db).await.unwrap(), three, "목록 사이 순서와 목록 안 순서를 그대로 돌려준다");

        let two = watch(vec![list(FIRST_LIST_ID, "기본", &["IDX:001"]), list("C", "셋 바꿈", &["005930"])], 2);
        put_watchlists(&db, &two).await.unwrap();
        assert_eq!(get_watchlists(&db).await.unwrap(), two, "지운 목록과 그 종목은 남지 않는다");
        let orphans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM watchlist_items WHERE list_id = 'B'").fetch_one(db.read()).await.unwrap();
        assert_eq!(orphans, 0);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn watch_groups_round_trip_in_order_and_go_with_their_list(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let mut first = list(FIRST_LIST_ID, "기본", &["005930", "000660", "IDX:001", "035420", "051910"]);
        first.groups = vec![group("G2", "관찰", &["051910", "005930"]), group("G1", "반도체", &["000660", "005930"]), group("G3", "빈 그룹", &[])];
        let mut second = list("B", "둘", &["005930", "000660"]);
        second.groups = vec![group("G4", "반도체", &["000660", "005930"])];
        let grouped = watch(vec![first, second], 1);
        put_watchlists(&db, &grouped).await.unwrap();
        assert_eq!(get_watchlists(&db).await.unwrap(), grouped, "그룹 사이 순서와 그룹 안 순서를 그대로 돌려준다");

        let mut regrouped = list(FIRST_LIST_ID, "기본", &["005930", "000660"]);
        regrouped.groups = vec![group("G1", "반도체", &["005930", "000660"])];
        let after = watch(vec![regrouped], 2);
        put_watchlists(&db, &after).await.unwrap();
        assert_eq!(get_watchlists(&db).await.unwrap(), after, "지운 목록·그룹과 그 종목은 남지 않는다");
        let groups: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM watch_groups").fetch_one(db.read()).await.unwrap();
        let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM watch_group_items").fetch_one(db.read()).await.unwrap();
        assert_eq!((groups, items), (1, 2));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn db_rejects_a_grouped_symbol_outside_its_list_or_twice_in_one_group(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let saved = watch(vec![list(FIRST_LIST_ID, "기본", &["005930"])], 1);
        put_watchlists(&db, &saved).await.unwrap();
        let mut outside = list(FIRST_LIST_ID, "기본", &["005930"]);
        outside.groups = vec![group("G1", "가", &["000660"])];
        let mut twice = list(FIRST_LIST_ID, "기본", &["005930"]);
        twice.groups = vec![group("G1", "가", &["005930", "005930"])];
        for (i, bad) in [outside, twice].into_iter().enumerate() {
            let err = put_watchlists(&db, &watch(vec![bad], 2 + i as i64)).await.unwrap_err();
            assert!(matches!(&err, StoreError::Db(e) if e.0.contains("constraint")), "{err:?}");
        }
        assert_eq!(get_watchlists(&db).await.unwrap(), saved, "실패한 트랜잭션은 아무것도 바꾸지 않는다");
    }

    #[tokio::test]
    async fn migration_preserves_single_group_data_and_revision_then_allows_overlap() {
        let tmp = tempfile::tempdir_in("target").unwrap();
        let path = tmp.path().join("vally.db");
        {
            let pool = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true)).await.unwrap();
            sqlx::migrate!("./migrations").run_to(9, &pool).await.unwrap();
            sqlx::query("INSERT INTO watchlist_items (list_id, symbol, position) VALUES (?, '0158S0', 0), (?, '005930', 1)")
                .bind(FIRST_LIST_ID).bind(FIRST_LIST_ID).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO watch_groups (id, list_id, name, position) VALUES ('G2', ?, '관찰', 0), ('G1', ?, '빈 그룹', 1)")
                .bind(FIRST_LIST_ID).bind(FIRST_LIST_ID).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO watch_group_items (group_id, list_id, symbol, position) VALUES ('G2', ?, '005930', 0), ('G2', ?, '0158S0', 1)")
                .bind(FIRST_LIST_ID).bind(FIRST_LIST_ID).execute(&pool).await.unwrap();
            sqlx::query("UPDATE watchlist_revision SET revision = 41").execute(&pool).await.unwrap();
            pool.close().await;
        }
        let db = AppDb::open(&path).await.unwrap();
        let mut original = list(FIRST_LIST_ID, "기본", &["0158S0", "005930"]);
        original.groups = vec![group("G2", "관찰", &["005930", "0158S0"]), group("G1", "빈 그룹", &[])];
        assert_eq!(get_watchlists(&db).await.unwrap(), watch(vec![original.clone()], 41));
        original.groups[1].symbols.push(SymbolCode("0158S0".into()));
        let overlap = watch(vec![original], 42);
        put_watchlists(&db, &overlap).await.unwrap();
        assert_eq!(get_watchlists(&db).await.unwrap(), overlap);
        assert!(matches!(put_watchlists(&db, &overlap).await, Err(StoreError::Stale(Revision(42)))));
        drop(db);
        assert_eq!(get_watchlists(&AppDb::open(&path).await.unwrap()).await.unwrap(), overlap);
    }

    #[tokio::test]
    async fn migration_moves_the_single_watchlist_into_the_first_list() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vally.db");
        {
            let pool = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true)).await.unwrap();
            sqlx::migrate!("./migrations").run_to(2, &pool).await.unwrap();
            for (symbol, position) in [("005930", 0), ("IDX:001", 1), ("000660", 2)] {
                sqlx::query("INSERT INTO watchlist (symbol, position) VALUES (?, ?)").bind(symbol).bind(position).execute(&pool).await.unwrap();
            }
            sqlx::query("UPDATE watchlist_revision SET revision = 1794222949877").execute(&pool).await.unwrap();
            pool.close().await;
        }
        let db = AppDb::open(&path).await.unwrap();
        let migrated = get_watchlists(&db).await.unwrap();
        assert_eq!(migrated, watch(vec![list(FIRST_LIST_ID, "기본", &["005930", "IDX:001", "000660"])], 1_794_222_949_877));
        assert!(matches!(put_watchlists(&db, &watch(vec![list(FIRST_LIST_ID, "기본", &[])], 1_794_222_949_877)).await, Err(StoreError::Stale(_))), "옛 탭의 늦은 저장은 여전히 막힌다");
    }

    #[tokio::test]
    async fn migration_turns_cells_into_chart_windows_and_adds_the_side_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vally.db");
        {
            let pool = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true).foreign_keys(true)).await.unwrap();
            sqlx::migrate!("./migrations").run_to(10, &pool).await.unwrap();
            sqlx::query("INSERT INTO layouts (id, name, arrangement, sync, position, updated_at, revision) VALUES ('L2', '둘', '2h', '{}', 1, 50, 7)")
                .execute(&pool).await.unwrap();
            sqlx::query(
                "INSERT INTO layout_cells (layout_id, slot, symbol, venue, period, symbol_link, chart_settings) VALUES
                 ('L2', 0, '005930', 'nxt', '5m', 0, '{\"v\":1,\"left\":true}'), ('L2', 1, 'IDX:101', NULL, 'W', 1, '{\"v\":1}')",
            )
            .execute(&pool).await.unwrap();
            sqlx::query(
                "INSERT INTO drawings (id, symbol, tool, points, style, z, scope, layout_id, slot, updated_at, revision) VALUES
                 ('D1', 'IDX:101', 'hline', '[{\"t\":1,\"price\":2}]', '{}', 0, 'cell', 'L2', 1, 40, 41),
                 ('D2', 'IDX:101', 'hline', '[{\"t\":1,\"price\":2}]', '{}', 1, 'cell', 'L2', 3, 40, 42),
                 ('D3', 'IDX:101', 'hline', '[{\"t\":1,\"price\":2}]', '{}', 2, 'layout', 'L2', NULL, 40, 43)",
            )
            .execute(&pool).await.unwrap();
            pool.close().await;
        }
        let db = AppDb::open(&path).await.unwrap();
        let migrated = get_layout(&db, "L2").await.unwrap();
        assert_eq!(
            kinds(&migrated),
            [
                ("cell-0", "chart".into(), None),
                ("cell-1", "chart".into(), Some(LinkColor::A)),
                ("watchlist", "watchlist".into(), None),
                ("screener", "screener".into(), None),
                ("objects", "objects".into(), None),
            ]
        );
        assert_eq!(
            migrated.windows[0].content,
            WindowContent::Chart { symbol: SymbolCode("005930".into()), venue: Some(Venue::Nxt), period: Period::M5, chart_settings: json!({"v": 1, "left": true}) }
        );
        assert!(matches!(&migrated.windows[1].content, WindowContent::Chart { venue: None, period: Period::Week, .. }));
        assert_eq!((migrated.placement.is_empty(), migrated.revision, migrated.updated_at), (true, Revision(7), UnixSeconds(50)));
        assert_eq!(kinds(&get_layout(&db, DEFAULT_ID).await.unwrap()).len(), 4, "기본 레이아웃도 차트 창 하나와 오른쪽 창 셋");

        let drawings = crate::drawings::list_drawings_of(&db, "IDX:101").await.unwrap();
        let scopes: Vec<_> = drawings.iter().map(|d| (d.id.as_str(), d.scope.clone(), d.revision)).collect();
        let layout_scope = crate::drawing_api::DrawingScope::Layout { layout_id: "L2".into() };
        assert_eq!(
            scopes,
            [
                ("D1", crate::drawing_api::DrawingScope::Cell { layout_id: "L2".into(), window_id: window_id("cell-1") }, Revision(41)),
                ("D2", layout_scope.clone(), Revision(42)),
                ("D3", layout_scope, Revision(43)),
            ],
            "slot 1은 창 cell-1, 없는 칸을 가리키던 드로잉은 이 레이아웃으로 넓힌다"
        );
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn quarterly_and_yearly_chart_periods_survive_storage(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let with_period = |mut w: LayoutWindow, p: Period| {
            if let WindowContent::Chart { period, .. } = &mut w.content {
                *period = p;
            }
            w
        };
        let windows = vec![with_period(chart("q", "005930", Some(Venue::Combined)), Period::Quarter), with_period(chart("y", "IDX:001", None), Period::Year)];
        let input = layout("QY", "분기·연간", windows.clone());
        let saved = put_layout(&db, &input, UnixSeconds(100)).await.unwrap();
        assert_eq!(get_layout(&db, "QY").await.unwrap(), saved);
        assert_eq!(saved.windows, windows);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn layout_upsert_replaces_windows_and_lists_in_position_order(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let seeded = get_layout(&db, DEFAULT_ID).await.unwrap();
        assert_eq!(seeded.name, "기본");
        assert_eq!(
            kinds(&seeded),
            [("cell-0", "chart".into(), None), ("watchlist", "watchlist".into(), None), ("screener", "screener".into(), None), ("objects", "objects".into(), None)]
        );
        assert!(matches!(&seeded.windows[0].content, WindowContent::Chart { symbol, venue: None, .. } if symbol.0 == "IDX:001"));
        assert!(seeded.placement.is_empty());

        let mut linked = chart("right", "005930", Some(Venue::Nxt));
        linked.link = Some(LinkColor::B);
        let mut screener = side(WindowContent::Screener);
        screener.link = Some(LinkColor::C);
        let windows = vec![screener, linked, side(WindowContent::Indicators), chart("left", "IDX:101", None), side(WindowContent::Objects)];
        let saved = put_layout(&db, &layout("L2", "둘", windows.clone()), UnixSeconds(100)).await.unwrap();
        let read = get_layout(&db, "L2").await.unwrap();
        assert_eq!(saved, read);
        assert_eq!(read.windows, windows, "창의 순서, 연동 색, 차트 창의 내용을 그대로 돌려준다");
        assert_eq!(serde_json::Value::Object(read.placement.clone()), json!({"v": 1, "windows": 5, "future": {"dock": null}}), "배치는 모르는 키도 그대로");
        assert_eq!(read.sync, LayoutSync { crosshair: false, scroll: true });

        let one = layout_at("L2", "둘 바꿈", vec![chart("only", "000660", Some(Venue::Krx))], 2);
        put_layout(&db, &one, UnixSeconds(200)).await.unwrap();
        let read = get_layout(&db, "L2").await.unwrap();
        assert_eq!((read.windows.len(), read.updated_at, read.name.as_str()), (1, UnixSeconds(200), "둘 바꿈"), "창을 통째로 바꾼다");

        let names: Vec<_> = list_layouts(&db).await.unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["기본", "둘 바꿈"], "바꿔도 자리는 그대로");
        assert!(matches!(get_layout(&db, "nope").await, Err(StoreError::NotFound)));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn duplicate_name_conflicts_and_last_layout_cannot_be_deleted(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let dup = layout("L2", "기본", vec![chart("c", "005930", Some(Venue::Combined))]);
        assert!(matches!(put_layout(&db, &dup, UnixSeconds(1)).await, Err(StoreError::Conflict(_))));
        assert!(matches!(delete_layout(&db, DEFAULT_ID).await, Err(StoreError::Conflict(_))));
        assert!(matches!(delete_layout(&db, "nope").await, Err(StoreError::NotFound)));

        put_layout(&db, &layout("L2", "둘", vec![chart("c", "005930", Some(Venue::Combined))]), UnixSeconds(1)).await.unwrap();
        delete_layout(&db, DEFAULT_ID).await.unwrap();
        let windows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layout_windows WHERE layout_id = ?").bind(DEFAULT_ID).fetch_one(db.read()).await.unwrap();
        assert_eq!(windows, 0, "foreign_keys가 켜져 있어 창도 함께 지워진다");
        assert!(matches!(delete_layout(&db, "L2").await, Err(StoreError::Conflict(_))));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn db_rejects_venue_on_an_index_and_a_stock_without_venue(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        for bad in [chart("c", "IDX:001", Some(Venue::Krx)), chart("c", "005930", None)] {
            let err = put_layout(&db, &layout("L2", "둘", vec![bad]), UnixSeconds(1)).await.unwrap_err();
            assert!(matches!(&err, StoreError::Db(e) if e.0.contains("CHECK")), "{err:?}");
        }
        assert!(matches!(get_layout(&db, "L2").await, Err(StoreError::NotFound)), "실패한 트랜잭션은 레이아웃도 남기지 않는다");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn older_or_equal_revisions_never_overwrite(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = db(opts).await;
        let newest = watch(vec![list(FIRST_LIST_ID, "기본", &["005930", "000660"])], 20);
        put_watchlists(&db, &newest).await.unwrap();
        for stale in [19, 20] {
            let old = watch(vec![list(FIRST_LIST_ID, "기본", &["005930"])], stale);
            assert!(matches!(put_watchlists(&db, &old).await, Err(StoreError::Stale(Revision(20)))), "{stale}");
        }
        assert_eq!(get_watchlists(&db).await.unwrap(), newest);

        let new = layout_at("L2", "새", vec![chart("c", "005930", Some(Venue::Krx))], 20);
        put_layout(&db, &new, UnixSeconds(1)).await.unwrap();
        let old = layout_at("L2", "옛", vec![chart("c", "000660", Some(Venue::Krx))], 19);
        assert!(matches!(put_layout(&db, &old, UnixSeconds(2)).await, Err(StoreError::Stale(Revision(20)))));
        let read = get_layout(&db, "L2").await.unwrap();
        assert_eq!((read.name.as_str(), read.revision, read.updated_at), ("새", Revision(20), UnixSeconds(1)));

        let ui = |theme: &str| -> UiState { serde_json::from_value(json!({"lastLayoutId": null, "theme": theme})).unwrap() };
        put_ui_state(&db, &ui("light"), Revision(20)).await.unwrap();
        assert!(matches!(put_ui_state(&db, &ui("dark"), Revision(20)).await, Err(StoreError::Stale(Revision(20)))));
        let read = get_ui_state(&db).await.unwrap();
        assert_eq!(serde_json::to_value(read).unwrap(), json!({"lastLayoutId": null, "theme": "light", "revision": 20}));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn get_layout_never_mixes_two_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("vally.db")).await.unwrap();
        let one = layout("R", "race", vec![chart("a", "005930", Some(Venue::Krx))]);
        let two = layout("R", "race", vec![chart("a", "005930", Some(Venue::Krx)), chart("b", "000660", Some(Venue::Krx)), side(WindowContent::Watchlist)]);
        put_layout(&db, &one, UnixSeconds(0)).await.unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let (db, stop) = (db.clone(), stop.clone());
            tokio::spawn(async move {
                for i in 0..400 {
                    let next = LayoutInput { revision: Revision(i + 2), ..if i % 2 == 0 { two.clone() } else { one.clone() } };
                    put_layout(&db, &next, UnixSeconds(i)).await.unwrap();
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
                        if l.placement["windows"] != l.windows.len() {
                            torn.push((l.placement["windows"].clone(), l.windows.len()));
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
        assert_eq!(seeded, json!({"lastLayoutId": DEFAULT_ID, "theme": "dark", "revision": 0}));
        let state: UiState = serde_json::from_value(json!({"lastLayoutId": null, "theme": "light", "watchCollapsed": true, "nested": {"a": [1]}, "revision": 1})).unwrap();
        put_ui_state(&db, &state, Revision(1)).await.unwrap();
        assert_eq!(get_ui_state(&db).await.unwrap(), state);
    }
}
