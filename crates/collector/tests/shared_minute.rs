use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use collector::collect::child::{ChildParts, run_session};
use collector::collect::link::{Events, Incoming};
use collector::collect::session::{Finish, Timings, WallClock};
use collector::collect::ws::{Connector, Socket};
use collector::protocol::{Command, KeyName, RealType, Registration};
use collector::raw_read::{RawContent, RawItem, read_day};
use collector::shared::minute::{FLUSH_EVERY, FileMinuteStore, MinuteStore, spawn};
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::BoxFuture;
use futures::{Sink, Stream, StreamExt};
use serde_json::{Value, json};
use server::config::Secret;
use server::shared_data::{MinuteBar, MinuteInstrument, MinuteVenue, minute_path};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(30);
const DAY: u32 = 20261123;
const DAY_START_MS: i64 = 1_795_395_600_000;
const SECOND_KEY_TOKEN: &str = "FAKE-MINUTE-TOKEN-0001";

struct Wall;

impl WallClock for Wall {
    fn now_ms(&self) -> i64 {
        DAY_START_MS + 9 * 3_600_000
    }
}

type Pushed = UnboundedSender<Result<Message, WsError>>;

struct Peer {
    pushes: Arc<Mutex<Vec<Pushed>>>,
    seen: Arc<Mutex<Vec<String>>>,
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

#[derive(Clone)]
struct Kiwoom(Arc<Peer>);

impl Connector for Kiwoom {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        let peer = self.0.clone();
        Box::pin(async move {
            peer.attempts.fetch_add(1, Ordering::SeqCst);
            let (incoming_tx, incoming) = unbounded();
            peer.pushes.lock().unwrap().push(incoming_tx.clone());
            let (outgoing, mut outgoing_rx) = unbounded();
            let seen = peer.seen.clone();
            tokio::spawn(async move {
                while let Some(Message::Text(text)) = outgoing_rx.next().await {
                    let trnm = serde_json::from_str::<Value>(text.as_str()).unwrap()["trnm"].as_str().unwrap().to_owned();
                    seen.lock().unwrap().push(trnm.clone());
                    if trnm == "PING" {
                        continue;
                    }
                    let ack = json!({"trnm": trnm, "return_code": 0, "return_msg": ""});
                    if incoming_tx.unbounded_send(Ok(Message::Text(ack.to_string().into()))).is_err() {
                        return;
                    }
                }
            });
            Ok(Box::new(ChannelSocket { incoming, outgoing }) as Socket)
        })
    }
}

struct Run {
    peer: Arc<Peer>,
    commands: mpsc::UnboundedSender<Incoming>,
    stop: watch::Sender<bool>,
    task: JoinHandle<Finish>,
}

struct Beacon {
    state: Mutex<(u64, bool)>,
    changed: Condvar,
}

impl Beacon {
    fn new() -> Arc<Beacon> {
        Arc::new(Beacon { state: Mutex::new((0, false)), changed: Condvar::new() })
    }

    fn ring(&self) {
        self.state.lock().unwrap().0 += 1;
        self.changed.notify_all();
    }

    fn close(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }

    async fn until(&self, what: &str, condition: impl Fn() -> bool) {
        self.until_within(what, NO_PROGRESS_LIMIT, condition).await;
    }

    async fn until_within(&self, what: &str, no_progress_limit: Duration, condition: impl Fn() -> bool) {
        let (mut seen_rings, mut last_progress) = (self.state.lock().unwrap().0, Instant::now());
        loop {
            if condition() {
                return;
            }
            let (rings, closed) = *self.state.lock().unwrap();
            assert!(!closed, "집계가 끝나 더는 오지 않는다: {what}");
            if rings != seen_rings {
                (seen_rings, last_progress) = (rings, Instant::now());
            }
            assert!(last_progress.elapsed() < no_progress_limit, "{no_progress_limit:?} 동안 새 신호가 없다: {what}");
            let state = self.state.lock().unwrap();
            drop(self.changed.wait_timeout_while(state, Duration::from_millis(1), |state| state.0 == rings && !state.1).unwrap());
            tokio::task::yield_now().await;
        }
    }
}

struct Watched {
    inner: Box<dyn MinuteStore>,
    written: Arc<Beacon>,
}

