mod common;

use std::ffi::OsStr;

use common::{FakeKiwoom, Server};
use domain::KstDate;
use fake_kiwoom::investors::{self, INVESTOR_FIELDS, PAGE_ROWS};
use fake_kiwoom::krx::{self, KrxMarket, KrxStock};
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
    fake: FakeKiwoom,
    client: reqwest::Client,
    base: String,
    _tmp: tempfile::TempDir,
}

impl Api {
    async fn boot() -> Api {
        let fake = FakeKiwoom::start().await;
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
    body[list(endpoint)] = json!([{"dt": "", "poss_stkcnt": "", "wght": "", "orgn": "", "ind_invsr": ""}]);
    body
}

fn invalid_request() -> Value {
    json!({"return_code": 2, "return_msg": "입력 값 오류입니다[1511:필수 입력 값에 값이 존재하지 않습니다]"})
}

#[tokio::test(flavor = "multi_thread")]
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
        assert_eq!(api.chain(endpoint), chain_through(krx::PRE_1985, pages), "{endpoint}: from에 닿은 페이지에서 멈춘다");
    }
    let bodies: Vec<Value> = api.fake.calls().into_iter().filter(|c| c.api_id == "ka10059").map(|c| c.body).collect();
    assert!(bodies.iter().all(|b| b["dt"] == today().yyyymmdd()), "ka10059는 언제나 오늘부터 거꾸로 받는다: {bodies:?}");
}

#[tokio::test(flavor = "multi_thread")]
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
}

#[tokio::test(flavor = "multi_thread")]
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

#[tokio::test(flavor = "multi_thread")]
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

#[tokio::test(flavor = "multi_thread")]
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

#[tokio::test(flavor = "multi_thread")]
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

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_row_is_left_out_and_logged_while_the_other_days_come_back() {
    let api = Api::boot().await;
    let newest_first: Vec<KstDate> = stock(krx::COMMON).bars.iter().rev().map(|b| b.day).collect();
    let (from, broken_day) = (newest_first[PAGE_ROWS - 1], newest_first[2]);
    let page = reqwest::Client::new()
        .post(format!("{}/api/dostk/frgnistt", api.fake.base_url()))
        .header("api-id", "ka10008")
        .header("authorization", format!("Bearer {}", common::TOKEN))
        .body(json!({"stk_cd": krx::COMMON}).to_string())
        .send()
        .await
        .unwrap();
    let mut only_page: Value = serde_json::from_str(&page.text().await.unwrap()).unwrap();
    assert_eq!(only_page["stk_frgnr"][2]["dt"], broken_day.yyyymmdd());
    only_page["stk_frgnr"][2]["poss_stkcnt"] = json!("N/A");
    api.fake.respond_with("ka10008", 200, only_page);
    let (status, body) = api.history(FOREIGN, krx::COMMON, from, today()).await;
    assert_eq!((status, &body["coverage"]["kind"]), (200, &json!("whole_range")), "{body}");
    let want: Vec<Value> = expected_days(FOREIGN, krx::COMMON, from, today()).into_iter().filter(|d| d["day"] != json!(broken_day.to_string())).collect();
    assert_eq!(body["days"].as_array().unwrap(), &want, "그 행만 빠진다");
    let logs = api.logs().await;
    assert!(logs.lines().any(|l| l.contains("WARN") && l.contains("행을 읽지 못해") && l.contains(&broken_day.yyyymmdd()) && l.contains(krx::COMMON)), "종목과 날을 남긴다: {logs}");
}

#[tokio::test(flavor = "multi_thread")]
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
