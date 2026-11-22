use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, TimeOfDay};
use serde::{Deserialize, Serialize};

use super::error::{Failure, Policy, judge_issue};
use super::token_file::{FileError, Saved, SavedToken, TokenFile, credential_id};
use super::transport::{HttpRequest, Method, Transport, TransportError};
use crate::clock::Clock;
use crate::config::{KisCredentials, Secret};

pub const MIN_ISSUE_INTERVAL_SECS: i64 = 10 * 60;
const EXPIRY_MARGIN_SECS: i64 = 10 * 60;
const TOKEN_PATH: &str = "/oauth2/tokenP";
const APPROVAL_PATH: &str = "/oauth2/Approval";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenGen(pub u64);

pub struct TokenLease {
    pub token: Secret<String>,
    pub generation: TokenGen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Halt {
    Rejected(Failure),
    TokenFileUnreadable(FileError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    Halted(Halt),
    IssueInterval { retry_at: KstTime },
    NotRecorded(FileError),
    Transport(TransportError),
    Failed(Failure),
    BadResponse,
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::Halted(Halt::Rejected(failure)) | AuthError::Failed(failure) => failure.fmt(f),
            AuthError::Halted(Halt::TokenFileUnreadable(e)) | AuthError::NotRecorded(e) => write!(f, "한투 토큰 파일: {e}"),
            AuthError::IssueInterval { .. } => f.write_str("한투 토큰 발급 간격(10분)이 지나지 않았습니다"),
            AuthError::Transport(e) => write!(f, "한투 인증 요청 실패: {e}"),
            AuthError::BadResponse => f.write_str("한투 인증 응답에서 값을 읽지 못했습니다"),
        }
    }
}

impl std::error::Error for AuthError {}

struct Issued {
    token: Secret<String>,
    issued_at: KstTime,
    expires_at: KstTime,
    generation: TokenGen,
}

#[derive(Default)]
struct State {
    issued: Option<Issued>,
    last_request_at: Option<KstTime>,
    stale: bool,
    issued_count: u64,
    halt: Option<Halt>,
}

struct Inner {
    credentials: KisCredentials,
    credential_id: String,
    file: TokenFile,
    transport: Arc<dyn Transport>,
    clock: Clock,
    state: Mutex<State>,
    issuing: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct KisAuth(Arc<Inner>);

impl fmt::Debug for KisAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let st = self.lock();
        f.debug_struct("KisAuth")
            .field("app_key", &self.0.credentials.app_key)
            .field("file", &self.0.file.path())
            .field("token", &st.issued.as_ref().map(|i| &i.token))
            .field("halt", &st.halt)
            .finish()
    }
}

#[derive(Serialize)]
struct CredentialBody<'a> {
    grant_type: &'static str,
    appkey: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    appsecret: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secretkey: Option<&'a str>,
}

