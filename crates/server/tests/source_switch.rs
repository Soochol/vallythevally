mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use account_server::SystemClock;
use account_server::fake_idp::{ClientCredentials, FakeIdp};
use common::support::kis_server::{FakeMaster, KisPeer};
use common::{ScriptedTransport, Server};
use domain::KstDate;
use futures::future::BoxFuture;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use server::kis::api::KisApiId;
use server::kis::feed::KisFeedParts;
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use tokio_tungstenite::tungstenite::Message;

const START: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "start");
const NO_KIWOOM_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");
const KIS_KEY: &str = "FAKE-KIS-APPKEY-switch-env-4R7T";
const KIS_SECRET: &str = "FAKE-KIS-SECRET-switch-env-9K2W";
const KIS_ENV: [(&str, &str); 2] = [("VALLY_KIS_APP_KEY", KIS_KEY), ("VALLY_KIS_APP_SECRET", KIS_SECRET)];
const KIS_CLOSE: u64 = 77_777;
const KIS_PRICE: u64 = 77_777;
const KIS_BASE: u64 = 70_000;
const KIWOOM_PRICE: u64 = 51_000;
const KIWOOM_BASE: u64 = 50_000;
const ISSUE_REFUSED: &str = r#"{"error_description":"유효하지 않은 AppKey입니다.","error_code":"EGW00999"}"#;

struct FakeKis {
    paths: Mutex<Vec<String>>,
    refuse_issue: AtomicBool,
}

impl FakeKis {
    fn new() -> Arc<FakeKis> {
        Arc::new(FakeKis { paths: Mutex::default(), refuse_issue: AtomicBool::new(false) })
    }

    fn sent_to(&self, api: KisApiId) -> usize {
        self.paths.lock().unwrap().iter().filter(|path| *path == api.path()).count()
    }

    fn minute_charts_sent(&self) -> usize {
        self.sent_to(KisApiId::TodayMinuteChart) + self.sent_to(KisApiId::PastMinuteChart)
    }
}

fn weekdays_ending(end: KstDate, count: usize) -> Vec<KstDate> {
    let mut days = Vec::new();
    let mut day = end;
    while days.len() < count {
        if !matches!(day.weekday(), domain::Weekday::Sat | domain::Weekday::Sun) {
            days.push(day);
        }
        day = day.add_days(-1);
    }
    days
}

fn daily_chart() -> String {
    let newest_kiwoom_fixture_day = KstDate::new(2026, 11, 6).unwrap();
    let rows: Vec<Value> = weekdays_ending(newest_kiwoom_fixture_day, 5)
        .into_iter()
        .map(|day| json!({"stck_bsop_date": day.yyyymmdd(), "stck_clpr": KIS_CLOSE.to_string(), "stck_oprc": KIS_CLOSE.to_string(), "stck_hgpr": KIS_CLOSE.to_string(), "stck_lwpr": KIS_CLOSE.to_string(), "acml_vol": "1000", "acml_tr_pbmn": "1"}))
        .collect();
    json!({"rt_cd": "0", "msg_cd": "MCA00000", "output1": {}, "output2": rows}).to_string()
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        self.paths.lock().unwrap().push(req.path.to_owned());
        let body = match req.path {
            "/oauth2/tokenP" if self.refuse_issue.load(Ordering::SeqCst) => return Box::pin(async { Ok(HttpResponse { status: 403, tr_cont: None, body: ISSUE_REFUSED.into() }) }),
            "/oauth2/tokenP" => json!({"access_token": "FAKE-KIS-TOKEN-switch", "expires_in": 86_400}).to_string(),
            "/oauth2/Approval" => json!({"approval_key": "FAKE-KIS-APPROVAL-switch"}).to_string(),
            path if path == KisApiId::DailyChart.path() => daily_chart(),
            path if path == KisApiId::MultiPrice.path() => json!({"rt_cd": "0", "msg_cd": "MCA00000", "output": [{"inter_shrn_iscd": "005930", "inter2_prpr": KIS_PRICE.to_string(), "inter2_sdpr": KIS_BASE.to_string(), "acml_vol": "1000", "acml_tr_pbmn": "5000000000"}]}).to_string(),
            _ => json!({"rt_cd": "1", "msg_cd": "EGW99999", "msg1": "시험이 정하지 않은 요청"}).to_string(),
        };
        Box::pin(async move { Ok(HttpResponse { status: 200, tr_cont: None, body }) })
    }
}

#[derive(Clone, Debug)]
struct KiwoomFrame {
    trnm: String,
    items: Vec<String>,
}

struct KiwoomPeer {
    url: String,
    seen: Arc<Mutex<Vec<KiwoomFrame>>>,
}

