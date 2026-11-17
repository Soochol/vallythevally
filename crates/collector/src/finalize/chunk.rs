use std::cmp::Ordering;
use std::io;
use std::sync::Arc;

use arrow_array::{ArrayRef, BooleanArray, Float64Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::Schema;

use super::schema::BufferKind;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cell<'a> {
    Null,
    Int { value: i64, plus: bool },
    Float { value: f64, plus: bool },
    Text(&'a str),
}

enum ColumnBuf {
    Int { values: Vec<i64>, valid: Vec<bool> },
    Float { values: Vec<f64>, valid: Vec<bool> },
    Text { data: String, ends: Vec<u32>, valid: Vec<bool> },
    Flag(Vec<bool>),
}

impl ColumnBuf {
    fn new(kind: BufferKind) -> ColumnBuf {
        match kind {
            BufferKind::Int => ColumnBuf::Int { values: Vec::new(), valid: Vec::new() },
            BufferKind::Float => ColumnBuf::Float { values: Vec::new(), valid: Vec::new() },
            BufferKind::Text => ColumnBuf::Text { data: String::new(), ends: Vec::new(), valid: Vec::new() },
            BufferKind::Flag => ColumnBuf::Flag(Vec::new()),
        }
    }

    fn clear(&mut self) {
        match self {
            ColumnBuf::Int { values, valid } => {
                values.clear();
                valid.clear();
            }
            ColumnBuf::Float { values, valid } => {
                values.clear();
                valid.clear();
            }
            ColumnBuf::Text { data, ends, valid } => {
                data.clear();
                ends.clear();
                valid.clear();
            }
            ColumnBuf::Flag(flags) => flags.clear(),
        }
    }

    fn text_at<'d>(data: &'d str, ends: &[u32], row: usize) -> &'d str {
        let start = if row == 0 { 0 } else { ends[row - 1] as usize };
        &data[start..ends[row] as usize]
    }
}

pub struct Chunk {
    symbols: String,
    symbol_ends: Vec<u32>,
    recv: Vec<i64>,
    line: Vec<u64>,
    entry: Vec<u32>,
    columns: Vec<ColumnBuf>,
    approx_bytes: usize,
}

impl Chunk {
    pub fn new(kinds: &[BufferKind]) -> Chunk {
        Chunk {
            symbols: String::new(),
            symbol_ends: Vec::new(),
            recv: Vec::new(),
            line: Vec::new(),
            entry: Vec::new(),
            columns: kinds.iter().map(|kind| ColumnBuf::new(*kind)).collect(),
            approx_bytes: 0,
        }
    }

    pub fn rows(&self) -> usize {
        self.recv.len()
    }

    pub fn approx_bytes(&self) -> usize {
        self.approx_bytes
    }

    pub fn clear(&mut self) {
        self.symbols.clear();
        self.symbol_ends.clear();
        self.recv.clear();
        self.line.clear();
        self.entry.clear();
        self.columns.iter_mut().for_each(ColumnBuf::clear);
        self.approx_bytes = 0;
    }

    pub fn begin_row(&mut self, symbol: &str, recv_ms: i64, line: u64, entry: u32) {
        self.symbols.push_str(symbol);
        self.symbol_ends.push(self.symbols.len() as u32);
        self.recv.push(recv_ms);
        self.line.push(line);
        self.entry.push(entry);
        self.approx_bytes += symbol.len() + 24;
    }

    pub fn push_cell(&mut self, column: usize, plus_column: Option<usize>, cell: Cell<'_>) {
        let flag = matches!(cell, Cell::Int { plus: true, .. } | Cell::Float { plus: true, .. });
        match (&mut self.columns[column], cell) {
            (ColumnBuf::Int { values, valid }, Cell::Int { value, .. }) => {
                values.push(value);
                valid.push(true);
                self.approx_bytes += 9;
            }
            (ColumnBuf::Int { values, valid }, _) => {
                values.push(0);
                valid.push(false);
                self.approx_bytes += 9;
            }
            (ColumnBuf::Float { values, valid }, Cell::Float { value, .. }) => {
                values.push(value);
                valid.push(true);
                self.approx_bytes += 9;
            }
            (ColumnBuf::Float { values, valid }, _) => {
                values.push(0.0);
                valid.push(false);
                self.approx_bytes += 9;
            }
            (ColumnBuf::Text { data, ends, valid }, Cell::Text(text)) => {
                data.push_str(text);
                ends.push(data.len() as u32);
                valid.push(true);
                self.approx_bytes += text.len() + 5;
            }
            (ColumnBuf::Text { data, ends, valid }, _) => {
                ends.push(data.len() as u32);
                valid.push(false);
                self.approx_bytes += 5;
            }
            (ColumnBuf::Flag(_), _) => unreachable!("값 열에 표시 열이 걸렸다"),
        }
        if let Some(plus_column) = plus_column {
            let ColumnBuf::Flag(flags) = &mut self.columns[plus_column] else {
                unreachable!("부호 열이 표시 열이 아니다")
            };
            flags.push(flag);
            self.approx_bytes += 1;
        }
    }

