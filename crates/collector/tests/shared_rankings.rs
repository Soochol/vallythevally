use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::protocol::KeyName;
use collector::shared::rankings::{Owner, RankingsJob, owner_of};
use collector::shared::{JobLoop, LoopStats, Market, Slice};
use domain::{KstDate, KstTime};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::api::{Excludes, Ranking, RankingMarket, Venue};
use server::clock::{Clock, kst};
use server::config::{KisCredentials, Secret};
use server::kis::api::KisApiId;
use server::kis::auth::KisAuth;
use server::kis::rest::KisRest;
use server::kis::token_file::{Saved, SavedToken, TokenFile, credential_id};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::market_source::Priority;
use server::market_source::rankings::{Demand, RankingSource, condition_key};
use server::rankings::KiwoomRankings;
use server::shared_data::{Broker, ConditionState, MergedRankings, SharedData, default_rankings};
use tokio::time::sleep;

const DATE: u32 = 20261118;
const PAGES: usize = 5;
const KIS_APP_KEY: &str = "FAKE-KIS-APPKEY-shared-rankings";
const KEEP_ALL: Excludes = Excludes { etf_etn: false, preferred: false };

fn today() -> KstDate {
    KstDate::parse_yyyymmdd(&DATE.to_string()).unwrap()
}

fn ten_o_clock() -> KstTime {
    kst(today(), 10, 0, 0)
}

fn server_fixture(relative: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../server/tests/fixtures").join(relative)).unwrap().trim().to_owned()
}

struct FakeKiwoom {
    calls: Mutex<Vec<String>>,
    pages_available: usize,
    failing_api: Mutex<Option<&'static str>>,
}

impl FakeKiwoom {
    fn new(pages_available: usize) -> Arc<FakeKiwoom> {
        Arc::new(FakeKiwoom { calls: Mutex::default(), pages_available, failing_api: Mutex::default() })
    }

    fn per_api(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for api in self.calls.lock().unwrap().iter() {
            *counts.entry(api.clone()).or_default() += 1;
        }
        counts
    }

    fn fail(&self, api: &'static str) {
        *self.failing_api.lock().unwrap() = Some(api);
    }
}

fn reply(body: Value, next_key: Option<String>) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status: 200, next_key, body: body.to_string() })
}

