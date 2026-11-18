use std::time::Duration;

use domain::{KstDate, KstTime, TimeOfDay};

use crate::finalize::RetentionSettings;

const fn clock_time(hour: u32, minute: u32) -> TimeOfDay {
    match TimeOfDay::hms(hour, minute, 0) {
        Some(time) => time,
        None => unreachable!(),
    }
}

#[derive(Debug, Clone)]
pub struct ScheduleSettings {
    pub judge_at: TimeOfDay,
    pub plan_at: TimeOfDay,
    pub launch_at: TimeOfDay,
    pub close_at: TimeOfDay,
    pub market_open_grace: Duration,
    pub reissue_spacing: Duration,
    pub finalize_threads: usize,
    pub retention: RetentionSettings,
}

impl Default for ScheduleSettings {
    fn default() -> ScheduleSettings {
        ScheduleSettings {
            judge_at: clock_time(7, 20),
            plan_at: clock_time(7, 35),
            launch_at: clock_time(7, 55),
            close_at: clock_time(20, 5),
            market_open_grace: Duration::from_secs(10 * 60),
            reissue_spacing: Duration::from_secs(30),
            finalize_threads: 2,
            retention: RetentionSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayTimes {
    pub judge: KstTime,
    pub plan: KstTime,
    pub launch: KstTime,
    pub close: KstTime,
}

impl ScheduleSettings {
    pub fn check(&self) -> Result<(), String> {
        let ordered = [self.judge_at, self.plan_at, self.launch_at, self.close_at].windows(2).all(|pair| pair[0].secs() < pair[1].secs());
        if !ordered {
            return Err("하루 시각은 판단 < 계획 < 띄우기 < 마감 순서여야 합니다".to_owned());
        }
        if self.finalize_threads == 0 {
            return Err("병합 스레드 상한은 1 이상이어야 합니다".to_owned());
        }
        Ok(())
    }

    pub fn times_of(&self, day: KstDate) -> DayTimes {
        let at = |time| KstTime::from_kst_civil(day, time);
        DayTimes { judge: at(self.judge_at), plan: at(self.plan_at), launch: at(self.launch_at), close: at(self.close_at) }
    }
}

pub fn parse_clock_time(text: &str) -> Option<TimeOfDay> {
    let (hour, minute) = text.split_once(':')?;
    let digits = |part: &str| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(hour) || !digits(minute) {
        return None;
    }
    TimeOfDay::hms(hour.parse().ok()?, minute.parse().ok()?, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_times_need_two_digit_hours_and_minutes() {
        assert_eq!(parse_clock_time("07:20"), Some(clock_time(7, 20)));
        assert_eq!(parse_clock_time("7:20"), None);
        assert_eq!(parse_clock_time("25:00"), None);
        assert_eq!(parse_clock_time("0720"), None);
    }

    #[test]
    fn the_day_must_run_in_order() {
        assert!(ScheduleSettings::default().check().is_ok());
        let backwards = ScheduleSettings { plan_at: clock_time(7, 10), ..ScheduleSettings::default() };
        assert!(backwards.check().is_err());
    }
}
