use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use arrow_array::{Array, Int64Array, RecordBatch, StringArray};
use domain::StockCode;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde::Deserialize;
use server::shared_data::{
    BOOK_DEPTH, BookLevel, BookRow, ClosedQuotes, QuoteMinute, QuoteMinuteBuilder, closed_day_dir, live_day_dir, write_closed_quotes,
};

use super::complete::{COMPLETE_FILE_NAME, COMPLETE_FORMAT_VERSION, REPLACED_SUFFIX};
use super::merge::into_io;
use super::schema::SYMBOL_COLUMN;
use super::store_dir;
use crate::calendar::Day;
use crate::protocol::STOCK_ITEM_SUFFIX;

const BOOK_TYPE: &str = "0D";
const STORE_FOLDER: &str = "store";
const TIME_COLUMN: &str = "f21";
const BATCH_ROWS: usize = 16_384;
const DATE_FOLDER_LEN: usize = 8;
const SECONDS_PER_DAY: i64 = 86_400;

const ASK_PRICE_COLS: [&str; BOOK_DEPTH] = ["f41", "f42", "f43", "f44", "f45", "f46", "f47", "f48", "f49", "f50"];
const BID_PRICE_COLS: [&str; BOOK_DEPTH] = ["f51", "f52", "f53", "f54", "f55", "f56", "f57", "f58", "f59", "f60"];
const COMBINED_ASK_COLS: [&str; BOOK_DEPTH] = ["f61", "f62", "f63", "f64", "f65", "f66", "f67", "f68", "f69", "f70"];
const COMBINED_BID_COLS: [&str; BOOK_DEPTH] = ["f71", "f72", "f73", "f74", "f75", "f76", "f77", "f78", "f79", "f80"];
const KRX_ASK_COLS: [&str; BOOK_DEPTH] = ["f6044", "f6045", "f6046", "f6047", "f6048", "f6049", "f6050", "f6051", "f6052", "f6053"];
const KRX_BID_COLS: [&str; BOOK_DEPTH] = ["f6054", "f6055", "f6056", "f6057", "f6058", "f6059", "f6060", "f6061", "f6062", "f6063"];
const NXT_ASK_COLS: [&str; BOOK_DEPTH] = ["f6066", "f6067", "f6068", "f6069", "f6070", "f6071", "f6072", "f6073", "f6074", "f6075"];
const NXT_BID_COLS: [&str; BOOK_DEPTH] = ["f6076", "f6077", "f6078", "f6079", "f6080", "f6081", "f6082", "f6083", "f6084", "f6085"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotesReport {
    pub date: u32,
    pub stocks: usize,
    pub minutes: usize,
}

#[derive(Deserialize)]
struct CompleteStocks {
    format_version: u32,
    verify: CompleteVerify,
    stocks: Vec<CompleteStock>,
}

#[derive(Deserialize)]
struct CompleteVerify {
    passed: bool,
}

#[derive(Deserialize)]
struct CompleteStock {
    code: String,
    #[serde(default)]
    registered: bool,
    #[serde(default)]
    gaps: Vec<CompleteGap>,
}

#[derive(Deserialize)]
struct CompleteGap {
    from_ms: i64,
    to_ms: i64,
}

struct DayMetadata {
    registered: BTreeSet<String>,
    gaps: HashMap<String, Vec<(u32, u32)>>,
}

struct BatchColumns<'a> {
    symbols: &'a StringArray,
    times: Option<&'a StringArray>,
    ask_prices: [Option<&'a Int64Array>; BOOK_DEPTH],
    bid_prices: [Option<&'a Int64Array>; BOOK_DEPTH],
    combined_asks: [Option<&'a Int64Array>; BOOK_DEPTH],
    combined_bids: [Option<&'a Int64Array>; BOOK_DEPTH],
    krx_asks: [Option<&'a Int64Array>; BOOK_DEPTH],
    krx_bids: [Option<&'a Int64Array>; BOOK_DEPTH],
    nxt_asks: [Option<&'a Int64Array>; BOOK_DEPTH],
    nxt_bids: [Option<&'a Int64Array>; BOOK_DEPTH],
}

pub fn missing_closed_quote_days(data_dir: &Path, shared_dir: &Path) -> io::Result<Vec<u32>> {
    Ok(complete_days(data_dir)?
        .into_iter()
        .filter(|candidate| !closed_day_dir(shared_dir, &candidate.to_string()).is_dir())
        .collect())
}

pub fn fill_missing_closed_days(data_dir: &Path, shared_dir: &Path, threads: usize) -> io::Result<Vec<QuotesReport>> {
    let targets = missing_closed_quote_days(data_dir, shared_dir)?;
    write_closed_targets(data_dir, shared_dir, targets, threads)
}

pub fn fill_closed_days(data_dir: &Path, shared_dir: &Path, date: u32, threads: usize) -> io::Result<Vec<QuotesReport>> {
    let candidates = complete_days(data_dir)?;
    let mut targets = Vec::new();
    if candidates.contains(&date) {
        targets.push(date);
    }
    for candidate in candidates {
        if candidate != date && !closed_day_dir(shared_dir, &candidate.to_string()).is_dir() {
            targets.push(candidate);
        }
    }
    write_closed_targets(data_dir, shared_dir, targets, threads)
}

fn write_closed_targets(data_dir: &Path, shared_dir: &Path, targets: Vec<u32>, threads: usize) -> io::Result<Vec<QuotesReport>> {
    let mut reports = Vec::new();
    let mut failures = Vec::new();
    for target in targets {
        match write_closed_day(data_dir, shared_dir, target, threads) {
            Ok(report) => reports.push(report),
            Err(error) => failures.push(format!("{target}: {error}")),
        }
    }
    if failures.is_empty() {
        Ok(reports)
    } else {
        Err(io::Error::other(failures.join("; ")))
    }
}

pub fn write_closed_day(data_dir: &Path, shared_dir: &Path, date: u32, threads: usize) -> io::Result<QuotesReport> {
    let metadata = read_day_metadata(data_dir, date)?;
    let date_text = date.to_string();
    let tmp_dir = closed_day_dir(shared_dir, &format!("{date_text}.tmp"));
    remove_if_exists(&tmp_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let result = build_day_in_tmp(data_dir, &tmp_dir, &date_text, date, threads, &metadata);
    let (stocks, minutes) = match result {
        Ok(counts) => counts,
        Err(error) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(error);
        }
    };

    publish_closed_day(shared_dir, &date_text, &tmp_dir)?;
    remove_if_exists(&live_day_dir(shared_dir, &date_text))?;
    Ok(QuotesReport { date, stocks, minutes })
}

fn build_day_in_tmp(
    data_dir: &Path,
    tmp_dir: &Path,
    date_text: &str,
    date: u32,
    threads: usize,
    metadata: &DayMetadata,
) -> io::Result<(usize, usize)> {
    let files = list_book_files(data_dir, date)?;
    let next = AtomicUsize::new(0);
    let total_minutes = AtomicUsize::new(0);
    let failure: Mutex<Option<io::Error>> = Mutex::new(None);
    let written: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    let workers = threads.max(1).min(files.len().max(1));

    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    if failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some() {
                        return;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(index) else { return };
                    match process_bucket(file, tmp_dir, date_text, &metadata.gaps) {
                        Ok((codes, minutes)) => {
                            written.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).extend(codes);
                            total_minutes.fetch_add(minutes, Ordering::Relaxed);
                        }
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

    let mut written_codes = written.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
    for code in &metadata.registered {
        if !written_codes.contains(code) {
            let gaps = metadata.gaps.get(code).cloned().unwrap_or_default();
            write_closed_quotes(tmp_dir, date_text, code, &ClosedQuotes { minutes: Vec::new(), gaps })?;
            written_codes.insert(code.clone());
        }
    }
    Ok((written_codes.len(), total_minutes.load(Ordering::Relaxed)))
}

fn process_bucket(
    path: &Path,
    tmp_dir: &Path,
    date_text: &str,
    gaps_by_code: &HashMap<String, Vec<(u32, u32)>>,
) -> io::Result<(Vec<String>, usize)> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?).map_err(into_io)?;
    let mask = projection_mask(&builder)?;
    let reader = builder.with_projection(mask).with_batch_size(BATCH_ROWS).build().map_err(into_io)?;

    let mut current_code: Option<String> = None;
    let mut builders: BTreeMap<u16, QuoteMinuteBuilder> = BTreeMap::new();
    let mut written_codes = Vec::new();
    let mut total_minutes = 0usize;

    for batch in reader {
        let batch = batch.map_err(into_io)?;
        let columns = extract_columns(&batch)?;
        for row in 0..batch.num_rows() {
            if columns.symbols.is_null(row) {
                continue;
            }
            let symbol = columns.symbols.value(row);
            let Some(code) = symbol.strip_suffix(STOCK_ITEM_SUFFIX).filter(|code| StockCode::parse(code).is_ok()) else {
                continue;
            };
            if current_code.as_deref() != Some(code)
                && let Some(previous) = current_code.replace(code.to_owned())
            {
                total_minutes += flush_stock(tmp_dir, date_text, &previous, &mut builders, gaps_by_code)?;
                written_codes.push(previous);
            }
            let Some(sec) = columns.times.and_then(|array| (!array.is_null(row)).then(|| array.value(row))).and_then(parse_hhmmss) else {
                continue;
            };
            let book = build_book_row(&columns, row, sec);
            let minute = book.minute();
            builders.entry(minute).or_insert_with(|| QuoteMinuteBuilder::new(minute)).take(&book);
        }
    }
    if let Some(previous) = current_code {
        total_minutes += flush_stock(tmp_dir, date_text, &previous, &mut builders, gaps_by_code)?;
        written_codes.push(previous);
    }
    Ok((written_codes, total_minutes))
}

fn flush_stock(
    tmp_dir: &Path,
    date_text: &str,
    code: &str,
    builders: &mut BTreeMap<u16, QuoteMinuteBuilder>,
    gaps_by_code: &HashMap<String, Vec<(u32, u32)>>,
) -> io::Result<usize> {
    let minutes: Vec<QuoteMinute> = std::mem::take(builders).into_values().filter_map(|builder| builder.finish()).collect();
    let count = minutes.len();
    let gaps = gaps_by_code.get(code).cloned().unwrap_or_default();
    write_closed_quotes(tmp_dir, date_text, code, &ClosedQuotes { minutes, gaps })?;
    Ok(count)
}

fn projection_mask(builder: &ParquetRecordBatchReaderBuilder<File>) -> io::Result<ProjectionMask> {
    let schema = builder.schema();
    let symbol_index = schema.index_of(SYMBOL_COLUMN).map_err(into_io)?;
    let mut roots = vec![symbol_index];
    if let Ok(index) = schema.index_of(TIME_COLUMN) {
        roots.push(index);
    }
    for group in [
        &ASK_PRICE_COLS,
        &BID_PRICE_COLS,
        &COMBINED_ASK_COLS,
        &COMBINED_BID_COLS,
        &KRX_ASK_COLS,
        &KRX_BID_COLS,
        &NXT_ASK_COLS,
        &NXT_BID_COLS,
    ] {
        for name in group {
            if let Ok(index) = schema.index_of(name) {
                roots.push(index);
            }
        }
    }
    Ok(ProjectionMask::roots(builder.parquet_schema(), roots))
}

fn extract_columns(batch: &RecordBatch) -> io::Result<BatchColumns<'_>> {
    let symbols = batch
        .column_by_name(SYMBOL_COLUMN)
        .and_then(|column| column.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| io::Error::other("symbol 열을 읽을 수 없다"))?;
    let times = batch.column_by_name(TIME_COLUMN).and_then(|column| column.as_any().downcast_ref::<StringArray>());
    let ints = |names: &[&str; BOOK_DEPTH]| -> [Option<&Int64Array>; BOOK_DEPTH] {
        std::array::from_fn(|index| batch.column_by_name(names[index]).and_then(|column| column.as_any().downcast_ref::<Int64Array>()))
    };
    Ok(BatchColumns {
        symbols,
        times,
        ask_prices: ints(&ASK_PRICE_COLS),
        bid_prices: ints(&BID_PRICE_COLS),
        combined_asks: ints(&COMBINED_ASK_COLS),
        combined_bids: ints(&COMBINED_BID_COLS),
        krx_asks: ints(&KRX_ASK_COLS),
        krx_bids: ints(&KRX_BID_COLS),
        nxt_asks: ints(&NXT_ASK_COLS),
        nxt_bids: ints(&NXT_BID_COLS),
    })
}

fn build_book_row(columns: &BatchColumns<'_>, row: usize, sec: u32) -> BookRow {
    let asks = std::array::from_fn(|index| BookLevel {
        price: price_at(columns.ask_prices[index], row),
        combined: qty_at(columns.combined_asks[index], row),
        krx: qty_at(columns.krx_asks[index], row),
        nxt: qty_at(columns.nxt_asks[index], row),
    });
    let bids = std::array::from_fn(|index| BookLevel {
        price: price_at(columns.bid_prices[index], row),
        combined: qty_at(columns.combined_bids[index], row),
        krx: qty_at(columns.krx_bids[index], row),
        nxt: qty_at(columns.nxt_bids[index], row),
    });
    BookRow { sec, asks, bids }
}

fn price_at(array: Option<&Int64Array>, row: usize) -> i64 {
    array.filter(|values| !values.is_null(row)).map_or(0, |values| values.value(row).saturating_abs())
}

fn qty_at(array: Option<&Int64Array>, row: usize) -> i64 {
    array.filter(|values| !values.is_null(row)).map_or(0, |values| values.value(row).max(0))
}

fn parse_hhmmss(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    if bytes.len() != 6 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let hour: u32 = text[0..2].parse().ok()?;
    let minute: u32 = text[2..4].parse().ok()?;
    let second: u32 = text[4..6].parse().ok()?;
    if hour < 24 && minute < 60 && second < 60 { Some(hour * 3600 + minute * 60 + second) } else { None }
}

fn read_day_metadata(data_dir: &Path, date: u32) -> io::Result<DayMetadata> {
    let day = Day::from_yyyymmdd(date).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("{date}는 날짜가 아니다")))?;
    let midnight_ms = day.unix_ms_at_kst(0, 0);
    let path = store_dir(data_dir, date).join(COMPLETE_FILE_NAME);
    let bytes = fs::read(&path)?;
    let complete: CompleteStocks = serde_json::from_slice(&bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if complete.format_version != COMPLETE_FORMAT_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("complete.json 형식 버전이 맞지 않는다: {}", complete.format_version),
        ));
    }
    if !complete.verify.passed {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "원문 대조를 통과하지 못한 complete.json이다"));
    }
    let mut registered = BTreeSet::new();
    let mut gaps = HashMap::new();
    for stock in complete.stocks {
        if StockCode::parse(&stock.code).is_err() {
            continue;
        }
        if stock.registered {
            registered.insert(stock.code.clone());
        }
        let converted = convert_gaps(&stock.gaps, midnight_ms);
        if !converted.is_empty() {
            gaps.insert(stock.code, converted);
        }
    }
    Ok(DayMetadata { registered, gaps })
}

