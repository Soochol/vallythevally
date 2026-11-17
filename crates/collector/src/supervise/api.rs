use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use server::clock::Clock;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Mutex, Semaphore, mpsc, watch};
use tokio::time::{Instant, Interval, interval_at, timeout};

use super::files::{read_coverage, read_disk};
use super::journal::kst_stamp;
use super::status::{DaemonStatus, DayPhase};
use super::wire::{ErrorCode, MAX_REQUEST_BYTES, Reply, ReplyBody, RequestKind, parse_request};

pub const SOCKET_FILE_NAME: &str = "supervise.sock";
pub const OUTBOX_LINES: usize = 64;
pub const MAX_CONNECTIONS: usize = 16;
const FILE_VIEW_TTL: Duration = Duration::from_secs(30);
const SOCKET_MODE: u32 = 0o600;
const FOLDER_MODE: u32 = 0o700;

pub struct StatusSocket {
    listener: UnixListener,
    path: PathBuf,
}

impl StatusSocket {
    pub fn bind(path: &Path) -> io::Result<StatusSocket> {
        if let Some(folder) = path.parent().filter(|folder| !folder.as_os_str().is_empty()) {
            fs::DirBuilder::new().recursive(true).mode(FOLDER_MODE).create(folder)?;
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path)?,
            Ok(_) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{}에 소켓이 아닌 파일이 있습니다", path.display()))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_MODE))?;
        Ok(StatusSocket { listener, path: path.to_owned() })
    }
}

struct CachedView<T> {
    slot: Mutex<Option<(Instant, Arc<T>)>>,
}

impl<T: Send + Sync + 'static> CachedView<T> {
    fn new() -> CachedView<T> {
        CachedView { slot: Mutex::new(None) }
    }

    async fn get(&self, read: impl FnOnce() -> T + Send + 'static) -> Arc<T> {
        let mut slot = self.slot.lock().await;
        if let Some((_, value)) = slot.as_ref().filter(|(read_at, _)| read_at.elapsed() < FILE_VIEW_TTL) {
            return value.clone();
        }
        let value = Arc::new(tokio::task::spawn_blocking(read).await.expect("파일 읽기 작업이 멈추지 않는다"));
        *slot = Some((Instant::now(), value.clone()));
        value
    }
}

pub struct StatusApi {
    pub status: watch::Receiver<DaemonStatus>,
    pub data_dir: PathBuf,
    pub clock: Clock,
    pub watch_every: Duration,
}

struct Shared {
    api: StatusApi,
    coverage: CachedView<Vec<super::wire::CoverageDay>>,
    disk: CachedView<super::wire::DiskUsage>,
    slots: Arc<Semaphore>,
}

impl Shared {
    fn sent_at(&self) -> String {
        kst_stamp(self.api.clock.now())
    }

    fn status_reply(&self) -> Reply {
        Reply::new(ReplyBody::Status { sent_at: self.sent_at(), status: self.api.status.borrow().clone() })
    }

    async fn answer(&self, kind: RequestKind) -> Reply {
        match kind {
            RequestKind::Status | RequestKind::Watch => self.status_reply(),
            RequestKind::Coverage => {
                let data_dir = self.api.data_dir.clone();
                let days = self.coverage.get(move || read_coverage(&data_dir)).await;
                Reply::new(ReplyBody::Coverage { sent_at: self.sent_at(), days: days.as_ref().clone() })
            }
            RequestKind::Disk => {
                let data_dir = self.api.data_dir.clone();
                let disk = self.disk.get(move || read_disk(&data_dir)).await;
                Reply::new(ReplyBody::Disk { sent_at: self.sent_at(), disk: disk.as_ref().clone() })
            }
        }
    }
}

pub async fn serve(socket: StatusSocket, api: StatusApi, mut shutdown: watch::Receiver<bool>) {
    let shared = Arc::new(Shared { api, coverage: CachedView::new(), disk: CachedView::new(), slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)) });
    let StatusSocket { listener, path } = socket;
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let shared = shared.clone();
                    let shutdown = shutdown.clone();
                    connections.spawn(connection(stream, shared, shutdown));
                }
                Err(error) => {
                    tracing::warn!(%error, "상태 소켓 연결을 받지 못했습니다");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            },
        }
        if *shutdown.borrow() {
            break;
        }
    }
    connections.shutdown().await;
    drop(listener);
    let _ = fs::remove_file(&path);
}

