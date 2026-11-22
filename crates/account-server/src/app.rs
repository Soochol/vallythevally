use crate::clock::Clock;
use crate::config::{AccountConfig, AccountOptions};
use crate::error::ApiError;
use crate::idp::{AuthorizeParams, CodeGrant, IdpClient};
use crate::model::{ConnectorPort, LoginFlow, Provider, StartRequest};
use crate::secrets::{random_string, s256_challenge};
use crate::setup_api::{ChangesResponse, PushResponse, SummaryResponse};
use crate::store::{AccountSlot, PendingLoginSlot, Store};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, LOCATION, RETRY_AFTER, SET_COOKIE};
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
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) public_origin: String,
    cookie_prefix: &'static str,
    pub(crate) session_cookie_name: &'static str,
    pub(crate) secure_cookie: bool,
    pub(crate) options: AccountOptions,
}

pub(crate) type Shared = State<Arc<AppState>>;

pub fn router(config: AccountConfig, pool: SqlitePool, clock: Arc<dyn Clock>) -> Router {
    Accounts::new(config, AccountOptions::default(), pool, clock).router()
}

pub fn router_with_pending_login_limit(
    config: AccountConfig,
    pool: SqlitePool,
    clock: Arc<dyn Clock>,
    pending_login_limit: u32,
) -> Router {
    Accounts::new(config, AccountOptions { pending_login_limit, ..AccountOptions::default() }, pool, clock).router()
}

pub struct SessionAccount {
    pub account_id: String,
    pub provider: Provider,
    pub subject: String,
    pub created_at: i64,
}

#[derive(Clone)]
pub struct Accounts(Arc<AppState>);

impl Accounts {
    pub fn new(config: AccountConfig, options: AccountOptions, pool: SqlitePool, clock: Arc<dyn Clock>) -> Self {
        let secure_cookie = config.public_url.is_secure();
        Self(Arc::new(AppState {
            store: Store::new(pool),
            idp: IdpClient::new(&config),
            clock,
            public_origin: config.public_url.origin().to_owned(),
            cookie_prefix: if secure_cookie { "__Host-vally_login_" } else { "vally_login_" },
            session_cookie_name: if secure_cookie { "__Host-vally_session" } else { "vally_session" },
            secure_cookie,
            options,
        }))
    }

    pub fn router(&self) -> Router {
        let routes = Router::new()
            .route("/v1/auth/{provider}/start", get(start))
            .route("/v1/auth/token", post(exchange_token).delete(revoke_token))
            .route("/v1/me", get(me))
            .route("/v1/account", delete(delete_account))
            .merge(self.shared_routes());
        self.finish(routes.layer(DefaultBodyLimit::max(4096)).merge(crate::setup_api::routes()))
    }

    pub fn browser_router(&self) -> Router {
        let routes = Router::new().route("/v1/account", delete(crate::session::delete_account)).merge(self.shared_routes());
        self.finish(routes.layer(DefaultBodyLimit::max(4096)))
    }

    fn shared_routes(&self) -> Router<Arc<AppState>> {
        Router::new().route("/v1/auth/{provider}/callback", get(callback)).merge(crate::session::routes())
    }

    fn finish(&self, routes: Router<Arc<AppState>>) -> Router {
        routes
            .fallback(|| async { ApiError::not_found() })
            .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
            .layer(axum::middleware::map_response(no_store))
            .with_state(self.0.clone())
    }

    pub async fn session_account(&self, headers: &HeaderMap) -> Result<Option<SessionAccount>, sqlx::Error> {
        crate::session::session_account(&self.0, headers).await
    }

    pub async fn setup_push(&self, account_id: &str, body: &[u8]) -> Result<PushResponse, ApiError> {
        crate::setup_api::push(&self.0.store, self.0.clock.now().0.saturating_mul(1000), account_id, body).await
    }

    pub async fn setup_changes(&self, account_id: &str, since: i64, limit: i64) -> Result<ChangesResponse, ApiError> {
        crate::setup_api::changes(&self.0.store, account_id, since, limit).await
    }

