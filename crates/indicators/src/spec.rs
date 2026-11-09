use std::ops::Deref;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MaMethod {
    Sma,
    Ema,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, rename = "IndicatorSpec")]
pub enum Spec {
    Ma { method: MaMethod, period: u16 },
    Bollinger { period: u16, k: f64 },
    Ichimoku { conversion: u16, base: u16, span_b: u16, displacement: u16 },
    Volume { ma_period: Option<u16> },
    Rsi { period: u16, signal: Option<u16> },
    Macd { fast: u16, slow: u16, signal: u16 },
    StochSlow { k: u16, d: u16, smooth: u16 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LineId {
    Ma,
    Upper,
    Middle,
    Lower,
    Conversion,
    Base,
    SpanA,
    SpanB,
    Lagging,
    Volume,
    Rsi,
    Signal,
    Macd,
    Histogram,
    K,
    D,
}

impl LineId {
    pub const ALL: [LineId; 16] = [
        LineId::Ma,
        LineId::Upper,
        LineId::Middle,
        LineId::Lower,
        LineId::Conversion,
        LineId::Base,
        LineId::SpanA,
        LineId::SpanB,
        LineId::Lagging,
        LineId::Volume,
        LineId::Rsi,
        LineId::Signal,
        LineId::Macd,
        LineId::Histogram,
        LineId::K,
        LineId::D,
    ];

    pub fn as_wire(self) -> &'static str {
        match self {
            LineId::Ma => "ma",
            LineId::Upper => "upper",
            LineId::Middle => "middle",
            LineId::Lower => "lower",
            LineId::Conversion => "conversion",
            LineId::Base => "base",
            LineId::SpanA => "spanA",
            LineId::SpanB => "spanB",
            LineId::Lagging => "lagging",
            LineId::Volume => "volume",
            LineId::Rsi => "rsi",
            LineId::Signal => "signal",
            LineId::Macd => "macd",
            LineId::Histogram => "histogram",
            LineId::K => "k",
            LineId::D => "d",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SpecError {
    pub field: String,
    pub message: String,
}

impl SpecError {
    fn new(field: &str, message: &str) -> Self {
        SpecError { field: field.to_owned(), message: message.to_owned() }
    }
}

fn at_least_one(errors: &mut Vec<SpecError>, field: &str, value: u16) {
    if value == 0 {
        errors.push(SpecError::new(field, "1 이상이어야 합니다."));
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidSpec(Spec);

impl ValidSpec {
    pub fn new(spec: Spec) -> Result<Self, Vec<SpecError>> {
        spec.validate()?;
        Ok(ValidSpec(spec))
    }
}

impl Deref for ValidSpec {
    type Target = Spec;

    fn deref(&self) -> &Spec {
        &self.0
    }
}

impl Spec {
    pub fn parse_valid(json: &str) -> Result<ValidSpec, Vec<SpecError>> {
        let spec: Spec = serde_json::from_str(json)
            .map_err(|e| vec![SpecError::new("", &format!("지표 설정을 읽을 수 없습니다: {e}"))])?;
        ValidSpec::new(spec)
    }

    fn validate(&self) -> Result<(), Vec<SpecError>> {
        let mut errors = Vec::new();
        match *self {
            Spec::Ma { period, .. } => at_least_one(&mut errors, "period", period),
            Spec::Bollinger { period, k } => {
                at_least_one(&mut errors, "period", period);
                if !(k.is_finite() && k > 0.0) {
                    errors.push(SpecError::new("k", "0보다 큰 수여야 합니다."));
                }
            }
            Spec::Ichimoku { conversion, base, span_b, displacement } => {
                at_least_one(&mut errors, "conversion", conversion);
                at_least_one(&mut errors, "base", base);
                at_least_one(&mut errors, "spanB", span_b);
                at_least_one(&mut errors, "displacement", displacement);
            }
            Spec::Volume { ma_period } => {
                if let Some(p) = ma_period {
                    at_least_one(&mut errors, "maPeriod", p);
                }
            }
            Spec::Rsi { period, signal } => {
                at_least_one(&mut errors, "period", period);
                if let Some(s) = signal {
                    at_least_one(&mut errors, "signal", s);
                }
            }
            Spec::Macd { fast, slow, signal } => {
                at_least_one(&mut errors, "fast", fast);
                at_least_one(&mut errors, "slow", slow);
                at_least_one(&mut errors, "signal", signal);
                if fast >= slow {
                    errors.push(SpecError::new("slow", "fast보다 커야 합니다."));
                }
            }
            Spec::StochSlow { k, d, smooth } => {
                at_least_one(&mut errors, "k", k);
                at_least_one(&mut errors, "d", d);
                at_least_one(&mut errors, "smooth", smooth);
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(errors) }
    }

    pub fn warmup(&self) -> usize {
        let n = |v: u16| usize::from(v);
        match *self {
            Spec::Ma { period, .. } | Spec::Bollinger { period, .. } => n(period),
            Spec::Ichimoku { conversion, base, span_b, .. } => n(conversion).max(n(base)).max(n(span_b)),
            Spec::Volume { ma_period } => ma_period.map_or(1, n),
            Spec::Rsi { period, signal } => n(period) + signal.map_or(1, n),
            Spec::Macd { fast, slow, signal } => (n(fast).max(n(slow)) + n(signal)).saturating_sub(1),
            Spec::StochSlow { k, d, smooth } => (n(k) + n(smooth) + n(d)).saturating_sub(2),
        }
    }

    pub fn lines(&self) -> Vec<LineId> {
        use LineId::*;
        match *self {
            Spec::Ma { .. } => vec![Ma],
            Spec::Bollinger { .. } => vec![Upper, Middle, Lower],
            Spec::Ichimoku { .. } => vec![Conversion, Base, SpanA, SpanB, Lagging],
            Spec::Volume { ma_period: None } => vec![Volume],
            Spec::Volume { ma_period: Some(_) } => vec![Volume, Ma],
            Spec::Rsi { signal: None, .. } => vec![Rsi],
            Spec::Rsi { signal: Some(_), .. } => vec![Rsi, Signal],
            Spec::Macd { .. } => vec![Macd, Signal, Histogram],
            Spec::StochSlow { .. } => vec![K, D],
        }
    }

    pub fn shift_of(&self, line: LineId) -> Option<i32> {
        if !self.lines().contains(&line) {
            return None;
        }
        let ahead = match *self {
            Spec::Ichimoku { displacement, .. } => i32::from(displacement) - 1,
            _ => 0,
        };
        Some(match line {
            LineId::SpanA | LineId::SpanB => ahead,
            LineId::Lagging => -ahead,
            _ => 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_uses_the_contract_field_names() {
        let cases = [
            (r#"{"kind":"ichimoku","conversion":9,"base":26,"spanB":52,"displacement":26}"#,
             Spec::Ichimoku { conversion: 9, base: 26, span_b: 52, displacement: 26 }),
            (r#"{"kind":"volume","maPeriod":20}"#, Spec::Volume { ma_period: Some(20) }),
            (r#"{"kind":"volume","maPeriod":null}"#, Spec::Volume { ma_period: None }),
            (r#"{"kind":"stochSlow","k":5,"d":3,"smooth":3}"#, Spec::StochSlow { k: 5, d: 3, smooth: 3 }),
            (r#"{"kind":"ma","method":"ema","period":20}"#, Spec::Ma { method: MaMethod::Ema, period: 20 }),
            (r#"{"kind":"bollinger","period":20,"k":2.0}"#, Spec::Bollinger { period: 20, k: 2.0 }),
            (r#"{"kind":"rsi","period":14,"signal":null}"#, Spec::Rsi { period: 14, signal: None }),
            (r#"{"kind":"macd","fast":12,"slow":26,"signal":9}"#, Spec::Macd { fast: 12, slow: 26, signal: 9 }),
        ];
        for (json, spec) in cases {
            assert_eq!(serde_json::from_str::<Spec>(json).unwrap(), spec, "{json}");
            assert_eq!(serde_json::to_string(&spec).unwrap(), json);
        }
    }

    #[test]
    fn line_wire_names_match_serde() {
        for id in LineId::ALL {
            assert_eq!(serde_json::to_value(id).unwrap(), id.as_wire());
        }
    }

    #[test]
    fn typescript_names_match_the_contract() {
        let ts = Spec::decl();
        assert!(ts.starts_with("type IndicatorSpec ="), "{ts}");
        for name in [r#""kind": "stochSlow""#, "spanB: number", "maPeriod: number | null", "method: MaMethod"] {
            assert!(ts.contains(name), "{name} 없음: {ts}");
        }
    }

    #[test]
    fn validation_names_each_bad_field() {
        let errs = Spec::parse_valid(r#"{"kind":"macd","fast":0,"slow":0,"signal":9}"#).unwrap_err();
        let fields: Vec<&str> = errs.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(fields, ["fast", "slow", "slow"]);
        assert_eq!(Spec::parse_valid(r#"{"kind":"bollinger","period":20,"k":0}"#).unwrap_err()[0].field, "k");
        assert_eq!(Spec::parse_valid(r#"{"kind":"volume","maPeriod":0}"#).unwrap_err()[0].field, "maPeriod");
        let unreadable = Spec::parse_valid(r#"{"kind":"ma","method":"wma","period":5}"#).unwrap_err();
        assert_eq!(unreadable[0].field, "");
        assert!(Spec::parse_valid(r#"{"kind":"ma","method":"sma","period":70000}"#).is_err());
        assert!(Spec::parse_valid(r#"{"kind":"macd","fast":12,"slow":26,"signal":9}"#).is_ok());
    }

    #[test]
    fn ichimoku_spans_move_by_displacement_minus_one() {
        let spec = Spec::Ichimoku { conversion: 9, base: 26, span_b: 52, displacement: 26 };
        assert_eq!(spec.shift_of(LineId::SpanA), Some(25));
        assert_eq!(spec.shift_of(LineId::SpanB), Some(25));
        assert_eq!(spec.shift_of(LineId::Lagging), Some(-25));
        assert_eq!(spec.shift_of(LineId::Base), Some(0));
        assert_eq!(spec.shift_of(LineId::Rsi), None);
        assert_eq!(Spec::Volume { ma_period: None }.shift_of(LineId::Ma), None);
    }
}
