use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use domain::KstDate;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::{SwitchStore, Trading, TradingError};
use crate::api::{OrderSide, OrdersStatus, OrdersSwitchInput};
use crate::app::{ApplicationInputs, application};
use crate::clock::{Clock, kst};
use crate::config::Secret;
use crate::db::AppDb;
use crate::http::{ApiFailure, AppState, router};
use crate::kiwoom::api::{Endpoint, MarketRequest, StockBasicInfo, StockList};
use crate::kiwoom::auth::KiwoomAuth;
use crate::kiwoom::error::Category;
use crate::kiwoom::private_file::PrivateFile;
use crate::kiwoom::rest::testing::{FakeTransport, Sent, ok, token};
use crate::kiwoom::rest::{Access, KiwoomError, KiwoomRest};
use crate::kiwoom::stream::{AccountEvent, AccountFeed, AccountKind, KiwoomStream};
use crate::kiwoom::transport::{HttpResponse, Stage, TransportError};
use crate::symbols::SymbolDirectory;
use crate::trading::TradingApiId;

pub(super) const ACCOUNT: &str = "5550123401";
const OTHER_ACCOUNT: &str = "5559876502";
pub(super) const HOST: &str = "127.0.0.1:7777";

#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Logs {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum WriteMode {
    Accept,
    Timeout,
    Refused,
    Garbage,
    NoNumber,
    NullNumber,
    Reject,
    BusinessReject,
}

fn write_reply(mode: WriteMode) -> Result<HttpResponse, TransportError> {
    match mode {
        WriteMode::Accept => ok(json!({"ord_no": "0099001", "dmst_stex_tp": "KRX", "return_code": 0, "return_msg": "정상"}), None),
        WriteMode::Timeout => Err(TransportError { stage: Stage::AwaitResponse, timed_out: true }),
        WriteMode::Refused => Err(TransportError::refused()),
        WriteMode::Garbage => Ok(HttpResponse { status: 200, next_key: None, body: "<html>oops</html>".into() }),
        WriteMode::NoNumber => ok(json!({"return_code": 0, "return_msg": "정상"}), None),
        WriteMode::NullNumber => ok(json!({"ord_no": null, "return_code": 0, "return_msg": "정상"}), None),
        WriteMode::Reject => ok(json!({"return_code": 20, "return_msg": "주문이 거부되었습니다"}), None),
        WriteMode::BusinessReject => ok(json!({"return_code": 20, "return_msg": "[2000](508975:합성 가격 밴드 사유)"}), None),
    }
}

fn is_write(id: TradingApiId) -> bool {
    matches!(id, TradingApiId::Kt10000 | TradingApiId::Kt10001 | TradingApiId::Kt10002 | TradingApiId::Kt10003)
}

fn price_band_reply(requested: &str) -> Result<HttpResponse, TransportError> {
    let mut body: Value = serde_json::from_str(include_str!("../../tests/fixtures/kiwoom/ka10001_005930_AL.json")).unwrap();
    let (upper, lower) = if requested.contains(ETN_CODE) {
        body["stk_cd"] = format!("{ETN_CODE}_AL").into();
        ("+10000", "-5000")
    } else {
        ("+100000", "-50000")
    };
    body["upl_pric"] = upper.into();
    body["lst_pric"] = lower.into();
    body["return_code"] = 0.into();
    body["return_msg"] = "정상".into();
    ok(body, None)
}

pub(super) const ETN_CODE: &str = "520100";

fn listed_symbols() -> Arc<SymbolDirectory> {
    use domain::{Market, Symbol, SymbolInfo, SymbolKind};
    let info = |code: &str, name: &str, kind, nxt_enabled| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind, market: Market::Kospi, nxt_enabled };
    let symbols = Arc::new(SymbolDirectory::default());
    symbols.replace(crate::symbols::Directory::build(vec![info("005930", "삼성전자", SymbolKind::Common, true), info("005935", "KRX전용", SymbolKind::Common, false), info(ETN_CODE, "합성 ETN", SymbolKind::Etn, false)]));
    symbols
}

pub(super) struct Fixture {
    pub(super) mode: Arc<Mutex<WriteMode>>,
    pub(super) rows_account: Arc<Mutex<Option<String>>>,
    pub(super) orderable_replies: Arc<Mutex<std::collections::HashMap<String, Value>>>,
    pub(super) app: Router,
    pub(super) state: Arc<AppState>,
    pub(super) fake: Arc<FakeTransport>,
    pub(super) feed: AccountFeed,
    pub(super) account: Arc<Mutex<String>>,
    pub(super) _dir: tempfile::TempDir,
}

