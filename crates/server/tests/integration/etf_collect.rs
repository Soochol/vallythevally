use crate::common;

use std::collections::HashMap;
use std::ffi::OsStr;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use common::support::krx::{self, KrxMarket, KrxStock};
use common::{ScriptedTransport, Server};
use domain::KstDate;
use serde_json::{Value, json};

const COLLECTED_ONCE: Duration = Duration::from_millis(600);
const SPACING: Duration = Duration::from_millis(500);

const DAY_ONE: &str = "2026-11-19";
const DAY_TWO: &str = "2026-11-20";

const SEMICONDUCTOR: &str = "091160";
const AUTOMOBILE: &str = "091180";
const BANK: &str = "091170";
const MACHINERY: &str = "102960";
const SECURITIES: &str = "102970";
const CONSTRUCTION: &str = "117700";
const STEEL: &str = "117680";
const NOT_LISTED: &str = "117460";

enum Reply {
    Body(String),
    Status(u16),
}

#[derive(Default)]
struct NaverFake {
    calls: Mutex<Vec<(String, Instant)>>,
    replies: Mutex<HashMap<String, Reply>>,
    served: Mutex<HashMap<String, String>>,
}

impl NaverFake {
    fn reply(&self, code: &str, reply: Reply) {
        self.replies.lock().unwrap().insert(code.into(), reply);
    }

    fn ok(&self, code: &str, as_of: &str, day: Day) {
        self.reply(code, Reply::Body(rows(code, as_of, day)));
    }

    fn codes_called(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(code, _)| code.clone()).collect()
    }

    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

async fn components(State(fake): State<Arc<NaverFake>>, Path(code): Path<String>) -> Response {
    fake.calls.lock().unwrap().push((code.clone(), Instant::now()));
    let replies = fake.replies.lock().unwrap();
    match replies.get(&code) {
        Some(Reply::Body(body)) => {
            fake.served.lock().unwrap().insert(code, body.clone());
            ([("content-type", "application/json; charset=utf-8")], body.clone()).into_response()
        }
        Some(Reply::Status(status)) => StatusCode::from_u16(*status).unwrap().into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Clone, Copy)]
enum Day {
    One,
    Two,
}

fn rows(code: &str, as_of: &str, day: Day) -> String {
    let (first, second, cash) = match day {
        Day::One => ("60.00", "39.00", "0.40"),
        Day::Two => ("55.00", "44.00", "0.50"),
    };
    rows_with(code, as_of, &[("005930", "삼성전자", first, "100.0000"), ("9ZZ999", "수집종목", second, "50.0000")], cash)
}

fn rows_with(code: &str, as_of: &str, stocks: &[(&str, &str, &str, &str)], cash: &str) -> String {
    let count = (stocks.len() + 1).to_string();
    let mut rows: Vec<Value> = stocks
        .iter()
        .map(|(stock, name, weight, quantity)| json!({"itemCode": code, "componentIsinCode": "KR7000000001", "componentItemCode": stock, "componentCount": count, "cuUnitQuantity": quantity, "componentName": name, "weight": weight, "referenceDate": as_of}))
        .collect();
    rows.push(json!({"itemCode": code, "componentIsinCode": "KRD010010001", "componentItemCode": null, "componentCount": count, "cuUnitQuantity": "-1000.0000", "componentName": "원화현금", "weight": cash, "referenceDate": as_of}));
    serde_json::to_string(&rows).unwrap()
}

fn listed_market(etfs: &[&str]) -> KrxMarket {
    let mut market = KrxMarket::sample(KstDate::new(2026, 11, 19).unwrap());
    let template = market.stocks.iter().find(|s| s.code == krx::ETF).unwrap().clone();
    market.stocks.retain(|s| s.code != krx::ETF);
    market.stocks.extend(etfs.iter().map(|code| KrxStock { code: (*code).into(), name: format!("가상ETF{code}"), ..template.clone() }));
    market
}

