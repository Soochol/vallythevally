use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use server::kiwoom::error::Category;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use super::session::{Finish, Halt, Timings, WallClock};
use super::start::exit_status;
use super::testing::*;
use crate::raw_read::{RawContent, RawItem, read_day};

const REAL_FRAME: &str = r#"{"trnm":"REAL",  "data":[{"type":"0D","item":"005930_AL","name":"주문호가","values":{"21":"090001","41":"-71000"}}]}"#;

fn timings() -> Timings {
    Timings::default()
}

async fn running_session(peer: &Peer) -> (Paths, Arc<FakeKiwoom>, Running) {
    let paths = Paths::new();
    let kiwoom = FakeKiwoom::issuing_tokens();
    let running = launch(&paths, peer, &kiwoom, timings());
    until("REG를 보냈다", || peer.count_sent("REG") >= 1).await;
    settle().await;
    (paths, kiwoom, running)
}

fn halted(finish: Result<Finish, server::instance::LockError>) -> Halt {
    match finish.expect("잠금을 잡았다") {
        Finish::Halted(halt) => halt,
        Finish::Shutdown => panic!("멈춰야 하는데 정상 종료했다"),
    }
}

#[tokio::test(start_paused = true)]
async fn first_connection_logs_in_with_the_token_and_registers_every_item_as_al() {
    let peer = Peer::accepting();
    let (_paths, kiwoom, running) = running_session(&peer).await;
    let texts = peer.texts(0);
    assert!(texts[0].contains(TOKEN_ONE), "{}", texts[0]);
    assert_eq!(serde_json::from_str::<Value>(&texts[0]).unwrap(), json!({"trnm": "LOGIN", "token": TOKEN_ONE}));
    assert_eq!(
        serde_json::from_str::<Value>(&texts[1]).unwrap(),
        json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [{"item": ["005930_AL", "000660_AL"], "type": ["0B", "0D", "0w", "0F"]}]})
    );
    assert_eq!(peer.trnms(0), ["LOGIN", "REG"]);
    assert_eq!(kiwoom.issue_count(), 1);
    assert!(matches!(running.stop().await, Finish::Shutdown));
}

