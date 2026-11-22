mod common;

use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use common::support::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
use common::{ScriptedTransport, Server};
use domain::{KstDate, Weekday};
use serde_json::{Value, json};

const GOLDEN: &str = "tests/screener_memory_golden.json";

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn at(day: KstDate, hhmm: &str) -> String {
    format!("{}{hhmm}00", day.yyyymmdd())
}

fn open_days(from: KstDate, through: KstDate) -> Vec<KstDate> {
    std::iter::successors(Some(from), |d| Some(d.add_days(1))).take_while(|d| *d <= through).filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)).collect()
}

fn walk(seed: u64, days: &[KstDate], volume_of: impl Fn(usize, u64) -> u64) -> Vec<KrxBar> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = move |below: u64| {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (state >> 33) % below
    };
    let mut close = 5_000 + next(50_000);
    days.iter()
        .enumerate()
        .map(|(i, &day)| {
            let open = close;
            close = (close * (9_600 + next(801)) / 10_000).max(100);
            let high = open.max(close) * (10_000 + next(150)) / 10_000;
            let low = open.min(close) * (10_000 - next(150)) / 10_000;
            let volume = volume_of(i, next(1_000_000));
            KrxBar { day, open, high, low, close, volume, traded_million_won: volume * close / 1_000_000, base: close, adjustment_rate: None }
        })
        .collect()
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

fn traded(i: usize, noise: u64) -> u64 {
    1_000 + noise + 30 * i as u64
}

fn market_of(days: &[KstDate]) -> Vec<KrxStock> {
    let without = |skip: &[usize]| -> Vec<KstDate> { days.iter().enumerate().filter(|(i, _)| !skip.contains(i)).map(|(_, &d)| d).collect() };
    let last = days.len() - 1;
    vec![
        stock("300001", walk(1, days, traded)),
        stock("300002", walk(2, days, |_, noise| 1_000 + noise)),
        stock("300003", walk(3, days, |i, noise| if (40..52).contains(&i) || i >= last - 2 { 0 } else { 1_000 + noise })),
        stock("300004", walk(4, &without(&[10, 11, 12, 55, 56, 90]), |_, noise| 1_000 + noise)),
        stock("300005", walk(5, &days[days.len() - 15..], |_, noise| 1_000 + noise)),
        KrxStock { market_code: "10".into(), ..stock("300006", walk(6, days, traded)) },
        KrxStock { market_code: "8".into(), ..stock("300007", walk(7, days, traded)) },
        KrxStock { audit_info: "관리종목".into(), ..stock("300008", walk(8, days, |_, noise| 1_000 + noise)) },
        stock("300009", walk(9, days, traded)),
        stock("300010", walk(10, days, |_, noise| 1_000 + noise)),
        KrxStock { listed_shares: Some(40_000_000), ..stock("300011", walk(11, days, traded)) },
        stock("300012", walk(12, &days[..days.len() - 30], |_, noise| 1_000 + noise)),
    ]
}

fn today_row(code: &str, today: KstDate, last_close: u64, close: u64, volume: u64) -> Value {
    let (high, low) = (close.max(last_close) + 20, close.min(last_close).saturating_sub(20).max(1));
    common::support::summary::row(code, KrxBar { day: today, open: last_close, high, low, close, volume, traded_million_won: volume * close / 1_000_000, base: last_close, adjustment_rate: None }, "100000")
}

struct Session {
    server: Server,
    base: String,
    client: reqwest::Client,
}

