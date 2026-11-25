use domain::{KstDate, KstTime, StockCode, TimeOfDay, Weekday};

use super::derived::StockCatalog;
use super::dto::{MarketOverviewScope, MarketOverviewSessionDna, MarketOverviewSessionWindow, MarketOverviewSessionWindowId};
use super::samples::{Sample, SampleValue};
use super::session::observation_day;
use crate::api::{self, Market};
use crate::shared_data::{Loaded, SnapshotBody};

const MILLION_WON_PER_EOK: f64 = 100.0;

const fn hm(hour: u32, minute: u32) -> TimeOfDay {
    match TimeOfDay::hms(hour, minute, 0) {
        Some(time) => time,
        None => panic!("올바른 시각"),
    }
}

struct WindowSpec {
    id: MarketOverviewSessionWindowId,
    label: &'static str,
    time_range: &'static str,
    start: TimeOfDay,
    end: TimeOfDay,
}

const WINDOWS: [WindowSpec; 6] = [
    WindowSpec { id: MarketOverviewSessionWindowId::NxtPre, label: "NXT 프리", time_range: "08:00–08:50", start: hm(8, 0), end: hm(8, 50) },
    WindowSpec { id: MarketOverviewSessionWindowId::KrxOpen, label: "장초반", time_range: "09:00–09:30", start: hm(9, 0), end: hm(9, 30) },
    WindowSpec { id: MarketOverviewSessionWindowId::KrxMid, label: "본장", time_range: "09:30–14:30", start: hm(9, 30), end: hm(14, 30) },
    WindowSpec { id: MarketOverviewSessionWindowId::KrxClose, label: "마감", time_range: "14:30–15:30", start: hm(14, 30), end: hm(15, 30) },
    WindowSpec { id: MarketOverviewSessionWindowId::NxtMain, label: "NXT 전반", time_range: "15:30–18:00", start: hm(15, 30), end: hm(18, 0) },
    WindowSpec { id: MarketOverviewSessionWindowId::NxtLate, label: "NXT 후반", time_range: "18:00–20:00", start: hm(18, 0), end: hm(20, 0) },
];

pub fn active_window_at(now: KstTime) -> Option<MarketOverviewSessionWindowId> {
    if matches!(now.kst_date().weekday(), Weekday::Sat | Weekday::Sun) {
        return None;
    }
    window_index_for(now.kst_time_of_day()).map(|idx| WINDOWS[idx].id)
}

fn window_index_for(time: TimeOfDay) -> Option<usize> {
    WINDOWS.iter().position(|spec| match spec.id {
        MarketOverviewSessionWindowId::KrxClose => time >= spec.start && time <= spec.end,
        MarketOverviewSessionWindowId::NxtMain => time > spec.start && time < spec.end,
        _ => time >= spec.start && time < spec.end,
    })
}

#[derive(Default, Clone, Copy)]
struct WindowAccum {
    foreign_delta_eok: f64,
    institution_delta_eok: f64,
    individual_delta_eok: f64,
    program_delta_eok: f64,
    sample_count: u32,
}

fn accumulate_market_samples(samples: &[Sample], target_market: Market, totals: &mut [WindowAccum; 6]) {
    let mut by_window: [Vec<&Sample>; 6] = Default::default();
    for sample in samples {
        if sample.market != target_market {
            continue;
        }
        let time = KstTime::from_unix(sample.at).kst_time_of_day();
        if let Some(idx) = window_index_for(time) {
            by_window[idx].push(sample);
        }
    }
    let mut prev_foreign = 0.0f64;
    let mut prev_institution = 0.0f64;
    let mut prev_individual = 0.0f64;
    let mut prev_program = 0.0f64;
    for (idx, bucket) in by_window.iter_mut().enumerate() {
        bucket.sort_by_key(|s| s.at);
        let mut last_investors: Option<(f64, f64, f64)> = None;
        let mut last_program: Option<f64> = None;
        for sample in bucket.iter() {
            totals[idx].sample_count = totals[idx].sample_count.saturating_add(1);
            match &sample.value {
                SampleValue::Investors { individual_eok, foreign_eok, institution_eok } => {
                    last_investors = Some((*foreign_eok as f64, *institution_eok as f64, *individual_eok as f64));
                }
                SampleValue::Program { total_million_won, .. } => {
                    last_program = Some(*total_million_won as f64 / MILLION_WON_PER_EOK);
                }
            }
        }
        if let Some((foreign, institution, individual)) = last_investors {
            totals[idx].foreign_delta_eok += foreign - prev_foreign;
            totals[idx].institution_delta_eok += institution - prev_institution;
            totals[idx].individual_delta_eok += individual - prev_individual;
            prev_foreign = foreign;
            prev_institution = institution;
            prev_individual = individual;
        }
        if let Some(program) = last_program {
            totals[idx].program_delta_eok += program - prev_program;
            prev_program = program;
        }
    }
}

fn scoped_trade_value_eok(snapshot: Option<&Loaded<SnapshotBody>>, catalog: &StockCatalog, scope: MarketOverviewScope) -> f64 {
    let Some(loaded) = snapshot else {
        return 0.0;
    };
    let mut total_million: u128 = 0;
    for row in &loaded.body.stocks {
        if scope == MarketOverviewScope::All || StockCode::parse(&row.code).is_ok_and(|code| catalog.matches_venue_scope(code, scope)) {
            total_million += u128::from(row.traded_million_won);
        }
    }
    total_million as f64 / MILLION_WON_PER_EOK
}

pub fn build_session_dna(
    now: KstTime,
    scope: MarketOverviewScope,
    samples: &[Sample],
    krx: Option<&Loaded<SnapshotBody>>,
    nxt: Option<&Loaded<SnapshotBody>>,
    catalog: &StockCatalog,
) -> Option<MarketOverviewSessionDna> {
    if samples.is_empty() && krx.is_none() && nxt.is_none() {
        return None;
    }
    let markets: &[Market] = match scope {
        MarketOverviewScope::All => &[Market::Kospi, Market::Kosdaq],
        MarketOverviewScope::Kospi => &[Market::Kospi],
        MarketOverviewScope::Kosdaq => &[Market::Kosdaq],
    };
    let mut totals = [WindowAccum::default(); 6];
    for &market in markets {
        accumulate_market_samples(samples, market, &mut totals);
    }
    let windows = WINDOWS
        .iter()
        .zip(totals)
        .map(|(spec, acc)| MarketOverviewSessionWindow {
            id: spec.id,
            label: spec.label.to_owned(),
            time_range: spec.time_range.to_owned(),
            foreign_delta_eok: acc.foreign_delta_eok,
            institution_delta_eok: acc.institution_delta_eok,
            individual_delta_eok: acc.individual_delta_eok,
            program_delta_eok: acc.program_delta_eok,
            sample_count: acc.sample_count,
        })
        .collect();
    let day: KstDate = observation_day(now);
    Some(MarketOverviewSessionDna {
        day: api::KstDate(day),
        active_window: active_window_at(now),
        krx_trade_value_eok: scoped_trade_value_eok(krx, catalog, scope),
        nxt_trade_value_eok: scoped_trade_value_eok(nxt, catalog, scope),
        windows,
    })
}
