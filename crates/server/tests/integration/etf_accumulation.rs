use crate::common;

use std::ffi::OsStr;
use std::path::PathBuf;

use common::{ScriptedTransport, Server};
use domain::{KstDate, Ohlcv, Price, StockCode, Volume};
use serde_json::{Value, json};
use server::kiwoom::wire::MillionWon;
use server::screener::store::{DayBar, Store, Write};

const ACTIVE_A: &str = "444200";
const ACTIVE_B: &str = "445290";
const ACTIVE_C: &str = "494890";
const PASSIVE_A: &str = "091160";

struct Rig {
    tmp: tempfile::TempDir,
    server: Option<Server>,
    client: reqwest::Client,
    base: String,
}

impl Rig {
    async fn start() -> Rig {
        let kiwoom = ScriptedTransport::new();
        for market_sample in ["ka10051", "ka90005"] {
            kiwoom.respond_with(market_sample, 500, json!({"return_code": 1, "return_msg": "이 시험은 장중 표본을 쓰지 않는다"}));
        }
        let tmp = tempfile::tempdir().unwrap();
        let server = Server::spawn_with(&kiwoom, &tmp.path().join("run/server.lock"), tmp.path(), &[("VALLY_CLOCK_START", OsStr::new("20261119110000")), ("VALLY_NAVER_BASE_URL", OsStr::new("http://127.0.0.1:9"))]);
        let base = format!("http://{}", server.addr().await);
        Rig { tmp, server: Some(server), client: reqwest::Client::new(), base }
    }

    fn store(&self, fund: &str, day: &str, holdings: &[(&str, f64, u32)]) {
        let dir: PathBuf = self.tmp.path().join("run/etf-pdf/pdf").join(day.replace('-', ""));
        std::fs::create_dir_all(&dir).unwrap();
        let rows: Vec<Value> = holdings.iter().map(|(code, quantity, weight_bps)| json!({"code": code, "name": format!("종목{code}"), "cuQuantity": quantity, "weightBps": weight_bps})).collect();
        std::fs::write(dir.join(format!("{fund}.json")), json!({"schemaVersion": 1, "code": fund, "asOf": day, "holdings": rows}).to_string()).unwrap();
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self.client.get(format!("{}{path}", self.base)).send().await.unwrap();
        (response.status().as_u16(), serde_json::from_str(&response.text().await.unwrap()).unwrap())
    }

    async fn ok(&self, path: &str) -> Value {
        let (status, body) = self.get(path).await;
        assert_eq!(status, 200, "{path}: {body}");
        body
    }

    async fn stop(mut self) {
        self.server.take().unwrap().stop().await;
    }
}

#[tokio::test]
async fn empty_and_single_day_collections_return_empty_rows_gracefully() {
    let rig = Rig::start().await;
    let empty = rig.ok("/api/etf/accumulation").await;
    assert_eq!(empty, json!({"window": 5, "style": "active", "direction": "buy", "fromDate": null, "toDate": null, "collectedDays": 0, "maAsOf": null, "rows": []}));

    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    let single = rig.ok("/api/etf/accumulation").await;
    assert_eq!(single, json!({"window": 5, "style": "active", "direction": "buy", "fromDate": null, "toDate": null, "collectedDays": 1, "maAsOf": null, "rows": []}));
    let single_sell = rig.ok("/api/etf/accumulation?direction=sell").await;
    assert_eq!(single_sell, json!({"window": 5, "style": "active", "direction": "sell", "fromDate": null, "toDate": null, "collectedDays": 1, "maAsOf": null, "rows": []}));
    rig.stop().await;
}

#[tokio::test]
async fn cu_doubling_produces_zero_false_accumulation() {
    let rig = Rig::start().await;
    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 2500), ("000660", 200.0, 2500), ("035420", 300.0, 2500), ("005380", 400.0, 2500)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 200.0, 2500), ("000660", 400.0, 2500), ("035420", 600.0, 2500), ("005380", 800.0, 2500)]);

    let res = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    assert_eq!((res["fromDate"].as_str(), res["toDate"].as_str(), res["collectedDays"].as_u64()), (Some("2026-11-17"), Some("2026-11-18"), Some(2)));
    assert_eq!(res["rows"], json!([]));
    rig.stop().await;
}

