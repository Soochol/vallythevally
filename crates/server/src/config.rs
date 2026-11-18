//! 설정(backend.md §11). `VALLY_ENV_FILE`이 가리키는 파일을 읽고, 프로세스 환경변수가 그 값을 덮는다.

use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};

use domain::KstTime;

use crate::account::{AccountServerUrl, ProviderSubject};
use crate::api::KiwoomEnvironment;
use crate::kiwoom::wire::parse_kst_datetime;

/// Debug와 Display 모두 "[가림]"만 낸다. 값은 `expose()`로만 꺼낸다(§11.3).
#[derive(Clone, PartialEq, Eq)]
pub struct Secret<T>(T);

impl<T> Secret<T> {
    pub fn new(v: T) -> Self {
        Secret(v)
    }

    pub fn expose(&self) -> &T {
        &self.0
    }
}

impl<T> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[가림]")
    }
}

impl<T> fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[가림]")
    }
}

#[derive(Debug, Clone)]
pub struct KiwoomCredentials {
    pub app_key: Secret<String>,
    pub app_secret: Secret<String>,
}

pub const KIWOOM_BASE_URL: &str = "https://api.kiwoom.com";
pub const KIWOOM_WS_URL: &str = "wss://api.kiwoom.com:10000/api/dostk/websocket";
pub const KIWOOM_MOCK_BASE_URL: &str = "https://mockapi.kiwoom.com";
pub const KIWOOM_MOCK_WS_URL: &str = "wss://mockapi.kiwoom.com:10000/api/dostk/websocket";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// 받는 주소. 루프백만 받는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindAddr(SocketAddr);

impl BindAddr {
    pub fn parse(s: &str) -> Result<Self, ConfigError> {
        let addr: SocketAddr = s
            .parse()
            .map_err(|_| ConfigError(format!("VALLY_BIND가 주소 형식이 아닙니다: {s}")))?;
        let loopback = match addr.ip() {
            IpAddr::V4(ip) => ip.is_loopback(),
            IpAddr::V6(ip) => ip.is_loopback(),
        };
        if loopback {
            Ok(BindAddr(addr))
        } else {
            Err(ConfigError(format!("VALLY_BIND는 루프백 주소(127.0.0.0/8, ::1)만 됩니다: {s}")))
        }
    }

    pub fn socket_addr(self) -> SocketAddr {
        self.0
    }
}


pub const REGISTERED_IP_FILE_NAME: &str = "kiwoom-ip.json";

const KNOWN_KEYS: &[&str] = &[
    "VALLY_ENV_FILE",
    "VALLY_KIWOOM_ENV",
    "VALLY_KIWOOM_MOCK_APP_KEY",
    "VALLY_KIWOOM_MOCK_APP_SECRET",
    "VALLY_KIWOOM_APP_KEY",
    "VALLY_KIWOOM_APP_SECRET",
    "VALLY_KIWOOM_BASE_URL",
    "VALLY_KIWOOM_WS_URL",
    "VALLY_CLOCK_START",
    "VALLY_DB_PATH",
    "VALLY_SCREENER_DB_PATH",
    "VALLY_SCREENER_UPDATE_ON_START",
    "VALLY_LOCK_PATH",
    "VALLY_TOKEN_PATH",
    "VALLY_KIWOOM_KEY_PATH",
    "VALLY_BIND",
    "VALLY_TELEGRAM_BOT_TOKEN",
    "VALLY_TELEGRAM_CHAT_ID",
    "VALLY_STATIC_DIR",
    "VALLY_LOG",
    "OPENDART_API_KEY",
    "VALLY_DART_BASE_URL",
    "VALLY_KIND_BASE_URL",
    "VALLY_PUBLIC_IP_URL",
    "VALLY_FINANCIAL_DB_PATH",
    "VALLY_FINANCIAL_AUTOMATIC",
    "VALLY_ACCOUNT_SERVER_URL",
    "VALLY_ACCOUNT_STATE_PATH",
    "VALLY_COLLECTOR_SOCKET",
    "VALLY_COLLECTOR_ADMINS",
];

#[derive(Debug, Clone)]
pub struct Config {
    pub kiwoom_environment: KiwoomEnvironment,
    pub kiwoom_credentials: Option<KiwoomCredentials>,
    pub kiwoom_base_url: String,
    pub kiwoom_ws_url: String,
    /// 시험용. 서버 시계가 이 KST 시각에서 시작해 실제 시간만큼 흐른다. 실제 키움 주소와 함께 주면 시작하지 않는다.
    pub clock_start: Option<KstTime>,
    pub lock_path: PathBuf,
    pub token_path: PathBuf,
    pub kiwoom_key_path: PathBuf,
    pub bind: BindAddr,
    pub static_dir: PathBuf,
    /// 사용자 자료 SQLite 파일(§7.1). 상대 경로면 서버 작업 디렉터리 기준.
    pub db_path: PathBuf,
    pub screener_db_path: PathBuf,
    pub screener_update_on_start: bool,
    pub log_filter: String,
    pub opendart_api_key: Option<Secret<String>>,
    pub dart_base_url: String,
    pub kind_base_url: String,
    pub public_ip_url: String,
    pub financial_db_path: PathBuf,
    pub financial_automatic: bool,
    pub account_server_url: Option<AccountServerUrl>,
    pub account_state_path: Option<PathBuf>,
    pub collector_socket: Option<PathBuf>,
    pub collector_admins: Vec<ProviderSubject>,
}

/// 설정을 읽으며 모은 경고. 로그를 켜기 전에 읽으므로 호출자가 나중에 남긴다.
pub type ConfigWarnings = Vec<String>;

impl Config {
    pub fn from_env() -> Result<(Config, ConfigWarnings), ConfigError> {
        let process: BTreeMap<String, String> = std::env::vars().filter(|(k, _)| k.starts_with("VALLY_") || k == "OPENDART_API_KEY").collect();
        let file = match process.get("VALLY_ENV_FILE") {
            Some(path) => read_env_file(Path::new(path))?,
            None => BTreeMap::new(),
        };
        Config::from_vars(file, process, default_lock_path, default_token_path, default_kiwoom_key_path, default_account_state_path)
    }

