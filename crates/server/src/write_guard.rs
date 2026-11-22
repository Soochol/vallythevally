use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, Uri, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::http::{ApiFailure, AppState};

pub(crate) async fn guard_writes(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && let Err(rejected) = check_write(&st, &req)
    {
        tracing::warn!(method = %req.method(), path = req.uri().path(), "쓰기 요청을 거절했습니다");
        return rejected.into_response();
    }
    next.run(req).await
}

fn refuse(what: &str) -> ApiFailure {
    ApiFailure::bad_request(format!("이 요청은 받지 않습니다: {what}"))
}

pub(crate) fn check_host<'a>(st: &AppState, headers: &'a HeaderMap, uri: &'a Uri) -> Result<&'a str, ApiFailure> {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).or_else(|| uri.authority().map(|a| a.as_str())).ok_or_else(|| refuse("Host가 없습니다"))?;
    let bound = st.system.bound_addr().ok_or_else(|| refuse("서버가 아직 준비되지 않았습니다"))?;
    if !is_own_host(host, bound) && !st.system.tailnet_hosts().contains(host) {
        return Err(refuse("Host가 이 서버의 주소가 아닙니다"));
    }
    Ok(host)
}

pub(crate) async fn guard_origin(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if let Err(rejected) = check_request_origin(&st, &req) {
        tracing::warn!(method = %req.method(), path = req.uri().path(), "출처가 맞지 않는 요청을 거절했습니다");
        return rejected.into_response();
    }
    next.run(req).await
}

fn check_request_origin(st: &AppState, req: &Request) -> Result<(), ApiFailure> {
    let headers = req.headers();
    let host = check_host(st, headers, req.uri())?;
    check_origin(st, headers, host)?;
    let cross_site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()).is_some_and(|site| site.eq_ignore_ascii_case("cross-site") || site.eq_ignore_ascii_case("same-site"));
    if cross_site && (req.uri().path() == "/api" || req.uri().path().starts_with("/api/")) {
        return Err(refuse("다른 사이트에서 온 요청입니다"));
    }
    Ok(())
}

fn check_write(st: &AppState, req: &Request) -> Result<(), ApiFailure> {
    let headers = req.headers();
    let host = check_host(st, headers, req.uri())?;
    check_origin(st, headers, host)?;
    let json = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(';').next().is_some_and(|essence| essence.trim().eq_ignore_ascii_case("application/json")));
    if !json {
        return Err(refuse("Content-Type은 application/json이어야 합니다"));
    }
    Ok(())
}

fn is_own_host(host: &str, bound: std::net::SocketAddr) -> bool {
    let (host, port) = (host.to_ascii_lowercase(), bound.port());
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}"), bound.to_string()].contains(&host)
}

pub(crate) fn check_origin(st: &AppState, headers: &HeaderMap, host: &str) -> Result<(), ApiFailure> {
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let Some(origin) = origins.next() else { return Ok(()) };
    let scheme = if st.system.tailnet_hosts().contains(host) { "https" } else { "http" };
    let same = origins.next().is_none() && origin.to_str().is_ok_and(|o| o.eq_ignore_ascii_case(&format!("{scheme}://{host}")));
    if same { Ok(()) } else { Err(ApiFailure::bad_request("이 요청은 받지 않습니다: Origin이 이 서버가 아닙니다")) }
}
