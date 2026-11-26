use crate::common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use common::Server;
use common::support::ScriptedTransport;
use common::support::kis_server::{KisPeer, archive, master_line};
use common::support::krx::{self, KrxMarket};
use domain::{KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::{Market as ApiMarket, ViDirection};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::http::{AppState, router};
use server::kis::api::KisApiId;
use server::kis::feed::KisFeedParts;
use server::kis::master::{MasterDownload, MasterError, MasterMarket};
use server::kis::transport::{HttpRequest as KisHttpRequest, HttpResponse as KisHttpResponse, Transport as KisTransport, TransportError as KisTransportError};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom_themes::KiwoomTheme;
use server::shared_data::{Broker, DataKind, Header, IntradayThemesBody, SourceKey, ViEventRow, ViEventsBody, write_snapshot};
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

const RECEIVED_AT: i64 = 1_792_000_000;

fn trading_day() -> KstDate {
    KstDate::new(2026, 11, 23).unwrap()
}

fn at(h: u32, m: u32) -> KstTime {
    KstTime::from_kst_civil(trading_day(), TimeOfDay::hms(h, m, 0).unwrap())
}

struct Harness {
    fake: ScriptedTransport,
    rest: KiwoomRest,
    state: Arc<AppState>,
    operator: Router,
    public: Router,
    shared: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(shared_enabled: bool, connected: bool) -> Harness {
        Harness::start_at(at(10, 30), shared_enabled, connected).await
    }

    async fn start_at(now: KstTime, shared_enabled: bool, connected: bool) -> Harness {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(now);
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let listed = |code: &str, name: &str, market: Market| SymbolInfo {
            symbol: Symbol::parse(code).unwrap(),
            name: name.into(),
            kind: SymbolKind::Common,
            market,
            nxt_enabled: true,
        };
        symbols.replace(Directory::build(vec![
            listed("005930", "삼성전자", Market::Kospi),
            listed("247540", "에코프로비엠", Market::Kosdaq),
        ]));
        let tmp = tempfile::tempdir().unwrap();
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
        let state = application(ApplicationInputs {
            rest: rest.clone(),
            clock,
            symbols,
            db,
            screener_store: store,
            stream: (stream, events),
            static_dir: tmp.path().to_owned(),
            screener_update_on_connect: false,
        });
        if connected {
            rest.set_access(Access::Open);
        }
        let shared = tmp.path().join("shared");
        if shared_enabled {
            state.shared_data.enable(shared.clone());
        }
        let operator = router(state.clone());
        let public = server::market_overview::routes().with_state(state.clone());
        Harness { fake, rest, state, operator, public, shared, _tmp: tmp }
    }

    async fn poll(&self) {
        self.state.shared_data.poll_once(&self.shared).await;
    }

    fn kiwoom_calls(&self) -> Vec<String> {
        self.fake.calls().into_iter().map(|call| call.api_id).filter(|id| id != "au10001").collect()
    }

    async fn get(&self, app: &Router, path: &str) -> (u16, Value) {
        let response = app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
}

fn write_themes_board(shared: &std::path::Path) {
    let header = Header::new(
        DataKind::IntradayThemes,
        trading_day(),
        RECEIVED_AT,
        RECEIVED_AT,
        vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }],
    );
    let body = IntradayThemesBody {
        themes: vec![
            KiwoomTheme {
                code: "319".into(),
                name: "조선".into(),
                stock_count: 12,
                change_rate: 3.45,
                period_return: 3.45,
                rising: 10,
                falling: 2,
                leaders: vec!["HD현대중공업".into(), "한화오션".into()],
            },
            KiwoomTheme {
                code: "100".into(),
                name: "원전".into(),
                stock_count: 8,
                change_rate: -1.1,
                period_return: -1.1,
                rising: 2,
                falling: 6,
                leaders: vec!["두산에너빌리티".into()],
            },
        ],
        pages: 1,
        complete: true,
        skipped: 0,
    };
    write_snapshot(shared, header, body).unwrap();
}