impl MinuteStore for Watched {
    fn load(&mut self, date: u32) -> io::Result<Vec<MinuteBar>> {
        self.inner.load(date)
    }

    fn append(&mut self, date: u32, bars: &[MinuteBar], as_of: i64) -> io::Result<()> {
        let result = self.inner.append(date, bars, as_of);
        self.written.ring();
        result
    }

    fn finish(&mut self) -> io::Result<()> {
        self.inner.finish()
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        self.written.close();
    }
}

async fn yield_until(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..20_000 {
        if condition() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("기다린 상태가 되지 않았다: {what}");
}

async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}

async fn start(data: &Path, key: &str, store: Box<dyn MinuteStore>) -> Run {
    start_with_quotes(data, key, store, None).await
}

async fn start_with_quotes(data: &Path, key: &str, store: Box<dyn MinuteStore>, quotes: Option<PathBuf>) -> Run {
    let peer = Arc::new(Peer { pushes: Arc::default(), seen: Arc::default(), attempts: Arc::default() });
    let (commands, command_source) = mpsc::unbounded_channel();
    let (stop, shutdown) = watch::channel(false);
    let parts = ChildParts {
        key: KeyName::parse(key).unwrap(),
        data_dir: data.to_owned(),
        connector: Arc::new(Kiwoom(peer.clone())),
        wall_clock: Arc::new(Wall),
        timings: Timings::default(),
        commands: command_source,
        events: Events::none(),
        shutdown,
        minutes: Some(store),
        flow: None,
        quotes,
    };
    let task = tokio::spawn(run_session(parts));
    commands.send(Ok(Command::Token { token: Secret::new(SECOND_KEY_TOKEN.to_owned()), generation: 1, expires_at: None })).unwrap();
    yield_until("LOGIN", || peer.seen.lock().unwrap().iter().any(|trnm| trnm == "LOGIN")).await;
    let registration = Registration::new("r1", vec!["005930".to_owned()], vec![RealType::Trade]).unwrap();
    commands.send(Ok(Command::Register(registration))).unwrap();
    yield_until("REG", || peer.seen.lock().unwrap().iter().any(|trnm| trnm == "REG")).await;
    Run { peer, commands, stop, task }
}

impl Run {
    fn push(&self, text: &str) {
        self.peer.pushes.lock().unwrap()[0].unbounded_send(Ok(Message::Text(text.to_owned().into()))).unwrap();
    }

    async fn stop(self) -> Finish {
        let _ = self.stop.send(true);
        drop(self.commands);
        self.task.await.unwrap()
    }
}

fn stock(item: &str, time: &str, price: &str, quantity: &str, venue: &str) -> String {
    json!({"trnm": "REAL", "data": [{"type": "0B", "item": format!("{item}_AL"), "name": "주식체결", "values": {"20": time, "10": price, "15": quantity, "9081": venue}}]}).to_string()
}

fn index(item: &str, time: &str, price: &str, quantity: &str, cumulative_value: &str) -> String {
    json!({"trnm": "REAL", "data": [{"type": "0J", "item": item, "name": "업종지수", "values": {"20": time, "10": price, "15": quantity, "14": cumulative_value}}]}).to_string()
}

fn file_store(shared: &Path, key: &str) -> (Box<dyn MinuteStore>, Arc<Beacon>) {
    let written = Beacon::new();
    let store = Watched { inner: Box::new(FileMinuteStore::new(shared.to_owned(), KeyName::parse(key).unwrap())), written: written.clone() };
    (Box::new(store), written)
}

fn minute_file(shared: &Path, key: &str) -> PathBuf {
    minute_path(shared, &DAY.to_string(), key)
}

fn file_text(shared: &Path, key: &str) -> String {
    std::fs::read_to_string(minute_file(shared, key)).unwrap_or_default()
}

fn appended(shared: &Path, key: &str) -> Vec<MinuteBar> {
    file_text(shared, key).lines().skip(1).map(|line| serde_json::from_str(line).unwrap()).collect()
}

async fn wait_for_lines(shared: &Path, key: &str, count: usize, written: &Beacon) {
    written.until(&format!("분봉 줄 {count}개"), || appended(shared, key).len() >= count).await;
}

async fn flush(shared: &Path, key: &str, expected_lines: usize, written: &Beacon) {
    settle().await;
    tokio::time::advance(FLUSH_EVERY).await;
    wait_for_lines(shared, key, expected_lines, written).await;
    settle().await;
    assert_eq!(appended(shared, key).len(), expected_lines, "{}", file_text(shared, key));
}

