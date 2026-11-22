mod board;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{KstTime, Symbol, Venue};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{KstDate, Quote, Revision, SymbolCode, UnixSeconds};
use crate::http::{ApiFailure, AppState, Lookup, symbol_list, venue_param};
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

#[derive(Default)]
pub struct QuoteCache {
    entries: Mutex<HashMap<(Symbol, Venue), Entry>>,
}

impl QuoteCache {
    fn fresh(&self, wanted: &[Symbol], venue: Venue, now: KstTime) -> (HashMap<Symbol, Quote>, Vec<Symbol>) {
        let mut entries = self.entries.lock().expect("보드 시세 캐시 잠금");
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
    }

    fn keep(&self, venue: Venue, now: KstTime, quotes: &[Quote]) {
        let mut entries = self.entries.lock().expect("보드 시세 캐시 잠금");
        for quote in quotes {
            if let Ok(symbol) = Symbol::parse(&quote.symbol.0) {
                entries.insert((symbol, venue), Entry { fetched_at: now, quote: quote.clone() });
            }
        }
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/heatmap/board", get(board)).layer(Extension(Arc::new(QuoteCache::default())))
}

async fn board(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<QuoteCache>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<HeatmapBoard>, ApiFailure> {
    let venue = venue_param(&q)?.unwrap_or(Venue::Combined);
    let order = match q.get("order") {
        None => HeatmapThemeOrder::default(),
        Some(raw) => HeatmapThemeOrder::parse(raw).ok_or_else(|| ApiFailure::bad_request("order는 rate, custom 또는 traded여야 합니다"))?,
    };
    let document = userdata::get_heatmap_themes(&st.db).await?;
    let mut wanted: Vec<Symbol> = Vec::new();
    for code in document.themes.iter().flat_map(|t| &t.symbols) {
        let symbol = Symbol::parse(&code.0).map_err(|e| ApiFailure::bad_request(format!("저장된 테마의 종목 코드가 틀렸습니다: {e}")))?;
        if !wanted.contains(&symbol) {
            wanted.push(symbol);
        }
    }
    let directory = if wanted.is_empty() { None } else { Some(symbol_list(&st).await?) };
    let now = st.clock.now();
    let (mut quotes, stale) = cache.fresh(&wanted, venue, now);
    if !stale.is_empty() {
        let fetched = crate::quotes::quotes(st.source.as_ref(), &st.bars, directory.as_deref(), &stale, venue).await.map_err(|e| Lookup::Quotes.failure(e, now))?;
        cache.keep(venue, now, &fetched);
        quotes.extend(fetched.into_iter().filter_map(|quote| Symbol::parse(&quote.symbol.0).ok().map(|symbol| (symbol, quote))));
    }
    let as_of = quotes.values().map(|quote| quote.t.0).max().map(UnixSeconds);
    let by_code: HashMap<SymbolCode, Quote> = quotes.into_iter().map(|(symbol, quote)| (SymbolCode(symbol.as_wire()), quote)).collect();
    let name_of = |code: &SymbolCode| {
        Symbol::parse(&code.0).ok().and_then(|symbol| directory.as_deref().and_then(|d| d.get(symbol))).map_or_else(|| code.0.clone(), |info| info.name.clone())
    };
    let themes = document.themes.iter().map(|theme| board_theme(theme, &by_code, name_of)).collect();
    Ok(Json(HeatmapBoard { revision: document.revision, order, as_of, source: HeatmapSource::Mine, catalog: None, themes: in_order(themes, order) }))
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
