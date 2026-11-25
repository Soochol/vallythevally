use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use arrow_array::{Array, BooleanArray, Int32Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use domain::StockCode;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::{ArrowWriter, ProjectionMask};
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::properties::WriterProperties;
use serde::Deserialize;
use server::shared_data::{daily_micro_dir, daily_micro_path};

use super::complete::{COMPLETE_FILE_NAME, COMPLETE_FORMAT_VERSION};
use super::merge::into_io;
use super::schema::{RECV_MS_COLUMN, SYMBOL_COLUMN};
use super::store_dir;
use crate::protocol::STOCK_ITEM_SUFFIX;

const TRADE_TYPE: &str = "0B";
const BOOK_TYPE: &str = "0D";
const PROGRAM_TYPE: &str = "0w";
const BROKER_TYPE: &str = "0F";
const VI_TYPE: &str = "1h";

const NXT_ITEM_SUFFIX: &str = "_NX";
const BATCH_ROWS: usize = 16_384;
const PARQUET_ZSTD_LEVEL: i32 = 3;
const WHALE_MIN_WON: i128 = 100_000_000;
const MILLION_WON: i64 = 1_000_000;
const MILLION_WON_I128: i128 = 1_000_000;
const BPS_SCALE: f64 = 10_000.0;
const MAX_BPS: i32 = 10_000;
const SPOOF_DEPTH: usize = 5;
const SPOOF_LEVEL_MIN_WON: i128 = 100_000_000;
const SPOOF_DROP_MIN_WON: i128 = 100_000_000;
const SPOOF_TRADE_WINDOW_MS: i64 = 500;

const ASK_PRICE_COLS: [&str; SPOOF_DEPTH] = ["f41", "f42", "f43", "f44", "f45"];
const BID_PRICE_COLS: [&str; SPOOF_DEPTH] = ["f51", "f52", "f53", "f54", "f55"];
const ASK_QTY_COLS: [&str; SPOOF_DEPTH] = ["f61", "f62", "f63", "f64", "f65"];
const BID_QTY_COLS: [&str; SPOOF_DEPTH] = ["f71", "f72", "f73", "f74", "f75"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyMicroReport {
    pub date: u32,
    pub stocks: usize,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DailyMicroRow {
    pub date: i32,
    pub whale_net_won: i64,
    pub program_net_won: i64,
    pub program_share_bps: i32,
    pub foreign_est_net_qty: i64,
    pub spoof_cancel_rate_bps: i32,
    pub vi_count: i32,
    pub vwap_close_gap_bps: i32,
}

#[derive(Deserialize)]
struct CompleteFile {
    format_version: u32,
    stocks: Vec<CompleteStock>,
}

#[derive(Deserialize)]
struct CompleteStock {
    code: String,
    #[serde(default)]
    registered: bool,
}

#[derive(Clone, Copy)]
struct TradePoint {
    recv_ms: i64,
    price: i64,
    qty: i64,
}

#[derive(Default)]
struct TradeAcc {
    whale_net_won: i128,
    total_traded_won: i128,
    total_volume: i128,
    last_recv_ms: Option<i64>,
    last_price: i64,
    trades: Vec<TradePoint>,
}

impl TradeAcc {
    fn merge(&mut self, other: TradeAcc) {
        self.whale_net_won += other.whale_net_won;
        self.total_traded_won += other.total_traded_won;
        self.total_volume += other.total_volume;
        if let Some(other_ms) = other.last_recv_ms
            && self.last_recv_ms.is_none_or(|current| other_ms >= current)
        {
            self.last_recv_ms = Some(other_ms);
            self.last_price = other.last_price;
        }
        if self.trades.is_empty() {
            self.trades = other.trades;
        } else if !other.trades.is_empty() {
            self.trades.extend(other.trades);
            self.trades.sort_unstable_by_key(|point| point.recv_ms);
        }
    }
}

#[derive(Default, Clone, Copy)]
struct ProgramAcc {
    last_recv_ms: Option<i64>,
    net_million: i64,
    gross_million: i128,
}

impl ProgramAcc {
    fn merge(&mut self, other: ProgramAcc) {
        if let Some(other_ms) = other.last_recv_ms
            && self.last_recv_ms.is_none_or(|current| other_ms >= current)
        {
            *self = other;
        }
    }
}

#[derive(Default, Clone, Copy)]
struct BrokerAcc {
    last_recv_ms: Option<i64>,
    foreign_est_net_qty: i64,
}

impl BrokerAcc {
    fn merge(&mut self, other: BrokerAcc) {
        if let Some(other_ms) = other.last_recv_ms
            && self.last_recv_ms.is_none_or(|current| other_ms >= current)
        {
            *self = other;
        }
    }
}

#[derive(Default, Clone, Copy)]
struct SpoofAcc {
    large_drop_events: u64,
    unmatched_cancel_events: u64,
}

impl SpoofAcc {
    fn merge(&mut self, other: SpoofAcc) {
        self.large_drop_events += other.large_drop_events;
        self.unmatched_cancel_events += other.unmatched_cancel_events;
    }

    fn rate_bps(self) -> i32 {
        if self.large_drop_events == 0 {
            return 0;
        }
        ((self.unmatched_cancel_events as f64 / self.large_drop_events as f64) * BPS_SCALE)
            .round()
            .clamp(0.0, f64::from(MAX_BPS)) as i32
    }
}

#[derive(Clone, Copy)]
struct BookSnapshot {
    recv_ms: i64,
    asks: [(i64, i64); SPOOF_DEPTH],
    bids: [(i64, i64); SPOOF_DEPTH],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StockStream {
    Combined,
    Krx,
    Nxt,
}

struct StreamSlots<T> {
    combined: Option<T>,
    krx: Option<T>,
    nxt: Option<T>,
}

impl<T> Default for StreamSlots<T> {
    fn default() -> Self {
        Self { combined: None, krx: None, nxt: None }
    }
}

impl<T> StreamSlots<T> {
    fn get(&self, stream: StockStream) -> Option<&T> {
        match stream {
            StockStream::Combined => self.combined.as_ref(),
            StockStream::Krx => self.krx.as_ref(),
            StockStream::Nxt => self.nxt.as_ref(),
        }
    }

    fn preferred(&self) -> Option<&T> {
        self.combined.as_ref().or(self.krx.as_ref()).or(self.nxt.as_ref())
    }

    fn get_or_insert_default(&mut self, stream: StockStream) -> &mut T
    where
        T: Default,
    {
        let slot = match stream {
            StockStream::Combined => &mut self.combined,
            StockStream::Krx => &mut self.krx,
            StockStream::Nxt => &mut self.nxt,
        };
        slot.get_or_insert_with(T::default)
    }

    fn merge_with(&mut self, other: Self, mut merge_fn: impl FnMut(&mut T, T)) {
        merge_option(&mut self.combined, other.combined, &mut merge_fn);
        merge_option(&mut self.krx, other.krx, &mut merge_fn);
        merge_option(&mut self.nxt, other.nxt, &mut merge_fn);
    }

    fn into_preferred(self) -> Option<T> {
        self.combined.or(self.krx).or(self.nxt)
    }
}

fn merge_option<T>(dst: &mut Option<T>, src: Option<T>, merge_fn: &mut impl FnMut(&mut T, T)) {
    if let Some(incoming) = src {
        match dst {
            Some(existing) => merge_fn(existing, incoming),
            None => *dst = Some(incoming),
        }
    }
}

fn merge_stream_maps<T>(partials: Vec<HashMap<String, StreamSlots<T>>>, mut merge_fn: impl FnMut(&mut T, T)) -> HashMap<String, StreamSlots<T>> {
    let mut merged: HashMap<String, StreamSlots<T>> = HashMap::new();
    for partial in partials {
        for (symbol, slots) in partial {
            match merged.entry(symbol) {
                Entry::Occupied(mut occupied) => occupied.get_mut().merge_with(slots, &mut merge_fn),
                Entry::Vacant(vacant) => {
                    vacant.insert(slots);
                }
            }
        }
    }
    merged
}

fn resolve_preferred<T>(map: HashMap<String, StreamSlots<T>>) -> HashMap<String, T> {
    map.into_iter().filter_map(|(symbol, slots)| slots.into_preferred().map(|acc| (symbol, acc))).collect()
}

pub fn write_daily_micro(data_dir: &Path, shared_dir: &Path, date: u32, threads: usize) -> io::Result<DailyMicroReport> {
    let day_store = store_dir(data_dir, date);
    let registered = read_registered_stocks(&day_store)?;
    let trade_streams = scan_trades(&day_store, threads)?;
    let programs = scan_programs(&day_store, threads)?;
    let brokers = scan_brokers(&day_store, threads)?;
    let vi_counts = scan_vi(&day_store, threads)?;
    let spoofs = scan_books_for_spoof(&day_store, &trade_streams, threads)?;
    let trades = resolve_preferred(trade_streams);

    let mut symbols: BTreeSet<String> = registered;
    symbols.extend(trades.keys().cloned());
    symbols.extend(programs.keys().cloned());
    symbols.extend(brokers.keys().cloned());
    symbols.extend(vi_counts.keys().cloned());
    symbols.extend(spoofs.keys().cloned());

    let mut rows = BTreeMap::new();
    for symbol in symbols {
        let trade = trades.get(&symbol);
        let program = programs.get(&symbol);
        let broker = brokers.get(&symbol);
        let vi = vi_counts.get(&symbol).copied().unwrap_or(0);
        let spoof = spoofs.get(&symbol).copied().unwrap_or_default();

        let (whale_net_won, total_traded_won, total_volume, last_price) = match trade {
            Some(acc) => (
                acc.whale_net_won.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64,
                acc.total_traded_won,
                acc.total_volume,
                acc.last_price,
            ),
            None => (0, 0, 0, 0),
        };
        let (program_net_won, program_gross_million) = match program {
            Some(acc) => (acc.net_million.saturating_mul(MILLION_WON), acc.gross_million),
            None => (0, 0),
        };
        let program_share_bps = compute_program_share_bps(program_gross_million, total_traded_won);
        let foreign_est_net_qty = broker.map_or(0, |acc| acc.foreign_est_net_qty);
        let spoof_cancel_rate_bps = spoof.rate_bps();
        let vwap_close_gap_bps = compute_vwap_close_gap_bps(total_traded_won, total_volume, last_price);

        rows.insert(
            symbol,
            DailyMicroRow {
                date: date as i32,
                whale_net_won,
                program_net_won,
                program_share_bps,
                foreign_est_net_qty,
                spoof_cancel_rate_bps,
                vi_count: vi.min(i32::MAX as u64) as i32,
                vwap_close_gap_bps,
            },
        );
    }

    let path = write_parquet_atomically(shared_dir, date, &rows)?;
    Ok(DailyMicroReport { date, stocks: rows.len(), path })
}

fn compute_program_share_bps(program_gross_million: i128, total_traded_won: i128) -> i32 {
    if total_traded_won <= 0 || program_gross_million <= 0 {
        return 0;
    }
    let gross_won = program_gross_million.saturating_mul(MILLION_WON_I128);
    ((gross_won as f64 / total_traded_won as f64) * BPS_SCALE)
        .round()
        .clamp(0.0, f64::from(MAX_BPS)) as i32
}

fn compute_vwap_close_gap_bps(total_traded_won: i128, total_volume: i128, last_price: i64) -> i32 {
    if total_volume <= 0 || last_price <= 0 {
        return 0;
    }
    let vwap = total_traded_won as f64 / total_volume as f64;
    if vwap <= 0.0 || !vwap.is_finite() {
        return 0;
    }
    (((last_price as f64 - vwap) / vwap) * BPS_SCALE)
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn parse_stream_symbol(raw: &str) -> Option<(&str, StockStream)> {
    let trimmed = raw.trim();
    let (code, stream) = if let Some(code) = trimmed.strip_suffix(STOCK_ITEM_SUFFIX) {
        (code, StockStream::Combined)
    } else if let Some(code) = trimmed.strip_suffix(NXT_ITEM_SUFFIX) {
        (code, StockStream::Nxt)
    } else {
        (trimmed, StockStream::Krx)
    };
    StockCode::parse(code).ok().map(|_| (code, stream))
}

fn parse_vi_stock_code(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.ends_with(STOCK_ITEM_SUFFIX) {
        return None;
    }
    let stripped = trimmed.strip_suffix(NXT_ITEM_SUFFIX).unwrap_or(trimmed);
    StockCode::parse(stripped).ok().map(|_| stripped)
}

fn is_vi_trigger_frame(releases: Option<&StringArray>, row: usize) -> bool {
    let Some(col) = releases else {
        return true;
    };
    if col.is_null(row) {
        return true;
    }
    matches!(col.value(row).trim(), "" | "000000")
}

fn read_registered_stocks(day_store: &Path) -> io::Result<BTreeSet<String>> {
    let path = day_store.join(COMPLETE_FILE_NAME);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(error) => return Err(error),
    };
    let complete: CompleteFile = serde_json::from_slice(&bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if complete.format_version != COMPLETE_FORMAT_VERSION {
        return Ok(BTreeSet::new());
    }
    Ok(complete
        .stocks
        .into_iter()
        .filter(|stock| stock.registered && StockCode::parse(&stock.code).is_ok())
        .map(|stock| stock.code)
        .collect())
}

fn list_type_files(day_store: &Path, type_code: &str) -> io::Result<Vec<PathBuf>> {
    let folder = day_store.join(type_code);
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(".parquet")) {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn run_parallel<T, F>(files: &[PathBuf], threads: usize, work: F) -> io::Result<Vec<T>>
where
    T: Send,
    F: Fn(&Path) -> io::Result<T> + Sync,
{
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let next = AtomicUsize::new(0);
    let failure: Mutex<Option<io::Error>> = Mutex::new(None);
    let outputs: Mutex<Vec<T>> = Mutex::new(Vec::with_capacity(files.len()));
    let workers = threads.max(1).min(files.len());
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    if failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some() {
                        return;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = files.get(index) else { return };
                    match work(path) {
                        Ok(result) => outputs.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(result),
                        Err(error) => {
                            failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_or_insert(error);
                            return;
                        }
                    }
                }
            });
        }
    });
    if let Some(error) = failure.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner()) {
        return Err(error);
    }
    Ok(outputs.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

fn projected_reader(path: &Path, names: &[&str]) -> io::Result<parquet::arrow::arrow_reader::ParquetRecordBatchReader> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?).map_err(into_io)?;
    let schema = builder.schema();
    let mut roots = Vec::with_capacity(names.len());
    for name in names {
        if let Ok(index) = schema.index_of(name) {
            roots.push(index);
        }
    }
    let mask = ProjectionMask::roots(builder.parquet_schema(), roots);
    builder.with_projection(mask).with_batch_size(BATCH_ROWS).build().map_err(into_io)
}

