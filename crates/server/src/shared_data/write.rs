use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::format::{Envelope, FEED_EXTENSION, FORMAT_VERSION, Header, SNAPSHOT_EXTENSION, data_path};

pub fn write_snapshot<B: Serialize>(dir: &Path, header: Header, body: B) -> io::Result<PathBuf> {
    let path = data_path(dir, header.kind, &header.observation_date, SNAPSHOT_EXTENSION);
    write_snapshot_at(path, header, body)
}

pub fn write_snapshot_at<B: Serialize>(path: PathBuf, header: Header, body: B) -> io::Result<PathBuf> {
    let folder = path.parent().expect("자료 파일은 종류 폴더 안에 있다");
    std::fs::create_dir_all(folder)?;
    let temporary = folder.join(format!(".{}.tmp-{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("data"), std::process::id()));
    let bytes = serde_json::to_vec(&Envelope { header, body }).map_err(io::Error::other)?;
    let mut file = File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, &path)?;
    File::open(folder)?.sync_all()?;
    Ok(path)
}

pub struct FeedWriter {
    file: File,
}

impl FeedWriter {
    pub fn open(dir: &Path, header: Header) -> io::Result<FeedWriter> {
        FeedWriter::open_at(&data_path(dir, header.kind, &header.observation_date, FEED_EXTENSION), header)
    }

    pub fn open_at(path: &Path, header: Header) -> io::Result<FeedWriter> {
        assert_eq!(header.format_version, FORMAT_VERSION);
        std::fs::create_dir_all(path.parent().expect("자료 파일은 폴더 안에 있다"))?;
        let mut file = OpenOptions::new().read(true).append(true).create(true).open(path)?;
        let complete_len = complete_prefix_len(&mut file)?;
        file.set_len(complete_len)?;
        if complete_len == 0 {
            let mut line = serde_json::to_vec(&header).map_err(io::Error::other)?;
            line.push(b'\n');
            file.write_all(&line)?;
            file.sync_all()?;
        }
        Ok(FeedWriter { file })
    }

    pub fn append<T: Serialize>(&mut self, item: &T) -> io::Result<()> {
        let mut line = serde_json::to_vec(item).map_err(io::Error::other)?;
        line.push(b'\n');
        self.file.write_all(&line)
    }

    pub fn sync(&self) -> io::Result<()> {
        self.file.sync_data()
    }
}

fn complete_prefix_len(file: &mut File) -> io::Result<u64> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i as u64 + 1))
}
