use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use server::shared_data::TradeMinuteLine;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, timeout};
use tokio_tungstenite::tungstenite::Utf8Bytes;

use super::read::{mentions_trade_type, read_trades};
use super::state::MinuteState;
use super::store::TradeMinuteStore;
use crate::collect::session::WallClock;
use crate::kst::KstTime;

const TICK_EVERY: Duration = Duration::from_secs(1);
const REPORT_EVERY: Duration = Duration::from_secs(60);
const INPUT_CAPACITY: usize = 16_384;
const DRAIN_LIMIT: Duration = Duration::from_secs(5);
const CLOSE_GRACE_MS: u32 = 1_000;
const MS_PER_MINUTE: u32 = 60_000;

#[derive(Debug, Default)]
pub struct TradeMinuteStats {
    dropped: AtomicU64,
    trades: AtomicU64,
    skipped: AtomicU64,
    unreadable: AtomicU64,
    too_late: AtomicU64,
    lines: AtomicU64,
    store_errors: AtomicU64,
}

impl TradeMinuteStats {
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
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
pub struct TradeMinuteFeed {
    input: mpsc::Sender<Frame>,
    stats: Arc<TradeMinuteStats>,
}

impl TradeMinuteFeed {
    pub fn offer(&self, recv_ms: i64, text: &Utf8Bytes) {
        if !mentions_trade_type(text.as_str()) {
            return;
        }
        if self.input.try_send(Frame { recv_ms, text: text.clone() }).is_err() {
            TradeMinuteStats::add(&self.stats.dropped, 1);
        }
    }
}

pub struct TradeMinuteWorker {
    task: JoinHandle<()>,
    stats: Arc<TradeMinuteStats>,
}

impl TradeMinuteWorker {
    pub fn stats(&self) -> Arc<TradeMinuteStats> {
        self.stats.clone()
    }

    pub async fn finish(self) {
        let abort = self.task.abort_handle();
        if timeout(DRAIN_LIMIT, self.task).await.is_err() {
            abort.abort();
            tracing::warn!("1분 체결 쓰기가 정한 시간 안에 끝나지 않아 멈춥니다");
        }
    }
}

pub fn spawn(store: Box<dyn TradeMinuteStore>, wall: Arc<dyn WallClock>) -> (TradeMinuteFeed, TradeMinuteWorker) {
    let (input, frames) = mpsc::channel(INPUT_CAPACITY);
    let stats = Arc::new(TradeMinuteStats::default());
    let task = tokio::spawn(run(frames, store, wall, stats.clone()));
    (TradeMinuteFeed { input, stats: stats.clone() }, TradeMinuteWorker { task, stats })
}

struct Aggregator {
    store: Option<Box<dyn TradeMinuteStore>>,
    wall: Arc<dyn WallClock>,
    state: MinuteState,
    stats: Arc<TradeMinuteStats>,
}

async fn run(
    mut frames: mpsc::Receiver<Frame>,
    store: Box<dyn TradeMinuteStore>,
    wall: Arc<dyn WallClock>,
    stats: Arc<TradeMinuteStats>,
) {
    let mut tick = interval_at(Instant::now() + TICK_EVERY, TICK_EVERY);
    let mut report = interval_at(Instant::now() + REPORT_EVERY, REPORT_EVERY);
    for interval in [&mut tick, &mut report] {
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    }
    let mut aggregator = Aggregator { store: Some(store), wall, state: MinuteState::default(), stats };
    loop {
        tokio::select! {
            received = frames.recv() => match received {
                Some(frame) => aggregator.take(frame).await,
                None => break,
            },
            _ = tick.tick() => {
                aggregator.take_queued(&mut frames).await;
                aggregator.close_if_elapsed().await;
            }
            _ = report.tick() => aggregator.report(),
        }
    }
    aggregator.flush_for_finish().await;
    aggregator.finish().await;
}

impl Aggregator {
    async fn with_store<T: Send + 'static>(&mut self, work: impl FnOnce(&mut dyn TradeMinuteStore) -> T + Send + 'static) -> Option<T> {
        let mut store = self.store.take()?;
        match tokio::task::spawn_blocking(move || {
            let output = work(store.as_mut());
            (store, output)
        })
        .await
        {
            Ok((store, output)) => {
                self.store = Some(store);
                Some(output)
            }
            Err(error) => {
                tracing::error!(%error, "1분 체결 파일 작업이 멈춰 이 자식의 1분 체결 쓰기를 그만둡니다");
                None
            }
        }
    }

