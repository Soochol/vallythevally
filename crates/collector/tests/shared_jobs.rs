use std::collections::BTreeSet;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::collect::link::{Events, Incoming};
use collector::keys::{ActiveKey, KeyIdentity, KeyList, KeyRole, KeysError};
use collector::protocol::{Command, Event, KeyName};
use collector::shared::child::{SharedParts, run_shared};
use collector::shared::{
    AssignedJob, Assignment, AssignmentError, AssignmentStore, JobCall, JobFuture, JobLoop, JobName, JobWindow, LimitEvidence, LoopStats, Market, Reload, SharedJob, Slice, UsageLog, UsageMinute,
    judge_limit, usage_path,
};
use collector::supervise::{
    AlertKind, ChildMessage, ChildProcess, Daemon, DaemonInjected, DaemonInputs, DayPhase, FinalizeRunner, Launcher, ScheduleSettings, SharedInjected, SharedInputs, SharedJobs, SharedLaunch,
    SharedSupervisor, Settings, Spawned, journal_path,
};
use collector::calendar::{HolidayRequest, HolidayTransport, TransportError as HolidayError};
use domain::{KstDate, KstTime, TimeOfDay};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::token_file::credential_id;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::Broker;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep};

const DATE: u32 = 20261118;

type Variables = std::collections::BTreeMap<String, String>;

fn today() -> KstDate {
    KstDate::new(2026, 11, 18).unwrap()
}

fn at(hour: u32, minute: u32, second: u32) -> KstTime {
    kst(today(), hour, minute, second)
}

fn app_key_of(name: &str) -> String {
    format!("FAKE-APPKEY-{name}")
}

fn name_of(text: &str) -> KeyName {
    KeyName::parse(text).unwrap()
}

fn rest_key(folder: &Path, name: &str, broker: Broker) -> ActiveKey {
    ActiveKey {
        broker,
        identity: KeyIdentity { name: name_of(name), role: KeyRole::Rest, app_key_hash: credential_id(&app_key_of(name)) },
        app_key: Secret::new(app_key_of(name)),
        app_secret: Secret::new(format!("FAKE-SECRET-{name}")),
        token_path: folder.join("keys").join(name).join("token.json"),
        lock_path: folder.join("keys").join(name).join("collector.lock"),
    }
}

fn plain_key(folder: &Path, name: &str, role: KeyRole) -> ActiveKey {
    ActiveKey { identity: KeyIdentity { role, ..rest_key(folder, name, Broker::Kiwoom).identity }, ..rest_key(folder, name, Broker::Kiwoom) }
}

struct KeyFiles {
    folder: tempfile::TempDir,
}

impl KeyFiles {
    fn new() -> KeyFiles {
        KeyFiles { folder: tempfile::tempdir().unwrap() }
    }

