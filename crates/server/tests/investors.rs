mod common;

use std::ffi::OsStr;

use common::{ScriptedTransport, Server};
use domain::KstDate;
use common::support::investors::{self, INVESTOR_FIELDS, PAGE_ROWS};
use common::support::krx::{self, KrxMarket, KrxStock};
use serde_json::{Value, json};

const FOREIGN: &str = "foreign-holdings";
const NET_SHARES: &str = "investor-net-shares";

const NET_SHARE_NAMES: [(&str, &str); 12] = [
    ("ind_invsr", "individual"),
    ("frgnr_invsr", "foreign"),
    ("orgn", "institution"),
    ("fnnc_invt", "financialInvestment"),
    ("insrnc", "insurance"),
    ("invtrt", "investmentTrust"),
    ("etc_fnnc", "otherFinancial"),
    ("bank", "bank"),
    ("penfnd_etc", "pensionFund"),
    ("samo_fund", "privateFund"),
    ("natn", "government"),
    ("etc_corp", "otherCorporation"),
];

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn today() -> KstDate {
    day(2026, 11, 6)
}

fn market() -> KrxMarket {
    KrxMarket::sample(today())
}

fn stock(code: &str) -> KrxStock {
    market().stocks.into_iter().find(|s| s.code == code).unwrap()
}

fn api_id(endpoint: &str) -> &'static str {
    if endpoint == FOREIGN { "ka10008" } else { "ka10059" }
}

fn list(endpoint: &str) -> &'static str {
    if endpoint == FOREIGN { "stk_frgnr" } else { "stk_invsr_orgn" }
}

struct Api {
    server: Server,
    fake: ScriptedTransport,
    client: reqwest::Client,
    base: String,
    _tmp: tempfile::TempDir,
}

