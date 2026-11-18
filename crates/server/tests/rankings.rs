mod support;

use std::sync::Arc;
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::{self, BalanceSort, ExpectedSort, Excludes, MinTradeAmount, NetDirection, Ranking, RankingInvestor, RankingMarket, SurgeBaseline, SurgeSort, TradeUnit, TradingSession, Venue, ViewSpan};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::http::{AppState, router};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::symbols::{Directory, SymbolDirectory};
use support::{Call, ScriptedReply, ScriptedTransport, fixture};
use tower::ServiceExt;

const RKINFO: &str = "/api/dostk/rkinfo";
const STKINFO: &str = "/api/dostk/stkinfo";
const KEEP_ALL: Excludes = Excludes { etf_etn: false, preferred: false };
const HIDE_ETF_ETN: Excludes = Excludes { etf_etn: true, preferred: false };
const HIDE_PREFERRED: Excludes = Excludes { etf_etn: false, preferred: true };
const HIDE_BOTH: Excludes = Excludes { etf_etn: true, preferred: true };

struct Harness {
    fake: ScriptedTransport,
    app: Router,
    clock: Clock,
    state: Arc<AppState>,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(connected: bool) -> Harness {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(KstTime::from_kst_civil(KstDate::new(2026, 11, 9).unwrap(), TimeOfDay::MIDNIGHT));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let listed = |code: &str, name: &str, kind: SymbolKind| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind, market: Market::Kospi, nxt_enabled: true };
        symbols.replace(Directory::build(vec![
            listed("005930", "삼성전자", SymbolKind::Common),
            listed("000660", "SK하이닉스", SymbolKind::Common),
            listed("005935", "삼성전자우", SymbolKind::Preferred),
            listed("069500", "KODEX 200", SymbolKind::Etf),
            listed("520100", "합성 ETN", SymbolKind::Etn),
            listed("088980", "합성 인프라", SymbolKind::Infrastructure),
            listed("094800", "합성 뮤추얼펀드", SymbolKind::MutualFund),
            listed("000070", "합성 리츠", SymbolKind::Reit),
        ]));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        if connected {
            rest.set_access(Access::Open);
        }
        let app = router(state.clone());
        tokio::time::pause();
        Harness { fake, app, clock, state, _tmp: tmp }
    }

    async fn post_raw(&self, body: Value) -> (u16, Value) {
        let request = Request::post("/api/rankings").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    async fn ask(&self, ranking: Ranking, pages: u8, trigger: &str) -> (u16, Value) {
        self.post_raw(json!({"ranking": serde_json::to_value(ranking).unwrap(), "pages": pages, "trigger": trigger})).await
    }

    async fn show(&self, ranking: Ranking, pages: u8) -> Value {
        let (status, body) = self.ask(ranking, pages, "user").await;
        assert_eq!(status, 200, "{body}");
        body
    }

    fn calls(&self, api_id: &str) -> Vec<Call> {
        self.fake.calls().into_iter().filter(|c| c.api_id == api_id).collect()
    }

    fn continuation_keys(&self, api_id: &str) -> Vec<Option<String>> {
        self.calls(api_id).into_iter().map(|c| c.next_key).collect()
    }

    fn api_ids(&self) -> Vec<String> {
        self.fake.calls().into_iter().map(|c| c.api_id).filter(|id| id != "au10001").collect()
    }
}

fn trade_amount(excludes: Excludes) -> Ranking {
    Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes, exclude_managed: false }
}

fn trade_volume() -> Ranking {
    Ranking::TradeVolume { market: RankingMarket::All, venue: Venue::Combined, session: TradingSession::All, excludes: KEEP_ALL, exclude_managed: false }
}

fn bid_ask_balance() -> Ranking {
    Ranking::BidAskBalance { market: api::Market::Kospi, venue: Venue::Krx, sort: BalanceSort::BuyRatio, excludes: KEEP_ALL, exclude_managed: false }
}

fn investor_net_buy(unit: TradeUnit) -> Ranking {
    Ranking::InvestorNetBuy { market: RankingMarket::All, investor: RankingInvestor::Foreign, direction: NetDirection::NetBuy, unit, excludes: KEEP_ALL }
}

fn headers(next: Option<&str>) -> Value {
    match next {
        Some(key) => json!({"cont-yn": "Y", "next-key": key}),
        None => json!({"cont-yn": "N", "next-key": ""}),
    }
}

