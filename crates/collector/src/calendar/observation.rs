use std::collections::BTreeMap;
use std::path::Path;

use server::config::Secret;

use super::day::Day;
use super::holidays::{FetchFailure, HolidayTransport, HolidayYear, Provenance, load_year};
use super::judgment::{DEFAULT_OPEN_MINUTE, Evidence, EvidenceInput, Finding, Judgment, Verdict};
use super::overrides::{Overrides, OverridesError};
use crate::kst::KstTime;

pub const CALENDAR_DIR: &str = "calendar";
pub const OVERRIDES_FILE: &str = "overrides.json";
const NEW_YEAR_OPEN_MINUTE: u16 = 10 * 60;
const MAY_DAY: (u8, u8) = (5, 1);
const YEAR_END: (u8, u8) = (12, 31);

#[derive(Debug)]
pub struct Calendar {
    years: BTreeMap<u16, Result<HolidayYear, FetchFailure>>,
    overrides: Result<Overrides, OverridesError>,
}

impl Calendar {
    pub async fn load(
        data_dir: &Path,
        transport: &dyn HolidayTransport,
        service_key: &Secret<String>,
        now_unix_ms: i64,
    ) -> Calendar {
        let this_year = KstTime::from_unix_ms(now_unix_ms).date / 10_000;
        Calendar::load_from_year(data_dir, transport, service_key, now_unix_ms, this_year as u16 - 1).await
    }

    pub async fn load_from_year(
        data_dir: &Path,
        transport: &dyn HolidayTransport,
        service_key: &Secret<String>,
        now_unix_ms: i64,
        first_year: u16,
    ) -> Calendar {
        let calendar_dir = data_dir.join(CALENDAR_DIR);
        let overrides = Overrides::load(&calendar_dir.join(OVERRIDES_FILE));
        if let Err(error) = &overrides {
            tracing::warn!(%error, "관측일 수정 파일을 쓸 수 없다");
        }
        let mut years = BTreeMap::new();
        for year in wanted_years(now_unix_ms, first_year) {
            let loaded = load_year(&calendar_dir, transport, service_key, year, now_unix_ms).await;
            years.insert(year, loaded);
        }
        Calendar { years, overrides }
    }

    pub fn judge(&self, day: Day) -> Judgment {
        let mut evidence = self.closure_evidence(day);
        let verdict = match closure_of(&evidence) {
            Finding::Closed => Verdict::Closed,
            Finding::Unknown => Verdict::Unknown,
            Finding::Open => {
                let (open_minute, finding) = self.open_minute(day);
                evidence.push(finding);
                Verdict::Observed { open_minute }
            }
        };
        Judgment { day, verdict, evidence }
    }

    pub fn next_observation_day(&self, day: Day) -> Result<Day, Judgment> {
        self.observation_days_after(day, 1)
    }

    pub fn observation_days_after(&self, day: Day, count: u32) -> Result<Day, Judgment> {
        self.walk(day, count, Day::next)
    }

    pub fn observation_days_before(&self, day: Day, count: u32) -> Result<Day, Judgment> {
        self.walk(day, count, Day::previous)
    }

    fn walk(&self, from: Day, count: u32, step: fn(Day) -> Day) -> Result<Day, Judgment> {
        let mut day = from;
        let mut remaining = count;
        while remaining > 0 {
            day = step(day);
            let judgment = self.judge(day);
            match judgment.verdict {
                Verdict::Observed { .. } => remaining -= 1,
                Verdict::Closed => {}
                Verdict::Unknown => return Err(judgment),
            }
        }
        Ok(day)
    }

    fn closure_evidence(&self, day: Day) -> Vec<Evidence> {
        vec![
            weekday_evidence(day),
            self.holiday_evidence(day),
            self.krx_closure_evidence(day),
            self.override_closure_evidence(day),
        ]
    }

    fn is_observation_day(&self, day: Day) -> Finding {
        closure_of(&self.closure_evidence(day))
    }

    fn holiday_evidence(&self, day: Day) -> Evidence {
        let year = day.year();
        let (finding, detail) = match self.years.get(&year) {
            Some(Ok(holidays)) => {
                let source = describe_source(year, holidays);
                match holidays.holiday_on(day) {
                    Some(holiday) => (Finding::Closed, format!("{source} 공휴일 '{}'", holiday.name)),
                    None => (Finding::Open, format!("{source} 공휴일이 아니다")),
                }
            }
            Some(Err(failure)) => (
                Finding::Unknown,
                format!("특일정보 {year}: 받기 실패({failure})이고 캐시도 없다"),
            ),
            None => (Finding::Unknown, format!("특일정보 {year}: 받지 않은 해다")),
        };
        Evidence { input: EvidenceInput::PublicHoliday, finding, detail }
    }

    fn krx_closure_evidence(&self, day: Day) -> Evidence {
        let (finding, detail) = if (day.month(), day.day_of_month()) == MAY_DAY {
            (Finding::Closed, "KRX 휴장일: 5월 1일".to_owned())
        } else if (day.month(), day.day_of_month()) == YEAR_END {
            (Finding::Closed, "KRX 휴장일: 12월 31일".to_owned())
        } else if day.month() == 12 {
            self.year_end_shift(day)
        } else {
            (Finding::Open, "KRX 고정 휴장일이 아니다".to_owned())
        };
        Evidence { input: EvidenceInput::KrxClosure, finding, detail }
    }

