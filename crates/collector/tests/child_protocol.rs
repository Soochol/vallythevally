use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::protocol::{Command as DaemonCommand, Event, KeyName, RealType, Registration, SessionState, encode_line, parse_event};
use collector::raw_read::{RawContent, RawItem, read_day};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use server::config::Secret;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "FAKE-INTEGRATION-TOKEN-0001";
const BAD_TOKEN: &str = "FAKE-INTEGRATION-TOKEN-REJECTED";
const NEW_TOKEN: &str = "FAKE-INTEGRATION-TOKEN-0002";
const REAL_FRAME: &str = r#"{"trnm":"REAL","data":[{"type":"0B","item":"000001_AL","name":"주식체결","values":{"20":"090001","10":"-71000"}}]}"#;
const MARKET_FRAME: &str = r#"{"trnm":"REAL","data":[{"type":"0s","item":"","name":"장시작시간","values":{"215":"3","20":"090000","214":"000000"}}]}"#;
const WAIT: Duration = Duration::from_secs(30);

struct Kiwoom {
    url: String,
    received: Arc<Mutex<Vec<Value>>>,
    pushes: Arc<Mutex<Option<mpsc::UnboundedSender<Message>>>>,
    rejected_tokens: Arc<Mutex<HashSet<String>>>,
}

impl Kiwoom {
    async fn start() -> Kiwoom {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let kiwoom = Kiwoom {
            url: format!("ws://{}", listener.local_addr().unwrap()),
            received: Arc::default(),
            pushes: Arc::default(),
            rejected_tokens: Arc::default(),
        };
        let (received, pushes, rejected) = (kiwoom.received.clone(), kiwoom.pushes.clone(), kiwoom.rejected_tokens.clone());
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { continue };
                let (push, mut pushed) = mpsc::unbounded_channel();
                *pushes.lock().unwrap() = Some(push);
                let (received, rejected) = (received.clone(), rejected.clone());
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            message = socket.next() => {
                                let Some(Ok(Message::Text(text))) = message else { return };
                                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                                received.lock().unwrap().push(request.clone());
                                let trnm = request["trnm"].as_str().unwrap().to_owned();
                                let refused = trnm == "LOGIN" && rejected.lock().unwrap().contains(request["token"].as_str().unwrap());
                                let code = if refused { 8005 } else { 0 };
                                let ack = json!({"trnm": trnm, "return_code": code, "return_msg": ""});
                                if socket.send(Message::Text(ack.to_string().into())).await.is_err() {
                                    return;
                                }
                            }
                            Some(message) = pushed.recv() => {
                                if socket.send(message).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                });
            }
        });
        kiwoom
    }

    fn requests(&self, trnm: &str) -> Vec<Value> {
        self.received.lock().unwrap().iter().filter(|request| request["trnm"] == trnm).cloned().collect()
    }

    fn push(&self, text: &str) {
        self.pushes.lock().unwrap().as_ref().unwrap().send(Message::Text(text.to_owned().into())).unwrap();
    }

    fn reject_token(&self, token: &str) {
        self.rejected_tokens.lock().unwrap().insert(token.to_owned());
    }

    async fn until_requests(&self, trnm: &str, count: usize) {
        timeout(WAIT, async {
            while self.requests(trnm).len() < count {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{trnm} 요청 {count}개가 오지 않았다: {:?}", self.received.lock().unwrap()));
    }
}

struct Collector {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: tokio::io::Lines<BufReader<ChildStdout>>,
    stderr: tokio::task::JoinHandle<String>,
    seen: Vec<Event>,
    data: tempfile::TempDir,
}

fn spawn_child(kiwoom: &Kiwoom, extra: &[&str]) -> Collector {
    let data = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["collect", "--child", "--key", "k1", "--data", data.path().to_str().unwrap()])
        .args(extra)
        .env_clear()
        .env("VALLY_COLLECTOR_WS_URL", &kiwoom.url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take();
    let lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr_pipe: ChildStderr = child.stderr.take().unwrap();
    let stderr = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr_pipe.read_to_string(&mut text).await;
        text
    });
    Collector { child, stdin, lines, stderr, seen: Vec::new(), data }
}

impl Collector {
    async fn send_line(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();
    }

