use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::kst::civil_from_days;

const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS: i64 = 9 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Weekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

impl Weekday {
    pub fn is_weekend(self) -> bool {
        matches!(self, Weekday::Saturday | Weekday::Sunday)
    }

    pub fn korean(self) -> &'static str {
        match self {
            Weekday::Monday => "월요일",
            Weekday::Tuesday => "화요일",
            Weekday::Wednesday => "수요일",
            Weekday::Thursday => "목요일",
            Weekday::Friday => "금요일",
            Weekday::Saturday => "토요일",
            Weekday::Sunday => "일요일",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Day(i64);

impl Day {
    pub fn from_ymd(year: u16, month: u8, day: u8) -> Option<Day> {
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Day(days_from_civil(
            i64::from(year),
            i64::from(month),
            i64::from(day),
        )))
    }

    pub fn from_yyyymmdd(date: u32) -> Option<Day> {
        let year = u16::try_from(date / 10_000).ok()?;
        Day::from_ymd(year, (date / 100 % 100) as u8, (date % 100) as u8)
    }

    pub fn yyyymmdd(self) -> u32 {
        let (year, month, day) = civil_from_days(self.0);
        (year * 10_000 + month * 100 + day) as u32
    }

    pub fn year(self) -> u16 {
        (self.yyyymmdd() / 10_000) as u16
    }

    pub fn month(self) -> u8 {
        (self.yyyymmdd() / 100 % 100) as u8
    }

    pub fn day_of_month(self) -> u8 {
        (self.yyyymmdd() % 100) as u8
    }

    pub fn weekday(self) -> Weekday {
        match (self.0 + 3).rem_euclid(7) {
            0 => Weekday::Monday,
            1 => Weekday::Tuesday,
            2 => Weekday::Wednesday,
            3 => Weekday::Thursday,
            4 => Weekday::Friday,
            5 => Weekday::Saturday,
            _ => Weekday::Sunday,
        }
    }

    pub fn plus_days(self, days: i64) -> Day {
        Day(self.0 + days)
    }

    pub fn next(self) -> Day {
        self.plus_days(1)
    }

    pub fn previous(self) -> Day {
        self.plus_days(-1)
    }

    pub fn unix_ms_at_kst(self, hour: u32, minute: u32) -> i64 {
        self.0 * MS_PER_DAY + (i64::from(hour) * 60 + i64::from(minute)) * 60_000 - KST_OFFSET_MS
    }
}

impl fmt::Display for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{:02}-{:02}", self.year(), self.month(), self.day_of_month())
    }
}

impl Serialize for Day {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(self.yyyymmdd())
    }
}

impl<'de> Deserialize<'de> for Day {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Day, D::Error> {
        let date = u32::deserialize(deserializer)?;
        Day::from_yyyymmdd(date)
            .ok_or_else(|| serde::de::Error::custom(format!("{date}은 YYYYMMDD 날짜가 아닙니다")))
    }
}

fn is_leap_year(year: u16) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_index = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_dates_and_knows_weekdays() {
        let day = Day::from_ymd(2026, 11, 17).unwrap();
        assert_eq!(day.yyyymmdd(), 20261117);
        assert_eq!(day.weekday(), Weekday::Tuesday);
        assert_eq!(Day::from_yyyymmdd(19700101).unwrap().weekday(), Weekday::Thursday);
        assert_eq!(Day::from_ymd(2024, 2, 29).unwrap().next().yyyymmdd(), 20240301);
        assert_eq!(day.to_string(), "2026-11-17");
    }

    #[test]
    fn rejects_dates_that_do_not_exist() {
        assert_eq!(Day::from_ymd(2026, 2, 29), None);
        assert_eq!(Day::from_yyyymmdd(20261301), None);
        assert_eq!(Day::from_yyyymmdd(20261100), None);
    }

    #[test]
    fn serializes_as_yyyymmdd_number() {
        let day = Day::from_ymd(2026, 5, 1).unwrap();
        assert_eq!(serde_json::to_string(&day).unwrap(), "20260501");
        assert_eq!(serde_json::from_str::<Day>("20260501").unwrap(), day);
        assert!(serde_json::from_str::<Day>("20260231").is_err());
    }

    #[test]
    fn unix_ms_at_kst_matches_kst_time() {
        let day = Day::from_ymd(2026, 7, 20).unwrap();
        let time = crate::kst::KstTime::from_unix_ms(day.unix_ms_at_kst(10, 27));
        assert_eq!(time.date, 20260720);
        assert_eq!(time.ms_of_day, (10 * 60 + 27) * 60_000);
    }
}
