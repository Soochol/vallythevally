use indicators::{Columns, Input, LineId, MaMethod, Memory, Output, Spec, ValidSpec};

use super::line::Series;
use crate::api::{BarField, BollingerBand, BollingerTest, Direction, IchimokuTest, MacdTest, MaOrder, PriceField, RsiTest, Side, StochasticTest};

#[derive(Debug, Clone, Copy)]
enum Operand {
    Price(PriceField),
    Line(usize, LineId),
    Level(f64),
}

#[derive(Debug, Clone, Copy)]
struct Placed {
    value: Operand,
    side: Side,
    of: Operand,
}

#[derive(Debug, Clone)]
enum Test {
    Placed(Vec<Placed>),
    Cross { line: Operand, of: Operand, direction: Direction },
    Within { value: Operand, min: Option<f64>, max: Option<f64> },
}

impl Test {
    fn operands(&self) -> Vec<Operand> {
        match self {
            Test::Placed(placed) => placed.iter().flat_map(|p| [p.value, p.of]).collect(),
            Test::Cross { line, of, .. } => vec![*line, *of],
            Test::Within { value, .. } => vec![*value],
        }
    }

    fn reads_the_bar_before(&self) -> bool {
        matches!(self, Test::Cross { .. })
    }

    fn holds(&self, i: usize, at: impl Fn(Operand, usize) -> f64) -> bool {
        match *self {
            Test::Placed(ref placed) => placed.iter().all(|p| beyond(p.side, at(p.value, i), at(p.of, i))),
            Test::Cross { line, of, direction } => i > 0 && crossed(direction, (at(line, i - 1), at(of, i - 1)), (at(line, i), at(of, i))),
            Test::Within { value, min, max } => {
                let v = at(value, i);
                !v.is_nan() && min.is_none_or(|lo| v >= lo) && max.is_none_or(|hi| v <= hi)
            }
        }
    }
}

fn beyond(side: Side, value: f64, of: f64) -> bool {
    match side {
        Side::Above => value > of,
        Side::Below => value < of,
    }
}

fn crossed(direction: Direction, (line_before, of_before): (f64, f64), (line, of): (f64, f64)) -> bool {
    match direction {
        Direction::Up => line_before <= of_before && line > of,
        Direction::Down => line_before >= of_before && line < of,
    }
}

#[derive(Debug, Clone)]
pub(super) struct Indicator {
    specs: Vec<ValidSpec>,
    test: Test,
}

