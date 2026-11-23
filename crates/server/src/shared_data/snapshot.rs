use domain::Venue;
use serde::{Deserialize, Serialize};

use super::format::DataKind;

pub fn snapshot_kind(venue: Venue) -> DataKind {
    match venue {
        Venue::Krx => DataKind::SnapshotKrx,
        Venue::Combined => DataKind::SnapshotCombined,
        Venue::Nxt => DataKind::SnapshotNxt,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBody {
    pub closing: bool,
    pub requested: u32,
    pub missing: u32,
    pub stocks: Vec<SnapshotRow>,
    pub indices: Vec<IndexRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    pub code: String,
    pub day: String,
    pub current_won: u64,
    pub base_won: u64,
    pub open_won: u64,
    pub high_won: u64,
    pub low_won: u64,
    pub volume: u64,
    pub traded_million_won: u64,
    pub traded_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRow {
    pub code: String,
    pub name: String,
    pub level: f64,
    pub change_rate: f64,
    pub trade_million_won: u64,
}
