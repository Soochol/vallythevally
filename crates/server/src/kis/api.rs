#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KisApiId {
    CurrentPrice,
    MultiPrice,
    DailyChart,
    TodayMinuteChart,
    PastMinuteChart,
    IndexChart,
    IndexMinuteChart,
    OrderBook,
    TodayTrades,
    ProgramTrades,
}

impl KisApiId {
    pub const ALL: [KisApiId; 10] = [
        KisApiId::CurrentPrice,
        KisApiId::MultiPrice,
        KisApiId::DailyChart,
        KisApiId::TodayMinuteChart,
        KisApiId::PastMinuteChart,
        KisApiId::IndexChart,
        KisApiId::IndexMinuteChart,
        KisApiId::OrderBook,
        KisApiId::TodayTrades,
        KisApiId::ProgramTrades,
    ];

    pub fn tr_id(self) -> &'static str {
        match self {
            KisApiId::CurrentPrice => "FHKST01010100",
            KisApiId::MultiPrice => "FHKST11300006",
            KisApiId::DailyChart => "FHKST03010100",
            KisApiId::TodayMinuteChart => "FHKST03010200",
            KisApiId::PastMinuteChart => "FHKST03010230",
            KisApiId::IndexChart => "FHKUP03500100",
            KisApiId::IndexMinuteChart => "FHKUP03500200",
            KisApiId::OrderBook => "FHKST01010200",
            KisApiId::TodayTrades => "FHPST01060000",
            KisApiId::ProgramTrades => "FHPPG04650101",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            KisApiId::CurrentPrice => "/uapi/domestic-stock/v1/quotations/inquire-price",
            KisApiId::MultiPrice => "/uapi/domestic-stock/v1/quotations/intstock-multprice",
            KisApiId::DailyChart => "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
            KisApiId::TodayMinuteChart => "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
            KisApiId::PastMinuteChart => "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice",
            KisApiId::IndexChart => "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",
            KisApiId::IndexMinuteChart => "/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice",
            KisApiId::OrderBook => "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
            KisApiId::TodayTrades => "/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion",
            KisApiId::ProgramTrades => "/uapi/domestic-stock/v1/quotations/program-trade-by-stock",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_api_has_a_distinct_tr_id_and_a_quotation_path() {
        let mut seen = std::collections::HashSet::new();
        let mut paths = std::collections::HashSet::new();
        for api in KisApiId::ALL {
            assert!(seen.insert(api.tr_id()), "{api:?}");
            assert!(paths.insert(api.path()), "{api:?}");
            assert!(api.path().starts_with("/uapi/domestic-stock/v1/quotations/"), "{api:?}");
        }
    }
}
