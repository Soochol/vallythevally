use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{HeatmapTheme, Quote, SymbolCode};

const RATE_DECIMALS: f64 = 10_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HeatmapThemeOrder {
    #[default]
    Rate,
    Custom,
    Traded,
}

impl HeatmapThemeOrder {
    pub fn parse(raw: &str) -> Option<HeatmapThemeOrder> {
        match raw {
            "rate" => Some(HeatmapThemeOrder::Rate),
            "custom" => Some(HeatmapThemeOrder::Custom),
            "traded" => Some(HeatmapThemeOrder::Traded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeatmapBoardMember {
    pub symbol: SymbolCode,
    pub name: String,
    pub change_rate: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub traded_million_won: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeatmapThemeSummary {
    pub weighted_rate: Option<f64>,
    pub traded_million_won: u64,
    pub rising: u32,
    pub flat: u32,
    pub falling: u32,
    pub leader: SymbolCode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HeatmapBoardTheme {
    pub id: String,
    pub name: String,
    pub summary: Option<HeatmapThemeSummary>,
    pub members: Vec<HeatmapBoardMember>,
    pub missing: Vec<SymbolCode>,
}

pub fn board_theme(theme: &HeatmapTheme, quotes: &HashMap<SymbolCode, Quote>, name_of: impl Fn(&SymbolCode) -> String) -> HeatmapBoardTheme {
    let mut members = Vec::new();
    let mut missing = Vec::new();
    for code in &theme.symbols {
        match quotes.get(code) {
            Some(quote) => members.push(HeatmapBoardMember { symbol: code.clone(), name: name_of(code), change_rate: quote.change_rate, traded_million_won: quote.traded_million_won }),
            None => missing.push(code.clone()),
        }
    }
    HeatmapBoardTheme { id: theme.id.clone(), name: theme.name.clone(), summary: summarize(&members), members, missing }
}

fn summarize(members: &[HeatmapBoardMember]) -> Option<HeatmapThemeSummary> {
    let leader = members.iter().reduce(|best, m| if m.change_rate > best.change_rate { m } else { best })?;
    let traded: Vec<(f64, u64)> = members.iter().filter_map(|m| m.traded_million_won.map(|t| (m.change_rate, t))).collect();
    let traded_million_won: u64 = traded.iter().map(|(_, t)| t).sum();
    let weighted_rate = (traded_million_won > 0).then(|| {
        let weighted = traded.iter().map(|(rate, t)| rate * *t as f64).sum::<f64>() / traded_million_won as f64;
        (weighted * RATE_DECIMALS).round() / RATE_DECIMALS
    });
    let count = |side: Ordering| members.iter().filter(|m| m.change_rate.partial_cmp(&0.0) == Some(side)).count() as u32;
    Some(HeatmapThemeSummary {
        weighted_rate,
        traded_million_won,
        rising: count(Ordering::Greater),
        flat: count(Ordering::Equal),
        falling: count(Ordering::Less),
        leader: leader.symbol.clone(),
    })
}

pub fn in_order(mut themes: Vec<HeatmapBoardTheme>, order: HeatmapThemeOrder) -> Vec<HeatmapBoardTheme> {
    let key = |theme: &HeatmapBoardTheme| -> Option<f64> {
        let summary = theme.summary.as_ref()?;
        match order {
            HeatmapThemeOrder::Custom => None,
            HeatmapThemeOrder::Rate => summary.weighted_rate,
            HeatmapThemeOrder::Traded => Some(summary.traded_million_won as f64),
        }
    };
    if order != HeatmapThemeOrder::Custom {
        themes.sort_by(|a, b| match (key(a), key(b)) {
            (Some(a), Some(b)) => b.partial_cmp(&a).unwrap_or(Ordering::Equal),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        });
    }
    themes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{QuoteSource, UnixSeconds};

    fn code(c: &str) -> SymbolCode {
        SymbolCode(c.into())
    }

    fn quote(c: &str, rate: f64, traded: Option<u64>) -> (SymbolCode, Quote) {
        (code(c), Quote { symbol: code(c), price: 1.0, change: 0.0, change_rate: rate, volume: 1, t: UnixSeconds(1), source: QuoteSource::Polled, venue: None, traded_million_won: traded })
    }

    fn theme(id: &str, symbols: &[&str]) -> HeatmapTheme {
        HeatmapTheme { id: id.into(), name: format!("테마 {id}"), symbols: symbols.iter().map(|s| code(s)).collect() }
    }

    fn named(c: &SymbolCode) -> String {
        format!("이름 {}", c.0)
    }

    #[test]
    fn a_summary_weights_each_rate_by_its_traded_value_and_counts_the_sides() {
        let quotes: HashMap<_, _> = [quote("A", 1.0, Some(5_000)), quote("B", 9.0, Some(50)), quote("C", -1.0, Some(30)), quote("D", 0.0, None)].into();
        let board = board_theme(&theme("T", &["A", "B", "C", "D", "Z"]), &quotes, named);
        let summary = board.summary.unwrap();
        let expected = (1.0 * 5_000.0 + 9.0 * 50.0 - 30.0) / 5_080.0;
        assert_eq!(summary.weighted_rate, Some((expected * RATE_DECIMALS).round() / RATE_DECIMALS));
        assert_eq!((summary.traded_million_won, summary.rising, summary.flat, summary.falling), (5_080, 2, 1, 1));
        assert_eq!(summary.leader, code("B"));
        assert_eq!(board.members.iter().map(|m| m.symbol.0.as_str()).collect::<Vec<_>>(), ["A", "B", "C", "D"], "테마 안 순서 그대로");
        assert_eq!(board.members[0].name, "이름 A");
        assert_eq!(board.missing, vec![code("Z")]);
    }

    #[test]
    fn without_any_traded_value_the_weighted_rate_is_null_and_without_quotes_there_is_no_summary() {
        let quotes: HashMap<_, _> = [quote("A", 2.0, None), quote("B", 3.0, Some(0))].into();
        let summary = board_theme(&theme("T", &["A", "B"]), &quotes, named).summary.unwrap();
        assert_eq!((summary.weighted_rate, summary.traded_million_won, summary.leader), (None, 0, code("B")));
        let none = board_theme(&theme("T", &["X"]), &quotes, named);
        assert_eq!((none.summary, none.missing), (None, vec![code("X")]));
    }

    #[test]
    fn the_earlier_member_leads_when_rates_tie() {
        let quotes: HashMap<_, _> = [quote("A", 2.0, Some(1)), quote("B", 2.0, Some(1))].into();
        assert_eq!(board_theme(&theme("T", &["B", "A"]), &quotes, named).summary.unwrap().leader, code("B"));
    }

    #[test]
    fn themes_order_by_weighted_rate_or_traded_value_keeping_user_order_for_ties_and_putting_unknowns_last() {
        let quotes: HashMap<_, _> = [quote("A", 1.0, Some(100)), quote("B", 5.0, Some(10)), quote("C", 1.0, Some(300)), quote("N", 4.0, None)].into();
        let themes = || ["empty:X", "a:A", "b:B", "n:N", "c:C"].map(|spec| {
            let (id, symbol) = spec.split_once(':').unwrap();
            board_theme(&theme(id, &[symbol]), &quotes, named)
        });
        let ids = |order| in_order(themes().to_vec(), order).into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(HeatmapThemeOrder::Custom), ["empty", "a", "b", "n", "c"]);
        assert_eq!(ids(HeatmapThemeOrder::Rate), ["b", "a", "c", "empty", "n"], "같은 값은 사용자 순서, 값이 없으면 맨 뒤");
        assert_eq!(ids(HeatmapThemeOrder::Traded), ["c", "a", "b", "n", "empty"]);
    }

    #[test]
    fn the_order_names_are_the_query_values() {
        for (raw, order) in [("rate", HeatmapThemeOrder::Rate), ("custom", HeatmapThemeOrder::Custom), ("traded", HeatmapThemeOrder::Traded)] {
            assert_eq!(HeatmapThemeOrder::parse(raw), Some(order));
            assert_eq!(serde_json::to_value(order).unwrap(), raw);
        }
        assert_eq!(HeatmapThemeOrder::parse("name"), None);
    }
}
