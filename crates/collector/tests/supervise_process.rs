use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::keys::KeyRole;
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile, write_plan};
use collector::protocol::KeyName;
use collector::raw_read::{RawContent, RawItem, read_day};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use server::instance::InstanceLock;
use server::kiwoom::token_file::{Saved, SavedToken, TokenFile, credential_id};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message;

const DATE: u32 = 20991231;
const WAIT: Duration = Duration::from_secs(40);
const KEYS: [(&str, bool); 2] = [("collect-01", false), ("spare-01", true)];

struct Kiwoom {
    url: String,
    received: Arc<Mutex<Vec<Value>>>,
}

impl Kiwoom {
    async fn start() -> Kiwoom {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let kiwoom = Kiwoom { url: format!("ws://{}", listener.local_addr().unwrap()), received: Arc::default() };
        let received = kiwoom.received.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { continue };
                let received = received.clone();
                tokio::spawn(async move {
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let request: Value = serde_json::from_str(text.as_str()).unwrap();
                        let trnm = request["trnm"].as_str().unwrap().to_owned();
                        received.lock().unwrap().push(request);
                        let ack = json!({"trnm": trnm, "return_code": 0, "return_msg": ""});
                        if socket.send(Message::Text(ack.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        kiwoom
    }

    fn requests(&self, trnm: &str) -> Vec<Value> {
        self.received.lock().unwrap().iter().filter(|request| request["trnm"] == trnm).cloned().collect()
    }

    async fn until(&self, trnm: &str, count: usize) {
        timeout(WAIT, async {
            while self.requests(trnm).len() < count {
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{trnm} 요청 {count}개가 오지 않았다: {:?}", self.received.lock().unwrap()));
    }
}

fn seeded_token(name: &str) -> String {
    format!("FAKE-SEEDED-TOKEN-{name}")
}

struct Setup {
    folder: tempfile::TempDir,
    keys_file: PathBuf,
    state: PathBuf,
    data: PathBuf,
}

fn set_up() -> Setup {
    let folder = tempfile::tempdir().unwrap();
    let (state, data) = (folder.path().join("state"), folder.path().join("data"));
    let mut entries = Vec::new();
    let mut shares = Vec::new();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    for (name, spare) in KEYS {
        let app_key = format!("FAKE-APPKEY-{name}");
        let secret_file = folder.path().join(format!("{name}.env"));
        std::fs::write(&secret_file, format!("VALLY_COLLECTOR_APP_KEY={app_key}\nVALLY_COLLECTOR_APP_SECRET=FAKE-SECRET-{name}\n")).unwrap();
        std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let hash = credential_id(&app_key);
        entries.push(json!({"name": name, "active": true, "spare": spare, "app_key_hash": hash, "secret_file": secret_file}));
        let lock = InstanceLock::acquire(&state.join(name).join("collector.lock")).unwrap();
        let file = TokenFile::new(state.join(name).join("token.json"), &lock);
        let token = SavedToken { value: seeded_token(name), expires_dt: "20991231000000".to_owned(), issued_at: now - 3600 };
        file.save(&Saved { credential: Some(hash.clone()), token: Some(token), last_request_at: now - 3600, ..Saved::default() }).unwrap();
        shares.push(KeyShare {
            name: KeyName::parse(name).unwrap(),
            role: if spare { KeyRole::Spare } else { KeyRole::Collecting },
            app_key_hash: hash,
            stocks: if spare { Vec::new() } else { vec!["000001".to_owned(), "000002".to_owned()] },
            market_types: if spare { Vec::new() } else { MARKET_TYPES.to_vec() },
            rest_jobs: Vec::new(),
            load: 0,
        });
    }
    let keys_file = folder.path().join("keys.json");
    std::fs::write(&keys_file, serde_json::to_vec(&json!({"version": 1, "keys": entries})).unwrap()).unwrap();
    let plan = PlanFile {
        format_version: 1,
        date: DATE,
        created_at: "2099-12-31T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: 2, universe_replaced: None },
        keys: shares,
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    };
    write_plan(&data, &plan).unwrap();
    Setup { folder, keys_file, state, data }
}

fn spawn_daemon(setup: &Setup, kiwoom: &Kiwoom) -> Child {
    let log = std::fs::File::create(setup.folder.path().join("daemon.log")).unwrap();
    Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["supervise", "--date", &DATE.to_string(), "--keys"])
        .arg(&setup.keys_file)
        .arg("--state")
        .arg(&setup.state)
        .arg("--data")
        .arg(&setup.data)
        .env_clear()
        .env("VALLY_COLLECTOR_WS_URL", &kiwoom.url)
        .env("VALLY_COLLECTOR_REST_URL", "http://127.0.0.1:1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

fn children_of(parent: u32) -> Vec<u32> {
    let mut children = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        let after_name = stat.rsplit_once(')').map_or("", |(_, rest)| rest);
        let mut fields = after_name.split_whitespace();
        let (_state, ppid) = (fields.next(), fields.next().and_then(|ppid| ppid.parse::<u32>().ok()));
        if ppid == Some(parent) {
            children.push(pid);
        }
    }
    children
}

fn is_running(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().next().map(|state| state != "Z")).unwrap_or(false),
        Err(_) => false,
    }
}

async fn until_all_gone(pids: &[u32]) {
    timeout(WAIT, async {
        while pids.iter().any(|pid| is_running(*pid)) {
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("자식이 남았다: {:?}", pids.iter().filter(|pid| is_running(**pid)).collect::<Vec<_>>()));
}

async fn daemon_with_two_children_online(setup: &Setup, kiwoom: &Kiwoom) -> (Child, Vec<u32>) {
    let daemon = spawn_daemon(setup, kiwoom);
    let daemon_pid = daemon.id().unwrap();
    kiwoom.until("LOGIN", 2).await;
    kiwoom.until("REG", 1).await;
    let logins: Vec<String> = kiwoom.requests("LOGIN").iter().map(|request| request["token"].as_str().unwrap().to_owned()).collect();
    for (name, _) in KEYS {
        assert!(logins.contains(&seeded_token(name)), "{name}의 토큰으로 LOGIN해야 한다: {logins:?}");
    }
    let registered_items: Vec<Value> = kiwoom.requests("REG").iter().flat_map(|request| request["data"].as_array().unwrap().clone()).collect();
    assert!(registered_items.iter().any(|item| item["item"] == json!(["000001_AL", "000002_AL"])), "{registered_items:?}");
    sleep(Duration::from_secs(1)).await;
    let children = children_of(daemon_pid);
    assert_eq!(children.len(), 2, "자식은 수집 키 하나와 예비 키 하나");
    (daemon, children)
}

fn stored_live_markers(data: &Path) -> usize {
    let days: Vec<u32> = std::fs::read_dir(data.join("raw")).unwrap().map(|entry| entry.unwrap().file_name().to_str().unwrap().parse().unwrap()).collect();
    days.into_iter()
        .flat_map(|day| read_day(data, day).unwrap())
        .filter(|item| matches!(item, RawItem::Record(record) if record.content == RawContent::Live))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn supervise_process_two_real_children_go_live_and_end_with_the_daemon() {
    let (setup, kiwoom) = (set_up(), Kiwoom::start().await);
    let (mut daemon, children) = daemon_with_two_children_online(&setup, &kiwoom).await;

    unsafe_free_sigterm(&daemon);
    let status = timeout(WAIT, daemon.wait()).await.expect("데몬이 끝나지 않았다").unwrap();
    assert_eq!(status.code(), Some(0), "{}", std::fs::read_to_string(setup.folder.path().join("daemon.log")).unwrap());
    until_all_gone(&children).await;
    assert!(stored_live_markers(&setup.data) >= 1, "수집 키의 원문에 live 표시가 있다");
    let log = std::fs::read_to_string(setup.folder.path().join("daemon.log")).unwrap();
    for name in ["collect-01", "spare-01"] {
        assert!(!log.contains(&seeded_token(name)), "로그에 토큰이 있다");
    }
    let journal = std::fs::read_to_string(collector::supervise::journal_path(&setup.data, DATE)).unwrap();
    assert!(!journal.contains("FAKE-SEEDED-TOKEN"));
    assert_eq!(journal.lines().filter(|line| line.contains("\"child_started\"")).count(), 2);
    assert_eq!(journal.lines().filter(|line| line.contains("\"child_exited\"")).count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn supervise_process_children_end_when_the_daemon_is_killed() {
    let (setup, kiwoom) = (set_up(), Kiwoom::start().await);
    let (mut daemon, children) = daemon_with_two_children_online(&setup, &kiwoom).await;

    daemon.start_kill().unwrap();
    daemon.wait().await.unwrap();
    until_all_gone(&children).await;
}

fn unsafe_free_sigterm(daemon: &Child) {
    let pid = rustix::process::Pid::from_raw(daemon.id().unwrap() as i32).unwrap();
    rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
}
