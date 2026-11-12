use std::collections::VecDeque;

use super::exact::{Decimal, Exact};
use super::indicator::Indicator;
use crate::api::{BarField, BarRange, Extreme, ScreenPeriod};

pub(super) type Cell = i64;

const CENTI_EXPONENT: i32 = -2;
const MILLION_EXPONENT: i32 = 6;

#[derive(Debug, Clone)]
pub(super) enum Kind {
    NewExtreme { extreme: Extreme, field: BarField, n: u32 },
    ValueRange { field: BarField, min: Option<Decimal>, max: Option<Decimal> },
    Change { back: u32, min_pct: Option<Decimal>, max_pct: Option<Decimal> },
    NearExtreme { extreme: Extreme, n: u32, within_pct: Decimal },
    Surge { field: BarField, n: u32, times: Decimal },
    Indicator(Indicator),
}

impl Kind {
    fn needed_bars(&self) -> i64 {
        match *self {
            Kind::NewExtreme { n, .. } | Kind::NearExtreme { n, .. } => i64::from(n),
            Kind::ValueRange { .. } => 1,
            Kind::Change { back, .. } => i64::from(back) + 1,
            Kind::Surge { n, .. } => i64::from(n) + 1,
            Kind::Indicator(ref indicator) => indicator.needed_bars(),
        }
    }