fn trade_amount_page(codes: &[&str], next: Option<&str>) -> Value {
    let rows: Vec<_> = codes
        .iter()
        .map(|code| json!({"stk_cd": code, "stk_nm": format!("키움{code}"), "now_rank": "1", "pred_rank": "1", "cur_prc": "1000", "flu_rt": "0.5", "now_trde_qty": "10", "trde_prica": "1"}))
        .collect();
    json!({"_headers": headers(next), "trde_prica_upper": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn refused_key() -> Value {
    json!({"return_code": 2, "return_msg": "[1511:필수]"})
}

fn chain(fake: &ScriptedTransport, api_id: &str, pages: &[Value]) {
    fake.respond_with(api_id, 200, pages[0].clone());
    for (index, page) in pages.iter().enumerate().skip(1) {
        fake.respond_with_for_key(api_id, &format!("K{}", index + 1), 200, page.clone());
    }
}

fn codes_of(page: &Value) -> Vec<&str> {
    page["rows"].as_array().unwrap().iter().map(|row| row["code"].as_str().unwrap()).collect()
}

fn ranks_of(page: &Value) -> Vec<u64> {
    page["rows"].as_array().unwrap().iter().map(|row| row["rank"].as_u64().unwrap()).collect()
}

struct Case {
    name: &'static str,
    ranking: Ranking,
    api_id: &'static str,
    path: &'static str,
    body: Value,
    fixture: &'static str,
    price: Value,
    change_rate: Value,
    figures: Value,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "거래대금",
            ranking: Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes: KEEP_ALL, exclude_managed: false },
            api_id: "ka10032",
            path: RKINFO,
            body: json!({"mrkt_tp": "000", "mang_stk_incls": "1", "stex_tp": "3"}),
            fixture: "rank_ka10032",
            price: json!(71_200),
            change_rate: json!(-3.21),
            figures: json!({"kind": "tradeAmount", "tradeAmount": 88_000_000_000_i64, "volume": 1_234_567, "placesGained": 2}),
        },
        Case {
            name: "거래량",
            ranking: Ranking::TradeVolume { market: RankingMarket::Kospi, venue: Venue::Krx, session: TradingSession::Regular, excludes: KEEP_ALL, exclude_managed: true },
            api_id: "ka10030",
            path: RKINFO,
            body: json!({"mrkt_tp": "001", "sort_tp": "1", "mang_stk_incls": "1", "crd_tp": "0", "trde_qty_tp": "0", "pric_tp": "0", "trde_prica_tp": "0", "mrkt_open_tp": "1", "stex_tp": "1"}),
            fixture: "rank_ka10030",
            price: json!(71_200),
            change_rate: json!(-3.21),
            figures: json!({"kind": "tradeVolume", "volume": 1_234_567, "previousDayVolumeRate": 150.5}),
        },
        Case {
            name: "회전율",
            ranking: Ranking::Turnover { market: RankingMarket::Kosdaq, venue: Venue::Nxt, excludes: KEEP_ALL, exclude_managed: false },
            api_id: "ka10030",
            path: RKINFO,
            body: json!({"mrkt_tp": "101", "sort_tp": "2", "mang_stk_incls": "0", "crd_tp": "0", "trde_qty_tp": "0", "pric_tp": "0", "trde_prica_tp": "0", "mrkt_open_tp": "0", "stex_tp": "2"}),
            fixture: "rank_ka10030",
            price: json!(71_200),
            change_rate: json!(-3.21),
            figures: json!({"kind": "turnover", "turnoverRate": 1.25, "volume": 1_234_567}),
        },
        Case {
            name: "거래량 급증",
            ranking: Ranking::VolumeSurge { market: RankingMarket::All, venue: Venue::Krx, baseline: SurgeBaseline::Minutes5, sort: SurgeSort::SurgeVolume, excludes: KEEP_ALL, exclude_managed: true },
            api_id: "ka10023",
            path: RKINFO,
            body: json!({"mrkt_tp": "000", "sort_tp": "1", "tm_tp": "1", "tm": "5", "trde_qty_tp": "5", "stk_cnd": "1", "pric_tp": "0", "stex_tp": "1"}),
            fixture: "rank_ka10023",
            price: json!(71_200),
            change_rate: json!(-3.21),
            figures: json!({"kind": "volumeSurge", "surgeRate": 250.0, "surgeVolume": 500_000, "volume": 1_234_567}),
        },
        Case {
            name: "상승률",
            ranking: Ranking::Gainers { market: RankingMarket::Kospi, venue: Venue::Combined, include_limit: true, min_trade_amount: MinTradeAmount::AtLeast1Billion, excludes: KEEP_ALL, exclude_managed: true },
            api_id: "ka10027",
            path: RKINFO,
            body: json!({"mrkt_tp": "001", "sort_tp": "1", "trde_qty_cnd": "0000", "stk_cnd": "1", "crd_cnd": "0", "updown_incls": "1", "pric_cnd": "0", "trde_prica_cnd": "100", "stex_tp": "3"}),
            fixture: "rank_ka10027",
            price: json!(78_300),
            change_rate: json!(3.03),
            figures: json!({"kind": "movers", "priceChange": 2_300, "volume": 1_234_567}),
        },
        Case {
            name: "하락률",
            ranking: Ranking::Losers { market: RankingMarket::Kosdaq, venue: Venue::Nxt, include_limit: false, min_trade_amount: MinTradeAmount::AtLeast10Billion, excludes: KEEP_ALL, exclude_managed: false },
            api_id: "ka10027",
            path: RKINFO,
            body: json!({"mrkt_tp": "101", "sort_tp": "3", "trde_qty_cnd": "0000", "stk_cnd": "0", "crd_cnd": "0", "updown_incls": "0", "pric_cnd": "0", "trde_prica_cnd": "1000", "stex_tp": "2"}),
            fixture: "rank_ka10027",
            price: json!(78_300),
            change_rate: json!(3.03),
            figures: json!({"kind": "movers", "priceChange": 2_300, "volume": 1_234_567}),
        },
        Case {
            name: "예상체결",
            ranking: Ranking::Expected { market: RankingMarket::All, venue: Venue::Krx, sort: ExpectedSort::Losers, excludes: KEEP_ALL, exclude_managed: true },
            api_id: "ka10029",
            path: RKINFO,
            body: json!({"mrkt_tp": "000", "sort_tp": "4", "trde_qty_cnd": "0", "stk_cnd": "1", "crd_cnd": "0", "pric_cnd": "0", "stex_tp": "1"}),
            fixture: "rank_ka10029",
            price: Value::Null,
            change_rate: Value::Null,
            figures: json!({"kind": "expected", "expectedPrice": 78_500, "expectedChangeRate": 3.29, "expectedVolume": 321_000}),
        },
        Case {
            name: "투자자별 순매수(수량)",
            ranking: Ranking::InvestorNetBuy { market: RankingMarket::Kosdaq, investor: RankingInvestor::PensionFund, direction: NetDirection::NetSell, unit: TradeUnit::Quantity, excludes: KEEP_ALL },
            api_id: "ka10065",
            path: RKINFO,
            body: json!({"trde_tp": "2", "mrkt_tp": "101", "orgn_tp": "6000", "amt_qty_tp": "2"}),
            fixture: "rank_ka10065",
            price: json!(71_200),
            change_rate: json!((7_120_000.0_f64 - 7_000_000.0) / 7_000_000.0 * 100.0),
            figures: json!({"kind": "netQuantities", "net": 4_000, "buy": 5_000, "sell": 1_000}),
        },
        Case {
            name: "외국인 연속",
            ranking: Ranking::ForeignStreak { market: RankingMarket::Kospi, venue: Venue::Krx, direction: NetDirection::NetBuy, excludes: KEEP_ALL },
            api_id: "ka10035",
            path: RKINFO,
            body: json!({"mrkt_tp": "001", "trde_tp": "2", "base_dt_tp": "0", "stex_tp": "1"}),
            fixture: "rank_ka10035",
            price: json!(71_200),
            change_rate: Value::Null,
            figures: json!({"kind": "foreignStreak", "netD1": 1_000, "netD2": 2_000, "netD3": -500, "netTotal": 2_500, "limitExhaustionRate": 51.2}),
        },
        Case {
            name: "프로그램",
            ranking: Ranking::Program { market: api::Market::Kosdaq, venue: Venue::Combined, direction: NetDirection::NetBuy, excludes: KEEP_ALL },
            api_id: "ka90003",
            path: STKINFO,
            body: json!({"trde_upper_tp": "2", "amt_qty_tp": "1", "mrkt_tp": "P10102", "stex_tp": "3"}),
            fixture: "rank_ka90003",
            price: json!(71_200),
            change_rate: json!(-3.21),
            figures: json!({"kind": "netAmounts", "net": 4_000_000_000_i64, "buy": 5_000_000_000_i64, "sell": 1_000_000_000}),
        },
        Case {
            name: "호가잔량",
            ranking: Ranking::BidAskBalance { market: api::Market::Kospi, venue: Venue::Krx, sort: BalanceSort::BuyRatio, excludes: KEEP_ALL, exclude_managed: true },
            api_id: "ka10020",
            path: RKINFO,
            body: json!({"mrkt_tp": "001", "sort_tp": "3", "trde_qty_tp": "0000", "stk_cnd": "1", "crd_cnd": "0", "stex_tp": "1"}),
            fixture: "rank_ka10020",
            price: json!(71_200),
            change_rate: Value::Null,
            figures: json!({"kind": "bidAskBalance", "totalSellRemaining": 10_000, "totalBuyRemaining": 25_000, "netBuyRemaining": 15_000, "buyRatio": 71.43}),
        },
        Case {
            name: "신용비율",
            ranking: Ranking::CreditRatio { market: RankingMarket::All, venue: Venue::Combined, excludes: KEEP_ALL, exclude_managed: true },
            api_id: "ka10033",
            path: RKINFO,
            body: json!({"mrkt_tp": "000", "trde_qty_tp": "0", "stk_cnd": "1", "updown_incls": "1", "crd_cnd": "0", "stex_tp": "3"}),
            fixture: "rank_ka10033",
            price: json!(71_200),
            change_rate: json!(-3.21),
            figures: json!({"kind": "creditRatio", "creditRatio": 4.5, "volume": 1_234_567}),
        },
        Case {
            name: "많이 본 종목",
            ranking: Ranking::MostViewed { span: ViewSpan::Hour1, excludes: KEEP_ALL },
            api_id: "ka00198",
            path: STKINFO,
            body: json!({"qry_tp": "3"}),
            fixture: "rank_ka00198",
            price: Value::Null,
            change_rate: Value::Null,
            figures: json!({"kind": "mostViewed", "referencePrice": 71_200, "changeFromReferenceRate": -1.25, "placesGained": 3}),
        },
    ]
}

