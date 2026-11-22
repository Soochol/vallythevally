use std::sync::Arc;

use domain::{Feed, KstDate, Listing, Period, SeriesKey, StockCode, Venue, classify};
use futures::future::BoxFuture;

use super::api::{
    DailyChart, IndexDailyChart, IndexMinuteChart, IndexMonthlyChart, IndexWeeklyChart, IndexYearlyChart, MarketRequest, MinuteChart, MonthlyChart, StockBasicInfo, StockList, StockOrderBook,
    StockProgramTrades, StockQuotes, StockTrades, WeeklyChart, YearlyChart,
};
use super::rest::{ContKey, KiwoomError, KiwoomRest};
use super::wire::{self, ChartBody, ChartRows, StockBasicInfoResponse, parse_chart, parse_day_summary, parse_quotes};
use crate::api;
use crate::market_source::{
    ChartPage, Cursor, DaySummary, MarketFeatures, MarketSource, MergeScope, OrderBookSnapshot, Priority, QuoteRow, SourceError, SourceFailure, StockFundamentals, TapePage,
};
use crate::symbols::{Directory, MAX_LIST_PAGES, SymbolDirectory};

impl From<&KiwoomError> for SourceFailure {
    fn from(e: &KiwoomError) -> Self {
        let shown = e.shown();
        SourceFailure { code: shown.code, reason: shown.reason, message: e.to_string(), retry_at: shown.retry_at, manual_action_required: shown.manual_action_required }
    }
}

impl From<&KiwoomError> for SourceError {
    fn from(e: &KiwoomError) -> Self {
        SourceError::Failed(e.into())
    }
}

impl From<KiwoomError> for SourceError {
    fn from(e: KiwoomError) -> Self {
        (&e).into()
    }
}

impl From<KiwoomRest> for Arc<dyn MarketSource> {
    fn from(rest: KiwoomRest) -> Self {
        Arc::new(rest)
    }
}

fn cursor_of(key: ContKey) -> Cursor {
    Cursor::new(key.as_str())
}

fn cont_key_of(cursor: Option<Cursor>) -> Option<ContKey> {
    cursor.map(|c| ContKey::new(c.as_str()))
}

pub struct ListingPages {
    pub rows: Vec<domain::ListingRow>,
    pub stopped_at_page_limit_with_pages_left: bool,
}

pub async fn fetch_listing_rows(rest: &KiwoomRest, priority: Priority) -> Result<ListingPages, KiwoomError> {
    let mut rows = Vec::new();
    let mut stopped_at_page_limit_with_pages_left = false;
    for req in [StockList::EXCHANGE, StockList::KOSDAQ] {
        let mut cont = None;
        for _ in 0..MAX_LIST_PAGES {
            let page = rest.call(&req, cont.as_ref(), priority, MergeScope::default()).await?;
            rows.extend(page.body.list);
            cont = page.next;
            if cont.is_none() {
                break;
            }
        }
        stopped_at_page_limit_with_pages_left |= cont.is_some();
    }
    Ok(ListingPages { rows, stopped_at_page_limit_with_pages_left })
}

/// ka10099를 `mrkt_tp=0`, `10`으로 불러 목록을 만든다.
async fn fetch_directory(rest: &KiwoomRest, priority: Priority) -> Result<Directory, KiwoomError> {
    let mut stocks = Vec::new();
    let mut screener_listing = Vec::new();
    let mut unknown = Vec::new();
    for row in &fetch_listing_rows(rest, priority).await?.rows {
        match classify(row) {
            Listing::Include(info) => {
                screener_listing.extend(wire::screener_listing(row, &info));
                stocks.push(info);
            }
            Listing::Unknown(why) => unknown.push(why),
        }
    }
    if !unknown.is_empty() {
        tracing::warn!(count = unknown.len(), first = %unknown[0], "종목 목록에 표에 없는 행이 있어 넣지 않았습니다");
    }
    let dir = Directory::build(stocks).with_screener_listing(screener_listing);
    tracing::info!(count = dir.len(), "종목 목록을 받았습니다");
    Ok(dir)
}

pub async fn refresh_symbols(symbols: &SymbolDirectory, rest: &KiwoomRest, priority: Priority) -> Result<(), KiwoomError> {
    symbols.replace(fetch_directory(rest, priority).await?);
    Ok(())
}

async fn chart<R>(rest: &KiwoomRest, req: &R, cursor: Option<Cursor>, period: Period, priority: Priority, scope: MergeScope) -> Result<ChartPage, SourceError>
where
    R: MarketRequest,
    R::Response: ChartBody,
{
    let page = rest.call(req, cont_key_of(cursor).as_ref(), priority, scope).await?;
    match parse_chart(page.body, period) {
        Ok(ChartRows::Rows(bars)) => Ok(ChartPage { bars, next: page.next.map(cursor_of) }),
        Ok(ChartRows::UnknownSymbol) => Err(SourceError::UnknownSymbol),
        Err(e) => {
            tracing::error!(api_id = R::API_ID.as_str(), error = %e, "키움 봉 응답을 읽지 못했습니다");
            Err(SourceError::Malformed(format!("키움 응답을 읽지 못했습니다: {e}")))
        }
    }
}

impl MarketSource for KiwoomRest {
    fn features(&self) -> MarketFeatures {
        MarketFeatures::ALL
    }

    fn outage(&self) -> Option<SourceError> {
        self.blocked().as_ref().map(SourceError::from)
    }

