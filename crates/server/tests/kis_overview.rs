mod support;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Symbol, SymbolInfo, SymbolKind, Weekday};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::{KisCredentials, Secret};
use server::db::AppDb;
use server::http::router;
use server::kis::api::KisApiId;
use server::kis::auth::KisAuth;
use server::kis::overview::{KisOverview, SUPPORTED_OVERVIEW_FEATURES};
use server::kis::rest::KisRest;
use server::kis::token_file::{Saved, SavedToken, TokenFile, credential_id};
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::market_overview::KiwoomOverview;
use server::market_source::{KiwoomHandle, OverviewFeature, OverviewSource, Priority, StreakSide};
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tower::ServiceExt;

const APP_KEY: &str = "FAKE-KIS-APPKEY-overview-1";
const APP_SECRET: &str = "FAKE-KIS-SECRET-overview-1";
const TOKEN: &str = "FAKE-KIS-TOKEN-overview";
const SAMSUNG: &str = "005930";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kis/overview").join(name)).unwrap().trim().to_owned()
}

fn monday() -> KstDate {
    KstDate::new(2026, 11, 9).unwrap()
}

fn at(h: u32, m: u32, s: u32) -> KstTime {
    kst(monday(), h, m, s)
}

#[derive(Clone)]
struct Sent {
    path: &'static str,
    query: Vec<(String, String)>,
    continuing: bool,
}

impl Sent {
    fn get(&self, name: &str) -> &str {
        self.query.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str()).unwrap_or_else(|| panic!("{name}이 없다: {:?}", self.query))
    }

    fn is(&self, api: KisApiId) -> bool {
        self.path == api.path()
    }
}

type Handler = dyn Fn(&Sent) -> HttpResponse + Send + Sync;

struct Held {
    api: KisApiId,
    arrived: Arc<tokio::sync::Notify>,
    gate: Arc<tokio::sync::Semaphore>,
}

struct FakeKis {
    sent: Mutex<Vec<Sent>>,
    handler: Box<Handler>,
    held: Mutex<Option<Held>>,
}

impl FakeKis {
    fn sent_to(&self, api: KisApiId) -> Vec<Sent> {
        self.sent.lock().unwrap().iter().filter(|s| s.is(api)).cloned().collect()
    }

    fn total(&self) -> usize {
        self.sent.lock().unwrap().len()
    }

    fn hold_next(&self, api: KisApiId) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>) {
        let (arrived, gate) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0)));
        *self.held.lock().unwrap() = Some(Held { api, arrived: arrived.clone(), gate: gate.clone() });
        (arrived, gate)
    }
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let sent = Sent { path: req.path, query: req.query.iter().map(|(n, v)| (n.to_string(), v.clone())).collect(), continuing: req.header("tr_cont").is_some_and(|v| !v.is_empty()) };
        let response = (self.handler)(&sent);
        let held = self.held.lock().unwrap().take_if(|held| sent.is(held.api));
        self.sent.lock().unwrap().push(sent);
        Box::pin(async move {
            if let Some(held) = held {
                held.arrived.notify_one();
                held.gate.acquire().await.unwrap().forget();
            }
            Ok(response)
        })
    }
}

fn ok(body: impl Into<String>) -> HttpResponse {
    HttpResponse { status: 200, tr_cont: None, body: body.into() }
}

fn ok_more(body: impl Into<String>, more: bool) -> HttpResponse {
    HttpResponse { status: 200, tr_cont: Some(if more { "M" } else { "D" }.into()), body: body.into() }
}

fn route(sent: &Sent) -> HttpResponse {
    let served = [
        (KisApiId::IndexPrice, "index_price.json"),
        (KisApiId::IndexCategoryPrice, "sectors.json"),
        (KisApiId::InvestorTimeByMarket, "investor_time.json"),
        (KisApiId::ProgramToday, "program_today.json"),
        (KisApiId::ProgramDaily, "program_daily.json"),
        (KisApiId::StockInvestorDaily, "stock_investor_daily.json"),
        (KisApiId::InvestorEstimate, "investor_estimate.json"),
        (KisApiId::CurrentPrice, "price_with_foreign_holdings.json"),
    ];
    match served.iter().find(|(api, _)| sent.is(*api)) {
        Some((_, name)) => ok(fixture(name)),
        None => panic!("시험이 정하지 않은 요청: {} {:?}", sent.path, sent.query),
    }
}

