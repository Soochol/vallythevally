use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};

use collector::serve::{BindError, bind_loopback, parse_loopback_address};

use super::support::built_day;

fn collector(arguments: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_collector"));
    command.args(arguments);
    command
}

#[test]
fn only_loopback_addresses_are_accepted() {
    for text in ["127.0.0.1:8090", "127.0.0.1:0", "127.5.5.5:1", "[::1]:0"] {
        assert!(parse_loopback_address(text).is_ok(), "{text}");
    }
    for text in ["0.0.0.0:0", "192.168.0.10:8090", "[::]:0", "8.8.8.8:80"] {
        assert!(matches!(parse_loopback_address(text), Err(BindError::NotLoopback(_))), "{text}");
    }
    for text in ["localhost:8090", "8090", ""] {
        assert!(matches!(parse_loopback_address(text), Err(BindError::NotAnAddress(_))), "{text}");
    }
}

#[tokio::test]
async fn binding_a_non_loopback_address_fails_and_port_zero_picks_a_free_port() {
    assert!(bind_loopback("0.0.0.0:0").await.is_err());
    let listener = bind_loopback("127.0.0.1:0").await.unwrap();
    assert_ne!(listener.local_addr().unwrap().port(), 0);
}

#[test]
fn serve_refuses_to_start_on_a_non_loopback_address() {
    let data = built_day();
    let output = collector(&["serve", "--data", data.path().to_str().unwrap(), "--bind", "0.0.0.0:0"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("루프백"));
    assert!(output.stdout.is_empty());
}

#[test]
fn serve_refuses_a_missing_data_folder() {
    let output = collector(&["serve", "--data", "/nonexistent/hoga-data", "--bind", "127.0.0.1:0"]).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn serve_prints_its_address_and_answers_over_http() {
    let data = built_day();
    let mut child = collector(&["serve", "--data", data.path().to_str().unwrap(), "--bind", "127.0.0.1:0"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first_line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut first_line).unwrap();
    let address = first_line.trim().strip_prefix("http://127.0.0.1:").map(str::to_string);
    let result = address.as_deref().map(|port| {
        let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
        stream.write_all(b"GET /data/dates.json HTTP/1.0\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    });
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(address.is_some(), "첫 줄이 주소가 아니다: {first_line:?}");
    let response = result.unwrap();
    assert!(response.starts_with("HTTP/1.0 200"), "{response}");
    assert!(response.ends_with("[\"20260720\"]"), "{response}");
}