impl KiwoomPeer {
    async fn start() -> KiwoomPeer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<KiwoomFrame>>> = Arc::default();
        let record = seen.clone();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let record = record.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(tcp).await else { return };
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let body: Value = serde_json::from_str(text.as_str()).unwrap();
                        let trnm = body["trnm"].as_str().unwrap().to_owned();
                        if trnm == "PING" {
                            let _ = socket.send(Message::Text(text)).await;
                            continue;
                        }
                        let items = body["data"].as_array().into_iter().flatten().flat_map(|entry| entry["item"].as_array().cloned().unwrap_or_default()).filter_map(|item| item.as_str().map(str::to_owned)).collect();
                        record.lock().unwrap().push(KiwoomFrame { trnm: trnm.clone(), items });
                        let ack = json!({"trnm": trnm, "return_code": 0, "return_msg": ""});
                        if socket.send(Message::Text(ack.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        KiwoomPeer { url, seen }
    }

    fn holds(&self, item_prefix: &str) -> bool {
        let mut held = false;
        for frame in self.seen.lock().unwrap().iter().filter(|frame| frame.items.iter().any(|item| item.starts_with(item_prefix))) {
            match frame.trnm.as_str() {
                "REG" => held = true,
                "REMOVE" => held = false,
                _ => {}
            }
        }
        held
    }
}

struct Env {
    _tmp: tempfile::TempDir,
    lock: PathBuf,
    dist: PathBuf,
}

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
        let lock = tmp.path().join("state/vallythevally/server.lock");
        Env { lock, dist, _tmp: tmp }
    }

    fn dir(&self) -> &Path {
        self.lock.parent().unwrap()
    }

    fn spawn(&self, kiwoom: &ScriptedTransport, kis: &Arc<FakeKis>, peer: &KisPeer, extra: &[(&str, &str)]) -> Server {
        let overrides: Vec<(&str, &std::ffi::OsStr)> = extra.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))).collect();
        let parts = KisFeedParts { connect: peer.connect(), master: Arc::new(FakeMaster) };
        Server::spawn_with_kis_feed(kiwoom, Some(kis.clone()), Some(parts), &self.lock, &self.dist, &overrides)
    }
}

struct Client {
    base: String,
    http: reqwest::Client,
}

impl Client {
    async fn of(server: &Server) -> Client {
        Client { base: format!("http://{}", server.addr().await), http: reqwest::Client::new() }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let request = self.http.request(method, format!("{}{path}", self.base)).header("content-type", "application/json");
        let request = match body {
            Some(body) => request.body(body.to_string()),
            None => request,
        };
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        self.send(reqwest::Method::GET, path, None).await
    }

    async fn key(&self, id: &str) -> Value {
        self.get("/api/system/kiwoom/keys").await.1["keys"].as_array().unwrap().iter().find(|key| key["keyId"] == id).cloned().unwrap_or(Value::Null)
    }

    async fn until_key_state(&self, id: &str, wanted: &str) -> Value {
        until(&format!("키 {id}의 연결 상태 {wanted}"), || async {
            let key = self.key(id).await;
            (key["link"]["state"] == wanted).then_some(key)
        })
        .await
    }

    async fn designate(&self, id: &str) {
        let (status, body) = self.send(reqwest::Method::PUT, "/api/system/kiwoom/market-key", Some(json!({"keyId": id}))).await;
        assert_eq!(status, 200, "{body}");
    }

    async fn daily_closes(&self) -> Vec<f64> {
        let (status, body) = self.get("/api/bars?symbol=005930&period=D&limit=20").await;
        assert_eq!(status, 200, "{body}");
        body["bars"].as_array().unwrap().iter().map(|bar| bar["c"].as_f64().unwrap()).collect()
    }
}

async fn until<T, F: std::future::Future<Output = Option<T>>>(what: &str, mut check: impl FnMut() -> F) -> T {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(found) = check().await {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("기다리던 것이 오지 않았다: {what}"))
}

