mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Period, TimeOfDay};
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::collected::kind::{CollectedKind, CollectedTradeTick, ProgramFlow, TradeTicks};
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::micro_series::aggregate_tick_cvd_day;
use server::shared_data::{CollectorPaths, FlowDescription, FlowRow, FlowWriter, flow_links_path, flow_path};
use server::symbols::SymbolDirectory;
use support::ScriptedTransport;
use tower::ServiceExt;

const CLOSED: &str = "20261123";
const TODAY: &str = "20261124";
const BUCKETS: u64 = 64;

fn date_of(day: u8) -> KstDate {
    KstDate::new(2026, 11, day).unwrap()
}

fn at_sec(day: u8, hour: u32, minute: u32, second: u32) -> i64 {
    kst(date_of(day), hour, minute, second).unix()
}

fn bucket_file(symbol: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in symbol.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:03}.parquet", hash % BUCKETS)
}

fn write_complete(data: &Path, date: &str) {
    let folder = data.join("store").join(date);
    std::fs::create_dir_all(&folder).unwrap();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": BUCKETS},
        "raw_files": {"collect-01/0900-000.jsonl.zst": 10},
        "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": [], "handoff": null}],
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn write_parquet(data: &Path, date: &str, type_code: &str, symbol_bucket: &str, rows: &[String]) {
    let parquet = data.join("store").join(date).join(type_code).join(bucket_file(symbol_bucket));
    std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&format!("SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)", rows.join(" UNION ALL "), parquet.display()))
        .unwrap();
}

fn tick_sql(recv_ms: i64, hhmmss: &str, price: u64, signed_qty: i64) -> String {
    let f15_plus = signed_qty > 0;
    format!(
        "SELECT '005930_AL' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, {signed_qty}::BIGINT AS f15, {f15_plus}::BOOLEAN AS f15_plus, 0::BIGINT AS f1313, 'KRX' AS f9081"
    )
}

fn program_sql(recv_ms: i64, hhmmss: &str, sell_amt: u64, buy_amt: u64, net_qty: i64, net_amt: i64) -> String {
    format!(
        "SELECT '005930_AL' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, 70000::BIGINT AS f10, 100::BIGINT AS f202, {sell_amt}::BIGINT AS f204, 200::BIGINT AS f206, {buy_amt}::BIGINT AS f208, {net_qty}::BIGINT AS f210, 0::BIGINT AS f211, {net_amt}::BIGINT AS f212, 0::BIGINT AS f213"
    )
}

fn tick_flow_row(recv_ms: i64, hhmmss: &str, price: u64, signed_qty: i64) -> FlowRow {
    FlowRow {
        recv_ms,
        values: vec![
            Some(hhmmss.to_owned()),
            Some(price.to_string()),
            Some(format!("{signed_qty:+}")),
            Some("0".to_owned()),
            Some("KRX".to_owned()),
        ],
    }
}

fn program_flow_row(recv_ms: i64, hhmmss: &str, sell_amt: u64, buy_amt: u64, net_qty: i64, net_amt: i64) -> FlowRow {
    FlowRow {
        recv_ms,
        values: vec![
            Some(hhmmss.to_owned()),
            Some("70000".to_owned()),
            Some("100".to_owned()),
            Some(sell_amt.to_string()),
            Some("200".to_owned()),
            Some(buy_amt.to_string()),
            Some(format!("{net_qty:+}")),
            Some("0".to_owned()),
            Some(format!("{net_amt:+}")),
            Some("0".to_owned()),
        ],
    }
}

struct Harness {
    app: Router,
    clock: Clock,
    data: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(enabled: bool) -> Harness {
        let clock = Clock::fake(kst(date_of(24), 10, 0, 0));
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
            clock: clock.clone(),
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
        Harness { app: router(state), clock, data, _tmp: tmp }
    }

    fn shared(&self) -> PathBuf {
        self.data.join("shared")
    }

    fn write_flow<K: CollectedKind>(&self, date: &str, key: &str, rows: &[FlowRow]) {
        let path = flow_path(&self.shared(), date, K::TYPE_CODE, "005930", key);
        FlowWriter::open(&path, FlowDescription::new(K::TYPE_CODE, "005930", date, key, K::fids()))
            .unwrap()
            .append(rows)
            .unwrap();
    }