    pub fn symbol(&self, row: usize) -> &str {
        ColumnBuf::text_at(&self.symbols, &self.symbol_ends, row)
    }

    pub fn sorted_order(&self) -> io::Result<Vec<u32>> {
        let rows = u32::try_from(self.rows()).map_err(|_| io::Error::other("버킷 하나의 행이 40억을 넘는다"))?;
        let mut order: Vec<u32> = (0..rows).collect();
        order.sort_unstable_by(|&a, &b| self.compare(a as usize, b as usize));
        Ok(order)
    }

    fn compare(&self, a: usize, b: usize) -> Ordering {
        self.symbol(a)
            .cmp(self.symbol(b))
            .then(self.recv[a].cmp(&self.recv[b]))
            .then(self.line[a].cmp(&self.line[b]))
            .then(self.entry[a].cmp(&self.entry[b]))
    }

    pub fn record_batch(&self, schema: &Arc<Schema>, order: &[u32]) -> RecordBatch {
        let mut arrays: Vec<ArrayRef> = Vec::with_capacity(schema.fields().len());
        arrays.push(Arc::new(StringArray::from_iter_values(order.iter().map(|&row| self.symbol(row as usize)))));
        arrays.push(Arc::new(Int64Array::from_iter_values(order.iter().map(|&row| self.recv[row as usize]))));
        for column in &self.columns {
            arrays.push(match column {
                ColumnBuf::Int { values, valid } => Arc::new(Int64Array::from_iter(
                    order.iter().map(|&row| valid[row as usize].then(|| values[row as usize])),
                )),
                ColumnBuf::Float { values, valid } => Arc::new(Float64Array::from_iter(
                    order.iter().map(|&row| valid[row as usize].then(|| values[row as usize])),
                )),
                ColumnBuf::Text { data, ends, valid } => Arc::new(StringArray::from_iter(
                    order.iter().map(|&row| valid[row as usize].then(|| ColumnBuf::text_at(data, ends, row as usize))),
                )),
                ColumnBuf::Flag(flags) => Arc::new(BooleanArray::from_iter(order.iter().map(|&row| Some(flags[row as usize])))),
            });
        }
        RecordBatch::try_new(schema.clone(), arrays).expect("배열은 스키마와 같은 모양이다")
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.approx_bytes);
        out.extend_from_slice(&(self.rows() as u32).to_le_bytes());
        put_text(&mut out, &self.symbols, &self.symbol_ends);
        self.recv.iter().for_each(|value| out.extend_from_slice(&value.to_le_bytes()));
        self.line.iter().for_each(|value| out.extend_from_slice(&value.to_le_bytes()));
        self.entry.iter().for_each(|value| out.extend_from_slice(&value.to_le_bytes()));
        for column in &self.columns {
            match column {
                ColumnBuf::Int { values, valid } => {
                    put_valid(&mut out, valid);
                    values.iter().for_each(|value| out.extend_from_slice(&value.to_le_bytes()));
                }
                ColumnBuf::Float { values, valid } => {
                    put_valid(&mut out, valid);
                    values.iter().for_each(|value| out.extend_from_slice(&value.to_le_bytes()));
                }
                ColumnBuf::Text { data, ends, valid } => {
                    put_valid(&mut out, valid);
                    put_text(&mut out, data, ends);
                }
                ColumnBuf::Flag(flags) => put_valid(&mut out, flags),
            }
        }
        out
    }

    pub fn append_encoded(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut cursor = Cursor { bytes, position: 0 };
        let rows = cursor.u32()? as usize;
        let symbols = cursor.text(rows)?;
        extend_ends(&mut self.symbol_ends, self.symbols.len(), &symbols.ends)?;
        self.symbols.push_str(symbols.data);
        for _ in 0..rows {
            self.recv.push(cursor.i64()?);
        }
        for _ in 0..rows {
            self.line.push(cursor.u64()?);
        }
        for _ in 0..rows {
            self.entry.push(cursor.u32()?);
        }
        for column in &mut self.columns {
            match column {
                ColumnBuf::Int { values, valid } => {
                    valid.extend(cursor.flags(rows)?);
                    for _ in 0..rows {
                        values.push(cursor.i64()?);
                    }
                }
                ColumnBuf::Float { values, valid } => {
                    valid.extend(cursor.flags(rows)?);
                    for _ in 0..rows {
                        values.push(f64::from_bits(cursor.u64()?));
                    }
                }
                ColumnBuf::Text { data, ends, valid } => {
                    valid.extend(cursor.flags(rows)?);
                    let text = cursor.text(rows)?;
                    extend_ends(ends, data.len(), &text.ends)?;
                    data.push_str(text.data);
                }
                ColumnBuf::Flag(flags) => flags.extend(cursor.flags(rows)?),
            }
        }
        self.approx_bytes += bytes.len();
        if cursor.position == bytes.len() { Ok(()) } else { Err(corrupt()) }
    }
}

