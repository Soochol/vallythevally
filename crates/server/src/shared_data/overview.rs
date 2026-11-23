use serde::{Deserialize, Serialize};

use crate::api::Market;
use crate::market_overview::{MarketOverviewFlowCard, MarketOverviewIndexCard, MarketOverviewPeriod, MarketOverviewSectorsCard, MarketOverviewStreaksCard, MarketOverviewTurnoverCard};

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

    pub fn from_cards(cards: impl IntoIterator<Item = MadeCard>) -> OverviewBody {
        let mut newest: Vec<MadeCard> = Vec::new();
        for card in cards {
            let same = newest.iter().position(|kept| kept.market == card.market && kept.card.slot() == card.card.slot());
            match same {
                Some(index) if newest[index].made_at >= card.made_at => {}
                Some(index) => newest[index] = card,
                None => newest.push(card),
            }
        }
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
