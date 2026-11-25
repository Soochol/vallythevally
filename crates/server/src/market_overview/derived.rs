use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::response::Json;
use domain::{KstDate, Price, StockCode, Symbol, SymbolKind};

use super::dto::*;
use super::session::phase;
use crate::api::{self, ApiErrorCode, ExcludeKind, Market, SymbolCode, UnixSeconds};
use crate::http::{ApiFailure, AppState};
use crate::screener::Screener;
use crate::screener::store::ListedMeta;
use crate::shared_data::{Loaded, SnapshotBody, SnapshotRow};
use crate::symbols::Directory;

const MILLION_WON_PER_EOK: f64 = 100.0;
const WON_PER_EOK: f64 = 100_000_000.0;
const ATTRIBUTION_TOP_N: usize = 5;
const MA_HISTORY_DAYS: usize = 20;
const MA_FETCH_CLOSES: usize = 220;
const HISTOGRAM_LABELS: [&str; 9] = [
    "≤-10%",
    "-10~-5%",
    "-5~-2%",
    "-2~-0.5%",
    "-0.5~+0.5%",
    "+0.5~+2%",
    "+2~+5%",
    "+5~+10%",
    "≥+10%",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodayOverlay {
    Append(KstDate),
    Replace(KstDate),
    None,
}

#[derive(Debug, Default, Clone)]
pub struct StockCatalog {
    pub markets: HashMap<StockCode, Market>,
    pub names: HashMap<StockCode, String>,
    pub listed_shares: HashMap<StockCode, u64>,
    pub excluded: HashSet<StockCode>,
}

impl StockCatalog {
    pub fn from_listed(listed: &[ListedMeta]) -> StockCatalog {
        let mut catalog = StockCatalog {
            markets: HashMap::with_capacity(listed.len()),
            names: HashMap::with_capacity(listed.len()),
            listed_shares: HashMap::with_capacity(listed.len()),
            excluded: HashSet::new(),
        };
        for item in listed {
            catalog.markets.insert(item.code, item.market);
            catalog.names.insert(item.code, item.name.clone());
            if let Some(shares) = item.listed_shares {
                catalog.listed_shares.insert(item.code, shares.get());
            }
            if item.is_etf_etn {
                catalog.excluded.insert(item.code);
            }
        }
        catalog
    }

    pub fn from_directory(directory: &Directory) -> StockCatalog {
        let mut catalog = StockCatalog::default();
        catalog.merge_directory(directory);
        catalog
    }

    pub fn merge_directory(&mut self, directory: &Directory) {
        for item in directory.screener_listing() {
            self.markets.entry(item.code).or_insert(item.market);
            self.names.entry(item.code).or_insert_with(|| item.name.clone());
            if let Some(shares) = item.listed_shares {
                self.listed_shares.entry(item.code).or_insert(shares.get());
            }
            if item.excludable_as.iter().any(|kind| matches!(kind, ExcludeKind::Etf | ExcludeKind::Etn)) {
                self.excluded.insert(item.code);
            }
        }
        for info in directory.all() {
            let Symbol::Stock(code) = info.symbol else { continue };
            self.markets.entry(code).or_insert_with(|| api_market(info.market));
            self.names.entry(code).or_insert_with(|| info.name.clone());
            if matches!(info.kind, SymbolKind::Etf | SymbolKind::Etn) {
                self.excluded.insert(code);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.markets.is_empty()
    }

    pub fn includes_stock(&self, code: StockCode, scope: MarketOverviewScope) -> bool {
        if self.excluded.contains(&code) {
            return false;
        }
        if self.markets.is_empty() {
            return scope == MarketOverviewScope::All;
        }
        match scope {
            MarketOverviewScope::All => self.markets.contains_key(&code),
            MarketOverviewScope::Kospi => self.markets.get(&code) == Some(&Market::Kospi),
            MarketOverviewScope::Kosdaq => self.markets.get(&code) == Some(&Market::Kosdaq),
        }
    }

    pub fn includes_in_market(&self, code: StockCode, market: Market) -> bool {
        !self.excluded.contains(&code) && self.markets.get(&code) == Some(&market)
    }

    pub fn matches_venue_scope(&self, code: StockCode, scope: MarketOverviewScope) -> bool {
        match scope {
            MarketOverviewScope::All => true,
            MarketOverviewScope::Kospi => self.markets.get(&code) == Some(&Market::Kospi),
            MarketOverviewScope::Kosdaq => self.markets.get(&code) == Some(&Market::Kosdaq),
        }
    }
}

fn api_market(market: domain::Market) -> Market {
    match market {
        domain::Market::Kospi => Market::Kospi,
        domain::Market::Kosdaq => Market::Kosdaq,
    }
}

#[derive(Debug, Default)]
pub struct DerivedStoreSnapshot {
    pub catalog: StockCatalog,
    pub latest_day: Option<KstDate>,
    pub trading_days: Vec<KstDate>,
    pub closes: HashMap<StockCode, Vec<(KstDate, Price)>>,
}

#[derive(Default)]
pub struct DerivedMaCache {
    entry: Mutex<Option<(u64, Arc<DerivedStoreSnapshot>)>>,
}

impl DerivedMaCache {
    pub async fn snapshot(&self, screener: &Screener) -> Arc<DerivedStoreSnapshot> {
        let generation = screener.store_generation();
        if let Some((cached, snapshot)) = self.entry.lock().expect("파생 이평선 캐시 잠금").as_ref()
            && *cached == generation
        {
            return snapshot.clone();
        }
        let listed = match screener.listed_meta().await {
            Ok(listed) => listed,
            Err(error) => {
                tracing::warn!(%error, "파생 지표용 상장 목록을 읽지 못했습니다");
                return Arc::default();
            }
        };
        let catalog = StockCatalog::from_listed(&listed);
        let codes: Vec<StockCode> = if !listed.is_empty() {
            listed.iter().filter(|item| !item.is_etf_etn).map(|item| item.code).collect()
        } else {
            match screener.daily_codes().await {
                Ok(codes) => codes,
                Err(error) => {
                    tracing::warn!(%error, "파생 지표용 일봉 종목 목록을 읽지 못했습니다");
                    return Arc::default();
                }
            }
        };
        let recent = match screener.recent_dated_closes(codes, MA_FETCH_CLOSES).await {
            Ok(recent) => recent,
            Err(error) => {
                tracing::warn!(%error, "파생 지표용 최근 종가를 읽지 못했습니다");
                return Arc::default();
            }
        };
        let trading_days = match screener.recent_trading_days(MA_HISTORY_DAYS).await {
            Ok(days) => days,
            Err(error) => {
                tracing::warn!(%error, "파생 지표용 최근 거래일을 읽지 못했습니다");
                Vec::new()
            }
        };
        let snapshot = Arc::new(DerivedStoreSnapshot {
            catalog,
            latest_day: recent.latest_day,
            trading_days,
            closes: recent.closes,
        });
        *self.entry.lock().expect("파생 이평선 캐시 잠금") = Some((generation, snapshot.clone()));
        snapshot
    }
}

pub fn parse_scope(query: &HashMap<String, String>) -> Result<MarketOverviewScope, ApiFailure> {
    match query.get("scope").map(String::as_str) {
        None | Some("all") => Ok(MarketOverviewScope::All),
        Some("kospi") => Ok(MarketOverviewScope::Kospi),
        Some("kosdaq") => Ok(MarketOverviewScope::Kosdaq),
        Some(other) => Err(ApiFailure::bad_request(format!("scope는 all, kospi, kosdaq 중 하나입니다: {other}"))),
    }
}

pub fn histogram_of(rows: &[&SnapshotRow]) -> Vec<MarketOverviewHistogramBucket> {
    let mut counts = [0u32; 9];
    for row in rows {
        if row.base_won == 0 || row.current_won == 0 {
            continue;
        }
        let rate = (row.current_won as f64 - row.base_won as f64) / row.base_won as f64 * 100.0;
        let bucket = histogram_bucket_index(rate);
        counts[bucket] += 1;
    }
    let total: u32 = counts.iter().sum();
    HISTOGRAM_LABELS
        .iter()
        .zip(counts)
        .map(|(&label, count)| MarketOverviewHistogramBucket {
            label: label.to_owned(),
            count,
            share_pct: if total == 0 { 0.0 } else { f64::from(count) / f64::from(total) * 100.0 },
        })
        .collect()
}

fn histogram_bucket_index(rate: f64) -> usize {
    if rate <= -10.0 {
        0
    } else if rate <= -5.0 {
        1
    } else if rate <= -2.0 {
        2
    } else if rate < -0.5 {
        3
    } else if rate <= 0.5 {
        4
    } else if rate < 2.0 {
        5
    } else if rate < 5.0 {
        6
    } else if rate < 10.0 {
        7
    } else {
        8
    }
}

pub fn venue_share_of(krx_rows: &[&SnapshotRow], nxt_rows: &[&SnapshotRow]) -> MarketOverviewVenueShare {
    let krx_million: u128 = krx_rows.iter().map(|row| u128::from(row.traded_million_won)).sum();
    let nxt_million: u128 = nxt_rows.iter().map(|row| u128::from(row.traded_million_won)).sum();
    let krx_trade_value_eok = krx_million as f64 / MILLION_WON_PER_EOK;
    let nxt_trade_value_eok = nxt_million as f64 / MILLION_WON_PER_EOK;
    let total = krx_trade_value_eok + nxt_trade_value_eok;
    let (krx_ratio_pct, nxt_ratio_pct) = if total > 0.0 {
        (krx_trade_value_eok / total * 100.0, nxt_trade_value_eok / total * 100.0)
    } else {
        (0.0, 0.0)
    };
    MarketOverviewVenueShare { krx_trade_value_eok, nxt_trade_value_eok, krx_ratio_pct, nxt_ratio_pct }
}

pub fn attribution_of(
    market: Market,
    index_level: f64,
    index_change_rate: f64,
    rows: &[&SnapshotRow],
    listed_shares_by_code: &HashMap<StockCode, u64>,
    names_by_code: &HashMap<StockCode, String>,
) -> Option<MarketOverviewAttribution> {
    if !index_level.is_finite() || index_level <= 0.0 || !index_change_rate.is_finite() || index_change_rate <= -100.0 {
        return None;
    }
    let index_base = index_level / (1.0 + index_change_rate / 100.0);
    if !index_base.is_finite() || index_base <= 0.0 {
        return None;
    }
    let index_change_points = index_level - index_base;
    let mut entries: Vec<(StockCode, &SnapshotRow, i128)> = Vec::with_capacity(rows.len());
    let mut total_base_cap_won: u128 = 0;
    for &row in rows {
        if row.base_won == 0 || row.current_won == 0 {
            continue;
        }
        let Ok(code) = StockCode::parse(&row.code) else { continue };
        let Some(&shares) = listed_shares_by_code.get(&code) else { continue };
        if shares == 0 {
            continue;
        }
        total_base_cap_won = total_base_cap_won.saturating_add(u128::from(row.base_won) * u128::from(shares));
        let delta_won = (i128::from(row.current_won) - i128::from(row.base_won)) * i128::from(shares);
        entries.push((code, row, delta_won));
    }
    if total_base_cap_won == 0 {
        return None;
    }
    let total_base_cap_f64 = total_base_cap_won as f64;
    let mut positives: Vec<MarketOverviewAttributionRow> = Vec::new();
    let mut negatives: Vec<MarketOverviewAttributionRow> = Vec::new();
    let mut total_abs_points = 0.0;
    let mut top1_abs = 0.0;
    let mut top2_abs = 0.0;
    for (code, row, delta_won) in entries {
        let points = (delta_won as f64 / total_base_cap_f64) * index_base;
        let abs_points = points.abs();
        total_abs_points += abs_points;
        if abs_points >= top1_abs {
            top2_abs = top1_abs;
            top1_abs = abs_points;
        } else if abs_points > top2_abs {
            top2_abs = abs_points;
        }
        if points == 0.0 {
            continue;
        }
        let change_rate = (row.current_won as f64 - row.base_won as f64) / row.base_won as f64 * 100.0;
        let cap_delta_eok = delta_won as f64 / WON_PER_EOK;
        let name = names_by_code.get(&code).cloned().unwrap_or_else(|| code.as_str().to_owned());
        let attribution_row = MarketOverviewAttributionRow {
            code: SymbolCode(Symbol::Stock(code).as_wire()),
            name,
            market,
            change_rate,
            points,
            cap_delta_eok,
        };
        if points > 0.0 {
            positives.push(attribution_row);
        } else {
            negatives.push(attribution_row);
        }
    }
    positives.sort_by(|a, b| b.points.total_cmp(&a.points).then_with(|| a.code.0.cmp(&b.code.0)));
    positives.truncate(ATTRIBUTION_TOP_N);
    negatives.sort_by(|a, b| a.points.total_cmp(&b.points).then_with(|| a.code.0.cmp(&b.code.0)));
    negatives.truncate(ATTRIBUTION_TOP_N);
    let top_two_concentration_pct = if total_abs_points > 0.0 {
        (top1_abs + top2_abs) / total_abs_points * 100.0
    } else {
        0.0
    };
    Some(MarketOverviewAttribution {
        market,
        index_change_points,
        top_positive: positives,
        top_negative: negatives,
        top_two_concentration_pct,
    })
}

pub fn ma_thrust_of(
    closes_by_code: &HashMap<StockCode, Vec<(KstDate, Price)>>,
    today_prices: &HashMap<StockCode, Price>,
    latest_day: Option<KstDate>,
    trading_days: &[KstDate],
    overlay: TodayOverlay,
) -> Option<MarketOverviewMaThrust> {
    ma_thrust_for(closes_by_code.iter().map(|(&code, closes)| (code, closes.as_slice())), today_prices, latest_day, trading_days, overlay)
}

pub fn ma_thrust_for<'a>(
    series: impl Iterator<Item = (StockCode, &'a [(KstDate, Price)])>,
    today_prices: &HashMap<StockCode, Price>,
    latest_day: Option<KstDate>,
    trading_days: &[KstDate],
    overlay: TodayOverlay,
) -> Option<MarketOverviewMaThrust> {
    let fallback_day = latest_day.into_iter().collect::<Vec<_>>();
    let effective_days = if trading_days.is_empty() { fallback_day.as_slice() } else { trading_days };
    let days_len = effective_days.len();
    let hist_slots = match overlay {
        TodayOverlay::Append(_) => days_len.min(MA_HISTORY_DAYS.saturating_sub(1)),
        TodayOverlay::Replace(_) | TodayOverlay::None => days_len.min(MA_HISTORY_DAYS),
    };
    let mut total_stocks = 0u32;
    let mut above_counts = [0u32; 4];
    let mut eligible_counts = [0u32; 4];
    let mut hist_above = [0u32; MA_HISTORY_DAYS];
    let mut hist_eligible = [0u32; MA_HISTORY_DAYS];
    for (code, closes) in series {
        if closes.is_empty() {
            continue;
        }
        total_stocks += 1;
        let (first, rest) = match (overlay, today_prices.get(&code).copied()) {
            (TodayOverlay::Append(_), Some(today)) => (today, closes),
            (TodayOverlay::Replace(replace_day), Some(today)) if closes[0].0 == replace_day => (today, &closes[1..]),
            (TodayOverlay::Replace(_), Some(today)) => (today, closes),
            _ => (closes[0].1, &closes[1..]),
        };
        let first_centi = u128::from(first.centi());
        let mut running = first_centi;
        let rest_len = rest.len();
        if rest_len >= 4 {
            let mut i = 0;
            while i < 4 {
                running += u128::from(rest[i].1.centi());
                i += 1;
            }
            eligible_counts[0] += 1;
            if first_centi * 5 > running {
                above_counts[0] += 1;
            }
            if rest_len >= 19 {
                while i < 19 {
                    running += u128::from(rest[i].1.centi());
                    i += 1;
                }
                eligible_counts[1] += 1;
                if first_centi * 20 > running {
                    above_counts[1] += 1;
                }
                if rest_len >= 59 {
                    while i < 59 {
                        running += u128::from(rest[i].1.centi());
                        i += 1;
                    }
                    eligible_counts[2] += 1;
                    if first_centi * 60 > running {
                        above_counts[2] += 1;
                    }
                    if rest_len >= 199 {
                        while i < 199 {
                            running += u128::from(rest[i].1.centi());
                            i += 1;
                        }
                        eligible_counts[3] += 1;
                        if first_centi * 200 > running {
                            above_counts[3] += 1;
                        }
                    }
                }
            }
        }
        if hist_slots > 0 && closes.len() >= 20 {
            let mut pos = 0usize;
            let mut sum20: u128 = 0;
            let mut k = 0usize;
            while k < 20 {
                sum20 += u128::from(closes[k].1.centi());
                k += 1;
            }
            let max_pos = closes.len() - 20;
            let mut offset = 0usize;
            while offset < hist_slots {
                let target_day = effective_days[days_len - 1 - offset];
                while pos < max_pos && closes[pos].0 > target_day {
                    sum20 = sum20 - u128::from(closes[pos].1.centi()) + u128::from(closes[pos + 20].1.centi());
                    pos += 1;
                }
                if closes[pos].0 == target_day {
                    hist_eligible[offset] += 1;
                    if u128::from(closes[pos].1.centi()) * 20 > sum20 {
                        hist_above[offset] += 1;
                    }
                }
                offset += 1;
            }
        }
    }
    if total_stocks == 0 {
        return None;
    }
    let ratio = |above: u32, eligible: u32| if eligible == 0 { 0.0 } else { f64::from(above) / f64::from(eligible) * 100.0 };
    let above_5_pct = ratio(above_counts[0], eligible_counts[0]);
    let above_20_pct = ratio(above_counts[1], eligible_counts[1]);
    let above_60_pct = ratio(above_counts[2], eligible_counts[2]);
    let above_200_pct = ratio(above_counts[3], eligible_counts[3]);
    let mut history_20d = Vec::with_capacity(MA_HISTORY_DAYS);
    for offset in (0..hist_slots).rev() {
        let day = effective_days[days_len - 1 - offset];
        if offset == 0 && matches!(overlay, TodayOverlay::Replace(_)) {
            if eligible_counts[1] > 0 {
                history_20d.push(MarketOverviewMaHistoryPoint { date: api::KstDate(day), above_20_pct });
            }
        } else if hist_eligible[offset] > 0 {
            history_20d.push(MarketOverviewMaHistoryPoint {
                date: api::KstDate(day),
                above_20_pct: ratio(hist_above[offset], hist_eligible[offset]),
            });
        }
    }
    if let TodayOverlay::Append(today_day) = overlay
        && eligible_counts[1] > 0
    {
        history_20d.push(MarketOverviewMaHistoryPoint { date: api::KstDate(today_day), above_20_pct });
    }
    let as_of = match overlay {
        TodayOverlay::Append(day) | TodayOverlay::Replace(day) => Some(api::KstDate(day)),
        TodayOverlay::None => latest_day.map(api::KstDate),
    };
    Some(MarketOverviewMaThrust {
        as_of,
        total_stocks,
        above_5_pct,
        above_20_pct,
        above_60_pct,
        above_200_pct,
        history_20d,
    })
}

pub struct DerivedInputs<'a> {
    pub scope: MarketOverviewScope,
    pub phase: MarketOverviewPhase,
    pub combined: Option<&'a Loaded<SnapshotBody>>,
    pub krx: Option<&'a Loaded<SnapshotBody>>,
    pub nxt: Option<&'a Loaded<SnapshotBody>>,
    pub overview_index: Option<(f64, f64)>,
    pub catalog: &'a StockCatalog,
    pub closes: &'a HashMap<StockCode, Vec<(KstDate, Price)>>,
    pub latest_day: Option<KstDate>,
    pub trading_days: &'a [KstDate],
}

pub fn derive_market_snapshot(inputs: &DerivedInputs<'_>) -> MarketOverviewDerivedCard {
    let DerivedInputs { scope, phase: market_phase, combined, krx, nxt, overview_index, catalog, closes, latest_day, trading_days } = *inputs;
    let received_at = [combined, krx, nxt]
        .into_iter()
        .flatten()
        .map(|loaded| loaded.header.as_of)
        .max()
        .map(UnixSeconds);
    let histogram = if scope != MarketOverviewScope::All && catalog.is_empty() {
        not_prepared("종목 목록이 아직 준비되지 않아 시장별 등락 분포를 계산할 수 없습니다")
    } else {
        match combined {
            Some(loaded) => {
                let scoped: Vec<&SnapshotRow> = loaded
                    .body
                    .stocks
                    .iter()
                    .filter(|row| StockCode::parse(&row.code).is_ok_and(|code| catalog.includes_stock(code, scope)))
                    .collect();
                MarketOverviewPart::Ok { value: histogram_of(&scoped) }
            }
            None => not_prepared("통합 시세 스냅샷이 아직 준비되지 않았습니다"),
        }
    };
    let venue_share = if scope != MarketOverviewScope::All && catalog.is_empty() {
        not_prepared("종목 목록이 아직 준비되지 않아 시장별 거래소 비중을 계산할 수 없습니다")
    } else {
        match (krx, nxt) {
            (Some(krx_loaded), Some(nxt_loaded)) => {
                if scope == MarketOverviewScope::All {
                    let krx_refs: Vec<&SnapshotRow> = krx_loaded.body.stocks.iter().collect();
                    let nxt_refs: Vec<&SnapshotRow> = nxt_loaded.body.stocks.iter().collect();
                    MarketOverviewPart::Ok { value: venue_share_of(&krx_refs, &nxt_refs) }
                } else {
                    let krx_scoped: Vec<&SnapshotRow> = krx_loaded
                        .body
                        .stocks
                        .iter()
                        .filter(|row| StockCode::parse(&row.code).is_ok_and(|code| catalog.matches_venue_scope(code, scope)))
                        .collect();
                    let nxt_scoped: Vec<&SnapshotRow> = nxt_loaded
                        .body
                        .stocks
                        .iter()
                        .filter(|row| StockCode::parse(&row.code).is_ok_and(|code| catalog.matches_venue_scope(code, scope)))
                        .collect();
                    MarketOverviewPart::Ok { value: venue_share_of(&krx_scoped, &nxt_scoped) }
                }
            }
            (None, _) => not_prepared("KRX 시세 스냅샷이 아직 준비되지 않았습니다"),
            (_, None) => not_prepared("NXT 시세 스냅샷이 아직 준비되지 않았습니다"),
        }
    };
    let attribution_market = attribution_market_for(scope);
    let attribution = match combined {
        None => not_prepared("통합 시세 스냅샷이 아직 준비되지 않았습니다"),
        Some(loaded) => match resolve_index_quote(attribution_market, combined, krx, overview_index) {
            None => not_prepared("지수 시세가 아직 준비되지 않았습니다"),
            Some((index_level, index_change_rate)) => {
                let market_rows: Vec<&SnapshotRow> = loaded
                    .body
                    .stocks
                    .iter()
                    .filter(|row| StockCode::parse(&row.code).is_ok_and(|code| catalog.includes_in_market(code, attribution_market)))
                    .collect();
                match attribution_of(
                    attribution_market,
                    index_level,
                    index_change_rate,
                    &market_rows,
                    &catalog.listed_shares,
                    &catalog.names,
                ) {
                    Some(value) => MarketOverviewPart::Ok { value },
                    None => not_prepared("상장주식수 자료가 없어 지수 기여도를 계산할 수 없습니다"),
                }
            }
        },
    };
    let (today_prices, overlay) = extract_today_overlay(combined, latest_day, catalog, scope);
    let ma_thrust = match latest_day {
        None => not_prepared("일봉 저장소가 비어 있어 이동평균선 상회 비율을 계산할 수 없습니다"),
        Some(_) => {
            let scoped_series = closes
                .iter()
                .filter(|(code, _)| catalog.includes_stock(**code, scope))
                .map(|(&code, values)| (code, values.as_slice()));
            match ma_thrust_for(scoped_series, &today_prices, latest_day, trading_days, overlay) {
                Some(value) => MarketOverviewPart::Ok { value },
                None => not_prepared("일봉 저장소에 대상 종목 자료가 없습니다"),
            }
        }
    };
    MarketOverviewDerivedCard {
        scope,
        phase: market_phase,
        received_at,
        histogram,
        venue_share,
        attribution,
        ma_thrust,
    }
}

fn attribution_market_for(scope: MarketOverviewScope) -> Market {
    match scope {
        MarketOverviewScope::All | MarketOverviewScope::Kospi => Market::Kospi,
        MarketOverviewScope::Kosdaq => Market::Kosdaq,
    }
}

fn index_code_of(market: Market) -> &'static str {
    match market {
        Market::Kospi => "001",
        Market::Kosdaq => "101",
    }
}

fn resolve_index_quote(
    market: Market,
    combined: Option<&Loaded<SnapshotBody>>,
    krx: Option<&Loaded<SnapshotBody>>,
    overview_index: Option<(f64, f64)>,
) -> Option<(f64, f64)> {
    let code = index_code_of(market);
    for loaded in [combined, krx].into_iter().flatten() {
        if let Some(row) = loaded.body.indices.iter().find(|row| row.code == code) {
            return Some((row.level, row.change_rate));
        }
    }
    overview_index
}

pub(crate) fn extract_today_overlay(
    combined: Option<&Loaded<SnapshotBody>>,
    latest_day: Option<KstDate>,
    catalog: &StockCatalog,
    scope: MarketOverviewScope,
) -> (HashMap<StockCode, Price>, TodayOverlay) {
    let Some(loaded) = combined else {
        return (HashMap::new(), TodayOverlay::None);
    };
    let Some(snapshot_day) = KstDate::parse_yyyymmdd(&loaded.header.observation_date) else {
        return (HashMap::new(), TodayOverlay::None);
    };
    let overlay = match latest_day {
        Some(last) if snapshot_day > last => TodayOverlay::Append(snapshot_day),
        Some(last) if snapshot_day == last => TodayOverlay::Replace(snapshot_day),
        _ => return (HashMap::new(), TodayOverlay::None),
    };
    let mut prices = HashMap::with_capacity(loaded.body.stocks.len());
    for row in &loaded.body.stocks {
        if let Ok(code) = StockCode::parse(&row.code)
            && catalog.includes_stock(code, scope)
            && let Some(price) = row.current_won.checked_mul(100).and_then(Price::from_centi)
        {
            prices.insert(code, price);
        }
    }
    if prices.is_empty() {
        return (prices, TodayOverlay::None);
    }
    (prices, overlay)
}

pub(crate) fn not_prepared<T>(message: impl Into<String>) -> MarketOverviewPart<T> {
    MarketOverviewPart::Failed {
        error: ApiFailure::new(ApiErrorCode::NotPrepared, message).into_body(),
    }
}

pub async fn derived(
    State(st): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<MarketOverviewDerivedCard>, ApiFailure> {
    let scope = parse_scope(&query)?;
    let store_snapshot = st.market_overview.derived_ma_cache.snapshot(&st.screener).await;
    let directory = st.symbols.updates().borrow().clone();
    let fallback_catalog;
    let catalog = if !store_snapshot.catalog.is_empty() {
        &store_snapshot.catalog
    } else if let Some(directory) = directory.as_deref() {
        fallback_catalog = StockCatalog::from_directory(directory);
        &fallback_catalog
    } else {
        &store_snapshot.catalog
    };
    let combined = st.shared_data.snapshot_combined.current();
    let krx = st.shared_data.snapshot_krx.current();
    let nxt = st.shared_data.snapshot_nxt.current();
    let attribution_market = attribution_market_for(scope);
    let overview_index = st.shared_data.market_overview.current().and_then(|board| {
        let card = board.body.market(attribution_market).index.as_ref()?;
        match &card.index {
            MarketOverviewPart::Ok { value } => Some((value.level, value.change_rate)),
            MarketOverviewPart::Failed { .. } => None,
        }
    });
    let card = derive_market_snapshot(&DerivedInputs {
        scope,
        phase: phase(st.clock.now()),
        combined: combined.as_deref(),
        krx: krx.as_deref(),
        nxt: nxt.as_deref(),
        overview_index,
        catalog,
        closes: &store_snapshot.closes,
        latest_day: store_snapshot.latest_day,
        trading_days: &store_snapshot.trading_days,
    });
    Ok(Json(card))
}