impl Api {
    async fn boot() -> Api {
        let fake = ScriptedTransport::new();
        fake.set_krx_market(market());
        let tmp = tempfile::tempdir().unwrap();
        let clock = format!("{}203000", today().yyyymmdd());
        let server = Server::spawn_with(&fake, &tmp.path().join("run/server.lock"), tmp.path(), &[("VALLY_CLOCK_START", OsStr::new(&clock))]);
        let base = format!("http://{}", server.addr().await);
        Api { server, fake, client: reqwest::Client::new(), base, _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let resp = self.client.get(format!("{}{path}", self.base)).send().await.unwrap();
        let status = resp.status().as_u16();
        (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
    }

    async fn history(&self, endpoint: &str, code: &str, from: KstDate, to: KstDate) -> (u16, Value) {
        self.get(&format!("/api/symbols/{code}/{endpoint}?from={from}&to={to}")).await
    }

    fn chain(&self, endpoint: &str) -> Vec<Option<String>> {
        self.fake.calls().into_iter().filter(|c| c.api_id == api_id(endpoint)).map(|c| c.next_key).collect()
    }

    async fn logs(self) -> String {
        self.server.stop().await
    }

    async fn kiwoom_first_page(&self, endpoint: &str, code: &str) -> Value {
        self.kiwoom_page(endpoint, code, None).await
    }

    async fn kiwoom_page(&self, endpoint: &str, code: &str, next_key: Option<&str>) -> Value {
        let body = if endpoint == FOREIGN { json!({"stk_cd": code}) } else { json!({"dt": today().yyyymmdd(), "stk_cd": code, "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}) };
        let market = market();
        let response = common::support::investors::answer(&market, api_id(endpoint), &body, next_key).unwrap();
        serde_json::from_str(&response.body).unwrap()
    }
}

fn undated_rows(body: &Value) -> Vec<String> {
    let rows = body["undatedRows"].as_array().expect("날짜를 읽지 못한 행 목록");
    assert!(rows.iter().all(|r| r["reason"].as_str().is_some_and(|reason| reason.contains("dt"))), "{body}");
    rows.iter().map(|r| r["dt"].as_str().unwrap().to_owned()).collect()
}

fn break_dates(page: &mut Value, endpoint: &str, next: Option<String>) -> Vec<String> {
    let raw: Vec<String> = page[list(endpoint)].as_array_mut().unwrap().iter_mut().enumerate().map(|(i, row)| {
        let dt = if i % 2 == 0 { "" } else { "2026110X" };
        row["dt"] = json!(dt);
        dt.to_owned()
    }).collect();
    page["_headers"] = json!({"cont-yn": if next.is_some() { "Y" } else { "N" }, "next-key": next.unwrap_or_default()});
    raw
}

fn newest_first(code: &str) -> Vec<KstDate> {
    stock(code).bars.iter().rev().map(|b| b.day).collect()
}

fn skipped(days: &Value) -> Vec<(String, String)> {
    days.as_array().unwrap().iter().map(|d| (d["day"].as_str().unwrap().to_owned(), d["field"].as_str().unwrap().to_owned())).collect()
}

fn expected_days(endpoint: &str, code: &str, from: KstDate, to: KstDate) -> Vec<Value> {
    let stock = stock(code);
    let within = |d: KstDate| (from..=to).contains(&d);
    if endpoint == FOREIGN {
        investors::foreign_days(&stock)
            .into_iter()
            .filter(|f| within(f.day))
            .map(|f| json!({"day": f.day.to_string(), "shares": f.shares, "weightPct": f.weight_basis_points as f64 / 100.0}))
            .collect()
    } else {
        investors::investor_days(&stock)
            .into_iter()
            .filter(|d| within(d.day))
            .map(|d| {
                let mut row = json!({"day": d.day.to_string()});
                for (field, name) in NET_SHARE_NAMES {
                    let k = INVESTOR_FIELDS.iter().position(|f| *f == field).unwrap();
                    row[name] = json!(d.net_shares[k]);
                }
                row
            })
            .collect()
    }
}

fn chain_through(code: &str, pages: usize) -> Vec<Option<String>> {
    std::iter::once(None).chain((1..pages).map(|n| Some(format!("{code}-{n}")))).collect()
}

fn pages_to_reach(code: &str, from: KstDate) -> usize {
    let newest_first: Vec<KstDate> = stock(code).bars.iter().rev().map(|b| b.day).collect();
    newest_first.iter().position(|d| *d <= from).unwrap() / PAGE_ROWS + 1
}

fn empty_answer(endpoint: &str) -> Value {
    let mut body = json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다"});
    body[list(endpoint)] = json!([]);
    body
}

fn invalid_request() -> Value {
    json!({"return_code": 2, "return_msg": "입력 값 오류입니다[1511:필수 입력 값에 값이 존재하지 않습니다]"})
}

#[tokio::test]
async fn unreadable_dates_on_the_first_page_are_distinct_from_a_normal_empty_range() {
    let api = Api::boot().await;
    for endpoint in [FOREIGN, NET_SHARES] {
        let original = api.kiwoom_first_page(endpoint, krx::COMMON).await;
        let mut absent = original.clone();
        absent[list(endpoint)].as_array_mut().unwrap().remove(0);
        api.fake.respond_with(api_id(endpoint), 200, absent);
        let (status, normal_empty) = api.history(endpoint, krx::COMMON, today(), today()).await;
        assert_eq!((status, &normal_empty["days"], &normal_empty["skippedDays"]), (200, &json!([]), &json!([])), "{endpoint}: {normal_empty}");
        for raw in ["", "2026110X"] {
            let mut broken = original.clone();
            broken[list(endpoint)][0]["dt"] = json!(raw);
            api.fake.respond_with(api_id(endpoint), 200, broken);
            let (status, body) = api.history(endpoint, krx::COMMON, today(), today()).await;
            assert_eq!((status, &body["coverage"], &body["days"], &body["skippedDays"]), (200, &normal_empty["coverage"], &json!([]), &json!([])), "{endpoint}: {body}");
            assert_ne!(body, normal_empty, "{endpoint}: 날짜 오류가 정상 빈 기간으로 숨지 않는다");
            assert_eq!(undated_rows(&body), [raw], "{endpoint}: 날짜를 추측하지 않고 원문을 남긴다");
        }
        assert_eq!(undated_rows(&normal_empty), Vec::<String>::new());
    }
    let logs = api.logs().await;
    assert!(logs.lines().any(|l| l.contains("WARN") && l.contains("2026110X") && l.contains(krx::COMMON)), "{logs}");
}

#[tokio::test]
async fn a_wholly_undated_first_page_keeps_its_failures_and_walks_to_older_pages() {
    let api = Api::boot().await;
    let newest = newest_first(krx::COMMON);
    let from = newest[PAGE_ROWS * 2 - 1];
    for endpoint in [FOREIGN, NET_SHARES] {
        let key = format!("{}-1", krx::COMMON);
        let mut broken = api.kiwoom_first_page(endpoint, krx::COMMON).await;
        let second = api.kiwoom_page(endpoint, krx::COMMON, Some(&key)).await;
        let raw = break_dates(&mut broken, endpoint, Some(key.clone()));
        api.fake.reset();
        api.fake.respond_with(api_id(endpoint), 200, broken);
        api.fake.respond_with_for_key(api_id(endpoint), &key, 200, second);
        let seen = api.chain(endpoint).len();
        let (status, body) = api.history(endpoint, krx::COMMON, from, today()).await;
        assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("whole_range")), "{endpoint}: {body}");
        assert_eq!(body["days"].as_array().unwrap(), &expected_days(endpoint, krx::COMMON, from, newest[PAGE_ROWS]), "{endpoint}: 날짜가 깨진 첫 페이지 뒤의 정상 자료도 받는다");
        assert_eq!(undated_rows(&body), raw, "{endpoint}");
        assert_eq!(body["skippedDays"], json!([]), "{endpoint}");
        assert_eq!(api.chain(endpoint)[seen..], chain_through(krx::COMMON, 2), "{endpoint}");
    }
}

#[tokio::test]
async fn a_wholly_undated_middle_page_does_not_hide_older_history() {
    let api = Api::boot().await;
    let newest = newest_first(krx::COMMON);
    let from = newest[PAGE_ROWS * 2 + 10];
    for endpoint in [FOREIGN, NET_SHARES] {
        let key = format!("{}-1", krx::COMMON);
        let mut broken = api.kiwoom_page(endpoint, krx::COMMON, Some(&key)).await;
        let raw = break_dates(&mut broken, endpoint, Some(format!("{}-2", krx::COMMON)));
        api.fake.reset();
        api.fake.respond_with_for_key(api_id(endpoint), &key, 200, broken);
        let seen = api.chain(endpoint).len();
        let (status, body) = api.history(endpoint, krx::COMMON, from, today()).await;
        assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("whole_range")), "{endpoint}: {body}");
        let mut expected = expected_days(endpoint, krx::COMMON, from, newest[PAGE_ROWS * 2]);
        expected.extend(expected_days(endpoint, krx::COMMON, newest[PAGE_ROWS - 1], today()));
        assert_eq!(body["days"].as_array().unwrap(), &expected, "{endpoint}: 날짜가 깨진 중간 페이지를 지나 과거 자료를 받는다");
        assert_eq!(undated_rows(&body), raw, "{endpoint}");
        assert_eq!(body["skippedDays"], json!([]), "{endpoint}");
        assert_eq!(api.chain(endpoint)[seen..], chain_through(krx::COMMON, 3), "{endpoint}");
    }
    let logs = api.logs().await;
    assert!(logs.lines().any(|l| l.contains("WARN") && l.contains("2026110X") && l.contains(krx::COMMON)), "{logs}");
}

#[tokio::test]
async fn wholly_undated_history_has_no_invented_start_date_or_unknown_symbol_error() {
    let api = Api::boot().await;
    for endpoint in [FOREIGN, NET_SHARES] {
        let mut page = api.kiwoom_first_page(endpoint, krx::COMMON).await;
        page[list(endpoint)].as_array_mut().unwrap().truncate(2);
        let raw = break_dates(&mut page, endpoint, None);
        api.fake.reset();
        api.fake.respond_with(api_id(endpoint), 200, page);
        let seen = api.chain(endpoint).len();
        let (status, body) = api.history(endpoint, krx::COMMON, today(), today()).await;
        assert_eq!((status, &body["coverage"], &body["days"], &body["skippedDays"]), (200, &json!({"kind": "no_readable_dates"}), &json!([]), &json!([])), "{endpoint}: {body}");
        assert_eq!(undated_rows(&body), raw, "{endpoint}");
        assert_eq!(api.chain(endpoint)[seen..], [None], "{endpoint}");

        let mut blank = json!({"return_code": 0});
        blank[list(endpoint)] = json!([{"dt": ""}]);
        api.fake.respond_with(api_id(endpoint), 200, blank);
        let (status, body) = api.history(endpoint, krx::COMMON, today(), today()).await;
        assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("no_readable_dates")), "{endpoint}: 빈 문자열 행도 날짜 오류를 보존한다: {body}");
        assert_eq!(undated_rows(&body), [""], "{endpoint}");
    }
}

