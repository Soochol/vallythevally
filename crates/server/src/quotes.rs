//! 현재가(backend.md §4.6 "현재가의 등락", §8.2).
//!
//! ka10095는 지수 코드를 받지 않는다. 그래서 지수 현재가는 지수 일봉의 최신 페이지에서 만든다.

use std::collections::HashMap;

use domain::{Feed, IndexCode, KstTime, Period, Price, SeriesKey, StockCode, Symbol, Venue};

use crate::api;
use crate::bars::{BarError, BarService};
use crate::kiwoom::api::StockQuotes;
use crate::kiwoom::rest::{KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::parse_quotes;
use crate::market::venue_volume::DayVolumes;
use crate::symbols::Directory;

const INDEX_BARS: usize = 2;

pub fn effective_venue(requested: Venue, nxt_enabled: bool) -> Venue {
    match requested {
        Venue::Nxt if !nxt_enabled => Venue::Combined,
        venue => venue,
    }
}

/// `symbols`는 중복이 없어야 한다. 값을 얻은 종목만 요청 순서대로 돌려준다.
pub async fn quotes(rest: &KiwoomRest, bars: &BarService, directory: Option<&Directory>, symbols: &[Symbol], requested: Venue) -> Result<Vec<api::Quote>, BarError> {
    let stocks: Vec<(StockCode, Venue)> = symbols
        .iter()
        .filter_map(|s| if let Symbol::Stock(c) = s { Some(*c) } else { None })
        .map(|code| {
            let nxt_enabled = directory.and_then(|d| d.get(Symbol::Stock(code))).is_some_and(|info| info.nxt_enabled);
            (code, effective_venue(requested, nxt_enabled))
        })
        .collect();
    let indexes = symbols.iter().filter_map(|s| if let Symbol::Index(c) = s { Some(*c) } else { None });
    let stock_quotes = async {
        let mut out = Vec::new();
        for chunk in stocks.chunks(StockQuotes::MAX) {
            let req = StockQuotes::of_venues(chunk).expect("chunks는 1~MAX개다");
            let page = rest.call(&req, None, Priority::Screen, MergeScope::default()).await?;
            let asked: HashMap<StockCode, Venue> = chunk.iter().copied().collect();
            out.extend(parse_quotes(page.body).into_iter().filter(|q| asked.get(&q.code) == Some(&q.venue)).map(|q| {
                let symbol = Symbol::Stock(q.code);
                (symbol, quote(symbol, Some(q.venue), q.price_centi, q.base_centi, q.volume.0, q.at.unix(), api::QuoteSource::Polled))
            }));
        }
        Ok::<_, BarError>(out)
    };
    let index_quotes = futures::future::try_join_all(indexes.map(|c| index_quote(bars, c)));
    let (stock_quotes, index_quotes) = futures::try_join!(stock_quotes, index_quotes)?;
    let mut by_symbol: HashMap<Symbol, api::Quote> = stock_quotes.into_iter().chain(index_quotes.into_iter().flatten()).collect();
    Ok(symbols.iter().filter_map(|s| by_symbol.remove(s)).collect())
}

async fn index_quote(bars: &BarService, code: IndexCode) -> Result<Option<(Symbol, api::Quote)>, BarError> {
    let key = SeriesKey { feed: Feed::Index(code), period: Period::Day };
    let page = match bars.page(key, None, INDEX_BARS).await {
        Err(BarError::UnknownSymbol) => return Ok(None),
        r => r?,
    };
    let mut recent: Vec<_> = page.bars.iter().map(|b| (b.bucket, b.ohlcv)).collect();
    recent.extend(page.current.map(|c| (c.bucket, c.ohlcv)));
    let [.., (_, prev), (bucket, last)] = recent[..] else {
        return Ok(None);
    };
    let symbol = Symbol::Index(code);
    Ok(Some((symbol, quote(symbol, None, last.close().centi(), prev.close().centi(), last.volume().0, bucket.start().unix(), api::QuoteSource::Polled))))
}

pub fn base_centi(price: Price, change_centi: i64) -> Option<u64> {
    u64::try_from(price.centi() as i64 - change_centi).ok().filter(|b| *b > 0)
}

pub fn realtime(symbol: Symbol, venue: Venue, price: Price, base_centi: u64, volume: u64, at: KstTime) -> api::Quote {
    let venue = matches!(symbol, Symbol::Stock(_)).then_some(venue);
    quote(symbol, venue, price.centi(), base_centi, volume, at.unix(), api::QuoteSource::Realtime)
}

pub async fn day_volumes(rest: &KiwoomRest, codes: &[StockCode]) -> Result<HashMap<StockCode, DayVolumes>, crate::kiwoom::rest::KiwoomError> {
    let rows: Vec<(StockCode, Venue)> = codes.iter().flat_map(|c| [Venue::Combined, Venue::Krx, Venue::Nxt].map(|v| (*c, v))).collect();
    let req = StockQuotes::of_venues(&rows).expect("종목 수가 DAY_VOLUME_CHUNK 이하다");
    let page = rest.call(&req, None, Priority::Screen, MergeScope::default()).await?;
    let mut seen: HashMap<StockCode, [Option<u64>; 3]> = HashMap::new();
    for q in parse_quotes(page.body) {
        let slot = match q.venue {
            Venue::Combined => 0,
            Venue::Krx => 1,
            Venue::Nxt => 2,
        };
        seen.entry(q.code).or_default()[slot] = Some(q.volume.0);
    }
    Ok(seen.into_iter().filter_map(|(code, v)| Some((code, DayVolumes { combined: v[0]?, krx: v[1]?, nxt: v[2]? }))).collect())
}

pub const DAY_VOLUME_CHUNK: usize = StockQuotes::MAX / 3;

fn quote(symbol: Symbol, venue: Option<Venue>, price_centi: u64, base_centi: u64, volume: u64, t: i64, source: api::QuoteSource) -> api::Quote {
    let change_centi = price_centi as i64 - base_centi as i64;
    api::Quote {
        symbol: api::SymbolCode(symbol.as_wire()),
        price: price_centi as f64 / 100.0,
        change: change_centi as f64 / 100.0,
        change_rate: if base_centi == 0 { 0.0 } else { change_centi as f64 / base_centi as f64 * 100.0 },
        volume,
        t: api::UnixSeconds(t),
        source,
        venue: venue.map(Into::into),
    }
}

#[cfg(test)]
mod tests {
    use domain::KstDate;

    use super::*;
    use crate::clock::kst;

    #[test]
    fn a_realtime_quote_uses_the_same_change_rule_as_rest() {
        let symbol = Symbol::parse("005930").unwrap();
        let at = kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 1);
        let price = Price::from_centi(19_340_000).unwrap();
        let base = base_centi(price, -810_000).unwrap();
        let q = realtime(symbol, Venue::Combined, price, base, 56_147_847, at);
        assert_eq!(q, quote(symbol, Some(Venue::Combined), 19_340_000, 20_150_000, 56_147_847, at.unix(), api::QuoteSource::Realtime));
        assert_eq!((q.price, q.change, q.volume, q.source, q.venue), (193_400.0, -8_100.0, 56_147_847, api::QuoteSource::Realtime, Some(api::Venue::Combined)));
        assert!((q.change_rate - -4.0198).abs() < 1e-3, "{}", q.change_rate);
        assert_eq!(base_centi(price, 19_340_000), None, "기준가 0");
    }

    #[test]
    fn only_nxt_requests_fall_back_to_combined_for_symbols_not_on_nxt() {
        assert_eq!(effective_venue(Venue::Nxt, false), Venue::Combined);
        assert_eq!(effective_venue(Venue::Nxt, true), Venue::Nxt);
        assert_eq!(effective_venue(Venue::Krx, false), Venue::Krx);
        assert_eq!(effective_venue(Venue::Combined, false), Venue::Combined);
    }
}
