use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use server::config::Secret;

pub const APP_KEY_VARIABLE: &str = "VALLY_COLLECTOR_APP_KEY";
pub const APP_SECRET_VARIABLE: &str = "VALLY_COLLECTOR_APP_SECRET";
pub const TOKEN_PATH_VARIABLE: &str = "VALLY_COLLECTOR_TOKEN_PATH";
pub const LOCK_PATH_VARIABLE: &str = "VALLY_COLLECTOR_LOCK_PATH";
pub const ENV_FILE_VARIABLE: &str = "VALLY_COLLECTOR_ENV_FILE";
const APP_SERVER_ENV_FILE_VARIABLE: &str = "VALLY_ENV_FILE";
const APP_SERVER_KEY_VARIABLE: &str = "VALLY_KIWOOM_APP_KEY";

const STATE_FOLDER: &str = "vallythevally/collector";
pub(crate) const TOKEN_FILE_NAME: &str = "token.json";
pub(crate) const LOCK_FILE_NAME: &str = "collector.lock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone)]
pub struct CollectorConfig {
    pub app_key: Secret<String>,
    pub app_secret: Secret<String>,
    pub token_path: PathBuf,
    pub lock_path: PathBuf,
}

pub type Variables = BTreeMap<String, String>;

pub fn process_variables() -> Variables {
    std::env::vars()
        .filter(|(name, _)| name.starts_with("VALLY_") || name == "XDG_STATE_HOME" || name == "HOME")
        .collect()
}

impl CollectorConfig {
    pub fn load(process: &Variables) -> Result<CollectorConfig, ConfigError> {
        let mut variables = match process.get(ENV_FILE_VARIABLE).filter(|path| !path.is_empty()) {
            Some(path) => read_env_file(ENV_FILE_VARIABLE, Path::new(path))?,
            None => Variables::new(),
        };
        variables.extend(process.iter().map(|(name, value)| (name.clone(), value.clone())));
        let present = |name: &str| variables.get(name).filter(|value| !value.is_empty()).cloned();
        let (Some(app_key), Some(app_secret)) = (present(APP_KEY_VARIABLE), present(APP_SECRET_VARIABLE)) else {
            let missing: Vec<&str> = [APP_KEY_VARIABLE, APP_SECRET_VARIABLE]
                .into_iter()
                .filter(|name| present(name).is_none())
                .collect();
            return Err(ConfigError(format!("{}가 없습니다", missing.join(", "))));
        };
        reject_app_server_key(process, &app_key)?;
        let token_path = match present(TOKEN_PATH_VARIABLE) {
            Some(path) => PathBuf::from(path),
            None => default_state_folder(&variables)?.join(TOKEN_FILE_NAME),
        };
        let lock_path = match present(LOCK_PATH_VARIABLE) {
            Some(path) => PathBuf::from(path),
            None => token_path.with_file_name(LOCK_FILE_NAME),
        };
        Ok(CollectorConfig {
            app_key: Secret::new(app_key),
            app_secret: Secret::new(app_secret),
            token_path,
            lock_path,
        })
    }
}

pub(crate) fn default_state_folder(variables: &Variables) -> Result<PathBuf, ConfigError> {
    let nonempty = |name: &str| variables.get(name).filter(|value| !value.is_empty()).map(PathBuf::from);
    let state_home = match (nonempty("XDG_STATE_HOME"), nonempty("HOME")) {
        (Some(state_home), _) => state_home,
        (None, Some(home)) => home.join(".local/state"),
        (None, None) => {
            return Err(ConfigError(format!(
                "XDG_STATE_HOME도 HOME도 없어 토큰 파일 경로를 정할 수 없습니다. {TOKEN_PATH_VARIABLE}를 주세요"
            )));
        }
    };
    Ok(state_home.join(STATE_FOLDER))
}

