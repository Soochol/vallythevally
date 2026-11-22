use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use domain::KstDate;
use serde_json::{Value, json};

use super::journal::Prepared;
use super::service::account_ref_of;
use super::tests::{ACCOUNT, DEFAULT_BAND, HOST, OTHER_ACCOUNT, WriteMode, call, get, is_write, listed_symbols, price_band_reply, reply, write_reply};
use crate::api::{Broker, KiwoomEnvironment, KiwoomTarget, KiwoomTargetKind, OrderCommandKind, SystemSettings};
use crate::app::{ApplicationInputs, application_with_system};
use crate::clock::{Clock, kst};
use crate::config::{KiwoomCredentials, Secret};
use crate::db::AppDb;
use crate::http::{AppState, router};
use crate::instance::InstanceLock;
use crate::kiwoom::api::{Endpoint, MarketRequest, StockBasicInfo, StockList};
use crate::kiwoom::auth::KiwoomAuth;
use crate::kiwoom::key_file::{FileBases, KeyFile, KeyId, KeyList, StoredKey, startup_keys};
use crate::kiwoom::keys::{KeySetup, LaneFactory};
use crate::kiwoom::rest::testing::{FakeTransport, ok};
use crate::kiwoom::rest::{Access, KiwoomRest};
use crate::kiwoom::stream::{AccountEvent, AccountKind, KiwoomStream};
use crate::system_routes::SystemState;

const KEYS: [(&str, &str, &str, &str); 3] = [
    ("k1", "주 계좌", "FAKE-APPKEY-order-a", ACCOUNT),
    ("k2", "연금", "FAKE-APPKEY-order-b", OTHER_ACCOUNT),
    ("k3", "같은 계좌", "FAKE-APPKEY-order-c", ACCOUNT),
];
const LEGACY_SALT: &str = "00ff";

struct Keyed {
    app: Router,
    state: Arc<AppState>,
    fake: Arc<FakeTransport>,
    _dir: tempfile::TempDir,
    _lock: InstanceLock,
}

fn app_key(index: usize) -> &'static str {
    KEYS[index].2
}

async fn keyed(listed: &[usize]) -> Keyed {
    keyed_with_switch_file(listed, None).await
}

async fn keyed_with_switch_file(listed: &[usize], switch_file: Option<String>) -> Keyed {
    let dir = tempfile::tempdir().unwrap();
    let lock = InstanceLock::acquire(&dir.path().join("state").join("server.lock")).unwrap();
    let key_file = KeyFile::new(dir.path().join("keys").join("kiwoom-key.json"), &lock);
    let stored = listed.iter().map(|&i| StoredKey { id: KeyId::parse(KEYS[i].0).unwrap(), alias: KEYS[i].1.into(), broker: Broker::Kiwoom, credentials: KiwoomCredentials { app_key: Secret::new(KEYS[i].2.into()), app_secret: Secret::new("FAKE-SECRET-order".into()) } }).collect();
    key_file.save(&KeyList { keys: stored, market: KeyId::parse(KEYS[listed[0]].0) }).unwrap();
    if let Some(text) = switch_file {
        let path = dir.path().join("keys").join(super::ORDER_SWITCH_FILE_NAME);
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let bases = FileBases { token: dir.path().join("state").join("token.json"), registered_ip: dir.path().join("keys").join("kiwoom-ip.json"), held: lock.held() };
    let startup = startup_keys(None, &key_file, KiwoomEnvironment::Real, &bases);

    let owners: HashMap<String, String> = KEYS.iter().map(|(_, _, app, account)| ((*app).to_owned(), (*account).to_owned())).collect();
    let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |sent| {
        if sent.api_id == Endpoint::ISSUE {
            let body: Value = serde_json::from_str(&sent.body).unwrap();
            let token = format!("tok-{}", body["appkey"].as_str().unwrap());
            return ok(json!({"token": token, "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}), None);
        }
        if let Endpoint::Trading(id) = sent.api_id
            && is_write(id)
        {
            return write_reply(WriteMode::Accept);
        }
        match sent.api_id.market() {
            Some(id) if id == StockBasicInfo::API_ID => return price_band_reply(&sent.body, &(DEFAULT_BAND[0].to_owned(), DEFAULT_BAND[1].to_owned())),
            Some(id) if id == StockList::API_ID => return ok(json!({"list": [], "return_code": 0, "return_msg": "정상"}), None),
            _ => {}
        }
        let app = sent.token.as_deref().and_then(|token| token.strip_prefix("tok-")).unwrap_or_default();
        let account = owners.get(app).cloned().unwrap_or_default();
        reply(sent, &account, &account)
    }));
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 0));
    let market = &startup.keys[0].credentials;
    let rest = KiwoomRest::build(Arc::new(fake.clone()), KiwoomAuth::new(market.app_key.clone(), market.app_secret.clone(), None), clock.clone(), Duration::ZERO, KiwoomEnvironment::Real);
    let factory = LaneFactory { transport: Arc::new(fake.clone()), clock: clock.clone(), environment: KiwoomEnvironment::Real, spacing: Some(Duration::ZERO), ws_url: None, bases };
    let key_setup = KeySetup { store: key_file, keys: startup.keys, market: startup.market, factory };
    let settings = SystemSettings {
        environment: KiwoomEnvironment::Real,
        bind: "127.0.0.1:0".into(),
        log_filter: "info".into(),
        static_dir: String::new(),
        db_path: String::new(),
        screener_db_path: String::new(),
        financial_db_path: String::new(),
        screener_update_on_start: false,
        financial_automatic: false,
        opendart_key_present: false,
        token_path: String::new(),
        key_path: String::new(),
        lock_path: String::new(),
        kiwoom_target: KiwoomTarget { kind: KiwoomTargetKind::Loopback, host: None },
        server_version: String::new(),
        account_server_url: None,
        account_state_path: None,
    };
    let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
    let (stream, _desired) = KiwoomStream::detached();
    let (_events, receiver) = tokio::sync::mpsc::channel(8);
    let screener_store = crate::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap();
    let inputs = ApplicationInputs { rest: rest.clone(), clock, symbols: listed_symbols(), db, screener_store, stream: (stream, receiver), static_dir: dir.path().to_owned(), screener_update_on_connect: false };
    let state = application_with_system(inputs, SystemState::new(key_setup, None, settings));
    rest.set_access(Access::Open);
    for view in state.keys.views() {
        view.lane.rest.set_access(Access::Open);
    }
    state.system.bound(HOST.parse().unwrap());
    Keyed { app: router(state.clone()), state, fake, _dir: dir, _lock: lock }
}

