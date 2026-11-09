use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::{Seen, TOKEN};

pub const DEFAULT_PING_EVERY: Duration = Duration::from_secs(10);
const PING: &str = r#"{"trnm":"PING"}"#;
const REG_LIMIT: usize = 200;
// RFC 6455 7.4.1: 1006은 close 프레임에 실을 수 없는 코드라 프레임 없이 TCP만 끊는다.
const ABNORMAL_CLOSURE: u16 = 1006;

pub struct WsHub {
    sessions: Mutex<HashMap<u64, Session>>,
    next_id: AtomicU64,
    logins: AtomicUsize,
    pongs: AtomicUsize,
    controls: Mutex<Vec<String>>,
    muted: AtomicBool,
    ping_every: watch::Sender<Duration>,
    reg_limit: AtomicUsize,
}

struct Session {
    tx: mpsc::UnboundedSender<Outbound>,
    logged_in: bool,
    registered: BTreeSet<Subscription>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Subscription {
    grp_no: String,
    kind: String,
    item: String,
}

enum Outbound {
    Text(String),
    Close(u16, String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsStats {
    pub sessions: usize,
    pub logins: usize,
    pub pongs: usize,
    pub controls: Vec<String>,
    pub registered: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct Control {
    trnm: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    grp_no: String,
    #[serde(default)]
    data: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    #[serde(default)]
    item: Vec<String>,
    #[serde(rename = "type", default)]
    kind: Vec<String>,
}

impl Default for WsHub {
    fn default() -> WsHub {
        WsHub {
            sessions: Mutex::default(),
            next_id: AtomicU64::default(),
            logins: AtomicUsize::default(),
            pongs: AtomicUsize::default(),
            controls: Mutex::default(),
            muted: AtomicBool::default(),
            ping_every: watch::Sender::new(DEFAULT_PING_EVERY),
            reg_limit: AtomicUsize::new(REG_LIMIT),
        }
    }
}

impl WsHub {
    pub fn push_real(&self, kind: &str, item: &str, values: Value) -> usize {
        if self.muted.load(Ordering::SeqCst) {
            return 0;
        }
        let frame = json!({"trnm": "REAL", "data": [{"type": kind, "name": real_name(kind), "item": item, "values": values}]}).to_string();
        let sessions = self.sessions.lock().unwrap();
        sessions
            .values()
            .filter(|s| s.logged_in && s.registered.iter().any(|r| r.kind == kind && r.item == item))
            .filter(|s| s.tx.send(Outbound::Text(frame.clone())).is_ok())
            .count()
    }

    pub fn drop_sessions(&self, code: u16, reason: &str) {
        for (_, s) in self.sessions.lock().unwrap().drain() {
            let _ = s.tx.send(Outbound::Close(code, reason.to_owned()));
        }
    }

    pub fn mute(&self, on: bool) {
        self.muted.store(on, Ordering::SeqCst);
    }

    pub fn set_reg_limit(&self, limit: usize) {
        self.reg_limit.store(limit, Ordering::SeqCst);
    }

    pub fn set_ping_every(&self, every: Duration) {
        self.ping_every.send_replace(every);
    }

    pub fn reset(&self) {
        self.mute(false);
        self.set_ping_every(DEFAULT_PING_EVERY);
    }

    pub fn stats(&self) -> WsStats {
        let sessions = self.sessions.lock().unwrap();
        let mut registered: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for s in sessions.values() {
            for r in &s.registered {
                registered.entry(r.kind.clone()).or_default().insert(r.item.clone());
            }
        }
        WsStats {
            sessions: sessions.len(),
            logins: self.logins.load(Ordering::SeqCst),
            pongs: self.pongs.load(Ordering::SeqCst),
            controls: self.controls.lock().unwrap().clone(),
            registered: registered.into_iter().map(|(k, items)| (k, items.into_iter().collect())).collect(),
        }
    }

    fn open(&self, tx: mpsc::UnboundedSender<Outbound>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.sessions.lock().unwrap().insert(id, Session { tx, logged_in: false, registered: BTreeSet::new() });
        id
    }

    fn close(&self, id: u64) {
        self.sessions.lock().unwrap().remove(&id);
    }

    fn logged_in(&self, id: u64) -> bool {
        self.sessions.lock().unwrap().get(&id).is_some_and(|s| s.logged_in)
    }

    fn answer(&self, id: u64, text: &str, rejected: impl Fn(&str) -> bool) -> Option<String> {
        if self.muted.load(Ordering::SeqCst) {
            return None;
        }
        let control: Control = serde_json::from_str(text).ok()?;
        if control.trnm == "PING" {
            self.pongs.fetch_add(1, Ordering::SeqCst);
            return None;
        }
        self.controls.lock().unwrap().push(control.trnm.clone());
        let mut sessions = self.sessions.lock().unwrap();
        if control.trnm == "LOGIN" {
            let accepted = issued(&control.token) && !rejected(&control.token);
            return Some(self.login(&mut sessions, id, accepted).to_string());
        }
        let session = sessions.get_mut(&id)?;
        let (code, msg) = if !session.logged_in {
            (100013, "로그인 전 요청입니다")
        } else {
            match control.trnm.as_str() {
                "REG" => register(session, &control, self.reg_limit.load(Ordering::SeqCst)),
                "REMOVE" => remove(session, &control),
                _ => return None,
            }
        };
        Some(json!({"trnm": control.trnm, "return_code": code, "return_msg": msg}).to_string())
    }

    fn login(&self, sessions: &mut HashMap<u64, Session>, id: u64, accepted: bool) -> Value {
        if !accepted || !sessions.contains_key(&id) {
            return json!({"trnm": "LOGIN", "return_code": 3, "return_msg": "인증에 실패했습니다 (CODE=8005, Token이 유효하지 않습니다)"});
        }
        let replaced: Vec<u64> = sessions.iter().filter(|(other, s)| **other != id && s.logged_in).map(|(other, _)| *other).collect();
        for other in replaced {
            if let Some(s) = sessions.remove(&other) {
                let _ = s.tx.send(Outbound::Close(1000, "Bye".to_owned()));
            }
        }
        if let Some(s) = sessions.get_mut(&id) {
            s.logged_in = true;
        }
        self.logins.fetch_add(1, Ordering::SeqCst);
        json!({"trnm": "LOGIN", "return_code": 0, "return_msg": "", "sor_yn": "Y"})
    }
}

fn issued(token: &str) -> bool {
    token == TOKEN || token.starts_with("FAKE-TOKEN-for-")
}

fn subscriptions(control: &Control) -> BTreeSet<Subscription> {
    control
        .data
        .iter()
        .flat_map(|e| e.kind.iter().flat_map(move |kind| e.item.iter().map(move |item| Subscription { grp_no: control.grp_no.clone(), kind: kind.clone(), item: item.clone() })))
        .collect()
}

fn register(session: &mut Session, control: &Control, limit: usize) -> (i64, &'static str) {
    let after: BTreeSet<Subscription> = session.registered.union(&subscriptions(control)).cloned().collect();
    if after.iter().filter(|s| s.grp_no == control.grp_no).count() > limit {
        return (105118, "등록 종목이 그룹번호에 등록할 수 있는 허용 개수(200)를 초과했습니다");
    }
    if after.len() > limit {
        return (105115, "등록 종목이 허용 개수(200)를 초과했습니다");
    }
    session.registered = after;
    (0, "")
}

fn remove(session: &mut Session, control: &Control) -> (i64, &'static str) {
    let kinds: BTreeSet<&str> = control.data.iter().flat_map(|e| e.kind.iter().map(String::as_str)).collect();
    if kinds.len() > 1 {
        return (105112, "실시간 항목 해지에 실패했습니다 (ERROR=서비스를 처리하는 중에 오류가 발생했습니다)");
    }
    for s in subscriptions(control) {
        session.registered.remove(&s);
    }
    (0, "")
}

fn real_name(kind: &str) -> &'static str {
    match kind {
        "0B" => "주식체결",
        "0J" => "업종지수",
        _ => "",
    }
}

async fn upgrade(State(seen): State<Arc<Seen>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| run_session(seen, socket))
}

async fn run_session(seen: Arc<Seen>, mut socket: WebSocket) {
    let hub = &seen.ws;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = hub.open(tx);
    let mut ping_every = hub.ping_every.subscribe();
    let mut last_ping: Option<Instant> = None;
    loop {
        let ping_due = last_ping.map(|at| at + *ping_every.borrow());
        let out = tokio::select! {
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(text))) => hub.answer(id, text.as_str(), |t| seen.is_rejected(t)).map(Outbound::Text),
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => None,
            },
            order = rx.recv() => match order {
                Some(order) => Some(order),
                None => break,
            },
            Ok(()) = ping_every.changed() => None,
            () = tokio::time::sleep_until(ping_due.unwrap_or_else(Instant::now)), if ping_due.is_some() => {
                last_ping = Some(Instant::now());
                Some(Outbound::Text(PING.to_owned()))
            },
        };
        if last_ping.is_none() && hub.logged_in(id) {
            last_ping = Some(Instant::now());
        }
        match out {
            Some(Outbound::Text(text)) if !hub.muted.load(Ordering::SeqCst) => {
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            Some(Outbound::Close(code, reason)) => {
                if code != ABNORMAL_CLOSURE {
                    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
                }
                break;
            }
            _ => {}
        }
    }
    hub.close(id);
}

