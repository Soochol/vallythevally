use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use domain::KstTime;
use serde::Serialize;
use server::kiwoom::rest::Usage;
use server::shared_data::Broker;

use super::wire::TrMinute;
use crate::protocol::KeyName;
use crate::supervise::kst_stamp;

pub const USAGE_VERSION: u32 = 1;
const PER_TR_LIMIT: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageMinute {
    pub minute_start: i64,
    pub key_max_per_second: u32,
    pub trs: Vec<TrMinute>,
}

impl UsageMinute {
    pub fn of(usage: &Usage) -> Option<UsageMinute> {
        let started = usage.last_minute_started_at?;
        let trs: Vec<TrMinute> = usage
            .trs
            .iter()
            .filter(|tr| tr.last_minute.sent > 0 || tr.last_minute.rate_limited > 0 || tr.last_minute.resent > 0)
            .map(|tr| TrMinute {
                tr: tr.api_id.to_owned(),
                sent: tr.last_minute.sent,
                rate_limited: tr.last_minute.rate_limited,
                resent: tr.last_minute.resent,
                max_wait_ms: tr.last_minute.max_wait.as_millis() as u64,
                max_per_second: tr.last_minute.max_per_second,
            })
            .collect();
        (!trs.is_empty()).then_some(UsageMinute { minute_start: started.unix(), key_max_per_second: usage.last_minute_key_max_per_second, trs })
    }
}

#[derive(Default)]
pub struct UsagePoller {
    last_started: Option<i64>,
}

impl UsagePoller {
    pub fn take(&mut self, usage: &Usage) -> Option<UsageMinute> {
        let started = usage.last_minute_started_at?.unix();
        if self.last_started == Some(started) {
            return None;
        }
        self.last_started = Some(started);
        UsageMinute::of(usage)
    }
}

pub fn usage_path(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join("usage").join(format!("{date}.jsonl"))
}

#[derive(Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
enum Row<'a> {
    Tr {
        v: u32,
        at: &'a str,
        key: &'a str,
        broker: Broker,
        #[serde(flatten)]
        minute: &'a TrMinute,
    },
    Key {
        v: u32,
        at: &'a str,
        key: &'a str,
        broker: Broker,
        max_per_second: u32,
    },
}

pub struct UsageLog {
    data_dir: PathBuf,
}

impl UsageLog {
    pub fn new(data_dir: PathBuf) -> UsageLog {
        UsageLog { data_dir }
    }

    pub fn append(&self, key: &KeyName, broker: Broker, minute: &UsageMinute) -> io::Result<()> {
        let started = KstTime::from_unix(minute.minute_start);
        let date: u32 = started.kst_date().yyyymmdd().parse().expect("날짜는 숫자 여덟 자리다");
        let at = kst_stamp(started);
        let mut text = String::new();
        let mut push = |row: &Row<'_>| {
            text.push_str(&serde_json::to_string(row).expect("사용량 줄은 JSON으로 바뀐다"));
            text.push('\n');
        };
        for tr in &minute.trs {
            push(&Row::Tr { v: USAGE_VERSION, at: &at, key: key.as_str(), broker, minute: tr });
        }
        push(&Row::Key { v: USAGE_VERSION, at: &at, key: key.as_str(), broker, max_per_second: minute.key_max_per_second });
        let path = usage_path(&self.data_dir, date);
        std::fs::create_dir_all(path.parent().expect("사용량 파일은 폴더 안에 있다"))?;
        OpenOptions::new().create(true).append(true).open(path)?.write_all(text.as_bytes())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitEvidence {
    TotalLimit,
    PerTrLimit,
    Independent,
    NotReached,
}

pub fn judge_limit(minute: &UsageMinute) -> LimitEvidence {
    let limited = minute.trs.iter().any(|tr| tr.rate_limited > 0);
    let each_within_limit = minute.trs.iter().all(|tr| tr.max_per_second <= PER_TR_LIMIT);
    match (limited, minute.key_max_per_second > PER_TR_LIMIT, each_within_limit) {
        (true, true, true) => LimitEvidence::TotalLimit,
        (true, _, _) => LimitEvidence::PerTrLimit,
        (false, true, _) => LimitEvidence::Independent,
        (false, false, _) => LimitEvidence::NotReached,
    }
}
