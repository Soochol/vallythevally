//! 설정(backend.md §11). `VALLY_ENV_FILE`이 가리키는 파일을 읽고, 프로세스 환경변수가 그 값을 덮는다.

use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// 받는 주소. 루프백만 받는다(ADR 0001).
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

pub const DEFAULT_KIWOOM_BASE_URL: &str = "https://api.kiwoom.com";

const KNOWN_KEYS: &[&str] = &[
    "VALLY_ENV_FILE",
    "VALLY_KIWOOM_APP_KEY",
    "VALLY_KIWOOM_APP_SECRET",
    "VALLY_KIWOOM_BASE_URL",
    "VALLY_DB_PATH",
    "VALLY_LOCK_PATH",
    "VALLY_TOKEN_PATH",
    "VALLY_BIND",
    "VALLY_TELEGRAM_BOT_TOKEN",
    "VALLY_TELEGRAM_CHAT_ID",
    "VALLY_STATIC_DIR",
    "VALLY_LOG",
];

#[derive(Debug, Clone)]
pub struct Config {
    pub kiwoom_app_key: Secret<String>,
    pub kiwoom_app_secret: Secret<String>,
    /// 테스트가 가짜 키움 서버를 가리키게 하려고 둔 키. 기본은 실제 키움 주소다.
    pub kiwoom_base_url: String,
    pub lock_path: PathBuf,
    pub token_path: PathBuf,
    pub bind: BindAddr,
    pub static_dir: PathBuf,
    /// 사용자 자료 SQLite 파일(§7.1). 상대 경로면 서버 작업 디렉터리 기준.
    pub db_path: PathBuf,
    pub log_filter: String,
}

/// 설정을 읽으며 모은 경고. 로그를 켜기 전에 읽으므로 호출자가 나중에 남긴다.
pub type ConfigWarnings = Vec<String>;

impl Config {
    pub fn from_env() -> Result<(Config, ConfigWarnings), ConfigError> {
        let process: BTreeMap<String, String> = std::env::vars().filter(|(k, _)| k.starts_with("VALLY_")).collect();
        let file = match process.get("VALLY_ENV_FILE") {
            Some(path) => read_env_file(Path::new(path))?,
            None => BTreeMap::new(),
        };
        Config::from_vars(file, process, default_lock_path, default_token_path)
    }

