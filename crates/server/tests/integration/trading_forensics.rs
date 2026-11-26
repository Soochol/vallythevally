use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::Request;
use axum::Router;
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use duckdb::Connection;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::http::{AppState, router};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::shared_data::{CollectorPaths, FlowDescription, FlowRow, FlowWriter, flow_path};
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tower::ServiceExt;

const ACCOUNT: &str = "5550120110";
const HOST: &str = "127.0.0.1:7777";
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

fn write_complete(data: &Path, date: &str, codes: &[&str]) {
    let folder = data.join("store").join(date);
    std::fs::create_dir_all(&folder).unwrap();
    let stocks: Vec<Value> = codes
        .iter()
        .map(|code| json!({"code": code, "key": "collect-01", "registered": true, "received": true, "gaps": [], "handoff": null}))
        .collect();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": BUCKETS},
        "raw_files": {"collect-01/1530-000.jsonl.zst": 10},
        "stocks": stocks,
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn write_parquet_groups(data: &Path, date: &str, type_code: &str, symbol_rows: &[(&str, Vec<String>)]) {
    let mut by_bucket: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (symbol_bucket, rows) in symbol_rows {
        by_bucket.entry(bucket_file(symbol_bucket)).or_default().extend(rows.iter().cloned());
    }
    for (file, rows) in by_bucket {
        let parquet = data.join("store").join(date).join(type_code).join(file);
        std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(&format!("SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)", rows.join(" UNION ALL "), parquet.display()))
            .unwrap();
    }
}

fn tick_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: i64, signed_qty: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, {signed_qty}::BIGINT AS f15, NULL::BIGINT AS f1313, 'KRX' AS f9081"
    )
}

fn program_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: i64, net_million: i64, change_million: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, \
         0::BIGINT AS f202, 0::BIGINT AS f204, 0::BIGINT AS f206, 0::BIGINT AS f208, \
         0::BIGINT AS f210, 0::BIGINT AS f211, {net_million}::BIGINT AS f212, {change_million}::BIGINT AS f213"
    )
}

fn book_sql(symbol: &str, recv_ms: i64, ask0_price: i64, ask0_qty: i64, bid0_price: i64, bid0_qty: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, \
         {ask0_price}::BIGINT AS f41, {ask0_qty}::BIGINT AS f61, 70200::BIGINT AS f42, 1000::BIGINT AS f62, \
         70300::BIGINT AS f43, 1000::BIGINT AS f63, 70400::BIGINT AS f44, 1000::BIGINT AS f64, \
         70500::BIGINT AS f45, 1000::BIGINT AS f65, 0::BIGINT AS f46, 0::BIGINT AS f66, \
         0::BIGINT AS f47, 0::BIGINT AS f67, 0::BIGINT AS f48, 0::BIGINT AS f68, \
         0::BIGINT AS f49, 0::BIGINT AS f69, 0::BIGINT AS f50, 0::BIGINT AS f70, \
         {bid0_price}::BIGINT AS f51, {bid0_qty}::BIGINT AS f71, 69900::BIGINT AS f52, 1000::BIGINT AS f72, \
         69800::BIGINT AS f53, 1000::BIGINT AS f73, 69700::BIGINT AS f54, 1000::BIGINT AS f74, \
         69600::BIGINT AS f55, 1000::BIGINT AS f75, 0::BIGINT AS f56, 0::BIGINT AS f76, \
         0::BIGINT AS f57, 0::BIGINT AS f77, 0::BIGINT AS f58, 0::BIGINT AS f78, \
         0::BIGINT AS f59, 0::BIGINT AS f79, 0::BIGINT AS f60, 0::BIGINT AS f80"
    )
}