fn write_vi_board(shared: &std::path::Path) {
    let header = Header::new(
        DataKind::ViEvents,
        trading_day(),
        RECEIVED_AT,
        RECEIVED_AT,
        vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }],
    );
    let body = ViEventsBody {
        events: vec![
            ViEventRow {
                code: "005930".into(),
                name: "삼성전자".into(),
                market: ApiMarket::Kospi,
                direction: ViDirection::Up,
                triggered_at: "10:15:30".into(),
                released_at: None,
                trigger_price: Some(75_000),
                static_vi: true,
                dynamic_vi: false,
                dispersion_rate: Some(10.29),
            },
            ViEventRow {
                code: "247540".into(),
                name: "에코프로비엠".into(),
                market: ApiMarket::Kosdaq,
                direction: ViDirection::Down,
                triggered_at: "09:12:05".into(),
                released_at: Some("09:14:10".into()),
                trigger_price: Some(182_000),
                static_vi: false,
                dynamic_vi: true,
                dispersion_rate: Some(-6.15),
            },
        ],
    };
    write_snapshot(shared, header, body).unwrap();
}

#[tokio::test]
async fn shared_mode_serves_themes_and_vi_from_boards_with_zero_broker_calls() {
    let h = Harness::start(true, true).await;
    write_themes_board(&h.shared);
    write_vi_board(&h.shared);
    h.poll().await;

    for app in [&h.operator, &h.public] {
        let (status, themes) = h.get(app, "/api/market-overview/themes").await;
        assert_eq!(status, 200, "{themes}");
        assert_eq!(themes["phase"], "regular");
        assert_eq!(themes["receivedAt"], RECEIVED_AT);
        assert_eq!(themes["source"], "kiwoom");
        assert_eq!(themes["themes"]["status"], "ok");
        assert_eq!(themes["themes"]["value"].as_array().unwrap().len(), 2);
        assert_eq!(themes["themes"]["value"][0]["code"], "319");

        let (status, all_vi) = h.get(app, "/api/market-overview/vi").await;
        assert_eq!(status, 200, "{all_vi}");
        assert_eq!(all_vi["scope"], "all");
        assert_eq!(all_vi["receivedAt"], RECEIVED_AT);
        assert_eq!(all_vi["events"]["status"], "ok");
        assert_eq!(all_vi["events"]["value"].as_array().unwrap().len(), 2);

        let (status, kospi_vi) = h.get(app, "/api/market-overview/vi?scope=kospi").await;
        assert_eq!(status, 200, "{kospi_vi}");
        assert_eq!(kospi_vi["scope"], "kospi");
        assert_eq!(kospi_vi["events"]["value"].as_array().unwrap().len(), 1);
        assert_eq!(kospi_vi["events"]["value"][0]["code"], "005930");
        assert_eq!(kospi_vi["events"]["value"][0]["direction"], "up");

        let (status, kosdaq_vi) = h.get(app, "/api/market-overview/vi?scope=kosdaq").await;
        assert_eq!(status, 200, "{kosdaq_vi}");
        assert_eq!(kosdaq_vi["scope"], "kosdaq");
        assert_eq!(kosdaq_vi["events"]["value"].as_array().unwrap().len(), 1);
        assert_eq!(kosdaq_vi["events"]["value"][0]["code"], "247540");
        assert_eq!(kosdaq_vi["events"]["value"][0]["direction"], "down");
    }

    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn shared_mode_returns_not_prepared_when_boards_are_empty() {
    let h = Harness::start(true, true).await;
    h.poll().await;

    let (status, themes) = h.get(&h.operator, "/api/market-overview/themes").await;
    assert_eq!(status, 404, "{themes}");
    assert_eq!(themes["error"]["code"], "not_prepared");

    let (status, vi) = h.get(&h.operator, "/api/market-overview/vi?scope=all").await;
    assert_eq!(status, 404, "{vi}");
    assert_eq!(vi["error"]["code"], "not_prepared");

    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn invalid_vi_scope_returns_bad_request() {
    let h = Harness::start(true, true).await;
    let (status, body) = h.get(&h.operator, "/api/market-overview/vi?scope=konex").await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"]["code"], "bad_request");
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn direct_mode_fetches_live_kiwoom_themes_and_vi_and_handles_disconnect() {
    let h = Harness::start(false, true).await;
    h.fake.respond_with(
        "ka90001",
        200,
        json!({
            "return_code": 0,
            "thema_grp": [
                {"thema_grp_cd": "501", "thema_nm": "방산", "stk_num": "5", "flu_sig": "2", "flu_rt": "+4.20", "rising_stk_num": "5", "fall_stk_num": "0", "dt_prft_rt": "+4.20", "main_stk": "한화에어로스페이스"}
            ]
        }),
    );
    h.fake.respond_with(
        "ka10054",
        200,
        json!({
            "return_code": 0,
            "motn_stk": [
                {"stk_cd": "005930", "motn_pric": "75000", "trde_cntr_proc_time": "101000", "virelis_time": "000000", "static_stdpc": "68000", "static_dispty_rt": "+10.29", "dynm_dispty_rt": "0.00"},
                {"stk_cd": "247540", "motn_pric": "182000", "trde_cntr_proc_time": "093000", "virelis_time": "093200", "static_stdpc": "0", "static_dispty_rt": "0.00", "dynm_dispty_rt": "-6.00"}
            ]
        }),
    );

    let (status, themes) = h.get(&h.operator, "/api/market-overview/themes").await;
    assert_eq!(status, 200, "{themes}");
    assert_eq!(themes["themes"]["status"], "ok");
    assert_eq!(themes["themes"]["value"][0]["name"], "방산");

    let (status, vi_kosdaq) = h.get(&h.operator, "/api/market-overview/vi?scope=kosdaq").await;
    assert_eq!(status, 200, "{vi_kosdaq}");
    assert_eq!(vi_kosdaq["events"]["status"], "ok");
    assert_eq!(vi_kosdaq["events"]["value"].as_array().unwrap().len(), 1);
    assert_eq!(vi_kosdaq["events"]["value"][0]["code"], "247540");
    assert_eq!(vi_kosdaq["events"]["value"][0]["name"], "에코프로비엠");
    assert_eq!(vi_kosdaq["events"]["value"][0]["market"], "kosdaq");
    assert_eq!(h.kiwoom_calls(), vec!["ka90001", "ka10054"]);

    h.rest.set_access(Access::Closed);
    let (status, failed_themes) = h.get(&h.operator, "/api/market-overview/themes").await;
    assert_eq!(status, 200, "{failed_themes}");
    assert_eq!(failed_themes["themes"]["status"], "failed");
    assert_eq!(failed_themes["receivedAt"], Value::Null);

    let (status, failed_vi) = h.get(&h.operator, "/api/market-overview/vi?scope=all").await;
    assert_eq!(status, 200, "{failed_vi}");
    assert_eq!(failed_vi["events"]["status"], "failed");
    assert_eq!(failed_vi["receivedAt"], Value::Null);
}

#[tokio::test]
async fn shared_mode_rejects_stale_previous_day_themes_and_vi_boards() {
    let next_day = KstDate::new(2026, 11, 24).unwrap();
    let now = KstTime::from_kst_civil(next_day, TimeOfDay::hms(10, 30, 0).unwrap());
    let h = Harness::start_at(now, true, true).await;
    write_themes_board(&h.shared);
    write_vi_board(&h.shared);
    h.poll().await;

    let (themes_status, themes_body) = h.get(&h.operator, "/api/market-overview/themes").await;
    let (vi_status, vi_body) = h.get(&h.operator, "/api/market-overview/vi?scope=all").await;
    assert_eq!(themes_status, 404);
    assert_eq!(themes_body["error"]["code"], "not_prepared");
    assert_eq!(vi_status, 404);
    assert_eq!(vi_body["error"]["code"], "not_prepared");
    assert_eq!(h.kiwoom_calls(), Vec::<String>::new());
}

#[tokio::test]
async fn direct_mode_vi_walks_ka10054_continuation_pages() {
    let h = Harness::start(false, true).await;
    h.fake.respond_with(
        "ka10054",
        200,
        json!({
            "_headers": {"cont-yn": "Y", "next-key": "P2"},
            "return_code": 0,
            "motn_stk": [{
                "stk_cd": "005930",
                "stk_nm": "삼성전자",
                "mrkt_nm": "코스피",
                "motn_pric": "75000",
                "trde_cntr_proc_time": "101000",
                "virelis_time": "000000",
                "static_stdpc": "68000",
                "static_dispty_rt": "+10.29",
                "dynm_dispty_rt": "0.00"
            }]
        }),
    );
    h.fake.respond_with_for_key(
        "ka10054",
        "P2",
        200,
        json!({
            "_headers": {"cont-yn": "N", "next-key": ""},
            "return_code": 0,
            "motn_stk": [{
                "stk_cd": "247540",
                "stk_nm": "에코프로비엠",
                "mrkt_nm": "코스닥",
                "motn_pric": "182000",
                "trde_cntr_proc_time": "093000",
                "virelis_time": "093200",
                "static_stdpc": "0",
                "static_dispty_rt": "0.00",
                "dynm_dispty_rt": "-6.00"
            }]
        }),
    );

    let (status, vi) = h.get(&h.operator, "/api/market-overview/vi?scope=all").await;
    assert_eq!(status, 200, "{vi}");
    let codes: Vec<&str> = vi["events"]["value"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["code"].as_str().unwrap())
        .collect();
    assert_eq!(h.kiwoom_calls(), vec!["ka10054", "ka10054"]);
    assert_eq!(codes, vec!["005930", "247540"]);
}

#[tokio::test]
async fn shared_mode_vi_prefers_symbol_directory_market_and_name() {
    let h = Harness::start(true, false).await;
    let header = Header::new(
        DataKind::ViEvents,
        trading_day(),
        RECEIVED_AT,
        RECEIVED_AT,
        vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }],
    );
    let body = ViEventsBody {
        events: vec![ViEventRow {
            code: "247540".into(),
            name: "".into(),
            market: ApiMarket::Kospi,
            direction: ViDirection::Down,
            triggered_at: "09:30:00".into(),
            released_at: None,
            trigger_price: Some(182_000),
            static_vi: false,
            dynamic_vi: true,
            dispersion_rate: Some(-6.0),
        }],
    };
    write_snapshot(&h.shared, header, body).unwrap();
    h.poll().await;

    let (status_kq, body_kq) = h.get(&h.operator, "/api/market-overview/vi?scope=kosdaq").await;
    let (status_kp, body_kp) = h.get(&h.operator, "/api/market-overview/vi?scope=kospi").await;
    assert_eq!(status_kq, 200);
    assert_eq!(status_kp, 200);
    assert_eq!(body_kq["events"]["value"].as_array().unwrap().len(), 1);
    assert_eq!(body_kq["events"]["value"][0]["name"], "에코프로비엠");
    assert_eq!(body_kq["events"]["value"][0]["market"], "kosdaq");
    assert_eq!(body_kp["events"]["value"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn direct_mode_vi_normalizes_al_and_nx_suffixed_stock_codes() {
    let h = Harness::start(false, true).await;
    h.fake.respond_with(
        "ka10054",
        200,
        json!({
            "return_code": 0,
            "motn_stk": [
                {"stk_cd": "005930_AL", "stk_nm": "삼성전자", "mrkt_nm": "코스피", "motn_pric": "75000", "trde_cntr_proc_time": "101000", "virelis_time": "000000", "static_stdpc": "68000", "static_dispty_rt": "+10.29", "dynm_dispty_rt": "0.00"},
                {"stk_cd": "247540_NX", "stk_nm": "에코프로비엠", "mrkt_nm": "코스닥", "motn_pric": "182000", "trde_cntr_proc_time": "093000", "virelis_time": "093200", "static_stdpc": "0", "static_dispty_rt": "0.00", "dynm_dispty_rt": "-6.00"}
            ]
        }),
    );

    let (status, body) = h.get(&h.operator, "/api/market-overview/vi?scope=all").await;
    assert_eq!(status, 200, "{body}");
    let codes: Vec<&str> = body["events"]["value"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, vec!["005930", "247540"]);
}

fn kis_fixture(group: &str, name: &str) -> String {
    std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kis").join(group).join(name))
        .unwrap()
        .trim()
        .to_owned()
}

struct FakeKis;

impl KisTransport for FakeKis {
    fn send(&self, req: KisHttpRequest) -> BoxFuture<'static, Result<KisHttpResponse, KisTransportError>> {
        let body = match req.path {
            "/oauth2/tokenP" => json!({"access_token": "FAKE-KIS-TOKEN", "expires_in": 86_400}).to_string(),
            "/oauth2/Approval" => json!({"approval_key": "FAKE-KIS-APPROVAL"}).to_string(),
            path if path == KisApiId::IndexPrice.path() => kis_fixture("overview", "index_price.json"),
            _ => json!({"rt_cd": "1", "msg_cd": "EGW99999", "msg1": "unscripted"}).to_string(),
        };
        Box::pin(async move { Ok(KisHttpResponse { status: 200, tr_cont: None, body }) })
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

#[tokio::test]
async fn direct_mode_kis_only_themes_and_vi_report_unsupported_by_source() {
    let kiwoom = ScriptedTransport::new();
    kiwoom.set_krx_market(KrxMarket::sample(KstDate::new(2026, 11, 6).unwrap()));
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let lock = tmp.path().join("state/vallythevally/server.lock");
    let parts = KisFeedParts { connect: KisPeer::default().connect(), master: Arc::new(ListedMaster) };
    let overrides: [(&str, &std::ffi::OsStr); 7] = [
        ("VALLY_CLOCK_START", std::ffi::OsStr::new("20261106203000")),
        ("VALLY_KIWOOM_APP_KEY", std::ffi::OsStr::new("")),
        ("VALLY_KIWOOM_CONNECT", std::ffi::OsStr::new("start")),
        ("VALLY_KIS_APP_KEY", std::ffi::OsStr::new("FAKE-KIS-APPKEY-events")),
        ("VALLY_KIS_APP_SECRET", std::ffi::OsStr::new("FAKE-KIS-SECRET-events")),
        ("VALLY_KIS_BASE_URL", std::ffi::OsStr::new("http://127.0.0.1:1")),
        ("VALLY_KIS_WS_URL", std::ffi::OsStr::new("ws://127.0.0.1:1")),
    ];
    let server = Server::spawn_with_kis_feed(&kiwoom, Some(Arc::new(FakeKis)), Some(parts), &lock, &dist, &overrides);
    let base = format!("http://{}", server.addr().await);
    let http = reqwest::Client::new();

    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let keys: Value = http.get(format!("{base}/api/system/kiwoom/keys")).send().await.unwrap().json().await.unwrap();
            let connected = keys["keys"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k["keyId"] == "env-kis" && k["link"]["state"] == "connected");
            if connected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();

    let themes_resp = http.get(format!("{base}/api/market-overview/themes")).send().await.unwrap();
    let themes_status = themes_resp.status().as_u16();
    let themes: Value = themes_resp.json().await.unwrap();
    let vi_resp = http.get(format!("{base}/api/market-overview/vi?scope=all")).send().await.unwrap();
    let vi_status = vi_resp.status().as_u16();
    let vi: Value = vi_resp.json().await.unwrap();
    server.stop().await;

    assert_eq!(themes_status, 200);
    assert_eq!(themes["source"], "kis");
    assert_eq!(themes["themes"]["status"], "failed");
    assert_eq!(themes["themes"]["error"]["code"], "bad_request");
    assert_eq!(themes["themes"]["error"]["reason"], "unsupported_by_source");

    assert_eq!(vi_status, 200);
    assert_eq!(vi["source"], "kis");
    assert_eq!(vi["events"]["status"], "failed");
    assert_eq!(vi["events"]["error"]["code"], "bad_request");
    assert_eq!(vi["events"]["error"]["reason"], "unsupported_by_source");
}
