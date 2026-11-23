use std::sync::{Arc, Mutex, Weak};

use domain::{KstDate, SeriesKey, StockCode, Venue};
use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::link::{KisLane, SourceDuty};
use super::market_rest::KisMarket;
use super::market_stream::{KisMarketStream, KisSeats};
use super::master::MasterDownload;
use super::stream::{Connector, StreamStatus};
use crate::api::{self, ApiErrorCode, ApiErrorReason};
use crate::clock::Clock;
use crate::kiwoom::link::{LinkFailure, LinkState, Problem};
use crate::market_source::stream::{DesiredFeeds, MarketStream, SeatRules, StreamEvent};
use crate::market_source::{ChartPage, Cursor, DaySummary, MarketFeatures, MarketSource, MergeScope, OrderBookSnapshot, Priority, QuoteRow, SourceError, SourceFailure, StockFundamentals, TapePage};
use crate::symbols::{Directory, SymbolDirectory};

const FEED_BUFFER: usize = 4096;
const NOT_CONNECTED_MESSAGE: &str = "한투에 연결하지 않았습니다. 시스템 설정에서 연결하세요";

pub type KisConnect = Arc<dyn Fn() -> Box<dyn Connector> + Send + Sync>;

#[derive(Clone)]
pub struct KisFeedParts {
    pub connect: KisConnect,
    pub master: Arc<dyn MasterDownload>,
}

fn not_connected() -> SourceError {
    SourceError::Failed(SourceFailure { code: ApiErrorCode::KiwoomUnavailable, reason: ApiErrorReason::NotConnected, message: NOT_CONNECTED_MESSAGE.into(), retry_at: None, manual_action_required: false })
}

fn link_open(state: &LinkState) -> bool {
    matches!(state, LinkState::Connected | LinkState::Connecting(_))
}

pub struct KisSource {
    market: KisMarket,
    lane: KisLane,
}

impl KisSource {
    fn gate(&self) -> Result<(), SourceError> {
        if link_open(&self.lane.link.state()) { Ok(()) } else { Err(not_connected()) }
    }

    fn gated<'a, T: Send + 'a>(&'a self, call: impl FnOnce(&'a KisMarket) -> BoxFuture<'a, Result<T, SourceError>>) -> BoxFuture<'a, Result<T, SourceError>> {
        match self.gate() {
            Ok(()) => call(&self.market),
            Err(error) => Box::pin(async move { Err(error) }),
        }
    }
}

impl MarketSource for KisSource {
    fn features(&self) -> MarketFeatures {
        self.market.features()
    }

    fn outage(&self) -> Option<SourceError> {
        self.gate().err().or_else(|| self.market.outage())
    }

    fn list_outage(&self) -> Option<SourceError> {
        self.market.list_outage()
    }

