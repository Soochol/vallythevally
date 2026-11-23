mod common;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::support::krx::{DailyAnswer, KrxBar, KrxMarket, KrxStock};
use common::{ScriptedTransport, Server};
use domain::{KstDate, Weekday};
use serde_json::{Value, json};
use server::clock::kst;
use server::shared_data::{DataKind, Header, SnapshotBody, SnapshotRow, write_snapshot};

const QUOTE_API: &str = "ka10095";

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

fn flat_bar(day: KstDate) -> KrxBar {
    KrxBar { day, open: 100, high: 100, low: 100, close: 100, volume: 1_000, traded_million_won: 0, base: 100, adjustment_rate: None }
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
        bars: days.iter().map(|&d| flat_bar(d)).collect(),
    }
}

fn every(conditions: Vec<Value>) -> Value {
    json!({"id": "S1", "name": "시험 조건식", "markets": [], "exclude": [], "conditions": conditions})
}

fn volume_is(period: &str, volume: f64) -> Value {
    json!({"kind": "value_range", "period": period, "recentBars": 1, "field": "volume", "min": volume, "max": volume})
}

fn close_between(min: f64, max: f64) -> Value {
    json!({"kind": "value_range", "period": "D", "recentBars": 1, "field": "close", "min": min, "max": max})
}

struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn of(server: &Server) -> Api {
        Api { client: reqwest::Client::new(), base: format!("http://{}/api/screener", server.addr().await) }
    }

    fn copy(&self) -> Api {
        Api { client: self.client.clone(), base: self.base.clone() }
    }

    async fn run(&self, screen: &Value) -> (u16, Value) {
        let resp = self.client.post(format!("{}/run", self.base)).header("content-type", "application/json").body(screen.to_string()).send().await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
    }

    async fn warm_calendar(&self) {
        let resp = self.client.get(format!("{}/status", self.base)).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
    }

    async fn result(&self, screen: &Value) -> Value {
        let (status, body) = self.run(screen).await;
        assert_eq!(status, 200, "{screen} → {body}");
        body
    }

    async fn result_of_snapshot(&self, screen: &Value, as_of: i64) -> Value {
        for _ in 0..500 {
            let (status, body) = self.run(screen).await;
            if status == 200 && body["collectionStartedAt"] == json!(as_of) {
                return body;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("스냅샷 {as_of}로 판정한 결과를 10초 동안 보지 못했습니다");
    }
}

struct Session {
    fake: ScriptedTransport,
    dir: tempfile::TempDir,
    shared: PathBuf,
    today: KstDate,
    hhmm: &'static str,
}

impl Session {
    async fn prepare(today: KstDate, hhmm: &'static str, count: usize, stored: Vec<KrxDate>, calendar: Vec<KstDate>) -> Session {
        let fake = ScriptedTransport::new();
        fake.set_krx_market(KrxMarket { days: stored.clone(), stocks: (0..count).map(|i| stock(i, &stored)).collect() });
        let dir = tempfile::tempdir().unwrap();
        let first = Server::spawn_with(&fake, &dir.path().join("run/server.lock"), dir.path(), &[("VALLY_CLOCK_START", OsStr::new(&at(*stored.last().unwrap(), "2030")))]);
        let base = format!("http://{}/api/screener", first.addr().await);
        let client = reqwest::Client::new();
        client.post(format!("{base}/update")).header("content-type", "application/json").body(json!({"full": false}).to_string()).send().await.unwrap();
        for _ in 0..2_400 {
            let status: Value = serde_json::from_str(&client.get(format!("{base}/status")).send().await.unwrap().text().await.unwrap()).unwrap();
            if status["update"].is_null() && status["lastDay"] == json!(stored.last().unwrap().to_string()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        first.stop().await;
        fake.set_krx_market(KrxMarket { days: calendar, stocks: vec![] });
        let shared = dir.path().join("shared");
        Session { fake, dir, shared, today, hhmm }
    }

    fn boot(&self, with_shared: bool) -> Server {
        self.boot_with(with_shared, &[])
    }

    fn boot_with(&self, with_shared: bool, extra: &[(&str, &OsStr)]) -> Server {
        let clock = at(self.today, self.hhmm);
        let shared = self.shared.clone();
        let mut overrides: Vec<(&str, &OsStr)> = vec![("VALLY_CLOCK_START", OsStr::new(&clock))];
        if with_shared {
            overrides.push(("VALLY_SHARED_DATA_DIR", shared.as_os_str()));
            overrides.push(("VALLY_SHARED_DATA_POLL_MILLIS", OsStr::new("20")));
        }
        overrides.extend_from_slice(extra);
        Server::spawn_with(&self.fake, &self.dir.path().join("run/server.lock"), self.dir.path(), &overrides)
    }

    fn quote_calls(&self) -> usize {
        self.fake.calls().iter().filter(|c| c.api_id == QUOTE_API).count()
    }
}

type KrxDate = KstDate;

fn quote(code: &str, on: KstDate, close: u64, high: u64, volume: u64, traded: u64) -> Value {
    common::support::summary::row(code, KrxBar { day: on, open: 100, high, low: 90, close, volume, traded_million_won: traded, base: 100, adjustment_rate: None }, "090000")
}

fn snapshot_row_of(quote: &Value) -> Option<SnapshotRow> {
    let text = |key: &str| quote[key].as_str().unwrap_or("");
    let number = |key: &str| text(key).trim().trim_start_matches(['+', '-']).parse::<u64>().ok();
    let on = KstDate::parse_yyyymmdd(text("dt"))?;
    let traded_at = match text("cntr_tm").is_empty() {
        true => None,
        false => {
            let tm = text("cntr_tm");
            Some(kst(on, tm[0..2].parse().unwrap(), tm[2..4].parse().unwrap(), tm[4..6].parse().unwrap()).unix())
        }
    };
    Some(SnapshotRow {
        code: text("stk_cd").to_owned(),
        day: text("dt").to_owned(),
        current_won: number("cur_prc")?,
        base_won: number("base_pric")?,
        open_won: number("open_pric")?,
        high_won: number("high_pric")?,
        low_won: number("low_pric")?,
        volume: number("trde_qty")?,
        traded_million_won: number("trde_prica")?,
        traded_at,
    })
}

fn publish(shared: &Path, observation: KstDate, as_of: i64, quotes: &[Value]) {
    let rows: Vec<SnapshotRow> = quotes.iter().filter_map(snapshot_row_of).collect();
    let header = Header::new(DataKind::SnapshotKrx, observation, as_of, as_of, vec![]);
    write_snapshot(shared, header, SnapshotBody { closing: false, requested: quotes.len() as u32, missing: 0, stocks: rows, indices: vec![] }).unwrap();
}

fn rows_with_every_shape(on: KstDate) -> Vec<Value> {
    let mut no_trades = quote("300001", on, 0, 0, 0, 0);
    for key in ["open_pric", "high_pric", "low_pric"] {
        no_trades[key] = "0".into();
    }
    no_trades["cntr_tm"] = "".into();
    let mut halted = no_trades.clone();
    halted["stk_cd"] = "300004".into();
    halted["cur_prc"] = "100".into();
    let mut old = quote("300002", on.add_days(-4), 100, 100, 1_000, 1);
    old["stk_cd"] = "300002".into();
    vec![quote("300000", on, 120, 150, 3_000, 17), no_trades, old, halted]
}

fn without_calendar_noise(mut result: Value) -> Value {
    result.as_object_mut().unwrap().remove("collectionCompletedAt");
    result
}

#[tokio::test]
async fn a_run_reads_the_snapshot_without_calling_kiwoom_and_judges_like_a_run_that_fetches_quotes() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let session = Session::prepare(today, "1200", 5, stored.clone(), [stored.clone(), vec![today]].concat()).await;
    let quotes = rows_with_every_shape(today);
    let as_of = kst(today, 12, 0, 0).unix();
    let screens = [
        every(vec![]),
        every(vec![close_between(120.0, 120.0)]),
        every(vec![volume_is("D", 3_000.0), close_between(100.0, 200.0)]),
        every(vec![volume_is("W", 3_000.0)]),
    ];

    session.fake.set_quote_rows(quotes.clone());
    let live = session.boot(false);
    let api = Api::of(&live).await;
    let mut fetched = Vec::new();
    for screen in &screens {
        fetched.push(api.result(screen).await);
    }
    assert!(session.quote_calls() > 0, "기준 서버는 실행 때 시세를 받는다");
    live.stop().await;

    publish(&session.shared, today, as_of, &quotes);
    let quote_calls = session.quote_calls();
    let shared = session.boot(true);
    let api = Api::of(&shared).await;
    api.warm_calendar().await;
    let requests = session.fake.requests();
    for (screen, fetched) in screens.iter().zip(&fetched) {
        let from_snapshot = api.result_of_snapshot(screen, as_of).await;
        assert_eq!(without_calendar_noise(from_snapshot), without_calendar_noise(fetched.clone()), "{screen}");
    }
    assert_eq!(session.quote_calls(), quote_calls, "변수가 있으면 전 종목 시세를 받지 않는다");
    assert_eq!(session.fake.requests(), requests, "달력을 데워 둔 실행은 키움 요청을 하나도 보내지 않는다");
    assert_eq!(fetched[0]["missingSummary"], 2, "스냅샷에 없는 종목과 다른 날짜의 행은 누락으로 센다");
    shared.stop().await;
}

#[tokio::test]
async fn closed_saturday_holiday_and_after_close_runs_use_the_last_observed_snapshot_and_never_double_count_today() {
    let monday = day(2026, 11, 9);
    let friday = day(2026, 11, 6);
    let saturday = day(2026, 11, 14);
    let before = |today: KstDate| last_open_days(20, today.add_days(-1));

    let on_saturday = Session::prepare(saturday, "1200", 3, before(saturday), before(saturday)).await;
    let last_friday = *before(saturday).last().unwrap();
    publish(&on_saturday.shared, last_friday, kst(saturday, 11, 59, 30).unix(), &(0..3).map(|i| quote(&code_of(i), last_friday, 130, 150, 5_000, 9)).collect::<Vec<_>>());
    let server = on_saturday.boot(true);
    let api = Api::of(&server).await;
    let result = api.result_of_snapshot(&every(vec![]), kst(saturday, 11, 59, 30).unix()).await;
    assert_eq!((result["missingSummary"].clone(), result["asOf"].clone(), result["universe"].clone()), (json!(0), json!(last_friday.to_string()), json!(3)), "{result}");
    assert!(result["rows"].as_array().unwrap().iter().all(|r| r["provisional"] == false && r["close"] == 100.0), "토요일은 저장된 마지막 봉으로 판정한다: {result}");
    server.stop().await;

    let on_holiday = Session::prepare(monday, "2030", 3, before(monday), before(monday)).await;
    publish(&on_holiday.shared, friday, kst(monday, 20, 29, 30).unix(), &(0..3).map(|i| quote(&code_of(i), friday, 100, 100, 1_000, 1)).collect::<Vec<_>>());
    let server = on_holiday.boot(true);
    let api = Api::of(&server).await;
    let result = api.result_of_snapshot(&every(vec![]), kst(monday, 20, 29, 30).unix()).await;
    assert_eq!((result["missingSummary"].clone(), result["asOf"].clone()), (json!(0), json!(friday.to_string())), "휴장 월요일: {result}");
    server.stop().await;

    let stored_with_today = [before(monday), vec![monday]].concat();
    let after_close = Session::prepare(monday, "2030", 2, stored_with_today.clone(), stored_with_today).await;
    publish(&after_close.shared, monday, kst(monday, 20, 29, 30).unix(), &(0..2).map(|i| quote(&code_of(i), monday, 120, 150, 4_000, 9)).collect::<Vec<_>>());
    let server = after_close.boot(true);
    let api = Api::of(&server).await;
    let once = api.result_of_snapshot(&every(vec![volume_is("D", 1_000.0), close_between(100.0, 100.0)]), kst(monday, 20, 29, 30).unix()).await;
    assert_eq!(once["rows"].as_array().unwrap().len(), 2, "저장소에 그날 봉이 있으면 스냅샷 행을 더하지 않는다: {once}");
    assert!(once["rows"].as_array().unwrap().iter().all(|r| r["provisional"] == false));
    server.stop().await;
}

#[tokio::test]
async fn a_snapshot_base_price_far_from_the_stored_close_blocks_the_run_for_an_adjustment_check() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let session = Session::prepare(today, "1200", 2, stored.clone(), [stored, vec![today]].concat()).await;
    let mut adjusted = quote("300001", today, 100, 100, 1_000, 1);
    adjusted["base_pric"] = "150".into();
    let as_of = kst(today, 12, 0, 0).unix();
    publish(&session.shared, today, as_of, &[quote("300000", today, 100, 100, 1_000, 1), adjusted]);
    let server = session.boot(true);
    let api = Api::of(&server).await;
    let mut last = (0, Value::Null);
    for _ in 0..500 {
        last = api.run(&every(vec![])).await;
        if last.0 != 502 && last.0 != 503 || !last.1.to_string().contains("스냅샷") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_ne!(last.0, 200, "{}", last.1);
    assert!(last.1.to_string().contains("기준가와 확정 이력의 차이가 커 수정 이력을 확인해야 합니다: 300001"), "{}", last.1);
    server.stop().await;
}

#[tokio::test]
async fn without_a_snapshot_or_with_yesterdays_the_run_fails_and_kiwoom_is_not_asked_for_quotes() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let session = Session::prepare(today, "0830", 2, stored.clone(), [stored.clone(), vec![today]].concat()).await;
    let quote_calls = session.quote_calls();
    let server = session.boot(true);
    let api = Api::of(&server).await;
    api.warm_calendar().await;
    let (status, body) = api.run(&every(vec![])).await;
    assert_ne!(status, 200, "{body}");
    assert!(body.to_string().contains("스냅샷"), "{body}");

    let yesterday = *stored.last().unwrap();
    publish(&session.shared, yesterday, kst(yesterday, 20, 0, 30).unix(), &[quote("300000", yesterday, 100, 100, 1_000, 1)]);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (status, body) = api.run(&every(vec![])).await;
    assert_ne!(status, 200, "오늘 관측이 확인된 날 어제 스냅샷으로는 판정하지 않는다: {body}");
    assert_eq!(session.quote_calls(), quote_calls);
    assert_eq!(server.screener().result_reuse().map(|c| (c.hits, c.misses)), Some((0, 0)));
    server.stop().await;
}

#[tokio::test]
async fn the_same_screen_on_the_same_snapshot_is_reused_until_the_snapshot_changes_and_eight_at_once_judge_once() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let session = Session::prepare(today, "1200", 4, stored.clone(), [stored, vec![today]].concat()).await;
    let rows = |close: u64| (0..4).map(|i| quote(&code_of(i), today, close, close.max(100), 3_000, 17)).collect::<Vec<_>>();
    let first_as_of = kst(today, 11, 59, 30).unix();
    publish(&session.shared, today, first_as_of, &rows(120));
    let server = session.boot(true);
    let api = Api::of(&server).await;
    let counts = || server.screener().result_reuse().map(|c| (c.hits, c.misses)).unwrap();

    let screen = json!({"id": "A", "name": "첫째", "markets": ["kospi", "kosdaq"], "exclude": [], "conditions": [close_between(120.0, 120.0)]});
    let first = api.result_of_snapshot(&screen, first_as_of).await;
    assert_eq!(counts(), (0, 1));
    assert_eq!(first["rows"].as_array().unwrap().len(), 4);

    assert_eq!(api.result(&screen).await, first);
    assert_eq!(counts(), (1, 1), "같은 조건·같은 판의 두 번째 실행은 판정하지 않는다");
    let renamed = json!({"id": "B", "name": "이름만 다름", "markets": ["kosdaq", "kospi"], "exclude": [], "conditions": [close_between(120.0, 120.0)]});
    assert_eq!(api.result(&renamed).await, first);
    assert_eq!(counts(), (2, 1), "이름·id와 시장 순서는 조건식 값에 들지 않는다");
    api.result(&every(vec![close_between(100.0, 200.0)])).await;
    assert_eq!(counts(), (2, 2), "다른 조건은 따로 판정한다");

    let second_as_of = first_as_of + 30;
    publish(&session.shared, today, second_as_of, &rows(110));
    let moved = api.result_of_snapshot(&screen, second_as_of).await;
    assert_eq!(moved["rows"].as_array().unwrap().len(), 0, "판이 바뀌면 다시 판정한다: {moved}");
    let (hits, misses) = counts();
    assert_eq!(misses, 3, "새 판의 첫 판정 하나만 판정으로 센다");
    api.result(&screen).await;
    assert_eq!(counts(), (hits + 1, 3));
    api.result(&every(vec![close_between(100.0, 200.0)])).await;
    assert_eq!(counts(), (hits + 1, 4), "지난 판의 결과는 버렸으므로 다시 판정한다");
    let hits = hits + 1;

    let crowd = json!({"id": "C", "name": "동시", "markets": [], "exclude": [], "conditions": [volume_is("D", 3_000.0)]});
    let runs: Vec<_> = (0..8).map(|_| {
        let (api, crowd) = (api.copy(), crowd.clone());
        tokio::spawn(async move { api.result(&crowd).await })
    }).collect();
    let results = futures::future::join_all(runs).await.into_iter().map(Result::unwrap).collect::<Vec<_>>();
    assert!(results.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(counts(), (hits + 7, 4 + 1), "같은 조건 8개가 동시에 와도 판정은 한 번이다");
    server.stop().await;
}

#[tokio::test]
async fn while_today_is_not_yet_known_a_snapshot_older_than_the_previous_observation_day_is_refused() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let previous = *stored.last().unwrap();
    let session = Session::prepare(today, "1200", 2, stored.clone(), stored).await;
    let quote_calls = session.quote_calls();
    let rows = |on: KstDate| (0..2).map(|i| quote(&code_of(i), on, 100, 100, 1_000, 1)).collect::<Vec<_>>();
    let long_ago = previous.add_days(-17);
    publish(&session.shared, long_ago, kst(long_ago, 20, 0, 30).unix(), &rows(long_ago));
    let server = session.boot(true);
    let api = Api::of(&server).await;
    api.warm_calendar().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (status, body) = api.run(&every(vec![])).await;
    assert_ne!(status, 200, "{body}");
    assert!(body.to_string().contains("스냅샷"), "{body}");

    let as_of = kst(previous, 20, 0, 30).unix();
    publish(&session.shared, previous, as_of, &rows(previous));
    let result = api.result_of_snapshot(&every(vec![]), as_of).await;
    assert_eq!((result["asOf"].clone(), result["missingSummary"].clone()), (json!(previous.to_string()), json!(2)), "평일 낮 달력에 오늘이 없으면 휴장으로 추정하지 않고 이전 날짜 행을 누락으로 센다: {result}");
    assert_eq!(session.quote_calls(), quote_calls);
    server.stop().await;
}

