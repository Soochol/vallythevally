mod common;

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use common::{FakeKiwoom, Server};
use domain::KstDate;
use fake_kiwoom::krx::{self, KrxMarket, PAGE_ROWS};
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
        json!({"lastDay": null, "needDay": wire(day(2026, 11, 5)), "todayAvailable": true, "fullHistory": {"done": 0, "total": 0}, "update": null})
    );
    let started = api.update(false).await;
    assert_eq!(started["update"]["phase"], "symbols", "{started}");
    let finished = api.settled().await;
    assert_eq!(
        finished,
        json!({"lastDay": wire(today), "needDay": wire(day(2026, 11, 5)), "todayAvailable": false, "fullHistory": {"done": 10, "total": 10}, "update": null})
    );
    let calls = fake.calls();
    assert_eq!(daily_chains(&calls), first_load(&market), "최근 1페이지 다음에 과거가 덜 찬 종목마다 cont-yn: N까지 따라간다");
    assert_eq!(count(&calls, "ka10095"), 0, "빈 저장소에는 하루치 덧붙일 종목이 없다");
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
    assert_eq!(count(&calls, "ka10095"), 0, "이틀 빠지면 하루치 덧붙이기를 쓰지 않는다");
    let codes = market.codes();
    assert_eq!(
        daily_chains(&calls),
        first_pages(&codes.iter().map(String::as_str).collect::<Vec<_>>()),
        "종목마다 1페이지만 받는다. 겹친 날(ka10095로 덧붙인 11-04와 거래정지 종목 포함)이 모두 같아 전체를 다시 받지 않는다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stock_ka10095_does_not_answer_for_the_target_day_falls_back_to_its_first_daily_page() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (yesterday, today) = (day(2026, 11, 4), day(2026, 11, 5));
    update_once(&fake, tmp.path(), &KrxMarket::sample(yesterday), &at(yesterday, "2030"), false).await;

    let mut market = KrxMarket::sample(today);
    market.stock_mut(krx::COMMON).quoted = false;
    market.stock_mut(krx::REIT).bars.pop();
    let (status, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;
    assert_eq!(status["lastDay"], wire(today));
    assert_eq!(count(&calls, "ka10095"), 1);
    assert_eq!(daily_chains(&calls), first_pages(&[krx::COMMON, krx::REIT]), "행이 없는 종목과 dt가 목표가 아닌 종목만 1페이지를 받는다");
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
async fn a_store_with_another_schema_version_starts_empty() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;

    let path = tmp.path().join("run/screener.duckdb");
    let other = duckdb::Connection::open(&path).unwrap();
    other.execute("UPDATE store_meta SET schema_version = schema_version + 1", []).unwrap();
    drop(other);

    fake.set_krx_market(market.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2040")).await;
    assert_eq!(
        api.status().await,
        json!({"lastDay": null, "needDay": wire(day(2026, 11, 5)), "todayAvailable": true, "fullHistory": {"done": 0, "total": 0}, "update": null})
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
