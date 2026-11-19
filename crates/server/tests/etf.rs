use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::etf::Catalog;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;
use tracing_subscriber::fmt::MakeWriter;

mod support;
use support::ScriptedTransport;

const EMBEDDED: &str = include_str!("../data/etf/funds.json");

struct Harness {
    app: Router,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(listed: &[(&str, &str)]) -> Harness {
        let clock = Clock::fake(KstTime::from_kst_civil(KstDate::new(2026, 11, 19).unwrap(), TimeOfDay::MIDNIGHT));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(ScriptedTransport::new().transport(), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let info = |(code, name): &(&str, &str)| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: (*name).into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true };
        symbols.replace(Directory::build(listed.iter().map(info).collect()));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest, clock, symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        Harness { app: router(state), _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    async fn ok(&self, path: &str) -> Value {
        let (status, body) = self.get(path).await;
        assert_eq!(status, 200, "{body}");
        body
    }
}

fn embedded_fund(code: &str) -> Value {
    let raw: Value = serde_json::from_str(EMBEDDED).unwrap();
    raw["funds"].as_array().unwrap().iter().find(|f| f["code"] == code).unwrap().clone()
}

fn weights(fund: &Value) -> Vec<f64> {
    fund["holdings"].as_array().unwrap().iter().map(|h| h["weightBps"].as_f64().unwrap()).collect()
}

#[tokio::test]
async fn the_list_has_every_embedded_fund_with_its_summary() {
    let h = Harness::start(&[]).await;
    let list = h.ok("/api/etf/funds").await;
    assert_eq!(list["funds"].as_array().unwrap().len(), 119);

    let kodex = list["funds"].as_array().unwrap().iter().find(|f| f["code"] == "091160").unwrap();
    let raw = embedded_fund("091160");
    let mut w = weights(&raw);
    w.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let total: f64 = w.iter().sum();
    let expected_effective = 1.0 / w.iter().map(|x| (x / total).powi(2)).sum::<f64>();
    assert_eq!(kodex["name"], "KODEX 반도체");
    assert_eq!(kodex["issuer"], "삼성자산운용");
    assert_eq!(kodex["style"], "passive");
    assert_eq!(kodex["benchmark"], "KRX 반도체");
    assert_eq!(kodex["holdingsCount"], 21);
    assert_eq!(kodex["top5WeightBps"], 1900 + 1817 + 1024 + 683 + 430);
    assert!((kodex["effectiveHoldings"].as_f64().unwrap() - expected_effective).abs() < 1e-9, "{kodex}");
    assert_eq!(list["funds"].as_array().unwrap().iter().filter(|f| f["style"] == "active").count(), 81);
}

#[tokio::test]
async fn a_fund_detail_lists_holdings_by_weight_with_empty_ma_and_snapshot_status() {
    let h = Harness::start(&[("005930", "서버삼성전자")]).await;
    let detail = h.ok("/api/etf/funds/091160").await;
    let holdings = detail["holdings"].as_array().unwrap();
    assert_eq!(holdings.len(), 21);
    assert_eq!((holdings[0]["code"].as_str(), holdings[0]["weightBps"].as_u64()), (Some("005930"), Some(1900)));
    assert_eq!(holdings[0]["name"], "서버삼성전자", "서버 종목 목록의 이름이 먼저다");
    assert_eq!(holdings[1]["name"], "SK하이닉스", "목록에 없으면 스냅샷 이름이다");
    assert!(holdings.windows(2).all(|p| p[0]["weightBps"].as_u64() >= p[1]["weightBps"].as_u64()));
    for holding in holdings {
        assert_eq!(holding["ma"], json!({"ma20": null, "ma60": null, "ma120": null}));
    }
    assert_eq!(detail["fund"]["status"], json!({"source": "snapshot", "holdingsAsOf": "2026-10-30", "lastAttemptAt": null, "refreshFailed": false}));
}

#[tokio::test]
async fn the_reverse_index_returns_every_fund_holding_the_stock_with_its_weight() {
    let h = Harness::start(&[]).await;
    let body = h.ok("/api/etf/stocks/005930").await;
    let raw: Value = serde_json::from_str(EMBEDDED).unwrap();
    let mut expected: Vec<(String, u64)> = raw["funds"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["holdings"].as_array().unwrap().iter().find(|x| x["code"] == "005930").map(|x| (f["code"].as_str().unwrap().to_owned(), x["weightBps"].as_u64().unwrap())))
        .collect();
    expected.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let holders: Vec<(String, u64)> = body["holders"].as_array().unwrap().iter().map(|x| (x["fund"]["code"].as_str().unwrap().to_owned(), x["weightBps"].as_u64().unwrap())).collect();
    assert_eq!(holders, expected);
    assert_eq!(holders.len(), 46);
    assert!(holders.contains(&("091160".to_owned(), 1900)));
    assert_eq!(body["name"], "삼성전자");
    assert_eq!(body["ma"], json!({"ma20": null, "ma60": null, "ma120": null}));
}

#[tokio::test]
async fn a_stock_no_fund_holds_has_an_empty_list() {
    let h = Harness::start(&[]).await;
    let body = h.ok("/api/etf/stocks/000001").await;
    assert_eq!(body["holders"], json!([]));
}

#[tokio::test]
async fn unknown_codes_are_not_found_and_malformed_codes_are_bad_requests() {
    let h = Harness::start(&[]).await;
    let (status, body) = h.get("/api/etf/funds/999999").await;
    assert_eq!((status, body["error"]["code"].as_str()), (404, Some("not_found")));
    for path in ["/api/etf/funds/12345", "/api/etf/funds/09116a", "/api/etf/funds/1234567", "/api/etf/stocks/ABC", "/api/etf/stocks/00593"] {
        let (status, body) = h.get(path).await;
        assert_eq!((status, body["error"]["code"].as_str()), (400, Some("bad_request")), "{path}");
    }
}

fn fund(code: &str, holdings: &[(&str, u32)]) -> Value {
    json!({"code": code, "name": format!("합성 {code}"), "issuer": "합성운용", "style": "active", "benchmark": "합성지수", "holdings": holdings.iter().map(|(c, w)| json!({"code": c, "weightBps": w})).collect::<Vec<_>>()})
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

impl<'a> MakeWriter<'a> for Captured {
    type Writer = Captured;
    fn make_writer(&'a self) -> Captured { self.clone() }
}

fn captured_logs() -> Captured {
    static LOGS: std::sync::OnceLock<Captured> = std::sync::OnceLock::new();
    LOGS.get_or_init(|| {
        let logs = Captured::default();
        tracing::subscriber::set_global_default(tracing_subscriber::fmt().with_writer(logs.clone()).with_ansi(false).finish()).unwrap();
        logs
    })
    .clone()
}

#[test]
fn funds_that_fail_validation_are_not_loaded_and_the_reason_is_logged() {
    let snapshot = json!({
        "schemaVersion": 1,
        "holdingsAsOf": "2026-10-30",
        "funds": [
            fund("111111", &[("005930", 6000), ("000660", 4000)]),
            fund("222222", &[("005930", 6000), ("000660", 6000)]),
            fund("333333", &[("005930", 3000), ("005930", 2000)]),
            fund("44444", &[("005930", 3000)]),
            fund("555555", &[("5930", 3000)]),
            fund("666666", &[("005930", 3000), ("000999", 1000)]),
            fund("777777", &[]),
            fund("111111", &[("005930", 3000)]),
            {"code": "888888", "name": "합성", "issuer": "합성운용", "style": "etn", "benchmark": "x", "holdings": [{"code": "005930", "weightBps": 3000}]},
            fund("999999", &[("005930", 10_001)]),
        ],
        "stocks": {"005930": "삼성전자", "000660": "SK하이닉스"},
    });
    let logs = captured_logs();
    let loaded = Catalog::load(&snapshot.to_string());

    let kept: Vec<_> = loaded.catalog.funds().iter().map(|f| f.code.as_str().to_owned()).collect();
    assert_eq!(kept, ["111111"]);
    let rejected: Vec<_> = loaded.rejected.iter().map(|r| r.subject.as_str()).collect();
    assert_eq!(rejected, ["222222", "333333", "44444", "555555", "666666", "777777", "111111", "888888", "999999"]);
    let text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    for needle in ["비중 합이 허용 범위", "종목이 중복입니다: 005930", "ETF 코드 형식이 아닙니다: 44444", "종목 코드 형식이 아닙니다: 5930", "종목 이름이 없습니다: 000999", "구성 종목이 없습니다", "ETF 코드가 중복입니다", "운용 방식을 알 수 없습니다: etn", "종목 비중이"] {
        assert!(text.contains(needle), "로그에 `{needle}`가 없다:\n{text}");
    }
    for rejection in &loaded.rejected {
        assert!(text.contains(&rejection.reason), "로그에 `{}`가 없다:\n{text}", rejection.reason);
    }
    assert_eq!(loaded.catalog.holders("005930".parse_stock()).len(), 1);
}

#[test]
fn a_snapshot_with_a_bad_version_or_date_loads_nothing() {
    for (version, as_of) in [(2, "2026-10-30"), (1, "2026-13-01"), (1, "20261030")] {
        let snapshot = json!({"schemaVersion": version, "holdingsAsOf": as_of, "funds": [fund("111111", &[("005930", 6000)])], "stocks": {"005930": "삼성전자"}});
        let loaded = Catalog::load(&snapshot.to_string());
        assert!(loaded.catalog.funds().is_empty(), "{version} {as_of}");
        assert_eq!(loaded.rejected.len(), 1);
    }
    assert!(Catalog::load("{").catalog.funds().is_empty());
}

trait ParseStock {
    fn parse_stock(&self) -> domain::StockCode;
}

impl ParseStock for str {
    fn parse_stock(&self) -> domain::StockCode {
        domain::StockCode::parse(self).unwrap()
    }
}