fn reply(sent: &Sent, account: &str, rows_account: &str) -> Result<crate::kiwoom::transport::HttpResponse, crate::kiwoom::transport::TransportError> {
    let Endpoint::Trading(id) = sent.api_id else { return token(1) };
    match id {
        TradingApiId::Ka00001 => ok(json!({"acctNo": account, "return_code": 0, "return_msg": "정상"}), None),
        TradingApiId::Kt00018 => ok(
            json!({
                "tot_pur_amt": "000000000900000", "tot_evlt_amt": "000000000990000", "tot_evlt_pl": "+000000000090000",
                "acnt_evlt_remn_indv_tot": [
                    {"stk_cd": "A005930", "stk_nm": "삼성전자", "evltv_prft": "+000000000090000", "prft_rt": "+10.00", "pur_pric": "000000000090000", "rmnd_qty": "000000000000010", "trde_able_qty": "000000000000004", "cur_prc": "000000000099000", "crd_tp": "00"},
                    {"stk_cd": "A000660", "stk_nm": "신용종목", "evltv_prft": "0", "prft_rt": "0.00", "pur_pric": "1000", "rmnd_qty": "5", "trde_able_qty": "5", "cur_prc": "1000", "crd_tp": "03"},
                    {"stk_cd": "A000270", "stk_nm": "없는종목", "evltv_prft": "0", "prft_rt": "0.00", "pur_pric": "1000", "rmnd_qty": "0", "trde_able_qty": "0", "cur_prc": "1000", "crd_tp": "00"}
                ],
                "return_code": 0, "return_msg": "정상"
            }),
            None,
        ),
        TradingApiId::Ka10075 => ok(
            json!({"oso": [
                {"acnt_no": rows_account, "ord_no": "0012345", "stk_cd": "005930", "stk_nm": "삼성전자", "ord_stt": "접수", "ord_qty": "10", "ord_pric": "71000", "oso_qty": "7", "orig_ord_no": "0000000", "io_tp_nm": "-매수", "trde_tp": "보통", "tm": "093001", "stex_tp": "1", "stex_tp_txt": "KRX", "sor_yn": "N"},
                {"acnt_no": rows_account, "ord_no": "0012346", "stk_cd": "005930", "stk_nm": "삼성전자", "ord_stt": "접수", "ord_qty": "3", "ord_pric": "72000", "oso_qty": "3", "orig_ord_no": "0012300", "io_tp_nm": "+매도", "trde_tp": "보통", "tm": "093105", "stex_tp": "0", "stex_tp_txt": "통합", "sor_yn": "Y"}
            ], "return_code": 0, "return_msg": "정상"}),
            None,
        ),
        TradingApiId::Kt00010 => ok(json!({"profa_100ord_alow_amt": "000000001000000", "profa_100ord_alowq": "000000000000014", "ord_alowa": "000000009999999", "return_code": 0, "return_msg": "정상"}), None),
        TradingApiId::Kt00007 => ok(
            json!({"acnt_ord_cntr_prps_dtl": [
                {"ord_no": "0012345", "stk_cd": "A005930", "stk_nm": "삼성전자", "trde_tp": "보통", "io_tp_nm": "현금매수", "cntr_qty": "0000000003", "cntr_uv": "0000071000", "ord_tm": "09:30:01", "cnfm_tm": "09:30:02", "dmst_stex_tp": "KRX"},
                {"ord_no": "0012346", "stk_cd": "A005930", "stk_nm": "삼성전자", "trde_tp": "보통", "io_tp_nm": "현금매도", "cntr_qty": "0000000000", "cntr_uv": "0000000000", "ord_tm": "09:31:05", "cnfm_tm": "", "dmst_stex_tp": "KRX"}
            ], "return_code": 0, "return_msg": "정상"}),
            None,
        ),
        TradingApiId::Kt10000 | TradingApiId::Kt10001 | TradingApiId::Kt10002 | TradingApiId::Kt10003 => unreachable!("쓰기 응답은 fixture가 WriteMode로 만든다"),
    }
}

pub(super) async fn fixture() -> Fixture {
    fixture_with(Duration::ZERO, Duration::ZERO).await
}

