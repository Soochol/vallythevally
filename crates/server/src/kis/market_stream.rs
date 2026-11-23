use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use domain::{IndexCode, KstTime, Price, Symbol, TimeOfDay, Venue, Volume};
use tokio::sync::{mpsc, watch};

use super::auth::KisAuth;
use super::notice::{KisNotices, NoticeClaim};
use super::stream::{Connector, KIS_REALTIME_LIMIT, KisStream, RealFrame, StreamEvent as SessionEvent, StreamStatus, Subscription};
use crate::clock::Clock;
use crate::market_source::stream::{
    BOOK_DEPTH, BookLevel, BookSnapshot, BrokerEntry, BrokerSnapshot, DayTotals, DesiredFeeds, Exchange, ExpectedTrade, MarketStream, RealProgramTrade, RealTick, SeatRules, StreamEvent, StreamKind,
    TradeSide,
};
use crate::quotes::effective_book_venue;
use crate::symbols::Directory;

const OUT_BUFFER: usize = 4096;
const INDEX_TR_ID: &str = "H0UPCNT0";
const WON_PER_MILLION: i64 = 1_000_000;

pub struct KisSeats {
    reserved: usize,
    notices: Option<KisNotices>,
}

impl KisSeats {
    pub fn new(reserved: usize) -> KisSeats {
        KisSeats { reserved, notices: None }
    }

    pub fn with_notices(reserved: usize, notices: KisNotices) -> KisSeats {
        KisSeats { reserved, notices: Some(notices) }
    }
}

impl SeatRules for KisSeats {
    fn limit(&self) -> usize {
        let notice_seat = usize::from(self.notices.as_ref().is_some_and(KisNotices::wanted));
        KIS_REALTIME_LIMIT.saturating_sub(self.reserved + notice_seat)
    }

    fn takes_own_seat(&self, kind: StreamKind) -> bool {
        matches!(kind, StreamKind::Book(_) | StreamKind::Program | StreamKind::Brokers)
    }

    fn companion(&self, _: StreamKind) -> Option<StreamKind> {
        None
    }
}

pub struct KisMarketStream {
    desired: watch::Sender<DesiredFeeds>,
    venue: watch::Sender<Venue>,
    status: watch::Receiver<StreamStatus>,
    seats: Arc<KisSeats>,
    _claim: Option<NoticeClaim>,
}

impl KisMarketStream {
    pub fn spawn(connector: Box<dyn Connector>, auth: KisAuth, clock: Clock, directory: watch::Receiver<Option<Arc<Directory>>>, reserved_seats: usize, notices: Option<KisNotices>) -> (KisMarketStream, mpsc::Receiver<StreamEvent>) {
        let claim = notices.as_ref().map(KisNotices::claim);
        let (session, session_events) = KisStream::spawn(connector, auth);
        let (desired, desired_rx) = watch::channel(DesiredFeeds::new());
        let (venue, venue_rx) = watch::channel(Venue::Combined);
        let (out, out_rx) = mpsc::channel(OUT_BUFFER);
        let status = session.watch_status();
        let bridge = Bridge {
            status: session.watch_status(),
            session,
            session_events,
            desired: desired_rx,
            venue: venue_rx,
            directory,
            out,
            clock,
            notice_wanted: notices.as_ref().map(KisNotices::watch_wanted),
            notices: notices.clone(),
            registered: BTreeSet::new(),
            open: false,
            index_cumulative: HashMap::new(),
            program_last: HashMap::new(),
        };
        tokio::spawn(bridge.run());
        let seats = Arc::new(match notices {
            Some(notices) => KisSeats::with_notices(reserved_seats, notices),
            None => KisSeats::new(reserved_seats),
        });
        (KisMarketStream { desired, venue, status, seats, _claim: claim }, out_rx)
    }

    pub fn status(&self) -> StreamStatus {
        self.status.borrow().clone()
    }

