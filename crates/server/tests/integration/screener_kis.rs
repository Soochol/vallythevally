use crate::common;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::support::kis_server::{KisPeer, archive, master_line};
use common::support::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
use common::{ScriptedTransport, Server};
use domain::{KstDate, Weekday};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::kst;
use server::kis::api::KisApiId;
use server::kis::feed::KisFeedParts;
use server::kis::master::{MasterDownload, MasterError, MasterMarket};
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{DataKind, Header, SnapshotBody, SnapshotRow, write_snapshot};

const NO_KIWOOM_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");
const START: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "start");
const KIS_ENV: [(&str, &str); 4] = [("VALLY_KIS_APP_KEY", "FAKE-KIS-APPKEY-screener-3F8D"), ("VALLY_KIS_APP_SECRET", "FAKE-KIS-SECRET-screener-7H1Q"), ("VALLY_KIS_BASE_URL", "http://127.0.0.1:1"), ("VALLY_KIS_WS_URL", "ws://127.0.0.1:1")];
const KIWOOM_QUOTES: &str = "ka10095";
const STOCKS: usize = 65;
const STORED_CLOSE: u64 = 100;

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn at(day: KstDate, hhmm: &str) -> String {
    format!("{}{hhmm}00", day.yyyymmdd())
}

fn last_open_days(count: usize, through: KstDate) -> Vec<KstDate> {
    let all: Vec<KstDate> = std::iter::successors(Some(day(2010, 1, 1)), |d| Some(d.add_days(1))).take_while(|d| *d <= through).filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)).collect();
    all[all.len() - count..].to_vec()
}

fn code_of(index: usize) -> String {
    format!("{:06}", 300_000 + index)
}

fn stock(index: usize, days: &[KstDate]) -> KrxStock {
    KrxStock {
        code: code_of(index),
        name: format!("가상{index}"),
        market_code: "0".into(),
        company_class_name: String::new(),
        reg_day: days[0],
        audit_info: "정상".into(),
        listed_shares: Some(1_000_000),
        quoted: true,
        daily: DailyAnswer::Bars,
        bars: days.iter().map(|&d| KrxBar { day: d, open: STORED_CLOSE, high: STORED_CLOSE, low: STORED_CLOSE, close: STORED_CLOSE, volume: 1_000, traded_million_won: 0, base: STORED_CLOSE, adjustment_rate: None }).collect(),
    }
}

fn every_stock() -> Value {
    json!({"id": "S1", "name": "시험 조건식", "markets": [], "exclude": [], "conditions": []})
}

fn value_is(field: &str, value: f64) -> Value {
    json!({"id": "S1", "name": "시험 조건식", "markets": [], "exclude": [], "conditions": [{"kind": "value_range", "period": "D", "recentBars": 1, "field": field, "min": value, "max": value}]})
}

fn symbols(result: &Value) -> Vec<String> {
    result["rows"].as_array().unwrap().iter().map(|row| row["symbol"].as_str().unwrap().to_owned()).collect()
}

#[derive(Clone, Copy)]
struct Quote {
    price: u64,
    base: u64,
    open: u64,
    high: u64,
    low: u64,
    volume: u64,
    traded_won: u64,
}

const QUIET: Quote = Quote { price: STORED_CLOSE, base: STORED_CLOSE, open: STORED_CLOSE, high: STORED_CLOSE, low: STORED_CLOSE, volume: 1_000, traded_won: 100_000 };
const ACTIVE: Quote = Quote { price: 120, base: STORED_CLOSE, open: 100, high: 150, low: 90, volume: 3_000, traded_won: 17_400_000 };

fn kis_row(code: &str, quote: Quote) -> Value {
    json!({
        "inter_shrn_iscd": code, "inter_kor_isnm": "가상", "inter2_prpr": quote.price.to_string(), "inter2_sdpr": quote.base.to_string(),
        "inter2_oprc": quote.open.to_string(), "inter2_hgpr": quote.high.to_string(), "inter2_lwpr": quote.low.to_string(),
        "acml_vol": quote.volume.to_string(), "acml_tr_pbmn": quote.traded_won.to_string(),
    })
}

fn kiwoom_row(code: &str, on: KstDate, quote: Quote) -> Value {
    common::support::summary::row(code, KrxBar { day: on, open: quote.open, high: quote.high, low: quote.low, close: quote.price, volume: quote.volume, traded_million_won: quote.traded_won / 1_000_000, base: quote.base, adjustment_rate: None }, "100000")
}

