use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};

use super::service::{account_ref_for, account_ref_of};
use super::tests::{ACCOUNT, DEFAULT_BAND, HOST, WriteMode, call, get, is_write, listed_symbols, price_band_reply, reply, write_reply};
use crate::api::{Broker, KiwoomEnvironment, KiwoomTarget, KiwoomTargetKind, SystemSettings};
use crate::app::{ApplicationInputs, application_with_system};
use crate::clock::{Clock, kst};
use crate::config::{KiwoomCredentials, Secret};
use crate::db::AppDb;
use crate::http::{AppState, router};
use crate::instance::InstanceLock;
use crate::kis::transport::{HttpRequest, HttpResponse, Stage, Transport, TransportError};
use crate::kiwoom::api::{Endpoint, MarketRequest, StockBasicInfo, StockList};
use crate::kiwoom::auth::KiwoomAuth;
use crate::kiwoom::key_file::{FileBases, KeyFile, KeyId, KeyList, StoredKey, startup_keys};
use crate::kiwoom::keys::{KeySetup, KisFactory, LaneFactory};
use crate::kiwoom::link::LinkState;
use crate::kiwoom::rest::testing::{FakeTransport, ok};
use crate::kiwoom::rest::{Access, KiwoomRest};
use crate::kiwoom::stream::KiwoomStream;
use crate::system_routes::SystemStartup;
use crate::kis::feed::KisFeedParts;
use crate::kis::master::{MasterDownload, MasterError, MasterMarket};
use crate::kis::stream::{Connector, Socket};
use crate::trading::KisAccountSettings;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const KIWOOM_APP: &str = "FAKE-APPKEY-kisorders-kiwoom";
const KIS_APP: &str = "FAKE-KIS-APPKEY-kisorders-b";
const KIS_SECRET: &str = "FAKE-KIS-SECRET-kisorders-b";
const KIS_ACCOUNT: &str = "50012356-01";
const KIS_CANO: &str = "50012356";
const KIS_DIGITS: &str = "5001235601";
const HTS_ID: &str = "fakehts01";
const KIS_KEY: &str = "k2";
const KIWOOM_KEY: &str = "k1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum KisWrite {
    Accept,
    Timeout,
    BusinessReject,
    RateLimitedTwice,
}

#[derive(Clone, Debug)]
struct KisSent {
    tr_id: String,
    query: Vec<(String, String)>,
    body: Value,
}

