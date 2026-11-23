use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use server::api::Ranking;
use server::clock::Clock;
use server::config::{KisCredentials, Secret};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::kis::auth::KisAuth;
use server::kis::rankings::KisRankings;
use server::kis::rest::KisRest;
use server::kis::transport::{HttpRequest as KisHttpRequest, HttpResponse as KisHttpResponse, Transport as KisTransport, TransportError as KisTransportError};
use server::market_source::rankings::RankingSource;
use server::rankings::KiwoomRankings;
use server::shared_data::Broker;

struct Unconnected;

impl Transport for Unconnected {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        Box::pin(async { Err(TransportError::refused()) })
    }
}

impl KisTransport for Unconnected {
    fn send(&self, _request: KisHttpRequest) -> BoxFuture<'static, Result<KisHttpResponse, KisTransportError>> {
        Box::pin(async { Err(KisTransportError::refused()) })
    }
}

pub(super) struct Capability {
    kiwoom: KiwoomRankings,
    kis: KisRankings,
}

impl Capability {
    pub(super) fn new(clock: &Clock) -> Capability {
        let kiwoom = KiwoomRankings::new(KiwoomRest::new(Arc::new(Unconnected), KiwoomAuth::keyless(None), clock.clone()));
        let credentials = KisCredentials { app_key: Secret::new(String::new()), app_secret: Secret::new(String::new()) };
        let kis_auth = KisAuth::new(credentials, PathBuf::from("/nonexistent/unconnected-token.json"), Arc::new(Unconnected), clock.clone());
        let kis = KisRankings::new(KisRest::new(Arc::new(Unconnected), kis_auth), clock.clone());
        Capability { kiwoom, kis }
    }

    pub(super) fn can_take(&self, broker: Broker, ranking: &Ranking) -> bool {
        match broker {
            Broker::Kiwoom => self.kiwoom.check(ranking).is_ok(),
            Broker::Kis => self.kis.check(ranking).is_ok(),
        }
    }
}