pub(super) async fn fixture_with(latency: Duration, spacing: Duration) -> Fixture {
    fixture_in(latency, spacing, crate::api::KiwoomEnvironment::Real).await
}

pub(super) async fn fixture_in(latency: Duration, spacing: Duration, environment: crate::api::KiwoomEnvironment) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mode = Arc::new(Mutex::new(WriteMode::Accept));
    let seen_mode = mode.clone();
    let account = Arc::new(Mutex::new(ACCOUNT.to_owned()));
    let seen_account = account.clone();
    let rows_account = Arc::new(Mutex::new(None::<String>));
    let seen_rows = rows_account.clone();
    let orderable_replies = Arc::new(Mutex::new(std::collections::HashMap::<String, Value>::new()));
    let seen_orderable = orderable_replies.clone();
    let fake = Arc::new(FakeTransport::new(latency, move |sent| {
        if sent.api_id == Endpoint::ISSUE {
            return token(1);
        }
        if let Endpoint::Trading(id) = sent.api_id
            && is_write(id)
        {
            return write_reply(*seen_mode.lock().unwrap());
        }
        if sent.api_id == Endpoint::Trading(TradingApiId::Kt00010) {
            let side = serde_json::from_str::<Value>(&sent.body).ok().and_then(|body| body["trde_tp"].as_str().map(str::to_owned));
            if let Some(scripted) = side.and_then(|side| seen_orderable.lock().unwrap().get(&side).cloned()) {
                return ok(scripted, None);
            }
        }
        match sent.api_id.market() {
            Some(id) if id == StockBasicInfo::API_ID => return price_band_reply(&sent.body),
            Some(id) if id == StockList::API_ID => return ok(json!({"list": [], "return_code": 0, "return_msg": "정상"}), None),
            _ => {}
        }
        let account = seen_account.lock().unwrap().clone();
        let rows = seen_rows.lock().unwrap().clone().unwrap_or_else(|| account.clone());
        reply(sent, &account, &rows)
    }));
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 0));
    let rest = KiwoomRest::build(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone(), spacing, environment);
    let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
    let (stream, _desired) = KiwoomStream::detached();
    let feed = stream.account_feed();
    let (_events, receiver) = tokio::sync::mpsc::channel(8);
    let screener_store = crate::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap();
    let state = application(ApplicationInputs { rest: rest.clone(), clock, symbols: listed_symbols(), db, screener_store, stream: (stream, receiver), static_dir: dir.path().to_owned(), screener_update_on_connect: false });
    rest.set_access(Access::Open);
    state.system.bound(HOST.parse().unwrap());
    let app = router(state.clone());
    Fixture { mode, rows_account, orderable_replies, app, state, fake, feed, account, _dir: dir }
}

pub(super) fn trading_sends(fake: &FakeTransport) -> Vec<&'static str> {
    fake.sent().iter().filter_map(|s| if let Endpoint::Trading(id) = s.api_id { Some(id.as_str()) } else { None }).collect()
}

pub(super) async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri).header("host", HOST);
    let body = match body {
        Some(value) => {
            req = req.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("{uri}: JSON이 아님: {}", String::from_utf8_lossy(&bytes))))
}

pub(super) async fn get(app: &Router, uri: &str) -> (StatusCode, Value) {
    call(app, "GET", uri, None).await
}

const READS: [&str; 4] = ["/api/trading/balance", "/api/trading/open-orders", "/api/trading/orderable?code=005930&side=buy&price=71000", "/api/trading/executions"];

pub(super) async fn enable(app: &Router, tail: &str) -> (StatusCode, Value) {
    call(app, "PUT", "/api/system/orders", Some(json!({"enabled": true, "confirmAccountTail": tail}))).await
}

