use std::io::Cursor;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::{Value, json};
use server::config::Secret;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::child::{ChildParts, connector, is_loopback_ws, read_commands, run_session, write_events};
use super::link::{Events, Incoming};
use super::session::{Finish, Halt, Timings, WallClock};
use super::testing::*;
use crate::protocol::{Command, Event, KeyName, ProtocolError, RealType, Registration, SessionState, encode_line, parse_event};
use crate::raw_read::{RawContent, RawItem, read_day};

const CHILD_TOKEN: &str = "FAKE-CHILD-TOKEN-0001";
const NEW_CHILD_TOKEN: &str = "FAKE-CHILD-TOKEN-0002";
const MARKET_FRAME: &str = r#"{"trnm":"REAL","data":[{"type":"0s","item":"","name":"장시작시간","values":{"215":"3","20":"090000","214":"000000"}}]}"#;
const REAL_FRAME: &str = r#"{"trnm":"REAL","data":[{"type":"0B","item":"005930_AL","name":"주식체결","values":{"20":"090001","10":"-71000"}}]}"#;

struct Child {
    paths: Paths,
    wall: Arc<FakeWall>,
    commands: mpsc::UnboundedSender<Incoming>,
    events: Receiver<Event>,
    stop: watch::Sender<bool>,
    task: JoinHandle<Finish>,
}

fn launch_child(peer: &Peer) -> Child {
    let paths = Paths::new();
    let wall = FakeWall::new();
    let (commands, command_source) = mpsc::unbounded_channel();
    let (event_sink, events) = channel();
    let (stop, shutdown) = watch::channel(false);
    let parts = ChildParts {
        key: KeyName::parse("k1").unwrap(),
        data_dir: paths.data(),
        connector: Arc::new(peer.clone()),
        wall_clock: wall.clone(),
        timings: Timings::default(),
        commands: command_source,
        events: Events::to(event_sink),
        shutdown,
        minutes: None,
        flow: None,
        quotes: None,
    };
    let task = tokio::spawn(run_session(parts));
    Child { paths, wall, commands, events, stop, task }
}

fn token(value: &str, generation: u64) -> Command {
    Command::Token { token: Secret::new(value.to_owned()), generation, expires_at: None }
}

fn stocks(id: &str, count: usize, types: &[RealType]) -> Registration {
    Registration::new(id, (0..count).map(|number| format!("{:06}", number + 1)).collect(), types.to_vec()).unwrap()
}

impl Child {
    fn send(&self, command: Command) {
        self.commands.send(Ok(command)).unwrap();
    }

    fn seen(&self) -> Vec<Event> {
        self.events.try_iter().filter(|event| !matches!(event, Event::Heartbeat { .. })).collect()
    }

    async fn stop(self) -> (Finish, Vec<Event>, Paths, u32) {
        let date = self.wall.date();
        let _ = self.stop.send(true);
        let finish = self.task.await.unwrap();
        let events = self.events.try_iter().filter(|event| !matches!(event, Event::Heartbeat { .. })).collect();
        (finish, events, self.paths, date)
    }
}

async fn live_child(peer: &Peer, count: usize) -> Child {
    let child = launch_child(peer);
    child.send(token(CHILD_TOKEN, 1));
    until("LOGIN을 보냈다", || peer.count_sent("LOGIN") >= 1).await;
    child.send(Command::Register(stocks("r1", count, &[RealType::Trade, RealType::OrderBook])));
    until("마지막 REG를 보냈다", || peer.count_sent("REG") >= count.div_ceil(50)).await;
    settle().await;
    child
}

fn registered(events: &[Event]) -> Vec<(u32, u32, usize, bool, bool)> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Registered { batch, ok, replay, .. } => Some((batch.part, batch.parts, batch.items, *ok, *replay)),
            _ => None,
        })
        .collect()
}

