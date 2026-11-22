use std::sync::{Arc, Mutex};
use std::time::Duration;

use domain::{Feed, IndexCode, KstDate, KstTime, Ohlcv, Period, Price, SeriesKey, StockCode, TimeOfDay, Venue, Volume, Weekday};
use futures::future::BoxFuture;
use serde::Deserialize;

use super::api::KisApiId;
use super::error::Category;
use super::master::{MasterDownload, MasterError, load_master};
use super::minute_bars::{Minute, MinuteCursor, Position, build};
use super::rest::{KisError, KisPage, KisRequest, KisRest, Priority as KisPriority};
use crate::api::{self, ApiErrorCode, ApiErrorReason};
use crate::clock::Clock;
use crate::kis::auth::Halt;
use crate::market_source::{
    ChartPage, Cursor, DaySummary, MarketFeature, MarketFeatures, MarketSource, MergeScope, OrderBookSnapshot, PeriodBar, Priority, QuoteRow, SourceError, SourceFailure, StockFundamentals, TapePage,
};
use crate::symbols::Directory;

pub const MULTI_PRICE_MAX_ROWS: usize = 30;
pub const DAILY_PAGE_ROWS: usize = 100;
pub const TODAY_MINUTE_PAGE_ROWS: usize = 30;
pub const PAST_MINUTE_PAGE_ROWS: usize = 120;
pub const MINUTE_PAGE_BUDGET: usize = 20;
const MAX_EMPTY_SESSION_DAYS: usize = 10;
const ADJUSTED_PRICE_FLAG: &str = "0";
const PAST_MINUTE_INCLUDES_OLDER_DAYS: &str = "N";
const TODAY_MINUTE_INCLUDES_OLDER_DAYS: &str = "N";
const INDEX_MINUTE_SECONDS: &str = "60";
const INDEX_MINUTE_INCLUDES_OLDER: &str = "Y";
const INDEX_MINUTE_ETC_CLASS: &str = "0";
const INDEX_MARKET_DIVISION: &str = "U";
const COMBINED_MARKET: &str = "UN";
const KRX_MARKET: &str = "J";
const NXT_MARKET: &str = "NX";
const KOSPI_INDEX_CODE: &str = "0001";
const KOSDAQ_INDEX_CODE: &str = "1001";
const WON_PER_EOK: u64 = 100_000_000;
const WON_PER_MILLION: u64 = 1_000_000;
const LAST_MINUTE_OF_SESSION: TimeOfDay = match TimeOfDay::hms(19, 59, 0) {
    Some(t) => t,
    None => unreachable!(),
};
const MASTER_RETRY_SECS: i64 = 600;
const OUTAGE_POLL: Duration = Duration::from_secs(1);
const INDEX_HISTORY_START: (i32, u8, u8) = (1980, 1, 1);
const MULTI_MARKET_KEYS: [&str; MULTI_PRICE_MAX_ROWS] = [
    "FID_COND_MRKT_DIV_CODE_1",
    "FID_COND_MRKT_DIV_CODE_2",
    "FID_COND_MRKT_DIV_CODE_3",
    "FID_COND_MRKT_DIV_CODE_4",
    "FID_COND_MRKT_DIV_CODE_5",
    "FID_COND_MRKT_DIV_CODE_6",
    "FID_COND_MRKT_DIV_CODE_7",
    "FID_COND_MRKT_DIV_CODE_8",
    "FID_COND_MRKT_DIV_CODE_9",
    "FID_COND_MRKT_DIV_CODE_10",
    "FID_COND_MRKT_DIV_CODE_11",
    "FID_COND_MRKT_DIV_CODE_12",
    "FID_COND_MRKT_DIV_CODE_13",
    "FID_COND_MRKT_DIV_CODE_14",
    "FID_COND_MRKT_DIV_CODE_15",
    "FID_COND_MRKT_DIV_CODE_16",
    "FID_COND_MRKT_DIV_CODE_17",
    "FID_COND_MRKT_DIV_CODE_18",
    "FID_COND_MRKT_DIV_CODE_19",
    "FID_COND_MRKT_DIV_CODE_20",
    "FID_COND_MRKT_DIV_CODE_21",
    "FID_COND_MRKT_DIV_CODE_22",
    "FID_COND_MRKT_DIV_CODE_23",
    "FID_COND_MRKT_DIV_CODE_24",
    "FID_COND_MRKT_DIV_CODE_25",
    "FID_COND_MRKT_DIV_CODE_26",
    "FID_COND_MRKT_DIV_CODE_27",
    "FID_COND_MRKT_DIV_CODE_28",
    "FID_COND_MRKT_DIV_CODE_29",
    "FID_COND_MRKT_DIV_CODE_30",
];
const MULTI_CODE_KEYS: [&str; MULTI_PRICE_MAX_ROWS] = [
    "FID_INPUT_ISCD_1",
    "FID_INPUT_ISCD_2",
    "FID_INPUT_ISCD_3",
    "FID_INPUT_ISCD_4",
    "FID_INPUT_ISCD_5",
    "FID_INPUT_ISCD_6",
    "FID_INPUT_ISCD_7",
    "FID_INPUT_ISCD_8",
    "FID_INPUT_ISCD_9",
    "FID_INPUT_ISCD_10",
    "FID_INPUT_ISCD_11",
    "FID_INPUT_ISCD_12",
    "FID_INPUT_ISCD_13",
    "FID_INPUT_ISCD_14",
    "FID_INPUT_ISCD_15",
    "FID_INPUT_ISCD_16",
    "FID_INPUT_ISCD_17",
    "FID_INPUT_ISCD_18",
    "FID_INPUT_ISCD_19",
    "FID_INPUT_ISCD_20",
    "FID_INPUT_ISCD_21",
    "FID_INPUT_ISCD_22",
    "FID_INPUT_ISCD_23",
    "FID_INPUT_ISCD_24",
    "FID_INPUT_ISCD_25",
    "FID_INPUT_ISCD_26",
    "FID_INPUT_ISCD_27",
    "FID_INPUT_ISCD_28",
    "FID_INPUT_ISCD_29",
    "FID_INPUT_ISCD_30",
];

