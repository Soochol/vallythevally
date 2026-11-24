use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::mpsc::Receiver;

use rustix::process::{Signal, getppid, set_parent_process_death_signal};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use super::config::{Variables, process_variables};
use super::link::{ChildLink, Commands, Events, Incoming};
use super::output::{Output, Throughput};
use super::registry::Registry;
use super::session::{Finish, Halt, Session, SessionParts, SystemWallClock, Timings, Tokens, WallClock};
use super::start::{KIWOOM_WS_URL, exit_status, forward_termination_signals, init_logging};
use super::ws::{Connector, WebSocketConnector};
use crate::shared::flow::{self, FLOW_KINDS, FileFlowStore};
use crate::shared::minute::{self, FileMinuteStore, MinuteStore};
use crate::shared::quotes;
use crate::protocol::{Command, Event, HEARTBEAT_EVERY, KeyName, ProtocolError, SessionState, encode_line, parse_command};

pub const WS_URL_VARIABLE: &str = "VALLY_COLLECTOR_WS_URL";
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

pub struct ChildParts {
    pub key: KeyName,
    pub data_dir: PathBuf,
    pub connector: Arc<dyn Connector>,
    pub wall_clock: Arc<dyn WallClock>,
    pub timings: Timings,
    pub commands: Commands,
    pub events: Events,
    pub shutdown: watch::Receiver<bool>,
    pub minutes: Option<Box<dyn MinuteStore>>,
    pub flow: Option<FileFlowStore>,
    pub quotes: Option<PathBuf>,
}

pub async fn run_session(parts: ChildParts) -> Finish {
    let ChildParts { key, data_dir, connector, wall_clock, timings, commands, events, shutdown, minutes, flow, quotes } = parts;
    if let Err(error) = std::fs::create_dir_all(data_dir.join("raw")) {
        let halt = Halt::Output(error);
        events.halted(&halt.reason(), halt.action());
        return Finish::Halted(halt);
    }
    let output = Output::for_key(data_dir, key.clone());
    let (state, observed_state) = watch::channel(SessionState::WaitingForToken);
    let heartbeat = tokio::spawn(heartbeat(events.clone(), output.throughput(), observed_state));
    let (feed, worker) = match minutes {
        Some(store) => {
            let (feed, worker) = minute::spawn(store, wall_clock.now_ms());
            (Some(feed), Some(worker))
        }
        None => (None, None),
    };
    let (flow_feed, flow_worker) = match flow {
        Some(store) => {
            let (feed, worker) = flow::spawn(FLOW_KINDS, store, wall_clock.now_ms());
            (Some(feed), Some(worker))
        }
        None => (None, None),
    };
    let (quote_feed, quote_worker) = match quotes {
        Some(shared_dir) => {
            let (feed, worker) = quotes::spawn(shared_dir, key, wall_clock.now_ms());
            (Some(feed), Some(worker))
        }
        None => (None, None),
    };
    let session = Session::new(SessionParts {
        tokens: Tokens::supplied(),
        registry: Registry::default(),
        output,
        connector,
        wall_clock,
        timings,
        shutdown,
        child: Some(ChildLink { commands, events, state }),
        minutes: feed,
        flow: flow_feed,
        quotes: quote_feed,
    });
    let finish = session.run().await;
    if let Some(worker) = worker {
        worker.finish().await;
    }
    if let Some(worker) = flow_worker {
        worker.finish().await;
    }
    if let Some(worker) = quote_worker {
        worker.finish().await;
    }
    heartbeat.abort();
    let _ = heartbeat.await;
    finish
}

async fn heartbeat(events: Events, throughput: Arc<Throughput>, state: watch::Receiver<SessionState>) {
    let mut tick = interval_at(Instant::now() + HEARTBEAT_EVERY, HEARTBEAT_EVERY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let (frames, bytes) = throughput.take();
        events.heartbeat(frames, bytes, *state.borrow());
    }
}

pub fn write_events(events: Receiver<Event>, mut out: impl Write) {
    let mut broken = false;
    for event in events {
        if broken {
            continue;
        }
        if let Err(error) = out.write_all(encode_line(&event).as_bytes()).and_then(|()| out.flush()) {
            eprintln!("collect: 사건을 stdout에 쓰지 못했습니다: {error}");
            broken = true;
        }
    }
}