impl KisSent {
    fn query(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

type KisFillsHook = Box<dyn Fn(&KisSent) -> Result<HttpResponse, TransportError> + Send + Sync>;

struct FakeKis {
    sent: Mutex<Vec<KisSent>>,
    write: Mutex<KisWrite>,
    rate_limited: AtomicUsize,
    balance_fails: Mutex<bool>,
    fills_hook: Mutex<Option<KisFillsHook>>,
}

impl FakeKis {
    fn new() -> Arc<FakeKis> {
        Arc::new(FakeKis {
            sent: Mutex::default(),
            write: Mutex::new(KisWrite::Accept),
            rate_limited: AtomicUsize::new(0),
            balance_fails: Mutex::new(false),
            fills_hook: Mutex::new(None),
        })
    }

    fn sent(&self) -> Vec<KisSent> {
        self.sent.lock().unwrap().clone()
    }

    fn trs(&self) -> Vec<String> {
        self.sent().into_iter().map(|sent| sent.tr_id).filter(|tr| !tr.is_empty()).collect()
    }

    fn writes(&self) -> Vec<KisSent> {
        self.sent().into_iter().filter(|sent| sent.tr_id.ends_with('U')).collect()
    }

    fn reply_to(&self, sent: &KisSent) -> Result<HttpResponse, TransportError> {
        let tr_id = sent.tr_id.as_str();
        let ok = |body: Value| Ok(HttpResponse { status: 200, tr_cont: None, body: body.to_string() });
        let fine = |mut body: Value| {
            body["rt_cd"] = "0".into();
            body["msg_cd"] = "KIOK0000".into();
            body["msg1"] = "정상처리 되었습니다".into();
            ok(body)
        };
        if tr_id == "TTTC0081R"
            && let Some(hook) = self.fills_hook.lock().unwrap().as_ref()
        {
            return hook(sent);
        }
        match tr_id {
            "TTTC8434R" if *self.balance_fails.lock().unwrap() => ok(json!({"rt_cd": "1", "msg_cd": "OPSQ0002", "msg1": "합성 계좌 오류"})),
            "TTTC8434R" => fine(json!({
                "ctx_area_fk100": "", "ctx_area_nk100": "",
                "output1": [
                    {"pdno": "005930", "prdt_name": "삼성전자", "trad_dvsn_name": "현금", "hldg_qty": "10", "ord_psbl_qty": "4", "pchs_avg_pric": "90000.0000", "prpr": "99000", "evlu_pfls_amt": "90000", "evlu_pfls_rt": "10.00", "loan_amt": "0"},
                    {"pdno": "000660", "prdt_name": "융자종목", "trad_dvsn_name": "자기융자", "hldg_qty": "5", "ord_psbl_qty": "5", "pchs_avg_pric": "1000", "prpr": "1000", "evlu_pfls_amt": "0", "evlu_pfls_rt": "0.00", "loan_amt": "5000"},
                    {"pdno": "035420", "prdt_name": "가격 없는 융자", "trad_dvsn_name": "자기융자", "hldg_qty": "5", "ord_psbl_qty": "5", "pchs_avg_pric": "", "prpr": "", "evlu_pfls_amt": "0", "evlu_pfls_rt": "0.00", "loan_amt": "5000"},
                    {"pdno": "035720", "prdt_name": "수량 어긋난 융자", "trad_dvsn_name": "자기융자", "hldg_qty": "5", "ord_psbl_qty": "9", "pchs_avg_pric": "1000", "prpr": "1000", "evlu_pfls_amt": "0", "evlu_pfls_rt": "0.00", "loan_amt": "5000"},
                    {"pdno": "000270", "prdt_name": "판종목", "trad_dvsn_name": "현금", "hldg_qty": "0", "ord_psbl_qty": "0", "pchs_avg_pric": "0", "prpr": "1000", "evlu_pfls_amt": "0", "evlu_pfls_rt": "0.00", "loan_amt": "0"}
                ],
                "output2": [{"pchs_amt_smtl_amt": "900000", "evlu_amt_smtl_amt": "990000", "evlu_pfls_smtl_amt": "90000"}]
            })),
            "TTTC0084R" => fine(json!({
                "ctx_area_fk100": "", "ctx_area_nk100": "",
                "output": [
                    {"ord_gno_brno": "91252", "odno": "0000012345", "orgn_odno": "", "ord_dvsn_name": "지정가", "pdno": "005930", "prdt_name": "삼성전자", "rvse_cncl_dvsn_name": "", "ord_qty": "10", "ord_unpr": "71000", "ord_tmd": "093001", "tot_ccld_qty": "3", "psbl_qty": "7", "sll_buy_dvsn_cd": "02", "ord_dvsn_cd": "00", "excg_id_dvsn_cd": "KRX"},
                    {"ord_gno_brno": "91253", "odno": "0000012346", "orgn_odno": "0000012300", "ord_dvsn_name": "지정가", "pdno": "005930", "prdt_name": "삼성전자", "rvse_cncl_dvsn_name": "정정", "ord_qty": "3", "ord_unpr": "72000", "ord_tmd": "093105", "tot_ccld_qty": "0", "psbl_qty": "3", "sll_buy_dvsn_cd": "01", "ord_dvsn_cd": "00", "excg_id_dvsn_cd": "SOR"},
                    {"ord_gno_brno": "91254", "odno": "0000012347", "orgn_odno": "", "ord_dvsn_name": "지정가", "pdno": "005930", "prdt_name": "삼성전자", "rvse_cncl_dvsn_name": "", "ord_qty": "2", "ord_unpr": "70000", "ord_tmd": "093200", "tot_ccld_qty": "0", "psbl_qty": "2", "sll_buy_dvsn_cd": "02", "ord_dvsn_cd": "00", "excg_id_dvsn_cd": "?"},
                    {"ord_gno_brno": "", "odno": "0000012348", "orgn_odno": "", "ord_dvsn_name": "지정가", "pdno": "005930", "prdt_name": "삼성전자", "rvse_cncl_dvsn_name": "", "ord_qty": "4", "ord_unpr": "70500", "ord_tmd": "093300", "tot_ccld_qty": "0", "psbl_qty": "4", "sll_buy_dvsn_cd": "02", "ord_dvsn_cd": "00", "excg_id_dvsn_cd": "KRX"}
                ]
            })),
            "TTTC8908R" => fine(json!({"output": {"ord_psbl_cash": "1500000", "nrcvb_buy_amt": "1000000", "nrcvb_buy_qty": "14", "max_buy_amt": "2500000", "max_buy_qty": "35"}})),
            "TTTC0081R" => fine(json!({
                "ctx_area_fk100": "", "ctx_area_nk100": "",
                "output1": [
                    {"odno": "0000012345", "pdno": "005930", "prdt_name": "삼성전자", "sll_buy_dvsn_cd": "02", "tot_ccld_qty": "3", "avg_prvs": "71000", "ord_tmd": "093001", "excg_id_dvsn_Cd": "SOR"},
                    {"odno": "0000012346", "pdno": "005930", "prdt_name": "삼성전자", "sll_buy_dvsn_cd": "01", "tot_ccld_qty": "0", "avg_prvs": "0", "ord_tmd": "093105", "excg_id_dvsn_Cd": "SOR"}
                ],
                "output2": {}
            })),
            "TTTC0011U" | "TTTC0012U" | "TTTC0013U" => {
                let mode = *self.write.lock().unwrap();
                match mode {
                    KisWrite::RateLimitedTwice if self.rate_limited.fetch_add(1, Ordering::SeqCst) < 2 => Ok(HttpResponse { status: 500, tr_cont: None, body: json!({"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "초당 거래건수를 초과하였습니다."}).to_string() }),
                    KisWrite::Accept | KisWrite::RateLimitedTwice => fine(json!({"output": {"KRX_FWDG_ORD_ORGNO": "91252", "ODNO": "0000117057", "ORD_TMD": "121052"}})),
                    KisWrite::Timeout => Err(TransportError { stage: Stage::AwaitResponse, timed_out: true }),
                    KisWrite::BusinessReject => ok(json!({"rt_cd": "1", "msg_cd": "APBK0919", "msg1": "합성 업무 거절"})),
                }
            }
            other => panic!("모르는 한투 TR {other}"),
        }
    }
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let body: Value = req.body.as_ref().and_then(|body| serde_json::from_str(body.expose()).ok()).unwrap_or(Value::Null);
        let tr_id = req.header("tr_id").unwrap_or_default().to_owned();
        let recorded = KisSent { tr_id: tr_id.clone(), query: req.query.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect(), body };
        self.sent.lock().unwrap().push(recorded.clone());
        let response = match req.path {
            "/oauth2/Approval" => Ok(HttpResponse { status: 200, tr_cont: None, body: json!({"approval_key": "FAKE-KIS-APPROVAL-kisorders"}).to_string() }),
            "/oauth2/tokenP" => Ok(HttpResponse { status: 200, tr_cont: None, body: json!({"access_token": "FAKE-KIS-TOKEN-kisorders", "expires_in": 86_400}).to_string() }),
            _ => self.reply_to(&recorded),
        };
        Box::pin(async move { response })
    }
}

struct ChannelSocket {
    incoming: futures::channel::mpsc::UnboundedReceiver<Result<Message, WsError>>,
    outgoing: futures::channel::mpsc::UnboundedSender<Message>,
}

impl futures::Stream for ChannelSocket {
    type Item = Result<Message, WsError>;

    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.incoming).poll_next(cx)
    }
}

impl futures::Sink<Message> for ChannelSocket {
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

struct Peer {
    to_client: futures::channel::mpsc::UnboundedSender<Result<Message, WsError>>,
    from_client: futures::channel::mpsc::UnboundedReceiver<Message>,
}

impl Peer {
    fn say(&self, text: &str) {
        self.to_client.unbounded_send(Ok(Message::Text(text.into()))).unwrap();
    }

    async fn heard(&mut self) -> Value {
        use futures::StreamExt;
        let message = tokio::time::timeout(Duration::from_secs(5), self.from_client.next()).await.expect("클라이언트가 보내지 않았다").expect("연결이 닫혔다");
        let Message::Text(text) = message else { panic!("글이 아니다: {message:?}") };
        serde_json::from_str(text.as_str()).unwrap()
    }
}

#[derive(Clone, Default)]
struct ScriptedConnector {
    sockets: Arc<Mutex<std::collections::VecDeque<Socket>>>,
    attempts: Arc<AtomicUsize>,
}

impl ScriptedConnector {
    fn queue_connection(&self) -> Peer {
        let (to_client, incoming) = futures::channel::mpsc::unbounded();
        let (outgoing, from_client) = futures::channel::mpsc::unbounded();
        self.sockets.lock().unwrap().push_back(Box::new(ChannelSocket { incoming, outgoing }));
        Peer { to_client, from_client }
    }
}

impl Connector for ScriptedConnector {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        let next = self.sockets.lock().unwrap().pop_front();
        Box::pin(async move { next.ok_or(WsError::ConnectionClosed) })
    }
}

struct NoMaster;

impl MasterDownload for NoMaster {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>> {
        Box::pin(async move { Err(MasterError::Empty(market)) })
    }
}

struct Kis {
    app: Router,
    state: Arc<AppState>,
    connector: ScriptedConnector,
    kiwoom: Arc<FakeTransport>,
    kis: Arc<FakeKis>,
    dir: tempfile::TempDir,
    _lock: InstanceLock,
}

fn settings() -> SystemSettings {
    SystemSettings {
        environment: KiwoomEnvironment::Real,
        bind: "127.0.0.1:0".into(),
        log_filter: "info".into(),
        static_dir: String::new(),
        db_path: String::new(),
        screener_db_path: String::new(),
        financial_db_path: String::new(),
        hoga_data_dir: None,
        shared_data_dir: None,
        screener_update_on_start: false,
        token_path: String::new(),
        key_path: String::new(),
        lock_path: String::new(),
        kiwoom_target: KiwoomTarget { kind: KiwoomTargetKind::Loopback, host: None },
        server_version: String::new(),
        account_server_url: None,
        account_state_path: None,
    }
}

async fn kis_fixture(account: Option<&str>, hts_id: Option<&str>) -> Kis {
    let dir = tempfile::tempdir().unwrap();
    let lock = InstanceLock::acquire(&dir.path().join("state").join("server.lock")).unwrap();
    let key_file = KeyFile::new(dir.path().join("keys").join("kiwoom-key.json"), &lock);
    let kiwoom_key = StoredKey { id: KeyId::parse(KIWOOM_KEY).unwrap(), alias: "키움 계좌".into(), broker: Broker::Kiwoom, credentials: KiwoomCredentials { app_key: Secret::new(KIWOOM_APP.into()), app_secret: Secret::new("FAKE-SECRET-kisorders".into()) }, account: KisAccountSettings::default() };
    let kis_key = StoredKey {
        id: KeyId::parse(KIS_KEY).unwrap(),
        alias: "한투 계좌".into(),
        broker: Broker::Kis,
        credentials: KiwoomCredentials { app_key: Secret::new(KIS_APP.into()), app_secret: Secret::new(KIS_SECRET.into()) },
        account: KisAccountSettings::read(account, hts_id).unwrap(),
    };
    key_file.save(&KeyList { keys: vec![kiwoom_key, kis_key], market: KeyId::parse(KIWOOM_KEY) }).unwrap();
    let bases = FileBases { token: dir.path().join("state").join("token.json"), registered_ip: dir.path().join("keys").join("kiwoom-ip.json"), held: lock.held() };
    let startup = startup_keys(None, &key_file, KiwoomEnvironment::Real, &bases);
    let kiwoom = Arc::new(FakeTransport::new(Duration::ZERO, |sent| {
        if sent.api_id == Endpoint::ISSUE {
            return ok(json!({"token": "tok-kiwoom", "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}), None);
        }
        if let Endpoint::Trading(id) = sent.api_id
            && is_write(id)
        {
            return write_reply(WriteMode::Accept);
        }
        match sent.api_id.market() {
            Some(id) if id == StockBasicInfo::API_ID => price_band_reply(&sent.body, &(DEFAULT_BAND[0].to_owned(), DEFAULT_BAND[1].to_owned())),
            Some(id) if id == StockList::API_ID => ok(json!({"list": [], "return_code": 0, "return_msg": "정상"}), None),
            _ => reply(sent, ACCOUNT, ACCOUNT),
        }
    }));
    let kis = FakeKis::new();
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 0));
    let market = &startup.keys[0].credentials;
    let rest = KiwoomRest::build(Arc::new(kiwoom.clone()), KiwoomAuth::new(market.app_key.clone(), market.app_secret.clone(), None), clock.clone(), Duration::ZERO, KiwoomEnvironment::Real);
    let factory = LaneFactory { transport: Arc::new(kiwoom.clone()), clock: clock.clone(), environment: KiwoomEnvironment::Real, spacing: Some(Duration::ZERO), ws_url: None, bases };
    let connector = ScriptedConnector::default();
    let connect = {
        let connector = connector.clone();
        Arc::new(move || Box::new(connector.clone()) as Box<dyn Connector>) as crate::kis::feed::KisConnect
    };
    let kis_factory = KisFactory { transport: kis.clone(), clock: clock.clone(), token_base: dir.path().join("state").join("kis-token.json"), feed: Some(KisFeedParts { connect, master: Arc::new(NoMaster) }) };
    let key_setup = KeySetup { store: key_file, keys: startup.keys, market: startup.market, factory };
    let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, receiver) = tokio::sync::mpsc::channel(8);
    let screener_store = crate::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap();
    let inputs = ApplicationInputs { rest: rest.clone(), clock, symbols: listed_symbols(), db, screener_store, stream: (stream, receiver), static_dir: dir.path().to_owned(), screener_update_on_connect: false };
    let state = application_with_system(inputs, SystemStartup::new(key_setup, None, settings()).with_kis(kis_factory));
    rest.set_access(Access::Open);
    for view in state.keys.views() {
        view.lane.rest.set_access(Access::Open);
    }
    let lane = state.keys.kis_view_of(&KeyId::parse(KIS_KEY).unwrap()).unwrap().lane;
    assert_eq!(lane.link.connect().await, LinkState::Connected);
    state.system.bound(HOST.parse().unwrap());
    state.accounts.remember_price_band(domain::StockCode::parse("005930").unwrap(), Some(100_000), Some(50_000));
    state.accounts.remember_price_band(domain::StockCode::parse("005935").unwrap(), Some(100_000), Some(50_000));
    Kis { app: router(state.clone()), state, connector, kiwoom, kis, dir, _lock: lock }
}

async fn order_call(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let request = Request::builder().method("POST").uri(uri).header("host", HOST).header("content-type", "application/json").header("x-vally-order", "1").body(Body::from(body.to_string())).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

impl Kis {
    async fn enable(&self, key: &str, tail: &str) -> (StatusCode, Value) {
        call(&self.app, "PUT", "/api/system/orders", Some(json!({"enabled": true, "confirmAccountTail": tail, "keyId": key}))).await
    }

    async fn line(&self, key: &str) -> Value {
        let (_, status) = get(&self.app, "/api/system/orders").await;
        status["accounts"].as_array().unwrap().iter().find(|line| line["keyId"] == key).cloned().unwrap_or(Value::Null)
    }

    async fn reference(&self, key: &str) -> String {
        self.line(key).await["accountRef"].as_str().unwrap().to_owned()
    }

    async fn enable_both(&self) -> (String, String) {
        assert_eq!(self.enable(KIWOOM_KEY, "01").await.0, StatusCode::OK);
        let (code, body) = self.enable(KIS_KEY, "56").await;
        assert_eq!(code, StatusCode::OK, "{body}");
        (self.reference(KIWOOM_KEY).await, self.reference(KIS_KEY).await)
    }

    async fn place(&self, account: &str, command_id: &str, venue: &str, side: &str) -> (StatusCode, Value) {
        let body = json!({"account": account, "commandId": command_id, "code": "005930", "side": side, "quantity": 1, "price": 71000, "venue": venue, "confirmHighValue": false});
        order_call(&self.app, "/api/trading/commands/place", body).await
    }

    fn kiwoom_trading(&self) -> Vec<&'static str> {
        self.kiwoom.sent().iter().filter_map(|sent| if let Endpoint::Trading(id) = sent.api_id { Some(id.as_str()) } else { None }).collect()
    }
}

#[tokio::test]
async fn a_buy_for_the_kis_account_goes_only_to_kis_as_one_cash_buy_and_the_kiwoom_account_still_uses_kt10000() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (reference_a, reference_b) = f.enable_both().await;
    assert_ne!(reference_a, reference_b);
    let (kiwoom_before, kis_writes_before) = (f.kiwoom.sent().len(), f.kis.writes().len());

    let (code, command) = f.place(&reference_b, "cmd-kis-buy-0001", "krx", "buy").await;
    assert_eq!((code, command["state"].clone(), command["accountRef"].clone(), command["orderNo"].clone()), (StatusCode::OK, json!("accepted"), json!(reference_b), json!("0000117057")), "{command}");
    assert_eq!(f.kiwoom.sent().len(), kiwoom_before, "한투 계좌 주문은 키움 transport에 아무것도 보내지 않는다");
    let writes = f.kis.writes();
    assert_eq!(writes.len() - kis_writes_before, 1);
    let buy = writes.last().unwrap();
    assert_eq!(buy.tr_id, "TTTC0012U", "공식 샘플의 현금 매수 tr_id");
    assert_eq!(
        (buy.body["CANO"].clone(), buy.body["ACNT_PRDT_CD"].clone(), buy.body["PDNO"].clone(), buy.body["ORD_DVSN"].clone(), buy.body["ORD_QTY"].clone(), buy.body["ORD_UNPR"].clone()),
        (json!(KIS_CANO), json!("01"), json!("005930"), json!("00"), json!("1"), json!("71000"))
    );

    let kis_before = f.kis.sent().len();
    let (code, command) = f.place(&reference_a, "cmd-kiwoom-buy-01", "krx", "buy").await;
    assert_eq!((code, command["state"].clone()), (StatusCode::OK, json!("accepted")), "{command}");
    assert!(f.kiwoom_trading().contains(&"kt10000"));
    assert_eq!(f.kis.sent().len(), kis_before, "키움 계좌 주문은 한투에 가지 않는다");

    let (code, sell) = f.place(&reference_b, "cmd-kis-sell-001", "krx", "sell").await;
    assert_eq!((code, sell["state"].clone()), (StatusCode::OK, json!("accepted")), "{sell}");
    let last = f.kis.writes().pop().unwrap();
    assert_eq!((last.tr_id.as_str(), last.body["SLL_TYPE"].clone()), ("TTTC0011U", json!("01")));
}

#[tokio::test]
async fn kis_reads_answer_with_the_kis_reference_and_neutral_shapes() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    let kiwoom_before = f.kiwoom.sent().len();
    let (code, balance) = get(&f.app, &format!("/api/trading/balance?account={reference_b}")).await;
    assert_eq!((code, balance["accountRef"].clone()), (StatusCode::OK, json!(reference_b)), "{balance}");
    assert_eq!(balance["holdings"], json!([{"code": "005930", "name": "삼성전자", "quantity": 10, "sellableQuantity": 4, "averagePrice": 90000, "currentPrice": 99000, "evaluationProfit": 90000, "profitRateCenti": 1000}]), "융자 행과 0주 행은 보이지 않는다");
    assert_eq!((balance["totalPurchase"].clone(), balance["totalEvaluation"].clone(), balance["totalProfit"].clone()), (json!(900000), json!(990000), json!(90000)));

    let (_, open) = get(&f.app, &format!("/api/trading/open-orders?account={reference_b}")).await;
    let orders = open["orders"].as_array().unwrap();
    assert_eq!(orders[0]["orderNo"], "0000012345");
    assert_eq!((orders[0]["side"].clone(), orders[0]["openQuantity"].clone(), orders[0]["venue"].clone(), orders[0]["orderedAt"].clone()), (json!("buy"), json!(7), json!("krx"), json!("09:30:01")));
    assert_eq!((orders[1]["side"].clone(), orders[1]["venue"].clone(), orders[1]["originalOrderNo"].clone()), (json!("sell"), json!("combined"), json!("0000012300")));

    let (_, orderable) = get(&f.app, &format!("/api/trading/orderable?account={reference_b}&code=005930&side=buy&price=71000")).await;
    assert_eq!((orderable["amount"].clone(), orderable["cashAmount"].clone(), orderable["marginAmount"].clone(), orderable["deposit"].clone()), (json!(1_000_000), json!(1_000_000), json!(2_500_000), json!(1_500_000)), "{orderable}");
    let (_, executions) = get(&f.app, &format!("/api/trading/executions?account={reference_b}")).await;
    assert_eq!(executions["executions"].as_array().unwrap().len(), 1, "체결 수량 0인 행은 빠진다: {executions}");
    assert_eq!(executions["executions"][0]["venue"], "combined", "체결통보가 없으면 행의 SOR를 그대로 쓴다");
    assert_eq!(f.kiwoom.sent().len(), kiwoom_before, "한투 계좌 조회는 키움에 가지 않는다");
    let fills = f.kis.sent().into_iter().find(|sent| sent.tr_id == "TTTC0081R").unwrap();
    assert_eq!((fills.query("INQR_STRT_DT"), fills.query("CANO"), fills.query("CCLD_DVSN")), (Some("20261109"), Some(KIS_CANO), Some("01")));
}

#[tokio::test]
async fn the_same_account_number_under_two_brokers_gets_two_references_and_the_old_kiwoom_reference_still_reads() {
    let salt = "00ff";
    let old_kiwoom = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(format!("{salt}:{ACCOUNT}").as_bytes());
        digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..24].to_owned()
    };
    assert_eq!(account_ref_of(salt, ACCOUNT), old_kiwoom, "키움 참조는 옛 계산 그대로다");
    assert_eq!(account_ref_for(Broker::Kiwoom, salt, ACCOUNT), old_kiwoom);
    assert_ne!(account_ref_for(Broker::Kis, salt, ACCOUNT), old_kiwoom);

    let same_digits = format!("{}-{}", &ACCOUNT[..8], &ACCOUNT[8..]);
    let f = kis_fixture(Some(&same_digits), None).await;
    assert_eq!(f.enable(KIWOOM_KEY, "01").await.0, StatusCode::OK);
    let (code, body) = f.enable(KIS_KEY, "01").await;
    assert_eq!(code, StatusCode::OK, "증권사가 다르면 같은 번호여도 다른 계좌라 함께 켠다: {body}");
    let (kiwoom, kis) = (f.reference(KIWOOM_KEY).await, f.reference(KIS_KEY).await);
    assert_ne!(kiwoom, kis);
    assert_eq!((f.line(KIWOOM_KEY).await["broker"].clone(), f.line(KIS_KEY).await["broker"].clone()), (json!("kiwoom"), json!("kis")));
    let (code, balance) = get(&f.app, &format!("/api/trading/balance?account={kiwoom}")).await;
    assert_eq!((code, balance["accountRef"].clone()), (StatusCode::OK, json!(kiwoom)));
}