    pub(super) fn columns(&self) -> Vec<BarField> {
        match *self {
            Kind::NewExtreme { field, .. } | Kind::ValueRange { field, .. } | Kind::Surge { field, .. } => vec![field],
            Kind::Change { .. } => vec![BarField::Close],
            Kind::NearExtreme { extreme, .. } => vec![extreme_field(extreme), BarField::Close],
            Kind::Indicator(ref indicator) => indicator.columns(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct Line {
    pub(super) period: ScreenPeriod,
    pub(super) bar_range: BarRange,
    pub(super) kind: Kind,
}

impl Line {
    pub(super) fn needed_bars(&self) -> i64 {
        self.kind.needed_bars()
    }

    pub(super) fn last_candidate(&self, series: &Series) -> Option<Cell> {
        let end = series.len().checked_sub(self.bar_range.start as usize)?;
        let recent = series.len().saturating_sub(self.bar_range.end as usize + 1);
        let cells = &series.cells[..end];
        let full_window = |i: usize, n: u32| i + 1 >= n as usize;
        let last = match self.kind {
            Kind::NewExtreme { extreme, field, n } => {
                let values = &series.column(field)[..end];
                let best = window_extremes(values, n as usize, recent, extreme);
                (recent..cells.len()).zip(best).filter(|&(i, best)| values[i] == best && full_window(i, n)).map(|(i, _)| i).next_back()
            }
            Kind::ValueRange { field, min, max } => {
                let values = &series.column(field)[..end];
                (recent..cells.len()).rev().find(|&i| within(Exact::new(false, values[i], stored_exponent(field)), min, max, 1))
            }
            Kind::Change { back, min_pct, max_pct } => {
                let close = &series.column(BarField::Close)[..end];
                let back = back as usize;
                (recent.max(back)..cells.len()).rev().find(|&i| {
                    let (from, to) = (close[i - back], close[i]);
                    within(Exact::new(to < from, to.abs_diff(from) * 100, 0), min_pct, max_pct, from)
                })
            }
            Kind::NearExtreme { extreme, n, within_pct } => {
                let close = &series.column(BarField::Close)[..end];
                let best = window_extremes(&series.column(extreme_field(extreme))[..end], n as usize, recent, extreme);
                (recent..cells.len()).zip(best).filter(|&(i, best)| near(extreme, close[i], best, within_pct) && full_window(i, n)).map(|(i, _)| i).next_back()
            }
            Kind::Surge { field, n, times } => last_surge(&series.column(field)[..end], n as usize, recent, times),
            Kind::Indicator(ref indicator) => indicator.last_candidate(series, recent, end),
        };
        last.map(|i| cells[i])
    }
}

#[derive(Debug, Default)]
pub(super) struct Series {
    cells: Vec<Cell>,
    columns: [Vec<u128>; 6],
}

impl Series {
    pub(super) fn clear(&mut self) {
        self.cells.clear();
        self.columns.iter_mut().for_each(Vec::clear);
    }

    pub(super) fn len(&self) -> usize {
        self.cells.len()
    }

    pub(super) fn cells_from(&self, from: usize) -> &[Cell] {
        &self.cells[from..]
    }

    pub(super) fn natural_at(&self, field: BarField, bar: usize) -> f64 {
        natural_value(field, self.column(field)[bar])
    }

    pub(super) fn natural_range(&self, field: BarField, from: usize, end: usize) -> Vec<f64> {
        self.column(field)[from..end].iter().map(|&stored| natural_value(field, stored)).collect()
    }

    pub(super) fn push_cells(&mut self, cells: &[Cell]) {
        self.cells.extend_from_slice(cells);
    }

    pub(super) fn column_mut(&mut self, field: BarField) -> &mut Vec<u128> {
        &mut self.columns[field as usize]
    }

    fn column(&self, field: BarField) -> &[u128] {
        &self.columns[field as usize]
    }
}

fn extreme_field(extreme: Extreme) -> BarField {
    match extreme {
        Extreme::High => BarField::High,
        Extreme::Low => BarField::Low,
    }
}

fn window_extremes(values: &[u128], n: usize, recent: usize, extreme: Extreme) -> Vec<u128> {
    if recent >= values.len() {
        return Vec::new();
    }
    let outlasts = |older: u128, newer: u128| match extreme {
        Extreme::High => older > newer,
        Extreme::Low => older < newer,
    };
    let mut window: VecDeque<usize> = VecDeque::new();
    let mut best = Vec::with_capacity(values.len() - recent);
    for i in recent.saturating_sub(n - 1)..values.len() {
        while window.back().is_some_and(|&j| !outlasts(values[j], values[i])) {
            window.pop_back();
        }
        window.push_back(i);
        while window.front().is_some_and(|&j| i - j >= n) {
            window.pop_front();
        }
        if i >= recent {
            best.push(values[window[0]]);
        }
    }
    best
}

fn last_surge(values: &[u128], n: usize, recent: usize, times: Decimal) -> Option<usize> {
    let first = recent.max(n);
    if first >= values.len() {
        return None;
    }
    let mut before: u128 = values[first - n..first].iter().sum();
    let mut last = None;
    for i in first..values.len() {
        if i > first {
            before = before + values[i - 1] - values[i - 1 - n];
        }
        if values[i] > 0 && Exact::new(false, values[i] * n as u128, 0) >= times.times(before) {
            last = Some(i);
        }
    }
    last
}

fn natural_value(field: BarField, stored: u128) -> f64 {
    match field {
        BarField::Open | BarField::High | BarField::Low | BarField::Close => stored as f64 / 100.0,
        BarField::Volume => stored as f64,
        BarField::TradedValue => stored as f64 * 1e6,
    }
}

fn stored_exponent(field: BarField) -> i32 {
    match field {
        BarField::Open | BarField::High | BarField::Low | BarField::Close => CENTI_EXPONENT,
        BarField::Volume => 0,
        BarField::TradedValue => MILLION_EXPONENT,
    }
}

fn near(extreme: Extreme, close: u128, extreme_value: u128, within_pct: Decimal) -> bool {
    let gap = match extreme {
        Extreme::High => extreme_value.saturating_sub(close),
        Extreme::Low => close.saturating_sub(extreme_value),
    };
    Exact::new(false, gap * 100, 0) <= within_pct.times(extreme_value)
}

fn within(value: Exact, min: Option<Decimal>, max: Option<Decimal>, per: u128) -> bool {
    min.is_none_or(|lo| value >= lo.times(per)) && max.is_none_or(|hi| value <= hi.times(per))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{PriceField, Side};

    fn series(prices: &[u128]) -> Series {
        let mut series = Series::default();
        series.push_cells(&(0..prices.len() as i64).map(|i| i * 10).collect::<Vec<_>>());
        for field in [BarField::Open, BarField::High, BarField::Low, BarField::Close] {
            series.column_mut(field).extend(prices.iter().map(|p| p * 100));
        }
        series.column_mut(BarField::Volume).extend(prices);
        series
    }

    #[test]
    fn zero_and_one_follow_new_bars_but_same_bar_updates_keep_positions() {
        let line = Line { period: ScreenPeriod::Day, bar_range: BarRange { start: 1, end: 1 }, kind: Kind::ValueRange { field: BarField::Close, min: Decimal::of(9.0), max: Decimal::of(9.0) } };
        let mut prices: Vec<u128> = (1..=10).collect();
        assert_eq!(line.last_candidate(&series(&prices)), Some(80));
        prices[9] = 99;
        assert_eq!(line.last_candidate(&series(&prices)), Some(80));
        prices.push(100);
        assert_eq!(line.last_candidate(&series(&prices)), None);
        let moved = Line { bar_range: BarRange { start: 2, end: 2 }, ..line };
        assert_eq!(moved.last_candidate(&series(&prices)), Some(80));
    }

    #[test]
    fn changing_future_prices_cannot_change_past_extremes_changes_surges_or_indicators() {
        let past = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        let mut changed = past;
        changed[8..].copy_from_slice(&[1_000_000, 1]);
        let kinds = [
            Kind::NewExtreme { extreme: Extreme::High, field: BarField::High, n: 3 },
            Kind::NewExtreme { extreme: Extreme::Low, field: BarField::Low, n: 1 },
            Kind::NearExtreme { extreme: Extreme::High, n: 3, within_pct: Decimal::of(0.0).unwrap() },
            Kind::Change { back: 2, min_pct: Decimal::of(20.0), max_pct: None },
            Kind::Surge { field: BarField::Volume, n: 2, times: Decimal::of(1.1).unwrap() },
            Kind::Indicator(Indicator::ma_position(PriceField::Close, indicators::MaMethod::Sma, 3, Side::Above).unwrap()),
            Kind::Indicator(Indicator::ma_position(PriceField::Close, indicators::MaMethod::Ema, 3, Side::Above).unwrap()),
        ];
        for kind in kinds {
            let line = Line { period: ScreenPeriod::Day, bar_range: BarRange { start: 2, end: 3 }, kind };
            assert_eq!(line.last_candidate(&series(&past)), Some(70), "{line:?}");
            assert_eq!(line.last_candidate(&series(&changed)), Some(70), "{line:?}");
        }
    }
}