#[tokio::test]
async fn style_filter_separates_active_only_from_all_funds() {
    let rig = Rig::start().await;
    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 3000), ("000660", 100.0, 3000), ("035420", 100.0, 4000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 3000), ("000660", 140.0, 4000), ("035420", 100.0, 3000)]);
    rig.store(PASSIVE_A, "2026-11-17", &[("005930", 100.0, 3000), ("000660", 100.0, 3000), ("035420", 100.0, 4000)]);
    rig.store(PASSIVE_A, "2026-11-18", &[("005930", 100.0, 2500), ("000660", 150.0, 3500), ("035420", 100.0, 2500), ("005380", 80.0, 1500)]);

    let active = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    let active_rows = active["rows"].as_array().unwrap();
    assert_eq!(active_rows.len(), 1);
    assert_eq!(active_rows[0]["code"], "000660");
    assert_eq!(active_rows[0]["buyingEtfCount"], 1);
    assert_eq!(active_rows[0]["contributors"].as_array().unwrap().len(), 1);
    assert_eq!(active_rows[0]["contributors"][0]["fundCode"], ACTIVE_A);

    let all = rig.ok("/api/etf/accumulation?window=5&style=all").await;
    let all_rows = all["rows"].as_array().unwrap();
    assert_eq!(all_rows.len(), 2);
    assert_eq!(all_rows[0]["code"], "000660");
    assert_eq!(all_rows[0]["buyingEtfCount"], 2);
    assert_eq!(all_rows[1]["code"], "005380");
    assert_eq!(all_rows[1]["addedEtfCount"], 1);
    assert_eq!(all_rows[1]["contributors"][0]["fundCode"], PASSIVE_A);
    assert_eq!(all_rows[1]["contributors"][0]["style"], "passive");
    assert_eq!(all_rows[1]["contributors"][0]["afterWeightBps"], 1500);
    rig.stop().await;
}

#[tokio::test]
async fn window_5_vs_20_picks_distinct_ranges_and_contributor_sort_matches_spec() {
    let rig = Rig::start().await;
    let days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"];
    for (idx, day) in days.iter().enumerate() {
        let hynix_a = if idx == 0 { 100.0 } else { 150.0 };
        let naver_b = if idx < 4 { 100.0 } else { 140.0 };
        rig.store(ACTIVE_A, day, &[("005930", 100.0, 3000), ("000660", hynix_a, 3500), ("035420", 100.0, 3500)]);
        if idx < 9 {
            rig.store(ACTIVE_B, day, &[("005930", 100.0, 3000), ("035420", naver_b, 3500), ("005380", 100.0, 3500)]);
        } else {
            rig.store(ACTIVE_B, day, &[("005930", 100.0, 2500), ("035420", naver_b, 3000), ("005380", 100.0, 2500), ("000660", 60.0, 2000)]);
        }
        rig.store(ACTIVE_C, day, &[("005930", 100.0, 3000), ("000660", if idx == 9 { 125.0 } else { 100.0 }, 3500), ("035420", 100.0, 3500)]);
    }

    let w5 = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    assert_eq!((w5["fromDate"].as_str(), w5["toDate"].as_str(), w5["collectedDays"].as_u64()), (Some("2026-11-05"), Some("2026-11-10"), Some(10)));
    let w5_rows = w5["rows"].as_array().unwrap();
    assert_eq!(w5_rows.len(), 1);
    assert_eq!(w5_rows[0]["code"], "000660");
    assert_eq!((w5_rows[0]["buyingEtfCount"].as_u64(), w5_rows[0]["addedEtfCount"].as_u64(), w5_rows[0]["increasedEtfCount"].as_u64()), (Some(2), Some(1), Some(1)));
    let w5_contribs: Vec<&str> = w5_rows[0]["contributors"].as_array().unwrap().iter().map(|c| c["fundCode"].as_str().unwrap()).collect();
    assert_eq!(w5_contribs, [ACTIVE_B, ACTIVE_C]);

    let w20 = rig.ok("/api/etf/accumulation?window=20&style=active").await;
    assert_eq!((w20["fromDate"].as_str(), w20["toDate"].as_str(), w20["collectedDays"].as_u64()), (Some("2026-11-01"), Some("2026-11-10"), Some(10)));
    let w20_rows = w20["rows"].as_array().unwrap();
    assert_eq!(w20_rows[0]["code"], "000660");
    assert_eq!(w20_rows[0]["buyingEtfCount"], 3);
    let w20_contribs: Vec<(&str, &str)> = w20_rows[0]["contributors"].as_array().unwrap().iter().map(|c| (c["fundCode"].as_str().unwrap(), c["kind"].as_str().unwrap())).collect();
    assert_eq!(w20_contribs, [(ACTIVE_B, "added"), (ACTIVE_A, "increased"), (ACTIVE_C, "increased")]);
    assert!((w20_rows[0]["medianRealChange"].as_f64().unwrap() - 0.375).abs() < 1e-9);
    assert_eq!(w20_rows[1]["code"], "035420");
    assert_eq!(w20_rows[1]["buyingEtfCount"], 1);
    rig.stop().await;
}

