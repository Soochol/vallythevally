use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, StockCode};
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::db::AppDb;
use server::http::{AppState, router};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::shared_data::{CollectorPaths, FlowDescription, FlowRow, FlowWriter, flow_path};
use server::symbols::SymbolDirectory;
use support::ScriptedTransport;
use tower::ServiceExt;

const BUCKETS: u64 = 64;

fn bucket_file(symbol: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in symbol.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:03}.parquet", hash % BUCKETS)
}

fn at_ms(date: KstDate, hour: u32, minute: u32, second: u32) -> i64 {
    kst(date, hour, minute, second).unix() * 1000
}

fn write_complete_with_gaps(data: &Path, date: &str, gaps: Value) {
    let folder = data.join("store").join(date);
    std::fs::create_dir_all(&folder).unwrap();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": BUCKETS},
        "raw_files": {"collect-01/1530-000.jsonl.zst": 10},
        "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": gaps, "handoff": null}],
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn write_complete(data: &Path, date: &str) {
    write_complete_with_gaps(data, date, json!([]));
}

fn write_parquet(data: &Path, date: &str, type_code: &str, symbol_bucket: &str, rows: &[String]) {
    let parquet = data.join("store").join(date).join(type_code).join(bucket_file(symbol_bucket));
    std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(&format!("SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)", rows.join(" UNION ALL "), parquet.display()))
        .unwrap();
}

fn book_sql(symbol: &str, recv_ms: i64, ask0: i64, bid0: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, \
         70100::BIGINT AS f41, {ask0}::BIGINT AS f61, 70200::BIGINT AS f42, 1000::BIGINT AS f62, \
         70300::BIGINT AS f43, 1000::BIGINT AS f63, 70400::BIGINT AS f44, 1000::BIGINT AS f64, \
         70500::BIGINT AS f45, 1000::BIGINT AS f65, 0::BIGINT AS f46, 0::BIGINT AS f66, \
         0::BIGINT AS f47, 0::BIGINT AS f67, 0::BIGINT AS f48, 0::BIGINT AS f68, \
         0::BIGINT AS f49, 0::BIGINT AS f69, 0::BIGINT AS f50, 0::BIGINT AS f70, \
         70000::BIGINT AS f51, {bid0}::BIGINT AS f71, 69900::BIGINT AS f52, 1000::BIGINT AS f72, \
         69800::BIGINT AS f53, 1000::BIGINT AS f73, 69700::BIGINT AS f54, 1000::BIGINT AS f74, \
         69600::BIGINT AS f55, 1000::BIGINT AS f75, 0::BIGINT AS f56, 0::BIGINT AS f76, \
         0::BIGINT AS f57, 0::BIGINT AS f77, 0::BIGINT AS f58, 0::BIGINT AS f78, \
         0::BIGINT AS f59, 0::BIGINT AS f79, 0::BIGINT AS f60, 0::BIGINT AS f80"
    )
}

fn trade_sql(symbol: &str, recv_ms: i64, price: i64, signed_qty: i64) -> String {
    format!("SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, {price}::BIGINT AS f10, {signed_qty}::BIGINT AS f15")
}

struct Harness {
    state: Arc<AppState>,
    app: Router,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(now: domain::KstTime, hoga: Option<PathBuf>, shared: Option<PathBuf>) -> Harness {
        let clock = Clock::fake(now);
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(ScriptedTransport::new().transport(), auth, clock.clone());
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let symbols = Arc::new(SymbolDirectory::default());
        let state = application(ApplicationInputs {
            rest,
            clock,
            symbols,
            db,
            screener_store: store,
            stream: (stream, events),
            static_dir: tmp.path().to_owned(),
            screener_update_on_connect: false,
        });
        state.collector_paths.configure(CollectorPaths::new(hoga, shared));
        let app = router(state.clone());
        Harness { state, app, _tmp: tmp }
    }

