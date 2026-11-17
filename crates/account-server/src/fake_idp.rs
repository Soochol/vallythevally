use crate::clock::Clock;
use axum::extract::{Query, State};
use axum::http::header::{AUTHORIZATION, LOCATION};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Form, Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

#[derive(Clone, Debug)]
pub struct ClientCredentials {
    pub id: String,
    pub secret: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    None,
    WrongAudience,
    ExtraAudience,
    WrongIssuer,
    WrongNonce,
    ExpiredIdToken,
    TokenExchangeRejected,
    ProfileFailure,
}

#[derive(Clone)]
struct Grant {
    subject: String,
    email: String,
    nonce: String,
    state: String,
    redirect_uri: String,
    client_id: String,
    fault: Fault,
}

struct Script {
    subject: String,
    email: String,
    fault: Fault,
    cancel_next: bool,
}

struct Inner {
    google: ClientCredentials,
    naver: ClientCredentials,
    clock: Arc<dyn Clock>,
    script: Mutex<Script>,
    codes: Mutex<HashMap<String, Grant>>,
    access_tokens: Mutex<HashMap<String, Grant>>,
    authorize_requests: Mutex<Vec<(String, HashMap<String, String>)>>,
    counter: Mutex<u64>,
}

pub struct FakeIdp {
    base_url: String,
    inner: Arc<Inner>,
    task: JoinHandle<()>,
}

impl Drop for FakeIdp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeIdp {
    pub async fn start(google: ClientCredentials, naver: ClientCredentials, clock: Arc<dyn Clock>) -> Self {
        let inner = Arc::new(Inner {
            google,
            naver,
            clock,
            script: Mutex::new(Script { subject: "subject-1".into(), email: "person@example.test".into(), fault: Fault::None, cancel_next: false }),
            codes: Mutex::default(),
            access_tokens: Mutex::default(),
            authorize_requests: Mutex::default(),
            counter: Mutex::new(0),
        });
        let router = Router::new()
            .route("/google/authorize", get(google_authorize))
            .route("/google/token", axum::routing::post(google_token))
            .route("/naver/authorize", get(naver_authorize))
            .route("/naver/token", axum::routing::post(naver_token))
            .route("/naver/profile", get(naver_profile))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("가짜 IdP 포트를 열지 못했다");
        let base_url = format!("http://{}", listener.local_addr().expect("주소"));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Self { base_url, inner, task }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    pub fn set_subject(&self, subject: &str) {
        self.inner.script.lock().unwrap().subject = subject.to_owned();
    }

    pub fn set_email(&self, email: &str) {
        self.inner.script.lock().unwrap().email = email.to_owned();
    }

    pub fn set_fault(&self, fault: Fault) {
        self.inner.script.lock().unwrap().fault = fault;
    }

    pub fn cancel_next_authorization(&self) {
        self.inner.script.lock().unwrap().cancel_next = true;
    }

    pub fn authorize_requests(&self, provider: &str) -> Vec<HashMap<String, String>> {
        self.inner
            .authorize_requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == provider)
            .map(|(_, query)| query.clone())
            .collect()
    }
}

impl Inner {
    fn next_id(&self, prefix: &str) -> String {
        let mut counter = self.counter.lock().unwrap();
        *counter += 1;
        format!("{prefix}-{}", *counter)
    }

    fn authorize(&self, provider: &str, query: HashMap<String, String>) -> Response {
        self.authorize_requests.lock().unwrap().push((provider.to_owned(), query.clone()));
        let field = |name: &str| query.get(name).cloned().unwrap_or_default();
        let redirect_uri = field("redirect_uri");
        let state = field("state");
        let (cancel, subject, email, fault) = {
            let mut script = self.script.lock().unwrap();
            let cancel = std::mem::take(&mut script.cancel_next);
            (cancel, script.subject.clone(), script.email.clone(), script.fault)
        };
        let mut location = url::Url::parse(&redirect_uri).expect("redirect_uri는 주소여야 한다");
        if cancel {
            location.query_pairs_mut().append_pair("error", "access_denied").append_pair("state", &state);
        } else {
            let code = self.next_id("fake-code");
            let grant = Grant { subject, email, nonce: field("nonce"), state: state.clone(), redirect_uri, client_id: field("client_id"), fault };
            self.codes.lock().unwrap().insert(code.clone(), grant);
            location.query_pairs_mut().append_pair("code", &code).append_pair("state", &state);
        }
        (StatusCode::FOUND, [(LOCATION, location.to_string())]).into_response()
    }

