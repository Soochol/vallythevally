mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::symbols::{Directory, SymbolDirectory};
use support::{Call, ScriptedReply, ScriptedTransport};
use tower::ServiceExt;

const MONDAY: u8 = 9;

fn at(day: u8, h: u32, m: u32, s: u32) -> KstTime {
    KstTime::from_kst_civil(KstDate::new(2026, 11, day).unwrap(), TimeOfDay::hms(h, m, s).unwrap())
}

struct Harness {
    fake: ScriptedTransport,
    app: Router,
    clock: Clock,
    rest: KiwoomRest,
    sampler: Option<tokio::task::JoinHandle<()>>,
    _tmp: tempfile::TempDir,
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(sampler) = &self.sampler {
            sampler.abort();
        }
    }
}

impl Harness {
    async fn start(clock_at: KstTime, connected: bool) -> Harness {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(clock_at);
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let listed = |code: &str, name: &str, kind: SymbolKind| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind, market: Market::Kospi, nxt_enabled: true };
        symbols.replace(Directory::build(vec![listed("005930", "삼성전자", SymbolKind::Common), listed("000660", "SK하이닉스", SymbolKind::Common), listed("069500", "KODEX 200", SymbolKind::Etf)]));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(if connected { Access::Open } else { Access::Closed });
        let app = router(state.clone());
        tokio::time::pause();
        Harness { fake, app, clock, rest, sampler: None, _tmp: tmp }
    }

    async fn start_with_samples(clock_at: KstTime, samples: &Path) -> Harness {
        let h = Harness::start_sampled(clock_at, samples).await;
        h.script_market_overview();
        h.settle().await;
        h
    }

    async fn start_sampled(clock_at: KstTime, samples: &Path) -> Harness {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(clock_at);
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::with_send_spacing(fake.transport(), auth, clock.clone(), Duration::from_millis(260));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols: Arc::new(SymbolDirectory::default()), db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        let app = router(state.clone());
        tokio::time::pause();
        let sampler = Some(server::market_overview::start(state, samples.to_owned()));
        Harness { fake, app, clock, rest, sampler, _tmp: tmp }
    }

    fn script_market_overview(&self) {
        self.fake.respond_with("ka10051", 200, sector_flows(&[("001_AL", "종합(KOSPI)", "-8787", "+6473", "+1893"), ("013_AL", "전기전자", "-100", "+50", "+25"), ("101_AL", "종합(KOSDAQ)", "+11", "-22", "+33")]));
        self.fake.respond_with("ka90005", 200, program_minutes(&[("103905", "+345603"), ("103859", "+342625")]));
    }

    async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    async fn minute(&self) {
        self.clock.jump(60);
        self.settle().await;
        self.until_quiet().await;
    }

    async fn until_quiet(&self) {
        let mut last = usize::MAX;
        for _ in 0..600 {
            let now = self.fake.requests();
            if now == last {
                return;
            }
            last = now;
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        panic!("요청이 멈추지 않습니다");
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

    fn calls(&self, api_id: &str) -> Vec<Call> {
        self.fake.calls().into_iter().filter(|c| c.api_id == api_id).collect()
    }

    fn market_calls(&self) -> Vec<Call> {
        self.fake.calls().into_iter().filter(|c| c.api_id != "au10001").collect()
    }
}

fn sector_flows(rows: &[(&str, &str, &str, &str, &str)]) -> Value {
    let rows: Vec<_> = rows.iter().map(|(code, name, individual, foreign, institution)| json!({"inds_cd": code, "inds_nm": name, "cur_prc": "+658091", "flu_rt": "349", "ind_netprps": individual, "frgnr_netprps": foreign, "orgn_netprps": institution})).collect();
    json!({"inds_netprps": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn program_minutes(rows: &[(&str, &str)]) -> Value {
    let rows: Vec<_> = rows.iter().map(|(time, total)| json!({"cntr_tm": time, "dfrt_trde_netprps": "+20885", "ndiffpro_trde_netprps": "+324718", "all_netprps": total})).collect();
    json!({"prm_trde_trnsn": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn program_days(rows: &[(&str, &str)]) -> Value {
    let rows: Vec<_> = rows.iter().map(|(day, total)| json!({"cntr_tm": format!("{day}000000"), "dfrt_trde_netprps": "100", "ndiffpro_trde_netprps": "--250", "all_netprps": total})).collect();
    json!({"prm_trde_trnsn": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn index_days(rows: &[(&str, &str)]) -> Value {
    let rows: Vec<_> = rows.iter().map(|(day, traded)| json!({"dt": day, "cur_prc": "505969", "open_pric": "505969", "high_pric": "505969", "low_pric": "505969", "trde_qty": "1", "trde_prica": traded})).collect();
    json!({"inds_dt_pole_qry": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn all_indices(whole: (&str, &str)) -> Value {
    json!({"all_inds_idex": [
        {"stk_cd": whole.0, "stk_nm": whole.1, "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
        {"stk_cd": "013", "stk_nm": "전기전자", "cur_prc": "+3100.50", "flu_rt": "+1.25", "trde_prica": "4000000"},
        {"stk_cd": "603", "stk_nm": "VKOSPI", "cur_prc": "+17.20", "flu_rt": "+1.50", "trde_prica": "0"}
    ], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn streaks() -> Value {
    let row = |code: &str, name: &str, foreign_days: &str, institution_days: &str| json!({
        "stk_cd": code, "stk_nm": name, "frgnr_cont_netprps_dys": foreign_days, "frgnr_cont_netprps_qty": foreign_days, "frgnr_cont_netprps_amt": "--940483",
        "orgn_cont_netprps_dys": institution_days, "orgn_cont_netprps_qty": "55", "orgn_cont_netprps_amt": "1000", "prid_stkpc_flu_rt": "-1.25"
    });
    json!({"orgn_frgnr_cont_trde_prst": [row("005930_AL", "삼성전자", "-2", "7"), row("069500", "KODEX 200", "-9", "9"), row("000660", "SK하이닉스", "3", "-4")], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn refused() -> Value {
    json!({"return_code": 2, "return_msg": "[1511:필수]"})
}

#[tokio::test]
async fn the_index_card_carries_levels_breadth_volatility_and_the_response_time() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    h.fake.respond_with("ka20003", 200, all_indices(("001", "종합(KOSPI)")));
    let body = h.ok("/api/market-overview/index?market=kospi").await;
    assert_eq!(
        body,
        json!({
            "context": {"market": "kospi", "phase": "regular", "receivedAt": at(MONDAY, 10, 0, 0).unix(), "source": "kiwoom"},
            "index": {"status": "ok", "value": {
                "code": "001", "name": "종합(KOSPI)", "level": 6613.59, "changeRate": -0.67,
                "breadth": {"rising": 410, "flat": 52, "falling": 498, "upperLimit": 3, "lowerLimit": 0},
                "tradeValueEok": 134859.76,
                "volatility": {"level": 17.2, "changeRate": 1.5}
            }}
        })
    );
    assert_eq!(h.calls("ka20003")[0].body, json!({"mrkt_tp": "0", "inds_cd": "001"}));
    assert_eq!(h.calls("ka20003")[0].path, "/api/dostk/sect");
}

#[tokio::test]
async fn the_kosdaq_argument_reaches_every_tr_body() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    h.fake.respond_with("ka20003", 200, all_indices(("101", "종합(KOSDAQ)")));
    h.fake.respond_with("ka10051", 200, sector_flows(&[("101_AL", "종합(KOSDAQ)", "1", "2", "3")]));
    h.fake.respond_with("ka90010", 200, program_days(&[("20261109", "7")]));
    h.fake.respond_with("ka20006", 200, index_days(&[("20261109", "100")]));
    h.fake.respond_with("ka10131", 200, streaks());
    let index = h.ok("/api/market-overview/index?market=kosdaq").await;
    assert_eq!(index["index"]["value"]["code"], "101");
    h.ok("/api/market-overview/sectors?market=kosdaq").await;
    h.ok("/api/market-overview/flow?market=kosdaq&period=5").await;
    h.ok("/api/market-overview/turnover?market=kosdaq&period=5").await;
    h.ok("/api/market-overview/streaks?market=kosdaq").await;
    let body = |api_id: &str| h.calls(api_id).into_iter().next().unwrap_or_else(|| panic!("{api_id}를 부르지 않았습니다")).body;
    assert_eq!(body("ka20003"), json!({"mrkt_tp": "1", "inds_cd": "101"}));
    assert_eq!(body("ka10051"), json!({"mrkt_tp": "1", "amt_qty_tp": "0", "base_dt": "20261109", "stex_tp": "3"}));
    assert_eq!(body("ka90010"), json!({"date": "20261109", "amt_qty_tp": "1", "mrkt_tp": "P10102", "min_tic_tp": "1", "stex_tp": "3"}));
    assert_eq!(body("ka20006"), json!({"inds_cd": "101", "base_dt": "20261109"}));
    let streak_bodies: Vec<_> = h.calls("ka10131").into_iter().map(|c| c.body["netslmt_tp"].as_str().unwrap().to_owned()).collect();
    assert_eq!(streak_bodies.len(), 2);
    assert!(streak_bodies.contains(&"1".to_owned()) && streak_bodies.contains(&"2".to_owned()));
    assert!(h.calls("ka10131").iter().all(|c| c.body["mrkt_tp"] == "101" && c.path == "/api/dostk/frgnistt"));
}

#[tokio::test]
async fn the_sectors_card_joins_returns_and_flows_by_code_and_keeps_the_whole_market_row_apart() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    h.fake.respond_with("ka20003", 200, all_indices(("001", "종합(KOSPI)")));
    h.fake.respond_with("ka10051", 200, sector_flows(&[("001_AL", "종합(KOSPI)", "-8787", "+6473", "+1893"), ("013_AL", "전기전자", "-100", "+50", "+25")]));
    let body = h.ok("/api/market-overview/sectors?market=kospi").await;
    assert_eq!(body["sectors"]["value"], json!([{"code": "013", "name": "전기전자", "level": 3100.5, "changeRate": 1.25, "tradeValueEok": 40000.0}]));
    assert_eq!(
        body["flows"]["value"],
        json!([
            {"code": "001", "name": "종합(KOSPI)", "wholeMarket": true, "individualEok": -8787, "foreignEok": 6473, "institutionEok": 1893},
            {"code": "013", "name": "전기전자", "wholeMarket": false, "individualEok": -100, "foreignEok": 50, "institutionEok": 25}
        ])
    );
}

#[tokio::test]
async fn a_tr_that_fails_makes_only_its_own_part_an_error() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    h.fake.respond_with("ka20003", 200, all_indices(("001", "종합(KOSPI)")));
    h.fake.respond_with("ka10051", 200, refused());
    let body = h.ok("/api/market-overview/sectors?market=kospi").await;
    assert_eq!(body["sectors"]["status"], "ok");
    assert_eq!(body["flows"]["status"], "failed");
    assert!(body["flows"]["error"]["code"].is_string(), "{body}");
    assert!(body["context"]["receivedAt"].is_i64(), "다른 구역의 응답 시각은 남는다: {body}");
    let index = h.ok("/api/market-overview/index?market=kospi").await;
    assert_eq!(index["index"]["status"], "ok", "다른 칸은 그대로다");
}

#[tokio::test]
async fn the_flow_card_reads_each_trading_day_and_past_days_are_asked_once() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    h.fake.respond_with("ka20006", 200, index_days(&[("20261109", "9"), ("20261106", "8"), ("20261105", "7"), ("20261104", "6"), ("20261103", "5"), ("20261102", "4")]));
    let day = |n: i64| ScriptedReply { status: 200, body: sector_flows(&[("001_AL", "종합(KOSPI)", &format!("{}", n * 10), &format!("-{n}"), "5")]), delay: Duration::ZERO };
    h.fake.script("ka10051", (1..=5).map(day).collect());
    h.fake.respond_with("ka90010", 200, program_days(&[("20261109", "900"), ("20261106", "800"), ("20261105", "700"), ("20261104", "600"), ("20261103", "500"), ("20261102", "400")]));
    let body = h.ok("/api/market-overview/flow?market=kospi&period=5").await;
    assert_eq!(body["period"], "5");
    let investors = body["investors"]["value"].as_array().unwrap();
    assert_eq!(investors.iter().map(|d| d["date"].as_str().unwrap()).collect::<Vec<_>>(), ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"]);
    assert_eq!(investors[0], json!({"date": "2026-11-03", "individualEok": 10, "foreignEok": -1, "institutionEok": 5}));
    let asked: Vec<_> = h.calls("ka10051").iter().map(|c| c.body["base_dt"].as_str().unwrap().to_owned()).collect();
    assert_eq!(asked, ["20261103", "20261104", "20261105", "20261106", "20261109"]);
    let program = body["program"]["value"].as_array().unwrap();
    assert_eq!(program.last().unwrap(), &json!({"date": "2026-11-09", "arbitrageEok": 1.0, "nonArbitrageEok": -2.5, "totalEok": 9.0}));
    assert_eq!(program.len(), 5);
    h.fake.script("ka10051", vec![ScriptedReply { status: 200, body: sector_flows(&[("001_AL", "종합(KOSPI)", "999", "999", "999")]), delay: Duration::ZERO }]);
    let again = h.ok("/api/market-overview/flow?market=kospi&period=5").await;
    let asked_again = h.calls("ka10051").len() - asked.len();
    assert_eq!(asked_again, 1, "끝난 날은 캐시에서 읽고 오늘만 다시 묻는다");
    assert_eq!(again["investors"]["value"][0], investors[0]);
    assert_eq!(again["investors"]["value"][4]["individualEok"], 999);
}

#[tokio::test]
async fn the_turnover_card_lists_the_last_days_in_eok() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    h.fake.respond_with("ka20006", 200, index_days(&[("20261109", "30000000"), ("20261106", "20000000"), ("20261105", "10000000")]));
    let body = h.ok("/api/market-overview/turnover?market=kospi&period=60").await;
    assert_eq!(body["days"]["value"], json!([{"date": "2026-11-05", "tradeValueEok": 100000.0}, {"date": "2026-11-06", "tradeValueEok": 200000.0}, {"date": "2026-11-09", "tradeValueEok": 300000.0}]));
    assert_eq!(h.calls("ka20006")[0].body, json!({"inds_cd": "001", "base_dt": "20261109"}));
}

#[tokio::test]
async fn the_streaks_card_splits_by_direction_actor_and_hides_etfs() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    h.fake.respond_with("ka10131", 200, streaks());
    let body = h.ok("/api/market-overview/streaks?market=kospi").await;
    let codes = |side: &str, actor: &str| body[side]["value"][actor].as_array().unwrap().iter().map(|r| r["code"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!((codes("buying", "foreign"), codes("buying", "institution")), (vec!["000660".to_owned()], vec!["005930".to_owned()]));
    assert_eq!((codes("selling", "foreign"), codes("selling", "institution")), (vec!["005930".to_owned()], vec!["000660".to_owned()]));
    assert_eq!(body["selling"]["value"]["foreign"][0], json!({"code": "005930", "name": "삼성전자", "days": -2, "netEok": -9404.83, "netShares": -2, "periodChangeRate": -1.25}));
}

#[tokio::test]
async fn bad_arguments_are_bad_requests_and_cost_no_kiwoom_call() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), true).await;
    for path in ["/api/market-overview/index", "/api/market-overview/index?market=all", "/api/market-overview/flow?market=kospi&period=7", "/api/market-overview/streaks?market=KOSPI"] {
        let (status, body) = h.get(path).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{path}: {body}");
    }
    assert!(h.market_calls().is_empty());
}

#[tokio::test]
async fn every_response_says_the_market_phase() {
    let h = Harness::start(at(MONDAY, 8, 30, 0), true).await;
    h.fake.respond_with("ka20003", 200, all_indices(("001", "종합(KOSPI)")));
    assert_eq!(h.ok("/api/market-overview/index?market=kospi").await["context"]["phase"], "preMarket");
    h.clock.jump(60 * 60);
    assert_eq!(h.ok("/api/market-overview/index?market=kospi").await["context"]["phase"], "regular");
    h.clock.jump(7 * 60 * 60);
    assert_eq!(h.ok("/api/market-overview/index?market=kospi").await["context"]["phase"], "afterMarket");
    h.clock.jump(12 * 60 * 60);
    assert_eq!(h.ok("/api/market-overview/index?market=kospi").await["context"]["phase"], "closed");
}

#[tokio::test]
async fn not_connected_is_an_error_in_every_part_with_no_response_time() {
    let h = Harness::start(at(MONDAY, 10, 0, 0), false).await;
    let body = h.ok("/api/market-overview/index?market=kospi").await;
    assert_eq!((body["index"]["status"].as_str(), body["index"]["error"]["reason"].as_str(), &body["context"]["receivedAt"]), (Some("failed"), Some("not_connected"), &Value::Null));
}

fn minutes_of(body: &Value) -> Vec<i64> {
    body["points"].as_array().unwrap().iter().map(|p| p["at"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn samples_are_taken_every_minute_of_the_regular_session_for_both_markets() {
    let dir = tempfile::tempdir().unwrap();
    let h = Harness::start_with_samples(at(MONDAY, 8, 58, 30), dir.path()).await;
    h.minute().await;
    assert!(h.market_calls().is_empty(), "08:59에는 정규장이 아니다");
    h.minute().await;
    let first = h.market_calls();
    assert_eq!(first.iter().map(|c| c.api_id.as_str()).filter(|id| *id == "ka10051").count(), 2);
    assert_eq!(first.iter().filter(|c| c.api_id == "ka90005").count(), 2);
    let markets = |api_id: &str, key: &str| {
        let mut values: Vec<_> = first.iter().filter(|c| c.api_id == api_id).map(|c| c.body[key].as_str().unwrap().to_owned()).collect();
        values.sort();
        values
    };
    assert_eq!(markets("ka10051", "mrkt_tp"), ["0", "1"]);
    assert_eq!(markets("ka90005", "mrkt_tp"), ["P00101", "P10102"]);
    assert!(first.iter().all(|c| c.body.get("base_dt").is_none_or(|d| d == "20261109") && c.body.get("date").is_none_or(|d| d == "20261109")));
    h.minute().await;
    h.minute().await;
    let body = h.ok("/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!(minutes_of(&body), [at(MONDAY, 9, 0, 0).unix(), at(MONDAY, 9, 1, 0).unix(), at(MONDAY, 9, 2, 0).unix()]);
    assert_eq!(body["points"][0], json!({"at": at(MONDAY, 9, 0, 0).unix(), "individualEok": -8787, "foreignEok": 6473, "institutionEok": 1893, "programEok": 3456.03}));
    assert_eq!(body["day"], "2026-11-09");
    assert!(body["context"]["receivedAt"].is_i64());
    let kosdaq = h.ok("/api/market-overview/flow/intraday?market=kosdaq").await;
    assert_eq!(kosdaq["points"].as_array().unwrap().len(), 3);
    assert_eq!((&kosdaq["points"][0]["individualEok"], &kosdaq["points"][0]["foreignEok"], &kosdaq["points"][0]["institutionEok"]), (&json!(11), &json!(-22), &json!(33)));
}

#[tokio::test]
async fn no_sample_is_taken_after_the_close_or_before_kiwoom_is_connected() {
    let dir = tempfile::tempdir().unwrap();
    let h = Harness::start_with_samples(at(MONDAY, 15, 29, 30), dir.path()).await;
    h.minute().await;
    assert_eq!(h.calls("ka10051").len(), 2, "15:30의 마감 표본까지 받는다");
    h.minute().await;
    h.clock.jump(3600);
    h.minute().await;
    assert_eq!(h.calls("ka10051").len(), 2, "정규장이 끝난 뒤에는 부르지 않는다");

    let late = tempfile::tempdir().unwrap();
    tokio::time::resume();
    let before = Harness::start_with_samples(at(MONDAY, 10, 0, 30), late.path()).await;
    before.rest.set_access(Access::Closed);
    before.minute().await;
    before.minute().await;
    assert!(before.market_calls().is_empty(), "키움이 연결되기 전에는 부르지 않는다");
    before.rest.set_access(Access::Open);
    before.minute().await;
    assert_eq!(before.calls("ka10051").len(), 2);
}

#[tokio::test]
async fn a_weekend_takes_no_samples() {
    let dir = tempfile::tempdir().unwrap();
    let h = Harness::start_with_samples(at(14, 9, 59, 30), dir.path()).await;
    h.minute().await;
    h.minute().await;
    assert!(h.market_calls().is_empty());
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    names
}

#[tokio::test]
async fn the_days_samples_continue_after_a_restart_and_go_after_the_next_0745() {
    let dir = tempfile::tempdir().unwrap();
    {
        let first = Harness::start_with_samples(at(MONDAY, 9, 59, 30), dir.path()).await;
        first.minute().await;
        first.minute().await;
        assert_eq!(minutes_of(&first.ok("/api/market-overview/flow/intraday?market=kospi").await).len(), 2);
    }
    assert_eq!(files_in(dir.path()), ["20261109.jsonl"]);
    tokio::time::resume();
    let second = Harness::start_with_samples(at(MONDAY, 10, 1, 30), dir.path()).await;
    let carried = second.ok("/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!(minutes_of(&carried), [at(MONDAY, 10, 0, 0).unix(), at(MONDAY, 10, 1, 0).unix()], "다시 켜도 그날 표본이 남는다");
    second.minute().await;
    assert_eq!(minutes_of(&second.ok("/api/market-overview/flow/intraday?market=kospi").await).len(), 3, "표본이 이어서 쌓인다");

    second.clock.jump(21 * 60 * 60 + 41 * 60);
    second.minute().await;
    assert_eq!(files_in(dir.path()), ["20261109.jsonl"], "07:44에는 아직 그 관측일이다");
    second.minute().await;
    assert_eq!(files_in(dir.path()), Vec::<String>::new(), "07:45가 지나면 지난날 표본을 지운다");
    let next = second.ok("/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!((minutes_of(&next).len(), &next["day"]), (0, &json!("2026-11-10")));
}

#[tokio::test]
async fn a_restart_drops_older_days_files_and_ignores_a_torn_last_line() {
    let dir = tempfile::tempdir().unwrap();
    let sample = |at: i64| json!({"at": at, "received_at": at, "market": "kospi", "value": {"kind": "investors", "individual_eok": 1, "foreign_eok": 2, "institution_eok": 3}}).to_string();
    std::fs::write(dir.path().join("20261106.jsonl"), format!("{}\n", sample(at(6, 10, 0, 0).unix()))).unwrap();
    std::fs::write(dir.path().join("memo.txt"), "남긴다").unwrap();
    std::fs::write(dir.path().join("20261109.jsonl"), format!("{}\n{{\"at\": 17", sample(at(MONDAY, 10, 0, 0).unix()))).unwrap();
    let h = Harness::start_with_samples(at(MONDAY, 10, 0, 30), dir.path()).await;
    assert_eq!(files_in(dir.path()), ["20261109.jsonl", "memo.txt"]);
    assert_eq!(minutes_of(&h.ok("/api/market-overview/flow/intraday?market=kospi").await), [at(MONDAY, 10, 0, 0).unix()]);
}

#[tokio::test]
async fn a_tr_failing_one_minute_leaves_that_line_and_the_earlier_samples() {
    let dir = tempfile::tempdir().unwrap();
    let h = Harness::start_with_samples(at(MONDAY, 9, 59, 30), dir.path()).await;
    h.minute().await;
    h.fake.respond_with("ka10051", 200, refused());
    h.minute().await;
    let body = h.ok("/api/market-overview/flow/intraday?market=kospi").await;
    let points = body["points"].as_array().unwrap();
    assert_eq!(points.len(), 2);
    assert_eq!((points[0]["individualEok"].as_i64(), points[0]["programEok"].as_f64()), (Some(-8787), Some(3456.03)));
    assert_eq!((points[1]["individualEok"].is_null(), points[1]["programEok"].as_f64()), (true, Some(3456.03)), "실패한 TR의 값만 비고 다른 TR 값은 그 분에도 남는다");
    h.script_market_overview();
    h.minute().await;
    assert_eq!(h.ok("/api/market-overview/flow/intraday?market=kospi").await["points"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn an_empty_answer_is_not_a_sample() {
    let dir = tempfile::tempdir().unwrap();
    let h = Harness::start_with_samples(at(MONDAY, 9, 59, 30), dir.path()).await;
    h.fake.respond_with("ka10051", 200, json!({"inds_netprps": [], "return_code": 0, "return_msg": "정상"}));
    h.fake.respond_with("ka90005", 200, json!({"prm_trde_trnsn": [], "return_code": 0, "return_msg": "정상"}));
    h.minute().await;
    assert_eq!(h.ok("/api/market-overview/flow/intraday?market=kospi").await["points"].as_array().unwrap().len(), 0);
    assert_eq!(files_in(dir.path()), Vec::<String>::new());
}

#[tokio::test]
async fn sampling_yields_to_what_the_screen_waits_for() {
    let dir = tempfile::tempdir().unwrap();
    let h = Harness::start_with_samples(at(MONDAY, 9, 59, 30), dir.path()).await;
    h.fake.respond_with("ka20003", 200, all_indices(("001", "종합(KOSPI)")));
    h.minute().await;
    let before = h.market_calls().len();
    h.clock.jump(60);
    tokio::time::sleep(Duration::from_millis(1)).await;
    h.ok("/api/market-overview/index?market=kospi").await;
    h.until_quiet().await;
    let order: Vec<_> = h.market_calls().into_iter().skip(before).map(|c| c.api_id).collect();
    assert_eq!(order.len(), 5, "{order:?}");
    assert!(order.iter().position(|id| id == "ka20003").unwrap() <= 1, "화면이 기다리는 요청이 뒤쪽 표본 호출보다 먼저 나간다: {order:?}");
}

#[tokio::test]
async fn a_sample_written_after_a_torn_last_line_survives_the_next_restart() {
    let dir = tempfile::tempdir().unwrap();
    let sample = json!({"at": at(MONDAY, 10, 0, 0).unix(), "received_at": 0, "market": "kospi", "value": {"kind": "investors", "individual_eok": 1, "foreign_eok": 2, "institution_eok": 3}}).to_string();
    std::fs::write(dir.path().join("20261109.jsonl"), format!("{sample}\n{{\"at\": 17")).unwrap();
    {
        let first = Harness::start_with_samples(at(MONDAY, 10, 0, 30), dir.path()).await;
        first.minute().await;
    }
    tokio::time::resume();
    let second = Harness::start_with_samples(at(MONDAY, 10, 1, 30), dir.path()).await;
    let body = second.ok("/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!(body["points"][1]["individualEok"], -8787, "{body}");
}
