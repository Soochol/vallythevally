use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use collector::protocol::KeyName;
use collector::shared::{JobLoop, JobName, LoopStats, Market, Slice};
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::api::{Market as ApiMarket, ViDirection};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{DataKind, SharedData};
use tokio::time::sleep;

fn today() -> KstDate {
    KstDate::new(2026, 11, 23).unwrap()
}

#[derive(Default)]
struct FakeMarket {
    theme_calls: AtomicUsize,
    vi_calls: AtomicUsize,
}

fn respond(body: Value) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
    let response = HttpResponse { status: 200, next_key: None, body: body.to_string() };
    Box::pin(async move { Ok(response) })
}

#[derive(Clone)]
struct Wire(Arc<FakeMarket>);

impl Transport for Wire {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        match request.api_id.as_str() {
            "au10001" => respond(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"})),
            "ka90001" => {
                let n = self.0.theme_calls.fetch_add(1, Ordering::SeqCst) + 1;
                let rate = format!("+{n}.25");
                respond(json!({
                    "return_code": 0,
                    "thema_grp": [
                        {"thema_grp_cd": "319", "thema_nm": "조선", "stk_num": "12", "flu_sig": "2", "flu_rt": rate, "rising_stk_num": "9", "fall_stk_num": "3", "dt_prft_rt": rate, "main_stk": "HD현대중공업,한화오션"},
                        {"thema_grp_cd": "100", "thema_nm": "원전", "stk_num": "8", "flu_sig": "5", "flu_rt": "-1.50", "rising_stk_num": "2", "fall_stk_num": "6", "dt_prft_rt": "-1.50", "main_stk": "두산에너빌리티"}
                    ]
                }))
            }
            "ka10054" => {
                self.0.vi_calls.fetch_add(1, Ordering::SeqCst);
                respond(json!({
                    "return_code": 0,
                    "motn_stk": [
                        {
                            "stk_cd": "005930",
                            "stk_nm": "삼성전자",
                            "mrkt_nm": "코스피",
                            "motn_pric": "75000",
                            "trde_cntr_proc_time": "101530",
                            "virelis_time": "000000",
                            "static_stdpc": "68000",
                            "static_dispty_rt": "+10.29",
                            "dynm_dispty_rt": "0.00",
                            "motn_tp": "정적"
                        },
                        {
                            "stk_cd": "247540",
                            "stk_nm": "에코프로비엠",
                            "mrkt_nm": "코스닥",
                            "motn_pric": "182000",
                            "trde_cntr_proc_time": "091205",
                            "virelis_time": "091410",
                            "static_stdpc": "0",
                            "static_dispty_rt": "0.00",
                            "dynm_dispty_rt": "-6.15",
                            "motn_tp": "동적"
                        }
                    ]
                }))
            }
            other => panic!("준비하지 않은 요청: {other}"),
        }
    }
}

fn spawn_job(job: JobName, fake: &Arc<FakeMarket>, clock: &Clock, shared: &Path, period: Duration, slice: Slice) -> tokio::task::JoinHandle<()> {
    let rest = KiwoomRest::new(Arc::new(Wire(fake.clone())), KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None), clock.clone());
    rest.set_access(Access::Open);
    let job_loop = JobLoop { job: job.job(), observation_date: today(), period, slice, peers: Vec::new(), options: Value::Null };
    let (clock, shared) = (clock.clone(), shared.to_owned());
    tokio::spawn(async move {
        let stats = LoopStats::default();
        job_loop.run(Market::Kiwoom(&rest), &KeyName::parse("rest-01").unwrap(), &shared, &clock, &stats).await;
    })
}

#[tokio::test(start_paused = true)]
async fn intraday_themes_job_runs_inside_window_and_publishes_shared_board() {
    let tmp = tempfile::tempdir().unwrap();
    let shared_dir = tmp.path().join("shared");
    let fake = Arc::new(FakeMarket::default());
    let clock = Clock::fake(kst(today(), 8, 58, 0));
    let task = spawn_job(JobName::IntradayThemes, &fake, &clock, &shared_dir, Duration::from_secs(180), Slice::WHOLE);

    sleep(Duration::from_secs(90)).await;
    assert_eq!(fake.theme_calls.load(Ordering::SeqCst), 0);

    sleep(Duration::from_secs(60)).await;
    assert_eq!(fake.theme_calls.load(Ordering::SeqCst), 1);

    let shared = SharedData::new();
    shared.poll_once(&shared_dir).await;
    let first = shared.intraday_themes.current().expect("intraday themes board");
    assert_eq!(first.header.kind, DataKind::IntradayThemes);
    assert_eq!(first.header.observation_date, "20261123");
    assert_eq!(first.body.themes.len(), 2);
    assert_eq!(first.body.themes[0].code, "319");
    assert_eq!(first.body.themes[0].change_rate, 1.25);
    assert!(first.body.complete);
    assert_eq!(shared.error_count(DataKind::IntradayThemes), 0);
    assert!(shared.age_secs(DataKind::IntradayThemes, clock.now()).is_some());

    sleep(Duration::from_secs(180)).await;
    assert_eq!(fake.theme_calls.load(Ordering::SeqCst), 2);
    shared.poll_once(&shared_dir).await;
    let second = shared.intraday_themes.current().unwrap();
    assert_eq!(second.body.themes[0].change_rate, 2.25);

    task.abort();
}

