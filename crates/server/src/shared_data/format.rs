use std::path::{Path, PathBuf};

use domain::KstDate;
use serde::{Deserialize, Serialize};

pub const FORMAT_VERSION: u32 = 1;

pub const SNAPSHOT_EXTENSION: &str = "json";
pub const FEED_EXTENSION: &str = "jsonl";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataKind {
    Probe,
    KiwoomThemes,
}

impl DataKind {
    pub fn folder(self) -> &'static str {
        match self {
            DataKind::Probe => "probe",
            DataKind::KiwoomThemes => "kiwoom_themes",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Broker {
    Kiwoom,
    Kis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceKey {
    pub key_name: String,
    pub broker: Broker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format_version: u32,
    pub kind: DataKind,
    pub observation_date: String,
    pub as_of: i64,
    pub written_at: i64,
    pub sources: Vec<SourceKey>,
}

impl Header {
    pub fn new(kind: DataKind, observation_date: KstDate, as_of: i64, written_at: i64, sources: Vec<SourceKey>) -> Self {
        Header { format_version: FORMAT_VERSION, kind, observation_date: observation_date.yyyymmdd(), as_of, written_at, sources }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope<B> {
    pub header: Header,
    pub body: B,
}

#[derive(Debug, Deserialize)]
pub struct HeaderOnly {
    pub header: Header,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Loaded<B> {
    pub header: Header,
    pub body: B,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeBody {
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeItem {
    pub seq: u64,
}

pub struct Probe;

pub fn data_path(dir: &Path, kind: DataKind, observation_date: &str, extension: &str) -> PathBuf {
    dir.join(kind.folder()).join(format!("{observation_date}.{extension}"))
}

pub fn newest_file(dir: &Path, kind: DataKind, extension: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir.join(kind.folder())).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let stem = name.strip_suffix(extension)?.strip_suffix('.')?;
            KstDate::parse_yyyymmdd(stem)?;
            Some((stem.to_owned(), entry.path()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, path)| path)
}

#[cfg(unix)]
pub fn file_identity(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

#[cfg(not(unix))]
pub fn file_identity(_: &std::fs::Metadata) -> u64 {
    0
}
