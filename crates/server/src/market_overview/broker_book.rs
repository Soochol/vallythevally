use std::collections::{HashMap, HashSet};

use domain::StockCode;

use super::dto::{MarketOverviewBrokerBook, MarketOverviewFlowLeader, MarketOverviewOrderbookStock, MarketOverviewScope};
use crate::api::{BalanceSort, Excludes, Market, NetDirection, Ranking, RankingFigures, RankingInvestor, RankingMarket, TradeUnit, Venue};
use crate::shared_data::{MergedRankings, SharedRankingRow};

const WON_PER_EOK: f64 = 100_000_000.0;
const TOP_N: usize = 5;

fn default_excludes() -> Excludes {
    Excludes { etf_etn: false, preferred: false }
}

fn rows_for<'a>(rankings: &'a MergedRankings, ranking: &Ranking) -> &'a [SharedRankingRow] {
    rankings
        .find(ranking, 1)
        .and_then(|condition| condition.last.as_ref())
        .map_or(&[], |received| received.rows.as_slice())
}

fn resolve_change_rate(row: &SharedRankingRow, live_rates: &HashMap<StockCode, f64>) -> Option<f64> {
    row.change_rate
        .map(|p| p.0)
        .filter(|rate| rate.is_finite())
        .or_else(|| StockCode::parse(&row.code.0).ok().and_then(|code| live_rates.get(&code).copied()))
}

fn collect_bid_ask(
    rankings: &MergedRankings,
    scope: MarketOverviewScope,
    live_rates: &HashMap<StockCode, f64>,
) -> (i64, i64, Vec<MarketOverviewOrderbookStock>, Vec<MarketOverviewOrderbookStock>, usize) {
    let markets: &[Market] = match scope {
        MarketOverviewScope::All => &[Market::Kospi, Market::Kosdaq],
        MarketOverviewScope::Kospi => &[Market::Kospi],
        MarketOverviewScope::Kosdaq => &[Market::Kosdaq],
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut total_bid: i64 = 0;
    let mut total_ask: i64 = 0;
    let mut buy_pressure: Vec<MarketOverviewOrderbookStock> = Vec::new();
    let mut sell_pressure: Vec<MarketOverviewOrderbookStock> = Vec::new();
    let mut matched = 0usize;
    for &market in markets {
        let query = Ranking::BidAskBalance {
            market,
            venue: Venue::Combined,
            sort: BalanceSort::NetBuyRemaining,
            excludes: default_excludes(),
            exclude_managed: false,
        };
        for row in rows_for(rankings, &query) {
            let RankingFigures::BidAskBalance { total_sell_remaining, total_buy_remaining, net_buy_remaining, buy_ratio } = row.figures else {
                continue;
            };
            if !seen.insert(row.code.0.clone()) {
                continue;
            }
            matched += 1;
            let bid = total_buy_remaining.0.max(0);
            let ask = total_sell_remaining.0.max(0);
            total_bid = total_bid.saturating_add(bid);
            total_ask = total_ask.saturating_add(ask);
            let ratio = if buy_ratio.0.is_finite() && buy_ratio.0 > 0.0 {
                buy_ratio.0
            } else if ask > 0 {
                bid as f64 / ask as f64 * 100.0
            } else if bid > 0 {
                100.0
            } else {
                0.0
            };
            let net_remaining = net_buy_remaining.0;
            let item = MarketOverviewOrderbookStock {
                code: row.code.clone(),
                name: row.name.clone(),
                change_rate: resolve_change_rate(row, live_rates),
                bid_ask_ratio: ratio,
                net_remaining,
            };
            if net_remaining > 0 {
                buy_pressure.push(item);
            } else if net_remaining < 0 {
                sell_pressure.push(item);
            }
        }
    }
    buy_pressure.sort_by(|a, b| {
        b.net_remaining
            .cmp(&a.net_remaining)
            .then_with(|| b.bid_ask_ratio.total_cmp(&a.bid_ask_ratio))
            .then_with(|| a.code.0.cmp(&b.code.0))
    });
    buy_pressure.truncate(TOP_N);
    sell_pressure.sort_by(|a, b| {
        a.net_remaining
            .cmp(&b.net_remaining)
            .then_with(|| a.bid_ask_ratio.total_cmp(&b.bid_ask_ratio))
            .then_with(|| a.code.0.cmp(&b.code.0))
    });
    sell_pressure.truncate(TOP_N);
    (total_bid, total_ask, buy_pressure, sell_pressure, matched)
}

fn collect_flow_leaders<'a>(
    rows: impl Iterator<Item = &'a SharedRankingRow>,
    live_rates: &HashMap<StockCode, f64>,
) -> Vec<MarketOverviewFlowLeader> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut leaders: Vec<MarketOverviewFlowLeader> = Vec::new();
    for row in rows {
        let RankingFigures::NetAmounts { net, .. } = row.figures else {
            continue;
        };
        if !seen.insert(row.code.0.clone()) {
            continue;
        }
        leaders.push(MarketOverviewFlowLeader {
            code: row.code.clone(),
            name: row.name.clone(),
            change_rate: resolve_change_rate(row, live_rates),
            net_eok: net.0 as f64 / WON_PER_EOK,
        });
    }
    leaders.sort_by(|a, b| b.net_eok.total_cmp(&a.net_eok).then_with(|| a.code.0.cmp(&b.code.0)));
    leaders.truncate(TOP_N);
    leaders
}

