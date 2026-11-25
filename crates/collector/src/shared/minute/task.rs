use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Utf8Bytes;

use super::read::{RawTick, mentions_minute_type, read_ticks};
use super::state::{Applied, Day};
use super::store::MinuteStore;
use crate::kst::KstTime;
use crate::shared::live_tap::{BlockingStore, INPUT_CAPACITY, REPORT_EVERY, delayed_interval, finish_task};

pub const FLUSH_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct MinuteStats {
    dropped: AtomicU64,
    ticks: AtomicU64,
    skipped: AtomicU64,
    unreadable: AtomicU64,
    too_late: AtomicU64,
    lines: AtomicU64,
    store_errors: AtomicU64,
}

impl MinuteStats {
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn ticks(&self) -> u64 {
        self.ticks.load(Ordering::Relaxed)
    }

    pub fn lines(&self) -> u64 {
        self.lines.load(Ordering::Relaxed)
    }

    pub fn store_errors(&self) -> u64 {
        self.store_errors.load(Ordering::Relaxed)
    }

    fn add(counter: &AtomicU64, count: u64) {
        counter.fetch_add(count, Ordering::Relaxed);
    }
}

struct Frame {
    recv_ms: i64,
    text: Utf8Bytes,
}

#[derive(Clone)]
pub struct MinuteFeed {
    input: mpsc::Sender<Frame>,
    stats: Arc<MinuteStats>,
}

impl MinuteFeed {
    pub fn offer(&self, recv_ms: i64, text: &Utf8Bytes) {
        if !mentions_minute_type(text.as_str()) {
            return;
        }
        if self.input.try_send(Frame { recv_ms, text: text.clone() }).is_err() {
            MinuteStats::add(&self.stats.dropped, 1);
        }
    }
}

pub struct MinuteWorker {
    task: JoinHandle<()>,
    stats: Arc<MinuteStats>,
}

impl MinuteWorker {
    pub fn stats(&self) -> Arc<MinuteStats> {
        self.stats.clone()
    }

    pub async fn finish(self) {
        finish_task(self.task, "분봉 집계가 정한 시간 안에 끝나지 않아 멈춥니다").await;
    }
}

pub fn spawn(store: Box<dyn MinuteStore>, now_ms: i64) -> (MinuteFeed, MinuteWorker) {
    let (input, frames) = mpsc::channel(INPUT_CAPACITY);
    let stats = Arc::new(MinuteStats::default());
    let task = tokio::spawn(run(frames, store, stats.clone(), now_ms));
    (MinuteFeed { input, stats: stats.clone() }, MinuteWorker { task, stats })
}

pub(crate) struct Aggregator {
    store: BlockingStore<Box<dyn MinuteStore>>,
    day: Option<Day>,
    as_of_ms: i64,
    stats: Arc<MinuteStats>,
}

async fn run(mut frames: mpsc::Receiver<Frame>, store: Box<dyn MinuteStore>, stats: Arc<MinuteStats>, now_ms: i64) {
    let mut flush = delayed_interval(FLUSH_EVERY);
    let mut report = delayed_interval(REPORT_EVERY);
    let mut aggregator = Aggregator::new(store, now_ms, stats);
    aggregator.open_day(KstTime::from_unix_ms(now_ms).date).await;
    loop {
        tokio::select! {
            received = frames.recv() => match received {
                Some(frame) => aggregator.take(frame).await,
                None => break,
            },
            _ = flush.tick() => {
                aggregator.take_queued(&mut frames).await;
                aggregator.flush().await;
            }
            _ = report.tick() => aggregator.report(),
        }
    }
    aggregator.flush().await;
    aggregator.finish().await;
}

impl Aggregator {
    pub(crate) fn new(store: Box<dyn MinuteStore>, now_ms: i64, stats: Arc<MinuteStats>) -> Aggregator {
        Aggregator { store: BlockingStore::new(store), day: None, as_of_ms: now_ms, stats }
    }

