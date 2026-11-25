use std::borrow::Cow;
use std::collections::HashMap;

use serde::Deserialize;
use serde_json::value::RawValue;
use server::shared_data::FlowRow;

use super::FlowKindSpec;

const COMBINED_SUFFIX: &str = "_AL";
const NXT_SUFFIX: &str = "_NX";
const VI_TYPE_CODE: &str = "1h";
const VI_SYMBOL_FID: u32 = 9001;
const MAX_SYMBOL_LEN: usize = 32;

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
    data: Option<Vec<&'a RawValue>>,
}

#[derive(Deserialize)]
struct Entry<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    item: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    values: Option<&'a RawValue>,
}

fn value_text(raw: &RawValue) -> Option<String> {
    let text = raw.get().trim();
    match text.as_bytes().first().copied()? {
        b'"' => serde_json::from_str::<String>(text).ok(),
        b'-' | b'0'..=b'9' => Some(text.to_owned()),
        _ => None,
    }
}

pub(super) fn read_rows(
    text: &str,
    recv_ms: i64,
    kinds: &[CompiledKind],
    mut sink: impl FnMut(Extracted<'_>),
) -> Result<Reading, serde_json::Error> {
    let frame: Frame<'_> = serde_json::from_str(text)?;
    let mut reading = Reading::default();
    let Some(entries) = frame.data else {
        return Ok(reading);
    };
    for raw_entry in entries {
        let Ok(entry) = serde_json::from_str::<Entry<'_>>(raw_entry.get()) else {
            reading.skipped += 1;
            continue;
        };
        let Some(kind) = entry.kind.as_deref() else {
            continue;
        };
        let Some(compiled) = kinds.iter().find(|candidate| candidate.spec.type_code == kind) else {
            continue;
        };
        let Some(item) = entry.item.as_deref() else {
            reading.skipped += 1;
            continue;
        };
        let (symbol, is_nxt_vi) = if compiled.spec.type_code == VI_TYPE_CODE {
            if item.ends_with(COMBINED_SUFFIX) {
                continue;
            }
            match item.strip_suffix(NXT_SUFFIX) {
                Some(base) => (base, true),
                None => (item, false),
            }
        } else {
            (item.strip_suffix(COMBINED_SUFFIX).unwrap_or(item), false)
        };
        if symbol.len() > MAX_SYMBOL_LEN || !crate::build::day::is_path_safe_symbol(symbol) {
            reading.skipped += 1;
            continue;
        }
        let values_map: HashMap<Cow<'_, str>, &RawValue> = match entry.values {
            Some(raw) => match serde_json::from_str(raw.get()) {
                Ok(map) => map,
                Err(_) => {
                    reading.skipped += 1;
                    continue;
                }
            },
            None => HashMap::new(),
        };
        let values = compiled
            .spec
            .fids
            .iter()
            .zip(compiled.fid_keys.iter())
            .map(|(&fid, fid_key)| {
                if is_nxt_vi && fid == VI_SYMBOL_FID {
                    Some(format!("{symbol}{NXT_SUFFIX}"))
                } else {
                    values_map.get(fid_key.as_str()).and_then(|raw| value_text(raw))
                }
            })
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
