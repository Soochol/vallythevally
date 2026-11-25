use super::rankings::RankingChoices;
use super::route::RouteProfile;
use super::switch::MarketSourceState;
use crate::api::{self, KiwoomLinkState, MarketSourceStatus, UnixSeconds};
use super::link::{ConnectStep, LinkState};
use crate::system_routes::{connect_step, problem};

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