#[tokio::test]
async fn cache_invalidates_when_new_snapshot_is_written() {
    let rig = Rig::start().await;
    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    assert_eq!(rig.ok("/api/etf/accumulation?window=5&style=active").await["rows"], json!([]));

    rig.store(ACTIVE_B, "2026-11-17", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);
    rig.store(ACTIVE_B, "2026-11-18", &[("005930", 100.0, 4000), ("035420", 100.0, 4000), ("000660", 50.0, 2000)]);
    let refreshed = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    assert_eq!(refreshed["rows"].as_array().unwrap().len(), 1);
    assert_eq!(refreshed["rows"][0]["code"], "000660");
    rig.stop().await;
}

#[tokio::test]
async fn invalid_query_parameters_return_bad_request() {
    let rig = Rig::start().await;
    for path in [
        "/api/etf/accumulation?window=10",
        "/api/etf/accumulation?window=abc",
        "/api/etf/accumulation?window=",
        "/api/etf/accumulation?style=passive",
        "/api/etf/accumulation?style=ACTIVE",
        "/api/etf/accumulation?window=5&style=other",
        "/api/etf/accumulation?direction=both",
        "/api/etf/accumulation?direction=SELL",
        "/api/etf/accumulation?direction=",
    ] {
        let (status, body) = rig.get(path).await;
        assert_eq!((status, body["error"]["code"].as_str()), (400, Some("bad_request")), "{path}: {body}");
    }
    rig.stop().await;
}