fn string_col<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a StringArray> {
    batch.column_by_name(name).and_then(|column| column.as_any().downcast_ref::<StringArray>())
}

fn int64_col<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a Int64Array> {
    batch.column_by_name(name).and_then(|column| column.as_any().downcast_ref::<Int64Array>())
}

fn bool_col<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a BooleanArray> {
    batch.column_by_name(name).and_then(|column| column.as_any().downcast_ref::<BooleanArray>())
}

fn scan_trades(day_store: &Path, threads: usize) -> io::Result<HashMap<String, StreamSlots<TradeAcc>>> {
    let files = list_type_files(day_store, TRADE_TYPE)?;
    let partials = run_parallel(&files, threads, scan_trade_bucket)?;
    Ok(merge_stream_maps(partials, TradeAcc::merge))
}

fn scan_trade_bucket(path: &Path) -> io::Result<HashMap<String, StreamSlots<TradeAcc>>> {
    let reader = projected_reader(path, &[SYMBOL_COLUMN, RECV_MS_COLUMN, "f10", "f15", "f15_plus"])?;
    let mut out: HashMap<String, StreamSlots<TradeAcc>> = HashMap::new();
    for batch in reader {
        let batch = batch.map_err(into_io)?;
        let Some(symbols) = string_col(&batch, SYMBOL_COLUMN) else { continue };
        let Some(recvs) = int64_col(&batch, RECV_MS_COLUMN) else { continue };
        let prices = int64_col(&batch, "f10");
        let qtys = int64_col(&batch, "f15");
        let plus_col = bool_col(&batch, "f15_plus");
        let (Some(prices), Some(qtys)) = (prices, qtys) else { continue };
        for row in 0..batch.num_rows() {
            if symbols.is_null(row) || recvs.is_null(row) || prices.is_null(row) || qtys.is_null(row) {
                continue;
            }
            let Some((code, stream)) = parse_stream_symbol(symbols.value(row)) else { continue };
            let price = prices.value(row).saturating_abs();
            let signed_qty = qtys.value(row);
            let qty = signed_qty.saturating_abs();
            if price <= 0 || qty <= 0 {
                continue;
            }
            let recv_ms = recvs.value(row);
            let notional = i128::from(price) * i128::from(qty);
            let slots = match out.get_mut(code) {
                Some(existing) => existing,
                None => out.entry(code.to_owned()).or_default(),
            };
            let acc = slots.get_or_insert_default(stream);
            acc.total_traded_won += notional;
            acc.total_volume += i128::from(qty);
            if notional >= WHALE_MIN_WON {
                if signed_qty < 0 {
                    acc.whale_net_won -= notional;
                } else if plus_col.is_none_or(|col| !col.is_null(row) && col.value(row)) {
                    acc.whale_net_won += notional;
                }
            }
            if acc.last_recv_ms.is_none_or(|last| recv_ms >= last) {
                acc.last_recv_ms = Some(recv_ms);
                acc.last_price = price;
            }
            acc.trades.push(TradePoint { recv_ms, price, qty });
        }
    }
    for slots in out.values_mut() {
        for acc in [&mut slots.combined, &mut slots.krx, &mut slots.nxt].into_iter().flatten() {
            acc.trades.sort_unstable_by_key(|point| point.recv_ms);
        }
    }
    Ok(out)
}

