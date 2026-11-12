use std::collections::HashSet;
use std::fmt;
use std::num::NonZeroU64;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::sync::atomic::{AtomicU64, Ordering};

use domain::{KstDate, Ohlcv, Price, StockCode, Volume};
use duckdb::types::Value;
use duckdb::{Config, Connection, OptionalExt, Transaction, params};

use crate::api::{ExcludeKind, Market};
use crate::kiwoom::wire::{MillionWon, ScreenerListing};

const SCHEMA_VERSION: i32 = 5;
const BEFORE_LISTED_MARKET_AND_SHARES: i32 = 4;

const LISTED: &str = "CREATE TABLE listed (code VARCHAR NOT NULL, name VARCHAR NOT NULL, listed_on DATE, excludable_as USMALLINT NOT NULL, market VARCHAR NOT NULL, listed_shares UBIGINT);";

const SCHEMA: &str = "
CREATE TABLE store_meta (schema_version INTEGER NOT NULL, last_day DATE, full_refetch BOOLEAN NOT NULL);
CREATE TABLE history (code VARCHAR PRIMARY KEY, complete BOOLEAN NOT NULL, refetch BOOLEAN NOT NULL);
CREATE TABLE daily (code VARCHAR NOT NULL, day DATE NOT NULL, open UBIGINT NOT NULL, high UBIGINT NOT NULL, low UBIGINT NOT NULL, close UBIGINT NOT NULL, volume UBIGINT NOT NULL, traded_million_won UBIGINT NOT NULL);
CREATE TABLE calendar (day DATE PRIMARY KEY);
";

pub(super) const LISTING_LOST: &str = "NOT EXISTS (SELECT 1 FROM listed) AND EXISTS (SELECT 1 FROM daily)";

const UNCONFIRMED_ON: &str = "SELECT code FROM listed WHERE NOT coalesce(listed_on > $1, false) AND code NOT IN (SELECT code FROM daily WHERE day = $1)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

