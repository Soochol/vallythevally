use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

use collector::calendar::Day;
use collector::finalize::{self, Options, RawFiles, finalize_day_with_shared, seal_day, verify_store, write_daily_micro, write_store};
use collector::keys::KeyRole;
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile, write_plan};
use collector::protocol::KeyName;
use collector::raw_write::{RawLine, RawWriter};
use duckdb::{Config, Connection};
use serde_json::{Map, json};
use server::shared_data::daily_micro_path;
use tempfile::tempdir;

const DATE: u32 = 20_261_124;
const ALPHA: &str = "005930";
const BETA: &str = "000660";
const SILENT: &str = "035420";

#[derive(Debug, PartialEq, Eq)]
struct Row {
    date: i32,
    whale_net_won: i64,
    program_net_won: i64,
    program_share_bps: i32,
    foreign_est_net_qty: i64,
    spoof_cancel_rate_bps: i32,
    vi_count: i32,
    vwap_close_gap_bps: i32,
}

fn at_ms(date: u32, hour: u32, minute: u32, second: i64) -> i64 {
    Day::from_yyyymmdd(date).unwrap().unix_ms_at_kst(hour, minute) + second * 1000
}

fn key(name: &str) -> KeyName {
    KeyName::parse(name).unwrap()
}

fn write_day_plan(data: &Path, date: u32, stocks: &[&str]) {
    let plan = PlanFile {
        format_version: 1,
        date,
        created_at: "2026-11-24T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: 1, universe_replaced: None },
        keys: vec![KeyShare {
            name: key("collect-01"),
            role: KeyRole::Collecting,
            app_key_hash: "hash-collect-01".to_owned(),
            stocks: stocks.iter().map(|code| (*code).to_owned()).collect(),
            market_types: MARKET_TYPES.to_vec(),
            rest_jobs: Vec::new(),
            load: 0,
        }],
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    };
    write_plan(data, &plan).unwrap();
}

fn trade_frame(code: &str, hhmmss: &str, price: &str, qty: &str) -> String {
    json!({
        "trnm": "REAL",
        "data": [{
            "type": "0B",
            "item": format!("{code}_AL"),
            "values": {"20": hhmmss, "10": price, "15": qty}
        }]
    })
    .to_string()
}

fn program_frame(code: &str, hhmmss: &str, sell_m: i64, buy_m: i64, net_m: i64) -> String {
    json!({
        "trnm": "REAL",
        "data": [{
            "type": "0w",
            "item": format!("{code}_AL"),
            "values": {
                "20": hhmmss,
                "204": sell_m.to_string(),
                "208": buy_m.to_string(),
                "212": net_m.to_string()
            }
        }]
    })
    .to_string()
}

fn broker_frame(code: &str, foreign_net_qty: i64) -> String {
    json!({
        "trnm": "REAL",
        "data": [{
            "type": "0F",
            "item": format!("{code}_AL"),
            "values": {"267": foreign_net_qty.to_string()}
        }]
    })
    .to_string()
}

fn vi_frame(item: &str, f9001: &str, kind: &str, direction: &str) -> String {
    json!({
        "trnm": "REAL",
        "data": [{
            "type": "1h",
            "item": item,
            "values": {"9001": f9001, "9068": kind, "9069": direction, "1223": "093000"}
        }]
    })
    .to_string()
}

fn book_frame(code: &str, hhmmss: &str, asks: &[(i64, i64)], bids: &[(i64, i64)]) -> String {
    let mut values = Map::new();
    values.insert("21".to_owned(), json!(hhmmss));
    for (idx, &(price, qty)) in asks.iter().enumerate() {
        values.insert((41 + idx).to_string(), json!(format!("+{price}")));
        values.insert((61 + idx).to_string(), json!(qty.to_string()));
    }
    for (idx, &(price, qty)) in bids.iter().enumerate() {
        values.insert((51 + idx).to_string(), json!(format!("-{price}")));
        values.insert((71 + idx).to_string(), json!(qty.to_string()));
    }
    json!({
        "trnm": "REAL",
        "data": [{
            "type": "0D",
            "item": format!("{code}_AL"),
            "values": values
        }]
    })
    .to_string()
}

