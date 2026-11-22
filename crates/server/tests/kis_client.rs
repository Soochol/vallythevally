use std::collections::{BTreeSet, VecDeque};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use domain::{KstDate, KstTime};
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::BoxFuture;
use futures::{Sink, Stream, StreamExt};
use server::clock::{Clock, kst};
use server::config::{KisCredentials, Secret};
use server::kis::api::KisApiId;
use server::kis::auth::{AuthError, Halt, KisAuth};
use server::kis::error::Category;
use server::kis::rest::{KIS_PER_SECOND_LIMIT, KisError, KisRequest, KisRest, Priority};
use server::kis::stream::{Connector, End, KIS_REALTIME_LIMIT, KisStream, Socket, StreamEvent, StreamStatus, Subscription};
use server::kis::token_file::{Saved, SavedToken, TokenFile, credential_id};
use server::kis::transport::{HttpRequest, HttpResponse, Method, Transport, TransportError};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const APP_KEY: &str = "FAKE-KIS-APPKEY-int-1";
const APP_SECRET: &str = "FAKE-KIS-SECRET-int-1";
const FILE_TOKEN: &str = "FAKE-KIS-TOKEN-file";
const ISSUED_TOKEN: &str = "FAKE-KIS-TOKEN-issued";
const APPROVAL_KEY: &str = "FAKE-KIS-APPROVAL-issued";
const WAIT: Duration = Duration::from_secs(120);
const SPAN: Duration = Duration::from_millis(1050);

fn fixture(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kis").join(name)).unwrap().trim().to_owned()
}

fn response(status: u16, fixture_name: &str) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status, tr_cont: None, body: fixture(fixture_name) })
}

fn now() -> KstTime {
    kst(KstDate::new(2026, 11, 22).unwrap(), 9, 30, 0)
}

fn credentials() -> KisCredentials {
    KisCredentials { app_key: Secret::new(APP_KEY.into()), app_secret: Secret::new(APP_SECRET.into()) }
}

#[derive(Clone)]
struct Sent {
    method: Method,
    path: &'static str,
    headers: Vec<(String, String)>,
    query: Vec<(String, String)>,
    body: String,
    at: Instant,
}

impl Sent {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

type Handler = dyn Fn(&Sent, usize) -> Result<HttpResponse, TransportError> + Send + Sync;

struct FakeTransport {
    sent: Mutex<Vec<Sent>>,
    handler: Box<Handler>,
}

impl FakeTransport {
    fn new(handler: impl Fn(&Sent, usize) -> Result<HttpResponse, TransportError> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(FakeTransport { sent: Mutex::default(), handler: Box::new(handler) })
    }

    fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    fn sent_to(&self, path: &str) -> Vec<Sent> {
        self.sent().into_iter().filter(|s| s.path == path).collect()
    }
}

impl Transport for FakeTransport {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let sent = Sent {
            method: req.method,
            path: req.path,
            headers: req.headers.iter().map(|(n, v)| (n.to_string(), v.expose().clone())).collect(),
            query: req.query.iter().map(|(n, v)| (n.to_string(), v.clone())).collect(),
            body: req.body.as_ref().map(|b| b.expose().clone()).unwrap_or_default(),
            at: Instant::now(),
        };
        let previous = self.sent.lock().unwrap().iter().filter(|s| s.path == sent.path).count();
        let result = (self.handler)(&sent, previous);
        self.sent.lock().unwrap().push(sent);
        Box::pin(async move { result })
    }
}

const PRICE_PATH: &str = "/uapi/domestic-stock/v1/quotations/inquire-price";
const TOKEN_PATH: &str = "/oauth2/tokenP";
const APPROVAL_PATH: &str = "/oauth2/Approval";

fn serving(price: impl Fn(&Sent, usize) -> Result<HttpResponse, TransportError> + Send + Sync + 'static) -> Arc<FakeTransport> {
    FakeTransport::new(move |sent, n| match sent.path {
        TOKEN_PATH => response(200, "token.json"),
        APPROVAL_PATH => response(200, "approval.json"),
        _ => price(sent, n),
    })
}

fn ok_price(_: &Sent, _: usize) -> Result<HttpResponse, TransportError> {
    response(200, "price.json")
}

struct Home {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Home {
    fn new() -> Home {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state/vallythevally/kis-token.json");
        Home { _dir: dir, path }
    }

    fn file(&self) -> TokenFile {
        TokenFile::new(self.path.clone())
    }

    fn holding_file_token(&self, issue_requested_secs_ago: i64) {
        self.file()
            .save(&Saved {
                credential: Some(credential_id(APP_KEY)),
                token: Some(SavedToken { value: FILE_TOKEN.into(), expires_at: now().unix() + 86_400, issued_at: now().unix() - issue_requested_secs_ago }),
                last_request_at: now().unix() - issue_requested_secs_ago,
            })
            .unwrap();
    }

