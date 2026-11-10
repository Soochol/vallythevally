use std::collections::HashMap;

use domain::{Bucket, KstDate, KstTime, Period, Price, StockCode, TimeOfDay};
use duckdb::{Transaction, params};

use super::store::{Store, StoreError, date_of, date_value, exclusion_mask, price_of, stock_code};
use crate::api::{self, BarField, NewHigh, Screen, ScreenPeriod, ScreenerExcluded, ScreenerResult, ScreenerRow, SymbolCode};

type Cell = i64;

struct Cells {
    buckets: Vec<Bucket>,
    of_day: Vec<(KstDate, Cell)>,
}

fn midnight(day: KstDate) -> KstTime {
    KstTime::from_kst_civil(day, TimeOfDay::MIDNIGHT)
}

impl Cells {
    fn new(period: Period, days: &[KstDate]) -> Cells {
        let mut buckets: Vec<Bucket> = Vec::new();
        let mut of_day = Vec::with_capacity(days.len());
        for &day in days {
            let bucket = period.bucket(midnight(day));
            if buckets.last() != Some(&bucket) {
                buckets.push(bucket);
            }
            of_day.push((day, buckets.len() as Cell - 1));
        }
        Cells { buckets, of_day }
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

    fn start_day(&self, cell: Cell) -> KstDate {
        self.buckets[cell as usize].start().kst_date()
    }
}

struct Stock {
    code: StockCode,
    name: String,
    listed_on: Option<KstDate>,
    excludable_as: u16,
    complete: bool,
    first_day: Option<KstDate>,
}

enum Standing {
    ListedTooShort,
    HistoryShort,
    Judged { start: Option<Cell> },
}

struct Reach {
    as_of: Cell,
    longest_n: i64,
    earliest_needed: Cell,
}

fn first_recent_cell(c: &NewHigh, as_of: Cell) -> Cell {
    as_of - i64::from(c.m - 1)
}

fn first_needed_cell(c: &NewHigh, as_of: Cell) -> Cell {
    first_recent_cell(c, as_of) - i64::from(c.n - 1)
}

impl Reach {
    fn of(conditions: &[NewHigh], as_of: Cell) -> Reach {
        let longest_n = conditions.iter().map(|c| i64::from(c.n)).max().unwrap_or(1);
        let earliest_needed = conditions.iter().map(|c| first_needed_cell(c, as_of)).min().unwrap_or(as_of);
        Reach { as_of, longest_n, earliest_needed }
    }

    fn standing(&self, stock: &Stock, cells: &Cells) -> Standing {
        let first = stock.first_day.map(|d| cells.at_or_after(d));
        let listed = stock.listed_on.and_then(|d| cells.of_listing(d));
        let start = if stock.complete { listed.max(first) } else { listed };
        if start.is_some_and(|s| self.as_of - s + 1 < self.longest_n) {
            return Standing::ListedTooShort;
        }
        let needed = start.map_or(self.earliest_needed, |s| self.earliest_needed.max(s));
        if !stock.complete && first.is_none_or(|f| f > needed) {
            return Standing::HistoryShort;
        }
        Standing::Judged { start }
    }
}

struct Hit {
    code: StockCode,
    high_cell: Cell,
    close: Price,
    previous_close: Option<Price>,
}

pub(super) fn screen(store: &Store, screen: &Screen) -> Result<ScreenerResult, StoreError> {
    let mut conn = store.reader()?;
    let tx = conn.transaction()?;
    let as_of = tx.query_row("SELECT last_day FROM store_meta", [], |row| row.get::<_, Option<i32>>(0))?.map(date_of);
    let as_of = as_of.ok_or_else(|| StoreError("마지막 관측일이 없는 저장소로는 실행할 수 없습니다".into()))?;
    let period = period_of(screen.period);
    let cells = Cells::new(period, &observation_days(&tx, as_of)?);
    let reach = Reach::of(&screen.conditions, cells.as_of());
    let unwanted = exclusion_mask(&screen.exclude);
    let universe: Vec<Stock> = stocks(&tx, as_of)?.into_iter().filter(|s| s.excludable_as & unwanted == 0).collect();
    let mut excluded = ScreenerExcluded { listed_too_short: 0, history_short: 0 };
    let mut judged = Vec::new();
    for stock in &universe {
        match reach.standing(stock, &cells) {
            Standing::ListedTooShort => excluded.listed_too_short += 1,
            Standing::HistoryShort => excluded.history_short += 1,
            Standing::Judged { start } => judged.push((stock.code, start)),
        }
    }
    let names: HashMap<StockCode, &str> = universe.iter().map(|s| (s.code, s.name.as_str())).collect();
    let mut rows: Vec<ScreenerRow> = new_highs(&tx, &cells, &reach, period, &screen.conditions, &judged)?
        .into_iter()
        .map(|hit| ScreenerRow {
            symbol: SymbolCode(hit.code.as_str().to_owned()),
            name: names[&hit.code].to_owned(),
            close: hit.close.to_f64(),
            change_rate: hit.previous_close.map(|previous| change_rate(hit.close, previous)),
            high_date: api::KstDate(cells.start_day(hit.high_cell)),
        })
        .collect();
    rows.sort_by(|a, b| b.high_date.cmp(&a.high_date).then_with(|| a.symbol.0.cmp(&b.symbol.0)));
    Ok(ScreenerResult { as_of: api::KstDate(as_of), universe: universe.len() as u32, excluded, rows })
}

fn period_of(period: ScreenPeriod) -> Period {
    match period {
        ScreenPeriod::Day => Period::Day,
        ScreenPeriod::Week => Period::Week,
        ScreenPeriod::Month => Period::Month,
    }
}

fn column(field: BarField) -> &'static str {
    match field {
        BarField::Open => "open",
        BarField::High => "high",
        BarField::Low => "low",
        BarField::Close => "close",
        BarField::Volume => "volume",
    }
}

