mod common;

use std::ffi::OsStr;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::time::{Duration, Instant};

use common::{FakeKiwoom, Server};
use domain::{KstDate, Ohlcv, Price, StockCode, Volume, Weekday};
use fake_kiwoom::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
use serde_json::{Value, json};
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
        quoted: true,
        daily: DailyAnswer::Bars,
        bars,
    }
}

fn new_high(period: &str, field: &str, n: u32, m: u32) -> Value {
    json!({"kind": "new_high", "period": period, "field": field, "n": n, "m": m})
}

fn new_low(period: &str, field: &str, n: u32, m: u32) -> Value {
    json!({"kind": "new_low", "period": period, "field": field, "n": n, "m": m})
}

fn value_range(period: &str, m: u32, field: &str, min: Option<f64>, max: Option<f64>) -> Value {
    json!({"kind": "value_range", "period": period, "m": m, "field": field, "min": min, "max": max})
}

fn change(period: &str, m: u32, back: u32, min_pct: Option<f64>, max_pct: Option<f64>) -> Value {
    json!({"kind": "change", "period": period, "m": m, "back": back, "minPct": min_pct, "maxPct": max_pct})
}

fn near_extreme(period: &str, m: u32, extreme: &str, n: u32, within_pct: f64) -> Value {
    json!({"kind": "near_extreme", "period": period, "m": m, "extreme": extreme, "n": n, "withinPct": within_pct})
}

