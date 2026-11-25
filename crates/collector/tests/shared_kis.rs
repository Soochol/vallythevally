use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::collect::link::{Events, Incoming};
use collector::keys::{ActiveKey, KeyIdentity, KeyRole};
use collector::protocol::{Command, Event, KeyName};
use collector::shared::child::{SharedParts, run_shared};
use collector::shared::{AssignedJob, Assignment, JobName};
use collector::supervise::{ChildMessage, ChildProcess, Launcher, SharedInjected, SharedInputs, SharedLaunch, SharedSupervisor, Settings, Spawned};
use domain::{KstDate, KstTime};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kis::transport::{HttpRequest as KisHttpRequest, HttpResponse as KisHttpResponse, Transport as KisTransport, TransportError as KisTransportError};
use server::kiwoom::token_file::credential_id;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{Board, Broker, DataKind, OverviewBody};
use tokio::sync::{mpsc, watch};
use tokio::time::sleep;

const DATE: u32 = 20261125;
const KIS_APP_KEY: &str = "FAKE-KIS-APPKEY-SHARED-0001";
const KIS_APP_SECRET: &str = "FAKE-KIS-SECRET-SHARED-0001";

fn today() -> KstDate {
    KstDate::new(2026, 11, 25).unwrap()
}

fn at(hour: u32, minute: u32, second: u32) -> KstTime {
    kst(today(), hour, minute, second)
}

fn key_name(text: &str) -> KeyName {
    KeyName::parse(text).unwrap()
}

struct UnusedKiwoom;

impl Transport for UnusedKiwoom {
    fn send(&self, _: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        Box::pin(async { panic!("한투 공용 자료 자식은 키움 transport를 부르지 않는다") })
    }
}

#[derive(Clone)]
struct RecordedKisCall {
    path: &'static str,
    app_key: Option<String>,
    app_secret: Option<String>,
    authorization: Option<String>,
}

struct FakeKis {
    calls: Mutex<Vec<RecordedKisCall>>,
    reject_token: AtomicBool,
    issued_count: AtomicUsize,
}

impl FakeKis {
    fn new() -> Arc<Self> {
        Arc::new(FakeKis { calls: Mutex::default(), reject_token: AtomicBool::new(false), issued_count: AtomicUsize::new(0) })
    }

    fn set_reject_token(&self, reject: bool) {
        self.reject_token.store(reject, Ordering::SeqCst);
    }

    fn calls(&self) -> Vec<RecordedKisCall> {
        self.calls.lock().unwrap().clone()
    }

    fn clear_calls(&self) {
        self.calls.lock().unwrap().clear();
    }

    fn issued(&self) -> usize {
        self.issued_count.load(Ordering::SeqCst)
    }
}

fn kis_reply(path: &str) -> Value {
    match path {
        "/uapi/domestic-stock/v1/quotations/inquire-index-price" => json!({
            "rt_cd": "0",
            "msg_cd": "MCA00000",
            "output": {
                "bstp_nmix_prpr": "2500.00",
                "bstp_nmix_prdy_vrss": "10.00",
                "prdy_vrss_sign": "2",
                "bstp_nmix_prdy_ctrt": "0.40",
                "acml_tr_pbmn": "12345678",
                "ascn_issu_cnt": "500",
                "stnr_issu_cnt": "50",
                "down_issu_cnt": "350",
                "uplm_issu_cnt": "3",
                "lslm_issu_cnt": "0"
            }
        }),
        _ => json!({"rt_cd": "1", "msg_cd": "EGW00000", "msg1": "시험용 거절"}),
    }
}

impl KisTransport for FakeKis {
    fn send(&self, request: KisHttpRequest) -> BoxFuture<'static, Result<KisHttpResponse, KisTransportError>> {
        self.calls.lock().unwrap().push(RecordedKisCall {
            path: request.path,
            app_key: request.header("appkey").map(str::to_owned),
            app_secret: request.header("appsecret").map(str::to_owned),
            authorization: request.header("authorization").map(str::to_owned),
        });
        let response = if request.path == "/oauth2/tokenP" {
            let number = self.issued_count.fetch_add(1, Ordering::SeqCst) + 1;
            KisHttpResponse {
                status: 200,
                tr_cont: None,
                body: json!({
                    "access_token": format!("FAKE-KIS-TOKEN-{number}"),
                    "expires_in": 86400
                })
                .to_string(),
            }
        } else if self.reject_token.load(Ordering::SeqCst) {
            KisHttpResponse {
                status: 401,
                tr_cont: None,
                body: json!({"rt_cd": "1", "msg_cd": "EGW00123", "msg1": "기간이 만료된 token 입니다."}).to_string(),
            }
        } else {
            KisHttpResponse { status: 200, tr_cont: None, body: kis_reply(request.path).to_string() }
        };
        Box::pin(async move { Ok(response) })
    }
}

fn overview_board(shared_dir: &Path) -> Option<(server::shared_data::Header, OverviewBody)> {
    let board = Board::<OverviewBody>::new(DataKind::MarketOverview);
    board.poll(shared_dir);
    board.current().map(|loaded| (loaded.header.clone(), loaded.body.clone()))
}