fn record_contents(data: &std::path::Path, date: u32) -> Vec<RawContent> {
    read_day(data, date)
        .unwrap()
        .map(|item| match item {
            RawItem::Record(record) => record.content,
            other => panic!("줄이 아닙니다: {other:?}"),
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn nothing_is_sent_before_the_daemon_gives_a_token() {
    let peer = Peer::accepting();
    let child = launch_child(&peer);
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(peer.connect_count(), 0);
    child.send(token(CHILD_TOKEN, 1));
    until("LOGIN을 보냈다", || peer.count_sent("LOGIN") == 1).await;
    assert_eq!(serde_json::from_str::<Value>(&peer.texts(0)[0]).unwrap(), json!({"trnm": "LOGIN", "token": CHILD_TOKEN}));
    let (finish, events, ..) = child.stop().await;
    assert!(matches!(finish, Finish::Shutdown));
    assert!(!events.iter().any(|event| matches!(event, Event::Live)), "{events:?}");
}

#[tokio::test(start_paused = true)]
async fn one_hundred_twenty_items_go_out_as_three_reg_messages_and_the_child_goes_live() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 120).await;
    assert_eq!(peer.trnms(0), ["LOGIN", "REG", "REG", "REG"]);
    let shapes: Vec<(usize, Value)> = peer
        .texts(0)
        .iter()
        .skip(1)
        .map(|text| {
            let message: Value = serde_json::from_str(text).unwrap();
            (message["data"][0]["item"].as_array().unwrap().len(), message["data"][0]["type"].clone())
        })
        .collect();
    assert_eq!(shapes, [(50, json!(["0B", "0D"])), (50, json!(["0B", "0D"])), (20, json!(["0B", "0D"]))]);
    let first: Value = serde_json::from_str(&peer.texts(0)[1]).unwrap();
    assert_eq!(first["data"][0]["item"][0], "000001_AL");
    assert_eq!(first["refresh"], "1");
    let (_, events, ..) = child.stop().await;
    assert_eq!(registered(&events), [(0, 3, 50, true, false), (1, 3, 50, true, false), (2, 3, 20, true, false)]);
    let positions = |wanted: fn(&Event) -> bool| events.iter().position(wanted).unwrap();
    assert!(positions(|event| matches!(event, Event::Live)) > events.iter().rposition(|event| matches!(event, Event::Registered { .. })).unwrap());
    assert!(matches!(&events[0], Event::Registered { batch, .. } if batch.id == "r1"));
}

#[tokio::test(start_paused = true)]
async fn a_logged_in_child_with_nothing_to_register_is_not_live_yet() {
    let peer = Peer::accepting();
    let child = launch_child(&peer);
    child.send(token(CHILD_TOKEN, 1));
    until("LOGIN을 보냈다", || peer.count_sent("LOGIN") == 1).await;
    settle().await;
    assert!(child.seen().is_empty());
    child.send(Command::Register(stocks("r1", 1, &[RealType::Trade])));
    until("REG를 보냈다", || peer.count_sent("REG") == 1).await;
    settle().await;
    assert!(matches!(child.seen().last(), Some(Event::Live)));
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn market_wide_types_register_with_their_items_as_given() {
    let peer = Peer::accepting();
    let child = launch_child(&peer);
    child.send(token(CHILD_TOKEN, 1));
    child.send(Command::Register(Registration::new("m1", vec!["001".into(), "101".into()], vec![RealType::SectorIndex, RealType::SectorBreadth]).unwrap()));
    child.send(Command::Register(Registration::new("m2", vec![String::new()], vec![RealType::MarketHours]).unwrap()));
    until("REG 둘", || peer.count_sent("REG") == 2).await;
    let entries: Vec<Value> = peer.texts(0).iter().skip(1).map(|text| serde_json::from_str::<Value>(text).unwrap()["data"][0].clone()).collect();
    assert_eq!(entries, [json!({"item": ["001", "101"], "type": ["0J", "0U"]}), json!({"item": [""], "type": ["0s"]})]);
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_rejected_batch_is_reported_dropped_from_the_replay_and_the_others_stay() {
    let peer = Peer::new(|connection, trnm, nth| if connection == 0 && trnm == "REG" && nth == 2 { Reply::Code(105115) } else { Reply::Ack });
    let child = live_child(&peer, 120).await;
    let events = child.seen();
    let batches = registered(&events);
    assert_eq!(batches.iter().map(|batch| batch.3).collect::<Vec<_>>(), [true, false, true]);
    let rejection = events.iter().find_map(|event| match event {
        Event::Registered { rejection: Some(rejection), .. } => Some(rejection.clone()),
        _ => None,
    });
    assert_eq!(rejection.unwrap().return_code, Some(105115));
    assert!(matches!(events.last(), Some(Event::Live)));

    peer.close(0);
    until("둘째 연결의 REG 둘", || peer.count_sent("REG") == 5).await;
    settle().await;
    assert_eq!(peer.trnms(1), ["LOGIN", "REG", "REG"]);
    let replayed: Vec<usize> = peer.texts(1).iter().skip(1).map(|text| serde_json::from_str::<Value>(text).unwrap()["data"][0]["item"].as_array().unwrap().len()).collect();
    assert_eq!(replayed, [50, 20]);
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_rejected_re_registration_does_not_take_an_accepted_item_out_of_the_replay() {
    let peer = Peer::new(|connection, trnm, nth| if connection == 0 && trnm == "REG" && nth == 2 { Reply::Code(105115) } else { Reply::Ack });
    let child = live_child(&peer, 2).await;
    child.send(Command::Register(Registration::new("again", vec!["000001".into()], vec![RealType::Trade, RealType::OrderBook]).unwrap()));
    until("둘째 REG", || peer.count_sent("REG") == 2).await;
    settle().await;
    assert_eq!(registered(&child.seen()).iter().map(|batch| batch.3).collect::<Vec<_>>(), [true, false]);
    peer.close(0);
    until("둘째 연결의 REG", || peer.count_sent("REG") == 3).await;
    settle().await;
    let replayed: Vec<Value> = peer.texts(1).iter().skip(1).map(|text| serde_json::from_str::<Value>(text).unwrap()["data"][0]["item"].clone()).collect();
    assert_eq!(replayed, [json!(["000001_AL", "000002_AL"])]);
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn after_a_reconnect_every_accepted_registration_is_sent_again_with_the_same_token() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 120).await;
    child.seen();
    peer.close(0);
    until("둘째 연결의 REG 셋", || peer.count_sent("REG") == 6).await;
    settle().await;
    assert_eq!(peer.trnms(1), ["LOGIN", "REG", "REG", "REG"]);
    assert!(peer.texts(1)[0].contains(CHILD_TOKEN));
    let events = child.seen();
    assert!(matches!(&events[0], Event::Down { .. }), "{events:?}");
    assert_eq!(registered(&events), [(0, 3, 50, true, true), (1, 3, 50, true, true), (2, 3, 20, true, true)]);
    assert!(matches!(events.last(), Some(Event::Live)));
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn only_a_batch_that_was_sent_before_is_flagged_as_a_replay() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    child.seen();
    peer.close(0);
    until("끊김", || child.events.try_iter().any(|event| matches!(event, Event::Down { .. }))).await;
    child.send(Command::Register(Registration::new("fresh", vec!["000777".into()], vec![RealType::Trade]).unwrap()));
    until("둘째 연결의 REG 둘", || peer.count_sent("REG") == 3).await;
    settle().await;
    let flags: Vec<(String, bool)> = child
        .seen()
        .into_iter()
        .filter_map(|event| match event {
            Event::Registered { batch, replay, .. } => Some((batch.id, replay)),
            _ => None,
        })
        .collect();
    assert_eq!(flags, [("r1".to_owned(), true), ("fresh".to_owned(), false)]);
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_same_pair_registered_twice_before_any_answer_is_still_replayed_once() {
    let peer = Peer::accepting();
    let child = launch_child(&peer);
    child.send(Command::Register(stocks("a", 2, &[RealType::Trade])));
    child.send(Command::Register(stocks("b", 2, &[RealType::Trade])));
    child.send(token(CHILD_TOKEN, 1));
    until("REG 둘", || peer.count_sent("REG") == 2).await;
    settle().await;
    peer.close(0);
    until("둘째 연결의 REG", || peer.count_sent("REG") == 3).await;
    settle().await;
    assert_eq!(peer.trnms(1), ["LOGIN", "REG"]);
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_token_rejected_at_login_is_reported_with_its_generation_and_a_new_one_is_awaited() {
    let peer = Peer::new(|connection, trnm, _| if trnm == "LOGIN" && connection == 0 { Reply::Code(8005) } else { Reply::Ack });
    let child = launch_child(&peer);
    child.send(Command::Register(stocks("r1", 2, &[RealType::Trade])));
    child.send(token(CHILD_TOKEN, 4));
    until("거절된 LOGIN", || peer.count_sent("LOGIN") == 1).await;
    settle().await;
    let events = child.seen();
    assert!(events.contains(&Event::TokenInvalid { generation: 4 }), "{events:?}");
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(peer.count_sent("LOGIN"), 1, "새 토큰이 오기 전에는 다시 LOGIN하지 않는다");

    child.send(token(NEW_CHILD_TOKEN, 5));
    until("둘째 LOGIN", || peer.count_sent("LOGIN") == 2).await;
    until("REG", || peer.count_sent("REG") == 1).await;
    settle().await;
    assert!(peer.texts(1)[0].contains(NEW_CHILD_TOKEN));
    assert!(!peer.texts(1)[0].contains(CHILD_TOKEN));
    assert!(matches!(child.seen().last(), Some(Event::Live)));
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_market_hours_frame_becomes_a_market_open_event_with_its_values_and_arrival_time() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    child.seen();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let received_at = child.wall.now_ms();
    peer.text(0, MARKET_FRAME);
    peer.text(0, REAL_FRAME);
    settle().await;
    let events = child.seen();
    assert_eq!(
        events,
        [Event::MarketOpen { recv_ms: received_at, values: serde_json::from_value(json!({"215": "3", "20": "090000", "214": "000000"})).unwrap() }]
    );
    let (_, _, paths, date) = child.stop().await;
    let stored = record_contents(&paths.data(), date);
    assert!(stored.contains(&RawContent::Frame(MARKET_FRAME.to_owned())));
}

#[tokio::test(start_paused = true)]
async fn the_heartbeat_reports_frames_and_bytes_since_the_last_one_and_the_session_state() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    peer.text(0, REAL_FRAME);
    peer.text(0, REAL_FRAME);
    settle().await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    settle().await;
    let beats: Vec<Event> = child.events.try_iter().filter(|event| matches!(event, Event::Heartbeat { .. })).collect();
    let ack = |trnm: &str| json!({"trnm": trnm, "return_code": 0, "return_msg": ""}).to_string().len() as u64;
    assert_eq!(
        beats,
        [Event::Heartbeat { frames: 4, bytes: ack("LOGIN") + ack("REG") + 2 * REAL_FRAME.len() as u64, state: SessionState::Live }]
    );
    tokio::time::sleep(Duration::from_secs(5)).await;
    settle().await;
    let beats: Vec<Event> = child.events.try_iter().filter(|event| matches!(event, Event::Heartbeat { .. })).collect();
    assert_eq!(beats, [Event::Heartbeat { frames: 0, bytes: 0, state: SessionState::Live }]);
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn heartbeats_keep_coming_while_the_child_waits_for_a_token() {
    let peer = Peer::accepting();
    let child = launch_child(&peer);
    tokio::time::sleep(Duration::from_secs(16)).await;
    settle().await;
    let beats: Vec<Event> = child.events.try_iter().collect();
    assert_eq!(beats.len(), 3);
    assert!(beats.iter().all(|beat| matches!(beat, Event::Heartbeat { frames: 0, bytes: 0, state: SessionState::WaitingForToken })), "{beats:?}");
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_unregister_sends_remove_and_the_items_are_not_replayed() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 60).await;
    child.seen();
    child.send(Command::Unregister(stocks("u1", 10, &[RealType::Trade, RealType::OrderBook])));
    until("REMOVE를 보냈다", || peer.count_sent("REMOVE") == 1).await;
    settle().await;
    let remove: Value = serde_json::from_str(peer.texts(0).last().unwrap()).unwrap();
    assert_eq!(remove["trnm"], "REMOVE");
    assert_eq!(remove["data"][0]["item"].as_array().unwrap().len(), 10);
    assert_eq!(remove["data"][0]["type"], json!(["0B", "0D"]));
    assert!(remove.get("refresh").is_none());
    let events = child.seen();
    assert!(matches!(&events[..], [Event::Unregistered { batch, ok: true, .. }] if batch.id == "u1" && batch.items == 10), "{events:?}");

    peer.close(0);
    until("둘째 연결의 REG", || peer.count_sent("REG") == 4).await;
    settle().await;
    let replayed: Vec<usize> = peer.texts(1).iter().skip(1).map(|text| serde_json::from_str::<Value>(text).unwrap()["data"][0]["item"].as_array().unwrap().len()).collect();
    assert_eq!(replayed, [40, 10]);
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn registering_while_live_is_sent_at_once_and_a_later_reconnect_replays_it() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    child.seen();
    child.send(Command::Register(Registration::new("late", vec!["005380".into()], vec![RealType::ProgramTrade]).unwrap()));
    until("셋째 REG", || peer.count_sent("REG") == 2).await;
    settle().await;
    assert_eq!(registered(&child.seen()), [(0, 1, 1, true, false)]);
    peer.close(0);
    until("둘째 연결의 REG 둘", || peer.count_sent("REG") == 4).await;
    child.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_broken_command_halts_with_a_halted_event_and_a_down_line() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    child.seen();
    child.commands.send(Err(ProtocolError::NotJson)).unwrap();
    let date = child.wall.date();
    let finish = child.task.await.unwrap();
    assert!(matches!(&finish, Finish::Halted(Halt::Protocol(ProtocolError::NotJson))), "{finish:?}");
    let events: Vec<Event> = child.events.try_iter().filter(|event| !matches!(event, Event::Heartbeat { .. })).collect();
    assert!(matches!(&events[0], Event::Down { .. }), "{events:?}");
    assert!(matches!(&events[1], Event::Halted { reason, action } if reason.contains("JSON") && !action.is_empty()), "{events:?}");
    let stored = record_contents(&child.paths.data(), date);
    assert!(matches!(stored.last(), Some(RawContent::Down { .. })));
}

#[tokio::test(start_paused = true)]
async fn a_foreign_version_halts_even_before_a_token_arrives() {
    let peer = Peer::accepting();
    let child = launch_child(&peer);
    child.commands.send(Err(ProtocolError::Version(Some(2)))).unwrap();
    let finish = child.task.await.unwrap();
    assert!(matches!(finish, Finish::Halted(Halt::Protocol(ProtocolError::Version(Some(2))))));
    assert!(child.events.try_iter().any(|event| matches!(event, Event::Halted { .. })));
}

#[tokio::test(start_paused = true)]
async fn the_shutdown_command_and_a_closed_command_channel_both_end_the_child_cleanly() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    child.send(Command::Shutdown);
    assert!(matches!(child.task.await.unwrap(), Finish::Shutdown));
    let events: Vec<Event> = child.events.try_iter().filter(|event| !matches!(event, Event::Heartbeat { .. })).collect();
    assert!(matches!(events.last(), Some(Event::Down { reason }) if reason == "종료"), "{events:?}");

    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    drop(child.commands);
    assert!(matches!(child.task.await.unwrap(), Finish::Shutdown));
}

#[tokio::test(start_paused = true)]
async fn raw_lines_go_to_the_key_folder_and_never_hold_a_token() {
    let peer = Peer::accepting();
    let child = live_child(&peer, 2).await;
    peer.text(0, REAL_FRAME);
    settle().await;
    let (_, events, paths, date) = child.stop().await;
    let day_folder = paths.data().join("raw").join(date.to_string());
    let direct_files = std::fs::read_dir(&day_folder).unwrap().filter(|entry| entry.as_ref().unwrap().path().is_file()).count();
    assert_eq!(direct_files, 0);
    assert!(std::fs::read_dir(day_folder.join("k1")).unwrap().count() >= 1);
    let stored = record_contents(&paths.data(), date);
    assert!(stored.contains(&RawContent::Live));
    assert!(stored.contains(&RawContent::Frame(REAL_FRAME.to_owned())));
    let everything = format!("{stored:?} {events:?}");
    for secret in [CHILD_TOKEN, NEW_CHILD_TOKEN] {
        assert!(!everything.contains(secret), "{secret}");
    }
    let lines: String = events.iter().map(encode_line).collect();
    assert!(!lines.contains(CHILD_TOKEN));
}

#[test]
fn commands_are_read_line_by_line_until_the_end_of_input() {
    let input = format!(
        "{}{}{}",
        encode_line(&token(CHILD_TOKEN, 1)),
        encode_line(&Command::Register(stocks("r", 1, &[RealType::Trade]))),
        encode_line(&Command::Shutdown),
    );
    let (sink, mut source) = mpsc::unbounded_channel();
    read_commands(Cursor::new(input), &sink);
    drop(sink);
    let mut received = Vec::new();
    while let Ok(incoming) = source.try_recv() {
        received.push(incoming);
    }
    assert_eq!(received.len(), 3);
    assert!(matches!(received[0], Ok(Command::Token { generation: 1, .. })));
    assert!(matches!(received[2], Ok(Command::Shutdown)));
}

#[test]
fn reading_stops_after_the_first_broken_line() {
    let input = format!("{}깨진 줄\n{}", encode_line(&Command::Shutdown).replace("shutdown", "register"), encode_line(&token(CHILD_TOKEN, 1)));
    let (sink, mut source) = mpsc::unbounded_channel();
    read_commands(Cursor::new(input), &sink);
    drop(sink);
    let mut received = Vec::new();
    while let Ok(incoming) = source.try_recv() {
        received.push(incoming);
    }
    assert!(matches!(received[0], Err(ProtocolError::Invalid { .. })));
    assert_eq!(received.len(), 1);
}

#[test]
fn a_line_that_is_not_utf8_is_a_broken_line() {
    let (sink, mut source) = mpsc::unbounded_channel();
    read_commands(Cursor::new(vec![0xff, 0xfe, b'\n']), &sink);
    assert_eq!(source.try_recv().unwrap(), Err(ProtocolError::Unreadable));
}

#[test]
fn events_are_written_one_json_line_each_with_the_version() {
    let (sink, source) = channel();
    sink.send(Event::Live).unwrap();
    sink.send(Event::Down { reason: "끊김".into() }).unwrap();
    drop(sink);
    let mut out = Vec::new();
    write_events(source, &mut out);
    let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(parse_event(lines[0]).unwrap(), Event::Live);
    assert_eq!(serde_json::from_str::<Value>(lines[1]).unwrap(), json!({"v": crate::protocol::PROTOCOL_VERSION, "event": "down", "reason": "끊김"}));
}

#[test]
fn only_loopback_addresses_may_replace_the_kiwoom_address() {
    for good in ["ws://127.0.0.1:8080", "ws://localhost:9", "ws://[::1]:1/x", "ws://127.0.0.1"] {
        assert!(is_loopback_ws(good), "{good}");
    }
    for bad in ["wss://127.0.0.1:1", "ws://example.com:1", "ws://127.0.0.1.evil.com:1", "ws://localhost.evil.com", "http://127.0.0.1", "127.0.0.1:1",
        "ws://127.0.0.1:1@127.0.0.2:9", "ws://localhost:x@evil.com:9", "ws://[::1]:1@evil.com", "ws://127.0.0.1:1\\@evil.com", "ws://127.0.0.1:@x", "ws://127.0.0.1:1x", "ws://[::1", "ws://"] {
        assert!(!is_loopback_ws(bad), "{bad}");
    }
    let variables = |url: &str| [("VALLY_COLLECTOR_WS_URL".to_owned(), url.to_owned())].into_iter().collect();
    assert!(connector(&variables("ws://127.0.0.1:1")).is_ok());
    assert!(connector(&variables("ws://example.com:1")).is_err());
    assert!(connector(&Default::default()).is_ok());
}

#[tokio::test]
async fn child_session_writes_symbol_flow_and_link_events() {
    use crate::shared::flow::FileFlowStore;
    use server::shared_data::{FlowCursor, flow_links_path, flow_path};

    let peer = Peer::accepting();
    let paths = Paths::new();
    let shared = paths.data().join("shared");
    let wall = FakeWall::new();
    let (commands, command_source) = mpsc::unbounded_channel();
    let (event_sink, events) = channel();
    let (stop, shutdown) = watch::channel(false);
    let key = KeyName::parse("k1").unwrap();
    let parts = ChildParts {
        key: key.clone(),
        data_dir: paths.data(),
        connector: Arc::new(peer.clone()),
        wall_clock: wall.clone(),
        timings: Timings { backoff: [Duration::from_millis(10); 5], ..Timings::default() },
        commands: command_source,
        events: Events::to(event_sink),
        shutdown,
        minutes: None,
        flow: Some(FileFlowStore::new(shared.clone(), key)),
    };
    let task = tokio::spawn(run_session(parts));
    let child = Child { paths, wall, commands, events, stop, task };

    child.send(token(CHILD_TOKEN, 1));
    until("LOGIN", || peer.count_sent("LOGIN") == 1).await;
    child.send(Command::Register(stocks("r1", 1, &[RealType::Trade])));
    until("REG", || peer.count_sent("REG") == 1).await;
    settle().await;

    let first = json!({"trnm": "REAL", "data": [{"type": "0F", "item": "005930_AL", "values": {"141": "키움", "161": "10"}}]}).to_string();
    let second = json!({"trnm": "REAL", "data": [{"type": "0F", "item": "005930_AL", "values": {"141": "키움", "161": "25"}}]}).to_string();
    peer.text(0, &first);
    settle().await;

    peer.close(0);
    until("재접속 REG", || peer.count_sent("REG") == 2).await;
    settle().await;
    peer.text(1, &second);
    settle().await;

    let (finish, _, _paths, date) = child.stop().await;
    assert!(matches!(finish, Finish::Shutdown));

    let date_text = date.to_string();
    let blocks = FlowCursor::new(flow_path(&shared, &date_text, "0F", "005930", "k1")).read_new().unwrap();
    let rows: Vec<_> = blocks.iter().flat_map(|block| &block.rows).collect();
    assert_eq!(rows.len(), 2);
    let fids = &blocks[0].description.fids;
    let at = |row: usize, fid: u32| rows[row].values[fids.iter().position(|f| *f == fid).unwrap()].as_deref();
    assert_eq!((at(0, 141), at(0, 161)), (Some("키움"), Some("10")));
    assert_eq!((at(1, 141), at(1, 161)), (Some("키움"), Some("25")));

    let links_text = std::fs::read_to_string(flow_links_path(&shared, &date_text, "k1")).unwrap();
    let link_events: Vec<String> = links_text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|line| line["event"] != "alive")
        .map(|line| line["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(link_events, ["start", "live", "down", "live", "down", "end"]);
}
