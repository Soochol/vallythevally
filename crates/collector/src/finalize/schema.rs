use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use arrow_schema::{DataType, Field, Schema};
use serde::Deserialize;

const FIDS_JSON: &str = include_str!("realtime_fids.json");
const FID_TABLE_LEN: usize = 10_000;
const NO_SLOT: u32 = u32::MAX;

pub const SYMBOL_COLUMN: &str = "symbol";
pub const RECV_MS_COLUMN: &str = "recv_ms";
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Int,
    Float,
    Text,
}

#[derive(Debug, Deserialize)]
struct SpecFile {
    types: Vec<SpecType>,
}

#[derive(Debug, Deserialize)]
struct SpecType {
    r#type: String,
    name: String,
    fids: Vec<SpecFid>,
}

#[derive(Debug, Deserialize)]
struct SpecFid {
    fid: u32,
    name: String,
    kind: ColumnKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferKind {
    Int,
    Float,
    Text,
    Flag,
}

#[derive(Debug)]
pub struct ValueColumn {
    pub fid: u32,
    pub name: String,
    pub korean_name: String,
    pub kind: ColumnKind,
    pub plus_slot: Option<usize>,
}

#[derive(Debug)]
pub struct RealtimeType {
    pub code: String,
    pub korean_name: String,
    pub values: Vec<ValueColumn>,
    plus_names: Vec<String>,
    slot_by_fid: Vec<u32>,
}

impl RealtimeType {
    fn new(spec: SpecType) -> RealtimeType {
        let numeric_count = spec.fids.iter().filter(|fid| fid.kind != ColumnKind::Text).count();
        let mut plus_names = Vec::with_capacity(numeric_count);
        let mut slot_by_fid = vec![NO_SLOT; FID_TABLE_LEN];
        let value_count = spec.fids.len();
        let values = spec
            .fids
            .into_iter()
            .enumerate()
            .map(|(slot, fid)| {
                slot_by_fid[fid.fid as usize] = slot as u32;
                let plus_slot = (fid.kind != ColumnKind::Text).then(|| {
                    plus_names.push(format!("f{}_plus", fid.fid));
                    value_count + plus_names.len() - 1
                });
                ValueColumn { fid: fid.fid, name: format!("f{}", fid.fid), korean_name: fid.name, kind: fid.kind, plus_slot }
            })
            .collect();
        RealtimeType { code: spec.r#type, korean_name: spec.name, values, plus_names, slot_by_fid }
    }

    pub fn slot_of(&self, fid: &str) -> Option<usize> {
        let canonical = !fid.is_empty() && fid.bytes().all(|byte| byte.is_ascii_digit()) && (fid.len() == 1 || !fid.starts_with('0'));
        let number: usize = canonical.then(|| fid.parse().ok()).flatten()?;
        let slot = *self.slot_by_fid.get(number)?;
        (slot != NO_SLOT).then_some(slot as usize)
    }

    pub fn buffer_kinds(&self) -> Vec<BufferKind> {
        let values = self.values.iter().map(|column| match column.kind {
            ColumnKind::Int => BufferKind::Int,
            ColumnKind::Float => BufferKind::Float,
            ColumnKind::Text => BufferKind::Text,
        });
        values.chain(self.plus_names.iter().map(|_| BufferKind::Flag)).collect()
    }

    pub fn column_names(&self) -> Vec<String> {
        let mut names = vec![SYMBOL_COLUMN.to_string(), RECV_MS_COLUMN.to_string()];
        names.extend(self.values.iter().map(|column| column.name.clone()));
        names.extend(self.plus_names.iter().cloned());
        names
    }

    pub fn arrow_schema(&self) -> Arc<Schema> {
        let mut fields = vec![
            Field::new(SYMBOL_COLUMN, DataType::Utf8, false),
            Field::new(RECV_MS_COLUMN, DataType::Int64, false),
        ];
        for column in &self.values {
            let data_type = match column.kind {
                ColumnKind::Int => DataType::Int64,
                ColumnKind::Float => DataType::Float64,
                ColumnKind::Text => DataType::Utf8,
            };
            fields.push(Field::new(&column.name, data_type, true));
        }
        for name in &self.plus_names {
            fields.push(Field::new(name, DataType::Boolean, false));
        }
        Arc::new(Schema::new(fields))
    }

    pub fn delta_encoded_columns(&self) -> Vec<&str> {
        let ints = self.values.iter().filter(|column| column.kind == ColumnKind::Int);
        std::iter::once(RECV_MS_COLUMN).chain(ints.map(|column| column.name.as_str())).collect()
    }
}

pub fn types() -> &'static [RealtimeType] {
    static TYPES: OnceLock<Vec<RealtimeType>> = OnceLock::new();
    TYPES.get_or_init(|| {
        let file: SpecFile = serde_json::from_str(FIDS_JSON).expect("realtime_fids.json은 항상 읽힌다");
        file.types.into_iter().map(RealtimeType::new).collect()
    })
}

pub fn type_index(code: &str) -> Option<usize> {
    static INDEX: OnceLock<HashMap<&'static str, usize>> = OnceLock::new();
    INDEX
        .get_or_init(|| types().iter().enumerate().map(|(index, kind)| (kind.code.as_str(), index)).collect())
        .get(code)
        .copied()
}

pub fn bucket_of(symbol: &str, buckets: usize) -> usize {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in symbol.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    (hash % buckets as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_eleven_received_types_have_their_columns() {
        let codes: Vec<&str> = types().iter().map(|kind| kind.code.as_str()).collect();
        assert_eq!(codes, ["0B", "0D", "0w", "0F", "1h", "0H", "0E", "0g", "0J", "0U", "0s"]);
    }

    #[test]
    fn every_numeric_value_column_has_a_plus_column() {
        for kind in types() {
            let names = kind.column_names();
            for column in &kind.values {
                let plus_name = format!("{}_plus", column.name);
                assert_eq!(names.contains(&plus_name), column.kind != ColumnKind::Text, "{} {}", kind.code, column.name);
            }
        }
    }

    #[test]
    fn column_names_match_the_arrow_schema() {
        for kind in types() {
            let schema = kind.arrow_schema();
            let from_schema: Vec<&str> = schema.fields().iter().map(|field| field.name().as_str()).collect();
            assert_eq!(from_schema, kind.column_names());
            assert_eq!(schema.fields().len(), 2 + kind.buffer_kinds().len());
        }
    }

    #[test]
    fn bucket_is_stable() {
        assert_eq!(bucket_of("005930_AL", 64), bucket_of("005930_AL", 64));
        assert!(bucket_of("", 64) < 64);
    }
}
