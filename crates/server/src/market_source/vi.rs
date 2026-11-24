use domain::{KstTime, Price, StockCode, TimeOfDay, Weekday};
use futures::future::BoxFuture;

pub type ViHistory = BoxFuture<'static, Option<Vec<ViAlert>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ViMarket {
    Krx,
    Nxt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViAlert {
    pub code: StockCode,
    pub market: ViMarket,
    pub direction: Option<ViDirection>,
    pub trigger_price: Option<Price>,
    pub static_base: Option<Price>,
    pub triggered: TimeOfDay,
    pub released: Option<TimeOfDay>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViTurn {
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViReading {
    pub code: StockCode,
    pub static_base: Option<Price>,
    pub turned: Option<ViTurn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViSignal {
    Alert(ViAlert),
    Reading(ViReading),
}

const fn at(hour: u32, minute: u32) -> TimeOfDay {
    match TimeOfDay::hms(hour, minute, 0) {
        Some(time) => time,
        None => panic!("올바른 시각"),
    }
}

const NXT_OPENS: TimeOfDay = at(8, 0);
const REGULAR_OPENS: TimeOfDay = at(9, 0);
const CLOSING_AUCTION_STARTS: TimeOfDay = at(15, 20);
const AFTER_MARKET_OPENS: TimeOfDay = at(16, 0);
const MARKET_CLOSES: TimeOfDay = at(20, 0);

pub fn vi_triggers_at(market: ViMarket, time: TimeOfDay) -> bool {
    match market {
        ViMarket::Krx => (REGULAR_OPENS..CLOSING_AUCTION_STARTS).contains(&time) || (AFTER_MARKET_OPENS..MARKET_CLOSES).contains(&time),
        ViMarket::Nxt => (NXT_OPENS..MARKET_CLOSES).contains(&time),
    }
}

pub fn vi_session_open(now: KstTime) -> bool {
    !matches!(now.kst_date().weekday(), Weekday::Sat | Weekday::Sun)
        && (REGULAR_OPENS..CLOSING_AUCTION_STARTS).contains(&now.kst_time_of_day())
}
