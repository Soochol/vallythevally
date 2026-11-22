use std::collections::HashMap;
use std::num::NonZeroU64;
use std::ops::Range;
use std::sync::{Arc, RwLock};

use domain::{KstDate, Period, StockCode};
use duckdb::arrow::array::{AsArray, RecordBatch};
use duckdb::arrow::datatypes::{ArrowPrimitiveType, Date32Type, UInt32Type, UInt64Type};
use duckdb::params;

use super::engine::Cells;
use super::store::{LISTING_LOST, Store, StoreError, date_of, date_value, market_of, stock_code};
use crate::api::{BarField, Market, ScreenPeriod};

const BAR_COLUMNS: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bar {
    pub open: u64,
    pub high: u64,
    pub low: u64,
    pub close: u64,
    pub volume: u64,
    pub traded: u64,
}

impl Bar {
    pub(super) fn field(&self, field: BarField) -> u64 {
        match field {
            BarField::Open => self.open,
            BarField::High => self.high,
            BarField::Low => self.low,
            BarField::Close => self.close,
            BarField::Volume => self.volume,
            BarField::TradedValue => self.traded,
        }
    }
}

struct Total {
    open: u64,
    high: u64,
    low: u64,
    close: u64,
    volume: u128,
    traded: u128,
}

impl Total {
    fn of(bar: &Bar) -> Total {
        Total { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: u128::from(bar.volume), traded: u128::from(bar.traded) }
    }

    fn joined_by(&mut self, later: &Bar) {
        self.high = self.high.max(later.high);
        self.low = self.low.min(later.low);
        self.close = later.close;
        self.volume += u128::from(later.volume);
        self.traded += u128::from(later.traded);
    }

    fn field(&self, field: BarField) -> u128 {
        match field {
            BarField::Open => u128::from(self.open),
            BarField::High => u128::from(self.high),
            BarField::Low => u128::from(self.low),
            BarField::Close => u128::from(self.close),
            BarField::Volume => self.volume,
            BarField::TradedValue => self.traded,
        }
    }
}

pub(super) enum Column {
    Narrow(Vec<u32>),
    Wide(Vec<u64>),
    Widest(Vec<u128>),
}

impl Column {
    fn push(&mut self, value: u128) {
        let widened = match self {
            Column::Widest(values) => {
                values.push(value);
                return;
            }
            Column::Wide(values) => match u64::try_from(value) {
                Ok(wide) => {
                    values.push(wide);
                    return;
                }
                Err(_) => Column::Widest(values.iter().map(|&v| u128::from(v)).chain(std::iter::once(value)).collect()),
            },
            Column::Narrow(values) => match u32::try_from(value) {
                Ok(narrow) => {
                    values.push(narrow);
                    return;
                }
                Err(_) => match u64::try_from(value) {
                    Ok(wide) => Column::Wide(values.iter().map(|&v| u64::from(v)).chain(std::iter::once(wide)).collect()),
                    Err(_) => Column::Widest(values.iter().map(|&v| u128::from(v)).chain(std::iter::once(value)).collect()),
                },
            },
        };
        *self = widened;
    }

    pub(super) fn append_to(&self, range: Range<usize>, into: &mut Vec<u128>) {
        match self {
            Column::Narrow(values) => into.extend(values[range].iter().map(|&v| u128::from(v))),
            Column::Wide(values) => into.extend(values[range].iter().map(|&v| u128::from(v))),
            Column::Widest(values) => into.extend_from_slice(&values[range]),
        }
    }

    pub(super) fn at(&self, at: usize) -> u128 {
        match self {
            Column::Narrow(values) => u128::from(values[at]),
            Column::Wide(values) => u128::from(values[at]),
            Column::Widest(values) => values[at],
        }
    }

    fn shrink(&mut self) {
        match self {
            Column::Narrow(values) => values.shrink_to_fit(),
            Column::Wide(values) => values.shrink_to_fit(),
            Column::Widest(values) => values.shrink_to_fit(),
        }
    }

    fn bytes(&self) -> usize {
        match self {
            Column::Narrow(values) => values.len() * size_of::<u32>(),
            Column::Wide(values) => values.len() * size_of::<u64>(),
            Column::Widest(values) => values.len() * size_of::<u128>(),
        }
    }
}

pub(super) struct PeriodBars {
    offsets: Vec<u32>,
    cells: Vec<u32>,
    columns: [Column; BAR_COLUMNS],
}

