//! 토큰의 단일 소유자(backend.md §4.1, ADR 0004). 발급 요청은 대기열이 보내고, 이 모듈은 상태와 규칙만 가진다.

use std::fmt;
use std::sync::Mutex;

use domain::{KstTime, TimeOfDay};
use serde::Serialize;
use tokio::sync::watch;

use super::token_file::{FileError, Saved, SavedToken, TokenFile, credential_id};
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

pub fn auth_failed_message(detail: Option<u16>) -> String {
    match detail {
        Some(8050) => "키움이 지정단말기 인증 실패([8050])로 거절했습니다. 키움 IP 미등록 또는 반복 발급 잠금입니다. \
                       지금 공인 IP를 키움 포털에 등록하세요. 반복 발급 잠금이면 포털에서 해제됐는지 확인하세요. \
                       조회와 토큰 발급을 모두 멈췄습니다. 고친 뒤 서버를 다시 켜야 합니다"
            .into(),
        Some(d) => format!("키움 인증에 실패했습니다([{d}]). 조회와 토큰 발급을 모두 멈췄습니다. 운영자가 설정을 고치고 서버를 다시 켜야 합니다"),
        None => "키움 인증에 실패했습니다. 운영자가 설정을 확인해야 합니다".into(),
    }
}

/// 서버를 다시 켜야 풀린다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Halt {
    Rejected(u16),
    TokenFileUnreadable(FileError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    Halted(Halt),
    /// au10001 응답에 토큰이나 만료 시각이 없다.
    BadTokenResponse,
}

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
    /// 토큰 무효 응답을 받아 다시 발급해야 한다.
    stale: bool,
    issued_count: u64,
}

pub struct KiwoomAuth {
    app_key: Secret<String>,
    app_secret: Secret<String>,
    credential: String,
    file: Option<TokenFile>,
    state: Mutex<State>,
    halted: watch::Sender<Option<Halt>>,
}

impl fmt::Debug for KiwoomAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let st = self.state.lock().expect("auth 잠금");
        f.debug_struct("KiwoomAuth")
            .field("app_key", &self.app_key)
            .field("app_secret", &self.app_secret)
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
        let credential = credential_id(app_key.expose());
        let (state, halt) = match file.as_ref().map(TokenFile::load) {
            None | Some(Ok(None)) => (State::default(), None),
            Some(Ok(Some(saved))) => (restore(saved, &credential), None),
            Some(Err(e)) => {
                tracing::error!(error = %e, "토큰 파일을 읽지 못했습니다. 마지막 발급 요청 시각을 모르므로 조회와 토큰 발급을 멈춥니다");
                (State::default(), Some(Halt::TokenFileUnreadable(e)))
            }
        };
        KiwoomAuth { app_key, app_secret, credential, file, state: Mutex::new(state), halted: watch::channel(halt).0 }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("auth 잠금")
    }

    fn save(&self, st: &State) -> Result<(), FileError> {
        let Some(file) = &self.file else { return Ok(()) };
        let saved = Saved {
            credential: Some(self.credential.clone()),
            token: st.issued.as_ref().map(|i| SavedToken {
                value: i.token.expose().clone(),
                expires_dt: format_kst_datetime(i.expires_at),
                issued_at: i.issued_at.unix(),
            }),
            last_request_at: st.last_request_at.map_or(0, KstTime::unix),
        };
        file.save(&saved)
    }

    /// 발급 요청 시각을 파일에 남기지 못하면 본문을 내주지 않는다. 다시 켠 서버가 그 시각을 알아야 10분을 지킨다.
    pub fn begin_issue(&self, now: KstTime) -> Result<Secret<String>, FileError> {
        let mut st = self.lock();
        let previous = st.last_request_at.replace(now);
        if let Err(e) = self.save(&st) {
            st.last_request_at = previous;
            return Err(e);
        }
        let req = TokenRequest {
            grant_type: "client_credentials",
            appkey: self.app_key.expose(),
            secretkey: self.app_secret.expose(),
        };
        Ok(Secret::new(serde_json::to_string(&req).expect("문자열만 담은 구조체")))
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

    pub fn needs_issue(&self, now: KstTime) -> bool {
        self.halted().is_none() && self.current(now).is_none()
    }

    pub fn halted(&self) -> Option<Halt> {
        self.halted.borrow().clone()
    }

    pub fn halt(&self, detail: u16) {
        self.halted.send_replace(Some(Halt::Rejected(detail)));
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

fn restore(saved: Saved, credential: &str) -> State {
    let ours = saved.credential.as_deref() == Some(credential);
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
        ..State::default()
    }
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
        a.halt(8001);
        assert!(!a.needs_issue(t0) && a.current(t0).is_none());
        assert_eq!(a.invalidate(g2), Err(AuthError::Halted(Halt::Rejected(8001))));
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
    fn a_token_from_another_or_unknown_app_key_is_dropped_but_its_request_time_is_kept() {
        let t0 = kst(d(9), 9, 0, 0);
        for credential in [Some(credential_id("FAKE-APPKEY-other")), None] {
            let (_dir, _lock, file) = crate::kiwoom::token_file::testing::temp_token_file();
            let token = SavedToken { value: TOKEN.into(), expires_dt: "20991231000000".into(), issued_at: t0.unix() };
            file.save(&Saved { credential: credential.clone(), token: Some(token), last_request_at: t0.unix() }).unwrap();
            let a = KiwoomAuth::new(Secret::new(KEY.into()), Secret::new(SECRET.into()), Some(file));
            let later = t0.plus_secs(60);
            assert!(a.current(later).is_none(), "{credential:?}");
            assert_eq!(a.issue_blocked_until(later), Some(t0.plus_secs(600)), "{credential:?}");
        }
    }
}
