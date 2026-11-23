use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::active::{ActiveSource, ActiveStream, AttachedStream};
use super::{MarketFeatures, MarketSource, Priority, SourceGeneration};
use crate::api::Broker;
use crate::bars::BarService;
use crate::clock::Clock;
use crate::kis::feed::{KisFeed, KisFeedParts};
use crate::kis::link::KisLane;
use crate::kiwoom::key_file::KeyId;
use crate::kiwoom::keys::{Connection, KeyRing, ListedKey};
use crate::kiwoom::link::{Link, LinkState};
use crate::market::hub::HubHandle;
use crate::symbols::SymbolDirectory;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketSourceState {
    pub broker: Broker,
    pub key_id: Option<KeyId>,
    pub alias: Option<String>,
    pub link_state: LinkState,
    pub features: MarketFeatures,
    pub switches: u64,
}

struct KisSupplier {
    lane: KisLane,
    feed: Arc<KisFeed>,
    source: Arc<dyn MarketSource>,
    stream: AttachedStream,
}

enum Supplier {
    Kiwoom,
    Kis(KisSupplier),
}

enum Wanted {
    Kiwoom,
    Kis(KisLane),
}

impl Supplier {
    fn serves(&self, wanted: &Wanted) -> bool {
        match (self, wanted) {
            (Supplier::Kiwoom, Wanted::Kiwoom) => true,
            (Supplier::Kis(supplier), Wanted::Kis(lane)) => supplier.lane.link.same(&lane.link),
            _ => false,
        }
    }

    fn link_state(&self, kiwoom: &Link) -> LinkState {
        match self {
            Supplier::Kiwoom => kiwoom.state(),
            Supplier::Kis(supplier) => supplier.lane.link.state(),
        }
    }

    fn watch_link(&self, kiwoom: &Link) -> watch::Receiver<LinkState> {
        match self {
            Supplier::Kiwoom => kiwoom.subscribe(),
            Supplier::Kis(supplier) => supplier.lane.link.subscribe(),
        }
    }
}

pub struct SwitchParts {
    pub keys: Arc<KeyRing>,
    pub kiwoom_source: Arc<dyn MarketSource>,
    pub kiwoom_stream: AttachedStream,
    pub kiwoom_link: Link,
    pub kis_feed: Option<KisFeedParts>,
    pub clock: Clock,
    pub active_source: Arc<ActiveSource>,
    pub active_stream: Arc<ActiveStream>,
    pub bars: Arc<BarService>,
    pub hub: HubHandle,
    pub symbols: Arc<SymbolDirectory>,
    pub generation: SourceGeneration,
}

pub struct SourceSwitch {
    current: tokio::sync::Mutex<Supplier>,
    parts: SwitchParts,
    state: watch::Sender<MarketSourceState>,
    switches: AtomicU64,
    source_link: std::sync::Mutex<Option<KisLane>>,
}

impl SourceSwitch {
    pub fn new(parts: SwitchParts) -> SourceSwitch {
        let state = MarketSourceState { broker: Broker::Kiwoom, key_id: None, alias: None, link_state: parts.kiwoom_link.state(), features: parts.kiwoom_source.features(), switches: 0 };
        SourceSwitch { current: tokio::sync::Mutex::new(Supplier::Kiwoom), parts, state: watch::channel(state).0, switches: AtomicU64::new(0), source_link: std::sync::Mutex::new(None) }
    }

    pub fn subscribe(&self) -> watch::Receiver<MarketSourceState> {
        self.state.subscribe()
    }

    pub fn state(&self) -> MarketSourceState {
        self.state.borrow().clone()
    }

    fn wanted(&self, key: Option<&ListedKey>) -> Wanted {
        match key.map(|key| &key.connection) {
            Some(Connection::Kis(lane)) if self.parts.kis_feed.is_some() => Wanted::Kis(lane.clone()),
            Some(Connection::Kis(_)) => {
                tracing::warn!("한투 키가 시세 공급원이지만 한투 시세 연결 설정이 없어 키움 공급원을 그대로 씁니다");
                Wanted::Kiwoom
            }
            Some(Connection::Kiwoom { .. }) | None => Wanted::Kiwoom,
        }
    }

    pub async fn sync(&self) {
        let mut current = self.current.lock().await;
        let key = self.parts.keys.source_key();
        let wanted = self.wanted(key.as_ref());
        if !current.serves(&wanted) {
            self.switch_to(&mut current, wanted).await;
        }
        self.publish(&current, key.as_ref());
    }