fn execution_row(order_no: &str, code: &str, name: &str, side: &str, qty: u64, price: u64, time: &str) -> Value {
    let io_tp_nm = if side == "buy" { "현금매수" } else { "현금매도" };
    json!({
        "ord_no": order_no,
        "stk_cd": format!("A{code}"),
        "stk_nm": name,
        "trde_tp": "보통",
        "io_tp_nm": io_tp_nm,
        "cntr_qty": format!("{qty:010}"),
        "cntr_uv": format!("{price:010}"),
        "ord_tm": time,
        "cnfm_tm": time,
        "dmst_stex_tp": "KRX",
    })
}

struct Harness {
    state: Arc<AppState>,
    app: Router,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(now: domain::KstTime, hoga: Option<PathBuf>, executions: Vec<Value>, symbol_codes: &[(&str, &str)]) -> Harness {
        Self::start_with_paths(now, CollectorPaths::new(hoga, None), executions, symbol_codes).await
    }

    async fn start_with_paths(
        now: domain::KstTime,
        paths: CollectorPaths,
        executions: Vec<Value>,
        symbol_codes: &[(&str, &str)],
    ) -> Harness {
        let clock = Clock::fake(now);
        let transport = ScriptedTransport::new();
        transport.respond_with("ka00001", 200, json!({"acctNo": ACCOUNT, "return_code": 0, "return_msg": "정상"}));
        transport.respond_with("kt00007", 200, json!({"acnt_ord_cntr_prps_dtl": executions, "return_code": 0, "return_msg": "정상"}));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(transport.transport(), auth, clock.clone());
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(8);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let symbols = Arc::new(SymbolDirectory::default());
        let infos = symbol_codes
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
        state.rest.set_access(Access::Open);
        state.system.bound(HOST.parse().unwrap());
        state.collector_paths.configure(paths);
        let app = router(state.clone());
        let enable_req = Request::builder()
            .method("PUT")
            .uri("/api/system/orders")
            .header("host", HOST)
            .header("content-type", "application/json")
            .body(Body::from(json!({"enabled": true, "confirmAccountTail": "01"}).to_string()))
            .unwrap();
        let enable_resp = app.clone().oneshot(enable_req).await.unwrap();
        assert_eq!(enable_resp.status().as_u16(), 200);
        Harness { state, app, _tmp: tmp }
    }

