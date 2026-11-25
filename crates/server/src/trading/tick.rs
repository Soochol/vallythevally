use domain::SymbolKind;

pub fn tick_size(price: u64, kind: SymbolKind) -> u64 {
    match kind {
        SymbolKind::Etf | SymbolKind::Etn => etf_tick_size(price),
        SymbolKind::Index | SymbolKind::Common | SymbolKind::Preferred | SymbolKind::Reit | SymbolKind::Infrastructure | SymbolKind::MutualFund => stock_tick_size(price),
    }
}

fn etf_tick_size(price: u64) -> u64 {
    if price < 2_000 { 1 } else { 5 }
}

fn stock_tick_size(price: u64) -> u64 {
    match price {
        0..2_000 => 1,
        2_000..5_000 => 5,
        5_000..20_000 => 10,
        20_000..50_000 => 50,
        50_000..200_000 => 100,
        200_000..500_000 => 500,
        _ => 1_000,
    }
}

pub fn is_on_tick(price: u64, kind: SymbolKind) -> bool {
    price.is_multiple_of(tick_size(price, kind))
}

const ETF_BANDS: &[(u64, u64, u64)] = &[
    (0, 2_000, 1),
    (2_000, u64::MAX, 5),
];

const STOCK_BANDS: &[(u64, u64, u64)] = &[
    (0, 2_000, 1),
    (2_000, 5_000, 5),
    (5_000, 20_000, 10),
    (20_000, 50_000, 50),
    (50_000, 200_000, 100),
    (200_000, 500_000, 500),
    (500_000, u64::MAX, 1_000),
];

pub fn signed_tick_diff(from_price: u64, to_price: u64, kind: SymbolKind) -> i64 {
    if from_price == to_price {
        return 0;
    }
    if to_price < from_price {
        return -signed_tick_diff(to_price, from_price, kind);
    }
    let bands = match kind {
        SymbolKind::Etf | SymbolKind::Etn => ETF_BANDS,
        SymbolKind::Index | SymbolKind::Common | SymbolKind::Preferred | SymbolKind::Reit | SymbolKind::Infrastructure | SymbolKind::MutualFund => STOCK_BANDS,
    };
    let mut ticks = 0.0f64;
    for &(lo, hi, step) in bands {
        let start = from_price.max(lo);
        let end = to_price.min(hi);
        if start < end {
            ticks += (end - start) as f64 / step as f64;
        }
    }
    ticks.round() as i64
}

pub fn slippage_ticks(side: crate::api::OrderSide, intended_price: u64, fill_price: u64, kind: SymbolKind) -> i64 {
    match side {
        crate::api::OrderSide::Buy => signed_tick_diff(intended_price, fill_price, kind),
        crate::api::OrderSide::Sell => signed_tick_diff(fill_price, intended_price, kind),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stock_ticks_change_at_each_band_edge() {
        for (price, tick) in [(1_999, 1), (2_000, 5), (4_995, 5), (5_000, 10), (19_990, 10), (20_000, 50), (49_950, 50), (50_000, 100), (199_900, 100), (200_000, 500), (499_500, 500), (500_000, 1_000), (1_000_000, 1_000)] {
            assert_eq!(tick_size(price, SymbolKind::Common), tick, "{price}");
        }
        assert!(is_on_tick(71_000, SymbolKind::Common));
        assert!(!is_on_tick(71_050, SymbolKind::Common));
        assert!(!is_on_tick(70_999, SymbolKind::Preferred));
    }

    #[test]
    fn etf_ticks_are_five_won_from_two_thousand() {
        assert_eq!(tick_size(1_999, SymbolKind::Etf), 1);
        assert_eq!(tick_size(12_345, SymbolKind::Etf), 5);
        assert!(!is_on_tick(12_343, SymbolKind::Etf));
        assert!(is_on_tick(12_345, SymbolKind::Etf));
    }

    #[test]
    fn etn_ticks_follow_the_etf_table() {
        for (price, tick) in [(1_999, 1), (2_000, 5), (6_465, 5), (12_345, 5), (600_000, 5)] {
            assert_eq!(tick_size(price, SymbolKind::Etn), tick, "{price}");
        }
        assert!(is_on_tick(6_465, SymbolKind::Etn));
        assert!(!is_on_tick(6_463, SymbolKind::Etn));
    }

    #[test]
    fn infrastructure_mutual_fund_and_reit_ticks_follow_the_stock_table() {
        for kind in [SymbolKind::Infrastructure, SymbolKind::MutualFund, SymbolKind::Reit] {
            for price in [1_999, 2_000, 6_465, 12_345, 71_050, 600_000] {
                assert_eq!(tick_size(price, kind), tick_size(price, SymbolKind::Common), "{kind:?} {price}");
            }
            assert!(!is_on_tick(12_345, kind));
            assert!(is_on_tick(12_340, kind));
        }
    }

    #[test]
    fn signed_tick_diff_and_slippage_handle_band_boundaries() {
        assert_eq!(signed_tick_diff(70_000, 70_300, SymbolKind::Common), 3);
        assert_eq!(signed_tick_diff(70_300, 70_000, SymbolKind::Common), -3);
        assert_eq!(signed_tick_diff(49_900, 50_200, SymbolKind::Common), 4);
        assert_eq!(signed_tick_diff(1_998, 2_010, SymbolKind::Etf), 4);
        assert_eq!(slippage_ticks(crate::api::OrderSide::Buy, 70_000, 70_200, SymbolKind::Common), 2);
        assert_eq!(slippage_ticks(crate::api::OrderSide::Buy, 70_200, 70_000, SymbolKind::Common), -2);
        assert_eq!(slippage_ticks(crate::api::OrderSide::Sell, 70_200, 70_000, SymbolKind::Common), 2);
        assert_eq!(slippage_ticks(crate::api::OrderSide::Sell, 70_000, 70_200, SymbolKind::Common), -2);
    }
}