    fn requested_issue_secs_ago(&self, secs: i64) {
        self.file().save(&Saved { credential: Some(credential_id(APP_KEY)), token: None, last_request_at: now().unix() - secs }).unwrap();
    }

    fn auth(&self, transport: &Arc<FakeTransport>) -> KisAuth {
        let transport: Arc<dyn Transport> = transport.clone();
        KisAuth::new(credentials(), self.path.clone(), transport, Clock::fake(now()))
    }

    fn rest(&self, transport: &Arc<FakeTransport>) -> KisRest {
        let transport_dyn: Arc<dyn Transport> = transport.clone();
        KisRest::new(transport_dyn, self.auth(transport))
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn price_request(code: &str, priority: Priority) -> KisRequest {
    KisRequest::new(KisApiId::CurrentPrice, vec![("FID_COND_MRKT_DIV_CODE", "J".into()), ("FID_INPUT_ISCD", code.into())], priority)
}

fn offsets(sent: &[Sent], start: Instant) -> Vec<Duration> {
    sent.iter().map(|s| s.at - start).collect()
}

#[tokio::test(start_paused = true)]
async fn a_valid_token_in_the_file_is_reused_without_an_issue_request_and_another_app_key_does_not_use_it() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(ok_price);

    let lease = home.auth(&transport).token().await.unwrap();
    assert_eq!(lease.token.expose(), FILE_TOKEN);
    assert!(transport.sent().is_empty(), "재시작은 발급이 아니다");

    let other_key = KisCredentials { app_key: Secret::new("FAKE-KIS-APPKEY-other".into()), app_secret: Secret::new(APP_SECRET.into()) };
    let transport_dyn: Arc<dyn Transport> = transport.clone();
    let other = KisAuth::new(other_key, home.path.clone(), transport_dyn, Clock::fake(now()));
    let lease = other.token().await.unwrap();
    assert_eq!(lease.token.expose(), ISSUED_TOKEN, "앱키가 바뀌면 파일의 토큰을 쓰지 않는다");
    assert_eq!(transport.sent_to(TOKEN_PATH).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn the_issue_request_time_is_recorded_before_the_request_and_the_file_is_private() {
    let home = Home::new();
    let transport = serving(ok_price);
    let auth = home.auth(&transport);
    assert_eq!(auth.token().await.unwrap().token.expose(), ISSUED_TOKEN);

    let saved = home.file().load().unwrap().expect("발급 뒤 파일이 있다");
    assert_eq!(saved.last_request_at, now().unix());
    assert_eq!(saved.credential, Some(credential_id(APP_KEY)));
    assert_eq!(saved.token.unwrap().value, ISSUED_TOKEN);
    assert_eq!((mode(&home.path), mode(home.path.parent().unwrap())), (0o600, 0o700));

    let request = &transport.sent_to(TOKEN_PATH)[0];
    assert_eq!(request.method, Method::Post);
    let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!((body["grant_type"].as_str(), body["appkey"].as_str(), body["appsecret"].as_str()), (Some("client_credentials"), Some(APP_KEY), Some(APP_SECRET)));
}

#[tokio::test(start_paused = true)]
async fn no_issue_request_is_sent_when_its_time_cannot_be_recorded() {
    let home = Home::new();
    let parent = home.path.parent().unwrap();
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(parent).unwrap();
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755)).unwrap();
    let transport = serving(ok_price);

    let error = home.auth(&transport).token().await.err().expect("기록하지 못하면 발급하지 않는다");
    assert!(matches!(error, AuthError::NotRecorded(_)), "{error:?}");
    assert!(transport.sent().is_empty());
    assert!(!home.path.exists());
    assert_eq!(mode(parent), 0o755, "디렉터리 권한을 바꾸지 않는다");
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_token_file_stops_lookups_and_issuing() {
    for broken in ["{\"token\": \"FAKE-KIS-TOKEN-broken\"", "not json"] {
        let home = Home::new();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(home.path.parent().unwrap()).unwrap();
        std::fs::write(&home.path, broken).unwrap();
        std::fs::set_permissions(&home.path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let transport = serving(ok_price);
        let auth = home.auth(&transport);
        assert!(matches!(auth.halted(), Some(Halt::TokenFileUnreadable(_))));
        assert!(matches!(auth.token().await.err(), Some(AuthError::Halted(Halt::TokenFileUnreadable(_)))));
        assert!(matches!(auth.approval_key().await.err(), Some(AuthError::Halted(Halt::TokenFileUnreadable(_)))));
        let rest = home.rest(&transport);
        assert!(matches!(rest.call(price_request("005930", Priority::Screen)).await, Err(KisError::TokenFile(_))));
        assert!(transport.sent().is_empty());
        assert_eq!(std::fs::read_to_string(&home.path).unwrap(), broken, "파일은 그대로다");
    }
}

#[tokio::test(start_paused = true)]
async fn a_token_file_others_can_read_is_neither_read_nor_written() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(ok_price);

    std::fs::set_permissions(&home.path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let auth = home.auth(&transport);
    assert!(matches!(auth.token().await.err(), Some(AuthError::Halted(Halt::TokenFileUnreadable(_)))), "644 파일은 읽지 않는다");
    assert_eq!(mode(&home.path), 0o644);

    std::fs::set_permissions(&home.path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(home.path.parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let auth = home.auth(&transport);
    assert!(matches!(auth.token().await.err(), Some(AuthError::Halted(Halt::TokenFileUnreadable(_)))), "755 디렉터리의 파일은 읽지 않는다");
    assert!(transport.sent().is_empty());
}

#[tokio::test(start_paused = true)]
async fn within_ten_minutes_of_the_last_issue_request_no_request_is_sent_and_the_retry_time_is_given() {
    let home = Home::new();
    home.requested_issue_secs_ago(120);
    let transport = serving(ok_price);
    let clock = Clock::fake(now());
    let transport_dyn: Arc<dyn Transport> = transport.clone();
    let auth = KisAuth::new(credentials(), home.path.clone(), transport_dyn, clock.clone());

    let retry_at = now().plus_secs(-120 + 600);
    assert_eq!(auth.token().await.err(), Some(AuthError::IssueInterval { retry_at }));
    assert!(transport.sent().is_empty());

    clock.jump(479);
    assert_eq!(auth.token().await.err(), Some(AuthError::IssueInterval { retry_at }), "1초 모자라면 아직이다");
    clock.jump(1);
    assert_eq!(auth.token().await.unwrap().token.expose(), ISSUED_TOKEN);
    assert_eq!(transport.sent_to(TOKEN_PATH).len(), 1);

    let home = Home::new();
    home.requested_issue_secs_ago(120);
    let transport = serving(ok_price);
    let rest_error = home.rest(&transport).call(price_request("005930", Priority::Screen)).await.expect_err("10분 안이다");
    assert_eq!(rest_error, KisError::Gated { until: retry_at });
    assert!(transport.sent().is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_issue_limit_answer_is_an_interval_wait_and_a_refusal_halts_the_key() {
    let home = Home::new();
    let limited: Arc<FakeTransport> = FakeTransport::new(|_, _| response(403, "issue_limited.json"));
    let auth = home.auth(&limited);
    let error = auth.token().await.err().unwrap();
    assert_eq!(error, AuthError::IssueInterval { retry_at: now().plus_secs(600) });
    assert_eq!(limited.sent().len(), 1);
    assert!(auth.halted().is_none(), "발급 간격 대기는 멈춤이 아니다");

    let home = Home::new();
    let refused = FakeTransport::new(|_, _| response(403, "issue_refused.json"));
    let auth = home.auth(&refused);
    let error = auth.token().await.err().unwrap();
    assert!(matches!(&error, AuthError::Halted(Halt::Rejected(f)) if f.category() == Category::AuthBlocked), "{error:?}");
    assert!(matches!(auth.token().await.err(), Some(AuthError::Halted(_))));
    assert_eq!(refused.sent().len(), 1, "멈춘 뒤에는 다시 보내지 않는다");
}

#[tokio::test(start_paused = true)]
async fn a_rate_limit_answer_resends_when_the_window_empties_and_the_third_one_fails() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(|_, _| response(500, "rate_limited.json"));
    let rest = home.rest(&transport);
    let start = Instant::now();

    let error = rest.call(price_request("005930", Priority::Screen)).await.expect_err("세 번째 한도 초과는 실패");
    assert!(matches!(&error, KisError::Failed(f) if f.category() == Category::RateLimited && f.code() == Some("EGW00201")), "{error:?}");
    let sent = transport.sent_to(PRICE_PATH);
    assert_eq!(offsets(&sent, start), [Duration::ZERO, SPAN, SPAN * 2], "창이 비는 시각마다 같은 요청을 다시 보낸다");
    assert!(sent.iter().all(|s| s.query == sent[0].query), "같은 요청이다");
    assert!(transport.sent_to(TOKEN_PATH).is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_rate_limited_request_that_is_accepted_on_the_resend_succeeds() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(|_, n| if n < 2 { response(500, "rate_limited.json") } else { response(200, "price.json") });
    let rest = home.rest(&transport);
    let page = rest.call(price_request("005930", Priority::Screen)).await.unwrap();
    assert!(page.body.contains("stck_prpr") && !page.more);
    assert_eq!(transport.sent_to(PRICE_PATH).len(), 3);
}

#[tokio::test(start_paused = true)]
async fn the_sixteenth_send_in_a_one_second_window_waits_until_the_window_empties() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(ok_price);
    let rest = home.rest(&transport);
    let start = Instant::now();
    assert_eq!(KIS_PER_SECOND_LIMIT, 15);

    let calls: Vec<_> = (0..16).map(|i| rest.call(price_request(&format!("{:06}", 5930 + i), Priority::Screen))).collect();
    for result in futures::future::join_all(calls).await {
        result.unwrap();
    }
    let times = offsets(&transport.sent_to(PRICE_PATH), start);
    assert_eq!(times.len(), 16);
    assert!(times[..15].iter().all(|t| t.is_zero()), "{times:?}");
    assert_eq!(times[15], SPAN, "16번째는 창이 빌 때까지 기다린다");
}

#[tokio::test(start_paused = true)]
async fn the_queue_serves_orders_before_background_work_and_keeps_two_slots_for_the_screen() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(ok_price);
    let rest = home.rest(&transport);
    let start = Instant::now();

    let screen = tokio::spawn({
        let rest = rest.clone();
        async move { rest.call(price_request("100000", Priority::Screen)).await }
    });
    tokio::task::yield_now().await;
    let background: Vec<_> = (0..13)
        .map(|i| {
            let rest = rest.clone();
            tokio::spawn(async move { rest.call(price_request(&format!("20{i:04}"), Priority::Background)).await })
        })
        .collect();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert_eq!(transport.sent_to(PRICE_PATH).len(), 13, "화면 활동이 있으면 배경은 15 - 2칸까지만 쓴다");
    let order = tokio::spawn({
        let rest = rest.clone();
        async move { rest.call(price_request("300000", Priority::Order)).await }
    });
    tokio::task::yield_now().await;
    assert_eq!(transport.sent_to(PRICE_PATH).len(), 14, "주문은 예약한 칸을 쓴다");

    screen.await.unwrap().unwrap();
    order.await.unwrap().unwrap();
    for job in background {
        job.await.unwrap().unwrap();
    }
    let times = offsets(&transport.sent_to(PRICE_PATH), start);
    assert_eq!(times.len(), 15);
    assert_eq!(times.iter().filter(|t| t.is_zero()).count(), 14);
    assert!(times[14] >= SPAN, "13번째 배경 요청은 창이 빌 때까지 기다린다: {times:?}");
}

#[tokio::test(start_paused = true)]
async fn a_queued_order_goes_before_queued_background_requests() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(ok_price);
    let rest = home.rest(&transport);
    let filling: Vec<_> = (0..15).map(|i| rest.call(price_request(&format!("40{i:04}"), Priority::Order))).collect();
    let background = rest.call(price_request("500000", Priority::Background));
    let order = rest.call(price_request("600000", Priority::Order));
    let (_, background, order) = tokio::join!(futures::future::join_all(filling), background, order);
    background.unwrap();
    order.unwrap();
    let codes: Vec<String> = transport.sent_to(PRICE_PATH).iter().skip(15).map(|s| s.query.iter().find(|(n, _)| n == "FID_INPUT_ISCD").unwrap().1.clone()).collect();
    assert_eq!(codes, ["600000", "500000"]);
}

#[tokio::test(start_paused = true)]
async fn the_same_request_made_at_once_is_sent_once_and_every_caller_gets_the_answer() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(ok_price);
    let rest = home.rest(&transport);
    let (a, b, c) = tokio::join!(rest.call(price_request("005930", Priority::Screen)), rest.call(price_request("005930", Priority::Background)), rest.call(price_request("000660", Priority::Screen)));
    assert_eq!(a.unwrap(), b.unwrap());
    c.unwrap();
    assert_eq!(transport.sent_to(PRICE_PATH).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_market_request_carries_the_tr_headers_and_the_continuation_flag() {
    let home = Home::new();
    let transport = serving(|sent, _| {
        let more = sent.header("tr_cont") == Some("");
        Ok(HttpResponse { status: 200, tr_cont: more.then(|| "F".to_owned()), body: fixture("price.json") })
    });
    let rest = home.rest(&transport);
    let first = rest.call(price_request("005930", Priority::Screen)).await.unwrap();
    assert!(first.more, "응답 tr_cont F는 다음 쪽이 있다");
    let second = rest.call(price_request("005930", Priority::Screen).next_page()).await.unwrap();
    assert!(!second.more);

    let sent = transport.sent_to(PRICE_PATH);
    let request = &sent[0];
    assert_eq!(request.method, Method::Get);
    assert_eq!(request.query, [("FID_COND_MRKT_DIV_CODE".to_owned(), "J".to_owned()), ("FID_INPUT_ISCD".to_owned(), "005930".to_owned())]);
    assert_eq!(request.header("tr_id"), Some("FHKST01010100"));
    assert_eq!(request.header("appkey"), Some(APP_KEY));
    assert_eq!(request.header("appsecret"), Some(APP_SECRET));
    assert_eq!(request.header("authorization"), Some(format!("Bearer {ISSUED_TOKEN}").as_str()));
    assert_eq!(request.header("custtype"), Some("P"));
    assert_eq!((request.header("tr_cont"), sent[1].header("tr_cont")), (Some(""), Some("N")));
    assert_eq!(transport.sent_to(TOKEN_PATH).len(), 1, "토큰은 한 번만 받는다");
}

#[tokio::test(start_paused = true)]
async fn a_token_invalid_answer_reissues_once_and_resends_once() {
    let home = Home::new();
    home.holding_file_token(700);
    let transport = serving(|sent, _| if sent.header("authorization") == Some(format!("Bearer {FILE_TOKEN}").as_str()) { response(200, "token_invalid.json") } else { response(200, "price.json") });
    let rest = home.rest(&transport);

    let page = rest.call(price_request("005930", Priority::Screen)).await.unwrap();
    assert!(page.body.contains("stck_prpr"));
    let sent = transport.sent();
    let paths: Vec<&str> = sent.iter().map(|s| s.path).collect();
    assert_eq!(paths, [PRICE_PATH, TOKEN_PATH, PRICE_PATH]);
    assert_eq!(sent[2].header("authorization"), Some(format!("Bearer {ISSUED_TOKEN}").as_str()));
}

#[tokio::test(start_paused = true)]
async fn a_token_that_is_still_invalid_after_the_reissue_stops_everything() {
    let home = Home::new();
    home.holding_file_token(700);
    let transport = serving(|_, _| response(200, "token_invalid.json"));
    let rest = home.rest(&transport);

    let error = rest.call(price_request("005930", Priority::Screen)).await.err().unwrap();
    assert!(matches!(&error, KisError::Stopped(f) if f.category() == Category::TokenInvalid), "{error:?}");
    assert_eq!(transport.sent_to(TOKEN_PATH).len(), 1, "다시 발급은 한 번");
    assert_eq!(transport.sent_to(PRICE_PATH).len(), 2, "그 요청은 한 번 다시 보낸다");
    assert!(rest.auth().halted().is_some());

    let before = transport.sent().len();
    assert!(matches!(rest.call(price_request("000660", Priority::Screen)).await, Err(KisError::Stopped(_))));
    assert_eq!(transport.sent().len(), before, "멈춘 뒤에는 보내지 않는다");
}

#[tokio::test(start_paused = true)]
async fn an_invalid_token_right_after_an_issue_waits_for_the_interval_instead_of_issuing_again() {
    let home = Home::new();
    home.holding_file_token(60);
    let transport = serving(|_, _| response(200, "token_invalid.json"));
    let rest = home.rest(&transport);
    let error = rest.call(price_request("005930", Priority::Screen)).await.err().unwrap();
    assert!(matches!(error, KisError::Gated { until } if until == now().plus_secs(-60 + 600)), "{error:?}");
    assert!(transport.sent_to(TOKEN_PATH).is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_business_rejection_fails_only_that_request_and_an_unknown_answer_stops_only_that_api() {
    let home = Home::new();
    home.holding_file_token(3600);
    let rejected = serving(|_, _| response(200, "business_rejected.json"));
    let rest = home.rest(&rejected);
    for _ in 0..2 {
        let error = rest.call(price_request("005930", Priority::Screen)).await.err().unwrap();
        assert!(matches!(&error, KisError::Failed(f) if f.category() == Category::BusinessRejected), "{error:?}");
    }
    assert_eq!(rejected.sent_to(PRICE_PATH).len(), 2, "업무 거절은 다음 요청을 막지 않는다");

    let home = Home::new();
    home.holding_file_token(3600);
    let unknown = serving(|_, _| Ok(HttpResponse { status: 502, tr_cont: None, body: "<html>FAKE-KIS-BODY-must-not-appear</html>".into() }));
    let rest = home.rest(&unknown);
    let error = rest.call(price_request("005930", Priority::Screen)).await.err().unwrap();
    assert!(matches!(&error, KisError::Stopped(f) if f.category() == Category::Unknown), "{error:?}");
    assert!(!error.to_string().contains("FAKE-"));
    assert!(matches!(rest.call(price_request("000660", Priority::Screen)).await, Err(KisError::Stopped(_))));
    assert_eq!(unknown.sent_to(PRICE_PATH).len(), 1);
    assert!(rest.auth().halted().is_none(), "경로만 멈춘다");
}

#[tokio::test(start_paused = true)]
async fn a_transport_failure_is_returned_to_the_caller() {
    let home = Home::new();
    home.holding_file_token(3600);
    let transport = serving(|_, _| Err(TransportError::refused()));
    let error = home.rest(&transport).call(price_request("005930", Priority::Screen)).await.err().unwrap();
    assert!(matches!(error, KisError::Transport(_)), "{error:?}");
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

struct Peer {
    to_client: UnboundedSender<Result<Message, WsError>>,
    from_client: UnboundedReceiver<Message>,
}

impl Peer {
    fn say(&self, text: &str) {
        self.to_client.unbounded_send(Ok(Message::Text(text.into()))).unwrap();
    }

    async fn heard(&mut self) -> serde_json::Value {
        let message = tokio::time::timeout(WAIT, self.from_client.next()).await.expect("클라이언트가 보내지 않았다").expect("연결이 닫혔다");
        let Message::Text(text) = message else { panic!("글이 아니다: {message:?}") };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn heard_text(&mut self) -> String {
        let message = tokio::time::timeout(WAIT, self.from_client.next()).await.expect("클라이언트가 보내지 않았다").expect("연결이 닫혔다");
        let Message::Text(text) = message else { panic!("글이 아니다: {message:?}") };
        text.as_str().to_owned()
    }

    async fn closed_by_client(&mut self) -> bool {
        tokio::time::timeout(WAIT, self.from_client.next()).await.expect("닫히지 않았다").is_none()
    }
}

#[derive(Clone, Default)]
struct ScriptedConnector {
    sockets: Arc<Mutex<VecDeque<Socket>>>,
    attempts: Arc<Mutex<usize>>,
}

impl ScriptedConnector {
    fn queue_connection(&self) -> Peer {
        let (to_client, incoming) = unbounded();
        let (outgoing, from_client) = unbounded();
        self.sockets.lock().unwrap().push_back(Box::new(ChannelSocket { incoming, outgoing }));
        Peer { to_client, from_client }
    }

    fn attempts(&self) -> usize {
        *self.attempts.lock().unwrap()
    }
}

impl Connector for ScriptedConnector {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        *self.attempts.lock().unwrap() += 1;
        let next = self.sockets.lock().unwrap().pop_front();
        Box::pin(async move { next.ok_or(WsError::ConnectionClosed) })
    }
}

fn subscription(tr_id: &str, tr_key: &str) -> Subscription {
    Subscription { tr_id: tr_id.into(), tr_key: tr_key.into() }
}

fn desired(subscriptions: &[Subscription]) -> BTreeSet<Subscription> {
    subscriptions.iter().cloned().collect()
}

async fn next_event(events: &mut tokio::sync::mpsc::Receiver<StreamEvent>) -> StreamEvent {
    tokio::time::timeout(WAIT, events.recv()).await.expect("이벤트가 오지 않았다").expect("세션이 끝났다")
}

fn stream_for(home: &Home, connector: &ScriptedConnector) -> (KisStream, tokio::sync::mpsc::Receiver<StreamEvent>, Arc<FakeTransport>) {
    let transport = serving(ok_price);
    KisStreamParts::start(home, connector, transport)
}

struct KisStreamParts;

impl KisStreamParts {
    fn start(home: &Home, connector: &ScriptedConnector, transport: Arc<FakeTransport>) -> (KisStream, tokio::sync::mpsc::Receiver<StreamEvent>, Arc<FakeTransport>) {
        let (stream, events) = KisStream::spawn(Box::new(connector.clone()), home.auth(&transport));
        (stream, events, transport)
    }
}

#[tokio::test(start_paused = true)]
async fn the_realtime_session_registers_confirms_answers_pingpong_and_splits_frames() {
    let home = Home::new();
    let connector = ScriptedConnector::default();
    let mut peer = connector.queue_connection();
    let (stream, mut events, transport) = stream_for(&home, &connector);
    let samsung = subscription("H0STCNT0", "005930");
    assert_eq!(KIS_REALTIME_LIMIT, 40);

    stream.set_desired(desired(std::slice::from_ref(&samsung)));
    let register = peer.heard().await;
    assert_eq!(register["header"]["tr_type"], "1");
    assert_eq!(register["header"]["approval_key"], APPROVAL_KEY);
    assert_eq!(register["header"]["custtype"], "P");
    assert_eq!(register["body"]["input"], serde_json::json!({"tr_id": "H0STCNT0", "tr_key": "005930"}));
    assert_eq!(transport.sent_to(APPROVAL_PATH).len(), 1);
    let approval_body: serde_json::Value = serde_json::from_str(&transport.sent_to(APPROVAL_PATH)[0].body).unwrap();
    assert_eq!((approval_body["appkey"].as_str(), approval_body["secretkey"].as_str()), (Some(APP_KEY), Some(APP_SECRET)));

    peer.say(&fixture("subscribe_ack.json"));
    assert_eq!(next_event(&mut events).await, StreamEvent::Registered(samsung.clone()));
    assert_eq!(stream.status(), StreamStatus::Open);

    let pingpong = fixture("pingpong.json");
    peer.say(&pingpong);
    assert_eq!(peer.heard_text().await, pingpong, "PINGPONG은 그대로 되돌려 보낸다");

    peer.say("0|H0STCNT0|001|a^b^c");
    let StreamEvent::Frame(frame) = next_event(&mut events).await else { panic!("프레임이 아니다") };
    assert_eq!((frame.tr_id.as_str(), frame.count, frame.fields.as_slice()), ("H0STCNT0", 1, &["a".to_owned(), "b".to_owned(), "c".to_owned()][..]));

    stream.set_desired(BTreeSet::new());
    let unregister = peer.heard().await;
    assert_eq!(unregister["header"]["tr_type"], "2");
    assert_eq!(unregister["body"]["input"], serde_json::json!({"tr_id": "H0STCNT0", "tr_key": "005930"}));
}

#[tokio::test(start_paused = true)]
async fn changing_the_registrations_unregisters_before_it_registers() {
    let home = Home::new();
    let connector = ScriptedConnector::default();
    let mut peer = connector.queue_connection();
    let (stream, _events, _transport) = stream_for(&home, &connector);
    let (first, second, third) = (subscription("H0STCNT0", "005930"), subscription("H0STCNT0", "000660"), subscription("H0STASP0", "005930"));

    stream.set_desired(desired(std::slice::from_ref(&first)));
    peer.heard().await;
    stream.set_desired(desired(&[second.clone(), third.clone()]));
    let heard = [peer.heard().await, peer.heard().await, peer.heard().await];
    let kinds: Vec<_> = heard.iter().map(|v| v["header"]["tr_type"].as_str().unwrap().to_owned()).collect();
    assert_eq!(kinds, ["2", "1", "1"], "해지가 먼저다");
    assert_eq!(heard[0]["body"]["input"]["tr_key"], "005930");
}

#[tokio::test(start_paused = true)]
async fn a_rejected_registration_is_reported_and_the_session_stays_open() {
    let home = Home::new();
    let connector = ScriptedConnector::default();
    let peer = connector.queue_connection();
    let (stream, mut events, _transport) = stream_for(&home, &connector);
    stream.set_desired(desired(&[subscription("H0STCNT0", "000660")]));
    peer.say(&fixture("subscribe_seats_exceeded.json"));
    let StreamEvent::Rejected { subscription, failure } = next_event(&mut events).await else { panic!("거절이 아니다") };
    assert_eq!(subscription, Some(self::subscription("H0STCNT0", "000660")));
    assert_eq!(failure.category(), Category::SeatsExceeded);
    assert_eq!(stream.status(), StreamStatus::Open);
}

#[tokio::test(start_paused = true)]
async fn an_in_use_elsewhere_answer_closes_the_session_and_it_never_connects_again() {
    let home = Home::new();
    let connector = ScriptedConnector::default();
    let mut peer = connector.queue_connection();
    let _second = connector.queue_connection();
    let (stream, mut events, _transport) = stream_for(&home, &connector);
    stream.set_desired(desired(&[subscription("H0STCNT0", "005930")]));
    peer.heard().await;

    peer.say(&fixture("in_use_elsewhere.json"));
    assert_eq!(next_event(&mut events).await, StreamEvent::InUseElsewhere);
    assert_eq!(stream.status(), StreamStatus::InUseElsewhere);
    assert!(peer.closed_by_client().await, "세션을 닫는다");

    tokio::time::sleep(Duration::from_secs(3600)).await;
    assert_eq!(connector.attempts(), 1, "저절로 다시 잇지 않는다");
    assert_eq!(stream.status(), StreamStatus::InUseElsewhere);
    stream.set_desired(desired(&[subscription("H0STCNT0", "000660")]));
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(connector.attempts(), 1, "구독을 바꿔도 다시 잇지 않는다");
}

#[tokio::test(start_paused = true)]
async fn a_lost_connection_is_reported_and_reconnects_with_the_same_registrations() {
    let home = Home::new();
    let connector = ScriptedConnector::default();
    let mut first_peer = connector.queue_connection();
    let mut second_peer = connector.queue_connection();
    let (stream, mut events, transport) = stream_for(&home, &connector);
    let samsung = subscription("H0STCNT0", "005930");
    stream.set_desired(desired(std::slice::from_ref(&samsung)));
    first_peer.heard().await;

    drop(first_peer);
    assert_eq!(next_event(&mut events).await, StreamEvent::Disconnected(End::Lost));
    let register = second_peer.heard().await;
    assert_eq!(register["body"]["input"]["tr_key"], "005930", "다시 접속하면 원하는 등록을 다시 보낸다");
    assert_eq!(connector.attempts(), 2);
    assert_eq!(transport.sent_to(APPROVAL_PATH).len(), 2, "접속키는 접속할 때마다 받는다");
}

#[tokio::test(start_paused = true)]
async fn a_failed_connection_retries_with_a_backoff() {
    let home = Home::new();
    let connector = ScriptedConnector::default();
    let (_stream, mut events, _transport) = stream_for(&home, &connector);
    assert_eq!(next_event(&mut events).await, StreamEvent::Disconnected(End::ConnectFailed));
    assert_eq!(next_event(&mut events).await, StreamEvent::Disconnected(End::ConnectFailed));
    assert_eq!(connector.attempts(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_halted_key_does_not_open_the_realtime_session() {
    let home = Home::new();
    let connector = ScriptedConnector::default();
    let refused = FakeTransport::new(|_, _| response(403, "issue_refused.json"));
    let (stream, _events, _transport) = KisStreamParts::start(&home, &connector, refused);
    let mut status = stream.watch_status();
    tokio::time::timeout(WAIT, status.wait_for(|s| matches!(s, StreamStatus::Disconnected(End::ApprovalFailed) | StreamStatus::Halted))).await.expect("상태가 바뀌지 않았다").unwrap();
    tokio::time::sleep(Duration::from_secs(3600)).await;
    assert_eq!(connector.attempts(), 0, "접속키를 받지 못하면 접속하지 않는다");
}

thread_local! {
    static CAPTURED: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

struct CapturedLogs;

impl std::io::Write for CapturedLogs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        CAPTURED.with(|logs| logs.borrow_mut().extend_from_slice(bytes));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn logs_errors_and_debug_output_never_contain_secrets_tokens_or_approval_keys() {
    let subscriber = tracing_subscriber::fmt().with_writer(|| CapturedLogs).with_ansi(false).with_max_level(tracing::Level::TRACE).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let mut outputs: Vec<String> = Vec::new();

    let home = Home::new();
    home.holding_file_token(700);
    let invalid = serving(|_, _| response(200, "token_invalid.json"));
    let rest = home.rest(&invalid);
    outputs.push(format!("{rest:?}"));
    let error = rest.call(price_request("005930", Priority::Screen)).await.err().unwrap();
    outputs.extend([error.to_string(), format!("{error:?}"), format!("{:?}", rest.auth())]);

    let home = Home::new();
    home.holding_file_token(3600);
    let limited = serving(|_, _| response(500, "rate_limited.json"));
    let error = home.rest(&limited).call(price_request("005930", Priority::Screen)).await.err().unwrap();
    outputs.extend([error.to_string(), format!("{error:?}")]);

    let home = Home::new();
    let refused = FakeTransport::new(|_, _| response(403, "issue_refused.json"));
    let auth = home.auth(&refused);
    let error = auth.token().await.err().unwrap();
    outputs.extend([error.to_string(), format!("{error:?}"), format!("{auth:?}")]);

    let home = Home::new();
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(home.path.parent().unwrap()).unwrap();
    std::fs::write(&home.path, "{\"token\": \"FAKE-KIS-TOKEN-broken\"").unwrap();
    std::fs::set_permissions(&home.path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let error = home.auth(&serving(ok_price)).token().await.err().unwrap();
    outputs.extend([error.to_string(), format!("{error:?}")]);

    let home = Home::new();
    let connector = ScriptedConnector::default();
    let peer = connector.queue_connection();
    let (stream, mut events, _transport) = stream_for(&home, &connector);
    stream.set_desired(desired(&[subscription("H0STCNT0", "005930")]));
    peer.say(&fixture("subscribe_seats_exceeded.json"));
    let event = next_event(&mut events).await;
    outputs.push(format!("{event:?}"));
    peer.say(&fixture("in_use_elsewhere.json"));
    outputs.push(format!("{:?}", next_event(&mut events).await));

    let logs = CAPTURED.with(|logs| String::from_utf8(logs.borrow().clone()).unwrap());
    assert!(!logs.is_empty(), "실패마다 로그를 남긴다");
    outputs.push(logs);
    for text in outputs {
        for secret in [APP_KEY, APP_SECRET, FILE_TOKEN, ISSUED_TOKEN, APPROVAL_KEY, "FAKE-KIS-"] {
            assert!(!text.contains(secret), "{secret}가 새어 나왔다: {text}");
        }
    }
}
