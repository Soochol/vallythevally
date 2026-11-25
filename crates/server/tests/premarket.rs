mod support;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::collected::kind::{CollectedKind, ExpectedTrades};
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::premarket::{PreMarketCompare, PreMarketDays, PreMarketSignal, PreMarketSnapshot};
use server::shared_data::{CollectorPaths, FlowDescription, FlowRow, FlowWriter, flow_path};
use server::symbols::{Directory, SymbolDirectory};
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

fn at_ms(day: u8, hour: u32, minute: u32, second: u32) -> i64 {
    kst(KstDate::new(2026, 11, day).unwrap(), hour, minute, second).unix() * 1000
}

fn write_complete(data: &Path, date: &str, stocks: &[&str]) {
    let folder = data.join("store").join(date);
    std::fs::create_dir_all(&folder).unwrap();
    let entries: Vec<Value> = stocks
        .iter()
        .map(|code| json!({"code": code, "key": "collect-01", "registered": true, "received": true, "gaps": [], "handoff": null}))
        .collect();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": BUCKETS},
        "raw_files": {"collect-01/0900-000.jsonl.zst": 10},
        "stocks": entries,
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn write_parquet_buckets(data: &Path, date: &str, type_code: &str, by_bucket: &HashMap<String, Vec<String>>) {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("SET threads = 1;").unwrap();
    for (bucket, rows) in by_bucket {
        let parquet = data.join("store").join(date).join(type_code).join(bucket);
        std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
        let sql = format!("COPY ({}) TO '{}' (FORMAT parquet)", rows.join(" UNION ALL "), parquet.display());
        conn.execute_batch(&sql).unwrap();
    }
}

#[allow(clippy::too_many_arguments)]
fn expected_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: i64, change: i64, pct: f64, qty: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, {change}::BIGINT AS f11, {pct}::DOUBLE AS f12, {qty}::BIGINT AS f15, {qty}::BIGINT AS f13, 2::BIGINT AS f25"
    )
}

fn tick_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: i64, signed_qty: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, {signed_qty}::BIGINT AS f15, 100::BIGINT AS f1313, 'KRX' AS f9081"
    )
}

fn ext_sql(symbol: &str, recv_ms: i64, f592: &str) -> String {
    format!("SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{f592}' AS f592")
}

struct Harness {
    app: Router,
    data: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(enabled: bool, stock_names: &[(&str, &str)]) -> Harness {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 24).unwrap(), 9, 15, 0));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(ScriptedTransport::new().transport(), auth, clock.clone());
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let symbols = Arc::new(SymbolDirectory::default());
        let infos: Vec<SymbolInfo> = stock_names
            .iter()
            .map(|(code, name)| SymbolInfo {
                symbol: Symbol::parse(code).unwrap(),
                name: (*name).to_owned(),
                kind: SymbolKind::Common,
                market: Market::Kospi,
                nxt_enabled: true,
            })
            .collect();
        symbols.replace(Directory::build(infos));
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

    fn shared(&self) -> PathBuf {
        self.data.join("shared")
    }
}