#[tokio::test(start_paused = true)]
async fn real_frames_are_stored_verbatim_and_ping_is_echoed_but_not_stored() {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let received_at = running.wall.now_ms();
    peer.text(0, REAL_FRAME);
    peer.text(0, r#"{"trnm":"PING"}"#);
    peer.text(0, "이건 JSON이 아니다");
    settle().await;
    let date = running.wall.date();
    running.stop().await;

    let source = raw_source(&paths.data(), date);
    assert!(source.contains(&format!("{{\"recv_ms\":{received_at},\"msg\":{REAL_FRAME}}}")), "{source}");
    assert!(!source.contains("PING"), "{source}");
    assert_eq!(peer.sent_at(0, "PING").len(), 1);
    assert_eq!(peer.texts(0).last().unwrap(), r#"{"trnm":"PING"}"#);
    let lines = raw_lines(&paths.data(), date);
    assert!(lines.iter().any(|line| line["recv_ms"] == received_at && line["text"] == "이건 JSON이 아니다"));
    let acked: Vec<&str> = lines.iter().filter_map(|line| line["msg"]["trnm"].as_str()).collect();
    assert_eq!(acked, ["LOGIN", "REG", "REAL"]);
}

#[tokio::test(start_paused = true)]
async fn nothing_secret_reaches_the_raw_files() {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    peer.text(0, REAL_FRAME);
    settle().await;
    let date = running.wall.date();
    running.stop().await;
    let source = raw_source(&paths.data(), date);
    for secret in [APP_KEY, APP_SECRET, TOKEN_ONE] {
        assert!(!source.contains(secret), "{secret}");
    }
}

#[tokio::test(start_paused = true)]
async fn the_live_event_follows_the_reg_response() {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    let date = running.wall.date();
    running.stop().await;
    let lines = raw_lines(&paths.data(), date);
    let position = |predicate: &dyn Fn(&Value) -> bool| lines.iter().position(predicate).unwrap();
    let reg_ack = position(&|line| line["msg"]["trnm"] == "REG");
    let live = position(&|line| line["event"] == "live");
    assert_eq!(live, reg_ack + 1);
}

fn close_frame() -> Message {
    Message::Close(Some(CloseFrame { code: 1000.into(), reason: "Bye".into() }))
}

async fn goes_down_and_comes_back(cut: impl FnOnce(&Peer), reason_part: &str) {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    cut(&peer);
    until("다시 REG를 보냈다", || peer.count_sent("REG") >= 2).await;
    settle().await;
    let date = running.wall.date();
    running.stop().await;
    let recorded = events(&raw_lines(&paths.data(), date));
    assert_eq!(recorded.len(), 4, "{recorded:?}");
    assert_eq!(recorded[0], ("live".to_owned(), None));
    let (event, reason) = &recorded[1];
    assert_eq!(event, "down");
    assert!(reason.as_deref().unwrap().contains(reason_part), "{reason:?}");
    assert_eq!(recorded[2], ("live".to_owned(), None));
    assert_eq!(recorded[3], ("down".to_owned(), Some("종료".to_owned())));
}

#[tokio::test(start_paused = true)]
async fn a_closed_connection_is_down_then_live_again() {
    goes_down_and_comes_back(|peer| peer.push(0, Ok(close_frame())), "닫았습니다").await;
}

#[tokio::test(start_paused = true)]
async fn a_transport_error_is_down_then_live_again() {
    goes_down_and_comes_back(|peer| peer.push(0, Err(WsError::Io(std::io::Error::other("reset")))), "전송 오류").await;
}

#[tokio::test(start_paused = true)]
async fn thirty_seconds_of_silence_is_down_then_live_again() {
    goes_down_and_comes_back(|_| {}, "아무 메시지도").await;
}

#[tokio::test(start_paused = true)]
async fn a_missing_reg_response_is_down_and_connects_again() {
    let peer = Peer::new(|connection, trnm, _| if connection == 0 && trnm == "REG" { Reply::Silent } else { Reply::Ack });
    let paths = Paths::new();
    let running = launch(&paths, &peer, &FakeKiwoom::issuing_tokens(), timings());
    until("둘째 연결의 REG", || peer.count_sent("REG") >= 2).await;
    settle().await;
    let date = running.wall.date();
    running.stop().await;
    let recorded = events(&raw_lines(&paths.data(), date));
    assert_eq!(recorded[0].0, "down");
    assert!(recorded[0].1.as_deref().unwrap().contains("REG 응답이 시간 안에 오지 않았습니다"));
    assert_eq!(recorded[1].0, "live");
}

#[tokio::test(start_paused = true)]
async fn reconnect_waits_grow_and_reset_after_a_stable_connection_and_reg_is_sent_every_time() {
    let peer = Peer::new(|connection, trnm, _| if connection < 6 && trnm == "REG" { Reply::AckThenClose } else { Reply::Ack });
    let paths = Paths::new();
    let running = launch(&paths, &peer, &FakeKiwoom::issuing_tokens(), timings());
    until("일곱째 연결", || peer.connect_count() == 7).await;
    settle().await;
    let waits: Vec<Duration> = peer.connect_times().windows(2).map(|pair| pair[1] - pair[0]).collect();
    assert_eq!(waits, [1, 2, 5, 10, 30, 30].map(Duration::from_secs));

    for _ in 0..7 {
        tokio::time::sleep(Duration::from_secs(10)).await;
        peer.text(6, r#"{"trnm":"PING"}"#);
        settle().await;
    }
    let closed_at = tokio::time::Instant::now();
    peer.close(6);
    until("여덟째 연결", || peer.connect_count() == 8).await;
    settle().await;
    assert_eq!(peer.connect_times()[7] - closed_at, Duration::from_secs(1));
    assert_eq!(peer.count_sent("REG"), 8);
    assert_eq!(peer.count_sent("LOGIN"), 8);
    running.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_usable_saved_token_means_no_token_request() {
    let paths = Paths::new();
    let first = FakeKiwoom::issuing_tokens();
    let first_peer = Peer::accepting();
    let running = launch(&paths, &first_peer, &first, timings());
    until("첫 실행의 REG", || first_peer.count_sent("REG") == 1).await;
    running.stop().await;
    assert_eq!(first.issue_count(), 1);

    let second = FakeKiwoom::issuing_tokens();
    let second_peer = Peer::accepting();
    let running = launch(&paths, &second_peer, &second, timings());
    until("둘째 실행의 REG", || second_peer.count_sent("REG") == 1).await;
    settle().await;
    assert_eq!(second.issue_count(), 0);
    assert!(second_peer.texts(0)[0].contains(TOKEN_ONE));
    running.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_token_the_server_calls_invalid_is_reissued_once_after_the_issue_interval() {
    let peer = Peer::new(|connection, trnm, _| if trnm == "LOGIN" && connection == 0 { Reply::Code(8005) } else { Reply::Ack });
    let paths = Paths::new();
    let kiwoom = FakeKiwoom::issuing_tokens();
    let running = launch(&paths, &peer, &kiwoom, timings());
    until("둘째 연결의 REG", || peer.count_sent("REG") == 1).await;
    settle().await;
    assert_eq!(kiwoom.issue_count(), 2);
    let times = kiwoom.issue_times();
    assert!(times[1] - times[0] >= Duration::from_secs(600), "{:?}", times[1] - times[0]);
    assert_eq!(peer.connect_count(), 2);
    assert!(peer.texts(1)[0].contains("FAKE-TOKEN-collector-0002"));
    running.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_second_invalid_token_response_stops_the_collector() {
    let peer = Peer::new(|_, trnm, _| if trnm == "LOGIN" { Reply::Code(8005) } else { Reply::Ack });
    let paths = Paths::new();
    let kiwoom = FakeKiwoom::issuing_tokens();
    let running = launch(&paths, &peer, &kiwoom, timings());
    let date = running.wall.date();
    let finish = running.finish().await;
    assert_eq!(kiwoom.issue_count(), 2);
    assert_eq!(peer.connect_count(), 2);
    let halt = halted(finish);
    assert!(matches!(halt, Halt::Login(rejection) if rejection.category == Category::TokenInvalid));
    let recorded = events(&raw_lines(&paths.data(), date));
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0, "down");
}

#[tokio::test(start_paused = true)]
async fn a_blocked_token_request_is_the_only_request_and_no_connection_is_tried() {
    for status in [200, 403] {
        let peer = Peer::accepting();
        let paths = Paths::new();
        let kiwoom = FakeKiwoom::new(move |_| blocked_reply(status));
        let running = launch(&paths, &peer, &kiwoom, timings());
        let date = running.wall.date();
        let finish = running.finish().await;
        assert_eq!(kiwoom.issue_count(), 1, "{status}");
        assert_eq!(peer.connect_count(), 0, "{status}");
        assert_eq!(exit_status(finish.as_ref().unwrap()), 1);
        let halt = halted(finish);
        assert!(matches!(halt, Halt::Token(_)), "{halt:?}");
        assert!(halt.action().contains("공인 IP"), "{}", halt.action());
        let recorded = events(&raw_lines(&paths.data(), date));
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].0, "down");
    }
}

#[tokio::test(start_paused = true)]
async fn a_registration_limit_rejection_stops_without_connecting_again() {
    let peer = Peer::new(|_, trnm, _| if trnm == "REG" { Reply::Code(105115) } else { Reply::Ack });
    let paths = Paths::new();
    let running = launch(&paths, &peer, &FakeKiwoom::issuing_tokens(), timings());
    let finish = running.finish().await;
    assert_eq!(peer.connect_count(), 1);
    assert_eq!(peer.count_sent("REG"), 1);
    let halt = halted(finish);
    assert!(matches!(&halt, Halt::Register(rejection) if rejection.category == Category::RealtimeCapacity));
    assert!(halt.action().contains("--items"));
}

#[tokio::test(start_paused = true)]
async fn a_rate_limited_reg_is_sent_again_after_one_second_and_only_once() {
    let peer = Peer::new(|_, trnm, nth| if trnm == "REG" && nth == 1 { Reply::Code(105110) } else { Reply::Ack });
    let paths = Paths::new();
    let running = launch(&paths, &peer, &FakeKiwoom::issuing_tokens(), timings());
    until("REG 두 번", || peer.count_sent("REG") == 2).await;
    settle().await;
    let sent = peer.sent_at(0, "REG");
    assert_eq!(sent[1] - sent[0], Duration::from_secs(1));
    assert_eq!(peer.connect_count(), 1);
    let date = running.wall.date();
    running.stop().await;
    assert_eq!(events(&raw_lines(&paths.data(), date))[0].0, "live");

    let peer = Peer::new(|_, trnm, _| if trnm == "REG" { Reply::Code(105110) } else { Reply::Ack });
    let running = launch(&Paths::new(), &peer, &FakeKiwoom::issuing_tokens(), timings());
    let halt = halted(running.finish().await);
    assert!(matches!(halt, Halt::Register(rejection) if rejection.category == Category::RateLimit));
    assert_eq!(peer.count_sent("REG"), 2);
    assert_eq!(peer.connect_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_termination_signal_writes_down_and_leaves_a_fully_readable_file() {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    peer.text(0, REAL_FRAME);
    settle().await;
    let date = running.wall.date();
    let finish = running.stop().await;
    assert_eq!(exit_status(&finish), 0);
    let items: Vec<RawItem> = read_day(&paths.data(), date).unwrap().collect();
    assert!(items.iter().all(|item| matches!(item, RawItem::Record(_))), "{items:?}");
    let Some(RawItem::Record(last)) = items.last() else { panic!("{items:?}") };
    assert_eq!(last.content, RawContent::Down { reason: "종료".into() });
    assert!(items.iter().any(|item| matches!(item, RawItem::Record(record) if record.content == RawContent::Frame(REAL_FRAME.into()))));
}

#[tokio::test(start_paused = true)]
async fn written_lines_become_readable_within_a_second_while_the_file_is_open() {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    peer.text(0, REAL_FRAME);
    settle().await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let date = running.wall.date();
    let items: Vec<RawItem> = read_day(&paths.data(), date).unwrap().collect();
    assert!(
        items.iter().any(|item| matches!(item, RawItem::Record(record) if record.content == RawContent::Frame(REAL_FRAME.into()))),
        "{items:?}"
    );
    running.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_second_collector_on_the_same_lock_fails_at_once_without_touching_kiwoom() {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    let second_kiwoom = FakeKiwoom::issuing_tokens();
    let second_peer = Peer::accepting();
    let second = launch(&paths, &second_peer, &second_kiwoom, timings());
    let result = second.finish().await;
    assert!(matches!(result, Err(server::instance::LockError::Held { .. })), "{result:?}");
    assert_eq!(second_kiwoom.issue_count(), 0);
    assert_eq!(second_peer.connect_count(), 0);
    running.stop().await;
}

#[tokio::test]
async fn the_real_web_socket_adapter_logs_in_registers_and_stores_a_frame_over_loopback() {
    use futures::{SinkExt, StreamExt};
    use tokio::sync::{oneshot, watch};

    async fn next_text<S>(socket: &mut S) -> String
    where
        S: futures::Stream<Item = Result<Message, WsError>> + Unpin,
    {
        loop {
            if let Message::Text(text) = socket.next().await.expect("연결이 끊겼다").unwrap() {
                return text.as_str().to_owned();
            }
        }
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (echoed_tx, echoed_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let login = next_text(&mut socket).await;
        let ack = |trnm: &str| Message::Text(json!({"trnm": trnm, "return_code": 0, "return_msg": ""}).to_string().into());
        socket.send(ack("LOGIN")).await.unwrap();
        let register = next_text(&mut socket).await;
        socket.send(ack("REG")).await.unwrap();
        socket.send(Message::Text(REAL_FRAME.into())).await.unwrap();
        socket.send(Message::Text(r#"{"trnm":"PING"}"#.into())).await.unwrap();
        assert_eq!(next_text(&mut socket).await, r#"{"trnm":"PING"}"#);
        echoed_tx.send(()).unwrap();
        while socket.next().await.is_some() {}
        (login, register)
    });

    let paths = Paths::new();
    let kiwoom = FakeKiwoom::issuing_tokens();
    let (stop, shutdown) = watch::channel(false);
    let injected = super::start::Injected {
        transport: transport(&kiwoom),
        connector: Arc::new(super::ws::WebSocketConnector::new(url)),
        wall_clock: Arc::new(super::session::SystemWallClock),
        token_clock: server::clock::Clock::system(),
        timings: timings(),
    };
    let (config, data) = (paths.config(), paths.data());
    let collector = tokio::spawn(async move { super::start::execute(&config, data, &items(), injected, shutdown).await });
    echoed_rx.await.unwrap();
    stop.send(true).unwrap();
    let finish = collector.await.unwrap().unwrap();
    assert!(matches!(finish, Finish::Shutdown));
    let (login, register) = server.await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&login).unwrap(), json!({"trnm": "LOGIN", "token": TOKEN_ONE}));
    assert!(register.contains("005930_AL") && register.contains("0F"), "{register}");
    let date = crate::kst::KstTime::from_unix_ms(super::session::SystemWallClock.now_ms()).date;
    let source = raw_source(&paths.data(), date);
    assert!(source.contains(&format!(",\"msg\":{REAL_FRAME}}}")), "{source}");
}

#[tokio::test(start_paused = true)]
async fn the_down_line_is_readable_during_the_reconnect_wait() {
    let peer = Peer::new(|connection, trnm, _| if connection < 6 && trnm == "REG" { Reply::AckThenClose } else { Reply::Ack });
    let paths = Paths::new();
    let running = launch(&paths, &peer, &FakeKiwoom::issuing_tokens(), timings());
    until("여섯째 연결", || peer.connect_count() == 6).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let date = running.wall.date();
    let downs = read_day(&paths.data(), date)
        .unwrap()
        .filter(|item| matches!(item, RawItem::Record(record) if matches!(record.content, RawContent::Down { .. })))
        .count();
    assert_eq!(downs, 6);
    running.stop().await;
}

#[tokio::test(start_paused = true)]
async fn shutdown_during_a_reconnect_wait_does_not_repeat_down() {
    let peer = Peer::accepting();
    let (paths, _kiwoom, running) = running_session(&peer).await;
    peer.close(0);
    settle().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let date = running.wall.date();
    running.stop().await;
    let names: Vec<String> = events(&raw_lines(&paths.data(), date)).into_iter().map(|(event, _)| event).collect();
    assert_eq!(names, ["live", "down"]);
}
