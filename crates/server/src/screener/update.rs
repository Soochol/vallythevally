use std::collections::HashMap;

use domain::{IndexCode, KstDate, Price, StockCode, Venue};
use futures::{StreamExt, TryStreamExt, stream};

use super::{Calendar, CalendarUse, Screener};
use super::store::{DayBar, Store, StoreError, Tail, Write};
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

pub(super) enum UpdateError {
    Failed(BarError),
    NoDailyBars(StockCode),
}

impl From<BarError> for UpdateError {
    fn from(e: BarError) -> Self {
        UpdateError::Failed(e)
    }
}

impl From<KiwoomError> for UpdateError {
    fn from(e: KiwoomError) -> Self {
        UpdateError::Failed(e.into())
    }
}

impl From<StoreError> for UpdateError {
    fn from(e: StoreError) -> Self {
        UpdateError::Failed(e.into())
    }
}

fn base_moved(base: Price, stored_close: Price) -> bool {
    let (base, close) = (base.centi(), stored_close.centi());
    10 * base.abs_diff(close) > 3 * close
}

impl Screener {
    pub(super) async fn update(&self, id: u64, full: bool) -> Result<(), UpdateError> {
        tracing::info!(full, "스크리너 업데이트를 시작합니다");
        self.report(id, UpdatePhase::Symbols, 0, 1);
        let directory = self.symbols.ready(&self.rest).await.map_err(BarError::from)?;
        tracing::info!(count = directory.screener_listing().len(), "서버가 받아 둔 종목 목록으로 스크리너 종목 목록을 바꿉니다");
        self.with_store(move |s| s.replace_listing(directory.screener_listing())).await?;
        self.report(id, UpdatePhase::Symbols, 1, 1);
        if full {
            self.with_store(Store::mark_refetch).await?;
        }
        let calendar = self.calendar(CalendarUse::Update).await?;
        let target = calendar.target(self.clock.now()).ok_or_else(|| BarError::Internal("코스피 일봉에 관측일이 없어 목표 관측일을 정할 수 없습니다".into()))?;
        self.store_calendar(&calendar, target).await?;
        self.recent(id, target, calendar.last_before(target)).await?;
        self.backfill(id, target).await
    }