    fn secret(&self, name: &str, app_key: &str, mode: u32) -> PathBuf {
        let path = self.folder.path().join(format!("{name}.env"));
        std::fs::write(&path, format!("VALLY_COLLECTOR_APP_KEY={app_key}\nVALLY_COLLECTOR_APP_SECRET=FAKE-SECRET-VALUE-7777\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn v1(&self, name: &str, app_key: &str, spare: bool) -> Value {
        json!({"name": name, "active": true, "spare": spare, "app_key_hash": credential_id(app_key), "secret_file": self.secret(name, app_key, 0o600)})
    }

    fn v2(&self, name: &str, app_key: &str, role: &str, broker: &str) -> Value {
        json!({"name": name, "active": true, "role": role, "broker": broker, "app_key_hash": credential_id(app_key), "secret_file": self.secret(name, app_key, 0o600)})
    }

    fn load(&self, version: u32, entries: Vec<Value>, process: &Variables) -> Result<KeyList, KeysError> {
        let path = self.folder.path().join("keys.json");
        std::fs::write(&path, json!({"version": version, "keys": entries}).to_string()).unwrap();
        KeyList::load(&path, Path::new("/state/collector"), process)
    }
}

#[test]
fn key_lists_of_both_versions_load_with_roles_and_brokers() {
    let files = KeyFiles::new();
    let old = files.load(1, vec![files.v1("collect-01", "FAKE-APPKEY-A", false), files.v1("spare-01", "FAKE-APPKEY-B", true)], &Variables::new()).unwrap();
    let roles: Vec<(KeyRole, Broker)> = old.active.iter().map(|key| (key.identity.role, key.broker)).collect();
    assert_eq!(roles, [(KeyRole::Collecting, Broker::Kiwoom), (KeyRole::Spare, Broker::Kiwoom)], "버전 1은 spare:true가 예비, 나머지가 수집, 증권사는 키움이다");

    let new = files
        .load(
            2,
            vec![
                files.v2("collect-01", "FAKE-APPKEY-A", "collect", "kiwoom"),
                files.v2("spare-01", "FAKE-APPKEY-B", "spare", "kiwoom"),
                files.v2("rest-01", "FAKE-APPKEY-C", "rest", "kiwoom"),
                files.v2("rest-kis", "FAKE-APPKEY-D", "rest", "kis"),
            ],
            &Variables::new(),
        )
        .unwrap();
    let roles: Vec<(&str, KeyRole, Broker)> = new.active.iter().map(|key| (key.identity.name.as_str(), key.identity.role, key.broker)).collect();
    assert_eq!(
        roles,
        [("collect-01", KeyRole::Collecting, Broker::Kiwoom), ("rest-01", KeyRole::Rest, Broker::Kiwoom), ("rest-kis", KeyRole::Rest, Broker::Kis), ("spare-01", KeyRole::Spare, Broker::Kiwoom)]
    );
    let (collecting, rest) = new.split_rest();
    assert_eq!((collecting.len(), rest.len()), (2, 2));
}

#[test]
fn role_and_broker_columns_must_match_the_format_version() {
    let files = KeyFiles::new();
    let spare = files.v1("spare-01", "FAKE-APPKEY-B", true);
    let mut with_role = files.v1("collect-01", "FAKE-APPKEY-A", false);
    with_role["role"] = json!("collect");
    assert!(matches!(files.load(1, vec![with_role, spare.clone()], &Variables::new()), Err(KeysError::EntryFields { .. })), "버전 1은 role을 받지 않는다");
    let mut without = files.v2("collect-01", "FAKE-APPKEY-A", "collect", "kiwoom");
    without.as_object_mut().unwrap().remove("broker");
    let v2_spare = files.v2("spare-01", "FAKE-APPKEY-B", "spare", "kiwoom");
    assert!(matches!(files.load(2, vec![without, v2_spare.clone()], &Variables::new()), Err(KeysError::EntryFields { .. })), "버전 2는 broker가 있어야 한다");
    let mut old_column = files.v2("collect-01", "FAKE-APPKEY-A", "collect", "kiwoom");
    old_column["spare"] = json!(false);
    assert!(matches!(files.load(2, vec![old_column, v2_spare.clone()], &Variables::new()), Err(KeysError::EntryFields { .. })), "버전 2는 spare를 받지 않는다");
    assert!(matches!(files.load(3, vec![v2_spare], &Variables::new()), Err(KeysError::UnsupportedVersion(3))));
    let kis_collecting = files.v2("kis-01", "FAKE-APPKEY-K", "collect", "kis");
    let spare_entry = files.v2("spare-01", "FAKE-APPKEY-B", "spare", "kiwoom");
    assert!(matches!(files.load(2, vec![kis_collecting, spare_entry.clone()], &Variables::new()), Err(KeysError::KisNeedsRestRole(_))), "한투 키는 rest만 된다");
    let kis_spare = files.v2("kis-01", "FAKE-APPKEY-K", "spare", "kis");
    assert!(matches!(files.load(2, vec![kis_spare, spare_entry], &Variables::new()), Err(KeysError::KisNeedsRestRole(_))));
}

#[test]
fn a_kis_key_equal_to_the_servers_kis_key_is_refused_but_a_kiwoom_key_is_not_tested_against_it() {
    let files = KeyFiles::new();
    let spare = files.v2("spare-01", "FAKE-APPKEY-B", "spare", "kiwoom");
    let process = Variables::from([("VALLY_KIS_APP_KEY".to_owned(), "FAKE-APPKEY-SAME".to_owned())]);
    let error = files.load(2, vec![files.v2("rest-kis", "FAKE-APPKEY-SAME", "rest", "kis"), spare.clone()], &process).unwrap_err();
    let KeysError::AppServerKey { key, detail } = &error else { panic!("{error:?}") };
    assert_eq!(key.as_str(), "rest-kis");
    assert!(detail.contains("VALLY_KIS_APP_KEY") && detail.contains("ADR 0039") && !detail.contains("FAKE-APPKEY-SAME"), "{detail}");

    let env_file = files.folder.path().join("server.env");
    std::fs::write(&env_file, "VALLY_KIS_APP_KEY=FAKE-APPKEY-SAME\n").unwrap();
    let from_file = Variables::from([("VALLY_ENV_FILE".to_owned(), env_file.display().to_string())]);
    assert!(matches!(files.load(2, vec![files.v2("rest-kis", "FAKE-APPKEY-SAME", "rest", "kis"), spare.clone()], &from_file), Err(KeysError::AppServerKey { .. })), "서버 env 파일의 한투 키와도 대조한다");

    let other = Variables::from([("VALLY_KIS_APP_KEY".to_owned(), "FAKE-APPKEY-OTHER".to_owned())]);
    assert!(files.load(2, vec![files.v2("rest-kis", "FAKE-APPKEY-SAME", "rest", "kis"), spare.clone()], &other).is_ok());
    let kiwoom_only = Variables::from([("VALLY_KIWOOM_APP_KEY".to_owned(), "FAKE-APPKEY-SAME".to_owned())]);
    assert!(matches!(files.load(2, vec![files.v2("rest-01", "FAKE-APPKEY-SAME", "rest", "kiwoom"), spare], &kiwoom_only), Err(KeysError::AppServerKey { .. })), "키움 키는 서버 키움 키와 대조한다");
}

#[test]
fn a_kis_secret_file_follows_the_kiwoom_secret_rules() {
    let files = KeyFiles::new();
    let spare = files.v2("spare-01", "FAKE-APPKEY-B", "spare", "kiwoom");
    let mut wide = files.v2("rest-kis", "FAKE-APPKEY-K", "rest", "kis");
    wide["secret_file"] = json!(files.secret("rest-kis", "FAKE-APPKEY-K", 0o644));
    assert!(matches!(files.load(2, vec![wide, spare.clone()], &Variables::new()), Err(KeysError::SecretFile { .. })), "비밀값 파일은 600이어야 한다");
    let mut wrong_hash = files.v2("rest-kis", "FAKE-APPKEY-K", "rest", "kis");
    wrong_hash["app_key_hash"] = json!(credential_id("FAKE-APPKEY-OTHER"));
    assert!(matches!(files.load(2, vec![wrong_hash, spare], &Variables::new()), Err(KeysError::HashMismatch(_))));
}

fn assignment_text(extra_job: Value) -> String {
    let mut jobs = json!({"probe": {"keys": ["rest-01", "rest-02"], "period_secs": 30, "options": {"calls_per_tr": 4}}});
    if !extra_job.is_null() {
        jobs = extra_job;
    }
    json!({"version": 1, "keys": {"rest-01": {"total_per_second": 5}}, "jobs": jobs}).to_string()
}

fn parse(text: &str, keys: &[ActiveKey]) -> Result<Assignment, AssignmentError> {
    Assignment::parse(text, Path::new("/etc/collector-shared.json"), keys)
}

fn rest_keys(folder: &Path) -> Vec<ActiveKey> {
    vec![rest_key(folder, "rest-01", Broker::Kiwoom), rest_key(folder, "rest-02", Broker::Kiwoom), rest_key(folder, "rest-kis", Broker::Kis), plain_key(folder, "collect-01", KeyRole::Collecting)]
}

#[test]
fn the_assignment_file_is_checked_for_unknown_fields_keys_and_roles() {
    let folder = tempfile::tempdir().unwrap();
    let keys = rest_keys(folder.path());
    let valid = parse(&assignment_text(Value::Null), &keys).unwrap();
    assert_eq!(valid.total_per_second(&name_of("rest-01")), Some(5));
    assert_eq!(valid.total_per_second(&name_of("rest-02")), None);

    let mut unknown_field: Value = serde_json::from_str(&assignment_text(Value::Null)).unwrap();
    unknown_field["jobs"]["probe"]["nope"] = json!(1);
    assert!(matches!(parse(&unknown_field.to_string(), &keys), Err(AssignmentError::Malformed { .. })), "모르는 칸");
    let mut unknown_top: Value = serde_json::from_str(&assignment_text(Value::Null)).unwrap();
    unknown_top["extra"] = json!(true);
    assert!(matches!(parse(&unknown_top.to_string(), &keys), Err(AssignmentError::Malformed { .. })));
    let mut unknown_key_option: Value = serde_json::from_str(&assignment_text(Value::Null)).unwrap();
    unknown_key_option["keys"]["rest-01"]["nope"] = json!(1);
    assert!(matches!(parse(&unknown_key_option.to_string(), &keys), Err(AssignmentError::Malformed { .. })));
    assert!(matches!(parse(&assignment_text(json!({"mystery": {"keys": ["rest-01"], "period_secs": 5}})), &keys), Err(AssignmentError::Malformed { .. })), "모르는 일 이름");

    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": ["collect-01"], "period_secs": 5}})), &keys), Err(AssignmentError::NotRestKey { .. })), "rest가 아닌 키");
    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": ["ghost"], "period_secs": 5}})), &keys), Err(AssignmentError::UnknownKey { .. })), "없는 키");
    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": ["rest-kis"], "period_secs": 5}})), &keys), Err(AssignmentError::WrongBroker { .. })), "일이 받지 않는 증권사");
    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": ["rest-01", "rest-01"], "period_secs": 5}})), &keys), Err(AssignmentError::DuplicateKey { .. })));
    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": [], "period_secs": 5}})), &keys), Err(AssignmentError::NoKeys(_))));
    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": ["rest-01"], "period_secs": 0}})), &keys), Err(AssignmentError::BadPeriod(_))));
    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": ["rest-01"], "period_secs": 5, "options": {"calls_per_tr": 0}}})), &keys), Err(AssignmentError::BadOptions { .. })));
    assert!(matches!(parse(&assignment_text(json!({"probe": {"keys": ["rest-01"], "period_secs": 5, "options": {"nope": 1}}})), &keys), Err(AssignmentError::BadOptions { .. })));
    let mut key_not_rest: Value = serde_json::from_str(&assignment_text(Value::Null)).unwrap();
    key_not_rest["keys"] = json!({"collect-01": {"total_per_second": 5}});
    assert!(matches!(parse(&key_not_rest.to_string(), &keys), Err(AssignmentError::NotRestKey { .. })), "total_per_second는 rest 키에만");
    let mut zero_total: Value = serde_json::from_str(&assignment_text(Value::Null)).unwrap();
    zero_total["keys"]["rest-01"]["total_per_second"] = json!(0);
    assert!(matches!(parse(&zero_total.to_string(), &keys), Err(AssignmentError::BadTotalPerSecond(_))));
    assert!(matches!(parse(&json!({"version": 2, "jobs": {}}).to_string(), &keys), Err(AssignmentError::UnsupportedVersion(2))));
    assert!(matches!(parse("not json", &keys), Err(AssignmentError::Malformed { .. })));
}

#[test]
fn the_order_of_keys_slices_a_job_and_a_stopped_key_hands_its_slice_to_the_rest() {
    let folder = tempfile::tempdir().unwrap();
    let keys = rest_keys(folder.path());
    let text = json!({"version": 1, "jobs": {"probe": {"keys": ["rest-01", "rest-02"], "period_secs": 30}}}).to_string();
    let assignment = parse(&text, &keys).unwrap();
    let slices = |down: &BTreeSet<KeyName>| -> Vec<(String, u32, u32)> {
        assignment.jobs_of(down).into_iter().flat_map(|(key, jobs)| jobs.into_iter().map(move |job| (key.as_str().to_owned(), job.slice_index, job.slice_count))).collect()
    };
    assert_eq!(slices(&BTreeSet::new()), [("rest-01".to_owned(), 0, 2), ("rest-02".to_owned(), 1, 2)]);
    let down = BTreeSet::from([name_of("rest-01")]);
    assert_eq!(slices(&down), [("rest-02".to_owned(), 0, 1)]);
    assert_eq!(assignment.next_key_of(JobName::Probe, &name_of("rest-01"), &down), Some(name_of("rest-02")));
    let all_down = BTreeSet::from([name_of("rest-01"), name_of("rest-02")]);
    assert_eq!(assignment.next_key_of(JobName::Probe, &name_of("rest-02"), &all_down), None);
    assert_eq!(assignment.unserved(&all_down), [JobName::Probe]);
    assert!(slices(&all_down).is_empty());
}

#[test]
fn reloading_follows_the_file_and_falls_back_to_the_previous_assignment_with_the_error() {
    let folder = tempfile::tempdir().unwrap();
    let keys = rest_keys(folder.path());
    let path = folder.path().join("collector-shared.json");
    let data = folder.path().join("data");
    let mut store = AssignmentStore::new(path.clone(), &data);
    assert_eq!(store.reload(&keys), Reload::NoFile, "파일이 없으면 공용 자료 일을 돌리지 않는다");
    assert!(store.current().is_none());

    std::fs::write(&path, assignment_text(Value::Null)).unwrap();
    assert_eq!(store.reload(&keys), Reload::Loaded);
    assert_eq!(store.current().unwrap().jobs_of(&BTreeSet::new()).len(), 2);

    std::fs::write(&path, assignment_text(json!({"probe": {"keys": ["rest-02"], "period_secs": 45}}))).unwrap();
    assert_eq!(store.reload(&keys), Reload::Loaded, "다시 읽으면 바뀐 파일을 쓴다");
    let jobs = store.current().unwrap().jobs_of(&BTreeSet::new());
    assert_eq!(jobs.keys().map(KeyName::as_str).collect::<Vec<_>>(), ["rest-02"]);
    assert_eq!(jobs[&name_of("rest-02")][0].period_secs, 45);

    std::fs::write(&path, "{ 깨진 파일").unwrap();
    let Reload::KeptPrevious(AssignmentError::Malformed { .. }) = store.reload(&keys) else { panic!("읽지 못하면 전날 배정을 쓴다") };
    assert_eq!(store.current().unwrap().jobs_of(&BTreeSet::new())[&name_of("rest-02")][0].period_secs, 45);

    std::fs::write(&path, assignment_text(json!({"probe": {"keys": ["collect-01"], "period_secs": 5}}))).unwrap();
    assert!(matches!(store.reload(&keys), Reload::KeptPrevious(AssignmentError::NotRestKey { .. })), "검사에 걸린 파일도 읽지 못한 것과 같다");

    let mut restarted = AssignmentStore::new(path.clone(), &data);
    let Reload::KeptPrevious(_) = restarted.reload(&keys) else { panic!("데몬이 다시 떠도 직전에 쓴 배정을 쓴다") };
    assert_eq!(restarted.current().unwrap().jobs_of(&BTreeSet::new())[&name_of("rest-02")][0].period_secs, 45);

    std::fs::remove_file(&path).unwrap();
    assert_eq!(store.reload(&keys), Reload::NoFile, "파일을 지우면 일을 멈춘다");
    assert!(store.current().is_none());

    let empty = tempfile::tempdir().unwrap();
    let mut fresh = AssignmentStore::new(path.clone(), empty.path());
    std::fs::write(&path, "{ 깨진 파일").unwrap();
    assert!(matches!(fresh.reload(&keys), Reload::Unusable(_)), "전날 배정도 없으면 일을 돌리지 않는다");
}

struct SlowJob {
    running: AtomicUsize,
    peak: AtomicUsize,
    started_at: Mutex<Vec<Duration>>,
    origin: Instant,
    takes: Duration,
}

impl SharedJob for SlowJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: TimeOfDay::MIDNIGHT, end: TimeOfDay::hms(23, 59, 59).unwrap() }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom]
    }

    fn check_options(&self, _: &Value) -> Result<(), String> {
        Ok(())
    }

    fn run<'a>(&'a self, _: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            self.started_at.lock().unwrap().push(self.origin.elapsed());
            sleep(self.takes).await;
            self.running.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

