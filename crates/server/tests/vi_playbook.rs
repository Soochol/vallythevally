mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::{Router, body::Body, http::Request};
use domain::KstDate;
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::shared_data::CollectorPaths;
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

fn write_complete(data: &Path, date: &str) {
    let folder = data.join("store").join(date);
    std::fs::create_dir_all(&folder).unwrap();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": BUCKETS},
        "raw_files": {"collect-01/1530-000.jsonl.zst": 10},
        "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": [], "handoff": null}],
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn write_parquet(data: &Path, date: &str, type_code: &str, symbol_bucket: &str, rows: &[String]) {
    let parquet = data.join("store").join(date).join(type_code).join(bucket_file(symbol_bucket));
    std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(&format!("SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)", rows.join(" UNION ALL "), parquet.display()))
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
fn vi_sql(
    symbol: &str,
    recv_ms: i64,
    f9001: &str,
    kind: &str,
    direction: &str,
    trigger_price: u64,
    triggered: &str,
    released: &str,
    action: &str,
) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{f9001}' AS f9001, '{kind}' AS f9068, '{direction}' AS f9069, {trigger_price}::BIGINT AS f1221, '{triggered}' AS f1223, '{released}' AS f1224, '{action}' AS f1225, 70000::BIGINT AS f1236, 70500::BIGINT AS f1237, 2.5::DOUBLE AS f1238, 1.5::DOUBLE AS f1239, 3.0::DOUBLE AS f1489, 1::BIGINT AS f1490"
    )
}

fn expected_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: u64, qty: u64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, 0::BIGINT AS f11, 0.0::DOUBLE AS f12, {qty}::BIGINT AS f15, {qty}::BIGINT AS f13, 2::BIGINT AS f25"
    )
}

fn tick_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: u64, signed_qty: i64) -> String {
    let f15_plus = signed_qty > 0;
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, {signed_qty}::BIGINT AS f15, {f15_plus}::BOOLEAN AS f15_plus, 100::BIGINT AS f1313, 'KRX' AS f9081"
    )
}

struct Harness {
    app: Router,
    data: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(enabled: bool) -> Harness {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 25).unwrap(), 10, 0, 0));
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
        let data = tmp.path().join("hoga");
        if enabled {
            state.collector_paths.configure(CollectorPaths::hoga_only(data.clone()));
        }
        Harness { app: router(state), data, _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn rejects_invalid_symbol_index_and_query_params() {
    let h = Harness::start(false).await;
    for path in [
        "/api/symbols/IDX:001/vi-playbook",
        "/api/symbols/bad/vi-playbook",
        "/api/symbols/005930/vi-playbook?direction=sideways",
        "/api/symbols/005930/vi-playbook?kind=turbo",
    ] {
        let (status, body) = h.get(path).await;
        assert_eq!(status, 400, "{path}: {body}");
        assert_eq!(body["error"]["code"], "bad_request", "{path}: {body}");
    }
}

#[tokio::test]
async fn unconfigured_or_empty_store_returns_zero_samples_gracefully() {
    let unconfigured = Harness::start(false).await;
    let (status, body) = unconfigured.get("/api/symbols/005930/vi-playbook").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["symbol"], "005930");
    assert_eq!(body["direction"], "up");
    assert_eq!(body["kind"], "all");
    assert_eq!(body["lookbackDays"], 0);
    assert_eq!(body["sampleCount"], 0);
    assert_eq!(body["horizons"], json!([]));
    assert_eq!(body["recentMatches"], json!([]));

    let empty = Harness::start(true).await;
    let (status, body) = empty.get("/api/symbols/005930/vi-playbook?direction=down&kind=static").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["direction"], "down");
    assert_eq!(body["kind"], "static");
    assert_eq!(body["sampleCount"], 0);
}

