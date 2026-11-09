//! 저장소 밖 토큰 파일(ADR 0004, backend.md §4.1). 서버와 키움 실측 프로그램이 같은 파일을 쓴다.

use std::fmt;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::instance::InstanceLock;

/// 파일 내용. 토큰이 들어 있으므로 `Debug`를 두지 않는다.
#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub struct Saved {
    pub token: Option<SavedToken>,
    /// 유닉스 초. 키움 실측 프로그램도 이 파일을 읽고 쓴다.
    pub last_request_at: i64,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedToken {
    pub value: String,
    /// au10001 응답의 `expires_dt` 그대로(KST `YYYYMMDDhhmmss`).
    pub expires_dt: String,
    pub issued_at: i64,
}

/// 경로와 원인. 파일 내용은 담지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileError(String);

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct TokenFile {
    path: PathBuf,
}

impl TokenFile {
    pub fn new(path: PathBuf, _held: &InstanceLock) -> Self {
        TokenFile { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn error(&self, what: impl fmt::Display) -> FileError {
        FileError(format!("{}: {what}", self.path.display()))
    }

    /// 파일이 없으면(처음 실행) `None`. 있는데 못 읽으면 오류다.
    pub fn load(&self) -> Result<Option<Saved>, FileError> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(self.error(e)),
        };
        serde_json::from_str(&text).map(Some).map_err(|e| self.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))
    }

    pub fn save(&self, saved: &Saved) -> Result<(), FileError> {
        let dir = self.path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let write = || -> std::io::Result<()> {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
            let tmp = dir.join(format!(".token.json.{}.tmp", std::process::id()));
            let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            file.write_all(&serde_json::to_vec(saved).expect("문자열과 정수만 담은 구조체"))?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        };
        write().map_err(|e| self.error(e))
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;

    pub fn temp_token_file() -> (tempfile::TempDir, InstanceLock, TokenFile) {
        let dir = tempfile::tempdir().unwrap();
        let lock = InstanceLock::acquire(&dir.path().join("server.lock")).unwrap();
        let file = TokenFile::new(dir.path().join("state/vallythevally/token.json"), &lock);
        (dir, lock, file)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::testing::temp_token_file;
    use super::*;

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn round_trip_with_private_permissions() {
        let (_dir, _lock, file) = temp_token_file();
        assert!(file.load().unwrap().is_none());
        let saved = Saved {
            token: Some(SavedToken { value: "FAKE-TOKEN-file-1".into(), expires_dt: "20261110090000".into(), issued_at: 10 }),
            last_request_at: 9,
        };
        file.save(&saved).unwrap();
        file.save(&saved).unwrap();
        assert!(file.load().unwrap() == Some(saved));
        assert_eq!(mode(file.path()), 0o600);
        assert_eq!(mode(file.path().parent().unwrap()), 0o700);
        let leftovers: Vec<_> = std::fs::read_dir(file.path().parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, ["token.json"], "임시 파일이 남지 않는다");
    }

    #[test]
    fn broken_file_is_an_error_without_its_contents() {
        let (_dir, _lock, file) = temp_token_file();
        std::fs::create_dir_all(file.path().parent().unwrap()).unwrap();
        std::fs::write(file.path(), "{\"token\": \"FAKE-TOKEN-broken\"").unwrap();
        let err = file.load().err().unwrap().to_string();
        assert!(!err.contains("FAKE-TOKEN-broken") && err.contains("token.json"), "{err}");
    }
}
