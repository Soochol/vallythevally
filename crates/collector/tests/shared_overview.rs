use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use collector::protocol::KeyName;
use collector::shared::{JobCall, JobName, Market, SharedJob, Slice};
use collector::universe::{ListedStock, ListingFile, write_listing};
use domain::{KstDate, KstTime, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::Market as ApiMarket;
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::{KisCredentials, Secret};
use server::db::AppDb;
use server::http::router;
use server::kis::auth::KisAuth;
use server::kis::rest::KisRest;
use server::kis::token_file::{Saved, SavedToken, TokenFile, credential_id};
use server::kis::transport::{HttpRequest as KisRequest, HttpResponse as KisResponse, Transport as KisTransport, TransportError as KisTransportError};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{Board, Broker, DataKind, OverviewBody};
use server::symbols::{Directory, SymbolDirectory};
use tokio::time::sleep;
use tower::ServiceExt;

const KIS_APP_KEY: &str = "FAKE-KIS-APPKEY-shared-overview";
const KIS_APP_SECRET: &str = "FAKE-KIS-SECRET-shared-overview";

fn monday() -> KstDate {
    KstDate::new(2026, 11, 9).unwrap()
}

fn at(day: KstDate, h: u32, m: u32, s: u32) -> KstTime {
    kst(day, h, m, s)
}

fn all_indices(whole: (&str, &str)) -> Value {
    json!({"all_inds_idex": [
        {"stk_cd": whole.0, "stk_nm": whole.1, "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
        {"stk_cd": "013", "stk_nm": "전기전자", "cur_prc": "+3100.50", "flu_rt": "+1.25", "trde_prica": "4000000"},
        {"stk_cd": "603", "stk_nm": "VKOSPI", "cur_prc": "+17.20", "flu_rt": "+1.50", "trde_prica": "0"}
    ], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn sector_flows(base_day: &str, whole_code: &str) -> Value {
    let number = base_day.parse::<i64>().unwrap() % 1000;
    let row = |code: &str, name: &str, individual: i64| json!({"inds_cd": code, "inds_nm": name, "cur_prc": "+658091", "flu_rt": "349", "ind_netprps": individual.to_string(), "frgnr_netprps": "+6473", "orgn_netprps": "+1893"});
    json!({"inds_netprps": [row(&format!("{whole_code}_AL"), "종합", number), row("013_AL", "전기전자", -number)], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn program_minutes() -> Value {
    let rows: Vec<_> = [("103905", "+345603"), ("103859", "+342625")].iter().map(|(time, total)| json!({"cntr_tm": time, "dfrt_trde_netprps": "+20885", "ndiffpro_trde_netprps": "+324718", "all_netprps": total})).collect();
    json!({"prm_trde_trnsn": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn program_days() -> Value {
    let rows: Vec<_> = [("20261109", "900"), ("20261106", "800"), ("20261105", "700"), ("20261104", "600"), ("20261103", "500"), ("20261102", "400")]
        .iter()
        .map(|(day, total)| json!({"cntr_tm": format!("{day}000000"), "dfrt_trde_netprps": "100", "ndiffpro_trde_netprps": "--250", "all_netprps": total}))
        .collect();
    json!({"prm_trde_trnsn": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn index_days() -> Value {
    let rows: Vec<_> = [("20261109", "30000000"), ("20261106", "20000000"), ("20261105", "10000000"), ("20261104", "9000000"), ("20261103", "8000000"), ("20261102", "7000000")]
        .iter()
        .map(|(day, traded)| json!({"dt": day, "cur_prc": "505969", "open_pric": "505969", "high_pric": "505969", "low_pric": "505969", "trde_qty": "1", "trde_prica": traded}))
        .collect();
    json!({"inds_dt_pole_qry": rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn streaks() -> Value {
    let row = |code: &str, name: &str, foreign_days: &str, institution_days: &str| {
        json!({
            "stk_cd": code, "stk_nm": name, "frgnr_cont_netprps_dys": foreign_days, "frgnr_cont_netprps_qty": foreign_days, "frgnr_cont_netprps_amt": "--940483",
            "orgn_cont_netprps_dys": institution_days, "orgn_cont_netprps_qty": "55", "orgn_cont_netprps_amt": "1000", "prid_stkpc_flu_rt": "-1.25"
        })
    };
    json!({"orgn_frgnr_cont_trde_prst": [row("005930_AL", "삼성전자", "-2", "7"), row("069500", "KODEX 200", "-9", "9"), row("000660", "SK하이닉스", "3", "-4")], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn kiwoom_reply(api_id: &str, body: &Value) -> Value {
    let kosdaq = body.get("mrkt_tp").and_then(Value::as_str) == Some("1");
    match api_id {
        "au10001" => json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}),
        "ka20003" if kosdaq => all_indices(("101", "종합(KOSDAQ)")),
        "ka20003" => all_indices(("001", "종합(KOSPI)")),
        "ka10051" => sector_flows(body["base_dt"].as_str().unwrap(), if kosdaq { "101" } else { "001" }),
        "ka90005" => program_minutes(),
        "ka90010" => program_days(),
        "ka20006" => index_days(),
        "ka10131" => streaks(),
        other => panic!("시험이 정하지 않은 요청: {other}"),
    }
}

#[derive(Clone, Default)]
struct FakeKiwoom {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
}

impl FakeKiwoom {
    fn rest(&self, clock: &Clock) -> KiwoomRest {
        let rest = KiwoomRest::new(Arc::new(self.clone()), KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None), clock.clone());
        rest.set_access(Access::Open);
        rest
    }

    fn counts(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for (api_id, _) in self.calls.lock().unwrap().iter().filter(|(api_id, _)| api_id != "au10001") {
            *counts.entry(api_id.clone()).or_insert(0) += 1;
        }
        counts
    }

    fn days_asked(&self, api_id: &str) -> BTreeSet<String> {
        self.calls.lock().unwrap().iter().filter(|(id, _)| id == api_id).map(|(_, body)| body["base_dt"].as_str().unwrap().to_owned()).collect()
    }

    fn forget(&self) {
        self.calls.lock().unwrap().clear();
    }

    fn total(&self) -> usize {
        self.calls.lock().unwrap().iter().filter(|(api_id, _)| api_id != "au10001").count()
    }
}

impl Transport for FakeKiwoom {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let body: Value = serde_json::from_str(request.body.expose()).unwrap_or(Value::Null);
        let api_id = request.api_id.as_str().to_owned();
        let response = HttpResponse { status: 200, next_key: None, body: kiwoom_reply(&api_id, &body).to_string() };
        self.calls.lock().unwrap().push((api_id, body));
        Box::pin(async move { Ok(response) })
    }
}

#[derive(Clone, Default)]
struct FakeKis {
    paths: Arc<Mutex<Vec<&'static str>>>,
}

impl KisTransport for FakeKis {
    fn send(&self, request: KisRequest) -> BoxFuture<'static, Result<KisResponse, KisTransportError>> {
        self.paths.lock().unwrap().push(request.path);
        let response = KisResponse { status: 200, tr_cont: None, body: json!({"rt_cd": "1", "msg_cd": "EGW00000", "msg1": "시험용 거절"}).to_string() };
        Box::pin(async move { Ok(response) })
    }
}

fn kis_rest(fake: &FakeKis, clock: &Clock, folder: &Path) -> KisRest {
    let token_path = folder.join("state/kis-token.json");
    let now = clock.now();
    TokenFile::new(token_path.clone())
        .save(&Saved { credential: Some(credential_id(KIS_APP_KEY)), token: Some(SavedToken { value: "FAKE-KIS-TOKEN".into(), expires_at: now.unix() + 86_400, issued_at: now.unix() - 3600 }), last_request_at: now.unix() - 3600, disconnected: None })
        .unwrap();
    let transport: Arc<dyn KisTransport> = Arc::new(fake.clone());
    KisRest::new(transport.clone(), KisAuth::new(KisCredentials { app_key: Secret::new(KIS_APP_KEY.into()), app_secret: Secret::new(KIS_APP_SECRET.into()) }, token_path, transport, clock.clone()))
}

struct Folders {
    data: tempfile::TempDir,
}

impl Folders {
    fn new() -> Folders {
        let folders = Folders { data: tempfile::tempdir().unwrap() };
        std::fs::create_dir_all(folders.shared()).unwrap();
        let listing = ListingFile { format_version: collector::universe::LISTING_FORMAT_VERSION, date: 20261109, fetched_at: "2026-11-09T07:20:00+09:00".into(), stocks: [("005930", false), ("000660", false), ("069500", true)].iter().map(|(code, etf)| ListedStock { code: (*code).to_owned(), nxt_enabled: true, exchange_traded: *etf }).collect() };
        write_listing(folders.data.path(), &listing).unwrap();
        folders
    }

    fn shared(&self) -> PathBuf {
        self.data.path().join("shared")
    }
}

fn key(name: &str) -> KeyName {
    KeyName::parse(name).unwrap()
}

struct Seat<'a> {
    shared: &'a Path,
    day: KstDate,
    clock: &'a Clock,
    slice: Slice,
    peers: &'a [Broker],
    key: &'a KeyName,
}

async fn run_once(job: &dyn SharedJob, market: Market<'_>, seat: Seat<'_>) -> Result<(), collector::shared::JobError> {
    job.run(JobCall { observation_date: seat.day, slice: seat.slice, peers: seat.peers, market, shared_dir: seat.shared, key: seat.key, clock: seat.clock, options: &Value::Null }).await
}

fn overview_file(shared: &Path) -> Option<(server::shared_data::Header, OverviewBody)> {
    let board = Board::<OverviewBody>::new(DataKind::MarketOverview);
    board.poll(shared);
    board.current().map(|loaded| (loaded.header.clone(), loaded.body.clone()))
}

fn without_received_at(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("receivedAt");
            map.values_mut().for_each(without_received_at);
        }
        Value::Array(items) => items.iter_mut().for_each(without_received_at),
        _ => {}
    }
}

struct Server {
    app: Router,
    _dir: tempfile::TempDir,
}

impl Server {
    async fn start(fake: &FakeKiwoom, clock: &Clock) -> Server {
        let rest = fake.rest(clock);
        let symbols = Arc::new(SymbolDirectory::default());
        let listed = |code: &str, name: &str, kind: SymbolKind| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind, market: domain::Market::Kospi, nxt_enabled: true };
        symbols.replace(Directory::build(vec![listed("005930", "삼성전자", SymbolKind::Common), listed("000660", "SK하이닉스", SymbolKind::Common), listed("069500", "KODEX 200", SymbolKind::Etf)]));
        let dir = tempfile::tempdir().unwrap();
        let db = AppDb::open(&dir.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: dir.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        Server { app: router(state), _dir: dir }
    }

    async fn get(&self, path: &str) -> Value {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status().as_u16(), 200, "{path}");
        let mut body: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        without_received_at(&mut body);
        body
    }
}

fn as_json<T: serde::Serialize>(card: &T) -> Value {
    let mut value = serde_json::to_value(card).unwrap();
    without_received_at(&mut value);
    value
}

#[tokio::test(start_paused = true)]
async fn a_minute_asks_each_card_once_and_past_days_are_kept_until_0745() {
    let folders = Folders::new();
    let clock = Clock::fake(at(monday(), 10, 0, 0));
    let kiwoom = FakeKiwoom::default();
    let rest = kiwoom.rest(&clock);
    let job = JobName::Overview.job();
    let name = key("rest-01");
    let shared = folders.shared();
    let tick = |day: KstDate| run_once(job.as_ref(), Market::Kiwoom(&rest), Seat { shared: &shared, day, clock: &clock, slice: Slice::WHOLE, peers: &[Broker::Kiwoom], key: &name });

    tick(monday()).await.unwrap();
    let first = kiwoom.counts();
    assert_eq!(first["ka10131"], 4, "연속 매매는 시장마다 매수·매도 한 번씩이다");
    let first_flow_days = kiwoom.days_asked("ka10051");
    assert!(first_flow_days.contains("20261103") && first_flow_days.contains("20261109"), "{first_flow_days:?}");

    kiwoom.forget();
    clock.jump(60);
    tick(monday()).await.unwrap();
    let second = kiwoom.counts();
    for api_id in ["ka20003", "ka20006", "ka90010", "ka10131"] {
        assert_eq!(second[api_id], first[api_id], "{api_id}: 둘째 번도 같은 호출 수다");
    }
    assert!(second["ka10051"] < first["ka10051"], "지난 거래일 투자자 값은 다시 받지 않는다: {first:?} {second:?}");
    assert_eq!(kiwoom.days_asked("ka10051"), BTreeSet::from(["20261109".to_owned()]), "오늘 값만 다시 받는다");

    kiwoom.forget();
    let tuesday = monday().add_days(1);
    clock.jump(at(tuesday, 7, 50, 0).unix() - clock.now().unix());
    tick(tuesday).await.unwrap();
    assert!(kiwoom.days_asked("ka10051").contains("20261103"), "07:45가 지나면 지난 거래일 값을 다시 받는다");
}

#[tokio::test]
async fn the_cards_in_the_file_equal_what_the_server_routes_answer_for_the_same_replies() {
    let folders = Folders::new();
    let clock = Clock::fake(at(monday(), 10, 0, 0));
    let (collector_side, server_side) = (FakeKiwoom::default(), FakeKiwoom::default());
    let rest = collector_side.rest(&clock);
    let job = JobName::Overview.job();
    let server = Server::start(&server_side, &clock).await;
    tokio::time::pause();
    run_once(job.as_ref(), Market::Kiwoom(&rest), Seat { shared: &folders.shared(), day: monday(), clock: &clock, slice: Slice::WHOLE, peers: &[Broker::Kiwoom], key: &key("rest-01") }).await.unwrap();
    let (header, body) = overview_file(&folders.shared()).expect("시장 개요 파일");
    assert_eq!((header.observation_date.as_str(), header.sources.len()), ("20261109", 1));
    for (market, name) in [(ApiMarket::Kospi, "kospi"), (ApiMarket::Kosdaq, "kosdaq")] {
        let cards = body.market(market);
        assert_eq!(as_json(cards.index.as_ref().unwrap()), server.get(&format!("/api/market-overview/index?market={name}")).await, "{name} index");
        assert_eq!(as_json(cards.sectors.as_ref().unwrap()), server.get(&format!("/api/market-overview/sectors?market={name}")).await, "{name} sectors");
        assert_eq!(as_json(cards.streaks.as_ref().unwrap()), server.get(&format!("/api/market-overview/streaks?market={name}")).await, "{name} streaks");
        for (period, card_flow, card_turnover) in cards.flow.iter().zip(&cards.turnover).map(|(flow, turnover)| (flow.period.days(), flow, turnover)) {
            assert_eq!(as_json(card_flow), server.get(&format!("/api/market-overview/flow?market={name}&period={period}")).await, "{name} flow {period}");
            assert_eq!(as_json(card_turnover), server.get(&format!("/api/market-overview/turnover?market={name}&period={period}")).await, "{name} turnover {period}");
        }
        assert_eq!(cards.flow.len(), 3);
        assert_eq!(cards.turnover.len(), 3);
    }
}

#[tokio::test(start_paused = true)]
async fn a_kis_first_key_hands_the_streak_cards_to_the_next_key_and_without_one_the_card_fails() {
    let folders = Folders::new();
    let clock = Clock::fake(at(monday(), 10, 0, 0));
    let (kiwoom, kis) = (FakeKiwoom::default(), FakeKis::default());
    let (kiwoom_rest, kis_rest) = (kiwoom.rest(&clock), kis_rest(&kis, &clock, folders.data.path()));
    let peers = [Broker::Kis, Broker::Kiwoom];
    let (kis_job, kiwoom_job) = (JobName::Overview.job(), JobName::Overview.job());
    run_once(kis_job.as_ref(), Market::Kis(Some(&kis_rest)), Seat { shared: &folders.shared(), day: monday(), clock: &clock, slice: Slice { index: 0, count: 2 }, peers: &peers, key: &key("rest-kis") }).await.unwrap();
    run_once(kiwoom_job.as_ref(), Market::Kiwoom(&kiwoom_rest), Seat { shared: &folders.shared(), day: monday(), clock: &clock, slice: Slice { index: 1, count: 2 }, peers: &peers, key: &key("rest-01") }).await.unwrap();
    let (header, body) = overview_file(&folders.shared()).unwrap();
    assert_eq!(header.sources.iter().map(|source| (source.key_name.as_str(), source.broker)).collect::<Vec<_>>(), [("rest-01", Broker::Kiwoom), ("rest-kis", Broker::Kis)]);
    let source_of = |value: &Value| value["context"]["source"].as_str().unwrap().to_owned();
    for market in [ApiMarket::Kospi, ApiMarket::Kosdaq] {
        let cards = body.market(market);
        assert_eq!(source_of(&as_json(cards.streaks.as_ref().unwrap())), "kiwoom", "연속 매매 칸은 키움 키로 나간다");
        assert_eq!(as_json(cards.streaks.as_ref().unwrap())["buying"]["status"], "ok");
        assert_eq!(cards.flow.len() + cards.turnover.len(), 6);
    }
    assert_eq!(source_of(&as_json(body.kospi.index.as_ref().unwrap())), "kis", "한투가 받는 칸은 한투 키가 만든다");
    assert_eq!(kiwoom.counts()["ka10131"], 4);
    assert!(!kis.paths.lock().unwrap().is_empty());

    let alone = Folders::new();
    run_once(kis_job.as_ref(), Market::Kis(Some(&kis_rest)), Seat { shared: &alone.shared(), day: monday(), clock: &clock, slice: Slice::WHOLE, peers: &[Broker::Kis], key: &key("rest-kis") }).await.unwrap();
    let (_, body) = overview_file(&alone.shared()).unwrap();
    let streaks = as_json(body.kospi.streaks.as_ref().unwrap());
    assert_eq!((streaks["buying"]["status"].as_str(), streaks["buying"]["error"]["reason"].as_str(), streaks["context"]["source"].as_str()), (Some("failed"), Some("unsupported_by_source"), Some("kis")), "키움 키가 없으면 그 칸은 실패 표시다");
}

fn samples_file(shared: &Path, day: &str) -> Vec<Value> {
    std::fs::read_to_string(shared.join("market-samples").join(format!("{day}.jsonl"))).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

#[tokio::test(start_paused = true)]
async fn samples_are_four_per_regular_minute_once_resume_after_a_restart_and_old_files_go() {
    let folders = Folders::new();
    let shared = folders.shared();
    std::fs::create_dir_all(shared.join("market-samples")).unwrap();
    std::fs::write(shared.join("market-samples/20261106.jsonl"), "{}\n").unwrap();
    let clock = Clock::fake(at(monday(), 8, 59, 0));
    let kiwoom = FakeKiwoom::default();
    let rest = kiwoom.rest(&clock);
    let name = key("rest-01");
    let job = JobName::IntradaySamples.job();
    let window = job.window();
    assert_eq!((window.start, window.end), (TimeOfDay::hms(9, 0, 0).unwrap(), TimeOfDay::hms(15, 31, 0).unwrap()));
    let tick = |job: Arc<dyn SharedJob>| {
        let (rest, shared, clock, name) = (&rest, &shared, &clock, &name);
        async move { run_once(job.as_ref(), Market::Kiwoom(rest), Seat { shared, day: monday(), clock, slice: Slice::WHOLE, peers: &[Broker::Kiwoom], key: name }).await }
    };

    tick(job.clone()).await.unwrap();
    assert_eq!(kiwoom.total(), 0, "정규장 전에는 받지 않는다");
    assert!(!shared.join("market-samples/20261106.jsonl").exists(), "07:45 지난 날 파일은 지운다");

    clock.jump(60);
    tick(job.clone()).await.unwrap();
    assert_eq!(kiwoom.counts(), BTreeMap::from([("ka10051".to_owned(), 2), ("ka90005".to_owned(), 2)]), "분마다 4건");
    let lines = samples_file(&shared, "20261109");
    assert_eq!(lines.len(), 4);
    assert_eq!(lines.iter().map(|line| (line["market"].as_str().unwrap(), line["value"]["kind"].as_str().unwrap())).collect::<BTreeSet<_>>().len(), 4);
    assert!(lines.iter().all(|line| line["at"] == json!(at(monday(), 9, 0, 0).unix())));

    clock.jump(20);
    tick(job.clone()).await.unwrap();
    assert_eq!(samples_file(&shared, "20261109").len(), 4, "같은 분·시장·종류는 한 번만 쌓는다");

    let restarted = JobName::IntradaySamples.job();
    tick(restarted.clone()).await.unwrap();
    assert_eq!(samples_file(&shared, "20261109").len(), 4, "다시 떠도 그날 파일에서 이어 쌓아 겹치지 않는다");
    clock.jump(40);
    tick(restarted.clone()).await.unwrap();
    assert_eq!(samples_file(&shared, "20261109").len(), 8, "다음 분은 이어서 쌓는다");

    let tuesday = monday().add_days(1);
    clock.jump(at(tuesday, 9, 0, 0).unix() - clock.now().unix());
    run_once(job.as_ref(), Market::Kiwoom(&rest), Seat { shared: &shared, day: tuesday, clock: &clock, slice: Slice::WHOLE, peers: &[Broker::Kiwoom], key: &name }).await.unwrap();
    assert!(!shared.join("market-samples/20261109.jsonl").exists(), "관측일이 바뀌면 지난 날 파일을 지운다");
    assert_eq!(samples_file(&shared, "20261110").len(), 4);
    sleep(Duration::from_millis(1)).await;
}

#[tokio::test(start_paused = true)]
async fn a_key_that_went_down_no_longer_pins_the_as_of_or_the_sources() {
    let folders = Folders::new();
    let clock = Clock::fake(at(monday(), 10, 0, 0));
    let kiwoom = FakeKiwoom::default();
    let rest = kiwoom.rest(&clock);
    let job = JobName::Overview.job();
    let peers = [Broker::Kiwoom, Broker::Kiwoom];
    run_once(job.as_ref(), Market::Kiwoom(&rest), Seat { shared: &folders.shared(), day: monday(), clock: &clock, slice: Slice { index: 1, count: 2 }, peers: &peers, key: &key("rest-02") }).await.unwrap();
    clock.jump(600);
    let before = clock.now().unix();
    run_once(job.as_ref(), Market::Kiwoom(&rest), Seat { shared: &folders.shared(), day: monday(), clock: &clock, slice: Slice::WHOLE, peers: &[Broker::Kiwoom], key: &key("rest-01") }).await.unwrap();
    let (header, body) = overview_file(&folders.shared()).unwrap();
    assert!((before..=clock.now().unix()).contains(&header.as_of), "모든 칸을 새로 만든 키가 하나면 기준 시각은 그 틱이다: {}", header.as_of);
    assert_eq!(header.sources.iter().map(|source| source.key_name.as_str()).collect::<Vec<_>>(), ["rest-01"]);
    assert_eq!(body.kospi.flow.len() + body.kosdaq.flow.len(), 6);
}
