use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use domain::{KstDate, SeriesKey, StockCode, Venue};
use futures::future::BoxFuture;
use tokio::sync::{mpsc, watch};

use super::stream::{DesiredFeeds, MarketStream, SeatRules, StreamEvent, StreamKind};
use super::vi::ViHistory;
use super::{ChartPage, Cursor, DaySummary, MarketFeatures, MarketSource, MergeScope, OrderBookSnapshot, Priority, QuoteRow, SourceError, StockFundamentals, TapePage};
use crate::api;
use crate::clock::Clock;
use crate::symbols::Directory;

const MERGED_BUFFER: usize = 4096;

pub struct ActiveSource {
    current: RwLock<Arc<dyn MarketSource>>,
    swaps: watch::Sender<u64>,
}

impl ActiveSource {
    pub fn new(initial: Arc<dyn MarketSource>) -> ActiveSource {
        ActiveSource { current: RwLock::new(initial), swaps: watch::channel(0).0 }
    }

    pub fn current(&self) -> Arc<dyn MarketSource> {
        self.current.read().expect("공급원 잠금").clone()
    }

    pub fn replace(&self, next: Arc<dyn MarketSource>) {
        *self.current.write().expect("공급원 잠금") = next;
        self.swaps.send_modify(|count| *count += 1);
    }

    async fn until_any_outage(&self, list: bool) -> SourceError {
        let mut swaps = self.swaps.subscribe();
        loop {
            let source = self.current();
            let outage = async {
                if list { source.until_list_outage().await } else { source.until_outage().await }
            };
            tokio::select! {
                error = outage => return error,
                changed = swaps.changed() => if changed.is_err() {
                    return std::future::pending().await;
                },
            }
        }
    }
}

impl MarketSource for ActiveSource {
    fn features(&self) -> MarketFeatures {
        self.current().features()
    }

    fn outage(&self) -> Option<SourceError> {
        self.current().outage()
    }

    fn list_outage(&self) -> Option<SourceError> {
        self.current().list_outage()
    }

