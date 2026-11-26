use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Arc, Mutex, Weak};

use aes::Aes256;
use base64::Engine;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use domain::Venue;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;

use super::auth::KisAuth;
use super::stream::{Connector, KisStream, RealFrame, SealedFrame, StreamEvent, Subscription};
use crate::config::Secret;
use crate::kiwoom::link::LinkState;

pub const FILL_NOTICE_TR_ID: &str = "H0STCNI0";
const KEY_BYTES: usize = 32;
const IV_BYTES: usize = 16;
const NOTICE_BUFFER: usize = 64;
const ACCOUNT_COLUMN: usize = 1;
const ORDER_COLUMN: usize = 2;
const QUANTITY_COLUMN: usize = 9;
const FILLED_COLUMN: usize = 13;
const EXCHANGE_COLUMN: usize = 19;
const FILLED: &str = "2";

pub type NoticeConnect = Arc<dyn Fn() -> Box<dyn Connector> + Send + Sync>;

#[derive(Clone, PartialEq, Eq)]
pub struct NoticeCipher {
    key: Secret<String>,
    iv: Secret<String>,
}

impl NoticeCipher {
    pub fn new(key: String, iv: String) -> Option<NoticeCipher> {
        (key.len() == KEY_BYTES && iv.len() == IV_BYTES).then(|| NoticeCipher { key: Secret::new(key), iv: Secret::new(iv) })
    }

    pub fn open(&self, sealed: &str) -> Option<String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(sealed.trim()).ok()?;
        let decryptor = cbc::Decryptor::<Aes256>::new_from_slices(self.key.expose().as_bytes(), self.iv.expose().as_bytes()).ok()?;
        String::from_utf8(decryptor.decrypt_padded_vec_mut::<Pkcs7>(&bytes).ok()?).ok()
    }
}

impl fmt::Debug for NoticeCipher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NoticeCipher([가림])")
    }
}

#[derive(Clone, Debug)]
pub struct FillNotice {
    pub account: Secret<String>,
    pub order_no: String,
    pub filled: bool,
    pub quantity: Option<u64>,
    pub venue: Option<Venue>,
}

fn exchange_venue(code: &str) -> Option<Venue> {
    match code.trim() {
        "1" | "3" => Some(Venue::Krx),
        "2" | "4" => Some(Venue::Nxt),
        _ => None,
    }
}

pub fn read_notices(plain: &str, count: u32) -> Vec<FillNotice> {
    let fields: Vec<&str> = plain.split('^').collect();
    let count = count.max(1) as usize;
    if fields.len() < count || !fields.len().is_multiple_of(count) {
        return Vec::new();
    }
    fields
        .chunks(fields.len() / count)
        .filter_map(|record| {
            let text = |index: usize| record.get(index).map(|field| field.trim()).filter(|field| !field.is_empty());
            let filled = text(FILLED_COLUMN) == Some(FILLED);
            let quantity = filled.then(|| text(QUANTITY_COLUMN).and_then(|value| value.parse::<u64>().ok()).filter(|&qty| qty > 0)).flatten();
            Some(FillNotice { account: Secret::new(text(ACCOUNT_COLUMN)?.to_owned()), order_no: text(ORDER_COLUMN)?.to_owned(), filled, quantity, venue: text(EXCHANGE_COLUMN).and_then(exchange_venue) })
        })
        .collect()
}

struct Dedicated {
    stream: KisStream,
    pump: JoinHandle<()>,
}

impl Drop for Dedicated {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

struct Inner {
    wanted: watch::Sender<Option<Secret<String>>>,
    claims: watch::Sender<usize>,
    cipher: Mutex<Option<NoticeCipher>>,
    out: broadcast::Sender<FillNotice>,
    dedicated: Mutex<Option<Dedicated>>,
}

#[derive(Clone)]
pub struct KisNotices(Arc<Inner>);

pub struct NoticeClaim(Weak<Inner>);

impl Drop for NoticeClaim {
    fn drop(&mut self) {
        if let Some(inner) = self.0.upgrade() {
            inner.claims.send_modify(|claims| *claims = claims.saturating_sub(1));
        }
    }
}

impl KisNotices {
    pub fn new(connect: Option<NoticeConnect>, auth: KisAuth, link: watch::Receiver<LinkState>) -> KisNotices {
        let notices = KisNotices(Arc::new(Inner { wanted: watch::channel(None).0, claims: watch::channel(0).0, cipher: Mutex::new(None), out: broadcast::channel(NOTICE_BUFFER).0, dedicated: Mutex::new(None) }));
        if let Some(connect) = connect {
            tokio::spawn(drive(Arc::downgrade(&notices.0), connect, auth, link, notices.0.wanted.subscribe(), notices.0.claims.subscribe()));
        }
        notices
    }

    pub fn want(&self, hts_id: Option<Secret<String>>) {
        self.0.wanted.send_if_modified(|current| {
            let changed = current.as_ref().map(Secret::expose) != hts_id.as_ref().map(Secret::expose);
            if changed {
                *current = hts_id;
            }
            changed
        });
    }

    pub fn wanted(&self) -> bool {
        self.0.wanted.borrow().is_some()
    }

    pub fn watch_wanted(&self) -> watch::Receiver<Option<Secret<String>>> {
        self.0.wanted.subscribe()
    }

