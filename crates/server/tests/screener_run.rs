mod common;

use std::ffi::OsStr;
use std::num::NonZeroU64;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::time::{Duration, Instant};

use common::{FakeKiwoom, Server};
use domain::{KstDate, Ohlcv, Price, StockCode, Volume, Weekday};
use fake_kiwoom::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
use indicators::{Columns, LineId, MaMethod, Spec, ValidSpec};
use serde_json::{Value, json};
use server::api::Market;
use server::kiwoom::wire::{MillionWon, ScreenerListing};
use server::screener::store::{DayBar, Store, Write};

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn at(day: KstDate, hhmm: &str) -> String {
    format!("{}{hhmm}00", day.yyyymmdd())
}

fn open_days(from: KstDate, through: KstDate, closed: &[KstDate]) -> Vec<KstDate> {
    std::iter::successors(Some(from), |d| Some(d.add_days(1)))
        .take_while(|d| *d <= through)
        .filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) && !closed.contains(d))
        .collect()
}

fn fortnight() -> Vec<KstDate> {
    open_days(day(2026, 10, 19), day(2026, 11, 6), &[])
}

fn last_open_days(count: usize, through: KstDate) -> Vec<KstDate> {
    let all = open_days(day(2010, 1, 1), through, &[]);
    all[all.len() - count..].to_vec()
}

fn bar(day: KstDate, price: u64, volume: u64) -> KrxBar {
    KrxBar { day, open: price, high: price, low: price, close: price, volume, traded_million_won: price * volume / 1_000_000, base: price, adjustment_rate: None }
}

fn priced(days: &[KstDate], price: impl Fn(usize) -> u64) -> Vec<KrxBar> {
    days.iter().enumerate().map(|(i, &d)| bar(d, price(i), 1_000)).collect()
}

fn stock(code: &str, bars: Vec<KrxBar>) -> KrxStock {
    KrxStock {
        code: code.into(),
        name: format!("가상{code}"),
        market_code: "0".into(),
        company_class_name: String::new(),
        reg_day: bars[0].day,
        audit_info: "정상".into(),
        listed_shares: Some(1_000_000),
        quoted: true,
        daily: DailyAnswer::Bars,
        bars,
    }
}

fn new_high(period: &str, field: &str, n: u32, m: u32) -> Value {
    json!({"kind": "new_high", "period": period, "field": field, "n": n, "recentBars": m})
}

fn new_low(period: &str, field: &str, n: u32, m: u32) -> Value {
    json!({"kind": "new_low", "period": period, "field": field, "n": n, "recentBars": m})
}

fn value_range(period: &str, m: u32, field: &str, min: Option<f64>, max: Option<f64>) -> Value {
    json!({"kind": "value_range", "period": period, "recentBars": m, "field": field, "min": min, "max": max})
}

fn change(period: &str, m: u32, back: u32, min_pct: Option<f64>, max_pct: Option<f64>) -> Value {
    json!({"kind": "change", "period": period, "recentBars": m, "back": back, "minPct": min_pct, "maxPct": max_pct})
}

fn near_extreme(period: &str, m: u32, extreme: &str, n: u32, within_pct: f64) -> Value {
    json!({"kind": "near_extreme", "period": period, "recentBars": m, "extreme": extreme, "n": n, "withinPct": within_pct})
}

fn surge(period: &str, m: u32, field: &str, n: u32, times: f64) -> Value {
    json!({"kind": "surge", "period": period, "recentBars": m, "field": field, "n": n, "times": times})
}

fn market_cap(min: Option<f64>, max: Option<f64>) -> Value {
    json!({"kind": "market_cap", "min": min, "max": max})
}

fn every(conditions: Vec<Value>) -> Value {
    lines(conditions, &[])
}

fn candle(day: KstDate, [open, high, low, close]: [u64; 4], volume: u64) -> KrxBar {
    KrxBar { day, open, high, low, close, volume, traded_million_won: close * volume / 1_000_000, base: close, adjustment_rate: None }
}

fn lines(conditions: Vec<Value>, markets: &[&str]) -> Value {
    json!({"id": "S1", "name": "시험 조건식", "markets": markets, "exclude": [], "conditions": conditions})
}

fn screen(period: &str, conditions: &[(&str, u32, u32)], exclude: &[&str]) -> Value {
    let conditions: Vec<Value> = conditions.iter().map(|&(field, n, m)| new_high(period, field, n, m)).collect();
    json!({"id": "S1", "name": "시험 조건식", "markets": [], "exclude": exclude, "conditions": conditions})
}

fn daily(conditions: &[(&str, u32, u32)]) -> Value {
    screen("D", conditions, &[])
}

fn hit(code: &str, day: KstDate) -> String {
    format!("{code} {day}")
}

fn hits(result: &Value) -> Vec<String> {
    result["rows"].as_array().unwrap().iter().map(|r| format!("{} {}", r["symbol"].as_str().unwrap(), r["matchedDate"].as_str().unwrap())).collect()
}

fn row<'a>(result: &'a Value, code: &str) -> &'a Value {
    result["rows"].as_array().unwrap().iter().find(|r| r["symbol"] == code).unwrap_or_else(|| panic!("{code}가 결과에 없습니다: {result}"))
}

fn price_and_change(result: &Value, code: &str) -> (Value, Value) {
    let r = row(result, code);
    (r["close"].clone(), r["changeRate"].clone())
}

fn excluded(listed_too_short: u32, history_short: u32) -> Value {
    json!({"listedTooShort": listed_too_short, "historyShort": history_short, "unconfirmed": 0})
}

struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn of(server: &Server) -> Api {
        Api { client: reqwest::Client::new(), base: format!("http://{}/api/screener", server.addr().await) }
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let resp = self.client.post(format!("{}/{path}", self.base)).header("content-type", "application/json").body(body.to_string()).send().await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
    }

    async fn status(&self) -> Value {
        let resp = self.client.get(format!("{}/status", self.base)).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        serde_json::from_str(&resp.text().await.unwrap()).unwrap()
    }

    async fn update(&self) {
        assert_eq!(self.post("update", json!({"full": false})).await.0, 200);
    }

    async fn cancel(&self) {
        assert_eq!(self.post("update/cancel", json!({})).await.0, 200);
    }

    async fn wait_for(&self, what: &str, done: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..2_400 {
            let status = self.status().await;
            if done(&status) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("{what}을 60초 동안 보지 못했습니다: {}", self.status().await);
    }

    async fn settled(&self) -> Value {
        let status = self.wait_for("업데이트 끝", |s| s["update"].is_null() || !s["update"]["error"].is_null()).await;
        assert!(status["update"].is_null(), "업데이트가 오류 없이 끝나야 한다: {status}");
        status
    }

    async fn run(&self, screen: &Value) -> (u16, Value) {
        self.post("run", screen.clone()).await
    }

    async fn result(&self, screen: &Value) -> Value {
        let (status, body) = self.run(screen).await;
        assert_eq!(status, 200, "{screen} → {body}");
        body
    }
}

fn boot(fake: &FakeKiwoom, dir: &Path, clock_start: &str) -> Server {
    Server::spawn_with(fake, &dir.join("run/server.lock"), dir, &[("VALLY_CLOCK_START", OsStr::new(clock_start))])
}

struct Loaded {
    _fake: FakeKiwoom,
    _dir: tempfile::TempDir,
    _server: Server,
    api: Api,
}

async fn loaded(market: KrxMarket) -> Loaded {
    let today = *market.days.last().unwrap();
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(market);
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    let status = api.settled().await;
    assert_eq!(status["lastDay"], json!(today.to_string()), "{status}");
    Loaded { _fake: fake, _dir: dir, _server: server, api }
}