#[tokio::test]
async fn sell_direction_ignores_cu_doubling_and_ranks_removed_and_decreased() {
    let rig = Rig::start().await;
    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 2500), ("000660", 200.0, 2500), ("035420", 300.0, 2500), ("005380", 400.0, 2500)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 200.0, 2500), ("000660", 400.0, 2500), ("035420", 600.0, 2500), ("005380", 800.0, 2500)]);

    let doubling = rig.ok("/api/etf/accumulation?window=5&style=active&direction=sell").await;
    assert_eq!(doubling["direction"], "sell");
    assert_eq!(doubling["rows"], json!([]));

    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 2500), ("000660", 100.0, 2500), ("035420", 100.0, 2500), ("005380", 100.0, 2500)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 4000), ("000660", 60.0, 2000), ("035420", 100.0, 4000)]);
    rig.store(ACTIVE_B, "2026-11-17", &[("005930", 100.0, 2500), ("000660", 100.0, 2500), ("035420", 100.0, 2500), ("005380", 100.0, 2500)]);
    rig.store(ACTIVE_B, "2026-11-18", &[("005930", 100.0, 3500), ("000660", 80.0, 2500), ("035420", 100.0, 4000)]);
    rig.store(ACTIVE_C, "2026-11-17", &[("005930", 100.0, 3500), ("000660", 100.0, 3000), ("035420", 100.0, 3500)]);
    rig.store(ACTIVE_C, "2026-11-18", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);

    let sell = rig.ok("/api/etf/accumulation?window=5&style=active&direction=sell").await;
    assert_eq!(sell["direction"], "sell");
    let rows = sell["rows"].as_array().unwrap();
    let codes: Vec<&str> = rows.iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["000660", "005380"]);

    let hynix = &rows[0];
    assert_eq!((hynix["buyingEtfCount"].as_u64(), hynix["addedEtfCount"].as_u64(), hynix["increasedEtfCount"].as_u64()), (Some(0), Some(0), Some(0)));
    assert_eq!((hynix["sellingEtfCount"].as_u64(), hynix["removedEtfCount"].as_u64(), hynix["decreasedEtfCount"].as_u64()), (Some(3), Some(1), Some(2)));
    assert!((hynix["medianRealChange"].as_f64().unwrap() - (-0.3)).abs() < 1e-9);
    let contribs: Vec<(&str, &str, Option<u64>, Option<u64>)> = hynix["contributors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["fundCode"].as_str().unwrap(), c["kind"].as_str().unwrap(), c["beforeWeightBps"].as_u64(), c["afterWeightBps"].as_u64()))
        .collect();
    assert_eq!(contribs, [
        (ACTIVE_C, "removed", Some(3000), None),
        (ACTIVE_A, "decreased", Some(2500), Some(2000)),
        (ACTIVE_B, "decreased", Some(2500), Some(2500)),
    ]);

    let hyundai = &rows[1];
    assert_eq!((hyundai["sellingEtfCount"].as_u64(), hyundai["removedEtfCount"].as_u64(), hyundai["decreasedEtfCount"].as_u64()), (Some(2), Some(2), Some(0)));
    assert!(hyundai["medianRealChange"].is_null());
    rig.stop().await;
}

#[tokio::test]
async fn recent_activity_populates_after_two_days_and_invalidates_on_new_pdf() {
    let rig = Rig::start().await;
    let find_fund = |body: &Value, code: &str| body["funds"].as_array().unwrap().iter().find(|f| f["code"] == code).unwrap().clone();

    let empty = rig.ok("/api/etf/funds").await;
    assert!(find_fund(&empty, ACTIVE_A)["recentActivity"].is_null());

    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 2500), ("000660", 100.0, 2500), ("035420", 100.0, 2500), ("005380", 100.0, 2500)]);
    let one_day = rig.ok("/api/etf/funds").await;
    assert!(find_fund(&one_day, ACTIVE_A)["recentActivity"].is_null());

    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 2500), ("000660", 130.0, 3000), ("035420", 70.0, 2000), ("051910", 50.0, 2500)]);
    let two_days = rig.ok("/api/etf/funds").await;
    assert_eq!(find_fund(&two_days, ACTIVE_A)["recentActivity"], json!({"added": 1, "removed": 1, "increased": 1, "decreased": 1}));
    assert!(find_fund(&two_days, ACTIVE_B)["recentActivity"].is_null());

    let detail = rig.ok(&format!("/api/etf/funds/{ACTIVE_A}")).await;
    assert_eq!(detail["fund"]["recentActivity"], json!({"added": 1, "removed": 1, "increased": 1, "decreased": 1}));

    rig.store(ACTIVE_A, "2026-11-19", &[("005930", 100.0, 2500), ("000660", 130.0, 3000), ("035420", 70.0, 2000), ("051910", 50.0, 2500)]);
    let three_days = rig.ok("/api/etf/funds").await;
    assert_eq!(find_fund(&three_days, ACTIVE_A)["recentActivity"], json!({"added": 0, "removed": 0, "increased": 0, "decreased": 0}));
    rig.stop().await;
}

