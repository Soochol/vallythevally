use crate::common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::support::kis_server::{KisPeer, archive, master_line};
use common::support::krx::{self, KrxMarket};
use common::{ScriptedTransport, Server};
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::api::{Excludes, NetDirection, Ranking, RankingMarket, Venue};
use server::kis::api::KisApiId;
use server::kis::feed::KisFeedParts;
use server::kis::master::{MasterDownload, MasterError, MasterMarket};
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};

const START: (&str, &str) = ("VALLY_KIWOOM_CONNECT", "start");
const NO_KIWOOM_KEY: (&str, &str) = ("VALLY_KIWOOM_APP_KEY", "");
const KIS_KEY: &str = "FAKE-KIS-APPKEY-route-env-3F8D";
const KIS_SECRET: &str = "FAKE-KIS-SECRET-route-env-7H1Q";
const KIS_ENV: [(&str, &str); 4] = [("VALLY_KIS_APP_KEY", KIS_KEY), ("VALLY_KIS_APP_SECRET", KIS_SECRET), ("VALLY_KIS_BASE_URL", "http://127.0.0.1:1"), ("VALLY_KIS_WS_URL", "ws://127.0.0.1:1")];
const FRIDAY_EVENING: &str = "20261106203000";
const MONDAY_MORNING: &str = "20261109100000";
const KEEP_ALL: Excludes = Excludes { etf_etn: false, preferred: false };
const HISTORY: &str = "from=2026-11-02&to=2026-11-06";

fn kis_fixture(group: &str, name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kis").join(group).join(name)).unwrap().trim().to_owned()
}

struct FakeKis {
    paths: Mutex<Vec<String>>,
}

impl FakeKis {
    fn new() -> Arc<FakeKis> {
        Arc::new(FakeKis { paths: Mutex::default() })
    }

    fn sent_to(&self, api: KisApiId) -> usize {
        self.paths.lock().unwrap().iter().filter(|path| *path == api.path()).count()
    }

    fn data_requests(&self) -> usize {
        self.paths.lock().unwrap().iter().filter(|path| !path.starts_with("/oauth2/")).count()
    }
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        self.paths.lock().unwrap().push(req.path.to_owned());
        let served = [
            (KisApiId::VolumeRank, "rankings", "volume_rank.json"),
            (KisApiId::IndexPrice, "overview", "index_price.json"),
            (KisApiId::CurrentPrice, "overview", "price_with_foreign_holdings.json"),
            (KisApiId::InvestorTimeByMarket, "overview", "investor_time.json"),
            (KisApiId::ProgramToday, "overview", "program_today.json"),
        ];
        let body = match req.path {
            "/oauth2/tokenP" => json!({"access_token": "FAKE-KIS-TOKEN-route", "expires_in": 86_400}).to_string(),
            "/oauth2/Approval" => json!({"approval_key": "FAKE-KIS-APPROVAL-route"}).to_string(),
            path => match served.iter().find(|(api, _, _)| api.path() == path) {
                Some((_, group, file)) => kis_fixture(group, file),
                None => json!({"rt_cd": "1", "msg_cd": "EGW99999", "msg1": "시험이 정하지 않은 요청"}).to_string(),
            },
        };
        Box::pin(async move { Ok(HttpResponse { status: 200, tr_cont: None, body }) })
    }
}

struct ListedMaster;

impl MasterDownload for ListedMaster {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>> {
        let lines = match market {
            MasterMarket::Kospi => vec![master_line(market, krx::COMMON, "합성 보통주")],
            MasterMarket::Kosdaq => vec![master_line(market, "247540", "합성 코스닥")],
        };
        Box::pin(async move { Ok(archive(&lines)) })
    }
}

fn headers() -> Value {
    json!({"cont-yn": "N", "next-key": ""})
}

