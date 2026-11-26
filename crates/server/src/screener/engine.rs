use std::collections::HashMap;
use std::num::NonZeroU64;

use domain::{Bucket, KstDate, KstTime, Period, Price, StockCode, TimeOfDay};

use super::memory::{Bar, Edition};
use super::micro::MicroRule;
use super::summary::{MissingSummary, SummaryBatch};
use super::Observation;
use crate::http::ApiFailure;
use crate::kiwoom::wire::KrxSummaryValues;
use super::line::{Cell, Line, Series};
use super::rules::RunnableScreen;
use super::store::{MicroSums, Store, StoreError, exclusion_mask, price_of};
use crate::api::{self, BarField, ScreenPeriod, ScreenerExcluded, ScreenerResult, ScreenerRow, SymbolCode};

const PERIODS: [ScreenPeriod; 3] = [ScreenPeriod::Day, ScreenPeriod::Week, ScreenPeriod::Month];

pub(super) struct Cells {
    buckets: Vec<Bucket>,
    first_observation_days: Vec<KstDate>,
    pub(super) of_day: Vec<Cell>,
}

fn midnight(day: KstDate) -> KstTime {
    KstTime::from_kst_civil(day, TimeOfDay::MIDNIGHT)
}

impl Cells {
    pub(super) fn new(period: Period, days: &[KstDate]) -> Cells {
        let mut buckets: Vec<Bucket> = Vec::new();
        let mut first_observation_days = Vec::new();
        let mut of_day = Vec::with_capacity(days.len());
        for &day in days {
            let bucket = period.bucket(midnight(day));
            if buckets.last() != Some(&bucket) {
                buckets.push(bucket);
                first_observation_days.push(day);
            }
            of_day.push(buckets.len() as Cell - 1);
        }
        Cells { buckets, first_observation_days, of_day }
    }

    fn as_of(&self) -> Cell {
        self.buckets.len() as Cell - 1
    }

    fn at_or_after(&self, day: KstDate) -> Cell {
        self.buckets.partition_point(|b| b.end() <= midnight(day)) as Cell
    }

    fn of_listing(&self, day: KstDate) -> Option<Cell> {
        self.buckets.first().filter(|first| first.start() <= midnight(day)).map(|_| self.at_or_after(day))
    }

    fn start_of(&self, stock: &Stock<'_>) -> Option<Cell> {
        let first_stored_cell = stock.first_stored_day.map(|d| self.at_or_after(d));
        let listed = stock.listed_on.and_then(|d| self.of_listing(d));
        if stock.complete { listed.max(first_stored_cell) } else { listed }
    }

    fn start_day(&self, cell: Cell) -> KstDate {
        self.buckets[cell as usize].start().kst_date()
    }

    fn first_observation_day(&self, cell: Cell) -> Option<KstDate> {
        usize::try_from(cell).ok().and_then(|c| self.first_observation_days.get(c)).copied()
    }
}

struct Calendars {
    day: Cells,
    week: Cells,
    month: Cells,
}

impl Calendars {
    fn new(days: Vec<KstDate>) -> Calendars {
        let (day, week, month) = (Cells::new(Period::Day, &days), Cells::new(Period::Week, &days), Cells::new(Period::Month, &days));
        Calendars { day, week, month }
    }

    fn of(&self, period: ScreenPeriod) -> &Cells {
        match period {
            ScreenPeriod::Day => &self.day,
            ScreenPeriod::Week => &self.week,
            ScreenPeriod::Month => &self.month,
        }
    }
}

struct Stock<'e> {
    stored: usize,
    code: StockCode,
    name: &'e str,
    listed_on: Option<KstDate>,
    listed_shares: Option<NonZeroU64>,
    complete: bool,
    first_stored_day: Option<KstDate>,
    on_last_day: bool,
    refetch: bool,
    today: Option<Bar>,
}

#[derive(Clone, Copy)]
enum Standing {
    ListedTooShort,
    HistoryShort,
    Judged,
}

fn standing(line: &Line, stock: &Stock<'_>, cells: &Cells, series: &Series) -> Standing {
    let start = cells.start_of(stock);
    if start.is_some_and(|s| cells.as_of() - s + 1 < line.needed_bars()) {
        return Standing::ListedTooShort;
    }
    let stored_from_listing = stock.first_stored_day.zip(stock.listed_on).is_some_and(|(stored, listed)| stored <= listed);
    if stock.complete || stored_from_listing {
        return if (series.len() as i64) < line.needed_bars() { Standing::ListedTooShort } else { Standing::Judged };
    }
    let needed = (u64::from(line.recent_bars) - 1) + line.needed_bars() as u64;
    let Some(first) = (series.len() as u64).checked_sub(needed).and_then(|i| series.cells_from(0).get(i as usize)) else {
        return Standing::HistoryShort;
    };
    let covered = stock.first_stored_day.zip(cells.first_observation_day(*first)).is_some_and(|(stored, needed)| stored <= needed);
    if covered { Standing::Judged } else { Standing::HistoryShort }
}

