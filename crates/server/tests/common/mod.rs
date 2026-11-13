#![allow(dead_code, unused_imports)]

#[path = "../support/mod.rs"]
pub mod support;
pub use support::{APP_KEY, APP_SECRET, ScriptedTransport, TOKEN};

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::io::Write;
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

pub struct Server {
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
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let subscriber = tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(move || writer.clone()).with_filter(tracing_subscriber::EnvFilter::new("server=trace")));
            let _guard = tracing::subscriber::set_default(subscriber);
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move {
                tokio::select! {
                    _ = stopped => {},
                    _ = async move {
            let value = |key: &str| overrides.get(key).map(String::as_str);
            let parent = lock.parent().unwrap();
            let instance = server::instance::InstanceLock::acquire(&lock).unwrap();
            let token_path = value("VALLY_TOKEN_PATH").map(PathBuf::from).unwrap_or_else(|| token_path(&lock));
            let clock = value("VALLY_CLOCK_START").map(|at| server::clock::Clock::fake(server::kiwoom::wire::parse_kst_datetime(at).unwrap())).unwrap_or_else(server::clock::Clock::system);
            let auth = server::kiwoom::auth::KiwoomAuth::new(server::config::Secret::new(value("VALLY_KIWOOM_APP_KEY").unwrap_or(APP_KEY).into()), server::config::Secret::new(APP_SECRET.into()), Some(server::kiwoom::token_file::TokenFile::new(token_path.clone(), &instance)));
            let rest = server::kiwoom::rest::KiwoomRest::new(transport.transport(), auth, clock.clone());
            let db = server::db::AppDb::open(&parent.join("vally.db")).await.unwrap();
            let store_path = parent.join("screener.duckdb");
            let dispatcher = tracing::dispatcher::get_default(Clone::clone);
            let store = tokio::task::spawn_blocking(move || tracing::dispatcher::with_default(&dispatcher, || server::screener::store::Store::open(&store_path).unwrap())).await.unwrap();
            let symbols = Arc::new(server::symbols::SymbolDirectory::default());
            let (stream, _desired) = server::kiwoom::stream::KiwoomStream::detached();
            let state = server::app::application(server::app::ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols: symbols.clone(), db, screener_store: store, stream: (stream, stream_events), static_dir });
            server::app::initialize_rest(&rest, &clock, &token_path).await;
            let mut background = tokio::task::JoinSet::new();
            background.spawn(server::app::initialize_market(state.clone(), value("VALLY_SCREENER_UPDATE_ON_START") == Some("on")));
            background.spawn(server::app::daily_maintenance(state.clone()));
            let financial_path = value("VALLY_FINANCIAL_DB_PATH").map(PathBuf::from).unwrap_or_else(|| parent.join("financials.db"));
            let financial_store = server::financials::store::Store::open(&financial_path).await;
            let client = value("OPENDART_API_KEY").filter(|key| !key.is_empty()).map(|key| server::financials::client::Client::new(server::config::Secret::new(key.into()), value("VALLY_DART_BASE_URL").expect("DART tests require loopback URL").into(), value("VALLY_KIND_BASE_URL").expect("KIND tests require loopback URL").into()).unwrap());
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
        Self { thread: Some(thread), shutdown: Some(shutdown), address: receiver, output, events }
    }

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
