use std::collections::BTreeMap;

use hoga_format::{Span, Stream, StreamKind};

use super::day::{FlatRows, ROW_KINDS, SPAN_MS, SymbolRows, carries_forward};
use super::gaps::{GapInterval, gaps_in_span};
use crate::kst::SPAN_MINUTES;

#[derive(Debug)]
pub struct CutSpan {
    pub span: Span,
    pub own_book_rows: usize,
}

pub fn cut_symbol(
    date: u32,
    symbol: &str,
    rows: &SymbolRows,
    gaps: &[GapInterval],
    last_span: u32,
) -> Vec<CutSpan> {
    let groups: Vec<BTreeMap<u32, Vec<usize>>> =
        ROW_KINDS.iter().map(|kind| group_by_span(rows.stream(*kind))).collect();
    let first = groups.iter().filter_map(|group| group.keys().next().copied()).min();
    let last = groups.iter().filter_map(|group| group.keys().next_back().copied()).max();
    let (Some(first), Some(last)) = (first, last) else {
        return Vec::new();
    };
    let mut carries: Vec<Option<usize>> = vec![None; ROW_KINDS.len()];
    let mut cuts = Vec::new();
    for span_index in first..=last.min(last_span) {
        let mut streams = Vec::new();
        let mut own_book_rows = 0;
        for (slot, kind) in ROW_KINDS.iter().enumerate() {
            let own: &[usize] = groups[slot].get(&span_index).map_or(&[], Vec::as_slice);
            if *kind == StreamKind::Book {
                own_book_rows = own.len();
            }
            let carry = if carries_forward(*kind) { carries[slot] } else { None };
            let picked: Vec<usize> = carry.into_iter().chain(own.iter().copied()).collect();
            if !picked.is_empty() {
                streams.push(Stream { kind: *kind, columns: columns_of(rows.stream(*kind), &picked) });
            }
        }
        let span_start_ms = span_index * SPAN_MS;
        let span_gaps = gaps_in_span(gaps, span_start_ms, span_start_ms + SPAN_MS);
        if !span_gaps.is_empty() {
            streams.push(Stream {
                kind: StreamKind::Gaps,
                columns: vec![
                    span_gaps.iter().map(|gap| i64::from(gap.from_ms)).collect(),
                    span_gaps.iter().map(|gap| i64::from(gap.to_ms)).collect(),
                ],
            });
        }
        cuts.push(CutSpan {
            span: Span {
                date,
                start_minute: (span_index * u32::from(SPAN_MINUTES)) as u16,
                length_minutes: SPAN_MINUTES,
                symbol: symbol.to_string(),
                streams,
            },
            own_book_rows,
        });
        for (slot, group) in groups.iter().enumerate() {
            if let Some(newest) = group.get(&span_index).and_then(|indices| indices.last()) {
                carries[slot] = Some(*newest);
            }
        }
    }
    cuts
}

fn group_by_span(rows: &FlatRows) -> BTreeMap<u32, Vec<usize>> {
    let mut groups: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for index in 0..rows.len() {
        let recv_ms = rows.row(index)[0] as u32;
        groups.entry(recv_ms / SPAN_MS).or_default().push(index);
    }
    groups
}

fn columns_of(rows: &FlatRows, picked: &[usize]) -> Vec<Vec<i64>> {
    let width = rows.row(picked[0]).len();
    (0..width)
        .map(|column| picked.iter().map(|&index| rows.row(index)[column]).collect())
        .collect()
}
