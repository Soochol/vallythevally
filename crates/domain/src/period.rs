use std::fmt;

use crate::time::{KstDate, KstTime, TimeOfDay, Weekday};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodError(pub String);

impl fmt::Display for PeriodError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "봉 주기가 아닙니다: {}", self.0)
    }
}

impl std::error::Error for PeriodError {}

/// 봉 주기.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Period {
    M1,
    M3,
    M5,
    M10,
    M15,
    M30,
    M60,
    Day,
    Week,
    Month,
}

impl Period {
    pub const ALL: [Period; 10] = [
        Period::M1,
        Period::M3,
        Period::M5,
        Period::M10,
        Period::M15,
        Period::M30,
        Period::M60,
        Period::Day,
        Period::Week,
        Period::Month,
    ];

    pub fn as_wire(self) -> &'static str {
        match self {
            Period::M1 => "1m",
            Period::M3 => "3m",
            Period::M5 => "5m",
            Period::M10 => "10m",
            Period::M15 => "15m",
            Period::M30 => "30m",
            Period::M60 => "60m",
            Period::Day => "D",
            Period::Week => "W",
            Period::Month => "M",
        }
    }

    pub fn parse(s: &str) -> Result<Self, PeriodError> {
        Period::ALL
            .into_iter()
            .find(|p| p.as_wire() == s)
            .ok_or_else(|| PeriodError(s.to_owned()))
    }

    pub fn is_intraday(self) -> bool {
        self.minutes().is_some()
    }

    /// 분봉의 분 수. 일·주·월봉은 None.
    pub fn minutes(self) -> Option<i64> {
        match self {
            Period::M1 => Some(1),
            Period::M3 => Some(3),
            Period::M5 => Some(5),
            Period::M10 => Some(10),
            Period::M15 => Some(15),
            Period::M30 => Some(30),
            Period::M60 => Some(60),
            Period::Day | Period::Week | Period::Month => None,
        }
    }

    /// [20:00:00, 20:00:10)의 체결도 키움은 그날 마지막 분봉에 넣는다(D16).
    pub fn trade_bucket(self, at: KstTime) -> Bucket {
        let close = KstTime::from_kst_civil(at.kst_date(), SESSION_CLOSE);
        let effective = if self.is_intraday() && close <= at && at < close.plus_secs(CLOSE_GRACE_SECS) { close.plus_secs(-1) } else { at };
        self.bucket(effective)
    }

    /// 시각 t가 속한 봉 구간. 봉 시작 시각을 만드는 유일한 방법이다.
    /// 주봉은 그 주 월요일, 월봉은 그달 1일(주말이어도)로 맞춘다. 키움의 주·월봉 `dt`는
    /// 그 구간의 첫 관측일이라(kiwoom.md §10.8) 파서가 반드시 이 함수를 거친다.
    pub fn bucket(self, t: KstTime) -> Bucket {
        let start = match self.minutes() {
            Some(n) => {
                let tod = i64::from(t.kst_time_of_day().secs());
                t.plus_secs(-(tod % (n * 60)))
            }
            None => {
                let date = t.kst_date();
                let first = match self {
                    Period::Week => date.add_days(-date.weekday().days_from_monday()),
                    Period::Month => date.first_of_month(),
                    _ => date,
                };
                KstTime::from_kst_civil(first, TimeOfDay::MIDNIGHT)
            }
        };
        Bucket { period: self, start }
    }
}

/// 체결이 들어오는 시간의 시작. NXT가 08:00에 연다(kiwoom.md §1).
pub const SESSION_OPEN: TimeOfDay = match TimeOfDay::hms(8, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};

/// 체결이 들어오는 시간의 끝(배타). 이 시각 바로 뒤에 온 체결도 키움은 19:59 봉에 넣는다(D16).
pub const SESSION_CLOSE: TimeOfDay = match TimeOfDay::hms(20, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};

