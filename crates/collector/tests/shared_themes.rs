use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use collector::protocol::KeyName;
use collector::shared::{JobLoop, JobName, LoopStats, Market, Slice};
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{Board, DataKind, ThemesBody};
use tokio::time::sleep;

fn today() -> KstDate {
    KstDate::new(2026, 11, 23).unwrap()
}

#[derive(Default)]
struct Kiwoom {
    lists: AtomicUsize,
    members: AtomicUsize,
    list_fails: AtomicBool,
    failing_theme: std::sync::Mutex<Option<String>>,
}

fn respond(body: Value) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
    let response = HttpResponse { status: 200, next_key: None, body: body.to_string() };
    Box::pin(async move { Ok(response) })
}

fn group(code: &str, name: &str) -> Value {
    json!({"thema_grp_cd": code, "thema_nm": name, "stk_num": "10", "flu_sig": "2", "flu_rt": "+1.00", "rising_stk_num": "7", "fall_stk_num": "3", "dt_prft_rt": "+1.00", "main_stk": "가,나"})
}

fn member(code: &str) -> Value {
    json!({"stk_cd": format!("{code}_AL"), "stk_nm": code, "cur_prc": "1000", "flu_sig": "2", "flu_rt": "+1.00", "acc_trde_qty": "10", "dt_prft_rt_n": "+1.00"})
}

#[derive(Clone)]
struct Wire(Arc<Kiwoom>);

impl Transport for Wire {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let this = &self.0;
        match request.api_id.as_str() {
            "au10001" => respond(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"})),
            "ka90001" => {
                this.lists.fetch_add(1, Ordering::SeqCst);
                match this.list_fails.load(Ordering::SeqCst) {
                    true => Box::pin(async { Err(TransportError::refused()) }),
                    false => respond(json!({"return_code": 0, "thema_grp": [group("319", "조선"), group("100", "원전")]})),
                }
            }
            "ka90002" => {
                this.members.fetch_add(1, Ordering::SeqCst);
                let theme = serde_json::from_str::<Value>(request.body.expose()).unwrap()["thema_grp_cd"].as_str().unwrap().to_owned();
                match this.failing_theme.lock().unwrap().as_deref() == Some(theme.as_str()) {
                    true => respond(json!({"return_code": 1, "return_msg": "조회 실패"})),
                    false => respond(json!({"return_code": 0, "flu_rt": "+1.00", "dt_prft_rt": "+1.00", "thema_comp_stk": [member(&format!("{theme:0>6}"))]})),
                }
            }
            other => panic!("준비하지 않은 요청: {other}"),
        }
    }
}

fn start(kiwoom: &Arc<Kiwoom>, clock: &Clock, shared: &Path) -> tokio::task::JoinHandle<()> {
    let rest = KiwoomRest::new(Arc::new(Wire(kiwoom.clone())), KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None), clock.clone());
    rest.set_access(Access::Open);
    let job_loop = JobLoop { job: JobName::KiwoomThemes.job(), observation_date: today(), period: Duration::from_secs(60), slice: Slice::WHOLE, options: Value::Null };
    let (clock, shared) = (clock.clone(), shared.to_owned());
    tokio::spawn(async move {
        let stats = LoopStats::default();
        job_loop.run(Market::Kiwoom(&rest), &KeyName::parse("rest-01").unwrap(), &shared, &clock, &stats).await;
    })
}

fn stored(shared: &Path) -> Option<Vec<(String, Vec<String>)>> {
    let board = Board::<ThemesBody>::new(DataKind::KiwoomThemes);
    board.poll(shared);
    board.current().map(|loaded| loaded.body.themes.iter().map(|theme| (theme.code.clone(), theme.members.clone())).collect())
}

