mod cache;
mod query;

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::response::Json;
use axum::routing::post;
use domain::{Symbol, SymbolKind};

use crate::api::{self, RankingPages, RankingRow, SymbolCode, UnixSeconds};
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, symbol_list};
use crate::kiwoom::rest::Priority;
use crate::symbols::Directory;
use crate::user_routes::read_json;

pub use cache::RankingCache;
use cache::{Served, WalkError};

const REQUEST_LIMIT: usize = 4 * 1024;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/rankings", post(rankings))
}

async fn rankings(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<api::RankingPage>, ApiFailure> {
    let request: api::RankingRequest = read_json(body, REQUEST_LIMIT, "순위 요청 본문").await?;
    let priority = match request.trigger {
        api::RankingTrigger::User => Priority::Screen,
        api::RankingTrigger::Refresh => Priority::Background,
    };
    let (query, excludes) = query::plan(request.ranking);
    let rest = st.kiwoom.rest().map_err(|e| failure(WalkError::Kiwoom(e), &st))?;
    let served = st.rankings.serve(query, usize::from(u8::from(request.pages)), priority, rest, &st.clock).await.map_err(|e| failure(e, &st))?;
    let directory = symbol_list(&st).await?;
    present(served, excludes, &directory).map(Json).map_err(|e| Lookup::Rankings.failure(e, st.clock.now()))
}

fn failure(error: WalkError, st: &AppState) -> ApiFailure {
    match error {
        WalkError::Kiwoom(e) => Lookup::Rankings.failure(e.into(), st.clock.now()),
        WalkError::KeyRepeated => ApiFailure::kiwoom_protocol("키움 순위의 연속조회 키가 되풀이돼 끝까지 받지 못했습니다"),
        WalkError::KeyMissing => ApiFailure::kiwoom_protocol("키움 순위가 다음 페이지가 있다고 하면서 연속조회 키를 주지 않았습니다"),
        WalkError::PageUnreadable => ApiFailure::kiwoom_protocol("키움 순위 페이지의 행을 하나도 읽지 못했습니다"),
        WalkError::WalkLost => {
            tracing::error!("순위 걷기가 결과를 내지 못하고 끝났습니다");
            ApiFailure::new(api::ApiErrorCode::Internal, "서버 내부 오류입니다")
        }
    }
}

fn hidden_by(excludes: api::Excludes, kind: SymbolKind) -> bool {
    (excludes.etf_etn && matches!(kind, SymbolKind::Etf | SymbolKind::Etn)) || (excludes.preferred && kind == SymbolKind::Preferred)
}

fn present(served: Served, excludes: api::Excludes, directory: &Directory) -> Result<api::RankingPage, BarError> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    let mut hidden = 0;
    for raw in served.pages.iter().flat_map(|page| page.iter()) {
        if !seen.insert(raw.code) {
            continue;
        }
        let symbol = Symbol::Stock(raw.code);
        let info = directory.get(symbol);
        if info.is_some_and(|info| hidden_by(excludes, info.kind)) {
            hidden += 1;
            continue;
        }
        rows.push(RankingRow {
            rank: u32::try_from(rows.len() + 1).map_err(|_| BarError::Internal("순위 줄 수가 너무 많습니다".into()))?,
            code: SymbolCode(symbol.as_wire()),
            name: raw.name.clone(),
            listed: info.is_some(),
            price: raw.price,
            change_rate: raw.change_rate,
            figures: raw.figures.clone(),
        });
    }
    let pages = u8::try_from(served.pages.len()).ok().and_then(|pages| RankingPages::try_from(pages).ok()).ok_or_else(|| BarError::Internal("순위 페이지 수가 범위를 벗어났습니다".into()))?;
    Ok(api::RankingPage { rows, pages, end: served.end, limited: served.limited, hidden, fetched_at: UnixSeconds(served.fetched_at.unix()) })
}
