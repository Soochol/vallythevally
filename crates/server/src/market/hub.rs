//! `MarketHub` 액터(backend.md §5.5). 실시간 상태는 태스크 하나가 혼자 가진다. 락이 없다.
//!
//! 허브는 자기 입력 말고는 아무것도 기다리지 않는다. 키움 조회(`BarService`)는 허브가 띄운 태스크가 기다리고 결과를 입력으로 돌려준다.
//! 브라우저로 보낼 것은 연결마다의 `Outbox`에 넣기만 한다.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use domain::{
    Aggregator, Applied, Bucket, CLOSE_GRACE_SECS, ConfirmedBar, CurrentBar, Feed, KstDate, KstTime, Ohlcv, Price, SESSION_CLOSE, SeriesKey, StockCode, Symbol,
    TRADING_OPEN, TimeOfDay, Trade, TradeTimeError, Venue, resolve_trade_time,
};
use tokio::sync::{mpsc, oneshot, watch};

use super::outbox::Outbox;
use super::subscriptions::{Holder, SubscriptionManager};
use super::venue_volume::{DayTallies, DayVolumes, Fill};
use super::{ConnId, SubId};
use crate::api::{self, ConnectionStatus, FeedKind, RealtimeState, ReloadReason, ServerMessage, SubErrorCode, UnixSeconds};
use crate::bars::{BarError, BarService, Seed};
use crate::clock::Clock;
use crate::kiwoom::rest::Priority;
use crate::market_source::SourceError;
use crate::market_source::stream::{
    AfterHoursTotals, BookLevel, BookSnapshot, BrokerEntry, BrokerSnapshot, Exchange, MarketStream, RealProgramTrade, RealTick, StreamEvent, StreamKind, TradeSide,
};
use crate::quotes;
use crate::symbols::Directory;

const SEED_RETRY_SECS: [u64; 5] = [1, 2, 5, 10, 30];
const VERIFY_DELAY_SECS: i64 = 5;
const VERIFY_ATTEMPTS: u32 = 3;
const RECENT_CONFIRMED: usize = 3;
const EVICT_EVERY_TICKS: u64 = 60;
const REPORT_EVERY_TICKS: u64 = 60;
pub const PROTOCOL: u8 = 1;

/// REST 최신 페이지를 만들 때 받는다. 셋은 같은 순간의 값이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubSnapshot {
    pub seq: u64,
    /// 시드를 받는 중이면 None.
    pub current: Option<CurrentBar>,
    /// 아직 캐시에 쓰이지 않았을 수 있는 최근 확정 봉. 오름차순.
    pub recent_confirmed: Vec<ConfirmedBar>,
}

#[derive(Clone)]
pub struct HubHandle {
    tx: mpsc::UnboundedSender<HubInput>,
    next_conn: Arc<AtomicU64>,
}

impl HubHandle {
    /// 연결을 등록한다. 허브가 `hello`를 그 연결의 outbox에 넣는다.
    pub fn connect(&self, outbox: Arc<Outbox>) -> ConnId {
        let conn = ConnId(self.next_conn.fetch_add(1, Ordering::SeqCst));
        self.send(HubInput::Connect { conn, outbox });
        conn
    }

    pub fn send_to(&self, conn: ConnId, message: ServerMessage) {
        self.send(HubInput::Direct { conn, message });
    }

    /// 답(`subscribed`, `sub_error`)은 그 연결의 outbox로 간다.
    pub fn subscribe(&self, conn: ConnId, sub: SubId, key: SeriesKey) {
        self.send(HubInput::Subscribe { conn, sub, key });
    }

    pub fn subscribe_feed(&self, conn: ConnId, sub: SubId, symbol: Symbol, kind: FeedKind, venue: Venue) {
        self.send(HubInput::SubscribeFeed { conn, sub, feed: FeedSub { symbol, kind, venue, requested_venue: venue } });
    }

    pub fn unsubscribe(&self, conn: ConnId, sub: SubId) {
        self.send(HubInput::Unsubscribe { conn, sub });
    }

    pub fn disconnect(&self, conn: ConnId) {
        self.send(HubInput::Disconnect(conn));
    }

    pub fn watch(&self, conn: ConnId, symbols: Vec<Symbol>, venue: Venue) {
        self.send(HubInput::Watch { conn, symbols, venue });
    }

    /// 실시간 집계 중인 키가 아니면 None.
    pub async fn snapshot(&self, key: SeriesKey) -> Option<HubSnapshot> {
        let (reply, rx) = oneshot::channel();
        self.send(HubInput::Snapshot { key, reply });
        rx.await.ok().flatten()
    }

    /// 07:45 `BarService::clear_all` 바로 뒤에 부른다. 모든 키를 다시 시드하고 `reload { daily_reset }`을 보낸다.
    pub fn daily_reset(&self) {
        self.send(HubInput::DailyReset);
    }

    pub fn source_switched(&self) {
        self.send(HubInput::SourceSwitched);
    }

    fn send(&self, input: HubInput) {
        if self.tx.send(input).is_err() {
            tracing::error!("MarketHub가 멈췄습니다");
        }
    }
}