impl From<duckdb::Error> for StoreError {
    fn from(e: duckdb::Error) -> Self {
        StoreError(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayBar {
    pub day: KstDate,
    pub ohlcv: Ohlcv,
    pub traded: MillionWon,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tail {
    pub code: StockCode,
    pub listed_on: Option<KstDate>,
    pub last: Option<(KstDate, Price)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub last_day: Option<KstDate>,
    pub listed: u32,
    pub complete: u32,
    pub unconfirmed: u32,
    pub listing_lost: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listed {
    Present,
    Filled,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Write {
    Extend { code: StockCode, bars: Vec<DayBar>, reached_origin: bool },
    Replace { code: StockCode, bars: Vec<DayBar> },
}

impl Write {
    pub fn last_day(&self) -> Option<KstDate> {
        match self {
            Write::Extend { bars, .. } | Write::Replace { bars, .. } => bars.last().map(|b| b.day),
        }
    }
}

pub(super) fn unconfirmed_on(conn: &Connection, day: KstDate) -> Result<HashSet<StockCode>, StoreError> {
    let mut stmt = conn.prepare(UNCONFIRMED_ON)?;
    let rows = stmt.query_map(params![date_value(day)], |row| row.get::<_, String>(0))?;
    rows.map(|code| stock_code(&code?)).collect()
}

pub(super) fn exclusion_mask(kinds: &[ExcludeKind]) -> u16 {
    kinds.iter().fold(0, |mask, kind| mask | 1 << *kind as u16)
}

pub struct Store {
    conn: Mutex<Connection>,
    generation: AtomicU64,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| StoreError(format!("{}를 만들 수 없습니다: {e}", dir.display())))?;
        }
        let conn = connect(path)?;
        let conn = match stored_version(&conn)? {
            Some(SCHEMA_VERSION) => conn,
            Some(BEFORE_LISTED_MARKET_AND_SHARES) => {
                tracing::info!(path = %path.display(), from = BEFORE_LISTED_MARKET_AND_SHARES, to = SCHEMA_VERSION, "스크리너 저장소를 올립니다. 종목 목록 표만 다시 만들고 일봉·이력 상태·관측일 달력·저장소 상태는 그대로 둡니다");
                rebuild_listed(conn)?
            }
            Some(other) => {
                tracing::warn!(path = %path.display(), stored = other, expected = SCHEMA_VERSION, "스크리너 저장소의 스키마 버전이 달라 지우고 빈 저장소로 시작합니다");
                drop(conn);
                for file in [path.to_path_buf(), path.with_extension(wal_extension(path))] {
                    match std::fs::remove_file(&file) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(StoreError(format!("{}를 지울 수 없습니다: {e}", file.display()))),
                        _ => {}
                    }
                }
                create(connect(path)?)?
            }
            None if table_count(&conn)? == 0 => create(conn)?,
            None => return Err(StoreError(format!("{}는 스크리너 저장소가 아닌 DuckDB 파일입니다. VALLY_SCREENER_DB_PATH를 다른 경로로 주세요", path.display()))),
        };
        Ok(Store { conn: Mutex::new(conn), generation: AtomicU64::new(0) })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("스크리너 저장소 잠금")
    }

    pub(super) fn generation(&self) -> u64 {
        let _conn = self.conn();
        self.generation.load(Ordering::SeqCst)
    }

    pub(super) fn collection_targets(&self) -> Result<(u64, Vec<StockCode>), StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT code FROM listed ORDER BY code")?;
        let codes = stmt.query_map([], |row| row.get::<_, String>(0))?.map(|row| stock_code(&row?)).collect::<Result<Vec<_>, _>>()?;
        Ok((self.generation.load(Ordering::SeqCst), codes))
    }

    pub(super) fn reader(&self) -> Result<Connection, StoreError> {
        Ok(self.conn().try_clone()?)
    }

    pub fn summary(&self) -> Result<Summary, StoreError> {
        let conn = self.conn();
        let last_day = conn.query_row("SELECT last_day FROM store_meta", [], |row| row.get::<_, Option<i32>>(0))?.map(date_of);
        let (listed, complete, unconfirmed) = conn.query_row(
            &format!(
                "SELECT count(*) FILTER (WHERE NOT unconfirmed), count(*) FILTER (WHERE complete AND NOT unconfirmed), count(*) FILTER (WHERE unconfirmed)
                 FROM (SELECT coalesce(history.complete, false) AS complete, $1 IS NOT NULL AND listed.code IN ({UNCONFIRMED_ON}) AS unconfirmed
                       FROM listed LEFT JOIN history USING (code))"
            ),
            params![last_day.map_or(Value::Null, date_value)],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)),
        )?;
        let listing_lost = conn.query_row(&format!("SELECT {LISTING_LOST}"), [], |row| row.get(0))?;
        Ok(Summary { last_day, listed, complete, unconfirmed, listing_lost })
    }

    pub fn replace_listing(&self, listing: &[ScreenerListing]) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM listed", [])?;
        append_listing(&tx, listing)?;
        tx.commit()?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn listing_lost(&self) -> Result<bool, StoreError> {
        Ok(self.conn().query_row(&format!("SELECT {LISTING_LOST}"), [], |row| row.get(0))?)
    }

    pub fn fill_lost_listing(&self, listing: &[ScreenerListing]) -> Result<Listed, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let lost: bool = tx.query_row(&format!("SELECT {LISTING_LOST}"), [], |row| row.get(0))?;
        let listed = match (lost, listing.is_empty()) {
            (false, _) => Listed::Present,
            (true, true) => Listed::Lost,
            (true, false) => {
                append_listing(&tx, listing)?;
                Listed::Filled
            }
        };
        tx.commit()?;
        if listed == Listed::Filled {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        Ok(listed)
    }

    pub fn tails(&self) -> Result<Vec<Tail>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT listed.code, listed.listed_on, last.day, last.close FROM listed
             LEFT JOIN (SELECT code, max(day) AS day, arg_max(close, day) AS close FROM daily GROUP BY code) AS last USING (code)
             ORDER BY listed.code",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?, row.get::<_, Option<i32>>(2)?, row.get::<_, Option<u64>>(3)?)))?;
        rows.map(|row| {
            let (code, listed_on, day, close) = row?;
            let last = match (day, close) {
                (Some(day), Some(close)) => Some((date_of(day), price_of(close)?)),
                _ => None,
            };
            Ok(Tail { code: stock_code(&code)?, listed_on: listed_on.map(date_of), last })
        })
        .collect()
    }

    pub fn bars_from(&self, code: StockCode, from: KstDate) -> Result<Vec<DayBar>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT day, open, high, low, close, volume, traded_million_won FROM daily WHERE code = ? AND day >= ? ORDER BY day")?;
        let rows = stmt.query_map(params![code.as_str(), date_value(from)], |row| {
            Ok((row.get::<_, i32>(0)?, [row.get::<_, u64>(1)?, row.get(2)?, row.get(3)?, row.get(4)?], row.get::<_, u64>(5)?, row.get::<_, u64>(6)?))
        })?;
        rows.map(|row| {
            let (day, [o, h, l, c], v, traded) = row?;
            let ohlcv = Ohlcv::try_new(price_of(o)?, price_of(h)?, price_of(l)?, price_of(c)?, Volume(v)).map_err(|e| StoreError(format!("저장된 봉이 틀렸습니다({code:?}): {e}")))?;
            Ok(DayBar { day: date_of(day), ohlcv, traded: MillionWon(traded) })
        })
        .collect()
    }

    pub fn write(&self, writes: &[Write]) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for w in writes {
            let (code, bars) = match w {
                Write::Extend { code, bars, reached_origin } => {
                    if let Some(first) = bars.first() {
                        tx.execute("DELETE FROM daily WHERE code = ? AND day >= ?", params![code.as_str(), date_value(first.day)])?;
                    }
                    tx.execute(
                        "INSERT INTO history VALUES (?, ?, false) ON CONFLICT (code) DO UPDATE SET complete = history.complete OR excluded.complete",
                        params![code.as_str(), reached_origin],
                    )?;
                    (code, bars)
                }
                Write::Replace { code, bars } => {
                    tx.execute("DELETE FROM daily WHERE code = ?", params![code.as_str()])?;
                    tx.execute("INSERT INTO history VALUES (?, true, false) ON CONFLICT (code) DO UPDATE SET complete = true, refetch = false", params![code.as_str()])?;
                    (code, bars)
                }
            };
            let mut appender = tx.appender("daily")?;
            for b in bars {
                let o = &b.ohlcv;
                appender.append_row(params![code.as_str(), date_value(b.day), o.open().centi(), o.high().centi(), o.low().centi(), o.close().centi(), o.volume().0, b.traded.0])?;
            }
            appender.flush()?;
        }
        tx.commit()?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn calendar_last_day(&self) -> Result<Option<KstDate>, StoreError> {
        Ok(self.conn().query_row("SELECT max(day) FROM calendar", [], |row| row.get::<_, Option<i32>>(0))?.map(date_of))
    }

    pub fn extend_calendar(&self, days: &[KstDate]) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut appender = tx.appender("calendar")?;
            for &day in days {
                appender.append_row(params![date_value(day)])?;
            }
            appender.flush()?;
        }
        tx.commit()?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn set_last_day(&self, day: KstDate) -> Result<(), StoreError> {
        let conn = self.conn();
        conn.execute("UPDATE store_meta SET last_day = ?", params![date_value(day)])?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn mark_refetch(&self) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let running: bool = tx.query_row("SELECT full_refetch FROM store_meta", [], |row| row.get(0))?;
        if !running {
            tx.execute("INSERT INTO history SELECT DISTINCT code, false, true FROM listed ON CONFLICT (code) DO UPDATE SET refetch = true", [])?;
            tx.execute("UPDATE store_meta SET full_refetch = true", [])?;
        }
        tx.commit()?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn end_full_refetch(&self) -> Result<(), StoreError> {
        let conn = self.conn();
        conn.execute("UPDATE store_meta SET full_refetch = false", [])?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn backfill_queue(&self, target: KstDate) -> Result<Vec<StockCode>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT listed.code FROM listed LEFT JOIN history USING (code)
             WHERE (NOT coalesce(history.complete, false) OR coalesce(history.refetch, false)) AND listed.code IN (SELECT code FROM daily WHERE day = ?)
             ORDER BY listed.code",
        )?;
        let rows = stmt.query_map(params![date_value(target)], |row| row.get::<_, String>(0))?;
        rows.map(|code| stock_code(&code?)).collect()
    }
}

