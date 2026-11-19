mod common;

use std::ffi::OsStr;
use std::path::PathBuf;

use common::{ScriptedTransport, Server};
use serde_json::{Value, json};

const FUND: &str = "091160";
const OTHER_FUND: &str = "091180";
const UNLISTED: &str = "999999";

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

    fn store(&self, fund: &str, day: &str, holdings: &[(&str, f64)]) {
        let dir: PathBuf = self.tmp.path().join("run/etf-pdf/pdf").join(day.replace('-', ""));
        std::fs::create_dir_all(&dir).unwrap();
        let rows: Vec<Value> = holdings.iter().map(|(code, quantity)| json!({"code": code, "name": format!("종목{code}"), "cuQuantity": quantity, "weightBps": 100})).collect();
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

    async fn history(&self, fund: &str) -> Value {
        self.ok(&format!("/api/etf/funds/{fund}/history")).await
    }

    async fn changes(&self, fund: &str, before: &str, after: &str) -> Value {
        self.ok(&format!("/api/etf/funds/{fund}/changes?before={before}&after={after}")).await
    }

    async fn stop(mut self) {
        self.server.take().unwrap().stop().await;
    }
}

fn kinds(changes: &Value) -> Vec<(String, String)> {
    changes["rows"].as_array().unwrap().iter().map(|row| (row["code"].as_str().unwrap().to_owned(), row["kind"].as_str().unwrap().to_owned())).collect()
}

fn kind_of(changes: &Value, code: &str) -> String {
    kinds(changes).into_iter().find(|(c, _)| c == code).unwrap().1
}

fn stocks(count: u32, quantity: f64) -> Vec<(String, f64)> {
    (1..=count).map(|n| (format!("00000{n}"), quantity)).collect()
}

fn borrowed(rows: &[(String, f64)]) -> Vec<(&str, f64)> {
    rows.iter().map(|(code, quantity)| (code.as_str(), *quantity)).collect()
}

#[tokio::test]
async fn a_shared_scale_is_divided_out_so_only_the_two_odd_stocks_change() {
    let rig = Rig::start().await;
    let before = stocks(10, 1000.0);
    let after: Vec<(String, f64)> = before.iter().map(|(code, quantity)| (code.clone(), match code.as_str() {
        "000001" => quantity * 1.2,
        "000002" => quantity * 0.8,
        _ => quantity * 0.94,
    })).collect();
    rig.store(FUND, "2026-10-30", &borrowed(&before));
    rig.store(FUND, "2026-11-18", &borrowed(&after));

    let changes = rig.changes(FUND, "2026-10-30", "2026-11-18").await;
    assert!((changes["commonScale"].as_f64().unwrap() - 0.94).abs() < 1e-9, "{changes}");
    assert_eq!((changes["before"].as_str(), changes["after"].as_str()), (Some("2026-10-30"), Some("2026-11-18")));
    assert_eq!(kind_of(&changes, "000001"), "increased");
    assert_eq!(kind_of(&changes, "000002"), "decreased");
    let others: Vec<String> = kinds(&changes).into_iter().filter(|(code, _)| code != "000001" && code != "000002").map(|(_, kind)| kind).collect();
    assert_eq!(others, vec!["unchanged"; 8]);
    let first = &changes["rows"][0];
    assert_eq!((first["beforeQuantity"].as_f64(), first["afterQuantity"].as_f64()), (Some(1000.0), Some(1200.0)));
    assert!((first["realChange"].as_f64().unwrap() - (1.2 / 0.94 - 1.0)).abs() < 1e-9);

    let history = rig.history(FUND).await;
    let pair = &history["pairs"][0];
    assert!((pair["commonScale"].as_f64().unwrap() - 0.94).abs() < 1e-9);
    assert_eq!((pair["increased"].as_u64(), pair["decreased"].as_u64(), pair["added"].as_u64(), pair["removed"].as_u64()), (Some(1), Some(1), Some(0), Some(0)));
    rig.stop().await;
}

#[tokio::test]
async fn exactly_one_percent_is_unchanged_and_anything_beyond_it_is_not() {
    let rig = Rig::start().await;
    let mut before = stocks(6, 1000.0);
    let mut after = stocks(6, 1000.0);
    before.extend([("000007".to_owned(), 1000.0), ("000008".to_owned(), 1000.0), ("000009".to_owned(), 1000.0), ("000010".to_owned(), 1000.0)]);
    after.extend([("000007".to_owned(), 1010.0), ("000008".to_owned(), 990.0), ("000009".to_owned(), 1011.0), ("000010".to_owned(), 989.0)]);
    rig.store(FUND, "2026-11-17", &borrowed(&before));
    rig.store(FUND, "2026-11-18", &borrowed(&after));

    let changes = rig.changes(FUND, "2026-11-17", "2026-11-18").await;
    assert_eq!(changes["commonScale"].as_f64(), Some(1.0));
    assert_eq!(kind_of(&changes, "000007"), "unchanged", "+1.00%");
    assert_eq!(kind_of(&changes, "000008"), "unchanged", "-1.00%");
    assert_eq!(kind_of(&changes, "000009"), "increased", "+1.10%");
    assert_eq!(kind_of(&changes, "000010"), "decreased", "-1.10%");
    rig.stop().await;
}

