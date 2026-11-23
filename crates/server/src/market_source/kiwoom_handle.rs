use std::sync::Arc;

use super::route::FeatureRoute;
use crate::kiwoom::rest::{KiwoomError, KiwoomRest};

#[derive(Clone)]
enum Held {
    Fixed(KiwoomRest),
    Absent,
    Routed(Arc<FeatureRoute>),
}

#[derive(Clone)]
pub struct KiwoomHandle(Held);

impl KiwoomHandle {
    pub fn connected(rest: KiwoomRest) -> Self {
        KiwoomHandle(Held::Fixed(rest))
    }

    pub fn absent() -> Self {
        KiwoomHandle(Held::Absent)
    }

    pub fn routed(route: Arc<FeatureRoute>) -> Self {
        KiwoomHandle(Held::Routed(route))
    }

    pub fn rest(&self) -> Result<KiwoomRest, KiwoomError> {
        match &self.0 {
            Held::Fixed(rest) => Ok(rest.clone()),
            Held::Absent => Err(KiwoomError::NotConnected),
            Held::Routed(route) => Ok(route.kiwoom_rest()),
        }
    }
}

impl From<KiwoomRest> for KiwoomHandle {
    fn from(rest: KiwoomRest) -> Self {
        KiwoomHandle::connected(rest)
    }
}
