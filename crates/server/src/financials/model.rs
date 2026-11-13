use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    Authentication,
    Network,
    RateLimited,
    Remote,
    InvalidResponse,
    Storage,
    SourceUnavailable,
    ReceiptMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Halt { Paused, Yielded }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interrupt { Halt(Halt), Failure(Failure) }

impl From<Halt> for Interrupt {
    fn from(halt: Halt) -> Self { Self::Halt(halt) }
}

impl From<Failure> for Interrupt {
    fn from(failure: Failure) -> Self { Self::Failure(failure) }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Basis { CFS, OFS }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FactPeriod {
    Instant { date: String },
    Duration { start: String, end: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", content = "detail", rename_all = "snake_case")]
pub enum Verification {
    Verified { period: FactPeriod, context_id: String, source_file: String, receipt: String },
    Unverified(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Account {
    pub fields: BTreeMap<String, String>,
    pub current_period: Verification,
    pub cumulative_period: Verification,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Statement {
    pub basis: Basis,
    pub accounts: Vec<Account>,
    pub source_failure: Option<Failure>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Dividend {
    pub settlement_date: Option<String>,
    pub period_reason: Option<String>,
    pub fields: BTreeMap<String, String>,
    pub share_class: Option<String>,
    pub share_class_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Fetch<T> {
    pub data: Option<T>,
    pub absent: bool,
    pub checked_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub failure: Option<Failure>,
    #[serde(default)]
    pub refresh_version: u64,
    #[serde(default)]
    pub validated_version: Option<u64>,
}

impl<T> Default for Fetch<T> {
    fn default() -> Self { Self { data: None, absent: false, checked_at: None, last_success_at: None, failure: None, refresh_version: 0, validated_version: None } }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "next", rename_all = "snake_case")]
pub enum StatementRequest { Separate, Xbrl { basis: Basis, rows: Vec<BTreeMap<String, String>> } }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Report {
    pub business_year: i32,
    pub report_code: String,
    pub statement: Fetch<Statement>,
    #[serde(default)]
    pub statement_request: Option<StatementRequest>,
    pub dividends: Fetch<Vec<Dividend>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Company {
    pub corp_code: String,
    pub name: String,
    pub fiscal_month: Option<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Security {
    pub stock_code: String,
    pub company: Company,
    pub share_class: Option<String>,
    pub share_class_reason: Option<String>,
    pub evidence: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Collection {
    pub reports: BTreeMap<String, Report>,
    #[serde(default)]
    pub staged_reports: Option<BTreeMap<String, Report>>,
    pub disclosures: Vec<BTreeMap<String, String>>,
    pub last_checked_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub disclosure_failure: Option<Failure>,
    #[serde(default)]
    pub refresh_version: u64,
    #[serde(default)]
    pub disclosure_version: u64,
    #[serde(default)]
    pub unpublished_check_version: u64,
}

pub const REPORT_CODES: [&str; 4] = ["11013", "11012", "11014", "11011"];
