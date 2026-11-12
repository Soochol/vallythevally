//! KST 벽시계. 테스트는 가짜 시계를 쓴다. 가짜 시계는 tokio 시간(테스트에서는 멈춘 시간)을 따라 흐른다.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use domain::{KstDate, KstTime, TimeOfDay};

#[derive(Clone, Debug)]
pub struct Clock(Arc<Source>);

#[derive(Debug)]
enum Source {
    System,
    Fake { base: KstTime, start: tokio::time::Instant, jump: AtomicI64, changed: tokio::sync::Notify },
}

impl Clock {
    pub fn system() -> Self {
        Clock(Arc::new(Source::System))
    }

    /// tokio 런타임 안에서 만든다. tokio 시간이 흐른 만큼 함께 흐른다.
    pub fn fake(start: KstTime) -> Self {
        Clock(Arc::new(Source::Fake { base: start, start: tokio::time::Instant::now(), jump: AtomicI64::new(0), changed: tokio::sync::Notify::new() }))
    }

    pub fn now(&self) -> KstTime {
        match &*self.0 {
            Source::System => {
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs() as i64);
                KstTime::from_unix(secs)
            }
            Source::Fake { base, start, jump, .. } => {
                base.plus_secs(start.elapsed().as_secs() as i64 + jump.load(Ordering::SeqCst))
            }
        }
    }

    /// 가짜 시계만: tokio 시간을 건드리지 않고 벽시계만 앞으로 옮긴다.
    pub fn jump(&self, secs: i64) {
        match &*self.0 {
            Source::System => panic!("시스템 시계는 옮길 수 없습니다"),
            Source::Fake { jump, changed, .. } => {
                jump.fetch_add(secs, Ordering::SeqCst);
                changed.notify_waiters();
            }
        }
    }

    /// 돌아올 때 `now() >= t`이다. 초 단위로 버린 시각 때문에 일찍 깨면 다시 잔다.
    pub async fn sleep_until(&self, t: KstTime) {
        loop {
            match &*self.0 {
                Source::Fake { changed, .. } => {
                    let notified = changed.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    let secs = t.unix() - self.now().unix();
                    if secs <= 0 { return; }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(secs as u64)) => {}
                        _ = notified => {}
                    }
                }
                Source::System => {
                    let secs = t.unix() - self.now().unix();
                    if secs <= 0 { return; }
                    tokio::time::sleep(Duration::from_secs(secs as u64)).await;
                }
            }
        }
    }
}

/// `now` 뒤에 처음 오는 KST `at` 시각. `now`가 바로 그 시각이면 다음 날이다.
pub fn next_daily(now: KstTime, at: TimeOfDay) -> KstTime {
    let today = KstTime::from_kst_civil(now.kst_date(), at);
    if today > now { today } else { KstTime::from_kst_civil(now.kst_date().add_days(1), at) }
}

pub fn kst(date: KstDate, h: u32, m: u32, s: u32) -> KstTime {
    KstTime::from_kst_civil(date, TimeOfDay::hms(h, m, s).expect("올바른 시각"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(day: u8) -> KstDate {
        KstDate::new(2026, 11, day).unwrap()
    }

    #[test]
    fn next_daily_rolls_over() {
        let at = TimeOfDay::hms(7, 45, 0).unwrap();
        assert_eq!(next_daily(kst(d(9), 0, 34, 0), at), kst(d(9), 7, 45, 0));
        assert_eq!(next_daily(kst(d(9), 7, 45, 0), at), kst(d(10), 7, 45, 0));
        assert_eq!(next_daily(kst(d(9), 23, 0, 0), at), kst(d(10), 7, 45, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn fake_clock_follows_tokio_time() {
        let c = Clock::fake(kst(d(9), 0, 0, 0));
        tokio::time::sleep(Duration::from_secs(90)).await;
        assert_eq!(c.now(), kst(d(9), 0, 1, 30));
        c.jump(3600);
        assert_eq!(c.now(), kst(d(9), 1, 1, 30));
        c.sleep_until(kst(d(9), 1, 2, 0)).await;
        assert_eq!(c.now(), kst(d(9), 1, 2, 0));
    }
}
