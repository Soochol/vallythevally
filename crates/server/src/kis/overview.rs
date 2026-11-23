use domain::{KstDate, KstTime, StockCode, Symbol, TimeOfDay, Weekday};
use futures::future::{BoxFuture, join_all};
use serde::{Deserialize, Deserializer};

use super::api::KisApiId;
use super::market_rest::{date_of, failure_of, float, kis_priority, parse_body, signed_whole, whole};
use super::rest::{KisPage, KisRequest, KisRest};
use crate::api::{self, Market};
use crate::market_overview::MarketOverviewPeriod;
use crate::market_source::{
    DayRange, IndexBreadth, IndexLevel, IntradayProgram, InvestorNetEok, MarketIndexSnapshot, OverviewFeature, OverviewFeatures, OverviewSource, Priority, ProgramDay, SectorFlow, SourceError, StreakRow,
    StreakSide, TradingDay, protocol, unsupported,
};

pub const SUPPORTED_OVERVIEW_FEATURES: [OverviewFeature; 7] = [
    OverviewFeature::Index,
    OverviewFeature::Sectors,
    OverviewFeature::Flow,
    OverviewFeature::IntradayFlow,
    OverviewFeature::Turnover,
    OverviewFeature::StockInvestors,
    OverviewFeature::ForeignHoldings,
];

const INDEX_MARKET_DIVISION: &str = "U";
const KRX_MARKET: &str = "J";
const SECTOR_SCREEN_CODE: &str = "20214";
const ALL_SECTORS: &str = "0";
const SECTOR_PAGE_BUDGET: usize = 5;
const MILLION_WON_PER_EOK: f64 = 100.0;
const HISTORY_WINDOW_DAYS: i64 = 130;
const LONGEST_PERIOD_DAYS: usize = MarketOverviewPeriod::Days60.days();
const INDEX_DAY_PAGE_BUDGET: usize = 5;
const STOCK_INVESTOR_PAGE_BUDGET: usize = 10;
const ESTIMATE_UNTIL: TimeOfDay = match TimeOfDay::hms(16, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};
const ESTIMATE_FROM: TimeOfDay = match TimeOfDay::hms(9, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};

struct MarketCodes {
    index: &'static str,
    name: &'static str,
    exchange_class: &'static str,
    investor_market: &'static str,
}

fn codes(market: Market) -> MarketCodes {
    match market {
        Market::Kospi => MarketCodes { index: "0001", name: "코스피", exchange_class: "K", investor_market: "KSP" },
        Market::Kosdaq => MarketCodes { index: "1001", name: "코스닥", exchange_class: "Q", investor_market: "KSQ" },
    }
}

pub struct KisOverview {
    rest: KisRest,
}

impl KisOverview {
    pub fn new(rest: KisRest) -> Self {
        KisOverview { rest }
    }