type Browser = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn subscribe_to_samsung(server: &Server) -> Browser {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", server.addr().await)).await.unwrap();
    ws.send(Message::Text(r#"{"type":"subscribe","sub":"c0","symbol":"005930","venue":null,"period":"D"}"#.into())).await.unwrap();
    ws
}

async fn next_of_type(ws: &mut Browser, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Some(Ok(Message::Text(text))) = ws.next().await else { panic!("브라우저 연결이 닫혔다") };
            let value: Value = serde_json::from_str(text.as_str()).unwrap();
            if value["type"] == kind {
                return value;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{kind} 메시지가 오지 않았다"))
}

async fn next_reload_because(ws: &mut Browser, reason: &str) -> Value {
    loop {
        let reload = next_of_type(ws, "reload").await;
        if reload["reason"] == reason {
            return reload;
        }
    }
}

#[tokio::test]
async fn with_only_a_kis_env_key_the_bars_come_from_the_kis_transport_and_kiwoom_gets_nothing() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let mut extra = vec![NO_KIWOOM_KEY, START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    let source = client.until_key_state("env-kis", "connected").await;
    assert_eq!(source["market"], true, "{source}");
    let closes = client.daily_closes().await;
    assert!(!closes.is_empty() && closes.iter().all(|close| *close == KIS_CLOSE as f64), "{closes:?}");
    assert!(kis.sent_to(KisApiId::DailyChart) >= 1);
    assert_eq!(kiwoom.api_ids(), Vec::<String>::new(), "키움 transport에는 요청이 0건이다");
    let (status, found) = client.get("/api/symbols?q=삼성").await;
    assert_eq!(status, 200, "{found}");
    assert!(found.to_string().contains("005930"), "종목 목록은 한투 마스터 파일에서 왔다: {found}");
    server.stop().await;
}

#[tokio::test]
async fn switching_the_source_to_kis_moves_open_subscriptions_off_kiwoom_and_drops_the_bar_cache() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let kiwoom_ws = KiwoomPeer::start().await;
    let mut extra = vec![START, ("VALLY_KIWOOM_WS_URL", kiwoom_ws.url.as_str())];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    let mut browser = subscribe_to_samsung(&server).await;
    until("키움 세션에 삼성전자 구독", || async { kiwoom_ws.holds("005930").then_some(()) }).await;
    let kiwoom_closes = client.daily_closes().await;
    assert!(kiwoom_closes.iter().all(|close| *close != KIS_CLOSE as f64), "처음에는 키움 봉이다: {kiwoom_closes:?}");
    let kiwoom_charts = kiwoom.api_ids().iter().filter(|id| *id == "ka10081").count();
    assert_eq!(kis.sent_to(KisApiId::DailyChart), 0);

    client.designate("env-kis").await;
    let reload = next_reload_because(&mut browser, "daily_reset").await;
    assert_eq!(reload["reason"], "daily_reset", "브라우저는 지금의 비우기 알림 경로로 다시 받는다: {reload}");
    until("키움 세션의 시세 구독이 내려감", || async { (!kiwoom_ws.holds("005930")).then_some(()) }).await;
    until("한투 세션에 열린 구독이 다시 등록됨", || async { peer.registered().contains(&("H0UNCNT0".to_owned(), "005930".to_owned())).then_some(()) }).await;
    let closes = client.daily_closes().await;
    assert!(closes.iter().all(|close| *close == KIS_CLOSE as f64), "봉 캐시가 비어 다음 봉은 한투에서 받는다: {closes:?}");
    assert_eq!(kiwoom.api_ids().iter().filter(|id| *id == "ka10081").count(), kiwoom_charts, "바꾼 뒤에는 키움으로 봉을 묻지 않는다");
    assert_eq!(client.key("env").await["link"]["state"], "connected", "키움 키는 연결된 채다");

    client.designate("env").await;
    until("키움 세션에 다시 등록", || async { kiwoom_ws.holds("005930").then_some(()) }).await;
    until("한투 세션 구독이 내려감", || async { peer.registered().is_empty().then_some(()) }).await;
    let back = client.daily_closes().await;
    assert!(back.iter().all(|close| *close != KIS_CLOSE as f64), "되돌리면 키움 봉이다: {back:?}");
    server.stop().await;
}

#[tokio::test]
async fn a_kiwoom_chart_answer_that_lands_after_the_switch_is_not_kept_in_the_bar_cache() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    let held = kiwoom.hold("키움 일봉", |call| call.api_id == "ka10081");
    let slow = tokio::spawn({
        let client = Client { base: client.base.clone(), http: reqwest::Client::new() };
        async move { client.daily_closes().await }
    });
    held.arrived().await;
    client.designate("env-kis").await;
    held.release();
    let late = slow.await.unwrap();
    assert!(late.iter().all(|close| *close != KIS_CLOSE as f64), "바꾸기 전에 보낸 요청은 자기 응답(키움)을 받는다: {late:?}");
    let after = client.daily_closes().await;
    assert!(after.iter().all(|close| *close == KIS_CLOSE as f64), "늦게 온 키움 응답은 새 캐시에 남지 않는다: {after:?}");
    server.stop().await;
}

#[tokio::test]
async fn a_kis_source_key_refused_at_issue_or_stopped_by_opsp8996_on_its_stream_leaves_the_kiwoom_key_connected() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    peer.answer_in_use.store(true, Ordering::SeqCst);
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    client.designate("env-kis").await;
    let _browser = subscribe_to_samsung(&server).await;
    let stopped = client.until_key_state("env-kis", "failed").await;
    assert!(stopped["link"]["message"].as_str().is_some_and(|message| message.contains("OPSP8996")), "{stopped}");
    assert_eq!(client.key("env").await["link"]["state"], "connected");
    assert_eq!(client.get("/api/system/kiwoom").await.1["state"], "connected");
    server.stop().await;

    let refusing = FakeKis::new();
    refusing.refuse_issue.store(true, Ordering::SeqCst);
    std::fs::remove_file(env.dir().join("kis-token.json")).unwrap();
    let restarted = env.spawn(&ScriptedTransport::new(), &refusing, &KisPeer::default(), &extra);
    let client = Client::of(&restarted).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "failed").await;
    client.designate("env-kis").await;
    let blocked = client.until_key_state("env-kis", "failed").await;
    assert_eq!((blocked["link"]["problem"].as_str(), blocked["market"].as_bool()), (Some("keyNeedsCheck"), Some(true)), "{blocked}");
    let (status, refused) = client.get("/api/bars?symbol=005930&period=D").await;
    assert_ne!(status, 200, "연결되지 않은 한투 공급원은 봉을 주지 않는다: {refused}");
    assert_eq!(client.key("env").await["link"]["state"], "connected");
    assert_eq!(client.get("/api/system/kiwoom").await.1["state"], "connected");
    restarted.stop().await;
}

