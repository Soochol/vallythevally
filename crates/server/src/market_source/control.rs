use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};

use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::route::FeatureRoute;
use super::status::status_of;
use super::switch::{SourceSwitch, SwitchParts};
use crate::api::{Broker, MarketSourceStatus};
use crate::config::KiwoomCredentials;
use crate::kiwoom::key_file::{KeyId, MIGRATED_KEY_ALIAS};
use crate::kiwoom::keys::{Connection, KeyError, KeyRing};
use crate::kiwoom::link::{Link, LinkState};
use crate::trading::{Accounts, KisAccountSettings};

type Wait = Pin<Box<dyn Future<Output = ()> + Send>>;

async fn any_changed(links: Vec<watch::Receiver<LinkState>>) {
    if links.is_empty() {
        return std::future::pending().await;
    }
    let waits: Vec<Wait> = links
        .into_iter()
        .map(|mut link| -> Wait {
            Box::pin(async move {
                let _ = link.changed().await;
            })
        })
        .collect();
    futures::future::select_all(waits).await;
}

pub struct MarketControl {
    keys: Arc<KeyRing>,
    route: Arc<FeatureRoute>,
    switch: Arc<SourceSwitch>,
    kiwoom_link: Link,
    status: watch::Sender<MarketSourceStatus>,
}

impl MarketControl {
    pub fn start(parts: SwitchParts, route: Arc<FeatureRoute>) -> Arc<Self> {
        let keys = parts.keys.clone();
        let kiwoom_link = parts.kiwoom_link.clone();
        let switch = Arc::new(SourceSwitch::new(parts));
        let first = status_of(switch.state(), route.current());
        let control = Arc::new(Self {
            keys,
            route,
            switch,
            kiwoom_link,
            status: watch::channel(first).0,
        });
        drop(control.follow());
        control
    }

    pub fn snapshot(&self) -> MarketSourceStatus {
        status_of(self.switch.state(), self.route.current())
    }

    pub fn subscribe(&self) -> watch::Receiver<MarketSourceStatus> {
        self.status.subscribe()
    }

    pub fn source_connected(&self) -> bool {
        self.switch.source_connected()
    }

    pub async fn sync(&self) {
        self.switch.sync().await;
        self.publish();
    }

    pub async fn save_market_credentials(&self, credentials: KiwoomCredentials) -> Result<(), KeyError> {
        match self.keys.market() {
            None => self.keys.add(MIGRATED_KEY_ALIAS, credentials).map(drop),
            Some(market) => self.keys.replace_credentials(&market.id, credentials),
        }?;
        self.sync().await;
        Ok(())
    }

    pub async fn remove_market_key(&self) -> Result<(), KeyError> {
        match self.keys.market() {
            None => self.keys.reset_file()?,
            Some(market) => self.keys.remove(&market.id)?,
        }
        self.sync().await;
        Ok(())
    }

    pub async fn add_key(&self, broker: Broker, alias: &str, credentials: KiwoomCredentials, account: KisAccountSettings) -> Result<KeyId, KeyError> {
        let id = self.keys.add_for(broker, alias, credentials, account)?;
        self.sync().await;
        Ok(id)
    }

    pub fn rename_key(&self, id: &KeyId, alias: &str) -> Result<(), KeyError> {
        self.keys.rename(id, alias)?;
        self.publish();
        Ok(())
    }

    pub async fn replace_key(&self, id: &KeyId, credentials: KiwoomCredentials, account: Option<KisAccountSettings>) -> Result<(), KeyError> {
        if let Some(account) = &account {
            self.keys.check_kis_account(id, account)?;
        }
        self.keys.replace_credentials(id, credentials)?;
        if let Some(account) = account {
            self.keys.set_kis_account(id, account)?;
        }
        self.sync().await;
        Ok(())
    }

    pub fn set_kis_account(&self, id: &KeyId, account: KisAccountSettings, accounts: &Accounts) -> Result<(), KeyError> {
        self.keys.set_kis_account(id, account)?;
        accounts.forget_verified_of(id);
        self.publish();
        Ok(())
    }

    pub async fn remove_key(&self, id: &KeyId) -> Result<(), KeyError> {
        self.keys.remove(id)?;
        self.sync().await;
        Ok(())
    }

    pub async fn designate_market(&self, id: &KeyId) -> Result<(), KeyError> {
        self.keys.designate_market(id)?;
        self.sync().await;
        Ok(())
    }

    fn publish(&self) {
        let next = self.snapshot();
        self.status.send_if_modified(|status| {
            if *status == next {
                return false;
            }
            *status = next;
            true
        });
    }

    fn follow(self: &Arc<Self>) -> JoinHandle<()> {
        let control = Arc::downgrade(self);
        tokio::spawn(async move {
            Self::run_follow(control).await;
        })
    }

