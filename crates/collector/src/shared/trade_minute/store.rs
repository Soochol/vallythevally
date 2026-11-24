use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use domain::KstDate;
use server::shared_data::{Broker, DataKind, FeedWriter, Header, SourceKey, TradeMinuteLine, trade_minute_path};

use crate::protocol::KeyName;

const KEEP_RECENT_DAYS: usize = 7;
const DATE_FOLDER_LEN: usize = 8;

pub trait TradeMinuteStore: Send {
    fn append(&mut self, date: u32, lines: &[(String, TradeMinuteLine)]) -> io::Result<()>;
    fn finish(&mut self) -> io::Result<()>;
}

pub struct FileTradeMinuteStore {
    shared_dir: PathBuf,
    key: KeyName,
    pruned_date: Option<u32>,
}

impl FileTradeMinuteStore {
    pub fn new(shared_dir: PathBuf, key: KeyName) -> FileTradeMinuteStore {
        FileTradeMinuteStore { shared_dir, key, pruned_date: None }
    }

    fn prune_if_new_date(&mut self, date: u32) {
        if self.pruned_date == Some(date) {
            return;
        }
        if let Err(error) = prune_old_dates(&self.shared_dir.join(DataKind::TradeMinute.folder()), date) {
            tracing::warn!(%error, date, "오래된 1분 체결 날짜 폴더를 지우지 못했습니다");
        }
        self.pruned_date = Some(date);
    }
}

impl TradeMinuteStore for FileTradeMinuteStore {
    fn append(&mut self, date: u32, lines: &[(String, TradeMinuteLine)]) -> io::Result<()> {
        if lines.is_empty() {
            return Ok(());
        }
        let date_str = date.to_string();
        let observation_date = KstDate::parse_yyyymmdd(&date_str).ok_or_else(|| io::Error::other(format!("관측일을 읽지 못했습니다: {date}")))?;
        self.prune_if_new_date(date);
        let now_sec = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        let sources = vec![SourceKey { key_name: self.key.as_str().to_owned(), broker: Broker::Kiwoom }];
        let header = Header::new(DataKind::TradeMinute, observation_date, now_sec, now_sec, sources);
        for (code, line) in lines {
            let path = trade_minute_path(&self.shared_dir, &date_str, self.key.as_str(), code);
            let mut writer = FeedWriter::open_at(&path, header.clone())?;
            writer.append(line)?;
        }
        Ok(())
    }

    fn finish(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn prune_old_dates(root: &Path, current_date: u32) -> io::Result<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut dates = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| name.len() == DATE_FOLDER_LEN && name.bytes().all(|byte| byte.is_ascii_digit())) else {
            continue;
        };
        if entry.file_type()?.is_dir()
            && let Ok(parsed) = name.parse::<u32>()
        {
            dates.push((parsed, entry.path()));
        }
    }
    if !dates.iter().any(|(d, _)| *d == current_date) {
        dates.push((current_date, root.join(current_date.to_string())));
    }
    dates.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    for (date, path) in dates.into_iter().skip(KEEP_RECENT_DAYS) {
        if date == current_date {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(&path)
            && meta.file_type().is_dir()
        {
            fs::remove_dir_all(&path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prunes_only_eight_digit_date_folders_older_than_seven_days() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("trade-minute");
        for day in 20261110..=20261118 {
            fs::create_dir_all(root.join(day.to_string())).unwrap();
        }
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("20261101"), b"file").unwrap();
        let mut store = FileTradeMinuteStore::new(tmp.path().to_owned(), KeyName::parse("k1").unwrap());
        let line = TradeMinuteLine { minute: 540, trades: vec![(32401, 71000, 1)] };
        store.append(20261119, &[("005930".to_owned(), line)]).unwrap();

        let mut remaining: Vec<String> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        remaining.sort();
        assert_eq!(remaining, ["20261101", "20261113", "20261114", "20261115", "20261116", "20261117", "20261118", "20261119", "notes"]);
    }
}