fn read_parquet_rows(path: &Path) -> BTreeMap<String, Row> {
    let config = Config::default().enable_autoload_extension(false).unwrap();
    let conn = Connection::open_in_memory_with_flags(config).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT symbol, date, whale_net_won, program_net_won, program_share_bps, foreign_est_net_qty, spoof_cancel_rate_bps, vi_count, vwap_close_gap_bps
             FROM read_parquet(?) ORDER BY symbol",
        )
        .unwrap();
    let rows = stmt
        .query_map([path.to_string_lossy().as_ref()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Row {
                    date: row.get(1)?,
                    whale_net_won: row.get(2)?,
                    program_net_won: row.get(3)?,
                    program_share_bps: row.get(4)?,
                    foreign_est_net_qty: row.get(5)?,
                    spoof_cancel_rate_bps: row.get(6)?,
                    vi_count: row.get(7)?,
                    vwap_close_gap_bps: row.get(8)?,
                },
            ))
        })
        .unwrap();
    rows.map(Result::unwrap).collect()
}

#[test]
fn finalize_emits_exact_daily_micro_parquet_for_every_collected_stock() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("data");
    let shared = dir.path().join("shared");
    fs::create_dir_all(&data).unwrap();
    write_day_plan(&data, DATE, &[ALPHA, BETA, SILENT]);

    let mut writer = RawWriter::for_key(&data, key("collect-01"));
    let base = at_ms(DATE, 9, 0, 0);
    let mut emit = |offset_ms: i64, text: String| writer.write(&RawLine::Frame { recv_ms: base + offset_ms, text: &text }).unwrap();
    emit(0, json!({"trnm": "LOGIN", "return_code": 0}).to_string());

    emit(1_000, trade_frame(ALPHA, "090001", "+100000", "+2000"));
    emit(2_000, trade_frame(ALPHA, "090002", "-100000", "-1500"));
    emit(3_000, trade_frame(ALPHA, "090003", "+110000", "+500"));

    emit(1_500, program_frame(ALPHA, "090001", 10, 20, 10));
    emit(4_000, program_frame(ALPHA, "090004", 50, 150, 100));

    emit(1_500, broker_frame(ALPHA, -300));
    emit(4_500, broker_frame(ALPHA, 12_500));

    emit(500, book_frame(ALPHA, "090000", &[(100_000, 3_000), (101_000, 500)], &[(99_000, 2_000)]));
    emit(1_100, book_frame(ALPHA, "090001", &[(100_000, 1_000), (101_000, 500)], &[(99_000, 2_000)]));
    emit(5_000, book_frame(ALPHA, "090005", &[(100_000, 1_000), (101_000, 500)], &[(99_000, 100)]));

    emit(6_000, vi_frame(ALPHA, ALPHA, "1", "1"));
    emit(6_500, vi_frame(&format!("{ALPHA}_NX"), ALPHA, "2", "2"));
    emit(7_000, vi_frame(ALPHA, ALPHA, "4", "1"));
    emit(7_500, vi_frame(ALPHA, ALPHA, "1", "9"));

    emit(1_000, trade_frame(BETA, "090001", "+50000", "+100"));
    emit(2_000, program_frame(BETA, "090002", 80, 120, -40));

    writer.close().unwrap();

    let options = Options {
        data_dir: data.clone(),
        date: DATE,
        threads: 2,
        buckets: 8,
        verify_only: false,
        spill_budget_bytes: finalize::DEFAULT_SPILL_BUDGET_BYTES,
    };
    let report = finalize_day_with_shared(&options, &shared).unwrap();
    assert!(report.passed);

    let parquet_path = daily_micro_path(&shared, DATE);
    assert!(parquet_path.is_file());
    assert!(!parquet_path.with_extension("parquet.tmp").exists());

    let rows = read_parquet_rows(&parquet_path);
    assert_eq!(rows.len(), 3);

    assert_eq!(
        rows[ALPHA],
        Row {
            date: DATE as i32,
            whale_net_won: 50_000_000,
            program_net_won: 100_000_000,
            program_share_bps: 4_938,
            foreign_est_net_qty: 12_500,
            spoof_cancel_rate_bps: 5_000,
            vi_count: 2,
            vwap_close_gap_bps: 864,
        }
    );

    assert_eq!(
        rows[BETA],
        Row {
            date: DATE as i32,
            whale_net_won: 0,
            program_net_won: -40_000_000,
            program_share_bps: 10_000,
            foreign_est_net_qty: 0,
            spoof_cancel_rate_bps: 0,
            vi_count: 0,
            vwap_close_gap_bps: 0,
        }
    );

    assert_eq!(
        rows[SILENT],
        Row {
            date: DATE as i32,
            whale_net_won: 0,
            program_net_won: 0,
            program_share_bps: 0,
            foreign_est_net_qty: 0,
            spoof_cancel_rate_bps: 0,
            vi_count: 0,
            vwap_close_gap_bps: 0,
        }
    );

    let rerun = write_daily_micro(&data, &shared, DATE, 2).unwrap();
    assert_eq!(rerun.stocks, 3);
    assert_eq!(read_parquet_rows(&parquet_path), rows);
}

