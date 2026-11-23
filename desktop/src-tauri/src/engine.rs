use crate::environment::Environment;
use crate::lifetime::ParentBond;
use crate::loopback::LoopbackAddr;
use crate::tail::LogTail;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL: Duration = Duration::from_millis(100);
const ALIVE_POLL: Duration = Duration::from_millis(500);
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const TERMINATE_GRACE: Duration = Duration::from_secs(10);
const TERMINATE_POLL: Duration = Duration::from_millis(50);
const FAILURE_LOG_LINES: usize = 12;
const READY_PROBE_PATH: &str = "/api/server-mode";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum EngineStatus {
    Starting,
    Ready { url: String },
    Failed { reason: String, log: Vec<String> },
}

#[derive(Clone)]
pub struct StatusCell(Arc<Mutex<EngineStatus>>);

impl StatusCell {
    pub fn starting() -> Self {
        StatusCell(Arc::new(Mutex::new(EngineStatus::Starting)))
    }

    pub fn get(&self) -> EngineStatus {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    pub fn set(&self, status: EngineStatus) {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = status;
    }

    pub fn fail(&self, reason: impl Into<String>, tail: &LogTail) {
        self.set(EngineStatus::Failed { reason: reason.into(), log: tail.last(FAILURE_LOG_LINES) });
    }
}

pub struct EngineSpec {
    pub binary: PathBuf,
    pub working_dir: PathBuf,
    pub environment: Environment,
}

pub struct Engine {
    child: Arc<Mutex<Child>>,
    stopping: Arc<AtomicBool>,
    _bond: ParentBond,
}

impl Engine {
    pub fn spawn_from_process_lifetime_thread(spec: &EngineSpec, tail: &LogTail) -> std::io::Result<Engine> {
        let bond = ParentBond::new()?;
        let mut command = Command::new(&spec.binary);
        command.env_clear().envs(&spec.environment).current_dir(&spec.working_dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        bond.prepare(&mut command);
        let mut child = command.spawn()?;
        if let Err(error) = bond.attach(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        if let Some(stdout) = child.stdout.take() {
            tail.drain_in_background(stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            tail.drain_in_background(stderr);
        }
        Ok(Engine { child: Arc::new(Mutex::new(child)), stopping: Arc::new(AtomicBool::new(false)), _bond: bond })
    }

    pub fn supervise(&self, address: LoopbackAddr, status: StatusCell, tail: LogTail, on_lost_after_ready: impl FnOnce() + Send + 'static) {
        let child = self.child.clone();
        let stopping = self.stopping.clone();
        std::thread::spawn(move || {
            let exited = || try_wait(&child);
            let started = Instant::now();
            loop {
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(exit) = exited() {
                    status.fail(format!("엔진이 응답하기 전에 끝났습니다({exit})"), &tail);
                    return;
                }
                if answers(address) {
                    break;
                }
                if started.elapsed() > READY_TIMEOUT {
                    status.fail(format!("엔진이 {}초 안에 응답하지 않았습니다", READY_TIMEOUT.as_secs()), &tail);
                    stopping.store(true, Ordering::SeqCst);
                    terminate(&child, Duration::ZERO);
                    return;
                }
                std::thread::sleep(READY_POLL);
            }
            status.set(EngineStatus::Ready { url: address.url() });
            loop {
                std::thread::sleep(ALIVE_POLL);
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(exit) = exited() {
                    status.fail(format!("엔진이 실행 중에 끝났습니다({exit})"), &tail);
                    on_lost_after_ready();
                    return;
                }
            }
        });
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        terminate(&self.child, TERMINATE_GRACE);
    }
}

fn try_wait(child: &Mutex<Child>) -> Option<ExitStatus> {
    child.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).try_wait().ok().flatten()
}

fn terminate(child: &Mutex<Child>, grace: Duration) {
    let mut child = child.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    ask_to_end(&child);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(TERMINATE_POLL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn ask_to_end(child: &Child) {
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn ask_to_end(_child: &Child) {}

fn answers(address: LoopbackAddr) -> bool {
    let addr = address.socket_addr();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else { return false };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
    let request = format!("GET {READY_PROBE_PATH} HTTP/1.0\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).is_ok() && is_ok_status_line(&head)
}

fn is_ok_status_line(head: &[u8]) -> bool {
    head == b"HTTP/1.1 200" || head == b"HTTP/1.0 200"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn serve_once(response: &'static [u8]) -> LoopbackAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = LoopbackAddr::at_port(listener.local_addr().unwrap().port());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            stream.write_all(response).unwrap();
        });
        address
    }

    #[test]
    fn an_engine_that_answers_200_on_the_probe_route_is_ready() {
        assert!(answers(serve_once(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}")));
    }

    #[test]
    fn an_engine_that_answers_with_an_error_is_not_ready() {
        assert!(!answers(serve_once(b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n")));
    }

    #[test]
    fn nothing_listening_is_not_ready() {
        let address = LoopbackAddr::reserve_free_port().unwrap();
        assert!(!answers(address));
    }

    #[cfg(unix)]
    fn script_engine(body: &str) -> (Engine, LogTail, StatusCell, LoopbackAddr) {
        let tail = LogTail::default();
        let bond = ParentBond::new().unwrap();
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(body).env_clear().env("PATH", "/usr/bin:/bin").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        bond.prepare(&mut command);
        let mut child = command.spawn().unwrap();
        tail.drain_in_background(child.stdout.take().unwrap());
        tail.drain_in_background(child.stderr.take().unwrap());
        let engine = Engine { child: Arc::new(Mutex::new(child)), stopping: Arc::new(AtomicBool::new(false)), _bond: bond };
        (engine, tail, StatusCell::starting(), LoopbackAddr::reserve_free_port().unwrap())
    }

    #[cfg(unix)]
    fn wait_for(status: &StatusCell, done: impl Fn(&EngineStatus) -> bool) -> EngineStatus {
        for _ in 0..200 {
            let current = status.get();
            if done(&current) {
                return current;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        status.get()
    }

    #[cfg(unix)]
    #[test]
    fn an_engine_that_dies_at_startup_fails_with_its_last_log_lines() {
        let (engine, tail, status, address) = script_engine("echo 'boom: cannot open database' >&2; exit 3");
        engine.supervise(address, status.clone(), tail, || {});
        let EngineStatus::Failed { reason, log } = wait_for(&status, |s| matches!(s, EngineStatus::Failed { .. })) else { panic!("expected a failure") };
        assert!(reason.contains("끝났습니다"), "{reason}");
        assert!(reason.contains('3'), "{reason}");
        assert_eq!(log, vec!["boom: cannot open database".to_owned()]);
    }

    #[cfg(unix)]
    #[test]
    fn stopping_ends_a_running_engine_and_waits_for_it() {
        let (engine, _tail, _status, _address) = script_engine("exec sleep 30");
        let pid = engine.child.lock().unwrap().id();
        engine.stop();
        assert!(try_wait(&engine.child).is_some());
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    }
}
