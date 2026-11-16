use std::process::Command;

fn run(arguments: &[&str]) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_collector")).args(arguments).output().unwrap();
    (output.status.code(), String::from_utf8(output.stderr).unwrap())
}

#[test]
fn no_subcommand_reports_not_implemented() {
    let invocations: [&[&str]; 4] = [
        &["collect"],
        &["serve", "--data", "somewhere"],
        &["build", "--data", "somewhere", "--date", "20260720"],
        &["verify", "--data", "somewhere", "--date", "20260720"],
    ];
    for arguments in invocations {
        let (_, stderr) = run(arguments);
        assert!(!stderr.contains("아직 구현되지 않았습니다"), "{arguments:?}: {stderr}");
    }
}

#[test]
fn unknown_subcommand_unknown_argument_and_missing_value_fail() {
    assert_eq!(run(&[]).0, Some(2));
    assert_eq!(run(&["nope"]).0, Some(2));
    assert_eq!(run(&["build", "--nope"]).0, Some(2));
    assert_eq!(run(&["build", "--data"]).0, Some(2));
    assert_eq!(run(&["serve", "--data", "somewhere", "--bind"]).0, Some(2));
}

#[test]
fn data_option_is_accepted_by_every_subcommand() {
    assert_eq!(run(&["serve", "--data", "somewhere"]).0, Some(1));
    assert_eq!(run(&["build", "--data", "somewhere", "--date", "20260720"]).0, Some(1));
    assert_eq!(run(&["verify", "--data", "somewhere", "--date", "20260720"]).0, Some(1));
    assert_eq!(run(&["collect", "--data", "somewhere"]).0, Some(2));
}
