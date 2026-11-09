//! 키움 응답을 닫힌 범주로 바꾸는 한 곳과, 범주마다의 대응 정책 표(ADR 0009, docs/design/kiwoom-errors-proposal.md §2·§5).

use std::fmt;

use serde_json::Value;

use super::api::ApiId;
use super::transport::TransportError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodeKey {
    /// REST `return_msg`의 `[NNNN:…]`·`[NNNN]`.
    Rest(u16),
    /// WebSocket LOGIN·REG·REMOVE ACK의 `return_code`.
    WsControl(u32),
    WsClose(u16),
}

impl fmt::Display for CodeKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodeKey::Rest(c) => write!(f, "[{c}]"),
            CodeKey::WsControl(c) => write!(f, "WS {c}"),
            CodeKey::WsClose(c) => write!(f, "close {c}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    RateLimit,
    TokenInvalid,
    AuthBlocked,
    AuthIndeterminate,
    InvalidRequest,
    SymbolMismatch,
    BatchLimit,
    Unsupported,
    Transient,
    RealtimeCapacity,
    ControlRejected,
    SubscriptionMismatch,
    Unknown,
    Protocol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    /// 키움 포털 오류코드 목록·공식 명세·공식 SDK.
    Official,
    /// docs/kiwoom.md의 직접 관측.
    Observed,
    /// hoga-ops 기록이나 공개 구현의 관측 설명(docs/kiwoom-ws-errors.md).
    Reported,
    /// RFC 6455·IANA의 close 의미. 키움 관측은 없다.
    Standard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Known(Category, Basis),
    /// docs/kiwoom-ws-errors.md §4: WS에서 온다는 근거가 약한 후보.
    Candidate { proposed: Category },
}

use Basis::*;
use Category::*;
use CodeKey::{Rest, WsClose, WsControl};
use Rule::{Candidate, Known};

