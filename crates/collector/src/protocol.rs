use std::collections::HashSet;
use std::fmt;
use std::time::Duration;

use domain::StockCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use server::config::Secret;

pub const PROTOCOL_VERSION: u32 = 1;
pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(5);
pub const REGISTER_BATCH_SIZE: usize = 50;
pub const STOCK_ITEM_SUFFIX: &str = "_AL";

const KEY_NAME_MAX_LEN: usize = 64;
const COMMAND_NAME_MAX_LEN: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyNameError {
    Empty,
    TooLong(usize),
    Character(char),
}

impl fmt::Display for KeyNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyNameError::Empty => formatter.write_str("키 이름이 비었습니다"),
            KeyNameError::TooLong(length) => write!(formatter, "키 이름은 {KEY_NAME_MAX_LEN}자까지입니다({length}자)"),
            KeyNameError::Character(character) => {
                write!(formatter, "키 이름에는 영문자, 숫자, -, _만 쓸 수 있습니다({character:?})")
            }
        }
    }
}

impl std::error::Error for KeyNameError {}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct KeyName(String);

impl KeyName {
    pub fn parse(text: &str) -> Result<KeyName, KeyNameError> {
        if text.is_empty() {
            return Err(KeyNameError::Empty);
        }
        if let Some(character) = text.chars().find(|character| !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))) {
            return Err(KeyNameError::Character(character));
        }
        if text.len() > KEY_NAME_MAX_LEN {
            return Err(KeyNameError::TooLong(text.len()));
        }
        Ok(KeyName(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for KeyName {
    type Error = KeyNameError;

    fn try_from(text: String) -> Result<KeyName, KeyNameError> {
        KeyName::parse(&text)
    }
}

impl From<KeyName> for String {
    fn from(key: KeyName) -> String {
        key.0
    }
}

impl fmt::Display for KeyName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Stock,
    Market,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum RealType {
    #[serde(rename = "0B")]
    Trade,
    #[serde(rename = "0D")]
    OrderBook,
    #[serde(rename = "0w")]
    ProgramTrade,
    #[serde(rename = "0F")]
    BrokerFlow,
    #[serde(rename = "1h")]
    VolatilityInterruption,
    #[serde(rename = "0H")]
    ExpectedTrade,
    #[serde(rename = "0E")]
    AfterHoursOrderBook,
    #[serde(rename = "0g")]
    StockInfo,
    #[serde(rename = "0J")]
    SectorIndex,
    #[serde(rename = "0U")]
    SectorBreadth,
    #[serde(rename = "0s")]
    MarketHours,
}

impl RealType {
    pub fn wire(self) -> &'static str {
        match self {
            RealType::Trade => "0B",
            RealType::OrderBook => "0D",
            RealType::ProgramTrade => "0w",
            RealType::BrokerFlow => "0F",
            RealType::VolatilityInterruption => "1h",
            RealType::ExpectedTrade => "0H",
            RealType::AfterHoursOrderBook => "0E",
            RealType::StockInfo => "0g",
            RealType::SectorIndex => "0J",
            RealType::SectorBreadth => "0U",
            RealType::MarketHours => "0s",
        }
    }

    pub fn scope(self) -> Scope {
        match self {
            RealType::SectorIndex | RealType::SectorBreadth | RealType::MarketHours => Scope::Market,
            _ => Scope::Stock,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationError {
    NoItems,
    NoTypes,
    RepeatedType(RealType),
    MixedScopes,
    Stock(String),
    RepeatedItem(String),
}

impl fmt::Display for RegistrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistrationError::NoItems => formatter.write_str("items가 비었습니다"),
            RegistrationError::NoTypes => formatter.write_str("types가 비었습니다"),
            RegistrationError::RepeatedType(kind) => write!(formatter, "types에 {}이 두 번 있습니다", kind.wire()),
            RegistrationError::MixedScopes => formatter.write_str("종목 단위 타입과 시장 단위 타입을 한 명령에 섞을 수 없습니다"),
            RegistrationError::Stock(text) => write!(formatter, "종목코드가 아닌 값이 있습니다: {text:?}"),
            RegistrationError::RepeatedItem(text) => write!(formatter, "같은 항목이 두 번 있습니다: {text:?}"),
        }
    }
}

impl std::error::Error for RegistrationError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RegistrationWire {
    id: String,
    items: Vec<String>,
    types: Vec<RealType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RegistrationWire", into = "RegistrationWire")]
pub struct Registration {
    id: String,
    items: Vec<String>,
    types: Vec<RealType>,
}

impl Registration {
    pub fn new(id: impl Into<String>, items: Vec<String>, types: Vec<RealType>) -> Result<Registration, RegistrationError> {
        let scope = types.first().ok_or(RegistrationError::NoTypes)?.scope();
        let mut seen_types = HashSet::new();
        for kind in &types {
            if kind.scope() != scope {
                return Err(RegistrationError::MixedScopes);
            }
            if !seen_types.insert(*kind) {
                return Err(RegistrationError::RepeatedType(*kind));
            }
        }
        if items.is_empty() {
            return Err(RegistrationError::NoItems);
        }
        let mut seen_items = HashSet::new();
        for item in &items {
            if scope == Scope::Stock && StockCode::parse(item).is_err() {
                return Err(RegistrationError::Stock(item.clone()));
            }
            if !seen_items.insert(item.as_str()) {
                return Err(RegistrationError::RepeatedItem(item.clone()));
            }
        }
        Ok(Registration { id: id.into(), items, types })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn types(&self) -> &[RealType] {
        &self.types
    }

    pub fn scope(&self) -> Scope {
        self.types[0].scope()
    }

    pub fn wire_items(&self) -> Vec<String> {
        match self.scope() {
            Scope::Stock => self.items.iter().map(|code| format!("{code}{STOCK_ITEM_SUFFIX}")).collect(),
            Scope::Market => self.items.clone(),
        }
    }
}

impl TryFrom<RegistrationWire> for Registration {
    type Error = RegistrationError;

    fn try_from(wire: RegistrationWire) -> Result<Registration, RegistrationError> {
        Registration::new(wire.id, wire.items, wire.types)
    }
}

impl From<Registration> for RegistrationWire {
    fn from(registration: Registration) -> RegistrationWire {
        RegistrationWire { id: registration.id, items: registration.items, types: registration.types }
    }
}

mod secret_text {
    use serde::{Deserialize, Deserializer, Serializer};
    use server::config::Secret;

    pub fn serialize<S: Serializer>(secret: &Secret<String>, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(secret.expose())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Secret<String>, D::Error> {
        String::deserialize(deserializer).map(Secret::new)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Token {
        #[serde(with = "secret_text")]
        token: Secret<String>,
        generation: u64,
    },
    Register(Registration),
    Unregister(Registration),
    Shutdown,
}

const COMMAND_NAMES: [&str; 4] = ["token", "register", "unregister", "shutdown"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    WaitingForToken,
    Backoff,
    Connecting,
    LoggingIn,
    Registering,
    Live,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rejection {
    pub reason: String,
    pub return_code: Option<i64>,
    pub detail: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Batch {
    pub id: String,
    pub part: u32,
    pub parts: u32,
    pub items: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Hello {
        key: KeyName,
        pid: u32,
    },
    Heartbeat {
        frames: u64,
        bytes: u64,
        state: SessionState,
    },
    Registered {
        #[serde(flatten)]
        batch: Batch,
        ok: bool,
        replay: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rejection: Option<Rejection>,
    },
    Unregistered {
        #[serde(flatten)]
        batch: Batch,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rejection: Option<Rejection>,
    },
    Live,
    Down {
        reason: String,
    },
    TokenInvalid {
        generation: u64,
    },
    MarketOpen {
        recv_ms: i64,
        values: Map<String, Value>,
    },
    Halted {
        reason: String,
        action: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    NotJson,
    Version(Option<u64>),
    UnknownCommand(String),
    Invalid { command: String, message: String },
    Unreadable,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::NotJson => formatter.write_str("JSON 객체가 아닌 줄을 받았습니다"),
            ProtocolError::Version(Some(version)) => {
                write!(formatter, "형식 버전 {version}인 줄을 받았습니다(이 수집기는 {PROTOCOL_VERSION}만 읽습니다)")
            }
            ProtocolError::Version(None) => write!(formatter, "형식 버전(v)이 없는 줄을 받았습니다(이 수집기는 {PROTOCOL_VERSION}만 읽습니다)"),
            ProtocolError::UnknownCommand(name) => write!(formatter, "모르는 명령을 받았습니다: {name}"),
            ProtocolError::Invalid { command, message } => write!(formatter, "{command} 명령의 형식이 맞지 않습니다: {message}"),
            ProtocolError::Unreadable => formatter.write_str("명령을 읽는 입력에서 줄을 읽지 못했습니다"),
        }
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Serialize)]
struct Line<'a, T> {
    v: u32,
    #[serde(flatten)]
    body: &'a T,
}

pub fn encode_line<T: Serialize>(body: &T) -> String {
    let mut line = serde_json::to_string(&Line { v: PROTOCOL_VERSION, body }).expect("프로토콜 타입은 항상 JSON으로 바뀐다");
    line.push('\n');
    line
}

fn parse_object(line: &str) -> Result<Map<String, Value>, ProtocolError> {
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(ProtocolError::NotJson),
    }
}

fn check_version(object: &Map<String, Value>) -> Result<(), ProtocolError> {
    match object.get("v").and_then(Value::as_u64) {
        Some(version) if version == u64::from(PROTOCOL_VERSION) => Ok(()),
        other => Err(ProtocolError::Version(other)),
    }
}

fn printable_name(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(name) if name.len() <= COMMAND_NAME_MAX_LEN && name.chars().all(|character| character.is_ascii_alphanumeric() || character == '_') => {
            name.to_owned()
        }
        _ => "(이름을 읽을 수 없음)".to_owned(),
    }
}

pub fn parse_command(line: &str) -> Result<Command, ProtocolError> {
    let object = parse_object(line)?;
    check_version(&object)?;
    let name = object.get("cmd").and_then(Value::as_str).filter(|name| COMMAND_NAMES.contains(name)).map(str::to_owned);
    let Some(name) = name else {
        return Err(ProtocolError::UnknownCommand(printable_name(object.get("cmd"))));
    };
    serde_json::from_value::<Command>(Value::Object(object)).map_err(|error| ProtocolError::Invalid {
        command: name.clone(),
        message: if name == "token" { "token(문자열)과 generation(정수)이 필요합니다".to_owned() } else { error.to_string() },
    })
}

pub fn parse_event(line: &str) -> Result<Event, ProtocolError> {
    let object = parse_object(line)?;
    check_version(&object)?;
    let name = printable_name(object.get("event"));
    serde_json::from_value::<Event>(Value::Object(object)).map_err(|error| ProtocolError::Invalid { command: name, message: error.to_string() })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const ALL_TYPES: [RealType; 11] = [
        RealType::Trade,
        RealType::OrderBook,
        RealType::ProgramTrade,
        RealType::BrokerFlow,
        RealType::VolatilityInterruption,
        RealType::ExpectedTrade,
        RealType::AfterHoursOrderBook,
        RealType::StockInfo,
        RealType::SectorIndex,
        RealType::SectorBreadth,
        RealType::MarketHours,
    ];

    #[test]
    fn real_types_serialize_as_the_kiwoom_codes() {
        for kind in ALL_TYPES {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.wire()));
            assert_eq!(serde_json::from_value::<RealType>(json!(kind.wire())).unwrap(), kind);
        }
        let codes: HashSet<&str> = ALL_TYPES.iter().map(|kind| kind.wire()).collect();
        assert_eq!(codes.len(), ALL_TYPES.len());
    }

    #[test]
    fn key_names_are_folder_safe() {
        for good in ["k1", "key-03", "SPARE_1"] {
            assert_eq!(KeyName::parse(good).unwrap().as_str(), good);
        }
        assert_eq!(KeyName::parse(""), Err(KeyNameError::Empty));
        for bad in ["a/b", "..", "a b", "키", "a.b"] {
            assert!(matches!(KeyName::parse(bad), Err(KeyNameError::Character(_))), "{bad}");
        }
        assert_eq!(KeyName::parse(&"k".repeat(65)), Err(KeyNameError::TooLong(65)));
        assert!(serde_json::from_value::<KeyName>(json!("../x")).is_err());
    }

    #[test]
    fn commands_round_trip_through_a_versioned_line() {
        let commands = [
            Command::Token { token: Secret::new("FAKE-TOKEN".to_owned()), generation: 7 },
            Command::Register(Registration::new("r1", vec!["005930".into(), "000660".into()], vec![RealType::Trade, RealType::OrderBook]).unwrap()),
            Command::Unregister(Registration::new("u1", vec!["001".into(), String::new()], vec![RealType::SectorIndex]).unwrap()),
            Command::Shutdown,
        ];
        for command in commands {
            let line = encode_line(&command);
            assert!(line.ends_with('\n') && !line[..line.len() - 1].contains('\n'));
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["v"], 1);
            assert_eq!(parse_command(&line).unwrap(), command);
        }
    }

    #[test]
    fn the_token_wire_shape_is_plain_and_its_debug_form_is_masked() {
        let command = Command::Token { token: Secret::new("FAKE-TOKEN".to_owned()), generation: 3 };
        assert_eq!(serde_json::from_str::<Value>(&encode_line(&command)).unwrap(), json!({"v": 1, "cmd": "token", "token": "FAKE-TOKEN", "generation": 3}));
        assert!(!format!("{command:?}").contains("FAKE-TOKEN"));
    }

    #[test]
    fn events_round_trip_through_a_versioned_line() {
        let batch = Batch { id: "r1".into(), part: 1, parts: 3, items: 50 };
        let events = [
            Event::Hello { key: KeyName::parse("k1").unwrap(), pid: 42 },
            Event::Heartbeat { frames: 9, bytes: 1234, state: SessionState::Live },
            Event::Registered { batch: batch.clone(), ok: true, replay: false, rejection: None },
            Event::Registered {
                batch: batch.clone(),
                ok: false,
                replay: true,
                rejection: Some(Rejection { reason: "한도".into(), return_code: Some(105115), detail: Some(8005) }),
            },
            Event::Unregistered { batch, ok: true, rejection: None },
            Event::Live,
            Event::Down { reason: "끊김".into() },
            Event::TokenInvalid { generation: 2 },
            Event::MarketOpen { recv_ms: 1_700_000_000_000, values: serde_json::from_value(json!({"215": "3", "20": "090000"})).unwrap() },
            Event::Halted { reason: "멈춤".into(), action: "확인".into() },
        ];
        for event in events {
            assert_eq!(parse_event(&encode_line(&event)).unwrap(), event);
        }
        assert_eq!(
            serde_json::from_str::<Value>(&encode_line(&Event::Registered { batch: Batch { id: "r1".into(), part: 0, parts: 1, items: 2 }, ok: true, replay: false, rejection: None })).unwrap(),
            json!({"v": 1, "event": "registered", "id": "r1", "part": 0, "parts": 1, "items": 2, "ok": true, "replay": false})
        );
    }

    #[test]
    fn registrations_reject_what_kiwoom_would_reject_or_what_would_corrupt_the_plan() {
        let stock = |items: &[&str], types: &[RealType]| Registration::new("r", items.iter().map(|item| item.to_string()).collect(), types.to_vec());
        assert_eq!(stock(&[], &[RealType::Trade]), Err(RegistrationError::NoItems));
        assert_eq!(stock(&["005930"], &[]), Err(RegistrationError::NoTypes));
        assert_eq!(stock(&["5930"], &[RealType::Trade]), Err(RegistrationError::Stock("5930".into())));
        assert_eq!(stock(&["005930", "005930"], &[RealType::Trade]), Err(RegistrationError::RepeatedItem("005930".into())));
        assert_eq!(stock(&["005930"], &[RealType::Trade, RealType::Trade]), Err(RegistrationError::RepeatedType(RealType::Trade)));
        assert_eq!(stock(&["005930"], &[RealType::Trade, RealType::SectorIndex]), Err(RegistrationError::MixedScopes));
        assert!(stock(&["", ""], &[RealType::MarketHours]).is_err());
        assert!(stock(&[""], &[RealType::MarketHours]).is_ok());
    }

    #[test]
    fn stock_items_get_the_integrated_suffix_and_market_items_are_sent_as_given() {
        let stocks = Registration::new("r", vec!["005930".into(), "03481K".into()], vec![RealType::Trade]).unwrap();
        assert_eq!(stocks.wire_items(), ["005930_AL", "03481K_AL"]);
        let market = Registration::new("m", vec!["001".into(), "101".into()], vec![RealType::SectorIndex, RealType::SectorBreadth]).unwrap();
        assert_eq!(market.wire_items(), ["001", "101"]);
    }

    #[test]
    fn broken_and_foreign_lines_are_told_apart() {
        assert_eq!(parse_command("깨진 줄"), Err(ProtocolError::NotJson));
        assert_eq!(parse_command(""), Err(ProtocolError::NotJson));
        assert_eq!(parse_command("[1]"), Err(ProtocolError::NotJson));
        assert_eq!(parse_command(r#"{"cmd":"shutdown"}"#), Err(ProtocolError::Version(None)));
        assert_eq!(parse_command(r#"{"v":2,"cmd":"shutdown"}"#), Err(ProtocolError::Version(Some(2))));
        assert_eq!(parse_command(r#"{"v":1,"cmd":"dance"}"#), Err(ProtocolError::UnknownCommand("dance".into())));
        assert_eq!(parse_command(r#"{"v":1}"#), Err(ProtocolError::UnknownCommand("(이름을 읽을 수 없음)".into())));
        assert!(matches!(parse_command(r#"{"v":1,"cmd":"register","id":"r","items":["5930"],"types":["0B"]}"#), Err(ProtocolError::Invalid { .. })));
        assert!(matches!(parse_command(r#"{"v":1,"cmd":"register","id":"r","items":["005930"],"types":["zz"]}"#), Err(ProtocolError::Invalid { .. })));
        assert_eq!(parse_command(r#"{"v":1,"cmd":"shutdown"}"#), Ok(Command::Shutdown));
    }

    #[test]
    fn a_malformed_token_line_never_repeats_what_it_carried() {
        let secret = "FAKE-TOKEN-must-not-leak";
        for line in [
            format!(r#"{{"v":1,"cmd":"token","token":"{secret}","generation":"seven"}}"#),
            format!(r#"{{"v":1,"cmd":"token","token":"{secret}"}}"#),
            format!(r#"{{"v":1,"cmd":"{secret}"}}"#),
            format!(r#"{{"v":1,"cmd":"token","token":["{secret}"],"generation":1}}"#),
        ] {
            let error = parse_command(&line).unwrap_err();
            assert!(!format!("{error} {error:?}").contains(secret), "{line}");
        }
    }
}
