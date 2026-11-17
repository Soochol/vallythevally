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

pub fn latest_universe_before(data_dir: &Path, date: u32) -> Result<Option<UniverseFile>, StoreError> {
    let folder = folder(data_dir);
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(StoreError::Read { path: folder, cause: error.to_string() }),
    };
    let latest = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().and_then(universe_date_of_name))
        .filter(|candidate| *candidate < date)
        .max();
    latest.map(|latest| read_universe(data_dir, latest)).transpose()
}

fn universe_date_of_name(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    (digits.len() == 8 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

pub fn write_universe(data_dir: &Path, file: &UniverseFile) -> Result<(), StoreError> {
    write_json(universe_path(data_dir, file.date), file)
}

pub fn write_rejected(data_dir: &Path, file: &RejectedFile) -> Result<(), StoreError> {
    write_json(folder(data_dir).join(format!("{}.rejected.json", file.date)), file)
}

pub fn write_after_close(data_dir: &Path, file: &AfterCloseFile) -> Result<(), StoreError> {
    write_json(folder(data_dir).join(format!("{}.after.json", file.date)), file)
}
