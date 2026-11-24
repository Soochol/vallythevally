use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use server::shared_data::FlowRow;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, timeout};
use tokio_tungstenite::tungstenite::Utf8Bytes;

use super::FlowKindSpec;
use super::read::{CompiledKind, read_rows};
use super::store::{FileFlowStore, LinkEvent};
use crate::kst::KstTime;

pub const FLUSH_EVERY: Duration = Duration::from_secs(1);
const ALIVE_EVERY: Duration = Duration::from_secs(30);
const REPORT_EVERY: Duration = Duration::from_secs(60);
const INPUT_CAPACITY: usize = 16_384;
const DRAIN_LIMIT: Duration = Duration::from_secs(5);
const MAX_PENDING_ROWS_PER_STREAM: usize = 16_384;
const MAX_PENDING_LINKS: usize = 1_024;

#[derive(Debug, Default)]
pub struct FlowStats {
    dropped: AtomicU64,
    rows: AtomicU64,
    skipped: AtomicU64,
    unreadable: AtomicU64,
    blocks: AtomicU64,
    evicted: AtomicU64,
    store_errors: AtomicU64,
}

impl FlowStats {
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn rows(&self) -> u64 {
        self.rows.load(Ordering::Relaxed)
    }

    pub fn blocks(&self) -> u64 {
        self.blocks.load(Ordering::Relaxed)
    }

    pub fn evicted(&self) -> u64 {
        self.evicted.load(Ordering::Relaxed)
    }

    pub fn store_errors(&self) -> u64 {
        self.store_errors.load(Ordering::Relaxed)
    }

    fn add(counter: &AtomicU64, count: u64) {
        counter.fetch_add(count, Ordering::Relaxed);
    }
}

enum Input {
    Frame { recv_ms: i64, text: Utf8Bytes },
    Link { recv_ms: i64, live: bool },
}

#[derive(Clone)]
pub struct FlowFeed {
    input: mpsc::Sender<Input>,
    needles: Arc<Vec<String>>,
    stats: Arc<FlowStats>,
}

impl FlowFeed {
    pub fn offer(&self, recv_ms: i64, text: &Utf8Bytes) {
        let raw = text.as_str();
        if !self.needles.iter().any(|needle| raw.contains(needle.as_str())) {
            return;
        }
        if self.input.try_send(Input::Frame { recv_ms, text: text.clone() }).is_err() {
            FlowStats::add(&self.stats.dropped, 1);
        }
    }

    pub fn link(&self, recv_ms: i64, live: bool) {
        if self.input.try_send(Input::Link { recv_ms, live }).is_err() {
            FlowStats::add(&self.stats.dropped, 1);
        }
    }
}

pub struct FlowWorker {
    task: JoinHandle<()>,
    stats: Arc<FlowStats>,
}

impl FlowWorker {
    pub fn stats(&self) -> Arc<FlowStats> {
        self.stats.clone()
    }

    pub async fn finish(self) {
        let abort = self.task.abort_handle();
        if timeout(DRAIN_LIMIT, self.task).await.is_err() {
            abort.abort();
            tracing::warn!("종목 흐름 쓰기가 정한 시간 안에 끝나지 않아 멈춥니다");
        }
    }
}