fn market_quotes(active: Quote) -> Vec<Value> {
    (0..STOCKS).map(|i| kis_row(&code_of(i), if i == 0 { active } else { QUIET })).collect()
}

struct FakeKis {
    paths: Mutex<Vec<&'static str>>,
    multi_price_requests: Mutex<Vec<Vec<(String, String)>>>,
    calendar_days: Vec<KstDate>,
    quotes: Mutex<Vec<Value>>,
}

impl FakeKis {
    fn new(calendar_days: Vec<KstDate>, quotes: Vec<Value>) -> Arc<FakeKis> {
        Arc::new(FakeKis { paths: Mutex::default(), multi_price_requests: Mutex::default(), calendar_days, quotes: Mutex::new(quotes) })
    }

    fn sent_to(&self, api: KisApiId) -> usize {
        self.paths.lock().unwrap().iter().filter(|path| **path == api.path()).count()
    }

    fn multi_price_sizes(&self) -> Vec<usize> {
        self.multi_price_requests.lock().unwrap().iter().map(Vec::len).collect()
    }

    fn multi_price_markets(&self) -> Vec<String> {
        self.multi_price_requests.lock().unwrap().iter().flatten().map(|(market, _)| market.clone()).collect()
    }

    fn data_requests(&self) -> usize {
        self.paths.lock().unwrap().iter().filter(|path| !path.starts_with("/oauth2/")).count()
    }

    fn calendar_body(&self) -> String {
        let row = |date: KstDate| json!({"stck_bsop_date": date.yyyymmdd(), "bstp_nmix_prpr": "2705.38", "bstp_nmix_oprc": "2700.00", "bstp_nmix_hgpr": "2710.10", "bstp_nmix_lwpr": "2690.55", "acml_vol": "300"});
        let rows: Vec<Value> = self.calendar_days.iter().rev().copied().map(row).collect();
        json!({"rt_cd": "0", "output2": rows}).to_string()
    }

    fn multi_price_body(&self, req: &HttpRequest) -> String {
        let query: Vec<(String, String)> = req.query.iter().map(|(name, value)| (name.to_string(), value.clone())).collect();
        let asked: Vec<(String, String)> = (1..=30)
            .filter_map(|i| {
                let market = query.iter().find(|(name, _)| *name == format!("FID_COND_MRKT_DIV_CODE_{i}"))?;
                let code = query.iter().find(|(name, _)| *name == format!("FID_INPUT_ISCD_{i}"))?;
                Some((market.1.clone(), code.1.clone()))
            })
            .collect();
        let rows: Vec<Value> = self.quotes.lock().unwrap().iter().filter(|row| asked.iter().any(|(_, code)| row["inter_shrn_iscd"] == json!(code))).cloned().collect();
        self.multi_price_requests.lock().unwrap().push(asked);
        json!({"rt_cd": "0", "msg_cd": "MCA00000", "msg1": "정상처리 되었습니다.", "output": rows}).to_string()
    }
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        self.paths.lock().unwrap().push(req.path);
        let body = match req.path {
            "/oauth2/tokenP" => json!({"access_token": "FAKE-KIS-TOKEN-screener", "expires_in": 86_400}).to_string(),
            "/oauth2/Approval" => json!({"approval_key": "FAKE-KIS-APPROVAL-screener"}).to_string(),
            path if path == KisApiId::IndexChart.path() => self.calendar_body(),
            path if path == KisApiId::MultiPrice.path() => self.multi_price_body(&req),
            _ => json!({"rt_cd": "1", "msg_cd": "EGW99999", "msg1": "시험이 정하지 않은 요청"}).to_string(),
        };
        Box::pin(async move { Ok(HttpResponse { status: 200, tr_cont: None, body }) })
    }
}

struct ListedMaster;

impl MasterDownload for ListedMaster {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>> {
        let lines = match market {
            MasterMarket::Kospi => vec![master_line(market, &code_of(0), "합성 보통주")],
            MasterMarket::Kosdaq => vec![master_line(market, "247540", "합성 코스닥")],
        };
        Box::pin(async move { Ok(archive(&lines)) })
    }
}

struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn of(server: &Server) -> Api {
        Api { client: reqwest::Client::new(), base: format!("http://{}", server.addr().await) }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let request = self.client.request(method, format!("{}{path}", self.base)).header("content-type", "application/json");
        let request = match body {
            Some(body) => request.body(body.to_string()),
            None => request,
        };
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
    }

    async fn run(&self, screen: &Value) -> (u16, Value) {
        self.send(reqwest::Method::POST, "/api/screener/run", Some(screen.clone())).await
    }

    async fn result(&self, screen: &Value) -> Value {
        let (status, body) = self.run(screen).await;
        assert_eq!(status, 200, "{screen} → {body}");
        body
    }

    async fn until_kis_connected(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (_, keys) = self.send(reqwest::Method::GET, "/api/system/kiwoom/keys", None).await;
                if keys["keys"].as_array().is_some_and(|keys| keys.iter().any(|key| key["keyId"] == "env-kis" && key["link"]["state"] == "connected")) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("한투 키가 연결되지 않았다");
    }
}