impl Transport for FakeKiwoom {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let api = request.api_id.as_str().to_owned();
        if api == "au10001" {
            let answer = reply(json!({"token": "tok", "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}), None);
            return Box::pin(async move { answer });
        }
        self.calls.lock().unwrap().push(api.clone());
        let page: usize = request.cont.as_ref().map_or(1, |cont| cont.as_str().trim_start_matches('K').parse::<usize>().unwrap() + 1);
        let answer = if self.failing_api.lock().unwrap().is_some_and(|failing| failing == api) {
            reply(json!({"return_code": 2, "return_msg": "[1511:필수]"}), None)
        } else {
            let mut body: Value = serde_json::from_str(&server_fixture(&format!("kiwoom/rank_{api}{}.json", if api == "ka10095" { "_krx" } else { "" }))).unwrap();
            let fields = body.as_object_mut().unwrap();
            fields.remove("_headers");
            fields.remove("_source");
            reply(body, (page < self.pages_available).then(|| format!("K{}", page)))
        };
        Box::pin(async move { answer })
    }
}

fn kiwoom_rest(fake: &Arc<FakeKiwoom>, clock: &Clock) -> KiwoomRest {
    KiwoomRest::with_send_spacing(fake.clone(), KiwoomAuth::new(Secret::new("key".into()), Secret::new("secret".into()), None), clock.clone(), Duration::ZERO)
}

struct FakeKis {
    sent: Mutex<Vec<&'static str>>,
    answering: AtomicBool,
}

impl FakeKis {
    fn new() -> Arc<FakeKis> {
        Arc::new(FakeKis { sent: Mutex::default(), answering: AtomicBool::new(true) })
    }

    fn total(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}

fn kis_fixture_of(path: &str) -> &'static str {
    [
        (KisApiId::VolumeRank, "volume_rank.json"),
        (KisApiId::OvertimeVolume, "overtime.json"),
        (KisApiId::Fluctuation, "fluctuation.json"),
        (KisApiId::ExpectedUpDown, "expected.json"),
        (KisApiId::InvestorTotal, "investor.json"),
        (KisApiId::QuoteBalance, "balance.json"),
        (KisApiId::CreditBalance, "credit.json"),
        (KisApiId::HtsTopView, "top_view.json"),
    ]
    .into_iter()
    .find(|(api, _)| api.path() == path)
    .map(|(_, file)| file)
    .unwrap_or_else(|| panic!("모르는 한투 경로 {path}"))
}

impl server::kis::transport::Transport for FakeKis {
    fn send(&self, request: server::kis::transport::HttpRequest) -> BoxFuture<'static, Result<server::kis::transport::HttpResponse, server::kis::transport::TransportError>> {
        self.sent.lock().unwrap().push(request.path);
        let body = server_fixture(&format!("kis/rankings/{}", kis_fixture_of(request.path)));
        let status = if self.answering.load(Ordering::SeqCst) { 200 } else { 500 };
        Box::pin(async move { Ok(server::kis::transport::HttpResponse { status, tr_cont: None, body }) })
    }
}

fn kis_rest(fake: &Arc<FakeKis>, clock: &Clock, folder: &Path) -> KisRest {
    let token_folder = folder.join("kis-state");
    std::fs::create_dir_all(&token_folder).unwrap();
    std::fs::set_permissions(&token_folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path: PathBuf = token_folder.join("kis-token.json");
    let now = clock.now();
    TokenFile::new(path.clone())
        .save(&Saved {
            credential: Some(credential_id(KIS_APP_KEY)),
            token: Some(SavedToken { value: "FAKE-KIS-TOKEN".into(), expires_at: now.unix() + 86_400, issued_at: now.unix() - 3600 }),
            last_request_at: now.unix() - 3600,
            disconnected: None,
        })
        .unwrap();
    let credentials = KisCredentials { app_key: Secret::new(KIS_APP_KEY.into()), app_secret: Secret::new("FAKE-KIS-SECRET".into()) };
    let transport: Arc<dyn server::kis::transport::Transport> = fake.clone();
    KisRest::new(transport.clone(), KisAuth::new(credentials, path, transport, clock.clone()))
}

fn loop_of(options: Value, slice: Slice, peers: &[Broker]) -> JobLoop {
    JobLoop { job: Arc::new(RankingsJob::default()), observation_date: today(), period: Duration::from_secs(10), slice, peers: peers.to_vec(), options }
}

async fn run_for(job_loop: &JobLoop, market: Market<'_>, key: &str, shared: &Path, clock: &Clock, stats: &LoopStats, seconds: u64) {
    let key = KeyName::parse(key).unwrap();
    tokio::select! {
        _ = job_loop.run(market, &key, shared, clock, stats) => {}
        _ = sleep(Duration::from_secs(seconds)) => {}
    }
}

fn merged_of(shared: &Path) -> Arc<MergedRankings> {
    let data = SharedData::new();
    data.rankings.poll(shared);
    data.rankings.current().expect("쓴 조각을 서버 읽기 함수가 읽는다")
}

fn count_of(ranking: &Ranking) -> &'static str {
    match ranking {
        Ranking::TradeAmount { .. } => "ka10032",
        Ranking::TradeVolume { .. } | Ranking::Turnover { .. } => "ka10030",
        Ranking::VolumeSurge { .. } => "ka10023",
        Ranking::Gainers { .. } | Ranking::Losers { .. } => "ka10027",
        Ranking::Expected { .. } => "ka10029",
        Ranking::InvestorNetBuy { .. } => "ka10065",
        Ranking::ForeignStreak { .. } => "ka10035",
        Ranking::Program { .. } => "ka90003",
        Ranking::BidAskBalance { .. } => "ka10020",
        Ranking::CreditRatio { .. } => "ka10033",
        Ranking::MostViewed { .. } => "ka00198",
    }
}

fn expected_calls(rankings: &[Ranking], pages_per_condition: usize) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for ranking in rankings {
        *counts.entry(count_of(ranking).to_owned()).or_default() += pages_per_condition;
    }
    counts
}

fn trade_amount_variant() -> Value {
    json!({"kind": "tradeAmount", "market": "all", "venue": "combined", "excludeManaged": false})
}

