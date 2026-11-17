use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;

use super::chunk::{Cell, Chunk};
use super::schema::{self, ColumnKind, RealtimeType, bucket_of};
use crate::raw_read::{RawContent, RawDayReader, RawItem};

const BATCH_LINES: usize = 1024;
const SPILL_ZSTD_LEVEL: i32 = 1;
const LOGIN_FRAME: &str = "LOGIN";
const REG_FRAME: &str = "REG";
const REAL_FRAME: &str = "REAL";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Unfinalized {
    MalformedFrame,
    UnknownRealtimeType,
    UnknownFid,
    UnparsableValue,
    OtherFrame,
    NonJsonText,
    BrokenLine,
    TruncatedFile,
    UnreadableFile,
}

impl Unfinalized {
    pub fn key(self) -> &'static str {
        match self {
            Unfinalized::MalformedFrame => "malformed_realtime_frame",
            Unfinalized::UnknownRealtimeType => "unknown_realtime_type",
            Unfinalized::UnknownFid => "unknown_fid",
            Unfinalized::UnparsableValue => "unparsable_value",
            Unfinalized::OtherFrame => "other_frame",
            Unfinalized::NonJsonText => "non_json_text",
            Unfinalized::BrokenLine => "broken_line",
            Unfinalized::TruncatedFile => "truncated_file",
            Unfinalized::UnreadableFile => "unreadable_file",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowStat {
    pub rows: u64,
    pub first_recv_ms: i64,
    pub last_recv_ms: i64,
}

impl RowStat {
    pub fn one(recv_ms: i64) -> RowStat {
        RowStat { rows: 1, first_recv_ms: recv_ms, last_recv_ms: recv_ms }
    }

    pub fn add(&mut self, other: RowStat) {
        self.rows += other.rows;
        self.first_recv_ms = self.first_recv_ms.min(other.first_recv_ms);
        self.last_recv_ms = self.last_recv_ms.max(other.last_recv_ms);
    }
}

pub type RowStats = Vec<BTreeMap<String, RowStat>>;

#[derive(Debug, Clone)]
pub struct Tally {
    pub finalized: u64,
    pub control: u64,
    pub unfinalized: BTreeMap<Unfinalized, u64>,
    pub rows: RowStats,
    pub symbol_messages: BTreeMap<String, u64>,
    pub unknown_types: BTreeMap<String, u64>,
    pub unknown_fids: BTreeMap<(usize, String), u64>,
    pub unparsable_values: BTreeMap<(usize, u32), u64>,
}

impl Default for Tally {
    fn default() -> Tally {
        Tally {
            finalized: 0,
            control: 0,
            unfinalized: BTreeMap::new(),
            rows: vec![BTreeMap::new(); schema::types().len()],
            symbol_messages: BTreeMap::new(),
            unknown_types: BTreeMap::new(),
            unknown_fids: BTreeMap::new(),
            unparsable_values: BTreeMap::new(),
        }
    }
}

impl Tally {
    pub fn unfinalized_total(&self) -> u64 {
        self.unfinalized.values().sum()
    }

    pub fn total(&self) -> u64 {
        self.finalized + self.control + self.unfinalized_total()
    }

    pub fn merge(&mut self, other: Tally) {
        self.finalized += other.finalized;
        self.control += other.control;
        add_counts(&mut self.unfinalized, other.unfinalized);
        for (mine, theirs) in self.rows.iter_mut().zip(other.rows) {
            for (symbol, stat) in theirs {
                mine.entry(symbol).and_modify(|existing| existing.add(stat)).or_insert(stat);
            }
        }
        add_counts(&mut self.symbol_messages, other.symbol_messages);
        add_counts(&mut self.unknown_types, other.unknown_types);
        add_counts(&mut self.unknown_fids, other.unknown_fids);
        add_counts(&mut self.unparsable_values, other.unparsable_values);
    }

    fn count_row(&mut self, type_index: usize, symbol: &str, recv_ms: i64) {
        match self.rows[type_index].get_mut(symbol) {
            Some(stat) => stat.add(RowStat::one(recv_ms)),
            None => {
                self.rows[type_index].insert(symbol.to_string(), RowStat::one(recv_ms));
            }
        }
    }

    fn count_message(&mut self, symbol: &str) {
        match self.symbol_messages.get_mut(symbol) {
            Some(count) => *count += 1,
            None => {
                self.symbol_messages.insert(symbol.to_string(), 1);
            }
        }
    }
}

fn add_counts<K: Ord>(into: &mut BTreeMap<K, u64>, from: BTreeMap<K, u64>) {
    for (key, count) in from {
        *into.entry(key).or_insert(0) += count;
    }
}

pub struct SpillLayout {
    root: PathBuf,
}

impl SpillLayout {
    pub fn new(root: PathBuf) -> SpillLayout {
        SpillLayout { root }
    }

    pub fn file(&self, worker: usize, type_index: usize, bucket: usize) -> PathBuf {
        self.root.join(format!("w{worker}")).join(format!("{type_index:02}-{bucket:03}.bin"))
    }

    pub fn create_worker_dir(&self, worker: usize) -> io::Result<()> {
        fs::create_dir_all(self.root.join(format!("w{worker}")))
    }
}

pub struct ScanOutput {
    pub tally: Tally,
    pub spilled: BTreeSet<(usize, usize)>,
}

struct Source {
    reader: RawDayReader,
    next_line: u64,
}

pub fn scan(reader: RawDayReader, spill: Option<&SpillLayout>, threads: usize, buckets: usize, budget_bytes: usize) -> io::Result<ScanOutput> {
    let source = Mutex::new(Source { reader, next_line: 0 });
    let stop = AtomicBool::new(false);
    let results: Vec<io::Result<ScanOutput>> = thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|worker| {
                let (source, stop) = (&source, &stop);
                scope.spawn(move || {
                    let result = Worker::new(worker, spill, buckets, budget_bytes).and_then(|worker| worker.run(source, stop));
                    if result.is_err() {
                        stop.store(true, Ordering::Relaxed);
                    }
                    result
                })
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| Err(io::Error::other("처리 스레드가 멈췄다")))).collect()
    });
    let mut output = ScanOutput { tally: Tally::default(), spilled: BTreeSet::new() };
    for result in results {
        let part = result?;
        output.tally.merge(part.tally);
        output.spilled.extend(part.spilled);
    }
    Ok(output)
}

