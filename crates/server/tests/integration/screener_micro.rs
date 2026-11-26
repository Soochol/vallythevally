use crate::common;

use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::time::Duration;

use common::support::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
use common::{ScriptedTransport, Server};
use domain::{KstDate, Weekday};
use duckdb::{Config, Connection};
use serde_json::{Value, json};
use server::shared_data::{daily_micro_dir, daily_micro_path};

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn at(day: KstDate, hhmm: &str) -> String {
    format!("{}{hhmm}00", day.yyyymmdd())
}

fn open_days(from: KstDate, through: KstDate) -> Vec<KstDate> {
    std::iter::successors(Some(from), |d| Some(d.add_days(1)))
        .take_while(|d| *d <= through)
        .filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun))
        .collect()
}

fn bar(day: KstDate, price: u64, volume: u64) -> KrxBar {
    KrxBar { day, open: price, high: price, low: price, close: price, volume, traded_million_won: price * volume / 1_000_000, base: price, adjustment_rate: None }
}

fn stock(code: &str, bars: Vec<KrxBar>) -> KrxStock {
    KrxStock {
        code: code.into(),
        name: format!("가상{code}"),
        market_code: "0".into(),
        company_class_name: String::new(),
        reg_day: bars[0].day,
        audit_info: "정상".into(),
        listed_shares: Some(1_000_000),
        quoted: true,
        daily: DailyAnswer::Bars,
        bars,
    }
}

struct MicroRow<'a> {
    symbol: &'a str,
    whale_net_won: i64,
    program_net_won: i64,
    vi_count: i32,
}

fn write_micro_parquet(shared_dir: &Path, date: u32, rows: &[MicroRow<'_>]) {
    let path = daily_micro_path(shared_dir, date);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let config = Config::default().enable_autoload_extension(false).unwrap();
    let conn = Connection::open_in_memory_with_flags(config).unwrap();
    conn.execute_batch(
        "CREATE TABLE tmp_micro (date INTEGER, symbol VARCHAR, whale_net_won BIGINT, program_net_won BIGINT, program_share_bps INTEGER, foreign_est_net_qty BIGINT, spoof_cancel_rate_bps INTEGER, vi_count INTEGER, vwap_close_gap_bps INTEGER);",
    )
    .unwrap();
    let mut appender = conn.appender("tmp_micro").unwrap();
    for row in rows {
        appender
            .append_row(duckdb::params![date as i32, row.symbol, row.whale_net_won, row.program_net_won, 1_000i32, 0i64, 0i32, row.vi_count, 0i32])
            .unwrap();
    }
    appender.flush().unwrap();
    drop(appender);
    let escaped = path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("COPY tmp_micro TO '{escaped}' (FORMAT PARQUET);")).unwrap();
}

struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn of(server: &Server) -> Api {
        Api { client: reqwest::Client::new(), base: format!("http://{}", server.addr().await) }
    }

    async fn status(&self) -> Value {
        self.client.get(format!("{}/api/screener/status", self.base)).send().await.unwrap().json().await.unwrap()
    }

    async fn start_update(&self) {
        let resp = self
            .client
            .post(format!("{}/api/screener/update", self.base))
            .json(&json!({"full": false}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    async fn wait_until_idle(&self) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.status().await;
            if status["update"].is_null() && status["lastDay"].is_string() {
                return;
            }
            assert!(tokio::time::Instant::now() < deadline, "업데이트가 끝나지 않았습니다: {status}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn run(&self, conditions: Vec<Value>) -> Value {
        let screen = json!({"id": "S-micro", "name": "미시 조건식", "markets": [], "exclude": [], "conditions": conditions});
        let resp = self
            .client
            .post(format!("{}/api/screener/run", self.base))
            .json(&screen)
            .send()
            .await
            .unwrap();
        let status = resp.status();
        let body: Value = resp.json().await.unwrap();
        assert_eq!(status, 200, "실행 실패: {body}");
        body
    }
}

#[tokio::test]
async fn screener_ingests_daily_micro_and_evaluates_program_whale_vi_and_new_high_together() {
    let days = open_days(day(2026, 10, 26), day(2026, 11, 6));
    let today = *days.last().unwrap();
    let alpha_bars: Vec<KrxBar> = days.iter().enumerate().map(|(i, &d)| bar(d, 10_000 + i as u64 * 100, 10_000)).collect();
    let beta_bars: Vec<KrxBar> = days.iter().enumerate().map(|(i, &d)| bar(d, 20_000 - i as u64 * 100, 10_000)).collect();
    let gamma_bars: Vec<KrxBar> = days.iter().enumerate().map(|(i, &d)| bar(d, 15_000 + i as u64 * 100, 10_000)).collect();

    let fake = ScriptedTransport::new();
    fake.set_krx_market(KrxMarket {
        days,
        stocks: vec![stock("100010", alpha_bars), stock("100020", beta_bars), stock("100030", gamma_bars)],
    });

    let dir = tempfile::tempdir().unwrap();
    let hoga = dir.path().join("hoga");
    let shared = hoga.join("shared");
    fs::create_dir_all(&hoga).unwrap();

    let clock_start = at(today, "2030");
    let server = Server::spawn_with(
        &fake,
        &dir.path().join("run/server.lock"),
        dir.path(),
        &[
            ("VALLY_CLOCK_START", OsStr::new(&clock_start)),
            ("VALLY_HOGA_DATA_DIR", hoga.as_os_str()),
        ],
    );
    let api = Api::of(&server).await;
    api.start_update().await;
    api.wait_until_idle().await;

    let empty_fallback = api
        .run(vec![json!({"kind": "program_net_buy", "days": 5, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(empty_fallback["rows"].as_array().unwrap().len(), 0);

    write_micro_parquet(
        &shared,
        20_261_104,
        &[
            MicroRow { symbol: "100010", whale_net_won: 300_000_000, program_net_won: 400_000_000, vi_count: 1 },
            MicroRow { symbol: "100020", whale_net_won: 900_000_000, program_net_won: 800_000_000, vi_count: 2 },
            MicroRow { symbol: "100030", whale_net_won: -200_000_000, program_net_won: 100_000_000, vi_count: 0 },
        ],
    );
    write_micro_parquet(
        &shared,
        20_261_105,
        &[
            MicroRow { symbol: "100010", whale_net_won: 500_000_000, program_net_won: 600_000_000, vi_count: 1 },
            MicroRow { symbol: "100020", whale_net_won: 200_000_000, program_net_won: 500_000_000, vi_count: 0 },
            MicroRow { symbol: "100030", whale_net_won: 100_000_000, program_net_won: -50_000_000, vi_count: 1 },
        ],
    );
    write_micro_parquet(
        &shared,
        20_261_106,
        &[
            MicroRow { symbol: "100010", whale_net_won: 400_000_000, program_net_won: 700_000_000, vi_count: 1 },
            MicroRow { symbol: "100020", whale_net_won: 100_000_000, program_net_won: 300_000_000, vi_count: 0 },
            MicroRow { symbol: "100030", whale_net_won: 50_000_000, program_net_won: 50_000_000, vi_count: 0 },
        ],
    );

    let two_day_prog = api
        .run(vec![json!({"kind": "program_net_buy", "days": 2, "minMillionWon": 1_000.0, "maxMillionWon": null})])
        .await;
    let rows = two_day_prog["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["symbol"], json!("100010"));
    assert_eq!(rows[0]["programNetMillionWon"], json!(1_300));
    assert!(rows[0].get("whaleNetMillionWon").is_none());
    assert!(rows[0].get("viCount").is_none());

    let three_day_prog = api
        .run(vec![json!({"kind": "program_net_buy", "days": 5, "minMillionWon": 1_500.0, "maxMillionWon": null})])
        .await;
    let symbols: Vec<&str> = three_day_prog["rows"].as_array().unwrap().iter().map(|r| r["symbol"].as_str().unwrap()).collect();
    assert_eq!(symbols, vec!["100010", "100020"]);

    let combined = api
        .run(vec![
            json!({"kind": "new_high", "period": "D", "recentBars": 1, "field": "high", "n": 5}),
            json!({"kind": "program_net_buy", "days": 3, "minMillionWon": 1_500.0, "maxMillionWon": null}),
            json!({"kind": "whale_net_buy", "days": 3, "minMillionWon": 1_000.0, "maxMillionWon": null}),
            json!({"kind": "vi_triggered", "days": 3, "minCount": 3}),
        ])
        .await;
    let combined_rows = combined["rows"].as_array().unwrap();
    assert_eq!(combined_rows.len(), 1);
    assert_eq!(combined_rows[0]["symbol"], json!("100010"));
    assert_eq!(combined_rows[0]["programNetMillionWon"], json!(1_700));
    assert_eq!(combined_rows[0]["whaleNetMillionWon"], json!(1_200));
    assert_eq!(combined_rows[0]["viCount"], json!(3));

    let plain_high = api
        .run(vec![json!({"kind": "new_high", "period": "D", "recentBars": 1, "field": "high", "n": 5})])
        .await;
    for row in plain_high["rows"].as_array().unwrap() {
        assert!(row.get("programNetMillionWon").is_none());
        assert!(row.get("whaleNetMillionWon").is_none());
        assert!(row.get("viCount").is_none());
    }

    write_micro_parquet(
        &shared,
        20_261_106,
        &[
            MicroRow { symbol: "100010", whale_net_won: 400_000_000, program_net_won: 700_000_000, vi_count: 1 },
            MicroRow { symbol: "100020", whale_net_won: 100_000_000, program_net_won: 300_000_000, vi_count: 0 },
            MicroRow { symbol: "100030", whale_net_won: 2_000_000_000, program_net_won: 2_500_000_000, vi_count: 4 },
        ],
    );
    let refreshed = api
        .run(vec![
            json!({"kind": "whale_net_buy", "days": 1, "minMillionWon": 1_500.0, "maxMillionWon": null}),
            json!({"kind": "vi_triggered", "days": 1, "minCount": 4}),
        ])
        .await;
    let refreshed_rows = refreshed["rows"].as_array().unwrap();
    assert_eq!(refreshed_rows.len(), 1);
    assert_eq!(refreshed_rows[0]["symbol"], json!("100030"));
    assert_eq!(refreshed_rows[0]["whaleNetMillionWon"], json!(2_000));
    assert_eq!(refreshed_rows[0]["viCount"], json!(4));

    server.stop().await;
}

async fn spawn_ready_micro_server() -> (tempfile::TempDir, std::path::PathBuf, Server, Api) {
    let days = open_days(day(2026, 10, 26), day(2026, 11, 6));
    let today = *days.last().unwrap();
    let alpha_bars: Vec<KrxBar> = days.iter().enumerate().map(|(i, &d)| bar(d, 10_000 + i as u64 * 100, 10_000)).collect();
    let beta_bars: Vec<KrxBar> = days.iter().enumerate().map(|(i, &d)| bar(d, 20_000 + i as u64 * 100, 10_000)).collect();

    let fake = ScriptedTransport::new();
    fake.set_krx_market(KrxMarket {
        days,
        stocks: vec![stock("100010", alpha_bars), stock("100020", beta_bars)],
    });

    let dir = tempfile::tempdir().unwrap();
    let hoga = dir.path().join("hoga");
    let shared = hoga.join("shared");
    fs::create_dir_all(&hoga).unwrap();

    let clock_start = at(today, "2030");
    let server = Server::spawn_with(
        &fake,
        &dir.path().join("run/server.lock"),
        dir.path(),
        &[
            ("VALLY_CLOCK_START", OsStr::new(&clock_start)),
            ("VALLY_HOGA_DATA_DIR", hoga.as_os_str()),
        ],
    );
    let api = Api::of(&server).await;
    api.start_update().await;
    api.wait_until_idle().await;
    (dir, shared, server, api)
}

#[tokio::test]
async fn micro_windows_anchor_to_market_trading_days_and_ignore_stale_or_gapped_rows() {
    let (_dir, shared, server, api) = spawn_ready_micro_server().await;

    write_micro_parquet(
        &shared,
        20_261_102,
        &[MicroRow { symbol: "100010", whale_net_won: 900_000_000, program_net_won: 900_000_000, vi_count: 5 }],
    );

    let stale_one_day = api
        .run(vec![json!({"kind": "program_net_buy", "days": 1, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(stale_one_day["rows"].as_array().unwrap().len(), 0);

    let stale_three_day = api
        .run(vec![json!({"kind": "program_net_buy", "days": 3, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(stale_three_day["rows"].as_array().unwrap().len(), 0);

    let stale_five_day = api
        .run(vec![json!({"kind": "program_net_buy", "days": 5, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(stale_five_day["rows"].as_array().unwrap().len(), 1);
    assert_eq!(stale_five_day["rows"][0]["symbol"], json!("100010"));

    write_micro_parquet(
        &shared,
        20_261_104,
        &[
            MicroRow { symbol: "100010", whale_net_won: 900_000_000, program_net_won: 900_000_000, vi_count: 3 },
            MicroRow { symbol: "100020", whale_net_won: 100_000_000, program_net_won: 100_000_000, vi_count: 1 },
        ],
    );
    write_micro_parquet(
        &shared,
        20_261_105,
        &[MicroRow { symbol: "100020", whale_net_won: 400_000_000, program_net_won: 400_000_000, vi_count: 1 }],
    );
    write_micro_parquet(
        &shared,
        20_261_106,
        &[
            MicroRow { symbol: "100010", whale_net_won: 200_000_000, program_net_won: 200_000_000, vi_count: 1 },
            MicroRow { symbol: "100020", whale_net_won: 300_000_000, program_net_won: 300_000_000, vi_count: 1 },
        ],
    );

    let gapped_two_day = api
        .run(vec![json!({"kind": "program_net_buy", "days": 2, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    let rows = gapped_two_day["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["symbol"], json!("100010"));
    assert_eq!(rows[0]["programNetMillionWon"], json!(200));
    assert_eq!(rows[1]["symbol"], json!("100020"));
    assert_eq!(rows[1]["programNetMillionWon"], json!(700));

    let gapped_threshold = api
        .run(vec![json!({"kind": "program_net_buy", "days": 2, "minMillionWon": 500.0, "maxMillionWon": null})])
        .await;
    let high_rows = gapped_threshold["rows"].as_array().unwrap();
    assert_eq!(high_rows.len(), 1);
    assert_eq!(high_rows[0]["symbol"], json!("100020"));

    server.stop().await;
}

#[tokio::test]
async fn deleting_daily_micro_files_or_directory_removes_stale_rows() {
    let (_dir, shared, server, api) = spawn_ready_micro_server().await;

    write_micro_parquet(
        &shared,
        20_261_105,
        &[MicroRow { symbol: "100010", whale_net_won: 300_000_000, program_net_won: 400_000_000, vi_count: 1 }],
    );
    write_micro_parquet(
        &shared,
        20_261_106,
        &[MicroRow { symbol: "100010", whale_net_won: 500_000_000, program_net_won: 600_000_000, vi_count: 2 }],
    );

    let initial = api
        .run(vec![json!({"kind": "program_net_buy", "days": 2, "minMillionWon": 900.0, "maxMillionWon": null})])
        .await;
    assert_eq!(initial["rows"].as_array().unwrap().len(), 1);

    fs::remove_file(daily_micro_path(&shared, 20_261_106)).unwrap();
    let after_one_delete = api
        .run(vec![json!({"kind": "program_net_buy", "days": 1, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(after_one_delete["rows"].as_array().unwrap().len(), 0);

    let after_one_delete_two_day = api
        .run(vec![json!({"kind": "program_net_buy", "days": 2, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(after_one_delete_two_day["rows"].as_array().unwrap().len(), 1);
    assert_eq!(after_one_delete_two_day["rows"][0]["programNetMillionWon"], json!(400));

    fs::remove_file(daily_micro_path(&shared, 20_261_105)).unwrap();
    let after_empty_dir = api
        .run(vec![json!({"kind": "program_net_buy", "days": 5, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(after_empty_dir["rows"].as_array().unwrap().len(), 0);

    write_micro_parquet(
        &shared,
        20_261_106,
        &[MicroRow { symbol: "100020", whale_net_won: 500_000_000, program_net_won: 700_000_000, vi_count: 1 }],
    );
    let repopulated = api
        .run(vec![json!({"kind": "program_net_buy", "days": 1, "minMillionWon": 500.0, "maxMillionWon": null})])
        .await;
    assert_eq!(repopulated["rows"].as_array().unwrap().len(), 1);
    assert_eq!(repopulated["rows"][0]["symbol"], json!("100020"));

    fs::remove_dir_all(daily_micro_dir(&shared)).unwrap();
    let after_dir_removed = api
        .run(vec![json!({"kind": "program_net_buy", "days": 5, "minMillionWon": 100.0, "maxMillionWon": null})])
        .await;
    assert_eq!(after_dir_removed["rows"].as_array().unwrap().len(), 0);

    server.stop().await;
}

#[tokio::test]
async fn corrupt_daily_micro_parquet_is_skipped_without_failing_healthy_dates() {
    let (_dir, shared, server, api) = spawn_ready_micro_server().await;

    write_micro_parquet(
        &shared,
        20_261_104,
        &[MicroRow { symbol: "100010", whale_net_won: 200_000_000, program_net_won: 300_000_000, vi_count: 1 }],
    );
    write_micro_parquet(
        &shared,
        20_261_105,
        &[MicroRow { symbol: "100010", whale_net_won: 300_000_000, program_net_won: 500_000_000, vi_count: 2 }],
    );
    let corrupt_path = daily_micro_path(&shared, 20_261_106);
    fs::write(&corrupt_path, b"not a valid parquet file").unwrap();

    let with_corrupt = api
        .run(vec![json!({"kind": "program_net_buy", "days": 3, "minMillionWon": 700.0, "maxMillionWon": null})])
        .await;
    let rows = with_corrupt["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["symbol"], json!("100010"));
    assert_eq!(rows[0]["programNetMillionWon"], json!(800));

    write_micro_parquet(
        &shared,
        20_261_106,
        &[MicroRow { symbol: "100020", whale_net_won: 900_000_000, program_net_won: 1_100_000_000, vi_count: 3 }],
    );
    let after_repair = api
        .run(vec![json!({"kind": "program_net_buy", "days": 1, "minMillionWon": 1_000.0, "maxMillionWon": null})])
        .await;
    let repaired_rows = after_repair["rows"].as_array().unwrap();
    assert_eq!(repaired_rows.len(), 1);
    assert_eq!(repaired_rows[0]["symbol"], json!("100020"));
    assert_eq!(repaired_rows[0]["programNetMillionWon"], json!(1_100));

    server.stop().await;
}
