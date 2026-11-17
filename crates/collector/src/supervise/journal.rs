use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use domain::KstTime;
use serde::Serialize;

use crate::plan::plan_path;
use crate::protocol::{KeyName, RealType};

pub const JOURNAL_VERSION: u32 = 1;

pub fn journal_path(data_dir: &Path, date: u32) -> PathBuf {
    plan_path(data_dir, date).with_extension("events.jsonl")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum JournalEvent {
    ChildStarted { key: KeyName, pid: Option<u32>, restarts: u32 },
    ChildExited { key: KeyName, code: Option<i32> },
    HeartbeatLost { key: KeyName, silent_secs: u64 },
    ChildRejected { key: KeyName, reason: String },
    Restart { key: KeyName, restart: u32, delay_secs: u64 },
    KeyStopped { key: KeyName, reason: String },
    Handoff { from: KeyName, to: KeyName, stocks: Vec<String>, market_types: Vec<RealType> },
    HandoffSkipped { key: KeyName, reason: String },
    RegisterFailed { key: KeyName, id: String, part: u32, parts: u32, items: usize, reason: String, return_code: Option<i64>, detail: Option<u16> },
    TokenIssued { key: KeyName, generation: u64 },
    TokenInvalid { key: KeyName, generation: u64 },
}

#[derive(Serialize)]
struct Record<'a> {
    v: u32,
    at: String,
    #[serde(flatten)]
    event: &'a JournalEvent,
}

pub fn kst_stamp(time: KstTime) -> String {
    let date = time.kst_date();
    let seconds = time.kst_time_of_day().secs();
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}+09:00", date.year(), date.month(), date.day(), seconds / 3600, seconds / 60 % 60, seconds % 60)
}

pub struct Journal {
    path: PathBuf,
    file: File,
}

impl Journal {
    pub fn open(path: PathBuf) -> io::Result<Journal> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Journal { path, file })
    }

    pub fn append(&mut self, at: KstTime, event: &JournalEvent) {
        let mut line = serde_json::to_string(&Record { v: JOURNAL_VERSION, at: kst_stamp(at), event }).expect("사건 기록은 항상 JSON으로 바뀐다");
        line.push('\n');
        if let Err(error) = self.file.write_all(line.as_bytes()).and_then(|()| self.file.flush()) {
            tracing::error!(path = %self.path.display(), %error, "사건 기록을 쓰지 못했습니다");
        }
    }
}
