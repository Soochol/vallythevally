use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use server::clock::Clock;
use server::instance::{InstanceLock, LockError};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant, Interval, interval_at, sleep_until, timeout, timeout_at};

use super::files::{read_coverage, read_disk};
use super::journal::kst_stamp;
use super::status::{DaemonStatus, DayPhase};
use super::wire::{ErrorCode, MAX_REQUEST_BYTES, Reply, ReplyBody, RequestKind, parse_request};

pub const SOCKET_FILE_NAME: &str = "supervise.sock";
pub const OUTBOX_LINES: usize = 64;
pub const MAX_CONNECTIONS: usize = 16;
const MAX_PENDING_REPLIES: usize = 4;
const MAX_HELD_FILE_REQUESTS: usize = 16;
const FIRST_REQUEST_LIMIT: Duration = Duration::from_secs(30);
const LOCK_FILE_SUFFIX: &str = ".lock";
const DRAIN_LIMIT: Duration = Duration::from_secs(30);
const PARTIAL_LINE_LIMIT: Duration = Duration::from_secs(10);
const WRITE_STALL_LIMIT: Duration = Duration::from_secs(5);
const FILE_VIEW_TTL: Duration = Duration::from_secs(30);
const SOCKET_MODE: u32 = 0o600;
const FOLDER_MODE: u32 = 0o700;

fn socket_is_alive(path: &Path) -> io::Result<bool> {
    let socket = rustix::net::socket_with(rustix::net::AddressFamily::UNIX, rustix::net::SocketType::STREAM, rustix::net::SocketFlags::NONBLOCK | rustix::net::SocketFlags::CLOEXEC, None)?;
    let address = rustix::net::SocketAddrUnix::new(path)?;
    match rustix::net::connect(&socket, &address) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INPROGRESS) => Ok(true),
        Err(rustix::io::Errno::CONNREFUSED | rustix::io::Errno::NOENT) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub struct StatusSocket {
    listener: UnixListener,
    path: PathBuf,
    _lock: InstanceLock,
}

fn lock_path_of(socket: &Path) -> PathBuf {
    let mut name = socket.file_name().map_or_else(OsString::new, OsString::from);
    name.push(LOCK_FILE_SUFFIX);
    socket.with_file_name(name)
}

impl StatusSocket {
    pub fn bind(path: &Path) -> io::Result<StatusSocket> {
        if let Some(folder) = path.parent().filter(|folder| !folder.as_os_str().is_empty()) {
            fs::DirBuilder::new().recursive(true).mode(FOLDER_MODE).create(folder)?;
        }
        let lock = match InstanceLock::acquire(&lock_path_of(path)) {
            Ok(lock) => lock,
            Err(LockError::Held { .. }) => return Err(io::Error::new(io::ErrorKind::AddrInUse, format!("{}를 쓰는 다른 데몬이 이미 떠 있습니다", path.display()))),
            Err(LockError::Io { error, .. }) => return Err(error),
        };
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => {
                if socket_is_alive(path)? {
                    return Err(io::Error::new(io::ErrorKind::AddrInUse, format!("{}를 쓰는 다른 데몬이 이미 떠 있습니다", path.display())));
                }
                fs::remove_file(path)?
            }
            Ok(_) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{}에 소켓이 아닌 파일이 있습니다", path.display()))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_MODE))?;
        Ok(StatusSocket { listener, path: path.to_owned(), _lock: lock })
    }
}

enum Slot<T> {
    Empty,
    Reading(watch::Receiver<Option<Arc<T>>>),
    Fresh(Instant, Arc<T>),
}

struct CachedView<T> {
    slot: Arc<StdMutex<Slot<T>>>,
}

