//! KST 시각. KST는 1988년 이후 서머타임이 없어 고정 오프셋(+09:00)으로 충분하다.

use std::fmt;

const KST_OFFSET_SECS: i64 = 9 * 3600;
const DAY_SECS: i64 = 86_400;

/// 한 순간. 내부 표현은 Unix 초다. 경계를 계산하거나 사람에게 보일 때만 KST로 바꾼다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KstTime(i64);

impl KstTime {
    pub fn from_unix(secs: i64) -> Self {
        KstTime(secs)
    }

    pub fn unix(self) -> i64 {
        self.0
    }

    pub fn from_kst_civil(date: KstDate, tod: TimeOfDay) -> Self {
        KstTime(date.days_since_epoch() * DAY_SECS + i64::from(tod.0) - KST_OFFSET_SECS)
    }

    pub fn kst_date(self) -> KstDate {
        KstDate::from_days_since_epoch((self.0 + KST_OFFSET_SECS).div_euclid(DAY_SECS))
    }

    pub fn kst_time_of_day(self) -> TimeOfDay {
        TimeOfDay((self.0 + KST_OFFSET_SECS).rem_euclid(DAY_SECS) as u32)
    }

    pub fn plus_secs(self, secs: i64) -> Self {
        KstTime(self.0 + secs)
    }
}

impl fmt::Display for KstTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {} KST", self.kst_date(), self.kst_time_of_day())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    /// 월요일 0 … 일요일 6.
    pub fn days_from_monday(self) -> i64 {
        self as i64
    }
}

/// 유효한 달력 날짜만 담는다. 필드 순서(y, m, d) 덕분에 파생한 Ord가 날짜 순서다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KstDate {
    y: i32,
    m: u8,
    d: u8,
}

impl KstDate {
    pub fn new(y: i32, m: u8, d: u8) -> Option<Self> {
        (1..=12).contains(&m).then_some(())?;
        (d >= 1 && d <= days_in_month(y, m)).then_some(KstDate { y, m, d })
    }

    /// 키움 응답의 `YYYYMMDD`.
    pub fn parse_yyyymmdd(s: &str) -> Option<Self> {
        if s.len() != 8 || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        KstDate::new(s[0..4].parse().ok()?, s[4..6].parse().ok()?, s[6..8].parse().ok()?)
    }

    pub fn yyyymmdd(self) -> String {
        format!("{:04}{:02}{:02}", self.y, self.m, self.d)
    }

    pub fn year(self) -> i32 {
        self.y
    }

    pub fn month(self) -> u8 {
        self.m
    }

    pub fn day(self) -> u8 {
        self.d
    }

    pub fn weekday(self) -> Weekday {
        // 1970-01-01은 목요일이다.
        match (self.days_since_epoch() + 3).rem_euclid(7) {
            0 => Weekday::Mon,
            1 => Weekday::Tue,
            2 => Weekday::Wed,
            3 => Weekday::Thu,
            4 => Weekday::Fri,
            5 => Weekday::Sat,
            _ => Weekday::Sun,
        }
    }

    pub fn add_days(self, n: i64) -> Self {
        KstDate::from_days_since_epoch(self.days_since_epoch() + n)
    }

    pub fn first_of_month(self) -> Self {
        KstDate { d: 1, ..self }
    }

    pub fn last_of_month(self) -> Self {
        KstDate { d: days_in_month(self.y, self.m), ..self }
    }

    pub fn first_of_next_month(self) -> Self {
        if self.m == 12 {
            KstDate { y: self.y + 1, m: 1, d: 1 }
        } else {
            KstDate { m: self.m + 1, d: 1, ..self }
        }
    }

    pub fn first_of_prev_month(self) -> Self {
        if self.m == 1 {
            KstDate { y: self.y - 1, m: 12, d: 1 }
        } else {
            KstDate { m: self.m - 1, d: 1, ..self }
        }
    }

    /// 1970-01-01부터의 날 수. Howard Hinnant의 days_from_civil.
    pub fn days_since_epoch(self) -> i64 {
        let y = i64::from(self.y) - i64::from(self.m <= 2);
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let m = i64::from(self.m);
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(self.d) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    pub fn from_days_since_epoch(z: i64) -> Self {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
        let y = (yoe + era * 400 + i64::from(m <= 2)) as i32;
        KstDate { y, m, d }
    }
}

impl fmt::Display for KstDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i32, m: u8) -> u8 {
    match m {
        2 if is_leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 하루 안의 초. 00:00:00 ~ 23:59:59.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TimeOfDay(u32);

impl TimeOfDay {
    pub const MIDNIGHT: TimeOfDay = TimeOfDay(0);

    pub const fn hms(h: u32, m: u32, s: u32) -> Option<Self> {
        if h < 24 && m < 60 && s < 60 { Some(TimeOfDay(h * 3600 + m * 60 + s)) } else { None }
    }

    pub fn secs(self) -> u32 {
        self.0
    }
}

impl fmt::Display for TimeOfDay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:02}:{:02}:{:02}", self.0 / 3600, self.0 / 60 % 60, self.0 % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u8, d: u8) -> KstDate {
        KstDate::new(y, m, d).unwrap()
    }

    #[test]
    fn civil_round_trip_over_a_wide_range() {
        for z in -800_000..800_000 {
            let d = KstDate::from_days_since_epoch(z);
            assert_eq!(d.days_since_epoch(), z);
            assert!(KstDate::new(d.year(), d.month(), d.day()).is_some());
        }
    }

    #[test]
    fn rejects_invalid_dates() {
        assert!(KstDate::new(2026, 2, 29).is_none());
        assert!(KstDate::new(2024, 2, 29).is_some());
        assert!(KstDate::new(2026, 13, 1).is_none());
        assert!(KstDate::new(2026, 11, 31).is_none());
        assert!(KstDate::parse_yyyymmdd("2026110").is_none());
        assert!(KstDate::parse_yyyymmdd("").is_none());
        assert_eq!(KstDate::parse_yyyymmdd("20261106"), Some(date(2026, 11, 6)));
    }

    #[test]
    fn weekdays() {
        assert_eq!(date(1970, 1, 1).weekday(), Weekday::Thu);
        assert_eq!(date(2026, 11, 9).weekday(), Weekday::Mon);
        assert_eq!(date(2026, 11, 1).weekday(), Weekday::Sun);
        assert_eq!(date(2027, 5, 1).weekday(), Weekday::Sat);
    }

    #[test]
    fn kst_offset() {
        // 2026-11-06 00:00 KST = 2026-11-05 15:00 UTC = 1793890800
        let t = KstTime::from_kst_civil(date(2026, 11, 6), TimeOfDay::MIDNIGHT);
        assert_eq!(t.unix(), 1_793_890_800);
        assert_eq!(t.kst_date(), date(2026, 11, 6));
        assert_eq!(t.plus_secs(-1).kst_date(), date(2026, 11, 5));
        assert_eq!(t.plus_secs(-1).kst_time_of_day(), TimeOfDay::hms(23, 59, 59).unwrap());
    }
}
