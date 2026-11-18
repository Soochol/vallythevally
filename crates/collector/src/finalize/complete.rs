use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::check::VerifyReport;
use super::observation::{ObservationSummary, read_observation};
use super::coverage::{CoverageInput, StockCoverage, build_coverage, read_journal, read_timelines};
use super::{store_dir, temporary_store_dir};
use crate::build::store::write_atomically;
use crate::keys::KeyRole;
use crate::plan::{PlanFile, plan_path, read_plan};
use crate::protocol::RealType;

pub const COMPLETE_FILE_NAME: &str = "complete.json";
pub const COMPLETE_FORMAT_VERSION: u32 = 1;
pub const REPLACED_SUFFIX: &str = ".old-";

#[derive(Debug, Serialize)]
pub struct VerifySummary {
    pub passed: bool,
    pub mismatch_count: u64,
    pub buckets: usize,
    pub lines_total: u64,
    pub lines_finalized: u64,
    pub lines_control: u64,
    pub lines_unfinalized: u64,
}

#[derive(Debug, Serialize)]
pub struct KeySummary {
    pub name: String,
    pub role: KeyRole,
    pub stocks: usize,
    pub market_types: Vec<RealType>,
    pub load: u64,
}

#[derive(Debug, Serialize)]
pub struct PlanSummary {
    pub created_at: String,
    pub active_keys: usize,
    pub universe_replaced: bool,
    pub planned_stocks: usize,
    pub excluded: usize,
    pub unregistered: usize,
    pub alerts: Vec<String>,
    pub keys: Vec<KeySummary>,
}

#[derive(Debug, Serialize)]
pub struct CompleteFile {
    pub format_version: u32,
    pub date: u32,
    pub verify: VerifySummary,
    pub plan: Option<PlanSummary>,
    pub observation: ObservationSummary,
    pub stocks: Vec<StockCoverage>,
}

fn summarize_plan(plan: &PlanFile) -> PlanSummary {
    PlanSummary {
        created_at: plan.created_at.clone(),
        active_keys: plan.input.active_keys,
        universe_replaced: plan.input.universe_replaced.is_some(),
        planned_stocks: plan.keys.iter().map(|share| share.stocks.len()).sum::<usize>() + plan.excluded.len() + plan.unregistered.len(),
        excluded: plan.excluded.len(),
        unregistered: plan.unregistered.len(),
        alerts: plan.alerts.clone(),
        keys: plan
            .keys
            .iter()
            .map(|share| KeySummary {
                name: share.name.as_str().to_owned(),
                role: share.role,
                stocks: share.stocks.len(),
                market_types: share.market_types.clone(),
                load: share.load,
            })
            .collect(),
    }
}

pub fn build_complete(data_dir: &Path, date: u32, report: &VerifyReport) -> io::Result<CompleteFile> {
    let plan = if plan_path(data_dir, date).exists() {
        Some(read_plan(data_dir, date).map_err(|error| io::Error::other(error.to_string()))?)
    } else {
        None
    };
    let journal = read_journal(data_dir, date)?;
    let observation = read_observation(data_dir, date)?;
    let timelines = read_timelines(data_dir, date)?;
    let stocks = build_coverage(&CoverageInput { plan: plan.as_ref(), journal: &journal, timelines: &timelines, symbol_messages: &report.symbol_messages });
    Ok(CompleteFile {
        format_version: COMPLETE_FORMAT_VERSION,
        date,
        verify: VerifySummary {
            passed: report.passed,
            mismatch_count: report.mismatch_count,
            buckets: report.buckets,
            lines_total: report.lines.total,
            lines_finalized: report.lines.finalized,
            lines_control: report.lines.control,
            lines_unfinalized: report.lines.unfinalized.total,
        },
        plan: plan.as_ref().map(summarize_plan),
        observation,
        stocks,
    })
}

pub fn write_complete(store_dir: &Path, complete: &CompleteFile) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(complete).expect("정리 완료 표시는 항상 JSON이 된다");
    bytes.push(b'\n');
    write_atomically(&store_dir.join(COMPLETE_FILE_NAME), &bytes)
}

fn store_root(data_dir: &Path) -> PathBuf {
    store_dir(data_dir, 0).parent().expect("저장소 폴더에는 부모가 있다").to_path_buf()
}

fn replaced_dirs(data_dir: &Path, date: u32) -> io::Result<Vec<PathBuf>> {
    let prefix = format!("{date}{REPLACED_SUFFIX}");
    let mut found = Vec::new();
    let entries = match fs::read_dir(store_root(data_dir)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(found),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let path = entry?.path();
        if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&prefix)) {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

pub fn recover_interrupted_swap(data_dir: &Path, date: u32) -> io::Result<()> {
    let published = store_dir(data_dir, date);
    let temporary = temporary_store_dir(data_dir, date);
    let replaced = replaced_dirs(data_dir, date)?;
    if replaced.is_empty() {
        return Ok(());
    }
    if published.is_dir() {
        return replaced.iter().try_for_each(fs::remove_dir_all);
    }
    if temporary.join(COMPLETE_FILE_NAME).is_file() {
        fs::rename(&temporary, &published)?;
        return replaced.iter().try_for_each(fs::remove_dir_all);
    }
    let (newest, older) = replaced.split_last().expect("비어 있지 않다");
    fs::rename(newest, &published)?;
    older.iter().try_for_each(fs::remove_dir_all)
}

pub fn publish_store(data_dir: &Path, date: u32) -> io::Result<()> {
    let published = store_dir(data_dir, date);
    let temporary = temporary_store_dir(data_dir, date);
    if !published.exists() {
        return fs::rename(&temporary, &published);
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    let replaced = store_root(data_dir).join(format!("{date}{REPLACED_SUFFIX}{stamp}"));
    fs::rename(&published, &replaced)?;
    fs::rename(&temporary, &published)?;
    fs::remove_dir_all(&replaced)
}
