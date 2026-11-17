use crate::clock::Clock;
use crate::config::AccountConfig;
use crate::error::ApiError;
use crate::idp::{AuthorizeParams, CodeGrant, IdpClient};
use crate::model::{ConnectorPort, Provider, StartRequest};
use crate::secrets::{random_string, s256_challenge};
use crate::store::Store;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use url::Url;

pub(crate) struct AppState {
    pub(crate) store: Store,
    idp: IdpClient,
    clock: Arc<dyn Clock>,
    cookie_name: &'static str,
    secure_cookie: bool,
}

pub(crate) type Shared = State<Arc<AppState>>;

pub fn router(config: AccountConfig, pool: SqlitePool, clock: Arc<dyn Clock>) -> Router {
    let secure_cookie = config.public_url.is_secure();
    let state = Arc::new(AppState {
        store: Store::new(pool),
        idp: IdpClient::new(&config),
        clock,
        cookie_name: if secure_cookie { "__Host-vally_login" } else { "vally_login" },
        secure_cookie,
    });
    Router::new()
        .route("/v1/auth/{provider}/start", get(start))
        .route("/v1/auth/{provider}/callback", get(callback))
        .route("/v1/auth/token", post(exchange_token).delete(revoke_token))
        .route("/v1/me", get(me))
        .route("/v1/account", delete(delete_account))
        .layer(DefaultBodyLimit::max(4096))
        .merge(crate::setup_api::routes())
        .fallback(|| async { ApiError::not_found() })
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .layer(axum::middleware::map_response(no_store))
        .with_state(state)
}

async fn no_store(response: Response) -> Response {
    let plain_client_error = response.status().is_client_error()
        && response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/plain"));
    let mut response = if plain_client_error { ApiError::from_rejection(response.status()).into_response() } else { response };
    response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn query_map(raw: Option<String>) -> HashMap<String, String> {
    url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()).into_owned().collect()
}

fn redirect(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    match HeaderValue::from_str(location) {
        Ok(value) => {
            response.headers_mut().insert(LOCATION, value);
            response
        }
        Err(_) => ApiError::internal().into_response(),
    }
}