    fn write_links(&self, date: &str, key: &str, lines: &[(i64, &str)]) {
        let path = flow_links_path(&self.shared(), date, key);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: String = lines.iter().map(|(t, event)| format!("{}\n", json!({"t": t * 1000, "event": event}))).collect();
        std::fs::write(path, text).unwrap();
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }
}

#[tokio::test]
async fn rejects_bad_symbol_index_and_non_intraday_periods() {
    let h = Harness::start(true).await;
    for path in [
        "/api/symbols/bad/tick-cvd?period=1m",
        "/api/symbols/IDX:001/tick-cvd?period=1m",
        "/api/symbols/005930/tick-cvd?period=D",
        "/api/symbols/005930/tick-cvd?period=2m",
        "/api/symbols/005930/tick-cvd",
        "/api/symbols/005930/tick-cvd?period=1m&from=200&to=100",
        "/api/symbols/IDX:001/program-series?period=5m",
        "/api/symbols/005930/program-series?period=W",
    ] {
        let (status, body) = h.get(path).await;
        assert_eq!(status, 400, "{path}: {body}");
        assert_eq!(body["error"]["code"], "bad_request", "{path}: {body}");
    }
}

#[tokio::test]
async fn disabled_and_not_collected_states_return_cleanly() {
    let disabled = Harness::start(false).await;
    for path in [
        "/api/symbols/005930/tick-cvd?period=1m",
        "/api/symbols/005930/program-series?period=1m",
    ] {
        let (status, body) = disabled.get(path).await;
        assert_eq!(status, 200, "{path}: {body}");
        assert_eq!(body["state"], "disabled", "{path}: {body}");
        assert_eq!(body["points"], json!([]));
    }

    let enabled = Harness::start(true).await;
    for path in [
        "/api/symbols/000660/tick-cvd?period=1m",
        "/api/symbols/000660/program-series?period=5m",
    ] {
        let (status, body) = enabled.get(path).await;
        assert_eq!(status, 200, "{path}: {body}");
        assert_eq!(body["state"], "not_collected", "{path}: {body}");
        assert_eq!(body["points"], json!([]));
    }
}

#[tokio::test]
async fn tick_cvd_classifies_exact_boundaries_and_resets_cumulatively_per_day() {
    let h = Harness::start(true).await;
    write_complete(&h.data, CLOSED);
    write_parquet(
        &h.data,
        CLOSED,
        "0B",
        "005930_AL",
        &[
            tick_sql(at_sec(23, 9, 0, 1) * 1000, "090001", 4_999_999, 1),
            tick_sql(at_sec(23, 9, 0, 2) * 1000, "090002", 5_000_000, 1),
            tick_sql(at_sec(23, 9, 0, 3) * 1000, "090003", 29_999_999, -1),
            tick_sql(at_sec(23, 9, 0, 4) * 1000, "090004", 30_000_000, 1),
            tick_sql(at_sec(23, 9, 1, 1) * 1000, "090101", 99_999_999, -1),
            tick_sql(at_sec(23, 9, 1, 2) * 1000, "090102", 100_000_000, 1),
        ],
    );
    h.write_links(TODAY, "collect-01", &[(at_sec(24, 9, 0, 0), "connected")]);
    h.write_flow::<TradeTicks>(
        TODAY,
        "collect-01",
        &[
            tick_flow_row(at_sec(24, 9, 0, 5) * 1000, "090005", 100_000, -1_500),
            tick_flow_row(at_sec(24, 9, 0, 10) * 1000, "090010", 1_000, 1_000),
        ],
    );

    let from = at_sec(23, 9, 0, 0);
    let to = at_sec(24, 9, 5, 0);
    let (status, body) = h.get(&format!("/api/symbols/005930/tick-cvd?period=1m&from={from}&to={to}")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "ready");
    let points = body["points"].as_array().unwrap();
    assert_eq!(points.len(), 3, "{body}");

    assert_eq!(points[0]["t"], at_sec(23, 9, 0, 0));
    assert!((points[0]["retailNetMillionWon"].as_f64().unwrap() - 4.999_999).abs() < 1e-6);
    assert!((points[0]["midNetMillionWon"].as_f64().unwrap() - (-24.999_999)).abs() < 1e-6);
    assert!((points[0]["largeNetMillionWon"].as_f64().unwrap() - 30.0).abs() < 1e-6);
    assert!((points[0]["whaleNetMillionWon"].as_f64().unwrap() - 0.0).abs() < 1e-6);

    assert_eq!(points[1]["t"], at_sec(23, 9, 1, 0));
    assert!((points[1]["retailNetMillionWon"].as_f64().unwrap() - 4.999_999).abs() < 1e-6);
    assert!((points[1]["midNetMillionWon"].as_f64().unwrap() - (-24.999_999)).abs() < 1e-6);
    assert!((points[1]["largeNetMillionWon"].as_f64().unwrap() - (-69.999_999)).abs() < 1e-6);
    assert!((points[1]["whaleNetMillionWon"].as_f64().unwrap() - 100.0).abs() < 1e-6);

    assert_eq!(points[2]["t"], at_sec(24, 9, 0, 0));
    assert!((points[2]["whaleNetMillionWon"].as_f64().unwrap() - (-150.0)).abs() < 1e-6);
    assert!((points[2]["retailNetMillionWon"].as_f64().unwrap() - 1.0).abs() < 1e-6);
    assert!((points[2]["largeNetMillionWon"].as_f64().unwrap() - 0.0).abs() < 1e-6);
    assert!((points[2]["midNetMillionWon"].as_f64().unwrap() - 0.0).abs() < 1e-6);

    let (status2, body2) = h.get("/api/symbols/005930/tick-cvd?period=5m").await;
    assert_eq!(status2, 200, "{body2}");
    assert_eq!(body2["state"], "ready");
    let latest_pts = body2["points"].as_array().unwrap();
    assert_eq!(latest_pts.len(), 1);
    assert_eq!(latest_pts[0]["t"], at_sec(24, 9, 0, 0));
    assert!((latest_pts[0]["whaleNetMillionWon"].as_f64().unwrap() - (-150.0)).abs() < 1e-6);
}

