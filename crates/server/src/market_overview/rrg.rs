use std::collections::HashMap;

use domain::{KstDate, Price, StockCode};

use super::derived::{StockCatalog, TodayOverlay, extract_today_overlay};
use super::dto::{
    MarketOverviewPart, MarketOverviewRrg, MarketOverviewRrgPoint, MarketOverviewRrgQuadrant, MarketOverviewRrgSeries, MarketOverviewScope,
    MarketOverviewSector,
};
use crate::api::{self, Market};
use crate::kiwoom_themes::{StoredCatalog, members_of};
use crate::shared_data::{IntradayThemesBody, Loaded, OverviewBody, SnapshotBody};

const MAX_SERIES_DAYS: usize = 20;
const RATIO_WINDOW: usize = 10;
const MOMENTUM_WINDOW: usize = 5;
const TRAIL_POINTS: usize = 5;
const MAX_ENTITIES: usize = 12;
const STD_EPSILON: f64 = 1e-9;

pub fn classify_quadrant(rs_ratio: f64, rs_momentum: f64) -> MarketOverviewRrgQuadrant {
    match (rs_ratio >= 100.0, rs_momentum >= 100.0) {
        (true, true) => MarketOverviewRrgQuadrant::Leading,
        (true, false) => MarketOverviewRrgQuadrant::Weakening,
        (false, false) => MarketOverviewRrgQuadrant::Lagging,
        (false, true) => MarketOverviewRrgQuadrant::Improving,
    }
}

pub fn rrg_trajectory_of(dates: &[KstDate], entity_index: &[f64], benchmark_index: &[f64]) -> Vec<MarketOverviewRrgPoint> {
    let len = dates.len().min(entity_index.len()).min(benchmark_index.len());
    if len == 0 {
        return Vec::new();
    }
    let mut rs = Vec::with_capacity(len);
    for idx in 0..len {
        let bench = benchmark_index[idx];
        let val = entity_index[idx];
        let ratio = if bench > 0.0 && bench.is_finite() && val.is_finite() { 100.0 * val / bench } else { 100.0 };
        rs.push(ratio);
    }
    let mut rs_ratio = Vec::with_capacity(len);
    let mut rs_rel = Vec::with_capacity(len);
    for idx in 0..len {
        let start = idx.saturating_sub(RATIO_WINDOW - 1);
        let window = &rs[start..=idx];
        rs_ratio.push(z_centered_100(window, rs[idx]));
        let mean = window.iter().copied().sum::<f64>() / window.len() as f64;
        let rel = if mean > 0.0 && mean.is_finite() { 100.0 * rs[idx] / mean } else { 100.0 };
        rs_rel.push(sanitize(rel));
    }
    let mut rs_momentum = Vec::with_capacity(len);
    for idx in 0..len {
        let start = idx.saturating_sub(MOMENTUM_WINDOW - 1);
        rs_momentum.push(z_centered_100(&rs_rel[start..=idx], rs_rel[idx]));
    }
    let keep_from = len.saturating_sub(TRAIL_POINTS);
    (keep_from..len)
        .map(|idx| MarketOverviewRrgPoint {
            date: api::KstDate(dates[idx]),
            rs_ratio: sanitize(rs_ratio[idx]),
            rs_momentum: sanitize(rs_momentum[idx]),
        })
        .collect()
}

fn z_centered_100(window: &[f64], current: f64) -> f64 {
    if window.len() < 2 || !current.is_finite() {
        return 100.0;
    }
    let n = window.len() as f64;
    let mean = window.iter().copied().sum::<f64>() / n;
    let variance = window.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    let std_dev = variance.sqrt();
    if !std_dev.is_finite() || std_dev <= STD_EPSILON {
        return 100.0;
    }
    sanitize(100.0 + (current - mean) / std_dev)
}

fn sanitize(value: f64) -> f64 {
    if value.is_finite() { value } else { 100.0 }
}

pub struct RrgInputs<'a> {
    pub scope: MarketOverviewScope,
    pub catalog: &'a StockCatalog,
    pub closes: &'a HashMap<StockCode, Vec<(KstDate, Price)>>,
    pub latest_day: Option<KstDate>,
    pub trading_days: &'a [KstDate],
    pub combined: Option<&'a Loaded<SnapshotBody>>,
    pub live_rates: &'a HashMap<StockCode, f64>,
    pub themes_catalog: Option<&'a StoredCatalog>,
    pub intraday_themes: Option<&'a Loaded<IntradayThemesBody>>,
    pub overview_board: Option<&'a Loaded<OverviewBody>>,
}

