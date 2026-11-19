
mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use common::{ScriptedTransport, Server};
use domain::{ConfirmedBar, Feed, KstDate, KstTime, Market, Period, SeriesKey, Symbol, SymbolInfo, SymbolKind, Venue};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::bars::{BarError, BarService};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::symbols::{Directory, SymbolDirectory};

const MINUTE_API: &str = "ka10080";
const DAILY_API: &str = "ka10081";
const INDEX_MINUTE_API: &str = "ka20005";

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/kiwoom/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

type Request = (String, Option<String>);
type Answer = (Value, Option<String>);

#[derive(Clone, Default)]
struct Chart {
    replies: Arc<Mutex<HashMap<(String, Request), Answer>>>,
    sent: Arc<Mutex<Vec<(String, Request)>>>,
}

impl Chart {
    fn reply(self, api: &str, base: &str, cont: Option<&str>, body: Value, next: Option<&str>) -> Self {
        self.replies.lock().unwrap().insert((api.into(), (base.into(), cont.map(Into::into))), (body, next.map(Into::into)));
        self
    }

    fn sent(&self, api: &str) -> Vec<Request> {
        self.sent.lock().unwrap().iter().filter(|(id, _)| id == api).map(|(_, r)| r.clone()).collect()
    }
}

impl Transport for Chart {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let reply = |body: String, next: Option<String>| {
            let r = HttpResponse { status: 200, next_key: next, body };
            Box::pin(async move { Ok(r) }) as BoxFuture<'static, _>
        };
        if req.api_id.as_str() == "au10001" {
            return reply(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}).to_string(), None);
        }
        let body: Value = serde_json::from_str(req.body.expose()).unwrap();
        let base = body["base_dt"].as_str().unwrap().to_owned();
        let cont = req.cont.as_ref().map(|c| c.as_str().to_owned());
        let api = req.api_id.as_str().to_owned();
        self.sent.lock().unwrap().push((api.clone(), (base.clone(), cont.clone())));
        let Some((body, next)) = self.replies.lock().unwrap().get(&(api.clone(), (base.clone(), cont.clone()))).cloned() else {
            panic!("정하지 않은 조회: {api} base_dt={base} cont={cont:?}");
        };
        reply(body.to_string(), next)
    }
}

fn minute_body(rows: &[(&str, u64, u64, u64, u64, u64)]) -> Value {
    let rows: Vec<Value> = rows
        .iter()
        .map(|(tm, o, h, l, c, v)| json!({"cntr_tm": tm, "open_pric": o.to_string(), "high_pric": h.to_string(), "low_pric": l.to_string(), "cur_prc": c.to_string(), "trde_qty": v.to_string()}))
        .collect();
    json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_min_pole_chart_qry": rows})
}

fn daily_body(closes: &[(&str, u64)]) -> Value {
    let rows: Vec<Value> = closes
        .iter()
        .map(|(dt, c)| json!({"dt": dt, "open_pric": c.to_string(), "high_pric": c.to_string(), "low_pric": c.to_string(), "cur_prc": c.to_string(), "trde_qty": "10"}))
        .collect();
    json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_dt_pole_chart_qry": rows})
}

const TODAY: &str = "20261109";
const SYMBOL: &str = "196170";

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

struct Harness {
    bars: BarService,
    clock: Clock,
}

fn harness(chart: &Chart) -> Harness {
    harness_at(chart, kst(day(2026, 11, 9), 2, 39, 0))
}

