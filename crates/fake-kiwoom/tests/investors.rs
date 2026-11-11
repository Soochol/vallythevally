use domain::KstDate;
use fake_kiwoom::investors::{self, INVESTOR_FIELDS, PAGE_ROWS};
use fake_kiwoom::krx::{self, KrxMarket, KrxStock};
use fake_kiwoom::{FakeKiwoom, TOKEN};
use serde_json::{Value, json};

struct Reply {
    status: u16,
    cont: String,
    next: String,
    body: Value,
}

async fn kiwoom(fake: &FakeKiwoom, api_id: &str, body: Value, next_key: Option<&str>) -> Reply {
    let path = if api_id == "ka10008" { "/api/dostk/frgnistt" } else { "/api/dostk/stkinfo" };
    let mut req = reqwest::Client::new()
        .post(format!("{}{path}", fake.base_url()))
        .header("api-id", api_id)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json;charset=UTF-8")
        .body(body.to_string());
    if let Some(k) = next_key {
        req = req.header("cont-yn", "Y").header("next-key", k);
    }
    let resp = req.send().await.unwrap();
    let h = |k: &str| resp.headers().get(k).map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
    let (status, cont, next) = (resp.status().as_u16(), h("cont-yn"), h("next-key"));
    let text = resp.text().await.unwrap();
    Reply { status, cont, next, body: serde_json::from_str(&text).unwrap_or(Value::String(text)) }
}

fn as_of() -> KstDate {
    KstDate::new(2026, 11, 6).unwrap()
}

fn market() -> KrxMarket {
    KrxMarket::sample(as_of())
}

fn stock<'a>(market: &'a KrxMarket, code: &str) -> &'a KrxStock {
    market.stocks.iter().find(|s| s.code == code).unwrap()
}

fn net_shares(base_day: KstDate) -> Value {
    json!({"dt": base_day.yyyymmdd(), "stk_cd": krx::COMMON, "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"})
}

async fn whole_chain(fake: &FakeKiwoom, api_id: &str, body: Value, list: &str) -> (Vec<Value>, Vec<String>) {
    let (mut rows, mut keys) = (Vec::new(), Vec::new());
    let mut next = None;
    loop {
        let reply = kiwoom(fake, api_id, body.clone(), next.as_deref()).await;
        assert_eq!((reply.status, &reply.body["return_code"]), (200, &json!(0)), "{}", reply.body);
        let page = reply.body[list].as_array().unwrap().clone();
        assert!(page.len() <= PAGE_ROWS);
        rows.extend(page);
        if reply.cont == "N" {
            assert_eq!(reply.next, "");
            return (rows, keys);
        }
        assert_eq!(reply.cont, "Y");
        keys.push(reply.next.clone());
        next = Some(reply.next);
    }
}

#[tokio::test]
async fn foreign_holdings_page_back_from_the_newest_day_to_the_first_listed_day() {
    let fake = FakeKiwoom::start().await;
    let market = market();
    fake.set_krx_market(market.clone());
    let common = stock(&market, krx::COMMON);
    let (rows, keys) = whole_chain(&fake, "ka10008", json!({"stk_cd": krx::COMMON}), "stk_frgnr").await;

    let want: Vec<_> = investors::foreign_days(common).into_iter().rev().collect();
    assert_eq!(rows.len(), common.bars.len());
    assert_eq!(keys, (1..common.bars.len().div_ceil(PAGE_ROWS)).map(|n| format!("{}-{n}", krx::COMMON)).collect::<Vec<_>>());
    for (row, day) in rows.iter().zip(&want) {
        assert_eq!(row["dt"], day.day.yyyymmdd());
        assert_eq!(row["poss_stkcnt"], day.shares.to_string());
        assert_eq!(row["wght"], format!("+{}.{:02}", day.weight_basis_points / 100, day.weight_basis_points % 100));
    }
    let listed = investors::listed_shares(common);
    assert!(want.iter().all(|d| d.listed_shares == listed && d.shares < listed), "보유주식수는 그 종목 상장주식수({listed}) 안이다");
    assert_eq!(rows[0]["frgnr_limit"], listed.to_string());
    assert_eq!(rows[0]["dt"], as_of().yyyymmdd());
    assert_eq!(rows.last().unwrap()["dt"], common.bars[0].day.yyyymmdd());
    let changed = |i: usize| want[i].shares as i64 - want[i + 1].shares as i64;
    assert_eq!(rows[0]["chg_qty"], if changed(0) > 0 { format!("+{}", changed(0)) } else { changed(0).to_string() });
}

