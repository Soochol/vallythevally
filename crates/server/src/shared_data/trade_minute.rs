use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::format::{DataKind, FEED_EXTENSION};

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