fn scan_programs(day_store: &Path, threads: usize) -> io::Result<HashMap<String, ProgramAcc>> {
    let files = list_type_files(day_store, PROGRAM_TYPE)?;
    let partials = run_parallel(&files, threads, scan_program_bucket)?;
    Ok(resolve_preferred(merge_stream_maps(partials, ProgramAcc::merge)))
}

fn scan_program_bucket(path: &Path) -> io::Result<HashMap<String, StreamSlots<ProgramAcc>>> {
    let reader = projected_reader(path, &[SYMBOL_COLUMN, RECV_MS_COLUMN, "f204", "f208", "f212"])?;
    let mut out: HashMap<String, StreamSlots<ProgramAcc>> = HashMap::new();
    for batch in reader {
        let batch = batch.map_err(into_io)?;
        let Some(symbols) = string_col(&batch, SYMBOL_COLUMN) else { continue };
        let Some(recvs) = int64_col(&batch, RECV_MS_COLUMN) else { continue };
        let sell_col = int64_col(&batch, "f204");
        let buy_col = int64_col(&batch, "f208");
        let net_col = int64_col(&batch, "f212");
        for row in 0..batch.num_rows() {
            if symbols.is_null(row) || recvs.is_null(row) {
                continue;
            }
            let sell = sell_col.filter(|col| !col.is_null(row)).map(|col| col.value(row).saturating_abs());
            let buy = buy_col.filter(|col| !col.is_null(row)).map(|col| col.value(row).saturating_abs());
            let net = net_col.filter(|col| !col.is_null(row)).map(|col| col.value(row));
            if sell.is_none() && buy.is_none() && net.is_none() {
                continue;
            }
            let Some((code, stream)) = parse_stream_symbol(symbols.value(row)) else { continue };
            let recv_ms = recvs.value(row);
            let slots = match out.get_mut(code) {
                Some(existing) => existing,
                None => out.entry(code.to_owned()).or_default(),
            };
            let acc = slots.get_or_insert_default(stream);
            if acc.last_recv_ms.is_none_or(|last| recv_ms >= last) {
                acc.last_recv_ms = Some(recv_ms);
                acc.net_million = net.unwrap_or(0);
                acc.gross_million = i128::from(sell.unwrap_or(0)) + i128::from(buy.unwrap_or(0));
            }
        }
    }
    Ok(out)
}