#[tokio::test]
async fn intermediate_day_overwrite_invalidates_accumulation_and_activity_caches() {
    let rig = Rig::start().await;
    let find_fund = |body: &Value, code: &str| body["funds"].as_array().unwrap().iter().find(|f| f["code"] == code).unwrap().clone();

    rig.store(ACTIVE_B, "2026-11-17", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 3500), ("005380", 100.0, 3500), ("000660", 100.0, 3000)]);
    rig.store(ACTIVE_A, "2026-11-19", &[("005930", 100.0, 3500), ("005380", 100.0, 3500), ("000660", 100.0, 3000)]);
    rig.store(ACTIVE_B, "2026-11-19", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);

    assert_eq!(rig.ok("/api/etf/accumulation?window=5&style=active").await["rows"], json!([]));
    assert_eq!(
        find_fund(&rig.ok("/api/etf/funds").await, ACTIVE_A)["recentActivity"],
        json!({"added": 0, "removed": 0, "increased": 0, "decreased": 0})
    );

    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 3000), ("005380", 100.0, 3000), ("000660", 50.0, 2000), ("035420", 100.0, 2000)]);
    let refreshed_acc = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    let rows = refreshed_acc["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["code"], "000660");

    let refreshed_funds = rig.ok("/api/etf/funds").await;
    assert_eq!(
        find_fund(&refreshed_funds, ACTIVE_A)["recentActivity"],
        json!({"added": 0, "removed": 1, "increased": 1, "decreased": 0})
    );
    rig.stop().await;
}

#[tokio::test]
async fn sell_radar_populates_ma_for_exited_stock_not_in_catalog() {
    let exited_code = StockCode::parse("999991").unwrap();
    assert!(server::etf::Catalog::embedded().stock_name(exited_code).is_none());

    let kiwoom = ScriptedTransport::new();
    for market_sample in ["ka10051", "ka90005"] {
        kiwoom.respond_with(market_sample, 500, json!({"return_code": 1, "return_msg": "이 시험은 장중 표본을 쓰지 않는다"}));
    }
    let tmp = tempfile::tempdir().unwrap();
    let run_dir = tmp.path().join("run");
    std::fs::create_dir_all(&run_dir).unwrap();
    {
        let store = Store::open(&run_dir.join("screener.duckdb")).unwrap();
        let latest = KstDate::new(2026, 11, 18).unwrap();
        let closes: Vec<u64> = (1..=130).rev().collect();
        let count = closes.len() as i64;
        let bars: Vec<DayBar> = closes
            .iter()
            .enumerate()
            .map(|(i, close)| {
                let price = Price::from_centi(close * 100).unwrap();
                let ohlcv = Ohlcv::try_new(price, price, price, price, Volume(1)).unwrap();
                DayBar {
                    day: KstDate::from_days_since_epoch(latest.days_since_epoch() - (count - 1 - i as i64)),
                    ohlcv,
                    traded: MillionWon(1),
                }
            })
            .collect();
        store.write(&[Write::Replace { code: exited_code, bars }]).unwrap();
    }
    let server = Server::spawn_with(
        &kiwoom,
        &run_dir.join("server.lock"),
        tmp.path(),
        &[("VALLY_CLOCK_START", OsStr::new("20261119110000")), ("VALLY_NAVER_BASE_URL", OsStr::new("http://127.0.0.1:9"))],
    );
    let base = format!("http://{}", server.addr().await);
    let rig = Rig { tmp, server: Some(server), client: reqwest::Client::new(), base };

    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 5000), ("999991", 100.0, 5000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 10_000)]);

    let _prime_catalog_only = rig.ok(&format!("/api/etf/funds/{ACTIVE_A}")).await;
    let sell = rig.ok("/api/etf/accumulation?window=5&style=active&direction=sell").await;
    assert_eq!(sell["maAsOf"], "2026-11-18");
    let rows = sell["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["code"], "999991");
    assert_eq!(rows[0]["ma"], json!({"ma20": "below", "ma60": "below", "ma120": "below"}));
    rig.stop().await;
}