impl Session {
    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let resp = self.client.post(format!("{}/{path}", self.base)).header("content-type", "application/json").body(body.to_string()).send().await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
    }

    async fn status(&self) -> Value {
        serde_json::from_str(&self.client.get(format!("{}/status", self.base)).send().await.unwrap().text().await.unwrap()).unwrap()
    }

    async fn settled(&self) {
        for _ in 0..2_400 {
            let status = self.status().await;
            if !status["update"]["error"].is_null() {
                panic!("업데이트가 실패했다: {status}");
            }
            if status["update"].is_null() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("업데이트가 끝나지 않았다");
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

fn boot(fake: &ScriptedTransport, dir: &Path, clock_start: &str) -> Server {
    Server::spawn_with(fake, &dir.join("run/server.lock"), dir, &[("VALLY_CLOCK_START", OsStr::new(clock_start))])
}

async fn session_on(server: Server) -> Session {
    let base = format!("http://{}/api/screener", server.addr().await);
    Session { server, base, client: reqwest::Client::new() }
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

fn lines(conditions: Vec<Value>, markets: &[&str], exclude: &[&str]) -> Value {
    json!({"id": "S1", "name": "메모리 시험", "markets": markets, "exclude": exclude, "conditions": conditions})
}

fn fixed_screens() -> Vec<(String, Value)> {
    let mut screens: Vec<(String, Value)> = Vec::new();
    let mut add = |label: &str, conditions: Vec<Value>, markets: &[&str], exclude: &[&str]| screens.push((label.to_owned(), lines(conditions, markets, exclude)));
    add("조건 없음", vec![], &[], &[]);
    for period in ["D", "W", "M"] {
        for (field, n, m) in [("high", 5, 1), ("high", 20, 3), ("close", 3, 1), ("volume", 10, 2), ("traded_value", 4, 1)] {
            add(&format!("{period} 신고 {field} {n} {m}"), vec![new_high(period, field, n, m)], &[], &[]);
        }
        add(&format!("{period} 신저"), vec![new_low(period, "low", 4, 2)], &[], &[]);
        add(&format!("{period} 값 범위"), vec![value_range(period, 3, "close", Some(3_000.0), Some(40_000.0))], &[], &[]);
        add(&format!("{period} 변화율"), vec![change(period, 2, 2, Some(1.0), None)], &[], &[]);
        add(&format!("{period} 근접"), vec![near_extreme(period, 1, "high", 6, 3.0)], &[], &[]);
        add(&format!("{period} 급증"), vec![surge(period, 2, "volume", 3, 1.2)], &[], &[]);
    }
    add("긴 창 상장 짧음", vec![new_high("D", "high", 90, 1)], &[], &[]);
    add("월 긴 창", vec![new_high("M", "high", 5, 1)], &[], &[]);
    add("거래정지 구간", vec![new_high("D", "high", 3, 15)], &[], &[]);
    add("지표 이평 위치", vec![json!({"kind": "ma_position", "period": "D", "recentBars": 3, "field": "close", "method": "sma", "length": 20, "side": "above"})], &[], &[]);
    add("지표 이평 정렬", vec![json!({"kind": "ma_alignment", "period": "D", "recentBars": 1, "method": "ema", "lengths": [5, 20], "order": "bullish"})], &[], &[]);
    add("지표 골든크로스", vec![json!({"kind": "ma_cross", "period": "D", "recentBars": 5, "method": "sma", "fast": null, "slow": 20, "direction": "up"})], &[], &[]);
    add("지표 RSI", vec![json!({"kind": "rsi", "period": "D", "recentBars": 5, "length": 14, "test": {"kind": "range", "min": null, "max": 45.0}})], &[], &[]);
    add("지표 MACD 주봉", vec![json!({"kind": "macd", "period": "W", "recentBars": 3, "fast": 6, "slow": 13, "signal": 4, "test": {"kind": "signal_cross", "direction": "up"}})], &[], &[]);
    add("지표 볼린저 월봉", vec![json!({"kind": "bollinger", "period": "M", "recentBars": 1, "length": 4, "k": 1.0, "test": {"kind": "outside", "side": "above"}})], &[], &[]);
    add("시가총액", vec![new_high("D", "high", 3, 2), market_cap(Some(100_000_000.0), Some(30_000_000_000.0))], &[], &[]);
    add("여러 줄 서로 다른 봉", vec![value_range("W", 2, "close", Some(1_000.0), None), new_high("D", "volume", 5, 4)], &[], &[]);
    add("코스닥만", vec![new_high("D", "high", 3, 2)], &["kosdaq"], &[]);
    add("코스피만", vec![new_high("D", "high", 3, 2)], &["kospi"], &[]);
    add("ETF와 관리 제외", vec![new_high("D", "high", 3, 2)], &[], &["etf", "managed"]);
    add("주 월 일 섞음", vec![new_high("D", "high", 5, 1), value_range("W", 1, "close", Some(1.0), None), value_range("M", 1, "close", Some(1.0), None)], &[], &[]);
    screens
}

fn comparable(result: &Value) -> Value {
    let mut result = result.clone();
    let object = result.as_object_mut().unwrap();
    object.remove("collectionStartedAt");
    object.remove("collectionCompletedAt");
    result
}

#[tokio::test]
async fn memory_judging_gives_the_results_the_sql_judging_gave_over_a_fixed_input() {
    let today = day(2026, 11, 9);
    let days = open_days(day(2026, 3, 2), day(2026, 11, 6));
    let stocks = market_of(&days);
    let last_closes: Vec<(String, u64)> = stocks.iter().map(|s| (s.code.clone(), s.bars.last().unwrap().close)).collect();
    let fake = ScriptedTransport::new();
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks });
    let dir = tempfile::tempdir().unwrap();
    let stored = session_on(boot(&fake, dir.path(), &at(*days.last().unwrap(), "2030"))).await;
    assert_eq!(stored.post("update", json!({"full": false})).await.0, 200);
    stored.settled().await;
    stored.server.stop().await;

    fake.set_krx_market(KrxMarket { days: [days.clone(), vec![today]].concat(), stocks: vec![] });
    let quote = |code: &str, close: u64, volume: u64| {
        let last = last_closes.iter().find(|(c, _)| c == code).unwrap().1;
        today_row(code, today, last, close, volume)
    };
    let rows: Vec<Value> = last_closes
        .iter()
        .filter(|(code, _)| code != "300009")
        .map(|(code, last)| match code.as_str() {
            "300001" => quote(code, last * 11 / 10, 90_000_000),
            "300002" => quote(code, last * 9 / 10, 2_000),
            "300010" => quote(code, *last, 0),
            _ => quote(code, last * 101 / 100, 5_000_000),
        })
        .collect();
    fake.set_quote_rows(rows);
    let server = boot(&fake, dir.path(), &at(today, "1200"));
    let session = session_on(server).await;

    let mut results = serde_json::Map::new();
    for (label, screen) in fixed_screens() {
        results.insert(label, comparable(&session.result(&screen).await));
    }
    let results = Value::Object(results);
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join(GOLDEN);
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(&golden).unwrap()).unwrap();
    for (label, result) in results.as_object().unwrap() {
        assert_eq!(result, &expected[label], "{label}");
    }
    assert_eq!(results.as_object().unwrap().len(), expected.as_object().unwrap().len());
    assert!(results.as_object().unwrap().values().filter(|r| r["rows"].as_array().is_some_and(|rows| !rows.is_empty())).count() > 15, "고정 입력이 판정을 실제로 거치지 않는다");
    session.server.stop().await;
}