fn gainers_variant() -> Value {
    json!({"kind": "gainers", "market": "kospi", "venue": "combined", "includeLimit": true, "minTradeAmount": "any", "excludeManaged": false})
}

#[test]
fn a_condition_goes_to_the_first_key_that_can_take_it_and_same_broker_keys_share_it() {
    let can = |broker: Broker| broker == Broker::Kis;
    assert_eq!(owner_of(0, &[Broker::Kis, Broker::Kiwoom], can), Owner::Key(0));
    assert_eq!(owner_of(1, &[Broker::Kis, Broker::Kiwoom], can), Owner::Key(0));
    assert_eq!(owner_of(1, &[Broker::Kiwoom, Broker::Kis], can), Owner::Key(1));
    assert_eq!((owner_of(0, &[Broker::Kis, Broker::Kiwoom, Broker::Kis], can), owner_of(1, &[Broker::Kis, Broker::Kiwoom, Broker::Kis], can)), (Owner::Key(0), Owner::Key(2)));
    assert_eq!(owner_of(0, &[Broker::Kiwoom], can), Owner::Nobody);
    assert_eq!(owner_of(0, &[], can), Owner::Nobody);
}

#[tokio::test(start_paused = true)]
async fn one_ten_second_run_sends_pages_calls_per_condition_to_each_tr_and_the_file_reads_back_by_the_servers_key_rule() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(ten_o_clock());
    let fake = FakeKiwoom::new(usize::MAX);
    let defaults = default_rankings();
    assert_eq!(defaults.len(), 35, "종류마다 기본 선택값 × 시장 × 통합 거래소");
    let (stats, job_loop) = (LoopStats::default(), loop_of(Value::Null, Slice::WHOLE, &[Broker::Kiwoom]));
    run_for(&job_loop, Market::Kiwoom(&kiwoom_rest(&fake, &clock)), "rest-01", folder.path(), &clock, &stats, 5).await;

    assert_eq!(stats.runs(), 1);
    assert_eq!(stats.last_error(), None);
    let sent = fake.per_api();
    for (api, expected) in expected_calls(&defaults, PAGES) {
        assert_eq!(sent.get(&api), Some(&expected), "{api}");
    }
    let merged = merged_of(folder.path());
    assert_eq!(merged.len(), defaults.len());
    for ranking in &defaults {
        let with_excludes = match *ranking {
            Ranking::TradeAmount { market, venue, exclude_managed, .. } => Ranking::TradeAmount { market, venue, excludes: Excludes { etf_etn: true, preferred: true }, exclude_managed },
            other => other,
        };
        let found = merged.find(&with_excludes, PAGES as u8).unwrap_or_else(|| panic!("{}", condition_key(ranking)));
        let last = found.last.as_ref().expect("받은 값");
        assert_eq!((found.state.clone(), last.pages, last.broker, last.rows.is_empty()), (ConditionState::Ready, PAGES as u8, Broker::Kiwoom, false));
    }
    assert!(merged.find(&defaults[0], PAGES as u8 + 1).is_none(), "미리 만든 쪽 수보다 많이 달라는 요청은 찾지 못한다");
}

#[tokio::test(start_paused = true)]
async fn a_list_that_ends_early_stops_the_walk_there() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(ten_o_clock());
    let fake = FakeKiwoom::new(3);
    let (stats, job_loop) = (LoopStats::default(), loop_of(json!({"variants": [trade_amount_variant(), gainers_variant()]}), Slice::WHOLE, &[Broker::Kiwoom]));
    run_for(&job_loop, Market::Kiwoom(&kiwoom_rest(&fake, &clock)), "rest-01", folder.path(), &clock, &stats, 5).await;

    assert_eq!(fake.per_api(), BTreeMap::from([("ka10027".to_owned(), 3), ("ka10032".to_owned(), 3)]));
    let merged = merged_of(folder.path());
    let last = merged.find(&default_rankings()[0], 3).and_then(|found| found.last.clone()).expect("거래대금 전체");
    assert_eq!((last.pages, last.end), (3, true));
}

