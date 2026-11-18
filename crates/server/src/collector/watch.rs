use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedReadHalf;
use tokio::time::Instant;
use ts_rs::TS;

use super::wire::{COVERAGE_REQUEST, CollectorCoverage, CollectorDisk, CollectorStatus, DISK_REQUEST, Line, Reply, WATCH_REQUEST};
use crate::api::UnixSeconds;

pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(5);
pub const MISSED_HEARTBEATS: u32 = 3;
pub const RECONNECT_BACKOFF: [Duration; 5] = [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(10), Duration::from_secs(30)];
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const ASK_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DaemonJudgment {
    Checking,
    Down,
    Unresponsive,
    Healthy,
    VersionMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkEvent {
    ConnectFailed,
    Connected,
    Heartbeat,
    Silent,
    Lost,
    Incompatible,
}

impl DaemonJudgment {
    pub fn after(self, event: LinkEvent) -> DaemonJudgment {
        use DaemonJudgment::*;
        match (self, event) {
            (_, LinkEvent::Incompatible) => VersionMismatch,
            (_, LinkEvent::ConnectFailed) => Down,
            (_, LinkEvent::Connected | LinkEvent::Lost) => Checking,
            (VersionMismatch, LinkEvent::Heartbeat | LinkEvent::Silent) => VersionMismatch,
            (_, LinkEvent::Heartbeat) => Healthy,
            (_, LinkEvent::Silent) => Unresponsive,
        }
    }

    pub fn warrants_notice(self) -> bool {
        matches!(self, DaemonJudgment::Down | DaemonJudgment::Unresponsive)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReceivedStatus {
    pub status: CollectorStatus,
    pub sent_at: String,
    pub received_at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DaemonView {
    pub judgment: DaemonJudgment,
    pub last_status: Option<ReceivedStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonNotice {
    pub judgment: DaemonJudgment,
    pub at: UnixSeconds,
}

pub struct Watcher {
    view: Mutex<DaemonView>,
    notices: tokio::sync::broadcast::Sender<DaemonNotice>,
    judgments: tokio::sync::watch::Sender<DaemonJudgment>,
}

impl Watcher {
    pub fn new() -> Self {
        Watcher { view: Mutex::new(DaemonView { judgment: DaemonJudgment::Checking, last_status: None }), notices: tokio::sync::broadcast::channel(16).0, judgments: tokio::sync::watch::channel(DaemonJudgment::Checking).0 }
    }

    pub fn view(&self) -> DaemonView {
        self.view.lock().expect("감독 데몬 감시 잠금").clone()
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<DaemonNotice> {
        self.notices.subscribe()
    }

    pub fn subscribe_judgment(&self) -> tokio::sync::watch::Receiver<DaemonJudgment> {
        self.judgments.subscribe()
    }

    fn apply(&self, event: LinkEvent, now: UnixSeconds) {
        let mut view = self.view.lock().expect("감독 데몬 감시 잠금");
        let before = view.judgment;
        view.judgment = before.after(event);
        if view.judgment != before {
            self.judgments.send_replace(view.judgment);
            tracing::info!(from = ?before, to = ?view.judgment, "감독 데몬 판단이 바뀌었습니다");
            if view.judgment.warrants_notice() {
                let _ = self.notices.send(DaemonNotice { judgment: view.judgment, at: now });
            }
        }
    }

    fn record_status(&self, status: CollectorStatus, sent_at: String, received_at: UnixSeconds) {
        self.view.lock().expect("감독 데몬 감시 잠금").last_status = Some(ReceivedStatus { status, sent_at, received_at });
    }
}

struct Lines {
    reader: BufReader<OwnedReadHalf>,
    pending: Vec<u8>,
}

impl Lines {
    fn new(read: OwnedReadHalf) -> Self {
        Lines { reader: BufReader::new(read), pending: Vec::new() }
    }

    async fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            let room = (MAX_LINE_BYTES + 1 - self.pending.len()) as u64;
            let read = (&mut self.reader).take(room).read_until(b'\n', &mut self.pending).await?;
            if self.pending.last() == Some(&b'\n') {
                let mut line = std::mem::take(&mut self.pending);
                line.pop();
                return Ok(Some(line));
            }
            if read == 0 {
                return Ok(None);
            }
            if self.pending.len() > MAX_LINE_BYTES {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "줄이 너무 깁니다"));
            }
        }
    }
}

async fn connect(socket: &Path) -> Option<UnixStream> {
    tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(socket)).await.ok()?.ok()
}

fn silence_limit() -> Duration {
    HEARTBEAT_EVERY * MISSED_HEARTBEATS
}

pub async fn watch_forever(socket: &Path, watcher: &Watcher, clock: &crate::clock::Clock) {
    let mut sessions_without_heartbeat = 0usize;
    loop {
        if watch_once(socket, watcher, clock).await {
            sessions_without_heartbeat = 0;
        } else {
            sessions_without_heartbeat += 1;
        }
        let step = sessions_without_heartbeat.saturating_sub(1).min(RECONNECT_BACKOFF.len() - 1);
        tokio::time::sleep(RECONNECT_BACKOFF[step]).await;
    }
}

async fn watch_once(socket: &Path, watcher: &Watcher, clock: &crate::clock::Clock) -> bool {
    let now = || UnixSeconds(clock.now().unix());
    let Some(stream) = connect(socket).await else {
        watcher.apply(LinkEvent::ConnectFailed, now());
        return false;
    };
    watcher.apply(LinkEvent::Connected, now());
    let (read, mut write) = stream.into_split();
    if write.write_all(WATCH_REQUEST).await.is_err() {
        watcher.apply(LinkEvent::Lost, now());
        return false;
    }
    let mut lines = Lines::new(read);
    let mut silent_at = Some(Instant::now() + silence_limit());
    let mut heard = false;
    loop {
        let next = match silent_at {
            Some(at) => tokio::time::timeout_at(at, lines.next()).await.ok(),
            None => Some(lines.next().await),
        };
        let line = match next {
            None => {
                watcher.apply(LinkEvent::Silent, now());
                silent_at = None;
                continue;
            }
            Some(Ok(Some(line))) => line,
            Some(Ok(None) | Err(_)) => {
                watcher.apply(LinkEvent::Lost, now());
                return heard;
            }
        };
        match Line::parse(&line) {
            Line::Incompatible => {
                watcher.apply(LinkEvent::Incompatible, now());
                silent_at = None;
            }
            Line::Malformed => tracing::debug!("감독 데몬이 읽을 수 없는 줄을 보냈습니다. 버립니다"),
            Line::Reply(Reply::Status(reply)) => watcher.record_status(reply.status, reply.sent_at, now()),
            Line::Reply(Reply::Heartbeat(_)) => {
                heard = true;
                watcher.apply(LinkEvent::Heartbeat, now());
                silent_at = Some(Instant::now() + silence_limit());
            }
            Line::Reply(Reply::Error(error)) if error.code == "unsupported_version" => {
                watcher.apply(LinkEvent::Incompatible, now());
                silent_at = None;
            }
            Line::Reply(Reply::Error(error)) => {
                tracing::warn!(code = %error.code, "감독 데몬이 감시 요청을 거절했습니다");
                watcher.apply(LinkEvent::Lost, now());
                return heard;
            }
            Line::Reply(Reply::Coverage(_) | Reply::Disk(_)) => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Question {
    Coverage,
    Disk,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Coverage(CollectorCoverage),
    Disk(CollectorDisk),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskFailure {
    Down,
    Silent,
    VersionMismatch,
    Refused,
}

pub async fn ask(socket: &Path, question: Question) -> Result<Answer, AskFailure> {
    let stream = connect(socket).await.ok_or(AskFailure::Down)?;
    let (read, mut write) = stream.into_split();
    let request = match question {
        Question::Coverage => COVERAGE_REQUEST,
        Question::Disk => DISK_REQUEST,
    };
    let exchange = async {
        write.write_all(request).await.map_err(|_| AskFailure::Down)?;
        let mut lines = Lines::new(read);
        loop {
            let line = lines.next().await.ok().flatten().ok_or(AskFailure::Down)?;
            match (Line::parse(&line), question) {
                (Line::Incompatible, _) => return Err(AskFailure::VersionMismatch),
                (Line::Reply(Reply::Coverage(coverage)), Question::Coverage) => return Ok(Answer::Coverage(coverage)),
                (Line::Reply(Reply::Disk(disk)), Question::Disk) => return Ok(Answer::Disk(disk)),
                (Line::Reply(Reply::Error(error)), _) if error.code == "unsupported_version" => return Err(AskFailure::VersionMismatch),
                (Line::Reply(Reply::Error(_)), _) => return Err(AskFailure::Refused),
                _ => {}
            }
        }
    };
    tokio::time::timeout(ASK_TIMEOUT, exchange).await.map_err(|_| AskFailure::Silent)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use DaemonJudgment::*;
    use LinkEvent::*;

    fn run(events: &[LinkEvent]) -> Vec<DaemonJudgment> {
        events.iter().scan(Checking, |judgment, event| {
            *judgment = judgment.after(*event);
            Some(*judgment)
        }).collect()
    }

    #[test]
    fn the_judgment_follows_what_the_connector_saw() {
        assert_eq!(run(&[ConnectFailed, ConnectFailed]), [Down, Down]);
        assert_eq!(run(&[Connected, Silent, Heartbeat]), [Checking, Unresponsive, Healthy]);
        assert_eq!(run(&[Connected, Heartbeat, Lost, ConnectFailed, Connected, Heartbeat]), [Checking, Healthy, Checking, Down, Checking, Healthy]);
    }

    #[test]
    fn a_newer_format_version_stays_until_the_connection_is_made_again() {
        assert_eq!(run(&[Connected, Incompatible, Heartbeat, Silent, Lost, Connected, Heartbeat]), [Checking, VersionMismatch, VersionMismatch, VersionMismatch, Checking, Checking, Healthy]);
    }

    #[test]
    fn only_down_and_unresponsive_warrant_a_notice() {
        assert_eq!([Checking, Down, Unresponsive, Healthy, VersionMismatch].map(DaemonJudgment::warrants_notice), [false, true, true, false, false]);
    }
}