    async fn page(&self, api: KisApiId, query: Vec<(&'static str, String)>, priority: Priority, next: bool) -> Result<KisPage, SourceError> {
        let request = KisRequest::new(api, query, kis_priority(priority));
        self.rest.call(if next { request.next_page() } else { request }).await.map_err(|e| failure_of(&e))
    }

    async fn body<T: for<'de> Deserialize<'de>>(&self, api: KisApiId, query: Vec<(&'static str, String)>, priority: Priority) -> Result<T, SourceError> {
        let page = self.page(api, query, priority, false).await?;
        parse_body(api, &page)
    }

    async fn sector_rows(&self, market: Market, priority: Priority) -> Result<Vec<SectorRow>, SourceError> {
        let market_codes = codes(market);
        let query = || {
            vec![
                ("FID_COND_MRKT_DIV_CODE", INDEX_MARKET_DIVISION.to_owned()),
                ("FID_INPUT_ISCD", market_codes.index.to_owned()),
                ("FID_COND_SCR_DIV_CODE", SECTOR_SCREEN_CODE.to_owned()),
                ("FID_MRKT_CLS_CODE", market_codes.exchange_class.to_owned()),
                ("FID_BLNG_CLS_CODE", ALL_SECTORS.to_owned()),
            ]
        };
        let mut rows = Vec::new();
        for pages in 0..SECTOR_PAGE_BUDGET {
            let page = self.page(KisApiId::IndexCategoryPrice, query(), priority, pages > 0).await?;
            let body: SectorBody = parse_body(KisApiId::IndexCategoryPrice, &page)?;
            rows.extend(body.output2);
            if !page.more {
                break;
            }
        }
        Ok(rows)
    }

    async fn investor_net_now(&self, market: Market, sector: &str, priority: Priority) -> Result<Option<InvestorNetEok>, SourceError> {
        let query = vec![("FID_INPUT_ISCD", codes(market).index.to_owned()), ("FID_INPUT_ISCD_2", sector.to_owned())];
        let body: InvestorFlowBody = self.body(KisApiId::InvestorTimeByMarket, query, priority).await?;
        Ok(body.output.first().and_then(InvestorFlowRow::net))
    }

    async fn confirmed_stock_rows(&self, code: StockCode, range: DayRange, priority: Priority) -> Result<StockRows, SourceError> {
        let mut rows = StockRows::default();
        let mut cursor = range.to();
        for _ in 0..STOCK_INVESTOR_PAGE_BUDGET {
            let query = vec![
                ("FID_COND_MRKT_DIV_CODE", KRX_MARKET.to_owned()),
                ("FID_INPUT_ISCD", code.as_str().to_owned()),
                ("FID_INPUT_DATE_1", cursor.yyyymmdd()),
                ("FID_ORG_ADJ_PRC", String::new()),
                ("FID_ETC_CLS_CODE", String::new()),
            ];
            let body: StockInvestorBody = self.body(KisApiId::StockInvestorDaily, query, priority).await?;
            let dated: Vec<(KstDate, &StockInvestorRow)> = body.output2.iter().filter_map(|row| date_of(&row.stck_bsop_date).map(|day| (day, row))).collect();
            let Some(oldest) = dated.iter().map(|(day, _)| *day).min() else { break };
            for (day, row) in dated {
                if !range.contains(day) {
                    continue;
                }
                match row.net_shares(day) {
                    Ok(net) => rows.days.push((day, net)),
                    Err(skipped) => rows.skipped.push(skipped),
                }
            }
            let progressed = rows.reached.is_none_or(|reached| oldest < reached);
            rows.reached = Some(rows.reached.map_or(oldest, |reached| reached.min(oldest)));
            if oldest <= range.from() || !progressed {
                break;
            }
            cursor = oldest.add_days(-1);
        }
        Ok(rows)
    }

    async fn estimated_today(&self, code: StockCode, today: KstDate, priority: Priority) -> Result<Option<api::InvestorNetSharesDay>, SourceError> {
        let body: EstimateBody = self.body(KisApiId::InvestorEstimate, vec![("MKSC_SHRN_ISCD", code.as_str().to_owned())], priority).await?;
        let latest = body.output2.iter().filter_map(|row| Some((whole(&row.bsop_hour_gb)?, row))).filter(|(_, row)| row.net().is_some()).max_by_key(|(slot, _)| *slot);
        Ok(latest.and_then(|(_, row)| row.net()).map(|(foreign, institution)| api::InvestorNetSharesDay {
            day: api::KstDate(today),
            individual: 0,
            foreign,
            institution,
            financial_investment: 0,
            insurance: 0,
            investment_trust: 0,
            other_financial: 0,
            bank: 0,
            pension_fund: 0,
            private_fund: 0,
            government: 0,
            other_corporation: 0,
        }))
    }
}

fn eok_of_million(million_won: i64) -> i64 {
    (million_won as f64 / MILLION_WON_PER_EOK).round() as i64
}

fn eok_float(text: &str) -> Option<f64> {
    float(text).map(|million_won| million_won / MILLION_WON_PER_EOK)
}

fn signed_rate(rate: &str, sign: &str) -> Option<f64> {
    let rate = float(rate)?;
    Some(if matches!(sign.trim(), "4" | "5") && rate > 0.0 { -rate } else { rate })
}

fn count(text: &str) -> Option<u32> {
    whole(text).and_then(|n| u32::try_from(n).ok())
}

fn window_start(today: KstDate) -> KstDate {
    today.add_days(-HISTORY_WINDOW_DAYS)
}

fn latest_weekday(day: KstDate) -> KstDate {
    let mut day = day;
    while matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
        day = day.add_days(-1);
    }
    day
}

fn estimate_window(now: KstTime) -> bool {
    let time = now.kst_time_of_day();
    !matches!(now.kst_date().weekday(), Weekday::Sat | Weekday::Sun) && (ESTIMATE_FROM..ESTIMATE_UNTIL).contains(&time)
}

impl OverviewSource for KisOverview {
    fn broker(&self) -> api::Broker {
        api::Broker::Kis
    }

