use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use domain::{KstDate, KstTime};
use serde::{Deserialize, Serialize};
use server::shared_data::{Broker, DataKind, Header, MadeCard, OverviewBody, SourceKey, write_snapshot};

use crate::protocol::KeyName;

const PARTS_FOLDER: &str = "market-overview-parts";
const LOCK_FILE: &str = ".lock";
const PART_SUFFIX: &str = ".json";

#[derive(Debug, Serialize, Deserialize)]
struct PartFile {
    key_name: String,
    broker: Broker,
    cards: Vec<MadeCard>,
}

fn parts_dir(shared_dir: &Path) -> PathBuf {
    shared_dir.join(PARTS_FOLDER)
}

fn part_path(shared_dir: &Path, date: &str, key: &KeyName) -> PathBuf {
    parts_dir(shared_dir).join(format!("{date}.{}{PART_SUFFIX}", key.as_str()))
}

fn write_part(shared_dir: &Path, date: &str, part: &PartFile, key: &KeyName) -> io::Result<()> {
    let path = part_path(shared_dir, date, key);
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec(part).map_err(io::Error::other)?)?;
    fs::rename(&temporary, &path)
}

fn parts_of(shared_dir: &Path, date: &str) -> Vec<PartFile> {
    let Ok(entries) = fs::read_dir(parts_dir(shared_dir)) else { return Vec::new() };
    let mut names: Vec<PathBuf> = entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| is_part_of(path, date)).collect();
    names.sort();
    names.iter().filter_map(|path| fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<PartFile>(&bytes).ok())).collect()
}

fn is_part_of(path: &Path, date: &str) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&format!("{date}.")) && name.ends_with(PART_SUFFIX))
}

fn prune_other_days(shared_dir: &Path, date: &str) {
    let Ok(entries) = fs::read_dir(parts_dir(shared_dir)) else { return };
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let is_part = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(PART_SUFFIX) && !name.starts_with('.'));
        if is_part && !is_part_of(&path, date) {
            let _ = fs::remove_file(&path);
        }
    }
}

pub(super) fn publish(shared_dir: &Path, observation_date: KstDate, key: &KeyName, broker: Broker, cards: Vec<MadeCard>, now: KstTime) -> io::Result<()> {
    let date = observation_date.yyyymmdd();
    fs::create_dir_all(parts_dir(shared_dir))?;
    let lock = File::create(parts_dir(shared_dir).join(LOCK_FILE))?;
    lock.lock()?;
    write_part(shared_dir, &date, &PartFile { key_name: key.as_str().to_owned(), broker, cards }, key)?;
    let parts = parts_of(shared_dir, &date);
    let sources: Vec<SourceKey> = parts.iter().map(|part| SourceKey { key_name: part.key_name.clone(), broker: part.broker }).collect();
    let all: Vec<MadeCard> = parts.into_iter().flat_map(|part| part.cards).collect();
    let as_of = all.iter().map(|card| card.made_at).min().unwrap_or(now.unix());
    let header = Header::new(DataKind::MarketOverview, observation_date, as_of, now.unix(), sources);
    write_snapshot(shared_dir, header, OverviewBody::from_cards(all))?;
    prune_other_days(shared_dir, &date);
    Ok(())
}
