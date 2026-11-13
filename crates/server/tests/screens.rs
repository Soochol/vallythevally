mod common;

use std::os::unix::fs::DirBuilderExt;

use common::{ScriptedTransport, Server};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

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

    async fn run(&self, screen: &Value) -> (u16, Value) {
        reply(self.client.post(self.url.replace("/api/screens", "/api/screener/run")).header("content-type", "application/json").body(screen.to_string()).send().await.unwrap()).await
    }

    async fn put(&self, body: String) -> (u16, Value) {
        reply(self.client.put(&self.url).header("content-type", "application/json").body(body).send().await.unwrap()).await
    }
}

async fn reply(resp: reqwest::Response) -> (u16, Value) {
    let status = resp.status().as_u16();
    (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap())
}

fn new_high(period: &str, field: &str, n: u32, m: u32) -> Value {
    json!({"kind": "new_high", "period": period, "field": field, "n": n, "recentBars": m})
}

fn screen_of(id: &str, name: &str, conditions: Vec<Value>) -> Value {
    json!({"id": id, "name": name, "markets": [], "exclude": [], "conditions": conditions})
}

fn screen(id: &str, name: &str) -> Value {
    screen_of(id, name, vec![new_high("D", "high", 200, 1)])
}

fn screens(list: Vec<Value>, revision: i64) -> Value {
    json!({"screens": list, "revision": revision})
}

fn every_kind() -> Value {
    json!(["etf", "preferred", "reit", "spac", "managed", "investment_caution_alert", "investment_warning",
           "investment_danger", "investment_caution", "short_term_overheated", "trading_halted"])
}

fn example(kind: &str) -> Value {
    match kind {
        "new_high" => new_high("D", "high", 200, 1),
        "new_low" => json!({"kind": "new_low", "period": "W", "recentBars": 2, "field": "traded_value", "n": 52}),
        "value_range" => json!({"kind": "value_range", "period": "D", "recentBars": 1, "field": "traded_value", "min": 10_000_000_000.0, "max": null}),
        "change" => json!({"kind": "change", "period": "D", "recentBars": 1, "back": 20, "minPct": 30.0, "maxPct": null}),
        "near_extreme" => json!({"kind": "near_extreme", "period": "D", "recentBars": 1, "extreme": "high", "n": 200, "withinPct": 5.0}),
        "surge" => json!({"kind": "surge", "period": "D", "recentBars": 1, "field": "volume", "n": 20, "times": 3.0}),
        "ma_position" => json!({"kind": "ma_position", "period": "D", "recentBars": 1, "field": "close", "method": "sma", "length": 20, "side": "above"}),
        "ma_alignment" => json!({"kind": "ma_alignment", "period": "D", "recentBars": 1, "method": "ema", "lengths": [5, 20, 60, 120], "order": "bullish"}),
        "ma_cross" => json!({"kind": "ma_cross", "period": "D", "recentBars": 5, "method": "sma", "fast": 5, "slow": 20, "direction": "up"}),
        "rsi" => json!({"kind": "rsi", "period": "D", "recentBars": 3, "length": 14, "test": {"kind": "breakout", "value": 30.0, "direction": "up"}}),
        "macd" => json!({"kind": "macd", "period": "D", "recentBars": 1, "fast": 12, "slow": 26, "signal": 9, "test": {"kind": "signal_cross", "direction": "up"}}),
        "stochastic" => json!({"kind": "stochastic", "period": "D", "recentBars": 1, "k": 5, "d": 3, "smooth": 3, "test": {"kind": "range", "min": null, "max": 20.0}}),
        "bollinger" => json!({"kind": "bollinger", "period": "D", "recentBars": 1, "length": 20, "k": 2.0, "test": {"kind": "outside", "side": "above"}}),
        "ichimoku" => json!({"kind": "ichimoku", "period": "D", "recentBars": 1, "conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cloud", "side": "above"}}),
        "market_cap" => json!({"kind": "market_cap", "min": 300_000_000_000.0, "max": null}),
        other => panic!("모르는 조건 종류 {other}"),
    }
}

fn with(mut condition: Value, key: &str, value: Value) -> Value {
    condition[key] = value;
    condition
}

const KINDS: [&str; 15] = [
    "new_high", "new_low", "value_range", "change", "near_extreme", "surge", "ma_position", "ma_alignment", "ma_cross",
    "rsi", "macd", "stochastic", "bollinger", "ichimoku", "market_cap",
];

