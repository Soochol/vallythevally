use crate::error::ApiError;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Naver,
}

impl Provider {
    pub fn parse(value: &str) -> Result<Self, ApiError> {
        match value {
            "google" => Ok(Self::Google),
            "naver" => Ok(Self::Naver),
            _ => Err(ApiError::provider_not_found()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Naver => "naver",
        }
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnectorPort(u16);

impl ConnectorPort {
    pub fn get(self) -> u16 {
        self.0
    }
}

#[derive(Clone, Debug)]
pub struct ConnectorState(String);

impl ConnectorState {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub struct CodeChallenge(String);

impl CodeChallenge {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_unreserved(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'))
}

#[derive(Clone, Debug)]
pub struct StartRequest {
    pub port: ConnectorPort,
    pub state: ConnectorState,
    pub code_challenge: CodeChallenge,
}

impl StartRequest {
    pub fn parse(query: &HashMap<String, String>) -> Result<Self, ApiError> {
        let field = |name: &str| {
            query
                .get(name)
                .map(String::as_str)
                .ok_or_else(|| ApiError::invalid_request(format!("{name}가 필요합니다")))
        };
        let port: u16 = field("port")?
            .parse()
            .ok()
            .filter(|port| *port >= 1024)
            .ok_or_else(|| ApiError::invalid_request("port는 1024~65535 정수여야 합니다"))?;
        let state = field("state")?;
        if !(16..=128).contains(&state.len()) || !is_unreserved(state) {
            return Err(ApiError::invalid_request("state 형식이 맞지 않습니다"));
        }
        let challenge = field("code_challenge")?;
        if challenge.len() != 43 || !is_unreserved(challenge) {
            return Err(ApiError::invalid_request("code_challenge 형식이 맞지 않습니다"));
        }
        if field("code_challenge_method")? != "S256" {
            return Err(ApiError::invalid_request("code_challenge_method는 S256만 받습니다"));
        }
        Ok(Self {
            port: ConnectorPort(port),
            state: ConnectorState(state.to_owned()),
            code_challenge: CodeChallenge(challenge.to_owned()),
        })
    }
}

impl ConnectorPort {
    pub fn from_stored(value: i64) -> Option<Self> {
        u16::try_from(value).ok().filter(|port| *port >= 1024).map(Self)
    }
}

impl ConnectorState {
    pub fn from_stored(value: String) -> Self {
        Self(value)
    }
}

impl CodeChallenge {
    pub fn from_stored(value: String) -> Self {
        Self(value)
    }
}

#[derive(Clone, Debug)]
pub enum LoginFlow {
    Connector(StartRequest),
    Browser,
}