struct Harness {
    app: Router,
    kis: Arc<FakeKis>,
    kiwoom: ScriptedTransport,
    clock: Clock,
    source: Arc<KisOverview>,
    state: Arc<server::http::AppState>,
    sampler: Option<tokio::task::JoinHandle<()>>,
    _dir: tempfile::TempDir,
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(sampler) = &self.sampler {
            sampler.abort();
        }
    }
}

impl Harness {
    async fn start(now: KstTime, handler: impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static) -> Harness {
        Harness::start_sampling(now, handler, None).await
    }

    async fn start_sampling(now: KstTime, handler: impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static, samples: Option<&Path>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let token_path: PathBuf = dir.path().join("state/vallythevally/kis-token.json");
        TokenFile::new(token_path.clone())
            .save(&Saved { credential: Some(credential_id(APP_KEY)), token: Some(SavedToken { value: TOKEN.into(), expires_at: now.unix() + 86_400, issued_at: now.unix() - 3600 }), last_request_at: now.unix() - 3600, disconnected: None })
            .unwrap();
        let kis = Arc::new(FakeKis { sent: Mutex::default(), handler: Box::new(handler), held: Mutex::default() });
        let clock = Clock::fake(now);
        let transport: Arc<dyn Transport> = kis.clone();
        let credentials = KisCredentials { app_key: Secret::new(APP_KEY.into()), app_secret: Secret::new(APP_SECRET.into()) };
        let auth = KisAuth::new(credentials, token_path, transport.clone(), clock.clone());
        let source = Arc::new(KisOverview::new(KisRest::new(transport, auth)));

        let kiwoom = ScriptedTransport::new();
        let rest = KiwoomRest::new(kiwoom.transport(), KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let listed = |code: &str, name: &str, kind: SymbolKind| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind, market: domain::Market::Kospi, nxt_enabled: true };
        symbols.replace(Directory::build(vec![listed(SAMSUNG, "삼성전자", SymbolKind::Common), listed("069500", "KODEX 200", SymbolKind::Etf)]));
        let db = AppDb::open(&dir.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: dir.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        state.market_overview.choose(Some(source.clone() as Arc<dyn OverviewSource>));
        let app = router(state.clone());
        tokio::time::pause();
        let sampler = samples.map(|samples| server::market_overview::start(state.clone(), samples.to_owned()));
        Harness { app, kis, kiwoom, clock, source, state, sampler, _dir: dir }
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

    async fn minute(&self) {
        self.clock.jump(60);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut last = usize::MAX;
        for _ in 0..600 {
            let now = self.kis.total();
            if now == last {
                return;
            }
            last = now;
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        panic!("요청이 멈추지 않습니다");
    }
}

fn weekdays_back_from(end: KstDate, count: usize) -> Vec<KstDate> {
    let mut out = Vec::new();
    let mut day = end;
    while out.len() < count {
        if !matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
            out.push(day);
        }
        day = day.add_days(-1);
    }
    out
}

#[tokio::test]
async fn the_kospi_index_card_asks_the_kis_index_tr_once_and_fills_the_neutral_columns() {
    let h = Harness::start(at(10, 0, 0), route).await;
    let mut body = h.ok("/api/market-overview/index?market=kospi").await;
    let received_at = body["context"].as_object_mut().unwrap().remove("receivedAt").unwrap().as_i64().unwrap();
    assert!((at(10, 0, 0).unix()..at(10, 0, 30).unix()).contains(&received_at), "{received_at}");
    assert_eq!(
        body,
        json!({
            "context": {"market": "kospi", "phase": "regular", "source": "kis"},
            "index": {"status": "ok", "value": {
                "code": "0001", "name": "코스피", "level": 2705.38, "changeRate": -0.67,
                "breadth": {"rising": 410, "flat": 52, "falling": 498, "upperLimit": 3, "lowerLimit": 0},
                "tradeValueEok": 134859.76,
                "volatility": null
            }}
        })
    );
    let sent = h.kis.sent_to(KisApiId::IndexPrice);
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[0].get("FID_INPUT_ISCD")), ("U", "0001"));
    assert_eq!(KisApiId::IndexPrice.tr_id(), "FHPUP02100000");
    assert_eq!(h.kis.total(), 1);
}

