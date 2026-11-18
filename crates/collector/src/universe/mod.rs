use std::path::{Path, PathBuf};

use server::kiwoom::rest::{KiwoomError, KiwoomRest, Priority};
use server::symbols::fetch_listing_rows;

use crate::kst::KstTime;

mod diff;
mod model;
mod store;

pub use diff::{Diff, Named, Renamed, diff};
pub use model::{AfterCloseFile, Entry, FORMAT_VERSION, MarketName, RejectedFile, ReplaceReason, Replacement, StockKind, UniverseFile};
pub use store::{SkippedFile, StoreError, after_close_path, read_universe, read_universe_if_present, universe_path};

const MAX_SHRINK_PERCENT: usize = 3;

#[derive(Debug)]
pub enum UniverseError {
    Store(StoreError),
    NoFallback { reason: ReplaceReason, detail: String, skipped: Vec<SkippedFile> },
    TodayListUnreadable { date: u32, cause: StoreError, reason: ReplaceReason, detail: String },
    NoMorningList { date: u32, cause: StoreError },
    AfterCloseFetch { detail: String },
}

impl std::fmt::Display for UniverseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UniverseError::Store(error) => error.fmt(formatter),
            UniverseError::NoFallback { detail, skipped, .. } => {
                write!(formatter, "대신 쓸 이전 목록이 없습니다: {detail}")?;
                if skipped.is_empty() {
                    return Ok(());
                }
                let causes: Vec<String> = skipped.iter().map(|file| format!("{}: {}", file.date, file.cause)).collect();
                write!(formatter, " (읽을 수 없어 건너뛴 파일: {})", causes.join("; "))
            }
            UniverseError::TodayListUnreadable { date, cause, detail, .. } => {
                write!(formatter, "{date} 목록 파일을 읽을 수 없고 새로 받은 목록도 쓰지 못하며({detail}) 대신 쓸 읽히는 이전 목록도 없어 파일을 그대로 둡니다: {cause}")
            }
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

fn clock_digits(time: KstTime) -> String {
    let seconds = time.ms_of_day / 1000;
    format!("{:02}{:02}{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovedAside {
    pub path: PathBuf,
    pub cause: String,
}

#[derive(Debug)]
pub struct Morning {
    pub file: UniverseFile,
    pub written: Written,
    pub moved_aside: Option<MovedAside>,
    pub skipped: Vec<SkippedFile>,
    pub warnings: Vec<String>,
}

pub async fn collect_morning(rest: &KiwoomRest, data_dir: &Path, date: u32, fetched_at: KstTime) -> Result<Morning, UniverseError> {
    let mut skipped = Vec::new();
    let mut unreadable_today = None;
    let existing = match store::read_universe_if_present(data_dir, date) {
        Ok(existing) => existing,
        Err(error) => {
            skipped.push(SkippedFile { date, cause: error.to_string() });
            unreadable_today = Some(error);
            None
        }
    };
    let before = store::latest_readable_before(data_dir, date)?;
    skipped.extend(before.skipped);
    for file in &skipped {
        tracing::warn!(date = file.date, cause = %file.cause, "읽을 수 없는 목록 파일을 건너뜁니다");
    }
    let previous = before.file;
    let aside_stamp = clock_digits(fetched_at);
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
            Ok(Morning { file, written: Written::NewList, moved_aside: None, skipped, warnings })
        }
        Fetched::Rejected(rejection) => {
            let rejected = RejectedFile {
                format_version: FORMAT_VERSION,
                date,
                fetched_at: fetched_at.clone(),
                reason: rejection.reason,
                detail: rejection.detail.clone(),
                previous_count: previous.as_ref().map(|previous| previous.stocks.len()),
                stocks: rejection.stocks,
                warnings: rejection.warnings,
            };
            if let Err(error) = store::write_rejected(data_dir, &rejected) {
                tracing::warn!(date, %error, "그날의 rejected 파일을 쓰지 못했습니다");
                warnings.push(error.to_string());
            }
            let mut moved_aside = None;
            if let Some(cause) = unreadable_today {
                if previous.is_none() {
                    return Err(UniverseError::TodayListUnreadable { date, cause, reason: rejection.reason, detail: rejection.detail });
                }
                let path = store::move_unreadable_aside(data_dir, date, aside_stamp)?;
                tracing::warn!(date, path = %path.display(), cause = %cause, "읽을 수 없는 그날 목록 파일을 옆으로 옮기고 이전 목록으로 대체합니다");
                moved_aside = Some(MovedAside { path, cause: cause.to_string() });
            }
            if let Some(file) = existing {
                let written = Written::LeftAsIs { reason: rejection.reason, detail: rejection.detail };
                return Ok(Morning { file, written, moved_aside: None, skipped, warnings });
            }
            let Some(previous) = previous else {
                return Err(UniverseError::NoFallback { reason: rejection.reason, detail: rejection.detail, skipped });
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
            Ok(Morning { file, written: Written::ReplacementList, moved_aside, skipped, warnings })
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
