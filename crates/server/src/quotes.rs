//! 현재가(backend.md §4.6 "현재가의 등락", §8.2).
//!
//! ka10095는 지수 코드를 받지 않는다. 그래서 지수 현재가는 지수 일봉의 최신 페이지에서 만든다.

use std::collections::HashMap;

use domain::{Feed, IndexCode, KstTime, Period, Price, SeriesKey, StockCode, Symbol};

use crate::api;
use crate::bars::{BarError, BarService};
use crate::kiwoom::api::StockQuotes;
use crate::kiwoom::rest::{KiwoomRest, MergeScope, Priority};
use crate::kiwoom::stream::DayTotals;
use crate::kiwoom::wire::parse_quotes;

const INDEX_BARS: usize = 2;

/// `symbols`는 중복이 없어야 한다. 값을 얻은 종목만 요청 순서대로 돌려준다.
pub async fn quotes(rest: &KiwoomRest, bars: &BarService, symbols: &[Symbol]) -> Result<Vec<api::Quote>, BarError> {
    let stocks: Vec<StockCode> = symbols.iter().filter_map(|s| if let Symbol::Stock(c) = s { Some(*c) } else { None }).collect();
    let indexes = symbols.iter().filter_map(|s| if let Symbol::Index(c) = s { Some(*c) } else { None });
    let stock_quotes = async {
        let mut out = Vec::new();
        for chunk in stocks.chunks(StockQuotes::MAX) {
            let req = StockQuotes::new(chunk).expect("chunks는 1~MAX개다");
            let page = rest.call(&req, None, Priority::Screen, MergeScope::default()).await?;
            out.extend(parse_quotes(page.body).into_iter().map(|q| {
                let symbol = Symbol::Stock(q.code);
                (symbol, quote(symbol, q.price_centi, q.base_centi, q.volume.0, q.at.unix(), api::QuoteSource::Polled))
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
    Ok(Some((symbol, quote(symbol, last.close().centi(), prev.close().centi(), last.volume().0, bucket.start().unix(), api::QuoteSource::Polled))))
}

/// 기준가는 |현재가| − 전일대비다(kiwoom.md §11.3).
pub fn realtime(symbol: Symbol, price: Price, day: DayTotals, at: KstTime) -> Option<api::Quote> {
    let base_centi = u64::try_from(price.centi() as i64 - day.change_centi).ok().filter(|b| *b > 0)?;
    Some(quote(symbol, price.centi(), base_centi, day.cumulative.0, at.unix(), api::QuoteSource::Realtime))
}

fn quote(symbol: Symbol, price_centi: u64, base_centi: u64, volume: u64, t: i64, source: api::QuoteSource) -> api::Quote {
    let change_centi = price_centi as i64 - base_centi as i64;
    api::Quote {
        symbol: api::SymbolCode(symbol.as_wire()),
        price: price_centi as f64 / 100.0,
        change: change_centi as f64 / 100.0,
        change_rate: if base_centi == 0 { 0.0 } else { change_centi as f64 / base_centi as f64 * 100.0 },
        volume,
        t: api::UnixSeconds(t),
        source,
    }
}

#[cfg(test)]
mod tests {
    use domain::{KstDate, Volume};

    use super::*;
    use crate::clock::kst;

    #[test]
    fn a_realtime_quote_uses_the_same_change_rule_as_rest() {
        let symbol = Symbol::parse("005930").unwrap();
        let at = kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 1);
        let price = Price::from_centi(19_340_000).unwrap();
        let q = realtime(symbol, price, DayTotals { change_centi: -810_000, cumulative: Volume(56_147_847) }, at).unwrap();
        assert_eq!(q, quote(symbol, 19_340_000, 20_150_000, 56_147_847, at.unix(), api::QuoteSource::Realtime));
        assert_eq!((q.price, q.change, q.volume, q.source), (193_400.0, -8_100.0, 56_147_847, api::QuoteSource::Realtime));
        assert!((q.change_rate - -4.0198).abs() < 1e-3, "{}", q.change_rate);
        assert_eq!(realtime(symbol, price, DayTotals { change_centi: 19_340_000, cumulative: Volume(1) }, at), None, "기준가 0");
    }
}
