use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::auth::KiwoomAuth;
use super::key_file::{FileBases, KEY_LIMIT, derived_paths, KeyFile, KeyId, KeyList, KeyOrigin, KeyPaths, StartupKey, StoredKey, checked_alias, kis_token_path, market_lane_key, paths_for_key, registered_ip_file};
use crate::kis::auth::KisAuth;
use crate::kis::link::{KisLane, KisLink};
use crate::kis::rest::KisRest;
use crate::kis::transport::Transport as KisTransport;
use super::link::Link;
use super::private_file::FileError;
use super::rest::KiwoomRest;
use super::stream::{AccountFeed, KiwoomStream};
use super::token_file::{Saved, TokenFile};
use super::transport::Transport;
use crate::api::{Broker, KiwoomEnvironment, RegisteredIp};
use crate::clock::Clock;
use crate::config::{KisCredentials, KiwoomCredentials, Secret};
use crate::trading::KisAccountSettings;

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

#[derive(Clone)]
pub struct KisFactory {
    pub transport: Arc<dyn KisTransport>,
    pub clock: Clock,
    pub token_base: PathBuf,
    pub feed: Option<crate::kis::feed::KisFeedParts>,
}

impl KisFactory {
    fn lane(&self, token_path: PathBuf, credentials: &KiwoomCredentials) -> KisLane {
        let kis_credentials = KisCredentials { app_key: credentials.app_key.clone(), app_secret: credentials.app_secret.clone() };
        let auth = KisAuth::new(kis_credentials, token_path, self.transport.clone(), self.clock.clone());
        KisLink::lane_with_notices(KisRest::new(self.transport.clone(), auth), self.clock.clone(), self.feed.as_ref().map(|feed| feed.connect.clone()))
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
    DuplicateAccount,
    AccountRequired,
    NotKis,
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
            KeyError::DuplicateAccount => f.write_str("같은 계좌번호의 한투 키가 이미 있습니다"),
            KeyError::AccountRequired => f.write_str("한투 키는 계좌번호를 넣어야 더할 수 있습니다"),
            KeyError::NotKis => f.write_str("계좌번호와 HTS ID는 한투 키에만 넣습니다"),
            KeyError::Alias(reason) => f.write_str(reason),
            KeyError::Unknown => f.write_str("그 키가 없습니다"),
            KeyError::EnvReadOnly => f.write_str(".env에서 읽은 키라 화면에서 바꿀 수 없습니다"),
            KeyError::NoStore => f.write_str("키 파일 위치가 정해지지 않았습니다"),
            KeyError::File(e) => write!(f, "키 파일에 쓰지 못했습니다: {e}"),
        }
    }
}

#[derive(Clone)]
enum EntryLane {
    Kiwoom(Lane),
    Kis(KisLane),
}

impl EntryLane {
    fn disconnect(&self) {
        match self {
            EntryLane::Kiwoom(lane) => lane.link.disconnect(),
            EntryLane::Kis(lane) => lane.link.disconnect(),
        }
    }

