use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
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

enum Layout {
    File,
    SymlinkToFile,
    NoAccess,
    SymlinkLoop,
    UnderAFile,
    Directory,
    Socket,
    Missing,
    DanglingSymlink,
    Relative(&'static str),
    MissingRelative(&'static str),
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Sends(String),
    TurnsOff,
    Fails,
}

struct Case {
    name: &'static str,
    text: String,
    layout: Layout,
    outcome: Outcome,
}

fn case(name: &'static str, text: &str, layout: Layout, outcome: Outcome) -> Case {
    Case { name, text: text.to_owned(), layout, outcome }
}

fn sends(chat_id: &str) -> Outcome {
    Outcome::Sends(chat_id.to_owned())
}

fn permission_000_still_reads() -> bool {
    let folder = tempfile::tempdir().unwrap();
    let file = folder.path().join("closed");
    write_private(&file, "", 0o000);
    std::fs::File::open(&file).is_ok()
}

fn parity_cases() -> Vec<Case> {
    let token = format!("bot_token=123456:{SECRET}\n");
    let two_lines = format!("{token}chat_id=-100777\n");
    let with_token_of = |length: usize| format!("bot_token={}\nchat_id=-100777\n", "a".repeat(length));
    let with_chat_of = |chat_id: String| format!("{token}chat_id={chat_id}\n");
    vec![
        case("정상 두 줄", &two_lines, Layout::File, sends("-100777")),
        case("600 파일을 가리키는 심볼릭 링크", &two_lines, Layout::SymlinkToFile, sends("-100777")),
        case("값 끝의 NBSP", &format!("{token}chat_id=-100777\u{a0}\n"), Layout::File, Outcome::Fails),
        case("값 끝의 전각 공백", &format!("{token}chat_id=-100777\u{3000}\n"), Layout::File, Outcome::Fails),
        case("값 끝의 탭과 수직 탭", &format!("{token}chat_id=-100777\t\x0b\n"), Layout::File, sends("-100777")),
        case("줄 안의 CR", &format!("{token}chat_id=-100\r777\n"), Layout::File, Outcome::Fails),
        case("CRLF 줄 끝", &format!("bot_token=123456:{SECRET}\r\nchat_id=-100777\r\n"), Layout::File, sends("-100777")),
        case("줄 안의 NUL", &format!("{token}chat_id=-100\u{0}777\n"), Layout::File, Outcome::Fails),
        case("값 끝의 NUL", &format!("{token}chat_id=-100777\0\n"), Layout::File, Outcome::Fails),
        case("빈 첫 값 뒤의 중복 키", &format!("{token}chat_id=\nchat_id=-100777\n"), Layout::File, Outcome::Fails),
        case("빈 첫 토큰 뒤의 중복 키", &format!("bot_token=\n{token}chat_id=-100777\n"), Layout::File, Outcome::Fails),
        case("파일이 없다", &two_lines, Layout::Missing, Outcome::TurnsOff),
        case("가리키는 곳이 없는 심볼릭 링크", &two_lines, Layout::DanglingSymlink, Outcome::TurnsOff),
        case("권한 000 파일", &two_lines, Layout::NoAccess, if permission_000_still_reads() { sends("-100777") } else { Outcome::Fails }),
        case("심볼릭 링크 고리", &two_lines, Layout::SymlinkLoop, Outcome::Fails),
        case("경로 중간이 파일", &two_lines, Layout::UnderAFile, Outcome::Fails),
        case("디렉터리", &two_lines, Layout::Directory, Outcome::Fails),
        case("소켓 파일", &two_lines, Layout::Socket, Outcome::Fails),
        case("-로 시작하는 상대 경로", &two_lines, Layout::Relative("-telegram"), sends("-100777")),
        case("이름이 -뿐인 상대 경로", &two_lines, Layout::Relative("-"), sends("-100777")),
        case("-로 시작하는 없는 상대 경로", &two_lines, Layout::MissingRelative("-nothing-here"), Outcome::TurnsOff),
        case("이름이 -뿐인 없는 상대 경로", &two_lines, Layout::MissingRelative("-"), Outcome::TurnsOff),
        case("상한 길이의 토큰", &with_token_of(256), Layout::File, sends("-100777")),
        case("상한을 넘는 토큰", &with_token_of(257), Layout::File, Outcome::Fails),
        case("수만 자 토큰", &with_token_of(40_000), Layout::File, Outcome::Fails),
        case("상한 길이의 숫자 chat_id", &with_chat_of("1".repeat(128)), Layout::File, sends(&"1".repeat(128))),
        case("상한 길이의 음수 chat_id", &with_chat_of(format!("-{}", "1".repeat(127))), Layout::File, sends(&format!("-{}", "1".repeat(127)))),
        case("상한 길이의 @이름 chat_id", &with_chat_of(format!("@{}", "a".repeat(127))), Layout::File, sends(&format!("@{}", "a".repeat(127)))),
        case("상한을 넘는 chat_id", &with_chat_of("1".repeat(129)), Layout::File, Outcome::Fails),
        case("수십만 자 chat_id", &with_chat_of("1".repeat(300_000)), Layout::File, Outcome::Fails),
    ]
}

fn place(folder: &Path, case: &Case) -> PathBuf {
    let target = folder.join("target");
    std::fs::write(&target, case.text.as_bytes()).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    match case.layout {
        Layout::File => target,
        Layout::SymlinkToFile => {
            let link = folder.join("link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            link
        }
        Layout::NoAccess => {
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o000)).unwrap();
            target
        }
        Layout::SymlinkLoop => {
            let (first, second) = (folder.join("loop-a"), folder.join("loop-b"));
            std::os::unix::fs::symlink(&second, &first).unwrap();
            std::os::unix::fs::symlink(&first, &second).unwrap();
            first
        }
        Layout::UnderAFile => target.join("telegram"),
        Layout::Directory => {
            let directory = folder.join("directory");
            std::fs::create_dir(&directory).unwrap();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
            directory
        }
        Layout::Socket => {
            let socket = folder.join("socket");
            let folder_handle = std::fs::File::open(folder).unwrap();
            drop(UnixListener::bind(format!("/proc/self/fd/{}/socket", folder_handle.as_raw_fd())).unwrap());
            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
            socket
        }
        Layout::Missing => folder.join("nothing-here"),
        Layout::DanglingSymlink => {
            let link = folder.join("dangling");
            std::os::unix::fs::symlink(folder.join("nothing-here"), &link).unwrap();
            link
        }
        Layout::Relative(name) => {
            std::fs::rename(&target, folder.join(name)).unwrap();
            PathBuf::from(name)
        }
        Layout::MissingRelative(name) => PathBuf::from(name),
    }
}

fn observed(case: &Case, requests: &Mutex<Vec<(String, Value)>>, loaded: Result<bool, String>) -> Outcome {
    match (loaded, requests.lock().unwrap().first()) {
        (Ok(_), Some((_, body))) => Outcome::Sends(body["chat_id"].as_str().unwrap().to_owned()),
        (Ok(false), None) => Outcome::TurnsOff,
        (Ok(true), None) => panic!("{}: 켜졌는데 보내지 않았다", case.name),
        (Err(message), _) => {
            assert!(!message.contains(SECRET), "{}: 오류 문구에 토큰이 나온다: {message}", case.name);
            Outcome::Fails
        }
    }
}

fn fake_for(case: &Case) -> FakeTelegram {
    serve(if matches!(case.outcome, Outcome::Sends(_)) { vec![ACCEPTED] } else { vec![] })
}

fn phrase_for_a_file_that_cannot_be_opened(layout: &Layout) -> Option<&'static str> {
    match layout {
        Layout::SymlinkLoop | Layout::UnderAFile | Layout::Directory => Some("을 열 수 없습니다"),
        Layout::NoAccess | Layout::Socket => Some("을 읽을 수 없습니다"),
        _ => None,
    }
}