async fn market_source(client: &Client) -> Value {
    let (status, body) = client.get("/api/system/market-source").await;
    assert_eq!(status, 200, "{body}");
    body
}

async fn until_market_source(client: &Client, what: &str, ready: impl Fn(&Value) -> bool) -> Value {
    until(what, || async {
        let body = market_source(client).await;
        ready(&body).then_some(body)
    })
    .await
}

fn feature_names(status: &Value) -> Vec<String> {
    status["features"].as_array().unwrap().iter().map(|name| name.as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn the_market_source_status_follows_the_source_key_and_the_broker_that_receives_rankings() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;

    let on_kiwoom = until_market_source(&client, "키움 공급원과 키움 수신", |status| status["broker"] == "kiwoom" && status["state"] == "connected" && status["feedBroker"]["broker"] == "kiwoom").await;
    assert_eq!(on_kiwoom["keyId"], "env", "{on_kiwoom}");
    assert!(feature_names(&on_kiwoom).contains(&"dayBars".to_owned()), "{on_kiwoom}");
    assert!(on_kiwoom["feedBroker"]["rankingKinds"].as_array().unwrap().iter().any(|kind| kind == "foreignStreak"), "{on_kiwoom}");
    assert!(on_kiwoom["feedBroker"]["overviewFeatures"].as_array().unwrap().iter().any(|feature| feature == "streaks"), "{on_kiwoom}");
    assert!(!on_kiwoom["feedBroker"]["rankingChoices"].as_array().unwrap().is_empty(), "{on_kiwoom}");

    client.designate("env-kis").await;
    let on_kis = until_market_source(&client, "한투 공급원, 수신은 키움 그대로", |status| status["broker"] == "kis" && status["state"] == "connected").await;
    assert_eq!(on_kis["keyId"], "env-kis", "{on_kis}");
    assert_eq!(on_kis["feedBroker"]["broker"], "kiwoom", "연결된 키움 키가 있으면 공급원이 한투여도 수신은 키움이다: {on_kis}");

    let (status, _) = client.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env/disconnect", None).await;
    assert_eq!(status, 200);
    let kis_only = until_market_source(&client, "키움을 끊으면 수신은 한투", |status| status["feedBroker"]["broker"] == "kis").await;
    assert_eq!(kis_only["broker"], "kis", "{kis_only}");
    let kis_kinds: Vec<&str> = kis_only["feedBroker"]["rankingKinds"].as_array().unwrap().iter().map(|kind| kind.as_str().unwrap()).collect();
    assert!(!kis_kinds.contains(&"foreignStreak") && !kis_kinds.contains(&"program"), "한투에 없는 순위는 기능 집합에 없다: {kis_kinds:?}");
    assert!(!kis_only["feedBroker"]["overviewFeatures"].as_array().unwrap().iter().any(|feature| feature == "streaks"), "{kis_only}");
    server.stop().await;
}

#[tokio::test]
async fn no_connected_key_means_no_feed_broker_and_the_status_names_the_link_state() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let server = env.spawn(&kiwoom, &kis, &peer, &[NO_KIWOOM_KEY]);
    let client = Client::of(&server).await;
    let status = market_source(&client).await;
    assert_eq!(status["broker"], "kiwoom", "{status}");
    assert_eq!(status["state"], "noKey", "{status}");
    assert!(status["feedBroker"].is_null(), "{status}");
    assert!(status["keyId"].is_null(), "{status}");
    server.stop().await;
}

#[tokio::test]
async fn the_key_list_and_the_market_source_status_never_carry_a_secret_or_a_whole_app_key() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    let saved_kiwoom = ("FAKE-KIWOOM-APPKEY-saved-1Q2W", "FAKE-KIWOOM-SECRET-saved-3E4R");
    let saved_kis = ("FAKE-KIS-APPKEY-saved-5T6Y", "FAKE-KIS-SECRET-saved-7U8I");
    for (broker, (app_key, secret)) in [("kiwoom", saved_kiwoom), ("kis", saved_kis)] {
        let (status, body) = client.send(reqwest::Method::POST, "/api/system/kiwoom/keys", Some(json!({"alias": broker, "appKey": app_key, "appSecret": secret, "broker": broker}))).await;
        assert_eq!(status, 200, "{body}");
    }
    let listing = client.get("/api/system/kiwoom/keys").await.1.to_string();
    let sources = [market_source(&client).await.to_string(), client.get("/api/system/kiwoom").await.1.to_string()];
    let carried = [KIS_KEY, KIS_SECRET, saved_kiwoom.0, saved_kiwoom.1, saved_kis.0, saved_kis.1];
    for text in sources.iter().chain([&listing]) {
        for secret in carried {
            assert!(!text.contains(secret), "응답에 {secret}가 들어 있다: {text}");
        }
    }
    assert!(listing.contains("\"broker\":\"kis\""), "{listing}");
    server.stop().await;
}