fn every_condition() -> Vec<Value> {
    let mut all: Vec<Value> = KINDS.iter().map(|k| example(k)).collect();
    all.extend([
        with(example("ma_cross"), "fast", Value::Null),
        with(example("rsi"), "test", json!({"kind": "range", "min": null, "max": 30.0})),
        with(example("macd"), "test", json!({"kind": "zero_breakout", "direction": "down"})),
        with(example("macd"), "test", json!({"kind": "vs_signal", "side": "below"})),
        with(example("stochastic"), "test", json!({"kind": "cross", "direction": "down"})),
        with(example("bollinger"), "test", json!({"kind": "cross", "band": "lower", "direction": "up"})),
        with(example("ichimoku"), "test", json!({"kind": "cross", "direction": "up"})),
    ]);
    all
}

#[tokio::test]
async fn screens_start_empty_are_replaced_whole_and_survive_a_restart() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let lock = tmp.path().join("run/server.lock");
    let server = Server::spawn(&fake, &lock, tmp.path());
    let api = ScreensApi::of(&server).await;
    assert_eq!(api.get().await, (200, json!({"screens": [], "revision": 0})));

    let two = screens(vec![
        json!({"id": "0193aaaa-0000-7000-8000-000000000001", "name": "고가 200일 신고가", "markets": ["kosdaq", "kospi"], "exclude": every_kind(),
               "conditions": [new_high("D", "high", 200, 5), example("market_cap"), new_high("W", "volume", 60, 60)]}),
        json!({"id": "S2", "name": "월봉 종가", "markets": [], "exclude": ["spac", "etf"], "conditions": [new_high("M", "close", 12, 1)]}),
    ], 1_794_152_040_001);
    assert_eq!(api.put(two.to_string()).await, (200, two.clone()));
    assert_eq!(api.get().await, (200, two), "조건식 순서, 시장 순서, 제외 순서, 조건 순서와 줄마다 봉 주기를 그대로 돌려준다");

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

#[tokio::test]
async fn every_condition_kind_and_test_is_saved_as_sent() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), tmp.path());
    let api = ScreensApi::of(&server).await;
    let list: Vec<Value> = every_condition().into_iter().enumerate().map(|(i, c)| screen_of(&format!("S{i}"), &format!("조건식 {i}"), vec![c])).collect();
    let all = screens(list, 1);
    assert_eq!(api.put(all.to_string()).await, (200, all.clone()));
    assert_eq!(api.get().await, (200, all), "종류마다, test마다 값을 그대로 돌려준다");
    for condition in every_condition() {
        let (status, body) = api.run(&screen_of("R", "실행", vec![condition.clone()])).await;
        assert_ne!(status, 400, "저장되는 조건은 실행 검사도 통과한다: {condition} → {body}");
    }

    let edges = screens(vec![screen_of("E", "경계값", vec![
        with(example("change"), "minPct", json!(-99.5)),
        with(with(example("value_range"), "min", json!(0.0)), "max", json!(0.0)),
        with(example("near_extreme"), "withinPct", json!(100.0)),
        with(with(example("near_extreme"), "withinPct", json!(0.0)), "recentBars", json!(301)),
        with(example("rsi"), "test", json!({"kind": "range", "min": 0.0, "max": 100.0})),
        with(example("rsi"), "test", json!({"kind": "breakout", "value": 100.0, "direction": "down"})),
        with(example("stochastic"), "test", json!({"kind": "range", "min": 0.0, "max": null})),
        with(example("ma_alignment"), "lengths", json!([65_531, 65_532, 65_533, 65_534, 65_535])),
        with(with(example("macd"), "fast", json!(65_534)), "slow", json!(65_535)),
        with(with(example("new_low"), "recentBars", json!(52)), "n", json!(52)),
    ])], 2);
    assert_eq!(api.put(edges.to_string()).await, (200, edges.clone()), "규칙이 허락하는 끝 값은 받는다");
    assert_eq!(api.get().await, (200, edges));
    server.stop().await;
}

