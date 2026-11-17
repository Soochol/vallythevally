use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use arrow_array::{Array, Int64Array, StringArray};
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde::Serialize;

use super::merge::{METADATA_BUCKETS, into_io};
use super::scan::{RowStat, Tally, Unfinalized};
use super::schema::{self, FORMAT_VERSION, RECV_MS_COLUMN, SYMBOL_COLUMN, bucket_of};

pub const VERIFY_FILE_NAME: &str = "verify.json";
const BATCH_ROWS: usize = 16_384;
const MAX_LISTED_MISMATCHES: usize = 100;
const MAX_PROBLEMS_PER_FILE: usize = 5;

const ALL_UNFINALIZED: [Unfinalized; 9] = [
    Unfinalized::MalformedFrame,
    Unfinalized::UnknownRealtimeType,
    Unfinalized::UnknownFid,
    Unfinalized::UnparsableValue,
    Unfinalized::OtherFrame,
    Unfinalized::NonJsonText,
    Unfinalized::BrokenLine,
    Unfinalized::TruncatedFile,
    Unfinalized::UnreadableFile,
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatJson {
    pub rows: u64,
    pub first_recv_ms: i64,
    pub last_recv_ms: i64,
}

impl From<RowStat> for StatJson {
    fn from(stat: RowStat) -> StatJson {
        StatJson { rows: stat.rows, first_recv_ms: stat.first_recv_ms, last_recv_ms: stat.last_recv_ms }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mismatch {
    pub kind: &'static str,
    pub r#type: String,
    pub symbol: String,
    pub raw: Option<StatJson>,
    pub parquet: Option<StatJson>,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UnfinalizedCounts {
    pub total: u64,
    pub kinds: BTreeMap<&'static str, u64>,
}

#[derive(Debug, Serialize)]
pub struct LineCounts {
    pub total: u64,
    pub finalized: u64,
    pub control: u64,
    pub unfinalized: UnfinalizedCounts,
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct VerifyReport {
    pub format_version: u32,
    pub date: u32,
    pub passed: bool,
    pub buckets: usize,
    pub lines: LineCounts,
    pub unknown_realtime_types: BTreeMap<String, u64>,
    pub unknown_fids: BTreeMap<String, BTreeMap<String, u64>>,
    pub unparsable_values: BTreeMap<String, BTreeMap<String, u64>>,
    pub rows: BTreeMap<String, BTreeMap<String, StatJson>>,
    pub symbol_messages: BTreeMap<String, u64>,
    pub mismatch_count: u64,
    pub mismatches: Vec<Mismatch>,
    pub files: Vec<FileEntry>,
}

struct ParquetFile {
    type_index: usize,
    bucket: usize,
    path: PathBuf,
}

struct FileRead {
    stats: BTreeMap<String, RowStat>,
    rows: u64,
    bytes: u64,
    problems: Vec<(&'static str, String, String)>,
    problem_count: u64,
}

pub fn bucket_count_of(store_dir: &Path) -> io::Result<Option<usize>> {
    let Some(file) = list_files(store_dir)?.into_iter().next() else { return Ok(None) };
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(&file.path)?).map_err(into_io)?;
    let stored = builder
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .and_then(|pairs| pairs.iter().find(|pair| pair.key == METADATA_BUCKETS))
        .and_then(|pair| pair.value.as_deref());
    Ok(stored.and_then(|text| text.parse().ok()))
}

pub fn verify_store(store_dir: &Path, date: u32, buckets: usize, threads: usize, tally: &Tally) -> io::Result<VerifyReport> {
    let files = list_files(store_dir)?;
    let reads = read_all(&files, buckets, threads)?;
    let mut parquet_rows: Vec<BTreeMap<String, RowStat>> = vec![BTreeMap::new(); schema::types().len()];
    let mut mismatches: Vec<(usize, Mismatch)> = Vec::new();
    let mut mismatch_count = 0u64;
    let mut entries = Vec::new();
    for (file, read) in files.iter().zip(reads) {
        let code = &schema::types()[file.type_index].code;
        for (stat_symbol, stat) in read.stats {
            parquet_rows[file.type_index].entry(stat_symbol).and_modify(|existing| existing.add(stat)).or_insert(stat);
        }
        mismatch_count += read.problem_count;
        for (kind, symbol, detail) in read.problems {
            mismatches.push((file.type_index, Mismatch { kind, r#type: code.clone(), symbol, raw: None, parquet: None, detail: Some(detail) }));
        }
        entries.push(FileEntry { path: relative(store_dir, &file.path), rows: read.rows, bytes: read.bytes });
    }
    for (type_index, raw_rows) in tally.rows.iter().enumerate() {
        let code = &schema::types()[type_index].code;
        let symbols: BTreeSet<&String> = raw_rows.keys().chain(parquet_rows[type_index].keys()).collect();
        for symbol in symbols {
            let (raw, parquet) = (raw_rows.get(symbol).copied(), parquet_rows[type_index].get(symbol).copied());
            if raw != parquet {
                mismatch_count += 1;
                mismatches.push((
                    type_index,
                    Mismatch {
                        kind: "rows",
                        r#type: code.clone(),
                        symbol: symbol.clone(),
                        raw: raw.map(StatJson::from),
                        parquet: parquet.map(StatJson::from),
                        detail: None,
                    },
                ));
            }
        }
    }
    mismatches.sort_by(|(left_type, left), (right_type, right)| {
        (left_type, &left.symbol, left.kind).cmp(&(right_type, &right.symbol, right.kind))
    });
    mismatches.truncate(MAX_LISTED_MISMATCHES);
    let report = VerifyReport {
        format_version: FORMAT_VERSION,
        date,
        passed: mismatch_count == 0,
        buckets,
        lines: line_counts(tally),
        unknown_realtime_types: tally.unknown_types.clone(),
        unknown_fids: nested_counts(tally.unknown_fids.iter().map(|((type_index, fid), count)| (*type_index, fid.clone(), *count))),
        unparsable_values: nested_counts(
            tally.unparsable_values.iter().map(|((type_index, fid), count)| (*type_index, fid.to_string(), *count)),
        ),
        rows: schema::types()
            .iter()
            .zip(&parquet_rows)
            .map(|(realtime, stats)| (realtime.code.clone(), stats.iter().map(|(symbol, stat)| (symbol.clone(), StatJson::from(*stat))).collect()))
            .collect(),
        symbol_messages: tally.symbol_messages.clone(),
        mismatch_count,
        mismatches: mismatches.into_iter().map(|(_, mismatch)| mismatch).collect(),
        files: entries,
    };
    let mut text = serde_json::to_vec_pretty(&report).expect("대조 결과는 항상 JSON이 된다");
    text.push(b'\n');
    crate::build::store::write_atomically(&store_dir.join(VERIFY_FILE_NAME), &text)?;
    Ok(report)
}

fn line_counts(tally: &Tally) -> LineCounts {
    LineCounts {
        total: tally.total(),
        finalized: tally.finalized,
        control: tally.control,
        unfinalized: UnfinalizedCounts {
            total: tally.unfinalized_total(),
            kinds: ALL_UNFINALIZED.iter().map(|kind| (kind.key(), tally.unfinalized.get(kind).copied().unwrap_or(0))).collect(),
        },
    }
}

fn nested_counts(entries: impl Iterator<Item = (usize, String, u64)>) -> BTreeMap<String, BTreeMap<String, u64>> {
    let mut nested: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for (type_index, fid, count) in entries {
        nested.entry(schema::types()[type_index].code.clone()).or_default().insert(fid, count);
    }
    nested
}

fn relative(store_dir: &Path, path: &Path) -> String {
    path.strip_prefix(store_dir).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn list_files(store_dir: &Path) -> io::Result<Vec<ParquetFile>> {
    let mut files = Vec::new();
    for (type_index, realtime) in schema::types().iter().enumerate() {
        let folder = store_dir.join(&realtime.code);
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let mut paths: Vec<PathBuf> = entries.map(|entry| entry.map(|entry| entry.path())).collect::<io::Result<_>>()?;
        paths.sort();
        for path in paths {
            let bucket = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".parquet"))
                .and_then(|stem| stem.parse::<usize>().ok());
            if let Some(bucket) = bucket {
                files.push(ParquetFile { type_index, bucket, path });
            }
        }
    }
    Ok(files)
}

fn read_all(files: &[ParquetFile], buckets: usize, threads: usize) -> io::Result<Vec<FileRead>> {
    let next = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<FileRead>>> = files.iter().map(|_| Mutex::new(None)).collect();
    thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(index) else { return };
                    *slots[index].lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(read_file(file, buckets));
                }
            });
        }
    });
    slots
        .into_iter()
        .map(|slot| slot.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner()).ok_or_else(|| io::Error::other("대조 스레드가 멈췄다")))
        .collect()
}

