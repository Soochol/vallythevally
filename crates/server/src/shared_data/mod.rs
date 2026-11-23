mod board;
mod feed;
mod format;
mod minute;
mod snapshot;
mod write;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub use board::Board;
pub use feed::Feed;
pub use format::{Broker, DataKind, FORMAT_VERSION, Header, Loaded, Probe, ProbeBody, ProbeItem, SourceKey};
pub use minute::{MinuteBar, MinuteBarKey, MinuteInstrument, MinuteTrade, MinuteVenue, minute_path};
pub use snapshot::{IndexRow, SnapshotBody, SnapshotRow, snapshot_kind};
pub use write::{FeedWriter, write_snapshot};

use domain::{KstTime, Venue};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedDataSettings {
    pub dir: PathBuf,
    pub poll: Duration,
}

pub const DEFAULT_POLL: Duration = Duration::from_millis(1000);

pub struct SharedData {
    pub probe: Board<ProbeBody>,
    pub probe_feed: Feed<ProbeItem>,
    pub snapshot_krx: Board<SnapshotBody>,
    pub snapshot_combined: Board<SnapshotBody>,
    pub snapshot_nxt: Board<SnapshotBody>,
}

impl SharedData {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            probe: Board::new(DataKind::Probe),
            probe_feed: Feed::new(DataKind::Probe),
            snapshot_krx: Board::new(DataKind::SnapshotKrx),
            snapshot_combined: Board::new(DataKind::SnapshotCombined),
            snapshot_nxt: Board::new(DataKind::SnapshotNxt),
        })
    }

    pub fn snapshot(&self, venue: Venue) -> &Board<SnapshotBody> {
        match venue {
            Venue::Krx => &self.snapshot_krx,
            Venue::Combined => &self.snapshot_combined,
            Venue::Nxt => &self.snapshot_nxt,
        }
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
            for venue in Venue::ALL {
                data.snapshot(venue).poll(&dir);
            }
        })
        .await
        {
            tracing::error!(error = %e, "공용 자료 읽기 작업이 멈췄습니다");
        }
    }

    pub fn error_count(&self, kind: DataKind) -> u64 {
        match kind {
            DataKind::Probe => self.probe.errors() + self.probe_feed.errors(),
            DataKind::SnapshotKrx => self.snapshot_krx.errors(),
            DataKind::SnapshotCombined => self.snapshot_combined.errors(),
            DataKind::SnapshotNxt => self.snapshot_nxt.errors(),
            DataKind::Minute => 0,
        }
    }

    pub fn age_secs(&self, kind: DataKind, now: KstTime) -> Option<i64> {
        match kind {
            DataKind::Probe => self.probe.age_secs(now),
            DataKind::SnapshotKrx => self.snapshot_krx.age_secs(now),
            DataKind::SnapshotCombined => self.snapshot_combined.age_secs(now),
            DataKind::SnapshotNxt => self.snapshot_nxt.age_secs(now),
            DataKind::Minute => None,
        }
    }
}
