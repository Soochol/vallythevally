use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::KstDate;
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::shared_data::{FlowDescription, FlowRow, FlowWriter, flow_links_path, flow_path};
use server::symbols::SymbolDirectory;
use support::ScriptedTransport;
use tower::ServiceExt;

const CLOSED: &str = "20261123";
const TODAY: &str = "20261124";
const SAMSUNG_BUCKET: &str = "056.parquet";

fn at(day: u8, hour: u32, minute: u32, second: u32) -> i64 {
    kst(KstDate::new(2026, 11, day).unwrap(), hour, minute, second).unix()
}

struct Harness {
    app: Router,
    clock: Clock,
    data: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(enabled: bool) -> Harness {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 24).unwrap(), 10, 0, 0));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(ScriptedTransport::new().transport(), auth, clock.clone());
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let symbols = Arc::new(SymbolDirectory::default());
        let state = application(ApplicationInputs { rest, clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        let data = tmp.path().join("hoga");
        if enabled {
            state.collector_paths.configure(server::shared_data::CollectorPaths::hoga_only(data.clone()));
        }
        Harness { app: router(state), clock, data, _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }

    async fn day(&self, date: &str, after: Option<&str>) -> Value {
        let after = after.map_or(String::new(), |cursor| format!("&after={cursor}"));
        let (status, body) = self.get(&format!("/api/symbols/005930/brokers?date={date}{after}")).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    fn shared(&self) -> PathBuf {
        self.data.join("shared")
    }

    fn write_flow(&self, key: &str, rows: &[FlowRow]) {
        let path = flow_path(&self.shared(), TODAY, "0F", "005930", key);
        let fids: Vec<u32> = (141..=180).collect();
        FlowWriter::open(&path, FlowDescription::new("0F", "005930", TODAY, key, &fids)).unwrap().append(rows).unwrap();
    }

    fn write_links(&self, key: &str, lines: &[(i64, &str)]) {
        let path = flow_links_path(&self.shared(), TODAY, key);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: String = lines.iter().map(|(t, event)| format!("{}\n", json!({"t": t * 1000, "event": event}))).collect();
        std::fs::write(path, text).unwrap();
    }
}

fn flow_row(recv_s: i64, buy_qty: &str) -> FlowRow {
    let values = (141..=180)
        .map(|fid| match fid {
            141 => Some("삼  성 ".to_owned()),
            146 => Some("030".to_owned()),
            151 => Some(" 키움증권".to_owned()),
            156 => Some("050".to_owned()),
            161 => Some("90".to_owned()),
            166 => Some("-5".to_owned()),
            171 => Some(buy_qty.to_owned()),
            176 => Some("+7".to_owned()),
            _ => None,
        })
        .collect();
    FlowRow { recv_ms: recv_s * 1000 + 250, values }
}

fn store_sql(symbol: &str, recv_s: i64, buy_qty: i64) -> String {
    let mut columns = vec![format!("'{symbol}' AS symbol"), format!("{}::BIGINT AS recv_ms", recv_s * 1000 + 250)];
    for fid in 141..=180 {
        let value = match fid {
            141 => "'삼  성 '".to_owned(),
            146 => "'030'".to_owned(),
            151 => "' 키움증권'".to_owned(),
            156 => "'050'".to_owned(),
            161 => "90::BIGINT".to_owned(),
            166 => "(-5)::BIGINT".to_owned(),
            171 => format!("{buy_qty}::BIGINT"),
            176 => "7::BIGINT".to_owned(),
            142..=145 | 147..=150 | 152..=155 | 157..=160 => "''".to_owned(),
            _ => "NULL::BIGINT".to_owned(),
        };
        columns.push(format!("{value} AS f{fid}"));
    }
    format!("SELECT {}", columns.join(", "))
}

fn write_store(data: &Path, date: &str, rows: &[String], gaps: Value) {
    let folder = data.join("store").join(date);
    let parquet = folder.join("0F").join(SAMSUNG_BUCKET);
    std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(&format!("SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)", rows.join(" UNION ALL "), parquet.display())).unwrap();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": 64},
        "raw_files": {"collect-01/0900-000.jsonl.zst": 10, "collect-01/2000-000.jsonl.zst": 10},
        "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": gaps, "handoff": null}],
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn times(body: &Value) -> Vec<i64> {
    body["snapshots"].as_array().unwrap().iter().map(|snapshot| snapshot["t"].as_i64().unwrap()).collect()
}

fn buys(body: &Value) -> Vec<i64> {
    body["snapshots"].as_array().unwrap().iter().map(|snapshot| snapshot["buys"][0]["qty"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn a_closed_day_comes_from_the_store_with_its_gaps() {
    let h = Harness::start(true).await;
    let rows = [
        store_sql("000120_AL", at(23, 9, 0, 30), 999),
        store_sql("005930_AL", at(23, 9, 0, 10), 100),
        store_sql("005930_AL", at(23, 9, 5, 0), 300),
        store_sql("005930_AL", at(23, 15, 20, 0), 450),
    ];
    write_store(&h.data, CLOSED, &rows, json!([{"from_ms": at(23, 10, 0, 0) * 1000, "to_ms": at(23, 10, 2, 0) * 1000}]));
    let body = h.day(CLOSED, None).await;
    assert_eq!((body["source"].as_str(), body["reset"].as_bool(), body["live"].as_bool()), (Some("store"), Some(true), Some(false)));
    assert_eq!((body["symbol"].as_str(), body["date"].as_str()), (Some("005930"), Some(CLOSED)));
    assert_eq!(times(&body), [at(23, 9, 0, 10), at(23, 9, 5, 0), at(23, 15, 20, 0)]);
    assert_eq!(buys(&body), [100, 300, 450]);
    assert_eq!(body["snapshots"][0]["buys"], json!([{"code": "050", "name": "키움증권", "qty": 100, "qtyChange": 7}]));
    assert_eq!(body["snapshots"][0]["sells"], json!([{"code": "030", "name": "삼  성", "qty": 90, "qtyChange": -5}]));
    assert_eq!(body["gaps"], json!([[at(23, 10, 0, 0), at(23, 10, 2, 0)]]));
}

#[tokio::test]
async fn today_comes_from_the_flow_and_only_new_rows_follow_the_cursor() {
    let h = Harness::start(true).await;
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100")]);
    h.write_flow("collect-01", &[flow_row(at(24, 9, 30, 0), "200")]);
    h.write_links("collect-01", &[(at(24, 8, 0, 0), "start"), (at(24, 8, 0, 0), "live"), (at(24, 9, 59, 50), "alive")]);
    let first = h.day(TODAY, None).await;
    assert_eq!((first["source"].as_str(), first["reset"].as_bool(), first["live"].as_bool()), (Some("flow"), Some(true), Some(true)));
    assert_eq!(times(&first), [at(24, 9, 0, 5), at(24, 9, 30, 0)]);
    assert_eq!(first["snapshots"][0]["buys"], json!([{"code": "050", "name": "키움증권", "qty": 100, "qtyChange": 7}]));
    assert_eq!(first["gaps"], json!([]));
    h.write_flow("collect-01", &[flow_row(at(24, 10, 0, 1), "350")]);
    h.clock.jump(2);
    let second = h.day(TODAY, first["cursor"].as_str()).await;
    assert_eq!(second["reset"], json!(false));
    assert_eq!(buys(&second), [350]);
    h.clock.jump(2);
    let third = h.day(TODAY, second["cursor"].as_str()).await;
    assert_eq!((third["reset"].as_bool(), third["snapshots"].as_array().unwrap().len()), (Some(false), 0));
}

#[tokio::test]
async fn two_keys_of_one_symbol_are_merged_in_time_order() {
    let h = Harness::start(true).await;
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100"), flow_row(at(24, 9, 40, 0), "300")]);
    h.write_flow("spare-01", &[flow_row(at(24, 9, 20, 0), "200"), flow_row(at(24, 9, 50, 0), "400")]);
    h.write_links("collect-01", &[(at(24, 8, 0, 0), "live"), (at(24, 9, 59, 50), "alive")]);
    h.write_links("spare-01", &[(at(24, 8, 0, 0), "live"), (at(24, 9, 59, 50), "alive")]);
    assert_eq!(buys(&h.day(TODAY, None).await), [100, 200, 300, 400]);
}

#[tokio::test]
async fn a_link_that_went_down_is_a_gap() {
    let h = Harness::start(true).await;
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100"), flow_row(at(24, 9, 40, 0), "300")]);
    h.write_links(
        "collect-01",
        &[(at(24, 8, 0, 0), "start"), (at(24, 8, 0, 0), "live"), (at(24, 9, 10, 0), "down"), (at(24, 9, 12, 0), "live"), (at(24, 9, 59, 50), "alive")],
    );
    let body = h.day(TODAY, None).await;
    assert_eq!(body["gaps"], json!([[at(24, 9, 10, 0), at(24, 9, 12, 0)]]));
    assert_eq!(body["live"], json!(true));
    h.clock.jump(300);
    let stale = h.day(TODAY, None).await;
    assert_eq!(stale["live"], json!(false));
    assert_eq!(stale["gaps"][1][0], json!(at(24, 9, 59, 50)));
}

#[tokio::test]
async fn a_day_that_gets_closed_switches_to_the_store() {
    let h = Harness::start(true).await;
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100")]);
    h.write_links("collect-01", &[(at(24, 8, 0, 0), "live"), (at(24, 9, 59, 50), "alive")]);
    let first = h.day(TODAY, None).await;
    assert_eq!(first["source"], json!("flow"));
    write_store(&h.data, TODAY, &[store_sql("005930_AL", at(24, 9, 0, 5), 100), store_sql("005930_AL", at(24, 9, 1, 0), 150)], json!([]));
    h.clock.jump(2);
    let closed = h.day(TODAY, first["cursor"].as_str()).await;
    assert_eq!((closed["source"].as_str(), closed["reset"].as_bool()), (Some("store"), Some(true)));
    assert_eq!(buys(&closed), [100, 150]);
}

#[tokio::test]
async fn a_symbol_without_collected_data_has_no_source() {
    for enabled in [true, false] {
        let h = Harness::start(enabled).await;
        let body = h.day(TODAY, None).await;
        assert_eq!((body["source"].as_str(), body["snapshots"].as_array().unwrap().len(), body["cursor"].as_str()), (Some("none"), 0, Some("")));
        let (status, days) = h.get("/api/symbols/005930/brokers/days").await;
        assert_eq!((status, days), (200, json!({"symbol": "005930", "days": []})));
    }
}

#[tokio::test]
async fn days_list_closed_days_and_today_flow() {
    let h = Harness::start(true).await;
    write_store(&h.data, CLOSED, &[store_sql("005930_AL", at(23, 9, 0, 10), 100)], json!([]));
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100")]);
    let (status, body) = h.get("/api/symbols/005930/brokers/days").await;
    assert_eq!((status, body["days"].clone()), (200, json!([CLOSED, TODAY])));
}

#[tokio::test]
async fn bad_requests_are_refused() {
    let h = Harness::start(true).await;
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100")]);
    for path in [
        "/api/symbols/IDX:001/brokers?date=20261124",
        "/api/symbols/005930/brokers?date=2026-11-24",
        "/api/symbols/005930/brokers",
        "/api/symbols/005930/brokers?date=20261124&fallback=bogus",
    ] {
        assert_eq!(h.get(path).await.0, 400, "{path}");
    }
    let body = h.day(TODAY, Some("broken")).await;
    assert_eq!((body["reset"].as_bool(), buys(&body)), (Some(true), vec![100]));
}

#[tokio::test]
async fn fallback_latest_returns_the_most_recent_closed_day_with_snapshots() {
    let h = Harness::start(true).await;
    write_store(&h.data, "20261120", &[store_sql("005930_AL", at(20, 15, 20, 0), 777)], json!([]));
    write_store(&h.data, CLOSED, &[store_sql("000120_AL", at(23, 9, 0, 10), 999)], json!([]));
    let exact = h.day(TODAY, None).await;
    assert_eq!((exact["date"].as_str(), exact["source"].as_str()), (Some(TODAY), Some("none")));
    let (status, fallback) = h.get(&format!("/api/symbols/005930/brokers?date={TODAY}&fallback=latest")).await;
    assert_eq!(status, 200, "{fallback}");
    assert_eq!((fallback["date"].as_str(), fallback["source"].as_str(), fallback["live"].as_bool()), (Some("20261120"), Some("store"), Some(false)));
    assert_eq!(buys(&fallback), [777]);
}

#[tokio::test]
async fn rows_in_the_same_second_are_all_sent_without_a_reset() {
    let h = Harness::start(true).await;
    let second = at(24, 9, 59, 30);
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100"), flow_row(second, "200")]);
    h.write_links("collect-01", &[(at(24, 8, 0, 0), "live"), (at(24, 9, 59, 50), "alive")]);
    let first = h.day(TODAY, None).await;
    let late = FlowRow { recv_ms: second * 1000 + 700, ..flow_row(second, "260") };
    h.write_flow("collect-01", &[late]);
    h.clock.jump(2);
    let next = h.day(TODAY, first["cursor"].as_str()).await;
    assert_eq!(next["reset"], json!(false));
    assert_eq!((times(&next), buys(&next)), (vec![second], vec![260]));
}

fn write_archive_brokers(root: &Path, date: &str, symbol: &str, qty: i64) {
    let dir = root.join(date).join(symbol).join("hogaplay");
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    let sql = format!(
        "SELECT 90500100::BIGINT AS ts_ms, 1::INTEGER AS seq, 'buy' AS side, 1::TINYINT AS rank, '키움증권' AS broker, {qty}::INTEGER AS qty_today, 12::INTEGER AS qty_delta \
         UNION ALL \
         SELECT 90500100::BIGINT AS ts_ms, 1::INTEGER AS seq, 'sell' AS side, 1::TINYINT AS rank, '한  화' AS broker, 88::INTEGER AS qty_today, -4::INTEGER AS qty_delta"
    );
    conn.execute_batch(&format!(
        "SET threads = 1; COPY ({sql}) TO '{}' (FORMAT parquet)",
        dir.join("brokers.parquet").display()
    ))
    .unwrap();
}

#[tokio::test]
async fn hogaplay_archive_serves_broker_days_and_snapshots_with_native_priority() {
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 24).unwrap(), 10, 0, 0));
    let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let rest = KiwoomRest::new(ScriptedTransport::new().transport(), auth, clock.clone());
    let tmp = tempfile::tempdir().unwrap();
    let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, events) = tokio::sync::mpsc::channel(1);
    let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
    let symbols = Arc::new(SymbolDirectory::default());
    let state = application(ApplicationInputs {
        rest,
        clock: clock.clone(),
        symbols,
        db,
        screener_store: store,
        stream: (stream, events),
        static_dir: tmp.path().to_owned(),
        screener_update_on_connect: false,
    });
    let hoga = tmp.path().join("hoga");
    let archive = tmp.path().join("parquet");
    write_store(&hoga, CLOSED, &[store_sql("005930_AL", at(23, 9, 0, 10), 100)], json!([]));
    write_archive_brokers(&archive, CLOSED, "005930", 999);
    write_archive_brokers(&archive, "20240827", "005930", 420);
    state.collector_paths.configure(server::shared_data::CollectorPaths::hoga_only(hoga).with_archive(Some(archive)));
    let h = Harness { app: router(state), clock, data: tmp.path().join("hoga"), _tmp: tmp };

    let (status, days) = h.get("/api/symbols/005930/brokers/days").await;
    assert_eq!(status, 200, "{days}");
    assert_eq!(days, json!({"symbol": "005930", "days": ["20240827", CLOSED], "archiveDays": ["20240827"]}));

    let native = h.day(CLOSED, None).await;
    assert_eq!(buys(&native), [100]);
    assert!(native.get("venueScope").is_none());

    let archived = h.day("20240827", None).await;
    assert_eq!((archived["source"].as_str(), archived["venueScope"].as_str()), (Some("store"), Some("krx_archive")));
    assert_eq!(archived["snapshots"][0]["buys"], json!([{"code": "050", "name": "키움증권", "qty": 420, "qtyChange": 12}]));
    assert_eq!(archived["snapshots"][0]["sells"], json!([{"code": "021", "name": "한  화", "qty": 88, "qtyChange": -4}]));
}
