use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct Body<'a> {
    code: &'a str,
    message: &'a str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }

    pub fn provider_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "provider_not_found", "지원하지 않는 로그인 방식입니다")
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "없는 길입니다")
    }

    pub fn method_not_allowed() -> Self {
        Self::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "허용하지 않는 메서드입니다")
    }

    pub fn invalid_grant() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_grant", "코드를 쓸 수 없습니다")
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "토큰이 올바르지 않거나 만료됐습니다")
    }

    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "이 출처의 요청만 받습니다")
    }

    pub fn unsupported_media_type() -> Self {
        Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type", "본문은 application/json이어야 합니다")
    }

    pub fn from_rejection(status: StatusCode) -> Self {
        match status {
            StatusCode::PAYLOAD_TOO_LARGE => Self::new(status, "payload_too_large", "본문이 너무 큽니다"),
            _ => Self::new(status, "invalid_request", "요청을 처리할 수 없습니다"),
        }
    }

    pub fn is_foreign_key_violation(error: &sqlx::Error) -> bool {
        error.as_database_error().is_some_and(|database| database.is_foreign_key_violation())
    }

    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "서버 오류입니다")
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "저장소 오류");
        Self::internal()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Body { code: self.code, message: &self.message };
        (self.status, Json(body)).into_response()
    }
}
