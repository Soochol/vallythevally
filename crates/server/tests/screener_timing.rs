mod common;

use std::ffi::OsStr;
use std::num::NonZeroU64;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::time::{Duration, Instant};

use common::support::krx::KrxMarket;
use common::{ScriptedTransport, Server};
use domain::{KstDate, Ohlcv, Price, StockCode, Volume, Weekday};
use serde_json::{Value, json};
use server::api::Market;
use server::kiwoom::wire::{MillionWon, ScreenerListing};
use server::screener::memory::Edition;
use server::screener::store::{DayBar, Store, Write};

const STOCKS: usize = 3_960;
const HISTORY_BARS: usize = 1_000;
const QUOTES_PER_CALL: usize = 100;
const QUOTE_CALLS_PER_RUN: usize = STOCKS.div_ceil(QUOTES_PER_CALL);
const QUOTE_REPLY_DELAY: Duration = Duration::from_millis(12);
const LIVE_PER_SECOND_LIMIT: usize = 5;
const LIVE_WINDOW_WITH_MARGIN: Duration = Duration::from_millis(1_050);
const CONCURRENT_JUDGMENTS: [usize; 4] = [1, 2, 4, 8];
const JOIN_SETTLE: Duration = Duration::from_secs(1);
const QUOTE_API: &str = "ka10095";

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn at(day: KstDate, hhmmss: &str) -> String {
    format!("{}{hhmmss}", day.yyyymmdd())
}

fn last_open_days(count: usize, through: KstDate) -> Vec<KstDate> {
    let all: Vec<KstDate> = std::iter::successors(Some(day(2010, 1, 1)), |d| Some(d.add_days(1)))
        .take_while(|d| *d <= through)
        .filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun))
        .collect();
    all[all.len() - count..].to_vec()
}

fn random_walk(seed: u64, days: &[KstDate]) -> Vec<DayBar> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = move |below: u64| {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (state >> 33) % below
    };
    let price = |centi: u64| Price::from_centi(centi).unwrap();
    let mut close = 500_000 + next(5_000_000);
    days.iter()
        .map(|&day| {
            let open = close;
            close = (close * (9_700 + next(601)) / 10_000).max(1_000);
            let high = open.max(close) * (10_000 + next(200)) / 10_000;
            let low = open.min(close) * (10_000 - next(200)) / 10_000;
            let volume = if next(100) == 0 { 0 } else { 1_000 + next(1_000_000) };
            DayBar { day, ohlcv: Ohlcv::try_new(price(open), price(high), price(low), price(close), Volume(volume)).unwrap(), traded: MillionWon(volume * close / 100_000_000) }
        })
        .collect()
}

fn code_of(index: usize) -> String {
    format!("{:05}0", 10_000 + index)
}

fn fill_store(path: &Path, days: &[KstDate]) {
    let store = Store::open(path).unwrap();
    let codes: Vec<StockCode> = (0..STOCKS).map(|i| StockCode::parse(&code_of(i)).unwrap()).collect();
    let listing: Vec<ScreenerListing> = codes
        .iter()
        .enumerate()
        .map(|(i, &code)| ScreenerListing {
            code,
            name: format!("가상{}", code.as_str()),
            listed_on: Some(days[0]),
            excludable_as: vec![],
            market: if i % 2 == 0 { Market::Kospi } else { Market::Kosdaq },
            listed_shares: NonZeroU64::new(10_000_000 + i as u64),
        })
        .collect();
    store.replace_listing(&listing).unwrap();
    store.extend_calendar(days).unwrap();
    for (k, chunk) in codes.chunks(100).enumerate() {
        let writes: Vec<Write> = chunk.iter().enumerate().map(|(i, &code)| Write::Replace { code, bars: random_walk((k * 100 + i) as u64, days) }).collect();
        store.write(&writes).unwrap();
    }
    store.set_last_day(*days.last().unwrap()).unwrap();
}

fn quote_row(code: &str, today: KstDate, close: u64) -> Value {
    let bar = common::support::krx::KrxBar { day: today, open: 100, high: close, low: 90, close, volume: 1_000, traded_million_won: 0, base: 100, adjustment_rate: None };
    common::support::summary::row(code, bar, "100000")
}

fn boot(fake: &ScriptedTransport, dir: &Path, clock_start: &str) -> Server {
    Server::spawn_with(fake, &dir.join("run/server.lock"), dir, &[("VALLY_CLOCK_START", OsStr::new(clock_start))])
}

fn new_high(field: &str, n: u32, m: u32) -> Value {
    json!({"kind": "new_high", "period": "D", "field": field, "n": n, "recentBars": m})
}