fn harness_at(chart: &Chart, now: KstTime) -> Harness {
    let clock = Clock::fake(now);
    let rest = KiwoomRest::new(Arc::new(chart.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
    let symbols = Arc::new(SymbolDirectory::default());
    let symbol = Symbol::parse(SYMBOL).unwrap();
    symbols.replace(Directory::build(vec![SymbolInfo { symbol, name: "알테오젠".into(), kind: SymbolKind::Common, market: Market::Kosdaq, nxt_enabled: true }]));
    Harness { bars: BarService::new(rest, symbols, clock.clone()), clock }
}

fn minute_key() -> SeriesKey {
    SeriesKey { feed: Feed::new(Symbol::parse(SYMBOL).unwrap(), Some(Venue::Combined)).unwrap(), period: Period::M60 }
}

fn won(bar: &ConfirmedBar) -> (u64, u64, u64, u64) {
    let o = &bar.ohlcv;
    (o.open().centi() / 100, o.high().centi() / 100, o.low().centi() / 100, o.close().centi() / 100)
}

fn start_of(bar: &ConfirmedBar) -> KstTime {
    bar.bucket.start()
}

fn jumping_chart() -> Chart {
    Chart::default()
        .reply(MINUTE_API, "20260716", None, fixture("ka10080_196170_AL_60_base_20260716"), Some("base-p2"))
        .reply(DAILY_API, "20260716", None, fixture("ka10081_196170_AL_base_20260716"), None)
        .reply(DAILY_API, TODAY, None, fixture("ka10081_196170_AL_today"), None)
        .reply(MINUTE_API, TODAY, None, fixture("ka10080_196170_AL_60_today_p1"), Some("today-p2"))
        .reply(MINUTE_API, TODAY, Some("today-p2"), fixture("ka10080_196170_AL_60_today_p2"), Some("today-p3"))
}

#[tokio::test(start_paused = true)]
async fn the_page_matches_todays_adjusted_bars_and_leaves_the_regular_cache_alone() {
    let chart = jumping_chart();
    let h = harness(&chart);
    let latest = h.bars.page(minute_key(), None, 900).await.unwrap();
    let older = h.bars.page(minute_key(), latest.next_before, 900).await.unwrap();
    let todays = |at: KstTime| latest.bars.iter().chain(&older.bars).find(|b| start_of(b) == at).copied().unwrap();

    let page = h.bars.jump_page(minute_key(), day(2026, 7, 16), None, 100).await.unwrap();

    let last = page.bars.last().unwrap();
    assert_eq!(start_of(last), kst(day(2026, 7, 16), 15, 0, 0), "첫 페이지는 기준일의 마지막 봉에서 끝난다");
    assert!(page.unadjusted_days.is_empty(), "{:?}", page.unadjusted_days);
    for hour in [14, 15] {
        let at = kst(day(2026, 7, 16), hour, 0, 0);
        let (jumped, regular) = (page.bars.iter().find(|b| start_of(b) == at).unwrap(), todays(at));
        let (a, b) = (won(jumped), won(&regular));
        assert!(a.0.abs_diff(b.0) <= 1 && a.3.abs_diff(b.3) <= 1, "{hour}시 봉 jump {a:?} 오늘 기준 {b:?}");
        assert_eq!(jumped.ohlcv.volume(), regular.ohlcv.volume(), "거래량은 바꾸지 않는다");
    }
    let minute_requests = chart.sent(MINUTE_API);
    assert!(minute_requests.contains(&("20260716".into(), None)), "{minute_requests:?}");
    assert_eq!(minute_requests.iter().filter(|(base, _)| base != TODAY).count(), 1, "기준일 분봉 조회는 한 번");

    let (latest_again, older_again) = (h.bars.page(minute_key(), None, 900).await.unwrap(), h.bars.page(minute_key(), latest.next_before, 900).await.unwrap());
    assert_eq!((latest_again.bars, older_again.bars), (latest.bars, older.bars), "이 조회가 기존 캐시의 값을 바꾸지 않는다");
    assert!(chart.sent(MINUTE_API).iter().filter(|(base, _)| base != TODAY).count() == 1);
}

#[tokio::test(start_paused = true)]
async fn the_next_page_continues_the_same_base_date_and_ends_when_kiwoom_ends() {
    let chart = jumping_chart().reply(
        MINUTE_API,
        "20260716",
        Some("base-p2"),
        minute_body(&[("20260622100000", 270_000, 271_000, 269_000, 270_500, 5), ("20260622090000", 269_000, 270_000, 268_000, 270_000, 6), ("20260619100000", 268_000, 269_000, 267_000, 268_500, 7)]),
        None,
    );
    let h = harness(&chart);

    let first = h.bars.jump_page(minute_key(), day(2026, 7, 16), None, 100).await.unwrap();
    assert_eq!(first.bars.len(), 100);
    assert_eq!(start_of(first.bars.last().unwrap()), kst(day(2026, 7, 16), 15, 0, 0));
    let second = h.bars.jump_page(minute_key(), day(2026, 7, 16), first.next_before, 100).await.unwrap();
    assert_eq!(second.bars.len(), 100);
    assert_eq!(chart.sent(MINUTE_API).len(), 1, "가진 봉으로 만든 페이지는 키움을 부르지 않는다");

    let third = h.bars.jump_page(minute_key(), day(2026, 7, 16), second.next_before, 100).await.unwrap();
    assert_eq!(chart.sent(MINUTE_API), vec![("20260716".into(), None), ("20260716".into(), Some("base-p2".into()))], "같은 기준일의 연속조회로 이어진다");
    assert_eq!(third.bars.len(), 1 + 3);
    assert_eq!(third.next_before, None, "키움이 연속조회를 끝냈다");
    assert!(start_of(&third.bars[0]) < start_of(&third.bars[1]) && third.bars.windows(2).all(|w| start_of(&w[0]) < start_of(&w[1])));
    assert!(third.unadjusted_days.is_empty(), "{:?}", third.unadjusted_days);
    assert_eq!(chart.sent(DAILY_API).len(), 2, "일봉은 오늘 기준 한 번, 기준일 기준 한 번이면 된다");
}

fn two_day_chart(base_daily: Value, today_daily: Value) -> Chart {
    Chart::default()
        .reply(
            MINUTE_API,
            "20260714",
            None,
            minute_body(&[("20260714100000", 1_000, 1_050, 950, 1_000, 10), ("20260713100000", 2_000, 2_100, 1_900, 2_050, 20)]),
            None,
        )
        .reply(DAILY_API, "20260714", None, base_daily, None)
        .reply(DAILY_API, TODAY, None, today_daily, None)
}

#[tokio::test(start_paused = true)]
async fn each_day_takes_its_own_ratio_when_a_rights_event_lies_between() {
    let chart = two_day_chart(daily_body(&[("20260714", 1_000), ("20260713", 2_000)]), daily_body(&[("20261106", 1_000), ("20260714", 1_000), ("20260713", 1_000)]));
    let h = harness(&chart);

    let page = h.bars.jump_page(minute_key(), day(2026, 7, 14), None, 500).await.unwrap();

    let by_day: Vec<_> = page.bars.iter().map(|b| (start_of(b).kst_date(), won(b), b.ohlcv.volume().0)).collect();
    assert_eq!(by_day, vec![(day(2026, 7, 13), (1_000, 1_050, 950, 1_025), 20), (day(2026, 7, 14), (1_000, 1_050, 950, 1_000), 10)], "07-13은 ×0.5, 07-14는 ×1, 거래량은 그대로");
    assert!(page.unadjusted_days.is_empty());

    let again = h.bars.jump_page(minute_key(), day(2026, 7, 14), None, 500).await.unwrap();
    assert_eq!(again.bars, page.bars, "같은 페이지를 다시 줄 때 비율을 다시 곱하지 않는다");
    assert_eq!(chart.sent(MINUTE_API).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_day_without_a_ratio_keeps_the_received_prices_and_is_listed() {
    let chart = two_day_chart(daily_body(&[("20260714", 1_000)]), daily_body(&[("20261106", 1_000), ("20260714", 1_000), ("20260713", 1_000)]));
    let h = harness(&chart);

    let page = h.bars.jump_page(minute_key(), day(2026, 7, 14), None, 500).await.unwrap();

    assert_eq!(won(&page.bars[0]), (2_000, 2_100, 1_900, 2_050), "기준일 일봉에 없는 날은 받은 가격 그대로");
    assert_eq!(won(&page.bars[1]), (1_000, 1_050, 950, 1_000));
    assert_eq!(page.unadjusted_days, vec![day(2026, 7, 13)]);

    let missing_today = two_day_chart(daily_body(&[("20260714", 1_000), ("20260713", 2_000)]), daily_body(&[("20261106", 1_000), ("20260713", 1_000)]));
    let page = harness(&missing_today).bars.jump_page(minute_key(), day(2026, 7, 14), None, 500).await.unwrap();
    assert_eq!(page.unadjusted_days, vec![day(2026, 7, 14)], "오늘 기준 일봉에 없는 날도 같다");
    assert_eq!(won(&page.bars[1]), (1_000, 1_050, 950, 1_000));
}

fn friday_chart(daily_close: u64) -> Chart {
    Chart::default()
        .reply(MINUTE_API, "20261106", None, minute_body(&[("20261106100000", 1_000, 1_050, 950, 1_000, 10)]), None)
        .reply(DAILY_API, "20261106", None, daily_body(&[("20261106", daily_close), ("20261105", 900)]), None)
}

fn daily_key() -> SeriesKey {
    SeriesKey { period: Period::Day, ..minute_key() }
}

fn daily_fetches_on(chart: &Chart, base: &str) -> usize {
    chart.sent(DAILY_API).iter().filter(|(b, _)| b == base).count()
}

#[tokio::test(start_paused = true)]
async fn yesterdays_daily_bar_cached_during_the_session_takes_its_final_close_after_midnight() {
    let chart = friday_chart(1_000);
    let h = harness_at(&chart, kst(day(2026, 11, 6), 15, 0, 0));
    let cached = h.bars.page(daily_key(), None, 5).await.unwrap();
    assert_eq!(cached.current.unwrap().ohlcv.close().centi() / 100, 1_000, "15:00에 받은 11-06 일봉은 진행 중 봉");
    chart.clone().reply(DAILY_API, "20261106", None, daily_body(&[("20261106", 1_200), ("20261105", 900)]), None);
    h.clock.jump(11 * 3600);
    assert_eq!(h.clock.now(), kst(day(2026, 11, 7), 2, 0, 0));

    let page = h.bars.jump_page(minute_key(), day(2026, 11, 6), None, 100).await.unwrap();

    assert!(page.unadjusted_days.is_empty(), "{:?}", page.unadjusted_days);
    assert_eq!(won(&page.bars[0]), (1_000, 1_050, 950, 1_000), "최종 종가 1,200 대 1,200이라 받은 가격 그대로. 15:00 값 1,000을 썼다면 바뀐다");
    assert_eq!(daily_fetches_on(&chart, "20261106"), 3, "일봉 최신 조회가 바로가기에서 한 번 더 나간다(처음 받기, 기준일, 최신 다시 받기)");
}

#[tokio::test(start_paused = true)]
async fn the_daily_latest_is_not_asked_again_when_the_day_was_already_confirmed_or_the_session_is_open() {
    let chart = friday_chart(1_000);
    let h = harness_at(&chart, kst(day(2026, 11, 6), 20, 30, 0));
    h.bars.page(daily_key(), None, 5).await.unwrap();
    h.clock.jump(5 * 3600 + 30 * 60);
    let page = h.bars.jump_page(minute_key(), day(2026, 11, 6), None, 100).await.unwrap();
    assert!(page.unadjusted_days.is_empty(), "{:?}", page.unadjusted_days);
    assert_eq!(daily_fetches_on(&chart, "20261106"), 2, "20시 유예 뒤에 만든 시리즈는 처음 받기와 기준일 조회뿐");

    let chart = friday_chart(1_000).reply(DAILY_API, "20261109", None, daily_body(&[("20261109", 1_100), ("20261106", 1_000)]), None);
    let h = harness_at(&chart, kst(day(2026, 11, 9), 10, 0, 0));
    h.bars.page(daily_key(), None, 5).await.unwrap();
    h.clock.jump(30 * 60);
    let page = h.bars.jump_page(minute_key(), day(2026, 11, 6), None, 100).await.unwrap();
    assert!(page.unadjusted_days.is_empty(), "{:?}", page.unadjusted_days);
    assert_eq!(daily_fetches_on(&chart, "20261109"), 1, "장 중에는 최신 조회를 더하지 않는다");
    assert_eq!(daily_fetches_on(&chart, "20261106"), 1, "기준일 조회뿐");
}

#[tokio::test(start_paused = true)]
async fn an_index_keeps_the_received_values_and_asks_for_no_daily_bars() {
    let row = |tm: &str, c: u64| json!({"cntr_tm": tm, "open_pric": c.to_string(), "high_pric": c.to_string(), "low_pric": c.to_string(), "cur_prc": c.to_string(), "trde_qty": "5"});
    let chart = Chart::default().reply(INDEX_MINUTE_API, "20260714", None, json!({"return_code": 0, "inds_min_pole_qry": [row("20260714100000", 505_969), row("20260713100000", 505_029)]}), None);
    let h = harness(&chart);
    let key = SeriesKey { feed: Feed::new(Symbol::parse("IDX:001").unwrap(), None).unwrap(), period: Period::M60 };

    let page = h.bars.jump_page(key, day(2026, 7, 14), None, 500).await.unwrap();

    assert_eq!(page.bars.iter().map(|b| b.ohlcv.close().centi()).collect::<Vec<_>>(), vec![505_029, 505_969]);
    assert!(page.unadjusted_days.is_empty());
    assert!(chart.sent(DAILY_API).is_empty() && chart.sent("ka20006").is_empty());
}

#[tokio::test(start_paused = true)]
async fn daily_periods_today_future_dates_and_unknown_symbols_are_rejected_before_asking_kiwoom() {
    let chart = Chart::default();
    let h = harness(&chart);
    let bad = |e: BarError| matches!(e, BarError::BadRequest(_));
    let daily = SeriesKey { period: Period::Day, ..minute_key() };
    assert!(bad(h.bars.jump_page(daily, day(2026, 7, 16), None, 10).await.unwrap_err()), "일봉 주기");
    assert!(bad(h.bars.jump_page(minute_key(), day(2026, 11, 9), None, 10).await.unwrap_err()), "오늘");
    assert!(bad(h.bars.jump_page(minute_key(), day(2026, 11, 10), None, 10).await.unwrap_err()), "미래");
    let unknown = SeriesKey { feed: Feed::new(Symbol::parse("005930").unwrap(), None).unwrap(), period: Period::M60 };
    assert_eq!(h.bars.jump_page(unknown, day(2026, 7, 16), None, 10).await.unwrap_err(), BarError::UnknownSymbol);
    assert!(chart.sent(MINUTE_API).is_empty() && chart.sent(DAILY_API).is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_empty_answer_ends_with_no_bars_and_no_cursor() {
    let chart = Chart::default().reply(MINUTE_API, "20250102", None, minute_body(&[]), None);
    let h = harness(&chart);

    let page = h.bars.jump_page(minute_key(), day(2025, 1, 2), None, 500).await.unwrap();

    assert_eq!((page.bars.len(), page.next_before, page.unadjusted_days.len()), (0, None, 0));
    assert!(chart.sent(DAILY_API).is_empty(), "봉이 없으면 일봉도 받지 않는다");
}

#[tokio::test(start_paused = true)]
async fn clearing_and_idle_eviction_drop_the_jump_columns_so_the_next_query_asks_kiwoom_again() {
    let chart = two_day_chart(daily_body(&[("20260714", 1_000), ("20260713", 2_000)]), daily_body(&[("20261106", 1_000), ("20260714", 1_000), ("20260713", 1_000)]));
    let h = harness(&chart);
    let ask = || h.bars.jump_page(minute_key(), day(2026, 7, 14), None, 500);

    ask().await.unwrap();
    ask().await.unwrap();
    assert_eq!((chart.sent(MINUTE_API).len(), h.bars.jump_series_count()), (1, 1));

    h.bars.clear_all();
    assert_eq!(h.bars.jump_series_count(), 0);
    ask().await.unwrap();
    assert_eq!(chart.sent(MINUTE_API).len(), 2, "비운 뒤에는 같은 질의가 키움을 다시 부른다");

    h.clock.jump(11 * 60);
    h.bars.evict_idle(&std::collections::HashSet::new());
    assert_eq!(h.bars.jump_series_count(), 0, "10분 쓰지 않은 열은 내린다");
}

fn fake_listing() -> Value {
    json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "list": [{
        "auditInfo": "정상", "code": SYMBOL, "companyClassName": "", "kind": "A", "lastPrice": "00212767", "listCount": "0000000053000000",
        "marketCode": "10", "marketName": "코스닥", "name": "알테오젠", "nxtEnable": "Y", "orderWarning": "0", "regDay": "20081217", "state": "증거금30%", "upName": "", "upSizeName": ""}]})
}

fn with_next(mut body: Value, next: &str) -> Value {
    body["_headers"] = json!({"cont-yn": "Y", "next-key": next});
    body
}

async fn get(client: &reqwest::Client, base: &str, path: &str) -> (u16, Value) {
    let resp = client.get(format!("{base}{path}")).send().await.unwrap();
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

#[tokio::test]
async fn the_route_answers_with_the_page_shape_and_the_error_codes() {
    let fake = ScriptedTransport::new();
    fake.respond_with("ka10099", 200, fake_listing());
    fake.respond_with(MINUTE_API, 200, with_next(fixture("ka10080_196170_AL_60_base_20260716"), "base-p2"));
    fake.script(
        DAILY_API,
        vec![
            common::support::ScriptedReply { status: 200, body: fixture("ka10081_196170_AL_base_20260716"), delay: std::time::Duration::ZERO },
            common::support::ScriptedReply { status: 200, body: fixture("ka10081_196170_AL_today"), delay: std::time::Duration::ZERO },
        ],
    );
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let server = Server::spawn_with(&fake, &tmp.path().join("run/server.lock"), &dist, &[("VALLY_CLOCK_START", std::ffi::OsStr::new("20261109023900"))]);
    let base = format!("http://{}", server.addr().await);
    let client = reqwest::Client::new();

    let mut answer = (0, Value::Null);
    for _ in 0..100 {
        answer = get(&client, &base, "/api/bars/jump?symbol=196170&venue=combined&period=60m&date=2026-07-16&limit=100").await;
        if answer.0 != 503 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let (status, page) = answer;
    assert_eq!(status, 200, "{page}");
    assert_eq!((page["symbol"].as_str(), page["venue"].as_str(), page["period"].as_str(), page["date"].as_str()), (Some("196170"), Some("combined"), Some("60m"), Some("2026-07-16")));
    assert_eq!(page["unadjustedDays"], json!([]));
    assert!(page.get("current").is_none() && page.get("seq").is_none(), "진행 중 봉과 seq는 없다");
    let bars = page["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 100);
    let last = bars.last().unwrap();
    assert_eq!(last["t"].as_i64(), Some(kst(day(2026, 7, 16), 15, 0, 0).unix()));
    assert!((last["c"].as_f64().unwrap() - 212_767.0).abs() <= 1.0, "{last}");
    assert!(page["nextBefore"].as_i64().is_some(), "연속조회 키가 남아 있으면 커서가 있다");
    let minute_calls: Vec<_> = fake.calls().into_iter().filter(|c| c.api_id == MINUTE_API).collect();
    assert_eq!(minute_calls[0].body["base_dt"], "20260716");

    for path in [
        "/api/bars/jump?symbol=196170&period=D&date=2026-07-16",
        "/api/bars/jump?symbol=196170&period=60m&date=2026-11-09",
        "/api/bars/jump?symbol=196170&period=60m&date=2026-12-31",
        "/api/bars/jump?symbol=196170&period=60m&date=2026-13-01",
        "/api/bars/jump?symbol=196170&period=60m&date=20260716",
        "/api/bars/jump?symbol=196170&period=60m",
        "/api/bars/jump?symbol=196170&period=60m&date=2026-07-16&limit=1001",
        "/api/bars/jump?symbol=IDX:001&period=60m&venue=krx&date=2026-07-16",
    ] {
        let (status, body) = get(&client, &base, path).await;
        assert_eq!((status, body["error"]["code"].as_str()), (400, Some("bad_request")), "{path}: {body}");
    }
}