    async fn get(&self, uri: &str) -> (u16, Value) {
        let req = Request::builder()
            .method("GET")
            .uri(uri)
            .header("host", HOST)
            .body(Body::empty())
            .unwrap();
        let response = self.app.clone().oneshot(req).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn insert_order_command(&self, command_id: &str, account_ref: &str, order_no: &str, code: &str, price: u64, created_at: i64) {
        let mut tx = self.state.db.begin_write().await.unwrap();
        sqlx::query(
            "INSERT INTO order_commands (command_id, account_ref, fingerprint, kind, code, venue, quantity, price, target_order_no, batch_id, state, order_no, reconciled, created_at, updated_at) \
             VALUES (?, ?, ?, 'buy', ?, 'krx', 10, ?, NULL, NULL, 'accepted', ?, 0, ?, ?)",
        )
        .bind(command_id)
        .bind(account_ref)
        .bind(format!("fp-{command_id}"))
        .bind(code)
        .bind(price as i64)
        .bind(order_no)
        .bind(created_at)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
}

#[tokio::test]
async fn forensics_endpoint_classifies_all_tags_joins_commands_and_validates_date() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let date = KstDate::parse_yyyymmdd("20261120").unwrap();
    let now = kst(date, 15, 0, 0);

    write_complete(&hoga, "20261120", &["005930", "000660", "035420", "005380", "035720"]);
    write_parquet_groups(
        &hoga,
        "20261120",
        "0D",
        &[
            (
                "005930_AL",
                vec![
                    book_sql("005930_AL", at_ms(date, 9, 10, 0), 70_100, 5_000, 70_000, 2_000),
                    book_sql("005930_AL", at_ms(date, 9, 10, 2), 70_100, 100, 70_000, 2_000),
                ],
            ),
            (
                "000660_AL",
                vec![
                    book_sql("000660_AL", at_ms(date, 9, 20, 0), 70_100, 1_000, 70_000, 1_000),
                    book_sql("000660_AL", at_ms(date, 9, 20, 2), 70_100, 1_000, 70_000, 950),
                ],
            ),
        ],
    );
    write_parquet_groups(
        &hoga,
        "20261120",
        "0B",
        &[
            (
                "005930_AL",
                vec![
                    tick_sql("005930_AL", at_ms(date, 9, 10, 5), "091005", 70_200, 50),
                    tick_sql("005930_AL", at_ms(date, 9, 12, 0), "091200", 69_600, -100),
                ],
            ),
            (
                "000660_AL",
                vec![
                    tick_sql("000660_AL", at_ms(date, 9, 20, 1), "092001", 70_000, -1_800),
                    tick_sql("000660_AL", at_ms(date, 9, 20, 5), "092005", 70_000, 50),
                    tick_sql("000660_AL", at_ms(date, 9, 23, 0), "092300", 70_700, 200),
                ],
            ),
            (
                "035420_AL",
                vec![
                    tick_sql("035420_AL", at_ms(date, 9, 30, 0), "093000", 100_000, 1_500),
                    tick_sql("035420_AL", at_ms(date, 9, 30, 20), "093020", 100_000, 50),
                    tick_sql("035420_AL", at_ms(date, 9, 33, 0), "093300", 101_000, 80),
                ],
            ),
            (
                "005380_AL",
                vec![
                    tick_sql("005380_AL", at_ms(date, 10, 0, 0), "100000", 50_000, -20),
                    tick_sql("005380_AL", at_ms(date, 10, 3, 0), "100300", 50_500, 100),
                ],
            ),
            (
                "035720_AL",
                vec![
                    tick_sql("035720_AL", at_ms(date, 10, 30, 0), "103000", 40_000, 20),
                    tick_sql("035720_AL", at_ms(date, 10, 32, 0), "103200", 40_050, 20),
                ],
            ),
        ],
    );
    write_parquet_groups(
        &hoga,
        "20261120",
        "0w",
        &[(
            "005380_AL",
            vec![
                program_sql("005380_AL", at_ms(date, 9, 59, 50), "095950", 50_000, 40, 10),
                program_sql("005380_AL", at_ms(date, 10, 3, 0), "100300", 50_500, 200, 160),
            ],
        )],
    );

    let executions = vec![
        execution_row("0000101", "005930", "삼성전자", "buy", 10, 70_200, "09:10:05"),
        execution_row("0000102", "000660", "SK하이닉스", "buy", 5, 70_000, "09:20:05"),
        execution_row("0000103", "035420", "NAVER", "buy", 4, 100_000, "09:30:20"),
        execution_row("0000104", "005380", "현대차", "sell", 8, 50_000, "10:00:00"),
        execution_row("0000105", "035720", "카카오", "buy", 3, 40_000, "10:30:00"),
    ];
    let h = Harness::start(
        now,
        Some(hoga),
        executions,
        &[
            ("005930", "삼성전자"),
            ("000660", "SK하이닉스"),
            ("035420", "NAVER"),
            ("005380", "현대차"),
            ("035720", "카카오"),
        ],
    )
    .await;

    let account_ref = h.state.accounts.status(None).unwrap().account_ref.unwrap();
    h.insert_order_command("cmd-forensic-001", &account_ref, "0000101", "005930", 70_000, now.unix()).await;

    let (bad_status, _) = h.get("/api/trading/executions/forensics?date=2026-11-20").await;
    assert_eq!(bad_status, 400);

    let (status, body) = h.get("/api/trading/executions/forensics?date=20261120").await;
    assert_eq!(status, 200);
    assert_eq!(body["date"], "20261120");
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 5);

    assert_eq!(items[0]["diagnosis"], "spoof_chase_trap");
    assert_eq!(items[0]["collected"], true);
    assert_eq!(items[0]["slippageTicks"], 2);
    assert_eq!(items[0]["preEntryCancelRatePct"], 100.0);
    assert_eq!(items[0]["maePct"], -0.85);