    fn features(&self) -> OverviewFeatures {
        OverviewFeatures::of(SUPPORTED_OVERVIEW_FEATURES)
    }

    fn is_open(&self) -> bool {
        self.rest.auth().halted().is_none()
    }

    fn index(&self, market: Market, priority: Priority) -> BoxFuture<'_, Result<MarketIndexSnapshot, SourceError>> {
        Box::pin(async move {
            let market_codes = codes(market);
            let query = vec![("FID_COND_MRKT_DIV_CODE", INDEX_MARKET_DIVISION.to_owned()), ("FID_INPUT_ISCD", market_codes.index.to_owned())];
            let body: IndexBody = self.body(KisApiId::IndexPrice, query, priority).await?;
            let row = body.output.first().ok_or_else(|| protocol(format!("한투 업종 현재지수 응답에 {} 행이 없습니다", market_codes.name)))?;
            let (Some(level), Some(change_rate), Some(trade_value_eok)) = (float(&row.bstp_nmix_prpr), signed_rate(&row.bstp_nmix_prdy_ctrt, &row.prdy_vrss_sign), eok_float(&row.acml_tr_pbmn)) else {
                return Err(protocol(format!("한투 업종 현재지수의 {} 지수·등락률·거래대금을 읽지 못했습니다", market_codes.name)));
            };
            Ok(MarketIndexSnapshot {
                whole: IndexLevel { code: market_codes.index.to_owned(), name: market_codes.name.to_owned(), level, change_rate, trade_value_eok },
                breadth: IndexBreadth {
                    rising: count(&row.ascn_issu_cnt),
                    flat: count(&row.stnr_issu_cnt),
                    falling: count(&row.down_issu_cnt),
                    upper_limit: count(&row.uplm_issu_cnt),
                    lower_limit: count(&row.lslm_issu_cnt),
                },
                volatility: None,
            })
        })
    }