fn latest(bars: Vec<MinuteBar>) -> HashMap<(String, Option<MinuteVenue>, u16), MinuteBar> {
    bars.into_iter().map(|bar| ((bar.symbol.clone(), bar.venue, bar.minute), bar)).collect()
}

fn expect(symbol: &str, venue: Option<MinuteVenue>, minute: u16, ohlc: [f64; 4], flow: (i64, i64, u32), seconds: (u32, u32)) -> MinuteBar {
    MinuteBar {
        symbol: symbol.to_owned(),
        instrument: if venue.is_some() { MinuteInstrument::Stock } else { MinuteInstrument::Index },
        venue,
        minute,
        open: ohlc[0],
        high: ohlc[1],
        low: ohlc[2],
        close: ohlc[3],
        volume: flow.0,
        value: flow.1,
        trades: flow.2,
        first_sec: seconds.0,
        last_sec: seconds.1,
    }
}

const KRX: Option<MinuteVenue> = Some(MinuteVenue::Krx);
const NXT: Option<MinuteVenue> = Some(MinuteVenue::Nxt);
const ALL: Option<MinuteVenue> = Some(MinuteVenue::Combined);

fn handover_ticks() -> [String; 5] {
    [
        stock("005930", "090001", "-70000", "+10", "KRX"),
        stock("005930", "090001", "+70100", "-5", "NXT"),
        stock("005930", "090001", "70050", "1", "KRX"),
        stock("005930", "090059", "-69900", "-2", "KRX"),
        stock("005930", "090030", "71000", "1", "KRX"),
    ]
}

#[tokio::test(start_paused = true)]
async fn a_hand_computed_batch_becomes_per_exchange_and_combined_one_minute_bars() {
    let folder = tempfile::tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    let (store, written) = file_store(&shared, "k1");
    let run = start(&data, "k1", store).await;
    for tick in handover_ticks() {
        run.push(&tick);
    }
    run.push(&stock("005930", "090100", "70200", "3", "NXT"));
    run.push(&index("001", "090010", "+2650.35", "100", "1000000"));
    run.push(&index("001", "090040", "+2651.10", "50", "1500000"));
    flush(&shared, "k1", 6, &written).await;
    let bars = latest(appended(&shared, "k1"));
    let want = [
        expect("005930", KRX, 540, [70000.0, 71000.0, 69900.0, 69900.0], (14, 980_850, 4), (32401, 32459)),
        expect("005930", NXT, 540, [70100.0, 70100.0, 70100.0, 70100.0], (5, 350_500, 1), (32401, 32401)),
        expect("005930", ALL, 540, [70000.0, 71000.0, 69900.0, 69900.0], (19, 1_331_350, 5), (32401, 32459)),
        expect("005930", NXT, 541, [70200.0, 70200.0, 70200.0, 70200.0], (3, 210_600, 1), (32460, 32460)),
        expect("005930", ALL, 541, [70200.0, 70200.0, 70200.0, 70200.0], (3, 210_600, 1), (32460, 32460)),
        expect("001", None, 540, [2650.35, 2651.10, 2650.35, 2651.10], (150, 500_000, 2), (32410, 32440)),
    ];
    assert_eq!(bars.len(), want.len(), "{bars:?}");
    for bar in want {
        assert_eq!(bars[&(bar.symbol.clone(), bar.venue, bar.minute)], bar);
    }
    assert!(matches!(run.stop().await, Finish::Shutdown));
}

