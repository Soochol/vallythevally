use crate::period::{CLOSE_GRACE_SECS, SESSION_CLOSE};
use crate::price::{Price, Volume};
use crate::time::{KstTime, TimeOfDay};

/// 거래가 한 번 성립한 것. 시각은 날짜까지 정해진 KST 순간이다(resolve_trade_time).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Trade {
    pub at: KstTime,
    pub price: Price,
    pub qty: Volume,
}

/// 체결이 들어오는 시간의 시작(포함).
pub const TRADING_OPEN: TimeOfDay = match TimeOfDay::hms(8, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};

/// 서버 시계가 늦어 체결시간이 수신 시각보다 앞서도 받아 주는 한도.
const MAX_FUTURE_SECS: i64 = 60;

/// 밀린 메시지이거나 서버 시계가 빨라도 받아 주는 한도.
const MAX_AGE_SECS: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TradeTimeError {
    /// [08:00:00, 20:00:10) 밖.
    OutsideTradingWindow,
    /// 체결시간이 수신 시각보다 60초 넘게 미래. 서버 시계가 늦다.
    FromFuture,
    /// 체결시간이 수신 시각보다 5분 넘게 과거. 밀린 메시지이거나 시계가 빠르다.
    TooOld,
}

/// 0B 체결시간(HHMMSS)에 수신 시각의 KST 날짜를 붙인다(backend.md §3.1). 자정을 넘는 체결은 없다.
pub fn resolve_trade_time(received_at: KstTime, hhmmss: TimeOfDay) -> Result<KstTime, TradeTimeError> {
    let window_end = i64::from(SESSION_CLOSE.secs()) + CLOSE_GRACE_SECS;
    if hhmmss < TRADING_OPEN || i64::from(hhmmss.secs()) >= window_end {
        return Err(TradeTimeError::OutsideTradingWindow);
    }
    let t = KstTime::from_kst_civil(received_at.kst_date(), hhmmss);
    if t > received_at.plus_secs(MAX_FUTURE_SECS) {
        Err(TradeTimeError::FromFuture)
    } else if t < received_at.plus_secs(-MAX_AGE_SECS) {
        Err(TradeTimeError::TooOld)
    } else {
        Ok(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::KstDate;

    fn tod(h: u32, m: u32, s: u32) -> TimeOfDay {
        TimeOfDay::hms(h, m, s).unwrap()
    }

    fn at(h: u32, m: u32, s: u32) -> KstTime {
        KstTime::from_kst_civil(KstDate::new(2026, 11, 6).unwrap(), tod(h, m, s))
    }

    #[test]
    fn resolve_trade_time_table() {
        use TradeTimeError::*;
        let cases: [(&str, KstTime, TimeOfDay, Result<KstTime, TradeTimeError>); 13] = [
            ("개장 첫 초", at(8, 0, 1), tod(8, 0, 0), Ok(at(8, 0, 0))),
            ("개장 직전", at(8, 0, 1), tod(7, 59, 59), Err(OutsideTradingWindow)),
            ("마지막 분", at(20, 0, 0), tod(19, 59, 59), Ok(at(19, 59, 59))),
            ("장 끝 유예 안", at(20, 0, 4), tod(20, 0, 3), Ok(at(20, 0, 3))),
            ("장 끝 유예 마지막 초", at(20, 0, 9), tod(20, 0, 9), Ok(at(20, 0, 9))),
            ("장 끝 유예 밖", at(20, 0, 10), tod(20, 0, 10), Err(OutsideTradingWindow)),
            ("미래 정확히 60초", at(9, 0, 0), tod(9, 1, 0), Ok(at(9, 1, 0))),
            ("미래 61초", at(9, 0, 0), tod(9, 1, 1), Err(FromFuture)),
            ("과거 정확히 300초", at(9, 5, 0), tod(9, 0, 0), Ok(at(9, 0, 0))),
            ("과거 301초", at(9, 5, 1), tod(9, 0, 0), Err(TooOld)),
            ("자정 직후 수신한 전날 체결", at(0, 0, 5), tod(19, 59, 59), Err(FromFuture)),
            ("창 검사가 먼저", at(23, 0, 0), tod(23, 0, 0), Err(OutsideTradingWindow)),
            ("같은 초", at(15, 30, 0), tod(15, 30, 0), Ok(at(15, 30, 0))),
        ];
        for (name, received_at, hhmmss, want) in cases {
            assert_eq!(resolve_trade_time(received_at, hhmmss), want, "{name}");
        }
    }
}