enum HubInput {
    Connect { conn: ConnId, outbox: Arc<Outbox> },
    Direct { conn: ConnId, message: ServerMessage },
    Subscribe { conn: ConnId, sub: SubId, key: SeriesKey },
    SubscribeFeed { conn: ConnId, sub: SubId, feed: FeedSub },
    Unsubscribe { conn: ConnId, sub: SubId },
    Disconnect(ConnId),
    Watch { conn: ConnId, symbols: Vec<Symbol>, venue: Venue },
    Snapshot { key: SeriesKey, reply: oneshot::Sender<Option<HubSnapshot>> },
    DailyReset,
    SourceSwitched,
    Seeded { key: SeriesKey, generation: u64, result: Result<Seed, BarError> },
    Verified { key: SeriesKey, generation: u64, bucket: Bucket, attempt: u32, result: Result<Option<ConfirmedBar>, BarError> },
    DayVolumes { requests: Vec<(StockCode, u64)>, result: Result<HashMap<StockCode, DayVolumes>, SourceError> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeedPurpose {
    Initial,
    Reload { reason: ReloadReason, from: Option<KstTime> },
}

impl SeedPurpose {
    fn priority(self) -> Priority {
        match self {
            SeedPurpose::Initial => Priority::Screen,
            SeedPurpose::Reload { .. } => Priority::Recovery,
        }
    }
}

enum KeyFeed {
    Seeding { purpose: SeedPurpose, attempt: u32, reported: bool, last_dropped: Option<KstTime> },
    Live(Aggregator),
}

struct KeyState {
    generation: u64,
    feed: KeyFeed,
    seq: u64,
    recent_confirmed: VecDeque<ConfirmedBar>,
    verifications: BTreeMap<Bucket, Verification>,
    subs: BTreeSet<(ConnId, SubId)>,
    contiguous: bool,
    idle_since: Option<KstTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerificationPhase {
    Waiting { at: KstTime },
    InFlight,
    Exhausted,
    Complete,
}

struct Verification {
    last_published: Option<Ohlcv>,
    attempts: u32,
    phase: VerificationPhase,
}

impl Verification {
    fn failed(&mut self, now: KstTime) {
        self.phase = if self.attempts < VERIFY_ATTEMPTS {
            VerificationPhase::Waiting { at: now.plus_secs(VERIFY_DELAY_SECS * i64::from(self.attempts + 1)) }
        } else {
            VerificationPhase::Exhausted
        };
    }
}

impl KeyState {
    fn register_verification(&mut self, bucket: Bucket, last_published: Option<Ohlcv>, now: KstTime) {
        let verification = self.verifications.entry(bucket).or_insert(Verification {
            last_published,
            attempts: 0,
            phase: VerificationPhase::Waiting { at: bucket.confirm_at().max(now).plus_secs(VERIFY_DELAY_SECS) },
        });
        if verification.phase == VerificationPhase::Complete {
            return;
        }
        if last_published.is_some() {
            verification.last_published = last_published;
        }
    }

    fn note_published(&mut self, bucket: Bucket, ohlcv: Ohlcv) {
        if let Some(verification) = self.verifications.get_mut(&bucket)
            && verification.phase != VerificationPhase::Complete
        {
            verification.last_published = Some(ohlcv);
        }
    }

    fn current(&self) -> Option<CurrentBar> {
        match &self.feed {
            KeyFeed::Live(agg) => agg.current().copied(),
            KeyFeed::Seeding { .. } => None,
        }
    }

    fn is_backfilling(&self) -> bool {
        matches!(self.feed, KeyFeed::Seeding { purpose: SeedPurpose::Reload { reason: ReloadReason::GapFilled, .. }, .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FeedSub {
    symbol: Symbol,
    kind: FeedKind,
    venue: Venue,
    requested_venue: Venue,
}

impl FeedSub {
    fn holder(&self, conn: ConnId, sub: &SubId) -> Holder {
        Holder::Feed { conn, sub: sub.clone(), kind: stream_kind(self.kind, self.venue) }
    }
}

fn stream_kind(kind: FeedKind, venue: Venue) -> StreamKind {
    match kind {
        FeedKind::Trades => StreamKind::Trades,
        FeedKind::Book => StreamKind::Book(venue),
        FeedKind::Program => StreamKind::Program,
        FeedKind::Brokers => StreamKind::Brokers,
    }
}

struct Conn {
    outbox: Arc<Outbox>,
    subs: HashMap<SubId, SeriesKey>,
    feeds: HashMap<SubId, FeedSub>,
    requested_watch: Vec<Symbol>,
    watch_venue: Venue,
    limited_sent: BTreeSet<Symbol>,
}

#[derive(Debug, Default)]
struct Counters {
    outside_window: u64,
    from_future: u64,
    too_old: u64,
    unknown_exchange: u64,
    while_seeding: u64,
    late: u64,
    book_frames: u64,
    book_frames_with_blank_level: u64,
    book_frames_with_hole: u64,
}

fn has_hole(levels: &[Option<BookLevel>]) -> bool {
    levels.iter().skip_while(|level| level.is_some()).any(Option::is_some)
}

pub struct MarketHub {
    bars: Arc<BarService>,
    stream: Arc<dyn MarketStream>,
    clock: Clock,
    tx: mpsc::UnboundedSender<HubInput>,
    manager: SubscriptionManager,
    rejected: BTreeSet<Holder>,
    broker_history: BTreeMap<Symbol, (BrokerSnapshot, KstTime)>,
    first_after_hours: FirstOfDay,
    first_expected: FirstOfDay,
    tallies: DayTallies,
    directory: watch::Receiver<Option<Arc<Directory>>>,
    conns: HashMap<ConnId, Conn>,
    keys: HashMap<SeriesKey, KeyState>,
    next_generation: u64,
    session_live: bool,
    gap_from: Option<KstTime>,
    realtime: RealtimeState,
    realtime_since: KstTime,
    sent_status: Option<ConnectionStatus>,
    closing: Vec<ConnId>,
    counters: Counters,
    ticks: u64,
}

impl MarketHub {
    /// 허브 태스크를 띄운다. 키움 세션이 Live가 되기 전까지는 끊긴 상태로 본다.
    pub fn spawn(bars: Arc<BarService>, stream: Arc<dyn MarketStream>, events: mpsc::Receiver<StreamEvent>, clock: Clock) -> HubHandle {
        let (tx, rx) = mpsc::unbounded_channel();
        let now = clock.now();
        let manager = SubscriptionManager::new(stream.seat_rules());
        let hub = MarketHub {
            directory: bars.directory_updates(),
            bars,
            stream,
            clock,
            tx: tx.clone(),
            manager,
            rejected: BTreeSet::new(),
            broker_history: BTreeMap::new(),
            first_after_hours: FirstOfDay::default(),
            first_expected: FirstOfDay::default(),
            tallies: DayTallies::default(),
            conns: HashMap::new(),
            keys: HashMap::new(),
            next_generation: 0,
            session_live: false,
            gap_from: Some(now),
            realtime: RealtimeState::Reconnecting,
            realtime_since: now,
            sent_status: None,
            closing: Vec::new(),
            counters: Counters::default(),
            ticks: 0,
        };
        tokio::spawn(hub.run(rx, events));
        HubHandle { tx, next_conn: Arc::new(AtomicU64::new(1)) }
    }

    async fn run(mut self, mut inputs: mpsc::UnboundedReceiver<HubInput>, mut events: mpsc::Receiver<StreamEvent>) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut events_open = true;
        loop {
            tokio::select! {
                Some(input) = inputs.recv() => self.on_input(input),
                ev = events.recv(), if events_open => match ev {
                    Some(ev) => self.on_event(ev),
                    None => events_open = false,
                },
                _ = tick.tick() => self.on_tick(),
            }
            self.close_overflowed();
            self.publish_status();
        }
    }

    fn on_input(&mut self, input: HubInput) {
        let now = self.clock.now();
        match input {
            HubInput::Connect { conn, outbox } => {
                let hello = ServerMessage::Hello { protocol: PROTOCOL, server_time: UnixSeconds(now.unix()), status: self.status() };
                if outbox.push(hello).is_ok() {
                    self.conns.insert(conn, Conn { outbox, subs: HashMap::new(), feeds: HashMap::new(), requested_watch: Vec::new(), watch_venue: Venue::Combined, limited_sent: BTreeSet::new() });
                }
            }
            HubInput::Direct { conn, message } => {
                push(&self.conns, &mut self.closing, conn, message);
            }
            HubInput::Subscribe { conn, sub, key } => self.subscribe(conn, sub, key, now),
            HubInput::SubscribeFeed { conn, sub, feed } => self.subscribe_feed(conn, sub, feed, now),
            HubInput::Unsubscribe { conn, sub } => {
                if let Some(key) = self.conns.get_mut(&conn).and_then(|c| c.subs.remove(&sub)) {
                    self.release(conn, sub.clone(), key, now);
                    self.replan(now);
                }
                if let Some(feed) = self.conns.get_mut(&conn).and_then(|c| c.feeds.remove(&sub)) {
                    self.release_feed(conn, &sub, feed, now);
                    self.replan(now);
                }
            }
            HubInput::Disconnect(conn) => self.drop_conn(conn, now),
            HubInput::Watch { conn, symbols, venue } => self.watch(conn, symbols, venue, now),
            HubInput::Snapshot { key, reply } => {
                let snap = self.keys.get(&key).map(|ks| HubSnapshot {
                    seq: ks.seq,
                    current: ks.current(),
                    recent_confirmed: ks.recent_confirmed.iter().copied().collect(),
                });
                let _ = reply.send(snap);
            }
            HubInput::DailyReset => {
                self.broker_history.clear();
                tracing::info!(keys = self.keys.len(), "07:45 실시간 키를 모두 다시 시드합니다");
                self.reseed_all(SeedPurpose::Reload { reason: ReloadReason::DailyReset, from: None });
            }
            HubInput::SourceSwitched => {
                self.manager.reseat(self.stream.seat_rules());
                self.replan(now);
                self.broker_history.clear();
                tracing::info!(keys = self.keys.len(), "시세 공급원이 바뀌어 실시간 키를 모두 다시 시드합니다");
                self.reseed_all(SeedPurpose::Reload { reason: ReloadReason::DailyReset, from: None });
            }
            HubInput::Seeded { key, generation, result } => self.on_seeded(key, generation, result, now),
            HubInput::Verified { key, generation, bucket, attempt, result } => self.on_verified(key, generation, bucket, attempt, result, now),
            HubInput::DayVolumes { requests, result } => self.on_day_volumes(requests, result, now),
        }
    }

    fn subscribe(&mut self, conn: ConnId, sub: SubId, key: SeriesKey, now: KstTime) {
        let Some(c) = self.conns.get_mut(&conn) else {
            return;
        };
        if let Some(old) = c.subs.insert(sub.clone(), key) {
            self.release(conn, sub.clone(), old, now);
        }
        let holder = Holder::Cell { conn, sub: sub.clone() };
        self.manager.hold(key.feed.symbol(), holder.clone());
        self.replan(now);
        if !self.rejected.contains(&holder) {
            self.attach(conn, sub, key);
        }
    }

    fn subscribe_feed(&mut self, conn: ConnId, sub: SubId, feed: FeedSub, now: KstTime) {
        if !self.conns.contains_key(&conn) {
            return;
        }
        let error = match &*self.directory.borrow() {
            _ if !matches!(feed.symbol, Symbol::Stock(_)) => Some(SubErrorCode::BadRequest),
            Some(dir) if dir.get(feed.symbol).is_none() => Some(SubErrorCode::UnknownSymbol),
            _ => None,
        };
        if let Some(code) = error {
            push(&self.conns, &mut self.closing, conn, ServerMessage::SubError { sub: sub.0, code });
            return;
        }
        let feed = match feed.kind {
            FeedKind::Book => FeedSub { venue: self.effective_book_venue(feed), ..feed },
            _ => feed,
        };
        let old_cell = self.conns.get_mut(&conn).and_then(|c| c.subs.remove(&sub));
        let old_feed = self.conns.get_mut(&conn).and_then(|c| c.feeds.insert(sub.clone(), feed));
        if let Some(key) = old_cell {
            self.release(conn, sub.clone(), key, now);
        }
        if let Some(old) = old_feed {
            self.release_feed(conn, &sub, old, now);
        }
        let holder = feed.holder(conn, &sub);
        self.manager.hold(feed.symbol, holder.clone());
        self.replan(now);
        if !self.rejected.contains(&holder) {
            self.attach_feed(conn, &sub, feed);
        }
    }

    fn effective_book_venue(&self, feed: FeedSub) -> Venue {
        quotes::effective_book_venue(feed.requested_venue, self.directory.borrow().as_ref().and_then(|dir| dir.get(feed.symbol)).map(|info| info.nxt_enabled))
    }

    fn resettle_book_venues(&mut self, now: KstTime) {
        let moved: Vec<(ConnId, SubId, FeedSub, Venue)> = self
            .conns
            .iter()
            .flat_map(|(&conn, c)| c.feeds.iter().map(move |(sub, &feed)| (conn, sub, feed)))
            .filter(|(_, _, feed)| feed.kind == FeedKind::Book)
            .map(|(conn, sub, feed)| (conn, sub.clone(), feed, self.effective_book_venue(feed)))
            .filter(|(_, _, feed, venue)| feed.venue != *venue)
            .collect();
        for (conn, sub, old, venue) in moved {
            let feed = FeedSub { venue, ..old };
            if let Some(c) = self.conns.get_mut(&conn) {
                c.feeds.insert(sub.clone(), feed);
            }
            let was_rejected = self.rejected.contains(&old.holder(conn, &sub));
            self.release_feed(conn, &sub, old, now);
            self.manager.hold(feed.symbol, feed.holder(conn, &sub));
            if was_rejected {
                self.rejected.insert(feed.holder(conn, &sub));
            }
        }
    }

    fn release_feed(&mut self, conn: ConnId, sub: &SubId, feed: FeedSub, now: KstTime) {
        let holder = feed.holder(conn, sub);
        self.manager.release(feed.symbol, &holder, now);
        self.rejected.remove(&holder);
        if let Some(c) = self.conns.get(&conn) {
            c.outbox.forget_feed(sub);
        }
    }

    fn attach_feed(&mut self, conn: ConnId, sub: &SubId, feed: FeedSub) {
        push(&self.conns, &mut self.closing, conn, ServerMessage::FeedSubscribed { sub: sub.0.clone(), kind: feed.kind });
        if !self.session_live {
            let msg = ServerMessage::FeedLink { sub: sub.0.clone(), live: false, at: UnixSeconds(self.realtime_since.unix()) };
            push(&self.conns, &mut self.closing, conn, msg);
        }
        if feed.kind == FeedKind::Brokers
            && let Some((snapshot, received_at)) = self.broker_history.get(&feed.symbol)
        {
            let msg = ServerMessage::FeedBrokers { sub: sub.0.clone(), brokers: feed_brokers(snapshot, *received_at) };
            push(&self.conns, &mut self.closing, conn, msg);
        }
    }

    /// 구독 하나를 놓는다. 종목은 30초 더 받는다.
    fn release(&mut self, conn: ConnId, sub: SubId, key: SeriesKey, now: KstTime) {
        let holder = Holder::Cell { conn, sub: sub.clone() };
        self.manager.release(key.feed.symbol(), &holder, now);
        self.rejected.remove(&holder);
        if let Some(ks) = self.keys.get_mut(&key) {
            ks.subs.remove(&(conn, sub));
            if ks.subs.is_empty() {
                ks.idle_since = Some(now);
            }
        }
    }

    fn drop_conn(&mut self, conn: ConnId, now: KstTime) {
        let Some(c) = self.conns.remove(&conn) else {
            return;
        };
        c.outbox.close();
        for (sub, key) in c.subs {
            self.release(conn, sub, key, now);
        }
        for (sub, feed) in &c.feeds {
            self.rejected.remove(&feed.holder(conn, sub));
        }
        self.manager.release_conn(conn, now);
        self.replan(now);
    }

    fn watch(&mut self, conn: ConnId, symbols: Vec<Symbol>, venue: Venue, now: KstTime) {
        let Some(c) = self.conns.get_mut(&conn) else {
            return;
        };
        c.requested_watch = symbols;
        c.watch_venue = venue;
        self.stream.set_venue(venue);
        c.outbox.set_quote_venue(venue.into());
        self.hold_listed_watch_rows(conn, now);
        self.sync_day_volumes(now);
    }

    fn nxt_enabled(&self, symbol: Symbol) -> bool {
        self.directory.borrow().as_ref().and_then(|dir| dir.get(symbol)).is_some_and(|info| info.nxt_enabled)
    }

    fn sync_day_volumes(&mut self, now: KstTime) {
        let wanted: BTreeSet<StockCode> = self
            .conns
            .iter()
            .filter(|(_, c)| c.watch_venue != Venue::Combined)
            .flat_map(|(conn, _)| self.manager.admitted_watch(*conn))
            .filter_map(|s| match s {
                Symbol::Stock(code) if self.nxt_enabled(s) => Some(code),
                _ => None,
            })
            .collect();
        let due = self.tallies.take_due(&wanted, now);
        for chunk in due.chunks(quotes::DAY_VOLUME_CHUNK) {
            let (bars, tx) = (self.bars.clone(), self.tx.clone());
            let requests: Vec<(StockCode, u64)> = chunk.iter().map(|code| (*code, self.tallies.request(*code))).collect();
            tokio::spawn(async move {
                let codes: Vec<StockCode> = requests.iter().map(|(code, _)| *code).collect();
                let result = quotes::day_volumes(bars.source().as_ref(), &codes).await;
                let _ = tx.send(HubInput::DayVolumes { requests, result });
            });
        }
    }

    fn on_day_volumes(&mut self, requests: Vec<(StockCode, u64)>, result: Result<HashMap<StockCode, DayVolumes>, SourceError>, now: KstTime) {
        let mut volumes = match result {
            Ok(volumes) => volumes,
            Err(e) => {
                tracing::warn!(reason = %e, count = requests.len(), "거래소별 거래량의 시작 값을 받지 못했습니다. 다시 조회합니다");
                HashMap::new()
            }
        };
        for (code, request) in requests {
            self.tallies.seeded(code, request, volumes.remove(&code), now);
        }
    }

    fn hold_listed_watch_rows(&mut self, conn: ConnId, now: KstTime) {
        let Some(c) = self.conns.get(&conn) else {
            return;
        };
        let known: Vec<Symbol> = match &*self.directory.borrow() {
            Some(dir) => c.requested_watch.iter().copied().filter(|s| dir.get(*s).is_some()).collect(),
            None => Vec::new(),
        };
        self.manager.set_watch(conn, known, now);
    }

    fn close_overflowed(&mut self) {
        if self.closing.is_empty() {
            return;
        }
        let now = self.clock.now();
        for conn in std::mem::take(&mut self.closing) {
            tracing::warn!(conn = conn.0, "브라우저가 메시지를 제때 받지 못해 연결을 닫습니다");
            self.drop_conn(conn, now);
        }
    }

    fn attach(&mut self, conn: ConnId, sub: SubId, key: SeriesKey) {
        if !self.keys.contains_key(&key) {
            let generation = self.new_generation();
            self.keys.insert(
                key,
                KeyState {
                    generation,
                    feed: KeyFeed::Seeding { purpose: SeedPurpose::Initial, attempt: 0, reported: false, last_dropped: None },
                    seq: 0,
                    recent_confirmed: VecDeque::new(),
                    verifications: BTreeMap::new(),
                    subs: BTreeSet::new(),
                    contiguous: false,
                    idle_since: None,
                },
            );
            self.start_seed(key, Duration::ZERO);
        }
        let ks = self.keys.get_mut(&key).expect("방금 넣은 키");
        ks.subs.insert((conn, sub.clone()));
        ks.idle_since = None;
        let msg = ServerMessage::Subscribed { sub: sub.0, seq: ks.seq, current: ks.current().map(|c| api::Bar::new(c.bucket(), c.ohlcv())) };
        push(&self.conns, &mut self.closing, conn, msg);
    }

    fn replan(&mut self, now: KstTime) {
        let plan = self.manager.plan(now);
        self.broker_history.retain(|symbol, _| plan.feeds.get(symbol).is_some_and(|kinds| kinds.contains(&StreamKind::Brokers)));
        self.stream.set_desired(plan.feeds);
        let newly: Vec<Holder> = plan.rejected.difference(&self.rejected).cloned().collect();
        let recovered: Vec<Holder> = self.rejected.difference(&plan.rejected).cloned().collect();
        self.rejected = plan.rejected;
        for (conn, sub) in newly.iter().filter_map(feed_of) {
            push(&self.conns, &mut self.closing, conn, ServerMessage::SubError { sub: sub.0, code: SubErrorCode::RealtimeLimit });
        }
        for (conn, sub) in recovered.iter().filter_map(feed_of) {
            if let Some(feed) = self.conns.get(&conn).and_then(|c| c.feeds.get(&sub)).copied() {
                self.attach_feed(conn, &sub, feed);
            }
        }
        for (conn, sub) in newly.into_iter().filter_map(cell_of) {
            if let Some(key) = self.conns.get(&conn).and_then(|c| c.subs.get(&sub)).copied()
                && let Some(ks) = self.keys.get_mut(&key)
            {
                ks.subs.remove(&(conn, sub.clone()));
                if ks.subs.is_empty() {
                    ks.idle_since = Some(now);
                }
            }
            push(&self.conns, &mut self.closing, conn, ServerMessage::SubError { sub: sub.0, code: SubErrorCode::RealtimeLimit });
        }
        for (conn, sub) in recovered.into_iter().filter_map(cell_of) {
            if let Some(key) = self.conns.get(&conn).and_then(|c| c.subs.get(&sub)).copied() {
                self.attach(conn, sub, key);
            }
        }
        self.publish_limited();
    }

    fn publish_limited(&mut self) {
        for (&conn, c) in &mut self.conns {
            let limited: BTreeSet<Symbol> = c.requested_watch.iter().copied().filter(|&symbol| self.rejected.contains(&Holder::Watch { conn, symbol })).collect();
            if limited == c.limited_sent {
                continue;
            }
            let symbols = c.requested_watch.iter().filter(|s| limited.contains(s)).map(|s| api::SymbolCode(s.as_wire())).collect();
            c.limited_sent = limited;
            if c.outbox.push(ServerMessage::WatchLimited { symbols }).is_err() {
                self.closing.push(conn);
            }
        }
    }

    fn publish_quotes(&mut self, tick: &RealTick, at: KstTime) {
        let symbol = tick.symbol;
        let venue_volumes = match symbol {
            Symbol::Stock(code) if self.tallies.tracks(code) => {
                let fill = Fill { exchange: tick.exchange, qty: tick.qty.0, combined_cumulative: tick.day.map(|d| d.cumulative.0) };
                self.tallies.apply(code, fill, self.clock.now())
            }
            _ => None,
        };
        let mut watchers = self.manager.watchers(symbol).peekable();
        if watchers.peek().is_none() {
            return;
        }
        let Some(day) = tick.day else {
            return;
        };
        let Some(base_centi) = quotes::base_centi(tick.price, day.change_centi) else {
            return;
        };
        let nxt_enabled = self.nxt_enabled(symbol);
        for conn in watchers {
            let Some(c) = self.conns.get(&conn) else {
                continue;
            };
            let venue = match symbol {
                Symbol::Stock(_) => quotes::effective_venue(c.watch_venue, nxt_enabled),
                Symbol::Index(_) => Venue::Combined,
            };
            let volume = match venue {
                Venue::Combined => Some(day.cumulative.0),
                Venue::Krx if tick.exchange != Some(Exchange::Krx) => None,
                Venue::Krx if !nxt_enabled => Some(day.cumulative.0),
                Venue::Krx => venue_volumes.map(|v| v.krx),
                Venue::Nxt if tick.exchange != Some(Exchange::Nxt) => None,
                Venue::Nxt => venue_volumes.map(|v| v.nxt),
            };
            if let Some(volume) = volume {
                c.outbox.set_quote(quotes::realtime(symbol, venue, tick.price, base_centi, volume, at));
            }
        }
    }

    fn new_generation(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }

    fn start_seed(&self, key: SeriesKey, delay: Duration) {
        let Some(ks) = self.keys.get(&key) else {
            return;
        };
        let KeyFeed::Seeding { purpose, .. } = ks.feed else {
            return;
        };
        let (generation, bars, tx) = (ks.generation, self.bars.clone(), self.tx.clone());
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let result = bars.seed(key, purpose.priority()).await;
            let _ = tx.send(HubInput::Seeded { key, generation, result });
        });
    }

    fn reseed_all(&mut self, purpose: SeedPurpose) {
        let keys: Vec<SeriesKey> = self.keys.keys().copied().collect();
        for key in keys {
            let ks = self.keys.get_mut(&key).expect("방금 본 키");
            let gap_fill = matches!(purpose, SeedPurpose::Reload { reason: ReloadReason::GapFilled, .. });
            if gap_fill && matches!(ks.feed, KeyFeed::Seeding { purpose: SeedPurpose::Reload { reason: ReloadReason::DailyReset, .. }, .. }) {
                continue;
            }
            let generation = self.new_generation();
            let ks = self.keys.get_mut(&key).expect("방금 본 키");
            if matches!(purpose, SeedPurpose::Reload { reason: ReloadReason::DailyReset, .. }) {
                ks.verifications.clear();
            } else {
                for verification in ks.verifications.values_mut() {
                    if verification.phase == VerificationPhase::InFlight {
                        verification.failed(self.clock.now());
                    }
                }
            }
            ks.generation = generation;
            ks.feed = KeyFeed::Seeding { purpose, attempt: 0, reported: false, last_dropped: None };
            ks.contiguous = false;
            self.start_seed(key, Duration::ZERO);
        }
        self.finish_gap_if_done();
    }

    fn on_seeded(&mut self, key: SeriesKey, generation: u64, result: Result<Seed, BarError>, now: KstTime) {
        let Some(ks) = self.keys.get_mut(&key).filter(|ks| ks.generation == generation) else {
            return;
        };
        let KeyFeed::Seeding { purpose, attempt, reported, last_dropped } = ks.feed else {
            return;
        };
        match result {
            Ok(seed) => {
                let mut agg = start_aggregator(key, &seed, now).trades_dropped_until(last_dropped);
                if let Some((bucket, _)) = ks.verifications.iter().rev().find(|(_, v)| v.phase == VerificationPhase::Complete) {
                    agg.confirm_through(*bucket);
                }
                let current = agg.current().copied();
                ks.feed = KeyFeed::Live(agg);
                ks.contiguous = self.session_live;
                ks.recent_confirmed.clear();
                match purpose {
                    SeedPurpose::Initial => {
                        if let Some(c) = current {
                            ks.note_published(c.bucket(), *c.ohlcv());
                            ks.seq += 1;
                            set_bar(&self.conns, &ks.subs, ks.seq, &c);
                        }
                    }
                    SeedPurpose::Reload { reason, from } => {
                        ks.seq += 1;
                        let (seq, from) = (ks.seq, from.map(|t| UnixSeconds(t.unix())));
                        emit(&self.conns, &mut self.closing, &ks.subs, |sub| ServerMessage::Reload { sub, seq, reason, from });
                    }
                }
                self.finish_gap_if_done();
            }
            Err(e @ (BarError::UnknownSymbol | BarError::BadRequest(_))) => {
                let code = if e == BarError::UnknownSymbol { SubErrorCode::UnknownSymbol } else { SubErrorCode::BadRequest };
                tracing::info!(symbol = %key.feed.symbol().as_wire(), error = %e, "구독을 받을 수 없는 키입니다");
                let ks = self.keys.remove(&key).expect("방금 본 키");
                for (conn, sub) in ks.subs {
                    if let Some(c) = self.conns.get_mut(&conn) {
                        c.subs.remove(&sub);
                    }
                    self.manager.forget(key.feed.symbol(), &Holder::Cell { conn, sub: sub.clone() });
                    push(&self.conns, &mut self.closing, conn, ServerMessage::SubError { sub: sub.0, code });
                }
                self.replan(now);
                self.finish_gap_if_done();
            }
            Err(e) => {
                let delay = Duration::from_secs(SEED_RETRY_SECS[(attempt as usize).min(SEED_RETRY_SECS.len() - 1)]);
                tracing::warn!(symbol = %key.feed.symbol().as_wire(), period = key.period.as_wire(), error = %e, retry_secs = delay.as_secs(), "실시간 시드를 받지 못했습니다. 다시 받습니다");
                if purpose == SeedPurpose::Initial && !reported {
                    emit(&self.conns, &mut self.closing, &ks.subs, |sub| ServerMessage::SubError { sub, code: SubErrorCode::KiwoomUnavailable });
                }
                ks.feed = KeyFeed::Seeding { purpose, attempt: attempt + 1, reported: reported || purpose == SeedPurpose::Initial, last_dropped };
                self.start_seed(key, delay);
            }
        }
    }

    fn on_verified(&mut self, key: SeriesKey, generation: u64, bucket: Bucket, attempt: u32, result: Result<Option<ConfirmedBar>, BarError>, now: KstTime) {
        let Some(ks) = self.keys.get_mut(&key).filter(|ks| ks.generation == generation && matches!(ks.feed, KeyFeed::Live(_))) else {
            return;
        };
        let Some(verification) = ks.verifications.get_mut(&bucket).filter(|v| v.attempts == attempt && v.phase == VerificationPhase::InFlight) else {
            return;
        };
        match result {
            Ok(Some(k)) => {
                let changed = verification.last_published != Some(k.ohlcv);
                let retired_current = match &mut ks.feed {
                    KeyFeed::Live(agg) => agg.confirm_through(bucket),
                    KeyFeed::Seeding { .. } => unreachable!(),
                };
                if let Some(r) = ks.recent_confirmed.iter_mut().find(|b| b.bucket == bucket) {
                    *r = k;
                }
                verification.last_published = Some(k.ohlcv);
                verification.phase = VerificationPhase::Complete;
                if changed || retired_current {
                    ks.seq += 1;
                    let (seq, from) = (ks.seq, Some(UnixSeconds(bucket.start().unix())));
                    emit(&self.conns, &mut self.closing, &ks.subs, |sub| ServerMessage::Reload { sub, seq, reason: ReloadReason::Replaced, from });
                }
            }
            result => {
                verification.failed(now);
                if verification.phase == VerificationPhase::Exhausted {
                    tracing::info!(symbol = %key.feed.symbol().as_wire(), period = key.period.as_wire(), error = ?result.err(), "불완전한 봉을 키움 값과 대조하지 못했습니다");
                }
            }
        }
    }

    fn finish_gap_if_done(&mut self) {
        if self.session_live && self.gap_from.is_some() && !self.keys.values().any(KeyState::is_backfilling) {
            self.gap_from = None;
        }
    }

    fn on_event(&mut self, ev: StreamEvent) {
        match ev {
            StreamEvent::Tick { tick, received_at } => self.on_trade(tick, received_at),
            StreamEvent::Book { book, received_at } => self.on_book(&book, received_at),
            StreamEvent::Program { row, received_at } => self.on_program(&row, received_at),
            StreamEvent::Broker { snapshot, received_at } => self.on_broker(snapshot, received_at),
            StreamEvent::AfterHours { totals, received_at } => self.on_after_hours(&totals, received_at),
            StreamEvent::Down { at } => {
                self.publish_feed_link(false, at);
                let from = *self.gap_from.get_or_insert(at);
                self.session_down(RealtimeState::Reconnecting, from);
            }
            StreamEvent::Idle => {
                let now = self.clock.now();
                self.publish_feed_link(false, now);
                self.gap_from.get_or_insert(now);
                self.session_down(RealtimeState::NotConnected, now);
            }
            StreamEvent::Halted => {
                let now = self.clock.now();
                self.publish_feed_link(false, now);
                self.gap_from.get_or_insert(now);
                self.session_down(RealtimeState::Halted, now);
            }
            StreamEvent::Live { since } => {
                self.publish_feed_link(true, since);
                self.session_live = true;
                self.realtime = RealtimeState::Live;
                self.realtime_since = since;
                match self.gap_from {
                    Some(from) if gap_overlaps_trading(from, since) && !self.keys.is_empty() => {
                        tracing::info!(%from, %since, keys = self.keys.len(), "끊긴 구간을 키움 조회로 메웁니다");
                        self.reseed_all(SeedPurpose::Reload { reason: ReloadReason::GapFilled, from: Some(from) });
                    }
                    _ => {
                        self.gap_from = None;
                        for ks in self.keys.values_mut() {
                            ks.contiguous = matches!(ks.feed, KeyFeed::Live(_));
                        }
                    }
                }
            }
        }
    }

    fn feed_targets(&self, symbol: Symbol, kind: FeedKind) -> Vec<(ConnId, SubId)> {
        let mut targets = Vec::new();
        for (&conn, c) in &self.conns {
            for (sub, feed) in &c.feeds {
                if feed.symbol == symbol && feed.kind == kind && (self.rejected.is_empty() || !self.rejected.contains(&feed.holder(conn, sub))) {
                    targets.push((conn, sub.clone()));
                }
            }
        }
        targets
    }

    fn publish_feed_trade(&mut self, tick: &RealTick, at: KstTime) {
        let qty = i64::try_from(tick.qty.0).unwrap_or(i64::MAX);
        let trade = api::FeedTrade {
            t: UnixSeconds(at.unix()),
            price: won(tick.price),
            qty: if tick.side == Some(TradeSide::Sell) { -qty } else { qty },
            venue: tick.exchange.map(|exchange| match exchange {
                Exchange::Krx => api::Venue::Krx,
                Exchange::Nxt => api::Venue::Nxt,
            }),
            strength: tick.strength_centi.map(|centi| centi as f64 / 100.0),
        };
        for (conn, sub) in self.feed_targets(tick.symbol, FeedKind::Trades) {
            let Some(c) = self.conns.get(&conn) else {
                continue;
            };
            if venue_takes(c.feeds[&sub].venue, tick.exchange) && c.outbox.add_trade(&sub, trade.clone()).is_err() {
                self.closing.push(conn);
            }
        }
    }

    fn on_book(&mut self, book: &BookSnapshot, received_at: KstTime) {
        self.counters.book_frames += 1;
        let sides = [&book.asks[..], &book.bids[..]];
        if sides.iter().any(|levels| levels.iter().any(Option::is_none)) {
            self.counters.book_frames_with_blank_level += 1;
        }
        if sides.iter().any(|levels| has_hole(levels)) {
            self.counters.book_frames_with_hole += 1;
        }
        if let Some(expected) = book.expected
            && self.first_expected.first(book.symbol, received_at.kst_date())
        {
            tracing::info!(symbol = %book.symbol.as_wire(), hhmmss = %book.hhmmss, price = %won(expected.price), qty = expected.qty.0, "예상체결 첫 수신");
        }
        let message = feed_book(book, received_at);
        for (conn, sub) in self.feed_targets(book.symbol, FeedKind::Book) {
            if let Some(c) = self.conns.get(&conn)
                && c.feeds[&sub].venue == book.venue
            {
                c.outbox.set_book(&sub, message.clone());
            }
        }
    }

    fn on_after_hours(&mut self, totals: &AfterHoursTotals, received_at: KstTime) {
        if self.first_after_hours.first(totals.symbol, received_at.kst_date()) {
            tracing::info!(symbol = %totals.symbol.as_wire(), hhmmss = %totals.hhmmss, ask_qty = totals.total_ask_qty.0, bid_qty = totals.total_bid_qty.0, "0E 첫 수신");
        }
        let message = api::FeedAfterHoursTotals { t: feed_time(received_at, totals.hhmmss), ask_qty: totals.total_ask_qty.0, bid_qty: totals.total_bid_qty.0 };
        for (conn, sub) in self.feed_targets(totals.symbol, FeedKind::Book) {
            let msg = ServerMessage::FeedAfterHours { sub: sub.0, totals: message };
            push(&self.conns, &mut self.closing, conn, msg);
        }
    }

    fn on_program(&mut self, row: &RealProgramTrade, received_at: KstTime) {
        let message = feed_program(row, received_at);
        for (conn, sub) in self.feed_targets(row.symbol, FeedKind::Program) {
            let msg = ServerMessage::FeedProgram { sub: sub.0, row: message.clone() };
            push(&self.conns, &mut self.closing, conn, msg);
        }
    }

    fn on_broker(&mut self, snapshot: BrokerSnapshot, received_at: KstTime) {
        let message = feed_brokers(&snapshot, received_at);
        for (conn, sub) in self.feed_targets(snapshot.symbol, FeedKind::Brokers) {
            let msg = ServerMessage::FeedBrokers { sub: sub.0, brokers: message.clone() };
            push(&self.conns, &mut self.closing, conn, msg);
        }
        self.broker_history.insert(snapshot.symbol, (snapshot, received_at));
    }

    fn publish_feed_link(&mut self, live: bool, at: KstTime) {
        if self.session_live == live {
            return;
        }
        let subs: Vec<(ConnId, SubId)> =
            self.conns.iter().flat_map(|(&conn, c)| c.feeds.keys().map(move |sub| (conn, sub.clone()))).collect();
        for (conn, sub) in subs {
            let msg = ServerMessage::FeedLink { sub: sub.0, live, at: UnixSeconds(at.unix()) };
            push(&self.conns, &mut self.closing, conn, msg);
        }
    }

    fn session_down(&mut self, state: RealtimeState, since: KstTime) {
        self.session_live = false;
        self.realtime = state;
        self.realtime_since = since;
        for ks in self.keys.values_mut() {
            ks.contiguous = false;
        }
    }

    fn on_trade(&mut self, tick: RealTick, received_at: KstTime) {
        let at = match resolve_trade_time(received_at, tick.hhmmss) {
            Ok(at) => at,
            Err(e) => {
                match e {
                    TradeTimeError::OutsideTradingWindow => self.counters.outside_window += 1,
                    TradeTimeError::FromFuture => self.counters.from_future += 1,
                    TradeTimeError::TooOld => self.counters.too_old += 1,
                }
                return;
            }
        };
        if matches!(tick.symbol, Symbol::Stock(_)) && tick.exchange.is_none() {
            self.counters.unknown_exchange += 1;
        }
        self.publish_quotes(&tick, at);
        self.publish_feed_trade(&tick, at);
        let trade = Trade { at, price: tick.price, qty: tick.qty };
        let now = self.clock.now();
        for (key, ks) in self.keys.iter_mut().filter(|(k, _)| k.feed.symbol() == tick.symbol && accepts(k.feed, tick.exchange)) {
            let agg = match &mut ks.feed {
                KeyFeed::Live(agg) => agg,
                KeyFeed::Seeding { last_dropped, .. } => {
                    *last_dropped = (*last_dropped).max(Some(at));
                    ks.register_verification(key.period.trade_bucket(at), None, now);
                    self.counters.while_seeding += 1;
                    continue;
                }
            };
            match agg.apply(&trade) {
                Applied::Updated => {
                    let cur = *agg.current().expect("반영했으면 현재 봉이 있다");
                    ks.note_published(cur.bucket(), *cur.ohlcv());
                    ks.seq += 1;
                    set_bar(&self.conns, &ks.subs, ks.seq, &cur);
                }
                Applied::Rolled { confirmed } => {
                    let cur = *agg.current().expect("넘겼으면 새 현재 봉이 있다");
                    on_confirmed(&self.bars, &self.conns, &mut self.closing, *key, ks, confirmed, now);
                    ks.note_published(cur.bucket(), *cur.ohlcv());
                    ks.seq += 1;
                    set_bar(&self.conns, &ks.subs, ks.seq, &cur);
                }
                Applied::Ignored(_) => self.counters.late += 1,
            }
        }
    }

    fn on_tick(&mut self) {
        let now = self.clock.now();
        for (key, ks) in self.keys.iter_mut() {
            let KeyFeed::Live(agg) = &mut ks.feed else {
                continue;
            };
            if let Some(confirmed) = agg.close_if_due(now) {
                on_confirmed(&self.bars, &self.conns, &mut self.closing, *key, ks, confirmed, now);
            }
            for (bucket, verification) in &mut ks.verifications {
                if matches!(verification.phase, VerificationPhase::Waiting { at } if at <= now) {
                    verification.attempts += 1;
                    verification.phase = VerificationPhase::InFlight;
                    spawn_verify(&self.bars, &self.tx, *key, ks.generation, *bucket, verification.attempts);
                }
            }
        }
        if self.directory.has_changed().unwrap_or(false) {
            self.directory.borrow_and_update();
            self.resettle_book_venues(now);
            let conns: Vec<ConnId> = self.conns.keys().copied().collect();
            for conn in conns {
                self.hold_listed_watch_rows(conn, now);
            }
        }
        self.replan(now);
        self.sync_day_volumes(now);
        let manager = &self.manager;
        self.keys.retain(|key, ks| {
            !ks.subs.is_empty()
                || (manager.is_admitted(key.feed.symbol()) && ks.idle_since.is_none_or(|t| now < t.plus_secs(super::subscriptions::RELEASE_GRACE_SECS)))
        });
        self.finish_gap_if_done();
        self.ticks += 1;
        if self.ticks.is_multiple_of(EVICT_EVERY_TICKS) {
            self.bars.evict_idle(&self.keys.keys().copied().collect::<HashSet<_>>());
        }
        if self.ticks.is_multiple_of(REPORT_EVERY_TICKS) {
            self.report();
        }
    }

    fn report(&mut self) {
        let c = std::mem::take(&mut self.counters);
        if c.outside_window + c.from_future + c.too_old > 0 {
            tracing::warn!(outside_window = c.outside_window, from_future = c.from_future, too_old = c.too_old, "지난 1분 동안 체결시간이 맞지 않는 체결을 버렸습니다");
        }
        if c.unknown_exchange + c.while_seeding + c.late > 0 {
            tracing::info!(unknown_exchange = c.unknown_exchange, while_seeding = c.while_seeding, late = c.late, "지난 1분 동안의 실시간 체결 카운터");
        }
        if c.book_frames_with_blank_level > 0 {
            tracing::info!(book_frames = c.book_frames, with_blank_level = c.book_frames_with_blank_level, with_hole = c.book_frames_with_hole, "지난 1분 동안 가격이 빈 호가 단이 있는 0D 프레임 카운터");
        }
    }

    fn status(&self) -> ConnectionStatus {
        ConnectionStatus {
            realtime: self.realtime,
            since: UnixSeconds(self.realtime_since.unix()),
            backfilling: self.keys.values().any(KeyState::is_backfilling),
        }
    }

    fn publish_status(&mut self) {
        let status = self.status();
        if self.sent_status == Some(status) {
            return;
        }
        let first = self.sent_status.is_none();
        self.sent_status = Some(status);
        if first {
            return;
        }
        for (conn, c) in &self.conns {
            if c.outbox.push(ServerMessage::Status { status }).is_err() {
                self.closing.push(*conn);
            }
        }
    }
}

fn start_aggregator(key: SeriesKey, seed: &Seed, now: KstTime) -> Aggregator {
    let newest = seed.tail.last().map(|b| b.bucket);
    match seed.current {
        Some(c) if !c.bucket.is_confirmed_at(now) => Aggregator::new(key.period, Some(CurrentBar::seed(c.bucket, c.ohlcv)), newest),
        Some(c) => Aggregator::new(key.period, None, newest.max(Some(c.bucket))),
        None => Aggregator::new(key.period, None, newest),
    }
}

fn accepts(feed: Feed, exchange: Option<Exchange>) -> bool {
    match feed {
        Feed::Index(_) | Feed::Stock(_, Venue::Combined) => true,
        Feed::Stock(_, Venue::Krx) => exchange == Some(Exchange::Krx),
        Feed::Stock(_, Venue::Nxt) => exchange == Some(Exchange::Nxt),
    }
}

fn gap_overlaps_trading(from: KstTime, to: KstTime) -> bool {
    let mut d = from.kst_date();
    while d <= to.kst_date() {
        let open = KstTime::from_kst_civil(d, TRADING_OPEN);
        let close = KstTime::from_kst_civil(d, SESSION_CLOSE).plus_secs(CLOSE_GRACE_SECS);
        if from < close && open < to {
            return true;
        }
        d = d.add_days(1);
    }
    false
}

fn on_confirmed(
    bars: &Arc<BarService>,
    conns: &HashMap<ConnId, Conn>,
    closing: &mut Vec<ConnId>,
    key: SeriesKey,
    ks: &mut KeyState,
    confirmed: ConfirmedBar,
    now: KstTime,
) {
    ks.note_published(confirmed.bucket, confirmed.ohlcv);
    ks.seq += 1;
    let (seq, bar) = (ks.seq, api::Bar::from(&confirmed));
    emit(conns, closing, &ks.subs, |sub| ServerMessage::Confirmed { sub, seq, bar });
    if ks.recent_confirmed.len() == RECENT_CONFIRMED {
        ks.recent_confirmed.pop_front();
    }
    ks.recent_confirmed.push_back(confirmed);
    if ks.contiguous {
        let bars = bars.clone();
        tokio::spawn(async move {
            let appended = bars.append_realtime(key, confirmed).await;
            tracing::debug!(symbol = %key.feed.symbol().as_wire(), period = key.period.as_wire(), ?appended, "실시간 확정 봉을 캐시에 붙였습니다");
        });
    }
    if confirmed.needs_verify {
        ks.register_verification(confirmed.bucket, Some(confirmed.ohlcv), now);
    }
}

fn spawn_verify(bars: &Arc<BarService>, tx: &mpsc::UnboundedSender<HubInput>, key: SeriesKey, generation: u64, bucket: Bucket, attempt: u32) {
    let (bars, tx) = (bars.clone(), tx.clone());
    tokio::spawn(async move {
        let result = bars.verify_confirmed(key, bucket).await;
        let _ = tx.send(HubInput::Verified { key, generation, bucket, attempt, result });
    });
}

fn won(price: Price) -> f64 {
    price.centi() as f64 / 100.0
}

#[derive(Debug, Default)]
struct FirstOfDay {
    day: Option<KstDate>,
    seen: BTreeSet<Symbol>,
}

impl FirstOfDay {
    fn first(&mut self, symbol: Symbol, today: KstDate) -> bool {
        if self.day != Some(today) {
            self.day = Some(today);
            self.seen.clear();
        }
        self.seen.insert(symbol)
    }
}

fn feed_time(received_at: KstTime, hhmmss: TimeOfDay) -> UnixSeconds {
    UnixSeconds(resolve_trade_time(received_at, hhmmss).unwrap_or(received_at).unix())
}

fn venue_takes(requested: Venue, exchange: Option<Exchange>) -> bool {
    match requested {
        Venue::Combined => true,
        Venue::Krx => exchange == Some(Exchange::Krx),
        Venue::Nxt => exchange == Some(Exchange::Nxt),
    }
}

fn feed_book(book: &BookSnapshot, received_at: KstTime) -> api::FeedBook {
    let side = |levels: &[Option<BookLevel>]| levels.iter().map(|l| l.map(|l| api::FeedBookLevel { price: won(l.price), qty: l.qty.0 })).collect();
    api::FeedBook {
        t: feed_time(received_at, book.hhmmss),
        asks: side(&book.asks),
        bids: side(&book.bids),
        total_ask_qty: book.total_ask_qty.0,
        total_bid_qty: book.total_bid_qty.0,
        expected: book.expected.map(|e| api::FeedExpected { price: won(e.price), qty: e.qty.0 }),
    }
}

fn feed_program(row: &RealProgramTrade, received_at: KstTime) -> api::FeedProgramRow {
    api::FeedProgramRow {
        t: feed_time(received_at, row.hhmmss),
        price: row.price.map(won),
        sell_qty: row.sell_qty.0,
        sell_amount: row.sell_amount_million_won,
        buy_qty: row.buy_qty.0,
        buy_amount: row.buy_amount_million_won,
        net_qty: row.net_buy_qty,
        net_qty_change: row.net_buy_qty_change,
        net_amount: row.net_buy_amount_million_won,
        net_amount_change: row.net_buy_amount_change_million_won,
    }
}

fn feed_brokers(snapshot: &BrokerSnapshot, at: KstTime) -> api::FeedBrokers {
    let side = |entries: &[BrokerEntry]| entries.iter().map(|e| api::FeedBroker { code: e.member_code.clone(), name: e.member_name.clone(), qty: e.cumulative_qty.0, qty_change: e.change_qty }).collect();
    api::FeedBrokers { t: UnixSeconds(at.unix()), sells: side(&snapshot.sells), buys: side(&snapshot.buys) }
}

fn cell_of(h: Holder) -> Option<(ConnId, SubId)> {
    match h {
        Holder::Cell { conn, sub } => Some((conn, sub)),
        Holder::Watch { .. } | Holder::Feed { .. } => None,
    }
}

fn feed_of(h: &Holder) -> Option<(ConnId, SubId)> {
    match h {
        Holder::Feed { conn, sub, .. } => Some((*conn, sub.clone())),
        Holder::Cell { .. } | Holder::Watch { .. } => None,
    }
}

fn push(conns: &HashMap<ConnId, Conn>, closing: &mut Vec<ConnId>, conn: ConnId, msg: ServerMessage) {
    if let Some(c) = conns.get(&conn)
        && c.outbox.push(msg).is_err()
    {
        closing.push(conn);
    }
}

fn emit(conns: &HashMap<ConnId, Conn>, closing: &mut Vec<ConnId>, subs: &BTreeSet<(ConnId, SubId)>, msg: impl Fn(String) -> ServerMessage) {
    for (conn, sub) in subs {
        push(conns, closing, *conn, msg(sub.0.clone()));
    }
}

fn set_bar(conns: &HashMap<ConnId, Conn>, subs: &BTreeSet<(ConnId, SubId)>, seq: u64, cur: &CurrentBar) {
    let bar = api::Bar::new(cur.bucket(), cur.ohlcv());
    for (conn, sub) in subs {
        if let Some(c) = conns.get(conn) {
            c.outbox.set_bar(sub, seq, bar);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use domain::{BarSource, KstDate, Market, Period, Price, StockCode, SymbolInfo, SymbolKind, TimeOfDay, Volume};
    use serde_json::json;

    use super::*;
    use crate::api::Bar;
    use crate::clock::kst;
    use crate::config::Secret;
    use crate::kiwoom::api::ApiId;
    use crate::kiwoom::api::kiwoom_stock_code;
    use crate::kiwoom::stream::{KIWOOM_REALTIME_LIMIT as REALTIME_LIMIT, KiwoomSeats, KiwoomStream};
    use crate::market_source::stream::{DayTotals, DesiredFeeds, SeatRules, trades_only};
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::rest::KiwoomRest;
    use crate::kiwoom::rest::testing::{FakeTransport, ok, status, token};
    use crate::market::outbox::Outbox;
    use crate::symbols::SymbolDirectory;

    const SAMSUNG: &str = "005930";
    const NEXTRADE_EXCLUDED: &str = "005935";
    const UNLISTED: &str = "000020";

    fn at(h: u32, m: u32, s: u32) -> KstTime {
        kst(KstDate::new(2026, 11, 9).unwrap(), h, m, s)
    }

    #[derive(Default)]
    struct Chart {
        rows: Vec<(KstTime, [u64; 5])>,
        answer_503_times: usize,
        page_size: Option<usize>,
        fail_at: Option<usize>,
        repeat_page: bool,
    }

    impl Chart {
        fn set(&mut self, start: KstTime, row: [u64; 5]) {
            self.rows.retain(|(t, _)| *t != start);
            self.rows.push((start, row));
            self.rows.sort_by_key(|(t, _)| *t);
        }
    }

    struct Harness {
        day_volumes: Arc<Mutex<HashMap<String, u64>>>,
        hub: HubHandle,
        events: mpsc::Sender<StreamEvent>,
        desired: watch::Receiver<DesiredFeeds>,
        bars: Arc<BarService>,
        symbols: Arc<SymbolDirectory>,
        chart: Arc<Mutex<Chart>>,
        fake: Arc<FakeTransport>,
        clock: Clock,
    }

    fn morning_chart() -> Chart {
        let mut c = Chart::default();
        c.set(at(8, 58, 0), [90, 95, 85, 92, 10]);
        c.set(at(8, 59, 0), [92, 99, 91, 98, 20]);
        c.set(at(9, 0, 0), [100, 110, 95, 105, 50]);
        c
    }

    fn harness(start: KstTime, chart: Chart, latency: Duration) -> Harness {
        period_harness(start, chart, latency, Period::M1)
    }

    fn period_harness(start: KstTime, chart: Chart, latency: Duration, period: Period) -> Harness {
        let harness = period_harness_without_directory(start, chart, latency, period);
        harness.symbols.replace(listed_directory());
        harness
    }

    fn listed_directory() -> Directory {
        let stock = |code: &str, nxt_enabled| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: code.into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled };
        let mut listed = vec![stock(SAMSUNG, true), stock(NEXTRADE_EXCLUDED, false)];
        listed.extend((0..REALTIME_LIMIT).map(|i| stock(&listed_filler(i), false)));
        Directory::build(listed)
    }

    fn period_harness_without_directory(start: KstTime, chart: Chart, latency: Duration, period: Period) -> Harness {
        let chart = Arc::new(Mutex::new(chart));
        let script = chart.clone();
        let day_volumes = Arc::new(Mutex::new(volumes(1_000, 700, Some(300))));
        let volumes = day_volumes.clone();
        let fake = Arc::new(FakeTransport::new(latency, move |s| {
            if s.api_id == ApiId::Au10001 {
                return token(1);
            }
            if s.api_id == ApiId::Ka10095 {
                let body: serde_json::Value = serde_json::from_str(&s.body).unwrap();
                let volumes = volumes.lock().unwrap();
                let rows: Vec<_> = body["stk_cd"]
                    .as_str()
                    .unwrap()
                    .split('|')
                    .filter_map(|code| {
                        let volume = volumes.get(code)?;
                        Some(json!({"stk_cd": code, "cur_prc": "100", "base_pric": "100", "pred_pre_sig": "3", "trde_qty": volume.to_string(), "cntr_tm": "090050", "dt": "20261109"}))
                    })
                    .collect();
                return ok(json!({"atn_stk_infr": rows, "return_code": 0}), None);
            }
            let (api, field) = match period {
                Period::Quarter => (ApiId::Ka10083, "stk_mth_pole_chart_qry"),
                Period::Year => (ApiId::Ka10094, "stk_yr_pole_chart_qry"),
                _ => (ApiId::Ka10080, "stk_min_pole_chart_qry"),
            };
            assert_eq!(s.api_id, api);
            let mut c = script.lock().unwrap();
            let offset: usize = if c.repeat_page { 0 } else { s.cont.as_deref().unwrap_or("0").parse().unwrap() };
            if c.fail_at == Some(offset) {
                return status(503, json!({}));
            }
            if c.answer_503_times > 0 {
                c.answer_503_times -= 1;
                return status(503, json!({}));
            }
            let rows: Vec<_> = c
                .rows
                .iter()
                .rev()
                .skip(offset)
                .take(c.page_size.unwrap_or(usize::MAX))
                .map(|(t, [o, h, l, cl, v])| {
                    let tod = t.kst_time_of_day().secs();
                    let mut row = json!({"cntr_tm": format!("{}{:02}{:02}00", t.kst_date().yyyymmdd(), tod / 3600, tod / 60 % 60),
                           "open_pric": o.to_string(), "high_pric": h.to_string(), "low_pric": l.to_string(), "cur_prc": cl.to_string(), "trde_qty": v.to_string()});
                    if !period.is_intraday() {
                        row["dt"] = t.kst_date().yyyymmdd().into();
                    }
                    row
                })
                .collect();
            let next = if c.repeat_page { Some("1".to_owned()) } else { (offset + rows.len() < c.rows.len()).then(|| (offset + rows.len()).to_string()) };
            ok(json!({field: rows, "return_code": 0}), next.as_deref())
        }));
        let clock = Clock::fake(start);
        let rest = KiwoomRest::new(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let bars = Arc::new(BarService::new(rest, symbols.clone(), clock.clone()));
        let (stream, desired) = KiwoomStream::detached();
        let (events, rx) = mpsc::channel(64);
        let hub = MarketHub::spawn(bars.clone(), Arc::new(stream), rx, clock.clone());
        Harness { day_volumes, hub, events, desired, bars, symbols, chart, fake, clock }
    }

    fn std_harness() -> Harness {
        harness(at(9, 0, 50), morning_chart(), Duration::ZERO)
    }

    fn listed_filler(i: usize) -> String {
        format!("{:06}", 100_000 + i)
    }

    fn key(code: &str, venue: Venue) -> SeriesKey {
        SeriesKey { feed: Feed::new(Symbol::parse(code).unwrap(), Some(venue)).unwrap(), period: Period::M1 }
    }

    fn samsung() -> SeriesKey {
        key(SAMSUNG, Venue::Combined)
    }

    fn sub(s: &str) -> SubId {
        SubId(s.into())
    }

    fn won(v: u64) -> Price {
        Price::from_centi(v * 100).unwrap()
    }

    fn trade(h: &Harness, hhmmss: (u32, u32, u32), price: u64, qty: u64, exchange: Option<Exchange>) -> StreamEvent {
        let tick = RealTick {
            symbol: Symbol::Stock(StockCode::parse(SAMSUNG).unwrap()),
            hhmmss: TimeOfDay::hms(hhmmss.0, hhmmss.1, hhmmss.2).unwrap(),
            price: won(price),
            qty: Volume(qty),
            exchange,
            day: None,
            strength_centi: None,
            side: None,
        };
        StreamEvent::Tick { tick, received_at: h.clock.now() }
    }

    fn day_trade(h: &Harness, hhmmss: (u32, u32, u32), price: u64, exchange: Exchange, change_won: i64, cumulative: u64) -> StreamEvent {
        let StreamEvent::Tick { mut tick, received_at } = trade(h, hhmmss, price, 1, Some(exchange)) else {
            unreachable!("trade는 Tick이다")
        };
        tick.day = Some(DayTotals { change_centi: change_won * 100, cumulative: Volume(cumulative) });
        StreamEvent::Tick { tick, received_at }
    }

    fn quote_msg(code: &str, price: f64, change: f64, volume: u64, t: KstTime) -> ServerMessage {
        let base = price - change;
        ServerMessage::Quotes {
            venue: api::Venue::Combined,
            quotes: vec![api::Quote {
                symbol: api::SymbolCode(code.into()),
                price,
                change,
                change_rate: change / base * 100.0,
                volume,
                t: UnixSeconds(t.unix()),
                source: api::QuoteSource::Realtime,
                venue: Some(api::Venue::Combined),
                traded_million_won: None,
            }],
        }
    }

    fn limited(codes: &[String]) -> ServerMessage {
        ServerMessage::WatchLimited { symbols: codes.iter().map(|c| api::SymbolCode(c.clone())).collect() }
    }

    fn fillers(n: usize) -> Vec<Symbol> {
        (0..n).map(|i| Symbol::parse(&listed_filler(i)).unwrap()).collect()
    }

    fn bar(t: KstTime, [o, h, l, c, v]: [u64; 5]) -> Bar {
        Bar { t: UnixSeconds(t.unix()), o: o as f64, h: h as f64, l: l as f64, c: c as f64, v }
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    async fn connect(h: &Harness) -> (ConnId, Arc<Outbox>) {
        let out = Outbox::new();
        let conn = h.hub.connect(out.clone());
        settle().await;
        let msgs = out.take(true).messages;
        assert!(matches!(msgs.as_slice(), [ServerMessage::Hello { protocol: 1, .. }]), "{msgs:?}");
        (conn, out)
    }

    async fn live(h: &Harness) {
        h.events.send(StreamEvent::Live { since: h.clock.now() }).await.unwrap();
        settle().await;
    }

    async fn take(out: &Outbox) -> Vec<ServerMessage> {
        settle().await;
        out.take(true).messages
    }

    fn subscribed(s: &str, seq: u64, current: Option<Bar>) -> ServerMessage {
        ServerMessage::Subscribed { sub: s.into(), seq, current }
    }

    fn bar_msg(s: &str, seq: u64, b: Bar) -> ServerMessage {
        ServerMessage::Bar { sub: s.into(), seq, bar: b }
    }

    fn confirmed(s: &str, seq: u64, b: Bar) -> ServerMessage {
        ServerMessage::Confirmed { sub: s.into(), seq, bar: b }
    }

    fn reload(s: &str, seq: u64, reason: ReloadReason, from: Option<KstTime>) -> ServerMessage {
        ServerMessage::Reload { sub: s.into(), seq, reason, from: from.map(|t| UnixSeconds(t.unix())) }
    }

    async fn subscribed_samsung(h: &Harness) -> (ConnId, Arc<Outbox>) {
        live(h).await;
        let (conn, out) = connect(h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        assert_eq!(take(&out).await, vec![subscribed("a", 0, None), bar_msg("a", 1, bar(at(9, 0, 0), [100, 110, 95, 105, 50]))]);
        (conn, out)
    }

    #[tokio::test(start_paused = true)]
    async fn subscribe_seeds_then_every_trade_moves_the_current_bar() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([samsung().feed.symbol()])));
        h.events.send(trade(&h, (9, 0, 51), 112, 2, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![bar_msg("a", 2, bar(at(9, 0, 0), [100, 112, 95, 112, 52]))]);
        h.events.send(trade(&h, (9, 0, 52), 90, 1, Some(Exchange::Nxt))).await.unwrap();
        h.events.send(trade(&h, (9, 0, 52), 91, 1, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![bar_msg("a", 4, bar(at(9, 0, 0), [100, 112, 90, 91, 54]))], "100ms 안의 갱신은 마지막 것 하나만 간다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_roll_sends_confirmed_then_the_new_bar_and_the_bar_lands_in_the_cache() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.events.send(trade(&h, (9, 1, 0), 120, 3, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(
            take(&out).await,
            vec![confirmed("a", 2, bar(at(9, 0, 0), [100, 110, 95, 105, 50])), bar_msg("a", 3, bar(at(9, 1, 0), [120, 120, 120, 120, 3]))]
        );
        h.clock.sleep_until(at(9, 1, 5)).await;
        out.take(true);
        h.events.send(trade(&h, (9, 1, 30), 118, 1, Some(Exchange::Krx))).await.unwrap();
        h.events.send(trade(&h, (9, 2, 0), 119, 1, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(
            take(&out).await,
            vec![confirmed("a", 5, bar(at(9, 1, 0), [120, 120, 118, 118, 4])), bar_msg("a", 6, bar(at(9, 2, 0), [119, 119, 119, 119, 1]))]
        );
        let page = h.bars.page(samsung(), None, 10).await.unwrap();
        let realtime = page.bars.iter().find(|b| b.bucket.start() == at(9, 1, 0)).expect("09:01 봉이 캐시에 있다");
        assert_eq!(realtime.source, BarSource::Realtime);
        assert!(!realtime.needs_verify, "체결로 시작한 봉은 완전하다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_subscribed_series_outlives_ten_idle_minutes_and_takes_realtime_bars() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.clock.sleep_until(at(9, 13, 30)).await;
        out.take(true);
        assert_eq!(h.bars.series_count(), 1, "구독이 잡은 시리즈는 1분 내리기 타이머를 견딘다");
        h.events.send(trade(&h, (9, 13, 40), 130, 2, Some(Exchange::Krx))).await.unwrap();
        h.events.send(trade(&h, (9, 14, 0), 131, 1, Some(Exchange::Krx))).await.unwrap();
        settle().await;
        assert_eq!(h.bars.series_count(), 1);
        let page = h.bars.page(samsung(), Some(at(9, 14, 0)), 3).await.unwrap();
        let last = page.bars.last().expect("봉이 있다");
        assert_eq!((last.bucket.start(), last.source), (at(9, 13, 0), BarSource::Realtime), "다시 만든 시리즈가 아니라 실시간 봉이 붙은 그 시리즈다");
    }

    #[tokio::test(start_paused = true)]
    async fn the_timer_confirms_a_bar_without_a_new_trade() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.events.send(trade(&h, (9, 1, 0), 120, 3, Some(Exchange::Krx))).await.unwrap();
        take(&out).await;
        h.clock.sleep_until(at(9, 2, 1)).await;
        assert_eq!(take(&out).await, vec![], "09:02:02 전에는 열려 있다");
        h.clock.sleep_until(at(9, 2, 3)).await;
        assert_eq!(take(&out).await, vec![confirmed("a", 4, bar(at(9, 1, 0), [120, 120, 120, 120, 3]))]);
    }

    #[tokio::test(start_paused = true)]
    async fn one_stream_is_split_by_exchange() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        for (s, v) in [("all", Venue::Combined), ("krx", Venue::Krx), ("nxt", Venue::Nxt)] {
            h.hub.subscribe(conn, sub(s), key(SAMSUNG, v));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(out.take(true).messages.len(), 6, "subscribed 셋과 시드 bar 셋");
        let got = |msgs: Vec<ServerMessage>| -> Vec<(String, f64)> {
            msgs.into_iter()
                .map(|m| match m {
                    ServerMessage::Bar { sub, bar, .. } => (sub, bar.c),
                    other => panic!("{other:?}"),
                })
                .collect()
        };
        h.events.send(trade(&h, (9, 0, 51), 101, 1, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(got(take(&out).await), [("all".to_owned(), 101.0), ("krx".to_owned(), 101.0)]);
        h.events.send(trade(&h, (9, 0, 52), 102, 1, Some(Exchange::Nxt))).await.unwrap();
        assert_eq!(got(take(&out).await), [("all".to_owned(), 102.0), ("nxt".to_owned(), 102.0)]);
        h.events.send(trade(&h, (9, 0, 53), 103, 1, None)).await.unwrap();
        assert_eq!(got(take(&out).await), [("all".to_owned(), 103.0)], "거래소를 모르면 통합에만");
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([samsung().feed.symbol()])), "거래소가 셋이어도 REG는 하나");
    }

    #[tokio::test(start_paused = true)]
    async fn late_and_out_of_window_trades_change_nothing() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.events.send(trade(&h, (9, 1, 0), 120, 3, Some(Exchange::Krx))).await.unwrap();
        take(&out).await;
        h.events.send(trade(&h, (9, 0, 59), 200, 9, Some(Exchange::Krx))).await.unwrap();
        h.events.send(trade(&h, (8, 59, 0), 200, 9, Some(Exchange::Krx))).await.unwrap();
        h.events.send(trade(&h, (7, 59, 0), 200, 9, Some(Exchange::Krx))).await.unwrap();
        h.events.send(trade(&h, (9, 5, 0), 200, 9, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![], "늦은 체결, 체결 시간 밖, 60초 넘는 미래");
    }

    #[tokio::test(start_paused = true)]
    async fn trades_while_seeding_are_dropped() {
        let h = harness(at(9, 0, 50), morning_chart(), Duration::from_secs(3));
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        assert_eq!(take(&out).await, vec![subscribed("a", 0, None)]);
        h.events.send(trade(&h, (9, 0, 51), 150, 7, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(take(&out).await, vec![bar_msg("a", 1, bar(at(9, 0, 0), [100, 110, 95, 105, 50]))], "시드 중 체결은 더하지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_bar_started_after_trades_dropped_while_seeding_is_verified_and_replaced() {
        let mut chart = Chart::default();
        chart.set(at(8, 59, 0), [90, 90, 90, 90, 1]);
        let h = harness(at(9, 0, 5), chart, Duration::from_secs(3));
        live(&h).await;
        let (conn, _) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        settle().await;
        h.events.send(trade(&h, (9, 0, 7), 100, 7, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(8)).await;
        h.events.send(trade(&h, (9, 0, 15), 110, 3, Some(Exchange::Krx))).await.unwrap();
        settle().await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 110, 100, 110, 10]);
        h.clock.sleep_until(at(9, 1, 3)).await;
        settle().await;
        let snap = h.hub.snapshot(samsung()).await.unwrap();
        let confirmed = snap.recent_confirmed.iter().find(|b| b.bucket.start() == at(9, 0, 0)).expect("09:00 봉이 확정됐다");
        assert!(confirmed.needs_verify, "시드를 기다리며 버린 체결이 있는 구간은 불완전하다");
        tokio::time::sleep(Duration::from_secs(35)).await;
        let page = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap();
        let [b] = page.bars.as_slice() else { panic!("{:?}", page.bars) };
        assert_eq!((b.bucket.start(), b.source, Bar::from(b)), (at(9, 0, 0), BarSource::Kiwoom, bar(at(9, 0, 0), [100, 110, 100, 110, 10])), "키움 값으로 바뀐다");
        assert_eq!(h.fake.market_sent().len(), 2, "버린 체결과 needs_verify가 같은 구간의 대조 하나를 공유한다");
    }

    #[tokio::test(start_paused = true)]
    async fn subs_of_one_key_share_its_seq() {
        let h = std_harness();
        let (_, a) = subscribed_samsung(&h).await;
        h.events.send(trade(&h, (9, 0, 51), 112, 2, Some(Exchange::Krx))).await.unwrap();
        take(&a).await;
        let (conn2, b) = connect(&h).await;
        h.hub.subscribe(conn2, sub("b"), samsung());
        h.hub.subscribe(conn2, sub("b2"), samsung());
        let now = bar(at(9, 0, 0), [100, 112, 95, 112, 52]);
        assert_eq!(take(&b).await, vec![subscribed("b", 2, Some(now)), subscribed("b2", 2, Some(now))], "subscribed는 지금의 seq와 현재 봉");
        h.events.send(trade(&h, (9, 1, 0), 120, 1, Some(Exchange::Krx))).await.unwrap();
        let (ma, mb) = (take(&a).await, take(&b).await);
        assert_eq!(ma[0], confirmed("a", 3, now));
        assert_eq!(mb[..2], [confirmed("b", 3, now), confirmed("b2", 3, now)]);
    }

    #[tokio::test(start_paused = true)]
    async fn unsubscribe_keeps_the_symbol_for_thirty_seconds_and_resubscribe_keeps_the_key() {
        let h = std_harness();
        let (conn, out) = subscribed_samsung(&h).await;
        let symbol = samsung().feed.symbol();
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([symbol])), "30초 유예");
        h.hub.subscribe(conn, sub("a2"), samsung());
        assert_eq!(take(&out).await, vec![subscribed("a2", 2, None)], "유예 중 다시 구독하면 키를 이어 쓴다(09:00 봉은 타이머로 확정됐다)");
        h.hub.unsubscribe(conn, sub("a2"));
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([symbol])));
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::new()));
        assert_eq!(h.hub.snapshot(samsung()).await, None, "구독도 유예도 없는 키는 내린다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_connection_releases_its_subs() {
        let h = std_harness();
        let (conn, _out) = subscribed_samsung(&h).await;
        h.hub.disconnect(conn);
        tokio::time::sleep(Duration::from_secs(31)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::new()));
    }

    fn statuses(msgs: &[ServerMessage]) -> Vec<(RealtimeState, bool)> {
        msgs.iter()
            .filter_map(|m| match m {
                ServerMessage::Status { status } => Some((status.realtime, status.backfilling)),
                _ => None,
            })
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn a_gap_in_trading_hours_is_refilled_then_reloaded() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        let down_at = h.clock.now();
        h.events.send(StreamEvent::Down { at: down_at }).await.unwrap();
        assert_eq!(statuses(&take(&out).await), [(RealtimeState::Reconnecting, false)]);
        h.chart.lock().unwrap().answer_503_times = 2;
        h.events.send(StreamEvent::Down { at: down_at.plus_secs(1) }).await.unwrap();
        live(&h).await;
        settle().await;
        let msgs = out.take(true).messages;
        assert_eq!(statuses(&msgs), [(RealtimeState::Live, true)], "{msgs:?}");
        tokio::time::sleep(Duration::from_secs(10)).await;
        let msgs = out.take(true).messages;
        assert_eq!(msgs[0], reload("a", 2, ReloadReason::GapFilled, Some(down_at)), "다시 끊겨도 처음 끊긴 시각. Recovery 우선순위라 503 두 번을 조회 안에서 다시 보낸다");
        assert_eq!(statuses(&msgs), [(RealtimeState::Live, false)]);
        h.events.send(trade(&h, (9, 1, 10), 120, 1, Some(Exchange::Krx))).await.unwrap();
        let msgs = take(&out).await;
        assert!(matches!(msgs.last(), Some(ServerMessage::Bar { bar: Bar { c: 120.0, .. }, .. })), "메운 뒤 집계를 이어 간다: {msgs:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_gap_outside_trading_hours_needs_no_reload() {
        let mut chart = Chart::default();
        chart.set(at(19, 59, 0), [100, 100, 100, 100, 1]);
        let h = harness(at(20, 30, 0), chart, Duration::ZERO);
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        assert_eq!(take(&out).await, vec![subscribed("a", 0, None)]);
        h.events.send(StreamEvent::Down { at: h.clock.now() }).await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
        live(&h).await;
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(statuses(&out.take(true).messages), [(RealtimeState::Reconnecting, false), (RealtimeState::Live, false)]);
        assert_eq!(h.hub.snapshot(samsung()).await.map(|s| s.seq), Some(0), "reload가 없다");
    }

    #[tokio::test(start_paused = true)]
    async fn daily_reset_reseeds_every_key_and_reloads() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 130, 95, 125, 80]);
        h.bars.clear_all();
        h.hub.daily_reset();
        assert_eq!(take(&out).await, vec![reload("a", 2, ReloadReason::DailyReset, None)]);
        let snap = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!(snap.current.map(|c| api::Bar::new(c.bucket(), c.ohlcv())), Some(bar(at(9, 0, 0), [100, 130, 95, 125, 80])), "새로 받은 현재 봉");
    }

    #[tokio::test(start_paused = true)]
    async fn an_incomplete_bar_is_replaced_when_kiwoom_differs() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.events.send(trade(&h, (9, 0, 55), 111, 1, Some(Exchange::Krx))).await.unwrap();
        h.events.send(trade(&h, (9, 1, 0), 120, 3, Some(Exchange::Krx))).await.unwrap();
        let sent = bar(at(9, 0, 0), [100, 111, 95, 111, 51]);
        assert_eq!(take(&out).await[0], confirmed("a", 3, sent));
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 111, 95, 111, 53]);
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert_eq!(out.take(true).messages, vec![reload("a", 5, ReloadReason::Replaced, Some(at(9, 0, 0)))]);
        h.events.send(trade(&h, (9, 1, 30), 121, 1, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![bar_msg("a", 6, bar(at(9, 1, 0), [120, 121, 120, 121, 4]))], "집계기는 그대로");
    }

    #[tokio::test(start_paused = true)]
    async fn an_incomplete_bar_that_matches_kiwoom_is_left_alone() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.events.send(trade(&h, (9, 1, 0), 120, 3, Some(Exchange::Krx))).await.unwrap();
        take(&out).await;
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert_eq!(out.take(true).messages, vec![]);
    }

