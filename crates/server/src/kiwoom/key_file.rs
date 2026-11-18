use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ip_file::RegisteredIpFile;
use super::private_file::{FileError, PrivateFile};
use crate::api::KiwoomEnvironment;
use crate::config::{KiwoomCredentials, Secret};
use crate::instance::InstanceLock;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    app_key: String,
    app_secret: String,
}

pub struct KeyFile {
    file: PrivateFile,
    environment: KiwoomEnvironment,
}

impl KeyFile {
    pub fn new(path: PathBuf, _held: &InstanceLock) -> Self {
        KeyFile { file: PrivateFile::new(path), environment: KiwoomEnvironment::Real }
    }

    pub fn with_environment(mut self, environment: KiwoomEnvironment) -> Self {
        self.environment = environment;
        self
    }

    pub fn path(&self) -> &Path {
        self.file.path()
    }

    pub fn registered_ip_file(&self) -> RegisteredIpFile {
        RegisteredIpFile::new(PrivateFile::new(self.path().with_file_name(crate::config::REGISTERED_IP_FILE_NAME)))
    }

    pub fn order_switch_store(&self) -> crate::trading::SwitchStore {
        crate::trading::SwitchStore::file(PrivateFile::new(self.path().with_file_name(crate::trading::ORDER_SWITCH_FILE_NAME)), self.environment)
    }

    pub fn load(&self) -> Result<Option<KiwoomCredentials>, FileError> {
        let Some(text) = self.file.read()? else { return Ok(None) };
        let stored: Stored = serde_json::from_str(&text).map_err(|e| self.file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
        if stored.app_key.is_empty() || stored.app_secret.is_empty() {
            return Err(self.file.error("앱키나 시크릿이 비어 있어 쓰지 않습니다"));
        }
        Ok(Some(KiwoomCredentials { app_key: Secret::new(stored.app_key), app_secret: Secret::new(stored.app_secret) }))
    }

    pub fn save(&self, credentials: &KiwoomCredentials) -> Result<(), FileError> {
        let stored = Stored { app_key: credentials.app_key.expose().clone(), app_secret: credentials.app_secret.expose().clone() };
        self.file.write(&serde_json::to_vec(&stored).expect("문자열만 담은 구조체"))
    }

    pub fn remove(&self) -> Result<(), FileError> {
        self.file.remove()
    }
}

pub struct StartupKey {
    pub credentials: Option<KiwoomCredentials>,
    pub file_problem: Option<FileError>,
}

pub fn startup_key(env: Option<KiwoomCredentials>, file: &KeyFile, environment: KiwoomEnvironment) -> StartupKey {
    if env.is_some() || environment == KiwoomEnvironment::Mock {
        return StartupKey { credentials: env, file_problem: None };
    }
    match file.load() {
        Ok(credentials) => StartupKey { credentials, file_problem: None },
        Err(e) => {
            tracing::error!(error = %e, "키 파일을 읽지 못했습니다. 키 없이 켭니다");
            StartupKey { credentials: None, file_problem: Some(e) }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn temp_key_file() -> (tempfile::TempDir, InstanceLock, KeyFile) {
        let dir = tempfile::tempdir().unwrap();
        let lock = InstanceLock::acquire(&dir.path().join("server.lock")).unwrap();
        let file = KeyFile::new(dir.path().join("state/vallythevally/kiwoom-key.json"), &lock);
        (dir, lock, file)
    }

    fn credentials(key: &str, secret: &str) -> KiwoomCredentials {
        KiwoomCredentials { app_key: Secret::new(key.into()), app_secret: Secret::new(secret.into()) }
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn round_trip_with_private_permissions_and_no_leftovers() {
        let (_dir, _lock, file) = temp_key_file();
        assert!(file.load().unwrap().is_none());
        file.save(&credentials("FAKE-APPKEY-keyfile-1", "FAKE-SECRET-keyfile-1")).unwrap();
        file.save(&credentials("FAKE-APPKEY-keyfile-2", "FAKE-SECRET-keyfile-2")).unwrap();
        let loaded = file.load().unwrap().unwrap();
        assert_eq!((loaded.app_key.expose().as_str(), loaded.app_secret.expose().as_str()), ("FAKE-APPKEY-keyfile-2", "FAKE-SECRET-keyfile-2"));
        assert_eq!(mode(file.path()), 0o600);
        assert_eq!(mode(file.path().parent().unwrap()), 0o700);
        let leftovers: Vec<_> = std::fs::read_dir(file.path().parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, ["kiwoom-key.json"]);
    }

    #[test]
    fn a_file_or_directory_others_can_read_is_not_read() {
        let (_dir, _lock, file) = temp_key_file();
        file.save(&credentials("FAKE-APPKEY-keyfile-3", "FAKE-SECRET-keyfile-3")).unwrap();
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = file.load().expect_err("644 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 600") && !err.contains("FAKE-"), "{err}");
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(file.path().parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = file.load().expect_err("755 디렉터리의 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 700"), "{err}");
    }

    #[test]
    fn a_broken_or_empty_file_is_an_error_without_its_contents() {
        let (_dir, _lock, file) = temp_key_file();
        file.save(&credentials("x", "y")).unwrap();
        std::fs::write(file.path(), "{\"appKey\": \"FAKE-APPKEY-broken\"").unwrap();
        let err = file.load().err().unwrap().to_string();
        assert!(!err.contains("FAKE-APPKEY-broken") && err.contains("kiwoom-key.json"), "{err}");
        std::fs::write(file.path(), "{\"appKey\":\"\",\"appSecret\":\"FAKE-SECRET-empty\"}").unwrap();
        let err = file.load().err().unwrap().to_string();
        assert!(!err.contains("FAKE-SECRET-empty"), "{err}");
    }

    #[test]
    fn remove_is_idempotent() {
        let (_dir, _lock, file) = temp_key_file();
        file.remove().unwrap();
        file.save(&credentials("a", "b")).unwrap();
        file.remove().unwrap();
        file.remove().unwrap();
        assert!(file.load().unwrap().is_none());
    }

    #[test]
    fn the_environment_key_wins_and_the_file_is_not_read() {
        let (_dir, _lock, file) = temp_key_file();
        file.save(&credentials("FAKE-APPKEY-file", "FAKE-SECRET-file")).unwrap();
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let from_env = startup_key(Some(credentials("FAKE-APPKEY-env", "FAKE-SECRET-env")), &file, KiwoomEnvironment::Real);
        assert_eq!(from_env.credentials.unwrap().app_key.expose(), "FAKE-APPKEY-env");
        assert!(from_env.file_problem.is_none(), "환경 키가 있으면 파일을 읽지 않으므로 문제도 모른다");
        let from_file = startup_key(None, &file, KiwoomEnvironment::Real);
        assert!(from_file.credentials.is_none() && from_file.file_problem.is_some());
        let mock = startup_key(None, &file, KiwoomEnvironment::Mock);
        assert!(mock.credentials.is_none() && mock.file_problem.is_none(), "모의 서버는 키 파일을 읽지 않으므로 문제도 모른다");
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(startup_key(None, &file, KiwoomEnvironment::Mock).credentials.is_none(), "읽을 수 있는 키 파일이 있어도 모의 서버는 쓰지 않는다");
    }
}
