use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::value::RawValue;
use zstd::stream::read::Decoder;

use crate::raw_write::raw_day_dir;

const RAW_FILE_SUFFIX: &str = ".jsonl.zst";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawContent {
    Frame(String),
    Text(String),
    Live,
    Down { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRecord {
    pub recv_ms: i64,
    pub content: RawContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawItem {
    Record(RawRecord),
    BadLine { file: PathBuf, line_number: usize, message: String },
    Truncated { file: PathBuf },
    Unreadable { file: PathBuf, message: String },
}

pub fn read_day(data_dir: &Path, date: u32) -> io::Result<RawDayReader> {
    let folder = raw_day_dir(data_dir, date);
    let mut files = Vec::new();
    for entry in fs::read_dir(&folder)? {
        let path = entry?.path();
        let is_raw_file = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(RAW_FILE_SUFFIX));
        if is_raw_file {
            files.push(path);
        }
    }
    files.sort();
    Ok(RawDayReader {
        pending_files: files.into(),
        current: None,
        queued: VecDeque::new(),
    })
}

pub struct RawDayReader {
    pending_files: VecDeque<PathBuf>,
    current: Option<FileReader>,
    queued: VecDeque<RawItem>,
}

struct FileReader {
    path: PathBuf,
    lines: BufReader<Decoder<'static, BufReader<File>>>,
    line_number: usize,
    ended: bool,
}

impl Iterator for RawDayReader {
    type Item = RawItem;

    fn next(&mut self) -> Option<RawItem> {
        loop {
            if let Some(item) = self.queued.pop_front() {
                return Some(item);
            }
            if let Some(reader) = self.current.as_mut() {
                match reader.next_item() {
                    Some(item) => return Some(item),
                    None => self.current = None,
                }
            }
            let path = self.pending_files.pop_front()?;
            match File::open(&path).and_then(Decoder::new) {
                Ok(decoder) => {
                    self.current = Some(FileReader {
                        path,
                        lines: BufReader::new(decoder),
                        line_number: 0,
                        ended: false,
                    });
                }
                Err(error) => self.queued.push_back(RawItem::Unreadable {
                    file: path,
                    message: error.to_string(),
                }),
            }
        }
    }
}

impl FileReader {
    fn next_item(&mut self) -> Option<RawItem> {
        if self.ended {
            return None;
        }
        let mut line = Vec::new();
        match self.lines.read_until(b'\n', &mut line) {
            Ok(0) => None,
            Ok(_) => {
                self.line_number += 1;
                Some(self.decode_line(&line))
            }
            Err(error) => {
                self.ended = true;
                let file = self.path.clone();
                Some(if error.kind() == io::ErrorKind::UnexpectedEof {
                    RawItem::Truncated { file }
                } else {
                    RawItem::Unreadable { file, message: error.to_string() }
                })
            }
        }
    }

    fn decode_line(&self, line: &[u8]) -> RawItem {
        match decode_record(line) {
            Ok(record) => RawItem::Record(record),
            Err(message) => RawItem::BadLine {
                file: self.path.clone(),
                line_number: self.line_number,
                message,
            },
        }
    }
}

#[derive(Deserialize)]
struct WireLine<'a> {
    recv_ms: i64,
    #[serde(default, borrow, deserialize_with = "present_value")]
    msg: Option<&'a RawValue>,
    event: Option<String>,
    reason: Option<String>,
    text: Option<String>,
}

fn present_value<'de, D>(deserializer: D) -> Result<Option<&'de RawValue>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <&RawValue>::deserialize(deserializer).map(Some)
}

fn decode_record(line: &[u8]) -> Result<RawRecord, String> {
    let wire: WireLine<'_> = serde_json::from_slice(line).map_err(|error| error.to_string())?;
    let content = match (wire.msg, wire.event.as_deref(), wire.text) {
        (Some(message), None, None) => RawContent::Frame(message.get().to_string()),
        (None, None, Some(text)) => RawContent::Text(text),
        (None, Some("live"), None) => RawContent::Live,
        (None, Some("down"), None) => RawContent::Down { reason: wire.reason.unwrap_or_default() },
        _ => return Err("줄의 종류를 알 수 없습니다".to_string()),
    };
    Ok(RawRecord { recv_ms: wire.recv_ms, content })
}