#[tokio::test(start_paused = true)]
async fn the_first_key_takes_what_it_can_and_the_second_key_the_rest_and_with_no_second_key_those_are_unavailable() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(ten_o_clock());
    let (kiwoom_fake, kis_fake) = (FakeKiwoom::new(usize::MAX), FakeKis::new());
    let (kis, kiwoom) = (kis_rest(&kis_fake, &clock, folder.path()), kiwoom_rest(&kiwoom_fake, &clock));
    let peers = [Broker::Kis, Broker::Kiwoom];
    let (kis_stats, kiwoom_stats) = (LoopStats::default(), LoopStats::default());
    let shared = folder.path().join("shared");
    let (kis_loop, kiwoom_loop) = (loop_of(Value::Null, Slice { index: 0, count: 2 }, &peers), loop_of(Value::Null, Slice { index: 1, count: 2 }, &peers));
    tokio::join!(
        run_for(&kis_loop, Market::Kis(Some(&kis)), "rest-kis", &shared, &clock, &kis_stats, 5),
        run_for(&kiwoom_loop, Market::Kiwoom(&kiwoom), "rest-01", &shared, &clock, &kiwoom_stats, 5),
    );

    let defaults = default_rankings();
    let kiwoom_only: Vec<Ranking> = defaults.iter().filter(|ranking| matches!(ranking, Ranking::ForeignStreak { .. } | Ranking::Program { .. } | Ranking::MostViewed { .. })).copied().collect();
    assert_eq!(kiwoom_only.len(), 6, "외국인 연속 3 + 프로그램 2 + 한투가 당일 누적만 받는 많이 본 종목 1");
    assert_eq!(kiwoom_fake.per_api(), expected_calls(&kiwoom_only, PAGES), "외국인 연속 순매수·프로그램 순매수와, 한투가 받지 못하는 많이 본 종목 1분만 키움 키로 나간다");
    assert_eq!(kis_fake.total(), defaults.len() - kiwoom_only.len(), "나머지는 한투 키로, 한투는 조건마다 한 번");
    let merged = merged_of(&shared);
    for ranking in &defaults {
        let broker = merged.find(ranking, 1).and_then(|found| found.last.as_ref().map(|last| last.broker));
        let want = if kiwoom_only.contains(ranking) { Broker::Kiwoom } else { Broker::Kis };
        assert_eq!(broker, Some(want), "{}", condition_key(ranking));
    }

    let alone = tempfile::tempdir().unwrap();
    let kis_alone = kis_rest(&FakeKis::new(), &clock, alone.path());
    let alone_loop = loop_of(Value::Null, Slice::WHOLE, &[Broker::Kis]);
    run_for(&alone_loop, Market::Kis(Some(&kis_alone)), "rest-kis", &alone.path().join("shared"), &clock, &LoopStats::default(), 5).await;
    let merged = merged_of(&alone.path().join("shared"));
    for ranking in &kiwoom_only {
        let found = merged.find(ranking, 1).unwrap();
        assert_eq!((found.state.clone(), found.last.is_none()), (ConditionState::Unavailable, true), "키움 키가 없으면 받을 수 없음");
    }
}

#[tokio::test(start_paused = true)]
async fn when_one_condition_fails_the_others_are_new_and_it_keeps_its_old_value_with_a_failure_mark() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(ten_o_clock());
    let fake = FakeKiwoom::new(usize::MAX);
    let options = json!({"variants": [trade_amount_variant(), gainers_variant()], "pages": 1});
    let (stats, job_loop) = (LoopStats::default(), loop_of(options, Slice::WHOLE, &[Broker::Kiwoom]));
    let rest = kiwoom_rest(&fake, &clock);
    let breaker = async {
        sleep(Duration::from_secs(5)).await;
        fake.fail("ka10027");
    };
    tokio::join!(run_for(&job_loop, Market::Kiwoom(&rest), "rest-01", folder.path(), &clock, &stats, 15), breaker);

    assert_eq!(stats.runs(), 2);
    let merged = merged_of(folder.path());
    let rankings = [Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes: KEEP_ALL, exclude_managed: false }, Ranking::Gainers { market: RankingMarket::Kospi, venue: Venue::Combined, include_limit: true, min_trade_amount: server::api::MinTradeAmount::Any, excludes: KEEP_ALL, exclude_managed: false }];
    let fresh = merged.find(&rankings[0], 1).unwrap();
    let failed = merged.find(&rankings[1], 1).unwrap();
    assert_eq!(fresh.state, ConditionState::Ready);
    assert!(matches!(failed.state, ConditionState::Failed { .. }), "{:?}", failed.state);
    let (new, old) = (fresh.last.as_ref().unwrap().received_at, failed.last.as_ref().expect("이전 값이 남는다").received_at);
    assert_eq!(new - old, 10, "성공한 조건은 두 번째 틱 값, 실패한 조건은 첫 틱 값");
}