fn surge(period: &str, m: u32, field: &str, n: u32, times: f64) -> Value {
    json!({"kind": "surge", "period": period, "m": m, "field": field, "n": n, "times": times})
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
async fn equal_values_are_new_highs_and_zero_volume_or_missing_days_are_no_bars_yet_still_cells() {
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
    assert_eq!(hits(&today), [hit("200010", days[14])], "같은 값도 가장 큰 값이다. 거래정지 날과 빠진 날의 봉은 없다");
    assert_eq!(
        hits(&api.result(&daily(&[("high", 5, 3)])).await),
        [hit("200010", days[14])],
        "거래량 0인 날은 정지 전 가격과 같아도 신고가 봉이 아니다"
    );
    assert_eq!(
        hits(&api.result(&daily(&[("high", 5, 4)])).await),
        [hit("200010", days[14]), hit("200020", days[11]), hit("200030", days[11])],
        "정지 전 마지막 거래일과 빠진 날 앞의 고점은 최근 4일 안의 신고가다"
    );
    assert_eq!(
        hits(&api.result(&daily(&[("high", 3, 2)])).await),
        [hit("200010", days[14]), hit("200030", days[14])],
        "봉이 빠진 날도 한 칸이라 3일 창은 고점 300을 넘어가지 않는다"
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
async fn a_traded_value_new_high_runs_while_indicator_market_cap_and_market_screens_are_refused_for_now() {
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

    let indicators = [
        json!({"kind": "ma_position", "period": "D", "m": 1, "field": "close", "method": "sma", "length": 20, "side": "above"}),
        json!({"kind": "ma_alignment", "period": "D", "m": 1, "method": "ema", "lengths": [5, 20], "order": "bullish"}),
        json!({"kind": "ma_cross", "period": "D", "m": 5, "method": "sma", "fast": null, "slow": 20, "direction": "up"}),
        json!({"kind": "rsi", "period": "D", "m": 1, "length": 14, "test": {"kind": "range", "min": null, "max": 30.0}}),
        json!({"kind": "macd", "period": "W", "m": 1, "fast": 12, "slow": 26, "signal": 9, "test": {"kind": "signal_cross", "direction": "up"}}),
        json!({"kind": "stochastic", "period": "D", "m": 1, "k": 5, "d": 3, "smooth": 3, "test": {"kind": "cross", "direction": "down"}}),
        json!({"kind": "bollinger", "period": "M", "m": 1, "length": 20, "k": 2.0, "test": {"kind": "outside", "side": "above"}}),
        json!({"kind": "ichimoku", "period": "D", "m": 1, "conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cloud", "side": "above"}}),
    ];
    let market_cap = json!({"kind": "market_cap", "min": 300_000_000_000.0, "max": null});
    let refused = indicators
        .into_iter()
        .map(|indicator| (format!("지표 {}", indicator["kind"]), lines(vec![new_high("D", "high", 5, 1), indicator], &[]), "2번째 조건: 지표 조건은 아직"))
        .chain([
            ("시가총액".to_owned(), lines(vec![new_high("D", "high", 5, 1), market_cap], &[]), "2번째 조건: 시가총액 조건은 아직"),
            ("시장".to_owned(), lines(vec![new_high("D", "high", 5, 1)], &["kospi"]), "시장으로 고르는 조건식은 아직"),
        ]);
    for (case, screen, why) in refused {
        let (status, body) = api.run(&screen).await;
        assert_eq!((status, body["error"]["code"].clone()), (400, json!("bad_request")), "{case}: {body}");
        assert!(body["error"]["message"].as_str().unwrap().contains(why), "{case}: 무엇이 아직 안 되는지 알린다: {body}");
    }
    let bad_rsi = json!({"kind": "rsi", "period": "D", "m": 1, "length": 14, "test": {"kind": "range", "min": 70.0, "max": 30.0}});
    let (status, body) = api.run(&lines(vec![bad_rsi], &[])).await;
    assert_eq!((status, body["error"]["code"].clone()), (400, json!("bad_request")), "저장과 같은 검사를 실행에도 한다: {body}");
    assert!(!body["error"]["message"].as_str().unwrap().contains("아직"), "{body}");
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

    assert_eq!(refusal(api.run(&new_high).await), (409, json!("screener_not_ready"), json!("missing_day")), "빈 저장소");
    assert_eq!(refusal(api.run(&daily(&[("high", 5, 6)])).await), (400, json!("bad_request"), Value::Null), "m이 n보다 크다");

    fake.delay("ka10081", Duration::from_millis(500));
    api.update().await;
    api.wait_for("최근 채우기", |s| s["update"]["phase"] == "recent").await;
    assert_eq!(refusal(api.run(&new_high).await), (409, json!("screener_not_ready"), json!("updating")));
    api.wait_for("과거 이어 받기", |s| s["update"]["phase"] == "backfill").await;
    let during_backfill = api.result(&new_high).await;
    assert_eq!((during_backfill["asOf"].clone(), hits(&during_backfill)), (json!(today.to_string()), vec![hit("200010", today), hit("200020", today)]), "과거 이어 받기 중에는 실행된다");
    fake.reset();
    api.settled().await;
    server.stop().await;

    let two_days_later = day(2026, 11, 10);
    fake.set_krx_market(KrxMarket { days: [days.clone(), vec![day(2026, 11, 9), two_days_later]].concat(), stocks: vec![] });
    let server = boot(&fake, dir.path(), &at(two_days_later, "1000"));
    let api = Api::of(&server).await;
    assert_eq!(api.status().await["needDay"], json!("2026-11-09"));
    assert_eq!(refusal(api.run(&new_high).await), (409, json!("screener_not_ready"), json!("missing_day")), "저장소의 마지막 관측일 11-06이 필요 관측일 11-09보다 이르다");
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
    assert_eq!((before["asOf"].clone(), before["universe"].clone(), hits(&before)), (json!(yesterday.to_string()), json!(1), vec![]), "어제 자료가 있어 저녁 업데이트 전에도 실행된다");

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
                assert_eq!(body["error"]["reason"], "updating", "{body}");
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
                assert_eq!(hits(body), [hit("200010", today)], "{body}");
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
    assert_eq!((today["excluded"].clone(), hits(&today)), (excluded(0, 0), vec![hit("200010", days[14]), hit("200030", days[14])]), "같은 값도 가장 작은 값이다. 200020은 이틀 전 80이 창에 있다");
    assert_eq!(
        hits(&api.result(&every(vec![new_low("D", "low", 5, 3)])).await),
        [hit("200010", days[14]), hit("200030", days[14]), hit("200040", days[13]), hit("200020", days[12])],
        "최근 3일 안의 마지막 신저가 봉이 맞은 날짜다. 200040은 오늘 거래정지라 오늘 봉이 없다"
    );
    assert_eq!(
        hits(&api.result(&every(vec![new_low("D", "volume", 5, 1)])).await),
        [hit("200010", days[14]), hit("200020", days[14]), hit("200030", days[14])],
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
    assert_eq!((two_back["excluded"].clone(), hits(&two_back)), (excluded(0, 0), vec![]), "200050은 칸이 3개라 상장 기간은 되지만 봉이 2개라 2봉 전 종가가 없다");
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
    let listing: Vec<ScreenerListing> = codes.iter().map(|&code| ScreenerListing { code, name: format!("가상{}", code.as_str()), listed_on: Some(days[0]), excludable_as: vec![] }).collect();
    store.replace_listing(&listing).unwrap();
    store.extend_calendar(days).unwrap();
    for (k, chunk) in codes.chunks(100).enumerate() {
        let writes: Vec<Write> = chunk.iter().enumerate().map(|(i, &code)| Write::Replace { code, bars: random_walk((k * 100 + i) as u64, days) }).collect();
        store.write(&writes).unwrap();
    }
    store.set_last_day(*days.last().unwrap()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screen_over_4000_stocks_with_thousands_of_bars_answers_within_2_seconds() {
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
    fake.set_krx_market(KrxMarket { days, stocks: vec![] });
    let server = boot(&fake, dir.path(), &at(today, "2030"));
    let api = Api::of(&server).await;
    assert_eq!(api.status().await["lastDay"], json!(today.to_string()));
    let screens = [
        ("일봉 고가 200일 신고가가 최근 5일 안", screen("D", &[("high", 200, 5)], &[])),
        ("일봉 거래량 2,900일 신고거래량이 최근 20일 안", screen("D", &[("volume", 2_900, 20)], &[])),
        ("주봉 종가 52주 신고가가 최근 4주 안", screen("W", &[("close", 52, 4)], &[])),
        ("월봉 고가 120개월 신고가가 이번 달", screen("M", &[("high", 120, 1)], &[])),
        (
            "일봉 20일 전 대비 +10% 이상이면서 주봉 거래량 급증, 일봉 고점 거리, 월봉 거래대금 범위",
            every(vec![
                change("D", 5, 20, Some(10.0), None),
                surge("W", 2, "volume", 10, 1.2),
                near_extreme("D", 1, "high", 250, 30.0),
                value_range("M", 1, "traded_value", Some(1_000_000.0), None),
            ]),
        ),
    ];
    for (label, screen) in &screens {
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
        assert!(took.iter().all(|t| *t < Duration::from_secs(2)), "{label}: {took:?}");
    }
    server.stop().await;
}
