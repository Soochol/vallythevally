//! 현재가(backend.md §8.2 "현재가"). 주식은 ka10095 통합(`_AL`) 시세, 지수는 지수 일봉의 최신 페이지에서 만든다.
//! ka10095는 지수 코드를 받지 않는다.

use std::collections::HashMap;

use domain::{Feed, IndexCode, Period, SeriesKey, StockCode, Symbol};

use crate::api;
use crate::bars::{BarError, BarService};
use crate::kiwoom::api::StockQuotes;
use crate::kiwoom::rest::{KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::parse_quotes;

/// 지수 현재가에 쓰는 봉: 마지막 봉과 그 앞 봉(기준가).
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
                (symbol, quote(symbol, q.price_centi, q.base_centi, q.volume.0, q.at.unix()))
            }));
        }
        Ok::<_, BarError>(out)
    };
    let index_quotes = futures::future::try_join_all(indexes.map(|c| index_quote(bars, c)));
    let (stock_quotes, index_quotes) = futures::try_join!(stock_quotes, index_quotes)?;
    let mut by_symbol: HashMap<Symbol, api::Quote> = stock_quotes.into_iter().chain(index_quotes.into_iter().flatten()).collect();
    Ok(symbols.iter().filter_map(|s| by_symbol.remove(s)).collect())
}

/// 마지막 봉(진행 중 봉이 있으면 그것)의 종가가 현재가, 그 앞 확정 봉의 종가가 기준가다. 봉이 둘 없으면 뺀다.
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
    Ok(Some((symbol, quote(symbol, last.close().centi(), prev.close().centi(), last.volume().0, bucket.start().unix()))))
}

/// 등락은 정수 centi로 계산한다. 기준가가 0이면 등락률은 0이다.
fn quote(symbol: Symbol, price_centi: u64, base_centi: u64, volume: u64, t: i64) -> api::Quote {
    let change_centi = price_centi as i64 - base_centi as i64;
    api::Quote {
        symbol: api::SymbolCode(symbol.as_wire()),
        price: price_centi as f64 / 100.0,
        change: change_centi as f64 / 100.0,
        change_rate: if base_centi == 0 { 0.0 } else { change_centi as f64 / base_centi as f64 * 100.0 },
        volume,
        t: api::UnixSeconds(t),
        source: api::QuoteSource::Polled,
    }
}