#[tokio::test]
async fn four_day_compare_detects_spoof_genuine_gap_flat_and_0b_outcomes() {
    let h = Harness::start(true, &[("005930", "삼성전자")]).await;
    let sym = "005930_AL";
    let b = bucket_file(sym);

    type ExpRow = (u32, u32, u32, i64, i64, f64, i64);
    type TickRow = (u32, u32, u32, i64);
    let day_configs: &[(u8, &str, &[ExpRow], &[TickRow])] = &[
        (
            20,
            "20261120",
            &[
                (8, 40, 0, 70_000, 0, 0.0, 10_000),
                (8, 55, 0, 74_200, 4_200, 6.0, 50_000),
                (8, 59, 45, 70_700, 700, 1.0, 15_000),
            ],
            &[(9, 0, 1, 70_700), (9, 4, 50, 70_000), (9, 9, 55, 69_300)],
        ),
        (
            21,
            "20261121",
            &[
                (8, 45, 0, 71_400, 1_400, 2.0, 20_000),
                (8, 55, 0, 72_100, 2_100, 3.0, 30_000),
                (8, 59, 50, 72_450, 2_450, 3.5, 40_000),
            ],
            &[(9, 0, 0, 72_450), (9, 5, 0, 73_150), (9, 10, 0, 73_500)],
        ),
        (
            22,
            "20261122",
            &[
                (8, 50, 0, 70_350, 350, 0.5, 10_000),
                (8, 59, 40, 70_210, 210, 0.3, 12_000),
            ],
            &[(9, 0, 2, 70_140), (9, 5, 0, 70_000), (9, 9, 30, 70_070)],
        ),
        (
            23,
            "20261123",
            &[
                (8, 53, 0, 73_500, 3_500, 5.0, 25_000),
                (8, 59, 55, 72_800, 2_800, 4.0, 28_000),
            ],
            &[(9, 0, 0, 72_800), (9, 4, 30, 73_500), (9, 10, 0, 74_200)],
        ),
    ];

    for (day_num, date, exp_rows, tick_rows) in day_configs {
        write_complete(&h.data, date, &["005930"]);
        let mut oh = HashMap::new();
        oh.insert(
            b.clone(),
            exp_rows
                .iter()
                .map(|&(hr, mn, sc, price, chg, pct, qty)| {
                    expected_sql(sym, at_ms(*day_num, hr, mn, sc), &format!("{hr:02}{mn:02}{sc:02}"), price, chg, pct, qty)
                })
                .collect(),
        );
        write_parquet_buckets(&h.data, date, "0H", &oh);
        let mut ob = HashMap::new();
        ob.insert(
            b.clone(),
            tick_rows
                .iter()
                .map(|&(hr, mn, sc, price)| tick_sql(sym, at_ms(*day_num, hr, mn, sc), &format!("{hr:02}{mn:02}{sc:02}"), price, 10))
                .collect(),
        );
        write_parquet_buckets(&h.data, date, "0B", &ob);
    }

    let (status, body) = h.get("/api/symbols/005930/premarket/days").await;
    assert_eq!(status, 200, "{body}");
    let days: PreMarketDays = serde_json::from_value(body).unwrap();
    assert_eq!(days.days, vec!["20261120", "20261121", "20261122", "20261123"]);

    let (status, body) = h.get("/api/symbols/005930/premarket/compare?days=20261120,20261121,20261122,20261123").await;
    assert_eq!(status, 200, "{body}");
    let cmp: PreMarketCompare = serde_json::from_value(body).unwrap();
    assert_eq!(cmp.series.len(), 4);

    assert_eq!(cmp.series[0].date, "20261120");
    assert_eq!(cmp.series[0].classification, PreMarketSignal::SpoofWarning);
    assert_eq!(cmp.series[0].late_drop_pct, -5.0);
    assert_eq!(cmp.series[0].open_price_won, Some(70_700));
    assert_eq!(cmp.series[0].return_0900_pct, Some(1.0));
    assert_eq!(cmp.series[0].return_0905_pct, Some(0.0));
    assert_eq!(cmp.series[0].return_0910_pct, Some(-1.0));

    assert_eq!(cmp.series[1].date, "20261121");
    assert_eq!(cmp.series[1].classification, PreMarketSignal::GenuineGap);
    assert_eq!(cmp.series[1].return_0900_pct, Some(3.5));
    assert_eq!(cmp.series[1].return_0905_pct, Some(4.5));
    assert_eq!(cmp.series[1].return_0910_pct, Some(5.0));

    assert_eq!(cmp.series[2].date, "20261122");
    assert_eq!(cmp.series[2].classification, PreMarketSignal::Flat);

    assert_eq!(cmp.series[3].date, "20261123");
    assert_eq!(cmp.series[3].classification, PreMarketSignal::GenuineGap);

    let (status, default_body) = h.get("/api/symbols/005930/premarket/compare").await;
    assert_eq!(status, 200, "{default_body}");
    let default_cmp: PreMarketCompare = serde_json::from_value(default_body).unwrap();
    let default_dates: Vec<&str> = default_cmp.series.iter().map(|s| s.date.as_str()).collect();
    assert_eq!(default_dates, vec!["20261121", "20261122", "20261123"]);
}