fn script_every_ranking_tr(fake: &ScriptedTransport) {
    for case in cases() {
        fake.respond_with(case.api_id, 200, fixture(case.fixture));
    }
    fake.respond_with("ka10095", 200, fixture("rank_ka10095_krx"));
}

#[tokio::test]
async fn each_ranking_goes_out_as_its_own_kiwoom_request() {
    let h = Harness::start(true).await;
    script_every_ranking_tr(&h.fake);
    for case in cases() {
        let (status, body) = h.ask(case.ranking, 1, "user").await;
        assert_eq!(status, 200, "{}: {body}", case.name);
        let sent: Vec<_> = h.calls(case.api_id).into_iter().filter(|c| c.body == case.body).collect();
        assert_eq!(sent.len(), 1, "{}: {:?}", case.name, h.fake.calls());
        assert_eq!((sent[0].path.as_str(), sent[0].next_key.clone()), (case.path, None), "{}", case.name);
    }
    assert_eq!(cases().len(), 13, "순위 13종");
}

#[tokio::test]
async fn each_kiwoom_answer_becomes_its_own_columns() {
    let h = Harness::start(true).await;
    script_every_ranking_tr(&h.fake);
    for case in cases() {
        let page = h.show(case.ranking, 1).await;
        let first = &page["rows"][0];
        assert_eq!((first["rank"].clone(), first["code"].clone(), first["name"].clone(), first["listed"].clone()), (json!(1), json!("005930"), json!("삼성전자"), json!(true)), "{}", case.name);
        assert_eq!((&first["price"], &first["changeRate"], &first["figures"]), (&case.price, &case.change_rate, &case.figures), "{}: {first}", case.name);
        assert_eq!((page["pages"].clone(), page["end"].clone(), page["limited"].clone(), page["hidden"].clone()), (json!(1), json!(true), json!(false), json!(0)), "{}", case.name);
    }
}