#[tokio::test]
async fn orders_off_sends_no_account_or_order_request() {
    let f = fixture().await;
    for uri in READS {
        let (code, body) = get(&f.app, uri).await;
        assert_eq!(code, StatusCode::CONFLICT, "{uri}");
        assert_eq!(body["error"]["reason"], "orders_off", "{uri}");
    }
    let (code, body) = get(&f.app, "/api/system/orders").await;
    assert_eq!((code, body["state"].clone()), (StatusCode::OK, json!("off")));
    assert!(f.fake.sent().is_empty(), "꺼져 있으면 토큰 발급도 계좌 TR도 나가지 않는다: {:?}", f.fake.sent().iter().map(|s| s.api_id).collect::<Vec<_>>());
    assert!(!f.feed.wanted(), "꺼져 있으면 00·04를 등록하지 않는다");

    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    assert!(f.feed.wanted());
    let (code, _) = call(&f.app, "PUT", "/api/system/orders", Some(json!({"enabled": false}))).await;
    assert_eq!(code, StatusCode::OK);
    assert!(!f.feed.wanted(), "끄면 00·04를 해지하도록 알린다");
    let before = trading_sends(&f.fake).len();
    for uri in READS {
        assert_eq!(get(&f.app, uri).await.0, StatusCode::CONFLICT, "{uri}");
    }
    assert_eq!(trading_sends(&f.fake).len(), before, "끈 뒤에는 어떤 계좌 TR도 나가지 않는다");
    assert_eq!(trading_sends(&f.fake), ["ka00001"], "켜는 확인에서만 계좌를 한 번 물었다");
}

#[tokio::test]
async fn account_number_never_leaves_in_responses_or_logs() {
    let logs = Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt().with_writer(move || writer.clone()).with_ansi(false).with_max_level(tracing::Level::TRACE).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let f = fixture().await;
    let mut bodies = Vec::new();
    let (_, check) = call(&f.app, "POST", "/api/system/orders/check-account", Some(json!({}))).await;
    bodies.push(check);
    let (code, enabled) = enable(&f.app, "01").await;
    assert_eq!(code, StatusCode::OK, "{enabled}");
    bodies.push(enabled);
    bodies.push(get(&f.app, "/api/system/orders").await.1);
    for uri in READS {
        let (code, body) = get(&f.app, uri).await;
        assert_eq!(code, StatusCode::OK, "{uri}: {body}");
        bodies.push(body);
    }
    f.state.trading.set_enabled(OrdersSwitchInput { enabled: true, confirm_account_tail: Some("99".into()) }).await.unwrap_err();
    *f.account.lock().unwrap() = OTHER_ACCOUNT.to_owned();
    f.feed.emit(AccountEvent { kind: AccountKind::OrderFill, account: Secret::new(ACCOUNT.into()) });
    tokio::task::yield_now().await;
    let mut all = bodies.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    all.push_str(&logs.text());
    for secret in [ACCOUNT, OTHER_ACCOUNT, &ACCOUNT[..8]] {
        assert!(!all.contains(secret), "응답이나 로그에 계좌번호 {secret}가 있다");
    }
    assert!(all.contains("accountRef"), "계좌는 불투명한 참조로만 나간다");
    assert!(!logs.text().is_empty(), "로그를 실제로 수집했다");
}

#[tokio::test]
async fn account_reads_need_a_connected_link() {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    f.state.rest.set_access(Access::Closed);
    let sent = f.fake.sent().len();
    for uri in READS {
        let (code, body) = get(&f.app, uri).await;
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(body["error"]["reason"], "not_connected", "{uri}: 연결 전");
    }
    assert_eq!(f.fake.sent().len(), sent, "연결 전에는 아무것도 보내지 않는다");
}

#[tokio::test]
async fn account_reads_stop_when_the_key_is_auth_blocked() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = blocked.clone();
    let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |sent| {
        if sent.api_id == Endpoint::ISSUE {
            return token(1);
        }
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            return ok(json!({"return_code": 5, "return_msg": "인증에 실패했습니다[8050:허용되지 않은 IP입니다]"}), None);
        }
        reply(sent, ACCOUNT, ACCOUNT)
    }));
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 0));
    let rest = KiwoomRest::with_send_spacing(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone(), Duration::ZERO);
    rest.set_access(Access::Open);
    let (stream, _desired) = KiwoomStream::detached();
    let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
    let trading = Trading::new(rest.clone(), clock, SwitchStore::file(PrivateFile::new(dir.path().join("state").join("orders.json")), crate::api::KiwoomEnvironment::Real), stream.account_feed(), db, Arc::new(SymbolDirectory::default()));
    trading.set_enabled(OrdersSwitchInput { enabled: true, confirm_account_tail: Some("01".into()) }).await.unwrap();
    blocked.store(true, std::sync::atomic::Ordering::SeqCst);
    let auth_blocked = |e: &TradingError| matches!(e, TradingError::Kiwoom(KiwoomError::Stopped(f)) if f.category() == Category::AuthBlocked);
    let first = trading.balance().await.unwrap_err();
    assert!(auth_blocked(&first), "{first:?}");
    let sent = fake.sent().len();
    for read in [trading.open_orders().await.map(drop), trading.executions().await.map(drop), trading.orderable(domain::StockCode::parse("005930").unwrap(), OrderSide::Buy, 71_000).await.map(drop)] {
        let error = read.unwrap_err();
        assert!(auth_blocked(&error), "{error:?}");
    }
    assert_eq!(fake.sent().len(), sent, "인증이 차단된 뒤에는 계좌 TR을 더 보내지 않는다");
    let body = ApiFailure::trading(first).into_body();
    assert_eq!((body.code, body.reason), (crate::api::ApiErrorCode::KiwoomAuthFailed, Some(crate::api::ApiErrorReason::AuthBlocked)));
}

