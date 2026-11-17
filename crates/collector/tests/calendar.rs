use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use collector::calendar::{
    Calendar, CrossCheck, Day, EvidenceInput, Finding, HolidayRequest, HolidayTransport, Judgment,
    Mismatch, TransportError, Verdict, cross_check,
};
use futures::future::BoxFuture;
use server::config::Secret;
use tempfile::{TempDir, tempdir};

const SERVICE_KEY: &str = "SvcKey-9f2c+/7aQ==";

struct FakeHolidays {
    responses: Mutex<HashMap<u16, Result<String, TransportError>>>,
    calls: Mutex<Vec<(u16, String)>>,
}

impl FakeHolidays {
    fn new() -> FakeHolidays {
        FakeHolidays { responses: Mutex::new(HashMap::new()), calls: Mutex::new(Vec::new()) }
    }

    fn with_years(years: &[(u16, &[(u32, &str)])]) -> FakeHolidays {
        let fake = FakeHolidays::new();
        for (year, holidays) in years {
            fake.set(*year, Ok(response_body(holidays)));
        }
        fake
    }

    fn set(&self, year: u16, response: Result<String, TransportError>) {
        self.responses.lock().unwrap().insert(year, response);
    }

    fn calls_for(&self, year: u16) -> usize {
        self.calls.lock().unwrap().iter().filter(|(called, _)| *called == year).count()
    }

    fn total_calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

impl HolidayTransport for FakeHolidays {
    fn fetch<'a>(&'a self, request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
        self.calls.lock().unwrap().push((request.year, request.service_key.expose().clone()));
        let response = self
            .responses
            .lock()
            .unwrap()
            .get(&request.year)
            .cloned()
            .unwrap_or(Err(TransportError::Unreachable));
        Box::pin(async move { response })
    }
}

fn response_body(holidays: &[(u32, &str)]) -> String {
    let items: Vec<String> = holidays
        .iter()
        .map(|(date, name)| {
            format!(r#"{{"dateKind":"01","dateName":"{name}","isHoliday":"Y","locdate":{date},"seq":1}}"#)
        })
        .collect();
    format!(
        r#"{{"response":{{"header":{{"resultCode":"00","resultMsg":"NORMAL SERVICE."}},"body":{{"items":{{"item":[{}]}},"numOfRows":100,"pageNo":1,"totalCount":{}}}}}}}"#,
        items.join(","),
        items.len()
    )
}

type YearEndCase = (u16, &'static [(u32, &'static str)], [(u8, bool); 3]);

const HOLIDAYS_2025: &[(u32, &str)] = &[(20250101, "1월1일"), (20251225, "기독탄신일")];
const HOLIDAYS_2026: &[(u32, &str)] = &[
    (20260101, "1월1일"),
    (20260301, "삼일절"),
    (20260302, "대체공휴일(삼일절)"),
    (20260505, "어린이날"),
    (20260924, "추석"),
    (20260925, "추석"),
    (20260926, "추석"),
    (20261225, "기독탄신일"),
];
const HOLIDAYS_2027: &[(u32, &str)] = &[(20270101, "1월1일"), (20270209, "설날")];

fn day(year: u16, month: u8, date: u8) -> Day {
    Day::from_ymd(year, month, date).unwrap()
}

fn at_0720(day: Day) -> i64 {
    day.unix_ms_at_kst(7, 20)
}

fn key() -> Secret<String> {
    Secret::new(SERVICE_KEY.to_owned())
}

async fn load_at(data: &Path, fake: &FakeHolidays, now: Day) -> Calendar {
    Calendar::load(data, fake, &key(), at_0720(now)).await
}

async fn standard_calendar() -> (TempDir, Calendar) {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::with_years(&[(2025, HOLIDAYS_2025), (2026, HOLIDAYS_2026)]);
    let calendar = load_at(data.path(), &fake, day(2026, 11, 17)).await;
    (data, calendar)
}

fn write_overrides(data: &Path, text: &str) {
    fs::create_dir_all(data.join("calendar")).unwrap();
    fs::write(data.join("calendar/overrides.json"), text).unwrap();
}

fn finding_of(judgment: &Judgment, input: EvidenceInput) -> Finding {
    judgment.evidence.iter().find(|item| item.input == input).unwrap().finding
}