fn paged_index_days(days: Vec<KstDate>, rows_per_page: Arc<AtomicUsize>) -> impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static {
    let served = AtomicUsize::new(0);
    move |sent| {
        assert!(sent.is(KisApiId::IndexChart), "{}", sent.path);
        let from = if sent.continuing { served.load(Ordering::SeqCst) } else { 0 };
        let page: Vec<Value> = days[from..].iter().take(rows_per_page.load(Ordering::SeqCst)).map(|d| json!({"stck_bsop_date": d.yyyymmdd(), "bstp_nmix_prpr": "2700.00", "acml_tr_pbmn": "20000000"})).collect();
        served.store(from + page.len(), Ordering::SeqCst);
        ok_more(json!({"rt_cd": "0", "output1": {}, "output2": page}).to_string(), from + page.len() < days.len())
    }
}

#[tokio::test]
async fn index_trading_days_follow_continuation_until_the_period_is_covered() {
    let rows_per_page = Arc::new(AtomicUsize::new(50));
    let h = Harness::start(at(10, 0, 0), paged_index_days(weekdays_back_from(monday(), 120), rows_per_page.clone())).await;
    let days = h.source.trading_days(server::api::Market::Kospi, monday(), Priority::Screen).await.unwrap();
    assert!(days.len() >= 60, "{}", days.len());
    assert!(days.windows(2).all(|pair| pair[0].date < pair[1].date), "오름차순이다");
    let sent = h.kis.sent_to(KisApiId::IndexChart);
    assert_eq!((sent.len(), sent[0].continuing, sent[1].continuing), (2, false, true), "50행 쪽 둘로 60일을 채우고 멈춘다");

    rows_per_page.store(100, Ordering::SeqCst);
    let days = h.source.trading_days(server::api::Market::Kospi, monday(), Priority::Screen).await.unwrap();
    assert_eq!(days.len(), 100);
    assert_eq!(h.kis.sent_to(KisApiId::IndexChart).len(), 3, "쪽이 100행이면 이 호출은 한 번만 보낸다");
}

#[tokio::test]
async fn an_empty_breadth_count_is_none() {
    let blank = Arc::new(AtomicBool::new(true));
    let blank_in_handler = blank.clone();
    let h = Harness::start(at(10, 0, 0), move |sent| {
        assert!(sent.is(KisApiId::IndexPrice));
        let mut body: Value = serde_json::from_str(&fixture("index_price.json")).unwrap();
        if blank_in_handler.load(Ordering::SeqCst) {
            for column in ["ascn_issu_cnt", "uplm_issu_cnt", "stnr_issu_cnt", "down_issu_cnt", "lslm_issu_cnt"] {
                body["output"][column] = json!("");
            }
        }
        ok(body.to_string())
    })
    .await;
    let b = h.source.index(server::api::Market::Kospi, Priority::Screen).await.unwrap().breadth;
    assert_eq!((b.rising, b.flat, b.falling, b.upper_limit, b.lower_limit), (None, None, None, None, None));
    let body = h.ok("/api/market-overview/index?market=kospi").await;
    assert_eq!(body["index"]["value"]["breadth"], json!({"rising": null, "flat": null, "falling": null, "upperLimit": null, "lowerLimit": null}));

    blank.store(false, Ordering::SeqCst);
    let b = h.source.index(server::api::Market::Kospi, Priority::Screen).await.unwrap().breadth;
    assert_eq!((b.rising, b.flat, b.falling, b.upper_limit, b.lower_limit), (Some(410), Some(52), Some(498), Some(3), Some(0)));
}