#[tokio::test]
async fn enabling_a_kis_account_needs_a_balance_read_and_the_matching_tail_and_a_wrong_tail_stays_off() {
    let f = kis_fixture(Some(KIS_ACCOUNT), Some(HTS_ID)).await;
    let (code, check) = call(&f.app, "POST", &format!("/api/system/orders/check-account?keyId={KIS_KEY}"), Some(json!({}))).await;
    assert_eq!((code, check), (StatusCode::OK, json!({"broker": "kis", "accountTail": "56"})));
    assert_eq!(f.kis.trs(), ["TTTC8434R"], "확인은 잔고 조회 한 번이다");
    assert_eq!(f.line(KIS_KEY).await["state"], "off", "확인만으로는 켜지지 않는다");

    let (code, body) = f.enable(KIS_KEY, "57").await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(f.line(KIS_KEY).await["state"], "off");

    *f.kis.balance_fails.lock().unwrap() = true;
    let (code, body) = f.enable(KIS_KEY, "56").await;
    assert_ne!(code, StatusCode::OK, "잔고 조회가 실패하면 끝 2자리가 맞아도 켜지 않는다: {body}");
    assert_eq!(f.line(KIS_KEY).await["state"], "off");

    *f.kis.balance_fails.lock().unwrap() = false;
    let (code, body) = f.enable(KIS_KEY, "56").await;
    assert_eq!((code, body["accounts"].as_array().unwrap().iter().find(|line| line["keyId"] == KIS_KEY).unwrap()["state"].clone()), (StatusCode::OK, json!("on")), "{body}");
    let line = f.line(KIS_KEY).await;
    assert_eq!((line["accountTail"].clone(), line["broker"].clone()), (json!("56"), json!("kis")));
    let switch: Value = serde_json::from_str(&std::fs::read_to_string(f.dir.path().join("keys").join(super::ORDER_SWITCH_FILE_NAME)).unwrap()).unwrap();
    let salt = switch["keys"][KIS_KEY]["salt"].as_str().unwrap().to_owned();
    assert_eq!(line["accountRef"], json!(account_ref_for(Broker::Kis, &salt, KIS_DIGITS)));
}

