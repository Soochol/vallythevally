use std::fmt;

use crate::spec::{LineId, Spec};
use crate::state::State;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColumnsError {
    LengthMismatch { t: usize, other: usize },
    NotAscending { index: usize },
}

impl fmt::Display for ColumnsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ColumnsError::LengthMismatch { t, other } => write!(f, "봉 열의 길이가 다릅니다: 시각 {t}개, 다른 열 {other}개"),
            ColumnsError::NotAscending { index } => write!(f, "봉 시각이 오름차순이 아닙니다: {index}번째"),
        }
    }
}

impl std::error::Error for ColumnsError {}

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
    ) -> Result<Self, ColumnsError> {
        for other in [open, high, low, close, volume] {
            if other.len() != t.len() {
                return Err(ColumnsError::LengthMismatch { t: t.len(), other: other.len() });
            }
        }
        if let Some(index) = t.windows(2).position(|w| w[0] >= w[1]) {
            return Err(ColumnsError::NotAscending { index: index + 1 });
        }
        Ok(Columns { open, high, low, close, volume, t })
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