fn detail_of(judgment: &Judgment, input: EvidenceInput) -> &str {
    &judgment.evidence.iter().find(|item| item.input == input).unwrap().detail
}

#[tokio::test]
async fn a_plain_weekday_is_observed_with_the_usual_open_time() {
    let (_data, calendar) = standard_calendar().await;
    let judgment = calendar.judge(day(2026, 11, 17));
    assert_eq!(judgment.verdict, Verdict::Observed { open_minute: 9 * 60 });
    for input in [
        EvidenceInput::Weekday,
        EvidenceInput::PublicHoliday,
        EvidenceInput::KrxClosure,
        EvidenceInput::Overrides,
        EvidenceInput::OpenTime,
    ] {
        assert_eq!(finding_of(&judgment, input), Finding::Open, "{input:?}");
    }
    assert!(detail_of(&judgment, EvidenceInput::PublicHoliday).contains("2026-11-17 07:20에 받음"));
}

#[tokio::test]
async fn weekends_are_closed() {
    let (_data, calendar) = standard_calendar().await;
    for (date, name) in [(21, "토요일"), (22, "일요일")] {
        let judgment = calendar.judge(day(2026, 11, date));
        assert_eq!(judgment.verdict, Verdict::Closed);
        assert_eq!(finding_of(&judgment, EvidenceInput::Weekday), Finding::Closed);
        assert!(detail_of(&judgment, EvidenceInput::Weekday).contains(name));
    }
}

#[tokio::test]
async fn public_holidays_and_substitute_holidays_are_closed() {
    let (_data, calendar) = standard_calendar().await;
    let chuseok = calendar.judge(day(2026, 9, 25));
    assert_eq!(chuseok.verdict, Verdict::Closed);
    assert!(detail_of(&chuseok, EvidenceInput::PublicHoliday).contains("추석"));
    let substitute = calendar.judge(day(2026, 3, 2));
    assert_eq!(substitute.verdict, Verdict::Closed);
    assert!(detail_of(&substitute, EvidenceInput::PublicHoliday).contains("대체공휴일(삼일절)"));
}

#[tokio::test]
async fn krx_closes_on_may_first_and_december_31() {
    let (_data, calendar) = standard_calendar().await;
    let may_first = calendar.judge(day(2026, 5, 1));
    assert_eq!(may_first.verdict, Verdict::Closed);
    assert_eq!(finding_of(&may_first, EvidenceInput::KrxClosure), Finding::Closed);
    assert_eq!(finding_of(&may_first, EvidenceInput::Weekday), Finding::Open);
    assert!(matches!(calendar.judge(day(2026, 4, 30)).verdict, Verdict::Observed { .. }));
    let year_end = calendar.judge(day(2026, 12, 31));
    assert_eq!(year_end.verdict, Verdict::Closed);
    assert_eq!(finding_of(&year_end, EvidenceInput::KrxClosure), Finding::Closed);
    assert!(matches!(calendar.judge(day(2026, 12, 30)).verdict, Verdict::Observed { .. }));
}

#[tokio::test]
async fn when_december_31_is_not_a_weekday_the_previous_observation_day_is_closed() {
    let cases: [YearEndCase; 3] = [
        (2022, &[(20220101, "1월1일")], [(30, true), (29, false), (28, false)]),
        (2023, &[(20230101, "1월1일")], [(29, true), (28, false), (27, false)]),
        (2024, &[(20241231, "임시공휴일")], [(30, true), (27, false), (26, false)]),
    ];
    for (year, holidays, expectations) in cases {
        let data = tempdir().unwrap();
        let fake = FakeHolidays::new();
        fake.set(year, Ok(response_body(holidays)));
        for neighbor in [year - 1, year + 1] {
            fake.set(neighbor, Ok(response_body(&[(u32::from(neighbor) * 10_000 + 101, "1월1일")])));
        }
        let calendar = load_at(data.path(), &fake, day(year, 12, 20)).await;
        assert_eq!(calendar.judge(day(year, 12, 31)).verdict, Verdict::Closed);
        for (date, closed) in expectations {
            let judgment = calendar.judge(day(year, 12, date));
            if closed {
                assert_eq!(judgment.verdict, Verdict::Closed, "{year}-12-{date}");
                assert_eq!(finding_of(&judgment, EvidenceInput::KrxClosure), Finding::Closed);
            } else if day(year, 12, date).weekday().is_weekend() {
                assert_eq!(judgment.verdict, Verdict::Closed);
            } else {
                assert!(matches!(judgment.verdict, Verdict::Observed { .. }), "{year}-12-{date}");
            }
        }
    }
}