pub const SUPPORTED_FEATURES: [MarketFeature; 12] = [
    MarketFeature::Directory,
    MarketFeature::Fundamentals,
    MarketFeature::Quotes,
    MarketFeature::DayBars,
    MarketFeature::WeekBars,
    MarketFeature::MonthBars,
    MarketFeature::YearBars,
    MarketFeature::MinuteBars,
    MarketFeature::IndexBars,
    MarketFeature::OrderBook,
    MarketFeature::Trades,
    MarketFeature::ProgramTrades,
];

pub struct KisMarket {
    rest: KisRest,
    clock: Clock,
    master: Arc<dyn MasterDownload>,
    directory_size: Mutex<Option<usize>>,
    list_outage: Mutex<Option<SourceError>>,
}

impl From<KisMarket> for Arc<dyn MarketSource> {
    fn from(market: KisMarket) -> Self {
        Arc::new(market)
    }
}

impl KisMarket {
    pub fn new(rest: KisRest, clock: Clock, master: Arc<dyn MasterDownload>) -> Self {
        KisMarket { rest, clock, master, directory_size: Mutex::new(None), list_outage: Mutex::new(None) }
    }

    async fn page(&self, api: KisApiId, query: Vec<(&'static str, String)>, priority: Priority) -> Result<KisPage, SourceError> {
        self.rest.call(KisRequest::new(api, query, kis_priority(priority))).await.map_err(|e| failure_of(&e))
    }

    async fn next_page(&self, api: KisApiId, query: Vec<(&'static str, String)>, priority: Priority) -> Result<KisPage, SourceError> {
        self.rest.call(KisRequest::new(api, query, kis_priority(priority)).next_page()).await.map_err(|e| failure_of(&e))
    }

    async fn body<T: for<'de> Deserialize<'de>>(&self, api: KisApiId, query: Vec<(&'static str, String)>, priority: Priority) -> Result<T, SourceError> {
        let page = self.page(api, query, priority).await?;
        parse_body(api, &page)
    }

    async fn stock_chart_calendar(&self, code: StockCode, venue: Venue, period: Period, base: KstDate, cursor: Option<Cursor>, priority: Priority) -> Result<ChartPage, SourceError> {
        let end = match cursor {
            Some(cursor) => KstDate::parse_yyyymmdd(cursor.as_str()).ok_or_else(|| SourceError::Malformed("한투 일봉 연속조회 키를 읽지 못했습니다".into()))?,
            None => base,
        };
        let query = vec![
            ("FID_COND_MRKT_DIV_CODE", market_division(venue).into()),
            ("FID_INPUT_ISCD", code.as_str().into()),
            ("FID_INPUT_DATE_1", end.add_days(-calendar_window_days(period)).yyyymmdd()),
            ("FID_INPUT_DATE_2", end.yyyymmdd()),
            ("FID_PERIOD_DIV_CODE", calendar_period_code(period).into()),
            ("FID_ORG_ADJ_PRC", ADJUSTED_PRICE_FLAG.into()),
        ];
        let body: ChartBody = self.body(KisApiId::DailyChart, query, priority).await?;
        let bars = calendar_bars(period, &body.output2)?;
        let next = (body.output2.len() >= DAILY_PAGE_ROWS).then(|| bars.first().map(|oldest| oldest.bucket.start().kst_date().add_days(-1))).flatten();
        Ok(ChartPage { bars, next: next.map(|date| Cursor::new(date.yyyymmdd())) })
    }

    async fn index_chart_calendar(&self, code: IndexCode, period: Period, base: KstDate, cursor: Option<Cursor>, priority: Priority) -> Result<ChartPage, SourceError> {
        let index_code = kis_index_code(code)?;
        let (year, month, day) = INDEX_HISTORY_START;
        let query = vec![
            ("FID_COND_MRKT_DIV_CODE", INDEX_MARKET_DIVISION.into()),
            ("FID_INPUT_ISCD", index_code.into()),
            ("FID_INPUT_DATE_1", KstDate::new(year, month, day).expect("상수 날짜").yyyymmdd()),
            ("FID_INPUT_DATE_2", base.yyyymmdd()),
            ("FID_PERIOD_DIV_CODE", calendar_period_code(period).into()),
        ];
        let page = if cursor.is_some() { self.next_page(KisApiId::IndexChart, query, priority).await? } else { self.page(KisApiId::IndexChart, query, priority).await? };
        let body: ChartBody = parse_body(KisApiId::IndexChart, &page)?;
        Ok(ChartPage { bars: calendar_bars(period, &body.output2)?, next: page.more.then(|| Cursor::new("next")) })
    }

    fn first_minute_bound(&self, base: KstDate) -> KstTime {
        let now = self.clock.now();
        let last = KstTime::from_kst_civil(base, LAST_MINUTE_OF_SESSION);
        if base == now.kst_date() { minute_floor(now).min(last) } else { last }
    }

    async fn stock_chart_minutes(&self, code: StockCode, venue: Venue, period: Period, base: KstDate, cursor: Option<Cursor>, priority: Priority) -> Result<ChartPage, SourceError> {
        let (mut at, mut minutes) = match cursor {
            Some(cursor) => match MinuteCursor::decode(cursor.as_str()) {
                Some(MinuteCursor { position: Position::StockAt { at_unix }, carried }) => (KstTime::from_unix(at_unix), carried),
                _ => return Err(SourceError::Malformed("한투 분봉 연속조회 키를 읽지 못했습니다".into())),
            },
            None => (self.first_minute_bound(base), Vec::new()),
        };
        let mut pages = 0;
        let mut empty_days = 0;
        let mut exhausted = false;
        loop {
            if exhausted || pages >= MINUTE_PAGE_BUDGET {
                let built = build(period, &minutes, !exhausted).map_err(|bad| malformed_minute(&bad))?;
                if exhausted || !built.bars.is_empty() {
                    let next = (!exhausted).then(|| Cursor::new(MinuteCursor { position: Position::StockAt { at_unix: at.unix() }, carried: built.held_back }.encode()));
                    return Ok(ChartPage { bars: built.bars, next });
                }
            }
            pages += 1;
            let today = self.clock.now().kst_date();
            let date = at.kst_date();
            let (api, page_rows, includes_older) = if date == today {
                (KisApiId::TodayMinuteChart, TODAY_MINUTE_PAGE_ROWS, TODAY_MINUTE_INCLUDES_OLDER_DAYS)
            } else {
                (KisApiId::PastMinuteChart, PAST_MINUTE_PAGE_ROWS, PAST_MINUTE_INCLUDES_OLDER_DAYS)
            };
            let mut query = vec![
                ("FID_COND_MRKT_DIV_CODE", market_division(venue).into()),
                ("FID_INPUT_ISCD", code.as_str().into()),
                ("FID_INPUT_HOUR_1", clock_text(at)),
                ("FID_PW_DATA_INCU_YN", includes_older.into()),
            ];
            if api == KisApiId::PastMinuteChart {
                query.push(("FID_INPUT_DATE_1", date.yyyymmdd()));
                query.push(("FID_FAKE_TICK_INCU_YN", String::new()));
            } else {
                query.push(("FID_ETC_CLS_CODE", String::new()));
            }
            let body: ChartBody = self.body(api, query, priority).await?;
            let rows = minute_rows(&body.output2, Some(at))?;
            let received = body.output2.len();
            if rows.is_empty() {
                empty_days += 1;
                if empty_days >= MAX_EMPTY_SESSION_DAYS {
                    exhausted = true;
                } else {
                    at = previous_session_end(date);
                }
                continue;
            }
            empty_days = 0;
            let oldest = rows.iter().map(|m| m.start_unix).min().expect("비지 않았다");
            at = if received < page_rows { previous_session_end(date) } else { KstTime::from_unix(oldest - 60) };
            minutes.extend(rows);
        }
    }

    async fn index_chart_minutes(&self, code: IndexCode, period: Period, cursor: Option<Cursor>, priority: Priority) -> Result<ChartPage, SourceError> {
        let index_code = kis_index_code(code)?;
        let (mut minutes, mut continuing) = match cursor {
            Some(cursor) => match MinuteCursor::decode(cursor.as_str()) {
                Some(MinuteCursor { position: Position::IndexNextPage, carried }) => (carried, true),
                _ => return Err(SourceError::Malformed("한투 지수 분봉 연속조회 키를 읽지 못했습니다".into())),
            },
            None => (Vec::new(), false),
        };
        let query = || {
            vec![
                ("FID_COND_MRKT_DIV_CODE", INDEX_MARKET_DIVISION.to_owned()),
                ("FID_ETC_CLS_CODE", INDEX_MINUTE_ETC_CLASS.to_owned()),
                ("FID_INPUT_ISCD", index_code.to_owned()),
                ("FID_INPUT_HOUR_1", INDEX_MINUTE_SECONDS.to_owned()),
                ("FID_PW_DATA_INCU_YN", INDEX_MINUTE_INCLUDES_OLDER.to_owned()),
            ]
        };
        let mut pages = 0;
        loop {
            pages += 1;
            let page = if continuing { self.next_page(KisApiId::IndexMinuteChart, query(), priority).await? } else { self.page(KisApiId::IndexMinuteChart, query(), priority).await? };
            continuing = true;
            let body: ChartBody = parse_body(KisApiId::IndexMinuteChart, &page)?;
            minutes.extend(minute_rows(&body.output2, None)?);
            let more = page.more;
            let must_continue = more && (pages < MINUTE_PAGE_BUDGET || build(period, &minutes, true).map_err(|bad| malformed_minute(&bad))?.bars.is_empty());
            if must_continue {
                continue;
            }
            let built = build(period, &minutes, more).map_err(|bad| malformed_minute(&bad))?;
            let next = more.then(|| Cursor::new(MinuteCursor { position: Position::IndexNextPage, carried: built.held_back }.encode()));
            return Ok(ChartPage { bars: built.bars, next });
        }
    }
}

impl MarketSource for KisMarket {
    fn features(&self) -> MarketFeatures {
        SUPPORTED_FEATURES.into_iter().fold(MarketFeatures::NONE, MarketFeatures::with)
    }

    fn outage(&self) -> Option<SourceError> {
        self.rest.auth().halted().map(|halt| halt_error(&halt))
    }

    fn list_outage(&self) -> Option<SourceError> {
        self.list_outage.lock().expect("목록 장애 잠금").clone()
    }

    fn until_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(async move {
            loop {
                if let Some(error) = self.outage() {
                    return error;
                }
                tokio::time::sleep(OUTAGE_POLL).await;
            }
        })
    }

    fn until_list_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(async move {
            loop {
                if let Some(error) = self.list_outage() {
                    return error;
                }
                tokio::time::sleep(OUTAGE_POLL).await;
            }
        })
    }

    fn directory(&self, _priority: Priority) -> BoxFuture<'_, Result<Directory, SourceError>> {
        Box::pin(async move {
            let previous = *self.directory_size.lock().expect("목록 크기 잠금");
            match load_master(self.master.as_ref(), previous).await {
                Ok(listing) => {
                    if !listing.unrecognized.is_empty() {
                        tracing::warn!(count = listing.unrecognized.len(), first = %listing.unrecognized[0], "한투 종목 마스터에 표에 없는 행이 있어 넣지 않았습니다");
                    }
                    *self.directory_size.lock().expect("목록 크기 잠금") = Some(listing.stocks.len());
                    *self.list_outage.lock().expect("목록 장애 잠금") = None;
                    let dir = Directory::build(listing.stocks);
                    tracing::info!(count = dir.len(), "한투 종목 마스터를 받았습니다");
                    Ok(dir)
                }
                Err(e) => {
                    tracing::warn!(error = %e, "한투 종목 마스터를 쓰지 않습니다. 이전 목록이 있으면 그대로 씁니다");
                    let error = master_failure(&e, self.clock.now());
                    *self.list_outage.lock().expect("목록 장애 잠금") = Some(error.clone());
                    Err(error)
                }
            }
        })
    }