fn kiwoom_trade_amount_page() -> Value {
    let row = json!({"stk_cd": krx::COMMON, "stk_nm": "키움 보통주", "now_rank": "1", "pred_rank": "1", "cur_prc": "1000", "flu_rt": "0.5", "now_trde_qty": "10", "trde_prica": "1"});
    json!({"_headers": headers(), "trde_prica_upper": [row], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

fn kiwoom_indices() -> Value {
    json!({"all_inds_idex": [
        {"stk_cd": "001", "stk_nm": "종합(KOSPI)", "cur_prc": "-6613.59", "flu_rt": "-0.67", "rising": "410", "stdns": "52", "fall": "+498", "upl": "3", "lst": "0", "trde_prica": "13,485,976"},
    ], "return_code": 0, "return_msg": "정상적으로 처리되었습니다"})
}

struct Env {
    _tmp: tempfile::TempDir,
    lock: PathBuf,
    dist: PathBuf,
}

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
        let lock = tmp.path().join("state/vallythevally/server.lock");
        Env { lock, dist, _tmp: tmp }
    }
}

struct Rig {
    server: Server,
    kiwoom: ScriptedTransport,
    kis: Arc<FakeKis>,
    base: String,
    http: reqwest::Client,
    _env: Env,
}

impl Rig {
    async fn start(clock: &str, extra: &[(&str, &str)]) -> Rig {
        let (kiwoom, kis, env) = (ScriptedTransport::new(), FakeKis::new(), Env::new());
        kiwoom.set_krx_market(KrxMarket::sample(KstDate::new(2026, 11, 6).unwrap()));
        kiwoom.respond_with("ka10032", 200, kiwoom_trade_amount_page());
        kiwoom.respond_with("ka20003", 200, kiwoom_indices());
        let mut overrides: Vec<(&str, &std::ffi::OsStr)> = vec![("VALLY_CLOCK_START", std::ffi::OsStr::new(clock))];
        overrides.extend(extra.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))));
        let parts = KisFeedParts { connect: KisPeer::default().connect(), master: Arc::new(ListedMaster) };
        let server = Server::spawn_with_kis_feed(&kiwoom, Some(kis.clone()), Some(parts), &env.lock, &env.dist, &overrides);
        let base = format!("http://{}", server.addr().await);
        Rig { server, kiwoom, kis, base, http: reqwest::Client::new(), _env: env }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let request = self.http.request(method, format!("{}{path}", self.base)).header("content-type", "application/json");
        let request = match body {
            Some(body) => request.body(body.to_string()),
            None => request,
        };
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        self.send(reqwest::Method::GET, path, None).await
    }

    async fn key(&self, id: &str) -> Value {
        self.get("/api/system/kiwoom/keys").await.1["keys"].as_array().unwrap().iter().find(|key| key["keyId"] == id).cloned().unwrap_or(Value::Null)
    }

    async fn until_key_state(&self, id: &str, wanted: &str) {
        until(&format!("키 {id}의 연결 상태 {wanted}"), || async { (self.key(id).await["link"]["state"] == wanted).then_some(()) }).await;
    }

    async fn trade_amount(&self) -> (u16, Value) {
        self.ask(Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes: KEEP_ALL, exclude_managed: false }).await
    }

    async fn foreign_streak(&self) -> (u16, Value) {
        self.ask(Ranking::ForeignStreak { market: RankingMarket::All, venue: Venue::Krx, direction: NetDirection::NetBuy, excludes: KEEP_ALL }).await
    }

    async fn ask(&self, ranking: Ranking) -> (u16, Value) {
        let body = json!({"ranking": serde_json::to_value(ranking).unwrap(), "pages": 1, "trigger": "user"});
        self.send(reqwest::Method::POST, "/api/rankings", Some(body)).await
    }

    async fn holdings(&self) -> (u16, Value) {
        self.get(&format!("/api/symbols/{}/foreign-holdings?{HISTORY}", krx::COMMON)).await
    }

    fn kiwoom_calls(&self, api_id: &str) -> usize {
        self.kiwoom.api_ids().iter().filter(|id| *id == api_id).count()
    }
}