#[test]
#[ignore = "finalize 대비 daily_micro 시간 비율을 재는 성능 시험"]
fn daily_micro_overhead_stays_within_eight_percent_of_finalize_baseline() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("data");
    let shared = dir.path().join("shared");
    fs::create_dir_all(&data).unwrap();

    let stock_count = 120usize;
    let ticks_per_stock = 300usize;
    let codes: Vec<String> = (0..stock_count).map(|i| format!("{:06}", 100_000 + i)).collect();
    let code_refs: Vec<&str> = codes.iter().map(String::as_str).collect();
    write_day_plan(&data, DATE, &code_refs);

    let mut writer = RawWriter::for_key(&data, key("collect-01"));
    let base = at_ms(DATE, 9, 0, 0);
    writer.write(&RawLine::Frame { recv_ms: base, text: &json!({"trnm": "LOGIN", "return_code": 0}).to_string() }).unwrap();
    for tick in 0..ticks_per_stock {
        let offset = (tick as i64 + 1) * 1_000;
        let hhmmss = format!("{:02}{:02}{:02}", 9 + (tick / 3600), (tick / 60) % 60, tick % 60);
        for (idx, code) in codes.iter().enumerate() {
            let price = 50_000 + ((tick + idx) % 10) as i64 * 100;
            let qty = if tick % 25 == 0 { 2_500 } else { 50 };
            let signed = if (tick + idx) % 2 == 0 { format!("+{qty}") } else { format!("-{qty}") };
            writer.write(&RawLine::Frame { recv_ms: base + offset, text: &trade_frame(code, &hhmmss, &format!("+{price}"), &signed) }).unwrap();
            if tick % 3 == 0 {
                let ask_qty = if tick % 6 == 0 { 2_500 } else { 300 };
                writer.write(&RawLine::Frame { recv_ms: base + offset + 10, text: &book_frame(code, &hhmmss, &[(price, ask_qty), (price + 100, 400)], &[(price - 100, 500)]) }).unwrap();
            }
            if tick % 30 == 0 {
                writer.write(&RawLine::Frame { recv_ms: base + offset + 20, text: &program_frame(code, &hhmmss, 100, 150, 50) }).unwrap();
                writer.write(&RawLine::Frame { recv_ms: base + offset + 30, text: &broker_frame(code, 5_000) }).unwrap();
            }
        }
    }
    writer.close().unwrap();

    let options = Options {
        data_dir: data.clone(),
        date: DATE,
        threads: 4,
        buckets: 16,
        verify_only: false,
        spill_budget_bytes: finalize::DEFAULT_SPILL_BUDGET_BYTES,
    };

    let raw_files = RawFiles::of_day(&options.data_dir, options.date).unwrap();
    let baseline_start = Instant::now();
    let written = write_store(&options).unwrap();
    let report = verify_store(&written.store_dir, options.date, options.buckets, options.threads, &written.tally).unwrap();
    assert!(seal_day(&options, &report, raw_files).unwrap());
    let baseline = baseline_start.elapsed();

    let mut micro_times = Vec::new();
    for _ in 0..3 {
        let micro_start = Instant::now();
        let micro_report = write_daily_micro(&data, &shared, DATE, options.threads).unwrap();
        micro_times.push(micro_start.elapsed());
        assert_eq!(micro_report.stocks, stock_count);
    }
    micro_times.sort();
    let median_micro = micro_times[1];
    let ratio_pct = (median_micro.as_secs_f64() / baseline.as_secs_f64()) * 100.0;
    eprintln!(
        "daily_micro timing: baseline={baseline:?}, micro_runs={micro_times:?}, median={median_micro:?}, overhead={ratio_pct:.2}%"
    );
    assert!(ratio_pct < 8.0, "daily_micro overhead {ratio_pct:.2}% exceeded 8% budget (baseline={baseline:?}, median={median_micro:?})");
}
