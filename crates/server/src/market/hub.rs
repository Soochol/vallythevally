//! `MarketHub` 액터(backend.md §5.5). 실시간 상태는 태스크 하나가 혼자 가진다. 락이 없다.
//!
//! 허브는 자기 입력 말고는 아무것도 기다리지 않는다. 키움 조회(`BarService`)는 허브가 띄운 태스크가 기다리고 결과를 입력으로 돌려준다.
//! 브라우저로 보낼 것은 연결마다의 `Outbox`에 넣기만 한다.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use domain::{
    Aggregator, Applied, Bucket, CLOSE_GRACE_SECS, ConfirmedBar, CurrentBar, Feed, KstTime, Ohlcv, SESSION_CLOSE, SeriesKey, Symbol, TRADING_OPEN,
    Trade, TradeTimeError, Venue, resolve_trade_time,
};
use tokio::sync::{mpsc, oneshot};

use super::outbox::Outbox;
use super::subscriptions::{Holder, SubscriptionManager};
use super::{ConnId, SubId};
use crate::api::{self, ConnectionStatus, RealtimeState, ReloadReason, ServerMessage, SubErrorCode, UnixSeconds};
use crate::bars::{BarError, BarService, Seed};
use crate::clock::Clock;
use crate::kiwoom::rest::Priority;
use crate::kiwoom::stream::{Exchange, KiwoomStream, RealTick, StreamEvent};

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

    /// 답(`subscribed`, `sub_error`)은 그 연결의 outbox로 간다.
    pub fn subscribe(&self, conn: ConnId, sub: SubId, key: SeriesKey) {
        self.send(HubInput::Subscribe { conn, sub, key });
    }

    pub fn unsubscribe(&self, conn: ConnId, sub: SubId) {
        self.send(HubInput::Unsubscribe { conn, sub });
    }

    pub fn disconnect(&self, conn: ConnId) {
        self.send(HubInput::Disconnect(conn));
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

    fn send(&self, input: HubInput) {
        if self.tx.send(input).is_err() {
            tracing::error!("MarketHub가 멈췄습니다");
        }
    }
}