#[tokio::test(start_paused = true)]
async fn themes_are_asked_once_after_half_past_eight_and_not_before() {
    let shared = tempfile::tempdir().unwrap();
    let kiwoom = Arc::new(Kiwoom::default());
    let clock = Clock::fake(kst(today(), 8, 28, 0));
    let task = start(&kiwoom, &clock, shared.path());
    sleep(Duration::from_secs(100)).await;
    assert_eq!((kiwoom.lists.load(Ordering::SeqCst), kiwoom.members.load(Ordering::SeqCst)), (0, 0), "08:30 전에는 부르지 않는다");
    sleep(Duration::from_secs(200)).await;
    assert_eq!((kiwoom.lists.load(Ordering::SeqCst), kiwoom.members.load(Ordering::SeqCst)), (1, 2), "08:30 뒤 한 번, 목록 1쪽과 테마마다 구성종목");
    sleep(Duration::from_secs(600)).await;
    assert_eq!(kiwoom.lists.load(Ordering::SeqCst), 1, "오늘 파일이 있으면 다시 받지 않는다");
    task.abort();
    assert_eq!(stored(shared.path()).unwrap(), [("319".to_owned(), vec!["000319".to_owned()]), ("100".to_owned(), vec!["000100".to_owned()])]);
    let board = Board::<ThemesBody>::new(DataKind::KiwoomThemes);
    board.poll(shared.path());
    let header = board.current().unwrap().header.clone();
    assert_eq!((header.observation_date.as_str(), header.sources[0].key_name.as_str()), ("20261123", "rest-01"));
}

#[tokio::test(start_paused = true)]
async fn a_failed_list_is_asked_again_five_minutes_later() {
    let shared = tempfile::tempdir().unwrap();
    let kiwoom = Arc::new(Kiwoom::default());
    kiwoom.list_fails.store(true, Ordering::SeqCst);
    let clock = Clock::fake(kst(today(), 8, 30, 0));
    let task = start(&kiwoom, &clock, shared.path());
    sleep(Duration::from_secs(10)).await;
    let first_attempt = kiwoom.lists.load(Ordering::SeqCst);
    assert!(first_attempt >= 1, "08:30에 처음 묻는다");
    sleep(Duration::from_secs(250)).await;
    assert_eq!(kiwoom.lists.load(Ordering::SeqCst), first_attempt, "5분이 지나기 전에는 다시 묻지 않는다");
    assert!(stored(shared.path()).is_none());
    kiwoom.list_fails.store(false, Ordering::SeqCst);
    sleep(Duration::from_secs(100)).await;
    assert_eq!(kiwoom.lists.load(Ordering::SeqCst), first_attempt + 1, "5분 뒤 다시 받는다");
    assert!(stored(shared.path()).is_some());
    sleep(Duration::from_secs(600)).await;
    assert_eq!(kiwoom.lists.load(Ordering::SeqCst), first_attempt + 1, "받은 뒤에는 다시 묻지 않는다");
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn a_theme_that_cannot_be_asked_keeps_the_previous_days_members() {
    let shared = tempfile::tempdir().unwrap();
    let yesterday = KstDate::new(2026, 11, 22).unwrap();
    let previous = Kiwoom::default();
    let first = Arc::new(previous);
    let clock = Clock::fake(kst(yesterday, 8, 30, 0));
    let rest = KiwoomRest::new(Arc::new(Wire(first.clone())), KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None), clock.clone());
    rest.set_access(Access::Open);
    let day_before = JobLoop { job: JobName::KiwoomThemes.job(), observation_date: yesterday, period: Duration::from_secs(60), slice: Slice::WHOLE, options: Value::Null };
    let task = tokio::spawn({
        let (clock, shared) = (clock.clone(), shared.path().to_owned());
        async move { day_before.run(Market::Kiwoom(&rest), &KeyName::parse("rest-01").unwrap(), &shared, &clock, &LoopStats::default()).await }
    });
    sleep(Duration::from_secs(10)).await;
    task.abort();
    assert!(stored(shared.path()).is_some());

    let kiwoom = Arc::new(Kiwoom::default());
    *kiwoom.failing_theme.lock().unwrap() = Some("100".to_owned());
    let clock = Clock::fake(kst(today(), 8, 30, 0));
    let task = start(&kiwoom, &clock, shared.path());
    sleep(Duration::from_secs(10)).await;
    task.abort();
    assert_eq!(stored(shared.path()).unwrap(), [("319".to_owned(), vec!["000319".to_owned()]), ("100".to_owned(), vec!["000100".to_owned()])], "받지 못한 테마는 지난 구성종목");
    assert!(shared.path().join("kiwoom_themes/20261123.json").exists());
}