pub(crate) fn reject_app_server_key(process: &Variables, collector_key: &str) -> Result<(), ConfigError> {
    let mut app_server = match process.get(APP_SERVER_ENV_FILE_VARIABLE).filter(|path| !path.is_empty()) {
        Some(path) => read_env_file(APP_SERVER_ENV_FILE_VARIABLE, Path::new(path))?,
        None => Variables::new(),
    };
    app_server.extend(process.iter().map(|(name, value)| (name.clone(), value.clone())));
    if app_server.get(APP_SERVER_KEY_VARIABLE).is_some_and(|key| key == collector_key) {
        return Err(ConfigError(format!(
            "{APP_KEY_VARIABLE}가 앱 서버의 {APP_SERVER_KEY_VARIABLE}와 같습니다. 같은 키를 두 곳에서 쓰면 서로 연결을 끊습니다. 수집기 전용 키를 쓰세요"
        )));
    }
    Ok(())
}

pub(crate) fn read_env_file(variable: &str, path: &Path) -> Result<Variables, ConfigError> {
    if !path.is_absolute() {
        return Err(ConfigError(format!("{variable}은 절대 경로여야 합니다: {}", path.display())));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|error| ConfigError(format!("설정 파일을 읽을 수 없습니다({}): {error}", path.display())))?;
    parse_env(&text)
}

