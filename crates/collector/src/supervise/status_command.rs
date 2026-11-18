use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use super::api::SOCKET_FILE_NAME;
use super::status::{DaemonStatus, ObservationVerdict};
use super::wire::{API_VERSION, MAX_REPLY_BYTES, Reply, ReplyBody, Request, RequestKind};
use crate::args::{ArgSpec, Arguments};
use crate::collect::config::{Variables, default_state_folder, process_variables};

pub const SPEC: ArgSpec = ArgSpec { value_options: &["socket", "state"], flag_options: &[] };
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

pub fn socket_path(arguments: &Arguments, process: &Variables) -> Result<PathBuf, String> {
    if let Some(socket) = arguments.value("socket") {
        return Ok(PathBuf::from(socket));
    }
    let state_folder = match arguments.value("state") {
        Some(folder) => PathBuf::from(folder),
        None => default_state_folder(process).map_err(|error| error.to_string())?,
    };
    Ok(state_folder.join(SOCKET_FILE_NAME))
}

#[derive(Debug)]
pub enum AskError {
    DaemonOff,
    NoAnswer,
    VersionMismatch(u64),
    Unexpected(String),
}

fn ask(socket: &Path) -> Result<Reply, AskError> {
    let stream = UnixStream::connect(socket).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => AskError::DaemonOff,
        _ => AskError::Unexpected(format!("{}에 연결하지 못했습니다: {error}", socket.display())),
    })?;
    let timed_out = |error: io::Error| match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => AskError::NoAnswer,
        _ => AskError::Unexpected(error.to_string()),
    };
    stream.set_read_timeout(Some(ANSWER_TIMEOUT)).map_err(timed_out)?;
    stream.set_write_timeout(Some(ANSWER_TIMEOUT)).map_err(timed_out)?;
    let mut request = serde_json::to_string(&Request::new(RequestKind::Status)).expect("요청은 항상 JSON으로 바뀐다");
    request.push('\n');
    (&stream).write_all(request.as_bytes()).map_err(timed_out)?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_REPLY_BYTES)).read_line(&mut line).map_err(timed_out)?;
    if line.is_empty() {
        return Err(AskError::NoAnswer);
    }
    let value: serde_json::Value = serde_json::from_str(&line).map_err(|error| AskError::Unexpected(format!("응답을 읽을 수 없습니다: {error}")))?;
    match value.get("v").and_then(serde_json::Value::as_u64) {
        Some(version) if version == u64::from(API_VERSION) => {}
        Some(version) => return Err(AskError::VersionMismatch(version)),
        None => return Err(AskError::Unexpected("응답에 형식 버전 v가 없습니다".to_owned())),
    }
    serde_json::from_value(value).map_err(|error| AskError::Unexpected(format!("응답을 읽을 수 없습니다: {error}")))
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => return usage_error(error),
    };
    let socket = match socket_path(&arguments, &process_variables()) {
        Ok(socket) => socket,
        Err(error) => return usage_error(error),
    };
    match ask(&socket) {
        Ok(Reply { body: ReplyBody::Status { sent_at, status }, .. }) => {
            print!("{}", render(&sent_at, &status));
            ExitCode::SUCCESS
        }
        Ok(Reply { body: ReplyBody::Error { code, message, .. }, .. }) => {
            eprintln!("status: 데몬이 거절했습니다({code:?}): {message}");
            ExitCode::FAILURE
        }
        Ok(other) => {
            eprintln!("status: 예상하지 못한 응답입니다: {other:?}");
            ExitCode::FAILURE
        }
        Err(AskError::DaemonOff) => {
            println!("데몬 꺼짐 ({}에 연결할 수 없습니다)", socket.display());
            ExitCode::FAILURE
        }
        Err(AskError::NoAnswer) => {
            println!("데몬 응답 없음 ({}에 연결됐지만 {}초 안에 답이 없습니다)", socket.display(), ANSWER_TIMEOUT.as_secs());
            ExitCode::FAILURE
        }
        Err(AskError::VersionMismatch(version)) => {
            println!("형식 버전 불일치 (데몬은 v{version}, 이 명령은 v{API_VERSION}만 읽습니다. 데몬과 collector 실행 파일의 버전을 맞추세요)");
            ExitCode::FAILURE
        }
        Err(AskError::Unexpected(message)) => {
            eprintln!("status: {message}");
            ExitCode::FAILURE
        }
    }
}

fn usage_error(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("status: {message}");
    ExitCode::from(2)
}

