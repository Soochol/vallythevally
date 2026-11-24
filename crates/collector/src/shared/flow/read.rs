use std::borrow::Cow;
use std::collections::HashMap;

use serde::Deserialize;
use server::shared_data::FlowRow;

use super::FlowKindSpec;

const COMBINED_SUFFIX: &str = "_AL";

pub(super) struct CompiledKind {
    pub(super) spec: FlowKindSpec,
    pub(super) fid_keys: Vec<String>,
}

impl CompiledKind {
    pub(super) fn compile_all(kinds: &'static [FlowKindSpec]) -> Vec<CompiledKind> {
        kinds
            .iter()
            .copied()
            .map(|spec| CompiledKind {
                spec,
                fid_keys: spec.fids.iter().map(u32::to_string).collect(),
            })
            .collect()
    }
}

pub(super) struct Extracted<'a> {
    pub(super) type_code: &'static str,
    pub(super) fids: &'static [u32],
    pub(super) symbol: &'a str,
    pub(super) row: FlowRow,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Reading {
    pub(super) rows: u64,
    pub(super) skipped: u64,
}

#[derive(Deserialize)]
struct Frame<'a> {
    #[serde(borrow, default)]
    data: Vec<Entry<'a>>,
}

#[derive(Deserialize)]
struct Entry<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Cow<'a, str>,
    #[serde(borrow, default)]
    item: Cow<'a, str>,
    #[serde(borrow, default)]
    values: HashMap<Cow<'a, str>, Option<Cow<'a, str>>>,
}

pub(super) fn read_rows(
    text: &str,
    recv_ms: i64,
    kinds: &[CompiledKind],
    mut sink: impl FnMut(Extracted<'_>),
) -> Result<Reading, serde_json::Error> {
    let frame: Frame<'_> = serde_json::from_str(text)?;
    let mut reading = Reading::default();
    for entry in &frame.data {
        let Some(compiled) = kinds.iter().find(|kind| kind.spec.type_code == entry.kind.as_ref()) else {
            continue;
        };
        let symbol = entry.item.strip_suffix(COMBINED_SUFFIX).unwrap_or(&entry.item);
        if symbol.is_empty() {
            reading.skipped += 1;
            continue;
        }
        let values = compiled
            .fid_keys
            .iter()
            .map(|fid_key| entry.values.get(fid_key.as_str()).and_then(|value| value.as_deref()).map(str::to_owned))
            .collect();
        reading.rows += 1;
        sink(Extracted {
            type_code: compiled.spec.type_code,
            fids: compiled.spec.fids,
            symbol,
            row: FlowRow { recv_ms, values },
        });
    }
    Ok(reading)
}
