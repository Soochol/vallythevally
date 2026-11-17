use serde::{Deserialize, Serialize};

use super::day::Day;

pub const DEFAULT_OPEN_MINUTE: u16 = 9 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceInput {
    Weekday,
    PublicHoliday,
    KrxClosure,
    Overrides,
    OpenTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Finding {
    Open,
    Closed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub input: EvidenceInput,
    pub finding: Finding,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verdict {
    Observed { open_minute: u16 },
    Closed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Judgment {
    pub day: Day,
    pub verdict: Verdict,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mismatch {
    ObservedWithoutIndexCandle,
    ClosedWithIndexCandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CrossCheck {
    Agrees,
    Disagrees { mismatch: Mismatch },
    Undetermined,
}

pub fn cross_check(judgment: &Judgment, index_candle_days: &[Day]) -> CrossCheck {
    let Some(earliest_candle) = index_candle_days.iter().min() else {
        return CrossCheck::Undetermined;
    };
    if judgment.day < *earliest_candle {
        return CrossCheck::Undetermined;
    }
    let has_candle = index_candle_days.contains(&judgment.day);
    match (judgment.verdict, has_candle) {
        (Verdict::Unknown, _) => CrossCheck::Undetermined,
        (Verdict::Observed { .. }, true) | (Verdict::Closed, false) => CrossCheck::Agrees,
        (Verdict::Observed { .. }, false) => {
            CrossCheck::Disagrees { mismatch: Mismatch::ObservedWithoutIndexCandle }
        }
        (Verdict::Closed, true) => CrossCheck::Disagrees { mismatch: Mismatch::ClosedWithIndexCandle },
    }
}