    pub fn subscription(&self) -> Option<Subscription> {
        self.0.wanted.borrow().as_ref().map(|hts_id| Subscription { tr_id: FILL_NOTICE_TR_ID.to_owned(), tr_key: hts_id.expose().clone() })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<FillNotice> {
        self.0.out.subscribe()
    }

    pub fn claim(&self) -> NoticeClaim {
        self.0.claims.send_modify(|claims| *claims += 1);
        drop(self.0.dedicated.lock().expect("체결통보 세션 잠금").take());
        NoticeClaim(Arc::downgrade(&self.0))
    }

    pub fn takes(&self, tr_id: &str) -> bool {
        tr_id == FILL_NOTICE_TR_ID
    }

    pub fn on_registered(&self, subscription: &Subscription, cipher: Option<NoticeCipher>) {
        if subscription.tr_id == FILL_NOTICE_TR_ID && cipher.is_some() {
            *self.0.cipher.lock().expect("체결통보 키 잠금") = cipher;
        }
    }

    pub fn on_sealed(&self, frame: &SealedFrame) {
        let cipher = self.0.cipher.lock().expect("체결통보 키 잠금").clone();
        let Some(plain) = cipher.and_then(|cipher| cipher.open(&frame.payload)) else {
            tracing::warn!("한투 체결통보를 풀지 못해 버립니다");
            return;
        };
        self.publish(read_notices(&plain, frame.count));
    }

    pub fn on_plain(&self, frame: &RealFrame) {
        self.publish(read_notices(&frame.fields.join("^"), frame.count));
    }

    fn publish(&self, notices: Vec<FillNotice>) {
        for notice in notices {
            let _ = self.0.out.send(notice);
        }
    }

    pub fn on_event(&self, event: &StreamEvent) {
        match event {
            StreamEvent::Registered { subscription, cipher } => self.on_registered(subscription, cipher.clone()),
            StreamEvent::Sealed(frame) if self.takes(&frame.tr_id) => self.on_sealed(frame),
            StreamEvent::Frame(frame) if self.takes(&frame.tr_id) => self.on_plain(frame),
            _ => {}
        }
    }
}

async fn pump(notices: Weak<Inner>, mut events: mpsc::Receiver<StreamEvent>) {
    while let Some(event) = events.recv().await {
        let Some(inner) = notices.upgrade() else { return };
        KisNotices(inner).on_event(&event);
    }
}

async fn drive(notices: Weak<Inner>, connect: NoticeConnect, auth: KisAuth, mut link: watch::Receiver<LinkState>, mut wanted: watch::Receiver<Option<Secret<String>>>, mut claims: watch::Receiver<usize>) {
    loop {
        let Some(inner) = notices.upgrade() else { return };
        let hub = KisNotices(inner);
        let connected = *link.borrow_and_update() == LinkState::Connected;
        let unclaimed = *claims.borrow_and_update() == 0;
        let subscription = wanted.borrow_and_update().as_ref().map(|hts_id| Subscription { tr_id: FILL_NOTICE_TR_ID.to_owned(), tr_key: hts_id.expose().clone() });
        {
            let mut dedicated = hub.0.dedicated.lock().expect("체결통보 세션 잠금");
            match subscription.filter(|_| connected && unclaimed) {
                Some(subscription) => {
                    let session = dedicated.get_or_insert_with(|| {
                        let (stream, events) = KisStream::spawn(connect(), auth.clone());
                        Dedicated { stream, pump: tokio::spawn(pump(Arc::downgrade(&hub.0), events)) }
                    });
                    session.stream.set_desired(BTreeSet::from([subscription]));
                }
                None => drop(dedicated.take()),
            }
        }
        drop(hub);
        tokio::select! {
            changed = link.changed() => if changed.is_err() { return },
            changed = wanted.changed() => if changed.is_err() { return },
            changed = claims.changed() => if changed.is_err() { return },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_notice_opens_with_its_key_and_iv_and_a_wrong_key_reads_nothing() {
        use cbc::cipher::BlockEncryptMut;
        let (key, iv) = ("FAKE-NOTICE-KEY-0123456789abcdef".to_owned(), "FAKE-NOTICE-IV-0".to_owned());
        let plain = "fakeuser^5001235601^0000117057^^02^0^00^0^005930^1^71000^093001^0^2^2^91252^1^합성^0^4^Y^^^^^71000";
        let sealed = base64::engine::general_purpose::STANDARD.encode(cbc::Encryptor::<Aes256>::new_from_slices(key.as_bytes(), iv.as_bytes()).unwrap().encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes()));
        let cipher = NoticeCipher::new(key, iv).unwrap();
        assert_eq!(cipher.open(&sealed).as_deref(), Some(plain));
        let wrong = NoticeCipher::new("FAKE-NOTICE-KEY-ffffffffffffffff".into(), "FAKE-NOTICE-IV-0".into()).unwrap();
        assert_ne!(wrong.open(&sealed).as_deref(), Some(plain));
        assert!(NoticeCipher::new("short".into(), "FAKE-NOTICE-IV-0".into()).is_none());
        assert!(!format!("{cipher:?}").contains("FAKE"));

        let notices = read_notices(plain, 1);
        assert_eq!(notices.len(), 1);
        assert_eq!((notices[0].account.expose().as_str(), notices[0].order_no.as_str(), notices[0].filled, notices[0].quantity, notices[0].venue), ("5001235601", "0000117057", true, Some(1), Some(Venue::Nxt)));
    }

    #[test]
    fn the_order_exchange_code_names_where_the_order_went() {
        assert_eq!(["1", "2", "3", "4", "9", ""].map(exchange_venue), [Some(Venue::Krx), Some(Venue::Nxt), Some(Venue::Krx), Some(Venue::Nxt), None, None]);
    }
}