impl Keyed {
    async fn enable(&self, index: usize, tail: &str) -> (StatusCode, Value) {
        call(&self.app, "PUT", "/api/system/orders", Some(json!({"enabled": true, "confirmAccountTail": tail, "keyId": KEYS[index].0}))).await
    }

    async fn disable(&self, index: usize) -> (StatusCode, Value) {
        call(&self.app, "PUT", "/api/system/orders", Some(json!({"enabled": false, "keyId": KEYS[index].0}))).await
    }

    async fn line(&self, index: usize) -> Value {
        let (_, status) = get(&self.app, "/api/system/orders").await;
        status["accounts"].as_array().unwrap().iter().find(|line| line["keyId"] == KEYS[index].0).cloned().unwrap_or(Value::Null)
    }

    async fn account_ref(&self, index: usize) -> String {
        self.line(index).await["accountRef"].as_str().unwrap().to_owned()
    }

    fn trading_sent_by(&self, index: usize) -> Vec<&'static str> {
        let token = format!("tok-{}", app_key(index));
        self.fake.sent().iter().filter(|sent| sent.token.as_deref() == Some(token.as_str())).filter_map(|sent| if let Endpoint::Trading(id) = sent.api_id { Some(id.as_str()) } else { None }).collect()
    }

    fn contacted(&self, index: usize) -> bool {
        self.fake.sent().iter().any(|sent| sent.token.as_deref() == Some(format!("tok-{}", app_key(index)).as_str()) || sent.body.contains(app_key(index)))
    }

    async fn place(&self, account: Option<&str>, command_id: &str) -> (StatusCode, Value) {
        let mut body = json!({"commandId": command_id, "code": "005930", "side": "buy", "quantity": 1, "price": 71000, "venue": "krx", "confirmHighValue": false});
        if let Some(account) = account {
            body["account"] = account.into();
        }
        call_ordering(&self.app, "/api/trading/commands/place", body).await
    }
}