impl PeriodBars {
    fn new(stocks: usize) -> PeriodBars {
        let mut offsets = Vec::with_capacity(stocks + 1);
        offsets.push(0);
        PeriodBars { offsets, cells: Vec::new(), columns: std::array::from_fn(|_| Column::Narrow(Vec::new())) }
    }

    fn without_bars(stocks: usize) -> PeriodBars {
        let mut bars = PeriodBars::new(stocks);
        (0..stocks).for_each(|_| bars.end_stock());
        bars
    }

    fn push(&mut self, cell: u32, bar: &Total) {
        self.cells.push(cell);
        for (field, column) in FIELDS.iter().zip(&mut self.columns) {
            column.push(bar.field(*field));
        }
    }

    fn end_stock(&mut self) {
        self.offsets.push(self.cells.len() as u32);
    }

    fn shrink(&mut self) {
        self.cells.shrink_to_fit();
        self.columns.iter_mut().for_each(Column::shrink);
    }

    pub(super) fn range(&self, stock: usize) -> Range<usize> {
        self.offsets[stock] as usize..self.offsets[stock + 1] as usize
    }

    pub(super) fn cells(&self, range: Range<usize>) -> &[u32] {
        &self.cells[range]
    }

    pub(super) fn column(&self, field: BarField) -> &Column {
        &self.columns[field as usize]
    }

    fn bars(&self) -> usize {
        self.cells.len()
    }

    fn bytes(&self) -> usize {
        self.offsets.len() * size_of::<u32>() + self.cells.len() * size_of::<u32>() + self.columns.iter().map(Column::bytes).sum::<usize>()
    }
}

const FIELDS: [BarField; BAR_COLUMNS] = [BarField::Open, BarField::High, BarField::Low, BarField::Close, BarField::Volume, BarField::TradedValue];

struct Aggregation {
    bars: PeriodBars,
    cell_of_day: Vec<u32>,
    pending: Option<(u32, Total)>,
}

impl Aggregation {
    fn new(stocks: usize, cell_of_day: Vec<u32>) -> Aggregation {
        Aggregation { bars: PeriodBars::new(stocks), cell_of_day, pending: None }
    }

    fn add(&mut self, calendar_index: usize, bar: Bar) {
        let cell = self.cell_of_day[calendar_index];
        match &mut self.pending {
            Some((pending_cell, pending)) if *pending_cell == cell => pending.joined_by(&bar),
            _ => {
                self.flush();
                self.pending = Some((cell, Total::of(&bar)));
            }
        }
    }

    fn flush(&mut self) {
        if let Some((cell, bar)) = self.pending.take() {
            self.bars.push(cell, &bar);
        }
    }

    fn end_stock(&mut self) {
        self.flush();
        self.bars.end_stock();
    }
}

pub(super) struct StoredStock {
    pub(super) code: StockCode,
    pub(super) name: String,
    pub(super) listed_on: Option<KstDate>,
    pub(super) excludable_as: u16,
    pub(super) market: Market,
    pub(super) listed_shares: Option<NonZeroU64>,
    pub(super) complete: bool,
    pub(super) refetch: bool,
    pub(super) first_day: Option<KstDate>,
    pub(super) on_last_day: bool,
    pub(super) last_close: Option<u64>,
    pub(super) last_traded_close: Option<u64>,
}

pub struct Edition {
    generation: u64,
    pub(super) last_day: Option<KstDate>,
    pub(super) listing_lost: bool,
    pub(super) refetching: bool,
    pub(super) calendar_days: Vec<KstDate>,
    pub(super) stocks: Vec<StoredStock>,
    index: HashMap<StockCode, usize>,
    day: PeriodBars,
    week: PeriodBars,
    month: PeriodBars,
}

fn primitive<T: ArrowPrimitiveType>(batch: &RecordBatch, k: usize) -> Result<&[T::Native], StoreError> {
    let array = batch.column(k);
    array.as_primitive_opt::<T>().map(|values| values.values().as_ref()).ok_or_else(|| StoreError(format!("봉 열의 {k}번째 열이 {}입니다", array.data_type())))
}

struct Walk {
    stock: usize,
    first_day: Option<KstDate>,
    on_last_day: bool,
    last_close: Option<u64>,
    last_traded_close: Option<u64>,
    calendar_cursor: usize,
}

impl Walk {
    fn at(stock: usize) -> Walk {
        Walk { stock, first_day: None, on_last_day: false, last_close: None, last_traded_close: None, calendar_cursor: 0 }
    }

