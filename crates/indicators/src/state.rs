use std::collections::VecDeque;
const NAN: f64 = f64::NAN;

use crate::engine::BarInput;
use crate::spec::{MaMethod, Spec};

pub(crate) const MAX_LINES: usize = 5;
pub(crate) type Values = [f64; MAX_LINES];

fn values(head: &[f64]) -> Values {
    let mut out = [NAN; MAX_LINES];
    out[..head.len()].copy_from_slice(head);
    out
}

/// 값 x에 대해서만 걸음을 옮긴다. 앞선 지표가 아직 값을 내지 않은 봉은 건너뛴다.
fn on_defined(x: f64, step: impl FnOnce(f64) -> f64) -> f64 {
    if x.is_nan() { NAN } else { step(x) }
}

#[derive(Debug, Clone)]
struct Window {
    len: usize,
    buf: VecDeque<f64>,
}

impl Window {
    fn new(len: u16) -> Self {
        let len = usize::from(len);
        Window { len, buf: VecDeque::with_capacity(len + 1) }
    }

    fn push(&mut self, x: f64) -> bool {
        self.buf.push_back(x);
        if self.buf.len() > self.len {
            self.buf.pop_front();
        }
        self.is_full()
    }

    fn is_full(&self) -> bool {
        self.len > 0 && self.buf.len() == self.len
    }

    fn mean(&self) -> f64 {
        self.buf.iter().sum::<f64>() / self.len as f64
    }

    fn max(&self) -> f64 {
        self.buf.iter().copied().fold(f64::NEG_INFINITY, f64::max)
    }

    fn min(&self) -> f64 {
        self.buf.iter().copied().fold(f64::INFINITY, f64::min)
    }
}

#[derive(Debug, Clone)]
struct Sma(Window);

impl Sma {
    fn new(period: u16) -> Self {
        Sma(Window::new(period))
    }

    fn step(&mut self, x: f64) -> f64 {
        if self.0.push(x) { self.0.mean() } else { NAN }
    }
}

/// 첫 period개의 단순평균에서 시작한다(backend.md §9.5).
#[derive(Debug, Clone)]
struct Ema {
    alpha: f64,
    seed: Sma,
    last: Option<f64>,
}

impl Ema {
    fn new(period: u16) -> Self {
        Ema { alpha: 2.0 / (f64::from(period) + 1.0), seed: Sma::new(period), last: None }
    }

    fn step(&mut self, x: f64) -> f64 {
        let next = match self.last {
            Some(prev) => self.alpha * x + (1.0 - self.alpha) * prev,
            None => self.seed.step(x),
        };
        if !next.is_nan() {
            self.last = Some(next);
        }
        next
    }
}

#[derive(Debug, Clone)]
struct Midpoint {
    high: Window,
    low: Window,
}

impl Midpoint {
    fn new(period: u16) -> Self {
        Midpoint { high: Window::new(period), low: Window::new(period) }
    }

    fn step(&mut self, bar: &BarInput) -> f64 {
        self.high.push(bar.high);
        if self.low.push(bar.low) { (self.high.max() + self.low.min()) / 2.0 } else { NAN }
    }
}

#[derive(Debug, Clone)]
enum Average {
    Sma(Sma),
    Ema(Ema),
}

#[derive(Debug, Clone)]
struct Wilder {
    period: f64,
    prev_close: Option<f64>,
    seen: usize,
    gain: f64,
    loss: f64,
}

impl Wilder {
    /// 첫 RSI는 종가 변화 period개의 단순평균, 그 뒤는 (이전 × (n−1) + 이번) / n.
    fn step(&mut self, close: f64) -> f64 {
        let Some(prev) = self.prev_close.replace(close) else { return NAN };
        let change = close - prev;
        let (gain, loss) = (change.max(0.0), (-change).max(0.0));
        let n = self.period;
        self.seen += 1;
        if (self.seen as f64) < n {
            self.gain += gain;
            self.loss += loss;
            return NAN;
        }
        if self.seen as f64 == n {
            self.gain = (self.gain + gain) / n;
            self.loss = (self.loss + loss) / n;
        } else {
            self.gain = (self.gain * (n - 1.0) + gain) / n;
            self.loss = (self.loss * (n - 1.0) + loss) / n;
        }
        balance(self.gain, self.gain + self.loss)
    }
}

