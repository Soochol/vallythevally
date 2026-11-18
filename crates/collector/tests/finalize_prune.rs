use std::fs;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use collector::calendar::{Calendar, Day, cache_path, HolidayRequest, HolidayTransport, TransportError};
use collector::finalize::{DEFAULT_SPILL_BUDGET_BYTES, KeepReason, Options, PRUNE_LOG_NAME, RetentionSettings, delete_planned_day, delete_raw_day, finalize_day, first_complete_day, plan_prune, prune_raw, prune_with_cached_calendar, read_day_facts};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::config::Secret;
use tempfile::{TempDir, tempdir};

const NOV_2: u32 = 20_261_102;
const NOV_3: u32 = 20_261_103;
const NOV_4: u32 = 20_261_104;
const NOV_5: u32 = 20_261_105;
const NOV_6: u32 = 20_261_106;
const NOV_9: u32 = 20_261_109;
const NOV_10: u32 = 20_261_110;
const NOV_11: u32 = 20_261_111;
const NOV_12: u32 = 20_261_112;
const NOV_13: u32 = 20_261_113;
const NOV_16: u32 = 20_261_116;
const NOV_19: u32 = 20_261_119;
const NOV_20: u32 = 20_261_120;

const YEAR_ROUND_HOLIDAYS: [(u32, &str); 5] = [(20_250_101, "1월1일"), (20_260_101, "1월1일"), (20_261_225, "기독탄신일"), (20_270_101, "1월1일"), (20_280_101, "1월1일")];

