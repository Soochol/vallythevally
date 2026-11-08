//! 서버를 하나만 띄우는 잠금 파일(backend.md §4.1, ADR 0004).

use std::fmt;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

/// 프로세스 수명 동안 쥐고 있는다. drop하거나 프로세스가 죽으면 OS가 잠금을 푼다.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

#[derive(Debug)]
pub enum LockError {
    /// 다른 프로세스가 잡고 있다. 파일에 적힌 pid를 함께 돌려준다(읽을 수 있으면).
    Held { pid: Option<u32>, path: PathBuf },
    /// 디렉터리나 파일을 만들 수 없다.
    Io { path: PathBuf, error: std::io::Error },
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LockError::Held { pid: Some(pid), path } => {
                write!(f, "다른 서버가 이미 실행 중이다(pid {pid}, {})", path.display())
            }
            LockError::Held { pid: None, path } => {
                write!(f, "다른 서버가 이미 실행 중이다(pid 모름, {})", path.display())
            }
            LockError::Io { path, error } => write!(f, "잠금 파일을 만들 수 없다({}): {error}", path.display()),
        }
    }
}

impl std::error::Error for LockError {}

impl InstanceLock {
    /// 이미 잡혀 있으면 기다리지 않고 바로 실패한다.
    pub fn acquire(path: &Path) -> Result<InstanceLock, LockError> {
        let io = |error| LockError::Io { path: path.to_owned(), error };
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(io)?;
        }
        // 잠그기 전에 내용을 지우면 잡고 있는 서버의 pid가 사라진다. 그래서 truncate는 잠근 뒤에 한다.
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(io)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                let mut text = String::new();
                let pid = file.read_to_string(&mut text).ok().and_then(|_| text.trim().parse().ok());
                return Err(LockError::Held { pid, path: path.to_owned() });
            }
            Err(TryLockError::Error(e)) => return Err(io(e)),
        }
        file.set_len(0).map_err(io)?;
        file.seek(SeekFrom::Start(0)).map_err(io)?;
        writeln!(file, "{}", std::process::id()).map_err(io)?;
        Ok(InstanceLock { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_is_held_and_release_frees_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/server.lock");
        let first = InstanceLock::acquire(&path).unwrap();
        match InstanceLock::acquire(&path) {
            Err(LockError::Held { pid, .. }) => assert_eq!(pid, Some(std::process::id())),
            other => panic!("Held가 아님: {other:?}"),
        }
        let msg = InstanceLock::acquire(&path).unwrap_err().to_string();
        assert!(msg.contains("다른 서버가 이미 실행 중이다") && msg.contains("server.lock"), "{msg}");
        drop(first);
        InstanceLock::acquire(&path).unwrap();
    }

    #[test]
    fn leftover_file_without_lock_does_not_block() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.lock");
        std::fs::write(&path, "99999\n").unwrap();
        let _lock = InstanceLock::acquire(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), std::process::id().to_string());
    }

    #[test]
    fn created_directory_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vallythevally/server.lock");
        let _lock = InstanceLock::acquire(&path).unwrap();
        let mode = std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn unwritable_location_is_an_io_error() {
        assert!(matches!(InstanceLock::acquire(Path::new("/proc/vally-test/server.lock")), Err(LockError::Io { .. })));
    }
}