#[tokio::test]
async fn the_sectors_card_reads_levels_once_and_flows_per_sector_in_the_background() {
    let h = Harness::start(at(10, 0, 0), |sent| {
        if sent.is(KisApiId::InvestorTimeByMarket) {
            let sector = sent.get("FID_INPUT_ISCD_2");
            let (individual, foreign, institution) = match sector {
                "0001" => ("-878700", "647300", "189300"),
                "0013" => ("-10000", "5000", "2500"),
                _ => ("100", "200", "300"),
            };
            return ok(json!({"rt_cd": "0", "output": [{"prsn_ntby_tr_pbmn": individual, "frgn_ntby_tr_pbmn": foreign, "orgn_ntby_tr_pbmn": institution}]}).to_string());
        }
        route(sent)
    })
    .await;
    let body = h.ok("/api/market-overview/sectors?market=kospi").await;
    assert_eq!(
        body["sectors"]["value"],
        json!([
            {"code": "0013", "name": "전기전자", "level": 3100.5, "changeRate": 1.25, "tradeValueEok": 40000.0},
            {"code": "0021", "name": "금융", "level": 900.1, "changeRate": -0.11, "tradeValueEok": 2500.0}
        ])
    );
    assert_eq!(
        body["flows"]["value"],
        json!([
            {"code": "0001", "name": "코스피", "wholeMarket": true, "individualEok": -8787, "foreignEok": 6473, "institutionEok": 1893},
            {"code": "0013", "name": "전기전자", "wholeMarket": false, "individualEok": -100, "foreignEok": 50, "institutionEok": 25},
            {"code": "0021", "name": "금융", "wholeMarket": false, "individualEok": 1, "foreignEok": 2, "institutionEok": 3}
        ])
    );
    let flows = h.kis.sent_to(KisApiId::InvestorTimeByMarket);
    assert_eq!(flows.len(), 3, "업종 둘과 종합 하나");
    assert!(flows.iter().all(|s| s.get("FID_INPUT_ISCD") == "0001"));
}

fn flow_day_handler(days: Vec<KstDate>) -> impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static {
    move |sent| {
        if sent.is(KisApiId::IndexChart) {
            let rows: Vec<Value> = days.iter().map(|d| json!({"stck_bsop_date": d.yyyymmdd(), "bstp_nmix_prpr": "2700.00", "acml_tr_pbmn": "20000000"})).collect();
            return ok(json!({"rt_cd": "0", "output1": {}, "output2": rows}).to_string());
        }
        if sent.is(KisApiId::InvestorDailyByMarket) {
            let day = sent.get("FID_INPUT_DATE_1");
            let index = days.iter().position(|d| d.yyyymmdd() == day).expect("요청한 날은 거래일이다") as i64;
            let row = json!({"stck_bsop_date": day, "prsn_ntby_tr_pbmn": format!("{}", index * 15_050), "frgn_ntby_tr_pbmn": format!("-{}", index * 100), "orgn_ntby_tr_pbmn": "500"});
            return ok(json!({"rt_cd": "0", "output": [row]}).to_string());
        }
        if sent.is(KisApiId::ProgramDaily) {
            let rows: Vec<Value> = days.iter().map(|d| json!({"stck_bsop_date": d.yyyymmdd(), "arbt_smtn_ntby_tr_pbmn": "10000", "nabt_smtn_ntby_tr_pbmn": "-25000"})).collect();
            return ok(json!({"rt_cd": "0", "output": rows}).to_string());
        }
        route(sent)
    }
}

#[tokio::test]
async fn the_twenty_day_flow_is_filled_from_three_trs_and_the_amounts_are_in_eok() {
    let mut days = weekdays_back_from(monday(), 25);
    days.reverse();
    let h = Harness::start(at(10, 0, 0), flow_day_handler(days.clone())).await;
    let body = h.ok("/api/market-overview/flow?market=kospi&period=20").await;
    assert_eq!(body["period"], "20");
    let investors = body["investors"]["value"].as_array().unwrap();
    assert_eq!(investors.len(), 20);
    let kept = &days[days.len() - 20..];
    assert_eq!(investors.iter().map(|d| d["date"].as_str().unwrap().replace('-', "")).collect::<Vec<_>>(), kept.iter().map(|d| d.yyyymmdd()).collect::<Vec<_>>());
    assert_eq!(investors[0]["institutionEok"], 5, "500백만원은 5억원이다");
    let index_of_first = (days.len() - 20) as i64;
    assert_eq!(investors[0]["individualEok"], json!(((index_of_first * 15_050) as f64 / 100.0).round() as i64), "백만원 값을 100으로 나눠 가까운 억원으로 맞춘다");
    assert_eq!(investors[0]["foreignEok"], json!(((-index_of_first * 100) as f64 / 100.0).round() as i64));
    let program = body["program"]["value"].as_array().unwrap();
    assert_eq!(program.len(), 20);
    assert_eq!(program[19], json!({"date": "2026-11-09", "arbitrageEok": 100.0, "nonArbitrageEok": -250.0, "totalEok": -150.0}));
    assert_eq!(h.kis.sent_to(KisApiId::IndexChart).len(), 1);
    assert_eq!(h.kis.sent_to(KisApiId::ProgramDaily).len(), 1);
    let per_day = h.kis.sent_to(KisApiId::InvestorDailyByMarket);
    assert_eq!(per_day.len(), 20);
    assert!(per_day.iter().all(|s| s.get("FID_INPUT_DATE_1") == s.get("FID_INPUT_DATE_2") && s.get("FID_INPUT_ISCD_1") == "KSP" && s.get("FID_INPUT_ISCD") == "0001"));
    assert_eq!(KisApiId::InvestorDailyByMarket.tr_id(), "FHPTJ04040000");
    assert_eq!(KisApiId::ProgramDaily.tr_id(), "FHPPG04600001");
    assert_eq!(KisApiId::IndexChart.tr_id(), "FHKUP03500100");
    let turnover = h.ok("/api/market-overview/turnover?market=kospi&period=5").await;
    assert_eq!(turnover["days"]["value"][0]["tradeValueEok"], 200_000.0, "20000000백만원은 20만억원이다");
}

