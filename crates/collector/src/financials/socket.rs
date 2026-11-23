use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use server::financials::Financials;
use server::instance::{InstanceLock, LockError};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;

use super::listing::ListingFeed;
use super::wire::{Command, MAX_REQUEST_BYTES, Reply, Request, VERSION};

const SOCKET_MODE: u32 = 0o600;
const FOLDER_MODE: u32 = 0o700;
const REQUEST_LIMIT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 8;
const NO_LISTING: &str = "종목 목록이 없어 업데이트를 시작하지 않았습니다";

pub struct BoundSocket {
    listener: UnixListener,
    path: PathBuf,
    _lock: InstanceLock,
}

impl Drop for BoundSocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_path_of(socket: &Path) -> PathBuf {
    let mut name = socket.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

pub fn bind(path: &Path) -> io::Result<BoundSocket> {
    if let Some(folder) = path.parent().filter(|folder| !folder.as_os_str().is_empty()) {
        std::fs::DirBuilder::new().recursive(true).mode(FOLDER_MODE).create(folder)?;
    }
    let lock = match InstanceLock::acquire(&lock_path_of(path)) {
        Ok(lock) => lock,
        Err(LockError::Held { .. }) => return Err(io::Error::new(io::ErrorKind::AddrInUse, format!("{}를 쓰는 다른 재무 프로세스가 이미 떠 있습니다", path.display()))),
        Err(LockError::Io { error, .. }) => return Err(error),
    };
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(path)?,
        Ok(_) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{}에 소켓이 아닌 파일이 있습니다", path.display()))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(SOCKET_MODE))?;
    Ok(BoundSocket { listener, path: path.to_owned(), _lock: lock })
}

pub struct Control {
    pub service: Arc<Financials>,
    pub listing: ListingFeed,
}

impl Control {
    async fn answer(&self, command: Command) -> Reply {
        let symbols = self.listing.symbols.borrow().clone();
        let listing = self.listing.info.borrow().clone();
        let (page, refused) = match (command, symbols) {
            (Command::Status, _) => (self.service.update_status().await, None),
            (Command::Pause, _) => (self.service.pause_update().await, None),
            (Command::Start | Command::Resume, None) => (self.service.update_status().await, Some(NO_LISTING.to_owned())),
            (Command::Start, Some(symbols)) => (self.service.start_update(symbols).await, None),
            (Command::Resume, Some(symbols)) => (self.service.resume_update(symbols).await, None),
        };
        Reply { v: VERSION, page, listing, refused }
    }
}

async fn read_request(stream: &mut UnixStream) -> Option<Request> {
    let mut line = String::new();
    let mut reader = BufReader::new(stream.take(MAX_REQUEST_BYTES));
    tokio::time::timeout(REQUEST_LIMIT, reader.read_line(&mut line)).await.ok()?.ok()?;
    serde_json::from_str(&line).ok().filter(|request: &Request| request.v == VERSION)
}

async fn connection(mut stream: UnixStream, control: Arc<Control>) {
    let Some(request) = read_request(&mut stream).await else { return };
    let reply = control.answer(request.command).await;
    let mut line = serde_json::to_string(&reply).expect("응답은 항상 JSON으로 바뀐다");
    line.push('\n');
    let _ = tokio::time::timeout(REQUEST_LIMIT, stream.write_all(line.as_bytes())).await;
}

pub async fn serve(socket: BoundSocket, control: Arc<Control>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        match socket.listener.accept().await {
            Ok((stream, _)) => {
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                let control = control.clone();
                tokio::spawn(async move {
                    connection(stream, control).await;
                    drop(permit);
                });
            }
            Err(error) => {
                tracing::warn!(%error, "재무 수집 소켓 연결을 받지 못했습니다");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