#[tokio::test]
async fn kis_buys_route_krx_nxt_and_combined_to_krx_nxt_and_sor_and_revisions_carry_the_original_exchange() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    for (index, (venue, route)) in [("krx", "KRX"), ("nxt", "NXT"), ("combined", "SOR")].into_iter().enumerate() {
        let (code, command) = f.place(&reference_b, &format!("cmd-kis-route-{index:04}"), venue, "buy").await;
        assert_eq!((code, command["state"].clone()), (StatusCode::OK, json!("accepted")), "{venue}: {command}");
        assert_eq!(f.kis.writes().last().unwrap().body["EXCG_ID_DVSN_CD"], route, "{venue}");
    }

    let (code, modified) = order_call(&f.app, "/api/trading/commands/modify", json!({"account": reference_b, "commandId": "cmd-kis-modify-01", "orderNo": "0000012346", "price": 72500})).await;
    assert_eq!((code, modified["state"].clone()), (StatusCode::OK, json!("accepted")), "{modified}");
    let revise = f.kis.writes().pop().unwrap();
    assert_eq!(revise.tr_id, "TTTC0013U");
    assert_eq!(
        (revise.body["EXCG_ID_DVSN_CD"].clone(), revise.body["RVSE_CNCL_DVSN_CD"].clone(), revise.body["ORGN_ODNO"].clone(), revise.body["KRX_FWDG_ORD_ORGNO"].clone(), revise.body["ORD_UNPR"].clone(), revise.body["QTY_ALL_ORD_YN"].clone(), revise.body["ORD_DVSN"].clone()),
        (json!("SOR"), json!("01"), json!("0000012346"), json!("91253"), json!("72500"), json!("Y"), json!("00"))
    );

    let (code, cancelled) = order_call(&f.app, "/api/trading/commands/cancel", json!({"account": reference_b, "commandId": "cmd-kis-cancel-01", "orderNo": "0000012345"})).await;
    assert_eq!((code, cancelled["state"].clone()), (StatusCode::OK, json!("accepted")), "{cancelled}");
    let cancel = f.kis.writes().pop().unwrap();
    assert_eq!((cancel.body["EXCG_ID_DVSN_CD"].clone(), cancel.body["RVSE_CNCL_DVSN_CD"].clone(), cancel.body["ORD_QTY"].clone(), cancel.body["KRX_FWDG_ORD_ORGNO"].clone()), (json!("KRX"), json!("02"), json!("7"), json!("91252")));

    let writes_before = f.kis.writes().len();
    let (code, unreadable) = order_call(&f.app, "/api/trading/commands/cancel", json!({"account": reference_b, "commandId": "cmd-kis-cancel-02", "orderNo": "0000012347"})).await;
    assert_eq!((code, unreadable["state"].clone(), unreadable["reason"].clone()), (StatusCode::OK, json!("rejected"), json!("invalid_order")), "원주문 거래소를 읽지 못하면 보내지 않고 닫힌 사유로 거절한다: {unreadable}");
    assert_eq!(f.kis.writes().len(), writes_before);
}

