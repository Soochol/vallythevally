use std::process::Command;

use domain::{KstDate, KstTime, TimeOfDay};

fn unix_at(date: &str, hour: u32, minute: u32) -> i64 {
    KstTime::from_kst_civil(KstDate::parse_yyyymmdd(date).unwrap(), TimeOfDay::hms(hour, minute, 0).unwrap()).unix()
}

fn data_with_holidays_cache() -> tempfile::TempDir {
    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(data.path().join("calendar")).unwrap();
    let cache = r#"{"version":1,"year":2026,"fetched_at_unix_ms":1700000000000,"holidays":[{"date":20261225,"name":"기독탄신일"}]}"#;
    std::fs::write(data.path().join("calendar/holidays-2026.json"), cache).unwrap();
    data
}

fn restart_window(data: &std::path::Path, now: i64, extra: &[&str]) -> (Option<i32>, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["restart-window", "--data"])
        .arg(data)
        .args(["--now", &now.to_string()])
        .args(extra)
        .output()
        .unwrap();
    (output.status.code(), String::from_utf8(output.stdout).unwrap(), String::from_utf8(output.stderr).unwrap())
}

#[test]
fn prints_now_outside_collection_hours_and_wait_with_the_time_inside_them() {
    let data = data_with_holidays_cache();
    let (code, stdout, _) = restart_window(data.path(), unix_at("20261124", 6, 0), &[]);
    assert_eq!(code, Some(0));
    assert!(stdout.starts_with("now\t") && stdout.ends_with('\n') && stdout.lines().count() == 1, "{stdout}");
    let (code, stdout, _) = restart_window(data.path(), unix_at("20261124", 12, 0), &[]);
    assert_eq!(code, Some(0));
    assert!(stdout.starts_with("wait\t2026-11-24 22:05:00 Asia/Seoul\t"), "{stdout}");
}

#[test]
fn a_holiday_from_the_cache_restarts_now_and_a_missing_cache_waits() {
    let data = data_with_holidays_cache();
    let (_, stdout, _) = restart_window(data.path(), unix_at("20261225", 12, 0), &[]);
    assert!(stdout.starts_with("now\t오늘은 쉬는 날이다"), "{stdout}");
    let without_cache = tempfile::tempdir().unwrap();
    let (code, stdout, _) = restart_window(without_cache.path(), unix_at("20261124", 12, 0), &[]);
    assert_eq!(code, Some(0));
    assert!(stdout.starts_with("wait\t2026-11-24 22:05:00 Asia/Seoul\t달력으로 오늘이 쉬는 날인지 알 수 없다"), "{stdout}");
}

#[test]
fn schedule_options_and_bad_values_follow_the_daemons_rules() {
    let data = data_with_holidays_cache();
    let (_, stdout, _) = restart_window(data.path(), unix_at("20261124", 18, 10), &["--close-at", "18:00", "--finalize-allowance-minutes", "30"]);
    assert!(stdout.starts_with("wait\t2026-11-24 18:30:00 Asia/Seoul\t"), "{stdout}");
    for bad in [&["--close-at", "7:5"][..], &["--judge-at", "21:00"], &["--finalize-allowance-minutes", "x"], &["--finalize-allowance-minutes", "600"], &["--nope"]] {
        let (code, stdout, stderr) = restart_window(data.path(), unix_at("20261124", 12, 0), bad);
        assert_eq!(code, Some(2), "{bad:?}: {stderr}");
        assert!(stdout.is_empty() && stderr.starts_with("restart-window:"), "{bad:?}: {stdout}{stderr}");
    }
}
