use std::collections::BTreeMap;

use domain::{KstDate, KstTime, Period};

pub const BUCKET_MINUTES: u32 = 5;
const BUCKET_SECS: i64 = BUCKET_MINUTES as i64 * 60;
const RATE_DECIMALS: f64 = 10_000.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolDay {
    prev_close_centi: u64,
    closes: BTreeMap<i64, u64>,
}

impl SymbolDay {
    pub fn from_minute_closes(today: KstDate, bars: impl IntoIterator<Item = (KstTime, u64)>) -> Option<SymbolDay> {
        let mut prev_close_centi = None;
        let mut closes = BTreeMap::new();
        for (start, close) in bars {
            let date = start.kst_date();
            if date < today {
                prev_close_centi = Some(close);
            } else if date == today {
                closes.insert(Period::M5.bucket(start).start().unix(), close);
            }
        }
        prev_close_centi.filter(|prev| *prev > 0).map(|prev_close_centi| SymbolDay { prev_close_centi, closes })
    }

    fn first_cell(&self) -> Option<i64> {
        self.closes.keys().next().copied()
    }

    fn last_cell(&self) -> Option<i64> {
        self.closes.keys().next_back().copied()
    }

    fn rate_at(&self, cell: i64) -> f64 {
        let price = self.closes.range(..=cell).next_back().map_or(self.prev_close_centi, |(_, close)| *close);
        (price as f64 / self.prev_close_centi as f64 - 1.0) * 100.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    pub t: i64,
    pub rate: f64,
}

pub fn group_cells<'a>(days: impl IntoIterator<Item = &'a SymbolDay> + Clone) -> Vec<Cell> {
    let first = days.clone().into_iter().filter_map(SymbolDay::first_cell).min();
    let last = days.clone().into_iter().filter_map(SymbolDay::last_cell).max();
    let (Some(first), Some(last)) = (first, last) else {
        return Vec::new();
    };
    let count = days.clone().into_iter().count() as f64;
    (0..=(last - first) / BUCKET_SECS)
        .map(|i| {
            let t = first + i * BUCKET_SECS;
            let mean = days.clone().into_iter().map(|day| day.rate_at(t)).sum::<f64>() / count;
            Cell { t, rate: (mean * RATE_DECIMALS).round() / RATE_DECIMALS }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::kst;

    fn day(d: u8) -> KstDate {
        KstDate::new(2026, 11, d).unwrap()
    }

    fn bar(d: u8, h: u32, m: u32, close: u64) -> (KstTime, u64) {
        (kst(day(d), h, m, 0), close)
    }

    fn symbol(bars: &[(KstTime, u64)]) -> SymbolDay {
        SymbolDay::from_minute_closes(day(19), bars.iter().copied()).unwrap()
    }

    #[test]
    fn the_last_minute_of_each_five_minute_cell_gives_the_rate_against_the_previous_close() {
        let a = symbol(&[bar(18, 15, 30, 10_000), bar(19, 9, 0, 10_100), bar(19, 9, 4, 10_200), bar(19, 9, 5, 10_500)]);
        let cells = group_cells([&a]);
        let t0 = kst(day(19), 9, 0, 0).unix();
        assert_eq!(cells, vec![Cell { t: t0, rate: 2.0 }, Cell { t: t0 + 300, rate: 5.0 }]);
    }

    #[test]
    fn a_cell_averages_the_rates_of_the_symbols() {
        let a = symbol(&[bar(18, 15, 30, 10_000), bar(19, 9, 4, 10_400)]);
        let b = symbol(&[bar(18, 15, 30, 20_000), bar(19, 9, 4, 19_600)]);
        assert_eq!(group_cells([&a, &b]), vec![Cell { t: kst(day(19), 9, 0, 0).unix(), rate: 1.0 }]);
    }

    #[test]
    fn a_cell_without_trades_keeps_the_last_price_and_a_symbol_before_its_first_trade_is_flat() {
        let early = symbol(&[bar(18, 15, 30, 10_000), bar(19, 9, 0, 11_000), bar(19, 9, 10, 11_000)]);
        let late = symbol(&[bar(18, 15, 30, 20_000), bar(19, 9, 10, 21_000)]);
        let t0 = kst(day(19), 9, 0, 0).unix();
        let rates: Vec<f64> = group_cells([&early, &late]).iter().map(|c| c.rate).collect();
        assert_eq!(rates, vec![5.0, 5.0, 7.5]);
        assert_eq!(group_cells([&early, &late])[2].t, t0 + 600);
    }

    #[test]
    fn a_symbol_without_a_previous_day_bar_has_no_base() {
        assert_eq!(SymbolDay::from_minute_closes(day(19), [bar(19, 9, 0, 10_000)]), None);
    }

    #[test]
    fn no_trades_today_gives_no_cells() {
        let a = symbol(&[bar(18, 15, 30, 10_000)]);
        assert_eq!(group_cells([&a]), Vec::<Cell>::new());
    }
}