fn scan_brokers(day_store: &Path, threads: usize) -> io::Result<HashMap<String, BrokerAcc>> {
    let files = list_type_files(day_store, BROKER_TYPE)?;
    let partials = run_parallel(&files, threads, scan_broker_bucket)?;
    Ok(resolve_preferred(merge_stream_maps(partials, BrokerAcc::merge)))
}

fn scan_broker_bucket(path: &Path) -> io::Result<HashMap<String, StreamSlots<BrokerAcc>>> {
    let reader = projected_reader(path, &[SYMBOL_COLUMN, RECV_MS_COLUMN, "f267"])?;
    let mut out: HashMap<String, StreamSlots<BrokerAcc>> = HashMap::new();
    for batch in reader {
        let batch = batch.map_err(into_io)?;
        let Some(symbols) = string_col(&batch, SYMBOL_COLUMN) else { continue };
        let Some(recvs) = int64_col(&batch, RECV_MS_COLUMN) else { continue };
        let Some(foreign_col) = int64_col(&batch, "f267") else { continue };
        for row in 0..batch.num_rows() {
            if symbols.is_null(row) || recvs.is_null(row) || foreign_col.is_null(row) {
                continue;
            }
            let Some((code, stream)) = parse_stream_symbol(symbols.value(row)) else { continue };
            let recv_ms = recvs.value(row);
            let slots = match out.get_mut(code) {
                Some(existing) => existing,
                None => out.entry(code.to_owned()).or_default(),
            };
            let acc = slots.get_or_insert_default(stream);
            if acc.last_recv_ms.is_none_or(|last| recv_ms >= last) {
                acc.last_recv_ms = Some(recv_ms);
                acc.foreign_est_net_qty = foreign_col.value(row);
            }
        }
    }
    Ok(out)
}

