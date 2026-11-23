use std::collections::BTreeSet;
use std::time::Duration;

use futures::{Sink, SinkExt, Stream, StreamExt, future::BoxFuture};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use super::auth::{AuthError, KisAuth};
use super::notice::NoticeCipher;
use super::error::{Category, Failure, judge_control};

pub const KIS_REALTIME_LIMIT: usize = 40;
const EVENT_BUFFER: usize = 4096;
const BACKOFF: [Duration; 5] = [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(10), Duration::from_secs(30)];
const PINGPONG: &str = "PINGPONG";
const REGISTER: &str = "1";
const UNREGISTER: &str = "2";
const CUSTOMER_TYPE_PERSONAL: &str = "P";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Subscription {
    pub tr_id: String,
    pub tr_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealFrame {
    pub tr_id: String,
    pub count: u32,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedFrame {
    pub tr_id: String,
    pub count: u32,
    pub payload: String,
}

pub fn parse_sealed(text: &str) -> Option<SealedFrame> {
    let mut parts = text.splitn(4, '|');
    let (Some("1"), Some(tr_id), Some(count), Some(payload)) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return None };
    Some(SealedFrame { tr_id: tr_id.to_owned(), count: count.parse().ok()?, payload: payload.to_owned() })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    Malformed,
    Encrypted,
}

pub fn parse_frame(text: &str) -> Result<RealFrame, FrameError> {
    let mut parts = text.splitn(4, '|');
    let (Some(flag), Some(tr_id), Some(count), Some(payload)) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(FrameError::Malformed);
    };
    match flag {
        "0" => {}
        "1" => return Err(FrameError::Encrypted),
        _ => return Err(FrameError::Malformed),
    }
    let count = count.parse().map_err(|_| FrameError::Malformed)?;
    Ok(RealFrame { tr_id: tr_id.to_owned(), count, fields: payload.split('^').map(str::to_owned).collect() })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    ConnectFailed,
    ApprovalFailed,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamStatus {
    Connecting,
    Open,
    Disconnected(End),
    InUseElsewhere,
    Halted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    Registered { subscription: Subscription, cipher: Option<NoticeCipher> },
    Sealed(SealedFrame),
    Rejected { subscription: Option<Subscription>, failure: Failure },
    Frame(RealFrame),
    Disconnected(End),
    InUseElsewhere,
}

pub trait SessionSocket: Sink<Message, Error = WsError> + Stream<Item = Result<Message, WsError>> + Unpin + Send {}

impl<T> SessionSocket for T where T: Sink<Message, Error = WsError> + Stream<Item = Result<Message, WsError>> + Unpin + Send {}

pub type Socket = Box<dyn SessionSocket>;

pub trait Connector: Send + Sync {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>>;
}

pub struct WebSocketConnector(String);

impl WebSocketConnector {
    pub fn new(url: String) -> Self {
        WebSocketConnector(url)
    }
}

impl Connector for WebSocketConnector {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        Box::pin(async { connect_async(self.0.as_str()).await.map(|(socket, _)| Box::new(socket) as Socket) })
    }
}

#[derive(Deserialize, Default)]
struct Control {
    #[serde(default)]
    header: ControlHeader,
    #[serde(default)]
    body: Option<ControlBody>,
}

#[derive(Deserialize, Default)]
struct ControlHeader {
    #[serde(default)]
    tr_id: Option<String>,
    #[serde(default)]
    tr_key: Option<String>,
}

#[derive(Deserialize)]
struct ControlBody {
    #[serde(default)]
    rt_cd: String,
    #[serde(default)]
    msg_cd: String,
    #[serde(default)]
    output: Option<ControlOutput>,
}

#[derive(Deserialize)]
struct ControlOutput {
    #[serde(default)]
    key: String,
    #[serde(default)]
    iv: String,
}

impl Control {
    fn subscription(&self) -> Option<Subscription> {
        Some(Subscription { tr_id: self.header.tr_id.clone()?, tr_key: self.header.tr_key.clone()? })
    }
}

pub struct KisStream {
    desired: watch::Sender<BTreeSet<Subscription>>,
    status: watch::Receiver<StreamStatus>,
}

impl KisStream {
    pub fn spawn(connector: Box<dyn Connector>, auth: KisAuth) -> (KisStream, mpsc::Receiver<StreamEvent>) {
        let (desired_tx, desired_rx) = watch::channel(BTreeSet::new());
        let (status_tx, status_rx) = watch::channel(StreamStatus::Connecting);
        let (events_tx, events_rx) = mpsc::channel(EVENT_BUFFER);
        tokio::spawn(Session { connector, auth, desired: desired_rx, status: status_tx, events: events_tx }.run());
        (KisStream { desired: desired_tx, status: status_rx }, events_rx)
    }