#[tokio::test]
async fn the_socket_sends_the_market_source_on_connect_and_again_only_when_it_changes() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/ws", server.addr().await)).await.unwrap();
    let first = next_of_type(&mut ws, "market_source").await;
    assert_eq!(first["status"]["broker"], "kiwoom", "{first}");
    assert_eq!(first["status"]["feedBroker"]["broker"], "kiwoom", "{first}");

    client.designate("env-kis").await;
    let mut previous = first["status"].clone();
    let switched = loop {
        let next = next_of_type(&mut ws, "market_source").await["status"].clone();
        assert_ne!(next, previous, "같은 값을 되풀이해 보내지 않는다");
        if next["broker"] == "kis" && next["state"] == "connected" {
            break next;
        }
        previous = next;
    };
    assert_eq!(switched["keyId"], "env-kis", "{switched}");

    let (status, _) = client.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env/disconnect", None).await;
    assert_eq!(status, 200);
    let mut previous = switched;
    let lost_kiwoom = loop {
        let next = next_of_type(&mut ws, "market_source").await["status"].clone();
        assert_ne!(next, previous, "같은 값을 되풀이해 보내지 않는다");
        if next["feedBroker"]["broker"] == "kis" {
            break next;
        }
        previous = next;
    };
    assert_eq!(lost_kiwoom["broker"], "kis", "{lost_kiwoom}");
    server.stop().await;
}

async fn symbol_found(client: &Client, code: &str) -> bool {
    let (status, found) = client.get(&format!("/api/symbols?q={code}")).await;
    status == 200 && found.to_string().contains(code)
}

#[tokio::test]
async fn a_kiwoom_symbol_list_that_lands_after_the_switch_to_kis_does_not_replace_the_kis_directory() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let held = kiwoom.hold("키움 종목 목록", |call| call.api_id == "ka10099");
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    held.arrived().await;
    client.until_key_state("env-kis", "connected").await;
    client.designate("env-kis").await;
    until("한투 마스터 목록", || async { symbol_found(&client, "247540").await.then_some(()) }).await;
    held.release();
    client.until_key_state("env", "connected").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(symbol_found(&client, "247540").await, "한투 목록이 그대로다");
    assert!(!symbol_found(&client, "094800").await, "늦게 온 키움 종목 목록이 디렉터리를 덮지 않는다");
    server.stop().await;
}

async fn update_screener(client: &Client) -> (u16, Value) {
    client.send(reqwest::Method::POST, "/api/screener/update", Some(json!({"full": false}))).await
}

#[tokio::test]
async fn the_screener_update_is_refused_while_no_kiwoom_key_is_connected_whatever_the_reason() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let mut extra = vec![NO_KIWOOM_KEY, START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env-kis", "connected").await;
    let (status, body) = update_screener(&client).await;
    assert_eq!((status, body["error"]["reason"].as_str()), (400, Some("unsupported_by_source")), "{body}");
    let (status, _) = client.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env-kis/disconnect", None).await;
    assert_eq!(status, 200);
    client.until_key_state("env-kis", "disconnected").await;
    let (status, body) = update_screener(&client).await;
    assert_eq!((status, body["error"]["reason"].as_str()), (400, Some("unsupported_by_source")), "한투도 끊겨 아무 키도 연결되지 않았다: {body}");
    assert_eq!(kiwoom.api_ids(), Vec::<String>::new());
    server.stop().await;
}

#[tokio::test]
async fn a_market_key_chosen_among_environment_keys_alone_survives_a_restart() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(&kiwoom, &kis, &peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env-kis", "connected").await;
    client.designate("env-kis").await;
    server.stop().await;
    let server = env.spawn(&kiwoom, &FakeKis::new(), &peer, &extra);
    let client = Client::of(&server).await;
    assert_eq!(client.key("env-kis").await["market"], true, "고른 시세 공급원이 다시 켠 뒤에도 남는다");
    client.designate("env").await;
    server.stop().await;
    let server = env.spawn(&kiwoom, &FakeKis::new(), &peer, &extra);
    let client = Client::of(&server).await;
    assert_eq!(client.key("env").await["market"], true, "기본값으로 돌아오면 다시 켠 뒤에도 기본값이다");
    server.stop().await;
}

fn kiwoom_quote(transport: &ScriptedTransport) {
    let row = json!({"stk_cd": "005930_AL", "stk_nm": "삼성전자", "cur_prc": KIWOOM_PRICE.to_string(), "base_pric": KIWOOM_BASE.to_string(), "pred_pre": "1000", "pred_pre_sig": "2", "flu_rt": "0", "trde_qty": "100", "trde_prica": "5000", "open_pric": "1", "high_pric": "1", "low_pric": "1", "close_pric": "1", "cntr_tm": "100000", "dt": "20261119", "upl_pric": "1", "lst_pric": "1"});
    transport.respond_with("ka10095", 200, json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "atn_stk_infr": [row]}));
}