#[tokio::test]
async fn the_amount_unit_of_net_buying_is_converted_from_million_won() {
    let h = Harness::start(true).await;
    script_every_ranking_tr(&h.fake);
    let page = h.show(investor_net_buy(TradeUnit::Amount), 1).await;
    assert_eq!(page["rows"][0]["figures"], json!({"kind": "netAmounts", "net": 4_000_000_000_i64, "buy": 5_000_000_000_i64, "sell": 1_000_000_000}));
    assert_eq!(page["rows"][1]["figures"], json!({"kind": "netAmounts", "net": -7_000_000_000_i64, "buy": 2_000_000_000, "sell": 9_000_000_000_i64}));
}

#[tokio::test]
async fn three_pages_follow_the_next_key_and_a_last_page_marks_the_end() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001", "000002"], Some("K2")), trade_amount_page(&["000003", "000004"], Some("K3")), trade_amount_page(&["000005"], None)]);
    let page = h.show(trade_amount(KEEP_ALL), 3).await;
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned()), Some("K3".to_owned())]);
    assert_eq!((&page["end"], &page["limited"], &page["pages"]), (&json!(true), &json!(false), &json!(3)));
    assert_eq!(codes_of(&page), ["000001", "000002", "000003", "000004", "000005"]);
}

#[tokio::test]
async fn a_list_that_ends_early_reports_the_pages_it_has() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001"], Some("K2")), trade_amount_page(&["000002"], None)]);
    let page = h.show(trade_amount(KEEP_ALL), 5).await;
    assert_eq!(h.calls("ka10032").len(), 2, "끝이 오면 더 부르지 않는다");
    assert_eq!((&page["end"], &page["pages"]), (&json!(true), &json!(2)));
}

