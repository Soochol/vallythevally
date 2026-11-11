mod common;

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use common::{FakeKiwoom, Server};
use domain::KstDate;
use fake_kiwoom::krx::{self, DailyAnswer, KrxMarket, KrxStock, PAGE_ROWS};
use fake_kiwoom::{Call, fixture};
use serde_json::{Value, json};

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn at(day: KstDate, hhmm: &str) -> String {
    format!("{}{hhmm}00", day.yyyymmdd())
}

fn wire(day: KstDate) -> Value {
    json!(day.to_string())
}

struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn of(server: &Server) -> Api {
        Api { client: reqwest::Client::new(), base: format!("http://{}/api/screener", server.addr().await) }
    }

    async fn status(&self) -> Value {
        reply(self.client.get(format!("{}/status", self.base)).send().await.unwrap()).await
    }

    async fn update(&self, full: bool) -> Value {
        let resp = self.client.post(format!("{}/update", self.base)).header("content-type", "application/json").body(json!({"full": full}).to_string()).send().await.unwrap();
        reply(resp).await
    }

    async fn cancel(&self) -> Value {
        reply(self.client.post(format!("{}/update/cancel", self.base)).send().await.unwrap()).await
    }

    async fn excluded(&self) -> Value {
        let screen = json!({"id": "S1", "name": "고가 1일 신고가", "period": "D", "exclude": [], "conditions": [{"field": "high", "n": 1, "m": 1}]});
        let resp = self.client.post(format!("{}/run", self.base)).header("content-type", "application/json").body(screen.to_string()).send().await.unwrap();
        reply(resp).await["excluded"].clone()
    }

    async fn settled(&self) -> Value {
        for _ in 0..1_200 {
            let status = self.status().await;
            if status["update"].is_null() || !status["update"]["error"].is_null() {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("업데이트가 60초 안에 끝나지 않았습니다: {}", self.status().await);
    }

    async fn wait_for(&self, what: &str, done: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..1_200 {
            let status = self.status().await;
            if done(&status) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("{what}을 60초 동안 보지 못했습니다: {}", self.status().await);
    }
}

async fn reply(resp: reqwest::Response) -> Value {
    let status = resp.status().as_u16();
    let body: Value = serde_json::from_str(&resp.text().await.unwrap()).unwrap();
    assert_eq!(status, 200, "{body}");
    body
}

async fn boot(fake: &FakeKiwoom, dir: &Path, clock_start: &str) -> (Server, Api) {
    let server = Server::spawn_with(fake, &dir.join("run/server.lock"), dir, &[("VALLY_CLOCK_START", OsStr::new(clock_start))]);
    let api = Api::of(&server).await;
    (server, api)
}

fn daily_chains(calls: &[Call]) -> BTreeMap<String, Vec<Option<String>>> {
    let mut chains: BTreeMap<String, Vec<Option<String>>> = BTreeMap::new();
    for c in calls.iter().filter(|c| c.api_id == "ka10081") {
        chains.entry(c.body["stk_cd"].as_str().unwrap().to_owned()).or_default().push(c.next_key.clone());
    }
    chains
}

fn count(calls: &[Call], api_id: &str) -> usize {
    calls.iter().filter(|c| c.api_id == api_id).count()
}

fn whole_history(code: &str, rows: usize) -> Vec<Option<String>> {
    std::iter::once(None).chain((1..rows.div_ceil(PAGE_ROWS)).map(|page| Some(format!("{code}-{page}")))).collect()
}

fn whole_history_of(market: &KrxMarket, code: &str) -> Vec<Option<String>> {
    whole_history(code, market.stocks.iter().find(|s| s.code == code).unwrap().bars.len())
}

fn first_pages(codes: &[&str]) -> BTreeMap<String, Vec<Option<String>>> {
    codes.iter().map(|c| (c.to_string(), vec![None])).collect()
}

async fn update_once(fake: &FakeKiwoom, dir: &Path, market: &KrxMarket, clock_start: &str, full: bool) -> (Value, Vec<Call>) {
    fake.set_krx_market(market.clone());
    let seen = fake.calls().len();
    let (server, api) = boot(fake, dir, clock_start).await;
    api.update(full).await;
    let status = api.settled().await;
    server.stop().await;
    assert!(status["update"].is_null(), "업데이트가 오류 없이 끝나야 한다: {status}");
    (status, fake.calls()[seen..].to_vec())
}

fn first_load(market: &KrxMarket) -> BTreeMap<String, Vec<Option<String>>> {
    market
        .stocks
        .iter()
        .map(|s| {
            let backfill = if s.bars.len() > PAGE_ROWS { whole_history(&s.code, s.bars.len()) } else { vec![] };
            (s.code.clone(), std::iter::once(None).chain(backfill).collect())
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn first_load_fills_every_recent_page_then_follows_each_history_to_cont_yn_n() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    fake.set_krx_market(market.clone());
    let tmp = tempfile::tempdir().unwrap();
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;

    assert_eq!(
        api.status().await,
        json!({"lastDay": null, "needDay": wire(day(2026, 11, 5)), "todayAvailable": true, "fullHistory": {"done": 0, "total": 0}, "unconfirmed": 0, "update": null})
    );
    let started = api.update(false).await;
    assert_eq!(started["update"]["phase"], "symbols", "{started}");
    let finished = api.settled().await;
    assert_eq!(
        finished,
        json!({"lastDay": wire(today), "needDay": wire(day(2026, 11, 5)), "todayAvailable": false, "fullHistory": {"done": 10, "total": 10}, "unconfirmed": 0, "update": null})
    );
    let calls = fake.calls();
    assert_eq!(daily_chains(&calls), first_load(&market), "최근 1페이지 다음에 과거가 덜 찬 종목마다 cont-yn: N까지 따라간다");
    assert_eq!(count(&calls, "ka10095"), 1, "일봉을 받기 전에 10종목을 ka10095 한 번으로 확인한다");
    assert_eq!(count(&calls, "ka10099"), 2, "업데이트는 서버가 켤 때 받은 두 시장의 종목 목록을 쓰고 다시 받지 않는다");
    assert!(market.stocks.iter().any(|s| s.bars.len() > 2 * PAGE_ROWS), "세 페이지에 걸친 이력이 있어야 연속조회를 시험한다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn one_missing_day_is_appended_from_a_single_ka10095_call() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (yesterday, today) = (day(2026, 11, 4), day(2026, 11, 5));
    update_once(&fake, tmp.path(), &KrxMarket::sample(yesterday), &at(yesterday, "2030"), false).await;

    let market = KrxMarket::sample(today);
    let (status, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;
    assert_eq!((status["lastDay"].clone(), status["fullHistory"].clone()), (wire(today), json!({"done": 10, "total": 10})));
    let quotes: Vec<&Call> = calls.iter().filter(|c| c.api_id == "ka10095").collect();
    assert_eq!(quotes.len(), 1, "10종목은 ka10095 한 번이다");
    assert_eq!(quotes[0].body["stk_cd"].as_str().unwrap().split('|').collect::<Vec<_>>(), market.codes(), "KRX 코드로 묻는다");
    assert_eq!(count(&calls, "ka10081"), 0, "하루치는 일봉을 받지 않는다");
}

#[tokio::test(flavor = "multi_thread")]
async fn two_or_more_missing_days_take_one_daily_page_that_agrees_with_the_ka10095_day() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    update_once(&fake, tmp.path(), &KrxMarket::sample(day(2026, 11, 3)), &at(day(2026, 11, 3), "2030"), false).await;
    let (_, appended) = update_once(&fake, tmp.path(), &KrxMarket::sample(day(2026, 11, 4)), &at(day(2026, 11, 4), "2030"), false).await;
    assert_eq!((count(&appended, "ka10095"), count(&appended, "ka10081")), (1, 0));

    let market = KrxMarket::sample(day(2026, 11, 6));
    let (status, calls) = update_once(&fake, tmp.path(), &market, &at(day(2026, 11, 6), "2030"), false).await;
    assert_eq!(status["lastDay"], wire(day(2026, 11, 6)));
    assert_eq!(count(&calls, "ka10095"), 1, "이틀 빠져도 ka10095로 확인만 하고 하루치 덧붙이기는 쓰지 않는다");
    let codes = market.codes();
    assert_eq!(
        daily_chains(&calls),
        first_pages(&codes.iter().map(String::as_str).collect::<Vec<_>>()),
        "종목마다 1페이지만 받는다. 겹친 날(ka10095로 덧붙인 11-04와 거래정지 종목 포함)이 모두 같아 전체를 다시 받지 않는다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stock_ka10095_skips_or_dates_before_the_target_day_is_unconfirmed_without_asking_for_its_daily_bars() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (yesterday, today) = (day(2026, 11, 4), day(2026, 11, 5));
    update_once(&fake, tmp.path(), &KrxMarket::sample(yesterday), &at(yesterday, "2030"), false).await;

    let mut market = KrxMarket::sample(today);
    market.stock_mut(krx::COMMON).quoted = false;
    market.stock_mut(krx::REIT).bars.pop();
    fake.set_krx_market(market);
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    let seen = fake.calls().len();
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!((status["lastDay"].clone(), status["unconfirmed"].clone(), status["update"].clone()), (wire(today), json!(2), Value::Null), "확인된 8종목을 채우고 마지막 관측일을 앞당긴다");
    let calls = &fake.calls()[seen..];
    assert_eq!((count(calls, "ka10095"), count(calls, "ka10081")), (1, 0), "행이 없는 종목과 dt가 목표보다 이른 종목은 일봉을 받지 않는다");
    assert_eq!(api.excluded().await, json!({"listedTooShort": 0, "historyShort": 0, "unconfirmed": 2}), "실행 결과의 확인 안 됨이 상태의 수와 같다");

    fake.set_krx_market(KrxMarket::sample(today));
    let seen = fake.calls().len();
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!((status["lastDay"].clone(), status["unconfirmed"].clone()), (wire(today), json!(0)));
    let calls = &fake.calls()[seen..];
    let quotes: Vec<&str> = calls.iter().filter(|c| c.api_id == "ka10095").map(|c| c.body["stk_cd"].as_str().unwrap()).collect();
    assert_eq!((quotes, count(calls, "ka10081")), (vec!["110020|110070"], 0), "다음 업데이트는 확인 안 된 두 종목만 다시 확인하고 하루치를 덧붙인다");
    assert_eq!(api.excluded().await["unconfirmed"], json!(0));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_split_seen_in_the_overlapping_daily_bars_refetches_that_whole_history() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    update_once(&fake, tmp.path(), &KrxMarket::sample(day(2026, 11, 6)), &at(day(2026, 11, 6), "2030"), false).await;

    let split = KrxMarket::sample(krx::sample_split_day());
    let (status, calls) = update_once(&fake, tmp.path(), &split, &at(krx::sample_split_day(), "2030"), false).await;
    assert_eq!(status["lastDay"], wire(krx::sample_split_day()));
    let mut want = first_pages(&split.codes().iter().map(String::as_str).collect::<Vec<_>>());
    want.get_mut(krx::SPLIT).unwrap().extend(whole_history_of(&split, krx::SPLIT));
    assert_eq!(daily_chains(&calls), want, "11-09·11-10 두 날이 빠져 1페이지를 받고, 분할로 겹친 봉이 다른 종목만 처음부터 끝까지 다시 받는다");

    let later = KrxMarket::sample(day(2026, 11, 12));
    let (_, calls) = update_once(&fake, tmp.path(), &later, &at(day(2026, 11, 12), "2030"), false).await;
    assert_eq!(daily_chains(&calls), first_pages(&later.codes().iter().map(String::as_str).collect::<Vec<_>>()), "다시 받은 이력이 키움의 수정주가와 같다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_base_price_more_than_30_percent_off_the_stored_close_refetches_that_whole_history() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let before = day(2026, 11, 9);
    update_once(&fake, tmp.path(), &KrxMarket::sample(before), &at(before, "2030"), false).await;

    let split = KrxMarket::sample(krx::sample_split_day());
    let (status, calls) = update_once(&fake, tmp.path(), &split, &at(krx::sample_split_day(), "2030"), false).await;
    assert_eq!(status["lastDay"], wire(krx::sample_split_day()));
    assert_eq!(count(&calls, "ka10095"), 1);
    assert_eq!(daily_chains(&calls), BTreeMap::from([(krx::SPLIT.to_owned(), whole_history_of(&split, krx::SPLIT))]), "기준가가 1/5로 바뀐 종목만 전체를 다시 받는다");

    let later = KrxMarket::sample(day(2026, 11, 12));
    let (_, calls) = update_once(&fake, tmp.path(), &later, &at(day(2026, 11, 12), "2030"), false).await;
    assert_eq!(daily_chains(&calls), first_pages(&later.codes().iter().map(String::as_str).collect::<Vec<_>>()), "다시 받은 이력이 키움의 수정주가와 같다");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_keeps_what_was_stored_and_the_next_update_fetches_only_the_rest() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    fake.set_krx_market(market.clone());
    fake.delay("ka10081", Duration::from_millis(300));
    let tmp = tempfile::tempdir().unwrap();
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    let midway = api.wait_for("최근 채우기 중간", |s| s["update"]["phase"] == "recent" && s["update"]["done"].as_u64() >= Some(4)).await;
    let cancelled = api.cancel().await;
    assert_eq!((cancelled["update"].clone(), cancelled["lastDay"].clone()), (Value::Null, Value::Null), "취소하면 업데이트가 멈추고, 최근 채우기를 마치지 않았으니 마지막 관측일은 그대로다");
    tokio::time::sleep(Duration::from_secs(1)).await;
    let settled = fake.calls().len();
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(fake.calls()[settled..], [], "취소한 뒤에는 키움에 더 묻지 않는다");
    assert_eq!(api.status().await["update"], Value::Null);

    let stored = midway["update"]["done"].as_u64().unwrap() as usize;
    let seen = fake.calls().len();
    fake.reset();
    api.update(false).await;
    let finished = api.settled().await;
    assert_eq!((finished["lastDay"].clone(), finished["fullHistory"].clone()), (wire(today), json!({"done": 10, "total": 10})));
    let chains = daily_chains(&fake.calls()[seen..]);
    let mut first_pages_again = 0;
    for stock in &market.stocks {
        let backfill = if stock.bars.len() > PAGE_ROWS { whole_history(&stock.code, stock.bars.len()) } else { vec![] };
        let recent_and_backfill: Vec<Option<String>> = std::iter::once(None).chain(backfill.clone()).collect();
        let chain = chains.get(&stock.code).cloned().unwrap_or_default();
        assert!(chain == backfill || chain == recent_and_backfill, "{}: {chain:?}", stock.code);
        first_pages_again += usize::from(chain == recent_and_backfill);
    }
    assert!(first_pages_again <= 10 - stored, "취소 전에 저장한 {stored}종목의 최근 1페이지는 다시 받지 않는다: {chains:?}");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_history_cut_off_midway_is_fetched_again_from_its_first_page_and_only_that_one() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    fake.set_krx_market(market.clone());
    let tmp = tempfile::tempdir().unwrap();
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    fake.delay("ka10081", Duration::from_secs(2));
    let cut = format!("{}-1", krx::PRE_1985);
    for _ in 0..400 {
        if fake.calls().iter().any(|c| c.next_key.as_deref() == Some(cut.as_str())) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(fake.calls().iter().any(|c| c.next_key.as_deref() == Some(cut.as_str())), "{} 둘째 페이지를 기다렸다", krx::PRE_1985);
    server.stop().await;
    fake.reset();

    let next_day = day(2026, 11, 9);
    let market = KrxMarket::sample(next_day);
    fake.set_krx_market(market.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(next_day, "2030")).await;
    let restarted = api.status().await;
    assert_eq!(restarted["lastDay"], wire(today), "최근 채우기는 끊기기 전에 끝났다");
    let complete = restarted["fullHistory"]["done"].as_u64().unwrap() as usize;
    let seen = fake.calls().len();
    api.update(false).await;
    let finished = api.settled().await;
    assert_eq!((finished["lastDay"].clone(), finished["fullHistory"].clone()), (wire(next_day), json!({"done": 10, "total": 10})));
    let calls = &fake.calls()[seen..];
    assert_eq!(count(calls, "ka10095"), 1, "다음 관측일은 과거가 덜 찬 종목도 하루치로 덧붙인다");
    let chains = daily_chains(calls);
    assert_eq!(chains.len(), 10 - complete, "다 받은 종목은 다시 받지 않는다: {chains:?}");
    assert_eq!(chains[krx::PRE_1985], whole_history_of(&market, krx::PRE_1985), "끊긴 종목은 하루치를 덧붙인 뒤에도 1페이지부터 끝까지 다시 받는다");
    for (code, chain) in &chains {
        assert_eq!(*chain, whole_history_of(&market, code), "{code}");
    }
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_store_left_by_schema_version_1_starts_empty() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;

    let path = tmp.path().join("run/screener.duckdb");
    let other = duckdb::Connection::open(&path).unwrap();
    other.execute("UPDATE store_meta SET schema_version = 1", []).unwrap();
    drop(other);

    fake.set_krx_market(market.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2040")).await;
    assert_eq!(
        api.status().await,
        json!({"lastDay": null, "needDay": wire(day(2026, 11, 5)), "todayAvailable": true, "fullHistory": {"done": 0, "total": 0}, "unconfirmed": 0, "update": null})
    );
    let seen = fake.calls().len();
    api.update(false).await;
    assert_eq!(api.settled().await["fullHistory"], json!({"done": 10, "total": 10}));
    assert_eq!(daily_chains(&fake.calls()[seen..]), first_load(&market), "빈 저장소의 첫 적재를 다시 한다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn status_shows_each_phase_with_progress_and_the_kiwoom_error_that_stopped_the_update() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    fake.set_krx_market(KrxMarket::sample(today));
    let tmp = tempfile::tempdir().unwrap();
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;

    fake.respond_with("ka10081", 200, fixture("ka10081_err_1511"));
    api.update(false).await;
    let failed = api.settled().await;
    let update = &failed["update"];
    assert_eq!((update["phase"].clone(), update["done"].clone(), update["total"].clone(), update["full"].clone()), (json!("recent"), json!(0), json!(10), json!(false)), "{failed}");
    assert_eq!((update["error"]["code"].as_str(), update["error"]["reason"].as_str()), (Some("internal"), Some("invalid_request")), "{failed}");
    assert!(!update["error"]["message"].as_str().unwrap().is_empty());
    assert_eq!(api.status().await, failed, "오류는 다음 업데이트를 시작할 때까지 남는다");

    fake.reset();
    fake.delay("ka10081", Duration::from_millis(100));
    let started = api.update(false).await;
    assert_eq!((started["update"]["phase"].as_str(), started["update"]["error"].clone()), (Some("symbols"), Value::Null), "다시 시작하면 오류가 지워진다");
    let mut seen = vec![started["update"].clone()];
    loop {
        let status = api.status().await;
        if status["update"].is_null() {
            assert_eq!(status["fullHistory"], json!({"done": 10, "total": 10}));
            break;
        }
        seen.push(status["update"].clone());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let phases: Vec<&str> = seen.iter().map(|u| u["phase"].as_str().unwrap()).collect();
    let mut order = phases.clone();
    order.dedup();
    assert_eq!(order, ["symbols", "recent", "backfill"], "{phases:?}");
    for pair in seen.windows(2) {
        assert!(pair[1]["done"].as_u64() <= pair[1]["total"].as_u64(), "{}", pair[1]);
        if pair[0]["phase"] == pair[1]["phase"] {
            assert!(pair[0]["done"].as_u64() <= pair[1]["done"].as_u64(), "같은 단계에서 진행률은 줄지 않는다: {} → {}", pair[0], pair[1]);
        }
    }
    let recent = seen.iter().rfind(|u| u["phase"] == "recent").unwrap();
    let backfill = seen.iter().rfind(|u| u["phase"] == "backfill").unwrap();
    assert_eq!((recent["total"].as_u64(), backfill["total"].as_u64()), (Some(10), Some(8)), "최근 채우기는 10종목, 과거 이어 받기는 1페이지에 다 들지 않은 8종목");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn before_20_00_the_update_stops_at_the_last_day_before_today() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    fake.set_krx_market(market.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(today, "1500")).await;
    assert_eq!((api.status().await["needDay"].clone(), api.status().await["todayAvailable"].clone()), (wire(day(2026, 11, 5)), json!(false)));
    api.update(false).await;
    let afternoon = api.settled().await;
    assert_eq!((afternoon["lastDay"].clone(), afternoon["todayAvailable"].clone()), (wire(day(2026, 11, 5)), json!(false)), "키움이 준 오늘 봉은 저장하지 않는다");
    server.stop().await;

    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    assert_eq!(api.status().await["todayAvailable"], json!(true), "20:00 뒤에는 오늘을 받을 수 있다");
    let seen = fake.calls().len();
    api.update(false).await;
    let evening = api.settled().await;
    assert_eq!((evening["lastDay"].clone(), evening["todayAvailable"].clone()), (wire(today), json!(false)));
    let calls = &fake.calls()[seen..];
    assert_eq!((count(calls, "ka10095"), count(calls, "ka10081")), (1, 0), "15:00에는 11-05까지만 저장했으니 저녁에는 하루치를 덧붙인다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn starting_while_an_update_runs_returns_its_status_without_starting_another() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    fake.set_krx_market(market.clone());
    fake.delay("ka10081", Duration::from_millis(200));
    let tmp = tempfile::tempdir().unwrap();
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    api.wait_for("최근 채우기", |s| s["update"]["phase"] == "recent").await;
    let again = api.update(true).await;
    assert_eq!((again["update"]["phase"].as_str(), again["update"]["full"].as_bool()), (Some("recent"), Some(false)), "돌고 있는 업데이트의 상태를 돌려준다: {again}");
    api.settled().await;
    assert_eq!(daily_chains(&fake.calls()), first_load(&market), "업데이트는 한 번만 돌았다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_update_fetches_every_history_again_and_a_plain_one_after_it_fetches_nothing() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;

    let (status, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2040"), true).await;
    assert_eq!(status["fullHistory"], json!({"done": 10, "total": 10}));
    let every: BTreeMap<String, Vec<Option<String>>> = market.stocks.iter().map(|s| (s.code.clone(), whole_history(&s.code, s.bars.len()))).collect();
    assert_eq!(daily_chains(&calls), every, "모든 종목의 전체 이력을 다시 받는다");

    let (_, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2050"), false).await;
    assert_eq!(count(&calls, "ka10081") + count(&calls, "ka10095"), 0, "다 받은 저장소에서는 받을 것이 없다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_full_update_is_resumed_by_the_next_plain_update() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;

    let (server, api) = boot(&fake, tmp.path(), &at(today, "2040")).await;
    fake.delay("ka10081", Duration::from_millis(300));
    api.update(true).await;
    let midway = api.wait_for("전체 다시 받기 중간", |s| s["update"]["phase"] == "backfill" && s["update"]["done"].as_u64() >= Some(2)).await;
    assert_eq!((midway["update"]["full"].as_bool(), midway["update"]["total"].as_u64()), (Some(true), Some(10)), "{midway}");
    api.cancel().await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let refetched = midway["update"]["done"].as_u64().unwrap() as usize;

    fake.reset();
    let seen = fake.calls().len();
    let resumed = api.update(false).await;
    assert_eq!(resumed["update"]["full"].as_bool(), Some(false));
    let finished = api.settled().await;
    assert_eq!((finished["update"].clone(), finished["fullHistory"].clone()), (Value::Null, json!({"done": 10, "total": 10})));
    let chains = daily_chains(&fake.calls()[seen..]);
    for (code, chain) in &chains {
        assert_eq!(*chain, whole_history_of(&market, code), "{code}");
    }
    assert!((10 - refetched).saturating_sub(2) <= chains.len() && chains.len() <= 10 - refetched, "일반 업데이트가 취소 전에 다시 받지 못한 종목을 받는다. 취소 전에 {refetched}종목, 이번에 {}종목", chains.len());

    let seen = fake.calls().len();
    api.update(false).await;
    api.settled().await;
    assert_eq!(count(&fake.calls()[seen..], "ka10081"), 0, "다 받은 뒤에는 다시 받을 표시가 남지 않는다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_traded_value_that_differs_on_an_overlapping_day_refetches_that_whole_history() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    update_once(&fake, tmp.path(), &KrxMarket::sample(day(2026, 11, 4)), &at(day(2026, 11, 4), "2030"), false).await;

    let mut market = KrxMarket::sample(day(2026, 11, 6));
    let stored_day = market.stock_mut(krx::COMMON).bars.iter_mut().rev().find(|b| b.day == day(2026, 11, 3)).unwrap();
    stored_day.traded_million_won += 1;
    let (status, calls) = update_once(&fake, tmp.path(), &market, &at(day(2026, 11, 6), "2030"), false).await;
    assert_eq!(status["lastDay"], wire(day(2026, 11, 6)));
    let mut want = first_pages(&market.codes().iter().map(String::as_str).collect::<Vec<_>>());
    want.get_mut(krx::COMMON).unwrap().extend(whole_history_of(&market, krx::COMMON));
    assert_eq!(daily_chains(&calls), want, "저장한 거래대금과 키움의 거래대금이 다른 종목만 전체를 다시 받는다");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_after_a_failed_update_keeps_its_error_until_the_next_start() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    fake.set_krx_market(KrxMarket::sample(today));
    let tmp = tempfile::tempdir().unwrap();
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    fake.respond_with("ka10081", 200, fixture("ka10081_err_1511"));
    api.update(false).await;
    let failed = api.settled().await;
    assert_eq!(failed["update"]["error"]["reason"], "invalid_request", "{failed}");
    assert_eq!(api.cancel().await, failed, "취소는 돌고 있는 업데이트만 멈춘다");
    assert_eq!(api.status().await, failed);

    fake.reset();
    let restarted = api.update(false).await;
    assert_eq!((restarted["update"]["phase"].as_str(), restarted["update"]["error"].clone()), (Some("symbols"), Value::Null), "오류는 다음 시작에서 지워진다");
    api.settled().await;
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_update_asks_for_the_kospi_calendar_behind_chart_requests_that_came_later() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    fake.set_krx_market(market.clone());
    let tmp = tempfile::tempdir().unwrap();
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.status().await;
    let base = format!("http://{}", server.addr().await);
    let charts: Vec<String> = market
        .codes()
        .iter()
        .flat_map(|code| ["period=D", "period=W", "period=M", "period=W&venue=krx", "period=M&venue=krx"].map(|q| format!("{base}/api/bars?symbol={code}&{q}&limit=1")))
        .collect();
    let flood = |urls: &[String]| {
        let client = reqwest::Client::new();
        urls.iter().map(|url| tokio::spawn(client.get(url).send())).collect::<Vec<_>>()
    };

    let is_chart = |c: &Call| matches!(c.api_id.as_str(), "ka10082" | "ka10083") || (c.api_id == "ka10081" && c.body["stk_cd"].as_str().unwrap().ends_with("_AL"));
    let seen = fake.calls().len();
    let earlier = flood(&charts[..20]);
    for _ in 0..400 {
        if fake.calls()[seen..].iter().any(is_chart) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    api.update(false).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let later = flood(&charts[20..40]);
    for chart in earlier.into_iter().chain(later) {
        assert_eq!(chart.await.unwrap().unwrap().status(), 200);
    }
    api.settled().await;

    let calls = &fake.calls()[seen..];
    let calendar = calls.iter().position(|c| c.api_id == "ka20006").expect("업데이트가 코스피 일봉을 받았다");
    let last_chart = calls.iter().rposition(is_chart).unwrap();
    assert_eq!(calls.iter().filter(|c| is_chart(c)).count(), 40);
    assert!(calendar > last_chart, "업데이트를 시작한 뒤 들어온 차트 요청 20개도 먼저 나가고 코스피 일봉은 그 뒤에 나간다(Background): 코스피 {calendar}번째, 마지막 차트 {last_chart}번째");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_listed_stock_kiwoom_gives_no_daily_bars_is_left_unconfirmed_and_filled_by_the_update_after_kiwoom_gives_them() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today).with_daily_withheld();
    fake.set_krx_market(market.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!(
        (status["lastDay"].clone(), status["fullHistory"].clone(), status["unconfirmed"].clone(), status["update"].clone()),
        (wire(today), json!({"done": 10, "total": 11}), json!(1), Value::Null),
        "일봉을 주지 않는 종목이 있어도 업데이트가 끝까지 간다"
    );
    let chains = daily_chains(&fake.calls());
    assert_eq!(chains.get(krx::DAILY_WITHHELD), Some(&vec![None]), "그 종목은 1페이지를 한 번 묻고 과거 이어 받기에서는 묻지 않는다");
    assert_eq!(api.excluded().await, json!({"listedTooShort": 0, "historyShort": 0, "unconfirmed": 1}));
    server.stop().await;

    let next_day = day(2026, 11, 9);
    let mut answered = KrxMarket::sample(next_day).with_daily_withheld();
    answered.stock_mut(krx::DAILY_WITHHELD).daily = DailyAnswer::Bars;
    fake.set_krx_market(answered.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(next_day, "2030")).await;
    let seen = fake.calls().len();
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!(
        (status["lastDay"].clone(), status["fullHistory"].clone(), status["unconfirmed"].clone()),
        (wire(next_day), json!({"done": 11, "total": 11}), json!(0)),
        "다음 업데이트가 다시 확인하고 이번에는 채운다"
    );
    let calls = &fake.calls()[seen..];
    assert_eq!(count(calls, "ka10095"), 1);
    let first_page_then_history: Vec<Option<String>> = std::iter::once(None).chain(whole_history_of(&answered, krx::DAILY_WITHHELD)).collect();
    assert_eq!(daily_chains(calls), BTreeMap::from([(krx::DAILY_WITHHELD.to_owned(), first_page_then_history)]), "다른 종목은 하루치를 덧붙이고 그 종목만 일봉을 받는다");
    assert_eq!(api.excluded().await["unconfirmed"], json!(0));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_stock_answered_with_an_empty_daily_row_or_an_unknown_code_stays_unconfirmed_until_kiwoom_answers_again() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let stored_through = day(2026, 11, 4);
    update_once(&fake, tmp.path(), &KrxMarket::sample(stored_through), &at(stored_through, "2030"), false).await;
    let today = day(2026, 11, 6);
    let mut broken = KrxMarket::sample(today);
    broken.stock_mut(krx::COMMON).daily = DailyAnswer::EmptyRow;
    broken.stock_mut(krx::REIT).daily = DailyAnswer::UnknownCode;
    let (status, _) = update_once(&fake, tmp.path(), &broken, &at(today, "2030"), false).await;
    assert_eq!((status["lastDay"].clone(), status["unconfirmed"].clone()), (wire(today), json!(2)), "키움 오류가 아니라 봉이 없는 답이라 멈추지 않는다");

    let (status, calls) = update_once(&fake, tmp.path(), &KrxMarket::sample(today), &at(today, "2040"), false).await;
    assert_eq!((status["lastDay"].clone(), status["unconfirmed"].clone()), (wire(today), json!(0)));
    let quotes: Vec<&str> = calls.iter().filter(|c| c.api_id == "ka10095").map(|c| c.body["stk_cd"].as_str().unwrap()).collect();
    assert_eq!(quotes, ["110020|110070"], "확인 안 된 두 종목만 다시 확인한다");
    assert_eq!(daily_chains(&calls), first_pages(&[krx::COMMON, krx::REIT]), "두 종목은 1페이지를 다시 받고, 겹친 봉이 같아 전체를 다시 받지 않는다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_update_again_refetches_every_confirmed_history_while_a_stock_stays_unconfirmed() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today).with_daily_withheld();
    let every_confirmed: BTreeMap<String, Vec<Option<String>>> = KrxMarket::sample(today).stocks.iter().map(|s| (s.code.clone(), whole_history(&s.code, s.bars.len()))).collect();
    let withheld_first_page = BTreeMap::from([(krx::DAILY_WITHHELD.to_owned(), vec![None])]);
    update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;
    for (round, clock) in [(1, "2040"), (2, "2050")] {
        let (status, calls) = update_once(&fake, tmp.path(), &market, &at(today, clock), true).await;
        assert_eq!((status["fullHistory"].clone(), status["unconfirmed"].clone()), (json!({"done": 10, "total": 11}), json!(1)), "{round}번째");
        let mut want = every_confirmed.clone();
        want.extend(withheld_first_page.clone());
        assert_eq!(daily_chains(&calls), want, "{round}번째 전체 다시 받기도 확인된 모든 종목의 전체 이력을 받는다");
    }
}

fn listed_from(market: &KrxMarket, code: &str, reg_day: KstDate) -> KrxStock {
    let mut stock = market.stocks.iter().find(|s| s.code == krx::NEW_LISTING).unwrap().clone();
    stock.code = code.into();
    stock.name = "가상상장예정".into();
    stock.reg_day = reg_day;
    stock.bars.retain(|b| b.day >= reg_day);
    stock
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stock_listed_after_the_target_day_is_skipped_without_asking_kiwoom() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (today, listing_day, upcoming) = (day(2026, 11, 6), day(2026, 11, 9), "110100");
    let mut market = KrxMarket::sample(today);
    market.stocks.push(listed_from(&market, upcoming, listing_day));
    let (status, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;
    assert_eq!((status["lastDay"].clone(), status["fullHistory"].clone()), (wire(today), json!({"done": 10, "total": 11})), "상장 전 종목은 오류 없이 건너뛰고 아직 다 받은 것으로 세지 않는다");
    assert!(!daily_chains(&calls).contains_key(upcoming), "상장 전 종목의 일봉은 묻지 않는다");

    let mut listed = KrxMarket::sample(listing_day);
    listed.stocks.push(listed_from(&listed, upcoming, listing_day));
    let (status, calls) = update_once(&fake, tmp.path(), &listed, &at(listing_day, "2030"), false).await;
    assert_eq!((status["lastDay"].clone(), status["fullHistory"].clone()), (wire(listing_day), json!({"done": 11, "total": 11})));
    assert_eq!(daily_chains(&calls).get(upcoming), Some(&vec![None]), "상장일에는 1페이지를 받는다");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_update_lists_the_stocks_the_server_got_at_start_or_at_07_45_without_asking_kiwoom_again() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let friday = day(2026, 11, 6);
    let market = KrxMarket::sample(friday);
    update_once(&fake, tmp.path(), &market, &at(friday, "2030"), false).await;
    let list_calls = |since: usize| count(&fake.calls()[since..], "ka10099");

    let monday = day(2026, 11, 9);
    let seen = fake.calls().len();
    let (server, api) = boot(&fake, tmp.path(), &format!("{}074455", monday.yyyymmdd())).await;
    for _ in 0..400 {
        if list_calls(seen) == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(list_calls(seen), 2, "서버를 켤 때 두 시장의 목록을 받는다");
    let relisted = "110100";
    let mut listed = market.clone();
    listed.stocks.push(listed_from(&market, relisted, day(2026, 10, 1)));
    fake.set_krx_market(listed);
    let refreshed = fake.calls().len();
    for _ in 0..1_000 {
        if list_calls(refreshed) == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(list_calls(refreshed), 2, "07:45에 목록을 다시 받는다");

    let seen = fake.calls().len();
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!((status["lastDay"].clone(), status["fullHistory"].clone()), (wire(friday), json!({"done": 11, "total": 11})), "07:45에 받은 목록에 새로 든 종목도 채운다");
    let calls = &fake.calls()[seen..];
    assert_eq!(list_calls(seen), 0, "업데이트는 종목 목록을 다시 받지 않는다");
    assert_eq!(daily_chains(calls), BTreeMap::from([(relisted.to_owned(), vec![None])]));
    server.stop().await;
}