    pub fn watch_status(&self) -> watch::Receiver<StreamStatus> {
        self.status.clone()
    }
}

impl MarketStream for KisMarketStream {
    fn seat_rules(&self) -> Arc<dyn SeatRules> {
        self.seats.clone()
    }

    fn set_desired(&self, desired: DesiredFeeds) {
        let desired: DesiredFeeds = desired
            .into_iter()
            .filter_map(|(symbol, kinds)| {
                let kinds: BTreeSet<StreamKind> = kinds.into_iter().filter(|kind| kind.serves(symbol)).collect();
                (!kinds.is_empty()).then_some((symbol, kinds))
            })
            .collect();
        self.desired.send_if_modified(|current| std::mem::replace(current, desired.clone()) != desired);
    }

    fn watch_desired(&self) -> watch::Receiver<DesiredFeeds> {
        self.desired.subscribe()
    }

    fn set_venue(&self, venue: Venue) {
        self.venue.send_if_modified(|current| std::mem::replace(current, venue) != venue);
    }
}

#[derive(Clone, Copy)]
enum Channel {
    Trades,
    Book,
    Program,
    Brokers,
}

impl Channel {
    fn suffix(self) -> &'static str {
        match self {
            Channel::Trades => "CNT0",
            Channel::Book => "ASP0",
            Channel::Program => "PGM0",
            Channel::Brokers => "MBC0",
        }
    }
}

fn venue_code(venue: Venue) -> &'static str {
    match venue {
        Venue::Combined => "UN",
        Venue::Krx => "ST",
        Venue::Nxt => "NX",
    }
}

fn tr_id(channel: Channel, venue: Venue) -> String {
    format!("H0{}{}", venue_code(venue), channel.suffix())
}

enum Incoming {
    Trades(Venue),
    Book(Venue),
    Program,
    Brokers,
    Index,
}

fn incoming(tr_id: &str) -> Option<Incoming> {
    if tr_id == INDEX_TR_ID {
        return Some(Incoming::Index);
    }
    let (venue_code_text, suffix) = tr_id.strip_prefix("H0")?.split_at_checked(2)?;
    let venue = Venue::ALL.into_iter().find(|venue| venue_code(*venue) == venue_code_text)?;
    [(Channel::Trades, Incoming::Trades(venue)), (Channel::Book, Incoming::Book(venue)), (Channel::Program, Incoming::Program), (Channel::Brokers, Incoming::Brokers)]
        .into_iter()
        .find(|(channel, _)| channel.suffix() == suffix)
        .map(|(_, incoming)| incoming)
}

fn kis_index_code(code: IndexCode) -> String {
    let code = code.as_str();
    format!("{}0{}", &code[..1], &code[1..])
}

fn index_code_of(kis: &str) -> Option<IndexCode> {
    let tail = kis.get(2..).filter(|_| kis.len() == 4 && kis.is_ascii())?;
    IndexCode::parse(&format!("{}{}", &kis[..1], tail)).ok()
}

fn subscription(symbol: Symbol, kind: StreamKind, app_venue: Venue, directory: Option<&Directory>) -> Option<Subscription> {
    match (symbol, kind) {
        (Symbol::Index(code), StreamKind::Index) => Some(Subscription { tr_id: INDEX_TR_ID.to_owned(), tr_key: kis_index_code(code) }),
        (Symbol::Stock(code), kind) => {
            let tr_id = match kind {
                StreamKind::Trades => tr_id(Channel::Trades, effective_book_venue(app_venue, directory.and_then(|d| d.get(symbol)).map(|info| info.nxt_enabled))),
                StreamKind::Book(venue) => tr_id(Channel::Book, venue),
                StreamKind::Program => tr_id(Channel::Program, Venue::Combined),
                StreamKind::Brokers => tr_id(Channel::Brokers, Venue::Combined),
                StreamKind::Index | StreamKind::AfterHours => return None,
            };
            Some(Subscription { tr_id, tr_key: code.as_str().to_owned() })
        }
        (Symbol::Index(_), _) => None,
    }
}