    assert_eq!(items[1]["diagnosis"], "iceberg_support");
    assert_eq!(items[1]["mfePct"], 1.0);
    assert_eq!(items[1]["maePct"], 0.0);

    assert_eq!(items[2]["diagnosis"], "whale_divergence");
    assert_eq!(items[2]["whaleNetDeltaMillionWon"], 150.0);
    assert_eq!(items[2]["mfePct"], 1.0);

    assert_eq!(items[3]["diagnosis"], "early_stop_before_program");
    assert_eq!(items[3]["programDeltaMillionWon"], 170.0);
    assert_eq!(items[3]["maePct"], -1.0);

    assert_eq!(items[4]["diagnosis"], "neutral");
    assert_eq!(items[4]["collected"], true);
}

#[tokio::test]
async fn forensics_endpoint_returns_uncollected_fallback_without_collector_data() {
    let date = KstDate::parse_yyyymmdd("20261125").unwrap();
    let now = kst(date, 11, 0, 0);
    let executions = vec![execution_row("0000201", "005930", "삼성전자", "buy", 10, 70_000, "09:30:15")];
    let h = Harness::start(now, None, executions, &[("005930", "삼성전자")]).await;

    let (status, body) = h.get("/api/trading/executions/forensics").await;
    assert_eq!(status, 200);
    assert_eq!(body["date"], "20261125");
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["collected"], false);
    assert_eq!(items[0]["diagnosis"], "neutral");
    assert!(items[0]["mfePct"].is_null());
    assert!(items[0]["maePct"].is_null());
    assert!(items[0]["slippageTicks"].is_null());
    assert!(items[0]["preEntryCancelRatePct"].is_null());
    assert!(items[0]["programDeltaMillionWon"].is_null());
    assert!(items[0]["whaleNetDeltaMillionWon"].is_null());
    assert_eq!(items[0]["summary"], "수집 데이터가 없어 체결 해부를 표시할 수 없습니다");
}

#[tokio::test]
async fn forensics_endpoint_returns_empty_items_for_mismatched_past_date() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let past_date = KstDate::parse_yyyymmdd("20261119").unwrap();
    let today = KstDate::parse_yyyymmdd("20261120").unwrap();
    let now = kst(today, 11, 0, 0);

    write_complete(&hoga, "20261119", &["005930"]);
    write_parquet_groups(
        &hoga,
        "20261119",
        "0B",
        &[(
            "005930_AL",
            vec![tick_sql("005930_AL", at_ms(past_date, 9, 30, 0), "093000", 65_000, 50)],
        )],
    );

    let executions = vec![execution_row("0000301", "005930", "삼성전자", "buy", 10, 70_000, "09:30:00")];
    let h = Harness::start(now, Some(hoga), executions, &[("005930", "삼성전자")]).await;

    let (status, body) = h.get("/api/trading/executions/forensics?date=20261119").await;
    assert_eq!(status, 200);
    assert_eq!(body["date"], "20261119");
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn forensics_live_flow_growth_within_throttle_window_does_not_poison_cache() {
    let tmp = tempfile::tempdir().unwrap();
    let shared = tmp.path().join("shared");
    let date = KstDate::parse_yyyymmdd("20261125").unwrap();
    let now = kst(date, 9, 35, 0);
    let fids: [u32; 5] = [20, 10, 15, 1313, 9081];
    let path = flow_path(&shared, "20261125", "0B", "005930", "k1");

    FlowWriter::open(&path, FlowDescription::new("0B", "005930", "20261125", "k1", &fids))
        .unwrap()
        .append(&[FlowRow {
            recv_ms: at_ms(date, 9, 30, 0),
            values: vec![
                Some("093000".to_owned()),
                Some("70000".to_owned()),
                Some("50".to_owned()),
                None,
                Some("KRX".to_owned()),
            ],
        }])
        .unwrap();

    let executions = vec![execution_row("0000401", "005930", "삼성전자", "buy", 10, 70_000, "09:30:00")];
    let h = Harness::start_with_paths(
        now,
        CollectorPaths::new(None, Some(shared.clone())),
        executions,
        &[("005930", "삼성전자")],
    )
    .await;

    let (status1, body1) = h.get("/api/trading/executions/forensics").await;
    assert_eq!(status1, 200);
    assert_eq!(body1["items"][0]["collected"], true);
    assert_eq!(body1["items"][0]["maePct"], 0.0);

    FlowWriter::open(&path, FlowDescription::new("0B", "005930", "20261125", "k1", &fids))
        .unwrap()
        .append(&[FlowRow {
            recv_ms: at_ms(date, 9, 32, 0),
            values: vec![
                Some("093200".to_owned()),
                Some("69000".to_owned()),
                Some("-100".to_owned()),
                None,
                Some("KRX".to_owned()),
            ],
        }])
        .unwrap();

    let (status2, body2) = h.get("/api/trading/executions/forensics").await;
    assert_eq!(status2, 200);
    assert_eq!(body2["items"][0]["maePct"], 0.0);

    h.state.clock.jump(120);

    let (status3, body3) = h.get("/api/trading/executions/forensics").await;
    assert_eq!(status3, 200);
    assert_eq!(body3["items"][0]["maePct"], -1.43);
}

