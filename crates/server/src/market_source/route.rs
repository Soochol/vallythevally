use std::sync::{Arc, OnceLock, Weak};

use super::rankings::{RankingChoices, RankingKind, RankingSource};
use super::{KiwoomHandle, OverviewFeatures, OverviewSource};
use crate::api::Broker;
use crate::clock::Clock;
use crate::kis::link::KisLane;
use crate::kis::overview::KisOverview;
use crate::kis::rankings::KisRankings;
use crate::kiwoom::keys::KeyRing;
use crate::kiwoom::rest::KiwoomRest;
use crate::market_overview::KiwoomOverview;
use crate::rankings::KiwoomRankings;

pub struct Picked<S: ?Sized> {
    pub broker: Broker,
    pub source: Arc<S>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteProfile {
    pub broker: Broker,
    pub ranking_kinds: &'static [RankingKind],
    pub ranking_choices: Vec<(RankingKind, RankingChoices)>,
    pub overview_features: OverviewFeatures,
}

#[derive(Clone)]
enum Receiver {
    Kiwoom(KiwoomRest),
    Kis(KisLane),
    Nobody,
}

pub struct FeatureRoute {
    keys: OnceLock<Weak<KeyRing>>,
    market_rest: KiwoomRest,
    clock: Clock,
}

impl FeatureRoute {
    pub fn new(market_rest: KiwoomRest, clock: Clock) -> FeatureRoute {
        FeatureRoute { keys: OnceLock::new(), market_rest, clock }
    }

    pub fn bind(&self, keys: &Arc<KeyRing>) {
        let _ = self.keys.set(Arc::downgrade(keys));
    }

    fn receiver(&self) -> Receiver {
        let connected = self.keys.get().and_then(Weak::upgrade).map(|keys| keys.connected_lanes());
        let (kiwoom, kis) = match connected {
            Some(lanes) => (lanes.kiwoom, lanes.kis),
            None => (None, None),
        };
        let kiwoom = kiwoom.or_else(|| (self.market_rest.access() == crate::kiwoom::rest::Access::Open).then(|| self.market_rest.clone()));
        match (kiwoom, kis) {
            (Some(rest), _) => Receiver::Kiwoom(rest),
            (None, Some(lane)) => Receiver::Kis(lane),
            (None, None) => Receiver::Nobody,
        }
    }

    pub fn kiwoom_rest(&self) -> KiwoomRest {
        match self.receiver() {
            Receiver::Kiwoom(rest) => rest,
            Receiver::Kis(_) | Receiver::Nobody => self.market_rest.clone(),
        }
    }

    pub fn kis_receiving_instead_of_kiwoom(&self) -> Option<KisLane> {
        match self.receiver() {
            Receiver::Kis(lane) => Some(lane),
            Receiver::Kiwoom(_) | Receiver::Nobody => None,
        }
    }

    pub fn kiwoom_connected(&self) -> bool {
        matches!(self.receiver(), Receiver::Kiwoom(_))
    }

    pub fn kis_listed_without_connected_kiwoom(&self) -> bool {
        let kis_listed = self.keys.get().and_then(Weak::upgrade).is_some_and(|keys| keys.listing().iter().any(|key| key.broker == Broker::Kis));
        kis_listed && !self.kiwoom_connected()
    }

    pub fn kiwoom_key_missing(&self) -> bool {
        self.keys.get().and_then(Weak::upgrade).is_some_and(|keys| !keys.listing().iter().any(|key| key.broker == Broker::Kiwoom))
    }

    pub fn rankings(&self) -> Picked<dyn RankingSource> {
        self.rankings_for(self.receiver())
    }

    pub fn overview(&self) -> Picked<dyn OverviewSource> {
        self.overview_for(self.receiver())
    }

    fn rankings_for(&self, receiver: Receiver) -> Picked<dyn RankingSource> {
        match receiver {
            Receiver::Kiwoom(rest) => Picked { broker: Broker::Kiwoom, source: Arc::new(KiwoomRankings::new(rest)) },
            Receiver::Kis(lane) => Picked { broker: Broker::Kis, source: Arc::new(KisRankings::new(lane.rest, self.clock.clone())) },
            Receiver::Nobody => Picked { broker: Broker::Kiwoom, source: Arc::new(KiwoomRankings::new(self.market_rest.clone())) },
        }
    }

    fn overview_for(&self, receiver: Receiver) -> Picked<dyn OverviewSource> {
        match receiver {
            Receiver::Kiwoom(rest) => Picked { broker: Broker::Kiwoom, source: Arc::new(KiwoomOverview::new(KiwoomHandle::connected(rest))) },
            Receiver::Kis(lane) => Picked { broker: Broker::Kis, source: Arc::new(KisOverview::new(lane.rest)) },
            Receiver::Nobody => Picked { broker: Broker::Kiwoom, source: Arc::new(KiwoomOverview::new(KiwoomHandle::connected(self.market_rest.clone()))) },
        }
    }

    pub fn current(&self) -> Option<RouteProfile> {
        let receiver = self.receiver();
        if matches!(receiver, Receiver::Nobody) {
            return None;
        }
        let rankings = self.rankings_for(receiver.clone());
        let overview = self.overview_for(receiver);
        let ranking_choices = rankings.source.kinds().iter().map(|kind| (*kind, rankings.source.choices(*kind))).collect();
        Some(RouteProfile { broker: rankings.broker, ranking_kinds: rankings.source.kinds(), ranking_choices, overview_features: overview.source.features() })
    }
}