#[tokio::test]
async fn investor_net_shares_page_back_from_the_requested_day() {
    let fake = FakeKiwoom::start().await;
    let market = market();
    fake.set_krx_market(market.clone());
    let common = stock(&market, krx::COMMON);
    let base_day = KstDate::new(2025, 1, 1).unwrap();
    let (rows, _) = whole_chain(&fake, "ka10059", net_shares(base_day), "stk_invsr_orgn").await;

    let want: Vec<_> = investors::investor_days(common).into_iter().rev().filter(|d| d.day <= base_day).collect();
    assert_eq!(rows.len(), want.len());
    assert_eq!(rows[0]["dt"], "20241231", "dt 이후의 날은 주지 않는다");
    for (row, day) in rows.iter().zip(&want) {
        assert_eq!(row["dt"], day.day.yyyymmdd());
        for (field, net) in INVESTOR_FIELDS.iter().zip(day.net_shares) {
            let text = row[*field].as_str().unwrap();
            assert_eq!(text.parse::<i64>().unwrap(), net, "{field}");
            assert_eq!(text.starts_with('+'), net > 0, "{field} {text}: 키움처럼 양수에 +를 붙인다");
        }
    }
    let fields_differ = want.iter().any(|d| d.net_shares.windows(2).all(|w| w[0] != w[1]));
    assert!(fields_differ, "필드를 바꿔 읽으면 값이 달라지도록 투자자마다 다른 값이다");
}

#[tokio::test]
async fn investor_net_shares_answer_only_net_buying_in_single_shares() {
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(market());
    for (field, value) in [("amt_qty_tp", "1"), ("trde_tp", "1"), ("unit_tp", "1000")] {
        let mut body = net_shares(as_of());
        body[field] = value.into();
        assert_eq!(kiwoom(&fake, "ka10059", body, None).await.status, 500, "{field}={value}");
    }
    let mut no_dt = net_shares(as_of());
    no_dt.as_object_mut().unwrap().remove("dt");
    assert_eq!(kiwoom(&fake, "ka10059", no_dt, None).await.status, 500);
}

#[tokio::test]
async fn a_code_outside_the_market_gets_one_empty_row() {
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(market());
    for (api_id, body, list) in [("ka10008", json!({"stk_cd": "999999"}), "stk_frgnr"), ("ka10059", json!({"dt": "20261106", "stk_cd": "999999", "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}), "stk_invsr_orgn")] {
        let reply = kiwoom(&fake, api_id, body, None).await;
        assert_eq!((reply.status, reply.cont.as_str(), &reply.body["return_code"]), (200, "N", &json!(0)), "{api_id}");
        let rows = reply.body[list].as_array().unwrap();
        assert_eq!(rows.len(), 1, "{api_id}");
        assert!(rows[0]["dt"] == "" && rows[0].as_object().unwrap().values().all(|v| v == ""), "{api_id}: {}", rows[0]);
    }
}

#[tokio::test]
async fn a_next_key_answer_replaces_only_that_page_until_reset() {
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(market());
    let second = format!("{}-1", krx::COMMON);
    let broken = json!({"return_code": 2, "return_msg": "입력 값 오류입니다[1511:필수 입력 값에 값이 존재하지 않습니다]"});
    fake.respond_with_for_key("ka10008", &second, 200, broken.clone());

    let first = kiwoom(&fake, "ka10008", json!({"stk_cd": krx::COMMON}), None).await;
    assert_eq!((first.cont.as_str(), first.next.as_str()), ("Y", second.as_str()));
    assert_eq!(kiwoom(&fake, "ka10008", json!({"stk_cd": krx::COMMON}), Some(&second)).await.body, broken);
    assert_eq!(kiwoom(&fake, "ka10059", net_shares(as_of()), Some(&second)).await.body["return_code"], 0, "다른 api-id의 같은 키는 그대로다");
    assert_eq!(kiwoom(&fake, "ka10008", json!({"stk_cd": krx::COMMON}), Some(&format!("{}-2", krx::COMMON))).await.body["return_code"], 0);

    fake.reset();
    let healed = kiwoom(&fake, "ka10008", json!({"stk_cd": krx::COMMON}), Some(&second)).await;
    let newest_first: Vec<_> = investors::foreign_days(stock(&market(), krx::COMMON)).into_iter().rev().collect();
    assert_eq!(first.body["stk_frgnr"][PAGE_ROWS - 1]["dt"], newest_first[PAGE_ROWS - 1].day.yyyymmdd());
    assert_eq!(healed.body["stk_frgnr"][0]["dt"], newest_first[PAGE_ROWS].day.yyyymmdd(), "둘째 페이지는 첫 페이지 바로 다음 날부터다");
}

#[tokio::test]
async fn an_overridden_page_can_keep_its_continuation_headers_and_http_status() {
    let fake = FakeKiwoom::start().await;
    fake.set_krx_market(market());
    let key = format!("{}-1", krx::COMMON);
    for api_id in ["ka10008", "ka10059"] {
        let body = json!({"return_code": 0, "_headers": {"cont-yn": "Y", "next-key": "older"}});
        fake.respond_with_for_key(api_id, &key, 206, body);
        let request = if api_id == "ka10008" { json!({"stk_cd": krx::COMMON}) } else { net_shares(as_of()) };
        let reply = kiwoom(&fake, api_id, request, Some(&key)).await;
        assert_eq!((reply.status, reply.cont.as_str(), reply.next.as_str(), reply.body), (206, "Y", "older", json!({"return_code": 0})), "{api_id}");
    }
}
