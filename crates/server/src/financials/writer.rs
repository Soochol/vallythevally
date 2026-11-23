use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use crate::instance::{InstanceLock, LockError};
use super::Financials;

const LOCK_SUFFIX: &str = ".writer.lock";

#[derive(Debug)]
pub enum WriterError {
    Held { pid: Option<u32>, path: PathBuf },
    Unavailable { path: PathBuf, error: std::io::Error },
}

impl std::fmt::Display for WriterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Held { pid: Some(pid), path } => write!(formatter, "다른 프로세스가 재무 저장소에 쓰고 있습니다(pid {pid}, {})", path.display()),
            Self::Held { pid: None, path } => write!(formatter, "다른 프로세스가 재무 저장소에 쓰고 있습니다({})", path.display()),
            Self::Unavailable { path, error } => write!(formatter, "재무 저장소 쓰기 잠금 파일을 만들 수 없습니다({}): {error}", path.display()),
        }
    }
}

impl std::error::Error for WriterError {}

pub fn writer_lock_path(database: &Path) -> PathBuf {
    let mut name = database.as_os_str().to_owned();
    name.push(LOCK_SUFFIX);
    PathBuf::from(name)
}

#[derive(Default)]
pub(super) struct WriterSeat(Mutex<Option<InstanceLock>>);

pub fn acquire_writer_lock(database: &Path) -> Result<InstanceLock, WriterError> {
    match InstanceLock::acquire(&writer_lock_path(database)) {
        Ok(lock) => Ok(lock),
        Err(LockError::Held { pid, path }) => Err(WriterError::Held { pid, path }),
        Err(LockError::Io { path, error }) => Err(WriterError::Unavailable { path, error }),
    }
}

impl WriterSeat {
    fn claim(&self, database: &Path) -> Result<(), WriterError> {
        let mut held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if held.is_none() { *held = Some(acquire_writer_lock(database)?); }
        Ok(())
    }

    fn adopt(&self, lock: InstanceLock) {
        let mut held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if held.is_none() { *held = Some(lock); }
    }
}

impl Financials {
    pub fn claim_writer(&self) -> Result<(), WriterError> {
        match &self.store {
            Ok(store) => self.writer.claim(&store.path()),
            Err(_) => Ok(()),
        }
    }

    pub fn hold_writer(&self, lock: InstanceLock) { self.writer.adopt(lock); }

    pub(super) fn may_write(&self) -> bool {
        if self.client.is_none() { return true; }
        match self.claim_writer() {
            Ok(()) => true,
            Err(error) => { tracing::warn!(%error, "재무 저장소의 쓰는 쪽을 쥘 수 없어 업데이트를 띄우지 않습니다"); false }
        }
    }
}
