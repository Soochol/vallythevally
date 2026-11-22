use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use crate::kiwoom::private_file::FileError;
use crate::kiwoom::private_file::PrivateFile;
pub use crate::kiwoom::token_file::credential_id;

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
pub struct Saved {
    #[serde(default)]
    pub credential: Option<String>,
    #[serde(default)]
    pub token: Option<SavedToken>,
    pub last_request_at: i64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SavedToken {
    pub value: String,
    pub expires_at: i64,
    pub issued_at: i64,
}

pub struct TokenFile {
    file: PrivateFile,
}

impl TokenFile {
    pub fn new(path: PathBuf) -> Self {
        TokenFile { file: PrivateFile::new(path) }
    }

    pub fn path(&self) -> &Path {
        self.file.path()
    }

    pub fn load(&self) -> Result<Option<Saved>, FileError> {
        let Some(text) = self.file.read()? else { return Ok(None) };
        serde_json::from_str(&text).map(Some).map_err(|e| self.file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))
    }

    pub fn save(&self, saved: &Saved) -> Result<(), FileError> {
        self.file.write(&serde_json::to_vec(saved).expect("문자열과 숫자만 담은 구조체"))
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn set_mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn temp_file() -> (tempfile::TempDir, TokenFile) {
        let dir = tempfile::tempdir().unwrap();
        let file = TokenFile::new(dir.path().join("state/vallythevally/kis-token.json"));
        (dir, file)
    }

    fn saved() -> Saved {
        Saved {
            credential: Some(credential_id("FAKE-KIS-APPKEY-file-1")),
            token: Some(SavedToken { value: "FAKE-KIS-TOKEN-file-1".into(), expires_at: 2_000_000_000, issued_at: 1_999_913_600 }),
            last_request_at: 1_999_913_599,
        }
    }

    #[test]
    fn kis_token_file_round_trips_with_private_permissions_and_leaves_no_temp_file() {
        let (_dir, file) = temp_file();
        assert!(file.load().unwrap().is_none());
        file.save(&saved()).unwrap();
        file.save(&saved()).unwrap();
        assert!(file.load().unwrap() == Some(saved()));
        assert_eq!(mode(file.path()), 0o600);
        assert_eq!(mode(file.path().parent().unwrap()), 0o700);
        let names: Vec<_> = std::fs::read_dir(file.path().parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["kis-token.json"]);
    }

    #[test]
    fn kis_token_file_others_can_read_is_neither_read_nor_written() {
        let (_dir, file) = temp_file();
        file.save(&saved()).unwrap();
        let dir = file.path().parent().unwrap();

        set_mode(file.path(), 0o644);
        let err = file.load().err().expect("644 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 600") && !err.contains("FAKE-"), "{err}");
        assert_eq!(mode(file.path()), 0o644);

        set_mode(file.path(), 0o600);
        set_mode(dir, 0o755);
        let err = file.load().err().expect("755 디렉터리의 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 700"), "{err}");
        assert!(file.save(&saved()).is_err(), "755 디렉터리에는 쓰지 않는다");
        assert_eq!(mode(dir), 0o755);
    }

    #[test]
    fn kis_broken_token_file_is_an_error_without_its_contents() {
        let (_dir, file) = temp_file();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(file.path().parent().unwrap()).unwrap();
        std::fs::write(file.path(), "{\"token\": \"FAKE-KIS-TOKEN-broken\"").unwrap();
        set_mode(file.path(), 0o600);
        let err = file.load().err().unwrap().to_string();
        assert!(err.contains("kis-token.json") && !err.contains("FAKE-"), "{err}");
    }
}