#[tokio::test]
async fn empty_raw_only_and_corrupt_day_dirs_do_not_inflate_days_or_displace_window() {
    let rig = Rig::start().await;
    let valid_days = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"];
    for (idx, day) in valid_days.iter().enumerate() {
        let hynix = if idx == 0 { 100.0 } else { 140.0 };
        rig.store(ACTIVE_A, day, &[("005930", 100.0, 5000), ("000660", hynix, 5000)]);
    }
    let pdf_root = rig.tmp.path().join("run/etf-pdf/pdf");
    std::fs::create_dir_all(pdf_root.join("20261118")).unwrap();
    std::fs::create_dir_all(pdf_root.join("20261119")).unwrap();
    std::fs::write(pdf_root.join("20261119").join(format!("{ACTIVE_A}.raw.json")), b"[]").unwrap();
    std::fs::create_dir_all(pdf_root.join("20261120")).unwrap();
    std::fs::write(pdf_root.join("20261120").join(format!("{ACTIVE_A}.json")), b"corrupt-json").unwrap();
    std::fs::create_dir_all(pdf_root.join("20261121")).unwrap();
    std::fs::write(
        pdf_root.join("20261121").join(format!("{ACTIVE_A}.json")),
        json!({"schemaVersion": 1, "code": ACTIVE_A, "asOf": "2026-11-20", "holdings": [{"code": "005930", "name": "삼성전자", "cuQuantity": 100.0, "weightBps": 10000}]}).to_string(),
    )
    .unwrap();
    rig.store(ACTIVE_A, "2026-11-22", &[]);

    let res = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    assert_eq!((res["fromDate"].as_str(), res["toDate"].as_str(), res["collectedDays"].as_u64()), (Some("2026-11-12"), Some("2026-11-17"), Some(6)));
    let rows = res["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["code"], "000660");

    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 5000), ("000660", 140.0, 5000)]);
    let after_valid = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    assert_eq!((after_valid["fromDate"].as_str(), after_valid["toDate"].as_str(), after_valid["collectedDays"].as_u64()), (Some("2026-11-13"), Some("2026-11-18"), Some(7)));
    assert_eq!(after_valid["rows"], json!([]));
    rig.stop().await;
}

#[tokio::test]
async fn same_length_atomic_overwrite_of_interior_day_invalidates_cache() {
    let rig = Rig::start().await;
    rig.store(ACTIVE_B, "2026-11-17", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 3500), ("005380", 100.0, 3500), ("000660", 100.0, 3000)]);
    rig.store(ACTIVE_A, "2026-11-19", &[("005930", 100.0, 3500), ("005380", 100.0, 3500), ("000660", 100.0, 3000)]);
    rig.store(ACTIVE_B, "2026-11-19", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);
    assert_eq!(rig.ok("/api/etf/accumulation?window=5&style=active").await["rows"], json!([]));

    let target = rig.tmp.path().join("run/etf-pdf/pdf/20261118").join(format!("{ACTIVE_A}.json"));
    let original_len = std::fs::metadata(&target).unwrap().len();
    let updated = json!({
        "schemaVersion": 1,
        "code": ACTIVE_A,
        "asOf": "2026-11-18",
        "holdings": [
            {"code": "005930", "name": "종목005930", "cuQuantity": 100.0, "weightBps": 3500},
            {"code": "005380", "name": "종목005380", "cuQuantity": 100.0, "weightBps": 3500},
            {"code": "000660", "name": "종목000660", "cuQuantity": 50.00, "weightBps": 3000},
        ]
    })
    .to_string();
    let padded = if (updated.len() as u64) < original_len {
        format!("{updated}{}", " ".repeat((original_len as usize) - updated.len()))
    } else {
        updated
    };
    assert_eq!(padded.len() as u64, original_len);
    let tmp_file = target.with_extension("tmp");
    std::fs::write(&tmp_file, padded).unwrap();
    std::fs::rename(&tmp_file, &target).unwrap();

    let refreshed = rig.ok("/api/etf/accumulation?window=5&style=active").await;
    let rows = refreshed["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["code"], "000660");
    rig.stop().await;
}

