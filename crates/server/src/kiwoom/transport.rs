//! HTTP 한 번 보내기. 대기열(`rest`)은 이 trait만 안다. 테스트는 가짜 전송을 쓴다.

use std::time::Duration;

use futures::future::BoxFuture;

use super::api::ApiId;
use super::rest::ContKey;
use crate::config::Secret;

/// Debug를 두지 않는다. au10001 본문에는 앱키와 시크릿이 들어 있다.
pub struct HttpRequest {
    pub api_id: ApiId,
    pub token: Option<Secret<String>>,
    pub cont: Option<ContKey>,
    pub body: Secret<String>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    /// 응답 헤더 `cont-yn: Y`일 때의 `next-key`. 아니면 None.
    pub next_key: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Connect,
    AwaitResponse,
    ReadBody,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportError {
    pub stage: Stage,
    pub timed_out: bool,
}

pub const SEND_TIMEOUT: Duration = Duration::from_secs(15);

impl TransportError {
    pub fn refused() -> Self {
        TransportError { stage: Stage::Connect, timed_out: false }
    }

    fn of(stage: Stage, e: &reqwest::Error) -> Self {
        let stage = if e.is_connect() { Stage::Connect } else { stage };
        TransportError { stage, timed_out: e.is_timeout() }
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let stage = match self.stage {
            Stage::Connect => "연결",
            Stage::AwaitResponse => "응답 대기",
            Stage::ReadBody => "본문 수신",
        };
        if self.timed_out {
            write!(f, "{stage} 단계에서 {}초 시간 초과", SEND_TIMEOUT.as_secs())
        } else {
            write!(f, "{stage} 단계에서 실패")
        }
    }
}

pub trait Transport: Send + Sync + 'static {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>>;
}

pub struct ReqwestTransport {
    client: reqwest::Client,
    base_url: String,
}

impl ReqwestTransport {
    pub fn new(base_url: String) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder().timeout(SEND_TIMEOUT).build().map_err(reqwest::Error::without_url)?;
        Ok(ReqwestTransport { client, base_url })
    }
}

impl Transport for ReqwestTransport {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let mut builder = self
            .client
            .post(format!("{}{}", self.base_url, req.api_id.path()))
            .header("api-id", req.api_id.as_str())
            .header("content-type", "application/json;charset=UTF-8")
            .body(req.body.expose().clone());
        if let Some(token) = &req.token {
            builder = builder.header("authorization", format!("Bearer {}", token.expose()));
        }
        if let Some(cont) = &req.cont {
            builder = builder.header("cont-yn", "Y").header("next-key", cont.as_str());
        }
        Box::pin(async move {
            let resp = builder.send().await.map_err(|e| TransportError::of(Stage::AwaitResponse, &e))?;
            let status = resp.status().as_u16();
            let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
            let next_key = (header("cont-yn") == "Y").then(|| header("next-key")).filter(|k| !k.is_empty());
            let body = resp.text().await.map_err(|e| TransportError::of(Stage::ReadBody, &e))?;
            Ok(HttpResponse { status, next_key, body })
        })
    }
}