impl<T: Send + Sync + 'static> CachedView<T> {
    fn new() -> CachedView<T> {
        CachedView { slot: Arc::new(StdMutex::new(Slot::Empty)) }
    }

    async fn get(&self, read: impl FnOnce() -> (T, bool) + Send + 'static) -> Arc<T> {
        let mut answer = {
            let mut slot = self.slot.lock().expect("읽기 상태를 잡은 채 멈춘 곳은 없다");
            match &*slot {
                Slot::Fresh(read_at, value) if read_at.elapsed() < FILE_VIEW_TTL => return value.clone(),
                Slot::Reading(answer) => answer.clone(),
                _ => {
                    let (sender, answer) = watch::channel(None);
                    *slot = Slot::Reading(answer.clone());
                    let slot = self.slot.clone();
                    tokio::spawn(async move {
                        let finished = tokio::task::spawn_blocking(read).await;
                        let mut slot = slot.lock().expect("읽기 상태를 잡은 채 멈춘 곳은 없다");
                        let Ok((value, settled)) = finished else {
                            *slot = Slot::Empty;
                            return;
                        };
                        let value = Arc::new(value);
                        *slot = if settled { Slot::Fresh(Instant::now(), value.clone()) } else { Slot::Empty };
                        let _ = sender.send(Some(value));
                    });
                    answer
                }
            }
        };
        let value = answer.wait_for(Option::is_some).await.expect("파일 읽기 작업이 멈추지 않는다").clone();
        value.expect("기다린 값이 있다")
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
                let days = self
                    .coverage
                    .get(move || {
                        let coverage = read_coverage(&data_dir);
                        (coverage.days, coverage.settled)
                    })
                    .await;
                Reply::new(ReplyBody::Coverage { sent_at: self.sent_at(), days: days.as_ref().clone() })
            }
            RequestKind::Disk => {
                let data_dir = self.api.data_dir.clone();
                let disk = self.disk.get(move || (read_disk(&data_dir), true)).await;
                Reply::new(ReplyBody::Disk { sent_at: self.sent_at(), disk: disk.as_ref().clone() })
            }
        }
    }
}

