use std::path::Path;

use server::kiwoom::rest::{KiwoomError, KiwoomRest, Priority};
use server::symbols::fetch_listing_rows;

use crate::kst::KstTime;

mod diff;
mod model;
mod store;

pub use diff::{Diff, Named, Renamed, diff};
pub use model::{AfterCloseFile, Entry, FORMAT_VERSION, MarketName, RejectedFile, ReplaceReason, Replacement, StockKind, UniverseFile};
pub use store::{SkippedFile, StoreError, read_universe};

const MAX_SHRINK_PERCENT: usize = 3;

#[derive(Debug)]
pub enum UniverseError {
    Store(StoreError),
    NoFallback { reason: ReplaceReason, detail: String },
    NoMorningList { date: u32, cause: StoreError },
    AfterCloseFetch { detail: String },
}

impl std::fmt::Display for UniverseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UniverseError::Store(error) => error.fmt(formatter),
            UniverseError::NoFallback { detail, .. } => write!(formatter, "대신 쓸 이전 목록이 없습니다: {detail}"),
            UniverseError::NoMorningList { date, cause } => write!(formatter, "{date} 아침 목록이 없습니다: {cause}"),
            UniverseError::AfterCloseFetch { detail } => write!(formatter, "마감 뒤 목록을 받지 못했습니다: {detail}"),
        }
    }
}

impl std::error::Error for UniverseError {}

impl From<StoreError> for UniverseError {
    fn from(error: StoreError) -> UniverseError {
        UniverseError::Store(error)
    }
}

pub(crate) fn kst_stamp(time: KstTime) -> String {
    let (date, seconds) = (time.date, time.ms_of_day / 1000);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}+09:00",
        date / 10_000,
        date / 100 % 100,
        date % 100,
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

fn shrank_too_much(previous_count: usize, count: usize) -> bool {
    (previous_count.saturating_sub(count)) * 100 > previous_count * MAX_SHRINK_PERCENT
}

struct Rejection {
    reason: ReplaceReason,
    detail: String,
    stocks: Vec<Entry>,
    warnings: Vec<String>,
}

enum Fetched {
    Whole { stocks: Vec<Entry>, warnings: Vec<String> },
    Rejected(Rejection),
}

async fn fetch_stocks(rest: &KiwoomRest, previous: Option<&UniverseFile>) -> Fetched {
    let pages = match fetch_listing_rows(rest, Priority::Background).await {
        Ok(pages) => pages,
        Err(error) => return Fetched::Rejected(failed(error)),
    };
    let classified = model::classify_rows(&pages.rows);
    if pages.stopped_at_page_limit_with_pages_left {
        return Fetched::Rejected(Rejection {
            reason: ReplaceReason::CutOff,
            detail: format!("연속조회가 쪽 수 상한({})에 닿았는데 다음 쪽이 남아 있습니다", server::symbols::MAX_LIST_PAGES),
            stocks: classified.stocks,
            warnings: classified.warnings,
        });
    }
    if let Some(previous) = previous.filter(|previous| shrank_too_much(previous.stocks.len(), classified.stocks.len())) {
        return Fetched::Rejected(Rejection {
            reason: ReplaceReason::Shrunk,
            detail: format!("종목이 {}개에서 {}개로 {MAX_SHRINK_PERCENT}%를 넘게 줄었습니다", previous.stocks.len(), classified.stocks.len()),
            stocks: classified.stocks,
            warnings: classified.warnings,
        });
    }
    Fetched::Whole { stocks: classified.stocks, warnings: classified.warnings }
}

fn failed(error: KiwoomError) -> Rejection {
    Rejection { reason: ReplaceReason::FetchFailed, detail: format!("조회가 실패했습니다: {error}"), stocks: Vec::new(), warnings: Vec::new() }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    NewList,
    ReplacementList,
    LeftAsIs { reason: ReplaceReason, detail: String },
}

#[derive(Debug)]
pub struct Morning {
    pub file: UniverseFile,
    pub written: Written,
    pub skipped: Vec<SkippedFile>,
    pub warnings: Vec<String>,
}