pub const CODE_TABLE: &[(CodeKey, Rule)] = &[
    (Rest(1501), Known(InvalidRequest, Official)),
    (Rest(1504), Known(InvalidRequest, Official)),
    (Rest(1505), Known(InvalidRequest, Official)),
    (Rest(1511), Known(InvalidRequest, Official)),
    (Rest(1512), Known(InvalidRequest, Official)),
    (Rest(1513), Known(InvalidRequest, Official)),
    (Rest(1514), Known(InvalidRequest, Official)),
    (Rest(1515), Known(InvalidRequest, Official)),
    (Rest(1516), Known(InvalidRequest, Official)),
    (Rest(1517), Known(InvalidRequest, Official)),
    (Rest(1687), Known(InvalidRequest, Official)),
    (Rest(1700), Known(RateLimit, Official)),
    (Rest(1701), Known(RateLimit, Official)),
    (Rest(1702), Known(RateLimit, Official)),
    (Rest(1901), Known(SymbolMismatch, Official)),
    (Rest(1902), Known(SymbolMismatch, Official)),
    (Rest(1903), Known(SymbolMismatch, Official)),
    (Rest(1999), Known(Transient, Official)),
    (Rest(8001), Known(AuthBlocked, Official)),
    (Rest(8002), Known(AuthBlocked, Official)),
    (Rest(8003), Known(AuthIndeterminate, Official)),
    (Rest(8005), Known(TokenInvalid, Official)),
    (Rest(8006), Known(AuthIndeterminate, Official)),
    (Rest(8009), Known(AuthIndeterminate, Official)),
    (Rest(8010), Known(AuthBlocked, Official)),
    (Rest(8011), Known(InvalidRequest, Official)),
    (Rest(8012), Known(InvalidRequest, Official)),
    (Rest(8015), Known(AuthIndeterminate, Official)),
    (Rest(8016), Known(InvalidRequest, Official)),
    (Rest(8020), Known(InvalidRequest, Official)),
    (Rest(8030), Known(AuthBlocked, Official)),
    (Rest(8031), Known(AuthBlocked, Official)),
    (Rest(8040), Known(AuthBlocked, Official)),
    (Rest(8050), Known(AuthBlocked, Official)),
    (Rest(8103), Known(AuthBlocked, Official)),
    (Rest(8104), Known(Unsupported, Official)),
    (Rest(8200), Known(Unsupported, Official)),
    (Rest(1634), Known(BatchLimit, Observed)),
    (WsControl(1), Known(ControlRejected, Official)),
    (WsControl(8005), Known(TokenInvalid, Official)),
    (WsControl(8031), Known(AuthBlocked, Official)),
    (WsControl(8103), Known(AuthBlocked, Official)),
    (WsControl(900004), Known(InvalidRequest, Official)),
    (WsControl(105112), Known(ControlRejected, Observed)),
    (WsControl(105115), Known(RealtimeCapacity, Observed)),
    (WsControl(105118), Known(RealtimeCapacity, Observed)),
    (WsControl(305003), Known(SubscriptionMismatch, Observed)),
    (WsControl(105110), Known(RateLimit, Reported)),
    (WsControl(100013), Known(ControlRejected, Reported)),
    (WsControl(8010), Candidate { proposed: AuthBlocked }),
    (WsControl(8030), Candidate { proposed: AuthBlocked }),
    (WsControl(8104), Candidate { proposed: Unsupported }),
    (WsControl(1702), Candidate { proposed: RateLimit }),
    (WsControl(1902), Candidate { proposed: SymbolMismatch }),
    (WsControl(1903), Candidate { proposed: SymbolMismatch }),
    (WsClose(1000), Known(Transient, Reported)),
    (WsClose(1006), Known(Transient, Reported)),
    (WsClose(1009), Known(Protocol, Reported)),
    (WsClose(1001), Known(Transient, Standard)),
    (WsClose(1002), Known(Protocol, Standard)),
    (WsClose(1003), Known(Protocol, Standard)),
    (WsClose(1007), Known(Protocol, Standard)),
    (WsClose(1010), Known(Protocol, Standard)),
    (WsClose(1008), Known(Unknown, Standard)),
    (WsClose(1011), Known(Transient, Standard)),
    (WsClose(1012), Known(Transient, Standard)),
    (WsClose(1013), Known(Transient, Standard)),
    (WsClose(1014), Known(Transient, Standard)),
    (WsClose(1005), Known(Transient, Standard)),
    (WsClose(1015), Known(Transient, Standard)),
];

pub fn rule(key: CodeKey) -> Option<Rule> {
    CODE_TABLE.iter().find(|(k, _)| *k == key).map(|(_, r)| *r)
}

