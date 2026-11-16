use std::process::Command;

fn run(arguments: &[&str]) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_collector")).args(arguments).output().unwrap();
    (output.status.code(), String::from_utf8(output.stderr).unwrap())
}

#[test]
fn unfinished_subcommands_report_not_implemented_and_fail() {
    let (code, stderr) = run(&["collect"]);
    assert_eq!(code, Some(1));
    assert!(stderr.contains("아직 구현되지 않았습니다"), "{stderr}");
}

#[test]
fn unknown_subcommand_unknown_argument_and_missing_value_fail() {
    assert_eq!(run(&[]).0, Some(2));
    assert_eq!(run(&["nope"]).0, Some(2));
    assert_eq!(run(&["build", "--nope"]).0, Some(2));
    assert_eq!(run(&["build", "--data"]).0, Some(2));
}

#[test]
fn data_option_is_accepted_by_every_subcommand() {
    for command in ["collect", "serve"] {
        assert_eq!(run(&[command, "--data", "somewhere"]).0, Some(1), "{command}");
    }
    assert_eq!(run(&["serve", "--data", "somewhere", "--bind"]).0, Some(2));
    assert_eq!(run(&["build", "--data", "somewhere", "--date", "20260720"]).0, Some(1));
    assert_eq!(run(&["verify", "--data", "somewhere", "--date", "20260720"]).0, Some(1));
}