#[tokio::test]
async fn a_kis_nxt_order_for_a_symbol_not_on_nxt_is_refused_without_a_request() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    let before = f.kis.sent().len();
    let body = json!({"account": reference_b, "commandId": "cmd-kis-nxt-0001", "code": "005935", "side": "buy", "quantity": 1, "price": 71000, "venue": "nxt", "confirmHighValue": false});
    let (code, command) = order_call(&f.app, "/api/trading/commands/place", body).await;
    assert_eq!((code, command["state"].clone(), command["reason"].clone()), (StatusCode::OK, json!("rejected"), json!("nxt_unavailable")), "{command}");
    assert_eq!(f.kis.sent().len(), before, "한투에 아무 요청도 보내지 않는다");
}

#[tokio::test]
async fn an_unanswered_kis_write_is_not_resent_and_blocks_the_account_while_a_rate_limited_one_is_resent() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    *f.kis.write.lock().unwrap() = KisWrite::RateLimitedTwice;
    let (code, command) = f.place(&reference_b, "cmd-kis-limit-001", "krx", "buy").await;
    assert_eq!((code, command["state"].clone()), (StatusCode::OK, json!("accepted")), "한도 초과는 창이 비면 다시 보낸다: {command}");
    assert_eq!(f.kis.writes().len(), 3, "첫 전송과 두 번 다시 보내기");

    *f.kis.write.lock().unwrap() = KisWrite::BusinessReject;
    let (_, rejected) = f.place(&reference_b, "cmd-kis-reject-01", "krx", "buy").await;
    assert_eq!((rejected["state"].clone(), rejected["reason"].clone()), (json!("rejected"), json!("kiwoom_rejected")), "업무 거절은 그 주문만 확정 거절이다: {rejected}");
    assert_eq!(f.kis.writes().len(), 4);

    *f.kis.write.lock().unwrap() = KisWrite::Timeout;
    let (_, unknown) = f.place(&reference_b, "cmd-kis-unknown-1", "krx", "buy").await;
    assert_eq!(unknown["state"], "unknown", "{unknown}");
    assert_eq!(f.kis.writes().len(), 5, "응답을 모르는 쓰기는 다시 보내지 않는다");
    *f.kis.write.lock().unwrap() = KisWrite::Accept;
    let (_, blocked) = f.place(&reference_b, "cmd-kis-after-01", "krx", "buy").await;
    assert_eq!((blocked["state"].clone(), blocked["reason"].clone()), (json!("rejected"), json!("unknown_pending")), "{blocked}");
    assert_eq!(f.kis.writes().len(), 5);
    let (_, commands) = get(&f.app, &format!("/api/trading/commands?account={reference_b}")).await;
    assert_eq!(commands["blocked"], true);
}

