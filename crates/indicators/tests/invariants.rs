use indicators::{BarInput, Columns, Engine, LineId, MaMethod, Output, Spec, Tail, compute};
use proptest::prelude::*;

struct Bars {
    t: Vec<i64>,
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    volume: Vec<f64>,
}

impl Bars {
    fn from(bars: &[BarInput]) -> Self {
        let col = |f: fn(&BarInput) -> f64| bars.iter().map(f).collect();
        Bars {
            t: bars.iter().map(|b| b.t).collect(),
            open: col(|b| b.open),
            high: col(|b| b.high),
            low: col(|b| b.low),
            close: col(|b| b.close),
            volume: col(|b| b.volume),
        }
    }

    fn columns(&self) -> Columns<'_> {
        Columns::new(&self.t, &self.open, &self.high, &self.low, &self.close, &self.volume).unwrap()
    }
}

fn compute_bars(spec: &Spec, bars: &[BarInput]) -> Output {
    compute(spec, &Bars::from(bars).columns())
}

fn bits(values: &[f64]) -> Vec<u64> {
    values.iter().map(|v| v.to_bits()).collect()
}

fn assert_same_output(a: &Output, b: &Output) {
    assert_eq!(a.lines.len(), b.lines.len());
    for (x, y) in a.lines.iter().zip(&b.lines) {
        assert_eq!((x.id, x.shift), (y.id, y.shift));
        assert_eq!(bits(&x.values), bits(&y.values), "{:?}", x.id);
    }
}

fn last_of(output: &Output) -> Vec<(LineId, u64)> {
    output.lines.iter().map(|l| (l.id, l.values.last().unwrap().to_bits())).collect()
}

fn tail_bits(tail: &Tail) -> Vec<(LineId, u64)> {
    tail.values.iter().map(|(id, v)| (*id, v.to_bits())).collect()
}

fn period() -> impl Strategy<Value = u16> {
    1u16..30
}

fn spec() -> impl Strategy<Value = Spec> {
    prop_oneof![
        (prop_oneof![Just(MaMethod::Sma), Just(MaMethod::Ema)], period()).prop_map(|(method, period)| Spec::Ma { method, period }),
        (period(), 0.5f64..3.0).prop_map(|(period, k)| Spec::Bollinger { period, k }),
        (period(), period(), period(), period())
            .prop_map(|(conversion, base, span_b, displacement)| Spec::Ichimoku { conversion, base, span_b, displacement }),
        proptest::option::of(period()).prop_map(|ma_period| Spec::Volume { ma_period }),
        (period(), proptest::option::of(period())).prop_map(|(period, signal)| Spec::Rsi { period, signal }),
        (period(), 1u16..20, period()).prop_map(|(fast, gap, signal)| Spec::Macd { fast, slow: fast + gap, signal }),
        (period(), period(), period()).prop_map(|(k, d, smooth)| Spec::StochSlow { k, d, smooth }),
    ]
}

fn bar() -> impl Strategy<Value = (f64, f64, f64, f64, f64)> {
    (1_000u32..1_100, 1_000u32..1_100, 0u32..30, 0u32..30, 0u32..1_000_000).prop_map(|(o, c, up, down, v)| {
        let (o, c) = (f64::from(o), f64::from(c));
        (o, o.max(c) + f64::from(up), o.min(c) - f64::from(down), c, f64::from(v))
    })
}

