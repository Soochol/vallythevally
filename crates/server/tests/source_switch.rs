mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{ScriptedTransport, Server};
use domain::KstDate;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::BoxFuture;
use futures::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{Value, json};
use server::kis::api::KisApiId;
use server::kis::feed::{KisConnect, KisFeedParts};
use server::kis::master::{MasterDownload, MasterError, MasterMarket};
use server::kis::stream::{Connector, Socket};
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const START: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "start");
const NO_KIWOOM_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");
const KIS_KEY: &str = "FAKE-KIS-APPKEY-switch-env-4R7T";
const KIS_SECRET: &str = "FAKE-KIS-SECRET-switch-env-9K2W";
const KIS_ENV: [(&str, &str); 2] = [("VALLY_KIS_APP_KEY", KIS_KEY), ("VALLY_KIS_APP_SECRET", KIS_SECRET)];
const KIS_CLOSE: u64 = 77_777;
const ISSUE_REFUSED: &str = r#"{"error_description":"유효하지 않은 AppKey입니다.","error_code":"EGW00999"}"#;
const IN_USE_ELSEWHERE: &str = r#"{"header":{"tr_id":null},"body":{"rt_cd":"9","msg_cd":"OPSP8996","msg1":"ALREADY IN USE appkey"}}"#;

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
            _ => json!({"rt_cd": "1", "msg_cd": "EGW99999", "msg1": "시험이 정하지 않은 요청"}).to_string(),
        };
        Box::pin(async move { Ok(HttpResponse { status: 200, tr_cont: None, body }) })
    }
}

struct FakeMaster;

const KOSPI_TAIL_CHARS: usize = 227;
const KOSDAQ_TAIL_CHARS: usize = 221;

fn master_line(market: MasterMarket, code: &str, name: &str) -> Vec<u8> {
    let tail_chars = if market == MasterMarket::Kospi { KOSPI_TAIL_CHARS } else { KOSDAQ_TAIL_CHARS };
    let text = format!("{code:<9}{:<12}{name}{:<width$}", "KR7000000000", "ST", width = tail_chars);
    encoding_rs::EUC_KR.encode(&text).0.into_owned()
}

fn archive(lines: &[Vec<u8>]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    zip.start_file("code.mst", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
    for line in lines {
        zip.write_all(line).unwrap();
        zip.write_all(b"\r\n").unwrap();
    }
    zip.finish().unwrap();
    out.into_inner()
}

impl MasterDownload for FakeMaster {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>> {
        let lines = match market {
            MasterMarket::Kospi => vec![master_line(market, "005930", "삼성전자"), master_line(market, "000660", "SK하이닉스")],
            MasterMarket::Kosdaq => vec![master_line(market, "247540", "에코프로비엠")],
        };
        Box::pin(async move { Ok(archive(&lines)) })
    }
}

struct ChannelSocket {
    incoming: UnboundedReceiver<Result<Message, WsError>>,
    outgoing: UnboundedSender<Message>,
}

impl Stream for ChannelSocket {
    type Item = Result<Message, WsError>;

    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.incoming).poll_next(cx)
    }
}

impl Sink<Message> for ChannelSocket {
    type Error = WsError;

    fn poll_ready(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn start_send(self: std::pin::Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        self.outgoing.unbounded_send(message).map_err(|_| WsError::ConnectionClosed)
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_close(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        self.outgoing.close_channel();
        std::task::Poll::Ready(Ok(()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct KisControl {
    tr_type: String,
    tr_id: String,
    tr_key: String,
}

#[derive(Clone, Default)]
struct KisPeer {
    controls: Arc<Mutex<Vec<KisControl>>>,
    connections: Arc<Mutex<usize>>,
    answer_in_use: Arc<AtomicBool>,
}

impl KisPeer {
    fn connect(&self) -> KisConnect {
        let peer = self.clone();
        Arc::new(move || Box::new(peer.clone()))
    }

    fn registered(&self) -> Vec<(String, String)> {
        let mut live: Vec<(String, String)> = Vec::new();
        for control in self.controls.lock().unwrap().iter() {
            let item = (control.tr_id.clone(), control.tr_key.clone());
            if control.tr_type == "1" {
                live.push(item);
            } else {
                live.retain(|kept| *kept != item);
            }
        }
        live
    }
}

impl Connector for KisPeer {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        *self.connections.lock().unwrap() += 1;
        let (to_client, incoming) = unbounded();
        let (outgoing, mut from_client) = unbounded::<Message>();
        let (controls, answer_in_use) = (self.controls.clone(), self.answer_in_use.clone());
        tokio::spawn(async move {
            while let Some(Message::Text(text)) = from_client.next().await {
                let body: Value = serde_json::from_str(text.as_str()).unwrap();
                let control = KisControl {
                    tr_type: body["header"]["tr_type"].as_str().unwrap().to_owned(),
                    tr_id: body["body"]["input"]["tr_id"].as_str().unwrap().to_owned(),
                    tr_key: body["body"]["input"]["tr_key"].as_str().unwrap().to_owned(),
                };
                controls.lock().unwrap().push(control.clone());
                let reply = if answer_in_use.load(Ordering::SeqCst) {
                    IN_USE_ELSEWHERE.to_owned()
                } else {
                    json!({"header": {"tr_id": control.tr_id, "tr_key": control.tr_key, "encrypt": "N"}, "body": {"rt_cd": "0", "msg_cd": "OPSP0000", "msg1": "SUBSCRIBE SUCCESS"}}).to_string()
                };
                if to_client.unbounded_send(Ok(Message::Text(reply.into()))).is_err() {
                    return;
                }
            }
        });
        Box::pin(async move { Ok(Box::new(ChannelSocket { incoming, outgoing }) as Socket) })
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
    let reload = next_of_type(&mut browser, "reload").await;
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
