use domain::{StockCode, Symbol};

use crate::api;
use crate::bars::BarError;
use crate::market_source::{MarketFeature, MarketSource, Priority};

pub async fn fundamentals(source: &dyn MarketSource, code: StockCode) -> Result<api::Fundamentals, BarError> {
    source.requires(MarketFeature::Fundamentals)?;
    let f = source.fundamentals(code, Priority::Screen).await?.ok_or(BarError::UnknownSymbol)?;
    Ok(api::Fundamentals {
        symbol: api::SymbolCode(Symbol::Stock(code).as_wire()),
        market_cap: f.market_cap_won,
        listed_shares: f.listed_shares,
        per: f.per,
        pbr: f.pbr,
        roe: f.roe_pct,
        eps: f.eps_won,
        bps: f.bps_won,
        foreign_exhaustion_rate: f.foreign_exhaustion_pct,
        high52w: f.high_250_won,
        low52w: f.low_250_won,
        upper_limit: f.upper_limit_won,
        lower_limit: f.lower_limit_won,
    })
}
