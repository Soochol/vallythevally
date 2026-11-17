use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde::Deserialize;

use crate::account::{CompleteQuery, Refusal};
use crate::api::{AccountConfirm, AccountLoginRequest, AccountLoginStart, AccountStatus, ApiErrorCode, UnixSeconds};
use crate::http::{ApiFailure, AppState};
use crate::user_routes::read_json;

const BODY_LIMIT: usize = 4096;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/account", get(status))
        .route("/api/account/login", post(login))
        .route("/api/account/logout", post(logout))
        .route("/api/account/refresh", post(refresh))
        .route("/api/account/delete", post(delete))
        .route("/api/account/replace-local", post(replace_local))
        .layer(middleware::from_fn_with_state(state, crate::write_guard::guard_writes))
        .route("/auth/complete", get(complete))
}

impl From<Refusal> for ApiFailure {
    fn from(refusal: Refusal) -> Self {
        let code = match refusal {
            Refusal::LocalOnly | Refusal::NotSignedIn | Refusal::NotOwnerMismatch => ApiErrorCode::Conflict,
            Refusal::ServerUnavailable(_) => ApiErrorCode::AccountServerUnavailable,
            Refusal::Storage => ApiErrorCode::Internal,
        };
        ApiFailure::new(code, refusal.to_string())
    }
}

fn now(st: &AppState) -> UnixSeconds {
    UnixSeconds(st.clock.now().unix())
}

async fn current(st: &AppState) -> Result<Json<AccountStatus>, ApiFailure> {
    st.system.account().status(&st.db).await.map(Json).map_err(|e| {
        tracing::error!(error = %e, "로컬 소유 계정을 읽지 못했습니다");
        ApiFailure::new(ApiErrorCode::Internal, "계정 상태를 읽지 못했습니다")
    })
}

async fn status(State(st): State<Arc<AppState>>) -> Result<Json<AccountStatus>, ApiFailure> {
    current(&st).await
}

async fn login(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<AccountLoginStart>, ApiFailure> {
    let request: AccountLoginRequest = read_json(body, BODY_LIMIT, "로그인 요청").await?;
    let port = st.system.bound_addr().ok_or_else(|| ApiFailure::new(ApiErrorCode::Internal, "서버가 아직 준비되지 않았습니다"))?.port();
    let url = st.system.account().start_login(now(&st), request.provider, port)?;
    Ok(Json(AccountLoginStart { url }))
}

async fn logout(State(st): State<Arc<AppState>>) -> Result<Json<AccountStatus>, ApiFailure> {
    st.system.account().logout().await?;
    current(&st).await
}

async fn refresh(State(st): State<Arc<AppState>>) -> Result<Json<AccountStatus>, ApiFailure> {
    st.system.account().refresh().await?;
    current(&st).await
}

async fn confirmed(body: Body) -> Result<(), ApiFailure> {
    let confirm: AccountConfirm = read_json(body, BODY_LIMIT, "확인 요청").await?;
    if confirm.confirm { Ok(()) } else { Err(ApiFailure::bad_request("confirm이 true여야 합니다")) }
}

async fn delete(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<AccountStatus>, ApiFailure> {
    confirmed(body).await?;
    st.system.account().delete_account(&st.db).await?;
    current(&st).await
}

async fn replace_local(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<AccountStatus>, ApiFailure> {
    confirmed(body).await?;
    st.system.account().replace_local(&st.db).await?;
    current(&st).await
}

#[derive(Deserialize)]
struct CompleteParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn found(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    let headers = response.headers_mut();
    headers.insert(header::LOCATION, HeaderValue::from_str(location).expect("고정된 문자만 담은 주소"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

async fn complete(State(st): State<Arc<AppState>>, Query(params): Query<CompleteParams>, request: Request) -> Response {
    if let Err(rejected) = crate::write_guard::check_host(&st, request.headers(), request.uri()) {
        tracing::warn!("로그인 완료 요청을 거절했습니다");
        return rejected.into_response();
    }
    let query = CompleteQuery { code: params.code, state: params.state, error: params.error };
    match st.system.account().complete_login(&st.db, now(&st), query).await {
        Ok(()) => found("/"),
        Err(failed) => {
            tracing::warn!(reason = failed.code(), "계정 로그인을 끝내지 못했습니다");
            found(&format!("/?login=error&reason={}", failed.code()))
        }
    }
}