#[tokio::test]
async fn newly_accumulated_non_catalog_stock_populates_ma_without_screener_generation_bump() {
    let added_code = StockCode::parse("999992").unwrap();
    let catalog_code = StockCode::parse("005930").unwrap();
    assert!(server::etf::Catalog::embedded().stock_name(added_code).is_none());

    let kiwoom = ScriptedTransport::new();
    for market_sample in ["ka10051", "ka90005"] {
        kiwoom.respond_with(market_sample, 500, json!({"return_code": 1, "return_msg": "이 시험은 장중 표본을 쓰지 않는다"}));
    }
    let tmp = tempfile::tempdir().unwrap();
    let run_dir = tmp.path().join("run");
    std::fs::create_dir_all(&run_dir).unwrap();
    {
        let store = Store::open(&run_dir.join("screener.duckdb")).unwrap();
        let latest = KstDate::new(2026, 11, 18).unwrap();
        let make_bars = |closes: Vec<u64>| {
            let count = closes.len() as i64;
            closes
                .iter()
                .enumerate()
                .map(|(i, close)| {
                    let price = Price::from_centi(close * 100).unwrap();
                    let ohlcv = Ohlcv::try_new(price, price, price, price, Volume(1)).unwrap();
                    DayBar {
                        day: KstDate::from_days_since_epoch(latest.days_since_epoch() - (count - 1 - i as i64)),
                        ohlcv,
                        traded: MillionWon(1),
                    }
                })
                .collect::<Vec<_>>()
        };
        store
            .write(&[
                Write::Replace { code: catalog_code, bars: make_bars((1..=130).collect()) },
                Write::Replace { code: added_code, bars: make_bars((1..=130).collect()) },
            ])
            .unwrap();
    }
    let server = Server::spawn_with(
        &kiwoom,
        &run_dir.join("server.lock"),
        tmp.path(),
        &[("VALLY_CLOCK_START", OsStr::new("20261119110000")), ("VALLY_NAVER_BASE_URL", OsStr::new("http://127.0.0.1:9"))],
    );
    let base = format!("http://{}", server.addr().await);
    let rig = Rig { tmp, server: Some(server), client: reqwest::Client::new(), base };

    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);

    let _prime_ma = rig.ok(&format!("/api/etf/funds/{ACTIVE_A}")).await;
    assert_eq!(rig.ok("/api/etf/accumulation?window=5&style=active&direction=buy").await["rows"], json!([]));

    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 140.0, 4000), ("000660", 100.0, 3000), ("999992", 50.0, 3000)]);
    let buy = rig.ok("/api/etf/accumulation?window=5&style=active&direction=buy").await;
    assert_eq!(buy["maAsOf"], "2026-11-18");
    let rows = buy["rows"].as_array().unwrap();
    let find_row = |code: &str| rows.iter().find(|r| r["code"] == code).unwrap();
    assert_eq!(find_row("999992")["ma"], json!({"ma20": "above", "ma60": "above", "ma120": "above"}));
    assert_eq!(find_row("005930")["ma"], json!({"ma20": "above", "ma60": "above", "ma120": "above"}));

    let stock_detail = rig.ok("/api/etf/stocks/999992").await;
    assert_eq!(stock_detail["ma"], json!({"ma20": "above", "ma60": "above", "ma120": "above"}));
    rig.stop().await;
}