    async fn take(&mut self, frame: Frame) {
        let kst = KstTime::from_unix_ms(frame.recv_ms);
        let minute = (kst.ms_of_day / MS_PER_MINUTE) as u16;
        if self.state.is_too_late(kst.date, minute) {
            TradeMinuteStats::add(&self.stats.too_late, 1);
            return;
        }
        if let Some((open_date, open_minute)) = self.state.open_key()
            && (kst.date, minute) > (open_date, open_minute)
        {
            self.flush_open().await;
            if kst.date != open_date {
                self.state.clear_written();
            }
        }
        self.state.ensure_open(kst.date, minute);
        let state = &mut self.state;
        let read = read_trades(frame.text.as_str(), |trade| {
            state.push(trade.code, trade.sec, trade.price, trade.quantity);
        });
        match read {
            Ok(reading) => {
                TradeMinuteStats::add(&self.stats.trades, reading.trades);
                TradeMinuteStats::add(&self.stats.skipped, reading.skipped);
            }
            Err(_) => TradeMinuteStats::add(&self.stats.unreadable, 1),
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

    async fn close_if_elapsed(&mut self) {
        if self.state.is_elapsed(self.wall.now_ms(), CLOSE_GRACE_MS) {
            self.flush_open().await;
        }
    }

    async fn flush_open(&mut self) {
        let Some((date, lines)) = self.state.close_open() else {
            return;
        };
        self.write_lines(date, lines).await;
    }

    async fn flush_for_finish(&mut self) {
        let Some((date, lines)) = self.state.flush_for_finish() else {
            return;
        };
        self.write_lines(date, lines).await;
    }

    async fn write_lines(&mut self, date: u32, lines: Vec<(String, TradeMinuteLine)>) {
        if lines.is_empty() {
            return;
        }
        let count = lines.len() as u64;
        match self.with_store(move |store| store.append(date, &lines)).await {
            Some(Ok(())) => {
                TradeMinuteStats::add(&self.stats.lines, count);
                self.state.clear_written();
            }
            Some(Err(error)) => {
                tracing::warn!(%error, date, "1분 체결을 파일에 덧붙이지 못했습니다. 다음 분에 이어 씁니다");
                TradeMinuteStats::add(&self.stats.store_errors, 1);
            }
            None => {}
        }
    }

    async fn finish(&mut self) {
        if let Some(Err(error)) = self.with_store(|store| store.finish()).await {
            tracing::warn!(%error, "1분 체결 파일을 마무리하지 못했습니다");
        }
    }

    fn report(&self) {
        let stats = &self.stats;
        tracing::info!(
            trades = stats.trades.load(Ordering::Relaxed),
            lines = stats.lines.load(Ordering::Relaxed),
            dropped = stats.dropped.load(Ordering::Relaxed),
            skipped = stats.skipped.load(Ordering::Relaxed),
            unreadable = stats.unreadable.load(Ordering::Relaxed),
            too_late = stats.too_late.load(Ordering::Relaxed),
            store_errors = stats.store_errors.load(Ordering::Relaxed),
            "1분 체결 쓰기 누계"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    struct FixedWall(i64);

    impl WallClock for FixedWall {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    struct PanickingStore;

    impl TradeMinuteStore for PanickingStore {
        fn append(&mut self, _date: u32, _lines: &[(String, TradeMinuteLine)]) -> io::Result<()> {
            panic!("의도된 저장소 패닉")
        }

        fn finish(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_panicking_store_does_not_block_offer_or_finish() {
        let (feed, worker) = spawn(Box::new(PanickingStore), Arc::new(FixedWall(1_795_359_600_000)));
        let frame = Utf8Bytes::from(r#"{"trnm":"REAL","data":[{"type":"0B","item":"005930_AL","values":{"20":"090001","10":"71000","15":"1"}}]}"#);
        feed.offer(1_795_359_600_000 + 9 * 3_600_000, &frame);
        feed.offer(1_795_359_600_000 + 9 * 3_600_000 + 60_000, &frame);
        drop(feed);
        worker.finish().await;
    }
}