async fn call_ordering(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
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

#[tokio::test]
async fn trading_orders_for_the_second_account_go_only_through_that_accounts_key() {
    let f = keyed(&[0, 1]).await;
    assert_eq!(f.enable(0, "01").await.0, StatusCode::OK);
    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK);
    let (a_before, reference_b) = (f.trading_sent_by(0).len(), f.account_ref(1).await);
    assert_ne!(f.account_ref(0).await, reference_b);

    let (code, command) = f.place(Some(&reference_b), "cmd-second-0001").await;
    assert_eq!((code, command["state"].clone(), command["accountRef"].clone()), (StatusCode::OK, json!("accepted"), json!(reference_b)), "{command}");
    assert!(f.trading_sent_by(1).contains(&"kt10000"), "{:?}", f.trading_sent_by(1));
    assert_eq!(f.trading_sent_by(0).len(), a_before, "첫 키에는 요청이 가지 않는다");

    let (code, open) = get(&f.app, &format!("/api/trading/open-orders?account={reference_b}")).await;
    assert_eq!((code, open["accountRef"].clone()), (StatusCode::OK, json!(reference_b)));
    let (_, balance) = get(&f.app, &format!("/api/trading/balance?account={reference_b}")).await;
    assert_eq!(balance["accountRef"], json!(reference_b));
    assert_eq!(f.trading_sent_by(0).len(), a_before, "조회도 그 계좌의 키로만 나간다");
    assert!(f.trading_sent_by(1).contains(&"kt00018") && f.trading_sent_by(1).contains(&"ka10075"));

    let (_, status) = get(&f.app, &format!("/api/system/orders?account={reference_b}")).await;
    assert_eq!((status["accountRef"].clone(), status["accountTail"].clone()), (json!(reference_b), json!("02")), "고른 계좌 기준 위쪽 필드");
    assert_eq!(status["accounts"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn trading_switch_is_per_account_and_enabling_asks_that_accounts_tail() {
    let f = keyed(&[0, 1]).await;
    assert_eq!(f.enable(0, "01").await.0, StatusCode::OK);
    let second = f.line(1).await;
    assert_eq!((second["state"].clone(), second["accountRef"].clone(), second["accountTail"].clone()), (json!("off"), Value::Null, Value::Null), "켠 적 없는 키는 계좌를 모른다");
    assert!(!f.contacted(1), "켜기 전까지 둘째 키에는 계좌 요청도 토큰 요청도 없다: {:?}", f.fake.sent().iter().map(|s| (s.api_id, s.token.clone())).collect::<Vec<_>>());

    let (code, body) = f.enable(1, "01").await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "첫 계좌의 끝 2자리로는 둘째 계좌를 켤 수 없다: {body}");
    assert_eq!(f.line(1).await["state"], json!("off"));
    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK);
    assert_eq!(f.line(1).await["accountTail"], json!("02"));

    let reference_b = f.account_ref(1).await;
    assert_eq!(f.disable(1).await.0, StatusCode::OK);
    let (code, body) = f.place(Some(&reference_b), "cmd-off-second-1").await;
    assert_eq!((code, body["error"]["reason"].clone()), (StatusCode::CONFLICT, json!("orders_off")), "{body}");
    assert_eq!(f.place(None, "cmd-first-0001").await.0, StatusCode::OK, "첫 계좌는 켜진 채다");
    assert_eq!(f.line(0).await["state"], json!("on"));
}

#[tokio::test]
async fn trading_two_keys_on_one_account_cannot_both_be_on() {
    let f = keyed(&[0, 1, 2]).await;
    assert_eq!(f.enable(0, "01").await.0, StatusCode::OK);
    let (code, body) = f.enable(2, "01").await;
    assert_eq!(code, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["message"], json!("‘주 계좌’와 같은 계좌입니다. 주문은 한 줄에서만 씁니다"));
    let third = f.line(2).await;
    assert_eq!((third["state"].clone(), third["accountRef"].clone()), (json!("off"), Value::Null), "거절된 키는 꺼진 채다");
    assert_eq!(f.line(0).await["state"], json!("on"));

    assert_eq!(f.disable(0).await.0, StatusCode::OK);
    assert_eq!(f.enable(2, "01").await.0, StatusCode::OK);
    let (code, body) = f.enable(0, "01").await;
    assert_eq!((code, body["error"]["message"].clone()), (StatusCode::CONFLICT, json!("‘같은 계좌’와 같은 계좌입니다. 주문은 한 줄에서만 씁니다")));
}

#[tokio::test]
async fn trading_without_an_account_uses_the_market_key_and_an_unknown_one_is_404() {
    let f = keyed(&[0, 1]).await;
    assert_eq!(f.enable(0, "01").await.0, StatusCode::OK);
    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK);
    let (b_before, reference_a) = (f.trading_sent_by(1).len(), f.account_ref(0).await);
    let (code, balance) = get(&f.app, "/api/trading/balance").await;
    assert_eq!((code, balance["accountRef"].clone()), (StatusCode::OK, json!(reference_a)), "계좌 참조가 없으면 시세 키 계좌다");
    assert_eq!(f.trading_sent_by(1).len(), b_before);

    for uri in ["/api/trading/balance?account=nope", "/api/system/orders?account=nope", "/api/trading/commands?account=nope", "/api/system/orders/margin?account=nope"] {
        let (code, body) = get(&f.app, uri).await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{uri}: {body}");
    }
    assert_eq!(f.place(Some("nope"), "cmd-unknown-001").await.0, StatusCode::NOT_FOUND);
    let (code, _) = call(&f.app, "PUT", "/api/system/orders", Some(json!({"enabled": false, "keyId": "k9"}))).await;
    assert_eq!(code, StatusCode::NOT_FOUND, "모르는 키 ID");
}

