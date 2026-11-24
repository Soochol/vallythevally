mod bars;
mod cache;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{Period, StockCode, Symbol, Venue};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{ApiErrorCode, KstDate, UnixSeconds};
use crate::http::{ApiFailure, AppState, venue_param};
use crate::quotes::effective_venue;
use crate::shared_data::{MinuteVenue, QuoteDay};
pub use cache::QuoteCache;

pub const MAX_RANGE_DAYS: i64 = 31;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum QuoteDayState {
    Closed,
    Live,
    NotCollected,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuoteDayInfo {
    pub date: KstDate,
    pub state: QuoteDayState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuoteTotalPoint {
    pub t: UnixSeconds,
    #[ts(type = "number")]
    pub ask: i64,
    #[ts(type = "number")]
    pub bid: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuoteTotalsPage {
    pub venue: crate::api::Venue,
    pub days: Vec<QuoteDayInfo>,
    pub points: Vec<QuoteTotalPoint>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum QuoteDepthSource {
    #[default]
    PriceMax,
    Peak,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuoteDepthPoint {
    pub t: UnixSeconds,
    #[ts(type = "[number, number][]")]
    pub asks: Vec<(i64, i64)>,
    #[ts(type = "[number, number][]")]
    pub bids: Vec<(i64, i64)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuoteDepthPage {
    pub venue: crate::api::Venue,
    pub source: QuoteDepthSource,
    pub days: Vec<QuoteDayInfo>,
    pub points: Vec<QuoteDepthPoint>,
}

pub fn routes(cache: Arc<QuoteCache>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/symbols/{code}/quote-totals", get(totals))
        .route("/api/symbols/{code}/quote-depth", get(depth))
        .layer(Extension(cache))
}

struct CommonParams {
    code: StockCode,
    period: Period,
    requested_venue: Venue,
    dates: Vec<domain::KstDate>,
    after: Option<i64>,
}

fn parse_common(code: &str, q: &HashMap<String, String>) -> Result<CommonParams, ApiFailure> {
    let symbol = Symbol::parse(code).map_err(|e| ApiFailure::bad_request(format!("{e}: {code}")))?;
    let Symbol::Stock(stock_code) = symbol else {
        return Err(ApiFailure::bad_request(format!("지수는 분 호가를 지원하지 않습니다: {code}")));
    };
    let period_raw = q.get("period").ok_or_else(|| ApiFailure::bad_request("period가 필요합니다"))?;
    let period = Period::parse(period_raw).map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    if !period.is_intraday() {
        return Err(ApiFailure::bad_request(format!("분봉 주기만 지원합니다: {period_raw}")));
    }
    let requested_venue = venue_param(q)?.unwrap_or(Venue::Combined);
    let from = parse_date(q, "from")?;
    let to = parse_date(q, "to")?;
    if from > to {
        return Err(ApiFailure::bad_request("from은 to보다 늦을 수 없습니다"));
    }
    let span = to.days_since_epoch() - from.days_since_epoch() + 1;
    if span > MAX_RANGE_DAYS {
        return Err(ApiFailure::bad_request(format!("조회 범위는 {MAX_RANGE_DAYS}일까지입니다")));
    }
    let dates = (0..span).map(|offset| from.add_days(offset)).collect();
    let after = q
        .get("after")
        .map(|raw| raw.parse::<i64>().map_err(|_| ApiFailure::bad_request(format!("after는 정수여야 합니다: {raw}"))))
        .transpose()?;
    Ok(CommonParams { code: stock_code, period, requested_venue, dates, after })
}

fn parse_date(q: &HashMap<String, String>, name: &str) -> Result<domain::KstDate, ApiFailure> {
    let raw = q.get(name).ok_or_else(|| ApiFailure::bad_request(format!("{name}가 필요합니다")))?;
    raw.parse::<KstDate>().map(|date| date.0).map_err(ApiFailure::bad_request)
}

fn parse_source(q: &HashMap<String, String>) -> Result<QuoteDepthSource, ApiFailure> {
    match q.get("source").map(String::as_str) {
        None | Some("priceMax") => Ok(QuoteDepthSource::PriceMax),
        Some("peak") => Ok(QuoteDepthSource::Peak),
        Some("close") => Ok(QuoteDepthSource::Close),
        Some(other) => Err(ApiFailure::bad_request(format!("source는 priceMax, peak, close 중 하나입니다: {other}"))),
    }
}

fn resolve_venue(st: &AppState, code: StockCode, requested: Venue) -> Venue {
    if requested != Venue::Nxt {
        return requested;
    }
    let Some(directory) = st.symbols.updates().borrow().clone() else {
        return requested;
    };
    let nxt_enabled = directory.get(Symbol::Stock(code)).is_some_and(|info| info.nxt_enabled);
    effective_venue(requested, nxt_enabled)
}

fn minute_venue(venue: Venue) -> MinuteVenue {
    match venue {
        Venue::Krx => MinuteVenue::Krx,
        Venue::Nxt => MinuteVenue::Nxt,
        Venue::Combined => MinuteVenue::Combined,
    }
}

fn internal_error(context: &str, detail: impl std::fmt::Display) -> ApiFailure {
    tracing::error!(reason = %detail, "{context}");
    ApiFailure::new(ApiErrorCode::Internal, context)
}

struct PreparedDays {
    venue: Venue,
    days: Vec<QuoteDayInfo>,
    inputs: Vec<(domain::KstDate, Arc<QuoteDay>)>,
}

async fn load_days(st: &AppState, cache: &QuoteCache, params: &CommonParams) -> Result<PreparedDays, ApiFailure> {
    let venue = resolve_venue(st, params.code, params.requested_venue);
    let Some(dir) = st.shared_data.dir().or_else(|| cache.fallback_dir()) else {
        let days = params.dates.iter().map(|&date| QuoteDayInfo { date: KstDate(date), state: QuoteDayState::None }).collect();
        return Ok(PreparedDays { venue, days, inputs: Vec::new() });
    };
    let loaded = cache
        .load_range(dir, params.code.as_str(), &params.dates, &st.clock)
        .await
        .map_err(|e| internal_error("분 호가를 읽지 못했습니다", e))?;
    let mut days = Vec::with_capacity(loaded.len());
    let mut inputs = Vec::new();
    for item in loaded {
        days.push(QuoteDayInfo { date: KstDate(item.date), state: item.state });
        if let Some(day) = item.day {
            inputs.push((item.date, day));
        }
    }
    Ok(PreparedDays { venue, days, inputs })
}

async fn totals(
    State(st): State<Arc<AppState>>,
    Extension(cache): Extension<Arc<QuoteCache>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<QuoteTotalsPage>, ApiFailure> {
    let params = parse_common(&code, &q)?;
    let PreparedDays { venue, days, inputs } = load_days(&st, &cache, &params).await?;
    let now = st.clock.now();
    let mv = minute_venue(venue);
    let period = params.period;
    let after = params.after;
    let points = if inputs.is_empty() {
        Vec::new()
    } else {
        tokio::task::spawn_blocking(move || {
            let mut points = Vec::new();
            for (date, day) in inputs {
                points.extend(bars::total_points(date, &day, period, mv, now, after));
            }
            points
        })
        .await
        .map_err(|e| internal_error("분 호가 집계 작업이 멈췄습니다", e))?
    };
    Ok(Json(QuoteTotalsPage { venue: venue.into(), days, points }))
}

async fn depth(
    State(st): State<Arc<AppState>>,
    Extension(cache): Extension<Arc<QuoteCache>>,
    Path(code): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<QuoteDepthPage>, ApiFailure> {
    let params = parse_common(&code, &q)?;
    let source = parse_source(&q)?;
    let PreparedDays { venue, days, inputs } = load_days(&st, &cache, &params).await?;
    let now = st.clock.now();
    let mv = minute_venue(venue);
    let period = params.period;
    let after = params.after;
    let points = if inputs.is_empty() {
        Vec::new()
    } else {
        tokio::task::spawn_blocking(move || {
            let mut points = Vec::new();
            for (date, day) in inputs {
                points.extend(bars::depth_points(date, &day, period, mv, source, now, after));
            }
            points
        })
        .await
        .map_err(|e| internal_error("분 호가 집계 작업이 멈췄습니다", e))?
    };
    Ok(Json(QuoteDepthPage { venue: venue.into(), source, days, points }))
}
