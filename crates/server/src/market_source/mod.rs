pub mod active;
pub mod control;
mod error;
mod feature;
mod generation;
mod kiwoom_handle;
pub mod link;
mod overview;
pub mod route;
pub mod status;
pub mod switch;
pub mod rankings;
pub mod stream;
pub mod vi;
mod types;

#[cfg(test)]
mod tests;

use domain::{KstDate, SeriesKey, StockCode, Venue};
use futures::future::BoxFuture;

pub use error::{SourceError, SourceFailure};
pub use feature::{MarketFeature, MarketFeatures};
pub use generation::{GenerationScoped, GenerationTicket, SourceGeneration};
pub use kiwoom_handle::KiwoomHandle;
pub use overview::*;
pub use types::{
    ChartPage, Cursor, DaySummary, MergeScope, OrderBookSnapshot, PeriodBar, Priority, QuoteRow, ScreenerListing, StockFundamentals, TapePage,
};

use crate::api;
use crate::symbols::Directory;

pub trait MarketSource: Send + Sync + 'static {
    fn features(&self) -> MarketFeatures;

    fn outage(&self) -> Option<SourceError>;
    fn list_outage(&self) -> Option<SourceError>;
    fn until_outage(&self) -> BoxFuture<'_, SourceError>;
    fn until_list_outage(&self) -> BoxFuture<'_, SourceError>;

    fn directory(&self, priority: Priority) -> BoxFuture<'_, Result<Directory, SourceError>>;
    fn fundamentals(&self, code: StockCode, priority: Priority) -> BoxFuture<'_, Result<Option<StockFundamentals>, SourceError>>;
    fn quotes(&self, rows: Vec<(StockCode, Venue)>, priority: Priority) -> BoxFuture<'_, Result<Vec<QuoteRow>, SourceError>>;
    fn day_summary(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<DaySummary, SourceError>>;
    fn chart_page(&self, key: SeriesKey, base: KstDate, cursor: Option<Cursor>, priority: Priority, scope: MergeScope) -> BoxFuture<'_, Result<ChartPage, SourceError>>;
    fn order_book(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<OrderBookSnapshot, SourceError>>;
    fn trades_page(&self, code: StockCode, venue: Venue, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::TradePrint>, SourceError>>;
    fn program_trades_page(&self, code: StockCode, today: KstDate, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::ProgramTradePoint>, SourceError>>;
    fn supports_past_program_trades(&self) -> bool {
        false
    }
}

impl dyn MarketSource {
    pub fn requires(&self, feature: MarketFeature) -> Result<(), crate::bars::BarError> {
        if self.features().contains(feature) { Ok(()) } else { Err(crate::bars::BarError::Unsupported(feature)) }
    }
}