#[tokio::test]
async fn program_series_buckets_and_computes_program_share_pct() {
    let h = Harness::start(true).await;
    write_complete(&h.data, CLOSED);
    write_parquet(
        &h.data,
        CLOSED,
        "0w",
        "005930_AL",
        &[
            program_sql(at_sec(23, 9, 0, 10) * 1000, "090010", 10, 20, 100, 10),
            program_sql(at_sec(23, 9, 2, 30) * 1000, "090230", 25, 75, 500, 50),
            program_sql(at_sec(23, 9, 5, 10) * 1000, "090510", 100, 300, 2000, 200),
        ],
    );
    write_parquet(
        &h.data,
        CLOSED,
        "0B",
        "005930_AL",
        &[
            tick_sql(at_sec(23, 9, 1, 0) * 1000, "090100", 100_000, 2_000),
            tick_sql(at_sec(23, 9, 5, 0) * 1000, "090500", 100_000, 1_000),
        ],
    );

    let from = at_sec(23, 9, 0, 0);
    let to = at_sec(23, 9, 10, 0);
    let (status, body) = h.get(&format!("/api/symbols/005930/program-series?period=5m&from={from}&to={to}")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "ready");
    let points = body["points"].as_array().unwrap();
    assert_eq!(points.len(), 2, "{body}");

    assert_eq!(points[0]["t"], at_sec(23, 9, 0, 0));
    assert!((points[0]["netBuyAmountMillionWon"].as_f64().unwrap() - 50.0).abs() < 1e-6);
    assert_eq!(points[0]["netBuyQty"], 500);
    assert!((points[0]["buyAmountMillionWon"].as_f64().unwrap() - 75.0).abs() < 1e-6);
    assert!((points[0]["sellAmountMillionWon"].as_f64().unwrap() - 25.0).abs() < 1e-6);
    assert!((points[0]["programSharePct"].as_f64().unwrap() - 50.0).abs() < 1e-6);
    assert!((points[0]["dayTradedMillionWon"].as_f64().unwrap() - 200.0).abs() < 1e-6);

    assert_eq!(points[1]["t"], at_sec(23, 9, 5, 0));
    assert!((points[1]["netBuyAmountMillionWon"].as_f64().unwrap() - 200.0).abs() < 1e-6);
    assert!((points[1]["programSharePct"].as_f64().unwrap() - 100.0).abs() < 1e-6);
    assert!((points[1]["dayTradedMillionWon"].as_f64().unwrap() - 300.0).abs() < 1e-6);

    h.write_links(TODAY, "collect-01", &[(at_sec(24, 9, 0, 0), "connected")]);
    h.write_flow::<ProgramFlow>(
        TODAY,
        "collect-01",
        &[program_flow_row(at_sec(24, 9, 0, 20) * 1000, "090020", 15, 45, 300, 30)],
    );
    let (status2, body2) = h.get("/api/symbols/005930/program-series?period=1m").await;
    assert_eq!(status2, 200, "{body2}");
    assert_eq!(body2["state"], "ready");
    let pts2 = body2["points"].as_array().unwrap();
    assert_eq!(pts2.len(), 1);
    assert!((pts2[0]["netBuyAmountMillionWon"].as_f64().unwrap() - 30.0).abs() < 1e-6);
    assert!(pts2[0]["programSharePct"].is_null());
    assert!(pts2[0].get("dayTradedMillionWon").is_none());
}

