use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use domain::{KstDate, KstTime, Price, StockCode, Weekday};

use super::broker_book::build_broker_book;
use super::derived::{StockCatalog, not_prepared, parse_scope};
use super::disclosures::build_disclosure_radar;
use super::dto::{MarketOverviewPart, MarketOverviewPhase, MarketOverviewProCard, MarketOverviewScope};
use super::rrg::{RrgInputs, build_rrg};
use super::samples::Sample;
use super::session::{observation_day, phase};
use super::session_dna::build_session_dna;
use super::shared;
use crate::api::{Market, UnixSeconds};
use crate::financials::store::SecurityDisclosures;
use crate::http::{ApiFailure, AppState};
use crate::kiwoom_themes::{StoredCatalog, StoredTheme};
use crate::shared_data::{IntradayThemesBody, Loaded, MergedRankings, OverviewBody, SnapshotBody};

pub struct ProInputs<'a> {
    pub now: KstTime,
    pub scope: MarketOverviewScope,
    pub phase: MarketOverviewPhase,
    pub combined: Option<&'a Loaded<SnapshotBody>>,
    pub krx: Option<&'a Loaded<SnapshotBody>>,
    pub nxt: Option<&'a Loaded<SnapshotBody>>,
    pub overview_board: Option<&'a Loaded<OverviewBody>>,
    pub intraday_themes: Option<&'a Loaded<IntradayThemesBody>>,
    pub themes_catalog: Option<&'a StoredCatalog>,
    pub rankings: Option<&'a MergedRankings>,
    pub samples: &'a [Sample],
    pub disclosures: Option<&'a [SecurityDisclosures]>,
    pub catalog: &'a StockCatalog,
    pub closes: &'a HashMap<StockCode, Vec<(KstDate, Price)>>,
    pub latest_day: Option<KstDate>,
    pub trading_days: &'a [KstDate],
}

fn live_rates_of(combined: Option<&Loaded<SnapshotBody>>, latest_day: Option<KstDate>) -> HashMap<StockCode, f64> {
    let Some(loaded) = combined else {
        return HashMap::new();
    };
    if let (Some(snapshot_day), Some(last)) = (KstDate::parse_yyyymmdd(&loaded.header.observation_date), latest_day)
        && snapshot_day < last
    {
        return HashMap::new();
    }
    let mut rates = HashMap::with_capacity(loaded.body.stocks.len());
    for row in &loaded.body.stocks {
        if row.base_won == 0 || row.current_won == 0 {
            continue;
        }
        if let Ok(code) = StockCode::parse(&row.code) {
            let rate = (row.current_won as f64 - row.base_won as f64) / row.base_won as f64 * 100.0;
            if rate.is_finite() {
                rates.insert(code, rate);
            }
        }
    }
    rates
}

fn latest_received_at(inputs: &ProInputs<'_>) -> Option<UnixSeconds> {
    let snapshot_max = [inputs.combined, inputs.krx, inputs.nxt]
        .into_iter()
        .flatten()
        .map(|loaded| loaded.header.as_of)
        .max();
    let overview_ts = inputs.overview_board.map(|loaded| loaded.header.as_of);
    let themes_ts = inputs.intraday_themes.map(|loaded| loaded.header.as_of);
    let samples_ts = inputs.samples.iter().map(|s| s.received_at).max();
    let rankings_ts = inputs
        .rankings
        .and_then(|merged| merged.parts.iter().map(|part| part.as_of).max());
    [snapshot_max, overview_ts, themes_ts, samples_ts, rankings_ts]
        .into_iter()
        .flatten()
        .max()
        .map(UnixSeconds)
}

pub fn derive_pro_card(inputs: &ProInputs<'_>) -> MarketOverviewProCard {
    let live_rates = live_rates_of(inputs.combined, inputs.latest_day);
    let rrg = match build_rrg(&RrgInputs {
        scope: inputs.scope,
        catalog: inputs.catalog,
        closes: inputs.closes,
        latest_day: inputs.latest_day,
        trading_days: inputs.trading_days,
        combined: inputs.combined,
        live_rates: &live_rates,
        themes_catalog: inputs.themes_catalog,
        intraday_themes: inputs.intraday_themes,
        overview_board: inputs.overview_board,
    }) {
        Some(value) => MarketOverviewPart::Ok { value },
        None => not_prepared("테마 구성종목과 일봉 자료가 없어 RRG 궤적을 계산할 수 없습니다"),
    };
    let session_dna = match build_session_dna(inputs.now, inputs.scope, inputs.samples, inputs.krx, inputs.nxt, inputs.catalog) {
        Some(value) => MarketOverviewPart::Ok { value },
        None => not_prepared("장중 수급 표본과 거래소 스냅샷이 없어 세션 DNA를 계산할 수 없습니다"),
    };
    let broker_book = match build_broker_book(inputs.rankings, inputs.scope, &live_rates) {
        Some(value) => MarketOverviewPart::Ok { value },
        None => not_prepared("공용 순위 자료가 없어 호가 압력과 외국인·프로그램 집중도를 계산할 수 없습니다"),
    };
    let disclosures = match build_disclosure_radar(inputs.disclosures, inputs.scope, inputs.catalog, &live_rates) {
        Some(value) => MarketOverviewPart::Ok { value },
        None => not_prepared("재무 DB에 공시 자료가 없어 핵심 공시 레이더를 만들 수 없습니다"),
    };
    MarketOverviewProCard {
        scope: inputs.scope,
        phase: inputs.phase,
        received_at: latest_received_at(inputs),
        rrg,
        session_dna,
        broker_book,
        disclosures,
    }
}

