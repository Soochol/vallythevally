use std::collections::{BTreeMap, HashMap};

use server::shared_data::{MinuteBar, MinuteInstrument, MinuteTrade, MinuteVenue};

use super::read::{Exchange, RawTick};

pub const RETAIN_MINUTES: u16 = 5;

type Slot = Option<MinuteVenue>;

struct Entry {
    bar: MinuteBar,
    dirty: bool,
}

struct SymbolBars {
    cumulative_value: Option<i64>,
    bars: BTreeMap<(u16, Slot), Entry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    Counted,
    TooLate,
}

pub struct Day {
    date: u32,
    newest_minute: u16,
    symbols: HashMap<String, SymbolBars>,
}

impl Day {
    pub fn new(date: u32) -> Day {
        Day { date, newest_minute: 0, symbols: HashMap::new() }
    }

    pub fn resumed(date: u32, bars: Vec<MinuteBar>) -> Day {
        let mut day = Day::new(date);
        day.newest_minute = bars.iter().map(|bar| bar.minute).max().unwrap_or(0);
        let oldest_kept = day.oldest_kept();
        for bar in bars.into_iter().filter(|bar| bar.minute >= oldest_kept) {
            let symbol = day.symbols.entry(bar.symbol.clone()).or_insert_with(|| SymbolBars { cumulative_value: None, bars: BTreeMap::new() });
            symbol.bars.insert((bar.minute, bar.venue), Entry { bar, dirty: false });
        }
        day
    }

    pub fn date(&self) -> u32 {
        self.date
    }

    fn oldest_kept(&self) -> u16 {
        self.newest_minute.saturating_sub(RETAIN_MINUTES)
    }

    pub fn apply(&mut self, tick: &RawTick<'_>) -> Applied {
        let minute = (tick.sec / 60) as u16;
        if minute < self.oldest_kept() {
            return Applied::TooLate;
        }
        self.newest_minute = self.newest_minute.max(minute);
        if !self.symbols.contains_key(tick.symbol) {
            self.symbols.insert(tick.symbol.to_owned(), SymbolBars { cumulative_value: None, bars: BTreeMap::new() });
        }
        let symbol = self.symbols.get_mut(tick.symbol).expect("방금 넣었다");
        let value = match tick.instrument {
            MinuteInstrument::Stock => tick.price.round() as i64 * tick.volume,
            MinuteInstrument::Index => symbol.value_since_last(tick.cumulative_value),
        };
        let trade = MinuteTrade { price: tick.price, volume: tick.volume, value, sec: tick.sec };
        let slots: &[Slot] = match (tick.instrument, tick.exchange) {
            (MinuteInstrument::Index, _) => &[None],
            (MinuteInstrument::Stock, Exchange::Krx) => &[Some(MinuteVenue::Krx), Some(MinuteVenue::Combined)],
            (MinuteInstrument::Stock, Exchange::Nxt) => &[Some(MinuteVenue::Nxt), Some(MinuteVenue::Combined)],
            (MinuteInstrument::Stock, Exchange::Unstated) => &[Some(MinuteVenue::Combined)],
        };
        for venue in slots {
            match symbol.bars.get_mut(&(minute, *venue)) {
                Some(entry) => {
                    entry.bar.absorb(trade);
                    entry.dirty = true;
                }
                None => {
                    let bar = MinuteBar::started_by(tick.symbol, tick.instrument, *venue, minute, trade);
                    symbol.bars.insert((minute, *venue), Entry { bar, dirty: true });
                }
            }
        }
        Applied::Counted
    }

    pub fn dirty_bars(&self) -> Vec<MinuteBar> {
        let mut dirty: Vec<MinuteBar> = self.symbols.values().flat_map(|symbol| symbol.bars.values()).filter(|entry| entry.dirty).map(|entry| entry.bar.clone()).collect();
        dirty.sort_by(|a, b| (a.minute, &a.symbol, a.venue).cmp(&(b.minute, &b.symbol, b.venue)));
        dirty
    }

    pub fn settle(&mut self) {
        let oldest_kept = self.oldest_kept();
        for symbol in self.symbols.values_mut() {
            for entry in symbol.bars.values_mut() {
                entry.dirty = false;
            }
            symbol.bars = symbol.bars.split_off(&(oldest_kept, None));
        }
        self.symbols.retain(|_, symbol| !symbol.bars.is_empty() || symbol.cumulative_value.is_some());
    }
}

impl SymbolBars {
    fn value_since_last(&mut self, cumulative: Option<i64>) -> i64 {
        let Some(now) = cumulative else {
            return 0;
        };
        let since = self.cumulative_value.map_or(0, |last| (now - last).max(0));
        self.cumulative_value = Some(now);
        since
    }
}