#[tokio::test]
async fn distinct_undated_pages_with_the_same_date_errors_still_reach_dated_history() {
    let api = Api::boot().await;
    let newest = newest_first(krx::COMMON);
    let from = newest[PAGE_ROWS * 3 - 1];
    for endpoint in [FOREIGN, NET_SHARES] {
        let second_key = format!("{}-1", krx::COMMON);
        let third_key = format!("{}-2", krx::COMMON);
        let mut first = api.kiwoom_first_page(endpoint, krx::COMMON).await;
        let mut second = api.kiwoom_page(endpoint, krx::COMMON, Some(&second_key)).await;
        let third = api.kiwoom_page(endpoint, krx::COMMON, Some(&third_key)).await;
        let mut raw = break_dates(&mut first, endpoint, Some(second_key.clone()));
        raw.extend(break_dates(&mut second, endpoint, Some(third_key.clone())));
        api.fake.reset();
        api.fake.respond_with(api_id(endpoint), 200, first);
        api.fake.respond_with_for_key(api_id(endpoint), &second_key, 200, second);
        api.fake.respond_with_for_key(api_id(endpoint), &third_key, 200, third);
        let seen = api.chain(endpoint).len();
        let (status, body) = api.history(endpoint, krx::COMMON, from, today()).await;
        assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("whole_range")), "{endpoint}: {body}");
        assert_eq!(body["days"].as_array().unwrap(), &expected_days(endpoint, krx::COMMON, from, newest[PAGE_ROWS * 2]), "{endpoint}");
        assert_eq!(undated_rows(&body), raw, "{endpoint}: 같은 날짜 오류여도 서로 다른 원본 행을 합치지 않는다");
        assert_eq!(api.chain(endpoint)[seen..], chain_through(krx::COMMON, 3), "{endpoint}");
    }
}