#[tokio::test]
async fn each_screen_rule_and_a_stale_revision_rejects_the_save() {
    let fake = ScriptedTransport::new();
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
    let line = |condition: Value| edit(&|s| s["conditions"][0] = condition.clone());
    let changed = |kind: &str, key: &str, value: Value| line(with(example(kind), key, value));
    let tested = |kind: &str, test: Value| changed(kind, "test", test);
    let condition = |n: Value, end: Value| line(json!({"kind": "new_high", "period": "D", "field": "high", "n": n, "recentBars": end}));
    let many = |count: usize| screens((0..count).map(|i| screen(&format!("S{i}"), &format!("조건식 {i}"))).collect(), 11).to_string();
    let mut cases = vec![
        ("조건식 51개", many(51), 400, "bad_request"),
        ("겹친 id", screens(vec![screen("S1", "가"), screen("S1", "나")], 11).to_string(), 400, "bad_request"),
        ("빈 id", edit(&|s| s["id"] = json!("")), 400, "bad_request"),
        ("65바이트 id", edit(&|s| s["id"] = json!("x".repeat(65))), 400, "bad_request"),
        ("빈 이름", edit(&|s| s["name"] = json!("")), 400, "bad_request"),
        ("공백뿐인 이름", edit(&|s| s["name"] = json!(" \t\u{3000} ")), 400, "bad_request"),
        ("41자 이름", edit(&|s| s["name"] = json!("가".repeat(41))), 400, "bad_request"),
        ("조건 0줄에 빈 이름", edit(&|s| *s = json!({"id": "S1", "name": " ", "markets": [], "exclude": [], "conditions": []})), 400, "bad_request"),
        ("조건 11줄", edit(&|s| s["conditions"] = json!(vec![new_high("D", "high", 2, 1); 11])), 400, "bad_request"),
        ("음수 끝", condition(json!(5), json!(-1)), 400, "bad_request"),
        ("역순 범위", changed("new_high", "barRange", json!({"start": 6, "end": 5})), 400, "bad_request"),
        ("n = 0", condition(json!(0), json!(1)), 400, "bad_request"),
        ("정수가 아닌 m", condition(json!(5), json!(1.5)), 400, "bad_request"),
        ("정수가 아닌 n", condition(json!(5.5), json!(1)), 400, "bad_request"),
        ("음수 n", condition(json!(-5), json!(1)), 400, "bad_request"),
        ("u32를 넘는 m", condition(json!(u32::MAX), json!(u64::from(u32::MAX) + 2)), 400, "bad_request"),
        ("겹친 제외", edit(&|s| s["exclude"] = json!(["etf", "spac", "etf"])), 400, "bad_request"),
        ("겹친 상태 제외", edit(&|s| s["exclude"] = json!(["trading_halted", "managed", "trading_halted"])), 400, "bad_request"),
        ("모르는 제외", edit(&|s| s["exclude"] = json!(["etn"])), 400, "bad_request"),
        ("겹친 시장", edit(&|s| s["markets"] = json!(["kosdaq", "kospi", "kosdaq"])), 400, "bad_request"),
        ("모르는 시장", edit(&|s| s["markets"] = json!(["konex"])), 400, "bad_request"),
        ("시장 목록 없음", edit(&|s| s["markets"] = Value::Null), 400, "bad_request"),
        ("조건식의 봉 주기만 있는 옛 형식", edit(&|s| *s = json!({"id": "S1", "name": "기본", "period": "D", "exclude": [], "conditions": [{"field": "high", "n": 200, "recentBars": 1}]})), 400, "bad_request"),
        ("종류 없는 조건", line(json!({"period": "D", "field": "high", "n": 200, "recentBars": 1})), 400, "bad_request"),
        ("모르는 종류", changed("new_high", "kind", json!("new_peak")), 400, "bad_request"),
        ("줄의 봉 주기가 null", changed("new_high", "period", Value::Null), 400, "bad_request"),
        ("모르는 봉 주기", changed("new_high", "period", json!("5m")), 400, "bad_request"),
        ("모르는 값", changed("new_high", "field", json!("amount")), 400, "bad_request"),
        ("신저가 역순 범위", changed("new_low", "barRange", json!({"start": 53, "end": 52})), 400, "bad_request"),
        ("값 범위의 min > max", changed("value_range", "max", json!(9_999_999_999.0)), 400, "bad_request"),
        ("값 범위의 max 키 없음", line(json!({"kind": "value_range", "period": "D", "recentBars": 1, "field": "close", "min": 1.0})), 400, "bad_request"),
        ("유한하지 않은 수", changed("value_range", "max", json!(12_345.25)).replace("12345.25", "1e999"), 400, "bad_request"),
        ("모르는 극값", changed("near_extreme", "extreme", json!("close")), 400, "bad_request"),
        ("거래 급증의 가격 값", changed("surge", "field", json!("close")), 400, "bad_request"),
        ("이평 위치의 거래량 값", changed("ma_position", "field", json!("volume")), 400, "bad_request"),
        ("모르는 이평 방법", changed("ma_position", "method", json!("wma")), 400, "bad_request"),
        ("모르는 위치", changed("ma_position", "side", json!("on")), 400, "bad_request"),
        ("모르는 배열", changed("ma_alignment", "order", json!("flat")), 400, "bad_request"),
        ("모르는 교차 방향", changed("ma_cross", "direction", json!("sideways")), 400, "bad_request"),
        ("모르는 RSI test", tested("rsi", json!({"kind": "cross", "direction": "up"})), 400, "bad_request"),
        ("모르는 MACD test", tested("macd", json!({"kind": "range", "min": 0.0, "max": null})), 400, "bad_request"),
        ("모르는 볼린저 밴드", tested("bollinger", json!({"kind": "cross", "band": "middle", "direction": "up"})), 400, "bad_request"),
        ("모르는 일목 test", tested("ichimoku", json!({"kind": "outside", "side": "above"})), 400, "bad_request"),
        ("revision 없음", json!({"screens": [screen("S1", "기본")]}).to_string(), 400, "bad_request"),
        ("128KB를 넘는 본문", json!({"screens": [screen("S1", "기본")], "revision": 11, "pad": "x".repeat(128 * 1024)}).to_string(), 413, "payload_too_large"),
        ("같은 revision", screens(vec![screen("S9", "새")], 10).to_string(), 409, "stale_revision"),
        ("옛 revision", screens(vec![screen("S9", "새")], 9).to_string(), 409, "stale_revision"),
    ];
    let bar_kinds = KINDS.iter().filter(|k| **k != "market_cap");
    let periods_and_m: Vec<_> = bar_kinds.flat_map(|k| [(k, "recentBars", json!(0)), (k, "period", json!("Y"))]).map(|(k, key, v)| ("봉 조건의 m = 0이나 모르는 봉 주기", changed(k, key, v), 400, "bad_request")).collect();
    let indicator_lengths = [
        ("ma_position", "length"), ("ma_cross", "slow"), ("ma_cross", "fast"), ("rsi", "length"), ("macd", "fast"), ("macd", "slow"), ("macd", "signal"),
        ("stochastic", "k"), ("stochastic", "d"), ("stochastic", "smooth"), ("bollinger", "length"),
        ("ichimoku", "conversion"), ("ichimoku", "base"), ("ichimoku", "spanB"), ("ichimoku", "displacement"),
    ];
    let lengths: Vec<_> = indicator_lengths.iter().flat_map(|&(k, key)| [json!(65_536), json!(14.5)].map(|v| ("지표 기간이 1~65,535 정수가 아님", changed(k, key, v), 400, "bad_request"))).collect();
    cases.extend(periods_and_m);
    cases.extend(lengths);
    for (case, body, status, code) in cases {
        let (s, v) = api.put(body.clone()).await;
        assert_eq!((s, v["error"]["code"].as_str().unwrap_or("")), (status, code), "{case}: {body} → {v}");
        assert!(!v["error"]["message"].as_str().unwrap_or("").is_empty(), "{case}: {v}");
    }
    let zero_n = screen_of("S1", "기본", vec![new_high("D", "high", 0, 1)]);
    let message = "조건식 기본의 1번째 조건: n는 1 이상이어야 합니다";
    let (saving, running) = (api.put(screens(vec![zero_n.clone()], 11).to_string()).await, api.run(&zero_n).await);
    assert_eq!((saving.0, saving.1["error"]["message"].as_str()), (400, Some(message)), "저장의 문구");
    assert_eq!((running.0, running.1["error"]["message"].as_str(), running.1["error"]["code"].as_str()), (400, Some(message), Some("bad_request")), "실행도 같은 문구");
    assert_eq!(api.get().await, (200, saved), "거절한 PUT은 저장하지 않는다");
    server.stop().await;
}