pub fn classify(key: CodeKey) -> Category {
    match rule(key) {
        Some(Known(category, _)) => category,
        Some(Candidate { .. }) | None => Unknown,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Issue,
    Market,
}

impl Phase {
    pub fn of(api_id: ApiId) -> Phase {
        if api_id == ApiId::Au10001 { Phase::Issue } else { Phase::Market }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retry {
    Never,
    AfterPause,
    Backoff,
    RefreshTokenOnce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Nothing,
    Path,
    PathOnRepeat,
    Everything,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub retry: Retry,
    pub stop: Stop,
    pub outer_retry: bool,
}

const fn p(retry: Retry, stop: Stop, outer_retry: bool) -> Policy {
    Policy { retry, stop, outer_retry }
}

pub const fn policy(phase: Phase, category: Category) -> Policy {
    use Retry::*;
    use Stop::*;
    match (phase, category) {
        (_, AuthBlocked) => p(Never, Everything, false),
        (Phase::Market, RateLimit) => p(AfterPause, Nothing, true),
        (Phase::Market, Transient) => p(Backoff, Nothing, true),
        (Phase::Market, TokenInvalid) => p(RefreshTokenOnce, Nothing, false),
        (Phase::Market, AuthIndeterminate | InvalidRequest | SymbolMismatch | BatchLimit) => p(Never, Nothing, false),
        (Phase::Market, Unsupported | Unknown | Protocol) => p(Never, Path, false),
        (Phase::Market, RealtimeCapacity | ControlRejected | SubscriptionMismatch) => p(Never, Path, false),
        (Phase::Issue, RateLimit | Transient) => p(Never, Nothing, true),
        (Phase::Issue, TokenInvalid | AuthIndeterminate) => p(Never, PathOnRepeat, false),
        (
            Phase::Issue,
            InvalidRequest | SymbolMismatch | BatchLimit | Unsupported | Unknown | Protocol | RealtimeCapacity | ControlRejected | SubscriptionMismatch,
        ) => p(Never, Path, false),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Unavailable,
    AuthFailed,
    UnknownSymbol,
    Internal,
}

/// 실패를 설명하는 고정된 사유. 키움 메시지 원문은 비밀값을 되돌려 줄 수 있어 담지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Note {
    None,
    NotJsonObject,
    MissingReturnCode,
    MalformedReturnCode,
    MalformedReturnMessage,
    MultipleDetails(Vec<u16>),
    Schema { line: usize, column: usize },
    BadTokenResponse,
    Transport(TransportError),
    QueueGone,
}

impl fmt::Display for Note {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Note::None => Ok(()),
            Note::NotJsonObject => f.write_str("JSON 객체가 아닙니다"),
            Note::MissingReturnCode => f.write_str("return_code가 없습니다"),
            Note::MalformedReturnCode => f.write_str("return_code가 정수가 아닙니다"),
            Note::MalformedReturnMessage => f.write_str("return_msg가 문자열이 아닙니다"),
            Note::MultipleDetails(codes) => write!(f, "상세 코드가 여럿입니다: {codes:?}"),
            Note::Schema { line, column } => write!(f, "응답 본문이 예상한 모양이 아닙니다({line}행 {column}열)"),
            Note::BadTokenResponse => f.write_str("토큰이나 만료 시각을 읽지 못했습니다"),
            Note::Transport(e) => write!(f, "{e}"),
            Note::QueueGone => f.write_str("대기열이 멈췄습니다"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    category: Category,
    api_id: ApiId,
    http_status: Option<u16>,
    return_code: Option<i64>,
    detail: Option<CodeKey>,
    note: Note,
}

impl Failure {
    pub fn transport(api_id: ApiId, e: TransportError) -> Failure {
        Failure { category: Transient, api_id, http_status: None, return_code: None, detail: None, note: Note::Transport(e) }
    }

    pub fn queue_gone(api_id: ApiId) -> Failure {
        Failure { category: Transient, api_id, http_status: None, return_code: None, detail: None, note: Note::QueueGone }
    }

    pub fn protocol(api_id: ApiId, note: Note) -> Failure {
        Failure { category: Protocol, api_id, http_status: None, return_code: None, detail: None, note }
    }

    pub fn schema(api_id: ApiId, envelope: Envelope, note: Note) -> Failure {
        Failure {
            category: Protocol,
            api_id,
            http_status: Some(envelope.http_status),
            return_code: Some(envelope.return_code),
            detail: None,
            note,
        }
    }

    pub fn note(&self) -> &Note {
        &self.note
    }

    pub fn category(&self) -> Category {
        self.category
    }

    pub fn api_id(&self) -> ApiId {
        self.api_id
    }

    pub fn http_status(&self) -> Option<u16> {
        self.http_status
    }

    pub fn return_code(&self) -> Option<i64> {
        self.return_code
    }

    pub fn detail(&self) -> Option<CodeKey> {
        self.detail
    }

    pub fn policy(&self) -> Policy {
        policy(Phase::of(self.api_id), self.category)
    }

    pub fn surface(&self) -> Surface {
        let issue = self.api_id == ApiId::Au10001;
        match self.category {
            RateLimit | Transient => Surface::Unavailable,
            TokenInvalid | AuthBlocked | AuthIndeterminate => Surface::AuthFailed,
            _ if issue => Surface::AuthFailed,
            Unknown => Surface::Unavailable,
            SymbolMismatch if matches!(self.api_id, ApiId::Ka10095 | ApiId::Ka10099) => Surface::Unavailable,
            SymbolMismatch => Surface::UnknownSymbol,
            InvalidRequest | BatchLimit | Unsupported | Protocol | RealtimeCapacity | ControlRejected | SubscriptionMismatch => Surface::Internal,
        }
    }

    fn evidence(&self) -> String {
        let mut parts = vec![self.api_id.as_str().to_owned()];
        if let Some(s) = self.http_status {
            parts.push(format!("HTTP {s}"));
        }
        if let Some(rc) = self.return_code {
            parts.push(format!("return_code {rc}"));
        }
        if let Some(d) = self.detail {
            parts.push(format!("상세 {d}"));
        }
        parts.join(", ")
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ev = self.evidence();
        let note = match &self.note {
            Note::None => String::new(),
            n => format!(": {n}"),
        };
        match self.category {
            AuthBlocked if self.detail == Some(Rest(8050)) => f.write_str(
                "키움이 지정단말기 인증 실패([8050])로 거절했습니다. 키움 IP 미등록 또는 반복 발급 잠금입니다. \
                 지금 공인 IP를 키움 포털에 등록하세요. 반복 발급 잠금이면 포털에서 해제됐는지 확인하세요. \
                 조회와 토큰 발급을 모두 멈췄습니다. 고친 뒤 서버를 다시 켜야 합니다",
            ),
            AuthBlocked => write!(f, "키움 인증에 실패했습니다({ev}). 조회와 토큰 발급을 모두 멈췄습니다. 운영자가 설정을 고치고 서버를 다시 켜야 합니다"),
            TokenInvalid => write!(f, "키움이 토큰을 무효로 봅니다({ev})"),
            AuthIndeterminate => write!(f, "키움 인증이 원인을 알 수 없게 실패했습니다({ev}). 곧바로 다시 발급하지 않습니다"),
            RateLimit => write!(f, "키움 요청 개수 초과가 계속됩니다({ev})"),
            Transient if self.http_status.is_none() => write!(f, "키움에 닿지 못했습니다({ev}){note}"),
            Transient => write!(f, "키움이 일시적으로 응답하지 못했습니다({ev})"),
            InvalidRequest | BatchLimit => write!(f, "키움이 요청을 거절했습니다({ev}){note}"),
            SymbolMismatch => write!(f, "키움에 종목이나 시장 정보가 없습니다({ev})"),
            Unsupported => write!(f, "키움이 이 계좌에서 지원하지 않는 API입니다({ev}). 이 조회를 멈췄습니다"),
            Unknown => write!(f, "키움이 알 수 없는 실패를 돌려줬습니다({ev}){note}. 운영자가 확인하고 서버를 다시 켤 때까지 이 경로로 보내지 않습니다"),
            Protocol => write!(f, "키움 응답 형식이 예상과 다릅니다({ev}){note}. 운영자가 확인하고 서버를 다시 켤 때까지 이 경로로 보내지 않습니다"),
            RealtimeCapacity | ControlRejected | SubscriptionMismatch => write!(f, "키움 실시간 제어가 거절됐습니다({ev}){note}"),
        }
    }
}

impl std::error::Error for Failure {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReturnCode {
    Missing,
    Number(i64),
    Malformed,
}

fn read_return_code(v: Option<&Value>) -> ReturnCode {
    match v {
        None | Some(Value::Null) => ReturnCode::Missing,
        Some(Value::Number(n)) => n.as_i64().map_or(ReturnCode::Malformed, ReturnCode::Number),
        Some(Value::String(s)) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().map_or(ReturnCode::Malformed, ReturnCode::Number),
        Some(_) => ReturnCode::Malformed,
    }
}

/// `[` 바로 뒤 네 자리, 그 뒤 `:` 또는 `]`. `[17000]`은 상세 코드가 아니다.
pub fn rest_details(msg: &str) -> Vec<u16> {
    let bytes = msg.as_bytes();
    let mut found = Vec::new();
    for (i, _) in msg.match_indices('[') {
        let digits = &bytes[i + 1..bytes.len().min(i + 5)];
        let closed = matches!(bytes.get(i + 5), Some(b':' | b']'));
        if digits.len() == 4 && digits.iter().all(u8::is_ascii_digit) && closed {
            let code = std::str::from_utf8(digits).expect("ASCII 숫자").parse().expect("네 자리");
            if !found.contains(&code) {
                found.push(code);
            }
        }
    }
    found
}

fn in_phase(api_id: ApiId, category: Category) -> Category {
    match (Phase::of(api_id), category) {
        (Phase::Issue, TokenInvalid) => AuthIndeterminate,
        (_, c) => c,
    }
}

/// 성공으로 판정한 응답 봉투.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Envelope {
    pub http_status: u16,
    pub return_code: i64,
}

pub fn judge(api_id: ApiId, status: u16, body: &str) -> Result<Envelope, Failure> {
    let object = match serde_json::from_str::<Value>(body) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    };
    let return_code = object.as_ref().map_or(ReturnCode::Malformed, |m| read_return_code(m.get("return_code")));
    let msg = match object.as_ref().and_then(|m| m.get("return_msg")) {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) => s,
        Some(_) => {
            return Err(Failure {
                category: Protocol,
                api_id,
                http_status: Some(status),
                return_code: match return_code {
                    ReturnCode::Number(n) => Some(n),
                    _ => None,
                },
                detail: None,
                note: Note::MalformedReturnMessage,
            });
        }
    };
    let details = rest_details(msg);
    let blocking = details.iter().copied().find(|&d| classify(Rest(d)) == AuthBlocked);
    let (category, detail) = match (details.as_slice(), blocking) {
        (_, Some(d)) => (AuthBlocked, Some(d)),
        (&[d], None) => (in_phase(api_id, classify(Rest(d))), Some(d)),
        ([_, _, ..], None) => (Protocol, None),
        ([], None) => match (status, return_code) {
            (429, _) => (RateLimit, None),
            (500.., _) => (Transient, None),
            (200, ReturnCode::Number(0)) => return Ok(Envelope { http_status: 200, return_code: 0 }),
            (200, ReturnCode::Number(_)) => (Unknown, None),
            (200, ReturnCode::Missing | ReturnCode::Malformed) => (Protocol, None),
            _ => (Unknown, None),
        },
    };
    let note = match (object.is_some(), return_code, details.len()) {
        (false, ..) => Note::NotJsonObject,
        (_, _, n) if n > 1 => Note::MultipleDetails(details.clone()),
        (_, ReturnCode::Missing, _) => Note::MissingReturnCode,
        (_, ReturnCode::Malformed, _) => Note::MalformedReturnCode,
        _ => Note::None,
    };
    Err(Failure {
        category,
        api_id,
        http_status: Some(status),
        return_code: match return_code {
            ReturnCode::Number(n) => Some(n),
            _ => None,
        },
        detail: detail.map(Rest),
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> String {
        let path = format!("{}/tests/fixtures/kiwoom/{name}.json", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn category(api_id: ApiId, status: u16, body: &str) -> Option<Category> {
        judge(api_id, status, body).err().map(|f| f.category())
    }

    const EXPECTED_REST: &[(u16, Category)] = &[
        (1501, InvalidRequest),
        (1504, InvalidRequest),
        (1505, InvalidRequest),
        (1511, InvalidRequest),
        (1512, InvalidRequest),
        (1513, InvalidRequest),
        (1514, InvalidRequest),
        (1515, InvalidRequest),
        (1516, InvalidRequest),
        (1517, InvalidRequest),
        (1687, InvalidRequest),
        (1700, RateLimit),
        (1701, RateLimit),
        (1702, RateLimit),
        (1901, SymbolMismatch),
        (1902, SymbolMismatch),
        (1903, SymbolMismatch),
        (1999, Transient),
        (8001, AuthBlocked),
        (8002, AuthBlocked),
        (8003, AuthIndeterminate),
        (8005, TokenInvalid),
        (8006, AuthIndeterminate),
        (8009, AuthIndeterminate),
        (8010, AuthBlocked),
        (8011, InvalidRequest),
        (8012, InvalidRequest),
        (8015, AuthIndeterminate),
        (8016, InvalidRequest),
        (8020, InvalidRequest),
        (8030, AuthBlocked),
        (8031, AuthBlocked),
        (8040, AuthBlocked),
        (8050, AuthBlocked),
        (8103, AuthBlocked),
        (8104, Unsupported),
        (8200, Unsupported),
        (1634, BatchLimit),
    ];

    const EXPECTED_WS: &[(u32, Category)] = &[
        (1, ControlRejected),
        (8005, TokenInvalid),
        (8031, AuthBlocked),
        (8103, AuthBlocked),
        (100013, ControlRejected),
        (105110, RateLimit),
        (105112, ControlRejected),
        (105115, RealtimeCapacity),
        (105118, RealtimeCapacity),
        (305003, SubscriptionMismatch),
        (900004, InvalidRequest),
        (8010, Unknown),
        (8030, Unknown),
        (8104, Unknown),
        (1702, Unknown),
        (1902, Unknown),
        (1903, Unknown),
    ];

    #[test]
    fn every_listed_code_has_one_rule_and_the_expected_category() {
        for (i, (k, _)) in CODE_TABLE.iter().enumerate() {
            assert!(!CODE_TABLE[i + 1..].iter().any(|(o, _)| o == k), "{k:?}가 두 번 있습니다");
        }
        let rest_rows = CODE_TABLE.iter().filter(|(k, _)| matches!(k, Rest(_))).count();
        let official = CODE_TABLE.iter().filter(|(k, r)| matches!(k, Rest(_)) && matches!(r, Known(_, Official))).count();
        assert_eq!((rest_rows, official), (EXPECTED_REST.len(), 37), "공식 37개와 실측 1634");
        for &(code, want) in EXPECTED_REST {
            assert_eq!(classify(Rest(code)), want, "[{code}]");
        }
        let ws_rows = CODE_TABLE.iter().filter(|(k, _)| matches!(k, WsControl(_))).count();
        assert_eq!(ws_rows, EXPECTED_WS.len(), "WS 11개와 추정 후보 6개");
        for &(code, want) in EXPECTED_WS {
            assert_eq!(classify(WsControl(code)), want, "WS {code}");
        }
        let candidates = CODE_TABLE.iter().filter(|(_, r)| matches!(r, Candidate { .. })).count();
        assert_eq!(candidates, 6);
    }

    #[test]
    fn close_codes_and_unlisted_codes() {
        for (code, want) in [(1000, Transient), (1006, Transient), (1009, Protocol), (1008, Unknown), (1011, Transient), (1004, Unknown), (4000, Unknown)] {
            assert_eq!(classify(WsClose(code)), want, "close {code}");
        }
        for key in [Rest(8004), Rest(8100), Rest(9999), Rest(0), WsControl(u32::MAX), WsControl(105111)] {
            assert_eq!(classify(key), Unknown, "{key:?}: 8000대라는 이유로 인증 차단이 되지 않는다");
        }
    }

    #[test]
    fn the_same_detail_is_the_same_category_on_any_http_status() {
        for &(code, want) in EXPECTED_REST {
            let body = format!(r#"{{"return_code": 3, "return_msg": "실패[{code}:사유]"}}"#);
            for status in [200, 401, 403, 429, 500, 503] {
                assert_eq!(category(ApiId::Ka10081, status, &body), Some(want), "[{code}] HTTP {status}");
            }
        }
        let unknown = r#"{"return_code": 1, "return_msg": "실패[8100:처음 보는 코드]"}"#;
        for status in [200, 429, 500] {
            assert_eq!(category(ApiId::Ka10081, status, unknown), Some(Unknown), "모르는 상세는 429·5xx여도 재시도 권한을 얻지 않는다");
        }
    }

    #[test]
    fn observed_responses() {
        let observed = [
            ("ka10081_err_1511", 200, InvalidRequest, 1511),
            ("err_1700", 429, RateLimit, 1700),
            ("err_8005", 200, TokenInvalid, 8005),
            ("err_1634", 200, BatchLimit, 1634),
        ];
        for (name, status, want, code) in observed {
            let f = judge(ApiId::Ka10081, status, &fixture(name)).unwrap_err();
            assert_eq!((f.category(), f.detail(), f.http_status()), (want, Some(Rest(code)), Some(status)), "{name}");
        }
        for name in ["ka10081_005930", "ka10081_unknown_999999", "ka20006_unknown_999", "ka10099_0", "au10001_ok"] {
            assert_eq!(judge(ApiId::Ka10081, 200, &fixture(name)).map(|_| ()), Ok(()), "{name}");
        }
    }

    #[test]
    fn token_invalid_while_issuing_is_indeterminate() {
        let f = judge(ApiId::Au10001, 200, &fixture("err_8005")).unwrap_err();
        assert_eq!(f.category(), AuthIndeterminate, "발급의 8005를 다시 발급으로 고치지 않는다");
        assert_eq!(f.policy().retry, Retry::Never);
    }

    #[test]
    fn a_broken_or_missing_envelope_is_never_success() {
        for body in [
            "",
            "<html>502 Bad Gateway</html>",
            "[]",
            "null",
            "{}",
            r#"{"list": []}"#,
            r#"{"return_code": null}"#,
            r#"{"return_code": "oops"}"#,
            r#"{"return_code": -0.5}"#,
            r#"{"return_code": 0.0}"#,
            r#"{"return_code": true}"#,
        ] {
            assert_eq!(category(ApiId::Ka10099, 200, body), Some(Protocol), "{body:?}");
        }
        assert_eq!(judge(ApiId::Ka10099, 200, r#"{"return_code": "0", "list": []}"#).map(|_| ()), Ok(()));
        assert_eq!(judge(ApiId::Ka10099, 200, r#"{"return_code": "0000", "list": []}"#).map(|_| ()), Ok(()));
        assert_eq!(category(ApiId::Ka10099, 200, r#"{"return_code": 0, "return_msg": "실패[8050:x]"}"#), Some(AuthBlocked), "상위 0이어도 실패 상세가 이긴다");
        assert_eq!(category(ApiId::Ka10099, 204, ""), Some(Unknown));
    }

    #[test]
    fn a_return_message_that_is_not_a_string_is_never_success() {
        for msg in [json!(["[8050:blocked]"]), json!({"detail": "[8050:blocked]"}), json!(42), json!(false)] {
            let body = json!({"return_code": 0, "return_msg": msg, "list": []}).to_string();
            assert_eq!(category(ApiId::Ka10099, 200, &body), Some(Protocol), "{msg}");
            assert_eq!(category(ApiId::Ka10099, 429, &body), Some(Protocol), "{msg}: 429여도 형식 오류가 이긴다");
        }
        for msg in [json!(null), json!("정상")] {
            let body = json!({"return_code": 0, "return_msg": msg, "list": []}).to_string();
            assert_eq!(judge(ApiId::Ka10099, 200, &body).map(|_| ()), Ok(()), "{msg}");
        }
        assert_eq!(judge(ApiId::Ka10099, 200, r#"{"return_code": 0, "list": []}"#).map(|_| ()), Ok(()), "메시지가 없어도 된다");
    }

    #[test]
    fn http_fallback_without_a_detail() {
        assert_eq!(category(ApiId::Ka10081, 429, "{}"), Some(RateLimit));
        assert_eq!(category(ApiId::Ka10081, 503, "<html>proxy</html>"), Some(Transient));
        assert_eq!(category(ApiId::Ka10081, 503, r#"{"return_code": 1, "return_msg": "점검"}"#), Some(Transient));
        assert_eq!(category(ApiId::Ka10081, 403, "{}"), Some(Unknown), "401·403만으로 토큰을 다시 받지 않는다");
        assert_eq!(category(ApiId::Ka10081, 200, r#"{"return_code": 1, "return_msg": "알 수 없음"}"#), Some(Unknown));
    }

    #[test]
    fn detail_parser() {
        assert_eq!(rest_details("입력 값 오류입니다[1511:필수]"), [1511]);
        assert_eq!(rest_details("허용된 요청 개수를 초과하였습니다[1634]"), [1634]);
        assert_eq!(rest_details("a[x] b[8005:y]"), [8005]);
        assert!(rest_details("[17000]").is_empty());
        assert!(rest_details("[170]").is_empty());
        assert!(rest_details("[1700").is_empty());
        assert!(rest_details("[1700x]").is_empty());
        assert!(rest_details("정상적으로 처리되었습니다").is_empty());
        assert!(rest_details("[１７００]").is_empty());
        assert_eq!(rest_details("[8005:a] [8005:b]"), [8005]);
        assert_eq!(rest_details("[1700:a] [8005:b]"), [1700, 8005]);
    }

    #[test]
    fn conflicting_details_prefer_auth_blocked_then_fail_as_protocol() {
        assert_eq!(category(ApiId::Ka10081, 200, r#"{"return_code": 5, "return_msg": "[1700:a][8050:b]"}"#), Some(AuthBlocked));
        assert_eq!(category(ApiId::Ka10081, 200, r#"{"return_code": 5, "return_msg": "[1700:a][8005:b]"}"#), Some(Protocol));
    }

    #[test]
    fn retry_and_stop_by_category() {
        for phase in [Phase::Issue, Phase::Market] {
            for c in [AuthBlocked, Unknown, Protocol, AuthIndeterminate, InvalidRequest] {
                let pol = policy(phase, c);
                assert_eq!((pol.retry, pol.outer_retry), (Retry::Never, false), "{phase:?} {c:?}");
            }
            assert_eq!(policy(phase, AuthBlocked).stop, Stop::Everything);
        }
        assert_eq!(policy(Phase::Market, Unknown).stop, Stop::Path);
        assert_eq!(policy(Phase::Market, Protocol).stop, Stop::Path);
        assert_eq!(policy(Phase::Issue, Unknown).stop, Stop::Path);
        assert_eq!(policy(Phase::Issue, AuthIndeterminate).stop, Stop::PathOnRepeat);
        assert_eq!(policy(Phase::Market, TokenInvalid).retry, Retry::RefreshTokenOnce);
        assert_eq!(policy(Phase::Issue, Transient).retry, Retry::Never, "발급은 일반 재시도를 쓰지 않는다");
    }

    #[test]
    fn market_failures_keep_no_message() {
        let secret = "FAKE-SECRET-err-2222";
        for body in [
            format!(r#"{{"return_code": 1, "return_msg": "실패[8999:{secret}]"}}"#),
            format!(r#"{{"return_code": 2, "return_msg": "입력 값 오류입니다[1511:{secret}]"}}"#),
            format!(r#"{{"return_code": 9, "return_msg": "{secret}"}}"#),
        ] {
            let f = judge(ApiId::Ka10081, 200, &body).unwrap_err();
            assert!(!format!("{f} {f:?}").contains(secret), "{f:?}");
        }
    }

    #[test]
    fn issue_failures_keep_no_message() {
        let body = r#"{"return_code": 3, "return_msg": "실패[8002:FAKE-APPKEY-err-1111]"}"#;
        let f = judge(ApiId::Au10001, 200, body).unwrap_err();
        assert!(!format!("{f} {f:?}").contains("FAKE-APPKEY"), "{f:?}");
    }
}
