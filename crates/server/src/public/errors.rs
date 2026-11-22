//! 공개 오류 응답. 키움 원문을 싣지 않고, 429·503에는 `retryAt`과 `Retry-After`를 맞춰 싣는다.

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};

use crate::api::{self, ApiErrorBody, ApiErrorCode, ApiErrorReason, UnixSeconds};

pub(super) const KIWOOM_RETRY_SECS: i64 = 5;
const SHAPED_BODY_LIMIT: usize = 64 * 1024;

pub(super) const TOO_MANY: &str = "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요";
pub(super) const BUSY: &str = "서버가 지금 바쁩니다. 잠시 뒤 다시 시도하세요";
pub(super) const KIWOOM_FIXED: &str = "시세를 지금 받지 못합니다. 잠시 뒤 다시 시도하세요";
const TOO_LARGE: &str = "요청 본문이 너무 큽니다";

fn body(code: ApiErrorCode, message: &str, reason: Option<ApiErrorReason>, retry_at: Option<i64>) -> api::ApiError {
    api::ApiError { error: ApiErrorBody { code, message: message.to_owned(), reason, retry_at: retry_at.map(UnixSeconds), manual_action_required: false } }
}

pub(super) fn retry_after(status: StatusCode, message: &str, now: i64, retry_at: i64) -> Response {
    let reason = (status == StatusCode::TOO_MANY_REQUESTS).then_some(ApiErrorReason::RateLimited);
    let mut response = (status, Json(body(ApiErrorCode::KiwoomUnavailable, message, reason, Some(retry_at)))).into_response();
    let wait = (retry_at - now).max(1);
    if let Ok(value) = HeaderValue::from_str(&wait.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

pub(super) fn too_many(now: i64, retry_at: i64) -> Response {
    retry_after(StatusCode::TOO_MANY_REQUESTS, TOO_MANY, now, retry_at)
}

pub(super) fn busy(now: i64, retry_in: i64) -> Response {
    retry_after(StatusCode::SERVICE_UNAVAILABLE, BUSY, now, now + retry_in.max(1))
}

pub(super) fn signed_out() -> Response {
    (StatusCode::UNAUTHORIZED, Json(body(ApiErrorCode::SignedOut, "로그인이 필요합니다", None, None))).into_response()
}

pub(super) fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(body(ApiErrorCode::NotFound, "없는 경로입니다", None, None))).into_response()
}

pub(super) fn too_large() -> Response {
    (StatusCode::PAYLOAD_TOO_LARGE, Json(body(ApiErrorCode::PayloadTooLarge, TOO_LARGE, None, None))).into_response()
}

pub(super) fn internal() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(body(ApiErrorCode::Internal, "서버 내부 오류입니다", None, None))).into_response()
}

fn is_json(response: &Response) -> bool {
    response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("application/json"))
}

fn is_kiwoom_code(code: ApiErrorCode) -> bool {
    matches!(code, ApiErrorCode::KiwoomUnavailable | ApiErrorCode::KiwoomAuthFailed | ApiErrorCode::AccountServerUnavailable)
}

/// 안쪽이 낸 오류 응답을 공개 모양으로 고친다. 오류가 아닌 응답은 건드리지 않는다.
pub(super) async fn shape(response: Response, now: i64) -> Response {
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error()) {
        return response;
    }
    if status == StatusCode::PAYLOAD_TOO_LARGE && !is_json(&response) {
        return too_large();
    }
    if !is_json(&response) {
        return match status {
            StatusCode::TOO_MANY_REQUESTS => too_many(now, now + KIWOOM_RETRY_SECS),
            StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT | StatusCode::REQUEST_TIMEOUT => busy(now, KIWOOM_RETRY_SECS),
            StatusCode::INTERNAL_SERVER_ERROR => internal(),
            _ => response,
        };
    }
    let (parts, inner) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(inner, SHAPED_BODY_LIMIT).await else { return internal() };
    let Ok(mut error) = serde_json::from_slice::<api::ApiError>(&bytes) else { return Response::from_parts(parts, Body::from(bytes)) };
    let mut status = status;
    if is_kiwoom_code(error.error.code) && status != StatusCode::TOO_MANY_REQUESTS {
        let soonest = now + KIWOOM_RETRY_SECS;
        let retry_at = error.error.retry_at.map_or(soonest, |at| at.0.min(soonest));
        error.error.message = KIWOOM_FIXED.to_owned();
        error.error.manual_action_required = false;
        error.error.reason = error.error.reason.filter(|r| matches!(r, ApiErrorReason::SymbolListLoading | ApiErrorReason::RateLimited));
        error.error.retry_at = Some(UnixSeconds(retry_at));
        if status == StatusCode::BAD_GATEWAY {
            status = StatusCode::SERVICE_UNAVAILABLE;
        }
    }
    if matches!(status, StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE) {
        let retry_at = error.error.retry_at.map_or(now + KIWOOM_RETRY_SECS, |at| at.0.max(now + 1));
        error.error.retry_at = Some(UnixSeconds(retry_at));
        let mut response = (status, Json(error)).into_response();
        if let Ok(value) = HeaderValue::from_str(&(retry_at - now).max(1).to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return response;
    }
    (status, Json(error)).into_response()
}

pub(super) fn security_headers(response: &mut Response, csp: &'static str) {
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(csp));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::HeaderName::from_static("cross-origin-opener-policy"), HeaderValue::from_static("same-origin"));
}