#[derive(Deserialize)]
struct Real {
    #[serde(rename = "type")]
    kind: String,
    item: String,
    values: Value,
}

#[derive(Deserialize)]
struct DropOrder {
    code: u16,
    reason: String,
}

#[derive(Deserialize)]
struct Mute {
    on: bool,
}

#[derive(Deserialize)]
struct RegLimit {
    limit: usize,
}

#[derive(Deserialize)]
struct PingEvery {
    ms: u64,
}

pub(crate) fn routes() -> Router<Arc<Seen>> {
    Router::new()
        .route("/api/dostk/websocket", get(upgrade))
        .route("/_fake/ws/real", post(admin_real))
        .route("/_fake/ws/drop", post(admin_drop))
        .route("/_fake/ws/mute", post(admin_mute))
        .route("/_fake/ws/ping-every", post(admin_ping_every))
        .route("/_fake/ws/reg-limit", post(admin_reg_limit))
        .route("/_fake/ws/stats", get(admin_stats))
}

async fn admin_real(State(seen): State<Arc<Seen>>, Json(r): Json<Real>) -> Json<Value> {
    Json(json!({"delivered": seen.ws.push_real(&r.kind, &r.item, r.values)}))
}

async fn admin_drop(State(seen): State<Arc<Seen>>, Json(d): Json<DropOrder>) -> StatusCode {
    seen.ws.drop_sessions(d.code, &d.reason);
    StatusCode::NO_CONTENT
}