#[tokio::test]
async fn forensics_intended_price_ignores_prior_day_and_other_symbol_collisions() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let date = KstDate::parse_yyyymmdd("20261120").unwrap();
    let now = kst(date, 15, 0, 0);

    write_complete(&hoga, "20261120", &["005930"]);
    write_parquet_groups(
        &hoga,
        "20261120",
        "0B",
        &[(
            "005930_AL",
            vec![tick_sql("005930_AL", at_ms(date, 9, 10, 5), "091005", 70_100, 50)],
        )],
    );

    let executions = vec![execution_row("0000101", "005930", "삼성전자", "buy", 10, 70_200, "09:10:05")];
    let h = Harness::start(now, Some(hoga), executions, &[("005930", "삼성전자"), ("000660", "SK하이닉스")]).await;
    let account_ref = h.state.accounts.status(None).unwrap().account_ref.unwrap();

    h.insert_order_command("cmd-prior-day", &account_ref, "0000101", "005930", 60_000, now.unix() - 86_400).await;
    h.insert_order_command("cmd-other-symbol", &account_ref, "0000101", "000660", 65_000, now.unix()).await;

    let (status, body) = h.get("/api/trading/executions/forensics?date=20261120").await;
    assert_eq!(status, 200);
    assert_eq!(body["items"][0]["slippageTicks"], 1);
}