fn with_cookie(mut response: Response, cookie: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(cookie) {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
}

impl AppState {
    fn login_cookie(&self, value: &str, max_age: u32) -> String {
        let secure = if self.secure_cookie { "; Secure" } else { "" };
        format!("{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", self.cookie_name)
    }

    fn browser_secret(&self, headers: &HeaderMap) -> Option<String> {
        headers
            .get_all(COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|line| line.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(name, _)| *name == self.cookie_name)
            .map(|(_, value)| value.to_owned())
    }
}

async fn start(
    State(state): Shared,
    Path(provider): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Response, ApiError> {
    let provider = Provider::parse(&provider)?;
    let request = StartRequest::parse(&query_map(raw))?;
    let now = state.clock.now();
    state.store.purge_expired(now).await?;
    let idp_state = random_string(32);
    let browser_secret = random_string(32);
    let nonce = random_string(32);
    state
        .store
        .insert_pending_login(
            crate::store::NewPendingLogin {
                idp_state: &idp_state,
                provider,
                browser_secret: &browser_secret,
                nonce: &nonce,
                port: request.port,
                connector_state: &request.state,
                code_challenge: &request.code_challenge,
            },
            now,
        )
        .await?;
    let authorize = state.idp.authorize_url(provider, AuthorizeParams { state: &idp_state, nonce: &nonce });
    let cookie = state.login_cookie(&browser_secret, 600);
    Ok(with_cookie(redirect(authorize.as_str()), &cookie))
}

fn login_error_page() -> Response {
    let body = "<!doctype html><meta charset=\"utf-8\"><title>로그인 실패</title><p>로그인을 마치지 못했습니다. vally에서 로그인을 다시 시작하세요.</p>";
    (StatusCode::BAD_REQUEST, [(CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

fn connector_url(port: ConnectorPort, pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://127.0.0.1/auth/complete").expect("고정 주소");
    url.set_port(Some(port.get())).expect("루프백 주소는 포트를 받는다");
    url.query_pairs_mut().extend_pairs(pairs);
    url.into()
}

async fn callback(
    State(state): Shared,
    Path(provider): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let provider = Provider::parse(&provider)?;
    let query = query_map(raw);
    let (Some(idp_state), Some(browser_secret)) = (query.get("state"), state.browser_secret(&headers)) else {
        return Ok(login_error_page());
    };
    let now = state.clock.now();
    let Some(pending) = state.store.take_pending_login(provider, idp_state, &browser_secret, now).await? else {
        return Ok(login_error_page());
    };
    let clear = state.login_cookie("", 0);
    let back = |pairs: &[(&str, &str)]| with_cookie(redirect(&connector_url(pending.port, pairs)), &clear);
    let connector_state = pending.connector_state.as_str();
    if query.contains_key("error") {
        return Ok(back(&[("error", "cancelled"), ("state", connector_state)]));
    }
    let Some(code) = query.get("code") else {
        return Ok(back(&[("error", "idp_failed"), ("state", connector_state)]));
    };
    let grant = CodeGrant { code, state: idp_state, nonce: &pending.nonce, now };
    let subject = match state.idp.subject(provider, grant).await {
        Ok(subject) => subject,
        Err(failure) => {
            tracing::warn!(%provider, reason = failure.0, "IdP 로그인 실패");
            return Ok(back(&[("error", "idp_failed"), ("state", connector_state)]));
        }
    };
    let account_id = state.store.account_for_identity(provider, &subject, now).await?;
    let one_time_code = random_string(32);
    state.store.insert_auth_code(&one_time_code, &account_id, &pending.code_challenge, now).await?;
    tracing::info!(%provider, account_id, "로그인 코드 발급");
    Ok(back(&[("code", &one_time_code), ("state", connector_state)]))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenRequest {
    code: String,
    code_verifier: String,
}

#[derive(Serialize)]
struct AccountRef {
    id: String,
    provider: String,
}

#[derive(Serialize)]
struct TokenResponse {
    token: String,
    account: AccountRef,
}

async fn exchange_token(State(state): Shared, body: Bytes) -> Result<Json<TokenResponse>, ApiError> {
    let request: TokenRequest =
        serde_json::from_slice(&body).map_err(|_| ApiError::invalid_request("본문은 {code, codeVerifier} JSON이어야 합니다"))?;
    let now = state.clock.now();
    state.store.purge_expired(now).await?;
    let (account_id, challenge) = state.store.take_auth_code(&request.code, now).await?.ok_or_else(ApiError::invalid_grant)?;
    if s256_challenge(&request.code_verifier) != challenge {
        return Err(ApiError::invalid_grant());
    }
    let account = state.store.account(&account_id).await?.ok_or_else(ApiError::invalid_grant)?;
    let token = random_string(32);
    state.store.insert_token(&token, &account_id, now).await.map_err(|error| {
        if ApiError::is_foreign_key_violation(&error) { ApiError::invalid_grant() } else { error.into() }
    })?;
    tracing::info!(account_id, "커넥터 토큰 발급");
    Ok(Json(TokenResponse { token, account: AccountRef { id: account.id, provider: account.provider } }))
}

pub(crate) async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<(String, String), ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| token.len() == 43)
        .ok_or_else(ApiError::unauthorized)?;
    let account_id = state.store.touch_token(token, state.clock.now()).await?.ok_or_else(ApiError::unauthorized)?;
    Ok((token.to_owned(), account_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    id: String,
    provider: String,
    created_at: i64,
}

async fn me(State(state): Shared, headers: HeaderMap) -> Result<Json<MeResponse>, ApiError> {
    let (_, account_id) = authenticate(&state, &headers).await?;
    let account = state.store.account(&account_id).await?.ok_or_else(ApiError::unauthorized)?;
    Ok(Json(MeResponse { id: account.id, provider: account.provider, created_at: account.created_at }))
}

async fn revoke_token(State(state): Shared, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let (token, account_id) = authenticate(&state, &headers).await?;
    state.store.revoke_token(&token).await?;
    tracing::info!(account_id, "커넥터 토큰 폐기");
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_account(State(state): Shared, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let (_, account_id) = authenticate(&state, &headers).await?;
    state.store.delete_account(&account_id).await?;
    tracing::info!(account_id, "계정 삭제");
    Ok(StatusCode::NO_CONTENT)
}