async fn admin_mute(State(seen): State<Arc<Seen>>, Json(m): Json<Mute>) -> StatusCode {
    seen.ws.mute(m.on);
    StatusCode::NO_CONTENT
}

async fn admin_reg_limit(State(seen): State<Arc<Seen>>, Json(r): Json<RegLimit>) -> StatusCode {
    seen.ws.set_reg_limit(r.limit);
    StatusCode::NO_CONTENT
}

async fn admin_ping_every(State(seen): State<Arc<Seen>>, Json(p): Json<PingEvery>) -> StatusCode {
    seen.ws.set_ping_every(Duration::from_millis(p.ms));
    StatusCode::NO_CONTENT
}

async fn admin_stats(State(seen): State<Arc<Seen>>) -> Json<WsStats> {
    Json(seen.ws.stats())
}

pub fn trade_0b(hhmmss: &str, price: i64, qty: i64, cum: i64, exchange: &str) -> Value {
    json!({
        "20": hhmmss,
        "10": format!("{price:+}"),
        "15": format!("{qty:+}"),
        "13": cum.to_string(),
        "9081": exchange,
        "11": "+0",
        "12": "+0.00",
        "25": if price < 0 { "5" } else { "2" },
    })
}

pub fn tick_0j(hhmmss: &str, value_centi: i64, cum: i64) -> Value {
    let sign = if value_centi < 0 { '-' } else { '+' };
    let abs = value_centi.unsigned_abs();
    json!({
        "20": hhmmss,
        "10": format!("{sign}{}.{:02}", abs / 100, abs % 100),
        "13": cum.to_string(),
        "15": "0",
    })
}
