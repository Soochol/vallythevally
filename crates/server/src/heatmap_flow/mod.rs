mod cache;
mod series;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{Feed, KstTime, Symbol, Venue};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{KstDate, SymbolCode, UnixSeconds};
use crate::http::{ApiFailure, AppState, Lookup, symbol_list, venue_param};
use crate::quotes::effective_venue;
pub use crate::heatmap_board::{Busy, Refused};
pub use cache::{DayError, FRESH_SECS, FlowCache, Freshness, Origin, Rolling};
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<SymbolCode>>", optional)]
    pub not_in_themes: Vec<SymbolCode>,
    pub limit: u32,
}

pub trait FlowGate: Freshness {
    fn begin(&self) -> Result<Box<dyn Send>, Busy>;
    fn fetch_concurrency(&self) -> usize;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FlowTally {
    pub cached: u32,
    pub fetched: u32,
    pub over_budget: u32,
    pub rejected: u32,
}

pub fn routes(cache: Arc<FlowCache>) -> Router<Arc<AppState>> {
    Router::new().route("/api/heatmap/flow", get(flow)).layer(Extension(cache))
}

fn code(symbol: Symbol) -> SymbolCode {
    SymbolCode(symbol.as_wire())
}

fn parse_symbols(q: &HashMap<String, String>) -> Result<Vec<Symbol>, ApiFailure> {
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
    Ok(symbols)
}

async fn feeds_of(st: &AppState, symbols: &[Symbol], requested: Venue) -> Result<Vec<Feed>, ApiFailure> {
    let directory = match requested {
        Venue::Nxt => Some(symbol_list(st).await?),
        _ => None,
    };
    Ok(symbols
        .iter()
        .map(|symbol| {
            let venue = match symbol {
                Symbol::Stock(_) => Some(effective_venue(requested, directory.as_deref().and_then(|d| d.get(*symbol)).is_some_and(|info| info.nxt_enabled))),
                Symbol::Index(_) => None,
            };
            Feed::new(*symbol, venue).expect("주식에는 거래소를, 지수에는 주지 않는다")
        })
        .collect())
}

struct Outcomes {
    days: Vec<Arc<series::SymbolDay>>,
    used: Vec<SymbolCode>,
    missing: Vec<SymbolCode>,
    first_error: Option<crate::bars::BarError>,
}

fn sorted_outcomes(symbols: &[Symbol], outcomes: Vec<Result<Arc<series::SymbolDay>, DayError>>) -> Outcomes {
    let mut sorted = Outcomes { days: Vec::new(), used: Vec::new(), missing: Vec::new(), first_error: None };
    for (symbol, outcome) in symbols.iter().zip(outcomes) {
        match outcome {
            Ok(day) => {
                sorted.days.push(day);
                sorted.used.push(code(*symbol));
            }
            Err(DayError::OutOfBudget) => sorted.missing.push(code(*symbol)),
            Err(DayError::Bars(e)) => {
                tracing::info!(symbol = %symbol.as_wire(), reason = %e, "히트맵 흐름에서 종목을 뺍니다");
                sorted.missing.push(code(*symbol));
                sorted.first_error.get_or_insert(e);
            }
        }
    }
    sorted
}

fn series_of(st: &AppState, sorted: Outcomes, over_limit: Vec<Symbol>, not_in_themes: Vec<Symbol>) -> Result<HeatmapFlowSeries, ApiFailure> {
    let Outcomes { days, used, missing, first_error } = sorted;
    if let Some(e) = first_error.filter(|_| days.is_empty()) {
        return Err(Lookup::Bars.failure(e, st.clock.now()));
    }
    Ok(HeatmapFlowSeries {
        date: KstDate(st.clock.now().kst_date()),
        bucket_minutes: BUCKET_MINUTES,
        points: group_cells(days.iter().map(Arc::as_ref)).into_iter().map(|c| HeatmapFlowPoint { t: UnixSeconds(c.t), rate: c.rate }).collect(),
        used,
        missing,
        over_limit: over_limit.into_iter().map(code).collect(),
        not_in_themes: not_in_themes.into_iter().map(code).collect(),
        limit: MAX_SYMBOLS as u32,
    })
}

async fn flow(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<FlowCache>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<HeatmapFlowSeries>, ApiFailure> {
    let mut symbols = parse_symbols(&q)?;
    let requested = venue_param(&q)?.unwrap_or(Venue::Combined);
    let over_limit = symbols.split_off(symbols.len().min(MAX_SYMBOLS));
    let feeds = feeds_of(&st, &symbols, requested).await?;
    let outcomes = futures::future::join_all(feeds.iter().map(|feed| cache.day(&st.bars, &st.clock, *feed))).await;
    let outcomes = outcomes.into_iter().map(|outcome| outcome.map_err(DayError::Bars)).collect();
    Ok(Json(series_of(&st, sorted_outcomes(&symbols, outcomes), over_limit, Vec::new())?))
}

pub async fn flow_within(st: &AppState, cache: &FlowCache, q: &HashMap<String, String>, allowed: &HashSet<Symbol>, gate: &dyn FlowGate) -> Result<(HeatmapFlowSeries, FlowTally), Refused> {
    let requested_symbols = parse_symbols(q).map_err(Refused::Failed)?;
    let requested = venue_param(q).map_err(Refused::Failed)?.unwrap_or(Venue::Combined);
    let (mut symbols, not_in_themes): (Vec<Symbol>, Vec<Symbol>) = requested_symbols.into_iter().partition(|symbol| allowed.contains(symbol));
    let over_limit = symbols.split_off(symbols.len().min(MAX_SYMBOLS));
    let feeds = feeds_of(st, &symbols, requested).await.map_err(Refused::Failed)?;
    let wanted_fetch = cache.stale_count(&feeds, st.clock.now(), gate) > 0;
    let _held = if wanted_fetch { Some(gate.begin().map_err(|_| Refused::Busy)?) } else { None };
    let fetched: Vec<_> = futures::stream::iter(feeds.iter().copied())
        .map(|feed| cache.day_by(&st.bars, &st.clock, feed, gate))
        .buffered(gate.fetch_concurrency().max(1))
        .collect()
        .await;
    let mut tally = FlowTally { rejected: not_in_themes.len() as u32, ..FlowTally::default() };
    let outcomes = fetched
        .into_iter()
        .map(|outcome| match outcome {
            Ok((day, Origin::Cached)) => {
                tally.cached += 1;
                Ok(day)
            }
            Ok((day, Origin::Fetched)) => {
                tally.fetched += 1;
                Ok(day)
            }
            Err(DayError::OutOfBudget) => {
                tally.over_budget += 1;
                Err(DayError::OutOfBudget)
            }
            Err(e) => Err(e),
        })
        .collect();
    let series = series_of(st, sorted_outcomes(&symbols, outcomes), over_limit, not_in_themes).map_err(Refused::Failed)?;
    Ok((series, tally))
}

pub fn same_kst_minute(fetched_at: KstTime, now: KstTime) -> bool {
    fetched_at.unix().div_euclid(60) == now.unix().div_euclid(60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kiwoom::rest::same_tr_burst_duration;

    #[test]
    fn the_symbol_limit_costs_at_most_a_third_of_the_refresh_interval_in_kiwoom_calls() {
        assert!(same_tr_burst_duration(MAX_SYMBOLS) <= std::time::Duration::from_secs(REFRESH_SECS) / 3);
        assert!(FRESH_SECS < REFRESH_SECS as i64);
    }
}