struct Worker<'a> {
    index: usize,
    spill: Option<&'a SpillLayout>,
    buckets: usize,
    budget_bytes: usize,
    chunks: Vec<Option<Chunk>>,
    buffered_bytes: usize,
    spilled: BTreeSet<(usize, usize)>,
    tally: Tally,
    source_slots: Vec<u32>,
}

impl<'a> Worker<'a> {
    fn new(index: usize, spill: Option<&'a SpillLayout>, buckets: usize, budget_bytes: usize) -> io::Result<Worker<'a>> {
        if let Some(spill) = spill {
            spill.create_worker_dir(index)?;
        }
        Ok(Worker {
            index,
            spill,
            buckets,
            budget_bytes,
            chunks: (0..schema::types().len() * buckets).map(|_| None).collect(),
            buffered_bytes: 0,
            spilled: BTreeSet::new(),
            tally: Tally::default(),
            source_slots: Vec::new(),
        })
    }

    fn run(mut self, source: &Mutex<Source>, stop: &AtomicBool) -> io::Result<ScanOutput> {
        while !stop.load(Ordering::Relaxed) {
            let batch = take_batch(source);
            if batch.is_empty() {
                break;
            }
            for (line, item) in batch {
                self.process_item(line, item);
            }
            if self.buffered_bytes >= self.budget_bytes {
                self.flush()?;
            }
        }
        self.flush()?;
        Ok(ScanOutput { tally: self.tally, spilled: self.spilled })
    }

    fn process_item(&mut self, line: u64, item: RawItem) {
        match item {
            RawItem::Record(record) => match record.content {
                RawContent::Frame(text) => self.process_frame(line, record.recv_ms, &text),
                RawContent::Text(_) => self.mark(Some(Unfinalized::NonJsonText)),
                RawContent::Live | RawContent::Down { .. } => self.mark(None),
            },
            RawItem::BadLine { .. } => self.mark(Some(Unfinalized::BrokenLine)),
            RawItem::Truncated { .. } => self.mark(Some(Unfinalized::TruncatedFile)),
            RawItem::Unreadable { .. } => self.mark(Some(Unfinalized::UnreadableFile)),
        }
    }

    fn mark(&mut self, outcome: Option<Unfinalized>) {
        match outcome {
            Some(kind) => *self.tally.unfinalized.entry(kind).or_insert(0) += 1,
            None => self.tally.control += 1,
        }
    }

    fn process_frame(&mut self, line: u64, recv_ms: i64, text: &str) {
        let Ok(head) = serde_json::from_str::<FrameHead<'_>>(text) else {
            return self.mark(Some(Unfinalized::OtherFrame));
        };
        match head.trnm.as_ref().map(|name| name.0.as_ref()) {
            Some(LOGIN_FRAME | REG_FRAME) => self.mark(None),
            Some(REAL_FRAME) => {
                let worst = self.process_real(line, recv_ms, head.data);
                match worst {
                    Some(kind) => self.mark(Some(kind)),
                    None => self.tally.finalized += 1,
                }
            }
            _ => self.mark(Some(Unfinalized::OtherFrame)),
        }
    }

