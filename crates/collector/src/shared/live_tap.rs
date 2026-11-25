use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use server::shared_data::MinuteInstrument;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at, timeout};
use tokio_tungstenite::tungstenite::Utf8Bytes;

use super::flow::{self, FLOW_KINDS, FileFlowStore, FlowFeed, FlowWorker};
use super::minute::{
    self, FLUSH_EVERY as MINUTE_FLUSH_EVERY, FileMinuteStore, MinuteFeed, MinuteStats, MinuteStore, MinuteWorker,
    read::{RawTick, mentions_minute_type, tick_from_fields},
    task::Aggregator as MinuteAggregator,
};
use super::quotes::{self, QuoteFeed, QuoteWorker};
use super::trade_minute::{
    self, FileTradeMinuteStore, TradeMinuteFeed, TradeMinuteStats, TradeMinuteStore, TradeMinuteWorker,
    read::{RawTrade, trade_from_fields},
    task::{Aggregator as TradeAggregator, TICK_EVERY as TRADE_TICK_EVERY},
};
use crate::collect::session::WallClock;
use crate::kst::KstTime;
use crate::protocol::KeyName;

pub(crate) const INPUT_CAPACITY: usize = 16_384;
pub(crate) const REPORT_EVERY: Duration = Duration::from_secs(60);
pub(crate) const DRAIN_LIMIT: Duration = Duration::from_secs(5);

pub(crate) fn delayed_interval(every: Duration) -> Interval {
    let mut interval = interval_at(Instant::now() + every, every);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval
}

pub(crate) async fn finish_task(task: JoinHandle<()>, timeout_message: &str) {
    let abort = task.abort_handle();
    if timeout(DRAIN_LIMIT, task).await.is_err() {
        abort.abort();
        tracing::warn!("{timeout_message}");
    }
}

pub(crate) struct BlockingStore<S>(Option<S>);

impl<S: Send + 'static> BlockingStore<S> {
    pub(crate) fn new(store: S) -> BlockingStore<S> {
        BlockingStore(Some(store))
    }

    pub(crate) async fn run<T: Send + 'static>(
        &mut self,
        work: impl FnOnce(&mut S) -> T + Send + 'static,
        panic_message: &str,
    ) -> Option<T> {
        let mut store = self.0.take()?;
        match tokio::task::spawn_blocking(move || {
            let output = work(&mut store);
            (store, output)
        })
        .await
        {
            Ok((store, output)) => {
                self.0 = Some(store);
                Some(output)
            }
            Err(error) => {
                tracing::error!(%error, "{panic_message}");
                None
            }
        }
    }
}

pub(crate) fn seconds_of_day(text: &str) -> Option<u32> {
    let text = text.trim();
    if text.len() != 6 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let part = |range: std::ops::Range<usize>| text[range].parse::<u32>().ok();
    let (hour, minute, second) = (part(0..2)?, part(2..4)?, part(4..6)?);
    (hour < 24 && minute < 60 && second < 60).then_some(hour * 3600 + minute * 60 + second)
}

pub(crate) fn unsigned_quantity(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0);
    }
    let magnitude = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if magnitude.is_empty() || !magnitude.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    magnitude.parse().ok()
}

#[derive(Deserialize)]
struct TradeFrame<'a> {
    #[serde(borrow, default)]
    data: Vec<TradeEntry<'a>>,
}

#[derive(Deserialize)]
struct TradeEntry<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Cow<'a, str>,
    #[serde(borrow, default)]
    item: Cow<'a, str>,
    #[serde(borrow, default)]
    values: TradeValues<'a>,
}

#[derive(Deserialize, Default)]
struct TradeValues<'a> {
    #[serde(rename = "20", borrow)]
    time: Option<Cow<'a, str>>,
    #[serde(rename = "10", borrow)]
    price: Option<Cow<'a, str>>,
    #[serde(rename = "15", borrow)]
    quantity: Option<Cow<'a, str>>,
    #[serde(rename = "14", borrow)]
    cumulative_value: Option<Cow<'a, str>>,
    #[serde(rename = "9081", borrow)]
    exchange: Option<Cow<'a, str>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CombinedReading {
    pub(crate) minute_ticks: u64,
    pub(crate) minute_skipped: u64,
    pub(crate) trades: u64,
    pub(crate) trade_skipped: u64,
}

