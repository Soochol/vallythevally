use futures::future::BoxFuture;

pub use crate::kiwoom::transport::{SEND_TIMEOUT, Stage, TransportError};

use crate::config::Secret;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

pub struct HttpRequest {
    pub method: Method,
    pub path: &'static str,
    pub headers: Vec<(&'static str, Secret<String>)>,
    pub query: Vec<(&'static str, String)>,
    pub body: Option<Secret<String>>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| *n == name).map(|(_, v)| v.expose().as_str())
    }
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub tr_cont: Option<String>,
    pub body: String,
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
        let client = reqwest::Client::builder().tls_backend_rustls().timeout(SEND_TIMEOUT).build().map_err(reqwest::Error::without_url)?;
        Ok(ReqwestTransport { client, base_url })
    }
}

impl Transport for ReqwestTransport {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let url = format!("{}{}", self.base_url, req.path);
        let mut builder = match req.method {
            Method::Get => self.client.get(url).query(&req.query),
            Method::Post => self.client.post(url),
        };
        builder = builder.header("content-type", "application/json; charset=utf-8");
        for (name, value) in &req.headers {
            builder = builder.header(*name, value.expose().as_str());
        }
        if let Some(body) = &req.body {
            builder = builder.body(body.expose().clone());
        }
        Box::pin(async move {
            let response = builder.send().await.map_err(|e| transport_error(Stage::AwaitResponse, &e))?;
            let status = response.status().as_u16();
            let tr_cont = response.headers().get("tr_cont").and_then(|v| v.to_str().ok()).map(str::to_owned);
            let body = response.text().await.map_err(|e| transport_error(Stage::ReadBody, &e))?;
            Ok(HttpResponse { status, tr_cont, body })
        })
    }
}

fn transport_error(stage: Stage, e: &reqwest::Error) -> TransportError {
    let stage = if e.is_connect() { Stage::Connect } else { stage };
    TransportError { stage, timed_out: e.is_timeout() }
}
