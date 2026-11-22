use crate::kiwoom::rest::{KiwoomError, KiwoomRest};

#[derive(Clone)]
pub struct KiwoomHandle(Option<KiwoomRest>);

impl KiwoomHandle {
    pub fn connected(rest: KiwoomRest) -> Self {
        KiwoomHandle(Some(rest))
    }

    pub fn absent() -> Self {
        KiwoomHandle(None)
    }

    pub fn rest(&self) -> Result<&KiwoomRest, KiwoomError> {
        self.0.as_ref().ok_or(KiwoomError::NotConnected)
    }
}

impl From<KiwoomRest> for KiwoomHandle {
    fn from(rest: KiwoomRest) -> Self {
        KiwoomHandle::connected(rest)
    }
}