    /// 파일 값 위에 프로세스 값을 덮어 설정을 만든다.
    fn from_vars(
        file: BTreeMap<String, String>,
        process: BTreeMap<String, String>,
        default_lock: impl FnOnce() -> Result<PathBuf, ConfigError>,
        default_token: impl FnOnce() -> Result<PathBuf, ConfigError>,
        default_key: impl FnOnce() -> Result<PathBuf, ConfigError>,
        default_account: impl FnOnce() -> Result<PathBuf, ConfigError>,
    ) -> Result<(Config, ConfigWarnings), ConfigError> {
        let mut vars = file;
        vars.extend(process);
        let warnings = vars
            .keys()
            .filter(|k| k.starts_with("VALLY_") && !KNOWN_KEYS.contains(&k.as_str()))
            .map(|k| format!("모르는 설정 키 {k}가 있습니다. 오타인지 확인하세요"))
            .collect();
        let present = |k: &str| vars.get(k).filter(|v| !v.is_empty()).cloned();
        let url = |k: &str| vars.get(k).filter(|v| !v.is_empty()).map(|s| s.trim_end_matches('/').to_owned());
        let kiwoom_environment = match vars.get("VALLY_KIWOOM_ENV").map(String::as_str) {
            None | Some("real") => KiwoomEnvironment::Real,
            Some("mock") => KiwoomEnvironment::Mock,
            Some(_) => return Err(ConfigError("VALLY_KIWOOM_ENV는 real이나 mock입니다".into())),
        };
        let mock = kiwoom_environment == KiwoomEnvironment::Mock;
        let (official_base_url, official_ws_url) = if mock { (KIWOOM_MOCK_BASE_URL, KIWOOM_MOCK_WS_URL) } else { (KIWOOM_BASE_URL, KIWOOM_WS_URL) };
        let (kiwoom_base_url, kiwoom_ws_url) = match (url("VALLY_KIWOOM_BASE_URL"), url("VALLY_KIWOOM_WS_URL")) {
            (Some(base), Some(ws)) => (base, ws),
            (None, None) => (official_base_url.to_owned(), official_ws_url.to_owned()),
            _ => {
                return Err(ConfigError(format!(
                    "VALLY_KIWOOM_BASE_URL과 VALLY_KIWOOM_WS_URL은 둘 다 적거나 둘 다 비워 둡니다. 둘 다 비우면 투자구분 {}의 공식 키움({official_base_url}, {official_ws_url})을 씁니다",
                    kiwoom_environment.as_str()
                )));
            }
        };
        let kiwoom_credentials = if mock {
            if let Some(key) = ["VALLY_KIWOOM_APP_KEY", "VALLY_KIWOOM_APP_SECRET"].into_iter().find(|key| present(key).is_some()) {
                return Err(ConfigError(format!("VALLY_KIWOOM_ENV=mock이면 실전 키 변수 {key}를 쓰지 않습니다. 모의 키는 VALLY_KIWOOM_MOCK_APP_KEY와 VALLY_KIWOOM_MOCK_APP_SECRET에 적습니다")));
            }
            credentials_from(present("VALLY_KIWOOM_MOCK_APP_KEY"), present("VALLY_KIWOOM_MOCK_APP_SECRET"), "VALLY_KIWOOM_MOCK_APP_KEY", "VALLY_KIWOOM_MOCK_APP_SECRET")?
        } else {
            credentials_from(present("VALLY_KIWOOM_APP_KEY"), present("VALLY_KIWOOM_APP_SECRET"), "VALLY_KIWOOM_APP_KEY", "VALLY_KIWOOM_APP_SECRET")?
        };
        let clock_start = match vars.get("VALLY_CLOCK_START") {
            None => None,
            Some(s) => Some(parse_kst_datetime(s).ok_or_else(|| ConfigError(format!("VALLY_CLOCK_START는 KST YYYYMMDDHHMMSS입니다: {s}")))?),
        };
        let rest_endpoint = Endpoint::of("VALLY_KIWOOM_BASE_URL", &kiwoom_base_url, kiwoom_environment)?;
        if rest_endpoint != Endpoint::of("VALLY_KIWOOM_WS_URL", &kiwoom_ws_url, kiwoom_environment)? {
            return Err(ConfigError("VALLY_KIWOOM_BASE_URL과 VALLY_KIWOOM_WS_URL은 둘 다 실제 키움이거나 둘 다 루프백 주소여야 합니다".into()));
        }
        if clock_start.is_some() && rest_endpoint == Endpoint::Official {
            return Err(ConfigError("VALLY_CLOCK_START는 루프백 키움 주소(VALLY_KIWOOM_BASE_URL, VALLY_KIWOOM_WS_URL)와만 쓸 수 있습니다".into()));
        }
        let dart_base_url = public_or_loopback("VALLY_DART_BASE_URL", url("VALLY_DART_BASE_URL"), "https://opendart.fss.or.kr")?;
        let kind_base_url = public_or_loopback("VALLY_KIND_BASE_URL", url("VALLY_KIND_BASE_URL"), "https://kind.krx.co.kr")?;
        let public_ip_url = public_or_loopback("VALLY_PUBLIC_IP_URL", url("VALLY_PUBLIC_IP_URL"), "https://api.ipify.org")?;
        let account_server_url = url("VALLY_ACCOUNT_SERVER_URL").map(|value| AccountServerUrl::parse(&value).map_err(|e| ConfigError(format!("VALLY_ACCOUNT_SERVER_URL: {e}")))).transpose()?;
        if mock && account_server_url.is_some() {
            return Err(ConfigError("VALLY_KIWOOM_ENV=mock이면 VALLY_ACCOUNT_SERVER_URL을 쓰지 않습니다. 셋업 동기화가 실전과 모의의 레이아웃·설정을 한 문서로 합칩니다".into()));
        }
        let account_state_path = match (vars.get("VALLY_ACCOUNT_STATE_PATH"), &account_server_url) {
            (Some(p), _) => Some(PathBuf::from(p)),
            (None, Some(_)) => Some(default_account()?),
            (None, None) if mock => None,
            (None, None) => default_account().ok(),
        };
        let collector_admins = parse_collector_admins(vars.get("VALLY_COLLECTOR_ADMINS").map_or("", String::as_str))?;
        let collector_socket = present("VALLY_COLLECTOR_SOCKET").map(PathBuf::from);
        if !collector_admins.is_empty() && collector_socket.is_none() {
            return Err(ConfigError("VALLY_COLLECTOR_ADMINS를 적으면 VALLY_COLLECTOR_SOCKET(감독 데몬의 unix socket 경로)도 적어야 합니다".into()));
        }
        let state_default = |default: Result<PathBuf, ConfigError>| -> Result<PathBuf, ConfigError> { default.map(|path| if mock { under_mock(path) } else { path }) };
        let (default_db, default_screener_db, default_bind) = if mock { ("data/mock/vally.db", "data/mock/screener.duckdb", "127.0.0.1:8081") } else { ("data/vally.db", "data/screener.duckdb", "127.0.0.1:8080") };
        let db_path = PathBuf::from(vars.get("VALLY_DB_PATH").map_or(default_db, String::as_str));
        let config = Config {
            kiwoom_environment,
            kiwoom_credentials,
            kiwoom_base_url,
            kiwoom_ws_url,
            clock_start,
            lock_path: match vars.get("VALLY_LOCK_PATH") {
                Some(p) => PathBuf::from(p),
                None => state_default(default_lock())?,
            },
            token_path: match vars.get("VALLY_TOKEN_PATH") {
                Some(p) => PathBuf::from(p),
                None => state_default(default_token())?,
            },
            kiwoom_key_path: match vars.get("VALLY_KIWOOM_KEY_PATH") {
                Some(p) => PathBuf::from(p),
                None => state_default(default_key())?,
            },
            bind: BindAddr::parse(vars.get("VALLY_BIND").map_or(default_bind, String::as_str))?,
            static_dir: PathBuf::from(vars.get("VALLY_STATIC_DIR").map_or("web/dist", String::as_str)),
            screener_db_path: PathBuf::from(vars.get("VALLY_SCREENER_DB_PATH").map_or(default_screener_db, String::as_str)),
            screener_update_on_start: match vars.get("VALLY_SCREENER_UPDATE_ON_START").map(String::as_str) {
                None => !mock,
                Some("on") => true,
                Some("off") => false,
                Some(other) => return Err(ConfigError(format!("VALLY_SCREENER_UPDATE_ON_START는 on이나 off입니다: {other}"))),
            },
            account_server_url,
            account_state_path,
            collector_socket,
            collector_admins,
            financial_automatic: match vars.get("VALLY_FINANCIAL_AUTOMATIC").map(String::as_str) {
                None | Some("on") => true,
                Some("off") => false,
                Some(other) => return Err(ConfigError(format!("VALLY_FINANCIAL_AUTOMATIC는 on이나 off입니다: {other}"))),
            },
            opendart_api_key: vars.get("OPENDART_API_KEY").filter(|s| !s.is_empty()).cloned().map(Secret::new),
            dart_base_url,
            kind_base_url,
            public_ip_url,
            financial_db_path: vars.get("VALLY_FINANCIAL_DB_PATH").map(PathBuf::from).unwrap_or_else(|| db_path.with_file_name("financials.db")),
            db_path,
            log_filter: vars.get("VALLY_LOG").cloned().unwrap_or_else(|| "info".to_owned()),
        };
        let registered_ip_path = config.kiwoom_key_path.with_file_name(REGISTERED_IP_FILE_NAME);
        let other_files = [
            ("VALLY_KIWOOM_KEY_PATH", &config.kiwoom_key_path),
            ("VALLY_TOKEN_PATH", &config.token_path),
            ("VALLY_LOCK_PATH", &config.lock_path),
            ("VALLY_DB_PATH", &config.db_path),
            ("VALLY_SCREENER_DB_PATH", &config.screener_db_path),
            ("VALLY_FINANCIAL_DB_PATH", &config.financial_db_path),
        ];
        if let Some((key, _)) = other_files.iter().find(|(_, path)| Some(*path) == config.account_state_path.as_ref()) {
            return Err(ConfigError(format!("{key}가 계정 상태 파일(VALLY_ACCOUNT_STATE_PATH)과 같은 파일입니다")));
        }
        let order_switch_path = config.kiwoom_key_path.with_file_name(crate::trading::ORDER_SWITCH_FILE_NAME);
        if let Some((key, _)) = other_files.iter().find(|(_, path)| **path == order_switch_path) {
            return Err(ConfigError(format!("{key}가 주문 사용 스위치 파일({}, 키 파일과 같은 폴더)과 같은 파일입니다", crate::trading::ORDER_SWITCH_FILE_NAME)));
        }
        if let Some((key, _)) = other_files.iter().find(|(_, path)| **path == registered_ip_path) {
            return Err(ConfigError(format!("{key}가 포털에 등록한 IP 기록 파일({REGISTERED_IP_FILE_NAME}, 키 파일과 같은 폴더)과 같은 파일입니다")));
        }
        Ok((config, warnings))
    }
}