fn scan_vi(day_store: &Path, threads: usize) -> io::Result<HashMap<String, u64>> {
    let files = list_type_files(day_store, VI_TYPE)?;
    let partials = run_parallel(&files, threads, scan_vi_bucket)?;
    let mut merged: HashMap<String, u64> = HashMap::new();
    for partial in partials {
        for (symbol, count) in partial {
            *merged.entry(symbol).or_insert(0) += count;
        }
    }
    Ok(merged)
}

fn scan_vi_bucket(path: &Path) -> io::Result<HashMap<String, u64>> {
    let reader = projected_reader(path, &[SYMBOL_COLUMN, "f9068", "f9069", "f1224"])?;
    let mut out: HashMap<String, u64> = HashMap::new();
    for batch in reader {
        let batch = batch.map_err(into_io)?;
        let Some(symbols) = string_col(&batch, SYMBOL_COLUMN) else { continue };
        let Some(kinds) = string_col(&batch, "f9068") else { continue };
        let Some(directions) = string_col(&batch, "f9069") else { continue };
        let releases = string_col(&batch, "f1224");
        for row in 0..batch.num_rows() {
            if symbols.is_null(row) || kinds.is_null(row) || directions.is_null(row) {
                continue;
            }
            if !matches!(kinds.value(row).trim(), "1" | "2" | "3") || !matches!(directions.value(row).trim(), "1" | "2") {
                continue;
            }
            if !is_vi_trigger_frame(releases, row) {
                continue;
            }
            let Some(code) = parse_vi_stock_code(symbols.value(row)) else { continue };
            match out.get_mut(code) {
                Some(count) => *count += 1,
                None => {
                    out.insert(code.to_owned(), 1);
                }
            }
        }
    }
    Ok(out)
}