fn widest_conditions() -> Vec<Value> {
    let (m, n, len) = (u32::MAX, json!(u32::MAX), json!(65_535));
    let huge = json!(-1.797_693_134_862_315_7e308);
    let percent = json!(99.999_999_999_999_99);
    vec![
        json!({"kind": "ichimoku", "period": "W", "recentBars": m, "conversion": len, "base": len, "spanB": len, "displacement": len, "test": {"kind": "cloud", "side": "above"}}),
        json!({"kind": "stochastic", "period": "W", "recentBars": m, "k": len, "d": len, "smooth": len, "test": {"kind": "range", "min": 0.000_000_000_000_000_1, "max": percent}}),
        json!({"kind": "bollinger", "period": "W", "recentBars": m, "length": len, "k": 1.797_693_134_862_315_7e308, "test": {"kind": "cross", "band": "upper", "direction": "down"}}),
        json!({"kind": "ma_alignment", "period": "W", "recentBars": m, "method": "sma", "lengths": [65_531, 65_532, 65_533, 65_534, 65_535], "order": "bullish"}),
        json!({"kind": "value_range", "period": "W", "recentBars": m, "field": "traded_value", "min": 1.797_693_134_862_315e308, "max": 1.797_693_134_862_315_7e308}),
        json!({"kind": "change", "period": "W", "recentBars": m, "back": n, "minPct": huge, "maxPct": 1.797_693_134_862_315_7e308}),
        json!({"kind": "macd", "period": "W", "recentBars": m, "fast": 65_534, "slow": len, "signal": len, "test": {"kind": "signal_cross", "direction": "down"}}),
        json!({"kind": "rsi", "period": "W", "recentBars": m, "length": len, "test": {"kind": "range", "min": 0.000_000_000_000_000_1, "max": percent}}),
        json!({"kind": "ma_cross", "period": "W", "recentBars": m, "method": "ema", "fast": 65_534, "slow": len, "direction": "down"}),
        json!({"kind": "near_extreme", "period": "W", "recentBars": m, "extreme": "high", "n": n, "withinPct": percent}),
    ]
}