struct Scene {
    kiwoom: ScriptedTransport,
    kis: Arc<FakeKis>,
    dir: tempfile::TempDir,
    today: KstDate,
    hhmm: &'static str,
    kiwoom_requests_while_preparing: usize,
    kiwoom_quote_calls_while_preparing: usize,
}

impl Scene {
    async fn prepare(today: KstDate, hhmm: &'static str, stored: Vec<KstDate>, calendar: Vec<KstDate>, quotes: Vec<Value>) -> Scene {
        let kiwoom = ScriptedTransport::new();
        kiwoom.set_krx_market(KrxMarket { days: stored.clone(), stocks: (0..STOCKS).map(|i| stock(i, &stored)).collect() });
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
        let first = Server::spawn_with(&kiwoom, &dir.path().join("run/server.lock"), dir.path(), &[("VALLY_CLOCK_START", OsStr::new(&at(*stored.last().unwrap(), "2030")))]);
        let api = Api::of(&first).await;
        api.send(reqwest::Method::POST, "/api/screener/update", Some(json!({"full": false}))).await;
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let (_, status) = api.send(reqwest::Method::GET, "/api/screener/status", None).await;
                if status["update"].is_null() && status["lastDay"] == json!(stored.last().unwrap().to_string()) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("키움으로 저장소를 채우지 못했다");
        first.stop().await;
        kiwoom.reset();
        kiwoom.set_krx_market(KrxMarket { days: calendar.clone(), stocks: vec![] });
        let kiwoom_quote_calls_while_preparing = kiwoom.api_ids().iter().filter(|id| *id == KIWOOM_QUOTES).count();
        Scene { kiwoom_requests_while_preparing: kiwoom.requests(), kiwoom_quote_calls_while_preparing, kiwoom, kis: FakeKis::new(calendar, quotes), dir, today, hhmm }
    }

    fn lock(&self) -> PathBuf {
        self.dir.path().join("run/server.lock")
    }

    fn boot(&self, extra: &[(&str, &OsStr)]) -> Server {
        let clock = at(self.today, self.hhmm);
        let mut overrides: Vec<(&str, &OsStr)> = vec![("VALLY_CLOCK_START", OsStr::new(&clock)), (START.0, OsStr::new(START.1))];
        overrides.extend(KIS_ENV.iter().map(|(key, value)| (*key, OsStr::new(*value))));
        overrides.extend_from_slice(extra);
        let parts = KisFeedParts { connect: KisPeer::default().connect(), master: Arc::new(ListedMaster) };
        Server::spawn_with_kis_feed(&self.kiwoom, Some(self.kis.clone()), Some(parts), &self.lock(), self.dir.path(), &overrides)
    }

    fn boot_without_kiwoom_key(&self, extra: &[(&str, &OsStr)]) -> Server {
        let mut overrides: Vec<(&str, &OsStr)> = vec![(NO_KIWOOM_KEY.0, OsStr::new(NO_KIWOOM_KEY.1))];
        overrides.extend_from_slice(extra);
        self.boot(&overrides)
    }

    fn kiwoom_requests(&self) -> usize {
        self.kiwoom.requests() - self.kiwoom_requests_while_preparing
    }

    fn kiwoom_quote_calls(&self) -> usize {
        self.kiwoom.api_ids().iter().filter(|id| *id == KIWOOM_QUOTES).count() - self.kiwoom_quote_calls_while_preparing
    }
}

fn with_today(stored: &[KstDate], today: KstDate) -> Vec<KstDate> {
    [stored.to_vec(), vec![today]].concat()
}

#[tokio::test]
async fn with_only_a_kis_key_a_run_asks_kis_for_the_calendar_and_thirty_stock_summaries_and_never_calls_kiwoom() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let scene = Scene::prepare(today, "1000", stored.clone(), with_today(&stored, today), market_quotes(ACTIVE)).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let result = api.result(&every_stock()).await;

    assert_eq!(result["asOf"], json!(today.to_string()), "{result}");
    assert_eq!(result["universe"], json!(STOCKS), "{result}");
    assert_eq!(scene.kiwoom_requests(), 0, "키움 transport는 한 번도 불리지 않는다");
    assert!(scene.kis.sent_to(KisApiId::IndexChart) >= 1, "달력은 코스피 지수 일봉이다");
    assert_eq!(scene.kis.multi_price_sizes(), [30, 30, 5], "오늘 요약은 멀티종목 시세 30종목씩이다");
    assert!(scene.kis.multi_price_markets().iter().all(|market| market == "J"), "시장 구분은 J다");
    server.stop().await;
}