#[tokio::test]
async fn kis_responses_and_logs_carry_no_full_account_number_hts_id_or_secret() {
    let logs = super::tests::Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt().with_writer(move || writer.clone()).with_ansi(false).with_max_level(tracing::Level::TRACE).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let f = kis_fixture(Some(KIS_ACCOUNT), Some(HTS_ID)).await;
    let mut bodies = vec![call(&f.app, "POST", &format!("/api/system/orders/check-account?keyId={KIS_KEY}"), Some(json!({}))).await.1];
    let (_, reference_b) = f.enable_both().await;
    bodies.push(get(&f.app, "/api/system/orders").await.1);
    bodies.push(get(&f.app, "/api/system/kiwoom/keys").await.1);
    for uri in ["/api/trading/balance", "/api/trading/open-orders", "/api/trading/orderable?code=005930&side=buy&price=71000", "/api/trading/executions"] {
        let (code, body) = get(&f.app, &format!("{uri}{}account={reference_b}", if uri.contains('?') { "&" } else { "?" })).await;
        assert_eq!(code, StatusCode::OK, "{uri}: {body}");
        bodies.push(body);
    }
    bodies.push(f.place(&reference_b, "cmd-kis-secret-01", "krx", "buy").await.1);
    *f.kis.write.lock().unwrap() = KisWrite::BusinessReject;
    bodies.push(f.place(&reference_b, "cmd-kis-secret-02", "krx", "buy").await.1);
    let listed = bodies[2]["keys"].as_array().unwrap().iter().find(|key| key["keyId"] == KIS_KEY).unwrap()["kisAccount"].clone();
    assert_eq!(listed, json!({"accountTail": "56", "accountMasked": "****-**56", "htsIdSet": true, "source": "file"}));
    let text = format!("{} {}", serde_json::to_string(&bodies).unwrap(), logs.text());
    for secret in [KIS_CANO, KIS_DIGITS, HTS_ID, KIS_SECRET, "FAKE-KIS-TOKEN"] {
        assert!(!text.contains(secret), "{secret}가 응답이나 로그에 나왔다");
    }
}

#[tokio::test]
async fn a_second_kis_key_with_the_same_account_number_or_a_bad_shape_is_refused_and_the_key_file_stays() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let path = f.dir.path().join("keys").join(crate::kiwoom::key_file::KEY_LIST_FILE_NAME);
    let before = std::fs::read(&path).unwrap();
    let add = |account: &str| json!({"alias": "둘째 한투", "appKey": "FAKE-KIS-APPKEY-kisorders-c", "appSecret": "FAKE-KIS-SECRET-kisorders-c", "broker": "kis", "accountNo": account});
    let (code, body) = call(&f.app, "POST", "/api/system/kiwoom/keys", Some(add(KIS_ACCOUNT))).await;
    assert_eq!((code, body["error"]["message"].clone()), (StatusCode::BAD_REQUEST, json!("같은 계좌번호의 한투 키가 이미 있습니다")), "{body}");
    assert_eq!(std::fs::read(&path).unwrap(), before, "키 목록 파일은 그대로다");
    for bad in ["5001235601", "5001-2356-01", ""] {
        let (code, body) = call(&f.app, "POST", "/api/system/kiwoom/keys", Some(add(bad))).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{bad}: {body}");
        assert!(!body.to_string().contains("50012356"), "{body}");
    }
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let (code, body) = call(&f.app, "PUT", &format!("/api/system/kiwoom/keys/{KIS_KEY}/account"), Some(json!({"accountNo": "50012357-01", "htsId": HTS_ID}))).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let listed = body["keys"].as_array().unwrap().iter().find(|key| key["keyId"] == KIS_KEY).unwrap()["kisAccount"].clone();
    assert_eq!((listed["accountTail"].clone(), listed["htsIdSet"].clone()), (json!("57"), json!(true)));
    let (code, body) = call(&f.app, "POST", "/api/system/kiwoom/keys", Some(add("50012356-01"))).await;
    assert_eq!(code, StatusCode::OK, "바꾼 뒤에는 옛 번호를 다른 키가 쓸 수 있다: {body}");
}

#[tokio::test]
async fn an_old_kis_key_without_an_account_number_reads_and_cannot_be_enabled_without_a_request() {
    let f = kis_fixture(None, None).await;
    let line = f.line(KIS_KEY).await;
    assert_eq!((line["broker"].clone(), line["state"].clone(), line["accountTail"].clone()), (json!("kis"), json!("off"), Value::Null), "{line}");
    let (code, body) = call(&f.app, "POST", &format!("/api/system/orders/check-account?keyId={KIS_KEY}"), Some(json!({}))).await;
    assert_eq!((code, body["error"]["message"].clone()), (StatusCode::BAD_REQUEST, json!("계좌번호를 넣어야 주문 사용을 켤 수 있습니다")), "{body}");
    let (code, body) = f.enable(KIS_KEY, "56").await;
    assert_eq!((code, body["error"]["message"].clone()), (StatusCode::BAD_REQUEST, json!("계좌번호를 넣어야 주문 사용을 켤 수 있습니다")), "{body}");
    assert!(f.kis.trs().is_empty(), "토큰 말고는 한투에 아무것도 보내지 않는다: {:?}", f.kis.trs());
    let listed = get(&f.app, "/api/system/kiwoom/keys").await.1["keys"].as_array().unwrap().iter().find(|key| key["keyId"] == KIS_KEY).unwrap()["kisAccount"].clone();
    assert_eq!(listed, json!({"accountTail": null, "accountMasked": null, "htsIdSet": false, "source": "file"}));
}

const NOTICE_KEY: &str = "FAKE-NOTICE-KEY-kisorders-012345";
const NOTICE_IV: &str = "FAKE-NOTICE-IV-2";

fn sealed_notice(account: &str, order_no: &str, exchange: &str) -> String {
    use aes::Aes256;
    use base64::Engine;
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::{BlockEncryptMut, KeyIvInit};
    let mut columns = vec![String::new(); 26];
    for (index, value) in [(0, HTS_ID), (1, account), (2, order_no), (4, "02"), (8, "005930"), (9, "3"), (10, "71000"), (11, "093001"), (12, "0"), (13, "2"), (14, "2"), (16, "3"), (19, exchange), (25, "71000")] {
        columns[index] = value.to_owned();
    }
    let plain = columns.join("^");
    let sealed = cbc::Encryptor::<Aes256>::new_from_slices(NOTICE_KEY.as_bytes(), NOTICE_IV.as_bytes()).unwrap().encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    format!("1|H0STCNI0|001|{}", base64::engine::general_purpose::STANDARD.encode(sealed))
}

async fn next_change(changes: &mut tokio::sync::broadcast::Receiver<super::AccountChanged>) -> super::AccountChanged {
    tokio::time::timeout(Duration::from_secs(5), changes.recv()).await.expect("계좌 변경 알림이 오지 않았다").unwrap()
}

