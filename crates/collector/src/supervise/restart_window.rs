use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use domain::KstTime;
use server::config::Secret;

use super::{ScheduleSettings, parse_schedule};
#[cfg(test)]
use super::schedule_from_arguments;
use crate::args::{ArgSpec, Arguments};
use crate::calendar::{CachedHolidaysOnly, Calendar, Day, Finding, Verdict};
use crate::finalize::{COMPLETE_FILE_NAME, store_dir, temporary_store_dir};

pub const SPEC: ArgSpec = ArgSpec {
    value_options: &["judge-at", "plan-at", "launch-at", "close-at", "finalize-allowance-minutes", "now"],
    flag_options: &[],
};

const DEFAULT_FINALIZE_ALLOWANCE: Duration = Duration::from_secs(120 * 60);
const SECS_PER_DAY: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartVerdict {
    Now { reason: String },
    Wait { until: KstTime, reason: String },
}

impl RestartVerdict {
    pub fn line(&self) -> String {
        match self {
            RestartVerdict::Now { reason } => format!("now\t{reason}"),
            RestartVerdict::Wait { until, reason } => {
                format!("wait\t{} {} Asia/Seoul\t{reason}", until.kst_date(), until.kst_time_of_day())
            }
        }
    }
}

pub struct RestartInputs<'a> {
    pub schedule: &'a ScheduleSettings,
    pub finalize_allowance: Duration,
    pub calendar: &'a Calendar,
    pub data_dir: &'a Path,
    pub now: KstTime,
}

pub fn decide(inputs: &RestartInputs) -> RestartVerdict {
    let today = inputs.now.kst_date();
    let date: u32 = today.yyyymmdd().parse().expect("날짜는 숫자 여덟 자리다");
    let times = inputs.schedule.times_of(today);
    let window_end = times.close.plus_secs(inputs.finalize_allowance.as_secs() as i64);
    let window = format!("{}~{}", inputs.schedule.judge_at, window_end.kst_time_of_day());
    if inputs.now < times.judge || inputs.now >= window_end {
        return RestartVerdict::Now { reason: format!("지금은 수집 시간({window}) 밖이다") };
    }
    let judgment = inputs.calendar.judge(Day::from_yyyymmdd(date).expect("오늘 날짜는 달력에 있다"));
    match judgment.verdict {
        Verdict::Closed => {
            let why = judgment.evidence.iter().find(|item| item.finding == Finding::Closed).map_or("쉬는 날이다", |item| item.detail.as_str());
            RestartVerdict::Now { reason: format!("오늘은 쉬는 날이다: {why}") }
        }
        Verdict::Unknown => {
            let unknown: Vec<&str> = judgment.evidence.iter().filter(|item| item.finding == Finding::Unknown).map(|item| item.detail.as_str()).collect();
            RestartVerdict::Wait { until: window_end, reason: format!("달력으로 오늘이 쉬는 날인지 알 수 없다: {}", unknown.join("; ")) }
        }
        Verdict::Observed { .. } => {
            let finalized = store_dir(inputs.data_dir, date).join(COMPLETE_FILE_NAME).is_file() && !temporary_store_dir(inputs.data_dir, date).exists();
            if inputs.now >= times.close && finalized {
                RestartVerdict::Now { reason: "오늘 마감 정리가 끝났다".to_owned() }
            } else {
                RestartVerdict::Wait { until: window_end, reason: format!("수집 시간({window}) 안이고 마감 정리가 끝나지 않았다") }
            }
        }
    }
}

fn usage_error(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("restart-window: {message}");
    ExitCode::from(2)
}

fn finalize_allowance(arguments: &Arguments) -> Result<Duration, String> {
    let Some(text) = arguments.value("finalize-allowance-minutes") else { return Ok(DEFAULT_FINALIZE_ALLOWANCE) };
    let minutes: u64 = text.parse().map_err(|_| format!("--finalize-allowance-minutes는 0 이상의 정수여야 합니다: {text:?}"))?;
    Ok(Duration::from_secs(minutes * 60))
}

