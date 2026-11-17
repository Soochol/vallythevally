use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;

use serde::Deserialize;

use super::day::Day;

const SUPPORTED_VERSION: u32 = 1;
const MINUTES_PER_DAY: u16 = 24 * 60;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OverridesFile {
    version: u32,
    days: Vec<OverrideEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OverrideEntry {
    Closed { date: Day, reason: String },
    OpenAt { date: Day, time: String, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTimeChange {
    pub open_minute: u16,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Overrides {
    closures: BTreeMap<Day, String>,
    open_times: BTreeMap<Day, OpenTimeChange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverridesError {
    Unreadable(io::ErrorKind),
    Malformed(String),
    UnsupportedVersion(u32),
    DuplicateDate(Day),
    BadTime(String),
}

impl fmt::Display for OverridesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OverridesError::Unreadable(kind) => write!(f, "수정 파일을 읽지 못했다({kind})"),
            OverridesError::Malformed(message) => write!(f, "수정 파일 형식 오류: {message}"),
            OverridesError::UnsupportedVersion(version) => {
                write!(f, "수정 파일 version {version}은 지원하지 않는다(지원: {SUPPORTED_VERSION})")
            }
            OverridesError::DuplicateDate(day) => {
                write!(f, "수정 파일에 {day}이 두 번 적혀 있다")
            }
            OverridesError::BadTime(time) => {
                write!(f, "수정 파일의 개장 시각 '{time}'은 HH:MM이 아니다")
            }
        }
    }
}

impl std::error::Error for OverridesError {}

impl Overrides {
    pub fn load(path: &Path) -> Result<Overrides, OverridesError> {
        match std::fs::read_to_string(path) {
            Ok(text) => Overrides::parse(&text),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Overrides::default()),
            Err(error) => Err(OverridesError::Unreadable(error.kind())),
        }
    }

    pub fn parse(text: &str) -> Result<Overrides, OverridesError> {
        let file: OverridesFile =
            serde_json::from_str(text).map_err(|error| OverridesError::Malformed(error.to_string()))?;
        if file.version != SUPPORTED_VERSION {
            return Err(OverridesError::UnsupportedVersion(file.version));
        }
        let mut overrides = Overrides::default();
        let mut seen = std::collections::BTreeSet::new();
        for entry in file.days {
            let (date, reason, open_minute) = match entry {
                OverrideEntry::Closed { date, reason } => (date, reason, None),
                OverrideEntry::OpenAt { date, time, reason } => {
                    (date, reason, Some(parse_minute_of_day(&time)?))
                }
            };
            if !seen.insert(date) {
                return Err(OverridesError::DuplicateDate(date));
            }
            match open_minute {
                None => {
                    overrides.closures.insert(date, reason);
                }
                Some(open_minute) => {
                    overrides.open_times.insert(date, OpenTimeChange { open_minute, reason });
                }
            }
        }
        Ok(overrides)
    }

    pub fn closure_reason(&self, day: Day) -> Option<&str> {
        self.closures.get(&day).map(String::as_str)
    }

    pub fn open_time_change(&self, day: Day) -> Option<&OpenTimeChange> {
        self.open_times.get(&day)
    }
}

fn parse_minute_of_day(time: &str) -> Result<u16, OverridesError> {
    let bad = || OverridesError::BadTime(time.to_owned());
    let (hour, minute) = time.split_once(':').ok_or_else(bad)?;
    if hour.len() != 2 || minute.len() != 2 {
        return Err(bad());
    }
    let hour: u16 = hour.parse().map_err(|_| bad())?;
    let minute: u16 = minute.parse().map_err(|_| bad())?;
    let total = hour * 60 + minute;
    if minute >= 60 || total >= MINUTES_PER_DAY {
        return Err(bad());
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(year: u16, month: u8, date: u8) -> Day {
        Day::from_ymd(year, month, date).unwrap()
    }

    #[test]
    fn reads_closures_and_open_time_changes() {
        let overrides = Overrides::parse(
            r#"{"version":1,"days":[
                {"kind":"closed","date":20261118,"reason":"임시 휴장"},
                {"kind":"open_at","date":20261119,"time":"10:00","reason":"수능"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(overrides.closure_reason(day(2026, 11, 18)), Some("임시 휴장"));
        assert_eq!(overrides.closure_reason(day(2026, 11, 19)), None);
        assert_eq!(overrides.open_time_change(day(2026, 11, 19)).unwrap().open_minute, 600);
    }

    #[test]
    fn rejects_malformed_files() {
        let cases = [
            "not json",
            r#"{"version":2,"days":[]}"#,
            r#"{"version":1,"days":[{"kind":"closed","date":20261301,"reason":"x"}]}"#,
            r#"{"version":1,"days":[{"kind":"open_at","date":20261119,"time":"25:00","reason":"x"}]}"#,
            r#"{"version":1,"days":[{"kind":"open_at","date":20261119,"time":"9:00","reason":"x"}]}"#,
            r#"{"version":1,"days":[{"kind":"closed","date":20261119,"reason":"x","extra":1}]}"#,
            r#"{"version":1,"days":[{"kind":"holiday","date":20261119,"reason":"x"}]}"#,
            r#"{"version":1,"days":[
                {"kind":"closed","date":20261119,"reason":"x"},
                {"kind":"open_at","date":20261119,"time":"10:00","reason":"y"}]}"#,
        ];
        for case in cases {
            assert!(Overrides::parse(case).is_err(), "{case}");
        }
    }

    #[test]
    fn missing_file_means_no_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let overrides = Overrides::load(&dir.path().join("overrides.json")).unwrap();
        assert_eq!(overrides, Overrides::default());
    }
}
