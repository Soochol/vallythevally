use std::collections::VecDeque;

use super::exact::{Decimal, Exact};
use crate::api::{BarField, Extreme, ScreenPeriod};

pub(super) type Cell = i64;

const CENTI_EXPONENT: i32 = -2;
const MILLION_EXPONENT: i32 = 6;

#[derive(Debug, Clone, Copy)]
pub(super) enum Kind {
    NewExtreme { extreme: Extreme, field: BarField, n: u32 },
    ValueRange { field: BarField, min: Option<Decimal>, max: Option<Decimal> },
    Change { back: u32, min_pct: Option<Decimal>, max_pct: Option<Decimal> },
    NearExtreme { extreme: Extreme, n: u32, within_pct: Decimal },
    Surge { field: BarField, n: u32, times: Decimal },
}

impl Kind {
    fn needed_bars(self) -> i64 {
        match self {
            Kind::NewExtreme { n, .. } | Kind::NearExtreme { n, .. } => i64::from(n),
            Kind::ValueRange { .. } => 1,
            Kind::Change { back, .. } => i64::from(back) + 1,
            Kind::Surge { n, .. } => i64::from(n) + 1,
        }
    }

    fn looks_back_along_bars(self) -> bool {
        matches!(self, Kind::Change { .. } | Kind::Surge { .. })
    }

    pub(super) fn columns(self) -> Vec<BarField> {
        match self {
            Kind::NewExtreme { field, .. } | Kind::ValueRange { field, .. } | Kind::Surge { field, .. } => vec![field],
            Kind::Change { .. } => vec![BarField::Close],
            Kind::NearExtreme { extreme, .. } => vec![extreme_field(extreme), BarField::Close],
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Line {
    pub(super) period: ScreenPeriod,
    pub(super) m: u32,
    pub(super) kind: Kind,
}

impl Line {
    pub(super) fn needed_bars(&self) -> i64 {
        self.kind.needed_bars()
    }

    fn first_recent_cell(&self, as_of: Cell) -> Cell {
        as_of - (i64::from(self.m) - 1)
    }

    pub(super) fn first_needed_cell(&self, as_of: Cell) -> Cell {
        self.first_recent_cell(as_of) - (self.needed_bars() - 1)
    }

    pub(super) fn first_loaded_cell(&self, as_of: Cell) -> Cell {
        if self.kind.looks_back_along_bars() { 0 } else { self.first_needed_cell(as_of).max(0) }
    }

    pub(super) fn last_candidate(&self, series: &Series, start: Option<Cell>, as_of: Cell) -> Option<Cell> {
        let cells = &series.cells;
        let recent = cells.partition_point(|&c| c < self.first_recent_cell(as_of));
        let full_window = |i: usize, n: u32| start.is_none_or(|s| cells[i] - s + 1 >= i64::from(n));
        let last = match self.kind {
            Kind::NewExtreme { extreme, field, n } => {
                let values = series.column(field);
                let best = window_extremes(cells, values, n, recent, extreme);
                (recent..cells.len()).zip(best).filter(|&(i, best)| values[i] == best && full_window(i, n)).map(|(i, _)| i).next_back()
            }
            Kind::ValueRange { field, min, max } => {
                let values = series.column(field);
                (recent..cells.len()).rev().find(|&i| within(Exact::new(false, values[i], stored_exponent(field)), min, max, 1))
            }
            Kind::Change { back, min_pct, max_pct } => {
                let close = series.column(BarField::Close);
                let back = back as usize;
                (recent.max(back)..cells.len()).rev().find(|&i| {
                    let (from, to) = (close[i - back], close[i]);
                    within(Exact::new(to < from, to.abs_diff(from) * 100, 0), min_pct, max_pct, from)
                })
            }
            Kind::NearExtreme { extreme, n, within_pct } => {
                let close = series.column(BarField::Close);
                let best = window_extremes(cells, series.column(extreme_field(extreme)), n, recent, extreme);
                (recent..cells.len()).zip(best).filter(|&(i, best)| near(extreme, close[i], best, within_pct) && full_window(i, n)).map(|(i, _)| i).next_back()
            }
            Kind::Surge { field, n, times } => last_surge(series.column(field), n as usize, recent, times),
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

fn window_extremes(cells: &[Cell], values: &[u128], n: u32, recent: usize, extreme: Extreme) -> Vec<u128> {
    let Some(&first_recent) = cells.get(recent) else {
        return Vec::new();
    };
    let span = i64::from(n);
    let outlasts = |older: u128, newer: u128| match extreme {
        Extreme::High => older > newer,
        Extreme::Low => older < newer,
    };
    let mut window: VecDeque<usize> = VecDeque::new();
    let mut best = Vec::with_capacity(cells.len() - recent);
    for i in cells.partition_point(|&c| c <= first_recent - span)..cells.len() {
        while window.back().is_some_and(|&j| !outlasts(values[j], values[i])) {
            window.pop_back();
        }
        window.push_back(i);
        while window.front().is_some_and(|&j| cells[j] <= cells[i] - span) {
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
