use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use domain::{KstDate, KstTime, StockCode, TimeOfDay, Weekday};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::catalog::Catalog;
use super::EtfStyle;
use crate::api::{KstDate as ApiKstDate, UnixSeconds};
use crate::config::Secret;
use crate::http::{ApiFailure, AppState};

const STORED_SCHEMA_VERSION: u32 = 1;
const DAYS_DIR: &str = "days";
const STATE_FILE: &str = "state.json";
const CALL_SPACING: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_EMPTY_LOOKBACK_DAYS: i64 = 420;
const SPARKLINE_LEN: usize = 10;

const SCHEDULE_SLOTS: [TimeOfDay; 3] = [
    match TimeOfDay::hms(8, 15, 0) {
        Some(at) => at,
        None => panic!("올바른 시각"),
    },
    match TimeOfDay::hms(19, 10, 0) {
        Some(at) => at,
        None => panic!("올바른 시각"),
    },
    match TimeOfDay::hms(20, 30, 0) {
        Some(at) => at,
        None => panic!("올바른 시각"),
    },
];

const FIRST_SAME_DAY_SLOT: TimeOfDay = SCHEDULE_SLOTS[1];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfSharesState {
    NotConfigured,
    Backfilling,
    Ready,
    AuthFailed,
    RateLimited,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfSharesStatus {
    pub state: EtfSharesState,
    pub configured: bool,
    pub latest_date: Option<ApiKstDate>,
    pub first_date: Option<ApiKstDate>,
    pub collected_days: u32,
    pub backfill_target_days: u32,
    pub last_attempt_at: Option<UnixSeconds>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfFlowDirection {
    #[default]
    Inflow,
    Outflow,
    All,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfFlowScope {
    #[default]
    All,
    Catalog,
    Active,
    Passive,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EtfFlowSort {
    #[default]
    Amount,
    FlowRatio,
    SharePct,
    Aum,
    Streak,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfFlowSummary {
    pub total_etf_count: u32,
    #[ts(type = "number")]
    pub total_aum_won: i64,
    #[ts(type = "number")]
    pub total_net_flow_won: i64,
    pub inflow_etf_count: u32,
    pub outflow_etf_count: u32,
    #[ts(type = "number")]
    pub inflow_total_won: i64,
    #[ts(type = "number")]
    pub outflow_total_won: i64,
    pub top_inflow_code: Option<String>,
    pub top_inflow_name: Option<String>,
    #[ts(type = "number | null")]
    pub top_inflow_won: Option<i64>,
    pub top_outflow_code: Option<String>,
    pub top_outflow_name: Option<String>,
    #[ts(type = "number | null")]
    pub top_outflow_won: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfFlowRankRow {
    pub code: String,
    pub name: String,
    pub issuer: Option<String>,
    pub in_catalog: bool,
    pub style: Option<EtfStyle>,
    #[ts(type = "number")]
    pub listed_shares: u64,
    #[ts(type = "number")]
    pub share_change: i64,
    pub share_change_pct: Option<f64>,
    #[ts(type = "number")]
    pub net_flow_won: i64,
    #[ts(type = "number | null")]
    pub net_flow_1d_won: Option<i64>,
    #[ts(type = "number | null")]
    pub net_flow_5d_won: Option<i64>,
    #[ts(type = "number | null")]
    pub net_flow_20d_won: Option<i64>,
    pub flow_to_aum_pct: Option<f64>,
    #[ts(type = "number")]
    pub aum_won: u64,
    #[ts(type = "number")]
    pub market_cap_won: u64,
    pub nav: f64,
    #[ts(type = "number")]
    pub close_price: u64,
    pub premium_bps: Option<i32>,
    pub streak_days: i32,
    #[ts(type = "Array<number>")]
    pub sparkline_flow: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfFlowRanking {
    pub status: EtfSharesStatus,
    pub window: u32,
    pub direction: EtfFlowDirection,
    pub scope: EtfFlowScope,
    pub sort: EtfFlowSort,
    pub from_date: Option<ApiKstDate>,
    pub to_date: Option<ApiKstDate>,
    pub summary: EtfFlowSummary,
    pub rows: Vec<EtfFlowRankRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfSharesLatest {
    pub date: ApiKstDate,
    #[ts(type = "number")]
    pub listed_shares: u64,
    #[ts(type = "number")]
    pub aum_won: u64,
    #[ts(type = "number")]
    pub market_cap_won: u64,
    pub nav: f64,
    #[ts(type = "number")]
    pub close_price: u64,
    pub premium_bps: Option<i32>,
    #[ts(type = "number | null")]
    pub net_flow_1d_won: Option<i64>,
    #[ts(type = "number | null")]
    pub net_flow_5d_won: Option<i64>,
    #[ts(type = "number | null")]
    pub net_flow_20d_won: Option<i64>,
    pub share_change_5d_pct: Option<f64>,
    pub share_change_20d_pct: Option<f64>,
    pub streak_days: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfSharesPoint {
    pub date: ApiKstDate,
    #[ts(type = "number")]
    pub listed_shares: u64,
    #[ts(type = "number")]
    pub share_delta: i64,
    #[ts(type = "number")]
    pub net_flow_won: i64,
    #[ts(type = "number")]
    pub cum_net_flow_won: i64,
    #[ts(type = "number")]
    pub aum_won: u64,
    #[ts(type = "number")]
    pub market_cap_won: u64,
    pub nav: f64,
    #[ts(type = "number")]
    pub close_price: u64,
    pub premium_bps: Option<i32>,
    #[ts(type = "number")]
    pub trading_value_won: u64,
    pub split_adjusted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EtfSharesSeries {
    pub status: EtfSharesStatus,
    pub code: String,
    pub name: Option<String>,
    pub in_catalog: bool,
    pub latest: Option<EtfSharesLatest>,
    pub points: Vec<EtfSharesPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSharesDay {
    schema_version: u32,
    date: String,
    rows: Vec<StoredSharesRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSharesRow {
    code: String,
    name: String,
    listed_shares: u64,
    aum_won: u64,
    market_cap_won: u64,
    nav: f64,
    close_price: u64,
    trading_value_won: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredErrorKind {
    AuthFailed,
    RateLimited,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSharesError {
    kind: StoredErrorKind,
    message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSharesState {
    schema_version: u32,
    last_attempt_at: Option<i64>,
    empty_days: BTreeSet<String>,
    last_error: Option<StoredSharesError>,
}

#[derive(Debug, Clone)]
struct DayRecord {
    name: String,
    listed_shares: u64,
    aum_won: u64,
    market_cap_won: u64,
    nav: f64,
    close_price: u64,
    trading_value_won: u64,
}

#[derive(Debug, Clone)]
struct DailyFlowStep {
    date: KstDate,
    listed_shares: u64,
    share_delta: i64,
    net_flow_won: i64,
    aum_won: u64,
    market_cap_won: u64,
    nav: f64,
    close_price: u64,
    premium_bps: Option<i32>,
    trading_value_won: u64,
    split_adjusted: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct FundFlowHint {
    pub latest_aum_won: u64,
    pub net_flow_5d_won: Option<i64>,
}

struct SharesStore {
    configured: bool,
    backfill_target_days: u32,
    backfilling: bool,
    last_attempt_at: Option<UnixSeconds>,
    last_error: Option<StoredSharesError>,
    empty_days: BTreeSet<KstDate>,
    days: BTreeMap<KstDate, HashMap<StockCode, DayRecord>>,
    fund_hints: HashMap<StockCode, FundFlowHint>,
}

impl Default for SharesStore {
    fn default() -> Self {
        SharesStore {
            configured: false,
            backfill_target_days: 60,
            backfilling: false,
            last_attempt_at: None,
            last_error: None,
            empty_days: BTreeSet::new(),
            days: BTreeMap::new(),
            fund_hints: HashMap::new(),
        }
    }
}

pub struct EtfSharesBook {
    inner: RwLock<SharesStore>,
}

impl Default for EtfSharesBook {
    fn default() -> Self {
        EtfSharesBook { inner: RwLock::new(SharesStore::default()) }
    }
}

impl EtfSharesBook {
    pub fn fund_hint(&self, code: StockCode) -> Option<FundFlowHint> {
        self.inner.read().expect("ETF 좌수 잠금").fund_hints.get(&code).copied()
    }

    pub fn status(&self) -> EtfSharesStatus {
        let store = self.inner.read().expect("ETF 좌수 잠금");
        status_of(&store)
    }

    pub fn flows(&self, catalog: &Catalog, window: u32, direction: EtfFlowDirection, scope: EtfFlowScope, sort: EtfFlowSort, limit: usize) -> EtfFlowRanking {
        let store = self.inner.read().expect("ETF 좌수 잠금");
        let status = status_of(&store);
        let Some((&to_date, latest_map)) = store.days.iter().next_back() else {
            return EtfFlowRanking {
                status,
                window,
                direction,
                scope,
                sort,
                from_date: None,
                to_date: None,
                summary: EtfFlowSummary::default(),
                rows: Vec::new(),
            };
        };

        let all_dates: Vec<KstDate> = store.days.keys().copied().collect();
        let from_idx = all_dates.len().saturating_sub(1 + window as usize);
        let from_date = all_dates.get(from_idx).copied();

        let mut scoped_rows = Vec::with_capacity(latest_map.len());
        for (&code, latest) in latest_map {
            let catalog_fund = catalog.fund(code);
            let in_catalog = catalog_fund.is_some();
            let style = catalog_fund.map(|fund| fund.style);
            match scope {
                EtfFlowScope::All => {}
                EtfFlowScope::Catalog if !in_catalog => continue,
                EtfFlowScope::Active if style != Some(EtfStyle::Active) => continue,
                EtfFlowScope::Passive if style != Some(EtfStyle::Passive) => continue,
                _ => {}
            }

            let steps = compute_steps(&store.days, code);
            let Some(last_step) = steps.last() else { continue };
            let win_summary = summarize_window(&steps, window as usize);
            let net_flow_1d_won = window_net_flow(&steps, 1);
            let net_flow_5d_won = window_net_flow(&steps, 5);
            let net_flow_20d_won = window_net_flow(&steps, 20);
            let streak_days = compute_streak(&steps);
            let sparkline_flow = steps
                .iter()
                .rev()
                .take(SPARKLINE_LEN)
                .map(|step| step.net_flow_won)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();

            scoped_rows.push(EtfFlowRankRow {
                code: code.as_str().into(),
                name: catalog_fund.map(|fund| fund.name.clone()).unwrap_or_else(|| latest.name.clone()),
                issuer: catalog_fund.map(|fund| fund.issuer.clone()),
                in_catalog,
                style,
                listed_shares: last_step.listed_shares,
                share_change: win_summary.share_change,
                share_change_pct: win_summary.share_change_pct,
                net_flow_won: win_summary.net_flow_won,
                net_flow_1d_won,
                net_flow_5d_won,
                net_flow_20d_won,
                flow_to_aum_pct: win_summary.flow_to_aum_pct,
                aum_won: last_step.aum_won,
                market_cap_won: last_step.market_cap_won,
                nav: last_step.nav,
                close_price: last_step.close_price,
                premium_bps: last_step.premium_bps,
                streak_days,
                sparkline_flow,
            });
        }

        let summary = summarize_market(&scoped_rows);

        let mut rows: Vec<EtfFlowRankRow> = scoped_rows
            .into_iter()
            .filter(|row| match direction {
                EtfFlowDirection::Inflow => row.net_flow_won > 0,
                EtfFlowDirection::Outflow => row.net_flow_won < 0,
                EtfFlowDirection::All => true,
            })
            .collect();

        sort_flow_rows(&mut rows, direction, sort);
        rows.truncate(limit);

        EtfFlowRanking {
            status,
            window,
            direction,
            scope,
            sort,
            from_date: from_date.map(ApiKstDate),
            to_date: Some(ApiKstDate(to_date)),
            summary,
            rows,
        }
    }

    pub fn series(&self, catalog: &Catalog, code: StockCode, days_limit: usize) -> Option<EtfSharesSeries> {
        let store = self.inner.read().expect("ETF 좌수 잠금");
        let status = status_of(&store);
        let catalog_fund = catalog.fund(code);
        let steps = compute_steps(&store.days, code);

        if steps.is_empty() {
            if catalog_fund.is_none() && !store.days.is_empty() {
                return None;
            }
            return Some(EtfSharesSeries {
                status,
                code: code.as_str().into(),
                name: catalog_fund.map(|fund| fund.name.clone()),
                in_catalog: catalog_fund.is_some(),
                latest: None,
                points: Vec::new(),
            });
        }

        let latest_name = store
            .days
            .values()
            .rev()
            .find_map(|day| day.get(&code).map(|row| row.name.clone()));
        let name = catalog_fund.map(|fund| fund.name.clone()).or(latest_name);

        let last = steps.last().expect("위에서 비어 있지 않음을 확인했다");
        let win5 = summarize_window(&steps, 5);
        let win20 = summarize_window(&steps, 20);
        let latest = EtfSharesLatest {
            date: ApiKstDate(last.date),
            listed_shares: last.listed_shares,
            aum_won: last.aum_won,
            market_cap_won: last.market_cap_won,
            nav: last.nav,
            close_price: last.close_price,
            premium_bps: last.premium_bps,
            net_flow_1d_won: window_net_flow(&steps, 1),
            net_flow_5d_won: window_net_flow(&steps, 5),
            net_flow_20d_won: window_net_flow(&steps, 20),
            share_change_5d_pct: win5.share_change_pct,
            share_change_20d_pct: win20.share_change_pct,
            streak_days: compute_streak(&steps),
        };

        let slice_start = steps.len().saturating_sub(days_limit);
        let mut cum: i64 = 0;
        let points = steps[slice_start..]
            .iter()
            .enumerate()
            .map(|(idx, step)| {
                if idx > 0 {
                    cum = cum.saturating_add(step.net_flow_won);
                }
                EtfSharesPoint {
                    date: ApiKstDate(step.date),
                    listed_shares: step.listed_shares,
                    share_delta: step.share_delta,
                    net_flow_won: step.net_flow_won,
                    cum_net_flow_won: cum,
                    aum_won: step.aum_won,
                    market_cap_won: step.market_cap_won,
                    nav: step.nav,
                    close_price: step.close_price,
                    premium_bps: step.premium_bps,
                    trading_value_won: step.trading_value_won,
                    split_adjusted: step.split_adjusted,
                }
            })
            .collect();

        Some(EtfSharesSeries {
            status,
            code: code.as_str().into(),
            name,
            in_catalog: catalog_fund.is_some(),
            latest: Some(latest),
            points,
        })
    }

    fn configure(&self, configured: bool, backfill_target_days: u32) {
        let mut store = self.inner.write().expect("ETF 좌수 잠금");
        store.configured = configured;
        store.backfill_target_days = backfill_target_days;
    }

    fn restore(&self, days: BTreeMap<KstDate, HashMap<StockCode, DayRecord>>, saved: StoredSharesState) {
        let mut store = self.inner.write().expect("ETF 좌수 잠금");
        store.days = days;
        store.last_attempt_at = saved.last_attempt_at.map(UnixSeconds);
        store.last_error = saved.last_error;
        store.empty_days = saved
            .empty_days
            .into_iter()
            .filter_map(|text| KstDate::parse_yyyymmdd(&text))
            .collect();
        rebuild_hints(&mut store);
    }

    fn set_backfilling(&self, active: bool) {
        self.inner.write().expect("ETF 좌수 잠금").backfilling = active;
    }

    fn has_day(&self, day: KstDate) -> bool {
        self.inner.read().expect("ETF 좌수 잠금").days.contains_key(&day)
    }

    fn is_empty_day(&self, day: KstDate) -> bool {
        self.inner.read().expect("ETF 좌수 잠금").empty_days.contains(&day)
    }

    fn record_day(&self, day: KstDate, rows: HashMap<StockCode, DayRecord>, at: UnixSeconds) -> StoredSharesState {
        let mut store = self.inner.write().expect("ETF 좌수 잠금");
        store.days.insert(day, rows);
        store.empty_days.remove(&day);
        store.last_attempt_at = Some(at);
        store.last_error = None;
        rebuild_hints(&mut store);
        export_state(&store)
    }

    fn record_empty(&self, day: KstDate, mark_permanent: bool, at: UnixSeconds) -> StoredSharesState {
        let mut store = self.inner.write().expect("ETF 좌수 잠금");
        if mark_permanent {
            store.empty_days.insert(day);
        }
        store.last_attempt_at = Some(at);
        store.last_error = None;
        export_state(&store)
    }

    fn record_error(&self, kind: StoredErrorKind, message: String, at: UnixSeconds) -> StoredSharesState {
        let mut store = self.inner.write().expect("ETF 좌수 잠금");
        store.last_attempt_at = Some(at);
        store.last_error = Some(StoredSharesError { kind, message });
        export_state(&store)
    }
}

fn export_state(store: &SharesStore) -> StoredSharesState {
    StoredSharesState {
        schema_version: STORED_SCHEMA_VERSION,
        last_attempt_at: store.last_attempt_at.map(|v| v.0),
        empty_days: store.empty_days.iter().map(|d| d.yyyymmdd()).collect(),
        last_error: store.last_error.clone(),
    }
}

fn status_of(store: &SharesStore) -> EtfSharesStatus {
    let latest_date = store.days.keys().next_back().copied().map(ApiKstDate);
    let first_date = store.days.keys().next().copied().map(ApiKstDate);
    let collected_days = store.days.len() as u32;
    let state = match (&store.last_error, store.configured, store.backfilling, collected_days) {
        (Some(err), _, _, _) => match err.kind {
            StoredErrorKind::AuthFailed => EtfSharesState::AuthFailed,
            StoredErrorKind::RateLimited => EtfSharesState::RateLimited,
            StoredErrorKind::Error => EtfSharesState::Error,
        },
        (None, false, _, 0) => EtfSharesState::NotConfigured,
        (None, _, true, _) => EtfSharesState::Backfilling,
        (None, _, false, _) => EtfSharesState::Ready,
    };
    EtfSharesStatus {
        state,
        configured: store.configured,
        latest_date,
        first_date,
        collected_days,
        backfill_target_days: store.backfill_target_days,
        last_attempt_at: store.last_attempt_at,
        message: store.last_error.as_ref().map(|e| e.message.clone()),
    }
}

fn rebuild_hints(store: &mut SharesStore) {
    store.fund_hints.clear();
    let Some(latest_map) = store.days.values().next_back() else {
        return;
    };
    let codes: Vec<(StockCode, u64)> = latest_map.iter().map(|(&code, row)| (code, row.aum_won)).collect();
    for (code, latest_aum_won) in codes {
        let steps = compute_steps(&store.days, code);
        let net_flow_5d_won = window_net_flow(&steps, 5);
        store.fund_hints.insert(code, FundFlowHint { latest_aum_won, net_flow_5d_won });
    }
}

fn reference_price(record: &DayRecord) -> f64 {
    if record.nav.is_finite() && record.nav > 0.0 {
        record.nav
    } else {
        record.close_price as f64
    }
}

fn premium_bps_of(close_price: u64, nav: f64) -> Option<i32> {
    if !nav.is_finite() || nav <= 0.0 || close_price == 0 {
        return None;
    }
    let ratio = (close_price as f64 - nav) / nav * 10_000.0;
    ratio.is_finite().then_some(ratio.round() as i32)
}

fn is_split_event(prev: &DayRecord, curr: &DayRecord) -> bool {
    if prev.listed_shares == 0 || curr.listed_shares == 0 {
        return false;
    }
    let share_ratio = curr.listed_shares as f64 / prev.listed_shares as f64;
    if share_ratio > 0.55 && share_ratio < 1.8 {
        return false;
    }
    let prev_price = reference_price(prev);
    let curr_price = reference_price(curr);
    if prev_price <= 0.0 || curr_price <= 0.0 {
        return false;
    }
    let nav_ratio = curr_price / prev_price;
    let combined = share_ratio * nav_ratio;
    combined.is_finite() && (combined - 1.0).abs() <= 0.15
}

fn compute_steps(days: &BTreeMap<KstDate, HashMap<StockCode, DayRecord>>, code: StockCode) -> Vec<DailyFlowStep> {
    let mut steps = Vec::new();
    let mut prev: Option<&DayRecord> = None;
    for (&date, day_map) in days {
        let Some(curr) = day_map.get(&code) else { continue };
        let (share_delta, net_flow_won, split_adjusted) = match prev {
            None => (0, 0, false),
            Some(before) if is_split_event(before, curr) => (0, 0, true),
            Some(before) => {
                let delta = curr.listed_shares as i128 - before.listed_shares as i128;
                let price = reference_price(curr);
                let flow = (delta as f64 * price).round();
                let flow_won = if flow.is_finite() { flow.clamp(i64::MIN as f64, i64::MAX as f64) as i64 } else { 0 };
                let delta_i64 = delta.clamp(i64::MIN as i128, i64::MAX as i128) as i64;
                (delta_i64, flow_won, false)
            }
        };
        steps.push(DailyFlowStep {
            date,
            listed_shares: curr.listed_shares,
            share_delta,
            net_flow_won,
            aum_won: curr.aum_won,
            market_cap_won: curr.market_cap_won,
            nav: curr.nav,
            close_price: curr.close_price,
            premium_bps: premium_bps_of(curr.close_price, curr.nav),
            trading_value_won: curr.trading_value_won,
            split_adjusted,
        });
        prev = Some(curr);
    }
    steps
}

struct WindowSummary {
    share_change: i64,
    share_change_pct: Option<f64>,
    net_flow_won: i64,
    flow_to_aum_pct: Option<f64>,
}

fn summarize_window(steps: &[DailyFlowStep], window: usize) -> WindowSummary {
    if steps.len() < 2 || window == 0 {
        return WindowSummary { share_change: 0, share_change_pct: None, net_flow_won: 0, flow_to_aum_pct: None };
    }
    let effective = window.min(steps.len() - 1);
    let base_idx = steps.len() - 1 - effective;
    let base = &steps[base_idx];
    let mut net_flow_won: i64 = 0;
    let mut share_change: i64 = 0;
    for step in &steps[base_idx + 1..] {
        net_flow_won = net_flow_won.saturating_add(step.net_flow_won);
        share_change = share_change.saturating_add(step.share_delta);
    }
    let share_change_pct = (base.listed_shares > 0).then_some(share_change as f64 / base.listed_shares as f64 * 100.0);
    let flow_to_aum_pct = (base.aum_won > 0).then_some(net_flow_won as f64 / base.aum_won as f64 * 100.0);
    WindowSummary { share_change, share_change_pct, net_flow_won, flow_to_aum_pct }
}

fn window_net_flow(steps: &[DailyFlowStep], window: usize) -> Option<i64> {
    if steps.len() < 2 || window == 0 {
        return None;
    }
    let effective = window.min(steps.len() - 1);
    let start = steps.len() - effective;
    Some(steps[start..].iter().fold(0i64, |acc, step| acc.saturating_add(step.net_flow_won)))
}

fn compute_streak(steps: &[DailyFlowStep]) -> i32 {
    let mut streak = 0i32;
    for step in steps.iter().skip(1).rev() {
        if step.net_flow_won == 0 {
            break;
        }
        if streak == 0 {
            streak = if step.net_flow_won > 0 { 1 } else { -1 };
        } else if (streak > 0 && step.net_flow_won > 0) || (streak < 0 && step.net_flow_won < 0) {
            streak += if streak > 0 { 1 } else { -1 };
        } else {
            break;
        }
    }
    streak
}

fn summarize_market(rows: &[EtfFlowRankRow]) -> EtfFlowSummary {
    let mut summary = EtfFlowSummary { total_etf_count: rows.len() as u32, ..Default::default() };
    let mut top_in: Option<(&str, &str, i64)> = None;
    let mut top_out: Option<(&str, &str, i64)> = None;
    for row in rows {
        summary.total_aum_won = summary.total_aum_won.saturating_add(row.aum_won.min(i64::MAX as u64) as i64);
        summary.total_net_flow_won = summary.total_net_flow_won.saturating_add(row.net_flow_won);
        if row.net_flow_won > 0 {
            summary.inflow_etf_count += 1;
            summary.inflow_total_won = summary.inflow_total_won.saturating_add(row.net_flow_won);
            if top_in.is_none_or(|(_, _, v)| row.net_flow_won > v) {
                top_in = Some((&row.code, &row.name, row.net_flow_won));
            }
        } else if row.net_flow_won < 0 {
            summary.outflow_etf_count += 1;
            summary.outflow_total_won = summary.outflow_total_won.saturating_add(row.net_flow_won);
            if top_out.is_none_or(|(_, _, v)| row.net_flow_won < v) {
                top_out = Some((&row.code, &row.name, row.net_flow_won));
            }
        }
    }
    if let Some((code, name, won)) = top_in {
        summary.top_inflow_code = Some(code.into());
        summary.top_inflow_name = Some(name.into());
        summary.top_inflow_won = Some(won);
    }
    if let Some((code, name, won)) = top_out {
        summary.top_outflow_code = Some(code.into());
        summary.top_outflow_name = Some(name.into());
        summary.top_outflow_won = Some(won);
    }
    summary
}

fn cmp_opt_f64_desc(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => y.total_cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn cmp_opt_f64_asc(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.total_cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn sort_flow_rows(rows: &mut [EtfFlowRankRow], direction: EtfFlowDirection, sort: EtfFlowSort) {
    rows.sort_by(|a, b| {
        let primary = match (sort, direction) {
            (EtfFlowSort::Amount, EtfFlowDirection::Outflow) => a.net_flow_won.cmp(&b.net_flow_won),
            (EtfFlowSort::Amount, EtfFlowDirection::Inflow) => b.net_flow_won.cmp(&a.net_flow_won),
            (EtfFlowSort::Amount, EtfFlowDirection::All) => b.net_flow_won.unsigned_abs().cmp(&a.net_flow_won.unsigned_abs()),
            (EtfFlowSort::FlowRatio, EtfFlowDirection::Outflow) => cmp_opt_f64_asc(a.flow_to_aum_pct, b.flow_to_aum_pct),
            (EtfFlowSort::FlowRatio, _) => cmp_opt_f64_desc(a.flow_to_aum_pct, b.flow_to_aum_pct),
            (EtfFlowSort::SharePct, EtfFlowDirection::Outflow) => cmp_opt_f64_asc(a.share_change_pct, b.share_change_pct),
            (EtfFlowSort::SharePct, _) => cmp_opt_f64_desc(a.share_change_pct, b.share_change_pct),
            (EtfFlowSort::Aum, _) => b.aum_won.cmp(&a.aum_won),
            (EtfFlowSort::Streak, EtfFlowDirection::Outflow) => a.streak_days.cmp(&b.streak_days),
            (EtfFlowSort::Streak, EtfFlowDirection::Inflow) => b.streak_days.cmp(&a.streak_days),
            (EtfFlowSort::Streak, EtfFlowDirection::All) => b.streak_days.unsigned_abs().cmp(&a.streak_days.unsigned_abs()),
        };
        primary.then_with(|| a.code.cmp(&b.code))
    });
}

pub(super) fn parse_window(query: &HashMap<String, String>) -> Result<u32, ApiFailure> {
    match query.get("window").map(String::as_str) {
        None | Some("5") => Ok(5),
        Some("1") => Ok(1),
        Some("20") => Ok(20),
        Some("60") => Ok(60),
        Some(other) => Err(ApiFailure::bad_request(format!("window는 1, 5, 20, 60 중 하나입니다: {other}"))),
    }
}

pub(super) fn parse_direction(query: &HashMap<String, String>) -> Result<EtfFlowDirection, ApiFailure> {
    match query.get("direction").map(String::as_str) {
        None | Some("inflow") => Ok(EtfFlowDirection::Inflow),
        Some("outflow") => Ok(EtfFlowDirection::Outflow),
        Some("all") => Ok(EtfFlowDirection::All),
        Some(other) => Err(ApiFailure::bad_request(format!("direction은 inflow, outflow, all 중 하나입니다: {other}"))),
    }
}

pub(super) fn parse_scope(query: &HashMap<String, String>) -> Result<EtfFlowScope, ApiFailure> {
    match query.get("scope").map(String::as_str) {
        None | Some("all") => Ok(EtfFlowScope::All),
        Some("catalog") => Ok(EtfFlowScope::Catalog),
        Some("active") => Ok(EtfFlowScope::Active),
        Some("passive") => Ok(EtfFlowScope::Passive),
        Some(other) => Err(ApiFailure::bad_request(format!("scope는 all, catalog, active, passive 중 하나입니다: {other}"))),
    }
}

pub(super) fn parse_sort(query: &HashMap<String, String>) -> Result<EtfFlowSort, ApiFailure> {
    match query.get("sort").map(String::as_str) {
        None | Some("amount") => Ok(EtfFlowSort::Amount),
        Some("flow_ratio") => Ok(EtfFlowSort::FlowRatio),
        Some("share_pct") => Ok(EtfFlowSort::SharePct),
        Some("aum") => Ok(EtfFlowSort::Aum),
        Some("streak") => Ok(EtfFlowSort::Streak),
        Some(other) => Err(ApiFailure::bad_request(format!("sort는 amount, flow_ratio, share_pct, aum, streak 중 하나입니다: {other}"))),
    }
}

pub(super) fn parse_limit(query: &HashMap<String, String>) -> Result<usize, ApiFailure> {
    match query.get("limit").map(String::as_str) {
        None => Ok(100),
        Some(text) => match text.parse::<usize>() {
            Ok(n) if (1..=1000).contains(&n) => Ok(n),
            _ => Err(ApiFailure::bad_request(format!("limit는 1~1000 정수입니다: {text}"))),
        },
    }
}

pub(super) fn parse_days(query: &HashMap<String, String>) -> Result<usize, ApiFailure> {
    match query.get("days").map(String::as_str) {
        None | Some("60") => Ok(60),
        Some("20") => Ok(20),
        Some("120") => Ok(120),
        Some("250") => Ok(250),
        Some(other) => Err(ApiFailure::bad_request(format!("days는 20, 60, 120, 250 중 하나입니다: {other}"))),
    }
}

#[derive(Deserialize)]
struct KrxResponse {
    #[serde(rename = "OutBlock_1", default)]
    out_block_1: Vec<KrxRow>,
}

#[derive(Deserialize)]
struct KrxRow {
    #[serde(rename = "BAS_DD", default)]
    bas_dd: String,
    #[serde(rename = "ISU_CD", default)]
    isu_cd: String,
    #[serde(rename = "ISU_NM", default)]
    isu_nm: String,
    #[serde(rename = "TDD_CLSPRC", default)]
    tdd_clsprc: String,
    #[serde(rename = "NAV", default)]
    nav: String,
    #[serde(rename = "ACC_TRDVAL", default)]
    acc_trdval: String,
    #[serde(rename = "MKTCAP", default)]
    mktcap: String,
    #[serde(rename = "INVSTASST_NETASST_TOTAMT", default)]
    invstasst_netasst_totamt: String,
    #[serde(rename = "LIST_SHRS", default)]
    list_shrs: String,
}

enum FetchError {
    AuthFailed(String),
    RateLimited(String),
    Other(String),
}

struct KrxClient {
    http: reqwest::Client,
    base: String,
    api_key: Secret<String>,
}

impl KrxClient {
    fn new(base: String, api_key: Secret<String>) -> Result<KrxClient, reqwest::Error> {
        let http = reqwest::Client::builder()
            .tls_backend_native()
            .user_agent(concat!("vallythevally/", env!("CARGO_PKG_VERSION")))
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(KrxClient { http, base, api_key })
    }

    async fn fetch_day(&self, day: KstDate) -> Result<Vec<StoredSharesRow>, FetchError> {
        let yyyymmdd = day.yyyymmdd();
        let url = format!("{}/svc/apis/etp/etf_bydd_trd?basDd={yyyymmdd}", self.base);
        let response = self
            .http
            .get(&url)
            .header("AUTH_KEY", self.api_key.expose())
            .send()
            .await
            .map_err(|e| FetchError::Other(format!("KRX 요청 실패: {}", e.without_url())))?;
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            return Err(FetchError::AuthFailed(format!("KRX Open API 인증 실패 (HTTP {status})")));
        }
        if status == 429 {
            return Err(FetchError::RateLimited("KRX Open API 일일 호출 한도를 초과했습니다 (HTTP 429)".into()));
        }
        if !(200..300).contains(&status) {
            return Err(FetchError::Other(format!("KRX 응답 오류 (HTTP {status})")));
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| FetchError::Other(format!("KRX 응답 수신 실패: {}", e.without_url())))?;
        if body.len() > MAX_BODY_BYTES {
            return Err(FetchError::Other(format!("KRX 응답이 {MAX_BODY_BYTES}바이트를 넘습니다")));
        }
        parse_krx_response(&body, day).map_err(FetchError::Other)
    }
}

fn parse_krx_code(raw: &str) -> Option<StockCode> {
    let trimmed = raw.trim();
    if let Ok(code) = StockCode::parse(trimmed) {
        return Some(code);
    }
    if trimmed.len() == 12 && trimmed.starts_with("KR7") {
        return StockCode::parse(&trimmed[3..9]).ok();
    }
    None
}

fn parse_u64_field(raw: &str) -> u64 {
    let cleaned: String = raw.trim().chars().filter(|&c| c != ',').collect();
    cleaned.parse::<u64>().unwrap_or(0)
}

fn parse_f64_field(raw: &str) -> f64 {
    let cleaned: String = raw.trim().chars().filter(|&c| c != ',').collect();
    cleaned.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(0.0)
}

fn parse_krx_response(body: &[u8], expected_day: KstDate) -> Result<Vec<StoredSharesRow>, String> {
    let parsed: KrxResponse = serde_json::from_slice(body).map_err(|e| format!("KRX JSON을 읽을 수 없습니다: {e}"))?;
    if parsed.out_block_1.is_empty() {
        return Ok(Vec::new());
    }
    let expected = expected_day.yyyymmdd();
    let mut rows = Vec::with_capacity(parsed.out_block_1.len());
    let mut seen = BTreeSet::new();
    for item in parsed.out_block_1 {
        let bas_dd = item.bas_dd.trim();
        if !bas_dd.is_empty() && bas_dd != expected {
            return Err(format!("기준일({bas_dd})이 요청일({expected})과 다릅니다"));
        }
        let Some(code) = parse_krx_code(&item.isu_cd) else { continue };
        let listed_shares = parse_u64_field(&item.list_shrs);
        if listed_shares == 0 {
            continue;
        }
        if !seen.insert(code) {
            return Err(format!("중복 ETF 코드가 있습니다: {}", code.as_str()));
        }
        rows.push(StoredSharesRow {
            code: code.as_str().into(),
            name: item.isu_nm.trim().into(),
            listed_shares,
            aum_won: parse_u64_field(&item.invstasst_netasst_totamt),
            market_cap_won: parse_u64_field(&item.mktcap),
            nav: parse_f64_field(&item.nav),
            close_price: parse_u64_field(&item.tdd_clsprc),
            trading_value_won: parse_u64_field(&item.acc_trdval),
        });
    }
    Ok(rows)
}

fn day_file_path(dir: &Path, day: KstDate) -> PathBuf {
    dir.join(DAYS_DIR).join(format!("{}.json", day.yyyymmdd()))
}

async fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    tokio::fs::write(&temporary, bytes).await?;
    tokio::fs::rename(&temporary, path).await
}

async fn save_day(dir: &Path, day: KstDate, rows: &[StoredSharesRow]) -> std::io::Result<()> {
    let days_dir = dir.join(DAYS_DIR);
    tokio::fs::create_dir_all(&days_dir).await?;
    let stored = StoredSharesDay { schema_version: STORED_SCHEMA_VERSION, date: day.to_string(), rows: rows.to_vec() };
    write_atomically(&day_file_path(dir, day), &serde_json::to_vec(&stored)?).await
}

async fn save_state(dir: &Path, state: &StoredSharesState) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    write_atomically(&dir.join(STATE_FILE), &serde_json::to_vec(state)?).await
}

async fn load_from_disk(dir: &Path) -> (BTreeMap<KstDate, HashMap<StockCode, DayRecord>>, StoredSharesState) {
    let state = match tokio::fs::read(dir.join(STATE_FILE)).await {
        Ok(bytes) => serde_json::from_slice::<StoredSharesState>(&bytes).unwrap_or_default(),
        Err(_) => StoredSharesState::default(),
    };
    let mut days = BTreeMap::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir.join(DAYS_DIR)).await else {
        return (days, state);
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = file_name.strip_suffix(".json") else { continue };
        let Some(day) = KstDate::parse_yyyymmdd(stem) else { continue };
        let Ok(bytes) = tokio::fs::read(entry.path()).await else { continue };
        match decode_day_file(&bytes, day) {
            Ok(map) => {
                days.insert(day, map);
            }
            Err(reason) => tracing::warn!(file = %entry.path().display(), %reason, "저장된 ETF 상장좌수 파일을 싣지 않습니다"),
        }
    }
    (days, state)
}

fn decode_day_file(bytes: &[u8], expected_day: KstDate) -> Result<HashMap<StockCode, DayRecord>, String> {
    let stored: StoredSharesDay = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if stored.schema_version != STORED_SCHEMA_VERSION || stored.date != expected_day.to_string() {
        return Err("자료 버전 또는 기준일이 파일 위치와 다릅니다".into());
    }
    Ok(to_record_map(&stored.rows))
}

fn to_record_map(rows: &[StoredSharesRow]) -> HashMap<StockCode, DayRecord> {
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        let Ok(code) = StockCode::parse(&row.code) else { continue };
        map.insert(
            code,
            DayRecord {
                name: row.name.clone(),
                listed_shares: row.listed_shares,
                aum_won: row.aum_won,
                market_cap_won: row.market_cap_won,
                nav: row.nav,
                close_price: row.close_price,
                trading_value_won: row.trading_value_won,
            },
        );
    }
    map
}

fn is_weekday(day: KstDate) -> bool {
    !matches!(day.weekday(), Weekday::Sat | Weekday::Sun)
}

fn latest_candidate_day(now: KstTime) -> KstDate {
    let today = now.kst_date();
    if is_weekday(today) && now >= KstTime::from_kst_civil(today, FIRST_SAME_DAY_SLOT) {
        today
    } else {
        let mut cursor = today.add_days(-1);
        while !is_weekday(cursor) {
            cursor = cursor.add_days(-1);
        }
        cursor
    }
}

fn next_schedule_slot(now: KstTime) -> KstTime {
    let today = now.kst_date();
    for slot in SCHEDULE_SLOTS {
        let at = KstTime::from_kst_civil(today, slot);
        if at > now {
            return at;
        }
    }
    KstTime::from_kst_civil(today.add_days(1), SCHEDULE_SLOTS[0])
}

pub fn start(state: Arc<AppState>, dir: PathBuf, base_url: String, api_key: Option<Secret<String>>, backfill_days: u32) -> tokio::task::JoinHandle<()> {
    let configured = api_key.is_some();
    state.etf.shares().configure(configured, backfill_days);
    tokio::spawn(async move {
        let (days, saved_state) = load_from_disk(&dir).await;
        state.etf.shares().restore(days, saved_state);
        let Some(key) = api_key else {
            tracing::info!("VALLY_KRX_API_KEY가 없어 ETF 상장좌수 수집을 끕니다");
            return;
        };
        match KrxClient::new(base_url, key) {
            Ok(client) => run_loop(state, dir, client, backfill_days as usize).await,
            Err(e) => tracing::error!(error = %e, "KRX Open API용 HTTP 클라이언트를 만들 수 없습니다"),
        }
    })
}

async fn run_loop(st: Arc<AppState>, dir: PathBuf, client: KrxClient, backfill_days: usize) {
    loop {
        let now = st.clock.now();
        backfill_recent(&st, &dir, &client, backfill_days, now).await;
        let wake_at = next_schedule_slot(st.clock.now());
        st.clock.sleep_until(wake_at).await;
    }
}

async fn backfill_recent(st: &AppState, dir: &Path, client: &KrxClient, target_days: usize, now: KstTime) {
    let start_day = latest_candidate_day(now);
    let today = now.kst_date();
    let mut cursor = start_day;
    let mut looked = 0i64;
    let mut covered = 0usize;
    let mut last_finished: Option<tokio::time::Instant> = None;

    st.etf.shares().set_backfilling(true);

    while covered < target_days && looked < MAX_EMPTY_LOOKBACK_DAYS {
        if !is_weekday(cursor) {
            cursor = cursor.add_days(-1);
            looked += 1;
            continue;
        }
        if st.etf.shares().has_day(cursor) {
            covered += 1;
            cursor = cursor.add_days(-1);
            looked += 1;
            continue;
        }
        if st.etf.shares().is_empty_day(cursor) {
            cursor = cursor.add_days(-1);
            looked += 1;
            continue;
        }
        if let Some(last) = last_finished {
            tokio::time::sleep_until(last + CALL_SPACING).await;
        }
        let outcome = fetch_and_persist_day(st, dir, client, cursor, cursor < today).await;
        last_finished = Some(tokio::time::Instant::now());
        match outcome {
            StepOutcome::Stored => covered += 1,
            StepOutcome::Empty => {}
            StepOutcome::AbortLoop => break,
        }
        cursor = cursor.add_days(-1);
        looked += 1;
    }

    st.etf.shares().set_backfilling(false);
}

#[derive(PartialEq, Eq)]
enum StepOutcome {
    Stored,
    Empty,
    AbortLoop,
}

async fn fetch_and_persist_day(st: &AppState, dir: &Path, client: &KrxClient, day: KstDate, permanent_empty: bool) -> StepOutcome {
    let at = UnixSeconds(st.clock.now().unix());
    match client.fetch_day(day).await {
        Ok(rows) if rows.is_empty() => {
            let state = st.etf.shares().record_empty(day, permanent_empty, at);
            if let Err(e) = save_state(dir, &state).await {
                tracing::warn!(error = %e, "ETF 상장좌수 상태를 저장하지 못했습니다");
            }
            StepOutcome::Empty
        }
        Ok(rows) => {
            if let Err(e) = save_day(dir, day, &rows).await {
                tracing::warn!(date = %day, error = %e, "ETF 상장좌수 일별 파일을 저장하지 못했습니다");
                let state = st.etf.shares().record_error(StoredErrorKind::Error, format!("저장 실패: {e}"), at);
                let _ = save_state(dir, &state).await;
                return StepOutcome::AbortLoop;
            }
            let state = st.etf.shares().record_day(day, to_record_map(&rows), at);
            if let Err(e) = save_state(dir, &state).await {
                tracing::warn!(error = %e, "ETF 상장좌수 상태를 저장하지 못했습니다");
            }
            StepOutcome::Stored
        }
        Err(FetchError::AuthFailed(message)) => {
            tracing::warn!(date = %day, %message, "KRX Open API 인증 오류로 ETF 상장좌수 수집을 멈춥니다");
            let state = st.etf.shares().record_error(StoredErrorKind::AuthFailed, message, at);
            let _ = save_state(dir, &state).await;
            StepOutcome::AbortLoop
        }
        Err(FetchError::RateLimited(message)) => {
            tracing::warn!(date = %day, %message, "KRX Open API 호출 한도로 ETF 상장좌수 수집을 멈춥니다");
            let state = st.etf.shares().record_error(StoredErrorKind::RateLimited, message, at);
            let _ = save_state(dir, &state).await;
            StepOutcome::AbortLoop
        }
        Err(FetchError::Other(message)) => {
            tracing::warn!(date = %day, %message, "ETF 상장좌수 일별 수집에 실패했습니다");
            let state = st.etf.shares().record_error(StoredErrorKind::Error, message, at);
            let _ = save_state(dir, &state).await;
            StepOutcome::AbortLoop
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(shares: u64, nav: f64, close_price: u64, aum_won: u64) -> DayRecord {
        DayRecord {
            name: "테스트ETF".into(),
            listed_shares: shares,
            aum_won,
            market_cap_won: shares * close_price,
            nav,
            close_price,
            trading_value_won: 1_000_000_000,
        }
    }

    #[test]
    fn split_event_is_detected_and_zeroed_out() {
        let code = StockCode::parse("445290").unwrap();
        let d1 = KstDate::new(2026, 11, 18).unwrap();
        let d2 = KstDate::new(2026, 11, 19).unwrap();
        let d3 = KstDate::new(2026, 11, 20).unwrap();
        let mut days = BTreeMap::new();
        days.insert(d1, HashMap::from([(code, record(1_000_000, 20_000.0, 20_050, 20_000_000_000))]));
        days.insert(d2, HashMap::from([(code, record(2_000_000, 10_100.0, 10_120, 20_200_000_000))]));
        days.insert(d3, HashMap::from([(code, record(2_100_000, 10_200.0, 10_210, 21_420_000_000))]));

        let steps = compute_steps(&days, code);
        assert_eq!(steps.len(), 3);
        assert!(!steps[0].split_adjusted);
        assert!(steps[1].split_adjusted);
        assert_eq!(steps[1].share_delta, 0);
        assert_eq!(steps[1].net_flow_won, 0);
        assert!(!steps[2].split_adjusted);
        assert_eq!(steps[2].share_delta, 100_000);
        assert_eq!(steps[2].net_flow_won, 1_020_000_000);
    }

    #[test]
    fn large_legitimate_creation_is_not_treated_as_split() {
        let prev = record(1_000_000, 20_000.0, 20_000, 20_000_000_000);
        let curr = record(2_000_000, 20_200.0, 20_200, 40_400_000_000);
        assert!(!is_split_event(&prev, &curr));
    }

    #[test]
    fn krx_parser_accepts_short_and_isin_codes_and_strips_commas() {
        let day = KstDate::new(2026, 11, 20).unwrap();
        let body = serde_json::json!({
            "OutBlock_1": [
                {
                    "BAS_DD": "20261120",
                    "ISU_CD": "091160",
                    "ISU_NM": "KODEX 반도체",
                    "TDD_CLSPRC": "44,850",
                    "NAV": "44,800.50",
                    "ACC_TRDVAL": "12,345,678,900",
                    "MKTCAP": "861,120,000,000",
                    "INVSTASST_NETASST_TOTAMT": "860,169,600,000",
                    "LIST_SHRS": "19,200,000"
                },
                {
                    "BAS_DD": "20261120",
                    "ISU_CD": "KR7445290001",
                    "ISU_NM": "KODEX 로봇액티브",
                    "TDD_CLSPRC": "22,300",
                    "NAV": "22,250.00",
                    "ACC_TRDVAL": "5,000,000,000",
                    "MKTCAP": "307,740,000,000",
                    "INVSTASST_NETASST_TOTAMT": "307,050,000,000",
                    "LIST_SHRS": "13,800,000"
                }
            ]
        })
        .to_string();
        let rows = parse_krx_response(body.as_bytes(), day).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].code, "091160");
        assert_eq!(rows[0].listed_shares, 19_200_000);
        assert_eq!(rows[0].aum_won, 860_169_600_000);
        assert_eq!(rows[1].code, "445290");
        assert_eq!(rows[1].listed_shares, 13_800_000);
    }

    #[test]
    fn streak_counts_consecutive_inflows_and_outflows() {
        let code = StockCode::parse("091160").unwrap();
        let mut days = BTreeMap::new();
        for (idx, shares) in [1_000_000u64, 900_000, 1_000_000, 1_100_000, 1_200_000].into_iter().enumerate() {
            let day = KstDate::new(2026, 11, 16 + idx as u8).unwrap();
            days.insert(day, HashMap::from([(code, record(shares, 10_000.0, 10_000, shares * 10_000))]));
        }
        let steps = compute_steps(&days, code);
        assert_eq!(compute_streak(&steps), 3);
    }
}
