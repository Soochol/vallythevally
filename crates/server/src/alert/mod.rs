pub mod engine;
pub mod format;
pub mod model;
pub mod pipeline;
pub mod sink;
pub mod store;

#[cfg(test)]
mod tests;

pub use engine::{AlertEngine, AlertState, DayAlertStats, DeferredP2, IncidentPhase, IncidentRecord};
pub use format::{FormattedMessage, escape_html, format_duration, render_dispatch};
pub use model::{
    AlertCode, AlertDispatch, AlertEvent, AlertSource, DispatchKind, Fingerprint, MarketContext, MarketObservation, MarketPhase, PolicyRule, Severity, Signal,
};
pub use pipeline::AlertPipeline;
pub use sink::{AlertRouter, AlertSink, MemorySink, RouteRule, TelegramSink};
pub use store::StateStore;