    async fn store_calendar(&self, recent: &Calendar, target: KstDate) -> Result<(), UpdateError> {
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

    async fn kospi_days_back_to(&self, stored_through: Option<KstDate>) -> Result<Vec<KstDate>, UpdateError> {
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
        Err(BarError::Internal(format!("코스피 일봉이 {MAX_HISTORY_PAGES}페이지를 넘어 관측일 달력 받기를 멈췄습니다")).into())
    }

    async fn recent(&self, id: u64, target: KstDate, day_before_target: Option<KstDate>) -> Result<(), UpdateError> {
        let tails = self.with_store(Store::tails).await?;
        let mut one_day = Vec::new();
        let mut catchups = Vec::new();
        for Tail { code, listed_on, last } in tails {
            if listed_on.is_some_and(|listed| listed > target) {
                continue;
            }
            match last {
                Some((day, _)) if day >= target => {}
                Some((day, close)) if Some(day) == day_before_target => one_day.push((code, day, close)),
                last => catchups.push((code, Catchup::FirstPage { stored_through: last.map(|(day, _)| day) })),
            }
        }
        let total = one_day.len() + catchups.len();
        let mut done = 0;
        self.report(id, UpdatePhase::Recent, done, total);
        for chunk in one_day.chunks(StockQuotes::MAX) {
            let codes: Vec<StockCode> = chunk.iter().map(|(code, _, _)| *code).collect();
            let req = StockQuotes::new(&codes, Venue::Krx).expect("chunks는 1~MAX개다");
            let page = self.rest.call(&req, None, Priority::Background, MergeScope::default()).await?;
            let quotes: HashMap<StockCode, KrxDayQuote> = parse_krx_quotes(page.body).into_iter().map(|q| (q.code, q)).collect();
            let mut writes = Vec::new();
            for &(code, stored_through, stored_close) in chunk {
                match quotes.get(&code).filter(|q| q.day == target) {
                    None => catchups.push((code, Catchup::FirstPage { stored_through: Some(stored_through) })),
                    Some(q) if base_moved(q.base, stored_close) => {
                        tracing::info!(code = code.as_str(), base = q.base.centi() / 100, stored_close = stored_close.centi() / 100, "기준가가 저장된 종가와 30% 넘게 달라 전체 이력을 다시 받습니다");
                        catchups.push((code, Catchup::WholeHistory));
                    }
                    Some(q) => writes.push(Write::Extend { code, bars: vec![DayBar { day: q.day, ohlcv: q.ohlcv, traded: q.traded }], reached_origin: false }),
                }
            }
            done += writes.len();
            self.with_store(move |s| s.write(&writes)).await?;
            self.report(id, UpdatePhase::Recent, done, total);
        }
        let mut written = stream::iter(catchups).map(|(code, how)| self.catch_up(code, how, target)).buffered(IN_FLIGHT);
        while let Some(write) = written.try_next().await? {
            self.with_store(move |s| s.write(&[write])).await?;
            done += 1;
            self.report(id, UpdatePhase::Recent, done, total);
        }
        self.with_store(move |s| s.set_last_day(target)).await?;
        Ok(())
    }

    async fn backfill(&self, id: u64, target: KstDate) -> Result<(), UpdateError> {
        let queue = self.with_store(move |s| s.backfill_queue(target)).await?;
        let total = queue.len();
        self.report(id, UpdatePhase::Backfill, 0, total);
        let mut written = stream::iter(queue).map(|code| self.catch_up(code, Catchup::WholeHistory, target)).buffered(IN_FLIGHT);
        let mut done = 0;
        while let Some(write) = written.try_next().await? {
            self.with_store(move |s| s.write(&[write])).await?;
            done += 1;
            self.report(id, UpdatePhase::Backfill, done, total);
        }
        Ok(())
    }

    async fn catch_up(&self, code: StockCode, how: Catchup, target: KstDate) -> Result<Write, UpdateError> {
        let Catchup::FirstPage { stored_through } = how else {
            return Ok(Write::Replace { code, bars: self.whole_history(code, target).await? });
        };
        let req = DailyChart::new(code, Venue::Krx, self.clock.now().kst_date());
        let page = self.daily_page(code, &req, None, target).await?;
        let reached_origin = page.next.is_none();
        let Some(stored_through) = stored_through else {
            return if page.bars.is_empty() { Err(UpdateError::NoDailyBars(code)) } else { Ok(Write::Extend { code, bars: page.bars, reached_origin }) };
        };
        let reaches_stored = page.bars.first().is_some_and(|b| b.day <= stored_through);
        let (overlap, fresh): (Vec<DayBar>, Vec<DayBar>) = page.bars.into_iter().partition(|b| b.day <= stored_through);
        let matches_stored = reaches_stored && {
            let from = overlap[0].day;
            self.with_store(move |s| s.bars_from(code, from)).await? == overlap
        };
        if matches_stored {
            return Ok(Write::Extend { code, bars: fresh, reached_origin });
        }
        tracing::info!(code = code.as_str(), reaches_stored, "최근 일봉이 저장된 봉과 달라 전체 이력을 다시 받습니다");
        Ok(Write::Replace { code, bars: self.whole_history(code, target).await? })
    }

    async fn whole_history(&self, code: StockCode, target: KstDate) -> Result<Vec<DayBar>, UpdateError> {
        let req = DailyChart::new(code, Venue::Krx, self.clock.now().kst_date());
        let mut pages = Vec::new();
        let mut cont = None;
        for _ in 0..MAX_HISTORY_PAGES {
            let page = self.daily_page(code, &req, cont.as_ref(), target).await?;
            pages.push(page.bars);
            cont = page.next;
            if cont.is_none() {
                let mut bars: Vec<DayBar> = pages.into_iter().rev().flatten().collect();
                bars.dedup_by_key(|b| b.day);
                return if bars.is_empty() { Err(UpdateError::NoDailyBars(code)) } else { Ok(bars) };
            }
        }
        Err(BarError::Internal(format!("{} 일봉이 {MAX_HISTORY_PAGES}페이지를 넘어 받기를 멈췄습니다", code.as_str())).into())
    }

    async fn daily_page(&self, code: StockCode, req: &DailyChart, cont: Option<&ContKey>, target: KstDate) -> Result<DailyPage, UpdateError> {
        let page = match self.rest.call(req, cont, Priority::Background, MergeScope::default()).await {
            Ok(page) => page,
            Err(e) if unknown_symbol(&e) => return Err(UpdateError::NoDailyBars(code)),
            Err(e) => return Err(e.into()),
        };
        match parse_krx_daily(page.body) {
            Ok(Some(rows)) => {
                let bars = rows.into_iter().map(|r| DayBar { day: r.day, ohlcv: r.ohlcv, traded: r.traded }).filter(|b| b.day <= target).collect();
                Ok(DailyPage { bars, next: page.next })
            }
            Ok(None) => Err(UpdateError::NoDailyBars(code)),
            Err(e) => Err(BarError::Internal(format!("키움 일봉 응답을 읽지 못했습니다: {e}")).into()),
        }
    }
}

fn unknown_symbol(e: &KiwoomError) -> bool {
    e.failure().map(Failure::surface) == Some(Surface::UnknownSymbol)
}
