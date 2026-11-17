use std::fmt;
use std::time::Duration;

use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::json;

use super::AccountServerUrl;
use crate::api::AccountProvider;
use crate::config::Secret;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientError {
    Unreachable,
    Rejected(u16),
    Malformed,
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Unreachable => f.write_str("계정 서버에 닿지 못했습니다"),
            ClientError::Rejected(status) => write!(f, "계정 서버가 요청을 거절했습니다({status})"),
            ClientError::Malformed => f.write_str("계정 서버의 응답을 읽지 못했습니다"),
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
struct MeResponse {
    id: String,
    provider: AccountProvider,
}

pub struct Exchanged {
    pub token: Secret<String>,
}

pub struct AccountClient {
    http: reqwest::Client,
    origin: String,
}

impl AccountClient {
    pub fn new(url: &AccountServerUrl) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).timeout(REQUEST_TIMEOUT).redirect(reqwest::redirect::Policy::none()).build()?;
        Ok(AccountClient { http, origin: url.as_str().to_owned() })
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Vec<u8>, ClientError> {
        let response = request.send().await.map_err(|_| ClientError::Unreachable)?;
        let status = response.status();
        if !status.is_success() {
            return Err(ClientError::Rejected(status.as_u16()));
        }
        response.bytes().await.map(|bytes| bytes.to_vec()).map_err(|_| ClientError::Unreachable)
    }

    pub async fn exchange(&self, code: &str, verifier: &Secret<String>) -> Result<Exchanged, ClientError> {
        let body = json!({"code": code, "codeVerifier": verifier.expose()}).to_string();
        let bytes = self.send(self.http.post(format!("{}/v1/auth/token", self.origin)).header(CONTENT_TYPE, "application/json").body(body)).await?;
        let response: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| ClientError::Malformed)?;
        Ok(Exchanged { token: Secret::new(response.token) })
    }

    pub async fn me(&self, token: &Secret<String>) -> Result<(String, AccountProvider), ClientError> {
        let bytes = self.send(self.http.get(format!("{}/v1/me", self.origin)).bearer_auth(token.expose())).await?;
        let me: MeResponse = serde_json::from_slice(&bytes).map_err(|_| ClientError::Malformed)?;
        Ok((me.id, me.provider))
    }

    pub async fn revoke(&self, token: &Secret<String>) -> Result<(), ClientError> {
        self.send(self.http.delete(format!("{}/v1/auth/token", self.origin)).bearer_auth(token.expose())).await.map(drop)
    }

    pub async fn delete_account(&self, token: &Secret<String>) -> Result<(), ClientError> {
        self.send(self.http.delete(format!("{}/v1/account", self.origin)).bearer_auth(token.expose())).await.map(drop)
    }
}
