use serde::{Deserialize, Serialize};

use crate::keys::KeyRole;
use crate::protocol::{KeyName, RealType};
use crate::universe::Replacement;

pub const FORMAT_VERSION: u32 = 1;
pub const KEY_CAPACITY: usize = 190;
pub const MARKET_TYPES: [RealType; 3] = [RealType::SectorIndex, RealType::SectorBreadth, RealType::MarketHours];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyShare {
    pub name: KeyName,
    pub role: KeyRole,
    pub app_key_hash: String,
    pub stocks: Vec<String>,
    pub market_types: Vec<RealType>,
    pub rest_jobs: Vec<String>,
    pub load: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputSummary {
    pub active_keys: usize,
    pub universe_replaced: Option<Replacement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanFile {
    pub format_version: u32,
    pub date: u32,
    pub created_at: String,
    pub input: InputSummary,
    pub keys: Vec<KeyShare>,
    pub excluded: Vec<String>,
    pub unregistered: Vec<String>,
    pub alerts: Vec<String>,
}
