use std::fmt;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::{CONTENT_TYPE, RETRY_AFTER};
use serde::Deserialize;

use crate::config::Secret;

pub const DEFAULT_FILE: &str = ".config/vally/telegram";
pub const DEFAULT_API: &str = "https://api.telegram.org";
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_ATTEMPTS: u32 = 4;
pub const LONGEST_WAIT: Duration = Duration::from_secs(60);
const FALLBACK_WAIT: Duration = Duration::from_secs(1);
const TEXT_LIMIT: usize = 4096;
pub const LONGEST_BOT_TOKEN: usize = 256;
pub const LONGEST_CHAT_ID: usize = 128;

pub fn default_path(home: &Path) -> PathBuf {
    home.join(DEFAULT_FILE)
}

#[derive(Debug)]
enum FileProblem {
    Unreadable(String),
    Mode(u32),
    Malformed(&'static str),
    Client(String),
}

#[derive(Debug)]
pub struct TelegramFileError {
    path: PathBuf,
    problem: FileProblem,
}

impl fmt::Display for TelegramFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = self.path.display();
        match &self.problem {
            FileProblem::Unreadable(kind) => write!(formatter, "텔레그램 설정 파일 {path}을 읽을 수 없습니다: {kind}"),
            FileProblem::Mode(mode) => write!(formatter, "텔레그램 설정 파일 {path}의 권한이 {mode:o}라 다른 사용자가 읽을 수 있습니다. chmod 600 {path}"),
            FileProblem::Malformed(reason) => write!(formatter, "텔레그램 설정 파일 {path}의 형식이 틀렸습니다: {reason}. bot_token=<토큰>과 chat_id=<대화 번호>를 한 줄씩 적습니다"),
            FileProblem::Client(detail) => write!(formatter, "텔레그램용 HTTP 클라이언트를 만들지 못했습니다: {detail}"),
        }
    }
}

impl std::error::Error for TelegramFileError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendFailure {
    Transport(String),
    Status(u16),
    RateLimited,
}

impl fmt::Display for SendFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendFailure::Transport(detail) => write!(formatter, "텔레그램 요청이 실패했습니다: {detail}"),
            SendFailure::Status(code) => write!(formatter, "텔레그램이 {code} 응답을 돌려줬습니다"),
            SendFailure::RateLimited => formatter.write_str("텔레그램이 속도 제한을 풀어 주지 않아 포기했습니다"),
        }
    }
}

impl std::error::Error for SendFailure {}

#[derive(Debug)]
pub struct Telegram {
    client: reqwest::Client,
    send_message_url: Secret<String>,
    chat_id: String,
}

#[derive(Deserialize)]
struct RateLimitBody {
    parameters: Option<RateLimitParameters>,
}

#[derive(Deserialize)]
struct RateLimitParameters {
    retry_after: Option<f64>,
}

struct Settings {
    bot_token: String,
    chat_id: String,
}

fn transport_failure(error: reqwest::Error) -> SendFailure {
    SendFailure::Transport(error.without_url().to_string())
}

fn wait_from(header: Option<&str>, body: &[u8]) -> Duration {
    let from_body = serde_json::from_slice::<RateLimitBody>(body).ok().and_then(|body| body.parameters).and_then(|parameters| parameters.retry_after);
    let seconds = from_body.or_else(|| header.and_then(|text| text.trim().parse::<f64>().ok()));
    match seconds {
        Some(seconds) if seconds >= 0.0 => Duration::try_from_secs_f64(seconds).unwrap_or(Duration::MAX),
        _ => FALLBACK_WAIT,
    }
}

fn payload_with(chat_id: &str, text: &str, parse_mode: Option<&str>, disable_notification: bool) -> String {
    let text: String = text.chars().take(TEXT_LIMIT).collect();
    let mut object = serde_json::Map::new();
    object.insert("chat_id".to_owned(), serde_json::Value::String(chat_id.to_owned()));
    object.insert("text".to_owned(), serde_json::Value::String(text));
    object.insert("link_preview_options".to_owned(), serde_json::json!({ "is_disabled": true }));
    if let Some(mode) = parse_mode {
        object.insert("parse_mode".to_owned(), serde_json::Value::String(mode.to_owned()));
    }
    if disable_notification {
        object.insert("disable_notification".to_owned(), serde_json::Value::Bool(true));
    }
    serde_json::Value::Object(object).to_string()
}