#[tokio::test(start_paused = true)]
async fn a_run_longer_than_the_period_never_overlaps_and_the_overruns_are_counted() {
    let job = Arc::new(SlowJob { running: AtomicUsize::new(0), peak: AtomicUsize::new(0), started_at: Mutex::default(), origin: Instant::now(), takes: Duration::from_secs(25) });
    let job_loop = JobLoop { job: job.clone(), observation_date: today(), period: Duration::from_secs(10), slice: Slice::WHOLE, peers: Vec::new(), options: Value::Null };
    let clock = Clock::fake(at(9, 0, 0));
    let stats = Arc::new(LoopStats::default());
    let key = name_of("rest-01");
    let loop_stats = stats.clone();
    let task = tokio::spawn(async move {
        job_loop.run(Market::Kis(None), &key, Path::new("/unused"), &clock, &loop_stats).await;
    });
    sleep(Duration::from_secs(80)).await;
    task.abort();
    assert_eq!(job.peak.load(Ordering::SeqCst), 1, "같은 일이 겹쳐 뜨지 않는다");
    let starts = job.started_at.lock().unwrap().clone();
    assert_eq!(starts.iter().map(Duration::as_secs).collect::<Vec<_>>(), [0, 25, 50, 75], "끝나자마자 다음을 시작한다");
    assert_eq!(stats.overruns(), 3, "넘친 횟수");
    assert_eq!(stats.runs(), 3, "끝난 횟수");

    let steady = Arc::new(SlowJob { running: AtomicUsize::new(0), peak: AtomicUsize::new(0), started_at: Mutex::default(), origin: Instant::now(), takes: Duration::from_secs(3) });
    let steady_loop = JobLoop { job: steady.clone(), observation_date: today(), period: Duration::from_secs(10), slice: Slice::WHOLE, peers: Vec::new(), options: Value::Null };
    let clock = Clock::fake(at(9, 0, 0));
    let steady_stats = Arc::new(LoopStats::default());
    let (key, loop_stats) = (name_of("rest-01"), steady_stats.clone());
    let task = tokio::spawn(async move {
        steady_loop.run(Market::Kis(None), &key, Path::new("/unused"), &clock, &loop_stats).await;
    });
    sleep(Duration::from_secs(35)).await;
    task.abort();
    assert_eq!(steady.started_at.lock().unwrap().iter().map(Duration::as_secs).collect::<Vec<_>>(), [0, 10, 20, 30], "주기 안에 끝나면 주기 격자에 맞춘다");
    assert_eq!(steady_stats.overruns(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_job_runs_only_inside_its_window_of_the_observation_day() {
    struct Windowed(Arc<AtomicUsize>);
    impl SharedJob for Windowed {
        fn window(&self) -> JobWindow {
            JobWindow { start: TimeOfDay::hms(8, 0, 0).unwrap(), end: TimeOfDay::hms(8, 1, 0).unwrap() }
        }
        fn brokers(&self) -> &'static [Broker] {
            &[Broker::Kiwoom]
        }
        fn check_options(&self, _: &Value) -> Result<(), String> {
            Ok(())
        }
        fn run<'a>(&'a self, _: JobCall<'a>) -> JobFuture<'a> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    let runs = Arc::new(AtomicUsize::new(0));
    let job_loop = JobLoop { job: Arc::new(Windowed(runs.clone())), observation_date: today(), period: Duration::from_secs(20), slice: Slice::WHOLE, peers: Vec::new(), options: Value::Null };
    let clock = Clock::fake(at(7, 59, 0));
    let stats = LoopStats::default();
    let finished = tokio::spawn({
        let clock = clock.clone();
        async move { job_loop.run(Market::Kis(None), &name_of("rest-01"), Path::new("/unused"), &clock, &stats).await }
    });
    sleep(Duration::from_secs(30)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 0, "시간대 앞에서는 돌지 않는다");
    sleep(Duration::from_secs(120)).await;
    finished.await.unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 3, "08:00:00, :20, :40에 돌고 닫히는 08:01:00에는 돌지 않는다");
}

#[derive(Clone, Copy)]
enum Limit {
    None,
    KeyTotalOver(usize),
    PerTrOver(usize),
}

struct Call {
    at: Duration,
    api: String,
    token: String,
}

struct FakeKiwoom {
    origin: Instant,
    limit: Limit,
    calls: Mutex<Vec<Call>>,
    accepted: Mutex<Vec<(Duration, String)>>,
    issued: Mutex<Vec<String>>,
    halt_market_keys: Mutex<BTreeSet<String>>,
    counter: AtomicUsize,
}

impl FakeKiwoom {
    fn new(limit: Limit) -> Arc<FakeKiwoom> {
        Arc::new(FakeKiwoom {
            origin: Instant::now(),
            limit,
            calls: Mutex::default(),
            accepted: Mutex::default(),
            issued: Mutex::default(),
            halt_market_keys: Mutex::default(),
            counter: AtomicUsize::new(0),
        })
    }

    fn halt_market_for(&self, key: &str) {
        self.halt_market_keys.lock().unwrap().insert(format!("for-{}", app_key_of(key)));
    }

    fn market_calls(&self) -> Vec<(Duration, String, String)> {
        self.calls.lock().unwrap().iter().map(|call| (call.at, call.api.clone(), call.token.clone())).collect()
    }

    fn issues(&self) -> Vec<String> {
        self.issued.lock().unwrap().clone()
    }

    fn calls_with_token_of(&self, key: &str) -> Vec<(Duration, String)> {
        let marker = format!("for-{}", app_key_of(key));
        self.market_calls().into_iter().filter(|(_, _, token)| token.ends_with(&marker)).map(|(at, api, _)| (at, api)).collect()
    }
}

fn reply(body: Value) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status: 200, next_key: None, body: body.to_string() })
}