pub fn spawn(kinds: &'static [FlowKindSpec], store: FileFlowStore, now_ms: i64) -> (FlowFeed, FlowWorker) {
    let (input, receiver) = mpsc::channel(INPUT_CAPACITY);
    let needles = Arc::new(kinds.iter().map(|spec| format!("\"{}\"", spec.type_code)).collect());
    let stats = Arc::new(FlowStats::default());
    let task = tokio::spawn(run(receiver, kinds, store, stats.clone(), now_ms));
    (FlowFeed { input, needles, stats: stats.clone() }, FlowWorker { task, stats })
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct StreamKey {
    date: u32,
    type_code: &'static str,
    symbol: String,
}

struct PendingStream {
    fids: &'static [u32],
    rows: VecDeque<FlowRow>,
}

struct PendingBatch {
    key: StreamKey,
    fids: &'static [u32],
    rows: Vec<FlowRow>,
}

struct Writer {
    store: Option<FileFlowStore>,
    kinds: Vec<CompiledKind>,
    pending: BTreeMap<StreamKey, PendingStream>,
    pending_links: VecDeque<(u32, i64, LinkEvent)>,
    start_ms: i64,
    started_at: Instant,
    last_ms: i64,
    stats: Arc<FlowStats>,
}

async fn run(
    mut receiver: mpsc::Receiver<Input>,
    kinds: &'static [FlowKindSpec],
    store: FileFlowStore,
    stats: Arc<FlowStats>,
    now_ms: i64,
) {
    let mut flush = interval_at(Instant::now() + FLUSH_EVERY, FLUSH_EVERY);
    let mut alive = interval_at(Instant::now() + ALIVE_EVERY, ALIVE_EVERY);
    let mut report = interval_at(Instant::now() + REPORT_EVERY, REPORT_EVERY);
    for tick in [&mut flush, &mut alive, &mut report] {
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    }
    let mut writer = Writer {
        store: Some(store),
        kinds: CompiledKind::compile_all(kinds),
        pending: BTreeMap::new(),
        pending_links: VecDeque::new(),
        start_ms: now_ms,
        started_at: Instant::now(),
        last_ms: now_ms,
        stats,
    };
    writer.record_link(now_ms, LinkEvent::Start).await;
    loop {
        tokio::select! {
            received = receiver.recv() => match received {
                Some(item) => writer.take(item).await,
                None => break,
            },
            _ = flush.tick() => {
                writer.take_queued(&mut receiver).await;
                writer.flush().await;
            }
            _ = alive.tick() => {
                let now = writer.current_ms();
                writer.record_link(now, LinkEvent::Alive).await;
            }
            _ = report.tick() => writer.report(),
        }
    }
    writer.flush().await;
    let end_ms = writer.current_ms();
    writer.record_link(end_ms, LinkEvent::End).await;
}

impl Writer {
    fn current_ms(&self) -> i64 {
        let elapsed = i64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(i64::MAX);
        self.last_ms.max(self.start_ms.saturating_add(elapsed))
    }

    async fn with_store<T: Send + 'static>(&mut self, work: impl FnOnce(&mut FileFlowStore) -> T + Send + 'static) -> Option<T> {
        let mut store = self.store.take()?;
        match tokio::task::spawn_blocking(move || {
            let output = work(&mut store);
            (store, output)
        })
        .await
        {
            Ok((store, output)) => {
                self.store = Some(store);
                Some(output)
            }
            Err(error) => {
                tracing::error!(%error, "종목 흐름 파일 작업이 멈춰 이 자식의 흐름 쓰기를 그만둡니다");
                None
            }
        }
    }

    async fn take(&mut self, item: Input) {
        match item {
            Input::Frame { recv_ms, text } => self.take_frame(recv_ms, text),
            Input::Link { recv_ms, live } => {
                self.last_ms = self.last_ms.max(recv_ms);
                let event = if live { LinkEvent::Live } else { LinkEvent::Down };
                self.record_link(recv_ms, event).await;
            }
        }
    }

    fn take_frame(&mut self, recv_ms: i64, text: Utf8Bytes) {
        self.last_ms = self.last_ms.max(recv_ms);
        let date = KstTime::from_unix_ms(recv_ms).date;
        let pending = &mut self.pending;
        let stats = &self.stats;
        let result = read_rows(text.as_str(), recv_ms, &self.kinds, |extracted| {
            let key = StreamKey { date, type_code: extracted.type_code, symbol: extracted.symbol.to_owned() };
            let stream = pending
                .entry(key)
                .or_insert_with(|| PendingStream { fids: extracted.fids, rows: VecDeque::new() });
            stream.fids = extracted.fids;
            if stream.rows.len() >= MAX_PENDING_ROWS_PER_STREAM {
                stream.rows.pop_front();
                FlowStats::add(&stats.evicted, 1);
            }
            stream.rows.push_back(extracted.row);
        });
        match result {
            Ok(reading) => {
                FlowStats::add(&stats.rows, reading.rows);
                FlowStats::add(&stats.skipped, reading.skipped);
            }
            Err(_) => FlowStats::add(&stats.unreadable, 1),
        }
    }

    async fn take_queued(&mut self, receiver: &mut mpsc::Receiver<Input>) {
        for _ in 0..receiver.len() {
            match receiver.try_recv() {
                Ok(item) => self.take(item).await,
                Err(_) => break,
            }
        }
    }

    async fn record_link(&mut self, t: i64, event: LinkEvent) {
        let date = KstTime::from_unix_ms(t).date;
        if self.pending_links.len() >= MAX_PENDING_LINKS {
            self.pending_links.pop_front();
            FlowStats::add(&self.stats.evicted, 1);
        }
        self.pending_links.push_back((date, t, event));
        self.flush_links().await;
    }

    async fn flush_links(&mut self) {
        if self.pending_links.is_empty() {
            return;
        }
        let queued: Vec<(u32, i64, LinkEvent)> = self.pending_links.drain(..).collect();
        let outcome = self
            .with_store(move |store| {
                let mut failed = Vec::new();
                for (date, t, event) in queued {
                    if let Err(error) = store.append_link(date, t, event) {
                        tracing::warn!(%error, date, ?event, "종목 흐름 연결 기록을 쓰지 못했습니다");
                        failed.push((date, t, event));
                    }
                }
                failed
            })
            .await;
        if let Some(failed) = outcome
            && !failed.is_empty()
        {
            FlowStats::add(&self.stats.store_errors, failed.len() as u64);
            for item in failed.into_iter().rev() {
                self.pending_links.push_front(item);
            }
            while self.pending_links.len() > MAX_PENDING_LINKS {
                self.pending_links.pop_front();
                FlowStats::add(&self.stats.evicted, 1);
            }
        }
    }

    async fn flush(&mut self) {
        self.flush_links().await;
        if self.pending.is_empty() {
            return;
        }
        let batches: Vec<PendingBatch> = std::mem::take(&mut self.pending)
            .into_iter()
            .filter(|(_, stream)| !stream.rows.is_empty())
            .map(|(key, stream)| PendingBatch { key, fids: stream.fids, rows: stream.rows.into_iter().collect() })
            .collect();
        if batches.is_empty() {
            return;
        }
        let outcome = self
            .with_store(move |store| {
                let mut written_blocks = 0u64;
                let mut failed = Vec::new();
                for batch in batches {
                    match store.append_rows(batch.key.date, batch.key.type_code, &batch.key.symbol, batch.fids, &batch.rows) {
                        Ok(()) => written_blocks += 1,
                        Err(error) => {
                            tracing::warn!(
                                %error,
                                date = batch.key.date,
                                type_code = batch.key.type_code,
                                symbol = %batch.key.symbol,
                                "종목 흐름 블록을 쓰지 못했습니다. 다음 주기에 다시 시도합니다"
                            );
                            failed.push(batch);
                        }
                    }
                }
                (written_blocks, failed)
            })
            .await;
        if let Some((written_blocks, failed)) = outcome {
            FlowStats::add(&self.stats.blocks, written_blocks);
            if !failed.is_empty() {
                FlowStats::add(&self.stats.store_errors, failed.len() as u64);
                for batch in failed {
                    let stream = self
                        .pending
                        .entry(batch.key)
                        .or_insert_with(|| PendingStream { fids: batch.fids, rows: VecDeque::new() });
                    for row in batch.rows.into_iter().rev() {
                        stream.rows.push_front(row);
                    }
                    while stream.rows.len() > MAX_PENDING_ROWS_PER_STREAM {
                        stream.rows.pop_front();
                        FlowStats::add(&self.stats.evicted, 1);
                    }
                }
            }
        }
    }

    fn report(&self) {
        let stats = &self.stats;
        tracing::info!(
            rows = stats.rows.load(Ordering::Relaxed),
            blocks = stats.blocks.load(Ordering::Relaxed),
            dropped = stats.dropped.load(Ordering::Relaxed),
            evicted = stats.evicted.load(Ordering::Relaxed),
            skipped = stats.skipped.load(Ordering::Relaxed),
            unreadable = stats.unreadable.load(Ordering::Relaxed),
            store_errors = stats.store_errors.load(Ordering::Relaxed),
            "종목 흐름 쓰기 누계"
        );
    }
}