/// 장 끝의 유예. 20:00:00~20:00:03 체결이 온다(D16). 그 체결이 19:59 봉과 그날·그 주·그달 봉에
/// 들어갈 여지를 두려고, 장 끝에 닿는 봉은 SESSION_CLOSE + 이 값에 확정한다.
pub const CLOSE_GRACE_SECS: i64 = 10;

/// 장 중간의 분봉에서 늦게 도착하는 체결을 기다리는 유예(backend.md §3.3).
const MINUTE_GRACE_SECS: i64 = 2;

/// (봉 주기, 봉 시작 시각). 시작 시각이 봉 주기의 경계에 맞는다는 것이 불변식이다.
/// 필드가 비공개라 Period::bucket과 next/prev로만 만든다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Bucket {
    period: Period,
    start: KstTime,
}

impl Bucket {
    pub fn period(self) -> Period {
        self.period
    }

    pub fn start(self) -> KstTime {
        self.start
    }

    /// 구간이 끝나는 시각(배타).
    pub fn end(self) -> KstTime {
        match self.period.minutes() {
            Some(n) => self.start.plus_secs(n * 60),
            None => {
                let date = self.start.kst_date();
                let next = match self.period {
                    Period::Week => date.add_days(7),
                    Period::Month => date.first_of_next_month(),
                    _ => date.add_days(1),
                };
                KstTime::from_kst_civil(next, TimeOfDay::MIDNIGHT)
            }
        }
    }

    /// 이 봉이 확정되는 시각(backend.md §3.3, D16). 진행 중 구간인지는 이것 하나로 판단한다.
    pub fn confirm_at(self) -> KstTime {
        let close_of = |d: KstDate| KstTime::from_kst_civil(d, SESSION_CLOSE).plus_secs(CLOSE_GRACE_SECS);
        let date = self.start.kst_date();
        match self.period {
            Period::Day => close_of(date),
            Period::Week => close_of(date.add_days(4)),
            Period::Month => {
                let mut last = date.last_of_month();
                while matches!(last.weekday(), Weekday::Sat | Weekday::Sun) {
                    last = last.add_days(-1);
                }
                close_of(last)
            }
            _ => {
                let end = self.end();
                if end.kst_time_of_day() == SESSION_CLOSE {
                    close_of(end.kst_date())
                } else {
                    end.plus_secs(MINUTE_GRACE_SECS)
                }
            }
        }
    }

    pub fn is_confirmed_at(self, now: KstTime) -> bool {
        self.confirm_at() <= now
    }

    pub fn next(self) -> Bucket {
        Bucket { period: self.period, start: self.end() }
    }

    pub fn prev(self) -> Bucket {
        let start = match self.period.minutes() {
            Some(n) => self.start.plus_secs(-n * 60),
            None => {
                let date = self.start.kst_date();
                let prev = match self.period {
                    Period::Week => date.add_days(-7),
                    Period::Month => date.first_of_prev_month(),
                    _ => date.add_days(-1),
                };
                KstTime::from_kst_civil(prev, TimeOfDay::MIDNIGHT)
            }
        };
        Bucket { period: self.period, start }
    }

    pub fn contains(self, t: KstTime) -> bool {
        self.start <= t && t < self.end()
    }

    /// 공휴일 달력이 없어 공휴일도 봉이 생기는 날로 센다.
    pub fn future_starts(self, n: usize) -> Vec<KstTime> {
        let mut out = Vec::with_capacity(n);
        let mut bucket = self;
        for _ in 0..n {
            bucket = bucket.next_trading();
            out.push(bucket.start);
        }
        out
    }

