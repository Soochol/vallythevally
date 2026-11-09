//! 토큰의 단일 소유자(backend.md §4.1, ADR 0004). 발급 요청은 대기열이 보내고, 이 모듈은 상태와 규칙만 가진다.

use std::fmt;
use std::sync::Mutex;

use domain::{KstTime, TimeOfDay};
use serde::Serialize;

use super::wire::{TokenResponse, parse_kst_datetime};
use crate::config::Secret;

/// 토큰이 다시 발급될 때마다 1씩 는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenGen(pub u64);

/// 만료까지 이만큼도 안 남았으면 안전장치로 다시 발급한다.
const EXPIRY_MARGIN_SECS: i64 = 10 * 60;
/// 토큰 무효 응답으로 다시 발급하는 것은 이 간격 안에 한 번뿐이다.
const INVALIDATE_COOLDOWN_SECS: i64 = 5 * 60;
pub const DAILY_REISSUE_AT: TimeOfDay = match TimeOfDay::hms(20, 5, 0) {
    Some(t) => t,
    None => unreachable!(),
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// 앱키·IP 같은 되돌릴 수 없는 인증 실패(8001~8200 중 8005 밖). 서버를 다시 켜야 한다.
    Halted { detail: u16 },
    /// 5분 안에 두 번째로 토큰 무효를 받았다.
    InvalidAgain,
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
    /// 토큰 무효 응답을 받아 다시 발급해야 한다.
    stale: bool,
    last_invalidate: Option<KstTime>,
    halted: Option<u16>,
    issued_count: u64,
}

pub struct KiwoomAuth {
    app_key: Secret<String>,
    app_secret: Secret<String>,
    state: Mutex<State>,
}

impl fmt::Debug for KiwoomAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let st = self.state.lock().expect("auth 잠금");
        f.debug_struct("KiwoomAuth")
            .field("app_key", &self.app_key)
            .field("app_secret", &self.app_secret)
            .field("generation", &st.issued.as_ref().map(|i| i.generation))
            .field("token", &st.issued.as_ref().map(|i| &i.token))
            .field("expires_at", &st.issued.as_ref().map(|i| i.expires_at))
            .field("stale", &st.stale)
            .field("halted", &st.halted)
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
    pub fn new(app_key: Secret<String>, app_secret: Secret<String>) -> Self {
        KiwoomAuth { app_key, app_secret, state: Mutex::new(State::default()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("auth 잠금")
    }

    /// au10001 본문. 앱키와 시크릿이 들어 있으므로 `Secret`으로만 내보낸다.
    pub fn issue_body(&self) -> Secret<String> {
        let req = TokenRequest {
            grant_type: "client_credentials",
            appkey: self.app_key.expose(),
            secretkey: self.app_secret.expose(),
        };
        Secret::new(serde_json::to_string(&req).expect("문자열만 담은 구조체"))
    }

    /// 지금 보낼 때 쓸 토큰. 무효로 표시됐거나 만료가 가까우면 없다.
    pub fn current(&self, now: KstTime) -> Option<(Secret<String>, TokenGen)> {
        let st = self.lock();
        if st.stale || st.halted.is_some() {
            return None;
        }
        let i = st.issued.as_ref()?;
        (i.expires_at.unix() - now.unix() >= EXPIRY_MARGIN_SECS).then(|| (i.token.clone(), i.generation))
    }

    pub fn needs_issue(&self, now: KstTime) -> bool {
        self.halted().is_none() && self.current(now).is_none()
    }

    pub fn halted(&self) -> Option<u16> {
        self.lock().halted
    }

    pub fn halt(&self, detail: u16) {
        self.lock().halted = Some(detail);
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
        Ok(generation)
    }

    /// 토큰 무효 응답을 받았을 때만 부른다. `seen`이 지금 세대일 때만 다시 발급하도록 표시한다.
    /// 이미 새 세대가 있으면 그대로 다시 보내면 된다.
    pub fn invalidate(&self, seen: TokenGen, now: KstTime) -> Result<(), AuthError> {
        let mut st = self.lock();
        if let Some(d) = st.halted {
            return Err(AuthError::Halted { detail: d });
        }
        let current = st.issued.as_ref().map(|i| i.generation);
        if current != Some(seen) {
            return Ok(());
        }
        if st.last_invalidate.is_some_and(|t| now.unix() - t.unix() < INVALIDATE_COOLDOWN_SECS) {
            return Err(AuthError::InvalidAgain);
        }
        st.last_invalidate = Some(now);
        st.stale = true;
        Ok(())
    }

    /// 매일 20:05: 지금 토큰이 그날 20:05 전에 발급된 것이면 다시 발급한다.
    pub fn due_daily_reissue(&self, now: KstTime) -> bool {
        let cutoff = KstTime::from_kst_civil(now.kst_date(), DAILY_REISSUE_AT);
        now >= cutoff && self.lock().issued.as_ref().is_none_or(|i| i.issued_at < cutoff)
    }
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
        KiwoomAuth::new(Secret::new(KEY.into()), Secret::new(SECRET.into()))
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
        assert!(a.issue_body().expose().contains(KEY));
        assert_eq!(format!("{:?}", a.issue_body()), "[가림]");
    }

    #[test]
    fn issue_body_shape() {
        let v: serde_json::Value = serde_json::from_str(auth().issue_body().expose()).unwrap();
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
    fn invalidate_only_once_per_five_minutes_and_only_for_the_seen_generation() {
        let a = auth();
        let t0 = kst(d(9), 9, 0, 0);
        let g1 = a.record_issued(resp(TOKEN, "20261110090000"), t0).unwrap();
        a.invalidate(g1, t0).unwrap();
        assert!(a.current(t0).is_none());
        let g2 = a.record_issued(resp("t2", "20261110090000"), t0).unwrap();
        a.invalidate(g1, t0).unwrap();
        assert_eq!(a.current(t0).unwrap().1, g2, "옛 세대의 무효는 새 토큰을 건드리지 않는다");
        assert_eq!(a.invalidate(g2, t0.plus_secs(299)), Err(AuthError::InvalidAgain));
        a.invalidate(g2, t0.plus_secs(300)).unwrap();
        a.halt(8001);
        assert!(!a.needs_issue(t0) && a.current(t0).is_none());
        assert_eq!(a.invalidate(g2, t0), Err(AuthError::Halted { detail: 8001 }));
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
}
