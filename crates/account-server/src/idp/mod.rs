mod google;
mod naver;

use crate::clock::UnixSeconds;
use crate::config::{AccountConfig, GoogleConfig, NaverConfig, PublicUrl};
use crate::model::Provider;
use std::time::Duration;
use url::Url;

#[derive(Debug)]
pub struct IdpFailure(pub &'static str);

pub struct IdpClient {
    http: reqwest::Client,
    public_url: PublicUrl,
    google: GoogleConfig,
    naver: NaverConfig,
}

pub struct AuthorizeParams<'a> {
    pub state: &'a str,
    pub nonce: &'a str,
}

pub struct CodeGrant<'a> {
    pub code: &'a str,
    pub state: &'a str,
    pub nonce: &'a str,
    pub now: UnixSeconds,
}

impl IdpClient {
    pub fn new(config: &AccountConfig) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .expect("HTTP 클라이언트를 만들지 못했다");
        Self {
            http,
            public_url: config.public_url.clone(),
            google: config.google.clone(),
            naver: config.naver.clone(),
        }
    }

    pub fn authorize_url(&self, provider: Provider, params: AuthorizeParams<'_>) -> Url {
        let redirect_uri = self.public_url.callback_url(provider.as_str());
        match provider {
            Provider::Google => google::authorize_url(&self.google, &redirect_uri, params),
            Provider::Naver => naver::authorize_url(&self.naver, &redirect_uri, params),
        }
    }

    pub async fn subject(&self, provider: Provider, grant: CodeGrant<'_>) -> Result<String, IdpFailure> {
        let redirect_uri = self.public_url.callback_url(provider.as_str());
        let subject = match provider {
            Provider::Google => google::subject(&self.http, &self.google, &redirect_uri, grant).await?,
            Provider::Naver => naver::subject(&self.http, &self.naver, &redirect_uri, grant).await?,
        };
        if subject.is_empty() || subject.len() > 255 {
            return Err(IdpFailure("subject 형식이 맞지 않는다"));
        }
        Ok(subject)
    }
}

fn transport_failure(error: reqwest::Error) -> IdpFailure {
    tracing::warn!(timeout = error.is_timeout(), connect = error.is_connect(), "IdP 요청 실패");
    IdpFailure("IdP에 닿지 못했다")
}