    fn process_real(&mut self, line: u64, recv_ms: i64, data: Option<&RawValue>) -> Option<Unfinalized> {
        let Some(entries) = data.and_then(|raw| serde_json::from_str::<Vec<&RawValue>>(raw.get()).ok()) else {
            return Some(Unfinalized::MalformedFrame);
        };
        let mut worst: Option<Unfinalized> = None;
        for (index, raw) in entries.into_iter().enumerate() {
            let outcome = match serde_json::from_str::<EntryWire<'_>>(raw.get()) {
                Ok(entry) => self.process_entry(line, index as u32, recv_ms, &entry),
                Err(_) => Some(Unfinalized::MalformedFrame),
            };
            worst = worse(worst, outcome);
        }
        worst
    }

    fn process_entry(&mut self, line: u64, index: u32, recv_ms: i64, entry: &EntryWire<'_>) -> Option<Unfinalized> {
        let item = entry.item.as_ref().map(|text| text.0.as_ref());
        if let Some(item) = item.filter(|item| !item.is_empty()) {
            self.tally.count_message(item);
        }
        let (Some(code), Some(item), Some(values)) = (entry.kind.as_ref(), item, entry.values.as_ref()) else {
            return Some(Unfinalized::MalformedFrame);
        };
        let Some(type_index) = schema::type_index(&code.0) else {
            *self.tally.unknown_types.entry(code.0.to_string()).or_insert(0) += 1;
            return Some(Unfinalized::UnknownRealtimeType);
        };
        let realtime = &schema::types()[type_index];
        let mut worst = self.locate_values(type_index, realtime, values);
        let mut chunk = match self.spill {
            Some(_) => {
                let bucket = bucket_of(item, self.buckets);
                let chunk = self.chunks[type_index * self.buckets + bucket].get_or_insert_with(|| Chunk::new(&realtime.buffer_kinds()));
                chunk.begin_row(item, recv_ms, line, index);
                Some(chunk)
            }
            None => None,
        };
        let before = chunk.as_ref().map_or(0, |chunk| chunk.approx_bytes());
        for (slot, column) in realtime.values.iter().enumerate() {
            let scalar = match self.source_slots[slot] {
                NO_VALUE => Scalar::Null,
                position => scalar_of(values.0[position as usize].1),
            };
            let cell = match cell_of(column.kind, &scalar) {
                Some(cell) => cell,
                None => {
                    *self.tally.unparsable_values.entry((type_index, column.fid)).or_insert(0) += 1;
                    worst = worse(worst, Some(Unfinalized::UnparsableValue));
                    Cell::Null
                }
            };
            if let Some(chunk) = chunk.as_mut() {
                chunk.push_cell(slot, column.plus_slot, cell);
            }
        }
        self.buffered_bytes += chunk.as_ref().map_or(0, |chunk| chunk.approx_bytes()) - before;
        self.tally.count_row(type_index, item, recv_ms);
        worst
    }

    fn locate_values(&mut self, type_index: usize, realtime: &RealtimeType, values: &Values<'_>) -> Option<Unfinalized> {
        self.source_slots.clear();
        self.source_slots.resize(realtime.values.len(), NO_VALUE);
        let mut worst = None;
        for (position, (key, _)) in values.0.iter().enumerate() {
            match realtime.slot_of(&key.0) {
                Some(slot) => {
                    if self.source_slots[slot] != NO_VALUE {
                        *self.tally.unparsable_values.entry((type_index, realtime.values[slot].fid)).or_insert(0) += 1;
                        worst = worse(worst, Some(Unfinalized::UnparsableValue));
                    }
                    self.source_slots[slot] = position as u32;
                }
                None => {
                    *self.tally.unknown_fids.entry((type_index, key.0.to_string())).or_insert(0) += 1;
                    worst = Some(Unfinalized::UnknownFid);
                }
            }
        }
        worst
    }

    fn flush(&mut self) -> io::Result<()> {
        let Some(spill) = self.spill else { return Ok(()) };
        for (position, slot) in self.chunks.iter_mut().enumerate() {
            let Some(chunk) = slot.as_mut().filter(|chunk| chunk.rows() > 0) else { continue };
            let (type_index, bucket) = (position / self.buckets, position % self.buckets);
            append_blob(&spill.file(self.index, type_index, bucket), &chunk.encode())?;
            self.spilled.insert((type_index, bucket));
            chunk.clear();
        }
        self.buffered_bytes = 0;
        Ok(())
    }
}

const NO_VALUE: u32 = u32::MAX;

fn worse(first: Option<Unfinalized>, second: Option<Unfinalized>) -> Option<Unfinalized> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (first, None) => first,
        (None, second) => second,
    }
}

