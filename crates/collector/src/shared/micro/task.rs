use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use domain::MicroEventDetector;
use server::shared_data::FlowRow;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Utf8Bytes;

use super::read::{MicroInput, mentions_micro_type, read_micro_frame};
use super::{MICRO_FIDS, MICRO_TYPE_CODE, event_to_flow_row};
use crate::kst::KstTime;
use crate::shared::flow::FileFlowStore;
use crate::shared::live_tap::{BlockingStore, INPUT_CAPACITY, REPORT_EVERY, delayed_interval, finish_task};

pub const FLUSH_EVERY: Duration = Duration::from_secs(1);
const MAX_PENDING_ROWS_PER_STREAM: usize = 16_384;
const MAX_TRACKED_SYMBOLS: usize = 4_096;
const SYMBOL_IDLE_EVICT_MS: i64 = 10 * 60 * 1_000;

#[derive(Debug, Default)]
pub struct MicroStats {
    dropped: AtomicU64,
    books: AtomicU64,
    trades: AtomicU64,
    events: AtomicU64,
    blocks: AtomicU64,
    evicted: AtomicU64,
    skipped: AtomicU64,
    unreadable: AtomicU64,
    store_errors: AtomicU64,
}

impl MicroStats {
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn events(&self) -> u64 {
        self.events.load(Ordering::Relaxed)
    }

    pub fn blocks(&self) -> u64 {
        self.blocks.load(Ordering::Relaxed)
    }

    pub fn books(&self) -> u64 {
        self.books.load(Ordering::Relaxed)
    }

    pub fn trades(&self) -> u64 {
        self.trades.load(Ordering::Relaxed)
    }

    fn add(counter: &AtomicU64, count: u64) {
        counter.fetch_add(count, Ordering::Relaxed);
    }
}

enum Input {
    Frame { recv_ms: i64, text: Utf8Bytes },
    Link { live: bool },
}

#[derive(Clone)]
pub struct MicroFeed {
    input: mpsc::Sender<Input>,
    stats: Arc<MicroStats>,
}

impl MicroFeed {
    pub fn offer(&self, recv_ms: i64, text: &Utf8Bytes) {
        if !mentions_micro_type(text.as_str()) {
            return;
        }
        if self.input.try_send(Input::Frame { recv_ms, text: text.clone() }).is_err() {
            MicroStats::add(&self.stats.dropped, 1);
        }
    }

    pub fn link(&self, _recv_ms: i64, live: bool) {
        if self.input.try_send(Input::Link { live }).is_err() {
            MicroStats::add(&self.stats.dropped, 1);
        }
    }
}

pub struct MicroWorker {
    task: JoinHandle<()>,
    stats: Arc<MicroStats>,
}

impl MicroWorker {
    pub fn stats(&self) -> Arc<MicroStats> {
        self.stats.clone()
    }

    pub async fn finish(self) {
        finish_task(self.task, "미시 이벤트 감지가 정한 시간 안에 끝나지 않아 멈춥니다").await;
    }
}

pub fn spawn(store: FileFlowStore, now_ms: i64) -> (MicroFeed, MicroWorker) {
    let (input, receiver) = mpsc::channel(INPUT_CAPACITY);
    let stats = Arc::new(MicroStats::default());
    let task = tokio::spawn(run(receiver, store, stats.clone(), now_ms));
    (MicroFeed { input, stats: stats.clone() }, MicroWorker { task, stats })
}

struct SymbolState {
    detector: MicroEventDetector,
    last_seen_ms: i64,
}

struct PendingBatch {
    date: u32,
    symbol: String,
    rows: Vec<FlowRow>,
}

struct Runner {
    store: BlockingStore<FileFlowStore>,
    current_date: u32,
    symbols: HashMap<String, SymbolState>,
    pending: BTreeMap<(u32, String), VecDeque<FlowRow>>,
    stats: Arc<MicroStats>,
}

async fn run(mut receiver: mpsc::Receiver<Input>, store: FileFlowStore, stats: Arc<MicroStats>, now_ms: i64) {
    let mut flush = delayed_interval(FLUSH_EVERY);
    let mut report = delayed_interval(REPORT_EVERY);
    let mut runner = Runner {
        store: BlockingStore::new(store),
        current_date: KstTime::from_unix_ms(now_ms).date,
        symbols: HashMap::new(),
        pending: BTreeMap::new(),
        stats,
    };
    loop {
        tokio::select! {
            received = receiver.recv() => match received {
                Some(item) => {
                    runner.take(item);
                    for _ in 0..63 {
                        match receiver.try_recv() {
                            Ok(next) => runner.take(next),
                            Err(_) => break,
                        }
                    }
                }
                None => break,
            },
            _ = flush.tick() => {
                runner.take_queued(&mut receiver);
                runner.flush().await;
            }
            _ = report.tick() => runner.report(),
        }
    }
    runner.flush().await;
}

impl Runner {
    fn take(&mut self, item: Input) {
        match item {
            Input::Frame { recv_ms, text } => self.take_frame(recv_ms, text),
            Input::Link { live: false } => self.symbols.clear(),
            Input::Link { live: true } => {}
        }
    }