#[tokio::test(start_paused = true)]
async fn vi_events_job_runs_inside_window_and_shared_data_polls_both_boards() {
    let tmp = tempfile::tempdir().unwrap();
    let shared_dir = tmp.path().join("shared");
    let fake = Arc::new(FakeMarket::default());
    let clock = Clock::fake(kst(today(), 8, 59, 0));
    let vi_task = spawn_job(JobName::ViEvents, &fake, &clock, &shared_dir, Duration::from_secs(60), Slice::WHOLE);
    let secondary_slice = spawn_job(JobName::ViEvents, &fake, &clock, &shared_dir, Duration::from_secs(60), Slice { index: 1, count: 2 });

    sleep(Duration::from_secs(30)).await;
    assert_eq!(fake.vi_calls.load(Ordering::SeqCst), 0);

    sleep(Duration::from_secs(40)).await;
    assert_eq!(fake.vi_calls.load(Ordering::SeqCst), 1);

    let shared = SharedData::new();
    shared.poll_once(&shared_dir).await;
    let loaded = shared.vi_events.current().expect("vi events board");
    assert_eq!(loaded.header.kind, DataKind::ViEvents);
    assert_eq!(loaded.header.observation_date, "20261123");
    assert_eq!(loaded.body.events.len(), 2);
    assert_eq!(loaded.body.events[0].code, "005930");
    assert_eq!(loaded.body.events[0].name, "삼성전자");
    assert_eq!(loaded.body.events[0].market, ApiMarket::Kospi);
    assert_eq!(loaded.body.events[0].direction, ViDirection::Up);
    assert_eq!(loaded.body.events[0].triggered_at, "10:15:30");
    assert_eq!(loaded.body.events[0].released_at, None);
    assert_eq!(loaded.body.events[0].trigger_price, Some(75_000));
    assert!(loaded.body.events[0].static_vi);
    assert!(!loaded.body.events[0].dynamic_vi);
    assert_eq!(loaded.body.events[0].dispersion_rate, Some(10.29));

    assert_eq!(loaded.body.events[1].code, "247540");
    assert_eq!(loaded.body.events[1].market, ApiMarket::Kosdaq);
    assert_eq!(loaded.body.events[1].direction, ViDirection::Down);
    assert_eq!(loaded.body.events[1].triggered_at, "09:12:05");
    assert_eq!(loaded.body.events[1].released_at.as_deref(), Some("09:14:10"));
    assert!(!loaded.body.events[1].static_vi);
    assert!(loaded.body.events[1].dynamic_vi);
    assert_eq!(loaded.body.events[1].dispersion_rate, Some(-6.15));
    assert_eq!(shared.error_count(DataKind::ViEvents), 0);
    assert!(shared.age_secs(DataKind::ViEvents, clock.now()).is_some());

    vi_task.abort();
    secondary_slice.abort();
}

#[tokio::test(start_paused = true)]
async fn jobs_stop_after_window_end() {
    let tmp = tempfile::tempdir().unwrap();
    let shared_dir = tmp.path().join("shared");
    let fake = Arc::new(FakeMarket::default());
    let clock = Clock::fake(kst(today(), 15, 34, 30));
    let theme_task = spawn_job(JobName::IntradayThemes, &fake, &clock, &shared_dir, Duration::from_secs(20), Slice::WHOLE);
    let vi_task = spawn_job(JobName::ViEvents, &fake, &clock, &shared_dir, Duration::from_secs(20), Slice::WHOLE);

    sleep(Duration::from_secs(90)).await;
    theme_task.await.unwrap();
    vi_task.await.unwrap();
    assert_eq!(fake.theme_calls.load(Ordering::SeqCst), 2);
    assert_eq!(fake.vi_calls.load(Ordering::SeqCst), 2);
}
