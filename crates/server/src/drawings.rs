use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, put};
use serde::Deserialize;
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::api::{Revision, SymbolCode, UnixSeconds};
use crate::db::AppDb;
use crate::drawing_api::{Drawing, DrawingInput, DrawingScope};
use crate::http::{ApiFailure, AppState};
use crate::user_routes::{JSON_LIMIT, parse_symbol, read_json};
use crate::userdata::{StoreError, check_newer, corrupt, from_wire_name, wire_name};

const GROUP_CHARS: std::ops::RangeInclusive<usize> = 1..=100;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/drawings", get(list_drawings))
        .route("/api/drawings/{id}", put(put_drawing).delete(delete_drawing))
}

#[derive(Debug)]
pub enum DrawingError {
    MissingScope(String),
    Store(StoreError),
}

impl From<StoreError> for DrawingError {
    fn from(e: StoreError) -> Self {
        DrawingError::Store(e)
    }
}

impl From<sqlx::Error> for DrawingError {
    fn from(e: sqlx::Error) -> Self {
        DrawingError::Store(e.into())
    }
}

impl From<DrawingError> for ApiFailure {
    fn from(e: DrawingError) -> Self {
        match e {
            DrawingError::MissingScope(m) => ApiFailure::bad_request(m),
            DrawingError::Store(e) => e.into(),
        }
    }
}

fn read_drawing(r: &SqliteRow) -> Result<Drawing, StoreError> {
    let layout_id: Option<String> = r.get("layout_id");
    let slot: Option<i64> = r.get("slot");
    let scope = match (r.get::<String, _>("scope").as_str(), layout_id, slot) {
        ("symbol", None, None) => DrawingScope::Symbol,
        ("layout", Some(layout_id), None) => DrawingScope::Layout { layout_id },
        ("cell", Some(layout_id), Some(slot)) => DrawingScope::Cell { layout_id, slot: u8::try_from(slot).map_err(|e| corrupt("slot", e))? },
        (scope, ..) => return Err(corrupt("scope", scope)),
    };
    let periods: Option<String> = r.get("periods");
    Ok(Drawing {
        id: r.get("id"),
        symbol: SymbolCode(r.get("symbol")),
        tool: from_wire_name("tool", r.get("tool"))?,
        points: serde_json::from_str(r.get("points")).map_err(|e| corrupt("points", e))?,
        text: r.get("text"),
        style: serde_json::from_str(r.get("style")).map_err(|e| corrupt("style", e))?,
        locked: r.get::<i64, _>("locked") == 1,
        hidden: r.get::<i64, _>("hidden") == 1,
        periods: periods.map(|p| serde_json::from_str(&p).map_err(|e| corrupt("periods", e))).transpose()?,
        z: r.get("z"),
        group: r.get("group_name"),
        scope,
        revision: Revision(r.get("revision")),
        updated_at: UnixSeconds(r.get("updated_at")),
    })
}

pub async fn list_drawings_of(db: &AppDb, symbol: &str) -> Result<Vec<Drawing>, StoreError> {
    let rows = sqlx::query("SELECT * FROM drawings WHERE symbol = ? ORDER BY z, id").bind(symbol).fetch_all(db.read()).await?;
    rows.iter().map(read_drawing).collect()
}

