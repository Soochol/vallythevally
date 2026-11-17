use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use server::config::Secret;

use super::day::Day;
use crate::kst::KstTime;

const CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy)]
pub struct HolidayRequest<'a> {
    pub year: u16,
    pub service_key: &'a Secret<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    Unreachable,
    TimedOut,
    HttpStatus(u16),
}

pub trait HolidayTransport: Send + Sync {
    fn fetch<'a>(
        &'a self,
        request: HolidayRequest<'a>,
    ) -> BoxFuture<'a, Result<String, TransportError>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BadResponse {
    NotJson,
    UnexpectedShape,
    ApiError(String),
    Truncated,
    NoHolidays,
    WrongYear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchFailure {
    Transport(TransportError),
    Response(BadResponse),
    NotLoaded,
}

impl fmt::Display for FetchFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchFailure::Transport(TransportError::Unreachable) => f.write_str("연결 실패"),
            FetchFailure::Transport(TransportError::TimedOut) => f.write_str("시간 초과"),
            FetchFailure::Transport(TransportError::HttpStatus(status)) => {
                write!(f, "HTTP 상태 {status}")
            }
            FetchFailure::Response(BadResponse::NotJson) => f.write_str("응답이 JSON이 아님"),
            FetchFailure::Response(BadResponse::UnexpectedShape) => {
                f.write_str("응답 모양이 다름")
            }
            FetchFailure::Response(BadResponse::ApiError(code)) => {
                write!(f, "서비스 오류 코드 {code}")
            }
            FetchFailure::Response(BadResponse::Truncated) => f.write_str("응답이 일부만 옴"),
            FetchFailure::Response(BadResponse::NoHolidays) => f.write_str("공휴일이 0건"),
            FetchFailure::Response(BadResponse::WrongYear) => {
                f.write_str("다른 해의 날짜가 섞여 있음")
            }
            FetchFailure::NotLoaded => f.write_str("받지 않음"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holiday {
    pub date: Day,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedHolidays {
    pub version: u32,
    pub year: u16,
    pub fetched_at_unix_ms: i64,
    pub holidays: Vec<Holiday>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provenance {
    Fetched { cache_saved: bool },
    CacheStillCurrent,
    CacheAfterFailure(FetchFailure),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolidayYear {
    pub data: CachedHolidays,
    pub provenance: Provenance,
}

impl HolidayYear {
    pub fn holiday_on(&self, day: Day) -> Option<&Holiday> {
        self.data.holidays.iter().find(|holiday| holiday.date == day)
    }
}

pub fn cache_path(calendar_dir: &Path, year: u16) -> PathBuf {
    calendar_dir.join(format!("holidays-{year}.json"))
}

pub async fn load_year(
    calendar_dir: &Path,
    transport: &dyn HolidayTransport,
    service_key: &Secret<String>,
    year: u16,
    now_unix_ms: i64,
) -> Result<HolidayYear, FetchFailure> {
    let path = cache_path(calendar_dir, year);
    let cached = read_cache(&path, year);
    if let Some(data) = &cached
        && !needs_refresh(data, year, now_unix_ms)
    {
        return Ok(HolidayYear { data: data.clone(), provenance: Provenance::CacheStillCurrent });
    }
    match fetch_year(transport, service_key, year).await {
        Ok(holidays) => {
            let data = CachedHolidays {
                version: CACHE_VERSION,
                year,
                fetched_at_unix_ms: now_unix_ms,
                holidays,
            };
            let cache_saved = match write_cache(calendar_dir, &path, &data) {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(year, kind = %error.kind(), "특일정보 캐시를 쓰지 못했다");
                    false
                }
            };
            Ok(HolidayYear { data, provenance: Provenance::Fetched { cache_saved } })
        }
        Err(failure) => match cached {
            Some(data) => {
                tracing::warn!(year, %failure, "특일정보를 받지 못해 캐시를 쓴다");
                Ok(HolidayYear { data, provenance: Provenance::CacheAfterFailure(failure) })
            }
            None => {
                tracing::warn!(year, %failure, "특일정보를 받지 못했고 캐시도 없다");
                Err(failure)
            }
        },
    }
}

fn needs_refresh(cached: &CachedHolidays, year: u16, now_unix_ms: i64) -> bool {
    let now = KstTime::from_unix_ms(now_unix_ms).date;
    if year < (now / 10_000) as u16 {
        return false;
    }
    let fetched_month = KstTime::from_unix_ms(cached.fetched_at_unix_ms).date / 100;
    fetched_month != now / 100
}

async fn fetch_year(
    transport: &dyn HolidayTransport,
    service_key: &Secret<String>,
    year: u16,
) -> Result<Vec<Holiday>, FetchFailure> {
    let body = transport
        .fetch(HolidayRequest { year, service_key })
        .await
        .map_err(FetchFailure::Transport)?;
    parse_holiday_response(year, &body).map_err(FetchFailure::Response)
}

fn read_cache(path: &Path, year: u16) -> Option<CachedHolidays> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(year, kind = %error.kind(), "특일정보 캐시를 읽지 못했다");
            return None;
        }
    };
    let valid = |data: &CachedHolidays| {
        data.version == CACHE_VERSION
            && data.year == year
            && !data.holidays.is_empty()
            && data.holidays.iter().all(|holiday| holiday.date.year() == year)
    };
    match serde_json::from_str::<CachedHolidays>(&text) {
        Ok(data) if valid(&data) => Some(data),
        _ => {
            tracing::warn!(year, "특일정보 캐시 형식이 맞지 않아 버린다");
            None
        }
    }
}

