use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use serde_json::Value;

const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../deploy/systemd/vally-collector-alert-telegram");
const UNIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../deploy/systemd/vally-collector-alert.service");
const SECRET: &str = "TELEGRAM-TOKEN-do-not-print";
const CHAT_ID: &str = "-100777";

struct FakeTelegram {
    port: u16,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
}

fn serve(answers: Vec<&'static str>) -> FakeTelegram {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let log = requests.clone();
    std::thread::spawn(move || {
        for answer in answers {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let path = request_line.split_whitespace().nth(1).unwrap().to_owned();
            log.lock().unwrap().push((path, serde_json::from_slice(&body).unwrap()));
            stream.write_all(answer.as_bytes()).unwrap();
        }
    });
    FakeTelegram { port, requests }
}

const ACCEPTED: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}";
const RATE_LIMITED: &str = "HTTP/1.1 429 Too Many Requests\r\nretry-after: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const RATE_LIMITED_FOR_HOURS: &str = "HTTP/1.1 429 Too Many Requests\r\nretry-after: 9999\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const NOT_FOUND: &str = "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

struct Run {
    output: Output,
    arguments_given_to_curl: String,
}

fn write_private(path: &Path, text: &str, mode: u32) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn run_script(folder: &Path, message: &str, settings_file: Option<(&str, u32)>, api_port: u16) -> Run {
    let shim_folder = folder.join("shim");
    std::fs::create_dir_all(&shim_folder).unwrap();
    let argument_log = folder.join("curl-arguments");
    write_private(&shim_folder.join("curl"), &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> {}\nexec /usr/bin/curl \"$@\"\n", argument_log.display()), 0o755);
    let file: PathBuf = folder.join("telegram");
    if let Some((text, mode)) = settings_file {
        write_private(&file, text, mode);
    }
    let output = Command::new(SCRIPT)
        .arg(message)
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", shim_folder.display()))
        .env("HOME", folder)
        .env("VALLY_TELEGRAM", &file)
        .env("VALLY_TELEGRAM_API", format!("http://127.0.0.1:{api_port}"))
        .output()
        .unwrap();
    Run { output, arguments_given_to_curl: std::fs::read_to_string(&argument_log).unwrap_or_default() }
}

fn settings() -> String {
    format!("bot_token=123456:{SECRET}\nchat_id={CHAT_ID}\n")
}

fn send_message_path() -> String {
    format!("/bot123456:{SECRET}/sendMessage")
}

fn unit_message() -> String {
    let unit = std::fs::read_to_string(UNIT).unwrap();
    assert!(unit.contains("Environment=VALLY_TELEGRAM=%h/.config/vally/telegram"));
    let line = unit.lines().find(|line| line.starts_with("ExecStart=%h/.local/bin/vally-collector-alert-telegram ")).expect("경보 유닛이 텔레그램 스크립트를 부른다");
    line.split_once(' ').unwrap().1.trim().trim_matches('"').to_owned()
}

fn everything_printed(run: &Run) -> String {
    format!("{}{}{}", String::from_utf8_lossy(&run.output.stdout), String::from_utf8_lossy(&run.output.stderr), run.arguments_given_to_curl)
}

#[test]
fn the_alert_unit_sends_its_message_to_the_fake_telegram_and_waits_out_a_rate_limit() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![RATE_LIMITED, ACCEPTED]);
    let message = unit_message();
    let run = run_script(folder.path(), &message, Some((&settings(), 0o600)), hook.port);
    assert!(run.output.status.success(), "{}", String::from_utf8_lossy(&run.output.stderr));
    let requests = hook.requests.lock().unwrap();
    assert_eq!(requests.len(), 2, "429 뒤 다시 보낸다");
    for (path, body) in requests.iter() {
        assert_eq!(path, &send_message_path());
        assert_eq!(body["chat_id"], CHAT_ID);
        assert_eq!(body["text"], message.as_str());
        assert_eq!(body["link_preview_options"]["is_disabled"], true);
        assert!(body.get("parse_mode").is_none());
    }
    let printed = everything_printed(&run);
    assert!(!printed.contains(SECRET) && !printed.contains(&hook.port.to_string()), "주소가 명령줄이나 출력에 나온다: {printed}");
}

#[test]
fn quotes_and_backslashes_in_the_message_stay_valid_json() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let message = r#"끝났다 "따옴표" \ 역슬래시"#;
    let run = run_script(folder.path(), message, Some((&settings(), 0o600)), hook.port);
    assert!(run.output.status.success(), "{}", String::from_utf8_lossy(&run.output.stderr));
    assert_eq!(hook.requests.lock().unwrap()[0].1["text"], message);
}