impl Transport for FakeKiwoom {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let api = request.api_id.as_str().to_owned();
        let answer = match api.as_str() {
            "au10001" => {
                let body: Value = serde_json::from_str(request.body.expose()).unwrap();
                let app_key = body["appkey"].as_str().unwrap().to_owned();
                self.issued.lock().unwrap().push(app_key.clone());
                let number = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
                reply(json!({"token": format!("FAKE-TOKEN-{number}-for-{app_key}"), "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}))
            }
            "ka10099" => reply(json!({"list": [], "return_code": 0, "return_msg": "정상"})),
            _ => {
                let now = self.origin.elapsed();
                let token = request.token.as_ref().map(|token| token.expose().clone()).unwrap_or_default();
                self.calls.lock().unwrap().push(Call { at: now, api: api.clone(), token: token.clone() });
                if self.halt_market_keys.lock().unwrap().iter().any(|marker| token.ends_with(marker)) {
                    reply(json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8050:지정단말기 인증에 실패하였습니다]"}))
                } else {
                    let mut accepted = self.accepted.lock().unwrap();
                    accepted.retain(|(at, _)| now.saturating_sub(*at) < Duration::from_secs(1));
                    let in_window = match self.limit {
                        Limit::None => 0,
                        Limit::KeyTotalOver(_) => accepted.len(),
                        Limit::PerTrOver(_) => accepted.iter().filter(|(_, accepted_api)| *accepted_api == api).count(),
                    };
                    let cap = match self.limit {
                        Limit::None => usize::MAX,
                        Limit::KeyTotalOver(cap) | Limit::PerTrOver(cap) => cap,
                    };
                    if in_window >= cap {
                        Ok(HttpResponse { status: 429, next_key: None, body: json!({"return_code": 5, "return_msg": "허용된 요청 개수를 초과하였습니다[1700:유량=5]"}).to_string() })
                    } else {
                        accepted.push((now, api.clone()));
                        match api.as_str() {
                            "ka10008" => reply(json!({"stk_frgnr": [], "return_code": 0, "return_msg": "정상"})),
                            _ => reply(json!({"stk_cd": "", "stk_nm": "", "mac": "", "flo_stk": "", "per": "", "pbr": "", "roe": "", "eps": "", "bps": "", "for_exh_rt": "", "250hgst": "", "250lwst": "", "upl_pric": "", "lst_pric": "", "return_code": 0, "return_msg": "정상"})),
                        }
                    }
                }
            }
        };
        Box::pin(async move { answer })
    }
}

#[derive(Default)]
struct Received {
    commands: Mutex<Vec<Command>>,
}

impl Received {
    fn assigned(&self) -> Vec<(u32, Vec<AssignedJob>)> {
        self.commands.lock().unwrap().iter().filter_map(|command| if let Command::Assign { date, jobs } = command { Some((*date, jobs.clone())) } else { None }).collect()
    }

    fn tokens(&self) -> Vec<(String, u64)> {
        self.commands.lock().unwrap().iter().filter_map(|command| if let Command::Token { token, generation, .. } = command { Some((token.expose().clone(), *generation)) } else { None }).collect()
    }

    fn first_two_kinds(&self) -> Vec<&'static str> {
        self.commands
            .lock()
            .unwrap()
            .iter()
            .filter_map(|command| match command {
                Command::Token { .. } => Some("token"),
                Command::Assign { .. } => Some("assign"),
                _ => None,
            })
            .take(2)
            .collect()
    }
}

struct FakeHandle {
    received: Arc<Received>,
    commands: mpsc::UnboundedSender<Incoming>,
    stop: watch::Sender<bool>,
    messages: mpsc::UnboundedSender<ChildMessage>,
    alive: Arc<AtomicBool>,
}

impl FakeHandle {
    fn end(&self, code: i32) {
        let _ = self.stop.send(true);
        if self.alive.swap(false, Ordering::SeqCst) {
            let _ = self.messages.send(ChildMessage::Exited(Some(code)));
        }
    }
}

impl ChildProcess for FakeHandle {
    fn send(&mut self, command: &Command) {
        self.received.commands.lock().unwrap().push(command.clone());
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

struct FakeLauncher {
    kiwoom: Arc<FakeKiwoom>,
    clock: Clock,
    shared_dir: PathBuf,
    failing: Mutex<BTreeSet<String>>,
    shared: Mutex<Vec<(String, SharedLaunch, Arc<Received>)>>,
    collect: Mutex<Vec<String>>,
}

impl FakeLauncher {
    fn new(kiwoom: Arc<FakeKiwoom>, clock: Clock, shared_dir: PathBuf) -> Arc<FakeLauncher> {
        Arc::new(FakeLauncher { kiwoom, clock, shared_dir, failing: Mutex::default(), shared: Mutex::default(), collect: Mutex::default() })
    }

    fn fail(&self, key: &str) {
        self.failing.lock().unwrap().insert(key.to_owned());
    }

    fn shared_keys(&self) -> Vec<String> {
        self.shared.lock().unwrap().iter().map(|(key, ..)| key.clone()).collect()
    }

    fn received_by(&self, key: &str) -> Vec<Arc<Received>> {
        self.shared.lock().unwrap().iter().filter(|(name, ..)| name == key).map(|(.., received)| received.clone()).collect()
    }

    fn launch_of(&self, key: &str) -> SharedLaunch {
        self.shared.lock().unwrap().iter().find(|(name, ..)| name == key).map(|(_, launch, _)| *launch).unwrap_or_else(|| panic!("{key} 공용 자료 자식이 뜨지 않았다"))
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, key: &KeyName) -> io::Result<Spawned> {
        self.collect.lock().unwrap().push(key.as_str().to_owned());
        let (messages_tx, messages) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let (stop, _) = watch::channel(false);
        let (commands, _) = mpsc::unbounded_channel();
        let handle = FakeHandle { received: Arc::default(), commands, stop, messages: messages_tx.clone(), alive: alive.clone() };
        let _ = messages_tx.send(ChildMessage::Event(Event::Hello { key: key.clone(), pid: 4000 }));
        tokio::spawn(async move {
            while alive.load(Ordering::SeqCst) {
                sleep(Duration::from_secs(5)).await;
                let _ = messages_tx.send(ChildMessage::Event(Event::Heartbeat { frames: 10, bytes: 100, state: collector::protocol::SessionState::Live }));
            }
        });
        Ok(Spawned { pid: Some(4000), process: Box::new(handle), messages })
    }

    fn launch_shared(&self, key: &KeyName, launch: &SharedLaunch) -> io::Result<Spawned> {
        let received = Arc::new(Received::default());
        self.shared.lock().unwrap().push((key.as_str().to_owned(), *launch, received.clone()));
        let (messages_tx, messages) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let (stop, shutdown) = watch::channel(false);
        let (command_tx, commands) = mpsc::unbounded_channel();
        let handle = FakeHandle { received, commands: command_tx, stop, messages: messages_tx.clone(), alive: alive.clone() };
        if self.failing.lock().unwrap().contains(key.as_str()) {
            let _ = messages_tx.send(ChildMessage::Event(Event::Hello { key: key.clone(), pid: 5000 }));
            let _ = messages_tx.send(ChildMessage::Exited(Some(1)));
            alive.store(false, Ordering::SeqCst);
            return Ok(Spawned { pid: Some(5000), process: Box::new(handle), messages });
        }
        let (event_sink, event_source) = std::sync::mpsc::channel();
        let forward = messages_tx.clone();
        let forwarder = tokio::spawn(async move {
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
            transport: self.kiwoom.clone(),
            kis_transport: None,
            clock: self.clock.clone(),
            total_per_second: launch.total_per_second,
            commands,
            events: Events::to(event_sink),
            shutdown,
        };
        tokio::spawn(async move {
            run_shared(parts).await;
            let _ = forwarder.await;
            if alive.swap(false, Ordering::SeqCst) {
                let _ = messages_tx.send(ChildMessage::Exited(Some(0)));
            }
        });
        Ok(Spawned { pid: Some(5001), process: Box::new(handle), messages })
    }
}

struct Shared {
    folder: tempfile::TempDir,
    kiwoom: Arc<FakeKiwoom>,
    launcher: Arc<FakeLauncher>,
    report: watch::Receiver<collector::supervise::SharedReport>,
    stop: watch::Sender<bool>,
    done: tokio::task::JoinHandle<()>,
}

impl Shared {
    fn start(assignment: Value, limit: Limit, prepare: impl FnOnce(&FakeLauncher)) -> Shared {
        let folder = tempfile::tempdir().unwrap();
        let keys: Vec<ActiveKey> = ["rest-01", "rest-02"].iter().map(|name| rest_key(folder.path(), name, Broker::Kiwoom)).collect();
        let assignment = Assignment::parse(&assignment.to_string(), Path::new("/etc/collector-shared.json"), &keys).unwrap();
        let clock = Clock::fake(at(9, 0, 0));
        let kiwoom = FakeKiwoom::new(limit);
        let launcher = FakeLauncher::new(kiwoom.clone(), clock.clone(), folder.path().join("data").join("shared"));
        prepare(&launcher);
        let supervisor = SharedSupervisor::start(
            SharedInputs { keys, assignment, date: DATE, data_dir: folder.path().join("data"), settings: Settings::default() },
            SharedInjected { launcher: launcher.clone(), transport: kiwoom.clone(), kis_transport: None, clock: clock.clone() },
        )
        .unwrap_or_else(|error| panic!("시작하지 못했다: {error}"));
        let report = supervisor.report();
        let (stop, shutdown) = watch::channel(false);
        let done = tokio::spawn(supervisor.run(shutdown));
        Shared { folder, kiwoom, launcher, report, stop, done }
    }

    fn data(&self) -> PathBuf {
        self.folder.path().join("data")
    }

    fn journal(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(journal_path(&self.data(), DATE)).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn journal_of(&self, event: &str) -> Vec<Value> {
        self.journal().into_iter().filter(|record| record["event"] == event).collect()
    }

    async fn finish(self) {
        self.stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(120), self.done).await.expect("공용 자료 감독이 끝나지 않았다").unwrap();
    }
}

fn probe_assignment(keys: &[&str], calls_per_tr: u32, total: Option<(&str, u32)>) -> Value {
    let key_options = total.map_or(json!({}), |(key, total)| json!({ key: {"total_per_second": total} }));
    json!({"version": 1, "keys": key_options, "jobs": {"probe": {"keys": keys, "period_secs": 30, "options": {"calls_per_tr": calls_per_tr}}}})
}

#[tokio::test(start_paused = true)]
async fn each_rest_key_gets_a_shared_child_that_receives_its_token_over_stdin_and_then_its_slice() {
    let shared = Shared::start(probe_assignment(&["rest-01", "rest-02"], 4, Some(("rest-01", 5))), Limit::None, |_| {});
    sleep(Duration::from_secs(12)).await;
    assert_eq!(shared.launcher.shared_keys(), ["rest-01", "rest-02"]);
    assert_eq!(shared.launcher.launch_of("rest-01").total_per_second, Some(5), "배정표의 total_per_second가 그 키의 자식에게 간다");
    assert_eq!(shared.launcher.launch_of("rest-02").total_per_second, None);
    assert_eq!(shared.launcher.launch_of("rest-01").broker, Broker::Kiwoom);
    for (index, key) in ["rest-01", "rest-02"].into_iter().enumerate() {
        let received = shared.launcher.received_by(key).remove(0);
        assert_eq!(received.first_two_kinds(), ["token", "assign"], "토큰이 먼저, 그다음 몫");
        let tokens = received.tokens();
        assert_eq!(tokens.len(), 1);
        assert!(tokens[0].0.contains("FAKE-TOKEN") && tokens[0].0.ends_with(&format!("for-{}", app_key_of(key))), "{key}: {tokens:?}");
        let assigned = received.assigned();
        assert_eq!(assigned.len(), 1);
        assert_eq!(assigned[0].0, DATE);
        assert_eq!((assigned[0].1[0].job, assigned[0].1[0].slice_index, assigned[0].1[0].slice_count, assigned[0].1[0].period_secs), (JobName::Probe, index as u32, 2, 30));
    }
    assert_eq!(shared.kiwoom.issues().len(), 2, "토큰은 데몬이 키마다 한 번 발급했다. 자식은 발급하지 않는다");
    let first = shared.kiwoom.calls_with_token_of("rest-01");
    let second = shared.kiwoom.calls_with_token_of("rest-02");
    assert_eq!((first.len(), second.len()), (4, 4), "단위 4개를 두 키가 둘씩 나눠 두 TR로 부른다");
    assert!(shared.kiwoom.market_calls().iter().all(|(_, _, token)| !token.is_empty()), "자식의 호출은 받은 토큰을 싣는다");
    let probe = std::fs::read_to_string(shared.data().join("shared").join("probe").join(format!("{DATE}.json"))).unwrap();
    assert!(probe.contains("\"keyName\"") && probe.contains("\"broker\":\"kiwoom\""), "{probe}");
    shared.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_key_that_passes_its_restart_limit_hands_its_job_to_the_next_key_and_the_event_is_kept() {
    let shared = Shared::start(probe_assignment(&["rest-01", "rest-02"], 4, None), Limit::None, |launcher| launcher.fail("rest-01"));
    sleep(Duration::from_secs(10)).await;
    assert_eq!(shared.kiwoom.calls_with_token_of("rest-02").len(), 4, "먼저는 둘이 나눠 맡았다");
    sleep(Duration::from_secs(150)).await;
    let attempts = shared.launcher.received_by("rest-01").len();
    assert_eq!(attempts, 6, "처음 한 번과 재시작 다섯 번");
    assert_eq!(shared.journal_of("restart").len(), 5);
    let stopped = shared.journal_of("key_stopped");
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0]["key"], "rest-01");
    assert!(stopped[0]["reason"].as_str().unwrap().contains("재시작 한도"));
    let moved = shared.journal_of("shared_job_moved");
    assert_eq!(moved.len(), 1);
    assert_eq!((moved[0]["job"].as_str(), moved[0]["from"].as_str(), moved[0]["to"].as_str()), (Some("probe"), Some("rest-01"), Some("rest-02")));

    let received = shared.launcher.received_by("rest-02").remove(0);
    let assigned = received.assigned();
    assert_eq!(assigned.len(), 2, "처음 몫과 옮겨 받은 몫");
    assert_eq!((assigned[1].1[0].slice_index, assigned[1].1[0].slice_count), (0, 1));
    let report = shared.report.borrow().clone();
    let state_of = |key: &str| report.keys.iter().find(|status| status.name.as_str() == key).unwrap().state;
    assert_eq!(state_of("rest-01"), collector::supervise::KeyState::Stopped);
    assert!(report.alerts.iter().any(|alert| alert.kind == AlertKind::SharedJobMoved && alert.message.contains("rest-02")), "{:?}", report.alerts);
    sleep(Duration::from_secs(60)).await;
    let all_units: usize = shared.kiwoom.calls_with_token_of("rest-02").len();
    assert!(all_units >= 4 + 8, "옮긴 뒤 rest-02가 단위 넷 전부를 두 TR로 부른다: {all_units}");
    shared.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_job_left_with_no_key_is_reported_not_silently_dropped() {
    let shared = Shared::start(probe_assignment(&["rest-01"], 2, None), Limit::None, |launcher| launcher.fail("rest-01"));
    sleep(Duration::from_secs(150)).await;
    let moved = shared.journal_of("shared_job_moved");
    assert_eq!(moved.len(), 1);
    assert_eq!(moved[0]["to"], Value::Null);
    let report = shared.report.borrow().clone();
    assert!(report.alerts.iter().any(|alert| alert.kind == AlertKind::SharedJobMoved && alert.message.contains("이어받을 키가 없")), "{:?}", report.alerts);
    shared.finish().await;
}

#[tokio::test(start_paused = true)]
async fn a_kiwoom_rest_child_that_halts_on_8050_retires_at_once_and_rebalances_slices() {
    let shared = Shared::start(probe_assignment(&["rest-01", "rest-02"], 4, None), Limit::None, |_| {});
    sleep(Duration::from_secs(12)).await;
    let initial = shared.launcher.received_by("rest-02")[0].assigned();
    assert_eq!(initial.len(), 1);
    assert_eq!((initial[0].1[0].slice_index, initial[0].1[0].slice_count), (1, 2));

    shared.kiwoom.halt_market_for("rest-01");
    sleep(Duration::from_secs(35)).await;

    assert_eq!(shared.launcher.received_by("rest-01").len(), 1);
    assert!(shared.journal_of("restart").is_empty());
    let stopped = shared.journal_of("key_stopped");
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0]["key"], "rest-01");
    assert!(stopped[0]["reason"].as_str().unwrap().contains("8050"), "{}", stopped[0]);
    let moved = shared.journal_of("shared_job_moved");
    assert_eq!(moved.len(), 1);
    assert_eq!((moved[0]["job"].as_str(), moved[0]["from"].as_str(), moved[0]["to"].as_str()), (Some("probe"), Some("rest-01"), Some("rest-02")));

    let received = shared.launcher.received_by("rest-02").remove(0);
    let assigned = received.assigned();
    assert_eq!(assigned.len(), 2);
    assert_eq!((assigned[0].1[0].slice_index, assigned[0].1[0].slice_count), (1, 2));
    assert_eq!((assigned[1].1[0].slice_index, assigned[1].1[0].slice_count), (0, 1));
    let report = shared.report.borrow().clone();
    let rest_01 = report.keys.iter().find(|status| status.name.as_str() == "rest-01").unwrap();
    assert_eq!(rest_01.state, collector::supervise::KeyState::Stopped);
    assert_eq!(rest_01.restarts, 0);
    assert!(report.alerts.iter().any(|alert| alert.kind == AlertKind::KeyStopped && alert.message.contains("rest-01")), "{:?}", report.alerts);
    assert!(report.alerts.iter().any(|alert| alert.kind == AlertKind::SharedJobMoved && alert.message.contains("rest-02")), "{:?}", report.alerts);
    let before_rebalanced_calls = shared.kiwoom.calls_with_token_of("rest-02").len();
    sleep(Duration::from_secs(40)).await;
    let after_rebalanced_calls = shared.kiwoom.calls_with_token_of("rest-02").len();
    assert!(after_rebalanced_calls >= before_rebalanced_calls + 8, "{before_rebalanced_calls} -> {after_rebalanced_calls}");
    shared.finish().await;
}

struct FakeKisTransport;

impl server::kis::transport::Transport for FakeKisTransport {
    fn send(&self, request: server::kis::transport::HttpRequest) -> BoxFuture<'static, Result<server::kis::transport::HttpResponse, server::kis::transport::TransportError>> {
        let reply = match request.path {
            "/oauth2/tokenP" => Ok(server::kis::transport::HttpResponse {
                status: 200,
                tr_cont: None,
                body: json!({"access_token": "FAKE-KIS-TOKEN-1", "access_token_token_expired": "2099-12-31 00:00:00"}).to_string(),
            }),
            _ => Ok(server::kis::transport::HttpResponse {
                status: 200,
                tr_cont: None,
                body: json!({"rt_cd": "0", "msg_cd": "MCA00000", "msg1": "정상", "output": []}).to_string(),
            }),
        };
        Box::pin(async move { reply })
    }
}

struct HaltingKisChildLauncher {
    received: Mutex<Vec<(String, Arc<Received>)>>,
    emitters: Mutex<Vec<(String, mpsc::UnboundedSender<ChildMessage>)>>,
}

impl HaltingKisChildLauncher {
    fn new() -> Arc<HaltingKisChildLauncher> {
        Arc::new(HaltingKisChildLauncher { received: Mutex::default(), emitters: Mutex::default() })
    }