    fn next_trading(self) -> Bucket {
        let next = self.next();
        let skips_weekend = self.period.is_intraday() || self.period == Period::Day;
        if !skips_weekend {
            return next;
        }
        let mut date = next.start.kst_date();
        let mut tod = next.start.kst_time_of_day();
        if self.period.is_intraday() {
            if tod >= SESSION_CLOSE {
                date = date.add_days(1);
                tod = SESSION_OPEN;
            } else if tod < SESSION_OPEN {
                tod = SESSION_OPEN;
            }
        }
        while matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            date = date.add_days(1);
            if self.period.is_intraday() {
                tod = SESSION_OPEN;
            }
        }
        self.period.bucket(KstTime::from_kst_civil(date, tod))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ymd: &str, h: u32, m: u32, s: u32) -> KstTime {
        KstTime::from_kst_civil(KstDate::parse_yyyymmdd(ymd).unwrap(), TimeOfDay::hms(h, m, s).unwrap())
    }

    fn midnight(ymd: &str) -> KstTime {
        at(ymd, 0, 0, 0)
    }

    #[test]
    fn wire_names_round_trip() {
        for p in Period::ALL {
            assert_eq!(Period::parse(p.as_wire()), Ok(p));
        }
        assert!(Period::parse("d").is_err());
        assert!(Period::parse("1d").is_err());
    }

    /// 키움 주·월봉 `dt`(구간의 첫 관측일) → 우리 봉 시작(kiwoom.md §10.4, §10.8).
    #[test]
    fn weekly_and_monthly_buckets_normalize_kiwoom_dates() {
        let cases = [
            (Period::Month, "20250304", "20250301"),
            (Period::Month, "20250602", "20250601"),
            (Period::Month, "20260202", "20260201"),
            (Period::Month, "20261102", "20261101"),
            (Period::Month, "20261231", "20261201"),
            (Period::Week, "20261102", "20261102"),
            (Period::Week, "20261006", "20261005"),
            (Period::Week, "20260526", "20260525"),
            (Period::Week, "20261108", "20261102"),
            (Period::Week, "20270101", "20261228"),
            (Period::Week, "20260601", "20260601"),
            (Period::Day, "20261106", "20261106"),
        ];
        for (p, kiwoom_dt, start) in cases {
            for tod in [(0, 0, 0), (9, 0, 0), (19, 59, 59), (23, 59, 59)] {
                let b = p.bucket(at(kiwoom_dt, tod.0, tod.1, tod.2));
                assert_eq!(b.start(), midnight(start), "{p:?} {kiwoom_dt} {tod:?}");
                assert!(b.contains(at(kiwoom_dt, tod.0, tod.1, tod.2)));
            }
        }
    }

    #[test]
    fn minute_buckets_cut_on_n_minute_boundaries() {
        let t = at("20261106", 9, 7, 30);
        assert_eq!(Period::M1.bucket(t).start(), at("20261106", 9, 7, 0));
        assert_eq!(Period::M5.bucket(t).start(), at("20261106", 9, 5, 0));
        assert_eq!(Period::M60.bucket(t).start(), at("20261106", 9, 0, 0));
        assert_eq!(Period::M15.bucket(at("20261106", 8, 0, 0)).start(), at("20261106", 8, 0, 0));
        assert_eq!(Period::M10.bucket(at("20261106", 9, 10, 0)).start(), at("20261106", 9, 10, 0));
        assert_eq!(Period::M10.bucket(at("20261106", 9, 19, 59)).start(), at("20261106", 9, 10, 0));
        assert_eq!(Period::M10.bucket(at("20261106", 9, 20, 0)).start(), at("20261106", 9, 20, 0));
        assert_eq!(Period::M1.bucket(at("20261106", 19, 59, 59)).start(), at("20261106", 19, 59, 0));
    }

    #[test]
    fn next_and_prev_walk_calendar_boundaries() {
        let dec = Period::Month.bucket(midnight("20261215"));
        assert_eq!(dec.next().start(), midnight("20270101"));
        assert_eq!(dec.next().prev(), dec);
        let wk = Period::Week.bucket(midnight("20261231"));
        assert_eq!(wk.start(), midnight("20261228"));
        assert_eq!(wk.next().start(), midnight("20270104"));
        assert_eq!(wk.end(), midnight("20270104"));
        let jan = Period::Month.bucket(midnight("20270120"));
        assert_eq!(jan.prev().start(), midnight("20261201"));
        let m5 = Period::M5.bucket(at("20261106", 23, 58, 0));
        assert_eq!(m5.next().start(), midnight("20261107"));
        assert_eq!(m5.next().prev(), m5);
    }

    #[test]
    fn future_starts_skip_nights_and_weekends_only_where_bars_cannot_start() {
        let cases = [
            (Period::M1, at("20261106", 19, 58, 0), vec![at("20261106", 19, 59, 0), at("20261109", 8, 0, 0), at("20261109", 8, 1, 0)]),
            (Period::M1, at("20261105", 19, 59, 0), vec![at("20261106", 8, 0, 0)]),
            (Period::M5, at("20261105", 7, 50, 0), vec![at("20261105", 8, 0, 0), at("20261105", 8, 5, 0)]),
            (Period::M30, at("20261105", 19, 30, 0), vec![at("20261106", 8, 0, 0)]),
            (Period::M60, at("20261106", 19, 0, 0), vec![at("20261109", 8, 0, 0), at("20261109", 9, 0, 0)]),
            (Period::Day, midnight("20261105"), vec![midnight("20261106"), midnight("20261109"), midnight("20261110")]),
            (Period::Week, midnight("20261221"), vec![midnight("20261228"), midnight("20270104")]),
            (Period::Week, midnight("20260525"), vec![midnight("20260601")]),
            (Period::Month, midnight("20261001"), vec![midnight("20261101"), midnight("20261201"), midnight("20270101")]),
            (Period::Month, midnight("20270401"), vec![midnight("20270501")]),
        ];
        for (p, last, want) in cases {
            let got = p.bucket(last).future_starts(want.len());
            assert_eq!(got, want, "{p:?} {last}");
        }
        assert!(Period::Day.bucket(midnight("20261105")).future_starts(0).is_empty());
    }

    #[test]
    fn confirm_at_leaves_a_grace_after_the_session_close() {
        let grace = CLOSE_GRACE_SECS;
        let day = Period::Day.bucket(at("20261106", 12, 0, 0));
        assert_eq!(day.confirm_at(), at("20261106", 20, 0, 0).plus_secs(grace));
        assert!(!day.is_confirmed_at(at("20261106", 20, 0, 3)));
        assert!(day.is_confirmed_at(at("20261106", 20, 0, 0).plus_secs(grace)));

        let week = Period::Week.bucket(midnight("20261102"));
        assert_eq!(week.confirm_at(), at("20261106", 20, 0, 0).plus_secs(grace));
        assert!(week.is_confirmed_at(midnight("20261109")));

        // 2026-11-30은 월요일, 2026-10-31은 토요일, 2027-01-31은 일요일.
        let nov = Period::Month.bucket(midnight("20261101"));
        assert_eq!(nov.confirm_at(), at("20261130", 20, 0, 0).plus_secs(grace));
        assert!(!nov.is_confirmed_at(midnight("20261109")));
        let oct = Period::Month.bucket(midnight("20261001"));
        assert_eq!(oct.confirm_at(), at("20261030", 20, 0, 0).plus_secs(grace));
        let jan = Period::Month.bucket(midnight("20270101"));
        assert_eq!(jan.confirm_at(), at("20270129", 20, 0, 0).plus_secs(grace));

        let mid = Period::M1.bucket(at("20261106", 9, 0, 0));
        assert_eq!(mid.confirm_at(), at("20261106", 9, 1, 2));
        let last = Period::M1.bucket(at("20261106", 19, 59, 0));
        assert_eq!(last.confirm_at(), at("20261106", 20, 0, 0).plus_secs(grace));
        let mid10 = Period::M10.bucket(at("20261106", 9, 10, 0));
        assert_eq!(mid10.confirm_at(), at("20261106", 9, 20, 2));
        assert_eq!(Period::M10.trade_bucket(at("20261106", 20, 0, 3)).start(), at("20261106", 19, 50, 0));
        let last10 = Period::M10.bucket(at("20261106", 19, 50, 0));
        assert_eq!(last10.confirm_at(), at("20261106", 20, 0, 0).plus_secs(grace));
        let last60 = Period::M60.bucket(at("20261106", 19, 0, 0));
        assert_eq!(last60.confirm_at(), at("20261106", 20, 0, 0).plus_secs(grace));
    }
}