fn extend_ends(ends: &mut Vec<u32>, base: usize, added: &[u32]) -> io::Result<()> {
    let too_big = || io::Error::other("버킷 하나의 글자 열이 4GiB를 넘는다. --buckets를 늘린다");
    let base = u32::try_from(base).map_err(|_| too_big())?;
    for end in added {
        ends.push(base.checked_add(*end).ok_or_else(too_big)?);
    }
    Ok(())
}

fn put_valid(out: &mut Vec<u8>, flags: &[bool]) {
    out.extend(flags.iter().map(|flag| u8::from(*flag)));
}

fn put_text(out: &mut Vec<u8>, data: &str, ends: &[u32]) {
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data.as_bytes());
    ends.iter().for_each(|end| out.extend_from_slice(&end.to_le_bytes()));
}

fn corrupt() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "임시 파일이 깨졌다")
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

struct TextBlock<'a> {
    data: &'a str,
    ends: Vec<u32>,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> io::Result<&'a [u8]> {
        let end = self.position.checked_add(count).filter(|end| *end <= self.bytes.len()).ok_or_else(corrupt)?;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("4바이트")))
    }

    fn u64(&mut self) -> io::Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().expect("8바이트")))
    }

    fn i64(&mut self) -> io::Result<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().expect("8바이트")))
    }

    fn flags(&mut self, rows: usize) -> io::Result<impl Iterator<Item = bool> + use<'a>> {
        Ok(self.take(rows)?.iter().map(|byte| *byte != 0))
    }

    fn text(&mut self, rows: usize) -> io::Result<TextBlock<'a>> {
        let length = self.u32()? as usize;
        let data = std::str::from_utf8(self.take(length)?).map_err(|_| corrupt())?;
        let mut ends = Vec::with_capacity(rows);
        for _ in 0..rows {
            ends.push(self.u32()?);
        }
        Ok(TextBlock { data, ends })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Chunk {
        let mut chunk = Chunk::new(&[BufferKind::Int, BufferKind::Float, BufferKind::Text, BufferKind::Flag, BufferKind::Flag]);
        chunk.begin_row("B", 5, 1, 0);
        chunk.push_cell(0, Some(3), Cell::Int { value: -7, plus: false });
        chunk.push_cell(1, Some(4), Cell::Float { value: 1.5, plus: true });
        chunk.push_cell(2, None, Cell::Text("삼  성"));
        chunk.begin_row("A", 9, 2, 0);
        chunk.push_cell(0, Some(3), Cell::Null);
        chunk.push_cell(1, Some(4), Cell::Null);
        chunk.push_cell(2, None, Cell::Null);
        chunk.begin_row("A", 9, 1, 3);
        chunk.push_cell(0, Some(3), Cell::Int { value: 4, plus: true });
        chunk.push_cell(1, Some(4), Cell::Float { value: 0.0, plus: false });
        chunk.push_cell(2, None, Cell::Text(""));
        chunk
    }

    #[test]
    fn rows_sort_by_symbol_time_then_arrival() {
        let chunk = sample();
        let order = chunk.sorted_order().unwrap();
        assert_eq!(order, [2, 1, 0]);
    }

    #[test]
    fn an_encoded_chunk_comes_back_identical() {
        let chunk = sample();
        let mut copy = Chunk::new(&[BufferKind::Int, BufferKind::Float, BufferKind::Text, BufferKind::Flag, BufferKind::Flag]);
        copy.append_encoded(&chunk.encode()).unwrap();
        copy.append_encoded(&chunk.encode()).unwrap();
        assert_eq!(copy.rows(), 6);
        assert_eq!(copy.symbol(3), "B");
        let mut twice = chunk.encode();
        twice.truncate(twice.len() - 1);
        assert!(copy.append_encoded(&twice).is_err());
    }
}
