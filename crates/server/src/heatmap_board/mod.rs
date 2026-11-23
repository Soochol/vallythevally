mod board;
mod shared;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{KstTime, Symbol, Venue};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{HeatmapTheme, HeatmapThemes, KstDate, Quote, Revision, SymbolCode, UnixSeconds};
use crate::http::{ApiFailure, AppState, Lookup, symbol_list, venue_param};
use crate::market_source::{GenerationScoped, GenerationTicket, SourceGeneration};
use crate::userdata;
pub use board::{HeatmapBoardMember, HeatmapBoardTheme, HeatmapThemeOrder, HeatmapThemeSummary, board_theme, in_order};

pub const FRESH_SECS: i64 = 45;

pub struct Busy;

pub enum Refused {
    Busy,
    Failed(ApiFailure),
}

pub trait QuoteGate: Sync {
    fn begin(&self) -> Result<Box<dyn Send>, Busy>;
    fn grant_tr(&self) -> BoxFuture<'_, bool>;
}

struct Unlimited;

impl QuoteGate for Unlimited {
    fn begin(&self) -> Result<Box<dyn Send>, Busy> {
        Ok(Box::new(()))
    }

    fn grant_tr(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BoardTally {
    pub cached: u32,
    pub fetched: u32,
    pub over_budget: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeatmapBoard {
    pub revision: Revision,
    pub order: HeatmapThemeOrder,
    pub as_of: Option<UnixSeconds>,
    pub source: HeatmapSource,
    pub catalog: Option<KiwoomCatalogInfo>,
    pub themes: Vec<HeatmapBoardTheme>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HeatmapSource {
    #[default]
    Mine,
    Kiwoom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomCatalogState {
    Ready,
    Collecting,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomCatalogInfo {
    pub date: Option<KstDate>,
    pub collected_at: Option<UnixSeconds>,
    pub themes: u32,
    pub state: KiwoomCatalogState,
}

struct Entry {
    fetched_at: KstTime,
    quote: Quote,
}

pub struct QuoteCache {
    entries: GenerationScoped<HashMap<(Symbol, Venue), Entry>>,
}

impl QuoteCache {
    pub fn with_generation(generation: SourceGeneration) -> QuoteCache {
        QuoteCache { entries: GenerationScoped::new(generation) }
    }

    fn ticket(&self) -> GenerationTicket {
        self.entries.ticket()
    }

    fn fresh(&self, wanted: &[Symbol], venue: Venue, now: KstTime) -> (HashMap<Symbol, Quote>, Vec<Symbol>) {
        self.entries.read(|entries| {
            entries.retain(|_, e| e.fetched_at.kst_date() == now.kst_date());
            let mut hits = HashMap::new();
            let mut stale = Vec::new();
            for symbol in wanted {
                match entries.get(&(*symbol, venue)) {
                    Some(e) if now.unix() - e.fetched_at.unix() < FRESH_SECS => {
                        hits.insert(*symbol, e.quote.clone());
                    }
                    _ => stale.push(*symbol),
                }
            }
            (hits, stale)
        })
    }

    fn keep(&self, started: GenerationTicket, venue: Venue, now: KstTime, quotes: &[Quote]) {
        self.entries.keep(started, |entries| {
            for quote in quotes {
                if let Ok(symbol) = Symbol::parse(&quote.symbol.0) {
                    entries.insert((symbol, venue), Entry { fetched_at: now, quote: quote.clone() });
                }
            }
        });
    }
}

pub fn routes(cache: Arc<QuoteCache>) -> Router<Arc<AppState>> {
    Router::new().route("/api/heatmap/board", get(board)).layer(Extension(cache))
}

struct BoardParams {
    venue: Venue,
    order: HeatmapThemeOrder,
    source: HeatmapSource,
}

fn board_params(q: &HashMap<String, String>) -> Result<BoardParams, ApiFailure> {
    let venue = venue_param(q)?.unwrap_or(Venue::Combined);
    let order = match q.get("order") {
        None => HeatmapThemeOrder::default(),
        Some(raw) => HeatmapThemeOrder::parse(raw).ok_or_else(|| ApiFailure::bad_request("order는 rate, custom 또는 traded여야 합니다"))?,
    };
    let source = match q.get("source").map(String::as_str) {
        None | Some("mine") => HeatmapSource::Mine,
        Some("kiwoom") => HeatmapSource::Kiwoom,
        Some(_) => return Err(ApiFailure::bad_request("source는 mine 또는 kiwoom이어야 합니다")),
    };
    Ok(BoardParams { venue, order, source })
}

async fn board(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<QuoteCache>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<HeatmapBoard>, ApiFailure> {
    let params = board_params(&q)?;
    let mine = match params.source {
        HeatmapSource::Mine => userdata::get_heatmap_themes(&st.db).await?,
        HeatmapSource::Kiwoom => HeatmapThemes { themes: Vec::new(), revision: Revision(0) },
    };
    match assemble(&st, &cache, params, mine, &Unlimited).await {
        Ok((board, _)) => Ok(Json(board)),
        Err(Refused::Failed(failure)) => Err(failure),
        Err(Refused::Busy) => Err(ApiFailure::new(crate::api::ApiErrorCode::Internal, "제한 없는 호출이 자리를 얻지 못했습니다")),
    }
}

pub async fn board_within(st: &AppState, cache: &QuoteCache, q: &HashMap<String, String>, mine: HeatmapThemes, gate: &dyn QuoteGate) -> Result<(HeatmapBoard, BoardTally), Refused> {
    let params = board_params(q).map_err(Refused::Failed)?;
    assemble(st, cache, params, mine, gate).await
}

async fn assemble(st: &AppState, cache: &QuoteCache, params: BoardParams, mine: HeatmapThemes, gate: &dyn QuoteGate) -> Result<(HeatmapBoard, BoardTally), Refused> {
    let BoardParams { venue, order, source } = params;
    let (document, catalog) = match source {
        HeatmapSource::Mine => (mine, None),
        HeatmapSource::Kiwoom => (kiwoom_document(&st.kiwoom_catalog), Some(st.kiwoom_catalog.info())),
    };
    let mut wanted: Vec<Symbol> = Vec::new();
    for code in document.themes.iter().flat_map(|t| &t.symbols) {
        let symbol = Symbol::parse(&code.0).map_err(|e| Refused::Failed(ApiFailure::bad_request(format!("저장된 테마의 종목 코드가 틀렸습니다: {e}"))))?;
        if !wanted.contains(&symbol) {
            wanted.push(symbol);
        }
    }
    let directory = if wanted.is_empty() { None } else { Some(symbol_list(st).await.map_err(Refused::Failed)?) };
    let (quotes, as_of, tally) = if st.shared_data.is_enabled() {
        let shared = shared::quotes(&st.shared_data, &wanted, venue, directory.as_deref());
        let tally = BoardTally { cached: shared.quotes.len() as u32, ..BoardTally::default() };
        (shared.quotes, shared.as_of, tally)
    } else {
        let (quotes, tally) = polled_quotes(st, cache, &wanted, venue, directory.as_deref(), gate).await?;
        let as_of = quotes.values().map(|quote| quote.t.0).max().map(UnixSeconds);
        (quotes, as_of, tally)
    };
    let by_code: HashMap<SymbolCode, Quote> = quotes.into_iter().map(|(symbol, quote)| (SymbolCode(symbol.as_wire()), quote)).collect();
    let name_of = |code: &SymbolCode| {
        Symbol::parse(&code.0).ok().and_then(|symbol| directory.as_deref().and_then(|d| d.get(symbol))).map_or_else(|| code.0.clone(), |info| info.name.clone())
    };
    let themes = document.themes.iter().map(|theme| board_theme(theme, &by_code, name_of)).collect();
    Ok((HeatmapBoard { revision: document.revision, order, as_of, source, catalog, themes: in_order(themes, order) }, tally))
}

async fn polled_quotes(st: &AppState, cache: &QuoteCache, wanted: &[Symbol], venue: Venue, directory: Option<&crate::symbols::Directory>, gate: &dyn QuoteGate) -> Result<(HashMap<Symbol, Quote>, BoardTally), Refused> {
    let now = st.clock.now();
    let started = cache.ticket();
    let (mut quotes, stale) = cache.fresh(wanted, venue, now);
    let mut tally = BoardTally { cached: quotes.len() as u32, ..BoardTally::default() };
    if !stale.is_empty() {
        let _held = gate.begin().map_err(|_| Refused::Busy)?;
        let mut fetched = Vec::new();
        for group in stale.chunks(crate::kiwoom::api::StockQuotes::MAX) {
            if !gate.grant_tr().await {
                tally.over_budget += group.len() as u32;
                continue;
            }
            fetched.extend(crate::quotes::quotes(st.source.as_ref(), &st.bars, directory, group, venue).await.map_err(|e| Refused::Failed(Lookup::Quotes.failure(e, now)))?);
            tally.fetched += 1;
        }
        cache.keep(started, venue, now, &fetched);
        quotes.extend(fetched.into_iter().filter_map(|quote| Symbol::parse(&quote.symbol.0).ok().map(|symbol| (symbol, quote))));
    }
    Ok((quotes, tally))
}

pub const KIWOOM_THEME_ID_PREFIX: &str = "kiwoom-";

fn kiwoom_document(store: &crate::kiwoom_themes::CatalogStore) -> HeatmapThemes {
    let themes = store.latest().map_or_else(Vec::new, |catalog| {
        catalog
            .themes
            .iter()
            .map(|theme| HeatmapTheme {
                id: format!("{KIWOOM_THEME_ID_PREFIX}{}", theme.code),
                name: theme.name.clone(),
                symbols: crate::kiwoom_themes::members_of(theme).into_iter().map(|code| SymbolCode(Symbol::Stock(code).as_wire())).collect(),
            })
            .collect()
    });
    HeatmapThemes { themes, revision: Revision(0) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::heatmap_flow::REFRESH_SECS;
    use crate::kiwoom::api::StockQuotes;
    use crate::kiwoom::rest::same_tr_burst_duration;

    #[test]
    fn the_largest_board_costs_at_most_a_third_of_the_refresh_interval_in_kiwoom_calls() {
        let calls = (setup::MAX_HEATMAP_THEMES * setup::MAX_HEATMAP_THEME_SYMBOLS).div_ceil(StockQuotes::MAX);
        assert!(same_tr_burst_duration(calls) <= std::time::Duration::from_secs(REFRESH_SECS) / 3);
        assert!(FRESH_SECS < REFRESH_SECS as i64);
    }
}
