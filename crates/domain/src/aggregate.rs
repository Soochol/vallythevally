use crate::bar::{BarSource, ConfirmedBar, Ohlcv};
use crate::period::{Bucket, CLOSE_GRACE_SECS, Period, SESSION_CLOSE};
use crate::time::KstTime;
use crate::trade::Trade;

/// 현재 봉에 어디까지의 체결이 들어 있는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedBoundary {
    /// 체결 하나로 시작했다. 빠진 체결이 없다.
    FromTrade,
    /// 키움 조회값으로 시작했고 경계를 모른다. 체결이 빠졌거나 겹쳤을 수 있다.
    Unknown,
}

/// 현재 봉. 봉 출처 필드가 없다. 캐시 저장 함수는 ConfirmedBar만 받으므로 현재 봉은 캐시에 들어갈 수 없다(ADR 0003).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurrentBar {
    bucket: Bucket,
    ohlcv: Ohlcv,
    boundary: SeedBoundary,
}

impl CurrentBar {
    /// 키움 조회에서 받은 진행 중 구간의 봉으로 시작한다. 경계를 모르므로 불완전하다.
    pub fn seed(bucket: Bucket, ohlcv: Ohlcv) -> Self {
        CurrentBar { bucket, ohlcv, boundary: SeedBoundary::Unknown }
    }

    fn from_trade(bucket: Bucket, trade: &Trade) -> Self {
        CurrentBar { bucket, ohlcv: Ohlcv::from_trade(trade), boundary: SeedBoundary::FromTrade }
    }

    pub fn bucket(&self) -> Bucket {
        self.bucket
    }

    pub fn ohlcv(&self) -> &Ohlcv {
        &self.ohlcv
    }

    pub fn is_complete(&self) -> bool {
        self.boundary == SeedBoundary::FromTrade
    }

