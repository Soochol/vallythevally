use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use server::collector::telegram::{Telegram, default_path as default_telegram_path};
use server::config::Secret;

use crate::args::{ArgSpec, Arguments};
use crate::collect::config::{Variables, default_state_folder};

pub const OFFICIAL_DART_URL: &str = "https://opendart.fss.or.kr";
pub const OFFICIAL_KIND_URL: &str = "https://kind.krx.co.kr";
pub const SOCKET_FILE_NAME: &str = "financials.sock";
const KEY_MODE: u32 = 0o600;

pub const RUN_SPEC: ArgSpec = ArgSpec {
    value_options: &["db", "dart-key", "state", "telegram", "telegram-api", "dart-base-url", "kind-base-url", "dart-spacing-millis"],
    flag_options: &[],
};

pub const COMMAND_SPEC: ArgSpec = ArgSpec { value_options: &["state"], flag_options: &["json"] };

pub struct RunConfig {
    pub database: PathBuf,
    pub data_dir: PathBuf,
    pub key: Secret<String>,
    pub state_folder: PathBuf,
    pub telegram: Option<Telegram>,
    pub dart_base_url: String,
    pub kind_base_url: String,
    pub spacing: Option<Duration>,
}

impl RunConfig {
    pub fn load(arguments: &Arguments, process: &Variables) -> Result<RunConfig, String> {
        let database = arguments.value("db").map(PathBuf::from).ok_or("--db <재무 DB 파일>이 필요합니다")?;
        let key_path = arguments.value("dart-key").map(PathBuf::from).ok_or("--dart-key <키 파일>이 필요합니다")?;
        let dart_base_url = official_or_loopback("dart-base-url", arguments.value("dart-base-url"), OFFICIAL_DART_URL)?;
        let kind_base_url = official_or_loopback("kind-base-url", arguments.value("kind-base-url"), OFFICIAL_KIND_URL)?;
        let spacing = match arguments.value("dart-spacing-millis") {
            None => None,
            Some(_) if dart_base_url == OFFICIAL_DART_URL => return Err("--dart-spacing-millis는 --dart-base-url이 루프백일 때만 쓸 수 있습니다".to_owned()),
            Some(text) => Some(Duration::from_millis(text.parse().map_err(|_| format!("--dart-spacing-millis가 숫자가 아닙니다: {text}"))?)),
        };
        let state_folder = match arguments.value("state") {
            Some(folder) => PathBuf::from(folder),
            None => default_state_folder(process).map_err(|error| error.to_string())?,
        };
        Ok(RunConfig {
            database,
            data_dir: arguments.data_dir(),
            key: read_key(&key_path)?,
            state_folder,
            telegram: load_telegram(arguments, process)?,
            dart_base_url,
            kind_base_url,
            spacing,
        })
    }
}

pub fn official_or_loopback(option: &str, value: Option<&str>, official: &str) -> Result<String, String> {
    let value = value.unwrap_or(official);
    if value == official {
        return Ok(value.to_owned());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| format!("--{option} 주소가 올바르지 않습니다"))?;
    let loopback = parsed.host_str().is_some_and(|host| host == "localhost" || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
    if loopback && parsed.scheme() == "http" && parsed.username().is_empty() && parsed.password().is_none() && parsed.query().is_none() && parsed.fragment().is_none() {
        Ok(value.to_owned())
    } else {
        Err(format!("--{option}는 공식 HTTPS 주소나 가짜 응답용 HTTP 루프백만 됩니다"))
    }
}

pub fn read_key(path: &Path) -> Result<Secret<String>, String> {
    let mut file = std::fs::File::open(path).map_err(|error| format!("키 파일 {}을 열 수 없습니다: {error}", path.display()))?;
    let metadata = file.metadata().map_err(|error| format!("키 파일 {}을 확인할 수 없습니다: {error}", path.display()))?;
    let mode = metadata.permissions().mode() & 0o777;
    if !metadata.is_file() || mode != KEY_MODE {
        return Err(format!("키 파일 {}의 권한이 {mode:o}입니다. 600이어야 합니다(chmod 600)", path.display()));
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|error| format!("키 파일 {}을 읽을 수 없습니다: {error}", path.display()))?;
    let key = text.trim();
    if key.is_empty() {
        return Err(format!("키 파일 {}이 비어 있습니다", path.display()));
    }
    Ok(Secret::new(key.to_owned()))
}

fn load_telegram(arguments: &Arguments, process: &Variables) -> Result<Option<Telegram>, String> {
    let default = || process.get("HOME").filter(|home| !home.is_empty()).map(|home| default_telegram_path(Path::new(home)));
    let Some(path) = arguments.value("telegram").map(PathBuf::from).or_else(default) else { return Ok(None) };
    let loaded = match arguments.value("telegram-api") {
        Some(api) => Telegram::load_at(&path, &official_or_loopback("telegram-api", Some(api), server::collector::telegram::DEFAULT_API)?),
        None => Telegram::load(&path),
    };
    loaded.map_err(|error| error.to_string())
}

pub fn socket_path(arguments: &Arguments, process: &Variables) -> Result<PathBuf, String> {
    let folder = match arguments.value("state") {
        Some(folder) => PathBuf::from(folder),
        None => default_state_folder(process).map_err(|error| error.to_string())?,
    };
    Ok(folder.join(SOCKET_FILE_NAME))
}
