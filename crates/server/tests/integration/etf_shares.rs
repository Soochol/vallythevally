use crate::common;

use std::collections::HashMap;
use std::ffi::OsStr;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use common::{ScriptedTransport, Server};
use serde_json::{Value, json};

const SECRET_KEY: &str = "krx-synthetic-test-auth-key-9988";
const SEMI_ETF: &str = "091160";
const ACTIVE_ETF: &str = "445290";
const EXTRA_KRX_ETF: &str = "069500";

enum KrxReply {
    Rows(Vec<Value>),
    Status(u16),
}

#[derive(Default)]
struct KrxFake {
    calls: Mutex<Vec<(String, Option<String>)>>,
    replies: Mutex<HashMap<String, KrxReply>>,
}

impl KrxFake {
    fn set_rows(&self, bas_dd: &str, rows: Vec<Value>) {
        self.replies.lock().unwrap().insert(bas_dd.into(), KrxReply::Rows(rows));
    }

    fn set_status(&self, bas_dd: &str, status: u16) {
        self.replies.lock().unwrap().insert(bas_dd.into(), KrxReply::Status(status));
    }

    fn called_days(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(d, _)| d.clone()).collect()
    }

    fn all_auth_keys(&self) -> Vec<Option<String>> {
        self.calls.lock().unwrap().iter().map(|(_, k)| k.clone()).collect()
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

async fn krx_handler(State(fake): State<Arc<KrxFake>>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Response {
    let bas_dd = query.get("basDd").cloned().unwrap_or_default();
    let auth = headers.get("AUTH_KEY").and_then(|v| v.to_str().ok()).map(str::to_owned);
    fake.calls.lock().unwrap().push((bas_dd.clone(), auth));
    let replies = fake.replies.lock().unwrap();
    match replies.get(&bas_dd) {
        Some(KrxReply::Rows(rows)) => {
            let body = serde_json::to_string(&json!({ "OutBlock_1": rows })).unwrap();
            ([("content-type", "application/json; charset=utf-8")], body).into_response()
        }
        Some(KrxReply::Status(code)) => StatusCode::from_u16(*code).unwrap().into_response(),
        None => ([("content-type", "application/json; charset=utf-8")], r#"{"OutBlock_1":[]}"#).into_response(),
    }
}

fn krx_row(bas_dd: &str, code: &str, name: &str, shares: u64, nav: u64, close_price: u64) -> Value {
    let aum = shares * nav;
    let mktcap = shares * close_price;
    json!({
        "BAS_DD": bas_dd,
        "ISU_CD": code,
        "ISU_NM": name,
        "TDD_CLSPRC": close_price.to_string(),
        "NAV": format!("{nav}.00"),
        "ACC_TRDVAL": "5000000000",
        "MKTCAP": mktcap.to_string(),
        "INVSTASST_NETASST_TOTAMT": aum.to_string(),
        "LIST_SHRS": shares.to_string()
    })
}

struct SharesRig {
    krx: Arc<KrxFake>,
    krx_base: String,
    kiwoom: ScriptedTransport,
    tmp: tempfile::TempDir,
    server: Option<Server>,
    client: reqwest::Client,
    base: String,
}

impl SharesRig {
    async fn new() -> SharesRig {
        let krx = Arc::new(KrxFake::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let krx_base = format!("http://{}", listener.local_addr().unwrap());
        let router = axum::Router::new()
            .route("/svc/apis/etp/etf_bydd_trd", get(krx_handler))
            .with_state(krx.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let kiwoom = ScriptedTransport::new();
        for market_sample in ["ka10051", "ka90005"] {
            kiwoom.respond_with(market_sample, 500, json!({"return_code": 1, "return_msg": "이 시험은 장중 표본을 쓰지 않는다"}));
        }
        SharesRig { krx, krx_base, kiwoom, tmp: tempfile::tempdir().unwrap(), server: None, client: reqwest::Client::new(), base: String::new() }
    }

    async fn start(&mut self, clock_start: &str, api_key: Option<&str>, backfill_days: &str) {
        let mut extra: Vec<(&str, &OsStr)> = vec![
            ("VALLY_CLOCK_START", OsStr::new(clock_start)),
            ("VALLY_KRX_BASE_URL", OsStr::new(&self.krx_base)),
            ("VALLY_ETF_SHARES_BACKFILL_DAYS", OsStr::new(backfill_days)),
        ];
        if let Some(key) = api_key {
            extra.push(("VALLY_KRX_API_KEY", OsStr::new(key)));
        }
        let server = Server::spawn_with(&self.kiwoom, &self.tmp.path().join("run/server.lock"), self.tmp.path(), &extra);
        self.base = format!("http://{}", server.addr().await);
        self.server = Some(server);
    }

    async fn stop(&mut self) {
        self.server.take().unwrap().stop().await;
    }

    fn day_file(&self, yyyymmdd: &str) -> PathBuf {
        self.tmp.path().join("run/etf-shares/days").join(format!("{yyyymmdd}.json"))
    }

    fn state_file(&self) -> PathBuf {
        self.tmp.path().join("run/etf-shares/state.json")
    }

    async fn get(&self, path: &str) -> Value {
        let response = self.client.get(format!("{}{path}", self.base)).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200, "{path}");
        serde_json::from_str(&response.text().await.unwrap()).unwrap()
    }

    async fn until<F: Future<Output = bool>>(&self, what: &str, mut condition: impl FnMut() -> F) {
        for _ in 0..300 {
            if condition().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("{what}: 시간 안에 이뤄지지 않았습니다. 서버 로그: {}", self.server.as_ref().map(Server::logs).unwrap_or_default());
    }
}

#[tokio::test]
async fn without_krx_api_key_flow_endpoints_degrade_gracefully_and_keep_catalog_working() {
    let mut rig = SharesRig::new().await;
    rig.start("20261120200000", None, "3").await;

    let flows = rig.get("/api/etf/flows?window=5&direction=all").await;
    assert_eq!(flows["status"]["state"], "not_configured");
    assert_eq!(flows["status"]["configured"], false);
    assert_eq!(flows["rows"].as_array().unwrap().len(), 0);
    assert_eq!(rig.krx.call_count(), 0);

    let series = rig.get(&format!("/api/etf/funds/{SEMI_ETF}/shares")).await;
    assert_eq!(series["status"]["state"], "not_configured");
    assert_eq!(series["inCatalog"], true);
    assert!(series["points"].as_array().unwrap().is_empty());

    let funds = rig.get("/api/etf/funds").await;
    assert!(!funds["funds"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn reverse_backfill_computes_flows_adjusts_splits_persists_across_restart_and_never_logs_key() {
    let mut rig = SharesRig::new().await;
    rig.krx.set_rows("20261117", vec![
        krx_row("20261117", SEMI_ETF, "KODEX 반도체", 10_000_000, 40_000, 40_020),
        krx_row("20261117", ACTIVE_ETF, "KODEX 로봇액티브", 5_000_000, 20_000, 20_010),
        krx_row("20261117", EXTRA_KRX_ETF, "KODEX 200", 100_000_000, 35_000, 35_000),
    ]);
    rig.krx.set_rows("20261118", vec![]);
    rig.krx.set_rows("20261119", vec![
        krx_row("20261119", SEMI_ETF, "KODEX 반도체", 11_000_000, 41_000, 41_040),
        krx_row("20261119", ACTIVE_ETF, "KODEX 로봇액티브", 10_000_000, 10_100, 10_100),
        krx_row("20261119", EXTRA_KRX_ETF, "KODEX 200", 98_000_000, 35_500, 35_490),
    ]);
    rig.krx.set_rows("20261120", vec![
        krx_row("20261120", SEMI_ETF, "KODEX 반도체", 11_500_000, 42_000, 42_050),
        krx_row("20261120", ACTIVE_ETF, "KODEX 로봇액티브", 10_200_000, 10_200, 10_210),
        krx_row("20261120", EXTRA_KRX_ETF, "KODEX 200", 97_000_000, 36_000, 35_980),
    ]);

    rig.start("20261120193000", Some(SECRET_KEY), "3").await;
    rig.until("3영업일 백필 완료", || async {
        let flows = rig.get("/api/etf/flows?window=5&direction=all").await;
        flows["status"]["state"] == "ready" && flows["status"]["collectedDays"] == 3
    })
    .await;

    assert_eq!(rig.krx.called_days(), vec!["20261120", "20261119", "20261118", "20261117"]);
    assert!(rig.krx.all_auth_keys().iter().all(|k| k.as_deref() == Some(SECRET_KEY)));
    assert!(rig.day_file("20261120").exists());
    assert!(rig.day_file("20261119").exists());
    assert!(rig.day_file("20261117").exists());
    assert!(!rig.day_file("20261118").exists());
    assert!(rig.state_file().exists());
    assert!(!rig.server.as_ref().unwrap().logs().contains(SECRET_KEY));

    let inflows = rig.get("/api/etf/flows?window=5&direction=inflow&scope=all").await;
    assert_eq!(inflows["summary"]["inflowEtfCount"], 2);
    assert_eq!(inflows["summary"]["outflowEtfCount"], 1);
    assert_eq!(inflows["summary"]["topInflowCode"], SEMI_ETF);
    assert_eq!(inflows["summary"]["topOutflowCode"], EXTRA_KRX_ETF);
    let semi_row = inflows["rows"].as_array().unwrap().iter().find(|r| r["code"] == SEMI_ETF).unwrap();
    assert_eq!(semi_row["netFlowWon"], 1_000_000i64 * 41_000i64 + 500_000i64 * 42_000i64);
    assert_eq!(semi_row["streakDays"], 2);

    let active_series = rig.get(&format!("/api/etf/funds/{ACTIVE_ETF}/shares?days=20")).await;
    let points = active_series["points"].as_array().unwrap();
    assert_eq!(points.len(), 3);
    assert_eq!(points[1]["date"], "2026-11-19");
    assert_eq!(points[1]["splitAdjusted"], true);
    assert_eq!(points[1]["netFlowWon"], 0);
    assert_eq!(points[2]["splitAdjusted"], false);
    assert_eq!(points[2]["netFlowWon"], 200_000i64 * 10_200i64);

    let extra_series = rig.get(&format!("/api/etf/funds/{EXTRA_KRX_ETF}/shares")).await;
    assert_eq!(extra_series["inCatalog"], false);
    assert_eq!(extra_series["name"], "KODEX 200");
    assert_eq!(extra_series["latest"]["streakDays"], -2);

    let funds = rig.get("/api/etf/funds").await;
    let listed_semi = funds["funds"].as_array().unwrap().iter().find(|f| f["code"] == SEMI_ETF).unwrap();
    assert_eq!(listed_semi["latestAumWon"], 11_500_000u64 * 42_000u64);
    assert_eq!(listed_semi["netFlow5dWon"], 1_000_000i64 * 41_000i64 + 500_000i64 * 42_000i64);

    let calls_before_restart = rig.krx.call_count();
    rig.stop().await;
    rig.start("20261120200000", Some(SECRET_KEY), "3").await;
    rig.until("재시작 후 저장본 복원", || async {
        let flows = rig.get("/api/etf/flows?window=5&direction=all").await;
        flows["status"]["state"] == "ready" && flows["status"]["collectedDays"] == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(rig.krx.call_count(), calls_before_restart);
}

#[tokio::test]
async fn auth_failure_stops_backfill_immediately_and_preserves_saved_days() {
    let mut rig = SharesRig::new().await;
    rig.krx.set_rows("20261120", vec![krx_row("20261120", SEMI_ETF, "KODEX 반도체", 10_000_000, 40_000, 40_000)]);
    rig.krx.set_status("20261119", 401);
    rig.krx.set_rows("20261118", vec![krx_row("20261118", SEMI_ETF, "KODEX 반도체", 9_900_000, 39_000, 39_000)]);

    rig.start("20261120193000", Some(SECRET_KEY), "3").await;
    rig.until("인증 실패 상태 반영", || async {
        let flows = rig.get("/api/etf/flows?window=5&direction=all").await;
        flows["status"]["state"] == "auth_failed"
    })
    .await;

    assert_eq!(rig.krx.called_days(), vec!["20261120", "20261119"]);
    let flows = rig.get("/api/etf/flows?window=5&direction=all").await;
    assert_eq!(flows["status"]["collectedDays"], 1);
    assert_eq!(flows["status"]["latestDate"], "2026-11-20");
    assert!(!rig.server.as_ref().unwrap().logs().contains(SECRET_KEY));
}