struct Holidays(Vec<(u32, &'static str)>);

impl HolidayTransport for Holidays {
    fn fetch<'a>(&'a self, request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
        let items: Vec<String> = self
            .0
            .iter()
            .chain(&YEAR_ROUND_HOLIDAYS)
            .filter(|(date, _)| *date / 10_000 == u32::from(request.year))
            .map(|(date, name)| format!(r#"{{"dateKind":"01","dateName":"{name}","isHoliday":"Y","locdate":{date},"seq":1}}"#))
            .collect();
        let body = format!(
            r#"{{"response":{{"header":{{"resultCode":"00","resultMsg":"NORMAL SERVICE."}},"body":{{"items":{{"item":[{}]}},"numOfRows":100,"pageNo":1,"totalCount":{}}}}}}}"#,
            items.join(","),
            items.len()
        );
        Box::pin(async move { Ok(body) })
    }
}

async fn calendar(data: &Path, holidays: Vec<(u32, &'static str)>) -> Calendar {
    let now = Day::from_yyyymmdd(NOV_20).unwrap().unix_ms_at_kst(8, 0);
    Calendar::load(data, &Holidays(holidays), &Secret::new("시험용 키".to_owned()), now).await
}

fn settings() -> RetentionSettings {
    RetentionSettings::default()
}

fn small_settings() -> RetentionSettings {
    RetentionSettings { early_keep: NonZeroU32::new(3).unwrap(), steady_keep: NonZeroU32::new(2).unwrap(), early_period: 4 }
}

fn raw_folder(data: &Path, date: u32) -> PathBuf {
    data.join("raw").join(date.to_string())
}

fn raw_exists(data: &Path, date: u32) -> bool {
    raw_folder(data, date).exists()
}

fn put_raw_bytes(data: &Path, date: u32) {
    let folder = raw_folder(data, date).join("collect-01");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("0900.jsonl.zst"), format!("원문 {date}")).unwrap();
}

fn raw_files_of(folder: &Path, prefix: &str, files: &mut serde_json::Map<String, Value>) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    for entry in entries {
        let entry = entry.unwrap();
        let name = format!("{prefix}{}", entry.file_name().to_str().unwrap());
        if entry.file_type().unwrap().is_dir() {
            raw_files_of(&entry.path(), &format!("{name}/"), files);
        } else {
            files.insert(name, json!(entry.metadata().unwrap().len()));
        }
    }
}

fn raw_fingerprint(data: &Path, date: u32) -> Value {
    let mut files = serde_json::Map::new();
    raw_files_of(&raw_folder(data, date), "", &mut files);
    Value::Object(files)
}

fn put_store_with(data: &Path, date: u32, passed: bool, unfinalized: Value, raw_files: Option<Value>) {
    let folder = data.join("store").join(date.to_string());
    fs::create_dir_all(&folder).unwrap();
    let mut complete = json!({"format_version": 1, "date": date, "verify": {"passed": passed}});
    if let Some(raw_files) = raw_files {
        complete["raw_files"] = raw_files;
    }
    fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
    fs::write(folder.join("verify.json"), json!({"passed": passed, "lines": {"unfinalized": unfinalized}}).to_string()).unwrap();
}

fn put_store(data: &Path, date: u32, passed: bool, unfinalized: Value) {
    put_store_with(data, date, passed, unfinalized, Some(raw_fingerprint(data, date)));
}

fn clean_day(data: &Path, date: u32) {
    put_raw_bytes(data, date);
    put_store(data, date, true, json!({"total": 0, "kinds": {"other_frame": 0}}));
}

fn log_lines(data: &Path) -> Vec<Value> {
    fs::read_to_string(data.join("store").join(PRUNE_LOG_NAME)).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn log_for(data: &Path, date: u32) -> Value {
    log_lines(data).into_iter().rev().find(|line| line["date"] == json!(date)).unwrap_or_else(|| panic!("{date} 기록이 없다"))
}

fn remaining_raw_days(data: &Path) -> Vec<u32> {
    let mut days: Vec<u32> = fs::read_dir(data.join("raw")).unwrap().map(|entry| entry.unwrap().file_name().to_str().unwrap().parse().unwrap()).collect();
    days.sort_unstable();
    days
}

fn write_raw_lines(data: &Path, date: u32, lines: &[String]) {
    let folder = raw_folder(data, date);
    fs::create_dir_all(&folder).unwrap();
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(folder.join("day.jsonl.zst"), zstd::encode_all(text.as_bytes(), 3).unwrap()).unwrap();
}

fn at(date: u32, offset_ms: i64) -> i64 {
    Day::from_yyyymmdd(date).unwrap().unix_ms_at_kst(9, 0) + offset_ms
}

fn frame_line(date: u32, offset_ms: i64, message: &Value) -> String {
    format!(r#"{{"recv_ms":{},"msg":{message}}}"#, at(date, offset_ms))
}

fn good_frame(date: u32, offset_ms: i64) -> String {
    frame_line(date, offset_ms, &json!({"trnm": "REAL", "data": [{"type": "0B", "item": "005930_AL", "values": {"10": "100"}}]}))
}

fn finalize(data: &Path, date: u32) {
    let options = Options { data_dir: data.to_path_buf(), date, threads: 2, buckets: 16, verify_only: false, spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES };
    assert!(finalize_day(&options).unwrap().passed);
}

fn data_with_first_day() -> TempDir {
    let data = tempdir().unwrap();
    put_store(data.path(), NOV_2, true, json!({"total": 0, "kinds": {}}));
    data
}

#[tokio::test]
async fn keeps_day_that_failed_verification() {
    let data = data_with_first_day();
    put_raw_bytes(data.path(), NOV_3);
    put_store(data.path(), NOV_3, false, json!({"total": 0, "kinds": {}}));
    put_raw_bytes(data.path(), NOV_4);
    let verify_failed_later = data.path().join("store").join(NOV_5.to_string());
    put_raw_bytes(data.path(), NOV_5);
    put_store(data.path(), NOV_5, true, json!({"total": 0, "kinds": {}}));
    fs::write(verify_failed_later.join("verify.json"), json!({"passed": false, "lines": {"unfinalized": {"total": 0, "kinds": {}}}}).to_string()).unwrap();

    let calendar = calendar(data.path(), Vec::new()).await;
    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert_eq!(remaining_raw_days(data.path()), [NOV_3, NOV_4, NOV_5]);
    assert!(report.deleted.is_empty());
    assert_eq!(log_for(data.path(), NOV_3)["reason"], json!("verification_failed"));
    assert_eq!(log_for(data.path(), NOV_4)["reason"], json!("no_complete"));
    assert_eq!(log_for(data.path(), NOV_5)["reason"], json!("verification_failed"));
    assert_eq!(log_for(data.path(), NOV_3)["action"], json!("kept"));
}

#[tokio::test]
async fn keeps_day_with_unfinalized_kinds() {
    let data = data_with_first_day();
    let cases: [(u32, &str, Value); 4] = [
        (NOV_3, "other_frame", json!({"return_code": 0, "return_msg": "REST 응답"})),
        (NOV_4, "unknown_realtime_type", json!({"trnm": "REAL", "data": [{"type": "ZZ", "item": "005930_AL", "values": {}}]})),
        (NOV_5, "unknown_fid", json!({"trnm": "REAL", "data": [{"type": "0B", "item": "005930_AL", "values": {"99999": "1"}}]})),
        (NOV_6, "broken_line", Value::Null),
    ];
    for (date, _, message) in &cases {
        let mut lines = vec![good_frame(*date, 0)];
        lines.push(if message.is_null() { "깨진 줄 {".to_owned() } else { frame_line(*date, 500, message) });
        write_raw_lines(data.path(), *date, &lines);
        finalize(data.path(), *date);
    }
    put_raw_bytes(data.path(), NOV_9);
    put_store(data.path(), NOV_9, true, json!({"total": 0, "kinds": {}}));
    fs::write(data.path().join("store").join(NOV_9.to_string()).join("verify.json"), json!({"passed": true}).to_string()).unwrap();

    let calendar = calendar(data.path(), Vec::new()).await;
    prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert_eq!(remaining_raw_days(data.path()), [NOV_3, NOV_4, NOV_5, NOV_6, NOV_9]);
    for (date, kind, _) in &cases {
        let line = log_for(data.path(), *date);
        assert_eq!(line["reason"], json!("unfinalized"), "{date}");
        assert_eq!(line["total"], json!(1), "{date}");
        assert_eq!(line["kinds"], json!({*kind: 1}), "{date}");
    }
    assert_eq!(log_for(data.path(), NOV_9)["reason"], json!("unfinalized_count_missing"));
}

#[tokio::test]
async fn control_lines_do_not_block_deletion() {
    let data = data_with_first_day();
    let lines = vec![
        frame_line(NOV_3, 0, &json!({"trnm": "LOGIN", "return_code": 0})),
        frame_line(NOV_3, 100, &json!({"trnm": "REG", "return_code": 0})),
        format!(r#"{{"recv_ms":{},"event":"live"}}"#, at(NOV_3, 200)),
        good_frame(NOV_3, 300),
        format!(r#"{{"recv_ms":{},"event":"down","reason":"끊김"}}"#, at(NOV_3, 400)),
        format!(r#"{{"recv_ms":{},"event":"live"}}"#, at(NOV_3, 500)),
    ];
    write_raw_lines(data.path(), NOV_3, &lines);
    finalize(data.path(), NOV_3);
    put_raw_bytes(data.path(), NOV_20);

    let calendar = calendar(data.path(), Vec::new()).await;
    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(!raw_exists(data.path(), NOV_3));
    assert_eq!(report.deleted.iter().map(|(date, _)| *date).collect::<Vec<_>>(), [NOV_3]);
    assert!(report.deleted[0].1 > 0);
    assert_eq!(log_for(data.path(), NOV_3)["action"], json!("deleted"));
    assert!(raw_exists(data.path(), NOV_20));
}

#[tokio::test]
async fn keeps_seven_observation_days_in_first_two_weeks() {
    let data = data_with_first_day();
    clean_day(data.path(), NOV_3);
    let calendar = calendar(data.path(), Vec::new()).await;

    prune_raw(data.path(), NOV_11, &calendar, &settings()).unwrap();
    assert!(raw_exists(data.path(), NOV_3), "6관측일이 지난 날은 남는다");
    assert_eq!(log_for(data.path(), NOV_3)["reason"], json!("within_retention"));
    assert_eq!(log_for(data.path(), NOV_3)["keep_observation_days"], json!(7));

    prune_raw(data.path(), NOV_12, &calendar, &settings()).unwrap();
    assert!(!raw_exists(data.path(), NOV_3), "7관측일이 지난 날은 지운다");
}

#[tokio::test]
async fn keeps_one_observation_day_after_first_two_weeks() {
    let data = data_with_first_day();
    clean_day(data.path(), NOV_19);
    clean_day(data.path(), NOV_20);
    let calendar = calendar(data.path(), Vec::new()).await;

    prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(!raw_exists(data.path(), NOV_19));
    assert!(raw_exists(data.path(), NOV_20));
}

#[tokio::test]
async fn retention_switches_on_eleventh_observation_day() {
    let data = data_with_first_day();
    for date in [NOV_3, NOV_4, NOV_5, NOV_6, NOV_9, NOV_10, NOV_11, NOV_12, NOV_13] {
        clean_day(data.path(), date);
    }
    let calendar = calendar(data.path(), Vec::new()).await;

    prune_raw(data.path(), NOV_13, &calendar, &settings()).unwrap();
    assert_eq!(remaining_raw_days(data.path()), [NOV_5, NOV_6, NOV_9, NOV_10, NOV_11, NOV_12, NOV_13], "10번째 관측일에는 7관측일 규칙이다");

    prune_raw(data.path(), NOV_16, &calendar, &settings()).unwrap();
    assert!(!data.path().join("raw").exists() || remaining_raw_days(data.path()).is_empty(), "11번째 관측일에는 1관측일 규칙이라 남은 날이 모두 지워진다");
}

#[tokio::test]
async fn retention_values_come_from_settings() {
    let data = data_with_first_day();
    for date in [NOV_3, NOV_4, NOV_5] {
        clean_day(data.path(), date);
    }
    clean_day(data.path(), NOV_2);
    let calendar = calendar(data.path(), Vec::new()).await;

    prune_raw(data.path(), NOV_5, &calendar, &small_settings()).unwrap();
    assert_eq!(remaining_raw_days(data.path()), [NOV_3, NOV_4, NOV_5], "전환 전에는 3관측일이다");

    prune_raw(data.path(), NOV_6, &calendar, &small_settings()).unwrap();
    assert_eq!(remaining_raw_days(data.path()), [NOV_5], "전환 뒤에는 2관측일이다");
}

#[tokio::test]
async fn holidays_do_not_count_as_observation_days() {
    let data = data_with_first_day();
    clean_day(data.path(), NOV_3);
    let calendar = calendar(data.path(), vec![(NOV_10, "시험 휴장일")]).await;

    prune_raw(data.path(), NOV_12, &calendar, &settings()).unwrap();
    assert!(raw_exists(data.path(), NOV_3), "휴장일 하루가 빠져 6관측일뿐이다");

    prune_raw(data.path(), NOV_13, &calendar, &settings()).unwrap();
    assert!(!raw_exists(data.path(), NOV_3));
}

#[tokio::test]
async fn an_unknown_observation_day_keeps_the_raw() {
    let data = data_with_first_day();
    clean_day(data.path(), NOV_3);
    let offline = Calendar::load(data.path(), &Offline, &Secret::new(String::new()), Day::from_yyyymmdd(NOV_20).unwrap().unix_ms_at_kst(8, 0)).await;

    let report = prune_raw(data.path(), NOV_20, &offline, &settings()).unwrap();

    assert!(raw_exists(data.path(), NOV_3));
    assert!(matches!(report.kept[0].1, KeepReason::ObservationUnknown { .. }));
}

#[tokio::test]
async fn raw_grown_after_complete_is_not_pruned() {
    let data = data_with_first_day();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    finalize(data.path(), NOV_3);
    let complete_before = fs::read(data.path().join("store").join(NOV_3.to_string()).join("complete.json")).unwrap();
    fs::write(raw_folder(data.path(), NOV_3).join("late.jsonl.zst"), zstd::encode_all(format!("{}\n", good_frame(NOV_3, 900)).as_bytes(), 3).unwrap()).unwrap();
    put_raw_bytes(data.path(), NOV_20);
    let calendar = calendar(data.path(), Vec::new()).await;

    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(report.deleted.is_empty(), "{report:?}");
    assert!(raw_folder(data.path(), NOV_3).join("late.jsonl.zst").exists());
    assert!(raw_folder(data.path(), NOV_3).join("day.jsonl.zst").exists());
    let line = log_for(data.path(), NOV_3);
    assert_eq!(line["action"], json!("kept"));
    assert_eq!(line["reason"], json!("raw_changed_after_complete"));
    assert_eq!(line["files"], json!(1));
    assert_eq!(line["examples"], json!(["late.jsonl.zst"]));
    assert_eq!(fs::read(data.path().join("store").join(NOV_3.to_string()).join("complete.json")).unwrap(), complete_before);

    finalize(data.path(), NOV_3);
    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();
    assert_eq!(report.deleted.iter().map(|(date, _)| *date).collect::<Vec<_>>(), [NOV_3], "다시 정리하면 늘어난 원문까지 정리돼 지운다");
}

#[tokio::test]
async fn a_raw_file_rewritten_or_removed_after_complete_is_not_pruned() {
    let data = data_with_first_day();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    finalize(data.path(), NOV_3);
    write_raw_lines(data.path(), NOV_4, &[good_frame(NOV_4, 0)]);
    finalize(data.path(), NOV_4);
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0), good_frame(NOV_3, 1)]);
    fs::remove_file(raw_folder(data.path(), NOV_4).join("day.jsonl.zst")).unwrap();
    let calendar = calendar(data.path(), Vec::new()).await;

    prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    for date in [NOV_3, NOV_4] {
        assert!(raw_exists(data.path(), date), "{date}");
        assert_eq!(log_for(data.path(), date)["reason"], json!("raw_changed_after_complete"), "{date}");
    }
    assert_eq!(log_for(data.path(), NOV_4)["examples"], json!(["day.jsonl.zst"]));
}

#[tokio::test]
async fn files_that_finalize_does_not_read_are_left_out_of_the_fingerprint_and_keep_the_day_from_being_pruned() {
    let data = data_with_first_day();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    let deep = raw_folder(data.path(), NOV_3).join("collect-01").join("sub");
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("0900.jsonl.zst"), "한 단계 더 깊다").unwrap();
    fs::write(raw_folder(data.path(), NOV_3).join("notes.txt"), "원문이 아니다").unwrap();
    finalize(data.path(), NOV_3);
    let complete: Value = serde_json::from_slice(&fs::read(data.path().join("store").join(NOV_3.to_string()).join("complete.json")).unwrap()).unwrap();
    assert_eq!(complete["raw_files"].as_object().unwrap().keys().collect::<Vec<_>>(), ["day.jsonl.zst"]);
    put_raw_bytes(data.path(), NOV_20);
    let calendar = calendar(data.path(), Vec::new()).await;

    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(report.deleted.is_empty(), "{report:?}");
    assert!(deep.join("0900.jsonl.zst").exists());
    assert!(raw_folder(data.path(), NOV_3).join("notes.txt").exists());
    let line = log_for(data.path(), NOV_3);
    assert_eq!(line["reason"], json!("raw_has_unread_files"));
    assert_eq!(line["files"], json!(2));
    assert_eq!(line["examples"], json!(["collect-01/sub/0900.jsonl.zst", "notes.txt"]));

    fs::remove_dir_all(deep.parent().unwrap()).unwrap();
    fs::remove_file(raw_folder(data.path(), NOV_3).join("notes.txt")).unwrap();
    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();
    assert_eq!(report.deleted.iter().map(|(date, _)| *date).collect::<Vec<_>>(), [NOV_3], "치우면 지울 수 있다");
}

#[tokio::test]
async fn a_symlinked_key_folder_is_not_a_layout_the_collector_writes_so_it_keeps_the_day() {
    let data = data_with_first_day();
    let real = tempdir().unwrap();
    fs::write(real.path().join("0900.jsonl.zst"), zstd::encode_all(format!("{}\n", good_frame(NOV_3, 0)).as_bytes(), 3).unwrap()).unwrap();
    fs::create_dir_all(raw_folder(data.path(), NOV_3)).unwrap();
    std::os::unix::fs::symlink(real.path(), raw_folder(data.path(), NOV_3).join("collect-01")).unwrap();
    finalize(data.path(), NOV_3);
    put_raw_bytes(data.path(), NOV_20);
    let calendar = calendar(data.path(), Vec::new()).await;

    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(report.deleted.is_empty(), "{report:?}");
    assert_eq!(log_for(data.path(), NOV_3)["reason"], json!("raw_has_unread_files"));
    assert!(real.path().join("0900.jsonl.zst").exists());
}

#[tokio::test]
async fn a_linked_raw_file_whose_target_grew_after_complete_is_not_pruned() {
    let data = data_with_first_day();
    let outside = tempdir().unwrap();
    let target = outside.path().join("day.jsonl.zst");
    fs::write(&target, zstd::encode_all(format!("{}\n", good_frame(NOV_3, 0)).as_bytes(), 3).unwrap()).unwrap();
    fs::create_dir_all(raw_folder(data.path(), NOV_3)).unwrap();
    std::os::unix::fs::symlink(&target, raw_folder(data.path(), NOV_3).join("day.jsonl.zst")).unwrap();
    finalize(data.path(), NOV_3);
    fs::write(&target, zstd::encode_all(format!("{}\n{}\n{}\n", good_frame(NOV_3, 0), good_frame(NOV_3, 1), good_frame(NOV_3, 2)).as_bytes(), 3).unwrap()).unwrap();
    put_raw_bytes(data.path(), NOV_20);
    let calendar = calendar(data.path(), Vec::new()).await;

    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(report.deleted.is_empty(), "{report:?}");
    assert_eq!(log_for(data.path(), NOV_3)["reason"], json!("raw_changed_after_complete"));
}

#[tokio::test]
async fn an_unread_file_whose_lossy_name_equals_a_read_key_folder_still_keeps_the_day() {
    use std::os::unix::ffi::OsStrExt;
    let data = data_with_first_day();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    let day = raw_folder(data.path(), NOV_3);
    fs::create_dir_all(day.join("\u{FFFD}")).unwrap();
    fs::write(day.join("\u{FFFD}").join("0900.jsonl.zst"), zstd::encode_all(format!("{}\n", good_frame(NOV_3, 1)).as_bytes(), 3).unwrap()).unwrap();
    let stray = day.join(std::ffi::OsStr::from_bytes(b"\xff"));
    fs::write(&stray, "원문이 아니다").unwrap();
    finalize(data.path(), NOV_3);
    put_raw_bytes(data.path(), NOV_20);
    let calendar = calendar(data.path(), Vec::new()).await;

    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(report.deleted.is_empty(), "{report:?}");
    assert!(stray.exists());
    assert_eq!(log_for(data.path(), NOV_3)["reason"], json!("raw_has_unread_files"));
}

#[tokio::test]
async fn an_unread_non_utf8_file_whose_lossy_name_equals_a_read_file_keeps_the_day() {
    use std::os::unix::ffi::OsStrExt;
    let data = data_with_first_day();
    let day = raw_folder(data.path(), NOV_3);
    fs::create_dir_all(&day).unwrap();
    fs::write(day.join("\u{FFFD}.jsonl.zst"), zstd::encode_all(format!("{}\n", good_frame(NOV_3, 0)).as_bytes(), 3).unwrap()).unwrap();
    let stray = day.join(std::ffi::OsStr::from_bytes(b"\xff.jsonl.zst"));
    fs::write(&stray, "원문이 아니다").unwrap();
    finalize(data.path(), NOV_3);
    put_raw_bytes(data.path(), NOV_20);
    let calendar = calendar(data.path(), Vec::new()).await;

    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(report.deleted.is_empty(), "{report:?}");
    assert!(stray.exists());
    let line = log_for(data.path(), NOV_3);
    assert_eq!(line["reason"], json!("raw_has_unread_files"));
    assert_eq!(line["files"], json!(1));
}

#[test]
fn a_dangling_raw_symlink_does_not_stop_finalize_and_keeps_the_day_unfinalized() {
    let data = tempdir().unwrap();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    std::os::unix::fs::symlink(data.path().join("없는 파일"), raw_folder(data.path(), NOV_3).join("broken.jsonl.zst")).unwrap();
    let options = Options { data_dir: data.path().to_path_buf(), date: NOV_3, threads: 2, buckets: 16, verify_only: false, spill_budget_bytes: DEFAULT_SPILL_BUDGET_BYTES };

    finalize_day(&options).expect("읽지 못한 파일 하나로 정리가 멈추지 않는다");

    let verify: Value = serde_json::from_slice(&fs::read(data.path().join("store").join(NOV_3.to_string()).join("verify.json")).unwrap()).unwrap();
    assert!(verify["lines"]["unfinalized"]["total"].as_u64().unwrap() > 0, "{verify}");
}

#[tokio::test]
async fn a_raw_file_that_appears_after_the_plan_is_caught_right_before_the_delete() {
    let data = data_with_first_day();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    finalize(data.path(), NOV_3);
    let calendar = calendar(data.path(), Vec::new()).await;
    let planned = plan_prune(NOV_20, first_complete_day(data.path()).unwrap(), &[read_day_facts(data.path(), NOV_3)], &calendar, &settings());
    assert_eq!(planned.delete, [NOV_3]);
    let late = raw_folder(data.path(), NOV_3).join("late.jsonl.zst");
    fs::write(&late, zstd::encode_all(format!("{}\n", good_frame(NOV_3, 900)).as_bytes(), 3).unwrap()).unwrap();

    let outcome = delete_planned_day(data.path(), NOV_20, NOV_3, &calendar, &settings()).unwrap();

    assert!(matches!(outcome, Err(KeepReason::RawChangedAfterComplete { files: 1, .. })), "{outcome:?}");
    assert!(late.exists());
    assert!(raw_folder(data.path(), NOV_3).join("day.jsonl.zst").exists());

    finalize(data.path(), NOV_3);
    assert!(delete_planned_day(data.path(), NOV_20, NOV_3, &calendar, &settings()).unwrap().is_ok());
    assert!(!raw_exists(data.path(), NOV_3));
}

#[tokio::test]
async fn a_complete_without_a_raw_fingerprint_keeps_the_raw() {
    let data = data_with_first_day();
    put_raw_bytes(data.path(), NOV_3);
    put_store_with(data.path(), NOV_3, true, json!({"total": 0, "kinds": {}}), None);
    let calendar = calendar(data.path(), Vec::new()).await;

    let report = prune_raw(data.path(), NOV_20, &calendar, &settings()).unwrap();

    assert!(report.deleted.is_empty());
    assert!(raw_exists(data.path(), NOV_3));
    assert_eq!(log_for(data.path(), NOV_3)["reason"], json!("raw_fingerprint_missing"));
}

#[test]
fn a_finalized_day_records_the_raw_files_and_their_sizes() {
    let data = tempdir().unwrap();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    put_raw_bytes(data.path(), NOV_3);
    finalize(data.path(), NOV_3);
    let complete: Value = serde_json::from_slice(&fs::read(data.path().join("store").join(NOV_3.to_string()).join("complete.json")).unwrap()).unwrap();
    assert_eq!(complete["raw_files"], raw_fingerprint(data.path(), NOV_3));
    assert_eq!(complete["raw_files"]["collect-01/0900.jsonl.zst"], json!(format!("원문 {NOV_3}").len()));
    assert!(complete["raw_files"]["day.jsonl.zst"].as_u64().unwrap() > 0);
}

struct Offline;

impl HolidayTransport for Offline {
    fn fetch<'a>(&'a self, _request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
        Box::pin(async { Err(TransportError::Unreachable) })
    }
}

#[test]
fn refuses_paths_outside_raw() {
    let data = tempdir().unwrap();
    let outside = tempdir().unwrap();
    clean_day(data.path(), NOV_3);
    let elsewhere = outside.path().join("20261103");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("keep.txt"), "남아야 한다").unwrap();
    std::os::unix::fs::symlink(&elsewhere, raw_folder(data.path(), NOV_4)).unwrap();
    fs::create_dir_all(data.path().join("raw").join("notes")).unwrap();

    let refused = [
        data.path().join("store").join(NOV_3.to_string()),
        data.path().join("raw"),
        elsewhere.clone(),
        raw_folder(data.path(), NOV_3).join("collect-01"),
        data.path().join("raw").join("..").join("store").join(NOV_3.to_string()),
        raw_folder(data.path(), NOV_4),
        data.path().join("raw").join("notes"),
    ];
    for target in &refused {
        assert!(delete_raw_day(data.path(), target).is_err(), "{}", target.display());
    }
    assert!(elsewhere.join("keep.txt").exists());
    assert!(data.path().join("store").join(NOV_3.to_string()).join("complete.json").exists());
    assert!(raw_folder(data.path(), NOV_3).join("collect-01").exists());
    assert!(delete_raw_day(data.path(), &raw_folder(data.path(), NOV_3)).is_ok());
}

#[test]
fn the_prune_flag_and_its_numbers_are_checked() {
    let run = |extra: &[&str]| {
        let mut arguments = vec!["finalize", "--data", "somewhere", "--date", "20261117"];
        arguments.extend_from_slice(extra);
        std::process::Command::new(env!("CARGO_BIN_EXE_collector")).args(arguments).output().unwrap().status.code()
    };
    assert_eq!(run(&["--keep", "3"]), Some(2));
    assert_eq!(run(&["--prune", "--keep", "0"]), Some(2));
    assert_eq!(run(&["--prune", "--keep-early", "x"]), Some(2));
}

#[test]
fn the_prune_flag_without_cached_holidays_deletes_nothing() {
    let data = tempdir().unwrap();
    write_raw_lines(data.path(), NOV_3, &[good_frame(NOV_3, 0)]);
    clean_day(data.path(), NOV_2);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["finalize", "--data", data.path().to_str().unwrap(), "--date", "20261103", "--prune"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(raw_exists(data.path(), NOV_2));
    assert!(raw_exists(data.path(), NOV_3));
}

#[test]
fn prunes_after_the_first_complete_day_is_two_years_old() {
    let data = tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    for now in [NOV_20, 20_271_220, 20_280_103] {
        let at_now = Day::from_yyyymmdd(now).unwrap().unix_ms_at_kst(8, 0);
        runtime.block_on(Calendar::load(data.path(), &Holidays(Vec::new()), &Secret::new("시험용 키".to_owned()), at_now));
    }
    for year in 2026..=2028 {
        assert!(cache_path(&data.path().join("calendar"), year).exists(), "{year} 캐시");
    }
    put_store(data.path(), 20_261_118, true, json!({"total": 0, "kinds": {}}));
    clean_day(data.path(), NOV_19);

    let report = prune_with_cached_calendar(data.path(), 20_280_103, &settings()).unwrap();

    assert_eq!(report.deleted.len(), 1, "{:?}", report.kept);
    assert!(!raw_exists(data.path(), NOV_19));
}
