use serde::{Deserialize, Serialize};

use crate::api::{Market, ViDirection};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViEventRow {
    pub code: String,
    pub name: String,
    pub market: Market,
    pub direction: ViDirection,
    pub triggered_at: String,
    pub released_at: Option<String>,
    pub trigger_price: Option<u64>,
    pub static_vi: bool,
    pub dynamic_vi: bool,
    pub dispersion_rate: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViEventsBody {
    pub events: Vec<ViEventRow>,
}
