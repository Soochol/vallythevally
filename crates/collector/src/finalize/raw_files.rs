use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::raw_read::day_files;
use crate::raw_write::raw_day_dir;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RawFiles(BTreeMap<String, u64>);

impl RawFiles {
    pub fn of_day(data_dir: &Path, date: u32) -> io::Result<RawFiles> {
        Ok(RawFiles(read_files(data_dir, date)?))
    }

    pub fn unread_of_day(data_dir: &Path, date: u32) -> io::Result<Vec<String>> {
        let day_dir = raw_day_dir(data_dir, date);
        let mut every = BTreeSet::new();
        collect(&day_dir, &mut every)?;
        let read: BTreeSet<PathBuf> = day_files(data_dir, date)?.into_iter().map(|(_, path)| path).collect();
        Ok(every.difference(&read).map(|path| slash_name(&day_dir, path)).collect())
    }

    pub fn paths_differing_from(&self, other: &RawFiles) -> Vec<String> {
        let paths: BTreeSet<&String> = self.0.keys().chain(other.0.keys()).collect();
        paths.into_iter().filter(|path| self.0.get(*path) != other.0.get(*path)).cloned().collect()
    }
}

fn read_files(data_dir: &Path, date: u32) -> io::Result<BTreeMap<String, u64>> {
    let day_dir = raw_day_dir(data_dir, date);
    let mut files = BTreeMap::new();
    for (_, path) in day_files(data_dir, date)? {
        files.insert(slash_name(&day_dir, &path), fs::metadata(&path).or_else(|_| fs::symlink_metadata(&path))?.len());
    }
    Ok(files)
}

fn slash_name(day_dir: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(day_dir).expect("원문 파일은 날짜 폴더 아래에 있다");
    relative.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

fn collect(folder: &Path, files: &mut BTreeSet<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            collect(&entry.path(), files)?;
        } else {
            files.insert(entry.path());
        }
    }
    Ok(())
}
