use std::fs;
use std::path::Path;

use hoga_format::EncodeError;

use super::cut::CutSpan;
use super::index::{RowCounts, SpanEntry};
use super::report::{BuildReport, RangeFailure};
use super::store::{PackError, hhmm, latest_revisions, pack, span_file_name, symbol_dir, unpack, write_atomically};

pub fn publish_symbol(
    data_dir: &Path,
    date: u32,
    symbol: &str,
    cuts: &[CutSpan],
    report: &mut BuildReport,
) -> Vec<SpanEntry> {
    let folder = symbol_dir(data_dir, date, symbol);
    let revisions = match latest_revisions(&folder) {
        Ok(revisions) => revisions,
        Err(error) => {
            report.write_errors.push(format!("{}: {error}", folder.display()));
            return Vec::new();
        }
    };
    let mut entries = Vec::new();
    for cut in cuts {
        let span = &cut.span;
        report.note_book_rows(symbol, cut.own_book_rows);
        let current = revisions.get(&span.start_minute).copied();
        let unchanged = current.filter(|revision| holds_same_content(&folder, span.start_minute, *revision, span));
        let outcome = match unchanged {
            Some(revision) => Ok(Placed {
                file_name: span_file_name(span.start_minute, revision),
                bytes: file_size(&folder, span.start_minute, revision),
                written: false,
            }),
            None => {
                let packed = match pack(span) {
                    Ok(packed) => packed,
                    Err(PackError::Encode(EncodeError::OutOfRange { kind, column, value, .. })) => {
                        report.range_failures.push(RangeFailure {
                            symbol: symbol.to_string(),
                            start: hhmm(span.start_minute),
                            stream: kind.name(),
                            column,
                            value,
                        });
                        continue;
                    }
                    Err(error) => {
                        report.write_errors.push(format!("{symbol} {}: {error}", hhmm(span.start_minute)));
                        continue;
                    }
                };
                let file_name = span_file_name(span.start_minute, current.map_or(1, |revision| revision + 1));
                write_atomically(&folder.join(&file_name), &packed)
                    .map(|()| Placed { file_name, bytes: packed.len() as u64, written: true })
            }
        };
        match outcome {
            Ok(placed) => {
                if placed.written {
                    report.written_files += 1;
                    report.written_bytes += placed.bytes;
                } else {
                    report.unchanged_files += 1;
                }
                entries.push(SpanEntry {
                    start: hhmm(span.start_minute),
                    file: placed.file_name,
                    rows: RowCounts::of(span),
                    bytes: placed.bytes,
                });
            }
            Err(error) => report.write_errors.push(format!("{symbol} {}: {error}", hhmm(span.start_minute))),
        }
    }
    entries
}

struct Placed {
    file_name: String,
    bytes: u64,
    written: bool,
}

fn holds_same_content(folder: &Path, start_minute: u16, revision: u32, span: &hoga_format::Span) -> bool {
    fs::read(folder.join(span_file_name(start_minute, revision)))
        .ok()
        .and_then(|bytes| unpack(&bytes).ok())
        .is_some_and(|existing| &existing == span)
}

fn file_size(folder: &Path, start_minute: u16, revision: u32) -> u64 {
    fs::metadata(folder.join(span_file_name(start_minute, revision))).map_or(0, |metadata| metadata.len())
}