    fn list_outage(&self) -> Option<SourceError> {
        self.stopped(super::api::ApiId::Ka10099).as_ref().map(SourceError::from)
    }

    fn until_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(async move { self.until_halted().await.into() })
    }

    fn until_list_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(async move { self.until_stopped(super::api::ApiId::Ka10099).await.into() })
    }

    fn directory(&self, priority: Priority) -> BoxFuture<'_, Result<Directory, SourceError>> {
        Box::pin(async move { Ok(fetch_directory(self, priority).await?) })
    }

    fn fundamentals(&self, code: StockCode, priority: Priority) -> BoxFuture<'_, Result<Option<StockFundamentals>, SourceError>> {
        Box::pin(async move {
            let page = self.call(&StockBasicInfo::new(code), None, priority, MergeScope::default()).await?;
            Ok(match page.body {
                StockBasicInfoResponse::UnknownSymbol => None,
                StockBasicInfoResponse::Found { fundamentals, .. } => Some(*fundamentals),
            })
        })
    }

    fn quotes(&self, rows: Vec<(StockCode, Venue)>, priority: Priority) -> BoxFuture<'_, Result<Vec<QuoteRow>, SourceError>> {
        Box::pin(async move {
            let mut out = Vec::new();
            for chunk in rows.chunks(StockQuotes::MAX) {
                let req = StockQuotes::of_venues(chunk).expect("chunks는 1~MAX개다");
                let page = self.call(&req, None, priority, MergeScope::default()).await?;
                out.extend(parse_quotes(page.body).into_iter().map(|q| QuoteRow {
                    code: q.code,
                    venue: q.venue,
                    price_centi: q.price_centi,
                    base_centi: q.base_centi,
                    volume: q.volume,
                    traded_million_won: q.traded.map(|t| t.0),
                    at: q.at,
                }));
            }
            Ok(out)
        })
    }

    fn day_summary(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<DaySummary, SourceError>> {
        Box::pin(async move {
            let req = StockQuotes::of_venues(&[(code, venue)]).expect("종목 하나다");
            let page = self.call(&req, None, priority, MergeScope::default()).await?;
            Ok(parse_day_summary(page.body, code, venue))
        })
    }

    fn chart_page(&self, key: SeriesKey, base: KstDate, cursor: Option<Cursor>, priority: Priority, scope: MergeScope) -> BoxFuture<'_, Result<ChartPage, SourceError>> {
        Box::pin(async move {
            const MINUTE: &str = "달력 봉이 아니면 분봉이다";
            let p = key.period;
            match key.feed {
                Feed::Stock(c, v) => match p {
                    Period::Day => chart(self, &DailyChart::new(c, v, base), cursor, p, priority, scope).await,
                    Period::Week => chart(self, &WeeklyChart::new(c, v, base), cursor, p, priority, scope).await,
                    Period::Month => chart(self, &MonthlyChart::new(c, v, base), cursor, p, priority, scope).await,
                    Period::Year => chart(self, &YearlyChart::new(c, v, base), cursor, p, priority, scope).await,
                    _ => chart(self, &MinuteChart::new(c, v, p, base).expect(MINUTE), cursor, p, priority, scope).await,
                },
                Feed::Index(c) => match p {
                    Period::Day => chart(self, &IndexDailyChart::new(c, base), cursor, p, priority, scope).await,
                    Period::Week => chart(self, &IndexWeeklyChart::new(c, base), cursor, p, priority, scope).await,
                    Period::Month => chart(self, &IndexMonthlyChart::new(c, base), cursor, p, priority, scope).await,
                    Period::Year => chart(self, &IndexYearlyChart::new(c, base), cursor, p, priority, scope).await,
                    _ => chart(self, &IndexMinuteChart::new(c, p, base).expect(MINUTE), cursor, p, priority, scope).await,
                },
            }
        })
    }

    fn order_book(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<OrderBookSnapshot, SourceError>> {
        Box::pin(async move {
            let book = self.call(&StockOrderBook::new(code, venue), None, priority, MergeScope::default()).await?.body;
            Ok(OrderBookSnapshot {
                asks: book.asks,
                bids: book.bids,
                total_ask_quantity: book.total_ask_quantity,
                total_bid_quantity: book.total_bid_quantity,
                after_hours_ask_quantity: book.after_hours_ask_quantity,
                after_hours_bid_quantity: book.after_hours_bid_quantity,
                book_time: book.book_time,
            })
        })
    }

    fn trades_page(&self, code: StockCode, venue: Venue, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::TradePrint>, SourceError>> {
        Box::pin(async move {
            let page = self.call(&StockTrades::new(code, venue), cont_key_of(cursor).as_ref(), priority, MergeScope::default()).await?;
            let parsed = page.body.trades();
            Ok(TapePage { rows: parsed.rows, skipped: parsed.skipped, next: page.next.map(cursor_of) })
        })
    }

    fn program_trades_page(&self, code: StockCode, today: KstDate, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::ProgramTradePoint>, SourceError>> {
        Box::pin(async move {
            let page = self.call(&StockProgramTrades::new(code, today), cont_key_of(cursor).as_ref(), priority, MergeScope::default()).await?;
            let parsed = page.body.points();
            Ok(TapePage { rows: parsed.rows, skipped: parsed.skipped, next: page.next.map(cursor_of) })
        })
    }
}
