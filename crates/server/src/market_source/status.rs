use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};

use tokio::sync::watch;

use super::rankings::RankingChoices;
use super::route::{FeatureRoute, RouteProfile};
use super::switch::{MarketSourceState, SourceSwitch};
use crate::api::{self, KiwoomLinkState, MarketSourceStatus, UnixSeconds};
use crate::kiwoom::keys::{Connection, KeyRing};
use crate::kiwoom::link::{ConnectStep, Link, LinkState};
use crate::system_routes::{connect_step, problem};

pub struct MarketSourceBoard {
    switch: Arc<SourceSwitch>,
    route: Arc<FeatureRoute>,
    status: watch::Sender<MarketSourceStatus>,
}

fn choices_view(choices: RankingChoices) -> api::RankingChoicesView {
    api::RankingChoicesView {
        venues: choices.venues,
        sessions: choices.sessions,
        baselines: choices.baselines,
        surge_sorts: choices.surge_sorts,
        min_trade_amounts: choices.min_trade_amounts,
        investors: choices.investors,
        spans: choices.spans,
        excludes_managed: choices.excludes_managed,
    }
}

fn feed_view(profile: RouteProfile) -> api::FeedBrokerStatus {
    api::FeedBrokerStatus {
        broker: profile.broker,
        ranking_kinds: profile.ranking_kinds.to_vec(),
        ranking_choices: profile.ranking_choices.into_iter().map(|(kind, choices)| api::RankingKindChoices { kind, choices: choices_view(choices) }).collect(),
        overview_features: profile.overview_features.iter().collect(),
    }
}

pub fn status_of(state: MarketSourceState, feed: Option<RouteProfile>) -> MarketSourceStatus {
    let (link_state, link_problem, step, retry_at) = match state.link_state {
        LinkState::NoKey => (KiwoomLinkState::NoKey, None, None, None),
        LinkState::Disconnected => (KiwoomLinkState::Disconnected, None, None, None),
        LinkState::Connecting(step) => {
            let retry_at = match step {
                ConnectStep::IssueInterval(until) => Some(UnixSeconds(until.unix())),
                _ => None,
            };
            (KiwoomLinkState::Connecting, None, Some(connect_step(step)), retry_at)
        }
        LinkState::Connected => (KiwoomLinkState::Connected, None, None, None),
        LinkState::Failed(failure) => (KiwoomLinkState::Failed, Some(problem(failure.problem)), None, failure.retry_at.map(|at| UnixSeconds(at.unix()))),
    };
    MarketSourceStatus {
        broker: state.broker,
        key_id: state.key_id.map(|id| id.to_string()),
        alias: state.alias,
        state: link_state,
        problem: link_problem,
        step,
        retry_at,
        features: state.features.iter().collect(),
        feed_broker: feed.map(feed_view),
    }
}

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

impl MarketSourceBoard {
    pub fn start(switch: Arc<SourceSwitch>, route: Arc<FeatureRoute>, keys: &Arc<KeyRing>, kiwoom_link: Link) -> Arc<MarketSourceBoard> {
        let first = status_of(switch.state(), route.current());
        let board = Arc::new(MarketSourceBoard { switch, route, status: watch::channel(first).0 });
        tokio::spawn(MarketSourceBoard::follow(Arc::downgrade(&board), Arc::downgrade(keys), kiwoom_link));
        board
    }

    pub fn snapshot(&self) -> MarketSourceStatus {
        status_of(self.switch.state(), self.route.current())
    }

    pub fn subscribe(&self) -> watch::Receiver<MarketSourceStatus> {
        self.status.subscribe()
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

    async fn follow(board: Weak<MarketSourceBoard>, keys: Weak<KeyRing>, kiwoom_link: Link) {
        loop {
            let (Some(strong), Some(keys)) = (board.upgrade(), keys.upgrade()) else { return };
            let mut key_changes = keys.subscribe_changes();
            let mut source_changes = strong.switch.subscribe();
            let mut links = vec![kiwoom_link.subscribe()];
            for key in keys.listing() {
                match key.connection {
                    Connection::Kiwoom { lane, .. } => links.push(lane.link.subscribe()),
                    Connection::Kis(lane) => links.push(lane.link.subscribe()),
                }
            }
            strong.publish();
            drop((strong, keys));
            tokio::select! {
                changed = key_changes.changed() => if changed.is_err() {
                    return;
                },
                changed = source_changes.changed() => if changed.is_err() {
                    return;
                },
                () = any_changed(links) => {}
            }
        }
    }
}