    async fn get(&self, uri: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn micro_events_endpoint_reads_today_me_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    let today = KstDate::parse_yyyymmdd("20261125").unwrap();
    let now = kst(today, 10, 0, 0);

    let path = flow_path(&shared, "20261125", "ME", "005930", "k1");
    let desc = FlowDescription::new("ME", "005930", "20261125", "k1", &[1, 2, 3, 4, 5, 6]);
    let mut writer = FlowWriter::open(&path, desc).unwrap();
    writer
        .append(&[
            FlowRow {
                recv_ms: at_ms(today, 9, 15, 0),
                values: vec![
                    Some("S".into()),
                    Some("A".into()),
                    Some("70100".into()),
                    Some("4500".into()),
                    Some("5000".into()),
                    Some("9000".into()),
                ],
            },
            FlowRow {
                recv_ms: at_ms(today, 9, 20, 0),
                values: vec![
                    Some("I".into()),
                    Some("B".into()),
                    Some("70000".into()),
                    Some("1800".into()),
                    Some("1000".into()),
                    Some("18000".into()),
                ],
            },
        ])
        .unwrap();

    let h = Harness::start(now, None, Some(shared)).await;
    let (status, body) = h.get("/api/symbols/005930/micro-events?date=20261125").await;
    assert_eq!(status, 200);
    assert_eq!(body["source"], "flow");
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["kind"], "spoof_cancel");
    assert_eq!(events[0]["side"], "ask");
    assert_eq!(events[0]["priceWon"], 70100);
    assert_eq!(events[0]["cancelledOrAbsorbedQty"], 4500);
    assert_eq!(events[0]["executedQty"], 500);
    assert_eq!(events[0]["ratioBps"], 9000);

    assert_eq!(events[1]["kind"], "iceberg_absorb");
    assert_eq!(events[1]["side"], "bid");
    assert_eq!(events[1]["priceWon"], 70000);
    assert_eq!(events[1]["executedQty"], 1800);

    let (direct_source, direct_events) = h
        .state
        .micro_events
        .day_events(&h.state.collected, h.state.collector_paths.snapshot(), StockCode::parse("005930").unwrap(), today, now)
        .await
        .unwrap();
    assert_eq!(direct_source, server::api::BrokerDaySource::Flow);
    assert_eq!(direct_events.len(), 2);
}

#[tokio::test]
async fn micro_events_endpoint_computes_closed_day_from_parquet_0d_and_0b() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let past = KstDate::parse_yyyymmdd("20261120").unwrap();
    let today = KstDate::parse_yyyymmdd("20261125").unwrap();
    let now = kst(today, 10, 0, 0);

    write_complete(&hoga, "20261120");
    write_parquet(
        &hoga,
        "20261120",
        "0D",
        "005930_AL",
        &[
            book_sql("005930_AL", at_ms(past, 9, 5, 0), 5_000, 2_000),
            book_sql("005930_AL", at_ms(past, 9, 5, 2), 100, 2_000),
            book_sql("005930_AL", at_ms(past, 9, 6, 0), 4_000, 2_000),
            book_sql("005930_AL", at_ms(past, 9, 6, 2), 100, 2_000),
        ],
    );
    write_parquet(
        &hoga,
        "20261120",
        "0B",
        "005930_AL",
        &[trade_sql("005930_AL", at_ms(past, 9, 6, 1), 70_100, 3_900)],
    );

    let h = Harness::start(now, Some(hoga), None).await;
    let (status, body) = h.get("/api/symbols/005930/micro-events?date=20261120").await;
    assert_eq!(status, 200);
    assert_eq!(body["source"], "store");
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "spoof_cancel");
    assert_eq!(events[0]["side"], "ask");
    assert_eq!(events[0]["priceWon"], 70100);
    assert_eq!(events[0]["cancelledOrAbsorbedQty"], 4900);
    assert_eq!(events[0]["ratioBps"], 10000);
}