#[tokio::test(start_paused = true)]
async fn the_pages_option_sets_how_many_pages_each_condition_walks() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(ten_o_clock());
    let fake = FakeKiwoom::new(usize::MAX);
    let (stats, job_loop) = (LoopStats::default(), loop_of(json!({"variants": [trade_amount_variant()], "pages": 2}), Slice::WHOLE, &[Broker::Kiwoom]));
    run_for(&job_loop, Market::Kiwoom(&kiwoom_rest(&fake, &clock)), "rest-01", folder.path(), &clock, &stats, 5).await;

    assert_eq!(fake.per_api(), BTreeMap::from([("ka10032".to_owned(), 2)]));
    let last = merged_of(folder.path()).find(&default_rankings()[0], 2).and_then(|found| found.last.clone()).expect("거래대금 전체");
    assert_eq!(last.pages, 2);
}

#[tokio::test(start_paused = true)]
async fn the_rows_in_the_file_are_the_rows_the_source_returned() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(ten_o_clock());
    let fake = FakeKiwoom::new(usize::MAX);
    let rest = kiwoom_rest(&fake, &clock);
    let (stats, job_loop) = (LoopStats::default(), loop_of(json!({"variants": [trade_amount_variant()], "pages": 1}), Slice::WHOLE, &[Broker::Kiwoom]));
    run_for(&job_loop, Market::Kiwoom(&rest), "rest-01", folder.path(), &clock, &stats, 5).await;

    let ranking = default_rankings()[0];
    let (_keep, best) = tokio::sync::watch::channel(Priority::Background);
    let fetched = KiwoomRankings::new(rest).page(&ranking, None, &mut Demand::new(best)).await.ok().expect("한 쪽을 받는다");
    let merged = merged_of(folder.path());
    let written = &merged.find(&ranking, 1).and_then(|found| found.last.clone()).expect("거래대금 전체").rows;
    assert!(!fetched.rows.is_empty());
    assert_eq!(written.len(), fetched.rows.len());
    for (row, source) in written.iter().zip(&fetched.rows) {
        assert_eq!((row.code.0.as_str(), &row.name, row.price, row.change_rate, &row.figures), (source.code.as_str(), &source.name, source.price, source.change_rate, &source.figures));
    }
}

#[tokio::test(start_paused = true)]
async fn a_job_started_after_a_reassignment_keeps_the_previous_value_when_its_first_run_fails() {
    let folder = tempfile::tempdir().unwrap();
    let clock = Clock::fake(ten_o_clock());
    let fake = FakeKiwoom::new(usize::MAX);
    let rest = kiwoom_rest(&fake, &clock);
    let options = json!({"variants": [trade_amount_variant(), gainers_variant()], "pages": 1});
    let first = loop_of(options.clone(), Slice::WHOLE, &[Broker::Kiwoom]);
    run_for(&first, Market::Kiwoom(&rest), "rest-01", folder.path(), &clock, &LoopStats::default(), 5).await;
    let before = merged_of(folder.path()).find(&default_rankings()[0], 1).map(|found| found.last.is_some());
    assert_eq!(before, Some(true));

    fake.fail("ka10027");
    let restarted = loop_of(options, Slice::WHOLE, &[Broker::Kiwoom]);
    run_for(&restarted, Market::Kiwoom(&rest), "rest-01", folder.path(), &clock, &LoopStats::default(), 5).await;
    let merged = merged_of(folder.path());
    let gainers = Ranking::Gainers { market: RankingMarket::Kospi, venue: Venue::Combined, include_limit: true, min_trade_amount: server::api::MinTradeAmount::Any, excludes: KEEP_ALL, exclude_managed: false };
    let found = merged.find(&gainers, 1).unwrap();
    assert!(matches!(found.state, ConditionState::Failed { .. }), "{:?}", found.state);
    assert!(found.last.is_some(), "새로 뜬 일도 파일의 이전 값을 이어받는다");
}
