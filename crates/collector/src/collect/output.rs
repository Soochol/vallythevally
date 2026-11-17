use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::time::{Interval, MissedTickBehavior, interval_at, Instant};

use crate::protocol::KeyName;
use crate::raw_write::{RawLine, RawWriter};

pub const FLUSH_EVERY: Duration = Duration::from_secs(1);
pub const REPORT_EVERY: Duration = Duration::from_secs(60);

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

pub struct Output {
    writer: Option<RawWriter>,
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
        Output {
            writer: Some(writer),
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

    pub fn write_frame(&mut self, recv_ms: i64, text: &str) -> io::Result<()> {
        self.count(text.len());
        self.write(&RawLine::Frame { recv_ms, text })
    }

    pub fn write_text(&mut self, recv_ms: i64, text: &str) -> io::Result<()> {
        self.count(text.len());
        self.write(&RawLine::Text { recv_ms, text })
    }

    pub fn write_event(&mut self, line: &RawLine<'_>) -> io::Result<()> {
        self.write(line)
    }

    fn count(&mut self, bytes: usize) {
        self.throughput.add(bytes);
        for counts in [&mut self.since_report, &mut self.total] {
            counts.frames += 1;
            counts.bytes += bytes as u64;
        }
    }

    fn write(&mut self, line: &RawLine<'_>) -> io::Result<()> {
        let writer = self.writer.as_mut().ok_or_else(closed)?;
        writer.write(line)?;
        self.dirty = true;
        Ok(())
    }

    pub fn flush_if_dirty(&mut self) -> io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        self.dirty = false;
        self.writer.as_mut().ok_or_else(closed)?.flush()
    }

    pub fn report(&mut self) {
        let minute = std::mem::take(&mut self.since_report);
        tracing::info!(frames = minute.frames, bytes = minute.bytes, total_frames = self.total.frames, total_bytes = self.total.bytes, "1분 수집 현황");
    }

    pub fn close(&mut self) -> io::Result<()> {
        match self.writer.take() {
            Some(writer) => writer.close(),
            None => Ok(()),
        }
    }
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "원문 파일이 이미 닫혔습니다")
}
