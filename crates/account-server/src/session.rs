use crate::app::{AppState, SessionAccount, Shared, begin_login, cookie_value};
use crate::error::ApiError;
use crate::model::{LoginFlow, Provider};
use crate::store::SESSION_ABSOLUTE_SECONDS;
use axum::extract::{Path, State};
use axum::http::header::{CONTENT_TYPE, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;

const SESSION_TOKEN_LENGTH: usize = 43;

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/session/{provider}/start", get(start))
        .route("/v1/session", get(current))
        .route("/v1/session/logout", post(logout))
}

impl AppState {
    pub(crate) fn session_cookie(&self, session: &str) -> String {
        self.session_cookie_line(session, SESSION_ABSOLUTE_SECONDS)
    }

    fn session_cookie_line(&self, value: &str, max_age: i64) -> String {
        let secure = if self.secure_cookie { "; Secure" } else { "" };
        format!("{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", self.session_cookie_name)
    }

    fn session_token(&self, headers: &HeaderMap) -> Option<String> {
        cookie_value(headers, self.session_cookie_name).filter(|token| token.len() == SESSION_TOKEN_LENGTH)
    }
}

pub(crate) async fn session_account(state: &AppState, headers: &HeaderMap) -> Result<Option<SessionAccount>, sqlx::Error> {
    let Some(token) = state.session_token(headers) else { return Ok(None) };
    let Some(record) = state.store.touch_session(&token, state.clock.now()).await? else { return Ok(None) };
    let Ok(provider) = Provider::parse(&record.provider) else { return Ok(None) };
    if state.options.blocked.contains(provider, &record.subject) {
        return Ok(None);
    }
    Ok(Some(SessionAccount { account_id: record.account_id, provider, subject: record.subject, created_at: record.created_at }))
}

async fn start(State(state): Shared, Path(provider): Path<String>) -> Result<Response, ApiError> {
    begin_login(&state, Provider::parse(&provider)?, LoginFlow::Browser).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    provider: Provider,
    created_at: i64,
}

async fn current(State(state): Shared, headers: HeaderMap) -> Result<Json<SessionResponse>, ApiError> {
    let account = session_account(&state, &headers).await?.ok_or_else(ApiError::unauthorized)?;
    Ok(Json(SessionResponse { provider: account.provider, created_at: account.created_at }))
}

fn require_same_origin_json(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let same_origin = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) == Some(state.public_origin.as_str());
    if !same_origin {
        return Err(ApiError::forbidden());
    }
    let is_json = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("application/json"));
    if !is_json {
        return Err(ApiError::unsupported_media_type());
    }
    Ok(())
}

fn clearing(state: &AppState) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = HeaderValue::from_str(&state.session_cookie_line("", 0)) {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
}

async fn logout(State(state): Shared, headers: HeaderMap) -> Result<Response, ApiError> {
    require_same_origin_json(&state, &headers)?;
    if let Some(token) = state.session_token(&headers) {
        state.store.revoke_session(&token).await?;
    }
    Ok(clearing(&state))
}

pub(crate) async fn delete_session_account(state: &AppState, headers: &HeaderMap) -> Result<Response, ApiError> {
    if state.session_token(headers).is_none() {
        return Err(ApiError::unauthorized());
    }
    require_same_origin_json(state, headers)?;
    let account = session_account(state, headers).await?.ok_or_else(ApiError::unauthorized)?;
    state.store.delete_account(&account.account_id).await?;
    tracing::info!(account_id = account.account_id, "계정 삭제");
    Ok(clearing(state))
}