#[tokio::test]
async fn the_thirtieth_page_with_a_next_key_is_limited_and_a_thirty_first_is_never_asked() {
    let h = Harness::start(true).await;
    let pages: Vec<Value> = (1..=31).map(|n| trade_amount_page(&[&format!("{n:06}")], Some(&format!("K{}", n + 1)))).collect();
    chain(&h.fake, "ka10032", &pages);
    let page = h.show(trade_amount(KEEP_ALL), 30).await;
    assert_eq!((&page["end"], &page["limited"], &page["pages"]), (&json!(false), &json!(true), &json!(30)));
    assert_eq!(page["rows"].as_array().unwrap().len(), 30);
    let keys = h.continuation_keys("ka10032");
    assert_eq!(keys.len(), 30);
    assert!(!keys.contains(&Some("K31".to_owned())), "{keys:?}");
}

#[tokio::test]
async fn a_page_count_outside_one_to_thirty_is_a_bad_request_that_never_reaches_kiwoom() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, trade_amount_page(&["000001"], None));
    let ranking = serde_json::to_value(trade_amount(KEEP_ALL)).unwrap();
    for pages in [json!(0), json!(31), json!(256), json!(-1), json!("3")] {
        let (status, body) = h.post_raw(json!({"ranking": ranking, "pages": pages, "trigger": "user"})).await;
        assert_eq!((status, &body["error"]["code"]), (400, &json!("bad_request")), "{pages}: {body}");
    }
    assert!(h.fake.calls().is_empty());
}

#[tokio::test]
async fn a_repeated_next_key_is_an_error_and_the_next_request_starts_over_at_page_one() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001"], Some("K2")), trade_amount_page(&["000002"], Some("K2"))]);
    let (status, body) = h.ask(trade_amount(KEEP_ALL), 5, "user").await;
    assert_eq!((status, &body["error"]["code"], &body["error"]["reason"]), (503, &json!("kiwoom_unavailable"), &json!("protocol")), "{body}");
    let (again, _) = h.ask(trade_amount(KEEP_ALL), 5, "user").await;
    assert_eq!(again, 503);
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned()), None, Some("K2".to_owned())]);
}

#[tokio::test]
async fn continuing_without_a_next_key_is_an_error_not_an_end() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, trade_amount_page(&["000001"], Some("")));
    for _ in 0..2 {
        let (status, body) = h.ask(trade_amount(KEEP_ALL), 3, "user").await;
        assert_eq!((status, &body["error"]["code"], &body["error"]["reason"]), (503, &json!("kiwoom_unavailable"), &json!("protocol")), "{body}");
    }
    assert_eq!(h.continuation_keys("ka10032"), [None, None], "부분 결과는 캐시에 없어 다음 요청도 1페이지부터다");
}

#[tokio::test]
async fn a_failure_on_page_two_is_an_error_and_leaves_no_partial_result() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, trade_amount_page(&["000001"], Some("K2")));
    h.fake.respond_with_for_key("ka10032", "K2", 200, refused_key());
    let (status, body) = h.ask(trade_amount(KEEP_ALL), 2, "user").await;
    assert_ne!(status, 200, "{body}");
    assert!(body["error"]["code"].is_string(), "{body}");
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001"], Some("K2")), trade_amount_page(&["000002"], None)]);
    let page = h.show(trade_amount(KEEP_ALL), 2).await;
    assert_eq!(codes_of(&page), ["000001", "000002"]);
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned()), None, Some("K2".to_owned())]);
}

#[tokio::test]
async fn a_stock_on_two_pages_appears_once_in_its_earlier_place_and_ranks_stay_gapless() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001", "000002", "000003"], Some("K2")), trade_amount_page(&["000002", "000004", "000001", "000005"], None)]);
    let page = h.show(trade_amount(KEEP_ALL), 2).await;
    assert_eq!(codes_of(&page), ["000001", "000002", "000003", "000004", "000005"]);
    assert_eq!(ranks_of(&page), [1, 2, 3, 4, 5]);
    assert_eq!(page["hidden"], 0, "중복은 칩으로 뺀 줄이 아니다");
    assert_eq!(page["rows"][0]["name"], "키움000001", "이름은 키움이 준 이름이다");
}