#[tokio::test(start_paused = true)]
async fn only_bars_changed_since_the_last_tick_are_appended_and_a_later_line_replaces_an_earlier_one() {
    let folder = tempfile::tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    let (store, written) = file_store(&shared, "k1");
    let run = start(&data, "k1", store).await;
    run.push(&stock("005930", "090001", "70000", "10", "KRX"));
    run.push(&stock("000660", "090002", "200000", "1", "KRX"));
    flush(&shared, "k1", 4, &written).await;
    flush_without_change(&shared, "k1", 4).await;
    run.push(&stock("005930", "090010", "70500", "2", "KRX"));
    flush(&shared, "k1", 6, &written).await;
    let lines = appended(&shared, "k1");
    assert!(lines[4..].iter().all(|bar| bar.symbol == "005930" && bar.minute == 540), "{lines:?}");
    let replaced = latest(lines);
    assert_eq!(replaced[&("005930".to_owned(), ALL, 540)].volume, 12);
    assert_eq!(replaced[&("005930".to_owned(), ALL, 540)].close, 70500.0);
    assert_eq!(replaced[&("000660".to_owned(), ALL, 540)].volume, 1);
    let header: Value = serde_json::from_str(file_text(&shared, "k1").lines().next().unwrap()).unwrap();
    assert_eq!((header["kind"].as_str(), header["observationDate"].as_str(), header["formatVersion"].as_u64()), (Some("minute"), Some("20261123"), Some(1)));
    assert_eq!(header["sources"], json!([{"keyName": "k1", "broker": "kiwoom"}]));
    assert!(matches!(run.stop().await, Finish::Shutdown));
}

async fn flush_without_change(shared: &Path, key: &str, expected_lines: usize) {
    settle().await;
    tokio::time::advance(FLUSH_EVERY).await;
    settle().await;
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(appended(shared, key).len(), expected_lines);
}

#[tokio::test(start_paused = true)]
async fn a_restarted_child_continues_the_bars_from_the_file_of_the_day() {
    let folder = tempfile::tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    let (first_store, first_written) = file_store(&shared, "k1");
    let first = start(&data, "k1", first_store).await;
    first.push(&stock("005930", "090001", "70000", "10", "KRX"));
    first.push(&stock("005930", "090030", "70400", "4", "KRX"));
    flush(&shared, "k1", 2, &first_written).await;
    assert!(matches!(first.stop().await, Finish::Shutdown));

    let (second_store, second_written) = file_store(&shared, "k1");
    let second = start(&data, "k1", second_store).await;
    second.push(&stock("005930", "090045", "69800", "6", "KRX"));
    second.push(&stock("005930", "090100", "69900", "1", "KRX"));
    flush(&shared, "k1", 6, &second_written).await;
    let bars = latest(appended(&shared, "k1"));
    let continued = &bars[&("005930".to_owned(), KRX, 540)];
    assert_eq!(*continued, expect("005930", KRX, 540, [70000.0, 70400.0, 69800.0, 69800.0], (20, 700_000 + 281_600 + 418_800, 3), (32401, 32445)));
    let combined = &bars[&("005930".to_owned(), ALL, 540)];
    assert_eq!((combined.volume, combined.trades), (20, 3));
    assert_eq!(bars[&("005930".to_owned(), KRX, 541)].volume, 1);
    assert_eq!(file_text(&shared, "k1").lines().filter(|line| line.contains("formatVersion")).count(), 1, "머리 줄은 한 번만 있다");
    assert!(matches!(second.stop().await, Finish::Shutdown));
}

#[tokio::test(start_paused = true)]
async fn a_minute_split_between_two_key_files_merges_to_the_hand_computed_bar() {
    let folder = tempfile::tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    let ticks = handover_ticks();
    let (before_store, before_written) = file_store(&shared, "k1");
    let before = start(&data, "k1", before_store).await;
    for tick in &ticks[..2] {
        before.push(tick);
    }
    before.push(&ticks[4]);
    flush(&shared, "k1", 3, &before_written).await;
    assert!(matches!(before.stop().await, Finish::Shutdown));
    let (after_store, after_written) = file_store(&shared, "k2");
    let after = start(&data, "k2", after_store).await;
    after.push(&ticks[2]);
    after.push(&ticks[3]);
    flush(&shared, "k2", 2, &after_written).await;
    assert!(matches!(after.stop().await, Finish::Shutdown));

    let from_first = latest(appended(&shared, "k1"));
    let from_second = latest(appended(&shared, "k2"));
    let merged_krx = from_first[&("005930".to_owned(), KRX, 540)].merged_with(&from_second[&("005930".to_owned(), KRX, 540)]).unwrap();
    assert_eq!(merged_krx, expect("005930", KRX, 540, [70000.0, 71000.0, 69900.0, 69900.0], (14, 980_850, 4), (32401, 32459)));
    let merged_all = from_first[&("005930".to_owned(), ALL, 540)].merged_with(&from_second[&("005930".to_owned(), ALL, 540)]).unwrap();
    assert_eq!(merged_all, expect("005930", ALL, 540, [70000.0, 71000.0, 69900.0, 69900.0], (19, 1_331_350, 5), (32401, 32459)));
}