#[tokio::test]
async fn micro_events_me_flow_preserves_exact_executed_qty_via_fid7_and_clamps_legacy() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    let today = KstDate::parse_yyyymmdd("20261125").unwrap();
    let now = kst(today, 10, 0, 0);

    let path7 = flow_path(&shared, "20261125", "ME", "005930", "k1");
    let desc7 = FlowDescription::new("ME", "005930", "20261125", "k1", &[1, 2, 3, 4, 5, 6, 7]);
    FlowWriter::open(&path7, desc7)
        .unwrap()
        .append(&[FlowRow {
            recv_ms: at_ms(today, 9, 15, 0),
            values: vec![
                Some("S".into()),
                Some("A".into()),
                Some("70100".into()),
                Some("99995".into()),
                Some("100000".into()),
                Some("9999".into()),
                Some("5".into()),
            ],
        }])
        .unwrap();

    let path6 = flow_path(&shared, "20261125", "ME", "005930", "k2");
    let desc6 = FlowDescription::new("ME", "005930", "20261125", "k2", &[1, 2, 3, 4, 5, 6]);
    FlowWriter::open(&path6, desc6)
        .unwrap()
        .append(&[FlowRow {
            recv_ms: at_ms(today, 9, 16, 0),
            values: vec![
                Some("S".into()),
                Some("A".into()),
                Some("70100".into()),
                Some("99995".into()),
                Some("100000".into()),
                Some("9999".into()),
            ],
        }])
        .unwrap();

    let h = Harness::start(now, None, Some(shared)).await;
    let (status, body) = h.get("/api/symbols/005930/micro-events?date=20261125").await;
    assert_eq!(status, 200);
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["executedQty"], 5);
    assert_eq!(events[1]["executedQty"], 5);
}

#[tokio::test]
async fn micro_events_store_resets_detector_across_complete_json_gaps() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let past = KstDate::parse_yyyymmdd("20261120").unwrap();
    let today = KstDate::parse_yyyymmdd("20261125").unwrap();
    let now = kst(today, 10, 0, 0);

    write_complete_with_gaps(
        &hoga,
        "20261120",
        json!([{"from_ms": at_ms(past, 9, 5, 10), "to_ms": at_ms(past, 9, 6, 0)}]),
    );
    write_parquet(
        &hoga,
        "20261120",
        "0D",
        "005930_AL",
        &[
            book_sql("005930_AL", at_ms(past, 9, 5, 0), 5_000, 2_000),
            book_sql("005930_AL", at_ms(past, 9, 6, 1), 100, 2_000),
            book_sql("005930_AL", at_ms(past, 9, 6, 5), 4_000, 2_000),
            book_sql("005930_AL", at_ms(past, 9, 6, 7), 100, 2_000),
        ],
    );

    let h = Harness::start(now, Some(hoga), None).await;
    let (status, body) = h.get("/api/symbols/005930/micro-events?date=20261120").await;
    assert_eq!(status, 200);
    assert_eq!(body["source"], "store");
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["recvMs"], at_ms(past, 9, 6, 7));
    assert_eq!(events[0]["cancelledOrAbsorbedQty"], 3900);
}

#[tokio::test]
async fn micro_events_corrupt_complete_json_falls_back_to_today_me_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let shared = hoga.join("shared");
    let today = KstDate::parse_yyyymmdd("20261125").unwrap();
    let now = kst(today, 10, 0, 0);

    let corrupt_dir = hoga.join("store").join("20261125");
    std::fs::create_dir_all(&corrupt_dir).unwrap();
    std::fs::write(corrupt_dir.join("complete.json"), "{broken").unwrap();

    let path = flow_path(&shared, "20261125", "ME", "005930", "k1");
    let desc = FlowDescription::new("ME", "005930", "20261125", "k1", &[1, 2, 3, 4, 5, 6, 7]);
    FlowWriter::open(&path, desc)
        .unwrap()
        .append(&[FlowRow {
            recv_ms: at_ms(today, 9, 15, 0),
            values: vec![
                Some("S".into()),
                Some("A".into()),
                Some("70100".into()),
                Some("4000".into()),
                Some("5000".into()),
                Some("9000".into()),
                Some("444".into()),
            ],
        }])
        .unwrap();

    let h = Harness::start(now, Some(hoga), Some(shared)).await;
    let (status, body) = h.get("/api/symbols/005930/micro-events?date=20261125").await;
    assert_eq!(status, 200);
    assert_eq!(body["source"], "flow");
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["executedQty"], 444);
}
