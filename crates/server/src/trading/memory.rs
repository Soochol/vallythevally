use std::collections::HashMap;
use std::sync::Mutex;

use domain::{KstDate, StockCode, Venue};

use super::service::OpenEntry;

const OPEN_ORDERS_FRESH_SECS: i64 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PriceBand {
    upper: u64,
    lower: u64,
}

impl PriceBand {
    pub(super) fn from_limits(upper: Option<u64>, lower: Option<u64>) -> Option<PriceBand> {
        match (upper.filter(|v| *v > 0), lower.filter(|v| *v > 0)) {
            (Some(upper), Some(lower)) => Some(PriceBand { upper, lower }),
            _ => None,
        }
    }

    pub(super) fn contains(self, price: u64) -> bool {
        price >= self.lower && price <= self.upper
    }
}

#[derive(Default)]
pub(super) struct PriceBands(Mutex<HashMap<StockCode, (KstDate, PriceBand)>>);

impl PriceBands {
    pub(super) fn remember(&self, code: StockCode, day: KstDate, band: PriceBand) {
        self.0.lock().expect("상·하한가 기억 잠금").insert(code, (day, band));
    }

    pub(super) fn of_day(&self, code: StockCode, day: KstDate) -> Option<PriceBand> {
        self.0.lock().expect("상·하한가 기억 잠금").get(&code).filter(|(remembered, _)| *remembered == day).map(|(_, band)| *band)
    }
}

#[derive(Default)]
pub(super) struct FillVenues(Mutex<HashMap<String, (KstDate, Venue)>>);

impl FillVenues {
    pub(super) fn remember(&self, order_no: &str, day: KstDate, venue: Venue) {
        let mut venues = self.0.lock().expect("체결 거래소 기억 잠금");
        venues.retain(|_, (remembered, _)| *remembered == day);
        venues.insert(order_no.to_owned(), (day, venue));
    }

    pub(super) fn of(&self, order_no: &str, day: KstDate) -> Option<Venue> {
        self.0.lock().expect("체결 거래소 기억 잠금").get(order_no).filter(|(remembered, _)| *remembered == day).map(|(_, venue)| *venue)
    }
}

struct Kept {
    account_ref: String,
    at: i64,
    entries: Vec<OpenEntry>,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    kept: Option<Kept>,
}

#[derive(Default)]
pub(super) struct RecentOpenOrders(Mutex<Inner>);

#[derive(Clone, Copy)]
pub(super) struct Ticket(u64);

impl RecentOpenOrders {
    pub(super) fn ticket(&self) -> Ticket {
        Ticket(self.0.lock().expect("미체결 기억 잠금").generation)
    }

    pub(super) fn keep(&self, ticket: Ticket, account_ref: &str, at: i64, entries: &[OpenEntry]) {
        let mut inner = self.0.lock().expect("미체결 기억 잠금");
        if inner.generation == ticket.0 {
            inner.kept = Some(Kept { account_ref: account_ref.to_owned(), at, entries: entries.to_vec() });
        }
    }

    pub(super) fn forget(&self) {
        let mut inner = self.0.lock().expect("미체결 기억 잠금");
        inner.generation += 1;
        inner.kept = None;
    }

    pub(super) fn find(&self, account_ref: &str, now: i64, order_no: &str) -> Option<OpenEntry> {
        let inner = self.0.lock().expect("미체결 기억 잠금");
        let kept = inner.kept.as_ref().filter(|k| k.account_ref == account_ref && (0..OPEN_ORDERS_FRESH_SECS).contains(&(now - k.at)))?;
        kept.entries.iter().find(|e| e.order.order_no == order_no && e.order.open_quantity > 0).cloned()
    }
}
