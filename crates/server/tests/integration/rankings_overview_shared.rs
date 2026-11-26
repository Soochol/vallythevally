use crate::support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{Extension, Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::{self, Excludes, Ranking, RankingMarket, Venue};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::http::{AppState, router};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::market_source::rankings::condition_key;
use server::rankings::PublicRoute;
use server::shared_data::{Broker, ConditionEntry, ConditionState, DataKind, Header, OverviewBody, RankingsPartBody, ReceivedRanking, SAMPLES_FOLDER, SharedRankingRow, SourceKey, data_path, part_path, write_snapshot_at};
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tower::ServiceExt;

const KEEP_ALL: Excludes = Excludes { etf_etn: false, preferred: false };
const HIDE_ETF_ETN: Excludes = Excludes { etf_etn: true, preferred: false };
const DAY: &str = "20261109";
const RECEIVED_AT: i64 = 1_792_000_000;

fn monday(h: u32, m: u32) -> KstTime {
    KstTime::from_kst_civil(KstDate::new(2026, 11, 9).unwrap(), TimeOfDay::hms(h, m, 0).unwrap())
}

struct Harness {
    fake: ScriptedTransport,
    state: Arc<AppState>,
    operator: Router,
    public: Router,
    shared: PathBuf,
    clock: Clock,
    tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(shared_dir: bool) -> Harness {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(monday(10, 0));
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
        rest.set_access(Access::Open);
        let shared = tmp.path().join("shared");
        if shared_dir {
            state.shared_data.enable(shared.clone());
        }
        let operator = router(state.clone());
        let public = server::rankings::routes().layer(Extension(PublicRoute)).merge(server::market_overview::routes()).with_state(state.clone());
        Harness { fake, state, operator, public, shared, clock, tmp }
    }

    async fn poll(&self) {
        self.state.shared_data.poll_once(&self.shared).await;
    }

    fn kiwoom_calls(&self) -> Vec<String> {
        self.fake.calls().into_iter().map(|call| call.api_id).filter(|id| id != "au10001").collect()
    }

    async fn through(app: &Router, request: Request<Body>) -> (u16, Value) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    async fn rank(&self, app: &Router, ranking: Ranking, pages: u8) -> (u16, Value) {
        let body = json!({"ranking": serde_json::to_value(ranking).unwrap(), "pages": pages, "trigger": "user"});
        Harness::through(app, Request::post("/api/rankings").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await
    }

    async fn get(&self, app: &Router, path: &str) -> (u16, Value) {
        Harness::through(app, Request::get(path).body(Body::empty()).unwrap()).await
    }
}

fn trade_amount(excludes: Excludes) -> Ranking {
    Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes, exclude_managed: false }
}

fn gainers() -> Ranking {
    Ranking::Gainers { market: RankingMarket::All, venue: Venue::Combined, include_limit: true, min_trade_amount: api::MinTradeAmount::Any, excludes: KEEP_ALL, exclude_managed: false }
}

fn losers() -> Ranking {
    Ranking::Losers { market: RankingMarket::All, venue: Venue::Combined, include_limit: true, min_trade_amount: api::MinTradeAmount::Any, excludes: KEEP_ALL, exclude_managed: false }
}

fn row(code: &str) -> SharedRankingRow {
    serde_json::from_value(json!({"code": code, "name": format!("판{code}"), "price": 1000, "changeRate": 0.5, "figures": {"kind": "tradeAmount", "tradeAmount": 7, "volume": 3, "placesGained": null}})).unwrap()
}

const CODES: [&str; 10] = ["005930", "069500", "000660", "111111", "222222", "333333", "444444", "555555", "666666", "777777"];

fn received(page_rows: Vec<u32>, end: bool, at: i64) -> ReceivedRanking {
    let pages = u8::try_from(page_rows.len()).unwrap();
    let count = page_rows.iter().sum::<u32>() as usize;
    ReceivedRanking { rows: CODES.iter().cycle().take(count).map(|code| row(code)).collect(), pages, end, limited: false, received_at: at, broker: Broker::Kiwoom, page_rows }
}

fn entry(ranking: &Ranking, state: ConditionState, last: Option<ReceivedRanking>) -> ConditionEntry {
    ConditionEntry { key: condition_key(ranking), state, last }
}

fn write_rankings(dir: &Path, conditions: Vec<ConditionEntry>) {
    let header = Header::new(DataKind::Rankings, KstDate::parse_yyyymmdd(DAY).unwrap(), RECEIVED_AT, RECEIVED_AT, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]);
    write_snapshot_at(part_path(dir, DAY, "rest-01"), header, RankingsPartBody { period_secs: 10, pages: 5, conditions }).unwrap();
}