pub fn read_commands(input: impl BufRead, sink: &mpsc::UnboundedSender<Incoming>) {
    for line in input.lines() {
        let incoming = match line {
            Ok(line) => parse_command(&line),
            Err(_) => Err(ProtocolError::Unreadable),
        };
        let last = !matches!(&incoming, Ok(command) if *command != Command::Shutdown);
        if sink.send(incoming).is_err() || last {
            return;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentWatch {
    Armed,
    ParentGone,
}

pub fn die_with_parent() -> io::Result<ParentWatch> {
    let parent = getppid();
    set_parent_process_death_signal(Some(Signal::TERM))?;
    Ok(if getppid() == parent { ParentWatch::Armed } else { ParentWatch::ParentGone })
}

pub fn connector(variables: &Variables) -> Result<WebSocketConnector, String> {
    let Some(url) = variables.get(WS_URL_VARIABLE).filter(|url| !url.is_empty()) else {
        return Ok(WebSocketConnector::new(KIWOOM_WS_URL));
    };
    if is_loopback_ws(url) {
        Ok(WebSocketConnector::new(url.clone()))
    } else {
        Err(format!("{WS_URL_VARIABLE}는 ws://127.0.0.1, ws://localhost, ws://[::1] 주소만 받습니다. 토큰을 밖으로 보내지 않기 위해서입니다"))
    }
}

pub fn is_loopback_ws(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("ws://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains(['@', '\\']) {
        return false;
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(inside) => match inside.split_once(']') {
            Some((address, tail)) => (format!("[{address}]"), tail.strip_prefix(':')),
            None => return false,
        },
        None => match authority.split_once(':') {
            Some((host, port)) => (host.to_owned(), Some(port)),
            None => (authority.to_owned(), None),
        },
    };
    let port_ok = port.is_none_or(|port| !port.is_empty() && port.chars().all(|digit| digit.is_ascii_digit()));
    port_ok && LOOPBACK_HOSTS.contains(&host.as_str())
}

pub fn run(key: KeyName, data_dir: PathBuf, shared_dir: Option<PathBuf>) -> ExitCode {
    init_logging();
    match die_with_parent() {
        Ok(ParentWatch::Armed) => {}
        Ok(ParentWatch::ParentGone) => {
            eprintln!("collect: 데몬이 이미 끝났습니다. 시작하지 않고 끝납니다");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("collect: 부모 종료 신호를 걸지 못했습니다: {error}");
            return ExitCode::FAILURE;
        }
    }
    let connector = match connector(&process_variables()) {
        Ok(connector) => connector,
        Err(message) => {
            eprintln!("collect: {message}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("collect: 실행 환경을 만들지 못했습니다: {error}");
            return ExitCode::FAILURE;
        }
    };
    let (event_sink, event_source) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || write_events(event_source, io::stdout().lock()));
    let events = Events::to(event_sink);
    events.emit(Event::Hello { key: key.clone(), pid: std::process::id() });
    let (command_sink, commands) = mpsc::unbounded_channel();
    std::thread::spawn(move || read_commands(io::stdin().lock(), &command_sink));
    let (stop, shutdown) = watch::channel(false);
    let finish = runtime.block_on(async {
        tokio::spawn(forward_termination_signals(stop));
        let minutes = shared_dir.as_ref().map(|dir| Box::new(FileMinuteStore::new(dir.clone(), key.clone())) as Box<dyn MinuteStore>);
        let flow = shared_dir.as_ref().map(|dir| FileFlowStore::new(dir.clone(), key.clone()));
        run_session(ChildParts {
            key,
            data_dir,
            connector: Arc::new(connector),
            wall_clock: Arc::new(SystemWallClock),
            timings: Timings::default(),
            commands,
            events: events.clone(),
            shutdown,
            minutes,
            flow,
            quotes: shared_dir,
        })
        .await
    });
    drop(events);
    runtime.shutdown_background();
    let _ = writer.join();
    if let Finish::Halted(halt) = &finish {
        eprintln!("collect: 멈췄습니다. {}\n할 일: {}", halt.reason(), halt.action());
    }
    ExitCode::from(exit_status(&finish))
}
