use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tempfile::NamedTempFile;

pub fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

pub fn sync_tree(root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            sync_tree(&path)?;
        } else if file_type.is_file() {
            File::open(&path)?.sync_all()?;
        }
    }
    sync_dir(root)
}

pub fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let folder = path.parent().expect("쓰는 경로에는 폴더가 있다");
    fs::create_dir_all(folder)?;
    let mut temporary = NamedTempFile::new_in(folder)?;
    temporary.write_all(bytes)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|failure| failure.error)?;
    sync_dir(folder)
}

pub fn swap_directory(temporary: &Path, published: &Path, replaced_prefix: &str) -> io::Result<()> {
    sync_tree(temporary)?;
    let parent = published.parent().expect("게시할 폴더에는 부모가 있다");
    match fs::symlink_metadata(published) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::rename(temporary, published)?;
            return sync_dir(parent);
        }
        Err(error) => return Err(error),
    }

    #[cfg(target_os = "linux")]
    match rustix::fs::renameat_with(
        rustix::fs::CWD,
        temporary,
        rustix::fs::CWD,
        published,
        rustix::fs::RenameFlags::EXCHANGE,
    ) {
        Ok(()) => {
            sync_dir(parent)?;
            let _ = remove_path_if_exists(temporary);
            return sync_dir(parent);
        }
        Err(rustix::io::Errno::NOSYS | rustix::io::Errno::OPNOTSUPP | rustix::io::Errno::INVAL) => {}
        Err(errno) => return Err(io::Error::from(errno)),
    }

    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    let replaced = parent.join(format!("{replaced_prefix}{stamp}"));
    fs::rename(published, &replaced)?;
    if let Err(error) = fs::rename(temporary, published) {
        let _ = fs::rename(&replaced, published);
        return Err(error);
    }
    sync_dir(parent)?;
    remove_path_if_exists(&replaced)?;
    sync_dir(parent)
}

pub fn recover_interrupted_dir_swaps(parent: &Path, replaced_suffix: &str, ready_marker: Option<&str>) -> io::Result<()> {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut grouped: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for entry in entries {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else { continue };
        let Some((base_name, _)) = name.split_once(replaced_suffix) else { continue };
        if base_name.is_empty() {
            continue;
        }
        grouped.entry(base_name.to_owned()).or_default().push(entry.path());
    }
    if grouped.is_empty() {
        return Ok(());
    }
    for (base_name, mut replaced) in grouped {
        replaced.sort();
        let published = parent.join(&base_name);
        let temporary = parent.join(format!("{base_name}.tmp"));
        if published.is_dir() {
            for path in &replaced {
                remove_path_if_exists(path)?;
            }
        } else if ready_marker.is_some_and(|marker| temporary.join(marker).is_file()) {
            fs::rename(&temporary, &published)?;
            for path in &replaced {
                remove_path_if_exists(path)?;
            }
        } else {
            let (newest, older) = replaced.split_last().expect("교체 후보가 비어 있지 않다");
            fs::rename(newest, &published)?;
            for path in older {
                remove_path_if_exists(path)?;
            }
        }
    }
    sync_dir(parent)
}

fn remove_path_if_exists(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}