#[test]
fn a_file_other_users_can_read_stops_the_script_before_any_request() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let run = run_script(folder.path(), "메시지", Some((&settings(), 0o644)), hook.port);
    assert!(!run.output.status.success());
    let printed = everything_printed(&run);
    assert!(printed.contains("chmod 600") && !printed.contains(SECRET), "{printed}");
    assert!(hook.requests.lock().unwrap().is_empty());
}

#[test]
fn a_missing_file_turns_telegram_off_without_failing_the_unit() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let run = run_script(folder.path(), "메시지", None, hook.port);
    assert!(run.output.status.success());
    assert!(hook.requests.lock().unwrap().is_empty());
}

#[test]
fn a_refusing_telegram_fails_the_script_without_printing_the_token() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![NOT_FOUND]);
    let run = run_script(folder.path(), "메시지", Some((&settings(), 0o600)), hook.port);
    assert!(!run.output.status.success());
    let printed = everything_printed(&run);
    assert!(!printed.contains(SECRET) && !printed.contains("/bot"), "{printed}");
}

#[test]
fn a_rate_limit_that_will_not_lift_fails_the_script() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![RATE_LIMITED_FOR_HOURS]);
    let run = run_script(folder.path(), "메시지", Some((&settings(), 0o600)), hook.port);
    assert!(!run.output.status.success(), "보내지 못했는데 성공으로 끝났다");
    let printed = everything_printed(&run);
    assert!(printed.contains("보내지 못했습니다") && !printed.contains(SECRET) && !printed.contains("/bot"), "{printed}");
    assert_eq!(hook.requests.lock().unwrap().len(), 1);
}

#[test]
fn newlines_tabs_and_control_characters_in_the_message_stay_valid_json() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let message = "첫 줄\n둘째\t줄\r\n\u{1}끝 \"따옴표\" \\";
    let run = run_script(folder.path(), message, Some((&settings(), 0o600)), hook.port);
    assert!(run.output.status.success(), "{}", String::from_utf8_lossy(&run.output.stderr));
    assert_eq!(hook.requests.lock().unwrap()[0].1["text"], message);
}

#[test]
fn a_malformed_file_stops_the_script_before_any_request_and_the_token_stays_out_of_the_output() {
    let malformed = [
        format!("bot_token=123456:{SECRET}\n"),
        format!("chat_id={CHAT_ID}\n"),
        format!("bot_token=123456:{SECRET}\nchat_id={CHAT_ID}\nchat_id=1\n"),
        format!("bot_token=123456:{SECRET}\nchat_id={CHAT_ID}\nbot_token=7:SECOND-TOKEN\n"),
        format!("bot_token=123456:{SECRET}\nchat_id={CHAT_ID}\nextra=1\n"),
        format!("bot_token=123456:{SECRET}\n7:SECOND-TOKEN\nchat_id={CHAT_ID}\n"),
        format!("bot_token=123456:{SECRET}/x\nchat_id={CHAT_ID}\n"),
        format!("bot_token=123456:{SECRET} chat_id={CHAT_ID}\n"),
        format!("bot_token=123456:{SECRET}\nchat_id=abc\n"),
        format!("{{\"bot_token\": \"123456:{SECRET}\", \"chat_id\": \"{CHAT_ID}\"}}\n"),
        "\n  \n".to_owned(),
    ];
    for text in malformed {
        let folder = tempfile::tempdir().unwrap();
        let hook = serve(vec![ACCEPTED]);
        let run = run_script(folder.path(), "메시지", Some((&text, 0o600)), hook.port);
        assert!(!run.output.status.success(), "{text:?}");
        let printed = everything_printed(&run);
        assert!(!printed.contains(SECRET) && !printed.contains("SECOND-TOKEN"), "{text:?}: {printed}");
        assert!(hook.requests.lock().unwrap().is_empty(), "{text:?}");
    }
}

#[test]
fn blank_lines_spaces_and_a_username_chat_are_fine() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let text = format!("\n bot_token = 123456:{SECRET} \n\nchat_id = @alerts_room\n  \n");
    let run = run_script(folder.path(), "메시지", Some((&text, 0o600)), hook.port);
    assert!(run.output.status.success(), "{}", String::from_utf8_lossy(&run.output.stderr));
    assert_eq!(hook.requests.lock().unwrap()[0].1["chat_id"], "@alerts_room");
}
