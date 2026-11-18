use domain::SymbolKind;

pub fn tick_size(price: u64, kind: SymbolKind) -> u64 {
    if kind == SymbolKind::Etf {
        return if price < 2_000 { 1 } else { 5 };
    }
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
}
