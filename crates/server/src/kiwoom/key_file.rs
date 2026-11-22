use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ip_file::RegisteredIpFile;
use super::private_file::{FileError, PrivateFile};
use crate::api::{Broker, KiwoomEnvironment};
use crate::config::{KiwoomCredentials, Secret};
use crate::instance::InstanceLock;

pub const KEY_LIMIT: usize = 5;
pub const KEY_LIST_FILE_NAME: &str = "kiwoom-keys.json";
pub const ALIAS_MAX_CHARS: usize = 20;
pub const MIGRATED_KEY_ALIAS: &str = "키 1";
pub const ENV_KEY_ALIAS: &str = "환경 설정 키";
const LIST_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct KeyId(String);

impl KeyId {
    pub fn env() -> KeyId {
        KeyId("env".to_owned())
    }

    pub fn numbered(number: u32) -> KeyId {
        KeyId(format!("k{number}"))
    }

    pub fn parse(text: &str) -> Option<KeyId> {
        let valid = !text.is_empty() && text.len() <= 16 && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        valid.then(|| KeyId(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn number(&self) -> Option<u32> {
        self.0.strip_prefix('k')?.parse().ok()
    }
}

impl std::fmt::Display for KeyId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOrigin {
    Env,
    File,
}

#[derive(Debug, Clone)]
pub struct StoredKey {
    pub id: KeyId,
    pub alias: String,
    pub broker: Broker,
    pub credentials: KiwoomCredentials,
}

#[derive(Debug, Clone, Default)]
pub struct KeyList {
    pub keys: Vec<StoredKey>,
    pub market: Option<KeyId>,
}

impl KeyList {
    pub fn next_id(&self) -> KeyId {
        KeyId::numbered(self.keys.iter().filter_map(|key| key.id.number()).max().unwrap_or(0) + 1)
    }
}

pub fn checked_alias(alias: &str) -> Result<String, &'static str> {
    let alias = alias.trim();
    if alias.is_empty() {
        return Err("별칭이 비어 있습니다");
    }
    if alias.chars().count() > ALIAS_MAX_CHARS {
        return Err("별칭은 20자까지 쓸 수 있습니다");
    }
    Ok(alias.to_owned())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredList {
    version: u32,
    #[serde(default)]
    market_key_id: Option<String>,
    keys: Vec<StoredEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    id: String,
    alias: String,
    #[serde(default = "kiwoom")]
    broker: Broker,
    app_key: String,
    app_secret: String,
}

fn kiwoom() -> Broker {
    Broker::Kiwoom
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyStored {
    app_key: String,
    app_secret: String,
}

pub struct KeyFile {
    list: PrivateFile,
    legacy: PrivateFile,
    environment: KiwoomEnvironment,
}

impl KeyFile {
    pub fn new(legacy_path: PathBuf, _held: &InstanceLock) -> Self {
        let list = PrivateFile::new(legacy_path.with_file_name(KEY_LIST_FILE_NAME));
        KeyFile { list, legacy: PrivateFile::new(legacy_path), environment: KiwoomEnvironment::Real }
    }

    pub fn with_environment(mut self, environment: KiwoomEnvironment) -> Self {
        self.environment = environment;
        self
    }

    pub fn path(&self) -> &Path {
        self.list.path()
    }

    pub fn order_switch_store(&self) -> crate::trading::SwitchStore {
        crate::trading::SwitchStore::file(PrivateFile::new(self.path().with_file_name(crate::trading::ORDER_SWITCH_FILE_NAME)), self.environment)
    }

    pub fn load(&self) -> Result<KeyList, FileError> {
        match self.list.read()? {
            Some(text) => self.parse(&text),
            None => self.migrate_legacy(),
        }
    }

    fn parse(&self, text: &str) -> Result<KeyList, FileError> {
        let stored: StoredList = serde_json::from_str(text).map_err(|e| self.list.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
        if stored.version != LIST_VERSION {
            return Err(self.list.error("알 수 없는 형식 버전이라 쓰지 않습니다"));
        }
        if stored.keys.len() > KEY_LIMIT {
            return Err(self.list.error("키가 5개를 넘어 쓰지 않습니다"));
        }
        let mut keys: Vec<StoredKey> = Vec::new();
        for entry in stored.keys {
            let id = KeyId::parse(&entry.id).filter(|id| *id != KeyId::env()).ok_or_else(|| self.list.error("키 ID가 올바르지 않아 쓰지 않습니다"))?;
            let alias = checked_alias(&entry.alias).map_err(|reason| self.list.error(format_args!("{reason}, 쓰지 않습니다")))?;
            if entry.app_key.is_empty() || entry.app_secret.is_empty() {
                return Err(self.list.error("앱키나 시크릿이 비어 있어 쓰지 않습니다"));
            }
            if keys.iter().any(|key| key.id == id || key.credentials.app_key.expose() == &entry.app_key) {
                return Err(self.list.error("같은 키 ID나 앱키가 두 번 있어 쓰지 않습니다"));
            }
            keys.push(StoredKey { id, alias, broker: entry.broker, credentials: KiwoomCredentials { app_key: Secret::new(entry.app_key), app_secret: Secret::new(entry.app_secret) } });
        }
        let market = stored.market_key_id.and_then(|id| KeyId::parse(&id)).filter(|id| *id == KeyId::env() || keys.iter().any(|key| key.id == *id));
        Ok(KeyList { keys, market })
    }

    fn migrate_legacy(&self) -> Result<KeyList, FileError> {
        let Some(text) = self.legacy.read()? else { return Ok(KeyList::default()) };
        let stored: LegacyStored = serde_json::from_str(&text).map_err(|e| self.legacy.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
        if stored.app_key.is_empty() || stored.app_secret.is_empty() {
            return Err(self.legacy.error("앱키나 시크릿이 비어 있어 쓰지 않습니다"));
        }
        let id = KeyId::numbered(1);
        let key = StoredKey { id: id.clone(), alias: MIGRATED_KEY_ALIAS.to_owned(), broker: Broker::Kiwoom, credentials: KiwoomCredentials { app_key: Secret::new(stored.app_key), app_secret: Secret::new(stored.app_secret) } };
        let list = KeyList { keys: vec![key], market: Some(id) };
        self.save(&list)?;
        match self.legacy.remove() {
            Ok(()) => tracing::info!("옛 키 파일의 키를 키 목록으로 옮기고 옛 파일을 지웠습니다"),
            Err(e) => tracing::warn!(error = %e, "키 목록으로 옮겼지만 옛 키 파일을 지우지 못했습니다. 목록이 있으므로 옛 파일은 읽지 않습니다"),
        }
        Ok(list)
    }

    pub fn remove(&self) -> Result<(), FileError> {
        self.list.remove()
    }

    pub fn save(&self, list: &KeyList) -> Result<(), FileError> {
        let stored = StoredList {
            version: LIST_VERSION,
            market_key_id: list.market.as_ref().map(|id| id.as_str().to_owned()),
            keys: list
                .keys
                .iter()
                .map(|key| StoredEntry { id: key.id.as_str().to_owned(), alias: key.alias.clone(), broker: key.broker, app_key: key.credentials.app_key.expose().clone(), app_secret: key.credentials.app_secret.expose().clone() })
                .collect(),
        };
        self.list.write(&serde_json::to_vec(&stored).expect("문자열만 담은 구조체"))
    }
}

pub fn registered_ip_file(path: PathBuf) -> RegisteredIpFile {
    RegisteredIpFile::new(PrivateFile::new(path))
}

pub fn path_for_key(base: &Path, id: &KeyId, env_key_present: bool) -> PathBuf {
    let owns_base = *id == KeyId::env() || (!env_key_present && *id == KeyId::numbered(1));
    if owns_base {
        return base.to_owned();
    }
    let stem = base.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = match base.extension() {
        Some(ext) => format!("{stem}.{id}.{}", ext.to_string_lossy()),
        None => format!("{stem}.{id}"),
    };
    base.with_file_name(name)
}

#[derive(Debug, Clone)]
pub struct StartupKey {
    pub id: KeyId,
    pub alias: String,
    pub origin: KeyOrigin,
    pub broker: Broker,
    pub credentials: KiwoomCredentials,
}

pub struct StartupKeys {
    pub keys: Vec<StartupKey>,
    pub market: Option<KeyId>,
    pub file_problem: Option<FileError>,
}

pub fn startup_keys(env: Option<KiwoomCredentials>, file: &KeyFile, environment: KiwoomEnvironment) -> StartupKeys {
    let mut keys: Vec<StartupKey> = env.into_iter().map(|credentials| StartupKey { id: KeyId::env(), alias: ENV_KEY_ALIAS.to_owned(), origin: KeyOrigin::Env, broker: Broker::Kiwoom, credentials }).collect();
    if environment == KiwoomEnvironment::Mock {
        let market = keys.first().map(|key| key.id.clone());
        return StartupKeys { keys, market, file_problem: None };
    }
    let (list, file_problem) = match file.load() {
        Ok(list) => (list, None),
        Err(e) => {
            tracing::error!(error = %e, "키 파일을 읽지 못했습니다. 파일의 키 없이 켭니다");
            (KeyList::default(), Some(e))
        }
    };
    for stored in list.keys {
        if keys.iter().any(|key| key.credentials.app_key.expose() == stored.credentials.app_key.expose()) {
            tracing::warn!("키 목록의 키가 환경 설정 키와 같아 한 번만 씁니다");
            continue;
        }
        keys.push(StartupKey { id: stored.id, alias: stored.alias, origin: KeyOrigin::File, broker: stored.broker, credentials: stored.credentials });
    }
    let market = list.market.filter(|id| keys.iter().any(|key| key.id == *id)).or_else(|| keys.first().map(|key| key.id.clone()));
    StartupKeys { keys, market, file_problem }
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

    fn stored(number: u32, alias: &str, key: &str) -> StoredKey {
        StoredKey { id: KeyId::numbered(number), alias: alias.into(), broker: Broker::Kiwoom, credentials: credentials(key, &format!("FAKE-SECRET-{key}")) }
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    fn write_legacy(file: &KeyFile, key: &str) {
        std::fs::create_dir_all(file.legacy.path().parent().unwrap()).unwrap();
        std::fs::set_permissions(file.legacy.path().parent().unwrap(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(file.legacy.path(), format!("{{\"appKey\":\"{key}\",\"appSecret\":\"FAKE-SECRET-legacy\"}}")).unwrap();
        std::fs::set_permissions(file.legacy.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn round_trip_with_private_permissions_and_no_leftovers() {
        let (_dir, _lock, file) = temp_key_file();
        assert!(file.load().unwrap().keys.is_empty());
        let list = KeyList { keys: vec![stored(1, "주식", "FAKE-APPKEY-list-1"), stored(2, "선물", "FAKE-APPKEY-list-2")], market: Some(KeyId::numbered(2)) };
        file.save(&KeyList { keys: vec![stored(1, "x", "FAKE-APPKEY-old")], market: None }).unwrap();
        file.save(&list).unwrap();
        let loaded = file.load().unwrap();
        assert_eq!(loaded.keys.iter().map(|k| (k.id.as_str(), k.alias.as_str(), k.credentials.app_key.expose().as_str())).collect::<Vec<_>>(), [("k1", "주식", "FAKE-APPKEY-list-1"), ("k2", "선물", "FAKE-APPKEY-list-2")]);
        assert_eq!(loaded.market, Some(KeyId::numbered(2)));
        assert_eq!(mode(file.path()), 0o600);
        assert_eq!(mode(file.path().parent().unwrap()), 0o700);
        let leftovers: Vec<_> = std::fs::read_dir(file.path().parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, ["kiwoom-keys.json"]);
    }

    #[test]
    fn a_file_or_directory_others_can_read_is_not_read() {
        let (_dir, _lock, file) = temp_key_file();
        file.save(&KeyList { keys: vec![stored(1, "a", "FAKE-APPKEY-keyfile-3")], market: None }).unwrap();
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = file.load().expect_err("644 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 600") && !err.contains("FAKE-"), "{err}");
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(file.path().parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = file.load().expect_err("755 디렉터리의 파일은 읽지 않는다").to_string();
        assert!(err.contains("chmod 700"), "{err}");
    }

    #[test]
    fn a_broken_or_invalid_list_is_an_error_without_its_contents() {
        let (_dir, _lock, file) = temp_key_file();
        file.save(&KeyList { keys: vec![stored(1, "a", "x")], market: None }).unwrap();
        let rejected = |text: &str| {
            std::fs::write(file.path(), text).unwrap();
            file.load().expect_err(text).to_string()
        };
        let err = rejected("{\"version\":1,\"keys\":[{\"id\":\"k1\",\"alias\":\"a\",\"appKey\":\"FAKE-APPKEY-broken\"");
        assert!(!err.contains("FAKE-APPKEY-broken") && err.contains("kiwoom-keys.json"), "{err}");
        let err = rejected(r#"{"version":1,"keys":[{"id":"k1","alias":"a","appKey":"","appSecret":"FAKE-SECRET-empty"}]}"#);
        assert!(!err.contains("FAKE-SECRET-empty"), "{err}");
        rejected(r#"{"version":1,"keys":[{"id":"k1","alias":"","appKey":"a","appSecret":"b"}]}"#);
        rejected(r#"{"version":1,"keys":[{"id":"k1","alias":"a","appKey":"same","appSecret":"b"},{"id":"k2","alias":"b","appKey":"same","appSecret":"b"}]}"#);
        rejected(r#"{"version":2,"keys":[]}"#);
        let six: Vec<String> = (1..=6).map(|n| format!(r#"{{"id":"k{n}","alias":"a","appKey":"key{n}","appSecret":"s"}}"#)).collect();
        rejected(&format!(r#"{{"version":1,"keys":[{}]}}"#, six.join(",")));
    }

    #[test]
    fn a_legacy_single_key_file_moves_to_the_list_as_key_one_and_is_removed() {
        let (_dir, _lock, file) = temp_key_file();
        write_legacy(&file, "FAKE-APPKEY-legacy");
        let list = file.load().unwrap();
        assert_eq!(list.keys.len(), 1);
        assert_eq!((list.keys[0].id.as_str(), list.keys[0].alias.as_str(), list.keys[0].credentials.app_key.expose().as_str()), ("k1", "키 1", "FAKE-APPKEY-legacy"));
        assert_eq!(list.market, Some(KeyId::numbered(1)));
        assert!(!file.legacy.path().exists(), "옮긴 뒤 옛 파일은 지운다");
        assert_eq!(mode(file.path()), 0o600);
        let again = file.load().unwrap();
        assert_eq!(again.keys[0].credentials.app_secret.expose(), "FAKE-SECRET-legacy");
    }

    #[test]
    fn a_failed_move_keeps_the_legacy_file_and_is_an_error() {
        let (_dir, _lock, file) = temp_key_file();
        write_legacy(&file, "FAKE-APPKEY-legacy-keep");
        std::fs::create_dir(file.path()).unwrap();
        let err = file.load().expect_err("목록 파일 자리를 쓸 수 없다").to_string();
        assert!(!err.contains("FAKE-"), "{err}");
        assert!(file.legacy.path().exists(), "옮기다 실패하면 옛 파일은 남는다");
    }

    #[test]
    fn the_environment_key_leads_the_list_and_the_file_keys_follow() {
        let (_dir, _lock, file) = temp_key_file();
        file.save(&KeyList { keys: vec![stored(1, "파일", "FAKE-APPKEY-file")], market: None }).unwrap();
        let startup = startup_keys(Some(credentials("FAKE-APPKEY-env", "FAKE-SECRET-env")), &file, KiwoomEnvironment::Real);
        assert_eq!(startup.keys.iter().map(|k| (k.id.as_str(), k.origin)).collect::<Vec<_>>(), [("env", KeyOrigin::Env), ("k1", KeyOrigin::File)]);
        assert_eq!(startup.market, Some(KeyId::env()));
        file.save(&KeyList { keys: vec![stored(1, "파일", "FAKE-APPKEY-file")], market: Some(KeyId::numbered(1)) }).unwrap();
        assert_eq!(startup_keys(Some(credentials("FAKE-APPKEY-env", "s")), &file, KiwoomEnvironment::Real).market, Some(KeyId::numbered(1)));
        let duplicate = startup_keys(Some(credentials("FAKE-APPKEY-file", "s")), &file, KiwoomEnvironment::Real);
        assert_eq!(duplicate.keys.len(), 1, "같은 앱키는 한 번만 쓴다");
    }

    #[test]
    fn a_bad_file_leaves_only_the_environment_key_and_reports_the_problem() {
        let (_dir, _lock, file) = temp_key_file();
        file.save(&KeyList { keys: vec![stored(1, "파일", "FAKE-APPKEY-file")], market: None }).unwrap();
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let startup = startup_keys(Some(credentials("FAKE-APPKEY-env", "s")), &file, KiwoomEnvironment::Real);
        assert_eq!(startup.keys.len(), 1);
        assert!(startup.file_problem.is_some());
        let keyless = startup_keys(None, &file, KiwoomEnvironment::Real);
        assert!(keyless.keys.is_empty() && keyless.market.is_none() && keyless.file_problem.is_some());
        let mock = startup_keys(None, &file, KiwoomEnvironment::Mock);
        assert!(mock.keys.is_empty() && mock.file_problem.is_none(), "모의 서버는 키 파일을 읽지 않으므로 문제도 모른다");
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(startup_keys(None, &file, KiwoomEnvironment::Mock).keys.is_empty(), "읽을 수 있는 키 파일이 있어도 모의 서버는 쓰지 않는다");
    }

    #[test]
    fn key_files_do_not_share_paths() {
        let base = Path::new("/s/token.json");
        let paths = [path_for_key(base, &KeyId::numbered(1), false), path_for_key(base, &KeyId::numbered(2), false), path_for_key(base, &KeyId::numbered(1), true), path_for_key(base, &KeyId::env(), true)];
        assert_eq!(paths.map(|p| p.display().to_string()), ["/s/token.json", "/s/token.k2.json", "/s/token.k1.json", "/s/token.json"]);
    }

    #[test]
    fn ids_grow_and_aliases_are_checked() {
        let list = KeyList { keys: vec![stored(1, "a", "a"), stored(3, "b", "b")], market: None };
        assert_eq!(list.next_id(), KeyId::numbered(4));
        assert_eq!(checked_alias("  별칭  ").unwrap(), "별칭");
        assert!(checked_alias("   ").is_err() && checked_alias(&"가".repeat(21)).is_err());
        assert!(checked_alias(&"가".repeat(20)).is_ok());
    }
}
