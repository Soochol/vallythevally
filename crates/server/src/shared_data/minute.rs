use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::format::{DataKind, FEED_EXTENSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MinuteVenue {
    Krx,
    Nxt,
    Combined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MinuteInstrument {
    Stock,
    Index,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinuteBar {
    pub symbol: String,
    pub instrument: MinuteInstrument,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<MinuteVenue>,
    pub minute: u16,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
    pub value: i64,
    pub trades: u32,
    pub first_sec: u32,
    pub last_sec: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MinuteBarKey {
    pub symbol: String,
    pub instrument: MinuteInstrument,
    pub venue: Option<MinuteVenue>,
    pub minute: u16,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MinuteTrade {
    pub price: f64,
    pub volume: i64,
    pub value: i64,
    pub sec: u32,
}

impl MinuteBar {
    pub fn started_by(symbol: &str, instrument: MinuteInstrument, venue: Option<MinuteVenue>, minute: u16, trade: MinuteTrade) -> MinuteBar {
        MinuteBar {
            symbol: symbol.to_owned(),
            instrument,
            venue,
            minute,
            open: trade.price,
            high: trade.price,
            low: trade.price,
            close: trade.price,
            volume: trade.volume,
            value: trade.value,
            trades: 1,
            first_sec: trade.sec,
            last_sec: trade.sec,
        }
    }

    pub fn key(&self) -> MinuteBarKey {
        MinuteBarKey { symbol: self.symbol.clone(), instrument: self.instrument, venue: self.venue, minute: self.minute }
    }

    pub fn has_key(&self, symbol: &str, instrument: MinuteInstrument, venue: Option<MinuteVenue>, minute: u16) -> bool {
        self.symbol == symbol && self.instrument == instrument && self.venue == venue && self.minute == minute
    }

    pub fn absorb(&mut self, trade: MinuteTrade) {
        self.high = self.high.max(trade.price);
        self.low = self.low.min(trade.price);
        if trade.sec < self.first_sec {
            self.open = trade.price;
            self.first_sec = trade.sec;
        }
        if trade.sec >= self.last_sec {
            self.close = trade.price;
            self.last_sec = trade.sec;
        }
        self.volume += trade.volume;
        self.value += trade.value;
        self.trades += 1;
    }

    pub fn merged_with(&self, later: &MinuteBar) -> Option<MinuteBar> {
        if self.key() != later.key() {
            return None;
        }
        let open_from = if later.first_sec < self.first_sec { later } else { self };
        let close_from = if later.last_sec >= self.last_sec { later } else { self };
        Some(MinuteBar {
            open: open_from.open,
            high: self.high.max(later.high),
            low: self.low.min(later.low),
            close: close_from.close,
            volume: self.volume + later.volume,
            value: self.value + later.value,
            trades: self.trades + later.trades,
            first_sec: self.first_sec.min(later.first_sec),
            last_sec: self.last_sec.max(later.last_sec),
            ..self.clone()
        })
    }
}

pub fn minute_path(dir: &Path, observation_date: &str, key_name: &str) -> PathBuf {
    dir.join(DataKind::Minute.folder()).join(observation_date).join(format!("{key_name}.{FEED_EXTENSION}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(price: f64, volume: i64, sec: u32) -> MinuteTrade {
        MinuteTrade { price, volume, value: price as i64 * volume, sec }
    }

    fn bar(first: MinuteTrade, rest: &[MinuteTrade]) -> MinuteBar {
        let mut bar = MinuteBar::started_by("005930", MinuteInstrument::Stock, Some(MinuteVenue::Krx), 540, first);
        for trade in rest {
            bar.absorb(*trade);
        }
        bar
    }

    #[test]
    fn a_bar_absorbs_trades_by_time_not_arrival() {
        let bar = bar(trade(100.0, 2, 30), &[trade(105.0, 1, 40), trade(98.0, 3, 10), trade(101.0, 4, 40)]);
        assert_eq!((bar.open, bar.high, bar.low, bar.close), (98.0, 105.0, 98.0, 101.0));
        assert_eq!((bar.volume, bar.value, bar.trades, bar.first_sec, bar.last_sec), (10, 200 + 105 + 294 + 404, 4, 10, 40));
    }

    #[test]
    fn merging_two_files_takes_the_open_of_the_earlier_and_the_close_of_the_later() {
        let first_key = bar(trade(100.0, 2, 5), &[trade(110.0, 1, 20)]);
        let second_key = bar(trade(90.0, 4, 30), &[trade(95.0, 1, 50)]);
        for merged in [first_key.merged_with(&second_key).unwrap(), second_key.merged_with(&first_key).unwrap()] {
            assert_eq!((merged.open, merged.high, merged.low, merged.close), (100.0, 110.0, 90.0, 95.0));
            assert_eq!((merged.volume, merged.value, merged.trades, merged.first_sec, merged.last_sec), (8, 200 + 110 + 360 + 95, 4, 5, 50));
        }
    }

    #[test]
    fn bars_of_different_keys_do_not_merge() {
        let stock = bar(trade(100.0, 1, 5), &[]);
        let mut other_minute = stock.clone();
        other_minute.minute += 1;
        let mut other_venue = stock.clone();
        other_venue.venue = Some(MinuteVenue::Nxt);
        assert_eq!(stock.merged_with(&other_minute), None);
        assert_eq!(stock.merged_with(&other_venue), None);
    }

    #[test]
    fn a_line_round_trips_and_leaves_out_the_venue_of_an_index() {
        let index = MinuteBar::started_by("001", MinuteInstrument::Index, None, 541, trade(2650.35, 10, 7));
        let text = serde_json::to_string(&index).unwrap();
        assert!(!text.contains("venue"));
        assert_eq!(serde_json::from_str::<MinuteBar>(&text).unwrap(), index);
    }

    #[test]
    fn the_path_is_a_day_folder_with_one_file_per_key() {
        assert_eq!(minute_path(Path::new("/shared"), "20261123", "collect-01"), Path::new("/shared/minute/20261123/collect-01.jsonl"));
    }
}