#[tokio::test]
async fn aggregates_multi_day_vi_events_horizons_mae_and_late_drop() {
    let h = Harness::start(true).await;

    let d1 = KstDate::new(2026, 11, 20).unwrap();
    write_complete(&h.data, "20261120");
    write_parquet(
        &h.data,
        "20261120",
        "1h",
        "005930",
        &[
            vi_sql("005930", at_ms(d1, 9, 10, 0), "005930", "2", "1", 70_000, "091000", "000000", "1"),
            vi_sql("005930", at_ms(d1, 9, 12, 0), "005930", "2", "1", 70_000, "091000", "091200", "2"),
        ],
    );
    write_parquet(
        &h.data,
        "20261120",
        "0H",
        "005930_AL",
        &[
            expected_sql("005930_AL", at_ms(d1, 9, 10, 15), "091015", 70_500, 10_000),
            expected_sql("005930_AL", at_ms(d1, 9, 11, 30), "091130", 71_000, 12_000),
            expected_sql("005930_AL", at_ms(d1, 9, 11, 55), "091155", 71_200, 13_000),
        ],
    );
    write_parquet(
        &h.data,
        "20261120",
        "0B",
        "005930_AL",
        &[
            tick_sql("005930_AL", at_ms(d1, 9, 12, 0), "091200", 70_000, 100),
            tick_sql("005930_AL", at_ms(d1, 9, 12, 30), "091230", 69_300, -50),
            tick_sql("005930_AL", at_ms(d1, 9, 13, 0), "091300", 71_400, 200),
            tick_sql("005930_AL", at_ms(d1, 9, 15, 0), "091500", 72_100, 150),
            tick_sql("005930_AL", at_ms(d1, 9, 17, 0), "091700", 72_800, 100),
            tick_sql("005930_AL", at_ms(d1, 9, 22, 0), "092200", 73_500, 120),
        ],
    );

    let d2 = KstDate::new(2026, 11, 23).unwrap();
    write_complete(&h.data, "20261123");
    write_parquet(
        &h.data,
        "20261123",
        "1h",
        "005930",
        &[
            vi_sql("005930", at_ms(d2, 10, 0, 0), "005930", "1", "1", 80_000, "100000", "000000", "1"),
            vi_sql("005930", at_ms(d2, 11, 0, 0), "005930", "2", "2", 75_000, "110000", "110200", "2"),
        ],
    );
    write_parquet(
        &h.data,
        "20261123",
        "0H",
        "005930_AL",
        &[
            expected_sql("005930_AL", at_ms(d2, 10, 0, 20), "100020", 81_000, 10_000),
            expected_sql("005930_AL", at_ms(d2, 10, 1, 20), "100120", 82_000, 12_000),
            expected_sql("005930_AL", at_ms(d2, 10, 1, 55), "100155", 80_800, 9_000),
        ],
    );
    write_parquet(
        &h.data,
        "20261123",
        "0B",
        "005930_AL",
        &[
            tick_sql("005930_AL", at_ms(d2, 10, 2, 0), "100200", 80_000, 100),
            tick_sql("005930_AL", at_ms(d2, 10, 3, 0), "100300", 79_200, -100),
            tick_sql("005930_AL", at_ms(d2, 10, 5, 0), "100500", 78_400, -100),
            tick_sql("005930_AL", at_ms(d2, 10, 7, 0), "100700", 77_600, -100),
            tick_sql("005930_AL", at_ms(d2, 10, 12, 0), "101200", 78_400, 50),
            tick_sql("005930_AL", at_ms(d2, 11, 2, 0), "110200", 75_000, -100),
            tick_sql("005930_AL", at_ms(d2, 11, 2, 30), "110230", 75_750, 40),
            tick_sql("005930_AL", at_ms(d2, 11, 3, 0), "110300", 73_500, -200),
            tick_sql("005930_AL", at_ms(d2, 11, 5, 0), "110500", 72_750, -150),
            tick_sql("005930_AL", at_ms(d2, 11, 7, 0), "110700", 72_000, -100),
        ],
    );

    let (status, up_all) = h.get("/api/symbols/005930/vi-playbook?direction=up&kind=all").await;
    assert_eq!(status, 200, "{up_all}");
    assert_eq!(up_all["lookbackDays"], 2);
    assert_eq!(up_all["sampleCount"], 2);

    let horizons = up_all["horizons"].as_array().unwrap();
    assert_eq!(horizons.len(), 4);
    assert_eq!(horizons[0], json!({"minutes": 1, "samples": 2, "winRatePct": 50.0, "avgReturnPct": 0.5, "avgMaePct": -1.0}));
    assert_eq!(horizons[1], json!({"minutes": 3, "samples": 2, "winRatePct": 50.0, "avgReturnPct": 0.5, "avgMaePct": -1.5}));
    assert_eq!(horizons[2], json!({"minutes": 5, "samples": 2, "winRatePct": 50.0, "avgReturnPct": 0.5, "avgMaePct": -2.0}));
    assert_eq!(horizons[3], json!({"minutes": 10, "samples": 2, "winRatePct": 50.0, "avgReturnPct": 1.5, "avgMaePct": -2.0}));

    let matches = up_all["recentMatches"].as_array().unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0]["date"], "2026-11-23");
    assert_eq!(matches[0]["kind"], "static");
    assert_eq!(matches[0]["releasedAt"], Value::Null);
    assert_eq!(matches[0]["lateDropDetected"], true);
    assert_eq!(matches[0]["return1mPct"], -1.0);
    assert_eq!(matches[0]["mae5mPct"], -3.0);

    assert_eq!(matches[1]["date"], "2026-11-20");
    assert_eq!(matches[1]["kind"], "dynamic");
    assert_eq!(matches[1]["releasedAt"], "09:12:00");
    assert_eq!(matches[1]["lateDropDetected"], false);
    assert_eq!(matches[1]["return5mPct"], 4.0);
    assert_eq!(matches[1]["mae5mPct"], -1.0);

    let (status, dynamic_only) = h.get("/api/symbols/005930/vi-playbook?direction=up&kind=dynamic").await;
    assert_eq!(status, 200, "{dynamic_only}");
    assert_eq!(dynamic_only["sampleCount"], 1);
    assert_eq!(dynamic_only["recentMatches"][0]["date"], "2026-11-20");

    let (status, down_all) = h.get("/api/symbols/005930/vi-playbook?direction=down&kind=all").await;
    assert_eq!(status, 200, "{down_all}");
    assert_eq!(down_all["sampleCount"], 1);
    assert_eq!(down_all["horizons"][0]["winRatePct"], 100.0);
    assert_eq!(down_all["horizons"][0]["avgReturnPct"], -2.0);
    assert_eq!(down_all["horizons"][0]["avgMaePct"], -1.0);
}

