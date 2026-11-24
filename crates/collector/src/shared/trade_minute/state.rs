use std::collections::{BTreeMap, VecDeque};

use server::shared_data::TradeMinuteLine;

use crate::kst::KstTime;

const MAX_TRADES_PER_MINUTE: usize = 10;
const MS_PER_MINUTE: u32 = 60_000;

#[derive(Default)]
pub struct MinuteState {
    open: Option<(u32, u16)>,
    closed_through: Option<(u32, u16)>,
    stocks: BTreeMap<String, VecDeque<(u32, u64, i64)>>,
}

impl MinuteState {
    pub fn open_key(&self) -> Option<(u32, u16)> {
        self.open
    }

    pub fn is_too_late(&self, date: u32, minute: u16) -> bool {
        let key = (date, minute);
        self.closed_through.is_some_and(|closed| key <= closed) || self.open.is_some_and(|open| key < open)
    }

    pub fn is_elapsed(&self, now_ms: i64, grace_ms: u32) -> bool {
        let Some((open_date, open_minute)) = self.open else {
            return false;
        };
        let now = KstTime::from_unix_ms(now_ms);
        if now.date > open_date {
            return true;
        }
        if now.date < open_date {
            return false;
        }
        let threshold = (u32::from(open_minute) + 1).saturating_mul(MS_PER_MINUTE).saturating_add(grace_ms);
        now.ms_of_day >= threshold
    }

    pub fn ensure_open(&mut self, date: u32, minute: u16) {
        if self.open.is_none() {
            self.open = Some((date, minute));
        }
    }

    pub fn push(&mut self, code: &str, sec: u32, price: u64, quantity: i64) {
        let trades = match self.stocks.get_mut(code) {
            Some(trades) => trades,
            None => self.stocks.entry(code.to_owned()).or_default(),
        };
        if trades.len() >= MAX_TRADES_PER_MINUTE {
            trades.pop_front();
        }
        trades.push_back((sec, price, quantity));
    }

    pub fn close_open(&mut self) -> Option<(u32, Vec<(String, TradeMinuteLine)>)> {
        let (date, minute) = self.open.take()?;
        self.closed_through = Some(self.closed_through.map_or((date, minute), |closed| closed.max((date, minute))));
        Some((date, self.build_lines(minute)))
    }

    pub fn flush_for_finish(&mut self) -> Option<(u32, Vec<(String, TradeMinuteLine)>)> {
        if let Some(batch) = self.close_open() {
            return Some(batch);
        }
        if self.stocks.is_empty() {
            return None;
        }
        let (date, minute) = self.closed_through?;
        Some((date, self.build_lines(minute)))
    }

    pub fn clear_written(&mut self) {
        self.stocks.clear();
    }

    fn build_lines(&self, minute: u16) -> Vec<(String, TradeMinuteLine)> {
        self.stocks
            .iter()
            .filter(|(_, trades)| !trades.is_empty())
            .map(|(code, trades)| {
                (
                    code.clone(),
                    TradeMinuteLine {
                        minute,
                        trades: trades.iter().copied().collect(),
                    },
                )
            })
            .collect()
    }
}
