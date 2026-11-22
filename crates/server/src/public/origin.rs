
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::Runtime;
use crate::http::ApiFailure;

fn refuse(what: &str) -> Response {
    ApiFailure::bad_request(format!("이 요청은 받지 않습니다: {what}")).into_response()
}

pub(super) async fn check(State(runtime): State<Arc<Runtime>>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).or_else(|| req.uri().authority().map(|a| a.as_str()));
    if !host.is_some_and(|host| runtime.origin.matches_host(host)) {
        return refuse("Host가 이 서버의 주소가 아닙니다");
    }
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let origin = origins.next();
    if origins.next().is_some() || origin.is_some_and(|o| o.to_str().ok() != Some(runtime.origin.origin.as_str())) {
        return refuse("Origin이 이 서버가 아닙니다");
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        if origin.is_none() {
            return refuse("Origin이 없습니다");
        }
        let json = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).and_then(|v| v.split(';').next()).is_some_and(|essence| essence.trim().eq_ignore_ascii_case("application/json"));
        if !json {
            return refuse("Content-Type은 application/json이어야 합니다");
        }
    }
    next.run(req).await
}
