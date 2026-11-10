mod common;

use common::{FakeKiwoom, Server};
use serde_json::{Value, json};

struct ScreensApi {
    client: reqwest::Client,
    url: String,
}

impl ScreensApi {
    async fn of(server: &Server) -> ScreensApi {
        ScreensApi { client: reqwest::Client::new(), url: format!("http://{}/api/screens", server.addr().await) }
    }

    async fn get(&self) -> (u16, Value) {
        reply(self.client.get(&self.url).send().await.unwrap()).await
    }

    async fn put(&self, body: String) -> (u16, Value) {
        reply(self.client.put(&self.url).header("content-type", "application/json").body(body).send().await.unwrap()).await
    }
}

async fn reply(resp: reqwest::Response) -> (u16, Value) {
    let status = resp.status().as_u16();
    (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
}

fn screen(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name, "period": "D", "exclude": [], "conditions": [{"field": "high", "n": 200, "m": 1}]})
}

fn screens(list: Vec<Value>, revision: i64) -> Value {
    json!({"screens": list, "revision": revision})
}

fn every_kind() -> Value {
    json!(["etf", "preferred", "reit", "spac", "managed", "investment_caution_alert", "investment_warning",
           "investment_danger", "investment_caution", "short_term_overheated", "trading_halted"])
}

#[tokio::test(flavor = "multi_thread")]
async fn screens_start_empty_are_replaced_whole_and_survive_a_restart() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let server = Server::spawn(&fake, &lock, tmp.path());
    let api = ScreensApi::of(&server).await;
    assert_eq!(api.get().await, (200, json!({"screens": [], "revision": 0})));

    let two = screens(vec![
        json!({"id": "0193aaaa-0000-7000-8000-000000000001", "name": "고가 200일 신고가", "period": "D", "exclude": every_kind(),
               "conditions": [{"field": "high", "n": 200, "m": 5}, {"field": "volume", "n": 60, "m": 60}]}),
        json!({"id": "S2", "name": "월봉 종가", "period": "M", "exclude": ["spac", "etf"], "conditions": [{"field": "close", "n": 12, "m": 1}]}),
    ], 1_794_152_040_001);
    assert_eq!(api.put(two.to_string()).await, (200, two.clone()));
    assert_eq!(api.get().await, (200, two), "조건식 순서, 제외 순서, 조건 순서를 그대로 돌려준다");

    let one = screens(vec![screen("S3", "저가")], 1_794_152_040_002);
    assert_eq!(api.put(one.to_string()).await, (200, one.clone()));
    assert_eq!(api.get().await, (200, one.clone()), "목록 전체를 바꾼다");

    server.stop().await;
    let server = Server::spawn(&fake, &lock, tmp.path());
    let api = ScreensApi::of(&server).await;
    assert_eq!(api.get().await, (200, one), "서버를 다시 켜도 남는다");

    let none = screens(vec![], 1_794_152_040_003);
    assert_eq!(api.put(none.to_string()).await, (200, none.clone()), "조건식 0개도 저장한다");
    assert_eq!(api.get().await, (200, none));
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn each_screen_rule_and_a_stale_revision_rejects_the_save() {
    let fake = FakeKiwoom::start().await;
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), tmp.path());
    let api = ScreensApi::of(&server).await;
    let saved = screens(vec![screen("S1", "기본")], 10);
    assert_eq!(api.put(saved.to_string()).await, (200, saved.clone()));

    let edit = |change: &dyn Fn(&mut Value)| {
        let mut one = screen("S1", "기본");
        change(&mut one);
        screens(vec![one], 11).to_string()
    };
    let condition = |n: Value, m: Value| edit(&|s| s["conditions"][0] = json!({"field": "high", "n": n, "m": m}));
    let many = |count: usize| screens((0..count).map(|i| screen(&format!("S{i}"), &format!("조건식 {i}"))).collect(), 11).to_string();
    for (case, body, status, code) in [
        ("조건식 51개", many(51), 400, "bad_request"),
        ("겹친 id", screens(vec![screen("S1", "가"), screen("S1", "나")], 11).to_string(), 400, "bad_request"),
        ("빈 id", edit(&|s| s["id"] = json!("")), 400, "bad_request"),
        ("65바이트 id", edit(&|s| s["id"] = json!("x".repeat(65))), 400, "bad_request"),
        ("빈 이름", edit(&|s| s["name"] = json!("")), 400, "bad_request"),
        ("공백뿐인 이름", edit(&|s| s["name"] = json!(" \t\u{3000} ")), 400, "bad_request"),
        ("41자 이름", edit(&|s| s["name"] = json!("가".repeat(41))), 400, "bad_request"),
        ("조건 0줄", edit(&|s| s["conditions"] = json!([])), 400, "bad_request"),
        ("조건 11줄", edit(&|s| s["conditions"] = json!(vec![json!({"field": "high", "n": 2, "m": 1}); 11])), 400, "bad_request"),
        ("m = 0", condition(json!(5), json!(0)), 400, "bad_request"),
        ("m > n", condition(json!(5), json!(6)), 400, "bad_request"),
        ("n = 0", condition(json!(0), json!(1)), 400, "bad_request"),
        ("정수가 아닌 m", condition(json!(5), json!(1.5)), 400, "bad_request"),
        ("정수가 아닌 n", condition(json!(5.5), json!(1)), 400, "bad_request"),
        ("음수 n", condition(json!(-5), json!(1)), 400, "bad_request"),
        ("겹친 제외", edit(&|s| s["exclude"] = json!(["etf", "spac", "etf"])), 400, "bad_request"),
        ("겹친 상태 제외", edit(&|s| s["exclude"] = json!(["trading_halted", "managed", "trading_halted"])), 400, "bad_request"),
        ("모르는 제외", edit(&|s| s["exclude"] = json!(["etn"])), 400, "bad_request"),
        ("모르는 봉 주기", edit(&|s| s["period"] = json!("5m")), 400, "bad_request"),
        ("모르는 값", edit(&|s| s["conditions"][0]["field"] = json!("amount")), 400, "bad_request"),
        ("revision 없음", json!({"screens": [screen("S1", "기본")]}).to_string(), 400, "bad_request"),
        ("같은 revision", screens(vec![screen("S9", "새")], 10).to_string(), 409, "stale_revision"),
        ("옛 revision", screens(vec![screen("S9", "새")], 9).to_string(), 409, "stale_revision"),
    ] {
        let (s, v) = api.put(body).await;
        assert_eq!((s, v["error"]["code"].as_str().unwrap_or("")), (status, code), "{case}: {v}");
        assert!(!v["error"]["message"].as_str().unwrap_or("").is_empty(), "{case}: {v}");
    }
    assert_eq!(api.get().await, (200, saved), "거절한 PUT은 저장하지 않는다");

    let widest = |i: usize| {
        let mut conditions = vec![json!({"field": "open", "n": 1, "m": 1})];
        conditions.extend(vec![json!({"field": "volume", "n": u32::MAX, "m": u32::MAX}); 9]);
        json!({"id": format!("{i:0>64}"), "name": format!(" {} ", "𝄞".repeat(40)), "period": "W", "exclude": every_kind(), "conditions": conditions})
    };
    let edges = screens((0..50).map(widest).collect(), 11);
    assert_eq!(api.put(edges.to_string()).await, (200, edges.clone()), "규칙마다 가장 끝 값을 모두 채운 조건식 50개도 받는다");
    assert_eq!(api.get().await, (200, edges));
    server.stop().await;
}
