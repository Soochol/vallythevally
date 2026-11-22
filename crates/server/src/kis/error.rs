use std::fmt;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    RateLimited,
    TokenInvalid,
    IssueLimited,
    AuthBlocked,
    BusinessRejected,
    Unknown,
    SeatsExceeded,
    InUseElsewhere,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    RetryAtWindowEnd,
    ReissueOnce,
    WaitIssueInterval,
    HaltAll,
    FailRequest,
    HaltPath,
    FailRegistration,
    CloseSession,
}

const POLICY_TABLE: [(Category, Policy); 8] = [
    (Category::RateLimited, Policy::RetryAtWindowEnd),
    (Category::TokenInvalid, Policy::ReissueOnce),
    (Category::IssueLimited, Policy::WaitIssueInterval),
    (Category::AuthBlocked, Policy::HaltAll),
    (Category::BusinessRejected, Policy::FailRequest),
    (Category::Unknown, Policy::HaltPath),
    (Category::SeatsExceeded, Policy::FailRegistration),
    (Category::InUseElsewhere, Policy::CloseSession),
];

const CODE_TABLE: [(&str, Category); 6] = [
    ("EGW00201", Category::RateLimited),
    ("EGW00121", Category::TokenInvalid),
    ("EGW00123", Category::TokenInvalid),
    ("EGW00133", Category::IssueLimited),
    ("OPSP0008", Category::SeatsExceeded),
    ("OPSP8996", Category::InUseElsewhere),
];

pub const CONTROL_SUCCESS_CODE: &str = "OPSP0000";
const MAX_CODE_LEN: usize = 16;

impl Category {
    pub fn policy(self) -> Policy {
        POLICY_TABLE.iter().find(|(category, _)| *category == self).map(|&(_, policy)| policy).expect("모든 범주가 표에 있다")
    }

    pub fn meaning(self) -> &'static str {
        match self {
            Category::RateLimited => "초당 거래건수 초과",
            Category::TokenInvalid => "접근토큰이 유효하지 않거나 만료됨",
            Category::IssueLimited => "접근토큰 발급 간격 제한",
            Category::AuthBlocked => "인증이 거절됨",
            Category::BusinessRejected => "업무 거절",
            Category::Unknown => "알 수 없는 응답",
            Category::SeatsExceeded => "실시간 등록 자리 초과",
            Category::InUseElsewhere => "다른 곳에서 이 앱키로 실시간을 사용 중",
        }
    }

    pub fn of_code(code: &str) -> Option<Category> {
        CODE_TABLE.iter().find(|(known, _)| *known == code).map(|&(_, category)| category)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    category: Category,
    status: Option<u16>,
    code: Option<String>,
}

impl Failure {
    pub fn category(&self) -> Category {
        self.category
    }

    pub fn policy(&self) -> Policy {
        self.category.policy()
    }

    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }

    pub fn status(&self) -> Option<u16> {
        self.status
    }

    fn new(category: Category, status: Option<u16>, code: Option<String>) -> Self {
        Failure { category, status, code }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "한투 응답 거절: {}", self.category.meaning())?;
        match (self.status, &self.code) {
            (Some(status), Some(code)) => write!(f, "(HTTP {status}, 코드 {code})"),
            (Some(status), None) => write!(f, "(HTTP {status})"),
            (None, Some(code)) => write!(f, "(코드 {code})"),
            (None, None) => Ok(()),
        }
    }
}

impl std::error::Error for Failure {}

#[derive(Deserialize, Default)]
struct Envelope {
    #[serde(default)]
    rt_cd: Option<String>,
    #[serde(default)]
    msg_cd: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
}

impl Envelope {
    fn parse(body: &str) -> Envelope {
        serde_json::from_str(body).unwrap_or_default()
    }

    fn code(&self) -> Option<String> {
        self.error_code.as_deref().or(self.msg_cd.as_deref()).filter(|code| is_code(code)).map(str::to_owned)
    }
}

