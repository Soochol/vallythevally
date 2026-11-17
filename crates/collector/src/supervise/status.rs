use serde::{Deserialize, Serialize};

use crate::keys::KeyRole;
use crate::protocol::KeyName;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyState {
    Waiting,
    Connecting,
    Receiving,
    Disconnected,
    Stopped,
    HandedOff,
}

impl KeyState {
    pub fn label(self) -> &'static str {
        match self {
            KeyState::Waiting => "대기",
            KeyState::Connecting => "연결 중",
            KeyState::Receiving => "받는 중",
            KeyState::Disconnected => "끊김",
            KeyState::Stopped => "멈춤",
            KeyState::HandedOff => "인계됨",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyStatus {
    pub name: KeyName,
    pub role: KeyRole,
    pub state: KeyState,
    pub stocks: usize,
    pub messages_per_second: Option<f64>,
    pub register_failures: usize,
    pub restarts: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct DaemonStatus {
    pub date: u32,
    pub keys: Vec<KeyStatus>,
}

impl DaemonStatus {
    pub fn summary(&self) -> String {
        let keys: Vec<String> = self
            .keys
            .iter()
            .map(|key| {
                let rate = key.messages_per_second.map_or_else(|| "-".to_owned(), |rate| format!("{rate:.1}"));
                format!("{}={} 종목 {} 초당 {} 등록실패 {} 재시작 {}", key.name, key.state.label(), key.stocks, rate, key.register_failures, key.restarts)
            })
            .collect();
        format!("{} 상태: {}", self.date, keys.join(" | "))
    }
}