fn flat(code: &str, days: &[KstDate], price: u64) -> KrxStock {
    stock(code, days.iter().map(|&day| KrxBar { day, open: price, high: price, low: price, close: price, volume: 1_000, traded_million_won: 1, base: price, adjustment_rate: None }).collect())
}

fn symbols(result: &Value) -> Vec<(String, String, bool)> {
    result["rows"].as_array().unwrap().iter().map(|r| (r["symbol"].as_str().unwrap().to_owned(), r["latestBarDate"].as_str().unwrap().to_owned(), r["provisional"].as_bool().unwrap())).collect()
}

fn long_new_high() -> Value {
    lines(vec![new_high("D", "high", 650, 1)], &[], &[])
}

fn backfill_request(call: &common::support::Call) -> bool {
    call.api_id == "ka10081" && call.next_key.is_some()
}

#[tokio::test]
async fn a_run_after_the_backfill_judges_the_new_edition_and_a_run_held_across_it_is_refused() {
    let today = day(2026, 11, 6);
    let days: Vec<KstDate> = {
        let all = open_days(day(2010, 1, 1), today);
        all[all.len() - 700..].to_vec()
    };
    let fake = ScriptedTransport::new();
    fake.set_krx_market(KrxMarket { days: days.clone(), stocks: vec![flat("300001", &days, 100)] });
    let backfill = fake.hold("과거 이어 받기", backfill_request);
    let dir = tempfile::tempdir().unwrap();
    let session = session_on(boot(&fake, dir.path(), &at(today, "2030"))).await;
    assert_eq!(session.post("update", json!({"full": false})).await.0, 200);
    backfill.arrived().await;

    let before = session.result(&long_new_high()).await;
    assert_eq!((before["excluded"]["historyShort"].clone(), before["rows"].clone()), (json!(1), json!([])), "이어 받기 전 판은 650봉이 없다: {before}");

    let collecting = fake.hold("요약 수집", |call| call.api_id == "ka10095");
    let screen = long_new_high();
    let started_before_backfill = session.run(&screen);
    let backfill_meanwhile = async {
        collecting.arrived().await;
        backfill.release();
        for _ in 0..2_400 {
            if session.status().await["fullHistory"]["done"] == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        collecting.release();
    };
    let ((status, body), ()) = tokio::join!(started_before_backfill, backfill_meanwhile);
    assert_eq!((status, body["error"]["reason"].clone()), (409, json!("data_changed")), "이어 받기 전에 시작한 실행은 새 자료와 섞인 결과를 내지 않는다: {body}");
    session.settled().await;

    let after = session.result(&long_new_high()).await;
    assert_eq!((after["excluded"]["historyShort"].clone(), symbols(&after)), (json!(0), vec![("300001".into(), today.to_string(), false)]), "이어 받은 뒤의 실행은 새 판의 650봉으로 판정한다: {after}");
    session.server.stop().await;
}