fn mixed_kinds_page() -> Value {
    trade_amount_page(&["005930", "005935", "069500", "520100", "088980", "094800", "000070", "999999"], None)
}

#[tokio::test]
async fn hiding_etf_and_etn_drops_both_kinds_and_keeps_infrastructure_and_mutual_funds() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, mixed_kinds_page());
    let page = h.show(trade_amount(HIDE_ETF_ETN), 1).await;
    assert_eq!(codes_of(&page), ["005930", "005935", "088980", "094800", "000070", "999999"]);
    assert_eq!((&page["hidden"], ranks_of(&page)), (&json!(2), vec![1, 2, 3, 4, 5, 6]));
}

#[tokio::test]
async fn hiding_preferred_drops_only_preferred_stocks() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, mixed_kinds_page());
    let page = h.show(trade_amount(HIDE_PREFERRED), 1).await;
    assert_eq!(codes_of(&page), ["005930", "069500", "520100", "088980", "094800", "000070", "999999"]);
    assert_eq!(page["hidden"], 1);
    let both = h.show(trade_amount(HIDE_BOTH), 1).await;
    assert_eq!((codes_of(&both), &both["hidden"]), (vec!["005930", "088980", "094800", "000070", "999999"], &json!(3)));
    let none = h.show(trade_amount(KEEP_ALL), 1).await;
    assert_eq!((none["rows"].as_array().unwrap().len(), &none["hidden"]), (8, &json!(0)));
}

#[tokio::test]
async fn stocks_outside_the_app_list_stay_in_place_unlisted_and_uncounted() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, mixed_kinds_page());
    let page = h.show(trade_amount(HIDE_BOTH), 1).await;
    let listed: Vec<_> = page["rows"].as_array().unwrap().iter().map(|row| (row["code"].as_str().unwrap(), row["listed"].as_bool().unwrap())).collect();
    assert_eq!(listed, [("005930", true), ("088980", true), ("094800", true), ("000070", true), ("999999", false)]);
    assert_eq!(page["hidden"], 3, "목록에 없는 줄은 hidden에 들지 않는다");
}

#[tokio::test]
async fn requests_that_differ_only_in_what_they_hide_share_one_kiwoom_call() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, mixed_kinds_page());
    let plain = h.show(trade_amount(KEEP_ALL), 1).await;
    let hiding = h.show(trade_amount(HIDE_BOTH), 1).await;
    assert_eq!(h.calls("ka10032").len(), 1);
    assert_eq!((&plain["hidden"], &hiding["hidden"], plain["fetchedAt"] == hiding["fetchedAt"]), (&json!(0), &json!(3), true));
}

#[tokio::test]
async fn two_simultaneous_identical_requests_make_one_kiwoom_call_and_get_the_same_answer() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001"], Some("K2")), trade_amount_page(&["000002"], None)]);
    let held = h.fake.hold("첫 페이지", |c| c.api_id == "ka10032");
    let release = async {
        held.arrived().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        held.release();
    };
    let (a, b, ()) = tokio::join!(h.ask(trade_amount(KEEP_ALL), 2, "user"), h.ask(trade_amount(KEEP_ALL), 2, "user"), release);
    assert_eq!((a.0, b.0), (200, 200), "{a:?} {b:?}");
    assert_eq!(a.1, b.1);
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned())], "두 요청이 걷기를 나눠 쓴다");
}

#[tokio::test]
async fn a_deeper_request_arriving_during_a_walk_continues_it_after_it_ends() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001"], Some("K2")), trade_amount_page(&["000002"], Some("K3")), trade_amount_page(&["000003"], None)]);
    let held = h.fake.hold("첫 페이지", |c| c.api_id == "ka10032");
    let release = async {
        held.arrived().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        held.release();
    };
    let (shallow, deep, ()) = tokio::join!(h.ask(trade_amount(KEEP_ALL), 1, "user"), h.ask(trade_amount(KEEP_ALL), 3, "user"), release);
    assert_eq!((shallow.0, deep.0), (200, 200), "{shallow:?} {deep:?}");
    assert_eq!(codes_of(&shallow.1), ["000001"]);
    assert_eq!(codes_of(&deep.1), ["000001", "000002", "000003"]);
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned()), Some("K3".to_owned())], "얕은 걷기의 1페이지를 다시 받지 않고 이어 받는다");
}