#[tokio::test]
async fn an_encrypted_fill_notice_names_the_kis_account_records_sor_nxt_as_nxt_and_the_reads_go_out_again() {
    let f = kis_fixture(Some(KIS_ACCOUNT), Some(HTS_ID)).await;
    let notices = f.state.keys.kis_view_of(&KeyId::parse(KIS_KEY).unwrap()).unwrap().lane.notices;
    assert!(!notices.wanted(), "주문 사용이 꺼져 있으면 체결통보를 구독하지 않는다");
    let seats = crate::kis::market_stream::KisSeats::with_notices(0, notices.clone());
    let mut peer = f.connector.queue_connection();
    let (_, reference_b) = f.enable_both().await;
    assert!(notices.wanted());
    assert_eq!(crate::market_source::stream::SeatRules::limit(&seats), crate::kis::stream::KIS_REALTIME_LIMIT - 1, "체결통보가 자리 하나를 먼저 잡는다");

    let register = peer.heard().await;
    assert_eq!((register["header"]["tr_type"].clone(), register["body"]["input"].clone()), (json!("1"), json!({"tr_id": "H0STCNI0", "tr_key": HTS_ID})));
    let mut changes = f.state.accounts.subscribe_changes();
    peer.say(&json!({"header": {"tr_id": "H0STCNI0", "tr_key": HTS_ID, "encrypt": "N"}, "body": {"rt_cd": "0", "msg_cd": "OPSP0000", "msg1": "SUBSCRIBE SUCCESS", "output": {"iv": NOTICE_IV, "key": NOTICE_KEY}}}).to_string());
    peer.say(&sealed_notice("5559999901", "0000099999", "1"));
    assert!(tokio::time::timeout(Duration::from_millis(300), changes.recv()).await.is_err(), "다른 계좌의 통보는 알리지 않는다");
    peer.say(&sealed_notice(KIS_DIGITS, "0000012345", "4"));
    let noticed = next_change(&mut changes).await;
    assert_eq!(noticed.account_ref, reference_b, "이 계좌의 통보는 B 참조의 체결 알림이 된다");
    assert_eq!(noticed.fill, Some(crate::api::TradingFillNotice { order_no: Some("0000012345".into()), quantity: Some(3), cumulative_quantity: None }));

    let before = f.kis.trs().len();
    let (_, executions) = get(&f.app, &format!("/api/trading/executions?account={reference_b}")).await;
    assert_eq!(executions["executions"][0]["venue"], "nxt", "SOR-NXT 체결은 NXT로 기록한다: {executions}");
    assert_eq!(get(&f.app, &format!("/api/trading/balance?account={reference_b}")).await.0, StatusCode::OK);
    assert_eq!(get(&f.app, &format!("/api/trading/open-orders?account={reference_b}")).await.0, StatusCode::OK);
    let again: Vec<String> = f.kis.trs()[before..].to_vec();
    assert!(again.contains(&"TTTC8434R".to_owned()) && again.contains(&"TTTC0084R".to_owned()), "체결 알림 뒤 잔고·미체결을 다시 조회한다: {again:?}");

    assert_eq!(call(&f.app, "PUT", "/api/system/orders", Some(json!({"enabled": false, "keyId": KIS_KEY}))).await.0, StatusCode::OK);
    assert!(!notices.wanted(), "끄면 체결통보 구독을 내려놓는다");
}

#[tokio::test]
async fn without_an_hts_id_no_fill_notice_subscription_goes_out_and_orders_settle_by_queries() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    let notices = f.state.keys.kis_view_of(&KeyId::parse(KIS_KEY).unwrap()).unwrap().lane.notices;
    let mut changes = f.state.accounts.subscribe_changes();
    let (_, command) = f.place(&reference_b, "cmd-kis-nohts-01", "krx", "buy").await;
    assert_eq!(command["state"], "accepted", "{command}");
    assert_eq!(next_change(&mut changes).await.account_ref, reference_b, "주문 뒤 그 계좌를 다시 조회하라고 알린다");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!notices.wanted());
    assert_eq!(f.connector.attempts.load(Ordering::SeqCst), 0, "HTS ID가 없으면 실시간 세션을 열지 않고 H0STCNI0도 보내지 않는다");
}

#[tokio::test]
async fn changing_the_kis_account_number_ends_reads_on_the_old_reference_with_account_changed() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    let (code, balance) = get(&f.app, &format!("/api/trading/balance?account={reference_b}")).await;
    assert_eq!(code, StatusCode::OK, "{balance}");

    let (code, keys) = call(&f.app, "PUT", &format!("/api/system/kiwoom/keys/{KIS_KEY}/account"), Some(json!({"accountNo": "50099999-01"}))).await;
    assert_eq!(code, StatusCode::OK, "{keys}");
    let sent_before = f.kis.sent().len();
    for uri in [format!("/api/trading/balance?account={reference_b}"), format!("/api/trading/open-orders?account={reference_b}")] {
        let (code, body) = get(&f.app, &uri).await;
        assert_eq!((code, body["error"]["reason"].clone()), (StatusCode::CONFLICT, json!("account_changed")), "계좌를 바꾼 직후 옛 참조는 새 계좌 자료를 받지 않는다 {uri}: {body}");
    }
    let new_account = f.kis.sent()[sent_before..].iter().filter(|sent| sent.query("CANO") == Some("50099999") || sent.body["CANO"] == "50099999").count();
    assert_eq!(new_account, 0, "옛 참조로 새 계좌를 조회하지 않는다");
}

#[tokio::test]
async fn a_kis_cancel_or_revision_of_a_row_without_a_branch_number_is_refused_as_invalid_order_without_a_request() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    let writes_before = f.kis.writes().len();
    let (code, cancelled) = order_call(&f.app, "/api/trading/commands/cancel", json!({"account": reference_b, "commandId": "cmd-kis-nobranch-c1", "orderNo": "0000012348"})).await;
    assert_eq!((code, cancelled["state"].clone(), cancelled["reason"].clone()), (StatusCode::OK, json!("rejected"), json!("invalid_order")), "지점번호가 빈 행의 취소는 보내지 않는다: {cancelled}");
    let (code, modified) = order_call(&f.app, "/api/trading/commands/modify", json!({"account": reference_b, "commandId": "cmd-kis-nobranch-m1", "orderNo": "0000012348", "price": 70600})).await;
    assert_eq!((code, modified["state"].clone(), modified["reason"].clone()), (StatusCode::OK, json!("rejected"), json!("invalid_order")), "지점번호가 빈 행의 정정은 보내지 않는다: {modified}");
    assert_eq!(f.kis.writes().len(), writes_before, "한투 쓰기가 나가지 않는다");
}

#[tokio::test]
async fn kis_loan_rows_are_sent_apart_and_an_unreadable_one_does_not_block_the_balance() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;

    let (code, balance) = get(&f.app, &format!("/api/trading/balance?account={reference_b}")).await;
    assert_eq!(code, StatusCode::OK, "{balance}");
    assert_eq!(balance["holdings"].as_array().unwrap().iter().map(|h| h["code"].clone()).collect::<Vec<_>>(), vec![json!("005930")]);
    assert_eq!(balance["creditHoldings"], json!([{"code": "000660", "name": "융자종목", "quantity": 5, "sellableQuantity": 5, "averagePrice": 1000, "currentPrice": 1000, "evaluationProfit": 0, "profitRateCenti": 0}]), "읽을 수 있는 융자 행만 따로 오고, 못 읽는 융자 행은 잔고를 막지 않는다");
}