#[tokio::test]
async fn stocks_missing_on_one_side_are_added_or_removed() {
    let rig = Rig::start().await;
    rig.store(FUND, "2026-11-17", &[("000001", 100.0), ("000002", 100.0), ("000003", 100.0)]);
    rig.store(FUND, "2026-11-18", &[("000001", 100.0), ("000002", 100.0), ("000004", 50.0)]);

    let changes = rig.changes(FUND, "2026-11-17", "2026-11-18").await;
    assert_eq!(kinds(&changes), [("000004", "added"), ("000003", "removed"), ("000001", "unchanged"), ("000002", "unchanged")].map(|(c, k)| (c.to_owned(), k.to_owned())));
    let added = &changes["rows"][0];
    assert_eq!((added["beforeQuantity"].clone(), added["afterQuantity"].as_f64(), added["realChange"].clone()), (Value::Null, Some(50.0), Value::Null));
    let removed = &changes["rows"][1];
    assert_eq!((removed["beforeQuantity"].as_f64(), removed["afterQuantity"].clone()), (Some(100.0), Value::Null));
    let pair = &rig.history(FUND).await["pairs"][0];
    assert_eq!((pair["added"].as_u64(), pair["removed"].as_u64()), (Some(1), Some(1)));
    rig.stop().await;
}

#[tokio::test]
async fn a_single_collected_day_gives_no_pairs_and_the_first_day() {
    let rig = Rig::start().await;
    assert_eq!(rig.history(FUND).await, json!({"code": FUND, "firstCollectedOn": null, "pairs": []}));
    rig.store(FUND, "2026-11-18", &[("000001", 100.0)]);
    assert_eq!(rig.history(FUND).await, json!({"code": FUND, "firstCollectedOn": "2026-11-18", "pairs": []}));
    rig.stop().await;
}

#[tokio::test]
async fn pairs_are_neighbouring_days_newest_first_and_other_funds_are_left_out() {
    let rig = Rig::start().await;
    rig.store(FUND, "2026-11-10", &[("000001", 100.0), ("000002", 100.0)]);
    rig.store(FUND, "2026-11-14", &[("000001", 100.0), ("000003", 100.0)]);
    rig.store(FUND, "2026-11-18", &[("000003", 100.0)]);
    rig.store(OTHER_FUND, "2026-11-12", &[("000009", 1.0)]);

    let history = rig.history(FUND).await;
    assert_eq!(history["firstCollectedOn"], "2026-11-10");
    let pairs: Vec<(&str, &str)> = history["pairs"].as_array().unwrap().iter().map(|pair| (pair["before"].as_str().unwrap(), pair["after"].as_str().unwrap())).collect();
    assert_eq!(pairs, [("2026-11-14", "2026-11-18"), ("2026-11-10", "2026-11-14")]);
    assert_eq!(history["pairs"][0]["removed"], 1);
    assert_eq!((history["pairs"][1]["added"].as_u64(), history["pairs"][1]["removed"].as_u64()), (Some(1), Some(1)));
    assert_eq!(rig.history(OTHER_FUND).await["pairs"], json!([]));
    rig.stop().await;
}

#[tokio::test]
async fn a_stored_file_that_disagrees_with_its_place_is_ignored() {
    let rig = Rig::start().await;
    rig.store(FUND, "2026-11-17", &[("000001", 100.0)]);
    rig.store(FUND, "2026-11-18", &[("000001", 100.0)]);
    let misplaced = rig.tmp.path().join("run/etf-pdf/pdf/20261118").join(format!("{FUND}.json"));
    std::fs::write(&misplaced, json!({"schemaVersion": 1, "code": FUND, "asOf": "2026-11-19", "holdings": []}).to_string()).unwrap();
    assert_eq!(rig.history(FUND).await["firstCollectedOn"], "2026-11-17");
    assert_eq!(rig.history(FUND).await["pairs"], json!([]));
    rig.stop().await;
}

#[tokio::test]
async fn bad_requests_and_missing_data_are_reported_as_api_errors() {
    let rig = Rig::start().await;
    rig.store(FUND, "2026-11-17", &[("000001", 100.0)]);
    rig.store(FUND, "2026-11-18", &[("000001", 100.0)]);
    for (path, status, code) in [
        (format!("/api/etf/funds/{UNLISTED}/history"), 404, "not_found"),
        ("/api/etf/funds/abc/history".to_owned(), 400, "bad_request"),
        (format!("/api/etf/funds/{UNLISTED}/changes?before=2026-11-17&after=2026-11-18"), 404, "not_found"),
        (format!("/api/etf/funds/{FUND}/changes?after=2026-11-18"), 400, "bad_request"),
        (format!("/api/etf/funds/{FUND}/changes?before=2026-11-17&after=11-18"), 400, "bad_request"),
        (format!("/api/etf/funds/{FUND}/changes?before=2026-11-18&after=2026-11-17"), 400, "bad_request"),
        (format!("/api/etf/funds/{FUND}/changes?before=2026-11-17&after=2026-11-17"), 400, "bad_request"),
        (format!("/api/etf/funds/{FUND}/changes?before=2026-11-16&after=2026-11-18"), 404, "not_found"),
    ] {
        let (actual, body) = rig.get(&path).await;
        assert_eq!((actual, body["error"]["code"].as_str()), (status, Some(code)), "{path}: {body}");
    }
    rig.stop().await;
}