    pub fn set_desired(&self, desired: BTreeSet<Subscription>) {
        self.desired.send_replace(desired);
    }

    pub fn status(&self) -> StreamStatus {
        self.status.borrow().clone()
    }

    pub fn watch_status(&self) -> watch::Receiver<StreamStatus> {
        self.status.clone()
    }
}

struct Session {
    connector: Box<dyn Connector>,
    auth: KisAuth,
    desired: watch::Receiver<BTreeSet<Subscription>>,
    status: watch::Sender<StreamStatus>,
    events: mpsc::Sender<StreamEvent>,
}

enum Ended {
    Lost { was_open: bool, end: End },
    InUseElsewhere,
    Halted,
    Gone,
}

enum Flow {
    Continue,
    Lost,
    InUseElsewhere,
    Gone,
}

impl Session {
    async fn run(mut self) {
        let mut failures = 0;
        loop {
            self.status.send_replace(StreamStatus::Connecting);
            match self.serve().await {
                Ended::Gone => return,
                Ended::Halted => {
                    self.status.send_replace(StreamStatus::Halted);
                    return;
                }
                Ended::InUseElsewhere => {
                    self.status.send_replace(StreamStatus::InUseElsewhere);
                    let _ = self.events.send(StreamEvent::InUseElsewhere).await;
                    return;
                }
                Ended::Lost { was_open, end } => {
                    self.status.send_replace(StreamStatus::Disconnected(end));
                    if self.events.send(StreamEvent::Disconnected(end)).await.is_err() {
                        return;
                    }
                    if was_open {
                        failures = 0;
                    }
                    tokio::time::sleep(BACKOFF[failures.min(BACKOFF.len() - 1)]).await;
                    failures += 1;
                }
            }
        }
    }

    async fn serve(&mut self) -> Ended {
        let approval = match self.auth.approval_key().await {
            Ok(key) => key,
            Err(AuthError::Halted(_)) => return Ended::Halted,
            Err(e) => {
                tracing::warn!(error = %e, "한투 접속키를 받지 못했습니다");
                return Ended::Lost { was_open: false, end: End::ApprovalFailed };
            }
        };
        let mut socket = match self.connector.connect().await {
            Ok(socket) => socket,
            Err(e) => {
                tracing::warn!(error = %e, "한투 실시간 서버에 접속하지 못했습니다");
                return Ended::Lost { was_open: false, end: End::ConnectFailed };
            }
        };
        self.status.send_replace(StreamStatus::Open);
        let mut registered = BTreeSet::new();
        let mut desired = self.desired.borrow_and_update().clone();
        loop {
            if send_changes(&mut socket, approval.expose(), &mut registered, &desired).await.is_err() {
                return Ended::Lost { was_open: true, end: End::Lost };
            }
            let flow = loop {
                tokio::select! {
                    changed = self.desired.changed() => {
                        if changed.is_err() {
                            return Ended::Gone;
                        }
                        desired = self.desired.borrow_and_update().clone();
                        break Flow::Continue;
                    }
                    message = socket.next() => match message {
                        Some(Ok(Message::Text(text))) => match self.handle_text(&mut socket, text.as_str()).await {
                            Flow::Continue => {}
                            other => break other,
                        },
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break Flow::Lost,
                        Some(Ok(_)) => {}
                    },
                }
            };
            match flow {
                Flow::Continue => {}
                Flow::Lost => return Ended::Lost { was_open: true, end: End::Lost },
                Flow::InUseElsewhere => {
                    let _ = socket.close().await;
                    return Ended::InUseElsewhere;
                }
                Flow::Gone => return Ended::Gone,
            }
        }
    }