#[tokio::test]
async fn trading_legacy_switch_and_journal_rows_read_as_the_market_keys_account() {
    let reference = account_ref_of(LEGACY_SALT, ACCOUNT);
    let legacy = format!(r#"{{"environment":"real","enabled":true,"salt":"{LEGACY_SALT}","accountRef":"{reference}","accountNumberTail":"01","marginPolicy":"cash_only"}}"#);
    let f = keyed_with_switch_file(&[0, 1], Some(legacy)).await;
    let (_, status) = get(&f.app, "/api/system/orders").await;
    assert_eq!((status["state"].clone(), status["accountRef"].clone(), status["accountTail"].clone()), (json!("on"), json!(reference), json!("01")), "{status}");
    assert_eq!(f.line(1).await["state"], json!("off"), "옛 기록은 시세 키 줄에만 붙는다");

    let prepared = Prepared { command_id: "cmd-legacy-0001".into(), account_ref: reference.clone(), kind: OrderCommandKind::Buy, code: Some("005930".into()), venue: Some(domain::Venue::Krx), quantity: Some(1), price: Some(71_000), target_order_no: None };
    f.state.accounts.market().journal.begin(&prepared, 1).await.unwrap();
    let (code, commands) = get(&f.app, "/api/trading/commands").await;
    assert_eq!((code, commands["commands"][0]["commandId"].clone()), (StatusCode::OK, json!("cmd-legacy-0001")), "{commands}");
    let (code, listed) = get(&f.app, &format!("/api/trading/commands?account={reference}")).await;
    assert_eq!((code, listed["commands"].as_array().unwrap().len()), (StatusCode::OK, 1));

    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK, "다른 키를 켜도 옛 기록은 시세 키 것으로 남는다");
    assert_eq!(f.line(0).await["state"], json!("on"));
    assert_eq!(f.account_ref(1).await, account_ref_of(LEGACY_SALT, OTHER_ACCOUNT), "새 줄도 같은 소금을 써서 같은 계좌는 같은 참조가 된다");
}

async fn next_change(changes: &mut tokio::sync::broadcast::Receiver<super::AccountChanged>) -> super::AccountChanged {
    tokio::time::timeout(Duration::from_secs(5), changes.recv()).await.expect("계좌 변경 알림이 오지 않았다").unwrap()
}

#[tokio::test]
async fn trading_realtime_fill_of_the_second_account_names_that_account() {
    let f = keyed(&[0, 1, 2]).await;
    assert_eq!(f.enable(0, "01").await.0, StatusCode::OK);
    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK);
    let lane = |index: usize| f.state.keys.view_of(&KeyId::parse(KEYS[index].0).unwrap()).unwrap().lane;
    assert!(lane(0).account.wanted() && lane(1).account.wanted());
    assert!(!lane(2).account.wanted(), "켜지 않은 키는 00·04를 등록하지 않는다");

    let mut changes = f.state.accounts.subscribe_changes();
    let reference_b = f.account_ref(1).await;
    lane(1).account.emit(AccountEvent { kind: AccountKind::OrderFill, account: Secret::new(OTHER_ACCOUNT.into()) });
    assert_eq!(next_change(&mut changes).await.account_ref, reference_b);
    lane(0).account.emit(AccountEvent { kind: AccountKind::OrderFill, account: Secret::new(OTHER_ACCOUNT.into()) });
    lane(0).account.emit(AccountEvent { kind: AccountKind::Balance, account: Secret::new(ACCOUNT.into()) });
    assert_eq!(next_change(&mut changes).await.account_ref, f.account_ref(0).await, "첫 키의 줄은 자기 계좌의 사건만 알린다");

    assert_eq!(f.disable(1).await.0, StatusCode::OK);
    assert!(!lane(1).account.wanted(), "끄면 그 키의 00·04를 해지한다");
    assert!(lane(0).account.wanted());
}

