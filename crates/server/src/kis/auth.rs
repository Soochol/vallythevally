use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use domain::{KstDate, KstTime, TimeOfDay};
use serde::{Deserialize, Serialize};

use super::error::{Category, Failure, judge_issue};
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
    IssueDisabled,
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
            AuthError::IssueDisabled => f.write_str("한투 토큰은 부모 데몬에서만 발급합니다"),
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
    supplied_credentials: Option<KisCredentials>,
    issued: Option<Issued>,
    last_request_at: Option<KstTime>,
    stale: bool,
    issued_count: u64,
    halt: Option<Halt>,
    disconnected: bool,
}

enum Mode {
    Managed {
        credentials: KisCredentials,
        credential_id: String,
        file: TokenFile,
        transport: Arc<dyn Transport>,
    },
    Supplied,
}

struct Inner {
    mode: Mode,
    clock: Clock,
    state: Mutex<State>,
    halted: watch::Sender<Option<Halt>>,
    issuing: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct KisAuth(Arc<Inner>);

impl fmt::Debug for KisAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let st = self.lock();
        let mut debug = f.debug_struct("KisAuth");
        match &self.0.mode {
            Mode::Managed { credentials, file, .. } => {
                debug.field("app_key", &credentials.app_key).field("file", &file.path());
            }
            Mode::Supplied => {
                debug.field("app_key", &st.supplied_credentials.as_ref().map(|credentials| &credentials.app_key)).field("supplied", &true);
            }
        }
        debug.field("token", &st.issued.as_ref().map(|i| &i.token)).field("halt", &st.halt).finish()
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
        let halted = watch::channel(state.halt.clone()).0;
        let mode = Mode::Managed { credentials, credential_id, file, transport };
        KisAuth(Arc::new(Inner { mode, clock, state: Mutex::new(state), halted, issuing: tokio::sync::Mutex::new(()) }))
    }

    pub fn supplied(clock: Clock) -> Self {
        let halted = watch::channel(None).0;
        KisAuth(Arc::new(Inner { mode: Mode::Supplied, clock, state: Mutex::new(State::default()), halted, issuing: tokio::sync::Mutex::new(()) }))
    }

    pub fn record_supplied(&self, credentials: KisCredentials, token: Secret<String>, generation: TokenGen, now: KstTime, expires_at: KstTime) {
        let mut st = self.lock();
        st.supplied_credentials = Some(credentials);
        st.issued_count = st.issued_count.max(generation.0);
        st.issued = Some(Issued { token, issued_at: now, expires_at, generation });
        st.stale = false;
    }

    pub fn needs_issue(&self) -> bool {
        matches!(self.usable(), Ok(None))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().expect("auth 잠금")
    }

    pub fn app_headers(&self) -> Vec<(&'static str, Secret<String>)> {
        match &self.0.mode {
            Mode::Managed { credentials, .. } => vec![("appkey", credentials.app_key.clone()), ("appsecret", credentials.app_secret.clone())],
            Mode::Supplied => match &self.lock().supplied_credentials {
                Some(credentials) => vec![("appkey", credentials.app_key.clone()), ("appsecret", credentials.app_secret.clone())],
                None => Vec::new(),
            },
        }
    }

    pub fn halted(&self) -> Option<Halt> {
        self.lock().halt.clone()
    }

    pub fn halt(&self, failure: Failure) {
        let mut st = self.lock();
        let halt = st.halt.get_or_insert(Halt::Rejected(failure)).clone();
        self.0.halted.send_replace(Some(halt));
    }

    pub fn watch_halted(&self) -> watch::Receiver<Option<Halt>> {
        self.0.halted.subscribe()
    }

    pub fn has_usable_token(&self) -> bool {
        matches!(self.usable(), Ok(Some(_)))
    }

    pub fn issue_blocked_until(&self) -> Option<KstTime> {
        let now = self.0.clock.now();
        let until = self.lock().last_request_at?.plus_secs(MIN_ISSUE_INTERVAL_SECS);
        (now < until).then_some(until)
    }

    pub fn app_key_tail(&self) -> Option<String> {
        let tail = |key: &str| (key.chars().count() >= 8).then(|| key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect());
        match &self.0.mode {
            Mode::Managed { credentials, .. } => tail(credentials.app_key.expose()),
            Mode::Supplied => self.lock().supplied_credentials.as_ref().and_then(|credentials| tail(credentials.app_key.expose())),
        }
    }

    pub fn credential_prefix(&self) -> String {
        let prefix = |id: &str| id.trim_start_matches("sha256:").chars().take(8).collect();
        match &self.0.mode {
            Mode::Managed { credential_id, .. } => prefix(credential_id),
            Mode::Supplied => self.lock().supplied_credentials.as_ref().map(|credentials| prefix(&credential_id(credentials.app_key.expose()))).unwrap_or_default(),
        }
    }

    pub fn kept_disconnected(&self) -> bool {
        self.lock().disconnected
    }

    pub fn keep_disconnected(&self) {
        self.record_disconnected(true);
    }

    pub fn clear_disconnected(&self) {
        self.record_disconnected(false);
    }

    fn record_disconnected(&self, kept: bool) {
        let mut st = self.lock();
        if st.disconnected == kept || matches!(st.halt, Some(Halt::TokenFileUnreadable(_))) {
            return;
        }
        st.disconnected = kept;
        if let Err(e) = self.save(&st) {
            tracing::warn!(error = %e, "끊어 둔 기록을 한투 토큰 파일에 쓰지 못했습니다");
            st.disconnected = !kept;
        }
    }

    pub fn due_daily_reissue(&self, now: KstTime, at: TimeOfDay) -> bool {
        let cutoff = KstTime::from_kst_civil(now.kst_date(), at);
        now >= cutoff && self.lock().issued.as_ref().is_some_and(|issued| issued.issued_at < cutoff)
    }

    pub async fn reissue(&self) -> Result<TokenLease, AuthError> {
        let _issuing = self.0.issuing.lock().await;
        self.issue().await
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
        let Mode::Managed { credentials, transport, .. } = &self.0.mode else {
            return Err(AuthError::IssueDisabled);
        };
        let now = self.0.clock.now();
        let body = self.begin_issue(credentials, now)?;
        let response = transport.send(self.credential_request(TOKEN_PATH, body)).await.map_err(AuthError::Transport)?;
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

    fn begin_issue(&self, credentials: &KisCredentials, now: KstTime) -> Result<Secret<String>, AuthError> {
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
        Ok(credential_body(credentials, Credential::Token))
    }

    fn credential_request(&self, path: &'static str, body: Secret<String>) -> HttpRequest {
        HttpRequest { method: Method::Post, path, headers: Vec::new(), query: Vec::new(), body: Some(body) }
    }

    fn refused(&self, failure: Failure, now: KstTime) -> AuthError {
        match failure.category() {
            Category::IssueLimited => AuthError::IssueInterval { retry_at: now.plus_secs(MIN_ISSUE_INTERVAL_SECS) },
            Category::AuthBlocked => {
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
        let Mode::Managed { credential_id, file, .. } = &self.0.mode else {
            return Ok(());
        };
        file.save(&Saved {
            credential: Some(credential_id.clone()),
            token: st.issued.as_ref().map(|issued| SavedToken { value: issued.token.expose().clone(), expires_at: issued.expires_at.unix(), issued_at: issued.issued_at.unix() }),
            last_request_at: st.last_request_at.map_or(0, KstTime::unix),
            disconnected: st.disconnected.then(|| credential_id.clone()),
        })
    }

    pub async fn approval_key(&self) -> Result<Secret<String>, AuthError> {
        let Mode::Managed { credentials, transport, .. } = &self.0.mode else {
            return Err(AuthError::IssueDisabled);
        };
        if let Some(halt) = self.halted() {
            return Err(AuthError::Halted(halt));
        }
        let now = self.0.clock.now();
        let body = credential_body(credentials, Credential::Approval);
        let response = transport.send(self.credential_request(APPROVAL_PATH, body)).await.map_err(AuthError::Transport)?;
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

fn credential_body(credentials: &KisCredentials, kind: Credential) -> Secret<String> {
    let app_key = credentials.app_key.expose();
    let app_secret = credentials.app_secret.expose();
    let body = match kind {
        Credential::Token => CredentialBody { grant_type: "client_credentials", appkey: app_key, appsecret: Some(app_secret), secretkey: None },
        Credential::Approval => CredentialBody { grant_type: "client_credentials", appkey: app_key, appsecret: None, secretkey: Some(app_secret) },
    };
    Secret::new(serde_json::to_string(&body).expect("문자열만 담은 구조체"))
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
            let disconnected = ours && saved.disconnected.as_deref() == Some(credential_id);
            State { issued_count: u64::from(issued.is_some()), issued, last_request_at: Some(saved.last_request_at).filter(|at| *at > 0).map(KstTime::from_unix), disconnected, ..State::default() }
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

    #[tokio::test]
    async fn supplied_auth_serves_recorded_token_and_refuses_issuing() {
        let start = KstTime::from_kst_civil(KstDate::new(2026, 11, 25).unwrap(), TimeOfDay::hms(9, 0, 0).unwrap());
        let clock = Clock::fake(start);
        let auth = KisAuth::supplied(clock.clone());

        assert!(auth.needs_issue());
        assert!(auth.app_headers().is_empty());
        assert_eq!(auth.token().await.err(), Some(AuthError::IssueDisabled));
        assert_eq!(auth.reissue().await.err(), Some(AuthError::IssueDisabled));
        assert_eq!(auth.approval_key().await.err(), Some(AuthError::IssueDisabled));
        assert_eq!(auth.halted(), None);

        let credentials = KisCredentials { app_key: Secret::new("FAKE-KIS-KEY-1234".to_owned()), app_secret: Secret::new("FAKE-KIS-SECRET-5678".to_owned()) };
        auth.record_supplied(credentials, Secret::new("FAKE-KIS-TOKEN-9999".to_owned()), TokenGen(3), start, start.plus_secs(3600));

        assert!(!auth.needs_issue());
        let lease = auth.token().await.unwrap();
        assert_eq!(lease.token.expose(), "FAKE-KIS-TOKEN-9999");
        assert_eq!(lease.generation, TokenGen(3));
        let headers: Vec<(&'static str, String)> = auth.app_headers().into_iter().map(|(name, value)| (name, value.expose().clone())).collect();
        assert_eq!(headers, vec![("appkey", "FAKE-KIS-KEY-1234".to_owned()), ("appsecret", "FAKE-KIS-SECRET-5678".to_owned())]);
        let debug = format!("{auth:?}");
        assert!(!debug.contains("FAKE-KIS-KEY-1234") && !debug.contains("FAKE-KIS-SECRET-5678") && !debug.contains("FAKE-KIS-TOKEN-9999"), "{debug}");

        assert_eq!(auth.reissue().await.err(), Some(AuthError::IssueDisabled));
        assert_eq!(auth.approval_key().await.err(), Some(AuthError::IssueDisabled));
        assert_eq!(auth.halted(), None);

        auth.invalidate(TokenGen(2));
        assert!(!auth.needs_issue());
        auth.invalidate(TokenGen(3));
        assert!(auth.needs_issue());
        assert_eq!(auth.token().await.err(), Some(AuthError::IssueDisabled));
        assert_eq!(auth.halted(), None);

        let next_credentials = KisCredentials { app_key: Secret::new("FAKE-KIS-KEY-1234".to_owned()), app_secret: Secret::new("FAKE-KIS-SECRET-5678".to_owned()) };
        auth.record_supplied(next_credentials, Secret::new("FAKE-KIS-TOKEN-NEXT".to_owned()), TokenGen(4), start, start.plus_secs(3600));
        assert!(!auth.needs_issue());
        clock.jump(3600 - EXPIRY_MARGIN_SECS + 1);
        assert!(auth.needs_issue());
        assert_eq!(auth.token().await.err(), Some(AuthError::IssueDisabled));
        assert_eq!(auth.halted(), None);
    }
}
