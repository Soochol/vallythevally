use crate::error::EncodeError;
use crate::kind::StreamKind;
use crate::span::{Span, Stream};
use crate::{MAGIC, MAX_SYMBOL_LEN, VERSION};

pub fn encode(span: &Span) -> Result<Vec<u8>, EncodeError> {
    if !span.symbol.is_ascii() {
        return Err(EncodeError::SymbolNotAscii);
    }
    if span.symbol.len() > MAX_SYMBOL_LEN {
        return Err(EncodeError::SymbolTooLong { len: span.symbol.len() });
    }
    let mut seen: Vec<StreamKind> = Vec::new();
    let mut bodies = Vec::with_capacity(span.streams.len());
    for stream in &span.streams {
        if seen.contains(&stream.kind) {
            return Err(EncodeError::DuplicateStream { kind: stream.kind });
        }
        seen.push(stream.kind);
        bodies.push(encode_body(stream)?);
    }

    let mut out = Vec::new();
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&span.date.to_le_bytes());
    out.extend_from_slice(&span.start_minute.to_le_bytes());
    out.extend_from_slice(&span.length_minutes.to_le_bytes());
    out.push(span.symbol.len() as u8);
    out.extend_from_slice(span.symbol.as_bytes());
    out.push(span.streams.len() as u8);
    for (stream, body) in span.streams.iter().zip(&bodies) {
        let specs = stream.kind.columns();
        out.push(stream.kind.code());
        out.push(specs.len() as u8);
        out.extend_from_slice(&(stream.rows() as u32).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&delta_flags(&specs));
    }
    while out.len() % 4 != 0 {
        out.push(0);
    }
    for body in bodies {
        out.extend_from_slice(&body);
    }
    Ok(out)
}

pub(crate) fn delta_flags(specs: &[crate::kind::ColumnSpec]) -> Vec<u8> {
    let mut flags = vec![0u8; specs.len().div_ceil(8)];
    for (index, spec) in specs.iter().enumerate() {
        if spec.delta {
            flags[index / 8] |= 1 << (index % 8);
        }
    }
    flags
}

fn encode_body(stream: &Stream) -> Result<Vec<u8>, EncodeError> {
    let kind = stream.kind;
    let specs = kind.columns();
    if stream.columns.len() != specs.len() {
        return Err(EncodeError::ColumnCount {
            kind,
            expected: specs.len(),
            found: stream.columns.len(),
        });
    }
    let rows = stream.rows();
    let body_bytes = rows
        .checked_mul(specs.len())
        .and_then(|cells| cells.checked_mul(4))
        .filter(|bytes| u32::try_from(*bytes).is_ok())
        .ok_or(EncodeError::TooLarge { kind })?;

    let mut body = Vec::with_capacity(body_bytes);
    for (spec, values) in specs.iter().zip(&stream.columns) {
        if values.len() != rows {
            return Err(EncodeError::ColumnLength {
                kind,
                column: spec.name.clone(),
                expected: rows,
                found: values.len(),
            });
        }
        let mut previous = 0i32;
        for (row, value) in values.iter().enumerate() {
            let value = i32::try_from(*value).map_err(|_| EncodeError::OutOfRange {
                kind,
                column: spec.name.clone(),
                row,
                value: *value,
            })?;
            let stored = if spec.delta && row > 0 {
                value.wrapping_sub(previous)
            } else {
                value
            };
            previous = value;
            body.extend_from_slice(&stored.to_le_bytes());
        }
    }
    Ok(body)
}