fn convert_gaps(gaps: &[CompleteGap], midnight_ms: i64) -> Vec<(u32, u32)> {
    gaps.iter()
        .map(|gap| (clamp_day_sec(gap.from_ms, midnight_ms), clamp_day_sec(gap.to_ms, midnight_ms)))
        .filter(|(from, to)| from < to)
        .collect()
}

fn clamp_day_sec(ms: i64, midnight_ms: i64) -> u32 {
    (ms - midnight_ms).div_euclid(1000).clamp(0, SECONDS_PER_DAY) as u32
}

fn complete_days(data_dir: &Path) -> io::Result<Vec<u32>> {
    let entries = match fs::read_dir(data_dir.join(STORE_FOLDER)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut dates = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| name.len() == DATE_FOLDER_LEN && name.bytes().all(|byte| byte.is_ascii_digit())) else {
            continue;
        };
        if entry.file_type()?.is_dir()
            && let Ok(date) = name.parse::<u32>()
            && store_dir(data_dir, date).join(COMPLETE_FILE_NAME).is_file()
        {
            dates.push(date);
        }
    }
    dates.sort_unstable();
    Ok(dates)
}

fn list_book_files(data_dir: &Path, date: u32) -> io::Result<Vec<PathBuf>> {
    let folder = store_dir(data_dir, date).join(BOOK_TYPE);
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(".parquet")) {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

pub fn recover_all_interrupted_quote_swaps(shared_dir: &Path) -> io::Result<()> {
    let sample = closed_day_dir(shared_dir, "0");
    let parent = sample.parent().expect("분 호가 폴더에는 부모가 있다");
    crate::fs_util::recover_interrupted_dir_swaps(parent, REPLACED_SUFFIX, None)
}

fn publish_closed_day(shared_dir: &Path, date_text: &str, tmp_dir: &Path) -> io::Result<()> {
    let final_dir = closed_day_dir(shared_dir, date_text);
    crate::fs_util::swap_directory(tmp_dir, &final_dir, &format!("{date_text}{REPLACED_SUFFIX}"))?;
    remove_leftover_replaced(&final_dir, date_text);
    Ok(())
}

fn remove_leftover_replaced(final_dir: &Path, date_text: &str) {
    let Some(parent) = final_dir.parent() else { return };
    let Ok(entries) = fs::read_dir(parent) else { return };
    let prefix = format!("{date_text}{REPLACED_SUFFIX}");
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(|name| name.starts_with(&prefix)) {
            let _ = remove_if_exists(&entry.path());
        }
    }
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hhmmss_parses_valid_times_and_rejects_bad_ones() {
        assert_eq!(parse_hhmmss("000000"), Some(0));
        assert_eq!(parse_hhmmss("090105"), Some(9 * 3600 + 65));
        assert_eq!(parse_hhmmss("235959"), Some(86_399));
        assert_eq!(parse_hhmmss(""), None);
        assert_eq!(parse_hhmmss("240000"), None);
        assert_eq!(parse_hhmmss("096000"), None);
        assert_eq!(parse_hhmmss("090060"), None);
        assert_eq!(parse_hhmmss("09000a"), None);
    }

    #[test]
    fn gaps_clamp_to_the_kst_day_bounds() {
        let midnight = Day::from_yyyymmdd(20_261_124).unwrap().unix_ms_at_kst(0, 0);
        let gaps = [
            CompleteGap { from_ms: midnight - 5_000, to_ms: midnight + 12_000 },
            CompleteGap { from_ms: midnight + 86_390_000, to_ms: midnight + 90_000_000 },
            CompleteGap { from_ms: midnight - 20_000, to_ms: midnight - 10_000 },
        ];
        assert_eq!(convert_gaps(&gaps, midnight), vec![(0, 12), (86_390, 86_400)]);
    }

    #[test]
    fn prices_strip_sign_and_negative_or_null_quantities_become_zero() {
        let values = Int64Array::from(vec![Some(-10_500), Some(10_500), None]);
        assert_eq!(price_at(Some(&values), 0), 10_500);
        assert_eq!(price_at(Some(&values), 1), 10_500);
        assert_eq!(price_at(Some(&values), 2), 0);
        assert_eq!(qty_at(Some(&values), 0), 0);
        assert_eq!(qty_at(Some(&values), 1), 10_500);
        assert_eq!(qty_at(Some(&values), 2), 0);
        assert_eq!(qty_at(None, 0), 0);
    }
}
