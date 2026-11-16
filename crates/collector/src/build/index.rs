use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use hoga_format::{Span, StreamKind};
use serde::{Deserialize, Serialize};

use super::day::ReadErrors;
use super::store::write_atomically;
use crate::kst::SPAN_MINUTES;

pub const INDEX_FILE_NAME: &str = "index.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowCounts {
    pub book: usize,
    pub trades: usize,
    pub program: usize,
    pub broker: usize,
    pub gaps: usize,
}

impl RowCounts {
    pub fn of(span: &Span) -> RowCounts {
        let count = |kind: StreamKind| span.stream(kind).map_or(0, |stream| stream.rows());
        RowCounts {
            book: count(StreamKind::Book),
            trades: count(StreamKind::Trades),
            program: count(StreamKind::Program),
            broker: count(StreamKind::Broker),
            gaps: count(StreamKind::Gaps),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpanEntry {
    pub start: String,
    pub file: String,
    pub rows: RowCounts,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolIndex {
    pub spans: Vec<SpanEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Index {
    pub version: u16,
    pub date: u32,
    pub span_minutes: u16,
    pub read_errors: ReadErrors,
    pub members: BTreeMap<String, String>,
    pub symbols: BTreeMap<String, SymbolIndex>,
}

impl Index {
    pub fn new(date: u32, read_errors: ReadErrors, members: BTreeMap<String, String>) -> Index {
        Index {
            version: hoga_format::VERSION,
            date,
            span_minutes: SPAN_MINUTES,
            read_errors,
            members,
            symbols: BTreeMap::new(),
        }
    }

    pub fn read(path: &Path) -> io::Result<Index> {
        let bytes = fs::read(path)?;
        serde_json::from_slice(&bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub fn write_if_changed(&self, path: &Path) -> io::Result<bool> {
        let mut text = serde_json::to_vec_pretty(self).expect("색인은 항상 JSON이 된다");
        text.push(b'\n');
        if fs::read(path).is_ok_and(|existing| existing == text) {
            return Ok(false);
        }
        write_atomically(path, &text)?;
        Ok(true)
    }
}
