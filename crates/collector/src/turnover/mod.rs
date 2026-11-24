use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use domain::{StockCode, Venue};
use serde::{Deserialize, Serialize};
use server::kiwoom::api::StockQuotes;
use server::kiwoom::rest::{KiwoomRest, MergeScope, Priority};
use server::kiwoom::wire::QuoteRow;

use crate::build::store::write_atomically;
use crate::kst::KstTime;
use crate::universe::kst_stamp;

pub const FORMAT_VERSION: u32 = 1;
const FOLDER: &str = "turnover";
const COMBINED_SUFFIX: &str = "_AL";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnoverFile {
    pub format_version: u32,
    pub date: u32,
    pub fetched_at: String,
    pub traded_million_won: BTreeMap<String, u64>,
}

#[derive(Debug)]
pub enum TurnoverError {
    Fetch { detail: String },
    NoRowsForDate { date: u32 },
    Write { path: PathBuf, cause: io::Error },
}

impl fmt::Display for TurnoverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TurnoverError::Fetch { detail } => write!(formatter, "거래대금을 받지 못했습니다: {detail}"),
            TurnoverError::NoRowsForDate { date } => write!(formatter, "{date} 거래대금 행이 하나도 없습니다"),
            TurnoverError::Write { path, cause } => write!(formatter, "{}를 쓸 수 없습니다: {cause}", path.display()),
        }
    }
}

impl std::error::Error for TurnoverError {}

pub fn turnover_path(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join(FOLDER).join(format!("{date}.json"))
}

pub async fn collect_turnover(
    rest: &KiwoomRest,
    data_dir: &Path,
    date: u32,
    now: KstTime,
    codes: &[String],
) -> Result<TurnoverFile, TurnoverError> {
    let stock_codes: Vec<StockCode> = codes.iter().filter_map(|code| StockCode::parse(code).ok()).collect();
    let expected_dt = format!("{date:08}");
    let mut traded_million_won = BTreeMap::new();
    for chunk in stock_codes.chunks(StockQuotes::MAX) {
        let request = StockQuotes::new(chunk, Venue::Combined).expect("묶음은 1~MAX개다");
        let page = rest
            .call(&request, None, Priority::Background, MergeScope::default())
            .await
            .map_err(|error| TurnoverError::Fetch { detail: error.to_string() })?;
        collect_chunk_rows(&page.body.atn_stk_infr, chunk, &expected_dt, &mut traded_million_won);
    }
    if traded_million_won.is_empty() {
        return Err(TurnoverError::NoRowsForDate { date });
    }
    let file = TurnoverFile { format_version: FORMAT_VERSION, date, fetched_at: kst_stamp(now), traded_million_won };
    let path = turnover_path(data_dir, date);
    let mut bytes = serde_json::to_vec_pretty(&file).expect("거래대금 파일은 언제나 직렬화된다");
    bytes.push(b'\n');
    write_atomically(&path, &bytes).map_err(|cause| TurnoverError::Write { path, cause })?;
    Ok(file)
}

pub fn latest_turnover(data_dir: &Path, oldest: u32, before: u32) -> Option<TurnoverFile> {
    let folder = data_dir.join(FOLDER);
    let entries = fs::read_dir(&folder).ok()?;
    let mut candidates: Vec<u32> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().and_then(date_of_name))
        .filter(|candidate| *candidate >= oldest && *candidate < before)
        .collect();
    candidates.sort_unstable_by(|a, b| b.cmp(a));
    for candidate in candidates {
        if let Some(file) = read_turnover(data_dir, candidate) {
            return Some(file);
        }
    }
    None
}

fn collect_chunk_rows(rows: &[QuoteRow], chunk: &[StockCode], expected_dt: &str, out: &mut BTreeMap<String, u64>) {
    let wanted: HashSet<&str> = chunk.iter().map(StockCode::as_str).collect();
    let mut by_code: HashMap<&str, Vec<&QuoteRow>> = HashMap::new();
    for row in rows {
        if let Some(code) = row.stk_cd.strip_suffix(COMBINED_SUFFIX).filter(|code| wanted.contains(code)) {
            by_code.entry(code).or_default().push(row);
        }
    }
    for (code, matched) in by_code {
        if matched.len() == 1
            && matched[0].dt.trim() == expected_dt
            && let Some(value) = parse_amount(&matched[0].trde_prica)
        {
            out.insert(code.to_owned(), value);
        }
    }
}

fn parse_amount(text: &str) -> Option<u64> {
    text.trim().trim_start_matches(['+', '-']).parse().ok()
}

fn read_turnover(data_dir: &Path, date: u32) -> Option<TurnoverFile> {
    let bytes = fs::read(turnover_path(data_dir, date)).ok()?;
    let file: TurnoverFile = serde_json::from_slice(&bytes).ok()?;
    (file.format_version == FORMAT_VERSION && file.date == date).then_some(file)
}

fn date_of_name(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    (digits.len() == 8 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}
