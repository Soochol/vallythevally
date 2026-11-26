use domain::TimeOfDay;
use serde_json::Value;
use server::kiwoom::rest::Priority;
use server::kiwoom_themes::fetch_theme_list;
use server::shared_data::{Broker, DataKind, Header, IntradayThemesBody, SourceKey, write_snapshot};

use super::super::job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob};

const OPENS_AT: TimeOfDay = match TimeOfDay::hms(9, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const CLOSES_AT: TimeOfDay = match TimeOfDay::hms(15, 35, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const DEFAULT_PERIOD_SECS: u64 = 180;

#[derive(Default)]
pub(in crate::shared) struct IntradayThemesJob;

impl SharedJob for IntradayThemesJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: OPENS_AT, end: CLOSES_AT }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom]
    }

    fn default_period_secs(&self) -> u64 {
        DEFAULT_PERIOD_SECS
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        match options.is_null() {
            true => Ok(()),
            false => Err("intraday_themes는 선택값을 받지 않습니다".to_owned()),
        }
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let Market::Kiwoom(rest) = call.market else {
                return Err(JobError("intraday_themes는 키움 키만 받습니다".to_owned()));
            };
            if !call.slice.owns(0) {
                return Ok(());
            }
            let now = call.clock.now();
            let list = fetch_theme_list(rest, 1, Priority::Background, now)
                .await
                .map_err(|reason| JobError(format!("장중 키움 테마 목록을 받지 못했습니다: {reason:?}")))?;
            let written_at = call.clock.now().unix();
            let header = Header::new(
                DataKind::IntradayThemes,
                call.observation_date,
                list.fetched_at.0,
                written_at,
                vec![SourceKey { key_name: call.key.as_str().to_owned(), broker: Broker::Kiwoom }],
            );
            let body = IntradayThemesBody {
                themes: list.themes,
                pages: list.pages,
                complete: list.complete,
                skipped: list.skipped,
            };
            write_snapshot(call.shared_dir, header, body)
                .map_err(|error| JobError(format!("공용 자료를 쓰지 못했습니다: {error}")))?;
            Ok(())
        })
    }
}
