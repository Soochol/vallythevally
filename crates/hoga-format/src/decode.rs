use crate::encode::delta_flags;
use crate::error::DecodeError;
use crate::kind::StreamKind;
use crate::span::{Span, Stream};
use crate::{MAGIC, VERSION};

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], DecodeError> {
        let end = self
            .offset
            .checked_add(len)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(DecodeError::Truncated { offset: self.offset })?;
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}

struct Entry {
    kind: StreamKind,
    rows: u32,
    body_bytes: u32,
}

pub fn decode(bytes: &[u8]) -> Result<Span, DecodeError> {
    let mut reader = Reader { bytes, offset: 0 };
    if reader.take(4)? != MAGIC {
        return Err(DecodeError::BadMagic);
    }
    let version = reader.u16()?;
    if version != VERSION {
        return Err(DecodeError::UnsupportedVersion { version });
    }
    let date = reader.u32()?;
    let start_minute = reader.u16()?;
    let length_minutes = reader.u16()?;
    let symbol_len = reader.u8()? as usize;
    let symbol_bytes = reader.take(symbol_len)?;
    if !symbol_bytes.is_ascii() {
        return Err(DecodeError::SymbolNotAscii);
    }
    let symbol = String::from_utf8_lossy(symbol_bytes).into_owned();

    let stream_count = reader.u8()?;
    let mut entries: Vec<Entry> = Vec::new();
    for _ in 0..stream_count {
        let code = reader.u8()?;
        let kind = StreamKind::from_code(code).ok_or(DecodeError::UnknownKind { code })?;
        if entries.iter().any(|entry| entry.kind == kind) {
            return Err(DecodeError::DuplicateStream { kind });
        }
        let specs = kind.columns();
        let column_count = reader.u8()? as usize;
        if column_count != specs.len() {
            return Err(DecodeError::ColumnCount {
                kind,
                expected: specs.len(),
                found: column_count,
            });
        }
        let rows = reader.u32()?;
        let body_bytes = reader.u32()?;
        let expected = rows as u64 * column_count as u64 * 4;
        if body_bytes as u64 != expected {
            return Err(DecodeError::BodyLength {
                kind,
                expected,
                found: body_bytes as u64,
            });
        }
        let flags = delta_flags(&specs);
        if reader.take(flags.len())? != flags.as_slice() {
            return Err(DecodeError::DeltaFlagsMismatch { kind });
        }
        entries.push(Entry { kind, rows, body_bytes });
    }

    let padding = (4 - reader.offset % 4) % 4;
    if reader.take(padding)?.iter().any(|byte| *byte != 0) {
        return Err(DecodeError::NonZeroPadding);
    }

    let mut streams = Vec::with_capacity(entries.len());
    for entry in entries {
        let body = reader.take(entry.body_bytes as usize)?;
        streams.push(decode_stream(&entry, body));
    }
    if reader.offset != bytes.len() {
        return Err(DecodeError::TrailingBytes {
            count: bytes.len() - reader.offset,
        });
    }
    Ok(Span {
        date,
        start_minute,
        length_minutes,
        symbol,
        streams,
    })
}

fn decode_stream(entry: &Entry, body: &[u8]) -> Stream {
    let rows = entry.rows as usize;
    let specs = entry.kind.columns();
    let mut cells = body
        .chunks_exact(4)
        .map(|chunk| i32::from_le_bytes(chunk.try_into().unwrap()));
    let mut columns = Vec::with_capacity(specs.len());
    for spec in &specs {
        let mut values = Vec::with_capacity(rows);
        let mut running = 0i32;
        for row in 0..rows {
            let stored = cells.next().unwrap_or(0);
            running = if spec.delta && row > 0 {
                running.wrapping_add(stored)
            } else {
                stored
            };
            values.push(running as i64);
        }
        columns.push(values);
    }
    Stream {
        kind: entry.kind,
        columns,
    }
}
