use std::collections::BTreeMap;

use domain::{KstDate, KstTime, Period};

pub const BUCKET_MINUTES: u32 = 5;
const BUCKET_SECS: i64 = BUCKET_MINUTES as i64 * 60;
const RATE_DECIMALS: f64 = 10_000.0;
const CENTI_PER_WON: u128 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MinuteBar {
    pub start: KstTime,
    pub close_centi: u64,
    pub volume: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Weighting {
    TradedValue,
    Excluded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolDay {
    prev_close_centi: u64,
    closes: BTreeMap<i64, u64>,
    traded_through: BTreeMap<i64, u128>,
    weighting: Weighting,
    as_of: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectedCell {
    pub start: i64,
    pub close_centi: u64,
    pub traded_won: u64,
}

impl SymbolDay {
    pub fn from_minute_bars(today: KstDate, weighting: Weighting, bars: impl IntoIterator<Item = MinuteBar>) -> Option<SymbolDay> {
        let mut prev_close_centi = None;
        let mut closes = BTreeMap::new();
        let mut traded_in = BTreeMap::<i64, u128>::new();
        let mut as_of = None;
        for bar in bars {
            let date = bar.start.kst_date();
            if date < today {
                prev_close_centi = Some(bar.close_centi);
            } else if date == today {
                let cell = Period::M5.bucket(bar.start).start().unix();
                closes.insert(cell, bar.close_centi);
                *traded_in.entry(cell).or_default() += u128::from(bar.close_centi) * u128::from(bar.volume);
                as_of = as_of.max(Some(bar.start.unix()));
            }
        }
        SymbolDay::assembled(prev_close_centi?, weighting, closes, traded_in, as_of)
    }

    pub fn from_collected_cells(prev_close_centi: u64, weighting: Weighting, as_of: Option<i64>, cells: impl IntoIterator<Item = CollectedCell>) -> Option<SymbolDay> {
        let mut closes = BTreeMap::new();
        let mut traded_in = BTreeMap::<i64, u128>::new();
        for cell in cells {
            closes.insert(cell.start, cell.close_centi);
            *traded_in.entry(cell.start).or_default() += u128::from(cell.traded_won) * CENTI_PER_WON;
        }
        SymbolDay::assembled(prev_close_centi, weighting, closes, traded_in, as_of)
    }

    fn assembled(prev_close_centi: u64, weighting: Weighting, closes: BTreeMap<i64, u64>, traded_in: BTreeMap<i64, u128>, as_of: Option<i64>) -> Option<SymbolDay> {
        let traded_through = traded_in
            .into_iter()
            .scan(0u128, |running, (cell, traded)| {
                *running += traded;
                Some((cell, *running))
            })
            .collect();
        (prev_close_centi > 0).then_some(SymbolDay { prev_close_centi, closes, traded_through, weighting, as_of })
    }

    pub fn as_of(&self) -> Option<i64> {
        self.as_of
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

    fn weight_at(&self, cell: i64) -> f64 {
        match self.weighting {
            Weighting::Excluded => 0.0,
            Weighting::TradedValue => self.traded_through.range(..=cell).next_back().map_or(0.0, |(_, traded)| *traded as f64),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    pub t: i64,
    pub rate: f64,
}

fn traded_weighted_rate<'a>(days: impl IntoIterator<Item = &'a SymbolDay>, cell: i64) -> f64 {
    let rated: Vec<(f64, f64)> = days.into_iter().map(|day| (day.rate_at(cell), day.weight_at(cell))).collect();
    let total_weight: f64 = rated.iter().map(|(_, weight)| weight).sum();
    if total_weight > 0.0 {
        rated.iter().map(|(rate, weight)| rate * weight).sum::<f64>() / total_weight
    } else {
        rated.iter().map(|(rate, _)| rate).sum::<f64>() / rated.len() as f64
    }
}

pub fn group_cells<'a>(days: impl IntoIterator<Item = &'a SymbolDay> + Clone) -> Vec<Cell> {
    let first = days.clone().into_iter().filter_map(SymbolDay::first_cell).min();
    let last = days.clone().into_iter().filter_map(SymbolDay::last_cell).max();
    let (Some(first), Some(last)) = (first, last) else {
        return Vec::new();
    };
    (0..=(last - first) / BUCKET_SECS)
        .map(|i| {
            let t = first + i * BUCKET_SECS;
            let rate = traded_weighted_rate(days.clone(), t);
            Cell { t, rate: (rate * RATE_DECIMALS).round() / RATE_DECIMALS }
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

    fn bar(d: u8, h: u32, m: u32, close: u64, volume: u64) -> MinuteBar {
        MinuteBar { start: kst(day(d), h, m, 0), close_centi: close, volume }
    }

    fn stock(bars: &[MinuteBar]) -> SymbolDay {
        SymbolDay::from_minute_bars(day(19), Weighting::TradedValue, bars.iter().copied()).unwrap()
    }

    fn index(bars: &[MinuteBar]) -> SymbolDay {
        SymbolDay::from_minute_bars(day(19), Weighting::Excluded, bars.iter().copied()).unwrap()
    }

    fn rates(cells: &[Cell]) -> Vec<f64> {
        cells.iter().map(|c| c.rate).collect()
    }

    #[test]
    fn the_last_minute_of_each_five_minute_cell_gives_the_rate_against_the_previous_close() {
        let a = stock(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 0, 10_100, 1), bar(19, 9, 4, 10_200, 1), bar(19, 9, 5, 10_500, 1)]);
        let cells = group_cells([&a]);
        let t0 = kst(day(19), 9, 0, 0).unix();
        assert_eq!(cells, vec![Cell { t: t0, rate: 2.0 }, Cell { t: t0 + 300, rate: 5.0 }]);
    }

    #[test]
    fn a_cell_weights_each_rate_by_the_traded_value_so_far() {
        let big = stock(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 4, 10_100, 900)]);
        let small = stock(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 4, 10_900, 10)]);
        let expected = (1.0 * 10_100.0 * 900.0 + 9.0 * 10_900.0 * 10.0) / (10_100.0 * 900.0 + 10_900.0 * 10.0);
        assert_eq!(rates(&group_cells([&big, &small])), vec![(expected * RATE_DECIMALS).round() / RATE_DECIMALS]);
    }

    #[test]
    fn the_weight_accumulates_over_the_day_up_to_the_end_of_the_cell() {
        let early = stock(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 0, 11_000, 10), bar(19, 9, 5, 11_000, 0)]);
        let late = stock(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 5, 9_000, 10), bar(19, 9, 6, 9_000, 10)]);
        let second = (10.0 * 110_000.0 - 10.0 * 180_000.0) / (110_000.0 + 180_000.0);
        assert_eq!(rates(&group_cells([&early, &late])), vec![10.0, (second * RATE_DECIMALS).round() / RATE_DECIMALS]);
    }

    #[test]
    fn a_cell_without_trades_keeps_the_last_price_and_a_symbol_before_its_first_trade_is_flat_and_weightless() {
        let early = stock(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 0, 11_000, 10), bar(19, 9, 10, 11_000, 0)]);
        let late = stock(&[bar(18, 15, 30, 20_000, 1), bar(19, 9, 10, 21_000, 10)]);
        let t0 = kst(day(19), 9, 0, 0).unix();
        let cells = group_cells([&early, &late]);
        let third = (10.0 * 110_000.0 + 5.0 * 210_000.0) / (110_000.0 + 210_000.0);
        assert_eq!(rates(&cells), vec![10.0, 10.0, (third * RATE_DECIMALS).round() / RATE_DECIMALS]);
        assert_eq!(cells[2].t, t0 + 600);
    }

    #[test]
    fn a_cell_with_no_traded_value_at_all_takes_the_plain_mean() {
        let a = index(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 4, 10_400, 5)]);
        let b = index(&[bar(18, 15, 30, 20_000, 1), bar(19, 9, 4, 19_600, 5)]);
        assert_eq!(rates(&group_cells([&a, &b])), vec![1.0]);
    }

    #[test]
    fn an_index_beside_stocks_carries_no_weight() {
        let kospi = index(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 4, 9_000, 1_000_000)]);
        let a = stock(&[bar(18, 15, 30, 10_000, 1), bar(19, 9, 4, 10_300, 10)]);
        assert_eq!(rates(&group_cells([&kospi, &a])), vec![3.0]);
    }

    #[test]
    fn a_symbol_without_a_previous_day_bar_has_no_base() {
        assert_eq!(SymbolDay::from_minute_bars(day(19), Weighting::TradedValue, [bar(19, 9, 0, 10_000, 1)]), None);
    }

    #[test]
    fn no_trades_today_gives_no_cells() {
        let a = stock(&[bar(18, 15, 30, 10_000, 1)]);
        assert_eq!(group_cells([&a]), Vec::<Cell>::new());
    }
}
