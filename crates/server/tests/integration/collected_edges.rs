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
    shared: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(separate_shared: bool) -> Harness {
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
        let data = tmp.path().join("hoga");
        let shared = if separate_shared {
            let external = tmp.path().join("external-shared");
            state.collector_paths.configure(server::shared_data::CollectorPaths::new(Some(data.clone()), Some(external.clone())));
            external
        } else {
            state.collector_paths.configure(server::shared_data::CollectorPaths::hoga_only(data.clone()));
            data.join("shared")
        };
        Harness { app: router(state), clock, data, shared, _tmp: tmp }
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

    fn write_flow(&self, key: &str, rows: &[FlowRow]) {
        let path = flow_path(&self.shared, TODAY, "0F", "005930", key);
        let fids: Vec<u32> = (141..=180).collect();
        FlowWriter::open(&path, FlowDescription::new("0F", "005930", TODAY, key, &fids)).unwrap().append(rows).unwrap();
    }

    fn write_links(&self, key: &str, lines: &[(i64, &str)]) {
        let path = flow_links_path(&self.shared, TODAY, key);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: String = lines.iter().map(|(t, event)| format!("{}\n", json!({"t": t * 1000, "event": event}))).collect();
        std::fs::write(path, text).unwrap();
    }
}

fn flow_row(recv_s: i64, buy_qty: &str) -> FlowRow {
    let values = (141..=180)
        .map(|fid| match fid {
            141 => Some("삼성증권".to_owned()),
            146 => Some("030".to_owned()),
            151 => Some("키움증권".to_owned()),
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
            141 => "'삼성증권'".to_owned(),
            146 => "'030'".to_owned(),
            151 => "'키움증권'".to_owned(),
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
        "raw_files": {"collect-01/0900-000.jsonl.zst": 10},
        "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": gaps, "handoff": null}],
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn buys(body: &Value) -> Vec<i64> {
    body["snapshots"].as_array().unwrap().iter().map(|snapshot| snapshot["buys"][0]["qty"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn a_replaced_key_file_resets_the_day_without_duplicates() {
    let h = Harness::start(false).await;
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "100"), flow_row(at(24, 9, 5, 0), "200")]);
    h.write_links("collect-01", &[(at(24, 8, 0, 0), "live"), (at(24, 9, 59, 50), "alive")]);
    let first = h.day(TODAY, None).await;
    assert_eq!(buys(&first), [100, 200]);
    let path = flow_path(&h.shared, TODAY, "0F", "005930", "collect-01");
    std::fs::remove_file(&path).unwrap();
    h.write_flow("collect-01", &[flow_row(at(24, 9, 30, 0), "350")]);
    h.clock.jump(2);
    let replaced = h.day(TODAY, first["cursor"].as_str()).await;
    assert_eq!(replaced["source"], json!("flow"));
    assert_eq!(replaced["reset"], json!(true));
    assert_eq!(buys(&replaced), [350]);
}

#[tokio::test]
async fn a_shared_data_dir_outside_the_data_folder_is_used() {
    let h = Harness::start(true).await;
    h.write_flow("collect-01", &[flow_row(at(24, 9, 0, 5), "120")]);
    h.write_links("collect-01", &[(at(24, 8, 0, 0), "live"), (at(24, 9, 59, 50), "alive")]);
    let body = h.day(TODAY, None).await;
    assert_eq!((body["source"].as_str(), body["reset"].as_bool()), (Some("flow"), Some(true)));
    assert_eq!(buys(&body), [120]);
    let (status, days) = h.get("/api/symbols/005930/brokers/days").await;
    assert_eq!((status, days["days"].clone()), (200, json!([TODAY])));
}

#[tokio::test]
async fn a_store_cursor_gives_nothing_new_and_resets_when_the_day_is_refinalized() {
    let h = Harness::start(false).await;
    write_store(&h.data, CLOSED, &[store_sql("005930_AL", at(23, 9, 0, 10), 100)], json!([]));
    let first = h.day(CLOSED, None).await;
    assert_eq!((first["source"].as_str(), first["reset"].as_bool()), (Some("store"), Some(true)));
    assert_eq!(buys(&first), [100]);
    let same = h.day(CLOSED, first["cursor"].as_str()).await;
    assert_eq!((same["source"].as_str(), same["reset"].as_bool(), buys(&same).len()), (Some("store"), Some(false), 0));
    write_store(
        &h.data,
        CLOSED,
        &[store_sql("005930_AL", at(23, 9, 0, 10), 100), store_sql("005930_AL", at(23, 9, 5, 0), 250)],
        json!([{"from_ms": at(23, 10, 0, 0) * 1000, "to_ms": at(23, 10, 1, 0) * 1000}]),
    );
    let refinalized = h.day(CLOSED, same["cursor"].as_str()).await;
    assert_eq!((refinalized["source"].as_str(), refinalized["reset"].as_bool()), (Some("store"), Some(true)));
    assert_eq!(buys(&refinalized), [100, 250]);
}