#[tokio::test]
async fn enabling_needs_the_confirmed_account_tail() {
    let f = fixture().await;
    let (code, check) = call(&f.app, "POST", "/api/system/orders/check-account", Some(json!({}))).await;
    assert_eq!((code, check), (StatusCode::OK, json!({"accountTail": "01"})));
    assert!(!f.feed.wanted(), "확인만으로는 켜지지 않는다");

    let (code, body) = enable(&f.app, "02").await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");
    assert!(!f.feed.wanted());
    let (_, off) = get(&f.app, "/api/system/orders").await;
    assert_eq!(off["state"], "off");

    let (code, body) = call(&f.app, "PUT", "/api/system/orders", Some(json!({"enabled": true}))).await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");

    let (code, on) = enable(&f.app, "01").await;
    assert_eq!(code, StatusCode::OK);
    let status: OrdersStatus = serde_json::from_value(on).unwrap();
    assert_eq!((status.state, status.account_tail.as_deref()), (crate::api::OrdersState::On, Some("01")));
    assert!(status.account_ref.is_some_and(|r| r.len() == 24 && !r.contains(ACCOUNT)));
    assert!(f.feed.wanted());
}

#[tokio::test]
async fn a_different_account_after_confirmation_blocks_every_read() {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    f.state.clock.jump(120);
    *f.account.lock().unwrap() = OTHER_ACCOUNT.to_owned();
    for uri in READS {
        let (code, body) = get(&f.app, uri).await;
        assert_eq!((code, body["error"]["reason"].clone()), (StatusCode::CONFLICT, json!("account_changed")), "{uri}");
    }
    let sent = trading_sends(&f.fake).len();
    assert_eq!(get(&f.app, READS[0]).await.0, StatusCode::CONFLICT);
    assert_eq!(trading_sends(&f.fake).len(), sent, "막힌 뒤에는 다시 묻지 않는다");
    let (_, status) = get(&f.app, "/api/system/orders").await;
    assert_eq!(status["state"], "account_changed");
    assert_eq!(enable(&f.app, "02").await.0, StatusCode::OK, "다시 켜서 확인하면 풀린다");
    assert_eq!(get(&f.app, READS[0]).await.0, StatusCode::OK);
}