#[tokio::test]
async fn an_intraday_kis_row_joins_todays_bar_with_its_open_high_low_close_volume_and_traded_value() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let scene = Scene::prepare(today, "1000", stored.clone(), with_today(&stored, today), market_quotes(ACTIVE)).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    for (field, value) in [("close", 120.0), ("high", 150.0), ("low", 90.0), ("volume", 3_000.0), ("traded_value", 17_000_000.0)] {
        let result = api.result(&value_is(field, value)).await;
        assert_eq!((symbols(&result), result["asOf"].clone()), (vec![code_of(0)], json!(today.to_string())), "{field}: {result}");
    }
    server.stop().await;
}

#[tokio::test]
async fn a_row_received_before_nine_on_the_observation_day_is_no_trades_and_makes_no_bar() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let mut quotes = market_quotes(ACTIVE);
    quotes.iter_mut().find(|row| row["inter_shrn_iscd"] == json!(code_of(1))).unwrap()["inter2_oprc"] = json!("");
    let scene = Scene::prepare(today, "0830", stored.clone(), with_today(&stored, today), quotes).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let overnight = api.result(&value_is("close", 120.0)).await;
    let carried = api.result(&value_is("close", STORED_CLOSE as f64)).await;

    assert!(symbols(&overnight).is_empty(), "09:00 전 한투 값은 오늘 봉이 아니다: {overnight}");
    assert_eq!(symbols(&carried).len(), STOCKS, "저장된 종가가 그대로다: {carried}");
    assert_eq!(carried["missingSummary"], 0, "거래 없음 행은 읽을 수 있는 요약이다: {carried}");
    assert!(scene.kis.multi_price_sizes().len() >= 6, "두 번 실행이 모두 한투로 받았다");
    server.stop().await;
}

#[tokio::test]
async fn on_a_saturday_the_rows_belong_to_the_previous_observation_day_and_are_not_merged_when_the_store_has_it() {
    let saturday = day(2026, 11, 14);
    let stored = last_open_days(20, saturday);
    let friday = *stored.last().unwrap();
    assert_eq!(friday, day(2026, 11, 13));
    let scene = Scene::prepare(saturday, "1000", stored.clone(), stored.clone(), market_quotes(ACTIVE)).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let merged = api.result(&value_is("close", 120.0)).await;
    let stored_only = api.result(&value_is("close", STORED_CLOSE as f64)).await;

    assert!(symbols(&merged).is_empty(), "금요일 봉은 이미 저장소에 있어 한투 행으로 덮지 않는다: {merged}");
    assert_eq!((stored_only["asOf"].clone(), symbols(&stored_only).len(), stored_only["missingSummary"].clone()), (json!(friday.to_string()), STOCKS, json!(0)), "{stored_only}");
    assert!(scene.kis.multi_price_sizes().len() >= 6);
    server.stop().await;
}

#[tokio::test]
async fn missing_duplicate_and_unreadable_rows_are_counted_with_their_reasons() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let mut quotes = market_quotes(ACTIVE);
    quotes.retain(|row| row["inter_shrn_iscd"] != json!(code_of(1)));
    quotes.push(kis_row(&code_of(2), QUIET));
    quotes.iter_mut().find(|row| row["inter_shrn_iscd"] == json!(code_of(3))).unwrap()["acml_vol"] = json!("읽을 수 없음");
    let scene = Scene::prepare(today, "1000", stored.clone(), with_today(&stored, today), quotes).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let result = api.result(&every_stock()).await;

    assert_eq!(result["missingSummary"], 3, "{result}");
    let logs = server.stop().await;
    for reason in ["MissingRow", "DuplicateRow", "Unreadable"] {
        assert!(logs.contains(reason), "{reason}이 로그에 없다");
    }
}

#[tokio::test]
async fn a_kis_base_price_far_from_the_stored_close_blocks_the_run_for_an_adjustment_check() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let adjusted = Quote { base: 60, ..ACTIVE };
    let scene = Scene::prepare(today, "1000", stored.clone(), with_today(&stored, today), market_quotes(adjusted)).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let (status, body) = api.run(&every_stock()).await;

    assert_ne!(status, 200, "{body}");
    assert!(body["error"]["message"].as_str().is_some_and(|message| message.contains("기준가와 확정 이력의 차이가 커") && message.contains(&code_of(0))), "{body}");
    server.stop().await;
}