#[cfg(test)]
fn payload(chat_id: &str, text: &str) -> String {
    payload_with(chat_id, text, None, false)
}

fn is_bot_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= LONGEST_BOT_TOKEN && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

fn is_chat_id(value: &str) -> bool {
    if value.len() > LONGEST_CHAT_ID {
        return false;
    }
    let digits = value.strip_prefix('-').unwrap_or(value);
    let channel_name = value.strip_prefix('@');
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())) || channel_name.is_some_and(|name| !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'))
}

fn is_blank(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\n' | '\x0B' | '\x0C' | '\r')
}

fn parse_settings(text: &str) -> Result<Settings, &'static str> {
    let mut bot_token = None;
    let mut chat_id = None;
    for line in text.lines().map(|line| line.trim_matches(is_blank)).filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once('=').ok_or("key=value 꼴이 아닌 줄이 있습니다")?;
        let slot = match key.trim_matches(is_blank) {
            "bot_token" => &mut bot_token,
            "chat_id" => &mut chat_id,
            _ => return Err("알 수 없는 키가 있습니다"),
        };
        if slot.replace(value.trim_matches(is_blank).to_owned()).is_some() {
            return Err("같은 키가 두 번 나옵니다");
        }
    }
    let bot_token = bot_token.ok_or("bot_token이 없습니다")?;
    let chat_id = chat_id.ok_or("chat_id가 없습니다")?;
    if !is_bot_token(&bot_token) {
        return Err("bot_token이 비어 있거나 쓸 수 없는 글자가 있거나 256자를 넘습니다");
    }
    if !is_chat_id(&chat_id) {
        return Err("chat_id는 128자 이하의 숫자(음수 가능)나 @이름이어야 합니다");
    }
    Ok(Settings { bot_token, chat_id })
}

impl Telegram {
    pub fn load(path: &Path) -> Result<Option<Telegram>, TelegramFileError> {
        Telegram::load_at(path, DEFAULT_API)
    }

