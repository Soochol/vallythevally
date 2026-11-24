use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use server::shared_data::{FlowDescription, FlowRow, FlowWriter, SYMBOL_FLOW_FOLDER, flow_links_path, flow_path};

use crate::finalize::{COMPLETE_FILE_NAME, store_dir};
use crate::protocol::KeyName;

const STORE_FOLDER: &str = "store";
const DATE_FOLDER_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum LinkEvent {
    Start,
    Live,
    Down,
    Alive,
    End,
}

#[derive(Serialize)]
struct LinkLine {
    t: i64,
    event: LinkEvent,
}

pub struct FileFlowStore {
    shared_dir: PathBuf,
    key: KeyName,
    verified: HashMap<PathBuf, FlowDescription>,
}

impl FileFlowStore {
    pub fn new(shared_dir: PathBuf, key: KeyName) -> FileFlowStore {
        FileFlowStore { shared_dir, key, verified: HashMap::new() }
    }

    pub(super) fn append_rows(
        &mut self,
        date: u32,
        type_code: &str,
        symbol: &str,
        fids: &[u32],
        rows: &[FlowRow],
    ) -> io::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let date_text = date.to_string();
        let path = flow_path(&self.shared_dir, &date_text, type_code, symbol, self.key.as_str());
        let description = FlowDescription::new(type_code, symbol, &date_text, self.key.as_str(), fids);
        let already_verified = self.verified.get(&path) == Some(&description);
        let mut writer = if already_verified {
            match FlowWriter::open_verified(&path) {
                Ok(writer) => writer,
                Err(error) if error.kind() == io::ErrorKind::NotFound => FlowWriter::open(&path, description.clone())?,
                Err(error) => {
                    self.verified.remove(&path);
                    return Err(error);
                }
            }
        } else {
            FlowWriter::open(&path, description.clone())?
        };
        if let Err(error) = writer.append(rows) {
            self.verified.remove(&path);
            return Err(error);
        }
        self.verified.insert(path, description);
        Ok(())
    }

    pub(super) fn append_link(&mut self, date: u32, t: i64, event: LinkEvent) -> io::Result<()> {
        let path = flow_links_path(&self.shared_dir, &date.to_string(), self.key.as_str());
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut line = serde_json::to_vec(&LinkLine { t, event }).map_err(io::Error::other)?;
        line.push(b'\n');
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(&line)
    }
}

fn date_folders(folder: &Path) -> io::Result<Vec<u32>> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut dates = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| name.len() == DATE_FOLDER_LEN && name.bytes().all(|byte| byte.is_ascii_digit())) else {
            continue;
        };
        if entry.file_type()?.is_dir() {
            dates.extend(name.parse::<u32>());
        }
    }
    dates.sort_unstable();
    Ok(dates)
}

fn has_complete(data_dir: &Path, date: u32) -> bool {
    store_dir(data_dir, date).join(COMPLETE_FILE_NAME).is_file()
}

pub fn remove_finished_days(shared_dir: &Path, data_dir: &Path) -> io::Result<Vec<u32>> {
    let finished = date_folders(&data_dir.join(STORE_FOLDER))?;
    let Some(newest_finished) = finished.into_iter().filter(|date| has_complete(data_dir, *date)).max() else {
        return Ok(Vec::new());
    };
    let flow_root = shared_dir.join(SYMBOL_FLOW_FOLDER);
    let flow_days = date_folders(&flow_root)?;
    let mut removed = Vec::new();
    for date in flow_days {
        if date < newest_finished && has_complete(data_dir, date) {
            let target = flow_root.join(date.to_string());
            if fs::symlink_metadata(&target)?.file_type().is_dir() {
                fs::remove_dir_all(&target)?;
                removed.push(date);
            }
        }
    }
    Ok(removed)
}