    fn redeem(&self, credentials: &ClientCredentials, form: &HashMap<String, String>) -> Option<Grant> {
        let field = |name: &str| form.get(name).map(String::as_str).unwrap_or_default();
        if field("grant_type") != "authorization_code"
            || field("client_id") != credentials.id
            || field("client_secret") != credentials.secret
        {
            return None;
        }
        let grant = self.codes.lock().unwrap().remove(field("code"))?;
        if grant.fault == Fault::TokenExchangeRejected || grant.client_id != credentials.id {
            return None;
        }
        Some(grant)
    }
}

fn rejected() -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"}))).into_response()
}

async fn google_authorize(State(inner): State<Arc<Inner>>, Query(query): Query<HashMap<String, String>>) -> Response {
    inner.authorize("google", query)
}

async fn google_token(State(inner): State<Arc<Inner>>, Form(form): Form<HashMap<String, String>>) -> Response {
    let Some(grant) = inner.redeem(&inner.google, &form) else {
        return rejected();
    };
    if form.get("redirect_uri") != Some(&grant.redirect_uri) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "redirect_uri_mismatch"}))).into_response();
    }
    let now = inner.clock.now().0;
    let claims = json!({
        "iss": if grant.fault == Fault::WrongIssuer { "https://issuer.example.test" } else { "https://accounts.google.com" },
        "aud": match grant.fault {
            Fault::WrongAudience => json!("another-client"),
            Fault::ExtraAudience => json!(["another-client", inner.google.id]),
            _ => json!(inner.google.id),
        },
        "exp": if grant.fault == Fault::ExpiredIdToken { now - 1 } else { now + 3600 },
        "iat": now,
        "nonce": if grant.fault == Fault::WrongNonce { "another-nonce" } else { grant.nonce.as_str() },
        "sub": grant.subject,
        "email": grant.email,
    });
    let part = |value: &serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let id_token = format!("{}.{}.unsigned", part(&json!({"alg": "none"})), part(&claims));
    Json(json!({"access_token": "fake-google-access", "token_type": "Bearer", "expires_in": 3600, "id_token": id_token})).into_response()
}

async fn naver_authorize(State(inner): State<Arc<Inner>>, Query(query): Query<HashMap<String, String>>) -> Response {
    inner.authorize("naver", query)
}

async fn naver_token(State(inner): State<Arc<Inner>>, Form(form): Form<HashMap<String, String>>) -> Response {
    let Some(grant) = inner.redeem(&inner.naver, &form) else {
        return rejected();
    };
    if form.get("state") != Some(&grant.state) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_request"}))).into_response();
    }
    let access_token = inner.next_id("fake-naver-access");
    inner.access_tokens.lock().unwrap().insert(access_token.clone(), grant);
    Json(json!({"access_token": access_token, "refresh_token": "fake-refresh", "token_type": "bearer", "expires_in": "3600"})).into_response()
}

async fn naver_profile(State(inner): State<Arc<Inner>>, headers: HeaderMap) -> Response {
    let token = headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer "));
    let grant = token.and_then(|token| inner.access_tokens.lock().unwrap().get(token).cloned());
    match grant {
        Some(grant) if grant.fault != Fault::ProfileFailure => Json(json!({
            "resultcode": "00",
            "message": "success",
            "response": {"id": grant.subject, "email": grant.email, "name": "Fake Person"},
        }))
        .into_response(),
        Some(_) => Json(json!({"resultcode": "024", "message": "Authentication failed"})).into_response(),
        None => (StatusCode::UNAUTHORIZED, Json(json!({"resultcode": "024", "message": "Authentication failed"}))).into_response(),
    }
}
