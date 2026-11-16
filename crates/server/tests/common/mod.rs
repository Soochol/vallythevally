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
            let parent = lock.parent().unwrap();
            let instance = server::instance::InstanceLock::acquire(&lock).unwrap();
            let token_path = value("VALLY_TOKEN_PATH").map(PathBuf::from).unwrap_or_else(|| token_path(&lock));
            let clock = value("VALLY_CLOCK_START").map(|at| server::clock::Clock::fake(server::kiwoom::wire::parse_kst_datetime(at).unwrap())).unwrap_or_else(server::clock::Clock::system);
            let token_file = server::kiwoom::token_file::TokenFile::new(token_path.clone(), &instance);
            let auth = match value("VALLY_KIWOOM_APP_KEY") {
                Some("") => server::kiwoom::auth::KiwoomAuth::keyless(Some(token_file)),
                key => server::kiwoom::auth::KiwoomAuth::new(server::config::Secret::new(key.unwrap_or(APP_KEY).into()), server::config::Secret::new(APP_SECRET.into()), Some(token_file)),
            };
            let rest = server::kiwoom::rest::KiwoomRest::with_send_spacing(transport.transport(), auth, clock.clone(), std::time::Duration::from_millis(value("KIWOOM_SEND_SPACING_MILLIS").map_or(1, |millis| millis.parse().unwrap())));
            let db = server::db::AppDb::open(&parent.join("vally.db")).await.unwrap();
            let store_path = parent.join("screener.duckdb");
            let dispatcher = tracing::dispatcher::get_default(Clone::clone);
            let store = tokio::task::spawn_blocking(move || tracing::dispatcher::with_default(&dispatcher, || server::screener::store::Store::open(&store_path).unwrap())).await.unwrap();
            let symbols = Arc::new(server::symbols::SymbolDirectory::default());
            let (stream, stream_events, _desired) = match value("VALLY_KIWOOM_WS_URL") {
                Some(url) => {
                    let (stream, events) = server::kiwoom::stream::KiwoomStream::spawn(url.into(), rest.clone(), clock.clone());
                    (stream, events, None)
                }
                None => {
                    let (stream, desired) = server::kiwoom::stream::KiwoomStream::detached();
                    (stream, stream_events, Some(desired))
                }
            };
            let state = server::app::application(server::app::ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols: symbols.clone(), db, screener_store: store, stream: (stream, stream_events), static_dir, screener_update_on_connect: value("VALLY_SCREENER_UPDATE_ON_START") == Some("on") });
            let mut background = tokio::task::JoinSet::new();
            publish.set(Control { link: state.link.clone(), runtime: tokio::runtime::Handle::current(), clock: clock.clone() }).ok();
            if value("VALLY_KIWOOM_CONNECT") != Some("off") {
                let link = state.link.clone();
                background.spawn(async move { link.connect(false).await; });
                state.link.subscribe().wait_for(|state| matches!(state, LinkState::NoKey | LinkState::Connected | LinkState::Failed(_) | LinkState::Connecting(ConnectStep::Symbols | ConnectStep::Realtime))).await.unwrap();
            }
            background.spawn(server::app::daily_maintenance(state.clone()));
            let financial_path = value("VALLY_FINANCIAL_DB_PATH").map(PathBuf::from).unwrap_or_else(|| parent.join("financials.db"));
            let financial_store = server::financials::store::Store::open(&financial_path).await;
            let client = value("OPENDART_API_KEY").filter(|key| !key.is_empty()).map(|key| server::financials::client::Client::with_spacing(server::config::Secret::new(key.into()), value("VALLY_DART_BASE_URL").expect("DART tests require loopback URL").into(), value("VALLY_KIND_BASE_URL").expect("KIND tests require loopback URL").into(), std::time::Duration::from_millis(value("DART_SPACING_MILLIS").map_or(1, |millis| millis.parse().unwrap()))).unwrap());
            let financials = server::financials::Financials::with_store(client, financial_store, clock);
            let automatic = (value("VALLY_FINANCIAL_AUTOMATIC") == Some("on")).then(|| financials.start_automatic(symbols.clone()));
            let app = server::http::router(state).merge(server::financials::routes(financials, symbols));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            address.send_replace(Some(listener.local_addr().unwrap()));
            let automatic = automatic.map(AbortOnDrop);
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

struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop { fn drop(&mut self) { self.0.abort(); } }