struct Rig {
    naver: Arc<NaverFake>,
    naver_base: String,
    kiwoom: ScriptedTransport,
    tmp: tempfile::TempDir,
    server: Option<Server>,
    client: reqwest::Client,
    base: String,
}

impl Rig {
    async fn new(etfs: &[&str]) -> Rig {
        let naver = Arc::new(NaverFake::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let naver_base = format!("http://{}", listener.local_addr().unwrap());
        let router = axum::Router::new().route("/api/domestic/detail/{code}/ETFComponent", get(components)).with_state(naver.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let kiwoom = ScriptedTransport::new();
        kiwoom.set_krx_market(listed_market(etfs));
        for market_sample in ["ka10051", "ka90005"] {
            kiwoom.respond_with(market_sample, 500, json!({"return_code": 1, "return_msg": "이 시험은 장중 표본을 쓰지 않는다"}));
        }
        Rig { naver, naver_base, kiwoom, tmp: tempfile::tempdir().unwrap(), server: None, client: reqwest::Client::new(), base: String::new() }
    }

    async fn start(&mut self, clock_start: &str) {
        let server = Server::spawn_with(&self.kiwoom, &self.tmp.path().join("run/server.lock"), self.tmp.path(), &[("VALLY_CLOCK_START", OsStr::new(clock_start)), ("VALLY_NAVER_BASE_URL", OsStr::new(&self.naver_base))]);
        self.base = format!("http://{}", server.addr().await);
        self.server = Some(server);
    }

    async fn stop(&mut self) {
        self.server.take().unwrap().stop().await;
    }

    fn jump(&self, secs: i64) {
        self.server.as_ref().unwrap().clock().jump(secs);
    }

    fn pdf_file(&self, day: &str, name: &str) -> PathBuf {
        self.tmp.path().join("run/etf-pdf/pdf").join(day.replace('-', "")).join(name)
    }

    async fn get(&self, path: &str) -> Value {
        let response = self.client.get(format!("{}{path}", self.base)).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200, "{path}");
        serde_json::from_str(&response.text().await.unwrap()).unwrap()
    }

    async fn fund(&self, code: &str) -> Value {
        self.get(&format!("/api/etf/funds/{code}")).await
    }

    async fn status(&self, code: &str) -> Value {
        self.fund(code).await["fund"]["status"].clone()
    }

    async fn holdings(&self, code: &str) -> Vec<(String, u64)> {
        self.fund(code).await["holdings"].as_array().unwrap().iter().map(|h| (h["code"].as_str().unwrap().to_owned(), h["weightBps"].as_u64().unwrap())).collect()
    }

    async fn until<F: Future<Output = bool>>(&self, what: &str, mut condition: impl FnMut() -> F) {
        for _ in 0..400 {
            if condition().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("{what}: 40초 안에 이뤄지지 않았습니다. 서버 로그: {}", self.server.as_ref().map(Server::logs).unwrap_or_default());
    }

    async fn until_collected_as_of(&self, codes: &[&str], as_of: &str) {
        self.until(&format!("{codes:?}이 {as_of} 기준으로 수집됨"), || async {
            for code in codes {
                let status = self.status(code).await;
                if status["source"] != "collected" || status["holdingsAsOf"] != as_of {
                    return false;
                }
            }
            true
        })
        .await;
    }
}

fn gaps(fake: &NaverFake) -> Vec<Duration> {
    let calls = fake.calls.lock().unwrap();
    calls.windows(2).map(|pair| pair[1].1.duration_since(pair[0].1)).collect()
}

#[tokio::test]
async fn schedule_fetches_each_etf_once_spaced_and_stores_by_date() {
    let etfs = [AUTOMOBILE, BANK, SEMICONDUCTOR];
    let mut rig = Rig::new(&etfs).await;
    for code in etfs {
        rig.naver.ok(code, DAY_ONE, Day::One);
    }
    rig.start("20261119110000").await;

    tokio::time::sleep(COLLECTED_ONCE).await;
    assert_eq!(rig.naver.count(), 0, "정한 시각 전에는 부르지 않는다");

    rig.jump(70 * 60);
    rig.until_collected_as_of(&etfs, DAY_ONE).await;
    tokio::time::sleep(COLLECTED_ONCE).await;

    let mut expected: Vec<String> = etfs.iter().map(|code| (*code).to_owned()).collect();
    expected.sort();
    assert_eq!(rig.naver.codes_called(), expected, "ETF마다 정확히 한 번, 코드 순서로 부른다");
    assert!(gaps(&rig.naver).iter().all(|gap| *gap >= SPACING), "호출 사이는 0.5초 이상이다: {:?}", gaps(&rig.naver));

    for code in etfs {
        assert_eq!(std::fs::read_to_string(rig.pdf_file(DAY_ONE, &format!("{code}.raw.json"))).unwrap(), rig.naver.served.lock().unwrap()[code], "원본은 받은 그대로 둔다");
        let normalized: Value = serde_json::from_str(&std::fs::read_to_string(rig.pdf_file(DAY_ONE, &format!("{code}.json"))).unwrap()).unwrap();
        assert_eq!(normalized["asOf"], DAY_ONE);
        assert_eq!(normalized["holdings"], json!([{"code": "005930", "name": "삼성전자", "cuQuantity": 100.0, "weightBps": 6000}, {"code": "9ZZ999", "name": "수집종목", "cuQuantity": 50.0, "weightBps": 3900}]));
    }
}

#[tokio::test]
async fn collected_funds_are_served_with_the_collection_source() {
    let mut rig = Rig::new(&[SEMICONDUCTOR, BANK]).await;
    rig.naver.ok(SEMICONDUCTOR, DAY_ONE, Day::One);
    rig.naver.ok(BANK, DAY_ONE, Day::One);
    rig.start("20261119130000").await;
    rig.until_collected_as_of(&[SEMICONDUCTOR, BANK], DAY_ONE).await;

    let detail = rig.fund(SEMICONDUCTOR).await;
    assert_eq!(detail["holdings"].as_array().unwrap().iter().map(|h| (h["code"].as_str().unwrap(), h["weightBps"].as_u64().unwrap(), h["name"].as_str().unwrap())).collect::<Vec<_>>(), [("005930", 6000, "삼성전자"), ("9ZZ999", 3900, "수집종목")]);
    let status = &detail["fund"]["status"];
    assert_eq!((status["source"].as_str(), status["holdingsAsOf"].as_str(), status["refreshFailed"].as_bool()), (Some("collected"), Some(DAY_ONE), Some(false)));
    assert!(status["lastAttemptAt"].as_i64().unwrap() > 0);
    assert_eq!((detail["fund"]["holdingsCount"].as_u64(), detail["fund"]["top5WeightBps"].as_u64()), (Some(2), Some(9900)));

    let list = rig.get("/api/etf/funds").await;
    let listed = list["funds"].as_array().unwrap().iter().find(|f| f["code"] == SEMICONDUCTOR).unwrap();
    assert_eq!(listed["status"]["source"], "collected");
    assert_eq!(listed["holdingsCount"], 2);

    let holders = rig.get("/api/etf/stocks/9ZZ999").await;
    assert_eq!(holders["name"], "수집종목");
    assert_eq!(holders["holders"].as_array().unwrap().iter().map(|h| (h["fund"]["code"].as_str().unwrap(), h["weightBps"].as_u64().unwrap())).collect::<Vec<_>>(), [(SEMICONDUCTOR, 3900), (BANK, 3900)]);

    let untouched = rig.status(NOT_LISTED).await;
    assert_eq!((untouched["source"].as_str(), untouched["holdingsAsOf"].as_str(), untouched["lastAttemptAt"].is_null(), untouched["refreshFailed"].as_bool()), (Some("snapshot"), Some("2026-10-30"), true, Some(false)), "수집하지 않은 ETF는 스냅샷 그대로다");
}

#[tokio::test]
async fn a_day_is_not_fetched_twice_even_after_a_restart() {
    let etfs = [BANK, SEMICONDUCTOR];
    let mut rig = Rig::new(&etfs).await;
    for code in etfs {
        rig.naver.ok(code, DAY_ONE, Day::One);
    }
    rig.start("20261119120900").await;
    rig.jump(120);
    rig.until_collected_as_of(&etfs, DAY_ONE).await;
    assert_eq!(rig.naver.count(), 2);

    rig.jump(60 * 60);
    tokio::time::sleep(COLLECTED_ONCE).await;
    assert_eq!(rig.naver.count(), 2, "같은 날 시각이 지나도 다시 받지 않는다");

    rig.stop().await;
    rig.start("20261119140000").await;
    rig.until_collected_as_of(&etfs, DAY_ONE).await;
    tokio::time::sleep(COLLECTED_ONCE).await;
    assert_eq!(rig.naver.count(), 2, "서버를 다시 켜도 그날을 다시 받지 않는다");

    for code in etfs {
        rig.naver.ok(code, DAY_TWO, Day::Two);
    }
    rig.jump(23 * 60 * 60);
    rig.until_collected_as_of(&etfs, DAY_TWO).await;
    assert_eq!(rig.naver.count(), 4, "다음 날은 한 번 더 받는다");
    assert_eq!(rig.holdings(BANK).await, [("005930".to_owned(), 5500), ("9ZZ999".to_owned(), 4400)]);
    assert!(rig.pdf_file(DAY_ONE, &format!("{BANK}.json")).exists(), "지난 날짜 자료는 그대로 남는다");
    assert!(rig.pdf_file(DAY_TWO, &format!("{BANK}.json")).exists());
}

#[tokio::test]
async fn a_server_started_after_the_scheduled_time_collects_that_days_share_once() {
    let etfs = [BANK, SEMICONDUCTOR];
    let mut rig = Rig::new(&etfs).await;
    for code in etfs {
        rig.naver.ok(code, DAY_ONE, Day::One);
    }
    rig.start("20261119183000").await;
    rig.until_collected_as_of(&etfs, DAY_ONE).await;
    tokio::time::sleep(COLLECTED_ONCE).await;
    assert_eq!(rig.naver.count(), 2);
}

#[tokio::test]
async fn a_failed_etf_keeps_its_previous_data_and_reports_a_failed_refresh() {
    let etfs = [AUTOMOBILE, BANK, CONSTRUCTION, MACHINERY, SECURITIES, SEMICONDUCTOR, STEEL];
    let mut rig = Rig::new(&etfs).await;
    for code in etfs {
        rig.naver.ok(code, DAY_ONE, Day::One);
    }
    rig.naver.reply(MACHINERY, Reply::Status(500));
    rig.start("20261119130000").await;
    rig.until(&format!("첫날 {}건 시도", etfs.len()), || async { rig.naver.count() == etfs.len() }).await;
    rig.until_collected_as_of(&[AUTOMOBILE, BANK, CONSTRUCTION, SECURITIES, SEMICONDUCTOR, STEEL], DAY_ONE).await;

    let embedded = server::etf::Catalog::embedded();
    let snapshot_count = embedded.fund(domain::StockCode::parse(MACHINERY).unwrap()).unwrap().holdings.len();
    let never_collected = rig.fund(MACHINERY).await;
    assert_eq!(never_collected["fund"]["status"]["source"], "snapshot", "한 번도 못 받았으면 스냅샷을 보인다");
    assert_eq!(never_collected["fund"]["status"]["refreshFailed"], true);
    assert!(never_collected["fund"]["status"]["lastAttemptAt"].as_i64().unwrap() > 0);
    assert_eq!(never_collected["holdings"].as_array().unwrap().len(), snapshot_count);

    rig.naver.ok(SEMICONDUCTOR, DAY_TWO, Day::Two);
    rig.naver.reply(AUTOMOBILE, Reply::Status(503));
    rig.naver.reply(BANK, Reply::Body("[]".into()));
    rig.naver.reply(SECURITIES, Reply::Body(rows(BANK, DAY_TWO, Day::Two)));
    rig.naver.reply(CONSTRUCTION, Reply::Body(rows_with(CONSTRUCTION, DAY_TWO, &[("005930", "삼성전자", "70.00", "1.0000"), ("9ZZ999", "수집종목", "50.00", "1.0000")], "0.10")));
    rig.naver.reply(STEEL, Reply::Body(rows(STEEL, "2026-11-18", Day::Two)));
    let first_day_calls = rig.naver.count();
    rig.jump(24 * 60 * 60);
    rig.until("둘째 날 7건 시도", || async { rig.naver.count() == first_day_calls + etfs.len() }).await;
    rig.until_collected_as_of(&[SEMICONDUCTOR], DAY_TWO).await;
    rig.until("마지막 ETF의 시도 기록", || async { rig.status(CONSTRUCTION).await["refreshFailed"] == true }).await;

    assert_eq!(rig.status(SEMICONDUCTOR).await["refreshFailed"], false);
    assert_eq!(rig.holdings(SEMICONDUCTOR).await, [("005930".to_owned(), 5500), ("9ZZ999".to_owned(), 4400)]);
    for (code, reason) in [(AUTOMOBILE, "HTTP 오류"), (BANK, "빈 응답"), (SECURITIES, "다른 코드"), (CONSTRUCTION, "비중 합 초과"), (STEEL, "기준일 역행")] {
        let status = rig.status(code).await;
        assert_eq!((status["source"].as_str(), status["holdingsAsOf"].as_str(), status["refreshFailed"].as_bool()), (Some("collected"), Some(DAY_ONE), Some(true)), "{reason}: 이전 자료가 남고 갱신 실패로 보인다");
        assert!(status["lastAttemptAt"].as_i64().unwrap() > 0, "{reason}");
        assert_eq!(rig.holdings(code).await, [("005930".to_owned(), 6000), ("9ZZ999".to_owned(), 3900)], "{reason}: 이전 구성이 그대로다");
        assert!(rig.pdf_file(DAY_ONE, &format!("{code}.json")).exists(), "{reason}: 이전 파일을 지우지 않는다");
        assert!(!rig.pdf_file(DAY_TWO, &format!("{code}.json")).exists(), "{reason}: 검증을 못 넘긴 응답은 저장하지 않는다");
    }
    assert_eq!(rig.status(NOT_LISTED).await["refreshFailed"], false, "서버 종목 목록에 없는 ETF는 건드리지 않는다");
    assert_eq!(rig.get("/api/etf/funds").await["funds"].as_array().unwrap().len(), embedded.funds().len(), "일부가 실패해도 목록은 그대로 나온다");
}

#[tokio::test]
async fn a_run_that_crosses_midnight_still_leaves_the_next_day_its_own_fetch() {
    let etfs = [AUTOMOBILE, BANK, SEMICONDUCTOR];
    let mut rig = Rig::new(&etfs).await;
    for code in etfs {
        rig.naver.ok(code, DAY_ONE, Day::One);
    }
    rig.start("20261119235958").await;
    rig.jump(1);
    rig.until_collected_as_of(&etfs, DAY_ONE).await;
    assert_eq!(rig.naver.count(), 3);
    assert!(rig.status(BANK).await["lastAttemptAt"].as_i64().unwrap() >= 1_795_100_400 - 1, "한 ETF 이상은 자정 뒤에 시도했다");

    for code in etfs {
        rig.naver.ok(code, DAY_TWO, Day::Two);
    }
    rig.jump(12 * 60 * 60 + 11 * 60);
    rig.until_collected_as_of(&etfs, DAY_TWO).await;
    assert_eq!(rig.naver.count(), 6, "둘째 날에도 ETF마다 한 번 부른다");
}