#[tokio::test]
async fn a_second_request_inside_eight_seconds_is_served_from_memory_and_a_later_one_walks_again() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001"], Some("K2")), trade_amount_page(&["000002"], None)]);
    let first = h.show(trade_amount(KEEP_ALL), 2).await;
    assert_eq!(h.calls("ka10032").len(), 2);
    h.clock.jump(7);
    let second = h.show(trade_amount(KEEP_ALL), 2).await;
    assert_eq!(second, first);
    assert_eq!(h.calls("ka10032").len(), 2, "7초 된 스냅숏은 새것이다");
    h.clock.jump(1);
    let third = h.show(trade_amount(KEEP_ALL), 2).await;
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned()), None, Some("K2".to_owned())], "8초가 되면 1페이지부터 다시 받는다");
    assert!(third["fetchedAt"].as_i64().unwrap() > first["fetchedAt"].as_i64().unwrap());
}

#[tokio::test]
async fn a_fresh_one_page_snapshot_is_extended_with_the_kept_key_and_serves_shallower_requests_later() {
    let h = Harness::start(true).await;
    chain(&h.fake, "ka10032", &[trade_amount_page(&["000001"], Some("K2")), trade_amount_page(&["000002"], None)]);
    let one = h.show(trade_amount(KEEP_ALL), 1).await;
    assert_eq!((&one["end"], &one["pages"]), (&json!(false), &json!(1)));
    let two = h.show(trade_amount(KEEP_ALL), 2).await;
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned())], "모자란 한 페이지만 이어 받는다");
    assert_eq!((codes_of(&two), &two["end"], &two["pages"], two["fetchedAt"] == one["fetchedAt"]), (vec!["000001", "000002"], &json!(true), &json!(2), true));
    let again = h.show(trade_amount(KEEP_ALL), 1).await;
    assert_eq!(h.calls("ka10032").len(), 2);
    assert_eq!((codes_of(&again), &again["end"]), (vec!["000001"], &json!(false)), "더 있는 목록의 앞쪽만 보이면 끝이 아니다");
}

#[tokio::test]
async fn a_key_kiwoom_refuses_sends_the_walk_back_to_page_one() {
    let h = Harness::start(true).await;
    let ok = |codes: &[&str], next| ScriptedReply { status: 200, body: trade_amount_page(codes, next), delay: Duration::ZERO };
    h.fake.script(
        "ka10032",
        vec![
            ok(&["000001"], Some("K2")),
            ScriptedReply { status: 200, body: refused_key(), delay: Duration::ZERO },
            ok(&["000001"], Some("K2")),
            ok(&["000002"], None),
        ],
    );
    h.show(trade_amount(KEEP_ALL), 1).await;
    let page = h.show(trade_amount(KEEP_ALL), 2).await;
    assert_eq!(codes_of(&page), ["000001", "000002"]);
    assert_eq!(h.continuation_keys("ka10032"), [None, Some("K2".to_owned()), None, Some("K2".to_owned())]);
}

#[tokio::test]
async fn a_snapshot_nobody_read_for_sixty_seconds_is_dropped() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, trade_amount_page(&["000001"], None));
    h.fake.respond_with("ka10030", 200, fixture("rank_ka10030"));
    h.show(trade_amount(KEEP_ALL), 1).await;
    assert_eq!(h.state.rankings.slots(), 1);
    h.clock.jump(59);
    h.show(trade_volume(), 1).await;
    assert_eq!(h.state.rankings.slots(), 2, "59초 된 것은 아직 둔다");
    h.clock.jump(2);
    h.show(trade_volume(), 1).await;
    assert_eq!(h.state.rankings.slots(), 1, "61초 동안 읽지 않은 거래대금 스냅숏은 버렸다");
    h.show(trade_amount(KEEP_ALL), 1).await;
    assert_eq!(h.calls("ka10032").len(), 2, "버린 뒤의 요청은 키움을 다시 부른다");
}

#[tokio::test]
async fn refresh_requests_go_out_behind_user_requests() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10020", 200, fixture("rank_ka10020"));
    h.fake.respond_with("ka10032", 200, fixture("rank_ka10032"));
    h.fake.respond_with("ka10030", 200, fixture("rank_ka10030"));
    h.ask(bid_ask_balance(), 1, "user").await;
    let (refresh, user) = tokio::join!(h.ask(trade_amount(KEEP_ALL), 1, "refresh"), h.ask(trade_volume(), 1, "user"));
    assert_eq!((refresh.0, user.0), (200, 200));
    assert_eq!(h.api_ids(), ["ka10020", "ka10030", "ka10032"], "나중에 들어온 user가 refresh 앞에 나간다");
}