fn credentials_from(app_key: Option<String>, app_secret: Option<String>, key_name: &str, secret_name: &str) -> Result<Option<KiwoomCredentials>, ConfigError> {
    match (app_key, app_secret) {
        (Some(app_key), Some(app_secret)) => Ok(Some(KiwoomCredentials { app_key: Secret::new(app_key), app_secret: Secret::new(app_secret) })),
        (None, None) => Ok(None),
        _ => Err(ConfigError(format!("{key_name}와 {secret_name}은 둘 다 적거나 둘 다 비워 둡니다"))),
    }
}

fn under_mock(path: PathBuf) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => dir.join("mock").join(name),
        _ => path,
    }
}

fn public_or_loopback(key: &str, value: Option<String>, official: &str) -> Result<String, ConfigError> {
    let value = value.unwrap_or_else(|| official.into());
    if value == official { return Ok(value); }
    let parsed = reqwest::Url::parse(&value).map_err(|_| ConfigError(format!("{key} 주소가 올바르지 않습니다")))?;
    let loopback = parsed.host_str().is_some_and(|h| h == "localhost" || h.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()));
    if loopback && parsed.scheme() == "http" && parsed.username().is_empty() && parsed.password().is_none() && parsed.query().is_none() && parsed.fragment().is_none() {
        Ok(value)
    } else { Err(ConfigError(format!("{key}는 공식 HTTPS 주소나 가짜 응답용 HTTP 루프백만 됩니다"))) }
}

#[derive(Debug, PartialEq, Eq)]
enum Endpoint {
    Official,
    Loopback,
}

impl Endpoint {
    fn of(key: &str, url: &str, environment: KiwoomEnvironment) -> Result<Endpoint, ConfigError> {
        let official_host = match environment {
            KiwoomEnvironment::Real => "api.kiwoom.com",
            KiwoomEnvironment::Mock => "mockapi.kiwoom.com",
        };
        let invalid = || ConfigError(format!("VALLY_KIWOOM_ENV={}이면 {key}는 {official_host}이거나 루프백 주소여야 합니다: {url}", environment.as_str()));
        let parsed = reqwest::Url::parse(url).map_err(|_| invalid())?;
        let host = parsed.host_str().ok_or_else(invalid)?.trim_end_matches('.');
        if host == official_host {
            return Ok(Endpoint::Official);
        }
        let loopback = host == "localhost" || host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
        if loopback { Ok(Endpoint::Loopback) } else { Err(invalid()) }
    }
}

/// `$XDG_RUNTIME_DIR/vallythevally/server.lock`, 없으면 `/tmp/vallythevally-<uid>/server.lock`(§4.1).
fn default_lock_path() -> Result<PathBuf, ConfigError> {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir).join("vallythevally").join("server.lock"));
    }
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata("/proc/self")
        .map_err(|e| ConfigError(format!("사용자 번호를 알 수 없어 잠금 파일 경로를 정할 수 없습니다: {e}")))?
        .uid();
    Ok(PathBuf::from(format!("/tmp/vallythevally-{uid}/server.lock")))
}

fn parse_collector_admins(value: &str) -> Result<Vec<ProviderSubject>, ConfigError> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut admins: Vec<ProviderSubject> = Vec::new();
    for entry in value.split(',') {
        let admin = ProviderSubject::parse(entry.trim()).map_err(|e| ConfigError(format!("VALLY_COLLECTOR_ADMINS: {e}")))?;
        if !admins.contains(&admin) {
            admins.push(admin);
        }
    }
    Ok(admins)
}