#[tokio::test]
async fn an_intraday_snapshot_older_than_the_limit_fails_as_stale_and_a_fresh_one_or_a_closed_market_runs_as_before() {
    let today = day(2026, 11, 9);
    let stored = last_open_days(20, today.add_days(-1));
    let rows = |on: KstDate| (0..2).map(|i| quote(&code_of(i), on, 100, 100, 1_000, 1)).collect::<Vec<_>>();

    let intraday = Session::prepare(today, "1200", 2, stored.clone(), [stored.clone(), vec![today]].concat()).await;
    let stale_as_of = kst(today, 11, 57, 0).unix();
    publish(&intraday.shared, today, stale_as_of, &rows(today));
    let server = intraday.boot(true);
    let api = Api::of(&server).await;
    api.warm_calendar().await;
    let mut refused = (200, Value::Null);
    for _ in 0..500 {
        refused = api.run(&every(vec![])).await;
        if refused.1["error"]["reason"] == json!("stale_data") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!((refused.0, refused.1["error"]["code"].clone(), refused.1["error"]["reason"].clone()), (409, json!("screener_not_ready"), json!("stale_data")), "{}", refused.1);

    let fresh_as_of = kst(today, 11, 59, 30).unix();
    publish(&intraday.shared, today, fresh_as_of, &rows(today));
    api.result_of_snapshot(&every(vec![]), fresh_as_of).await;
    server.stop().await;

    let raised = intraday.boot_with(true, &[("VALLY_SCREENER_SNAPSHOT_STALE_SECS", OsStr::new("600"))]);
    let api = Api::of(&raised).await;
    publish(&intraday.shared, today, stale_as_of, &rows(today));
    api.warm_calendar().await;
    api.result_of_snapshot(&every(vec![]), stale_as_of).await;
    raised.stop().await;

    let stored_with_today = [stored.clone(), vec![today]].concat();
    let after_close = Session::prepare(today, "2030", 2, stored_with_today.clone(), stored_with_today).await;
    let closing_as_of = kst(today, 20, 0, 30).unix();
    publish(&after_close.shared, today, closing_as_of, &rows(today));
    let server = after_close.boot(true);
    let api = Api::of(&server).await;
    api.result_of_snapshot(&every(vec![]), closing_as_of).await;
    server.stop().await;

    let saturday = day(2026, 11, 14);
    let before_saturday = last_open_days(20, saturday.add_days(-1));
    let last_friday = *before_saturday.last().unwrap();
    let weekend = Session::prepare(saturday, "1200", 2, before_saturday.clone(), before_saturday).await;
    let friday_as_of = kst(last_friday, 20, 0, 30).unix();
    publish(&weekend.shared, last_friday, friday_as_of, &rows(last_friday));
    let server = weekend.boot(true);
    let api = Api::of(&server).await;
    api.result_of_snapshot(&every(vec![]), friday_as_of).await;
    server.stop().await;
}
