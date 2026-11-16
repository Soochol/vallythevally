const KST_OFFSET_MS: i64 = 9 * 60 * 60 * 1000;
const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE: u32 = 60 * 1000;

pub const SPAN_MINUTES: u16 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KstTime {
    pub date: u32,
    pub ms_of_day: u32,
}

impl KstTime {
    pub fn from_unix_ms(unix_ms: i64) -> KstTime {
        let local_ms = unix_ms + KST_OFFSET_MS;
        let days = local_ms.div_euclid(MS_PER_DAY);
        let ms_of_day = local_ms.rem_euclid(MS_PER_DAY) as u32;
        let (year, month, day) = civil_from_days(days);
        KstTime {
            date: (year * 10_000 + month * 100 + day) as u32,
            ms_of_day,
        }
    }

    pub fn span_start_minute(self) -> u16 {
        let minute = self.ms_of_day / MS_PER_MINUTE;
        (minute - minute % u32::from(SPAN_MINUTES)) as u16
    }
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_epoch + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_unix_ms_to_kst_date_and_ms_of_day() {
        let time = KstTime::from_unix_ms(1_784_510_875_466);
        assert_eq!(time.date, 20260720);
        assert_eq!(time.ms_of_day, ((10 * 60 + 27) * 60 + 55) * 1000 + 466);
        assert_eq!(time.span_start_minute(), 10 * 60 + 25);
    }

    #[test]
    fn utc_evening_is_next_kst_day() {
        let before_midnight = KstTime::from_unix_ms(1_784_559_599_999);
        let at_midnight = KstTime::from_unix_ms(1_784_559_600_000);
        assert_eq!(before_midnight.date, 20260720);
        assert_eq!(before_midnight.span_start_minute(), 23 * 60 + 55);
        assert_eq!(at_midnight.date, 20260721);
        assert_eq!(at_midnight.ms_of_day, 0);
    }

    #[test]
    fn handles_epoch_and_leap_day() {
        assert_eq!(KstTime::from_unix_ms(0).date, 19700101);
        assert_eq!(KstTime::from_unix_ms(0).ms_of_day, 9 * 60 * 60 * 1000);
        assert_eq!(KstTime::from_unix_ms(1_709_164_800_000).date, 20240229);
    }
}
