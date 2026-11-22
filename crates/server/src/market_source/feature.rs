use domain::{Feed, Period, SeriesKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MarketFeature {
    Directory,
    Fundamentals,
    Quotes,
    DayBars,
    WeekBars,
    MonthBars,
    YearBars,
    MinuteBars,
    IndexBars,
    OrderBook,
    Trades,
    ProgramTrades,
}

impl MarketFeature {
    pub const ALL: [MarketFeature; 12] = [
        MarketFeature::Directory,
        MarketFeature::Fundamentals,
        MarketFeature::Quotes,
        MarketFeature::DayBars,
        MarketFeature::WeekBars,
        MarketFeature::MonthBars,
        MarketFeature::YearBars,
        MarketFeature::MinuteBars,
        MarketFeature::IndexBars,
        MarketFeature::OrderBook,
        MarketFeature::Trades,
        MarketFeature::ProgramTrades,
    ];

    pub fn label(self) -> &'static str {
        match self {
            MarketFeature::Directory => "종목 목록",
            MarketFeature::Fundamentals => "종목 기본 정보",
            MarketFeature::Quotes => "현재가",
            MarketFeature::DayBars => "일봉",
            MarketFeature::WeekBars => "주봉",
            MarketFeature::MonthBars => "월봉",
            MarketFeature::YearBars => "연봉",
            MarketFeature::MinuteBars => "분봉",
            MarketFeature::IndexBars => "지수 봉",
            MarketFeature::OrderBook => "호가",
            MarketFeature::Trades => "당일 체결",
            MarketFeature::ProgramTrades => "당일 프로그램매매",
        }
    }

    pub fn for_series(key: SeriesKey) -> impl Iterator<Item = MarketFeature> {
        let period = match key.period {
            Period::Day => MarketFeature::DayBars,
            Period::Week => MarketFeature::WeekBars,
            Period::Month | Period::Quarter => MarketFeature::MonthBars,
            Period::Year => MarketFeature::YearBars,
            Period::M1 | Period::M3 | Period::M5 | Period::M10 | Period::M15 | Period::M30 | Period::M60 => MarketFeature::MinuteBars,
        };
        matches!(key.feed, Feed::Index(_)).then_some(MarketFeature::IndexBars).into_iter().chain([period])
    }

    const fn bit(self) -> u16 {
        1 << self as u16
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MarketFeatures(u16);

impl MarketFeatures {
    pub const NONE: MarketFeatures = MarketFeatures(0);
    pub const ALL: MarketFeatures = MarketFeatures((1 << MarketFeature::ALL.len() as u16) - 1);

    pub fn contains(self, feature: MarketFeature) -> bool {
        self.0 & feature.bit() != 0
    }

    pub fn without(self, feature: MarketFeature) -> MarketFeatures {
        MarketFeatures(self.0 & !feature.bit())
    }

    pub fn with(self, feature: MarketFeature) -> MarketFeatures {
        MarketFeatures(self.0 | feature.bit())
    }

    pub fn iter(self) -> impl Iterator<Item = MarketFeature> {
        MarketFeature::ALL.into_iter().filter(move |f| self.contains(*f))
    }

    pub fn first_missing_for(self, key: SeriesKey) -> Option<MarketFeature> {
        MarketFeature::for_series(key).find(|f| !self.contains(*f))
    }
}
