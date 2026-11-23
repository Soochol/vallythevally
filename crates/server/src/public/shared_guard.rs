use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::limits::{MinuteWindow, PerAccount, locked};
use super::settings::Limits;
use super::{Runtime, errors};

const CACHED_BODY_LIMIT: usize = 8 * 1024 * 1024;
const FAILED_CARD_MARK: &[u8] = b"\"failed\"";

struct Cached {
    at: i64,
    content_type: Option<HeaderValue>,
    body: Bytes,
}

impl Cached {
    fn response(&self) -> Response {
        let mut response = (StatusCode::OK, Body::from(self.body.clone())).into_response();
        if let Some(content_type) = &self.content_type {
            response.headers_mut().insert(header::CONTENT_TYPE, content_type.clone());
        }
        response
    }
}

pub(crate) struct SharedGuard {
    status_cache_secs: i64,
    screener_account_per_minute: u32,
    screener_account: PerAccount<MinuteWindow>,
    status_cache: Mutex<Option<Cached>>,
}

impl SharedGuard {
    pub fn new(limits: &Limits) -> Self {
        SharedGuard {
            status_cache_secs: limits.screener_status_cache.as_secs() as i64,
            screener_account_per_minute: limits.screener_account_per_minute,
            screener_account: PerAccount::default(),
            status_cache: Mutex::new(None),
        }
    }

    fn screener_runs(&self, account: &str, now: i64) -> Result<(), i64> {
        self.screener_account.with(account, MinuteWindow::default, |window| window.admit(self.screener_account_per_minute, now))
    }

    fn fresh_status(&self, now: i64) -> Option<Response> {
        locked(&self.status_cache).as_ref().filter(|c| now - c.at < self.status_cache_secs).map(Cached::response)
    }
}

fn scrub_failed_cards(value: &mut serde_json::Value, retry_at: i64) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            let mut scrubbed = false;
            if object.get("status").and_then(|s| s.as_str()) == Some("failed")
                && let Some(serde_json::Value::Object(error)) = object.get_mut("error")
            {
                error.insert("message".into(), errors::KIWOOM_FIXED.into());
                error.insert("manualActionRequired".into(), false.into());
                error.insert("reason".into(), serde_json::Value::Null);
                error.insert("retryAt".into(), retry_at.into());
                scrubbed = true;
            }
            let mut deeper = false;
            for child in object.values_mut() {
                deeper |= scrub_failed_cards(child, retry_at);
            }
            scrubbed || deeper
        }
        serde_json::Value::Array(items) => {
            let mut scrubbed = false;
            for child in items {
                scrubbed |= scrub_failed_cards(child, retry_at);
            }
            scrubbed
        }
        _ => false,
    }
}

async fn with_fixed_card_errors(response: Response, now: i64) -> Response {
    let (mut parts, body) = response.into_parts();
    if parts.status != StatusCode::OK {
        return Response::from_parts(parts, body);
    }
    let Ok(bytes) = axum::body::to_bytes(body, CACHED_BODY_LIMIT).await else { return errors::internal() };
    if bytes.windows(FAILED_CARD_MARK.len()).any(|window| window == FAILED_CARD_MARK)
        && let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes)
        && scrub_failed_cards(&mut value, now + errors::KIWOOM_RETRY_SECS)
        && let Ok(scrubbed) = serde_json::to_vec(&value)
    {
        parts.headers.remove(header::CONTENT_LENGTH);
        return Response::from_parts(parts, Body::from(scrubbed));
    }
    Response::from_parts(parts, Body::from(bytes))
}

pub(super) async fn market_overview(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    let now = runtime.clock.now().unix();
    let response = next.run(request).await;
    with_fixed_card_errors(response, now).await
}

async fn screener_run(runtime: Arc<Runtime>, request: Request, next: Next) -> Response {
    let now = runtime.clock.now().unix();
    let Some(account) = request.extensions().get::<super::Principal>().map(|p| p.key.clone()) else { return errors::signed_out() };
    if let Err(retry_at) = runtime.guard.screener_runs(&account, now) {
        return errors::too_many(now, retry_at);
    }
    next.run(request).await
}

async fn screener_status(runtime: Arc<Runtime>, request: Request, next: Next) -> Response {
    let now = runtime.clock.now().unix();
    if let Some(hit) = runtime.guard.fresh_status(now) {
        runtime.usage.screener_status_cache_hit();
        return hit;
    }
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    if parts.status != StatusCode::OK {
        return Response::from_parts(parts, body);
    }
    let Ok(bytes) = axum::body::to_bytes(body, CACHED_BODY_LIMIT).await else { return errors::internal() };
    *locked(&runtime.guard.status_cache) = Some(Cached { at: now, content_type: parts.headers.get(header::CONTENT_TYPE).cloned(), body: bytes.clone() });
    Response::from_parts(parts, Body::from(bytes))
}

pub(super) async fn screener(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    match (request.method().clone(), request.uri().path()) {
        (Method::POST, "/api/screener/run") => screener_run(runtime, request, next).await,
        (Method::GET, "/api/screener/status") => screener_status(runtime, request, next).await,
        _ => errors::not_found(),
    }
}

pub(super) async fn financial_reads(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let listed = *request.method() == Method::GET && (path == "/api/financial-update" || (path.starts_with("/api/symbols/") && (path.ends_with("/financial-source") || path.ends_with("/financials"))));
    if listed { next.run(request).await } else { errors::not_found() }
}