fn parse_env(text: &str) -> Result<Variables, ConfigError> {
    let mut variables = Variables::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else {
            return Err(ConfigError(format!("설정 파일 {}번째 줄에 '='가 없습니다", index + 1)));
        };
        let value = value.trim();
        let value = [('"', '"'), ('\'', '\'')]
            .iter()
            .find_map(|&(open, close)| value.strip_prefix(open).and_then(|rest| rest.strip_suffix(close)))
            .unwrap_or_else(|| value.split_once(" #").map_or(value, |(before, _)| before.trim_end()));
        variables.insert(name.trim().to_owned(), value.to_owned());
    }
    Ok(variables)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "FAKE-COLLECTOR-KEY-1111";
    const SECRET: &str = "FAKE-COLLECTOR-SECRET-2222";

    fn variables(pairs: &[(&str, &str)]) -> Variables {
        pairs.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect()
    }

    fn credentials() -> Vec<(&'static str, &'static str)> {
        vec![(APP_KEY_VARIABLE, KEY), (APP_SECRET_VARIABLE, SECRET), ("HOME", "/home/someone")]
    }

    fn env_file(contents: &str) -> (tempfile::TempDir, String) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("collector.env");
        std::fs::write(&path, contents).unwrap();
        let text = path.to_str().unwrap().to_owned();
        (folder, text)
    }

    #[test]
    fn missing_key_names_the_variable() {
        let message = CollectorConfig::load(&variables(&[("HOME", "/h"), (APP_SECRET_VARIABLE, SECRET)])).unwrap_err().to_string();
        assert!(message.contains("VALLY_COLLECTOR_APP_KEY"), "{message}");
        assert!(!message.contains("VALLY_COLLECTOR_APP_SECRET"), "{message}");
        let message = CollectorConfig::load(&variables(&[("HOME", "/h")])).unwrap_err().to_string();
        assert!(message.contains("VALLY_COLLECTOR_APP_KEY") && message.contains("VALLY_COLLECTOR_APP_SECRET"), "{message}");
    }

    #[test]
    fn empty_values_count_as_missing() {
        let message = CollectorConfig::load(&variables(&[(APP_KEY_VARIABLE, ""), (APP_SECRET_VARIABLE, SECRET)])).unwrap_err().to_string();
        assert!(message.contains("VALLY_COLLECTOR_APP_KEY"), "{message}");
    }

    #[test]
    fn default_paths_sit_under_the_collector_state_folder() {
        let config = CollectorConfig::load(&variables(&credentials())).unwrap();
        assert_eq!(config.token_path, PathBuf::from("/home/someone/.local/state/vallythevally/collector/token.json"));
        assert_eq!(config.lock_path, PathBuf::from("/home/someone/.local/state/vallythevally/collector/collector.lock"));
        let mut with_state_home = credentials();
        with_state_home.push(("XDG_STATE_HOME", "/state"));
        let config = CollectorConfig::load(&variables(&with_state_home)).unwrap();
        assert_eq!(config.token_path, PathBuf::from("/state/vallythevally/collector/token.json"));
        assert_eq!(config.lock_path, PathBuf::from("/state/vallythevally/collector/collector.lock"));
    }

    #[test]
    fn default_lock_follows_a_custom_token_folder() {
        let mut pairs = credentials();
        pairs.push((TOKEN_PATH_VARIABLE, "/elsewhere/t.json"));
        let config = CollectorConfig::load(&variables(&pairs)).unwrap();
        assert_eq!(config.lock_path, PathBuf::from("/elsewhere/collector.lock"));
        pairs.push((LOCK_PATH_VARIABLE, "/locks/c.lock"));
        assert_eq!(CollectorConfig::load(&variables(&pairs)).unwrap().lock_path, PathBuf::from("/locks/c.lock"));
    }

    #[test]
    fn no_state_location_is_an_error_naming_the_override() {
        let message = CollectorConfig::load(&variables(&[(APP_KEY_VARIABLE, KEY), (APP_SECRET_VARIABLE, SECRET)])).unwrap_err().to_string();
        assert!(message.contains(TOKEN_PATH_VARIABLE), "{message}");
    }

    #[test]
    fn process_values_override_the_env_file() {
        let (_folder, path) = env_file(&format!("export {APP_KEY_VARIABLE}=\"from-file\"\n{APP_SECRET_VARIABLE}='{SECRET}'\n# memo\n"));
        let config = CollectorConfig::load(&variables(&[(ENV_FILE_VARIABLE, &path), (APP_KEY_VARIABLE, KEY), ("HOME", "/h")])).unwrap();
        assert_eq!(config.app_key.expose(), KEY);
        assert_eq!(config.app_secret.expose(), SECRET);
    }

    #[test]
    fn env_file_must_be_absolute_and_readable() {
        let message = CollectorConfig::load(&variables(&[(ENV_FILE_VARIABLE, "relative.env")])).unwrap_err().to_string();
        assert!(message.contains("절대 경로"), "{message}");
        let message = CollectorConfig::load(&variables(&[(ENV_FILE_VARIABLE, "/nonexistent/collector.env")])).unwrap_err().to_string();
        assert!(message.contains("읽을 수 없습니다"), "{message}");
    }

    #[test]
    fn the_app_server_key_in_the_process_environment_is_refused() {
        let mut pairs = credentials();
        pairs.push((APP_SERVER_KEY_VARIABLE, KEY));
        let message = CollectorConfig::load(&variables(&pairs)).unwrap_err().to_string();
        assert!(message.contains("앱 서버") && message.contains("서로 연결을 끊습니다"), "{message}");
        assert!(!message.contains(KEY), "{message}");
    }

    #[test]
    fn the_app_server_key_in_its_env_file_is_refused() {
        let (_folder, path) = env_file(&format!("{APP_SERVER_KEY_VARIABLE}={KEY}\n"));
        let mut pairs = credentials();
        pairs.push((APP_SERVER_ENV_FILE_VARIABLE, &path));
        assert!(CollectorConfig::load(&variables(&pairs)).unwrap_err().to_string().contains("앱 서버"));
    }

    #[test]
    fn a_different_app_server_key_is_fine() {
        let mut pairs = credentials();
        pairs.push((APP_SERVER_KEY_VARIABLE, "another-key"));
        assert!(CollectorConfig::load(&variables(&pairs)).is_ok());
    }

    #[test]
    fn debug_output_hides_the_key_and_the_secret() {
        let config = CollectorConfig::load(&variables(&credentials())).unwrap();
        let debug = format!("{config:?}");
        assert!(!debug.contains(KEY) && !debug.contains(SECRET), "{debug}");
    }
}
