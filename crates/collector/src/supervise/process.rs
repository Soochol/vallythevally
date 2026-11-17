use std::io;
use std::path::PathBuf;
use std::process::Stdio;

use rustix::process::{Pid, Signal, kill_process};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as OsCommand;
use tokio::sync::mpsc;

use crate::collect::config::Variables;
use crate::protocol::{Command, Event, KeyName, ProtocolError, encode_line, parse_event};

pub const FORWARDED_VARIABLES: [&str; 2] = ["VALLY_COLLECTOR_WS_URL", "RUST_LOG"];

#[derive(Debug)]
pub enum ChildMessage {
    Event(Event),
    BadLine(ProtocolError),
    Exited(Option<i32>),
}

pub trait ChildProcess: Send {
    fn send(&mut self, command: &Command);
    fn terminate(&mut self);
    fn kill(&mut self);
}

pub struct Spawned {
    pub pid: Option<u32>,
    pub process: Box<dyn ChildProcess>,
    pub messages: mpsc::UnboundedReceiver<ChildMessage>,
}

pub trait Launcher: Send + Sync + 'static {
    fn launch(&self, key: &KeyName) -> io::Result<Spawned>;
}

pub struct TokioLauncher {
    executable: PathBuf,
    data_dir: PathBuf,
    forwarded: Vec<(String, String)>,
}

impl TokioLauncher {
    pub fn new(executable: PathBuf, data_dir: PathBuf, process: &Variables) -> TokioLauncher {
        let forwarded = FORWARDED_VARIABLES.iter().filter_map(|name| process.get(*name).map(|value| ((*name).to_owned(), value.clone()))).collect();
        TokioLauncher { executable, data_dir, forwarded }
    }
}

#[derive(Debug, Clone, Copy)]
enum Signalled {
    Terminate,
    Kill,
}

struct TokioChild {
    lines: mpsc::UnboundedSender<String>,
    signals: mpsc::UnboundedSender<Signalled>,
}

impl ChildProcess for TokioChild {
    fn send(&mut self, command: &Command) {
        let _ = self.lines.send(encode_line(command));
    }

    fn terminate(&mut self) {
        let _ = self.signals.send(Signalled::Terminate);
    }

    fn kill(&mut self) {
        let _ = self.signals.send(Signalled::Kill);
    }
}

impl Launcher for TokioLauncher {
    fn launch(&self, key: &KeyName) -> io::Result<Spawned> {
        let mut child = OsCommand::new(&self.executable)
            .args(["collect", "--child", "--key", key.as_str(), "--data"])
            .arg(&self.data_dir)
            .env_clear()
            .envs(self.forwarded.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let pid = child.id();
        let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            return Err(io::Error::other("자식의 stdin, stdout, stderr를 얻지 못했습니다"));
        };
        let (messages_sink, messages) = mpsc::unbounded_channel();
        let (lines, mut pending_lines) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = pending_lines.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    return;
                }
            }
        });
        let stdout_sink = messages_sink.clone();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let message = match parse_event(&line) {
                    Ok(event) => ChildMessage::Event(event),
                    Err(error) => ChildMessage::BadLine(error),
                };
                if stdout_sink.send(message).is_err() {
                    return;
                }
            }
        });
        let name = key.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(key = %name, "자식: {line}");
            }
        });
        let (signals, mut pending_signals) = mpsc::unbounded_channel::<Signalled>();
        tokio::spawn(async move {
            let status = loop {
                tokio::select! {
                    status = child.wait() => break status,
                    Some(signal) = pending_signals.recv() => match signal {
                        Signalled::Terminate => {
                            if let Some(pid) = pid.and_then(|pid| Pid::from_raw(pid as i32)) {
                                let _ = kill_process(pid, Signal::TERM);
                            }
                        }
                        Signalled::Kill => {
                            let _ = child.start_kill();
                        }
                    },
                }
            };
            let _ = reader.await;
            let _ = messages_sink.send(ChildMessage::Exited(status.ok().and_then(|status| status.code())));
        });
        Ok(Spawned { pid, process: Box::new(TokioChild { lines, signals }), messages })
    }
}
