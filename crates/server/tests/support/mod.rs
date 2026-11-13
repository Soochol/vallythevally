#![allow(dead_code, unused_imports)]

pub mod investors;
pub mod krx;
pub mod summary;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};

pub use krx::{KrxBar, KrxMarket, KrxStock};

pub const APP_KEY: &str = "test-app-key";
pub const APP_SECRET: &str = "test-app-secret";
pub const TOKEN: &str = "test-token";

#[derive(Debug, Clone)]
pub struct ScriptedReply {
    pub status: u16,
    pub body: Value,
    pub delay: Duration,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub api_id: String,
    pub body: Value,
    pub next_key: Option<String>,
}

#[derive(Default)]
struct Replies {
    scripts: HashMap<String, VecDeque<ScriptedReply>>,
    defaults: HashMap<String, (u16, Value)>,
    continuations: HashMap<(String, String), (u16, Value)>,
    delays: HashMap<String, Duration>,
    quotes: Option<Vec<Value>>,
    market: Option<KrxMarket>,
    rejected: Vec<String>,
}

#[derive(Default)]
pub struct Observed {
    pub api_ids: Mutex<Vec<String>>,
    pub authorizations: Mutex<Vec<String>>,
    pub token_bodies: Mutex<Vec<Value>>,
    pub calls: Mutex<Vec<Call>>,
}

#[derive(Clone, Default)]
pub struct ScriptedTransport {
    replies: Arc<Mutex<Replies>>,
    pub seen: Arc<Observed>,
}

impl ScriptedTransport {
    pub fn new() -> Self { Self::default() }
    pub fn transport(&self) -> Arc<dyn Transport> { Arc::new(self.clone()) }
    pub fn respond_with(&self, id: &str, status: u16, body: Value) { self.replies.lock().unwrap().defaults.insert(id.into(), (status, body)); }
    pub fn respond_with_for_key(&self, id: &str, key: &str, status: u16, body: Value) { self.replies.lock().unwrap().continuations.insert((id.into(), key.into()), (status, body)); }
    pub fn script(&self, id: &str, replies: Vec<ScriptedReply>) { self.replies.lock().unwrap().scripts.insert(id.into(), replies.into()); }
    pub fn delay(&self, id: &str, delay: Duration) { self.replies.lock().unwrap().delays.insert(id.into(), delay); }
    pub fn set_quote_rows(&self, rows: Vec<Value>) { self.replies.lock().unwrap().quotes = Some(rows); }
    pub fn set_krx_market(&self, market: KrxMarket) { self.replies.lock().unwrap().market = Some(market); }
    pub fn reject_token(&self, token: &str) { self.replies.lock().unwrap().rejected.push(token.into()); }
    pub fn reset(&self) {
        let mut replies = self.replies.lock().unwrap();
        let market = replies.market.take();
        *replies = Replies { market, ..Replies::default() };
    }
    pub fn api_ids(&self) -> Vec<String> { self.seen.api_ids.lock().unwrap().clone() }
    pub fn calls(&self) -> Vec<Call> { self.seen.calls.lock().unwrap().clone() }
    pub fn requests(&self) -> usize { self.seen.calls.lock().unwrap().len() }
    pub fn issued(&self) -> usize { self.api_ids().iter().filter(|id| *id == "au10001").count() }

