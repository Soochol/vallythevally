use domain::{KstTime, Price, StockCode, TimeOfDay, Weekday};
use futures::future::BoxFuture;

pub type ViHistory = BoxFuture<'static, Option<Vec<ViAlert>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViAlert {
    pub code: StockCode,
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

const REGULAR_OPENS: TimeOfDay = at(9, 0);
const CLOSING_AUCTION_STARTS: TimeOfDay = at(15, 20);

pub fn vi_triggers_at(time: TimeOfDay) -> bool {
    (REGULAR_OPENS..CLOSING_AUCTION_STARTS).contains(&time)
}

pub fn vi_session_open(now: KstTime) -> bool {
    !matches!(now.kst_date().weekday(), Weekday::Sat | Weekday::Sun) && vi_triggers_at(now.kst_time_of_day())
}
