use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use server::shared_data::{FlowDescription, FlowLinkEvent, FlowLinkLine, FlowRow, FlowWriter, SYMBOL_FLOW_FOLDER, complete_jsonl_prefix, flow_links_path, flow_path};

use crate::finalize::{COMPLETE_FILE_NAME, store_dir};
use crate::protocol::KeyName;

const STORE_FOLDER: &str = "store";
const DATE_FOLDER_LEN: usize = 8;

pub struct FileFlowStore {
    shared_dir: PathBuf,
    key: KeyName,
    verified: HashMap<PathBuf, FlowDescription>,
    verified_links: HashSet<PathBuf>,
}

impl FileFlowStore {
    pub fn new(shared_dir: PathBuf, key: KeyName) -> FileFlowStore {
        FileFlowStore { shared_dir, key, verified: HashMap::new(), verified_links: HashSet::new() }
    }

    pub(crate) fn append_rows(
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
            match FlowWriter::open_verified(&path, fids.len()) {
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

    pub(super) fn append_link(&mut self, date: u32, t: i64, event: FlowLinkEvent) -> io::Result<()> {
        let path = flow_links_path(&self.shared_dir, &date.to_string(), self.key.as_str());
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut line = serde_json::to_vec(&FlowLinkLine { t, event }).map_err(io::Error::other)?;
        line.push(b'\n');
        let already_verified = self.verified_links.contains(&path);
        let mut file = OpenOptions::new().read(!already_verified).write(true).create(true).truncate(false).open(&path)?;
        let before = if already_verified {
            file.seek(SeekFrom::End(0))?
        } else {
            let file_len = file.metadata()?.len();
            let complete_len = complete_lines_len(&mut file)?;
            if complete_len < file_len {
                file.set_len(complete_len)?;
            }
            file.seek(SeekFrom::Start(complete_len))?
        };
        if let Err(error) = file.write_all(&line) {
            let _ = file.set_len(before);
            self.verified_links.remove(&path);
            return Err(error);
        }
        self.verified_links.insert(path);
        Ok(())
    }
}

fn complete_lines_len(file: &mut File) -> io::Result<u64> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(complete_jsonl_prefix(&bytes).len() as u64)
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