    fn record_in(&self, stock: &mut StoredStock) {
        stock.first_day = self.first_day;
        stock.on_last_day = self.on_last_day;
        stock.last_close = self.last_close;
        stock.last_traded_close = self.last_traded_close;
    }
}

impl Edition {
    pub fn load(store: &Store) -> Result<Edition, StoreError> {
        let (generation, mut conn) = store.reader_at_generation()?;
        let tx = conn.transaction()?;
        let (last_day, listing_lost, refetching) = tx.query_row(
            &format!("SELECT last_day, {LISTING_LOST}, full_refetch OR EXISTS (SELECT 1 FROM refetch_checks JOIN listed USING (code)) FROM store_meta"),
            [],
            |row| Ok((row.get::<_, Option<i32>>(0)?, row.get::<_, bool>(1)?, row.get::<_, bool>(2)?)),
        )?;
        let last_day = last_day.map(date_of);
        let mut stocks = Self::load_stocks(&tx)?;
        let index = stocks.iter().enumerate().map(|(idx, stock)| (stock.code, idx)).collect();
        let (calendar_days, bars) = match last_day {
            Some(last) => {
                let mut stmt = tx.prepare("SELECT day FROM calendar WHERE day <= ? ORDER BY day")?;
                let days = stmt.query_map(params![date_value(last)], |row| row.get::<_, i32>(0))?.map(|day| day.map(date_of)).collect::<Result<Vec<_>, _>>()?;
                let bars = Self::load_bars(&tx, last, &days, &mut stocks)?;
                (days, bars)
            }
            None => (Vec::new(), std::array::from_fn(|_| PeriodBars::without_bars(stocks.len()))),
        };
        let [day, week, month] = bars;
        Ok(Edition { generation, last_day, listing_lost, refetching, calendar_days, stocks, index, day, week, month })
    }

