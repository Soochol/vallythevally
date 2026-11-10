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

fn screen(period: &str, conditions: &[(&str, u32, u32)], exclude: &[&str]) -> Value {
    let conditions: Vec<Value> = conditions.iter().map(|(field, n, m)| json!({"field": field, "n": n, "m": m})).collect();
    json!({"id": "S1", "name": "시험 조건식", "period": period, "exclude": exclude, "conditions": conditions})
}

fn daily(conditions: &[(&str, u32, u32)]) -> Value {
    screen("D", conditions, &[])
}

fn hit(code: &str, day: KstDate) -> String {
    format!("{code} {day}")
}

fn hits(result: &Value) -> Vec<String> {
    result["rows"].as_array().unwrap().iter().map(|r| format!("{} {}", r["symbol"].as_str().unwrap(), r["highDate"].as_str().unwrap())).collect()
}

fn row<'a>(result: &'a Value, code: &str) -> &'a Value {
    result["rows"].as_array().unwrap().iter().find(|r| r["symbol"] == code).unwrap_or_else(|| panic!("{code}가 결과에 없습니다: {result}"))
}

fn price_and_change(result: &Value, code: &str) -> (Value, Value) {
    let r = row(result, code);
    (r["close"].clone(), r["changeRate"].clone())
}

fn excluded(listed_too_short: u32, history_short: u32) -> Value {
    json!({"listedTooShort": listed_too_short, "historyShort": history_short})
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
    assert_eq!(price_and_change(&this_week, "200010"), (json!(220.0), json!(10.0)), "종가는 마지막 봉, 등락률은 지난주 종가 200 대비다");
    assert_eq!(hits(&api.result(&screen("W", &[("high", 3, 1)], &[])).await), Vec::<String>::new(), "휴장한 주는 칸이 아니라 3주 창에 고가 300인 주가 든다");
    assert_eq!(hits(&api.result(&screen("W", &[("volume", 2, 1)], &[])).await), [hit("200020", day(2026, 11, 2))], "주봉 거래량은 일봉 거래량의 합이다");

    let this_month = api.result(&screen("M", &[("close", 2, 1)], &[])).await;
    assert_eq!(hits(&this_month), [hit("200010", day(2026, 11, 1))], "끝나지 않은 이번 달도 한 봉이고, 신고가 날짜는 그달 1일이다");
    assert_eq!(price_and_change(&this_month, "200010"), (json!(220.0), json!(10.0)), "등락률은 지난달 종가 200 대비다");
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
async fn runs_racing_into_recent_read_the_store_from_before_recent_or_are_refused() {
    let days = fortnight();
    let (yesterday, today) = (days[13], days[14]);
    let stopped_trading = stock("200020", priced(&days[..9], |_| 100));
    let delisted_today = stock("200030", priced(&days[..14], |_| 100));
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(KrxMarket { days: days[..14].to_vec(), stocks: vec![stopped_trading.clone(), delisted_today] });
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
    assert_eq!(
        (before["asOf"].clone(), before["universe"].clone(), hits(&before)),
        (json!(yesterday.to_string()), json!(2), vec![hit("200030", yesterday)]),
        "어제 자료가 있어 저녁 업데이트 전에도 실행된다"
    );

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
    let racing = futures::future::join_all((0..200).map(|_| api.run(&new_high))).await;
    let mut outcomes = std::collections::BTreeMap::new();
    for (status, body) in &racing {
        let outcome = match (*status, body["asOf"].as_str()) {
            (409, _) => {
                assert_eq!(body["error"]["reason"], "updating", "{body}");
                "refused"
            }
            (200, Some(d)) if d == yesterday.to_string() => {
                assert_eq!((body["universe"].clone(), body["excluded"].clone(), hits(body)), (json!(2), excluded(0, 1), vec![]), "최근 채우기 전의 저장소라 200010은 목록에만 있고 봉이 없다");
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
    for (k, chunk) in codes.chunks(100).enumerate() {
        let writes: Vec<Write> = chunk.iter().enumerate().map(|(i, &code)| Write::Replace { code, bars: random_walk((k * 100 + i) as u64, days) }).collect();
        store.write(&writes).unwrap();
    }
    store.set_last_day(*days.last().unwrap()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_condition_over_4000_stocks_with_thousands_of_bars_answers_within_2_seconds() {
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
