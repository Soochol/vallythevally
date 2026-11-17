use crate::secrets::Secret;
use std::fmt;
use url::{Host, Url};

#[derive(Debug)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn is_loopback_ip(url: &Url) -> bool {
    matches!(url.host(), Some(Host::Ipv4(address)) if address.is_loopback())
}

fn has_userinfo(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

#[derive(Clone, Debug)]
pub struct PublicUrl(Url);

impl PublicUrl {
    pub fn parse(value: &str) -> Result<Self, ConfigError> {
        let url = Url::parse(value).map_err(|_| ConfigError("공개 주소를 읽을 수 없습니다".into()))?;
        let allowed = url.scheme() == "https" || (url.scheme() == "http" && is_loopback_ip(&url));
        if !allowed || url.host().is_none() {
            return Err(ConfigError("공개 주소는 https이거나 루프백 IP의 http여야 합니다".into()));
        }
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() || has_userinfo(&url) {
            return Err(ConfigError("공개 주소는 경로와 질의 없이 출처만 적습니다".into()));
        }
        Ok(Self(url))
    }

    pub fn is_secure(&self) -> bool {
        self.0.scheme() == "https"
    }

    pub fn callback_url(&self, provider: &str) -> String {
        let origin = self.0.as_str().trim_end_matches('/');
        format!("{origin}/v1/auth/{provider}/callback")
    }
}

#[derive(Clone, Debug)]
pub struct IdpUrl(Url);

impl IdpUrl {
    pub fn parse(value: &str) -> Result<Self, ConfigError> {
        let url = Url::parse(value).map_err(|_| ConfigError(format!("IdP 주소를 읽을 수 없습니다: {value}")))?;
        let allowed = url.scheme() == "https" || (url.scheme() == "http" && is_loopback_ip(&url));
        if !allowed || has_userinfo(&url) {
            return Err(ConfigError(format!("IdP 주소는 https이거나 루프백 IP의 http여야 합니다: {value}")));
        }
        Ok(Self(url))
    }

    pub fn url(&self) -> &Url {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: Secret,
    pub authorize_url: IdpUrl,
    pub token_url: IdpUrl,
}

#[derive(Clone, Debug)]
pub struct NaverConfig {
    pub client_id: String,
    pub client_secret: Secret,
    pub authorize_url: IdpUrl,
    pub token_url: IdpUrl,
    pub profile_url: IdpUrl,
}

#[derive(Clone, Debug)]
pub struct AccountConfig {
    pub public_url: PublicUrl,
    pub google: GoogleConfig,
    pub naver: NaverConfig,
}

pub const DEFAULT_PENDING_LOGIN_LIMIT: u32 = 10_000;
pub const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const NAVER_AUTHORIZE_URL: &str = "https://nid.naver.com/oauth2.0/authorize";
pub const NAVER_TOKEN_URL: &str = "https://nid.naver.com/oauth2.0/token";
pub const NAVER_PROFILE_URL: &str = "https://openapi.naver.com/v1/nid/me";