#[tokio::test(start_paused = true)]
async fn kis_shared_child_runs_overview_with_supplied_headers_and_reports_invalid_token_without_issuing() {
    let folder = tempfile::tempdir().unwrap();
    let shared_dir = folder.path().join("data").join("shared");
    std::fs::create_dir_all(&shared_dir).unwrap();
    let clock = Clock::fake(at(10, 0, 0));
    let kis = FakeKis::new();
    let (command_tx, commands) = mpsc::unbounded_channel::<Incoming>();
    let (event_sink, event_source) = std::sync::mpsc::channel();
    let (stop, shutdown) = watch::channel(false);

    let task = tokio::spawn(run_shared(SharedParts {
        key: key_name("rest-kis"),
        broker: Broker::Kis,
        shared_dir: shared_dir.clone(),
        transport: Arc::new(UnusedKiwoom),
        kis_transport: Some(kis.clone()),
        clock: clock.clone(),
        total_per_second: None,
        commands,
        events: Events::to(event_sink),
        shutdown,
    }));

    sleep(Duration::from_millis(10)).await;
    command_tx
        .send(Ok(Command::Token {
            token: Secret::new("FAKE-SUPPLIED-TOKEN-1".to_owned()),
            generation: 1,
            expires_at: Some(at(10, 0, 0).plus_secs(3600).unix()),
            app_key: Some(Secret::new(KIS_APP_KEY.to_owned())),
            app_secret: Some(Secret::new(KIS_APP_SECRET.to_owned())),
        }))
        .unwrap();
    command_tx
        .send(Ok(Command::Assign {
            date: DATE,
            jobs: vec![AssignedJob { job: JobName::Overview, period_secs: 15, slice_index: 0, slice_count: 1, peers: vec![Broker::Kis], options: Value::Null }],
        }))
        .unwrap();

    sleep(Duration::from_secs(5)).await;
    let first_calls = kis.calls();
    assert!(!first_calls.is_empty(), "한투 공용 자료 자식이 개요 요청을 보냈다");
    assert!(first_calls.iter().all(|call| call.path != "/oauth2/tokenP" && call.path != "/oauth2/Approval"), "자식은 토큰을 발급하지 않는다");
    assert!(
        first_calls.iter().all(|call| {
            call.app_key.as_deref() == Some(KIS_APP_KEY)
                && call.app_secret.as_deref() == Some(KIS_APP_SECRET)
                && call.authorization.as_deref() == Some("Bearer FAKE-SUPPLIED-TOKEN-1")
        }),
        "모든 요청에 appkey·appsecret·authorization 헤더가 실린다"
    );
    let (header, body) = overview_board(&shared_dir).expect("개요 파일이 만들어졌다");
    assert_eq!(header.sources.len(), 1);
    assert_eq!((header.sources[0].key_name.as_str(), header.sources[0].broker), ("rest-kis", Broker::Kis));
    assert!(body.kospi.index.is_some());

    kis.clear_calls();
    kis.set_reject_token(true);
    sleep(Duration::from_secs(16)).await;

    let invalid_calls = kis.calls();
    assert!(!invalid_calls.is_empty());
    assert!(invalid_calls.iter().all(|call| call.path != "/oauth2/tokenP"), "토큰 무효 응답에도 자식이 스스로 발급하지 않는다");
    let events: Vec<Event> = event_source.try_iter().collect();
    assert!(events.contains(&Event::TokenInvalid { generation: 1 }), "자식이 TokenInvalid를 올린다: {events:?}");

    kis.clear_calls();
    kis.set_reject_token(false);
    command_tx
        .send(Ok(Command::Token {
            token: Secret::new("FAKE-SUPPLIED-TOKEN-2".to_owned()),
            generation: 2,
            expires_at: Some(at(10, 0, 0).plus_secs(7200).unix()),
            app_key: Some(Secret::new(KIS_APP_KEY.to_owned())),
            app_secret: Some(Secret::new(KIS_APP_SECRET.to_owned())),
        }))
        .unwrap();
    sleep(Duration::from_secs(16)).await;
    let recovered_calls = kis.calls();
    assert!(!recovered_calls.is_empty(), "새 토큰을 받은 뒤 멈추지 않고 다시 호출한다");
    assert!(
        recovered_calls.iter().all(|call| call.authorization.as_deref() == Some("Bearer FAKE-SUPPLIED-TOKEN-2")),
        "새 토큰으로 호출한다"
    );

    stop.send(true).unwrap();
    task.await.unwrap();
}

struct FakeChildHandle {
    commands: mpsc::UnboundedSender<Incoming>,
    stop: watch::Sender<bool>,
    messages: mpsc::UnboundedSender<ChildMessage>,
    alive: Arc<AtomicBool>,
}

impl FakeChildHandle {
    fn end(&self, code: i32) {
        let _ = self.stop.send(true);
        if self.alive.swap(false, Ordering::SeqCst) {
            let _ = self.messages.send(ChildMessage::Exited(Some(code)));
        }
    }
}

