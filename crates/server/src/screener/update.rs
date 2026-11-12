use std::collections::{HashMap, HashSet};
use std::fmt;

use domain::{IndexCode, KstDate, Price, StockCode, Venue};
use futures::{StreamExt, TryFutureExt, TryStreamExt, stream};

use super::{Calendar, CalendarUse, Screener};
use super::store::{DayBar, Listed, Store, Tail, Write};
use crate::api::UpdatePhase;
use crate::bars::BarError;
use crate::kiwoom::api::{DailyChart, IndexDailyChart, StockQuotes};
use crate::kiwoom::error::{Failure, Surface};
use crate::kiwoom::rest::{ContKey, KiwoomError, MergeScope, Priority};
use crate::kiwoom::wire::{KrxDayQuote, index_days, parse_krx_daily, parse_krx_quotes};

const IN_FLIGHT: usize = 2;
const MAX_HISTORY_PAGES: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Catchup {
    FirstPage { stored_through: Option<KstDate> },
    WholeHistory,
}

struct DailyPage {
    bars: Vec<DayBar>,
    next: Option<ContKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Skip {
    NoDailyBars,
    PastPageLimit,
}

impl fmt::Display for Skip {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Skip::NoDailyBars => f.write_str("키움이 일봉을 주지 않았습니다"),
            Skip::PastPageLimit => write!(f, "일봉이 {MAX_HISTORY_PAGES}페이지를 넘습니다"),
        }
    }
}

fn base_moved(base: Price, stored_close: Price) -> bool {
    let (base, close) = (base.centi(), stored_close.centi());
    10 * base.abs_diff(close) > 3 * close
}

fn unconfirmed(code: StockCode, target: KstDate, reason: &str) {
    tracing::warn!(code = code.as_str(), %target, reason, "확인 안 된 종목이라 최근 채우기에서 건너뜁니다. 다음 업데이트에서 다시 확인합니다");
}

fn stopped_on(code: StockCode, e: &BarError) {
    tracing::error!(code = code.as_str(), reason = %e, "이 종목의 일봉을 받다가 업데이트를 멈춥니다");
}

impl Screener {
    pub async fn fill_lost_listing(&self) {
        match self.refill_listing().await {
            Ok(Listed::Present) => {}
            Ok(Listed::Filled) => tracing::info!("스크리너 저장소에 일봉은 있는데 종목 목록이 비어 있어, 서버가 받은 종목 목록으로 채웠습니다"),
            Ok(Listed::Lost) => tracing::warn!("서버가 받은 종목 목록이 비어 스크리너 종목 목록을 채우지 못했습니다. 비지 않은 목록을 받을 때까지 실행을 막습니다"),
            Err(e) => tracing::warn!(error = %e, "스크리너 종목 목록을 채우지 못했습니다. 실행이나 업데이트 때 다시 채웁니다"),
        }
    }

    pub(super) async fn update(&self, id: u64, full: bool) -> Result<(), BarError> {
        tracing::info!(full, "스크리너 업데이트를 시작합니다");
        self.report(id, UpdatePhase::Symbols, 0, 1);
        let directory = self.symbols.ready(&self.rest).await?;
        if directory.screener_listing().is_empty() {
            tracing::warn!("서버가 받아 둔 종목 목록이 비어 있어, 스크리너 종목 목록을 바꾸지 않고 업데이트를 멈춥니다");
            return Err(BarError::ListNotReady);
        }
        tracing::info!(count = directory.screener_listing().len(), "서버가 받아 둔 종목 목록으로 스크리너 종목 목록을 바꿉니다");
        self.with_store(move |s| s.replace_listing(directory.screener_listing())).await?;
        self.report(id, UpdatePhase::Symbols, 1, 1);
        if full {
            self.with_store(Store::mark_refetch).await?;
        }
        let calendar = self.calendar(CalendarUse::Update).await?;
        let target = calendar.target(self.clock.now()).ok_or_else(|| BarError::Internal("코스피 일봉에 관측일이 없어 목표 관측일을 정할 수 없습니다".into()))?;
        self.store_calendar(&calendar, target).await?;
        let unavailable = self.recent(id, target, calendar.last_before(target)).await?;
        self.backfill(id, target, &unavailable).await
    }

    async fn store_calendar(&self, recent: &Calendar, target: KstDate) -> Result<(), BarError> {
        let stored_through = self.with_store(Store::calendar_last_day).await?;
        if stored_through.is_some_and(|last| last >= target) {
            return Ok(());
        }
        let recent_reaches_stored = stored_through.is_some_and(|last| recent.days.first().is_some_and(|first| *first <= last));
        let mut days = if recent_reaches_stored { recent.days.clone() } else { self.kospi_days_back_to(stored_through).await? };
        days.retain(|d| *d <= target && stored_through.is_none_or(|last| *d > last));
        tracing::info!(count = days.len(), "코스피 일봉 날짜를 관측일 달력에 덧붙입니다");
        Ok(self.with_store(move |s| s.extend_calendar(&days)).await?)
    }