fn subscriptions(desired: &DesiredFeeds, app_venue: Venue, directory: Option<&Directory>) -> BTreeSet<Subscription> {
    desired.iter().flat_map(|(&symbol, kinds)| kinds.iter().filter_map(move |&kind| subscription(symbol, kind, app_venue, directory))).collect()
}

struct Record<'a>(&'a [String]);

impl Record<'_> {
    fn text(&self, index: usize) -> Option<&str> {
        self.0.get(index).map(|s| s.trim()).filter(|s| !s.is_empty())
    }

    fn centi(&self, index: usize) -> Option<i64> {
        parse_centi(self.text(index)?)
    }

    fn quantity(&self, index: usize) -> Option<u64> {
        self.text(index)?.parse().ok()
    }

    fn signed(&self, index: usize) -> Option<i64> {
        self.text(index)?.parse().ok()
    }

    fn price(&self, index: usize) -> Option<Price> {
        Price::from_centi(u64::try_from(self.centi(index)?).ok()?)
    }

    fn time(&self, index: usize) -> Option<TimeOfDay> {
        let text = self.text(index).filter(|t| t.len() == 6 && t.bytes().all(|b| b.is_ascii_digit()))?;
        let part = |range: std::ops::Range<usize>| text[range].parse::<u32>().ok();
        TimeOfDay::hms(part(0..2)?, part(2..4)?, part(4..6)?)
    }

    fn change_centi(&self, sign: usize, magnitude: usize) -> Option<i64> {
        let magnitude = self.centi(magnitude)?.abs();
        Some(if matches!(self.text(sign)?, "4" | "5") { -magnitude } else { magnitude })
    }
}

fn parse_centi(text: &str) -> Option<i64> {
    let (negative, unsigned) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.is_empty() && fraction.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let whole: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    let mut cents = fraction.chars().take(2).map(|c| c.to_digit(10)).collect::<Option<Vec<_>>>()?;
    cents.resize(2, 0);
    let value = whole.checked_mul(100)?.checked_add(i64::from(cents[0] * 10 + cents[1]))?;
    Some(if negative { -value } else { value })
}

fn records(frame: &RealFrame) -> Option<impl Iterator<Item = Record<'_>>> {
    let count = frame.count as usize;
    if count == 0 {
        return None;
    }
    if count > 1 && !frame.fields.len().is_multiple_of(count) {
        return None;
    }
    Some(frame.fields.chunks((frame.fields.len() / count).max(1)).take(count).map(Record))
}

#[derive(Default)]
struct ProgramLast {
    net_qty: i64,
    net_amount_million_won: i64,
}

struct Bridge {
    session: KisStream,
    session_events: mpsc::Receiver<SessionEvent>,
    status: watch::Receiver<StreamStatus>,
    desired: watch::Receiver<DesiredFeeds>,
    venue: watch::Receiver<Venue>,
    directory: watch::Receiver<Option<Arc<Directory>>>,
    out: mpsc::Sender<StreamEvent>,
    clock: Clock,
    notices: Option<KisNotices>,
    notice_wanted: Option<watch::Receiver<Option<crate::config::Secret<String>>>>,
    registered: BTreeSet<Subscription>,
    open: bool,
    index_cumulative: HashMap<IndexCode, u64>,
    program_last: HashMap<Symbol, ProgramLast>,
}

impl Bridge {
    async fn run(mut self) {
        let mut directory_alive = true;
        let mut status_alive = true;
        loop {
            let proceed = tokio::select! {
                biased;
                changed = self.desired.changed() => changed.is_ok(),
                changed = self.venue.changed() => changed.is_ok(),
                changed = self.directory.changed(), if directory_alive => {
                    directory_alive = changed.is_ok();
                    true
                }
                changed = async { self.notice_wanted.as_mut().expect("체결통보 구독 바람").changed().await }, if self.notice_wanted.is_some() => {
                    if changed.is_err() {
                        self.notice_wanted = None;
                    }
                    true
                }
                changed = self.status.changed(), if status_alive => {
                    status_alive = changed.is_ok();
                    self.on_status().await
                }
                event = self.session_events.recv() => match event {
                    Some(event) => self.on_session_event(event).await,
                    None => false,
                },
            };
            if !proceed {
                return;
            }
            self.sync_registrations();
        }
    }