    fn reply(&self, req: &HttpRequest) -> (Duration, HttpResponse) {
        let id = req.api_id.as_str();
        let body: Value = serde_json::from_str(req.body.expose()).unwrap();
        let next = req.cont.as_ref().map(|key| key.as_str().to_owned());
        self.seen.api_ids.lock().unwrap().push(id.into());
        self.seen.authorizations.lock().unwrap().push(req.token.as_ref().map(|token| format!("Bearer {}", token.expose())).unwrap_or_default());
        self.seen.calls.lock().unwrap().push(Call { api_id: id.into(), body: body.clone(), next_key: next.clone() });
        let mut replies = self.replies.lock().unwrap();
        if let Some(reply) = replies.scripts.get_mut(id).and_then(VecDeque::pop_front) {
            let mut response = response(reply.body, false);
            response.status = reply.status;
            return (reply.delay, response);
        }
        let delay = replies.delays.get(id).copied().unwrap_or(Duration::ZERO);
        if let Some((status, body)) = next.as_ref().and_then(|key| replies.continuations.get(&(id.into(), key.clone()))).or_else(|| replies.defaults.get(id)).cloned() {
            let mut response = response(body, false);
            response.status = status;
            return (delay, response);
        }
        if req.token.as_ref().is_some_and(|token| replies.rejected.contains(token.expose())) {
            return (delay, response(json!({"return_code":3,"return_msg":"인증 실패[8005:Token이 유효하지 않습니다]"}), true));
        }
        if id == "au10001" {
            self.seen.token_bodies.lock().unwrap().push(body.clone());
            return (delay, response(json!({"return_code":0,"token":token_for(body["appkey"].as_str().unwrap()),"expires_dt":"20991231000000"}), true));
        }
        if id == "ka10095" && let Some(rows) = &replies.quotes {
            return (delay, response(summary::response(rows, &body), true));
        }
        if let Some(market) = &replies.market {
            if let Some(answer) = investors::answer(market, id, &body, next.as_deref()) { return (delay, answer); }
            if let Some(page) = krx::respond(market, id, &body, next.as_deref()) {
                return (delay, match page {
                    krx::KrxPage::Page { body, last } => response(body, last),
                    krx::KrxPage::UnknownNextKey(key) => panic!("unexpected continuation: {key}"),
                });
            }
        }
        let name = match id {
            "ka10099" if body["mrkt_tp"] == "10" => "ka10099_10",
            "ka10099" => "ka10099_0",
            "ka10081" if body["stk_cd"].as_str().is_some_and(|s| s.ends_with("_NX")) => "ka10081_005930_NX",
            "ka10081" if body["stk_cd"].as_str().is_some_and(|s| s.ends_with("_AL")) => "ka10081_005930_AL",
            "ka10081" => "ka10081_005930",
            "ka10080" if body["stk_cd"] == "005935_NX" => "ka10080_005935_NX_1",
            "ka10080" if body["stk_cd"].as_str().is_some_and(|s| s.ends_with("_NX")) => "ka10080_005930_NX_1",
            "ka10080" => "ka10080_005930_3",
            "ka10001" if body["stk_cd"].as_str().is_some_and(|s| s.starts_with("086520")) => "ka10001_086520_AL",
            "ka10001" if body["stk_cd"].as_str().is_some_and(|s| s.starts_with("069500")) => "ka10001_069500_AL",
            "ka10001" => "ka10001_005930_AL",
            "ka10082" => "ka10082_005930_AL",
            "ka10083" => "ka10083_005930_AL",
            "ka10094" => "ka10094_synthetic",
            "ka10095" => "ka10095_synthetic",
            "ka20005" => "ka20005_001_1",
            "ka20006" => "ka20006_001",
            "ka20007" => "ka20007_001",
            "ka20008" => "ka20008_001",
            "ka20019" => "ka20019_synthetic",
            _ => panic!("unscripted transport request: {id}: {body}"),
        };
        let mut value = fixture(name);
        if next.is_some() {
            for value in value.as_object_mut().unwrap().values_mut() { if let Value::Array(rows) = value { rows.clear(); } }
        }
        (delay, response(value, next.is_some()))
    }
}

impl Transport for ScriptedTransport {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let (delay, response) = self.reply(&req);
        Box::pin(async move {
            if !delay.is_zero() { tokio::time::sleep(delay).await; }
            Ok(response)
        })
    }
}

pub fn token_for(key: &str) -> String { if key == APP_KEY { TOKEN.into() } else { format!("test-token-for-{key}") } }

pub fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kiwoom").join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn response(mut body: Value, last: bool) -> HttpResponse {
    let object = body.as_object_mut().unwrap();
    let headers = object.remove("_headers").unwrap_or(Value::Null);
    let status = object.remove("_status").and_then(|s| s.as_u64()).unwrap_or(200) as u16;
    object.retain(|key, _| !key.starts_with('_'));
    let next_key = (!last && headers["cont-yn"] == "Y").then(|| headers["next-key"].as_str().unwrap_or("").to_owned()).filter(|key| !key.is_empty());
    HttpResponse { status, next_key, body: body.to_string() }
}
