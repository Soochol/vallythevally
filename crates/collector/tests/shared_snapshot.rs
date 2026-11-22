use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::protocol::KeyName;
use collector::shared::snapshot::SnapshotJob;
use collector::shared::{JobLoop, JobName, LoopStats, Market, SharedJob, Slice};
use collector::universe::{LISTING_FORMAT_VERSION, ListedStock, ListingFile, write_listing};
use domain::{KstDate, KstTime, Venue};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{DataKind, SharedData};
use tokio::time::{Instant, sleep};

const STOCKS: usize = 250;
const EVEN_ARE_ON_NXT: usize = STOCKS / 2;

fn day(date: u32) -> KstDate {
    KstDate::parse_yyyymmdd(&date.to_string()).unwrap()
}

fn at(date: u32, hour: u32, minute: u32, second: u32) -> KstTime {
    kst(day(date), hour, minute, second)
}

fn code_of(index: usize) -> String {
    format!("{}", 100_000 + index)
}

fn calls_for(count: usize) -> usize {
    count.div_ceil(100)
}

fn quote_row(stk_cd: &str, response_day: &str) -> Value {
    let suffix_at = stk_cd.find('_').unwrap_or(stk_cd.len());
    let number: u64 = stk_cd[..suffix_at].parse::<u64>().unwrap() - 100_000;
    json!({
        "stk_cd": stk_cd,
        "cur_prc": format!("+{}", 10_000 + number),
        "base_pric": "10000",
        "pred_pre_sig": "2",
        "trde_qty": format!("{}", 1_000 + number),
        "dt": response_day,
        "cntr_tm": "100000",
        "open_pric": "10001",
        "high_pric": "10500",
        "low_pric": "9900",
        "trde_prica": format!("{}", 500 + number),
    })
}

struct Call {
    at: Duration,
    api: String,
    stk_cd: Option<String>,
}

struct FakeKiwoom {
    origin: Instant,
    calls: Mutex<Vec<Call>>,
    failing: AtomicBool,
    blank_traded: AtomicBool,
    no_whole_index: AtomicBool,
    omitted: Mutex<HashSet<String>>,
}

impl FakeKiwoom {
    fn new() -> Arc<FakeKiwoom> {
        Arc::new(FakeKiwoom { origin: Instant::now(), calls: Mutex::default(), failing: AtomicBool::new(false), blank_traded: AtomicBool::new(false), no_whole_index: AtomicBool::new(false), omitted: Mutex::default() })
    }

    fn calls_of(&self, api: &str) -> Vec<(Duration, Option<String>)> {
        self.calls.lock().unwrap().iter().filter(|call| call.api == api).map(|call| (call.at, call.stk_cd.clone())).collect()
    }

    fn total(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    fn per_tick(&self) -> Vec<usize> {
        let mut buckets: Vec<usize> = Vec::new();
        for call in self.calls.lock().unwrap().iter() {
            let bucket = (call.at.as_secs() / 30) as usize;
            if buckets.len() <= bucket {
                buckets.resize(bucket + 1, 0);
            }
            buckets[bucket] += 1;
        }
        buckets
    }

    fn requested_codes(&self, suffix: &str) -> BTreeSet<String> {
        self.calls_of("ka10095")
            .into_iter()
            .flat_map(|(_, stk_cd)| stk_cd.unwrap().split('|').map(str::to_owned).collect::<Vec<_>>())
            .filter(|code| if suffix.is_empty() { !code.contains('_') } else { code.ends_with(suffix) })
            .map(|code| code.trim_end_matches(suffix).to_owned())
            .collect()
    }
}

fn reply(body: Value) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status: 200, next_key: None, body: body.to_string() })
}