    fn sync_registrations(&mut self) {
        let mut wanted = subscriptions(&self.desired.borrow(), *self.venue.borrow(), self.directory.borrow().as_deref());
        wanted.extend(self.notices.as_ref().and_then(KisNotices::subscription));
        if wanted != self.registered {
            self.session.set_desired(wanted.clone());
            self.registered = wanted;
        }
    }

    async fn send(&self, event: StreamEvent) -> bool {
        self.out.send(event).await.is_ok()
    }

    async fn on_status(&mut self) -> bool {
        let status = self.status.borrow_and_update().clone();
        match status {
            StreamStatus::Open if !self.open => {
                self.open = true;
                self.send(StreamEvent::Live { since: self.clock.now() }).await
            }
            StreamStatus::Halted => self.send(StreamEvent::Halted).await,
            _ => true,
        }
    }

    async fn on_session_event(&mut self, event: SessionEvent) -> bool {
        match event {
            SessionEvent::Frame(frame) => self.on_frame(&frame).await,
            SessionEvent::Disconnected(end) => {
                tracing::warn!(?end, "한투 실시간 세션이 끊겼습니다");
                self.open = false;
                self.index_cumulative.clear();
                self.send(StreamEvent::Down { at: self.clock.now() }).await && self.on_status().await
            }
            SessionEvent::InUseElsewhere => {
                tracing::warn!("다른 곳에서 이 한투 키로 실시간을 쓰고 있어 다시 잇지 않습니다");
                self.open = false;
                self.send(StreamEvent::Halted).await
            }
            SessionEvent::Rejected { subscription, failure } => {
                tracing::warn!(?subscription, category = ?failure.category(), "한투 실시간 등록이 거절됐습니다");
                true
            }
            SessionEvent::Registered { subscription, cipher } => {
                if let Some(notices) = &self.notices {
                    notices.on_registered(&subscription, cipher);
                }
                true
            }
            SessionEvent::Sealed(frame) => {
                match self.notices.as_ref().filter(|notices| notices.takes(&frame.tr_id)) {
                    Some(notices) => notices.on_sealed(&frame),
                    None => tracing::debug!(tr_id = %frame.tr_id, "받지 않는 암호화 프레임을 버립니다"),
                }
                true
            }
        }
    }

    async fn on_frame(&mut self, frame: &RealFrame) -> bool {
        if let Some(notices) = self.notices.as_ref().filter(|notices| notices.takes(&frame.tr_id)) {
            notices.on_plain(frame);
            return true;
        }
        let received_at = self.clock.now();
        let Some(kind) = incoming(&frame.tr_id) else {
            tracing::debug!(tr_id = %frame.tr_id, "받지 않는 한투 실시간 프레임을 버립니다");
            return true;
        };
        let Some(records) = records(frame) else {
            tracing::debug!(tr_id = %frame.tr_id, count = frame.count, fields = frame.fields.len(), "건수와 필드 수가 맞지 않는 한투 프레임을 버립니다");
            return true;
        };
        let mut events = Vec::new();
        for record in records {
            let event = match kind {
                Incoming::Trades(venue) => trade(&record, venue, received_at),
                Incoming::Book(venue) => book(&record, venue, received_at),
                Incoming::Program => self.program(&record, received_at),
                Incoming::Brokers => broker(&record, received_at),
                Incoming::Index => self.index(&record, received_at),
            };
            match event {
                Some(event) => events.push(event),
                None => tracing::debug!(tr_id = %frame.tr_id, "읽지 못한 한투 실시간 항목을 버립니다"),
            }
        }
        for event in events {
            if !self.send(event).await {
                return false;
            }
        }
        true
    }

