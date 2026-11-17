//! 토큰의 단일 소유자(backend.md §4.1, ADR 0004). 발급 요청은 대기열이 보내고, 이 모듈은 상태와 규칙만 가진다.

use std::fmt;
use std::sync::Mutex;

use domain::{KstTime, TimeOfDay};
use serde::Serialize;
use tokio::sync::watch;

use super::error::{Category, CodeKey, Failure};
use super::token_file::{FileError, Saved, SavedAuthBlock, SavedToken, TokenFile, credential_id};
use super::wire::{TokenResponse, parse_kst_datetime};
use crate::config::Secret;

/// 토큰이 다시 발급될 때마다 1씩 는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenGen(pub u64);

/// 만료까지 이만큼도 안 남았으면 안전장치로 다시 발급한다.
const EXPIRY_MARGIN_SECS: i64 = 10 * 60;
/// 발급 요청 사이를 이만큼 띄운다. 반복 발급은 계정 단위 8050 잠금을 부른다(ADR 0004).
pub const MIN_ISSUE_INTERVAL_SECS: i64 = 10 * 60;
pub const DAILY_REISSUE_AT: TimeOfDay = match TimeOfDay::hms(20, 5, 0) {
    Some(t) => t,
    None => unreachable!(),
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Halt {
    Rejected(Failure),
    TokenFileUnreadable(FileError),
}

impl Halt {
    pub fn is_8050(&self) -> bool {
        matches!(self, Halt::Rejected(f) if f.detail() == Some(CodeKey::Rest(8050)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginIssueError {
    NoKey,
    File(FileError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    Halted(Halt),
    /// au10001 응답에 토큰이나 만료 시각이 없다.
    BadTokenResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSummary {
    pub app_key_tail: Option<String>,
    pub credential_prefix: String,
}

struct Issued {
    token: Secret<String>,
    issued_at: KstTime,
    expires_at: KstTime,
    generation: TokenGen,
}

struct Credentials {
    app_key: Secret<String>,
    app_secret: Secret<String>,
    id: String,
}

impl Credentials {
    fn new(app_key: Secret<String>, app_secret: Secret<String>) -> Self {
        let id = credential_id(app_key.expose());
        Credentials { app_key, app_secret, id }
    }
}

#[derive(Default)]
struct State {
    credentials: Option<Credentials>,
    issuing_for: Option<String>,
    issued: Option<Issued>,
    last_request_at: Option<KstTime>,
    /// 토큰 무효 응답을 받아 다시 발급해야 한다.
    stale: bool,
    issued_count: u64,
    disconnected: Option<String>,
    auth_block: Option<SavedAuthBlock>,
}

pub struct KiwoomAuth {
    file: Option<TokenFile>,
    state: Mutex<State>,
    halted: watch::Sender<Option<Halt>>,
}

impl fmt::Debug for KiwoomAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let st = self.state.lock().expect("auth 잠금");
        f.debug_struct("KiwoomAuth")
            .field("app_key", &st.credentials.as_ref().map(|c| &c.app_key))
            .field("app_secret", &st.credentials.as_ref().map(|c| &c.app_secret))
            .field("file", &self.file.as_ref().map(TokenFile::path))
            .field("generation", &st.issued.as_ref().map(|i| i.generation))
            .field("token", &st.issued.as_ref().map(|i| &i.token))
            .field("expires_at", &st.issued.as_ref().map(|i| i.expires_at))
            .field("last_request_at", &st.last_request_at)
            .field("stale", &st.stale)
            .field("halted", &*self.halted.borrow())
            .finish()
    }
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    grant_type: &'static str,
    appkey: &'a str,
    secretkey: &'a str,
}

impl KiwoomAuth {
    pub fn new(app_key: Secret<String>, app_secret: Secret<String>, file: Option<TokenFile>) -> Self {
        Self::with_credentials(Some(Credentials::new(app_key, app_secret)), file)
    }

    pub fn keyless(file: Option<TokenFile>) -> Self {
        Self::with_credentials(None, file)
    }

    fn with_credentials(credentials: Option<Credentials>, file: Option<TokenFile>) -> Self {
        let id = credentials.as_ref().map(|c| c.id.as_str());
        let (mut state, halt) = match file.as_ref().map(TokenFile::load) {
            None | Some(Ok(None)) => (State::default(), None),
            Some(Ok(Some(saved))) => {
                let state = restore(saved, id);
                let halt = restored_halt(&state, id);
                (state, halt)
            }
            Some(Err(e)) => {
                tracing::error!(error = %e, "토큰 파일을 읽지 못했습니다. 마지막 발급 요청 시각을 모르므로 조회와 토큰 발급을 멈춥니다");
                (State::default(), Some(Halt::TokenFileUnreadable(e)))
            }
        };
        state.credentials = credentials;
        KiwoomAuth { file, state: Mutex::new(state), halted: watch::channel(halt).0 }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("auth 잠금")
    }

    pub fn issue_is_for_current_key(&self) -> bool {
        let st = self.lock();
        st.issuing_for.is_none() || st.credentials.as_ref().map(|c| &c.id) == st.issuing_for.as_ref()
    }

    pub fn watch_halted(&self) -> watch::Receiver<Option<Halt>> {
        self.halted.subscribe()
    }

    pub fn credential_summary(&self) -> Option<CredentialSummary> {
        let st = self.lock();
        let credentials = st.credentials.as_ref()?;
        let key = credentials.app_key.expose();
        let app_key_tail = (key.chars().count() >= 8).then(|| key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect());
        let credential_prefix = credentials.id.trim_start_matches("sha256:").chars().take(8).collect();
        Some(CredentialSummary { app_key_tail, credential_prefix })
    }

    pub fn token_expires_at(&self) -> Option<KstTime> {
        self.lock().issued.as_ref().map(|i| i.expires_at)
    }

    pub fn has_credentials(&self) -> bool {
        self.lock().credentials.is_some()
    }

    fn save(&self, st: &State) -> Result<(), FileError> {
        let Some(file) = &self.file else { return Ok(()) };
        let saved = Saved {
            credential: st.credentials.as_ref().map(|c| c.id.clone()),
            token: st.issued.as_ref().map(|i| SavedToken {
                value: i.token.expose().clone(),
                expires_dt: format_kst_datetime(i.expires_at),
                issued_at: i.issued_at.unix(),
            }),
            last_request_at: st.last_request_at.map_or(0, KstTime::unix),
            disconnected: st.disconnected.clone(),
            auth_block: st.auth_block.clone(),
        };
        file.save(&saved)
    }

    fn save_records(&self, st: &State) -> Result<(), FileError> {
        let Some(file) = &self.file else { return Ok(()) };
        let mut saved = match file.load()? {
            Some(saved) => saved,
            None if st.disconnected.is_none() && st.auth_block.is_none() => return Ok(()),
            None => Saved { credential: st.credentials.as_ref().map(|c| c.id.clone()), ..Saved::default() },
        };
        saved.disconnected = st.disconnected.clone();
        saved.auth_block = st.auth_block.clone();
        file.save(&saved)
    }

    pub fn kept_disconnected(&self) -> bool {
        let st = self.lock();
        st.disconnected.is_some() && st.disconnected.as_deref() == st.credentials.as_ref().map(|c| c.id.as_str())
    }

    pub fn keep_disconnected(&self) {
        let mut st = self.lock();
        let Some(id) = st.credentials.as_ref().map(|c| c.id.clone()) else { return };
        let previous = st.disconnected.replace(id);
        if let Err(e) = self.save_records(&st) {
            tracing::warn!(error = %e, "끊어 둔 기록을 파일에 쓰지 못했습니다. 다시 켜면 자동으로 연결합니다");
            st.disconnected = previous;
        }
    }

    pub fn clear_connect_records(&self) {
        let mut st = self.lock();
        if st.disconnected.is_none() && st.auth_block.is_none() {
            return;
        }
        let previous = (st.disconnected.take(), st.auth_block.take());
        if let Err(e) = self.save_records(&st) {
            tracing::warn!(error = %e, "연결했으니 끊어 둔 기록과 인증 차단 기록을 지워야 하는데 파일에 쓰지 못했습니다");
            (st.disconnected, st.auth_block) = previous;
        }
    }

    pub fn replace_credentials(&self, app_key: Secret<String>, app_secret: Secret<String>) {
        let next = Credentials::new(app_key, app_secret);
        let mut st = self.lock();
        let same_key = st.credentials.as_ref().is_some_and(|c| c.id == next.id);
        if !same_key {
            st.issued = None;
            st.stale = false;
            let from_file = self.file.as_ref().and_then(|f| f.load().ok().flatten()).and_then(|saved| restore(saved, Some(&next.id)).issued);
            if let Some(mut issued) = from_file {
                st.issued_count += 1;
                issued.generation = TokenGen(st.issued_count);
                st.issued = Some(issued);
            }
        }
        st.credentials = Some(next);
        let released_block = st.auth_block.as_ref().is_some_and(|block| block.detail != CodeKey::Rest(8050));
        if released_block || st.disconnected.is_some() {
            if released_block {
                st.auth_block = None;
            }
            st.disconnected = None;
            if let Err(e) = self.save_records(&st) {
                tracing::warn!(error = %e, "키를 저장하면서 지울 끊어 둔 기록과 인증 차단 기록을 파일에서 지우지 못했습니다");
            }
        }
    }

    pub fn clear_credentials(&self) {
        let mut st = self.lock();
        st.credentials = None;
        st.issued = None;
        st.stale = false;
        st.disconnected = None;
        if matches!(self.halted(), Some(Halt::TokenFileUnreadable(_))) {
            return;
        }
        if let Err(e) = self.save(&st) {
            tracing::error!(error = %e, "토큰 파일에서 토큰을 비우지 못했습니다");
        }
    }

    pub fn release_key_rejection(&self) {
        self.halted.send_if_modified(|halt| {
            let release = matches!(halt, Some(h @ Halt::Rejected(_)) if !h.is_8050());
            if release {
                *halt = None;
            }
            release
        });
    }

    pub fn restore_halt(&self, halt: Halt) {
        self.halted.send_if_modified(|current| {
            let restore = current.is_none();
            if restore {
                *current = Some(halt);
            }
            restore
        });
    }

    pub fn release_8050(&self) {
        self.halted.send_if_modified(|halt| {
            let release = halt.as_ref().is_some_and(Halt::is_8050);
            if release {
                *halt = None;
            }
            release
        });
    }

    pub fn recheck_token_file(&self) -> Result<(), FileError> {
        let Some(file) = &self.file else { return Ok(()) };
        if !matches!(self.halted(), Some(Halt::TokenFileUnreadable(_))) {
            return Ok(());
        }
        match file.load() {
            Ok(saved) => {
                let mut st = self.lock();
                let id = st.credentials.as_ref().map(|c| c.id.clone());
                let restored = saved.map_or_else(State::default, |saved| restore(saved, id.as_deref()));
                st.issued = restored.issued;
                st.issued_count = restored.issued_count;
                st.last_request_at = restored.last_request_at;
                st.stale = false;
                st.disconnected = restored.disconnected;
                st.auth_block = restored.auth_block;
                let halt = restored_halt(&st, id.as_deref());
                drop(st);
                self.halted.send_replace(halt);
                Ok(())
            }
            Err(e) => {
                self.halted.send_replace(Some(Halt::TokenFileUnreadable(e.clone())));
                Err(e)
            }
        }
    }

    pub fn begin_issue(&self, now: KstTime) -> Result<Secret<String>, BeginIssueError> {
        let mut st = self.lock();
        let Some(credentials) = &st.credentials else { return Err(BeginIssueError::NoKey) };
        let req = TokenRequest {
            grant_type: "client_credentials",
            appkey: credentials.app_key.expose(),
            secretkey: credentials.app_secret.expose(),
        };
        let body = Secret::new(serde_json::to_string(&req).expect("문자열만 담은 구조체"));
        st.issuing_for = Some(credentials.id.clone());
        let previous = st.last_request_at.replace(now);
        if let Err(e) = self.save(&st) {
            st.last_request_at = previous;
            return Err(BeginIssueError::File(e));
        }
        Ok(body)
    }

    pub fn issue_blocked_until(&self, now: KstTime) -> Option<KstTime> {
        let until = self.lock().last_request_at?.plus_secs(MIN_ISSUE_INTERVAL_SECS);
        (now < until).then_some(until)
    }

    /// 지금 보낼 때 쓸 토큰. 무효로 표시됐거나 만료가 가까우면 없다.
    pub fn current(&self, now: KstTime) -> Option<(Secret<String>, TokenGen)> {
        let st = self.lock();
        if st.stale || self.halted.borrow().is_some() {
            return None;
        }
        let i = st.issued.as_ref()?;
        (i.expires_at.unix() - now.unix() >= EXPIRY_MARGIN_SECS).then(|| (i.token.clone(), i.generation))
    }

    pub fn issued_generation(&self) -> Option<TokenGen> {
        self.lock().issued.as_ref().map(|i| i.generation)
    }

    pub fn needs_issue(&self, now: KstTime) -> bool {
        self.halted().is_none() && self.current(now).is_none()
    }

    pub fn halted(&self) -> Option<Halt> {
        self.halted.borrow().clone()
    }

    pub fn halt(&self, failure: Failure, now: KstTime) {
        if failure.category() == Category::AuthBlocked {
            self.record_auth_block(&failure, now);
        }
        self.halted.send_replace(Some(Halt::Rejected(failure)));
    }

    fn record_auth_block(&self, failure: &Failure, now: KstTime) {
        let Some(detail) = failure.detail() else {
            tracing::error!("인증 차단에 상세 코드가 없어 파일에 남기지 못했습니다");
            return;
        };
        let mut st = self.lock();
        st.auth_block = Some(SavedAuthBlock { detail, credential: st.credentials.as_ref().map(|c| c.id.clone()), at: now.unix() });
        if let Err(e) = self.save_records(&st) {
            tracing::error!(error = %e, "인증 차단을 파일에 쓰지 못했습니다. 이 프로세스에서는 멈춘 채 두지만 다시 켜면 차단이 풀립니다");
        }
    }

    pub async fn until_halted(&self) -> Halt {
        let mut rx = self.halted.subscribe();
        let halt = rx.wait_for(Option::is_some).await.expect("보내는 쪽은 self가 쥐고 있다");
        halt.clone().expect("Some을 기다렸다")
    }

    pub fn record_issued(&self, resp: TokenResponse, now: KstTime) -> Result<TokenGen, AuthError> {
        let expires_at = parse_kst_datetime(&resp.expires_dt).ok_or(AuthError::BadTokenResponse)?;
        if resp.token.is_empty() {
            return Err(AuthError::BadTokenResponse);
        }
        let mut st = self.lock();
        let still_ours = st.issuing_for.is_none() || st.credentials.as_ref().map(|c| &c.id) == st.issuing_for.as_ref();
        if !still_ours {
            tracing::warn!("토큰을 받는 동안 앱키가 바뀌어 그 토큰은 쓰지 않습니다");
            return Ok(TokenGen(st.issued_count));
        }
        st.issued_count += 1;
        let generation = TokenGen(st.issued_count);
        st.issued = Some(Issued { token: Secret::new(resp.token), issued_at: now, expires_at, generation });
        st.stale = false;
        if let Err(e) = self.save(&st) {
            tracing::error!(error = %e, "받은 토큰을 파일에 쓰지 못했습니다. 다시 켜면 발급 간격이 지난 뒤 새로 받습니다");
        }
        Ok(generation)
    }

    pub fn invalidate(&self, seen: TokenGen) -> Result<(), AuthError> {
        if let Some(h) = self.halted() {
            return Err(AuthError::Halted(h));
        }
        let mut st = self.lock();
        if st.issued.as_ref().map(|i| i.generation) == Some(seen) {
            st.stale = true;
        }
        Ok(())
    }

    /// 매일 20:05: 지금 토큰이 그날 20:05 전에 발급된 것이면 다시 발급한다.
    pub fn due_daily_reissue(&self, now: KstTime) -> bool {
        let cutoff = KstTime::from_kst_civil(now.kst_date(), DAILY_REISSUE_AT);
        now >= cutoff && self.lock().issued.as_ref().is_none_or(|i| i.issued_at < cutoff)
    }
}

fn restore(saved: Saved, credential: Option<&str>) -> State {
    let ours = credential.is_some() && saved.credential.as_deref() == credential;
    if saved.token.is_some() && !ours {
        tracing::warn!("토큰 파일의 토큰은 지금 앱키로 받은 것이 아니라 쓰지 않습니다. 발급 요청 간격은 그대로 지킵니다");
    }
    let issued = saved.token.filter(|_| ours).and_then(|t| {
        let expires_at = parse_kst_datetime(&t.expires_dt);
        if expires_at.is_none() {
            tracing::warn!("토큰 파일의 만료 시각을 읽지 못해 토큰을 버립니다");
        }
        Some(Issued { token: Secret::new(t.value), issued_at: KstTime::from_unix(t.issued_at), expires_at: expires_at?, generation: TokenGen(1) })
    });
    State {
        issued_count: u64::from(issued.is_some()),
        issued,
        last_request_at: (saved.last_request_at > 0).then(|| KstTime::from_unix(saved.last_request_at)),
        disconnected: saved.disconnected,
        auth_block: saved.auth_block,
        ..State::default()
    }
}

fn restored_halt(state: &State, credential: Option<&str>) -> Option<Halt> {
    let block = state.auth_block.as_ref()?;
    let applies = block.detail == CodeKey::Rest(8050) || (credential.is_some() && block.credential.as_deref() == credential);
    if !applies {
        return None;
    }
    tracing::warn!(detail = %block.detail, "파일에 인증 차단 기록이 있어 차단된 채로 켭니다. 키움에는 아무것도 보내지 않습니다");
    Some(Halt::Rejected(Failure::restored_auth_block(block.detail)))
}

fn format_kst_datetime(t: KstTime) -> String {
    let secs = t.kst_time_of_day().secs();
    format!("{}{:02}{:02}{:02}", t.kst_date().yyyymmdd(), secs / 3600, secs / 60 % 60, secs % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::kst;
    use domain::KstDate;

    const KEY: &str = "FAKE-APPKEY-auth-3333";
    const SECRET: &str = "FAKE-SECRET-auth-4444";
    const TOKEN: &str = "FAKE-TOKEN-auth-5555";

    fn d(day: u8) -> KstDate {
        KstDate::new(2026, 11, day).unwrap()
    }

    fn auth() -> KiwoomAuth {
        KiwoomAuth::new(Secret::new(KEY.into()), Secret::new(SECRET.into()), None)
    }

    fn resp(token: &str, expires: &str) -> TokenResponse {
        TokenResponse { token: token.into(), expires_dt: expires.into() }
    }

    #[test]
    fn debug_has_no_secrets() {
        let a = auth();
        a.record_issued(resp(TOKEN, "20261110090000"), kst(d(9), 9, 0, 0)).unwrap();
        let dbg = format!("{a:?}");
        for s in [KEY, SECRET, TOKEN] {
            assert!(!dbg.contains(s), "{dbg}");
        }
        let body = a.begin_issue(kst(d(9), 9, 0, 0)).unwrap();
        assert!(body.expose().contains(KEY));
        assert_eq!(format!("{body:?}"), "[가림]");
    }

    #[test]
    fn issue_body_shape() {
        let v: serde_json::Value = serde_json::from_str(auth().begin_issue(kst(d(9), 9, 0, 0)).unwrap().expose()).unwrap();
        assert_eq!(v, serde_json::json!({"grant_type": "client_credentials", "appkey": KEY, "secretkey": SECRET}));
    }

    #[test]
    fn expiry_margin_and_generations() {
        let a = auth();
        let now = kst(d(9), 9, 0, 0);
        assert!(a.needs_issue(now));
        let g1 = a.record_issued(resp(TOKEN, "20261110090000"), now).unwrap();
        assert_eq!(a.current(now).unwrap().1, g1);
        assert!(a.current(kst(d(10), 8, 50, 0)).is_some());
        assert!(a.current(kst(d(10), 8, 50, 1)).is_none(), "만료 10분 전부터는 다시 발급");
        let g2 = a.record_issued(resp("t2", "20261110090000"), now).unwrap();
        assert!(g2 > g1);
        assert!(a.record_issued(resp("", "20261110090000"), now).is_err());
        assert!(a.record_issued(resp("t", "bad"), now).is_err());
    }

    #[test]
    fn invalidate_only_marks_the_seen_generation() {
        let a = auth();
        let t0 = kst(d(9), 9, 0, 0);
        let g1 = a.record_issued(resp(TOKEN, "20261110090000"), t0).unwrap();
        a.invalidate(g1).unwrap();
        assert!(a.current(t0).is_none());
        let g2 = a.record_issued(resp("t2", "20261110090000"), t0).unwrap();
        a.invalidate(g1).unwrap();
        assert_eq!(a.current(t0).unwrap().1, g2, "옛 세대의 무효는 새 토큰을 건드리지 않는다");
        let rejected = crate::kiwoom::error::judge(crate::kiwoom::api::ApiId::Ka10081, 200, r#"{"return_code": 3, "return_msg": "[8001:앱키]"}"#).unwrap_err();
        a.halt(rejected.clone(), t0);
        assert!(!a.needs_issue(t0) && a.current(t0).is_none());
        assert_eq!(a.invalidate(g2), Err(AuthError::Halted(Halt::Rejected(rejected))));
    }

    #[test]
    fn issue_requests_are_ten_minutes_apart() {
        let a = auth();
        let t0 = kst(d(9), 9, 0, 0);
        assert_eq!(a.issue_blocked_until(t0), None);
        a.begin_issue(t0).unwrap();
        assert_eq!(a.issue_blocked_until(t0.plus_secs(599)), Some(t0.plus_secs(600)), "실패한 요청도 센다");
        assert_eq!(a.issue_blocked_until(t0.plus_secs(600)), None);
    }

    #[test]
    fn a_restart_keeps_the_token_and_the_last_request_time() {
        let (_dir, lock, file) = crate::kiwoom::token_file::testing::temp_token_file();
        let path = file.path().to_owned();
        let t0 = kst(d(9), 9, 0, 0);
        let first = KiwoomAuth::new(Secret::new(KEY.into()), Secret::new(SECRET.into()), Some(file));
        first.begin_issue(t0).unwrap();
        first.record_issued(resp(TOKEN, "20261110090000"), t0.plus_secs(1)).unwrap();
        drop(first);

        let again = KiwoomAuth::new(Secret::new(KEY.into()), Secret::new(SECRET.into()), Some(TokenFile::new(path, &lock)));
        let later = t0.plus_secs(300);
        assert_eq!(again.current(later).map(|(t, g)| (t.expose().clone(), g)), Some((TOKEN.to_owned(), TokenGen(1))));
        assert!(!again.needs_issue(later));
        assert_eq!(again.issue_blocked_until(later), Some(t0.plus_secs(600)));
        assert!(again.current(kst(d(10), 8, 50, 1)).is_none(), "파일의 만료 시각을 따른다");
        assert!(!again.due_daily_reissue(kst(d(9), 20, 4, 0)) && again.due_daily_reissue(kst(d(9), 20, 5, 0)), "발급 시각도 이어진다");
    }

    #[test]
    fn daily_reissue_after_2005_only_for_older_tokens() {
        let a = auth();
        a.record_issued(resp(TOKEN, "20261110090000"), kst(d(9), 9, 0, 0)).unwrap();
        assert!(!a.due_daily_reissue(kst(d(9), 20, 4, 59)));
        assert!(a.due_daily_reissue(kst(d(9), 20, 5, 0)));
        a.record_issued(resp("t2", "20261110200500"), kst(d(9), 20, 5, 1)).unwrap();
        assert!(!a.due_daily_reissue(kst(d(9), 20, 15, 0)));
        assert!(a.due_daily_reissue(kst(d(10), 20, 5, 0)));
    }

    #[test]
    fn a_keyless_auth_keeps_the_request_time_and_cannot_issue() {
        let (_dir, _lock, file) = crate::kiwoom::token_file::testing::temp_token_file();
        let t0 = kst(d(9), 9, 0, 0);
        file.save(&Saved { credential: Some(credential_id(KEY)), last_request_at: t0.unix(), ..Saved::default() }).unwrap();
        let a = KiwoomAuth::keyless(Some(file));
        assert!(!a.has_credentials());
        assert_eq!(a.issue_blocked_until(t0.plus_secs(60)), Some(t0.plus_secs(600)));
        assert_eq!(a.begin_issue(t0.plus_secs(60)).unwrap_err(), BeginIssueError::NoKey);
    }

    #[test]
    fn replacing_the_key_drops_the_old_token_and_keeps_the_request_time() {
        let (_dir, _lock, file) = crate::kiwoom::token_file::testing::temp_token_file();
        let a = KiwoomAuth::new(Secret::new(KEY.into()), Secret::new(SECRET.into()), Some(file));
        let t0 = kst(d(9), 9, 0, 0);
        a.begin_issue(t0).unwrap();
        a.record_issued(resp(TOKEN, "20991231000000"), t0).unwrap();
        assert!(a.current(t0).is_some());
        a.replace_credentials(Secret::new("FAKE-APPKEY-other".into()), Secret::new("other-secret".into()));
        assert!(a.current(t0).is_none(), "앱키가 바뀌면 이전 토큰은 쓰지 않는다");
        assert_eq!(a.issue_blocked_until(t0.plus_secs(60)), Some(t0.plus_secs(600)));
        let body: serde_json::Value = serde_json::from_str(a.begin_issue(t0.plus_secs(700)).unwrap().expose()).unwrap();
        assert_eq!(body["appkey"], "FAKE-APPKEY-other");
        a.clear_credentials();
        assert!(!a.has_credentials() && a.current(t0).is_none());
        assert_eq!(a.issue_blocked_until(t0.plus_secs(710)), Some(t0.plus_secs(1300)));
    }

    #[test]
    fn a_token_from_another_or_unknown_app_key_is_dropped_but_its_request_time_is_kept() {
        let t0 = kst(d(9), 9, 0, 0);
        for credential in [Some(credential_id("FAKE-APPKEY-other")), None] {
            let (_dir, _lock, file) = crate::kiwoom::token_file::testing::temp_token_file();
            let token = SavedToken { value: TOKEN.into(), expires_dt: "20991231000000".into(), issued_at: t0.unix() };
            file.save(&Saved { credential: credential.clone(), token: Some(token), last_request_at: t0.unix(), ..Saved::default() }).unwrap();
            let a = KiwoomAuth::new(Secret::new(KEY.into()), Secret::new(SECRET.into()), Some(file));
            let later = t0.plus_secs(60);
            assert!(a.current(later).is_none(), "{credential:?}");
            assert_eq!(a.issue_blocked_until(later), Some(t0.plus_secs(600)), "{credential:?}");
        }
    }
}