enum HubInput {
    Connect { conn: ConnId, outbox: Arc<Outbox> },
    Subscribe { conn: ConnId, sub: SubId, key: SeriesKey },
    Unsubscribe { conn: ConnId, sub: SubId },
    Disconnect(ConnId),
    Snapshot { key: SeriesKey, reply: oneshot::Sender<Option<HubSnapshot>> },
    DailyReset,
    Seeded { key: SeriesKey, generation: u64, result: Result<Seed, BarError> },
    Verified { key: SeriesKey, generation: u64, bucket: Bucket, attempt: u32, result: Result<Option<ConfirmedBar>, BarError> },
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

struct Conn {
    outbox: Arc<Outbox>,
    subs: HashMap<SubId, SeriesKey>,
}

#[derive(Debug, Default)]
struct Counters {
    outside_window: u64,
    from_future: u64,
    too_old: u64,
    unknown_exchange: u64,
    while_seeding: u64,
    late: u64,
}

pub struct MarketHub {
    bars: Arc<BarService>,
    stream: KiwoomStream,
    clock: Clock,
    tx: mpsc::UnboundedSender<HubInput>,
    manager: SubscriptionManager,
    rejected: BTreeSet<Holder>,
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
    pub fn spawn(bars: Arc<BarService>, stream: KiwoomStream, events: mpsc::Receiver<StreamEvent>, clock: Clock) -> HubHandle {
        let (tx, rx) = mpsc::unbounded_channel();
        let now = clock.now();
        let hub = MarketHub {
            bars,
            stream,
            clock,
            tx: tx.clone(),
            manager: SubscriptionManager::default(),
            rejected: BTreeSet::new(),
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

    /// 키움 세션 없이 띄운다. 시험이 체결과 세션 이벤트를 직접 넣는다.
    #[cfg(test)]
    pub(crate) fn detached(bars: Arc<BarService>, clock: Clock) -> (HubHandle, mpsc::Sender<StreamEvent>) {
        let (stream, _) = KiwoomStream::detached();
        let (events, rx) = mpsc::channel(64);
        (MarketHub::spawn(bars, stream, rx, clock), events)
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
                    self.conns.insert(conn, Conn { outbox, subs: HashMap::new() });
                }
            }
            HubInput::Subscribe { conn, sub, key } => self.subscribe(conn, sub, key, now),
            HubInput::Unsubscribe { conn, sub } => {
                if let Some(key) = self.conns.get_mut(&conn).and_then(|c| c.subs.remove(&sub)) {
                    self.release(conn, sub, key, now);
                    self.replan(now);
                }
            }
            HubInput::Disconnect(conn) => self.drop_conn(conn, now),
            HubInput::Snapshot { key, reply } => {
                let snap = self.keys.get(&key).map(|ks| HubSnapshot {
                    seq: ks.seq,
                    current: ks.current(),
                    recent_confirmed: ks.recent_confirmed.iter().copied().collect(),
                });
                let _ = reply.send(snap);
            }
            HubInput::DailyReset => {
                tracing::info!(keys = self.keys.len(), "07:45 실시간 키를 모두 다시 시드합니다");
                self.reseed_all(SeedPurpose::Reload { reason: ReloadReason::DailyReset, from: None });
            }
            HubInput::Seeded { key, generation, result } => self.on_seeded(key, generation, result, now),
            HubInput::Verified { key, generation, bucket, attempt, result } => self.on_verified(key, generation, bucket, attempt, result, now),
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
        self.replan(now);
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
        self.stream.set_desired(plan.realtime);
        let newly: Vec<Holder> = plan.rejected.difference(&self.rejected).cloned().collect();
        let recovered: Vec<Holder> = self.rejected.difference(&plan.rejected).cloned().collect();
        self.rejected = plan.rejected;
        for Holder::Cell { conn, sub } in newly {
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
        for Holder::Cell { conn, sub } in recovered {
            if let Some(key) = self.conns.get(&conn).and_then(|c| c.subs.get(&sub)).copied() {
                self.attach(conn, sub, key);
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
            StreamEvent::Down { at } => {
                let from = *self.gap_from.get_or_insert(at);
                self.session_down(RealtimeState::Reconnecting, from);
            }
            StreamEvent::Halted => {
                let now = self.clock.now();
                self.gap_from.get_or_insert(now);
                self.session_down(RealtimeState::Halted, now);
            }
            StreamEvent::Live { since } => {
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
        self.replan(now);
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

/// `_AL` 한 흐름을 거래소별 키로 나눈다(ADR 0007). `9081`이 없거나 모르는 값이면 통합에만 넣는다.
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
    use tokio::sync::watch;

    use super::*;
    use crate::api::Bar;
    use crate::market::subscriptions::REALTIME_LIMIT;
    use crate::clock::kst;
    use crate::config::Secret;
    use crate::kiwoom::api::ApiId;
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::rest::KiwoomRest;
    use crate::kiwoom::rest::testing::{FakeTransport, ok, status, token};
    use crate::market::outbox::Outbox;
    use crate::symbols::{Directory, SymbolDirectory};

    const SAMSUNG: &str = "005930";
    const NOT_ON_NXT: &str = "005935";
    const UNLISTED: &str = "000020";

    fn at(h: u32, m: u32, s: u32) -> KstTime {
        kst(KstDate::new(2026, 11, 9).unwrap(), h, m, s)
    }

    #[derive(Default)]
    struct Chart {
        rows: Vec<(KstTime, [u64; 5])>,
        answer_503_times: usize,
    }

    impl Chart {
        fn set(&mut self, start: KstTime, row: [u64; 5]) {
            self.rows.retain(|(t, _)| *t != start);
            self.rows.push((start, row));
            self.rows.sort_by_key(|(t, _)| *t);
        }
    }

    struct Harness {
        hub: HubHandle,
        events: mpsc::Sender<StreamEvent>,
        desired: watch::Receiver<BTreeSet<Symbol>>,
        bars: Arc<BarService>,
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
        let chart = Arc::new(Mutex::new(chart));
        let script = chart.clone();
        let fake = Arc::new(FakeTransport::new(latency, move |s| {
            if s.api_id == ApiId::Au10001 {
                return token(1);
            }
            assert_eq!(s.api_id, ApiId::Ka10080, "허브 시험은 주식 분봉만 받는다");
            let mut c = script.lock().unwrap();
            if c.answer_503_times > 0 {
                c.answer_503_times -= 1;
                return status(503, json!({}));
            }
            let rows: Vec<_> = c
                .rows
                .iter()
                .rev()
                .map(|(t, [o, h, l, cl, v])| {
                    let tod = t.kst_time_of_day().secs();
                    json!({"cntr_tm": format!("{}{:02}{:02}00", t.kst_date().yyyymmdd(), tod / 3600, tod / 60 % 60),
                           "open_pric": o.to_string(), "high_pric": h.to_string(), "low_pric": l.to_string(), "cur_prc": cl.to_string(), "trde_qty": v.to_string()})
                })
                .collect();
            ok(json!({"stk_min_pole_chart_qry": rows, "return_code": 0}), None)
        }));
        let clock = Clock::fake(start);
        let rest = KiwoomRest::new(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let stock = |code: &str, nxt_enabled| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: code.into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled };
        let mut listed = vec![stock(SAMSUNG, true), stock(NOT_ON_NXT, false)];
        listed.extend((0..REALTIME_LIMIT).map(|i| stock(&listed_filler(i), false)));
        symbols.replace(Directory::build(listed));
        let bars = Arc::new(BarService::new(rest, symbols, clock.clone()));
        let (stream, desired) = KiwoomStream::detached();
        let (events, rx) = mpsc::channel(64);
        let hub = MarketHub::spawn(bars.clone(), stream, rx, clock.clone());
        Harness { hub, events, desired, bars, chart, fake, clock }
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
        };
        StreamEvent::Tick { tick, received_at: h.clock.now() }
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
        assert_eq!(*h.desired.borrow(), BTreeSet::from([samsung().feed.symbol()]));
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
        assert_eq!(*h.desired.borrow(), BTreeSet::from([samsung().feed.symbol()]), "거래소가 셋이어도 REG는 하나");
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
        assert_eq!(*h.desired.borrow(), BTreeSet::from([symbol]), "30초 유예");
        h.hub.subscribe(conn, sub("a2"), samsung());
        assert_eq!(take(&out).await, vec![subscribed("a2", 2, None)], "유예 중 다시 구독하면 키를 이어 쓴다(09:00 봉은 타이머로 확정됐다)");
        h.hub.unsubscribe(conn, sub("a2"));
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert_eq!(*h.desired.borrow(), BTreeSet::from([symbol]));
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(*h.desired.borrow(), BTreeSet::new());
        assert_eq!(h.hub.snapshot(samsung()).await, None, "구독도 유예도 없는 키는 내린다");
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_connection_releases_its_subs() {
        let h = std_harness();
        let (conn, _out) = subscribed_samsung(&h).await;
        h.hub.disconnect(conn);
        tokio::time::sleep(Duration::from_secs(31)).await;
        assert_eq!(*h.desired.borrow(), BTreeSet::new());
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
        h.hub.subscribe(conn, sub("y"), key(NOT_ON_NXT, Venue::Nxt));
        assert_eq!(
            take(&out).await,
            vec![subscribed("x", 0, None), subscribed("y", 0, None), sub_error("x", SubErrorCode::UnknownSymbol), sub_error("y", SubErrorCode::BadRequest)]
        );
        assert_eq!(*h.desired.borrow(), BTreeSet::new(), "받을 수 없는 종목은 유예 없이 놓는다");
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
        assert!(!h.desired.borrow().contains(&samsung().feed.symbol()));
        assert!(h.desired.borrow().contains(&Symbol::parse(&listed_filler(REALTIME_LIMIT - 1)).unwrap()));
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

}
