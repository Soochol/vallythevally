use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use domain::KstTime;
use serde::Serialize;

use crate::calendar::{Evidence, Mismatch};
use crate::finalize::{IndexCheckResult, JudgedVerdict, TreatedAs};
use crate::plan::plan_path;
use crate::protocol::{KeyName, RealType};
use crate::shared::JobName;

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
    ObservationJudged { day: u32, verdict: JudgedVerdict, open_minute: Option<u16>, treated_as: TreatedAs, evidence: Vec<Evidence> },
    MarketOpenSeen { key: KeyName, deadline: String },
    MarketOpenMissing { deadline: String },
    MarketOpenNotChecked { reason: String },
    SharedJobMoved { job: JobName, from: KeyName, to: Option<KeyName> },
    IndexChecked { result: IndexCheckResult, mismatch: Option<Mismatch>, detail: Option<String> },
}

#[derive(Serialize)]
struct Record<'a> {
    v: u32,
    at: String,
    #[serde(flatten)]
    event: &'a JournalEvent,
}

pub fn read_lossy(path: &Path) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&std::fs::read(path)?).into_owned())
}

pub fn has_event(path: &Path, event: &str) -> bool {
    let Ok(text) = read_lossy(path) else { return false };
    text.lines().filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok()).any(|record| record["event"] == event)
}

fn ends_inside_a_line(file: &mut File) -> io::Result<bool> {
    if file.metadata()?.len() == 0 {
        return Ok(false);
    }
    let mut last = [0u8; 1];
    file.seek(SeekFrom::End(-1))?;
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
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
        let mut file = OpenOptions::new().create(true).read(true).append(true).open(&path)?;
        if ends_inside_a_line(&mut file)? {
            file.write_all(b"\n")?;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path).unwrap().lines().map(str::to_owned).collect()
    }

    fn judged_event() -> JournalEvent {
        JournalEvent::MarketOpenMissing { deadline: "2026-11-18T09:10:00+09:00".to_owned() }
    }

    #[test]
    fn opening_a_file_that_ends_inside_a_line_starts_the_next_event_on_its_own_line() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("plan").join("20261118.events.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{\"v\":1,\"event\":\"child_started\"}\n{\"v\":1,\"event\":\"child_exi").unwrap();
        let mut journal = Journal::open(path.clone()).unwrap();
        journal.append(KstTime::from_unix(0), &judged_event());
        let lines = lines_of(&path);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1], "{\"v\":1,\"event\":\"child_exi");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&lines[2]).unwrap()["event"], "market_open_missing");
    }

    #[test]
    fn opening_an_empty_or_complete_file_adds_no_blank_line() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("events.jsonl");
        Journal::open(path.clone()).unwrap().append(KstTime::from_unix(0), &judged_event());
        Journal::open(path.clone()).unwrap().append(KstTime::from_unix(1), &judged_event());
        assert_eq!(lines_of(&path).len(), 2);
    }
}