    pub fn load_at(path: &Path, api: &str) -> Result<Option<Telegram>, TelegramFileError> {
        let problem = |problem| TelegramFileError { path: path.to_owned(), problem };
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(problem(FileProblem::Unreadable(error.to_string()))),
        };
        let metadata = file.metadata().map_err(|error| problem(FileProblem::Unreadable(error.to_string())))?;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(problem(FileProblem::Mode(mode)));
        }
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|error| problem(FileProblem::Unreadable(error.to_string())))?;
        let settings = parse_settings(&text).map_err(|reason| problem(FileProblem::Malformed(reason)))?;
        if !reqwest::Url::parse(api).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https")) {
            return Err(problem(FileProblem::Malformed("API 기준 주소가 http나 https 주소가 아닙니다")));
        }
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| problem(FileProblem::Client(error.without_url().to_string())))?;
        let send_message_url = format!("{}/bot{}/sendMessage", api.trim_end_matches('/'), settings.bot_token);
        Ok(Some(Telegram { client, send_message_url: Secret::new(send_message_url), chat_id: settings.chat_id }))
    }

    pub async fn send(&self, text: &str) -> Result<(), SendFailure> {
        self.send_formatted(text, None, false).await
    }

    pub async fn send_formatted(&self, text: &str, parse_mode: Option<&str>, disable_notification: bool) -> Result<(), SendFailure> {
        let body = payload_with(&self.chat_id, text, parse_mode, disable_notification);
        for attempt in 1..=MAX_ATTEMPTS {
            let response = self.client.post(self.send_message_url.expose()).header(CONTENT_TYPE, "application/json").body(body.clone()).send().await.map_err(transport_failure)?;
            let status = response.status();
            if status.is_success() {
                return Ok(());
            }
            if status != StatusCode::TOO_MANY_REQUESTS {
                return Err(SendFailure::Status(status.as_u16()));
            }
            let header = response.headers().get(RETRY_AFTER).and_then(|value| value.to_str().ok()).map(str::to_owned);
            let bytes = response.bytes().await.map_err(transport_failure)?;
            let wait = wait_from(header.as_deref(), &bytes);
            if attempt == MAX_ATTEMPTS || wait > LONGEST_WAIT {
                return Err(SendFailure::RateLimited);
            }
            tokio::time::sleep(wait).await;
        }
        Err(SendFailure::RateLimited)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wait_comes_from_the_body_then_the_header_then_a_default() {
        assert_eq!(wait_from(Some("3"), br#"{"ok":false,"parameters":{"retry_after":2}}"#), Duration::from_secs(2));
        assert_eq!(wait_from(Some("3"), b"not json"), Duration::from_secs(3));
        assert_eq!(wait_from(Some("3"), br#"{"parameters":{}}"#), Duration::from_secs(3));
        assert_eq!(wait_from(None, b""), FALLBACK_WAIT);
        assert_eq!(wait_from(Some("-1"), b""), FALLBACK_WAIT);
    }

    #[test]
    fn a_wait_beyond_what_a_duration_holds_counts_as_longer_than_the_limit() {
        for body in [br#"{"parameters":{"retry_after": 1e300}}"#.as_slice(), br#"{"parameters":{"retry_after": 1e19}}"#] {
            assert!(wait_from(None, body) > LONGEST_WAIT);
        }
        assert!(wait_from(Some("1e300"), b"") > LONGEST_WAIT);
    }

    #[test]
    fn the_payload_cuts_the_text_and_turns_the_link_preview_off() {
        let long = "가".repeat(TEXT_LIMIT + 10);
        let value: serde_json::Value = serde_json::from_str(&payload("-100123", &long)).unwrap();
        assert_eq!(value["text"].as_str().unwrap().chars().count(), TEXT_LIMIT);
        assert_eq!(value["chat_id"], "-100123");
        assert_eq!(value["link_preview_options"]["is_disabled"], true);
        assert!(value.get("parse_mode").is_none());
        assert!(value.get("disable_notification").is_none());

        let html: serde_json::Value = serde_json::from_str(&payload_with("-100123", "<b>알림</b>", Some("HTML"), true)).unwrap();
        assert_eq!(html["parse_mode"], "HTML");
        assert_eq!(html["disable_notification"], true);
    }

    const SETTINGS: &str = "bot_token=123456:SECRET-TOKEN\nchat_id=-100777\n";

    fn file_with(mode: u32, text: &str) -> (tempfile::TempDir, PathBuf) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("telegram");
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        (folder, path)
    }

    #[test]
    fn a_missing_file_turns_telegram_off_without_an_error() {
        let folder = tempfile::tempdir().unwrap();
        assert!(Telegram::load(&folder.path().join("telegram")).unwrap().is_none());
    }

    #[test]
    fn a_path_that_cannot_be_opened_is_an_error_but_only_a_missing_file_turns_telegram_off() {
        let folder = tempfile::tempdir().unwrap();
        let (_file_folder, file) = file_with(0o600, SETTINGS);
        let under_a_file = file.join("telegram");
        let loop_a = folder.path().join("loop-a");
        let loop_b = folder.path().join("loop-b");
        std::os::unix::fs::symlink(&loop_b, &loop_a).unwrap();
        std::os::unix::fs::symlink(&loop_a, &loop_b).unwrap();
        let (_closed_folder, closed) = file_with(0o000, SETTINGS);
        let dangling = folder.path().join("dangling");
        std::os::unix::fs::symlink(folder.path().join("nowhere"), &dangling).unwrap();
        for path in [&under_a_file, &loop_a, &closed] {
            let message = Telegram::load(path).unwrap_err().to_string();
            assert!(message.contains(&path.display().to_string()) && !message.contains("SECRET-TOKEN"), "{message}");
        }
        assert!(Telegram::load(&dangling).unwrap().is_none());
    }

    #[test]
    fn the_token_and_the_chat_have_a_longest_length() {
        let settings = |token: usize, chat: &str| format!("bot_token={}\nchat_id={chat}\n", "a".repeat(token));
        assert!(parse_settings(&settings(LONGEST_BOT_TOKEN, "1")).is_ok());
        assert!(parse_settings(&settings(LONGEST_BOT_TOKEN + 1, "1")).is_err());
        for chat in ["1".repeat(LONGEST_CHAT_ID), format!("-{}", "1".repeat(LONGEST_CHAT_ID - 1)), format!("@{}", "a".repeat(LONGEST_CHAT_ID - 1))] {
            assert!(parse_settings(&settings(1, &chat)).is_ok(), "{chat}");
            assert!(parse_settings(&settings(1, &format!("{chat}1"))).is_err(), "{chat}");
        }
    }

    #[test]
    fn a_file_other_users_can_read_is_an_error_that_does_not_show_the_token() {
        for mode in [0o644, 0o640, 0o604, 0o660] {
            let (_folder, path) = file_with(mode, SETTINGS);
            let message = Telegram::load(&path).unwrap_err().to_string();
            assert!(message.contains("chmod 600") && !message.contains("SECRET-TOKEN"), "{mode:o}: {message}");
        }
        let (_folder, path) = file_with(0o600, SETTINGS);
        assert!(Telegram::load(&path).unwrap().is_some());
        let (_folder, path) = file_with(0o400, SETTINGS);
        assert!(Telegram::load(&path).unwrap().is_some());
    }

    #[test]
    fn a_malformed_file_is_an_error_and_the_token_stays_out_of_messages_and_debug_output() {
        let malformed = [
            "  \n",
            "bot_token=123456:SECRET-TOKEN\n",
            "chat_id=1\n",
            "bot_token=123456:SECRET-TOKEN chat_id=1\n",
            "bot_token=123456:SECRET-TOKEN\nchat_id=1\nchat_id=2\n",
            "bot_token=123456:SECRET-TOKEN\nchat_id=1\nextra=x\n",
            "bot_token=123456:SECRET-TOKEN\nchat_id=abc\n",
            "bot_token=123456:SECRET/TOKEN\nchat_id=1\n",
            "bot_token=123456:SECRET-TOKEN\n123456:SECRET-MORE\nchat_id=1\n",
            "{\"bot_token\": \"123456:SECRET-TOKEN\", \"chat_id\": \"1\"}",
        ];
        for text in malformed {
            let (_folder, path) = file_with(0o600, text);
            let error = Telegram::load(&path).unwrap_err();
            let shown = format!("{error} {error:?}");
            assert!(!shown.contains("SECRET"), "{text:?}: {shown}");
        }
        let (_folder, path) = file_with(0o600, SETTINGS);
        let telegram = Telegram::load(&path).unwrap().unwrap();
        assert!(!format!("{telegram:?}").contains("SECRET-TOKEN"));
    }

    #[test]
    fn blank_lines_and_spaces_around_the_equals_sign_are_allowed() {
        let (_folder, path) = file_with(0o600, "\n bot_token = 1:a \n\nchat_id = @alerts_room\n");
        assert!(Telegram::load(&path).unwrap().is_some());
    }

    #[test]
    fn only_ascii_blanks_around_lines_keys_and_values_are_ignored() {
        let settings = parse_settings("\x0b bot_token\t=\x0c1:a\r\r\nchat_id=-100777 \n").unwrap();
        assert_eq!((settings.bot_token.as_str(), settings.chat_id.as_str()), ("1:a", "-100777"));
        for text in ["bot_token=1:a\nchat_id=-100777\u{a0}\n", "bot_token=1:a\nchat_id=-100\r777\n", "bot_token=1:a\nchat_id=-100\u{0}777\n", "bot_token=1:a\nchat_id=\nchat_id=-100777\n", "bot_token=1:a\nchat_id=-100777\n\u{3000}\n"] {
            assert!(parse_settings(text).is_err(), "{text:?}");
        }
    }
}