#[tokio::test]
async fn repeated_continuation_keys_or_undated_pages_stop_without_looping() {
    let api = Api::boot().await;
    for endpoint in [FOREIGN, NET_SHARES] {
        for repeat_key in [true, false] {
            api.fake.reset();
            let key = format!("{}-1", krx::COMMON);
            let third_key = format!("{}-2", krx::COMMON);
            let mut first = api.kiwoom_first_page(endpoint, krx::COMMON).await;
            let mut second = api.kiwoom_page(endpoint, krx::COMMON, Some(&key)).await;
            let mut raw = break_dates(&mut first, endpoint, Some(key.clone()));
            raw.extend(break_dates(&mut second, endpoint, Some(if repeat_key { key.clone() } else { third_key.clone() })));
            api.fake.reset();
            api.fake.respond_with(api_id(endpoint), 200, first);
            api.fake.respond_with_for_key(api_id(endpoint), &key, 200, second.clone());
            if !repeat_key {
                second["_headers"] = json!({"cont-yn": "Y", "next-key": format!("{}-3", krx::COMMON)});
                api.fake.respond_with_for_key(api_id(endpoint), &third_key, 200, second);
            }
            let seen = api.chain(endpoint).len();
            let (status, body) = tokio::time::timeout(std::time::Duration::from_secs(10), api.history(endpoint, krx::COMMON, day(2020, 1, 1), today())).await.expect("반복 페이지를 유한한 요청으로 멈춘다");
            assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("no_readable_dates")), "{endpoint}: {body}");
            assert_eq!(undated_rows(&body), raw, "{endpoint}: 반복된 페이지의 실패는 다시 넣지 않는다");
            assert_eq!(api.chain(endpoint)[seen..], chain_through(krx::COMMON, if repeat_key { 2 } else { 3 }), "{endpoint}");
        }
    }
}

