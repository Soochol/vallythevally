use std::process::Command;

fn collect(arguments: &[&str], folder: &std::path::Path) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_collector"))
        .arg("collect")
        .args(arguments)
        .env_clear()
        .env("HOME", folder)
        .output()
        .unwrap();
    (output.status.code(), String::from_utf8(output.stderr).unwrap())
}

#[test]
fn without_a_key_it_names_the_variable_and_touches_nothing() {
    let folder = tempfile::tempdir().unwrap();
    let data = folder.path().join("data");
    let (code, stderr) = collect(&["--data", data.to_str().unwrap(), "--items", "005930"], folder.path());
    assert_eq!(code, Some(2));
    assert!(stderr.contains("VALLY_COLLECTOR_APP_KEY"), "{stderr}");
    assert!(!data.exists());
    assert!(!folder.path().join(".local").exists());
}

#[test]
fn bad_items_fail_before_the_configuration_is_read() {
    let folder = tempfile::tempdir().unwrap();
    for items in ["5930", "005930,005930"] {
        let (code, stderr) = collect(&["--items", items], folder.path());
        assert_eq!(code, Some(2), "{items}");
        assert!(stderr.contains("--items"), "{items}: {stderr}");
    }
    let (code, stderr) = collect(&[], folder.path());
    assert_eq!(code, Some(2));
    assert!(stderr.contains("--items가 필요합니다"), "{stderr}");
}