fn scan_books_for_spoof(day_store: &Path, trades: &HashMap<String, StreamSlots<TradeAcc>>, threads: usize) -> io::Result<HashMap<String, SpoofAcc>> {
    let files = list_type_files(day_store, BOOK_TYPE)?;
    let partials = run_parallel(&files, threads, |path| scan_book_bucket(path, trades))?;
    Ok(resolve_preferred(merge_stream_maps(partials, SpoofAcc::merge)))
}

fn scan_book_bucket(path: &Path, trades: &HashMap<String, StreamSlots<TradeAcc>>) -> io::Result<HashMap<String, StreamSlots<SpoofAcc>>> {
    let mut cols: Vec<&str> = Vec::with_capacity(2 + SPOOF_DEPTH * 4);
    cols.push(SYMBOL_COLUMN);
    cols.push(RECV_MS_COLUMN);
    cols.extend_from_slice(&ASK_PRICE_COLS);
    cols.extend_from_slice(&BID_PRICE_COLS);
    cols.extend_from_slice(&ASK_QTY_COLS);
    cols.extend_from_slice(&BID_QTY_COLS);
    let reader = projected_reader(path, &cols)?;

    let mut out: HashMap<String, StreamSlots<SpoofAcc>> = HashMap::new();
    let mut current_code = String::new();
    let mut current_stream: Option<StockStream> = None;
    let mut prev_book: Option<BookSnapshot> = None;
    let mut trade_cursor = 0usize;
    let mut current_trades: &[TradePoint] = &[];

    for batch in reader {
        let batch = batch.map_err(into_io)?;
        let Some(symbols) = string_col(&batch, SYMBOL_COLUMN) else { continue };
        let Some(recvs) = int64_col(&batch, RECV_MS_COLUMN) else { continue };
        let ask_prices: [Option<&Int64Array>; SPOOF_DEPTH] = std::array::from_fn(|i| int64_col(&batch, ASK_PRICE_COLS[i]));
        let bid_prices: [Option<&Int64Array>; SPOOF_DEPTH] = std::array::from_fn(|i| int64_col(&batch, BID_PRICE_COLS[i]));
        let ask_qtys: [Option<&Int64Array>; SPOOF_DEPTH] = std::array::from_fn(|i| int64_col(&batch, ASK_QTY_COLS[i]));
        let bid_qtys: [Option<&Int64Array>; SPOOF_DEPTH] = std::array::from_fn(|i| int64_col(&batch, BID_QTY_COLS[i]));

        for row in 0..batch.num_rows() {
            if symbols.is_null(row) || recvs.is_null(row) {
                continue;
            }
            let Some((code, stream)) = parse_stream_symbol(symbols.value(row)) else { continue };
            if current_code != code || current_stream != Some(stream) {
                current_code.clear();
                current_code.push_str(code);
                current_stream = Some(stream);
                prev_book = None;
                trade_cursor = 0;
                current_trades = trades
                    .get(code)
                    .and_then(|slots| slots.get(stream).or_else(|| slots.preferred()))
                    .map_or(&[], |acc| acc.trades.as_slice());
            }
            let curr = BookSnapshot {
                recv_ms: recvs.value(row),
                asks: std::array::from_fn(|i| (abs_int(ask_prices[i], row), pos_int(ask_qtys[i], row))),
                bids: std::array::from_fn(|i| (abs_int(bid_prices[i], row), pos_int(bid_qtys[i], row))),
            };
            let acc = out.entry(current_code.clone()).or_default().get_or_insert_default(stream);
            if let Some(prev) = prev_book
                && curr.recv_ms >= prev.recv_ms
            {
                let window_start = prev.recv_ms.saturating_sub(SPOOF_TRADE_WINDOW_MS);
                let window_end = curr.recv_ms.saturating_add(SPOOF_TRADE_WINDOW_MS);
                while trade_cursor < current_trades.len() && current_trades[trade_cursor].recv_ms < window_start {
                    trade_cursor += 1;
                }
                check_side_drops(&prev.asks, &curr.asks, true, current_trades, trade_cursor, window_end, acc);
                check_side_drops(&prev.bids, &curr.bids, false, current_trades, trade_cursor, window_end, acc);
            }
            prev_book = Some(curr);
        }
    }
    Ok(out)
}