#[tokio::test]
async fn an_empty_or_repeated_dated_page_still_ends_the_walk_even_with_a_next_key() {
    let api = Api::boot().await;
    let newest = newest_first(krx::COMMON);
    for endpoint in [FOREIGN, NET_SHARES] {
        for repeat in [false, true] {
            api.fake.reset();
            let mut page = if repeat { api.kiwoom_first_page(endpoint, krx::COMMON).await } else { empty_answer(endpoint) };
            page["_headers"] = json!({"cont-yn": "Y", "next-key": format!("{}-2", krx::COMMON)});
            api.fake.respond_with_for_key(api_id(endpoint), &format!("{}-1", krx::COMMON), 200, page);
            let seen = api.chain(endpoint).len();
            let (status, body) = api.history(endpoint, krx::COMMON, day(2020, 1, 1), today()).await;
            assert_eq!((status, &body["coverage"]), (200, &json!({"kind": "kiwoom_starts_later", "firstDay": newest[PAGE_ROWS - 1].to_string()})), "{endpoint}: {body}");
            assert_eq!(body["days"].as_array().unwrap(), &expected_days(endpoint, krx::COMMON, newest[PAGE_ROWS - 1], today()), "{endpoint}");
            assert_eq!(undated_rows(&body), Vec::<String>::new(), "{endpoint}");
            assert_eq!(api.chain(endpoint)[seen..], chain_through(krx::COMMON, 2), "{endpoint}");
        }
    }
}

#[tokio::test]
async fn a_range_over_several_pages_comes_back_whole_in_day_order_and_the_walk_stops_at_from() {
    let api = Api::boot().await;
    let (from, to) = (day(2025, 1, 2), day(2026, 6, 30));
    let pages = pages_to_reach(krx::PRE_1985, from);
    assert!(pages >= 3, "{pages}페이지: 여러 페이지에 걸친 기간이어야 한다");
    for endpoint in [FOREIGN, NET_SHARES] {
        let (status, body) = api.history(endpoint, krx::PRE_1985, from, to).await;
        assert_eq!(status, 200, "{endpoint}: {body}");
        assert_eq!((&body["symbol"], &body["from"], &body["to"]), (&json!(krx::PRE_1985), &json!("2025-01-02"), &json!("2026-06-30")), "{endpoint}");
        assert_eq!(body["coverage"], json!({"kind": "whole_range"}), "{endpoint}");
        let days = body["days"].as_array().unwrap();
        assert_eq!(days, &expected_days(endpoint, krx::PRE_1985, from, to), "{endpoint}: 기간 안의 날만, 빠짐·겹침 없이, 오래된 날부터");
        assert_eq!(body["skippedDays"], json!([]), "{endpoint}");
        assert_eq!(api.chain(endpoint), chain_through(krx::PRE_1985, pages), "{endpoint}: from에 닿은 페이지에서 멈춘다");
    }
    let bodies: Vec<Value> = api.fake.calls().into_iter().filter(|c| c.api_id == "ka10059").map(|c| c.body).collect();
    assert!(bodies.iter().all(|b| b["dt"] == today().yyyymmdd()), "ka10059는 언제나 오늘부터 거꾸로 받는다: {bodies:?}");
}