#[tokio::test]
async fn account_reads_are_parsed_into_the_browser_contract() {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);

    let (_, balance) = get(&f.app, "/api/trading/balance").await;
    assert_eq!(balance["holdings"], json!([{"code": "005930", "name": "삼성전자", "quantity": 10, "sellableQuantity": 4, "averagePrice": 90000, "currentPrice": 99000, "evaluationProfit": 90000, "profitRateCenti": 1000}]), "신용 행과 수량 0 행은 보이지 않는다");
    assert_eq!((balance["totalPurchase"].clone(), balance["totalEvaluation"].clone(), balance["totalProfit"].clone()), (json!(900000), json!(990000), json!(90000)));

    let (_, open) = get(&f.app, "/api/trading/open-orders").await;
    assert_eq!(open["orders"][0], json!({"orderNo": "0012345", "code": "005930", "name": "삼성전자", "side": "buy", "quantity": 10, "price": 71000, "openQuantity": 7, "status": "접수", "orderedAt": "093001", "originalOrderNo": null, "venue": "krx"}));
    assert_eq!((open["orders"][1]["side"].clone(), open["orders"][1]["venue"].clone(), open["orders"][1]["originalOrderNo"].clone()), (json!("sell"), json!("combined"), json!("0012300")));

    let (_, orderable) = get(&f.app, "/api/trading/orderable?code=005930&side=buy&price=71000").await;
    assert_eq!((orderable["amount"].clone(), orderable["quantity"].clone()), (json!(1_000_000), json!(14)));

    let (_, executions) = get(&f.app, "/api/trading/executions").await;
    assert_eq!(executions["day"], "2026-11-09");
    assert_eq!(executions["executions"], json!([{"orderNo": "0012345", "code": "005930", "name": "삼성전자", "side": "buy", "quantity": 3, "price": 71000, "time": "09:30:02", "venue": "krx"}]), "체결 수량이 0인 행은 내역이 아니다");

    let bodies: Vec<(&str, Value)> = f.fake.sent().iter().filter_map(|s| if let Endpoint::Trading(id) = s.api_id { Some((id.as_str(), serde_json::from_str(&s.body).unwrap())) } else { None }).collect();
    let body_of = |tr: &str| bodies.iter().find(|(id, _)| *id == tr).map(|(_, b)| b.clone()).unwrap();
    assert_eq!(body_of("kt00018"), json!({"qry_tp": "2", "dmst_stex_tp": "KRX"}));
    assert_eq!(body_of("ka10075"), json!({"all_stk_tp": "0", "trde_tp": "0", "stk_cd": "", "stex_tp": "0"}));
    assert_eq!(body_of("kt00010"), json!({"stk_cd": "005930", "trde_tp": "2", "uv": "71000"}));
    assert_eq!(body_of("kt00007")["qry_tp"], "4");
    assert_eq!(body_of("kt00007")["ord_dt"], "20261109");
    assert_eq!(f.fake.sent().iter().filter(|s| s.api_id == Endpoint::Trading(TradingApiId::Ka00001)).count(), 1, "계좌 확인은 60초 동안 한 번이다");
}

fn orderable_sends(f: &Fixture) -> usize {
    f.fake.sent().iter().filter(|s| s.api_id == Endpoint::Trading(TradingApiId::Kt00010)).count()
}

#[tokio::test]
async fn a_business_rejection_fails_only_that_request_and_stops_no_path() {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    f.orderable_replies.lock().unwrap().insert("1".into(), json!({"return_code": 20, "return_msg": "[2000](571455:합성 매도 사유 FAKE-SECRET-sell)"}));
    let code = domain::StockCode::parse("005930").unwrap();
    let (sell, buy) = tokio::join!(f.state.trading.orderable(code, OrderSide::Sell, 71_000), f.state.trading.orderable(code, OrderSide::Buy, 71_000));
    assert_eq!(buy.unwrap().quantity, 14, "같은 경로의 매수 조회는 성공한다");
    let Err(TradingError::Kiwoom(ref error @ KiwoomError::Failed(ref failure))) = sell else { panic!("{sell:?}") };
    assert_eq!((failure.category(), failure.vendor_reason().map(|r| r.number())), (Category::BusinessRejected, Some(571455)));
    assert!(!error.manual_action_required());
    let shown = error.shown();
    assert_eq!((shown.code, shown.reason, shown.manual_action_required), (crate::api::ApiErrorCode::KiwoomUnavailable, crate::api::ApiErrorReason::BusinessRejected, false));
    assert!(f.state.rest.stopped(Endpoint::Trading(TradingApiId::Kt00010)).is_none() && f.state.rest.halted().is_none());
    let sent = orderable_sends(&f);
    assert_eq!(sent, 2, "매도·매수가 각각 한 번 나갔다");
    assert!(matches!(f.state.trading.orderable(code, OrderSide::Sell, 71_000).await, Err(TradingError::Kiwoom(KiwoomError::Failed(_)))));
    assert_eq!(orderable_sends(&f), sent + 1, "거절된 뒤에도 다시 키움으로 나간다");
}

#[tokio::test]
async fn a_business_rejection_reaches_the_browser_as_a_reason_not_a_stop() {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    f.orderable_replies.lock().unwrap().insert("2".into(), json!({"return_code": 20, "return_msg": "[2000](571489:합성 휴장 FAKE-SECRET-closed)"}));
    let (status, body) = get(&f.app, "/api/trading/orderable?code=005930&side=buy&price=71000").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!((body["error"]["reason"].clone(), body["error"]["manualActionRequired"].clone(), body["error"]["code"].clone()), (json!("business_rejected"), json!(false), json!("kiwoom_unavailable")));
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("571489") && message.contains("장이 열리지 않는 날"), "{message}");
    assert!(!message.contains("다시 켤") && !message.contains("멈") && !message.contains("FAKE-SECRET"), "{message}");
    let (again, _) = get(&f.app, "/api/trading/orderable?code=005930&side=buy&price=71000").await;
    assert_eq!(again, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(orderable_sends(&f), 2, "첫 거절 뒤에도 다음 요청이 키움으로 나간다");
}