fn headers(next: Option<&str>) -> Value {
    match next {
        Some(key) => json!({"cont-yn": "Y", "next-key": key}),
        None => json!({"cont-yn": "N", "next-key": ""}),
    }
}

fn script_trade_amount(fake: &ScriptedTransport) {
    let rows = [json!({"stk_cd": "005930", "stk_nm": "키움", "now_rank": "1", "pred_rank": "1", "cur_prc": "1000", "flu_rt": "0.5", "now_trde_qty": "10", "trde_prica": "1"})];
    fake.respond_with("ka10032", 200, json!({"_headers": headers(None), "trde_prica_upper": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"}));
}

fn codes_of(page: &Value) -> Vec<&str> {
    page["rows"].as_array().unwrap().iter().map(|row| row["code"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn a_prepared_condition_is_answered_from_the_board_for_every_page_count_up_to_the_boards() {
    let h = Harness::start(true).await;
    write_rankings(&h.shared, vec![entry(&trade_amount(KEEP_ALL), ConditionState::Ready, Some(received(vec![2, 2, 2, 2, 2], false, RECEIVED_AT)))]);
    h.poll().await;
    for (pages, rows) in [(1u8, 2usize), (2, 4), (5, 10)] {
        let (status, page) = h.rank(&h.operator, trade_amount(KEEP_ALL), pages).await;
        assert_eq!(status, 200, "{page}");
        assert_eq!((page["pages"].as_u64(), page["rows"].as_array().unwrap().len(), page["end"].as_bool(), page["limited"].as_bool()), (Some(u64::from(pages)), rows, Some(false), Some(false)), "{pages}쪽: {page}");
        assert_eq!((page["fetchedAt"].as_i64(), page["source"].as_str(), page["hidden"].as_u64()), (Some(RECEIVED_AT), Some("kiwoom"), Some(0)));
    }
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new(), "판에 있는 조건은 키움을 부르지 않는다");
}

#[tokio::test]
async fn exclude_options_and_hidden_are_applied_by_the_server_on_the_boards_rows() {
    let h = Harness::start(true).await;
    write_rankings(&h.shared, vec![entry(&trade_amount(KEEP_ALL), ConditionState::Ready, Some(received(vec![2, 2, 2, 2, 2], false, RECEIVED_AT)))]);
    h.poll().await;
    let (_, shown) = h.rank(&h.operator, trade_amount(KEEP_ALL), 1).await;
    assert_eq!((codes_of(&shown), shown["hidden"].as_u64()), (vec!["005930", "069500"], Some(0)));
    let (status, hidden) = h.rank(&h.operator, trade_amount(HIDE_ETF_ETN), 1).await;
    assert_eq!(status, 200, "{hidden}");
    assert_eq!((codes_of(&hidden), hidden["hidden"].as_u64(), hidden["rows"][0]["rank"].as_u64()), (vec!["005930"], Some(1), Some(1)));
    assert_eq!(hidden["fetchedAt"].as_i64(), Some(RECEIVED_AT));
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_list_that_ended_before_the_boards_pages_answers_end_for_every_larger_request() {
    let h = Harness::start(true).await;
    write_rankings(&h.shared, vec![entry(&trade_amount(KEEP_ALL), ConditionState::Ready, Some(received(vec![3, 2], true, RECEIVED_AT)))]);
    h.poll().await;
    let (_, page) = h.rank(&h.operator, trade_amount(KEEP_ALL), 5).await;
    assert_eq!((page["pages"].as_u64(), page["rows"].as_array().unwrap().len(), page["end"].as_bool()), (Some(2), 5, Some(true)));
    let (_, first) = h.rank(&h.operator, trade_amount(KEEP_ALL), 1).await;
    assert_eq!((first["pages"].as_u64(), first["rows"].as_array().unwrap().len(), first["end"].as_bool()), (Some(1), 3, Some(false)));
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_condition_missing_from_the_board_calls_kiwoom_on_the_operator_listener_and_is_not_prepared_on_the_public_one() {
    let h = Harness::start(true).await;
    write_rankings(&h.shared, vec![entry(&gainers(), ConditionState::Ready, Some(received(vec![2], false, RECEIVED_AT)))]);
    h.poll().await;
    let (status, body) = h.rank(&h.public, trade_amount(KEEP_ALL), 1).await;
    assert_eq!((status, body["error"]["code"].as_str()), (404, Some("not_prepared")), "{body}");
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new(), "공개 리스너는 키움을 부르지 않는다");
    script_trade_amount(&h.fake);
    let (status, page) = h.rank(&h.operator, trade_amount(KEEP_ALL), 1).await;
    assert_eq!((status, codes_of(&page)), (200, vec!["005930"]), "{page}");
    assert_eq!(h.kiwoom_calls(), vec!["ka10032".to_owned()]);
}

#[tokio::test]
async fn more_pages_than_the_board_holds_calls_kiwoom_on_the_operator_listener_and_is_not_prepared_on_the_public_one() {
    let h = Harness::start(true).await;
    write_rankings(&h.shared, vec![entry(&trade_amount(KEEP_ALL), ConditionState::Ready, Some(received(vec![2, 2, 2, 2, 2], false, RECEIVED_AT)))]);
    h.poll().await;
    let (status, body) = h.rank(&h.public, trade_amount(KEEP_ALL), 6).await;
    assert_eq!((status, body["error"]["code"].as_str()), (404, Some("not_prepared")), "{body}");
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
    script_trade_amount(&h.fake);
    let (status, page) = h.rank(&h.operator, trade_amount(KEEP_ALL), 6).await;
    assert_eq!((status, page["fetchedAt"].as_i64().is_some_and(|at| at != RECEIVED_AT)), (200, true), "{page}");
    assert_eq!(h.kiwoom_calls(), vec!["ka10032".to_owned()]);
}

#[tokio::test]
async fn before_the_daemon_wrote_anything_the_public_listener_is_not_prepared_and_the_operator_listener_calls_kiwoom() {
    let h = Harness::start(true).await;
    h.poll().await;
    let (status, body) = h.rank(&h.public, trade_amount(KEEP_ALL), 1).await;
    assert_eq!((status, body["error"]["code"].as_str()), (404, Some("not_prepared")), "{body}");
    script_trade_amount(&h.fake);
    assert_eq!(h.rank(&h.operator, trade_amount(KEEP_ALL), 1).await.0, 200);
    assert_eq!(h.kiwoom_calls(), vec!["ka10032".to_owned()]);
}

#[tokio::test]
async fn a_condition_the_daemon_marked_unavailable_gets_the_closed_unsupported_reason_on_both_listeners() {
    let h = Harness::start(true).await;
    write_rankings(&h.shared, vec![entry(&losers(), ConditionState::Unavailable, None)]);
    h.poll().await;
    for app in [&h.operator, &h.public] {
        let (status, body) = h.rank(app, losers(), 1).await;
        assert_eq!((status, body["error"]["code"].as_str(), body["error"]["reason"].as_str()), (400, Some("bad_request"), Some("unsupported_by_source")), "{body}");
    }
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_failed_condition_keeps_answering_with_its_previous_value_and_without_one_says_the_collector_failed() {
    let h = Harness::start(true).await;
    let failed = ConditionState::Failed { at: RECEIVED_AT + 10, message: "연속조회 키가 되풀이됐다".into() };
    write_rankings(&h.shared, vec![entry(&trade_amount(KEEP_ALL), failed.clone(), Some(received(vec![2, 2, 2, 2, 2], false, RECEIVED_AT))), entry(&gainers(), failed, None)]);
    h.poll().await;
    let (status, page) = h.rank(&h.public, trade_amount(KEEP_ALL), 2).await;
    assert_eq!((status, page["fetchedAt"].as_i64()), (200, Some(RECEIVED_AT)), "{page}");
    let (status, body) = h.rank(&h.public, gainers(), 1).await;
    assert_eq!((status, body["error"]["code"].as_str()), (503, Some("collector_unavailable")), "{body}");
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn without_the_variable_both_listeners_call_kiwoom_as_before() {
    let h = Harness::start(false).await;
    write_rankings(&h.shared, vec![entry(&trade_amount(KEEP_ALL), ConditionState::Ready, Some(received(vec![2], false, RECEIVED_AT)))]);
    h.poll().await;
    script_trade_amount(&h.fake);
    for app in [&h.operator, &h.public] {
        let (status, page) = h.rank(app, trade_amount(KEEP_ALL), 1).await;
        assert_eq!((status, codes_of(&page)), (200, vec!["005930"]), "{page}");
    }
    assert!(!h.kiwoom_calls().is_empty());
}

fn context(market: &str) -> Value {
    json!({"market": market, "phase": "regular", "receivedAt": RECEIVED_AT, "source": "kiwoom"})
}

fn ok(value: Value) -> Value {
    json!({"status": "ok", "value": value})
}

fn index_card(market: &str, level: f64) -> Value {
    json!({"context": context(market), "index": ok(json!({"code": "001", "name": "종합", "level": level, "changeRate": 0.5, "breadth": {"rising": 1, "flat": 2, "falling": 3, "upperLimit": 4, "lowerLimit": 5}, "tradeValueEok": 9.0, "volatility": null}))})
}

fn sectors_card(market: &str) -> Value {
    json!({"context": context(market), "sectors": ok(json!([{"code": "013", "name": "전기전자", "level": 1.0, "changeRate": 2.0, "tradeValueEok": 3.0}])), "flows": ok(json!([{"code": "013", "name": "전기전자", "wholeMarket": false, "individualEok": 1, "foreignEok": 2, "institutionEok": 3}]))})
}

fn flow_card(market: &str, period: &str, individual: i64) -> Value {
    json!({"context": context(market), "period": period, "investors": ok(json!([{"date": "2026-11-06", "individualEok": individual, "foreignEok": 2, "institutionEok": 3}])), "program": ok(json!([{"date": "2026-11-06", "arbitrageEok": 1.0, "nonArbitrageEok": 2.0, "totalEok": 3.0}]))})
}

fn turnover_card(market: &str, period: &str, value: f64) -> Value {
    json!({"context": context(market), "period": period, "days": ok(json!([{"date": "2026-11-06", "tradeValueEok": value}]))})
}

fn streaks_card(market: &str) -> Value {
    let board = json!({"foreign": [{"code": "005930", "name": "삼성전자", "days": 3, "netEok": 1.0, "netShares": 10, "periodChangeRate": 0.1}], "institution": []});
    json!({"context": context(market), "buying": ok(board), "selling": ok(json!({"foreign": [], "institution": []}))})
}

fn market_cards(market: &str, level: f64) -> Value {
    json!({
        "index": index_card(market, level),
        "sectors": sectors_card(market),
        "flow": [flow_card(market, "5", 5), flow_card(market, "20", 20), flow_card(market, "60", 60)],
        "turnover": [turnover_card(market, "5", 5.0), turnover_card(market, "20", 20.0), turnover_card(market, "60", 60.0)],
        "streaks": streaks_card(market),
    })
}

fn write_overview(dir: &Path, body: Value) {
    let body: OverviewBody = serde_json::from_value(body).unwrap();
    let header = Header::new(DataKind::MarketOverview, KstDate::parse_yyyymmdd(DAY).unwrap(), RECEIVED_AT, RECEIVED_AT, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]);
    write_snapshot_at(data_path(dir, DataKind::MarketOverview, DAY, "json"), header, body).unwrap();
}

#[tokio::test]
async fn the_six_market_overview_cards_come_from_the_board_with_zero_kiwoom_calls() {
    let h = Harness::start(true).await;
    write_overview(&h.shared, json!({"kospi": market_cards("kospi", 2500.0), "kosdaq": market_cards("kosdaq", 800.0)}));
    h.poll().await;
    for app in [&h.operator, &h.public] {
        for (market, level) in [("kospi", 2500.0), ("kosdaq", 800.0)] {
            assert_eq!(h.get(app, &format!("/api/market-overview/index?market={market}")).await, (200, index_card(market, level)));
            assert_eq!(h.get(app, &format!("/api/market-overview/sectors?market={market}")).await, (200, sectors_card(market)));
            assert_eq!(h.get(app, &format!("/api/market-overview/streaks?market={market}")).await, (200, streaks_card(market)));
            for (period, individual, value) in [("5", 5, 5.0), ("20", 20, 20.0), ("60", 60, 60.0)] {
                assert_eq!(h.get(app, &format!("/api/market-overview/flow?market={market}&period={period}")).await, (200, flow_card(market, period, individual)));
                assert_eq!(h.get(app, &format!("/api/market-overview/turnover?market={market}&period={period}")).await, (200, turnover_card(market, period, value)));
            }
        }
        let (_, default_period) = h.get(app, "/api/market-overview/flow?market=kospi").await;
        assert_eq!(default_period["period"], "20");
    }
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_failed_part_inside_a_card_fails_only_that_part_and_a_card_the_daemon_has_not_made_is_not_prepared() {
    let h = Harness::start(true).await;
    let mut kospi = market_cards("kospi", 2500.0);
    let error = json!({"code": "kiwoom_unavailable", "message": "키움 조회에 실패했습니다", "reason": "kiwoom_error", "retryAt": null, "manualActionRequired": false});
    kospi["index"]["index"] = json!({"status": "failed", "error": error});
    kospi["sectors"] = Value::Null;
    write_overview(&h.shared, json!({"kospi": kospi, "kosdaq": market_cards("kosdaq", 800.0)}));
    h.poll().await;
    let (status, index) = h.get(&h.operator, "/api/market-overview/index?market=kospi").await;
    assert_eq!((status, index["index"]["status"].as_str(), index["context"]["receivedAt"].as_i64()), (200, Some("failed"), Some(RECEIVED_AT)), "{index}");
    assert_eq!(index["index"]["error"]["code"], "kiwoom_unavailable");
    assert_eq!(h.get(&h.operator, "/api/market-overview/flow?market=kospi&period=5").await, (200, flow_card("kospi", "5", 5)));
    let (status, missing) = h.get(&h.public, "/api/market-overview/sectors?market=kospi").await;
    assert_eq!((status, missing["error"]["code"].as_str()), (404, Some("not_prepared")), "{missing}");
    assert_eq!(h.get(&h.operator, "/api/market-overview/sectors?market=kosdaq").await.0, 200);
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn before_the_daemon_wrote_the_overview_every_card_is_not_prepared_without_calling_kiwoom() {
    let h = Harness::start(true).await;
    h.poll().await;
    let (status, body) = h.get(&h.operator, "/api/market-overview/index?market=kospi").await;
    assert_eq!((status, body["error"]["code"].as_str()), (404, Some("not_prepared")), "{body}");
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

fn sample_line(at: KstTime, market: &str, value: Value) -> String {
    json!({"at": at.unix(), "received_at": at.unix() + 3, "market": market, "value": value}).to_string()
}

fn write_samples(dir: &Path, day: &str, lines: &[String], torn: Option<&str>) {
    let folder = dir.join(SAMPLES_FOLDER);
    std::fs::create_dir_all(&folder).unwrap();
    let mut text = lines.iter().map(|line| format!("{line}\n")).collect::<String>();
    text.push_str(torn.unwrap_or(""));
    std::fs::write(folder.join(format!("{day}.jsonl")), text).unwrap();
}

#[tokio::test]
async fn intraday_flow_is_read_from_the_days_sample_file_and_skips_a_torn_last_line() {
    let h = Harness::start(true).await;
    write_overview(&h.shared, json!({"kospi": market_cards("kospi", 2500.0), "kosdaq": market_cards("kosdaq", 800.0)}));
    let investors = |individual: i64| json!({"kind": "investors", "individual_eok": individual, "foreign_eok": 2, "institution_eok": 3});
    let program = json!({"kind": "program", "total_million_won": 250});
    write_samples(
        &h.shared,
        DAY,
        &[sample_line(monday(9, 1), "kospi", investors(10)), sample_line(monday(9, 1), "kospi", program), sample_line(monday(9, 2), "kospi", investors(11)), sample_line(monday(9, 1), "kosdaq", investors(99))],
        Some("{\"at\": 17"),
    );
    h.poll().await;
    let (status, flow) = h.get(&h.operator, "/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!(status, 200, "{flow}");
    let at = |time: KstTime| time.unix();
    assert_eq!(
        flow["points"],
        json!([
            {"at": at(monday(9, 1)), "individualEok": 10, "foreignEok": 2, "institutionEok": 3, "programEok": 2.5},
            {"at": at(monday(9, 2)), "individualEok": 11, "foreignEok": 2, "institutionEok": 3, "programEok": null},
        ])
    );
    assert_eq!((flow["day"].as_str(), flow["context"]["receivedAt"].as_i64(), flow["context"]["source"].as_str()), (Some("2026-11-09"), Some(at(monday(9, 2)) + 3), Some("kiwoom")));
    let (_, kosdaq) = h.get(&h.public, "/api/market-overview/flow/intraday?market=kosdaq").await;
    assert_eq!(kosdaq["points"].as_array().unwrap().len(), 1);
    write_samples(&h.shared, DAY, &[sample_line(monday(9, 1), "kospi", investors(10)), sample_line(monday(9, 3), "kospi", investors(12))], None);
    h.poll().await;
    let (_, grown) = h.get(&h.operator, "/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!(grown["points"].as_array().unwrap().len(), 2, "{grown}");
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_sample_file_of_another_day_gives_no_points() {
    let h = Harness::start(true).await;
    write_samples(&h.shared, "20261106", &[sample_line(monday(9, 1), "kospi", json!({"kind": "investors", "individual_eok": 1, "foreign_eok": 2, "institution_eok": 3}))], None);
    h.poll().await;
    let (status, flow) = h.get(&h.operator, "/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!((status, flow["points"].clone()), (200, json!([])), "{flow}");
}

async fn requests_after_a_sampling_minute(shared_dir: bool) -> usize {
    let h = Harness::start(shared_dir).await;
    tokio::time::pause();
    h.fake.respond_with("ka10051", 200, json!({"return_code": 0, "return_msg": "ok"}));
    let samples = h.tmp.path().join("own-samples");
    let sampler = server::market_overview::start(h.state.clone(), samples);
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.clock.jump(60);
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    sampler.abort();
    h.fake.requests()
}

#[tokio::test]
async fn the_server_sampler_does_not_run_when_the_shared_folder_is_set() {
    assert_eq!(requests_after_a_sampling_minute(true).await, 0);
}

#[tokio::test]
async fn the_server_sampler_runs_as_before_without_the_variable() {
    assert!(requests_after_a_sampling_minute(false).await > 0);
}