fn now_from(arguments: &Arguments) -> Result<KstTime, String> {
    match arguments.value("now") {
        Some(text) => text.parse().map(KstTime::from_unix).map_err(|_| format!("--now는 Unix 초여야 합니다: {text:?}")),
        None => {
            let elapsed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| format!("시계가 1970년 앞입니다: {error}"))?;
            Ok(KstTime::from_unix(elapsed.as_secs() as i64))
        }
    }
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => return usage_error(error),
    };
    let schedule = match parse_schedule(&arguments) {
        Ok(schedule) => schedule,
        Err(message) => return usage_error(message),
    };
    let allowance = match finalize_allowance(&arguments) {
        Ok(allowance) => allowance,
        Err(message) => return usage_error(message),
    };
    if u64::from(schedule.close_at.secs()) + allowance.as_secs() >= SECS_PER_DAY {
        return usage_error("마감 시각에 정리 여유를 더하면 자정을 넘습니다");
    }
    let now = match now_from(&arguments) {
        Ok(now) => now,
        Err(message) => return usage_error(message),
    };
    let data_dir = arguments.data_dir();
    let runtime = match tokio::runtime::Builder::new_current_thread().build() {
        Ok(runtime) => runtime,
        Err(error) => return usage_error(format_args!("실행 환경을 만들지 못했습니다: {error}")),
    };
    let calendar = runtime.block_on(Calendar::load(&data_dir, &CachedHolidaysOnly, &Secret::new(String::new()), now.unix() * 1000));
    let verdict = decide(&RestartInputs { schedule: &schedule, finalize_allowance: allowance, calendar: &calendar, data_dir: &data_dir, now });
    println!("{}", verdict.line());
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{HolidayRequest, HolidayTransport, TransportError};
    use futures::future::BoxFuture;

    const HOLIDAY_BODY: &str = r#"{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL SERVICE."},"body":{"items":{"item":[{"dateKind":"01","dateName":"기독탄신일","isHoliday":"Y","locdate":20261225,"seq":1}]},"numOfRows":100,"pageNo":1,"totalCount":1}}}"#;

    struct FixedHolidays;

    impl HolidayTransport for FixedHolidays {
        fn fetch<'a>(&'a self, request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
            let body = HOLIDAY_BODY.replace("2026", &request.year.to_string());
            Box::pin(async move { Ok(body) })
        }
    }

    fn kst(date: &str, clock: &str) -> KstTime {
        let day = domain::KstDate::parse_yyyymmdd(date).unwrap();
        let (hour, minute) = clock.split_once(':').unwrap();
        KstTime::from_kst_civil(day, domain::TimeOfDay::hms(hour.parse().unwrap(), minute.parse().unwrap(), 0).unwrap())
    }

    fn verdict_at(data: &Path, calendar: &Calendar, now: KstTime) -> String {
        let schedule = ScheduleSettings::default();
        decide(&RestartInputs { schedule: &schedule, finalize_allowance: DEFAULT_FINALIZE_ALLOWANCE, calendar, data_dir: data, now }).line()
    }

    fn calendar_in(data: &Path) -> Calendar {
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let now = kst("20261123", "07:00").unix() * 1000;
        runtime.block_on(Calendar::load(data, &FixedHolidays, &Secret::new("key".to_owned()), now))
    }

    #[test]
    fn outside_collection_hours_restarts_now_even_on_an_observation_day() {
        let data = tempfile::tempdir().unwrap();
        let calendar = calendar_in(data.path());
        assert!(verdict_at(data.path(), &calendar, kst("20261124", "07:19")).starts_with("now\t"));
        assert!(verdict_at(data.path(), &calendar, kst("20261124", "22:05")).starts_with("now\t"));
    }

    #[test]
    fn a_weekend_or_holiday_restarts_now_during_collection_hours() {
        let data = tempfile::tempdir().unwrap();
        let calendar = calendar_in(data.path());
        for date in ["20261121", "20261225"] {
            let line = verdict_at(data.path(), &calendar, kst(date, "12:00"));
            assert!(line.starts_with("now\t오늘은 쉬는 날이다"), "{date}: {line}");
        }
    }

    #[test]
    fn collection_hours_on_an_observation_day_wait_until_the_finalize_allowance_ends() {
        let data = tempfile::tempdir().unwrap();
        let calendar = calendar_in(data.path());
        for clock in ["07:20", "12:00", "20:05", "21:59"] {
            let line = verdict_at(data.path(), &calendar, kst("20261124", clock));
            assert!(line.starts_with("wait\t2026-11-24 22:05:00 Asia/Seoul\t"), "{clock}: {line}");
        }
    }

    #[test]
    fn a_finished_finalize_ends_the_wait_early_but_a_leftover_temporary_folder_does_not() {
        let data = tempfile::tempdir().unwrap();
        let calendar = calendar_in(data.path());
        let store = data.path().join("store");
        std::fs::create_dir_all(store.join("20261124")).unwrap();
        std::fs::write(store.join("20261124").join(COMPLETE_FILE_NAME), "{}").unwrap();
        assert!(verdict_at(data.path(), &calendar, kst("20261124", "20:30")).starts_with("now\t"));
        assert!(verdict_at(data.path(), &calendar, kst("20261124", "12:00")).starts_with("wait\t"), "마감 전에는 어제 것이 아니라도 정리 완료로 치지 않는다");
        std::fs::create_dir_all(store.join("20261124.tmp")).unwrap();
        assert!(verdict_at(data.path(), &calendar, kst("20261124", "20:30")).starts_with("wait\t"));
    }

    #[test]
    fn an_unreadable_calendar_waits_inside_hours_and_restarts_outside_them() {
        let data = tempfile::tempdir().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let empty = runtime.block_on(Calendar::load(data.path(), &CachedHolidaysOnly, &Secret::new(String::new()), kst("20261124", "07:00").unix() * 1000));
        let inside = verdict_at(data.path(), &empty, kst("20261124", "12:00"));
        assert!(inside.starts_with("wait\t2026-11-24 22:05:00 Asia/Seoul\t달력으로 오늘이 쉬는 날인지 알 수 없다"), "{inside}");
        assert!(verdict_at(data.path(), &empty, kst("20261124", "23:00")).starts_with("now\t"));
    }

    #[test]
    fn the_daemons_own_schedule_options_move_the_window() {
        let data = tempfile::tempdir().unwrap();
        let calendar = calendar_in(data.path());
        let schedule = schedule_from_arguments(&["--close-at".to_owned(), "18:00".to_owned()]).unwrap();
        let verdict = decide(&RestartInputs { schedule: &schedule, finalize_allowance: Duration::from_secs(30 * 60), calendar: &calendar, data_dir: data.path(), now: kst("20261124", "18:10") });
        assert_eq!(verdict.line().split('\t').nth(1), Some("2026-11-24 18:30:00 Asia/Seoul"));
    }
}