pub async fn upsert_drawing(db: &AppDb, input: DrawingInput, now: UnixSeconds) -> Result<Drawing, DrawingError> {
    let mut tx = db.begin_write().await?;
    let stored: Option<i64> = sqlx::query_scalar("SELECT revision FROM drawings WHERE id = ?").bind(&input.id).fetch_optional(&mut *tx).await?;
    check_newer(stored, input.revision)?;
    let (scope, layout_id, slot) = match &input.scope {
        DrawingScope::Symbol => ("symbol", None, None),
        DrawingScope::Layout { layout_id } => ("layout", Some(layout_id), None),
        DrawingScope::Cell { layout_id, slot } => ("cell", Some(layout_id), Some(i64::from(*slot))),
    };
    if let Some(layout_id) = layout_id {
        let found: Option<i64> = match slot {
            None => sqlx::query_scalar("SELECT 1 FROM layouts WHERE id = ?").bind(layout_id).fetch_optional(&mut *tx).await?,
            Some(slot) => {
                sqlx::query_scalar("SELECT 1 FROM layout_cells WHERE layout_id = ? AND slot = ?").bind(layout_id).bind(slot).fetch_optional(&mut *tx).await?
            }
        };
        if found.is_none() {
            return Err(DrawingError::MissingScope(match slot {
                None => format!("드로잉 범위의 레이아웃이 없습니다: {layout_id}"),
                Some(slot) => format!("드로잉 범위의 칸이 없습니다: 레이아웃 {layout_id}, slot {slot}"),
            }));
        }
    }
    sqlx::query(
        "INSERT INTO drawings (id, symbol, tool, points, text, style, locked, hidden, periods, z, group_name, scope, layout_id, slot, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET symbol = excluded.symbol, tool = excluded.tool, points = excluded.points, text = excluded.text,
                                       style = excluded.style, locked = excluded.locked, hidden = excluded.hidden, periods = excluded.periods,
                                       z = excluded.z, group_name = excluded.group_name, scope = excluded.scope, layout_id = excluded.layout_id,
                                       slot = excluded.slot, updated_at = excluded.updated_at, revision = excluded.revision",
    )
    .bind(&input.id)
    .bind(&input.symbol.0)
    .bind(wire_name(&input.tool))
    .bind(serde_json::to_string(&input.points).expect("점은 언제나 직렬화된다"))
    .bind(&input.text)
    .bind(input.style.to_string())
    .bind(i64::from(input.locked))
    .bind(i64::from(input.hidden))
    .bind(input.periods.as_ref().map(|p| serde_json::to_string(p).expect("봉 주기는 언제나 직렬화된다")))
    .bind(input.z)
    .bind(&input.group)
    .bind(scope)
    .bind(layout_id)
    .bind(slot)
    .bind(now.0)
    .bind(input.revision.0)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(input.saved_at(now))
}