    fn sector_levels(&self, market: Market, priority: Priority) -> BoxFuture<'_, Result<Vec<IndexLevel>, SourceError>> {
        Box::pin(async move {
            let whole = codes(market).index;
            let rows = self.sector_rows(market, priority).await?;
            Ok(rows
                .iter()
                .filter(|row| row.bstp_cls_code.trim() != whole)
                .filter_map(|row| {
                    Some(IndexLevel {
                        code: row.bstp_cls_code.trim().to_owned(),
                        name: row.hts_kor_isnm.trim().to_owned(),
                        level: float(&row.bstp_nmix_prpr)?,
                        change_rate: signed_rate(&row.bstp_nmix_prdy_ctrt, &row.prdy_vrss_sign)?,
                        trade_value_eok: eok_float(&row.acml_tr_pbmn)?,
                    })
                })
                .collect())
        })
    }

    fn sector_flows(&self, market: Market, _today: KstDate, _priority: Priority) -> BoxFuture<'_, Result<Vec<SectorFlow>, SourceError>> {
        Box::pin(async move {
            let market_codes = codes(market);
            let rows = self.sector_rows(market, Priority::Background).await?;
            let mut sectors: Vec<(String, String)> = vec![(market_codes.index.to_owned(), market_codes.name.to_owned())];
            for row in &rows {
                let code = row.bstp_cls_code.trim();
                if !code.is_empty() && !sectors.iter().any(|(known, _)| known == code) {
                    sectors.push((code.to_owned(), row.hts_kor_isnm.trim().to_owned()));
                }
            }
            let nets = join_all(sectors.iter().map(|(code, _)| self.investor_net_now(market, code, Priority::Background))).await;
            let mut flows = Vec::with_capacity(sectors.len());
            for ((code, name), net) in sectors.into_iter().zip(nets) {
                let Some(net) = net? else { continue };
                flows.push(SectorFlow { whole_market: code == market_codes.index, code, name, net });
            }
            Ok(flows)
        })
    }

    fn trading_days(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<TradingDay>, SourceError>> {
        Box::pin(async move {
            let query = vec![
                ("FID_COND_MRKT_DIV_CODE", INDEX_MARKET_DIVISION.to_owned()),
                ("FID_INPUT_ISCD", codes(market).index.to_owned()),
                ("FID_INPUT_DATE_1", window_start(today).yyyymmdd()),
                ("FID_INPUT_DATE_2", today.yyyymmdd()),
                ("FID_PERIOD_DIV_CODE", "D".to_owned()),
            ];
            let mut days: Vec<TradingDay> = Vec::new();
            for pages in 0..INDEX_DAY_PAGE_BUDGET {
                let page = self.page(KisApiId::IndexChart, query.clone(), priority, pages > 0).await?;
                let body: IndexChartBody = parse_body(KisApiId::IndexChart, &page)?;
                days.extend(body.output2.iter().filter_map(|row| Some(TradingDay { date: date_of(&row.stck_bsop_date)?, trade_value_eok: eok_float(&row.acml_tr_pbmn)? })));
                days.sort_by_key(|d| d.date);
                days.dedup_by_key(|d| d.date);
                if !page.more || days.len() >= LONGEST_PERIOD_DAYS {
                    break;
                }
            }
            Ok(days)
        })
    }

    fn investor_day(&self, market: Market, day: KstDate, priority: Priority) -> BoxFuture<'_, Result<InvestorNetEok, SourceError>> {
        Box::pin(async move {
            let market_codes = codes(market);
            let query = vec![
                ("FID_COND_MRKT_DIV_CODE", INDEX_MARKET_DIVISION.to_owned()),
                ("FID_INPUT_ISCD", market_codes.index.to_owned()),
                ("FID_INPUT_DATE_1", day.yyyymmdd()),
                ("FID_INPUT_ISCD_1", market_codes.investor_market.to_owned()),
                ("FID_INPUT_DATE_2", day.yyyymmdd()),
                ("FID_INPUT_ISCD_2", market_codes.index.to_owned()),
            ];
            let body: InvestorFlowBody = self.body(KisApiId::InvestorDailyByMarket, query, priority).await?;
            body.output
                .iter()
                .find(|row| date_of(&row.stck_bsop_date) == Some(day))
                .and_then(InvestorFlowRow::net)
                .ok_or_else(|| protocol(format!("한투 시장별 투자자매매동향(일별)이 {day}의 {} 행을 주지 않았습니다", market_codes.name)))
        })
    }

    fn program_days(&self, market: Market, today: KstDate, priority: Priority) -> BoxFuture<'_, Result<Vec<ProgramDay>, SourceError>> {
        Box::pin(async move {
            let query = vec![
                ("FID_COND_MRKT_DIV_CODE", KRX_MARKET.to_owned()),
                ("FID_MRKT_CLS_CODE", codes(market).exchange_class.to_owned()),
                ("FID_INPUT_DATE_1", window_start(today).yyyymmdd()),
                ("FID_INPUT_DATE_2", today.yyyymmdd()),
            ];
            let body: ProgramDailyBody = self.body(KisApiId::ProgramDaily, query, priority).await?;
            let mut days: Vec<ProgramDay> = body
                .output
                .iter()
                .filter_map(|row| {
                    let (arbitrage_eok, non_arbitrage_eok) = (eok_float(&row.arbt_smtn_ntby_tr_pbmn)?, eok_float(&row.nabt_smtn_ntby_tr_pbmn)?);
                    Some(ProgramDay { date: date_of(&row.stck_bsop_date)?, arbitrage_eok, non_arbitrage_eok, total_eok: arbitrage_eok + non_arbitrage_eok })
                })
                .collect();
            days.sort_by_key(|d| d.date);
            days.dedup_by_key(|d| d.date);
            Ok(days)
        })
    }

    fn intraday_investors(&self, market: Market, _now: KstTime, priority: Priority) -> BoxFuture<'_, Result<Option<InvestorNetEok>, SourceError>> {
        Box::pin(async move {
            let net = self.investor_net_now(market, codes(market).index, priority).await?;
            if net.is_none() {
                tracing::info!(?market, "한투가 시장별 투자자 행을 주지 않아 이 분의 투자자 표본을 비웁니다");
            }
            Ok(net)
        })
    }

    fn intraday_program(&self, market: Market, _now: KstTime, priority: Priority) -> BoxFuture<'_, Result<Option<IntradayProgram>, SourceError>> {
        Box::pin(async move {
            let query = vec![
                ("FID_COND_MRKT_DIV_CODE", KRX_MARKET.to_owned()),
                ("FID_MRKT_CLS_CODE", codes(market).exchange_class.to_owned()),
                ("FID_SCTN_CLS_CODE", String::new()),
                ("FID_INPUT_ISCD", String::new()),
                ("FID_COND_MRKT_DIV_CODE1", String::new()),
                ("FID_INPUT_HOUR_1", String::new()),
            ];
            let body: ProgramTodayBody = self.body(KisApiId::ProgramToday, query, priority).await?;
            let latest = body.output.iter().filter(|row| eok_float(&row.whol_smtn_ntby_tr_pbmn).is_some()).max_by_key(|row| row.bsop_hour.trim().to_owned());
            let latest = latest.or_else(|| body.output.iter().find(|row| eok_float(&row.whol_smtn_ntby_tr_pbmn).is_some()));
            if latest.is_none() {
                tracing::info!(?market, "한투가 프로그램 매매 행을 주지 않아 이 분의 표본을 비웁니다");
            }
            Ok(latest.and_then(|row| eok_float(&row.whol_smtn_ntby_tr_pbmn)).map(|total_eok| IntradayProgram { total_eok, split: None }))
        })
    }

    fn streaks(&self, _side: StreakSide, _market: Market, _priority: Priority) -> BoxFuture<'_, Result<Vec<StreakRow>, SourceError>> {
        Box::pin(async move { Err(unsupported(OverviewFeature::Streaks)) })
    }

    fn stock_investors(&self, code: StockCode, range: DayRange, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<api::DayHistory<api::InvestorNetSharesDay>, SourceError>> {
        Box::pin(async move {
            let today = now.kst_date();
            let mut rows = self.confirmed_stock_rows(code, range, priority).await?;
            let mut estimated_days = None;
            if range.contains(today) && estimate_window(now) {
                rows.days.retain(|(day, _)| *day != today);
                rows.skipped.retain(|skipped| skipped.day.0 != today);
                match self.estimated_today(code, today, priority).await {
                    Ok(Some(estimate)) => {
                        rows.days.push((today, estimate));
                        estimated_days = Some(vec![api::KstDate(today)]);
                        rows.reached = Some(rows.reached.map_or(today, |reached| reached.min(today)));
                    }
                    Ok(None) => {}
                    Err(e) => tracing::warn!(code = code.as_str(), reason = %e, "한투 외인기관 추정가집계를 받지 못해 오늘 행을 비웁니다"),
                }
            }
            Ok(rows.into_history(code, range, estimated_days))
        })
    }

    fn foreign_holdings(&self, code: StockCode, range: DayRange, now: KstTime, priority: Priority) -> BoxFuture<'_, Result<api::DayHistory<api::ForeignHoldingDay>, SourceError>> {
        Box::pin(async move {
            let query = vec![("FID_COND_MRKT_DIV_CODE", KRX_MARKET.to_owned()), ("FID_INPUT_ISCD", code.as_str().to_owned())];
            let body: PriceBody = self.body(KisApiId::CurrentPrice, query, priority).await?;
            let day = latest_weekday(now.kst_date());
            let held = whole(&body.output.frgn_hldn_qty).zip(float(&body.output.hts_frgn_ehrt)).filter(|_| range.contains(day));
            let days: Vec<api::ForeignHoldingDay> = held.map(|(shares, weight_pct)| api::ForeignHoldingDay { day: api::KstDate(day), shares, weight_pct }).into_iter().collect();
            let coverage = match days.first() {
                Some(_) if day <= range.from() => api::RangeCoverage::WholeRange,
                Some(_) => api::RangeCoverage::KiwoomStartsLater { first_day: api::KstDate(day) },
                None => api::RangeCoverage::NoReadableDates,
            };
            Ok(api::DayHistory {
                symbol: api::SymbolCode(Symbol::Stock(code).as_wire()),
                from: api::KstDate(range.from()),
                to: api::KstDate(range.to()),
                coverage,
                days,
                source: api::Broker::Kis,
                skipped_days: Vec::new(),
                undated_rows: Vec::new(),
                estimated_days: None,
            })
        })
    }
}