#[tokio::test]
async fn overrides_close_a_day_and_move_the_open_time() {
    let data = tempdir().unwrap();
    write_overrides(
        data.path(),
        r#"{"version":1,"days":[
            {"kind":"closed","date":20261118,"reason":"임시 휴장"},
            {"kind":"open_at","date":20261119,"time":"10:00","reason":"수능"}
        ]}"#,
    );
    let fake = FakeHolidays::with_years(&[(2025, HOLIDAYS_2025), (2026, HOLIDAYS_2026)]);
    let calendar = load_at(data.path(), &fake, day(2026, 11, 17)).await;
    let closed = calendar.judge(day(2026, 11, 18));
    assert_eq!(closed.verdict, Verdict::Closed);
    assert!(detail_of(&closed, EvidenceInput::Overrides).contains("임시 휴장"));
    let exam = calendar.judge(day(2026, 11, 19));
    assert_eq!(exam.verdict, Verdict::Observed { open_minute: 10 * 60 });
    assert!(detail_of(&exam, EvidenceInput::OpenTime).contains("수능"));
    assert_eq!(calendar.judge(day(2026, 11, 20)).verdict, Verdict::Observed { open_minute: 9 * 60 });
}

#[tokio::test]
async fn the_first_observation_day_of_the_year_opens_at_ten() {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::with_years(&[(2025, HOLIDAYS_2025), (2026, HOLIDAYS_2026), (2027, HOLIDAYS_2027)]);
    let calendar = load_at(data.path(), &fake, day(2026, 12, 1)).await;
    assert_eq!(calendar.judge(day(2026, 1, 1)).verdict, Verdict::Closed);
    let first = calendar.judge(day(2026, 1, 2));
    assert_eq!(first.verdict, Verdict::Observed { open_minute: 10 * 60 });
    assert!(detail_of(&first, EvidenceInput::OpenTime).contains("새해 첫 관측일"));
    assert_eq!(calendar.judge(day(2026, 1, 5)).verdict, Verdict::Observed { open_minute: 9 * 60 });
    assert_eq!(calendar.judge(day(2027, 1, 1)).verdict, Verdict::Closed);
    assert_eq!(calendar.judge(day(2027, 1, 4)).verdict, Verdict::Observed { open_minute: 10 * 60 });
    assert_eq!(calendar.judge(day(2027, 1, 5)).verdict, Verdict::Observed { open_minute: 9 * 60 });
}

#[tokio::test]
async fn a_failed_fetch_falls_back_to_the_cache_and_says_so() {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::with_years(&[(2025, HOLIDAYS_2025), (2026, HOLIDAYS_2026)]);
    load_at(data.path(), &fake, day(2026, 10, 5)).await;
    fake.set(2026, Err(TransportError::TimedOut));
    let calendar = load_at(data.path(), &fake, day(2026, 11, 3)).await;
    let chuseok = calendar.judge(day(2026, 9, 25));
    assert_eq!(chuseok.verdict, Verdict::Closed);
    let detail = detail_of(&chuseok, EvidenceInput::PublicHoliday);
    assert!(detail.contains("받기 실패(시간 초과)"), "{detail}");
    assert!(detail.contains("2026-10-05 07:20에 받은 캐시"), "{detail}");
    let weekday = calendar.judge(day(2026, 11, 17));
    assert!(matches!(weekday.verdict, Verdict::Observed { .. }));
    assert!(detail_of(&weekday, EvidenceInput::PublicHoliday).contains("받기 실패(시간 초과)"));
}

#[tokio::test]
async fn without_a_cache_a_failed_fetch_makes_the_judgment_unknown() {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::new();
    fake.set(2026, Err(TransportError::HttpStatus(503)));
    let calendar = load_at(data.path(), &fake, day(2026, 11, 17)).await;
    let weekday = calendar.judge(day(2026, 11, 17));
    assert_eq!(weekday.verdict, Verdict::Unknown);
    assert_eq!(finding_of(&weekday, EvidenceInput::PublicHoliday), Finding::Unknown);
    assert!(detail_of(&weekday, EvidenceInput::PublicHoliday).contains("HTTP 상태 503"));
    assert_eq!(calendar.judge(day(2026, 11, 21)).verdict, Verdict::Closed);
    assert!(!data.path().join("calendar/holidays-2026.json").exists());
}

