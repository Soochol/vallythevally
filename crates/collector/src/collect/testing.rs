use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use domain::KstDate;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::BoxFuture;
use futures::{Sink, Stream, StreamExt};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::instance::LockError;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use super::config::CollectorConfig;
use super::items::Items;
use super::session::{Finish, Timings, WallClock};
use super::start::{Injected, execute};
use super::ws::{Connector, Socket};

pub const APP_KEY: &str = "FAKE-COLLECTOR-KEY-1111";
pub const APP_SECRET: &str = "FAKE-COLLECTOR-SECRET-2222";
pub const TOKEN_ONE: &str = "FAKE-TOKEN-collector-0001";

pub fn token_reply(number: usize) -> Result<HttpResponse, TransportError> {
    let token = if number == 1 { TOKEN_ONE.to_owned() } else { format!("FAKE-TOKEN-collector-{number:04}") };
    let body = serde_json::json!({"token": token, "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"});
    Ok(HttpResponse { status: 200, next_key: None, body: body.to_string() })
}

pub fn blocked_reply(status: u16) -> Result<HttpResponse, TransportError> {
    let body = serde_json::json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]"});
    Ok(HttpResponse { status, next_key: None, body: body.to_string() })
}

type TokenReply = Box<dyn Fn(usize) -> Result<HttpResponse, TransportError> + Send + Sync>;

pub struct FakeKiwoom {
    issued: Mutex<Vec<(Instant, String)>>,
    reply: TokenReply,
}

impl FakeKiwoom {
    pub fn new(reply: impl Fn(usize) -> Result<HttpResponse, TransportError> + Send + Sync + 'static) -> Arc<FakeKiwoom> {
        Arc::new(FakeKiwoom { issued: Mutex::new(Vec::new()), reply: Box::new(reply) })
    }

    pub fn issuing_tokens() -> Arc<FakeKiwoom> {
        FakeKiwoom::new(token_reply)
    }

    pub fn issue_count(&self) -> usize {
        self.issued.lock().unwrap().len()
    }

    pub fn issue_times(&self) -> Vec<Instant> {
        self.issued.lock().unwrap().iter().map(|(at, _)| *at).collect()
    }
}

struct FakeTransport(Arc<FakeKiwoom>);

impl Transport for FakeTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        assert_eq!(request.api_id.as_str(), "au10001", "수집기는 토큰 발급 말고는 REST를 부르지 않는다");
        let number = {
            let mut issued = self.0.issued.lock().unwrap();
            issued.push((Instant::now(), request.body.expose().clone()));
            issued.len()
        };
        let reply = (self.0.reply)(number);
        Box::pin(async move { reply })
    }
}

pub fn transport(kiwoom: &Arc<FakeKiwoom>) -> Arc<dyn Transport> {
    Arc::new(FakeTransport(kiwoom.clone()))
}

pub struct FakeWall {
    start: Instant,
    base_ms: i64,
}

impl FakeWall {
    pub fn new() -> Arc<FakeWall> {
        Arc::new(FakeWall { start: Instant::now(), base_ms: start_clock().unix() * 1000 })
    }

    pub fn date(&self) -> u32 {
        crate::kst::KstTime::from_unix_ms(self.base_ms).date
    }
}

impl WallClock for FakeWall {
    fn now_ms(&self) -> i64 {
        self.base_ms + self.start.elapsed().as_millis() as i64
    }
}

pub fn start_clock() -> domain::KstTime {
    kst(KstDate::new(2026, 11, 16).unwrap(), 9, 0, 0)
}

#[derive(Clone, Copy, Debug)]
pub enum Reply {
    Ack,
    Code(u32),
    Silent,
    AckThenClose,
}

type Script = dyn Fn(usize, &str, usize) -> Reply + Send + Sync;
type Frames = UnboundedSender<Result<Message, WsError>>;

#[derive(Clone)]
pub struct Peer {
    script: Arc<Script>,
    seen: Arc<Mutex<Vec<(usize, String, Instant)>>>,
    frames: Arc<Mutex<Vec<Frames>>>,
    connects: Arc<Mutex<Vec<Instant>>>,
    attempts: Arc<AtomicUsize>,
}

struct ChannelSocket {
    incoming: UnboundedReceiver<Result<Message, WsError>>,
    outgoing: UnboundedSender<Message>,
}

impl Stream for ChannelSocket {
    type Item = Result<Message, WsError>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.incoming).poll_next(context)
    }
}

impl Sink<Message> for ChannelSocket {
    type Error = WsError;

    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        self.outgoing.unbounded_send(message).map_err(|_| WsError::ConnectionClosed)
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.outgoing.close_channel();
        Poll::Ready(Ok(()))
    }
}

impl Peer {
    pub fn new(script: impl Fn(usize, &str, usize) -> Reply + Send + Sync + 'static) -> Peer {
        Peer {
            script: Arc::new(script),
            seen: Arc::default(),
            frames: Arc::default(),
            connects: Arc::default(),
            attempts: Arc::default(),
        }
    }

    pub fn accepting() -> Peer {
        Peer::new(|_, _, _| Reply::Ack)
    }

    pub fn connect_count(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }

    pub fn connect_times(&self) -> Vec<Instant> {
        self.connects.lock().unwrap().clone()
    }

    pub fn texts(&self, connection: usize) -> Vec<String> {
        self.seen.lock().unwrap().iter().filter(|(number, ..)| *number == connection).map(|(_, text, _)| text.clone()).collect()
    }