pub fn build_rrg(inputs: &RrgInputs<'_>) -> Option<MarketOverviewRrg> {
    let (today_prices, overlay) = extract_today_overlay(inputs.combined, inputs.latest_day, inputs.catalog, inputs.scope);
    let dates = effective_dates(inputs.trading_days, inputs.latest_day, overlay);
    let as_of = dates
        .last()
        .copied()
        .or_else(|| inputs.combined.and_then(|loaded| KstDate::parse_yyyymmdd(&loaded.header.observation_date)))
        .or_else(|| inputs.overview_board.and_then(|loaded| KstDate::parse_yyyymmdd(&loaded.header.observation_date)))
        .or(inputs.latest_day);
    let themes = build_theme_series(inputs, &dates, &today_prices, overlay);
    let sectors = build_sector_series(inputs.scope, inputs.overview_board, as_of, inputs.latest_day);
    if themes.is_empty() && sectors.is_empty() {
        return None;
    }
    Some(MarketOverviewRrg { as_of: as_of.map(api::KstDate), themes, sectors })
}

fn effective_dates(trading_days: &[KstDate], latest_day: Option<KstDate>, overlay: TodayOverlay) -> Vec<KstDate> {
    let mut days: Vec<KstDate> = if trading_days.is_empty() {
        latest_day.into_iter().collect()
    } else {
        trading_days.to_vec()
    };
    if let TodayOverlay::Append(today) = overlay {
        days.push(today);
    }
    if days.len() > MAX_SERIES_DAYS {
        let drop_count = days.len() - MAX_SERIES_DAYS;
        days.drain(..drop_count);
    }
    days
}

fn stock_prices_for_dates(
    closes: &[(KstDate, Price)],
    today_price: Option<Price>,
    overlay: TodayOverlay,
    dates: &[KstDate],
    out: &mut [f64; MAX_SERIES_DAYS],
) {
    let overlay_day = match overlay {
        TodayOverlay::Append(day) | TodayOverlay::Replace(day) => Some(day),
        TodayOverlay::None => None,
    };
    let mut pos = 0usize;
    let closes_len = closes.len();
    let mut idx = dates.len();
    while idx > 0 {
        idx -= 1;
        let target_day = dates[idx];
        out[idx] = f64::NAN;
        if overlay_day == Some(target_day)
            && let Some(price) = today_price
        {
            let centi = price.centi();
            if centi > 0 {
                out[idx] = centi as f64;
                continue;
            }
        }
        while pos < closes_len && closes[pos].0 > target_day {
            pos += 1;
        }
        if pos < closes_len {
            let centi = closes[pos].1.centi();
            if centi > 0 {
                out[idx] = centi as f64;
            }
        }
    }
}

fn build_theme_series(
    inputs: &RrgInputs<'_>,
    dates: &[KstDate],
    today_prices: &HashMap<StockCode, Price>,
    overlay: TodayOverlay,
) -> Vec<MarketOverviewRrgSeries> {
    let Some(stored) = inputs.themes_catalog else {
        return Vec::new();
    };
    if stored.themes.is_empty() || dates.is_empty() {
        return Vec::new();
    }
    let steps = dates.len().saturating_sub(1);
    let mut stock_returns: HashMap<StockCode, [f64; MAX_SERIES_DAYS]> = HashMap::with_capacity(inputs.closes.len());
    let mut bench_sum = vec![0.0f64; steps];
    let mut bench_cnt = vec![0u32; steps];
    let mut price_buf = [f64::NAN; MAX_SERIES_DAYS];
    if steps > 0 {
        for (&code, closes) in inputs.closes {
            if !inputs.catalog.includes_stock(code, inputs.scope) || closes.is_empty() {
                continue;
            }
            let today = today_prices.get(&code).copied();
            stock_prices_for_dates(closes, today, overlay, dates, &mut price_buf);
            let mut series = [f64::NAN; MAX_SERIES_DAYS];
            let mut any = false;
            let mut step = 0usize;
            while step < steps {
                let prev = price_buf[step];
                let curr = price_buf[step + 1];
                if prev > 0.0 && curr > 0.0 {
                    let r = (curr - prev) / prev;
                    if r.is_finite() {
                        bench_sum[step] += r;
                        bench_cnt[step] += 1;
                        any = true;
                        series[step] = r;
                    }
                }
                step += 1;
            }
            if any {
                stock_returns.insert(code, series);
            }
        }
    }
    let bench_index = cumulative_index(&bench_sum, &bench_cnt);
    let intraday_by_code: HashMap<&str, f64> = inputs
        .intraday_themes
        .map(|loaded| loaded.body.themes.iter().map(|t| (t.code.as_str(), t.change_rate)).collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    let mut member_sum = vec![0.0f64; steps];
    let mut member_cnt = vec![0u32; steps];
    for theme in &stored.themes {
        let members: Vec<StockCode> = members_of(theme)
            .into_iter()
            .filter(|code| inputs.catalog.includes_stock(*code, inputs.scope))
            .collect();
        if members.is_empty() {
            continue;
        }
        member_sum.fill(0.0);
        member_cnt.fill(0);
        let mut active_members = 0u32;
        for &code in &members {
            if let Some(returns) = stock_returns.get(&code) {
                active_members += 1;
                let mut step = 0usize;
                while step < steps {
                    let r = returns[step];
                    if r.is_finite() {
                        member_sum[step] += r;
                        member_cnt[step] += 1;
                    }
                    step += 1;
                }
            }
        }
        if active_members == 0 {
            continue;
        }
        let theme_index = cumulative_index(&member_sum, &member_cnt);
        let points = rrg_trajectory_of(dates, &theme_index, &bench_index);
        let Some(last) = points.last() else { continue };
        let live_change = mean_live_change(&members, inputs.live_rates);
        let fallback_change = if steps > 0 && member_cnt[steps - 1] > 0 {
            member_sum[steps - 1] / f64::from(member_cnt[steps - 1]) * 100.0
        } else {
            0.0
        };
        let change_rate = live_change
            .or_else(|| (inputs.scope == MarketOverviewScope::All).then(|| intraday_by_code.get(theme.code.as_str()).copied()).flatten())
            .unwrap_or(fallback_change);
        out.push(MarketOverviewRrgSeries {
            code: theme.code.clone(),
            name: theme.name.clone(),
            quadrant: classify_quadrant(last.rs_ratio, last.rs_momentum),
            change_rate: if change_rate.is_finite() { change_rate } else { 0.0 },
            member_count: active_members,
            points,
        });
    }
    sort_and_cap_series(&mut out);
    out
}

fn mean_live_change(members: &[StockCode], live_rates: &HashMap<StockCode, f64>) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0u32;
    for code in members {
        if let Some(&rate) = live_rates.get(code)
            && rate.is_finite()
        {
            sum += rate;
            count += 1;
        }
    }
    (count > 0).then(|| sum / f64::from(count))
}