fn default_token_path() -> Result<PathBuf, ConfigError> {
    state_file_path_from(std::env::var_os("XDG_STATE_HOME"), std::env::var_os("HOME"), "token.json", "VALLY_TOKEN_PATH")
}

fn default_kiwoom_key_path() -> Result<PathBuf, ConfigError> {
    state_file_path_from(std::env::var_os("XDG_STATE_HOME"), std::env::var_os("HOME"), "kiwoom-key.json", "VALLY_KIWOOM_KEY_PATH")
}

fn default_account_state_path() -> Result<PathBuf, ConfigError> {
    state_file_path_from(std::env::var_os("XDG_STATE_HOME"), std::env::var_os("HOME"), "account.json", "VALLY_ACCOUNT_STATE_PATH")
}

fn state_file_path_from(state_home: Option<std::ffi::OsString>, home: Option<std::ffi::OsString>, file_name: &str, override_key: &str) -> Result<PathBuf, ConfigError> {
    let nonempty = |v: Option<std::ffi::OsString>| v.filter(|d| !d.is_empty()).map(PathBuf::from);
    let state = match (nonempty(state_home), nonempty(home)) {
        (Some(state), _) => state,
        (None, Some(home)) => home.join(".local/state"),
        (None, None) => return Err(ConfigError(format!("XDG_STATE_HOME도 HOME도 없어 {file_name} 경로를 정할 수 없습니다. {override_key}를 주세요"))),
    };
    Ok(state.join("vallythevally").join(file_name))
}

fn read_env_file(path: &Path) -> Result<BTreeMap<String, String>, ConfigError> {
    if !path.is_absolute() {
        return Err(ConfigError(format!("VALLY_ENV_FILE은 절대 경로여야 합니다: {}", path.display())));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| ConfigError(format!("설정 파일을 읽을 수 없습니다({}): {e}", path.display())))?;
    parse_env(&text)
}