    async fn with_store<T: Send + 'static>(&mut self, work: impl FnOnce(&mut dyn MinuteStore) -> T + Send + 'static) -> Option<T> {
        self.store
            .run(move |store| work(store.as_mut()), "분봉 파일 작업이 멈춰 이 자식의 분봉 집계를 그만둡니다")
            .await
    }

    pub(crate) async fn open_day(&mut self, date: u32) {
        let loaded = self.with_store(move |store| store.load(date)).await;
        let bars = match loaded {
            Some(Ok(bars)) => bars,
            Some(Err(error)) => {
                tracing::warn!(%error, date, "그날 분봉 파일을 읽지 못해 빈 상태로 시작합니다");
                MinuteStats::add(&self.stats.store_errors, 1);
                Vec::new()
            }
            None => Vec::new(),
        };
        self.day = Some(Day::resumed(date, bars));
    }

    pub(crate) async fn prepare_day(&mut self, recv_ms: i64) {
        let date = KstTime::from_unix_ms(recv_ms).date;
        if self.day.as_ref().is_none_or(|day| day.date() != date) {
            self.flush().await;
            self.open_day(date).await;
        }
        self.as_of_ms = self.as_of_ms.max(recv_ms);
    }

    pub(crate) fn apply_tick(&mut self, tick: &RawTick<'_>) {
        let Some(day) = self.day.as_mut() else { return };
        match day.apply(tick) {
            Applied::Counted => MinuteStats::add(&self.stats.ticks, 1),
            Applied::TooLate => MinuteStats::add(&self.stats.too_late, 1),
        }
    }

    pub(crate) fn record_skipped(&self, count: u64) {
        MinuteStats::add(&self.stats.skipped, count);
    }

    pub(crate) fn record_unreadable(&self) {
        MinuteStats::add(&self.stats.unreadable, 1);
    }

    pub(crate) fn record_dropped(&self, count: u64) {
        MinuteStats::add(&self.stats.dropped, count);
    }

    async fn take(&mut self, frame: Frame) {
        self.prepare_day(frame.recv_ms).await;
        let read = read_ticks(frame.text.as_str(), |tick| self.apply_tick(&tick));
        match read {
            Ok(reading) => self.record_skipped(reading.skipped),
            Err(_) => self.record_unreadable(),
        }
    }

    async fn take_queued(&mut self, frames: &mut mpsc::Receiver<Frame>) {
        for _ in 0..frames.len() {
            match frames.try_recv() {
                Ok(frame) => self.take(frame).await,
                Err(_) => break,
            }
        }
    }

    pub(crate) async fn flush(&mut self) {
        let Some(day) = self.day.as_ref() else {
            return;
        };
        let bars = day.dirty_bars();
        if bars.is_empty() {
            return;
        }
        let (date, as_of, count) = (day.date(), self.as_of_ms.div_euclid(1000), bars.len() as u64);
        match self.with_store(move |store| store.append(date, &bars, as_of)).await {
            Some(Ok(())) => {
                MinuteStats::add(&self.stats.lines, count);
                if let Some(day) = self.day.as_mut() {
                    day.settle();
                }
            }
            Some(Err(error)) => {
                tracing::warn!(%error, date, "분봉을 파일에 덧붙이지 못했습니다. 다음 5초에 다시 시도합니다");
                MinuteStats::add(&self.stats.store_errors, 1);
            }
            None => {}
        }
    }

    pub(crate) async fn finish(&mut self) {
        if let Some(Err(error)) = self.with_store(|store| store.finish()).await {
            tracing::warn!(%error, "분봉 파일을 동기화하지 못했습니다");
        }
    }

    pub(crate) fn report(&self) {
        let stats = &self.stats;
        tracing::info!(
            ticks = stats.ticks.load(Ordering::Relaxed),
            lines = stats.lines.load(Ordering::Relaxed),
            dropped = stats.dropped.load(Ordering::Relaxed),
            skipped = stats.skipped.load(Ordering::Relaxed),
            unreadable = stats.unreadable.load(Ordering::Relaxed),
            too_late = stats.too_late.load(Ordering::Relaxed),
            store_errors = stats.store_errors.load(Ordering::Relaxed),
            "분봉 집계 누계"
        );
    }
}