    fn confirm(&self) -> ConfirmedBar {
        ConfirmedBar { bucket: self.bucket, ohlcv: self.ohlcv, source: BarSource::Realtime, needs_verify: !self.is_complete() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgnoreReason {
    /// 확정이 끝난 구간이거나 현재 봉보다 앞 구간의 체결.
    Late,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// 현재 봉에 더했거나, 현재 봉이 없어 이 체결로 시작했다.
    Updated,
    /// 새 구간의 체결이라 앞 봉을 확정하고 새 현재 봉을 시작했다.
    Rolled { confirmed: ConfirmedBar },
    Ignored(IgnoreReason),
}

/// (종목, 거래소, 봉 주기) 하나의 현재 봉 집계기. 열린 봉은 언제나 많아야 하나다(backend.md §3.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aggregator {
    period: Period,
    current: Option<CurrentBar>,
    closed_through: Option<Bucket>,
}

impl Aggregator {
    /// newest_confirmed: 키움 조회로 아는 가장 새 확정 봉 구간. 그 구간까지의 체결은 늦은 체결이다.
    pub fn new(period: Period, seed: Option<CurrentBar>, newest_confirmed: Option<Bucket>) -> Self {
        Aggregator { period, current: seed, closed_through: newest_confirmed }
    }

    pub fn period(&self) -> Period {
        self.period
    }

    pub fn current(&self) -> Option<&CurrentBar> {
        self.current.as_ref()
    }

    pub fn apply(&mut self, trade: &Trade) -> Applied {
        let bucket = self.period.bucket(self.effective_at(trade.at));
        if self.closed_through.is_some_and(|closed| bucket <= closed) {
            return Applied::Ignored(IgnoreReason::Late);
        }
        match &mut self.current {
            None => {
                self.current = Some(CurrentBar::from_trade(bucket, trade));
                Applied::Updated
            }
            Some(cur) if cur.bucket == bucket => {
                cur.ohlcv.absorb(trade);
                Applied::Updated
            }
            Some(cur) if cur.bucket < bucket => {
                let confirmed = cur.confirm();
                self.closed_through = Some(cur.bucket);
                *cur = CurrentBar::from_trade(bucket, trade);
                Applied::Rolled { confirmed }
            }
            Some(_) => Applied::Ignored(IgnoreReason::Late),
        }
    }

    /// now ≥ 현재 봉의 confirm_at이면 확정하고 비운다.
    pub fn close_if_due(&mut self, now: KstTime) -> Option<ConfirmedBar> {
        let cur = self.current.filter(|c| c.bucket.is_confirmed_at(now))?;
        self.current = None;
        self.closed_through = Some(cur.bucket);
        Some(cur.confirm())
    }

    /// [20:00:00, 20:00:10)의 체결도 키움은 19:59 봉에 넣는다(D16). 분봉에서만 그날 마지막 분 구간으로 당긴다.
    fn effective_at(&self, at: KstTime) -> KstTime {
        let close = KstTime::from_kst_civil(at.kst_date(), SESSION_CLOSE);
        if self.period.is_intraday() && close <= at && at < close.plus_secs(CLOSE_GRACE_SECS) { close.plus_secs(-1) } else { at }
    }
}

/// 체결 목록을 차례로 반영한 뒤 close_if_due(now)를 한 번 부른다. 확정된 봉을 순서대로 돌려준다.
pub fn aggregate(mut agg: Aggregator, trades: &[Trade], now: KstTime) -> (Vec<ConfirmedBar>, Aggregator) {
    let mut confirmed: Vec<ConfirmedBar> = trades
        .iter()
        .filter_map(|t| match agg.apply(t) {
            Applied::Rolled { confirmed } => Some(confirmed),
            Applied::Updated | Applied::Ignored(_) => None,
        })
        .collect();
    confirmed.extend(agg.close_if_due(now));
    (confirmed, agg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::price::{Price, Volume};
    use crate::time::{KstDate, TimeOfDay};

    /// 2026-11-02(월) ~ 2026-11-06(금).
    fn at_on(day: u8, h: u32, m: u32, s: u32) -> KstTime {
        KstTime::from_kst_civil(KstDate::new(2026, 11, day).unwrap(), TimeOfDay::hms(h, m, s).unwrap())
    }

    fn at(h: u32, m: u32, s: u32) -> KstTime {
        at_on(6, h, m, s)
    }

    fn p(v: u64) -> Price {
        Price::from_centi(v).unwrap()
    }

    fn tr(at: KstTime, price: u64, qty: u64) -> Trade {
        Trade { at, price: p(price), qty: Volume(qty) }
    }

    fn ohlcv(o: u64, h: u64, l: u64, c: u64, v: u64) -> Ohlcv {
        Ohlcv::try_new(p(o), p(h), p(l), p(c), Volume(v)).unwrap()
    }

    fn realtime(bucket: Bucket, ohlcv: Ohlcv, needs_verify: bool) -> ConfirmedBar {
        ConfirmedBar { bucket, ohlcv, source: BarSource::Realtime, needs_verify }
    }

    struct Case {
        name: &'static str,
        agg: Aggregator,
        trades: Vec<Trade>,
        now: KstTime,
        confirmed: Vec<ConfirmedBar>,
        /// (구간, OHLCV, is_complete)
        current: Option<(Bucket, Ohlcv, bool)>,
    }

    fn fresh(period: Period) -> Aggregator {
        Aggregator::new(period, None, None)
    }

    #[test]
    fn aggregate_table() {
        use Period::*;
        let m1 = |h, m| M1.bucket(at(h, m, 0));
        let m5 = |h, m| M5.bucket(at(h, m, 0));
        let cases = vec![
            Case {
                name: "한 분 안의 체결은 현재 봉 하나",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 1), 100, 1), tr(at(9, 0, 20), 120, 2), tr(at(9, 0, 30), 90, 3), tr(at(9, 0, 59), 110, 4)],
                now: at(9, 0, 59),
                confirmed: vec![],
                current: Some((m1(9, 0), ohlcv(100, 120, 90, 110, 10), true)),
            },
            Case {
                name: "다음 분의 체결이 앞 봉을 확정한다",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 1), 100, 1), tr(at(9, 0, 50), 105, 1), tr(at(9, 1, 0), 103, 2)],
                now: at(9, 1, 0),
                confirmed: vec![realtime(m1(9, 0), ohlcv(100, 105, 100, 105, 2), false)],
                current: Some((m1(9, 1), ohlcv(103, 103, 103, 103, 2), true)),
            },
            Case {
                name: "체결 없는 분은 봉을 만들지 않는다",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 1), 100, 1), tr(at(9, 2, 5), 101, 1)],
                now: at(9, 2, 5),
                confirmed: vec![realtime(m1(9, 0), ohlcv(100, 100, 100, 100, 1), false)],
                current: Some((m1(9, 2), ohlcv(101, 101, 101, 101, 1), true)),
            },
            Case {
                name: "장 중간 분봉은 끝 + 1초에는 아직 열려 있다",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 1), 100, 1)],
                now: at(9, 1, 1),
                confirmed: vec![],
                current: Some((m1(9, 0), ohlcv(100, 100, 100, 100, 1), true)),
            },
            Case {
                name: "장 중간 분봉은 끝 + 2초에 타이머로 확정",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 1), 100, 1)],
                now: at(9, 1, 2),
                confirmed: vec![realtime(m1(9, 0), ohlcv(100, 100, 100, 100, 1), false)],
                current: None,
            },
            Case {
                name: "20:00:03 체결은 1분봉 19:59 봉에 들어가고 20:00:09에는 아직 열려 있다",
                agg: fresh(M1),
                trades: vec![tr(at(19, 59, 30), 100, 1), tr(at(20, 0, 3), 98, 5)],
                now: at(20, 0, 9),
                confirmed: vec![],
                current: Some((m1(19, 59), ohlcv(100, 100, 98, 98, 6), true)),
            },
            Case {
                name: "1분봉 19:59 봉은 20:00:10에 확정",
                agg: fresh(M1),
                trades: vec![tr(at(19, 59, 30), 100, 1), tr(at(20, 0, 3), 98, 5)],
                now: at(20, 0, 10),
                confirmed: vec![realtime(m1(19, 59), ohlcv(100, 100, 98, 98, 6), false)],
                current: None,
            },
            Case {
                name: "20:00:03 체결은 5분봉 19:55 봉에 들어간다",
                agg: fresh(M5),
                trades: vec![tr(at(19, 56, 0), 100, 1), tr(at(20, 0, 3), 102, 5)],
                now: at(20, 0, 10),
                confirmed: vec![realtime(m5(19, 55), ohlcv(100, 102, 100, 102, 6), false)],
                current: None,
            },
            Case {
                name: "장 끝 유예의 체결 하나로도 19:59 봉을 시작한다",
                agg: fresh(M1),
                trades: vec![tr(at(20, 0, 0), 97, 3)],
                now: at(20, 0, 5),
                confirmed: vec![],
                current: Some((m1(19, 59), ohlcv(97, 97, 97, 97, 3), true)),
            },
            Case {
                name: "앞 구간의 체결은 롤 뒤에 와도 버린다",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 1), 100, 1), tr(at(9, 1, 0), 101, 1), tr(at(9, 0, 59), 200, 9)],
                now: at(9, 1, 0),
                confirmed: vec![realtime(m1(9, 0), ohlcv(100, 100, 100, 100, 1), false)],
                current: Some((m1(9, 1), ohlcv(101, 101, 101, 101, 1), true)),
            },
            Case {
                name: "가장 새 확정 봉까지의 체결은 버린다",
                agg: Aggregator::new(M1, None, Some(m1(9, 0))),
                trades: vec![tr(at(8, 59, 59), 50, 1), tr(at(9, 0, 30), 60, 1), tr(at(9, 1, 0), 101, 1)],
                now: at(9, 1, 0),
                confirmed: vec![],
                current: Some((m1(9, 1), ohlcv(101, 101, 101, 101, 1), true)),
            },
            Case {
                name: "시드 봉은 체결을 더하고 needs_verify로 확정, 다음 봉은 완전",
                agg: Aggregator::new(M1, Some(CurrentBar::seed(m1(9, 0), ohlcv(100, 110, 95, 105, 50))), Some(m1(8, 59))),
                trades: vec![tr(at(9, 0, 40), 112, 2), tr(at(9, 0, 50), 108, 3), tr(at(9, 1, 1), 109, 1)],
                now: at(9, 1, 1),
                confirmed: vec![realtime(m1(9, 0), ohlcv(100, 112, 95, 108, 55), true)],
                current: Some((m1(9, 1), ohlcv(109, 109, 109, 109, 1), true)),
            },
            Case {
                name: "시드 봉은 체결 없이 타이머로 닫혀도 needs_verify",
                agg: Aggregator::new(M1, Some(CurrentBar::seed(m1(9, 0), ohlcv(100, 110, 95, 105, 50))), None),
                trades: vec![],
                now: at(9, 1, 2),
                confirmed: vec![realtime(m1(9, 0), ohlcv(100, 110, 95, 105, 50), true)],
                current: None,
            },
            Case {
                name: "시드 봉은 확정 전 현재 봉으로 불완전",
                agg: Aggregator::new(M1, Some(CurrentBar::seed(m1(9, 0), ohlcv(100, 110, 95, 105, 50))), None),
                trades: vec![tr(at(9, 0, 40), 90, 2)],
                now: at(9, 0, 41),
                confirmed: vec![],
                current: Some((m1(9, 0), ohlcv(100, 110, 90, 90, 52), false)),
            },
            Case {
                name: "동시호가 체결 한 건은 그 분의 봉",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 0), 19_350_000, 1_234_567)],
                now: at(9, 1, 2),
                confirmed: vec![realtime(m1(9, 0), ohlcv(19_350_000, 19_350_000, 19_350_000, 19_350_000, 1_234_567), false)],
                current: None,
            },
            Case {
                name: "거래량 0 체결도 가격에 반영",
                agg: fresh(M1),
                trades: vec![tr(at(9, 0, 1), 100, 3), tr(at(9, 0, 2), 130, 0)],
                now: at(9, 0, 3),
                confirmed: vec![],
                current: Some((m1(9, 0), ohlcv(100, 130, 100, 130, 3), true)),
            },
            Case {
                name: "일봉은 09:00과 19:59, 장 끝 유예를 한 봉에 담고 20:00:09에는 열려 있다",
                agg: fresh(Day),
                trades: vec![tr(at(9, 0, 0), 100, 1), tr(at(19, 59, 59), 120, 2), tr(at(20, 0, 3), 115, 3)],
                now: at(20, 0, 9),
                confirmed: vec![],
                current: Some((Day.bucket(at(9, 0, 0)), ohlcv(100, 120, 100, 115, 6), true)),
            },
            Case {
                name: "일봉은 20:00:10에 확정",
                agg: fresh(Day),
                trades: vec![tr(at(9, 0, 0), 100, 1), tr(at(19, 59, 59), 120, 2)],
                now: at(20, 0, 10),
                confirmed: vec![realtime(Day.bucket(at(9, 0, 0)), ohlcv(100, 120, 100, 120, 3), false)],
                current: None,
            },
            Case {
                name: "다음 날 체결이 일봉을 넘긴다",
                agg: fresh(Day),
                trades: vec![tr(at_on(5, 10, 0, 0), 100, 1), tr(at_on(6, 8, 0, 0), 99, 1)],
                now: at_on(6, 8, 0, 0),
                confirmed: vec![realtime(Day.bucket(at_on(5, 10, 0, 0)), ohlcv(100, 100, 100, 100, 1), false)],
                current: Some((Day.bucket(at_on(6, 8, 0, 0)), ohlcv(99, 99, 99, 99, 1), true)),
            },
            Case {
                name: "주봉은 여러 날의 체결을 한 봉에 담고 금요일 20:00:10 전에는 열려 있다",
                agg: fresh(Week),
                trades: vec![tr(at_on(2, 9, 0, 0), 100, 1), tr(at_on(4, 13, 0, 0), 150, 2), tr(at_on(6, 19, 59, 0), 80, 3)],
                now: at_on(6, 20, 0, 9),
                confirmed: vec![],
                current: Some((Week.bucket(at_on(2, 9, 0, 0)), ohlcv(100, 150, 80, 80, 6), true)),
            },
            Case {
                name: "주봉은 금요일 20:00:10에 확정",
                agg: fresh(Week),
                trades: vec![tr(at_on(2, 9, 0, 0), 100, 1), tr(at_on(4, 13, 0, 0), 150, 2), tr(at_on(6, 19, 59, 0), 80, 3)],
                now: at_on(6, 20, 0, 10),
                confirmed: vec![realtime(Week.bucket(at_on(2, 9, 0, 0)), ohlcv(100, 150, 80, 80, 6), false)],
                current: None,
            },
        ];
        for c in cases {
            let (confirmed, agg) = aggregate(c.agg, &c.trades, c.now);
            assert_eq!(confirmed, c.confirmed, "{}: 확정 봉", c.name);
            let current = agg.current().map(|b| (b.bucket(), *b.ohlcv(), b.is_complete()));
            assert_eq!(current, c.current, "{}: 현재 봉", c.name);
        }
    }

    #[test]
    fn late_trade_after_timer_close_changes_nothing() {
        let mut agg = fresh(Period::M1);
        assert_eq!(agg.apply(&tr(at(9, 0, 1), 100, 1)), Applied::Updated);
        let closed = agg.close_if_due(at(9, 1, 2));
        assert_eq!(closed, Some(realtime(Period::M1.bucket(at(9, 0, 0)), ohlcv(100, 100, 100, 100, 1), false)));
        assert_eq!(agg.apply(&tr(at(9, 0, 59), 200, 9)), Applied::Ignored(IgnoreReason::Late));
        assert_eq!(agg.current(), None);
        assert_eq!(agg.close_if_due(at(9, 5, 0)), None);
        assert_eq!(agg.apply(&tr(at(9, 1, 3), 101, 1)), Applied::Updated);
        assert_eq!(agg.current().map(|b| b.bucket()), Some(Period::M1.bucket(at(9, 1, 0))));
    }

    #[test]
    fn roll_reports_the_confirmed_bar() {
        let mut agg = fresh(Period::M1);
        agg.apply(&tr(at(9, 0, 1), 100, 1));
        let confirmed = realtime(Period::M1.bucket(at(9, 0, 0)), ohlcv(100, 100, 100, 100, 1), false);
        assert_eq!(agg.apply(&tr(at(9, 1, 0), 101, 1)), Applied::Rolled { confirmed });
    }
}