impl Transport for FakeKiwoom {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let api = request.api_id.as_str().to_owned();
        if api == "au10001" {
            let answer = reply(json!({"token": "tok", "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}));
            return Box::pin(async move { answer });
        }
        let body: Value = serde_json::from_str(request.body.expose()).unwrap();
        let stk_cd = body["stk_cd"].as_str().map(str::to_owned);
        self.calls.lock().unwrap().push(Call { at: self.origin.elapsed(), api: api.clone(), stk_cd: stk_cd.clone() });
        let answer = if self.failing.load(Ordering::SeqCst) {
            Err(TransportError::refused())
        } else {
            match api.as_str() {
                "ka10095" => {
                    let omitted = self.omitted.lock().unwrap();
                    let rows: Vec<Value> = stk_cd.unwrap().split('|').filter(|code| !omitted.contains(code.split('_').next().unwrap())).map(|code| quote_row(code, "20261118")).map(|mut row| {
                        if self.blank_traded.load(Ordering::SeqCst) {
                            row["trde_prica"] = json!("");
                        }
                        row
                    }).collect();
                    reply(json!({"atn_stk_infr": rows, "return_code": 0, "return_msg": "정상"}))
                }
                "ka20003" => {
                    let whole = body["inds_cd"].as_str().unwrap();
                    let hidden = self.no_whole_index.load(Ordering::SeqCst);
                    reply(json!({"all_inds_idex": [
                        {"stk_cd": if hidden { "999" } else { whole }, "stk_nm": format!("종합{whole}"), "cur_prc": "-2650.12", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
                        {"stk_cd": "013", "stk_nm": "전기전자", "cur_prc": "+3100.50", "flu_rt": "+1.25", "trde_prica": "4000000"}
                    ], "return_code": 0, "return_msg": "정상"}))
                }
                other => panic!("모르는 TR {other}"),
            }
        };
        Box::pin(async move { answer })
    }
}

fn rest_of(fake: &Arc<FakeKiwoom>, clock: &Clock) -> KiwoomRest {
    let auth = KiwoomAuth::new(Secret::new("key".into()), Secret::new("secret".into()), None);
    KiwoomRest::with_send_spacing(fake.clone(), auth, clock.clone(), Duration::ZERO)
}

struct Folder {
    root: tempfile::TempDir,
}

impl Folder {
    fn with_listing(dates: &[u32]) -> Folder {
        let root = tempfile::tempdir().unwrap();
        let stocks: Vec<ListedStock> = (0..STOCKS).map(|index| ListedStock { code: code_of(index), nxt_enabled: index % 2 == 0 }).collect();
        for date in dates {
            write_listing(root.path(), &ListingFile { format_version: LISTING_FORMAT_VERSION, date: *date, fetched_at: "2026-11-18T07:20:00+09:00".into(), stocks: stocks.clone() }).unwrap();
        }
        Folder { root }
    }

    fn shared(&self) -> PathBuf {
        self.root.path().join("shared")
    }

    fn file(&self, kind: DataKind, date: u32) -> PathBuf {
        self.shared().join(kind.folder()).join(format!("{date}.json"))
    }

    fn dates_in(&self, kind: DataKind) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.shared().join(kind.folder())).map(|entries| entries.map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect()).unwrap_or_default();
        names.sort();
        names
    }
}

fn job_loop(job: &Arc<SnapshotJob>, date: u32, slice: Slice, options: Value) -> JobLoop {
    JobLoop { job: job.clone(), observation_date: day(date), period: Duration::from_secs(30), slice, options }
}

async fn run_for(job_loop: &JobLoop, rest: &KiwoomRest, key: &str, shared: &Path, clock: &Clock, stats: &LoopStats, seconds: u64) {
    let key = KeyName::parse(key).unwrap();
    tokio::select! {
        _ = job_loop.run(Market::Kiwoom(rest), &key, shared, clock, stats) => {}
        _ = sleep(Duration::from_secs(seconds)) => {}
    }
}

fn board_of(shared: &Path, venue: Venue) -> Arc<server::shared_data::Loaded<server::shared_data::SnapshotBody>> {
    let data = SharedData::new();
    data.snapshot(venue).poll(shared);
    data.snapshot(venue).current().expect("쓴 파일을 서버 읽기 함수가 읽는다")
}

#[tokio::test(start_paused = true)]
async fn at_ten_the_three_venues_and_two_indices_are_fetched_every_thirty_seconds_and_read_back_the_same() {
    let folder = Folder::with_listing(&[20261118]);
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let fake = FakeKiwoom::new();
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    run_for(&job_loop(&job, 20261118, Slice::WHOLE, Value::Null), &rest_of(&fake, &clock), "rest-01", &folder.shared(), &clock, &stats, 95).await;

    let expected_per_tick = calls_for(STOCKS) * 2 + calls_for(EVEN_ARE_ON_NXT) + 2;
    assert_eq!(fake.per_tick(), [expected_per_tick; 4], "10:00:00, :30, 11:00:00, :30에 한 판씩, 거래소 셋 기준 호출 수");
    assert!(fake.calls.lock().unwrap().iter().all(|call| call.at.as_secs() % 30 < 5), "판은 :00과 :30에 맞춰 시작한다");
    assert_eq!((fake.calls_of("ka10095").len(), fake.calls_of("ka20003").len()), (4 * (expected_per_tick - 2), 4 * 2));
    assert_eq!(fake.requested_codes("_AL").len(), STOCKS, "통합은 전 종목");
    assert_eq!(fake.requested_codes("").len(), STOCKS, "KRX는 전 종목");
    assert_eq!(fake.requested_codes("_NX"), (0..STOCKS).filter(|index| index % 2 == 0).map(code_of).collect::<BTreeSet<_>>(), "NXT는 NXT 거래 종목만");
    assert_eq!(stats.runs(), 4);
    assert_eq!(job.failures(), 0);

    for (venue, kind, count) in [(Venue::Krx, DataKind::SnapshotKrx, STOCKS), (Venue::Combined, DataKind::SnapshotCombined, STOCKS), (Venue::Nxt, DataKind::SnapshotNxt, EVEN_ARE_ON_NXT)] {
        let loaded = board_of(&folder.shared(), venue);
        assert_eq!((loaded.header.kind, loaded.header.observation_date.as_str(), loaded.header.format_version), (kind, "20261118", 1));
        assert!(loaded.header.as_of >= at(20261118, 10, 1, 30).unix(), "기준 시각은 마지막 판을 마친 때");
        assert_eq!((loaded.body.closing, loaded.body.requested, loaded.body.missing, loaded.body.stocks.len()), (false, count as u32, 0, count));
        assert_eq!(loaded.body.indices.iter().map(|index| index.code.as_str()).collect::<Vec<_>>(), ["001", "101"]);
    }
    let krx = board_of(&folder.shared(), Venue::Krx);
    let row = krx.body.stocks.iter().find(|row| row.code == "100010").unwrap();
    assert_eq!(
        (row.day.as_str(), row.current_won, row.base_won, row.open_won, row.high_won, row.low_won, row.volume, row.traded_million_won, row.traded_at),
        ("20261118", 10_010, 10_000, 10_001, 10_500, 9_900, 1_010, 510, Some(at(20261118, 10, 0, 0).unix())),
        "쓴 파일을 server::shared_data로 다시 읽으면 응답과 같은 값이다"
    );
    let kospi = &krx.body.indices[0];
    assert_eq!((kospi.name.as_str(), kospi.level, kospi.change_rate, kospi.trade_million_won), ("종합001", 2650.12, -0.67, 13_485_976));
    let nxt = board_of(&folder.shared(), Venue::Nxt);
    assert!(nxt.body.stocks.iter().all(|row| (row.code.parse::<usize>().unwrap() - 100_000) % 2 == 0));
}

#[tokio::test(start_paused = true)]
async fn two_keys_split_the_bundles_in_half_and_the_last_slice_writes_the_whole_file() {
    let folder = Folder::with_listing(&[20261118]);
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let (first, second) = (FakeKiwoom::new(), FakeKiwoom::new());
    let (job_first, job_second) = (Arc::new(SnapshotJob::default()), Arc::new(SnapshotJob::default()));
    let (stats_first, stats_second) = (LoopStats::default(), LoopStats::default());
    let (rest_first, rest_second) = (rest_of(&first, &clock), rest_of(&second, &clock));
    let (loop_first, loop_second) = (job_loop(&job_first, 20261118, Slice { index: 0, count: 2 }, Value::Null), job_loop(&job_second, 20261118, Slice { index: 1, count: 2 }, Value::Null));
    let shared = folder.shared();
    let (key_first, key_second) = (KeyName::parse("rest-01").unwrap(), KeyName::parse("rest-02").unwrap());
    tokio::select! {
        _ = async {
            tokio::join!(
                loop_first.run(Market::Kiwoom(&rest_first), &key_first, &shared, &clock, &stats_first),
                loop_second.run(Market::Kiwoom(&rest_second), &key_second, &shared, &clock, &stats_second),
            );
        } => {}
        _ = sleep(Duration::from_secs(35)) => {}
    }

    let whole_tick = calls_for(STOCKS) * 2 + calls_for(EVEN_ARE_ON_NXT) + 2;
    assert_eq!((first.per_tick(), second.per_tick()), (vec![whole_tick / 2; 2], vec![whole_tick / 2; 2]), "묶음이 반씩 나뉘어 두 키로 나간다");
    let (codes_first, codes_second) = (first.requested_codes("_AL"), second.requested_codes("_AL"));
    assert!(codes_first.is_disjoint(&codes_second), "한 묶음은 한 키만 부른다");
    assert_eq!(codes_first.union(&codes_second).count(), STOCKS);
    for kind in [DataKind::SnapshotKrx, DataKind::SnapshotCombined, DataKind::SnapshotNxt] {
        assert_eq!(folder.dates_in(kind), ["20261118.json"]);
    }
    let loaded = board_of(&shared, Venue::Combined);
    assert_eq!((loaded.body.stocks.len(), loaded.body.missing, loaded.body.indices.len()), (STOCKS, 0, 2), "두 조각이 한 판으로 합쳐진다");
    assert_eq!(loaded.header.sources.iter().map(|source| source.key_name.as_str()).collect::<Vec<_>>(), ["rest-01", "rest-02"]);
    assert_eq!(std::fs::read_dir(shared.join("snapshot-parts")).unwrap().count(), 2, "조각은 마지막 판 것만 남는다");
}

#[tokio::test(start_paused = true)]
async fn after_the_close_one_closing_fetch_stands_and_nothing_is_fetched_again_until_the_next_observation_day() {
    let folder = Folder::with_listing(&[20261118]);
    let clock = Clock::fake(at(20261118, 19, 59, 0));
    let fake = FakeKiwoom::new();
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    let rest = rest_of(&fake, &clock);
    let (wednesday, key, shared) = (job_loop(&job, 20261118, Slice::WHOLE, Value::Null), KeyName::parse("rest-01").unwrap(), folder.shared());
    tokio::time::timeout(Duration::from_secs(300), wednesday.run(Market::Kiwoom(&rest), &key, &shared, &clock, &stats)).await.expect("시간대가 닫히면 일이 끝난다");

    let per_tick = calls_for(STOCKS) * 2 + calls_for(EVEN_ARE_ON_NXT) + 2;
    assert_eq!(stats.runs(), 3, "19:59:00, 19:59:30, 20:00 뒤 한 번");
    assert_eq!(fake.total(), 3 * per_tick);
    let closing = board_of(&folder.shared(), Venue::Krx);
    assert!(closing.body.closing, "마지막 판은 마감 시세다");
    assert!(closing.header.as_of >= at(20261118, 20, 0, 30).unix(), "20:00 뒤에 받았다");
    let kept = std::fs::read(folder.file(DataKind::SnapshotKrx, 20261118)).unwrap();

    clock.jump(2 * 24 * 3600 + 14 * 3600);
    let saturday = KstTime::from_unix(clock.now().unix());
    assert_eq!(saturday.kst_date(), day(20261121));
    tokio::time::timeout(Duration::from_secs(60), wednesday.run(Market::Kiwoom(&rest), &key, &shared, &clock, &stats)).await.expect("닫힌 시간대는 바로 끝난다");
    sleep(Duration::from_secs(3600)).await;
    assert_eq!(fake.total(), 3 * per_tick, "휴장일·주말에는 호출 0이다");
    assert_eq!(std::fs::read(folder.file(DataKind::SnapshotKrx, 20261118)).unwrap(), kept, "마지막 판이 남는다");
    assert_eq!(job.failures(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_failed_bundle_keeps_the_previous_file_and_counts_and_the_next_observation_day_replaces_the_old_files() {
    let folder = Folder::with_listing(&[20261118]);
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let fake = FakeKiwoom::new();
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    let rest = rest_of(&fake, &clock);
    run_for(&job_loop(&job, 20261118, Slice::WHOLE, Value::Null), &rest, "rest-01", &folder.shared(), &clock, &stats, 5).await;
    let previous: Vec<Vec<u8>> = [DataKind::SnapshotKrx, DataKind::SnapshotCombined, DataKind::SnapshotNxt].iter().map(|kind| std::fs::read(folder.file(*kind, 20261118)).unwrap()).collect();
    assert_eq!(job.failures(), 0);

    clock.jump(23 * 3600);
    fake.failing.store(true, Ordering::SeqCst);
    let thursday = job_loop(&job, 20261119, Slice::WHOLE, Value::Null);
    run_for(&thursday, &rest, "rest-01", &folder.shared(), &clock, &stats, 50).await;
    assert!(job.failures() >= 1, "묶음이 실패하면 실패 수가 는다");
    assert!(stats.last_error().is_some_and(|error| error.contains("이 판을 쓰지 않습니다")), "{:?}", stats.last_error());
    for (kind, before) in [DataKind::SnapshotKrx, DataKind::SnapshotCombined, DataKind::SnapshotNxt].iter().zip(&previous) {
        assert_eq!(&std::fs::read(folder.file(*kind, 20261118)).unwrap(), before, "이전 판이 그대로다");
        assert_eq!(folder.dates_in(*kind), ["20261118.json"], "새 관측일 파일은 아직 없다");
    }

    fake.failing.store(false, Ordering::SeqCst);
    run_for(&thursday, &rest, "rest-01", &folder.shared(), &clock, &stats, 120).await;
    assert_eq!(stats.last_error(), None, "키움이 다시 받으면 판이 다시 써진다");
    for kind in [DataKind::SnapshotKrx, DataKind::SnapshotCombined, DataKind::SnapshotNxt] {
        assert_eq!(folder.dates_in(kind), ["20261119.json"], "새 관측일 첫 판 뒤 지난 판 파일이 지워진다");
    }
    assert_eq!(board_of(&folder.shared(), Venue::Krx).header.observation_date, "20261119");
}

#[tokio::test(start_paused = true)]
async fn rows_missing_from_a_good_response_are_counted_in_the_file() {
    let folder = Folder::with_listing(&[20261118]);
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let fake = FakeKiwoom::new();
    fake.omitted.lock().unwrap().extend([code_of(4), code_of(5)]);
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    run_for(&job_loop(&job, 20261118, Slice::WHOLE, Value::Null), &rest_of(&fake, &clock), "rest-01", &folder.shared(), &clock, &stats, 5).await;
    assert_eq!(job.failures(), 0, "정상 응답에서 빠진 종목은 실패가 아니다");
    let missing = |venue| {
        let loaded = board_of(&folder.shared(), venue);
        (loaded.body.requested, loaded.body.missing, loaded.body.stocks.len() as u32)
    };
    assert_eq!(missing(Venue::Krx), (250, 2, 248));
    assert_eq!(missing(Venue::Combined), (250, 2, 248));
    assert_eq!(missing(Venue::Nxt), (125, 1, 124), "NXT는 짝수 번호만 받는다. 4번만 빠진다");
}

#[tokio::test(start_paused = true)]
async fn the_venue_option_picks_the_files_and_the_calls_and_a_missing_listing_is_an_error_without_calls() {
    let job = SnapshotJob::default();
    for good in [Value::Null, json!({}), json!({"venues": ["krx"]}), json!({"venues": ["nxt", "combined"]})] {
        assert!(job.check_options(&good).is_ok(), "{good}");
    }
    for bad in [json!({"venues": []}), json!({"venues": ["krx", "krx"]}), json!({"venues": ["kospi"]}), json!({"venue": ["krx"]}), json!(5)] {
        assert!(job.check_options(&bad).is_err(), "{bad}");
    }
    assert_eq!(JobName::Snapshot.job().window().start, domain::TimeOfDay::hms(8, 0, 0).unwrap());

    let folder = Folder::with_listing(&[20261118]);
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let fake = FakeKiwoom::new();
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    run_for(&job_loop(&job, 20261118, Slice::WHOLE, json!({"venues": ["krx"]})), &rest_of(&fake, &clock), "rest-01", &folder.shared(), &clock, &stats, 5).await;
    assert_eq!(fake.per_tick(), [calls_for(STOCKS) + 2]);
    assert_eq!(folder.dates_in(DataKind::SnapshotKrx), ["20261118.json"]);
    assert!(!folder.shared().join(DataKind::SnapshotCombined.folder()).exists() && !folder.shared().join(DataKind::SnapshotNxt.folder()).exists());

    let empty = Folder::with_listing(&[]);
    let fresh_clock = Clock::fake(at(20261118, 11, 0, 0));
    let (lonely, lonely_stats, lonely_fake) = (Arc::new(SnapshotJob::default()), LoopStats::default(), FakeKiwoom::new());
    run_for(&job_loop(&lonely, 20261118, Slice::WHOLE, Value::Null), &rest_of(&lonely_fake, &fresh_clock), "rest-01", &empty.shared(), &fresh_clock, &lonely_stats, 5).await;
    assert_eq!(lonely_fake.total(), 0, "종목 목록이 없으면 부르지 않는다");
    assert!(lonely_stats.last_error().is_some_and(|error| error.contains("전체 종목 행 파일이 없습니다")), "{:?}", lonely_stats.last_error());
    assert_eq!(lonely.failures(), 1);
}

fn files_of(folder: &Folder) -> Vec<Vec<u8>> {
    [DataKind::SnapshotKrx, DataKind::SnapshotCombined, DataKind::SnapshotNxt].iter().map(|kind| std::fs::read(folder.file(*kind, 20261118)).unwrap()).collect()
}

#[tokio::test(start_paused = true)]
async fn a_response_with_no_readable_row_or_no_whole_index_row_fails_the_tick_and_keeps_the_previous_file() {
    let folder = Folder::with_listing(&[20261118]);
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let fake = FakeKiwoom::new();
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    let rest = rest_of(&fake, &clock);
    let looping = job_loop(&job, 20261118, Slice::WHOLE, Value::Null);
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 5).await;
    let previous = files_of(&folder);
    let as_of = board_of(&folder.shared(), Venue::Krx).header.as_of;
    assert_eq!(job.failures(), 0);

    fake.blank_traded.store(true, Ordering::SeqCst);
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 30).await;
    assert_eq!(job.failures(), 1, "읽히는 행이 하나도 없는 응답은 실패로 센다");
    assert!(stats.last_error().is_some_and(|error| error.contains("읽히는 행이 하나도 없습니다")), "{:?}", stats.last_error());
    assert_eq!(files_of(&folder), previous, "빈 판이 이전 판을 덮지 않는다");
    assert_eq!(board_of(&folder.shared(), Venue::Krx).header.as_of, as_of, "받은 시각이 그대로라 서버가 낡음을 안다");

    fake.blank_traded.store(false, Ordering::SeqCst);
    fake.no_whole_index.store(true, Ordering::SeqCst);
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 30).await;
    assert_eq!(job.failures(), 2, "종합지수 행이 없는 응답도 실패로 센다");
    assert!(stats.last_error().is_some_and(|error| error.contains("종합지수")), "{:?}", stats.last_error());
    assert_eq!(files_of(&folder), previous);
}

#[tokio::test(start_paused = true)]
async fn a_listing_of_the_day_that_appears_after_a_fallback_replaces_the_earlier_days_list_from_the_next_tick() {
    let folder = Folder::with_listing(&[20261117]);
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let fake = FakeKiwoom::new();
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    let rest = rest_of(&fake, &clock);
    let looping = job_loop(&job, 20261118, Slice::WHOLE, Value::Null);
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 5).await;
    assert_eq!(board_of(&folder.shared(), Venue::Krx).body.requested, STOCKS as u32, "그날 목록이 없으면 이전 날 것으로 돈다");

