mod catalog;
mod ma;

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{StockCode, Symbol};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{self, KstDate, UnixSeconds};
use crate::http::{ApiFailure, AppState};
use ma::MaCache;
pub use catalog::{Catalog, Fund, Holding, Loaded, MAX_WEIGHT_SUM_BPS, Rejection};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfStyle {
    Active,
    Passive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfDataSource {
    Snapshot,
    Collected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfDataStatus {
    pub source: EtfDataSource,
    pub holdings_as_of: KstDate,
    pub last_attempt_at: Option<UnixSeconds>,
    pub refresh_failed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfMaState {
    Above,
    Equal,
    Below,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfMaStates {
    pub ma20: Option<EtfMaState>,
    pub ma60: Option<EtfMaState>,
    pub ma120: Option<EtfMaState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfFundSummary {
    pub code: String,
    pub name: String,
    pub issuer: String,
    pub style: EtfStyle,
    pub benchmark: String,
    pub holdings_count: u32,
    pub top5_weight_bps: u32,
    pub effective_holdings: f64,
    pub status: EtfDataStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfFundList {
    pub funds: Vec<EtfFundSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfHolding {
    pub code: String,
    pub name: String,
    pub weight_bps: u32,
    pub ma: EtfMaStates,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfFundDetail {
    pub fund: EtfFundSummary,
    pub holdings: Vec<EtfHolding>,
    pub ma_as_of: Option<KstDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfStockHolder {
    pub fund: EtfFundSummary,
    pub weight_bps: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfStockHolders {
    pub code: String,
    pub name: Option<String>,
    pub ma: EtfMaStates,
    pub ma_as_of: Option<KstDate>,
    pub holders: Vec<EtfStockHolder>,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/etf/funds", get(funds))
        .route("/api/etf/funds/{code}", get(fund))
        .route("/api/etf/stocks/{code}", get(stock))
        .layer(Extension(Arc::new(Catalog::embedded())))
        .layer(Extension(Arc::new(MaCache::default())))
}

fn summary(fund: &Fund) -> EtfFundSummary {
    EtfFundSummary {
        code: fund.code.as_str().into(),
        name: fund.name.clone(),
        issuer: fund.issuer.clone(),
        style: fund.style,
        benchmark: fund.benchmark.clone(),
        holdings_count: fund.holdings.len() as u32,
        top5_weight_bps: fund.top_weight_bpss,
        effective_holdings: fund.effective_holdings,
        status: fund.status.clone(),
    }
}

fn code_in(path: &str) -> Result<StockCode, ApiFailure> {
    StockCode::parse(path).map_err(|e| ApiFailure::bad_request(e.to_string()))
}

fn stock_name(st: &AppState, catalog: &Catalog, code: StockCode) -> Option<String> {
    let listed = st.symbols.updates().borrow().as_ref().and_then(|dir| dir.get(Symbol::Stock(code)).map(|info| info.name.clone()));
    listed.or_else(|| catalog.stock_name(code).map(str::to_owned))
}

async fn funds(Extension(catalog): Extension<Arc<Catalog>>) -> Json<EtfFundList> {
    Json(EtfFundList { funds: catalog.funds().iter().map(summary).collect() })
}

async fn fund(State(st): State<Arc<AppState>>, Extension(catalog): Extension<Arc<Catalog>>, Extension(cache): Extension<Arc<MaCache>>, Path(code): Path<String>) -> Result<Json<EtfFundDetail>, ApiFailure> {
    let fund = catalog.fund(code_in(&code)?).ok_or_else(|| ApiFailure::new(api::ApiErrorCode::NotFound, format!("없는 ETF입니다: {code}")))?;
    let ma = cache.snapshot(&st.screener, || catalog.stock_codes()).await;
    let holdings = fund
        .holdings
        .iter()
        .map(|h| EtfHolding { code: h.code.as_str().into(), name: stock_name(&st, &catalog, h.code).unwrap_or_default(), weight_bps: h.weight_bps, ma: ma.states(h.code) })
        .collect();
    Ok(Json(EtfFundDetail { fund: summary(fund), holdings, ma_as_of: ma.as_of.map(KstDate) }))
}

async fn stock(State(st): State<Arc<AppState>>, Extension(catalog): Extension<Arc<Catalog>>, Extension(cache): Extension<Arc<MaCache>>, Path(code): Path<String>) -> Result<Json<EtfStockHolders>, ApiFailure> {
    let stock = code_in(&code)?;
    let ma = cache.snapshot(&st.screener, || catalog.stock_codes()).await;
    let holders = catalog.holders(stock).into_iter().map(|(fund, weight_bps)| EtfStockHolder { fund: summary(fund), weight_bps }).collect();
    Ok(Json(EtfStockHolders { code: stock.as_str().into(), name: stock_name(&st, &catalog, stock), ma: ma.states(stock), ma_as_of: ma.as_of.map(KstDate), holders }))
}