fn kiwoom_minutes(transport: &ScriptedTransport, today: KstDate) {
    let row = |day: KstDate, time: &str, close: u64| json!({"cntr_tm": format!("{}{time}", day.yyyymmdd()), "open_pric": close.to_string(), "high_pric": close.to_string(), "low_pric": close.to_string(), "cur_prc": close.to_string(), "trde_qty": "10"});
    let yesterday = today.add_days(-1);
    let rows = vec![row(today, "090100", 10_200), row(today, "090000", 10_100), row(yesterday, "153000", 10_000)];
    transport.respond_with("ka10080", 200, json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_min_pole_chart_qry": rows}));
}

async fn heatmap_themes(client: &Client) {
    let themes = json!([{"id": "CHIP", "name": "반도체", "symbols": ["005930"]}]);
    let (status, body) = client.send(reqwest::Method::PUT, "/api/heatmap/themes", Some(json!({"themes": themes, "revision": 1}))).await;
    assert_eq!(status, 200, "{body}");
}

async fn board_rate(client: &Client) -> f64 {
    let (status, body) = client.get("/api/heatmap/board").await;
    assert_eq!(status, 200, "{body}");
    body["themes"][0]["members"][0]["changeRate"].as_f64().unwrap_or_else(|| panic!("보드에 삼성전자 등락률이 없다: {body}"))
}

fn kiwoom_rate() -> f64 {
    2.0
}

async fn flow_points(client: &Client) -> Value {
    let (_, body) = client.get("/api/heatmap/flow?symbols=005930").await;
    body["points"].clone()
}

async fn switched_to_kis(client: &Client) {
    client.designate("env-kis").await;
    until_market_source(client, "한투 공급원으로 바뀜", |status| status["broker"] == "kis").await;
}

async fn connected_pair(kiwoom: &ScriptedTransport, kis: &Arc<FakeKis>, peer: &KisPeer, env: &Env) -> (Server, Client) {
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let server = env.spawn(kiwoom, kis, peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    (server, client)
}

#[tokio::test]
async fn switching_the_source_drops_the_heatmap_quote_cache_so_the_next_board_comes_from_the_new_source() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    kiwoom_quote(&kiwoom);
    let (server, client) = connected_pair(&kiwoom, &kis, &peer, &env).await;
    heatmap_themes(&client).await;
    assert_eq!(board_rate(&client).await, kiwoom_rate());
    let kiwoom_asked = kiwoom.api_ids().iter().filter(|id| *id == "ka10095").count();
    assert_eq!(board_rate(&client).await, kiwoom_rate());
    assert_eq!(kiwoom.api_ids().iter().filter(|id| *id == "ka10095").count(), kiwoom_asked, "바꾸기 전에는 캐시가 답한다");

    switched_to_kis(&client).await;
    let on_kis = board_rate(&client).await;
    assert_ne!(on_kis, kiwoom_rate(), "캐시에 남은 키움 시세를 돌려주지 않는다");
    assert_eq!(kis.sent_to(KisApiId::MultiPrice), 1, "새 공급원에서 시세를 새로 받는다");
    assert_eq!(kiwoom.api_ids().iter().filter(|id| *id == "ka10095").count(), kiwoom_asked, "바꾼 뒤에는 키움으로 시세를 묻지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn a_kiwoom_quote_answer_that_lands_after_the_switch_is_not_kept_in_the_heatmap_quote_cache() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    kiwoom_quote(&kiwoom);
    let (server, client) = connected_pair(&kiwoom, &kis, &peer, &env).await;
    heatmap_themes(&client).await;
    let held = kiwoom.hold("키움 현재가", |call| call.api_id == "ka10095");
    let slow = tokio::spawn({
        let client = Client { base: client.base.clone(), http: reqwest::Client::new() };
        async move { board_rate(&client).await }
    });
    held.arrived().await;
    switched_to_kis(&client).await;
    held.release();
    assert_eq!(slow.await.unwrap(), kiwoom_rate(), "바꾸기 전에 보낸 요청은 자기 응답(키움)을 받는다");
    assert_ne!(board_rate(&client).await, kiwoom_rate(), "늦게 온 키움 시세는 새 캐시에 남지 않는다");
    assert_eq!(kis.sent_to(KisApiId::MultiPrice), 1);
    server.stop().await;
}

#[tokio::test]
async fn switching_the_source_drops_the_heatmap_flow_cache_so_the_next_flow_is_read_from_the_new_source() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let (server, client) = connected_pair(&kiwoom, &kis, &peer, &env).await;
    kiwoom_minutes(&kiwoom, server.clock().now().kst_date());
    let from_kiwoom = flow_points(&client).await;
    assert!(from_kiwoom.as_array().is_some_and(|points| !points.is_empty()), "키움 분봉으로 흐름이 나온다: {from_kiwoom}");
    let kiwoom_asked = kiwoom.api_ids().iter().filter(|id| *id == "ka10080").count();
    assert_eq!(flow_points(&client).await, from_kiwoom);
    assert_eq!(kiwoom.api_ids().iter().filter(|id| *id == "ka10080").count(), kiwoom_asked, "바꾸기 전에는 캐시가 답한다");
    assert_eq!(kis.minute_charts_sent(), 0);

    switched_to_kis(&client).await;
    assert_ne!(flow_points(&client).await, from_kiwoom, "캐시에 남은 키움 흐름을 돌려주지 않는다");
    assert!(kis.minute_charts_sent() >= 1, "새 공급원에서 분봉을 새로 받는다");
    assert_eq!(kiwoom.api_ids().iter().filter(|id| *id == "ka10080").count(), kiwoom_asked, "바꾼 뒤에는 키움으로 분봉을 묻지 않는다");
    server.stop().await;
}

#[tokio::test]
async fn a_kiwoom_minute_answer_that_lands_after_the_switch_is_not_kept_in_the_heatmap_flow_cache() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    let (server, client) = connected_pair(&kiwoom, &kis, &peer, &env).await;
    kiwoom_minutes(&kiwoom, server.clock().now().kst_date());
    let held = kiwoom.hold("키움 분봉", |call| call.api_id == "ka10080");
    let slow = tokio::spawn({
        let client = Client { base: client.base.clone(), http: reqwest::Client::new() };
        async move { flow_points(&client).await }
    });
    held.arrived().await;
    switched_to_kis(&client).await;
    held.release();
    let late = slow.await.unwrap();
    assert!(late.as_array().is_some_and(|points| !points.is_empty()), "바꾸기 전에 보낸 요청은 자기 응답(키움)을 받는다: {late}");
    assert_ne!(flow_points(&client).await, late, "늦게 온 키움 분봉은 새 캐시에 남지 않는다");
    assert!(kis.minute_charts_sent() >= 1);
    server.stop().await;
}

