use domain::{KstDate, KstTime, TimeOfDay, Weekday};

use super::dto::MarketOverviewPhase;

const fn at(hour: u32, minute: u32) -> TimeOfDay {
    match TimeOfDay::hms(hour, minute, 0) {
        Some(time) => time,
        None => panic!("올바른 시각"),
    }
}

const TRADING_STARTS: TimeOfDay = at(8, 0);
const REGULAR_OPENS: TimeOfDay = at(9, 0);
const REGULAR_CLOSES: TimeOfDay = at(15, 30);
const TRADING_ENDS: TimeOfDay = at(20, 0);
const OBSERVATION_DAY_STARTS_SECS: i64 = (7 * 60 + 45) * 60;

pub const SAMPLE_INTERVAL_SECS: i64 = 60;

pub fn phase(now: KstTime) -> MarketOverviewPhase {
    let time = now.kst_time_of_day();
    if matches!(now.kst_date().weekday(), Weekday::Sat | Weekday::Sun) || time < TRADING_STARTS || time >= TRADING_ENDS {
        MarketOverviewPhase::Closed
    } else if time < REGULAR_OPENS {
        MarketOverviewPhase::PreMarket
    } else if time < REGULAR_CLOSES {
        MarketOverviewPhase::Regular
    } else {
        MarketOverviewPhase::AfterMarket
    }
}

pub fn is_sampling_minute(mark: KstTime) -> bool {
    let time = mark.kst_time_of_day();
    !matches!(mark.kst_date().weekday(), Weekday::Sat | Weekday::Sun) && (REGULAR_OPENS..=REGULAR_CLOSES).contains(&time)
}

pub fn observation_day(now: KstTime) -> KstDate {
    now.plus_secs(-OBSERVATION_DAY_STARTS_SECS).kst_date()
}

pub fn minute_floor(now: KstTime) -> KstTime {
    KstTime::from_unix(now.unix().div_euclid(SAMPLE_INTERVAL_SECS) * SAMPLE_INTERVAL_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_time(day: u8, h: u32, m: u32, s: u32) -> KstTime {
        KstTime::from_kst_civil(KstDate::new(2026, 11, day).unwrap(), TimeOfDay::hms(h, m, s).unwrap())
    }

    #[test]
    fn phases_follow_the_trading_windows_and_weekends() {
        assert_eq!(phase(at_time(9, 7, 59, 59)), MarketOverviewPhase::Closed);
        assert_eq!(phase(at_time(9, 8, 0, 0)), MarketOverviewPhase::PreMarket);
        assert_eq!(phase(at_time(9, 9, 0, 0)), MarketOverviewPhase::Regular);
        assert_eq!(phase(at_time(9, 15, 29, 59)), MarketOverviewPhase::Regular);
        assert_eq!(phase(at_time(9, 15, 30, 0)), MarketOverviewPhase::AfterMarket);
        assert_eq!(phase(at_time(9, 20, 0, 0)), MarketOverviewPhase::Closed);
        assert_eq!(phase(at_time(14, 10, 0, 0)), MarketOverviewPhase::Closed);
    }

    #[test]
    fn sampling_covers_the_regular_session_minutes_only() {
        assert!(!is_sampling_minute(at_time(9, 8, 59, 0)));
        assert!(is_sampling_minute(at_time(9, 9, 0, 0)));
        assert!(is_sampling_minute(at_time(9, 15, 30, 0)));
        assert!(!is_sampling_minute(at_time(9, 15, 31, 0)));
        assert!(!is_sampling_minute(at_time(14, 10, 0, 0)));
    }

    #[test]
    fn observation_days_roll_over_at_0745() {
        let day = |d| KstDate::new(2026, 11, d).unwrap();
        assert_eq!(observation_day(at_time(9, 7, 44, 59)), day(8));
        assert_eq!(observation_day(at_time(9, 7, 45, 0)), day(9));
        assert_eq!(observation_day(at_time(9, 23, 59, 0)), day(9));
    }
}