#[tokio::test]
async fn a_range_longer_than_kiwooms_history_gives_what_kiwoom_has_and_says_where_it_starts() {
    let api = Api::boot().await;
    let common = stock(krx::COMMON);
    let first = common.bars[0].day;
    let whole = chain_through(krx::COMMON, common.bars.len().div_ceil(PAGE_ROWS));
    for endpoint in [FOREIGN, NET_SHARES] {
        let (from, to) = (day(2020, 1, 1), today());
        let (status, body) = api.history(endpoint, krx::COMMON, from, to).await;
        assert_eq!(status, 200, "{endpoint}: {body}");
        assert_eq!(body["coverage"], json!({"kind": "kiwoom_starts_later", "firstDay": first.to_string()}), "{endpoint}");
        assert_eq!(body["days"].as_array().unwrap(), &expected_days(endpoint, krx::COMMON, from, to), "{endpoint}");
        assert_eq!(api.chain(endpoint), whole, "{endpoint}: 키움이 cont-yn N을 줄 때까지 받는다");
    }

    let (status, before_listing) = api.history(NET_SHARES, krx::COMMON, day(2019, 1, 1), day(2019, 12, 31)).await;
    assert_eq!(status, 200, "{before_listing}");
    assert_eq!((&before_listing["coverage"]["firstDay"], &before_listing["days"]), (&json!(first.to_string()), &json!([])), "기간 전체가 키움 자료보다 이르면 빈 날과 시작일");
    assert_eq!(before_listing["skippedDays"], json!([]), "자료가 없는 기간은 빠진 날도 없다");
}

#[tokio::test]
async fn kiwooms_empty_answer_is_an_unknown_stock_and_does_not_stop_the_path() {
    let api = Api::boot().await;
    for endpoint in [FOREIGN, NET_SHARES] {
        api.fake.respond_with(api_id(endpoint), 200, empty_answer(endpoint));
        let (status, body) = api.history(endpoint, krx::COMMON, day(2026, 1, 2), today()).await;
        assert_eq!((status, &body["error"]["code"]), (404, &json!("unknown_symbol")), "{endpoint}: {body}");
        assert_eq!(api.chain(endpoint), [None], "{endpoint}: 첫 페이지만 보낸다");
        api.fake.reset();
        let (status, body) = api.history(endpoint, krx::COMMON, day(2026, 1, 2), today()).await;
        assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("whole_range")), "{endpoint}: {body}");
    }
}

#[tokio::test]
async fn a_failure_on_the_first_page_answers_the_error_and_the_next_request_starts_over() {
    let api = Api::boot().await;
    let (from, to) = (day(2025, 1, 2), today());
    for endpoint in [FOREIGN, NET_SHARES] {
        api.fake.respond_with(api_id(endpoint), 200, invalid_request());
        let (status, body) = api.history(endpoint, krx::PRE_1985, from, to).await;
        assert_eq!((status, &body["error"]["reason"], &body["error"]["manualActionRequired"]), (500, &json!("invalid_request"), &json!(false)), "{endpoint}: {body}");
        assert_eq!(api.chain(endpoint), [None], "{endpoint}: 요청 오류는 다시 보내지 않는다");
        api.fake.reset();
        let (status, body) = api.history(endpoint, krx::PRE_1985, from, to).await;
        assert_eq!(status, 200, "{endpoint}: {body}");
        assert_eq!(body["days"].as_array().unwrap(), &expected_days(endpoint, krx::PRE_1985, from, to), "{endpoint}");
    }
    let logs = api.logs().await;
    assert!(logs.lines().any(|l| l.contains("외국인 보유 요청에 답하지 못했습니다")), "{logs}");
    assert!(logs.lines().any(|l| l.contains("투자자별 순매수 요청에 답하지 못했습니다")), "{logs}");
}

