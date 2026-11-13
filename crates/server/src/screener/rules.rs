use std::fmt;

use super::exact::Decimal;
use super::indicator::Indicator;
use super::line::{Kind, Line};
use super::market_cap::MarketCapRange;
use crate::api::{BarField, Bound, Condition, ExcludeKind, Extreme, Market, RsiTest, Screen, StochasticTest, SurgeField};

pub(crate) struct RunnableScreen {
    pub(super) lines: Vec<Line>,
    pub(super) market_caps: Vec<MarketCapRange>,
    pub(super) markets: Vec<Market>,
    pub(super) exclude: Vec<ExcludeKind>,
}

impl RunnableScreen {
    pub(super) fn covers(&self, market: Market) -> bool {
        self.markets.is_empty() || self.markets.contains(&market)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Invalid(String);

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub(crate) fn parse_screen(screen: &Screen) -> Result<RunnableScreen, Invalid> {
    let (mut lines, mut market_caps) = (Vec::new(), Vec::new());
    for (k, condition) in screen.conditions.iter().enumerate() {
        match rule_of(condition).map_err(|why| Invalid(format!("조건식 {}의 {}번째 조건: {why}", screen.name, k + 1)))? {
            Rule::Bars(line) => lines.push(line),
            Rule::MarketCap(range) => market_caps.push(range),
        }
    }
    Ok(RunnableScreen { lines, market_caps, markets: screen.markets.clone(), exclude: screen.exclude.clone() })
}

enum Rule {
    Bars(Line),
    MarketCap(MarketCapRange),
}

#[derive(Debug, Clone, Copy)]
enum Allowed {
    Any,
    NonNegative,
    Positive,
    Percent,
}

impl Allowed {
    fn decimal(self, what: &str, value: f64) -> Result<Decimal, String> {
        let (fits, rule) = match self {
            Allowed::Any => ((f64::MIN..=f64::MAX).contains(&value), "유한한 수"),
            Allowed::NonNegative => ((0.0..=f64::MAX).contains(&value), "0 이상의 유한한 수"),
            Allowed::Positive => (value > 0.0 && value <= f64::MAX, "0보다 큰 유한한 수"),
            Allowed::Percent => ((0.0..=100.0).contains(&value), "0~100인 수"),
        };
        let invalid = || format!("{what}는 {rule}여야 합니다: {value}");
        if fits { Decimal::of(value).ok_or_else(invalid) } else { Err(invalid()) }
    }
}

fn at_least_one(what: &str, value: u32) -> Result<(), String> {
    if value >= 1 { Ok(()) } else { Err(format!("{what}는 1 이상이어야 합니다")) }
}

fn indicator_length(what: &str, value: u16) -> Result<(), String> {
    if value >= 1 { Ok(()) } else { Err(format!("{what}는 1~65,535여야 합니다")) }
}

fn fast_below_slow(fast: u16, slow: u16) -> Result<(), String> {
    if fast < slow { Ok(()) } else { Err(format!("fast는 slow보다 작아야 합니다: fast={fast}, slow={slow}")) }
}

fn bounds(min: Bound, max: Bound, allowed: Allowed) -> Result<(Option<Decimal>, Option<Decimal>), String> {
    let lowest = min.0.map(|v| allowed.decimal("min", v)).transpose()?;
    let highest = max.0.map(|v| allowed.decimal("max", v)).transpose()?;
    match (min.0, max.0) {
        (None, None) => Err("min과 max 가운데 하나는 있어야 합니다".to_owned()),
        (Some(lo), Some(hi)) if lo > hi => Err(format!("min은 max 이하여야 합니다: min={lo}, max={hi}")),
        _ => Ok((lowest, highest)),
    }
}

fn surged(field: SurgeField) -> BarField {
    match field {
        SurgeField::Volume => BarField::Volume,
        SurgeField::TradedValue => BarField::TradedValue,
    }
}

fn rule_of(condition: &Condition) -> Result<Rule, String> {
    let line = |period, recent_bars, kind| Ok(Rule::Bars(Line { period, recent_bars, kind }));
    let indicator = |period, recent_bars, built: Result<Indicator, &'static str>| line(period, recent_bars, Kind::Indicator(built?));
    match *condition {
        Condition::NewHigh { period, recent_bars, field, n } => {
            at_least_one("n", n)?;
            line(period, recent_bars, Kind::NewExtreme { extreme: Extreme::High, field, n })
        }
        Condition::NewLow { period, recent_bars, field, n } => {
            at_least_one("n", n)?;
            line(period, recent_bars, Kind::NewExtreme { extreme: Extreme::Low, field, n })
        }
        Condition::ValueRange { period, recent_bars, field, min, max } => {
            let (min, max) = bounds(min, max, Allowed::NonNegative)?;
            line(period, recent_bars, Kind::ValueRange { field, min, max })
        }
        Condition::Change { period, recent_bars, back, min_pct, max_pct } => {
            at_least_one("back", back)?;
            let (min_pct, max_pct) = bounds(min_pct, max_pct, Allowed::Any)?;
            line(period, recent_bars, Kind::Change { back, min_pct, max_pct })
        }
        Condition::NearExtreme { period, recent_bars, extreme, n, within_pct } => {
            at_least_one("n", n)?;
            let within_pct = Allowed::Percent.decimal("withinPct", within_pct)?;
            line(period, recent_bars, Kind::NearExtreme { extreme, n, within_pct })
        }
        Condition::Surge { period, recent_bars, field, n, times } => {
            at_least_one("n", n)?;
            let times = Allowed::Positive.decimal("times", times)?;
            line(period, recent_bars, Kind::Surge { field: surged(field), n, times })
        }
        Condition::MaPosition { period, recent_bars, field, method, length, side } => {
            indicator_length("length", length)?;
            indicator(period, recent_bars, Indicator::ma_position(field, method, length, side))
        }
        Condition::MaAlignment { period, recent_bars, method, ref lengths, order } => {
            for &length in lengths {
                indicator_length("lengths", length)?;
            }
            if !(2..=5).contains(&lengths.len()) {
                return Err(format!("lengths는 2~5개여야 합니다: {}개", lengths.len()));
            }
            if lengths.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(format!("lengths는 겹치지 않고 커지는 순서여야 합니다: {lengths:?}"));
            }
            indicator(period, recent_bars, Indicator::ma_alignment(method, lengths, order))
        }
        Condition::MaCross { period, recent_bars, method, fast, slow, direction } => {
            indicator_length("slow", slow)?;
            if let Some(fast) = fast {
                indicator_length("fast", fast)?;
                fast_below_slow(fast, slow)?;
            }
            indicator(period, recent_bars, Indicator::ma_cross(method, fast, slow, direction))
        }
        Condition::Rsi { period, recent_bars, length, test } => {
            indicator_length("length", length)?;
            match test {
                RsiTest::Range { min, max } => {
                    bounds(min, max, Allowed::Percent)?;
                }
                RsiTest::Breakout { value, .. } => {
                    Allowed::Percent.decimal("value", value)?;
                }
            }
            indicator(period, recent_bars, Indicator::rsi(length, test))
        }
        Condition::Macd { period, recent_bars, fast, slow, signal, test } => {
            indicator_length("fast", fast)?;
            indicator_length("slow", slow)?;
            indicator_length("signal", signal)?;
            fast_below_slow(fast, slow)?;
            indicator(period, recent_bars, Indicator::macd(fast, slow, signal, test))
        }
        Condition::Stochastic { period, recent_bars, k, d, smooth, test } => {
            indicator_length("k", k)?;
            indicator_length("d", d)?;
            indicator_length("smooth", smooth)?;
            if let StochasticTest::Range { min, max } = test {
                bounds(min, max, Allowed::Percent)?;
            }
            indicator(period, recent_bars, Indicator::stochastic(k, d, smooth, test))
        }
        Condition::Bollinger { period, recent_bars, length, k, test } => {
            indicator_length("length", length)?;
            Allowed::Positive.decimal("k", k)?;
            indicator(period, recent_bars, Indicator::bollinger(length, k, test))
        }
        Condition::Ichimoku { period, recent_bars, conversion, base, span_b, displacement, test } => {
            indicator_length("conversion", conversion)?;
            indicator_length("base", base)?;
            indicator_length("spanB", span_b)?;
            indicator_length("displacement", displacement)?;
            indicator(period, recent_bars, Indicator::ichimoku(conversion, base, span_b, displacement, test))
        }
        Condition::MarketCap { min, max } => {
            let (min, max) = bounds(min, max, Allowed::NonNegative)?;
            Ok(Rule::MarketCap(MarketCapRange { min, max }))
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::api::{RecentBars, ScreenPeriod, Side};

    fn example(kind: &str) -> Value {
        match kind {
            "new_high" => json!({"kind": "new_high", "period": "D", "recentBars": 1, "field": "high", "n": 200}),
            "new_low" => json!({"kind": "new_low", "period": "W", "recentBars": 2, "field": "traded_value", "n": 52}),
            "value_range" => json!({"kind": "value_range", "period": "D", "recentBars": 1, "field": "traded_value", "min": 10_000_000_000.0, "max": null}),
            "change" => json!({"kind": "change", "period": "D", "recentBars": 1, "back": 20, "minPct": 30.0, "maxPct": null}),
            "near_extreme" => json!({"kind": "near_extreme", "period": "D", "recentBars": 1, "extreme": "high", "n": 200, "withinPct": 5.0}),
            "surge" => json!({"kind": "surge", "period": "D", "recentBars": 1, "field": "volume", "n": 20, "times": 3.0}),
            "ma_position" => json!({"kind": "ma_position", "period": "D", "recentBars": 1, "field": "close", "method": "sma", "length": 20, "side": "above"}),
            "ma_alignment" => json!({"kind": "ma_alignment", "period": "D", "recentBars": 1, "method": "ema", "lengths": [5, 20, 60, 120], "order": "bullish"}),
            "ma_cross" => json!({"kind": "ma_cross", "period": "D", "recentBars": 5, "method": "sma", "fast": 5, "slow": 20, "direction": "up"}),
            "rsi" => json!({"kind": "rsi", "period": "D", "recentBars": 3, "length": 14, "test": {"kind": "breakout", "value": 30.0, "direction": "up"}}),
            "macd" => json!({"kind": "macd", "period": "D", "recentBars": 1, "fast": 12, "slow": 26, "signal": 9, "test": {"kind": "signal_cross", "direction": "up"}}),
            "stochastic" => json!({"kind": "stochastic", "period": "D", "recentBars": 1, "k": 5, "d": 3, "smooth": 3, "test": {"kind": "range", "min": null, "max": 20.0}}),
            "bollinger" => json!({"kind": "bollinger", "period": "D", "recentBars": 1, "length": 20, "k": 2.0, "test": {"kind": "outside", "side": "above"}}),
            "ichimoku" => json!({"kind": "ichimoku", "period": "D", "recentBars": 1, "conversion": 9, "base": 26, "spanB": 52, "displacement": 26, "test": {"kind": "cloud", "side": "above"}}),
            "market_cap" => json!({"kind": "market_cap", "min": 300_000_000_000.0, "max": null}),
            other => panic!("모르는 조건 종류 {other}"),
        }
    }

    fn with(kind: &str, key: &str, value: Value) -> Value {
        let mut condition = example(kind);
        condition[key] = value;
        condition
    }

    fn screen_of(conditions: Vec<Value>) -> Screen {
        serde_json::from_value(json!({"id": "S1", "name": "기본", "markets": ["kospi"], "exclude": ["etf"], "conditions": conditions})).unwrap()
    }

    fn judged(condition: Value) -> Result<(), String> {
        parse_screen(&screen_of(vec![condition])).map(drop).map_err(|invalid| invalid.to_string())
    }

    fn refused(why: &str) -> Result<(), String> {
        Err(format!("조건식 기본의 1번째 조건: {why}"))
    }

    #[test]
    fn bar_conditions_need_a_positive_count() {
        let cases = [
            (example("new_high"), Ok(())),
            (with("new_high", "n", json!(1)), Ok(())),
            (with("new_high", "n", json!(0)), refused("n는 1 이상이어야 합니다")),
            (example("new_low"), Ok(())),
            (with("new_low", "n", json!(0)), refused("n는 1 이상이어야 합니다")),
            (example("change"), Ok(())),
            (with("change", "back", json!(0)), refused("back는 1 이상이어야 합니다")),
            (example("near_extreme"), Ok(())),
            (with("near_extreme", "n", json!(0)), refused("n는 1 이상이어야 합니다")),
            (example("surge"), Ok(())),
            (with("surge", "n", json!(0)), refused("n는 1 이상이어야 합니다")),
        ];
        for (condition, expected) in cases {
            assert_eq!(judged(condition.clone()), expected, "{condition}");
        }
    }

    #[test]
    fn value_range_and_market_cap_take_non_negative_bounds_with_one_end_at_least() {
        for kind in ["value_range", "market_cap"] {
            let bounded = |min: Value, max: Value| {
                let mut condition = example(kind);
                condition["min"] = min;
                condition["max"] = max;
                condition
            };
            let cases = [
                (bounded(json!(1.0), Value::Null), Ok(())),
                (bounded(Value::Null, json!(1.0)), Ok(())),
                (bounded(json!(0.0), json!(0.0)), Ok(())),
                (bounded(json!(5.0), json!(5.0)), Ok(())),
                (bounded(Value::Null, Value::Null), refused("min과 max 가운데 하나는 있어야 합니다")),
                (bounded(json!(-1.0), Value::Null), refused("min는 0 이상의 유한한 수여야 합니다: -1")),
                (bounded(Value::Null, json!(-0.5)), refused("max는 0 이상의 유한한 수여야 합니다: -0.5")),
                (bounded(json!(10.0), json!(9.5)), refused("min은 max 이하여야 합니다: min=10, max=9.5")),
            ];
            for (condition, expected) in cases {
                assert_eq!(judged(condition.clone()), expected, "{condition}");
            }
        }
    }

    #[test]
    fn change_takes_any_finite_bounds_and_percent_conditions_take_zero_to_one_hundred() {
        let cases = [
            (with("change", "minPct", json!(-99.5)), Ok(())),
            (with("change", "minPct", Value::Null), refused("min과 max 가운데 하나는 있어야 합니다")),
            (with("change", "maxPct", json!(29.9)), refused("min은 max 이하여야 합니다: min=30, max=29.9")),
            (with("near_extreme", "withinPct", json!(0.0)), Ok(())),
            (with("near_extreme", "withinPct", json!(100.0)), Ok(())),
            (with("near_extreme", "withinPct", json!(-0.1)), refused("withinPct는 0~100인 수여야 합니다: -0.1")),
            (with("near_extreme", "withinPct", json!(100.1)), refused("withinPct는 0~100인 수여야 합니다: 100.1")),
            (with("surge", "times", json!(0.5)), Ok(())),
            (with("surge", "times", json!(0.0)), refused("times는 0보다 큰 유한한 수여야 합니다: 0")),
            (with("surge", "times", json!(-3.0)), refused("times는 0보다 큰 유한한 수여야 합니다: -3")),
        ];
        for (condition, expected) in cases {
            assert_eq!(judged(condition.clone()), expected, "{condition}");
        }
    }

    #[test]
    fn moving_average_conditions_need_lengths_that_fit() {
        let cases = [
            (example("ma_position"), Ok(())),
            (with("ma_position", "length", json!(65_535)), Ok(())),
            (with("ma_position", "length", json!(0)), refused("length는 1~65,535여야 합니다")),
            (example("ma_alignment"), Ok(())),
            (with("ma_alignment", "lengths", json!([5, 20])), Ok(())),
            (with("ma_alignment", "lengths", json!([65_531, 65_532, 65_533, 65_534, 65_535])), Ok(())),
            (with("ma_alignment", "lengths", json!([0, 20])), refused("lengths는 1~65,535여야 합니다")),
            (with("ma_alignment", "lengths", json!([20])), refused("lengths는 2~5개여야 합니다: 1개")),
            (with("ma_alignment", "lengths", json!([1, 2, 3, 4, 5, 6])), refused("lengths는 2~5개여야 합니다: 6개")),
            (with("ma_alignment", "lengths", json!([20, 5, 60])), refused("lengths는 겹치지 않고 커지는 순서여야 합니다: [20, 5, 60]")),
            (with("ma_alignment", "lengths", json!([5, 20, 20])), refused("lengths는 겹치지 않고 커지는 순서여야 합니다: [5, 20, 20]")),
            (example("ma_cross"), Ok(())),
            (with("ma_cross", "fast", Value::Null), Ok(())),
            (with("ma_cross", "slow", json!(0)), refused("slow는 1~65,535여야 합니다")),
            (with("ma_cross", "fast", json!(0)), refused("fast는 1~65,535여야 합니다")),
            (with("ma_cross", "fast", json!(20)), refused("fast는 slow보다 작아야 합니다: fast=20, slow=20")),
            (with("ma_cross", "fast", json!(60)), refused("fast는 slow보다 작아야 합니다: fast=60, slow=20")),
        ];
        for (condition, expected) in cases {
            assert_eq!(judged(condition.clone()), expected, "{condition}");
        }
    }

    #[test]
    fn rsi_and_stochastic_tests_stay_within_zero_to_one_hundred() {
        let rsi = |test: Value| with("rsi", "test", test);
        let stochastic = |test: Value| with("stochastic", "test", test);
        let cases = [
            (example("rsi"), Ok(())),
            (with("rsi", "length", json!(0)), refused("length는 1~65,535여야 합니다")),
            (rsi(json!({"kind": "range", "min": null, "max": 30.0})), Ok(())),
            (rsi(json!({"kind": "range", "min": 0.0, "max": 100.0})), Ok(())),
            (rsi(json!({"kind": "range", "min": null, "max": null})), refused("min과 max 가운데 하나는 있어야 합니다")),
            (rsi(json!({"kind": "range", "min": 70.0, "max": 30.0})), refused("min은 max 이하여야 합니다: min=70, max=30")),
            (rsi(json!({"kind": "range", "min": 70.0, "max": 100.5})), refused("max는 0~100인 수여야 합니다: 100.5")),
            (rsi(json!({"kind": "range", "min": -1.0, "max": null})), refused("min는 0~100인 수여야 합니다: -1")),
            (rsi(json!({"kind": "breakout", "value": 100.0, "direction": "down"})), Ok(())),
            (rsi(json!({"kind": "breakout", "value": 101.0, "direction": "up"})), refused("value는 0~100인 수여야 합니다: 101")),
            (rsi(json!({"kind": "breakout", "value": -0.5, "direction": "up"})), refused("value는 0~100인 수여야 합니다: -0.5")),
            (example("stochastic"), Ok(())),
            (stochastic(json!({"kind": "cross", "direction": "down"})), Ok(())),
            (with("stochastic", "k", json!(0)), refused("k는 1~65,535여야 합니다")),
            (with("stochastic", "d", json!(0)), refused("d는 1~65,535여야 합니다")),
            (with("stochastic", "smooth", json!(0)), refused("smooth는 1~65,535여야 합니다")),
            (stochastic(json!({"kind": "range", "min": 80.0, "max": 101.0})), refused("max는 0~100인 수여야 합니다: 101")),
            (stochastic(json!({"kind": "range", "min": 80.0, "max": 20.0})), refused("min은 max 이하여야 합니다: min=80, max=20")),
            (stochastic(json!({"kind": "range", "min": null, "max": null})), refused("min과 max 가운데 하나는 있어야 합니다")),
        ];
        for (condition, expected) in cases {
            assert_eq!(judged(condition.clone()), expected, "{condition}");
        }
    }

    #[test]
    fn macd_bollinger_and_ichimoku_need_fitting_settings() {
        let cases = [
            (example("macd"), Ok(())),
            (with("macd", "test", json!({"kind": "zero_breakout", "direction": "down"})), Ok(())),
            (with("macd", "test", json!({"kind": "vs_signal", "side": "below"})), Ok(())),
            (with("macd", "fast", json!(0)), refused("fast는 1~65,535여야 합니다")),
            (with("macd", "slow", json!(0)), refused("slow는 1~65,535여야 합니다")),
            (with("macd", "signal", json!(0)), refused("signal는 1~65,535여야 합니다")),
            (with("macd", "fast", json!(26)), refused("fast는 slow보다 작아야 합니다: fast=26, slow=26")),
            (with("macd", "slow", json!(10)), refused("fast는 slow보다 작아야 합니다: fast=12, slow=10")),
            (example("bollinger"), Ok(())),
            (with("bollinger", "test", json!({"kind": "cross", "band": "lower", "direction": "up"})), Ok(())),
            (with("bollinger", "length", json!(0)), refused("length는 1~65,535여야 합니다")),
            (with("bollinger", "k", json!(0.0)), refused("k는 0보다 큰 유한한 수여야 합니다: 0")),
            (with("bollinger", "k", json!(-2.0)), refused("k는 0보다 큰 유한한 수여야 합니다: -2")),
            (example("ichimoku"), Ok(())),
            (with("ichimoku", "test", json!({"kind": "cross", "direction": "up"})), Ok(())),
            (with("ichimoku", "conversion", json!(0)), refused("conversion는 1~65,535여야 합니다")),
            (with("ichimoku", "base", json!(0)), refused("base는 1~65,535여야 합니다")),
            (with("ichimoku", "spanB", json!(0)), refused("spanB는 1~65,535여야 합니다")),
            (with("ichimoku", "displacement", json!(0)), refused("displacement는 1~65,535여야 합니다")),
        ];
        for (condition, expected) in cases {
            assert_eq!(judged(condition.clone()), expected, "{condition}");
        }
    }

    #[test]
    fn a_number_that_is_not_finite_is_refused_where_json_cannot_carry_it() {
        let recent_bars = RecentBars::try_from(1).unwrap();
        let screen_with = |condition| Screen { id: "S1".to_owned(), name: "기본".to_owned(), markets: vec![], exclude: vec![], conditions: vec![condition] };
        let surge = |times| Condition::Surge { period: ScreenPeriod::Day, recent_bars, field: SurgeField::Volume, n: 20, times };
        let bollinger = |k| Condition::Bollinger { period: ScreenPeriod::Day, recent_bars, length: 20, k, test: crate::api::BollingerTest::Outside { side: Side::Above } };
        let near_extreme = |within_pct| Condition::NearExtreme { period: ScreenPeriod::Day, recent_bars, extreme: Extreme::High, n: 5, within_pct };
        let range = |min| Condition::MarketCap { min: Bound(Some(min)), max: Bound(None) };
        let cases = [
            (surge(f64::NAN), "times는 0보다 큰 유한한 수여야 합니다: NaN"),
            (surge(f64::INFINITY), "times는 0보다 큰 유한한 수여야 합니다: inf"),
            (bollinger(f64::INFINITY), "k는 0보다 큰 유한한 수여야 합니다: inf"),
            (near_extreme(f64::NAN), "withinPct는 0~100인 수여야 합니다: NaN"),
            (range(f64::INFINITY), "min는 0 이상의 유한한 수여야 합니다: inf"),
        ];
        for (condition, why) in cases {
            let refusal = parse_screen(&screen_with(condition)).map(drop).map_err(|invalid| invalid.to_string());
            assert_eq!(refusal, refused(why));
        }
    }

    #[test]
    fn the_message_names_the_screen_and_the_failing_line_and_keeps_markets_and_exclusions() {
        let screen = screen_of(vec![example("new_high"), with("new_high", "n", json!(0)), with("rsi", "length", json!(0))]);
        assert_eq!(parse_screen(&screen).map(drop).unwrap_err().to_string(), "조건식 기본의 2번째 조건: n는 1 이상이어야 합니다");
        let runnable = parse_screen(&screen_of(vec![example("new_high"), example("market_cap"), example("rsi")])).unwrap();
        assert_eq!((runnable.lines.len(), runnable.market_caps.len(), runnable.markets.len(), runnable.exclude.len()), (2, 1, 1, 1));
    }
}
