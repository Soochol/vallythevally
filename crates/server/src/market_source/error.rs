use std::fmt;

use domain::KstTime;

use crate::api::{ApiErrorCode, ApiErrorReason};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFailure {
    pub code: ApiErrorCode,
    pub reason: ApiErrorReason,
    pub message: String,
    pub retry_at: Option<KstTime>,
    pub manual_action_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    UnknownSymbol,
    Malformed(String),
    Failed(SourceFailure),
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourceError::UnknownSymbol => f.write_str("없는 종목입니다"),
            SourceError::Malformed(message) => f.write_str(message),
            SourceError::Failed(failure) => f.write_str(&failure.message),
        }
    }
}

impl SourceError {
    pub fn retry_at(&self) -> Option<KstTime> {
        match self {
            SourceError::Failed(failure) => failure.retry_at,
            SourceError::UnknownSymbol | SourceError::Malformed(_) => None,
        }
    }
}

impl std::error::Error for SourceError {}
