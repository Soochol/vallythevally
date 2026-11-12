use std::collections::HashMap;
use std::num::NonZeroU64;

use domain::{Bucket, KstDate, KstTime, Period, Price, StockCode, TimeOfDay};
use duckdb::arrow::array::{AsArray, RecordBatch};
use duckdb::arrow::datatypes::{ArrowPrimitiveType, DataType, Decimal128Type, Int64Type, UInt32Type, UInt64Type};
use duckdb::{Connection, Transaction, params};

use super::exact::Decimal;
use super::summary::{MissingSummary, SummaryBatch};
use super::Observation;
use crate::http::ApiFailure;
use crate::kiwoom::wire::KrxSummaryValues;
use super::indicator::Indicator;
use super::line::{Cell, Kind, Line, Series};
use super::market_cap::MarketCapRange;
use super::store::{LISTING_LOST, StoreError, date_of, date_value, exclusion_mask, market_of, price_of, stock_code, unconfirmed_on};
use crate::api::{self, BarField, Bound, Condition, ExcludeKind, Extreme, Market, Screen, ScreenPeriod, ScreenerExcluded, ScreenerResult, ScreenerRow, SurgeField, SymbolCode};

const PERIODS: [ScreenPeriod; 3] = [ScreenPeriod::Day, ScreenPeriod::Week, ScreenPeriod::Month];

pub(super) struct RunnableScreen {
    lines: Vec<Line>,
    market_caps: Vec<MarketCapRange>,
    markets: Vec<Market>,
    exclude: Vec<ExcludeKind>,
}

impl RunnableScreen {
    pub(super) fn of(screen: &Screen) -> Result<RunnableScreen, String> {
        let (mut lines, mut market_caps) = (Vec::new(), Vec::new());
        for (k, condition) in screen.conditions.iter().enumerate() {
            match rule_of(condition).map_err(|why| format!("{}번째 조건: {why}", k + 1))? {
                Rule::Bars(line) => lines.push(line),
                Rule::MarketCap(range) => market_caps.push(range),
            }
        }
        Ok(RunnableScreen { lines, market_caps, markets: screen.markets.clone(), exclude: screen.exclude.clone() })
    }

    fn covers(&self, market: Market) -> bool {
        self.markets.is_empty() || self.markets.contains(&market)
    }
}

enum Rule {
    Bars(Line),
    MarketCap(MarketCapRange),
}

fn rule_of(condition: &Condition) -> Result<Rule, &'static str> {
    let line = |period, bar_range, kind| Ok(Rule::Bars(Line { period, bar_range, kind }));
    match *condition {
        Condition::NewHigh { period, bar_range, field, n } => line(period, bar_range, Kind::NewExtreme { extreme: Extreme::High, field, n }),
        Condition::NewLow { period, bar_range, field, n } => line(period, bar_range, Kind::NewExtreme { extreme: Extreme::Low, field, n }),
        Condition::ValueRange { period, bar_range, field, min, max } => line(period, bar_range, Kind::ValueRange { field, min: bound(min)?, max: bound(max)? }),
        Condition::Change { period, bar_range, back, min_pct, max_pct } => line(period, bar_range, Kind::Change { back, min_pct: bound(min_pct)?, max_pct: bound(max_pct)? }),
        Condition::NearExtreme { period, bar_range, extreme, n, within_pct } => line(period, bar_range, Kind::NearExtreme { extreme, n, within_pct: decimal(within_pct)? }),
        Condition::Surge { period, bar_range, field, n, times } => line(period, bar_range, Kind::Surge { field: surged(field), n, times: decimal(times)? }),
        Condition::MaPosition { period, bar_range, field, method, length, side } => line(period, bar_range, Kind::Indicator(Indicator::ma_position(field, method, length, side)?)),
        Condition::MaAlignment { period, bar_range, method, ref lengths, order } => line(period, bar_range, Kind::Indicator(Indicator::ma_alignment(method, lengths, order)?)),
        Condition::MaCross { period, bar_range, method, fast, slow, direction } => line(period, bar_range, Kind::Indicator(Indicator::ma_cross(method, fast, slow, direction)?)),
        Condition::Rsi { period, bar_range, length, test } => line(period, bar_range, Kind::Indicator(Indicator::rsi(length, test)?)),
        Condition::Macd { period, bar_range, fast, slow, signal, test } => line(period, bar_range, Kind::Indicator(Indicator::macd(fast, slow, signal, test)?)),
        Condition::Stochastic { period, bar_range, k, d, smooth, test } => line(period, bar_range, Kind::Indicator(Indicator::stochastic(k, d, smooth, test)?)),
        Condition::Bollinger { period, bar_range, length, k, test } => line(period, bar_range, Kind::Indicator(Indicator::bollinger(length, k, test)?)),
        Condition::Ichimoku { period, bar_range, conversion, base, span_b, displacement, test } => line(period, bar_range, Kind::Indicator(Indicator::ichimoku(conversion, base, span_b, displacement, test)?)),
        Condition::MarketCap { min, max } => Ok(Rule::MarketCap(MarketCapRange { min: bound(min)?, max: bound(max)? })),
    }
}