#[tokio::test]
async fn an_investor_day_that_lands_after_the_overview_source_changed_is_not_cached() {
    let mut days = weekdays_back_from(monday(), 25);
    days.reverse();
    let h = Harness::start(at(10, 0, 0), flow_day_handler(days)).await;
    let (arrived, gate) = h.kis.hold_next(KisApiId::InvestorDailyByMarket);
    let request = Request::get("/api/market-overview/flow?market=kospi&period=20").body(Body::empty()).unwrap();
    let slow = tokio::spawn(h.app.clone().oneshot(request));
    arrived.notified().await;
    h.state.market_overview.choose(Some(h.source.clone() as Arc<dyn OverviewSource>));
    gate.add_permits(1);
    assert_eq!(slow.await.unwrap().unwrap().status().as_u16(), 200);
    let per_day = || h.kis.sent_to(KisApiId::InvestorDailyByMarket).len();
    assert_eq!(per_day(), 20);
    h.ok("/api/market-overview/flow?market=kospi&period=20").await;
    assert_eq!(per_day(), 40, "받는 쪽이 바뀌기 전에 시작한 요청의 지난날 행은 캐시에 남지 않는다");
    h.ok("/api/market-overview/flow?market=kospi&period=20").await;
    assert_eq!(per_day(), 41, "바뀐 뒤 받은 지난날 행은 캐시에서 쓰고 오늘 행만 다시 묻는다");
}

#[tokio::test]
async fn an_intraday_sample_that_lands_after_the_overview_source_changed_is_not_recorded_and_the_next_minute_continues() {
    let samples = tempfile::tempdir().unwrap();
    let h = Harness::start_sampling(at(9, 59, 30), route, Some(samples.path())).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (arrived, gate) = h.kis.hold_next(KisApiId::InvestorTimeByMarket);
    h.clock.jump(60);
    arrived.notified().await;
    h.state.market_overview.choose(Some(h.source.clone() as Arc<dyn OverviewSource>));
    gate.add_permits(1);
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.minute().await;
    let text = std::fs::read_to_string(samples.path().join("20261109.jsonl")).unwrap();
    let lines: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let at_mark = |mark: KstTime, kind: &str| lines.iter().filter(|line| line["at"] == mark.unix() && line["value"]["kind"] == kind).count();
    assert_eq!((at_mark(at(10, 0, 0), "investors"), at_mark(at(10, 0, 0), "program")), (1, 2), "바뀌는 중 늦게 온 표본 하나는 쌓지 않는다: {text}");
    assert_eq!((at_mark(at(10, 1, 0), "investors"), at_mark(at(10, 1, 0), "program")), (2, 2), "바뀐 뒤 분부터 이어 쌓는다: {text}");
}

