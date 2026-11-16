use std::path::PathBuf;
use std::time::Duration;

use tokio::signal::unix::{SignalKind, signal};

use super::day::SPAN_MS;
use super::{build_day, now_unix_ms};
use crate::kst::KstTime;

const ROUND_DELAY_AFTER_BOUNDARY_MS: i64 = 15_000;

pub fn run_follow(data_dir: PathBuf) -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(follow(data_dir));
    Ok(())
}

pub fn wait_until_next_round(now_unix_ms: i64) -> Duration {
    let span_ms = i64::from(SPAN_MS);
    let boundary_index = (now_unix_ms - ROUND_DELAY_AFTER_BOUNDARY_MS).div_euclid(span_ms) + 1;
    let target = boundary_index * span_ms + ROUND_DELAY_AFTER_BOUNDARY_MS;
    Duration::from_millis((target - now_unix_ms) as u64)
}

async fn follow(data_dir: PathBuf) {
    let mut stop = Box::pin(shutdown_signal());
    let mut previous_date: Option<u32> = None;
    loop {
        let now = now_unix_ms();
        let today = KstTime::from_unix_ms(now).date;
        let mut dates: Vec<u32> = previous_date.filter(|date| *date != today).into_iter().collect();
        dates.push(today);
        previous_date = Some(today);

        let round_dir = data_dir.clone();
        let mut round = tokio::task::spawn_blocking(move || {
            for date in dates {
                run_round(&round_dir, date);
            }
        });
        let stopped = tokio::select! {
            result = &mut round => {
                if let Err(error) = result {
                    eprintln!("build: 한 바퀴가 비정상 종료했다: {error}");
                }
                false
            }
            _ = &mut stop => {
                let _ = (&mut round).await;
                true
            }
        };
        if stopped {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(wait_until_next_round(now_unix_ms())) => {}
            _ = &mut stop => return,
        }
    }
}

fn run_round(data_dir: &std::path::Path, date: u32) {
    match build_day(data_dir, date, now_unix_ms()) {
        Ok(report) => {
            print!("{report}");
            if report.failed() {
                eprintln!("build: {date}에 오류가 있었다. 다음 바퀴를 계속한다");
            }
        }
        Err(error) => eprintln!("build: {date}를 만들 수 없다: {error}"),
    }
}

async fn shutdown_signal() {
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM 처리기를 등록할 수 있어야 한다");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUNDARY: i64 = 1_784_510_700_000;

    #[test]
    fn waits_for_fifteen_seconds_after_the_next_boundary() {
        assert_eq!(wait_until_next_round(BOUNDARY - 1_000), Duration::from_millis(16_000));
        assert_eq!(wait_until_next_round(BOUNDARY + 15_000 - 1), Duration::from_millis(1));
    }

    #[test]
    fn a_round_exactly_on_the_mark_waits_for_the_next_one() {
        assert_eq!(wait_until_next_round(BOUNDARY + 15_000), Duration::from_millis(300_000));
        assert_eq!(wait_until_next_round(BOUNDARY), Duration::from_millis(15_000));
    }
}