pub async fn collect_morning(rest: &KiwoomRest, data_dir: &Path, date: u32, fetched_at: KstTime) -> Result<Morning, UniverseError> {
    let mut skipped = Vec::new();
    let existing = match store::read_universe_if_present(data_dir, date) {
        Ok(existing) => existing,
        Err(error) => {
            skipped.push(SkippedFile { date, cause: error.to_string() });
            None
        }
    };
    let before = store::latest_readable_before(data_dir, date)?;
    skipped.extend(before.skipped);
    for file in &skipped {
        tracing::warn!(date = file.date, cause = %file.cause, "읽을 수 없는 목록 파일을 건너뜁니다");
    }
    let previous = before.file;
    let fetched_at = kst_stamp(fetched_at);
    let mut warnings = Vec::new();
    match fetch_stocks(rest, previous.as_ref()).await {
        Fetched::Whole { stocks, warnings: list_warnings } => {
            let diff = previous.as_ref().map(|previous| diff::diff(&previous.stocks, &stocks)).unwrap_or_default();
            let file = UniverseFile { format_version: FORMAT_VERSION, date, fetched_at, stocks, warnings: list_warnings, diff, replaced: None };
            store::write_universe(data_dir, &file)?;
            if let Err(error) = store::remove_rejected(data_dir, date) {
                tracing::warn!(date, %error, "그날의 rejected 파일을 지우지 못했습니다");
                warnings.push(error.to_string());
            }
            Ok(Morning { file, written: Written::NewList, skipped, warnings })
        }
        Fetched::Rejected(rejection) => {
            store::write_rejected(
                data_dir,
                &RejectedFile {
                    format_version: FORMAT_VERSION,
                    date,
                    fetched_at: fetched_at.clone(),
                    reason: rejection.reason,
                    detail: rejection.detail.clone(),
                    previous_count: previous.as_ref().map(|previous| previous.stocks.len()),
                    stocks: rejection.stocks,
                    warnings: rejection.warnings,
                },
            )?;
            if let Some(file) = existing {
                let written = Written::LeftAsIs { reason: rejection.reason, detail: rejection.detail };
                return Ok(Morning { file, written, skipped, warnings });
            }
            let Some(previous) = previous else {
                return Err(UniverseError::NoFallback { reason: rejection.reason, detail: rejection.detail });
            };
            let replacement = Replacement { reason: rejection.reason, detail: rejection.detail, source_date: previous.date };
            let file = UniverseFile {
                format_version: FORMAT_VERSION,
                date,
                fetched_at,
                stocks: previous.stocks,
                warnings: previous.warnings,
                diff: Diff::default(),
                replaced: Some(replacement),
            };
            store::write_universe(data_dir, &file)?;
            Ok(Morning { file, written: Written::ReplacementList, skipped, warnings })
        }
    }
}

pub async fn collect_after_close(rest: &KiwoomRest, data_dir: &Path, date: u32, fetched_at: KstTime) -> Result<AfterCloseFile, UniverseError> {
    let morning = read_universe(data_dir, date).map_err(|cause| UniverseError::NoMorningList { date, cause })?;
    let pages = fetch_listing_rows(rest, Priority::Background)
        .await
        .map_err(|error| UniverseError::AfterCloseFetch { detail: error.to_string() })?;
    if pages.stopped_at_page_limit_with_pages_left {
        return Err(UniverseError::AfterCloseFetch { detail: "연속조회가 쪽 수 상한에 닿았는데 다음 쪽이 남아 있습니다".into() });
    }
    let classified = model::classify_rows(&pages.rows);
    let file = AfterCloseFile {
        format_version: FORMAT_VERSION,
        date,
        fetched_at: kst_stamp(fetched_at),
        morning_count: morning.stocks.len(),
        after_close_count: classified.stocks.len(),
        diff: diff::diff(&morning.stocks, &classified.stocks),
        warnings: classified.warnings,
    };
    store::write_after_close(data_dir, &file)?;
    Ok(file)
}
