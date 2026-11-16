use crate::kind::StreamKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub date: u32,
    pub start_minute: u16,
    pub length_minutes: u16,
    pub symbol: String,
    pub streams: Vec<Stream>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stream {
    pub kind: StreamKind,
    pub columns: Vec<Vec<i64>>,
}

impl Stream {
    pub fn rows(&self) -> usize {
        self.columns.first().map_or(0, Vec::len)
    }

    pub fn column(&self, name: &str) -> Option<&[i64]> {
        let index = self.kind.column_index(name)?;
        self.columns.get(index).map(Vec::as_slice)
    }
}

impl Span {
    pub fn stream(&self, kind: StreamKind) -> Option<&Stream> {
        self.streams.iter().find(|stream| stream.kind == kind)
    }
}