fn cumulative_index(sums: &[f64], counts: &[u32]) -> Vec<f64> {
    let mut index = Vec::with_capacity(sums.len() + 1);
    let mut level = 100.0;
    index.push(level);
    for (&sum, &cnt) in sums.iter().zip(counts) {
        if cnt > 0 {
            let avg = sum / f64::from(cnt);
            if avg.is_finite() {
                level *= (1.0 + avg).max(0.01);
            }
        }
        index.push(level);
    }
    index
}

fn build_sector_series(
    scope: MarketOverviewScope,
    overview_board: Option<&Loaded<OverviewBody>>,
    as_of: Option<KstDate>,
    latest_day: Option<KstDate>,
) -> Vec<MarketOverviewRrgSeries> {
    let Some(board) = overview_board else {
        return Vec::new();
    };
    let Some(date) = KstDate::parse_yyyymmdd(&board.header.observation_date).or(as_of) else {
        return Vec::new();
    };
    if let Some(last) = latest_day
        && date < last
    {
        return Vec::new();
    }
    let markets: &[Market] = match scope {
        MarketOverviewScope::All => &[Market::Kospi, Market::Kosdaq],
        MarketOverviewScope::Kospi => &[Market::Kospi],
        MarketOverviewScope::Kosdaq => &[Market::Kosdaq],
    };
    let mut rows: Vec<&MarketOverviewSector> = Vec::new();
    for &market in markets {
        if let Some(card) = board.body.market(market).sectors.as_ref()
            && let MarketOverviewPart::Ok { value } = &card.sectors
        {
            rows.extend(value.iter());
        }
    }
    if rows.is_empty() {
        return Vec::new();
    }
    let rates: Vec<f64> = rows.iter().map(|s| if s.change_rate.is_finite() { s.change_rate } else { 0.0 }).collect();
    let mut out = Vec::with_capacity(rows.len());
    for (sector, &rate) in rows.iter().zip(&rates) {
        let rs_ratio = z_centered_100(&rates, rate);
        let rs_momentum = 100.0;
        out.push(MarketOverviewRrgSeries {
            code: sector.code.clone(),
            name: sector.name.clone(),
            quadrant: classify_quadrant(rs_ratio, rs_momentum),
            change_rate: rate,
            member_count: 0,
            points: vec![MarketOverviewRrgPoint { date: api::KstDate(date), rs_ratio, rs_momentum }],
        });
    }
    sort_and_cap_series(&mut out);
    out
}

fn distance_from_center(series: &MarketOverviewRrgSeries) -> f64 {
    series.points.last().map_or(0.0, |pt| ((pt.rs_ratio - 100.0).powi(2) + (pt.rs_momentum - 100.0).powi(2)).sqrt())
}

fn sort_and_cap_series(series: &mut Vec<MarketOverviewRrgSeries>) {
    series.sort_by(|a, b| {
        distance_from_center(b)
            .total_cmp(&distance_from_center(a))
            .then_with(|| b.change_rate.abs().total_cmp(&a.change_rate.abs()))
            .then_with(|| a.code.cmp(&b.code))
    });
    series.truncate(MAX_ENTITIES);
}
