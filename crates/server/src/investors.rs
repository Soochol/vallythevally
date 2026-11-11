use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use domain::{KstDate, StockCode, Symbol};

use crate::api;
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, symbol_list};
use crate::kiwoom::api::{MarketRequest, StockForeignHoldings, StockInvestorNetShares};
use crate::kiwoom::rest::{ContKey, KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::DayPage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayRange {
    from: KstDate,
    to: KstDate,
}

impl DayRange {
    pub fn new(from: KstDate, to: KstDate) -> Option<Self> {
        (from <= to).then_some(DayRange { from, to })
    }

    fn contains(self, day: KstDate) -> bool {
        (self.from..=self.to).contains(&day)
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/symbols/{code}/foreign-holdings", get(foreign_holdings))
        .route("/api/symbols/{code}/investor-net-shares", get(investor_net_shares))
}

async fn foreign_holdings(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::DayHistory<api::ForeignHoldingDay>>, ApiFailure> {
    let (stock, range) = history_query(&st, &code, &q).await?;
    let history = walk(&st.rest, &StockForeignHoldings::new(stock), stock, range).await;
    Ok(Json(history.map_err(|e| Lookup::ForeignHoldings.failure(e, st.clock.now()))?))
}

async fn investor_net_shares(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::DayHistory<api::InvestorNetSharesDay>>, ApiFailure> {
    let (stock, range) = history_query(&st, &code, &q).await?;
    let history = walk(&st.rest, &StockInvestorNetShares::new(stock, st.clock.now().kst_date()), stock, range).await;
    Ok(Json(history.map_err(|e| Lookup::InvestorNetShares.failure(e, st.clock.now()))?))
}

async fn history_query(st: &AppState, code: &str, q: &HashMap<String, String>) -> Result<(StockCode, DayRange), ApiFailure> {
    let Symbol::Stock(stock) = Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? else {
        return Err(ApiFailure::bad_request("지수에는 투자자별 자료가 없습니다"));
    };
    let day = |k: &str| -> Result<KstDate, ApiFailure> {
        let text = q.get(k).ok_or_else(|| ApiFailure::bad_request(format!("{k}가 없습니다")))?;
        Ok(text.parse::<api::KstDate>().map_err(|e| ApiFailure::bad_request(format!("{k}: {e}")))?.0)
    };
    let (from, to) = (day("from")?, day("to")?);
    let range = DayRange::new(from, to).ok_or_else(|| ApiFailure::bad_request(format!("from({from})이 to({to})보다 늦습니다")))?;
    if symbol_list(st).await?.get(Symbol::Stock(stock)).is_none() {
        return Err(ApiFailure::new(api::ApiErrorCode::UnknownSymbol, format!("없는 종목입니다: {code}")));
    }
    Ok((stock, range))
}

async fn walk<R>(rest: &KiwoomRest, req: &R, code: StockCode, range: DayRange) -> Result<api::DayHistory<<R::Response as DayPage>::Day>, BarError>
where
    R: MarketRequest,
    R::Response: DayPage,
{
    let (mut days, mut skipped) = (Vec::new(), Vec::new());
    let mut reached: Option<KstDate> = None;
    let mut cont: Option<ContKey> = None;
    let first_day = loop {
        let page = rest.call(req, cont.as_ref(), Priority::Background, MergeScope::default()).await?;
        let older = page.body.into_days().filter(|rows| reached.is_none_or(|r| rows.oldest < r));
        let Some(rows) = older else {
            let Some(reached) = reached else {
                return Err(BarError::UnknownSymbol);
            };
            tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), %reached, "키움 연속조회가 더 오래된 날을 주지 않아 여기서 멈춥니다");
            break reached;
        };
        for row in &rows.undated {
            tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), dt = %row.dt, reason = %row.reason, "키움 행을 읽지 못해 그 행만 빼고 받습니다");
        }
        reached = Some(rows.oldest);
        let oldest = rows.oldest;
        for (day, row) in rows.rows {
            match row {
                Ok(row) if range.contains(day) => days.push((day, row)),
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(api_id = R::API_ID.as_str(), code = code.as_str(), dt = %day.yyyymmdd(), field = e.field, reason = %e.reason, "키움 행을 읽지 못해 그 행만 빼고 받습니다");
                    if range.contains(day) {
                        skipped.push(api::SkippedDay { day: api::KstDate(day), field: e.field.to_owned(), reason: e.reason.to_string() });
                    }
                }
            }
        }
        match page.next {
            Some(next) if oldest > range.from => cont = Some(next),
            _ => break oldest,
        }
    };
    days.sort_by_key(|(day, _)| *day);
    days.dedup_by_key(|(day, _)| *day);
    skipped.sort_by_key(|s| s.day);
    skipped.dedup_by_key(|s| s.day);
    skipped.retain(|s| days.binary_search_by_key(&s.day.0, |(day, _)| *day).is_err());
    let coverage = if first_day <= range.from { api::RangeCoverage::WholeRange } else { api::RangeCoverage::KiwoomStartsLater { first_day: api::KstDate(first_day) } };
    Ok(api::DayHistory {
        symbol: api::SymbolCode(Symbol::Stock(code).as_wire()),
        from: api::KstDate(range.from),
        to: api::KstDate(range.to),
        coverage,
        days: days.into_iter().map(|(_, day)| day).collect(),
        skipped_days: skipped,
    })
}