const FRIDAY_EVENING: &str = "20261106203000";
const GOOGLE_SECRET: &str = "google-secret-source-switch-5t2q";
const NAVER_SECRET: &str = "naver-secret-source-switch-8d4m";
const MARKET_CARD: &str = "/api/market-overview/index?market=kospi";

fn weekdays_before_friday(count: usize) -> Vec<String> {
    let mut days: Vec<String> = weekdays_ending(KstDate::new(2026, 11, 5).unwrap(), count).into_iter().map(|day| day.yyyymmdd().to_string()).collect();
    days.reverse();
    days
}

fn script_market_card(kiwoom: &ScriptedTransport) {
    let indices = json!({"all_inds_idex": [
        {"stk_cd": "001", "stk_nm": "종합(KOSPI)", "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
        {"stk_cd": "101", "stk_nm": "종합(KOSDAQ)", "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"}
    ], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"});
    let days: Vec<Value> = weekdays_before_friday(24).iter().map(|day| json!({"dt": day, "cur_prc": "505969", "open_pric": "505969", "high_pric": "505969", "low_pric": "505969", "trde_qty": "1", "trde_prica": "100"})).collect();
    kiwoom.respond_with("ka20003", 200, indices);
    kiwoom.respond_with("ka20006", 200, json!({"inds_dt_pole_qry": days, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"}));
}

fn public_vars(idp: &FakeIdp, port: u16) -> Vec<(String, String)> {
    [
        ("VALLY_PUBLIC_BIND", format!("127.0.0.1:{port}")),
        ("VALLY_PUBLIC_ORIGIN", format!("http://127.0.0.1:{port}")),
        ("VALLY_PUBLIC_GOOGLE_CLIENT_ID", "google-id".to_owned()),
        ("VALLY_PUBLIC_GOOGLE_CLIENT_SECRET", GOOGLE_SECRET.to_owned()),
        ("VALLY_PUBLIC_GOOGLE_AUTHORIZE_URL", idp.url("/google/authorize")),
        ("VALLY_PUBLIC_GOOGLE_TOKEN_URL", idp.url("/google/token")),
        ("VALLY_PUBLIC_NAVER_CLIENT_ID", "naver-id".to_owned()),
        ("VALLY_PUBLIC_NAVER_CLIENT_SECRET", NAVER_SECRET.to_owned()),
        ("VALLY_PUBLIC_NAVER_AUTHORIZE_URL", idp.url("/naver/authorize")),
        ("VALLY_PUBLIC_NAVER_TOKEN_URL", idp.url("/naver/token")),
        ("VALLY_PUBLIC_NAVER_PROFILE_URL", idp.url("/naver/profile")),
        ("VALLY_CLOCK_START", FRIDAY_EVENING.to_owned()),
        ("VALLY_KIS_BASE_URL", "http://127.0.0.1:1".to_owned()),
        ("VALLY_KIS_WS_URL", "ws://127.0.0.1:1".to_owned()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn set_cookies(headers: &reqwest::header::HeaderMap) -> BTreeMap<String, String> {
    headers.get_all("set-cookie").iter().filter_map(|line| line.to_str().ok()?.split(';').next()?.split_once('=').map(|(name, value)| (name.to_owned(), value.to_owned()))).collect()
}

fn location(response: &reqwest::Response) -> String {
    response.headers()["location"].to_str().unwrap().to_owned()
}

struct PublicSide {
    base: String,
    http: reqwest::Client,
    session: String,
}

impl PublicSide {
    async fn login(base: &str, idp: &FakeIdp) -> PublicSide {
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().timeout(Duration::from_secs(15)).build().unwrap();
        idp.set_subject("alice");
        let start = http.get(format!("{base}/v1/session/google/start")).send().await.unwrap();
        assert_eq!(start.status(), 302, "로그인 시작은 IdP로 보낸다");
        let mut cookies = set_cookies(start.headers());
        let at_idp = http.get(location(&start)).send().await.unwrap();
        assert_eq!(at_idp.status(), 302);
        let callback = location(&at_idp);
        let callback = callback.strip_prefix(base).unwrap_or_else(|| panic!("callback이 공개 출처로 온다: {callback}")).to_owned();
        let sent: Vec<String> = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect();
        let done = http.get(format!("{base}{callback}")).header("cookie", sent.join("; ")).send().await.unwrap();
        assert_eq!(done.status(), 302, "callback은 화면 첫 주소로 보낸다");
        cookies.extend(set_cookies(done.headers()));
        let (name, value) = cookies.iter().find(|(name, value)| name.ends_with("vally_session") && !value.is_empty()).unwrap_or_else(|| panic!("세션 쿠키가 없다: {cookies:?}"));
        PublicSide { base: base.to_owned(), http, session: format!("{name}={value}") }
    }

    async fn market_card(&self) -> (u16, Vec<u8>) {
        let response = self.http.get(format!("{}{MARKET_CARD}", self.base)).header("cookie", &self.session).send().await.unwrap();
        (response.status().as_u16(), response.bytes().await.unwrap().to_vec())
    }
}

async fn public_pair(kiwoom: &ScriptedTransport, kis: &Arc<FakeKis>, peer: &KisPeer, env: &Env) -> (Server, Client, PublicSide) {
    let idp = Arc::new(FakeIdp::start(ClientCredentials { id: "google-id".into(), secret: GOOGLE_SECRET.into() }, ClientCredentials { id: "naver-id".into(), secret: NAVER_SECRET.into() }, Arc::new(SystemClock)).await);
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut vars: Vec<(String, String)> = public_vars(&idp, port);
    vars.extend(KIS_ENV.iter().chain([&START]).map(|(key, value)| ((*key).to_owned(), (*value).to_owned())));
    let extra: Vec<(&str, &str)> = vars.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    let server = env.spawn(kiwoom, kis, peer, &extra);
    let client = Client::of(&server).await;
    client.until_key_state("env", "connected").await;
    client.until_key_state("env-kis", "connected").await;
    let public = PublicSide::login(&format!("http://127.0.0.1:{port}"), &idp).await;
    (server, client, public)
}

fn market_card_calls(kiwoom: &ScriptedTransport) -> usize {
    kiwoom.api_ids().iter().filter(|id| *id == "ka20003").count()
}

#[tokio::test]
async fn switching_the_source_drops_the_public_market_cache_so_the_next_card_is_asked_again() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    script_market_card(&kiwoom);
    let (server, client, public) = public_pair(&kiwoom, &kis, &peer, &env).await;
    let (status, first) = public.market_card().await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&first));
    assert_eq!(market_card_calls(&kiwoom), 1);
    assert_eq!(public.market_card().await, (200, first.clone()));
    assert_eq!(market_card_calls(&kiwoom), 1, "바꾸기 전에는 캐시가 답한다");

    switched_to_kis(&client).await;
    assert_eq!(public.market_card().await.0, 200);
    assert_eq!(market_card_calls(&kiwoom), 2, "바꾼 뒤 첫 요청은 캐시에 남은 응답이 아니라 새로 받은 응답이다");
    server.stop().await;
}

#[tokio::test]
async fn a_market_answer_that_lands_after_the_switch_is_not_kept_in_the_public_market_cache() {
    let (kiwoom, kis, peer, env) = (ScriptedTransport::new(), FakeKis::new(), KisPeer::default(), Env::new());
    script_market_card(&kiwoom);
    let (server, client, public) = public_pair(&kiwoom, &kis, &peer, &env).await;
    let held = kiwoom.hold("키움 지수", |call| call.api_id == "ka20003");
    let public = Arc::new(public);
    let slow = tokio::spawn({
        let public = public.clone();
        async move { public.market_card().await }
    });
    held.arrived().await;
    switched_to_kis(&client).await;
    held.release();
    assert_eq!(slow.await.unwrap().0, 200, "바꾸기 전에 보낸 요청은 자기 응답을 받는다");
    assert_eq!(market_card_calls(&kiwoom), 1);
    assert_eq!(public.market_card().await.0, 200);
    assert_eq!(market_card_calls(&kiwoom), 2, "늦게 온 응답은 새 캐시에 남지 않는다");
    server.stop().await;
}
