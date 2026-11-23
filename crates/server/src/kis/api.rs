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
    IndexPrice,
    IndexCategoryPrice,
    InvestorTimeByMarket,
    InvestorDailyByMarket,
    ProgramToday,
    ProgramDaily,
    StockInvestorDaily,
    InvestorEstimate,
    VolumeRank,
    Fluctuation,
    ExpectedUpDown,
    InvestorTotal,
    QuoteBalance,
    CreditBalance,
    HtsTopView,
    OvertimeVolume,
}

impl KisApiId {
    pub const ALL: [KisApiId; 26] = [
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
        KisApiId::IndexPrice,
        KisApiId::IndexCategoryPrice,
        KisApiId::InvestorTimeByMarket,
        KisApiId::InvestorDailyByMarket,
        KisApiId::ProgramToday,
        KisApiId::ProgramDaily,
        KisApiId::StockInvestorDaily,
        KisApiId::InvestorEstimate,
        KisApiId::VolumeRank,
        KisApiId::Fluctuation,
        KisApiId::ExpectedUpDown,
        KisApiId::InvestorTotal,
        KisApiId::QuoteBalance,
        KisApiId::CreditBalance,
        KisApiId::HtsTopView,
        KisApiId::OvertimeVolume,
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
            KisApiId::IndexPrice => "FHPUP02100000",
            KisApiId::IndexCategoryPrice => "FHPUP02140000",
            KisApiId::InvestorTimeByMarket => "FHPTJ04030000",
            KisApiId::InvestorDailyByMarket => "FHPTJ04040000",
            KisApiId::ProgramToday => "FHPPG04600101",
            KisApiId::ProgramDaily => "FHPPG04600001",
            KisApiId::StockInvestorDaily => "FHPTJ04160001",
            KisApiId::InvestorEstimate => "HHPTJ04160200",
            KisApiId::VolumeRank => "FHPST01710000",
            KisApiId::Fluctuation => "FHPST01700000",
            KisApiId::ExpectedUpDown => "FHPST01820000",
            KisApiId::InvestorTotal => "FHPTJ04400000",
            KisApiId::QuoteBalance => "FHPST01720000",
            KisApiId::CreditBalance => "FHKST17010000",
            KisApiId::HtsTopView => "HHMCM000100C0",
            KisApiId::OvertimeVolume => "FHPST02350000",
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
            KisApiId::IndexPrice => "/uapi/domestic-stock/v1/quotations/inquire-index-price",
            KisApiId::IndexCategoryPrice => "/uapi/domestic-stock/v1/quotations/inquire-index-category-price",
            KisApiId::InvestorTimeByMarket => "/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market",
            KisApiId::InvestorDailyByMarket => "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market",
            KisApiId::ProgramToday => "/uapi/domestic-stock/v1/quotations/comp-program-trade-today",
            KisApiId::ProgramDaily => "/uapi/domestic-stock/v1/quotations/comp-program-trade-daily",
            KisApiId::StockInvestorDaily => "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
            KisApiId::InvestorEstimate => "/uapi/domestic-stock/v1/quotations/investor-trend-estimate",
            KisApiId::VolumeRank => "/uapi/domestic-stock/v1/quotations/volume-rank",
            KisApiId::Fluctuation => "/uapi/domestic-stock/v1/ranking/fluctuation",
            KisApiId::ExpectedUpDown => "/uapi/domestic-stock/v1/ranking/exp-trans-updown",
            KisApiId::InvestorTotal => "/uapi/domestic-stock/v1/quotations/foreign-institution-total",
            KisApiId::QuoteBalance => "/uapi/domestic-stock/v1/ranking/quote-balance",
            KisApiId::CreditBalance => "/uapi/domestic-stock/v1/ranking/credit-balance",
            KisApiId::HtsTopView => "/uapi/domestic-stock/v1/ranking/hts-top-view",
            KisApiId::OvertimeVolume => "/uapi/domestic-stock/v1/ranking/overtime-volume",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KisEndpoint {
    Market(KisApiId),
    Trading(crate::trading::KisTradingApiId),
}

impl KisEndpoint {
    pub fn tr_id(self) -> &'static str {
        match self {
            KisEndpoint::Market(api) => api.tr_id(),
            KisEndpoint::Trading(api) => api.tr_id(),
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            KisEndpoint::Market(api) => api.path(),
            KisEndpoint::Trading(api) => api.path(),
        }
    }

    pub fn is_order_write(self) -> bool {
        matches!(self, KisEndpoint::Trading(api) if api.is_order_write())
    }
}

impl From<KisApiId> for KisEndpoint {
    fn from(api: KisApiId) -> Self {
        KisEndpoint::Market(api)
    }
}

impl From<crate::trading::KisTradingApiId> for KisEndpoint {
    fn from(api: crate::trading::KisTradingApiId) -> Self {
        KisEndpoint::Trading(api)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_api_has_a_distinct_tr_id_and_a_domestic_stock_path() {
        let mut seen = std::collections::HashSet::new();
        let mut paths = std::collections::HashSet::new();
        for api in KisApiId::ALL {
            assert!(seen.insert(api.tr_id()), "{api:?}");
            assert!(paths.insert(api.path()), "{api:?}");
            assert!(api.path().starts_with("/uapi/domestic-stock/v1/quotations/") || api.path().starts_with("/uapi/domestic-stock/v1/ranking/"), "{api:?}");
        }
    }
}
