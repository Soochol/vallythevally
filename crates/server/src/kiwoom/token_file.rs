//! 저장소 밖 토큰 파일(ADR 0004, backend.md §4.1). 서버와 키움 실측 프로그램이 같은 파일을 쓴다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::CodeKey;
use super::private_file::{parse_stamped, render_stamped};
use crate::api::KiwoomEnvironment;
use crate::instance::InstanceLock;

#[derive(Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Saved {
    #[serde(default)]
    pub credential: Option<String>,
    pub token: Option<SavedToken>,
    /// 유닉스 초. 키움 실측 프로그램도 이 파일을 읽고 쓴다.
    pub last_request_at: i64,
    #[serde(default)]
    pub disconnected: Option<String>,
    #[serde(default)]
    pub auth_block: Option<SavedAuthBlock>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct SavedAuthBlock {
    pub detail: CodeKey,
    pub credential: Option<String>,
    pub at: i64,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedToken {
    pub value: String,
    /// au10001 응답의 `expires_dt` 그대로(KST `YYYYMMDDhhmmss`).
    pub expires_dt: String,
    pub issued_at: i64,
}

pub fn credential_id(app_key: &str) -> String {
    let hex: String = Sha256::digest(app_key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

pub use super::private_file::FileError;
use super::private_file::PrivateFile;

pub struct TokenFile {
    file: PrivateFile,
    environment: KiwoomEnvironment,
}

impl TokenFile {
    pub fn new(path: PathBuf, _held: &InstanceLock) -> Self {
        TokenFile { file: PrivateFile::new(path), environment: KiwoomEnvironment::Real }
    }

    pub fn with_environment(mut self, environment: KiwoomEnvironment) -> Self {
        self.environment = environment;
        self
    }

    pub fn path(&self) -> &Path {
        self.file.path()
    }

    pub fn load(&self) -> Result<Option<Saved>, FileError> {
        let Some(text) = self.file.read()? else { return Ok(None) };
        let (stored, saved) = parse_stamped(&text).map_err(|e| self.file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
        if stored != self.environment {
            return Err(self.file.error_for_other_environment(stored, self.environment));
        }
        Ok(Some(saved))
    }

    pub fn save(&self, saved: &Saved) -> Result<(), FileError> {
        if let Some(stored) = self.file.stored_environment()?
            && stored != self.environment
        {
            return Err(self.file.error_for_other_environment(stored, self.environment));
        }
        self.file.write(&render_stamped(self.environment, saved))
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
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

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
            credential: Some(credential_id("FAKE-APPKEY-file-1")),
            token: Some(SavedToken { value: "FAKE-TOKEN-file-1".into(), expires_dt: "20261110090000".into(), issued_at: 10 }),
            last_request_at: 9,
            disconnected: Some(credential_id("FAKE-APPKEY-file-1")),
            auth_block: Some(SavedAuthBlock { detail: CodeKey::Rest(8050), credential: None, at: 8 }),
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

    #[test]
    fn a_token_file_from_the_other_environment_is_neither_read_nor_written() {
        let (dir, lock, real) = temp_token_file();
        let token = || Saved { credential: Some(credential_id("FAKE-APPKEY-env-1")), token: Some(SavedToken { value: "FAKE-TOKEN-env-1".into(), expires_dt: "20261110090000".into(), issued_at: 10 }), last_request_at: 9, ..Saved::default() };
        real.save(&token()).unwrap();
        let before = std::fs::read(real.path()).unwrap();
        assert!(String::from_utf8(before.clone()).unwrap().contains("\"environment\":\"real\""));

        let mock = TokenFile::new(real.path().to_owned(), &lock).with_environment(KiwoomEnvironment::Mock);
        let err = mock.load().err().expect("모의 서버는 실전 파일을 읽지 않는다").to_string();
        assert!(err.contains("real") && err.contains("mock") && !err.contains("FAKE-"), "{err}");
        assert!(mock.save(&saved()).is_err(), "쓰지도 않는다");
        assert_eq!(std::fs::read(real.path()).unwrap(), before, "파일은 그대로다");
        assert!(real.load().unwrap() == Some(token()));

        let separate = TokenFile::new(dir.path().join("mock/token.json"), &lock).with_environment(KiwoomEnvironment::Mock);
        separate.save(&token()).unwrap();
        assert!(separate.load().unwrap() == Some(token()));
        let as_real = TokenFile::new(separate.path().to_owned(), &lock);
        assert!(as_real.load().is_err() && as_real.save(&saved()).is_err(), "실전 서버도 모의 파일을 읽지 않는다");
    }

    #[test]
    fn a_token_file_without_the_environment_mark_is_real() {
        let (_dir, lock, file) = temp_token_file();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(file.path().parent().unwrap()).unwrap();
        std::fs::write(file.path(), r#"{"credential":null,"token":null,"last_request_at":7}"#).unwrap();
        set_mode(file.path(), 0o600);
        assert_eq!(file.load().unwrap().unwrap().last_request_at, 7);
        let mock = TokenFile::new(file.path().to_owned(), &lock).with_environment(KiwoomEnvironment::Mock);
        assert!(mock.load().is_err());
        file.save(&saved()).expect("표시 없는 실전 파일에는 실전 프로세스가 쓴다");
        assert_eq!(file.load().unwrap().unwrap().last_request_at, 9);
    }

    #[test]
    fn a_token_file_with_an_unreadable_environment_mark_is_not_overwritten() {
        let (_dir, lock, file) = temp_token_file();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(file.path().parent().unwrap()).unwrap();
        for content in [r#"{"environment":"paper","credential":null,"token":null,"last_request_at":7}"#, r#"{"environment":"mock","token":"FAKE-TOKEN-cut""#] {
            std::fs::write(file.path(), content).unwrap();
            set_mode(file.path(), 0o600);
            for environment in [KiwoomEnvironment::Real, KiwoomEnvironment::Mock] {
                let store = TokenFile::new(file.path().to_owned(), &lock).with_environment(environment);
                let err = store.save(&saved()).expect_err("표시를 읽을 수 없으면 쓰지 않는다").to_string();
                assert!(!err.contains("FAKE-"), "{err}");
                assert_eq!(std::fs::read_to_string(file.path()).unwrap(), content, "파일은 그대로다");
            }
        }
    }

    fn set_mode(p: &Path, mode: u32) {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn saved() -> Saved {
        Saved { last_request_at: 9, ..Saved::default() }
    }

    #[test]
    fn a_planted_temp_file_does_not_decide_the_token_file_mode() {
        let (_dir, _lock, file) = temp_token_file();
        let dir = file.path().parent().unwrap();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).unwrap();
        let planted = dir.join(format!(".token.json.{}.tmp", std::process::id()));
        std::fs::write(&planted, "").unwrap();
        set_mode(&planted, 0o644);
        file.save(&saved()).unwrap();
        assert_eq!(mode(file.path()), 0o600);
    }

    #[test]
    fn a_file_or_directory_others_can_read_is_refused_and_left_as_is() {
        let (_dir, _lock, file) = temp_token_file();
        let dir = file.path().parent().unwrap();
        file.save(&saved()).unwrap();

        set_mode(file.path(), 0o644);
        let err = file.load().err().expect("644 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 600"), "{err}");
        assert_eq!(mode(file.path()), 0o644);

        set_mode(file.path(), 0o600);
        set_mode(dir, 0o755);
        let err = file.load().err().expect("755 디렉터리의 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 700"), "{err}");
        assert!(file.save(&saved()).is_err(), "755 디렉터리에는 쓰지 않는다");
        assert_eq!(mode(dir), 0o755, "디렉터리 권한을 바꾸지 않는다");
    }
}
