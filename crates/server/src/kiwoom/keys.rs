use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::auth::KiwoomAuth;
use super::key_file::{FileBases, KEY_LIMIT, derived_paths, KeyFile, KeyId, KeyList, KeyOrigin, KeyPaths, StartupKey, StoredKey, checked_alias, paths_for_key, registered_ip_file};
use super::link::Link;
use super::private_file::FileError;
use super::rest::KiwoomRest;
use super::stream::{AccountFeed, KiwoomStream};
use super::token_file::{Saved, TokenFile};
use super::transport::Transport;
use crate::api::{Broker, KiwoomEnvironment, RegisteredIp};
use crate::clock::Clock;
use crate::config::{KiwoomCredentials, Secret};

static NEXT_SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_serial() -> u64 {
    NEXT_SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

struct LaneTasks {
    _stream: KiwoomStream,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for LaneTasks {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

#[derive(Clone)]
pub struct Lane {
    pub rest: KiwoomRest,
    pub link: Link,
    pub account: AccountFeed,
    _owned: Option<Arc<LaneTasks>>,
}

impl Lane {
    pub fn market(rest: KiwoomRest, link: Link, account: AccountFeed) -> Lane {
        Lane { rest, link, account, _owned: None }
    }
}

pub struct LaneFactory {
    pub transport: Arc<dyn Transport>,
    pub clock: Clock,
    pub environment: KiwoomEnvironment,
    pub spacing: Option<Duration>,
    pub ws_url: Option<String>,
    pub bases: FileBases,
}

impl LaneFactory {
    pub fn token_file(&self, paths: &KeyPaths) -> TokenFile {
        TokenFile::held(paths.token.clone(), self.bases.held).with_environment(self.environment)
    }

    fn paths_for(&self, credentials: &KiwoomCredentials, base_taken: bool, listed: &[KiwoomCredentials]) -> KeyPaths {
        paths_for_key(&self.bases, self.environment, credentials, base_taken, listed)
    }

    fn account_lane(&self, paths: &KeyPaths, credentials: &KiwoomCredentials) -> Lane {
        let auth = KiwoomAuth::new(credentials.app_key.clone(), credentials.app_secret.clone(), Some(self.token_file(paths)));
        let rest = match self.spacing {
            None => KiwoomRest::for_environment(self.transport.clone(), auth, self.clock.clone(), self.environment),
            Some(spacing) => KiwoomRest::build(self.transport.clone(), auth, self.clock.clone(), spacing, self.environment),
        };
        rest.set_access(super::rest::Access::Closed);
        let link = Link::account_only(rest.clone(), self.clock.clone());
        let mut tasks = Vec::new();
        let stream = match &self.ws_url {
            Some(url) => {
                let (stream, mut events) = KiwoomStream::spawn(url.clone(), rest.clone(), self.clock.clone());
                tasks.push(tokio::spawn(async move { while events.recv().await.is_some() {} }));
                stream
            }
            None => KiwoomStream::detached().0,
        };
        tasks.push(tokio::spawn(crate::app::daily_token(self.clock.clone(), rest.clone(), link.clone())));
        Lane { rest, link, account: stream.account_feed(), _owned: Some(Arc::new(LaneTasks { _stream: stream, tasks })) }
    }
}

pub struct KeySetup {
    pub store: KeyFile,
    pub keys: Vec<StartupKey>,
    pub market: Option<KeyId>,
    pub factory: LaneFactory,
}

#[derive(Debug)]
pub enum KeyError {
    Limit,
    DuplicateAppKey,
    Alias(&'static str),
    Unknown,
    EnvReadOnly,
    NoStore,
    File(FileError),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::Limit => write!(f, "키는 {KEY_LIMIT}개까지 등록할 수 있습니다"),
            KeyError::DuplicateAppKey => f.write_str("이미 등록한 앱키입니다"),
            KeyError::Alias(reason) => f.write_str(reason),
            KeyError::Unknown => f.write_str("그 키가 없습니다"),
            KeyError::EnvReadOnly => f.write_str(".env에서 읽은 키라 화면에서 바꿀 수 없습니다"),
            KeyError::NoStore => f.write_str("키 파일 위치가 정해지지 않았습니다"),
            KeyError::File(e) => write!(f, "키 파일에 쓰지 못했습니다: {e}"),
        }
    }
}

struct Entry {
    serial: u64,
    id: KeyId,
    alias: String,
    origin: KeyOrigin,
    broker: Broker,
    credentials: KiwoomCredentials,
    paths: KeyPaths,
    lane: Lane,
    registered_ip: Option<RegisteredIp>,
}

impl Entry {
    fn stored(&self) -> StoredKey {
        StoredKey { id: self.id.clone(), alias: self.alias.clone(), broker: self.broker, credentials: self.credentials.clone() }
    }
}

struct Inner {
    entries: Vec<Entry>,
    market: Option<KeyId>,
    idle_registered_ip: Option<RegisteredIp>,
}

impl Inner {
    fn file_list(&self) -> KeyList {
        KeyList { keys: self.entries.iter().filter(|entry| entry.origin == KeyOrigin::File).map(Entry::stored).collect(), market: self.market.clone() }
    }

    fn position(&self, id: &KeyId) -> Result<usize, KeyError> {
        self.entries.iter().position(|entry| entry.id == *id).ok_or(KeyError::Unknown)
    }

    fn file_position(&self, id: &KeyId) -> Result<usize, KeyError> {
        let at = self.position(id)?;
        if self.entries[at].origin == KeyOrigin::Env { Err(KeyError::EnvReadOnly) } else { Ok(at) }
    }

    fn has_app_key(&self, app_key: &str, except: Option<&KeyId>) -> bool {
        self.entries.iter().any(|entry| Some(&entry.id) != except && entry.credentials.app_key.expose() == app_key)
    }
}

#[derive(Clone)]
pub struct KeyView {
    pub serial: u64,
    pub id: KeyId,
    pub alias: String,
    pub origin: KeyOrigin,
    pub broker: Broker,
    pub market: bool,
    pub app_key_tail: Option<String>,
    pub lane: Lane,
    pub registered_ip: Option<RegisteredIp>,
}

pub struct KeyRing {
    inner: Mutex<Inner>,
    changes: watch::Sender<u64>,
    store: Option<KeyFile>,
    factory: Option<LaneFactory>,
    market_lane: Lane,
}

fn app_key_tail(app_key: &str) -> Option<String> {
    (app_key.chars().count() >= 8).then(|| app_key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect())
}

fn identity(factory: &LaneFactory, entry: &Entry) -> Option<(Secret<String>, Secret<String>, Option<TokenFile>)> {
    Some((entry.credentials.app_key.clone(), entry.credentials.app_secret.clone(), Some(factory.token_file(&entry.paths))))
}

impl KeyRing {
    pub fn unconfigured(market_lane: Lane) -> KeyRing {
        KeyRing { inner: Mutex::new(Inner { entries: Vec::new(), market: None, idle_registered_ip: None }), changes: watch::channel(0).0, store: None, factory: None, market_lane }
    }

    pub fn new(setup: KeySetup, market_lane: Lane) -> KeyRing {
        let KeySetup { store, keys, market, factory } = setup;
        let load_ip = |path: &PathBuf| {
            registered_ip_file(path.clone()).load().unwrap_or_else(|e| {
                tracing::warn!(error = %e, "등록한 IP 기록을 읽지 못했습니다. 없는 것으로 봅니다");
                None
            })
        };
        let entries: Vec<Entry> = keys
            .into_iter()
            .map(|key| {
                let lane = if Some(&key.id) == market.as_ref() { market_lane.clone() } else { factory.account_lane(&key.paths, &key.credentials) };
                let registered_ip = load_ip(&key.paths.registered_ip);
                Entry { serial: next_serial(), id: key.id, alias: key.alias, origin: key.origin, broker: key.broker, credentials: key.credentials, paths: key.paths, lane, registered_ip }
            })
            .collect();
        let idle_registered_ip = if entries.is_empty() { load_ip(&factory.bases.registered_ip) } else { None };
        KeyRing { inner: Mutex::new(Inner { entries, market, idle_registered_ip }), changes: watch::channel(0).0, store: Some(store), factory: Some(factory), market_lane }
    }

    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn announce_change(&self) {
        self.changes.send_modify(|count| *count += 1);
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("키 목록 잠금")
    }

    fn view(inner: &Inner, entry: &Entry) -> KeyView {
        KeyView {
            serial: entry.serial,
            id: entry.id.clone(),
            alias: entry.alias.clone(),
            origin: entry.origin,
            broker: entry.broker,
            market: inner.market.as_ref() == Some(&entry.id),
            app_key_tail: app_key_tail(entry.credentials.app_key.expose()),
            lane: entry.lane.clone(),
            registered_ip: entry.registered_ip.clone(),
        }
    }

    pub fn views(&self) -> Vec<KeyView> {
        let inner = self.lock();
        inner.entries.iter().map(|entry| Self::view(&inner, entry)).collect()
    }

    pub fn view_of(&self, id: &KeyId) -> Option<KeyView> {
        let inner = self.lock();
        inner.entries.iter().find(|entry| entry.id == *id).map(|entry| Self::view(&inner, entry))
    }

    pub fn market(&self) -> Option<KeyView> {
        let inner = self.lock();
        let market = inner.market.as_ref()?;
        inner.entries.iter().find(|entry| entry.id == *market).map(|entry| Self::view(&inner, entry))
    }

    pub fn market_origin(&self) -> Option<KeyOrigin> {
        self.market().map(|view| view.origin)
    }

    pub fn registered_ip(&self) -> Option<RegisteredIp> {
        let inner = self.lock();
        match inner.market.as_ref() {
            Some(market) => inner.entries.iter().find(|entry| entry.id == *market).and_then(|entry| entry.registered_ip.clone()),
            None => inner.idle_registered_ip.clone(),
        }
    }

    pub fn record_registered_ip(&self, registered: RegisteredIp) -> Result<(), KeyError> {
        let factory = self.factory.as_ref().ok_or(KeyError::NoStore)?;
        let mut inner = self.lock();
        let path = inner.market.as_ref().and_then(|market| inner.entries.iter().find(|entry| entry.id == *market)).map_or_else(|| factory.bases.registered_ip.clone(), |entry| entry.paths.registered_ip.clone());
        registered_ip_file(path).save(&registered).map_err(KeyError::File)?;
        match inner.market.clone() {
            Some(market) => {
                if let Some(entry) = inner.entries.iter_mut().find(|entry| entry.id == market) {
                    entry.registered_ip = Some(registered);
                }
            }
            None => inner.idle_registered_ip = Some(registered),
        }
        Ok(())
    }

    pub fn connect_at_start(&self) {
        let lanes: Vec<Lane> = self.lock().entries.iter().map(|entry| entry.lane.clone()).collect();
        if lanes.is_empty() {
            self.market_lane.link.connect_at_start();
        }
        for lane in lanes {
            lane.link.connect_at_start();
        }
    }

    fn persist(&self, list: &KeyList) -> Result<(), KeyError> {
        let store = self.store.as_ref().ok_or(KeyError::NoStore)?;
        let written = if list.keys.is_empty() { store.remove() } else { store.save(list) };
        written.map_err(KeyError::File)
    }

    pub fn add(&self, alias: &str, credentials: KiwoomCredentials) -> Result<KeyId, KeyError> {
        let alias = checked_alias(alias).map_err(KeyError::Alias)?;
        let factory = self.factory.as_ref().ok_or(KeyError::NoStore)?;
        let mut inner = self.lock();
        if inner.has_app_key(credentials.app_key.expose(), None) {
            return Err(KeyError::DuplicateAppKey);
        }
        if inner.entries.len() >= KEY_LIMIT {
            return Err(KeyError::Limit);
        }
        let mut proposed = inner.file_list();
        let id = proposed.next_id();
        let first = inner.entries.is_empty();
        proposed.keys.push(StoredKey { id: id.clone(), alias: alias.clone(), broker: Broker::Kiwoom, credentials: credentials.clone() });
        if first {
            proposed.market = Some(id.clone());
        }
        self.persist(&proposed)?;
        let listed: Vec<KiwoomCredentials> = inner.entries.iter().map(|entry| entry.credentials.clone()).chain([credentials.clone()]).collect();
        let base_taken = inner.entries.iter().any(|entry| entry.paths.token == factory.bases.token);
        let paths = factory.paths_for(&credentials, base_taken, &listed);
        let lane = if first { self.market_lane.clone() } else { factory.account_lane(&paths, &credentials) };
        let registered_ip = registered_ip_file(paths.registered_ip.clone()).load().ok().flatten();
        let entry = Entry { serial: next_serial(), id: id.clone(), alias, origin: KeyOrigin::File, broker: Broker::Kiwoom, credentials, paths, lane, registered_ip };
        if first {
            inner.market = Some(id.clone());
            inner.idle_registered_ip = None;
            entry.lane.link.rebind(identity(factory, &entry));
        }
        entry.lane.link.connect_in_background();
        inner.entries.push(entry);
        self.announce_change();
        Ok(id)
    }

    pub fn rename(&self, id: &KeyId, alias: &str) -> Result<(), KeyError> {
        let alias = checked_alias(alias).map_err(KeyError::Alias)?;
        let mut inner = self.lock();
        let at = inner.file_position(id)?;
        let mut proposed = inner.file_list();
        if let Some(key) = proposed.keys.iter_mut().find(|key| key.id == *id) {
            key.alias.clone_from(&alias);
        }
        self.persist(&proposed)?;
        inner.entries[at].alias = alias;
        Ok(())
    }

    pub fn replace_credentials(&self, id: &KeyId, credentials: KiwoomCredentials) -> Result<(), KeyError> {
        let mut inner = self.lock();
        let at = inner.file_position(id)?;
        if inner.has_app_key(credentials.app_key.expose(), Some(id)) {
            return Err(KeyError::DuplicateAppKey);
        }
        let mut proposed = inner.file_list();
        if let Some(key) = proposed.keys.iter_mut().find(|key| key.id == *id) {
            key.credentials = credentials.clone();
        }
        self.persist(&proposed)?;
        let factory = self.factory.as_ref().ok_or(KeyError::NoStore)?;
        let entry = &mut inner.entries[at];
        entry.credentials = credentials;
        let owns_base = entry.paths.token == factory.bases.token;
        let new_paths = if owns_base { entry.paths.clone() } else { derived_paths(&factory.bases, &entry.credentials) };
        if entry.paths.token != new_paths.token && entry.paths.token.exists() {
            Self::move_token_file(factory, &entry.paths, &new_paths);
        }
        if entry.paths.registered_ip != new_paths.registered_ip && entry.paths.registered_ip.exists() && !new_paths.registered_ip.exists() && let Err(e) = std::fs::rename(&entry.paths.registered_ip, &new_paths.registered_ip) {
            tracing::warn!(error = %e, "키를 바꾸면서 등록 IP 기록을 새 이름으로 옮기지 못했습니다");
        }
        entry.paths = new_paths;
        entry.lane.link.rebind(identity(factory, entry));
        entry.lane.link.record_key_in_token_file();
        entry.lane.link.connect_in_background();
        self.announce_change();
        Ok(())
    }

    fn move_token_file(factory: &LaneFactory, from: &KeyPaths, to: &KeyPaths) {
        let (source, target) = (factory.token_file(from), factory.token_file(to));
        let merged = match (source.load(), target.load()) {
            (Ok(Some(source)), Ok(Some(target))) => Saved {
                credential: target.credential,
                token: target.token,
                last_request_at: source.last_request_at.max(target.last_request_at),
                disconnected: None,
                auth_block: source.auth_block.or(target.auth_block),
            },
            (Ok(Some(source)), Ok(None)) => source,
            (Ok(None), _) => return,
            (Err(e), _) | (_, Err(e)) => {
                tracing::warn!(error = %e, "키를 바꾸면서 토큰 파일을 새 이름으로 옮기지 못했습니다");
                return;
            }
        };
        match target.save(&merged) {
            Ok(()) => drop(std::fs::remove_file(&from.token)),
            Err(e) => tracing::warn!(error = %e, "키를 바꾸면서 토큰 파일을 새 이름으로 옮기지 못했습니다"),
        }
    }

    pub fn remove(&self, id: &KeyId) -> Result<(), KeyError> {
        let mut inner = self.lock();
        let at = inner.file_position(id)?;
        let was_market = inner.market.as_ref() == Some(id);
        let successor = if was_market { inner.entries.iter().position(|entry| entry.id != *id) } else { None };
        let mut proposed = inner.file_list();
        proposed.keys.retain(|key| key.id != *id);
        if was_market {
            proposed.market = successor.map(|at| inner.entries[at].id.clone());
        }
        self.persist(&proposed)?;
        if let Some(successor) = successor {
            self.swap_market(&mut inner, at, successor);
        }
        let removed = inner.entries.remove(at);
        if was_market && successor.is_none() {
            removed.lane.link.clear_key();
            inner.market = None;
        } else {
            removed.lane.link.disconnect();
            if successor.is_some() {
                self.market_lane.link.connect_at_start();
            }
        }
        self.announce_change();
        Ok(())
    }

    pub fn reset_file(&self) -> Result<(), KeyError> {
        self.store.as_ref().ok_or(KeyError::NoStore)?.remove().map_err(KeyError::File)
    }

    pub fn designate_market(&self, id: &KeyId) -> Result<(), KeyError> {
        let mut inner = self.lock();
        let to = inner.position(id)?;
        let Some(from) = inner.market.as_ref().and_then(|market| inner.entries.iter().position(|entry| entry.id == *market)) else { return Err(KeyError::Unknown) };
        if from == to {
            return Ok(());
        }
        let mut proposed = inner.file_list();
        proposed.market = Some(id.clone());
        self.persist(&proposed)?;
        self.swap_market(&mut inner, from, to);
        let lanes = [inner.entries[from].lane.clone(), inner.entries[to].lane.clone()];
        for lane in lanes {
            lane.link.connect_at_start();
        }
        self.announce_change();
        Ok(())
    }

    fn swap_market(&self, inner: &mut Inner, from: usize, to: usize) {
        let Some(factory) = self.factory.as_ref() else { return };
        let (from_lane, to_lane) = (inner.entries[from].lane.clone(), inner.entries[to].lane.clone());
        from_lane.link.disconnect();
        to_lane.link.disconnect();
        from_lane.link.rebind(identity(factory, &inner.entries[to]));
        to_lane.link.rebind(identity(factory, &inner.entries[from]));
        inner.entries[from].lane = to_lane;
        inner.entries[to].lane = from_lane;
        inner.market = Some(inner.entries[to].id.clone());
    }
}