#[tokio::test(flavor = "multi_thread")]
async fn equal_values_are_new_highs_and_zero_volume_or_missing_days_are_skipped_in_ranges_and_n() {
    let days = fortnight();
    let equal = stock("200010", priced(&days, |_| 100));
    let halted = stock("200020", days.iter().enumerate().map(|(i, &d)| if i <= 11 { bar(d, 89 + i as u64, 1_000) } else { bar(d, 100, 0) }).collect());
    let gap = stock(
        "200030",
        days.iter().enumerate().filter(|(i, _)| *i != 13).map(|(i, &d)| bar(d, match i { 11 => 300, 12 => 200, 14 => 250, _ => 100 }, 1_000)).collect(),
    );
    let session = loaded(KrxMarket { days: days.clone(), stocks: vec![equal, halted, gap] }).await;
    let api = &session.api;

    let today = api.result(&daily(&[("high", 5, 1)])).await;
    assert_eq!((today["asOf"].clone(), today["universe"].clone(), today["excluded"].clone()), (json!(days[14].to_string()), json!(3), excluded(0, 0)));
    assert_eq!(hits(&today), [hit("200010", days[14]), hit("200020", days[11])], "같은 값도 가장 큰 값이다. 거래정지 날과 빠진 날의 봉은 없다");
    assert_eq!(
        hits(&api.result(&daily(&[("high", 5, 3)])).await),
        [hit("200010", days[14]), hit("200020", days[11]), hit("200030", days[11])],
        "무거래 날을 건너뛴 마지막 세 봉에서 이전 신고가도 찾는다"
    );
    assert_eq!(
        hits(&api.result(&daily(&[("high", 5, 4)])).await),
        [hit("200010", days[14]), hit("200020", days[11]), hit("200030", days[11])],
        "정지 전 마지막 거래일과 빠진 날 앞의 고점은 최근 4일 안의 신고가다"
    );
    assert_eq!(
        hits(&api.result(&daily(&[("high", 3, 2)])).await),
        [hit("200010", days[14]), hit("200020", days[11])],
        "실제 세 봉에는 빠진 날 앞의 고점 300이 남아 있으므로 250은 신고가가 아니다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_listing_shorter_than_the_longest_n_is_counted_as_listed_too_short() {
    let days = fortnight();
    let session = loaded(KrxMarket {
        days: days.clone(),
        stocks: vec![stock("200010", priced(&days, |_| 100)), stock("200020", priced(&days[10..], |_| 100)), stock("200030", priced(&days[11..], |_| 100))],
    })
    .await;
    let api = &session.api;

    let five = api.result(&daily(&[("high", 5, 1)])).await;
    assert_eq!((five["universe"].clone(), five["excluded"].clone()), (json!(3), excluded(1, 0)));
    assert_eq!(hits(&five), [hit("200010", days[14]), hit("200020", days[14])], "상장한 날부터 5칸이면 5일 신고가를 따질 수 있다");

    let six = api.result(&daily(&[("high", 5, 1), ("volume", 6, 1)])).await;
    assert_eq!((six["excluded"].clone(), hits(&six)), (excluded(2, 0), vec![hit("200010", days[14])]), "조건 가운데 가장 큰 n으로 센다");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unfilled_history_is_history_short_until_backfill_and_a_pre_1985_listing_then_starts_at_its_first_stored_bar() {
    let days = last_open_days(700, day(2026, 11, 6));
    let today = days[699];
    let mut pre_1985 = stock("200010", priced(&days, |_| 100));
    pre_1985.reg_day = day(1976, 3, 24);
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![pre_1985, stock("200020", priced(&days[670..], |_| 100))] });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    fake.delay("ka10081", Duration::from_millis(300));
    api.update().await;
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    api.cancel().await;
    let cut = api.status().await;
    assert_eq!((cut["lastDay"].clone(), cut["fullHistory"].clone()), (json!(today.to_string()), json!({"done": 1, "total": 2})), "최근 600관측일만 받은 채 멈췄다");

    let cases = [((600, 1), excluded(1, 0), vec![hit("200010", today)]), ((601, 1), excluded(1, 1), vec![]), ((500, 101), excluded(1, 0), vec![hit("200010", today)]), ((500, 102), excluded(1, 1), vec![])];
    for ((n, m), want_excluded, want_hits) in cases {
        let result = api.result(&daily(&[("high", n, m)])).await;
        assert_eq!((result["excluded"].clone(), hits(&result)), (want_excluded, want_hits), "n={n}, m={m}: 필요한 첫 칸은 T−(m−1)−(n−1)이다");
    }
    let capped = api.result(&every(vec![market_cap(Some(0.0), None)])).await;
    assert_eq!((capped["excluded"].clone(), hits(&capped)), (excluded(0, 0), vec![hit("200010", today), hit("200020", today)]), "시가총액만 있는 조건식은 과거가 덜 찬 종목도 따진다");

    fake.reset();
    api.update().await;
    assert_eq!(api.settled().await["fullHistory"], json!({"done": 2, "total": 2}));
    for (n, want_excluded, want_hits) in [(601, excluded(1, 0), vec![hit("200010", today)]), (700, excluded(1, 0), vec![hit("200010", today)]), (701, excluded(2, 0), vec![])] {
        let result = api.result(&daily(&[("high", n, 1)])).await;
        assert_eq!((result["excluded"].clone(), hits(&result)), (want_excluded, want_hits), "n={n}: 1976년 상장이어도 시작 칸은 저장된 첫 봉이다");
    }
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn weekly_and_monthly_cells_count_the_unfinished_current_one_and_skip_holidays() {
    let closed = [day(2026, 10, 9), day(2026, 10, 12), day(2026, 10, 13), day(2026, 10, 14), day(2026, 10, 15), day(2026, 10, 16)];
    let days = open_days(day(2026, 9, 7), day(2026, 11, 4), &closed);
    let on = |d: KstDate, m: u8, dd: u8| (d.month(), d.day()) == (m, dd);
    let weekly = stock(
        "200010",
        days.iter()
            .map(|&d| {
                let price = if on(d, 10, 20) { 300 } else if on(d, 10, 30) { 200 } else if on(d, 11, 3) { 250 } else if on(d, 11, 4) { 220 } else { 100 };
                bar(d, price, 1_000)
            })
            .collect(),
    );
    let summed = stock(
        "200020",
        days.iter()
            .enumerate()
            .map(|(i, &d)| {
                let volume = if on(d, 10, 30) { 600 } else if d >= day(2026, 11, 2) { 400 } else { 100 };
                bar(d, 10_000 - i as u64, volume)
            })
            .collect(),
    );
    let session = loaded(KrxMarket { days, stocks: vec![weekly, summed] }).await;
    let api = &session.api;

    let this_week = api.result(&screen("W", &[("high", 2, 1)], &[])).await;
    assert_eq!(hits(&this_week), [hit("200010", day(2026, 11, 2))], "수요일까지의 이번 주도 한 봉이고, 신고가 날짜는 그 주 월요일이다");
    assert_eq!(price_and_change(&this_week, "200010"), (json!(220.0), json!(-12.0)), "주봉 줄이어도 종가와 등락률은 일봉이다: 11-04 종가 220, 11-03 종가 250 대비");
    assert_eq!(hits(&api.result(&screen("W", &[("high", 3, 1)], &[])).await), Vec::<String>::new(), "휴장한 주는 칸이 아니라 3주 창에 고가 300인 주가 든다");
    assert_eq!(hits(&api.result(&screen("W", &[("volume", 2, 1)], &[])).await), [hit("200020", day(2026, 11, 2))], "주봉 거래량은 일봉 거래량의 합이다");

    let this_month = api.result(&screen("M", &[("close", 2, 1)], &[])).await;
    assert_eq!(hits(&this_month), [hit("200010", day(2026, 11, 1))], "끝나지 않은 이번 달도 한 봉이고, 신고가 날짜는 그달 1일이다");
    assert_eq!(price_and_change(&this_month, "200010"), (json!(220.0), json!(-12.0)), "월봉 줄이어도 등락률은 직전 일봉 종가 250 대비다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_market_holiday_is_not_a_daily_cell() {
    let days = open_days(day(2026, 10, 19), day(2026, 11, 6), &[day(2026, 11, 5)]);
    let (before_holiday, today) = (days.len() - 2, days.len() - 1);
    let ending = |code: &str, high_before_holiday: u64| stock(code, priced(&days, |i| if i == before_holiday { high_before_holiday } else if i == today { 250 } else { 100 }));
    let session = loaded(KrxMarket { days: days.clone(), stocks: vec![ending("200010", 300), ending("200020", 200)] }).await;
    assert_eq!(
        hits(&session.api.result(&daily(&[("high", 2, 1)])).await),
        [hit("200020", days[today])],
        "11-05는 휴장일이라 2일 창이 11-04까지 가고, 11-04 고가 300을 넘지 못한 종목은 빠진다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn conditions_combine_with_and_and_rows_carry_the_first_conditions_last_new_high_sorted_newest_first() {
    let days = fortnight();
    let lone_bar = stock("200050", vec![bar(days[14], 100, 1_000)]);
    let stocks = vec![
        stock("200010", days.iter().enumerate().map(|(i, &d)| bar(d, match i { 12 => 150, 13 => 120, 14 => 110, _ => 100 }, if i == 14 { 5_000 } else { 1_000 })).collect()),
        stock("200020", days.iter().enumerate().map(|(i, &d)| bar(d, if i == 14 { 130 } else { 100 }, if i == 10 { 3_000 } else { 1_000 })).collect()),
        stock("200030", days.iter().enumerate().map(|(i, &d)| match i { 13 => bar(d, 104, 0), 14 => bar(d, 105, 5_000), _ => bar(d, 100, 1_000) }).collect()),
        stock("200040", days.iter().enumerate().map(|(i, &d)| if i == 14 { bar(d, 102, 5_000) } else { bar(d, 100, 1_000) }).collect()),
        lone_bar,
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;

    let both = api.result(&daily(&[("high", 5, 3), ("volume", 5, 1)])).await;
    assert_eq!((both["universe"].clone(), both["excluded"].clone()), (json!(5), excluded(1, 0)));
    assert_eq!(hits(&both), [hit("200030", days[14]), hit("200040", days[14]), hit("200010", days[12])], "두 조건이 다 맞는 종목만, 신고가 날짜 최신순, 같으면 종목코드 순");
    assert_eq!(price_and_change(&both, "200010"), (json!(110.0), json!(-8.33)));
    assert_eq!(price_and_change(&both, "200030"), (json!(105.0), json!(5.0)), "거래량 0인 날을 건너뛴 직전 봉 종가 100 대비다");
    assert_eq!(price_and_change(&both, "200040"), (json!(102.0), json!(2.0)));

    let volume_first = api.result(&daily(&[("volume", 5, 1), ("high", 5, 3)])).await;
    assert_eq!(hits(&volume_first), [hit("200010", days[14]), hit("200030", days[14]), hit("200040", days[14])], "신고가 날짜는 첫 번째 조건의 마지막 후보 봉이다");

    let high_only = api.result(&daily(&[("high", 5, 3)])).await;
    assert_eq!(hits(&high_only), [hit("200020", days[14]), hit("200030", days[14]), hit("200040", days[14]), hit("200010", days[12])]);
    assert_eq!(price_and_change(&high_only, "200020"), (json!(130.0), json!(30.0)));

    let every_bar = api.result(&daily(&[("high", 1, 1)])).await;
    assert_eq!(hits(&every_bar), ["200010", "200020", "200030", "200040", "200050"].map(|c| hit(c, days[14])));
    assert_eq!(price_and_change(&every_bar, "200050"), (json!(100.0), Value::Null), "직전 봉이 없으면 등락률이 없다");
    assert_eq!(row(&every_bar, "200050")["name"], "가상200050");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_traded_value_new_high_runs_and_no_condition_kind_or_market_is_refused_any_more() {
    let days = fortnight();
    let traded = |code: &str, million_won: fn(usize) -> u64| {
        stock(code, days.iter().enumerate().map(|(i, &d)| KrxBar { traded_million_won: million_won(i), ..bar(d, 100, 1_000) }).collect())
    };
    let stocks = vec![
        traded("200010", |i| if i == 14 { 900 } else { 100 }),
        traded("200020", |i| match i { 5..=9 => 350, 12 => 900, _ => 100 }),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;

    assert_eq!(hits(&api.result(&daily(&[("traded_value", 5, 1)])).await), [hit("200010", days[14])], "가격과 거래량이 같아도 거래대금이 가장 큰 봉만 신고거래대금이다");
    assert_eq!(hits(&api.result(&daily(&[("volume", 5, 1)])).await), [hit("200010", days[14]), hit("200020", days[14])]);
    assert_eq!(
        hits(&api.result(&screen("W", &[("traded_value", 2, 1)], &[])).await),
        [hit("200010", day(2026, 11, 2))],
        "주봉 거래대금은 일봉 거래대금의 합이다: 200010은 이번 주 1,300 > 지난주 500, 200020은 이번 주 1,300 < 지난주 1,750"
    );

    let other_kinds = [
        json!({"kind": "ma_position", "period": "D", "recentBars": 1, "field": "close", "method": "sma", "length": 20, "side": "above"}),
        json!({"kind": "ma_alignment", "period": "D", "recentBars": 1, "method": "ema", "lengths": [5, 20], "order": "bullish"}),
        json!({"kind": "ma_cross", "period": "D", "recentBars": 5, "method": "sma", "fast": null, "slow": 20, "direction": "up"}),
        json!({"kind": "rsi", "period": "D", "recentBars": 1, "length": 14, "test": {"kind": "range", "min": null, "max": 30.0}}),
        json!({"kind": "macd", "period": "W", "recentBars": 1, "fast": 12, "slow": 26, "signal": 9, "test": {"kind": "signal_cross", "direction": "up"}}),
        json!({"kind": "stochastic", "period": "D", "recentBars": 1, "k": 5, "d": 3, "smooth": 3, "test": {"kind": "cross", "direction": "down"}}),
        json!({"kind": "bollinger", "period": "M", "recentBars": 1, "length": 20, "k": 2.0, "test": {"kind": "outside", "side": "above"}}),
        json!({"kind": "ichimoku", "period": "D", "recentBars": 1, "conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cloud", "side": "above"}}),
        market_cap(Some(300_000_000_000.0), None),
    ];
    let screens = other_kinds
        .into_iter()
        .map(|line| (line["kind"].to_string(), lines(vec![new_high("D", "high", 5, 1), line], &[])))
        .chain([("시장".to_owned(), lines(vec![new_high("D", "high", 5, 1)], &["kospi"]))]);
    for (case, screen) in screens {
        let (status, body) = api.run(&screen).await;
        assert_eq!(status, 200, "{case}: 실행을 막는 조건 종류나 시장이 없다: {body}");
    }
    let bad_rsi = json!({"kind": "rsi", "period": "D", "recentBars": 1, "length": 14, "test": {"kind": "range", "min": 70.0, "max": 30.0}});
    let (status, body) = api.run(&lines(vec![bad_rsi], &[])).await;
    assert_eq!((status, body["error"]["code"].clone()), (400, json!("bad_request")), "저장과 같은 검사를 실행에도 한다: {body}");
    assert!(!body["error"]["message"].as_str().unwrap().contains("아직"), "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_volume_or_traded_value_high_in_the_last_100_of_200_cells_follows_the_price_new_high_rules() {
    let days = last_open_days(300, day(2026, 11, 6));
    let flat_but = |code: &str, peaks: &[(usize, u64)]| {
        stock(code, days.iter().enumerate().map(|(i, &d)| bar(d, 10_000, peaks.iter().find(|(at, _)| *at == i).map_or(1_000, |&(_, volume)| volume))).collect())
    };
    let gapped = days.iter().enumerate().filter(|(i, _)| !(150..=159).contains(i)).map(|(i, &d)| bar(d, 10_000, if i == 99 { 9_000 } else { 1_000 })).collect();
    let halted = days.iter().enumerate().map(|(i, &d)| bar(d, 10_000, match i { 99 => 9_000, 150..=159 => 0, _ => 1_000 })).collect();
    let pricier = days.iter().enumerate().map(|(i, &d)| bar(d, if i == 230 { 90_000 } else { 10_000 }, 1_000)).collect();
    let stocks = vec![
        flat_but("200010", &[(200, 9_000)]),
        flat_but("200020", &[(199, 9_000)]),
        flat_but("200030", &[(99, 9_000)]),
        flat_but("200040", &[(150, 7_000), (260, 7_000)]),
        stock("200050", gapped),
        stock("200060", halted),
        stock("200070", pricier),
        stock("200080", priced(&days[101..], |_| 10_000)),
        stock("200090", priced(&days[100..], |_| 10_000)),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;

    let volume = api.result(&daily(&[("volume", 200, 100)])).await;
    assert_eq!((volume["universe"].clone(), volume["excluded"].clone()), (json!(9), excluded(1, 0)), "상장한 날부터 199칸인 200080만 상장 기간 부족이다");
    assert_eq!(
        hits(&volume),
        [hit("200030", days[299]), hit("200070", days[299]), hit("200090", days[299]), hit("200040", days[260]), hit("200010", days[200])],
        "최근 100칸의 첫 칸에 난 200칸 최고 거래량은 맞고 그 앞 칸이면 빠진다. 200칸 밖으로 나간 최고값, 빠진 날과 거래정지 날은 세지 않으므로 이전 최고값이 아직 창 안에 남으며, 앞선 같은 값도 최고값이다"
    );

    let traded_value = api.result(&daily(&[("traded_value", 200, 100)])).await;
    assert_eq!(traded_value["excluded"], excluded(1, 0));
    assert_eq!(
        hits(&traded_value),
        [hit("200030", days[299]), hit("200090", days[299]), hit("200040", days[260]), hit("200070", days[230]), hit("200010", days[200])],
        "신고거래대금도 같은 칸 규칙이고, 거래량이 같아도 가격이 높은 날의 거래대금이 최고값이다"
    );

    for field in ["volume", "traded_value"] {
        assert_eq!(api.run(&daily(&[(field, 200, 201)])).await.0, 200, "{field}: 범위 끝은 비교 기간과 독립이다");
        assert_eq!(api.run(&daily(&[(field, 200, 200)])).await.0, 200, "{field}: 최근 봉 수와 비교 기간이 같을 수 있다");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn excluded_kinds_and_states_leave_the_universe_uncounted_even_when_audit_info_lists_several() {
    let days = fortnight();
    let flat = |code: &str| stock(code, priced(&days, |_| 100));
    let stated = |code: &str, audit: &str| KrxStock { audit_info: audit.into(), ..flat(code) };
    let stocks = vec![
        flat("200010"),
        KrxStock { market_code: "8".into(), ..flat("200020") },
        flat("200025"),
        KrxStock { market_code: "6".into(), ..flat("200030") },
        KrxStock { market_code: "10".into(), company_class_name: "스팩".into(), ..flat("200040") },
        stated("200050", "관리종목"),
        stated("200060", "투자주의|단기과열"),
        stated("200070", "거래정지"),
        KrxStock { market_code: "8".into(), ..stock("200080", priced(&days[14..], |_| 100)) },
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let today = |codes: &[&str]| codes.iter().map(|c| hit(c, days[14])).collect::<Vec<_>>();
    let new_high_excluding = |exclude: &'static [&'static str]| screen("D", &[("high", 5, 1)], exclude);

    let everything = api.result(&new_high_excluding(&[])).await;
    assert_eq!((everything["universe"].clone(), everything["excluded"].clone()), (json!(9), excluded(1, 0)), "아무것도 빼지 않으면 전 종목이 대상이다");
    assert_eq!(hits(&everything), today(&["200010", "200020", "200025", "200030", "200040", "200050", "200060", "200070"]));

    let common_only = api.result(&new_high_excluding(&["etf", "preferred", "reit", "spac"])).await;
    assert_eq!((common_only["universe"].clone(), common_only["excluded"].clone()), (json!(4), excluded(0, 0)), "제외 목록은 빼되 세지 않는다. 상장이 짧은 ETF도 세지 않는다");
    assert_eq!(hits(&common_only), today(&["200010", "200050", "200060", "200070"]));

    let second_label = api.result(&new_high_excluding(&["short_term_overheated"])).await;
    assert_eq!((second_label["universe"].clone(), hits(&second_label)), (json!(8), today(&["200010", "200020", "200025", "200030", "200040", "200050", "200070"])), "auditInfo의 두 번째 값으로도 뺀다");

    let states = api.result(&new_high_excluding(&["investment_caution", "managed", "trading_halted"])).await;
    assert_eq!((states["universe"].clone(), hits(&states)), (json!(6), today(&["200010", "200020", "200025", "200030", "200040"])));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_is_refused_while_recent_days_fill_and_when_the_store_lacks_the_need_day() {
    let days = last_open_days(700, day(2026, 11, 6));
    let today = days[699];
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![stock("200010", priced(&days, |_| 100)), stock("200020", priced(&days[670..], |_| 100))] });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    let refusal = |(status, body): (u16, Value)| (status, body["error"]["code"].clone(), body["error"]["reason"].clone());
    let new_high = daily(&[("high", 5, 1)]);
    let unconditioned = every(vec![]);

    assert_eq!(refusal(api.run(&new_high).await), (409, json!("screener_not_ready"), json!("missing_day")), "빈 저장소");
    assert_eq!(refusal(api.run(&unconditioned).await), (409, json!("screener_not_ready"), json!("missing_day")), "조건 0줄이어도 빈 저장소에서는 막힌다");
    assert_eq!(refusal(api.run(&every(vec![with_recent(new_high["conditions"][0].clone(), 0)])).await), (400, json!("bad_request"), Value::Null), "최근 기간은 1 이상이다");

    fake.delay("ka10081", Duration::from_millis(500));
    api.update().await;
    api.wait_for("최근 채우기", |s| s["update"]["phase"] == "recent").await;
    assert_eq!(refusal(api.run(&new_high).await), (409, json!("screener_not_ready"), json!("updating")));
    assert_eq!(refusal(api.run(&unconditioned).await), (409, json!("screener_not_ready"), json!("updating")), "조건 0줄이어도 최근 채우기 중에는 막힌다");
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    let during_backfill = api.result(&new_high).await;
    assert_eq!((during_backfill["asOf"].clone(), hits(&during_backfill)), (json!(today.to_string()), vec![hit("200010", today), hit("200020", today)]), "과거 이어 받기 중에는 실행된다");
    let unconditioned_during_backfill = api.result(&unconditioned).await;
    assert_eq!(
        (unconditioned_during_backfill["excluded"].clone(), hits(&unconditioned_during_backfill)),
        (excluded(0, 0), vec![hit("200010", today), hit("200020", today)]),
        "조건 0줄은 과거 봉을 요구하지 않아 과거가 덜 찬 종목도 이력 덜 참이 아니다"
    );
    fake.reset();
    api.settled().await;
    server.stop().await;

    let two_days_later = day(2026, 11, 10);
    fake.set_krx_market(KrxMarket { days: [days.clone(), vec![day(2026, 11, 9), two_days_later]].concat(), stocks: vec![] });
    let server = boot(&fake, dir.path(), &at(two_days_later, "1000"));
    let api = Api::of(&server).await;
    assert_eq!(api.status().await["needDay"], json!("2026-11-09"));
    assert_eq!(refusal(api.run(&new_high).await), (409, json!("screener_not_ready"), json!("missing_day")), "저장소의 마지막 관측일 11-06이 필요 관측일 11-09보다 이르다");
    assert_eq!(refusal(api.run(&unconditioned).await), (409, json!("screener_not_ready"), json!("missing_day")), "조건 0줄이어도 필요 관측일이 없으면 막힌다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partly_stored_first_week_or_month_is_history_short_until_backfill_fills_it() {
    let today = day(2026, 11, 4);
    let days = last_open_days(1_300, today);
    let first_page = &days[days.len() - 600..];
    let first_stored = first_page[0];
    let its_monday = first_stored.add_days(-first_stored.weekday().days_from_monday());
    let mut mondays: Vec<KstDate> = first_page.iter().map(|d| d.add_days(-d.weekday().days_from_monday())).collect();
    mondays.dedup();
    let mut months: Vec<(i32, u8)> = first_page.iter().map(|d| (d.year(), d.month())).collect();
    months.dedup();
    assert_eq!((first_stored, its_monday, mondays.len(), months.len()), (day(2024, 7, 18), day(2024, 7, 15), 121, 29), "최근 600관측일은 목요일에 시작해 그 주와 그달의 앞부분이 빠진다");

    let earlier = stock("200010", priced(&days[days.len() - 650..], |i| 10_000 - i as u64));
    let gapped = stock("200020", priced(&days, |i| if days[i] == its_monday { 300 } else if days[i] == today { 200 } else { 100 }));
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![earlier, gapped] });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    let judged = |r: &Value| (r["excluded"].clone(), hits(r));
    let weekly = |n: u32| screen("W", &[("high", n, 1)], &[]);
    let monthly = |n: u32| screen("M", &[("high", n, 1)], &[]);

    fake.delay("ka10081", Duration::from_secs(1));
    api.update().await;
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    api.cancel().await;
    assert_eq!(api.status().await["fullHistory"], json!({"done": 0, "total": 2}));
    assert_eq!(judged(&api.result(&weekly(121)).await), (excluded(0, 2), vec![]), "필요한 첫 주의 7-15·16·17이 저장되지 않았다");
    assert_eq!(judged(&api.result(&weekly(120)).await), (excluded(0, 0), vec![hit("200020", day(2026, 11, 2))]), "필요한 첫 주가 7-22 주면 다 저장돼 있다");
    assert_eq!(judged(&api.result(&monthly(29)).await), (excluded(0, 2), vec![]), "필요한 첫 달의 7-01~17이 저장되지 않았다");
    assert_eq!(judged(&api.result(&monthly(28)).await), (excluded(0, 0), vec![hit("200020", day(2026, 11, 1))]));

    api.update().await;
    api.wait_for("200010의 과거", |s| s["fullHistory"]["done"] == 1).await;
    api.cancel().await;
    assert_eq!(judged(&api.result(&weekly(121)).await), (excluded(0, 1), vec![]), "200010이 7-15를 저장했어도 200020은 7-18부터다");
    assert_eq!(judged(&api.result(&monthly(29)).await), (excluded(0, 1), vec![]));

    fake.reset();
    api.update().await;
    assert_eq!(api.settled().await["fullHistory"], json!({"done": 2, "total": 2}));
    assert_eq!(judged(&api.result(&weekly(121)).await), (excluded(0, 0), vec![]), "7-15 고가 300이 창에 들어 이번 주는 신고가가 아니다");
    assert_eq!(judged(&api.result(&monthly(29)).await), (excluded(0, 0), vec![]));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_update_stores_the_kospi_calendar_back_to_its_first_day_once_then_appends_only_new_days() {
    let days = last_open_days(1_301, day(2026, 11, 6));
    let (yesterday, today) = (days[1_299], days[1_300]);
    let calendar_keys = |calls: &[fake_kiwoom::Call]| calls.iter().filter(|c| c.api_id == "ka20006").map(|c| c.next_key.clone()).collect::<Vec<_>>();
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days[..1_300].to_vec(), stocks: vec![stock("200010", priced(&days[1_270..1_300], |_| 100))] });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(yesterday, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.settled().await;
    let first = calendar_keys(&fake.calls());
    assert!(first.contains(&Some("IDX-1".to_owned())) && first.contains(&Some("IDX-2".to_owned())), "1,300관측일을 600행씩 연속조회로 끝까지 받는다: {first:?}");
    server.stop().await;

    let seen = fake.calls().len();
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![stock("200010", priced(&days[1_270..], |_| 100))] });
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.settled().await;
    let next = calendar_keys(&fake.calls()[seen..]);
    assert!(!next.is_empty() && next.iter().all(Option::is_none), "다음 날은 최근 코스피 일봉에서 하루를 덧붙이고 연속조회하지 않는다: {next:?}");
    assert_eq!(api.result(&daily(&[("high", 5, 1)])).await["asOf"], json!(today.to_string()), "덧붙인 오늘이 달력에 있어 오늘 기준으로 실행된다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delisted_stocks_old_bars_do_not_fill_in_the_unstored_start_of_a_new_listings_first_week() {
    let today = day(2026, 11, 4);
    let days = last_open_days(1_300, today);
    let may: Vec<KstDate> = days.iter().copied().filter(|d| (d.year(), d.month()) == (2024, 5)).collect();
    let delisted = stock("200030", priced(&may, |_| 100));
    let last_traded = *may.last().unwrap();
    let listed_from = days.iter().position(|&d| d == day(2024, 7, 1)).unwrap();
    let listed_days = &days[listed_from..];
    let new_listing = stock("200020", priced(listed_days, |i| if listed_days[i] == day(2024, 7, 15) { 300 } else if listed_days[i] == today { 200 } else { 100 }));
    assert_eq!(new_listing.bars[new_listing.bars.len() - 600].day, day(2024, 7, 18), "최근 600관측일은 7-18(목)부터라 7-15·16·17이 빠진다");
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days.iter().copied().filter(|d| *d <= last_traded).collect(), stocks: vec![delisted] });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(last_traded, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.settled().await;
    server.stop().await;

    fake.set_krx_market(KrxMarket { days, stocks: vec![new_listing] });
    fake.delay("ka10081", Duration::from_secs(1));
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    api.cancel().await;
    assert_eq!(api.status().await["fullHistory"], json!({"done": 0, "total": 1}), "상장폐지된 200030은 목록에서 빠지고 2024-05 봉만 남았다");
    let judged = |r: &Value| (r["universe"].clone(), r["excluded"].clone(), hits(r));
    let cases = [
        (screen("W", &[("high", 121, 1)], &[]), excluded(0, 1), vec![]),
        (screen("M", &[("high", 29, 1)], &[]), excluded(0, 1), vec![]),
        (screen("W", &[("high", 120, 1)], &[]), excluded(0, 0), vec![hit("200020", day(2026, 11, 2))]),
        (screen("M", &[("high", 28, 1)], &[]), excluded(0, 0), vec![hit("200020", day(2026, 11, 1))]),
    ];
    for (screen, want_excluded, want_hits) in cases {
        assert_eq!(judged(&api.result(&screen).await), (json!(1), want_excluded, want_hits), "{screen}: 필요한 첫 주·달의 첫 관측일은 코스피 달력의 7-15·7-01이다");
    }

    fake.reset();
    api.update().await;
    assert_eq!(api.settled().await["fullHistory"], json!({"done": 1, "total": 1}));
    for screen in [screen("W", &[("high", 121, 1)], &[]), screen("M", &[("high", 29, 1)], &[])] {
        assert_eq!(judged(&api.result(&screen).await), (json!(1), excluded(0, 0), vec![]), "{screen}: 과거를 채우면 7-15 고가 300이 창에 들어 신고가가 아니다");
    }
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_racing_into_recent_read_the_store_from_before_recent_or_are_refused() {
    let days = fortnight();
    let (yesterday, today) = (days[13], days[14]);
    let stopped_trading = stock("200020", priced(&days[..9], |_| 100));
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days[..14].to_vec(), stocks: vec![stopped_trading.clone()] });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(yesterday, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.settled().await;
    server.stop().await;

    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![stock("200010", priced(&days[5..], |_| 100)), stopped_trading] });
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    let new_high = daily(&[("high", 3, 3)]);
    let before = api.result(&new_high).await;
    assert_eq!((before["asOf"].clone(), before["universe"].clone(), hits(&before)), (json!(today.to_string()), json!(1), vec![]), "오늘 관측일은 확인됐어도 종목의 과거 확인이 없으면 판정하지 않는다");

    let calendar_calls = || fake.calls().iter().filter(|c| c.api_id == "ka20006").count();
    let seen = calendar_calls();
    fake.delay("ka20006", Duration::from_millis(1_500));
    api.update().await;
    for _ in 0..400 {
        if calendar_calls() > seen {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(calendar_calls() > seen, "업데이트가 목록을 바꾸고 코스피 달력을 묻는 중이다");
    let racing = futures::future::join_all((0..400).map(|_| api.run(&new_high))).await;
    let mut outcomes = std::collections::BTreeMap::new();
    for (status, body) in &racing {
        let outcome = match (*status, body["asOf"].as_str()) {
            (409, _) => {
                assert!([json!("updating"), json!("data_changed")].contains(&body["error"]["reason"]), "{body}");
                "refused"
            }
            (200, Some(d)) if d == yesterday.to_string() => {
                assert_eq!(
                    (body["universe"].clone(), body["excluded"].clone(), hits(body)),
                    (json!(2), json!({"listedTooShort": 0, "historyShort": 0, "unconfirmed": 2}), vec![]),
                    "최근 채우기 전의 저장소라 200010은 목록에만 있고 봉이 없다. 거래를 멈춘 200020은 어제 봉이 없다"
                );
                "before recent"
            }
            (200, Some(d)) if d == today.to_string() => {
                assert!([vec![], vec![hit("200010", today)]].contains(&hits(body)), "{body}");
                "after recent"
            }
            _ => panic!("{status}: {body}"),
        };
        *outcomes.entry(outcome).or_insert(0) += 1;
    }
    eprintln!("최근 채우기에 들어가는 업데이트와 겨룬 실행 {}개: {outcomes:?}", racing.len());
    fake.reset();
    api.settled().await;
    let after = api.result(&new_high).await;
    assert_eq!((after["asOf"].clone(), hits(&after)), (json!(today.to_string()), vec![hit("200010", today)]));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_low_takes_the_smallest_value_ties_included_and_a_halted_day_is_no_low_volume_bar() {
    let days = fortnight();
    let stocks = vec![
        stock("200010", priced(&days, |_| 100)),
        stock("200020", priced(&days, |i| match i { 12 => 80, 14 => 90, _ => 100 })),
        stock("200030", priced(&days, |i| if i == 14 { 95 } else { 100 })),
        stock("200040", days.iter().enumerate().map(|(i, &d)| bar(d, 100, match i { 14 => 0, 13 => 500, _ => 1_000 })).collect()),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;

    let today = api.result(&every(vec![new_low("D", "low", 5, 1)])).await;
    assert_eq!((today["excluded"].clone(), hits(&today)), (excluded(0, 0), vec![hit("200010", days[14]), hit("200030", days[14]), hit("200040", days[13])]), "같은 값도 가장 작은 값이다. 200020은 이틀 전 80이 창에 있다");
    assert_eq!(
        hits(&api.result(&every(vec![new_low("D", "low", 5, 3)])).await),
        [hit("200010", days[14]), hit("200030", days[14]), hit("200040", days[13]), hit("200020", days[12])],
        "최근 3일 안의 마지막 신저가 봉이 맞은 날짜다. 200040은 오늘 거래정지라 오늘 봉이 없다"
    );
    assert_eq!(
        hits(&api.result(&every(vec![new_low("D", "volume", 5, 1)])).await),
        [hit("200010", days[14]), hit("200020", days[14]), hit("200030", days[14]), hit("200040", days[13])],
        "거래량 0인 날은 봉이 아니라 신저거래량이 아니다"
    );
    assert_eq!(hits(&api.result(&every(vec![new_low("D", "volume", 5, 2)])).await)[3], hit("200040", days[13]), "정지 전날의 거래량 500이 5일 신저거래량이다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_value_range_includes_both_bounds_in_won_and_shares() {
    let days = fortnight();
    let closing = |code: &str, close: u64, volume: u64, traded_million_won: u64| {
        let mut bars = priced(&days, |_| 100);
        bars[14] = KrxBar { traded_million_won, ..bar(days[14], close, volume) };
        stock(code, bars)
    };
    let stocks = vec![
        closing("200010", 150, 1_000, 99),
        closing("200020", 200, 3_000, 101),
        closing("200030", 100, 1_000, 100),
        stock("200040", priced(&days, |i| if i == 12 { 300 } else { 100 })),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let today = |codes: &[&str]| codes.iter().map(|c| hit(c, days[14])).collect::<Vec<_>>();
    let ranged = |m: u32, field: &str, min: Option<f64>, max: Option<f64>| every(vec![value_range("D", m, field, min, max)]);

    assert_eq!(hits(&api.result(&ranged(1, "close", Some(150.0), Some(150.0))).await), today(&["200010"]), "최소와 최대가 같으면 그 값만 맞는다");
    assert_eq!(hits(&api.result(&ranged(1, "close", Some(150.0), None)).await), today(&["200010", "200020"]), "max가 없으면 위로 끝이 없다");
    assert_eq!(hits(&api.result(&ranged(1, "close", None, Some(150.0))).await), today(&["200010", "200030", "200040"]));
    assert_eq!(hits(&api.result(&ranged(1, "close", Some(150.5), None)).await), today(&["200020"]));
    assert_eq!(hits(&api.result(&ranged(1, "volume", Some(3_000.0), None)).await), today(&["200020"]), "거래량은 주 단위다");
    assert_eq!(hits(&api.result(&ranged(1, "volume", Some(3_001.0), None)).await), Vec::<String>::new());
    assert_eq!(hits(&api.result(&ranged(1, "traded_value", Some(100_000_000.0), None)).await), today(&["200020", "200030"]), "거래대금은 원 단위다: 100백만 원 = 1억 원");
    assert_eq!(hits(&api.result(&ranged(1, "traded_value", None, Some(100_000_000.0))).await), today(&["200010", "200030", "200040"]), "200040의 거래대금은 0백만 원이다");
    assert_eq!(hits(&api.result(&ranged(3, "close", Some(250.0), None)).await), [hit("200040", days[12])], "최근 3일 안에 맞은 봉이 있으면 맞고, 그날이 맞은 날짜다");
    assert_eq!(hits(&api.result(&ranged(2, "close", Some(250.0), None)).await), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_compares_with_the_close_back_bars_earlier_skipping_halted_days() {
    let days = fortnight();
    let stocks = vec![
        stock("200010", priced(&days, |i| if i == 14 { 105 } else { 100 })),
        stock("200020", days.iter().enumerate().map(|(i, &d)| match i { 13 => bar(d, 104, 0), 14 => bar(d, 105, 1_000), _ => bar(d, 100, 1_000) }).collect()),
        stock(
            "200030",
            days.iter().enumerate().map(|(i, &d)| match i { 9 => bar(d, 90, 1_000), 11 => bar(d, 100, 0), 12 => bar(d, 110, 1_000), 13 => bar(d, 120, 1_000), 14 => bar(d, 130, 1_000), _ => bar(d, 100, 1_000) }).collect(),
        ),
        stock("200040", priced(&days, |i| if i == 14 { 95 } else { 100 })),
        stock("200050", vec![bar(days[12], 100, 1_000), bar(days[13], 100, 0), bar(days[14], 200, 1_000)]),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let today = |codes: &[&str]| codes.iter().map(|c| hit(c, days[14])).collect::<Vec<_>>();
    let changed = |back: u32, min: Option<f64>, max: Option<f64>| every(vec![change("D", 1, back, min, max)]);

    let up_five = api.result(&changed(1, Some(5.0), None)).await;
    assert_eq!((up_five["excluded"].clone(), hits(&up_five)), (excluded(0, 0), today(&["200010", "200020", "200030", "200050"])), "+5.00%는 minPct 5를 맞춘다. 200020은 정지한 11-05를 건너뛴 11-04 종가 100 대비다");
    assert_eq!(hits(&api.result(&changed(1, Some(5.01), None)).await), today(&["200030", "200050"]));
    assert_eq!(hits(&api.result(&changed(1, None, Some(5.0))).await), today(&["200010", "200020", "200040"]));
    assert_eq!(hits(&api.result(&changed(1, None, Some(-5.0))).await), today(&["200040"]), "−5.00%는 maxPct −5를 맞춘다");
    assert_eq!(hits(&api.result(&changed(1, None, Some(-5.01))).await), Vec::<String>::new());
    assert_eq!(
        hits(&api.result(&changed(4, Some(44.4), Some(44.5))).await),
        today(&["200030"]),
        "4봉 전은 정지한 날을 건너뛴 종가 90이라 +44.44%다. 칸으로 세면 종가 100 대비 +30%다"
    );
    let two_back = api.result(&changed(2, Some(50.0), None)).await;
    assert_eq!((two_back["excluded"].clone(), hits(&two_back)), (excluded(1, 0), vec![]), "200050은 실제 봉이 2개라 2봉 전 종가를 비교할 상장 기간이 부족하다");
}

#[tokio::test(flavor = "multi_thread")]
async fn near_extreme_compares_the_close_with_the_n_cell_high_or_low_inside_a_full_window() {
    let days = fortnight();
    let flat = |price: u64| move |d: KstDate| candle(d, [price; 4], 1_000);
    let stocks = vec![
        stock("200010", days.iter().enumerate().map(|(i, &d)| match i { 9 => flat(300)(d), 11 => flat(200)(d), 14 => candle(d, [190, 195, 190, 190], 1_000), _ => flat(100)(d) }).collect()),
        stock("200020", days.iter().enumerate().map(|(i, &d)| match i { 12 => candle(d, [150, 150, 100, 150], 1_000), 14 => flat(105)(d), _ => flat(150)(d) }).collect()),
        stock("200030", days[10..].iter().enumerate().map(|(i, &d)| { let price = if i == 2 { 300 } else { 100 }; candle(d, [price, price, price - 10, price], 1_000) }).collect()),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let near = |m: u32, extreme: &str, n: u32, within: f64| every(vec![near_extreme("D", m, extreme, n, within)]);

    let high = api.result(&near(1, "high", 5, 5.0)).await;
    assert_eq!((high["excluded"].clone(), hits(&high)), (excluded(0, 0), vec![hit("200010", days[14])]), "종가 190은 5일 최고 고가 200에서 5% 안이다");
    assert_eq!(hits(&api.result(&near(1, "high", 5, 4.99)).await), Vec::<String>::new(), "오늘 고가 195가 아니라 종가 190으로 잰다");
    assert_eq!(hits(&api.result(&near(1, "high", 6, 5.0)).await), Vec::<String>::new(), "6일 창에는 고가 300이 든다");
    assert_eq!(hits(&api.result(&near(1, "low", 5, 5.0)).await), [hit("200020", days[14])], "종가 105는 5일 최저 저가 100에서 5% 안이다");
    assert_eq!(hits(&api.result(&near(1, "low", 5, 4.99)).await), Vec::<String>::new());
    assert_eq!(
        hits(&api.result(&near(3, "high", 5, 5.0)).await),
        [hit("200010", days[14]), hit("200020", days[13])],
        "200030은 상장한 지 5일이라 오늘은 따지지만, 종가가 고가 300인 11-04는 그날까지 5칸이 안 되어 후보가 아니다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_surge_compares_with_the_average_of_the_n_bars_before_skipping_halted_days() {
    let days = fortnight();
    let traded = |code: &str, volume: fn(usize) -> u64, million_won: fn(usize) -> u64| {
        stock(code, days.iter().enumerate().map(|(i, &d)| KrxBar { traded_million_won: million_won(i), ..bar(d, 100, volume(i)) }).collect())
    };
    let stocks = vec![
        traded("200010", |i| if i == 14 { 300 } else { 100 }, |_| 100),
        traded("200020", |i| match i { 12 => 0, 14 => 350, _ => 100 }, |_| 100),
        traded("200030", |_| 100, |i| if i == 14 { 900 } else { 100 }),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let today = |codes: &[&str]| codes.iter().map(|c| hit(c, days[14])).collect::<Vec<_>>();
    let surging = |field: &str, times: f64| every(vec![surge("D", 1, field, 5, times)]);

    assert_eq!(hits(&api.result(&surging("volume", 3.0)).await), today(&["200010", "200020"]), "300은 그 봉을 뺀 직전 5봉 평균 100의 3배다");
    assert_eq!(hits(&api.result(&surging("volume", 3.01)).await), today(&["200020"]));
    assert_eq!(hits(&api.result(&surging("volume", 3.5)).await), today(&["200020"]), "200020의 직전 5봉은 정지한 날을 건너뛰어 평균 100이다");
    assert_eq!(hits(&api.result(&surging("volume", 3.51)).await), Vec::<String>::new(), "정지한 날을 거래량 0인 봉으로 세면 평균 80이라 맞았을 것이다");
    assert_eq!(hits(&api.result(&surging("traded_value", 9.0)).await), today(&["200030"]));
    assert_eq!(hits(&api.result(&surging("traded_value", 9.01)).await), Vec::<String>::new());
}

fn picks(result: &Value, code: &str) -> bool {
    result["rows"].as_array().unwrap().iter().any(|r| r["symbol"] == code)
}

#[tokio::test(flavor = "multi_thread")]
async fn decimal_parameters_meet_their_exact_boundary_and_the_floats_beside_it_fall_either_side() {
    let days = fortnight();
    let (before_huge, huge) = (48_650_645_685_924_000, 49_185_802_788_469_164);
    let traded = |i: usize, today: u64, before: u64| KrxBar { traded_million_won: if i == 14 { today } else { before }, ..bar(days[i], 100, 100) };
    let stocks = vec![
        stock("200010", days.iter().enumerate().map(|(i, &d)| bar(d, 100, if i == 14 { 55 } else { 50 })).collect()),
        stock("200020", days.iter().enumerate().map(|(i, &d)| if i == 14 { candle(d, [112_500, 112_500, 106_200, 106_200], 100) } else { bar(d, 112_500, 100) }).collect()),
        stock("200030", days.iter().enumerate().map(|(i, &d)| if i == 14 { candle(d, [1_000, 1_282, 1_000, 1_282], 100) } else { bar(d, 1_000, 100) }).collect()),
        stock("200040", days.iter().enumerate().map(|(i, &d)| bar(d, if i == 14 { huge } else { before_huge }, 1)).collect()),
        stock("200050", (0..days.len()).map(|i| traded(i, 9_007_199_254_740_993, 1)).collect()),
        stock("200060", (0..days.len()).map(|i| traded(i, 18_000_000_000_000_000_000, 10_000_000_000_000_000_000)).collect()),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let traded_at_least = |won: f64| value_range("D", 1, "traded_value", Some(won), None);
    let traded_at_most = |won: f64| value_range("D", 1, "traded_value", None, Some(won));
    let precise = 9.007199254740993e21;
    let cases = [
        ("거래량 50 → 55는 직전 1봉의 정확히 1.1배다", surge("D", 1, "volume", 1, 1.1), "200010", true),
        ("1.1 바로 위의 배수", surge("D", 1, "volume", 1, 1.1f64.next_up()), "200010", false),
        ("1.1 바로 아래의 배수", surge("D", 1, "volume", 1, 1.1f64.next_down()), "200010", true),
        ("종가 106,200은 고가 112,500에서 정확히 5.6% 안이다", near_extreme("D", 1, "high", 1, 5.6), "200020", true),
        ("5.6% 바로 아래", near_extreme("D", 1, "high", 1, 5.6f64.next_down()), "200020", false),
        ("5.6% 바로 위", near_extreme("D", 1, "high", 1, 5.6f64.next_up()), "200020", true),
        ("종가 1,282는 저가 1,000에서 정확히 28.2% 안이다", near_extreme("D", 1, "low", 1, 28.2), "200030", true),
        ("28.2% 바로 아래", near_extreme("D", 1, "low", 1, 28.2f64.next_down()), "200030", false),
        ("28.2% 바로 위", near_extreme("D", 1, "low", 1, 28.2f64.next_up()), "200030", true),
        ("4.9경 원대 가격의 등락률은 정확히 +1.1%다", change("D", 1, 1, Some(1.1), None), "200040", true),
        ("minPct가 1.1 바로 위", change("D", 1, 1, Some(1.1f64.next_up()), None), "200040", false),
        ("maxPct가 1.1", change("D", 1, 1, None, Some(1.1)), "200040", true),
        ("maxPct가 1.1 바로 아래", change("D", 1, 1, None, Some(1.1f64.next_down())), "200040", false),
        ("거래대금 (2^53 + 1)백만 원은 f64로 바꾸면 2^53백만 원이 되지만 그대로 견준다", traded_at_least(precise), "200050", true),
        ("최소가 그 값 바로 위", traded_at_least(precise.next_up()), "200050", false),
        ("최대가 그 값", traded_at_most(precise), "200050", true),
        ("최대가 그 값 바로 아래", traded_at_most(precise.next_down()), "200050", false),
        ("직전 5봉 합 5천경 백만 원은 u64를 넘어도 넘치지 않고, 오늘 1.8천경은 평균의 정확히 1.8배다", surge("D", 1, "traded_value", 5, 1.8), "200060", true),
        ("1.8 바로 위의 배수", surge("D", 1, "traded_value", 5, 1.8f64.next_up()), "200060", false),
    ];
    for (case, condition, code, want) in cases {
        let result = api.result(&every(vec![condition])).await;
        assert_eq!(picks(&result, code), want, "{case}: {result}");
    }
    let huge_row = api.result(&every(vec![change("D", 1, 1, Some(1.1), None)])).await;
    assert_eq!(price_and_change(&huge_row, "200040"), (json!(huge as f64), json!(1.1)), "결과 행의 종가와 등락률도 그 가격 그대로다");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_surge_needs_a_value_above_zero_even_when_the_bars_before_average_zero() {
    let days = fortnight();
    let traded = |code: &str, today: u64| stock(code, days.iter().enumerate().map(|(i, &d)| KrxBar { traded_million_won: if i == 14 { today } else { 0 }, ..bar(d, 100, 100) }).collect());
    let session = loaded(KrxMarket { days: days.clone(), stocks: vec![traded("200010", 0), traded("200020", 1)] }).await;
    let api = &session.api;
    for n in [1, 5] {
        assert_eq!(
            hits(&api.result(&every(vec![surge("D", 1, "traded_value", n, 3.0)])).await),
            [hit("200020", days[14])],
            "n={n}: 거래대금 0백만 원이 이어진 200010은 오늘도 0이라 급증이 아니고, 0에서 1백만 원이 된 200020은 급증이다"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_huge_traded_value_sum_in_some_stocks_leaves_every_stocks_weekly_and_monthly_result() {
    let days = fortnight();
    let traded = |code: &str, million_won: u64| stock(code, days.iter().map(|&d| KrxBar { traded_million_won: million_won, ..bar(d, 100, 100) }).collect());
    let huge = 10_000_000_000_000_000_000;
    let stocks = vec![traded("200010", huge), traded("200020", 10), traded("200030", huge), traded("200040", 10)];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let this_week_sum = 5e25;
    for (period, start, last_cell_ratio) in [("W", day(2026, 11, 2), 1.0), ("M", day(2026, 11, 1), 0.5)] {
        let at = |codes: &[&str]| codes.iter().map(|c| hit(c, start)).collect::<Vec<_>>();
        let traded_at_least = |won: f64| every(vec![value_range(period, 1, "traded_value", Some(won), None)]);
        let any = api.result(&traded_at_least(1.0)).await;
        assert_eq!(
            (any["excluded"].clone(), hits(&any)),
            (excluded(0, 0), at(&["200010", "200020", "200030", "200040"])),
            "{period}: 한 칸 합이 u64를 넘는 종목이 앞에 있든 뒤에 있든 다른 종목의 결과가 남는다"
        );
        assert_eq!(hits(&api.result(&traded_at_least(this_week_sum)).await), at(&["200010", "200030"]), "{period}: 이번 칸 합은 5 × 1천경 백만 원 = 5 × 10^25원이다");
        assert_eq!(hits(&api.result(&traded_at_least(this_week_sum.next_up())).await), Vec::<String>::new(), "{period}");
        assert_eq!(
            hits(&api.result(&every(vec![surge(period, 1, "traded_value", 1, last_cell_ratio)])).await),
            at(&["200010", "200020", "200030", "200040"]),
            "{period}: 지난 칸 합(주 5일, 10월 10일)과 견준 배수도 넘치지 않는다"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn needed_bars_of_each_line_decide_listed_too_short_once_even_across_periods() {
    let days = fortnight();
    let listed_from = |code: &str, first: usize| stock(code, priced(&days[first..], |_| 100));
    let stocks = vec![listed_from("200010", 0), listed_from("200020", 10), listed_from("200030", 14), listed_from("200040", 5)];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let anything = || value_range("D", 1, "close", Some(0.0), None);
    let cases = [
        ("값 범위는 1칸", vec![anything()], 0),
        ("등락률 back=4는 5칸", vec![change("D", 1, 4, Some(-100.0), None)], 1),
        ("등락률 back=5는 6칸", vec![change("D", 1, 5, Some(-100.0), None)], 2),
        ("거래 급증 n=4는 5칸", vec![surge("D", 1, "volume", 4, 1.0)], 1),
        ("거래 급증 n=5는 6칸", vec![surge("D", 1, "volume", 5, 1.0)], 2),
        ("고점 거리 n=5는 5칸", vec![near_extreme("D", 1, "high", 5, 5.0)], 1),
        ("고점 거리 n=6은 6칸", vec![near_extreme("D", 1, "high", 6, 5.0)], 2),
        ("신저가 n=11은 11칸", vec![new_low("D", "low", 11, 1)], 3),
        ("주봉 2주: 200020·200030은 이번 주에 상장했다", vec![anything(), new_high("W", "high", 2, 1)], 2),
        ("일봉 6칸과 주봉 3주: 200040은 주봉 줄만 모자라고, 두 줄 다 모자란 종목도 한 번 센다", vec![change("D", 1, 5, Some(-100.0), None), new_high("W", "high", 3, 1)], 3),
    ];
    for (case, conditions, too_short) in cases {
        let result = api.result(&every(conditions)).await;
        assert_eq!((result["universe"].clone(), result["excluded"].clone()), (json!(4), excluded(too_short, 0)), "{case}");
        assert_eq!(hits(&result).len(), 4 - too_short as usize, "{case}: 남은 종목은 모두 맞는다");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn history_short_needs_the_earliest_first_needed_day_over_lines_of_every_period() {
    let days = last_open_days(700, day(2026, 11, 6));
    let today = days[699];
    assert_eq!((days[0].weekday(), days[100].weekday()), (Weekday::Mon, Weekday::Mon), "140주가 꼭 차고, 최근 600관측일은 월요일에 시작한다");
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![stock("200010", priced(&days, |_| 100)), stock("200020", priced(&days[670..], |_| 100))] });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    fake.delay("ka10081", Duration::from_millis(300));
    api.update().await;
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    api.cancel().await;
    assert_eq!(api.status().await["fullHistory"], json!({"done": 1, "total": 2}), "200010은 최근 600관측일만 받았다");

    let anything = || value_range("D", 1, "close", Some(0.0), None);
    let cases = [
        ("일봉 600칸이 저장돼 있다", vec![anything(), change("D", 1, 599, Some(-100.0), None)], excluded(1, 0)),
        ("일봉 601칸은 저장된 첫 날보다 이르다", vec![anything(), change("D", 1, 600, Some(-100.0), None)], excluded(1, 1)),
        ("주봉 120주는 저장된 첫 주부터다", vec![anything(), new_high("W", "close", 120, 1)], excluded(1, 0)),
        ("주봉 121주는 저장되지 않은 주에서 시작한다", vec![anything(), new_high("W", "close", 121, 1)], excluded(1, 1)),
        ("주봉 줄은 되어도 일봉 줄이 더 이른 날을 요구한다", vec![new_high("W", "close", 120, 1), surge("D", 1, "volume", 600, 1.0)], excluded(1, 1)),
        ("주봉 줄이 더 이른 날을 요구한다", vec![new_high("W", "close", 121, 1), surge("D", 1, "volume", 599, 1.0)], excluded(1, 1)),
    ];
    for (case, conditions, want) in cases {
        let result = api.result(&every(conditions)).await;
        let want_hits = if want["historyShort"] == 0 { vec![hit("200010", today)] } else { vec![] };
        assert_eq!((result["excluded"].clone(), hits(&result)), (want, want_hits), "{case}");
    }
    fake.reset();
    api.settled().await;
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn daily_and_weekly_lines_combine_with_and_and_the_first_line_sets_the_matched_date_while_closes_stay_daily() {
    let days = open_days(day(2026, 10, 19), day(2026, 11, 4), &[]);
    let (monday, today) = (day(2026, 11, 2), *days.last().unwrap());
    let rising = |i: usize| match i { 10 => 120, 11 => 300, 12 => 240, _ => 100 };
    let surging = |i: usize| if i == 12 { 500 } else { 100 };
    let stocks = vec![
        stock("200010", days.iter().enumerate().map(|(i, &d)| bar(d, rising(i), surging(i))).collect()),
        stock("200020", priced(&days, rising)),
        stock("200030", days.iter().enumerate().map(|(i, &d)| bar(d, if i == 7 { 200 } else { 100 }, surging(i))).collect()),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let weekly_high = || new_high("W", "high", 2, 1);
    let daily_surge = || surge("D", 1, "volume", 5, 3.0);

    let weekly_first = api.result(&every(vec![weekly_high(), daily_surge()])).await;
    assert_eq!(hits(&weekly_first), [hit("200010", monday)], "두 줄이 다 맞는 종목만 남고, 첫 줄이 주봉이면 맞은 날짜는 그 주 월요일이다. 수요일까지의 이번 주도 한 봉이다");
    assert_eq!(price_and_change(&weekly_first, "200010"), (json!(240.0), json!(-20.0)), "종가와 등락률은 일봉이다: 11-04 종가 240, 11-03 종가 300 대비");
    assert_eq!(hits(&api.result(&every(vec![daily_surge(), weekly_high()])).await), [hit("200010", today)], "첫 줄이 일봉이면 그 줄이 맞은 날이다");
    assert_eq!(hits(&api.result(&every(vec![weekly_high()])).await), [hit("200010", monday), hit("200020", monday)]);
    assert_eq!(hits(&api.result(&every(vec![daily_surge()])).await), [hit("200010", today), hit("200030", today)]);

    let this_week = |field: &str, value: f64| every(vec![value_range("W", 1, field, Some(value), Some(value))]);
    for (field, value) in [("open", 120.0), ("high", 300.0), ("low", 120.0), ("close", 240.0)] {
        assert_eq!(hits(&api.result(&this_week(field, value)).await), [hit("200010", monday), hit("200020", monday)], "이번 주 {field}는 {value}다: 시가는 첫 봉, 고가는 최대, 저가는 최소, 종가는 마지막 봉");
    }
    assert_eq!(hits(&api.result(&every(vec![value_range("W", 1, "volume", Some(700.0), Some(700.0))])).await), [hit("200010", monday), hit("200030", monday)], "이번 주 거래량은 100 + 100 + 500의 합이다");
    assert_eq!(
        hits(&api.result(&every(vec![change("W", 1, 1, Some(140.0), Some(140.0))])).await),
        [hit("200010", monday), hit("200020", monday)],
        "주봉 등락률은 지난주 종가 100 대비 이번 주 종가 240이다"
    );
}

fn indicator(kind: &str, period: &str, m: u32, settings: Value) -> Value {
    let mut condition = json!({"kind": kind, "period": period, "recentBars": m});
    condition.as_object_mut().unwrap().extend(settings.as_object().unwrap().clone());
    condition
}

fn walk(seed: u64, days: &[KstDate]) -> Vec<KrxBar> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = move |below: u64| {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (state >> 33) % below
    };
    let mut close = 10_000 + next(40_000);
    days.iter()
        .enumerate()
        .map(|(i, &day)| {
            let open = close;
            close = (close * (9_400 + next(1_201)) / 10_000).max(100);
            let high = open.max(close) + next(open.max(close) / 50 + 1);
            let low = open.min(close) - next(open.min(close) / 50 + 1);
            let volume = if next(15) == 0 && i + 2 < days.len() { 0 } else { 1_000 + next(100_000) };
            KrxBar { day, open, high, low, close, volume, traded_million_won: close * volume / 1_000_000, base: close, adjustment_rate: None }
        })
        .collect()
}

fn cell_start(period: &str, day: KstDate) -> KstDate {
    match period {
        "D" => day,
        "W" => day.add_days(-day.weekday().days_from_monday()),
        "M" => KstDate::new(day.year(), day.month(), 1).unwrap(),
        other => panic!("봉 주기 {other}"),
    }
}

#[derive(Default)]
struct Chart {
    starts: Vec<KstDate>,
    t: Vec<i64>,
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    volume: Vec<f64>,
}

impl Chart {
    fn of(bars: &[KrxBar], period: &str) -> Chart {
        let mut chart = Chart::default();
        for bar in bars.iter().filter(|b| b.volume > 0) {
            let start = cell_start(period, bar.day);
            if chart.starts.last() == Some(&start) {
                let k = chart.starts.len() - 1;
                chart.high[k] = chart.high[k].max(bar.high as f64);
                chart.low[k] = chart.low[k].min(bar.low as f64);
                chart.close[k] = bar.close as f64;
                chart.volume[k] += bar.volume as f64;
            } else {
                chart.starts.push(start);
                chart.t.push(start.days_since_epoch());
                chart.open.push(bar.open as f64);
                chart.high.push(bar.high as f64);
                chart.low.push(bar.low as f64);
                chart.close.push(bar.close as f64);
                chart.volume.push(bar.volume as f64);
            }
        }
        chart
    }

    fn len(&self) -> usize {
        self.starts.len()
    }

    fn line(&self, spec: Spec, id: LineId) -> Vec<f64> {
        let columns = Columns::new(&self.t, &self.open, &self.high, &self.low, &self.close, &self.volume).unwrap();
        let output = indicators::compute(&ValidSpec::new(spec).unwrap(), &columns);
        let line = output.lines.into_iter().find(|l| l.id == id).unwrap();
        let ahead = usize::try_from(line.shift).unwrap();
        (0..self.len()).map(|i| if i >= ahead { line.values[i - ahead] } else { f64::NAN }).collect()
    }

    fn ma(&self, method: MaMethod, period: u16) -> Vec<f64> {
        self.line(Spec::Ma { method, period }, LineId::Ma)
    }

    fn each(&self, holds: impl Fn(usize) -> bool) -> Vec<bool> {
        (0..self.len()).map(holds).collect()
    }

    fn crossing(&self, direction: &str, line: &[f64], of: &[f64]) -> Vec<bool> {
        self.each(|i| {
            i > 0 && match direction {
                "up" => line[i - 1] <= of[i - 1] && line[i] > of[i],
                "down" => line[i - 1] >= of[i - 1] && line[i] < of[i],
                other => panic!("방향 {other}"),
            }
        })
    }

    fn level(&self, value: f64) -> Vec<f64> {
        vec![value; self.len()]
    }
}

fn rsi(chart: &Chart, period: u16) -> Vec<f64> {
    chart.line(Spec::Rsi { period, signal: None }, LineId::Rsi)
}

fn macd(chart: &Chart, fast: u16, slow: u16, signal: u16) -> (Vec<f64>, Vec<f64>) {
    let spec = Spec::Macd { fast, slow, signal };
    (chart.line(spec.clone(), LineId::Macd), chart.line(spec, LineId::Signal))
}

fn stochastic(chart: &Chart, k: u16, d: u16, smooth: u16) -> (Vec<f64>, Vec<f64>) {
    let spec = Spec::StochSlow { k, d, smooth };
    (chart.line(spec.clone(), LineId::K), chart.line(spec, LineId::D))
}

fn bollinger(chart: &Chart, period: u16, k: f64) -> (Vec<f64>, Vec<f64>) {
    let spec = Spec::Bollinger { period, k };
    (chart.line(spec.clone(), LineId::Upper), chart.line(spec, LineId::Lower))
}

fn ichimoku(chart: &Chart, id: LineId) -> Vec<f64> {
    chart.line(Spec::Ichimoku { conversion: 9, base: 26, span_b: 52, displacement: 26 }, id)
}

type Candidates = fn(&Chart) -> Vec<bool>;

fn found(_days: &[KstDate], stocks: &[KrxStock], condition: &Value, candidates: Candidates) -> Vec<String> {
    let period = condition["period"].as_str().unwrap();
    let count = condition["recentBars"].as_u64().unwrap() as usize;
    let mut found: Vec<(KstDate, &str)> = stocks
        .iter()
        .filter_map(|stock| {
            let chart = Chart::of(&stock.bars, period);
            let flags = candidates(&chart);
            (chart.len().saturating_sub(count)..chart.len()).rev().find(|&i| flags[i]).map(|i| (chart.starts[i], stock.code.as_str()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    found.into_iter().map(|(day, code)| hit(code, day)).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn each_indicator_kind_and_test_picks_the_stocks_the_indicators_crate_finds_on_the_same_bars() {
    let days = last_open_days(200, day(2026, 11, 6));
    let stocks: Vec<KrxStock> = (0..24).map(|k| stock(&format!("2000{:02}", k + 10), walk(k as u64, if k % 4 == 3 { &days[40..] } else { &days }))).collect();
    let session = loaded(KrxMarket { days: days.clone(), stocks: stocks.clone() }).await;
    let api = &session.api;
    let cases: Vec<(Value, Candidates)> = vec![
        (indicator("ma_position", "D", 1, json!({"field": "close", "method": "sma", "length": 20, "side": "above"})), |c| {
            let ma = c.ma(MaMethod::Sma, 20);
            c.each(|i| c.close[i] > ma[i])
        }),
        (indicator("ma_position", "D", 2, json!({"field": "low", "method": "ema", "length": 10, "side": "below"})), |c| {
            let ma = c.ma(MaMethod::Ema, 10);
            c.each(|i| c.low[i] < ma[i])
        }),
        (indicator("ma_alignment", "D", 3, json!({"method": "sma", "lengths": [5, 20, 60], "order": "bullish"})), |c| {
            let (short, middle, long) = (c.ma(MaMethod::Sma, 5), c.ma(MaMethod::Sma, 20), c.ma(MaMethod::Sma, 60));
            c.each(|i| short[i] > middle[i] && middle[i] > long[i])
        }),
        (indicator("ma_alignment", "D", 1, json!({"method": "ema", "lengths": [5, 20], "order": "bearish"})), |c| {
            let (short, long) = (c.ma(MaMethod::Ema, 5), c.ma(MaMethod::Ema, 20));
            c.each(|i| short[i] < long[i])
        }),
        (indicator("ma_cross", "D", 10, json!({"method": "sma", "fast": 5, "slow": 20, "direction": "up"})), |c| c.crossing("up", &c.ma(MaMethod::Sma, 5), &c.ma(MaMethod::Sma, 20))),
        (indicator("ma_cross", "D", 10, json!({"method": "ema", "fast": null, "slow": 10, "direction": "down"})), |c| c.crossing("down", &c.close, &c.ma(MaMethod::Ema, 10))),
        (indicator("rsi", "D", 1, json!({"length": 14, "test": {"kind": "range", "min": 55.0, "max": null}})), |c| {
            let rsi = rsi(c, 14);
            c.each(|i| rsi[i] >= 55.0)
        }),
        (indicator("rsi", "D", 10, json!({"length": 14, "test": {"kind": "breakout", "value": 50.0, "direction": "up"}})), |c| c.crossing("up", &rsi(c, 14), &c.level(50.0))),
        (indicator("rsi", "D", 10, json!({"length": 14, "test": {"kind": "breakout", "value": 50.0, "direction": "down"}})), |c| c.crossing("down", &rsi(c, 14), &c.level(50.0))),
        (indicator("macd", "D", 10, json!({"fast": 12, "slow": 26, "signal": 9, "test": {"kind": "signal_cross", "direction": "up"}})), |c| {
            let (macd, signal) = macd(c, 12, 26, 9);
            c.crossing("up", &macd, &signal)
        }),
        (indicator("macd", "D", 10, json!({"fast": 12, "slow": 26, "signal": 9, "test": {"kind": "zero_breakout", "direction": "down"}})), |c| c.crossing("down", &macd(c, 12, 26, 9).0, &c.level(0.0))),
        (indicator("macd", "D", 1, json!({"fast": 12, "slow": 26, "signal": 9, "test": {"kind": "vs_signal", "side": "above"}})), |c| {
            let (macd, signal) = macd(c, 12, 26, 9);
            c.each(|i| macd[i] > signal[i])
        }),
        (indicator("stochastic", "D", 5, json!({"k": 5, "d": 3, "smooth": 3, "test": {"kind": "cross", "direction": "up"}})), |c| {
            let (k, d) = stochastic(c, 5, 3, 3);
            c.crossing("up", &k, &d)
        }),
        (indicator("stochastic", "D", 1, json!({"k": 5, "d": 3, "smooth": 3, "test": {"kind": "range", "min": null, "max": 30.0}})), |c| {
            let k = stochastic(c, 5, 3, 3).0;
            c.each(|i| k[i] <= 30.0)
        }),
        (indicator("bollinger", "D", 20, json!({"length": 20, "k": 2.0, "test": {"kind": "outside", "side": "above"}})), |c| {
            let upper = bollinger(c, 20, 2.0).0;
            c.each(|i| c.close[i] > upper[i])
        }),
        (indicator("bollinger", "D", 20, json!({"length": 20, "k": 2.0, "test": {"kind": "outside", "side": "below"}})), |c| {
            let lower = bollinger(c, 20, 2.0).1;
            c.each(|i| c.close[i] < lower[i])
        }),
        (indicator("bollinger", "D", 20, json!({"length": 20, "k": 1.5, "test": {"kind": "cross", "band": "upper", "direction": "down"}})), |c| c.crossing("down", &c.close, &bollinger(c, 20, 1.5).0)),
        (indicator("bollinger", "D", 20, json!({"length": 20, "k": 1.5, "test": {"kind": "cross", "band": "lower", "direction": "up"}})), |c| c.crossing("up", &c.close, &bollinger(c, 20, 1.5).1)),
        (indicator("ichimoku", "D", 1, json!({"conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cloud", "side": "above"}})), |c| {
            let (a, b) = (ichimoku(c, LineId::SpanA), ichimoku(c, LineId::SpanB));
            c.each(|i| c.close[i] > a[i] && c.close[i] > b[i])
        }),
        (indicator("ichimoku", "D", 1, json!({"conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cloud", "side": "below"}})), |c| {
            let (a, b) = (ichimoku(c, LineId::SpanA), ichimoku(c, LineId::SpanB));
            c.each(|i| c.close[i] < a[i] && c.close[i] < b[i])
        }),
        (indicator("ichimoku", "D", 10, json!({"conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cross", "direction": "up"}})), |c| {
            c.crossing("up", &ichimoku(c, LineId::Conversion), &ichimoku(c, LineId::Base))
        }),
        (indicator("macd", "W", 4, json!({"fast": 3, "slow": 6, "signal": 4, "test": {"kind": "signal_cross", "direction": "down"}})), |c| {
            let (macd, signal) = macd(c, 3, 6, 4);
            c.crossing("down", &macd, &signal)
        }),
        (indicator("ma_position", "W", 1, json!({"field": "high", "method": "sma", "length": 10, "side": "above"})), |c| {
            let ma = c.ma(MaMethod::Sma, 10);
            c.each(|i| c.high[i] > ma[i])
        }),
        (indicator("stochastic", "M", 2, json!({"k": 3, "d": 2, "smooth": 2, "test": {"kind": "range", "min": 50.0, "max": null}})), |c| {
            let k = stochastic(c, 3, 2, 2).0;
            c.each(|i| k[i] >= 50.0)
        }),
    ];
    for (condition, candidates) in &cases {
        let want = found(&days, &stocks, condition, *candidates);
        let result = api.result(&every(vec![condition.clone()])).await;
        assert_eq!((result["excluded"].clone(), hits(&result)), (excluded(0, 0), want.clone()), "{condition}");
        assert!(!want.is_empty() && want.len() < stocks.len(), "{condition}: 맞는 종목과 안 맞는 종목이 다 있다: {want:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cross_takes_lines_equal_on_the_bar_before_and_that_bar_skips_halted_days() {
    let days = fortnight();
    let ending = |code: &str, last_two: [(u64, u64); 2]| {
        stock(code, days.iter().enumerate().map(|(i, &d)| if i < 13 { bar(d, 100, 1_000) } else { bar(d, last_two[i - 13].0, last_two[i - 13].1) }).collect())
    };
    let stocks = vec![
        ending("200010", [(100, 1_000), (130, 1_000)]),
        ending("200020", [(110, 1_000), (130, 1_000)]),
        ending("200030", [(80, 1_000), (90, 1_000)]),
        ending("200040", [(150, 0), (130, 1_000)]),
        ending("200050", [(100, 1_000), (70, 1_000)]),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let close_crossing = |m: u32, direction: &str| every(vec![indicator("ma_cross", "D", m, json!({"method": "sma", "fast": null, "slow": 3, "direction": direction}))]);

    assert_eq!(
        hits(&api.result(&close_crossing(1, "up")).await),
        [hit("200010", days[14]), hit("200040", days[14])],
        "200010은 어제 종가 100이 3일선 100과 같았고 오늘 130이 3일선 110 위다. 200040은 정지한 어제를 건너뛴 그제가 직전 봉이다"
    );
    assert_eq!(hits(&api.result(&close_crossing(1, "down")).await), [hit("200050", days[14])], "200030은 오늘 종가 90이 3일선 90과 같아 아래로 교차하지 않았다");
    assert_eq!(
        hits(&api.result(&close_crossing(2, "up")).await),
        [hit("200010", days[14]), hit("200040", days[14]), hit("200020", days[13])],
        "200020은 어제 이미 3일선 위로 올라섰다"
    );
    assert_eq!(hits(&api.result(&close_crossing(2, "down")).await), [hit("200050", days[14]), hit("200030", days[13])]);
    assert_eq!(
        hits(&api.result(&every(vec![indicator("ma_position", "D", 1, json!({"field": "close", "method": "sma", "length": 3, "side": "below"}))])).await),
        [hit("200050", days[14])],
        "이평과 같은 종가는 이평 아래가 아니다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_ichimoku_cloud_of_a_bar_is_the_leading_spans_computed_displacement_minus_one_bars_before() {
    let days = fortnight();
    let ranged = |d: KstDate, high: u64, low: u64, close: u64| candle(d, [close, high, low, close], 1_000);
    let halted = |d: KstDate| candle(d, [999; 4], 0);
    let stocks = vec![
        stock("200010", vec![ranged(days[11], 310, 290, 300), ranged(days[12], 110, 90, 100), ranged(days[13], 210, 190, 200), ranged(days[14], 250, 150, 150)]),
        stock("200020", vec![ranged(days[11], 110, 90, 100), ranged(days[12], 310, 290, 300), ranged(days[13], 110, 90, 100), ranged(days[14], 250, 150, 200)]),
        stock("200030", vec![ranged(days[10], 310, 290, 300), ranged(days[11], 110, 90, 100), halted(days[12]), ranged(days[13], 210, 190, 200), ranged(days[14], 250, 150, 150)]),
        stock("200040", vec![ranged(days[13], 110, 90, 100), ranged(days[14], 250, 150, 150)]),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let spec = Spec::Ichimoku { conversion: 1, base: 1, span_b: 1, displacement: 3 };
    assert_eq!((spec.shift_of(LineId::SpanA), spec.shift_of(LineId::SpanB), spec.warmup()), (Some(2), Some(2), 1), "선행스팬은 2봉 앞으로 옮겨 그리고, 한 봉의 고가·저가 가운데가 그 봉의 선이다");
    let cloud = |side: &str| every(vec![indicator("ichimoku", "D", 1, json!({"conversion": 1, "base": 1, "spanB": 1, "displacement": 3, "test": {"kind": "cloud", "side": side}}))]);

    let above = api.result(&cloud("above")).await;
    assert_eq!(
        (above["excluded"].clone(), hits(&above)),
        (excluded(1, 0), vec![hit("200010", days[14]), hit("200030", days[14])]),
        "오늘 구름은 2봉 전 가운데 100이라 종가 150이 위다. 1봉 전(200)이나 3봉 전(300)이면 위가 아니다. 200030은 정지한 날을 건너뛰어 센다. 200040은 구름에 3칸이 필요해 상장 기간 부족이다"
    );
    assert_eq!(hits(&api.result(&cloud("below")).await), [hit("200020", days[14])], "오늘 구름은 2봉 전 가운데 300이라 종가 200이 아래다");
}

#[tokio::test(flavor = "multi_thread")]
async fn needed_bars_of_indicator_lines_follow_the_indicator_warmup_and_count_listed_too_short() {
    let days = fortnight();
    let listed_cells = [9, 10, 11, 12];
    let stocks = listed_cells.iter().enumerate().map(|(k, &cells)| stock(&format!("2000{}0", k + 1), priced(&days[days.len() - cells..], |i| 100 + (i as u64 * 7) % 5))).collect();
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let warmup = |spec: Spec| spec.warmup();
    let cross = |spec: Spec| spec.warmup() + 1;
    let rsi = |test: Value| indicator("rsi", "D", 1, json!({"length": 9, "test": test}));
    let macd = |test: Value| indicator("macd", "D", 1, json!({"fast": 3, "slow": 6, "signal": 5, "test": test}));
    let stochastic = |test: Value| indicator("stochastic", "D", 1, json!({"k": 6, "d": 3, "smooth": 3, "test": test}));
    let bollinger = |test: Value| indicator("bollinger", "D", 1, json!({"length": 10, "k": 2.0, "test": test}));
    let ichimoku = |test: Value| indicator("ichimoku", "D", 1, json!({"conversion": 3, "base": 5, "spanB": 10, "displacement": 3, "test": test}));
    let (rsi_spec, macd_spec, stochastic_spec) = (Spec::Rsi { period: 9, signal: None }, Spec::Macd { fast: 3, slow: 6, signal: 5 }, Spec::StochSlow { k: 6, d: 3, smooth: 3 });
    let (bollinger_spec, ichimoku_spec) = (Spec::Bollinger { period: 10, k: 2.0 }, Spec::Ichimoku { conversion: 3, base: 5, span_b: 10, displacement: 3 });
    let up = json!({"direction": "up"});
    let with = |kind: &str, extra: &Value| {
        let mut test = json!({"kind": kind});
        test.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        test
    };
    let cases = [
        ("이평 위치는 length", indicator("ma_position", "D", 1, json!({"field": "close", "method": "sma", "length": 10, "side": "above"})), 10),
        ("이평 배열은 가장 긴 length", indicator("ma_alignment", "D", 1, json!({"method": "ema", "lengths": [3, 10], "order": "bullish"})), 10),
        ("이평 교차는 slow + 1", indicator("ma_cross", "D", 1, json!({"method": "sma", "fast": 3, "slow": 10, "direction": "up"})), 11),
        ("종가와 이평의 교차도 slow + 1", indicator("ma_cross", "D", 1, json!({"method": "ema", "fast": null, "slow": 10, "direction": "down"})), 11),
        ("RSI 범위는 warmup", rsi(json!({"kind": "range", "min": 0.0, "max": null})), warmup(rsi_spec.clone())),
        ("RSI 돌파는 warmup + 1", rsi(json!({"kind": "breakout", "value": 50.0, "direction": "up"})), cross(rsi_spec)),
        ("MACD 시그널 위는 warmup", macd(json!({"kind": "vs_signal", "side": "above"})), warmup(macd_spec.clone())),
        ("MACD 시그널 교차는 warmup + 1", macd(with("signal_cross", &up)), cross(macd_spec.clone())),
        ("MACD 0선 돌파는 warmup + 1", macd(with("zero_breakout", &up)), cross(macd_spec)),
        ("스토캐스틱 범위는 warmup", stochastic(json!({"kind": "range", "min": 0.0, "max": null})), warmup(stochastic_spec.clone())),
        ("스토캐스틱 교차는 warmup + 1", stochastic(with("cross", &up)), cross(stochastic_spec)),
        ("볼린저 밴드 밖은 warmup", bollinger(json!({"kind": "outside", "side": "below"})), warmup(bollinger_spec.clone())),
        ("볼린저 밴드 교차는 warmup + 1", bollinger(json!({"kind": "cross", "band": "upper", "direction": "up"})), cross(bollinger_spec)),
        ("일목 구름은 warmup + displacement − 1", ichimoku(json!({"kind": "cloud", "side": "above"})), warmup(ichimoku_spec.clone()) + 2),
        ("일목 전환선·기준선 교차는 warmup + 1", ichimoku(with("cross", &up)), cross(ichimoku_spec)),
        (
            "M은 필요한 봉 수를 바꾸지 않는다",
            indicator("rsi", "D", 5, json!({"length": 9, "test": {"kind": "breakout", "value": 50.0, "direction": "up"}})),
            cross(Spec::Rsi { period: 9, signal: None }),
        ),
    ];
    assert_eq!(cases.iter().map(|(_, _, needed)| *needed).collect::<Vec<_>>(), [10, 10, 11, 11, 10, 11, 10, 11, 11, 10, 11, 10, 11, 12, 11, 11], "상장 칸 9~12인 종목들이 경계를 가른다");
    for (case, condition, needed) in cases {
        let too_short = listed_cells.iter().filter(|&&cells| cells < needed).count() as u32;
        let result = api.result(&every(vec![condition])).await;
        assert_eq!((result["universe"].clone(), result["excluded"].clone()), (json!(4), excluded(too_short, 0)), "{case}: 필요한 봉 {needed}칸");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_indicator_value_meets_a_bound_equal_to_it_and_the_floats_beside_it_fall_either_side() {
    let days = last_open_days(200, day(2026, 11, 6));
    let bars = walk(7, &days);
    let chart = Chart::of(&bars, "D");
    let session = loaded(KrxMarket { days: days.clone(), stocks: vec![stock("200010", bars)] }).await;
    let api = &session.api;
    let today = chart.len() - 1;
    let rsi_line = rsi(&chart, 14);
    let k_line = stochastic(&chart, 5, 3, 3).0;
    let (rsi_before, rsi_today, k_today) = (rsi_line[today - 1], rsi_line[today], k_line[today]);
    assert_ne!(rsi_before, rsi_today);
    let (rising, beyond_before) = if rsi_today > rsi_before { ("up", rsi_before.next_down()) } else { ("down", rsi_before.next_up()) };
    let rsi_range = |min: Option<f64>, max: Option<f64>| indicator("rsi", "D", 1, json!({"length": 14, "test": {"kind": "range", "min": min, "max": max}}));
    let k_range = |min: Option<f64>, max: Option<f64>| indicator("stochastic", "D", 1, json!({"k": 5, "d": 3, "smooth": 3, "test": {"kind": "range", "min": min, "max": max}}));
    let breakout = |value: f64| indicator("rsi", "D", 1, json!({"length": 14, "test": {"kind": "breakout", "value": value, "direction": rising}}));
    let cases = [
        ("RSI가 최소이자 최대다", rsi_range(Some(rsi_today), Some(rsi_today)), true),
        ("최소가 RSI 바로 위의 f64", rsi_range(Some(rsi_today.next_up()), None), false),
        ("최대가 RSI 바로 아래의 f64", rsi_range(None, Some(rsi_today.next_down())), false),
        ("%K가 최소이자 최대다. 200봉 가운데 끝 봉만 넣어 셈해도 크레이트가 처음부터 셈한 값과 같다", k_range(Some(k_today), Some(k_today)), true),
        ("최소가 %K 바로 위의 f64", k_range(Some(k_today.next_up()), None), false),
        ("최대가 %K 바로 아래의 f64", k_range(None, Some(k_today.next_down())), false),
        ("직전 봉 RSI와 같은 값을 넘으면 돌파다", breakout(rsi_before), true),
        ("직전 봉 RSI가 이미 넘어 있던 값은 돌파가 아니다", breakout(beyond_before), false),
        ("오늘 RSI와 같은 값은 넘지 않았다", breakout(rsi_today), false),
    ];
    for (case, condition, want) in cases {
        let result = api.result(&every(vec![condition])).await;
        assert_eq!(picks(&result, "200010"), want, "{case}: RSI {rsi_before} → {rsi_today}, %K {k_today}: {result}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_candidate_bar_and_the_bar_before_a_cross_need_every_line_of_the_indicator_computed() {
    let days = fortnight();
    let jumping_at = |first: usize| priced(&days, move |i| if i >= first { 130 } else { 100 });
    let halted_most_days: Vec<KrxBar> = days.iter().enumerate().map(|(i, &d)| bar(d, if i == 14 { 130 } else { 100 }, if i == 0 || i >= 12 { 1_000 } else { 0 })).collect();
    let stocks = vec![
        stock("200010", halted_most_days.clone()),
        stock("200020", jumping_at(14)),
        stock("200030", jumping_at(3)),
        stock("200040", jumping_at(5)),
        stock("200050", jumping_at(6)),
    ];
    let session = loaded(KrxMarket { days: days.clone(), stocks }).await;
    let api = &session.api;
    let few_bars = Chart::of(&halted_most_days, "D");
    let stochastic_spec = Spec::StochSlow { k: 2, d: 9, smooth: 1 };
    let macd_spec = Spec::Macd { fast: 1, slow: 2, signal: 5 };
    let ichimoku_spec = Spec::Ichimoku { conversion: 1, base: 2, span_b: 10, displacement: 1 };
    assert_eq!(
        (few_bars.len(), stochastic_spec.warmup(), macd_spec.warmup(), ichimoku_spec.warmup()),
        (4, 10, 6, 10),
        "200010은 15칸에 봉이 4개라 상장 기간은 되지만 %D·시그널·선행스팬 B가 계산되지 않는다"
    );
    for (spec, unready) in [(stochastic_spec, LineId::D), (macd_spec, LineId::Signal), (ichimoku_spec, LineId::SpanB)] {
        assert!(few_bars.line(spec, unready)[3].is_nan());
    }
    let today = || vec![hit("200020", days[14])];
    let cases = [
        (
            "스토캐스틱 범위는 %K만 맞아도 %D가 계산되기 전이면 후보가 아니다",
            json!({"kind": "stochastic", "k": 2, "d": 9, "smooth": 1, "test": {"kind": "range", "min": 90.0, "max": 100.0}}),
            1,
            today(),
            today(),
        ),
        (
            "MACD 0선 돌파는 시그널이 계산되기 전이면 후보가 아니고, 직전 봉에서도 시그널이 있어야 한다: 200040은 시그널이 처음 생긴 봉에서 돌파했다",
            json!({"kind": "macd", "fast": 1, "slow": 2, "signal": 5, "test": {"kind": "zero_breakout", "direction": "up"}}),
            1,
            today(),
            vec![hit("200020", days[14]), hit("200050", days[6])],
        ),
        (
            "일목 전환선·기준선 교차는 선행스팬 B가 계산되기 전이면 후보가 아니다",
            json!({"kind": "ichimoku", "conversion": 1, "base": 2, "spanB": 10, "displacement": 1, "test": {"kind": "cross", "direction": "up"}}),
            1,
            today(),
            today(),
        ),
        (
            "일목 교차의 선행스팬은 displacement−1봉 앞에서 계산한 값이라, 그 봉과 직전 봉에서 4봉 앞의 선행스팬 B가 있어야 한다",
            json!({"kind": "ichimoku", "conversion": 1, "base": 2, "spanB": 2, "displacement": 5, "test": {"kind": "cross", "direction": "up"}}),
            0,
            today(),
            vec![hit("200020", days[14]), hit("200050", days[6])],
        ),
    ];
    for (case, settings, listed_too_short, today_only, fortnight_long) in cases {
        let kind = settings["kind"].as_str().unwrap().to_owned();
        for (m, want) in [(1, today_only), (15, fortnight_long)] {
            let result = api.result(&every(vec![indicator(&kind, "D", m, settings.clone())])).await;
            assert_eq!((result["excluded"].clone(), hits(&result)), (excluded(listed_too_short, 0), want), "{case}, 최근 {m}봉: 200010은 실제 봉이 모자라고 200030은 준비 기간에 맞았다");
        }
    }
}

fn with_shares(listed_shares: Option<u64>, stock: KrxStock) -> KrxStock {
    KrxStock { listed_shares, ..stock }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_market_cap_is_the_last_daily_close_up_to_the_as_of_day_times_the_listed_shares_with_both_bounds_included() {
    let days = fortnight();
    let today = days[14];
    let cap = 12_345.0 * 24_300_001.0;
    let halted_at_another_price = |i: usize, d: KstDate| if i <= 12 { bar(d, 12_345, 1_000) } else { bar(d, 99_999, 0) };
    let stocks = vec![
        with_shares(Some(24_300_001), stock("200010", priced(&days, |_| 12_345))),
        with_shares(Some(24_300_001), stock("200020", days.iter().enumerate().map(|(i, &d)| halted_at_another_price(i, d)).collect())),
        with_shares(None, stock("200030", priced(&days, |_| 12_345))),
        with_shares(Some(0), stock("200040", priced(&days, |_| 12_345))),
    ];
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.settled().await;

    let capped = |min: Option<f64>, max: Option<f64>| every(vec![market_cap(min, max)]);
    let both = vec![hit("200010", today), hit("200020", today)];
    let cases = [
        ("하한과 같다", capped(Some(cap), None), both.clone()),
        ("상한과 같다", capped(None, Some(cap)), both.clone()),
        ("하한이 1원 크다", capped(Some(cap + 1.0), None), vec![]),
        ("상한이 1원 작다", capped(None, Some(cap - 1.0)), vec![]),
        ("하한이 0원", capped(Some(0.0), None), both.clone()),
    ];
    for (case, screen, want) in cases {
        let result = api.result(&screen).await;
        assert_eq!((result["universe"].clone(), hits(&result)), (json!(4), want), "{case}: 시가총액은 12,345원 × 24,300,001주다. 상장주식수가 없는 200030과 0인 200040은 맞지 않는다");
    }
    let exact = api.result(&capped(Some(cap), Some(cap))).await;
    assert_eq!(price_and_change(&exact, "200020"), (json!(12_345.0), json!(0.0)), "거래량 0인 날은 봉이 아니라서, 시가총액도 결과 행처럼 마지막으로 거래한 날의 종가로 센다");
    server.stop().await;

    let after_as_of = today.add_days(3);
    let store = Store::open(&dir.path().join("run/screener.duckdb")).unwrap();
    let price = Price::from_centi(99_999 * 100).unwrap();
    let left_by_cancelled_recent = DayBar { day: after_as_of, ohlcv: Ohlcv::try_new(price, price, price, price, Volume(1_000)).unwrap(), traded: MillionWon(99) };
    store.write(&[Write::Extend { code: StockCode::parse("200010").unwrap(), bars: vec![left_by_cancelled_recent], reached_origin: true }]).unwrap();
    drop(store);
    let server = boot(&fake, dir.path(), &at(after_as_of, "2040"));
    let api = Api::of(&server).await;
    fake.set_quote_rows(["200010", "200020", "200030", "200040"].into_iter().map(|code| {
        let mut row = summary_row(code, after_as_of, 0, 0, 0, 0);
        for key in ["open_pric", "high_pric", "low_pric"] { row[key] = "0".into(); }
        row["base_pric"] = "12345".into();
        row["cntr_tm"] = "".into();
        row
    }).collect());
    let result = api.result(&capped(Some(cap), Some(cap))).await;
    assert_eq!((result["asOf"].clone(), hits(&result)), (json!(today.to_string()), both), "기준 관측일 뒤의 봉은 시가총액에 쓰지 않는다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn markets_keep_only_their_own_stocks_with_kospi_holding_etfs_and_reits_and_leave_the_others_uncounted() {
    let days = fortnight();
    let today = days[14];
    let listed_in = |market_code: &str, stock: KrxStock| KrxStock { market_code: market_code.into(), ..stock };
    let stocks = vec![
        listed_in("0", stock("200010", priced(&days, |_| 100))),
        listed_in("8", stock("200020", priced(&days, |_| 100))),
        listed_in("6", stock("200030", priced(&days, |_| 100))),
        listed_in("10", stock("200040", priced(&days, |_| 100))),
        listed_in("10", stock("200050", priced(&days[12..], |_| 100))),
        listed_in("10", stock("200060", priced(&days[..9], |_| 100))),
    ];
    let session = loaded(KrxMarket { days, stocks }).await;
    let api = &session.api;
    let picked = |markets: &[&str], exclude: &[&str]| json!({"id": "S1", "name": "시험 조건식", "markets": markets, "exclude": exclude, "conditions": [new_high("D", "high", 5, 1)]});
    let counted = |listed_too_short: u32, unconfirmed: u32| json!({"listedTooShort": listed_too_short, "historyShort": 0, "unconfirmed": unconfirmed});
    let every_market = ["200010", "200020", "200030", "200040"];
    let cases = [
        ("시장을 고르지 않음", picked(&[], &[]), 6, counted(1, 1), every_market.to_vec()),
        ("두 시장을 다 고름", picked(&["kospi", "kosdaq"], &[]), 6, counted(1, 1), every_market.to_vec()),
        ("코스피만", picked(&["kospi"], &[]), 3, counted(0, 0), vec!["200010", "200020", "200030"]),
        ("코스닥만", picked(&["kosdaq"], &[]), 3, counted(1, 1), vec!["200040"]),
        ("코스피에서 ETF를 뺌", picked(&["kospi"], &["etf"]), 2, counted(0, 0), vec!["200010", "200030"]),
    ];
    for (case, screen, universe, want_excluded, want) in cases {
        let result = api.result(&screen).await;
        let want: Vec<String> = want.into_iter().map(|code| hit(code, today)).collect();
        assert_eq!(
            (result["universe"].clone(), result["excluded"].clone(), hits(&result)),
            (json!(universe), want_excluded, want),
            "{case}: 고르지 않은 시장의 종목은 대상 종목 수에도 제외 수에도 들지 않는다. 코스닥의 200050은 상장 기간 부족, 200060은 확인 안 됨이다"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screen_without_conditions_is_saved_read_back_after_a_restart_and_finds_every_target_stock_on_the_as_of_day() {
    let days = fortnight();
    let today = days[14];
    let listed_in = |market_code: &str, stock: KrxStock| KrxStock { market_code: market_code.into(), ..stock };
    let halted_after = |code: &str| stock(code, days.iter().enumerate().map(|(i, &d)| bar(d, if i >= 12 { 120 } else { 100 }, if i >= 13 { 0 } else { 1_000 })).collect());
    let stocks = vec![
        stock("200010", priced(&days, |i| if i == 14 { 110 } else { 100 })),
        listed_in("8", stock("200020", priced(&days, |_| 100))),
        listed_in("10", stock("200030", priced(&days[14..], |_| 100))),
        KrxStock { audit_info: "관리종목".into(), ..listed_in("10", halted_after("200040")) },
        listed_in("10", stock("200050", priced(&days[..9], |_| 100))),
        KrxStock { reg_day: day(2026, 11, 9), bars: vec![], ..stock("200060", priced(&days, |_| 100)) },
    ];
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days, stocks });
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.settled().await;

    let unconditioned = |id: &str, markets: &[&str], exclude: &[&str]| json!({"id": id, "name": format!("조건 없음 {id}"), "markets": markets, "exclude": exclude, "conditions": []});
    let saved = json!({"screens": [unconditioned("all", &[], &[]), unconditioned("kosdaq", &["kosdaq"], &["managed"]), unconditioned("kospi", &["kospi"], &["etf"])], "revision": 1});
    let screens_url = format!("http://{}/api/screens", server.addr().await);
    let put = reqwest::Client::new().put(&screens_url).header("content-type", "application/json").body(saved.to_string()).send().await.unwrap();
    assert_eq!(put.status().as_u16(), 200, "조건 0줄 조건식도 저장한다");
    server.stop().await;

    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    let read_back: Value = serde_json::from_str(&reqwest::get(format!("http://{}/api/screens", server.addr().await)).await.unwrap().text().await.unwrap()).unwrap();
    assert_eq!(read_back, saved, "서버를 다시 켜도 조건 0줄 조건식이 그대로 남는다");

    let counted = |listed_too_short: u32, unconfirmed: u32| json!({"listedTooShort": listed_too_short, "historyShort": 0, "unconfirmed": unconfirmed});
    let cases = [
        ("시장도 제외도 고르지 않음", 6, counted(1, 1), vec!["200010", "200020", "200030", "200040"]),
        ("코스닥만 고르고 관리종목을 뺌", 2, counted(0, 1), vec!["200030"]),
        ("코스피만 고르고 ETF를 뺌", 2, counted(1, 0), vec!["200010"]),
    ];
    for (screen, (case, universe, want_excluded, want)) in read_back["screens"].as_array().unwrap().iter().zip(cases) {
        let result = api.result(screen).await;
        let want: Vec<String> = want.into_iter().map(|code| hit(code, today)).collect();
        assert_eq!(
            (result["asOf"].clone(), result["universe"].clone(), result["excluded"].clone(), hits(&result)),
            (json!(today.to_string()), json!(universe), want_excluded, want),
            "{case}: 맞은 날짜는 기준 관측일이다. 기준 관측일 뒤에 상장하는 200060은 상장 기간 부족, 거래를 멈춘 200050은 확인 안 됨이다"
        );
    }
    let everything = api.result(&read_back["screens"][0]).await;
    assert_eq!(price_and_change(&everything, "200010"), (json!(110.0), json!(10.0)));
    assert_eq!(price_and_change(&everything, "200030"), (json!(100.0), Value::Null), "직전 일봉이 없으면 등락률이 없다");
    assert_eq!(price_and_change(&everything, "200040"), (json!(120.0), json!(20.0)), "거래량 0인 날은 봉이 아니라 마지막 거래일 종가와 그 직전 일봉 대비다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_market_cap_first_line_leaves_the_matched_date_to_the_next_bar_line_and_to_the_as_of_day_without_one() {
    let days = fortnight();
    let (monday, today) = (day(2026, 11, 2), days[14]);
    let peaked = stock("200010", priced(&days, |i| if i == 11 { 300 } else { 100 }));
    let upcoming = KrxStock { reg_day: day(2026, 11, 9), bars: vec![], ..stock("200020", priced(&days, |_| 100)) };
    let session = loaded(KrxMarket { days: days.clone(), stocks: vec![peaked, upcoming] }).await;
    let api = &session.api;
    let at_least = |won: f64| market_cap(Some(won), None);
    let cases = [
        ("다음 줄이 일봉", every(vec![at_least(1e8), new_high("D", "high", 5, 5)]), vec![hit("200010", days[11])]),
        ("다음 줄이 주봉", every(vec![at_least(1e8), new_high("W", "high", 2, 1)]), vec![hit("200010", monday)]),
        ("봉으로 따지는 줄이 없음", every(vec![at_least(1e8)]), vec![hit("200010", today)]),
        ("시가총액이 1원 모자람", every(vec![at_least(1e8 + 1.0), new_high("D", "high", 5, 5)]), vec![]),
    ];
    for (case, screen, want) in cases {
        let result = api.result(&screen).await;
        assert_eq!(
            (result["excluded"].clone(), hits(&result)),
            (excluded(1, 0), want),
            "{case}: 200010의 시가총액은 100원 × 1,000,000주다. 기준 관측일 뒤에 상장하는 200020은 봉으로 따지는 줄이 없어도 상장 기간 부족이다"
        );
    }
}

const LARGE_STOCKS: usize = 4_000;
const LARGE_BARS: usize = 3_000;

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

fn fill_large_store(path: &Path, days: &[KstDate]) {
    let store = Store::open(path).unwrap();
    let codes: Vec<StockCode> = (0..LARGE_STOCKS).map(|i| StockCode::parse(&format!("{:05}0", 10_000 + i)).unwrap()).collect();
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

#[tokio::test(flavor = "multi_thread")]
async fn a_screen_over_4000_stocks_collects_all_summaries_and_judges_thousands_of_bars() {
    let days = last_open_days(LARGE_BARS, day(2026, 11, 6));
    let today = *days.last().unwrap();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    std::fs::DirBuilder::new().mode(0o700).create(dir.path().join("run")).unwrap();
    let path = dir.path().join("run/screener.duckdb");
    let filling = Instant::now();
    let stored = days.clone();
    tokio::task::spawn_blocking(move || fill_large_store(&path, &stored)).await.unwrap();
    eprintln!("가짜 저장소 {LARGE_STOCKS}종목 × {LARGE_BARS}봉을 {:?}에 채웠습니다", filling.elapsed());

    let fake = FakeKiwoom::start().await;
    fake.set_quote_rows((0..LARGE_STOCKS).map(|i| {
        let code = format!("{:05}0", 10_000 + i);
        summary_row(&code, today, 100, 100, 1000, 0)
    }).collect());
    fake.set_krx_market(KrxMarket { days, stocks: vec![] });
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    assert_eq!(api.status().await["lastDay"], json!(today.to_string()));
    let bar_lines = Duration::from_secs(2);
    let screens = [
        ("일봉 고가 200일 신고가가 최근 5일 안", screen("D", &[("high", 200, 5)], &[]), bar_lines),
        ("일봉 거래량 2,900일 신고거래량이 최근 20일 안", screen("D", &[("volume", 2_900, 20)], &[]), bar_lines),
        ("주봉 종가 52주 신고가가 최근 4주 안", screen("W", &[("close", 52, 4)], &[]), bar_lines),
        ("월봉 고가 120개월 신고가가 이번 달", screen("M", &[("high", 120, 1)], &[]), bar_lines),
        (
            "일봉 20일 전 대비 +10% 이상이면서 주봉 거래량 급증, 일봉 고점 거리, 월봉 거래대금 범위",
            every(vec![
                change("D", 5, 20, Some(10.0), None),
                surge("W", 2, "volume", 10, 1.2),
                near_extreme("D", 1, "high", 250, 30.0),
                value_range("M", 1, "traded_value", Some(1_000_000.0), None),
            ]),
            bar_lines,
        ),
        ("시가총액 1,000억 원 이상", every(vec![market_cap(Some(100_000_000_000.0), None)]), bar_lines),
        (
            "지표 여덟 종류와 봉 조건 둘의 일·주·월봉 10줄",
            every(vec![
                indicator("ma_position", "D", 1, json!({"field": "close", "method": "sma", "length": 20, "side": "above"})),
                indicator("ma_alignment", "D", 20, json!({"method": "sma", "lengths": [5, 20, 60, 120], "order": "bullish"})),
                indicator("ma_cross", "D", 60, json!({"method": "ema", "fast": null, "slow": 20, "direction": "up"})),
                indicator("rsi", "D", 1, json!({"length": 14, "test": {"kind": "range", "min": 30.0, "max": null}})),
                indicator("macd", "W", 26, json!({"fast": 12, "slow": 26, "signal": 9, "test": {"kind": "signal_cross", "direction": "up"}})),
                indicator("stochastic", "D", 5, json!({"k": 5, "d": 3, "smooth": 3, "test": {"kind": "range", "min": 20.0, "max": null}})),
                indicator("bollinger", "M", 24, json!({"length": 20, "k": 1.0, "test": {"kind": "outside", "side": "above"}})),
                indicator("ichimoku", "W", 1, json!({"conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cloud", "side": "above"}})),
                near_extreme("D", 1, "high", 250, 30.0),
                change("D", 5, 20, Some(-50.0), None),
            ]),
            Duration::from_secs(3),
        ),
    ];
    for (label, screen, limit) in &screens {
        let mut took = Vec::new();
        let mut result = Value::Null;
        for _ in 0..3 {
            let started = Instant::now();
            result = api.result(screen).await;
            took.push(started.elapsed());
        }
        let rows = result["rows"].as_array().unwrap().len();
        eprintln!("{label}: {took:?}, 결과 {rows}종목");
        assert_eq!((result["universe"].clone(), result["excluded"].clone()), (json!(LARGE_STOCKS), excluded(0, 0)), "{label}");
        assert!(rows > 0, "{label}: 판정이 실제로 돌았다면 맞는 종목이 있다");
        assert_eq!(result["missingSummary"], 0);
        let collection_budget = Duration::from_secs(12);
        assert!(took.iter().all(|t| *t < *limit + collection_budget), "{label}: {took:?}");
    }
    server.stop().await;
}

fn with_recent(mut condition: Value, count: u64) -> Value {
    condition["recentBars"] = json!(count);
    condition
}

#[tokio::test(flavor = "multi_thread")]
async fn recent_periods_skip_empty_days_weeks_and_months_and_conditions_match_independently() {
    let days = open_days(day(2026, 1, 1), day(2026, 11, 6), &[]);
    let mut traded: Vec<KstDate> = days.iter().copied().filter(|d| d.day() == 5).take(10).collect();
    for month in 1..=10 {
        let first = *days.iter().find(|d| d.month() == month).unwrap();
        if !traded.iter().any(|d| d.month() == month) { traded.push(first); }
    }
    traded.sort();
    traded.truncate(10);
    let prices = [100, 200, 150, 400, 350, 600, 550, 800, 750, 700];
    let mut bars: Vec<KrxBar> = traded.iter().enumerate().map(|(i, &d)| bar(d, prices[i], if i == 7 { 100 } else { i as u64 + 1 })).collect();
    bars.push(bar(*days.last().unwrap(), 99_999, 0));
    let session = loaded(KrxMarket { days, stocks: vec![stock("200010", bars)] }).await;
    for period in ["D", "W", "M"] {
        let matched = |i: usize| vec![hit("200010", cell_start(period, traded[i]))];
        let value = |count, price: f64| every(vec![with_recent(value_range(period, 1, "close", Some(price), Some(price)), count)]);
        for (count, price, index) in [(1, 700.0, 9), (2, 750.0, 8), (3, 800.0, 7), (4, 550.0, 6)] {
            assert_eq!(hits(&session.api.result(&value(count, price)).await), matched(index), "{period} {count}");
        }
        assert!(hits(&session.api.result(&value(1, 750.0)).await).is_empty());
        assert!(hits(&session.api.result(&value(20, 99_999.0)).await).is_empty(), "없는 봉은 후보가 아니다");
        let first = with_recent(value_range(period, 1, "close", Some(800.0), Some(800.0)), 4);
        let last = value_range(period, 1, "close", Some(700.0), None);
        assert_eq!(hits(&session.api.result(&every(vec![first, last])).await), matched(7), "각 조건은 서로 다른 봉에서 맞고 첫 줄의 최근 일치가 날짜다");
        let past = [
            new_high(period, "high", 3, 1),
            near_extreme(period, 1, "high", 3, 0.0),
            change(period, 1, 1, Some(40.0), None),
            surge(period, 1, "volume", 2, 2.0),
            indicator("ma_position", period, 1, json!({"field": "close", "method": "sma", "length": 2, "side": "above"})),
        ];
        for condition in past {
            assert_eq!(hits(&session.api.result(&every(vec![with_recent(condition.clone(), 3)])).await), matched(7), "{condition}: 과거 후보는 미래 봉을 읽지 않고 실제 봉으로 계산한다");
        }
        assert_eq!(hits(&session.api.result(&every(vec![new_high(period, "high", 8, 3)])).await), matched(7));
        assert_eq!(session.api.result(&every(vec![new_low(period, "low", 11, 1)])).await["excluded"], excluded(1, 0), "달력에 충분한 칸이 있어도 실제 봉은 열 개다");
    }
}

async fn intraday_session(today: KstDate, count: usize, hhmm: &str) -> Loaded {
    let days = last_open_days(20, today.add_days(-1));
    let stocks = (0..count).map(|i| stock(&format!("{:06}", 300000 + i), priced(&days, |_| 100))).collect();
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = loaded(KrxMarket { days: days.clone(), stocks }).await;
    server.stop().await;
    let observed = if hhmm >= "0900" && !matches!(today.weekday(), Weekday::Sat | Weekday::Sun) { [days, vec![today]].concat() } else { days };
    fake.set_krx_market(KrxMarket { days: observed, stocks: vec![] });
    let server = boot(&fake, dir.path(), &at(today, hhmm));
    let api = Api::of(&server).await;
    Loaded { _fake: fake, _dir: dir, _server: server, api }
}

fn summary_row(code: &str, today: KstDate, close: u64, high: u64, volume: u64, traded: u64) -> Value {
    fake_kiwoom::summary::row(code, KrxBar { day: today, open: 100, high, low: 90, close, volume, traded_million_won: traded, base: 100, adjustment_rate: None }, "090000")
}

#[tokio::test(flavor = "multi_thread")]
async fn intraday_values_indicators_caps_and_results_share_one_overlay_and_reverted_crosses_disappear() {
    let today = day(2026, 11, 9);
    let session = intraday_session(today, 1, "1200").await;
    let (api, fake) = (&session.api, &session._fake);
    let cross = every(vec![indicator("ma_cross", "D", 1, json!({"method": "sma", "fast": null, "slow": 3, "direction": "up"}))]);
    fake.set_quote_rows(vec![summary_row("300000", today, 120, 150, 3_000, 17)]);
    let result = api.result(&cross).await;
    let evidence = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/issue-219");
    std::fs::create_dir_all(&evidence).unwrap();
    std::fs::write(evidence.join("intraday-response.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    assert_eq!(hits(&result), [hit("300000", today)]);
    assert_eq!(price_and_change(&result, "300000"), (json!(120.0), json!(20.0)));
    assert_eq!(row(&result, "300000")["latestBarDate"], today.to_string());
    assert_eq!(row(&result, "300000")["provisional"], true);
    assert_eq!(result["asOf"], today.to_string());
    assert_eq!(result["missingSummary"], 0);
    assert!(result["collectionStartedAt"].as_i64().unwrap() <= result["collectionCompletedAt"].as_i64().unwrap());
    let combined = every(vec![value_range("D", 1, "high", Some(150.0), Some(150.0)), surge("D", 1, "volume", 3, 3.0), value_range("D", 1, "traded_value", Some(17_000_000.0), Some(17_000_000.0)), market_cap(Some(120_000_000.0), Some(120_000_000.0))]);
    assert_eq!(hits(&api.result(&combined).await), [hit("300000", today)]);
    assert_eq!(price_and_change(&api.result(&every(vec![])).await, "300000"), (json!(120.0), json!(20.0)));
    for (period, matched) in [("W", today), ("M", day(2026, 11, 1))] {
        assert_eq!(hits(&api.result(&every(vec![value_range(period, 1, "close", Some(120.0), Some(120.0))])).await), [hit("300000", matched)]);
    }
    fake.set_quote_rows(vec![summary_row("300000", today, 95, 110, 500, 2)]);
    assert!(hits(&api.result(&cross).await).is_empty());
    assert!(hits(&api.result(&combined).await).is_empty());
    let past = every(vec![with_recent(new_high("D", "high", 3, 1), 2)]);
    assert_eq!(hits(&api.result(&past).await), [hit("300000", day(2026, 11, 6))]);
    assert_eq!(api.status().await["lastDay"], "2026-11-06");
    let Loaded { _server: server, _dir: dir, .. } = session;
    server.stop().await;
    let store = Store::open(&dir.path().join("run/screener.duckdb")).unwrap();
    assert!(store.bars_from(StockCode::parse("300000").unwrap(), today).unwrap().is_empty());
    assert_eq!(store.summary().unwrap().last_day, Some(day(2026, 11, 6)));
}

#[tokio::test(flavor = "multi_thread")]
async fn intraday_week_month_ohlcv_and_boundary_values_are_added_once_and_finalized_day_wins() {
    for today in [day(2026, 11, 9), day(2026, 12, 1)] {
        let session = intraday_session(today, 1, "1200").await;
        session._fake.set_quote_rows(vec![summary_row("300000", today, 120, 150, 3_000, 17)]);
        let previous_days = last_open_days(20, today.add_days(-1));
        for period in ["W", "M"] {
            let bucket = if period == "W" { domain::Period::Week } else { domain::Period::Month }.bucket(domain::KstTime::from_kst_civil(today, domain::TimeOfDay::MIDNIGHT));
            let prior = previous_days.iter().filter(|&&d| bucket.contains(domain::KstTime::from_kst_civil(d, domain::TimeOfDay::MIDNIGHT))).count() as f64;
            let conditions = [("open", 100.0), ("high", 150.0), ("low", 90.0), ("close", 120.0), ("volume", prior * 1000.0 + 3000.0), ("traded_value", 17_000_000.0)].into_iter().map(|(field, value)| value_range(period, 1, field, Some(value), Some(value))).collect();
            assert_eq!(hits(&session.api.result(&every(conditions)).await), [hit("300000", bucket.start().kst_date())]);
        }
    }
    let today = day(2026, 11, 6);
    let session = loaded(KrxMarket { days: fortnight(), stocks: vec![stock("300000", priced(&fortnight(), |_| 100))] }).await;
    session._fake.set_quote_rows(vec![summary_row("300000", today, 120, 150, 9000, 17)]);
    let result = session.api.result(&every(vec![value_range("D", 1, "volume", Some(1000.0), Some(1000.0)), value_range("W", 1, "volume", Some(5000.0), Some(5000.0)), value_range("M", 1, "volume", Some(5000.0), Some(5000.0))])).await;
    assert_eq!(price_and_change(&result, "300000"), (json!(100.0), json!(0.0)));
    assert_eq!(row(&result, "300000")["provisional"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn intraday_no_trades_missing_other_dates_and_unreadable_rows_remain_distinct() {
    for (today, hhmm) in [(day(2026, 11, 9), "0755"), (day(2026, 11, 14), "1200")] {
        let session = intraday_session(today, 5, hhmm).await;
        let mut no_trades = summary_row("300000", today, 0, 0, 0, 0);
        for key in ["open_pric", "high_pric", "low_pric", "cntr_tm"] { no_trades[key] = "".into(); }
        for key in ["open_pric", "high_pric", "low_pric"] { no_trades[key] = "0".into(); }
        let mut old = no_trades.clone(); old["stk_cd"] = "300001".into(); old["dt"] = today.add_days(-2).yyyymmdd().into();
        let mut unreadable = no_trades.clone(); unreadable["stk_cd"] = "300002".into(); unreadable["dt"] = "bad".into();
        let mut halted = no_trades.clone(); halted["stk_cd"] = "300004".into(); halted["cur_prc"] = "100".into();
        session._fake.set_quote_rows(vec![no_trades, old, unreadable, halted]);
        let result = session.api.result(&every(vec![])).await;
        assert_eq!(result["missingSummary"], 3);
        assert_eq!(result["rows"].as_array().unwrap().len(), 2);
        for code in ["300000", "300004"] {
            assert_eq!(row(&result, code)["latestBarDate"], result["asOf"]);
            assert_eq!(row(&result, code)["provisional"], false);
            assert_eq!(row(&result, code)["close"], 100.0);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn intraday_different_conditions_share_full_listing_collection_and_failures_never_return_partial_results() {
    let today = day(2026, 11, 9);
    let session = intraday_session(today, 101, "1200").await;
    let rows: Vec<_> = (0..101).map(|i| summary_row(&format!("{:06}", 300000 + i), today, 120, 150, 3000, 17)).collect();
    session._fake.set_quote_rows(rows.clone());
    session._fake.delay("ka10095", Duration::from_millis(200));
    let seen = session._fake.calls().iter().filter(|c| c.api_id == "ka10095").count();
    let all = every(vec![]);
    let none = lines(vec![market_cap(Some(1_000_000_000.0), None)], &["kosdaq"]);
    let (a, b) = tokio::join!(session.api.result(&all), session.api.result(&none));
    assert_eq!(a["rows"].as_array().unwrap().len(), 101);
    assert_eq!(b["universe"], 0);
    assert_eq!(a["collectionStartedAt"], b["collectionStartedAt"]);
    assert_eq!(session._fake.calls().iter().filter(|c| c.api_id == "ka10095").count() - seen, 2);
    let fail = || fake_kiwoom::ScriptedReply { status: 200, body: json!({"return_code": 2, "return_msg": "[1501:입력 오류]"}), delay: Duration::ZERO };
    for replies in [vec![fail()], vec![fake_kiwoom::ScriptedReply { status: 200, body: json!({"return_code": 0, "atn_stk_infr": &rows[..100]}), delay: Duration::ZERO }, fail()]] {
        session._fake.script("ka10095", replies);
        let (status, body) = session.api.run(&all).await;
        assert_ne!(status, 200, "{body}");
        assert!(body["rows"].is_null());
        assert!(!body["error"].is_null());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn intraday_adjustment_and_same_day_history_updates_abort_the_whole_result() {
    let today = day(2026, 11, 9);
    let session = intraday_session(today, 1, "1200").await;
    let mut adjusted = summary_row("300000", today, 120, 150, 3000, 17);
    adjusted["base_pric"] = "50".into();
    session._fake.set_quote_rows(vec![adjusted]);
    let (status, body) = session.api.run(&every(vec![])).await;
    assert_eq!((status, body["error"]["reason"].clone()), (409, json!("data_changed")));
    drop(session);
    let session = intraday_session(today, 1, "1200").await;
    session._fake.set_quote_rows(vec![summary_row("300000", today, 120, 150, 3000, 17)]);
    session._fake.delay("ka10095", Duration::from_millis(500));
    let seen = session._fake.calls().iter().filter(|call| call.api_id == "ka10095").count();
    let request = every(vec![]);
    let running = session.api.run(&request);
    let update = async {
        while session._fake.calls().iter().filter(|call| call.api_id == "ka10095").count() == seen { tokio::time::sleep(Duration::from_millis(5)).await; }
        session.api.update().await;
    };
    let ((status, body), _) = tokio::join!(running, update);
    assert_eq!(status, 409, "{body}");
    assert!(body["rows"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn intraday_midnight_during_collection_returns_an_error_without_rows() {
    let today = day(2026, 11, 9);
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = intraday_session(today, 1, "1200").await;
    server.stop().await;
    fake.set_quote_rows(vec![summary_row("300000", today, 120, 150, 3000, 17)]);
    fake.delay("ka10095", Duration::from_millis(1500));
    let server = Server::spawn_with(&fake, &dir.path().join("run/server.lock"), dir.path(), &[("VALLY_CLOCK_START", OsStr::new("20261109235959"))]);
    let api = Api::of(&server).await;
    let (status, body) = api.run(&every(vec![])).await;
    assert_eq!((status, body["error"]["reason"].clone()), (409, json!("data_changed")));
    assert!(body["rows"].is_null());
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn intraday_backfill_committing_during_collection_invalidates_the_same_update_generation() {
    let today = day(2026, 11, 6);
    let days = last_open_days(700, today);
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![stock("300000", priced(&days, |_| 100))] });
    fake.delay("ka10081", Duration::from_millis(500));
    let dir = tempfile::tempdir().unwrap();
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    api.update().await;
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    fake.delay("ka10095", Duration::from_millis(1000));
    let (status, body) = api.run(&every(vec![])).await;
    assert_eq!((status, body["error"]["reason"].clone()), (409, json!("data_changed")));
    assert!(body["rows"].is_null());
    assert_eq!(api.settled().await["fullHistory"], json!({"done": 1, "total": 1}));
    server.stop().await;
}

fn review_evidence(name: &str, value: &Value) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/review-fix-223");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.json")), serde_json::to_vec_pretty(value).unwrap()).unwrap();
    eprintln!("{name}: {value}");
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_previous_date_on_closed_and_preopen_days() {
    let mut outcomes = Vec::new();
    for (today, hhmm) in [(day(2026, 11, 9), "0755"), (day(2026, 11, 14), "1200"), (day(2026, 11, 9), "1200"), (day(2026, 11, 9), "0830")] {
        let session = intraday_session(today, 1, hhmm).await;
        let previous = *last_open_days(1, today.add_days(-1)).last().unwrap();
        session._fake.set_quote_rows(vec![summary_row("300000", previous, 100, 100, 1000, 1)]);
        let result = session.api.result(&every(vec![])).await;
        if hhmm == "0755" || today.weekday() == Weekday::Sat {
            assert_eq!(result["missingSummary"], 0);
            assert_eq!(row(&result, "300000")["latestBarDate"], previous.to_string());
            assert_eq!(row(&result, "300000")["provisional"], false);
        } else {
            assert_eq!(result["missingSummary"], 1);
            assert_eq!(result["rows"], json!([]));
        }
        outcomes.push(json!({"today": today.to_string(), "hhmm": hhmm, "quoteDate": previous.to_string(), "result": result}));
    }
    review_evidence("previous-date", &json!(outcomes));
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_adjustment_normal_update_recovers() {
    let today = day(2026, 11, 9);
    let days = last_open_days(20, today.add_days(-1));
    let initial = KrxMarket { days: days.clone(), stocks: vec![stock("300000", priced(&days, |_| 100)), stock("300001", priced(&days, |_| 100))] };
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = loaded(initial).await;
    server.stop().await;
    let mut split = stock("300001", priced(&[days.clone(), vec![today]].concat(), |_| 50));
    split.market_code = "10".into();
    fake.set_krx_market(KrxMarket { days: [days.clone(), vec![today]].concat(), stocks: vec![stock("300000", priced(&[days.clone(), vec![today]].concat(), |_| 100)), split] });
    let mut adjusted = summary_row("300001", today, 50, 50, 1000, 1);
    adjusted["open_pric"] = "50".into(); adjusted["low_pric"] = "50".into(); adjusted["base_pric"] = "50".into();
    fake.set_quote_rows(vec![summary_row("300000", today, 100, 100, 1000, 1), adjusted]);
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    let screen = lines(vec![], &["kospi"]);
    let before = api.run(&screen).await;
    api.update().await; let updated = api.settled().await;
    let after = api.run(&screen).await;
    assert_eq!((before.0, after.0), (409, 200));
    assert_eq!(after.1["rows"].as_array().unwrap().len(), 1);
    assert_eq!(api.post("update", json!({"full": true})).await.0, 200);
    let full = api.settled().await;
    let recovered = api.run(&screen).await;
    assert_eq!(recovered.0, 200, "{recovered:?}");
    assert_eq!(recovered.1["rows"].as_array().unwrap().len(), 1);
    review_evidence("adjustment-update", &json!({"before": before, "normalUpdate": updated, "afterNormalUpdate": after, "fullUpdate": full, "afterFullUpdate": recovered}));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_withheld_stock_does_not_block_full_refetch() {
    let today = day(2026, 11, 6);
    let days = last_open_days(20, today);
    let mut withheld = stock("300001", priced(&days, |_| 100));
    withheld.daily = DailyAnswer::EmptyRow;
    withheld.market_code = "10".into();
    let session = loaded(KrxMarket { days: days.clone(), stocks: vec![stock("300000", priced(&days, |_| 100)), withheld] }).await;
    let screen = lines(vec![], &["kospi"]);
    let before = session.api.result(&screen).await;
    assert_eq!(before["rows"].as_array().unwrap().len(), 1);
    assert_eq!(session.api.post("update", json!({"full": true})).await.0, 200);
    let full = session.api.settled().await;
    let after = session.api.run(&screen).await;
    session.api.update().await; let normal = session.api.settled().await;
    let repeated = session.api.run(&screen).await;
    assert_eq!((after.0, repeated.0), (200, 200));
    assert_eq!(after.1["rows"].as_array().unwrap().len(), 1);
    review_evidence("withheld-refetch", &json!({"before": before, "fullUpdate": full, "afterFullUpdate": after, "normalUpdate": normal, "afterNormalUpdate": repeated}));
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_first_listing_day_uses_overlay_for_history_readiness() {
    let today = day(2026, 11, 9);
    let days = last_open_days(20, today.add_days(-1));
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = loaded(KrxMarket { days: days.clone(), stocks: vec![stock("300000", priced(&days, |_| 100))] }).await;
    server.stop().await;
    fake.set_krx_market(KrxMarket { days: [days, vec![today]].concat(), stocks: vec![stock("300000", vec![bar(today, 100, 1000)]), stock("300001", vec![bar(today, 100, 1000)])] });
    fake.set_quote_rows(vec![summary_row("300000", today, 100, 100, 1000, 1), summary_row("300001", today, 100, 100, 1000, 1)]);
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    api.update().await; api.settled().await;
    let all = api.result(&every(vec![])).await;
    let one_bar = api.result(&every(vec![value_range("D", 1, "close", Some(100.0), Some(100.0))])).await;
    assert_eq!(all["universe"], 2);
    assert_eq!(all["excluded"]["listedTooShort"], 0);
    assert_eq!(one_bar["excluded"]["historyShort"], 0);
    assert_eq!(row(&all, "300001")["changeRate"], Value::Null);
    assert_eq!(row(&one_bar, "300001")["latestBarDate"], today.to_string());
    review_evidence("new-listing", &json!({"noConditions": all, "oneBarCondition": one_bar}));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_new_generation_cannot_join_old_collection() {
    let today = day(2026, 11, 9);
    let days = last_open_days(20, today.add_days(-1));
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = loaded(KrxMarket { days: days.clone(), stocks: vec![stock("300000", priced(&days, |_| 100))] }).await;
    server.stop().await;
    fake.set_krx_market(KrxMarket { days: [days.clone(), vec![today]].concat(), stocks: vec![stock("300000", priced(&[days.clone(), vec![today]].concat(), |_| 100))] });
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    let old_quote = summary_row("300000", today, 100, 100, 1000, 1);
    fake.script("ka10095", vec![fake_kiwoom::ScriptedReply { status: 200, body: json!({"return_code": 0, "atn_stk_infr": [old_quote]}), delay: Duration::from_secs(5) }]);
    let seen = fake.calls().iter().filter(|c| c.api_id == "ka10095").count();
    let screen = every(vec![]);
    let during = async {
        for _ in 0..1000 {
            if fake.calls().iter().filter(|c| c.api_id == "ka10095").count() > seen { break }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        fake.set_krx_market(KrxMarket { days: [days.clone(), vec![today]].concat(), stocks: vec![stock("300000", priced(&[days.clone(), vec![today]].concat(), |_| 90))] });
        assert_eq!(api.post("update", json!({"full": true})).await.0, 200);
        let updated = api.settled().await;
        let second = api.run(&screen).await;
        (updated, second)
    };
    let (first, (updated, second)) = tokio::join!(api.run(&screen), during);
    let fresh = api.run(&screen).await;
    review_evidence("generation-join", &json!({"originalRun": first, "fullUpdate": updated, "joinedAfterUpdate": second, "freshAfterCompletion": fresh, "summaryRequests": fake.calls().iter().filter(|c| c.api_id == "ka10095").count() - seen}));
    assert_eq!(first.0, 409);
    assert_eq!(second.0, 409);
    assert_eq!(second.1["error"]["reason"], "data_changed");
    assert_eq!(price_and_change(&fresh.1, "300000"), (json!(90.0), json!(0.0)));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_closed_day_evidence_never_hides_missing_rows_or_conflicting_today_trades() {
    for (today, hhmm) in [(day(2026, 11, 9), "0755"), (day(2026, 11, 14), "1200")] {
        let session = intraday_session(today, 3, hhmm).await;
        let previous = last_open_days(1, today.add_days(-1))[0];
        let mut unreadable = summary_row("300001", previous, 100, 100, 1000, 1);
        unreadable["cur_prc"] = "bad".into();
        session._fake.set_quote_rows(vec![summary_row("300000", previous, 100, 100, 1000, 1), unreadable]);
        let result = session.api.result(&every(vec![])).await;
        assert_eq!(result["missingSummary"], 2);
        assert_eq!(hits(&result), [hit("300000", previous)]);
        session._fake.set_quote_rows(vec![summary_row("300000", previous, 100, 100, 1000, 1), summary_row("300001", today, 100, 100, 1000, 1)]);
        let (status, body) = session.api.run(&every(vec![])).await;
        assert_eq!((status, body["error"]["reason"].clone()), (409, json!("data_changed")));
        assert!(body["rows"].is_null());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_new_listing_week_month_boundaries_require_only_existing_past_bars() {
    for today in [day(2026, 11, 9), day(2026, 12, 1)] {
        let days = last_open_days(20, today.add_days(-1));
        let Loaded { _fake: fake, _dir: dir, _server: server, .. } = loaded(KrxMarket { days: days.clone(), stocks: vec![stock("300000", priced(&days, |_| 100))] }).await;
        server.stop().await;
        let listing = stock("300001", vec![bar(today, 100, 1000)]);
        fake.set_krx_market(KrxMarket { days: [days.clone(), vec![today]].concat(), stocks: vec![stock("300000", priced(&[days, vec![today]].concat(), |_| 100)), listing] });
        fake.set_quote_rows(vec![summary_row("300000", today, 100, 100, 1000, 1), summary_row("300001", today, 100, 100, 1000, 1)]);
        let server = boot(&fake, dir.path(), &at(today, "1200"));
        let api = Api::of(&server).await;
        api.update().await; api.settled().await;
        for period in ["D", "W", "M"] {
            let one = api.result(&every(vec![value_range(period, 1, "close", Some(100.0), Some(100.0))])).await;
            assert_eq!(row(&one, "300001")["changeRate"], Value::Null);
            assert_eq!(row(&one, "300001")["latestBarDate"], today.to_string());
            let two = api.result(&every(vec![new_high(period, "close", 2, 1)])).await;
            assert_eq!(two["excluded"]["listedTooShort"], 1, "{period}: {two}");
            assert!(!hits(&two).iter().any(|hit| hit.starts_with("300001")));
        }
        server.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_adjustment_refetch_missing_midway_recovers_or_excludes_after_restart_and_delisting() {
    let today = day(2026, 11, 9);
    let days = last_open_days(20, today.add_days(-1));
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = loaded(KrxMarket { days: days.clone(), stocks: vec![stock("300000", priced(&days, |_| 100)), stock("300001", priced(&days, |_| 100))] }).await;
    server.stop().await;
    let mut market = KrxMarket { days: [days.clone(), vec![today]].concat(), stocks: vec![stock("300000", priced(&days, |_| 100)), stock("300001", priced(&days, |_| 50))] };
    market.stocks[1].bars.push(bar(today, 50, 1000));
    fake.set_krx_market(market.clone());
    let mut adjusted = summary_row("300001", today, 50, 50, 1000, 1);
    adjusted["open_pric"] = "50".into(); adjusted["low_pric"] = "50".into(); adjusted["base_pric"] = "50".into();
    fake.set_quote_rows(vec![summary_row("300000", today, 100, 100, 1000, 1), adjusted.clone()]);
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    assert_eq!(api.run(&every(vec![])).await.0, 409);
    fake.delay("ka10081", Duration::from_secs(5));
    api.update().await;
    api.wait_for("수정 이력 재수집", |s| s["update"]["phase"] == "backfill").await;
    api.cancel().await;
    assert_eq!(api.run(&every(vec![])).await.0, 409, "취소로 수정 확인 필요를 해제하지 않는다");
    server.stop().await;
    fake.delay("ka10081", Duration::ZERO);
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    fake.script("ka10081", vec![fake_kiwoom::ScriptedReply { status: 200, body: json!({"return_code": 2, "return_msg": "[1501:입력 오류]"}), delay: Duration::ZERO }]);
    api.update().await;
    let failed = api.wait_for("재수집 오류", |s| !s["update"]["error"].is_null()).await;
    assert!(!failed["update"]["error"].is_null());
    server.stop().await;
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    assert_eq!(api.run(&every(vec![])).await.0, 409, "수정 확인 필요는 재시작해도 남는다");
    let fake_kiwoom::krx::KrxPage::Page { mut body, .. } = fake_kiwoom::krx::respond(&market, "ka10081", &json!({"stk_cd": "300001"}), None).unwrap() else { panic!("일봉 페이지") };
    body["_headers"] = json!({"cont-yn": "Y", "next-key": "middle"});
    let mut missing = market.clone(); missing.stocks[1].daily = DailyAnswer::EmptyRow;
    let fake_kiwoom::krx::KrxPage::Page { body: empty, .. } = fake_kiwoom::krx::respond(&missing, "ka10081", &json!({"stk_cd": "300001"}), None).unwrap() else { panic!("빈 일봉") };
    fake.script("ka10081", vec![body, empty].into_iter().map(|body| fake_kiwoom::ScriptedReply { status: 200, body, delay: Duration::ZERO }).collect());
    fake.set_krx_market(missing.clone());
    api.update().await;
    assert_eq!(api.settled().await["unconfirmed"], 1);
    let result = api.result(&every(vec![])).await;
    assert_eq!(result["excluded"]["unconfirmed"], 1);
    assert_eq!(hits(&result), [hit("300000", today)]);
    api.update().await;
    assert_eq!(api.settled().await["unconfirmed"], 1, "계속 일봉이 없어도 업데이트가 끝나며 재확인한다");
    server.stop().await;
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    assert_eq!(api.result(&every(vec![])).await["excluded"]["unconfirmed"], 1);
    fake.set_krx_market(market);
    api.update().await; api.settled().await;
    let recovered = api.result(&every(vec![])).await;
    assert_eq!(recovered["rows"].as_array().unwrap().len(), 2);
    assert_eq!(row(&recovered, "300001")["close"], 50.0);
    adjusted["base_pric"] = "25".into();
    fake.set_quote_rows(vec![summary_row("300000", today, 100, 100, 1000, 1), adjusted]);
    assert_eq!(api.run(&every(vec![])).await.0, 409);
    server.stop().await;
    missing.stocks.pop();
    fake.set_krx_market(missing);
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let api = Api::of(&server).await;
    api.update().await; api.settled().await;
    assert_eq!(api.result(&every(vec![])).await["universe"], 1, "목록에서 빠진 수정 확인 이력이 전역 관문에 남지 않는다");
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_pre0800_evidence_expires_when_collection_crosses_0800() {
    let today = day(2026, 11, 9);
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = intraday_session(today, 1, "0755").await;
    server.stop().await;
    fake.set_quote_rows(vec![summary_row("300000", day(2026, 11, 6), 100, 100, 1000, 1)]);
    fake.delay("ka10095", Duration::from_millis(1500));
    let server = Server::spawn_with(&fake, &dir.path().join("run/server.lock"), dir.path(), &[("VALLY_CLOCK_START", OsStr::new("20261109075959"))]);
    let api = Api::of(&server).await;
    let result = api.result(&every(vec![])).await;
    assert_eq!(result["missingSummary"], 1);
    assert!(hits(&result).is_empty());
    server.stop().await;
}

async fn early_krx_session(hhmmss: &str) -> Loaded {
    let today = day(2026, 11, 9);
    let Loaded { _fake: fake, _dir: dir, _server: server, .. } = intraday_session(today, 1, "0815").await;
    server.stop().await;
    let clock = format!("20261109{hhmmss}");
    let server = Server::spawn_with(&fake, &dir.path().join("run/server.lock"), dir.path(), &[("VALLY_CLOCK_START", OsStr::new(&clock))]);
    let api = Api::of(&server).await;
    Loaded { _fake: fake, _dir: dir, _server: server, api }
}

fn early_krx_evidence(name: &str, responses: &Value) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/review-fix-223-2");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.json")), serde_json::to_vec_pretty(responses).unwrap()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_early_krx_previous_date_remains_missing_after_0800() {
    let mut responses = Vec::new();
    for time in ["080000", "081500", "082959"] {
        let session = early_krx_session(time).await;
        let mut quote = summary_row("300000", day(2026, 11, 6), 100, 100, 1000, 1);
        quote["cntr_tm"] = "153000".into();
        session._fake.set_quote_rows(vec![quote]);
        let (status, result) = session.api.run(&every(vec![])).await;
        responses.push(json!({"time": time, "status": status, "result": result}));
    }
    early_krx_evidence("early-previous", &json!(responses));
    for response in responses {
        assert_eq!(response["status"], 200, "{response}");
        assert_eq!(response["result"]["missingSummary"], 1, "{response}");
        assert_eq!(response["result"]["rows"], json!([]), "{response}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_early_krx_today_trade_is_used_after_0800() {
    let today = day(2026, 11, 9);
    let mut responses = Vec::new();
    for time in ["080000", "081500", "082959"] {
        let session = early_krx_session(time).await;
        let mut quote = summary_row("300000", today, 110, 110, 1000, 1);
        quote["cntr_tm"] = if time == "080000" { "080000" } else { "081000" }.into();
        session._fake.set_quote_rows(vec![quote]);
        let (status, result) = session.api.run(&every(vec![])).await;
        responses.push(json!({"time": time, "status": status, "result": result}));
    }
    early_krx_evidence("early-today", &json!(responses));
    for response in responses {
        assert_eq!(response["status"], 200, "{response}");
        let result = &response["result"];
        assert_eq!(result["missingSummary"], 0);
        assert_eq!(row(result, "300000")["latestBarDate"], today.to_string());
        assert_eq!(row(result, "300000")["provisional"], true);
        assert_eq!(price_and_change(result, "300000"), (json!(110.0), json!(10.0)));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn regression_223_early_krx_before_0800_distinguishes_current_from_absence() {
    let today = day(2026, 11, 9);
    let mut responses = Vec::new();
    for observed_today in [false, true] {
        let session = early_krx_session("075500").await;
        if observed_today {
            session._fake.set_krx_market(KrxMarket { days: [last_open_days(20, today.add_days(-1)), vec![today]].concat(), stocks: vec![] });
        }
        let mut quote = summary_row("300000", today, 110, 110, 1000, 1);
        quote["cntr_tm"] = "075000".into();
        session._fake.set_quote_rows(vec![quote]);
        let (status, result) = session.api.run(&every(vec![])).await;
        responses.push(json!({"observedToday": observed_today, "status": status, "result": result}));
    }
    early_krx_evidence("before-0800-current", &json!(responses));
    assert_eq!(responses[0]["status"], 409);
    assert_eq!(responses[0]["result"]["error"]["reason"], "data_changed");
    assert_eq!(responses[1]["status"], 200);
    assert_eq!(row(&responses[1]["result"], "300000")["latestBarDate"], today.to_string());
    assert_eq!(row(&responses[1]["result"], "300000")["provisional"], true);
}