pub async fn delete_drawing_by_id(db: &AppDb, id: &str) -> Result<(), StoreError> {
    let mut tx = db.begin_write().await?;
    sqlx::query("DELETE FROM drawings WHERE id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

fn check_drawing(path_id: &str, d: &DrawingInput) -> Result<(), ApiFailure> {
    if d.id != path_id {
        return Err(ApiFailure::bad_request(format!("주소의 id({path_id})와 본문의 id({})가 다릅니다", d.id)));
    }
    parse_symbol(&d.symbol.0)?;
    let range = d.tool.point_count();
    if !range.contains(&d.points.len()) {
        return Err(ApiFailure::bad_request(format!(
            "{}의 점은 {}~{}개여야 합니다: {}개",
            wire_name(&d.tool),
            range.start(),
            range.end(),
            d.points.len()
        )));
    }
    if d.points.iter().any(|p| !p.price.is_finite()) {
        return Err(ApiFailure::bad_request("점의 가격은 유한한 수여야 합니다"));
    }
    if d.periods.as_ref().is_some_and(Vec::is_empty) {
        return Err(ApiFailure::bad_request("periods는 null이거나 봉 주기가 하나 이상이어야 합니다"));
    }
    if !d.z.is_finite() {
        return Err(ApiFailure::bad_request("z는 유한한 수여야 합니다"));
    }
    if let Some(group) = &d.group
        && !GROUP_CHARS.contains(&group.chars().count())
    {
        return Err(ApiFailure::bad_request(format!("그룹 이름은 {}~{}자여야 합니다", GROUP_CHARS.start(), GROUP_CHARS.end())));
    }
    Ok(())
}

#[derive(Deserialize)]
struct SymbolQuery {
    symbol: Option<String>,
}

async fn list_drawings(State(st): State<Arc<AppState>>, Query(q): Query<SymbolQuery>) -> Result<Json<Vec<Drawing>>, ApiFailure> {
    let code = q.symbol.ok_or_else(|| ApiFailure::bad_request("symbol이 필요합니다"))?;
    parse_symbol(&code)?;
    Ok(Json(list_drawings_of(&st.db, &code).await?))
}

async fn put_drawing(State(st): State<Arc<AppState>>, Path(id): Path<String>, body: Body) -> Result<Json<Drawing>, ApiFailure> {
    let input: DrawingInput = read_json(body, JSON_LIMIT, "드로잉 본문").await?;
    check_drawing(&id, &input)?;
    let now = UnixSeconds(st.clock.now().unix());
    Ok(Json(upsert_drawing(&st.db, input, now).await?))
}

async fn delete_drawing(State(st): State<Arc<AppState>>, Path(id): Path<String>) -> Result<StatusCode, ApiFailure> {
    delete_drawing_by_id(&st.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tower::ServiceExt;

    use super::*;
    use crate::api::{Arrangement, Cell, LayoutInput, LayoutSync, Period, Venue};
    use crate::app::{ApplicationInputs, application};
    use crate::clock::{Clock, kst};
    use crate::config::Secret;
    use crate::drawing_api::{DrawingPoint, DrawingTool};
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::rest::KiwoomRest;
    use crate::kiwoom::rest::testing::FakeTransport;
    use crate::kiwoom::stream::{KiwoomStream, StreamEvent};
    use crate::symbols::SymbolDirectory;
    use crate::userdata;

    const DEFAULT_ID: &str = "01900000-0000-7000-8000-000000000001";

    fn input(id: &str, symbol: &str, z: f64, scope: DrawingScope, revision: i64) -> DrawingInput {
        DrawingInput {
            id: id.into(),
            symbol: SymbolCode(symbol.into()),
            tool: DrawingTool::Trendline,
            points: vec![DrawingPoint { t: UnixSeconds(1_794_100_000), price: 193_400.5 }, DrawingPoint { t: UnixSeconds(1_794_200_000), price: 201_500.0 }],
            text: Some("목표".into()),
            style: json!({"v": 1, "line": {"color": "$draw", "width": 2}, "future": [1]}),
            locked: true,
            hidden: false,
            periods: Some(vec![Period::Day, Period::M5]),
            z,
            group: Some("그룹 1".into()),
            scope,
            revision: Revision(revision),
        }
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn drawings_round_trip_every_field_and_list_by_z_within_one_symbol(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = AppDb::connect(opts).await.unwrap();
        let top = upsert_drawing(&db, input("A", "005930", 2.5, DrawingScope::Symbol, 1), UnixSeconds(100)).await.unwrap();
        let cell = DrawingScope::Cell { layout_id: DEFAULT_ID.into(), slot: 0 };
        let bottom = upsert_drawing(&db, DrawingInput { group: None, periods: None, text: None, ..input("B", "005930", -1.0, cell, 1) }, UnixSeconds(200)).await.unwrap();
        let layout = DrawingScope::Layout { layout_id: DEFAULT_ID.into() };
        upsert_drawing(&db, input("C", "000660", 0.0, layout.clone(), 1), UnixSeconds(300)).await.unwrap();
        assert_eq!(list_drawings_of(&db, "005930").await.unwrap(), [bottom, top.clone()], "z 오름차순, 다른 종목은 빠진다");
        assert_eq!(top.updated_at, UnixSeconds(100));

        let moved = upsert_drawing(&db, DrawingInput { z: 9.0, locked: false, ..input("A", "005930", 0.0, layout, 2) }, UnixSeconds(400)).await.unwrap();
        let listed = list_drawings_of(&db, "005930").await.unwrap();
        assert_eq!(listed.last(), Some(&moved), "같은 id는 바꾼다");
        assert_eq!(listed.len(), 2);
        assert!(list_drawings_of(&db, "IDX:001").await.unwrap().is_empty());
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn older_or_equal_revision_never_overwrites_and_delete_is_idempotent(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = AppDb::connect(opts).await.unwrap();
        let saved = upsert_drawing(&db, input("A", "005930", 1.0, DrawingScope::Symbol, 20), UnixSeconds(1)).await.unwrap();
        for stale in [19, 20] {
            let err = upsert_drawing(&db, input("A", "005930", 5.0, DrawingScope::Symbol, stale), UnixSeconds(2)).await.unwrap_err();
            assert!(matches!(err, DrawingError::Store(StoreError::Stale(Revision(20)))), "{stale}: {err:?}");
        }
        assert_eq!(list_drawings_of(&db, "005930").await.unwrap(), [saved]);

        delete_drawing_by_id(&db, "A").await.unwrap();
        delete_drawing_by_id(&db, "A").await.unwrap();
        delete_drawing_by_id(&db, "never").await.unwrap();
        assert!(list_drawings_of(&db, "005930").await.unwrap().is_empty());
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn scope_must_name_an_existing_layout_and_cell(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = AppDb::connect(opts).await.unwrap();
        for scope in [
            DrawingScope::Layout { layout_id: "nope".into() },
            DrawingScope::Cell { layout_id: "nope".into(), slot: 0 },
            DrawingScope::Cell { layout_id: DEFAULT_ID.into(), slot: 1 },
        ] {
            let err = upsert_drawing(&db, input("A", "005930", 0.0, scope.clone(), 1), UnixSeconds(1)).await.unwrap_err();
            assert!(matches!(err, DrawingError::MissingScope(_)), "{scope:?}: {err:?}");
        }
        assert!(list_drawings_of(&db, "005930").await.unwrap().is_empty(), "거절한 PUT은 남기지 않는다");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn a_layout_scoped_drawing_blocks_deleting_its_layout(_: SqlitePoolOptions, opts: SqliteConnectOptions) {
        let db = AppDb::connect(opts).await.unwrap();
        let cell = Cell { slot: 0, symbol: SymbolCode("005930".into()), venue: Some(Venue::Krx), period: Period::Day, symbol_link: false, chart_settings: json!({}) };
        let second = LayoutInput { id: "L2".into(), name: "둘".into(), arrangement: Arrangement::One, sync: LayoutSync { crosshair: true, scroll: true }, cells: vec![cell], revision: Revision(1) };
        userdata::put_layout(&db, &second, UnixSeconds(1)).await.unwrap();
        upsert_drawing(&db, input("A", "005930", 0.0, DrawingScope::Layout { layout_id: "L2".into() }, 1), UnixSeconds(1)).await.unwrap();
        let err = userdata::delete_layout(&db, "L2").await.unwrap_err();
        assert!(matches!(&err, StoreError::Db(e) if e.0.contains("FOREIGN KEY")), "{err:?}");
        delete_drawing_by_id(&db, "A").await.unwrap();
        userdata::delete_layout(&db, "L2").await.unwrap();
    }

    #[test]
    fn point_counts_follow_the_tool_table() {
        use DrawingTool::*;
        let table = [
            (Trendline, 2, 2), (Ray, 2, 2), (Extline, 2, 2), (Arrow, 2, 2),
            (Hline, 1, 1), (Hray, 1, 1), (Vline, 1, 1),
            (Channel, 3, 3), (Fib, 2, 2), (Fibext, 3, 3),
            (Rect, 2, 2), (Ellipse, 2, 2), (Path, 2, 100), (Brush, 2, 1000),
            (Text, 1, 1), (Pricelabel, 1, 1), (Callout, 2, 2),
            (Pricerange, 2, 2), (Daterange, 2, 2), (Long, 3, 3), (Short, 3, 3),
            (Crossline, 1, 1), (Regression, 2, 2), (Pitchfork, 3, 3),
            (Fibfan, 2, 2), (Fibtime, 2, 2), (Gannfan, 2, 2), (Gannbox, 2, 2),
            (Triangle, 3, 3), (Datepricerange, 2, 2), (Avwap, 1, 1), (Volprofile, 2, 2),
            (Elliott, 6, 6), (Elliottabc, 4, 4), (Xabcd, 5, 5), (Headshoulders, 7, 7),
        ];
        assert_eq!(table.len(), 36);
        for (tool, min, max) in table {
            let with = |n: usize| DrawingInput { tool, points: vec![DrawingPoint { t: UnixSeconds(0), price: 1.0 }; n], ..input("A", "005930", 0.0, DrawingScope::Symbol, 1) };
            for n in [min, max] {
                assert!(check_drawing("A", &with(n)).is_ok(), "{tool:?} {n}");
            }
            for n in [min - 1, max + 1] {
                assert!(check_drawing("A", &with(n)).is_err(), "{tool:?} {n}");
            }
        }
    }

    #[test]
    fn wire_shape_matches_the_contract() {
        let mut d = input("A", "005930", 1.5, DrawingScope::Cell { layout_id: "L".into(), slot: 2 }, 7);
        d.periods = Some(vec![Period::M60]);
        let v = serde_json::to_value(d.saved_at(UnixSeconds(9))).unwrap();
        assert_eq!(v["tool"], "trendline");
        assert_eq!(v["scope"], json!({"kind": "cell", "layoutId": "L", "slot": 2}));
        assert_eq!(v["points"][0], json!({"t": 1_794_100_000, "price": 193_400.5}));
        assert_eq!((v["periods"].clone(), v["group"].clone(), v["revision"].clone(), v["updatedAt"].clone()), (json!(["60m"]), json!("그룹 1"), json!(7), json!(9)));
        assert_eq!(serde_json::to_value(DrawingScope::Symbol).unwrap(), json!({"kind": "symbol"}));
        assert_eq!(serde_json::to_value(DrawingScope::Layout { layout_id: "L".into() }).unwrap(), json!({"kind": "layout", "layoutId": "L"}));
        assert_eq!(serde_json::to_value(DrawingTool::Pricelabel).unwrap(), json!("pricelabel"));
    }

    struct Fixture {
        app: Router,
        kiwoom: Arc<FakeTransport>,
        _events: tokio::sync::mpsc::Sender<StreamEvent>,
        _dir: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
        let kiwoom = Arc::new(FakeTransport::new(Duration::ZERO, |s| panic!("드로잉 경로가 키움을 불렀다: {:?}", s.api_id)));
        let clock = Clock::fake(kst(domain::KstDate::new(2026, 11, 9).unwrap(), 0, 34, 0));
        let rest = KiwoomRest::new(Arc::new(kiwoom.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let (stream, _desired) = KiwoomStream::detached();
        let (events, receiver) = tokio::sync::mpsc::channel(64);
        let screener_store = crate::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap();
        let app = crate::http::router(application(ApplicationInputs { rest, clock, symbols, db, screener_store, stream: (stream, receiver), static_dir: dir.path().to_owned() }));
        Fixture { app, kiwoom, _events: events, _dir: dir }
    }

    async fn send(app: &Router, method: &str, uri: &str, body: impl Into<Body>) -> (StatusCode, Value) {
        let req = Request::builder().method(method).uri(uri).header("content-type", "application/json").body(body.into()).unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() })
    }

    fn code(v: &Value) -> &str {
        v["error"]["code"].as_str().unwrap_or("")
    }

    fn body(revision: i64) -> Value {
        json!({"id": "D1", "symbol": "005930", "tool": "channel", "text": null, "style": {"v": 1, "x": [1]},
               "locked": false, "hidden": false, "periods": null, "z": 1.5, "group": null, "scope": {"kind": "symbol"}, "revision": revision,
               "points": [{"t": 1_794_100_000, "price": 100.0}, {"t": 1_794_200_000, "price": 110.0}, {"t": 1_794_100_000, "price": 105.0}]})
    }

    #[tokio::test]
    async fn drawings_round_trip_and_rejections_over_http() {
        let f = fixture().await;
        let (s, saved) = send(&f.app, "PUT", "/api/drawings/D1", body(1).to_string()).await;
        assert_eq!(s, StatusCode::OK, "{saved}");
        let mut want = body(1);
        want["updatedAt"] = json!(1_794_152_040);
        assert_eq!(saved, want, "서버 시계(2026-11-09 00:34 KST)가 updatedAt이다");
        assert_eq!(send(&f.app, "GET", "/api/drawings?symbol=005930", Body::empty()).await, (StatusCode::OK, json!([want])));

        let with = |f: &dyn Fn(&mut Value)| {
            let mut v = body(2);
            f(&mut v);
            v.to_string()
        };
        for (uri, sent, status, want) in [
            ("/api/drawings/OTHER", with(&|_| {}), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["symbol"] = json!("bad")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["tool"] = json!("notatool")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["points"].as_array_mut().unwrap().truncate(2)), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["points"][0]["t"] = json!(1.5)), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["points"][0]["price"] = json!("1")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["periods"] = json!([])), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["periods"] = json!(["2m"])), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["z"] = json!(null)), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["group"] = json!("")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["group"] = json!("가".repeat(101))), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["scope"] = json!({"kind": "layout", "layoutId": "nope"})), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["scope"] = json!({"kind": "cell", "layoutId": DEFAULT_ID, "slot": 3})), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["scope"] = json!({"kind": "cell", "layoutId": DEFAULT_ID})), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["revision"] = json!(null)), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/drawings/D1", with(&|v| v["style"] = json!({"pad": "x".repeat(JSON_LIMIT)})), StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            ("/api/drawings/D1", with(&|v| v["revision"] = json!(1)), StatusCode::CONFLICT, "stale_revision"),
            ("/api/drawings/D1", "{\"id\": ".to_owned(), StatusCode::BAD_REQUEST, "bad_request"),
        ] {
            let (s, v) = send(&f.app, "PUT", uri, sent).await;
            assert_eq!((s, code(&v)), (status, want), "{uri} {v}");
            assert!(!v["error"]["message"].as_str().unwrap().is_empty());
        }
        assert_eq!(send(&f.app, "GET", "/api/drawings?symbol=005930", Body::empty()).await.1[0]["revision"], 1, "거절한 PUT은 저장하지 않는다");

        let brush: Vec<Value> = (0..1000).map(|i| json!({"t": 1_794_100_000 + i, "price": 193_400.5 + f64::from(i)})).collect();
        let near_limit = with(&|v| {
            v["tool"] = json!("brush");
            v["points"] = json!(brush);
            v["group"] = json!("가".repeat(100));
            v["scope"] = json!({"kind": "cell", "layoutId": DEFAULT_ID, "slot": 0});
        });
        assert!(near_limit.len() < JSON_LIMIT, "{}", near_limit.len());
        let (s, v) = send(&f.app, "PUT", "/api/drawings/D1", near_limit).await;
        assert_eq!((s, v["points"].as_array().map(Vec::len)), (StatusCode::OK, Some(1000)), "붓 1,000점과 한글 100자 그룹은 받는다");

        for uri in ["/api/drawings", "/api/drawings?symbol=", "/api/drawings?symbol=abc"] {
            let (s, v) = send(&f.app, "GET", uri, Body::empty()).await;
            assert_eq!((s, code(&v)), (StatusCode::BAD_REQUEST, "bad_request"), "{uri} {v}");
        }
        for _ in 0..2 {
            assert_eq!(send(&f.app, "DELETE", "/api/drawings/D1", Body::empty()).await, (StatusCode::NO_CONTENT, Value::Null));
        }
        assert_eq!(send(&f.app, "GET", "/api/drawings?symbol=005930", Body::empty()).await, (StatusCode::OK, json!([])));
        assert!(f.kiwoom.sent().is_empty(), "드로잉 경로는 키움에 아무것도 보내지 않는다");
    }

    #[test]
    fn json_cannot_carry_a_non_finite_price() {
        let parsed: Result<DrawingPoint, _> = serde_json::from_str(r#"{"t": 1, "price": 1e999}"#);
        assert!(parsed.is_err(), "{parsed:?}");
    }
}