    fn fundamentals(&self, code: StockCode, priority: Priority) -> BoxFuture<'_, Result<Option<StockFundamentals>, SourceError>> {
        Box::pin(async move {
            let body: PriceBody = self.body(KisApiId::CurrentPrice, price_query(code, Venue::Krx), priority).await?;
            let row = body.output;
            if whole(&row.stck_prpr).is_none() {
                return Ok(None);
            }
            Ok(Some(StockFundamentals {
                market_cap_won: whole(&row.hts_avls).and_then(|eok| eok.checked_mul(WON_PER_EOK)),
                listed_shares: whole(&row.lstn_stcn),
                per: float(&row.per),
                pbr: float(&row.pbr),
                roe_pct: None,
                eps_won: signed_whole(&row.eps),
                bps_won: signed_whole(&row.bps),
                foreign_exhaustion_pct: float(&row.hts_frgn_ehrt),
                high_250_won: whole(&row.w52_hgpr),
                low_250_won: whole(&row.w52_lwpr),
                upper_limit_won: whole(&row.stck_mxpr),
                lower_limit_won: whole(&row.stck_llam),
            }))
        })
    }

    fn quotes(&self, rows: Vec<(StockCode, Venue)>, priority: Priority) -> BoxFuture<'_, Result<Vec<QuoteRow>, SourceError>> {
        Box::pin(async move {
            let mut out = Vec::new();
            for chunk in rows.chunks(MULTI_PRICE_MAX_ROWS) {
                let query = chunk
                    .iter()
                    .enumerate()
                    .flat_map(|(i, (code, venue))| [(MULTI_MARKET_KEYS[i], market_division(*venue).to_owned()), (MULTI_CODE_KEYS[i], code.as_str().to_owned())])
                    .collect();
                let body: MultiPriceBody = self.body(KisApiId::MultiPrice, query, priority).await?;
                let mut unmatched: Vec<(StockCode, Venue)> = chunk.to_vec();
                for row in body.output {
                    let Ok(code) = StockCode::parse(row.inter_shrn_iscd.trim()) else { continue };
                    let Some(at) = unmatched.iter().position(|(wanted, _)| *wanted == code) else { continue };
                    let (_, venue) = unmatched.remove(at);
                    let (Some(price), Some(base)) = (centi(&row.inter2_prpr).filter(|p| *p > 0), centi(&row.inter2_sdpr).filter(|p| *p > 0)) else { continue };
                    out.push(QuoteRow {
                        code,
                        venue,
                        price_centi: price,
                        base_centi: base,
                        volume: Volume(whole(&row.acml_vol).unwrap_or(0)),
                        traded_million_won: whole(&row.acml_tr_pbmn).map(|won| won / WON_PER_MILLION),
                        at: self.clock.now(),
                    });
                }
            }
            Ok(out)
        })
    }

    fn day_summary(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<DaySummary, SourceError>> {
        Box::pin(async move {
            let body: PriceBody = self.body(KisApiId::CurrentPrice, price_query(code, venue), priority).await?;
            let row = body.output;
            let present = |s: &str| whole(s).filter(|n| *n > 0);
            Ok(DaySummary {
                price_won: present(&row.stck_prpr),
                base_won: present(&row.stck_sdpr),
                open_won: present(&row.stck_oprc),
                high_won: present(&row.stck_hgpr),
                low_won: present(&row.stck_lwpr),
                volume: present(&row.acml_vol),
                trade_value_won: present(&row.acml_tr_pbmn),
                at: present(&row.stck_prpr).map(|_| self.clock.now()),
            })
        })
    }

    fn chart_page(&self, key: SeriesKey, base: KstDate, cursor: Option<Cursor>, priority: Priority, _scope: MergeScope) -> BoxFuture<'_, Result<ChartPage, SourceError>> {
        Box::pin(async move {
            let period = key.period;
            if period == Period::Quarter {
                return Err(SourceError::Malformed("분기봉은 월봉으로 만듭니다".into()));
            }
            match (key.feed, period.is_intraday()) {
                (Feed::Stock(code, venue), false) => self.stock_chart_calendar(code, venue, period, base, cursor, priority).await,
                (Feed::Stock(code, venue), true) => self.stock_chart_minutes(code, venue, period, base, cursor, priority).await,
                (Feed::Index(code), false) => self.index_chart_calendar(code, period, base, cursor, priority).await,
                (Feed::Index(code), true) => self.index_chart_minutes(code, period, cursor, priority).await,
            }
        })
    }

    fn order_book(&self, code: StockCode, venue: Venue, priority: Priority) -> BoxFuture<'_, Result<OrderBookSnapshot, SourceError>> {
        Box::pin(async move {
            let query = vec![("FID_COND_MRKT_DIV_CODE", market_division(venue).into()), ("FID_INPUT_ISCD", code.as_str().into())];
            let body: OrderBookBody = self.body(KisApiId::OrderBook, query, priority).await?;
            let book = body.output1;
            let levels = |prices: [&String; 10], quantities: [&String; 10]| {
                prices
                    .iter()
                    .zip(quantities)
                    .filter_map(|(price, quantity)| Some(api::OrderBookLevel { price: whole(price).filter(|p| *p > 0)?, quantity: whole(quantity).unwrap_or(0) }))
                    .collect::<Vec<_>>()
            };
            Ok(OrderBookSnapshot {
                asks: levels(book.ask_prices(), book.ask_quantities()),
                bids: levels(book.bid_prices(), book.bid_quantities()),
                total_ask_quantity: whole(&book.total_askp_rsqn).unwrap_or(0),
                total_bid_quantity: whole(&book.total_bidp_rsqn).unwrap_or(0),
                after_hours_ask_quantity: whole(&book.ovtm_total_askp_rsqn),
                after_hours_bid_quantity: whole(&book.ovtm_total_bidp_rsqn),
                book_time: clock_of(&book.aspr_acpt_hour).map(|t| hms_text(t.secs())),
            })
        })
    }

    fn trades_page(&self, code: StockCode, venue: Venue, cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::TradePrint>, SourceError>> {
        Box::pin(async move {
            let (hour, already_seen) = match &cursor {
                Some(cursor) => parse_tape_cursor(cursor.as_str()).ok_or_else(|| SourceError::Malformed("한투 체결 연속조회 키를 읽지 못했습니다".into()))?,
                None => (END_OF_DAY_HOUR.to_owned(), 0),
            };
            let query = vec![("FID_COND_MRKT_DIV_CODE", market_division(venue).into()), ("FID_INPUT_ISCD", code.as_str().into()), ("FID_INPUT_HOUR_1", hour.clone())];
            let body: TradesBody = self.body(KisApiId::TodayTrades, query, priority).await?;
            let mut skipped = 0_u32;
            let mut seen_at_bound = 0_usize;
            let mut rows = Vec::new();
            for row in &body.output2 {
                if row.stck_cntg_hour == hour && seen_at_bound < already_seen {
                    seen_at_bound += 1;
                    continue;
                }
                match row.print() {
                    Some(print) => rows.push(print),
                    None => skipped += 1,
                }
            }
            let next = body.output2.last().map(|oldest| {
                let at_bound = body.output2.iter().filter(|row| row.stck_cntg_hour == oldest.stck_cntg_hour).count();
                let carried = if oldest.stck_cntg_hour == hour { already_seen + at_bound } else { at_bound };
                Cursor::new(format!("{}:{carried}", oldest.stck_cntg_hour))
            });
            let progressed = !rows.is_empty() || skipped > 0;
            Ok(TapePage { rows, skipped, next: next.filter(|_| progressed) })
        })
    }

    fn program_trades_page(&self, code: StockCode, _today: KstDate, _cursor: Option<Cursor>, priority: Priority) -> BoxFuture<'_, Result<TapePage<api::ProgramTradePoint>, SourceError>> {
        Box::pin(async move {
            let query = vec![("FID_COND_MRKT_DIV_CODE", COMBINED_MARKET.into()), ("FID_INPUT_ISCD", code.as_str().into())];
            let body: ProgramBody = self.body(KisApiId::ProgramTrades, query, priority).await?;
            let mut skipped = 0_u32;
            let mut rows = Vec::new();
            for row in &body.output {
                match row.point() {
                    Some(point) => rows.push(point),
                    None => skipped += 1,
                }
            }
            Ok(TapePage { rows, skipped, next: None })
        })
    }
}