/// part / whole × 100. 값이 움직이지 않아 whole이 0이면 가운데인 50이다.
fn balance(part: f64, whole: f64) -> f64 {
    if whole == 0.0 { 50.0 } else { 100.0 * part / whole }
}

#[derive(Debug, Clone)]
pub(crate) struct State(Kind);

#[derive(Debug, Clone)]
enum Kind {
    Ma(Average),
    Bollinger { window: Window, k: f64 },
    Ichimoku { conversion: Midpoint, base: Midpoint, span_b: Midpoint },
    Volume { ma: Option<Sma> },
    Rsi { rsi: Wilder, signal: Option<Sma> },
    Macd { fast: Ema, slow: Ema, signal: Ema },
    StochSlow { high: Window, low: Window, smooth: Sma, d: Sma },
}

impl State {
    pub(crate) fn new(spec: &Spec) -> Self {
        State(match *spec {
            Spec::Ma { method: MaMethod::Sma, period } => Kind::Ma(Average::Sma(Sma::new(period))),
            Spec::Ma { method: MaMethod::Ema, period } => Kind::Ma(Average::Ema(Ema::new(period))),
            Spec::Bollinger { period, k } => Kind::Bollinger { window: Window::new(period), k },
            Spec::Ichimoku { conversion, base, span_b, .. } => Kind::Ichimoku {
                conversion: Midpoint::new(conversion),
                base: Midpoint::new(base),
                span_b: Midpoint::new(span_b),
            },
            Spec::Volume { ma_period } => Kind::Volume { ma: ma_period.map(Sma::new) },
            Spec::Rsi { period, signal } => Kind::Rsi {
                rsi: Wilder { period: f64::from(period), prev_close: None, seen: 0, gain: 0.0, loss: 0.0 },
                signal: signal.map(Sma::new),
            },
            Spec::Macd { fast, slow, signal } => {
                Kind::Macd { fast: Ema::new(fast), slow: Ema::new(slow), signal: Ema::new(signal) }
            }
            Spec::StochSlow { k, d, smooth } => {
                Kind::StochSlow { high: Window::new(k), low: Window::new(k), smooth: Sma::new(smooth), d: Sma::new(d) }
            }
        })
    }

    /// 한 봉을 더하고 그 봉 위치의 값을 Spec::lines() 순서로 돌려준다.
    pub(crate) fn step(&mut self, bar: &BarInput) -> Values {
        match &mut self.0 {
            Kind::Ma(Average::Sma(sma)) => values(&[sma.step(bar.close)]),
            Kind::Ma(Average::Ema(ema)) => values(&[ema.step(bar.close)]),
            Kind::Bollinger { window, k } => {
                if !window.push(bar.close) {
                    return values(&[]);
                }
                let mean = window.mean();
                let variance = window.buf.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / window.len as f64;
                let band = *k * variance.sqrt();
                values(&[mean + band, mean, mean - band])
            }
            Kind::Ichimoku { conversion, base, span_b } => {
                let (c, b) = (conversion.step(bar), base.step(bar));
                values(&[c, b, (c + b) / 2.0, span_b.step(bar), bar.close])
            }
            Kind::Volume { ma: None } => values(&[bar.volume]),
            Kind::Volume { ma: Some(ma) } => values(&[bar.volume, ma.step(bar.volume)]),
            Kind::Rsi { rsi, signal } => {
                let r = rsi.step(bar.close);
                match signal {
                    None => values(&[r]),
                    Some(signal) => values(&[r, on_defined(r, |r| signal.step(r))]),
                }
            }
            Kind::Macd { fast, slow, signal } => {
                let macd = fast.step(bar.close) - slow.step(bar.close);
                let sig = on_defined(macd, |m| signal.step(m));
                values(&[macd, sig, macd - sig])
            }
            Kind::StochSlow { high, low, smooth, d } => {
                high.push(bar.high);
                if !low.push(bar.low) {
                    return values(&[]);
                }
                let (hh, ll) = (high.max(), low.min());
                let k = on_defined(balance(bar.close - ll, hh - ll), |fast| smooth.step(fast));
                values(&[k, on_defined(k, |k| d.step(k))])
            }
        }
    }
}
