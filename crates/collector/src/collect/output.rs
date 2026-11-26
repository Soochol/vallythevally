use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at};
use tokio_tungstenite::tungstenite::Utf8Bytes;

use crate::protocol::KeyName;
use crate::raw_write::{RawLine, RawRecord, RawWriter};

pub const FLUSH_EVERY: Duration = Duration::from_secs(1);
pub const REPORT_EVERY: Duration = Duration::from_secs(60);
const QUEUE_CAPACITY: usize = 16_384;

#[derive(Debug, Default)]
pub struct Throughput {
    frames: AtomicU64,
    bytes: AtomicU64,
}

impl Throughput {
    fn add(&self, bytes: usize) {
        self.frames.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub fn take(&self) -> (u64, u64) {
        (self.frames.swap(0, Ordering::Relaxed), self.bytes.swap(0, Ordering::Relaxed))
    }
}

enum WriteCommand {
    Write(RawRecord),
    Flush,
    Close(SyncSender<io::Result<()>>),
}

struct SavedError {
    kind: io::ErrorKind,
    message: String,
}

#[derive(Default)]
struct ErrorState {
    error: Mutex<Option<SavedError>>,
}

impl ErrorState {
    fn record(&self, error: io::Error) {
        let mut slot = self.error.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(SavedError { kind: error.kind(), message: error.to_string() });
        }
    }

    fn check(&self) -> io::Result<()> {
        let slot = self.error.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match slot.as_ref() {
            Some(saved) => Err(io::Error::new(saved.kind, saved.message.clone())),
            None => Ok(()),
        }
    }
}

fn run_writer(mut writer: RawWriter, commands: Receiver<WriteCommand>, errors: Arc<ErrorState>) {
    while let Ok(command) = commands.recv() {
        match command {
            WriteCommand::Write(record) => {
                if let Err(error) = writer.write_record(&record) {
                    errors.record(error);
                    return;
                }
            }
            WriteCommand::Flush => {
                if let Err(error) = writer.flush() {
                    errors.record(error);
                    return;
                }
            }
            WriteCommand::Close(ack) => {
                let result = writer.close();
                let _ = ack.send(result);
                return;
            }
        }
    }
}

pub struct Output {
    sender: Option<SyncSender<WriteCommand>>,
    worker: Option<JoinHandle<()>>,
    errors: Arc<ErrorState>,
    dirty: bool,
    throughput: Arc<Throughput>,
    since_report: Counts,
    total: Counts,
    pub flush_tick: Interval,
    pub report_tick: Interval,
}

#[derive(Debug, Clone, Copy, Default)]
struct Counts {
    frames: u64,
    bytes: u64,
}

fn ticker(period: Duration) -> Interval {
    let mut ticker = interval_at(Instant::now() + period, period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker
}

impl Output {
    pub fn new(data_dir: impl Into<PathBuf>) -> Output {
        Output::with_writer(RawWriter::new(data_dir))
    }

    pub fn for_key(data_dir: impl Into<PathBuf>, key: KeyName) -> Output {
        Output::with_writer(RawWriter::for_key(data_dir, key))
    }

    fn with_writer(writer: RawWriter) -> Output {
        let (sender, commands) = sync_channel(QUEUE_CAPACITY);
        let errors = Arc::new(ErrorState::default());
        let worker_errors = errors.clone();
        let worker = std::thread::Builder::new()
            .name("raw-writer".to_owned())
            .spawn(move || run_writer(writer, commands, worker_errors))
            .expect("원문 쓰기 스레드를 만들지 못했습니다");
        Output {
            sender: Some(sender),
            worker: Some(worker),
            errors,
            dirty: false,
            throughput: Arc::default(),
            since_report: Counts::default(),
            total: Counts::default(),
            flush_tick: ticker(FLUSH_EVERY),
            report_tick: ticker(REPORT_EVERY),
        }
    }

    pub fn throughput(&self) -> Arc<Throughput> {
        self.throughput.clone()
    }

    pub fn write_frame(&mut self, recv_ms: i64, text: &Utf8Bytes) -> io::Result<()> {
        self.count(text.len());
        self.send_record(RawRecord::Frame { recv_ms, text: text.clone() })
    }

    pub fn write_text(&mut self, recv_ms: i64, text: &str) -> io::Result<()> {
        self.count(text.len());
        self.send_record(RawRecord::Text { recv_ms, text: text.to_owned() })
    }

    pub fn write_event(&mut self, line: &RawLine<'_>) -> io::Result<()> {
        self.send_record(RawRecord::from_line(line))
    }

    fn count(&mut self, bytes: usize) {
        self.throughput.add(bytes);
        for counts in [&mut self.since_report, &mut self.total] {
            counts.frames += 1;
            counts.bytes += bytes as u64;
        }
    }

    fn send_record(&mut self, record: RawRecord) -> io::Result<()> {
        self.errors.check()?;
        let sender = self.sender.as_ref().ok_or_else(closed)?;
        match sender.try_send(WriteCommand::Write(record)) {
            Ok(()) => {
                self.dirty = true;
                Ok(())
            }
            Err(TrySendError::Full(_)) => Err(io::Error::new(io::ErrorKind::WouldBlock, "원문 쓰기 대기열이 가득 찼습니다")),
            Err(TrySendError::Disconnected(_)) => {
                self.errors.check()?;
                Err(closed())
            }
        }
    }

    pub fn flush_if_dirty(&mut self) -> io::Result<()> {
        self.errors.check()?;
        if !self.dirty {
            return Ok(());
        }
        let sender = self.sender.as_ref().ok_or_else(closed)?;
        match sender.try_send(WriteCommand::Flush) {
            Ok(()) => {
                self.dirty = false;
                Ok(())
            }
            Err(TrySendError::Full(_)) => Ok(()),
            Err(TrySendError::Disconnected(_)) => {
                self.errors.check()?;
                Err(closed())
            }
        }
    }

    pub fn report(&mut self) {
        let minute = std::mem::take(&mut self.since_report);
        tracing::info!(frames = minute.frames, bytes = minute.bytes, total_frames = self.total.frames, total_bytes = self.total.bytes, "1분 수집 현황");
    }

    pub fn close(&mut self) -> io::Result<()> {
        let sender = self.sender.take();
        let worker = self.worker.take();
        let close_result = match sender {
            Some(sender) => {
                let (ack_tx, ack_rx) = sync_channel(1);
                let sent = sender.send(WriteCommand::Close(ack_tx)).is_ok();
                drop(sender);
                if sent {
                    ack_rx.recv().unwrap_or_else(|_| Err(closed()))
                } else {
                    Ok(())
                }
            }
            None => Ok(()),
        };
        let joined = match worker {
            Some(worker) => worker.join().map_err(|_| io::Error::other("원문 쓰기 스레드가 비정상 종료했습니다")),
            None => Ok(()),
        };
        self.errors.check()?;
        joined?;
        close_result
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "원문 파일이 이미 닫혔습니다")
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn background_write_error_surfaces_on_close() {
        let dir = tempdir().unwrap();
        let blocked = dir.path().join("not-a-dir");
        std::fs::write(&blocked, b"file").unwrap();
        let mut output = Output::new(&blocked);
        let _ = output.write_frame(1_784_510_875_000, &Utf8Bytes::from_static("{\"n\":1}"));
        let error = output.close().unwrap_err();
        assert_ne!(error.kind(), io::ErrorKind::BrokenPipe, "{error}");
    }
}
