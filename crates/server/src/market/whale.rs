use std::collections::{HashMap, VecDeque};

use domain::{KstTime, StockCode, Symbol};

use crate::api::{ServerMessage, SymbolCode, UnixSeconds, WhaleEvent, WhaleSide, WhaleStockSummary};
use crate::market_source::stream::{RealTick, TradeSide};

pub const WHALE_RECORD_MIN_WON: i64 = 10_000_000;
pub const WHALE_MAX_EVENTS: usize = 2_000;

#[derive(Debug, Default)]
pub struct WhaleBoard {
    next_id: u64,
    events: VecDeque<WhaleEvent>,
    summaries: HashMap<StockCode, WhaleStockSummary>,
}

impl WhaleBoard {
    pub fn on_trade(&mut self, tick: &RealTick, at: KstTime) -> Option<(WhaleEvent, WhaleStockSummary)> {
        let Symbol::Stock(code) = tick.symbol else {
            return None;
        };
        let price_won = i64::try_from(tick.price.centi() / 100).unwrap_or(i64::MAX);
        if price_won <= 0 || tick.qty.0 == 0 {
            return None;
        }
        let qty = i64::try_from(tick.qty.0).unwrap_or(i64::MAX);
        let amount_won = price_won.saturating_mul(qty);
        if amount_won < WHALE_RECORD_MIN_WON {
            return None;
        }
        let side = match tick.side {
            Some(TradeSide::Sell) => WhaleSide::Sell,
            Some(TradeSide::Buy) | None => WhaleSide::Buy,
        };
        self.next_id = self.next_id.wrapping_add(1);
        let symbol = SymbolCode(Symbol::Stock(code).as_wire());
        let price = tick.price.centi() as f64 / 100.0;
        let event = WhaleEvent {
            id: self.next_id,
            at: UnixSeconds(at.unix()),
            symbol: symbol.clone(),
            side,
            price,
            quantity: tick.qty.0,
            amount_won,
        };
        self.events.push_front(event.clone());
        if self.events.len() > WHALE_MAX_EVENTS {
            self.events.pop_back();
        }
        let summary = self.summaries.entry(code).or_insert_with(|| WhaleStockSummary {
            symbol,
            buy_count: 0,
            sell_count: 0,
            buy_won: 0,
            sell_won: 0,
            net_won: 0,
            last_price: price,
            last_at: UnixSeconds(at.unix()),
        });
        match side {
            WhaleSide::Buy => {
                summary.buy_count += 1;
                summary.buy_won = summary.buy_won.saturating_add(amount_won);
            }
            WhaleSide::Sell => {
                summary.sell_count += 1;
                summary.sell_won = summary.sell_won.saturating_add(amount_won);
            }
        }
        summary.net_won = summary.buy_won.saturating_sub(summary.sell_won);
        summary.last_price = price;
        summary.last_at = UnixSeconds(at.unix());
        Some((event, summary.clone()))
    }

    pub fn snapshot(&self, watched_count: u32) -> ServerMessage {
        ServerMessage::WhaleSnapshot {
            events: self.events.iter().cloned().collect(),
            summaries: self.summaries.values().cloned().collect(),
            watched_count,
        }
    }

    pub fn clear(&mut self) {
        self.events.clear();
        self.summaries.clear();
    }
}

#[cfg(test)]
mod tests {
    use domain::{Price, TimeOfDay, Volume};

    use super::*;

    fn sample_tick(code: &str, price_won: u64, qty: u64, side: TradeSide) -> RealTick {
        RealTick {
            symbol: Symbol::Stock(StockCode::parse(code).unwrap()),
            hhmmss: TimeOfDay::hms(10, 0, 0).unwrap(),
            price: Price::from_centi(price_won * 100).unwrap(),
            qty: Volume(qty),
            exchange: None,
            day: None,
            strength_centi: None,
            same_time_ratio_centi: None,
            side: Some(side),
        }
    }

    fn kst(sec: u8) -> KstTime {
        KstTime::from_unix(1_764_205_200 + i64::from(sec))
    }

    #[test]
    fn ignores_trades_below_record_threshold() {
        let mut board = WhaleBoard::default();
        let small = sample_tick("005930", 70_000, 100, TradeSide::Buy);
        assert!(board.on_trade(&small, kst(1)).is_none());
        let whale = sample_tick("005930", 70_000, 500, TradeSide::Buy);
        let (event, summary) = board.on_trade(&whale, kst(2)).unwrap();
        assert_eq!(event.amount_won, 35_000_000);
        assert_eq!(event.side, WhaleSide::Buy);
        assert_eq!(summary.buy_count, 1);
        assert_eq!(summary.net_won, 35_000_000);
    }

    #[test]
    fn aggregates_buy_and_sell_per_stock_and_resets_on_clear() {
        let mut board = WhaleBoard::default();
        board.on_trade(&sample_tick("005930", 100_000, 1_000, TradeSide::Buy), kst(1)).unwrap();
        let (_, summary) = board.on_trade(&sample_tick("005930", 100_000, 400, TradeSide::Sell), kst(2)).unwrap();
        assert_eq!(summary.buy_count, 1);
        assert_eq!(summary.sell_count, 1);
        assert_eq!(summary.buy_won, 100_000_000);
        assert_eq!(summary.sell_won, 40_000_000);
        assert_eq!(summary.net_won, 60_000_000);

        board.clear();
        let ServerMessage::WhaleSnapshot { events, summaries, watched_count } = board.snapshot(12) else {
            panic!("expected WhaleSnapshot");
        };
        assert!(events.is_empty());
        assert!(summaries.is_empty());
        assert_eq!(watched_count, 12);
    }

    #[test]
    fn caps_ring_buffer_at_max_events() {
        let mut board = WhaleBoard::default();
        let tick = sample_tick("000660", 200_000, 200, TradeSide::Buy);
        for i in 0..(WHALE_MAX_EVENTS + 10) {
            board.on_trade(&tick, kst((i % 60) as u8)).unwrap();
        }
        let ServerMessage::WhaleSnapshot { events, .. } = board.snapshot(1) else {
            panic!("expected WhaleSnapshot");
        };
        assert_eq!(events.len(), WHALE_MAX_EVENTS);
        assert_eq!(events[0].id, (WHALE_MAX_EVENTS + 10) as u64);
    }
}
