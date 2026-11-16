use std::path::Path;
use std::process::{Command, Output};

use super::support::*;

fn collector(arguments: &[&str], data: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(arguments)
        .args(["--data", data.to_str().unwrap(), "--date", "20260720"])
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[test]
fn build_and_verify_exit_zero_on_the_fixture_and_the_second_build_writes_nothing() {
    let data = fixture_day();
    let first = collector(&["build"], data.path());
    assert_eq!(first.status.code(), Some(0), "{}", stdout(&first));
    assert!(stdout(&first).contains("새로 쓴 파일 14개"));
    let second = collector(&["build"], data.path());
    assert_eq!(second.status.code(), Some(0));
    assert!(stdout(&second).contains("새로 쓴 파일 0개"), "{}", stdout(&second));
    let verified = collector(&["verify"], data.path());
    assert_eq!(verified.status.code(), Some(0), "{}", stdout(&verified));
    assert!(stdout(&verified).contains("통과"));
}

#[test]
fn build_exits_nonzero_for_read_errors_and_for_values_beyond_i32() {
    let broken = tempfile::tempdir().unwrap();
    write_raw(broken.path(), &[Line::Frame(at(9, 0, 10), book_frame("A", "9x0010", "1000", "1")), Line::Frame(at(9, 0, 20), book_frame("A", "090020", "1000", "1"))]);
    let output = collector(&["build"], broken.path());
    assert_eq!(output.status.code(), Some(1));
    assert!(span_path(broken.path(), "A", 9 * 60, 1).exists());
    assert_eq!(collector(&["verify"], broken.path()).status.code(), Some(1));

    let huge = tempfile::tempdir().unwrap();
    write_raw(huge.path(), &[Line::Frame(at(9, 0, 10), book_frame("A", "090010", "1000", "3000000000"))]);
    assert_eq!(collector(&["build"], huge.path()).status.code(), Some(1));
    assert!(!span_path(huge.path(), "A", 9 * 60, 1).exists());
}

#[test]
fn verify_exits_nonzero_when_a_span_file_is_gone() {
    let data = fixture_day();
    assert_eq!(collector(&["build"], data.path()).status.code(), Some(0));
    std::fs::remove_file(span_path(data.path(), "005930", 10 * 60 + 30, 1)).unwrap();
    let output = collector(&["verify"], data.path());
    assert_eq!(output.status.code(), Some(1));
    assert!(stdout(&output).contains("005930"), "{}", stdout(&output));
}

#[test]
fn usage_errors_exit_two() {
    let data = tempfile::tempdir().unwrap();
    let run = |arguments: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_collector")).args(arguments).arg("--data").arg(data.path()).output().unwrap().status.code()
    };
    assert_eq!(run(&["verify"]), Some(2));
    assert_eq!(run(&["verify", "--date", "2026-07-20"]), Some(2));
    assert_eq!(run(&["build", "--date", "20261301"]), Some(2));
    assert_eq!(run(&["build", "--follow", "--date", "20260720"]), Some(2));
    assert_eq!(run(&["verify", "--follow"]), Some(2));
}