/// `KEY=VALUE` 줄만 읽는다. 빈 줄과 `#` 줄은 건너뛴다. 값을 감싼 따옴표 한 쌍은 벗긴다.
fn parse_env(text: &str) -> Result<BTreeMap<String, String>, ConfigError> {
    let mut out = BTreeMap::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            return Err(ConfigError(format!("설정 파일 {}번째 줄에 '='가 없습니다", i + 1)));
        };
        let v = v.trim();
        let v = [('"', '"'), ('\'', '\'')]
            .iter()
            .find_map(|&(a, b)| v.strip_prefix(a).and_then(|s| s.strip_suffix(b)))
            .unwrap_or_else(|| v.split_once(" #").map_or(v, |(before, _)| before.trim_end()));
        out.insert(k.trim().to_owned(), v.to_owned());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "FAKE-APPKEY-cfg-1111";
    const SECRET: &str = "FAKE-SECRET-cfg-2222";

    const REAL: [(&str, &str); 2] = [("VALLY_KIWOOM_BASE_URL", "https://api.kiwoom.com"), ("VALLY_KIWOOM_WS_URL", "wss://api.kiwoom.com:10000/api/dostk/websocket")];

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn lock() -> Result<PathBuf, ConfigError> {
        Ok(PathBuf::from("/nonexistent/test.lock"))
    }

    fn token() -> Result<PathBuf, ConfigError> {
        Ok(PathBuf::from("/nonexistent/token.json"))
    }

    fn key() -> Result<PathBuf, ConfigError> {
        Ok(PathBuf::from("/nonexistent/kiwoom-key.json"))
    }

    fn account() -> Result<PathBuf, ConfigError> {
        Ok(PathBuf::from("/nonexistent/account.json"))
    }

    #[test]
    fn dart_is_optional_redacted_and_uses_separate_rebuildable_storage() {
        let file = vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET), ("VALLY_DB_PATH", "isolated/user.db"), ("OPENDART_API_KEY", "file-dart-secret")]);
        let mut process = vars(&REAL);
        process.insert("OPENDART_API_KEY".into(), "process-dart-secret".into());
        let (config, warnings) = Config::from_vars(file.clone(),process,lock,token,key, account).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(config.opendart_api_key.as_ref().unwrap().expose(), "process-dart-secret");
        assert_eq!(config.financial_db_path, PathBuf::from("isolated/financials.db"));
        assert!(!format!("{config:?}").contains("dart-secret"));
        for endpoint in ["https://example.com", "https://opendart.fss.or.kr.evil.test", "http://user:pass@localhost:19", "http://localhost:19/?key=value"] {
            let mut process = vars(&REAL);
            process.insert("VALLY_DART_BASE_URL".into(),endpoint.into());
            assert!(Config::from_vars(file.clone(),process,lock,token,key, account).is_err());
        }
    }

    #[test]
    fn secret_never_prints_its_value() {
        let s = Secret::new(KEY.to_owned());
        assert_eq!(format!("{s:?}"), "[가림]");
        assert_eq!(format!("{s}"), "[가림]");
        assert_eq!(s.expose(), KEY);
    }

    #[test]
    fn config_debug_hides_keys() {
        let (c, _) = Config::from_vars(
            vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET)]),
            vars(&REAL),
            lock,
            token,
            key,
            account,
        )
        .unwrap();
        let dbg = format!("{c:?} {c:#?}");
        assert!(!dbg.contains(KEY) && !dbg.contains(SECRET), "{dbg}");
        assert!(dbg.contains("[가림]"));
    }

    #[test]
    fn process_overrides_file_and_defaults_apply() {
        let (c, warnings) = Config::from_vars(
            vars(&[("VALLY_KIWOOM_APP_KEY", "file"), ("VALLY_KIWOOM_APP_SECRET", SECRET), ("VALLY_BIND", "127.0.0.1:9")]),
            vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:5/"), ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:5/api/dostk/websocket")]),
            lock,
            token,
            key,
            account,
        )
        .unwrap();
        assert!(warnings.is_empty());
        assert_eq!(c.kiwoom_credentials.as_ref().unwrap().app_key.expose(), KEY);
        assert_eq!(c.kiwoom_base_url, "http://127.0.0.1:5");
        assert_eq!(c.bind.socket_addr().port(), 9);
        assert_eq!(c.static_dir, PathBuf::from("web/dist"));
        assert_eq!(c.db_path, PathBuf::from("data/vally.db"));
        assert_eq!(c.screener_db_path, PathBuf::from("data/screener.duckdb"));
        assert!(c.screener_update_on_start, "서버를 켤 때 뒤처진 스크리너 저장소를 채우는 것이 기본이다");
        assert_eq!(c.log_filter, "info");
        assert_eq!(c.lock_path, PathBuf::from("/nonexistent/test.lock"));
        assert_eq!(c.token_path, PathBuf::from("/nonexistent/token.json"));
        assert_eq!(c.kiwoom_key_path, PathBuf::from("/nonexistent/kiwoom-key.json"));

        let (c, _) = Config::from_vars(vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET)]), vars(&REAL), lock, token, key, account).unwrap();
        assert_eq!(c.bind.socket_addr(), "127.0.0.1:8080".parse().unwrap());
    }

    #[test]
    fn kiwoom_keys_are_optional_but_never_half_given_and_unknown_keys_warn() {
        let start = |pairs: &[(&str, &str)]| Config::from_vars(vars(pairs), BTreeMap::new(), lock, token, key, account);
        assert!(start(&[("VALLY_KIWOOM_APP_KEY", KEY)]).is_err(), "앱키만");
        assert!(start(&[("VALLY_KIWOOM_APP_SECRET", SECRET)]).is_err(), "시크릿만");
        assert!(start(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", "")]).is_err(), "빈 시크릿");
        assert!(start(&[]).unwrap().0.kiwoom_credentials.is_none(), "키 없이 켜진다");
        let (c, _) = start(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET)]).unwrap();
        assert_eq!(c.kiwoom_credentials.unwrap().app_secret.expose(), SECRET);
        let (_, warnings) = Config::from_vars(
            vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET), ("VALLY_BIDN", "x")]),
            vars(&REAL),
            lock,
            token,
            key,
            account,
        )
        .unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("VALLY_BIDN"));
    }

    #[test]
    fn kiwoom_urls_must_both_be_official_or_both_loopback() {
        let keys = [("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET)];
        let rest = ("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:5");
        let ws = ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:5/api/dostk/websocket");
        let start = |extra: &[(&str, &str)]| Config::from_vars(vars(&keys), vars(extra), lock, token, key, account);
        let (c, _) = start(&[]).expect("둘 다 비우면 실제 키움");
        assert_eq!((c.kiwoom_base_url.as_str(), c.kiwoom_ws_url.as_str()), (REAL[0].1, REAL[1].1));
        assert!(start(&[rest]).is_err(), "루프백 REST만");
        assert!(start(&[ws]).is_err(), "루프백 WS만");
        assert!(start(&REAL[..1]).is_err(), "실제 REST만");
        assert!(start(&REAL[1..]).is_err(), "실제 WS만");
        assert!(start(&[rest, ("VALLY_KIWOOM_WS_URL", "")]).is_err(), "빈 값");
        assert!(start(&[rest, REAL[1]]).is_err(), "루프백 REST + 실제 WS");
        assert!(start(&[REAL[0], ws]).is_err(), "실제 REST + 루프백 WS");
        let (c, _) = start(&[rest, ws]).expect("둘 다 루프백");
        assert_eq!((c.kiwoom_base_url.as_str(), c.kiwoom_ws_url.as_str()), (rest.1, ws.1));
        let (c, _) = start(&REAL).expect("둘 다 실제 키움");
        assert_eq!((c.kiwoom_base_url.as_str(), c.kiwoom_ws_url.as_str()), (REAL[0].1, REAL[1].1));
    }

    #[test]
    fn clock_start_requires_loopback_kiwoom_endpoints() {
        let keys = [("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET), ("VALLY_CLOCK_START", "20261109100000")];
        let loopback = [("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:5"), ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:5/api/dostk/websocket")];
        let (c, _) = Config::from_vars(vars(&keys), vars(&loopback), lock, token, key, account).unwrap();
        assert_eq!(c.clock_start.map(|t| t.to_string()), Some("2026-11-09 10:00:00 KST".to_owned()));
        assert_eq!(c.kiwoom_ws_url, "ws://127.0.0.1:5/api/dostk/websocket");

        assert!(Config::from_vars(vars(&keys), vars(&REAL), lock, token, key, account).is_err(), "실제 키움 주소와 함께면 거부");
        let bad = [("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET), ("VALLY_CLOCK_START", "2026-11-09")];
        assert!(Config::from_vars(vars(&bad), vars(&loopback), lock, token, key, account).is_err());

        let (c, _) = Config::from_vars(vars(&keys[..2]), vars(&REAL), lock, token, key, account).unwrap();
        assert_eq!(c.clock_start, None);
    }

    #[test]
    fn screener_update_on_start_is_on_or_off() {
        let start = |value: &str| Config::from_vars(vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET), ("VALLY_SCREENER_UPDATE_ON_START", value)]), vars(&REAL), lock, token, key, account);
        assert!(start("on").unwrap().0.screener_update_on_start);
        assert!(!start("off").unwrap().0.screener_update_on_start);
        assert!(start("no").is_err());
    }

    #[test]
    fn token_and_key_paths_follow_xdg_state_home_then_home() {
        let os = |s: &str| Some(std::ffi::OsString::from(s));
        let token = |state, home| state_file_path_from(state, home, "token.json", "VALLY_TOKEN_PATH");
        let key = |state, home| state_file_path_from(state, home, "kiwoom-key.json", "VALLY_KIWOOM_KEY_PATH");
        assert_eq!(token(os("/s"), os("/h")).unwrap(), PathBuf::from("/s/vallythevally/token.json"));
        assert_eq!(token(os(""), os("/h")).unwrap(), PathBuf::from("/h/.local/state/vallythevally/token.json"));
        assert_eq!(key(os("/s"), os("/h")).unwrap(), PathBuf::from("/s/vallythevally/kiwoom-key.json"));
        assert_eq!(key(os(""), os("/h")).unwrap(), PathBuf::from("/h/.local/state/vallythevally/kiwoom-key.json"));
        assert!(token(None, None).is_err() && key(None, None).is_err());
    }

    #[test]
    fn bind_is_loopback_only() {
        for ok in ["127.0.0.1:8080", "127.1.2.3:1", "[::1]:8080", "127.0.0.1:0"] {
            assert!(BindAddr::parse(ok).is_ok(), "{ok}");
        }
        for bad in ["0.0.0.0:8080", "192.168.0.2:8080", "[::]:8080", "100.64.0.1:80", "localhost:8080", "127.0.0.1"] {
            assert!(BindAddr::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn env_file_parsing() {
        let m = parse_env("# c\n\nVALLY_A=1 # 주석\nexport VALLY_B = \"two # words\"\nVALLY_C='x=y'\nVALLY_D=a#b\n").unwrap();
        assert_eq!(m["VALLY_D"], "a#b");
        assert_eq!(m["VALLY_A"], "1");
        assert_eq!(m["VALLY_B"], "two # words");
        assert_eq!(m["VALLY_C"], "x=y");
        assert!(parse_env("NOEQUALS\n").is_err());
        assert!(read_env_file(Path::new("relative/.env")).is_err());
    }

    #[test]
    fn kiwoom_endpoints_are_classified_by_parsed_host_and_local_endpoints_require_loopback() {
        let keys = [("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET)];
        let start = |rest: &str, ws: &str, clock: bool| {
            let mut process = vars(&[("VALLY_KIWOOM_BASE_URL", rest), ("VALLY_KIWOOM_WS_URL", ws)]);
            if clock {
                process.insert("VALLY_CLOCK_START".into(), "20261109100000".into());
            }
            Config::from_vars(vars(&keys), process, lock, token, key, account)
        };
        let loopback_rest = "http://127.0.0.1:5";
        let loopback_ws = "ws://127.0.0.1:5/api/dostk/websocket";
        for real_ws in ["wss://API.KIWOOM.COM:10000/api/dostk/websocket", "wss://api.kiwoom.com:10000/api/dostk/websocket?", "wss://api.kiwoom.com./api/dostk/websocket", "wss://mockapi.kiwoom.com:10000/api/dostk/websocket"] {
            assert!(start(loopback_rest, real_ws, true).is_err(), "루프백 REST + 실제 WS: {real_ws}");
            assert!(start(loopback_rest, real_ws, false).is_err(), "루프백 REST + 실제 WS: {real_ws}");
        }
        assert!(start("https://API.kiwoom.com", loopback_ws, true).is_err(), "실제 REST + 루프백 WS");
        assert!(start("https://api.kiwoom.com", "wss://API.KIWOOM.COM:10000/api/dostk/websocket", true).is_err(), "시험 시계 + 실제 키움");
        assert!(start("https://api.kiwoom.com", "wss://API.KIWOOM.COM:10000/api/dostk/websocket", false).is_ok(), "둘 다 실제 키움");
        assert!(start("http://example.com", "ws://example.com/ws", true).is_err(), "시험 주소는 루프백만");
        assert!(start("not a url", loopback_ws, true).is_err());
        assert!(start("http://localhost:5", "ws://[::1]:5/ws", true).is_ok(), "루프백 이름과 IPv6");
    }

    #[test]
    fn the_public_ip_service_is_the_official_https_address_or_a_loopback_http_stand_in() {
        let start = |pairs: &[(&str, &str)]| Config::from_vars(vars(&[]), vars(pairs), lock, token, key, account).map(|(config, _)| config.public_ip_url);
        assert_eq!(start(&[]).unwrap(), "https://api.ipify.org");
        assert_eq!(start(&[("VALLY_PUBLIC_IP_URL", "http://127.0.0.1:9/")]).unwrap(), "http://127.0.0.1:9");
        assert_eq!(start(&[("VALLY_PUBLIC_IP_URL", "http://localhost:9")]).unwrap(), "http://localhost:9");
        for refused in ["http://example.com", "https://example.com", "http://user:pw@127.0.0.1:9", "http://127.0.0.1:9/?k=v", "not a url"] {
            let error = start(&[("VALLY_PUBLIC_IP_URL", refused)]).expect_err(refused).to_string();
            assert!(error.contains("VALLY_PUBLIC_IP_URL"), "{error}");
        }
    }

    #[test]
    fn the_account_server_is_optional_and_only_https_or_a_loopback_origin() {
        let start = |pairs: &[(&str, &str)]| Config::from_vars(vars(&[]), vars(pairs), lock, token, key, account).map(|(config, _)| config.account_server_url.map(|url| url.as_str().to_owned()));
        assert_eq!(start(&[]).unwrap(), None, "주소가 없으면 로컬 전용");
        assert_eq!(start(&[("VALLY_ACCOUNT_SERVER_URL", "")]).unwrap(), None);
        assert_eq!(start(&[("VALLY_ACCOUNT_SERVER_URL", "https://account.example.com/")]).unwrap().as_deref(), Some("https://account.example.com"));
        assert_eq!(start(&[("VALLY_ACCOUNT_SERVER_URL", "http://127.0.0.1:8090")]).unwrap().as_deref(), Some("http://127.0.0.1:8090"));
        for bad in ["http://account.example.com", "http://localhost:8090", "https://account.example.com/v1", "https://u:p@account.example.com", "account.example.com"] {
            assert!(start(&[("VALLY_ACCOUNT_SERVER_URL", bad)]).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_collector_allow_list_is_provider_colon_subject_pairs_and_a_bad_entry_stops_the_start() {
        let start = |pairs: &[(&str, &str)]| Config::from_vars(vars(&[]), vars(pairs), lock, token, key, account).map(|(config, _)| config);
        let socket = ("VALLY_COLLECTOR_SOCKET", "/run/collector/supervise.sock");
        let none = start(&[]).unwrap();
        assert!(none.collector_admins.is_empty() && none.collector_socket.is_none(), "설정이 없으면 현황판은 꺼진다");
        assert!(start(&[("VALLY_COLLECTOR_ADMINS", " ")]).unwrap().collector_admins.is_empty());
        let listed = start(&[socket, ("VALLY_COLLECTOR_ADMINS", "google:1234, naver:abc:def ,google:1234")]).unwrap();
        let names: Vec<(crate::api::AccountProvider, &str)> = listed.collector_admins.iter().map(|admin| (admin.provider, admin.subject.as_str())).collect();
        assert_eq!(names, [(crate::api::AccountProvider::Google, "1234"), (crate::api::AccountProvider::Naver, "abc:def")], "같은 항목은 한 번만 센다");
        assert_eq!(listed.collector_socket, Some(PathBuf::from("/run/collector/supervise.sock")));
        for bad in ["1234", "kakao:1234", "google:", ":1234", "google:1234,", ",google:1234", "google:12 34", "Google:1234"] {
            let error = start(&[socket, ("VALLY_COLLECTOR_ADMINS", bad)]).expect_err(bad).to_string();
            assert!(error.contains("VALLY_COLLECTOR_ADMINS"), "{error}");
        }
        let error = start(&[("VALLY_COLLECTOR_ADMINS", "google:1234")]).expect_err("소켓 없이 허용 목록만").to_string();
        assert!(error.contains("VALLY_COLLECTOR_SOCKET"), "{error}");
        assert!(start(&[socket]).is_ok(), "소켓만 있고 허용 목록이 비어도 시작한다(꺼짐)");
    }

    #[test]
    fn local_only_mode_does_not_need_a_home_for_the_account_state_file() {
        let no_home = || Err(ConfigError("HOME이 없다".into()));
        let (c, _) = Config::from_vars(vars(&[]), vars(&[]), lock, token, key, no_home).unwrap();
        assert_eq!(c.account_state_path, None);
        let linked = vars(&[("VALLY_ACCOUNT_SERVER_URL", "https://account.example.com")]);
        assert!(Config::from_vars(vars(&[]), linked.clone(), lock, token, key, no_home).is_err(), "계정 서버를 쓰면 상태 파일 경로가 필요하다");
        let with_path = vars(&[("VALLY_ACCOUNT_SERVER_URL", "https://account.example.com"), ("VALLY_ACCOUNT_STATE_PATH", "/x/account.json")]);
        assert!(Config::from_vars(vars(&[]), with_path, lock, token, key, no_home).is_ok());
    }

    #[test]
    fn the_account_state_path_defaults_under_xdg_state_and_cannot_be_another_file() {
        let (c, _) = Config::from_vars(vars(&[]), vars(&[("VALLY_ACCOUNT_STATE_PATH", "/x/account.json")]), lock, token, key, account).unwrap();
        assert_eq!(c.account_state_path, Some(PathBuf::from("/x/account.json")));
        let (c, _) = Config::from_vars(vars(&[]), vars(&[]), lock, token, key, account).unwrap();
        assert_eq!(c.account_state_path, Some(PathBuf::from("/nonexistent/account.json")));
        assert_eq!(state_file_path_from(Some("/s".into()), Some("/h".into()), "account.json", "K").unwrap(), PathBuf::from("/s/vallythevally/account.json"));
        assert_eq!(state_file_path_from(None, Some("/h".into()), "account.json", "K").unwrap(), PathBuf::from("/h/.local/state/vallythevally/account.json"));
        assert!(Config::from_vars(vars(&[]), vars(&[("VALLY_ACCOUNT_STATE_PATH", "/nonexistent/token.json")]), lock, token, key, account).is_err());
    }

    #[test]
    fn no_other_file_can_be_the_registered_ip_file_next_to_the_key_file() {
        let start = |pairs: &[(&str, &str)]| Config::from_vars(vars(&[]), vars(pairs), lock, token, key, account).map(|_| ());
        let beside_key = "/state/vally/kiwoom-ip.json";
        for key_name in ["VALLY_KIWOOM_KEY_PATH", "VALLY_TOKEN_PATH", "VALLY_LOCK_PATH", "VALLY_DB_PATH", "VALLY_SCREENER_DB_PATH", "VALLY_FINANCIAL_DB_PATH"] {
            let pairs = if key_name == "VALLY_KIWOOM_KEY_PATH" { vec![(key_name, beside_key)] } else { vec![("VALLY_KIWOOM_KEY_PATH", "/state/vally/kiwoom-key.json"), (key_name, beside_key)] };
            let error = start(&pairs).expect_err(key_name).to_string();
            assert!(error.contains(key_name) && error.contains("kiwoom-ip.json"), "{error}");
        }
        assert!(start(&[("VALLY_KIWOOM_KEY_PATH", "/state/vally/kiwoom-key.json"), ("VALLY_TOKEN_PATH", "/elsewhere/kiwoom-ip.json")]).is_ok(), "다른 폴더의 같은 이름은 겹치지 않는다");
    }

    #[test]
    fn no_other_file_can_be_the_order_switch_file_next_to_the_key_file() {
        let start = |pairs: &[(&str, &str)]| Config::from_vars(vars(&[]), vars(pairs), lock, token, key, account).map(|_| ());
        for key_name in ["VALLY_TOKEN_PATH", "VALLY_LOCK_PATH", "VALLY_DB_PATH", "VALLY_SCREENER_DB_PATH", "VALLY_FINANCIAL_DB_PATH"] {
            let error = start(&[("VALLY_KIWOOM_KEY_PATH", "/state/vally/kiwoom-key.json"), (key_name, "/state/vally/kiwoom-orders.json")]).expect_err(key_name).to_string();
            assert!(error.contains(key_name) && error.contains("kiwoom-orders.json"), "{error}");
        }
        assert!(start(&[("VALLY_KIWOOM_KEY_PATH", "/state/vally/kiwoom-key.json"), ("VALLY_TOKEN_PATH", "/elsewhere/kiwoom-orders.json")]).is_ok());
    }

    const MOCK_KEY: &str = "FAKE-MOCK-APPKEY-cfg-3333";
    const MOCK_SECRET: &str = "FAKE-MOCK-SECRET-cfg-4444";
    const MOCK_KEYS: [(&str, &str); 3] = [("VALLY_KIWOOM_ENV", "mock"), ("VALLY_KIWOOM_MOCK_APP_KEY", MOCK_KEY), ("VALLY_KIWOOM_MOCK_APP_SECRET", MOCK_SECRET)];
    const MOCK_HOSTS: [(&str, &str); 2] = [("VALLY_KIWOOM_BASE_URL", "https://mockapi.kiwoom.com"), ("VALLY_KIWOOM_WS_URL", "wss://mockapi.kiwoom.com:10000/api/dostk/websocket")];

    fn start(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        Config::from_vars(vars(&[]), vars(pairs), lock, token, key, account).map(|(config, _)| config)
    }

    #[test]
    fn mock_env_uses_mock_hosts_and_mock_state_paths() {
        let config = start(&MOCK_KEYS).unwrap();
        assert_eq!(config.kiwoom_environment, KiwoomEnvironment::Mock);
        assert_eq!((config.kiwoom_base_url.as_str(), config.kiwoom_ws_url.as_str()), (MOCK_HOSTS[0].1, MOCK_HOSTS[1].1));
        let credentials = config.kiwoom_credentials.as_ref().unwrap();
        assert_eq!((credentials.app_key.expose().as_str(), credentials.app_secret.expose().as_str()), (MOCK_KEY, MOCK_SECRET));
        assert_eq!(config.lock_path, PathBuf::from("/nonexistent/mock/test.lock"));
        assert_eq!(config.token_path, PathBuf::from("/nonexistent/mock/token.json"));
        assert_eq!(config.kiwoom_key_path, PathBuf::from("/nonexistent/mock/kiwoom-key.json"));
        assert_eq!(config.db_path, PathBuf::from("data/mock/vally.db"));
        assert_eq!(config.screener_db_path, PathBuf::from("data/mock/screener.duckdb"));
        assert_eq!(config.financial_db_path, PathBuf::from("data/mock/financials.db"));
        assert_eq!(config.bind.socket_addr(), "127.0.0.1:8081".parse().unwrap());
        assert!(!config.screener_update_on_start);
        assert_eq!(config.account_state_path, None, "모의에서는 기본 계정 상태 파일을 쓰지 않는다");

        let mut explicit = MOCK_KEYS.to_vec();
        explicit.extend([("VALLY_BIND", "127.0.0.1:9"), ("VALLY_DB_PATH", "elsewhere/user.db"), ("VALLY_TOKEN_PATH", "/x/token.json"), ("VALLY_SCREENER_UPDATE_ON_START", "on")]);
        let config = start(&explicit).unwrap();
        assert_eq!(config.bind.socket_addr().port(), 9);
        assert_eq!((config.db_path, config.token_path), (PathBuf::from("elsewhere/user.db"), PathBuf::from("/x/token.json")), "명시한 값이 기본값보다 앞선다");
        assert_eq!(config.financial_db_path, PathBuf::from("elsewhere/financials.db"));
        assert!(config.screener_update_on_start);

        let real = start(&[]).unwrap();
        assert_eq!(real.kiwoom_environment, KiwoomEnvironment::Real);
        assert_eq!((real.kiwoom_base_url.as_str(), real.bind.socket_addr().port(), real.db_path), (KIWOOM_BASE_URL, 8080, PathBuf::from("data/vally.db")));
        assert_eq!(real.lock_path, PathBuf::from("/nonexistent/test.lock"));
        assert!(real.screener_update_on_start);
        assert!(start(&[("VALLY_KIWOOM_ENV", "real")]).is_ok());
        let keyless = start(&[("VALLY_KIWOOM_ENV", "mock")]).unwrap();
        assert!(keyless.kiwoom_credentials.is_none(), "모의도 키 없이 켜진다");
    }

    #[test]
    fn mock_env_refuses_real_keys_and_real_hosts() {
        for real_key in ["VALLY_KIWOOM_APP_KEY", "VALLY_KIWOOM_APP_SECRET"] {
            let mut pairs = MOCK_KEYS.to_vec();
            pairs.push((real_key, "FAKE-REAL-VALUE-must-not-print"));
            let error = start(&pairs).expect_err(real_key).to_string();
            assert!(error.contains(real_key) && !error.contains("FAKE-"), "{error}");
        }
        let mut file_and_process = Config::from_vars(vars(&[("VALLY_KIWOOM_APP_KEY", KEY)]), vars(&MOCK_KEYS), lock, token, key, account);
        assert!(file_and_process.is_err(), "설정 파일의 실전 키도 거절한다");
        file_and_process = Config::from_vars(vars(&[("VALLY_KIWOOM_APP_KEY", "")]), vars(&MOCK_KEYS), lock, token, key, account);
        assert!(file_and_process.is_ok(), "빈 실전 키 변수는 없는 것과 같다");

        let mut with_real_hosts = MOCK_KEYS.to_vec();
        with_real_hosts.extend(REAL);
        let error = start(&with_real_hosts).expect_err("모의 + 실전 주소").to_string();
        assert!(error.contains("mockapi.kiwoom.com") && !error.contains(MOCK_KEY) && !error.contains(MOCK_SECRET), "{error}");
        let mut one_real = MOCK_KEYS.to_vec();
        one_real.extend([MOCK_HOSTS[0], REAL[1]]);
        assert!(start(&one_real).is_err(), "모의 REST + 실전 WS");

        for half in [&MOCK_KEYS[..2], &[MOCK_KEYS[0], MOCK_KEYS[2]][..]] {
            let error = start(half).expect_err("모의 키는 둘 다 적거나 둘 다 비운다").to_string();
            assert!(error.contains("VALLY_KIWOOM_MOCK_APP_KEY") && !error.contains("FAKE-"), "{error}");
        }
        let mut one_url = MOCK_KEYS.to_vec();
        one_url.push(MOCK_HOSTS[0]);
        assert!(start(&one_url).is_err());
    }

    #[test]
    fn real_env_refuses_mock_hosts() {
        let mut pairs = vec![("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET)];
        pairs.extend(MOCK_HOSTS);
        assert!(start(&pairs).is_err(), "실전 + 모의 주소");
        pairs.push(("VALLY_KIWOOM_ENV", "real"));
        assert!(start(&pairs).is_err());
        let ignored = start(&[("VALLY_KIWOOM_MOCK_APP_KEY", MOCK_KEY), ("VALLY_KIWOOM_MOCK_APP_SECRET", MOCK_SECRET)]).unwrap();
        assert!(ignored.kiwoom_credentials.is_none(), "실전에서는 모의 키 변수를 무시한다");
        let half_mock = start(&[("VALLY_KIWOOM_MOCK_APP_KEY", MOCK_KEY)]);
        assert!(half_mock.is_ok(), "실전에서는 모의 키가 반쪽이어도 무시한다");
    }

    #[test]
    fn only_exact_kiwoom_hosts_are_accepted() {
        let loopback = [("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:5"), ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:5/api/dostk/websocket")];
        for environment in ["real", "mock"] {
            for (rest, ws) in [("https://openapi.kiwoom.com", "wss://openapi.kiwoom.com:10000/ws"), ("https://kiwoom.com", "wss://kiwoom.com/ws"), ("https://api.kiwoom.com.evil.test", "wss://api.kiwoom.com.evil.test/ws"), ("https://sub.mockapi.kiwoom.com", "wss://sub.mockapi.kiwoom.com/ws")] {
                let error = start(&[("VALLY_KIWOOM_ENV", environment), ("VALLY_KIWOOM_BASE_URL", rest), ("VALLY_KIWOOM_WS_URL", ws)]).expect_err(rest).to_string();
                assert!(error.contains("VALLY_KIWOOM_BASE_URL"), "{error}");
            }
            let mut pairs = vec![("VALLY_KIWOOM_ENV", environment)];
            pairs.extend(loopback);
            assert!(start(&pairs).is_ok(), "루프백은 {environment}에서 된다");
            pairs.push(("VALLY_CLOCK_START", "20261109100000"));
            assert!(start(&pairs).is_ok(), "시험 시계는 루프백과 {environment}에서 뜬다");
        }
        let mut official_with_clock = MOCK_KEYS.to_vec();
        official_with_clock.extend(MOCK_HOSTS);
        assert!(start(&official_with_clock).is_ok());
        official_with_clock.push(("VALLY_CLOCK_START", "20261109100000"));
        assert!(start(&official_with_clock).is_err(), "시험 시계는 모의 공식 주소와도 뜨지 않는다");
    }

    #[test]
    fn mock_env_refuses_the_account_server() {
        let mut pairs = MOCK_KEYS.to_vec();
        pairs.push(("VALLY_ACCOUNT_SERVER_URL", "https://account.example.com"));
        let error = start(&pairs).expect_err("모의 + 계정 서버").to_string();
        assert!(error.contains("VALLY_ACCOUNT_SERVER_URL"), "{error}");
        pairs.push(("VALLY_ACCOUNT_STATE_PATH", "/x/account.json"));
        assert!(start(&pairs).is_err());
        assert!(start(&[("VALLY_ACCOUNT_SERVER_URL", "https://account.example.com")]).is_ok(), "실전은 그대로다");
        let mut empty = MOCK_KEYS.to_vec();
        empty.push(("VALLY_ACCOUNT_SERVER_URL", ""));
        assert!(start(&empty).is_ok());
    }

    #[test]
    fn an_unknown_kiwoom_environment_stops_the_start() {
        for bad in ["", "Mock", "paper", "demo", "REAL", "mock "] {
            let error = start(&[("VALLY_KIWOOM_ENV", bad)]).expect_err(bad).to_string();
            assert!(error.contains("VALLY_KIWOOM_ENV"), "{error}");
        }
    }

    #[test]
    fn the_mock_keys_and_the_environment_are_known_settings() {
        let (_, warnings) = Config::from_vars(vars(&[]), vars(&MOCK_KEYS), lock, token, key, account).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
    }
}