    pub async fn setup_summary(&self, account_id: &str) -> Result<SummaryResponse, ApiError> {
        crate::setup_api::summary(&self.0.store, account_id).await
    }
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

pub(crate) fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(cookie_name, _)| *cookie_name == name)
        .map(|(_, value)| value.to_owned())
}

impl AppState {
    fn login_cookie(&self, idp_state: &str, value: &str, max_age: u32) -> String {
        let secure = if self.secure_cookie { "; Secure" } else { "" };
        format!("{}{idp_state}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", self.cookie_prefix)
    }

    fn browser_secret(&self, headers: &HeaderMap, idp_state: &str) -> Option<String> {
        cookie_value(headers, &format!("{}{idp_state}", self.cookie_prefix))
    }
}

async fn start(
    State(state): Shared,
    Path(provider): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Response, ApiError> {
    let provider = Provider::parse(&provider)?;
    let request = StartRequest::parse(&query_map(raw))?;
    begin_login(&state, provider, LoginFlow::Connector(request)).await
}

pub(crate) async fn begin_login(state: &AppState, provider: Provider, flow: LoginFlow) -> Result<Response, ApiError> {
    let now = state.clock.now();
    state.store.purge_expired(now).await?;
    let idp_state = random_string(32);
    let browser_secret = random_string(32);
    let nonce = random_string(32);
    let slot = state
        .store
        .insert_pending_login(
            crate::store::NewPendingLogin {
                idp_state: &idp_state,
                provider,
                browser_secret: &browser_secret,
                nonce: &nonce,
                flow: &flow,
            },
            now,
            state.options.pending_login_limit,
        )
        .await?;
    if matches!(slot, PendingLoginSlot::Full) {
        return Ok(login_busy_page());
    }
    let authorize = state.idp.authorize_url(provider, AuthorizeParams { state: &idp_state, nonce: &nonce });
    let cookie = state.login_cookie(&idp_state, &browser_secret, 600);
    Ok(with_cookie(redirect(authorize.as_str()), &cookie))
}

fn login_error_page() -> Response {
    let body = "<!doctype html><meta charset=\"utf-8\"><title>로그인 실패</title><p>로그인을 마치지 못했습니다. vally에서 로그인을 다시 시작하세요.</p>";
    (StatusCode::BAD_REQUEST, [(CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

const LOGIN_BUSY_RETRY_SECONDS: &str = "60";

fn login_busy_page() -> Response {
    let body = "<!doctype html><meta charset=\"utf-8\"><title>로그인 대기</title><p>로그인 요청이 많아 잠시 받지 않습니다. 잠시 뒤 vally에서 로그인을 다시 시작하세요.</p>";
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(CONTENT_TYPE, "text/html; charset=utf-8"), (RETRY_AFTER, LOGIN_BUSY_RETRY_SECONDS)],
        body,
    )
        .into_response()
}

fn connector_url(port: ConnectorPort, pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://127.0.0.1/auth/complete").expect("고정 주소");
    url.set_port(Some(port.get())).expect("루프백 주소는 포트를 받는다");
    url.query_pairs_mut().extend_pairs(pairs);
    url.into()
}

#[derive(Clone, Copy)]
enum Refusal {
    Cancelled,
    IdpFailed,
    AccountLimit,
    Blocked,
}

impl Refusal {
    fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::IdpFailed => "idp_failed",
            Self::AccountLimit => "account_limit",
            Self::Blocked => "blocked",
        }
    }
}

async fn verified_subject(
    state: &AppState,
    provider: Provider,
    query: &HashMap<String, String>,
    idp_state: &str,
    nonce: &str,
    now: crate::clock::UnixSeconds,
) -> Result<String, Refusal> {
    if query.contains_key("error") {
        return Err(Refusal::Cancelled);
    }
    let Some(code) = query.get("code") else {
        return Err(Refusal::IdpFailed);
    };
    state.idp.subject(provider, CodeGrant { code, state: idp_state, nonce, now }).await.map_err(|failure| {
        tracing::warn!(%provider, reason = failure.0, "IdP 로그인 실패");
        Refusal::IdpFailed
    })
}

async fn admitted_account(
    state: &AppState,
    provider: Provider,
    subject: &str,
    now: crate::clock::UnixSeconds,
) -> Result<Result<String, Refusal>, ApiError> {
    if state.options.blocked.contains(provider, subject) {
        return Ok(Err(Refusal::Blocked));
    }
    Ok(match state.store.account_for_identity(provider, subject, now, state.options.max_accounts).await? {
        AccountSlot::Existing(account_id) | AccountSlot::Created(account_id) => Ok(account_id),
        AccountSlot::Full => Err(Refusal::AccountLimit),
    })
}

async fn callback(
    State(state): Shared,
    Path(provider): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let provider = Provider::parse(&provider)?;
    let query = query_map(raw);
    let Some(idp_state) = query.get("state") else {
        return Ok(login_error_page());
    };
    let Some(browser_secret) = state.browser_secret(&headers, idp_state) else {
        return Ok(login_error_page());
    };
    let now = state.clock.now();
    let Some(pending) = state.store.take_pending_login(provider, idp_state, &browser_secret, now).await? else {
        return Ok(login_error_page());
    };
    let clear = state.login_cookie(idp_state, "", 0);
    let admission = match verified_subject(&state, provider, &query, idp_state, &pending.nonce, now).await {
        Ok(subject) => admitted_account(&state, provider, &subject, now).await?,
        Err(refusal) => Err(refusal),
    };
    match pending.flow {
        LoginFlow::Connector(request) => {
            let back = |pairs: &[(&str, &str)]| with_cookie(redirect(&connector_url(request.port, pairs)), &clear);
            let connector_state = request.state.as_str();
            match admission {
                Err(refusal) => Ok(back(&[("error", refusal.code()), ("state", connector_state)])),
                Ok(account_id) => {
                    let one_time_code = random_string(32);
                    state.store.insert_auth_code(&one_time_code, &account_id, &request.code_challenge, now).await?;
                    tracing::info!(%provider, account_id, "로그인 코드 발급");
                    Ok(back(&[("code", &one_time_code), ("state", connector_state)]))
                }
            }
        }
        LoginFlow::Browser => {
            let landing = match admission {
                Err(refusal) => format!("{}/?login=error&reason={}", state.public_origin, refusal.code()),
                Ok(account_id) => {
                    let session = random_string(32);
                    state.store.insert_session(&session, &account_id, now).await?;
                    tracing::info!(%provider, account_id, "브라우저 로그인");
                    let response = with_cookie(redirect(&format!("{}/", state.public_origin)), &clear);
                    return Ok(with_cookie(response, &state.session_cookie(&session)));
                }
            };
            Ok(with_cookie(redirect(&landing), &clear))
        }
    }
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
    if !state.options.blocked.is_empty() {
        let account = state.store.account(&account_id).await?.ok_or_else(ApiError::unauthorized)?;
        let blocked = Provider::parse(&account.provider).is_ok_and(|provider| state.options.blocked.contains(provider, &account.subject));
        if blocked {
            return Err(ApiError::unauthorized());
        }
    }
    Ok((token.to_owned(), account_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    id: String,
    provider: String,
    subject: String,
    created_at: i64,
}

async fn me(State(state): Shared, headers: HeaderMap) -> Result<Json<MeResponse>, ApiError> {
    let (_, account_id) = authenticate(&state, &headers).await?;
    let account = state.store.account(&account_id).await?.ok_or_else(ApiError::unauthorized)?;
    Ok(Json(MeResponse { id: account.id, provider: account.provider, subject: account.subject, created_at: account.created_at }))
}

async fn revoke_token(State(state): Shared, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let (token, account_id) = authenticate(&state, &headers).await?;
    state.store.revoke_token(&token).await?;
    tracing::info!(account_id, "커넥터 토큰 폐기");
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_account(State(state): Shared, headers: HeaderMap) -> Result<Response, ApiError> {
    if headers.contains_key("authorization") {
        let (_, account_id) = authenticate(&state, &headers).await?;
        state.store.delete_account(&account_id).await?;
        tracing::info!(account_id, "계정 삭제");
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    crate::session::delete_session_account(&state, &headers).await
}