fn foreign_query(market: RankingMarket) -> Ranking {
    Ranking::InvestorNetBuy {
        market,
        investor: RankingInvestor::Foreign,
        direction: NetDirection::NetBuy,
        unit: TradeUnit::Amount,
        excludes: default_excludes(),
    }
}

fn program_query(market: Market) -> Ranking {
    Ranking::Program {
        market,
        venue: Venue::Combined,
        direction: NetDirection::NetBuy,
        excludes: default_excludes(),
    }
}

pub fn build_broker_book(
    rankings: Option<&MergedRankings>,
    scope: MarketOverviewScope,
    live_rates: &HashMap<StockCode, f64>,
) -> Option<MarketOverviewBrokerBook> {
    let rankings = rankings?;
    let (total_bid_remaining, total_ask_remaining, top_buy_pressure, top_sell_pressure, bid_ask_matched) =
        collect_bid_ask(rankings, scope, live_rates);
    let foreign_leaders = match scope {
        MarketOverviewScope::All => {
            let all_rows = rows_for(rankings, &foreign_query(RankingMarket::All));
            if !all_rows.is_empty() {
                collect_flow_leaders(all_rows.iter(), live_rates)
            } else {
                let kospi = rows_for(rankings, &foreign_query(RankingMarket::Kospi));
                let kosdaq = rows_for(rankings, &foreign_query(RankingMarket::Kosdaq));
                collect_flow_leaders(kospi.iter().chain(kosdaq), live_rates)
            }
        }
        MarketOverviewScope::Kospi => collect_flow_leaders(rows_for(rankings, &foreign_query(RankingMarket::Kospi)).iter(), live_rates),
        MarketOverviewScope::Kosdaq => collect_flow_leaders(rows_for(rankings, &foreign_query(RankingMarket::Kosdaq)).iter(), live_rates),
    };
    let program_leaders = match scope {
        MarketOverviewScope::All => {
            let kospi = rows_for(rankings, &program_query(Market::Kospi));
            let kosdaq = rows_for(rankings, &program_query(Market::Kosdaq));
            collect_flow_leaders(kospi.iter().chain(kosdaq), live_rates)
        }
        MarketOverviewScope::Kospi => collect_flow_leaders(rows_for(rankings, &program_query(Market::Kospi)).iter(), live_rates),
        MarketOverviewScope::Kosdaq => collect_flow_leaders(rows_for(rankings, &program_query(Market::Kosdaq)).iter(), live_rates),
    };
    if bid_ask_matched == 0 && foreign_leaders.is_empty() && program_leaders.is_empty() {
        return None;
    }
    let total_remaining = total_bid_remaining.saturating_add(total_ask_remaining);
    let buy_pressure_pct = if total_remaining > 0 {
        (total_bid_remaining as f64 / total_remaining as f64 * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    Some(MarketOverviewBrokerBook {
        total_bid_remaining,
        total_ask_remaining,
        buy_pressure_pct,
        top_buy_pressure,
        top_sell_pressure,
        foreign_leaders,
        program_leaders,
    })
}