    fn sub_error(s: &str, code: SubErrorCode) -> ServerMessage {
        ServerMessage::SubError { sub: s.into(), code }
    }

    #[tokio::test(start_paused = true)]
    async fn seed_errors_become_sub_errors() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("x"), key(UNLISTED, Venue::Combined));
        h.hub.subscribe(conn, sub("y"), key(NEXTRADE_EXCLUDED, Venue::Nxt));
        assert_eq!(
            take(&out).await,
            vec![subscribed("x", 0, None), subscribed("y", 0, None), sub_error("x", SubErrorCode::UnknownSymbol), sub_error("y", SubErrorCode::BadRequest)]
        );
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::new()), "받을 수 없는 종목은 유예 없이 놓는다");
        assert_eq!(h.hub.snapshot(key(UNLISTED, Venue::Combined)).await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn kiwoom_unavailable_is_reported_once_and_the_seed_is_retried() {
        let h = harness(at(9, 0, 5), morning_chart(), Duration::ZERO);
        h.chart.lock().unwrap().answer_503_times = 2;
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        h.clock.sleep_until(at(9, 1, 0)).await;
        assert_eq!(
            out.take(true).messages,
            vec![subscribed("a", 0, None), sub_error("a", SubErrorCode::KiwoomUnavailable), bar_msg("a", 1, bar(at(9, 0, 0), [100, 110, 95, 105, 50]))],
            "503은 조회 관문을 30초 닫는다. 그 뒤 다시 받는다"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_carries_seq_current_and_recent_confirmed() {
        let h = std_harness();
        assert_eq!(h.hub.snapshot(samsung()).await, None);
        let (_, out) = subscribed_samsung(&h).await;
        h.events.send(trade(&h, (9, 1, 0), 120, 3, Some(Exchange::Krx))).await.unwrap();
        take(&out).await;
        let snap = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!(snap.seq, 3);
        assert_eq!(snap.current.map(|c| c.bucket().start()), Some(at(9, 1, 0)));
        assert_eq!(snap.recent_confirmed.iter().map(|b| b.bucket.start()).collect::<Vec<_>>(), [at(9, 0, 0)]);
    }

    #[tokio::test(start_paused = true)]
    async fn over_the_limit_a_sub_is_rejected_and_comes_back_when_room_frees() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        for i in 0..REALTIME_LIMIT - 1 {
            h.hub.subscribe(conn, sub(&format!("f{i}")), key(&listed_filler(i), Venue::Combined));
        }
        h.hub.subscribe(conn, sub("a"), samsung());
        h.hub.subscribe(conn, sub("over"), key(&listed_filler(REALTIME_LIMIT - 1), Venue::Combined));
        settle().await;
        let msgs = out.take(true).messages;
        assert!(msgs.contains(&sub_error("over", SubErrorCode::RealtimeLimit)));
        assert!(!msgs.iter().any(|m| matches!(m, ServerMessage::Subscribed { sub, .. } if sub == "over")), "거절된 구독에는 subscribed가 없다");
        assert_eq!(h.desired.borrow().len(), REALTIME_LIMIT);
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let msgs = out.take(true).messages;
        assert!(msgs.contains(&subscribed("over", 0, None)), "유예 중인 종목을 빼서 자리를 만들고 같은 sub로 다시 알린다: {msgs:?}");
        assert!(!h.desired.borrow().contains_key(&samsung().feed.symbol()));
        assert!(h.desired.borrow().contains_key(&Symbol::parse(&listed_filler(REALTIME_LIMIT - 1)).unwrap()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_trade_moves_the_combined_cell_and_the_watch_row_to_the_same_price() {
        let h = std_harness();
        let (conn, out) = subscribed_samsung(&h).await;
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Combined);
        settle().await;
        h.events.send(day_trade(&h, (9, 0, 51), 112, Exchange::Krx, 12, 1_000)).await.unwrap();
        let msgs = take(&out).await;
        assert_eq!(msgs, vec![bar_msg("a", 2, bar(at(9, 0, 0), [100, 112, 95, 112, 51])), quote_msg(SAMSUNG, 112.0, 12.0, 1_000, at(9, 0, 51))], "같은 묶음으로 나간다");
        h.events.send(day_trade(&h, (9, 0, 52), 90, Exchange::Nxt, -10, 1_001)).await.unwrap();
        let msgs = take(&out).await;
        let close = msgs.iter().find_map(|m| if let ServerMessage::Bar { bar, .. } = m { Some(bar.c) } else { None });
        let price = msgs.iter().find_map(|m| if let ServerMessage::Quotes { quotes, .. } = m { Some(quotes[0].price) } else { None });
        assert_eq!((close, price), (Some(90.0), Some(90.0)), "NXT 체결도 통합 칸과 관심종목이 함께 받는다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_trade_without_day_totals_moves_only_the_cell() {
        let h = std_harness();
        let (conn, out) = subscribed_samsung(&h).await;
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Combined);
        h.events.send(trade(&h, (9, 0, 51), 112, 2, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![bar_msg("a", 2, bar(at(9, 0, 0), [100, 112, 95, 112, 52]))]);
    }

    #[tokio::test(start_paused = true)]
    async fn over_the_limit_watch_rows_are_reported_and_cleared_when_room_frees() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        h.hub.watch(conn, fillers(REALTIME_LIMIT), Venue::Combined);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let msgs = out.take(true).messages;
        assert!(msgs.contains(&limited(&[listed_filler(REALTIME_LIMIT - 1)])), "칸이 한 자리를 쓰니 맨 아랫줄이 넘친다: {msgs:?}");
        assert_eq!(h.desired.borrow().len(), REALTIME_LIMIT);
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let msgs = out.take(true).messages;
        assert!(msgs.contains(&limited(&[])), "유예 중인 칸 종목을 빼서 자리를 만든다: {msgs:?}");
        assert!(h.desired.borrow().contains_key(&fillers(REALTIME_LIMIT)[REALTIME_LIMIT - 1]));
        assert!(!h.desired.borrow().contains_key(&samsung().feed.symbol()));
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(!out.take(true).messages.iter().any(|m| matches!(m, ServerMessage::WatchLimited { .. })), "바뀌지 않으면 다시 보내지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn reordering_watch_rows_changes_the_kiwoom_set_once_per_tick() {
        let h = std_harness();
        let t0 = tokio::time::Instant::now();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        let samsung = samsung().feed.symbol();
        let mut rows = fillers(REALTIME_LIMIT);
        rows.push(samsung);
        let mut moved = vec![samsung];
        moved.extend(fillers(REALTIME_LIMIT));
        h.hub.watch(conn, rows.clone(), Venue::Combined);
        tokio::time::sleep_until(t0 + Duration::from_millis(3_100)).await;
        let mut desired = h.desired.clone();
        assert!(!desired.borrow_and_update().contains_key(&samsung));
        for _ in 0..3 {
            h.hub.watch(conn, moved.clone(), Venue::Combined);
            h.hub.watch(conn, rows.clone(), Venue::Combined);
        }
        h.hub.watch(conn, moved.clone(), Venue::Combined);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!desired.has_changed().unwrap(), "watch 입력은 REG 집합을 바로 바꾸지 않는다");
        tokio::time::sleep_until(t0 + Duration::from_millis(4_100)).await;
        assert!(desired.has_changed().unwrap());
        let now = desired.borrow_and_update().clone();
        assert!(now.contains_key(&samsung) && !now.contains_key(&fillers(REALTIME_LIMIT)[REALTIME_LIMIT - 1]), "다음 1초 타이머에 마지막 순서로 한 번 바뀐다");
    }

    #[tokio::test(start_paused = true)]
    async fn watch_rows_outside_the_symbol_list_are_registered_only_once_it_lists_them() {
        let h = std_harness();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        let unlisted = Symbol::parse(UNLISTED).unwrap();
        h.hub.watch(conn, vec![unlisted, samsung().feed.symbol()], Venue::Combined);
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([samsung().feed.symbol()])), "없는 코드는 REG하지 않는다");
        let info = |symbol| SymbolInfo { symbol, name: "x".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: false };
        h.symbols.replace(Directory::build(vec![info(unlisted), info(samsung().feed.symbol())]));
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([unlisted, samsung().feed.symbol()])), "종목 목록이 바뀌면 다시 맞춘다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_watchlist_keeps_its_symbols_for_thirty_seconds() {
        let h = std_harness();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Combined);
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([samsung().feed.symbol()])));
        h.hub.watch(conn, Vec::new(), Venue::Combined);
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([samsung().feed.symbol()])));
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::new()));
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Combined);
        tokio::time::sleep(Duration::from_secs(2)).await;
        h.hub.disconnect(conn);
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([samsung().feed.symbol()])), "연결이 끊겨도 30초 유예");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::new()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_watched_symbol_stays_registered_but_its_closed_cell_key_is_dropped_after_thirty_seconds() {
        let h = std_harness();
        let (conn, out) = subscribed_samsung(&h).await;
        let symbol = samsung().feed.symbol();
        h.hub.watch(conn, vec![symbol], Venue::Combined);
        settle().await;
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert!(h.hub.snapshot(samsung()).await.is_some(), "닫은 칸의 키는 30초 유예");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(h.hub.snapshot(samsung()).await, None, "관심종목이 종목을 잡고 있어도 닫은 칸의 키는 내린다");
        assert_eq!(*h.desired.borrow(), trades_only(BTreeSet::from([symbol])), "관심종목 줄이 REG를 지킨다");
        out.take(true);
        h.events.send(day_trade(&h, (9, 1, 23), 112, Exchange::Krx, 12, 1_000)).await.unwrap();
        assert_eq!(take(&out).await, vec![quote_msg(SAMSUNG, 112.0, 12.0, 1_000, at(9, 1, 23))], "키가 없어도 관심종목 줄은 체결을 받는다");
    }

    #[test]
    fn gaps_overlap_trading_hours_on_any_day() {
        let d = |day: u8, h, m, s| kst(KstDate::new(2026, 11, day).unwrap(), h, m, s);
        assert!(!gap_overlaps_trading(d(9, 7, 50, 0), d(9, 7, 55, 0)), "07:50 강제 단절");
        assert!(!gap_overlaps_trading(d(9, 20, 0, 10), d(9, 23, 0, 0)));
        assert!(gap_overlaps_trading(d(9, 20, 0, 9), d(9, 20, 1, 0)), "장 끝 유예 안");
        assert!(gap_overlaps_trading(d(9, 7, 59, 0), d(9, 8, 0, 1)));
        assert!(gap_overlaps_trading(d(9, 21, 0, 0), d(10, 9, 0, 0)), "다음 날 장중");
        assert!(!gap_overlaps_trading(d(9, 21, 0, 0), d(10, 7, 0, 0)));
    }

    #[tokio::test(start_paused = true)]
    async fn rereview_dropped_only_tick_is_recovered_without_a_later_tick_in_its_minute() {
        let mut chart = Chart::default();
        chart.set(at(8, 59, 0), [90, 90, 90, 90, 1]);
        let h = harness(at(9, 0, 5), chart, Duration::from_secs(3));
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        settle().await;
        h.events.send(trade(&h, (9, 0, 7), 100, 7, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(8)).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 100, 100, 100, 7]);
        h.clock.sleep_until(at(9, 1, 3)).await;
        h.events.send(trade(&h, (9, 1, 3), 110, 3, Some(Exchange::Krx))).await.unwrap();
        h.clock.sleep_until(at(9, 1, 20)).await;
        settle().await;
        let snap = h.hub.snapshot(samsung()).await.unwrap();
        let page = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap();
        let messages = out.take(true).messages;
        let restored = messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, from: Some(t), .. } if *t == UnixSeconds(at(9, 0, 0).unix()))).collect::<Vec<_>>();
        assert_eq!(restored.len(), 1, "누락 봉을 복구한 뒤 한 번만 reload한다: {messages:?}");
        assert!(matches!(restored[0], ServerMessage::Reload { seq: 2, .. }), "복구가 기존 seq를 올린다");
        assert_eq!(snap.seq, 2);
        assert_eq!(snap.current.map(|c| api::Bar::new(c.bucket(), c.ohlcv())), Some(bar(at(9, 1, 0), [110, 110, 110, 110, 3])), "누락 봉 복구가 진행 중 집계기를 바꾸지 않는다");
        assert!(snap.recent_confirmed.is_empty(), "누락 봉을 최근 확정 큐에 끼워 넣지 않는다");
        assert_eq!(page.bars.last().map(|b| (b.bucket.start(), b.ohlcv.volume().0)), Some((at(9, 0, 0), 7)), "the observed dropped minute must be fetched and restored even when its next live tick is in a later minute");
        println!("dropped-only restored bucket={} volume=7, replaced count=1 seq=2, actual fake chart requests={}, current bucket={} volume=3", at(9, 0, 0), h.fake.market_sent().len(), snap.current.unwrap().bucket().start());
        h.clock.sleep_until(at(9, 2, 40)).await;
        settle().await;
        let page = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap();
        assert_eq!(page.bars.last().map(|b| (b.bucket.start(), b.ohlcv.volume().0)), Some((at(9, 0, 0), 7)), "원래 회귀 시각에도 복구한 봉을 유지한다");
        assert!(!out.take(true).messages.iter().any(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })), "성공한 대상은 reload를 다시 만들지 않는다");
        println!("dropped-only original boundary now={} historical bucket={} volume=7, additional replaced count=0", h.clock.now(), at(9, 0, 0));
    }

    async fn subscribe_with_dropped_tick(h: &Harness, hhmmss: (u32, u32, u32)) -> Arc<Outbox> {
        live(h).await;
        let (conn, out) = connect(h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        settle().await;
        h.events.send(trade(h, hhmmss, 100, 7, Some(Exchange::Krx))).await.unwrap();
        settle().await;
        out
    }

    #[tokio::test(start_paused = true)]
    async fn duplicate_dropped_ticks_and_gap_reseeds_share_three_verification_requests() {
        let h = harness(at(9, 0, 5), Chart::default(), Duration::from_secs(3));
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        h.events.send(trade(&h, (9, 0, 7), 100, 7, Some(Exchange::Krx))).await.unwrap();
        h.clock.sleep_until(at(9, 1, 8)).await;
        settle().await;
        assert_eq!(h.fake.market_sent().len(), 2, "최초 시드와 아직 진행 중인 첫 대조");
        let gap = h.clock.now();
        h.events.send(StreamEvent::Down { at: gap }).await.unwrap();
        live(&h).await;
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(h.fake.market_sent().len(), 5, "시드 둘과 대조 셋. 구세대 진행 중 요청도 한 번으로 센다");
        assert!(!out.take(true).messages.iter().any(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })));
        let gap = h.clock.now();
        h.events.send(StreamEvent::Down { at: gap }).await.unwrap();
        live(&h).await;
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(h.fake.market_sent().len(), 6, "소진한 구간은 재시드로 되살리지 않는다");
        println!("bounded verification actual fake chart requests=5 (2 seed + 3 verify), exhausted reseed total=6");
    }

    #[tokio::test(start_paused = true)]
    async fn an_old_generation_verification_cannot_reload_or_retry() {
        let h = harness(at(9, 0, 5), Chart::default(), Duration::from_secs(3));
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        tokio::time::sleep(Duration::from_secs(8)).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 100, 100, 100, 7]);
        h.clock.sleep_until(at(9, 1, 8)).await;
        settle().await;
        assert_eq!(h.fake.market_sent().len(), 2);
        let gap = h.clock.now();
        h.events.send(StreamEvent::Down { at: gap }).await.unwrap();
        live(&h).await;
        h.clock.sleep_until(at(9, 1, 15)).await;
        let messages = take(&out).await;
        assert!(!messages.iter().any(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })), "진행 중이던 구세대 결과는 알리지 않는다: {messages:?}");
        assert_eq!(h.fake.market_sent().len(), 3, "구세대 성공은 새 즉시 대조를 만들지 않는다");
        h.clock.sleep_until(at(9, 1, 35)).await;
        let messages = take(&out).await;
        assert_eq!(messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })).count(), 1, "새 세대가 보존한 대상은 그 세대의 대조로만 완료한다: {messages:?}");
        assert_eq!(h.fake.market_sent().len(), 4);
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap().seq, 2, "gap reload와 새 세대의 replaced만 seq를 올린다");
        println!("stale generation ignored; current generation replaced count=1 seq=2; actual fake chart requests=4");
    }

    #[tokio::test(start_paused = true)]
    async fn daily_reset_clears_pending_verification_and_ignores_its_inflight_result() {
        let h = harness(at(9, 0, 5), Chart::default(), Duration::from_secs(3));
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        tokio::time::sleep(Duration::from_secs(8)).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 100, 100, 100, 7]);
        h.clock.sleep_until(at(9, 1, 8)).await;
        settle().await;
        assert_eq!(h.fake.market_sent().len(), 2);
        h.bars.clear_all();
        h.hub.daily_reset();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(h.fake.market_sent().len(), 3, "daily reset 시드 하나 외에는 예전 대상을 다시 조회하지 않는다");
        let messages = out.take(true).messages;
        assert_eq!(messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::DailyReset, .. })).count(), 1);
        assert!(!messages.iter().any(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })), "reset 전 진행 중 결과를 알리지 않는다: {messages:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_gap_that_opens_after_the_source_switch_does_not_replace_the_pending_daily_reset() {
        let h = harness(at(9, 0, 5), Chart::default(), Duration::from_secs(3));
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        h.hub.source_switched();
        h.events.send(StreamEvent::Down { at: h.clock.now() }).await.unwrap();
        live(&h).await;
        tokio::time::sleep(Duration::from_secs(60)).await;
        let reloads: Vec<ReloadReason> = out.take(true).messages.iter().filter_map(|m| match m { ServerMessage::Reload { reason, .. } => Some(*reason), _ => None }).collect();
        assert_eq!(reloads, [ReloadReason::DailyReset], "바꾼 뒤 열린 끊김 구간이 비우기 알림을 밀어내지 않는다: {reloads:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn dropped_session_close_tick_waits_for_grace_and_verification_delay() {
        let h = harness(at(20, 0, 0), Chart::default(), Duration::from_secs(1));
        let out = subscribe_with_dropped_tick(&h, (20, 0, 3)).await;
        h.chart.lock().unwrap().set(at(19, 59, 0), [100, 100, 100, 100, 7]);
        h.clock.sleep_until(at(20, 0, 14)).await;
        assert_eq!(h.fake.market_sent().len(), 1, "20:00:10 확정과 5초 대기 전에는 시드만 보낸다");
        h.clock.sleep_until(at(20, 0, 18)).await;
        let messages = take(&out).await;
        assert_eq!(h.fake.market_sent().len(), 2);
        assert!(messages.iter().any(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, from: Some(t), .. } if *t == UnixSeconds(at(19, 59, 0).unix()))), "20:00 체결의 복구 구간도 19:59다: {messages:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn every_dropped_bucket_is_verified_even_before_the_five_bar_seed_tail() {
        let h = harness(at(9, 0, 5), Chart::default(), Duration::from_secs(10));
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        tokio::time::sleep(Duration::from_secs(10)).await;
        for minute in 1..7 {
            h.clock.jump(60);
            h.events.send(trade(&h, (9, minute, 7), 100, 7, Some(Exchange::Krx))).await.unwrap();
            settle().await;
        }
        assert_eq!(h.fake.market_sent().len(), 1, "시드 중 실제로 버린 일곱 구간을 기록한다");
        for minute in 0..12 {
            h.chart.lock().unwrap().set(at(9, minute, 0), [100, 100, 100, 100, 7]);
        }
        h.clock.jump(6 * 60);
        tokio::time::sleep(Duration::from_secs(100)).await;
        let messages = out.take(true).messages;
        let replaced = messages.iter().filter_map(|m| match m {
            ServerMessage::Reload { reason: ReloadReason::Replaced, from: Some(t), .. } => Some(*t),
            _ => None,
        }).collect::<BTreeSet<_>>();
        assert_eq!(replaced, (0..7).map(|minute| UnixSeconds(at(9, minute, 0).unix())).collect(), "최근 다섯 개보다 오래된 대상도 캐시 전체에서 찾는다: {messages:?}");
        let requests = h.fake.market_sent();
        assert_eq!(requests.len(), 8, "최초 시드와 일곱 구간 대조만 보낸다");
        assert!(requests.iter().all(|r| r.cont.is_none()), "대조가 과거 연속조회를 시작하지 않는다");
        let snap = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!((snap.seq, snap.current, snap.recent_confirmed.len()), (7, None, 0));
    }

    fn n3_n4_replaced(messages: &[ServerMessage]) -> usize {
        messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })).count()
    }

    async fn n3_n4_reconnect_with_duplicate(h: &Harness) {
        h.events.send(StreamEvent::Down { at: h.clock.now() }).await.unwrap();
        live(h).await;
        h.events.send(trade(h, (9, 0, 7), 100, 7, Some(Exchange::Krx))).await.unwrap();
        settle().await;
    }

    async fn n3_n4_completed_recovery() -> (Harness, ConnId, Arc<Outbox>) {
        let mut chart = Chart::default();
        chart.set(at(8, 59, 0), [90, 90, 90, 90, 1]);
        let h = harness(at(9, 0, 5), chart, Duration::from_secs(3));
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        settle().await;
        h.events.send(trade(&h, (9, 0, 7), 100, 7, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(8)).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 100, 100, 100, 7]);
        h.clock.sleep_until(at(9, 1, 20)).await;
        settle().await;
        assert_eq!(h.fake.market_sent().len(), 2);
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap().seq, 1);
        assert_eq!(n3_n4_replaced(&out.take(true).messages), 1);
        (h, conn, out)
    }

    #[test]
    fn n3_n4_complete_registration_preserves_accepted_value_and_consumed_attempts() {
        let bucket = Period::M1.bucket(at(9, 0, 0));
        let accepted = Ohlcv::try_new(won(100), won(100), won(100), won(100), Volume(7)).unwrap();
        let other = Ohlcv::try_new(won(125), won(125), won(125), won(125), Volume(2)).unwrap();
        let mut ks = KeyState {
            generation: 1,
            feed: KeyFeed::Live(Aggregator::new(Period::M1, None, Some(bucket))),
            seq: 1,
            recent_confirmed: VecDeque::new(),
            verifications: BTreeMap::from([(bucket, Verification { last_published: Some(accepted), attempts: 2, phase: VerificationPhase::Complete })]),
            subs: BTreeSet::new(),
            contiguous: true,
            idle_since: None,
        };
        for previous in [None, Some(other)] {
            ks.register_verification(bucket, previous, at(9, 1, 20));
            ks.note_published(bucket, other);
            let verification = &ks.verifications[&bucket];
            assert_eq!(verification.last_published, Some(accepted));
            assert_eq!(verification.attempts, 2);
            assert_eq!(verification.phase, VerificationPhase::Complete);
        }
    }

    #[test]
    fn n3_n4_publication_only_updates_existing_unfinished_comparison() {
        let bucket = Period::M1.bucket(at(9, 0, 0));
        let published = Ohlcv::try_new(won(125), won(125), won(125), won(125), Volume(2)).unwrap();
        let mut ks = KeyState {
            generation: 1,
            feed: KeyFeed::Live(Aggregator::new(Period::M1, None, None)),
            seq: 0,
            recent_confirmed: VecDeque::new(),
            verifications: BTreeMap::new(),
            subs: BTreeSet::new(),
            contiguous: true,
            idle_since: None,
        };
        ks.note_published(bucket, published);
        assert!(ks.verifications.is_empty());
        for (attempts, phase) in [
            (0, VerificationPhase::Waiting { at: at(9, 1, 7) }),
            (2, VerificationPhase::Waiting { at: at(9, 1, 40) }),
            (1, VerificationPhase::InFlight),
            (VERIFY_ATTEMPTS, VerificationPhase::Exhausted),
        ] {
            ks.verifications.insert(bucket, Verification { last_published: None, attempts, phase });
            ks.note_published(bucket, published);
            ks.note_published(Period::M1.bucket(at(9, 1, 0)), published);
            assert_eq!(ks.verifications.len(), 1);
            let verification = &ks.verifications[&bucket];
            assert_eq!(verification.last_published, Some(published));
            assert_eq!((verification.attempts, verification.phase), (attempts, phase));
            assert_eq!((ks.seq, ks.current(), ks.recent_confirmed.len()), (0, None, 0));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_complete_trade_publications_create_no_verification_requests() {
        let h = harness(at(9, 0, 5), Chart::default(), Duration::ZERO);
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        take(&out).await;
        h.events.send(trade(&h, (9, 0, 10), 100, 7, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![bar_msg("a", 1, bar(at(9, 0, 0), [100, 100, 100, 100, 7]))]);
        h.clock.sleep_until(at(9, 1, 0)).await;
        h.events.send(trade(&h, (9, 1, 0), 125, 2, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![
            confirmed("a", 2, bar(at(9, 0, 0), [100, 100, 100, 100, 7])),
            bar_msg("a", 3, bar(at(9, 1, 0), [125, 125, 125, 125, 2])),
        ]);
        h.clock.sleep_until(at(9, 2, 30)).await;
        assert_eq!(take(&out).await, vec![confirmed("a", 4, bar(at(9, 1, 0), [125, 125, 125, 125, 2]))]);
        assert_eq!(h.fake.market_sent().len(), 1, "publication alone only uses the initial seed request");
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_equal_verification_without_current_needs_no_reload() {
        let h = std_harness();
        let (_, out) = subscribed_samsung(&h).await;
        h.clock.sleep_until(at(9, 1, 25)).await;
        let messages = take(&out).await;
        assert_eq!(messages, vec![confirmed("a", 2, bar(at(9, 0, 0), [100, 110, 95, 105, 50]))]);
        let snapshot = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!((snapshot.seq, snapshot.current), (2, None));
        assert_eq!(h.fake.market_sent().len(), 2);
        h.clock.sleep_until(at(9, 2, 0)).await;
        assert!(take(&out).await.is_empty());
        assert_eq!(h.fake.market_sent().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_recovered_boundary_survives_an_omitted_seed_tail() {
        let (h, _, out) = n3_n4_completed_recovery().await;
        h.chart.lock().unwrap().rows.retain(|(t, _)| *t < at(9, 0, 0));
        n3_n4_reconnect_with_duplicate(&h).await;
        tokio::time::sleep(Duration::from_secs(8)).await;
        let messages = out.take(true).messages;
        assert_eq!(messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::GapFilled, .. })).count(), 1);
        assert_eq!(n3_n4_replaced(&messages), 0);
        let before = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!((before.seq, before.current, before.recent_confirmed.len()), (2, None, 0));
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert!(out.take(true).messages.is_empty());
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap(), before);
        assert_eq!(h.fake.market_sent().len(), 3, "the omitted completed bucket only costs a seed request");
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_late_recovered_trade_preserves_newer_current_exactly() {
        let (h, _, out) = n3_n4_completed_recovery().await;
        h.events.send(trade(&h, (9, 1, 20), 110, 3, Some(Exchange::Krx))).await.unwrap();
        assert_eq!(take(&out).await, vec![bar_msg("a", 2, bar(at(9, 1, 0), [110, 110, 110, 110, 3]))]);
        let before = h.hub.snapshot(samsung()).await.unwrap();
        assert!(before.current.unwrap().is_complete());
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        assert!(take(&out).await.is_empty());
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap(), before);
        assert_eq!(h.fake.market_sent().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_completed_recovery_survives_idle_grace_and_resubscription() {
        let (h, conn, out) = n3_n4_completed_recovery().await;
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(10)).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        let messages = take(&out).await;
        assert!(messages.iter().any(|m| *m == subscribed("a", 1, None)), "{messages:?}");
        out.take(true);
        let before = h.hub.snapshot(samsung()).await.unwrap();
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert!(out.take(true).messages.is_empty());
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap(), before);
        assert_eq!(h.fake.market_sent().len(), 2, "the retained key gets no new seed or verification budget");
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_daily_reset_allows_a_new_recovery_for_a_completed_bucket() {
        let (h, _, out) = n3_n4_completed_recovery().await;
        h.bars.clear_all();
        h.hub.daily_reset();
        settle().await;
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(20)).await;
        let messages = out.take(true).messages;
        assert_eq!(messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::DailyReset, .. })).count(), 1);
        assert_eq!(n3_n4_replaced(&messages), 1, "daily reset clears the completed recovery ledger: {messages:?}");
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap().seq, 3);
        assert_eq!(h.fake.market_sent().len(), 4, "each lifetime has one seed and one verification");
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_key_removal_allows_a_new_recovery_for_a_completed_bucket() {
        let (h, conn, out) = n3_n4_completed_recovery().await;
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(32)).await;
        assert!(h.hub.snapshot(samsung()).await.is_none());
        out.take(true);
        h.hub.subscribe(conn, sub("a"), samsung());
        settle().await;
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(20)).await;
        let messages = out.take(true).messages;
        assert!(messages.iter().any(|m| *m == subscribed("a", 0, None)), "{messages:?}");
        assert_eq!(n3_n4_replaced(&messages), 1, "a new key owns a new recovery ledger: {messages:?}");
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap().seq, 1);
        assert_eq!(h.fake.market_sent().len(), 4, "each key lifetime has one seed and one verification");
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_recovery_success_does_not_revive_same_bucket_budget() {
        let h = harness(at(9, 0, 5), Chart::default(), Duration::from_secs(3));
        let started = tokio::time::Instant::now();
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        h.clock.sleep_until(at(9, 0, 30)).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 100, 100, 100, 7]);
        h.clock.sleep_until(at(9, 1, 15)).await;
        settle().await;
        assert_eq!(h.fake.market_sent().len(), 2);
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap().seq, 1);
        for _ in 0..4 {
            n3_n4_reconnect_with_duplicate(&h).await;
            tokio::time::sleep(Duration::from_secs(20)).await;
        }
        let requests = h.fake.market_sent();
        let messages = out.take(true).messages;
        let replaced = n3_n4_replaced(&messages);
        let gap = messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::GapFilled, .. })).count();
        let seq = h.hub.snapshot(samsung()).await.unwrap().seq;
        let times: Vec<_> = requests.iter().map(|r| (r.at - started).as_secs_f64()).collect();
        println!("N3 same-bucket delayed duplicate now={} requests={} (5 seeds + {} verifies) seq={seq} replaced={replaced} gap={gap} offsets={times:?}", h.clock.now(), requests.len(), requests.len() - 5);
        assert_eq!(gap, 4);
        assert_eq!(replaced, 1, "unchanged successful bucket has no redundant replaced reload");
        assert_eq!(requests.len(), 6, "five seeds and one completed verification");
        assert_eq!(seq, 5);
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_recovered_missing_bucket_must_reject_a_delayed_trade() {
        let mut chart = Chart::default();
        chart.set(at(8, 59, 0), [90, 90, 90, 90, 1]);
        let h = harness(at(9, 0, 5), chart, Duration::from_secs(3));
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        tokio::time::sleep(Duration::from_secs(8)).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 100, 100, 100, 7]);
        h.clock.sleep_until(at(9, 1, 20)).await;
        settle().await;
        let snap = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!((snap.seq, snap.current), (1, None));
        let messages = out.take(true).messages;
        assert_eq!(messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })).count(), 1);
        let cached = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap().bars[0];
        assert_eq!((cached.bucket.start(), cached.ohlcv.volume().0, cached.source), (at(9, 0, 0), 7, BarSource::Kiwoom));
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        let mut late_messages = take(&out).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        late_messages.extend(out.take(true).messages);
        let after = h.hub.snapshot(samsung()).await.unwrap();
        let cache_after = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap().bars[0];
        assert_eq!((cache_after.source, cache_after.ohlcv.volume().0), (BarSource::Kiwoom, 7));
        println!("N4 cache remains Kiwoom q7");
        println!("N4 recovered missing 09:00 cache source={:?} volume={} seq-before={}; delayed 09:00:59 p125/q2 at09:01:20 produces messages={late_messages:?}, seq-after={}, recent={:?}; expected no bar/confirmed after recovered confirmed bucket", cached.source, cached.ohlcv.volume().0, snap.seq, after.seq, after.recent_confirmed);
        h.clock.sleep_until(at(9, 1, 40)).await;
        let later = take(&out).await;
        println!("N4 later messages={later:?}; fake requests={}", h.fake.market_sent().len());
        assert!(later.is_empty(), "completed bucket needs no second verification or reload");
        assert_eq!(h.fake.market_sent().len(), 2);
        assert!(!late_messages.iter().any(|m| matches!(m, ServerMessage::Bar { .. } | ServerMessage::Confirmed { .. })), "late trade must not publish a partial replacement of the already recovered confirmed bucket");
        assert_eq!(after.seq, snap.seq);
        assert_eq!(after.recent_confirmed, snap.recent_confirmed);
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_recovered_complete_bucket_must_reject_its_already_counted_trade() {
        let mut chart = Chart::default();
        chart.set(at(8, 59, 0), [90, 90, 90, 90, 1]);
        let h = harness(at(9, 0, 5), chart, Duration::from_secs(3));
        let out = subscribe_with_dropped_tick(&h, (9, 0, 7)).await;
        tokio::time::sleep(Duration::from_secs(8)).await;
        h.clock.sleep_until(at(9, 1, 0)).await;
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 125, 100, 125, 9]);
        h.clock.sleep_until(at(9, 1, 20)).await;
        settle().await;
        let snap = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!((snap.seq, snap.current), (1, None));
        let messages = out.take(true).messages;
        assert_eq!(messages.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })).count(), 1);
        let cached = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap().bars[0];
        assert_eq!((cached.bucket.start(), cached.ohlcv.volume().0, cached.source), (at(9, 0, 0), 9, BarSource::Kiwoom));
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        let mut late_messages = take(&out).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        late_messages.extend(out.take(true).messages);
        let after = h.hub.snapshot(samsung()).await.unwrap();
        let cache_after = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap().bars[0];
        assert_eq!((cache_after.source, cache_after.ohlcv.volume().0), (BarSource::Kiwoom, 9));
        println!("N4 cache remains Kiwoom q9 (both original q7 and delayed q2 already counted)");
        println!("N4 recovered missing 09:00 cache source={:?} volume={} seq-before={}; delayed 09:00:59 p125/q2 at09:01:20 produces messages={late_messages:?}, seq-after={}, recent={:?}; expected no bar/confirmed after recovered confirmed bucket", cached.source, cached.ohlcv.volume().0, snap.seq, after.seq, after.recent_confirmed);
        h.clock.sleep_until(at(9, 1, 40)).await;
        let later = take(&out).await;
        println!("N4 later messages={later:?}; fake requests={}", h.fake.market_sent().len());
        assert!(later.is_empty(), "completed bucket needs no second verification or reload");
        assert_eq!(h.fake.market_sent().len(), 2);
        assert!(!late_messages.iter().any(|m| matches!(m, ServerMessage::Bar { .. } | ServerMessage::Confirmed { .. })), "late trade must not publish a partial replacement of the already recovered confirmed bucket");
        assert_eq!(after.seq, snap.seq);
        assert_eq!(after.recent_confirmed, snap.recent_confirmed);
    }

    async fn n3_n4_equal_previous_after_omitted_seed(confirm_partial_before_result: bool) {
        let mut chart = Chart::default();
        chart.set(at(9, 0, 0), [100, 125, 95, 125, 50]);
        let h = harness(at(9, 0, 45), chart, Duration::from_millis(3250));
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        h.clock.sleep_until(at(9, 1, 3)).await;
        let initial = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!(initial.current, None);
        assert_eq!(initial.recent_confirmed.last().unwrap().ohlcv.volume().0, 50);
        assert_eq!(h.fake.market_sent().len(), 1);
        h.chart.lock().unwrap().rows.clear();
        h.events.send(StreamEvent::Down { at: h.clock.now() }).await.unwrap();
        live(&h).await;
        let reseed = h.fake.market_sent().last().unwrap().at;
        tokio::time::sleep_until(reseed + Duration::from_millis(3300)).await;
        let seeded = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!((seeded.current, seeded.recent_confirmed.len()), (None, 0));
        assert_eq!(h.fake.market_sent().len(), 2);
        h.chart.lock().unwrap().set(at(9, 0, 0), [100, 125, 95, 125, 50]);
        h.clock.sleep_until(at(9, 1, 7)).await;
        settle().await;
        assert_eq!(h.fake.market_sent().len(), 3, "seed, empty reseed, pending verification");
        let request = h.fake.market_sent().last().unwrap().at;
        let offset = if confirm_partial_before_result { 2100 } else { 3100 };
        tokio::time::sleep_until(request + Duration::from_millis(offset)).await;
        out.take(true);
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        let mut partial = out.take(true).messages;
        if confirm_partial_before_result {
            tokio::time::sleep_until(request + Duration::from_millis(3100)).await;
            partial.extend(out.take(true).messages);
        }
        let before_result = h.hub.snapshot(samsung()).await.unwrap();
        assert!(partial.iter().any(|m| matches!(m, ServerMessage::Bar { bar, .. } if bar.v == 2)), "must publish partial Q before recovery result: {partial:?}");
        if confirm_partial_before_result {
            assert!(partial.iter().any(|m| matches!(m, ServerMessage::Confirmed { bar, .. } if bar.v == 2)), "must publish partial Q confirmation before recovery result: {partial:?}");
            assert_eq!(before_result.current, None);
            assert_eq!(before_result.recent_confirmed.last().unwrap().ohlcv.volume().0, 2);
        } else {
            assert_eq!(before_result.current.unwrap().ohlcv().volume().0, 2);
        }
        tokio::time::sleep_until(request + Duration::from_millis(3500)).await;
        let corrected = take(&out).await;
        let after = h.hub.snapshot(samsung()).await.unwrap();
        let canonical = h.bars.page(samsung(), Some(at(9, 1, 0)), 1).await.unwrap().bars[0];
        assert_eq!((canonical.source, canonical.ohlcv.volume().0), (BarSource::Kiwoom, 50));
        println!("equal-previous confirmed-before-result={confirm_partial_before_result} partial={partial:?} correction={corrected:?} seq-before={} seq-after={} current-after={:?} recent-after={:?} requests={}", before_result.seq, after.seq, after.current, after.recent_confirmed, h.fake.market_sent().len());
        assert_eq!(after.current, None);
        assert_eq!(corrected.iter().filter(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::Replaced, .. })).count(), 1, "a published partial Q needs a repair even when original P equals recovered P");
        assert_eq!(after.seq, before_result.seq + 1);
        assert!(!after.recent_confirmed.iter().any(|b| b.ohlcv.volume().0 == 2));
        assert_eq!(h.fake.market_sent().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_equal_published_current_still_reloads_when_retired() {
        let mut chart = Chart::default();
        chart.set(at(9, 0, 0), [125, 125, 125, 125, 2]);
        let h = harness(at(9, 0, 45), chart, Duration::from_millis(3250));
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe(conn, sub("a"), samsung());
        h.clock.sleep_until(at(9, 1, 3)).await;
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap().current, None);
        h.chart.lock().unwrap().rows.clear();
        h.events.send(StreamEvent::Down { at: h.clock.now() }).await.unwrap();
        live(&h).await;
        let reseed = h.fake.market_sent().last().unwrap().at;
        tokio::time::sleep_until(reseed + Duration::from_millis(3300)).await;
        assert_eq!(h.hub.snapshot(samsung()).await.unwrap().current, None);
        h.chart.lock().unwrap().set(at(9, 0, 0), [125, 125, 125, 125, 2]);
        h.clock.sleep_until(at(9, 1, 7)).await;
        settle().await;
        assert_eq!(h.fake.market_sent().len(), 3);
        let request = h.fake.market_sent().last().unwrap().at;
        tokio::time::sleep_until(request + Duration::from_millis(3100)).await;
        out.take(true);
        h.events.send(trade(&h, (9, 0, 59), 125, 2, Some(Exchange::Krx))).await.unwrap();
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        let partial = out.take(true).messages;
        assert!(partial.iter().any(|m| matches!(m, ServerMessage::Bar { bar, .. } if *bar == self::bar(at(9, 0, 0), [125, 125, 125, 125, 2]))));
        let before = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!(before.current.unwrap().ohlcv().volume().0, 2);
        tokio::time::sleep_until(request + Duration::from_millis(3500)).await;
        assert_eq!(take(&out).await, vec![reload("a", before.seq + 1, ReloadReason::Replaced, Some(at(9, 0, 0)))]);
        let after = h.hub.snapshot(samsung()).await.unwrap();
        assert_eq!((after.seq, after.current), (before.seq + 1, None));
        h.clock.sleep_until(at(9, 1, 40)).await;
        assert!(take(&out).await.is_empty());
        assert_eq!(h.fake.market_sent().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_equal_previous_repairs_partial_current_after_reseed() {
        n3_n4_equal_previous_after_omitted_seed(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn n3_n4_equal_previous_repairs_partial_confirmed_after_reseed() {
        n3_n4_equal_previous_after_omitted_seed(true).await;
    }

    #[tokio::test(start_paused = true)]
    async fn quarterly_and_yearly_current_bars_publish_ticks_and_roll_at_calendar_boundaries() {
        for (period, last, next) in [(Period::Quarter, "20260331", "20260401"), (Period::Year, "20261231", "20270101")] {
            let date = |s| KstDate::parse_yyyymmdd(s).unwrap();
            let start = kst(date(last), 19, 58, 0);
            let mut chart = Chart::default();
            chart.set(kst(date("20260102"), 0, 0, 0), [100, 150, 80, 120, 10]);
            if period == Period::Quarter {
                chart.set(kst(date("20260202"), 0, 0, 0), [120, 140, 90, 130, 20]);
                chart.set(kst(date("20260303"), 0, 0, 0), [130, 150, 100, 140, 30]);
            }
            let h = period_harness(start, chart, Duration::ZERO, period);
            live(&h).await;
            let (conn, out) = connect(&h).await;
            let k = SeriesKey { period, ..samsung() };
            h.hub.subscribe(conn, sub("a"), k);
            take(&out).await;
            let original = h.hub.snapshot(k).await.unwrap().current.unwrap();
            h.clock.jump(kst(date(last), 19, 59, 0).unix() - h.clock.now().unix());
            h.events.send(trade(&h, (19, 59, 0), 160, 7, Some(Exchange::Krx))).await.unwrap();
            take(&out).await;
            let current = h.hub.snapshot(k).await.unwrap().current.unwrap();
            assert_eq!(current.ohlcv().volume().0, original.ohlcv().volume().0 + 7);
            assert_eq!(current.ohlcv().open(), original.ohlcv().open());
            assert_eq!(current.ohlcv().close().centi(), 16000);
            h.clock.jump(kst(date(next), 9, 0, 0).unix() - h.clock.now().unix());
            h.events.send(trade(&h, (9, 0, 0), 170, 3, Some(Exchange::Krx))).await.unwrap();
            let messages = take(&out).await;
            assert!(messages.iter().any(|m| matches!(m, ServerMessage::Confirmed { bar, .. } if bar.v == original.ohlcv().volume().0 + 7)), "{messages:?}");
            let new = h.hub.snapshot(k).await.unwrap().current.unwrap();
            assert_eq!(new.bucket(), original.bucket().next());
            assert_eq!(new.ohlcv().volume().0, 3);
            assert_eq!(new.ohlcv().open().centi(), 17000);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn quarterly_seed_failure_on_first_or_required_earlier_month_stays_retryable() {
        for fail_at in [0, 1] {
            let mut chart = Chart { page_size: Some(1), fail_at: Some(fail_at), ..Chart::default() };
            let date = |s| KstDate::parse_yyyymmdd(s).unwrap();
            chart.set(kst(date("20260401"), 0, 0, 0), [100, 150, 80, 120, 10]);
            chart.set(kst(date("20260504"), 0, 0, 0), [120, 160, 100, 150, 20]);
            let h = period_harness(kst(date("20260520"), 12, 0, 0), chart, Duration::ZERO, Period::Quarter);
            live(&h).await;
            let (conn, out) = connect(&h).await;
            let k = SeriesKey { period: Period::Quarter, ..samsung() };
            h.hub.subscribe(conn, sub("a"), k);
            tokio::time::sleep(Duration::from_secs(3)).await;
            let messages = out.take(true).messages;
            assert!(messages.iter().any(|m| matches!(m, ServerMessage::SubError { code: SubErrorCode::KiwoomUnavailable, .. })), "{messages:?}");
            assert!(!messages.iter().any(|m| matches!(m, ServerMessage::Bar { .. } | ServerMessage::Confirmed { .. })));
            assert!(h.hub.snapshot(k).await.unwrap().current.is_none());
            h.chart.lock().unwrap().fail_at = None;
            tokio::time::sleep(Duration::from_secs(70)).await;
            let messages = out.take(true).messages;
            assert!(messages.iter().any(|m| matches!(m, ServerMessage::Bar { bar, .. } if bar.v == 30)), "{messages:?}");
            assert_eq!(h.hub.snapshot(k).await.unwrap().current.unwrap().ohlcv().volume().0, 30);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn quarterly_repeated_monthly_cursor_reports_unavailable_and_automatically_reseeds() {
        let date = |s| KstDate::parse_yyyymmdd(s).unwrap();
        let mut chart = Chart { page_size: Some(1), repeat_page: true, ..Chart::default() };
        chart.set(kst(date("20260504"), 0, 0, 0), [120, 160, 100, 150, 20]);
        let h = period_harness(kst(date("20260520"), 12, 0, 0), chart, Duration::ZERO, Period::Quarter);
        live(&h).await;
        let (conn, out) = connect(&h).await;
        let k = SeriesKey { period: Period::Quarter, ..samsung() };
        h.hub.subscribe(conn, sub("a"), k);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let messages = out.take(true).messages;
        assert!(messages.iter().any(|m| matches!(m, ServerMessage::SubError { code: SubErrorCode::KiwoomUnavailable, .. })), "{messages:?}");
        assert!(!messages.iter().any(|m| matches!(m, ServerMessage::Bar { .. } | ServerMessage::Confirmed { .. })));
        assert!(h.hub.snapshot(k).await.unwrap().current.is_none());
        {
            let mut chart = h.chart.lock().unwrap();
            chart.repeat_page = false;
            chart.set(kst(date("20260401"), 0, 0, 0), [100, 150, 80, 120, 10]);
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        let messages = out.take(true).messages;
        assert!(messages.iter().any(|m| matches!(m, ServerMessage::Bar { bar, .. } if bar.v == 30)), "{messages:?}");
        assert_eq!(h.hub.snapshot(k).await.unwrap().current.unwrap().ohlcv().volume().0, 30);
    }

    #[tokio::test(start_paused = true)]
    async fn quarterly_confirmation_verifies_before_next_quarter_and_daily_reset_clears_the_ledger() {
        let date = |s| KstDate::parse_yyyymmdd(s).unwrap();
        let mut chart = Chart { page_size: Some(1), ..Chart::default() };
        for (dt, v) in [("20260102", 10), ("20260202", 20), ("20260303", 30)] {
            chart.set(kst(date(dt), 0, 0, 0), [100, 150, 80, 120, v]);
        }
        let h = period_harness(kst(date("20260331"), 19, 59, 55), chart, Duration::ZERO, Period::Quarter);
        live(&h).await;
        let (conn, out) = connect(&h).await;
        let k = SeriesKey { period: Period::Quarter, ..samsung() };
        h.hub.subscribe(conn, sub("a"), k);
        take(&out).await;
        h.clock.sleep_until(kst(date("20260331"), 19, 59, 59)).await;
        h.events.send(trade(&h, (19, 59, 59), 130, 1, Some(Exchange::Krx))).await.unwrap();
        h.chart.lock().unwrap().set(kst(date("20260303"), 0, 0, 0), [100, 150, 80, 130, 31]);
        h.clock.sleep_until(kst(date("20260331"), 20, 0, 20)).await;
        let snapshot = h.hub.snapshot(k).await.unwrap();
        assert!(snapshot.current.is_none());
        let confirmed = snapshot.recent_confirmed.last().unwrap();
        assert_eq!((confirmed.source, confirmed.ohlcv.volume().0, confirmed.needs_verify), (BarSource::Kiwoom, 61, false));
        let q1 = confirmed.bucket;
        out.take(true);
        h.clock.jump(kst(date("20260401"), 7, 45, 0).unix() - h.clock.now().unix());
        h.chart.lock().unwrap().set(kst(date("20260401"), 0, 0, 0), [130, 150, 120, 140, 4]);
        h.bars.clear_all();
        h.hub.daily_reset();
        let messages = take(&out).await;
        assert!(messages.iter().any(|m| matches!(m, ServerMessage::Reload { reason: ReloadReason::DailyReset, .. })), "{messages:?}");
        let requests = h.fake.market_sent().len();
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert_eq!(h.fake.market_sent().len(), requests, "the reset ledger does not verify a previous-quarter bucket");
        let page = h.bars.page(k, None, 10).await.unwrap();
        assert_eq!((page.bars[0].bucket, page.bars[0].ohlcv.volume().0), (q1, 61));
        assert_eq!(page.current.unwrap().ohlcv.volume().0, 4);
    }


    fn fill(h: &Harness, code: &str, hhmmss: (u32, u32, u32), price: u64, exchange: Option<Exchange>, qty: u64, day: (i64, u64)) -> StreamEvent {
        let StreamEvent::Tick { mut tick, received_at } = trade(h, hhmmss, price, qty, exchange) else {
            unreachable!("trade는 Tick이다")
        };
        tick.symbol = Symbol::parse(code).unwrap();
        tick.day = Some(DayTotals { change_centi: day.0 * 100, cumulative: Volume(day.1) });
        StreamEvent::Tick { tick, received_at }
    }

    fn venue_quote(code: &str, venue: api::Venue, price: f64, change: f64, volume: u64, t: KstTime) -> api::Quote {
        api::Quote {
            symbol: api::SymbolCode(code.into()),
            price,
            change,
            change_rate: change / (price - change) * 100.0,
            volume,
            t: UnixSeconds(t.unix()),
            source: api::QuoteSource::Realtime,
            venue: Some(venue),
            traded_million_won: None,
        }
    }

    fn quotes_msg(requested: api::Venue, quotes: Vec<api::Quote>) -> ServerMessage {
        ServerMessage::Quotes { venue: requested, quotes }
    }

    fn quote_messages(msgs: Vec<ServerMessage>) -> Vec<ServerMessage> {
        msgs.into_iter().filter(|m| matches!(m, ServerMessage::Quotes { .. })).collect()
    }

    fn samsung_code(venue: Venue) -> String {
        kiwoom_stock_code(StockCode::parse(SAMSUNG).unwrap(), venue)
    }

    fn volumes(combined: u64, krx: u64, nxt: Option<u64>) -> HashMap<String, u64> {
        let mut by_code = HashMap::from([(samsung_code(Venue::Combined), combined), (samsung_code(Venue::Krx), krx)]);
        by_code.extend(nxt.map(|nxt| (samsung_code(Venue::Nxt), nxt)));
        by_code
    }

    fn samsung_volume_request() -> String {
        format!(r#"{{"stk_cd":"{}|{}|{}"}}"#, samsung_code(Venue::Combined), samsung_code(Venue::Krx), samsung_code(Venue::Nxt))
    }

    fn day_volume_requests(h: &Harness) -> Vec<String> {
        h.fake.market_sent().into_iter().filter(|s| s.api_id == ApiId::Ka10095).map(|s| s.body).collect()
    }

    async fn day_volume_asked(h: &Harness, count: usize) {
        for _ in 0..300 {
            if day_volume_requests(h).len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("거래소별 거래량을 {count}번 묻지 않았다: {:?}", day_volume_requests(h));
    }

    #[tokio::test(start_paused = true)]
    async fn watch_in_krx_moves_only_on_krx_fills_with_the_krx_day_volume() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Krx);
        day_volume_asked(&h, 1).await;
        settle().await;
        assert_eq!(day_volume_requests(&h), [samsung_volume_request()], "통합·KRX·NXT 누적을 한 요청으로 묻는다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 112.0, 12.0, 705, at(9, 0, 51))])], "거래량은 통합 1_005가 아니라 KRX 누적이다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 52), 90, Some(Exchange::Nxt), 4, (-10, 1_009))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![], "NXT 체결은 KRX 시세를 움직이지 않는다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 53), 113, Some(Exchange::Krx), 1, (13, 1_010))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 113.0, 13.0, 706, at(9, 0, 53))])], "NXT 체결 수량은 KRX 거래량에 들어가지 않고, 등락은 그 가격과 기준가의 차이다");
        assert_eq!(day_volume_requests(&h).len(), 1, "다시 묻지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn watch_in_nxt_moves_only_on_nxt_fills_with_the_nxt_day_volume() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Nxt);
        day_volume_asked(&h, 1).await;
        settle().await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![], "KRX 체결은 NXT 시세를 움직이지 않는다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 52), 90, Some(Exchange::Nxt), 4, (-10, 1_009))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Nxt, vec![venue_quote(SAMSUNG, api::Venue::Nxt, 90.0, -10.0, 304, at(9, 0, 52))])]);
    }

    #[tokio::test(start_paused = true)]
    async fn watch_in_nxt_gives_a_combined_quote_for_a_symbol_not_on_nxt() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        h.hub.watch(conn, vec![Symbol::parse(NEXTRADE_EXCLUDED).unwrap()], Venue::Nxt);
        settle().await;
        h.events.send(fill(&h, NEXTRADE_EXCLUDED, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 2_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Nxt, vec![venue_quote(NEXTRADE_EXCLUDED, api::Venue::Combined, 112.0, 12.0, 2_005, at(9, 0, 51))])], "요청은 NXT, 값은 통합이다");
        assert_eq!(day_volume_requests(&h), Vec::<String>::new(), "통합 누적을 그대로 쓰므로 거래소별 거래량을 묻지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn watch_in_krx_for_a_symbol_not_on_nxt_uses_the_combined_volume_of_krx_fills() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        h.hub.watch(conn, vec![Symbol::parse(NEXTRADE_EXCLUDED).unwrap()], Venue::Krx);
        settle().await;
        h.events.send(fill(&h, NEXTRADE_EXCLUDED, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 2_005))).await.unwrap();
        h.events.send(fill(&h, NEXTRADE_EXCLUDED, (9, 0, 52), 113, None, 5, (13, 2_010))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(NEXTRADE_EXCLUDED, api::Venue::Krx, 112.0, 12.0, 2_005, at(9, 0, 51))])], "거래소를 모르는 체결은 움직이지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn changing_only_the_watch_venue_switches_the_next_quote_and_keeps_the_kiwoom_set() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        let list = vec![samsung().feed.symbol()];
        h.hub.watch(conn, list.clone(), Venue::Combined);
        settle().await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Combined, vec![venue_quote(SAMSUNG, api::Venue::Combined, 112.0, 12.0, 1_005, at(9, 0, 51))])]);
        h.events.send(fill(&h, SAMSUNG, (9, 0, 52), 113, Some(Exchange::Krx), 1, (13, 1_006))).await.unwrap();
        settle().await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let registered = h.desired.borrow().clone();
        assert!(!registered.is_empty());
        *h.day_volumes.lock().unwrap() = volumes(1_006, 706, Some(300));
        h.hub.watch(conn, list, Venue::Krx);
        settle().await;
        assert_eq!(quote_messages(out.take(true).messages), vec![], "바꾸기 전 거래소로 만든 대기 중 시세는 나가지 않는다");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), registered, "등록 집합은 그대로다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 53), 114, Some(Exchange::Krx), 1, (14, 1_007))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 114.0, 14.0, 707, at(9, 0, 53))])]);
    }

    #[tokio::test(start_paused = true)]
    async fn connections_watching_different_venues_each_get_their_own_quote() {
        let h = std_harness();
        let (a, out_a) = connect(&h).await;
        let (b, out_b) = connect(&h).await;
        live(&h).await;
        h.hub.watch(a, vec![samsung().feed.symbol()], Venue::Krx);
        h.hub.watch(b, vec![samsung().feed.symbol()], Venue::Combined);
        settle().await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Nxt), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out_a).await), vec![]);
        assert_eq!(quote_messages(take(&out_b).await), vec![quotes_msg(api::Venue::Combined, vec![venue_quote(SAMSUNG, api::Venue::Combined, 112.0, 12.0, 1_005, at(9, 0, 51))])]);
        h.events.send(fill(&h, SAMSUNG, (9, 0, 52), 113, Some(Exchange::Krx), 2, (13, 1_007))).await.unwrap();
        assert_eq!(quote_messages(take(&out_a).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 113.0, 13.0, 702, at(9, 0, 52))])]);
        assert_eq!(quote_messages(take(&out_b).await), vec![quotes_msg(api::Venue::Combined, vec![venue_quote(SAMSUNG, api::Venue::Combined, 113.0, 13.0, 1_007, at(9, 0, 52))])]);
    }

    #[tokio::test(start_paused = true)]
    async fn fills_that_arrive_while_the_day_volume_is_being_asked_are_counted_once() {
        let h = harness(at(9, 0, 50), morning_chart(), Duration::from_millis(300));
        let (conn, out) = connect(&h).await;
        live(&h).await;
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Krx);
        day_volume_asked(&h, 1).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 50), 110, Some(Exchange::Krx), 3, (10, 998))).await.unwrap();
        h.events.send(fill(&h, SAMSUNG, (9, 0, 50), 110, Some(Exchange::Nxt), 2, (10, 1_000))).await.unwrap();
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 111, Some(Exchange::Krx), 4, (11, 1_004))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![], "시작 값을 받기 전에는 내지 않는다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 52), 112, Some(Exchange::Krx), 1, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 112.0, 12.0, 705, at(9, 0, 52))])], "조회 값 700에 1_000을 넘은 KRX 체결 4와 1만 더한다");
    }

    #[tokio::test(start_paused = true)]
    async fn unlisted_watch_rows_do_not_use_up_the_day_volume_places() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        let mut rows = vec![Symbol::parse(UNLISTED).unwrap()];
        rows.extend(fillers(REALTIME_LIMIT - 1));
        rows.push(samsung().feed.symbol());
        h.hub.watch(conn, rows, Venue::Krx);
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(h.desired.borrow().contains_key(&samsung().feed.symbol()), "마지막 목록 줄도 실시간 자리를 받는다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 112.0, 12.0, 705, at(9, 0, 51))])]);
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_watch_rows_do_not_use_up_the_day_volume_places() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        let mut rows = vec![fillers(1)[0]; REALTIME_LIMIT];
        rows.push(samsung().feed.symbol());
        h.hub.watch(conn, rows, Venue::Krx);
        tokio::time::sleep(Duration::from_secs(3)).await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 112.0, 12.0, 705, at(9, 0, 51))])]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_day_volume_whose_venues_do_not_add_up_to_the_combined_volume_is_not_used() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        *h.day_volumes.lock().unwrap() = volumes(1_000, 700, Some(200));
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Krx);
        settle().await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![]);
        *h.day_volumes.lock().unwrap() = volumes(1_005, 705, Some(300));
        tokio::time::sleep(Duration::from_secs(6)).await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 58), 113, Some(Exchange::Krx), 1, (13, 1_006))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 113.0, 13.0, 706, at(9, 0, 58))])], "다시 받은 값이 맞으면 그때부터 낸다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_missing_nxt_row_is_zero_only_when_krx_already_equals_the_combined_volume() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        *h.day_volumes.lock().unwrap() = volumes(1_000, 1_000, None);
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Krx);
        day_volume_asked(&h, 1).await;
        settle().await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 112.0, 12.0, 1_005, at(9, 0, 51))])]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_seed_missing_the_nxt_row_while_krx_is_below_combined_is_not_used() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        *h.day_volumes.lock().unwrap() = volumes(1_000, 900, None);
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Krx);
        day_volume_asked(&h, 1).await;
        settle().await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_missed_fill_holds_the_quote_until_the_day_volume_is_asked_again() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        h.hub.watch(conn, vec![samsung().feed.symbol()], Venue::Krx);
        day_volume_asked(&h, 1).await;
        settle().await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Krx), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await).len(), 1);
        h.events.send(fill(&h, SAMSUNG, (9, 0, 52), 113, Some(Exchange::Krx), 5, (13, 1_030))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![], "1_005 다음이 1_030이면 사이 체결이 빠졌다");
        *h.day_volumes.lock().unwrap() = volumes(1_031, 720, Some(311));
        tokio::time::sleep(Duration::from_secs(6)).await;
        assert_eq!(day_volume_requests(&h).len(), 2, "다시 묻는다");
        h.events.send(fill(&h, SAMSUNG, (9, 0, 58), 114, Some(Exchange::Krx), 9, (14, 1_040))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Krx, vec![venue_quote(SAMSUNG, api::Venue::Krx, 114.0, 14.0, 729, at(9, 0, 58))])]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_day_volume_is_no_longer_asked_for_after_the_watch_returns_to_combined() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        let list = vec![samsung().feed.symbol()];
        h.hub.watch(conn, list.clone(), Venue::Nxt);
        day_volume_asked(&h, 1).await;
        settle().await;
        h.hub.watch(conn, list, Venue::Combined);
        settle().await;
        tokio::time::sleep(Duration::from_secs(10)).await;
        h.events.send(fill(&h, SAMSUNG, (9, 0, 51), 112, Some(Exchange::Nxt), 5, (12, 1_005))).await.unwrap();
        assert_eq!(quote_messages(take(&out).await), vec![quotes_msg(api::Venue::Combined, vec![venue_quote(SAMSUNG, api::Venue::Combined, 112.0, 12.0, 1_005, at(9, 0, 51))])]);
        assert_eq!(day_volume_requests(&h).len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_watch_row_pushed_out_of_realtime_does_not_ask_for_its_day_volume() {
        let h = std_harness();
        let (conn, out) = connect(&h).await;
        live(&h).await;
        h.hub.subscribe(conn, sub("a"), key(NEXTRADE_EXCLUDED, Venue::Combined));
        let mut rows = fillers(REALTIME_LIMIT - 1);
        rows.push(samsung().feed.symbol());
        h.hub.watch(conn, rows, Venue::Krx);
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(out.take(true).messages.contains(&limited(&[SAMSUNG.to_owned()])), "칸이 한 자리를 쓰니 맨 아랫줄 삼성전자가 넘친다");
        assert_eq!(day_volume_requests(&h), Vec::<String>::new(), "실시간 자리를 받지 못한 줄은 거래소별 거래량을 묻지 않는다");
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(day_volume_requests(&h), [samsung_volume_request()], "자리가 나면 그때 묻는다");
    }

    fn samsung_symbol() -> Symbol {
        samsung().feed.symbol()
    }

    fn feed_trade_of(h: &Harness, price: u64, qty: u64, side: Option<TradeSide>, exchange: Option<Exchange>) -> StreamEvent {
        let StreamEvent::Tick { mut tick, received_at } = trade(h, (9, 0, 50), price, qty, exchange) else {
            unreachable!("trade는 Tick이다")
        };
        tick.side = side;
        tick.strength_centi = Some(11_234);
        StreamEvent::Tick { tick, received_at }
    }

    fn book_event(h: &Harness, ask: u64, qty: u64) -> StreamEvent {
        let mut asks = [None; crate::market_source::stream::BOOK_DEPTH];
        asks[0] = Some(BookLevel { price: won(ask), qty: Volume(qty) });
        let book = BookSnapshot {
            symbol: samsung_symbol(),
            venue: Venue::Combined,
            hhmmss: TimeOfDay::hms(9, 0, 50).unwrap(),
            asks,
            bids: [None; crate::market_source::stream::BOOK_DEPTH],
            total_ask_qty: Volume(qty),
            total_bid_qty: Volume(0),
            expected: None,
        };
        StreamEvent::Book { book: Box::new(book), received_at: h.clock.now() }
    }

    fn broker_event(h: &Harness, cumulative: u64) -> StreamEvent {
        let sells = vec![BrokerEntry { member_code: "001".into(), member_name: "키움".into(), cumulative_qty: Volume(cumulative), change_qty: -3 }];
        StreamEvent::Broker { snapshot: BrokerSnapshot { symbol: samsung_symbol(), sells, buys: Vec::new() }, received_at: h.clock.now() }
    }

    fn program_event(h: &Harness, net: i64) -> StreamEvent {
        let row = RealProgramTrade {
            symbol: samsung_symbol(),
            hhmmss: TimeOfDay::hms(9, 0, 50).unwrap(),
            price: Some(won(100)),
            sell_qty: Volume(1),
            sell_amount_million_won: 2,
            buy_qty: Volume(3),
            buy_amount_million_won: 4,
            net_buy_qty: net,
            net_buy_qty_change: -1,
            net_buy_amount_million_won: 5,
            net_buy_amount_change_million_won: 6,
        };
        StreamEvent::Program { row, received_at: h.clock.now() }
    }

    fn after_hours_event(h: &Harness, symbol: Symbol, ask: u64, bid: u64) -> StreamEvent {
        let totals = AfterHoursTotals { symbol, hhmmss: TimeOfDay::hms(8, 35, 12).unwrap(), total_ask_qty: Volume(ask), total_bid_qty: Volume(bid) };
        StreamEvent::AfterHours { totals, received_at: h.clock.now() }
    }

    fn subscribe_feed(h: &Harness, conn: ConnId, name: &str, kind: FeedKind, venue: Venue) {
        h.hub.subscribe_feed(conn, sub(name), samsung_symbol(), kind, venue);
    }

    type SentTrades = Vec<(u64, Vec<(i64, Option<api::Venue>)>)>;

    fn feed_trades(msgs: &[ServerMessage], name: &str) -> SentTrades {
        msgs.iter()
            .filter_map(|m| match m {
                ServerMessage::FeedTrades { sub, seq, trades } if sub == name => Some((*seq, trades.iter().map(|t| (t.qty, t.venue)).collect())),
                _ => None,
            })
            .collect()
    }

    fn feed_subscribed(name: &str, kind: FeedKind) -> ServerMessage {
        ServerMessage::FeedSubscribed { sub: name.into(), kind }
    }

    #[tokio::test(start_paused = true)]
    async fn trades_are_sent_in_order_without_loss_per_flush() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "t", FeedKind::Trades, Venue::Combined);
        assert_eq!(take(&out).await, [feed_subscribed("t", FeedKind::Trades)]);
        for (qty, side) in [(5, Some(TradeSide::Buy)), (7, Some(TradeSide::Sell)), (2, Some(TradeSide::Buy)), (9, None)] {
            h.events.send(feed_trade_of(&h, 100, qty, side, Some(Exchange::Krx))).await.unwrap();
        }
        let msgs = take(&out).await;
        let krx = Some(api::Venue::Krx);
        assert_eq!(feed_trades(&msgs, "t"), [(1, vec![(5, krx), (-7, krx), (2, krx), (9, krx)])], "한 묶음에 네 건이 순서대로 간다");
        let ServerMessage::FeedTrades { trades, .. } = &msgs[0] else { panic!("{msgs:?}") };
        assert_eq!((trades[0].price, trades[0].strength), (100.0, Some(112.34)));
        h.events.send(feed_trade_of(&h, 100, 1, Some(TradeSide::Buy), Some(Exchange::Krx))).await.unwrap();
        assert_eq!(feed_trades(&take(&out).await, "t"), [(2, vec![(1, krx)])]);
        assert!(take(&out).await.is_empty(), "체결이 없으면 빈 묶음을 보내지 않는다");
    }

    #[derive(Clone, Default)]
    struct Logs(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Logs {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Logs {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    fn capture_logs() -> (Logs, tracing::subscriber::DefaultGuard) {
        let logs = Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt().with_writer(move || writer.clone()).with_ansi(false).finish();
        (logs, tracing::subscriber::set_default(subscriber))
    }

    fn book_with(h: &Harness, asks: [Option<BookLevel>; crate::market_source::stream::BOOK_DEPTH]) -> StreamEvent {
        let StreamEvent::Book { mut book, received_at } = book_event(h, 101, 10) else { unreachable!() };
        book.asks = asks;
        book.bids = [Some(BookLevel { price: won(100), qty: Volume(5) }); crate::market_source::stream::BOOK_DEPTH];
        StreamEvent::Book { book, received_at }
    }

    #[tokio::test(start_paused = true)]
    async fn one_line_per_minute_counts_book_frames_with_a_blank_price_level() {
        let (logs, _guard) = capture_logs();
        let h = std_harness();
        live(&h).await;
        let level = |ask: u64| Some(BookLevel { price: won(ask), qty: Volume(5) });
        let mut hole = [None; crate::market_source::stream::BOOK_DEPTH];
        hole[0] = level(101);
        hole[2] = level(103);
        h.events.send(book_with(&h, hole)).await.unwrap();
        h.events.send(book_with(&h, [level(101), level(102), level(103), None, None, None, None, None, None, None])).await.unwrap();
        h.events.send(book_with(&h, [level(101); crate::market_source::stream::BOOK_DEPTH])).await.unwrap();
        settle().await;
        assert!(!logs.text().contains("0D 프레임 카운터"), "1분이 지나기 전에는 줄이 없다");
        tokio::time::sleep(Duration::from_secs(60)).await;
        settle().await;
        let text = logs.text();
        let lines: Vec<&str> = text.lines().filter(|line| line.contains("0D 프레임 카운터")).collect();
        assert_eq!(lines.len(), 1, "{text}");
        assert!(lines[0].contains("book_frames=3") && lines[0].contains("with_blank_level=2") && lines[0].contains("with_hole=1"), "{}", lines[0]);
        tokio::time::sleep(Duration::from_secs(60)).await;
        settle().await;
        assert_eq!(logs.text().matches("0D 프레임 카운터").count(), 1, "다음 1분에는 0D가 없어 줄이 늘지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn no_counter_line_when_every_book_frame_is_complete() {
        let (logs, _guard) = capture_logs();
        let h = std_harness();
        live(&h).await;
        let full = Some(BookLevel { price: won(101), qty: Volume(5) });
        h.events.send(book_with(&h, [full; crate::market_source::stream::BOOK_DEPTH])).await.unwrap();
        settle().await;
        tokio::time::sleep(Duration::from_secs(60)).await;
        settle().await;
        assert!(!logs.text().contains("0D 프레임 카운터"), "{}", logs.text());
    }

    fn book_event_on(h: &Harness, venue: Venue, ask: u64, qty: u64) -> StreamEvent {
        let StreamEvent::Book { mut book, received_at } = book_event(h, ask, qty) else {
            unreachable!("book_event는 Book이다")
        };
        book.venue = venue;
        StreamEvent::Book { book, received_at }
    }

    fn desired_kinds(h: &Harness, symbol: Symbol) -> BTreeSet<StreamKind> {
        h.desired.borrow().get(&symbol).cloned().unwrap_or_default()
    }

    #[tokio::test(start_paused = true)]
    async fn a_krx_book_on_an_nxt_symbol_registers_its_own_code_and_keeps_trades_combined() {
        let h = std_harness();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        subscribe_feed(&h, conn, "k", FeedKind::Book, Venue::Krx);
        settle().await;
        assert_eq!(desired_kinds(&h, samsung_symbol()), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Krx), StreamKind::AfterHours]));
        assert_eq!(KiwoomSeats.seats(&h.desired.borrow()), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_book_on_a_symbol_off_nxt_reuses_the_combined_code_for_krx_and_nxt() {
        let h = std_harness();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        let off_nxt = Symbol::parse(NEXTRADE_EXCLUDED).unwrap();
        h.hub.subscribe_feed(conn, sub("k"), off_nxt, FeedKind::Book, Venue::Krx);
        h.hub.subscribe_feed(conn, sub("n"), off_nxt, FeedKind::Book, Venue::Nxt);
        settle().await;
        assert_eq!(desired_kinds(&h, off_nxt), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]));
        assert_eq!(KiwoomSeats.seats(&h.desired.borrow()), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_book_frame_goes_only_to_the_subs_of_its_own_venue() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "all", FeedKind::Book, Venue::Combined);
        subscribe_feed(&h, conn, "krx", FeedKind::Book, Venue::Krx);
        subscribe_feed(&h, conn, "nxt", FeedKind::Book, Venue::Nxt);
        take(&out).await;
        assert_eq!(desired_kinds(&h, samsung_symbol()), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::Book(Venue::Krx), StreamKind::Book(Venue::Nxt), StreamKind::AfterHours]));
        let fed = |msgs: Vec<ServerMessage>| -> Vec<String> { msgs.into_iter().filter_map(|m| if let ServerMessage::FeedBook { sub, .. } = m { Some(sub) } else { None }).collect() };
        h.events.send(book_event_on(&h, Venue::Nxt, 101, 10)).await.unwrap();
        assert_eq!(fed(take(&out).await), ["nxt"]);
        h.events.send(book_event_on(&h, Venue::Combined, 102, 10)).await.unwrap();
        assert_eq!(fed(take(&out).await), ["all"]);
        h.events.send(book_event_on(&h, Venue::Krx, 103, 10)).await.unwrap();
        assert_eq!(fed(take(&out).await), ["krx"]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_last_holder_of_a_venue_book_leaving_drops_only_that_code_after_the_grace() {
        let h = std_harness();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        subscribe_feed(&h, conn, "all", FeedKind::Book, Venue::Combined);
        subscribe_feed(&h, conn, "nxt", FeedKind::Book, Venue::Nxt);
        settle().await;
        h.hub.unsubscribe(conn, sub("nxt"));
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert!(desired_kinds(&h, samsung_symbol()).contains(&StreamKind::Book(Venue::Nxt)), "유예 안에는 거래소 코드 0D를 유지한다");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(desired_kinds(&h, samsung_symbol()), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_venue_book_resubscribed_within_the_grace_is_not_dropped() {
        let h = std_harness();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        subscribe_feed(&h, conn, "nxt", FeedKind::Book, Venue::Nxt);
        settle().await;
        h.hub.unsubscribe(conn, sub("nxt"));
        tokio::time::sleep(Duration::from_secs(10)).await;
        subscribe_feed(&h, conn, "nxt2", FeedKind::Book, Venue::Nxt);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(desired_kinds(&h, samsung_symbol()).contains(&StreamKind::Book(Venue::Nxt)));
    }

    fn std_harness_before_the_directory() -> Harness {
        period_harness_without_directory(at(9, 0, 50), morning_chart(), Duration::ZERO, Period::M1)
    }

    #[tokio::test(start_paused = true)]
    async fn an_nxt_book_subscribed_before_the_directory_loads_moves_to_the_nxt_code_once_it_loads() {
        let h = std_harness_before_the_directory();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "n", FeedKind::Book, Venue::Nxt);
        settle().await;
        assert_eq!(desired_kinds(&h, samsung_symbol()), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]), "종목 정보가 없는 동안 NXT는 통합으로 받는다");
        h.symbols.replace(listed_directory());
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(desired_kinds(&h, samsung_symbol()).contains(&StreamKind::Book(Venue::Nxt)));
        tokio::time::sleep(Duration::from_secs(31)).await;
        assert_eq!(desired_kinds(&h, samsung_symbol()), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Nxt), StreamKind::AfterHours]), "통합 0D는 유예 뒤에 놓는다");
        out.take(true);
        h.events.send(book_event_on(&h, Venue::Nxt, 101, 10)).await.unwrap();
        let fed: Vec<String> = take(&out).await.into_iter().filter_map(|m| if let ServerMessage::FeedBook { sub, .. } = m { Some(sub) } else { None }).collect();
        assert_eq!(fed, ["n"], "옮긴 뒤에는 NXT 호가를 받는다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_krx_book_of_a_symbol_off_nxt_subscribed_before_the_directory_loads_moves_to_the_combined_code_once_it_loads() {
        let h = std_harness_before_the_directory();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        let off_nxt = Symbol::parse(NEXTRADE_EXCLUDED).unwrap();
        h.hub.subscribe_feed(conn, sub("k"), off_nxt, FeedKind::Book, Venue::Krx);
        settle().await;
        assert_eq!(desired_kinds(&h, off_nxt), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Krx), StreamKind::AfterHours]));
        h.symbols.replace(listed_directory());
        tokio::time::sleep(Duration::from_secs(33)).await;
        assert_eq!(desired_kinds(&h, off_nxt), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]));
        assert_eq!(KiwoomSeats.seats(&h.desired.borrow()), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_rejected_krx_book_that_moves_to_the_combined_code_with_the_directory_is_announced() {
        let h = std_harness_before_the_directory();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        for i in 0..REALTIME_LIMIT - 1 {
            h.hub.subscribe_feed(conn, sub(&format!("f{i}")), Symbol::parse(&listed_filler(i)).unwrap(), FeedKind::Trades, Venue::Krx);
        }
        let off_nxt = Symbol::parse(NEXTRADE_EXCLUDED).unwrap();
        h.hub.subscribe_feed(conn, sub("k"), off_nxt, FeedKind::Book, Venue::Krx);
        settle().await;
        assert!(out.take(true).messages.contains(&sub_error("k", SubErrorCode::RealtimeLimit)));
        h.symbols.replace(listed_directory());
        tokio::time::sleep(Duration::from_secs(2)).await;
        let msgs = out.take(true).messages;
        assert!(msgs.contains(&feed_subscribed("k", FeedKind::Book)), "{msgs:?}");
        assert!(!msgs.contains(&sub_error("k", SubErrorCode::RealtimeLimit)), "{msgs:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_house_book_moved_to_the_nxt_code_by_the_directory_keeps_the_old_code_for_the_grace() {
        let h = std_harness_before_the_directory();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        for i in 0..REALTIME_LIMIT - 1 {
            h.hub.subscribe(conn, sub(&format!("f{i}")), key(&listed_filler(i), Venue::Combined));
        }
        subscribe_feed(&h, conn, "n", FeedKind::Book, Venue::Nxt);
        settle().await;
        assert_eq!(KiwoomSeats.seats(&h.desired.borrow()), REALTIME_LIMIT);
        assert!(desired_kinds(&h, samsung_symbol()).contains(&StreamKind::Book(Venue::Combined)));
        out.take(true);
        h.symbols.replace(listed_directory());
        tokio::time::sleep(Duration::from_secs(2)).await;
        let msgs = out.take(true).messages;
        assert!(desired_kinds(&h, samsung_symbol()).contains(&StreamKind::Book(Venue::Combined)), "옛 통합 0D는 30초 유예 뒤 REMOVE: desired={:?} msgs={msgs:?}", desired_kinds(&h, samsung_symbol()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_venue_book_over_the_limit_is_rejected_and_comes_back_when_a_place_frees() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        for i in 0..REALTIME_LIMIT - 1 {
            h.hub.subscribe(conn, sub(&format!("f{i}")), key(&listed_filler(i), Venue::Combined));
        }
        h.hub.subscribe(conn, sub("a"), samsung());
        settle().await;
        out.take(true);
        subscribe_feed(&h, conn, "nxt", FeedKind::Book, Venue::Nxt);
        settle().await;
        let msgs = out.take(true).messages;
        assert!(msgs.contains(&sub_error("nxt", SubErrorCode::RealtimeLimit)), "{msgs:?}");
        assert!(!msgs.contains(&feed_subscribed("nxt", FeedKind::Book)));
        assert_eq!(KiwoomSeats.seats(&h.desired.borrow()), REALTIME_LIMIT);
        h.hub.unsubscribe(conn, sub("f0"));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let msgs = out.take(true).messages;
        assert!(msgs.contains(&feed_subscribed("nxt", FeedKind::Book)), "유예 중인 종목의 자리를 받아 같은 sub로 다시 알린다: {msgs:?}");
        assert!(desired_kinds(&h, samsung_symbol()).contains(&StreamKind::Book(Venue::Nxt)));
        assert_eq!(KiwoomSeats.seats(&h.desired.borrow()), REALTIME_LIMIT);
    }

    #[tokio::test(start_paused = true)]
    async fn book_sends_only_the_latest_per_flush() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "b", FeedKind::Book, Venue::Combined);
        take(&out).await;
        h.events.send(book_event(&h, 101, 10)).await.unwrap();
        h.events.send(book_event(&h, 102, 20)).await.unwrap();
        let msgs = take(&out).await;
        let [ServerMessage::FeedBook { sub, book }] = msgs.as_slice() else { panic!("{msgs:?}") };
        assert_eq!(sub, "b");
        assert_eq!((book.asks[0], book.total_ask_qty, book.asks.len(), book.bids.len()), (Some(api::FeedBookLevel { price: 102.0, qty: 20 }), 20, 10, 10));
    }

    #[tokio::test(start_paused = true)]
    async fn after_hours_totals_go_to_the_book_subs_of_that_symbol_only() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "b", FeedKind::Book, Venue::Combined);
        subscribe_feed(&h, conn, "p", FeedKind::Program, Venue::Combined);
        subscribe_feed(&h, conn, "t", FeedKind::Trades, Venue::Combined);
        take(&out).await;
        let other = Symbol::parse("000660").unwrap();
        h.events.send(after_hours_event(&h, other, 1, 2)).await.unwrap();
        assert!(take(&out).await.is_empty(), "다른 종목의 0E는 가지 않는다");
        let received_at = h.clock.now();
        h.events.send(after_hours_event(&h, samsung_symbol(), 13_770, 0)).await.unwrap();
        let msgs = take(&out).await;
        let [ServerMessage::FeedAfterHours { sub, totals }] = msgs.as_slice() else { panic!("{msgs:?}") };
        assert_eq!((sub.as_str(), totals.ask_qty, totals.bid_qty), ("b", 13_770, 0));
        assert_eq!(totals.t, feed_time(received_at, TimeOfDay::hms(8, 35, 12).unwrap()));
        let json = serde_json::to_value(&msgs[0]).unwrap();
        assert_eq!(json["type"], "feed_after_hours");
        assert_eq!(json["totals"]["askQty"], 13_770);
    }

    #[test]
    fn the_first_receipt_is_logged_once_per_symbol_per_kst_day() {
        let (a, b) = (samsung_symbol(), Symbol::parse("000660").unwrap());
        let (day1, day2) = (KstDate::new(2026, 11, 9).unwrap(), KstDate::new(2026, 11, 10).unwrap());
        let mut firsts = FirstOfDay::default();
        assert!(firsts.first(a, day1));
        assert!(!firsts.first(a, day1), "같은 날 두 번째는 남기지 않는다");
        assert!(firsts.first(b, day1), "다른 종목은 따로 센다");
        assert!(firsts.first(a, day2), "날이 바뀌면 다시 남긴다");
        assert!(!firsts.first(a, day2));
        assert!(firsts.first(b, day2), "전날 기록은 남지 않는다");
    }

    #[tokio::test(start_paused = true)]
    async fn trades_follow_the_requested_venue() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        for (name, venue) in [("all", Venue::Combined), ("krx", Venue::Krx), ("nxt", Venue::Nxt)] {
            subscribe_feed(&h, conn, name, FeedKind::Trades, venue);
        }
        take(&out).await;
        for (qty, exchange) in [(1, Some(Exchange::Krx)), (2, Some(Exchange::Nxt)), (3, None)] {
            h.events.send(feed_trade_of(&h, 100, qty, Some(TradeSide::Buy), exchange)).await.unwrap();
        }
        let msgs = take(&out).await;
        let (krx, nxt) = (Some(api::Venue::Krx), Some(api::Venue::Nxt));
        assert_eq!(feed_trades(&msgs, "all"), [(1, vec![(1, krx), (2, nxt), (3, None)])]);
        assert_eq!(feed_trades(&msgs, "krx"), [(1, vec![(1, krx)])], "KRX 구독에는 NXT 체결이 가지 않는다");
        assert_eq!(feed_trades(&msgs, "nxt"), [(1, vec![(2, nxt)])]);
    }

    #[tokio::test(start_paused = true)]
    async fn program_rows_are_all_sent() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "p", FeedKind::Program, Venue::Combined);
        take(&out).await;
        for net in [10, -20, 30] {
            h.events.send(program_event(&h, net)).await.unwrap();
        }
        let nets: Vec<i64> = take(&out).await.into_iter().filter_map(|m| match m {
            ServerMessage::FeedProgram { row, .. } => Some(row.net_qty),
            _ => None,
        }).collect();
        assert_eq!(nets, [10, -20, 30]);
    }

    #[tokio::test(start_paused = true)]
    async fn broker_history_is_sent_to_a_late_subscriber() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "first", FeedKind::Brokers, Venue::Combined);
        take(&out).await;
        h.events.send(broker_event(&h, 100)).await.unwrap();
        let received_at = h.clock.now();
        h.events.send(broker_event(&h, 150)).await.unwrap();
        take(&out).await;
        tokio::time::sleep(Duration::from_secs(15)).await;
        let (late_conn, late) = connect(&h).await;
        subscribe_feed(&h, late_conn, "late", FeedKind::Brokers, Venue::Combined);
        let msgs = take(&late).await;
        let [ServerMessage::FeedSubscribed { .. }, ServerMessage::FeedBrokers { sub, brokers }] = msgs.as_slice() else { panic!("{msgs:?}") };
        assert_eq!((sub.as_str(), brokers.sells.len(), brokers.sells[0].qty), ("late", 1, 150), "응답 다음에 가장 새 스냅샷이 먼저 온다");
        assert_eq!(brokers.t.0, received_at.unix(), "t는 구독 시각이 아니라 수신 시각이다");
    }

    #[tokio::test(start_paused = true)]
    async fn broker_history_is_dropped_after_release_and_daily_reset() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "a", FeedKind::Brokers, Venue::Combined);
        take(&out).await;
        h.events.send(broker_event(&h, 100)).await.unwrap();
        take(&out).await;
        h.hub.unsubscribe(conn, sub("a"));
        tokio::time::sleep(Duration::from_secs(20)).await;
        subscribe_feed(&h, conn, "within-grace", FeedKind::Brokers, Venue::Combined);
        assert_eq!(take(&out).await.len(), 2, "유예 안에서는 스냅샷이 남아 있다");
        h.hub.unsubscribe(conn, sub("within-grace"));
        tokio::time::sleep(Duration::from_secs(32)).await;
        subscribe_feed(&h, conn, "after-grace", FeedKind::Brokers, Venue::Combined);
        assert_eq!(take(&out).await, [feed_subscribed("after-grace", FeedKind::Brokers)], "유예가 지나면 버린다");
        h.events.send(broker_event(&h, 200)).await.unwrap();
        take(&out).await;
        h.hub.daily_reset();
        settle().await;
        h.hub.unsubscribe(conn, sub("after-grace"));
        subscribe_feed(&h, conn, "after-reset", FeedKind::Brokers, Venue::Combined);
        assert_eq!(take(&out).await, [feed_subscribed("after-reset", FeedKind::Brokers)], "07:45 비우기에서 버린다");
    }

    #[tokio::test(start_paused = true)]
    async fn feed_subscribers_hear_stream_down_and_live() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "t", FeedKind::Trades, Venue::Combined);
        take(&out).await;
        let down_at = h.clock.now();
        h.events.send(StreamEvent::Down { at: down_at }).await.unwrap();
        let link = |live: bool, at: KstTime| ServerMessage::FeedLink { sub: "t".into(), live, at: UnixSeconds(at.unix()) };
        assert_eq!(take(&out).await.into_iter().filter(|m| matches!(m, ServerMessage::FeedLink { .. })).collect::<Vec<_>>(), [link(false, down_at)]);
        h.events.send(StreamEvent::Down { at: down_at }).await.unwrap();
        assert!(take(&out).await.iter().all(|m| !matches!(m, ServerMessage::FeedLink { .. })), "이미 끊겼으면 다시 알리지 않는다");
        let live_at = h.clock.now();
        h.events.send(StreamEvent::Live { since: live_at }).await.unwrap();
        assert_eq!(take(&out).await.into_iter().filter(|m| matches!(m, ServerMessage::FeedLink { .. })).collect::<Vec<_>>(), [link(true, live_at)]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_feed_opened_while_the_session_is_down_hears_the_link_is_down() {
        let h = std_harness();
        live(&h).await;
        let down_at = h.clock.now();
        h.events.send(StreamEvent::Down { at: down_at }).await.unwrap();
        settle().await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "b", FeedKind::Book, Venue::Combined);
        let link_down = ServerMessage::FeedLink { sub: "b".into(), live: false, at: UnixSeconds(down_at.unix()) };
        assert_eq!(take(&out).await, [feed_subscribed("b", FeedKind::Book), link_down]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_feed_opened_while_the_session_is_live_hears_no_link() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "b", FeedKind::Book, Venue::Combined);
        assert_eq!(take(&out).await, [feed_subscribed("b", FeedKind::Book)]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_feed_asks_the_session_for_its_kind_and_keeps_it_for_the_grace() {
        let h = std_harness();
        live(&h).await;
        let (conn, _out) = connect(&h).await;
        subscribe_feed(&h, conn, "b", FeedKind::Book, Venue::Combined);
        settle().await;
        let want = |kinds: &[StreamKind]| h.desired.borrow().get(&samsung_symbol()).cloned().unwrap_or_default() == kinds.iter().copied().collect::<BTreeSet<_>>();
        assert!(want(&[StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]));
        h.hub.unsubscribe(conn, sub("b"));
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert!(want(&[StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]), "마지막 호가 창을 닫아도 30초 동안 0D와 0E를 유지한다");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(want(&[]), "유예가 지나면 종목째 빠진다");
    }

    #[tokio::test(start_paused = true)]
    async fn releasing_one_of_two_feeds_of_the_same_symbol_and_kind_keeps_the_kind_registered_and_the_other_fed() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "first", FeedKind::Book, Venue::Combined);
        subscribe_feed(&h, conn, "second", FeedKind::Book, Venue::Combined);
        take(&out).await;
        let want = |kinds: &[StreamKind]| h.desired.borrow().get(&samsung_symbol()).cloned().unwrap_or_default() == kinds.iter().copied().collect::<BTreeSet<_>>();
        h.hub.unsubscribe(conn, sub("first"));
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(want(&[StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]), "남은 창이 있으면 유예가 지나도 호가 종류가 등록 목록에 남는다");
        h.events.send(book_event(&h, 101, 10)).await.unwrap();
        let msgs = take(&out).await;
        let [ServerMessage::FeedBook { sub: fed, .. }] = msgs.as_slice() else { panic!("{msgs:?}") };
        assert_eq!(fed, "second", "남은 구독만 다음 호가를 받는다");
        h.hub.unsubscribe(conn, sub("second"));
        tokio::time::sleep(Duration::from_secs(31)).await;
        assert!(want(&[]), "마지막 구독까지 풀리고 유예가 지나면 종목째 빠진다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_feed_for_an_index_or_an_unknown_symbol_is_an_error() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        h.hub.subscribe_feed(conn, sub("i"), Symbol::parse("IDX:001").unwrap(), FeedKind::Trades, Venue::Combined);
        h.hub.subscribe_feed(conn, sub("u"), Symbol::parse(UNLISTED).unwrap(), FeedKind::Book, Venue::Combined);
        assert_eq!(take(&out).await, [sub_error("i", SubErrorCode::BadRequest), sub_error("u", SubErrorCode::UnknownSymbol)]);
    }

    #[tokio::test(start_paused = true)]
    async fn resubscribing_a_feed_sub_drops_what_the_old_one_had_pending() {
        let h = std_harness();
        live(&h).await;
        let (conn, out) = connect(&h).await;
        subscribe_feed(&h, conn, "t", FeedKind::Trades, Venue::Combined);
        take(&out).await;
        h.events.send(feed_trade_of(&h, 100, 4, Some(TradeSide::Buy), Some(Exchange::Krx))).await.unwrap();
        h.events.send(feed_trade_of(&h, 100, 5, Some(TradeSide::Buy), Some(Exchange::Krx))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
        h.hub.unsubscribe(conn, sub("t"));
        subscribe_feed(&h, conn, "t", FeedKind::Trades, Venue::Krx);
        let msgs = take(&out).await;
        assert_eq!(msgs, [feed_subscribed("t", FeedKind::Trades)], "{msgs:?}");
    }
}
