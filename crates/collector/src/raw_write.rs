use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use tokio_tungstenite::tungstenite::Utf8Bytes;
use zstd::stream::write::Encoder;

use crate::kst::KstTime;
use crate::protocol::KeyName;

const ZSTD_LEVEL: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawLine<'a> {
    Frame { recv_ms: i64, text: &'a str },
    Text { recv_ms: i64, text: &'a str },
    Live { recv_ms: i64 },
    Down { recv_ms: i64, reason: &'a str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawRecord {
    Frame { recv_ms: i64, text: Utf8Bytes },
    Text { recv_ms: i64, text: String },
    Live { recv_ms: i64 },
    Down { recv_ms: i64, reason: String },
}

impl RawRecord {
    pub fn as_line(&self) -> RawLine<'_> {
        match self {
            RawRecord::Frame { recv_ms, text } => RawLine::Frame { recv_ms: *recv_ms, text: text.as_str() },
            RawRecord::Text { recv_ms, text } => RawLine::Text { recv_ms: *recv_ms, text: text.as_str() },
            RawRecord::Live { recv_ms } => RawLine::Live { recv_ms: *recv_ms },
            RawRecord::Down { recv_ms, reason } => RawLine::Down { recv_ms: *recv_ms, reason: reason.as_str() },
        }
    }

    pub fn from_line(line: &RawLine<'_>) -> RawRecord {
        match *line {
            RawLine::Frame { recv_ms, text } => RawRecord::Frame { recv_ms, text: Utf8Bytes::from(text) },
            RawLine::Text { recv_ms, text } => RawRecord::Text { recv_ms, text: text.to_owned() },
            RawLine::Live { recv_ms } => RawRecord::Live { recv_ms },
            RawLine::Down { recv_ms, reason } => RawRecord::Down { recv_ms, reason: reason.to_owned() },
        }
    }
}

impl RawLine<'_> {
    fn recv_ms(&self) -> i64 {
        match *self {
            RawLine::Frame { recv_ms, .. }
            | RawLine::Text { recv_ms, .. }
            | RawLine::Live { recv_ms }
            | RawLine::Down { recv_ms, .. } => recv_ms,
        }
    }

    fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        match *self {
            RawLine::Frame { recv_ms, text } => {
                write!(writer, "{{\"recv_ms\":{recv_ms},\"msg\":")?;
                for part in text.split(['\n', '\r']) {
                    if !part.is_empty() {
                        writer.write_all(part.as_bytes())?;
                    }
                }
                writer.write_all(b"}\n")
            }
            RawLine::Text { recv_ms, text } => {
                write!(writer, "{{\"recv_ms\":{recv_ms},\"text\":")?;
                serde_json::to_writer(&mut *writer, text)?;
                writer.write_all(b"}\n")
            }
            RawLine::Live { recv_ms } => writeln!(writer, "{{\"recv_ms\":{recv_ms},\"event\":\"live\"}}"),
            RawLine::Down { recv_ms, reason } => {
                write!(writer, "{{\"recv_ms\":{recv_ms},\"event\":\"down\",\"reason\":")?;
                serde_json::to_writer(&mut *writer, reason)?;
                writer.write_all(b"}\n")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SpanKey {
    date: u32,
    start_minute: u16,
}

struct OpenFile {
    key: SpanKey,
    encoder: Encoder<'static, BufWriter<File>>,
}

pub struct RawWriter {
    data_dir: PathBuf,
    key: Option<KeyName>,
    open: Option<OpenFile>,
}

impl RawWriter {
    pub fn new(data_dir: impl Into<PathBuf>) -> RawWriter {
        RawWriter {
            data_dir: data_dir.into(),
            key: None,
            open: None,
        }
    }

    pub fn for_key(data_dir: impl Into<PathBuf>, key: KeyName) -> RawWriter {
        RawWriter {
            data_dir: data_dir.into(),
            key: Some(key),
            open: None,
        }
    }

    pub fn write(&mut self, line: &RawLine<'_>) -> io::Result<()> {
        let time = KstTime::from_unix_ms(line.recv_ms());
        let key = SpanKey {
            date: time.date,
            start_minute: time.span_start_minute(),
        };
        if self.open.as_ref().is_none_or(|open| open.key != key) {
            self.close_current()?;
            self.open = Some(self.open_new_file(key)?);
        }
        let open = self.open.as_mut().expect("방금 열었다");
        line.write_to(&mut open.encoder)
    }

    pub fn write_record(&mut self, record: &RawRecord) -> io::Result<()> {
        self.write(&record.as_line())
    }

    pub fn flush(&mut self) -> io::Result<()> {
        match self.open.as_mut() {
            Some(open) => open.encoder.flush(),
            None => Ok(()),
        }
    }

    pub fn close(mut self) -> io::Result<()> {
        self.close_current()
    }

    fn close_current(&mut self) -> io::Result<()> {
        match self.open.take() {
            Some(open) => {
                let buffer = open.encoder.finish()?;
                let file = buffer.into_inner().map_err(io::IntoInnerError::into_error)?;
                file.sync_all()
            }
            None => Ok(()),
        }
    }

    fn open_new_file(&self, key: SpanKey) -> io::Result<OpenFile> {
        let folder = match &self.key {
            Some(name) => raw_key_dir(&self.data_dir, key.date, name),
            None => raw_day_dir(&self.data_dir, key.date),
        };
        fs::create_dir_all(&folder)?;
        let hhmm = format!("{:02}{:02}", key.start_minute / 60, key.start_minute % 60);
        for number in 0u32.. {
            let path = folder.join(format!("{hhmm}-{number:03}.jsonl.zst"));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(OpenFile {
                        key,
                        encoder: Encoder::new(BufWriter::new(file), ZSTD_LEVEL)?,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        unreachable!("파일 번호는 끝나지 않는다")
    }
}

impl Drop for RawWriter {
    fn drop(&mut self) {
        let _ = self.close_current();
    }
}

pub fn raw_day_dir(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join("raw").join(date.to_string())
}

pub fn raw_key_dir(data_dir: &Path, date: u32, key: &KeyName) -> PathBuf {
    raw_day_dir(data_dir, date).join(key.as_str())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::raw_read::{RawContent, RawItem, read_day};

    const KST_2026_07_20_10_27_55: i64 = 1_784_510_875_000;

    #[test]
    fn dropping_a_raw_writer_finishes_the_zstd_stream_without_truncation() {
        let data = tempdir().unwrap();
        let recv_ms = KST_2026_07_20_10_27_55;
        {
            let mut writer = RawWriter::new(data.path());
            writer.write_record(&RawRecord::Live { recv_ms }).unwrap();
            writer
                .write_record(&RawRecord::Frame {
                    recv_ms: recv_ms + 1,
                    text: Utf8Bytes::from_static("{\"a\":\r\n[1,\n2]}"),
                })
                .unwrap();
            writer
                .write_record(&RawRecord::Text {
                    recv_ms: recv_ms + 2,
                    text: "plain \"text\"\nline".to_owned(),
                })
                .unwrap();
            writer
                .write_record(&RawRecord::Down {
                    recv_ms: recv_ms + 3,
                    reason: "종료".to_owned(),
                })
                .unwrap();
        }
        let items: Vec<RawItem> = read_day(data.path(), 20260720).unwrap().collect();
        assert!(items.iter().all(|item| !matches!(item, RawItem::Truncated { .. })), "{items:?}");
        let contents: Vec<(i64, RawContent)> = items
            .into_iter()
            .map(|item| match item {
                RawItem::Record(record) => (record.recv_ms, record.content),
                other => panic!("기록이 아닙니다: {other:?}"),
            })
            .collect();
        assert_eq!(
            contents,
            [
                (recv_ms, RawContent::Live),
                (recv_ms + 1, RawContent::Frame("{\"a\":[1,2]}".to_owned())),
                (recv_ms + 2, RawContent::Text("plain \"text\"\nline".to_owned())),
                (recv_ms + 3, RawContent::Down { reason: "종료".to_owned() }),
            ]
        );
    }
}