    fn load_stocks(tx: &duckdb::Transaction) -> Result<Vec<StoredStock>, StoreError> {
        let mut stmt = tx.prepare(
            "SELECT listed.code, listed.name, listed.listed_on, listed.excludable_as, listed.market, listed.listed_shares, coalesce(history.complete, false), coalesce(history.refetch, false)
             FROM listed LEFT JOIN history USING (code) ORDER BY listed.code",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i32>>(2)?,
                row.get::<_, u16>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<u64>>(5)?,
                row.get::<_, bool>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })?;
        rows.map(|row| {
            let (code, name, listed_on, excludable_as, market, listed_shares, complete, refetch) = row?;
            Ok(StoredStock {
                code: stock_code(&code)?,
                name,
                listed_on: listed_on.map(date_of),
                excludable_as,
                market: market_of(&market)?,
                listed_shares: listed_shares.and_then(NonZeroU64::new),
                complete,
                refetch,
                first_day: None,
                on_last_day: false,
                last_close: None,
                last_traded_close: None,
            })
        })
        .collect()
    }

    fn load_bars(tx: &duckdb::Transaction, last_day: KstDate, calendar: &[KstDate], stocks: &mut [StoredStock]) -> Result<[PeriodBars; 3], StoreError> {
        let cell_ids = |period: Period| Cells::new(period, calendar).of_day.iter().map(|&cell| cell as u32).collect::<Vec<u32>>();
        let mut day = Aggregation::new(stocks.len(), (0..calendar.len() as u32).collect());
        let mut week = Aggregation::new(stocks.len(), cell_ids(Period::Week));
        let mut month = Aggregation::new(stocks.len(), cell_ids(Period::Month));
        let rows: u64 = tx.query_row("SELECT count(*) FROM daily WHERE day <= ?", params![date_value(last_day)], |row| row.get(0))?;
        day.bars.cells.reserve(rows as usize);
        let mut stmt = tx.prepare(
            "SELECT s.idx, d.day, d.open, d.high, d.low, d.close, d.volume, d.traded_million_won
             FROM daily AS d JOIN (SELECT code, (row_number() OVER (ORDER BY code) - 1)::UINTEGER AS idx FROM listed) AS s USING (code)
             WHERE d.day <= ? ORDER BY s.idx, d.day",
        )?;
        let mut finished = 0;
        let mut walk: Option<Walk> = None;
        for batch in stmt.query_arrow(params![date_value(last_day)])? {
            let indexes = primitive::<UInt32Type>(&batch, 0)?;
            let days = primitive::<Date32Type>(&batch, 1)?;
            let numbers: Vec<&[u64]> = (2..8).map(|k| primitive::<UInt64Type>(&batch, k)).collect::<Result<_, _>>()?;
            for row in 0..indexes.len() {
                let stock = indexes[row] as usize;
                if walk.as_ref().is_none_or(|w| w.stock != stock) {
                    if let Some(done) = walk.take() {
                        done.record_in(&mut stocks[done.stock]);
                    }
                    while finished < stock {
                        [&mut day, &mut week, &mut month].into_iter().for_each(Aggregation::end_stock);
                        finished += 1;
                    }
                    walk = Some(Walk::at(stock));
                }
                let walking = walk.as_mut().expect("종목을 걷는 중");
                let observed = date_of(days[row]);
                let bar = Bar { open: numbers[0][row], high: numbers[1][row], low: numbers[2][row], close: numbers[3][row], volume: numbers[4][row], traded: numbers[5][row] };
                walking.first_day.get_or_insert(observed);
                walking.on_last_day |= observed == last_day;
                walking.last_close = Some(bar.close);
                if bar.volume > 0 {
                    walking.last_traded_close = Some(bar.close);
                    while calendar.get(walking.calendar_cursor).is_some_and(|d| *d < observed) {
                        walking.calendar_cursor += 1;
                    }
                    if calendar.get(walking.calendar_cursor) == Some(&observed) {
                        day.add(walking.calendar_cursor, bar);
                        week.add(walking.calendar_cursor, bar);
                        month.add(walking.calendar_cursor, bar);
                    }
                }
            }
        }
        if let Some(done) = walk.take() {
            done.record_in(&mut stocks[done.stock]);
        }
        while finished < stocks.len() {
            [&mut day, &mut week, &mut month].into_iter().for_each(Aggregation::end_stock);
            finished += 1;
        }
        let mut bars = [day.bars, week.bars, month.bars];
        bars.iter_mut().for_each(PeriodBars::shrink);
        Ok(bars)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn last_day(&self) -> Option<KstDate> {
        self.last_day
    }

    pub fn bar_count(&self) -> usize {
        self.day.bars()
    }

    pub fn bytes(&self) -> usize {
        let stocks = self.stocks.len() * size_of::<StoredStock>() + self.stocks.iter().map(|s| s.name.len()).sum::<usize>();
        stocks + self.calendar_days.len() * size_of::<KstDate>() + self.day.bytes() + self.week.bytes() + self.month.bytes()
    }

    pub(super) fn bars(&self, period: ScreenPeriod) -> &PeriodBars {
        match period {
            ScreenPeriod::Day => &self.day,
            ScreenPeriod::Week => &self.week,
            ScreenPeriod::Month => &self.month,
        }
    }

    pub(super) fn stock(&self, code: &StockCode) -> Option<&StoredStock> {
        self.index.get(code).map(|&idx| &self.stocks[idx])
    }
}

#[derive(Default)]
pub struct Memory {
    current: RwLock<Option<Arc<Edition>>>,
    loading: tokio::sync::Mutex<Option<u64>>,
}

impl Memory {
    pub fn current(&self) -> Option<Arc<Edition>> {
        self.current.read().expect("메모리 판 잠금").clone()
    }