#[tokio::test]
async fn a_row_of_another_account_is_refused() {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    assert_eq!(get(&f.app, "/api/trading/open-orders").await.0, StatusCode::OK);
    *f.rows_account.lock().unwrap() = Some(OTHER_ACCOUNT.to_owned());
    let (code, body) = get(&f.app, "/api/trading/open-orders").await;
    assert_eq!((code, body["error"]["reason"].clone()), (StatusCode::SERVICE_UNAVAILABLE, json!("protocol")));
    assert!(!body.to_string().contains(OTHER_ACCOUNT));
}

#[tokio::test]
async fn orderable_validates_its_query_before_asking_kiwoom() {
    let f = fixture().await;
    assert_eq!(enable(&f.app, "01").await.0, StatusCode::OK);
    let sent = f.fake.sent().len();
    for uri in ["/api/trading/orderable", "/api/trading/orderable?code=005930&side=hold&price=1", "/api/trading/orderable?code=005930&side=buy&price=0", "/api/trading/orderable?code=abc&side=buy&price=1", "/api/trading/orderable?code=005930&side=sell&price=-1"] {
        assert_eq!(get(&f.app, uri).await.0, StatusCode::BAD_REQUEST, "{uri}");
    }
    assert_eq!(f.fake.sent().len(), sent);
}

#[tokio::test]
async fn account_events_for_the_confirmed_account_tell_the_browser_the_account_changed() {
    let f = fixture().await;
    let mut changes = f.state.trading.subscribe_changes();
    f.feed.emit(AccountEvent { kind: AccountKind::OrderFill, account: Secret::new(ACCOUNT.into()) });
    tokio::task::yield_now().await;
    assert!(changes.try_recv().is_err(), "꺼져 있으면 알리지 않는다");

    let (_, enabled) = enable(&f.app, "01").await;
    let account_ref = enabled["accountRef"].as_str().unwrap().to_owned();
    let sent = f.fake.sent().len();
    f.feed.emit(AccountEvent { kind: AccountKind::Balance, account: Secret::new(OTHER_ACCOUNT.into()) });
    f.feed.emit(AccountEvent { kind: AccountKind::OrderFill, account: Secret::new(ACCOUNT.into()) });
    let changed = tokio::time::timeout(Duration::from_secs(5), changes.recv()).await.unwrap().unwrap();
    assert_eq!(changed.account_ref, account_ref);
    assert!(changes.try_recv().is_err(), "다른 계좌의 이벤트는 알리지 않는다");
    assert_eq!(f.fake.sent().len(), sent, "이벤트만으로는 아무것도 조회하지 않는다");
}

async fn direct_trading(latency: Duration, store: SwitchStore) -> (Arc<Trading>, Arc<FakeTransport>, AccountFeed, Clock, tempfile::TempDir) {
    direct_trading_spaced(latency, Duration::ZERO, store).await
}

async fn direct_trading_spaced(latency: Duration, spacing: Duration, store: SwitchStore) -> (Arc<Trading>, Arc<FakeTransport>, AccountFeed, Clock, tempfile::TempDir) {
    let fake = Arc::new(FakeTransport::new(latency, |sent| if sent.api_id == Endpoint::ISSUE { token(1) } else { reply(sent, ACCOUNT, ACCOUNT) }));
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 0));
    let rest = KiwoomRest::with_send_spacing(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone(), spacing);
    rest.set_access(Access::Open);
    let (stream, _desired) = KiwoomStream::detached();
    let feed = stream.account_feed();
    let dir = tempfile::tempdir().unwrap();
    let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
    (Trading::new(rest, clock.clone(), store, feed.clone(), db, Arc::new(SymbolDirectory::default())), fake, feed, clock, dir)
}

fn confirm(tail: &str) -> OrdersSwitchInput {
    OrdersSwitchInput { enabled: true, confirm_account_tail: Some(tail.into()) }
}