    fn program(&mut self, record: &Record, received_at: KstTime) -> Option<StreamEvent> {
        let symbol = Symbol::parse(record.text(0)?).ok().filter(|s| matches!(s, Symbol::Stock(_)))?;
        let million_won = |index: usize| record.signed(index).map_or(0, |won| won / WON_PER_MILLION);
        let net_qty = record.signed(6).unwrap_or(0);
        let net_amount = million_won(7);
        let last = self.program_last.insert(symbol, ProgramLast { net_qty, net_amount_million_won: net_amount }).unwrap_or_default();
        let row = RealProgramTrade {
            symbol,
            hhmmss: record.time(1).unwrap_or_else(|| received_at.kst_time_of_day()),
            price: None,
            sell_qty: Volume(record.quantity(2).unwrap_or(0)),
            sell_amount_million_won: u64::try_from(million_won(3)).unwrap_or(0),
            buy_qty: Volume(record.quantity(4).unwrap_or(0)),
            buy_amount_million_won: u64::try_from(million_won(5)).unwrap_or(0),
            net_buy_qty: net_qty,
            net_buy_qty_change: net_qty.saturating_sub(last.net_qty),
            net_buy_amount_million_won: net_amount,
            net_buy_amount_change_million_won: net_amount.saturating_sub(last.net_amount_million_won),
        };
        Some(StreamEvent::Program { row, received_at })
    }

    fn index(&mut self, record: &Record, received_at: KstTime) -> Option<StreamEvent> {
        let code = index_code_of(record.text(0)?)?;
        let cumulative = record.quantity(5);
        let before = cumulative.and_then(|now| self.index_cumulative.insert(code, now));
        let qty = cumulative.zip(before).map_or(0, |(now, before)| now.saturating_sub(before));
        let change_centi = record.change_centi(3, 4);
        let day = change_centi.zip(cumulative).map(|(change_centi, cumulative)| DayTotals { change_centi, cumulative: Volume(cumulative) });
        let tick = RealTick {
            symbol: Symbol::Index(code),
            hhmmss: record.time(1).unwrap_or_else(|| received_at.kst_time_of_day()),
            price: record.price(2)?,
            qty: Volume(qty),
            exchange: None,
            day,
            strength_centi: None,
            side: None,
        };
        Some(StreamEvent::Tick { tick, received_at })
    }
}

fn stock_symbol(record: &Record) -> Option<Symbol> {
    Symbol::parse(record.text(0)?).ok().filter(|s| matches!(s, Symbol::Stock(_)))
}

fn trade(record: &Record, venue: Venue, received_at: KstTime) -> Option<StreamEvent> {
    let qty = record.quantity(12).filter(|qty| *qty > 0)?;
    let day = record.change_centi(3, 4).zip(record.quantity(13)).map(|(change_centi, cumulative)| DayTotals { change_centi, cumulative: Volume(cumulative) });
    let side = match record.text(21) {
        Some("1") => Some(TradeSide::Buy),
        Some("5") => Some(TradeSide::Sell),
        _ => None,
    };
    let exchange = match venue {
        Venue::Combined => None,
        Venue::Krx => Some(Exchange::Krx),
        Venue::Nxt => Some(Exchange::Nxt),
    };
    let tick = RealTick {
        symbol: stock_symbol(record)?,
        hhmmss: record.time(1).unwrap_or_else(|| received_at.kst_time_of_day()),
        price: record.price(2)?,
        qty: Volume(qty),
        exchange,
        day,
        strength_centi: record.centi(18).and_then(|centi| u64::try_from(centi).ok()),
        side,
    };
    Some(StreamEvent::Tick { tick, received_at })
}