#[tokio::test]
async fn snapshot_reads_closed_store_extension_flag_and_0b_outcomes() {
    let h = Harness::start(true, &[("005930", "삼성전자"), ("000660", "SK하이닉스"), ("035420", "NAVER")]).await;
    let date = "20261123";
    write_complete(&h.data, date, &["005930", "000660", "035420"]);

    let mut oh: HashMap<String, Vec<String>> = HashMap::new();
    oh.entry(bucket_file("005930_AL")).or_default().extend([
        expected_sql("005930_AL", at_ms(23, 8, 52, 0), "085200", 74_200, 4_200, 6.0, 20_000),
        expected_sql("005930_AL", at_ms(23, 8, 59, 45), "085945", 71_400, 1_400, 2.0, 15_000),
    ]);
    oh.entry(bucket_file("000660_AL")).or_default().extend([
        expected_sql("000660_AL", at_ms(23, 8, 55, 0), "085500", 208_000, 8_000, 4.0, 30_000),
        expected_sql("000660_AL", at_ms(23, 8, 59, 50), "085950", 208_000, 8_000, 4.0, 35_000),
    ]);
    oh.entry(bucket_file("035420_AL")).or_default().extend([
        expected_sql("035420_AL", at_ms(23, 8, 55, 0), "085500", 200_400, 400, 0.2, 5_000),
        expected_sql("035420_AL", at_ms(23, 8, 59, 50), "085950", 200_200, 200, 0.1, 5_000),
    ]);
    write_parquet_buckets(&h.data, date, "0H", &oh);

    let mut og: HashMap<String, Vec<String>> = HashMap::new();
    og.entry(bucket_file("000660_AL")).or_default().push(ext_sql("000660_AL", at_ms(23, 8, 59, 55), "Y"));
    og.entry(bucket_file("005930_AL")).or_default().push(ext_sql("005930_AL", at_ms(23, 8, 59, 55), "N"));
    write_parquet_buckets(&h.data, date, "0g", &og);

    let mut ob: HashMap<String, Vec<String>> = HashMap::new();
    ob.entry(bucket_file("005930_AL")).or_default().extend([
        tick_sql("005930_AL", at_ms(23, 9, 0, 1), "090001", 71_400, 100),
        tick_sql("005930_AL", at_ms(23, 9, 9, 50), "090950", 69_300, -50),
    ]);
    ob.entry(bucket_file("000660_AL")).or_default().extend([
        tick_sql("000660_AL", at_ms(23, 9, 0, 0), "090000", 208_000, 100),
        tick_sql("000660_AL", at_ms(23, 9, 10, 0), "091000", 212_000, 200),
    ]);
    write_parquet_buckets(&h.data, date, "0B", &ob);

    let (status, body) = h.get("/api/premarket/snapshot?date=20261123").await;
    assert_eq!(status, 200, "{body}");
    let snap: PreMarketSnapshot = serde_json::from_value(body).unwrap();
    assert_eq!(snap.date, "20261123");
    assert_eq!(snap.available_dates, vec!["20261123"]);
    assert_eq!(snap.rows.len(), 3);

    assert_eq!(snap.rows[0].code.0, "005930");
    assert_eq!(snap.rows[0].name, "삼성전자");
    assert_eq!(snap.rows[0].signal, PreMarketSignal::SpoofWarning);
    assert!(!snap.rows[0].pre_market_extended);
    assert_eq!(snap.rows[0].actual_0900_pct, Some(2.0));
    assert_eq!(snap.rows[0].actual_0910_pct, Some(-1.0));

    assert_eq!(snap.rows[1].code.0, "000660");
    assert_eq!(snap.rows[1].name, "SK하이닉스");
    assert_eq!(snap.rows[1].signal, PreMarketSignal::GenuineGap);
    assert!(snap.rows[1].pre_market_extended);
    assert_eq!(snap.rows[1].actual_0900_pct, Some(4.0));
    assert_eq!(snap.rows[1].actual_0910_pct, Some(6.0));

    assert_eq!(snap.rows[2].code.0, "035420");
    assert_eq!(snap.rows[2].signal, PreMarketSignal::Flat);
    assert!(!snap.rows[2].pre_market_extended);
}