fn take_batch(source: &Mutex<Source>) -> Vec<(u64, RawItem)> {
    let mut source = source.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut batch = Vec::with_capacity(BATCH_LINES);
    while batch.len() < BATCH_LINES {
        let Some(item) = source.reader.next() else { break };
        batch.push((source.next_line, item));
        source.next_line += 1;
    }
    batch
}

fn append_blob(path: &Path, raw: &[u8]) -> io::Result<()> {
    let compressed = zstd::bulk::compress(raw, SPILL_ZSTD_LEVEL)?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let mut framed = Vec::with_capacity(compressed.len() + 8);
    framed.extend_from_slice(&(raw.len() as u32).to_le_bytes());
    framed.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    framed.extend_from_slice(&compressed);
    file.write_all(&framed)
}

pub fn read_blobs(path: &Path) -> io::Result<Vec<Vec<u8>>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let corrupt = || io::Error::new(io::ErrorKind::InvalidData, "임시 파일이 깨졌다");
    let mut blobs = Vec::new();
    let mut position = 0;
    while position < bytes.len() {
        let header = bytes.get(position..position + 8).ok_or_else(corrupt)?;
        let raw_len = u32::from_le_bytes(header[..4].try_into().expect("4바이트")) as usize;
        let compressed_len = u32::from_le_bytes(header[4..].try_into().expect("4바이트")) as usize;
        let body = bytes.get(position + 8..position + 8 + compressed_len).ok_or_else(corrupt)?;
        blobs.push(zstd::bulk::decompress(body, raw_len)?);
        position += 8 + compressed_len;
    }
    Ok(blobs)
}

fn cell_of<'v>(kind: ColumnKind, scalar: &'v Scalar<'_>) -> Option<Cell<'v>> {
    let text: &str = match scalar {
        Scalar::Null => return Some(Cell::Null),
        Scalar::Other => return None,
        Scalar::Text(text) => text,
        Scalar::Number(text) => text,
    };
    match kind {
        ColumnKind::Text => Some(Cell::Text(text)),
        ColumnKind::Int => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(Cell::Null);
            }
            trimmed.parse::<i64>().ok().map(|value| Cell::Int { value, plus: text.starts_with('+') })
        }
        ColumnKind::Float => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(Cell::Null);
            }
            trimmed
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(|value| Cell::Float { value, plus: text.starts_with('+') })
        }
    }
}

struct Text<'a>(Cow<'a, str>);

impl<'de: 'a, 'a> Deserialize<'de> for Text<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TextVisitor<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for TextVisitor<'a> {
            type Value = Text<'a>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("문자열")
            }

            fn visit_borrowed_str<E: de::Error>(self, value: &'de str) -> Result<Self::Value, E> {
                Ok(Text(Cow::Borrowed(value)))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(Text(Cow::Owned(value.to_string())))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(Text(Cow::Owned(value)))
            }
        }
        deserializer.deserialize_str(TextVisitor(std::marker::PhantomData))
    }
}

enum Scalar<'a> {
    Text(Cow<'a, str>),
    Number(&'a str),
    Null,
    Other,
}

fn scalar_of(raw: &RawValue) -> Scalar<'_> {
    let text = raw.get().trim();
    match text.as_bytes().first() {
        Some(b'"') => {
            let inner = &text[1..text.len() - 1];
            if !inner.contains('\\') {
                Scalar::Text(Cow::Borrowed(inner))
            } else {
                serde_json::from_str::<String>(text).map_or(Scalar::Other, |owned| Scalar::Text(Cow::Owned(owned)))
            }
        }
        Some(b'n') => Scalar::Null,
        Some(b't' | b'f' | b'{' | b'[') => Scalar::Other,
        _ => Scalar::Number(text),
    }
}

struct Values<'a>(Vec<(Text<'a>, &'a RawValue)>);

impl<'de: 'a, 'a> Deserialize<'de> for Values<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ValuesVisitor<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for ValuesVisitor<'a> {
            type Value = Values<'a>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("FID 값 객체")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(entry) = map.next_entry::<Text<'a>, &'de RawValue>()? {
                    entries.push(entry);
                }
                Ok(Values(entries))
            }
        }
        deserializer.deserialize_map(ValuesVisitor(std::marker::PhantomData))
    }
}

#[derive(Deserialize)]
struct FrameHead<'a> {
    #[serde(default, borrow)]
    trnm: Option<Text<'a>>,
    #[serde(default, borrow)]
    data: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct EntryWire<'a> {
    #[serde(default, borrow, rename = "type")]
    kind: Option<Text<'a>>,
    #[serde(default, borrow)]
    item: Option<Text<'a>>,
    #[serde(default, borrow)]
    values: Option<Values<'a>>,
}