fn screen_of(conditions: Vec<Value>) -> Value {
    json!({"id": "S1", "name": "계측 조건식", "markets": [], "exclude": [], "conditions": conditions})
}

fn distinct_screen(variant: usize) -> Value {
    screen_of(vec![new_high("high", 100 + 7 * variant as u32, 5), new_high("volume", 20 + variant as u32, 20)])
}

fn no_condition_screen() -> Value {
    screen_of(vec![])
}

struct Api {
    client: reqwest::Client,
    url: String,
}

impl Api {
    async fn of(server: &Server) -> Api {
        Api { client: reqwest::Client::new(), url: format!("http://{}/api/screener/run", server.addr().await) }
    }

    async fn run(&self, screen: &Value) -> (Duration, u16, Value) {
        let started = Instant::now();
        let resp = self.client.post(&self.url).header("content-type", "application/json").body(screen.to_string()).send().await.unwrap();
        let status = resp.status().as_u16();
        let body: Value = serde_json::from_str(&resp.text().await.unwrap()).unwrap();
        (started.elapsed(), status, body)
    }

    async fn run_ok(&self, screen: &Value) -> (Duration, Value) {
        let (took, status, body) = self.run(screen).await;
        assert_eq!(status, 200, "{body}");
        (took, body)
    }
}

fn quote_calls(fake: &ScriptedTransport) -> usize {
    fake.calls().iter().filter(|call| call.api_id == QUOTE_API).count()
}

fn judging_millis(server: &Server, seen: &mut usize) -> Vec<f64> {
    let all: Vec<f64> = server
        .logs()
        .lines()
        .filter_map(|line| line.split("judging_us=").nth(1)?.split_whitespace().next()?.parse::<f64>().ok())
        .map(|micros| micros / 1_000.0)
        .collect();
    let fresh = all[*seen..].to_vec();
    *seen = all.len();
    fresh
}

fn live_quote_time(calls: usize) -> Duration {
    LIVE_WINDOW_WITH_MARGIN * (calls.div_ceil(LIVE_PER_SECOND_LIMIT) as u32 - 1)
}

fn millis(d: Duration) -> f64 {
    d.as_secs_f64() * 1_000.0
}

