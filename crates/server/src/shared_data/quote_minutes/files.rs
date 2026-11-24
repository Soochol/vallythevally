use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};

use super::super::format::{Broker, DataKind, Envelope, FEED_EXTENSION, FORMAT_VERSION, Header, SourceKey};
use super::super::write::{FeedWriter, write_snapshot_at};
use super::fold::QuoteMinute;

pub const LIVE_FOLDER: &str = "quote-minutes-live";
pub const GAPS_FILE: &str = "_gaps.jsonl";
pub const CURRENT_FILE: &str = "_current.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentQuotes {
    #[serde(default)]
    pub minutes: BTreeMap<String, QuoteMinute>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedQuotes {
    #[serde(default)]
    pub minutes: Vec<QuoteMinute>,
    #[serde(default)]
    pub gaps: Vec<(u32, u32)>,
}

pub fn live_day_dir(dir: &Path, date: &str) -> PathBuf {
    dir.join(LIVE_FOLDER).join(date)
}

pub fn closed_day_dir(dir: &Path, date: &str) -> PathBuf {
    dir.join(DataKind::QuoteMinutes.folder()).join(date)
}

pub struct LiveQuoteWriter {
    key_dir: PathBuf,
    date: String,
    key_name: String,
    as_of: i64,
    stocks: HashMap<String, FeedWriter>,
    gaps: Option<FeedWriter>,
}

impl LiveQuoteWriter {
    pub fn open(dir: &Path, date: &str, key_name: &str, as_of: i64) -> io::Result<LiveQuoteWriter> {
        let key_dir = live_day_dir(dir, date).join(key_name);
        std::fs::create_dir_all(&key_dir)?;
        Ok(LiveQuoteWriter {
            key_dir,
            date: date.to_owned(),
            key_name: key_name.to_owned(),
            as_of,
            stocks: HashMap::new(),
            gaps: None,
        })
    }

    fn header(&self, as_of: i64) -> Header {
        Header {
            format_version: FORMAT_VERSION,
            kind: DataKind::QuoteMinutes,
            observation_date: self.date.clone(),
            as_of,
            written_at: as_of,
            sources: vec![SourceKey { key_name: self.key_name.clone(), broker: Broker::Kiwoom }],
        }
    }

    pub fn append_minute(&mut self, code: &str, minute: &QuoteMinute) -> io::Result<()> {
        if !self.stocks.contains_key(code) {
            let path = self.key_dir.join(format!("{code}.{FEED_EXTENSION}"));
            let writer = FeedWriter::open_at(&path, self.header(self.as_of))?;
            self.stocks.insert(code.to_owned(), writer);
        }
        self.stocks.get_mut(code).expect("방금 연 파일").append(minute)
    }

    pub fn append_gap(&mut self, from_sec: u32, to_sec: u32) -> io::Result<()> {
        if self.gaps.is_none() {
            let path = self.key_dir.join(GAPS_FILE);
            self.gaps = Some(FeedWriter::open_at(&path, self.header(self.as_of))?);
        }
        self.gaps.as_mut().expect("방금 연 파일").append(&(from_sec, to_sec))
    }

    pub fn write_current(&mut self, current: &CurrentQuotes, as_of: i64) -> io::Result<()> {
        write_snapshot_at(self.key_dir.join(CURRENT_FILE), self.header(as_of), current)?;
        Ok(())
    }

    pub fn load_current(&self) -> io::Result<CurrentQuotes> {
        let path = self.key_dir.join(CURRENT_FILE);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(CurrentQuotes::default()),
            Err(e) => return Err(e),
        };
        let envelope: Envelope<CurrentQuotes> = serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        if envelope.header.format_version != FORMAT_VERSION || envelope.header.kind != DataKind::QuoteMinutes {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "분 호가 진행 파일 머리가 맞지 않습니다"));
        }
        Ok(envelope.body)
    }

    pub fn sync(&self) -> io::Result<()> {
        for writer in self.stocks.values() {
            writer.sync()?;
        }
        if let Some(gaps) = &self.gaps {
            gaps.sync()?;
        }
        Ok(())
    }
}

pub fn write_closed_quotes(day_dir: &Path, date: &str, code: &str, quotes: &ClosedQuotes) -> io::Result<()> {
    std::fs::create_dir_all(day_dir)?;
    let path = day_dir.join(format!("{code}.json.gz"));
    let temporary = day_dir.join(format!(".{code}.json.gz.tmp-{}", std::process::id()));
    let header = Header {
        format_version: FORMAT_VERSION,
        kind: DataKind::QuoteMinutes,
        observation_date: date.to_owned(),
        as_of: 0,
        written_at: 0,
        sources: Vec::new(),
    };
    let file = File::create(&temporary)?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    serde_json::to_writer(&mut encoder, &Envelope { header, body: quotes }).map_err(io::Error::other)?;
    let file = encoder.finish()?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, &path)?;
    File::open(day_dir)?.sync_all()?;
    Ok(())
}