#[tokio::test]
async fn a_user_request_joining_a_waiting_refresh_walk_lifts_it_to_the_front() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10020", 200, fixture("rank_ka10020"));
    h.fake.respond_with("ka10032", 200, fixture("rank_ka10032"));
    h.fake.respond_with("ka10030", 200, fixture("rank_ka10030"));
    h.ask(bid_ask_balance(), 1, "user").await;
    let (other, refresh, user) = tokio::join!(h.ask(trade_volume(), 1, "refresh"), h.ask(trade_amount(KEEP_ALL), 1, "refresh"), h.ask(trade_amount(KEEP_ALL), 1, "user"));
    assert_eq!((other.0, refresh.0, user.0), (200, 200, 200));
    assert_eq!(h.api_ids(), ["ka10020", "ka10032", "ka10030"], "기다리는 요청 가운데 가장 높은 우선순위로 나간다");
    assert_eq!(h.calls("ka10032").len(), 1);
}

#[tokio::test]
async fn net_buying_fills_price_and_change_rate_from_one_quotes_call_kept_in_the_same_snapshot() {
    let h = Harness::start(true).await;
    script_every_ranking_tr(&h.fake);
    let page = h.show(investor_net_buy(TradeUnit::Amount), 1).await;
    let second = &page["rows"][1];
    assert_eq!((&second["code"], &second["price"]), (&json!("000660"), &json!(120_500)));
    assert!((second["changeRate"].as_f64().unwrap() - 0.4166).abs() < 1e-3, "{second}");
    let quotes = h.calls("ka10095");
    assert_eq!(quotes.iter().map(|c| c.body.clone()).collect::<Vec<_>>(), [json!({"stk_cd": "005930|000660"})]);
    h.clock.jump(7);
    h.show(investor_net_buy(TradeUnit::Amount), 1).await;
    assert_eq!((h.calls("ka10065").len(), h.calls("ka10095").len()), (1, 1), "8초 안에는 두 값도 다시 받지 않는다");
}

#[tokio::test]
async fn net_buying_without_quotes_still_lists_its_rows_with_empty_price_and_change_rate() {
    let h = Harness::start(true).await;
    script_every_ranking_tr(&h.fake);
    h.fake.respond_with("ka10095", 200, refused_key());
    let page = h.show(investor_net_buy(TradeUnit::Amount), 1).await;
    assert_eq!(codes_of(&page), ["005930", "000660"]);
    for row in page["rows"].as_array().unwrap() {
        assert_eq!((&row["price"], &row["changeRate"]), (&Value::Null, &Value::Null), "{row}");
    }
    assert_eq!(page["rows"][0]["figures"]["net"], 4_000_000_000_i64);
}

#[tokio::test]
async fn before_kiwoom_is_connected_a_ranking_answers_not_connected() {
    let h = Harness::start(false).await;
    for ranking in [trade_amount(KEEP_ALL), investor_net_buy(TradeUnit::Amount)] {
        let (status, body) = h.ask(ranking, 1, "user").await;
        assert_eq!((status, body["error"]["code"].as_str(), body["error"]["reason"].as_str()), (503, Some("kiwoom_unavailable"), Some("not_connected")), "{body}");
    }
    assert!(h.fake.calls().is_empty());
}

async fn post_to(app: Router, ranking: Ranking, pages: u8, trigger: &'static str) -> (u16, Value) {
    let body = json!({"ranking": serde_json::to_value(ranking).unwrap(), "pages": pages, "trigger": trigger});
    let request = Request::post("/api/rankings").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
}

#[tokio::test]
async fn a_user_joining_just_as_the_refresh_answer_lands_does_not_call_kiwoom_twice() {
    let h = Harness::start(true).await;
    h.fake.respond_with("ka10032", 200, trade_amount_page(&["000001"], None));
    let mut per_round = Vec::new();
    h.fake.delay("ka10032", Duration::from_millis(100));
    for _ in 0..16 {
        let before = h.calls("ka10032").len();
        let held = h.fake.hold("refresh 1페이지", |c| c.api_id == "ka10032");
        let walker = tokio::spawn(post_to(h.app.clone(), trade_amount(KEEP_ALL), 1, "refresh"));
        held.arrived().await;
        held.release();
        let app = h.app.clone();
        let user = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            post_to(app, trade_amount(KEEP_ALL), 1, "user").await
        });
        let refresh = walker.await.unwrap();
        let user = user.await.unwrap();
        assert_eq!((refresh.0, user.0), (200, 200));
        per_round.push(h.calls("ka10032").len() - before);
        h.clock.jump(8);
    }
    assert!(per_round.iter().all(|&n| n == 1), "라운드마다 ka10032 호출 수: {per_round:?}");
}