#[tokio::test]
async fn a_failure_on_a_middle_page_answers_the_error_instead_of_a_shortened_history() {
    let api = Api::boot().await;
    let (from, to) = (day(2025, 1, 2), today());
    let pages = pages_to_reach(krx::PRE_1985, from);
    assert!(pages >= 4, "{pages}");
    let third = format!("{}-2", krx::PRE_1985);
    for endpoint in [FOREIGN, NET_SHARES] {
        api.fake.respond_with_for_key(api_id(endpoint), &third, 200, invalid_request());
        let seen = api.chain(endpoint).len();
        let (status, body) = api.history(endpoint, krx::PRE_1985, from, to).await;
        assert_eq!((status, &body["error"]["reason"]), (500, &json!("invalid_request")), "{endpoint}: 받은 두 페이지로 줄인 기간을 주지 않는다: {body}");
        assert!(body.get("days").is_none(), "{endpoint}: {body}");
        assert_eq!(api.chain(endpoint)[seen..], chain_through(krx::PRE_1985, 3), "{endpoint}: 실패한 페이지에서 멈춘다");
        api.fake.reset();
        let (status, body) = api.history(endpoint, krx::PRE_1985, from, to).await;
        assert_eq!(status, 200, "{endpoint}: {body}");
        assert_eq!(body["days"].as_array().unwrap(), &expected_days(endpoint, krx::PRE_1985, from, to), "{endpoint}: 다시 물으면 처음부터 다시 받는다");
    }
}