#[tokio::test]
async fn snapshot_reads_today_live_flow_and_empty_store_falls_back_gracefully() {
    let empty = Harness::start(false, &[]).await;
    let (s1, b1) = empty.get("/api/symbols/005930/premarket/days").await;
    assert_eq!(s1, 200);
    let d1: PreMarketDays = serde_json::from_value(b1).unwrap();
    assert!(d1.days.is_empty());

    let (s2, b2) = empty.get("/api/premarket/snapshot").await;
    assert_eq!(s2, 200);
    let snap_empty: PreMarketSnapshot = serde_json::from_value(b2).unwrap();
    assert!(snap_empty.rows.is_empty());

    let h = Harness::start(true, &[("005930", "삼성전자")]).await;
    let flow_file = flow_path(&h.shared(), "20261124", ExpectedTrades::TYPE_CODE, "005930", "k1");
    FlowWriter::open(&flow_file, FlowDescription::new(ExpectedTrades::TYPE_CODE, "005930", "20261124", "k1", ExpectedTrades::fids()))
        .unwrap()
        .append(&[
            FlowRow {
                recv_ms: at_ms(24, 8, 52, 0),
                values: vec![
                    Some("085200".into()),
                    Some("+73500".into()),
                    Some("+3500".into()),
                    Some("+5.00".into()),
                    Some("20000".into()),
                    Some("20000".into()),
                    Some("2".into()),
                ],
            },
            FlowRow {
                recv_ms: at_ms(24, 8, 59, 45),
                values: vec![
                    Some("085945".into()),
                    Some("+71400".into()),
                    Some("+1400".into()),
                    Some("+2.00".into()),
                    Some("10000".into()),
                    Some("10000".into()),
                    Some("2".into()),
                ],
            },
        ])
        .unwrap();

    let (s3, b3) = h.get("/api/premarket/snapshot?date=20261124").await;
    assert_eq!(s3, 200, "{b3}");
    let snap: PreMarketSnapshot = serde_json::from_value(b3).unwrap();
    assert_eq!(snap.rows.len(), 1);
    assert_eq!(snap.rows[0].code.0, "005930");
    assert_eq!(snap.rows[0].signal, PreMarketSignal::SpoofWarning);
    assert_eq!(snap.rows[0].late_drop_pct, -3.0);
    assert_eq!(snap.rows[0].actual_0900_pct, None);
}

#[tokio::test]
async fn rejects_bad_dates_too_many_days_and_index_symbols() {
    let h = Harness::start(true, &[]).await;
    assert_eq!(h.get("/api/symbols/IDX:001/premarket/days").await.0, 400);
    assert_eq!(h.get("/api/symbols/IDX:001/premarket/compare").await.0, 400);
    assert_eq!(h.get("/api/symbols/005930/premarket/compare?days=bad").await.0, 400);
    assert_eq!(
        h.get("/api/symbols/005930/premarket/compare?days=20261119,20261120,20261121,20261122,20261123").await.0,
        400
    );
    assert_eq!(h.get("/api/premarket/snapshot?date=2026-11-23").await.0, 400);
}

