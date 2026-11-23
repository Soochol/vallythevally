mod cache;
mod kiwoom;

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::Extension;
use axum::body::Body;
use axum::extract::State;
use axum::response::Json;
use axum::routing::post;
use domain::{KstTime, StockCode, Symbol, SymbolKind};

use crate::api::{self, RankingFigures, RankingPages, RankingRow, SymbolCode, UnixSeconds};
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, feature_symbol_list};
use crate::market_source::Priority;
use crate::market_source::rankings::{RankingKind, Unsupported, condition_key, excludes_of};
use crate::shared_data::{ConditionState, to_api_broker};
use crate::symbols::Directory;
use crate::user_routes::read_json;

pub use cache::RankingCache;
pub use kiwoom::KiwoomRankings;
use cache::{Served, WalkError};

const REQUEST_LIMIT: usize = 4 * 1024;

#[derive(Clone, Copy)]
pub struct PublicRoute;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/rankings", post(rankings))
}

async fn rankings(State(st): State<Arc<AppState>>, public: Option<Extension<PublicRoute>>, body: Body) -> Result<Json<api::RankingPage>, ApiFailure> {
    let request: api::RankingRequest = read_json(body, REQUEST_LIMIT, "순위 요청 본문").await?;
    let excludes = excludes_of(&request.ranking);
    if st.shared_data.is_enabled() && let Some(page) = from_shared(&st, &request, excludes, public.is_some()).await? {
        return Ok(Json(page));
    }
    let priority = match request.trigger {
        api::RankingTrigger::User => Priority::Screen,
        api::RankingTrigger::Refresh => Priority::Background,
    };
    let picked = st.route.rankings();
    let served = st.rankings.serve(picked.source, request.ranking, usize::from(u8::from(request.pages)), priority, &st.clock).await.map_err(|e| failure(e, &st))?;
    let directory = feature_symbol_list(&st).await?;
    present(raw_rows(&served), served.pages.len(), served.end, served.limited, served.fetched_at, picked.broker, excludes, &directory).map(Json).map_err(|e| Lookup::Rankings.failure(e, st.clock.now()))
}

async fn from_shared(st: &AppState, request: &api::RankingRequest, excludes: api::Excludes, public: bool) -> Result<Option<api::RankingPage>, ApiFailure> {
    let not_prepared = || match public {
        true => Err(ApiFailure::new(api::ApiErrorCode::NotPrepared, "수집기가 미리 만들지 않은 순위 조건입니다")),
        false => Ok(None),
    };
    let wanted = u8::from(request.pages);
    let merged = st.shared_data.rankings.current();
    let Some(condition) = merged.as_ref().and_then(|merged| merged.find(&request.ranking, wanted)) else { return not_prepared() };
    let answer = condition.last.as_ref().and_then(|last| last.first_pages(wanted).map(|first| (last, first)));
    let (last, first) = match (&condition.state, answer) {
        (ConditionState::Unavailable, _) => return Err(Lookup::Rankings.failure(BarError::Source(Unsupported::Kind(RankingKind::of(&request.ranking)).into_failure()), st.clock.now())),
        (_, Some(answer)) => answer,
        (ConditionState::Failed { message, .. }, None) => {
            tracing::warn!(condition = %condition_key(&request.ranking), %message, "수집기가 이 순위 조건을 받지 못했고 이전 값도 없습니다");
            return Err(ApiFailure::new(api::ApiErrorCode::CollectorUnavailable, "수집기가 이 순위를 받지 못했습니다"));
        }
        (ConditionState::Ready, None) => return not_prepared(),
    };
    let directory = feature_symbol_list(st).await?;
    let rows = first.rows.iter().filter_map(|row| match Symbol::parse(&row.code.0) {
        Ok(Symbol::Stock(code)) => Some(RawRow { code, name: &row.name, price: row.price, change_rate: row.change_rate, figures: &row.figures }),
        _ => None,
    });
    let limited = !first.end && first.pages == api::MAX_RANKING_PAGES;
    present(rows, usize::from(first.pages), first.end, limited, KstTime::from_unix(last.received_at), to_api_broker(last.broker), excludes, &directory).map(Some).map_err(|e| Lookup::Rankings.failure(e, st.clock.now()))
}

fn failure(error: WalkError, st: &AppState) -> ApiFailure {
    match error {
        WalkError::Source(e) | WalkError::CursorRefused(e) => Lookup::Rankings.failure(e.into(), st.clock.now()),
        WalkError::Unsupported(unsupported) => Lookup::Rankings.failure(BarError::Source(unsupported.into_failure()), st.clock.now()),
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

struct RawRow<'a> {
    code: StockCode,
    name: &'a str,
    price: Option<api::Won>,
    change_rate: Option<api::Percent>,
    figures: &'a RankingFigures,
}

fn raw_rows(served: &Served) -> impl Iterator<Item = RawRow<'_>> {
    served.pages.iter().flat_map(|page| page.iter()).map(|raw| RawRow { code: raw.code, name: &raw.name, price: raw.price, change_rate: raw.change_rate, figures: &raw.figures })
}

#[allow(clippy::too_many_arguments)]
fn present<'a>(raw_rows: impl Iterator<Item = RawRow<'a>>, page_count: usize, end: bool, limited: bool, fetched_at: KstTime, source: api::Broker, excludes: api::Excludes, directory: &Directory) -> Result<api::RankingPage, BarError> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    let mut hidden = 0;
    for raw in raw_rows {
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
            name: if raw.name.is_empty() { info.map(|info| info.name.clone()).unwrap_or_default() } else { raw.name.to_owned() },
            listed: info.is_some(),
            price: raw.price,
            change_rate: raw.change_rate,
            figures: raw.figures.clone(),
        });
    }
    let pages = u8::try_from(page_count).ok().and_then(|pages| RankingPages::try_from(pages).ok()).ok_or_else(|| BarError::Internal("순위 페이지 수가 범위를 벗어났습니다".into()))?;
    Ok(api::RankingPage { rows, pages, end, limited, hidden, fetched_at: UnixSeconds(fetched_at.unix()), source })
}