    /// 파일 값 위에 프로세스 값을 덮어 설정을 만든다.
    fn from_vars(
        file: BTreeMap<String, String>,
        process: BTreeMap<String, String>,
        default_lock: impl FnOnce() -> Result<PathBuf, ConfigError>,
        default_token: impl FnOnce() -> Result<PathBuf, ConfigError>,
    ) -> Result<(Config, ConfigWarnings), ConfigError> {
        let mut vars = file;
        vars.extend(process);
        let warnings = vars
            .keys()
            .filter(|k| k.starts_with("VALLY_") && !KNOWN_KEYS.contains(&k.as_str()))
            .map(|k| format!("모르는 설정 키 {k}가 있습니다. 오타인지 확인하세요"))
            .collect();
        let required = |k: &str| {
            vars.get(k)
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or_else(|| ConfigError(format!("{k}가 없습니다")))
        };
        let config = Config {
            kiwoom_app_key: Secret::new(required("VALLY_KIWOOM_APP_KEY")?),
            kiwoom_app_secret: Secret::new(required("VALLY_KIWOOM_APP_SECRET")?),
            kiwoom_base_url: vars
                .get("VALLY_KIWOOM_BASE_URL")
                .map(|s| s.trim_end_matches('/').to_owned())
                .unwrap_or_else(|| DEFAULT_KIWOOM_BASE_URL.to_owned()),
            lock_path: match vars.get("VALLY_LOCK_PATH") {
                Some(p) => PathBuf::from(p),
                None => default_lock()?,
            },
            token_path: match vars.get("VALLY_TOKEN_PATH") {
                Some(p) => PathBuf::from(p),
                None => default_token()?,
            },
            bind: BindAddr::parse(vars.get("VALLY_BIND").map_or("127.0.0.1:8080", String::as_str))?,
            static_dir: PathBuf::from(vars.get("VALLY_STATIC_DIR").map_or("web/dist", String::as_str)),
            db_path: PathBuf::from(vars.get("VALLY_DB_PATH").map_or("data/vally.db", String::as_str)),
            log_filter: vars.get("VALLY_LOG").cloned().unwrap_or_else(|| "info".to_owned()),
        };
        Ok((config, warnings))
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

/// `$XDG_STATE_HOME/vallythevally/token.json`, 없으면 `$HOME/.local/state/vallythevally/token.json`(§4.1).
fn default_token_path() -> Result<PathBuf, ConfigError> {
    token_path_from(std::env::var_os("XDG_STATE_HOME"), std::env::var_os("HOME"))
}

fn token_path_from(state_home: Option<std::ffi::OsString>, home: Option<std::ffi::OsString>) -> Result<PathBuf, ConfigError> {
    let nonempty = |v: Option<std::ffi::OsString>| v.filter(|d| !d.is_empty()).map(PathBuf::from);
    let state = match (nonempty(state_home), nonempty(home)) {
        (Some(state), _) => state,
        (None, Some(home)) => home.join(".local/state"),
        (None, None) => return Err(ConfigError("XDG_STATE_HOME도 HOME도 없어 토큰 파일 경로를 정할 수 없습니다. VALLY_TOKEN_PATH를 주세요".into())),
    };
    Ok(state.join("vallythevally").join("token.json"))
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

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn lock() -> Result<PathBuf, ConfigError> {
        Ok(PathBuf::from("/nonexistent/test.lock"))
    }

    fn token() -> Result<PathBuf, ConfigError> {
        Ok(PathBuf::from("/nonexistent/token.json"))
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
            BTreeMap::new(),
            lock,
            token,
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
            vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:5/")]),
            lock,
            token,
        )
        .unwrap();
        assert!(warnings.is_empty());
        assert_eq!(c.kiwoom_app_key.expose(), KEY);
        assert_eq!(c.kiwoom_base_url, "http://127.0.0.1:5");
        assert_eq!(c.bind.socket_addr().port(), 9);
        assert_eq!(c.static_dir, PathBuf::from("web/dist"));
        assert_eq!(c.db_path, PathBuf::from("data/vally.db"));
        assert_eq!(c.log_filter, "info");
        assert_eq!(c.lock_path, PathBuf::from("/nonexistent/test.lock"));
        assert_eq!(c.token_path, PathBuf::from("/nonexistent/token.json"));

        let (c, _) = Config::from_vars(vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET)]), BTreeMap::new(), lock, token).unwrap();
        assert_eq!(c.kiwoom_base_url, DEFAULT_KIWOOM_BASE_URL);
        assert_eq!(c.bind.socket_addr(), "127.0.0.1:8080".parse().unwrap());
    }

    #[test]
    fn missing_keys_fail_and_unknown_keys_warn() {
        assert!(Config::from_vars(vars(&[("VALLY_KIWOOM_APP_KEY", KEY)]), BTreeMap::new(), lock, token).is_err());
        assert!(Config::from_vars(vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", "")]), BTreeMap::new(), lock, token).is_err());
        let (_, warnings) = Config::from_vars(
            vars(&[("VALLY_KIWOOM_APP_KEY", KEY), ("VALLY_KIWOOM_APP_SECRET", SECRET), ("VALLY_BIDN", "x")]),
            BTreeMap::new(),
            lock,
            token,
        )
        .unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("VALLY_BIDN"));
    }

    #[test]
    fn token_path_follows_xdg_state_home_then_home() {
        let os = |s: &str| Some(std::ffi::OsString::from(s));
        assert_eq!(token_path_from(os("/s"), os("/h")).unwrap(), PathBuf::from("/s/vallythevally/token.json"));
        assert_eq!(token_path_from(os(""), os("/h")).unwrap(), PathBuf::from("/h/.local/state/vallythevally/token.json"));
        assert!(token_path_from(None, None).is_err());
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
}
