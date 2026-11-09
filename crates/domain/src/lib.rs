//! 순수 도메인 타입. IO와 시계가 없다. 현재 시각은 언제나 인자로 받는다(backend.md §1).

mod aggregate;
mod bar;
mod period;
mod price;
mod symbol;
mod time;
mod trade;

pub use aggregate::{Aggregator, Applied, CurrentBar, IgnoreReason, SeedBoundary, aggregate};
pub use bar::{BarSource, ConfirmedBar, Ohlcv, OhlcvError, SeriesKey};
pub use period::{Bucket, CLOSE_GRACE_SECS, Period, PeriodError, SESSION_CLOSE, SESSION_OPEN};
pub use price::{Price, Volume};
pub use symbol::{Feed, IndexCode, Market, StockCode, Symbol, SymbolError, SymbolInfo, SymbolKind, Venue};
pub use time::{KstDate, KstTime, TimeOfDay, Weekday};
pub use trade::{TRADING_OPEN, Trade, TradeTimeError, resolve_trade_time};