    async fn kospi_days_back_to(&self, stored_through: Option<KstDate>) -> Result<Vec<KstDate>, BarError> {
        let req = IndexDailyChart::new(IndexCode::KOSPI, self.clock.now().kst_date());
        let mut pages = Vec::new();
        let mut cont = None;
        for _ in 0..MAX_HISTORY_PAGES {
            let page = self.rest.call(&req, cont.as_ref(), Priority::Background, MergeScope::default()).await?;
            let days = index_days(page.body).map_err(|e| BarError::Internal(format!("코스피 일봉 응답을 읽지 못했습니다: {e}")))?;
            let reaches_stored = stored_through.is_some_and(|last| days.first().is_some_and(|oldest| *oldest <= last));
            pages.push(days);
            cont = page.next;
            if reaches_stored || cont.is_none() {
                let mut days: Vec<KstDate> = pages.into_iter().rev().flatten().collect();
                days.dedup();
                return Ok(days);
            }
        }
        Err(BarError::Internal(format!("코스피 일봉이 {MAX_HISTORY_PAGES}페이지를 넘어 관측일 달력 받기를 멈췄습니다")))
    }

    async fn recent(&self, id: u64, target: KstDate, day_before_target: Option<KstDate>) -> Result<HashSet<StockCode>, BarError> {
        let tails = self.with_store(Store::tails).await?;
        let unfilled: Vec<Tail> = tails.into_iter().filter(|t| t.listed_on.is_none_or(|listed| listed <= target) && t.last.is_none_or(|(day, _)| day < target)).collect();
        let total = unfilled.len();
        let (mut done, mut skipped) = (0, 0);
        let mut catchups = Vec::new();
        let mut unavailable = HashSet::new();
        self.report(id, UpdatePhase::Recent, done, total);
        for chunk in unfilled.chunks(StockQuotes::MAX) {
            let codes: Vec<StockCode> = chunk.iter().map(|t| t.code).collect();
            let req = StockQuotes::new(&codes, Venue::Krx).expect("chunks는 1~MAX개다");
            let page = self.rest.call(&req, None, Priority::Background, MergeScope::default()).await?;
            let quotes: HashMap<StockCode, KrxDayQuote> = parse_krx_quotes(page.body).into_iter().map(|q| (q.code, q)).collect();
            let waiting = catchups.len();
            let mut writes = Vec::new();
            for &Tail { code, last, .. } in chunk {
                let Some(q) = quotes.get(&code) else {
                    unconfirmed(code, target, "ka10095에 행이 없습니다");
                    skipped += 1;
                    continue;
                };
                if q.day < target {
                    unconfirmed(code, target, &format!("ka10095의 dt가 {}입니다", q.day));
                    skipped += 1;
                    continue;
                }
                match last {
                    Some((day, close)) if q.day == target && Some(day) == day_before_target => {
                        if base_moved(q.base, close) {
                            tracing::info!(code = code.as_str(), base = q.base.centi() / 100, stored_close = close.centi() / 100, "기준가가 저장된 종가와 30% 넘게 달라 전체 이력을 다시 받습니다");
                            self.with_store(move |s| s.require_refetch(&[code], None)).await?;
                            catchups.push((code, Catchup::WholeHistory));
                        } else {
                            writes.push(Write::Extend { code, bars: vec![DayBar { day: q.day, ohlcv: q.ohlcv, traded: q.traded }], reached_origin: false });
                        }
                    }
                    last => catchups.push((code, Catchup::FirstPage { stored_through: last.map(|(day, _)| day) })),
                }
            }
            done += chunk.len() - (catchups.len() - waiting);
            self.with_store(move |s| s.write(&writes)).await?;
            self.report(id, UpdatePhase::Recent, done, total);
        }
        let mut written = stream::iter(catchups).map(|(code, how)| self.catch_up(code, how, target).inspect_err(move |e| stopped_on(code, e)).map_ok(move |write| (code, write))).buffered(IN_FLIGHT);
        while let Some((code, write)) = written.try_next().await? {
            match write {
                Err(skip) => {
                    unavailable.insert(code);
                    self.with_store(move |s| s.finish_refetch_attempt(code)).await?;
                    unconfirmed(code, target, &skip.to_string());
                    skipped += 1;
                }
                Ok(write) => {
                    let short = match write.last_day() {
                        Some(last) if last >= target => None,
                        Some(last) => Some(format!("키움 일봉이 {last}에서 끝납니다")),
                        None => Some("키움 일봉에 저장된 봉 뒤의 새 봉이 없습니다".to_owned()),
                    };
                    if let Some(reason) = short {
                        unconfirmed(code, target, &reason);
                        skipped += 1;
                    }
                    self.with_store(move |s| s.write(&[write])).await?;
                }
            }
            done += 1;
            self.report(id, UpdatePhase::Recent, done, total);
        }
        self.with_store(move |s| s.set_last_day(target)).await?;
        tracing::info!(%target, filled = total - skipped, unconfirmed = skipped, "최근 채우기를 마쳤습니다");
        Ok(unavailable)
    }