#[tokio::test]
async fn fifty_screens_of_ten_of_the_widest_conditions_are_saved() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), tmp.path());
    let api = ScreensApi::of(&server).await;
    let widest = |i: usize| {
        json!({"id": format!("{i:0>64}"), "name": format!(" {} ", "𝄞".repeat(40)), "markets": ["kospi", "kosdaq"], "exclude": every_kind(), "conditions": widest_conditions()})
    };
    let edges = screens((0..50).map(widest).collect(), 11);
    assert_eq!(api.put(edges.to_string()).await, (200, edges.clone()), "규칙마다 가장 끝 값을 모두 채운 조건식 50개도 받는다");
    assert_eq!(api.get().await, (200, edges));
    server.stop().await;
}

async fn saved_before_condition_kinds(tmp: &tempfile::TempDir, list: &Value, revision: i64) -> std::path::PathBuf {
    let run = tmp.path().join("run");
    std::fs::DirBuilder::new().mode(0o700).create(&run).unwrap();
    let pool = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(run.join("vally.db")).create_if_missing(true)).await.unwrap();
    sqlx::migrate!("./migrations").run_to(5, &pool).await.unwrap();
    sqlx::query("UPDATE screens SET list = ?, revision = ?").bind(list.to_string()).bind(revision).execute(&pool).await.unwrap();
    pool.close().await;
    run.join("server.lock")
}

fn old_new_high(id: &str) -> Value {
    json!({"name": "신고가", "period": "D", "conditions": [{"field": "high", "n": 200, "m": 1}], "exclude": [], "id": id})
}