#[tokio::test]
async fn the_sampler_asks_the_two_kis_trs_per_market_each_minute_and_writes_the_kiwoom_line_shape() {
    let samples = tempfile::tempdir().unwrap();
    let h = Harness::start_sampling(at(9, 59, 30), route, Some(samples.path())).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.minute().await;
    let investors = h.kis.sent_to(KisApiId::InvestorTimeByMarket);
    let programs = h.kis.sent_to(KisApiId::ProgramToday);
    assert_eq!((investors.len(), programs.len()), (2, 2), "시장마다 한 번씩");
    let mut markets: Vec<_> = investors.iter().map(|s| s.get("FID_INPUT_ISCD").to_owned()).collect();
    markets.sort();
    assert_eq!(markets, ["0001", "1001"]);
    let mut classes: Vec<_> = programs.iter().map(|s| s.get("FID_MRKT_CLS_CODE").to_owned()).collect();
    classes.sort();
    assert_eq!(classes, ["K", "Q"]);
    assert_eq!(KisApiId::InvestorTimeByMarket.tr_id(), "FHPTJ04030000");
    assert_eq!(KisApiId::ProgramToday.tr_id(), "FHPPG04600101");

    let text = std::fs::read_to_string(samples.path().join("20261109.jsonl")).unwrap();
    let lines: Vec<Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(lines.len(), 4);
    let mark = at(10, 0, 0).unix();
    let investor_line = lines.iter().find(|l| l["market"] == "kospi" && l["value"]["kind"] == "investors").unwrap();
    let mut shape = investor_line.clone();
    let received_at = shape.as_object_mut().unwrap().remove("received_at").unwrap().as_i64().unwrap();
    assert!((mark..mark + 60).contains(&received_at), "{received_at}");
    assert_eq!(
        shape,
        json!({"at": mark, "market": "kospi", "value": {"kind": "investors", "individual_eok": -8787, "foreign_eok": 6473, "institution_eok": 1893}}),
        "키움 때 쓰는 줄 모양과 같다"
    );
    let program_line = lines.iter().find(|l| l["market"] == "kosdaq" && l["value"]["kind"] == "program").unwrap();
    assert_eq!(program_line["at"], mark);
    assert_eq!(program_line["value"]["total_million_won"], 345_603);
    assert!(program_line["value"].get("arbitrage_million_won").is_none(), "한투 시간별 프로그램 매매에는 차익·비차익 열이 없다");

    let flow = h.ok("/api/market-overview/flow/intraday?market=kospi").await;
    assert_eq!(flow["points"][0], json!({"at": mark, "individualEok": -8787, "foreignEok": 6473, "institutionEok": 1893, "programEok": 3456.03}));
}