impl Indicator {
    fn new(specs: Vec<Spec>, test: Test) -> Result<Indicator, &'static str> {
        let specs = specs.into_iter().map(ValidSpec::new).collect::<Result<Vec<_>, _>>().map_err(|_| "지표 설정이 맞지 않습니다")?;
        Ok(Indicator { specs, test })
    }

    pub(super) fn ma_position(field: PriceField, method: MaMethod, length: u16, side: Side) -> Result<Indicator, &'static str> {
        Indicator::new(vec![Spec::Ma { method, period: length }], Test::Placed(vec![Placed { value: Operand::Price(field), side, of: Operand::Line(0, LineId::Ma) }]))
    }

    pub(super) fn ma_alignment(method: MaMethod, lengths: &[u16], order: MaOrder) -> Result<Indicator, &'static str> {
        let side = match order {
            MaOrder::Bullish => Side::Above,
            MaOrder::Bearish => Side::Below,
        };
        let placed = (1..lengths.len()).map(|k| Placed { value: Operand::Line(k - 1, LineId::Ma), side, of: Operand::Line(k, LineId::Ma) }).collect();
        Indicator::new(lengths.iter().map(|&period| Spec::Ma { method, period }).collect(), Test::Placed(placed))
    }

    pub(super) fn ma_cross(method: MaMethod, fast: Option<u16>, slow: u16, direction: Direction) -> Result<Indicator, &'static str> {
        let slow_ma = Spec::Ma { method, period: slow };
        match fast {
            Some(fast) => Indicator::new(vec![Spec::Ma { method, period: fast }, slow_ma], Test::Cross { line: Operand::Line(0, LineId::Ma), of: Operand::Line(1, LineId::Ma), direction }),
            None => Indicator::new(vec![slow_ma], Test::Cross { line: Operand::Price(PriceField::Close), of: Operand::Line(0, LineId::Ma), direction }),
        }
    }

    pub(super) fn rsi(length: u16, test: RsiTest) -> Result<Indicator, &'static str> {
        let rsi = Operand::Line(0, LineId::Rsi);
        let test = match test {
            RsiTest::Range { min, max } => Test::Within { value: rsi, min: min.0, max: max.0 },
            RsiTest::Breakout { value, direction } => Test::Cross { line: rsi, of: Operand::Level(value), direction },
        };
        Indicator::new(vec![Spec::Rsi { period: length, signal: None }], test)
    }

    pub(super) fn macd(fast: u16, slow: u16, signal: u16, test: MacdTest) -> Result<Indicator, &'static str> {
        let (macd, signal_line) = (Operand::Line(0, LineId::Macd), Operand::Line(0, LineId::Signal));
        let test = match test {
            MacdTest::SignalCross { direction } => Test::Cross { line: macd, of: signal_line, direction },
            MacdTest::ZeroBreakout { direction } => Test::Cross { line: macd, of: Operand::Level(0.0), direction },
            MacdTest::VsSignal { side } => Test::Placed(vec![Placed { value: macd, side, of: signal_line }]),
        };
        Indicator::new(vec![Spec::Macd { fast, slow, signal }], test)
    }

    pub(super) fn stochastic(k: u16, d: u16, smooth: u16, test: StochasticTest) -> Result<Indicator, &'static str> {
        let (k_line, d_line) = (Operand::Line(0, LineId::K), Operand::Line(0, LineId::D));
        let test = match test {
            StochasticTest::Cross { direction } => Test::Cross { line: k_line, of: d_line, direction },
            StochasticTest::Range { min, max } => Test::Within { value: k_line, min: min.0, max: max.0 },
        };
        Indicator::new(vec![Spec::StochSlow { k, d, smooth }], test)
    }

    pub(super) fn bollinger(length: u16, k: f64, test: BollingerTest) -> Result<Indicator, &'static str> {
        let close = Operand::Price(PriceField::Close);
        let band_line = |band| match band {
            BollingerBand::Upper => Operand::Line(0, LineId::Upper),
            BollingerBand::Lower => Operand::Line(0, LineId::Lower),
        };
        let test = match test {
            BollingerTest::Outside { side } => {
                let band = match side {
                    Side::Above => BollingerBand::Upper,
                    Side::Below => BollingerBand::Lower,
                };
                Test::Placed(vec![Placed { value: close, side, of: band_line(band) }])
            }
            BollingerTest::Cross { band, direction } => Test::Cross { line: close, of: band_line(band), direction },
        };
        Indicator::new(vec![Spec::Bollinger { period: length, k }], test)
    }

    pub(super) fn ichimoku(conversion: u16, base: u16, span_b: u16, displacement: u16, test: IchimokuTest) -> Result<Indicator, &'static str> {
        let close = Operand::Price(PriceField::Close);
        let test = match test {
            IchimokuTest::Cloud { side } => Test::Placed([LineId::SpanA, LineId::SpanB].map(|span| Placed { value: close, side, of: Operand::Line(0, span) }).to_vec()),
            IchimokuTest::Cross { direction } => Test::Cross { line: Operand::Line(0, LineId::Conversion), of: Operand::Line(0, LineId::Base), direction },
        };
        Indicator::new(vec![Spec::Ichimoku { conversion, base, span_b, displacement }], test)
    }

    fn bars_ahead(&self, operand: Operand) -> usize {
        match operand {
            Operand::Line(k, id) => self.specs[k].shift_of(id).and_then(|shift| usize::try_from(shift).ok()).unwrap_or(0),
            Operand::Price(_) | Operand::Level(_) => 0,
        }
    }

    fn bars_read_before(&self) -> usize {
        let ahead = self.test.operands().into_iter().map(|operand| self.bars_ahead(operand)).max().unwrap_or(0);
        ahead + usize::from(self.test.reads_the_bar_before())
    }

    fn bars_checked_before(&self) -> usize {
        let ahead = self.specs.iter().flat_map(|spec| spec.lines().into_iter().filter_map(|id| spec.shift_of(id))).filter_map(|shift| usize::try_from(shift).ok()).max().unwrap_or(0);
        ahead + usize::from(self.test.reads_the_bar_before())
    }

    pub(super) fn columns(&self) -> Vec<BarField> {
        let read_by_specs = self.specs.iter().flat_map(|spec| spec.inputs().iter().map(|&input| input_field(input)));
        let compared_prices = self.test.operands().into_iter().filter_map(|operand| match operand {
            Operand::Price(field) => Some(price_field(field)),
            Operand::Line(..) | Operand::Level(_) => None,
        });
        let mut columns: Vec<BarField> = read_by_specs.chain(compared_prices).collect();
        columns.sort_by_key(|field| *field as usize);
        columns.dedup();
        columns
    }

    pub(super) fn needed_bars(&self) -> i64 {
        let warmup = self.specs.iter().map(|spec| spec.warmup()).max().unwrap_or(1);
        i64::try_from(warmup + self.bars_read_before()).unwrap_or(i64::MAX)
    }

    pub(super) fn last_candidate(&self, series: &Series, recent: usize) -> Option<usize> {
        if recent >= series.len() {
            return None;
        }
        let first_read = recent.saturating_sub(self.bars_checked_before());
        let computed = self.specs.iter().map(|spec| Computed::of(spec, series, first_read)).collect::<Option<Vec<_>>>()?;
        let at = |operand: Operand, i: usize| match operand {
            Operand::Price(field) => series.natural_at(price_field(field), i),
            Operand::Line(k, id) => computed[k].value(id, i),
            Operand::Level(level) => level,
        };
        let every_line_computed = |i: usize| computed.iter().all(|c| c.every_line_computed_at(i));
        let bar_before_computed = |i: usize| !self.test.reads_the_bar_before() || i.checked_sub(1).is_some_and(every_line_computed);
        (recent..series.len()).rev().find(|&i| every_line_computed(i) && bar_before_computed(i) && self.test.holds(i, at))
    }
}