async fn until<T, F: std::future::Future<Output = Option<T>>>(what: &str, mut check: impl FnMut() -> F) -> T {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(found) = check().await {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("기다리던 것이 오지 않았다: {what}"))
}

#[tokio::test]
async fn with_a_kis_source_a_connected_kiwoom_key_still_serves_rankings_overview_and_investors() {
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let rig = Rig::start(FRIDAY_EVENING, &extra).await;
    rig.until_key_state("env", "connected").await;
    rig.until_key_state("env-kis", "connected").await;
    let (status, body) = rig.send(reqwest::Method::PUT, "/api/system/kiwoom/market-key", Some(json!({"keyId": "env-kis"}))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(rig.key("env-kis").await["market"], true);
    let kis_before = rig.kis.data_requests();

    let (status, ranking) = rig.trade_amount().await;
    assert_eq!((status, &ranking["source"]), (200, &json!("kiwoom")), "{ranking}");
    assert_eq!(ranking["rows"][0]["name"], "키움 보통주");
    let (status, index) = rig.get("/api/market-overview/index?market=kospi").await;
    assert_eq!((status, &index["context"]["source"], &index["index"]["status"]), (200, &json!("kiwoom"), &json!("ok")), "{index}");
    let (status, holdings) = rig.holdings().await;
    assert_eq!((status, &holdings["source"]), (200, &json!("kiwoom")), "{holdings}");

    assert_eq!(rig.kiwoom_calls("ka10032"), 1);
    assert_eq!(rig.kiwoom_calls("ka20003"), 1);
    assert_eq!(rig.kiwoom_calls("ka10008"), 1);
    assert_eq!(rig.kis.data_requests(), kis_before, "한투 transport에는 순위·시장 개요·투자자 요청이 없다");
    for api in [KisApiId::VolumeRank, KisApiId::IndexPrice, KisApiId::CurrentPrice] {
        assert_eq!(rig.kis.sent_to(api), 0, "{api:?}");
    }
    rig.server.stop().await;
}

#[tokio::test]
async fn without_a_kiwoom_key_the_same_requests_go_to_kis_and_what_kis_lacks_is_refused_without_a_request() {
    let mut extra = vec![NO_KIWOOM_KEY, START];
    extra.extend(KIS_ENV);
    let rig = Rig::start(FRIDAY_EVENING, &extra).await;
    rig.until_key_state("env-kis", "connected").await;

    let (status, ranking) = rig.trade_amount().await;
    assert_eq!((status, &ranking["source"]), (200, &json!("kis")), "{ranking}");
    assert_eq!(rig.kis.sent_to(KisApiId::VolumeRank), 1);
    let (status, index) = rig.get("/api/market-overview/index?market=kospi").await;
    assert_eq!((status, &index["context"]["source"], &index["index"]["status"]), (200, &json!("kis"), &json!("ok")), "{index}");
    assert_eq!(rig.kis.sent_to(KisApiId::IndexPrice), 1);
    let (status, holdings) = rig.holdings().await;
    assert_eq!((status, &holdings["source"]), (200, &json!("kis")), "{holdings}");
    assert_eq!(rig.kis.sent_to(KisApiId::CurrentPrice), 1);

    let before = rig.kis.data_requests();
    let (status, refused) = rig.foreign_streak().await;
    assert_eq!((status, &refused["error"]["reason"]), (400, &json!("unsupported_by_source")), "{refused}");
    let (status, streaks) = rig.get("/api/market-overview/streaks?market=kospi").await;
    assert_eq!(status, 200, "{streaks}");
    assert_eq!(streaks["context"]["source"], "kis");
    for side in ["buying", "selling"] {
        assert_eq!((&streaks[side]["status"], &streaks[side]["error"]["reason"]), (&json!("failed"), &json!("unsupported_by_source")), "{streaks}");
    }
    assert_eq!(rig.kis.data_requests(), before, "한투에 없는 항목은 transport 요청 없이 닫힌다");
    assert_eq!(rig.kiwoom.api_ids(), Vec::<String>::new(), "키움 transport에는 요청이 0건이다");
    rig.server.stop().await;
}

#[tokio::test]
async fn disconnecting_the_kiwoom_key_sends_the_next_ranking_to_kis_and_reconnecting_returns_to_kiwoom() {
    let mut extra = vec![START];
    extra.extend(KIS_ENV);
    let rig = Rig::start(FRIDAY_EVENING, &extra).await;
    rig.until_key_state("env", "connected").await;
    rig.until_key_state("env-kis", "connected").await;

    let (_, first) = rig.trade_amount().await;
    assert_eq!(first["source"], "kiwoom", "{first}");
    assert_eq!(rig.kiwoom_calls("ka10032"), 1);

    let (status, body) = rig.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env/disconnect", None).await;
    assert_eq!(status, 200, "{body}");
    let (_, second) = rig.trade_amount().await;
    assert_eq!(second["source"], "kis", "키움을 끊은 뒤 첫 순위부터 한투다: {second}");
    assert_eq!(rig.kis.sent_to(KisApiId::VolumeRank), 1, "키움이 채운 칸이 한투 요청에 섞이지 않는다");
    assert_eq!(rig.kiwoom_calls("ka10032"), 1);

    let (status, body) = rig.send(reqwest::Method::POST, "/api/system/kiwoom/keys/env/connect", Some(json!({"acknowledged": false}))).await;
    assert_eq!(status, 200, "{body}");
    rig.until_key_state("env", "connected").await;
    rig.server.clock().jump(30);
    let (_, third) = rig.trade_amount().await;
    assert_eq!(third["source"], "kiwoom", "다시 이으면 키움이다: {third}");
    assert_eq!(rig.kiwoom_calls("ka10032"), 2);
    assert_eq!(rig.kis.sent_to(KisApiId::VolumeRank), 1);
    rig.server.stop().await;
}

#[tokio::test]
async fn with_a_kis_source_and_no_kiwoom_key_a_screener_update_is_refused_and_the_screener_status_still_reads() {
    let mut extra = vec![NO_KIWOOM_KEY, START];
    extra.extend(KIS_ENV);
    let rig = Rig::start(FRIDAY_EVENING, &extra).await;
    rig.until_key_state("env-kis", "connected").await;

    let (status, refused) = rig.send(reqwest::Method::POST, "/api/screener/update", Some(json!({"full": false}))).await;
    assert_eq!((status, &refused["error"]["reason"]), (400, &json!("unsupported_by_source")), "{refused}");
    let (status, state) = rig.get("/api/screener/status").await;
    assert_eq!(status, 200, "{state}");
    assert!(state["update"].is_null(), "갱신은 시작하지 않았다: {state}");
    assert_eq!(rig.kiwoom.api_ids(), Vec::<String>::new());
    rig.server.stop().await;
}

#[tokio::test]
async fn the_intraday_sampler_samples_with_kis_trs_when_no_kiwoom_key_is_connected() {
    let mut extra = vec![NO_KIWOOM_KEY, START];
    extra.extend(KIS_ENV);
    let rig = Rig::start(MONDAY_MORNING, &extra).await;
    rig.until_key_state("env-kis", "connected").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    rig.server.clock().jump(60);
    until("한투 장중 표본 TR 요청", || async { (rig.kis.sent_to(KisApiId::InvestorTimeByMarket) >= 1 && rig.kis.sent_to(KisApiId::ProgramToday) >= 1).then_some(()) }).await;
    let flow = until("장중 누적선의 표본", || async {
        let (_, flow) = rig.get("/api/market-overview/flow/intraday?market=kospi").await;
        flow["points"].as_array().is_some_and(|points| !points.is_empty()).then_some(flow)
    })
    .await;
    assert_eq!(flow["context"]["source"], "kis", "{flow}");
    assert_eq!(rig.kiwoom.api_ids(), Vec::<String>::new(), "키움 transport에는 요청이 0건이다");
    rig.server.stop().await;
}
