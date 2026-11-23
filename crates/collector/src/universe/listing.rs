use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use domain::{Listing, ListingRow, Symbol, SymbolKind, classify};
use serde::{Deserialize, Serialize};

use super::store::StoreError;
use crate::build::store::write_atomically;

const FOLDER: &str = "listing";
const KEPT_DAYS: usize = 3;

pub const LISTING_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedStock {
    pub code: String,
    pub nxt_enabled: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exchange_traded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingFile {
    pub format_version: u32,
    pub date: u32,
    pub fetched_at: String,
    pub stocks: Vec<ListedStock>,
}

pub fn listed_stocks(rows: &[ListingRow]) -> Vec<ListedStock> {
    let mut stocks: Vec<ListedStock> = rows
        .iter()
        .filter_map(|row| match classify(row) {
            Listing::Include(info) => match info.symbol {
                Symbol::Stock(code) => Some(ListedStock { code: code.as_str().to_owned(), nxt_enabled: info.nxt_enabled, exchange_traded: matches!(info.kind, SymbolKind::Etf | SymbolKind::Etn) }),
                Symbol::Index(_) => None,
            },
            Listing::Unknown(_) => None,
        })
        .collect();
    stocks.sort_by(|a, b| a.code.cmp(&b.code));
    stocks.dedup_by(|later, first| later.code == first.code);
    stocks
}

fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join(FOLDER)
}

pub fn listing_path(data_dir: &Path, date: u32) -> PathBuf {
    folder(data_dir).join(format!("{date}.json"))
}

fn date_of_name(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    (digits.len() == 8 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

fn listing_dates(data_dir: &Path) -> io::Result<Vec<u32>> {
    let entries = match fs::read_dir(folder(data_dir)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut dates: Vec<u32> = entries.filter_map(Result::ok).filter_map(|entry| entry.file_name().to_str().and_then(date_of_name)).collect();
    dates.sort_unstable_by(|a, b| b.cmp(a));
    Ok(dates)
}

pub fn write_listing(data_dir: &Path, file: &ListingFile) -> Result<(), StoreError> {
    let path = listing_path(data_dir, file.date);
    let bytes = serde_json::to_vec(file).expect("목록 파일은 언제나 직렬화된다");
    write_atomically(&path, &bytes).map_err(|cause| StoreError::Write { path, cause })?;
    for stale in listing_dates(data_dir).unwrap_or_default().into_iter().skip(KEPT_DAYS) {
        let _ = fs::remove_file(listing_path(data_dir, stale));
    }
    Ok(())
}

pub fn read_listing_upto(data_dir: &Path, date: u32) -> Result<Option<ListingFile>, StoreError> {
    let dates = listing_dates(data_dir).map_err(|cause| StoreError::Read { path: folder(data_dir), cause: cause.to_string() })?;
    let Some(found) = dates.into_iter().find(|candidate| *candidate <= date) else { return Ok(None) };
    let path = listing_path(data_dir, found);
    let bytes = fs::read(&path).map_err(|cause| StoreError::Read { path: path.clone(), cause: cause.to_string() })?;
    let file: ListingFile = serde_json::from_slice(&bytes).map_err(|cause| StoreError::Malformed { path: path.clone(), cause: cause.to_string() })?;
    if file.format_version != LISTING_FORMAT_VERSION {
        return Err(StoreError::Malformed { path, cause: format!("형식 버전 {}은 지원하지 않습니다", file.format_version) });
    }
    Ok(Some(file))
}
