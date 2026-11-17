use domain::{Listing, ListingRow, Market, SymbolKind, classify};
use serde::{Deserialize, Serialize};

use super::diff::Diff;

pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketName {
    Kospi,
    Kosdaq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StockKind {
    Common,
    Preferred,
    Spac,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub code: String,
    pub name: String,
    pub market: MarketName,
    pub kind: StockKind,
    pub status: Vec<String>,
    pub registered: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplaceReason {
    FetchFailed,
    Shrunk,
    CutOff,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Replacement {
    pub reason: ReplaceReason,
    pub detail: String,
    pub source_date: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UniverseFile {
    pub format_version: u32,
    pub date: u32,
    pub fetched_at: String,
    pub stocks: Vec<Entry>,
    pub warnings: Vec<String>,
    pub diff: Diff,
    pub replaced: Option<Replacement>,
}

impl UniverseFile {
    pub fn registrable(&self) -> impl Iterator<Item = &Entry> {
        self.stocks.iter().filter(|entry| entry.registered)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedFile {
    pub format_version: u32,
    pub date: u32,
    pub fetched_at: String,
    pub reason: ReplaceReason,
    pub detail: String,
    pub previous_count: Option<usize>,
    pub stocks: Vec<Entry>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AfterCloseFile {
    pub format_version: u32,
    pub date: u32,
    pub fetched_at: String,
    pub morning_count: usize,
    pub after_close_count: usize,
    pub warnings: Vec<String>,
    pub diff: Diff,
}

pub struct Classified {
    pub stocks: Vec<Entry>,
    pub warnings: Vec<String>,
}

pub fn classify_rows(rows: &[ListingRow]) -> Classified {
    let mut stocks: Vec<Entry> = Vec::new();
    let mut warnings = Vec::new();
    for row in rows {
        let info = match classify(row) {
            Listing::Include(info) => info,
            Listing::Exclude => continue,
            Listing::Unknown(why) => {
                warnings.push(why);
                continue;
            }
        };
        let kind = match info.kind {
            SymbolKind::Common if row.is_spac() => StockKind::Spac,
            SymbolKind::Common => StockKind::Common,
            SymbolKind::Preferred => StockKind::Preferred,
            SymbolKind::Etf | SymbolKind::Reit | SymbolKind::Index => continue,
        };
        let market = match info.market {
            Market::Kospi => MarketName::Kospi,
            Market::Kosdaq => MarketName::Kosdaq,
        };
        if stocks.iter().any(|entry| entry.code == row.code) {
            warnings.push(format!("종목코드가 겹칩니다: {} {}", row.code, row.name));
            continue;
        }
        let mut status = Vec::new();
        for (label, parsed) in row.audit_statuses() {
            if parsed == domain::AuditStatus::Unknown {
                warnings.push(format!("모르는 auditInfo 상태 {label:?}({} {})", row.code, row.name));
            }
            if !label.is_empty() {
                status.push(label.to_owned());
            }
        }
        stocks.push(Entry { code: row.code.clone(), name: row.name.clone(), market, kind, status, registered: !row.is_trading_halted() });
    }
    stocks.sort_by(|a, b| a.code.cmp(&b.code));
    Classified { stocks, warnings }
}