    fn received_by(&self, key: &str) -> Vec<Arc<Received>> {
        self.received.lock().unwrap().iter().filter(|(name, _)| name == key).map(|(_, received)| received.clone()).collect()
    }

    fn emit_halted(&self, key: &str, reason: &str, action: &str) {
        let emitters = self.emitters.lock().unwrap();
        let (_, tx) = emitters.iter().find(|(name, _)| name == key).unwrap();
        let _ = tx.send(ChildMessage::Event(Event::Halted { reason: reason.to_owned(), action: action.to_owned() }));
    }
}

impl Launcher for HaltingKisChildLauncher {
    fn launch(&self, _: &KeyName) -> io::Result<Spawned> {
        unreachable!()
    }

    fn launch_shared(&self, key: &KeyName, _: &SharedLaunch) -> io::Result<Spawned> {
        let received = Arc::new(Received::default());
        self.received.lock().unwrap().push((key.as_str().to_owned(), received.clone()));
        let (messages_tx, messages) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let (stop, _) = watch::channel(false);
        let (command_tx, _) = mpsc::unbounded_channel();
        let handle = FakeHandle { received, commands: command_tx, stop, messages: messages_tx.clone(), alive: alive.clone() };
        self.emitters.lock().unwrap().push((key.as_str().to_owned(), messages_tx.clone()));
        let _ = messages_tx.send(ChildMessage::Event(Event::Hello { key: key.clone(), pid: 6000 }));
        tokio::spawn(async move {
            while alive.load(Ordering::SeqCst) {
                sleep(Duration::from_secs(5)).await;
                if alive.load(Ordering::SeqCst) {
                    let _ = messages_tx.send(ChildMessage::Event(Event::Heartbeat { frames: 0, bytes: 0, state: collector::protocol::SessionState::Live }));
                }
            }
        });
        Ok(Spawned { pid: Some(6000), process: Box::new(handle), messages })
    }
}

#[tokio::test(start_paused = true)]
async fn a_kis_rest_child_that_reports_halted_retires_at_once_and_rebalances_to_surviving_key() {
    let folder = tempfile::tempdir().unwrap();
    let keys = vec![rest_key(folder.path(), "rest-kis", Broker::Kis), rest_key(folder.path(), "rest-02", Broker::Kiwoom)];
    let text = json!({"version": 1, "jobs": {"rankings": {"keys": ["rest-kis", "rest-02"], "period_secs": 30}}}).to_string();
    let assignment = Assignment::parse(&text, Path::new("/etc/collector-shared.json"), &keys).unwrap();
    let clock = Clock::fake(at(9, 0, 0));
    let kiwoom = FakeKiwoom::new(Limit::None);
    let launcher = HaltingKisChildLauncher::new();
    let supervisor = SharedSupervisor::start(
        SharedInputs { keys, assignment, date: DATE, data_dir: folder.path().join("data"), settings: Settings::default() },
        SharedInjected { launcher: launcher.clone(), transport: kiwoom, kis_transport: Some(Arc::new(FakeKisTransport)), clock },
    )
    .unwrap();
    let report = supervisor.report();
    let (stop, shutdown) = watch::channel(false);
    let done = tokio::spawn(supervisor.run(shutdown));

    sleep(Duration::from_secs(12)).await;
    assert_eq!(launcher.received_by("rest-kis")[0].assigned().len(), 1);
    assert_eq!(launcher.received_by("rest-02")[0].assigned().len(), 1);

    launcher.emit_halted("rest-kis", "한투 응답 거절: 인증이 거절됨(HTTP 403, 코드 EGW00999)", "한투 키와 인증 상태를 확인한 뒤 다시 시작하세요");
    sleep(Duration::from_secs(5)).await;

    assert_eq!(launcher.received_by("rest-kis").len(), 1);
    let journal_text = std::fs::read_to_string(journal_path(&folder.path().join("data"), DATE)).unwrap();
    let journal: Vec<Value> = journal_text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert!(journal.iter().all(|record| record["event"] != "restart"));
    let stopped: Vec<&Value> = journal.iter().filter(|record| record["event"] == "key_stopped").collect();
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0]["key"], "rest-kis");
    assert!(stopped[0]["reason"].as_str().unwrap().contains("EGW00999"));
    let moved: Vec<&Value> = journal.iter().filter(|record| record["event"] == "shared_job_moved").collect();
    assert_eq!(moved.len(), 1);
    assert_eq!((moved[0]["job"].as_str(), moved[0]["from"].as_str(), moved[0]["to"].as_str()), (Some("rankings"), Some("rest-kis"), Some("rest-02")));

    let assigned = launcher.received_by("rest-02")[0].assigned();
    assert_eq!(assigned.len(), 2);
    assert_eq!((assigned[0].1[0].slice_index, assigned[0].1[0].slice_count), (1, 2));
    assert_eq!((assigned[1].1[0].slice_index, assigned[1].1[0].slice_count), (0, 1));
    assert_eq!(assigned[1].1[0].peers, vec![Broker::Kiwoom]);
    let snapshot = report.borrow().clone();
    let rest_kis = snapshot.keys.iter().find(|status| status.name.as_str() == "rest-kis").unwrap();
    assert_eq!(rest_kis.state, collector::supervise::KeyState::Stopped);
    assert_eq!(rest_kis.restarts, 0);
    assert!(snapshot.alerts.iter().any(|alert| alert.kind == AlertKind::KeyStopped && alert.message.contains("rest-kis")));
    assert!(snapshot.alerts.iter().any(|alert| alert.kind == AlertKind::SharedJobMoved && alert.message.contains("rest-02")));

    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(30), done).await.unwrap().unwrap();
}