    async fn handle_text(&self, socket: &mut Socket, text: &str) -> Flow {
        if !text.starts_with('{') {
            return match parse_frame(text) {
                Ok(frame) => self.emit(StreamEvent::Frame(frame)).await,
                Err(FrameError::Encrypted) if let Some(sealed) = parse_sealed(text) => self.emit(StreamEvent::Sealed(sealed)).await,
                Err(error) => {
                    tracing::debug!(?error, "한투 실시간 프레임을 나누지 못해 버립니다");
                    Flow::Continue
                }
            };
        }
        let control: Control = serde_json::from_str(text).unwrap_or_default();
        if control.header.tr_id.as_deref() == Some(PINGPONG) {
            return match socket.send(Message::Text(text.into())).await {
                Ok(()) => Flow::Continue,
                Err(_) => Flow::Lost,
            };
        }
        let Some(body) = &control.body else { return Flow::Continue };
        let Some(failure) = judge_control(&body.rt_cd, &body.msg_cd) else {
            let cipher = body.output.as_ref().and_then(|output| NoticeCipher::new(output.key.clone(), output.iv.clone()));
            return match control.subscription() {
                Some(subscription) => self.emit(StreamEvent::Registered { subscription, cipher }).await,
                None => Flow::Continue,
            };
        };
        tracing::warn!(category = ?failure.category(), code = failure.code(), "한투 실시간 서버가 요청을 받아들이지 않았습니다");
        if failure.category() == Category::InUseElsewhere {
            return Flow::InUseElsewhere;
        }
        self.emit(StreamEvent::Rejected { subscription: control.subscription(), failure }).await
    }

    async fn emit(&self, event: StreamEvent) -> Flow {
        if self.events.send(event).await.is_ok() { Flow::Continue } else { Flow::Gone }
    }
}

async fn send_changes(socket: &mut Socket, approval_key: &str, registered: &mut BTreeSet<Subscription>, desired: &BTreeSet<Subscription>) -> Result<(), WsError> {
    let unregister: Vec<Subscription> = registered.difference(desired).cloned().collect();
    let register: Vec<Subscription> = desired.difference(registered).cloned().collect();
    for (tr_type, subscriptions) in [(UNREGISTER, unregister), (REGISTER, register)] {
        for subscription in subscriptions {
            socket.send(Message::Text(control_frame(approval_key, tr_type, &subscription).into())).await?;
            if tr_type == REGISTER {
                registered.insert(subscription);
            } else {
                registered.remove(&subscription);
            }
        }
    }
    Ok(())
}

fn control_frame(approval_key: &str, tr_type: &str, subscription: &Subscription) -> String {
    json!({
        "header": {"approval_key": approval_key, "custtype": CUSTOMER_TYPE_PERSONAL, "tr_type": tr_type, "content-type": "utf-8"},
        "body": {"input": {"tr_id": subscription.tr_id, "tr_key": subscription.tr_key}},
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kis_realtime_frame_is_split_into_fields() {
        let frame = parse_frame("0|H0STCNT0|001|a^b^c").unwrap();
        assert_eq!(frame, RealFrame { tr_id: "H0STCNT0".into(), count: 1, fields: vec!["a".into(), "b".into(), "c".into()] });
        let two = parse_frame("0|H0STASP0|002|a^b^c^d").unwrap();
        assert_eq!((two.count, two.fields.len()), (2, 4));
    }

    #[test]
    fn kis_realtime_frame_that_is_encrypted_or_malformed_is_refused() {
        assert_eq!(parse_frame("1|H0STCNI0|001|CIPHERTEXT"), Err(FrameError::Encrypted));
        for bad in ["", "0|H0STCNT0", "0|H0STCNT0|x|a^b", "2|H0STCNT0|001|a", "{\"header\":{}}"] {
            assert_eq!(parse_frame(bad), Err(FrameError::Malformed), "{bad}");
        }
    }

    #[test]
    fn an_encrypted_frame_keeps_its_tr_id_count_and_sealed_payload_for_the_notice_reader() {
        assert_eq!(parse_sealed("1|H0STCNI0|001|U0VBTEVE"), Some(SealedFrame { tr_id: "H0STCNI0".into(), count: 1, payload: "U0VBTEVE".into() }));
        for not_sealed in ["0|H0STCNI0|001|a^b", "1|H0STCNI0|x|U0VBTEVE", "1|H0STCNI0"] {
            assert_eq!(parse_sealed(not_sealed), None, "{not_sealed}");
        }
    }

    #[test]
    fn kis_control_frame_carries_the_registration_fields_and_nothing_else_secret() {
        let text = control_frame("FAKE-APPROVAL", UNREGISTER, &Subscription { tr_id: "H0STCNT0".into(), tr_key: "005930".into() });
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["header"]["tr_type"], "2");
        assert_eq!(value["header"]["custtype"], "P");
        assert_eq!(value["body"]["input"], json!({"tr_id": "H0STCNT0", "tr_key": "005930"}));
    }
}
