use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use domain::KstDate;
use serde::{Deserialize, Serialize};

use super::board::Signature;
use crate::api::Market;
use crate::market_overview::{MarketOverviewFlowCard, MarketOverviewIndexCard, MarketOverviewPeriod, MarketOverviewSectorsCard, MarketOverviewStreaksCard, MarketOverviewTurnoverCard, Sample};

pub const SAMPLES_FOLDER: &str = "market-samples";
const SAMPLES_EXTENSION: &str = ".jsonl";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "card", rename_all = "camelCase")]
pub enum CardValue {
    Index { value: MarketOverviewIndexCard },
    Sectors { value: MarketOverviewSectorsCard },
    Flow { value: MarketOverviewFlowCard },
    Turnover { value: MarketOverviewTurnoverCard },
    Streaks { value: MarketOverviewStreaksCard },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MadeCard {
    pub market: Market,
    pub key_name: String,
    pub made_at: i64,
    pub card: CardValue,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCards {
    pub index: Option<MarketOverviewIndexCard>,
    pub sectors: Option<MarketOverviewSectorsCard>,
    pub flow: Vec<MarketOverviewFlowCard>,
    pub turnover: Vec<MarketOverviewTurnoverCard>,
    pub streaks: Option<MarketOverviewStreaksCard>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewBody {
    pub kospi: MarketCards,
    pub kosdaq: MarketCards,
}

fn period_order(period: MarketOverviewPeriod) -> usize {
    period.days()
}

impl OverviewBody {
    pub fn market(&self, market: Market) -> &MarketCards {
        match market {
            Market::Kospi => &self.kospi,
            Market::Kosdaq => &self.kosdaq,
        }
    }

    fn market_mut(&mut self, market: Market) -> &mut MarketCards {
        match market {
            Market::Kospi => &mut self.kospi,
            Market::Kosdaq => &mut self.kosdaq,
        }
    }

    pub fn newest_cards(cards: impl IntoIterator<Item = MadeCard>) -> Vec<MadeCard> {
        let mut newest: Vec<MadeCard> = Vec::new();
        for card in cards {
            let same = newest.iter().position(|kept| kept.market == card.market && kept.card.slot() == card.card.slot());
            match same {
                Some(index) if newest[index].made_at >= card.made_at => {}
                Some(index) => newest[index] = card,
                None => newest.push(card),
            }
        }
        newest
    }

    pub fn from_cards(cards: impl IntoIterator<Item = MadeCard>) -> OverviewBody {
        let newest = OverviewBody::newest_cards(cards);
        let mut body = OverviewBody::default();
        for made in newest {
            let cards = body.market_mut(made.market);
            match made.card {
                CardValue::Index { value } => cards.index = Some(value),
                CardValue::Sectors { value } => cards.sectors = Some(value),
                CardValue::Flow { value } => cards.flow.push(value),
                CardValue::Turnover { value } => cards.turnover.push(value),
                CardValue::Streaks { value } => cards.streaks = Some(value),
            }
        }
        for market in [Market::Kospi, Market::Kosdaq] {
            let cards = body.market_mut(market);
            cards.flow.sort_by_key(|card| period_order(card.period));
            cards.turnover.sort_by_key(|card| period_order(card.period));
        }
        body
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardSlot {
    Index,
    Sectors,
    Flow(usize),
    Turnover(usize),
    Streaks,
}

impl CardValue {
    pub fn slot(&self) -> CardSlot {
        match self {
            CardValue::Index { .. } => CardSlot::Index,
            CardValue::Sectors { .. } => CardSlot::Sectors,
            CardValue::Flow { value } => CardSlot::Flow(value.period.days()),
            CardValue::Turnover { value } => CardSlot::Turnover(value.period.days()),
            CardValue::Streaks { .. } => CardSlot::Streaks,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DaySamples {
    pub day: KstDate,
    pub samples: Vec<Sample>,
}

pub struct SampleBoard {
    current: RwLock<Option<Arc<DaySamples>>>,
    seen: Mutex<Option<Signature>>,
    errors: AtomicU64,
}

impl Default for SampleBoard {
    fn default() -> Self {
        SampleBoard::new()
    }
}

impl SampleBoard {
    pub fn new() -> Self {
        SampleBoard { current: RwLock::new(None), seen: Mutex::new(None), errors: AtomicU64::new(0) }
    }

    pub fn current(&self) -> Option<Arc<DaySamples>> {
        self.current.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }

    pub fn poll(&self, dir: &Path) {
        let Some((day, path)) = newest_samples_file(&dir.join(SAMPLES_FOLDER)) else { return };
        let Ok(meta) = std::fs::metadata(&path) else { return };
        let signature = Signature::of(path.clone(), &meta);
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.as_ref() == Some(&signature) {
            return;
        }
        *seen = Some(signature);
        drop(seen);
        match std::fs::read_to_string(&path) {
            Ok(text) => *self.current.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(DaySamples { day, samples: self.parse(&path, &text) })),
            Err(e) => {
                self.errors.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(path = %path.display(), error = %e, "장중 표본 파일을 읽지 못해 이전 표본을 둡니다");
            }
        }
    }

    fn parse(&self, path: &Path, text: &str) -> Vec<Sample> {
        let finished = if text.ends_with('\n') { text.len() } else { text.rfind('\n').map_or(0, |end| end + 1) };
        let mut samples = Vec::new();
        for line in text[..finished].lines().filter(|line| !line.trim().is_empty()) {
            match serde_json::from_str::<Sample>(line) {
                Ok(sample) => samples.push(sample),
                Err(e) => {
                    self.errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(path = %path.display(), error = %e, "읽을 수 없는 장중 표본 줄을 건너뜁니다");
                }
            }
        }
        samples
    }
}

fn newest_samples_file(folder: &Path) -> Option<(KstDate, std::path::PathBuf)> {
    std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let stem = name.strip_suffix(SAMPLES_EXTENSION).filter(|stem| stem.len() == 8)?;
            Some((KstDate::parse_yyyymmdd(stem)?, entry.path()))
        })
        .max_by_key(|(day, _)| *day)
}