#[tokio::test]
#[ignore]
async fn forensics_50_executions_across_10_symbols_perf() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let date = KstDate::parse_yyyymmdd("20261120").unwrap();
    let now = kst(date, 15, 30, 0);

    let symbols: Vec<(String, String)> = (0..10)
        .map(|i| (format!("{:06}", 10000 + i), format!("종목{i}")))
        .collect();
    let code_refs: Vec<&str> = symbols.iter().map(|(c, _)| c.as_str()).collect();
    write_complete(&hoga, "20261120", &code_refs);

    let mut tick_groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut prog_groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut book_groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut executions = Vec::new();

    for (idx, (code, name)) in symbols.iter().enumerate() {
        let sym = format!("{code}_AL");
        let mut ticks = Vec::new();
        let mut progs = Vec::new();
        let mut books = Vec::new();
        for minute in 0..60u32 {
            let h = 9 + minute / 60;
            let m = minute % 60;
            let hhmmss = format!("{h:02}{m:02}00");
            let price = 50_000 + ((minute as i64 % 10) * 100);
            ticks.push(tick_sql(&sym, at_ms(date, h, m, 0), &hhmmss, price, if minute % 2 == 0 { 100 } else { -80 }));
            ticks.push(tick_sql(&sym, at_ms(date, h, m, 30), &format!("{h:02}{m:02}30"), price + 100, 120));
            progs.push(program_sql(&sym, at_ms(date, h, m, 0), &hhmmss, price, (minute as i64) * 5, 5));
        }
        books.push(book_sql(&sym, at_ms(date, 9, 10, 0), 50_100, 5_000, 50_000, 2_000));
        books.push(book_sql(&sym, at_ms(date, 9, 10, 2), 50_100, 100, 50_000, 2_000));
        tick_groups.push((sym.clone(), ticks));
        prog_groups.push((sym.clone(), progs));
        book_groups.push((sym, books));

        for fill_i in 0..5u32 {
            let m = 5 + fill_i * 10;
            let ord_no = format!("{:07}", idx * 10 + fill_i as usize + 1);
            executions.push(execution_row(&ord_no, code, name, if fill_i % 2 == 0 { "buy" } else { "sell" }, 10, 50_200, &format!("09:{m:02}:05")));
        }
    }

    let tick_pairs: Vec<(&str, Vec<String>)> = tick_groups.iter().map(|(s, r)| (s.as_str(), r.clone())).collect();
    let prog_pairs: Vec<(&str, Vec<String>)> = prog_groups.iter().map(|(s, r)| (s.as_str(), r.clone())).collect();
    let book_pairs: Vec<(&str, Vec<String>)> = book_groups.iter().map(|(s, r)| (s.as_str(), r.clone())).collect();
    write_parquet_groups(&hoga, "20261120", "0B", &tick_pairs);
    write_parquet_groups(&hoga, "20261120", "0w", &prog_pairs);
    write_parquet_groups(&hoga, "20261120", "0D", &book_pairs);

    let sym_pairs: Vec<(&str, &str)> = symbols.iter().map(|(c, n)| (c.as_str(), n.as_str())).collect();
    let h = Harness::start(now, Some(hoga), executions, &sym_pairs).await;
    let fills = h.state.accounts.executions(None).await.unwrap();
    assert_eq!(fills.executions.len(), 50);
    let cache = server::trading::forensics::ForensicsCache::new();
    let paths = h.state.collector_paths.snapshot();

    let cold_start = Instant::now();
    let cold = server::trading::forensics::compute_forensics(server::trading::forensics::ForensicsInputs {
        collected: &h.state.collected,
        micro_events: &h.state.micro_events,
        db: &h.state.db,
        symbols: &h.state.symbols,
        cache: &cache,
        paths: paths.clone(),
        date,
        date_str: "20261120",
        account_query: None,
        executions: &fills,
        now,
    })
    .await
    .unwrap();
    let cold_elapsed = cold_start.elapsed();
    assert_eq!(cold.items.len(), 50);

    let warm_start = Instant::now();
    let warm = server::trading::forensics::compute_forensics(server::trading::forensics::ForensicsInputs {
        collected: &h.state.collected,
        micro_events: &h.state.micro_events,
        db: &h.state.db,
        symbols: &h.state.symbols,
        cache: &cache,
        paths,
        date,
        date_str: "20261120",
        account_query: None,
        executions: &fills,
        now,
    })
    .await
    .unwrap();
    let warm_elapsed = warm_start.elapsed();
    assert_eq!(warm.items.len(), 50);

    println!(
        "forensics perf (50 executions / 10 symbols): cold={:.2}ms warm={:.2}ms",
        cold_elapsed.as_secs_f64() * 1000.0,
        warm_elapsed.as_secs_f64() * 1000.0,
    );
    assert!(cold_elapsed.as_millis() < 500, "cold took {:?}", cold_elapsed);
    assert!(warm_elapsed.as_millis() < 10, "warm took {:?}", warm_elapsed);
}