fn change_rate(close: Price, previous: Price) -> f64 {
    let (close, previous) = (close.centi() as f64, previous.centi() as f64);
    ((close - previous) / previous * 10_000.0).round() / 100.0
}

fn observation_days(tx: &Transaction, as_of: KstDate) -> Result<Vec<KstDate>, StoreError> {
    let mut stmt = tx.prepare("SELECT DISTINCT day FROM daily WHERE day <= ? ORDER BY day")?;
    let mut days = stmt.query_map(params![date_value(as_of)], |row| row.get::<_, i32>(0))?.map(|day| day.map(date_of)).collect::<Result<Vec<_>, _>>()?;
    if days.last() != Some(&as_of) {
        days.push(as_of);
    }
    Ok(days)
}

fn stocks(tx: &Transaction, as_of: KstDate) -> Result<Vec<Stock>, StoreError> {
    let mut stmt = tx.prepare(
        "SELECT listed.code, listed.name, listed.listed_on, listed.excludable_as, coalesce(history.complete, false), earliest.day
         FROM listed LEFT JOIN history USING (code)
         LEFT JOIN (SELECT code, min(day) AS day FROM daily WHERE day <= ? GROUP BY code) AS earliest USING (code)",
    )?;
    let rows = stmt.query_map(params![date_value(as_of)], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i32>>(2)?, row.get::<_, u16>(3)?, row.get::<_, bool>(4)?, row.get::<_, Option<i32>>(5)?))
    })?;
    rows.map(|row| {
        let (code, name, listed_on, excludable_as, complete, first_day) = row?;
        Ok(Stock { code: stock_code(&code)?, name, listed_on: listed_on.map(date_of), excludable_as, complete, first_day: first_day.map(date_of) })
    })
    .collect()
}

fn new_highs(tx: &Transaction, cells: &Cells, reach: &Reach, period: Period, conditions: &[NewHigh], judged: &[(StockCode, Option<Cell>)]) -> Result<Vec<Hit>, StoreError> {
    tx.execute_batch("CREATE TEMP TABLE screen_cells (day DATE NOT NULL, cell BIGINT NOT NULL); CREATE TEMP TABLE screen_stocks (code VARCHAR NOT NULL, start_cell BIGINT);")?;
    {
        let mut appender = tx.appender("screen_cells")?;
        for &(day, cell) in &cells.of_day {
            appender.append_row(params![date_value(day), cell])?;
        }
        appender.flush()?;
        let mut appender = tx.appender("screen_stocks")?;
        for (code, start) in judged {
            appender.append_row(params![code.as_str(), start])?;
        }
        appender.flush()?;
    }
    let mut stmt = tx.prepare(&new_high_query(period, conditions, reach))?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, u64>(2)?, row.get::<_, Option<u64>>(3)?)))?;
    rows.map(|row| {
        let (code, high_cell, close, previous) = row?;
        Ok(Hit { code: stock_code(&code)?, high_cell, close: price_of(close)?, previous_close: previous.map(price_of).transpose()? })
    })
    .collect()
}

fn new_high_query(period: Period, conditions: &[NewHigh], reach: &Reach) -> String {
    let lower = reach.earliest_needed.max(0);
    let from = "FROM daily AS d JOIN screen_cells AS c ON c.day = d.day JOIN screen_stocks AS s ON s.code = d.code";
    let bars = match period {
        Period::Day => format!("SELECT d.code, c.cell, s.start_cell, d.open, d.high, d.low, d.close, d.volume {from} WHERE d.volume > 0 AND c.cell >= {lower}"),
        _ => format!(
            "SELECT d.code, c.cell, any_value(s.start_cell) AS start_cell, arg_min(d.open, d.day) AS open, max(d.high) AS high, min(d.low) AS low,
                    arg_max(d.close, d.day) AS close, sum(d.volume) AS volume
             {from} WHERE d.volume > 0 AND c.cell >= {lower} GROUP BY d.code, c.cell"
        ),
    };
    let hits: Vec<String> = conditions
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let (value, span, recent) = (column(c.field), i64::from(c.n) - 1, first_recent_cell(c, reach.as_of));
            format!(
                "cell >= {recent} AND (start_cell IS NULL OR cell >= start_cell + {span})
                 AND {value} = max({value}) OVER (PARTITION BY code ORDER BY cell RANGE BETWEEN {span} PRECEDING AND CURRENT ROW) AS hit_{i}"
            )
        })
        .collect();
    let every_hit: Vec<String> = (0..conditions.len()).map(|i| format!("bool_or(hit_{i})")).collect();
    format!(
        "WITH bars AS ({bars}),
         judged AS (SELECT code, cell, {hits} FROM bars),
         matched AS (SELECT code, max(cell) FILTER (WHERE hit_0) AS high_cell FROM judged GROUP BY code HAVING {every_hit}),
         traded AS (SELECT d.code, c.cell, d.day, d.close FROM daily AS d JOIN screen_cells AS c ON c.day = d.day JOIN matched AS m ON m.code = d.code WHERE d.volume > 0),
         latest AS (SELECT code, max(cell) AS cell, arg_max(close, day) AS close FROM traded GROUP BY code),
         previous AS (SELECT t.code, arg_max(t.close, t.day) AS close FROM traded AS t JOIN latest AS l ON l.code = t.code WHERE t.cell < l.cell GROUP BY t.code)
         SELECT m.code, m.high_cell, l.close, p.close FROM matched AS m JOIN latest AS l ON l.code = m.code LEFT JOIN previous AS p ON p.code = m.code",
        hits = hits.join(", "),
        every_hit = every_hit.join(" AND "),
    )
}
