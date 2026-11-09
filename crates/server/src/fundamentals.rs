use domain::{StockCode, Symbol};

use crate::api;
use crate::bars::BarError;
use crate::kiwoom::api::StockBasicInfo;
use crate::kiwoom::rest::{KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::{BasicInfo, parse_basic_info};

pub async fn fundamentals(rest: &KiwoomRest, code: StockCode) -> Result<api::Fundamentals, BarError> {
    let page = rest.call(&StockBasicInfo::new(code), None, Priority::Screen, MergeScope::default()).await?;
    let f = match parse_basic_info(page.body).map_err(|e| BarError::Internal(format!("ka10001 응답을 읽지 못했습니다: {e}")))? {
        BasicInfo::UnknownSymbol => return Err(BarError::UnknownSymbol),
        BasicInfo::Found(f) => f,
    };
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
    })
}