#[tokio::test]
async fn kis_executions_history_fetches_multi_day_range_with_continuation_and_caches_closed_days() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    *f.kis.fills_hook.lock().unwrap() = Some(Box::new(|sent| {
        let nk = sent.query("CTX_AREA_NK100").unwrap_or("");
        if nk.is_empty() {
            Ok(HttpResponse {
                status: 200,
                tr_cont: Some("M".to_owned()),
                body: json!({
                    "rt_cd": "0",
                    "msg_cd": "KIOK0000",
                    "msg1": "정상",
                    "ctx_area_fk100": "FK1",
                    "ctx_area_nk100": "NK1",
                    "output1": [
                        {"ord_dt": "20261103", "odno": "0000010001", "pdno": "005930", "prdt_name": "삼성전자", "sll_buy_dvsn_cd": "02", "tot_ccld_qty": "10", "avg_prvs": "70000", "ord_tmd": "091000", "excg_id_dvsn_Cd": "KRX"},
                        {"ord_dt": "20261106", "odno": "0000010002", "pdno": "005930", "prdt_name": "삼성전자", "sll_buy_dvsn_cd": "01", "tot_ccld_qty": "10", "avg_prvs": "72000", "ord_tmd": "101500", "excg_id_dvsn_Cd": "KRX"}
                    ]
                })
                .to_string(),
            })
        } else {
            Ok(HttpResponse {
                status: 200,
                tr_cont: None,
                body: json!({
                    "rt_cd": "0",
                    "msg_cd": "KIOK0000",
                    "msg1": "정상",
                    "ctx_area_fk100": "",
                    "ctx_area_nk100": "",
                    "output1": [
                        {"ord_dt": "20261109", "odno": "0000010003", "pdno": "000660", "prdt_name": "SK하이닉스", "sll_buy_dvsn_cd": "02", "tot_ccld_qty": "5", "avg_prvs": "200000", "ord_tmd": "093000", "excg_id_dvsn_Cd": "NXT"}
                    ]
                })
                .to_string(),
            })
        }
    }));

    let kiwoom_before = f.kiwoom.sent().len();
    let (status, history) = get(&f.app, &format!("/api/trading/executions/history?account={reference_b}&from=2026-11-02&to=2026-11-09")).await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["today"], "2026-11-09");
    assert_eq!(history["pendingDays"], 0);
    let days: Vec<&str> = history["days"].as_array().unwrap().iter().map(|d| d["day"].as_str().unwrap()).collect();
    assert_eq!(days, vec!["2026-11-03", "2026-11-06", "2026-11-09"]);
    assert_eq!(f.kiwoom.sent().len(), kiwoom_before, "한투 이력 조회는 키움에 가지 않는다");

    let fill_calls: Vec<KisSent> = f.kis.sent().into_iter().filter(|s| s.tr_id == "TTTC0081R").collect();
    assert_eq!(fill_calls.len(), 2, "연속조회 두 페이지를 모두 받는다");
    assert_eq!((fill_calls[0].query("INQR_STRT_DT"), fill_calls[0].query("INQR_END_DT")), (Some("20261102"), Some("20261109")));
    assert_eq!(fill_calls[1].query("CTX_AREA_NK100"), Some("NK1"));

    let kis_before_cached = f.kis.sent().len();
    let (status, cached) = get(&f.app, &format!("/api/trading/executions/history?account={reference_b}&from=2026-11-02&to=2026-11-06")).await;
    assert_eq!(status, StatusCode::OK, "{cached}");
    assert_eq!(cached["days"].as_array().unwrap().len(), 2);
    assert_eq!(f.kis.sent().len(), kis_before_cached, "확정된 과거 구간은 한투를 다시 부르지 않는다");

    let kis_before_old = f.kis.sent().len();
    let (status, old_range) = get(&f.app, &format!("/api/trading/executions/history?account={reference_b}&from=2026-01-01&to=2026-11-09")).await;
    assert_eq!(status, StatusCode::OK, "{old_range}");
    let clamped_calls: Vec<KisSent> = f.kis.sent()[kis_before_old..].iter().filter(|s| s.tr_id == "TTTC0081R").cloned().collect();
    assert!(!clamped_calls.is_empty());
    assert!(clamped_calls.iter().all(|s| s.query("INQR_STRT_DT").unwrap() >= "20260812"), "TTTC0081R 3개월 한도를 넘겨 요청하지 않는다: {clamped_calls:?}");
}

#[tokio::test]
async fn kis_executions_history_preserves_already_finalized_days_within_a_wider_sync_window() {
    let f = kis_fixture(Some(KIS_ACCOUNT), None).await;
    let (_, reference_b) = f.enable_both().await;
    let store = super::history::ExecutionHistoryStore::new(f.state.db.clone());
    let finalized_day = domain::KstDate::new(2026, 11, 5).unwrap();
    store
        .save_day(
            &reference_b,
            finalized_day,
            true,
            &[crate::api::TradingExecution {
                order_no: "0000019999".into(),
                code: "005930".into(),
                name: "삼성전자".into(),
                side: crate::api::OrderSide::Buy,
                quantity: 3,
                price: 70_000,
                time: "09:15:00".into(),
                venue: crate::api::Venue::Nxt,
            }],
            100,
        )
        .await
        .unwrap();

    *f.kis.fills_hook.lock().unwrap() = Some(Box::new(|_sent| {
        Ok(HttpResponse {
            status: 200,
            tr_cont: None,
            body: json!({
                "rt_cd": "0",
                "msg_cd": "KIOK0000",
                "msg1": "정상",
                "ctx_area_fk100": "",
                "ctx_area_nk100": "",
                "output1": [
                    {"ord_dt": "20261104", "odno": "0000010010", "pdno": "005930", "prdt_name": "삼성전자", "sll_buy_dvsn_cd": "02", "tot_ccld_qty": "2", "avg_prvs": "69500", "ord_tmd": "091000", "excg_id_dvsn_Cd": "KRX"},
                    {"ord_dt": "20261105", "odno": "0000019999", "pdno": "005930", "prdt_name": "삼성전자", "sll_buy_dvsn_cd": "02", "tot_ccld_qty": "3", "avg_prvs": "70000", "ord_tmd": "091500", "excg_id_dvsn_Cd": "SOR"},
                    {"ord_dt": "20261106", "odno": "0000010011", "pdno": "005930", "prdt_name": "삼성전자", "sll_buy_dvsn_cd": "01", "tot_ccld_qty": "5", "avg_prvs": "71000", "ord_tmd": "102000", "excg_id_dvsn_Cd": "KRX"}
                ]
            })
            .to_string(),
        })
    }));

    let (status, history) = get(&f.app, &format!("/api/trading/executions/history?account={reference_b}&from=2026-11-04&to=2026-11-06")).await;
    assert_eq!(status, StatusCode::OK, "{history}");
    let day_5 = history["days"].as_array().unwrap().iter().find(|d| d["day"] == "2026-11-05").unwrap();
    assert_eq!(day_5["executions"][0]["venue"], "nxt", "이미 확정된 과거일의 NXT 거래소 기록을 넓은 구간 동기화가 덮어쓰지 않는다");
}