    async fn backfill(&self, id: u64, target: KstDate, unavailable: &HashSet<StockCode>) -> Result<(), BarError> {
        let mut queue = self.with_store(move |s| s.backfill_queue(target)).await?;
        queue.retain(|code| !unavailable.contains(code));
        let total = queue.len();
        self.report(id, UpdatePhase::Backfill, 0, total);
        let mut written = stream::iter(queue).map(|code| self.catch_up(code, Catchup::WholeHistory, target).inspect_err(move |e| stopped_on(code, e)).map_ok(move |write| (code, write))).buffered(IN_FLIGHT);
        let mut done = 0;
        while let Some((code, write)) = written.try_next().await? {
            match write {
                Ok(write) => self.with_store(move |s| s.write(&[write])).await?,
                Err(skip) => {
                    self.with_store(move |s| s.finish_refetch_attempt(code)).await?;
                    tracing::warn!(code = code.as_str(), reason = %skip, "과거 이어 받기에서 이 종목을 건너뜁니다. 다음 업데이트에서 다시 받습니다");
                }
            }
            done += 1;
            self.report(id, UpdatePhase::Backfill, done, total);
        }
        Ok(self.with_store(Store::end_full_refetch).await?)
    }

    async fn catch_up(&self, code: StockCode, how: Catchup, target: KstDate) -> Result<Result<Write, Skip>, BarError> {
        let Catchup::FirstPage { stored_through } = how else {
            return Ok(self.whole_history(code, target).await?.map(|bars| Write::Replace { code, bars }));
        };
        let req = DailyChart::new(code, Venue::Krx, self.clock.now().kst_date());
        let Some(page) = self.daily_page(code, &req, None, target).await?.filter(|p| !p.bars.is_empty()) else {
            return Ok(Err(Skip::NoDailyBars));
        };
        let reached_origin = page.next.is_none();
        let Some(stored_through) = stored_through else {
            return Ok(Ok(Write::Extend { code, bars: page.bars, reached_origin }));
        };
        let reaches_stored = page.bars.first().is_some_and(|b| b.day <= stored_through);
        let (overlap, fresh): (Vec<DayBar>, Vec<DayBar>) = page.bars.into_iter().partition(|b| b.day <= stored_through);
        let matches_stored = reaches_stored && {
            let from = overlap[0].day;
            self.with_store(move |s| s.bars_from(code, from)).await? == overlap
        };
        if matches_stored {
            return Ok(Ok(Write::Extend { code, bars: fresh, reached_origin }));
        }
        tracing::info!(code = code.as_str(), reaches_stored, "최근 일봉이 저장된 봉과 달라 전체 이력을 다시 받습니다");
        self.with_store(move |s| s.require_refetch(&[code], None)).await?;
        Ok(self.whole_history(code, target).await?.map(|bars| Write::Replace { code, bars }))
    }

    async fn whole_history(&self, code: StockCode, target: KstDate) -> Result<Result<Vec<DayBar>, Skip>, BarError> {
        let req = DailyChart::new(code, Venue::Krx, self.clock.now().kst_date());
        let mut pages = Vec::new();
        let mut cont = None;
        for _ in 0..MAX_HISTORY_PAGES {
            let Some(page) = self.daily_page(code, &req, cont.as_ref(), target).await? else {
                return Ok(Err(Skip::NoDailyBars));
            };
            pages.push(page.bars);
            cont = page.next;
            if cont.is_none() {
                let mut bars: Vec<DayBar> = pages.into_iter().rev().flatten().collect();
                bars.dedup_by_key(|b| b.day);
                return Ok(Some(bars).filter(|bars| !bars.is_empty()).ok_or(Skip::NoDailyBars));
            }
        }
        Ok(Err(Skip::PastPageLimit))
    }

    async fn daily_page(&self, code: StockCode, req: &DailyChart, cont: Option<&ContKey>, target: KstDate) -> Result<Option<DailyPage>, BarError> {
        let page = match self.rest.call(req, cont, Priority::Background, MergeScope::default()).await {
            Ok(page) => page,
            Err(e) if unknown_symbol(&e) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let Some(daily) = parse_krx_daily(page.body) else {
            return Ok(None);
        };
        for row in &daily.unreadable {
            tracing::warn!(code = code.as_str(), dt = %row.dt, reason = %row.reason, "키움 일봉 행을 읽지 못해 그 행만 빼고 받습니다");
        }
        let bars = daily.rows.into_iter().map(|r| DayBar { day: r.day, ohlcv: r.ohlcv, traded: r.traded }).filter(|b| b.day <= target).collect();
        Ok(Some(DailyPage { bars, next: page.next }))
    }
}

fn unknown_symbol(e: &KiwoomError) -> bool {
    e.failure().map(Failure::surface) == Some(Surface::UnknownSymbol)
}