#[tokio::test]
async fn an_off_switch_stops_a_read_that_is_already_in_flight() {
    let (trading, fake, _feed, clock, _dir) = direct_trading(Duration::from_millis(150), SwitchStore::memory()).await;
    trading.set_enabled(confirm("01")).await.unwrap();
    clock.jump(120);
    let sent = trading_sends(&fake).len();
    let reading = tokio::spawn({
        let trading = trading.clone();
        async move { trading.balance().await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    trading.set_enabled(OrdersSwitchInput { enabled: false, confirm_account_tail: None }).await.unwrap();
    let outcome = reading.await.unwrap();
    assert!(matches!(outcome, Err(TradingError::Off)), "{outcome:?}");
    assert_eq!(trading_sends(&fake)[sent..], ["ka00001"], "끈 뒤에는 잔고 TR이 나가지 않는다");
}

#[tokio::test]
async fn realtime_registration_follows_the_switch_file_even_when_it_changes_behind_the_servers_back() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("orders.json");
    let store = || SwitchStore::file(PrivateFile::new(path.clone()), crate::api::KiwoomEnvironment::Real);
    let (trading, _fake, feed, _clock, _dir) = direct_trading(Duration::ZERO, store()).await;
    trading.set_enabled(confirm("01")).await.unwrap();
    assert!(feed.wanted());

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(trading.status().state, crate::api::OrdersState::FileUnusable);
    assert!(!feed.wanted(), "파일이 열려 있으면 00·04를 해지한다");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(trading.status().state, crate::api::OrdersState::On);
    assert!(feed.wanted());
    let mut record = store().load().unwrap().unwrap();
    record.enabled = false;
    store().save(&record).unwrap();
    assert_eq!(trading.status().state, crate::api::OrdersState::Off);
    assert!(!feed.wanted(), "파일이 꺼짐으로 바뀌면 00·04를 해지한다");
}

#[tokio::test]
async fn enabling_while_a_stale_verification_is_in_flight_does_not_lock_the_new_account() {
    let (trading, _fake, _feed, clock, _dir) = direct_trading(Duration::from_millis(150), SwitchStore::memory()).await;
    trading.set_enabled(confirm("01")).await.unwrap();
    clock.jump(120);
    let reading = tokio::spawn({
        let trading = trading.clone();
        async move { trading.balance().await.map(drop) }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    trading.set_enabled(confirm("01")).await.unwrap();
    reading.await.unwrap().unwrap();
    assert_eq!(trading.status().state, crate::api::OrdersState::On);
}

#[tokio::test]
async fn an_off_switch_stops_a_read_that_is_still_queued_behind_the_send_spacing() {
    let (trading, fake, _feed, clock, _dir) = direct_trading_spaced(Duration::ZERO, Duration::from_millis(300), SwitchStore::memory()).await;
    trading.set_enabled(confirm("01")).await.unwrap();
    clock.jump(120);
    let sent = trading_sends(&fake).len();
    let reading = tokio::spawn({
        let trading = trading.clone();
        async move { trading.balance().await.map(drop) }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    trading.set_enabled(OrdersSwitchInput { enabled: false, confirm_account_tail: None }).await.unwrap();
    let outcome = reading.await.unwrap();
    assert!(matches!(outcome, Err(TradingError::Off)), "{outcome:?}");
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(trading_sends(&fake)[sent..], Vec::<&str>::new(), "대기열에 있던 요청도 끈 뒤에는 나가지 않는다");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_realtime_registration_matches_the_switch_right_after_every_change_even_with_readers_running() {
    let dir = tempfile::tempdir().unwrap();
    let (trading, _fake, feed, _clock, _dir) = direct_trading(Duration::ZERO, SwitchStore::file(PrivateFile::new(dir.path().join("state").join("orders.json")), crate::api::KiwoomEnvironment::Real)).await;
    trading.set_enabled(confirm("01")).await.unwrap();
    let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let readers: Vec<_> = (0..3)
        .map(|_| {
            let (trading, running) = (trading.clone(), running.clone());
            std::thread::spawn(move || {
                while running.load(std::sync::atomic::Ordering::SeqCst) {
                    trading.status();
                }
            })
        })
        .collect();
    for round in 0..300 {
        trading.set_enabled(OrdersSwitchInput { enabled: false, confirm_account_tail: None }).await.unwrap();
        assert!(!feed.wanted(), "끈 직후 {round}번째");
        trading.set_enabled(confirm("01")).await.unwrap();
        assert!(feed.wanted(), "켠 직후 {round}번째");
    }
    running.store(false, std::sync::atomic::Ordering::SeqCst);
    for reader in readers {
        reader.join().unwrap();
    }
}