const END_OF_DAY_HOUR: &str = "200000";

fn parse_tape_cursor(text: &str) -> Option<(String, usize)> {
    let (hour, seen) = text.split_once(':')?;
    (hour.len() == 6 && hour.bytes().all(|b| b.is_ascii_digit())).then(|| seen.parse().ok().map(|seen| (hour.to_owned(), seen)))?
}

fn kis_priority(priority: Priority) -> KisPriority {
    match priority {
        Priority::Order => KisPriority::Order,
        Priority::Screen => KisPriority::Screen,
        Priority::ScreenBulk => KisPriority::ScreenBulk,
        Priority::Recovery => KisPriority::Recovery,
        Priority::Background => KisPriority::Background,
    }
}

fn market_division(venue: Venue) -> &'static str {
    match venue {
        Venue::Combined => COMBINED_MARKET,
        Venue::Krx => KRX_MARKET,
        Venue::Nxt => NXT_MARKET,
    }
}

fn kis_index_code(code: IndexCode) -> Result<&'static str, SourceError> {
    match code {
        c if c == IndexCode::KOSPI => Ok(KOSPI_INDEX_CODE),
        c if c == IndexCode::KOSDAQ => Ok(KOSDAQ_INDEX_CODE),
        other => Err(SourceError::Malformed(format!("한투 지수 코드를 모릅니다: {}", other.as_str()))),
    }
}

