use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::PathBuf;

use domain::KstDate;
use server::shared_data::{Broker, DataKind, FeedWriter, Header, MinuteBar, SourceKey, minute_path};

use crate::protocol::KeyName;

pub trait MinuteStore: Send {
    fn load(&mut self, date: u32) -> io::Result<Vec<MinuteBar>>;
    fn append(&mut self, date: u32, bars: &[MinuteBar], as_of: i64) -> io::Result<()>;
    fn finish(&mut self) -> io::Result<()>;
}

pub struct FileMinuteStore {
    shared_dir: PathBuf,
    key: KeyName,
    open: Option<(u32, FeedWriter)>,
}

impl FileMinuteStore {
    pub fn new(shared_dir: PathBuf, key: KeyName) -> FileMinuteStore {
        FileMinuteStore { shared_dir, key, open: None }
    }

    fn path(&self, date: u32) -> PathBuf {
        minute_path(&self.shared_dir, &date.to_string(), self.key.as_str())
    }

    fn writer_for(&mut self, date: u32, as_of: i64) -> io::Result<&mut FeedWriter> {
        if self.open.as_ref().is_none_or(|(open_date, _)| *open_date != date) {
            let observation_date = KstDate::parse_yyyymmdd(&date.to_string()).ok_or_else(|| io::Error::other(format!("관측일을 읽지 못했습니다: {date}")))?;
            let sources = vec![SourceKey { key_name: self.key.as_str().to_owned(), broker: Broker::Kiwoom }];
            let header = Header::new(DataKind::Minute, observation_date, as_of, as_of, sources);
            self.open = Some((date, FeedWriter::open_at(&self.path(date), header)?));
        }
        Ok(&mut self.open.as_mut().expect("방금 열었다").1)
    }
}

impl MinuteStore for FileMinuteStore {
    fn load(&mut self, date: u32) -> io::Result<Vec<MinuteBar>> {
        let file = match File::open(self.path(date)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut latest: HashMap<_, MinuteBar> = HashMap::new();
        for line in BufReader::new(file).lines().skip(1) {
            if let Ok(bar) = serde_json::from_str::<MinuteBar>(&line?) {
                latest.insert(bar.key(), bar);
            }
        }
        Ok(latest.into_values().collect())
    }

    fn append(&mut self, date: u32, bars: &[MinuteBar], as_of: i64) -> io::Result<()> {
        let result = self.writer_for(date, as_of).and_then(|writer| bars.iter().try_for_each(|bar| writer.append(bar)));
        if result.is_err() {
            self.open = None;
        }
        result
    }

    fn finish(&mut self) -> io::Result<()> {
        match self.open.take() {
            Some((_, writer)) => writer.sync(),
            None => Ok(()),
        }
    }
}