fn write_cache(calendar_dir: &Path, path: &Path, data: &CachedHolidays) -> io::Result<()> {
    std::fs::create_dir_all(calendar_dir)?;
    let mut file = tempfile::NamedTempFile::new_in(calendar_dir)?;
    file.write_all(&serde_json::to_vec_pretty(data).map_err(io::Error::other)?)?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub fn parse_holiday_response(year: u16, body: &str) -> Result<Vec<Holiday>, BadResponse> {
    let value: Value = serde_json::from_str(body).map_err(|_| BadResponse::NotJson)?;
    let response = value.get("response").ok_or(BadResponse::UnexpectedShape)?;
    let result_code = response
        .pointer("/header/resultCode")
        .and_then(text_of)
        .ok_or(BadResponse::UnexpectedShape)?;
    if result_code != "00" {
        let code: String = result_code.chars().filter(char::is_ascii_alphanumeric).take(8).collect();
        return Err(BadResponse::ApiError(code));
    }
    let body = response.get("body").ok_or(BadResponse::UnexpectedShape)?;
    let items = match body.get("items") {
        Some(Value::String(text)) if text.is_empty() => Vec::new(),
        Some(items) => match items.get("item") {
            Some(Value::Array(items)) => items.iter().collect(),
            Some(item @ Value::Object(_)) => vec![item],
            _ => return Err(BadResponse::UnexpectedShape),
        },
        None => return Err(BadResponse::UnexpectedShape),
    };
    if let Some(total) = body.get("totalCount").and_then(text_of).and_then(|text| text.parse::<u64>().ok())
        && total > items.len() as u64
    {
        return Err(BadResponse::Truncated);
    }
    let mut names_by_day: BTreeMap<Day, Vec<String>> = BTreeMap::new();
    for item in items {
        if item.get("isHoliday").and_then(Value::as_str) != Some("Y") {
            continue;
        }
        let date = item
            .get("locdate")
            .and_then(text_of)
            .and_then(|text| text.parse::<u32>().ok())
            .and_then(Day::from_yyyymmdd)
            .ok_or(BadResponse::UnexpectedShape)?;
        if date.year() != year {
            return Err(BadResponse::WrongYear);
        }
        let name = item
            .get("dateName")
            .and_then(Value::as_str)
            .ok_or(BadResponse::UnexpectedShape)?;
        names_by_day.entry(date).or_default().push(name.to_owned());
    }
    if names_by_day.is_empty() {
        return Err(BadResponse::NoHolidays);
    }
    Ok(names_by_day
        .into_iter()
        .map(|(date, names)| Holiday { date, name: names.join(", ") })
        .collect())
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceKeyError {
    Unreadable(io::ErrorKind),
    Empty,
}

impl fmt::Display for ServiceKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ServiceKeyError::Unreadable(kind) => write!(f, "서비스 키 파일을 읽지 못했다({kind})"),
            ServiceKeyError::Empty => f.write_str("서비스 키 파일이 비어 있다"),
        }
    }
}

