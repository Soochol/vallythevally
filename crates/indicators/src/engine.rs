use std::fmt;

use crate::spec::{LineId, Spec};
use crate::state::State;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BarError {
    LengthMismatch { t: usize, other: usize },
    NotAscending { index: usize },
    NotFinite { index: usize, field: &'static str },
}

impl fmt::Display for BarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BarError::LengthMismatch { t, other } => write!(f, "봉 열의 길이가 다릅니다: 시각 {t}개, 다른 열 {other}개"),
            BarError::NotAscending { index } => write!(f, "봉 시각이 오름차순이 아닙니다: {index}번째"),
            BarError::NotFinite { index, field } => write!(f, "봉 {field} 값이 유한한 수가 아닙니다: {index}번째"),
        }
    }
}

impl std::error::Error for BarError {}

fn check_bar(index: usize, prev_t: Option<i64>, bar: &BarInput) -> Result<(), BarError> {
    if prev_t.is_some_and(|prev| bar.t <= prev) {
        return Err(BarError::NotAscending { index });
    }
    let fields = [("open", bar.open), ("high", bar.high), ("low", bar.low), ("close", bar.close), ("volume", bar.volume)];
    match fields.into_iter().find(|(_, v)| !v.is_finite()) {
        Some((field, _)) => Err(BarError::NotFinite { index, field }),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Columns<'a> {
    open: &'a [f64],
    high: &'a [f64],
    low: &'a [f64],
    close: &'a [f64],
    volume: &'a [f64],
    t: &'a [i64],
}

impl<'a> Columns<'a> {
    pub fn new(
        t: &'a [i64],
        open: &'a [f64],
        high: &'a [f64],
        low: &'a [f64],
        close: &'a [f64],
        volume: &'a [f64],
    ) -> Result<Self, BarError> {
        for other in [open, high, low, close, volume] {
            if other.len() != t.len() {
                return Err(BarError::LengthMismatch { t: t.len(), other: other.len() });
            }
        }
        let columns = Columns { open, high, low, close, volume, t };
        for i in 0..columns.len() {
            check_bar(i, i.checked_sub(1).map(|prev| t[prev]), &columns.bar(i))?;
        }
        Ok(columns)
    }

    pub fn len(&self) -> usize {
        self.t.len()
    }

    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }

    pub fn bar(&self, i: usize) -> BarInput {
        BarInput {
            t: self.t[i],
            open: self.open[i],
            high: self.high[i],
            low: self.low[i],
            close: self.close[i],
            volume: self.volume[i],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BarInput {
    pub t: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone)]
pub struct Line {
    pub id: LineId,
    pub shift: i32,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct Output {
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone)]
pub struct Tail {
    pub values: Vec<(LineId, f64)>,
}

#[derive(Debug, Clone)]
pub struct Engine {
    state: State,
    output: Output,
}

impl Engine {
    pub fn new(spec: &Spec, confirmed: &Columns) -> Self {
        let lines = spec
            .lines()
            .into_iter()
            .map(|id| Line {
                id,
                shift: spec.shift_of(id).unwrap_or(0),
                values: Vec::with_capacity(confirmed.len()),
            })
            .collect();
        let mut engine = Engine { state: State::new(spec), output: Output { lines } };
        for i in 0..confirmed.len() {
            engine.push_confirmed(&confirmed.bar(i));
        }
        engine
    }

    pub fn push_confirmed(&mut self, bar: &BarInput) -> Tail {
        let values = self.state.step(bar);
        for (line, v) in self.output.lines.iter_mut().zip(values) {
            line.values.push(v);
        }
        self.tail(&values)
    }

    pub fn preview(&self, current: &BarInput) -> Tail {
        self.tail(&self.state.clone().step(current))
    }

    pub fn output(&self) -> &Output {
        &self.output
    }

    fn tail(&self, values: &[f64]) -> Tail {
        Tail { values: self.output.lines.iter().zip(values).map(|(line, v)| (line.id, *v)).collect() }
    }
}

pub fn compute(spec: &Spec, bars: &Columns) -> Output {
    Engine::new(spec, bars).output
}