impl ChildProcess for FakeChildHandle {
    fn send(&mut self, command: &Command) {
        let _ = self.commands.send(Ok(command.clone()));
        if *command == Command::Shutdown {
            self.end(0);
        }
    }

    fn terminate(&mut self) {
        self.end(0);
    }

    fn kill(&mut self) {
        self.end(137);
    }
}

struct KisLauncher {
    child_kis: Arc<FakeKis>,
    clock: Clock,
    shared_dir: PathBuf,
}

impl Launcher for KisLauncher {
    fn launch(&self, _: &KeyName) -> io::Result<Spawned> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "수집 자식은 띄우지 않는다"))
    }

    fn launch_shared(&self, key: &KeyName, launch: &SharedLaunch) -> io::Result<Spawned> {
        let (messages_tx, messages) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let (stop, shutdown) = watch::channel(false);
        let (command_tx, commands) = mpsc::unbounded_channel();
        let handle = FakeChildHandle { commands: command_tx, stop, messages: messages_tx.clone(), alive: alive.clone() };
        let (event_sink, event_source) = std::sync::mpsc::channel();
        let forward = messages_tx.clone();
        tokio::spawn(async move {
            loop {
                match event_source.try_recv() {
                    Ok(event) => {
                        if forward.send(ChildMessage::Event(event)).is_err() {
                            return;
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => sleep(Duration::from_millis(1)).await,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
                }
            }
        });
        let parts = SharedParts {
            key: key.clone(),
            broker: launch.broker,
            shared_dir: self.shared_dir.clone(),
            transport: Arc::new(UnusedKiwoom),
            kis_transport: Some(self.child_kis.clone()),
            clock: self.clock.clone(),
            total_per_second: launch.total_per_second,
            commands,
            events: Events::to(event_sink),
            shutdown,
        };
        tokio::spawn(async move {
            run_shared(parts).await;
            if alive.swap(false, Ordering::SeqCst) {
                let _ = messages_tx.send(ChildMessage::Exited(Some(0)));
            }
        });
        Ok(Spawned { pid: Some(6001), process: Box::new(handle), messages })
    }
}

#[tokio::test(start_paused = true)]
async fn shared_supervisor_issues_kis_token_and_delivers_credentials_over_stdin_to_the_child() {
    let folder = tempfile::tempdir().unwrap();
    let data_dir = folder.path().join("data");
    let shared_dir = data_dir.join("shared");
    std::fs::create_dir_all(&shared_dir).unwrap();
    let key = ActiveKey {
        broker: Broker::Kis,
        identity: KeyIdentity { name: key_name("rest-kis"), role: KeyRole::Rest, app_key_hash: credential_id(KIS_APP_KEY) },
        app_key: Secret::new(KIS_APP_KEY.to_owned()),
        app_secret: Secret::new(KIS_APP_SECRET.to_owned()),
        token_path: folder.path().join("keys").join("rest-kis").join("token.json"),
        lock_path: folder.path().join("keys").join("rest-kis").join("collector.lock"),
    };
    let assignment = Assignment::parse(
        &json!({"version": 1, "jobs": {"overview": {"keys": ["rest-kis"], "period_secs": 30}}}).to_string(),
        Path::new("/etc/collector-shared.json"),
        std::slice::from_ref(&key),
    )
    .unwrap();
    let clock = Clock::fake(at(10, 0, 0));
    let daemon_kis = FakeKis::new();
    let child_kis = FakeKis::new();
    let launcher = Arc::new(KisLauncher { child_kis: child_kis.clone(), clock: clock.clone(), shared_dir: shared_dir.clone() });
    let supervisor = SharedSupervisor::start(
        SharedInputs { keys: vec![key], assignment, date: DATE, data_dir, settings: Settings::default() },
        SharedInjected { launcher, transport: Arc::new(UnusedKiwoom), kis_transport: Some(daemon_kis.clone()), clock: clock.clone() },
    )
    .unwrap();
    let (stop, shutdown) = watch::channel(false);
    let done = tokio::spawn(supervisor.run(shutdown));

    sleep(Duration::from_secs(10)).await;
    assert_eq!(daemon_kis.issued(), 1, "데몬이 한투 토큰을 한 번 발급했다");
    assert_eq!(child_kis.issued(), 0, "자식은 한투 토큰을 발급하지 않는다");
    let calls = child_kis.calls();
    assert!(!calls.is_empty(), "자식이 데몬에게 받은 토큰과 헤더로 한투를 호출했다");
    assert!(
        calls.iter().all(|call| {
            call.app_key.as_deref() == Some(KIS_APP_KEY)
                && call.app_secret.as_deref() == Some(KIS_APP_SECRET)
                && call.authorization.as_deref() == Some("Bearer FAKE-KIS-TOKEN-1")
        }),
        "자식 요청에 데몬이 넘긴 키·시크릿·토큰이 실린다"
    );
    let (header, _) = overview_board(&shared_dir).expect("공용 개요 파일이 쓰였다");
    assert_eq!((header.sources[0].key_name.as_str(), header.sources[0].broker), ("rest-kis", Broker::Kis));

    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(30), done).await.expect("감독이 끝나지 않았다").unwrap();
}
