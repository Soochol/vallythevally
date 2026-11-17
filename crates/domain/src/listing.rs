use crate::symbol::{Market, StockCode, Symbol, SymbolInfo, SymbolKind};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListingRow {
    pub code: String,
    pub name: String,
    pub market_code: String,
    pub company_class_name: String,
    pub nxt_enable: String,
    pub reg_day: String,
    pub audit_info: String,
    pub list_count: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listing {
    Include(SymbolInfo),
    Exclude,
    Unknown(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditStatus {
    Normal,
    Managed,
    InvestmentCautionAlert,
    InvestmentWarning,
    InvestmentDanger,
    InvestmentCaution,
    ShortTermOverheated,
    TradingHalted,
    Unknown,
}

impl AuditStatus {
    pub fn parse(label: &str) -> AuditStatus {
        match label {
            "정상" | "" => AuditStatus::Normal,
            "관리종목" => AuditStatus::Managed,
            "투자주의환기종목" => AuditStatus::InvestmentCautionAlert,
            "투자경고" => AuditStatus::InvestmentWarning,
            "투자위험" => AuditStatus::InvestmentDanger,
            "투자주의" => AuditStatus::InvestmentCaution,
            "단기과열" => AuditStatus::ShortTermOverheated,
            "거래정지" => AuditStatus::TradingHalted,
            _ => AuditStatus::Unknown,
        }
    }
}

impl ListingRow {
    pub fn is_spac(&self) -> bool {
        self.company_class_name == "스팩" || self.name.contains("스팩") || self.name.contains("기업인수목적")
    }

    pub fn audit_statuses(&self) -> impl Iterator<Item = (&str, AuditStatus)> {
        self.audit_info.split('|').map(str::trim).map(|label| (label, AuditStatus::parse(label)))
    }

    pub fn is_trading_halted(&self) -> bool {
        self.audit_statuses().any(|(_, status)| status == AuditStatus::TradingHalted)
    }
}

pub fn classify(row: &ListingRow) -> Listing {
    let Ok(code) = StockCode::parse(&row.code) else {
        return Listing::Unknown(format!("종목코드 형식이 아닙니다: {:?}", row.code));
    };
    let stock_kind = |code: StockCode| if code.is_preferred_code() { SymbolKind::Preferred } else { SymbolKind::Common };
    let (kind, market) = match row.market_code.as_str() {
        "0" => (stock_kind(code), Market::Kospi),
        "8" => (SymbolKind::Etf, Market::Kospi),
        "6" => (SymbolKind::Reit, Market::Kospi),
        "10" if row.is_spac() => (SymbolKind::Common, Market::Kosdaq),
        "10" => (stock_kind(code), Market::Kosdaq),
        "60" | "70" | "90" | "2" | "4" => return Listing::Exclude,
        other => return Listing::Unknown(format!("모르는 marketCode {other:?}({} {})", row.code, row.name)),
    };
    Listing::Include(SymbolInfo { symbol: Symbol::Stock(code), name: row.name.clone(), kind, market, nxt_enabled: row.nxt_enable == "Y" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(code: &str, market_code: &str) -> ListingRow {
        ListingRow { code: code.into(), name: "가상".into(), market_code: market_code.into(), ..Default::default() }
    }

    fn included(row: &ListingRow) -> (SymbolKind, Market) {
        match classify(row) {
            Listing::Include(info) => {
                assert_eq!(info.name, row.name);
                (info.kind, info.market)
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn each_market_code_of_the_table_is_sorted_to_its_kind_and_market() {
        use {Market::*, SymbolKind::*};
        assert_eq!(included(&row("005930", "0")), (Common, Kospi));
        assert_eq!(included(&row("000020", "0")), (Common, Kospi));
        assert_eq!(included(&row("0000D0", "8")), (Etf, Kospi));
        assert_eq!(included(&row("0030R0", "6")), (Reit, Kospi));
        assert_eq!(included(&row("247540", "10")), (Common, Kosdaq));
    }

    #[test]
    fn a_preferred_code_makes_a_preferred_stock_on_either_market() {
        use {Market::*, SymbolKind::*};
        assert_eq!(included(&row("005935", "0")), (Preferred, Kospi));
        assert_eq!(included(&row("02826K", "0")), (Preferred, Kospi));
        assert_eq!(included(&row("03481K", "10")), (Preferred, Kosdaq));
    }

    #[test]
    fn a_spac_is_a_kosdaq_common_stock_even_with_a_preferred_looking_code() {
        use {Market::*, SymbolKind::*};
        let by_name = ListingRow { name: "가나스팩".into(), ..row("12345K", "10") };
        let by_purpose = ListingRow { name: "가나기업인수목적1호".into(), ..row("12345K", "10") };
        let by_class = ListingRow { company_class_name: "스팩".into(), ..row("12345K", "10") };
        for spac in [by_name, by_purpose, by_class] {
            assert!(spac.is_spac());
            assert_eq!(included(&spac), (Common, Kosdaq));
        }
        assert!(!row("12345K", "10").is_spac());
        let near_miss = ListingRow { name: "가나기업인수".into(), ..row("12345K", "10") };
        assert!(!near_miss.is_spac());
    }

    #[test]
    fn products_left_out_on_purpose_are_excluded() {
        for market_code in ["60", "70", "90", "2", "4"] {
            assert_eq!(classify(&row("088980", market_code)), Listing::Exclude, "{market_code}");
        }
    }

    #[test]
    fn an_unknown_market_code_or_a_malformed_code_is_reported_not_included() {
        let Listing::Unknown(why) = classify(&row("123450", "77")) else { panic!() };
        assert!(why.contains("77") && why.contains("123450"), "{why}");
        for code in ["", "12345", "1234567", "12345a", "12 450"] {
            let Listing::Unknown(why) = classify(&row(code, "0")) else { panic!("{code:?}") };
            assert!(why.contains("종목코드") && why.contains(code), "{why}");
        }
        assert!(matches!(classify(&row("005930", "")), Listing::Unknown(_)));
    }

    #[test]
    fn nxt_enable_y_marks_a_stock_tradable_on_nxt() {
        let nxt = |flag: &str| match classify(&ListingRow { nxt_enable: flag.into(), ..row("005930", "0") }) {
            Listing::Include(info) => info.nxt_enabled,
            other => panic!("{other:?}"),
        };
        assert_eq!([nxt("Y"), nxt("N"), nxt("")], [true, false, false]);
    }

    #[test]
    fn each_audit_label_parses_to_its_status() {
        use AuditStatus::*;
        let cases = [
            ("정상", Normal),
            ("", Normal),
            ("관리종목", Managed),
            ("투자주의환기종목", InvestmentCautionAlert),
            ("투자경고", InvestmentWarning),
            ("투자위험", InvestmentDanger),
            ("투자주의", InvestmentCaution),
            ("단기과열", ShortTermOverheated),
            ("거래정지", TradingHalted),
            ("신종상태", Unknown),
        ];
        for (label, want) in cases {
            assert_eq!(AuditStatus::parse(label), want, "{label:?}");
        }
    }

    #[test]
    fn audit_info_joined_by_a_bar_yields_every_status_in_order() {
        let audited = ListingRow { audit_info: "투자주의 | 단기과열|신종상태|".into(), ..row("005930", "0") };
        let statuses: Vec<_> = audited.audit_statuses().collect();
        assert_eq!(
            statuses,
            [("투자주의", AuditStatus::InvestmentCaution), ("단기과열", AuditStatus::ShortTermOverheated), ("신종상태", AuditStatus::Unknown), ("", AuditStatus::Normal)],
        );
    }

    #[test]
    fn a_halted_stock_is_found_among_other_statuses_and_a_normal_one_is_not() {
        let halted = |audit_info: &str| ListingRow { audit_info: audit_info.into(), ..row("005930", "0") }.is_trading_halted();
        assert_eq!([halted("거래정지"), halted("관리종목|거래정지"), halted("거래정지|투자경고")], [true; 3]);
        assert_eq!([halted(""), halted("정상"), halted("관리종목|투자경고"), halted("거래정지아님")], [false; 4]);
    }
}