fn read_usage(data: &Path) -> (String, Vec<Value>) {
    let text = std::fs::read_to_string(usage_path(data, DATE)).unwrap_or_else(|error| panic!("사용량 파일이 없다: {error}"));
    let rows = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    (text, rows)
}

fn minute_of(rows: &[Value], key: &str) -> UsageMinute {
    let trs = rows
        .iter()
        .filter(|row| row["scope"] == "tr" && row["key"] == key)
        .map(|row| collector::shared::TrMinute {
            tr: row["tr"].as_str().unwrap().to_owned(),
            sent: row["sent"].as_u64().unwrap() as u32,
            rate_limited: row["rate_limited"].as_u64().unwrap() as u32,
            resent: row["resent"].as_u64().unwrap() as u32,
            max_wait_ms: row["max_wait_ms"].as_u64().unwrap(),
            max_per_second: row["max_per_second"].as_u64().unwrap() as u32,
        })
        .collect();
    let key_max = rows.iter().find(|row| row["scope"] == "key" && row["key"] == key).map(|row| row["max_per_second"].as_u64().unwrap() as u32).expect("키 전체 줄이 있다");
    UsageMinute { minute_start: 0, key_max_per_second: key_max, trs }
}

async fn one_key_two_trs_usage(limit: Limit) -> (String, Vec<Value>, collector::supervise::SharedReport) {
    let shared = Shared::start(probe_assignment(&["rest-01"], 5, None), limit, |_| {});
    sleep(Duration::from_secs(75)).await;
    let (text, rows) = read_usage(&shared.data());
    let report = shared.report.borrow().clone();
    shared.finish().await;
    (text, rows, report)
}