fn connect(path: &Path) -> Result<Connection, StoreError> {
    let config = Config::default().enable_autoload_extension(false)?;
    Connection::open_with_flags(path, config).map_err(|e| StoreError(format!("{}를 DuckDB로 열 수 없습니다: {e}", path.display())))
}

fn wal_extension(path: &Path) -> String {
    match path.extension() {
        Some(ext) => format!("{}.wal", ext.to_string_lossy()),
        None => "wal".into(),
    }
}

fn table_count(conn: &Connection) -> Result<u32, StoreError> {
    Ok(conn.query_row("SELECT count(*) FROM duckdb_tables()", [], |row| row.get(0))?)
}

fn stored_version(conn: &Connection) -> Result<Option<i32>, StoreError> {
    let has_meta: u32 = conn.query_row("SELECT count(*) FROM duckdb_tables() WHERE table_name = 'store_meta'", [], |row| row.get(0))?;
    if has_meta == 0 {
        return Ok(None);
    }
    Ok(conn.query_row("SELECT schema_version FROM store_meta", [], |row| row.get::<_, i32>(0)).optional()?.or(Some(0)))
}

fn create(mut conn: Connection) -> Result<Connection, StoreError> {
    let tx = conn.transaction()?;
    tx.execute_batch(SCHEMA)?;
    tx.execute_batch(LISTED)?;
    tx.execute("INSERT INTO store_meta VALUES (?, NULL, false)", params![SCHEMA_VERSION])?;
    tx.commit()?;
    Ok(conn)
}

