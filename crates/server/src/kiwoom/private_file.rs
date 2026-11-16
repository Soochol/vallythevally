use std::fmt;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

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

    /// 경로가 홈 같은 공용 디렉터리를 가리킬 수 있어 chmod는 하지 않는다.
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

    pub fn remove(&self) -> Result<(), FileError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(self.error(e)),
        }
    }
}