#[tokio::test]
async fn close_grace_ticks_and_program_rows_fold_across_parquet_and_flow() {
    let h = Harness::start(true).await;
    write_complete(&h.data, CLOSED);
    write_parquet(
        &h.data,
        CLOSED,
        "0B",
        "005930_AL",
        &[
            tick_sql(at_sec(23, 19, 59, 40) * 1000, "195940", 100_000, 1_000),
            tick_sql(at_sec(23, 20, 0, 3) * 1000, "200003", 100_000, 1_500),
        ],
    );
    write_parquet(
        &h.data,
        CLOSED,
        "0w",
        "005930_AL",
        &[
            program_sql(at_sec(23, 19, 59, 45) * 1000, "195945", 20, 50, 300, 30),
            program_sql(at_sec(23, 20, 0, 4) * 1000, "200004", 30, 95, 650, 65),
        ],
    );
    h.write_links(TODAY, "collect-01", &[(at_sec(24, 9, 0, 0), "connected")]);
    h.write_flow::<TradeTicks>(
        TODAY,
        "collect-01",
        &[tick_flow_row(at_sec(24, 19, 59, 50) * 1000, "195950", 100_000, 1_000)],
    );
    h.write_flow::<ProgramFlow>(
        TODAY,
        "collect-01",
        &[program_flow_row(at_sec(24, 19, 59, 50) * 1000, "195950", 10, 30, 200, 20)],
    );

    let from = at_sec(23, 19, 0, 0);
    let to = at_sec(24, 20, 5, 0);
    let (s_init, _) = h.get(&format!("/api/symbols/005930/tick-cvd?period=1m&from={from}&to={to}")).await;
    assert_eq!(s_init, 200);
    let (sp_init, _) = h.get(&format!("/api/symbols/005930/program-series?period=1m&from={from}&to={to}")).await;
    assert_eq!(sp_init, 200);

    h.write_flow::<TradeTicks>(
        TODAY,
        "collect-01",
        &[tick_flow_row(at_sec(24, 20, 0, 5) * 1000, "200005", 100_000, 2_000)],
    );
    h.write_flow::<ProgramFlow>(
        TODAY,
        "collect-01",
        &[program_flow_row(at_sec(24, 20, 0, 5) * 1000, "200005", 40, 110, 700, 70)],
    );
    h.clock.jump(5);

    for (period, d1_t, d2_t) in [
        ("1m", at_sec(23, 19, 59, 0), at_sec(24, 19, 59, 0)),
        ("5m", at_sec(23, 19, 55, 0), at_sec(24, 19, 55, 0)),
        ("60m", at_sec(23, 19, 0, 0), at_sec(24, 19, 0, 0)),
    ] {
        let (sc, cvd) = h.get(&format!("/api/symbols/005930/tick-cvd?period={period}&from={from}&to={to}")).await;
        assert_eq!(sc, 200, "{period}: {cvd}");
        let cvd_pts = cvd["points"].as_array().unwrap();
        assert_eq!(cvd_pts.len(), 2, "{period}: {cvd}");
        assert_eq!(cvd_pts[0]["t"], d1_t);
        assert!((cvd_pts[0]["whaleNetMillionWon"].as_f64().unwrap() - 250.0).abs() < 1e-6);
        assert_eq!(cvd_pts[1]["t"], d2_t);
        assert!((cvd_pts[1]["whaleNetMillionWon"].as_f64().unwrap() - 300.0).abs() < 1e-6);

        let (sp, prog) = h.get(&format!("/api/symbols/005930/program-series?period={period}&from={from}&to={to}")).await;
        assert_eq!(sp, 200, "{period}: {prog}");
        let prog_pts = prog["points"].as_array().unwrap();
        assert_eq!(prog_pts.len(), 2, "{period}: {prog}");
        assert_eq!(prog_pts[0]["t"], d1_t);
        assert!((prog_pts[0]["netBuyAmountMillionWon"].as_f64().unwrap() - 65.0).abs() < 1e-6);
        assert!((prog_pts[0]["dayTradedMillionWon"].as_f64().unwrap() - 250.0).abs() < 1e-6);
        assert!((prog_pts[0]["programSharePct"].as_f64().unwrap() - 50.0).abs() < 1e-6);
        assert_eq!(prog_pts[1]["t"], d2_t);
        assert!((prog_pts[1]["netBuyAmountMillionWon"].as_f64().unwrap() - 70.0).abs() < 1e-6);
        assert!((prog_pts[1]["dayTradedMillionWon"].as_f64().unwrap() - 300.0).abs() < 1e-6);
        assert!((prog_pts[1]["programSharePct"].as_f64().unwrap() - 50.0).abs() < 1e-6);
    }
}