    async fn send(&mut self, command: &DaemonCommand) {
        self.send_line(&encode_line(command)).await;
    }

    async fn next_event(&mut self) -> Event {
        let line = timeout(WAIT, self.lines.next_line()).await.expect("사건이 시간 안에 오지 않았다").unwrap().expect("stdout이 닫혔다");
        let event = parse_event(&line).unwrap_or_else(|error| panic!("stdout 줄을 읽을 수 없다({error}): {line}"));
        self.seen.push(event.clone());
        event
    }

    async fn until(&mut self, what: &str, wanted: impl Fn(&Event) -> bool) -> Event {
        for _ in 0..200 {
            let event = self.next_event().await;
            if wanted(&event) {
                return event;
            }
        }
        panic!("기다린 사건이 오지 않았다: {what}: {:?}", self.seen);
    }

    async fn finish(mut self) -> (ExitStatus, String, tempfile::TempDir, Vec<Event>) {
        drop(self.stdin.take());
        while let Ok(Ok(Some(line))) = timeout(WAIT, self.lines.next_line()).await {
            self.seen.push(parse_event(&line).unwrap());
        }
        let status = timeout(WAIT, self.child.wait()).await.expect("프로세스가 끝나지 않았다").unwrap();
        let stderr = self.stderr.await.unwrap();
        (status, stderr, self.data, self.seen)
    }
}

fn token_command(token: &str, generation: u64) -> DaemonCommand {
    DaemonCommand::Token { token: Secret::new(token.to_owned()), generation }
}

fn stock_registration(id: &str, count: usize) -> DaemonCommand {
    DaemonCommand::Register(Registration::new(id, (0..count).map(|number| format!("{:06}", number + 1)).collect(), vec![RealType::Trade]).unwrap())
}

fn all_raw_text(data: &Path) -> String {
    let mut text = String::new();
    let mut stack: Vec<PathBuf> = vec![data.join("raw")];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = std::fs::File::open(&path).and_then(zstd::decode_all) {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
    }
    text
}

