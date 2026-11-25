use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};

use domain::KstDate;
use flate2::read::GzDecoder;
use serde::de::DeserializeOwned;

use super::super::format::{DataKind, Envelope, FEED_EXTENSION, FORMAT_VERSION, Header};
use super::super::symbol_flow::complete_jsonl_prefix;
use super::files::{CURRENT_FILE, ClosedQuotes, CurrentQuotes, GAPS_FILE, LIVE_FOLDER, closed_day_dir, live_day_dir};
use super::fold::QuoteMinute;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuoteDay {
    pub closed: bool,
    pub minutes: Vec<QuoteMinute>,
    pub gaps: Vec<(u32, u32)>,
}

pub fn read_quote_day(dir: &Path, date: &str, code: &str) -> io::Result<Option<QuoteDay>> {
    let closed_dir = closed_day_dir(dir, date);
    if closed_dir.is_dir() {
        return read_closed_day(&closed_dir, code);
    }
    read_live_day(&live_day_dir(dir, date), code)
}

pub fn quote_days(dir: &Path) -> io::Result<Vec<KstDate>> {
    let mut days = BTreeSet::new();
    collect_dates(&dir.join(DataKind::QuoteMinutes.folder()), &mut days)?;
    collect_dates(&dir.join(LIVE_FOLDER), &mut days)?;
    Ok(days.into_iter().collect())
}

pub fn live_quote_days_for_stock(dir: &Path, stock_code: &str) -> io::Result<Vec<String>> {
    let live_root = dir.join(LIVE_FOLDER);
    let entries = match std::fs::read_dir(&live_root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let file_name = format!("{stock_code}.{FEED_EXTENSION}");
    let mut days = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Ok(date) = entry.file_name().into_string() else { continue };
        if KstDate::parse_yyyymmdd(&date).is_none() || !entry.file_type()?.is_dir() {
            continue;
        }
        if day_has_stock_file(&entry.path(), &file_name)? {
            days.push(date);
        }
    }
    days.sort_unstable();
    Ok(days)
}

pub fn live_quote_stock_keys(dir: &Path, date: &str, code: &str) -> io::Result<Vec<(String, u16)>> {
    let live_dir = live_day_dir(dir, date);
    let entries = match std::fs::read_dir(&live_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let file_name = format!("{code}.{FEED_EXTENSION}");
    let mut keys = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Ok(key_name) = entry.file_name().into_string() else { continue };
        let stock_path = entry.path().join(&file_name);
        if let Some(first_minute) = first_quote_minute(&stock_path) {
            keys.push((key_name, first_minute));
        }
    }
    Ok(keys)
}

fn day_has_stock_file(day_dir: &Path, file_name: &str) -> io::Result<bool> {
    let entries = match std::fs::read_dir(day_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() && entry.path().join(file_name).is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn first_quote_minute(path: &Path) -> Option<u16> {
    let bytes = std::fs::read(path).ok()?;
    let complete = complete_jsonl_prefix(&bytes);
    let mut header_checked = false;
    for line in complete.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if !header_checked {
            header_checked = true;
            let header: Header = serde_json::from_slice(line).ok()?;
            if !header_valid(&header) {
                return None;
            }
            continue;
        }
        if let Ok(qm) = serde_json::from_slice::<QuoteMinute>(line) {
            return Some(qm.minute);
        }
    }
    None
}

fn collect_dates(root: &Path, days: &mut BTreeSet<KstDate>) -> io::Result<()> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else { continue };
        if let Some(date) = KstDate::parse_yyyymmdd(&name) {
            days.insert(date);
        }
    }
    Ok(())
}

fn read_closed_day(closed_dir: &Path, code: &str) -> io::Result<Option<QuoteDay>> {
    let path = closed_dir.join(format!("{code}.json.gz"));
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let decoder = GzDecoder::new(BufReader::new(file));
    let envelope: Envelope<ClosedQuotes> = serde_json::from_reader(decoder).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if !header_valid(&envelope.header) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "닫힌 날 분 호가 머리가 맞지 않습니다"));
    }
    Ok(Some(QuoteDay {
        closed: true,
        minutes: envelope.body.minutes,
        gaps: envelope.body.gaps,
    }))
}

fn read_live_day(live_dir: &Path, code: &str) -> io::Result<Option<QuoteDay>> {
    let key_dirs = sorted_key_dirs(live_dir)?;
    if key_dirs.is_empty() {
        return Ok(None);
    }
    let mut minutes: BTreeMap<u16, QuoteMinute> = BTreeMap::new();
    let mut gaps: Vec<(u32, u32)> = Vec::new();
    for key_dir in key_dirs {
        let mut key_has_code = false;
        if let Some(current) = read_current_for(&key_dir.join(CURRENT_FILE), code)? {
            key_has_code = true;
            insert_minute(&mut minutes, current);
        }
        let stock_path = key_dir.join(format!("{code}.{FEED_EXTENSION}"));
        for item in read_jsonl_items::<QuoteMinute>(&stock_path)? {
            key_has_code = true;
            insert_minute(&mut minutes, item);
        }
        if key_has_code {
            gaps.extend(read_jsonl_items::<(u32, u32)>(&key_dir.join(GAPS_FILE))?);
        }
    }
    if minutes.is_empty() {
        return Ok(None);
    }
    gaps.sort_unstable();
    Ok(Some(QuoteDay {
        closed: false,
        minutes: minutes.into_values().collect(),
        gaps,
    }))
}

fn sorted_key_dirs(live_dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(live_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut dirs = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Ok(dirs)
}

fn insert_minute(minutes: &mut BTreeMap<u16, QuoteMinute>, incoming: QuoteMinute) {
    match minutes.get(&incoming.minute) {
        Some(existing) => {
            if let Some(merged) = existing.merged_with(&incoming) {
                minutes.insert(merged.minute, merged);
            }
        }
        None => {
            minutes.insert(incoming.minute, incoming);
        }
    }
}

fn read_current_for(path: &Path, code: &str) -> io::Result<Option<QuoteMinute>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let Ok(envelope) = serde_json::from_slice::<Envelope<CurrentQuotes>>(&bytes) else {
        return Ok(None);
    };
    if !header_valid(&envelope.header) {
        return Ok(None);
    }
    Ok(envelope.body.minutes.get(code).cloned())
}

fn read_jsonl_items<T: DeserializeOwned>(path: &Path) -> io::Result<Vec<T>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let complete = complete_jsonl_prefix(&bytes);
    let mut items = Vec::new();
    let mut header_pending = true;
    for line in complete.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if header_pending {
            header_pending = false;
            let Ok(header) = serde_json::from_slice::<Header>(line) else {
                return Ok(Vec::new());
            };
            if !header_valid(&header) {
                return Ok(Vec::new());
            }
            continue;
        }
        if let Ok(item) = serde_json::from_slice::<T>(line) {
            items.push(item);
        }
    }
    Ok(items)
}

fn header_valid(header: &Header) -> bool {
    header.format_version == FORMAT_VERSION && header.kind == DataKind::QuoteMinutes
}