async fn connection(stream: UnixStream, shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    let (reader, writer) = stream.into_split();
    let (outbox, lines) = mpsc::channel::<String>(OUTBOX_LINES);
    let writer = tokio::spawn(write_lines(writer, lines));
    let Ok(_slot) = shared.slots.clone().try_acquire_owned() else {
        let _ = outbox.try_send(Reply::error(ErrorCode::TooManyConnections, "연결이 너무 많습니다").to_line());
        drop(outbox);
        let _ = timeout(Duration::from_secs(1), writer).await;
        return;
    };
    let ended = converse(reader, &outbox, &shared, &mut shutdown).await;
    drop(outbox);
    match ended {
        Ended::Overflow => writer.abort(),
        Ended::Peer => {
            let _ = timeout(Duration::from_secs(2), writer).await;
        }
    }
}

async fn write_lines(mut writer: OwnedWriteHalf, mut lines: mpsc::Receiver<String>) {
    while let Some(line) = lines.recv().await {
        if writer.write_all(line.as_bytes()).await.is_err() {
            return;
        }
    }
    let _ = writer.shutdown().await;
}

enum Line {
    Text(String),
    TooLong,
    Closed,
}

async fn read_line_limited(reader: &mut BufReader<impl AsyncRead + Unpin>) -> Line {
    let mut bytes = Vec::new();
    loop {
        let Ok(chunk) = reader.fill_buf().await else { return Line::Closed };
        if chunk.is_empty() {
            return Line::Closed;
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(chunk.len(), |at| at + 1);
        bytes.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        if newline.is_some() {
            bytes.pop();
            return Line::Text(String::from_utf8_lossy(&bytes).into_owned());
        }
        if bytes.len() > MAX_REQUEST_BYTES {
            return Line::TooLong;
        }
    }
}

fn push(outbox: &mpsc::Sender<String>, reply: &Reply) -> bool {
    outbox.try_send(reply.to_line()).is_ok()
}

enum Ended {
    Peer,
    Overflow,
}

async fn converse(reader: impl AsyncRead + Unpin, outbox: &mpsc::Sender<String>, shared: &Shared, shutdown: &mut watch::Receiver<bool>) -> Ended {
    let mut reader = BufReader::new(reader);
    let mut ticker: Option<Interval> = None;
    let mut sequence = 0_u64;
    let mut last_phase = DayPhase::default();
    let mut status = shared.api.status.clone();
    loop {
        let watching = ticker.is_some();
        let tick = async {
            match &mut ticker {
                Some(ticker) => ticker.tick().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            _ = shutdown.changed() => return Ended::Peer,
            _ = tick => {
                sequence += 1;
                last_phase = shared.api.status.borrow().phase;
                let heartbeat = Reply::new(ReplyBody::Heartbeat { sent_at: shared.sent_at(), sequence, phase: last_phase });
                if !(push(outbox, &shared.status_reply()) && push(outbox, &heartbeat)) {
                    return Ended::Overflow;
                }
            }
            changed = status.changed(), if watching => {
                if changed.is_err() {
                    return Ended::Peer;
                }
                let phase = status.borrow_and_update().phase;
                if phase != last_phase {
                    last_phase = phase;
                    if !push(outbox, &shared.status_reply()) {
                        return Ended::Overflow;
                    }
                }
            }
            line = read_line_limited(&mut reader) => match line {
                Line::Closed => return Ended::Peer,
                Line::TooLong => {
                    push(outbox, &Reply::error(ErrorCode::BadRequest, format!("요청 한 줄은 {MAX_REQUEST_BYTES}바이트까지입니다")));
                    return Ended::Peer;
                }
                Line::Text(text) => {
                    let reply = match parse_request(&text) {
                        Ok(request) => {
                            if request.kind == RequestKind::Watch && !watching {
                                let every = shared.api.watch_every;
                                ticker = Some(interval_at(Instant::now() + every, every));
                                last_phase = shared.api.status.borrow().phase;
                                status.borrow_and_update();
                            }
                            shared.answer(request.kind).await
                        }
                        Err(refusal) => refusal.into_reply(),
                    };
                    if !push(outbox, &reply) {
                        return Ended::Overflow;
                    }
                }
            },
        }
    }
}