struct Gate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
    arrivals: Arc<Beacon>,
}

impl Gate {
    fn new() -> Arc<Gate> {
        Arc::new(Gate { state: Mutex::new((true, false)), changed: Condvar::new(), arrivals: Beacon::new() })
    }

    fn arrived(&self) -> bool {
        self.state.lock().unwrap().1
    }

    async fn until_arrived(&self) {
        self.arrivals.until("집계가 붙잡힌다", || self.arrived()).await;
    }

    fn release(&self) {
        self.state.lock().unwrap().0 = false;
        self.changed.notify_all();
    }
}

struct ReleaseOnDrop(Arc<Gate>);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

struct HeldStore {
    inner: Box<dyn MinuteStore>,
    gate: Arc<Gate>,
}

impl Drop for HeldStore {
    fn drop(&mut self) {
        self.gate.arrivals.close();
    }
}

impl MinuteStore for HeldStore {
    fn load(&mut self, date: u32) -> io::Result<Vec<MinuteBar>> {
        self.inner.load(date)
    }

    fn append(&mut self, date: u32, bars: &[MinuteBar], as_of: i64) -> io::Result<()> {
        let mut state = self.gate.state.lock().unwrap();
        state.1 = true;
        self.gate.changed.notify_all();
        self.gate.arrivals.ring();
        while state.0 {
            state = self.gate.changed.wait(state).unwrap();
        }
        drop(state);
        self.inner.append(date, bars, as_of)
    }

    fn finish(&mut self) -> io::Result<()> {
        self.inner.finish()
    }
}

fn raw_realtime_frames(data: &Path) -> usize {
    read_day(data, DAY).unwrap().filter(|item| matches!(item, RawItem::Record(record) if matches!(&record.content, RawContent::Frame(text) if text.contains("\"REAL\"")))).count()
}

#[tokio::test(start_paused = true)]
async fn a_held_aggregation_leaves_raw_writing_complete() {
    let folder = tempfile::tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    let gate = Gate::new();
    let _release_on_failure = ReleaseOnDrop(gate.clone());
    let held = HeldStore { inner: file_store(&shared, "k1").0, gate: gate.clone() };
    let run = start(&data, "k1", Box::new(held)).await;
    run.push(&stock("005930", "090001", "70000", "10", "KRX"));
    settle().await;
    tokio::time::advance(FLUSH_EVERY).await;
    gate.until_arrived().await;
    assert!(gate.arrived(), "집계가 붙잡혔다");
    run.push(&json!({"trnm": "REAL", "data": [{"type": "0D", "item": "005930_AL", "values": {"21": "090001"}}]}).to_string());
    let burst = 20_000;
    for number in 0..burst {
        run.push(&stock("005930", "090002", "70000", "1", if number % 2 == 0 { "KRX" } else { "NXT" }));
    }
    settle().await;
    assert!(gate.arrived(), "붙잡힌 채로 원문이 계속 들어온다");
    let stopping = tokio::spawn(run.stop());
    settle().await;
    tokio::time::advance(Duration::from_secs(10)).await;
    assert!(matches!(stopping.await.unwrap(), Finish::Shutdown));
    gate.release();
    assert_eq!(raw_realtime_frames(&data), 1 + 1 + burst, "집계가 멈춘 동안에도 원문은 한 줄도 빠지지 않는다");
}

#[tokio::test(start_paused = true)]
async fn a_full_aggregation_queue_drops_frames_on_the_aggregation_side_and_counts_them() {
    let folder = tempfile::tempdir().unwrap();
    let shared = folder.path().join("shared");
    let gate = Gate::new();
    let _release_on_failure = ReleaseOnDrop(gate.clone());
    let held = HeldStore { inner: file_store(&shared, "k1").0, gate: gate.clone() };
    let (feed, worker) = spawn(Box::new(held), DAY_START_MS + 9 * 3_600_000);
    let stats = worker.stats();
    let frame = tokio_tungstenite::tungstenite::Utf8Bytes::from(stock("005930", "090001", "70000", "1", "KRX"));
    feed.offer(DAY_START_MS, &frame);
    settle().await;
    tokio::time::advance(FLUSH_EVERY).await;
    gate.until_arrived().await;
    assert!(gate.arrived());
    assert_eq!(stats.ticks(), 1);
    let capacity = 16_384;
    for _ in 0..capacity + 25 {
        feed.offer(DAY_START_MS, &frame);
    }
    assert_eq!(stats.dropped(), 25);
    drop(feed);
    gate.release();
    worker.finish().await;
    assert_eq!(stats.ticks(), 1 + capacity as u64);
    assert_eq!(appended(&shared, "k1").iter().filter(|bar| bar.venue == ALL).map(|bar| bar.volume).next_back(), Some(1 + capacity as i64));
}