impl std::error::Error for ServiceKeyError {}

pub fn read_service_key(path: &Path) -> Result<Secret<String>, ServiceKeyError> {
    let text = std::fs::read_to_string(path).map_err(|error| ServiceKeyError::Unreadable(error.kind()))?;
    let key = text.trim();
    if key.is_empty() {
        return Err(ServiceKeyError::Empty);
    }
    Ok(Secret::new(key.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(items: &str, total: usize) -> String {
        format!(
            r#"{{"response":{{"header":{{"resultCode":"00","resultMsg":"NORMAL SERVICE."}},
            "body":{{"items":{items},"numOfRows":100,"pageNo":1,"totalCount":{total}}}}}}}"#
        )
    }

    fn item(date: u32, name: &str, is_holiday: &str) -> String {
        format!(r#"{{"dateKind":"01","dateName":"{name}","isHoliday":"{is_holiday}","locdate":{date},"seq":1}}"#)
    }

    #[test]
    fn reads_an_item_list_and_merges_the_same_day() {
        let items = format!(
            r#"{{"item":[{},{},{}]}}"#,
            item(20260101, "1월1일", "Y"),
            item(20260524, "부처님오신날", "Y"),
            item(20260524, "일요일", "Y"),
        );
        let holidays = parse_holiday_response(2026, &response(&items, 3)).unwrap();
        assert_eq!(holidays.len(), 2);
        assert_eq!(holidays[1].name, "부처님오신날, 일요일");
    }

    #[test]
    fn reads_a_single_item_object_and_skips_non_holidays() {
        let single = format!(r#"{{"item":{}}}"#, item(20260301, "삼일절", "Y"));
        assert_eq!(parse_holiday_response(2026, &response(&single, 1)).unwrap().len(), 1);
        let non_holiday = format!(r#"{{"item":[{},{}]}}"#, item(20260301, "삼일절", "Y"), item(20260302, "기념일", "N"));
        assert_eq!(parse_holiday_response(2026, &response(&non_holiday, 2)).unwrap().len(), 1);
    }

    #[test]
    fn total_count_written_as_text_still_detects_truncation() {
        let one = format!(r#"{{"item":[{}]}}"#, item(20260101, "1월1일", "Y"));
        let body = response(&one, 8).replace(r#""totalCount":8"#, r#""totalCount":"8""#);
        assert_eq!(parse_holiday_response(2026, &body), Err(BadResponse::Truncated));
    }

    #[test]
    fn rejects_unusable_responses() {
        assert_eq!(parse_holiday_response(2026, "<xml/>"), Err(BadResponse::NotJson));
        assert_eq!(parse_holiday_response(2026, &response("\"\"", 0)), Err(BadResponse::NoHolidays));
        let one = format!(r#"{{"item":[{}]}}"#, item(20260101, "1월1일", "Y"));
        assert_eq!(parse_holiday_response(2026, &response(&one, 9)), Err(BadResponse::Truncated));
        assert_eq!(parse_holiday_response(2025, &response(&one, 1)), Err(BadResponse::WrongYear));
        let error = r#"{"response":{"header":{"resultCode":"30","resultMsg":"SERVICE KEY IS NOT REGISTERED ERROR."}}}"#;
        assert_eq!(parse_holiday_response(2026, error), Err(BadResponse::ApiError("30".to_owned())));
    }

    #[test]
    fn service_key_file_is_trimmed_and_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("key");
        std::fs::write(&path, "  abc/+=key\n").unwrap();
        let key = read_service_key(&path).unwrap();
        assert_eq!(key.expose(), "abc/+=key");
        assert!(!format!("{key:?}").contains("abc"));
        std::fs::write(&path, " \n").unwrap();
        assert_eq!(read_service_key(&path).unwrap_err(), ServiceKeyError::Empty);
    }
}