fn calendar_period_code(period: Period) -> &'static str {
    match period {
        Period::Week => "W",
        Period::Month => "M",
        Period::Year => "Y",
        _ => "D",
    }
}

fn calendar_window_days(period: Period) -> i64 {
    match period {
        Period::Week => 770,
        Period::Month => 3_200,
        Period::Year => 36_600,
        _ => 170,
    }
}

fn price_query(code: StockCode, venue: Venue) -> Vec<(&'static str, String)> {
    vec![("FID_COND_MRKT_DIV_CODE", market_division(venue).into()), ("FID_INPUT_ISCD", code.as_str().into())]
}

fn minute_floor(t: KstTime) -> KstTime {
    t.plus_secs(-(t.unix().rem_euclid(60)))
}

fn previous_session_end(date: KstDate) -> KstTime {
    let mut previous = date.add_days(-1);
    while matches!(previous.weekday(), Weekday::Sat | Weekday::Sun) {
        previous = previous.add_days(-1);
    }
    KstTime::from_kst_civil(previous, LAST_MINUTE_OF_SESSION)
}

fn clock_text(t: KstTime) -> String {
    hms_text_plain(t.kst_time_of_day().secs())
}

fn hms_text_plain(secs: u32) -> String {
    format!("{:02}{:02}{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
}

fn hms_text(secs: u32) -> String {
    format!("{:02}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
}

fn clock_of(text: &str) -> Option<TimeOfDay> {
    let text = text.trim();
    (text.len() == 6 && text.bytes().all(|b| b.is_ascii_digit())).then(|| TimeOfDay::hms(text[0..2].parse().ok()?, text[2..4].parse().ok()?, text[4..6].parse().ok()?))?
}

fn date_of(text: &str) -> Option<KstDate> {
    KstDate::parse_yyyymmdd(text.trim())
}

pub fn centi(text: &str) -> Option<u64> {
    let text: String = text.trim().chars().filter(|c| *c != ',').collect();
    let (whole_part, fraction) = text.split_once('.').unwrap_or((text.as_str(), ""));
    if whole_part.is_empty() && fraction.is_empty() || !whole_part.bytes().chain(fraction.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits: Vec<u64> = fraction.bytes().map(|b| u64::from(b - b'0')).collect();
    let hundredths = digits.first().copied().unwrap_or(0) * 10 + digits.get(1).copied().unwrap_or(0) + u64::from(digits.get(2).copied().unwrap_or(0) >= 5);
    let whole_part: u64 = if whole_part.is_empty() { 0 } else { whole_part.parse().ok()? };
    whole_part.checked_mul(100)?.checked_add(hundredths)
}

pub fn whole(text: &str) -> Option<u64> {
    centi(text).map(|c| (c + 50) / 100)
}

fn signed_whole(text: &str) -> Option<i64> {
    let text = text.trim();
    match text.strip_prefix('-') {
        Some(rest) => whole(rest).and_then(|n| i64::try_from(n).ok()).map(|n| -n),
        None => whole(text).and_then(|n| i64::try_from(n).ok()),
    }
}

fn float(text: &str) -> Option<f64> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.parse::<f64>().ok()).flatten().filter(|v| v.is_finite())
}

fn parse_body<T: for<'de> Deserialize<'de>>(api: KisApiId, page: &KisPage) -> Result<T, SourceError> {
    serde_json::from_str(&page.body).map_err(|e| {
        tracing::error!(tr_id = api.tr_id(), error = %e, "한투 응답을 읽지 못했습니다");
        SourceError::Malformed(format!("한투 응답을 읽지 못했습니다({})", api.tr_id()))
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PriceBody {
    output: PriceRow,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PriceRow {
    stck_prpr: String,
    stck_sdpr: String,
    stck_oprc: String,
    stck_hgpr: String,
    stck_lwpr: String,
    stck_mxpr: String,
    stck_llam: String,
    acml_vol: String,
    acml_tr_pbmn: String,
    w52_hgpr: String,
    w52_lwpr: String,
    hts_avls: String,
    lstn_stcn: String,
    per: String,
    pbr: String,
    eps: String,
    bps: String,
    hts_frgn_ehrt: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MultiPriceBody {
    output: Vec<MultiPriceRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MultiPriceRow {
    inter_shrn_iscd: String,
    inter2_prpr: String,
    inter2_sdpr: String,
    acml_vol: String,
    acml_tr_pbmn: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ChartBody {
    output2: Vec<ChartRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ChartRow {
    stck_bsop_date: String,
    stck_cntg_hour: String,
    stck_clpr: String,
    stck_prpr: String,
    stck_oprc: String,
    stck_hgpr: String,
    stck_lwpr: String,
    acml_vol: String,
    cntg_vol: String,
    bstp_nmix_prpr: String,
    bstp_nmix_oprc: String,
    bstp_nmix_hgpr: String,
    bstp_nmix_lwpr: String,
}

fn first_present(texts: [&str; 3]) -> &str {
    texts.into_iter().find(|t| !t.trim().is_empty()).unwrap_or("")
}

impl ChartRow {
    fn prices(&self) -> [Option<u64>; 4] {
        [
            centi(first_present([&self.stck_oprc, &self.bstp_nmix_oprc, ""])),
            centi(first_present([&self.stck_hgpr, &self.bstp_nmix_hgpr, ""])),
            centi(first_present([&self.stck_lwpr, &self.bstp_nmix_lwpr, ""])),
            centi(first_present([&self.stck_clpr, &self.stck_prpr, &self.bstp_nmix_prpr])),
        ]
        .map(|p| p.filter(|p| *p > 0))
    }

    fn volume(&self) -> u64 {
        whole(first_present([&self.acml_vol, &self.cntg_vol, ""])).unwrap_or(0)
    }
}

fn ohlcv_of(prices: [Option<u64>; 4], volume: u64) -> Result<Option<Ohlcv>, SourceError> {
    if prices.iter().all(Option::is_none) {
        return Ok(None);
    }
    let [Some(open), Some(high), Some(low), Some(close)] = prices else {
        return Err(SourceError::Malformed("한투 봉 행에 가격이 빠져 있습니다".into()));
    };
    let price = |centi| Price::from_centi(centi).expect("0보다 크다고 걸렀다");
    Ohlcv::try_new(price(open), price(high), price(low), price(close), Volume(volume)).map(Some).map_err(|e| SourceError::Malformed(format!("한투 봉 값이 맞지 않습니다: {e}")))
}

fn calendar_bars(period: Period, rows: &[ChartRow]) -> Result<Vec<PeriodBar>, SourceError> {
    let mut bars = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(date) = date_of(&row.stck_bsop_date) else { continue };
        let Some(ohlcv) = ohlcv_of(row.prices(), row.volume())? else { continue };
        bars.push(PeriodBar { bucket: period.bucket(KstTime::from_kst_civil(date, TimeOfDay::MIDNIGHT)), ohlcv });
    }
    bars.sort_by_key(|bar| bar.bucket);
    bars.dedup_by_key(|bar| bar.bucket);
    Ok(bars)
}

fn minute_rows(rows: &[ChartRow], at_most: Option<KstTime>) -> Result<Vec<Minute>, SourceError> {
    let mut minutes = Vec::with_capacity(rows.len());
    for row in rows {
        let (Some(date), Some(time)) = (date_of(&row.stck_bsop_date), clock_of(&row.stck_cntg_hour)) else { continue };
        let start = KstTime::from_kst_civil(date, time);
        if at_most.is_some_and(|bound| start > bound) {
            continue;
        }
        let prices = row.prices();
        if ohlcv_of(prices, 0)?.is_none() {
            continue;
        }
        let [Some(open_centi), Some(high_centi), Some(low_centi), Some(close_centi)] = prices else { unreachable!("ohlcv_of가 빠진 값을 걸렀다") };
        minutes.push(Minute { start_unix: minute_floor(start).unix(), open_centi, high_centi, low_centi, close_centi, volume: row.volume() });
    }
    Ok(minutes)
}

fn malformed_minute(bad: &Minute) -> SourceError {
    SourceError::Malformed(format!("한투 1분봉 값이 맞지 않습니다: {}", KstTime::from_unix(bad.start_unix)))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OrderBookBody {
    output1: OrderBookRow,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OrderBookRow {
    askp1: String,
    askp2: String,
    askp3: String,
    askp4: String,
    askp5: String,
    askp6: String,
    askp7: String,
    askp8: String,
    askp9: String,
    askp10: String,
    bidp1: String,
    bidp2: String,
    bidp3: String,
    bidp4: String,
    bidp5: String,
    bidp6: String,
    bidp7: String,
    bidp8: String,
    bidp9: String,
    bidp10: String,
    askp_rsqn1: String,
    askp_rsqn2: String,
    askp_rsqn3: String,
    askp_rsqn4: String,
    askp_rsqn5: String,
    askp_rsqn6: String,
    askp_rsqn7: String,
    askp_rsqn8: String,
    askp_rsqn9: String,
    askp_rsqn10: String,
    bidp_rsqn1: String,
    bidp_rsqn2: String,
    bidp_rsqn3: String,
    bidp_rsqn4: String,
    bidp_rsqn5: String,
    bidp_rsqn6: String,
    bidp_rsqn7: String,
    bidp_rsqn8: String,
    bidp_rsqn9: String,
    bidp_rsqn10: String,
    total_askp_rsqn: String,
    total_bidp_rsqn: String,
    ovtm_total_askp_rsqn: String,
    ovtm_total_bidp_rsqn: String,
    aspr_acpt_hour: String,
}

impl OrderBookRow {
    fn ask_prices(&self) -> [&String; 10] {
        [&self.askp1, &self.askp2, &self.askp3, &self.askp4, &self.askp5, &self.askp6, &self.askp7, &self.askp8, &self.askp9, &self.askp10]
    }

    fn bid_prices(&self) -> [&String; 10] {
        [&self.bidp1, &self.bidp2, &self.bidp3, &self.bidp4, &self.bidp5, &self.bidp6, &self.bidp7, &self.bidp8, &self.bidp9, &self.bidp10]
    }

    fn ask_quantities(&self) -> [&String; 10] {
        [&self.askp_rsqn1, &self.askp_rsqn2, &self.askp_rsqn3, &self.askp_rsqn4, &self.askp_rsqn5, &self.askp_rsqn6, &self.askp_rsqn7, &self.askp_rsqn8, &self.askp_rsqn9, &self.askp_rsqn10]
    }

    fn bid_quantities(&self) -> [&String; 10] {
        [&self.bidp_rsqn1, &self.bidp_rsqn2, &self.bidp_rsqn3, &self.bidp_rsqn4, &self.bidp_rsqn5, &self.bidp_rsqn6, &self.bidp_rsqn7, &self.bidp_rsqn8, &self.bidp_rsqn9, &self.bidp_rsqn10]
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TradesBody {
    output2: Vec<TradeRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TradeRow {
    stck_cntg_hour: String,
    stck_pbpr: String,
    cnqn: String,
    askp: String,
    bidp: String,
}

impl TradeRow {
    fn print(&self) -> Option<api::TradePrint> {
        let time = clock_of(&self.stck_cntg_hour)?;
        let price = whole(&self.stck_pbpr).filter(|p| *p > 0)?;
        let quantity = i64::try_from(whole(&self.cnqn)?).ok()?;
        let sold = whole(&self.bidp).is_some_and(|bid| bid > 0 && price <= bid) && !whole(&self.askp).is_some_and(|ask| ask > 0 && price >= ask);
        Some(api::TradePrint { time: hms_text(time.secs()), price, quantity: if sold { -quantity } else { quantity }, exchange: None })
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProgramBody {
    output: Vec<ProgramRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProgramRow {
    bsop_hour: String,
    stck_prpr: String,
    whol_smtn_seln_vol: String,
    whol_smtn_shnu_vol: String,
    whol_smtn_ntby_qty: String,
    whol_smtn_seln_tr_pbmn: String,
    whol_smtn_shnu_tr_pbmn: String,
    whol_smtn_ntby_tr_pbmn: String,
}

impl ProgramRow {
    fn point(&self) -> Option<api::ProgramTradePoint> {
        let million_won = |text: &str| signed_whole(text).and_then(|n| n.checked_mul(WON_PER_MILLION as i64));
        Some(api::ProgramTradePoint {
            time: hms_text(clock_of(&self.bsop_hour)?.secs()),
            price: whole(&self.stck_prpr).filter(|p| *p > 0),
            buy_quantity: whole(&self.whol_smtn_shnu_vol)?,
            sell_quantity: whole(&self.whol_smtn_seln_vol)?,
            net_quantity: signed_whole(&self.whol_smtn_ntby_qty)?,
            buy_amount: million_won(&self.whol_smtn_shnu_tr_pbmn)?.abs(),
            sell_amount: million_won(&self.whol_smtn_seln_tr_pbmn)?.abs(),
            net_amount: million_won(&self.whol_smtn_ntby_tr_pbmn)?,
        })
    }
}

fn halt_error(halt: &Halt) -> SourceError {
    match halt {
        Halt::Rejected(failure) => SourceError::Failed(SourceFailure {
            code: ApiErrorCode::KiwoomAuthFailed,
            reason: ApiErrorReason::AuthBlocked,
            message: failure.to_string(),
            retry_at: None,
            manual_action_required: true,
        }),
        Halt::TokenFileUnreadable(e) => SourceError::Failed(SourceFailure {
            code: ApiErrorCode::KiwoomAuthFailed,
            reason: ApiErrorReason::TokenFile,
            message: format!("한투 토큰 파일: {e}"),
            retry_at: None,
            manual_action_required: true,
        }),
    }
}

fn failure_of(error: &KisError) -> SourceError {
    let unavailable = |reason| SourceFailure { code: ApiErrorCode::KiwoomUnavailable, reason, message: error.to_string(), retry_at: None, manual_action_required: false };
    let failure = match error {
        KisError::Failed(failure) => unavailable(match failure.category() {
            Category::RateLimited => ApiErrorReason::RateLimited,
            Category::TokenInvalid => ApiErrorReason::TokenInvalid,
            Category::IssueLimited => ApiErrorReason::IssueInterval,
            Category::BusinessRejected => ApiErrorReason::BusinessRejected,
            Category::AuthBlocked => ApiErrorReason::AuthBlocked,
            Category::Unknown | Category::SeatsExceeded | Category::InUseElsewhere => ApiErrorReason::UnknownFailure,
        }),
        KisError::Stopped(failure) if matches!(failure.category(), Category::AuthBlocked | Category::TokenInvalid) => {
            SourceFailure { code: ApiErrorCode::KiwoomAuthFailed, reason: ApiErrorReason::AuthBlocked, manual_action_required: true, ..unavailable(ApiErrorReason::AuthBlocked) }
        }
        KisError::Stopped(_) => unavailable(ApiErrorReason::UnknownFailure),
        KisError::Gated { until } => SourceFailure { retry_at: Some(*until), ..unavailable(ApiErrorReason::IssueInterval) },
        KisError::TokenFile(_) => SourceFailure { code: ApiErrorCode::KiwoomAuthFailed, manual_action_required: true, ..unavailable(ApiErrorReason::TokenFile) },
        KisError::Transport(transport) => unavailable(if transport.timed_out { ApiErrorReason::KiwoomTimeout } else { ApiErrorReason::KiwoomUnreachable }),
        KisError::BadTokenResponse => unavailable(ApiErrorReason::Protocol),
        KisError::QueueGone => unavailable(ApiErrorReason::KiwoomUnreachable),
    };
    SourceError::Failed(failure)
}

fn master_failure(error: &MasterError, now: KstTime) -> SourceError {
    let reason = match error {
        MasterError::Download(..) => ApiErrorReason::KiwoomUnreachable,
        _ => ApiErrorReason::Protocol,
    };
    SourceError::Failed(SourceFailure { code: ApiErrorCode::KiwoomUnavailable, reason, message: error.to_string(), retry_at: Some(now.plus_secs(MASTER_RETRY_SECS)), manual_action_required: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_read_in_centi_and_whole_units() {
        assert_eq!(centi("71000"), Some(7_100_000));
        assert_eq!(centi("2705.38"), Some(270_538));
        assert_eq!(centi("2705.385"), Some(270_539));
        assert_eq!(centi("1,234.5"), Some(123_450));
        assert_eq!(centi(""), None);
        assert_eq!(centi("-3"), None);
        assert_eq!(centi("abc"), None);
        assert_eq!(whole("5421.00"), Some(5_421));
        assert_eq!(signed_whole("-1103.4"), Some(-1_103));
        assert_eq!(float("12.50"), Some(12.5));
        assert_eq!(float(""), None);
    }

    #[test]
    fn a_tape_cursor_names_the_second_and_how_many_rows_of_it_were_seen() {
        assert_eq!(parse_tape_cursor("093001:3"), Some(("093001".into(), 3)));
        assert_eq!(parse_tape_cursor("93001:3"), None);
        assert_eq!(parse_tape_cursor("093001"), None);
    }
}