#[tokio::test]
async fn a_response_without_holidays_is_not_trusted_or_cached() {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::new();
    fake.set(2026, Ok(r#"{"response":{"header":{"resultCode":"00"},"body":{"items":"","totalCount":0}}}"#.to_owned()));
    let calendar = load_at(data.path(), &fake, day(2026, 11, 17)).await;
    assert_eq!(calendar.judge(day(2026, 11, 17)).verdict, Verdict::Unknown);
    assert!(!data.path().join("calendar/holidays-2026.json").exists());
}

#[tokio::test]
async fn a_malformed_overrides_file_makes_open_days_unknown() {
    let data = tempdir().unwrap();
    write_overrides(data.path(), r#"{"version":1,"days":[{"kind":"closed","date":20261340,"reason":"x"}]}"#);
    let fake = FakeHolidays::with_years(&[(2025, HOLIDAYS_2025), (2026, HOLIDAYS_2026)]);
    let calendar = load_at(data.path(), &fake, day(2026, 11, 17)).await;
    let weekday = calendar.judge(day(2026, 11, 17));
    assert_eq!(weekday.verdict, Verdict::Unknown);
    assert_eq!(finding_of(&weekday, EvidenceInput::Overrides), Finding::Unknown);
    assert!(detail_of(&weekday, EvidenceInput::Overrides).contains("수정 파일 형식 오류"));
    assert_eq!(calendar.judge(day(2026, 11, 21)).verdict, Verdict::Closed);
}

#[tokio::test]
async fn holidays_are_fetched_once_a_month() {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::with_years(&[
        (2025, HOLIDAYS_2025),
        (2026, HOLIDAYS_2026),
        (2027, HOLIDAYS_2027),
    ]);
    load_at(data.path(), &fake, day(2026, 11, 3)).await;
    assert_eq!((fake.calls_for(2025), fake.calls_for(2026)), (1, 1));

    let same_month = load_at(data.path(), &fake, day(2026, 11, 20)).await;
    assert_eq!(fake.total_calls(), 2);
    assert!(detail_of(&same_month.judge(day(2026, 11, 20)), EvidenceInput::PublicHoliday).contains("이달"));

    load_at(data.path(), &fake, day(2026, 12, 1)).await;
    assert_eq!(fake.calls_for(2026), 2);
    assert_eq!(fake.calls_for(2027), 1);
    assert_eq!(fake.calls_for(2025), 1);

    load_at(data.path(), &fake, day(2026, 12, 2)).await;
    assert_eq!(fake.total_calls(), 4);
}

#[tokio::test]
async fn the_cache_file_records_when_it_was_fetched() {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::with_years(&[(2025, HOLIDAYS_2025), (2026, HOLIDAYS_2026)]);
    let now = at_0720(day(2026, 11, 17));
    Calendar::load(data.path(), &fake, &key(), now).await;
    let cache: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(data.path().join("calendar/holidays-2026.json")).unwrap()).unwrap();
    assert_eq!(cache["year"], 2026);
    assert_eq!(cache["fetched_at_unix_ms"], now);
    assert_eq!(cache["holidays"][0]["date"], 20260101);
}

#[tokio::test]
async fn counting_observation_days_skips_closed_days() {
    let (_data, calendar) = standard_calendar().await;
    assert_eq!(calendar.next_observation_day(day(2026, 11, 20)).unwrap(), day(2026, 11, 23));
    assert_eq!(calendar.observation_days_after(day(2026, 9, 23), 1).unwrap(), day(2026, 9, 28));
    assert_eq!(calendar.observation_days_after(day(2026, 9, 23), 3).unwrap(), day(2026, 9, 30));
    assert_eq!(calendar.observation_days_before(day(2026, 9, 28), 1).unwrap(), day(2026, 9, 23));
    assert_eq!(calendar.observation_days_before(day(2026, 9, 28), 2).unwrap(), day(2026, 9, 22));
    assert_eq!(calendar.observation_days_before(day(2026, 11, 20), 0).unwrap(), day(2026, 11, 20));
}

#[tokio::test]
async fn counting_crosses_the_year_end_closure() {
    let (_data, calendar) = standard_calendar().await;
    assert_eq!(calendar.observation_days_before(day(2026, 1, 5), 1).unwrap(), day(2026, 1, 2));
    assert_eq!(calendar.observation_days_before(day(2026, 1, 5), 2).unwrap(), day(2025, 12, 30));
}

#[tokio::test]
async fn counting_stops_where_the_calendar_is_unknown() {
    let (_data, calendar) = standard_calendar().await;
    let unknown = calendar.observation_days_before(day(2025, 1, 3), 3).unwrap_err();
    assert_eq!(unknown.verdict, Verdict::Unknown);
    assert_eq!(unknown.day.year(), 2024);
}

#[tokio::test]
async fn cross_check_compares_the_judgment_with_index_candles() {
    let (_data, calendar) = standard_calendar().await;
    let open_day = calendar.judge(day(2026, 11, 17));
    let closed_day = calendar.judge(day(2026, 9, 25));
    let candles = [day(2026, 9, 23), day(2026, 11, 17)];
    assert_eq!(cross_check(&open_day, &candles), CrossCheck::Agrees);
    assert_eq!(cross_check(&closed_day, &candles), CrossCheck::Agrees);
    assert_eq!(
        cross_check(&open_day, &[day(2026, 11, 16)]),
        CrossCheck::Disagrees { mismatch: Mismatch::ObservedWithoutIndexCandle }
    );
    assert_eq!(
        cross_check(&closed_day, &[day(2026, 9, 25)]),
        CrossCheck::Disagrees { mismatch: Mismatch::ClosedWithIndexCandle }
    );
    assert_eq!(cross_check(&open_day, &[]), CrossCheck::Undetermined);

    let data = tempdir().unwrap();
    let unknown_calendar = load_at(data.path(), &FakeHolidays::new(), day(2026, 11, 17)).await;
    let unknown_day = unknown_calendar.judge(day(2026, 11, 17));
    assert_eq!(cross_check(&unknown_day, &candles), CrossCheck::Undetermined);
}

#[tokio::test]
async fn a_judgment_serializes_with_its_evidence() {
    let (_data, calendar) = standard_calendar().await;
    let judgment = calendar.judge(day(2026, 11, 17));
    let value = serde_json::to_value(&judgment).unwrap();
    assert_eq!(value["day"], 20261117);
    assert_eq!(value["verdict"]["kind"], "observed");
    assert_eq!(value["verdict"]["open_minute"], 540);
    assert_eq!(value["evidence"][0]["input"], "weekday");
    assert_eq!(value["evidence"][0]["finding"], "open");
    assert_eq!(serde_json::from_value::<Judgment>(value).unwrap(), judgment);
}

#[tokio::test]
async fn the_service_key_never_reaches_files_logs_or_error_text() {
    let data = tempdir().unwrap();
    let fake = FakeHolidays::with_years(&[(2025, HOLIDAYS_2025), (2026, HOLIDAYS_2026)]);
    load_at(data.path(), &fake, day(2026, 10, 5)).await;
    assert!(fake.calls.lock().unwrap().iter().all(|(_, seen)| seen == SERVICE_KEY));
    assert!(fake.total_calls() > 0);

    fake.set(2026, Err(TransportError::Unreachable));
    fake.set(2025, Ok("<OpenAPI_ServiceResponse>SERVICE KEY IS NOT REGISTERED</OpenAPI_ServiceResponse>".to_owned()));
    let cached = load_at(data.path(), &fake, day(2026, 11, 3)).await;
    let uncached_dir = tempdir().unwrap();
    let uncached = load_at(uncached_dir.path(), &fake, day(2026, 11, 3)).await;

    let mut texts = vec![format!("{cached:?}"), format!("{uncached:?}")];
    for calendar in [&cached, &uncached] {
        for date in [day(2026, 9, 25), day(2026, 11, 17), day(2026, 12, 31)] {
            texts.push(serde_json::to_string(&calendar.judge(date)).unwrap());
        }
    }
    for root in [data.path(), uncached_dir.path()] {
        if let Ok(entries) = fs::read_dir(root.join("calendar")) {
            for entry in entries {
                texts.push(fs::read_to_string(entry.unwrap().path()).unwrap());
            }
        }
    }
    for text in texts {
        assert!(!text.contains(SERVICE_KEY), "{text}");
        assert!(!text.contains("SvcKey"), "{text}");
    }
}
