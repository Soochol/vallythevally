use crate::config::*;
use crate::secrets::Secret;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

pub struct Settings {
    pub bind: SocketAddr,
    pub database_path: PathBuf,
    pub config: AccountConfig,
}

pub fn parse_env_file(text: &str) -> HashMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| {
            let value = value.trim();
            let unquoted = value
                .strip_prefix('"')
                .and_then(|rest| rest.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|rest| rest.strip_suffix('\'')))
                .unwrap_or(value);
            (key.trim().to_owned(), unquoted.to_owned())
        })
        .collect()
}

impl Settings {
    pub fn from_values(values: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let get = |name: &str| values.get(name).filter(|value| !value.is_empty());
        let required = |name: &str| {
            get(name).cloned().ok_or_else(|| ConfigError(format!("{name}가 필요합니다")))
        };
        let endpoint = |name: &str, default: &str| IdpUrl::parse(get(name).map_or(default, String::as_str));
        let public_url = PublicUrl::parse(&required("VALLY_ACCOUNT_PUBLIC_URL")?)?;
        let bind = get("VALLY_ACCOUNT_BIND")
            .map_or("127.0.0.1:8090", String::as_str)
            .parse()
            .map_err(|_| ConfigError("VALLY_ACCOUNT_BIND를 읽을 수 없습니다".into()))?;
        let database_path = get("VALLY_ACCOUNT_DB_PATH").map_or("data/account.db", String::as_str).into();
        let google = GoogleConfig {
            client_id: required("VALLY_ACCOUNT_GOOGLE_CLIENT_ID")?,
            client_secret: Secret::new(required("VALLY_ACCOUNT_GOOGLE_CLIENT_SECRET")?),
            authorize_url: endpoint("VALLY_ACCOUNT_GOOGLE_AUTHORIZE_URL", GOOGLE_AUTHORIZE_URL)?,
            token_url: endpoint("VALLY_ACCOUNT_GOOGLE_TOKEN_URL", GOOGLE_TOKEN_URL)?,
        };
        let naver = NaverConfig {
            client_id: required("VALLY_ACCOUNT_NAVER_CLIENT_ID")?,
            client_secret: Secret::new(required("VALLY_ACCOUNT_NAVER_CLIENT_SECRET")?),
            authorize_url: endpoint("VALLY_ACCOUNT_NAVER_AUTHORIZE_URL", NAVER_AUTHORIZE_URL)?,
            token_url: endpoint("VALLY_ACCOUNT_NAVER_TOKEN_URL", NAVER_TOKEN_URL)?,
            profile_url: endpoint("VALLY_ACCOUNT_NAVER_PROFILE_URL", NAVER_PROFILE_URL)?,
        };
        Ok(Self { bind, database_path, config: AccountConfig { public_url, google, naver } })
    }
}