fn read_file(file: &ParquetFile, buckets: usize) -> FileRead {
    let mut read = FileRead { stats: BTreeMap::new(), rows: 0, bytes: 0, problems: Vec::new(), problem_count: 0 };
    read.bytes = fs::metadata(&file.path).map(|metadata| metadata.len()).unwrap_or(0);
    if let Err(error) = scan_file(file, buckets, &mut read) {
        read.report("unreadable_file", String::new(), error.to_string());
    }
    read
}

impl FileRead {
    fn report(&mut self, kind: &'static str, symbol: String, detail: String) {
        self.problem_count += 1;
        if self.problems.len() < MAX_PROBLEMS_PER_FILE {
            self.problems.push((kind, symbol, detail));
        }
    }
}

fn scan_file(file: &ParquetFile, buckets: usize, read: &mut FileRead) -> io::Result<()> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(&file.path)?).map_err(into_io)?;
    let expected_schema = schema::types()[file.type_index].arrow_schema();
    if builder.schema().fields() != expected_schema.fields() {
        read.report("schema", String::new(), "열 정의가 계약과 다르다".to_string());
    }
    let mask = ProjectionMask::roots(builder.parquet_schema(), [0, 1]);
    let reader = builder.with_projection(mask).with_batch_size(BATCH_ROWS).build().map_err(into_io)?;
    let mut previous: Option<(String, i64)> = None;
    let mut current: Option<(String, RowStat)> = None;
    for batch in reader {
        let batch = batch.map_err(into_io)?;
        let symbols = batch.column_by_name(SYMBOL_COLUMN).and_then(|column| column.as_any().downcast_ref::<StringArray>());
        let times = batch.column_by_name(RECV_MS_COLUMN).and_then(|column| column.as_any().downcast_ref::<Int64Array>());
        let (Some(symbols), Some(times)) = (symbols, times) else {
            return Err(io::Error::other("symbol·recv_ms 열을 읽을 수 없다"));
        };
        for row in 0..batch.num_rows() {
            if symbols.is_null(row) || times.is_null(row) {
                return Err(io::Error::other("symbol·recv_ms에 빈 값이 있다"));
            }
            let (symbol, recv_ms) = (symbols.value(row), times.value(row));
            read.rows += 1;
            match current.as_mut() {
                Some((name, stat)) if name == symbol => stat.add(RowStat::one(recv_ms)),
                _ => {
                    if let Some((name, stat)) = current.take() {
                        add_stat(&mut read.stats, name, stat);
                    }
                    if bucket_of(symbol, buckets) != file.bucket {
                        read.report("bucket", symbol.to_string(), format!("{}번 파일에 있지만 해시 버킷은 {}이다", file.bucket, bucket_of(symbol, buckets)));
                    }
                    current = Some((symbol.to_string(), RowStat::one(recv_ms)));
                }
            }
            if previous.as_ref().is_some_and(|(name, time)| (name.as_str(), *time) > (symbol, recv_ms)) {
                read.report("order", symbol.to_string(), "종목·시각 순이 아니다".to_string());
            }
            match previous.as_mut() {
                Some((name, time)) if name == symbol => *time = recv_ms,
                _ => previous = Some((symbol.to_string(), recv_ms)),
            }
        }
    }
    if let Some((name, stat)) = current {
        add_stat(&mut read.stats, name, stat);
    }
    Ok(())
}

fn add_stat(stats: &mut BTreeMap<String, RowStat>, symbol: String, stat: RowStat) {
    stats.entry(symbol).and_modify(|existing| existing.add(stat)).or_insert(stat);
}
