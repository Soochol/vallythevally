use serde::{Deserialize, Serialize};
use serde_json::Value;
use server::collector::wire::{
    CollectorCoverage, CollectorCoverageDay, CollectorDayBytes, CollectorDayState, CollectorDisk, CollectorDiskUsage, CollectorFilesystem, DaemonError,
    Heartbeat, Reply as ServerWireBody, StatusReply, WireReply,
};

use super::status::{DaemonStatus, DayPhase};

pub const API_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 4096;
pub const MAX_REPLY_BYTES: u64 = 4 << 20;

const COMMAND_LIKE_TYPES: [&str; 14] = [
    "restart", "handoff", "hand_off", "stop", "start", "kill", "shutdown", "terminate", "reload", "register", "unregister", "reissue_token", "token", "set",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequestKind {
    Status,
    Coverage,
    Disk,
    Watch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub v: u32,
    #[serde(flatten)]
    pub kind: RequestKind,
}

impl Request {
    pub fn new(kind: RequestKind) -> Request {
        Request { v: API_VERSION, kind }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    UnsupportedVersion,
    UnknownRequest,
    ReadOnly,
    TooManyConnections,
}

impl ErrorCode {
    pub fn wire_name(self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::UnsupportedVersion => "unsupported_version",
            ErrorCode::UnknownRequest => "unknown_request",
            ErrorCode::ReadOnly => "read_only",
            ErrorCode::TooManyConnections => "too_many_connections",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageState {
    Complete,
    Incomplete,
    InProgress,
    VerifyFailed,
    Unreadable,
}

impl CoverageState {
    pub fn to_wire(self) -> CollectorDayState {
        match self {
            CoverageState::Complete => CollectorDayState::Complete,
            CoverageState::Incomplete => CollectorDayState::Incomplete,
            CoverageState::InProgress => CollectorDayState::InProgress,
            CoverageState::VerifyFailed => CollectorDayState::VerifyFailed,
            CoverageState::Unreadable => CollectorDayState::Unreadable,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoverageDay {
    pub date: u32,
    pub state: CoverageState,
    pub verified: Option<bool>,
    pub planned_stocks: Option<u64>,
    pub received_stocks: Option<u64>,
}

impl CoverageDay {
    pub fn to_wire(&self) -> CollectorCoverageDay {
        CollectorCoverageDay {
            date: self.date,
            state: self.state.to_wire(),
            verified: self.verified,
            planned_stocks: self.planned_stocks.map(|count| u32::try_from(count).unwrap_or(u32::MAX)),
            received_stocks: self.received_stocks.map(|count| u32::try_from(count).unwrap_or(u32::MAX)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DayBytes {
    pub date: u32,
    pub bytes: u64,
}

impl DayBytes {
    pub fn to_wire(&self) -> CollectorDayBytes {
        CollectorDayBytes { date: self.date, bytes: self.bytes }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filesystem {
    pub free_bytes: u64,
    pub total_bytes: u64,
}

impl Filesystem {
    pub fn to_wire(&self) -> CollectorFilesystem {
        CollectorFilesystem { free_bytes: self.free_bytes, total_bytes: self.total_bytes }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskUsage {
    pub filesystem: Option<Filesystem>,
    pub raw: Vec<DayBytes>,
    pub store: Vec<DayBytes>,
}

impl DiskUsage {
    pub fn to_wire(&self) -> CollectorDiskUsage {
        CollectorDiskUsage {
            filesystem: self.filesystem.as_ref().map(Filesystem::to_wire),
            raw: self.raw.iter().map(DayBytes::to_wire).collect(),
            store: self.store.iter().map(DayBytes::to_wire).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReplyBody {
    Status { sent_at: String, status: DaemonStatus },
    Heartbeat { sent_at: String, sequence: u64, phase: DayPhase },
    Coverage { sent_at: String, days: Vec<CoverageDay> },
    Disk { sent_at: String, disk: DiskUsage },
    Error { code: ErrorCode, message: String, supported_version: u32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub v: u32,
    #[serde(flatten)]
    pub body: ReplyBody,
}

impl Reply {
    pub fn new(body: ReplyBody) -> Reply {
        Reply { v: API_VERSION, body }
    }

    pub fn error(code: ErrorCode, message: impl Into<String>) -> Reply {
        Reply::new(ReplyBody::Error { code, message: message.into(), supported_version: API_VERSION })
    }

    pub fn to_wire(&self) -> WireReply {
        let body = match &self.body {
            ReplyBody::Status { sent_at, status } => ServerWireBody::Status(Box::new(StatusReply {
                sent_at: sent_at.clone(),
                status: status.to_wire(),
            })),
            ReplyBody::Heartbeat { sent_at, sequence, phase } => ServerWireBody::Heartbeat(Heartbeat {
                sent_at: Some(sent_at.clone()),
                sequence: *sequence,
                phase: phase.to_wire(),
            }),
            ReplyBody::Coverage { sent_at, days } => ServerWireBody::Coverage(CollectorCoverage {
                sent_at: sent_at.clone(),
                days: days.iter().map(CoverageDay::to_wire).collect(),
            }),
            ReplyBody::Disk { sent_at, disk } => ServerWireBody::Disk(CollectorDisk {
                sent_at: sent_at.clone(),
                disk: disk.to_wire(),
            }),
            ReplyBody::Error { code, message, supported_version } => ServerWireBody::Error(DaemonError {
                code: code.wire_name().to_owned(),
                message: message.clone(),
                supported_version: Some(u64::from(*supported_version)),
            }),
        };
        WireReply { v: u64::from(self.v), body }
    }

    pub fn to_line(&self) -> String {
        let mut line = serde_json::to_string(&self.to_wire()).expect("응답은 항상 JSON으로 바뀐다");
        line.push('\n');
        line
    }
}

#[derive(Debug)]
pub struct Refusal {
    pub code: ErrorCode,
    pub message: String,
}

impl Refusal {
    fn new(code: ErrorCode, message: impl Into<String>) -> Refusal {
        Refusal { code, message: message.into() }
    }

    pub fn into_reply(self) -> Reply {
        Reply::error(self.code, self.message)
    }
}

pub fn parse_request(line: &str) -> Result<Request, Refusal> {
    let value: Value = serde_json::from_str(line).map_err(|_| Refusal::new(ErrorCode::BadRequest, "JSON 한 줄이어야 합니다"))?;
    let Some(object) = value.as_object() else {
        return Err(Refusal::new(ErrorCode::BadRequest, "JSON 객체여야 합니다"));
    };
    match object.get("v").and_then(Value::as_u64) {
        Some(version) if version == u64::from(API_VERSION) => {}
        Some(version) => return Err(Refusal::new(ErrorCode::UnsupportedVersion, format!("요청 형식 버전({version})은 지원하지 않습니다"))),
        None => return Err(Refusal::new(ErrorCode::BadRequest, "형식 버전 v가 없습니다")),
    }
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return Err(Refusal::new(ErrorCode::BadRequest, "요청 종류 type이 없습니다"));
    };
    let name: String = kind.chars().take(32).collect();
    if COMMAND_LIKE_TYPES.contains(&kind) {
        return Err(Refusal::new(ErrorCode::ReadOnly, format!("{name}: 이 API는 읽기 전용입니다. 명령을 받지 않습니다")));
    }
    serde_json::from_value(value).map_err(|_| Refusal::new(ErrorCode::UnknownRequest, format!("알 수 없는 요청입니다: {name}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_round_trip_and_reject_commands_and_versions() {
        for kind in [RequestKind::Status, RequestKind::Coverage, RequestKind::Disk, RequestKind::Watch] {
            let line = serde_json::to_string(&Request::new(kind)).unwrap();
            assert_eq!(parse_request(&line).unwrap().kind, kind);
        }
        let code = |line: &str| parse_request(line).unwrap_err().code;
        assert_eq!(code(r#"{"v":1,"type":"restart","key":"collect-01"}"#), ErrorCode::ReadOnly);
        assert_eq!(code(r#"{"v":1,"type":"nonsense"}"#), ErrorCode::UnknownRequest);
        assert_eq!(code(r#"{"v":2,"type":"status"}"#), ErrorCode::UnsupportedVersion);
        assert_eq!(code(r#"{"type":"status"}"#), ErrorCode::BadRequest);
        assert_eq!(code("not json"), ErrorCode::BadRequest);
        assert_eq!(code("[]"), ErrorCode::BadRequest);
    }
}