#[derive(Deserialize)]
struct TokenBody {
    access_token: String,
    #[serde(default)]
    access_token_token_expired: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct ApprovalBody {
    approval_key: String,
}

impl KisAuth {
    pub fn new(credentials: KisCredentials, token_path: PathBuf, transport: Arc<dyn Transport>, clock: Clock) -> Self {
        let credential_id = credential_id(credentials.app_key.expose());
        let file = TokenFile::new(token_path);
        let state = loaded_state(&file, &credential_id);
        KisAuth(Arc::new(Inner { credentials, credential_id, file, transport, clock, state: Mutex::new(state), issuing: tokio::sync::Mutex::new(()) }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().expect("auth 잠금")
    }

    pub fn app_headers(&self) -> Vec<(&'static str, Secret<String>)> {
        vec![("appkey", self.0.credentials.app_key.clone()), ("appsecret", self.0.credentials.app_secret.clone())]
    }

    pub fn halted(&self) -> Option<Halt> {
        self.lock().halt.clone()
    }

    pub fn halt(&self, failure: Failure) {
        self.lock().halt.get_or_insert(Halt::Rejected(failure));
    }

    pub fn token_expires_at(&self) -> Option<KstTime> {
        self.lock().issued.as_ref().map(|issued| issued.expires_at)
    }

    pub fn invalidate(&self, seen: TokenGen) {
        let mut st = self.lock();
        if st.issued.as_ref().is_some_and(|issued| issued.generation == seen) {
            st.stale = true;
        }
    }

    fn usable(&self) -> Result<Option<TokenLease>, AuthError> {
        let st = self.lock();
        if let Some(halt) = &st.halt {
            return Err(AuthError::Halted(halt.clone()));
        }
        let now = self.0.clock.now();
        Ok(st
            .issued
            .as_ref()
            .filter(|issued| !st.stale && issued.expires_at.unix() - now.unix() >= EXPIRY_MARGIN_SECS)
            .map(|issued| TokenLease { token: issued.token.clone(), generation: issued.generation }))
    }

    pub async fn token(&self) -> Result<TokenLease, AuthError> {
        if let Some(lease) = self.usable()? {
            return Ok(lease);
        }
        let _issuing = self.0.issuing.lock().await;
        if let Some(lease) = self.usable()? {
            return Ok(lease);
        }
        self.issue().await
    }

    async fn issue(&self) -> Result<TokenLease, AuthError> {
        let now = self.0.clock.now();
        let body = self.begin_issue(now)?;
        let response = self.0.transport.send(self.credential_request(TOKEN_PATH, body)).await.map_err(AuthError::Transport)?;
        if let Some(failure) = judge_issue(response.status, &response.body) {
            return Err(self.refused(failure, now));
        }
        let parsed: TokenBody = serde_json::from_str(&response.body).map_err(|_| AuthError::BadResponse)?;
        let expires_at = parsed
            .access_token_token_expired
            .as_deref()
            .and_then(parse_kst_datetime)
            .or_else(|| parsed.expires_in.filter(|secs| *secs > 0).map(|secs| now.plus_secs(secs)))
            .ok_or(AuthError::BadResponse)?;
        if parsed.access_token.is_empty() {
            return Err(AuthError::BadResponse);
        }
        Ok(self.record_issued(parsed.access_token, now, expires_at))
    }

    fn begin_issue(&self, now: KstTime) -> Result<Secret<String>, AuthError> {
        let mut st = self.lock();
        if let Some(halt) = &st.halt {
            return Err(AuthError::Halted(halt.clone()));
        }
        if let Some(retry_at) = st.last_request_at.map(|at| at.plus_secs(MIN_ISSUE_INTERVAL_SECS)).filter(|until| now < *until) {
            return Err(AuthError::IssueInterval { retry_at });
        }
        let previous = st.last_request_at.replace(now);
        if let Err(e) = self.save(&st) {
            st.last_request_at = previous;
            return Err(AuthError::NotRecorded(e));
        }
        Ok(self.credential_body(Credential::Token))
    }

    fn credential_body(&self, kind: Credential) -> Secret<String> {
        let app_key = self.0.credentials.app_key.expose();
        let app_secret = self.0.credentials.app_secret.expose();
        let body = match kind {
            Credential::Token => CredentialBody { grant_type: "client_credentials", appkey: app_key, appsecret: Some(app_secret), secretkey: None },
            Credential::Approval => CredentialBody { grant_type: "client_credentials", appkey: app_key, appsecret: None, secretkey: Some(app_secret) },
        };
        Secret::new(serde_json::to_string(&body).expect("문자열만 담은 구조체"))
    }

    fn credential_request(&self, path: &'static str, body: Secret<String>) -> HttpRequest {
        HttpRequest { method: Method::Post, path, headers: Vec::new(), query: Vec::new(), body: Some(body) }
    }

    fn refused(&self, failure: Failure, now: KstTime) -> AuthError {
        match failure.policy() {
            Policy::WaitIssueInterval => AuthError::IssueInterval { retry_at: now.plus_secs(MIN_ISSUE_INTERVAL_SECS) },
            Policy::HaltAll | Policy::HaltPath => {
                self.halt(failure.clone());
                AuthError::Halted(Halt::Rejected(failure))
            }
            _ => AuthError::Failed(failure),
        }
    }

    fn record_issued(&self, token: String, now: KstTime, expires_at: KstTime) -> TokenLease {
        let mut st = self.lock();
        st.issued_count += 1;
        let generation = TokenGen(st.issued_count);
        let token = Secret::new(token);
        st.issued = Some(Issued { token: token.clone(), issued_at: now, expires_at, generation });
        st.stale = false;
        if let Err(e) = self.save(&st) {
            tracing::error!(error = %e, "받은 한투 토큰을 파일에 쓰지 못했습니다. 다시 켜면 발급 간격이 지난 뒤 새로 받습니다");
        }
        TokenLease { token, generation }
    }

    fn save(&self, st: &State) -> Result<(), FileError> {
        self.0.file.save(&Saved {
            credential: Some(self.0.credential_id.clone()),
            token: st.issued.as_ref().map(|issued| SavedToken { value: issued.token.expose().clone(), expires_at: issued.expires_at.unix(), issued_at: issued.issued_at.unix() }),
            last_request_at: st.last_request_at.map_or(0, KstTime::unix),
        })
    }

    pub async fn approval_key(&self) -> Result<Secret<String>, AuthError> {
        if let Some(halt) = self.halted() {
            return Err(AuthError::Halted(halt));
        }
        let now = self.0.clock.now();
        let body = self.credential_body(Credential::Approval);
        let response = self.0.transport.send(self.credential_request(APPROVAL_PATH, body)).await.map_err(AuthError::Transport)?;
        if let Some(failure) = judge_issue(response.status, &response.body) {
            return Err(self.refused(failure, now));
        }
        let parsed: ApprovalBody = serde_json::from_str(&response.body).map_err(|_| AuthError::BadResponse)?;
        if parsed.approval_key.is_empty() {
            return Err(AuthError::BadResponse);
        }
        Ok(Secret::new(parsed.approval_key))
    }
}

#[derive(Clone, Copy)]
enum Credential {
    Token,
    Approval,
}

fn loaded_state(file: &TokenFile, credential_id: &str) -> State {
    match file.load() {
        Ok(None) => State::default(),
        Ok(Some(saved)) => {
            let ours = saved.credential.as_deref() == Some(credential_id);
            if saved.token.is_some() && !ours {
                tracing::warn!("한투 토큰 파일의 토큰은 지금 앱키로 받은 것이 아니라 쓰지 않습니다. 발급 요청 간격은 그대로 지킵니다");
            }
            let issued = saved.token.filter(|_| ours).map(|t| Issued {
                token: Secret::new(t.value),
                issued_at: KstTime::from_unix(t.issued_at),
                expires_at: KstTime::from_unix(t.expires_at),
                generation: TokenGen(1),
            });
            State { issued_count: u64::from(issued.is_some()), issued, last_request_at: Some(saved.last_request_at).filter(|at| *at > 0).map(KstTime::from_unix), ..State::default() }
        }
        Err(e) => {
            tracing::error!(error = %e, "한투 토큰 파일을 읽지 못했습니다. 마지막 발급 요청 시각을 모르므로 토큰 발급을 멈춥니다");
            State { halt: Some(Halt::TokenFileUnreadable(e)), ..State::default() }
        }
    }
}

fn parse_kst_datetime(text: &str) -> Option<KstTime> {
    let (date, time) = text.split_once(' ')?;
    let mut date = date.split('-');
    let mut time = time.split(':');
    let date = KstDate::new(date.next()?.parse().ok()?, date.next()?.parse().ok()?, date.next()?.parse().ok()?)?;
    let time = TimeOfDay::hms(time.next()?.parse().ok()?, time.next()?.parse().ok()?, time.next()?.parse().ok()?)?;
    Some(KstTime::from_kst_civil(date, time))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kis_token_expiry_text_is_read_as_kst() {
        let expected = KstTime::from_kst_civil(KstDate::new(2026, 11, 23).unwrap(), TimeOfDay::hms(18, 30, 5).unwrap());
        assert_eq!(parse_kst_datetime("2026-11-23 18:30:05"), Some(expected));
        for bad in ["", "2026-11-23", "2026/11/23 18:30:05", "2026-13-23 18:30:05", "2026-11-23 25:00:00"] {
            assert_eq!(parse_kst_datetime(bad), None, "{bad}");
        }
    }
}