    fn until_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(async move {
            let mut state = self.lane.link.subscribe();
            tokio::select! {
                error = self.market.until_outage() => error,
                _ = state.wait_for(|state| !link_open(state)) => not_connected(),
            }
        })
    }

    fn until_list_outage(&self) -> BoxFuture<'_, SourceError> {
        self.market.until_list_outage()
    }

    fn directory(&self, priority: Priority) -> BoxFuture<'_, Result<Directory, SourceError>> {
        self.gated(|market| market.directory(priority))
    }

    fn fundamentals(&self, code: StockCode, priority: Priority) -> BoxFuture<'_, Result<Option<StockFundamentals>, SourceError>> {
        self.gated(|market| market.fundamentals(code, priority))
    }

    fn quotes(&self, rows: Vec<(StockCode, Venue)>, priority: Priority) -> BoxFuture<'_, Result<Vec<QuoteRow>, SourceError>> {
        self.gated(|market| market.quotes(rows, priority))
    }

    fn day_summary(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<DaySummary, SourceError>> {
        self.gated(|market| market.day_summary(code, venue, priority))
    }

    fn chart_page(&self, key: SeriesKey, base: KstDate, cursor: Option<Cursor>, priority: Priority, scope: MergeScope) -> BoxFuture<'_, Result<ChartPage, SourceError>> {
        self.gated(|market| market.chart_page(key, base, cursor, priority, scope))
    }

    fn order_book(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<OrderBookSnapshot, SourceError>> {
        self.gated(|market| market.order_book(code, venue, priority))
    }

    fn trades_page(&self, code: StockCode, venue: Venue, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::TradePrint>, SourceError>> {
        self.gated(|market| market.trades_page(code, venue, cursor, priority))
    }

    fn program_trades_page(&self, code: StockCode, today: KstDate, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::ProgramTradePoint>, SourceError>> {
        self.gated(|market| market.program_trades_page(code, today, cursor, priority))
    }
}

struct Session {
    epoch: u64,
    stream: KisMarketStream,
}

impl Session {
    fn serving(&self) -> bool {
        !matches!(self.stream.status(), StreamStatus::InUseElsewhere | StreamStatus::Halted)
    }
}

struct Wanted {
    desired: DesiredFeeds,
    venue: Venue,
}

pub struct KisFeed {
    lane: KisLane,
    parts: KisFeedParts,
    clock: Clock,
    directory: watch::Receiver<Option<Arc<Directory>>>,
    events: mpsc::Sender<StreamEvent>,
    session: Mutex<Option<Session>>,
    next_epoch: Mutex<u64>,
    wanted: Mutex<Wanted>,
    desired: watch::Sender<DesiredFeeds>,
    seats: Arc<KisSeats>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Drop for KisFeed {
    fn drop(&mut self) {
        for task in self.tasks.lock().expect("작업 잠금").drain(..) {
            task.abort();
        }
    }
}

pub struct KisSupply {
    pub source: Arc<dyn MarketSource>,
    pub feed: Arc<KisFeed>,
    pub events: mpsc::Receiver<StreamEvent>,
}

impl KisFeed {
    pub fn supply(lane: KisLane, parts: KisFeedParts, clock: Clock, directory: watch::Receiver<Option<Arc<Directory>>>) -> KisSupply {
        let market = KisMarket::new(lane.rest.clone(), clock.clone(), parts.master.clone());
        let source: Arc<dyn MarketSource> = Arc::new(KisSource { market, lane: lane.clone() });
        let (events, received) = mpsc::channel(FEED_BUFFER);
        let seats = Arc::new(KisSeats::with_notices(0, lane.notices.clone()));
        let feed = Arc::new(KisFeed {
            lane,
            parts,
            clock,
            directory,
            events,
            session: Mutex::new(None),
            next_epoch: Mutex::new(0),
            wanted: Mutex::new(Wanted { desired: DesiredFeeds::new(), venue: Venue::Combined }),
            desired: watch::channel(DesiredFeeds::new()).0,
            seats,
            tasks: Mutex::new(Vec::new()),
        });
        feed.follow_link();
        KisSupply { source, feed, events: received }
    }

    fn follow_link(self: &Arc<Self>) {
        let feed = Arc::downgrade(self);
        let mut state = self.lane.link.subscribe();
        let task = tokio::spawn(async move {
            loop {
                let current = state.borrow_and_update().clone();
                let Some(feed) = feed.upgrade() else { return };
                match current {
                    LinkState::Connected => feed.open(),
                    LinkState::Connecting(_) => {}
                    LinkState::NoKey | LinkState::Disconnected | LinkState::Failed(_) => feed.close().await,
                }
                drop(feed);
                if state.changed().await.is_err() {
                    return;
                }
            }
        });
        self.tasks.lock().expect("작업 잠금").push(task);
    }

    pub fn open(self: &Arc<Self>) {
        let mut session = self.session.lock().expect("세션 잠금");
        if session.as_ref().is_some_and(Session::serving) {
            return;
        }
        let epoch = {
            let mut next = self.next_epoch.lock().expect("세션 잠금");
            *next += 1;
            *next
        };
        let (stream, out) = KisMarketStream::spawn((self.parts.connect)(), self.lane.rest.auth().clone(), self.clock.clone(), self.directory.clone(), 0, Some(self.lane.notices.clone()));
        {
            let wanted = self.wanted.lock().expect("구독 잠금");
            stream.set_venue(wanted.venue);
            stream.set_desired(wanted.desired.clone());
        }
        let status = stream.watch_status();
        *session = Some(Session { epoch, stream });
        drop(session);
        let mut tasks = self.tasks.lock().expect("작업 잠금");
        tasks.retain(|task| !task.is_finished());
        tasks.push(tokio::spawn(pump(Arc::downgrade(self), epoch, out)));
        tasks.push(tokio::spawn(watch_in_use(self.lane.clone(), status)));
    }

    async fn close(&self) {
        let closed = self.session.lock().expect("세션 잠금").take();
        if closed.as_ref().is_some_and(Session::serving) {
            let _ = self.events.send(StreamEvent::Idle).await;
        }
    }

    fn current_epoch(&self) -> Option<u64> {
        self.session.lock().expect("세션 잠금").as_ref().map(|session| session.epoch)
    }

    pub fn duty(self: &Arc<Self>, symbols: Arc<SymbolDirectory>, source: Arc<dyn MarketSource>) -> Arc<dyn SourceDuty> {
        Arc::new(KisDuty { feed: Arc::downgrade(self), symbols, source })
    }
}

async fn pump(feed: Weak<KisFeed>, epoch: u64, mut out: mpsc::Receiver<StreamEvent>) {
    while let Some(event) = out.recv().await {
        let Some(feed) = feed.upgrade() else { return };
        if feed.current_epoch() != Some(epoch) {
            return;
        }
        if feed.events.send(event).await.is_err() {
            return;
        }
    }
}

async fn watch_in_use(lane: KisLane, mut status: watch::Receiver<StreamStatus>) {
    if status.wait_for(|status| *status == StreamStatus::InUseElsewhere).await.is_ok() {
        tracing::warn!("한투 실시간을 다른 곳에서 쓰고 있어 이 한투 키의 연결을 멈춥니다");
        lane.link.fail_in_use_elsewhere();
    }
}

impl MarketStream for KisFeed {
    fn seat_rules(&self) -> Arc<dyn SeatRules> {
        self.seats.clone()
    }

    fn set_desired(&self, desired: DesiredFeeds) {
        let session = self.session.lock().expect("세션 잠금");
        self.wanted.lock().expect("구독 잠금").desired.clone_from(&desired);
        if let Some(session) = session.as_ref() {
            session.stream.set_desired(desired.clone());
        }
        self.desired.send_replace(desired);
    }

    fn watch_desired(&self) -> watch::Receiver<DesiredFeeds> {
        self.desired.subscribe()
    }

    fn set_venue(&self, venue: Venue) {
        let session = self.session.lock().expect("세션 잠금");
        self.wanted.lock().expect("구독 잠금").venue = venue;
        if let Some(session) = session.as_ref() {
            session.stream.set_venue(venue);
        }
    }
}

struct KisDuty {
    feed: Weak<KisFeed>,
    symbols: Arc<SymbolDirectory>,
    source: Arc<dyn MarketSource>,
}

fn failure_of_source(error: &SourceError) -> LinkFailure {
    let problem = match error {
        SourceError::Failed(failure) => match failure.reason {
            ApiErrorReason::AuthBlocked => Problem::KeyNeedsCheck,
            ApiErrorReason::IssueInterval => Problem::IssueIntervalWait,
            ApiErrorReason::TokenFile => Problem::TokenFileUnusable,
            ApiErrorReason::KiwoomUnreachable | ApiErrorReason::KiwoomTimeout | ApiErrorReason::RateLimited | ApiErrorReason::NotConnected => Problem::Network,
            _ => Problem::PathStopped,
        },
        SourceError::UnknownSymbol | SourceError::Malformed(_) => Problem::PathStopped,
    };
    LinkFailure { problem, retry_at: error.retry_at(), message: error.to_string() }
}

impl SourceDuty for KisDuty {
    fn load_symbols(&self) -> BoxFuture<'static, Result<(), LinkFailure>> {
        let (symbols, source) = (self.symbols.clone(), self.source.clone());
        async move { symbols.refresh(source.as_ref(), Priority::Screen).await.map_err(|error| failure_of_source(&error)) }.boxed()
    }

    fn open_realtime(&self) -> BoxFuture<'static, Result<(), LinkFailure>> {
        if let Some(feed) = self.feed.upgrade() {
            feed.open();
        }
        async { Ok(()) }.boxed()
    }
}