#[tokio::test(start_paused = true)]
async fn usage_lines_keep_per_tr_and_whole_key_peaks_apart_and_tell_a_total_limit_from_an_independent_one() {
    let (text, rows, report) = one_key_two_trs_usage(Limit::KeyTotalOver(5)).await;
    assert!(text.ends_with('\n') && text.lines().all(|line| !line.trim().is_empty()), "사용량 파일에는 빈 줄이 없다");
    let trs: Vec<&str> = rows.iter().filter(|row| row["scope"] == "tr").map(|row| row["tr"].as_str().unwrap()).collect();
    assert_eq!(trs, ["ka10001", "ka10008"]);
    assert!(rows.iter().all(|row| row["v"] == 1 && row["key"] == "rest-01" && row["broker"] == "kiwoom" && row["at"].as_str().unwrap().starts_with("2026-11-18T09:0")), "{rows:?}");
    let total_case = minute_of(&rows, "rest-01");
    assert!(total_case.trs.iter().all(|tr| tr.max_per_second <= 5 && tr.sent >= 5), "TR 하나는 5를 넘지 않는다: {total_case:?}");
    assert!(total_case.key_max_per_second > 5, "키 전체는 5를 넘어 보냈다: {total_case:?}");
    assert!(total_case.trs.iter().any(|tr| tr.rate_limited > 0 && tr.resent > 0), "합계 5 초과에서 제한 응답이 난다: {total_case:?}");
    assert_eq!(judge_limit(&total_case), LimitEvidence::TotalLimit);

    let usage = report.keys[0].usage.as_ref().expect("상태의 키 항목에 지난 1분 값이 실린다");
    assert_eq!(usage.key_max_per_second, total_case.key_max_per_second);
    assert_eq!(usage.trs.len(), 2);
    assert_eq!(report.keys[0].role, KeyRole::Rest);

    let (_, rows, _) = one_key_two_trs_usage(Limit::PerTrOver(5)).await;
    let independent_case = minute_of(&rows, "rest-01");
    assert!(independent_case.trs.iter().all(|tr| tr.max_per_second <= 5 && tr.rate_limited == 0), "TR별 한도만 있으면 TR마다 5로 제한 응답이 없다: {independent_case:?}");
    assert!(independent_case.key_max_per_second > 5, "그래도 키 전체는 5를 넘는다: {independent_case:?}");
    assert_eq!(judge_limit(&independent_case), LimitEvidence::Independent);
    assert_ne!(judge_limit(&total_case), judge_limit(&independent_case), "두 경우의 줄이 구별된다");
}

#[tokio::test(start_paused = true)]
async fn a_key_with_total_per_second_five_never_sends_more_than_five_in_any_second() {
    let shared = Shared::start(probe_assignment(&["rest-01"], 5, Some(("rest-01", 5))), Limit::None, |_| {});
    sleep(Duration::from_secs(100)).await;
    let calls: Vec<Duration> = shared.kiwoom.market_calls().into_iter().map(|(at, ..)| at).collect();
    assert!(calls.len() >= 30, "일이 여러 번 돌았다: {}", calls.len());
    for start in &calls {
        let in_second = calls.iter().filter(|at| *at >= start && **at < *start + Duration::from_secs(1)).count();
        assert!(in_second <= 5, "{start:?}부터 1초에 {in_second}건");
    }
    sleep(Duration::from_secs(20)).await;
    let (_, rows) = read_usage(&shared.data());
    let minute = minute_of(&rows, "rest-01");
    assert!(minute.key_max_per_second <= 5, "{minute:?}");
    assert!(minute.trs.iter().all(|tr| tr.rate_limited == 0));
    shared.finish().await;
}

#[test]
fn the_usage_log_writes_whole_lines_only_and_never_a_blank_one() {
    let folder = tempfile::tempdir().unwrap();
    let log = UsageLog::new(folder.path().to_owned());
    let minute = UsageMinute {
        minute_start: at(9, 1, 0).unix(),
        key_max_per_second: 7,
        trs: vec![collector::shared::TrMinute { tr: "ka10095".into(), sent: 12, rate_limited: 1, resent: 1, max_wait_ms: 1050, max_per_second: 5 }],
    };
    log.append(&name_of("rest-01"), Broker::Kiwoom, &minute).unwrap();
    log.append(&name_of("rest-01"), Broker::Kiwoom, &minute).unwrap();
    let text = std::fs::read_to_string(usage_path(folder.path(), DATE)).unwrap();
    assert!(text.ends_with('\n') && !text.contains("\n\n") && !text.starts_with('\n'), "{text:?}");
    assert_eq!(text.lines().count(), 4);
    let first: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(
        first,
        json!({"v": 1, "at": "2026-11-18T09:01:00+09:00", "key": "rest-01", "broker": "kiwoom", "scope": "tr", "tr": "ka10095", "sent": 12, "rate_limited": 1, "resent": 1, "max_wait_ms": 1050, "max_per_second": 5})
    );
    let last: Value = serde_json::from_str(text.lines().nth(1).unwrap()).unwrap();
    assert_eq!(last, json!({"v": 1, "at": "2026-11-18T09:01:00+09:00", "key": "rest-01", "broker": "kiwoom", "scope": "key", "max_per_second": 7}));
}

struct NoHolidays;

