use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::format::{DataKind, FEED_EXTENSION, FORMAT_VERSION, Header};
use super::symbol_flow::complete_jsonl_prefix;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeMinuteLine {
    pub minute: u16,
    #[serde(default)]
    pub trades: Vec<(u32, u64, i64)>,
}

pub fn trade_minute_path(dir: &Path, date: &str, key: &str, code: &str) -> PathBuf {
    dir.join(DataKind::TradeMinute.folder()).join(date).join(key).join(format!("{code}.{FEED_EXTENSION}"))
}

pub fn read_trade_minute_file(path: &Path) -> io::Result<Vec<TradeMinuteLine>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let complete = complete_jsonl_prefix(&bytes);
    let mut header_checked = false;
    let mut warned = false;
    let mut entries = Vec::new();
    for line in complete.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if !header_checked {
            header_checked = true;
            match serde_json::from_slice::<Header>(line) {
                Ok(header) if header.format_version == FORMAT_VERSION && header.kind == DataKind::TradeMinute => {}
                _ => {
                    tracing::warn!(path = %path.display(), "지원하지 않는 머리의 1분 체결 파일을 건너뜁니다");
                    return Ok(Vec::new());
                }
            }
            continue;
        }
        match serde_json::from_slice::<TradeMinuteLine>(line) {
            Ok(entry) => entries.push(entry),
            Err(_) => {
                if !warned {
                    tracing::warn!(path = %path.display(), "깨진 1분 체결 줄을 건너뜁니다");
                    warned = true;
                }
            }
        }
    }
    Ok(entries)
}