#[tokio::test(start_paused = true)]
async fn a_wait_with_no_new_write_signal_fails_naming_what_it_waited_for() {
    use futures::FutureExt;
    let folder = tempfile::tempdir().unwrap();
    let shared = folder.path().join("shared");
    let gate = Gate::new();
    let _release_on_failure = ReleaseOnDrop(gate.clone());
    let held = HeldStore { inner: file_store(&shared, "k1").0, gate: gate.clone() };
    let written = Beacon::new();
    let watched = Watched { inner: Box::new(held), written: written.clone() };
    let (feed, worker) = spawn(Box::new(watched), DAY_START_MS + 9 * 3_600_000);
    let frame = tokio_tungstenite::tungstenite::Utf8Bytes::from(stock("005930", "090001", "70000", "1", "KRX"));
    feed.offer(DAY_START_MS, &frame);
    settle().await;
    tokio::time::advance(FLUSH_EVERY).await;
    gate.until_arrived().await;
    let waiting = written.until_within("분봉 줄 1개", Duration::from_millis(200), || !appended(&shared, "k1").is_empty());
    let failure = std::panic::AssertUnwindSafe(waiting).catch_unwind().await.expect_err("붙잡힌 쓰기를 기다리면 실패해야 한다");
    let message = failure.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(message.contains("새 신호가 없다") && message.contains("분봉 줄 1개"), "{message}");
    drop(feed);
    gate.release();
    worker.finish().await;
}

fn book(item: &str, time: &str, best_ask_qty: i64) -> String {
    let mut values = serde_json::Map::new();
    values.insert("21".to_owned(), json!(time));
    for index in 0..10 {
        values.insert((41 + index).to_string(), json!(format!("+{}", 10_100 + index * 100)));
        values.insert((51 + index).to_string(), json!(format!("-{}", 10_000 - index * 100)));
        for (fid, qty) in [(61, best_ask_qty), (6044, best_ask_qty), (71, 5), (6054, 5)] {
            values.insert((fid + index).to_string(), json!(qty.to_string()));
        }
    }
    json!({"trnm": "REAL", "data": [{"type": "0D", "item": format!("{item}_AL"), "name": "주식호가잔량", "values": values}]}).to_string()
}

#[tokio::test(start_paused = true)]
async fn the_session_feeds_books_to_the_quote_minutes() {
    let folder = tempfile::tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    let (store, _written) = file_store(&shared, "k1");
    let run = start_with_quotes(&data, "k1", store, Some(shared.clone())).await;
    let frames = [book("005930", "090001", 7), book("005930", "090059", 9), book("005930", "090100", 11)];
    frames.iter().for_each(|frame| run.push(frame));
    let quotes = || server::shared_data::read_quote_day(&shared, &DAY.to_string(), "005930").unwrap();
    for _ in 0..200 {
        settle().await;
        if quotes().is_some_and(|day| day.minutes.len() == 2) {
            break;
        }
        tokio::time::advance(FLUSH_EVERY).await;
        tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(2))).await.unwrap();
    }
    let day = quotes().expect("분 호가 파일이 있다");
    let shown: Vec<(u16, i64)> = day.minutes.iter().map(|minute| (minute.minute, minute.combined.close.ask_total())).collect();
    assert_eq!(shown, [(540, 90), (541, 110)]);
    assert!(!day.closed);
    assert!(matches!(run.stop().await, Finish::Shutdown));
    let raw: Vec<String> = read_day(&data, DAY)
        .unwrap()
        .filter_map(|item| match item {
            RawItem::Record(record) => match record.content {
                RawContent::Frame(text) if text.contains("\"0D\"") => Some(text.to_string()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(raw, frames);
}
