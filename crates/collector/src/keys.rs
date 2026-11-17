use std::collections::BTreeSet;
use std::fmt;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use server::config::Secret;
use server::kiwoom::token_file::credential_id;

use crate::collect::config::{
    APP_KEY_VARIABLE, APP_SECRET_VARIABLE, LOCK_FILE_NAME, TOKEN_FILE_NAME, Variables, read_env_file, reject_app_server_key,
};
use crate::protocol::KeyName;

const SUPPORTED_VERSION: u32 = 1;
const HASH_PREFIX: &str = "sha256:";
const HASH_HEX_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyRole {
    Collecting,
    Spare,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyIdentity {
    pub name: KeyName,
    pub role: KeyRole,
    pub app_key_hash: String,
}

#[derive(Debug, Clone)]
pub struct ActiveKey {
    pub identity: KeyIdentity,
    pub app_key: Secret<String>,
    pub app_secret: Secret<String>,
    pub token_path: PathBuf,
    pub lock_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct KeyList {
    pub active: Vec<ActiveKey>,
}

impl KeyList {
    pub fn identities(&self) -> Vec<KeyIdentity> {
        self.active.iter().map(|key| key.identity.clone()).collect()
    }

    pub fn load(path: &Path, state_folder: &Path, process: &Variables) -> Result<KeyList, KeysError> {
        let entries = read_entries(path)?;
        let named = name_entries(entries)?;
        let spares = named.iter().filter(|entry| entry.spare).count();
        if spares != 1 {
            return Err(KeysError::SpareCount(spares));
        }
        check_hashes(&named)?;
        let mut active = Vec::new();
        for entry in named.into_iter().filter(|entry| entry.active) {
            active.push(open_key(entry, state_folder, process)?);
        }
        Ok(KeyList { active })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyListFile {
    version: u32,
    keys: Vec<KeyEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyEntry {
    name: String,
    active: bool,
    spare: bool,
    app_key_hash: String,
    secret_file: PathBuf,
    #[serde(default)]
    token_path: Option<PathBuf>,
    #[serde(default)]
    lock_path: Option<PathBuf>,
}

struct NamedEntry {
    name: KeyName,
    active: bool,
    spare: bool,
    app_key_hash: String,
    secret_file: PathBuf,
    token_path: Option<PathBuf>,
    lock_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretFileProblem {
    Unreadable(String),
    Mode(u32),
    Missing(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeysError {
    Unreadable { path: PathBuf, kind: io::ErrorKind },
    Malformed { path: PathBuf, detail: String },
    UnsupportedVersion(u32),
    BadName { name: String, detail: String },
    DuplicateName(KeyName),
    SpareCount(usize),
    BadHash(KeyName),
    BadPath { key: KeyName, path: PathBuf },
    SecretFile { key: KeyName, path: PathBuf, problem: SecretFileProblem },
    HashMismatch(KeyName),
    SameAppKey { first: KeyName, second: KeyName },
    AppServerKey { key: KeyName, detail: String },
}

impl fmt::Display for KeysError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeysError::Unreadable { path, kind } => write!(formatter, "키 목록 설정을 읽을 수 없습니다({}): {kind}", path.display()),
            KeysError::Malformed { path, detail } => write!(formatter, "키 목록 설정 형식이 틀렸습니다({}): {detail}", path.display()),
            KeysError::UnsupportedVersion(version) => write!(formatter, "키 목록 설정의 형식 버전 {version}은 지원하지 않습니다"),
            KeysError::BadName { name, detail } => write!(formatter, "키 이름 {name:?}을 쓸 수 없습니다: {detail}"),
            KeysError::DuplicateName(name) => write!(formatter, "키 이름 {name}이 겹칩니다"),
            KeysError::SpareCount(count) => write!(formatter, "예비 키는 정확히 하나여야 합니다({count}개)"),
            KeysError::BadHash(key) => write!(formatter, "키 {key}의 앱키 해시가 {HASH_PREFIX}<소문자 16진수 {HASH_HEX_LEN}자> 형식이 아닙니다"),
            KeysError::BadPath { key, path } => write!(formatter, "키 {key}의 경로는 절대 경로여야 합니다: {}", path.display()),
            KeysError::SecretFile { key, path, problem } => {
                write!(formatter, "키 {key}의 비밀값 파일({})을 쓸 수 없습니다: ", path.display())?;
                match problem {
                    SecretFileProblem::Unreadable(detail) => formatter.write_str(detail),
                    SecretFileProblem::Mode(mode) => {
                        write!(formatter, "권한이 {mode:o}라 다른 사용자가 읽을 수 있습니다. chmod 600 {}", path.display())
                    }
                    SecretFileProblem::Missing(variable) => write!(formatter, "{variable}가 없습니다"),
                }
            }
            KeysError::HashMismatch(key) => write!(formatter, "키 {key}의 비밀값 파일에 있는 앱키의 해시가 설정의 앱키 해시와 다릅니다"),
            KeysError::SameAppKey { first, second } => {
                write!(formatter, "키 {first}와 {second}가 같은 앱키입니다. 같은 앱키를 두 곳에서 쓰면 서로 연결을 끊습니다")
            }
            KeysError::AppServerKey { key, detail } => write!(formatter, "키 {key}: {detail}"),
        }
    }
}

impl std::error::Error for KeysError {}

fn read_entries(path: &Path) -> Result<Vec<KeyEntry>, KeysError> {
    let text = std::fs::read_to_string(path).map_err(|error| KeysError::Unreadable { path: path.to_owned(), kind: error.kind() })?;
    let file: KeyListFile = serde_json::from_str(&text).map_err(|error| KeysError::Malformed {
        path: path.to_owned(),
        detail: format!("JSON {:?} 오류, {}번째 줄", error.classify(), error.line()),
    })?;
    if file.version != SUPPORTED_VERSION {
        return Err(KeysError::UnsupportedVersion(file.version));
    }
    Ok(file.keys)
}

fn parse_name(text: &str) -> Result<KeyName, KeysError> {
    let bad = |detail: String| KeysError::BadName { name: text.to_owned(), detail };
    let name = KeyName::parse(text).map_err(|error| bad(error.to_string()))?;
    match text.chars().find(|character| !(character.is_ascii_lowercase() || character.is_ascii_digit() || *character == '-')) {
        Some(character) => Err(bad(format!("a-z, 0-9, -만 쓸 수 있습니다({character:?})"))),
        None => Ok(name),
    }
}

fn name_entries(entries: Vec<KeyEntry>) -> Result<Vec<NamedEntry>, KeysError> {
    let mut seen = BTreeSet::new();
    let mut named = Vec::new();
    for entry in entries {
        let name = parse_name(&entry.name)?;
        if !seen.insert(name.clone()) {
            return Err(KeysError::DuplicateName(name));
        }
        named.push(NamedEntry {
            name,
            active: entry.active,
            spare: entry.spare,
            app_key_hash: entry.app_key_hash,
            secret_file: entry.secret_file,
            token_path: entry.token_path,
            lock_path: entry.lock_path,
        });
    }
    named.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(named)
}

fn is_hash(text: &str) -> bool {
    text.strip_prefix(HASH_PREFIX)
        .is_some_and(|hex| hex.len() == HASH_HEX_LEN && hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn check_hashes(entries: &[NamedEntry]) -> Result<(), KeysError> {
    for (index, entry) in entries.iter().enumerate() {
        if !is_hash(&entry.app_key_hash) {
            return Err(KeysError::BadHash(entry.name.clone()));
        }
        if let Some(first) = entries[..index].iter().find(|earlier| earlier.app_key_hash == entry.app_key_hash) {
            return Err(KeysError::SameAppKey { first: first.name.clone(), second: entry.name.clone() });
        }
    }
    Ok(())
}

fn require_absolute(key: &KeyName, path: &Path) -> Result<(), KeysError> {
    match path.is_absolute() {
        true => Ok(()),
        false => Err(KeysError::BadPath { key: key.clone(), path: path.to_owned() }),
    }
}

fn open_key(entry: NamedEntry, state_folder: &Path, process: &Variables) -> Result<ActiveKey, KeysError> {
    let NamedEntry { name, spare, app_key_hash, secret_file, token_path, lock_path, .. } = entry;
    require_absolute(&name, &secret_file)?;
    let default_folder = state_folder.join(name.as_str());
    let token_path = token_path.unwrap_or_else(|| default_folder.join(TOKEN_FILE_NAME));
    let lock_path = lock_path.unwrap_or_else(|| default_folder.join(LOCK_FILE_NAME));
    require_absolute(&name, &token_path)?;
    require_absolute(&name, &lock_path)?;
    let (app_key, app_secret) = read_secrets(&name, &secret_file)?;
    if credential_id(app_key.expose()) != app_key_hash {
        return Err(KeysError::HashMismatch(name));
    }
    reject_app_server_key(process, app_key.expose()).map_err(|error| KeysError::AppServerKey { key: name.clone(), detail: error.to_string() })?;
    let role = if spare { KeyRole::Spare } else { KeyRole::Collecting };
    Ok(ActiveKey { identity: KeyIdentity { name, role, app_key_hash }, app_key, app_secret, token_path, lock_path })
}

fn read_secrets(key: &KeyName, path: &Path) -> Result<(Secret<String>, Secret<String>), KeysError> {
    let problem = |problem: SecretFileProblem| KeysError::SecretFile { key: key.clone(), path: path.to_owned(), problem };
    let mode = std::fs::metadata(path)
        .map_err(|error| problem(SecretFileProblem::Unreadable(error.kind().to_string())))?
        .permissions()
        .mode()
        & 0o777;
    if mode & 0o077 != 0 {
        return Err(problem(SecretFileProblem::Mode(mode)));
    }
    let variables = read_env_file("비밀값 파일", path).map_err(|error| problem(SecretFileProblem::Unreadable(error.to_string())))?;
    let present = |name: &'static str| {
        variables
            .get(name)
            .filter(|value| !value.is_empty())
            .map(|value| Secret::new(value.clone()))
            .ok_or_else(|| problem(SecretFileProblem::Missing(name)))
    };
    Ok((present(APP_KEY_VARIABLE)?, present(APP_SECRET_VARIABLE)?))
}
