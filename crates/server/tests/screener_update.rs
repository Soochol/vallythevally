mod common;

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::os::unix::fs::DirBuilderExt;
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

    async fn try_run(&self, screen: &Value) -> (u16, Value) {
        let resp = self.client.post(format!("{}/run", self.base)).header("content-type", "application/json").body(screen.to_string()).send().await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
    }

    async fn run(&self, screen: &Value) -> Value {
        let (status, body) = self.try_run(screen).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn excluded(&self) -> Value {
        let screen = json!({"id": "S1", "name": "고가 1일 신고가", "markets": [], "exclude": [], "conditions": [{"kind": "new_high", "period": "D", "field": "high", "n": 1, "barRange": {"start": 0, "end": 0}}]});
        self.run(&screen).await["excluded"].clone()
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
async fn a_store_left_by_a_schema_version_with_no_upgrade_path_starts_empty() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    for version in [3, 6] {
        let tmp = tempfile::tempdir().unwrap();
        update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;

        let path = tmp.path().join("run/screener.duckdb");
        let other = duckdb::Connection::open(&path).unwrap();
        other.execute("UPDATE store_meta SET schema_version = ?", [version]).unwrap();
        drop(other);

        fake.set_krx_market(market.clone());
        let (server, api) = boot(&fake, tmp.path(), &at(today, "2040")).await;
        assert_eq!(
            api.status().await,
            json!({"lastDay": null, "needDay": wire(day(2026, 11, 5)), "todayAvailable": true, "fullHistory": {"done": 0, "total": 0}, "unconfirmed": 0, "update": null}),
            "스키마 {version}"
        );
        let seen = fake.calls().len();
        api.update(false).await;
        assert_eq!(api.settled().await["fullHistory"], json!({"done": 10, "total": 10}));
        assert_eq!(daily_chains(&fake.calls()[seen..]), first_load(&market), "스키마 {version}: 빈 저장소의 첫 적재를 다시 한다");
        server.stop().await;
    }
}

const SCHEMA_4_STORE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/screener/schema-4.duckdb");

fn screens_across_the_upgrade() -> Vec<Value> {
    let screen = |markets: &[&str], exclude: &[&str], conditions: Vec<Value>| json!({"id": "S1", "name": "업그레이드 확인", "markets": markets, "exclude": exclude, "conditions": conditions});
    let new_high = |period: &str, field: &str, n: u32, m: u32| json!({"kind": "new_high", "period": period, "field": field, "n": n, "barRange": {"start": 0, "end": m - 1}});
    vec![
        screen(&[], &[], vec![new_high("D", "high", 20, 5)]),
        screen(&[], &["etf", "managed"], vec![new_high("W", "close", 4, 4), new_high("D", "volume", 20, 20)]),
        screen(&["kosdaq"], &[], vec![new_high("M", "high", 12, 6)]),
        screen(&["kospi"], &[], vec![json!({"kind": "market_cap", "min": 3_000_000_000_000.0, "max": null})]),
    ]
}

fn schema_4_copy() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::DirBuilder::new().mode(0o700).create(dir.path().join("run")).unwrap();
    std::fs::copy(SCHEMA_4_STORE, dir.path().join("run/screener.duckdb")).unwrap();
    dir
}