#[tokio::test]
#[ignore]
async fn benchmark_cold_and_warm_vi_playbook_across_60_days() {
    let h = Harness::start(true).await;
    let base_day = KstDate::new(2026, 11, 24).unwrap().days_since_epoch();
    for offset in 0..60 {
        let date = KstDate::from_days_since_epoch(base_day - offset);
        let date_str = format!("{:04}{:02}{:02}", date.year(), date.month(), date.day());
        write_complete(&h.data, &date_str);
        if offset % 12 == 0 {
            write_parquet(
                &h.data,
                &date_str,
                "1h",
                "005930",
                &[vi_sql("005930", at_ms(date, 9, 10, 0), "005930", "2", "1", 70_000, "091000", "091200", "2")],
            );
            write_parquet(
                &h.data,
                &date_str,
                "0H",
                "005930_AL",
                &[
                    expected_sql("005930_AL", at_ms(date, 9, 10, 10), "091010", 70_500, 10_000),
                    expected_sql("005930_AL", at_ms(date, 9, 11, 55), "091155", 71_000, 11_000),
                ],
            );
            write_parquet(
                &h.data,
                &date_str,
                "0B",
                "005930_AL",
                &[
                    tick_sql("005930_AL", at_ms(date, 9, 12, 0), "091200", 70_000, 100),
                    tick_sql("005930_AL", at_ms(date, 9, 13, 0), "091300", 71_000, 100),
                    tick_sql("005930_AL", at_ms(date, 9, 15, 0), "091500", 71_500, 100),
                    tick_sql("005930_AL", at_ms(date, 9, 17, 0), "091700", 72_000, 100),
                    tick_sql("005930_AL", at_ms(date, 9, 22, 0), "092200", 72_500, 100),
                ],
            );
        }
    }

    let t0 = Instant::now();
    let (status, cold_body) = h.get("/api/symbols/005930/vi-playbook?direction=up&kind=all").await;
    let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(status, 200, "{cold_body}");
    assert_eq!(cold_body["lookbackDays"], 60);
    assert_eq!(cold_body["sampleCount"], 5);

    let mut warm_ms: Vec<f64> = Vec::with_capacity(10);
    for _ in 0..10 {
        let tw = Instant::now();
        let (ws, warm_body) = h.get("/api/symbols/005930/vi-playbook?direction=up&kind=all").await;
        let elapsed = tw.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(ws, 200);
        assert_eq!(warm_body["sampleCount"], 5);
        warm_ms.push(elapsed);
    }
    warm_ms.sort_by(|a, b| a.total_cmp(b));
    let warm_min = warm_ms[0];
    let warm_median = warm_ms[warm_ms.len() / 2];
    let warm_max = *warm_ms.last().unwrap();
    println!("vi_playbook bench (60 finalized days, 5 VI days): cold={cold_ms:.2}ms warm(n=10) min={warm_min:.2}ms median={warm_median:.2}ms max={warm_max:.2}ms");
    assert!(cold_ms < 800.0, "cold={cold_ms:.2}ms exceeded 800ms budget");
    assert!(warm_median < 5.0, "warm median={warm_median:.2}ms exceeded 5ms budget");
}