    let today: Vec<ListedStock> = (0..STOCKS + 10).map(|index| ListedStock { code: code_of(index), nxt_enabled: index % 2 == 0 }).collect();
    write_listing(folder.root.path(), &ListingFile { format_version: LISTING_FORMAT_VERSION, date: 20261118, fetched_at: "2026-11-18T10:00:10+09:00".into(), stocks: today }).unwrap();
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 60).await;
    let krx = board_of(&folder.shared(), Venue::Krx);
    assert_eq!((krx.body.requested, krx.body.stocks.len()), (STOCKS as u32 + 10, STOCKS + 10), "그날 목록이 생기면 신규 종목도 받는다");

    let calls_before = fake.total();
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 30).await;
    assert!(fake.total() > calls_before && job.failures() == 0, "그날 목록은 캐시되어 계속 돈다");
}

#[tokio::test(start_paused = true)]
async fn one_omitted_stock_of_a_tiny_venue_is_missing_not_a_failed_tick_and_a_broken_listing_keeps_the_cached_one() {
    let folder = Folder::with_listing(&[20261117]);
    let stocks: Vec<ListedStock> = (0..STOCKS).map(|index| ListedStock { code: code_of(index), nxt_enabled: index == 0 }).collect();
    write_listing(folder.root.path(), &ListingFile { format_version: LISTING_FORMAT_VERSION, date: 20261117, fetched_at: "x".into(), stocks }).unwrap();
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let fake = FakeKiwoom::new();
    fake.omitted.lock().unwrap().insert(code_of(0));
    let (job, stats) = (Arc::new(SnapshotJob::default()), LoopStats::default());
    let rest = rest_of(&fake, &clock);
    let looping = job_loop(&job, 20261118, Slice::WHOLE, Value::Null);
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 5).await;
    assert_eq!(job.failures(), 0, "NXT에 한 종목뿐이고 그 행이 빠져도 판은 써진다");
    let nxt = board_of(&folder.shared(), Venue::Nxt);
    assert_eq!((nxt.body.requested, nxt.body.missing, nxt.body.stocks.len()), (1, 1, 0));
    assert_eq!(board_of(&folder.shared(), Venue::Krx).body.stocks.len(), STOCKS - 1);

    std::fs::write(folder.root.path().join("listing").join("20261118.json"), "{broken").unwrap();
    run_for(&looping, &rest, "rest-01", &folder.shared(), &clock, &stats, 60).await;
    assert_eq!(job.failures(), 0, "그날 목록 파일이 깨져도 이미 읽은 목록으로 계속 돈다: {:?}", stats.last_error());
}