fn check_side_drops(
    prev: &[(i64, i64); SPOOF_DEPTH],
    curr: &[(i64, i64); SPOOF_DEPTH],
    is_ask: bool,
    trades: &[TradePoint],
    trade_cursor: usize,
    window_end: i64,
    acc: &mut SpoofAcc,
) {
    let populated = curr.iter().filter(|(price, _)| *price > 0).count();
    let boundary = if populated == SPOOF_DEPTH {
        if is_ask {
            curr.iter().map(|(price, _)| *price).max().unwrap_or(0)
        } else {
            curr.iter().map(|(price, _)| *price).filter(|price| *price > 0).min().unwrap_or(0)
        }
    } else {
        0
    };
    for &(prev_price, prev_qty) in prev {
        if prev_price <= 0 || prev_qty <= 0 {
            continue;
        }
        if i128::from(prev_price) * i128::from(prev_qty) < SPOOF_LEVEL_MIN_WON {
            continue;
        }
        let curr_qty = curr.iter().find(|(price, _)| *price == prev_price).map(|(_, qty)| *qty);
        let drop = match curr_qty {
            Some(qty) => prev_qty.saturating_sub(qty),
            None => {
                let shifted_out = boundary > 0 && if is_ask { prev_price >= boundary } else { prev_price <= boundary };
                if shifted_out { 0 } else { prev_qty }
            }
        };
        if drop <= 0 || i128::from(prev_price) * i128::from(drop) < SPOOF_DROP_MIN_WON {
            continue;
        }
        acc.large_drop_events += 1;
        let mut matched_qty = 0i64;
        for trade in &trades[trade_cursor..] {
            if trade.recv_ms > window_end {
                break;
            }
            if trade.price == prev_price {
                matched_qty = matched_qty.saturating_add(trade.qty);
            }
        }
        if matched_qty.saturating_mul(2) < drop {
            acc.unmatched_cancel_events += 1;
        }
    }
}

