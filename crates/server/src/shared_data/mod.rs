mod board;
mod feed;
mod format;
mod themes;
mod write;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub use board::Board;
pub use feed::Feed;
pub use format::{Broker, DataKind, FORMAT_VERSION, Header, Loaded, Probe, ProbeBody, ProbeItem, SNAPSHOT_EXTENSION, SourceKey, data_path};
pub use themes::{ThemeEntry, ThemesBody};
pub use write::{FeedWriter, write_snapshot};

use domain::KstTime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedDataSettings {
    pub dir: PathBuf,
    pub poll: Duration,
}

pub const DEFAULT_POLL: Duration = Duration::from_millis(1000);

pub struct SharedData {
    pub probe: Board<ProbeBody>,
    pub probe_feed: Feed<ProbeItem>,
    pub kiwoom_themes: Board<ThemesBody>,
}

impl SharedData {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { probe: Board::new(DataKind::Probe), probe_feed: Feed::new(DataKind::Probe), kiwoom_themes: Board::new(DataKind::KiwoomThemes) })
    }

    pub fn start(self: &Arc<Self>, settings: Option<&SharedDataSettings>) -> Option<tokio::task::JoinHandle<()>> {
        let settings = settings?.clone();
        let data = self.clone();
        Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(settings.poll);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                data.poll_once(&settings.dir).await;
            }
        }))
    }

    pub async fn poll_once(self: &Arc<Self>, dir: &std::path::Path) {
        let data = self.clone();
        let dir = dir.to_owned();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            data.probe.poll(&dir);
            data.probe_feed.poll(&dir);
            data.kiwoom_themes.poll(&dir);
        })
        .await
        {
            tracing::error!(error = %e, "공용 자료 읽기 작업이 멈췄습니다");
        }
    }

    pub fn error_count(&self, kind: DataKind) -> u64 {
        match kind {
            DataKind::Probe => self.probe.errors() + self.probe_feed.errors(),
            DataKind::KiwoomThemes => self.kiwoom_themes.errors(),
        }
    }

    pub fn age_secs(&self, kind: DataKind, now: KstTime) -> Option<i64> {
        match kind {
            DataKind::Probe => self.probe.age_secs(now),
            DataKind::KiwoomThemes => self.kiwoom_themes.age_secs(now),
        }
    }
}