struct DailyClose {
    day: KstDate,
    provisional: bool,
    close: Price,
    previous: Option<Price>,
    traded_million_won: u64,
}

fn today_bar(batch: &SummaryBatch, code: &StockCode) -> Option<Bar> {
    let quote = batch.stocks.get(code)?.result.as_ref().ok()?;
    let KrxSummaryValues::Traded { ohlcv: o, traded } = quote.values else { return None };
    Some(Bar { open: o.open().centi(), high: o.high().centi(), low: o.low().centi(), close: o.close().centi(), volume: o.volume().0, traded: traded.0 })
}

pub(super) fn screen(edition: &Edition, screen: &RunnableScreen, batch: &SummaryBatch, observation: Observation, store: &Store) -> Result<ScreenerResult, ApiFailure> {
    let stored_day = edition.last_day.expect("확인한 저장소");
    let provisional = stored_day < batch.target;
    let today_traded = batch.stocks.values().any(|s| s.result.as_ref().is_ok_and(|q| matches!(q.values, KrxSummaryValues::Traded { .. })));
    if matches!(observation, Observation::PreviousOnly(_)) && today_traded {
        return Err(super::data_changed("오늘 거래 요약과 새 봉 부재의 근거가 다릅니다. 다시 실행하세요"));
    }
    let as_of = if provisional && (matches!(observation, Observation::Current) || today_traded) { batch.target } else { stored_day };
    let mut days = edition.calendar_days.clone();
    if days.last() != Some(&stored_day) {
        return Err(StoreError(format!("관측일 달력에 기준 관측일 {stored_day}이 없습니다")).into());
    }
    if as_of > stored_day { days.push(as_of); }
    let calendars = Calendars::new(days);
    let with_today_bars = provisional && as_of == batch.target;
    let unwanted = exclusion_mask(&screen.exclude);
    let universe: Vec<Stock> = edition
        .stocks
        .iter()
        .enumerate()
        .filter(|(_, s)| s.excludable_as & unwanted == 0 && screen.covers(s.market))
        .map(|(stored, s)| {
            let today = if with_today_bars { today_bar(batch, &s.code) } else { None };
            Stock {
                stored,
                code: s.code,
                name: &s.name,
                listed_on: s.listed_on,
                listed_shares: s.listed_shares,
                complete: s.complete,
                first_stored_day: if today.is_some() { Some(s.first_day.map_or(as_of, |first| first.min(as_of))) } else { s.first_day },
                on_last_day: s.on_last_day,
                refetch: s.refetch,
                today,
            }
        })
        .collect();
    let mut excluded = ScreenerExcluded { listed_too_short: 0, history_short: 0, unconfirmed: 0 };
    let mut missing_summary = 0;
    let mut judged = Vec::new();
    for stock in &universe {
        if stock.listed_on.is_some_and(|listed| listed > as_of) {
            excluded.listed_too_short += 1;
            continue;
        }
        let listed_by_stored_day = stock.listed_on.is_none_or(|listed| listed <= stored_day);
        if listed_by_stored_day && (!stock.on_last_day || stock.refetch) {
            excluded.unconfirmed += 1;
            continue;
        }
        let available = batch.stocks.get(&stock.code).is_some_and(|s| match &s.result {
            Ok(_) => true,
            Err(MissingSummary::OtherDate(day)) => matches!(observation, Observation::PreviousOnly(previous) if previous == *day && previous == stored_day),
            Err(_) => false,
        });
        if !available {
            missing_summary += 1;
            continue;
        }
        judged.push(stock);
    }
    let Matches { hits, standings } = matched(edition, &calendars, &screen.lines, &judged, as_of, with_today_bars)?;
    for standing in standings {
        match standing {
            Standing::ListedTooShort => excluded.listed_too_short += 1,
            Standing::HistoryShort => excluded.history_short += 1,
            Standing::Judged => (),
        }
    }
    let micro_windows: HashMap<u32, HashMap<StockCode, MicroSums>> = if screen.micros.is_empty() {
        HashMap::new()
    } else {
        let mut days_list: Vec<u32> = screen.micros.iter().map(MicroRule::days).collect();
        days_list.sort_unstable();
        days_list.dedup();
        store.micro_windows(as_of, &days_list)?
    };
    let program_days = screen.micros.iter().find_map(|rule| match *rule {
        MicroRule::ProgramNetBuy { days, .. } => Some(days),
        _ => None,
    });
    let whale_days = screen.micros.iter().find_map(|rule| match *rule {
        MicroRule::WhaleNetBuy { days, .. } => Some(days),
        _ => None,
    });
    let vi_days = screen.micros.iter().find_map(|rule| match *rule {
        MicroRule::ViTriggered { days, .. } => Some(days),
        _ => None,
    });
    let mut rows: Vec<ScreenerRow> = Vec::new();
    for (idx, matched_on) in hits {
        let stock = judged[idx];
        let Some(daily) = daily_close(edition, stock, as_of)? else {
            tracing::warn!(code = stock.code.as_str(), "맞은 종목의 일봉 종가가 없어 결과에서 뺍니다");
            continue;
        };
        if !screen.market_caps.iter().all(|range| range.admits(daily.close, stock.listed_shares)) {
            continue;
        }
        if !screen.micros.iter().all(|rule| rule.admits(micro_windows.get(&rule.days()).and_then(|map| map.get(&stock.code)))) {
            continue;
        }
        let program_net_million_won = program_days
            .and_then(|days| micro_windows.get(&days)?.get(&stock.code))
            .map(|sums| won_to_million(sums.program_net_won));
        let whale_net_million_won = whale_days
            .and_then(|days| micro_windows.get(&days)?.get(&stock.code))
            .map(|sums| won_to_million(sums.whale_net_won));
        let vi_count = vi_days
            .and_then(|days| micro_windows.get(&days)?.get(&stock.code))
            .map(|sums| sums.vi_count);
        rows.push(ScreenerRow {
            symbol: SymbolCode(stock.code.as_str().to_owned()),
            name: stock.name.to_owned(),
            close: daily.close.to_f64(),
            change_rate: daily.previous.map(|previous| change_rate(daily.close, previous)),
            matched_date: api::KstDate(matched_on),
            latest_bar_date: api::KstDate(daily.day),
            provisional: daily.provisional,
            traded_million_won: Some(daily.traded_million_won),
            program_net_million_won,
            whale_net_million_won,
            vi_count,
        });
    }
    rows.sort_by(|a, b| b.matched_date.cmp(&a.matched_date).then_with(|| a.symbol.0.cmp(&b.symbol.0)));
    Ok(ScreenerResult { as_of: api::KstDate(as_of), collection_started_at: api::UnixSeconds(batch.started_at.unix()), collection_completed_at: api::UnixSeconds(batch.completed_at.unix()), missing_summary, universe: universe.len() as u32, excluded, rows })
}