fn abs_int(array: Option<&Int64Array>, row: usize) -> i64 {
    array.filter(|values| !values.is_null(row)).map_or(0, |values| values.value(row).saturating_abs())
}

fn pos_int(array: Option<&Int64Array>, row: usize) -> i64 {
    array.filter(|values| !values.is_null(row)).map_or(0, |values| values.value(row).max(0))
}

fn daily_micro_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("date", DataType::Int32, false),
        Field::new("symbol", DataType::Utf8, false),
        Field::new("whale_net_won", DataType::Int64, false),
        Field::new("program_net_won", DataType::Int64, false),
        Field::new("program_share_bps", DataType::Int32, false),
        Field::new("foreign_est_net_qty", DataType::Int64, false),
        Field::new("spoof_cancel_rate_bps", DataType::Int32, false),
        Field::new("vi_count", DataType::Int32, false),
        Field::new("vwap_close_gap_bps", DataType::Int32, false),
    ]))
}

fn write_parquet_atomically(shared_dir: &Path, date: u32, rows: &BTreeMap<String, DailyMicroRow>) -> io::Result<PathBuf> {
    let dir = daily_micro_dir(shared_dir);
    fs::create_dir_all(&dir)?;
    let final_path = daily_micro_path(shared_dir, date);
    let tmp_path = dir.join(format!("{date}.parquet.tmp"));
    let write_result = (|| -> io::Result<()> {
        let schema = daily_micro_schema();
        let count = rows.len();
        let mut dates = Vec::with_capacity(count);
        let mut symbols = Vec::with_capacity(count);
        let mut whale_net = Vec::with_capacity(count);
        let mut program_net = Vec::with_capacity(count);
        let mut program_share = Vec::with_capacity(count);
        let mut foreign_est = Vec::with_capacity(count);
        let mut spoof_cancel = Vec::with_capacity(count);
        let mut vi_counts = Vec::with_capacity(count);
        let mut vwap_gaps = Vec::with_capacity(count);
        for (symbol, row) in rows {
            dates.push(row.date);
            symbols.push(symbol.as_str());
            whale_net.push(row.whale_net_won);
            program_net.push(row.program_net_won);
            program_share.push(row.program_share_bps);
            foreign_est.push(row.foreign_est_net_qty);
            spoof_cancel.push(row.spoof_cancel_rate_bps);
            vi_counts.push(row.vi_count);
            vwap_gaps.push(row.vwap_close_gap_bps);
        }
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int32Array::from(dates)),
                Arc::new(StringArray::from(symbols)),
                Arc::new(Int64Array::from(whale_net)),
                Arc::new(Int64Array::from(program_net)),
                Arc::new(Int32Array::from(program_share)),
                Arc::new(Int64Array::from(foreign_est)),
                Arc::new(Int32Array::from(spoof_cancel)),
                Arc::new(Int32Array::from(vi_counts)),
                Arc::new(Int32Array::from(vwap_gaps)),
            ],
        )
        .map_err(into_io)?;
        let properties = WriterProperties::builder()
            .set_compression(Compression::ZSTD(ZstdLevel::try_new(PARQUET_ZSTD_LEVEL).expect("zstd 수준이 맞다")))
            .build();
        let file = File::create(&tmp_path)?;
        let mut writer = ArrowWriter::try_new(file, schema, Some(properties)).map_err(into_io)?;
        writer.write(&batch).map_err(into_io)?;
        writer.close().map_err(into_io)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    fs::rename(&tmp_path, &final_path)?;
    Ok(final_path)
}