fn is_weekend_observation(now: KstTime) -> bool {
    matches!(observation_day(now).weekday(), Weekday::Sat | Weekday::Sun)
}

fn board_matches_day(observation_date: &str, expected_day: &str, weekend: bool) -> bool {
    weekend || observation_date == expected_day
}

fn collect_samples(st: &AppState, now: KstTime, scope: MarketOverviewScope) -> Vec<Sample> {
    let markets: &[Market] = match scope {
        MarketOverviewScope::All => &[Market::Kospi, Market::Kosdaq],
        MarketOverviewScope::Kospi => &[Market::Kospi],
        MarketOverviewScope::Kosdaq => &[Market::Kosdaq],
    };
    let weekend = is_weekend_observation(now);
    let mut out = Vec::new();
    for &market in markets {
        if st.shared_data.is_enabled() {
            if weekend {
                out.extend(shared::latest_samples(st, market));
            } else {
                out.extend(shared::samples(st, now, market));
            }
        } else {
            out.extend(st.market_overview.samples.samples(now, market));
        }
    }
    out
}

pub async fn pro(
    State(st): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<MarketOverviewProCard>, ApiFailure> {
    let scope = parse_scope(&query)?;
    let now = st.clock.now();
    let store_snapshot = st.market_overview.derived_ma_cache.snapshot(&st.screener).await;
    let directory = st.symbols.updates().borrow().clone();
    let fallback_catalog;
    let catalog = if !store_snapshot.catalog.is_empty() {
        &store_snapshot.catalog
    } else if let Some(directory) = directory.as_deref() {
        fallback_catalog = StockCatalog::from_directory(directory);
        &fallback_catalog
    } else {
        &store_snapshot.catalog
    };
    let expected_day = observation_day(now).yyyymmdd();
    let weekend = is_weekend_observation(now);
    let combined = st.shared_data.snapshot_combined.current().filter(|loaded| board_matches_day(&loaded.header.observation_date, &expected_day, weekend));
    let krx = st.shared_data.snapshot_krx.current().filter(|loaded| board_matches_day(&loaded.header.observation_date, &expected_day, weekend));
    let nxt = st.shared_data.snapshot_nxt.current().filter(|loaded| board_matches_day(&loaded.header.observation_date, &expected_day, weekend));
    let overview_board = st.shared_data.market_overview.current().filter(|loaded| board_matches_day(&loaded.header.observation_date, &expected_day, weekend));
    let intraday_themes = st.shared_data.intraday_themes.current().filter(|loaded| board_matches_day(&loaded.header.observation_date, &expected_day, weekend));
    let themes_catalog = st.kiwoom_catalog.latest().or_else(|| {
        st.shared_data.kiwoom_themes.current().map(|loaded| {
            Arc::new(StoredCatalog {
                date: loaded.header.observation_date.clone(),
                collected_at: loaded.header.as_of,
                themes: loaded
                    .body
                    .themes
                    .iter()
                    .map(|theme| StoredTheme { code: theme.code.clone(), name: theme.name.clone(), members: theme.members.clone() })
                    .collect(),
            })
        })
    });
    let rankings = st.shared_data.rankings.current().filter(|merged| board_matches_day(&merged.observation_date, &expected_day, weekend));
    let samples = collect_samples(&st, now, scope);
    let disclosures = st.market_overview.load_security_disclosures().await;
    let card = derive_pro_card(&ProInputs {
        now,
        scope,
        phase: phase(now),
        combined: combined.as_deref(),
        krx: krx.as_deref(),
        nxt: nxt.as_deref(),
        overview_board: overview_board.as_deref(),
        intraday_themes: intraday_themes.as_deref(),
        themes_catalog: themes_catalog.as_deref(),
        rankings: rankings.as_deref(),
        samples: &samples,
        disclosures: disclosures.as_deref().map(Vec::as_slice),
        catalog,
        closes: &store_snapshot.closes,
        latest_day: store_snapshot.latest_day,
        trading_days: &store_snapshot.trading_days,
    });
    Ok(Json(card))
}
