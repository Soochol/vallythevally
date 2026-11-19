use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use domain::{KstDate, Price, StockCode};

use super::{EtfMaState, EtfMaStates};
use crate::screener::Screener;

const LONGEST_WINDOW: usize = 120;

#[derive(Debug, Default)]
pub struct MaSnapshot {
    pub as_of: Option<KstDate>,
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

#[derive(Default)]
pub struct MaCache {
    entry: Mutex<Option<(u64, Arc<MaSnapshot>)>>,
}

impl MaCache {
    pub async fn snapshot(&self, screener: &Screener, codes: impl FnOnce() -> Vec<StockCode>) -> Arc<MaSnapshot> {
        let generation = screener.store_generation();
        if let Some((cached, snapshot)) = self.entry.lock().expect("이평선 캐시 잠금").as_ref()
            && *cached == generation
        {
            return snapshot.clone();
        }
        let recent = match screener.recent_closes(codes(), LONGEST_WINDOW).await {
            Ok(recent) => recent,
            Err(e) => {
                tracing::warn!(error = %e, "ETF 이평선을 일봉 저장소에서 읽지 못했습니다");
                return Arc::default();
            }
        };
        let states = recent.closes.iter().map(|(code, closes)| (*code, states_of(closes))).collect();
        let snapshot = Arc::new(MaSnapshot { as_of: recent.latest_day, states });
        *self.entry.lock().expect("이평선 캐시 잠금") = Some((generation, snapshot.clone()));
        snapshot
    }
}