#[derive(Default)]
struct StockRows {
    days: Vec<(KstDate, api::InvestorNetSharesDay)>,
    skipped: Vec<api::SkippedDay>,
    reached: Option<KstDate>,
}

impl StockRows {
    fn into_history(mut self, code: StockCode, range: DayRange, estimated_days: Option<Vec<api::KstDate>>) -> api::DayHistory<api::InvestorNetSharesDay> {
        self.days.sort_by_key(|(day, _)| *day);
        self.days.dedup_by_key(|(day, _)| *day);
        self.skipped.sort_by_key(|s| s.day);
        self.skipped.dedup_by_key(|s| s.day);
        let days = &self.days;
        self.skipped.retain(|s| days.binary_search_by_key(&s.day.0, |(day, _)| *day).is_err());
        let coverage = match self.reached {
            Some(first_day) if first_day <= range.from() => api::RangeCoverage::WholeRange,
            Some(first_day) => api::RangeCoverage::KiwoomStartsLater { first_day: api::KstDate(first_day) },
            None => api::RangeCoverage::NoReadableDates,
        };
        api::DayHistory {
            symbol: api::SymbolCode(Symbol::Stock(code).as_wire()),
            from: api::KstDate(range.from()),
            to: api::KstDate(range.to()),
            coverage,
            days: self.days.into_iter().map(|(_, day)| day).collect(),
            source: api::Broker::Kis,
            skipped_days: self.skipped,
            undated_rows: Vec::new(),
            estimated_days,
        }
    }
}