fn book_side(record: &Record, price_base: usize, qty_base: usize) -> [Option<BookLevel>; BOOK_DEPTH] {
    std::array::from_fn(|level| {
        record.price(price_base + level).map(|price| BookLevel { price, qty: Volume(record.quantity(qty_base + level).unwrap_or(0)) })
    })
}

fn book(record: &Record, venue: Venue, received_at: KstTime) -> Option<StreamEvent> {
    let expected = record.price(47).map(|price| ExpectedTrade { price, qty: Volume(record.quantity(48).unwrap_or(0)) });
    let book = BookSnapshot {
        symbol: stock_symbol(record)?,
        venue,
        hhmmss: record.time(1).unwrap_or_else(|| received_at.kst_time_of_day()),
        asks: book_side(record, 3, 23),
        bids: book_side(record, 13, 33),
        total_ask_qty: Volume(record.quantity(43).unwrap_or(0)),
        total_bid_qty: Volume(record.quantity(44).unwrap_or(0)),
        expected,
    };
    Some(StreamEvent::Book { book: Box::new(book), received_at })
}

fn broker_side(record: &Record, name_base: usize, qty_base: usize, code_base: usize, change_base: usize) -> Vec<BrokerEntry> {
    (0..5)
        .filter_map(|rank| {
            let code = record.text(code_base + rank);
            let name = record.text(name_base + rank);
            let member_code = code.or(name)?.to_owned();
            Some(BrokerEntry {
                member_name: name.unwrap_or(&member_code).to_owned(),
                member_code,
                cumulative_qty: Volume(record.quantity(qty_base + rank).unwrap_or(0)),
                change_qty: record.signed(change_base + rank).unwrap_or(0),
            })
        })
        .collect()
}

fn broker(record: &Record, received_at: KstTime) -> Option<StreamEvent> {
    let snapshot = BrokerSnapshot {
        symbol: stock_symbol(record)?,
        sells: broker_side(record, 1, 11, 31, 51),
        buys: broker_side(record, 6, 16, 36, 56),
    };
    Some(StreamEvent::Broker { snapshot, received_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_and_index_levels_become_hundredths() {
        assert_eq!(parse_centi("71200"), Some(7_120_000));
        assert_eq!(parse_centi("2650.12"), Some(265_012));
        assert_eq!(parse_centi("-3.5"), Some(-350));
        assert_eq!(parse_centi("+.07"), Some(7));
        assert_eq!(parse_centi("x"), None);
        for malformed in ["--5", "+-3.5", "-", ".", "", "1.x"] {
            assert_eq!(parse_centi(malformed), None, "{malformed}");
        }
    }

    #[test]
    fn index_codes_convert_between_kiwoom_and_kis_forms() {
        for (kiwoom, kis) in [("001", "0001"), ("101", "1001"), ("201", "2001")] {
            let code = IndexCode::parse(kiwoom).unwrap();
            assert_eq!(kis_index_code(code), kis);
            assert_eq!(index_code_of(kis), Some(code));
        }
        assert_eq!(index_code_of("001"), None);
        assert_eq!(index_code_of("é01"), None);
    }

    #[test]
    fn tr_ids_follow_the_venue() {
        assert_eq!(tr_id(Channel::Trades, Venue::Combined), "H0UNCNT0");
        assert_eq!(tr_id(Channel::Book, Venue::Krx), "H0STASP0");
        assert_eq!(tr_id(Channel::Program, Venue::Nxt), "H0NXPGM0");
        assert!(matches!(incoming("H0NXCNT0"), Some(Incoming::Trades(Venue::Nxt))));
        assert!(matches!(incoming("H0UPCNT0"), Some(Incoming::Index)));
        assert!(incoming("H0STCNI0").is_none());
    }

    #[test]
    fn seats_never_go_below_zero_after_the_reserved_ones() {
        assert_eq!(KisSeats::new(0).limit(), 40);
        assert_eq!(KisSeats::new(1).limit(), 39);
        assert_eq!(KisSeats::new(99).limit(), 0);
    }
}