pub async fn serve(socket: StatusSocket, api: StatusApi, mut shutdown: watch::Receiver<bool>) {
    let shared = Arc::new(Shared { api, coverage: CachedView::new(), disk: CachedView::new(), slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)) });
    let StatusSocket { listener, path, _lock } = socket;
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
    let mut writer = tokio::spawn(write_lines(writer, lines));
    let Ok(_slot) = shared.slots.clone().try_acquire_owned() else {
        let _ = outbox.try_send(Reply::error(ErrorCode::TooManyConnections, "연결이 너무 많습니다").to_line());
        drop(outbox);
        if timeout(Duration::from_secs(1), &mut writer).await.is_err() {
            writer.abort();
        }
        return;
    };
    let ended = converse(reader, &outbox, &shared, &mut shutdown).await;
    drop(outbox);
    match ended {
        Ended::Overflow => writer.abort(),
        Ended::Peer => {
            if timeout(Duration::from_secs(2), &mut writer).await.is_err() {
                writer.abort();
            }
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
    Stalled,
    Closed,
}

async fn read_line_limited(reader: &mut BufReader<impl AsyncRead + Unpin>, pending: &mut Vec<u8>, started_at: &mut Option<Instant>) -> Line {
    loop {
        let filled = match *started_at {
            Some(started_at) => match timeout_at(started_at + PARTIAL_LINE_LIMIT, reader.fill_buf()).await {
                Ok(filled) => filled,
                Err(_) => return Line::Stalled,
            },
            None => reader.fill_buf().await,
        };
        let Ok(chunk) = filled else { return Line::Closed };
        if chunk.is_empty() {
            return Line::Closed;
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(chunk.len(), |at| at + 1);
        pending.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        let length = pending.len() - usize::from(newline.is_some());
        if length > MAX_REQUEST_BYTES {
            return Line::TooLong;
        }
        if newline.is_some() {
            pending.pop();
            *started_at = None;
            return Line::Text(String::from_utf8_lossy(&std::mem::take(pending)).into_owned());
        }
        started_at.get_or_insert_with(Instant::now);
    }
}

async fn push(outbox: &mpsc::Sender<String>, reply: &Reply) -> bool {
    matches!(timeout(WRITE_STALL_LIMIT, outbox.send(reply.to_line())).await, Ok(Ok(())))
}

fn spawn_file_reply(replies: &mut JoinSet<bool>, shared: &Arc<Shared>, outbox: &mpsc::Sender<String>, kind: RequestKind) {
    let (shared, outbox) = (shared.clone(), outbox.clone());
    replies.spawn(async move {
        let reply = shared.answer(kind).await;
        push(&outbox, &reply).await
    });
}

enum Ended {
    Peer,
    Overflow,
}

async fn converse(reader: impl AsyncRead + Unpin, outbox: &mpsc::Sender<String>, shared: &Arc<Shared>, shutdown: &mut watch::Receiver<bool>) -> Ended {
    let mut reader = BufReader::new(reader);
    let mut pending = Vec::new();
    let mut line_started_at = None;
    let mut replies = JoinSet::new();
    let mut held_file_requests: VecDeque<RequestKind> = VecDeque::new();
    let connected_at = Instant::now();
    let mut asked = false;
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
        let idle = sleep_until(connected_at + FIRST_REQUEST_LIMIT);
        tokio::select! {
            biased;
            _ = shutdown.changed() => return Ended::Peer,
            Some(finished) = replies.join_next(), if !replies.is_empty() => {
                if matches!(finished, Ok(false)) {
                    return Ended::Overflow;
                }
                if let Some(kind) = held_file_requests.pop_front() {
                    spawn_file_reply(&mut replies, shared, outbox, kind);
                }
            }
            _ = idle, if !asked && line_started_at.is_none() => {
                push(outbox, &Reply::error(ErrorCode::BadRequest, format!("요청이 {}초 동안 오지 않아 연결을 닫습니다", FIRST_REQUEST_LIMIT.as_secs()))).await;
                return Ended::Peer;
            }
            _ = tick => {
                sequence += 1;
                last_phase = shared.api.status.borrow().phase;
                let heartbeat = Reply::new(ReplyBody::Heartbeat { sent_at: shared.sent_at(), sequence, phase: last_phase });
                if !(push(outbox, &shared.status_reply()).await && push(outbox, &heartbeat).await) {
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
                    if !push(outbox, &shared.status_reply()).await {
                        return Ended::Overflow;
                    }
                }
            }
            line = read_line_limited(&mut reader, &mut pending, &mut line_started_at), if held_file_requests.len() < MAX_HELD_FILE_REQUESTS => match line {
                Line::Closed => {
                    let drained = timeout(DRAIN_LIMIT, async {
                        let mut sent_all = true;
                        while let Some(finished) = replies.join_next().await {
                            sent_all &= matches!(finished, Ok(true));
                            if let Some(kind) = held_file_requests.pop_front() {
                                spawn_file_reply(&mut replies, shared, outbox, kind);
                            }
                        }
                        sent_all
                    })
                    .await;
                    return if drained == Ok(false) { Ended::Overflow } else { Ended::Peer };
                }
                Line::TooLong => {
                    push(outbox, &Reply::error(ErrorCode::BadRequest, format!("요청 한 줄은 {MAX_REQUEST_BYTES}바이트까지입니다"))).await;
                    return Ended::Peer;
                }
                Line::Stalled => {
                    push(outbox, &Reply::error(ErrorCode::BadRequest, format!("요청 한 줄이 {}초 안에 끝나지 않았습니다", PARTIAL_LINE_LIMIT.as_secs()))).await;
                    return Ended::Peer;
                }
                Line::Text(text) => {
                    asked = true;
                    let reply = match parse_request(&text) {
                        Ok(request) => {
                            if request.kind == RequestKind::Watch && !watching {
                                let every = shared.api.watch_every;
                                ticker = Some(interval_at(Instant::now() + every, every));
                                last_phase = shared.api.status.borrow().phase;
                                status.borrow_and_update();
                            }
                            if matches!(request.kind, RequestKind::Coverage | RequestKind::Disk) {
                                if replies.len() < MAX_PENDING_REPLIES {
                                    spawn_file_reply(&mut replies, shared, outbox, request.kind);
                                } else {
                                    held_file_requests.push_back(request.kind);
                                }
                                continue;
                            }
                            shared.answer(request.kind).await
                        }
                        Err(refusal) => refusal.into_reply(),
                    };
                    if !push(outbox, &reply).await {
                        return Ended::Overflow;
                    }
                }
            },
        }
    }
}