#[tokio::test]
async fn a_minute_one_kis_tr_fails_leaves_only_that_kind_empty() {
    let samples = tempfile::tempdir().unwrap();
    let h = Harness::start_sampling(
        at(9, 59, 30),
        |sent| if sent.is(KisApiId::ProgramToday) { HttpResponse { status: 200, tr_cont: None, body: json!({"rt_cd": "1", "msg_cd": "EGW99999", "msg1": "거절"}).to_string() } } else { route(sent) },
        Some(samples.path()),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.minute().await;
    let body = h.ok("/api/market-overview/flow/intraday?market=kospi").await;
    let point = &body["points"][0];
    assert_eq!((point["individualEok"].as_i64(), point["programEok"].is_null()), (Some(-8787), true));
}

#[tokio::test]
async fn the_kis_feature_set_has_no_streaks_and_the_kiwoom_one_has_it() {
    let h = Harness::start(at(10, 0, 0), route).await;
    let kis = h.source.features();
    assert!(!kis.contains(OverviewFeature::Streaks));
    assert_eq!(kis.iter().collect::<Vec<_>>(), SUPPORTED_OVERVIEW_FEATURES.to_vec());
    assert!(KiwoomOverview::new(KiwoomHandle::absent()).features().contains(OverviewFeature::Streaks));
    for feature in OverviewFeature::ALL.into_iter().filter(|f| *f != OverviewFeature::Streaks) {
        assert!(kis.contains(feature), "{feature:?}");
    }
    let refused = h.source.streaks(StreakSide::Buying, server::api::Market::Kospi, Priority::Screen).await.unwrap_err();
    assert!(refused.to_string().contains("시장 개요 연속 매매"), "{refused}");
    let card = h.ok("/api/market-overview/streaks?market=kospi").await;
    assert_eq!((card["buying"]["status"].as_str(), card["buying"]["error"]["reason"].as_str()), (Some("failed"), Some("unsupported_by_source")));
    assert_eq!(h.kis.total(), 0, "받을 수 없는 칸은 요청을 보내지 않는다");
}

const NET_SHARES: &str = "/api/symbols/005930/investor-net-shares?from=2026-11-05&to=2026-11-09";

#[tokio::test]
async fn during_the_session_today_comes_from_the_estimate_tr_and_is_marked_estimated() {
    let h = Harness::start(at(10, 0, 0), route).await;
    let body = h.ok(NET_SHARES).await;
    let days = body["days"].as_array().unwrap();
    assert_eq!(days.iter().map(|d| d["day"].as_str().unwrap()).collect::<Vec<_>>(), ["2026-11-05", "2026-11-06", "2026-11-09"]);
    let today = &days[2];
    assert_eq!((today["foreign"].as_i64(), today["institution"].as_i64()), (Some(250), Some(-80)), "가장 늦게 채워진 입력 구분(2)의 값이다");
    assert_eq!(body["estimatedDays"], json!(["2026-11-09"]));
    assert_eq!((days[1]["foreign"].as_i64(), days[1]["institution"].as_i64()), (Some(-1500), Some(60)));
    assert_eq!(h.kis.sent_to(KisApiId::InvestorEstimate).len(), 1);
    assert_eq!(h.kis.sent_to(KisApiId::InvestorEstimate)[0].get("MKSC_SHRN_ISCD"), SAMSUNG);
    let confirmed = h.kis.sent_to(KisApiId::StockInvestorDaily);
    assert_eq!(confirmed.len(), 1);
    assert_eq!((confirmed[0].get("FID_COND_MRKT_DIV_CODE"), confirmed[0].get("FID_INPUT_ISCD"), confirmed[0].get("FID_INPUT_DATE_1")), ("J", SAMSUNG, "20261109"));
    assert_eq!(KisApiId::InvestorEstimate.tr_id(), "HHPTJ04160200");
    assert_eq!(KisApiId::StockInvestorDaily.tr_id(), "FHPTJ04160001");
}

#[tokio::test]
async fn after_the_close_today_is_the_confirmed_row_and_nothing_is_marked() {
    let h = Harness::start(at(16, 0, 0), route).await;
    let body = h.ok(NET_SHARES).await;
    let days = body["days"].as_array().unwrap();
    assert_eq!(days.len(), 3);
    assert_eq!(days[2]["day"], "2026-11-09");
    assert_eq!((days[2]["foreign"].as_i64(), days[2]["institution"].as_i64()), (Some(700), Some(60)), "확정 행이다");
    assert!(body.get("estimatedDays").is_none(), "{body}");
    assert!(h.kis.sent_to(KisApiId::InvestorEstimate).is_empty());
}

#[tokio::test]
async fn a_past_range_never_asks_the_estimate_tr() {
    let h = Harness::start(at(10, 0, 0), route).await;
    let body = h.ok("/api/symbols/005930/investor-net-shares?from=2026-11-05&to=2026-11-06").await;
    assert_eq!(body["days"].as_array().unwrap().len(), 2);
    assert!(body.get("estimatedDays").is_none());
    assert!(h.kis.sent_to(KisApiId::InvestorEstimate).is_empty());
}

#[tokio::test]
async fn foreign_holding_columns_missing_from_the_response_stay_empty_while_net_buying_is_filled() {
    let h = Harness::start(at(16, 0, 0), |sent| if sent.is(KisApiId::CurrentPrice) { ok(fixture("price_without_foreign_holdings.json")) } else { route(sent) }).await;
    let holdings = h.ok("/api/symbols/005930/foreign-holdings?from=2026-11-05&to=2026-11-09").await;
    assert_eq!(holdings["days"], json!([]));
    assert_eq!(holdings["coverage"], json!({"kind": "no_readable_dates"}));
    let net = h.ok(NET_SHARES).await;
    assert_eq!(net["days"][2]["foreign"], 700);
    let sent = h.kis.sent_to(KisApiId::CurrentPrice);
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[0].get("FID_INPUT_ISCD")), ("J", SAMSUNG));
}

#[tokio::test]
async fn the_current_holding_columns_give_one_row_for_the_latest_session_day() {
    let h = Harness::start(at(16, 0, 0), route).await;
    let holdings = h.ok("/api/symbols/005930/foreign-holdings?from=2026-11-05&to=2026-11-09").await;
    assert_eq!(holdings["days"], json!([{"day": "2026-11-09", "shares": 2_999_000_000_u64, "weightPct": 50.25}]));
}

#[tokio::test]
async fn the_kiwoom_handle_is_never_asked_while_a_kis_source_is_chosen() {
    let h = Harness::start(at(10, 0, 0), route).await;
    h.ok("/api/market-overview/index?market=kosdaq").await;
    assert_eq!(h.kis.sent_to(KisApiId::IndexPrice)[0].get("FID_INPUT_ISCD"), "1001");
    assert_eq!(h.kiwoom.requests(), 0);
}