fn bars(max: usize) -> impl Strategy<Value = Vec<BarInput>> {
    proptest::collection::vec(bar(), 1..max).prop_map(|rows| {
        rows.into_iter()
            .enumerate()
            .map(|(i, (open, high, low, close, volume))| BarInput { t: 60 * i as i64, open, high, low, close, volume })
            .collect()
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    #[test]
    fn pushing_confirmed_bars_equals_computing_all(spec in spec(), bars in bars(120), split in 0usize..120) {
        let split = split.min(bars.len());
        let head = Bars::from(&bars[..split]);
        let mut engine = Engine::new(&spec, &head.columns());
        for n in split..bars.len() {
            let tail = engine.push_confirmed(&bars[n]);
            prop_assert_eq!(tail_bits(&tail), last_of(&compute_bars(&spec, &bars[..=n])));
        }
        assert_same_output(engine.output(), &compute_bars(&spec, &bars));
    }

    #[test]
    fn preview_equals_computing_with_the_current_bar_and_changes_nothing(spec in spec(), bars in bars(120)) {
        let (current, confirmed) = bars.split_last().unwrap();
        let engine = Engine::new(&spec, &Bars::from(confirmed).columns());
        let before = engine.output().clone();
        let preview = engine.preview(current);
        prop_assert_eq!(tail_bits(&preview), last_of(&compute_bars(&spec, &bars)));
        assert_same_output(engine.output(), &before);
    }

    #[test]
    fn warmup_is_the_first_bar_where_every_line_has_a_value(spec in spec(), bars in bars(200)) {
        let output = compute_bars(&spec, &bars);
        let all_defined = |i: usize| output.lines.iter().all(|l| l.values[i].is_finite());
        let first = (0..bars.len()).find(|&i| all_defined(i));
        let warmup = spec.warmup();
        if warmup <= bars.len() {
            prop_assert_eq!(first, Some(warmup - 1));
            prop_assert!((warmup - 1..bars.len()).all(all_defined));
        } else {
            prop_assert_eq!(first, None);
        }
    }

    #[test]
    fn line_shifts_come_from_the_spec(spec in spec(), bars in bars(10)) {
        let output = compute_bars(&spec, &bars);
        let ids: Vec<LineId> = output.lines.iter().map(|l| l.id).collect();
        prop_assert_eq!(ids, spec.lines());
        for line in &output.lines {
            prop_assert_eq!(Some(line.shift), spec.shift_of(line.id));
            prop_assert_eq!(line.values.len(), bars.len());
        }
    }
}

#[test]
fn flat_prices_sit_in_the_middle_of_rsi_and_stochastic() {
    let flat: Vec<BarInput> =
        (0..40).map(|i| BarInput { t: i, open: 100.0, high: 100.0, low: 100.0, close: 100.0, volume: 1.0 }).collect();
    let rsi = compute_bars(&Spec::Rsi { period: 14, signal: None }, &flat);
    assert_eq!(rsi.lines[0].values[39], 50.0);
    let stoch = compute_bars(&Spec::StochSlow { k: 5, d: 3, smooth: 3 }, &flat);
    assert_eq!((stoch.lines[0].values[39], stoch.lines[1].values[39]), (50.0, 50.0));
}

#[test]
fn columns_reject_ragged_or_unordered_input() {
    let x = [1.0, 2.0];
    assert!(Columns::new(&[1, 2], &x, &x, &x, &x, &[1.0]).is_err());
    assert!(Columns::new(&[2, 2], &x, &x, &x, &x, &x).is_err());
    assert!(Columns::new(&[1, 2], &x, &x, &x, &x, &x).is_ok());
}

#[test]
fn invalid_specs_compute_without_panicking() {
    let bars: Vec<BarInput> =
        (0..5).map(|i| BarInput { t: i, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: 3.0 }).collect();
    for spec in [
        Spec::Ma { method: MaMethod::Ema, period: 0 },
        Spec::Rsi { period: 0, signal: Some(0) },
        Spec::Macd { fast: 0, slow: 0, signal: 0 },
        Spec::StochSlow { k: 0, d: 0, smooth: 0 },
        Spec::Ichimoku { conversion: 0, base: 0, span_b: 0, displacement: 0 },
    ] {
        assert!(spec.validate().is_err());
        let _ = spec.warmup();
        assert_eq!(compute_bars(&spec, &bars).lines[0].values.len(), 5);
    }
}
