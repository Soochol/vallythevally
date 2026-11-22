#![allow(dead_code, unused_imports)]

#[path = "../support/mod.rs"]
pub mod support;
pub use support::{APP_KEY, APP_SECRET, ScriptedTransport, TOKEN};

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::io::Write;
use server::kiwoom::link::{ConnectStep, LinkState};
use tokio::sync::watch;
use tracing_subscriber::prelude::*;

pub fn token_path(lock: &Path) -> PathBuf { lock.with_file_name("token.json") }

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

struct Control {
    link: server::kiwoom::link::Link,
    runtime: tokio::runtime::Handle,
    clock: server::clock::Clock,
}

pub struct Server {
    control: Arc<std::sync::OnceLock<Control>>,
    thread: Option<std::thread::JoinHandle<()>>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    address: watch::Receiver<Option<SocketAddr>>,
    output: Captured,
    pub events: tokio::sync::mpsc::Sender<server::kiwoom::stream::StreamEvent>,
}

impl Server {
    pub fn spawn(transport: &ScriptedTransport, lock: &Path, static_dir: &Path) -> Self {
        Self::spawn_with(transport, lock, static_dir, &[])
    }

    pub fn spawn_with(transport: &ScriptedTransport, lock: &Path, static_dir: &Path, overrides: &[(&str, &std::ffi::OsStr)]) -> Self {
        let output = Captured::default();
        let writer = output.clone();
        let transport = transport.clone();
        let lock = lock.to_owned();
        let static_dir = static_dir.to_owned();
        let overrides: std::collections::HashMap<String, String> = overrides.iter().map(|(key, value)| ((*key).into(), value.to_str().unwrap().into())).collect();
        let (address, receiver) = watch::channel(None);
        let (events, stream_events) = tokio::sync::mpsc::channel(16);
        let control = Arc::new(std::sync::OnceLock::new());
        let publish = control.clone();
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let subscriber = tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(move || writer.clone()).with_filter(tracing_subscriber::EnvFilter::new("server=trace")));
            let _guard = tracing::subscriber::set_default(subscriber);
            let runtime = match overrides.get("SERVER_RUNTIME_THREADS") {
                Some(threads) => tokio::runtime::Builder::new_multi_thread().worker_threads(threads.parse().unwrap()).enable_all().build().unwrap(),
                None => tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap(),
            };
            runtime.block_on(async move {
                tokio::select! {
                    _ = stopped => {},
                    _ = async move {
            let value = |key: &str| overrides.get(key).map(String::as_str);
            let config = harness_config(&overrides, &lock, &static_dir);
            let instance = server::instance::InstanceLock::acquire(&lock).unwrap();
            let millis = |key: &str| std::time::Duration::from_millis(value(key).map_or(1, |millis| millis.parse().unwrap()));
            let stream = if value("VALLY_KIWOOM_WS_URL").is_some() { server::app::StreamSource::Connect } else { server::app::StreamSource::Detached(stream_events) };
            let adapters = server::app::Adapters { kiwoom: transport.transport(), stream, kiwoom_spacing: Some(millis("KIWOOM_SEND_SPACING_MILLIS")), dart_spacing: Some(millis("DART_SPACING_MILLIS")) };
            let started = server::app::start(&config, &instance, adapters).await.unwrap();
            let state = started.state.clone();
            let mut background = tokio::task::JoinSet::new();
            publish.set(Control { link: state.link.clone(), runtime: tokio::runtime::Handle::current(), clock: state.clock.clone() }).ok();
            if value("VALLY_KIWOOM_CONNECT") == Some("start") {
                state.keys.connect_at_start();
            } else if value("VALLY_KIWOOM_CONNECT") != Some("off") {
                let link = state.link.clone();
                background.spawn(async move { link.connect(false).await; });
                state.link.subscribe().wait_for(|state| matches!(state, LinkState::NoKey | LinkState::Connected | LinkState::Failed(_) | LinkState::Connecting(ConnectStep::IssueInterval(_) | ConnectStep::Symbols | ConnectStep::Realtime))).await.unwrap();
            }
            address.send_replace(Some(started.listener.local_addr().unwrap()));
            let automatic = started.automatic.map(AbortOnDrop);
            let listener = started.listener;
            let app = started.router;
            axum::serve(listener, app).await.unwrap();
            drop(automatic);
                    } => {},
                }
            });
        });
        Self { control, thread: Some(thread), shutdown: Some(shutdown), address: receiver, output, events }
    }

    pub fn link_state(&self) -> LinkState { self.control.get().expect("서버가 아직 준비되지 않았습니다").link.state() }

    pub async fn connect(&self, acknowledged: bool) -> LinkState {
        let control = self.control.get().expect("서버가 아직 준비되지 않았습니다");
        let link = control.link.clone();
        control.runtime.spawn(async move { link.connect(acknowledged).await }).await.unwrap()
    }

    pub async fn connect_until_waiting(&self, acknowledged: bool) -> LinkState {
        let control = self.control.get().expect("서버가 아직 준비되지 않았습니다");
        let link = control.link.clone();
        control.runtime.spawn(async move { link.connect_until_waiting(acknowledged).await }).await.unwrap()
    }

    pub async fn wait_for_state(&self, wanted: fn(&LinkState) -> bool) -> LinkState {
        let control = self.control.get().expect("서버가 아직 준비되지 않았습니다");
        let mut state = control.link.subscribe();
        control.runtime.spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(10), async { state.wait_for(wanted).await.unwrap().clone() }).await.expect("기다리던 연결 상태가 오지 않았다")
        }).await.unwrap()
    }

    pub fn clock(&self) -> server::clock::Clock { self.control.get().expect("서버가 아직 준비되지 않았습니다").clock.clone() }

    pub fn link(&self) -> server::kiwoom::link::Link { self.control.get().expect("서버가 아직 준비되지 않았습니다").link.clone() }

    pub fn logs(&self) -> String { String::from_utf8(self.output.0.lock().unwrap().clone()).unwrap() }

    pub async fn addr(&self) -> SocketAddr {
        let mut address = self.address.clone();
        loop {
            if let Some(address) = *address.borrow() { return address; }
            address.changed().await.unwrap_or_else(|_| panic!("application initialization failed: {}", self.logs()));
        }
    }

    pub async fn stop(mut self) -> String {
        if let Some(shutdown) = self.shutdown.take() { let _ = shutdown.send(()); }
        if let Some(thread) = self.thread.take() { tokio::task::spawn_blocking(move || thread.join().unwrap()).await.unwrap(); }
        self.logs()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() { let _ = shutdown.send(()); }
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

const HARNESS_ONLY: [&str; 5] = ["KIWOOM_SEND_SPACING_MILLIS", "DART_SPACING_MILLIS", "SERVER_RUNTIME_THREADS", "SERVER_BIND_IP", "VALLY_KIWOOM_CONNECT"];

fn harness_config(overrides: &std::collections::HashMap<String, String>, lock: &Path, static_dir: &Path) -> server::config::Config {
    let parent = lock.parent().unwrap();
    let path = |p: &Path| p.display().to_string();
    let value = |key: &str| overrides.get(key).map(String::as_str);
    let mut vars: std::collections::BTreeMap<String, String> = [
        ("VALLY_LOCK_PATH", path(lock)),
        ("VALLY_TOKEN_PATH", path(&token_path(lock))),
        ("VALLY_KIWOOM_KEY_PATH", path(&lock.with_file_name("kiwoom-key.json"))),
        ("VALLY_ACCOUNT_STATE_PATH", path(&lock.with_file_name("account.json"))),
        ("VALLY_DB_PATH", path(&parent.join("vally.db"))),
        ("VALLY_SCREENER_DB_PATH", path(&parent.join("screener.duckdb"))),
        ("VALLY_STATIC_DIR", path(static_dir)),
        ("VALLY_BIND", format!("{}:0", value("SERVER_BIND_IP").unwrap_or("127.0.0.1"))),
        ("VALLY_LOG", "server=trace".into()),
        ("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:1".into()),
        ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:1".into()),
        ("VALLY_PUBLIC_IP_URL", "http://127.0.0.1:1".into()),
        ("VALLY_SCREENER_UPDATE_ON_START", "off".into()),
        ("VALLY_FINANCIAL_AUTOMATIC", "off".into()),
    ].into_iter().map(|(key, value)| (key.to_owned(), value)).collect();
    let (key_name, secret_name) = if value("VALLY_KIWOOM_ENV") == Some("mock") { ("VALLY_KIWOOM_MOCK_APP_KEY", "VALLY_KIWOOM_MOCK_APP_SECRET") } else { ("VALLY_KIWOOM_APP_KEY", "VALLY_KIWOOM_APP_SECRET") };
    vars.insert(key_name.into(), APP_KEY.into());
    vars.insert(secret_name.into(), APP_SECRET.into());
    vars.extend(overrides.iter().filter(|(key, _)| !HARNESS_ONLY.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())));
    if value(key_name) == Some("") { vars.insert(secret_name.into(), String::new()); }
    if value("OPENDART_API_KEY").is_some_and(|key| !key.is_empty()) {
        assert!(value("VALLY_DART_BASE_URL").is_some() && value("VALLY_KIND_BASE_URL").is_some(), "DART tests require loopback URL");
    }
    server::config::Config::from_values(vars).unwrap().0
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop { fn drop(&mut self) { self.0.abort(); } }
