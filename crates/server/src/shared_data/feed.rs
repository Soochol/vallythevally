use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use serde::de::DeserializeOwned;

use super::format::{DataKind, FEED_EXTENSION, FORMAT_VERSION, Header, newest_file};

struct Cursor {
    path: PathBuf,
    identity: u64,
    offset: u64,
    rejected: bool,
    head: Vec<u8>,
}

pub struct Feed<T> {
    kind: DataKind,
    items: RwLock<Vec<T>>,
    errors: AtomicU64,
    cursor: Mutex<Option<Cursor>>,
}

impl<T: DeserializeOwned> Feed<T> {
    pub fn new(kind: DataKind) -> Self {
        Feed { kind, items: RwLock::new(Vec::new()), errors: AtomicU64::new(0), cursor: Mutex::new(None) }
    }

    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        self.items.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn read<R>(&self, f: impl FnOnce(&[T]) -> R) -> R {
        f(&self.items.read().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn poll(&self, dir: &Path) {
        let kind = self.kind;
        let Some(path) = newest_file(dir, kind, FEED_EXTENSION) else { return };
        let Ok(mut file) = File::open(&path) else { return };
        let Ok(meta) = file.metadata() else { return };
        let (len, identity) = (meta.len(), super::format::file_identity(&meta));
        let mut cursor = self.cursor.lock().unwrap_or_else(|e| e.into_inner());
        let replaced = cursor.as_ref().is_none_or(|c| c.path != path || c.identity != identity || len < c.offset || !head_matches(&mut file, &c.head));
        if replaced {
            *cursor = Some(Cursor { path: path.clone(), identity, offset: 0, rejected: false, head: Vec::new() });
        }
        let cursor = cursor.as_mut().expect("위에서 채웠다");
        if cursor.rejected || len == cursor.offset {
            return;
        }
        let mut chunk = Vec::new();
        if file.seek(SeekFrom::Start(cursor.offset)).and_then(|_| file.read_to_end(&mut chunk)).is_err() {
            return;
        }
        let complete = chunk.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let mut fresh = Vec::new();
        let mut header_pending = cursor.offset == 0;
        let mut line_end = 0;
        for line in chunk[..complete].split(|b| *b == b'\n') {
            line_end += line.len() + 1;
            if line.is_empty() {
                continue;
            }
            if header_pending {
                header_pending = false;
                cursor.head = chunk[..line_end].to_vec();
                if let Err(reason) = check_header(line, kind) {
                    self.errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(path = %path.display(), %reason, "덧붙이는 공용 자료의 머리를 읽지 못했습니다");
                    cursor.rejected = true;
                    return;
                }
                self.items.write().unwrap_or_else(|e| e.into_inner()).clear();
                continue;
            }
            match serde_json::from_slice::<T>(line) {
                Ok(item) => fresh.push(item),
                Err(e) => {
                    self.errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(path = %path.display(), error = %e, "덧붙이는 공용 자료의 줄을 건너뜁니다");
                }
            }
        }
        cursor.offset += complete as u64;
        if !fresh.is_empty() {
            self.items.write().unwrap_or_else(|e| e.into_inner()).extend(fresh);
        }
    }
}

fn head_matches(file: &mut File, head: &[u8]) -> bool {
    let mut seen = vec![0; head.len()];
    file.seek(SeekFrom::Start(0)).and_then(|_| file.read_exact(&mut seen)).is_ok() && seen == head
}

fn check_header(line: &[u8], kind: DataKind) -> Result<(), String> {
    let header: Header = serde_json::from_slice(line).map_err(|e| e.to_string())?;
    if header.format_version != FORMAT_VERSION {
        return Err(format!("모르는 형식 버전 {}", header.format_version));
    }
    if header.kind != kind {
        return Err("폴더와 자료 종류가 다릅니다".to_owned());
    }
    Ok(())
}
