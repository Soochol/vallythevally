use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

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

impl RawLine<'_> {
    fn recv_ms(&self) -> i64 {
        match *self {
            RawLine::Frame { recv_ms, .. }
            | RawLine::Text { recv_ms, .. }
            | RawLine::Live { recv_ms }
            | RawLine::Down { recv_ms, .. } => recv_ms,
        }
    }

    fn encode(&self) -> String {
        match *self {
            RawLine::Frame { recv_ms, text } => {
                let message: String = text.chars().filter(|c| !matches!(c, '\n' | '\r')).collect();
                format!("{{\"recv_ms\":{recv_ms},\"msg\":{message}}}\n")
            }
            RawLine::Text { recv_ms, text } => {
                format!("{{\"recv_ms\":{recv_ms},\"text\":{}}}\n", json_string(text))
            }
            RawLine::Live { recv_ms } => format!("{{\"recv_ms\":{recv_ms},\"event\":\"live\"}}\n"),
            RawLine::Down { recv_ms, reason } => format!(
                "{{\"recv_ms\":{recv_ms},\"event\":\"down\",\"reason\":{}}}\n",
                json_string(reason)
            ),
        }
    }
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("문자열은 항상 JSON으로 바뀐다")
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
        open.encoder.write_all(line.encode().as_bytes())
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
            Some(open) => open.encoder.finish()?.flush(),
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

pub fn raw_day_dir(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join("raw").join(date.to_string())
}

pub fn raw_key_dir(data_dir: &Path, date: u32, key: &KeyName) -> PathBuf {
    raw_day_dir(data_dir, date).join(key.as_str())
}
