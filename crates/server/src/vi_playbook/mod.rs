use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as AxumPath, Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{KstDate, KstTime, StockCode, Symbol, TimeOfDay};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{self, ApiErrorCode, SymbolCode, ViDirection};
use crate::collected::Collected;
use crate::collected::kind::{CollectedExpectedTrade, CollectedTradeTick, CollectedViEvent, ViKind};
use crate::collected_store::read_stamp;
use crate::http::{ApiFailure, AppState};
use crate::market_source::vi::{ViDirection as SourceViDirection, ViMarket};
use crate::shared_data::CollectorPaths;

pub const LOOKBACK_TRADING_DAYS: usize = 60;
pub const RECENT_MATCHES_LIMIT: usize = 10;
pub const PLAYBOOK_CACHE_CAPACITY: usize = 16;

const DEFAULT_VI_DURATION_SECS: u32 = 120;
const LATE_WINDOW_SECS: u32 = 15;
const LATE_PRICE_DROP_THRESHOLD: f64 = 0.005;
const LATE_VOLUME_SHRINK_RATIO: f64 = 0.70;
const HORIZON_MINUTES: [u32; 4] = [1, 3, 5, 10];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ViPlaybookKind {
    Dynamic,
    Static,
    #[default]
    All,
}

impl ViPlaybookKind {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "dynamic" => Some(Self::Dynamic),
            "static" => Some(Self::Static),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    fn matches(self, kind: ViKind) -> bool {
        match self {
            Self::All => true,
            Self::Dynamic => matches!(kind, ViKind::Dynamic | ViKind::Both),
            Self::Static => matches!(kind, ViKind::Static | ViKind::Both),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ViPlaybookHorizon {
    pub minutes: u32,
    pub samples: u32,
    pub win_rate_pct: f64,
    pub avg_return_pct: f64,
    pub avg_mae_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ViPlaybookMatch {
    pub date: api::KstDate,
    pub triggered_at: String,
    pub released_at: Option<String>,
    pub kind: String,
    #[ts(type = "number | null")]
    pub trigger_price: Option<u64>,
    #[ts(type = "number | null")]
    pub release_price: Option<u64>,
    pub return_1m_pct: Option<f64>,
    pub return_3m_pct: Option<f64>,
    pub return_5m_pct: Option<f64>,
    pub return_10m_pct: Option<f64>,
    pub mae_5m_pct: Option<f64>,
    pub late_drop_detected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ViPlaybook {
    pub symbol: SymbolCode,
    pub direction: ViDirection,
    pub kind: ViPlaybookKind,
    pub lookback_days: u32,
    pub sample_count: u32,
    pub horizons: Vec<ViPlaybookHorizon>,
    pub recent_matches: Vec<ViPlaybookMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    stock: StockCode,
    direction: ViDirection,
    kind: ViPlaybookKind,
    store_stamp: String,
}

struct PlaybookLru {
    capacity: usize,
    order: VecDeque<CacheKey>,
    entries: HashMap<CacheKey, ViPlaybook>,
}

impl PlaybookLru {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::with_capacity(capacity),
            entries: HashMap::with_capacity(capacity),
        }
    }

    fn get(&mut self, key: &CacheKey) -> Option<ViPlaybook> {
        let value = self.entries.get(key)?.clone();
        if let Some(pos) = self.order.iter().position(|candidate| candidate == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
        Some(value)
    }

    fn insert(&mut self, key: CacheKey, value: ViPlaybook) {
        if let Some(pos) = self.order.iter().position(|candidate| candidate == &key) {
            self.order.remove(pos);
        } else if self.order.len() >= self.capacity
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

pub struct ViPlaybookCache {
    lru: Mutex<PlaybookLru>,
}

impl ViPlaybookCache {
    pub fn new() -> Arc<Self> {
        Self::with_capacity(PLAYBOOK_CACHE_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            lru: Mutex::new(PlaybookLru::with_capacity(capacity)),
        })
    }

    fn get(&self, key: &CacheKey) -> Option<ViPlaybook> {
        self.lru.lock().expect("vi playbook cache").get(key)
    }

    fn insert(&self, key: CacheKey, value: ViPlaybook) {
        self.lru.lock().expect("vi playbook cache").insert(key, value);
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    let cache = ViPlaybookCache::new();
    Router::new()
        .route("/api/symbols/{code}/vi-playbook", get(vi_playbook))
        .layer(Extension(cache))
}

async fn vi_playbook(
    State(st): State<Arc<AppState>>,
    Extension(cache): Extension<Arc<ViPlaybookCache>>,
    AxumPath(code): AxumPath<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<ViPlaybook>, ApiFailure> {
    let stock = parse_stock(&code)?;
    let direction = parse_direction(&q)?;
    let kind = parse_kind(&q)?;
    let paths = st.collector_paths.snapshot();
    let playbook = query_playbook(&st.collected, &cache, paths, stock, direction, kind, st.clock.now())
        .await
        .map_err(|detail| internal_error("과거 VI 이력을 계산하지 못했습니다", detail))?;
    Ok(Json(playbook))
}

fn parse_stock(code: &str) -> Result<StockCode, ApiFailure> {
    match Symbol::parse(code).map_err(|e| ApiFailure::bad_request(e.to_string()))? {
        Symbol::Stock(stock) => Ok(stock),
        Symbol::Index(_) => Err(ApiFailure::bad_request("지수에는 VI 이력이 없습니다")),
    }
}

fn parse_direction(q: &HashMap<String, String>) -> Result<ViDirection, ApiFailure> {
    match q.get("direction").map(String::as_str) {
        None | Some("up") => Ok(ViDirection::Up),
        Some("down") => Ok(ViDirection::Down),
        Some(other) => Err(ApiFailure::bad_request(format!("direction은 up 또는 down이어야 합니다: {other}"))),
    }
}

fn parse_kind(q: &HashMap<String, String>) -> Result<ViPlaybookKind, ApiFailure> {
    match q.get("kind").map(String::as_str) {
        None => Ok(ViPlaybookKind::All),
        Some(raw) => ViPlaybookKind::parse(raw)
            .ok_or_else(|| ApiFailure::bad_request(format!("kind는 dynamic, static 또는 all이어야 합니다: {raw}"))),
    }
}

fn internal_error(context: &str, detail: String) -> ApiFailure {
    tracing::error!(reason = %detail, "{context}");
    ApiFailure::new(ApiErrorCode::Internal, context)
}

fn empty_playbook(stock: StockCode, direction: ViDirection, kind: ViPlaybookKind, lookback_days: u32) -> ViPlaybook {
    ViPlaybook {
        symbol: SymbolCode(Symbol::Stock(stock).as_wire()),
        direction,
        kind,
        lookback_days,
        sample_count: 0,
        horizons: Vec::new(),
        recent_matches: Vec::new(),
    }
}

struct FinalizedDays {
    days: Vec<(String, KstDate)>,
    store_stamp: String,
}

fn collect_finalized_days(hoga_dir: &Path, candidate_days: Vec<String>) -> Result<FinalizedDays, String> {
    let mut finalized: Vec<(String, KstDate, String)> = Vec::new();
    for date_str in candidate_days {
        let Some(date) = KstDate::parse_yyyymmdd(&date_str) else {
            continue;
        };
        if let Some(stamp) = read_stamp(hoga_dir, &date_str)? {
            finalized.push((date_str, date, stamp.token()));
        }
    }
    finalized.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    if finalized.len() > LOOKBACK_TRADING_DAYS {
        let start = finalized.len() - LOOKBACK_TRADING_DAYS;
        finalized.drain(..start);
    }
    let store_stamp = match finalized.last() {
        Some((newest_date, _, token)) => format!("{}:{newest_date}:{token}", finalized.len()),
        None => String::from("0"),
    };
    let days = finalized.into_iter().map(|(date_str, date, _)| (date_str, date)).collect();
    Ok(FinalizedDays { days, store_stamp })
}

pub async fn query_playbook(
    collected: &Arc<Collected>,
    cache: &ViPlaybookCache,
    paths: CollectorPaths,
    stock: StockCode,
    direction: ViDirection,
    kind: ViPlaybookKind,
    now: KstTime,
) -> Result<ViPlaybook, String> {
    let Some(hoga_dir) = paths.hoga_dir().map(PathBuf::from) else {
        return Ok(empty_playbook(stock, direction, kind, 0));
    };
    let candidate_days = collected.vi_days(paths.clone(), stock, now).await?;
    if candidate_days.is_empty() {
        return Ok(empty_playbook(stock, direction, kind, 0));
    }
    let finalized = tokio::task::spawn_blocking(move || collect_finalized_days(&hoga_dir, candidate_days))
        .await
        .map_err(|e| format!("VI 확정 일자 확인 작업이 멈췄습니다: {e}"))??;
    let lookback_days = finalized.days.len() as u32;
    if finalized.days.is_empty() {
        return Ok(empty_playbook(stock, direction, kind, 0));
    }
    let cache_key = CacheKey {
        stock,
        direction,
        kind,
        store_stamp: finalized.store_stamp,
    };
    if let Some(cached) = cache.get(&cache_key) {
        return Ok(cached);
    }
    let mut evaluated: Vec<EvaluatedEpisode> = Vec::new();
    for (date_str, date) in finalized.days.into_iter().rev() {
        let vi_slice = collected.vi_day(paths.clone(), stock, date, &date_str, None, now).await?;
        let episodes: Vec<ViEpisode> = extract_episodes(&vi_slice.snapshots)
            .into_iter()
            .filter(|episode| matches_filter(episode, direction, kind))
            .collect();
        if episodes.is_empty() {
            continue;
        }
        let expected_slice = collected.expected_day(paths.clone(), stock, date, &date_str, None, now).await?;
        let ticks_slice = collected.ticks_day(paths.clone(), stock, date, &date_str, None, now).await?;
        for episode in episodes {
            evaluated.push(evaluate_episode(date, episode, &expected_slice.snapshots, &ticks_slice.snapshots));
        }
    }
    let playbook = aggregate_playbook(stock, direction, kind, lookback_days, evaluated);
    cache.insert(cache_key, playbook.clone());
    Ok(playbook)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ViEpisode {
    market: ViMarket,
    kind: ViKind,
    direction: SourceViDirection,
    trigger_price_won: Option<u64>,
    triggered: TimeOfDay,
    released: Option<TimeOfDay>,
}

fn kind_label(kind: ViKind) -> &'static str {
    match kind {
        ViKind::Static => "static",
        ViKind::Dynamic => "dynamic",
        ViKind::Both => "both",
    }
}

fn extract_episodes(events: &[CollectedViEvent]) -> Vec<ViEpisode> {
    let mut episodes: Vec<ViEpisode> = Vec::new();
    let mut index_by_key: HashMap<(ViMarket, u32), usize> = HashMap::new();
    for event in events {
        let key = (event.market, event.triggered.secs());
        if let Some(&idx) = index_by_key.get(&key) {
            let existing = &mut episodes[idx];
            if event.released.is_some() {
                existing.released = event.released;
            }
            if existing.trigger_price_won.is_none() && event.trigger_price_won.is_some() {
                existing.trigger_price_won = event.trigger_price_won;
            }
            if existing.kind != event.kind {
                existing.kind = ViKind::Both;
            }
        } else {
            let idx = episodes.len();
            index_by_key.insert(key, idx);
            episodes.push(ViEpisode {
                market: event.market,
                kind: event.kind,
                direction: event.direction,
                trigger_price_won: event.trigger_price_won,
                triggered: event.triggered,
                released: event.released,
            });
        }
    }
    episodes
}

fn matches_filter(episode: &ViEpisode, direction: ViDirection, kind: ViPlaybookKind) -> bool {
    ViDirection::from(episode.direction) == direction && kind.matches(episode.kind)
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct HorizonOutcome {
    return_pct: f64,
    mae_pct: f64,
    won: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct EvaluatedEpisode {
    date: KstDate,
    triggered_secs: u32,
    summary: ViPlaybookMatch,
    outcomes: [Option<HorizonOutcome>; 4],
}

fn release_anchor_secs(episode: ViEpisode) -> u32 {
    let trigger_secs = episode.triggered.secs();
    match episode.released {
        Some(released) if released.secs() >= trigger_secs => released.secs(),
        _ => trigger_secs.saturating_add(DEFAULT_VI_DURATION_SECS),
    }
}

fn detect_late_drop(
    expected: &[CollectedExpectedTrade],
    direction: SourceViDirection,
    trigger_secs: u32,
    release_secs: u32,
) -> bool {
    let window: Vec<&CollectedExpectedTrade> = expected
        .iter()
        .filter(|row| {
            let secs = row.hhmmss.secs();
            secs >= trigger_secs && secs <= release_secs && row.price_won > 0
        })
        .collect();
    if window.len() < 2 {
        return false;
    }
    let late_start = release_secs.saturating_sub(LATE_WINDOW_SECS);
    let mut running_extreme_price = window[0].price_won;
    let mut running_peak_qty = window[0].expected_qty;
    let mut saw_late = false;
    let mut late_price_trap = false;
    for row in &window {
        let secs = row.hhmmss.secs();
        if secs >= late_start {
            saw_late = true;
            match direction {
                SourceViDirection::Up => {
                    if running_extreme_price > 0
                        && (running_extreme_price as f64 - row.price_won as f64) / running_extreme_price as f64 >= LATE_PRICE_DROP_THRESHOLD
                    {
                        late_price_trap = true;
                    }
                }
                SourceViDirection::Down => {
                    if running_extreme_price > 0
                        && (row.price_won as f64 - running_extreme_price as f64) / running_extreme_price as f64 >= LATE_PRICE_DROP_THRESHOLD
                    {
                        late_price_trap = true;
                    }
                }
            }
        }
        match direction {
            SourceViDirection::Up => running_extreme_price = running_extreme_price.max(row.price_won),
            SourceViDirection::Down => running_extreme_price = running_extreme_price.min(row.price_won),
        }
        running_peak_qty = running_peak_qty.max(row.expected_qty);
    }
    if !saw_late {
        return false;
    }
    if late_price_trap {
        return true;
    }
    let last_qty = window.last().map_or(0, |row| row.expected_qty);
    running_peak_qty > 0 && (last_qty as f64) <= (running_peak_qty as f64) * LATE_VOLUME_SHRINK_RATIO
}

fn evaluate_horizon(
    post_ticks: &[&CollectedTradeTick],
    direction: SourceViDirection,
    entry_price: u64,
    release_secs: u32,
    horizon_minutes: u32,
) -> Option<HorizonOutcome> {
    if entry_price == 0 {
        return None;
    }
    let cutoff_secs = release_secs.saturating_add(horizon_minutes.saturating_mul(60));
    let mut last_price: Option<u64> = None;
    let mut min_price = u64::MAX;
    let mut max_price = 0u64;
    for tick in post_ticks {
        if tick.hhmmss.secs() > cutoff_secs {
            break;
        }
        last_price = Some(tick.price_won);
        min_price = min_price.min(tick.price_won);
        max_price = max_price.max(tick.price_won);
    }
    let final_price = last_price?;
    let entry = entry_price as f64;
    let return_pct = ((final_price as f64 - entry) / entry) * 100.0;
    let mae_pct = match direction {
        SourceViDirection::Up => (((min_price as f64 - entry) / entry) * 100.0).min(0.0),
        SourceViDirection::Down => (((entry - max_price as f64) / entry) * 100.0).min(0.0),
    };
    let won = match direction {
        SourceViDirection::Up => return_pct > 0.0,
        SourceViDirection::Down => return_pct < 0.0,
    };
    Some(HorizonOutcome {
        return_pct: round2(return_pct),
        mae_pct: round2(mae_pct),
        won,
    })
}

fn evaluate_episode(
    date: KstDate,
    episode: ViEpisode,
    expected: &[CollectedExpectedTrade],
    ticks: &[CollectedTradeTick],
) -> EvaluatedEpisode {
    let trigger_secs = episode.triggered.secs();
    let release_secs = release_anchor_secs(episode);
    let post_ticks: Vec<&CollectedTradeTick> = ticks
        .iter()
        .filter(|tick| tick.hhmmss.secs() >= release_secs && tick.price_won > 0)
        .collect();
    let release_price = post_ticks.first().map(|tick| tick.price_won).or(episode.trigger_price_won);
    let outcomes = match release_price {
        Some(entry) if entry > 0 => HORIZON_MINUTES.map(|minutes| evaluate_horizon(&post_ticks, episode.direction, entry, release_secs, minutes)),
        _ => [None; 4],
    };
    let late_drop_detected = detect_late_drop(expected, episode.direction, trigger_secs, release_secs);
    let summary = ViPlaybookMatch {
        date: api::KstDate(date),
        triggered_at: episode.triggered.to_string(),
        released_at: episode.released.map(|t| t.to_string()),
        kind: kind_label(episode.kind).to_owned(),
        trigger_price: episode.trigger_price_won,
        release_price,
        return_1m_pct: outcomes[0].map(|o| o.return_pct),
        return_3m_pct: outcomes[1].map(|o| o.return_pct),
        return_5m_pct: outcomes[2].map(|o| o.return_pct),
        return_10m_pct: outcomes[3].map(|o| o.return_pct),
        mae_5m_pct: outcomes[2].map(|o| o.mae_pct),
        late_drop_detected,
    };
    EvaluatedEpisode {
        date,
        triggered_secs: trigger_secs,
        summary,
        outcomes,
    }
}

fn aggregate_playbook(
    stock: StockCode,
    direction: ViDirection,
    kind: ViPlaybookKind,
    lookback_days: u32,
    mut episodes: Vec<EvaluatedEpisode>,
) -> ViPlaybook {
    if episodes.is_empty() {
        return empty_playbook(stock, direction, kind, lookback_days);
    }
    episodes.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| b.triggered_secs.cmp(&a.triggered_secs)));
    let sample_count = episodes.len() as u32;
    let horizons = HORIZON_MINUTES
        .iter()
        .enumerate()
        .map(|(idx, &minutes)| {
            let mut samples = 0u32;
            let mut wins = 0u32;
            let mut sum_return = 0.0f64;
            let mut sum_mae = 0.0f64;
            for episode in &episodes {
                if let Some(outcome) = episode.outcomes[idx] {
                    samples += 1;
                    if outcome.won {
                        wins += 1;
                    }
                    sum_return += outcome.return_pct;
                    sum_mae += outcome.mae_pct;
                }
            }
            let (win_rate_pct, avg_return_pct, avg_mae_pct) = if samples > 0 {
                let count = f64::from(samples);
                (round2((f64::from(wins) / count) * 100.0), round2(sum_return / count), round2(sum_mae / count))
            } else {
                (0.0, 0.0, 0.0)
            };
            ViPlaybookHorizon {
                minutes,
                samples,
                win_rate_pct,
                avg_return_pct,
                avg_mae_pct,
            }
        })
        .collect();
    let recent_matches = episodes
        .into_iter()
        .take(RECENT_MATCHES_LIMIT)
        .map(|episode| episode.summary)
        .collect();
    ViPlaybook {
        symbol: SymbolCode(Symbol::Stock(stock).as_wire()),
        direction,
        kind,
        lookback_days,
        sample_count,
        horizons,
        recent_matches,
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collected::kind::ViAction;

    fn hms(h: u32, m: u32, s: u32) -> TimeOfDay {
        TimeOfDay::hms(h, m, s).unwrap()
    }

    fn vi_event(kind: ViKind, direction: SourceViDirection, trigger_price: Option<u64>, triggered: TimeOfDay, released: Option<TimeOfDay>, action: Option<ViAction>) -> CollectedViEvent {
        CollectedViEvent {
            recv_ms: 0,
            market: ViMarket::Krx,
            kind,
            direction,
            trigger_price_won: trigger_price,
            triggered,
            released,
            action,
            static_base_won: None,
            dynamic_base_won: None,
            static_deviation_pct: None,
            dynamic_deviation_pct: None,
            trigger_change_pct: None,
            trigger_count: None,
        }
    }

    fn expected_row(hhmmss: TimeOfDay, price_won: u64, expected_qty: u64) -> CollectedExpectedTrade {
        CollectedExpectedTrade {
            recv_ms: 0,
            hhmmss,
            price_won,
            change_won: 0,
            change_pct: None,
            expected_qty,
            cumulative_qty: 0,
            change_sign: None,
        }
    }

    fn tick_row(hhmmss: TimeOfDay, price_won: u64) -> CollectedTradeTick {
        CollectedTradeTick {
            recv_ms: 0,
            hhmmss,
            price_won,
            signed_qty: 10,
            instant_value_thousand_won: None,
            exchange: None,
        }
    }

    #[test]
    fn coalesces_trigger_and_release_into_one_episode() {
        let events = vec![
            vi_event(ViKind::Dynamic, SourceViDirection::Up, Some(77_000), hms(9, 10, 0), None, Some(ViAction::Trigger)),
            vi_event(ViKind::Dynamic, SourceViDirection::Up, Some(77_000), hms(9, 10, 0), Some(hms(9, 12, 5)), Some(ViAction::Release)),
        ];
        let episodes = extract_episodes(&events);
        assert_eq!(episodes.len(), 1);
        assert_eq!(episodes[0].released, Some(hms(9, 12, 5)));
        assert_eq!(episodes[0].trigger_price_won, Some(77_000));
    }

    #[test]
    fn detects_late_drop_on_price_reversal_or_volume_shrink() {
        let price_drop = vec![
            expected_row(hms(9, 10, 10), 78_000, 10_000),
            expected_row(hms(9, 11, 30), 79_000, 12_000),
            expected_row(hms(9, 11, 55), 78_400, 12_000),
        ];
        assert!(detect_late_drop(&price_drop, SourceViDirection::Up, hms(9, 10, 0).secs(), hms(9, 12, 0).secs()));

        let steady = vec![
            expected_row(hms(9, 10, 10), 78_000, 10_000),
            expected_row(hms(9, 11, 30), 79_000, 12_000),
            expected_row(hms(9, 11, 55), 78_900, 11_000),
        ];
        assert!(!detect_late_drop(&steady, SourceViDirection::Up, hms(9, 10, 0).secs(), hms(9, 12, 0).secs()));

        let volume_shrink = vec![
            expected_row(hms(9, 10, 10), 78_000, 10_000),
            expected_row(hms(9, 11, 30), 79_000, 10_000),
            expected_row(hms(9, 11, 55), 79_000, 6_500),
        ];
        assert!(detect_late_drop(&volume_shrink, SourceViDirection::Up, hms(9, 10, 0).secs(), hms(9, 12, 0).secs()));

        let down_bounce = vec![
            expected_row(hms(9, 10, 10), 63_000, 5_000),
            expected_row(hms(9, 11, 30), 62_000, 5_000),
            expected_row(hms(9, 11, 52), 62_500, 5_000),
        ];
        assert!(detect_late_drop(&down_bounce, SourceViDirection::Down, hms(9, 10, 0).secs(), hms(9, 12, 0).secs()));
    }

    #[test]
    fn evaluates_up_and_down_horizons_and_mae() {
        let date = KstDate::new(2026, 11, 20).unwrap();
        let up_ep = ViEpisode {
            market: ViMarket::Krx,
            kind: ViKind::Dynamic,
            direction: SourceViDirection::Up,
            trigger_price_won: Some(10_000),
            triggered: hms(9, 10, 0),
            released: Some(hms(9, 12, 0)),
        };
        let up_ticks = vec![
            tick_row(hms(9, 12, 0), 10_000),
            tick_row(hms(9, 12, 30), 9_900),
            tick_row(hms(9, 13, 0), 10_200),
            tick_row(hms(9, 15, 0), 10_500),
            tick_row(hms(9, 17, 0), 10_300),
            tick_row(hms(9, 22, 0), 10_800),
        ];
        let evaluated = evaluate_episode(date, up_ep, &[], &up_ticks);
        assert_eq!(evaluated.summary.release_price, Some(10_000));
        assert_eq!(evaluated.summary.return_1m_pct, Some(2.0));
        assert_eq!(evaluated.summary.return_3m_pct, Some(5.0));
        assert_eq!(evaluated.summary.return_5m_pct, Some(3.0));
        assert_eq!(evaluated.summary.return_10m_pct, Some(8.0));
        assert_eq!(evaluated.summary.mae_5m_pct, Some(-1.0));
        assert!(evaluated.outcomes[0].unwrap().won);

        let down_ep = ViEpisode {
            direction: SourceViDirection::Down,
            ..up_ep
        };
        let down_ticks = vec![
            tick_row(hms(9, 12, 0), 10_000),
            tick_row(hms(9, 12, 20), 10_150),
            tick_row(hms(9, 13, 0), 9_800),
        ];
        let evaluated_down = evaluate_episode(date, down_ep, &[], &down_ticks);
        assert_eq!(evaluated_down.summary.return_1m_pct, Some(-2.0));
        assert_eq!(evaluated_down.summary.mae_5m_pct, Some(-1.5));
        assert!(evaluated_down.outcomes[0].unwrap().won);
    }

    #[test]
    fn lru_evicts_oldest_entry_above_capacity() {
        let cache = ViPlaybookCache::with_capacity(2);
        let stock = |code: &str| StockCode::parse(code).unwrap();
        let make = |code: &str| empty_playbook(stock(code), ViDirection::Up, ViPlaybookKind::All, 1);
        let key = |code: &str| CacheKey {
            stock: stock(code),
            direction: ViDirection::Up,
            kind: ViPlaybookKind::All,
            store_stamp: "1:20261123:10-0".to_owned(),
        };
        cache.insert(key("005930"), make("005930"));
        cache.insert(key("000660"), make("000660"));
        assert!(cache.get(&key("005930")).is_some());
        cache.insert(key("035420"), make("035420"));
        assert!(cache.get(&key("005930")).is_some());
        assert!(cache.get(&key("000660")).is_none());
        assert!(cache.get(&key("035420")).is_some());
    }
}