#[tokio::test]
async fn a_success_without_the_list_is_a_protocol_failure_that_stops_the_path_not_an_empty_history() {
    let api = Api::boot().await;
    for endpoint in [FOREIGN, NET_SHARES] {
        api.fake.respond_with(api_id(endpoint), 200, json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다"}));
        let (status, body) = api.history(endpoint, krx::COMMON, day(2026, 1, 2), today()).await;
        assert_eq!((status, &body["error"]["reason"], &body["error"]["manualActionRequired"]), (500, &json!("protocol"), &json!(true)), "{endpoint}: {body}");
        api.fake.reset();
        let (_, again) = api.history(endpoint, krx::COMMON, day(2026, 1, 2), today()).await;
        assert_eq!(again["error"]["reason"], json!("protocol"), "{endpoint}: {again}");
        assert_eq!(api.chain(endpoint), [None], "{endpoint}: 형식 오류 뒤에는 그 TR을 다시 보내지 않는다");
    }
}

#[tokio::test]
async fn when_every_row_in_the_range_is_unreadable_the_days_are_empty_and_each_row_is_a_skipped_day() {
    let api = Api::boot().await;
    let newest_first = newest_first(krx::COMMON);
    let (from, to) = (newest_first[50], newest_first[10]);
    for (endpoint, kiwoom_field, field) in [(FOREIGN, "poss_stkcnt", "shares"), (NET_SHARES, "natn", "government")] {
        let mut page = api.kiwoom_first_page(endpoint, krx::COMMON).await;
        for row in page[list(endpoint)].as_array_mut().unwrap() {
            row[kiwoom_field] = json!("");
        }
        api.fake.respond_with(api_id(endpoint), 200, page);

        let (status, body) = api.history(endpoint, krx::COMMON, from, to).await;
        assert_eq!((status, &body["coverage"]["kind"], &body["days"]), (200, &json!("whole_range"), &json!([])), "{endpoint}: {body}");
        let want: Vec<(String, String)> = newest_first[10..=50].iter().rev().map(|d| (d.to_string(), field.to_owned())).collect();
        assert_eq!(skipped(&body["skippedDays"]), want, "{endpoint}: 기간 안에서 뺀 행은 빠짐없이, 기간 밖의 행은 넣지 않는다");
        assert!(body["skippedDays"].as_array().unwrap().iter().all(|d| d["reason"].as_str().unwrap().starts_with(&format!("{kiwoom_field}: "))), "{endpoint}: {body}");

        let (status, one_day) = api.history(endpoint, krx::COMMON, today(), today()).await;
        assert_eq!((status, &one_day["days"]), (200, &json!([])), "{endpoint}: {one_day}");
        assert_eq!(skipped(&one_day["skippedDays"]), [(today().to_string(), field.to_owned())], "{endpoint}: 하루짜리 기간도 빈 기간과 구별된다");
    }
}

#[tokio::test]
async fn some_unreadable_rows_stay_out_of_days_and_only_those_come_back_as_skipped_days() {
    let api = Api::boot().await;
    let newest_first = newest_first(krx::COMMON);
    let from = newest_first[PAGE_ROWS - 1];
    let mut broken_days = Vec::new();
    for (endpoint, broken) in [(FOREIGN, [(2, "poss_stkcnt", "N/A", "shares"), (5, "wght", "", "weightPct")]), (NET_SHARES, [(2, "natn", "", "government"), (5, "orgn", "x", "institution")])] {
        let mut page = api.kiwoom_first_page(endpoint, krx::COMMON).await;
        for (row, kiwoom_field, text, _) in broken {
            assert_eq!(page[list(endpoint)][row]["dt"], newest_first[row].yyyymmdd());
            page[list(endpoint)][row][kiwoom_field] = json!(text);
        }
        api.fake.respond_with(api_id(endpoint), 200, page);

        let (status, body) = api.history(endpoint, krx::COMMON, from, today()).await;
        assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("whole_range")), "{endpoint}: {body}");
        let left_out: Vec<String> = broken.iter().map(|(row, ..)| newest_first[*row].to_string()).collect();
        let want: Vec<Value> = expected_days(endpoint, krx::COMMON, from, today()).into_iter().filter(|d| !left_out.contains(&d["day"].as_str().unwrap().to_owned())).collect();
        assert_eq!(body["days"].as_array().unwrap(), &want, "{endpoint}: 그 행만 빠진다");
        let want_skipped: Vec<(String, String)> = broken.iter().rev().map(|(row, _, _, field)| (newest_first[*row].to_string(), field.to_string())).collect();
        assert_eq!(skipped(&body["skippedDays"]), want_skipped, "{endpoint}: 빠진 행만, 오래된 날부터");
        broken_days.extend(broken.iter().map(|(row, ..)| newest_first[*row].yyyymmdd()));
    }
    let logs = api.logs().await;
    for dt in broken_days {
        assert!(logs.lines().any(|l| l.contains("WARN") && l.contains("행을 읽지 못해") && l.contains(&dt) && l.contains(krx::COMMON)), "{dt}: 종목과 날을 남긴다: {logs}");
    }
}

#[tokio::test]
async fn bad_ranges_and_symbols_are_rejected_before_asking_kiwoom() {
    let api = Api::boot().await;
    for (path, status, code) in [
        ("/api/symbols/110020/foreign-holdings?to=2026-11-06", 400, "bad_request"),
        ("/api/symbols/110020/foreign-holdings?from=2026-1-2&to=2026-11-06", 400, "bad_request"),
        ("/api/symbols/110020/investor-net-shares?from=2026-11-06&to=2026-01-02", 400, "bad_request"),
        ("/api/symbols/IDX:001/investor-net-shares?from=2026-01-02&to=2026-11-06", 400, "bad_request"),
        ("/api/symbols/999999/foreign-holdings?from=2026-01-02&to=2026-11-06", 404, "unknown_symbol"),
    ] {
        let (got, body) = api.get(path).await;
        assert_eq!((got, &body["error"]["code"]), (status, &json!(code)), "{path}: {body}");
    }
    assert!(api.chain(FOREIGN).is_empty() && api.chain(NET_SHARES).is_empty());
}