#[tokio::test]
async fn a_list_saved_in_the_old_format_comes_back_in_the_new_format_with_the_revision_raised() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let old = json!([
        old_new_high("01900000-0000-7000-8000-0000000000a1"),
        {"id": "S2", "name": "주봉 둘", "period": "W", "exclude": ["etf", "trading_halted"], "conditions": [{"field": "close", "n": 52, "m": 4}, {"field": "volume", "n": 26, "m": 1}]},
    ]);
    let lock = saved_before_condition_kinds(&tmp, &old, 1_794_222_949_877).await;
    let server = Server::spawn(&fake, &lock, tmp.path());
    let api = ScreensApi::of(&server).await;
    let migrated = screens(vec![
        json!({"id": "01900000-0000-7000-8000-0000000000a1", "name": "신고가", "markets": [], "exclude": [], "conditions": [new_high("D", "high", 200, 1)]}),
        json!({"id": "S2", "name": "주봉 둘", "markets": [], "exclude": ["etf", "trading_halted"], "conditions": [new_high("W", "close", 52, 4), new_high("W", "volume", 26, 1)]}),
    ], 1_794_222_949_880);
    assert_eq!(api.get().await, (200, migrated.clone()), "봉 주기는 줄마다 옮기고, 줄은 신고가 종류가 되고, 시장은 빈 목록이며, revision은 1 오른다");

    let late = screens(vec![screen("S9", "옛 탭")], 1_794_222_949_880);
    assert_eq!(api.put(late.to_string()).await.1["error"]["code"], json!("stale_revision"), "옮기기 전 revision 다음 번호로 보낸 저장은 막힌다");
    assert_eq!(api.get().await, (200, migrated));
    server.stop().await;

    let server = Server::spawn(&fake, &lock, tmp.path());
    assert_eq!(ScreensApi::of(&server).await.get().await.1["revision"], json!(1_794_222_949_880_i64), "다시 켜도 한 번만 옮긴다");
    server.stop().await;
}

#[tokio::test]
async fn a_list_saved_at_the_largest_revision_is_moved_and_keeps_that_revision() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let lock = saved_before_condition_kinds(&tmp, &json!([old_new_high("S1")]), i64::MAX).await;
    let server = Server::spawn(&fake, &lock, tmp.path());
    let api = ScreensApi::of(&server).await;
    let migrated = screens(vec![json!({"id": "S1", "name": "신고가", "markets": [], "exclude": [], "conditions": [new_high("D", "high", 200, 1)]})], i64::MAX);
    assert_eq!(api.get().await, (200, migrated.clone()), "revision이 i64 최댓값이면 올리지 않고 서버가 켜진다");
    assert_eq!(api.put(screens(vec![screen("S9", "덮어쓰기")], i64::MAX).to_string()).await.1["error"]["code"], json!("stale_revision"), "그 뒤의 저장도 덮어쓰지 못한다");
    assert_eq!(api.get().await, (200, migrated));
    server.stop().await;
}

#[tokio::test]
async fn old_migrates_every_saved_kind_once_preserving_order_values_and_revision_protection() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let run = tmp.path().join("run");
    std::fs::DirBuilder::new().mode(0o700).create(&run).unwrap();
    let mut expected_lines = every_condition();
    for (index, condition) in expected_lines.iter_mut().enumerate() {
        if condition["kind"] != "market_cap" {
            condition["recentBars"] = json!(index + 3);
        }
    }
    let mut list: Vec<Value> = expected_lines.chunks(10).enumerate().map(|(i, lines)| json!({"id": format!("S{i}"), "name": format!("모든 조건 보존 {i}"), "markets": ["kosdaq", "kospi"], "exclude": ["etf", "managed"], "conditions": lines})).collect();
    list.push(screen_of("empty", "빈 조건", vec![]));
    let expected = screens(list, 79);
    let mut old = expected["screens"].clone();
    for condition in old.as_array_mut().unwrap().iter_mut().flat_map(|screen| screen["conditions"].as_array_mut().unwrap()) {
        if condition["kind"] != "market_cap" {
            let count = condition["recentBars"].as_u64().unwrap();
            let object = condition.as_object_mut().unwrap();
            object.remove("recentBars");
            object.insert("m".into(), json!(count));
        }
    }
    let pool = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(run.join("vally.db")).create_if_missing(true)).await.unwrap();
    sqlx::migrate!("./migrations").run_to(6, &pool).await.unwrap();
    sqlx::query("UPDATE screens SET list = ?, revision = 77").bind(old.to_string()).execute(&pool).await.unwrap();
    pool.close().await;
    let lock = run.join("server.lock");
    let server = Server::spawn(&fake, &lock, tmp.path());
    let api = ScreensApi::of(&server).await;
    assert_eq!(api.get().await, (200, expected.clone()));
    assert_eq!(api.put(expected.to_string()).await.1["error"]["code"], "stale_revision");
    assert_eq!(api.put(screens(old.as_array().unwrap().clone(), 80).to_string()).await.0, 400, "옛 M 본문은 다시 저장할 수 없다");
    let mut edited = expected.clone();
    edited["revision"] = json!(80);
    edited["screens"][0]["conditions"][0]["recentBars"] = json!(9);
    assert_eq!(api.put(edited.to_string()).await, (200, edited.clone()));
    server.stop().await;
    let server = Server::spawn(&fake, &lock, tmp.path());
    assert_eq!(ScreensApi::of(&server).await.get().await, (200, edited), "재시작해도 범위와 revision은 다시 변환되지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn recent_period_accepts_the_old_end_plus_one_boundary_and_rejects_old_api_shapes() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let server = Server::spawn(&fake, &tmp.path().join("run/server.lock"), tmp.path());
    let api = ScreensApi::of(&server).await;
    let mut revision = 1;
    for kind in KINDS.into_iter().filter(|k| *k != "market_cap") {
        let mut condition = example(kind);
        for count in [1_u64, 100, 260, 4_294_967_296] {
            condition["recentBars"] = json!(count);
            let sent = screens(vec![screen_of("S1", "최근 기간", vec![condition.clone()])], revision);
            assert_eq!(api.put(sent.to_string()).await, (200, sent), "{kind} {count}");
            revision += 1;
        }
        for count in [Value::Null, json!(0), json!(-1), json!(1.5), json!(4_294_967_297_u64)] {
            condition["recentBars"] = count.clone();
            let sent = screens(vec![screen_of("S1", "최근 기간", vec![condition.clone()])], revision);
            assert_eq!(api.put(sent.to_string()).await.0, 400, "{kind} {count}");
        }
        condition.as_object_mut().unwrap().remove("recentBars");
        for old in [json!({"barRange": {"start": 10, "end": 19}}), json!({"m": 20}), json!({})] {
            let mut legacy = condition.clone();
            legacy.as_object_mut().unwrap().extend(old.as_object().unwrap().clone());
            assert_eq!(api.put(screens(vec![screen_of("S1", "옛 본문", vec![legacy])], revision).to_string()).await.0, 400);
        }
    }
    server.stop().await;
}

