use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Decimal {
    negative: bool,
    digits: u64,
    exponent: i32,
}

impl Decimal {
    pub(super) fn of(value: f64) -> Option<Decimal> {
        if !value.is_finite() {
            return None;
        }
        let text = format!("{value:e}");
        let (mantissa, exponent) = text.split_once('e')?;
        let exponent: i32 = exponent.parse().ok()?;
        let negative = mantissa.starts_with('-');
        let mantissa = mantissa.trim_start_matches('-');
        let fraction_digits = mantissa.split_once('.').map_or(0, |(_, fraction)| fraction.len());
        let digits: u64 = mantissa.replace('.', "").parse().ok()?;
        Some(Decimal { negative, digits, exponent: exponent - i32::try_from(fraction_digits).ok()? })
    }

    pub(super) fn times(self, factor: u128) -> Exact {
        Exact { negative: self.negative, magnitude: U256::product(u128::from(self.digits), factor), exponent: self.exponent }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Exact {
    negative: bool,
    magnitude: U256,
    exponent: i32,
}

impl Exact {
    pub(super) fn new(negative: bool, magnitude: u128, exponent: i32) -> Exact {
        Exact { negative, magnitude: U256 { high: 0, low: magnitude }, exponent }
    }

    fn sign(&self) -> i8 {
        match (self.magnitude == U256::ZERO, self.negative) {
            (true, _) => 0,
            (false, true) => -1,
            (false, false) => 1,
        }
    }
}

impl Ord for Exact {
    fn cmp(&self, other: &Exact) -> Ordering {
        let sign = self.sign();
        match sign.cmp(&other.sign()) {
            Ordering::Equal if sign == 0 => Ordering::Equal,
            Ordering::Equal => {
                let magnitudes = if self.exponent >= other.exponent {
                    scaled_cmp(self.magnitude, self.exponent - other.exponent, other.magnitude)
                } else {
                    scaled_cmp(other.magnitude, other.exponent - self.exponent, self.magnitude).reverse()
                };
                if sign < 0 { magnitudes.reverse() } else { magnitudes }
            }
            unequal => unequal,
        }
    }
}

impl PartialOrd for Exact {
    fn partial_cmp(&self, other: &Exact) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Exact {
    fn eq(&self, other: &Exact) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Exact {}

fn scaled_cmp(magnitude: U256, tens: i32, other: U256) -> Ordering {
    let mut scaled = magnitude;
    for _ in 0..tens {
        if scaled > other {
            return Ordering::Greater;
        }
        match scaled.times_ten() {
            Some(next) => scaled = next,
            None => return Ordering::Greater,
        }
    }
    scaled.cmp(&other)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct U256 {
    high: u128,
    low: u128,
}

impl U256 {
    const ZERO: U256 = U256 { high: 0, low: 0 };

    fn product(a: u128, b: u128) -> U256 {
        const LOW_HALF: u128 = u64::MAX as u128;
        let (a_high, a_low, b_high, b_low) = (a >> 64, a & LOW_HALF, b >> 64, b & LOW_HALF);
        let (low_low, low_high, high_low, high_high) = (a_low * b_low, a_low * b_high, a_high * b_low, a_high * b_high);
        let middle = (low_low >> 64) + (low_high & LOW_HALF) + (high_low & LOW_HALF);
        U256 { high: high_high + (low_high >> 64) + (high_low >> 64) + (middle >> 64), low: (low_low & LOW_HALF) | (middle << 64) }
    }

    fn times_ten(self) -> Option<U256> {
        let low = U256::product(self.low, 10);
        Some(U256 { high: self.high.checked_mul(10)?.checked_add(low.high)?, low: low.low })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(value: f64) -> Decimal {
        Decimal::of(value).unwrap()
    }

    #[test]
    fn a_decimal_keeps_the_shortest_digits_the_user_typed() {
        assert_eq!(decimal(1.1).times(50), Exact::new(false, 55, 0));
        assert_eq!(decimal(5.6).times(112_500), Exact::new(false, 630_000, 0));
        assert!(decimal(1.1f64.next_up()).times(50) > Exact::new(false, 55, 0));
        assert!(decimal(1.1f64.next_down()).times(50) < Exact::new(false, 55, 0));
        assert_eq!((Decimal::of(f64::NAN), Decimal::of(f64::INFINITY)), (None, None));
    }

    #[test]
    fn products_past_u128_and_far_apart_exponents_compare_exactly() {
        assert_eq!(decimal(1e20).times(u128::MAX), Exact::new(false, u128::MAX, 20));
        assert!(decimal(1e20).times(u128::MAX) > Exact::new(false, u128::MAX - 1, 20));
        assert!(decimal(12_345_678_901_234_568.0).times(u128::MAX) > Exact::new(false, u128::MAX, 16));
        assert!(decimal(12_345_678_901_234_568.0).times(u128::MAX) < Exact::new(false, u128::MAX, 17));
        assert!(decimal(1e300).times(1) > Exact::new(false, u128::MAX, 0));
        assert!(decimal(1e-300).times(u128::MAX) < Exact::new(false, 1, 0));
        assert!(decimal(1e-300).times(1) > Exact::new(false, 0, 0));
    }

    #[test]
    fn shortest_decimals_order_like_the_floats_they_come_from() {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            state
        };
        let exact = |value: f64| decimal(value).times(1);
        for _ in 0..20_000 {
            let percent = 100.0 * (next() >> 11) as f64 / (1u64 << 53) as f64;
            let any = f64::from_bits(next());
            for a in [percent, any].into_iter().filter(|v| v.is_finite()) {
                for b in [a.next_up(), a.next_down(), percent, 30.0, 0.0, -0.0].into_iter().filter(|v| v.is_finite()) {
                    assert_eq!(exact(a).cmp(&exact(b)), a.partial_cmp(&b).unwrap(), "{a:e} vs {b:e}");
                }
            }
        }
    }

    #[test]
    fn signs_order_before_magnitudes_and_negative_zero_is_zero() {
        assert_eq!(decimal(-5.0).times(3), Exact::new(true, 15, 0));
        assert!(decimal(-5.0).times(3) < Exact::new(false, 0, 0));
        assert!(decimal(-1.1).times(100) > Exact::new(true, 111, 0));
        assert_eq!(decimal(-0.0).times(7), Exact::new(false, 0, 0));
        assert_eq!(Exact::new(true, 0, 5), Exact::new(false, 0, -5));
    }
}
