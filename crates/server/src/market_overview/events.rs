use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use domain::{StockCode, Symbol};

use super::derived::parse_scope;
use super::dto::{MarketOverviewPart, MarketOverviewScope, MarketOverviewThemesCard, MarketOverviewViCard, MarketOverviewViEvent};
use super::overview_source;
use super::session::{observation_day, phase};
use crate::api::{ApiErrorCode, ApiErrorReason, Broker, Market, SymbolCode, UnixSeconds};
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup};
use crate::kiwoom::api::ViTriggeredStocks;
use crate::kiwoom::rest::{ContKey, MergeScope, Priority};
use crate::kiwoom_themes::{fetch_theme_list, walk_failure_at};
use crate::market_source::SourceFailure;
use crate::shared_data::{ViEventRow, broker_of_part, to_api_broker};
use crate::symbols::Directory;

const MAX_VI_PAGES: usize = 20;

fn matches_scope(market: Market, scope: MarketOverviewScope) -> bool {
    match scope {
        MarketOverviewScope::All => true,
        MarketOverviewScope::Kospi => market == Market::Kospi,
        MarketOverviewScope::Kosdaq => market == Market::Kosdaq,
    }
}

fn api_market(market: domain::Market) -> Market {
    match market {
        domain::Market::Kospi => Market::Kospi,
        domain::Market::Kosdaq => Market::Kosdaq,
    }
}

fn directory_info(directory: Option<&Directory>, code: StockCode) -> (Option<Market>, Option<String>) {
    let Some(info) = directory.and_then(|dir| dir.get(Symbol::Stock(code))) else {
        return (None, None);
    };
    (Some(api_market(info.market)), Some(info.name.clone()))
}

fn row_to_dto(row: &ViEventRow, directory: Option<&Directory>) -> MarketOverviewViEvent {
    let parsed_code = StockCode::parse(&row.code).ok();
    let (dir_market, dir_name) = parsed_code.map_or((None, None), |code| directory_info(directory, code));
    let market = dir_market.unwrap_or(row.market);
    let name = if row.name.is_empty() || row.name == row.code {
        dir_name.unwrap_or_else(|| row.code.clone())
    } else {
        row.name.clone()
    };
    let symbol = parsed_code.map_or_else(|| SymbolCode(row.code.clone()), |code| SymbolCode(Symbol::Stock(code).as_wire()));
    MarketOverviewViEvent {
        code: symbol,
        name,
        market,
        direction: row.direction,
        triggered_at: row.triggered_at.clone(),
        released_at: row.released_at.clone(),
        trigger_price: row.trigger_price,
        static_vi: row.static_vi,
        dynamic_vi: row.dynamic_vi,
        dispersion_rate: row.dispersion_rate,
    }
}

fn unsupported_by_source(feature: &str, now: domain::KstTime) -> crate::api::ApiErrorBody {
    let refusal = SourceFailure {
        code: ApiErrorCode::BadRequest,
        reason: ApiErrorReason::UnsupportedBySource,
        message: format!("지금 쓰는 시세 공급원은 {feature}을(를) 받을 수 없습니다"),
        retry_at: None,
        manual_action_required: false,
    };
    Lookup::MarketOverview.failure(BarError::Source(refusal), now).into_body()
}

pub async fn themes(State(st): State<Arc<AppState>>) -> Result<Json<MarketOverviewThemesCard>, ApiFailure> {
    let now = st.clock.now();
    if st.shared_data.is_enabled() {
        let expected_day = observation_day(now).yyyymmdd();
        let board = st.shared_data.intraday_themes.current().filter(|loaded| loaded.header.observation_date == expected_day);
        let Some(loaded) = board else {
            return Err(ApiFailure::new(ApiErrorCode::NotPrepared, "수집기가 아직 장중 테마 목록을 만들지 않았습니다"));
        };
        let source = broker_of_part(&loaded.header).map_or(Broker::Kiwoom, to_api_broker);
        return Ok(Json(MarketOverviewThemesCard {
            phase: phase(now),
            received_at: Some(UnixSeconds(loaded.header.as_of)),
            source,
            themes: MarketOverviewPart::Ok { value: loaded.body.themes.clone() },
        }));
    }
    if overview_source(&st).broker == Broker::Kis {
        return Ok(Json(MarketOverviewThemesCard {
            phase: phase(now),
            received_at: None,
            source: Broker::Kis,
            themes: MarketOverviewPart::Failed { error: unsupported_by_source("장중 테마 목록", now) },
        }));
    }
    let rest = st.route.kiwoom_rest();
    match fetch_theme_list(&rest, 1, Priority::Screen, now).await {
        Ok(list) => Ok(Json(MarketOverviewThemesCard {
            phase: phase(now),
            received_at: Some(list.fetched_at),
            source: Broker::Kiwoom,
            themes: MarketOverviewPart::Ok { value: list.themes },
        })),
        Err(failure) => Ok(Json(MarketOverviewThemesCard {
            phase: phase(now),
            received_at: None,
            source: Broker::Kiwoom,
            themes: MarketOverviewPart::Failed { error: walk_failure_at(failure, now).into_body() },
        })),
    }
}

