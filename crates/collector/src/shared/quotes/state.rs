use std::collections::BTreeMap;

use server::shared_data::{BookRow, CurrentQuotes, QuoteMinute, QuoteMinuteBuilder};

pub const CLOSE_AFTER_SECS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    Counted,
    TooLate,
}

struct ActiveMinute {
    minute: u16,
    builder: QuoteMinuteBuilder,
}

struct StockState {
    active: Option<ActiveMinute>,
    closed_through: Option<u16>,
}

pub struct LiveQuotes {
    date: u32,
    stocks: BTreeMap<String, StockState>,
    pending: Vec<(String, QuoteMinute)>,
    current_dirty: bool,
}

impl LiveQuotes {
    pub fn new(date: u32) -> LiveQuotes {
        LiveQuotes {
            date,
            stocks: BTreeMap::new(),
            pending: Vec::new(),
            current_dirty: false,
        }
    }

    pub fn resumed(date: u32, current: CurrentQuotes) -> LiveQuotes {
        let mut live = LiveQuotes::new(date);
        for (code, quote) in current.minutes {
            let minute = quote.minute;
            let state = StockState {
                active: Some(ActiveMinute { minute, builder: QuoteMinuteBuilder::resumed(quote) }),
                closed_through: minute.checked_sub(1),
            };
            live.stocks.insert(code, state);
        }
        live
    }

    pub fn date(&self) -> u32 {
        self.date
    }

    pub fn take(&mut self, code: &str, row: &BookRow) -> Applied {
        let minute = row.minute();
        let stock = match self.stocks.get_mut(code) {
            Some(stock) => stock,
            None => {
                self.stocks.insert(code.to_owned(), StockState { active: None, closed_through: None });
                self.stocks.get_mut(code).expect("방금 넣었다")
            }
        };
        if stock.closed_through.is_some_and(|closed| minute <= closed) {
            return Applied::TooLate;
        }
        if let Some(active) = stock.active.as_mut() {
            if minute < active.minute {
                return Applied::TooLate;
            }
            if minute == active.minute {
                active.builder.take(row);
                self.current_dirty = true;
                return Applied::Counted;
            }
            let finished = stock.active.take().expect("방금 확인했다");
            if let Some(quote) = finished.builder.finish() {
                self.pending.push((code.to_owned(), quote));
            }
            stock.closed_through = Some(finished.minute);
        }
        let mut builder = QuoteMinuteBuilder::new(minute);
        builder.take(row);
        stock.active = Some(ActiveMinute { minute, builder });
        self.current_dirty = true;
        Applied::Counted
    }

    pub fn settle(&mut self, now_sec: u32) {
        for (code, stock) in &mut self.stocks {
            let should_close = stock
                .active
                .as_ref()
                .is_some_and(|active| (u32::from(active.minute) + 1) * 60 + CLOSE_AFTER_SECS <= now_sec);
            if should_close {
                let finished = stock.active.take().expect("방금 확인했다");
                if let Some(quote) = finished.builder.finish() {
                    self.pending.push((code.clone(), quote));
                }
                stock.closed_through = Some(finished.minute);
                self.current_dirty = true;
            }
        }
    }

    pub(crate) fn finish_all(&mut self) {
        for (code, stock) in &mut self.stocks {
            if let Some(finished) = stock.active.take() {
                if let Some(quote) = finished.builder.finish() {
                    self.pending.push((code.clone(), quote));
                }
                stock.closed_through = Some(finished.minute);
                self.current_dirty = true;
            }
        }
    }

    pub fn pending(&self) -> &[(String, QuoteMinute)] {
        &self.pending
    }

    pub fn written(&mut self, count: usize) {
        let drain_count = count.min(self.pending.len());
        self.pending.drain(..drain_count);
    }

    pub fn current(&self) -> CurrentQuotes {
        let mut minutes = BTreeMap::new();
        for (code, stock) in &self.stocks {
            if let Some(active) = &stock.active
                && let Some(quote) = active.builder.finish()
            {
                minutes.insert(code.clone(), quote);
            }
        }
        CurrentQuotes { minutes }
    }

    pub(crate) fn is_current_dirty(&self) -> bool {
        self.current_dirty
    }

    pub(crate) fn mark_current_saved(&mut self) {
        self.current_dirty = false;
    }
}