#[tokio::test(start_paused = true)]
async fn with_two_keys_a_key_whose_share_is_one_omitted_stock_does_not_fail_the_tick() {
    let folder = Folder::with_listing(&[]);
    let stocks: Vec<ListedStock> = (0..101).map(|index| ListedStock { code: code_of(index), nxt_enabled: false }).collect();
    write_listing(folder.root.path(), &ListingFile { format_version: LISTING_FORMAT_VERSION, date: 20261118, fetched_at: "x".into(), stocks }).unwrap();
    let clock = Clock::fake(at(20261118, 10, 0, 0));
    let (first, second) = (FakeKiwoom::new(), FakeKiwoom::new());
    for fake in [&first, &second] {
        fake.omitted.lock().unwrap().insert(code_of(100));
    }
    let (job_first, job_second) = (Arc::new(SnapshotJob::default()), Arc::new(SnapshotJob::default()));
    let (stats_first, stats_second) = (LoopStats::default(), LoopStats::default());
    let (rest_first, rest_second) = (rest_of(&first, &clock), rest_of(&second, &clock));
    let (loop_first, loop_second) = (job_loop(&job_first, 20261118, Slice { index: 0, count: 2 }, Value::Null), job_loop(&job_second, 20261118, Slice { index: 1, count: 2 }, Value::Null));
    let shared = folder.shared();
    let (key_first, key_second) = (KeyName::parse("rest-01").unwrap(), KeyName::parse("rest-02").unwrap());
    tokio::select! {
        _ = async {
            tokio::join!(
                loop_first.run(Market::Kiwoom(&rest_first), &key_first, &shared, &clock, &stats_first),
                loop_second.run(Market::Kiwoom(&rest_second), &key_second, &shared, &clock, &stats_second),
            );
        } => {}
        _ = sleep(Duration::from_secs(5)) => {}
    }
    assert_eq!((job_first.failures(), job_second.failures()), (0, 0), "{:?} {:?}", stats_first.last_error(), stats_second.last_error());
    let krx = board_of(&shared, Venue::Krx);
    assert_eq!((krx.body.requested, krx.body.missing, krx.body.stocks.len()), (101, 1, 100));
}
