use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::model::{AfterCloseFile, FORMAT_VERSION, RejectedFile, UniverseFile};
use crate::build::store::write_atomically;

const FOLDER: &str = "universe";

#[derive(Debug)]
pub enum StoreError {
    Read { path: PathBuf, cause: String },
    Write { path: PathBuf, cause: io::Error },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Read { path, cause } => write!(formatter, "{}를 읽을 수 없습니다: {cause}", path.display()),
            StoreError::Write { path, cause } => write!(formatter, "{}를 쓸 수 없습니다: {cause}", path.display()),
        }
    }
}

impl std::error::Error for StoreError {}

fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join(FOLDER)
}

fn universe_path(data_dir: &Path, date: u32) -> PathBuf {
    folder(data_dir).join(format!("{date}.json"))
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, StoreError> {
    let read_error = |cause: String| StoreError::Read { path: path.to_owned(), cause };
    let bytes = fs::read(path).map_err(|error| read_error(error.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|error| read_error(error.to_string()))
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), StoreError> {
    let mut bytes = serde_json::to_vec_pretty(value).expect("목록 파일은 언제나 직렬화된다");
    bytes.push(b'\n');
    write_atomically(&path, &bytes).map_err(|cause| StoreError::Write { path, cause })
}

pub fn read_universe(data_dir: &Path, date: u32) -> Result<UniverseFile, StoreError> {
    let path = universe_path(data_dir, date);
    let file: UniverseFile = read_json(&path)?;
    if file.format_version != FORMAT_VERSION {
        return Err(StoreError::Read { path, cause: format!("형식 버전 {}은 지원하지 않습니다", file.format_version) });
    }
    Ok(file)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedFile {
    pub date: u32,
    pub cause: String,
}

#[derive(Debug, Default)]
pub struct Previous {
    pub file: Option<UniverseFile>,
    pub skipped: Vec<SkippedFile>,
}

pub fn latest_readable_before(data_dir: &Path, date: u32) -> Result<Previous, StoreError> {
    let folder = folder(data_dir);
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Previous::default()),
        Err(error) => return Err(StoreError::Read { path: folder, cause: error.to_string() }),
    };
    let mut candidates: Vec<u32> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().and_then(universe_date_of_name))
        .filter(|candidate| *candidate < date)
        .collect();
    candidates.sort_unstable_by(|a, b| b.cmp(a));
    let mut previous = Previous::default();
    for candidate in candidates {
        match read_universe(data_dir, candidate) {
            Ok(file) => {
                previous.file = Some(file);
                break;
            }
            Err(error) => previous.skipped.push(SkippedFile { date: candidate, cause: error.to_string() }),
        }
    }
    Ok(previous)
}

pub fn read_universe_if_present(data_dir: &Path, date: u32) -> Result<Option<UniverseFile>, StoreError> {
    match universe_path(data_dir, date).try_exists() {
        Ok(true) => read_universe(data_dir, date).map(Some),
        Ok(false) => Ok(None),
        Err(error) => Err(StoreError::Read { path: universe_path(data_dir, date), cause: error.to_string() }),
    }
}

fn universe_date_of_name(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    (digits.len() == 8 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

pub fn write_universe(data_dir: &Path, file: &UniverseFile) -> Result<(), StoreError> {
    write_json(universe_path(data_dir, file.date), file)
}

fn rejected_path(data_dir: &Path, date: u32) -> PathBuf {
    folder(data_dir).join(format!("{date}.rejected.json"))
}

pub fn write_rejected(data_dir: &Path, file: &RejectedFile) -> Result<(), StoreError> {
    write_json(rejected_path(data_dir, file.date), file)
}

pub fn remove_rejected(data_dir: &Path, date: u32) -> Result<(), StoreError> {
    let path = rejected_path(data_dir, date);
    match fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(StoreError::Write { path, cause: error }),
        _ => Ok(()),
    }
}

pub fn write_after_close(data_dir: &Path, file: &AfterCloseFile) -> Result<(), StoreError> {
    write_json(folder(data_dir).join(format!("{}.after.json", file.date)), file)
}
