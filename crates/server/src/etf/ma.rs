use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use domain::{KstDate, Price, StockCode};

use super::{EtfMaState, EtfMaStates};
use crate::screener::Screener;

const LONGEST_WINDOW: usize = 120;

#[derive(Debug, Default)]
pub struct MaSnapshot {
    pub as_of: Option<KstDate>,
    pub ok: bool,
    states: HashMap<StockCode, EtfMaStates>,
}

impl MaSnapshot {
    pub fn states(&self, code: StockCode) -> EtfMaStates {
        self.states.get(&code).copied().unwrap_or_default()
    }
}

pub fn states_of(closes_newest_first: &[Price]) -> EtfMaStates {
    let state = |window: usize| {
        let window_closes = closes_newest_first.get(..window)?;
        let sum: u128 = window_closes.iter().map(|p| u128::from(p.centi())).sum();
        let last = u128::from(closes_newest_first[0].centi()) * window as u128;
        Some(match last.cmp(&sum) {
            std::cmp::Ordering::Greater => EtfMaState::Above,
            std::cmp::Ordering::Equal => EtfMaState::Equal,
            std::cmp::Ordering::Less => EtfMaState::Below,
        })
    };
    EtfMaStates { ma20: state(20), ma60: state(60), ma120: state(LONGEST_WINDOW) }
}

struct MaCacheEntry {
    generation: u64,
    loaded: HashSet<StockCode>,
    snapshot: Arc<MaSnapshot>,
}

#[derive(Default)]
pub struct MaCache {
    entry: Mutex<Option<MaCacheEntry>>,
}

impl MaCache {
    pub async fn snapshot(&self, screener: &Screener, codes: impl FnOnce() -> Vec<StockCode>) -> Arc<MaSnapshot> {
        let generation = match screener.store_generation().await {
            Ok(generation) => generation,
            Err(e) => {
                tracing::warn!(error = %e, "ETF 이평선 세대를 읽지 못했습니다");
                return Arc::default();
            }
        };
        let requested: HashSet<StockCode> = codes().into_iter().collect();
        let missing: Option<Vec<StockCode>> = {
            let guard = self.entry.lock().expect("이평선 캐시 잠금");
            if let Some(entry) = guard.as_ref()
                && entry.generation == generation
            {
                let diff: Vec<StockCode> = requested.iter().copied().filter(|code| !entry.loaded.contains(code)).collect();
                if diff.is_empty() {
                    return entry.snapshot.clone();
                }
                Some(diff)
            } else {
                None
            }
        };
        let is_partial = missing.is_some();
        let fetch_codes = missing.unwrap_or_else(|| requested.iter().copied().collect());
        let recent = match screener.recent_closes(fetch_codes.clone(), LONGEST_WINDOW).await {
            Ok(recent) => recent,
            Err(e) => {
                tracing::warn!(error = %e, "ETF 이평선을 일봉 저장소에서 읽지 못했습니다");
                return Arc::default();
            }
        };
        let fetched_states: HashMap<StockCode, EtfMaStates> =
            recent.closes.iter().map(|(code, closes)| (*code, states_of(closes))).collect();
        {
            let mut guard = self.entry.lock().expect("이평선 캐시 잠금");
            if let Some(entry) = guard.as_mut()
                && entry.generation == generation
                && entry.snapshot.as_of == recent.latest_day
            {
                let mut merged_states = entry.snapshot.states.clone();
                merged_states.extend(fetched_states);
                entry.loaded.extend(fetch_codes);
                let snapshot = Arc::new(MaSnapshot { as_of: recent.latest_day, ok: true, states: merged_states });
                entry.snapshot = snapshot.clone();
                return snapshot;
            }
            if !is_partial {
                let snapshot = Arc::new(MaSnapshot { as_of: recent.latest_day, ok: true, states: fetched_states });
                *guard = Some(MaCacheEntry { generation, loaded: requested, snapshot: snapshot.clone() });
                return snapshot;
            }
        }
        let fresh_generation = match screener.store_generation().await {
            Ok(fresh) => fresh,
            Err(e) => {
                tracing::warn!(error = %e, "ETF 이평선 세대를 읽지 못했습니다");
                return Arc::default();
            }
        };
        let all_codes: Vec<StockCode> = requested.iter().copied().collect();
        let recent = match screener.recent_closes(all_codes, LONGEST_WINDOW).await {
            Ok(recent) => recent,
            Err(e) => {
                tracing::warn!(error = %e, "ETF 이평선을 일봉 저장소에서 읽지 못했습니다");
                return Arc::default();
            }
        };
        let states: HashMap<StockCode, EtfMaStates> =
            recent.closes.iter().map(|(code, closes)| (*code, states_of(closes))).collect();
        let snapshot = Arc::new(MaSnapshot { as_of: recent.latest_day, ok: true, states });
        let mut guard = self.entry.lock().expect("이평선 캐시 잠금");
        *guard = Some(MaCacheEntry { generation: fresh_generation, loaded: requested, snapshot: snapshot.clone() });
        snapshot
    }
}