fn stored_listing(dir: &Path) -> (i32, Vec<(String, String, Option<u64>)>) {
    let conn = duckdb::Connection::open(dir.join("run/screener.duckdb")).unwrap();
    let version = conn.query_row("SELECT schema_version FROM store_meta", [], |row| row.get(0)).unwrap();
    let mut stmt = conn.prepare("SELECT code, market, listed_shares FROM listed ORDER BY code").unwrap();
    let listed = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().map(Result::unwrap).collect();
    (version, listed)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schema_4_store_keeps_its_daily_bars_and_history_and_is_listed_with_shares_and_markets_by_the_first_start_that_gets_the_stock_list() {
    let fake = FakeKiwoom::start().await;
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    let screens = screens_across_the_upgrade();

    let fresh = tempfile::tempdir().unwrap();
    update_once(&fake, fresh.path(), &market, &at(today, "2030"), false).await;
    let (server, api) = boot(&fake, fresh.path(), &at(today, "2040")).await;
    let mut want = Vec::new();
    for screen in &screens {
        want.push(api.run(screen).await);
    }
    server.stop().await;
    for (screen, result) in screens.iter().zip(&want) {
        assert!(!result["rows"].as_array().unwrap().is_empty(), "견줄 결과에 맞은 종목이 있다: {screen} → {result}");
    }

    let upgraded = schema_4_copy();
    let boot_updating = || {
        let clock = at(today, "2040");
        Server::spawn_with(&fake, &upgraded.path().join("run/server.lock"), upgraded.path(), &[("VALLY_CLOCK_START", OsStr::new(&clock)), ("VALLY_SCREENER_UPDATE_ON_START", OsStr::new("on"))])
    };
    let seen = fake.calls().len();

    fake.delay("ka10099", Duration::from_secs(60));
    let server = boot_updating();
    server.addr().await;
    let logs = server.stop().await;
    assert!(logs.contains("스크리너 저장소를 올립니다"), "종목 목록을 받기 전에 꺼진 시작도 저장소를 스키마 5로 올렸다");
    fake.reset();

    let server = boot_updating();
    let api = Api::of(&server).await;
    let listed = api.wait_for("켤 때 채운 종목 목록", |s| s["fullHistory"]["total"] == 10).await;
    assert_eq!(
        listed,
        json!({"lastDay": wire(today), "needDay": wire(day(2026, 11, 5)), "todayAvailable": false, "fullHistory": {"done": 10, "total": 10}, "unconfirmed": 0, "update": null}),
        "앞 시작이 목록을 받기 전에 꺼졌어도 다음 시작이 목록을 채우고, 다 받은 이력이 그대로다"
    );
    for (screen, want) in screens.iter().zip(&want) {
        assert_eq!(api.run(screen).await, *want, "새로 채운 저장소와 같은 결과다: {screen}");
    }
    for _ in 0..400 {
        if server.logs().contains("목표 관측일까지 차 있어") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(server.logs().contains("목표 관측일까지 차 있어"), "켤 때 저장소가 뒤처졌는지 봤다");
    api.update(false).await;
    assert_eq!(api.settled().await["fullHistory"], json!({"done": 10, "total": 10}));
    let calls = &fake.calls()[seen..];
    assert_eq!((count(calls, "ka10095"), count(calls, "ka10081")), (0, 0), "켤 때도 업데이트할 때도 일봉을 다시 받지 않는다");
    server.stop().await;

    let kept: Vec<(String, String, Option<u64>)> =
        market.stocks.iter().map(|s| (s.code.clone(), if s.market_code == "10" { "kosdaq" } else { "kospi" }.to_owned(), s.listed_shares)).collect();
    assert_eq!(stored_listing(upgraded.path()), (5, kept), "listed에 상장주식수와 시장이 찬다. 상장주식수가 없는 종목은 비워 둔다");
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
        (wire(today), json!({"done": 10, "total": 10}), json!(1), Value::Null),
        "일봉을 주지 않는 종목이 있어도 업데이트가 끝까지 간다. 확인 안 된 종목은 과거 이력 수에 넣지 않는다"
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
        assert_eq!((status["fullHistory"].clone(), status["unconfirmed"].clone()), (json!({"done": 10, "total": 10}), json!(1)), "{round}번째");
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
async fn the_server_starts_an_update_when_its_store_is_behind_the_target_day_and_not_when_it_is_up_to_date() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (yesterday, today) = (day(2026, 11, 5), day(2026, 11, 6));
    update_once(&fake, tmp.path(), &KrxMarket::sample(yesterday).with_daily_withheld(), &at(yesterday, "2030"), false).await;
    let boot_updating = |clock: String| {
        let lock = tmp.path().join("run/server.lock");
        let dir = tmp.path().to_owned();
        let fake = &fake;
        move || Server::spawn_with(fake, &lock, &dir, &[("VALLY_CLOCK_START", OsStr::new(&clock)), ("VALLY_SCREENER_UPDATE_ON_START", OsStr::new("on"))])
    };

    fake.set_krx_market(KrxMarket::sample(today).with_daily_withheld());
    let seen = fake.calls().len();
    let server = boot_updating(at(today, "2030"))();
    let api = Api::of(&server).await;
    let caught_up = api.wait_for("켜자마자 시작한 업데이트의 끝", |s| s["lastDay"] == wire(today) && s["update"].is_null()).await;
    assert_eq!(caught_up["unconfirmed"], json!(1), "{caught_up}");
    assert_eq!(count(&fake.calls()[seen..], "ka10095"), 1, "버튼을 누르지 않아도 뒤처진 하루를 채운다");
    server.stop().await;

    let seen = fake.calls().len();
    let server = boot_updating(at(today, "2040"))();
    let api = Api::of(&server).await;
    for _ in 0..400 {
        if count(&fake.calls()[seen..], "ka20006") > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(count(&fake.calls()[seen..], "ka20006"), 1, "켤 때 코스피 일봉으로 목표 관측일을 본다");
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let calls = &fake.calls()[seen..];
    assert_eq!((count(calls, "ka10095"), count(calls, "ka10081")), (0, 0), "목표 관측일까지 찬 저장소는 업데이트하지 않는다. 업데이트했다면 확인 안 된 종목을 다시 확인했다");
    assert_eq!(api.status().await["update"], Value::Null);
    server.stop().await;
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

#[tokio::test(flavor = "multi_thread")]
async fn a_new_full_update_refetches_every_confirmed_history_even_after_kiwoom_kept_withholding_one_history() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let market = KrxMarket::sample(today);
    update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;
    let mut withheld = market.clone();
    withheld.stock_mut(krx::COMMON).daily = DailyAnswer::EmptyRow;
    let every: BTreeMap<String, Vec<Option<String>>> =
        market.stocks.iter().map(|s| (s.code.clone(), if s.code == krx::COMMON { vec![None] } else { whole_history(&s.code, s.bars.len()) })).collect();
    for (round, clock) in [(1, "2040"), (2, "2050")] {
        let (status, calls) = update_once(&fake, tmp.path(), &withheld, &at(today, clock), true).await;
        assert_eq!((status["fullHistory"].clone(), status["unconfirmed"].clone()), (json!({"done": 10, "total": 10}), json!(0)), "{round}번째");
        assert_eq!(daily_chains(&calls), every, "{round}번째 전체 다시 받기도 확인된 모든 종목의 전체 이력을 받는다");
    }

    let (_, calls) = update_once(&fake, tmp.path(), &withheld, &at(today, "2100"), false).await;
    assert_eq!(daily_chains(&calls), BTreeMap::from([(krx::COMMON.to_owned(), vec![None])]), "일반 업데이트는 다시 받지 못한 그 종목만 다시 묻는다");
    let (_, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2110"), false).await;
    assert_eq!(daily_chains(&calls), BTreeMap::from([(krx::COMMON.to_owned(), whole_history_of(&market, krx::COMMON))]), "키움이 다시 주면 그 종목의 전체 이력을 받는다");
    let (_, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2120"), false).await;
    assert_eq!(count(&calls, "ka10081"), 0, "다시 받을 표시가 남지 않는다");
}

#[tokio::test(flavor = "multi_thread")]
async fn full_history_counts_only_confirmed_stocks_so_a_stock_whose_history_was_complete_does_not_push_done_past_total() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (yesterday, today) = (day(2026, 11, 5), day(2026, 11, 6));
    update_once(&fake, tmp.path(), &KrxMarket::sample(yesterday), &at(yesterday, "2030"), false).await;

    let mut market = KrxMarket::sample(today).with_daily_withheld();
    market.stock_mut(krx::COMMON).quoted = false;
    let (status, _) = update_once(&fake, tmp.path(), &market, &at(today, "2030"), false).await;
    assert_eq!(
        (status["fullHistory"].clone(), status["unconfirmed"].clone()),
        (json!({"done": 9, "total": 9}), json!(2)),
        "이력을 다 받아 둔 종목도, 한 번도 받지 못한 종목도 확인 안 됨이면 과거 이력 수에서 뺀다"
    );

    let mut answered = KrxMarket::sample(today).with_daily_withheld();
    answered.stock_mut(krx::DAILY_WITHHELD).daily = DailyAnswer::Bars;
    let (status, _) = update_once(&fake, tmp.path(), &answered, &at(today, "2040"), false).await;
    assert_eq!((status["fullHistory"].clone(), status["unconfirmed"].clone()), (json!({"done": 11, "total": 11}), json!(0)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stock_whose_daily_bars_stop_before_the_target_day_is_logged_and_counted_as_unconfirmed() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let (stored_through, target) = (day(2026, 11, 6), day(2026, 11, 10));
    update_once(&fake, tmp.path(), &KrxMarket::sample(stored_through), &at(stored_through, "2030"), false).await;

    let mut market = KrxMarket::sample(target);
    market.stock_mut(krx::COMMON).daily = DailyAnswer::BarsThrough(stored_through);
    fake.set_krx_market(market);
    let (server, api) = boot(&fake, tmp.path(), &at(target, "2030")).await;
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!((status["lastDay"].clone(), status["unconfirmed"].clone()), (wire(target), json!(1)), "ka10095는 목표일로 답했지만 일봉은 저장된 날까지만 온다");
    let logs = server.stop().await;
    let warned: Vec<&str> = logs.lines().filter(|l| l.contains("확인 안 된 종목이라")).collect();
    assert_eq!(warned.len(), 1, "{logs}");
    assert!(warned[0].contains(krx::COMMON) && warned[0].contains(&target.to_string()), "종목과 목표 관측일을 남긴다: {}", warned[0]);
    assert!(logs.lines().any(|l| l.contains("최근 채우기를 마쳤습니다") && l.contains("unconfirmed=1")), "요약 수에 센다: {logs}");
}

fn stored_days(dir: &Path, code: &str) -> Vec<KstDate> {
    let conn = duckdb::Connection::open(dir.join("run/screener.duckdb")).unwrap();
    let mut stmt = conn.prepare("SELECT strftime(day, '%Y%m%d') FROM daily WHERE code = ? ORDER BY day").unwrap();
    stmt.query_map([code], |row| row.get::<_, String>(0)).unwrap().map(|d| KstDate::parse_yyyymmdd(&d.unwrap()).unwrap()).collect()
}

fn days_without(market: &KrxMarket, code: &str, left_out: KstDate) -> Vec<KstDate> {
    market.stocks.iter().find(|s| s.code == code).unwrap().bars.iter().map(|b| b.day).filter(|d| *d != left_out).collect()
}

fn assert_left_out_row_is_warned(logs: &str, code: &str, left_out: KstDate) {
    let warned: Vec<&str> = logs.lines().filter(|l| l.contains("WARN") && l.contains(code) && l.contains(&left_out.yyyymmdd())).collect();
    assert_eq!(warned.len(), 1, "뺀 행마다 경고 한 줄: {logs}");
    assert!(warned[0].contains("가격이 0"), "이유를 남긴다: {}", warned[0]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_zero_price_row_on_the_first_daily_page_is_left_out_and_the_recent_fill_still_fills_that_stock() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let left_out = day(2026, 10, 15);
    let mut market = KrxMarket::sample(today);
    market.stock_mut(krx::NEW_LISTING).daily = DailyAnswer::ZeroPricesOn(left_out);
    fake.set_krx_market(market.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!(
        (status["lastDay"].clone(), status["fullHistory"].clone(), status["unconfirmed"].clone(), status["update"].clone()),
        (wire(today), json!({"done": 10, "total": 10}), json!(0), Value::Null),
        "가격이 0인 행 하나로 최근 채우기가 멈추지 않는다"
    );
    assert_eq!(daily_chains(&fake.calls()).get(krx::NEW_LISTING), Some(&vec![None]), "1페이지에 다 든 종목이다");
    let logs = server.stop().await;
    assert_left_out_row_is_warned(&logs, krx::NEW_LISTING, left_out);
    assert_eq!(stored_days(tmp.path(), krx::NEW_LISTING), days_without(&market, krx::NEW_LISTING, left_out), "그 행만 빠진다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_zero_price_row_midway_through_a_history_is_left_out_and_the_backfill_finishes_every_stock() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let mut market = KrxMarket::sample(today);
    let bars = &market.stock_mut(krx::PRE_1985).bars;
    assert!(bars.len() > 2 * PAGE_ROWS, "셋째 페이지가 있어야 도중이다");
    let left_out = bars[bars.len() - PAGE_ROWS - PAGE_ROWS / 2].day;
    market.stock_mut(krx::PRE_1985).daily = DailyAnswer::ZeroPricesOn(left_out);
    fake.set_krx_market(market.clone());
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!(
        (status["lastDay"].clone(), status["fullHistory"].clone(), status["unconfirmed"].clone(), status["update"].clone()),
        (wire(today), json!({"done": 10, "total": 10}), json!(0), Value::Null),
        "둘째 페이지의 가격이 0인 행 하나로 과거 이어 받기가 멈추지 않는다"
    );
    assert_eq!(daily_chains(&fake.calls()), first_load(&market), "모든 종목이 cont-yn: N까지 받는다");
    let logs = server.stop().await;
    assert_left_out_row_is_warned(&logs, krx::PRE_1985, left_out);
    assert_eq!(stored_days(tmp.path(), krx::PRE_1985), days_without(&market, krx::PRE_1985, left_out), "그 행만 빠진 채 이력이 다 찬다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stock_whose_daily_pages_never_end_is_skipped_by_the_backfill_and_fetched_again_by_the_next_update() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let mut market = KrxMarket::sample(today);
    market.stock_mut(krx::PRE_1985).daily = DailyAnswer::EndlessPages;
    fake.set_krx_market(market);
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!(
        (status["lastDay"].clone(), status["fullHistory"].clone(), status["update"].clone()),
        (wire(today), json!({"done": 9, "total": 10}), Value::Null),
        "페이지 상한을 넘은 종목만 건너뛰고 업데이트는 끝까지 간다"
    );
    let chains = daily_chains(&fake.calls());
    assert_eq!(chains[krx::PRE_1985].len(), 1 + 100, "최근 1페이지 다음 과거를 100페이지까지 따라간다");
    let logs = server.stop().await;
    assert!(logs.lines().any(|l| l.contains("WARN") && l.contains(krx::PRE_1985) && l.contains("100페이지")), "종목과 이유를 남긴다: {logs}");

    let market = KrxMarket::sample(today);
    let (status, calls) = update_once(&fake, tmp.path(), &market, &at(today, "2040"), false).await;
    assert_eq!(status["fullHistory"], json!({"done": 10, "total": 10}));
    assert_eq!(daily_chains(&calls), BTreeMap::from([(krx::PRE_1985.to_owned(), whole_history_of(&market, krx::PRE_1985))]), "다음 업데이트는 건너뛴 종목만 다시 받는다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kiwoom_failure_midway_through_the_backfill_stops_the_update_and_logs_the_stock_it_was_fetching() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    fake.set_krx_market(KrxMarket::sample(today));
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    fake.respond_with("ka10081", 200, fixture("ka10081_err_1511"));
    let failed = api.settled().await;
    assert_eq!((failed["update"]["phase"].as_str(), failed["update"]["error"]["reason"].as_str()), (Some("backfill"), Some("invalid_request")), "키움 오류는 지금처럼 업데이트를 멈춘다: {failed}");
    let logs = server.stop().await;
    let stopped: Vec<&str> = logs.lines().filter(|l| l.contains("업데이트를 멈춥니다")).collect();
    assert!(!stopped.is_empty() && stopped.iter().all(|l| market_code_in(l)), "멈춘 오류의 로그에 종목 코드가 있다: {logs}");
}

fn market_code_in(line: &str) -> bool {
    KrxMarket::sample(day(2026, 11, 6)).codes().iter().any(|c| line.contains(&format!("code={c}")) || line.contains(&format!("code=\"{c}\"")))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_dt_on_the_newest_daily_row_leaves_out_only_that_row_and_keeps_the_others() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let today = day(2026, 11, 6);
    let mut market = KrxMarket::sample(today);
    market.stocks.retain(|s| s.code == krx::NEW_LISTING);
    let krx::KrxPage::Page { mut body, .. } = krx::respond(&market, "ka10081", &json!({"stk_cd": krx::NEW_LISTING}), None).unwrap() else {
        panic!("가짜 KRX가 일봉 한 페이지로 답한다");
    };
    assert_eq!(body["stk_dt_pole_chart_qry"][0]["dt"], today.yyyymmdd());
    body["stk_dt_pole_chart_qry"][0]["dt"] = json!("");
    fake.set_krx_market(market.clone());
    fake.respond_with("ka10081", 200, body);
    let (server, api) = boot(&fake, tmp.path(), &at(today, "2030")).await;
    api.update(false).await;
    let status = api.settled().await;
    assert_eq!((status["update"].clone(), status["unconfirmed"].clone()), (Value::Null, json!(1)), "목표일 행이 빠져 확인 안 됨이지만 업데이트는 끝까지 간다: {status}");
    let logs = server.stop().await;
    assert_eq!(stored_days(tmp.path(), krx::NEW_LISTING), days_without(&market, krx::NEW_LISTING, today), "빈 dt 행만 빠지고 다른 행은 저장된다");
    assert!(logs.lines().any(|l| l.contains("WARN") && l.contains(krx::NEW_LISTING) && l.contains("dt가 날짜가 아닙니다")), "종목과 이유를 남긴다: {logs}");
}

fn list_loading(status: u16, body: &Value) -> bool {
    status == 503 && body["error"]["reason"] == "symbol_list_loading"
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upgraded_store_whose_first_stock_list_comes_back_empty_refuses_runs_and_updates_until_a_normal_list_arrives() {
    for update_on_start in ["on", "off"] {
        let fake = FakeKiwoom::start().await;
        fake.set_krx_market(KrxMarket::sample(day(2026, 11, 6)));
        fake.respond_with("ka10099", 200, json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "list": []}));
        let upgraded = schema_4_copy();
        let monday_before_07_45 = format!("{}074455", day(2026, 11, 9).yyyymmdd());
        let server = Server::spawn_with(
            &fake,
            &upgraded.path().join("run/server.lock"),
            upgraded.path(),
            &[("VALLY_CLOCK_START", OsStr::new(&monday_before_07_45)), ("VALLY_SCREENER_UPDATE_ON_START", OsStr::new(update_on_start))],
        );
        let api = Api::of(&server).await;
        let screen = &screens_across_the_upgrade()[0];
        let (status, body) = api.try_run(screen).await;
        assert!(list_loading(status, &body), "켤 때 {update_on_start}: 빈 종목 목록으로는 저장소 목록을 채우지 못하니 빈 결과 대신 목록을 받는 중이라고 답한다: {status} {body}");
        api.update(false).await;
        let refused = api.settled().await;
        assert_eq!(refused["update"]["error"]["reason"], "symbol_list_loading", "켤 때 {update_on_start}: 빈 목록으로는 업데이트도 멈춘다: {refused}");
        let (status, body) = api.try_run(screen).await;
        assert!(list_loading(status, &body), "켤 때 {update_on_start}: 멈춘 업데이트 뒤에도 빈 결과를 내지 않는다: {status} {body}");

        fake.reset();
        let search = format!("http://{}/api/symbols?q={}", server.addr().await, krx::COMMON);
        for _ in 0..1_200 {
            if reply(api.client.get(&search).send().await.unwrap()).await.as_array().is_some_and(|found| !found.is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(reply(api.client.get(&search).send().await.unwrap()).await.as_array().map(Vec::len), Some(1), "07:45에 비지 않은 목록을 받았다");
        let result = api.run(screen).await;
        assert_eq!(result["universe"], 10, "켤 때 {update_on_start}: 다음 실행이 받은 목록으로 저장소 목록을 채우고 판정한다: {result}");
        assert!(!result["rows"].as_array().unwrap().is_empty(), "{result}");
        assert_eq!(api.status().await["fullHistory"], json!({"done": 10, "total": 10}));
        if update_on_start == "on" {
            assert!(server.logs().contains("목표 관측일까지 차 있어"), "자동 업데이트가 아니라 실행 관문이 목록을 채웠다");
        }
        assert_eq!((count(&fake.calls(), "ka10095"), count(&fake.calls(), "ka10081")), (0, 0), "켤 때 {update_on_start}: 일봉을 다시 받지 않는다");
        server.stop().await;
        assert_eq!(stored_listing(upgraded.path()).1.len(), 10);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_after_the_stock_list_arrives_but_before_the_start_fills_the_store_listing_fills_it_first_instead_of_answering_empty() {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use server::bars::BarService;
    use server::clock::{Clock, kst};
    use server::config::Secret;
    use server::db::AppDb;
    use server::http::{AppState, router};
    use server::kiwoom::auth::KiwoomAuth;
    use server::kiwoom::rest::{KiwoomRest, Priority};
    use server::kiwoom::stream::KiwoomStream;
    use server::kiwoom::transport::ReqwestTransport;
    use server::market::hub::MarketHub;
    use server::screener::Screener;
    use server::screener::store::Store;
    use server::symbols::SymbolDirectory;
    use tower::ServiceExt;

    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket::sample(day(2026, 11, 6)));
    let upgraded = schema_4_copy();
    let clock = Clock::fake(kst(day(2026, 11, 6), 20, 40, 0));
    let auth = KiwoomAuth::new(Secret::new(common::APP_KEY.into()), Secret::new(common::APP_SECRET.into()), None);
    let rest = KiwoomRest::new(Arc::new(ReqwestTransport::new(fake.base_url()).unwrap()), auth, clock.clone());
    let symbols = Arc::new(SymbolDirectory::default());
    let bars = Arc::new(BarService::new(rest.clone(), symbols.clone(), clock.clone()));
    let store = Store::open(&upgraded.path().join("run/screener.duckdb")).unwrap();
    let screener = Arc::new(Screener::new(store, rest.clone(), bars.clone(), symbols.clone(), clock.clone()));
    let db = AppDb::open(&upgraded.path().join("run/vally.db")).await.unwrap();
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, events) = tokio::sync::mpsc::channel(1);
    let hub = MarketHub::spawn(bars.clone(), stream, events, clock.clone());
    let app = router(Arc::new(AppState { symbols: symbols.clone(), bars, rest: rest.clone(), db, clock, static_dir: upgraded.path().to_owned(), hub, screener }));
    let call = |request: Request<Body>| {
        let app = app.clone();
        async move {
            let response = app.oneshot(request).await.unwrap();
            let status = response.status().as_u16();
            (status, serde_json::from_slice::<Value>(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
        }
    };
    let screen = screens_across_the_upgrade()[0].to_string();
    let run = || Request::post("/api/screener/run").header("content-type", "application/json").body(Body::from(screen.clone())).unwrap();

    let (status, body) = call(run()).await;
    assert!(list_loading(status, &body), "목록을 받기 전의 실행은 목록을 받는 중이라고 답한다: {status} {body}");

    symbols.refresh(&rest, Priority::Screen).await.unwrap();
    let (status, result) = call(run()).await;
    assert_eq!((status, result["universe"].clone()), (200, json!(10)), "목록이 메모리에 들고 저장소 목록은 아직 비어 있을 때의 실행이 먼저 채운다: {result}");
    assert!(!result["rows"].as_array().unwrap().is_empty(), "{result}");
    let (status, summary) = call(Request::get("/api/screener/status").body(Body::empty()).unwrap()).await;
    assert_eq!((status, summary["fullHistory"].clone()), (200, json!({"done": 10, "total": 10})));
    assert_eq!(count(&fake.calls(), "ka10081"), 0);
}