#[tokio::test]
async fn with_both_a_kiwoom_key_and_kis_connected_the_summary_comes_from_kiwoom_and_kis_is_not_called() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let scene = Scene::prepare(today, "1000", stored.clone(), with_today(&stored, today), market_quotes(ACTIVE)).await;
    scene.kiwoom.set_quote_rows((0..STOCKS).map(|i| kiwoom_row(&code_of(i), today, if i == 0 { ACTIVE } else { QUIET })).collect());
    let server = scene.boot(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let result = api.result(&value_is("close", 120.0)).await;

    assert_eq!(symbols(&result), [code_of(0)], "{result}");
    assert_eq!(scene.kiwoom_quote_calls(), 1, "65종목은 키움 ka10095 한 번에 받는다");
    assert_eq!(scene.kis.data_requests(), 0, "한투 호출 수는 0이다");
    server.stop().await;
}

fn snapshot_row(code: &str, on: KstDate, quote: Quote, traded_at: i64) -> SnapshotRow {
    SnapshotRow { code: code.into(), day: on.yyyymmdd(), current_won: quote.price, base_won: quote.base, open_won: quote.open, high_won: quote.high, low_won: quote.low, volume: quote.volume, traded_million_won: quote.traded_won / 1_000_000, traded_at: Some(traded_at) }
}

#[tokio::test]
async fn with_a_shared_snapshot_and_only_a_kis_key_the_snapshot_judges_and_the_calendar_comes_from_kis() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let scene = Scene::prepare(today, "1000", stored.clone(), with_today(&stored, today), market_quotes(ACTIVE)).await;
    let shared: &Path = &scene.dir.path().join("shared");
    let as_of = kst(today, 10, 0, 0).unix();
    let rows: Vec<SnapshotRow> = (0..STOCKS).map(|i| snapshot_row(&code_of(i), today, if i == 0 { ACTIVE } else { QUIET }, as_of)).collect();
    let header = Header::new(DataKind::SnapshotKrx, today, as_of, as_of, vec![]);
    write_snapshot(shared, header, SnapshotBody { closing: false, requested: STOCKS as u32, missing: 0, stocks: rows, indices: vec![] }).unwrap();
    let server = scene.boot_without_kiwoom_key(&[("VALLY_SHARED_DATA_DIR", shared.as_os_str()), ("VALLY_SHARED_DATA_POLL_MILLIS", OsStr::new("20"))]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (status, body) = api.run(&value_is("close", 120.0)).await;
            if status == 200 && body["collectionStartedAt"] == json!(as_of) {
                return body;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("스냅샷으로 판정한 결과를 보지 못했다");

    assert_eq!(symbols(&result), [code_of(0)], "{result}");
    assert!(scene.kis.sent_to(KisApiId::IndexChart) >= 1, "달력만 한투로 받는다");
    assert_eq!(scene.kis.sent_to(KisApiId::MultiPrice), 0, "공용 스냅샷이 있으면 멀티종목 시세를 받지 않는다");
    assert_eq!(scene.kiwoom_requests(), 0);
    server.stop().await;
}

#[tokio::test]
async fn while_today_is_unknown_after_nine_kis_rows_get_no_day_and_none_is_guessed_as_a_holiday_or_a_trading_day() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let scene = Scene::prepare(today, "1000", stored.clone(), stored.clone(), market_quotes(ACTIVE)).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let result = api.result(&value_is("close", 120.0)).await;

    assert_eq!((symbols(&result).len(), result["missingSummary"].clone()), (0, json!(STOCKS)), "{result}");
    assert!(server.stop().await.contains("DayUnknown"));
}

#[tokio::test]
async fn while_today_is_unknown_before_nine_kis_rows_are_still_readable_as_no_trades() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let scene = Scene::prepare(today, "0830", stored.clone(), stored.clone(), market_quotes(ACTIVE)).await;
    let server = scene.boot_without_kiwoom_key(&[]);
    let api = Api::of(&server).await;
    api.until_kis_connected().await;

    let result = api.result(&value_is("close", STORED_CLOSE as f64)).await;

    assert_eq!((symbols(&result).len(), result["missingSummary"].clone(), result["asOf"].clone()), (STOCKS, json!(0), json!(stored.last().unwrap().to_string())), "{result}");
    server.stop().await;
}
