use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use domain::{KstTime, Price, Symbol, TimeOfDay, Venue, Volume};
use tokio::sync::watch;

use super::vi::{ViHistory, ViSignal};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Exchange {
    Krx,
    Nxt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TradeSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealTick {
    pub symbol: Symbol,
    pub hhmmss: TimeOfDay,
    pub price: Price,
    pub qty: Volume,
    pub exchange: Option<Exchange>,
    pub day: Option<DayTotals>,
    pub strength_centi: Option<u64>,
    pub same_time_ratio_centi: Option<u64>,
    pub side: Option<TradeSide>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayTotals {
    pub change_centi: i64,
    pub cumulative: Volume,
    pub traded_million_won: Option<u64>,
}

pub const BOOK_DEPTH: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookLevel {
    pub price: Price,
    pub qty: Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedTrade {
    pub price: Price,
    pub qty: Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedQuote {
    pub symbol: Symbol,
    pub hhmmss: TimeOfDay,
    pub price: Price,
    pub change_centi: i64,
    pub expected_qty: Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookSnapshot {
    pub symbol: Symbol,
    pub venue: Venue,
    pub hhmmss: TimeOfDay,
    pub asks: [Option<BookLevel>; BOOK_DEPTH],
    pub bids: [Option<BookLevel>; BOOK_DEPTH],
    pub total_ask_qty: Volume,
    pub total_bid_qty: Volume,
    pub expected: Option<ExpectedTrade>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealProgramTrade {
    pub symbol: Symbol,
    pub hhmmss: TimeOfDay,
    pub price: Option<Price>,
    pub sell_qty: Volume,
    pub sell_amount_million_won: u64,
    pub buy_qty: Volume,
    pub buy_amount_million_won: u64,
    pub net_buy_qty: i64,
    pub net_buy_qty_change: i64,
    pub net_buy_amount_million_won: i64,
    pub net_buy_amount_change_million_won: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerEntry {
    pub member_code: String,
    pub member_name: String,
    pub cumulative_qty: Volume,
    pub change_qty: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerSnapshot {
    pub symbol: Symbol,
    pub sells: Vec<BrokerEntry>,
    pub buys: Vec<BrokerEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    Tick { tick: RealTick, received_at: KstTime },
    Expected { quote: ExpectedQuote, received_at: KstTime },
    Book { book: Box<BookSnapshot>, received_at: KstTime },
    Program { row: RealProgramTrade, received_at: KstTime },
    Broker { snapshot: BrokerSnapshot, received_at: KstTime },
    AfterHours { totals: AfterHoursTotals, received_at: KstTime },
    Vi { signal: ViSignal, received_at: KstTime },
    SourceSwitched,
    Live { since: KstTime },
    SeatsChanged,
    Down { at: KstTime },
    Idle,
    Halted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AfterHoursTotals {
    pub symbol: Symbol,
    pub hhmmss: TimeOfDay,
    pub total_ask_qty: Volume,
    pub total_bid_qty: Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum StreamKind {
    Trades,
    Index,
    Book(Venue),
    AfterHours,
    Program,
    Brokers,
}

impl StreamKind {
    pub fn base(symbol: Symbol) -> StreamKind {
        match symbol {
            Symbol::Stock(_) => StreamKind::Trades,
            Symbol::Index(_) => StreamKind::Index,
        }
    }

    pub fn serves(self, symbol: Symbol) -> bool {
        match symbol {
            Symbol::Stock(_) => self != StreamKind::Index,
            Symbol::Index(_) => self == StreamKind::Index,
        }
    }
}

pub type DesiredFeeds = BTreeMap<Symbol, BTreeSet<StreamKind>>;

pub fn trades_only(symbols: BTreeSet<Symbol>) -> DesiredFeeds {
    symbols.into_iter().map(|symbol| (symbol, BTreeSet::from([StreamKind::base(symbol)]))).collect()
}

pub trait SeatRules: Send + Sync + 'static {
    fn limit(&self) -> usize;
    fn takes_own_seat(&self, kind: StreamKind) -> bool;
    fn companion(&self, kind: StreamKind) -> Option<StreamKind>;

    fn own_seats(&self, symbol: Symbol, kind: StreamKind) -> BTreeSet<StreamKind> {
        let base = StreamKind::base(symbol);
        std::iter::once(kind).chain(self.companion(kind)).filter(|seat| *seat != base && self.takes_own_seat(*seat)).collect()
    }

    fn seats(&self, desired: &DesiredFeeds) -> usize {
        desired.iter().map(|(symbol, kinds)| 1 + kinds.iter().flat_map(|kind| self.own_seats(*symbol, *kind)).collect::<BTreeSet<_>>().len()).sum()
    }
}

pub trait MarketStream: Send + Sync + 'static {
    fn seat_rules(&self) -> Arc<dyn SeatRules>;
    fn set_desired(&self, desired: DesiredFeeds);
    fn watch_desired(&self) -> watch::Receiver<DesiredFeeds>;
    fn set_venue(&self, _venue: Venue) {}
    fn vi_history(&self) -> Option<ViHistory> {
        None
    }
    fn forget_vi_history(&self) {}
}