#[tokio::test]
#[ignore = "4000종목 계측 벤치마크"]
async fn one_screener_run_splits_into_quote_receiving_and_judging_time() {
    let days = last_open_days(HISTORY_BARS, day(2026, 11, 6));
    let today = *days.last().unwrap();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    std::fs::DirBuilder::new().mode(0o700).create(dir.path().join("run")).unwrap();
    let path = dir.path().join("run/screener.duckdb");
    let stored = days.clone();
    let filling = Instant::now();
    tokio::task::spawn_blocking(move || fill_store(&path, &stored)).await.unwrap();
    eprintln!("[계측] 저장소 {STOCKS}종목 × {HISTORY_BARS}일봉을 {:?}에 채웠다", filling.elapsed());
    let loading_path = dir.path().join("run/screener.duckdb");
    let (loading, edition) = tokio::task::spawn_blocking(move || {
        let store = Store::open(&loading_path).unwrap();
        let started = Instant::now();
        (started, Edition::load(&store).unwrap())
    })
    .await
    .map(|(started, edition)| (started.elapsed(), edition))
    .unwrap();
    eprintln!(
        "[계측] 메모리 판 올리기 {:?}: 종목 {STOCKS} × 일봉 {HISTORY_BARS} = 거래 봉 {}개, 일·주·월봉 열과 종목 표가 쓰는 메모리 {} 바이트({:.1} MiB)",
        loading,
        edition.bar_count(),
        edition.bytes(),
        edition.bytes() as f64 / (1024.0 * 1024.0),
    );
    drop(edition);

    let fake = ScriptedTransport::new();
    fake.set_quote_rows((0..STOCKS).map(|i| quote_row(&code_of(i), today, 100)).collect());
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![] });
    fake.delay(QUOTE_API, QUOTE_REPLY_DELAY);
    let server = boot(&fake, dir.path(), &at(today, "100000"));
    let api = Api::of(&server).await;

    let mut seen = 0;
    let (first, _) = api.run_ok(&no_condition_screen()).await;
    eprintln!("[계측] 서버를 켠 뒤 첫 실행(메모리 판을 올리는 시간이 들 수 있다): {:.0}ms, 서버가 잰 판정 {:?}ms", millis(first), judging_millis(&server, &mut seen));

    let before = quote_calls(&fake);
    let (collecting_probe, probe) = api.run_ok(&no_condition_screen()).await;
    let calls_per_run = quote_calls(&fake) - before;
    assert_eq!(calls_per_run, QUOTE_CALLS_PER_RUN, "실행 한 번의 StockQuotes 호출 수는 종목 수를 {QUOTES_PER_CALL}으로 나눠 올림한 값이다");
    assert_eq!(probe["universe"], json!(STOCKS));
    assert_eq!(probe["missingSummary"], 0);
    let injected = QUOTE_REPLY_DELAY * calls_per_run as u32;
    assert!(collecting_probe >= injected, "주입한 지연 {injected:?}보다 빠를 수 없다: {collecting_probe:?}");
    judging_millis(&server, &mut seen);

    let before = quote_calls(&fake);
    let (judged_run, result) = api.run_ok(&distinct_screen(0)).await;
    assert_eq!(quote_calls(&fake) - before, QUOTE_CALLS_PER_RUN, "연달아 실행하면 다시 받는다. 호출 수가 두 배다");
    assert_eq!(quote_calls(&fake), 3 * QUOTE_CALLS_PER_RUN);
    assert!(result["rows"].as_array().is_some_and(|rows| !rows.is_empty()), "판정이 실제로 돌았다면 맞는 종목이 있다");
    eprintln!(
        "[계측] 종목 {STOCKS}, 실행당 StockQuotes {calls_per_run}회, 응답당 주입 지연 {QUOTE_REPLY_DELAY:?} → 주입 합 {injected:?}, 시세 받기 실측(조건 없는 실행) {:.0}ms, 실전 대기열(TR당 초당 {LIVE_PER_SECOND_LIMIT}, ADR 0035) 기대 시세 받기 {:?}",
        millis(collecting_probe),
        live_quote_time(calls_per_run) + QUOTE_REPLY_DELAY,
    );
    eprintln!("[계측] 판정(조건 2줄, 서버가 잰 시간) = {:?}ms (전체 실행 {:.0}ms)", judging_millis(&server, &mut seen), millis(judged_run));

    for (round, &concurrent) in CONCURRENT_JUDGMENTS.iter().enumerate() {
        let calls_before = quote_calls(&fake);
        api.run_ok(&no_condition_screen()).await;
        judging_millis(&server, &mut seen);
        let held = fake.hold("수집 합류 대기", |call| call.api_id == QUOTE_API);
        let joining = async {
            held.arrived().await;
            tokio::time::sleep(JOIN_SETTLE).await;
            held.release();
        };
        let runs = futures::future::join_all((0..concurrent).map(|i| {
            let screen = distinct_screen(10 * (round + 1) + i);
            let api = &api;
            async move { api.run_ok(&screen).await }
        }));
        tokio::join!(joining, runs);
        let joined_calls = quote_calls(&fake) - calls_before - QUOTE_CALLS_PER_RUN;
        assert_eq!(joined_calls, QUOTE_CALLS_PER_RUN, "동시 {concurrent}개 실행은 수집 작업 하나를 같이 쓴다. StockQuotes는 한 번분만 간다");
        let each = judging_millis(&server, &mut seen);
        assert_eq!(each.len(), concurrent);
        let slowest = each.iter().cloned().fold(0.0, f64::max);
        eprintln!(
            "[계측] 동시 판정 {concurrent}개(같은 수집 결과를 받아 함께 판정을 시작한다): 판정 하나 평균 {:.0}ms(가장 느린 {slowest:.0}ms), 처리량 {:.2}개/초 (= {concurrent} / 가장 느린 판정)",
            each.iter().sum::<f64>() / each.len() as f64,
            concurrent as f64 / (slowest / 1_000.0),
        );
    }
    server.stop().await;

    for (label, clock) in [("장 마감 뒤 20:30", at(today, "203000")), ("휴장 주말 토요일 10:00", at(day(2026, 11, 7), "100000")), ("휴장 월요일 10:00", at(day(2026, 11, 9), "100000"))] {
        let server = boot(&fake, dir.path(), &clock);
        let api = Api::of(&server).await;
        let before = quote_calls(&fake);
        let (took, status, body) = api.run(&no_condition_screen()).await;
        let calls = quote_calls(&fake) - before;
        assert_eq!((status, calls), (200, QUOTE_CALLS_PER_RUN), "{label}에도 지금 코드는 시세를 다시 받는다: {body}");
        eprintln!("[계측] {label}: 상태 {status}, StockQuotes {calls}회, 실측 {:.0}ms, missingSummary {}, asOf {}, 오류 {}", millis(took), body["missingSummary"], body["asOf"], body["error"]);
        server.stop().await;
    }
}