pub(super) fn adjustments(edition: &Edition, batch: &SummaryBatch) -> Vec<StockCode> {
    if edition.last_day >= Some(batch.target) { return Vec::new(); }
    batch.stocks.iter().filter_map(|(code, stock)| {
        let quote = stock.result.as_ref().ok()?;
        let stored = edition.stock(code).filter(|s| !s.refetch)?;
        let (last_bar, last_traded) = (stored.last_close?, stored.last_traded_close);
        let moved_from = |close: u64| 10 * u128::from(quote.base.centi().abs_diff(close)) > 3 * u128::from(close);
        (moved_from(last_bar) && last_traded.is_some_and(moved_from)).then_some(*code)
    }).collect()
}

struct Matches {
    hits: Vec<(usize, KstDate)>,
    standings: Vec<Standing>,
}

fn matched(edition: &Edition, calendars: &Calendars, lines: &[Line], judged: &[&Stock], as_of: KstDate, with_today_bars: bool) -> Result<Matches, StoreError> {
    let mut standings: Vec<Vec<Standing>> = judged.iter().map(|stock| lines.iter().map(|line| {
        let cells = calendars.of(line.period);
        if stock.complete || cells.start_of(stock).is_some_and(|start| cells.as_of() - start + 1 < line.needed_bars()) { Standing::ListedTooShort } else { Standing::HistoryShort }
    }).collect()).collect();
    let mut last_candidates: Vec<Vec<Option<Cell>>> = vec![vec![None; lines.len()]; judged.len()];
    let mut series = Series::default();
    for period in PERIODS {
        let of_period: Vec<(usize, &Line)> = lines.iter().enumerate().filter(|(_, line)| line.period == period).collect();
        if of_period.is_empty() {
            continue;
        }
        let cells = calendars.of(period);
        let mut columns: Vec<BarField> = of_period.iter().flat_map(|(_, line)| line.kind.columns()).collect();
        columns.sort_by_key(|field| *field as usize);
        columns.dedup();
        let today_cell = with_today_bars.then(|| cells.as_of());
        for (idx, stock) in judged.iter().enumerate() {
            if !fill_series(edition, period, stock, &columns, today_cell, &mut series) {
                continue;
            }
            for &(k, line) in &of_period {
                standings[idx][k] = standing(line, stock, cells, &series);
                last_candidates[idx][k] = line.last_candidate(&series);
            }
        }
    }
    let matched_on = |candidates: &[Option<Cell>]| match (lines.first(), candidates.first()) {
        (Some(line), Some(Some(cell))) => calendars.of(line.period).start_day(*cell),
        _ => as_of,
    };
    let standings: Vec<Standing> = standings.into_iter().enumerate().map(|(idx, lines)| {
        if lines.iter().any(|s| matches!(s, Standing::ListedTooShort)) {
            Standing::ListedTooShort
        } else if lines.iter().any(|s| matches!(s, Standing::HistoryShort)) {
            Standing::HistoryShort
        } else if judged[idx].first_stored_day.is_none() {
            Standing::ListedTooShort
        } else {
            Standing::Judged
        }
    }).collect();
    let hits = last_candidates.iter().enumerate().filter(|(idx, candidates)| matches!(standings[*idx], Standing::Judged) && candidates.iter().all(Option::is_some)).map(|(idx, candidates)| (idx, matched_on(candidates))).collect();
    Ok(Matches { hits, standings })
}

