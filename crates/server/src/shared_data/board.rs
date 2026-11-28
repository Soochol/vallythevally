use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use domain::KstTime;
use serde::de::DeserializeOwned;

use super::format::{DataKind, Envelope, FORMAT_VERSION, HeaderOnly, Loaded, SNAPSHOT_EXTENSION, newest_file};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Signature {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
    identity: u64,
}

impl Signature {
    pub(super) fn of(path: PathBuf, meta: &Metadata) -> Self {
        Signature { path, modified: meta.modified().ok(), len: meta.len(), identity: super::format::file_identity(meta) }
    }
}

pub struct Board<B> {
    kind: DataKind,
    current: RwLock<Option<Arc<Loaded<B>>>>,
    errors: AtomicU64,
    seen: Mutex<Option<Signature>>,
}

impl<B: DeserializeOwned> Board<B> {
    pub fn new(kind: DataKind) -> Self {
        Board { kind, current: RwLock::new(None), errors: AtomicU64::new(0), seen: Mutex::new(None) }
    }

    pub fn current(&self) -> Option<Arc<Loaded<B>>> {
        self.current.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }

    pub fn age_secs(&self, now: KstTime) -> Option<i64> {
        self.current().map(|loaded| now.unix() - loaded.header.as_of)
    }

    pub fn poll(&self, dir: &Path) {
        let kind = self.kind;
        let Some(path) = newest_file(dir, kind, SNAPSHOT_EXTENSION) else { return };
        let Ok(meta) = std::fs::metadata(&path) else { return };
        let signature = Signature::of(path.clone(), &meta);
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.as_ref() == Some(&signature) {
            return;
        }
        *seen = Some(signature);
        drop(seen);
        match read_snapshot::<B>(&path, kind) {
            Ok(loaded) => *self.current.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(loaded)),
            Err(reason) => {
                self.errors.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(path = %path.display(), %reason, "공용 자료 파일을 읽지 못해 이전 판을 둡니다");
            }
        }
    }
}

pub fn read_snapshot<B: DeserializeOwned>(path: &Path, kind: DataKind) -> Result<Loaded<B>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let peek: HeaderOnly = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if peek.header.format_version != FORMAT_VERSION {
        return Err(format!("모르는 형식 버전 {}", peek.header.format_version));
    }
    if peek.header.kind != kind {
        return Err("폴더와 자료 종류가 다릅니다".to_owned());
    }
    let Envelope { header, body } = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Loaded { header, body })
}