#[test]
#[ignore]
fn tick_cvd_aggregates_100k_rows_within_250ms() {
    let day = date_of(23);
    let mut ticks = Vec::with_capacity(100_000);
    for i in 0..100_000usize {
        let secs = 9 * 3600 + (i % (6 * 3600 + 30 * 60)) as u32;
        let hh = secs / 3600;
        let mm = (secs % 3600) / 60;
        let ss = secs % 60;
        let (price, qty) = match i % 4 {
            0 => (70_000, 20),
            1 => (70_000, 150),
            2 => (70_000, 700),
            _ => (70_000, 2_000),
        };
        let signed_qty = if i % 3 == 0 { -qty } else { qty };
        let side = if signed_qty > 0 {
            Some(server::market_source::stream::TradeSide::Buy)
        } else {
            Some(server::market_source::stream::TradeSide::Sell)
        };
        ticks.push(CollectedTradeTick {
            recv_ms: i as i64,
            hhmmss: TimeOfDay::hms(hh, mm, ss).unwrap(),
            price_won: price,
            signed_qty,
            side,
            instant_value_thousand_won: None,
            exchange: None,
        });
    }
    let mut timings_ms = Vec::with_capacity(5);
    let mut last_len = 0usize;
    for _ in 0..5 {
        let started = Instant::now();
        let points = aggregate_tick_cvd_day(day, &ticks, Period::M1, None, None);
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        last_len = points.len();
        timings_ms.push(elapsed_ms);
    }
    timings_ms.sort_by(|a, b| a.total_cmp(b));
    let median = timings_ms[timings_ms.len() / 2];
    println!(
        "tick_cvd 100k rows -> {last_len} 1m points: min={:.3}ms median={:.3}ms max={:.3}ms runs={timings_ms:?}",
        timings_ms[0],
        median,
        timings_ms[timings_ms.len() - 1]
    );
    assert_eq!(last_len, 390);
    assert!(median < 250.0, "median {median:.3}ms exceeded 250ms budget");
}

#[test]
fn unsigned_call_auction_ticks_do_not_skew_cvd_buckets() {
    let day = date_of(23);
    let ticks = vec![
        CollectedTradeTick {
            recv_ms: 1,
            hhmmss: TimeOfDay::hms(9, 0, 0).unwrap(),
            price_won: 100_000,
            signed_qty: 2_000,
            side: None,
            instant_value_thousand_won: None,
            exchange: None,
        },
        CollectedTradeTick {
            recv_ms: 2,
            hhmmss: TimeOfDay::hms(9, 0, 5).unwrap(),
            price_won: 100_000,
            signed_qty: -1_000,
            side: Some(server::market_source::stream::TradeSide::Sell),
            instant_value_thousand_won: None,
            exchange: None,
        },
    ];
    let points = aggregate_tick_cvd_day(day, &ticks, Period::M1, None, None);
    assert_eq!(points.len(), 1);
    assert!((points[0].whale_net_million_won - (-100.0)).abs() < 1e-9);
}
