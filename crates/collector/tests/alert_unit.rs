use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use serde_json::Value;

const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../deploy/systemd/vally-collector-alert-webhook");
const UNIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../deploy/systemd/vally-collector-alert.service");
const SECRET: &str = "WEBHOOK-TOKEN-do-not-print";

struct Hook {
    port: u16,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
}

fn serve(answers: Vec<&'static str>) -> Hook {
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
    Hook { port, requests }
}

const ACCEPTED: &str = "HTTP/1.1 204 No Content\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const RATE_LIMITED: &str = "HTTP/1.1 429 Too Many Requests\r\nretry-after: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const NOT_FOUND: &str = "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

struct Run {
    output: Output,
    arguments_given_to_curl: String,
}

fn write_private(path: &Path, text: &str, mode: u32) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn run_script(folder: &Path, message: &str, address_file: Option<(&str, u32)>) -> Run {
    let shim_folder = folder.join("shim");
    std::fs::create_dir_all(&shim_folder).unwrap();
    let argument_log = folder.join("curl-arguments");
    write_private(&shim_folder.join("curl"), &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> {}\nexec /usr/bin/curl \"$@\"\n", argument_log.display()), 0o755);
    let file: PathBuf = folder.join("discord-webhook");
    if let Some((text, mode)) = address_file {
        write_private(&file, text, mode);
    }
    let output = Command::new(SCRIPT)
        .arg(message)
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", shim_folder.display()))
        .env("HOME", folder)
        .env("VALLY_DISCORD_WEBHOOK", &file)
        .output()
        .unwrap();
    Run { output, arguments_given_to_curl: std::fs::read_to_string(&argument_log).unwrap_or_default() }
}

fn address(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/webhooks/123/{SECRET}\n")
}

fn unit_message() -> String {
    let unit = std::fs::read_to_string(UNIT).unwrap();
    assert!(unit.contains("Environment=VALLY_DISCORD_WEBHOOK=%h/.config/vally/discord-webhook"));
    let line = unit.lines().find(|line| line.starts_with("ExecStart=%h/.local/bin/vally-collector-alert-webhook ")).expect("경보 유닛이 웹훅 스크립트를 부른다");
    line.split_once(' ').unwrap().1.trim().trim_matches('"').to_owned()
}

fn everything_printed(run: &Run) -> String {
    format!("{}{}{}", String::from_utf8_lossy(&run.output.stdout), String::from_utf8_lossy(&run.output.stderr), run.arguments_given_to_curl)
}

#[test]
fn the_alert_unit_sends_its_message_to_the_fake_webhook_and_waits_out_a_rate_limit() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![RATE_LIMITED, ACCEPTED]);
    let message = unit_message();
    let run = run_script(folder.path(), &message, Some((&address(hook.port), 0o600)));
    assert!(run.output.status.success(), "{}", String::from_utf8_lossy(&run.output.stderr));
    let requests = hook.requests.lock().unwrap();
    assert_eq!(requests.len(), 2, "429 뒤 다시 보낸다");
    for (path, body) in requests.iter() {
        assert_eq!(path, &format!("/api/webhooks/123/{SECRET}"));
        assert_eq!(body["content"], message.as_str());
        assert_eq!(body["allowed_mentions"]["parse"], serde_json::json!([]));
    }
    let printed = everything_printed(&run);
    assert!(!printed.contains(SECRET) && !printed.contains(&hook.port.to_string()), "주소가 명령줄이나 출력에 나온다: {printed}");
}

#[test]
fn quotes_and_backslashes_in_the_message_stay_valid_json() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let message = r#"끝났다 "따옴표" \ 역슬래시"#;
    let run = run_script(folder.path(), message, Some((&address(hook.port), 0o600)));
    assert!(run.output.status.success(), "{}", String::from_utf8_lossy(&run.output.stderr));
    assert_eq!(hook.requests.lock().unwrap()[0].1["content"], message);
}

#[test]
fn a_file_other_users_can_read_stops_the_script_before_any_request() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let run = run_script(folder.path(), "메시지", Some((&address(hook.port), 0o644)));
    assert!(!run.output.status.success());
    let printed = everything_printed(&run);
    assert!(printed.contains("chmod 600") && !printed.contains(SECRET), "{printed}");
    assert!(hook.requests.lock().unwrap().is_empty());
}

#[test]
fn a_missing_file_turns_the_webhook_off_without_failing_the_unit() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![ACCEPTED]);
    let run = run_script(folder.path(), "메시지", None);
    assert!(run.output.status.success());
    assert!(hook.requests.lock().unwrap().is_empty());
}

#[test]
fn a_refusing_webhook_fails_the_script_without_printing_the_address() {
    let folder = tempfile::tempdir().unwrap();
    let hook = serve(vec![NOT_FOUND]);
    let run = run_script(folder.path(), "메시지", Some((&address(hook.port), 0o600)));
    assert!(!run.output.status.success());
    let printed = everything_printed(&run);
    assert!(!printed.contains(SECRET) && !printed.contains("/api/webhooks"), "{printed}");
}
