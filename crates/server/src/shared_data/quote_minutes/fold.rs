use std::cmp::{Ordering, Reverse};
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::super::minute::MinuteVenue;

pub const BOOK_DEPTH: usize = 10;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BookLevel {
    pub price: i64,
    pub combined: i64,
    pub krx: i64,
    pub nxt: i64,
}

impl BookLevel {
    fn qty(self, venue: MinuteVenue) -> i64 {
        match venue {
            MinuteVenue::Combined => self.combined,
            MinuteVenue::Krx => self.krx,
            MinuteVenue::Nxt => self.nxt,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookRow {
    pub sec: u32,
    pub asks: [BookLevel; BOOK_DEPTH],
    pub bids: [BookLevel; BOOK_DEPTH],
}

impl BookRow {
    pub fn minute(&self) -> u16 {
        (self.sec / 60) as u16
    }

    pub fn is_single_price(&self) -> bool {
        let ask_levels = self.asks.iter().filter(|level| level.price != 0).count();
        let bid_levels = self.bids.iter().filter(|level| level.price != 0).count();
        ask_levels <= 3 && bid_levels <= 3
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelQty(pub i64, pub i64);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ladder {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<LevelQty>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bids: Vec<LevelQty>,
}

impl Ladder {
    pub fn is_empty(&self) -> bool {
        self.asks.is_empty() && self.bids.is_empty()
    }

    pub fn ask_total(&self) -> i64 {
        self.asks.iter().map(|level| level.1).sum()
    }

    pub fn bid_total(&self) -> i64 {
        self.bids.iter().map(|level| level.1).sum()
    }

    fn total(&self) -> i64 {
        self.ask_total() + self.bid_total()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueQuote {
    #[serde(default, skip_serializing_if = "Ladder::is_empty")]
    pub close: Ladder,
    #[serde(default, skip_serializing_if = "Ladder::is_empty")]
    pub peak: Ladder,
    #[serde(default, skip_serializing_if = "Ladder::is_empty")]
    pub price_max: Ladder,
}

impl VenueQuote {
    fn is_empty(&self) -> bool {
        self.close.is_empty() && self.peak.is_empty() && self.price_max.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteMinute {
    pub minute: u16,
    pub close_sec: u32,
    #[serde(default)]
    pub single_price: bool,
    #[serde(default, skip_serializing_if = "VenueQuote::is_empty")]
    pub combined: VenueQuote,
    #[serde(default, skip_serializing_if = "VenueQuote::is_empty")]
    pub krx: VenueQuote,
    #[serde(default, skip_serializing_if = "VenueQuote::is_empty")]
    pub nxt: VenueQuote,
}

impl QuoteMinute {
    pub fn venue(&self, venue: MinuteVenue) -> &VenueQuote {
        match venue {
            MinuteVenue::Combined => &self.combined,
            MinuteVenue::Krx => &self.krx,
            MinuteVenue::Nxt => &self.nxt,
        }
    }

    pub fn merged_with(&self, later: &QuoteMinute) -> Option<QuoteMinute> {
        if self.minute != later.minute {
            return None;
        }
        let close_from_later = later.close_sec >= self.close_sec;
        Some(QuoteMinute {
            minute: self.minute,
            close_sec: if close_from_later { later.close_sec } else { self.close_sec },
            single_price: if close_from_later { later.single_price } else { self.single_price },
            combined: merge_venue(&self.combined, &later.combined, close_from_later),
            krx: merge_venue(&self.krx, &later.krx, close_from_later),
            nxt: merge_venue(&self.nxt, &later.nxt, close_from_later),
        })
    }
}

fn merge_venue(first: &VenueQuote, second: &VenueQuote, close_from_second: bool) -> VenueQuote {
    let close = if close_from_second { second.close.clone() } else { first.close.clone() };
    let peak = if second.peak.total() > first.peak.total() { second.peak.clone() } else { first.peak.clone() };
    let price_max = Ladder {
        asks: merge_side(&first.price_max.asks, &second.price_max.asks, true),
        bids: merge_side(&first.price_max.bids, &second.price_max.bids, false),
    };
    VenueQuote { close, peak, price_max }
}

fn merge_side(first: &[LevelQty], second: &[LevelQty], ascending: bool) -> Vec<LevelQty> {
    let mut merged = Vec::with_capacity(first.len().max(second.len()));
    let (mut i, mut j) = (0, 0);
    while i < first.len() && j < second.len() {
        let ord = if ascending { first[i].0.cmp(&second[j].0) } else { second[j].0.cmp(&first[i].0) };
        match ord {
            Ordering::Less => {
                merged.push(first[i]);
                i += 1;
            }
            Ordering::Greater => {
                merged.push(second[j]);
                j += 1;
            }
            Ordering::Equal => {
                merged.push(LevelQty(first[i].0, first[i].1.max(second[j].1)));
                i += 1;
                j += 1;
            }
        }
    }
    merged.extend_from_slice(&first[i..]);
    merged.extend_from_slice(&second[j..]);
    merged
}

struct VenueAccumulator {
    peak_total: i64,
    peak_asks: [LevelQty; BOOK_DEPTH],
    peak_asks_len: usize,
    peak_bids: [LevelQty; BOOK_DEPTH],
    peak_bids_len: usize,
    resumed_peak: Option<Ladder>,
    price_max_asks: BTreeMap<i64, i64>,
    price_max_bids: BTreeMap<i64, i64>,
}

impl VenueAccumulator {
    fn new() -> Self {
        Self {
            peak_total: 0,
            peak_asks: [LevelQty(0, 0); BOOK_DEPTH],
            peak_asks_len: 0,
            peak_bids: [LevelQty(0, 0); BOOK_DEPTH],
            peak_bids_len: 0,
            resumed_peak: None,
            price_max_asks: BTreeMap::new(),
            price_max_bids: BTreeMap::new(),
        }
    }

    fn resumed(quote: VenueQuote) -> Self {
        let peak_total = quote.peak.total();
        let resumed_peak = if quote.peak.is_empty() { None } else { Some(quote.peak) };
        let price_max_asks = quote.price_max.asks.into_iter().map(|level| (level.0, level.1)).collect();
        let price_max_bids = quote.price_max.bids.into_iter().map(|level| (level.0, level.1)).collect();
        Self {
            peak_total,
            peak_asks: [LevelQty(0, 0); BOOK_DEPTH],
            peak_asks_len: 0,
            peak_bids: [LevelQty(0, 0); BOOK_DEPTH],
            peak_bids_len: 0,
            resumed_peak,
            price_max_asks,
            price_max_bids,
        }
    }

    fn record_normal(&mut self, row: &BookRow, venue: MinuteVenue) {
        let mut total = 0i64;
        for level in row.asks {
            if level.price != 0 {
                let qty = level.qty(venue);
                if qty > 0 {
                    total += qty;
                    update_price_max(&mut self.price_max_asks, level.price, qty);
                }
            }
        }
        for level in row.bids {
            if level.price != 0 {
                let qty = level.qty(venue);
                if qty > 0 {
                    total += qty;
                    update_price_max(&mut self.price_max_bids, level.price, qty);
                }
            }
        }
        if total > self.peak_total {
            self.peak_total = total;
            self.resumed_peak = None;
            (self.peak_asks, self.peak_asks_len) = pack_side(&row.asks, venue, true);
            (self.peak_bids, self.peak_bids_len) = pack_side(&row.bids, venue, false);
        }
    }

    fn finish(&self, close: Ladder) -> VenueQuote {
        let peak = if let Some(ladder) = &self.resumed_peak {
            ladder.clone()
        } else if self.peak_total > 0 {
            Ladder {
                asks: self.peak_asks[..self.peak_asks_len].to_vec(),
                bids: self.peak_bids[..self.peak_bids_len].to_vec(),
            }
        } else {
            Ladder::default()
        };
        let price_max = Ladder {
            asks: self.price_max_asks.iter().map(|(&price, &qty)| LevelQty(price, qty)).collect(),
            bids: self.price_max_bids.iter().rev().map(|(&price, &qty)| LevelQty(price, qty)).collect(),
        };
        VenueQuote { close, peak, price_max }
    }
}

fn update_price_max(map: &mut BTreeMap<i64, i64>, price: i64, qty: i64) {
    if let Some(current) = map.get_mut(&price) {
        if qty > *current {
            *current = qty;
        }
    } else {
        map.insert(price, qty);
    }
}

fn pack_side(levels: &[BookLevel; BOOK_DEPTH], venue: MinuteVenue, ascending: bool) -> ([LevelQty; BOOK_DEPTH], usize) {
    let mut packed = [LevelQty(0, 0); BOOK_DEPTH];
    let mut len = 0usize;
    for level in levels {
        if level.price != 0 {
            let qty = level.qty(venue);
            if qty > 0 {
                packed[len] = LevelQty(level.price, qty);
                len += 1;
            }
        }
    }
    if ascending {
        packed[..len].sort_unstable_by_key(|level| level.0);
    } else {
        packed[..len].sort_unstable_by_key(|level| Reverse(level.0));
    }
    (packed, len)
}

fn ladder_from_row(row: &BookRow, venue: MinuteVenue) -> Ladder {
    let (asks, asks_len) = pack_side(&row.asks, venue, true);
    let (bids, bids_len) = pack_side(&row.bids, venue, false);
    Ladder {
        asks: asks[..asks_len].to_vec(),
        bids: bids[..bids_len].to_vec(),
    }
}

pub struct QuoteMinuteBuilder {
    minute: u16,
    close_sec: u32,
    single_price: bool,
    close_row: Option<BookRow>,
    resumed_close: Option<Box<[Ladder; 3]>>,
    combined: VenueAccumulator,
    krx: VenueAccumulator,
    nxt: VenueAccumulator,
}

impl QuoteMinuteBuilder {
    pub fn new(minute: u16) -> Self {
        Self {
            minute,
            close_sec: 0,
            single_price: false,
            close_row: None,
            resumed_close: None,
            combined: VenueAccumulator::new(),
            krx: VenueAccumulator::new(),
            nxt: VenueAccumulator::new(),
        }
    }

    pub fn resumed(minute: QuoteMinute) -> Self {
        let resumed_close = Box::new([
            minute.combined.close.clone(),
            minute.krx.close.clone(),
            minute.nxt.close.clone(),
        ]);
        Self {
            minute: minute.minute,
            close_sec: minute.close_sec,
            single_price: minute.single_price,
            close_row: None,
            resumed_close: Some(resumed_close),
            combined: VenueAccumulator::resumed(minute.combined),
            krx: VenueAccumulator::resumed(minute.krx),
            nxt: VenueAccumulator::resumed(minute.nxt),
        }
    }

    pub fn take(&mut self, row: &BookRow) {
        let single_price = row.is_single_price();
        self.close_sec = row.sec;
        self.single_price = single_price;
        self.close_row = Some(*row);
        self.resumed_close = None;
        if !single_price {
            self.combined.record_normal(row, MinuteVenue::Combined);
            self.krx.record_normal(row, MinuteVenue::Krx);
            self.nxt.record_normal(row, MinuteVenue::Nxt);
        }
    }

    pub fn finish(&self) -> Option<QuoteMinute> {
        let (combined_close, krx_close, nxt_close) = if let Some(row) = &self.close_row {
            (
                ladder_from_row(row, MinuteVenue::Combined),
                ladder_from_row(row, MinuteVenue::Krx),
                ladder_from_row(row, MinuteVenue::Nxt),
            )
        } else if let Some(resumed) = &self.resumed_close {
            (resumed[0].clone(), resumed[1].clone(), resumed[2].clone())
        } else {
            return None;
        };
        Some(QuoteMinute {
            minute: self.minute,
            close_sec: self.close_sec,
            single_price: self.single_price,
            combined: self.combined.finish(combined_close),
            krx: self.krx.finish(krx_close),
            nxt: self.nxt.finish(nxt_close),
        })
    }
}