pub(crate) fn read_trade_and_minute_frame(
    text: &str,
    mut on_tick: impl FnMut(RawTick<'_>),
    mut on_trade: impl FnMut(RawTrade<'_>),
) -> Result<CombinedReading, serde_json::Error> {
    let frame: TradeFrame<'_> = serde_json::from_str(text)?;
    let mut reading = CombinedReading::default();
    for entry in &frame.data {
        let time = entry.values.time.as_deref();
        let price = entry.values.price.as_deref();
        let quantity = entry.values.quantity.as_deref();
        let cumulative_value = entry.values.cumulative_value.as_deref();
        let exchange = entry.values.exchange.as_deref();
        let instrument = match entry.kind.as_ref() {
            "0B" => {
                match trade_from_fields(entry.item.as_ref(), time, price, quantity) {
                    Some(trade) => {
                        reading.trades += 1;
                        on_trade(trade);
                    }
                    None => reading.trade_skipped += 1,
                }
                MinuteInstrument::Stock
            }
            "0J" => MinuteInstrument::Index,
            _ => continue,
        };
        match tick_from_fields(entry.item.as_ref(), instrument, time, price, quantity, cumulative_value, exchange) {
            Some(tick) => {
                reading.minute_ticks += 1;
                on_tick(tick);
            }
            None => reading.minute_skipped += 1,
        }
    }
    Ok(reading)
}

#[derive(Default)]
pub struct LiveTapConfig {
    pub minutes: Option<Box<dyn MinuteStore>>,
    pub flow: Option<FileFlowStore>,
    pub quotes: Option<PathBuf>,
    pub trades: Option<Box<dyn TradeMinuteStore>>,
}

impl LiveTapConfig {
    pub fn none() -> LiveTapConfig {
        LiveTapConfig::default()
    }

    pub fn for_shared_dir(dir: PathBuf, key: &KeyName) -> LiveTapConfig {
        LiveTapConfig {
            minutes: Some(Box::new(FileMinuteStore::new(dir.clone(), key.clone()))),
            flow: Some(FileFlowStore::new(dir.clone(), key.clone())),
            quotes: Some(dir.clone()),
            trades: Some(Box::new(FileTradeMinuteStore::new(dir, key.clone()))),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.minutes.is_none() && self.flow.is_none() && self.quotes.is_none() && self.trades.is_none()
    }
}

struct CombinedFrame {
    recv_ms: i64,
    text: Utf8Bytes,
}

#[derive(Clone)]
struct CombinedTradeFeed {
    input: mpsc::Sender<CombinedFrame>,
    dropped: Arc<AtomicU64>,
}

impl CombinedTradeFeed {
    fn offer(&self, recv_ms: i64, text: &Utf8Bytes) {
        if !mentions_minute_type(text.as_str()) {
            return;
        }
        if self.input.try_send(CombinedFrame { recv_ms, text: text.clone() }).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[derive(Clone)]
enum TradeLaneFeed {
    Minutes(MinuteFeed),
    Trades(TradeMinuteFeed),
    Combined(CombinedTradeFeed),
}

impl TradeLaneFeed {
    fn offer(&self, recv_ms: i64, text: &Utf8Bytes) {
        match self {
            TradeLaneFeed::Minutes(feed) => feed.offer(recv_ms, text),
            TradeLaneFeed::Trades(feed) => feed.offer(recv_ms, text),
            TradeLaneFeed::Combined(feed) => feed.offer(recv_ms, text),
        }
    }
}

enum TradeLaneWorker {
    Minutes(MinuteWorker),
    Trades(TradeMinuteWorker),
    Combined(JoinHandle<()>),
}

impl TradeLaneWorker {
    async fn finish(self) {
        match self {
            TradeLaneWorker::Minutes(worker) => worker.finish().await,
            TradeLaneWorker::Trades(worker) => worker.finish().await,
            TradeLaneWorker::Combined(task) => finish_task(task, "분봉·1분 체결 집계가 정한 시간 안에 끝나지 않아 멈춥니다").await,
        }
    }
}

#[derive(Clone)]
pub struct LiveTapFeed {
    trade_lane: Option<TradeLaneFeed>,
    flow: Option<FlowFeed>,
    quotes: Option<QuoteFeed>,
}

impl LiveTapFeed {
    pub fn offer_frame(&self, recv_ms: i64, bytes: &Utf8Bytes) {
        if let Some(lane) = &self.trade_lane {
            lane.offer(recv_ms, bytes);
        }
        if let Some(flow) = &self.flow {
            flow.offer(recv_ms, bytes);
        }
        if let Some(quotes) = &self.quotes {
            quotes.offer(recv_ms, bytes);
        }
    }

    pub fn on_link(&self, recv_ms: i64, live: bool) {
        if let Some(flow) = &self.flow {
            flow.link(recv_ms, live);
        }
        if let Some(quotes) = &self.quotes {
            if live {
                quotes.link_live(recv_ms);
            } else {
                quotes.link_down(recv_ms);
            }
        }
    }
}

pub struct LiveTapWorker {
    trade_lane: Option<TradeLaneWorker>,
    flow: Option<FlowWorker>,
    quotes: Option<QuoteWorker>,
}

impl LiveTapWorker {
    pub async fn finish(self) {
        tokio::join!(
            async {
                if let Some(worker) = self.trade_lane {
                    worker.finish().await;
                }
            },
            async {
                if let Some(worker) = self.flow {
                    worker.finish().await;
                }
            },
            async {
                if let Some(worker) = self.quotes {
                    worker.finish().await;
                }
            },
        );
    }
}

pub fn spawn_live_tap(config: LiveTapConfig, key: KeyName, wall_clock: Arc<dyn WallClock>) -> Option<(LiveTapFeed, LiveTapWorker)> {
    if config.is_empty() {
        return None;
    }
    let now_ms = wall_clock.now_ms();
    let (trade_feed, trade_worker) = match (config.minutes, config.trades) {
        (Some(minutes), Some(trades)) => {
            let (feed, task) = spawn_combined_trade(minutes, trades, wall_clock, now_ms);
            (Some(TradeLaneFeed::Combined(feed)), Some(TradeLaneWorker::Combined(task)))
        }
        (Some(minutes), None) => {
            let (feed, worker) = minute::spawn(minutes, now_ms);
            (Some(TradeLaneFeed::Minutes(feed)), Some(TradeLaneWorker::Minutes(worker)))
        }
        (None, Some(trades)) => {
            let (feed, worker) = trade_minute::spawn(trades, wall_clock);
            (Some(TradeLaneFeed::Trades(feed)), Some(TradeLaneWorker::Trades(worker)))
        }
        (None, None) => (None, None),
    };
    let (flow_feed, flow_worker) = match config.flow {
        Some(store) => {
            let (feed, worker) = flow::spawn(FLOW_KINDS, store, now_ms);
            (Some(feed), Some(worker))
        }
        None => (None, None),
    };
    let (quote_feed, quote_worker) = match config.quotes {
        Some(shared_dir) => {
            let (feed, worker) = quotes::spawn(shared_dir, key, now_ms);
            (Some(feed), Some(worker))
        }
        None => (None, None),
    };
    Some((
        LiveTapFeed { trade_lane: trade_feed, flow: flow_feed, quotes: quote_feed },
        LiveTapWorker { trade_lane: trade_worker, flow: flow_worker, quotes: quote_worker },
    ))
}

fn spawn_combined_trade(
    minutes: Box<dyn MinuteStore>,
    trades: Box<dyn TradeMinuteStore>,
    wall: Arc<dyn WallClock>,
    now_ms: i64,
) -> (CombinedTradeFeed, JoinHandle<()>) {
    let (input, frames) = mpsc::channel(INPUT_CAPACITY);
    let dropped = Arc::new(AtomicU64::new(0));
    let task = tokio::spawn(run_combined_trade(frames, minutes, trades, wall, dropped.clone(), now_ms));
    (CombinedTradeFeed { input, dropped }, task)
}

async fn run_combined_trade(
    mut frames: mpsc::Receiver<CombinedFrame>,
    minutes: Box<dyn MinuteStore>,
    trades: Box<dyn TradeMinuteStore>,
    wall: Arc<dyn WallClock>,
    dropped: Arc<AtomicU64>,
    now_ms: i64,
) {
    let mut minute_flush = delayed_interval(MINUTE_FLUSH_EVERY);
    let mut trade_tick = delayed_interval(TRADE_TICK_EVERY);
    let mut report = delayed_interval(REPORT_EVERY);
    let minute_stats = Arc::new(MinuteStats::default());
    let trade_stats = Arc::new(TradeMinuteStats::default());
    let mut minute_agg = MinuteAggregator::new(minutes, now_ms, minute_stats);
    let mut trade_agg = TradeAggregator::new(trades, wall, trade_stats);
    minute_agg.open_day(KstTime::from_unix_ms(now_ms).date).await;

    let drain_queued = |frames: &mut mpsc::Receiver<CombinedFrame>| -> Vec<CombinedFrame> {
        let mut batch = Vec::with_capacity(frames.len());
        for _ in 0..frames.len() {
            match frames.try_recv() {
                Ok(frame) => batch.push(frame),
                Err(_) => break,
            }
        }
        batch
    };

    loop {
        tokio::select! {
            received = frames.recv() => match received {
                Some(frame) => apply_combined_frame(&mut minute_agg, &mut trade_agg, frame).await,
                None => break,
            },
            _ = trade_tick.tick() => {
                for frame in drain_queued(&mut frames) {
                    apply_combined_frame(&mut minute_agg, &mut trade_agg, frame).await;
                }
                trade_agg.close_if_elapsed().await;
            }
            _ = minute_flush.tick() => {
                for frame in drain_queued(&mut frames) {
                    apply_combined_frame(&mut minute_agg, &mut trade_agg, frame).await;
                }
                minute_agg.flush().await;
            }
            _ = report.tick() => {
                let dropped_count = dropped.swap(0, Ordering::Relaxed);
                if dropped_count > 0 {
                    minute_agg.record_dropped(dropped_count);
                    trade_agg.record_dropped(dropped_count);
                }
                minute_agg.report();
                trade_agg.report();
            }
        }
    }
    minute_agg.flush().await;
    minute_agg.finish().await;
    trade_agg.flush_for_finish().await;
    trade_agg.finish().await;
}

async fn apply_combined_frame(minute_agg: &mut MinuteAggregator, trade_agg: &mut TradeAggregator, frame: CombinedFrame) {
    minute_agg.prepare_day(frame.recv_ms).await;
    let accept_trades = trade_agg.prepare_frame(frame.recv_ms).await;
    let parsed = read_trade_and_minute_frame(
        frame.text.as_str(),
        |tick| minute_agg.apply_tick(&tick),
        |trade| {
            if accept_trades {
                trade_agg.apply_trade(trade);
            }
        },
    );
    match parsed {
        Ok(reading) => {
            minute_agg.record_skipped(reading.minute_skipped);
            if accept_trades {
                trade_agg.record_read(reading.trades, reading.trade_skipped);
            }
        }
        Err(_) => {
            minute_agg.record_unreadable();
            if accept_trades {
                trade_agg.record_unreadable();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Mutex;

    use server::shared_data::{MinuteBar, TradeMinuteLine};

    use super::*;

    struct FixedWall(i64);

    impl WallClock for FixedWall {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    #[derive(Default)]
    struct MemMinuteStore(Arc<Mutex<Vec<MinuteBar>>>);

    impl MinuteStore for MemMinuteStore {
        fn load(&mut self, _date: u32) -> io::Result<Vec<MinuteBar>> {
            Ok(Vec::new())
        }

        fn append(&mut self, _date: u32, bars: &[MinuteBar], _as_of: i64) -> io::Result<()> {
            self.0.lock().unwrap().extend_from_slice(bars);
            Ok(())
        }

        fn finish(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct MemTradeStore(Arc<Mutex<Vec<(String, TradeMinuteLine)>>>);

    impl TradeMinuteStore for MemTradeStore {
        fn append(&mut self, _date: u32, lines: &[(String, TradeMinuteLine)]) -> io::Result<()> {
            self.0.lock().unwrap().extend_from_slice(lines);
            Ok(())
        }

        fn finish(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn seconds_of_day_and_unsigned_quantity_validate_inputs() {
        assert_eq!(seconds_of_day("090001"), Some(9 * 3600 + 1));
        assert_eq!(seconds_of_day(" 153000 "), Some(15 * 3600 + 30 * 60));
        assert_eq!(seconds_of_day("240000"), None);
        assert_eq!(seconds_of_day("096000"), None);
        assert_eq!(seconds_of_day("0900"), None);

        assert_eq!(unsigned_quantity(""), Some(0));
        assert_eq!(unsigned_quantity("-42"), Some(42));
        assert_eq!(unsigned_quantity("+7"), Some(7));
        assert_eq!(unsigned_quantity("abc"), None);
    }

    #[test]
    fn combined_parser_reads_stock_and_index_entries_in_one_pass() {
        let frame = r#"{"trnm":"REAL","data":[
            {"type":"0B","item":"005930_AL","values":{"20":"090001","10":"-71000","15":"-12","9081":"NXT"}},
            {"type":"0J","item":"001","values":{"20":"090002","10":"+2650.5","15":"0","14":"999"}}
        ]}"#;
        let mut ticks = Vec::new();
        let mut trades = Vec::new();
        let reading = read_trade_and_minute_frame(
            frame,
            |tick| ticks.push((tick.symbol.to_owned(), tick.instrument, tick.volume)),
            |trade| trades.push((trade.code.to_owned(), trade.price, trade.quantity)),
        )
        .unwrap();
        assert_eq!(reading, CombinedReading { minute_ticks: 2, minute_skipped: 0, trades: 1, trade_skipped: 0 });
        assert_eq!(ticks, [("005930".into(), MinuteInstrument::Stock, 12), ("001".into(), MinuteInstrument::Index, 0)]);
        assert_eq!(trades, [("005930".into(), 71000, -12)]);
    }

    #[tokio::test]
    async fn combined_live_tap_feeds_both_minute_and_trade_stores_from_one_offer() {
        let base_ms = 1_795_359_600_000 + 9 * 3_600_000;
        let minute_out = Arc::new(Mutex::new(Vec::new()));
        let trade_out = Arc::new(Mutex::new(Vec::new()));
        let config = LiveTapConfig {
            minutes: Some(Box::new(MemMinuteStore(minute_out.clone()))),
            flow: None,
            quotes: None,
            trades: Some(Box::new(MemTradeStore(trade_out.clone()))),
        };
        let (feed, worker) = spawn_live_tap(config, KeyName::parse("k1").unwrap(), Arc::new(FixedWall(base_ms))).unwrap();
        let frame = Utf8Bytes::from(r#"{"trnm":"REAL","data":[{"type":"0B","item":"005930_AL","values":{"20":"090001","10":"+71000","15":"-5","9081":"KRX"}}]}"#);
        feed.offer_frame(base_ms + 1_000, &frame);
        drop(feed);
        worker.finish().await;

        assert_eq!(minute_out.lock().unwrap().len(), 2);
        let trade_lines = trade_out.lock().unwrap();
        assert_eq!(trade_lines.len(), 1);
        assert_eq!(trade_lines[0].0, "005930");
    }
}