#[tokio::test]
async fn stale_multi_month_and_lagging_etfs_are_excluded_from_simultaneous_accumulation() {
    let rig_gap = Rig::start().await;
    rig_gap.store(ACTIVE_A, "2026-08-01", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    rig_gap.store(ACTIVE_A, "2026-08-02", &[("005930", 100.0, 4000), ("000660", 150.0, 6000)]);
    rig_gap.store(ACTIVE_B, "2026-11-18", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    rig_gap.store(ACTIVE_B, "2026-11-19", &[("005930", 100.0, 4000), ("000660", 150.0, 6000)]);

    let res_gap = rig_gap.ok("/api/etf/accumulation?window=5&style=active").await;
    assert_eq!((res_gap["fromDate"].as_str(), res_gap["toDate"].as_str()), (Some("2026-11-18"), Some("2026-11-19")));
    let gap_rows = res_gap["rows"].as_array().unwrap();
    assert_eq!(gap_rows.len(), 1);
    assert_eq!(gap_rows[0]["code"], "000660");
    assert_eq!(gap_rows[0]["buyingEtfCount"], 1);
    assert_eq!(gap_rows[0]["contributors"].as_array().unwrap().len(), 1);
    assert_eq!(gap_rows[0]["contributors"][0]["fundCode"], ACTIVE_B);
    rig_gap.stop().await;

    let rig_window = Rig::start().await;
    for day_num in 1..=21 {
        let day = format!("2026-11-{day_num:02}");
        rig_window.store(ACTIVE_C, &day, &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);
    }
    rig_window.store(ACTIVE_A, "2026-11-01", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    rig_window.store(ACTIVE_A, "2026-11-02", &[("005930", 100.0, 4000), ("000660", 150.0, 6000)]);
    rig_window.store(ACTIVE_B, "2026-11-20", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    rig_window.store(ACTIVE_B, "2026-11-21", &[("005930", 100.0, 4000), ("000660", 150.0, 6000)]);

    let res_window = rig_window.ok("/api/etf/accumulation?window=20&style=active").await;
    assert_eq!((res_window["fromDate"].as_str(), res_window["toDate"].as_str()), (Some("2026-11-01"), Some("2026-11-21")));
    let window_rows = res_window["rows"].as_array().unwrap();
    assert_eq!(window_rows.len(), 1);
    assert_eq!(window_rows[0]["code"], "000660");
    assert_eq!(window_rows[0]["buyingEtfCount"], 1);
    assert_eq!(window_rows[0]["contributors"].as_array().unwrap().len(), 1);
    assert_eq!(window_rows[0]["contributors"][0]["fundCode"], ACTIVE_B);
    rig_window.stop().await;
}

#[tokio::test]
async fn empty_holdings_snapshot_is_rejected_without_false_added_or_removed_rows() {
    let rig = Rig::start().await;
    rig.store(ACTIVE_B, "2026-11-17", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);
    rig.store(ACTIVE_B, "2026-11-18", &[("005930", 100.0, 5000), ("035420", 100.0, 5000)]);
    rig.store(ACTIVE_A, "2026-11-17", &[]);
    rig.store(ACTIVE_A, "2026-11-18", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);

    let buy = rig.ok("/api/etf/accumulation?window=5&style=active&direction=buy").await;
    assert_eq!(buy["rows"], json!([]));

    rig.store(ACTIVE_A, "2026-11-17", &[("005930", 100.0, 5000), ("000660", 100.0, 5000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[]);
    let sell = rig.ok("/api/etf/accumulation?window=5&style=active&direction=sell").await;
    assert_eq!(sell["rows"], json!([]));
    rig.stop().await;
}

#[tokio::test]
async fn extreme_scale_underflow_never_emits_increased_with_null_real_change() {
    let rig = Rig::start().await;
    rig.store(ACTIVE_A, "2026-11-17", &[("000001", 1e200, 3000), ("000002", 1e200, 3000), ("005930", 100.0, 4000)]);
    rig.store(ACTIVE_A, "2026-11-18", &[("000001", 1e-200, 3000), ("000002", 1e-200, 3000), ("005930", 100.0, 4000)]);

    let buy = rig.ok("/api/etf/accumulation?window=5&style=active&direction=buy").await;
    assert_eq!(buy["rows"], json!([]));

    let changes = rig.ok(&format!("/api/etf/funds/{ACTIVE_A}/changes?before=2026-11-17&after=2026-11-18")).await;
    let rows = changes["rows"].as_array().unwrap();
    let samsung = rows.iter().find(|r| r["code"] == "005930").unwrap();
    assert_eq!(samsung["kind"], "unchanged");
    assert!(rows.iter().all(|r| r["kind"] != "increased" || r["realChange"].is_f64()));
    rig.stop().await;
}
