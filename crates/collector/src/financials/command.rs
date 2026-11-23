use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use super::config::{COMMAND_SPEC, socket_path};
use super::render::lines;
use super::wire::{Command, MAX_REPLY_BYTES, Reply, Request, VERSION};
use crate::args::Arguments;
use crate::collect::config::process_variables;

const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
const OFF: &str = "재무 수집 프로세스가 꺼져 있습니다";

enum AskError {
    Off,
    Other(String),
}

fn ask(socket: &Path, command: Command) -> Result<Reply, AskError> {
    let stream = UnixStream::connect(socket).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => AskError::Off,
        _ => AskError::Other(format!("{}에 연결하지 못했습니다: {error}", socket.display())),
    })?;
    let failed = |error: io::Error| AskError::Other(format!("재무 수집 프로세스와 통신하지 못했습니다: {error}"));
    stream.set_read_timeout(Some(ANSWER_TIMEOUT)).map_err(failed)?;
    stream.set_write_timeout(Some(ANSWER_TIMEOUT)).map_err(failed)?;
    let mut request = serde_json::to_string(&Request { v: VERSION, command }).expect("요청은 항상 JSON으로 바뀐다");
    request.push('\n');
    (&stream).write_all(request.as_bytes()).map_err(failed)?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_REPLY_BYTES)).read_line(&mut line).map_err(failed)?;
    if line.is_empty() {
        return Err(AskError::Other("재무 수집 프로세스가 답하지 않고 연결을 닫았습니다".to_owned()));
    }
    serde_json::from_str(&line).map_err(|error| AskError::Other(format!("응답을 읽을 수 없습니다. collector 실행 파일과 재무 프로세스의 버전을 맞추세요: {error}")))
}

fn command_of(name: &str) -> Command {
    match name {
        "start" => Command::Start,
        "pause" => Command::Pause,
        "resume" => Command::Resume,
        _ => Command::Status,
    }
}

pub fn run(name: &str, raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &COMMAND_SPEC) {
        Ok(arguments) => arguments,
        Err(error) => return usage_error(name, error),
    };
    if arguments.flag("json") && name != "status" {
        return usage_error(name, "--json은 status에서만 씁니다");
    }
    let socket = match socket_path(&arguments, &process_variables()) {
        Ok(socket) => socket,
        Err(error) => return usage_error(name, error),
    };
    match ask(&socket, command_of(name)) {
        Ok(reply) => {
            if arguments.flag("json") {
                println!("{}", serde_json::to_string(&reply).expect("응답은 항상 JSON으로 바뀐다"));
            } else {
                print!("{}", lines(&reply));
            }
            match &reply.refused {
                Some(reason) => {
                    eprintln!("{name}: {reason}");
                    ExitCode::FAILURE
                }
                None => ExitCode::SUCCESS,
            }
        }
        Err(AskError::Off) => {
            eprintln!("{name}: {OFF} ({}에 연결할 수 없습니다)", socket.display());
            ExitCode::FAILURE
        }
        Err(AskError::Other(message)) => {
            eprintln!("{name}: {message}");
            ExitCode::FAILURE
        }
    }
}

fn usage_error(name: &str, message: impl std::fmt::Display) -> ExitCode {
    eprintln!("{name}: {message}");
    ExitCode::from(2)
}