    fn until_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(self.until_any_outage(false))
    }

    fn until_list_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(self.until_any_outage(true))
    }

    fn directory(&self, priority: Priority) -> BoxFuture<'_, Result<Directory, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.directory(priority).await })
    }

    fn fundamentals(&self, code: StockCode, priority: Priority) -> BoxFuture<'_, Result<Option<StockFundamentals>, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.fundamentals(code, priority).await })
    }

    fn quotes(&self, rows: Vec<(StockCode, Venue)>, priority: Priority) -> BoxFuture<'_, Result<Vec<QuoteRow>, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.quotes(rows, priority).await })
    }

    fn day_summary(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<DaySummary, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.day_summary(code, venue, priority).await })
    }

    fn chart_page(&self, key: SeriesKey, base: KstDate, cursor: Option<Cursor>, priority: Priority, scope: MergeScope) -> BoxFuture<'_, Result<ChartPage, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.chart_page(key, base, cursor, priority, scope).await })
    }

    fn order_book(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<OrderBookSnapshot, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.order_book(code, venue, priority).await })
    }

    fn trades_page(&self, code: StockCode, venue: Venue, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::TradePrint>, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.trades_page(code, venue, cursor, priority).await })
    }

    fn program_trades_page(&self, code: StockCode, today: KstDate, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::ProgramTradePoint>, SourceError>> {
        let source = self.current();
        Box::pin(async move { source.program_trades_page(code, today, cursor, priority).await })
    }

    fn supports_past_program_trades(&self) -> bool {
        self.current().supports_past_program_trades()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StreamId(u64);

#[derive(Clone)]
pub struct AttachedStream {
    id: StreamId,
    stream: Arc<dyn MarketStream>,
}

impl AttachedStream {
    pub fn id(&self) -> StreamId {
        self.id
    }
}

struct Gate {
    active: StreamId,
    liveness: HashMap<StreamId, StreamEvent>,
}

struct Merged {
    gate: tokio::sync::Mutex<Gate>,
    out: mpsc::Sender<StreamEvent>,
}

struct Wanted {
    desired: DesiredFeeds,
    venue: Option<Venue>,
}

pub struct ActiveStream {
    merged: Arc<Merged>,
    clock: Clock,
    current: Mutex<AttachedStream>,
    wanted: Mutex<Wanted>,
    desired: watch::Sender<DesiredFeeds>,
    next_id: AtomicU64,
}

fn is_liveness(event: &StreamEvent) -> bool {
    matches!(event, StreamEvent::Live { .. } | StreamEvent::Down { .. } | StreamEvent::Idle | StreamEvent::Halted)
}

async fn forward(merged: Arc<Merged>, id: StreamId, mut events: mpsc::Receiver<StreamEvent>) {
    while let Some(event) = events.recv().await {
        let mut gate = merged.gate.lock().await;
        if is_liveness(&event) {
            gate.liveness.insert(id, event.clone());
        }
        if gate.active == id {
            let _ = merged.out.send(event).await;
        }
    }
    merged.gate.lock().await.liveness.remove(&id);
}

impl ActiveStream {
    pub fn new(stream: Arc<dyn MarketStream>, events: mpsc::Receiver<StreamEvent>, clock: Clock) -> (ActiveStream, mpsc::Receiver<StreamEvent>, AttachedStream) {
        let (out, merged_events) = mpsc::channel(MERGED_BUFFER);
        let first = AttachedStream { id: StreamId(0), stream };
        let merged = Arc::new(Merged { gate: tokio::sync::Mutex::new(Gate { active: first.id, liveness: HashMap::new() }), out });
        tokio::spawn(forward(merged.clone(), first.id, events));
        let active = ActiveStream {
            merged,
            clock,
            current: Mutex::new(first.clone()),
            wanted: Mutex::new(Wanted { desired: DesiredFeeds::new(), venue: None }),
            desired: watch::channel(DesiredFeeds::new()).0,
            next_id: AtomicU64::new(1),
        };
        (active, merged_events, first)
    }

    pub fn attach(&self, stream: Arc<dyn MarketStream>, events: mpsc::Receiver<StreamEvent>) -> AttachedStream {
        let attached = AttachedStream { id: StreamId(self.next_id.fetch_add(1, Ordering::Relaxed)), stream };
        tokio::spawn(forward(self.merged.clone(), attached.id, events));
        attached
    }

    pub fn active(&self) -> StreamId {
        self.current.lock().expect("스트림 잠금").id
    }

    pub async fn activate(&self, next: &AttachedStream) {
        {
            let mut current = self.current.lock().expect("스트림 잠금");
            if current.id == next.id {
                return;
            }
            let wanted = self.wanted.lock().expect("스트림 잠금");
            current.stream.set_desired(DesiredFeeds::new());
            if let Some(venue) = wanted.venue {
                next.stream.set_venue(venue);
            }
            next.stream.set_desired(wanted.desired.clone());
            *current = next.clone();
        }
        let mut gate = self.merged.gate.lock().await;
        gate.active = next.id;
        let now = self.clock.now();
        let _ = self.merged.out.send(StreamEvent::SourceSwitched).await;
        let _ = self.merged.out.send(StreamEvent::Down { at: now }).await;
        let replay = match gate.liveness.get(&next.id) {
            Some(StreamEvent::Live { .. }) => Some(StreamEvent::Live { since: now }),
            Some(held @ (StreamEvent::Idle | StreamEvent::Halted)) => Some(held.clone()),
            _ => None,
        };
        if let Some(event) = replay {
            let _ = self.merged.out.send(event).await;
        }
    }

    pub fn live_seat_rules(self: &Arc<Self>) -> Arc<dyn SeatRules> {
        Arc::new(ActiveSeats(self.clone()))
    }
}

impl MarketStream for ActiveStream {
    fn seat_rules(&self) -> Arc<dyn SeatRules> {
        self.current.lock().expect("스트림 잠금").stream.seat_rules()
    }

    fn set_desired(&self, desired: DesiredFeeds) {
        let current = self.current.lock().expect("스트림 잠금");
        self.wanted.lock().expect("스트림 잠금").desired.clone_from(&desired);
        current.stream.set_desired(desired.clone());
        self.desired.send_replace(desired);
    }

    fn watch_desired(&self) -> watch::Receiver<DesiredFeeds> {
        self.desired.subscribe()
    }

    fn set_venue(&self, venue: Venue) {
        let current = self.current.lock().expect("스트림 잠금");
        self.wanted.lock().expect("스트림 잠금").venue = Some(venue);
        current.stream.set_venue(venue);
    }

    fn vi_history(&self) -> Option<ViHistory> {
        self.current.lock().expect("스트림 잠금").stream.vi_history()
    }

    fn forget_vi_history(&self) {
        self.current.lock().expect("스트림 잠금").stream.forget_vi_history();
    }
}

struct ActiveSeats(Arc<ActiveStream>);

impl SeatRules for ActiveSeats {
    fn limit(&self) -> usize {
        self.0.seat_rules().limit()
    }

    fn takes_own_seat(&self, kind: StreamKind) -> bool {
        self.0.seat_rules().takes_own_seat(kind)
    }

    fn companion(&self, kind: StreamKind) -> Option<StreamKind> {
        self.0.seat_rules().companion(kind)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use domain::{KstDate, Symbol};

    use super::*;
    use crate::clock::kst;
    use crate::kis::market_stream::KisSeats;

    struct Recorded {
        desired: Mutex<Vec<DesiredFeeds>>,
        venues: Mutex<Vec<Venue>>,
        watched: watch::Sender<DesiredFeeds>,
    }

    impl Recorded {
        fn new() -> Arc<Recorded> {
            Arc::new(Recorded { desired: Mutex::default(), venues: Mutex::default(), watched: watch::channel(DesiredFeeds::new()).0 })
        }

        fn last_desired(&self) -> Option<DesiredFeeds> {
            self.desired.lock().unwrap().last().cloned()
        }
    }

    impl MarketStream for Recorded {
        fn seat_rules(&self) -> Arc<dyn SeatRules> {
            Arc::new(KisSeats::new(0))
        }

        fn set_desired(&self, desired: DesiredFeeds) {
            self.desired.lock().unwrap().push(desired);
        }

        fn watch_desired(&self) -> watch::Receiver<DesiredFeeds> {
            self.watched.subscribe()
        }

        fn set_venue(&self, venue: Venue) {
            self.venues.lock().unwrap().push(venue);
        }
    }

    fn samsung() -> DesiredFeeds {
        DesiredFeeds::from([(Symbol::parse("005930").unwrap(), BTreeSet::from([StreamKind::Trades]))])
    }

    async fn drained(merged: &mut mpsc::Receiver<StreamEvent>) -> Vec<StreamEvent> {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        let mut seen = Vec::new();
        while let Ok(event) = merged.try_recv() {
            seen.push(event);
        }
        seen
    }

    #[tokio::test]
    async fn only_the_active_stream_reaches_the_hub_and_activating_moves_the_desired_feeds_and_replays_liveness() {
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 23).unwrap(), 10, 0, 0));
        let (kiwoom, kis) = (Recorded::new(), Recorded::new());
        let (kiwoom_tx, kiwoom_rx) = mpsc::channel(8);
        let (kis_tx, kis_rx) = mpsc::channel(8);
        let (active, mut merged, first) = ActiveStream::new(kiwoom.clone(), kiwoom_rx, clock.clone());
        let second = active.attach(kis.clone(), kis_rx);
        active.set_desired(samsung());
        active.set_venue(Venue::Krx);
        assert_eq!(kiwoom.last_desired(), Some(samsung()));
        kis_tx.send(StreamEvent::Live { since: clock.now() }).await.unwrap();
        kiwoom_tx.send(StreamEvent::Idle).await.unwrap();
        assert_eq!(drained(&mut merged).await, [StreamEvent::Idle], "쓰지 않는 스트림의 이벤트는 허브에 가지 않는다");

        active.activate(&second).await;
        assert_eq!(active.active(), second.id());
        assert_eq!(kiwoom.last_desired(), Some(DesiredFeeds::new()), "옛 스트림의 실시간 시세를 내린다");
        assert_eq!((kis.last_desired(), kis.venues.lock().unwrap().clone()), (Some(samsung()), vec![Venue::Krx]), "새 스트림에 열린 구독과 거래소를 다시 건다");
        assert_eq!(drained(&mut merged).await, [StreamEvent::SourceSwitched, StreamEvent::Down { at: clock.now() }, StreamEvent::Live { since: clock.now() }], "바꾸는 순간 끊김을 알리고 이미 살아 있는 새 스트림이면 바로 Live");
        kiwoom_tx.send(StreamEvent::Live { since: clock.now() }).await.unwrap();
        kis_tx.send(StreamEvent::Halted).await.unwrap();
        assert_eq!(drained(&mut merged).await, [StreamEvent::Halted]);

        active.activate(&first).await;
        assert_eq!(kiwoom.last_desired(), Some(samsung()));
        assert_eq!(drained(&mut merged).await, [StreamEvent::SourceSwitched, StreamEvent::Down { at: clock.now() }, StreamEvent::Live { since: clock.now() }], "되돌아온 키움 스트림은 그사이 Live였다");
    }
}