fn utf8_locale() -> Option<String> {
    let listed = Command::new("locale").arg("-a").output().ok()?;
    let names = String::from_utf8_lossy(&listed.stdout).into_owned();
    ["C.utf8", "C.UTF-8", "en_US.utf8", "ko_KR.utf8"].into_iter().find(|wanted| names.lines().any(|name| name == *wanted)).map(str::to_owned)
}

fn script_outcome(case: &Case) -> Outcome {
    script_outcome_in_locale(case, None)
}

fn script_outcome_in_locale(case: &Case, locale: Option<&str>) -> Outcome {
    let folder = tempfile::tempdir().unwrap();
    let file = place(folder.path(), case);
    let hook = fake_for(case);
    let mut command = Command::new(SCRIPT);
    command
        .arg("메시지")
        .current_dir(folder.path())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", folder.path())
        .env("VALLY_TELEGRAM", &file)
        .env("VALLY_TELEGRAM_API", format!("http://127.0.0.1:{}", hook.port));
    if let Some(locale) = locale {
        command.env("LANG", locale).env("LC_ALL", locale);
    }
    let output = command.output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let loaded = if output.status.success() { Ok(!hook.requests.lock().unwrap().is_empty()) } else { Err(stderr.clone()) };
    if let Err(message) = &loaded {
        assert!(message.contains(&file.display().to_string()), "{}: 오류 문구에 경로가 없다: {message}", case.name);
        if let Some(phrase) = phrase_for_a_file_that_cannot_be_opened(&case.layout) {
            assert!(message.contains(phrase), "{}: 오류 문구가 \"{phrase}\"이 아니다: {message}", case.name);
            assert!(message.lines().count() == 1 && !message.contains("bot_token"), "{}: 다른 명령의 오류가 섞인다: {message}", case.name);
        }
    }
    assert!(output.stdout.is_empty(), "{}: 표준 출력이 있다", case.name);
    observed(case, &hook.requests, loaded)
}