async fn heard_after_swap(changes: &mut tokio::sync::broadcast::Receiver<super::AccountChanged>, lane: &crate::kiwoom::keys::Lane, account: &str) -> String {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            lane.account.emit(AccountEvent { kind: AccountKind::OrderFill, account: Secret::new(account.into()) });
            if let Ok(Ok(change)) = tokio::time::timeout(Duration::from_millis(50), changes.recv()).await {
                return change.account_ref;
            }
        }
    })
    .await
    .expect("시세 키를 바꾼 뒤에도 계좌 실시간 사건이 닿는다")
}

#[tokio::test]
async fn trading_realtime_follows_each_key_when_the_market_key_changes() {
    let f = keyed(&[0, 1]).await;
    assert_eq!(f.enable(0, "01").await.0, StatusCode::OK);
    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK);
    let (reference_a, reference_b) = (f.account_ref(0).await, f.account_ref(1).await);
    f.state.keys.designate_market(&KeyId::parse(KEYS[1].0).unwrap()).unwrap();

    let lane = |index: usize| f.state.keys.view_of(&KeyId::parse(KEYS[index].0).unwrap()).unwrap().lane;
    let mut changes = f.state.accounts.subscribe_changes();
    assert_eq!(heard_after_swap(&mut changes, &lane(1), OTHER_ACCOUNT).await, reference_b);
    assert_eq!(heard_after_swap(&mut changes, &lane(0), ACCOUNT).await, reference_a);
    assert!(lane(0).account.wanted() && lane(1).account.wanted());
    let (_, status) = get(&f.app, "/api/system/orders").await;
    assert_eq!(status["accountRef"], json!(reference_b), "계좌 참조가 없으면 새 시세 키의 계좌다");
}

#[tokio::test]
async fn trading_removing_a_key_clears_its_record_so_a_reused_key_id_starts_blank() {
    let f = keyed(&[0, 1]).await;
    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK);
    let reference_b = f.account_ref(1).await;
    f.state.keys.remove(&KeyId::parse(KEYS[1].0).unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (code, _) = get(&f.app, &format!("/api/trading/balance?account={reference_b}")).await;
            if code == StatusCode::NOT_FOUND {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("지운 키의 계좌 참조는 모르는 계좌가 된다");
    let (_, status) = get(&f.app, "/api/system/orders").await;
    assert_eq!(status["accounts"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn trading_a_key_added_under_a_removed_keys_id_does_not_inherit_its_account() {
    let f = keyed(&[0, 1]).await;
    assert_eq!(f.enable(1, "02").await.0, StatusCode::OK);
    let reference_b = f.account_ref(1).await;
    let (_, policy) = call(&f.app, "PUT", "/api/system/orders/margin", Some(json!({"policy": "allow_margin", "account": reference_b}))).await;
    assert_eq!(policy["policy"], json!("allow_margin"));
    f.state.keys.remove(&KeyId::parse(KEYS[1].0).unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while get(&f.app, &format!("/api/trading/balance?account={reference_b}")).await.0 != StatusCode::NOT_FOUND {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("지운 키의 계좌 참조는 모르는 계좌다");
    let credentials = KiwoomCredentials { app_key: Secret::new(KEYS[2].2.into()), app_secret: Secret::new("FAKE-SECRET-order".into()) };
    let id = f.state.keys.add("새 키", credentials).unwrap();
    assert_eq!(id.as_str(), "k2", "지운 번호를 다시 쓴다");
    let added = get(&f.app, "/api/system/orders").await.1["accounts"][1].clone();
    assert_eq!((added["accountRef"].clone(), added["accountTail"].clone()), (Value::Null, Value::Null), "{added}");
    for view in f.state.keys.views() {
        view.lane.rest.set_access(Access::Open);
    }
    let (code, _) = call(&f.app, "PUT", "/api/system/orders", Some(json!({"enabled": true, "confirmAccountTail": "01", "keyId": "k2"}))).await;
    assert_eq!(code, StatusCode::OK);
    let (_, margin) = get(&f.app, &format!("/api/system/orders/margin?account={}", f.account_ref(1).await)).await;
    assert_eq!(margin["policy"], json!("cash_only"));
}