impl HolidayTransport for NoHolidays {
    fn fetch<'a>(&'a self, request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, HolidayError>> {
        let _ = request;
        Box::pin(async { Ok(r#"{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL SERVICE."},"body":{"items":"","numOfRows":100,"pageNo":1,"totalCount":0}}}"#.to_owned()) })
    }
}

struct NoFinalize;

impl FinalizeRunner for NoFinalize {
    fn run(&self, _: Vec<String>) -> BoxFuture<'_, io::Result<i32>> {
        Box::pin(async { Ok(0) })
    }
}

struct DayHarness {
    folder: tempfile::TempDir,
    clock: Clock,
    launcher: Arc<FakeLauncher>,
    status: watch::Receiver<collector::supervise::DaemonStatus>,
    stop: watch::Sender<bool>,
    done: tokio::task::JoinHandle<()>,
}

impl DayHarness {
    fn shared_config(&self) -> PathBuf {
        self.folder.path().join("collector-shared.json")
    }

    fn data(&self) -> PathBuf {
        self.folder.path().join("data")
    }

    async fn until(&self, time: KstTime) {
        self.clock.sleep_until(time).await;
        for _ in 0..3 {
            sleep(Duration::from_millis(1)).await;
        }
    }

    fn status_now(&self) -> collector::supervise::DaemonStatus {
        self.status.borrow().clone()
    }

    async fn finish(self) {
        self.stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(120), self.done).await.expect("데몬이 끝나지 않았다").unwrap();
    }
}

fn universe_file(date: u32) -> String {
    let stocks: Vec<Value> = ["000010", "000020", "000030", "000040"]
        .iter()
        .map(|code| json!({"code": code, "name": format!("가상{code}"), "market": "kospi", "kind": "common", "status": [], "registered": true}))
        .collect();
    json!({"format_version": 1, "date": date, "fetched_at": format!("{date} 07:20"), "stocks": stocks, "warnings": [], "diff": {"added": [], "removed": [], "renamed": [], "halt_started": [], "halt_lifted": []}, "replaced": null}).to_string()
}

fn start_day(with_shared: bool, prepare: impl FnOnce(&Path, &Path)) -> DayHarness {
    let folder = tempfile::tempdir().unwrap();
    let data = folder.path().join("data");
    std::fs::create_dir_all(data.join("universe")).unwrap();
    std::fs::write(data.join("universe").join(format!("{DATE}.json")), universe_file(DATE)).unwrap();
    std::fs::write(folder.path().join("holiday-key"), "SvcKey-shared-test").unwrap();
    let config = folder.path().join("collector-shared.json");
    prepare(&config, &data);
    let mut keys: Vec<ActiveKey> = [("collect-01", KeyRole::Collecting), ("collect-02", KeyRole::Collecting), ("spare-01", KeyRole::Spare)].iter().map(|(name, role)| plain_key(folder.path(), name, *role)).collect();
    keys.push(rest_key(folder.path(), "rest-01", Broker::Kiwoom));
    keys.push(rest_key(folder.path(), "rest-02", Broker::Kiwoom));
    let clock = Clock::fake(at(7, 0, 0));
    let kiwoom = FakeKiwoom::new(Limit::None);
    let launcher = FakeLauncher::new(kiwoom.clone(), clock.clone(), data.join("shared"));
    let daemon = Daemon::start(
        DaemonInputs { keys, data_dir: data.clone(), supervisor: Settings::default(), schedule: ScheduleSettings::default(), holiday_key_path: folder.path().join("holiday-key") },
        DaemonInjected { launcher: launcher.clone(), transport: kiwoom, holidays: Arc::new(NoHolidays), finalizer: Arc::new(NoFinalize), clock: clock.clone() },
    )
    .unwrap_or_else(|error| panic!("시작하지 못했다: {error}"));
    let daemon = if with_shared { daemon.with_shared_jobs(SharedJobs { assignment_path: config, kis_transport: None }) } else { daemon };
    let status = daemon.status();
    let (stop, shutdown) = watch::channel(false);
    let done = tokio::spawn(daemon.run(shutdown));
    DayHarness { folder, clock, launcher, status, stop, done }
}

fn write_assignment(path: &Path, key: &str, period: u64) {
    std::fs::write(path, json!({"version": 1, "jobs": {"probe": {"keys": [key], "period_secs": period, "options": {"calls_per_tr": 2}}}}).to_string()).unwrap();
}

#[tokio::test(start_paused = true)]
async fn the_daemon_reads_the_assignment_again_at_the_plan_time_and_starts_one_shared_child_per_assigned_rest_key() {
    let day = start_day(true, |config, _| write_assignment(config, "rest-01", 30));
    day.until(at(7, 34, 0)).await;
    write_assignment(&day.shared_config(), "rest-02", 45);
    day.until(at(7, 54, 0)).await;
    assert!(day.launcher.shared_keys().is_empty(), "자식은 07:55에 뜬다");
    day.until(at(7, 58, 0)).await;
    assert_eq!(day.launcher.shared_keys(), ["rest-02"], "07:35에 다시 읽어 바뀐 배정이 쓰인다");
    let received = day.launcher.received_by("rest-02").remove(0);
    let assigned = received.assigned();
    assert_eq!((assigned[0].0, assigned[0].1[0].period_secs, assigned[0].1[0].slice_count), (DATE, 45, 1));
    assert_eq!(day.launcher.collect.lock().unwrap().len(), 3, "수집 자식은 수집·예비 키만 뜬다");
    let plan = collector::plan::read_plan(&day.data(), DATE).unwrap();
    assert!(plan.keys.iter().all(|key| key.role != KeyRole::Rest), "계획에 rest 키는 들지 않는다");
    let status = day.status_now();
    let rest = status.keys.iter().find(|key| key.name.as_str() == "rest-02").expect("상태에 rest 키가 보인다");
    assert_eq!(rest.role, KeyRole::Rest);
    assert!(status.keys.iter().all(|key| key.name.as_str() != "rest-01"));
    assert_eq!(status.phase, DayPhase::Collecting);
    day.finish().await;
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_assignment_at_the_plan_time_uses_the_previous_one_and_alerts() {
    let day = start_day(true, |config, data| {
        let previous = tempfile::tempdir().unwrap();
        write_assignment(&previous.path().join("p.json"), "rest-01", 30);
        std::fs::create_dir_all(data.join("plan")).unwrap();
        std::fs::copy(previous.path().join("p.json"), data.join("plan").join("shared-assignment.last.json")).unwrap();
        std::fs::write(config, "{ 깨진 파일").unwrap();
    });
    day.until(at(7, 58, 0)).await;
    assert_eq!(day.launcher.shared_keys(), ["rest-01"], "전날 배정을 쓴다");
    let alert = day.status_now().alerts.into_iter().find(|alert| alert.kind == AlertKind::StageFailed && alert.message.contains("전날 배정")).expect("경보가 난다");
    assert!(alert.message.contains("키 배정표"), "{}", alert.message);
    day.finish().await;
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_assignment_with_no_previous_one_runs_no_shared_job_and_alerts() {
    let day = start_day(true, |config, _| std::fs::write(config, "{ 깨진 파일").unwrap());
    day.until(at(7, 58, 0)).await;
    assert!(day.launcher.shared_keys().is_empty());
    assert!(day.status_now().alerts.iter().any(|alert| alert.kind == AlertKind::StageFailed && alert.message.contains("공용 자료 일을 돌리지 않습니다")));
    assert_eq!(day.launcher.collect.lock().unwrap().len(), 3, "수집은 그대로 돈다");
    day.finish().await;
}

#[tokio::test(start_paused = true)]
async fn without_an_assignment_file_no_shared_child_starts_and_nothing_is_alerted() {
    let day = start_day(true, |_, _| {});
    day.until(at(7, 58, 0)).await;
    assert!(day.launcher.shared_keys().is_empty());
    assert!(day.status_now().alerts.iter().all(|alert| alert.kind != AlertKind::StageFailed), "{:?}", day.status_now().alerts);
    assert_eq!(day.launcher.collect.lock().unwrap().len(), 3);
    day.finish().await;

    let off = start_day(false, |config, _| write_assignment(config, "rest-01", 30));
    off.until(at(7, 58, 0)).await;
    assert!(off.launcher.shared_keys().is_empty(), "배정표 설정을 켜지 않으면 파일이 있어도 돌리지 않는다");
    off.finish().await;
}

#[test]
fn the_single_day_entry_ignores_rest_keys_when_checking_the_plan() {
    let files = KeyFiles::new();
    let entries = vec![
        files.v2("collect-01", "FAKE-APPKEY-A", "collect", "kiwoom"),
        files.v2("spare-01", "FAKE-APPKEY-B", "spare", "kiwoom"),
        files.v2("rest-01", "FAKE-APPKEY-C", "rest", "kiwoom"),
    ];
    let keys_file = files.folder.path().join("keys.json");
    std::fs::write(&keys_file, json!({"version": 2, "keys": entries}).to_string()).unwrap();
    let share = |name: &str, role: KeyRole, app_key: &str, collecting: bool| collector::plan::KeyShare {
        name: name_of(name),
        role,
        app_key_hash: credential_id(app_key),
        stocks: if collecting { vec!["000001".to_owned()] } else { Vec::new() },
        market_types: if collecting { collector::plan::MARKET_TYPES.to_vec() } else { Vec::new() },
        rest_jobs: Vec::new(),
        load: 0,
    };
    let plan = collector::plan::PlanFile {
        format_version: 1,
        date: 20260105,
        created_at: "2026-01-05T07:35:00+09:00".to_owned(),
        input: collector::plan::InputSummary { active_keys: 2, universe_replaced: None },
        keys: vec![share("collect-01", KeyRole::Collecting, "FAKE-APPKEY-A", true), share("spare-01", KeyRole::Spare, "FAKE-APPKEY-B", false)],
        excluded: Vec::new(),
        unregistered: Vec::new(),
        alerts: Vec::new(),
    };
    let data = files.folder.path().join("data");
    collector::plan::write_plan(&data, &plan).unwrap();
    let sockets = tempfile::Builder::new().prefix("sj").tempdir_in("/tmp").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["supervise", "--date", "20260105", "--keys"])
        .arg(&keys_file)
        .arg("--data")
        .arg(&data)
        .arg("--state")
        .arg(files.folder.path().join("state"))
        .arg("--socket")
        .arg(sockets.path().join("s.sock"))
        .env_clear()
        .output()
        .unwrap();
    assert!(output.status.success(), "rest 키가 있어도 시작한다: {}", String::from_utf8_lossy(&output.stderr));
}