pub async fn vi(
    State(st): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<MarketOverviewViCard>, ApiFailure> {
    let scope = parse_scope(&query)?;
    let now = st.clock.now();
    let directory = st.symbols.updates().borrow().clone();
    if st.shared_data.is_enabled() {
        let expected_day = observation_day(now).yyyymmdd();
        let board = st.shared_data.vi_events.current().filter(|loaded| loaded.header.observation_date == expected_day);
        let Some(loaded) = board else {
            return Err(ApiFailure::new(ApiErrorCode::NotPrepared, "수집기가 아직 VI 발동 목록을 만들지 않았습니다"));
        };
        let source = broker_of_part(&loaded.header).map_or(Broker::Kiwoom, to_api_broker);
        let events = loaded
            .body
            .events
            .iter()
            .map(|row| row_to_dto(row, directory.as_deref()))
            .filter(|event| matches_scope(event.market, scope))
            .collect();
        return Ok(Json(MarketOverviewViCard {
            scope,
            phase: phase(now),
            received_at: Some(UnixSeconds(loaded.header.as_of)),
            source,
            events: MarketOverviewPart::Ok { value: events },
        }));
    }
    if overview_source(&st).broker == Broker::Kis {
        return Ok(Json(MarketOverviewViCard {
            scope,
            phase: phase(now),
            received_at: None,
            source: Broker::Kis,
            events: MarketOverviewPart::Failed { error: unsupported_by_source("VI 발동 목록", now) },
        }));
    }
    let rest = st.route.kiwoom_rest();
    let mut rows = Vec::new();
    let mut used: Vec<ContKey> = Vec::new();
    let mut cont: Option<ContKey> = None;
    for _ in 0..MAX_VI_PAGES {
        match rest.call(&ViTriggeredStocks::KRX_TODAY, cont.as_ref(), Priority::Screen, MergeScope::default()).await {
            Ok(page) => {
                rows.extend(page.body.events().rows);
                match page.next {
                    Some(next) if !used.contains(&next) => {
                        used.push(next.clone());
                        cont = Some(next);
                    }
                    _ => break,
                }
            }
            Err(error) => {
                return Ok(Json(MarketOverviewViCard {
                    scope,
                    phase: phase(now),
                    received_at: None,
                    source: Broker::Kiwoom,
                    events: MarketOverviewPart::Failed {
                        error: Lookup::MarketOverview.failure(BarError::from(error), now).into_body(),
                    },
                }));
            }
        }
    }
    rows.sort_by(|a, b| b.triggered.cmp(&a.triggered).then_with(|| a.code.as_str().cmp(b.code.as_str())));
    let events = rows
        .into_iter()
        .filter_map(|event| {
            let (dir_market, dir_name) = directory_info(directory.as_deref(), event.code);
            let market = dir_market.or(event.market).unwrap_or(Market::Kospi);
            if !matches_scope(market, scope) {
                return None;
            }
            let name = if event.name.is_empty() {
                dir_name.unwrap_or_else(|| event.code.as_str().to_owned())
            } else {
                event.name
            };
            Some(MarketOverviewViEvent {
                code: SymbolCode(Symbol::Stock(event.code).as_wire()),
                name,
                market,
                direction: event.direction,
                triggered_at: event.triggered.to_string(),
                released_at: event.released.map(|time| time.to_string()),
                trigger_price: event.trigger_price,
                static_vi: event.static_vi,
                dynamic_vi: event.dynamic_vi,
                dispersion_rate: event.dispersion_rate,
            })
        })
        .collect();
    Ok(Json(MarketOverviewViCard {
        scope,
        phase: phase(now),
        received_at: Some(UnixSeconds(now.unix())),
        source: Broker::Kiwoom,
        events: MarketOverviewPart::Ok { value: events },
    }))
}