fn is_code(code: &str) -> bool {
    !code.is_empty() && code.len() <= MAX_CODE_LEN && code.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn judge_market(status: u16, body: &str) -> Option<Failure> {
    let envelope = Envelope::parse(body);
    let succeeded = status == 200 && envelope.rt_cd.as_deref() == Some("0");
    if succeeded {
        return None;
    }
    let code = envelope.code();
    let category = match code.as_deref().and_then(Category::of_code) {
        Some(category) => category,
        None if status == 200 && envelope.rt_cd.is_some() => Category::BusinessRejected,
        None => Category::Unknown,
    };
    Some(Failure::new(category, Some(status), code))
}

pub fn judge_issue(status: u16, body: &str) -> Option<Failure> {
    let envelope = Envelope::parse(body);
    let code = envelope.code();
    let known = code.as_deref().and_then(Category::of_code);
    if status == 200 && known.is_none() && envelope.error_code.is_none() {
        return None;
    }
    let category = match known {
        Some(category) => category,
        None if (400..500).contains(&status) => Category::AuthBlocked,
        None => Category::Unknown,
    };
    Some(Failure::new(category, Some(status), code))
}

pub fn judge_control(rt_cd: &str, msg_cd: &str) -> Option<Failure> {
    if rt_cd == "0" {
        return None;
    }
    let code = Some(msg_cd).filter(|code| is_code(code)).map(str::to_owned);
    let category = code.as_deref().and_then(Category::of_code).unwrap_or(Category::Unknown);
    Some(Failure::new(category, None, code))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Category; 8] = [
        Category::RateLimited,
        Category::TokenInvalid,
        Category::IssueLimited,
        Category::AuthBlocked,
        Category::BusinessRejected,
        Category::Unknown,
        Category::SeatsExceeded,
        Category::InUseElsewhere,
    ];

    #[test]
    fn every_category_has_one_policy() {
        for category in ALL {
            assert_eq!(POLICY_TABLE.iter().filter(|(c, _)| *c == category).count(), 1, "{category:?}");
            category.policy();
        }
        assert_eq!(POLICY_TABLE.len(), ALL.len());
    }

    #[test]
    fn known_codes_map_to_their_category_whatever_the_http_status() {
        let body = |code: &str| format!(r#"{{"rt_cd":"1","msg_cd":"{code}","msg1":"FAKE-MESSAGE"}}"#);
        for (code, category) in CODE_TABLE {
            for status in [200, 403, 500] {
                let failure = judge_market(status, &body(code)).unwrap();
                assert_eq!((failure.category(), failure.code()), (category, Some(code)), "{code} {status}");
            }
        }
    }

    #[test]
    fn a_successful_market_response_is_not_a_failure() {
        assert!(judge_market(200, r#"{"rt_cd":"0","msg_cd":"MCA00000","msg1":"정상처리 되었습니다.","output":{}}"#).is_none());
    }

    #[test]
    fn an_unlisted_code_is_a_business_rejection_only_when_the_envelope_says_so() {
        let rejected = judge_market(200, r#"{"rt_cd":"1","msg_cd":"APBK0919","msg1":"x"}"#).unwrap();
        assert_eq!(rejected.category(), Category::BusinessRejected);
        for (status, body) in [(500, r#"{"rt_cd":"1","msg_cd":"APBK0919"}"#), (200, "not json"), (200, r#"{"output":{}}"#), (502, "")] {
            assert_eq!(judge_market(status, body).unwrap().category(), Category::Unknown, "{status} {body}");
        }
    }

    #[test]
    fn a_code_that_could_carry_a_secret_is_not_kept() {
        let failure = judge_market(200, r#"{"rt_cd":"1","msg_cd":"FAKE-SECRET-should-not-appear-in-any-message","msg1":"x"}"#).unwrap();
        assert_eq!(failure.code(), None);
        assert!(!failure.to_string().contains("FAKE-"), "{failure}");
    }

    #[test]
    fn issue_failures_follow_the_table_and_otherwise_a_4xx_blocks_the_key() {
        let issue_limited = judge_issue(403, r#"{"error_description":"x","error_code":"EGW00133"}"#).unwrap();
        assert_eq!(issue_limited.category(), Category::IssueLimited);
        let blocked = judge_issue(403, r#"{"error_description":"x","error_code":"EGW00999"}"#).unwrap();
        assert_eq!(blocked.category(), Category::AuthBlocked);
        assert_eq!(judge_issue(500, "").unwrap().category(), Category::Unknown);
        assert!(judge_issue(200, r#"{"access_token":"FAKE-TOKEN","expires_in":86400}"#).is_none());
    }

    #[test]
    fn control_rejections_follow_the_table() {
        assert!(judge_control("0", CONTROL_SUCCESS_CODE).is_none());
        assert_eq!(judge_control("9", "OPSP8996").unwrap().category(), Category::InUseElsewhere);
        assert_eq!(judge_control("9", "OPSP0008").unwrap().category(), Category::SeatsExceeded);
        assert_eq!(judge_control("9", "OPSQ2000").unwrap().category(), Category::Unknown);
    }
}