    fn year_end_shift(&self, day: Day) -> (Finding, String) {
        let year_end = Day::from_ymd(day.year(), YEAR_END.0, YEAR_END.1).unwrap();
        let unknown = |detail: &str| (Finding::Unknown, format!("KRX 연말 휴장일: {detail}"));
        match self.base_status(year_end) {
            Finding::Open => {}
            Finding::Unknown => return unknown("12월 31일이 쉬는 날인지 알 수 없다"),
            Finding::Closed => {
                let mut closing_day = year_end.previous();
                loop {
                    match self.observation_status(closing_day) {
                        Finding::Closed => closing_day = closing_day.previous(),
                        Finding::Unknown => return unknown("직전 관측일을 알 수 없다"),
                        Finding::Open => break,
                    }
                }
                if closing_day == day {
                    return (
                        Finding::Closed,
                        format!(
                            "KRX 연말 휴장일: 12월 31일이 쉬는 날({})이라 직전 관측일이 쉰다",
                            year_end.weekday().korean()
                        ),
                    );
                }
            }
        }
        (Finding::Open, "KRX 고정 휴장일이 아니다".to_owned())
    }

    fn observation_status(&self, day: Day) -> Finding {
        match (self.base_status(day), &self.overrides) {
            (Finding::Open, Ok(overrides)) if overrides.closure_reason(day).is_some() => Finding::Closed,
            (Finding::Open, Err(_)) => Finding::Unknown,
            (status, _) => status,
        }
    }

    fn base_status(&self, day: Day) -> Finding {
        if day.weekday().is_weekend() {
            return Finding::Closed;
        }
        match self.years.get(&day.year()) {
            Some(Ok(holidays)) if holidays.holiday_on(day).is_some() => Finding::Closed,
            Some(Ok(_)) => Finding::Open,
            _ => Finding::Unknown,
        }
    }

    fn override_closure_evidence(&self, day: Day) -> Evidence {
        let (finding, detail) = match &self.overrides {
            Ok(overrides) => match overrides.closure_reason(day) {
                Some(reason) => (Finding::Closed, format!("수정 파일: 임시 휴장 '{reason}'")),
                None => (Finding::Open, "수정 파일에 휴장 기록이 없다".to_owned()),
            },
            Err(error) => (Finding::Unknown, error.to_string()),
        };
        Evidence { input: EvidenceInput::Overrides, finding, detail }
    }

    fn open_minute(&self, day: Day) -> (u16, Evidence) {
        let observed = |minute: u16, detail: String| {
            (minute, Evidence { input: EvidenceInput::OpenTime, finding: Finding::Open, detail })
        };
        if let Ok(overrides) = &self.overrides
            && let Some(change) = overrides.open_time_change(day)
        {
            return observed(
                change.open_minute,
                format!("수정 파일: 개장 {} '{}'", format_minute(change.open_minute), change.reason),
            );
        }
        if self.is_first_observation_day_of_year(day) {
            return observed(
                NEW_YEAR_OPEN_MINUTE,
                format!("새해 첫 관측일이라 개장 {}", format_minute(NEW_YEAR_OPEN_MINUTE)),
            );
        }
        observed(DEFAULT_OPEN_MINUTE, format!("개장 {}", format_minute(DEFAULT_OPEN_MINUTE)))
    }

    fn is_first_observation_day_of_year(&self, day: Day) -> bool {
        if day.month() != 1 {
            return false;
        }
        let mut earlier = Day::from_ymd(day.year(), 1, 1).unwrap();
        while earlier < day {
            if self.is_observation_day(earlier) != Finding::Closed {
                return false;
            }
            earlier = earlier.next();
        }
        true
    }
}

fn wanted_years(now_unix_ms: i64, first_year: u16) -> Vec<u16> {
    let today = KstTime::from_unix_ms(now_unix_ms).date;
    let year = (today / 10_000) as u16;
    let month = today / 100 % 100;
    let last_year = if month == 12 { year + 1 } else { year };
    (first_year.min(year - 1)..=last_year).collect()
}

fn weekday_evidence(day: Day) -> Evidence {
    let weekday = day.weekday();
    let (finding, detail) = if weekday.is_weekend() {
        (Finding::Closed, format!("{}이다", weekday.korean()))
    } else {
        (Finding::Open, format!("{}이다", weekday.korean()))
    };
    Evidence { input: EvidenceInput::Weekday, finding, detail }
}

fn closure_of(evidence: &[Evidence]) -> Finding {
    if evidence.iter().any(|item| item.finding == Finding::Closed) {
        Finding::Closed
    } else if evidence.iter().any(|item| item.finding == Finding::Unknown) {
        Finding::Unknown
    } else {
        Finding::Open
    }
}

fn describe_source(year: u16, holidays: &HolidayYear) -> String {
    let fetched = format_fetched_at(holidays.data.fetched_at_unix_ms);
    match &holidays.provenance {
        Provenance::Fetched { cache_saved: true } => format!("특일정보 {year}({fetched}에 받음):"),
        Provenance::Fetched { cache_saved: false } => {
            format!("특일정보 {year}({fetched}에 받음, 캐시 저장 실패):")
        }
        Provenance::CacheStillCurrent => format!("특일정보 {year}(이달 {fetched}에 받은 캐시):"),
        Provenance::CacheAfterFailure(failure) => {
            format!("특일정보 {year}: 받기 실패({failure})라 {fetched}에 받은 캐시를 썼다.")
        }
    }
}

fn format_fetched_at(unix_ms: i64) -> String {
    let time = KstTime::from_unix_ms(unix_ms);
    let day = Day::from_yyyymmdd(time.date).map(|day| day.to_string()).unwrap_or_default();
    format!("{day} {}", format_minute((time.ms_of_day / 60_000) as u16))
}

fn format_minute(minute: u16) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}