    async fn switch_to(&self, current: &mut Supplier, wanted: Wanted) {
        let parts = &self.parts;
        let next = match wanted {
            Wanted::Kiwoom => Supplier::Kiwoom,
            Wanted::Kis(lane) => {
                let feed_parts = parts.kis_feed.clone().expect("한투 시세 연결 설정을 확인한 뒤에만 고른다");
                let supply = KisFeed::supply(lane.clone(), feed_parts, parts.clock.clone(), parts.symbols.updates());
                let stream = parts.active_stream.attach(supply.feed.clone(), supply.events);
                Supplier::Kis(KisSupplier { lane, feed: supply.feed, source: supply.source, stream })
            }
        };
        if let Supplier::Kis(previous) = &*current {
            previous.lane.link.set_duty(None);
        }
        let (source, stream) = match &next {
            Supplier::Kiwoom => (parts.kiwoom_source.clone(), parts.kiwoom_stream.clone()),
            Supplier::Kis(supplier) => (supplier.source.clone(), supplier.stream.clone()),
        };
        tracing::info!(to = if matches!(next, Supplier::Kiwoom) { "kiwoom" } else { "kis" }, "시세 공급원을 바꿉니다");
        parts.active_stream.activate(&stream).await;
        parts.active_source.replace(source);
        parts.bars.clear_all();
        parts.generation.advance();
        parts.hub.source_switched();
        if let Supplier::Kis(supplier) = &next {
            supplier.lane.link.set_duty(Some(supplier.feed.duty(parts.symbols.clone(), supplier.source.clone())));
            if supplier.lane.link.is_connected() {
                supplier.feed.open();
            }
        }
        *self.source_link.lock().expect("공급원 연결 잠금") = match &next {
            Supplier::Kiwoom => None,
            Supplier::Kis(supplier) => Some(supplier.lane.clone()),
        };
        let previous = std::mem::replace(current, next);
        drop(previous);
        self.refresh_symbols().await;
        self.switches.fetch_add(1, Ordering::SeqCst);
    }

    async fn refresh_symbols(&self) {
        let source = &self.parts.active_source;
        if let Some(outage) = source.outage() {
            tracing::info!(reason = %outage, "새 시세 공급원이 아직 연결되지 않아 종목 목록은 연결할 때 받습니다");
            return;
        }
        if let Err(error) = self.parts.symbols.refresh(source.as_ref(), Priority::Screen).await {
            tracing::warn!(error = %error, "새 시세 공급원에서 종목 목록을 받지 못했습니다. 이전 목록을 씁니다");
        }
    }

    fn publish(&self, current: &Supplier, key: Option<&ListedKey>) {
        let features = self.parts.active_source.features();
        let link_state = current.link_state(&self.parts.kiwoom_link);
        let broker = match current {
            Supplier::Kiwoom => Broker::Kiwoom,
            Supplier::Kis(_) => Broker::Kis,
        };
        let shown = key.filter(|key| key.broker == broker);
        let switches = self.switches.load(Ordering::SeqCst);
        let next = MarketSourceState { broker, key_id: shown.map(|key| key.id.clone()), alias: shown.map(|key| key.alias.clone()), link_state, features, switches };
        self.state.send_if_modified(|state| if *state == next { false } else {
            *state = next;
            true
        });
    }

    pub fn source_connected(&self) -> bool {
        match self.source_link.lock().expect("공급원 연결 잠금").as_ref() {
            Some(lane) => lane.link.is_connected(),
            None => self.parts.kiwoom_link.is_connected(),
        }
    }

    pub fn follow(self: &Arc<Self>) -> JoinHandle<()> {
        let switch = Arc::downgrade(self);
        let mut changes = self.parts.keys.subscribe_changes();
        tokio::spawn(async move {
            loop {
                let Some(strong) = switch.upgrade() else { return };
                let mut link = strong.current.lock().await.watch_link(&strong.parts.kiwoom_link);
                drop(strong);
                tokio::select! {
                    changed = changes.changed() => if changed.is_err() {
                        return;
                    },
                    changed = link.changed() => if changed.is_err() && changes.changed().await.is_err() {
                        return;
                    },
                }
                let Some(strong) = switch.upgrade() else { return };
                strong.sync().await;
            }
        })
    }
}