    pub fn trnms(&self, connection: usize) -> Vec<String> {
        self.texts(connection).iter().map(|text| trnm_of(text)).collect()
    }

    pub fn sent_at(&self, connection: usize, trnm: &str) -> Vec<Instant> {
        self.seen.lock().unwrap().iter().filter(|(number, text, _)| *number == connection && trnm_of(text) == trnm).map(|(.., at)| *at).collect()
    }

    pub fn count_sent(&self, trnm: &str) -> usize {
        self.seen.lock().unwrap().iter().filter(|(_, text, _)| trnm_of(text) == trnm).count()
    }

    pub fn push(&self, connection: usize, message: Result<Message, WsError>) {
        self.frames.lock().unwrap()[connection].unbounded_send(message).unwrap();
    }

    pub fn text(&self, connection: usize, text: &str) {
        self.push(connection, Ok(Message::Text(text.to_owned().into())));
    }

    pub fn close(&self, connection: usize) {
        self.push(connection, Ok(Message::Close(None)));
    }
}

fn trnm_of(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text).unwrap()["trnm"].as_str().unwrap().to_owned()
}

impl Connector for Peer {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        let connection = self.attempts.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            self.connects.lock().unwrap().push(Instant::now());
            let (incoming_tx, incoming) = unbounded();
            self.frames.lock().unwrap().push(incoming_tx.clone());
            let (outgoing, mut outgoing_rx) = unbounded();
            let (script, seen) = (self.script.clone(), self.seen.clone());
            tokio::spawn(async move {
                let mut counts: HashMap<String, usize> = HashMap::new();
                while let Some(Message::Text(text)) = outgoing_rx.next().await {
                    let trnm = trnm_of(text.as_str());
                    seen.lock().unwrap().push((connection, text.as_str().to_owned(), Instant::now()));
                    if trnm == "PING" {
                        continue;
                    }
                    let nth = counts.entry(trnm.clone()).and_modify(|count| *count += 1).or_insert(1);
                    let reply = script(connection, &trnm, *nth);
                    let code = if let Reply::Code(code) = reply { code } else { 0 };
                    if !matches!(reply, Reply::Silent) {
                        let ack = serde_json::json!({"trnm": trnm, "return_code": code, "return_msg": ""});
                        if incoming_tx.unbounded_send(Ok(Message::Text(ack.to_string().into()))).is_err() {
                            return;
                        }
                    }
                    if matches!(reply, Reply::AckThenClose) {
                        let _ = incoming_tx.unbounded_send(Ok(Message::Close(None)));
                    }
                }
            });
            Ok(Box::new(ChannelSocket { incoming, outgoing }) as Socket)
        })
    }
}

pub struct Paths {
    pub folder: tempfile::TempDir,
}

impl Paths {
    pub fn new() -> Paths {
        Paths { folder: tempfile::tempdir().unwrap() }
    }

    pub fn data(&self) -> PathBuf {
        self.folder.path().join("data")
    }

    pub fn config(&self) -> CollectorConfig {
        CollectorConfig {
            app_key: Secret::new(APP_KEY.to_owned()),
            app_secret: Secret::new(APP_SECRET.to_owned()),
            token_path: self.folder.path().join("state/token.json"),
            lock_path: self.folder.path().join("state/collector.lock"),
        }
    }
}

pub fn items() -> Items {
    Items::parse(Some("005930,000660")).unwrap()
}

pub struct Running {
    pub wall: Arc<FakeWall>,
    stop: watch::Sender<bool>,
    task: JoinHandle<Result<Finish, LockError>>,
}

pub fn launch(paths: &Paths, peer: &Peer, kiwoom: &Arc<FakeKiwoom>, timings: Timings) -> Running {
    let wall = FakeWall::new();
    let (stop, shutdown) = watch::channel(false);
    let injected = Injected {
        transport: transport(kiwoom),
        connector: Arc::new(peer.clone()),
        wall_clock: wall.clone(),
        token_clock: Clock::fake(start_clock()),
        timings,
    };
    let (config, data) = (paths.config(), paths.data());
    let task = tokio::spawn(async move { execute(&config, data, &items(), injected, shutdown).await });
    Running { wall, stop, task }
}

impl Running {
    pub async fn stop(self) -> Finish {
        let _ = self.stop.send(true);
        self.task.await.unwrap().expect("잠금을 잡았다")
    }

    pub async fn finish(self) -> Result<Finish, LockError> {
        self.task.await.unwrap()
    }
}

pub async fn until(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..200_000 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("기다린 상태가 되지 않았다: {what}");
}

pub async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

pub fn raw_source(data: &Path, date: u32) -> String {
    let folder = data.join("raw").join(date.to_string());
    let mut files: Vec<PathBuf> = std::fs::read_dir(folder).unwrap().map(|entry| entry.unwrap().path()).collect();
    files.sort();
    files
        .iter()
        .map(|path| String::from_utf8(zstd::decode_all(std::fs::File::open(path).unwrap()).unwrap()).unwrap())
        .collect()
}

pub fn raw_lines(data: &Path, date: u32) -> Vec<serde_json::Value> {
    raw_source(data, date).lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

pub fn events(lines: &[serde_json::Value]) -> Vec<(String, Option<String>)> {
    lines
        .iter()
        .filter_map(|line| {
            let event = line.get("event")?.as_str()?.to_owned();
            Some((event, line.get("reason").and_then(|reason| reason.as_str()).map(str::to_owned)))
        })
        .collect()
}