fn display_width(text: &str) -> usize {
    text.chars().map(|character| if character as u32 >= 0x1100 { 2 } else { 1 }).sum()
}

fn row(cells: &[String], widths: &[usize]) -> String {
    let padded: Vec<String> = cells.iter().zip(widths).map(|(cell, width)| format!("{cell}{}", " ".repeat(width - display_width(cell)))).collect();
    format!("{}\n", padded.join("  ").trim_end())
}

fn table(header: &[&str], rows: &[Vec<String>]) -> String {
    let header: Vec<String> = header.iter().map(|cell| (*cell).to_owned()).collect();
    let widths: Vec<usize> = (0..header.len()).map(|column| std::iter::once(&header).chain(rows).map(|cells| display_width(&cells[column])).max().unwrap_or(0)).collect();
    std::iter::once(&header).chain(rows).map(|cells| row(cells, &widths)).collect()
}

pub fn render(sent_at: &str, status: &DaemonStatus) -> String {
    let today = &status.today;
    let mut text = format!("수집 상태 {} · {} · {sent_at}\n", status.date, status.phase.label());
    text += &format!(
        "계획 {} · 받는 중 {} · 등록 실패 {}묶음 · 끊김 {} · 인계됨 {} · 제외 {} (종목 수)\n",
        today.planned_stocks, today.receiving_stocks, today.register_failed_batches, today.disconnected_stocks, today.handed_off_stocks, today.excluded_stocks
    );
    if let Some(observation) = &status.observation_day {
        let verdict = match observation.verdict {
            ObservationVerdict::Observed => "관측일",
            ObservationVerdict::NotObserved => "관측일 아님",
            ObservationVerdict::Unknown => "모름",
        };
        text += &format!("관측일 판단: {verdict} ({})\n", observation.reasons.join(", "));
    }
    text.push('\n');
    let keys: Vec<Vec<String>> = status
        .keys
        .iter()
        .map(|key| {
            vec![
                key.name.to_string(),
                key.app_key_hash_prefix.clone(),
                format!("{:?}", key.role).to_lowercase(),
                key.state.label().to_owned(),
                key.stocks.to_string(),
                key.messages_per_second.map_or_else(|| "-".to_owned(), |rate| format!("{rate:.1}")),
                format!("{}/{}", key.rest.finished_jobs, key.rest.planned_jobs),
                key.register_failures.to_string(),
                key.restarts.to_string(),
            ]
        })
        .collect();
    text += &table(&["키", "해시", "역할", "상태", "종목", "초당", "REST", "등록실패", "재시작"], &keys);
    if !status.alerts.is_empty() {
        text += "\n경보\n";
        let alerts: Vec<Vec<String>> = status.alerts.iter().map(|alert| vec![alert.at.clone(), alert.message.clone()]).collect();
        text += &table(&["시각", "내용"], &alerts);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervise::status::{Alert, AlertKind, DayPhase, KeyState, KeyStatus, RestProgress, Today};
    use crate::keys::KeyRole;
    use crate::protocol::KeyName;

    #[test]
    fn the_table_shows_the_summary_keys_and_alerts() {
        let status = DaemonStatus {
            date: 20261118,
            phase: DayPhase::Collecting,
            today: Today { planned_stocks: 6, receiving_stocks: 3, ..Today::default() },
            keys: vec![KeyStatus {
                name: KeyName::parse("collect-01").unwrap(),
                app_key_hash_prefix: "1a2b3c4d".to_owned(),
                role: KeyRole::Collecting,
                state: KeyState::Receiving,
                stocks: 3,
                messages_per_second: Some(10.0),
                register_failures: 0,
                restarts: 1,
                rest: RestProgress::default(),
            }],
            alerts: vec![Alert { at: "2026-11-18T09:00:00+09:00".to_owned(), kind: AlertKind::Handoff, message: "인계했습니다".to_owned() }],
            ..DaemonStatus::default()
        };
        let text = render("2026-11-18T09:00:05+09:00", &status);
        assert!(text.starts_with("수집 상태 20261118 · 장중 수집 · "), "{text}");
        assert!(text.contains("계획 6 · 받는 중 3"), "{text}");
        let key_line = text.lines().find(|line| line.starts_with("collect-01")).unwrap();
        assert!(key_line.contains("1a2b3c4d") && key_line.contains("받는 중") && key_line.contains("10.0"), "{key_line}");
        assert!(text.contains("경보") && text.contains("인계했습니다"), "{text}");
    }
}