#[tokio::test]
async fn saved_ranges_become_recent_periods_once_including_nonzero_starts_and_the_largest_end() {
    let fake = ScriptedTransport::new();
    let tmp = tempfile::tempdir().unwrap();
    let run = tmp.path().join("run");
    std::fs::DirBuilder::new().mode(0o700).create(&run).unwrap();
    let mut old = Vec::new();
    let mut expected = Vec::new();
    for (index, kind) in KINDS.into_iter().enumerate() {
        let mut line = example(kind);
        if kind != "market_cap" {
            line.as_object_mut().unwrap().remove("recentBars");
            let range = match index % 3 { 0 => json!({"start": 0, "end": 259}), 1 => json!({"start": 10, "end": 19}), _ => json!({"start": 300, "end": u32::MAX}) };
            let count = match index % 3 { 0 => 260_u64, 1 => 20, _ => 4_294_967_296 };
            line["barRange"] = range;
            let mut converted = line.clone();
            converted.as_object_mut().unwrap().remove("barRange");
            converted["recentBars"] = json!(count);
            expected.push(converted);
        } else {
            expected.push(line.clone());
        }
        old.push(line);
    }
    let list = |lines: Vec<Value>| lines.chunks(10).enumerate().map(|(i, lines)| json!({"id": format!("S{i}"), "name": format!("보존 {i}"), "markets": ["kosdaq", "kospi"], "exclude": ["etf"], "conditions": lines})).collect::<Vec<_>>();
    let pool = SqlitePoolOptions::new().connect_with(SqliteConnectOptions::new().filename(run.join("vally.db")).create_if_missing(true)).await.unwrap();
    sqlx::migrate!("./migrations").run_to(7, &pool).await.unwrap();
    sqlx::query("UPDATE screens SET list = ?, revision = 77").bind(json!(list(old)).to_string()).execute(&pool).await.unwrap();
    pool.close().await;
    let server = Server::spawn(&fake, &run.join("server.lock"), tmp.path());
    let api = ScreensApi::of(&server).await;
    let expected = screens(list(expected), 78);
    assert_eq!(api.get().await, (200, expected.clone()));
    assert_eq!(api.put(expected.to_string()).await.0, 409);
    let mut edited = expected.clone();
    edited["revision"] = json!(79);
    assert_eq!(api.put(edited.to_string()).await, (200, edited.clone()));
    server.stop().await;
    let server = Server::spawn(&fake, &run.join("server.lock"), tmp.path());
    assert_eq!(ScreensApi::of(&server).await.get().await, (200, edited));
    server.stop().await;
}