    pub async fn edition_for(&self, store: &Arc<Store>, generation: u64) -> Result<Arc<Edition>, StoreError> {
        if let Some(edition) = self.current().filter(|e| e.generation >= generation) {
            return Ok(edition);
        }
        let mut failed_generation = self.loading.lock().await;
        if let Some(edition) = self.current().filter(|e| e.generation >= generation) {
            return Ok(edition);
        }
        let previous = self.current();
        if *failed_generation == Some(generation) {
            return previous.ok_or_else(|| StoreError("스크리너 메모리 판을 올리지 못했습니다".into()));
        }
        let from = store.clone();
        let started = std::time::Instant::now();
        let loaded = tokio::task::spawn_blocking(move || Edition::load(&from)).await.map_err(|e| StoreError(format!("메모리 판을 올리는 작업이 끝나지 못했습니다: {e}")))?;
        match loaded {
            Ok(edition) => {
                tracing::info!(generation = edition.generation, stocks = edition.stocks.len(), bars = edition.bar_count(), bytes = edition.bytes(), took_ms = started.elapsed().as_millis() as u64, "스크리너 메모리 판을 올렸습니다");
                let edition = Arc::new(edition);
                *self.current.write().expect("메모리 판 잠금") = Some(edition.clone());
                *failed_generation = None;
                Ok(edition)
            }
            Err(error) => {
                tracing::warn!(%error, generation, kept = previous.as_ref().map(|e| e.generation), "스크리너 메모리 판을 올리지 못했습니다. 이전 판을 쓰고 저장소가 다시 바뀔 때 다시 올립니다");
                *failed_generation = Some(generation);
                previous.ok_or(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use domain::{Ohlcv, Price, Volume};

    use super::*;
    use crate::kiwoom::wire::{MillionWon, ScreenerListing};
    use crate::screener::store::{DayBar, Write};

    fn day(d: u8) -> KstDate {
        KstDate::new(2026, 11, d).unwrap()
    }

    fn stored(through: u8) -> (tempfile::TempDir, Arc<Store>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("screener.duckdb")).unwrap();
        let code = StockCode::parse("300000").unwrap();
        store.replace_listing(&[ScreenerListing { code, name: "가상".into(), listed_on: Some(day(2)), excludable_as: vec![], market: Market::Kospi, listed_shares: NonZeroU64::new(1) }]).unwrap();
        extend(&store, 2..=through);
        (dir, Arc::new(store))
    }

    fn extend(store: &Store, days: std::ops::RangeInclusive<u8>) {
        let code = StockCode::parse("300000").unwrap();
        let price = Price::from_centi(10_000).unwrap();
        let bars: Vec<DayBar> = days.clone().map(|d| DayBar { day: day(d), ohlcv: Ohlcv::try_new(price, price, price, price, Volume(1_000)).unwrap(), traded: MillionWon(1) }).collect();
        store.write(&[Write::Extend { code, bars, reached_origin: false }]).unwrap();
        let calendar: Vec<KstDate> = days.clone().map(day).collect();
        store.extend_calendar(&calendar).unwrap();
        store.set_last_day(day(*days.end())).unwrap();
    }

    #[tokio::test]
    async fn a_run_keeps_the_edition_it_took_while_the_next_generation_loads_beside_it() {
        let (_dir, store) = stored(4);
        let memory = Memory::default();
        let before = store.generation();
        let taken = memory.edition_for(&store, before).await.unwrap();
        assert_eq!((taken.generation(), taken.last_day()), (before, Some(day(4))));
        assert!(Arc::ptr_eq(&taken, &memory.edition_for(&store, before).await.unwrap()), "같은 세대는 같은 판을 다시 쓴다");

        extend(&store, 5..=6);
        let after = store.generation();
        assert!(after > before);
        let next = memory.edition_for(&store, after).await.unwrap();
        assert_eq!((next.generation(), next.last_day()), (after, Some(day(6))));
        assert_eq!((taken.generation(), taken.last_day()), (before, Some(day(4))), "잡고 있던 판은 바뀌지 않는다");
        assert_eq!(taken.bar_count() + 2, next.bar_count());
        assert!(Arc::ptr_eq(&memory.current().unwrap(), &next));
    }

    #[tokio::test]
    async fn a_failed_load_keeps_the_previous_edition_and_the_next_generation_loads_again() {
        let (_dir, store) = stored(4);
        let memory = Memory::default();
        let loaded = memory.edition_for(&store, store.generation()).await.unwrap();

        let (_, conn) = store.reader_at_generation().unwrap();
        conn.execute_batch("UPDATE listed SET market = 'broken'").unwrap();
        extend(&store, 5..=5);
        let broken = store.generation();
        let kept = memory.edition_for(&store, broken).await.unwrap();
        assert!(Arc::ptr_eq(&kept, &loaded), "올리다 실패하면 이전 판을 그대로 쓴다");
        assert!(Arc::ptr_eq(&memory.edition_for(&store, broken).await.unwrap(), &loaded), "같은 세대로는 다시 올리지 않는다");

        conn.execute_batch("UPDATE listed SET market = 'kospi'").unwrap();
        store.set_last_day(day(5)).unwrap();
        let repaired = store.generation();
        let reloaded = memory.edition_for(&store, repaired).await.unwrap();
        assert_eq!((reloaded.generation(), reloaded.last_day()), (repaired, Some(day(5))));
        assert!(!Arc::ptr_eq(&reloaded, &loaded));
    }

    #[tokio::test]
    async fn a_first_load_that_fails_is_an_error_instead_of_an_empty_edition() {
        let (_dir, store) = stored(4);
        let (_, conn) = store.reader_at_generation().unwrap();
        conn.execute_batch("UPDATE listed SET market = 'broken'").unwrap();
        assert!(Memory::default().edition_for(&store, store.generation()).await.is_err());
    }
}