    fn take_queued(&mut self, receiver: &mut mpsc::Receiver<Input>) {
        for _ in 0..receiver.len() {
            match receiver.try_recv() {
                Ok(item) => self.take(item),
                Err(_) => break,
            }
        }
    }

    fn take_frame(&mut self, recv_ms: i64, text: Utf8Bytes) {
        let date = KstTime::from_unix_ms(recv_ms).date;
        if date != self.current_date {
            self.current_date = date;
            self.symbols.clear();
        }
        let symbols = &mut self.symbols;
        let pending = &mut self.pending;
        let stats = &self.stats;
        let result = read_micro_frame(text.as_str(), |input| match input {
            MicroInput::Trade { code, price_won, signed_qty } => {
                if let Some(state) = symbol_state(symbols, code, recv_ms) {
                    state.detector.on_trade(recv_ms, price_won, signed_qty);
                }
            }
            MicroInput::Book { code, asks, bids } => {
                if let Some(state) = symbol_state(symbols, code, recv_ms) {
                    let (events, _) = state.detector.on_book(recv_ms, asks, bids);
                    if !events.is_empty() {
                        MicroStats::add(&stats.events, events.len() as u64);
                        let queue = pending.entry((date, code.to_owned())).or_default();
                        for event in events {
                            if queue.len() >= MAX_PENDING_ROWS_PER_STREAM {
                                queue.pop_front();
                                MicroStats::add(&stats.evicted, 1);
                            }
                            queue.push_back(event_to_flow_row(event));
                        }
                    }
                }
            }
        });
        match result {
            Ok(reading) => {
                MicroStats::add(&stats.books, reading.books);
                MicroStats::add(&stats.trades, reading.trades);
                MicroStats::add(&stats.skipped, reading.skipped);
            }
            Err(_) => MicroStats::add(&stats.unreadable, 1),
        }
    }

    async fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let batches: Vec<PendingBatch> = std::mem::take(&mut self.pending)
            .into_iter()
            .filter(|(_, rows)| !rows.is_empty())
            .map(|((date, symbol), rows)| PendingBatch { date, symbol, rows: rows.into_iter().collect() })
            .collect();
        if batches.is_empty() {
            return;
        }
        let outcome = self
            .store
            .run(
                move |store| {
                    let mut written = 0u64;
                    let mut failed = Vec::new();
                    for batch in batches {
                        match store.append_rows(batch.date, MICRO_TYPE_CODE, &batch.symbol, &MICRO_FIDS, &batch.rows) {
                            Ok(()) => written += 1,
                            Err(error) => {
                                tracing::warn!(%error, date = batch.date, symbol = %batch.symbol, "미시 이벤트 블록을 쓰지 못했습니다. 다음 주기에 다시 시도합니다");
                                failed.push(batch);
                            }
                        }
                    }
                    (written, failed)
                },
                "미시 이벤트 파일 작업이 멈춰 쓰기를 그만둡니다",
            )
            .await;
        if let Some((written, failed)) = outcome {
            MicroStats::add(&self.stats.blocks, written);
            if !failed.is_empty() {
                MicroStats::add(&self.stats.store_errors, failed.len() as u64);
                for batch in failed {
                    let queue = self.pending.entry((batch.date, batch.symbol)).or_default();
                    for row in batch.rows.into_iter().rev() {
                        queue.push_front(row);
                    }
                    while queue.len() > MAX_PENDING_ROWS_PER_STREAM {
                        queue.pop_front();
                        MicroStats::add(&self.stats.evicted, 1);
                    }
                }
            }
        }
    }

    fn report(&self) {
        let stats = &self.stats;
        tracing::info!(
            books = stats.books.load(Ordering::Relaxed),
            trades = stats.trades.load(Ordering::Relaxed),
            events = stats.events.load(Ordering::Relaxed),
            blocks = stats.blocks.load(Ordering::Relaxed),
            dropped = stats.dropped.load(Ordering::Relaxed),
            evicted = stats.evicted.load(Ordering::Relaxed),
            skipped = stats.skipped.load(Ordering::Relaxed),
            unreadable = stats.unreadable.load(Ordering::Relaxed),
            store_errors = stats.store_errors.load(Ordering::Relaxed),
            "미시 이벤트 감지 누계"
        );
    }
}

fn symbol_state<'a>(symbols: &'a mut HashMap<String, SymbolState>, code: &str, recv_ms: i64) -> Option<&'a mut SymbolState> {
    if symbols.contains_key(code) {
        let existing = symbols.get_mut(code)?;
        existing.last_seen_ms = recv_ms;
        return Some(existing);
    }
    if symbols.len() >= MAX_TRACKED_SYMBOLS {
        let cutoff = recv_ms.saturating_sub(SYMBOL_IDLE_EVICT_MS);
        symbols.retain(|_, state| state.last_seen_ms > cutoff);
    }
    if symbols.len() >= MAX_TRACKED_SYMBOLS {
        return None;
    }
    symbols.insert(code.to_owned(), SymbolState { detector: MicroEventDetector::default(), last_seen_ms: recv_ms });
    symbols.get_mut(code)
}