fn decimal(value: f64) -> Result<Decimal, &'static str> {
    Decimal::of(value).ok_or("수는 유한해야 합니다")
}

fn bound(value: Bound) -> Result<Option<Decimal>, &'static str> {
    value.0.map(decimal).transpose()
}

fn surged(field: SurgeField) -> BarField {
    match field {
        SurgeField::Volume => BarField::Volume,
        SurgeField::TradedValue => BarField::TradedValue,
    }
}

struct Cells {
    buckets: Vec<Bucket>,
    first_observation_days: Vec<KstDate>,
    of_day: Vec<Cell>,
}

fn midnight(day: KstDate) -> KstTime {
    KstTime::from_kst_civil(day, TimeOfDay::MIDNIGHT)
}

impl Cells {
    fn new(period: Period, days: &[KstDate]) -> Cells {
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

    fn start_of(&self, stock: &Stock) -> Option<Cell> {
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
    days: Vec<KstDate>,
    day: Cells,
    week: Cells,
    month: Cells,
}

impl Calendars {
    fn new(days: Vec<KstDate>) -> Calendars {
        let (day, week, month) = (Cells::new(Period::Day, &days), Cells::new(Period::Week, &days), Cells::new(Period::Month, &days));
        Calendars { days, day, week, month }
    }

    fn of(&self, period: ScreenPeriod) -> &Cells {
        match period {
            ScreenPeriod::Day => &self.day,
            ScreenPeriod::Week => &self.week,
            ScreenPeriod::Month => &self.month,
        }
    }
}

struct Stock {
    code: StockCode,
    name: String,
    listed_on: Option<KstDate>,
    excludable_as: u16,
    market: Market,
    listed_shares: Option<NonZeroU64>,
    complete: bool,
    first_stored_day: Option<KstDate>,
}

#[derive(Clone, Copy)]
enum Standing {
    ListedTooShort,
    HistoryShort,
    Judged,
}

fn standing(line: &Line, stock: &Stock, cells: &Cells, series: &Series) -> Standing {
    let start = cells.start_of(stock);
    if start.is_some_and(|s| cells.as_of() - s + 1 < line.needed_bars()) {
        return Standing::ListedTooShort;
    }
    let stored_from_listing = stock.first_stored_day.zip(stock.listed_on).is_some_and(|(stored, listed)| stored <= listed);
    if stock.complete || stored_from_listing {
        return if (series.len() as i64) < line.needed_bars() { Standing::ListedTooShort } else { Standing::Judged };
    }
    let needed = u64::from(line.bar_range.end) + line.needed_bars() as u64;
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
}

pub(super) struct Snapshot<'a> {
    tx: Transaction<'a>,
    pub(super) last_day: Option<KstDate>,
    pub(super) listing_lost: bool,
    pub(super) refetching: bool,
}

impl<'a> Snapshot<'a> {
    pub(super) fn begin(conn: &'a mut Connection) -> Result<Snapshot<'a>, StoreError> {
        let tx = conn.transaction()?;
        let (last_day, listing_lost, refetching) = tx.query_row(&format!("SELECT last_day, {LISTING_LOST}, full_refetch OR EXISTS (SELECT 1 FROM refetch_checks JOIN listed USING (code)) FROM store_meta"), [], |row| Ok((row.get::<_, Option<i32>>(0)?, row.get::<_, bool>(1)?, row.get::<_, bool>(2)?)))?;
        Ok(Snapshot { tx, last_day: last_day.map(date_of), listing_lost, refetching })
    }

    pub(super) fn screen(&self, screen: &RunnableScreen, batch: &SummaryBatch, observation: Observation) -> Result<ScreenerResult, ApiFailure> {
        let tx = &self.tx;
        let stored_day = self.last_day.expect("확인한 저장소");
        let provisional = stored_day < batch.target;
        let today_traded = batch.stocks.values().any(|s| s.result.as_ref().is_ok_and(|q| matches!(q.values, KrxSummaryValues::Traded { .. })));
        if matches!(observation, Observation::PreviousOnly(_)) && today_traded {
            return Err(super::data_changed("오늘 거래 요약과 새 봉 부재의 근거가 다릅니다. 다시 실행하세요"));
        }
        let as_of = if provisional && (matches!(observation, Observation::Current) || today_traded) { batch.target } else { stored_day };
        let mut days = observation_days(tx, stored_day)?;
        if as_of > stored_day { days.push(as_of); }
        let calendars = Calendars::new(days);
        self.combine_summary(batch)?;
        let unwanted = exclusion_mask(&screen.exclude);
        let universe: Vec<Stock> = stocks(tx, as_of)?.into_iter().filter(|s| s.excludable_as & unwanted == 0 && screen.covers(s.market)).collect();
        let unconfirmed = unconfirmed_on(tx, stored_day)?;
        let mut excluded = ScreenerExcluded { listed_too_short: 0, history_short: 0, unconfirmed: 0 };
        let mut missing_summary = 0;
        let mut judged = Vec::new();
        for stock in &universe {
            if stock.listed_on.is_some_and(|listed| listed > as_of) {
                excluded.listed_too_short += 1;
                continue;
            }
            if unconfirmed.contains(&stock.code) {
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
        fill_screen_tables(tx, &calendars, &judged)?;
        let Matches { hits, standings } = matched(tx, &calendars, &screen.lines, &judged, as_of)?;
        for standing in standings {
            match standing {
                Standing::ListedTooShort => excluded.listed_too_short += 1,
                Standing::HistoryShort => excluded.history_short += 1,
                Standing::Judged => (),
            }
        }
        let mut closes = daily_closes(tx, hits.iter().map(|(idx, _)| *idx))?;
        let mut rows: Vec<ScreenerRow> = hits
            .into_iter()
            .filter_map(|(idx, matched_on)| {
                let stock = judged[idx];
                let Some(daily) = closes.remove(&idx) else {
                    tracing::warn!(code = stock.code.as_str(), "맞은 종목의 일봉 종가가 없어 결과에서 뺍니다");
                    return None;
                };
                if !screen.market_caps.iter().all(|range| range.admits(daily.close, stock.listed_shares)) {
                    return None;
                }
                Some(ScreenerRow {
                    symbol: SymbolCode(stock.code.as_str().to_owned()),
                    name: stock.name.clone(),
                    close: daily.close.to_f64(),
                    change_rate: daily.previous.map(|previous| change_rate(daily.close, previous)),
                    matched_date: api::KstDate(matched_on),
                    latest_bar_date: api::KstDate(daily.day),
                    provisional: daily.provisional,
                })
            })
            .collect();
        rows.sort_by(|a, b| b.matched_date.cmp(&a.matched_date).then_with(|| a.symbol.0.cmp(&b.symbol.0)));
        Ok(ScreenerResult { as_of: api::KstDate(as_of), collection_started_at: api::UnixSeconds(batch.started_at.unix()), collection_completed_at: api::UnixSeconds(batch.completed_at.unix()), missing_summary, universe: universe.len() as u32, excluded, rows })
    }

    pub(super) fn adjustments(&self, batch: &SummaryBatch) -> Result<Vec<StockCode>, StoreError> {
        if self.last_day >= Some(batch.target) { return Ok(Vec::new()); }
        let mut stmt = self.tx.prepare("SELECT code, arg_max(close, day) FROM daily WHERE day < ? AND day <= (SELECT last_day FROM store_meta) AND volume > 0 AND code NOT IN (SELECT code FROM history WHERE refetch) GROUP BY code")?;
        let previous = stmt.query_map(params![date_value(batch.target)], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)))?.collect::<Result<HashMap<_, _>, _>>()?;
        Ok(batch.stocks.iter().filter_map(|(code, stock)| {
            let quote = stock.result.as_ref().ok()?;
            let close = *previous.get(code.as_str())?;
            (10 * u128::from(quote.base.centi().abs_diff(close)) > 3 * u128::from(close)).then_some(*code)
        }).collect())
    }

    fn combine_summary(&self, batch: &SummaryBatch) -> Result<(), ApiFailure> {
        let tx = &self.tx;
        tx.execute_batch("CREATE TEMP TABLE screen_summary AS SELECT * FROM daily LIMIT 0").map_err(StoreError::from)?;
        if self.last_day < Some(batch.target) {
            let mut appender = tx.appender("screen_summary").map_err(StoreError::from)?;
            for (code, stock) in &batch.stocks {
                let Ok(quote) = &stock.result else { continue };
                let KrxSummaryValues::Traded { ohlcv: o, traded } = quote.values else { continue };
                appender.append_row(params![code.as_str(), date_value(batch.target), o.open().centi(), o.high().centi(), o.low().centi(), o.close().centi(), o.volume().0, traded.0]).map_err(StoreError::from)?;
            }
            appender.flush().map_err(StoreError::from)?;
        }
        tx.execute_batch("CREATE TEMP VIEW screen_daily AS SELECT d.* FROM daily d WHERE d.day <= (SELECT last_day FROM store_meta) AND NOT EXISTS (SELECT 1 FROM screen_summary s WHERE s.code = d.code AND s.day = d.day) UNION ALL SELECT * FROM screen_summary").map_err(StoreError::from)?;
        Ok(())
    }
}

struct Matches {
    hits: Vec<(usize, KstDate)>,
    standings: Vec<Standing>,
}

fn matched(tx: &Transaction, calendars: &Calendars, lines: &[Line], judged: &[&Stock], as_of: KstDate) -> Result<Matches, StoreError> {
    let mut standings: Vec<Vec<Standing>> = judged.iter().map(|stock| lines.iter().map(|line| {
        let cells = calendars.of(line.period);
        if stock.complete || cells.start_of(stock).is_some_and(|start| cells.as_of() - start + 1 < line.needed_bars()) { Standing::ListedTooShort } else { Standing::HistoryShort }
    }).collect()).collect();
    let mut last_candidates: Vec<Vec<Option<Cell>>> = vec![vec![None; lines.len()]; judged.len()];
    for period in PERIODS {
        let of_period: Vec<(usize, &Line)> = lines.iter().enumerate().filter(|(_, line)| line.period == period).collect();
        if of_period.is_empty() {
            continue;
        }
        let cells = calendars.of(period);
        let mut columns: Vec<BarField> = of_period.iter().flat_map(|(_, line)| line.kind.columns()).collect();
        columns.sort_by_key(|field| *field as usize);
        columns.dedup();
        for_each_series(tx, &bar_query(period, &columns), &columns, |idx, series| {
            for &(k, line) in &of_period {
                standings[idx][k] = standing(line, judged[idx], cells, series);
                last_candidates[idx][k] = line.last_candidate(series);
            }
        })?;
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

fn column(field: BarField) -> &'static str {
    match field {
        BarField::Open => "open",
        BarField::High => "high",
        BarField::Low => "low",
        BarField::Close => "close",
        BarField::Volume => "volume",
        BarField::TradedValue => "traded_million_won",
    }
}

fn cell_column(period: ScreenPeriod) -> &'static str {
    match period {
        ScreenPeriod::Day => "day_cell",
        ScreenPeriod::Week => "week_cell",
        ScreenPeriod::Month => "month_cell",
    }
}

fn aggregate(field: BarField) -> String {
    let value = column(field);
    match field {
        BarField::Open => format!("arg_min(d.{value}, d.day)"),
        BarField::High => format!("max(d.{value})"),
        BarField::Low => format!("min(d.{value})"),
        BarField::Close => format!("arg_max(d.{value}, d.day)"),
        BarField::Volume | BarField::TradedValue => format!("sum(d.{value})"),
    }
}

fn bar_query(period: ScreenPeriod, columns: &[BarField]) -> String {
    let cell = format!("c.{}", cell_column(period));
    let from = "FROM screen_daily AS d JOIN screen_cells AS c ON c.day = d.day JOIN screen_stocks AS s ON s.code = d.code WHERE d.volume > 0";
    match period {
        ScreenPeriod::Day => {
            let values: Vec<String> = columns.iter().map(|&field| format!("d.{}", column(field))).collect();
            format!("SELECT s.idx, {cell}, {} {from} ORDER BY s.idx, {cell}", values.join(", "))
        }
        ScreenPeriod::Week | ScreenPeriod::Month => {
            let values: Vec<String> = columns.iter().map(|&field| aggregate(field)).collect();
            format!("SELECT s.idx, {cell}, {} {from} GROUP BY s.idx, {cell} ORDER BY s.idx, {cell}", values.join(", "))
        }
    }
}

fn primitive<T: ArrowPrimitiveType>(batch: &RecordBatch, k: usize) -> Result<&[T::Native], StoreError> {
    let array = batch.column(k);
    array.as_primitive_opt::<T>().map(|values| values.values().as_ref()).ok_or_else(|| StoreError(format!("봉 열의 {k}번째 열이 {}입니다", array.data_type())))
}

enum Values<'a> {
    Stored(&'a [u64]),
    Summed(&'a [i128]),
}

impl<'a> Values<'a> {
    fn of(batch: &'a RecordBatch, k: usize) -> Result<Values<'a>, StoreError> {
        let array = batch.column(k);
        match array.data_type() {
            DataType::UInt64 => Ok(Values::Stored(primitive::<UInt64Type>(batch, k)?)),
            DataType::Decimal128(_, 0) => Ok(Values::Summed(primitive::<Decimal128Type>(batch, k)?)),
            other => Err(StoreError(format!("봉 열의 {k}번째 열이 {other}입니다"))),
        }
    }

    fn append(&self, into: &mut Vec<u128>, rows: std::ops::Range<usize>) {
        match self {
            Values::Stored(values) => into.extend(values[rows].iter().map(|&v| u128::from(v))),
            Values::Summed(values) => into.extend(values[rows].iter().map(|v| v.unsigned_abs())),
        }
    }
}

fn for_each_series(tx: &Transaction, sql: &str, columns: &[BarField], mut judge: impl FnMut(usize, &Series)) -> Result<(), StoreError> {
    let mut stmt = tx.prepare(sql)?;
    let mut series = Series::default();
    let mut current: Option<u32> = None;
    for batch in stmt.query_arrow([])? {
        let stocks = primitive::<UInt32Type>(&batch, 0)?;
        let cells = primitive::<Int64Type>(&batch, 1)?;
        let values = columns.iter().enumerate().map(|(k, &field)| Ok((field, Values::of(&batch, k + 2)?))).collect::<Result<Vec<_>, StoreError>>()?;
        let mut from = 0;
        while from < stocks.len() {
            let stock = stocks[from];
            let to = from + stocks[from..].partition_point(|&s| s == stock);
            if current != Some(stock) {
                if let Some(done) = current {
                    judge(done as usize, &series);
                }
                series.clear();
                current = Some(stock);
            }
            series.push_cells(&cells[from..to]);
            for (field, column) in &values {
                column.append(series.column_mut(*field), from..to);
            }
            from = to;
        }
    }
    if let Some(done) = current {
        judge(done as usize, &series);
    }
    Ok(())
}

fn change_rate(close: Price, previous: Price) -> f64 {
    let (close, previous) = (close.centi() as f64, previous.centi() as f64);
    ((close - previous) / previous * 10_000.0).round() / 100.0
}

fn observation_days(tx: &Transaction, as_of: KstDate) -> Result<Vec<KstDate>, StoreError> {
    let mut stmt = tx.prepare("SELECT day FROM calendar WHERE day <= ? ORDER BY day")?;
    let days = stmt.query_map(params![date_value(as_of)], |row| row.get::<_, i32>(0))?.map(|day| day.map(date_of)).collect::<Result<Vec<_>, _>>()?;
    if days.last() != Some(&as_of) {
        return Err(StoreError(format!("관측일 달력에 기준 관측일 {as_of}이 없습니다")));
    }
    Ok(days)
}

fn stocks(tx: &Transaction, as_of: KstDate) -> Result<Vec<Stock>, StoreError> {
    let mut stmt = tx.prepare(
        "SELECT listed.code, listed.name, listed.listed_on, listed.excludable_as, listed.market, listed.listed_shares, coalesce(history.complete, false), earliest.day
         FROM listed LEFT JOIN history USING (code)
         LEFT JOIN (SELECT code, min(day) AS day FROM screen_daily WHERE day <= ? GROUP BY code) AS earliest USING (code)",
    )?;
    let rows = stmt.query_map(params![date_value(as_of)], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<i32>>(2)?,
            row.get::<_, u16>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<u64>>(5)?,
            row.get::<_, bool>(6)?,
            row.get::<_, Option<i32>>(7)?,
        ))
    })?;
    rows.map(|row| {
        let (code, name, listed_on, excludable_as, market, listed_shares, complete, first_stored_day) = row?;
        Ok(Stock {
            code: stock_code(&code)?,
            name,
            listed_on: listed_on.map(date_of),
            excludable_as,
            market: market_of(&market)?,
            listed_shares: listed_shares.and_then(NonZeroU64::new),
            complete,
            first_stored_day: first_stored_day.map(date_of),
        })
    })
    .collect()
}

fn fill_screen_tables(tx: &Transaction, calendars: &Calendars, judged: &[&Stock]) -> Result<(), StoreError> {
    tx.execute_batch(
        "CREATE TEMP TABLE screen_cells (day DATE NOT NULL, day_cell BIGINT NOT NULL, week_cell BIGINT NOT NULL, month_cell BIGINT NOT NULL);
         CREATE TEMP TABLE screen_stocks (code VARCHAR NOT NULL, idx UINTEGER NOT NULL);",
    )?;
    let mut appender = tx.appender("screen_cells")?;
    for (k, &day) in calendars.days.iter().enumerate() {
        appender.append_row(params![date_value(day), calendars.day.of_day[k], calendars.week.of_day[k], calendars.month.of_day[k]])?;
    }
    appender.flush()?;
    let mut appender = tx.appender("screen_stocks")?;
    for (idx, stock) in judged.iter().enumerate() {
        appender.append_row(params![stock.code.as_str(), idx as u32])?;
    }
    appender.flush()?;
    Ok(())
}

fn daily_closes(tx: &Transaction, hits: impl Iterator<Item = usize>) -> Result<HashMap<usize, DailyClose>, StoreError> {
    tx.execute_batch("CREATE TEMP TABLE screen_hits (idx UINTEGER NOT NULL)")?;
    {
        let mut appender = tx.appender("screen_hits")?;
        for idx in hits {
            appender.append_row(params![idx as u32])?;
        }
        appender.flush()?;
    }
    let mut stmt = tx.prepare(
        "WITH traded AS (SELECT s.idx, d.day, d.close FROM screen_daily AS d JOIN screen_cells AS c ON c.day = d.day JOIN screen_stocks AS s ON s.code = d.code
                         JOIN screen_hits AS h ON h.idx = s.idx WHERE d.volume > 0),
         latest AS (SELECT idx, max(day) AS day, arg_max(close, day) AS close FROM traded GROUP BY idx),
         previous AS (SELECT t.idx, arg_max(t.close, t.day) AS close FROM traded AS t JOIN latest AS l ON l.idx = t.idx WHERE t.day < l.day GROUP BY t.idx)
         SELECT l.idx, l.close, p.close, l.day, EXISTS (SELECT 1 FROM screen_summary s JOIN screen_stocks stock ON stock.code = s.code WHERE stock.idx = l.idx AND s.day = l.day) FROM latest AS l LEFT JOIN previous AS p ON p.idx = l.idx",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u64>(1)?, row.get::<_, Option<u64>>(2)?, row.get::<_, i32>(3)?, row.get::<_, bool>(4)?)))?;
    rows.map(|row| {
        let (idx, close, previous, day, provisional) = row?;
        Ok((idx as usize, DailyClose { day: date_of(day), provisional, close: price_of(close)?, previous: previous.map(price_of).transpose()? }))
    })
    .collect()
}