    fn connect_at_start(&self) {
        match self {
            EntryLane::Kiwoom(lane) => lane.link.connect_at_start(),
            EntryLane::Kis(lane) => lane.link.connect_at_start(),
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
    lane: EntryLane,
    registered_ip: Option<RegisteredIp>,
    account: KisAccountSettings,
}

impl Entry {
    fn stored(&self) -> StoredKey {
        StoredKey { id: self.id.clone(), alias: self.alias.clone(), broker: self.broker, credentials: self.credentials.clone(), account: self.account.clone() }
    }

    fn kiwoom_lane(&self) -> Option<&Lane> {
        match &self.lane {
            EntryLane::Kiwoom(lane) => Some(lane),
            EntryLane::Kis(_) => None,
        }
    }
}

struct Inner {
    entries: Vec<Entry>,
    market: Option<KeyId>,
    market_lane_holder: Option<KeyId>,
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

    fn has_app_key(&self, broker: Broker, app_key: &str, except: Option<&KeyId>) -> bool {
        self.entries.iter().any(|entry| entry.broker == broker && Some(&entry.id) != except && entry.credentials.app_key.expose() == app_key)
    }

    fn has_account(&self, account: &KisAccountSettings, except: Option<&KeyId>) -> bool {
        let Some(number) = account.number.as_ref() else { return false };
        self.entries.iter().any(|entry| entry.broker == Broker::Kis && Some(&entry.id) != except && entry.account.number.as_ref() == Some(number))
    }

    fn count(&self, broker: Broker) -> usize {
        self.entries.iter().filter(|entry| entry.broker == broker).count()
    }

    fn first_kiwoom(&self, except: Option<&KeyId>) -> Option<usize> {
        self.entries.iter().position(|entry| entry.broker == Broker::Kiwoom && Some(&entry.id) != except)
    }

    fn source_is_kiwoom(&self) -> bool {
        self.market.as_ref().and_then(|market| self.entries.iter().find(|entry| entry.id == *market)).is_none_or(|entry| entry.broker == Broker::Kiwoom)
    }

    fn desired_lane_holder(&self, removing: Option<&KeyId>) -> Option<usize> {
        let source = self.market.as_ref().and_then(|market| self.entries.iter().position(|entry| entry.id == *market));
        if let Some(at) = source.filter(|&at| self.entries[at].broker == Broker::Kiwoom && Some(&self.entries[at].id) != removing) {
            return Some(at);
        }
        let current = self.market_lane_holder.as_ref().and_then(|holder| self.entries.iter().position(|entry| entry.id == *holder));
        current.filter(|&at| Some(&self.entries[at].id) != removing).or_else(|| self.first_kiwoom(removing))
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

#[derive(Clone)]
pub enum Connection {
    Kiwoom { lane: Lane, registered_ip: Option<RegisteredIp> },
    Kis(KisLane),
}

#[derive(Clone)]
pub struct ListedKey {
    pub serial: u64,
    pub id: KeyId,
    pub alias: String,
    pub origin: KeyOrigin,
    pub broker: Broker,
    pub market: bool,
    pub app_key_tail: Option<String>,
    pub connection: Connection,
    pub account: KisAccountSettings,
}

#[derive(Clone)]
pub struct KisAccountView {
    pub serial: u64,
    pub id: KeyId,
    pub alias: String,
    pub origin: KeyOrigin,
    pub lane: KisLane,
    pub account: KisAccountSettings,
}

pub struct ConnectedLanes {
    pub kiwoom: Option<KiwoomRest>,
    pub kis: Option<KisLane>,
}

pub struct KeyRing {
    inner: Mutex<Inner>,
    changes: watch::Sender<u64>,
    store: Option<KeyFile>,
    factory: Option<LaneFactory>,
    kis: Option<KisFactory>,
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
        KeyRing { inner: Mutex::new(Inner { entries: Vec::new(), market: None, market_lane_holder: None, idle_registered_ip: None }), changes: watch::channel(0).0, store: None, factory: None, kis: None, market_lane }
    }

    pub fn new(setup: KeySetup, market_lane: Lane) -> KeyRing {
        KeyRing::with_kis(setup, None, market_lane)
    }

    pub fn with_kis(setup: KeySetup, kis: Option<KisFactory>, market_lane: Lane) -> KeyRing {
        let KeySetup { store, keys, market, factory } = setup;
        let load_ip = |path: &PathBuf| {
            registered_ip_file(path.clone()).load().unwrap_or_else(|e| {
                tracing::warn!(error = %e, "등록한 IP 기록을 읽지 못했습니다. 없는 것으로 봅니다");
                None
            })
        };
        let kiwoom_holder = market_lane_key(&keys, market.as_ref()).map(|key| key.id.clone());
        let entries: Vec<Entry> = keys
            .into_iter()
            .filter_map(|key| {
                let (lane, registered_ip) = match key.broker {
                    Broker::Kiwoom => {
                        let lane = if Some(&key.id) == kiwoom_holder.as_ref() { market_lane.clone() } else { factory.account_lane(&key.paths, &key.credentials) };
                        (EntryLane::Kiwoom(lane), load_ip(&key.paths.registered_ip))
                    }
                    Broker::Kis => {
                        let Some(kis) = kis.as_ref() else {
                            tracing::warn!("한투 키가 있지만 한투 연결 설정이 없어 쓰지 않습니다");
                            return None;
                        };
                        (EntryLane::Kis(kis.lane(key.paths.token.clone(), &key.credentials)), None)
                    }
                };
                Some(Entry { serial: next_serial(), id: key.id, alias: key.alias, origin: key.origin, broker: key.broker, credentials: key.credentials, paths: key.paths, lane, registered_ip, account: key.account })
            })
            .collect();
        let market = market.filter(|id| entries.iter().any(|entry| entry.id == *id));
        let idle_registered_ip = if kiwoom_holder.is_none() { load_ip(&factory.bases.registered_ip) } else { None };
        let ring = KeyRing { inner: Mutex::new(Inner { entries, market, market_lane_holder: kiwoom_holder, idle_registered_ip }), changes: watch::channel(0).0, store: Some(store), factory: Some(factory), kis, market_lane };
        ring.apply_market_duty(&ring.lock());
        ring
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

    fn apply_market_duty(&self, inner: &Inner) {
        self.market_lane.link.set_market_duty(inner.source_is_kiwoom());
    }

    fn kiwoom_view(inner: &Inner, entry: &Entry) -> Option<KeyView> {
        Some(KeyView {
            serial: entry.serial,
            id: entry.id.clone(),
            alias: entry.alias.clone(),
            origin: entry.origin,
            broker: entry.broker,
            market: inner.market_lane_holder.as_ref() == Some(&entry.id),
            app_key_tail: app_key_tail(entry.credentials.app_key.expose()),
            lane: entry.kiwoom_lane()?.clone(),
            registered_ip: entry.registered_ip.clone(),
        })
    }

    fn listed(inner: &Inner, entry: &Entry) -> ListedKey {
        let connection = match &entry.lane {
            EntryLane::Kiwoom(lane) => Connection::Kiwoom { lane: lane.clone(), registered_ip: entry.registered_ip.clone() },
            EntryLane::Kis(lane) => Connection::Kis(lane.clone()),
        };
        ListedKey {
            serial: entry.serial,
            id: entry.id.clone(),
            alias: entry.alias.clone(),
            origin: entry.origin,
            broker: entry.broker,
            market: inner.market.as_ref() == Some(&entry.id),
            app_key_tail: app_key_tail(entry.credentials.app_key.expose()),
            connection,
            account: entry.account.clone(),
        }
    }

    fn kis_view(entry: &Entry) -> Option<KisAccountView> {
        let EntryLane::Kis(lane) = &entry.lane else { return None };
        Some(KisAccountView { serial: entry.serial, id: entry.id.clone(), alias: entry.alias.clone(), origin: entry.origin, lane: lane.clone(), account: entry.account.clone() })
    }

    pub fn kis_views(&self) -> Vec<KisAccountView> {
        self.lock().entries.iter().filter_map(Self::kis_view).collect()
    }

    pub fn kis_view_of(&self, id: &KeyId) -> Option<KisAccountView> {
        self.lock().entries.iter().find(|entry| entry.id == *id).and_then(Self::kis_view)
    }

    pub fn views(&self) -> Vec<KeyView> {
        let inner = self.lock();
        inner.entries.iter().filter_map(|entry| Self::kiwoom_view(&inner, entry)).collect()
    }

    pub fn view_of(&self, id: &KeyId) -> Option<KeyView> {
        let inner = self.lock();
        inner.entries.iter().find(|entry| entry.id == *id).and_then(|entry| Self::kiwoom_view(&inner, entry))
    }

    pub fn market(&self) -> Option<KeyView> {
        let inner = self.lock();
        let holder = inner.market_lane_holder.as_ref()?;
        inner.entries.iter().find(|entry| entry.id == *holder).and_then(|entry| Self::kiwoom_view(&inner, entry))
    }

    pub fn market_origin(&self) -> Option<KeyOrigin> {
        self.market().map(|view| view.origin)
    }

    pub fn listing(&self) -> Vec<ListedKey> {
        let inner = self.lock();
        inner.entries.iter().map(|entry| Self::listed(&inner, entry)).collect()
    }

    pub fn connected_lanes(&self) -> ConnectedLanes {
        let inner = self.lock();
        let mut connected = ConnectedLanes { kiwoom: None, kis: None };
        for entry in &inner.entries {
            match &entry.lane {
                EntryLane::Kiwoom(lane) if connected.kiwoom.is_none() && lane.rest.access() == super::rest::Access::Open => connected.kiwoom = Some(lane.rest.clone()),
                EntryLane::Kis(lane) if connected.kis.is_none() && lane.link.is_connected() => connected.kis = Some(lane.clone()),
                _ => {}
            }
        }
        connected
    }

    pub fn listed_key(&self, id: &KeyId) -> Option<ListedKey> {
        let inner = self.lock();
        inner.entries.iter().find(|entry| entry.id == *id).map(|entry| Self::listed(&inner, entry))
    }

    pub fn source_key(&self) -> Option<ListedKey> {
        let inner = self.lock();
        let source = inner.market.as_ref()?;
        inner.entries.iter().find(|entry| entry.id == *source).map(|entry| Self::listed(&inner, entry))
    }

    pub fn registered_ip(&self) -> Option<RegisteredIp> {
        let inner = self.lock();
        match inner.market_lane_holder.as_ref() {
            Some(holder) => inner.entries.iter().find(|entry| entry.id == *holder).and_then(|entry| entry.registered_ip.clone()),
            None => inner.idle_registered_ip.clone(),
        }
    }

    pub fn record_registered_ip(&self, registered: RegisteredIp) -> Result<(), KeyError> {
        let factory = self.factory.as_ref().ok_or(KeyError::NoStore)?;
        let mut inner = self.lock();
        let path = inner.market_lane_holder.as_ref().and_then(|holder| inner.entries.iter().find(|entry| entry.id == *holder)).map_or_else(|| factory.bases.registered_ip.clone(), |entry| entry.paths.registered_ip.clone());
        registered_ip_file(path).save(&registered).map_err(KeyError::File)?;
        match inner.market_lane_holder.clone() {
            Some(holder) => {
                if let Some(entry) = inner.entries.iter_mut().find(|entry| entry.id == holder) {
                    entry.registered_ip = Some(registered);
                }
            }
            None => inner.idle_registered_ip = Some(registered),
        }
        Ok(())
    }

    pub fn connect_at_start(&self) {
        let (lanes, holder_free): (Vec<EntryLane>, bool) = {
            let inner = self.lock();
            (inner.entries.iter().map(|entry| entry.lane.clone()).collect(), inner.market_lane_holder.is_none())
        };
        if holder_free {
            self.market_lane.link.connect_at_start();
        }
        for lane in lanes {
            lane.connect_at_start();
        }
    }

    fn persist(&self, inner: &Inner, list: &KeyList) -> Result<(), KeyError> {
        let store = self.store.as_ref().ok_or(KeyError::NoStore)?;
        let default_source = inner.entries.iter().find(|entry| entry.origin == KeyOrigin::Env).map(|entry| &entry.id);
        let chose_other_source = list.market.is_some() && list.market.as_ref() != default_source;
        let written = if list.keys.is_empty() && !chose_other_source { store.remove() } else { store.save(list) };
        written.map_err(KeyError::File)
    }

    pub fn add(&self, alias: &str, credentials: KiwoomCredentials) -> Result<KeyId, KeyError> {
        self.add_for(Broker::Kiwoom, alias, credentials, KisAccountSettings::default())
    }

    pub fn add_for(&self, broker: Broker, alias: &str, credentials: KiwoomCredentials, account: KisAccountSettings) -> Result<KeyId, KeyError> {
        let alias = checked_alias(alias).map_err(KeyError::Alias)?;
        let factory = self.factory.as_ref().ok_or(KeyError::NoStore)?;
        match broker {
            Broker::Kiwoom if account != KisAccountSettings::default() => return Err(KeyError::NotKis),
            Broker::Kis if account.number.is_none() => return Err(KeyError::AccountRequired),
            _ => {}
        }
        let mut inner = self.lock();
        if inner.has_app_key(broker, credentials.app_key.expose(), None) {
            return Err(KeyError::DuplicateAppKey);
        }
        if inner.has_account(&account, None) {
            return Err(KeyError::DuplicateAccount);
        }
        if inner.count(broker) >= KEY_LIMIT {
            return Err(KeyError::Limit);
        }
        let kis = match broker {
            Broker::Kiwoom => None,
            Broker::Kis => Some(self.kis.as_ref().ok_or(KeyError::NoStore)?),
        };
        let mut proposed = inner.file_list();
        let id = proposed.next_id();
        let becomes_source = inner.market.is_none();
        proposed.keys.push(StoredKey { id: id.clone(), alias: alias.clone(), broker, credentials: credentials.clone(), account: account.clone() });
        if becomes_source {
            proposed.market = Some(id.clone());
        }
        self.persist(&inner, &proposed)?;
        let entry = match kis {
            Some(kis) => {
                let paths = KeyPaths { token: kis_token_path(&kis.token_base, &credentials), registered_ip: derived_paths(&factory.bases, &credentials).registered_ip };
                let lane = kis.lane(paths.token.clone(), &credentials);
                Entry { serial: next_serial(), id: id.clone(), alias, origin: KeyOrigin::File, broker, credentials, paths, lane: EntryLane::Kis(lane), registered_ip: None, account }
            }
            None => {
                let listed: Vec<KiwoomCredentials> = inner.entries.iter().filter(|entry| entry.broker == Broker::Kiwoom).map(|entry| entry.credentials.clone()).chain([credentials.clone()]).collect();
                let base_taken = inner.entries.iter().any(|entry| entry.broker == Broker::Kiwoom && entry.paths.token == factory.bases.token);
                let paths = factory.paths_for(&credentials, base_taken, &listed);
                let takes_market_lane = inner.market_lane_holder.is_none();
                let lane = if takes_market_lane { self.market_lane.clone() } else { factory.account_lane(&paths, &credentials) };
                let registered_ip = registered_ip_file(paths.registered_ip.clone()).load().ok().flatten();
                let entry = Entry { serial: next_serial(), id: id.clone(), alias, origin: KeyOrigin::File, broker, credentials, paths, lane: EntryLane::Kiwoom(lane.clone()), registered_ip, account };
                if takes_market_lane {
                    inner.market_lane_holder = Some(id.clone());
                    inner.idle_registered_ip = None;
                    lane.link.rebind(identity(factory, &entry));
                }
                entry
            }
        };
        if becomes_source {
            inner.market = Some(id.clone());
        }
        self.apply_market_duty(&inner);
        match &entry.lane {
            EntryLane::Kiwoom(lane) => lane.link.connect_in_background(),
            EntryLane::Kis(lane) => lane.link.connect_in_background(),
        }
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
        self.persist(&inner, &proposed)?;
        inner.entries[at].alias = alias;
        Ok(())
    }

    fn kis_account_problem(inner: &Inner, id: &KeyId, account: &KisAccountSettings) -> Result<usize, KeyError> {
        let at = inner.file_position(id)?;
        if inner.entries[at].broker != Broker::Kis {
            return Err(KeyError::NotKis);
        }
        if account.number.is_none() {
            return Err(KeyError::AccountRequired);
        }
        if inner.has_account(account, Some(id)) {
            return Err(KeyError::DuplicateAccount);
        }
        Ok(at)
    }

    pub fn check_kis_account(&self, id: &KeyId, account: &KisAccountSettings) -> Result<(), KeyError> {
        Self::kis_account_problem(&self.lock(), id, account).map(drop)
    }

    pub fn set_kis_account(&self, id: &KeyId, account: KisAccountSettings) -> Result<(), KeyError> {
        let mut inner = self.lock();
        let at = Self::kis_account_problem(&inner, id, &account)?;
        let mut proposed = inner.file_list();
        if let Some(key) = proposed.keys.iter_mut().find(|key| key.id == *id) {
            key.account = account.clone();
        }
        self.persist(&inner, &proposed)?;
        inner.entries[at].account = account;
        self.announce_change();
        Ok(())
    }

    pub fn replace_credentials(&self, id: &KeyId, credentials: KiwoomCredentials) -> Result<(), KeyError> {
        let mut inner = self.lock();
        let at = inner.file_position(id)?;
        let broker = inner.entries[at].broker;
        if inner.has_app_key(broker, credentials.app_key.expose(), Some(id)) {
            return Err(KeyError::DuplicateAppKey);
        }
        let mut proposed = inner.file_list();
        if let Some(key) = proposed.keys.iter_mut().find(|key| key.id == *id) {
            key.credentials = credentials.clone();
        }
        self.persist(&inner, &proposed)?;
        let factory = self.factory.as_ref().ok_or(KeyError::NoStore)?;
        if broker == Broker::Kis {
            let kis = self.kis.as_ref().ok_or(KeyError::NoStore)?;
            let entry = &mut inner.entries[at];
            let old_token = entry.paths.token.clone();
            entry.lane.disconnect();
            entry.paths.token = kis_token_path(&kis.token_base, &credentials);
            entry.credentials = credentials;
            let lane = kis.lane(entry.paths.token.clone(), &entry.credentials);
            lane.link.connect_in_background();
            entry.lane = EntryLane::Kis(lane);
            if old_token != entry.paths.token {
                drop(std::fs::remove_file(old_token));
            }
            self.announce_change();
            return Ok(());
        }
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
        if let EntryLane::Kiwoom(lane) = &entry.lane {
            lane.link.rebind_replacing(identity(factory, entry));
            lane.link.record_key_in_token_file();
            lane.link.connect_in_background();
        }
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
        let was_lane_holder = inner.market_lane_holder.as_ref() == Some(id);
        let next_market = if was_market { inner.entries.iter().find(|entry| entry.id != *id).map(|entry| entry.id.clone()) } else { inner.market.clone() };
        let mut proposed = inner.file_list();
        proposed.keys.retain(|key| key.id != *id);
        proposed.market.clone_from(&next_market);
        self.persist(&inner, &proposed)?;
        inner.market = next_market;
        let next_holder = inner.desired_lane_holder(Some(id));
        let moved = self.hand_over_market_lane(&mut inner, next_holder);
        let removed = inner.entries.remove(at);
        if !(was_lane_holder && next_holder.is_none()) {
            removed.lane.disconnect();
        }
        self.apply_market_duty(&inner);
        if moved {
            self.market_lane.link.connect_at_start();
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
        if inner.market.as_ref() == Some(id) {
            return Ok(());
        }
        let mut proposed = inner.file_list();
        proposed.market = Some(id.clone());
        self.persist(&inner, &proposed)?;
        inner.market = Some(id.clone());
        let next_holder = inner.desired_lane_holder(None);
        let previous_holder = inner.market_lane_holder.clone();
        let moved = self.hand_over_market_lane(&mut inner, next_holder);
        self.apply_market_duty(&inner);
        let lanes: Vec<EntryLane> = inner.entries.iter().enumerate().filter(|(at, entry)| *at == to || (moved && (Some(&entry.id) == previous_holder.as_ref() || Some(&entry.id) == inner.market_lane_holder.as_ref()))).map(|(_, entry)| entry.lane.clone()).collect();
        for lane in lanes {
            lane.connect_at_start();
        }
        self.announce_change();
        Ok(())
    }

    fn hand_over_market_lane(&self, inner: &mut Inner, to: Option<usize>) -> bool {
        let Some(factory) = self.factory.as_ref() else { return false };
        let from = inner.market_lane_holder.as_ref().and_then(|holder| inner.entries.iter().position(|entry| entry.id == *holder));
        match (from, to) {
            (Some(from), Some(to)) if from != to => {
                let (EntryLane::Kiwoom(from_lane), EntryLane::Kiwoom(to_lane)) = (inner.entries[from].lane.clone(), inner.entries[to].lane.clone()) else { return false };
                from_lane.link.disconnect();
                to_lane.link.disconnect();
                from_lane.link.rebind(identity(factory, &inner.entries[to]));
                to_lane.link.rebind(identity(factory, &inner.entries[from]));
                inner.entries[from].lane = EntryLane::Kiwoom(to_lane);
                inner.entries[to].lane = EntryLane::Kiwoom(from_lane);
                inner.market_lane_holder = Some(inner.entries[to].id.clone());
                true
            }
            (None, Some(to)) => {
                self.market_lane.link.rebind(identity(factory, &inner.entries[to]));
                inner.entries[to].lane = EntryLane::Kiwoom(self.market_lane.clone());
                inner.market_lane_holder = Some(inner.entries[to].id.clone());
                inner.idle_registered_ip = None;
                true
            }
            (Some(_), None) => {
                self.market_lane.link.clear_key();
                inner.market_lane_holder = None;
                false
            }
            _ => false,
        }
    }
}
