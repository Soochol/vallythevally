use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use domain::{KstDate, KstTime, TimeOfDay};

const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../deploy/collector-restart");

struct Sandbox {
    folder: tempfile::TempDir,
}

fn write_executable(path: &Path, body: &str) {
    std::fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

impl Sandbox {
    fn new() -> Sandbox {
        let folder = tempfile::tempdir().unwrap();
        let stubs = folder.path().join("stubs");
        std::fs::create_dir(&stubs).unwrap();
        let calls = folder.path().join("calls");
        write_executable(&stubs.join("sleep"), "exit 0\n");
        write_executable(&stubs.join("systemctl"), &format!("echo \"systemctl $*\" >> '{}'\n", calls.display()));
        write_executable(&stubs.join("systemd-run"), &format!("echo \"systemd-run $*\" >> '{}'\n", calls.display()));
        let data = folder.path().join("data");
        std::fs::create_dir_all(data.join("calendar")).unwrap();
        let cache = r#"{"version":1,"year":2026,"fetched_at_unix_ms":1700000000000,"holidays":[{"date":20261225,"name":"기독탄신일"}]}"#;
        std::fs::write(data.join("calendar/holidays-2026.json"), cache).unwrap();
        Sandbox { folder }
    }

    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.folder.path().join("calls")).map(|text| text.lines().map(str::to_owned).collect()).unwrap_or_default()
    }

    fn run_at(&self, date: &str, hour: u32, minute: u32) -> Output {
        let now = KstTime::from_kst_civil(KstDate::parse_yyyymmdd(date).unwrap(), TimeOfDay::hms(hour, minute, 0).unwrap()).unix();
        let wrapper = self.folder.path().join("stubs/collector");
        write_executable(&wrapper, &format!("exec '{}' \"$@\" --now {now}\n", env!("CARGO_BIN_EXE_collector")));
        let path = format!("{}:{}", self.folder.path().join("stubs").display(), std::env::var("PATH").unwrap());
        Command::new(SCRIPT)
            .env("PATH", path)
            .env("HOME", self.folder.path())
            .env("VALLY_COLLECTOR_BIN", &wrapper)
            .env("VALLY_SYSTEMD_USER_DIR", self.folder.path().join("units"))
            .env("VALLY_DATA", self.folder.path().join("data"))
            .env("VALLY_COLLECTOR_STABLE_SECONDS", "1")
            .output()
            .unwrap()
    }
}

fn script_path() -> PathBuf {
    PathBuf::from(SCRIPT).canonicalize().unwrap()
}

#[test]
fn the_real_check_decides_between_restart_and_reservation_for_the_script() {
    let inside = Sandbox::new();
    let output = inside.run_at("20261124", 12, 0);
    let wrapper = inside.folder.path().join("stubs/collector");
    let units = inside.folder.path().join("units");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let calls = inside.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0], "systemctl --user stop vally-collector-restart.timer");
    assert_eq!(
        calls[1],
        format!("systemd-run --user --unit=vally-collector-restart --on-calendar=2026-11-24 22:05:00 Asia/Seoul --setenv=VALLY_COLLECTOR_SERVICE=vally-collector.service --setenv=VALLY_COLLECTOR_STABLE_SECONDS=1 --setenv=VALLY_COLLECTOR_BIN={} --setenv=VALLY_SYSTEMD_USER_DIR={} --collect {} --scheduled", wrapper.display(), units.display(), script_path().display())
    );

    let outside = Sandbox::new();
    let output = outside.run_at("20261124", 23, 0);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(outside.calls().contains(&"systemctl --user restart vally-collector.service".to_owned()), "{:?}", outside.calls());

    let holiday = Sandbox::new();
    assert!(holiday.run_at("20261225", 12, 0).status.success());
    assert!(holiday.calls().contains(&"systemctl --user restart vally-collector.service".to_owned()));
}
