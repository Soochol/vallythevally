use serde::{Deserialize, Serialize};
use server::api::FinancialUpdatePage;

use super::listing::ListingInfo;

pub const VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: u64 = 1024;
pub const MAX_REPLY_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Command {
    Status,
    Start,
    Pause,
    Resume,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub v: u32,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub v: u32,
    pub page: FinancialUpdatePage,
    pub listing: Option<ListingInfo>,
    pub refused: Option<String>,
}