#[tokio::test]
#[ignore]
async fn perf_four_day_compare_and_500_stock_closed_snapshot() {
    let mut stock_owned: Vec<(String, String)> = Vec::with_capacity(500);
    for idx in 0..500 {
        stock_owned.push((format!("{:06}", 100_000 + idx), format!("종목{idx:03}")));
    }
    let stock_refs: Vec<(&str, &str)> = stock_owned.iter().map(|(c, n)| (c.as_str(), n.as_str())).collect();
    let code_refs: Vec<&str> = stock_owned.iter().map(|(c, _)| c.as_str()).collect();
    let h = Harness::start(true, &stock_refs).await;

    let target_code = stock_owned[0].0.clone();
    let target_sym = format!("{target_code}_AL");
    for (day_num, date) in [(20u8, "20261120"), (21u8, "20261121"), (22u8, "20261122")] {
        write_complete(&h.data, date, &[target_code.as_str()]);
        let mut oh: HashMap<String, Vec<String>> = HashMap::new();
        let mut rows = Vec::new();
        for step in 0..180 {
            let sec = 8 * 3600 + 30 * 60 + step * 10;
            let hr = sec / 3600;
            let mn = (sec % 3600) / 60;
            let sc = sec % 60;
            rows.push(expected_sql(
                &target_sym,
                at_ms(day_num, hr, mn, sc),
                &format!("{hr:02}{mn:02}{sc:02}"),
                70_000 + i64::from(step) * 10,
                i64::from(step) * 10,
                f64::from(step) * 0.02,
                10_000,
            ));
        }
        oh.insert(bucket_file(&target_sym), rows);
        write_parquet_buckets(&h.data, date, "0H", &oh);
        let mut ob: HashMap<String, Vec<String>> = HashMap::new();
        ob.insert(
            bucket_file(&target_sym),
            vec![
                tick_sql(&target_sym, at_ms(day_num, 9, 0, 0), "090000", 71_800, 100),
                tick_sql(&target_sym, at_ms(day_num, 9, 5, 0), "090500", 72_000, 100),
                tick_sql(&target_sym, at_ms(day_num, 9, 10, 0), "091000", 72_200, 100),
            ],
        );
        write_parquet_buckets(&h.data, date, "0B", &ob);
    }

    let snap_date = "20261123";
    write_complete(&h.data, snap_date, &code_refs);
    let mut oh_500: HashMap<String, Vec<String>> = HashMap::new();
    let mut ob_500: HashMap<String, Vec<String>> = HashMap::new();
    let mut og_500: HashMap<String, Vec<String>> = HashMap::new();
    for (idx, (code, _)) in stock_owned.iter().enumerate() {
        let sym = format!("{code}_AL");
        let bucket = bucket_file(&sym);
        let base = 50_000i64 + (idx as i64 % 50) * 1_000;
        let peak_chg = if idx % 5 == 0 { base / 20 } else { base / 40 };
        let late_chg = if idx % 5 == 0 { base / 100 } else { base / 40 };
        let oh_entry = oh_500.entry(bucket.clone()).or_default();
        for step in 0..10 {
            let sec = 8 * 3600 + 50 * 60 + step * 60;
            let hr = sec / 3600;
            let mn = (sec % 3600) / 60;
            let sc = sec % 60;
            let chg = if step < 8 { peak_chg } else { late_chg };
            let pct = (chg as f64 / base as f64) * 100.0;
            oh_entry.push(expected_sql(
                &sym,
                at_ms(23, hr, mn, sc),
                &format!("{hr:02}{mn:02}{sc:02}"),
                base + chg,
                chg,
                pct,
                10_000 + (idx as i64) * 10,
            ));
        }
        ob_500.entry(bucket.clone()).or_default().extend([
            tick_sql(&sym, at_ms(23, 9, 0, 1), "090001", base + late_chg, 100),
            tick_sql(&sym, at_ms(23, 9, 9, 55), "090955", base + late_chg + 200, 100),
        ]);
        if idx % 20 == 0 {
            og_500.entry(bucket).or_default().push(ext_sql(&sym, at_ms(23, 8, 59, 55), "Y"));
        }
    }
    write_parquet_buckets(&h.data, snap_date, "0H", &oh_500);
    write_parquet_buckets(&h.data, snap_date, "0B", &ob_500);
    write_parquet_buckets(&h.data, snap_date, "0g", &og_500);

    let compare_path = format!("/api/symbols/{target_code}/premarket/compare?days=20261120,20261121,20261122,20261123");
    let t0 = Instant::now();
    let (status, body) = h.get(&compare_path).await;
    let compare_cold_ms = t0.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(status, 200, "{body}");
    let cmp: PreMarketCompare = serde_json::from_value(body).unwrap();
    assert_eq!(cmp.series.len(), 4);

    let t1 = Instant::now();
    let (status_warm, _) = h.get(&compare_path).await;
    let compare_warm_ms = t1.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(status_warm, 200);

    let t2 = Instant::now();
    let (snap_status, snap_body) = h.get("/api/premarket/snapshot?date=20261123").await;
    let snap_cold_ms = t2.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(snap_status, 200, "{snap_body}");
    let snap: PreMarketSnapshot = serde_json::from_value(snap_body).unwrap();
    assert_eq!(snap.rows.len(), 500);

    let t3 = Instant::now();
    let (snap_warm_status, _) = h.get("/api/premarket/snapshot?date=20261123").await;
    let snap_warm_ms = t3.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(snap_warm_status, 200);

    eprintln!(
        "premarket perf: compare_4d_cold={compare_cold_ms:.2}ms compare_4d_warm={compare_warm_ms:.2}ms snapshot_500_cold={snap_cold_ms:.2}ms snapshot_500_warm={snap_warm_ms:.2}ms"
    );
    assert!(compare_cold_ms < 400.0, "4-day compare cold {compare_cold_ms:.2}ms exceeded 400ms");
    assert!(compare_warm_ms < 5.0, "4-day compare warm {compare_warm_ms:.2}ms exceeded 5ms");
    assert!(snap_cold_ms < 1000.0, "500-stock snapshot cold {snap_cold_ms:.2}ms exceeded 1000ms");
    assert!(snap_warm_ms < 5.0, "500-stock snapshot warm {snap_warm_ms:.2}ms exceeded 5ms");
}
