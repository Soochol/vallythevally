use axum::response::Json;
use domain::KstTime;

use super::samples::Sample;
use super::session::observation_day;
use crate::api::{ApiErrorCode, Broker, Market};
use crate::http::{ApiFailure, AppState};
use crate::shared_data::{MarketCards, broker_of_part, to_api_broker};

pub(super) fn answer<T: Clone>(st: &AppState, market: Market, card: &str, pick: impl FnOnce(&MarketCards) -> Option<&T>) -> Option<Result<Json<T>, ApiFailure>> {
    if !st.shared_data.serving() {
        return None;
    }
    let board = st.shared_data.market_overview.current();
    let found = board.as_ref().and_then(|board| pick(board.body.market(market))).cloned();
    Some(found.map(Json).ok_or_else(|| ApiFailure::new(ApiErrorCode::NotPrepared, format!("수집기가 아직 {card}을(를) 만들지 않았습니다"))))
}

pub(super) fn samples(st: &AppState, now: KstTime, market: Market) -> Vec<Sample> {
    let Some(today) = st.shared_data.market_samples.current().filter(|today| today.day == observation_day(now)) else { return Vec::new() };
    let mut samples: Vec<_> = today.samples.iter().filter(|sample| sample.market == market).cloned().collect();
    samples.sort_by_key(|sample| sample.at);
    samples
}

pub(super) fn broker(st: &AppState) -> Broker {
    st.shared_data.market_overview.current().and_then(|board| broker_of_part(&board.header)).map_or_else(|| super::overview_source(st).broker, to_api_broker)
}
