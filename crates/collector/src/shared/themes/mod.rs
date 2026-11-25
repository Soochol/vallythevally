mod intraday;

pub(super) use intraday::IntradayThemesJob;

use std::path::Path;
use std::sync::Mutex;

use domain::{KstTime, TimeOfDay};
use serde_json::Value;
use server::kiwoom_themes::{CATALOG_AT, StoredCatalog, StoredTheme, collect};
use server::shared_data::{Board, Broker, DataKind, Header, SNAPSHOT_EXTENSION, SourceKey, ThemeEntry, ThemesBody, data_path, write_snapshot};

use super::job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob};

const RETRY_SECS: i64 = 300;
const END_OF_WINDOW: TimeOfDay = match TimeOfDay::hms(23, 59, 59) {
    Some(time) => time,
    None => unreachable!(),
};

#[derive(Default)]
pub(super) struct KiwoomThemesJob {
    retry_at: Mutex<Option<KstTime>>,
}

impl KiwoomThemesJob {
    fn waiting_for_retry(&self, now: KstTime) -> bool {
        self.retry_at.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some_and(|retry_at| now < retry_at)
    }

    fn retry_after(&self, retry_at: Option<KstTime>) {
        *self.retry_at.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = retry_at;
    }
}

fn newest_catalog(shared_dir: &Path) -> Option<StoredCatalog> {
    let board = Board::<ThemesBody>::new(DataKind::KiwoomThemes);
    board.poll(shared_dir);
    let loaded = board.current()?;
    let themes = loaded.body.themes.iter().map(|theme| StoredTheme { code: theme.code.clone(), name: theme.name.clone(), members: theme.members.clone() }).collect();
    Some(StoredCatalog { date: loaded.header.observation_date.clone(), collected_at: loaded.header.as_of, themes })
}

fn body_of(catalog: &StoredCatalog) -> ThemesBody {
    ThemesBody { themes: catalog.themes.iter().map(|theme| ThemeEntry { code: theme.code.clone(), name: theme.name.clone(), members: theme.members.clone() }).collect() }
}

impl SharedJob for KiwoomThemesJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: CATALOG_AT, end: END_OF_WINDOW }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom]
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        match options.is_null() {
            true => Ok(()),
            false => Err("kiwoom_themes는 선택값을 받지 않습니다".to_owned()),
        }
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let Market::Kiwoom(rest) = call.market else { return Err(JobError("kiwoom_themes는 키움 키만 받습니다".to_owned())) };
            if !call.slice.owns(0) {
                return Ok(());
            }
            let today = call.observation_date.yyyymmdd();
            if data_path(call.shared_dir, DataKind::KiwoomThemes, &today, SNAPSHOT_EXTENSION).exists() {
                return Ok(());
            }
            let now = call.clock.now();
            if self.waiting_for_retry(now) {
                return Ok(());
            }
            let previous = newest_catalog(call.shared_dir);
            let catalog = match collect(rest, now, previous.as_ref()).await {
                Ok(catalog) => catalog,
                Err(reason) => {
                    self.retry_after(Some(KstTime::from_unix(now.unix() + RETRY_SECS)));
                    return Err(JobError(format!("키움 테마 목록을 받지 못했습니다: {reason:?}")));
                }
            };
            self.retry_after(None);
            let header = Header::new(DataKind::KiwoomThemes, call.observation_date, catalog.collected_at, now.unix(), vec![SourceKey { key_name: call.key.as_str().to_owned(), broker: Broker::Kiwoom }]);
            write_snapshot(call.shared_dir, header, body_of(&catalog)).map_err(|error| JobError(format!("공용 자료를 쓰지 못했습니다: {error}")))?;
            Ok(())
        })
    }
}