fn rebuild_listed(mut conn: Connection) -> Result<Connection, StoreError> {
    let tx = conn.transaction()?;
    tx.execute_batch("DROP TABLE listed")?;
    tx.execute_batch(LISTED)?;
    tx.execute("UPDATE store_meta SET schema_version = ?", params![SCHEMA_VERSION])?;
    tx.commit()?;
    Ok(conn)
}

fn append_listing(tx: &Transaction, listing: &[ScreenerListing]) -> Result<(), StoreError> {
    let mut seen = HashSet::new();
    let mut appender = tx.appender("listed")?;
    for stock in listing.iter().filter(|s| seen.insert(s.code)) {
        let listed_on = stock.listed_on.map_or(Value::Null, date_value);
        let listed_shares = stock.listed_shares.map(NonZeroU64::get);
        appender.append_row(params![stock.code.as_str(), stock.name, listed_on, exclusion_mask(&stock.excludable_as), market_name(stock.market), listed_shares])?;
    }
    appender.flush()?;
    Ok(())
}

fn market_name(market: Market) -> &'static str {
    match market {
        Market::Kospi => "kospi",
        Market::Kosdaq => "kosdaq",
    }
}

pub(super) fn market_of(name: &str) -> Result<Market, StoreError> {
    match name {
        "kospi" => Ok(Market::Kospi),
        "kosdaq" => Ok(Market::Kosdaq),
        other => Err(StoreError(format!("저장된 시장이 틀렸습니다: {other:?}"))),
    }
}

pub(super) fn date_value(day: KstDate) -> Value {
    Value::Date32(day.days_since_epoch() as i32)
}

pub(super) fn date_of(days: i32) -> KstDate {
    KstDate::from_days_since_epoch(i64::from(days))
}

pub(super) fn price_of(centi: u64) -> Result<Price, StoreError> {
    Price::from_centi(centi).ok_or_else(|| StoreError("저장된 가격이 0입니다".into()))
}

pub(super) fn stock_code(code: &str) -> Result<StockCode, StoreError> {
    StockCode::parse(code).map_err(|e| StoreError(format!("저장된 종목코드가 틀렸습니다: {e}")))
}

#[cfg(test)]
mod generation_tests {
    use super::*;

    #[test]
    fn same_day_rewrites_listing_calendar_and_refetch_changes_advance_the_generation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("screener.duckdb")).unwrap();
        let day = KstDate::new(2026, 11, 6).unwrap();
        let code = StockCode::parse("300000").unwrap();
        let listed = ScreenerListing { code, name: "가상".into(), listed_on: Some(day), excludable_as: vec![], market: Market::Kospi, listed_shares: NonZeroU64::new(1_000_000) };
        let mut generation = store.generation();
        let mut changed = || {
            let next = store.generation();
            assert!(next > generation);
            generation = next;
        };
        store.replace_listing(std::slice::from_ref(&listed)).unwrap(); changed();
        store.replace_listing(&[listed]).unwrap(); changed();
        store.extend_calendar(&[day]).unwrap(); changed();
        store.set_last_day(day).unwrap(); changed();
        for won in [100, 110] {
            let price = Price::from_centi(won * 100).unwrap();
            let bar = DayBar { day, ohlcv: Ohlcv::try_new(price, price, price, price, Volume(1000)).unwrap(), traded: MillionWon(1) };
            store.write(&[Write::Replace { code, bars: vec![bar] }]).unwrap(); changed();
            assert_eq!(store.summary().unwrap().last_day, Some(day));
        }
        store.mark_refetch().unwrap(); changed();
        store.end_full_refetch().unwrap(); changed();
        let (captured, codes) = store.collection_targets().unwrap();
        assert_eq!(captured, store.generation());
        assert_eq!(codes, [code]);
    }
}
