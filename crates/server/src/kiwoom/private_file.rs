use std::fmt;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::api::KiwoomEnvironment;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileError(String);

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct PrivateFile {
    path: PathBuf,
}

impl PrivateFile {
    pub fn new(path: PathBuf) -> Self {
        PrivateFile { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn error(&self, what: impl fmt::Display) -> FileError {
        FileError(format!("{}: {what}", self.path.display()))
    }

    fn dir(&self) -> &Path {
        self.path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."))
    }

    pub fn read(&self) -> Result<Option<String>, FileError> {
        let mut file = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(self.error(e)),
        };
        self.private_dir()?;
        let mode = file.metadata().map_err(|e| self.error(e))?.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(self.error(format_args!("권한이 {mode:o}라 다른 사용자가 읽을 수 있어 쓰지 않습니다. chmod 600 {}", self.path.display())));
        }
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|e| self.error(e))?;
        Ok(Some(text))
    }

    fn private_dir(&self) -> Result<(), FileError> {
        let dir = self.dir();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| self.error(e))?;
        let mode = std::fs::metadata(dir).map_err(|e| self.error(e))?.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(self.error(format_args!("디렉터리 권한이 {mode:o}라 다른 사용자가 읽을 수 있어 쓰지 않습니다. chmod 700 {}", dir.display())));
        }
        Ok(())
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), FileError> {
        self.private_dir()?;
        let name = self.path.file_name().map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
        let write = || -> std::io::Result<()> {
            let mut tmp = tempfile::Builder::new().prefix(&format!(".{name}.")).tempfile_in(self.dir())?;
            tmp.write_all(bytes)?;
            tmp.as_file().sync_all()?;
            tmp.persist(&self.path).map_err(|e| e.error)?;
            Ok(())
        };
        write().map_err(|e| self.error(e))
    }

    pub fn stored_environment(&self) -> Result<Option<KiwoomEnvironment>, FileError> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(self.error(e)),
        };
        Ok(serde_json::from_str::<EnvironmentOnly>(&text).ok().map(|only| only.environment))
    }

    pub fn error_for_other_environment(&self, stored: KiwoomEnvironment, current: KiwoomEnvironment) -> FileError {
        self.error(format_args!("투자구분 {}의 파일이라 {} 서버는 읽지도 쓰지도 않습니다", stored.as_str(), current.as_str()))
    }

    pub fn remove(&self) -> Result<(), FileError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(self.error(e)),
        }
    }
}

#[derive(Serialize)]
struct StampedRef<'a, T> {
    environment: KiwoomEnvironment,
    #[serde(flatten)]
    value: &'a T,
}

#[derive(Deserialize)]
struct Stamped<T> {
    #[serde(default)]
    environment: KiwoomEnvironment,
    #[serde(flatten)]
    value: T,
}

#[derive(Deserialize)]
struct EnvironmentOnly {
    #[serde(default)]
    environment: KiwoomEnvironment,
}

pub fn render_stamped<T: Serialize>(environment: KiwoomEnvironment, value: &T) -> Vec<u8> {
    serde_json::to_vec(&StampedRef { environment, value }).expect("문자열과 숫자만 담은 구조체")
}

pub fn parse_stamped<T: DeserializeOwned>(text: &str) -> serde_json::Result<(KiwoomEnvironment, T)> {
    serde_json::from_str::<Stamped<T>>(text).map(|stamped| (stamped.environment, stamped.value))
}