fn one_or_many<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany<T> {
        Many(Vec<T>),
        One(T),
    }
    Ok(match Option::<OneOrMany<T>>::deserialize(deserializer)? {
        Some(OneOrMany::Many(rows)) => rows,
        Some(OneOrMany::One(row)) => vec![row],
        None => Vec::new(),
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct IndexBody {
    #[serde(deserialize_with = "one_or_many")]
    output: Vec<IndexRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct IndexRow {
    bstp_nmix_prpr: String,
    bstp_nmix_prdy_ctrt: String,
    prdy_vrss_sign: String,
    acml_tr_pbmn: String,
    ascn_issu_cnt: String,
    stnr_issu_cnt: String,
    down_issu_cnt: String,
    uplm_issu_cnt: String,
    lslm_issu_cnt: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SectorBody {
    #[serde(deserialize_with = "one_or_many")]
    output2: Vec<SectorRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SectorRow {
    bstp_cls_code: String,
    hts_kor_isnm: String,
    bstp_nmix_prpr: String,
    bstp_nmix_prdy_ctrt: String,
    prdy_vrss_sign: String,
    acml_tr_pbmn: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct IndexChartBody {
    #[serde(deserialize_with = "one_or_many")]
    output2: Vec<IndexChartRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct IndexChartRow {
    stck_bsop_date: String,
    acml_tr_pbmn: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct InvestorFlowBody {
    #[serde(deserialize_with = "one_or_many")]
    output: Vec<InvestorFlowRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct InvestorFlowRow {
    stck_bsop_date: String,
    prsn_ntby_tr_pbmn: String,
    frgn_ntby_tr_pbmn: String,
    orgn_ntby_tr_pbmn: String,
}

impl InvestorFlowRow {
    fn net(&self) -> Option<InvestorNetEok> {
        let eok = |text: &str| signed_whole(text).map(eok_of_million);
        Some(InvestorNetEok { individual: eok(&self.prsn_ntby_tr_pbmn)?, foreign: eok(&self.frgn_ntby_tr_pbmn)?, institution: eok(&self.orgn_ntby_tr_pbmn)? })
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProgramDailyBody {
    #[serde(deserialize_with = "one_or_many")]
    output: Vec<ProgramDailyRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProgramDailyRow {
    stck_bsop_date: String,
    arbt_smtn_ntby_tr_pbmn: String,
    nabt_smtn_ntby_tr_pbmn: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProgramTodayBody {
    #[serde(deserialize_with = "one_or_many")]
    output: Vec<ProgramTodayRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProgramTodayRow {
    bsop_hour: String,
    whol_smtn_ntby_tr_pbmn: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct StockInvestorBody {
    #[serde(deserialize_with = "one_or_many")]
    output2: Vec<StockInvestorRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct StockInvestorRow {
    stck_bsop_date: String,
    prsn_ntby_qty: String,
    frgn_ntby_qty: String,
    orgn_ntby_qty: String,
    scrt_ntby_qty: String,
    insu_ntby_qty: String,
    ivtr_ntby_qty: String,
    mrbn_ntby_qty: String,
    bank_ntby_qty: String,
    fund_ntby_qty: String,
    pe_fund_ntby_vol: String,
    etc_corp_ntby_vol: String,
}

impl StockInvestorRow {
    fn net_shares(&self, day: KstDate) -> Result<api::InvestorNetSharesDay, api::SkippedDay> {
        let read = |field: &'static str, text: &str| {
            signed_whole(text).ok_or_else(|| api::SkippedDay { day: api::KstDate(day), field: field.to_owned(), reason: format!("한투 {field} 열을 읽지 못했습니다: {:?}", text.trim()) })
        };
        Ok(api::InvestorNetSharesDay {
            day: api::KstDate(day),
            individual: read("individual", &self.prsn_ntby_qty)?,
            foreign: read("foreign", &self.frgn_ntby_qty)?,
            institution: read("institution", &self.orgn_ntby_qty)?,
            financial_investment: read("financialInvestment", &self.scrt_ntby_qty)?,
            insurance: read("insurance", &self.insu_ntby_qty)?,
            investment_trust: read("investmentTrust", &self.ivtr_ntby_qty)?,
            other_financial: read("otherFinancial", &self.mrbn_ntby_qty)?,
            bank: read("bank", &self.bank_ntby_qty)?,
            pension_fund: read("pensionFund", &self.fund_ntby_qty)?,
            private_fund: read("privateFund", &self.pe_fund_ntby_vol)?,
            government: 0,
            other_corporation: read("otherCorporation", &self.etc_corp_ntby_vol)?,
        })
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct EstimateBody {
    #[serde(deserialize_with = "one_or_many")]
    output2: Vec<EstimateRow>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct EstimateRow {
    bsop_hour_gb: String,
    frgn_fake_ntby_qty: String,
    orgn_fake_ntby_qty: String,
}

impl EstimateRow {
    fn net(&self) -> Option<(i64, i64)> {
        Some((signed_whole(&self.frgn_fake_ntby_qty)?, signed_whole(&self.orgn_fake_ntby_qty)?))
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PriceBody {
    output: PriceRow,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PriceRow {
    frgn_hldn_qty: String,
    hts_frgn_ehrt: String,
}
