mod board;
mod shared;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{KstTime, Symbol, Venue};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{HeatmapTheme, HeatmapThemes, KstDate, Quote, Revision, SymbolCode, UnixSeconds};
use crate::http::{ApiFailure, AppState, Lookup, symbol_list, venue_param};
use crate::market_source::{GenerationScoped, GenerationTicket, SourceGeneration};
use crate::userdata;
pub use board::{HeatmapBoardMember, HeatmapBoardTheme, HeatmapThemeOrder, HeatmapThemeSummary, board_theme, in_order};

pub const FRESH_SECS: i64 = 45;

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
    let wanted = wanted_by(&st, params.source, mine).await?;
    let (quotes, as_of) = if st.shared_data.is_enabled() {
        let shared = shared::quotes(&st.shared_data, &wanted.symbols, params.venue, wanted.directory.as_deref());
        (shared.quotes, shared.as_of)
    } else {
        let quotes = polled_quotes(&st, &cache, &wanted.symbols, params.venue, wanted.directory.as_deref()).await?;
        let as_of = quotes.values().map(|quote| quote.t.0).max().map(UnixSeconds);
        (quotes, as_of)
    };
    Ok(Json(board_of(&params, wanted, quotes, as_of)))
}

pub async fn board_within(st: &AppState, q: &HashMap<String, String>, mine: HeatmapThemes) -> Result<HeatmapBoard, ApiFailure> {
    let params = board_params(q)?;
    if !st.shared_data.is_enabled() {
        return Err(ApiFailure::new(crate::api::ApiErrorCode::NotPrepared, "공용 자료 폴더가 없어 보드를 만들 수 없습니다"));
    }
    let wanted = wanted_by(st, params.source, mine).await?;
    let shared = shared::quotes(&st.shared_data, &wanted.symbols, params.venue, wanted.directory.as_deref());
    Ok(board_of(&params, wanted, shared.quotes, shared.as_of))
}

struct Wanted {
    document: HeatmapThemes,
    catalog: Option<KiwoomCatalogInfo>,
    symbols: Vec<Symbol>,
    directory: Option<Arc<crate::symbols::Directory>>,
}

async fn wanted_by(st: &AppState, source: HeatmapSource, mine: HeatmapThemes) -> Result<Wanted, ApiFailure> {
    let (document, catalog) = match source {
        HeatmapSource::Mine => (mine, None),
        HeatmapSource::Kiwoom => (kiwoom_document(&st.kiwoom_catalog), Some(st.kiwoom_catalog.info())),
    };
    let mut symbols: Vec<Symbol> = Vec::new();
    for code in document.themes.iter().flat_map(|t| &t.symbols) {
        let symbol = Symbol::parse(&code.0).map_err(|e| ApiFailure::bad_request(format!("저장된 테마의 종목 코드가 틀렸습니다: {e}")))?;
        if !symbols.contains(&symbol) {
            symbols.push(symbol);
        }
    }
    let directory = if symbols.is_empty() { None } else { Some(symbol_list(st).await?) };
    Ok(Wanted { document, catalog, symbols, directory })
}

fn board_of(params: &BoardParams, wanted: Wanted, quotes: HashMap<Symbol, Quote>, as_of: Option<UnixSeconds>) -> HeatmapBoard {
    let Wanted { document, catalog, directory, .. } = wanted;
    let by_code: HashMap<SymbolCode, Quote> = quotes.into_iter().map(|(symbol, quote)| (SymbolCode(symbol.as_wire()), quote)).collect();
    let name_of = |code: &SymbolCode| {
        Symbol::parse(&code.0).ok().and_then(|symbol| directory.as_deref().and_then(|d| d.get(symbol))).map_or_else(|| code.0.clone(), |info| info.name.clone())
    };
    let themes = document.themes.iter().map(|theme| board_theme(theme, &by_code, name_of)).collect();
    HeatmapBoard { revision: document.revision, order: params.order, as_of, source: params.source, catalog, themes: in_order(themes, params.order) }
}

async fn polled_quotes(st: &AppState, cache: &QuoteCache, wanted: &[Symbol], venue: Venue, directory: Option<&crate::symbols::Directory>) -> Result<HashMap<Symbol, Quote>, ApiFailure> {
    let now = st.clock.now();
    let started = cache.ticket();
    let (mut quotes, stale) = cache.fresh(wanted, venue, now);
    let mut fetched = Vec::new();
    for group in stale.chunks(crate::kiwoom::api::StockQuotes::MAX) {
        fetched.extend(crate::quotes::quotes(st.source.as_ref(), &st.bars, directory, group, venue).await.map_err(|e| Lookup::Quotes.failure(e, now))?);
    }
    cache.keep(started, venue, now, &fetched);
    quotes.extend(fetched.into_iter().filter_map(|quote| Symbol::parse(&quote.symbol.0).ok().map(|symbol| (symbol, quote))));
    Ok(quotes)
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