static WORKING_FOLDER: Mutex<()> = Mutex::new(());

fn load_in(folder: &Path, file: &Path, api: &str) -> Result<Option<server::collector::telegram::Telegram>, server::collector::telegram::TelegramFileError> {
    let _held = WORKING_FOLDER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = std::env::current_dir().unwrap();
    std::env::set_current_dir(folder).unwrap();
    let loaded = server::collector::telegram::Telegram::load_at(file, api);
    std::env::set_current_dir(before).unwrap();
    loaded
}

fn rust_outcome(case: &Case) -> Outcome {
    let folder = tempfile::tempdir().unwrap();
    let file = place(folder.path(), case);
    let hook = fake_for(case);
    let loaded = match load_in(folder.path(), &file, &format!("http://127.0.0.1:{}", hook.port)) {
        Ok(Some(telegram)) => {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(telegram.send("메시지")).unwrap();
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(error) => {
            let message = format!("{error} {error:?}");
            assert!(message.contains(&file.display().to_string()), "{}: 오류 문구에 경로가 없다: {message}", case.name);
            Err(message)
        }
    };
    observed(case, &hook.requests, loaded)
}

#[test]
fn the_script_and_the_daemon_read_the_same_settings_file_the_same_way() {
    for case in parity_cases() {
        assert_eq!(rust_outcome(&case), case.outcome, "{}: Rust", case.name);
        assert_eq!(script_outcome(&case), case.outcome, "{}: 스크립트", case.name);
    }
}

#[test]
fn the_script_reads_the_settings_file_the_same_way_under_a_utf8_locale() {
    let Some(locale) = utf8_locale() else {
        eprintln!("locale 명령이 없거나 UTF-8 로캘이 없어 UTF-8 로캘 경우를 건너뛴다");
        return;
    };
    for case in parity_cases() {
        assert_eq!(script_outcome_in_locale(&case, Some(&locale)), case.outcome, "{}: 스크립트({locale})", case.name);
    }
}