struct Computed {
    from: usize,
    output: Output,
}

impl Computed {
    fn of(spec: &ValidSpec, series: &Series, first_read: usize) -> Option<Computed> {
        let from = match spec.memory() {
            Memory::LastBars(bars) => first_read.saturating_sub(bars - 1),
            Memory::EveryBar => 0,
        };
        let read: Vec<(Input, Vec<f64>)> = spec.inputs().iter().map(|&input| (input, series.natural_from(input_field(input), from))).collect();
        let unread_filler = &read.first()?.1;
        let slot = |input: Input| read.iter().find(|(read_input, _)| *read_input == input).map_or(unread_filler, |(_, values)| values);
        match Columns::new(series.cells_from(from), slot(Input::Open), slot(Input::High), slot(Input::Low), slot(Input::Close), slot(Input::Volume)) {
            Ok(bars) => Some(Computed { from, output: indicators::compute(spec, &bars) }),
            Err(e) => {
                tracing::warn!(error = %e, "봉 열을 지표에 넣지 못해 이 종목의 지표 조건은 맞지 않는 것으로 봅니다");
                None
            }
        }
    }

    fn every_line_computed_at(&self, bar: usize) -> bool {
        self.output.lines.iter().all(|line| {
            let drawn_from_bars_before = usize::try_from(line.shift).unwrap_or(0);
            bar.checked_sub(drawn_from_bars_before).and_then(|at| at.checked_sub(self.from)).and_then(|at| line.values.get(at)).is_some_and(|value| !value.is_nan())
        })
    }

    fn value(&self, id: LineId, bar: usize) -> f64 {
        let Some(line) = self.output.lines.iter().find(|line| line.id == id) else {
            return f64::NAN;
        };
        let computed_at = i64::try_from(bar).ok().map(|bar| bar - i64::from(line.shift));
        computed_at.and_then(|at| usize::try_from(at).ok()).and_then(|at| at.checked_sub(self.from)).and_then(|at| line.values.get(at)).copied().unwrap_or(f64::NAN)
    }
}

fn input_field(input: Input) -> BarField {
    match input {
        Input::Open => BarField::Open,
        Input::High => BarField::High,
        Input::Low => BarField::Low,
        Input::Close => BarField::Close,
        Input::Volume => BarField::Volume,
    }
}

fn price_field(field: PriceField) -> BarField {
    match field {
        PriceField::Open => BarField::Open,
        PriceField::High => BarField::High,
        PriceField::Low => BarField::Low,
        PriceField::Close => BarField::Close,
    }
}
