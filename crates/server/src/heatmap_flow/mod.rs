mod cache;
mod series;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{Feed, Symbol, Venue};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{KstDate, SymbolCode, UnixSeconds};
use crate::http::{ApiFailure, AppState, Lookup, symbol_list, venue_param};
use crate::quotes::effective_venue;
pub use cache::{FRESH_SECS, FlowCache};
pub use series::{BUCKET_MINUTES, Cell, SymbolDay, group_cells};

pub const REFRESH_SECS: u64 = 60;

pub const MAX_SYMBOLS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeatmapFlowPoint {
    pub t: UnixSeconds,
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeatmapFlowSeries {
    pub date: KstDate,
    pub bucket_minutes: u32,
    pub points: Vec<HeatmapFlowPoint>,
    pub used: Vec<SymbolCode>,
    pub missing: Vec<SymbolCode>,
    pub over_limit: Vec<SymbolCode>,
    pub limit: u32,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/heatmap/flow", get(flow)).layer(Extension(Arc::new(FlowCache::default())))
}

fn code(symbol: Symbol) -> SymbolCode {
    SymbolCode(symbol.as_wire())
}

async fn flow(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<FlowCache>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<HeatmapFlowSeries>, ApiFailure> {
    let raw = q.get("symbols").map_or("", String::as_str);
    let mut symbols: Vec<Symbol> = Vec::new();
    for item in raw.split(',').filter(|s| !s.is_empty()) {
        let symbol = Symbol::parse(item).map_err(|e| ApiFailure::bad_request(format!("{e}: {item}")))?;
        if !symbols.contains(&symbol) {
            symbols.push(symbol);
        }
    }
    if symbols.is_empty() {
        return Err(ApiFailure::bad_request("symbols가 없습니다"));
    }
    let requested = venue_param(&q)?.unwrap_or(Venue::Combined);
    let directory = match requested {
        Venue::Nxt => Some(symbol_list(&st).await?),
        _ => None,
    };
    let over_limit = symbols.split_off(symbols.len().min(MAX_SYMBOLS));
    let feeds: Vec<Feed> = symbols
        .iter()
        .map(|symbol| {
            let venue = match symbol {
                Symbol::Stock(_) => Some(effective_venue(requested, directory.as_deref().and_then(|d| d.get(*symbol)).is_some_and(|info| info.nxt_enabled))),
                Symbol::Index(_) => None,
            };
            Feed::new(*symbol, venue).expect("주식에는 거래소를, 지수에는 주지 않는다")
        })
        .collect();
    let outcomes = futures::future::join_all(feeds.iter().map(|feed| cache.day(&st.bars, &st.clock, *feed))).await;
    let mut days = Vec::new();
    let mut used = Vec::new();
    let mut missing = Vec::new();
    let mut first_error = None;
    for (symbol, outcome) in symbols.iter().zip(outcomes) {
        match outcome {
            Ok(day) => {
                days.push(day);
                used.push(code(*symbol));
            }
            Err(e) => {
                tracing::info!(symbol = %symbol.as_wire(), reason = %e, "히트맵 흐름에서 종목을 뺍니다");
                missing.push(code(*symbol));
                first_error.get_or_insert(e);
            }
        }
    }
    if let Some(e) = first_error.filter(|_| days.is_empty()) {
        return Err(Lookup::Bars.failure(e, st.clock.now()));
    }
    Ok(Json(HeatmapFlowSeries {
        date: KstDate(st.clock.now().kst_date()),
        bucket_minutes: BUCKET_MINUTES,
        points: group_cells(days.iter().map(Arc::as_ref)).into_iter().map(|c| HeatmapFlowPoint { t: UnixSeconds(c.t), rate: c.rate }).collect(),
        used,
        missing,
        over_limit: over_limit.into_iter().map(code).collect(),
        limit: MAX_SYMBOLS as u32,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kiwoom::rest::SEND_SPACING;

    #[test]
    fn the_symbol_limit_costs_at_most_a_third_of_the_refresh_interval_in_kiwoom_calls() {
        assert!(SEND_SPACING * MAX_SYMBOLS as u32 <= std::time::Duration::from_secs(REFRESH_SECS) / 3);
        assert!(FRESH_SECS < REFRESH_SECS as i64);
    }
}
