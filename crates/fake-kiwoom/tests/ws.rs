use std::net::SocketAddr;
use std::process::Stdio;
use std::time::{Duration, Instant};

use fake_kiwoom::{FakeKiwoom, TOKEN, WsStats, tick_0j, token_for, trade_0b};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);

async fn connect(url: &str) -> Ws {
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

async fn frame(ws: &mut Ws, within: Duration) -> Option<Message> {
    tokio::time::timeout(within, ws.next()).await.ok().flatten().map(Result::unwrap)
}

async fn reply(ws: &mut Ws) -> Value {
    loop {
        match frame(ws, WAIT).await {
            Some(Message::Text(t)) if t.as_str() != r#"{"trnm":"PING"}"# => return serde_json::from_str(t.as_str()).unwrap(),
            Some(Message::Text(_)) => continue,
            other => panic!("응답 대신 {other:?}"),
        }
    }
}

async fn silent_for(ws: &mut Ws, span: Duration) {
    if let Some(m) = frame(ws, span).await {
        panic!("조용해야 하는데 {m:?}");
    }
}

async fn close_code(ws: &mut Ws) -> Option<(u16, String)> {
    loop {
        match tokio::time::timeout(WAIT, ws.next()).await.expect("닫히지 않았다") {
            Some(Ok(Message::Close(Some(f)))) => return Some((u16::from(f.code), f.reason.to_string())),
            Some(Ok(Message::Close(None))) | Some(Err(_)) | None => return None,
            Some(Ok(_)) => continue,
        }
    }
}

async fn login(ws: &mut Ws, token: &str) -> Value {
    send(ws, json!({"trnm": "LOGIN", "token": token})).await;
    reply(ws).await
}

async fn logged_in(fake: &FakeKiwoom) -> Ws {
    let mut ws = connect(&fake.ws_url()).await;
    assert_eq!(login(&mut ws, TOKEN).await["return_code"], 0);
    ws
}

fn reg(grp_no: &str, data: Value) -> Value {
    json!({"trnm": "REG", "grp_no": grp_no, "refresh": "1", "data": data})
}

fn remove(data: Value) -> Value {
    json!({"trnm": "REMOVE", "grp_no": "1", "data": data})
}

async fn eventually(fake: &FakeKiwoom, done: impl Fn(&WsStats) -> bool) -> WsStats {
    let started = Instant::now();
    loop {
        let stats = fake.ws_stats();
        if done(&stats) {
            return stats;
        }
        assert!(started.elapsed() < WAIT, "{stats:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn admin(fake: &FakeKiwoom, path: &str, body: Value) -> (u16, String) {
    let resp = reqwest::Client::new().post(format!("{}/_fake/{path}", fake.base_url())).header("content-type", "application/json").body(body.to_string()).send().await.unwrap();
    (resp.status().as_u16(), resp.text().await.unwrap())
}

#[tokio::test]
async fn login_accepts_issued_tokens_and_answers_8005_otherwise_without_closing() {
    let fake = FakeKiwoom::start().await;
    let mut ws = connect(&fake.ws_url()).await;
    let bad = login(&mut ws, "not-a-token").await;
    assert_eq!((bad["trnm"].as_str(), bad["return_code"].as_i64()), (Some("LOGIN"), Some(3)));
    assert!(bad["return_msg"].as_str().unwrap().contains("8005"), "{bad}");
    assert_eq!(login(&mut ws, TOKEN).await, json!({"trnm": "LOGIN", "return_code": 0, "return_msg": "", "sor_yn": "Y"}));

    let mut other = connect(&fake.ws_url()).await;
    assert_eq!(login(&mut other, &token_for("OTHER-KEY")).await["return_code"], 0);

    fake.reject_token(TOKEN);
    let mut third = connect(&fake.ws_url()).await;
    assert_eq!(login(&mut third, TOKEN).await["return_code"], 3);
    fake.reset();
    assert_eq!(login(&mut third, TOKEN).await["return_code"], 0);
}

#[tokio::test]
async fn controls_before_login_answer_100013() {
    let fake = FakeKiwoom::start().await;
    let mut ws = connect(&fake.ws_url()).await;
    send(&mut ws, reg("1", json!([{"item": ["005930_AL"], "type": ["0B"]}]))).await;
    assert_eq!(reply(&mut ws).await, json!({"trnm": "REG", "return_code": 100013, "return_msg": "로그인 전 요청입니다"}));
    send(&mut ws, remove(json!([{"item": ["005930_AL"], "type": ["0B"]}]))).await;
    assert_eq!(reply(&mut ws).await["return_code"], 100013);
    assert_eq!(fake.ws_stats().registered, Default::default());
}

#[tokio::test]
async fn ping_comes_every_interval_after_login_and_echoes_are_counted() {
    let fake = FakeKiwoom::start().await;
    fake.set_ping_every(Duration::from_millis(150));
    let mut ws = connect(&fake.ws_url()).await;
    silent_for(&mut ws, Duration::from_millis(400)).await;
    let before_login = Instant::now();
    send(&mut ws, json!({"trnm": "LOGIN", "token": TOKEN})).await;
    assert_eq!(reply(&mut ws).await["return_code"], 0);
    for n in 1..=2 {
        let ping = frame(&mut ws, WAIT).await.unwrap();
        assert_eq!(ping, Message::text(r#"{"trnm":"PING"}"#));
        assert!(before_login.elapsed() >= Duration::from_millis(150 * n), "{n}번째 PING이 {:?}에 왔다", before_login.elapsed());
        ws.send(ping).await.unwrap();
    }
    eventually(&fake, |s| s.pongs == 2).await;
}

#[tokio::test]
async fn a_new_ping_interval_reaches_a_session_already_waiting_on_the_default() {
    let fake = FakeKiwoom::start().await;
    let mut ws = logged_in(&fake).await;
    fake.set_ping_every(Duration::from_millis(100));
    assert_eq!(frame(&mut ws, Duration::from_secs(2)).await, Some(Message::text(r#"{"trnm":"PING"}"#)));
}

#[tokio::test]
async fn real_reaches_only_sessions_registered_for_that_type_and_item() {
    let fake = FakeKiwoom::start().await;
    let mut ws = logged_in(&fake).await;
    send(&mut ws, reg("1", json!([{"item": ["005930_AL", "000660_AL"], "type": ["0B"]}, {"item": ["001"], "type": ["0J"]}]))).await;
    assert_eq!(reply(&mut ws).await, json!({"trnm": "REG", "return_code": 0, "return_msg": ""}));

    let trade = trade_0b("090001", 193500, 10, 1000, "KRX");
    assert_eq!(fake.push_real("0B", "005930_AL", trade.clone()), 1);
    assert_eq!(reply(&mut ws).await, json!({"trnm": "REAL", "data": [{"type": "0B", "name": "주식체결", "item": "005930_AL", "values": trade}]}));
    assert_eq!(fake.push_real("0B", "035420_AL", trade.clone()), 0);
    assert_eq!(fake.push_real("0J", "005930_AL", trade.clone()), 0);

    let (status, body) = admin(&fake, "ws/real", json!({"type": "0J", "item": "001", "values": tick_0j("090001", 505969, 7)})).await;
    assert_eq!((status, serde_json::from_str::<Value>(&body).unwrap()), (200, json!({"delivered": 1})));
    let tick = reply(&mut ws).await;
    assert_eq!((tick["data"][0]["name"].as_str(), tick["data"][0]["values"]["10"].as_str()), (Some("업종지수"), Some("+5059.69")));

    let mut unregistered = connect(&fake.ws_url()).await;
    assert_eq!(fake.push_real("0B", "000660_AL", trade.clone()), 1, "LOGIN 전 세션에는 보내지 않는다");
    silent_for(&mut unregistered, Duration::from_millis(200)).await;
}

#[tokio::test]
async fn remove_with_mixed_types_fails_105112_and_a_single_type_stops_delivery() {
    let fake = FakeKiwoom::start().await;
    let mut ws = logged_in(&fake).await;
    send(&mut ws, reg("1", json!([{"item": ["005930_AL"], "type": ["0B"]}, {"item": ["001"], "type": ["0J"]}]))).await;
    reply(&mut ws).await;

    send(&mut ws, remove(json!([{"item": ["005930_AL"], "type": ["0B"]}, {"item": ["001"], "type": ["0J"]}]))).await;
    assert_eq!(
        reply(&mut ws).await,
        json!({"trnm": "REMOVE", "return_code": 105112, "return_msg": "실시간 항목 해지에 실패했습니다 (ERROR=서비스를 처리하는 중에 오류가 발생했습니다)"})
    );
    assert_eq!(fake.push_real("0B", "005930_AL", json!({})), 1, "실패한 REMOVE는 아무것도 지우지 않는다");
    reply(&mut ws).await;

    send(&mut ws, remove(json!([{"item": ["005930_AL"], "type": ["0B"]}]))).await;
    assert_eq!(reply(&mut ws).await, json!({"trnm": "REMOVE", "return_code": 0, "return_msg": ""}));
    assert_eq!(fake.push_real("0B", "005930_AL", json!({})), 0);
    assert_eq!(fake.push_real("0J", "001", json!({})), 1);
}

#[tokio::test]
async fn registration_stops_at_200_per_group_105118_and_per_session_105115() {
    let fake = FakeKiwoom::start().await;
    let mut ws = logged_in(&fake).await;
    let items = |range: std::ops::Range<usize>| range.map(|i| format!("{i:06}_AL")).collect::<Vec<_>>();
    send(&mut ws, reg("1", json!([{"item": items(0..199), "type": ["0B"]}, {"item": ["001"], "type": ["0J"]}]))).await;
    assert_eq!(reply(&mut ws).await["return_code"], 0);
    send(&mut ws, reg("1", json!([{"item": items(0..199), "type": ["0B"]}]))).await;
    assert_eq!(reply(&mut ws).await["return_code"], 0, "이미 등록한 쌍은 다시 세지 않는다");

    send(&mut ws, reg("1", json!([{"item": items(199..200), "type": ["0B"]}]))).await;
    let same_group = reply(&mut ws).await;
    assert_eq!(same_group["return_code"], 105118, "{same_group}");
    send(&mut ws, reg("2", json!([{"item": items(199..200), "type": ["0B"]}]))).await;
    assert_eq!(reply(&mut ws).await, json!({"trnm": "REG", "return_code": 105115, "return_msg": "등록 종목이 허용 개수(200)를 초과했습니다"}));

    let stats = fake.ws_stats();
    assert_eq!((stats.registered["0B"].len(), stats.registered["0J"].clone()), (199, vec!["001".to_owned()]));
    assert_eq!(fake.push_real("0B", "000199_AL", json!({})), 0);
}

#[tokio::test]
async fn drop_closes_every_session_with_the_given_close_frame() {
    let fake = FakeKiwoom::start().await;
    let mut a = logged_in(&fake).await;
    let mut b = connect(&fake.ws_url()).await;
    eventually(&fake, |s| s.sessions == 2).await;
    assert_eq!(admin(&fake, "ws/drop", json!({"code": 1001, "reason": "점검"})).await.0, 204);
    assert_eq!(close_code(&mut a).await, Some((1001, "점검".to_owned())));
    assert_eq!(close_code(&mut b).await, Some((1001, "점검".to_owned())));
    assert_eq!(fake.ws_stats().sessions, 0);
}

#[tokio::test]
async fn drop_with_1006_cuts_the_connection_without_a_close_frame() {
    let fake = FakeKiwoom::start().await;
    let mut ws = logged_in(&fake).await;
    fake.drop_sessions(1006, "");
    assert_eq!(close_code(&mut ws).await, None);
}

#[tokio::test]
async fn a_second_login_closes_the_older_session_with_1000_bye() {
    let fake = FakeKiwoom::start().await;
    let mut first = logged_in(&fake).await;
    send(&mut first, reg("1", json!([{"item": ["005930_AL"], "type": ["0B"]}]))).await;
    reply(&mut first).await;
    let mut second = logged_in(&fake).await;
    assert_eq!(close_code(&mut first).await, Some((1000, "Bye".to_owned())));
    let stats = eventually(&fake, |s| s.sessions == 1).await;
    assert_eq!((stats.logins, stats.registered.len()), (2, 0));
    send(&mut second, json!({"trnm": "PING"})).await;
    eventually(&fake, |s| s.pongs == 1).await;
}

#[tokio::test]
async fn mute_silences_pings_replies_and_real_until_reset() {
    let fake = FakeKiwoom::start().await;
    fake.set_ping_every(Duration::from_millis(100));
    let mut ws = logged_in(&fake).await;
    send(&mut ws, reg("1", json!([{"item": ["005930_AL"], "type": ["0B"]}]))).await;
    reply(&mut ws).await;

    assert_eq!(admin(&fake, "ws/mute", json!({"on": true})).await.0, 204);
    tokio::time::sleep(Duration::from_millis(50)).await;
    while frame(&mut ws, Duration::from_millis(10)).await.is_some() {}
    send(&mut ws, reg("1", json!([{"item": ["000660_AL"], "type": ["0B"]}]))).await;
    assert_eq!(fake.push_real("0B", "005930_AL", json!({})), 0);
    silent_for(&mut ws, Duration::from_millis(500)).await;
    assert_eq!(fake.ws_stats().sessions, 1, "소켓은 열려 있다");

    fake.mute_ws(false);
    assert_eq!(frame(&mut ws, WAIT).await, Some(Message::text(r#"{"trnm":"PING"}"#)));

    fake.mute_ws(true);
    assert_eq!(admin(&fake, "reset", json!({})).await.0, 204);
    let mut fresh = logged_in(&fake).await;
    send(&mut fresh, reg("1", json!([{"item": ["005930_AL"], "type": ["0B"]}]))).await;
    assert_eq!(reply(&mut fresh).await["return_code"], 0, "reset은 mute를 푼다");
    silent_for(&mut fresh, Duration::from_millis(500)).await;
}

#[tokio::test]
async fn ws_stats_over_http_show_controls_in_order_and_registrations_sorted() {
    let fake = FakeKiwoom::start().await;
    fake.set_ping_every(Duration::from_millis(50));
    let mut ws = connect(&fake.ws_url()).await;
    send(&mut ws, json!({"trnm": "REG", "grp_no": "1", "data": []})).await;
    reply(&mut ws).await;
    login(&mut ws, TOKEN).await;
    send(&mut ws, reg("1", json!([{"item": ["000660_AL", "005930_AL"], "type": ["0B"]}, {"item": ["101", "001"], "type": ["0J"]}]))).await;
    reply(&mut ws).await;
    send(&mut ws, remove(json!([{"item": ["000660_AL"], "type": ["0B"]}]))).await;
    reply(&mut ws).await;
    let ping = frame(&mut ws, WAIT).await.unwrap();
    ws.send(ping).await.unwrap();
    eventually(&fake, |s| s.pongs >= 1).await;

    let body: Value = serde_json::from_str(&reqwest::get(format!("{}/_fake/ws/stats", fake.base_url())).await.unwrap().text().await.unwrap()).unwrap();
    let pongs = body["pongs"].clone();
    assert_eq!(
        body,
        json!({
            "sessions": 1,
            "logins": 1,
            "pongs": pongs,
            "controls": ["REG", "LOGIN", "REG", "REMOVE"],
            "registered": {"0B": ["005930_AL"], "0J": ["001", "101"]},
        })
    );
    assert!(pongs.as_u64().unwrap() >= 1);
}

#[test]
fn field_helpers_carry_direction_and_side_in_the_sign() {
    assert_eq!(
        trade_0b("090001", 193500, 10, 1234, "KRX"),
        json!({"20": "090001", "10": "+193500", "15": "+10", "13": "1234", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2"})
    );
    let down = trade_0b("153000", -193500, -7, 5, "NXT");
    assert_eq!((down["10"].as_str(), down["15"].as_str(), down["25"].as_str(), down["9081"].as_str()), (Some("-193500"), Some("-7"), Some("5"), Some("NXT")));
    assert_eq!(tick_0j("090001", 505969, 7), json!({"20": "090001", "10": "+5059.69", "13": "7", "15": "0"}));
    assert_eq!(tick_0j("090001", -5, 7)["10"], "-0.05");
}

#[tokio::test]
async fn the_binary_serves_the_websocket() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_fake-kiwoom")).stdin(Stdio::null()).stdout(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await.unwrap().unwrap().unwrap();
    let addr: SocketAddr = line.strip_prefix("fake-kiwoom listening addr=").unwrap_or_else(|| panic!("{line}")).parse().unwrap();
    let mut ws = connect(&format!("ws://{addr}/api/dostk/websocket")).await;
    assert_eq!(login(&mut ws, TOKEN).await["return_code"], 0);
    let stats: Value = serde_json::from_str(&reqwest::get(format!("http://{addr}/_fake/ws/stats")).await.unwrap().text().await.unwrap()).unwrap();
    assert_eq!((stats["sessions"].as_u64(), stats["logins"].as_u64()), (Some(1), Some(1)));
    child.kill().await.unwrap();
}
