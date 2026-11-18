use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::raw_write::raw_day_dir;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RawFiles(BTreeMap<String, u64>);

impl RawFiles {
    pub fn of_day(data_dir: &Path, date: u32) -> io::Result<RawFiles> {
        let mut files = BTreeMap::new();
        collect(&raw_day_dir(data_dir, date), "", &mut files)?;
        Ok(RawFiles(files))
    }

    pub fn paths_differing_from(&self, other: &RawFiles) -> Vec<String> {
        let paths: BTreeSet<&String> = self.0.keys().chain(other.0.keys()).collect();
        paths.into_iter().filter(|path| self.0.get(*path) != other.0.get(*path)).cloned().collect()
    }
}

fn collect(folder: &Path, prefix: &str, files: &mut BTreeMap<String, u64>) -> io::Result<()> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if entry.file_type()?.is_dir() {
            collect(&entry.path(), &path, files)?;
        } else {
            files.insert(path, entry.metadata()?.len());
        }
    }
    Ok(())
}
