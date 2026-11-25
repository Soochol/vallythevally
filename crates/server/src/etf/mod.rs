mod accumulation;
mod catalog;
mod collect;
mod history;
mod ma;

use std::sync::Arc;

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{StockCode, Symbol};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{self, KstDate, UnixSeconds};
use crate::http::{ApiFailure, AppState};
use ma::MaCache;
pub use collect::{EtfBook, start as start_collection};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfChangeKind {
    Added,
    Removed,
    Increased,
    Decreased,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfChangePair {
    pub before: KstDate,
    pub after: KstDate,
    pub common_scale: Option<f64>,
    pub added: u32,
    pub removed: u32,
    pub increased: u32,
    pub decreased: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfHistory {
    pub code: String,
    pub first_collected_on: Option<KstDate>,
    pub pairs: Vec<EtfChangePair>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfChangeRow {
    pub code: String,
    pub name: String,
    pub before_quantity: Option<f64>,
    pub after_quantity: Option<f64>,
    pub real_change: Option<f64>,
    pub kind: EtfChangeKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfChanges {
    pub code: String,
    pub before: KstDate,
    pub after: KstDate,
    pub common_scale: Option<f64>,
    pub rows: Vec<EtfChangeRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfAccumulationStyle {
    Active,
    All,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfAccumulationContributor {
    pub fund_code: String,
    pub fund_name: String,
    pub style: EtfStyle,
    pub kind: EtfChangeKind,
    pub real_change: Option<f64>,
    pub after_weight_bps: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfAccumulationRow {
    pub code: String,
    pub name: String,
    pub buying_etf_count: u32,
    pub added_etf_count: u32,
    pub increased_etf_count: u32,
    pub median_real_change: Option<f64>,
    pub ma: EtfMaStates,
    pub contributors: Vec<EtfAccumulationContributor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfAccumulation {
    pub window: u32,
    pub style: EtfAccumulationStyle,
    pub from_date: Option<KstDate>,
    pub to_date: Option<KstDate>,
    pub collected_days: u32,
    pub ma_as_of: Option<KstDate>,
    pub rows: Vec<EtfAccumulationRow>,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/etf/funds", get(funds))
        .route("/api/etf/funds/{code}", get(fund))
        .route("/api/etf/funds/{code}/history", get(history))
        .route("/api/etf/funds/{code}/changes", get(changes))
        .route("/api/etf/stocks/{code}", get(stock))
        .route("/api/etf/accumulation", get(accumulation))
        .layer(Extension(Arc::new(MaCache::default())))
        .layer(Extension(Arc::new(accumulation::AccumulationCache::default())))
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

async fn funds(State(st): State<Arc<AppState>>) -> Json<EtfFundList> {
    let catalog = st.etf.catalog();
    Json(EtfFundList { funds: catalog.funds().iter().map(summary).collect() })
}

async fn fund(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<MaCache>>, Path(code): Path<String>) -> Result<Json<EtfFundDetail>, ApiFailure> {
    let catalog = st.etf.catalog();
    let fund = catalog.fund(code_in(&code)?).ok_or_else(|| ApiFailure::new(api::ApiErrorCode::NotFound, format!("없는 ETF입니다: {code}")))?;
    let ma = cache.snapshot(&st.screener, || catalog.stock_codes()).await;
    let holdings = fund
        .holdings
        .iter()
        .map(|h| EtfHolding { code: h.code.as_str().into(), name: stock_name(&st, &catalog, h.code).unwrap_or_default(), weight_bps: h.weight_bps, ma: ma.states(h.code) })
        .collect();
    Ok(Json(EtfFundDetail { fund: summary(fund), holdings, ma_as_of: ma.as_of.map(KstDate) }))
}

async fn stock(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<MaCache>>, Path(code): Path<String>) -> Result<Json<EtfStockHolders>, ApiFailure> {
    let catalog = st.etf.catalog();
    let stock = code_in(&code)?;
    let ma = cache.snapshot(&st.screener, || catalog.stock_codes()).await;
    let holders = catalog.holders(stock).into_iter().map(|(fund, weight_bps)| EtfStockHolder { fund: summary(fund), weight_bps }).collect();
    Ok(Json(EtfStockHolders { code: stock.as_str().into(), name: stock_name(&st, &catalog, stock), ma: ma.states(stock), ma_as_of: ma.as_of.map(KstDate), holders }))
}

fn listed_fund(st: &AppState, code: &str) -> Result<StockCode, ApiFailure> {
    let code = code_in(code)?;
    st.etf.catalog().fund(code).ok_or_else(|| ApiFailure::new(api::ApiErrorCode::NotFound, format!("없는 ETF입니다: {}", code.as_str())))?;
    Ok(code)
}

async fn collection_of(st: &AppState, code: StockCode) -> history::Collection {
    match st.etf.pdf_dir() {
        Some(dir) => history::read_collection(dir, code).await,
        None => history::Collection::new(),
    }
}

fn day_in(query: &HashMap<String, String>, name: &str) -> Result<domain::KstDate, ApiFailure> {
    let text = query.get(name).ok_or_else(|| ApiFailure::bad_request(format!("{name} 날짜가 필요합니다")))?;
    text.parse::<KstDate>().map(|date| date.0).map_err(ApiFailure::bad_request)
}

async fn history(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<EtfHistory>, ApiFailure> {
    let code = listed_fund(&st, &code)?;
    let collection = collection_of(&st, code).await;
    Ok(Json(EtfHistory { code: code.as_str().into(), first_collected_on: collection.keys().next().map(|day| KstDate(*day)), pairs: history::pairs(&collection) }))
}

async fn changes(State(st): State<Arc<AppState>>, Path(code): Path<String>, Query(query): Query<HashMap<String, String>>) -> Result<Json<EtfChanges>, ApiFailure> {
    let code = listed_fund(&st, &code)?;
    let (before, after) = (day_in(&query, "before")?, day_in(&query, "after")?);
    if before >= after {
        return Err(ApiFailure::bad_request("before는 after보다 앞선 날짜여야 합니다"));
    }
    let collection = collection_of(&st, code).await;
    history::changes(code, &collection, before, after).map(Json).ok_or_else(|| ApiFailure::new(api::ApiErrorCode::NotFound, format!("{}의 {before}·{after} 수집본이 없습니다", code.as_str())))
}

async fn accumulation(
    State(st): State<Arc<AppState>>,
    Extension(ma_cache): Extension<Arc<MaCache>>,
    Extension(acc_cache): Extension<Arc<accumulation::AccumulationCache>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<EtfAccumulation>, ApiFailure> {
    let window = accumulation::parse_window(&query)?;
    let style = accumulation::parse_style(&query)?;
    Ok(Json(acc_cache.get(&st, &ma_cache, window, style).await))
}
