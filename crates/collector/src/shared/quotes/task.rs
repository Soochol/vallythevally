use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use server::shared_data::{CurrentQuotes, LiveQuoteWriter, QuoteMinute};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, timeout};
use tokio_tungstenite::tungstenite::Utf8Bytes;

use super::read::{mentions_quote_type, read_books};
use super::state::{Applied, LiveQuotes};
use crate::kst::KstTime;
use crate::protocol::KeyName;

pub const FLUSH_EVERY: Duration = Duration::from_secs(5);
const REPORT_EVERY: Duration = Duration::from_secs(60);
const INPUT_CAPACITY: usize = 16_384;
const DRAIN_LIMIT: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct QuoteStats {
    books: AtomicU64,
    too_late: AtomicU64,
    dropped: AtomicU64,
    store_errors: AtomicU64,
    skipped: AtomicU64,
    unreadable: AtomicU64,
    minutes: AtomicU64,
    gaps: AtomicU64,
}

impl QuoteStats {
    pub fn books(&self) -> u64 {
        self.books.load(Ordering::Relaxed)
    }

    pub fn too_late(&self) -> u64 {
        self.too_late.load(Ordering::Relaxed)
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
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

enum Signal {
    Down { recv_ms: i64 },
    Live { recv_ms: i64 },
}

#[derive(Clone)]
pub struct QuoteFeed {
    frames: mpsc::Sender<Frame>,
    signals: mpsc::UnboundedSender<Signal>,
    stats: Arc<QuoteStats>,
}

impl QuoteFeed {
    pub fn offer(&self, recv_ms: i64, text: &Utf8Bytes) {
        if !mentions_quote_type(text.as_str()) {
            return;
        }
        if self.frames.try_send(Frame { recv_ms, text: text.clone() }).is_err() {
            QuoteStats::add(&self.stats.dropped, 1);
        }
    }

    pub fn link_down(&self, recv_ms: i64) {
        let _ = self.signals.send(Signal::Down { recv_ms });
    }

    pub fn link_live(&self, recv_ms: i64) {
        let _ = self.signals.send(Signal::Live { recv_ms });
    }
}

pub struct QuoteWorker {
    task: JoinHandle<()>,
    stats: Arc<QuoteStats>,
}

impl QuoteWorker {
    pub fn stats(&self) -> Arc<QuoteStats> {
        self.stats.clone()
    }

    pub async fn finish(self) {
        let abort = self.task.abort_handle();
        if timeout(DRAIN_LIMIT, self.task).await.is_err() {
            abort.abort();
            tracing::warn!("분 호가 집계가 정한 시간 안에 끝나지 않아 멈춥니다");
        }
    }
}

pub fn spawn(shared_dir: PathBuf, key: KeyName, now_ms: i64) -> (QuoteFeed, QuoteWorker) {
    let (frames_tx, frames_rx) = mpsc::channel(INPUT_CAPACITY);
    let (signals_tx, signals_rx) = mpsc::unbounded_channel();
    let stats = Arc::new(QuoteStats::default());
    let store = QuoteStore::new(shared_dir, key);
    let task = tokio::spawn(run(frames_rx, signals_rx, store, stats.clone(), now_ms));
    (QuoteFeed { frames: frames_tx, signals: signals_tx, stats: stats.clone() }, QuoteWorker { task, stats })
}

struct QuoteStore {
    shared_dir: PathBuf,
    key: KeyName,
    open: Option<(u32, LiveQuoteWriter)>,
}

struct FlushResult {
    minutes_written: usize,
    gaps_written: usize,
    current_written: bool,
    error: Option<io::Error>,
}

impl QuoteStore {
    fn new(shared_dir: PathBuf, key: KeyName) -> QuoteStore {
        QuoteStore { shared_dir, key, open: None }
    }

    fn writer_for(&mut self, date: u32, as_of: i64) -> io::Result<&mut LiveQuoteWriter> {
        if self.open.as_ref().is_none_or(|(open_date, _)| *open_date != date) {
            let writer = LiveQuoteWriter::open(&self.shared_dir, &date.to_string(), self.key.as_str(), as_of)?;
            self.open = Some((date, writer));
        }
        Ok(&mut self.open.as_mut().expect("방금 열었다").1)
    }

    fn load(&mut self, date: u32, as_of: i64) -> io::Result<CurrentQuotes> {
        let result = self.writer_for(date, as_of).and_then(|writer| writer.load_current());
        if result.is_err() {
            self.open = None;
        }
        result
    }

    fn flush(
        &mut self,
        date: u32,
        as_of: i64,
        pending_minutes: &[(String, QuoteMinute)],
        pending_gaps: &[(u32, u32)],
        current: Option<&CurrentQuotes>,
    ) -> FlushResult {
        let writer = match self.writer_for(date, as_of) {
            Ok(writer) => writer,
            Err(error) => {
                self.open = None;
                return FlushResult { minutes_written: 0, gaps_written: 0, current_written: false, error: Some(error) };
            }
        };
        let mut minutes_written = 0;
        for (code, minute) in pending_minutes {
            if let Err(error) = writer.append_minute(code, minute) {
                self.open = None;
                return FlushResult { minutes_written, gaps_written: 0, current_written: false, error: Some(error) };
            }
            minutes_written += 1;
        }
        let mut gaps_written = 0;
        for &(from_sec, to_sec) in pending_gaps {
            if let Err(error) = writer.append_gap(from_sec, to_sec) {
                self.open = None;
                return FlushResult { minutes_written, gaps_written, current_written: false, error: Some(error) };
            }
            gaps_written += 1;
        }
        if let Some(current) = current {
            if let Err(error) = writer.write_current(current, as_of) {
                self.open = None;
                return FlushResult { minutes_written, gaps_written, current_written: false, error: Some(error) };
            }
            return FlushResult { minutes_written, gaps_written, current_written: true, error: None };
        }
        FlushResult { minutes_written, gaps_written, current_written: false, error: None }
    }

    fn sync(&mut self) -> io::Result<()> {
        match self.open.take() {
            Some((_, writer)) => writer.sync(),
            None => Ok(()),
        }
    }
}

struct Aggregator {
    store: Option<QuoteStore>,
    day: Option<LiveQuotes>,
    now_sec: u32,
    as_of_ms: i64,
    down_since: Option<u32>,
    pending_gaps: Vec<(u32, u32)>,
    stats: Arc<QuoteStats>,
}

async fn run(
    mut frames: mpsc::Receiver<Frame>,
    mut signals: mpsc::UnboundedReceiver<Signal>,
    store: QuoteStore,
    stats: Arc<QuoteStats>,
    now_ms: i64,
) {
    let mut flush = interval_at(Instant::now() + FLUSH_EVERY, FLUSH_EVERY);
    let mut report = interval_at(Instant::now() + REPORT_EVERY, REPORT_EVERY);
    for tick in [&mut flush, &mut report] {
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    }
    let mut aggregator = Aggregator {
        store: Some(store),
        day: None,
        now_sec: 0,
        as_of_ms: now_ms,
        down_since: None,
        pending_gaps: Vec::new(),
        stats,
    };
    aggregator.open_day(KstTime::from_unix_ms(now_ms).date).await;
    let mut frames_open = true;
    let mut signals_open = true;
    while frames_open || signals_open {
        tokio::select! {
            received = frames.recv(), if frames_open => match received {
                Some(frame) => aggregator.take_frame(frame).await,
                None => frames_open = false,
            },
            received = signals.recv(), if signals_open => match received {
                Some(signal) => aggregator.take_signal(signal).await,
                None => signals_open = false,
            },
            _ = flush.tick() => {
                aggregator.take_queued(&mut frames, &mut signals).await;
                aggregator.flush().await;
            }
            _ = report.tick() => aggregator.report(),
        }
    }
    aggregator.drain_signals(&mut signals).await;
    aggregator.flush().await;
    aggregator.finish().await;
}

impl Aggregator {
    async fn with_store<T: Send + 'static>(&mut self, work: impl FnOnce(&mut QuoteStore) -> T + Send + 'static) -> Option<T> {
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
                tracing::error!(%error, "분 호가 파일 작업이 멈춰 이 자식의 분 호가 집계를 그만둡니다");
                None
            }
        }
    }

    async fn open_day(&mut self, date: u32) {
        let as_of = self.as_of_ms.div_euclid(1000);
        let loaded = self.with_store(move |store| store.load(date, as_of)).await;
        let current = match loaded {
            Some(Ok(current)) => current,
            Some(Err(error)) => {
                tracing::warn!(%error, date, "그날 분 호가 진행 파일을 읽지 못해 빈 상태로 시작합니다");
                QuoteStats::add(&self.stats.store_errors, 1);
                CurrentQuotes::default()
            }
            None => CurrentQuotes::default(),
        };
        self.down_since = current.minutes.values().map(|quote| quote.close_sec).max();
        self.day = Some(LiveQuotes::resumed(date, current));
    }

    async fn ensure_day(&mut self, recv_ms: i64) -> KstTime {
        let kst = KstTime::from_unix_ms(recv_ms);
        if self.day.as_ref().is_none_or(|day| day.date() != kst.date) {
            if let Some(day) = self.day.as_mut() {
                day.finish_all();
            }
            self.flush().await;
            self.finish().await;
            self.now_sec = 0;
            self.down_since = None;
            self.pending_gaps.clear();
            self.as_of_ms = recv_ms;
            self.open_day(kst.date).await;
        }
        self.as_of_ms = self.as_of_ms.max(recv_ms);
        kst
    }

    async fn take_frame(&mut self, frame: Frame) {
        let kst = self.ensure_day(frame.recv_ms).await;
        self.now_sec = self.now_sec.max(kst.ms_of_day / 1000);
        let Some(day) = self.day.as_mut() else {
            return;
        };
        let stats = &self.stats;
        let read = read_books(frame.text.as_str(), |code, row| match day.take(code, row) {
            Applied::Counted => QuoteStats::add(&stats.books, 1),
            Applied::TooLate => QuoteStats::add(&stats.too_late, 1),
        });
        match read {
            Ok(reading) => QuoteStats::add(&stats.skipped, reading.skipped),
            Err(_) => QuoteStats::add(&stats.unreadable, 1),
        }
    }

    async fn take_signal(&mut self, signal: Signal) {
        match signal {
            Signal::Down { recv_ms } => {
                let kst = self.ensure_day(recv_ms).await;
                if self.down_since.is_none() {
                    self.down_since = Some(kst.ms_of_day / 1000);
                }
            }
            Signal::Live { recv_ms } => {
                let kst = self.ensure_day(recv_ms).await;
                if let Some(from_sec) = self.down_since.take() {
                    let to_sec = kst.ms_of_day / 1000;
                    if to_sec >= from_sec {
                        self.pending_gaps.push((from_sec, to_sec));
                    }
                }
            }
        }
    }

    async fn drain_signals(&mut self, signals: &mut mpsc::UnboundedReceiver<Signal>) {
        while let Ok(signal) = signals.try_recv() {
            self.take_signal(signal).await;
        }
    }

    async fn take_queued(&mut self, frames: &mut mpsc::Receiver<Frame>, signals: &mut mpsc::UnboundedReceiver<Signal>) {
        for _ in 0..frames.len() {
            match frames.try_recv() {
                Ok(frame) => self.take_frame(frame).await,
                Err(_) => break,
            }
        }
        self.drain_signals(signals).await;
    }

    async fn flush(&mut self) {
        let Some(day) = self.day.as_mut() else {
            return;
        };
        day.settle(self.now_sec);
        let pending_minutes = day.pending().to_vec();
        let pending_gaps = self.pending_gaps.clone();
        let current = day.is_current_dirty().then(|| day.current());
        if pending_minutes.is_empty() && pending_gaps.is_empty() && current.is_none() {
            return;
        }
        let date = day.date();
        let as_of = self.as_of_ms.div_euclid(1000);
        let Some(result) = self
            .with_store(move |store| store.flush(date, as_of, &pending_minutes, &pending_gaps, current.as_ref()))
            .await
        else {
            return;
        };
        if let Some(day) = self.day.as_mut() {
            day.written(result.minutes_written);
            if result.current_written {
                day.mark_current_saved();
            }
        }
        self.pending_gaps.drain(..result.gaps_written);
        QuoteStats::add(&self.stats.minutes, result.minutes_written as u64);
        QuoteStats::add(&self.stats.gaps, result.gaps_written as u64);
        if let Some(error) = result.error {
            tracing::warn!(%error, date, "분 호가를 파일에 쓰지 못했습니다. 다음 5초에 다시 시도합니다");
            QuoteStats::add(&self.stats.store_errors, 1);
        }
    }

    async fn finish(&mut self) {
        if let Some(Err(error)) = self.with_store(|store| store.sync()).await {
            tracing::warn!(%error, "분 호가 파일을 동기화하지 못했습니다");
        }
    }

    fn report(&self) {
        let stats = &self.stats;
        tracing::info!(
            books = stats.books.load(Ordering::Relaxed),
            minutes = stats.minutes.load(Ordering::Relaxed),
            gaps = stats.gaps.load(Ordering::Relaxed),
            dropped = stats.dropped.load(Ordering::Relaxed),
            skipped = stats.skipped.load(Ordering::Relaxed),
            unreadable = stats.unreadable.load(Ordering::Relaxed),
            too_late = stats.too_late.load(Ordering::Relaxed),
            store_errors = stats.store_errors.load(Ordering::Relaxed),
            "분 호가 집계 누계"
        );
    }
}
