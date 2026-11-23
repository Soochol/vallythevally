use std::collections::HashMap;
use std::sync::Arc;

use domain::{KstDate, Symbol, Venue};

use crate::api::{Quote, QuoteSource, SymbolCode, UnixSeconds};
use crate::quotes::effective_venue;
use crate::shared_data::{Loaded, SharedData, SnapshotBody, SnapshotRow};
use crate::symbols::Directory;

struct Boards {
    loaded: [Option<Arc<Loaded<SnapshotBody>>>; 3],
}

impl Boards {
    fn of(data: &SharedData, today: KstDate) -> Boards {
        Boards { loaded: Venue::ALL.map(|venue| data.snapshot(venue).current().filter(|loaded| loaded.header.observation_date == today.yyyymmdd())) }
    }

    fn at(&self, venue: Venue) -> Option<&Arc<Loaded<SnapshotBody>>> {
        self.loaded[Venue::ALL.iter().position(|v| *v == venue).expect("모든 거래소가 ALL에 있다")].as_ref()
    }
}

fn stock_quote(symbol: Symbol, venue: Venue, row: &SnapshotRow, as_of: i64) -> Quote {
    let change = row.current_won as f64 - row.base_won as f64;
    Quote {
        symbol: SymbolCode(symbol.as_wire()),
        price: row.current_won as f64,
        change,
        change_rate: if row.base_won == 0 { 0.0 } else { change / row.base_won as f64 * 100.0 },
        volume: row.volume,
        t: UnixSeconds(row.traded_at.unwrap_or(as_of)),
        source: QuoteSource::Polled,
        venue: Some(venue.into()),
        traded_million_won: Some(row.traded_million_won),
    }
}

pub(super) struct SharedQuotes {
    pub quotes: HashMap<Symbol, Quote>,
    pub as_of: Option<UnixSeconds>,
}

pub(super) fn quotes(data: &SharedData, today: KstDate, wanted: &[Symbol], requested: Venue, directory: Option<&Directory>) -> SharedQuotes {
    let boards = Boards::of(data, today);
    let rows_by_venue: Vec<(Venue, HashMap<&str, &SnapshotRow>)> = Venue::ALL
        .iter()
        .filter_map(|venue| boards.at(*venue).map(|loaded| (*venue, loaded.body.stocks.iter().rev().map(|row| (row.code.as_str(), row)).collect())))
        .collect();
    let mut found = HashMap::with_capacity(wanted.len());
    let mut as_of: Option<i64> = None;
    for symbol in wanted {
        match symbol {
            Symbol::Stock(code) => {
                let nxt_enabled = directory.and_then(|d| d.get(*symbol)).is_some_and(|info| info.nxt_enabled);
                let venue = effective_venue(requested, nxt_enabled);
                let Some(row) = rows_by_venue.iter().find(|(v, _)| *v == venue).and_then(|(_, rows)| rows.get(code.as_str())) else { continue };
                let board_as_of = boards.at(venue).expect("행이 있으면 판이 있다").header.as_of;
                as_of = as_of.max(Some(board_as_of));
                found.insert(*symbol, stock_quote(*symbol, venue, row, board_as_of));
            }
            Symbol::Index(code) => {
                let Some((loaded, row)) = std::iter::once(requested).chain(Venue::ALL).find_map(|venue| boards.at(venue).and_then(|loaded| loaded.body.indices.iter().find(|row| row.code == code.as_str()).map(|row| (loaded, row)))) else { continue };
                as_of = as_of.max(Some(loaded.header.as_of));
                let change = if row.change_rate > -100.0 { row.level - row.level / (1.0 + row.change_rate / 100.0) } else { 0.0 };
                found.insert(
                    *symbol,
                    Quote { symbol: SymbolCode(symbol.as_wire()), price: row.level, change, change_rate: row.change_rate, volume: 0, t: UnixSeconds(loaded.header.as_of), source: QuoteSource::Polled, venue: None, traded_million_won: None },
                );
            }
        }
    }
    SharedQuotes { quotes: found, as_of: as_of.map(UnixSeconds) }
}