fn only_day(data: &Path) -> u32 {
    let days: Vec<u32> = std::fs::read_dir(data.join("raw")).unwrap().map(|entry| entry.unwrap().file_name().to_str().unwrap().parse().unwrap()).collect();
    assert_eq!(days.len(), 1, "{days:?}");
    days[0]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_child_walks_hello_token_login_register_live_and_stores_a_frame_in_its_key_folder() {
    let kiwoom = Kiwoom::start().await;
    let mut child = spawn_child(&kiwoom, &[]);
    let child_pid = child.child.id().unwrap();
    match child.next_event().await {
        Event::Hello { key, pid } => assert_eq!((key, pid), (KeyName::parse("k1").unwrap(), child_pid)),
        other => panic!("첫 사건이 hello가 아니다: {other:?}"),
    }
    child.send(&token_command(TOKEN, 1)).await;
    kiwoom.until_requests("LOGIN", 1).await;
    assert_eq!(kiwoom.requests("LOGIN")[0], json!({"trnm": "LOGIN", "token": TOKEN}));

    child.send(&stock_registration("r1", 120)).await;
    for part in 0..3u32 {
        let event = child.until("registered", |event| matches!(event, Event::Registered { .. })).await;
        let Event::Registered { batch, ok, replay, .. } = event else { unreachable!() };
        assert_eq!((batch.id.as_str(), batch.part, batch.parts, ok, replay), ("r1", part, 3, true, false));
        assert_eq!(batch.items, if part == 2 { 20 } else { 50 });
    }
    assert_eq!(child.next_event().await, Event::Live);
    let sizes: Vec<usize> = kiwoom.requests("REG").iter().map(|request| request["data"][0]["item"].as_array().unwrap().len()).collect();
    assert_eq!(sizes, [50, 50, 20]);
    assert_eq!(kiwoom.requests("REG")[0]["data"][0]["item"][0], "000001_AL");

    kiwoom.push(REAL_FRAME);
    let mut frames = 0;
    let mut last_state = SessionState::WaitingForToken;
    while frames < 5 {
        if let Event::Heartbeat { frames: seen, state, .. } = child.until("heartbeat", |event| matches!(event, Event::Heartbeat { .. })).await {
            frames += seen;
            last_state = state;
        }
    }
    assert_eq!(frames, 5, "LOGIN 응답 1 + REG 응답 3 + REAL 1");
    assert_eq!(last_state, SessionState::Live);

    child.send(&DaemonCommand::Shutdown).await;
    let (status, stderr, data, events) = child.finish().await;
    assert_eq!(status.code(), Some(0), "{stderr}");
    assert!(matches!(events.last(), Some(Event::Down { reason }) if reason == "종료"), "{events:?}");

    let day = only_day(data.path());
    let key_folder = data.path().join("raw").join(day.to_string()).join("k1");
    assert!(std::fs::read_dir(&key_folder).unwrap().count() >= 1);
    let stored: Vec<RawContent> = read_day(data.path(), day)
        .unwrap()
        .map(|item| match item {
            RawItem::Record(record) => record.content,
            other => panic!("줄이 아닙니다: {other:?}"),
        })
        .collect();
    assert!(stored.contains(&RawContent::Frame(REAL_FRAME.to_owned())), "{stored:?}");
    assert!(stored.contains(&RawContent::Live));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_market_hours_frame_becomes_a_market_open_event() {
    let kiwoom = Kiwoom::start().await;
    let mut child = spawn_child(&kiwoom, &[]);
    child.until("hello", |event| matches!(event, Event::Hello { .. })).await;
    child.send(&token_command(TOKEN, 1)).await;
    child.send(&DaemonCommand::Register(Registration::new("m", vec![String::new()], vec![RealType::MarketHours]).unwrap())).await;
    child.until("live", |event| matches!(event, Event::Live)).await;
    assert_eq!(kiwoom.requests("REG")[0]["data"][0], json!({"item": [""], "type": ["0s"]}));
    kiwoom.push(MARKET_FRAME);
    let Event::MarketOpen { recv_ms, values } = child.until("market_open", |event| matches!(event, Event::MarketOpen { .. })).await else { unreachable!() };
    assert_eq!(Value::Object(values), json!({"215": "3", "20": "090000", "214": "000000"}));
    assert!((1_500_000_000_000..4_000_000_000_000).contains(&recv_ms), "{recv_ms}");
    child.send(&DaemonCommand::Shutdown).await;
    assert_eq!(child.finish().await.0.code(), Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_token_is_reported_and_a_new_token_logs_in_again() {
    let kiwoom = Kiwoom::start().await;
    kiwoom.reject_token(BAD_TOKEN);
    let mut child = spawn_child(&kiwoom, &[]);
    child.send(&stock_registration("r1", 3)).await;
    child.send(&token_command(BAD_TOKEN, 7)).await;
    assert_eq!(child.until("token_invalid", |event| matches!(event, Event::TokenInvalid { .. })).await, Event::TokenInvalid { generation: 7 });
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(kiwoom.requests("LOGIN").len(), 1);

    child.send(&token_command(NEW_TOKEN, 8)).await;
    child.until("live", |event| matches!(event, Event::Live)).await;
    let logins = kiwoom.requests("LOGIN");
    assert_eq!(logins.len(), 2);
    assert_eq!(logins[1]["token"], NEW_TOKEN);
    child.send(&DaemonCommand::Shutdown).await;
    let (status, stderr, data, events) = child.finish().await;
    assert_eq!(status.code(), Some(0));
    for secret in [BAD_TOKEN, NEW_TOKEN] {
        assert!(!stderr.contains(secret), "stderr에 토큰이 있다");
        assert!(!all_raw_text(data.path()).contains(secret), "원문에 토큰이 있다");
        assert!(!events.iter().map(encode_line).collect::<String>().contains(secret), "사건에 토큰이 있다");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_token_value_reaches_stdout_stderr_or_the_raw_files() {
    let kiwoom = Kiwoom::start().await;
    let mut child = spawn_child(&kiwoom, &[]);
    child.send(&token_command(TOKEN, 1)).await;
    child.send(&stock_registration("r1", 2)).await;
    child.until("live", |event| matches!(event, Event::Live)).await;
    kiwoom.push(REAL_FRAME);
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    child.send_line(&format!("{{\"v\":1,\"cmd\":\"token\",\"token\":\"{TOKEN}\",\"generation\":\"not a number\"}}\n")).await;
    let halted = child.until("halted", |event| matches!(event, Event::Halted { .. })).await;
    let (status, stderr, data, events) = child.finish().await;
    assert_eq!(status.code(), Some(1));
    let stdout: String = events.iter().map(encode_line).collect();
    assert!(!format!("{halted:?}{stdout}").contains(TOKEN));
    assert!(!stderr.contains(TOKEN), "{stderr}");
    assert!(!all_raw_text(data.path()).contains(TOKEN));
    assert!(kiwoom.requests("LOGIN")[0]["token"] == TOKEN);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn broken_unknown_and_foreign_version_lines_halt_with_a_nonzero_exit() {
    let kiwoom = Kiwoom::start().await;
    let lines = [
        "깨진 줄\n",
        "{\"v\":1,\"cmd\":\"dance\"}\n",
        "{\"v\":2,\"cmd\":\"shutdown\"}\n",
        "{\"cmd\":\"shutdown\"}\n",
        "{\"v\":1,\"cmd\":\"register\",\"id\":\"r\",\"items\":[\"5930\"],\"types\":[\"0B\"]}\n",
        "\n",
    ];
    for line in lines {
        let mut child = spawn_child(&kiwoom, &[]);
        child.until("hello", |event| matches!(event, Event::Hello { .. })).await;
        child.send_line(line).await;
        let Event::Halted { reason, action } = child.until("halted", |event| matches!(event, Event::Halted { .. })).await else { unreachable!() };
        assert!(!reason.is_empty() && !action.is_empty());
        let (status, stderr, ..) = child.finish().await;
        assert_eq!(status.code(), Some(1), "{line:?}: {stderr}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_stdin_ends_the_child_like_a_shutdown() {
    let kiwoom = Kiwoom::start().await;
    let mut child = spawn_child(&kiwoom, &[]);
    child.until("hello", |event| matches!(event, Event::Hello { .. })).await;
    let (status, ..) = child.finish().await;
    assert_eq!(status.code(), Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_child_ends_when_its_parent_is_killed_even_though_stdin_stays_open() {
    let kiwoom = Kiwoom::start().await;
    let data = tempfile::tempdir().unwrap();
    let mut parent = Command::new("sh")
        .arg("-c")
        .arg(r#"exec 3<&0; "$COLLECTOR" collect --child --key k1 --data "$DATA" <&3 & wait"#)
        .env_clear()
        .env("COLLECTOR", env!("CARGO_BIN_EXE_collector"))
        .env("DATA", data.path())
        .env("VALLY_COLLECTOR_WS_URL", &kiwoom.url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let held_stdin = parent.stdin.take().unwrap();
    let mut lines = BufReader::new(parent.stdout.take().unwrap()).lines();
    let hello = timeout(WAIT, lines.next_line()).await.unwrap().unwrap().unwrap();
    let Event::Hello { pid, .. } = parse_event(&hello).unwrap() else { panic!("{hello}") };
    assert_ne!(Some(pid), parent.id());
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!process_gone(pid), "stdin을 열어 둔 채로 자식이 먼저 끝났다");

    parent.kill().await.unwrap();
    timeout(WAIT, async {
        while !process_gone(pid) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("부모가 죽었는데 자식이 남아 있다");
    drop(held_stdin);
}

fn process_gone(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z')),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_arguments_are_checked_before_anything_is_sent() {
    let run = |arguments: &'static [&'static str]| async move {
        let output = Command::new(env!("CARGO_BIN_EXE_collector")).arg("collect").args(arguments).env_clear().output().await.unwrap();
        (output.status.code(), String::from_utf8(output.stderr).unwrap(), output.stdout)
    };
    for arguments in [
        &["--child"][..],
        &["--child", "--key", "a/b"],
        &["--child", "--key", ""],
        &["--child", "--key", "k1", "--items", "005930"],
        &["--key", "k1", "--items", "005930"],
    ] {
        let (code, stderr, stdout) = run(arguments).await;
        assert_eq!(code, Some(2), "{arguments:?}: {stderr}");
        assert!(stdout.is_empty(), "{arguments:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_websocket_address_is_refused() {
    let output = Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["collect", "--child", "--key", "k1"])
        .env_clear()
        .env("VALLY_COLLECTOR_WS_URL", "ws://example.com:1")
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}