fn fill_series(edition: &Edition, period: ScreenPeriod, stock: &Stock<'_>, columns: &[BarField], today_cell: Option<Cell>, series: &mut Series) -> bool {
    series.clear();
    let bars = edition.bars(period);
    let range = bars.range(stock.stored);
    series.extend_cells(bars.cells(range.clone()).iter().map(|&cell| Cell::from(cell)));
    for &field in columns {
        bars.column(field).append_to(range.clone(), series.column_mut(field));
    }
    if let Some((cell, bar)) = today_cell.zip(stock.today.filter(|bar| bar.volume > 0)) {
        let joins_last_bar = series.last_cell() == Some(cell);
        if !joins_last_bar {
            series.extend_cells(std::iter::once(cell));
        }
        for &field in columns {
            let (column, value) = (series.column_mut(field), u128::from(bar.field(field)));
            match (joins_last_bar, column.last_mut()) {
                (true, Some(last)) => *last = match field {
                    BarField::Open => *last,
                    BarField::High => (*last).max(value),
                    BarField::Low => (*last).min(value),
                    BarField::Close => value,
                    BarField::Volume | BarField::TradedValue => *last + value,
                },
                _ => column.push(value),
            }
        }
    }
    series.len() > 0
}

fn daily_close(edition: &Edition, stock: &Stock<'_>, as_of: KstDate) -> Result<Option<DailyClose>, StoreError> {
    let bars = edition.bars(ScreenPeriod::Day);
    let range = bars.range(stock.stored);
    let close = bars.column(BarField::Close);
    let traded = bars.column(BarField::TradedValue);
    let stored_close = |from_end: usize| (range.len() > from_end).then(|| close.at(range.end - 1 - from_end) as u64).map(price_of).transpose();
    if let Some(today) = stock.today.filter(|bar| bar.volume > 0) {
        return Ok(Some(DailyClose { day: as_of, provisional: true, close: price_of(today.close)?, previous: stored_close(0)?, traded_million_won: today.traded }));
    }
    let Some(&cell) = bars.cells(range.clone()).last() else { return Ok(None) };
    Ok(Some(DailyClose { day: edition.calendar_days[cell as usize], provisional: false, close: price_of(close.at(range.end - 1) as u64)?, previous: stored_close(1)?, traded_million_won: traded.at(range.end - 1) as u64 }))
}

fn change_rate(close: Price, previous: Price) -> f64 {
    let (close, previous) = (close.centi() as f64, previous.centi() as f64);
    ((close - previous) / previous * 10_000.0).round() / 100.0
}

fn won_to_million(won: i128) -> i64 {
    (won as f64 / 1_000_000.0).round().clamp(i64::MIN as f64, i64::MAX as f64) as i64
}