    async fn run_follow(control: Weak<Self>) {
        loop {
            let Some(strong) = control.upgrade() else { return };
            let mut key_changes = strong.keys.subscribe_changes();
            let mut source_changes = strong.switch.subscribe();
            let mut links = vec![strong.kiwoom_link.subscribe()];
            for key in strong.keys.listing() {
                match key.connection {
                    Connection::Kiwoom { lane, .. } => links.push(lane.link.subscribe()),
                    Connection::Kis(lane) => links.push(lane.link.subscribe()),
                }
            }
            strong.publish();
            drop(strong);
            tokio::select! {
                changed = key_changes.changed() => if changed.is_err() {
                    return;
                },
                changed = source_changes.changed() => if changed.is_err() {
                    return;
                },
                () = any_changed(links) => {}
            }
            let Some(strong) = control.upgrade() else { return };
            strong.sync().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use crate::api::{Broker, KiwoomEnvironment};
    use crate::bars::BarService;
    use crate::clock::Clock;
    use crate::config::{KiwoomCredentials, Secret};
    use crate::instance::InstanceLock;
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::key_file::{FileBases, KeyFile, startup_keys};
    use crate::kiwoom::keys::{KeyRing, KeySetup, Lane, LaneFactory};
    use crate::kiwoom::link::Link;
    use crate::kiwoom::rest::KiwoomRest;
    use crate::kiwoom::rest::testing::{FakeTransport, ok};
    use crate::kiwoom::stream::KiwoomStream;
    use crate::market::hub::MarketHub;
    use crate::market_source::active::{ActiveSource, ActiveStream};
    use crate::market_source::route::FeatureRoute;
    use crate::market_source::switch::SwitchParts;
    use crate::market_source::{KiwoomHandle, MarketSource};
    use crate::screener::Screener;
    use crate::screener::store::Store;
    use crate::symbols::SymbolDirectory;

    use super::*;

    fn credentials(key: &str) -> KiwoomCredentials {
        KiwoomCredentials { app_key: Secret::new(key.to_owned()), app_secret: Secret::new("secret".to_owned()) }
    }

    #[tokio::test]
    async fn save_market_credentials_syncs_and_publishes_market_source_status() {
        let dir = tempfile::tempdir().unwrap();
        let lock = InstanceLock::acquire(&dir.path().join("vally.lock")).unwrap();
        let clock = Clock::system();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, |_| ok(serde_json::json!({"return_code": 0, "return_msg": "정상"}), None)));
        let rest = KiwoomRest::build(Arc::new(fake.clone()), KiwoomAuth::keyless(None), clock.clone(), Duration::ZERO, KiwoomEnvironment::Real);
        let symbols = Arc::new(SymbolDirectory::default());
        let route = Arc::new(FeatureRoute::new(rest.clone(), clock.clone()));
        let source: Arc<dyn MarketSource> = rest.clone().into();
        let active_source = Arc::new(ActiveSource::new(source.clone()));
        let shared_source: Arc<dyn MarketSource> = active_source.clone();
        let bars = Arc::new(BarService::new(shared_source, symbols.clone(), clock.clone()));
        let screener_store = Store::open(&dir.path().join("screener.duckdb")).unwrap();
        let screener = Arc::new(Screener::new(screener_store, KiwoomHandle::routed(route.clone()), bars.clone(), symbols.clone(), clock.clone()));
        let (stream, _desired) = KiwoomStream::detached();
        let account_feed = stream.account_feed();
        let (_tx, events) = tokio::sync::mpsc::channel(4);
        let (active_stream, merged_events, kiwoom_stream) = ActiveStream::new(Arc::new(stream), events, clock.clone());
        let active_stream = Arc::new(active_stream);
        let hub = MarketHub::spawn(bars.clone(), active_stream.clone(), merged_events, clock.clone());
        let link = Link::new(rest.clone(), symbols.clone(), screener, clock.clone(), false);
        let market_lane = Lane::market(rest, link.clone(), account_feed);
        let bases = FileBases { token: dir.path().join("state").join("kiwoom-token.json"), registered_ip: dir.path().join("keys").join("kiwoom-ip.json"), held: lock.held() };
        let key_file = KeyFile::new(dir.path().join("keys").join("kiwoom-key.json"), &lock);
        let startup = startup_keys(None, &key_file, KiwoomEnvironment::Real, &bases);
        let factory = LaneFactory {
            transport: Arc::new(fake),
            clock: clock.clone(),
            environment: KiwoomEnvironment::Real,
            spacing: Some(Duration::ZERO),
            ws_url: None,
            bases,
        };
        let keys = Arc::new(KeyRing::with_kis(KeySetup { store: key_file, keys: startup.keys, market: startup.market, factory }, None, market_lane));
        route.bind(&keys);
        let control = MarketControl::start(
            SwitchParts {
                keys,
                kiwoom_source: source,
                kiwoom_stream,
                kiwoom_link: link,
                kis_feed: None,
                clock,
                active_source,
                active_stream,
                bars,
                hub,
                symbols: symbols.clone(),
                generation: symbols.generation(),
            },
            route,
        );
        let updates = control.subscribe();
        assert_eq!(control.snapshot().key_id, None);
        control.save_market_credentials(credentials("APPKEY-1111")).await.unwrap();
        let status = control.snapshot();
        assert_eq!(status.broker, Broker::Kiwoom);
        assert!(status.key_id.is_some());
        assert_eq!(status.alias.as_deref(), Some(MIGRATED_KEY_ALIAS));
        assert!(updates.has_changed().unwrap_or(false));
    }
}
