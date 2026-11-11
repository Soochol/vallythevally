use std::num::NonZeroU64;

use domain::Price;

use super::exact::{Decimal, Exact};

const CENTI_EXPONENT: i32 = -2;

#[derive(Debug, Clone, Copy)]
pub(super) struct MarketCapRange {
    pub(super) min: Option<Decimal>,
    pub(super) max: Option<Decimal>,
}

impl MarketCapRange {
    pub(super) fn admits(&self, close: Price, listed_shares: Option<NonZeroU64>) -> bool {
        let Some(shares) = listed_shares else {
            return false;
        };
        let won = Exact::new(false, u128::from(close.centi()) * u128::from(shares.get()), CENTI_EXPONENT);
        self.min.is_none_or(|min| won >= min.times(1)) && self.max.is_none_or(|max| won <= max.times(1))
    }
}
