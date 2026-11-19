use std::fmt;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::{CONTENT_TYPE, RETRY_AFTER};
use serde::Deserialize;

use crate::config::Secret;

pub const DEFAULT_FILE: &str = ".config/vally/discord-webhook";
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_ATTEMPTS: u32 = 4;
pub const LONGEST_WAIT: Duration = Duration::from_secs(60);
const FALLBACK_WAIT: Duration = Duration::from_secs(1);
const CONTENT_LIMIT: usize = 2000;

pub fn default_path(home: &Path) -> PathBuf {
    home.join(DEFAULT_FILE)
}

#[derive(Debug)]
enum FileProblem {
    Unreadable(String),
    Mode(u32),
    Empty,
    NotHttp,
    Client(String),
}

#[derive(Debug)]
pub struct WebhookFileError {
    path: PathBuf,
    problem: FileProblem,
}

impl fmt::Display for WebhookFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = self.path.display();
        match &self.problem {
            FileProblem::Unreadable(kind) => write!(formatter, "웹훅 주소 파일 {path}을 읽을 수 없습니다: {kind}"),
            FileProblem::Mode(mode) => write!(formatter, "웹훅 주소 파일 {path}의 권한이 {mode:o}라 다른 사용자가 읽을 수 있습니다. chmod 600 {path}"),
            FileProblem::Empty => write!(formatter, "웹훅 주소 파일 {path}이 비어 있습니다"),
            FileProblem::NotHttp => write!(formatter, "웹훅 주소 파일 {path}의 내용이 http나 https 주소가 아닙니다"),
            FileProblem::Client(detail) => write!(formatter, "웹훅용 HTTP 클라이언트를 만들지 못했습니다: {detail}"),
        }
    }
}

impl std::error::Error for WebhookFileError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendFailure {
    Transport(String),
    Status(u16),
    RateLimited,
}

impl fmt::Display for SendFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendFailure::Transport(detail) => write!(formatter, "웹훅 요청이 실패했습니다: {detail}"),
            SendFailure::Status(code) => write!(formatter, "웹훅이 {code} 응답을 돌려줬습니다"),
            SendFailure::RateLimited => formatter.write_str("웹훅이 속도 제한을 풀어 주지 않아 포기했습니다"),
        }
    }
}

impl std::error::Error for SendFailure {}

#[derive(Debug)]
pub struct Webhook {
    client: reqwest::Client,
    url: Secret<String>,
}

#[derive(Deserialize)]
struct RateLimitBody {
    retry_after: Option<f64>,
}

fn transport_failure(error: reqwest::Error) -> SendFailure {
    SendFailure::Transport(error.without_url().to_string())
}

fn wait_from(header: Option<&str>, body: &[u8]) -> Duration {
    let seconds = serde_json::from_slice::<RateLimitBody>(body).ok().and_then(|body| body.retry_after).or_else(|| header.and_then(|text| text.trim().parse::<f64>().ok()));
    match seconds {
        Some(seconds) if seconds >= 0.0 => Duration::try_from_secs_f64(seconds).unwrap_or(Duration::MAX),
        _ => FALLBACK_WAIT,
    }
}

fn payload(text: &str) -> String {
    let content: String = text.chars().take(CONTENT_LIMIT).collect();
    serde_json::json!({ "content": content, "allowed_mentions": { "parse": [] } }).to_string()
}

impl Webhook {
    pub fn load(path: &Path) -> Result<Option<Webhook>, WebhookFileError> {
        let problem = |problem| WebhookFileError { path: path.to_owned(), problem };
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(problem(FileProblem::Unreadable(error.kind().to_string()))),
        };
        let metadata = file.metadata().map_err(|error| problem(FileProblem::Unreadable(error.kind().to_string())))?;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(problem(FileProblem::Mode(mode)));
        }
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|error| problem(FileProblem::Unreadable(error.kind().to_string())))?;
        let url = text.trim();
        if url.is_empty() {
            return Err(problem(FileProblem::Empty));
        }
        if !reqwest::Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https")) {
            return Err(problem(FileProblem::NotHttp));
        }
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| problem(FileProblem::Client(error.without_url().to_string())))?;
        Ok(Some(Webhook { client, url: Secret::new(url.to_owned()) }))
    }

    pub async fn send(&self, text: &str) -> Result<(), SendFailure> {
        let body = payload(text);
        for attempt in 1..=MAX_ATTEMPTS {
            let response = self.client.post(self.url.expose()).header(CONTENT_TYPE, "application/json").body(body.clone()).send().await.map_err(transport_failure)?;
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
        assert_eq!(wait_from(Some("3"), br#"{"retry_after": 0.25}"#), Duration::from_millis(250));
        assert_eq!(wait_from(Some("3"), b"not json"), Duration::from_secs(3));
        assert_eq!(wait_from(None, b""), FALLBACK_WAIT);
        assert_eq!(wait_from(Some("-1"), b""), FALLBACK_WAIT);
    }

    #[test]
    fn a_wait_beyond_what_a_duration_holds_counts_as_longer_than_the_limit() {
        for body in [br#"{"retry_after": 1e300}"#.as_slice(), br#"{"retry_after": 1e19}"#] {
            assert!(wait_from(None, body) > LONGEST_WAIT);
        }
        assert!(wait_from(Some("1e300"), b"") > LONGEST_WAIT);
    }

    #[test]
    fn the_payload_cuts_the_text_and_turns_mentions_off() {
        let long = "가".repeat(CONTENT_LIMIT + 10);
        let value: serde_json::Value = serde_json::from_str(&payload(&long)).unwrap();
        assert_eq!(value["content"].as_str().unwrap().chars().count(), CONTENT_LIMIT);
        assert_eq!(value["allowed_mentions"]["parse"], serde_json::json!([]));
    }

    const ADDRESS: &str = "https://discord.com/api/webhooks/123/SECRET-TOKEN";

    fn file_with(mode: u32, text: &str) -> (tempfile::TempDir, PathBuf) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("discord-webhook");
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        (folder, path)
    }

    #[test]
    fn a_missing_file_turns_the_webhook_off_without_an_error() {
        let folder = tempfile::tempdir().unwrap();
        assert!(Webhook::load(&folder.path().join("discord-webhook")).unwrap().is_none());
    }

    #[test]
    fn a_file_other_users_can_read_is_an_error_that_does_not_show_the_address() {
        for mode in [0o644, 0o640, 0o604, 0o660] {
            let (_folder, path) = file_with(mode, ADDRESS);
            let message = Webhook::load(&path).unwrap_err().to_string();
            assert!(message.contains("chmod 600") && !message.contains("SECRET-TOKEN"), "{mode:o}: {message}");
        }
        let (_folder, path) = file_with(0o600, ADDRESS);
        assert!(Webhook::load(&path).unwrap().is_some());
        let (_folder, path) = file_with(0o400, ADDRESS);
        assert!(Webhook::load(&path).unwrap().is_some());
    }

    #[test]
    fn an_empty_or_non_http_file_is_an_error_and_the_address_stays_out_of_debug_output() {
        for text in ["  \n", "ftp://example.com/hook", "not a url SECRET-TOKEN"] {
            let (_folder, path) = file_with(0o600, text);
            let message = Webhook::load(&path).unwrap_err().to_string();
            assert!(!message.contains("SECRET-TOKEN"), "{message}");
        }
        let (_folder, path) = file_with(0o600, ADDRESS);
        let webhook = Webhook::load(&path).unwrap().unwrap();
        assert!(!format!("{webhook:?}").contains("SECRET-TOKEN"));
    }
}
